import type {
  AraConditionGradeEnum,
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  CurrencyCode,
  EbaySyncState,
  ExpenseCategory,
  InventoryAvailabilityState,
  OperationalLane,
  PartComplianceState,
  PartCustodyState,
  Prisma,
  PrismaClient,
  ReceiptVerificationState,
  SaleMarketNode,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import type { IStoragePort } from '@/core/ports/storage.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import {
  loadPersistedFinancialSnapshot,
  type PersistedLedgerProjection,
} from '@/modules/cfo-subledger/financial-snapshot.query';
import type {
  LockedDonorPartRow,
  LockedDonorVehicleRow,
} from '@/modules/dismantling/part-strip/part-strip.contracts';
import { translateTenantContextError } from '@/modules/shared-ops/auth';
import {
  createPrismaStorageSecurityRepository,
  createStorageService,
} from '@/modules/shared-ops/storage';
import {
  type ActiveOrgMemberRecord,
  type ExpenseRepository,
  type ExpenseTx,
  type ExpenseUseCaseDeps,
  isValidSha256Hex,
  organizationAdvisoryLockKeys,
  parseExpenseCommandReceiptNextState,
  type PersistAuditLogRecord,
  type PersistCashCustodyTransferRecord,
  type PersistDeferredAccrualSettlementUpdate,
  type PersistExpenseReceiptUpdate,
  type PersistExpenseRecord,
  type PersistOutboxEventRecord,
  type StoredCashCustodyTransferRecord,
  type StoredCommandReceipt,
  type StoredExpenseRecord,
  type TrancheLiveCounts,
  type TrustedEvidenceMetadata,
} from './expenses.contracts';
import {
  LogExpenseUseCase,
  registerDefaultLogExpenseUseCaseFactory,
} from './log-expense.use-case';
import { OperatorFloatSubledgerQueryService } from './operator-float-subledger.query';
import { RecordCashCustodyTransferUseCase } from './record-cash-custody-transfer.use-case';

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

interface RawExpenseRow {
  id: string;
  organizationId: string;
  vehicleId: string | null;
  shipmentId: string | null;
  cannabisLotId: string | null;
  loggedByUserId: string;
  recipientUserId: string | null;
  floatOffsetAppliedCadMinor: number;
  custodyHolderUserId: string | null;
  idempotencyKey: string | null;
  category: ExpenseCategory;
  vendorName: string;
  description: string;
  amountOriginalMinor: number;
  currencyOriginal: CurrencyCode;
  amountCadMinor: number;
  itcReceivableCadMinor: number;
  paidFromCashCustody: CashCustodyState | null;
  isDeferredIntercompanyAccrual: boolean;
  accrualSettledAt: Date | null;
  isReversalEntry: boolean;
  reversesExpenseId: string | null;
  receiptVerificationState: ReceiptVerificationState;
  receiptStorageKey: string | null;
  receiptSha256Hash: string | null;
  voucherReason: string | null;
  incurredAt: Date;
  createdAt: Date;
}

function mapStoredExpense(row: RawExpenseRow): StoredExpenseRecord {
  return {
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    vehicleId: row.vehicleId ? row.vehicleId.toLowerCase() : null,
    shipmentId: row.shipmentId ? row.shipmentId.toLowerCase() : null,
    cannabisLotId: row.cannabisLotId ? row.cannabisLotId.toLowerCase() : null,
    loggedByUserId: row.loggedByUserId.toLowerCase(),
    recipientUserId: row.recipientUserId
      ? row.recipientUserId.toLowerCase()
      : null,
    floatOffsetAppliedCadMinor: row.floatOffsetAppliedCadMinor,
    custodyHolderUserId: row.custodyHolderUserId
      ? row.custodyHolderUserId.toLowerCase()
      : null,
    idempotencyKey: row.idempotencyKey ? row.idempotencyKey.toLowerCase() : null,
    category: row.category,
    vendorName: row.vendorName,
    description: row.description,
    amountOriginalMinor: row.amountOriginalMinor,
    currencyOriginal: row.currencyOriginal,
    amountCadMinor: row.amountCadMinor,
    itcReceivableCadMinor: row.itcReceivableCadMinor,
    paidFromCashCustody: row.paidFromCashCustody,
    isDeferredIntercompanyAccrual: row.isDeferredIntercompanyAccrual,
    accrualSettledAt: row.accrualSettledAt,
    isReversalEntry: row.isReversalEntry,
    reversesExpenseId: row.reversesExpenseId
      ? row.reversesExpenseId.toLowerCase()
      : null,
    receiptVerificationState: row.receiptVerificationState,
    receiptStorageKey: row.receiptStorageKey,
    receiptSha256Hash: row.receiptSha256Hash,
    voucherReason: row.voucherReason,
    incurredAt: row.incurredAt,
    createdAt: row.createdAt,
  };
}

