import { randomUUID } from 'node:crypto';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  DomainRuleError,
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
import {
  LISTING_METADATA_VERSION,
  lookupEbayListingCategory,
  resolveAraConditionMetadata,
  SELLER_HUB_CSV_FORMAT_VERSION,
} from './ebay-listing-metadata';
import {
  computeSyndicationCommandFingerprint,
  deriveSyndicationReceiptId,
  type B2bPowertrainItemSummary,
  type ConfirmEbayListingLiveResult,
  type ExportB2bPowertrainSheetResult,
  type ExportEbayCsvResult,
  type ExportPartProvenance,
  type PreviewEbayCsvResult,
  SYNDICATION_AUDIT_ACTIONS,
  SYNDICATION_RECEIPT_SCHEMA_VERSION,
  type SyndicationClock,
  SyndicationError,
  type SyndicationPartRecord,
  type SyndicationRepository,
  type SyndicationTx,
} from './syndication.contracts';
import {
  computePolicySnapshotHash,
  DEFAULT_LOCAL_PUBLIC_MEDIA_ORIGIN,
  resolvePartCompatibility,
  resolvePartPrice,
  resolvePartPublicMediaUrls,
} from './syndication-input-resolver';
import { SyndicationTemplateService } from './syndication-template.service';

export interface EbayCsvExporterUseCaseDeps {
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

function buildTemplateServiceFromPolicy(
  policy: PricingAndCompliancePolicy,
): SyndicationTemplateService {
  return new SyndicationTemplateService({
    publicPickupLocationLabel:
      policy.domesticSyndication.publicPickupLocationLabel,
    ebayShipFromCity: policy.domesticSyndication.ebayShipFromCity,
    ebayShipFromPostalCode: policy.domesticSyndication.ebayShipFromPostalCode,
    heavyLocalOnlyThresholdKg:
      policy.domesticSyndication.heavyLocalOnlyThresholdKg,
  });
}

function isUnselectedEbayEligible(
  part: SyndicationPartRecord,
  heavyThresholdKg: number,
): boolean {
  if (
    part.hasActiveSale ||
    part.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
    part.availabilityState !== 'AVAILABLE' ||
    part.complianceState === 'QUARANTINED_RECALL_OR_DG' ||
    part.tdgHazmatCode !== 'NONE' ||
    part.isHazmatOrAirbag ||
    part.weightKg <= 0 ||
    part.weightKg >= heavyThresholdKg
  ) {
    return false;
  }
  return (
    part.ebaySyncState === 'NOT_LISTED' || part.ebaySyncState === 'DELISTED'
  );
}

function assertExplicitPartEligibleForEbayCsv(
  part: SyndicationPartRecord,
  policy: PricingAndCompliancePolicy,
): void {
  if (
    part.custodyState === 'RESTOCKED_QC_HOLD' ||
    part.availabilityState === 'RETURNED_QC_HOLD'
  ) {
    throw new SyndicationError(
      'PART_IN_RETURN_QC_HOLD',
      `Part "${part.qrSkuCode}" is in return QC hold and cannot be exported.`,
      { partId: part.id, qrSkuCode: part.qrSkuCode },
    );
  }
  if (part.tdgHazmatCode !== 'NONE' || part.isHazmatOrAirbag) {
    throw new DomainRuleError(
      'HAZMAT_PARCEL_SHIPPING_BLOCKED',
      `Part "${part.qrSkuCode}" (${part.tdgHazmatCode}) is blocked from eBay parcel shipping.`,
      { partId: part.id, tdgHazmatCode: part.tdgHazmatCode },
    );
  }
  if (part.hasActiveSale) {
    throw new SyndicationError(
      'VERSION_CONFLICT',
      `Part "${part.qrSkuCode}" already has an active sale commitment.`,
      { partId: part.id },
    );
  }
  validatePartTransition(toPartStateSnapshot(part), 'EXPORT_EBAY_CSV', {
    tdgHazmatCode: part.tdgHazmatCode,
    isHazmatOrAirbag: part.isHazmatOrAirbag,
    weightKg: part.weightKg,
    heavyLocalOnlyThresholdKg:
      policy.domesticSyndication.heavyLocalOnlyThresholdKg,
  });
}

export class EbayCsvExporterUseCase {
  private readonly repository: SyndicationRepository;
  private readonly clock: SyndicationClock;
  private readonly idGenerator: () => string;
  private readonly publicMediaOrigin: string;

