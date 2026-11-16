import type {
  AraConditionGradeEnum,
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  EbaySyncState,
  ExpenseCategory,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  Prisma,
  PrismaClient,
  ScrapStreamCategory,
  SteeringSideCompatibility,
  TdgHazmatCode,
} from '@prisma/client';
import type { IStoragePort } from '@/core/ports/storage.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import { translateTenantContextError } from '@/modules/shared-ops/auth';
import { createStorageService } from '@/modules/shared-ops/storage';
import { CompleteHulkScrapUseCase } from './complete-hulk-scrap.use-case';
import { LogScrapComponentUseCase } from './log-scrap-component.use-case';
import {
  type LockedDonorExpenseRow,
  type LockedDonorPartRow,
  type LockedDonorVehicleRow,
  type LockedScrapLogRow,
  type LockedStorageLocationRow,
  parseCommandReceiptNextState,
  type PartStripRepository,
  type PartStripTx,
  type PersistAuditLogRecord,
  type PersistNewPartRecord,
  type PersistPartCustodyEventRecord,
  type PersistScrapLogRecord,
  type SafeDonorSummaryRow,
  type SafePartListRow,
  type SafeScrapHistoryRow,
  type StoredCommandReceipt,
} from './part-strip.contracts';
import { StripPartUseCase } from './strip-part.use-case';

