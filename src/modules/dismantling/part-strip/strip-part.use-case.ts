import { randomUUID } from 'node:crypto';
import type {
  AssetLifecycleState,
  CatalyticConverterDisposition,
} from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  computeGradeAdjustedMarketValueCadMinor,
  computeProvisionalCostBasis,
  type PartStateSnapshot,
  type ProvisionalPartAllocationInput,
  trueUpDonorCostBasis,
  validatePartTransition,
  validateVehicleLifecycleTransition,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import type { IStoragePort } from '@/core/ports/storage.port';
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
  LocationCustodyError,
  LocationZoningService,
  mergeComplianceWarnings,
} from '@/modules/shared-ops/locations-qr/location-zoning.service';
import { computeSha256Hex } from '@/modules/shared-ops/storage';
import {
  assertValidUuidParam,
  computeCommandFingerprint,
  computeDonorDirectCostLedger,
  computePartGradeAdjustedBaseline,
  deriveIssue8CommandReceiptId,
  type InspectReturnCommand,
  InspectReturnCommandSchema,
  type InspectReturnResult,
  isCatalyticConverterPartCategory,
  isPrismaUniqueViolation,
  type LockedDonorPartRow,
  type LockedDonorVehicleRow,
  type LockedScrapLogRow,
  type LockedStorageLocationRow,
  mapShortAraGradeToEnum,
  MAX_PART_PHOTO_BYTES,
  normalizeAndValidateLocationBarcode,
  normalizeAndValidatePartQrSku,
  PART_STRIP_AUDIT_ACTIONS,
  PART_STRIP_RECEIPT_SCHEMA_VERSION,
  parseStrictTimestamp,
  partitionDonorPartsForTrueUp,
  type PartStripClock,
  PartStripError,
  type PartStripRepository,
  type PartStripTx,
  type PartStripUseCaseDeps,
  type PrivateTicketUrlResult,
  type ReceiveReturnCommand,
  ReceiveReturnCommandSchema,
  type ReceiveReturnResult,
  resolveIdempotentCommandReplay,
  resolvePartClassification,
  type SafeDonorSummaryRow,
  type SafePartListRow,
  type SafeScrapHistoryRow,
  type StripPartCommand,
  StripPartMetadataSchema,
  type StripPartResult,
  validateOptionalDamageCode,
} from './part-strip.contracts';

function isValidStripPartResult(raw: unknown): raw is StripPartResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    typeof r.partId === 'string' &&
    typeof r.organizationId === 'string' &&
    typeof r.donorVehicleId === 'string' &&
    typeof r.qrSkuCode === 'string' &&
    typeof r.custodyState === 'string' &&
    typeof r.allocatedCostBasisCadMinor === 'number' &&
    typeof r.custodyEventId === 'string' &&
    typeof r.auditLogId === 'string'
  );
}

function isValidReceiveReturnResult(raw: unknown): raw is ReceiveReturnResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    typeof r.partId === 'string' &&
    typeof r.organizationId === 'string' &&
    typeof r.custodyState === 'string' &&
    typeof r.availabilityState === 'string' &&
    typeof r.complianceState === 'string' &&
    typeof r.custodyEventId === 'string' &&
    typeof r.auditLogId === 'string'
  );
}

function isValidInspectReturnResult(raw: unknown): raw is InspectReturnResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    typeof r.partId === 'string' &&
    typeof r.organizationId === 'string' &&
    typeof r.qcPassed === 'boolean' &&
    typeof r.custodyState === 'string' &&
    typeof r.availabilityState === 'string' &&
    typeof r.complianceState === 'string' &&
    typeof r.auditLogId === 'string'
  );
}

