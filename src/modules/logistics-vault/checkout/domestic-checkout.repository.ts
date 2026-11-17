import type {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  ClassifiedsSyncState,
  EbaySyncState,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  Prisma,
  PrismaClient,
  TdgHazmatCode,
} from '@prisma/client';
import type { IStoragePort } from '@/core/ports/storage.port';
import type { WorkingCapitalPolicySlice } from '@/core/domain';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import { loadPersistedFinancialSnapshot } from '@/modules/cfo-subledger/financial-snapshot.query';
import { translateTenantContextError } from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import {
  createPrismaStorageSecurityRepository,
  createStorageService,
} from '@/modules/shared-ops/storage';
import {
  type CheckoutLockedPartRow,
  type CheckoutLockedVehicleRow,
  type DomesticCheckoutRepository,
  type DomesticCheckoutTx,
  type EligibleCashSweepTransferRow,
  type PersistedDomesticSaleRecord,
  type StoredCheckoutReceipt,
} from './domestic-checkout.contracts';
import { ExecuteDomesticCheckoutUseCase } from './execute-domestic-checkout.use-case';

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseReceipt(
  auditId: string,
  nextState: unknown,
): StoredCheckoutReceipt | null {
  if (!isPlainRecord(nextState)) {
    return null;
  }
  if (
    typeof nextState.action !== 'string' ||
    typeof nextState.idempotencyKey !== 'string' ||
    typeof nextState.commandFingerprint !== 'string' ||
    nextState.result === undefined
  ) {
    return null;
  }
  return {
    auditId: auditId.toLowerCase(),
    action: nextState.action,
    idempotencyKey: nextState.idempotencyKey,
    commandFingerprint: nextState.commandFingerprint,
    result: nextState.result,
  };
}

interface RawLockedPartRow {
  id: string;
  organizationId: string;
  qrSkuCode: string;
  donorVehicleId: string;
  custodyState: PartCustodyState;
  availabilityState: InventoryAvailabilityState;
  ebaySyncState: EbaySyncState;
  classifiedsSyncState: ClassifiedsSyncState;
  complianceState: PartComplianceState;
  partCategoryName: string;
  tdgHazmatCode: TdgHazmatCode;
  isHazmatOrAirbag: boolean;
  araGrade: string;
  weightKg: Prisma.Decimal | number | string;
  compBaselineCadMinor: number | null;
  retailPriceCadMinor: number | null;
  ebayListingId: string | null;
  storageLocationId: string | null;
  storageLocationBarcode: string | null;
  version: number;
}

interface RawLockedVehicleRow {
  id: string;
  organizationId: string;
  internalStockNumber: string;
  assetCategory: AssetCategory;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  engineSpec: string | null;
  operationalLane: OperationalLane;
  lifecycleState: AssetLifecycleState;
  availabilityState: InventoryAvailabilityState;
  classifiedsSyncState: ClassifiedsSyncState;
  storageLocationId: string | null;
  storageLocationOrgId: string | null;
  storageLocationAllowedOrgType: OrganizationType | null;
  storageLocationStatus: LocationOperationalStatus | null;
  storageLocationAllowsDismantling: boolean | null;
  fluidsDrainedAt: Date | null;
  actualPurchasePriceCadMinor: number;
  estimatedRepairCadMinor: number;
  targetGrossRealizationMinor: number;
  driveOnInitialFailAt: Date | null;
  driveOnSscIssuedAt: Date | null;
  driveOnSscExpiresAt: Date | null;
  complianceWarnings: string[];
  version: number;
}

