import type {
  CashCustodyState,
  CurrencyCode,
  DomesticSaleChannel,
  ExpenseCategory,
  ExportSaleChannel,
  InventoryAvailabilityState,
  PartCustodyState,
  PaymentSettlementState,
  Prisma,
  ReceiptVerificationState,
  SaleMarketNode,
  TaxCollectionMode,
} from '@prisma/client';
import {
  bigIntToSafeNumber,
  computeDetailedTaxCounters,
  computeSeparatedFinancialSnapshot,
  DomainRuleError,
  type FinancialSnapshotInput,
  type SeparatedFinancialSnapshot,
  type SnapshotCashTransferRow,
  type SnapshotDonorVehicleSummaryRow,
  type SnapshotExpenseRow,
  type SnapshotRefundAdjustmentRow,
  type SnapshotRepatriationRow,
  type SnapshotSaleRow,
  type SnapshotScrapRow,
  type WorkingCapitalPolicySlice,
} from '@/core/domain';

const ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
  new Set<ExpenseCategory>([
    'AUCTION_BUYER_FEE',
    'TOWING_AND_RECOVERY',
    'YARD_STRIPPER_PIECE_RATE',
    'RAMSAYVILLE_SHOP_LABOR',
    'REFRIGERANT_EVAC_AND_PREP',
  ]);

export interface PersistedSaleLedgerRow {
  readonly id: string;
  readonly organizationId: string;
  readonly marketNode: SaleMarketNode;
  readonly domesticChannel: DomesticSaleChannel | null;
  readonly exportChannel: ExportSaleChannel | null;
  readonly paymentCurrency: CurrencyCode;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly subtotalMinor: number;
  readonly taxOrVatMinor: number;
  readonly buyerTaxRemittedByPlatformMinor: number | null;
  readonly platformFeeMinor: number;
  readonly shippingCostMinor: number;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly feeTaxInvoiceStorageKey: string | null;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
  readonly bankSettledAt: Date | string | null;
  readonly bankDepositReference: string | null;
  readonly soldByUserId: string;
  readonly isVoidedOrReversed: boolean;
  readonly reversesSaleTxId?: string | null;
  readonly brokerCommissionMinor?: number;
  readonly isBrokerCommissionDeductedAtCounter?: boolean;
}

export interface PersistedScrapLedgerRow {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string;
  readonly payoutCadMinor: number;
  readonly cashCustodyState: CashCustodyState;
  readonly recordedByUserId: string;
}

export interface PersistedCashTransferLedgerRow {
  readonly id: string;
  readonly organizationId: string;
  readonly marketNode: SaleMarketNode;
  readonly fromCustodyState: CashCustodyState;
  readonly toCustodyState: CashCustodyState;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor: number;
  readonly depositSlipStorageKey: string;
  readonly recordedByUserId: string;
  readonly custodyHolderUserId?: string | null;
}

export interface PersistedCurrencySettlementRow {
  readonly id: string;
  readonly organizationId: string;
  readonly targetCurrency: CurrencyCode;
  readonly totalTargetSettledMinor: bigint | number;
  readonly settledInCanadaAt: Date | string | null;
}

export interface PersistedExpenseLedgerRow {
  readonly id: string;
  readonly organizationId: string;
  readonly category: ExpenseCategory;
  readonly vehicleId: string | null;
  readonly currencyOriginal: CurrencyCode;
  readonly amountOriginalMinor: number;
  readonly amountCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody: CashCustodyState | null;
  readonly loggedByUserId: string;
  readonly recipientUserId?: string | null;
  readonly floatOffsetAppliedCadMinor?: number;
  readonly custodyHolderUserId?: string | null;
  readonly isDeferredIntercompanyAccrual: boolean;
  readonly accrualSettledAt: Date | string | null;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey: string | null;
  readonly isReversalEntry: boolean;
  readonly reversesExpenseId?: string | null;
}

export interface PersistedDonorVehicleRow {
  readonly id: string;
  readonly organizationId: string;
  readonly actualPurchasePriceCadMinor: number;
  readonly scrapRecoveryCadMinor: number;
}

export interface PersistedDonorPartRow {
  readonly id: string;
  readonly donorVehicleId: string;
  readonly compBaselineCadMinor: number | null;
  readonly availabilityState: InventoryAvailabilityState;
  readonly custodyState: PartCustodyState;
}