  public constructor(deps: EbayCsvExporterUseCaseDeps) {
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

  public async exportEbaySellerHubCsv(
    session: AuthSessionContext,
    input: {
      readonly partIds?: readonly string[];
      readonly format?: 'EBAY_CSV' | 'B2B_POWERTRAIN';
      readonly idempotencyKey: string;
    },
  ): Promise<ExportEbayCsvResult | ExportB2bPowertrainSheetResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:export-csv');

    if (input.format === 'B2B_POWERTRAIN') {
      return this.exportB2bPowertrainSheet(session);
    }

    if (!isValidUuid(input.idempotencyKey)) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'idempotencyKey must be a valid UUID.',
      );
    }

    let requestedPartIds: string[] | undefined;
    if (input.partIds !== undefined) {
      if (!Array.isArray(input.partIds) || input.partIds.length === 0) {
        throw new SyndicationError(
          'INVALID_SYNDICATION_INPUT',
          'Explicit partIds array must contain at least one valid UUID.',
        );
      }
      const seen = new Set<string>();
      requestedPartIds = [];
      for (const id of input.partIds) {
        if (!isValidUuid(id)) {
          throw new SyndicationError(
            'INVALID_SYNDICATION_INPUT',
            `Invalid partId UUID "${String(id)}".`,
          );
        }
        const normalized = id.toLowerCase();
        if (seen.has(normalized)) {
          throw new SyndicationError(
            'INVALID_SYNDICATION_INPUT',
            `Duplicate partId "${normalized}" in batch export.`,
          );
        }
        seen.add(normalized);
        requestedPartIds.push(normalized);
      }
    }

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const idempotencyKey = input.idempotencyKey.toLowerCase();
    const receiptId = deriveSyndicationReceiptId(organizationId, idempotencyKey);
    const commandFingerprint = computeSyndicationCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'export-ebay-csv',
      payload: {
        partIds: requestedPartIds ? [...requestedPartIds].sort() : null,
      },
    });

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const existingReceipt = await tx.findCommandReceipt(
        organizationId,
        receiptId,
      );
      if (existingReceipt) {
        if (
          existingReceipt.action !== 'export-ebay-csv' ||
          existingReceipt.commandFingerprint !== commandFingerprint
        ) {
          throw new SyndicationError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different syndication command.',
          );
        }
        return existingReceipt.result as ExportEbayCsvResult;
      }

      await tx.acquireOrganizationLock(organizationId);

      const recheckReceipt = await tx.findCommandReceipt(
        organizationId,
        receiptId,
      );
      if (recheckReceipt) {
        if (
          recheckReceipt.action !== 'export-ebay-csv' ||
          recheckReceipt.commandFingerprint !== commandFingerprint
        ) {
          throw new SyndicationError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different syndication command.',
          );
        }
        return recheckReceipt.result as ExportEbayCsvResult;
      }

      const policy = await loadPolicyInTx(tx, organizationId);
      const policyHash = computePolicySnapshotHash(policy);
      const templateService = buildTemplateServiceFromPolicy(policy);

      let lockedParts: readonly SyndicationPartRecord[];
      if (requestedPartIds) {
        const sortedIds = [...requestedPartIds].sort();
        lockedParts = await tx.lockPartsByIds(organizationId, sortedIds);
        if (lockedParts.length !== sortedIds.length) {
          const foundSet = new Set(lockedParts.map((p) => p.id.toLowerCase()));
          const missingId = sortedIds.find((id) => !foundSet.has(id));
          throw new SyndicationError(
            'PART_NOT_FOUND',
            `Part "${missingId}" was not found in the active organization.`,
            { partId: missingId },
          );
        }
        for (const part of lockedParts) {
          assertExplicitPartEligibleForEbayCsv(part, policy);
        }
      } else {
        const candidates = await tx.findPartsForSyndication(organizationId);
        const eligibleIds = candidates
          .filter((p) =>
            isUnselectedEbayEligible(
              p,
              policy.domesticSyndication.heavyLocalOnlyThresholdKg,
            ),
          )
          .map((p) => p.id.toLowerCase())
          .sort();
        if (eligibleIds.length === 0) {
          throw new SyndicationError(
            'NO_ELIGIBLE_PARTS_FOR_EXPORT',
            'No eligible < 15.0 kg non-hazmat shelved parts are ready for eBay CSV export.',
          );
        }
        lockedParts = await tx.lockPartsByIds(organizationId, eligibleIds);
        for (const part of lockedParts) {
          assertExplicitPartEligibleForEbayCsv(part, policy);
        }
      }

      const now = this.clock.now();
      const exportId = this.nextUuid();

      const csvInputs: Parameters<
        SyndicationTemplateService['exportEbaySellerHubCsv']
      >[0] = [];
      const provenance: ExportPartProvenance[] = [];
      const transitionUpdates: Array<{
        readonly part: SyndicationPartRecord;
        readonly ebaySeoTitle80: string;
        readonly nextState: PartStateSnapshot;
      }> = [];

      for (const part of lockedParts) {
        const resolvedPrice = resolvePartPrice(part, policy);
        const media = resolvePartPublicMediaUrls({
          organizationId,
          qrSkuCode: part.qrSkuCode,
          cleanPhotoUrls: part.cleanPhotoUrls,
          rawPhotoUrls: part.rawPhotoUrls,
          publicMediaOrigin: this.publicMediaOrigin,
        });
        const fitment = resolvePartCompatibility({
          ebayCompatibilityJson: part.ebayCompatibilityJson,
          donorVehicle: part.donorVehicle,
        });
        const categoryMeta = lookupEbayListingCategory(part.partCategoryName);
        const conditionMeta = resolveAraConditionMetadata(part.araGrade);

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

        const transition = validatePartTransition(
          toPartStateSnapshot(part),
          'EXPORT_EBAY_CSV',
          {
            tdgHazmatCode: part.tdgHazmatCode,
            isHazmatOrAirbag: part.isHazmatOrAirbag,
            weightKg: part.weightKg,
            heavyLocalOnlyThresholdKg:
              policy.domesticSyndication.heavyLocalOnlyThresholdKg,
          },
        );

        csvInputs.push({
          qrSkuCode: part.qrSkuCode,
          ebaySeoTitle80: copy.ebaySeoTitle80,
          ebayHtmlDescription: copy.ebayHtmlDescription,
          partCategoryName: part.partCategoryName,
          oemPartNumbers: [...part.oemPartNumbers],
          araGrade: conditionMeta.canonicalGrade,
          tdgHazmatCode: part.tdgHazmatCode,
          retailPriceCadMinor: resolvedPrice.amountCadMinor,
          sanitizedPublicImageUrls: [...media.sanitizedPublicImageUrls],
          make: part.donorVehicle.make,
          compatibleVehicles: fitment.compatibleVehicles.map((v) => ({
            year: v.year,
            make: v.make,
            model: v.model,
            trim: v.trim,
            engine: v.engine,
          })),
        });

        provenance.push({
          partId: part.id,
          qrSkuCode: part.qrSkuCode,
          previousVersion: part.version,
          nextVersion: part.version + 1,
          ebaySeoTitle80: copy.ebaySeoTitle80,
          resolvedPrice,
          mediaSource: media.sourceArray,
          mediaClassification: media.classification,
          sanitizedPublicImageUrls: media.sanitizedPublicImageUrls,
          fitmentSource: fitment.source,
          compatibleVehicles: fitment.compatibleVehicles,
          ebayCategoryId: categoryMeta.ebayCategoryId,
          conditionId: conditionMeta.conditionId,
        });

        transitionUpdates.push({
          part,
          ebaySeoTitle80: copy.ebaySeoTitle80,
          nextState: transition.nextState,
        });
      }

      const csvContent = templateService.exportEbaySellerHubCsv(csvInputs, {
        city: policy.domesticSyndication.ebayShipFromCity,
        postalCode: policy.domesticSyndication.ebayShipFromPostalCode,
      });

      for (const upd of transitionUpdates) {
        const updated = await tx.updatePartSyndicationState({
          organizationId,
          partId: upd.part.id,
          expectedVersion: upd.part.version,
          nextVersion: upd.part.version + 1,
          ebaySyncState: upd.nextState.ebaySyncState,
          ebayTitle: upd.ebaySeoTitle80,
          updatedAt: now,
        });
        if (!updated) {
          throw new SyndicationError(
            'VERSION_CONFLICT',
            `Concurrent update conflicted while exporting part "${upd.part.qrSkuCode}".`,
            { partId: upd.part.id },
          );
        }
      }

      const result: ExportEbayCsvResult = {
        exportId,
        organizationId,
        format: 'EBAY_CSV',
        csvContent,
        exportedPartIds: lockedParts.map((p) => p.id),
        exportedSkus: lockedParts.map((p) => p.qrSkuCode),
        mappingVersion: LISTING_METADATA_VERSION,
        csvFormatVersion: SELLER_HUB_CSV_FORMAT_VERSION,
        policyHash,
        partProvenance: provenance,
        auditLogId: receiptId,
        createdAt: now.toISOString(),
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'SyndicationExport',
        entityId: exportId,
        action: SYNDICATION_AUDIT_ACTIONS.EBAY_CSV_EXPORTED,
        previousState: {
          parts: lockedParts.map((p) => ({
            partId: p.id,
            ebaySyncState: p.ebaySyncState,
            version: p.version,
          })),
        },
        nextState: {
          schemaVersion: SYNDICATION_RECEIPT_SCHEMA_VERSION,
          action: 'export-ebay-csv',
          idempotencyKey,
          commandFingerprint,
          exportId,
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }

  public async getCommittedExport(
    session: AuthSessionContext,
    exportId: string,
  ): Promise<ExportEbayCsvResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:read');

    if (!isValidUuid(exportId)) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'exportId must be a valid UUID.',
      );
    }

    const tenantCtx = toTenantExecutionContext(session);
    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const committed = await tx.findCommittedExportReceiptByExportId(
        tenantCtx.organizationId,
        exportId.toLowerCase(),
      );
      if (!committed) {
        throw new SyndicationError(
          'EXPORT_NOT_FOUND',
          `Committed eBay CSV export "${exportId}" was not found in the active organization.`,
        );
      }
      return committed;
    });
  }

  public async previewEbaySellerHubCsv(
    session: AuthSessionContext,
    partIds?: readonly string[],
  ): Promise<PreviewEbayCsvResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:read');

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const policy = await loadPolicyInTx(tx, organizationId);
      const templateService = buildTemplateServiceFromPolicy(policy);
      const parts = await tx.findPartsForSyndication(
        organizationId,
        partIds && partIds.length > 0 ? { partIds } : undefined,
      );

      const csvInputs: Parameters<
        SyndicationTemplateService['exportEbaySellerHubCsv']
      >[0] = [];
      const eligiblePartIds: string[] = [];
      const eligibleSkus: string[] = [];
      const ineligibleParts: Array<{
        readonly partId: string;
        readonly qrSkuCode: string;
        readonly reasonCode: string;
        readonly reasonMessage: string;
      }> = [];

      for (const part of parts) {
        if (
          !isUnselectedEbayEligible(
            part,
            policy.domesticSyndication.heavyLocalOnlyThresholdKg,
          )
        ) {
          ineligibleParts.push({
            partId: part.id,
            qrSkuCode: part.qrSkuCode,
            reasonCode:
              part.tdgHazmatCode !== 'NONE' || part.isHazmatOrAirbag
                ? 'HAZMAT_PARCEL_SHIPPING_BLOCKED'
                : 'PART_NOT_EBAY_PARCEL_ELIGIBLE',
            reasonMessage: `Part ${part.qrSkuCode} is not eligible for eBay parcel CSV export.`,
          });
          continue;
        }
        try {
          const resolvedPrice = resolvePartPrice(part, policy);
          const media = resolvePartPublicMediaUrls({
            organizationId,
            qrSkuCode: part.qrSkuCode,
            cleanPhotoUrls: part.cleanPhotoUrls,
            rawPhotoUrls: part.rawPhotoUrls,
            publicMediaOrigin: this.publicMediaOrigin,
          });
          const fitment = resolvePartCompatibility({
            ebayCompatibilityJson: part.ebayCompatibilityJson,
            donorVehicle: part.donorVehicle,
          });
          const conditionMeta = resolveAraConditionMetadata(part.araGrade);
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
          lookupEbayListingCategory(part.partCategoryName);

          csvInputs.push({
            qrSkuCode: part.qrSkuCode,
            ebaySeoTitle80: copy.ebaySeoTitle80,
            ebayHtmlDescription: copy.ebayHtmlDescription,
            partCategoryName: part.partCategoryName,
            oemPartNumbers: [...part.oemPartNumbers],
            araGrade: conditionMeta.canonicalGrade,
            tdgHazmatCode: part.tdgHazmatCode,
            retailPriceCadMinor: resolvedPrice.amountCadMinor,
            sanitizedPublicImageUrls: [...media.sanitizedPublicImageUrls],
            make: part.donorVehicle.make,
            compatibleVehicles: fitment.compatibleVehicles.map((v) => ({
              year: v.year,
              make: v.make,
              model: v.model,
              trim: v.trim,
              engine: v.engine,
            })),
          });
          eligiblePartIds.push(part.id);
          eligibleSkus.push(part.qrSkuCode);
        } catch (err) {
          const code =
            err instanceof DomainRuleError ? err.code : 'INVALID_SYNDICATION_INPUT';
          const message = err instanceof Error ? err.message : 'Ineligible part';
          ineligibleParts.push({
            partId: part.id,
            qrSkuCode: part.qrSkuCode,
            reasonCode: code,
            reasonMessage: message,
          });
        }
      }

      const csvContent =
        csvInputs.length > 0
          ? templateService.exportEbaySellerHubCsv(csvInputs, {
              city: policy.domesticSyndication.ebayShipFromCity,
              postalCode: policy.domesticSyndication.ebayShipFromPostalCode,
            })
          : '';

      return {
        isPreview: true,
        persistedMutation: false,
        organizationId,
        csvContent,
        eligiblePartIds,
        eligibleSkus,
        ineligibleParts,
        mappingVersion: LISTING_METADATA_VERSION,
        csvFormatVersion: SELLER_HUB_CSV_FORMAT_VERSION,
      };
    });
  }

  /**
   * Two-step eBay listing confirmation: validates non-empty unique `ebayListingId`
   * and transitions `CSV_EXPORTED_PENDING_CONFIRMATION -> SYNDICATED_LIVE`.
   */
  public async confirmEbayListingLive(
    session: AuthSessionContext,
    partId: string,
    ebayListingId: string,
    options?: {
      readonly expectedVersion?: number;
      readonly idempotencyKey?: string;
    },
  ): Promise<ConfirmEbayListingLiveResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:export-csv');

    if (!isValidUuid(partId)) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'partId must be a valid UUID.',
      );
    }

    const trimmedListingId =
      typeof ebayListingId === 'string' ? ebayListingId.trim() : '';
    if (trimmedListingId.length === 0) {
      throw new DomainRuleError(
        'EBAY_LISTING_ID_REQUIRED',
        'A non-empty ebayListingId is required to confirm SYNDICATED_LIVE.',
      );
    }

    const normalizedPartId = partId.toLowerCase();
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    const idempotencyKey = options?.idempotencyKey
      ? options.idempotencyKey.toLowerCase()
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
          action: 'confirm-ebay-live',
          payload: {
            partId: normalizedPartId,
            ebayListingId: trimmedListingId,
            expectedVersion: options?.expectedVersion ?? null,
          },
        })
      : '';

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.findCommandReceipt(organizationId, receiptId);
        if (existing) {
          if (
            existing.action !== 'confirm-ebay-live' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new SyndicationError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different command.',
            );
          }
          return existing.result as ConfirmEbayListingLiveResult;
        }
      }

      await tx.acquireOrganizationLock(organizationId);

      if (idempotencyKey) {
        const recheck = await tx.findCommandReceipt(organizationId, receiptId);
        if (recheck) {
          if (
            recheck.action !== 'confirm-ebay-live' ||
            recheck.commandFingerprint !== commandFingerprint
          ) {
            throw new SyndicationError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different command.',
            );
          }
          return recheck.result as ConfirmEbayListingLiveResult;
        }
      }

      const parts = await tx.lockPartsByIds(organizationId, [normalizedPartId]);
      const part = parts[0];
      if (!part) {
        throw new SyndicationError(
          'PART_NOT_FOUND',
          `Part "${normalizedPartId}" was not found in the active organization.`,
        );
      }

      if (
        options?.expectedVersion !== undefined &&
        part.version !== options.expectedVersion
      ) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Part version conflict: expected ${options.expectedVersion}, actual ${part.version}.`,
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
      if (part.hasActiveSale) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Part "${part.qrSkuCode}" was committed to a sale and cannot be confirmed live.`,
        );
      }

      const duplicateListing = await tx.ebayListingIdExists(
        trimmedListingId,
        part.id,
      );
      if (duplicateListing) {
        throw new SyndicationError(
          'DUPLICATE_EBAY_LISTING_ID',
          `eBay listing ID "${trimmedListingId}" is already assigned to another part.`,
        );
      }

      const transition = validatePartTransition(
        toPartStateSnapshot(part),
        'CONFIRM_EBAY_LIVE',
        { ebayListingId: trimmedListingId },
      );

      const now = this.clock.now();
      const nextVersion = part.version + 1;
      const updated = await tx.updatePartSyndicationState({
        organizationId,
        partId: part.id,
        expectedVersion: part.version,
        nextVersion,
        ebaySyncState: transition.nextState.ebaySyncState,
        ebayListingId: trimmedListingId,
        updatedAt: now,
      });
      if (!updated) {
        throw new SyndicationError(
          'VERSION_CONFLICT',
          `Concurrent update conflicted while confirming live listing for "${part.qrSkuCode}".`,
        );
      }

      const result: ConfirmEbayListingLiveResult = {
        partId: part.id,
        organizationId,
        qrSkuCode: part.qrSkuCode,
        ebayListingId: trimmedListingId,
        ebaySyncState: transition.nextState.ebaySyncState,
        version: nextVersion,
        auditLogId: receiptId,
        provenanceClassification: 'OPERATOR_ASSERTION',
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'Part',
        entityId: part.id,
        action: SYNDICATION_AUDIT_ACTIONS.EBAY_LISTING_CONFIRMED_LIVE,
        previousState: {
          ebaySyncState: part.ebaySyncState,
          ebayListingId: part.ebayListingId,
          version: part.version,
        },
        nextState: {
          schemaVersion: SYNDICATION_RECEIPT_SCHEMA_VERSION,
          action: 'confirm-ebay-live',
          ...(idempotencyKey ? { idempotencyKey, commandFingerprint } : {}),
          provenanceClassification: 'OPERATOR_ASSERTION',
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }

  /**
   * Read-only Day-1 B2B Mechanic Powertrain Sheet export (`FR-MKT-00`).
   * Never mutates `ebaySyncState` or `Part` records.
   */
  public async exportB2bPowertrainSheet(
    session: AuthSessionContext,
  ): Promise<ExportB2bPowertrainSheetResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-MKT-00:read');

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const policy = await loadPolicyInTx(tx, organizationId);
      const templateService = buildTemplateServiceFromPolicy(policy);
      const parts = await tx.findPartsForSyndication(organizationId);

      const b2bItems: B2bPowertrainItemSummary[] = [];
      for (const part of parts) {
        if (
          part.hasActiveSale ||
          part.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
          part.availabilityState !== 'AVAILABLE' ||
          part.complianceState === 'QUARANTINED_RECALL_OR_DG' ||
          part.tdgHazmatCode !== 'NONE' ||
          part.isHazmatOrAirbag
        ) {
          continue;
        }
        let categoryMapping;
        try {
          categoryMapping = lookupEbayListingCategory(part.partCategoryName);
        } catch {
          continue;
        }
        if (!categoryMapping.isPowertrainB2bEligible) {
          continue;
        }

        const resolvedPrice = resolvePartPrice(part, policy);
        const conditionMeta = resolveAraConditionMetadata(part.araGrade);

        b2bItems.push({
          partId: part.id,
          qrSkuCode: part.qrSkuCode,
          year: part.donorVehicle.year,
          make: part.donorVehicle.make,
          model: part.donorVehicle.model,
          engineSpec: part.donorVehicle.engineSpec,
          odometerKm: part.donorVehicle.odometerKm,
          partCategoryName: part.partCategoryName,
          oemPartNumbers: [...part.oemPartNumbers],
          araGrade: conditionMeta.canonicalGrade,
          initialMechanicAskCadMinor: resolvedPrice.amountCadMinor,
          resolvedPrice,
          publicPickupLocationLabel:
            policy.domesticSyndication.publicPickupLocationLabel,
        });
      }

      const sheet = templateService.exportB2bMechanicPowertrainSheet(
        b2bItems.map((item) => ({
          qrSkuCode: item.qrSkuCode,
          year: item.year,
          make: item.make,
          model: item.model,
          engineSpec: item.engineSpec,
          odometerKm: item.odometerKm,
          partCategoryName: item.partCategoryName,
          oemPartNumbers: [...item.oemPartNumbers],
          araGrade: item.araGrade,
          wholesaleAskCadMinor: item.initialMechanicAskCadMinor,
        })),
      );

      return {
        organizationId,
        format: 'B2B_POWERTRAIN',
        persistedMutation: false,
        publicPickupLocationLabel:
          policy.domesticSyndication.publicPickupLocationLabel,
        whatsappMarkdownText: sheet.whatsappMarkdownText,
        csvContent: sheet.csvContent,
        items: b2bItems,
      };
    });
  }
}