async function mapLockedParts(
  tx: Prisma.TransactionClient,
  organizationId: string,
  rows: readonly RawLockedPartRow[],
): Promise<readonly CheckoutLockedPartRow[]> {
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
    select: { partId: true },
  });
  const activeSet = new Set(activeSales.map((s) => s.partId.toLowerCase()));

  return rows.map((r) => ({
    id: r.id.toLowerCase(),
    organizationId: r.organizationId.toLowerCase(),
    qrSkuCode: r.qrSkuCode,
    donorVehicleId: r.donorVehicleId.toLowerCase(),
    custodyState: r.custodyState,
    availabilityState: r.availabilityState,
    ebaySyncState: r.ebaySyncState,
    classifiedsSyncState: r.classifiedsSyncState,
    complianceState: r.complianceState,
    partCategoryName: r.partCategoryName,
    tdgHazmatCode: r.tdgHazmatCode,
    isHazmatOrAirbag: r.isHazmatOrAirbag,
    araGrade: r.araGrade,
    weightKg: Number(r.weightKg),
    compBaselineCadMinor: r.compBaselineCadMinor,
    retailPriceCadMinor: r.retailPriceCadMinor,
    ebayListingId: r.ebayListingId,
    storageLocationId: r.storageLocationId
      ? r.storageLocationId.toLowerCase()
      : null,
    storageLocationBarcode: r.storageLocationBarcode,
    hasActiveSale: activeSet.has(r.id.toLowerCase()),
    version: r.version,
  }));
}

async function mapLockedVehicles(
  tx: Prisma.TransactionClient,
  organizationId: string,
  rows: readonly RawLockedVehicleRow[],
): Promise<readonly CheckoutLockedVehicleRow[]> {
  if (rows.length === 0) {
    return [];
  }
  const vehicleIds = rows.map((r) => r.id);
  const activeSales = await tx.saleTransactionVehicleItem.findMany({
    where: {
      organizationId,
      vehicleId: { in: vehicleIds },
      isActiveSale: true,
    },
    select: { vehicleId: true },
  });
  const activeSet = new Set(activeSales.map((s) => s.vehicleId.toLowerCase()));

  return rows.map((r) => ({
    id: r.id.toLowerCase(),
    organizationId: r.organizationId.toLowerCase(),
    internalStockNumber: r.internalStockNumber,
    assetCategory: r.assetCategory,
    year: r.year,
    make: r.make,
    model: r.model,
    trim: r.trim,
    engineSpec: r.engineSpec,
    operationalLane: r.operationalLane,
    lifecycleState: r.lifecycleState,
    availabilityState: r.availabilityState,
    classifiedsSyncState: r.classifiedsSyncState,
    storageLocationId: r.storageLocationId
      ? r.storageLocationId.toLowerCase()
      : null,
    storageLocationOrgId: r.storageLocationOrgId
      ? r.storageLocationOrgId.toLowerCase()
      : null,
    storageLocationAllowedOrgType: r.storageLocationAllowedOrgType,
    storageLocationStatus: r.storageLocationStatus,
    storageLocationAllowsDismantling: r.storageLocationAllowsDismantling,
    fluidsDrainedAt: r.fluidsDrainedAt,
    actualPurchasePriceCadMinor: r.actualPurchasePriceCadMinor,
    estimatedRepairCadMinor: r.estimatedRepairCadMinor,
    targetGrossRealizationMinor: r.targetGrossRealizationMinor,
    driveOnInitialFailAt: r.driveOnInitialFailAt,
    driveOnSscIssuedAt: r.driveOnSscIssuedAt,
    driveOnSscExpiresAt: r.driveOnSscExpiresAt,
    complianceWarnings: r.complianceWarnings ?? [],
    hasActiveSale: activeSet.has(r.id.toLowerCase()),
    version: r.version,
  }));
}