export interface PersistedSalePartItemRow {
  readonly saleTransactionId: string;
  readonly partId: string;
  readonly soldPriceMinor: number;
  readonly isActiveSale: boolean;
}

export interface PersistedTaxAndLiquidityCounters {
  readonly directTaxCollectedNetOfRefundsCadMinor: number;
  readonly buyerTaxRemittedByPlatformCadMinor: number | null;
  readonly hasUnknownMarketplaceBuyerTax: boolean;
  readonly unverifiedPlatformFeeTaxAccruedCadMinor: number;
  readonly verifiedItcReceivableCadMinor: number;
  readonly netHstTrustLiabilityCadMinor: number;
}

export interface PersistedLedgerProjection {
  readonly snapshotInput: FinancialSnapshotInput;
  readonly snapshot: SeparatedFinancialSnapshot;
  readonly taxCounters: PersistedTaxAndLiquidityCounters;
  readonly destinationVaultCashByCurrency: Readonly<Record<string, number>>;
}

function normalizeSignedMagnitude(
  value: number,
  expectedDirection: 'NON_NEGATIVE' | 'NON_POSITIVE',
  fieldLabel: string,
): number {
  if (!Number.isSafeInteger(value)) {
    throw new DomainRuleError(
      'INVALID_MONETARY_AMOUNT',
      `${fieldLabel} must be a finite safe integer.`,
    );
  }
  if (expectedDirection === 'NON_NEGATIVE' && value < 0) {
    throw new DomainRuleError(
      'INVALID_INPUT',
      `${fieldLabel} has mixed sign inside reversal SaleTransaction.`,
    );
  }
  if (expectedDirection === 'NON_POSITIVE' && value > 0) {
    throw new DomainRuleError(
      'INVALID_INPUT',
      `${fieldLabel} has mixed sign inside reversal SaleTransaction.`,
    );
  }
  return -Math.abs(value);
}

/**
 * Pure normalization contract converting persisted database rows (including linked
 * `SaleTransaction.reversesSaleTxId` reversals, donor vehicle/part projections, and
 * tax/ITC counters) into `SeparatedFinancialSnapshot` inputs.
 *
 * Contract for downstream checkout consumers (Issue #10):
 * - A persisted reversal `SaleTransaction` MUST set `reversesSaleTxId` to a non-reversal
 *   parent sale in the same organization with matching `marketNode`, `paymentCurrency`, and
 *   `taxCollectionMode`, and MUST NOT set `isVoidedOrReversed = true` on the reversal row itself.
 * - Reversal monetary fields (`subtotalMinor`, `taxOrVatMinor`, `grossCollectedMinor`,
 *   `netRealizedCadMinor`, `itcReceivableCadMinor`) may be stored as non-negative magnitudes
 *   or signed negative integers (never mixed signs within one row) and are normalized into
 *   negative `SnapshotRefundAdjustmentRow` values attributed to the reversal's custody/settlement state.
 */