function mapStoredTransfer(row: {
  id: string;
  organizationId: string;
  transferCode: string;
  marketNode: SaleMarketNode;
  fromCustodyState: CashCustodyState;
  toCustodyState: CashCustodyState;
  currency: CurrencyCode;
  amountMinor: number;
  equivalentCadMinor: number;
  commercialBankName: string | null;
  depositSlipStorageKey: string;
  recordedByUserId: string;
  custodyHolderUserId: string | null;
  idempotencyKey: string | null;
  transferredAt: Date;
  createdAt: Date;
}): StoredCashCustodyTransferRecord {
  return {
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    transferCode: row.transferCode,
    marketNode: row.marketNode,
    fromCustodyState: row.fromCustodyState,
    toCustodyState: row.toCustodyState,
    currency: row.currency,
    amountMinor: row.amountMinor,
    equivalentCadMinor: row.equivalentCadMinor,
    commercialBankName: row.commercialBankName,
    depositSlipStorageKey: row.depositSlipStorageKey,
    recordedByUserId: row.recordedByUserId.toLowerCase(),
    custodyHolderUserId: row.custodyHolderUserId
      ? row.custodyHolderUserId.toLowerCase()
      : null,
    idempotencyKey: row.idempotencyKey ? row.idempotencyKey.toLowerCase() : null,
    transferredAt: row.transferredAt,
    createdAt: row.createdAt,
  };
}

/**
 * Production `ExpenseRepository` executing strictly inside `withTenantTransaction`
 * (`FORCE ROW LEVEL SECURITY` as `erp_app_user`) with shared organization advisory
 * locks and parameterized `tx.$queryRaw` row locks.
 */