function toPersistedSaleRecord(
  sale: Prisma.SaleTransactionGetPayload<{
    include: { partItems: true; vehicleItems: true };
  }>,
): PersistedDomesticSaleRecord {
  return {
    id: sale.id.toLowerCase(),
    organizationId: sale.organizationId.toLowerCase(),
    receiptNumber: sale.receiptNumber,
    marketNode: sale.marketNode,
    domesticChannel: sale.domesticChannel,
    exportChannel: sale.exportChannel,
    deliveryMethod: sale.deliveryMethod,
    destinationCountryCode: sale.destinationCountryCode,
    destinationProvinceOrState: sale.destinationProvinceOrState,
    exportProofStorageKey: sale.exportProofStorageKey,
    taxInvoiceNumber: sale.taxInvoiceNumber,
    buyerName: sale.buyerName,
    buyerPhoneE164: sale.buyerPhoneE164,
    soldByUserId: sale.soldByUserId.toLowerCase(),
    verifiedByAdminId: sale.verifiedByAdminId.toLowerCase(),
    paymentCurrency: sale.paymentCurrency,
    floorPriceAtCheckoutMinor: sale.floorPriceAtCheckoutMinor,
    subtotalMinor: sale.subtotalMinor,
    discountAmountMinor: sale.discountAmountMinor,
    discountReasonCode: sale.discountReasonCode,
    cfoOverrideApprovedById: sale.cfoOverrideApprovedById
      ? sale.cfoOverrideApprovedById.toLowerCase()
      : null,
    cfoOverrideReasonNote: sale.cfoOverrideReasonNote,
    platformFeeMinor: sale.platformFeeMinor,
    actualPlatformFeeMinor: sale.actualPlatformFeeMinor,
    shippingCostMinor: sale.shippingCostMinor,
    taxCollectionMode: sale.taxCollectionMode,
    appliedTaxJurisdiction: sale.appliedTaxJurisdiction,
    appliedTaxRateBps: sale.appliedTaxRateBps,
    taxOrVatMinor: sale.taxOrVatMinor,
    buyerTaxRemittedByPlatformMinor: sale.buyerTaxRemittedByPlatformMinor,
    estimatedPlatformFeeTaxCadMinor: sale.estimatedPlatformFeeTaxCadMinor,
    itcReceivableCadMinor: sale.itcReceivableCadMinor,
    isFeeTaxInvoiceVerified: sale.isFeeTaxInvoiceVerified,
    feeTaxInvoiceStorageKey: sale.feeTaxInvoiceStorageKey,
    grossCollectedMinor: sale.grossCollectedMinor,
    netRealizedCadMinor: sale.netRealizedCadMinor,
    paymentMethod: sale.paymentMethod,
    paymentSettlementState: sale.paymentSettlementState,
    paymentConfirmedAt: sale.paymentConfirmedAt,
    bankSettledAt: sale.bankSettledAt,
    bankDepositReference: sale.bankDepositReference,
    settlementProofStorageKey: sale.settlementProofStorageKey,
    cashCustodyState: sale.cashCustodyState,
    ebayDelistAttestedAt: sale.ebayDelistAttestedAt,
    complianceWarnings: sale.complianceWarnings ?? [],
    paymentProofStorageKey: sale.paymentProofStorageKey,
    billOfSaleStorageKey: sale.billOfSaleStorageKey,
    isPaymentVerified: sale.isPaymentVerified,
    gateReleasedAt: sale.gateReleasedAt,
    isVoidedOrReversed: sale.isVoidedOrReversed,
    reversesSaleTxId: sale.reversesSaleTxId
      ? sale.reversesSaleTxId.toLowerCase()
      : null,
    voidReason: sale.voidReason,
    createdAt: sale.createdAt,
    partItems: sale.partItems.map((pi) => ({
      id: pi.id.toLowerCase(),
      partId: pi.partId.toLowerCase(),
      soldPriceMinor: pi.soldPriceMinor,
      isActiveSale: pi.isActiveSale,
    })),
    vehicleItems: sale.vehicleItems.map((vi) => ({
      id: vi.id.toLowerCase(),
      vehicleId: vi.vehicleId.toLowerCase(),
      soldPriceMinor: vi.soldPriceMinor,
      isActiveSale: vi.isActiveSale,
    })),
  };
}