export function buildPersistedLedgerProjection(params: {
  readonly organizationId: string;
  readonly policy: WorkingCapitalPolicySlice;
  readonly saleRows: readonly PersistedSaleLedgerRow[];
  readonly scrapRows: readonly PersistedScrapLedgerRow[];
  readonly transferRows: readonly PersistedCashTransferLedgerRow[];
  readonly settlementRows: readonly PersistedCurrencySettlementRow[];
  readonly expenseRows: readonly PersistedExpenseLedgerRow[];
  readonly vehicleRows?: readonly PersistedDonorVehicleRow[];
  readonly partRows?: readonly PersistedDonorPartRow[];
  readonly salePartItemRows?: readonly PersistedSalePartItemRow[];
}): PersistedLedgerProjection {
  const normalizedOrgId = params.organizationId.toLowerCase();
  const baseSaleRows: PersistedSaleLedgerRow[] = [];
  const reversalRows: PersistedSaleLedgerRow[] = [];

  for (const row of params.saleRows) {
    if (row.organizationId.toLowerCase() !== normalizedOrgId) {
      throw new DomainRuleError(
        'ORGANIZATION_MISMATCH',
        `SaleTransaction "${row.id}" belongs to a different organization.`,
      );
    }
    if (row.reversesSaleTxId) {
      reversalRows.push(row);
    } else {
      baseSaleRows.push(row);
    }
  }

  const baseSaleMap = new Map(
    baseSaleRows.map((row) => [row.id.toLowerCase(), row]),
  );

  const refundAdjustments: SnapshotRefundAdjustmentRow[] = [];
  const reversalsByOriginalSaleId = new Map<string, PersistedSaleLedgerRow[]>();

  for (const rev of reversalRows) {
    const revId = rev.id.toLowerCase();
    const targetId = rev.reversesSaleTxId!.toLowerCase();
    if (revId === targetId) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        `SaleTransaction "${rev.id}" cannot reverse itself.`,
      );
    }
    if (rev.isVoidedOrReversed) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        `Reversal SaleTransaction "${rev.id}" cannot itself be voided or reversed.`,
      );
    }
    const original = baseSaleMap.get(targetId);
    if (!original) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        `Reversal SaleTransaction "${rev.id}" references missing or chained sale "${rev.reversesSaleTxId}".`,
      );
    }
    if (
      rev.marketNode !== original.marketNode ||
      rev.paymentCurrency !== original.paymentCurrency ||
      rev.taxCollectionMode !== original.taxCollectionMode
    ) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        `Reversal SaleTransaction "${rev.id}" mismatches original sale node, currency, or tax collection mode.`,
      );
    }

    const direction: 'NON_NEGATIVE' | 'NON_POSITIVE' =
      rev.subtotalMinor < 0 ||
      rev.grossCollectedMinor < 0 ||
      rev.taxOrVatMinor < 0 ||
      rev.netRealizedCadMinor < 0
        ? 'NON_POSITIVE'
        : 'NON_NEGATIVE';

    const subtotalAdj = normalizeSignedMagnitude(
      rev.subtotalMinor,
      direction,
      `reversal[${rev.id}].subtotalMinor`,
    );
    const taxAdj = normalizeSignedMagnitude(
      rev.taxOrVatMinor,
      direction,
      `reversal[${rev.id}].taxOrVatMinor`,
    );
    const grossAdj = normalizeSignedMagnitude(
      rev.grossCollectedMinor,
      direction,
      `reversal[${rev.id}].grossCollectedMinor`,
    );
    const netAdj = normalizeSignedMagnitude(
      rev.netRealizedCadMinor,
      direction,
      `reversal[${rev.id}].netRealizedCadMinor`,
    );
    const itcAdj = normalizeSignedMagnitude(
      rev.itcReceivableCadMinor,
      direction,
      `reversal[${rev.id}].itcReceivableCadMinor`,
    );

    const refundSettlementAccount: SnapshotRefundAdjustmentRow['refundSettlementAccount'] =
      rev.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' ||
      rev.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED'
        ? 'CORP_BANK'
        : rev.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT' ||
            rev.paymentSettlementState === 'PAYMENT_CONFIRMED'
          ? 'OPERATOR_FLOAT'
          : 'PENDING_EXTERNAL_RECEIVABLE';

    const originalFeeTaxVerified =
      original.isFeeTaxInvoiceVerified === true &&
      typeof original.feeTaxInvoiceStorageKey === 'string' &&
      original.feeTaxInvoiceStorageKey.trim().length > 0;

    refundAdjustments.push({
      id: revId,
      organizationId: normalizedOrgId,
      originalSaleId: targetId,
      taxCollectionMode: rev.taxCollectionMode,
      gstHstAdjustmentCadMinor:
        rev.marketNode === 'DOMESTIC_ORIGIN' &&
        rev.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
          ? taxAdj
          : 0,
      itcAdjustmentCadMinor: itcAdj,
      isFeeTaxInvoiceVerified: originalFeeTaxVerified,
      subtotalAdjustmentMinor: subtotalAdj,
      grossAdjustmentMinor: grossAdj,
      netRealizedCadAdjustmentMinor: netAdj,
      refundSettlementAccount,
      custodyHolderUserId: rev.soldByUserId.toLowerCase(),
    });

    const list = reversalsByOriginalSaleId.get(targetId) ?? [];
    list.push(rev);
    reversalsByOriginalSaleId.set(targetId, list);
  }

  const sales: SnapshotSaleRow[] = baseSaleRows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    marketNode: row.marketNode,
    domesticChannel: row.domesticChannel,
    exportChannel: row.exportChannel,
    paymentCurrency: row.paymentCurrency,
    taxCollectionMode: row.taxCollectionMode,
    subtotalMinor: row.subtotalMinor,
    gstHstTaxCadMinor:
      row.marketNode === 'DOMESTIC_ORIGIN' &&
      row.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
        ? row.taxOrVatMinor
        : 0,
    taxOrVatMinor: row.taxOrVatMinor,
    buyerTaxRemittedByPlatformMinor: row.buyerTaxRemittedByPlatformMinor,
    platformFeeMinor: row.platformFeeMinor,
    shippingCostMinor: row.shippingCostMinor,
    estimatedPlatformFeeTaxCadMinor: row.estimatedPlatformFeeTaxCadMinor,
    itcReceivableCadMinor: row.itcReceivableCadMinor,
    isFeeTaxInvoiceVerified: row.isFeeTaxInvoiceVerified,
    feeTaxInvoiceStorageKey: row.feeTaxInvoiceStorageKey,
    grossCollectedMinor: row.grossCollectedMinor,
    netRealizedCadMinor: row.netRealizedCadMinor,
    paymentSettlementState: row.paymentSettlementState,
    cashCustodyState: row.cashCustodyState,
    bankSettledAt: row.bankSettledAt,
    bankDepositReference: row.bankDepositReference,
    soldByUserId: row.soldByUserId.toLowerCase(),
    isVoidedOrReversed: row.isVoidedOrReversed,
  }));

  const scrapLogs: SnapshotScrapRow[] = params.scrapRows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    vehicleId: row.vehicleId.toLowerCase(),
    payoutCadMinor: row.payoutCadMinor,
    cashCustodyState: row.cashCustodyState,
    custodyHolderUserId: row.recordedByUserId.toLowerCase(),
  }));

  const cashTransfers: SnapshotCashTransferRow[] = params.transferRows.map(
    (row) => ({
      id: row.id.toLowerCase(),
      organizationId: row.organizationId.toLowerCase(),
      marketNode: row.marketNode,
      fromCustodyState: row.fromCustodyState,
      toCustodyState: row.toCustodyState,
      currency: row.currency,
      amountMinor: row.amountMinor,
      equivalentCadMinor: row.equivalentCadMinor,
      depositSlipStorageKey: row.depositSlipStorageKey,
      operatorUserId: (
        row.custodyHolderUserId ?? row.recordedByUserId
      ).toLowerCase(),
    }),
  );

  const repatriationSettlements: SnapshotRepatriationRow[] =
    params.settlementRows.map((row) => {
      if (row.settledInCanadaAt !== null && row.targetCurrency !== 'CAD') {
        throw new DomainRuleError(
          'UNCONVERTED_NON_CAD_AMOUNT',
          `Settled CurrencySettlement "${row.id}" must target CAD, got ${row.targetCurrency}.`,
        );
      }
      return {
        id: row.id.toLowerCase(),
        organizationId: row.organizationId.toLowerCase(),
        targetSettledCadMinor:
          typeof row.totalTargetSettledMinor === 'number'
            ? row.totalTargetSettledMinor
            : bigIntToSafeNumber(
                row.totalTargetSettledMinor,
                `currencySettlement[${row.id}].totalTargetSettledMinor`,
              ),
        cashCustodyState:
          row.settledInCanadaAt !== null
            ? 'SETTLED_ORIGIN_CORP_BANK'
            : 'PENDING_EXTERNAL_RECEIVABLE',
      };
    });

  const expenses: SnapshotExpenseRow[] = params.expenseRows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    category: row.category,
    vehicleId: row.vehicleId ? row.vehicleId.toLowerCase() : null,
    currencyOriginal: row.currencyOriginal,
    amountOriginalMinor: row.amountOriginalMinor,
    amountCadMinor: row.amountCadMinor,
    itcReceivableCadMinor: row.itcReceivableCadMinor,
    paidFromCashCustody: row.paidFromCashCustody,
    custodyHolderUserId: row.custodyHolderUserId
      ? row.custodyHolderUserId.toLowerCase()
      : null,
    recipientUserId: row.recipientUserId
      ? row.recipientUserId.toLowerCase()
      : null,
    floatOffsetAppliedCadMinor: row.floatOffsetAppliedCadMinor ?? 0,
    loggedByUserId: row.loggedByUserId.toLowerCase(),
    isDeferredIntercompanyAccrual: row.isDeferredIntercompanyAccrual,
    accrualSettledAt: row.accrualSettledAt,
    receiptVerificationState: row.receiptVerificationState,
    receiptStorageKey: row.receiptStorageKey,
    isReversalEntry: row.isReversalEntry,
  }));

  // Build donor vehicle summaries when vehicle rows are supplied
  const extraWarnings: string[] = [];
  const donorVehicles: SnapshotDonorVehicleSummaryRow[] = [];

  if (params.vehicleRows && params.vehicleRows.length > 0) {
    const scrapByVehicle = new Map<string, number>();
    for (const s of scrapLogs) {
      scrapByVehicle.set(
        s.vehicleId,
        (scrapByVehicle.get(s.vehicleId) ?? 0) + s.payoutCadMinor,
      );
    }

    const directExpensesByVehicle = new Map<string, number>();
    const expenseById = new Map(
      params.expenseRows.map((e) => [e.id.toLowerCase(), e]),
    );
    const reversedAmountByExpenseId = new Map<string, number>();
    for (const e of params.expenseRows) {
      if (e.isReversalEntry && e.reversesExpenseId) {
        const targetId = e.reversesExpenseId.toLowerCase();
        reversedAmountByExpenseId.set(
          targetId,
          (reversedAmountByExpenseId.get(targetId) ?? 0) + e.amountCadMinor,
        );
      }
    }
    for (const e of params.expenseRows) {
      if (
        e.isReversalEntry ||
        !e.vehicleId ||
        !ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES.has(e.category)
      ) {
        continue;
      }
      const vehId = e.vehicleId.toLowerCase();
      const reversed = reversedAmountByExpenseId.get(e.id.toLowerCase()) ?? 0;
      const net = Math.max(0, e.amountCadMinor - reversed);
      directExpensesByVehicle.set(
        vehId,
        (directExpensesByVehicle.get(vehId) ?? 0) + net,
      );
    }
    void expenseById;

    const activeCadSaleIds = new Set(
      baseSaleRows
        .filter(
          (s) =>
            s.paymentCurrency === 'CAD' &&
            !s.isVoidedOrReversed &&
            s.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK',
        )
        .map((s) => s.id.toLowerCase()),
    );

    const partById = new Map(
      (params.partRows ?? []).map((p) => [p.id.toLowerCase(), p]),
    );
    const activeSoldPartIds = new Set<string>();
    const realizedPartsByVehicle = new Map<string, number>();

    for (const item of params.salePartItemRows ?? []) {
      if (!item.isActiveSale) {
        continue;
      }
      const saleId = item.saleTransactionId.toLowerCase();
      const partId = item.partId.toLowerCase();
      activeSoldPartIds.add(partId);
      if (!activeCadSaleIds.has(saleId)) {
        continue;
      }
      const part = partById.get(partId);
      if (!part) {
        continue;
      }
      const vehId = part.donorVehicleId.toLowerCase();
      realizedPartsByVehicle.set(
        vehId,
        (realizedPartsByVehicle.get(vehId) ?? 0) + item.soldPriceMinor,
      );
    }

    const projectedRemainingByVehicle = new Map<string, number>();
    let hasMissingCompBaseline = false;
    for (const part of params.partRows ?? []) {
      const partId = part.id.toLowerCase();
      const vehId = part.donorVehicleId.toLowerCase();
      const isSoldOrScrapped =
        activeSoldPartIds.has(partId) ||
        part.availabilityState === 'PAID_SETTLED' ||
        part.custodyState === 'SOLD_AND_RELEASED' ||
        part.custodyState === 'SCRAPPED_OR_DAMAGED';
      if (isSoldOrScrapped) {
        continue;
      }
      if (part.compBaselineCadMinor === null) {
        hasMissingCompBaseline = true;
        continue;
      }
      projectedRemainingByVehicle.set(
        vehId,
        (projectedRemainingByVehicle.get(vehId) ?? 0) +
          part.compBaselineCadMinor,
      );
    }
    if (hasMissingCompBaseline) {
      extraWarnings.push('DONOR_MISSING_PART_COMP_BASELINE');
    }

    for (const veh of params.vehicleRows) {
      const vehId = veh.id.toLowerCase();
      const scrapTotal = scrapByVehicle.has(vehId)
        ? scrapByVehicle.get(vehId)!
        : veh.scrapRecoveryCadMinor;
      donorVehicles.push({
        id: vehId,
        organizationId: normalizedOrgId,
        totalAcquisitionAndStripCostCadMinor:
          veh.actualPurchasePriceCadMinor +
          (directExpensesByVehicle.get(vehId) ?? 0),
        scrapRecoveryCadMinor: scrapTotal,
        realizedPartSalesCadMinor: realizedPartsByVehicle.get(vehId) ?? 0,
        projectedRemainingPartsCadMinor:
          projectedRemainingByVehicle.get(vehId) ?? 0,
      });
    }
  }

  const snapshotInput: FinancialSnapshotInput = {
    organizationId: normalizedOrgId,
    tranches: params.policy.operationalGates.workingCapitalGate.tranches.map(
      (t) => ({
        trancheCode: t.trancheCode,
        principalCadMinor: t.principalCadMinor,
        unlocked: t.unlocked,
      }),
    ),
    sales,
    refundAdjustments,
    scrapLogs,
    cashTransfers,
    repatriationSettlements,
    expenses,
    donorVehicles,
    priorPartnerDrawsCadMinor: 0,
  };

  const baseSnapshot = computeSeparatedFinancialSnapshot(
    snapshotInput,
    params.policy,
  );
  const snapshot: SeparatedFinancialSnapshot =
    extraWarnings.length > 0
      ? {
          ...baseSnapshot,
          warnings: [...baseSnapshot.warnings, ...extraWarnings],
        }
      : baseSnapshot;

  const detailedTax = computeDetailedTaxCounters({
    organizationId: normalizedOrgId,
    sales: sales.map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
      taxCollectionMode: s.taxCollectionMode,
      gstHstTaxCadMinor:
        s.gstHstTaxCadMinor ??
        (s.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
          ? s.taxOrVatMinor
          : 0),
      provincialTaxCadMinor: s.provincialTaxCadMinor,
      itcReceivableCadMinor: s.itcReceivableCadMinor,
      estimatedPlatformFeeTaxCadMinor: s.estimatedPlatformFeeTaxCadMinor,
      isFeeTaxInvoiceVerified: s.isFeeTaxInvoiceVerified,
      feeTaxInvoiceStorageKey: s.feeTaxInvoiceStorageKey,
      paymentSettlementState: s.paymentSettlementState,
      isVoidedOrReversed: s.isVoidedOrReversed,
    })),
    expenses: expenses.map((e) => ({
      id: e.id,
      organizationId: e.organizationId,
      itcReceivableCadMinor: e.itcReceivableCadMinor,
      receiptVerificationState: e.receiptVerificationState,
      receiptStorageKey: e.receiptStorageKey,
      isReversalEntry: e.isReversalEntry,
      isVoidedOrReversed: e.isVoidedOrReversed,
    })),
    refundAdjustments,
  });

  // Compute authoritative marketplace buyer tax sum (nullable) & unverified platform fee tax
  let buyerTaxSum: number | null = null;
  let hasUnknownMarketplaceBuyerTax = false;
  let unverifiedPlatformFeeTaxAccruedCadMinor = 0;

  for (const row of baseSaleRows) {
    const saleId = row.id.toLowerCase();
    const rowReversals = reversalsByOriginalSaleId.get(saleId) ?? [];
    const isFullyReversedWithoutAdjustments =
      rowReversals.length === 0 &&
      (row.isVoidedOrReversed === true ||
        row.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK');
    if (isFullyReversedWithoutAdjustments) {
      continue;
    }

    const isMarketplaceFacilitated =
      row.taxCollectionMode === 'MARKETPLACE_FACILITATOR_COLLECTED' ||
      row.domesticChannel === 'EBAY_MOTORS_SHIPPED';

    if (isMarketplaceFacilitated && row.paymentCurrency === 'CAD') {
      if (
        row.buyerTaxRemittedByPlatformMinor !== null &&
        row.buyerTaxRemittedByPlatformMinor !== undefined
      ) {
        let netBuyerTax = row.buyerTaxRemittedByPlatformMinor;
        let reversedAllWithoutValue = false;
        for (const rev of rowReversals) {
          if (
            rev.buyerTaxRemittedByPlatformMinor !== null &&
            rev.buyerTaxRemittedByPlatformMinor !== undefined
          ) {
            netBuyerTax -= Math.abs(rev.buyerTaxRemittedByPlatformMinor);
          } else if (row.isVoidedOrReversed) {
            reversedAllWithoutValue = true;
          }
        }
        const effectiveBuyerTax = reversedAllWithoutValue
          ? 0
          : Math.max(0, netBuyerTax);
        buyerTaxSum = (buyerTaxSum ?? 0) + effectiveBuyerTax;
      } else {
        hasUnknownMarketplaceBuyerTax = true;
      }
    }

    const feeInvoiceVerified =
      row.isFeeTaxInvoiceVerified === true &&
      typeof row.feeTaxInvoiceStorageKey === 'string' &&
      row.feeTaxInvoiceStorageKey.trim().length > 0;

    if (!feeInvoiceVerified && row.estimatedPlatformFeeTaxCadMinor > 0) {
      let netUnverified = row.estimatedPlatformFeeTaxCadMinor;
      for (const rev of rowReversals) {
        netUnverified -= Math.abs(rev.estimatedPlatformFeeTaxCadMinor);
      }
      if (!row.isVoidedOrReversed || rowReversals.length > 0) {
        unverifiedPlatformFeeTaxAccruedCadMinor += Math.max(0, netUnverified);
      }
    }
  }

  // Destination vault physical cash held per currency (fail-closed at 0 when no vault sales exist)
  const destinationVaultCashByCurrency: Record<string, number> = {};
  for (const row of baseSaleRows) {
    if (
      row.marketNode === 'DESTINATION_EXPORT_VAULT' &&
      row.cashCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
      !row.isVoidedOrReversed &&
      row.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK'
    ) {
      const counterDeduction =
        row.isBrokerCommissionDeductedAtCounter === true
          ? (row.brokerCommissionMinor ?? 0)
          : 0;
      const netCounterCash = Math.max(
        0,
        row.grossCollectedMinor - counterDeduction,
      );
      destinationVaultCashByCurrency[row.paymentCurrency] =
        (destinationVaultCashByCurrency[row.paymentCurrency] ?? 0) +
        netCounterCash;
    }
  }
  for (const t of params.transferRows) {
    if (
      t.fromCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
      t.toCustodyState === 'DEPOSITED_DESTINATION_BANK'
    ) {
      destinationVaultCashByCurrency[t.currency] =
        (destinationVaultCashByCurrency[t.currency] ?? 0) - t.amountMinor;
    }
  }

  return {
    snapshotInput,
    snapshot,
    taxCounters: {
      directTaxCollectedNetOfRefundsCadMinor:
        detailedTax.directTaxCollectedNetOfRefundsCadMinor,
      buyerTaxRemittedByPlatformCadMinor: buyerTaxSum,
      hasUnknownMarketplaceBuyerTax,
      unverifiedPlatformFeeTaxAccruedCadMinor,
      verifiedItcReceivableCadMinor: detailedTax.verifiedItcReceivableCadMinor,
      netHstTrustLiabilityCadMinor: detailedTax.netHstTrustLiabilityCadMinor,
    },
    destinationVaultCashByCurrency,
  };
}