export function createPrismaExpenseRepository(options?: {
  readonly prisma?: PrismaClient;
}): ExpenseRepository {
  const explicitPrisma = options?.prisma;

  return {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: ExpenseTx) => Promise<T>,
    ): Promise<T> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const txAdapter: ExpenseTx = {
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
              return parseExpenseCommandReceiptNextState(
                audit.id,
                audit.nextState,
              );
            },

            async findExpenseByIdempotencyKey(
              organizationId: string,
              idempotencyKey: string,
            ): Promise<StoredExpenseRecord | null> {
              const row = await tx.expense.findFirst({
                where: {
                  organizationId,
                  idempotencyKey,
                },
              });
              return row ? mapStoredExpense(row) : null;
            },

            async findTransferByIdempotencyKey(
              organizationId: string,
              idempotencyKey: string,
            ): Promise<StoredCashCustodyTransferRecord | null> {
              const row = await tx.cashCustodyTransfer.findFirst({
                where: {
                  organizationId,
                  idempotencyKey,
                },
              });
              return row ? mapStoredTransfer(row) : null;
            },

            async findVerifiedEvidenceMetadata(
              organizationId: string,
              storageKey: string,
            ): Promise<TrustedEvidenceMetadata | null> {
              const audit = await tx.auditLog.findFirst({
                where: {
                  organizationId,
                  entityType: 'PRIVATE_EVIDENCE',
                  entityId: storageKey,
                  action: 'PRIVATE_EVIDENCE_UPLOADED',
                },
                orderBy: { createdAt: 'desc' },
                select: { nextState: true },
              });
              if (
                !audit ||
                !audit.nextState ||
                typeof audit.nextState !== 'object' ||
                Array.isArray(audit.nextState)
              ) {
                return null;
              }
              const state = audit.nextState as Record<string, unknown>;
              if (
                state.storageKey !== storageKey ||
                state.bucketClassification !== 'PRIVATE_EVIDENCE' ||
                !isValidSha256Hex(state.sha256Hash)
              ) {
                return null;
              }
              return {
                storageKey,
                sha256Hash: state.sha256Hash,
              };
            },

            async findActiveOrgMember(
              organizationId: string,
              userId: string,
            ): Promise<ActiveOrgMemberRecord | null> {
              const rows = await tx.$queryRaw<
                Array<{
                  userId: string;
                  organizationId: string;
                  fullName: string;
                  role: UserRole;
                  isActive: boolean;
                }>
              >`
                SELECT
                  m."userId"::text AS "userId",
                  m."organizationId"::text AS "organizationId",
                  u."fullName",
                  m."role"::text AS "role",
                  (m."isActive" AND u."isActive") AS "isActive"
                FROM "shared"."OrganizationMembership" m
                INNER JOIN "shared"."User" u ON u."id" = m."userId"
                WHERE m."organizationId" = ${organizationId}::uuid
                  AND m."userId" = ${userId}::uuid
              `;
              const row = rows[0];
              if (!row || !row.isActive) {
                return null;
              }
              return {
                userId: row.userId.toLowerCase(),
                organizationId: row.organizationId.toLowerCase(),
                fullName: row.fullName,
                role: row.role,
                isActive: row.isActive,
              };
            },

            async listActiveOrgMembers(
              organizationId: string,
            ): Promise<readonly ActiveOrgMemberRecord[]> {
              const rows = await tx.$queryRaw<
                Array<{
                  userId: string;
                  organizationId: string;
                  fullName: string;
                  role: UserRole;
                  isActive: boolean;
                }>
              >`
                SELECT
                  m."userId"::text AS "userId",
                  m."organizationId"::text AS "organizationId",
                  u."fullName",
                  m."role"::text AS "role",
                  (m."isActive" AND u."isActive") AS "isActive"
                FROM "shared"."OrganizationMembership" m
                INNER JOIN "shared"."User" u ON u."id" = m."userId"
                WHERE m."organizationId" = ${organizationId}::uuid
                  AND m."isActive" = true
                  AND u."isActive" = true
                ORDER BY u."fullName" ASC, m."userId" ASC
              `;
              return rows.map((r) => ({
                userId: r.userId.toLowerCase(),
                organizationId: r.organizationId.toLowerCase(),
                fullName: r.fullName,
                role: r.role,
                isActive: r.isActive,
              }));
            },

            async findAndLockVehicle(
              organizationId: string,
              vehicleId: string,
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
                  AND "id" = ${vehicleId}::uuid
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
              return rows.map((row) => ({
                id: row.id.toLowerCase(),
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
                hasActiveSale: false,
                version: row.version,
              }));
            },

            async shipmentExists(
              organizationId: string,
              shipmentId: string,
            ): Promise<boolean> {
              const row = await tx.shipment.findFirst({
                where: {
                  organizationId,
                  id: shipmentId,
                },
                select: { id: true },
              });
              return row !== null;
            },

            async findAndLockExpense(
              organizationId: string,
              expenseId: string,
            ): Promise<StoredExpenseRecord | null> {
              const rows = await tx.$queryRaw<RawExpenseRow[]>`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "vehicleId"::text AS "vehicleId",
                  "shipmentId"::text AS "shipmentId",
                  "cannabisLotId"::text AS "cannabisLotId",
                  "loggedByUserId"::text AS "loggedByUserId",
                  "recipientUserId"::text AS "recipientUserId",
                  "floatOffsetAppliedCadMinor",
                  "custodyHolderUserId"::text AS "custodyHolderUserId",
                  "idempotencyKey",
                  "category"::text AS "category",
                  "vendorName",
                  "description",
                  "amountOriginalMinor",
                  "currencyOriginal"::text AS "currencyOriginal",
                  "amountCadMinor",
                  "itcReceivableCadMinor",
                  "paidFromCashCustody"::text AS "paidFromCashCustody",
                  "isDeferredIntercompanyAccrual",
                  "accrualSettledAt",
                  "isReversalEntry",
                  "reversesExpenseId"::text AS "reversesExpenseId",
                  "receiptVerificationState"::text AS "receiptVerificationState",
                  "receiptStorageKey",
                  "receiptSha256Hash",
                  "voucherReason",
                  "incurredAt",
                  "createdAt"
                FROM "shared"."Expense"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ${expenseId}::uuid
                FOR UPDATE
              `;
              const row = rows[0];
              return row ? mapStoredExpense(row) : null;
            },

            async findTransferById(
              organizationId: string,
              transferId: string,
            ): Promise<StoredCashCustodyTransferRecord | null> {
              const row = await tx.cashCustodyTransfer.findFirst({
                where: {
                  organizationId,
                  id: transferId,
                },
              });
              return row ? mapStoredTransfer(row) : null;
            },

            async sumRollingOperatorVouchersCadMinor(
              organizationId: string,
              loggedByUserId: string,
              windowStart: Date,
              windowEnd: Date,
            ): Promise<number> {
              const vouchers = await tx.expense.findMany({
                where: {
                  organizationId,
                  loggedByUserId,
                  receiptVerificationState: 'PETTY_CASH_VOUCHER',
                  isReversalEntry: false,
                  createdAt: {
                    gte: windowStart,
                    lte: windowEnd,
                  },
                },
                select: {
                  id: true,
                  amountCadMinor: true,
                },
              });
              if (vouchers.length === 0) {
                return 0;
              }
              const voucherIds = vouchers.map((v) => v.id);
              const reversals = await tx.expense.findMany({
                where: {
                  organizationId,
                  isReversalEntry: true,
                  reversesExpenseId: { in: voucherIds },
                },
                select: {
                  reversesExpenseId: true,
                  amountCadMinor: true,
                },
              });
              const reversedMap = new Map<string, number>();
              for (const rev of reversals) {
                if (rev.reversesExpenseId) {
                  const key = rev.reversesExpenseId.toLowerCase();
                  reversedMap.set(
                    key,
                    (reversedMap.get(key) ?? 0) + rev.amountCadMinor,
                  );
                }
              }
              let total = 0;
              for (const v of vouchers) {
                const reversed = reversedMap.get(v.id.toLowerCase()) ?? 0;
                total += Math.max(0, v.amountCadMinor - reversed);
              }
              return total;
            },

            async hasUnreversedPieceRatePayoutForVehicle(
              organizationId: string,
              vehicleId: string,
            ): Promise<boolean> {
              const rows = await tx.expense.findMany({
                where: {
                  organizationId,
                  vehicleId,
                  category: 'YARD_STRIPPER_PIECE_RATE',
                },
                select: {
                  id: true,
                  amountCadMinor: true,
                  isReversalEntry: true,
                  reversesExpenseId: true,
                },
              });
              let net = 0;
              for (const r of rows) {
                net += r.isReversalEntry ? -r.amountCadMinor : r.amountCadMinor;
              }
              return net > 0;
            },

            async hasReversalForExpense(
              organizationId: string,
              expenseId: string,
            ): Promise<boolean> {
              const rev = await tx.expense.findFirst({
                where: {
                  organizationId,
                  isReversalEntry: true,
                  reversesExpenseId: expenseId,
                },
                select: { id: true },
              });
              return rev !== null;
            },

            async loadPersistedSnapshot(
              organizationId: string,
              policy: PricingAndCompliancePolicy,
            ): Promise<PersistedLedgerProjection> {
              return loadPersistedFinancialSnapshot(tx, organizationId, policy);
            },

            async loadTrancheLiveCounts(
              organizationId: string,
              overdueCutoff: Date,
            ): Promise<TrancheLiveCounts> {
              const [shelvedSkusCount, scrappedDonorsCount, pendingFloatRows] =
                await Promise.all([
                  tx.part.count({
                    where: {
                      organizationId,
                      custodyState: 'SHELVED_ORIGIN_CONTAINER',
                      availabilityState: { not: 'RETURNED_QC_HOLD' },
                    },
                  }),
                  tx.vehicle.count({
                    where: {
                      organizationId,
                      lifecycleState: 'SCRAPPED_METAL_CLEARED',
                    },
                  }),
                  tx.expense.findMany({
                    where: {
                      organizationId,
                      receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
                      category: { not: 'PARTNER_TIME_LOG_MEMO' },
                      isReversalEntry: false,
                      createdAt: { lte: overdueCutoff },
                    },
                    select: { id: true },
                  }),
                ]);

              let overdueFloatReceiptsCount = 0;
              if (pendingFloatRows.length > 0) {
                const pendingIds = pendingFloatRows.map((r) => r.id);
                const reversals = await tx.expense.findMany({
                  where: {
                    organizationId,
                    isReversalEntry: true,
                    reversesExpenseId: { in: pendingIds },
                  },
                  select: { reversesExpenseId: true },
                });
                const reversedSet = new Set(
                  reversals
                    .map((r) => r.reversesExpenseId?.toLowerCase())
                    .filter((id): id is string => Boolean(id)),
                );
                for (const row of pendingFloatRows) {
                  if (!reversedSet.has(row.id.toLowerCase())) {
                    overdueFloatReceiptsCount += 1;
                  }
                }
              }

              return {
                shelvedSkusCount,
                scrappedDonorsCount,
                overdueFloatReceiptsCount,
              };
            },

            async listExpenses(
              organizationId: string,
              listOptions?: { readonly limit?: number },
            ): Promise<readonly StoredExpenseRecord[]> {
              const rows = await tx.expense.findMany({
                where: { organizationId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: listOptions?.limit ?? 200,
              });
              return rows.map((r) => mapStoredExpense(r));
            },

            async listCashCustodyTransfers(
              organizationId: string,
              listOptions?: { readonly limit?: number },
            ): Promise<readonly StoredCashCustodyTransferRecord[]> {
              const rows = await tx.cashCustodyTransfer.findMany({
                where: { organizationId },
                orderBy: [{ transferredAt: 'desc' }, { id: 'desc' }],
                take: listOptions?.limit ?? 100,
              });
              return rows.map((r) => mapStoredTransfer(r));
            },

            async insertExpense(record: PersistExpenseRecord): Promise<void> {
              await tx.expense.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  vehicleId: record.vehicleId,
                  shipmentId: record.shipmentId,
                  loggedByUserId: record.loggedByUserId,
                  recipientUserId: record.recipientUserId,
                  floatOffsetAppliedCadMinor: record.floatOffsetAppliedCadMinor,
                  custodyHolderUserId: record.custodyHolderUserId,
                  idempotencyKey: record.idempotencyKey,
                  category: record.category,
                  vendorName: record.vendorName,
                  description: record.description,
                  amountOriginalMinor: record.amountOriginalMinor,
                  currencyOriginal: record.currencyOriginal,
                  amountCadMinor: record.amountCadMinor,
                  itcReceivableCadMinor: record.itcReceivableCadMinor,
                  paidFromCashCustody: record.paidFromCashCustody,
                  isDeferredIntercompanyAccrual:
                    record.isDeferredIntercompanyAccrual,
                  accrualSettledAt: record.accrualSettledAt,
                  receiptVerificationState: record.receiptVerificationState,
                  receiptStorageKey: record.receiptStorageKey,
                  receiptSha256Hash: record.receiptSha256Hash,
                  voucherReason: record.voucherReason,
                  incurredAt: record.incurredAt,
                  createdAt: record.createdAt,
                },
              });
            },

            async updateExpenseReceipt(
              update: PersistExpenseReceiptUpdate,
            ): Promise<void> {
              await tx.expense.update({
                where: {
                  organizationId_id: {
                    organizationId: update.organizationId,
                    id: update.expenseId,
                  },
                },
                data: {
                  receiptVerificationState: 'VERIFIED_RECEIPT',
                  receiptStorageKey: update.receiptStorageKey,
                  receiptSha256Hash: update.receiptSha256Hash,
                  itcReceivableCadMinor: update.itcReceivableCadMinor,
                },
              });
            },

            async settleExpenseDeferredAccrual(
              update: PersistDeferredAccrualSettlementUpdate,
            ): Promise<void> {
              await tx.expense.update({
                where: {
                  organizationId_id: {
                    organizationId: update.organizationId,
                    id: update.expenseId,
                  },
                },
                data: {
                  accrualSettledAt: update.accrualSettledAt,
                  paidFromCashCustody: update.paidFromCashCustody,
                  custodyHolderUserId: update.custodyHolderUserId,
                },
              });
            },

            async insertCashCustodyTransfer(
              record: PersistCashCustodyTransferRecord,
            ): Promise<void> {
              await tx.cashCustodyTransfer.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  transferCode: record.transferCode,
                  marketNode: record.marketNode,
                  fromCustodyState: record.fromCustodyState,
                  toCustodyState: record.toCustodyState,
                  currency: record.currency,
                  amountMinor: record.amountMinor,
                  equivalentCadMinor: record.equivalentCadMinor,
                  commercialBankName: record.commercialBankName,
                  depositSlipStorageKey: record.depositSlipStorageKey,
                  recordedByUserId: record.recordedByUserId,
                  custodyHolderUserId: record.custodyHolderUserId,
                  idempotencyKey: record.idempotencyKey,
                  transferredAt: record.transferredAt,
                  createdAt: record.createdAt,
                },
              });
            },

            async insertAuditLog(record: PersistAuditLogRecord): Promise<void> {
              await tx.auditLog.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  actorUserId: record.actorUserId,
                  entityType: record.entityType,
                  entityId: record.entityId,
                  action: record.action,
                  previousState: record.previousState as
                    | Prisma.InputJsonValue
                    | undefined,
                  nextState: record.nextState as Prisma.InputJsonValue,
                  createdAt: record.createdAt,
                },
              });
            },

            async insertOutboxEvent(
              record: PersistOutboxEventRecord,
            ): Promise<void> {
              await tx.outboxEvent.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  aggregateType: record.aggregateType,
                  aggregateId: record.aggregateId,
                  eventType: record.eventType,
                  payloadJson: record.payloadJson as Prisma.InputJsonValue,
                  idempotencyKey: record.idempotencyKey,
                  createdAt: record.createdAt,
                },
              });
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