async function loadPolicyInTx(
  tx: PartStripTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

export class StripPartUseCase {
  private readonly repository?: PartStripRepository;
  private readonly storage?: IStoragePort;
  private readonly zoningService: LocationZoningService;
  private readonly clock: PartStripClock;
  private readonly idGenerator: () => string;

  public constructor(deps: PartStripUseCaseDeps = {}) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.zoningService = deps.zoningService ?? new LocationZoningService();
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
  }

  private requireRepository(): PartStripRepository {
    if (!this.repository) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'PartStripRepository dependency is required.',
      );
    }
    return this.repository;
  }

  private requireStorage(): IStoragePort {
    if (!this.storage) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'IStoragePort dependency is required.',
      );
    }
    return this.storage;
  }

  private nextUuid(): string {
    const id = this.idGenerator();
    if (!isValidUuid(id)) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'idGenerator must produce a valid UUID string.',
      );
    }
    return id.toLowerCase();
  }

  /**
   * FR-INT-02 online 3-tap part strip, EXIF-stripped 3-photo upload, TDG hazmat
   * classification, Stage 1/2 cost allocation, and origin container bin custody.
   */
  public async execute(
    session: AuthSessionContext,
    rawInput: StripPartCommand,
  ): Promise<StripPartResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');

    if (!rawInput || typeof rawInput !== 'object') {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Strip part command payload is required.',
      );
    }

    const { photos, ...metadataRaw } = rawInput as StripPartCommand &
      Record<string, unknown>;
    const parsedMeta = StripPartMetadataSchema.safeParse(metadataRaw);
    if (!parsedMeta.success) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        parsedMeta.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    if (!Array.isArray(photos) || photos.length !== 3) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Exactly 3 part photos are required for 3-tap strip intake.',
      );
    }

    const photoDigests: string[] = [];
    for (let i = 0; i < photos.length; i += 1) {
      const photo = photos[i];
      if (!photo || !(photo.bytes instanceof Uint8Array)) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          `Photo ${i + 1} must contain binary image bytes.`,
        );
      }
      if (photo.bytes.byteLength === 0) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          `Photo ${i + 1} must not be empty.`,
        );
      }
      if (photo.bytes.byteLength > MAX_PART_PHOTO_BYTES) {
        throw new PartStripError(
          'PAYLOAD_TOO_LARGE',
          `Photo ${i + 1} exceeds maximum size of ${MAX_PART_PHOTO_BYTES} bytes.`,
        );
      }
      photoDigests.push(computeSha256Hex(photo.bytes));
    }

    const meta = parsedMeta.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const donorVehicleId = assertValidUuidParam(
      meta.donorVehicleId,
      'donorVehicleId',
    );
    const idempotencyKey = assertValidUuidParam(
      meta.idempotencyKey,
      'idempotencyKey',
    );
    const qrSkuCode = normalizeAndValidatePartQrSku(meta.qrSkuCode);
    const destinationBinBarcode = normalizeAndValidateLocationBarcode(
      meta.destinationBinBarcode,
      'destinationBinBarcode',
    );
    const araGradeEnum = mapShortAraGradeToEnum(meta.araGrade);
    const araDamageCode = validateOptionalDamageCode(meta.araDamageCode);
    const deviceTimestamp = parseStrictTimestamp(
      meta.deviceTimestamp,
      'deviceTimestamp',
    );
    const classification = resolvePartClassification({
      partCategoryName: meta.partCategoryName,
      steeringSideCompatibility: meta.steeringSideCompatibility,
      tdgHazmatCode: meta.tdgHazmatCode,
      suggestedHsCode: meta.suggestedHsCode,
    });

    const oemPartNumbers = meta.oemPartNumbers ?? [];
    const interchangePartNumbers = meta.interchangePartNumbers ?? [];
    const oemFitmentVerified = meta.oemFitmentVerified ?? false;
    const conditionNotes = meta.conditionNotes ?? null;

    const commandFingerprint = computeCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'strip',
      payload: {
        donorVehicleId,
        donorExpectedVersion: meta.donorExpectedVersion,
        partCategoryName: classification.partCategoryName,
        qrSkuCode,
        araGrade: meta.araGrade,
        araDamageCode,
        conditionNotes,
        steeringSideCompatibility: classification.steeringSideCompatibility,
        tdgHazmatCode: classification.tdgHazmatCode,
        suggestedHsCode: classification.suggestedHsCode,
        oemFitmentVerified,
        oemPartNumbers,
        interchangePartNumbers,
        compBaselineCadMinor: meta.compBaselineCadMinor,
        weightKg: meta.weightKg,
        destinationBinBarcode,
        photoDigests,
      },
    });

    const receiptId = deriveIssue8CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();
    const storage = this.requireStorage();

    // 1. Short authorized preflight transaction (no storage I/O inside DB tx)
    const preflightReplay = await repository.withTenantTransaction(
      tenantCtx,
      async (tx) => {
        const [existingReceipt, existingCustody] = await Promise.all([
          tx.findCommandReceipt(organizationId, receiptId),
          tx.findCustodyEventByIdempotencyKey(organizationId, idempotencyKey),
        ]);
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'strip',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: existingCustody !== null,
          validateResult: isValidStripPartResult,
        });
        if (replayed) {
          return replayed;
        }

        const [policy, skuExists, donor, existingParts, expenses, scrapLogs, destination] =
          await Promise.all([
            loadPolicyInTx(tx, organizationId),
            tx.partQrSkuExists(qrSkuCode),
            tx.findAndLockDonorVehicle(organizationId, donorVehicleId),
            tx.findAndLockDonorParts(organizationId, donorVehicleId),
            tx.listDonorExpenses(organizationId, donorVehicleId),
            tx.listDonorScrapLogs(organizationId, donorVehicleId),
            tx.findAndLockStorageLocationByBarcode(
              organizationId,
              destinationBinBarcode,
            ),
          ]);

        if (skuExists) {
          throw new PartStripError(
            'DUPLICATE_QR_SKU',
            `Part QR SKU "${qrSkuCode}" already exists.`,
          );
        }

        this.validateStripPreconditions({
          session,
          donor,
          donorExpectedVersion: meta.donorExpectedVersion,
          destination,
          existingParts,
          expenses,
          scrapLogs,
          classification,
          araGradeEnum,
          compBaselineCadMinor: meta.compBaselineCadMinor,
          provisionalPartId: '00000000-0000-4000-8000-000000000000',
          policy,
        });

        return null;
      },
    );

    if (preflightReplay) {
      return preflightReplay;
    }

    // 2. Upload all 3 photos via IStoragePort outside any DB transaction (EXIF GPS stripped)
    const uploadedPhotoUrls: string[] = [];
    for (const photo of photos) {
      const url = await storage.uploadPublicPartMedia({
        actor: session,
        organizationId,
        image: photo.bytes,
      });
      uploadedPhotoUrls.push(url);
    }

    // 3. Final locked atomic transaction
    const commitStrip = async (): Promise<StripPartResult> =>
      repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const [existingReceipt, existingCustody] = await Promise.all([
          tx.findCommandReceipt(organizationId, receiptId),
          tx.findCustodyEventByIdempotencyKey(organizationId, idempotencyKey),
        ]);
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'strip',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: existingCustody !== null,
          validateResult: isValidStripPartResult,
        });
        if (replayed) {
          return replayed;
        }

        const policy = await loadPolicyInTx(tx, organizationId);
        const donor = await tx.findAndLockDonorVehicle(
          organizationId,
          donorVehicleId,
        );
        const existingParts = await tx.findAndLockDonorParts(
          organizationId,
          donorVehicleId,
        );
        const expenses = await tx.listDonorExpenses(
          organizationId,
          donorVehicleId,
        );
        const scrapLogs = await tx.listDonorScrapLogs(
          organizationId,
          donorVehicleId,
        );
        const destination = await tx.findAndLockStorageLocationByBarcode(
          organizationId,
          destinationBinBarcode,
        );

        if (await tx.partQrSkuExists(qrSkuCode)) {
          throw new PartStripError(
            'DUPLICATE_QR_SKU',
            `Part QR SKU "${qrSkuCode}" already exists.`,
          );
        }

        const partId = this.nextUuid();
        const custodyEventId = this.nextUuid();
        const now = this.clock.now();

        const evaluated = this.validateStripPreconditions({
          session,
          donor,
          donorExpectedVersion: meta.donorExpectedVersion,
          destination,
          existingParts,
          expenses,
          scrapLogs,
          classification,
          araGradeEnum,
          compBaselineCadMinor: meta.compBaselineCadMinor,
          provisionalPartId: partId,
          policy,
        });

        const initialState: PartStateSnapshot = {
          custodyState: 'STRIPPED_RAW_OFFLINE',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: classification.complianceState,
        };

        const shelveResult = validatePartTransition(
          initialState,
          'SHELVE_IN_ORIGIN_CONTAINER',
          {
            originBinBarcode: evaluated.destination.fullQrBarcode,
          },
        );

        const partComplianceWarnings = mergeComplianceWarnings(
          [],
          [...evaluated.zoningWarnings, ...shelveResult.warnings],
        );

        // Update donor if lifecycle activation (STAGED_ONTARIO_YARD -> DISMANTLING_IN_PROGRESS)
        // or catalytic converter disposition (PRESENT_AT_INTAKE -> SHELVED_AS_PART) occurred.
        let nextDonorVersion = evaluated.donor.version;
        if (
          evaluated.nextDonorLifecycleState !== undefined ||
          evaluated.nextCatDisposition !== undefined
        ) {
          nextDonorVersion = evaluated.donor.version + 1;
          const donorUpdated = await tx.updateDonorVehicle({
            organizationId,
            donorVehicleId: evaluated.donor.id,
            expectedCurrentVersion: evaluated.donor.version,
            nextVersion: nextDonorVersion,
            lifecycleState: evaluated.nextDonorLifecycleState,
            catalyticConverterDisposition: evaluated.nextCatDisposition,
            updatedAt: now,
          });
          if (!donorUpdated) {
            throw new PartStripError(
              'VERSION_CONFLICT',
              'Donor vehicle version changed concurrently during strip.',
            );
          }

          if (evaluated.nextDonorLifecycleState !== undefined) {
            await tx.insertAuditLog({
              id: this.nextUuid(),
              organizationId,
              actorUserId: tenantCtx.userId,
              entityType: 'Vehicle',
              entityId: evaluated.donor.id,
              action: PART_STRIP_AUDIT_ACTIONS.DONOR_DISMANTLING_STARTED,
              previousState: {
                lifecycleState: evaluated.donor.lifecycleState,
                version: evaluated.donor.version,
              },
              nextState: {
                lifecycleState: evaluated.nextDonorLifecycleState,
                version: nextDonorVersion,
                triggeredByPartId: partId,
              },
              createdAt: now,
            });
          }
        }

        const finalLifecycleState =
          evaluated.nextDonorLifecycleState ?? evaluated.donor.lifecycleState;

        await tx.insertPart({
          id: partId,
          organizationId,
          qrSkuCode,
          donorVehicleId: evaluated.donor.id,
          strippedByUserId: tenantCtx.userId,
          custodyState: shelveResult.nextState.custodyState,
          availabilityState: shelveResult.nextState.availabilityState,
          ebaySyncState: shelveResult.nextState.ebaySyncState,
          classifiedsSyncState: shelveResult.nextState.classifiedsSyncState,
          complianceState: shelveResult.nextState.complianceState,
          partCategoryName: classification.partCategoryName,
          steeringSideCompatibility: classification.steeringSideCompatibility,
          oemFitmentVerified,
          isHazmatOrAirbag: classification.isHazmatOrAirbag,
          tdgHazmatCode: classification.tdgHazmatCode,
          oemPartNumbers,
          interchangePartNumbers,
          suggestedHsCode: classification.suggestedHsCode,
          brokerVerifiedHsCode: null,
          araGrade: araGradeEnum,
          araDamageCode,
          conditionNotes,
          humanVerifiedAt: now,
          weightKg: meta.weightKg,
          rawPhotoUrls: uploadedPhotoUrls,
          cleanPhotoUrls: [],
          storageLocationId: evaluated.destination.id,
          allocatedCostBasisCadMinor: evaluated.newPartAllocatedCostCadMinor,
          compBaselineCadMinor: meta.compBaselineCadMinor,
          complianceWarnings: partComplianceWarnings,
          version: 1,
          strippedAt: now,
        });

        for (const update of evaluated.existingPartCostUpdates) {
          const updated = await tx.updatePartCostBasis({
            organizationId,
            partId: update.partId,
            expectedCurrentVersion: update.expectedCurrentVersion,
            nextVersion: update.expectedCurrentVersion + 1,
            allocatedCostBasisCadMinor: update.newAllocatedCostCadMinor,
            updatedAt: now,
          });
          if (!updated) {
            throw new PartStripError(
              'VERSION_CONFLICT',
              `Concurrent modification detected on part "${update.partId}" during cost allocation.`,
            );
          }
        }

        await tx.insertCustodyEvent({
          id: custodyEventId,
          organizationId,
          partId,
          actorUserId: tenantCtx.userId,
          idempotencyKey,
          fromLocationBarcode: null,
          toLocationBarcode: evaluated.destination.fullQrBarcode,
          expectedVersion: 1,
          hasConflict: false,
          complianceWarnings: evaluated.zoningWarnings,
          deviceTimestamp,
          serverReceivedAt: now,
        });

        const result: StripPartResult = {
          replayed: false,
          partId,
          organizationId,
          donorVehicleId: evaluated.donor.id,
          donorLifecycleState: finalLifecycleState,
          donorVersion: nextDonorVersion,
          qrSkuCode,
          custodyState: shelveResult.nextState.custodyState,
          availabilityState: shelveResult.nextState.availabilityState,
          ebaySyncState: shelveResult.nextState.ebaySyncState,
          classifiedsSyncState: shelveResult.nextState.classifiedsSyncState,
          complianceState: shelveResult.nextState.complianceState,
          partCategoryName: classification.partCategoryName,
          steeringSideCompatibility: classification.steeringSideCompatibility,
          tdgHazmatCode: classification.tdgHazmatCode,
          isHazmatOrAirbag: classification.isHazmatOrAirbag,
          suggestedHsCode: classification.suggestedHsCode,
          araGrade: araGradeEnum,
          araDamageCode,
          allocatedCostBasisCadMinor: evaluated.newPartAllocatedCostCadMinor,
          storageLocationId: evaluated.destination.id,
          destinationBinBarcode: evaluated.destination.fullQrBarcode,
          rawPhotoUrls: uploadedPhotoUrls,
          complianceWarnings: partComplianceWarnings,
          version: 1,
          custodyEventId,
          auditLogId: receiptId,
          strippedAt: now.toISOString(),
        };

        await tx.insertAuditLog({
          id: receiptId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'Part',
          entityId: partId,
          action: PART_STRIP_AUDIT_ACTIONS.STRIP_AND_SHELVE,
          previousState: null,
          nextState: {
            commandReceipt: {
              schemaVersion: PART_STRIP_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'strip',
              commandFingerprint,
              result,
            },
            costAllocationMode: evaluated.costAllocationMode,
            totalAcquisitionAndStripCostCadMinor:
              evaluated.totalAcquisitionAndStripCostCadMinor,
            photoDigests,
            existingPartCostUpdates: evaluated.existingPartCostUpdates,
          },
          createdAt: now,
        });

        return result;
      });

    try {
      return await commitStrip();
    } catch (error) {
      if (
        isPrismaUniqueViolation(error, 'qrSkuCode') ||
        isPrismaUniqueViolation(error, 'Part_qrSkuCode_key')
      ) {
        throw new PartStripError(
          'DUPLICATE_QR_SKU',
          `Part QR SKU "${qrSkuCode}" is already assigned.`,
        );
      }

      if (isPrismaUniqueViolation(error)) {
        const replayed = await repository.withTenantTransaction(
          tenantCtx,
          async (tx) => {
            await tx.acquireOrganizationLock(organizationId);
            const [existingReceipt, existingCustody] = await Promise.all([
              tx.findCommandReceipt(organizationId, receiptId),
              tx.findCustodyEventByIdempotencyKey(
                organizationId,
                idempotencyKey,
              ),
            ]);
            const resolved = resolveIdempotentCommandReplay({
              existingReceipt,
              expectedAction: 'strip',
              expectedIdempotencyKey: idempotencyKey,
              expectedFingerprint: commandFingerprint,
              hasConflictingCustodyEvent: existingCustody !== null,
              validateResult: isValidStripPartResult,
            });
            if (!resolved) {
              throw new PartStripError(
                'IDEMPOTENCY_KEY_REUSED',
                'Idempotency-Key conflicted with a concurrent operation.',
              );
            }
            return resolved;
          },
        );
        return replayed;
      }

      throw error;
    }
  }

  /**
   * Anti-Part-Swap Return QC Intake (`ADR-0006 FIX 01`):
   * SOLD_AND_RELEASED (PAID_SETTLED) -> RESTOCKED_QC_HOLD + RETURNED_QC_HOLD + NEEDS_HUMAN_REVIEW + DELISTED.
   */
  public async receiveReturnedPartIntoQcHold(
    session: AuthSessionContext,
    rawInput: ReceiveReturnCommand,
  ): Promise<ReceiveReturnResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');

    const parsed = ReceiveReturnCommandSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const input = parsed.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const partId = assertValidUuidParam(input.partId, 'partId');
    const idempotencyKey = assertValidUuidParam(
      input.idempotencyKey,
      'idempotencyKey',
    );
    const qcLocationBarcode = normalizeAndValidateLocationBarcode(
      input.qcLocationBarcode,
      'qcLocationBarcode',
    );
    const deviceTimestamp = parseStrictTimestamp(
      input.deviceTimestamp,
      'deviceTimestamp',
    );
    const returnReason = input.returnReason ?? null;

    const commandFingerprint = computeCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'receive-return',
      payload: {
        partId,
        expectedVersion: input.expectedVersion,
        qcLocationBarcode,
        returnReason,
      },
    });

    const receiptId = deriveIssue8CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    const executeTx = async (): Promise<ReceiveReturnResult> =>
      repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const [existingReceipt, existingCustody] = await Promise.all([
          tx.findCommandReceipt(organizationId, receiptId),
          tx.findCustodyEventByIdempotencyKey(organizationId, idempotencyKey),
        ]);
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'receive-return',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: existingCustody !== null,
          validateResult: isValidReceiveReturnResult,
        });
        if (replayed) {
          return replayed;
        }

        const policy = await loadPolicyInTx(tx, organizationId);
        const part = await tx.findAndLockPart(organizationId, partId);
        if (!part) {
          throw new PartStripError(
            'ENTITY_NOT_FOUND',
            `Part "${partId}" was not found in the active organization.`,
          );
        }

        const donor = await tx.findAndLockDonorVehicle(
          organizationId,
          part.donorVehicleId,
        );
        if (!donor) {
          throw new PartStripError(
            'ENTITY_NOT_FOUND',
            'Donor vehicle for returned part was not found in the active organization.',
          );
        }

        if (part.version !== input.expectedVersion) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            `Part version conflict: expected ${input.expectedVersion}, found ${part.version}.`,
          );
        }

        const qcLocation = await tx.findAndLockStorageLocationByBarcode(
          organizationId,
          qcLocationBarcode,
        );
        if (!qcLocation) {
          throw new LocationCustodyError(
            'SITE_ZONING_VIOLATION',
            `Destination location "${qcLocationBarcode}" does not exist in the active organization.`,
          );
        }

        if (
          part.custodyState === 'SOLD_AND_RELEASED' &&
          part.availabilityState !== 'PAID_SETTLED'
        ) {
          throw new PartStripError(
            'PART_STRIP_INTEGRITY_ERROR',
            `Sold part "${part.id}" has unexpected availabilityState "${part.availabilityState}"; expected PAID_SETTLED.`,
          );
        }

        const zoningDecision = this.zoningService.evaluateLocationZoning({
          activeOrganizationId: organizationId,
          activeOrganizationType: session.activeOrganizationType,
          entity: {
            kind: 'PART',
            id: part.id,
            organizationId,
            partCategoryName: part.partCategoryName,
            storageLocationId: part.storageLocationId,
            donorVehicleFluidsDrainedAt: donor.fluidsDrainedAt,
          },
          location: qcLocation,
          complianceEnforcementMode:
            policy.operationalGates.complianceEnforcementMode,
          locationCapacityGateMode:
            policy.operationalGates.locationCapacityGate.enforcementMode,
          currentDestinationActiveAssetCount: 0,
          evaluateCapacity: false,
        });

        const currentSnapshot: PartStateSnapshot = {
          custodyState: part.custodyState,
          availabilityState: part.availabilityState,
          ebaySyncState: part.ebaySyncState,
          classifiedsSyncState: part.classifiedsSyncState,
          complianceState: part.complianceState,
        };

        const transition = validatePartTransition(
          currentSnapshot,
          'RETURN_FROM_BUYER',
        );

        const nextWarnings = mergeComplianceWarnings(part.complianceWarnings, [
          ...zoningDecision.warnings,
          ...transition.warnings,
        ]);
        const nextVersion = part.version + 1;
        const now = this.clock.now();
        const custodyEventId = this.nextUuid();

        const updated = await tx.updatePartStateAndLocation({
          organizationId,
          partId: part.id,
          expectedCurrentVersion: part.version,
          nextVersion,
          custodyState: transition.nextState.custodyState,
          availabilityState: transition.nextState.availabilityState,
          ebaySyncState: transition.nextState.ebaySyncState,
          classifiedsSyncState: transition.nextState.classifiedsSyncState,
          complianceState: transition.nextState.complianceState,
          storageLocationId: qcLocation.id,
          complianceWarnings: nextWarnings,
          updatedAt: now,
        });
        if (!updated) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            'Part version conflicted during return QC intake.',
          );
        }

        await tx.insertCustodyEvent({
          id: custodyEventId,
          organizationId,
          partId: part.id,
          actorUserId: tenantCtx.userId,
          idempotencyKey,
          fromLocationBarcode: part.currentLocationBarcode,
          toLocationBarcode: qcLocation.fullQrBarcode,
          expectedVersion: input.expectedVersion,
          hasConflict: false,
          complianceWarnings: zoningDecision.warnings,
          deviceTimestamp,
          serverReceivedAt: now,
        });

        const result: ReceiveReturnResult = {
          replayed: false,
          partId: part.id,
          organizationId,
          qrSkuCode: part.qrSkuCode,
          custodyState: transition.nextState.custodyState,
          availabilityState: transition.nextState.availabilityState,
          ebaySyncState: transition.nextState.ebaySyncState,
          classifiedsSyncState: transition.nextState.classifiedsSyncState,
          complianceState: transition.nextState.complianceState,
          storageLocationId: qcLocation.id,
          qcLocationBarcode: qcLocation.fullQrBarcode,
          complianceWarnings: nextWarnings,
          version: nextVersion,
          custodyEventId,
          auditLogId: receiptId,
        };

        await tx.insertAuditLog({
          id: receiptId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'Part',
          entityId: part.id,
          action: PART_STRIP_AUDIT_ACTIONS.RETURN_QC_INTAKE,
          previousState: {
            ...currentSnapshot,
            storageLocationId: part.storageLocationId,
            version: part.version,
          },
          nextState: {
            commandReceipt: {
              schemaVersion: PART_STRIP_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'receive-return',
              commandFingerprint,
              result,
            },
            returnReason,
            qcLocationBarcode: qcLocation.fullQrBarcode,
            custodyEventId,
          },
          createdAt: now,
        });

        return result;
      });

    try {
      return await executeTx();
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        return repository.withTenantTransaction(tenantCtx, async (tx) => {
          await tx.acquireOrganizationLock(organizationId);
          const [existingReceipt, existingCustody] = await Promise.all([
            tx.findCommandReceipt(organizationId, receiptId),
            tx.findCustodyEventByIdempotencyKey(organizationId, idempotencyKey),
          ]);
          const resolved = resolveIdempotentCommandReplay({
            existingReceipt,
            expectedAction: 'receive-return',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: commandFingerprint,
            hasConflictingCustodyEvent: existingCustody !== null,
            validateResult: isValidReceiveReturnResult,
          });
          if (!resolved) {
            throw new PartStripError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key conflicted with a concurrent operation.',
            );
          }
          return resolved;
        });
      }
      throw error;
    }
  }

  /**
   * Anti-Part-Swap Return QC Inspection Gate (`ADR-0006 FIX 01`):
   * Clears RESTOCKED_QC_HOLD + RETURNED_QC_HOLD -> SHELVED_ORIGIN_CONTAINER + AVAILABLE + CLEARED_FOR_SALE
   * (or fails to SCRAPPED_OR_DAMAGED + RETURNED_QC_HOLD) after operator attestation of OEM/tamper comparison.
   */
  public async completeReturnQcInspection(
    session: AuthSessionContext,
    rawInput: InspectReturnCommand,
  ): Promise<InspectReturnResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');

    const parsed = InspectReturnCommandSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const input = parsed.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const partId = assertValidUuidParam(input.partId, 'partId');
    const idempotencyKey = assertValidUuidParam(
      input.idempotencyKey,
      'idempotencyKey',
    );
    const deviceTimestamp = parseStrictTimestamp(
      input.deviceTimestamp,
      'deviceTimestamp',
    );

    const normalizedDestinationBarcode = input.destinationBinBarcode
      ? normalizeAndValidateLocationBarcode(
          input.destinationBinBarcode,
          'destinationBinBarcode',
        )
      : null;

    if (input.qcPassed && !normalizedDestinationBarcode) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'destinationBinBarcode is required when qcPassed is true.',
      );
    }

    const commandFingerprint = computeCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'inspect-return',
      payload: {
        partId,
        expectedVersion: input.expectedVersion,
        qcPassed: input.qcPassed,
        inspectedOriginalPhotosAndMarkings:
          input.inspectedOriginalPhotosAndMarkings,
        inspectionNotes: input.inspectionNotes,
        destinationBinBarcode: normalizedDestinationBarcode,
      },
    });

    const receiptId = deriveIssue8CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    const executeTx = async (): Promise<InspectReturnResult> =>
      repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const [existingReceipt, existingCustody] = await Promise.all([
          tx.findCommandReceipt(organizationId, receiptId),
          normalizedDestinationBarcode !== null
            ? tx.findCustodyEventByIdempotencyKey(organizationId, idempotencyKey)
            : Promise.resolve(null),
        ]);
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'inspect-return',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: existingCustody !== null,
          validateResult: isValidInspectReturnResult,
        });
        if (replayed) {
          return replayed;
        }

        const policy = await loadPolicyInTx(tx, organizationId);
        const part = await tx.findAndLockPart(organizationId, partId);
        if (!part) {
          throw new PartStripError(
            'ENTITY_NOT_FOUND',
            `Part "${partId}" was not found in the active organization.`,
          );
        }

        const donor = await tx.findAndLockDonorVehicle(
          organizationId,
          part.donorVehicleId,
        );
        if (!donor) {
          throw new PartStripError(
            'ENTITY_NOT_FOUND',
            'Donor vehicle for inspected part was not found in the active organization.',
          );
        }

        if (part.version !== input.expectedVersion) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            `Part version conflict: expected ${input.expectedVersion}, found ${part.version}.`,
          );
        }

        let destination: LockedStorageLocationRow | null = null;
        let zoningWarnings: readonly string[] = [];

        if (normalizedDestinationBarcode !== null) {
          destination = await tx.findAndLockStorageLocationByBarcode(
            organizationId,
            normalizedDestinationBarcode,
          );
          if (!destination) {
            throw new LocationCustodyError(
              'SITE_ZONING_VIOLATION',
              `Destination location "${normalizedDestinationBarcode}" does not exist in the active organization.`,
            );
          }

          const zoningDecision = this.zoningService.evaluateLocationZoning({
            activeOrganizationId: organizationId,
            activeOrganizationType: session.activeOrganizationType,
            entity: {
              kind: 'PART',
              id: part.id,
              organizationId,
              partCategoryName: part.partCategoryName,
              storageLocationId: part.storageLocationId,
              donorVehicleFluidsDrainedAt: donor.fluidsDrainedAt,
            },
            location: destination,
            complianceEnforcementMode:
              policy.operationalGates.complianceEnforcementMode,
            locationCapacityGateMode:
              policy.operationalGates.locationCapacityGate.enforcementMode,
            currentDestinationActiveAssetCount: 0,
            evaluateCapacity: false,
          });
          zoningWarnings = zoningDecision.warnings;
        }

        const currentSnapshot: PartStateSnapshot = {
          custodyState: part.custodyState,
          availabilityState: part.availabilityState,
          ebaySyncState: part.ebaySyncState,
          classifiedsSyncState: part.classifiedsSyncState,
          complianceState: part.complianceState,
        };

        const transition = input.qcPassed
          ? validatePartTransition(currentSnapshot, 'CLEAR_RETURN_QC', {
              qcPassed: true,
              originBinBarcode: destination?.fullQrBarcode ?? null,
              tdgHazmatCode: part.tdgHazmatCode,
            })
          : validatePartTransition(currentSnapshot, 'FAIL_RETURN_QC_SCRAP', {
              qcPassed: false,
            });

        const nextWarnings = mergeComplianceWarnings(part.complianceWarnings, [
          ...zoningWarnings,
          ...transition.warnings,
        ]);
        const nextVersion = part.version + 1;
        const now = this.clock.now();
        const targetStorageLocationId = destination
          ? destination.id
          : part.storageLocationId;
        const targetBarcode = destination
          ? destination.fullQrBarcode
          : part.currentLocationBarcode;

        const updated = await tx.updatePartStateAndLocation({
          organizationId,
          partId: part.id,
          expectedCurrentVersion: part.version,
          nextVersion,
          custodyState: transition.nextState.custodyState,
          availabilityState: transition.nextState.availabilityState,
          ebaySyncState: transition.nextState.ebaySyncState,
          classifiedsSyncState: transition.nextState.classifiedsSyncState,
          complianceState: transition.nextState.complianceState,
          storageLocationId: targetStorageLocationId,
          complianceWarnings: nextWarnings,
          humanVerifiedAt: now,
          updatedAt: now,
        });
        if (!updated) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            'Part version conflicted during return QC inspection.',
          );
        }

        let custodyEventId: string | null = null;
        if (destination !== null) {
          custodyEventId = this.nextUuid();
          await tx.insertCustodyEvent({
            id: custodyEventId,
            organizationId,
            partId: part.id,
            actorUserId: tenantCtx.userId,
            idempotencyKey,
            fromLocationBarcode: part.currentLocationBarcode,
            toLocationBarcode: destination.fullQrBarcode,
            expectedVersion: input.expectedVersion,
            hasConflict: false,
            complianceWarnings: zoningWarnings,
            deviceTimestamp,
            serverReceivedAt: now,
          });
        }

        const result: InspectReturnResult = {
          replayed: false,
          partId: part.id,
          organizationId,
          qrSkuCode: part.qrSkuCode,
          qcPassed: input.qcPassed,
          custodyState: transition.nextState.custodyState,
          availabilityState: transition.nextState.availabilityState,
          ebaySyncState: transition.nextState.ebaySyncState,
          classifiedsSyncState: transition.nextState.classifiedsSyncState,
          complianceState: transition.nextState.complianceState,
          tdgHazmatCode: part.tdgHazmatCode,
          storageLocationId: targetStorageLocationId,
          destinationBinBarcode: targetBarcode,
          complianceWarnings: nextWarnings,
          version: nextVersion,
          custodyEventId,
          auditLogId: receiptId,
        };

        await tx.insertAuditLog({
          id: receiptId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'Part',
          entityId: part.id,
          action: PART_STRIP_AUDIT_ACTIONS.RETURN_QC_INSPECTED,
          previousState: {
            ...currentSnapshot,
            storageLocationId: part.storageLocationId,
            version: part.version,
          },
          nextState: {
            commandReceipt: {
              schemaVersion: PART_STRIP_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'inspect-return',
              commandFingerprint,
              result,
            },
            inspectedOriginalPhotosAndMarkings: true,
            inspectionNotes: input.inspectionNotes,
            hasActiveSaleLink: part.hasActiveSale,
            custodyEventId,
          },
          createdAt: now,
        });

        return result;
      });

    try {
      return await executeTx();
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        return repository.withTenantTransaction(tenantCtx, async (tx) => {
          await tx.acquireOrganizationLock(organizationId);
          const [existingReceipt, existingCustody] = await Promise.all([
            tx.findCommandReceipt(organizationId, receiptId),
            normalizedDestinationBarcode !== null
              ? tx.findCustodyEventByIdempotencyKey(organizationId, idempotencyKey)
              : Promise.resolve(null),
          ]);
          const resolved = resolveIdempotentCommandReplay({
            existingReceipt,
            expectedAction: 'inspect-return',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: commandFingerprint,
            hasConflictingCustodyEvent: existingCustody !== null,
            validateResult: isValidInspectReturnResult,
          });
          if (!resolved) {
            throw new PartStripError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key conflicted with a concurrent operation.',
            );
          }
          return resolved;
        });
      }
      throw error;
    }
  }

  public async listDonors(
    session: AuthSessionContext,
    filter: { readonly donorVehicleId?: string; readonly limit?: number } = {},
  ): Promise<readonly SafeDonorSummaryRow[]> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');
    const tenantCtx = toTenantExecutionContext(session);
    const limit = normalizeQueryLimit(filter.limit);
    const donorVehicleId = filter.donorVehicleId
      ? assertValidUuidParam(filter.donorVehicleId, 'donorVehicleId')
      : undefined;

    return this.requireRepository().withTenantTransaction(tenantCtx, (tx) =>
      tx.listStripDonors(tenantCtx.organizationId, {
        donorVehicleId,
        limit,
      }),
    );
  }

  public async listParts(
    session: AuthSessionContext,
    filter: {
      readonly donorVehicleId?: string;
      readonly partId?: string;
      readonly qrSkuCode?: string;
      readonly qcHoldOnly?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly SafePartListRow[]> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');
    const tenantCtx = toTenantExecutionContext(session);
    const limit = normalizeQueryLimit(filter.limit);
    const donorVehicleId = filter.donorVehicleId
      ? assertValidUuidParam(filter.donorVehicleId, 'donorVehicleId')
      : undefined;
    const partId = filter.partId
      ? assertValidUuidParam(filter.partId, 'partId')
      : undefined;
    const qrSkuCode = filter.qrSkuCode
      ? normalizeAndValidatePartQrSku(filter.qrSkuCode)
      : undefined;

    return this.requireRepository().withTenantTransaction(tenantCtx, (tx) =>
      tx.listParts(tenantCtx.organizationId, {
        donorVehicleId,
        partId,
        qrSkuCode,
        qcHoldOnly: filter.qcHoldOnly,
        limit,
      }),
    );
  }

  public async listScrapHistory(
    session: AuthSessionContext,
    filter: { readonly donorVehicleId?: string; readonly limit?: number } = {},
  ): Promise<readonly SafeScrapHistoryRow[]> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');
    const tenantCtx = toTenantExecutionContext(session);
    const limit = normalizeQueryLimit(filter.limit);
    const donorVehicleId = filter.donorVehicleId
      ? assertValidUuidParam(filter.donorVehicleId, 'donorVehicleId')
      : undefined;

    return this.requireRepository().withTenantTransaction(tenantCtx, (tx) =>
      tx.listScrapHistory(tenantCtx.organizationId, {
        donorVehicleId,
        limit,
      }),
    );
  }

  public async getScrapTicketPresignedUrl(
    session: AuthSessionContext,
    rawScrapLogId: string,
    ttlSeconds = 300,
  ): Promise<PrivateTicketUrlResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');
    const tenantCtx = toTenantExecutionContext(session);
    const scrapLogId = assertValidUuidParam(rawScrapLogId, 'scrapLogId');

    const log = await this.requireRepository().withTenantTransaction(
      tenantCtx,
      (tx) => tx.findScrapLogById(tenantCtx.organizationId, scrapLogId),
    );
    if (!log) {
      throw new PartStripError(
        'TICKET_NOT_FOUND',
        `Scrap log "${scrapLogId}" was not found in the active organization.`,
      );
    }

    const presignedUrl =
      await this.requireStorage().createPrivateEvidencePresignedUrl({
        actor: session,
        organizationId: tenantCtx.organizationId,
        storageKey: log.recyclerTicketStorageKey,
        ttlSeconds,
      });

    return {
      scrapLogId: log.id,
      presignedUrl,
      ttlSeconds,
    };
  }

  private validateStripPreconditions(params: {
    readonly session: AuthSessionContext;
    readonly donor: LockedDonorVehicleRow | null;
    readonly donorExpectedVersion: number;
    readonly destination: LockedStorageLocationRow | null;
    readonly existingParts: readonly LockedDonorPartRow[];
    readonly expenses: ReturnType<
      typeof computeDonorDirectCostLedger
    > extends never
      ? never
      : readonly import('./part-strip.contracts').LockedDonorExpenseRow[];
    readonly scrapLogs: readonly LockedScrapLogRow[];
    readonly classification: ReturnType<typeof resolvePartClassification>;
    readonly araGradeEnum: ReturnType<typeof mapShortAraGradeToEnum>;
    readonly compBaselineCadMinor: number;
    readonly provisionalPartId: string;
    readonly policy: PricingAndCompliancePolicy;
  }): {
    readonly donor: LockedDonorVehicleRow;
    readonly destination: LockedStorageLocationRow;
    readonly nextDonorLifecycleState: AssetLifecycleState | undefined;
    readonly nextCatDisposition: CatalyticConverterDisposition | undefined;
    readonly zoningWarnings: readonly string[];
    readonly costAllocationMode: 'STAGE_1_PROVISIONAL' | 'STAGE_2_INCREMENTAL';
    readonly totalAcquisitionAndStripCostCadMinor: number;
    readonly newPartAllocatedCostCadMinor: number;
    readonly existingPartCostUpdates: readonly {
      readonly partId: string;
      readonly expectedCurrentVersion: number;
      readonly oldAllocatedCostCadMinor: number;
      readonly newAllocatedCostCadMinor: number;
    }[];
  } {
    const { donor, destination, policy, classification } = params;
    if (!donor) {
      throw new PartStripError(
        'ENTITY_NOT_FOUND',
        'Donor vehicle was not found in the active organization.',
      );
    }
    if (donor.version !== params.donorExpectedVersion) {
      throw new PartStripError(
        'VERSION_CONFLICT',
        `Donor vehicle version conflict: expected ${params.donorExpectedVersion}, found ${donor.version}.`,
      );
    }

    let nextDonorLifecycleState: AssetLifecycleState | undefined;
    if (donor.lifecycleState === 'STAGED_ONTARIO_YARD') {
      const activation = validateVehicleLifecycleTransition(
        donor.lifecycleState,
        'DISMANTLING_IN_PROGRESS',
        {
          assetCategory: donor.assetCategory,
          operationalLane: donor.operationalLane,
          complianceEnforcementMode:
            policy.operationalGates.complianceEnforcementMode,
        },
      );
      nextDonorLifecycleState = activation.nextState;
    } else if (donor.lifecycleState !== 'DISMANTLING_IN_PROGRESS') {
      // Delegate to pure vehicle lifecycle guard for canonical INVALID_VEHICLE_TRANSITION error
      validateVehicleLifecycleTransition(
        donor.lifecycleState,
        'DISMANTLING_IN_PROGRESS',
        {
          assetCategory: donor.assetCategory,
          operationalLane: donor.operationalLane,
          complianceEnforcementMode:
            policy.operationalGates.complianceEnforcementMode,
        },
      );
    }

    let nextCatDisposition: CatalyticConverterDisposition | undefined;
    if (isCatalyticConverterPartCategory(classification.partCategoryName)) {
      if (
        donor.catalyticConverterDisposition === 'MISSING_AT_INTAKE' ||
        donor.catalyticConverterDisposition === 'LOGGED_SCRAP_SALE' ||
        params.scrapLogs.some((s) => s.stream === 'CATALYTIC_CONVERTER')
      ) {
        throw new PartStripError(
          'CATALYTIC_DISPOSITION_CONFLICT',
          `Cannot strip catalytic converter part when donor disposition is "${donor.catalyticConverterDisposition}".`,
        );
      }
      if (donor.catalyticConverterDisposition === 'PRESENT_AT_INTAKE') {
        nextCatDisposition = 'SHELVED_AS_PART';
      }
    }

    if (!destination) {
      throw new LocationCustodyError(
        'SITE_ZONING_VIOLATION',
        'Destination bin location was not found in the active organization.',
      );
    }

    const zoningDecision = this.zoningService.evaluateLocationZoning({
      activeOrganizationId: params.session.activeOrganizationId,
      activeOrganizationType: params.session.activeOrganizationType,
      entity: {
        kind: 'PART',
        id: params.provisionalPartId,
        organizationId: donor.organizationId,
        partCategoryName: classification.partCategoryName,
        storageLocationId: null,
        donorVehicleFluidsDrainedAt: donor.fluidsDrainedAt,
      },
      location: destination,
      complianceEnforcementMode:
        policy.operationalGates.complianceEnforcementMode,
      locationCapacityGateMode:
        policy.operationalGates.locationCapacityGate.enforcementMode,
      currentDestinationActiveAssetCount: 0,
      evaluateCapacity: false,
    });

    const costLedger = computeDonorDirectCostLedger({
      donorVehicleId: donor.id,
      actualPurchasePriceCadMinor: donor.actualPurchasePriceCadMinor,
      expenses: params.expenses,
    });

    const newPartGradeAdjusted = computeGradeAdjustedMarketValueCadMinor(
      params.compBaselineCadMinor,
      params.araGradeEnum,
      policy,
    );

    if (params.scrapLogs.length === 0) {
      const strippedParts: ProvisionalPartAllocationInput[] =
        params.existingParts.map((p) => ({
          partId: p.id,
          organizationId: p.organizationId,
          donorVehicleId: p.donorVehicleId,
          gradeAdjustedMarketValueCadMinor: computePartGradeAdjustedBaseline(
            p,
            policy,
          ),
        }));
      strippedParts.push({
        partId: params.provisionalPartId,
        organizationId: donor.organizationId,
        donorVehicleId: donor.id,
        gradeAdjustedMarketValueCadMinor: newPartGradeAdjusted,
      });

      const provisional = computeProvisionalCostBasis({
        organizationId: donor.organizationId,
        donorVehicleId: donor.id,
        actualPurchasePriceCadMinor: costLedger.actualPurchasePriceCadMinor,
        loggedDirectExpensesCadMinor: costLedger.loggedDirectExpensesCadMinor,
        targetGrossRealizationMinor: donor.targetGrossRealizationMinor,
        strippedParts,
      });

      const newAlloc = provisional.allocations.find(
        (a) => a.partId === params.provisionalPartId,
      );
      if (!newAlloc) {
        throw new PartStripError(
          'PART_STRIP_INTEGRITY_ERROR',
          'Stage 1 provisional allocation missing for new part.',
        );
      }

      return {
        donor,
        destination,
        nextDonorLifecycleState,
        nextCatDisposition,
        zoningWarnings: zoningDecision.warnings,
        costAllocationMode: 'STAGE_1_PROVISIONAL',
        totalAcquisitionAndStripCostCadMinor:
          provisional.totalAcquisitionAndStripCostCadMinor,
        newPartAllocatedCostCadMinor: newAlloc.allocatedCostBasisCadMinor,
        existingPartCostUpdates: [],
      };
    }

    // Donor already has scrap logs: preserve exact Stage 2 cost identity over full snapshot
    const partitioned = partitionDonorPartsForTrueUp({
      organizationId: donor.organizationId,
      donorVehicleId: donor.id,
      parts: params.existingParts,
      policy,
    });

    const trueUp = trueUpDonorCostBasis({
      organizationId: donor.organizationId,
      donorVehicleId: donor.id,
      actualPurchasePriceCadMinor: costLedger.actualPurchasePriceCadMinor,
      loggedDirectExpensesCadMinor: costLedger.loggedDirectExpensesCadMinor,
      scrapLogs: params.scrapLogs,
      soldParts: partitioned.soldParts,
      unsoldParts: [
        ...partitioned.unsoldParts,
        {
          partId: params.provisionalPartId,
          organizationId: donor.organizationId,
          donorVehicleId: donor.id,
          gradeAdjustedMarketValueCadMinor: newPartGradeAdjusted,
        },
      ],
    });

    const newAlloc = trueUp.unsoldAllocations.find(
      (a) => a.partId === params.provisionalPartId,
    );
    if (!newAlloc) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'Stage 2 incremental allocation missing for new part.',
      );
    }

    const existingPartCostUpdates: Array<{
      readonly partId: string;
      readonly expectedCurrentVersion: number;
      readonly oldAllocatedCostCadMinor: number;
      readonly newAllocatedCostCadMinor: number;
    }> = [];

    for (const row of trueUp.unsoldAllocations) {
      if (row.partId === params.provisionalPartId) {
        continue;
      }
      const oldCost = partitioned.existingCostByPartId.get(row.partId);
      const oldVersion = partitioned.existingVersionByPartId.get(row.partId);
      if (oldCost === undefined || oldVersion === undefined) {
        continue;
      }
      if (oldCost !== row.allocatedCostBasisCadMinor) {
        existingPartCostUpdates.push({
          partId: row.partId,
          expectedCurrentVersion: oldVersion,
          oldAllocatedCostCadMinor: oldCost,
          newAllocatedCostCadMinor: row.allocatedCostBasisCadMinor,
        });
      }
    }

    return {
      donor,
      destination,
      nextDonorLifecycleState,
      nextCatDisposition,
      zoningWarnings: zoningDecision.warnings,
      costAllocationMode: 'STAGE_2_INCREMENTAL',
      totalAcquisitionAndStripCostCadMinor:
        trueUp.totalAcquisitionAndStripCostCadMinor,
      newPartAllocatedCostCadMinor: newAlloc.allocatedCostBasisCadMinor,
      existingPartCostUpdates,
    };
  }
}

function normalizeQueryLimit(rawLimit?: number): number {
  if (rawLimit === undefined) {
    return 50;
  }
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      'limit must be an integer between 1 and 200.',
    );
  }
  return rawLimit;
}
