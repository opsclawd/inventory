import { randomUUID } from 'node:crypto';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  type PartStateSnapshot,
  validatePartTransition,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import {
  assertCapability,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import { resolveAraConditionMetadata } from './ebay-listing-metadata';
import {
  type ClassifiedsStateUpdateResult,
  computeSyndicationCommandFingerprint,
  deriveSyndicationReceiptId,
  type LocalAdPayload,
  SYNDICATION_AUDIT_ACTIONS,
  SYNDICATION_RECEIPT_SCHEMA_VERSION,
  type SyndicationClock,
  SyndicationError,
  type SyndicationPartRecord,
  type SyndicationRepository,
  type SyndicationTx,
  type UrgentDelistQueueResult,
} from './syndication.contracts';
import {
  DEFAULT_LOCAL_PUBLIC_MEDIA_ORIGIN,
  resolvePartPrice,
  resolvePartPublicMediaUrls,
} from './syndication-input-resolver';
import { SyndicationTemplateService } from './syndication-template.service';

export interface LocalClassifiedsQueueUseCaseDeps {
  readonly repository: SyndicationRepository;
  readonly clock?: SyndicationClock;
  readonly idGenerator?: () => string;
  readonly publicMediaOrigin?: string;
}

function toPartStateSnapshot(part: SyndicationPartRecord): PartStateSnapshot {
  return {
    custodyState: part.custodyState,
    availabilityState: part.availabilityState,
    ebaySyncState: part.ebaySyncState,
    classifiedsSyncState: part.classifiedsSyncState,
    complianceState: part.complianceState,
  };
}

async function loadPolicyInTx(
  tx: SyndicationTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

function assertCleanSkuOrId(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new SyndicationError(
      'INVALID_SYNDICATION_INPUT',
      'SKU or partId parameter must be a non-empty string.',
    );
  }
  const candidate: string = trimmed;
  const isUuid = isValidUuid(candidate as unknown);
  return isUuid ? candidate.toLowerCase() : candidate.toUpperCase();
}

export class LocalClassifiedsQueueUseCase {
  private readonly repository: SyndicationRepository;
  private readonly clock: SyndicationClock;
  private readonly idGenerator: () => string;
  private readonly publicMediaOrigin: string;

  public constructor(deps: LocalClassifiedsQueueUseCaseDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
    this.publicMediaOrigin =
      deps.publicMediaOrigin ?? DEFAULT_LOCAL_PUBLIC_MEDIA_ORIGIN;
  }

  private nextUuid(): string {
    const id = this.idGenerator();
    if (!isValidUuid(id)) {
      throw new SyndicationError(
        'SYNDICATION_INTEGRITY_ERROR',
        'idGenerator must produce a valid UUID string.',
      );
    }
    return id.toLowerCase();
  }

  public async getLocalAdPayload(
    session: AuthSessionContext,
    skuOrPartId: string,
  ): Promise<LocalAdPayload> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:read');

    const normalizedKey = assertCleanSkuOrId(skuOrPartId);
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const policy = await loadPolicyInTx(tx, organizationId);
      const parts = await tx.findPartsForSyndication(organizationId, {
        qrSkuCodeOrId: normalizedKey,
      });
      const part = parts[0];
      if (!part) {
        throw new SyndicationError(
          'PART_NOT_FOUND',
          `Part "${skuOrPartId}" was not found in the active organization.`,
        );
      }
      if (
        part.custodyState === 'RESTOCKED_QC_HOLD' ||
        part.availabilityState === 'RETURNED_QC_HOLD'
      ) {
        throw new SyndicationError(
          'PART_IN_RETURN_QC_HOLD',
          `Part "${part.qrSkuCode}" is in return QC hold and cannot be syndicated locally.`,
        );
      }

      const resolvedPrice = resolvePartPrice(part, policy);
      const media = resolvePartPublicMediaUrls({
        organizationId,
        qrSkuCode: part.qrSkuCode,
        cleanPhotoUrls: part.cleanPhotoUrls,
        rawPhotoUrls: part.rawPhotoUrls,
        publicMediaOrigin: this.publicMediaOrigin,
      });
      const conditionMeta = resolveAraConditionMetadata(part.araGrade);
      const templateService = new SyndicationTemplateService({
        publicPickupLocationLabel:
          policy.domesticSyndication.publicPickupLocationLabel,
        ebayShipFromCity: policy.domesticSyndication.ebayShipFromCity,
        ebayShipFromPostalCode:
          policy.domesticSyndication.ebayShipFromPostalCode,
        heavyLocalOnlyThresholdKg:
          policy.domesticSyndication.heavyLocalOnlyThresholdKg,
      });

      const copy = templateService.buildPartSyndicationCopy({
        qrSkuCode: part.qrSkuCode,
        partCategoryName: part.partCategoryName,
        oemPartNumbers: [...part.oemPartNumbers],
        araGrade: conditionMeta.canonicalGrade,
        araDamageCode: part.araDamageCode,
        weightKg: part.weightKg,
        tdgHazmatCode: part.tdgHazmatCode,
        retailPriceCadMinor: resolvedPrice.amountCadMinor,
        sanitizedPublicImageUrls: [...media.sanitizedPublicImageUrls],
        donorVehicle: {
          year: part.donorVehicle.year,
          make: part.donorVehicle.make,
          model: part.donorVehicle.model,
          trim: part.donorVehicle.trim,
          engineSpec: part.donorVehicle.engineSpec,
          vinOrHin: part.donorVehicle.vinOrHin,
          odometerKm: part.donorVehicle.odometerKm,
          engineHours: part.donorVehicle.engineHours,
        },
        publicPickupLocationLabel:
          policy.domesticSyndication.publicPickupLocationLabel,
        ebayShipFromCity: policy.domesticSyndication.ebayShipFromCity,
        ebayShipFromPostalCode:
          policy.domesticSyndication.ebayShipFromPostalCode,
        heavyLocalOnlyThresholdKg:
          policy.domesticSyndication.heavyLocalOnlyThresholdKg,
      });

      return {
        partId: part.id,
        organizationId: part.organizationId,
        qrSkuCode: part.qrSkuCode,
        title: copy.localClassifiedsTitle,
        body: copy.localClassifiedsBody,
        askCadMinor: resolvedPrice.amountCadMinor,
        resolvedPrice,
        publicPickupLocationLabel: copy.publicPickupLocationLabel,
        sanitizedPublicImageUrls: media.sanitizedPublicImageUrls,
        mediaClassification: media.classification,
        isLocalPickupOnly: !copy.isEbayParcelEligible,
        tdgHazmatCode: part.tdgHazmatCode,
        araGrade: conditionMeta.canonicalGrade,
        classifiedsSyncState: part.classifiedsSyncState,
        ebaySyncState: part.ebaySyncState,
        donorVehicle: {
          year: part.donorVehicle.year,
          make: part.donorVehicle.make,
          model: part.donorVehicle.model,
          trim: part.donorVehicle.trim,
          engineSpec: part.donorVehicle.engineSpec,
          odometerKm: part.donorVehicle.odometerKm,
        },
        version: part.version,
      };
    });
  }

  public async markPostedToClassifieds(
    session: AuthSessionContext,
    input: {
      readonly qrSkuCodeOrPartId: string;
      readonly expectedVersion?: number;
      readonly idempotencyKey?: string;
    },
  ): Promise<ClassifiedsStateUpdateResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:execute-local-queue');

    const normalizedKey = assertCleanSkuOrId(input.qrSkuCodeOrPartId);
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    const idempotencyKey = input.idempotencyKey
      ? input.idempotencyKey.toLowerCase()
      : null;
    if (idempotencyKey !== null && !isValidUuid(idempotencyKey)) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'idempotencyKey must be a valid UUID.',
      );
    }

    const receiptId = idempotencyKey
      ? deriveSyndicationReceiptId(organizationId, idempotencyKey)
      : this.nextUuid();
    const commandFingerprint = idempotencyKey
      ? computeSyndicationCommandFingerprint({
          organizationId,
          actorUserId: tenantCtx.userId,
          action: 'mark-posted-classifieds',
          payload: {
            qrSkuCodeOrPartId: normalizedKey,
            expectedVersion: input.expectedVersion ?? null,
          },
        })
      : '';

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.findCommandReceipt(organizationId, receiptId);
        if (existing) {
          if (
            existing.action !== 'mark-posted-classifieds' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new SyndicationError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different command.',
            );
          }
          return existing.result as ClassifiedsStateUpdateResult;
        }
      }

      await tx.acquireOrganizationLock(organizationId);

      const matches = await tx.findPartsForSyndication(organizationId, {
        qrSkuCodeOrId: normalizedKey,
      });
      const candidate = matches[0];
      if (!candidate) {
        throw new SyndicationError(
          'PART_NOT_FOUND',
          `Part "${input.qrSkuCodeOrPartId}" was not found in the active organization.`,
        );
      }

      const locked = await tx.lockPartsByIds(organizationId, [candidate.id]);
      const part = locked[0];
      if (!part) {
        throw new SyndicationError(
          'PART_NOT_FOUND',
          `Part "${input.qrSkuCodeOrPartId}" was not found in the active organization.`,
        );
      }

      if (
        input.expectedVersion !== undefined &&
        part.version !== input.expectedVersion
      ) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Part version conflict: expected ${input.expectedVersion}, actual ${part.version}.`,
        );
      }
      if (
        part.custodyState === 'RESTOCKED_QC_HOLD' ||
        part.availabilityState === 'RETURNED_QC_HOLD'
      ) {
        throw new SyndicationError(
          'PART_IN_RETURN_QC_HOLD',
          `Part "${part.qrSkuCode}" is in return QC hold.`,
        );
      }

      const transition = validatePartTransition(
        toPartStateSnapshot(part),
        'POST_CLASSIFIEDS',
        {},
      );

      const now = this.clock.now();
      const nextVersion = part.version + 1;
      const updated = await tx.updatePartSyndicationState({
        organizationId,
        partId: part.id,
        expectedVersion: part.version,
        nextVersion,
        classifiedsSyncState: transition.nextState.classifiedsSyncState,
        updatedAt: now,
      });
      if (!updated) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Concurrent update conflicted for "${part.qrSkuCode}".`,
        );
      }

      const result: ClassifiedsStateUpdateResult = {
        partId: part.id,
        organizationId,
        qrSkuCode: part.qrSkuCode,
        ebaySyncState: part.ebaySyncState,
        classifiedsSyncState: transition.nextState.classifiedsSyncState,
        version: nextVersion,
        auditLogId: receiptId,
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'Part',
        entityId: part.id,
        action: SYNDICATION_AUDIT_ACTIONS.CLASSIFIEDS_POSTED_LIVE,
        previousState: {
          classifiedsSyncState: part.classifiedsSyncState,
          version: part.version,
        },
        nextState: {
          schemaVersion: SYNDICATION_RECEIPT_SCHEMA_VERSION,
          action: 'mark-posted-classifieds',
          ...(idempotencyKey ? { idempotencyKey, commandFingerprint } : {}),
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }

  public async listUrgentDelistQueue(
    session: AuthSessionContext,
  ): Promise<UrgentDelistQueueResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:read');

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const rows = await tx.listUrgentDelistParts(organizationId);
      return {
        organizationId,
        items: rows.map((p) => ({
          partId: p.id,
          qrSkuCode: p.qrSkuCode,
          partCategoryName: p.partCategoryName,
          ebaySyncState: p.ebaySyncState,
          classifiedsSyncState: p.classifiedsSyncState,
          ebayListingId: p.ebayListingId,
          ebayTitle: p.ebayTitle,
          version: p.version,
        })),
        classifiedsConfirmationNotice:
          'Confirming local classifieds delist covers removal of all applicable FB Marketplace and Kijiji ads for the SKU.',
      };
    });
  }

  public async confirmManualChannelDelist(
    session: AuthSessionContext,
    input: {
      readonly qrSkuCodeOrPartId: string;
      readonly channel: 'EBAY' | 'LOCAL_CLASSIFIEDS';
      readonly expectedVersion?: number;
      readonly idempotencyKey?: string;
    },
  ): Promise<ClassifiedsStateUpdateResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:execute-local-queue');

    const normalizedKey = assertCleanSkuOrId(input.qrSkuCodeOrPartId);
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    const idempotencyKey = input.idempotencyKey
      ? input.idempotencyKey.toLowerCase()
      : null;
    if (idempotencyKey !== null && !isValidUuid(idempotencyKey)) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'idempotencyKey must be a valid UUID.',
      );
    }

    const receiptId = idempotencyKey
      ? deriveSyndicationReceiptId(organizationId, idempotencyKey)
      : this.nextUuid();
    const commandFingerprint = idempotencyKey
      ? computeSyndicationCommandFingerprint({
          organizationId,
          actorUserId: tenantCtx.userId,
          action: 'confirm-manual-delist',
          payload: {
            qrSkuCodeOrPartId: normalizedKey,
            channel: input.channel,
            expectedVersion: input.expectedVersion ?? null,
          },
        })
      : '';

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.findCommandReceipt(organizationId, receiptId);
        if (existing) {
          if (
            existing.action !== 'confirm-manual-delist' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new SyndicationError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different command.',
            );
          }
          return existing.result as ClassifiedsStateUpdateResult;
        }
      }

      await tx.acquireOrganizationLock(organizationId);

      const matches = await tx.findPartsForSyndication(organizationId, {
        qrSkuCodeOrId: normalizedKey,
      });
      const candidate = matches[0];
      if (!candidate) {
        throw new SyndicationError(
          'PART_NOT_FOUND',
          `Part "${input.qrSkuCodeOrPartId}" was not found in the active organization.`,
        );
      }

      const locked = await tx.lockPartsByIds(organizationId, [candidate.id]);
      const part = locked[0];
      if (!part) {
        throw new SyndicationError(
          'PART_NOT_FOUND',
          `Part "${input.qrSkuCodeOrPartId}" was not found in the active organization.`,
        );
      }

      if (
        input.expectedVersion !== undefined &&
        part.version !== input.expectedVersion
      ) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Part version conflict: expected ${input.expectedVersion}, actual ${part.version}.`,
        );
      }

      const transition =
        input.channel === 'EBAY'
          ? validatePartTransition(
              toPartStateSnapshot(part),
              'CONFIRM_EBAY_DELISTED',
              {},
            )
          : validatePartTransition(
              toPartStateSnapshot(part),
              'MARK_CLASSIFIEDS_DELISTED',
              {},
            );

      const now = this.clock.now();
      const nextVersion = part.version + 1;
      const updated = await tx.updatePartSyndicationState({
        organizationId,
        partId: part.id,
        expectedVersion: part.version,
        nextVersion,
        ...(input.channel === 'EBAY'
          ? { ebaySyncState: transition.nextState.ebaySyncState }
          : {
              classifiedsSyncState: transition.nextState.classifiedsSyncState,
            }),
        updatedAt: now,
      });
      if (!updated) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Concurrent update conflicted for "${part.qrSkuCode}".`,
        );
      }

      const result: ClassifiedsStateUpdateResult = {
        partId: part.id,
        organizationId,
        qrSkuCode: part.qrSkuCode,
        ebaySyncState: transition.nextState.ebaySyncState,
        classifiedsSyncState: transition.nextState.classifiedsSyncState,
        version: nextVersion,
        auditLogId: receiptId,
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'Part',
        entityId: part.id,
        action: SYNDICATION_AUDIT_ACTIONS.MANUAL_CHANNEL_DELISTED,
        previousState: {
          ebaySyncState: part.ebaySyncState,
          classifiedsSyncState: part.classifiedsSyncState,
          version: part.version,
        },
        nextState: {
          schemaVersion: SYNDICATION_RECEIPT_SCHEMA_VERSION,
          action: 'confirm-manual-delist',
          channel: input.channel,
          ...(idempotencyKey ? { idempotencyKey, commandFingerprint } : {}),
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }
}