/**
 * Reads persisted ledger tables within an active `withTenantTransaction` (`tx`)
 * and delegates all 7-metric liquidity, pending-receivable, float, and CRA HST
 * trust calculations to `computeSeparatedFinancialSnapshot`.
 */
export async function querySeparatedFinancialSnapshot(
  tx: Prisma.TransactionClient,
  organizationId: string,
  policy: WorkingCapitalPolicySlice,
): Promise<SeparatedFinancialSnapshot> {
  const projection = await loadPersistedFinancialSnapshot(
    tx,
    organizationId,
    policy,
  );
  return projection.snapshot;
}

export async function loadPersistedFinancialSnapshot(
  tx: Prisma.TransactionClient,
  organizationId: string,
  policy: WorkingCapitalPolicySlice,
): Promise<PersistedLedgerProjection> {
  const hasDonorTables =
    typeof (tx as unknown as { vehicle?: { findMany?: unknown } }).vehicle
      ?.findMany === 'function' &&
    typeof (tx as unknown as { part?: { findMany?: unknown } }).part
      ?.findMany === 'function' &&
    typeof (
      tx as unknown as { saleTransactionPartItem?: { findMany?: unknown } }
    ).saleTransactionPartItem?.findMany === 'function';

  const [
    saleRows,
    scrapRows,
    transferRows,
    settlementRows,
    expenseRows,
    vehicleRows,
    partRows,
    salePartItemRows,
  ] = await Promise.all([
    tx.saleTransaction.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        marketNode: true,
        domesticChannel: true,
        exportChannel: true,
        paymentCurrency: true,
        taxCollectionMode: true,
        subtotalMinor: true,
        taxOrVatMinor: true,
        buyerTaxRemittedByPlatformMinor: true,
        platformFeeMinor: true,
        shippingCostMinor: true,
        estimatedPlatformFeeTaxCadMinor: true,
        itcReceivableCadMinor: true,
        isFeeTaxInvoiceVerified: true,
        feeTaxInvoiceStorageKey: true,
        grossCollectedMinor: true,
        netRealizedCadMinor: true,
        paymentSettlementState: true,
        cashCustodyState: true,
        bankSettledAt: true,
        bankDepositReference: true,
        soldByUserId: true,
        isVoidedOrReversed: true,
        reversesSaleTxId: true,
        brokerCommissionMinor: true,
        isBrokerCommissionDeductedAtCounter: true,
      },
    }),
    tx.scrapComponentLog.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        vehicleId: true,
        payoutCadMinor: true,
        cashCustodyState: true,
        recordedByUserId: true,
      },
    }),
    tx.cashCustodyTransfer.findMany({
      where: { organizationId },
      orderBy: [{ transferredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        marketNode: true,
        fromCustodyState: true,
        toCustodyState: true,
        currency: true,
        amountMinor: true,
        equivalentCadMinor: true,
        depositSlipStorageKey: true,
        recordedByUserId: true,
        custodyHolderUserId: true,
      },
    }),
    tx.currencySettlement.findMany({
      where: { organizationId },
      orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        targetCurrency: true,
        totalTargetSettledMinor: true,
        settledInCanadaAt: true,
      },
    }),
    tx.expense.findMany({
      where: { organizationId },
      orderBy: [{ incurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        category: true,
        vehicleId: true,
        currencyOriginal: true,
        amountOriginalMinor: true,
        amountCadMinor: true,
        itcReceivableCadMinor: true,
        paidFromCashCustody: true,
        loggedByUserId: true,
        recipientUserId: true,
        floatOffsetAppliedCadMinor: true,
        custodyHolderUserId: true,
        isDeferredIntercompanyAccrual: true,
        accrualSettledAt: true,
        receiptVerificationState: true,
        receiptStorageKey: true,
        isReversalEntry: true,
        reversesExpenseId: true,
      },
    }),
    hasDonorTables
      ? tx.vehicle.findMany({
          where: { organizationId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            organizationId: true,
            actualPurchasePriceCadMinor: true,
            scrapRecoveryCadMinor: true,
          },
        })
      : Promise.resolve([]),
    hasDonorTables
      ? tx.part.findMany({
          where: { organizationId },
          orderBy: [{ strippedAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            donorVehicleId: true,
            compBaselineCadMinor: true,
            availabilityState: true,
            custodyState: true,
          },
        })
      : Promise.resolve([]),
    hasDonorTables
      ? tx.saleTransactionPartItem.findMany({
          where: { organizationId, isActiveSale: true },
          select: {
            saleTransactionId: true,
            partId: true,
            soldPriceMinor: true,
            isActiveSale: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return buildPersistedLedgerProjection({
    organizationId,
    policy,
    saleRows,
    scrapRows,
    transferRows,
    settlementRows,
    expenseRows,
    vehicleRows,
    partRows,
    salePartItemRows,
  });
}