export function createPrismaDomesticCheckoutRepository(options?: {
  readonly prisma?: PrismaClient;
}): DomesticCheckoutRepository {
  const explicitPrisma = options?.prisma;

  return {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: DomesticCheckoutTx) => Promise<T>,
    ): Promise<T> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);
      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const txAdapter: DomesticCheckoutTx = {
            async acquireOrganizationLock(organizationId: string): Promise<void> {
              const [k1, k2] = organizationAdvisoryLockKeys(organizationId);
              await tx.$queryRaw<Array<{ locked: string }>>`
                SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)::text AS "locked"
              `;
            },

            async readOrganizationPolicyRecord(organizationId: string) {
              const org = await tx.organization.findUnique({
                where: { id: organizationId },
                select: { id: true, policyConfigJson: true },
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
            ): Promise<StoredCheckoutReceipt | null> {
              const audit = await tx.auditLog.findFirst({
                where: { organizationId, id: receiptAuditId },
                select: { id: true, nextState: true },
              });
              if (!audit) {
                return null;
              }
              return parseReceipt(audit.id, audit.nextState);
            },

            async lockPartsByIds(organizationId, partIds) {
              if (partIds.length === 0) {
                return [];
              }
              const sortedIds = [...partIds].map((id) => id.toLowerCase()).sort();
              const rawRows = await tx.$queryRaw<RawLockedPartRow[]>`
                SELECT
                  p."id"::text AS "id",
                  p."organizationId"::text AS "organizationId",
                  p."qrSkuCode",
                  p."donorVehicleId"::text AS "donorVehicleId",
                  p."custodyState"::text AS "custodyState",
                  p."availabilityState"::text AS "availabilityState",
                  p."ebaySyncState"::text AS "ebaySyncState",
                  p."classifiedsSyncState"::text AS "classifiedsSyncState",
                  p."complianceState"::text AS "complianceState",
                  p."partCategoryName",
                  p."tdgHazmatCode"::text AS "tdgHazmatCode",
                  p."isHazmatOrAirbag",
                  p."araGrade"::text AS "araGrade",
                  p."weightKg",
                  p."compBaselineCadMinor",
                  p."retailPriceCadMinor",
                  p."ebayListingId",
                  p."storageLocationId"::text AS "storageLocationId",
                  sl."fullQrBarcode" AS "storageLocationBarcode",
                  p."version"
                FROM "salvage"."Part" p
                LEFT JOIN "shared"."StorageLocation" sl
                  ON sl."organizationId" = p."organizationId"
                 AND sl."id" = p."storageLocationId"
                WHERE p."organizationId" = ${organizationId}::uuid
                  AND p."id" = ANY(${sortedIds}::uuid[])
                ORDER BY p."id" ASC
                FOR UPDATE OF p
              `;
              return mapLockedParts(tx, organizationId, rawRows);
            },

            async lockVehiclesByIds(organizationId, vehicleIds) {
              if (vehicleIds.length === 0) {
                return [];
              }
              const sortedIds = [...vehicleIds]
                .map((id) => id.toLowerCase())
                .sort();
              const rawRows = await tx.$queryRaw<RawLockedVehicleRow[]>`
                SELECT
                  v."id"::text AS "id",
                  v."organizationId"::text AS "organizationId",
                  v."internalStockNumber",
                  v."assetCategory"::text AS "assetCategory",
                  v."year",
                  v."make",
                  v."model",
                  v."trim",
                  v."engineSpec",
                  v."operationalLane"::text AS "operationalLane",
                  v."lifecycleState"::text AS "lifecycleState",
                  v."availabilityState"::text AS "availabilityState",
                  v."classifiedsSyncState"::text AS "classifiedsSyncState",
                  v."storageLocationId"::text AS "storageLocationId",
                  sl."organizationId"::text AS "storageLocationOrgId",
                  sl."allowedOrgType"::text AS "storageLocationAllowedOrgType",
                  sl."locationOperationalStatus"::text AS "storageLocationStatus",
                  sl."allowsWholeVehicleDismantling" AS "storageLocationAllowsDismantling",
                  v."fluidsDrainedAt",
                  v."actualPurchasePriceCadMinor",
                  v."estimatedRepairCadMinor",
                  v."targetGrossRealizationMinor",
                  v."driveOnInitialFailAt",
                  v."driveOnSscIssuedAt",
                  v."driveOnSscExpiresAt",
                  v."complianceWarnings",
                  v."version"
                FROM "salvage"."Vehicle" v
                LEFT JOIN "shared"."StorageLocation" sl
                  ON sl."organizationId" = v."organizationId"
                 AND sl."id" = v."storageLocationId"
                WHERE v."organizationId" = ${organizationId}::uuid
                  AND v."id" = ANY(${sortedIds}::uuid[])
                ORDER BY v."id" ASC
                FOR UPDATE OF v
              `;
              return mapLockedVehicles(tx, organizationId, rawRows);
            },

            async lookupCheckoutItems(organizationId, query) {
              const code = query?.code?.trim();
              const isUuidCode = code ? isValidUuid(code) : false;

              const [partsRaw, vehiclesRaw] = await Promise.all([
                tx.part.findMany({
                  where: {
                    organizationId,
                    ...(code
                      ? isUuidCode
                        ? { id: code.toLowerCase() }
                        : { qrSkuCode: code.toUpperCase() }
                      : {}),
                  },
                  take: code ? 10 : 50,
                  orderBy: [{ strippedAt: 'desc' }, { id: 'asc' }],
                  include: { storageLocation: true },
                }),
                tx.vehicle.findMany({
                  where: {
                    organizationId,
                    ...(code
                      ? isUuidCode
                        ? { id: code.toLowerCase() }
                        : { internalStockNumber: code.toUpperCase() }
                      : { lifecycleState: 'READY_FOR_RETAIL_SALE' }),
                  },
                  take: code ? 10 : 25,
                  orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                  include: { storageLocation: true },
                }),
              ]);

              const parts = await mapLockedParts(
                tx,
                organizationId,
                partsRaw.map((p) => ({
                  id: p.id,
                  organizationId: p.organizationId,
                  qrSkuCode: p.qrSkuCode,
                  donorVehicleId: p.donorVehicleId,
                  custodyState: p.custodyState,
                  availabilityState: p.availabilityState,
                  ebaySyncState: p.ebaySyncState,
                  classifiedsSyncState: p.classifiedsSyncState,
                  complianceState: p.complianceState,
                  partCategoryName: p.partCategoryName,
                  tdgHazmatCode: p.tdgHazmatCode,
                  isHazmatOrAirbag: p.isHazmatOrAirbag,
                  araGrade: p.araGrade,
                  weightKg: p.weightKg,
                  compBaselineCadMinor: p.compBaselineCadMinor,
                  retailPriceCadMinor: p.retailPriceCadMinor,
                  ebayListingId: p.ebayListingId,
                  storageLocationId: p.storageLocationId,
                  storageLocationBarcode:
                    p.storageLocation?.fullQrBarcode ?? null,
                  version: p.version,
                })),
              );

              const vehicles = await mapLockedVehicles(
                tx,
                organizationId,
                vehiclesRaw.map((v) => ({
                  id: v.id,
                  organizationId: v.organizationId,
                  internalStockNumber: v.internalStockNumber,
                  assetCategory: v.assetCategory,
                  year: v.year,
                  make: v.make,
                  model: v.model,
                  trim: v.trim,
                  engineSpec: v.engineSpec,
                  operationalLane: v.operationalLane,
                  lifecycleState: v.lifecycleState,
                  availabilityState: v.availabilityState,
                  classifiedsSyncState: v.classifiedsSyncState,
                  storageLocationId: v.storageLocationId,
                  storageLocationOrgId:
                    v.storageLocation?.organizationId ?? null,
                  storageLocationAllowedOrgType:
                    v.storageLocation?.allowedOrgType ?? null,
                  storageLocationStatus:
                    v.storageLocation?.locationOperationalStatus ?? null,
                  storageLocationAllowsDismantling:
                    v.storageLocation?.allowsWholeVehicleDismantling ?? null,
                  fluidsDrainedAt: v.fluidsDrainedAt,
                  actualPurchasePriceCadMinor: v.actualPurchasePriceCadMinor,
                  estimatedRepairCadMinor: v.estimatedRepairCadMinor,
                  targetGrossRealizationMinor: v.targetGrossRealizationMinor,
                  driveOnInitialFailAt: v.driveOnInitialFailAt,
                  driveOnSscIssuedAt: v.driveOnSscIssuedAt,
                  driveOnSscExpiresAt: v.driveOnSscExpiresAt,
                  complianceWarnings: v.complianceWarnings,
                  version: v.version,
                })),
              );

              return { parts, vehicles };
            },

            async findAndLockSaleTransaction(organizationId, saleId) {
              await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id"::text AS "id"
                FROM "salvage"."SaleTransaction"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ${saleId}::uuid
                FOR UPDATE
              `;
              const sale = await tx.saleTransaction.findFirst({
                where: { organizationId, id: saleId },
                include: { partItems: true, vehicleItems: true },
              });
              return sale ? toPersistedSaleRecord(sale) : null;
            },

            async findLinkedReversalSale(organizationId, originalSaleId) {
              const rev = await tx.saleTransaction.findFirst({
                where: {
                  organizationId,
                  reversesSaleTxId: originalSaleId,
                },
                include: { partItems: true, vehicleItems: true },
              });
              return rev ? toPersistedSaleRecord(rev) : null;
            },

            async listDomesticSales(organizationId, limit = 100) {
              const rows = await tx.saleTransaction.findMany({
                where: {
                  organizationId,
                  marketNode: 'DOMESTIC_ORIGIN',
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                take: Math.min(Math.max(1, limit), 200),
                include: { partItems: true, vehicleItems: true },
              });
              return rows.map(toPersistedSaleRecord);
            },

            async listEligibleFloatToBankTransfers(
              organizationId,
              sellerUserId,
              upTo,
            ): Promise<readonly EligibleCashSweepTransferRow[]> {
              const normalizedSeller = sellerUserId.toLowerCase();
              const rows = await tx.cashCustodyTransfer.findMany({
                where: {
                  organizationId,
                  marketNode: 'DOMESTIC_ORIGIN',
                  currency: 'CAD',
                  fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
                  toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
                  transferredAt: { lte: upTo },
                },
                orderBy: [{ transferredAt: 'desc' }, { id: 'desc' }],
              });
              return rows
                .filter((r) => {
                  const holder = (
                    r.custodyHolderUserId ?? r.recordedByUserId
                  ).toLowerCase();
                  return (
                    holder === normalizedSeller &&
                    r.depositSlipStorageKey.trim().length > 0
                  );
                })
                .map((r) => ({
                  id: r.id.toLowerCase(),
                  organizationId: r.organizationId.toLowerCase(),
                  transferCode: r.transferCode,
                  marketNode: r.marketNode,
                  fromCustodyState: r.fromCustodyState,
                  toCustodyState: r.toCustodyState,
                  currency: r.currency,
                  amountMinor: r.amountMinor,
                  equivalentCadMinor: r.equivalentCadMinor,
                  depositSlipStorageKey: r.depositSlipStorageKey,
                  recordedByUserId: r.recordedByUserId.toLowerCase(),
                  custodyHolderUserId: r.custodyHolderUserId
                    ? r.custodyHolderUserId.toLowerCase()
                    : null,
                  transferredAt: r.transferredAt,
                }));
            },

            async loadLedgerProjection(organizationId, policy) {
              return loadPersistedFinancialSnapshot(
                tx,
                organizationId,
                policy as WorkingCapitalPolicySlice,
              );
            },

            async insertSaleTransaction(record) {
              await tx.saleTransaction.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  receiptNumber: record.receiptNumber,
                  marketNode: record.marketNode,
                  domesticChannel: record.domesticChannel,
                  exportChannel: record.exportChannel as never,
                  deliveryMethod: record.deliveryMethod,
                  destinationCountryCode: record.destinationCountryCode,
                  destinationProvinceOrState: record.destinationProvinceOrState,
                  exportProofStorageKey: record.exportProofStorageKey,
                  taxInvoiceNumber: record.taxInvoiceNumber,
                  buyerName: record.buyerName,
                  buyerPhoneE164: record.buyerPhoneE164,
                  soldByUserId: record.soldByUserId,
                  verifiedByAdminId: record.verifiedByAdminId,
                  paymentCurrency: record.paymentCurrency,
                  floorPriceAtCheckoutMinor: record.floorPriceAtCheckoutMinor,
                  subtotalMinor: record.subtotalMinor,
                  discountAmountMinor: record.discountAmountMinor,
                  discountReasonCode: record.discountReasonCode,
                  cfoOverrideApprovedById: record.cfoOverrideApprovedById,
                  cfoOverrideReasonNote: record.cfoOverrideReasonNote,
                  platformFeeMinor: record.platformFeeMinor,
                  actualPlatformFeeMinor: record.actualPlatformFeeMinor,
                  shippingCostMinor: record.shippingCostMinor,
                  taxCollectionMode: record.taxCollectionMode,
                  appliedTaxJurisdiction: record.appliedTaxJurisdiction,
                  appliedTaxRateBps: record.appliedTaxRateBps,
                  taxOrVatMinor: record.taxOrVatMinor,
                  buyerTaxRemittedByPlatformMinor:
                    record.buyerTaxRemittedByPlatformMinor,
                  estimatedPlatformFeeTaxCadMinor:
                    record.estimatedPlatformFeeTaxCadMinor,
                  itcReceivableCadMinor: record.itcReceivableCadMinor,
                  isFeeTaxInvoiceVerified: record.isFeeTaxInvoiceVerified,
                  feeTaxInvoiceStorageKey: record.feeTaxInvoiceStorageKey,
                  grossCollectedMinor: record.grossCollectedMinor,
                  netRealizedCadMinor: record.netRealizedCadMinor,
                  paymentMethod: record.paymentMethod,
                  paymentSettlementState: record.paymentSettlementState,
                  paymentConfirmedAt: record.paymentConfirmedAt,
                  bankSettledAt: record.bankSettledAt,
                  bankDepositReference: record.bankDepositReference,
                  settlementProofStorageKey: record.settlementProofStorageKey,
                  cashCustodyState: record.cashCustodyState,
                  ebayDelistAttestedAt: record.ebayDelistAttestedAt,
                  complianceWarnings: [...record.complianceWarnings],
                  paymentProofStorageKey: record.paymentProofStorageKey,
                  billOfSaleStorageKey: record.billOfSaleStorageKey,
                  isPaymentVerified: record.isPaymentVerified,
                  gateReleasedAt: record.gateReleasedAt,
                  isVoidedOrReversed: record.isVoidedOrReversed,
                  reversesSaleTxId: record.reversesSaleTxId,
                  voidReason: record.voidReason,
                  createdAt: record.createdAt,
                },
              });
            },

            async insertSalePartItems(items) {
              if (items.length === 0) return;
              await tx.saleTransactionPartItem.createMany({
                data: items.map((i) => ({
                  id: i.id,
                  organizationId: i.organizationId,
                  saleTransactionId: i.saleTransactionId,
                  partId: i.partId,
                  soldPriceMinor: i.soldPriceMinor,
                  isActiveSale: i.isActiveSale,
                })),
              });
            },

            async insertSaleVehicleItems(items) {
              if (items.length === 0) return;
              await tx.saleTransactionVehicleItem.createMany({
                data: items.map((i) => ({
                  id: i.id,
                  organizationId: i.organizationId,
                  saleTransactionId: i.saleTransactionId,
                  vehicleId: i.vehicleId,
                  soldPriceMinor: i.soldPriceMinor,
                  isActiveSale: i.isActiveSale,
                })),
              });
            },

            async updatePartAfterCheckoutOrReturn(input) {
              const res = await tx.part.updateMany({
                where: {
                  id: input.partId,
                  organizationId: input.organizationId,
                  version: input.expectedVersion,
                },
                data: {
                  version: input.nextVersion,
                  custodyState: input.custodyState,
                  availabilityState: input.availabilityState,
                  ebaySyncState: input.ebaySyncState,
                  classifiedsSyncState: input.classifiedsSyncState,
                  complianceState: input.complianceState,
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async updateVehicleAfterCheckout(input) {
              const res = await tx.vehicle.updateMany({
                where: {
                  id: input.vehicleId,
                  organizationId: input.organizationId,
                  version: input.expectedVersion,
                },
                data: {
                  version: input.nextVersion,
                  lifecycleState: input.lifecycleState,
                  availabilityState: input.availabilityState,
                  classifiedsSyncState: input.classifiedsSyncState,
                  complianceWarnings: [...input.complianceWarnings],
                  realizedRetailSaleCadMinor: input.realizedRetailSaleCadMinor,
                  soldAt: input.soldAt,
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async updateSaleBankSettlement(input) {
              await tx.saleTransaction.updateMany({
                where: {
                  id: input.saleId,
                  organizationId: input.organizationId,
                },
                data: {
                  paymentSettlementState: input.paymentSettlementState,
                  cashCustodyState: input.cashCustodyState,
                  paymentConfirmedAt: input.paymentConfirmedAt,
                  bankSettledAt: input.bankSettledAt,
                  bankDepositReference: input.bankDepositReference,
                  settlementProofStorageKey: input.settlementProofStorageKey,
                  actualPlatformFeeMinor: input.actualPlatformFeeMinor,
                  isFeeTaxInvoiceVerified: input.isFeeTaxInvoiceVerified,
                  feeTaxInvoiceStorageKey: input.feeTaxInvoiceStorageKey,
                  itcReceivableCadMinor: input.itcReceivableCadMinor,
                  isPaymentVerified: input.isPaymentVerified,
                  gateReleasedAt: input.gateReleasedAt,
                },
              });
            },

            async markSaleRefundedOrChargedBack(input) {
              await tx.saleTransaction.updateMany({
                where: {
                  id: input.saleId,
                  organizationId: input.organizationId,
                },
                data: {
                  paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
                  isVoidedOrReversed: true,
                  voidReason: input.voidReason,
                },
              });
            },

            async insertCustodyEvent(record) {
              await tx.custodyEvent.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  partId: record.partId,
                  actorUserId: record.actorUserId,
                  idempotencyKey: record.idempotencyKey,
                  fromLocationBarcode: record.fromLocationBarcode,
                  toLocationBarcode: record.toLocationBarcode,
                  expectedVersion: record.expectedVersion,
                  hasConflict: record.hasConflict,
                  complianceWarnings: [...record.complianceWarnings],
                  deviceTimestamp: record.deviceTimestamp,
                  serverReceivedAt: record.serverReceivedAt,
                },
              });
            },

            async insertOutboxEvent(record) {
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

            async insertAuditLog(record) {
              await tx.auditLog.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  actorUserId: record.actorUserId,
                  entityType: record.entityType,
                  entityId: record.entityId,
                  action: record.action,
                  previousState: record.previousState as Prisma.InputJsonValue,
                  nextState: record.nextState as Prisma.InputJsonValue,
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

export function createProductionDomesticCheckoutUseCase(options?: {
  readonly prisma?: PrismaClient;
  readonly storage?: IStoragePort;
}): ExecuteDomesticCheckoutUseCase {
  return new ExecuteDomesticCheckoutUseCase({
    repository: createPrismaDomesticCheckoutRepository({
      prisma: options?.prisma,
    }),
    storage:
      options?.storage ??
      createStorageService(
        options?.prisma
          ? {
              securityRepository: createPrismaStorageSecurityRepository({
                prisma: options.prisma,
              }),
            }
          : {},
      ),
  });
}