function organizationAdvisoryLockKeys(organizationId: string): [number, number] {
  const hex = organizationId.replace(/-/g, '').toLowerCase();
  const key1 = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const key2 = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [key1, key2];
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

interface RawLockedPartRow {
  id: string;
  organizationId: string;
  donorVehicleId: string;
  qrSkuCode: string;
  custodyState: PartCustodyState;
  availabilityState: InventoryAvailabilityState;
  ebaySyncState: EbaySyncState;
  classifiedsSyncState: ClassifiedsSyncState;
  complianceState: PartComplianceState;
  partCategoryName: string;
  tdgHazmatCode: TdgHazmatCode;
  araGrade: AraConditionGradeEnum;
  compBaselineCadMinor: number | null;
  allocatedCostBasisCadMinor: number;
  storageLocationId: string | null;
  currentLocationBarcode: string | null;
  rawPhotoUrls: string[];
  complianceWarnings: string[];
  version: number;
}

async function mapLockedPartRows(
  tx: Prisma.TransactionClient,
  organizationId: string,
  rows: readonly RawLockedPartRow[],
): Promise<readonly LockedDonorPartRow[]> {
  if (rows.length === 0) {
    return [];
  }
  const partIds = rows.map((r) => r.id);
  const activeSales = await tx.saleTransactionPartItem.findMany({
    where: {
      organizationId,
      partId: { in: partIds },
      isActiveSale: true,
    },
    select: {
      partId: true,
    },
  });
  const activeSaleSet = new Set(activeSales.map((s) => s.partId.toLowerCase()));

  return rows.map((row) => {
    const normalizedId = row.id.toLowerCase();
    return {
      id: normalizedId,
      organizationId: row.organizationId.toLowerCase(),
      donorVehicleId: row.donorVehicleId.toLowerCase(),
      qrSkuCode: row.qrSkuCode,
      custodyState: row.custodyState,
      availabilityState: row.availabilityState,
      ebaySyncState: row.ebaySyncState,
      classifiedsSyncState: row.classifiedsSyncState,
      complianceState: row.complianceState,
      partCategoryName: row.partCategoryName,
      tdgHazmatCode: row.tdgHazmatCode,
      araGrade: row.araGrade,
      compBaselineCadMinor: row.compBaselineCadMinor,
      allocatedCostBasisCadMinor: row.allocatedCostBasisCadMinor,
      storageLocationId: row.storageLocationId
        ? row.storageLocationId.toLowerCase()
        : null,
      currentLocationBarcode: row.currentLocationBarcode,
      rawPhotoUrls: row.rawPhotoUrls ?? [],
      complianceWarnings: row.complianceWarnings ?? [],
      hasActiveSale: activeSaleSet.has(normalizedId),
      version: row.version,
    };
  });
}

/**
 * Production `PartStripRepository` backed strictly by `withTenantTransaction`
 * (`FORCE ROW LEVEL SECURITY` as `erp_app_user`) with custody-compatible advisory locks
 * and parameterized `tx.$queryRaw` row locks.
 */
export function createPrismaPartStripRepository(options?: {
  readonly prisma?: PrismaClient;
}): PartStripRepository {
  const explicitPrisma = options?.prisma;

  return {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: PartStripTx) => Promise<T>,
    ): Promise<T> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const txAdapter: PartStripTx = {
            async acquireOrganizationLock(organizationId: string): Promise<void> {
              const [k1, k2] = organizationAdvisoryLockKeys(organizationId);
              await tx.$queryRaw<Array<{ locked: string }>>`
                SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)::text AS "locked"
              `;
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

            async findCommandReceipt(
              organizationId: string,
              receiptAuditId: string,
            ): Promise<StoredCommandReceipt | null> {
              const audit = await tx.auditLog.findFirst({
                where: {
                  organizationId,
                  id: receiptAuditId,
                },
                select: {
                  id: true,
                  nextState: true,
                },
              });
              if (!audit) {
                return null;
              }
              return parseCommandReceiptNextState(audit.id, audit.nextState);
            },

            async findCustodyEventByIdempotencyKey(
              organizationId: string,
              idempotencyKey: string,
            ): Promise<{ id: string } | null> {
              const existing = await tx.custodyEvent.findFirst({
                where: {
                  organizationId,
                  idempotencyKey,
                },
                select: { id: true },
              });
              return existing ? { id: existing.id.toLowerCase() } : null;
            },

            async partQrSkuExists(qrSkuCode: string): Promise<boolean> {
              const existing = await tx.part.findFirst({
                where: { qrSkuCode },
                select: { id: true },
              });
              return existing !== null;
            },

            async findAndLockDonorVehicle(
              organizationId: string,
              donorVehicleId: string,
            ): Promise<LockedDonorVehicleRow | null> {
              const rows = await tx.$queryRaw<
                Array<{
                  id: string;
                  organizationId: string;
                  internalStockNumber: string;
                  assetCategory: AssetCategory;
                  operationalLane: OperationalLane;
                  lifecycleState: AssetLifecycleState;
                  actualPurchasePriceCadMinor: number;
                  targetGrossRealizationMinor: number;
                  fluidsDrainedAt: Date | null;
                  catalyticConverterDisposition: CatalyticConverterDisposition;
                  scrapMetalTicketKey: string | null;
                  scrapRecoveryCadMinor: number;
                  scrappedClearedAt: Date | null;
                  complianceWarnings: string[];
                  version: number;
                }>
              >`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "internalStockNumber",
                  "assetCategory"::text AS "assetCategory",
                  "operationalLane"::text AS "operationalLane",
                  "lifecycleState"::text AS "lifecycleState",
                  "actualPurchasePriceCadMinor",
                  "targetGrossRealizationMinor",
                  "fluidsDrainedAt",
                  "catalyticConverterDisposition"::text AS "catalyticConverterDisposition",
                  "scrapMetalTicketKey",
                  "scrapRecoveryCadMinor",
                  "scrappedClearedAt",
                  "complianceWarnings",
                  "version"
                FROM "salvage"."Vehicle"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ${donorVehicleId}::uuid
                FOR UPDATE
              `;

              const row = rows[0];
              if (!row) {
                return null;
              }
              return {
                id: row.id.toLowerCase(),
                organizationId: row.organizationId.toLowerCase(),
                internalStockNumber: row.internalStockNumber,
                assetCategory: row.assetCategory,
                operationalLane: row.operationalLane,
                lifecycleState: row.lifecycleState,
                actualPurchasePriceCadMinor: row.actualPurchasePriceCadMinor,
                targetGrossRealizationMinor: row.targetGrossRealizationMinor,
                fluidsDrainedAt: row.fluidsDrainedAt,
                catalyticConverterDisposition:
                  row.catalyticConverterDisposition,
                scrapMetalTicketKey: row.scrapMetalTicketKey,
                scrapRecoveryCadMinor: row.scrapRecoveryCadMinor,
                scrappedClearedAt: row.scrappedClearedAt,
                complianceWarnings: row.complianceWarnings ?? [],
                version: row.version,
              };
            },

            async findAndLockDonorParts(
              organizationId: string,
              donorVehicleId: string,
            ): Promise<readonly LockedDonorPartRow[]> {
              const rows = await tx.$queryRaw<RawLockedPartRow[]>`
                SELECT
                  p."id"::text AS "id",
                  p."organizationId"::text AS "organizationId",
                  p."donorVehicleId"::text AS "donorVehicleId",
                  p."qrSkuCode",
                  p."custodyState"::text AS "custodyState",
                  p."availabilityState"::text AS "availabilityState",
                  p."ebaySyncState"::text AS "ebaySyncState",
                  p."classifiedsSyncState"::text AS "classifiedsSyncState",
                  p."complianceState"::text AS "complianceState",
                  p."partCategoryName",
                  p."tdgHazmatCode"::text AS "tdgHazmatCode",
                  p."araGrade"::text AS "araGrade",
                  p."compBaselineCadMinor",
                  p."allocatedCostBasisCadMinor",
                  p."storageLocationId"::text AS "storageLocationId",
                  sl."fullQrBarcode" AS "currentLocationBarcode",
                  p."rawPhotoUrls",
                  p."complianceWarnings",
                  p."version"
                FROM "salvage"."Part" p
                LEFT JOIN "shared"."StorageLocation" sl
                  ON sl."organizationId" = p."organizationId"
                 AND sl."id" = p."storageLocationId"
                WHERE p."organizationId" = ${organizationId}::uuid
                  AND p."donorVehicleId" = ${donorVehicleId}::uuid
                ORDER BY p."id" ASC
                FOR UPDATE OF p
              `;
              return mapLockedPartRows(tx, organizationId, rows);
            },

            async findAndLockPart(
              organizationId: string,
              partId: string,
            ): Promise<LockedDonorPartRow | null> {
              const rows = await tx.$queryRaw<RawLockedPartRow[]>`
                SELECT
                  p."id"::text AS "id",
                  p."organizationId"::text AS "organizationId",
                  p."donorVehicleId"::text AS "donorVehicleId",
                  p."qrSkuCode",
                  p."custodyState"::text AS "custodyState",
                  p."availabilityState"::text AS "availabilityState",
                  p."ebaySyncState"::text AS "ebaySyncState",
                  p."classifiedsSyncState"::text AS "classifiedsSyncState",
                  p."complianceState"::text AS "complianceState",
                  p."partCategoryName",
                  p."tdgHazmatCode"::text AS "tdgHazmatCode",
                  p."araGrade"::text AS "araGrade",
                  p."compBaselineCadMinor",
                  p."allocatedCostBasisCadMinor",
                  p."storageLocationId"::text AS "storageLocationId",
                  sl."fullQrBarcode" AS "currentLocationBarcode",
                  p."rawPhotoUrls",
                  p."complianceWarnings",
                  p."version"
                FROM "salvage"."Part" p
                LEFT JOIN "shared"."StorageLocation" sl
                  ON sl."organizationId" = p."organizationId"
                 AND sl."id" = p."storageLocationId"
                WHERE p."organizationId" = ${organizationId}::uuid
                  AND p."id" = ${partId}::uuid
                FOR UPDATE OF p
              `;
              const mapped = await mapLockedPartRows(tx, organizationId, rows);
              return mapped[0] ?? null;
            },

            async listDonorExpenses(
              organizationId: string,
              donorVehicleId: string,
            ): Promise<readonly LockedDonorExpenseRow[]> {
              const rows = await tx.expense.findMany({
                where: {
                  organizationId,
                  vehicleId: donorVehicleId,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  organizationId: true,
                  vehicleId: true,
                  category: true,
                  amountCadMinor: true,
                  isReversalEntry: true,
                  reversesExpenseId: true,
                },
              });
              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                organizationId: r.organizationId.toLowerCase(),
                vehicleId: r.vehicleId ? r.vehicleId.toLowerCase() : null,
                category: r.category as ExpenseCategory,
                amountCadMinor: r.amountCadMinor,
                isReversalEntry: r.isReversalEntry,
                reversesExpenseId: r.reversesExpenseId
                  ? r.reversesExpenseId.toLowerCase()
                  : null,
              }));
            },

            async listDonorScrapLogs(
              organizationId: string,
              donorVehicleId: string,
            ): Promise<readonly LockedScrapLogRow[]> {
              const rows = await tx.scrapComponentLog.findMany({
                where: {
                  organizationId,
                  vehicleId: donorVehicleId,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  organizationId: true,
                  vehicleId: true,
                  scrapStream: true,
                  weightKg: true,
                  payoutCadMinor: true,
                  recyclerName: true,
                  recyclerTicketStorageKey: true,
                  cashCustodyState: true,
                  recordedByUserId: true,
                  createdAt: true,
                },
              });
              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                organizationId: r.organizationId.toLowerCase(),
                donorVehicleId: r.vehicleId.toLowerCase(),
                stream: r.scrapStream,
                weightKg: r.weightKg !== null ? Number(r.weightKg) : null,
                payoutCadMinor: r.payoutCadMinor,
                recyclerName: r.recyclerName,
                recyclerTicketStorageKey: r.recyclerTicketStorageKey,
                cashCustodyState: r.cashCustodyState,
                recordedByUserId: r.recordedByUserId.toLowerCase(),
                createdAt: r.createdAt,
              }));
            },

            async findScrapLogById(
              organizationId: string,
              scrapLogId: string,
            ): Promise<LockedScrapLogRow | null> {
              const r = await tx.scrapComponentLog.findFirst({
                where: {
                  organizationId,
                  id: scrapLogId,
                },
                select: {
                  id: true,
                  organizationId: true,
                  vehicleId: true,
                  scrapStream: true,
                  weightKg: true,
                  payoutCadMinor: true,
                  recyclerName: true,
                  recyclerTicketStorageKey: true,
                  cashCustodyState: true,
                  recordedByUserId: true,
                  createdAt: true,
                },
              });
              if (!r) {
                return null;
              }
              return {
                id: r.id.toLowerCase(),
                organizationId: r.organizationId.toLowerCase(),
                donorVehicleId: r.vehicleId.toLowerCase(),
                stream: r.scrapStream,
                weightKg: r.weightKg !== null ? Number(r.weightKg) : null,
                payoutCadMinor: r.payoutCadMinor,
                recyclerName: r.recyclerName,
                recyclerTicketStorageKey: r.recyclerTicketStorageKey,
                cashCustodyState: r.cashCustodyState,
                recordedByUserId: r.recordedByUserId.toLowerCase(),
                createdAt: r.createdAt,
              };
            },

            async findAndLockStorageLocationByBarcode(
              organizationId: string,
              fullQrBarcode: string,
            ): Promise<LockedStorageLocationRow | null> {
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

            async insertPart(input: PersistNewPartRecord): Promise<void> {
              await tx.part.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  qrSkuCode: input.qrSkuCode,
                  donorVehicleId: input.donorVehicleId,
                  strippedByUserId: input.strippedByUserId,
                  custodyState: input.custodyState,
                  availabilityState: input.availabilityState,
                  ebaySyncState: input.ebaySyncState,
                  classifiedsSyncState: input.classifiedsSyncState,
                  complianceState: input.complianceState,
                  partCategoryName: input.partCategoryName,
                  steeringSideCompatibility: input.steeringSideCompatibility,
                  oemFitmentVerified: input.oemFitmentVerified,
                  isHazmatOrAirbag: input.isHazmatOrAirbag,
                  tdgHazmatCode: input.tdgHazmatCode,
                  oemPartNumbers: [...input.oemPartNumbers],
                  interchangePartNumbers: [...input.interchangePartNumbers],
                  suggestedHsCode: input.suggestedHsCode,
                  brokerVerifiedHsCode: null,
                  araGrade: input.araGrade,
                  araDamageCode: input.araDamageCode,
                  conditionNotes: input.conditionNotes,
                  humanVerifiedAt: input.humanVerifiedAt,
                  weightKg: input.weightKg,
                  rawPhotoUrls: [...input.rawPhotoUrls],
                  cleanPhotoUrls: [...input.cleanPhotoUrls],
                  storageLocationId: input.storageLocationId,
                  allocatedCostBasisCadMinor: input.allocatedCostBasisCadMinor,
                  compBaselineCadMinor: input.compBaselineCadMinor,
                  complianceWarnings: [...input.complianceWarnings],
                  version: input.version,
                  strippedAt: input.strippedAt,
                },
              });
            },

            async updatePartStateAndLocation(input): Promise<boolean> {
              const res = await tx.part.updateMany({
                where: {
                  id: input.partId,
                  organizationId: input.organizationId,
                  version: input.expectedCurrentVersion,
                },
                data: {
                  custodyState: input.custodyState,
                  availabilityState: input.availabilityState,
                  ebaySyncState: input.ebaySyncState,
                  classifiedsSyncState: input.classifiedsSyncState,
                  complianceState: input.complianceState,
                  storageLocationId: input.storageLocationId,
                  complianceWarnings: [...input.complianceWarnings],
                  ...(input.humanVerifiedAt !== undefined
                    ? { humanVerifiedAt: input.humanVerifiedAt }
                    : {}),
                  version: input.nextVersion,
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async updatePartCostBasis(input): Promise<boolean> {
              const res = await tx.part.updateMany({
                where: {
                  id: input.partId,
                  organizationId: input.organizationId,
                  version: input.expectedCurrentVersion,
                },
                data: {
                  allocatedCostBasisCadMinor: input.allocatedCostBasisCadMinor,
                  version: input.nextVersion,
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async updateDonorVehicle(input): Promise<boolean> {
              const res = await tx.vehicle.updateMany({
                where: {
                  id: input.donorVehicleId,
                  organizationId: input.organizationId,
                  version: input.expectedCurrentVersion,
                },
                data: {
                  ...(input.lifecycleState !== undefined
                    ? { lifecycleState: input.lifecycleState }
                    : {}),
                  ...(input.catalyticConverterDisposition !== undefined
                    ? {
                        catalyticConverterDisposition:
                          input.catalyticConverterDisposition,
                      }
                    : {}),
                  ...(input.scrapMetalTicketKey !== undefined
                    ? { scrapMetalTicketKey: input.scrapMetalTicketKey }
                    : {}),
                  ...(input.scrapRecoveryCadMinor !== undefined
                    ? { scrapRecoveryCadMinor: input.scrapRecoveryCadMinor }
                    : {}),
                  ...(input.scrappedClearedAt !== undefined
                    ? { scrappedClearedAt: input.scrappedClearedAt }
                    : {}),
                  ...(input.complianceWarnings !== undefined
                    ? { complianceWarnings: [...input.complianceWarnings] }
                    : {}),
                  version: input.nextVersion,
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async insertScrapComponentLog(
              input: PersistScrapLogRecord,
            ): Promise<void> {
              await tx.scrapComponentLog.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  vehicleId: input.vehicleId,
                  scrapStream: input.scrapStream,
                  weightKg: input.weightKg,
                  payoutCadMinor: input.payoutCadMinor,
                  recyclerName: input.recyclerName,
                  recyclerTicketStorageKey: input.recyclerTicketStorageKey,
                  cashCustodyState: input.cashCustodyState,
                  recordedByUserId: input.recordedByUserId,
                  createdAt: input.createdAt,
                },
              });
            },

            async insertCustodyEvent(
              input: PersistPartCustodyEventRecord,
            ): Promise<void> {
              await tx.custodyEvent.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  partId: input.partId,
                  vehicleId: null,
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

            async insertAuditLog(input: PersistAuditLogRecord): Promise<void> {
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

            async listStripDonors(
              organizationId: string,
              filter: {
                readonly donorVehicleId?: string;
                readonly limit: number;
              },
            ): Promise<readonly SafeDonorSummaryRow[]> {
              const rows = await tx.vehicle.findMany({
                where: {
                  organizationId,
                  operationalLane: 'DISMANTLE_AND_EXPORT',
                  ...(filter.donorVehicleId
                    ? { id: filter.donorVehicleId }
                    : {}),
                  lifecycleState: {
                    in: [
                      'STAGED_ONTARIO_YARD',
                      'DISMANTLING_IN_PROGRESS',
                      'HULK_AWAITING_SCRAP',
                      'SCRAPPED_METAL_CLEARED',
                    ],
                  },
                },
                take: filter.limit,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                select: {
                  id: true,
                  internalStockNumber: true,
                  assetCategory: true,
                  year: true,
                  make: true,
                  model: true,
                  operationalLane: true,
                  lifecycleState: true,
                  fluidsDrainedAt: true,
                  catalyticConverterDisposition: true,
                  scrapRecoveryCadMinor: true,
                  scrappedClearedAt: true,
                  complianceWarnings: true,
                  version: true,
                  scrapComponentLogs: {
                    where: { scrapStream: 'BARE_STEEL_SHELL' },
                    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                    select: { id: true },
                  },
                },
              });

              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                internalStockNumber: r.internalStockNumber,
                assetCategory: r.assetCategory,
                year: r.year,
                make: r.make,
                model: r.model,
                operationalLane: r.operationalLane,
                lifecycleState: r.lifecycleState,
                fluidsDrainedAt: r.fluidsDrainedAt?.toISOString() ?? null,
                catalyticConverterDisposition: r.catalyticConverterDisposition,
                scrapRecoveryCadMinor: r.scrapRecoveryCadMinor,
                scrappedClearedAt: r.scrappedClearedAt?.toISOString() ?? null,
                complianceWarnings: r.complianceWarnings ?? [],
                bareShellScrapLogIds: r.scrapComponentLogs.map((l) =>
                  l.id.toLowerCase(),
                ),
                version: r.version,
              }));
            },

            async listParts(
              organizationId: string,
              filter: {
                readonly donorVehicleId?: string;
                readonly partId?: string;
                readonly qrSkuCode?: string;
                readonly qcHoldOnly?: boolean;
                readonly limit: number;
              },
            ): Promise<readonly SafePartListRow[]> {
              const rows = await tx.part.findMany({
                where: {
                  organizationId,
                  ...(filter.donorVehicleId
                    ? { donorVehicleId: filter.donorVehicleId }
                    : {}),
                  ...(filter.partId ? { id: filter.partId } : {}),
                  ...(filter.qrSkuCode ? { qrSkuCode: filter.qrSkuCode } : {}),
                  ...(filter.qcHoldOnly
                    ? {
                        OR: [
                          { custodyState: 'RESTOCKED_QC_HOLD' },
                          { availabilityState: 'RETURNED_QC_HOLD' },
                        ],
                      }
                    : {}),
                },
                take: filter.limit,
                orderBy: [{ strippedAt: 'desc' }, { id: 'asc' }],
                select: {
                  id: true,
                  qrSkuCode: true,
                  donorVehicleId: true,
                  custodyState: true,
                  availabilityState: true,
                  ebaySyncState: true,
                  classifiedsSyncState: true,
                  complianceState: true,
                  partCategoryName: true,
                  steeringSideCompatibility: true,
                  tdgHazmatCode: true,
                  isHazmatOrAirbag: true,
                  suggestedHsCode: true,
                  araGrade: true,
                  araDamageCode: true,
                  weightKg: true,
                  rawPhotoUrls: true,
                  storageLocationId: true,
                  storageLocation: {
                    select: { fullQrBarcode: true },
                  },
                  allocatedCostBasisCadMinor: true,
                  compBaselineCadMinor: true,
                  complianceWarnings: true,
                  version: true,
                  strippedAt: true,
                },
              });

              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                qrSkuCode: r.qrSkuCode,
                donorVehicleId: r.donorVehicleId.toLowerCase(),
                custodyState: r.custodyState,
                availabilityState: r.availabilityState,
                ebaySyncState: r.ebaySyncState,
                classifiedsSyncState: r.classifiedsSyncState,
                complianceState: r.complianceState,
                partCategoryName: r.partCategoryName,
                steeringSideCompatibility: r.steeringSideCompatibility,
                tdgHazmatCode: r.tdgHazmatCode,
                isHazmatOrAirbag: r.isHazmatOrAirbag,
                suggestedHsCode: r.suggestedHsCode,
                araGrade: r.araGrade,
                araDamageCode: r.araDamageCode,
                weightKg: Number(r.weightKg),
                rawPhotoUrls: r.rawPhotoUrls ?? [],
                storageLocationId: r.storageLocationId
                  ? r.storageLocationId.toLowerCase()
                  : null,
                locationBarcode: r.storageLocation?.fullQrBarcode ?? null,
                allocatedCostBasisCadMinor: r.allocatedCostBasisCadMinor,
                compBaselineCadMinor: r.compBaselineCadMinor,
                complianceWarnings: r.complianceWarnings ?? [],
                version: r.version,
                strippedAt: r.strippedAt.toISOString(),
              }));
            },

            async listScrapHistory(
              organizationId: string,
              filter: {
                readonly donorVehicleId?: string;
                readonly limit: number;
              },
            ): Promise<readonly SafeScrapHistoryRow[]> {
              const rows = await tx.scrapComponentLog.findMany({
                where: {
                  organizationId,
                  ...(filter.donorVehicleId
                    ? { vehicleId: filter.donorVehicleId }
                    : {}),
                },
                take: filter.limit,
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                select: {
                  id: true,
                  vehicleId: true,
                  scrapStream: true,
                  weightKg: true,
                  payoutCadMinor: true,
                  recyclerName: true,
                  cashCustodyState: true,
                  createdAt: true,
                },
              });

              return rows.map((r) => ({
                id: r.id.toLowerCase(),
                vehicleId: r.vehicleId.toLowerCase(),
                scrapStream: r.scrapStream,
                weightKg: r.weightKg !== null ? Number(r.weightKg) : null,
                payoutCadMinor: r.payoutCadMinor,
                recyclerName: r.recyclerName,
                cashCustodyState: r.cashCustodyState,
                hasTicketEvidence: true,
                createdAt: r.createdAt.toISOString(),
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

export interface PartStripFactoryOptions {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}

export function createProductionStripPartUseCase(
  options?: PartStripFactoryOptions,
): StripPartUseCase {
  return new StripPartUseCase({
    repository: createPrismaPartStripRepository({ prisma: options?.prisma }),
    storage: options?.storage ?? createStorageService(),
  });
}

export function createProductionLogScrapComponentUseCase(
  options?: PartStripFactoryOptions,
): LogScrapComponentUseCase {
  return new LogScrapComponentUseCase({
    repository: createPrismaPartStripRepository({ prisma: options?.prisma }),
    storage: options?.storage ?? createStorageService(),
  });
}

export function createProductionCompleteHulkScrapUseCase(
  options?: PartStripFactoryOptions,
): CompleteHulkScrapUseCase {
  return new CompleteHulkScrapUseCase({
    repository: createPrismaPartStripRepository({ prisma: options?.prisma }),
    storage: options?.storage ?? createStorageService(),
  });
}