export interface ExpenseService {
  readonly logExpense: LogExpenseUseCase['execute'];
  readonly attachExpenseReceipt: LogExpenseUseCase['attachExpenseReceipt'];
  readonly settleDeferredAccrual: LogExpenseUseCase['settleDeferredAccrual'];
  readonly recordCashCustodyTransfer: RecordCashCustodyTransferUseCase['execute'];
  readonly queryOperatorFloatSubledger: OperatorFloatSubledgerQueryService['query'];
  readonly getEvidencePresignedUrl: OperatorFloatSubledgerQueryService['getEvidencePresignedUrl'];
}

export function createExpenseService(deps: ExpenseUseCaseDeps): ExpenseService {
  const logUseCase = new LogExpenseUseCase(deps);
  const transferUseCase = new RecordCashCustodyTransferUseCase(deps);
  const queryService = new OperatorFloatSubledgerQueryService(deps);

  return {
    logExpense: (session, command) => logUseCase.execute(session, command),
    attachExpenseReceipt: logUseCase.attachExpenseReceipt.bind(
      logUseCase,
    ) as LogExpenseUseCase['attachExpenseReceipt'],
    settleDeferredAccrual: logUseCase.settleDeferredAccrual.bind(
      logUseCase,
    ) as LogExpenseUseCase['settleDeferredAccrual'],
    recordCashCustodyTransfer: (session, command) =>
      transferUseCase.execute(session, command),
    queryOperatorFloatSubledger: (session, options) =>
      queryService.query(session, options),
    getEvidencePresignedUrl: (session, input) =>
      queryService.getEvidencePresignedUrl(session, input),
  };
}

