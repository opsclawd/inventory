import type {
  LocationOperationalStatus,
  OrganizationType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import type {
  EasrSiteVehicleCandidate,
  SeparatedFinancialSnapshot,
  WorkingCapitalPolicySlice,
} from '@/core/domain';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import { querySeparatedFinancialSnapshot } from '@/modules/cfo-subledger/financial-snapshot.query';
import { translateTenantContextError } from '@/modules/shared-ops/auth';
import type { AssetDecoderFactory } from './asset-decoder.adapter';
import {
  EXPENSE_LINKED_AUDIT_ACTION,
  EXPENSE_LINKED_AUDIT_ENTITY_TYPE,
  type ExistingIdempotentIntakeRecord,
  type IntakeVehicleRepository,
  type IntakeVehicleResult,
  type IntakeVehicleTx,
  IntakeVehicleUseCase,
  type LockedExistingAcquisitionExpense,
  type LockedIntakeStorageLocation,
  type PersistAcquisitionExpenseRecord,
  type PersistInitialCustodyEventRecord,
  type PersistIntakeAuditLogRecord,
  type PersistVehicleRecord,
  type StoredHtaRegisterRow,
  type StoredVehicleListProjection,
  VEHICLE_INTAKE_AUDIT_ACTION,
  VEHICLE_INTAKE_AUDIT_ENTITY_TYPE,
} from './intake-vehicle.use-case';

function organizationAdvisoryLockKeys(organizationId: string): [number, number] {
  const hex = organizationId.replace(/-/g, '').toLowerCase();
  const key1 = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const key2 = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [key1, key2];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseReplayMetadata(nextState: unknown): {
  readonly commandFingerprint: string | null;
  readonly intakeResult: IntakeVehicleResult | null;
} {
  if (!isPlainRecord(nextState)) {
    return { commandFingerprint: null, intakeResult: null };
  }
  const commandFingerprint =
    typeof nextState.commandFingerprint === 'string' &&
    nextState.commandFingerprint.length > 0
      ? nextState.commandFingerprint
      : null;

  const rawResult = nextState.intakeResult;
  if (!isPlainRecord(rawResult)) {
    return { commandFingerprint, intakeResult: null };
  }

  if (
    typeof rawResult.vehicleId !== 'string' ||
    typeof rawResult.organizationId !== 'string' ||
    typeof rawResult.internalStockNumber !== 'string' ||
    typeof rawResult.assetCategory !== 'string' ||
    typeof rawResult.vinOrHin !== 'string' ||
    typeof rawResult.year !== 'number' ||
    typeof rawResult.make !== 'string' ||
    typeof rawResult.model !== 'string' ||
    typeof rawResult.custodyEventId !== 'string' ||
    typeof rawResult.auditLogId !== 'string' ||
    !Array.isArray(rawResult.complianceWarnings) ||
    typeof rawResult.cfoOverrideApplied !== 'boolean'
  ) {
    return { commandFingerprint, intakeResult: null };
  }

  return {
    commandFingerprint,
    intakeResult: rawResult as unknown as IntakeVehicleResult,
  };
}

async function resolveRuntimePrisma(
  explicitPrisma?: PrismaClient,
): Promise<PrismaClient> {
  if (explicitPrisma) {
    return explicitPrisma;
  }
  const mod = await import('@/infrastructure/db/prisma');
  return mod.prisma;
}

/**
 * Production `IntakeVehicleRepository` executing inside `withTenantTransaction`
 * (`FORCE ROW LEVEL SECURITY` as `erp_app_user`) with custody-compatible organization
 * advisory locks (`pg_advisory_xact_lock`) and parameterized `tx.$queryRaw` row locks.
 */
export function createPrismaIntakeVehicleRepository(options?: {
  readonly prisma?: PrismaClient;
}): IntakeVehicleRepository {
  const explicitPrisma = options?.prisma;

  return {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: IntakeVehicleTx) => Promise<T>,
    ): Promise<T> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const txAdapter: IntakeVehicleTx = {
            async acquireOrganizationLock(
              organizationId: string,
            ): Promise<void> {
              const [k1, k2] = organizationAdvisoryLockKeys(organizationId);
              await tx.$queryRaw<Array<{ locked: string }>>`
                SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)::text AS "locked"
              `;
            },

            async findIdempotentIntake(
              organizationId: string,
              idempotencyKey: string,
            ): Promise<ExistingIdempotentIntakeRecord | null> {
              const existing = await tx.custodyEvent.findFirst({
                where: {
                  organizationId,
                  idempotencyKey,
                },
                select: {
                  id: true,
                  vehicleId: true,
                },
              });
              if (!existing) {
                return null;
              }

              if (existing.vehicleId) {
                const intakeAudit = await tx.auditLog.findFirst({
                  where: {
                    organizationId,
                    entityType: VEHICLE_INTAKE_AUDIT_ENTITY_TYPE,
                    entityId: existing.vehicleId,
                    action: VEHICLE_INTAKE_AUDIT_ACTION,
                  },
                  select: {
                    action: true,
                    nextState: true,
                  },
                });
                if (intakeAudit) {
                  const parsed = parseReplayMetadata(intakeAudit.nextState);
                  return {
                    custodyEventId: existing.id.toLowerCase(),
                    vehicleId: existing.vehicleId.toLowerCase(),
                    auditAction: intakeAudit.action,
                    commandFingerprint: parsed.commandFingerprint,
                    intakeResult: parsed.intakeResult,
                  };
                }
              }

              const otherAudit = await tx.auditLog.findFirst({
                where: {
                  organizationId,
                  entityId: existing.id,
                },
                select: {
                  action: true,
                },
              });

              return {
                custodyEventId: existing.id.toLowerCase(),
                vehicleId: existing.vehicleId
                  ? existing.vehicleId.toLowerCase()
                  : null,
                auditAction: otherAudit?.action ?? null,
                commandFingerprint: null,
                intakeResult: null,
              };
            },

            async readOrganizationPolicyRecord(organizationId: string) {
              const org = await tx.organization.findUnique({
                where: { id: organizationId },
                select: {
                  id: true,
                  policyConfigJson: true,
                },
              });
              if (!org) {
                return null;
              }
              return {
                organizationId: org.id.toLowerCase(),
                policyConfigJson: org.policyConfigJson,
              };
            },

            async findAndLockStorageLocationByBarcode(
              organizationId: string,
              fullQrBarcode: string,
            ): Promise<LockedIntakeStorageLocation | null> {
              const rows = await tx.$queryRaw<
                Array<{
                  id: string;
                  organizationId: string;
                  allowedOrgType: OrganizationType;
                  locationOperationalStatus: LocationOperationalStatus;
                  allowsWholeVehicleDismantling: boolean;
                  maxActiveAssetCapacity: number | null;
                  fullQrBarcode: string;
                }>
              >`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "allowedOrgType"::text AS "allowedOrgType",
                  "locationOperationalStatus"::text AS "locationOperationalStatus",
                  "allowsWholeVehicleDismantling",
                  "maxActiveAssetCapacity",
                  "fullQrBarcode"
                FROM "shared"."StorageLocation"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "fullQrBarcode" = ${fullQrBarcode}
                FOR UPDATE
              `;

              const row = rows[0];
              if (!row) {
                return null;
              }

              return {
                id: row.id.toLowerCase(),
                organizationId: row.organizationId.toLowerCase(),
                allowedOrgType: row.allowedOrgType,
                locationOperationalStatus: row.locationOperationalStatus,
                allowsWholeVehicleDismantling:
                  row.allowsWholeVehicleDismantling,
                maxActiveAssetCapacity: row.maxActiveAssetCapacity,
                fullQrBarcode: row.fullQrBarcode,
              };
            },

            async findAndLockAcquisitionExpenses(
              organizationId: string,
              expenseIds: readonly string[],
            ): Promise<readonly LockedExistingAcquisitionExpense[]> {
              if (expenseIds.length === 0) {
                return [];
              }

              const lockedRows = await tx.$queryRaw<
                Array<{
                  id: string;
                  organizationId: string;
                  vehicleId: string | null;
                  category: string;
                  amountCadMinor: number;
                  currencyOriginal: string;
                  amountOriginalMinor: number;
                  itcReceivableCadMinor: number;
                  paidFromCashCustody: string | null;
                  isDeferredIntercompanyAccrual: boolean;
                  accrualSettledAt: Date | null;
                  isReversalEntry: boolean;
                }>
              >`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "vehicleId"::text AS "vehicleId",
                  "category"::text AS "category",
                  "amountCadMinor",
                  "currencyOriginal"::text AS "currencyOriginal",
                  "amountOriginalMinor",
                  "itcReceivableCadMinor",
                  "paidFromCashCustody"::text AS "paidFromCashCustody",
                  "isDeferredIntercompanyAccrual",
                  "accrualSettledAt",
                  "isReversalEntry"
                FROM "shared"."Expense"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ANY(${[...expenseIds]}::uuid[])
                ORDER BY "id" ASC
                FOR UPDATE
              `;

              const [reversalRows, linkAuditRows] = await Promise.all([
                tx.expense.findMany({
                  where: {
                    organizationId,
                    reversesExpenseId: { in: [...expenseIds] },
                  },
                  select: { reversesExpenseId: true },
                }),
                tx.auditLog.findMany({
                  where: {
                    organizationId,
                    entityType: EXPENSE_LINKED_AUDIT_ENTITY_TYPE,
                    entityId: { in: [...expenseIds] },
                    action: EXPENSE_LINKED_AUDIT_ACTION,
                  },
                  select: { entityId: true },
                }),
              ]);

              const reversedIds = new Set(
                reversalRows
                  .map((r) => r.reversesExpenseId?.toLowerCase())
                  .filter((id): id is string => Boolean(id)),
              );
              const linkedIds = new Set(
                linkAuditRows.map((a) => a.entityId.toLowerCase()),
              );

              return lockedRows.map((row) => {
                const normalizedId = row.id.toLowerCase();
                return {
                  id: normalizedId,
                  organizationId: row.organizationId.toLowerCase(),
                  vehicleId: row.vehicleId ? row.vehicleId.toLowerCase() : null,
                  category: row.category as LockedExistingAcquisitionExpense['category'],
                  amountCadMinor: row.amountCadMinor,
                  currencyOriginal:
                    row.currencyOriginal as LockedExistingAcquisitionExpense['currencyOriginal'],
                  amountOriginalMinor: row.amountOriginalMinor,
                  itcReceivableCadMinor: row.itcReceivableCadMinor,
                  paidFromCashCustody:
                    row.paidFromCashCustody as LockedExistingAcquisitionExpense['paidFromCashCustody'],
                  isDeferredIntercompanyAccrual:
                    row.isDeferredIntercompanyAccrual,
                  accrualSettledAt: row.accrualSettledAt,
                  isReversalEntry: row.isReversalEntry,
                  hasReversalEntry: reversedIds.has(normalizedId),
                  alreadyLinkedInAudit: linkedIds.has(normalizedId),
                };
              });
            },

            async countActiveVehiclesAtLocation(
              organizationId: string,
              storageLocationId: string,
            ): Promise<number> {
              const rows = await tx.$queryRaw<Array<{ count: number }>>`
                SELECT COUNT(*)::int AS "count"
                FROM "salvage"."Vehicle"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "storageLocationId" = ${storageLocationId}::uuid
                  AND "lifecycleState" NOT IN (
                    'PROPOSED_DEAL'::"salvage"."AssetLifecycleState",
                    'SOLD_RETAIL_ONTARIO'::"salvage"."AssetLifecycleState",
                    'SOLD_EXPORT_COD'::"salvage"."AssetLifecycleState",
                    'SCRAPPED_METAL_CLEARED'::"salvage"."AssetLifecycleState"
                  )
              `;
              return rows[0]?.count ?? 0;
            },

            async listActiveAutomobileElvCandidates(
              organizationId: string,
            ): Promise<readonly EasrSiteVehicleCandidate[]> {
              const rows = await tx.vehicle.findMany({
                where: {
                  organizationId,
                  assetCategory: 'AUTOMOBILE',
                  operationalLane: 'DISMANTLE_AND_EXPORT',
                  lifecycleState: {
                    notIn: [
                      'PROPOSED_DEAL',
                      'SCRAPPED_METAL_CLEARED',
                      'SOLD_RETAIL_ONTARIO',
                      'SOLD_EXPORT_COD',
                    ],
                  },
                },
                select: {
                  id: true,
                  assetCategory: true,
                  operationalLane: true,
                  lifecycleState: true,
                },
              });
              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                assetCategory: r.assetCategory,
                operationalLane: r.operationalLane,
                lifecycleState: r.lifecycleState,
              }));
            },

            async queryFinancialSnapshot(
              organizationId: string,
              policy: WorkingCapitalPolicySlice,
            ): Promise<SeparatedFinancialSnapshot> {
              return querySeparatedFinancialSnapshot(
                tx,
                organizationId,
                policy,
              );
            },

            async insertVehicle(input: PersistVehicleRecord): Promise<void> {
              await tx.vehicle.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  internalStockNumber: input.internalStockNumber,
                  assetCategory: input.assetCategory,
                  vinOrHin: input.vinOrHin,
                  year: input.year,
                  make: input.make,
                  model: input.model,
                  trim: input.trim,
                  engineSpec: input.engineSpec,
                  odometerKm: input.odometerKm,
                  engineHours: input.engineHours,
                  exteriorColor: input.exteriorColor,
                  steeringSide: input.steeringSide,
                  oemFitmentVerified: input.oemFitmentVerified,
                  roadBrand: input.roadBrand,
                  operationalLane: input.operationalLane,
                  lifecycleState: input.lifecycleState,
                  availabilityState: input.availabilityState,
                  classifiedsSyncState: input.classifiedsSyncState,
                  storageLocationId: input.storageLocationId,
                  acquisitionSource: input.acquisitionSource,
                  sellerFullName: input.sellerFullName,
                  sellerAddress: input.sellerAddress,
                  sellerPhotoIdStorageKey: input.sellerPhotoIdStorageKey,
                  ontarioPermitNumber: input.ontarioPermitNumber,
                  declaredStatutoryPurpose: input.declaredStatutoryPurpose,
                  suggestedHsCode: input.suggestedHsCode,
                  estimatedMaxBidCadMinor: input.estimatedMaxBidCadMinor,
                  actualPurchasePriceCadMinor:
                    input.actualPurchasePriceCadMinor,
                  estimatedRepairCadMinor: input.estimatedRepairCadMinor,
                  targetGrossRealizationMinor:
                    input.targetGrossRealizationMinor,
                  cfoGateApprovedById: input.cfoGateApprovedById,
                  cfoGateApprovedAt: input.cfoGateApprovedAt,
                  cfoGateOverrideReason: input.cfoGateOverrideReason,
                  driveOnInitialFailAt: input.driveOnInitialFailAt,
                  driveOnReinspectionDeadlineAt:
                    input.driveOnReinspectionDeadlineAt,
                  driveOnFailSheetStorageKey: input.driveOnFailSheetStorageKey,
                  fluidsDrainedAt: input.fluidsDrainedAt,
                  catalyticConverterDisposition:
                    input.catalyticConverterDisposition,
                  complianceWarnings: [...input.complianceWarnings],
                  version: input.version,
                  createdAt: input.createdAt,
                },
              });
            },

            async insertExpenses(
              inputs: readonly PersistAcquisitionExpenseRecord[],
            ): Promise<void> {
              if (inputs.length === 0) {
                return;
              }
              await tx.expense.createMany({
                data: inputs.map((item) => ({
                  id: item.id,
                  organizationId: item.organizationId,
                  vehicleId: item.vehicleId,
                  loggedByUserId: item.loggedByUserId,
                  category: item.category,
                  vendorName: item.vendorName,
                  description: item.description,
                  amountOriginalMinor: item.amountOriginalMinor,
                  currencyOriginal: item.currencyOriginal,
                  amountCadMinor: item.amountCadMinor,
                  itcReceivableCadMinor: item.itcReceivableCadMinor,
                  paidFromCashCustody: item.paidFromCashCustody,
                  receiptVerificationState: item.receiptVerificationState,
                  receiptStorageKey: item.receiptStorageKey,
                  receiptSha256Hash: item.receiptSha256Hash,
                  voucherReason: item.voucherReason,
                  incurredAt: item.incurredAt,
                  createdAt: item.createdAt,
                })),
              });
            },

            async insertCustodyEvent(
              input: PersistInitialCustodyEventRecord,
            ): Promise<void> {
              await tx.custodyEvent.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  partId: null,
                  vehicleId: input.vehicleId,
                  cannabisLotId: null,
                  actorUserId: input.actorUserId,
                  idempotencyKey: input.idempotencyKey,
                  fromLocationBarcode: input.fromLocationBarcode,
                  toLocationBarcode: input.toLocationBarcode,
                  expectedVersion: input.expectedVersion,
                  hasConflict: input.hasConflict,
                  complianceWarnings: [...input.complianceWarnings],
                  deviceTimestamp: input.deviceTimestamp,
                  serverReceivedAt: input.serverReceivedAt,
                },
              });
            },

            async insertAuditLog(
              input: PersistIntakeAuditLogRecord,
            ): Promise<void> {
              await tx.auditLog.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  actorUserId: input.actorUserId,
                  entityType: input.entityType,
                  entityId: input.entityId,
                  action: input.action,
                  previousState:
                    input.previousState === null
                      ? undefined
                      : (input.previousState as Prisma.InputJsonValue),
                  nextState: input.nextState as Prisma.InputJsonValue,
                  createdAt: input.createdAt,
                },
              });
            },

            async listVehicles(
              organizationId: string,
              filter: {
                readonly scope: 'FULL' | 'STRIP_QUEUE_ONLY' | 'EXPORTED_ONLY';
                readonly limit: number;
              },
            ): Promise<readonly StoredVehicleListProjection[]> {
              const where: Prisma.VehicleWhereInput =
                filter.scope === 'STRIP_QUEUE_ONLY'
                  ? {
                      organizationId,
                      operationalLane: 'DISMANTLE_AND_EXPORT',
                      lifecycleState: {
                        in: [
                          'STAGED_ONTARIO_YARD',
                          'DISMANTLING_IN_PROGRESS',
                          'HULK_AWAITING_SCRAP',
                        ],
                      },
                    }
                  : filter.scope === 'EXPORTED_ONLY'
                    ? {
                        organizationId,
                        OR: [
                          { operationalLane: 'WHOLE_UNIT_EXPORT' },
                          {
                            lifecycleState: {
                              in: [
                                'MANIFESTED_WHOLE_EXPORT',
                                'LANDED_TRINIDAD_VAULT',
                                'SOLD_EXPORT_COD',
                              ],
                            },
                          },
                        ],
                      }
                    : { organizationId };

              const rows = await tx.vehicle.findMany({
                where,
                take: filter.limit,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                select: {
                  id: true,
                  internalStockNumber: true,
                  assetCategory: true,
                  vinOrHin: true,
                  year: true,
                  make: true,
                  model: true,
                  trim: true,
                  engineSpec: true,
                  exteriorColor: true,
                  steeringSide: true,
                  roadBrand: true,
                  operationalLane: true,
                  lifecycleState: true,
                  availabilityState: true,
                  storageLocationId: true,
                  storageLocation: {
                    select: { fullQrBarcode: true },
                  },
                  suggestedHsCode: true,
                  catalyticConverterDisposition: true,
                  complianceWarnings: true,
                  driveOnReinspectionDeadlineAt: true,
                  fluidsDrainedAt: true,
                  createdAt: true,
                },
              });

              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                internalStockNumber: r.internalStockNumber,
                assetCategory: r.assetCategory,
                vinOrHin: r.vinOrHin,
                year: r.year,
                make: r.make,
                model: r.model,
                trim: r.trim,
                engineSpec: r.engineSpec,
                exteriorColor: r.exteriorColor,
                steeringSide: r.steeringSide,
                roadBrand: r.roadBrand,
                operationalLane: r.operationalLane,
                lifecycleState: r.lifecycleState,
                availabilityState: r.availabilityState,
                storageLocationId: r.storageLocationId
                  ? r.storageLocationId.toLowerCase()
                  : null,
                destinationBarcode: r.storageLocation?.fullQrBarcode ?? null,
                suggestedHsCode: r.suggestedHsCode,
                catalyticConverterDisposition: r.catalyticConverterDisposition,
                complianceWarnings: r.complianceWarnings ?? [],
                driveOnReinspectionDeadlineAt: r.driveOnReinspectionDeadlineAt,
                fluidsDrainedAt: r.fluidsDrainedAt,
                createdAt: r.createdAt,
              }));
            },

            async listHtaSection60AutomobileRows(
              organizationId: string,
            ): Promise<readonly StoredHtaRegisterRow[]> {
              const rows = await tx.vehicle.findMany({
                where: {
                  organizationId,
                  assetCategory: 'AUTOMOBILE',
                  lifecycleState: { not: 'PROPOSED_DEAL' },
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  internalStockNumber: true,
                  vinOrHin: true,
                  year: true,
                  make: true,
                  model: true,
                  exteriorColor: true,
                  createdAt: true,
                  acquisitionSource: true,
                  sellerFullName: true,
                  sellerAddress: true,
                  ontarioPermitNumber: true,
                  declaredStatutoryPurpose: true,
                  catalyticConverterDisposition: true,
                  lifecycleState: true,
                  scrappedClearedAt: true,
                  soldAt: true,
                  complianceWarnings: true,
                },
              });

              return rows.map((r) => ({
                internalStockNumber: r.internalStockNumber,
                vinOrHin: r.vinOrHin,
                year: r.year,
                make: r.make,
                model: r.model,
                exteriorColor: r.exteriorColor,
                createdAt: r.createdAt,
                acquisitionSource: r.acquisitionSource,
                sellerFullName: r.sellerFullName,
                sellerAddress: r.sellerAddress,
                ontarioPermitNumber: r.ontarioPermitNumber,
                declaredStatutoryPurpose: r.declaredStatutoryPurpose,
                catalyticConverterDisposition: r.catalyticConverterDisposition,
                lifecycleState: r.lifecycleState,
                scrappedClearedAt: r.scrappedClearedAt,
                soldAt: r.soldAt,
                complianceWarnings: r.complianceWarnings ?? [],
              }));
            },
          };

          return fn(txAdapter);
        });
      } catch (error) {
        translateTenantContextError(error);
      }
    },
  };
}

export function createProductionIntakeVehicleUseCase(options?: {
  readonly prisma?: PrismaClient;
  readonly decoderFactory?: AssetDecoderFactory;
}): IntakeVehicleUseCase {
  const repository = createPrismaIntakeVehicleRepository({
    prisma: options?.prisma,
  });
  return new IntakeVehicleUseCase({
    repository,
    decoderFactory: options?.decoderFactory,
  });
}
