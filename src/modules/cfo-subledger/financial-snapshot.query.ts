import type { Prisma } from '@prisma/client';
import {
  bigIntToSafeNumber,
  computeSeparatedFinancialSnapshot,
  DomainRuleError,
  type FinancialSnapshotInput,
  type SeparatedFinancialSnapshot,
  type SnapshotCashTransferRow,
  type SnapshotExpenseRow,
  type SnapshotRepatriationRow,
  type SnapshotSaleRow,
  type SnapshotScrapRow,
  type WorkingCapitalPolicySlice,
} from '@/core/domain';

export interface PersistedLedgerProjection {
  readonly snapshotInput: FinancialSnapshotInput;
  readonly snapshot: SeparatedFinancialSnapshot;
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
  const [saleRows, scrapRows, transferRows, settlementRows, expenseRows] =
    await Promise.all([
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
          isDeferredIntercompanyAccrual: true,
          accrualSettledAt: true,
          receiptVerificationState: true,
          receiptStorageKey: true,
          isReversalEntry: true,
        },
      }),
    ]);

  const sales: SnapshotSaleRow[] = saleRows.map((row) => ({
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

  const scrapLogs: SnapshotScrapRow[] = scrapRows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    vehicleId: row.vehicleId.toLowerCase(),
    payoutCadMinor: row.payoutCadMinor,
    cashCustodyState: row.cashCustodyState,
    custodyHolderUserId: row.recordedByUserId.toLowerCase(),
  }));

  const cashTransfers: SnapshotCashTransferRow[] = transferRows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    marketNode: row.marketNode,
    fromCustodyState: row.fromCustodyState,
    toCustodyState: row.toCustodyState,
    currency: row.currency,
    amountMinor: row.amountMinor,
    equivalentCadMinor: row.equivalentCadMinor,
    depositSlipStorageKey: row.depositSlipStorageKey,
    operatorUserId: row.recordedByUserId.toLowerCase(),
  }));

  const repatriationSettlements: SnapshotRepatriationRow[] = settlementRows.map(
    (row) => {
      if (row.settledInCanadaAt !== null && row.targetCurrency !== 'CAD') {
        throw new DomainRuleError(
          'UNCONVERTED_NON_CAD_AMOUNT',
          `Settled CurrencySettlement "${row.id}" must target CAD, got ${row.targetCurrency}.`,
        );
      }
      return {
        id: row.id.toLowerCase(),
        organizationId: row.organizationId.toLowerCase(),
        targetSettledCadMinor: bigIntToSafeNumber(
          row.totalTargetSettledMinor,
          `currencySettlement[${row.id}].totalTargetSettledMinor`,
        ),
        cashCustodyState:
          row.settledInCanadaAt !== null
            ? 'SETTLED_ORIGIN_CORP_BANK'
            : 'PENDING_EXTERNAL_RECEIVABLE',
      };
    },
  );

  const expenses: SnapshotExpenseRow[] = expenseRows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    category: row.category,
    vehicleId: row.vehicleId ? row.vehicleId.toLowerCase() : null,
    currencyOriginal: row.currencyOriginal,
    amountOriginalMinor: row.amountOriginalMinor,
    amountCadMinor: row.amountCadMinor,
    itcReceivableCadMinor: row.itcReceivableCadMinor,
    paidFromCashCustody: row.paidFromCashCustody,
    loggedByUserId: row.loggedByUserId.toLowerCase(),
    isDeferredIntercompanyAccrual: row.isDeferredIntercompanyAccrual,
    accrualSettledAt: row.accrualSettledAt,
    receiptVerificationState: row.receiptVerificationState,
    receiptStorageKey: row.receiptStorageKey,
    isReversalEntry: row.isReversalEntry,
  }));

  const snapshotInput: FinancialSnapshotInput = {
    organizationId: organizationId.toLowerCase(),
    tranches: policy.operationalGates.workingCapitalGate.tranches.map((t) => ({
      trancheCode: t.trancheCode,
      principalCadMinor: t.principalCadMinor,
      unlocked: t.unlocked,
    })),
    sales,
    scrapLogs,
    cashTransfers,
    repatriationSettlements,
    expenses,
    priorPartnerDrawsCadMinor: 0,
  };

  const snapshot = computeSeparatedFinancialSnapshot(snapshotInput, policy);
  return { snapshotInput, snapshot };
}