function resolveProductionStorage(options?: {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}): IStoragePort {
  if (options?.storage) {
    return options.storage;
  }
  return createStorageService({
    securityRepository: createPrismaStorageSecurityRepository({
      prisma: options?.prisma,
    }),
  });
}

/**
 * Lazy production factory for Issue #9 expense, accrual, cash transfer, and subledger services.
 * Safe to import in offline tests without forcing database or R2 connections on import.
 */
export function createProductionExpenseService(options?: {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}): ExpenseService {
  const repository = createPrismaExpenseRepository({ prisma: options?.prisma });
  const storage = resolveProductionStorage(options);
  return createExpenseService({ repository, storage });
}

export function createProductionLogExpenseUseCase(options?: {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}): LogExpenseUseCase {
  const repository = createPrismaExpenseRepository({ prisma: options?.prisma });
  const storage = resolveProductionStorage(options);
  return new LogExpenseUseCase({ repository, storage });
}

export function createProductionRecordCashCustodyTransferUseCase(options?: {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}): RecordCashCustodyTransferUseCase {
  const repository = createPrismaExpenseRepository({ prisma: options?.prisma });
  const storage = resolveProductionStorage(options);
  return new RecordCashCustodyTransferUseCase({ repository, storage });
}

export function createProductionOperatorFloatSubledgerQueryService(options?: {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}): OperatorFloatSubledgerQueryService {
  const repository = createPrismaExpenseRepository({ prisma: options?.prisma });
  const storage = resolveProductionStorage(options);
  return new OperatorFloatSubledgerQueryService({ repository, storage });
}

registerDefaultLogExpenseUseCaseFactory(() =>
  createProductionLogExpenseUseCase(),
);
