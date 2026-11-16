import type {
  AssetCategory,
  CashCustodyState,
  CurrencyCode,
  DomesticSaleChannel,
  ExpenseCategory,
  ExportSaleChannel,
  OperationalLane,
  PartCustodyState,
  InventoryAvailabilityState,
  PaymentSettlementState,
  ReceiptVerificationState,
  SaleMarketNode,
  TaxCollectionMode,
  UserRole,
} from '@prisma/client';
import type { PricingAndCompliancePolicy } from '../ports';
import {
  type ActorContext,
  type DomainRuleErrorCode,
  type GateDecision,
  type TrustedCfoApprovalInput,
  DomainRuleError,
  assertNonEmptyTrimmedString,
  assertNonNegativeSafeInt,
  assertPositiveSafeInt,
  assertSafeInt,
  bigIntToSafeNumber,
  checkedSub,
  evaluateCfoOverride,
  isNonEmptyTrimmedString,
} from './domain-primitives';

export type WorkingCapitalPolicySlice = Pick<
  PricingAndCompliancePolicy,
  'operationalGates' | 'compensationRules'
>;

export interface TaxSaleLedgerRow {
  readonly id: string;
  readonly organizationId: string;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly gstHstTaxCadMinor: number;
  readonly provincialTaxCadMinor?: number;
  readonly itcReceivableCadMinor: number;
  readonly estimatedPlatformFeeTaxCadMinor?: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly feeTaxInvoiceStorageKey?: string | null;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly isVoidedOrReversed?: boolean;
}

export interface TaxExpenseLedgerRow {
  readonly id: string;
  readonly organizationId: string;
  readonly itcReceivableCadMinor: number;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey?: string | null;
  readonly isReversalEntry?: boolean;
  readonly isVoidedOrReversed?: boolean;
}

export interface TaxRefundAdjustmentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly originalSaleId: string;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly gstHstAdjustmentCadMinor: number;
  readonly provincialTaxAdjustmentCadMinor?: number;
  readonly itcAdjustmentCadMinor: number;
  readonly isFeeTaxInvoiceVerified?: boolean;
}

export interface NetHstTrustLiabilityInput {
  readonly organizationId: string;
  readonly sales: readonly TaxSaleLedgerRow[];
  readonly expenses?: readonly TaxExpenseLedgerRow[];
  readonly refundAdjustments?: readonly TaxRefundAdjustmentRow[];
}

export interface DetailedTaxCounters {
  readonly directTaxCollectedNetOfRefundsCadMinor: number;
  readonly verifiedItcReceivableCadMinor: number;
  readonly netHstTrustLiabilityCadMinor: number;
}

export interface LoanTrancheStatusRow {
  readonly trancheCode: string;
  readonly principalCadMinor: number;
  readonly unlocked: boolean;
}

export interface SnapshotSaleRow {
  readonly id: string;
  readonly organizationId: string;
  readonly marketNode: SaleMarketNode;
  readonly domesticChannel?: DomesticSaleChannel | null;
  readonly exportChannel?: ExportSaleChannel | null;
  readonly paymentCurrency: CurrencyCode;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly subtotalMinor: number;
  readonly gstHstTaxCadMinor?: number;
  readonly provincialTaxCadMinor?: number;
  readonly taxOrVatMinor: number;
  readonly buyerTaxRemittedByPlatformMinor?: number | null;
  readonly platformFeeMinor: number;
  readonly shippingCostMinor: number;
  readonly shippingDeductedFromPayout?: boolean;
  readonly estimatedPlatformFeeTaxCadMinor?: number;
  readonly itcReceivableCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly feeTaxInvoiceStorageKey?: string | null;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly bankClearedCadMinor?: number | null;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
  readonly bankSettledAt?: string | Date | null;
  readonly bankDepositReference?: string | null;
  readonly soldByUserId?: string | null;
  readonly custodyHolderUserId?: string | null;
  readonly isVoidedOrReversed?: boolean;
}

export interface SnapshotRefundAdjustmentRow extends TaxRefundAdjustmentRow {
  readonly subtotalAdjustmentMinor: number;
  readonly grossAdjustmentMinor: number;
  readonly netRealizedCadAdjustmentMinor?: number;
  readonly refundSettlementAccount?:
    | 'CORP_BANK'
    | 'OPERATOR_FLOAT'
    | 'PENDING_EXTERNAL_RECEIVABLE';
  readonly custodyHolderUserId?: string | null;
}

export interface SnapshotScrapRow {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string;
  readonly payoutCadMinor: number;
  readonly cashCustodyState: CashCustodyState;
  readonly custodyHolderUserId?: string | null;
}

export interface SnapshotCashTransferRow {
  readonly id: string;
  readonly organizationId: string;
  readonly marketNode: SaleMarketNode;
  readonly fromCustodyState: CashCustodyState;
  readonly toCustodyState: CashCustodyState;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor: number;
  readonly depositSlipStorageKey: string;
  readonly operatorUserId?: string | null;
  readonly sourceSaleIds?: readonly string[];
  readonly sourceScrapIds?: readonly string[];
}

export interface SnapshotRepatriationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly targetSettledCadMinor: number;
  readonly cashCustodyState: CashCustodyState;
}

export interface SnapshotExpenseRow {
  readonly id: string;
  readonly organizationId: string;
  readonly category: ExpenseCategory;
  readonly vehicleId?: string | null;
  readonly linkedSaleId?: string | null;
  readonly currencyOriginal: CurrencyCode;
  readonly amountOriginalMinor?: number;
  readonly amountCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody?: CashCustodyState | null;
  readonly custodyHolderUserId?: string | null;
  readonly recipientUserId?: string | null;
  readonly floatOffsetAppliedCadMinor?: number;
  readonly loggedByUserId?: string | null;
  readonly isDeferredIntercompanyAccrual: boolean;
  readonly accrualSettledAt?: string | Date | null;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey?: string | null;
  readonly isWithheldOrNettedInSalePayout?: boolean;
  readonly isReversalEntry?: boolean;
  readonly isVoidedOrReversed?: boolean;
}

export interface SnapshotDonorVehicleSummaryRow {
  readonly id: string;
  readonly organizationId: string;
  readonly totalAcquisitionAndStripCostCadMinor: number;
  readonly scrapRecoveryCadMinor: number;
  readonly realizedPartSalesCadMinor: number;
  readonly projectedRemainingPartsCadMinor: number;
}

export interface FinancialSnapshotInput {
  readonly organizationId: string;
  readonly tranches?: readonly LoanTrancheStatusRow[];
  readonly sales: readonly SnapshotSaleRow[];
  readonly refundAdjustments?: readonly SnapshotRefundAdjustmentRow[];
  readonly scrapLogs?: readonly SnapshotScrapRow[];
  readonly cashTransfers?: readonly SnapshotCashTransferRow[];
  readonly repatriationSettlements?: readonly SnapshotRepatriationRow[];
  readonly expenses?: readonly SnapshotExpenseRow[];
  readonly donorVehicles?: readonly SnapshotDonorVehicleSummaryRow[];
  readonly priorPartnerDrawsCadMinor?: number;
}

export interface SeparatedFinancialSnapshot {
  readonly organizationId: string;
  readonly activeReleasedTrancheCapitalCadMinor: number;
  readonly accountingRevenueCadMinor: number;
  readonly grossSaleValueCadMinor: number;
  readonly pendingExternalReceivablesCadMinor: number;
  readonly runningOperatorFloatCadMinor: number;
  readonly operatorFloatByUserId: Readonly<Record<string, number>>;
  readonly confirmedCorpBankCashCadMinor: number;
  readonly netHstTrustLiabilityCadMinor: number;
  readonly estimatedDonorProfitCadMinor: number;
  readonly availableWorkingCapitalCadMinor: number;
  readonly distributableRealizedProfitPoolCadMinor: number;
  readonly accruedUnpaidExpensesCadMinor: number;
  readonly warnings: readonly string[];
}

export interface TrancheMilestoneMetrics {
  readonly shelvedSkusCount: number;
  readonly scrappedDonorsCount: number;
  readonly overdueFloatReceiptsCount: number;
}

export interface TrancheEligibilityStatus {
  readonly trancheCode: string;
  readonly principalCadMinor: number;
  readonly unlocked: boolean;
  readonly milestoneMet: boolean;
  readonly shelvedSkusRemaining: number;
  readonly scrappedDonorsRemaining: number;
  readonly overdueFloatReceiptsBlocking: boolean;
}

export interface TrancheEligibilityResult {
  readonly committedFacilityCadMinor: number;
  readonly activeReleasedTrancheCapitalCadMinor: number;
  readonly eligibleUnreleasedTrancheCapitalCadMinor: number;
  readonly tranches: readonly TrancheEligibilityStatus[];
}

export interface WorkingCapitalGateInput {
  readonly organizationId: string;
  readonly availableWorkingCapitalCadMinor: number;
  readonly estimatedDealOutlayCadMinor: number;
  readonly operationalLane: OperationalLane;
  readonly assetCategory: AssetCategory;
  readonly actor?: ActorContext;
  readonly cfoOverride?: TrustedCfoApprovalInput;
}

export interface WorkingCapitalGateDecision
  extends GateDecision<DomainRuleErrorCode> {
  readonly projectedPostDealCapitalCadMinor: number;
  readonly minCashReserveFloorCadMinor: number;
  readonly maxDonorDismantleLandedCadMinor: number;
}

export interface PieceRatePartCandidate {
  readonly id: string;
  readonly organizationId: string;
  readonly donorVehicleId: string | null;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly barcode: string | null;
  readonly binLocationCode: string | null;
  readonly rawPhotoUrls: readonly string[];
}

export interface PieceRatePayoutInput {
  readonly organizationId: string;
  readonly vehicleId: string;
  readonly fluidsDrainedAt: string | Date | null;
  readonly parts: readonly PieceRatePartCandidate[];
}

export interface PieceRatePayoutResult {
  readonly eligible: boolean;
  readonly qualifyingShelvedPartsCount: number;
  readonly requiredShelvedPartsCount: number;
  readonly authorizedPayoutCadMinor: number;
  readonly blockingCodes: readonly DomainRuleErrorCode[];
}

export interface PartnerProfitDrawInput {
  readonly organizationId: string;
  readonly targetUserId: string;
  readonly targetUserRole: UserRole;
  readonly requestedDrawCadMinor: number;
  readonly snapshotInput?: FinancialSnapshotInput;
  readonly snapshot?: SeparatedFinancialSnapshot;
  readonly targetOperatorFloatOverrideCadMinor?: number;
  readonly actor?: ActorContext;
  readonly cfoOverride?: TrustedCfoApprovalInput;
}

export interface PartnerProfitDrawResult
  extends GateDecision<DomainRuleErrorCode> {
  readonly requestedDrawCadMinor: number;
  readonly distributableRealizedProfitPoolCadMinor: number;
  readonly availableWorkingCapitalCadMinor: number;
  readonly minCashReserveFloorCadMinor: number;
  readonly maxBankDisbursementAllowedCadMinor: number;
  readonly targetOperatorFloatCadMinor: number;
  readonly floatOffsetAppliedCadMinor: number;
  readonly netCashDisbursedFromBankCadMinor: number;
}

function assertOrgAndUniqueIds<
  T extends { readonly id: string; readonly organizationId: string },
>(
  rows: readonly T[],
  expectedOrgId: string,
  entityLabel: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const id = assertNonEmptyTrimmedString(
      row.id,
      'INVALID_INPUT',
      `${entityLabel}.id is required.`,
    );
    if (row.organizationId !== expectedOrgId) {
      throw new DomainRuleError(
        'ORGANIZATION_MISMATCH',
        `${entityLabel} "${id}" belongs to organization "${row.organizationId}", expected "${expectedOrgId}".`,
        { entityLabel, id, organizationId: row.organizationId, expectedOrgId },
      );
    }
    if (map.has(id)) {
      throw new DomainRuleError(
        'DUPLICATE_ENTITY_ID',
        `Duplicate ${entityLabel} id "${id}".`,
        { entityLabel, id },
      );
    }
    map.set(id, row);
  }
  return map;
}

function isVerifiedFeeTaxInvoice(sale: {
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly feeTaxInvoiceStorageKey?: string | null;
}): boolean {
  return (
    sale.isFeeTaxInvoiceVerified === true &&
    isNonEmptyTrimmedString(sale.feeTaxInvoiceStorageKey)
  );
}

function isVerifiedExpenseReceipt(expense: {
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey?: string | null;
}): boolean {
  return (
    expense.receiptVerificationState === 'VERIFIED_RECEIPT' &&
    isNonEmptyTrimmedString(expense.receiptStorageKey)
  );
}

function groupAdjustmentsBySaleId<
  T extends {
    readonly id: string;
    readonly organizationId: string;
    readonly originalSaleId: string;
  },
>(
  adjustments: readonly T[],
  expectedOrgId: string,
): Map<string, T[]> {
  assertOrgAndUniqueIds(adjustments, expectedOrgId, 'refundAdjustment');
  const grouped = new Map<string, T[]>();
  for (const adj of adjustments) {
    const existing = grouped.get(adj.originalSaleId) ?? [];
    existing.push(adj);
    grouped.set(adj.originalSaleId, existing);
  }
  return grouped;
}

function resolveDirectGstHstForSale(sale: TaxSaleLedgerRow): number {
  if (sale.taxCollectionMode !== 'DIRECT_SELLER_COLLECTED') {
    return 0;
  }
  return assertNonNegativeSafeInt(sale.gstHstTaxCadMinor, 'gstHstTaxCadMinor');
}

export function computeDetailedTaxCounters(
  input: NetHstTrustLiabilityInput,
): DetailedTaxCounters {
  const organizationId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const saleMap = assertOrgAndUniqueIds(input.sales, organizationId, 'sale');
  const expenses = input.expenses ?? [];
  assertOrgAndUniqueIds(expenses, organizationId, 'expense');
  const adjustmentsBySale = groupAdjustmentsBySaleId(
    input.refundAdjustments ?? [],
    organizationId,
  );

  let directTaxCollected = 0n;
  let verifiedItcTotal = 0n;

  for (const sale of input.sales) {
    if (sale.provincialTaxCadMinor !== undefined) {
      assertNonNegativeSafeInt(
        sale.provincialTaxCadMinor,
        `sale[${sale.id}].provincialTaxCadMinor`,
      );
    }

    const baseDirectGstHst = resolveDirectGstHstForSale(sale);
    const baseVerifiedItc = isVerifiedFeeTaxInvoice(sale)
      ? assertNonNegativeSafeInt(
          sale.itcReceivableCadMinor,
          `sale[${sale.id}].itcReceivableCadMinor`,
        )
      : 0;

    const saleAdjustments = adjustmentsBySale.get(sale.id) ?? [];
    if (saleAdjustments.length > 0) {
      let adjGstHstSum = 0n;
      let adjItcSum = 0n;
      for (const adj of saleAdjustments) {
        if (adj.provincialTaxAdjustmentCadMinor !== undefined) {
          const provAdj = assertSafeInt(
            adj.provincialTaxAdjustmentCadMinor,
            `adj[${adj.id}].provincialTaxAdjustmentCadMinor`,
          );
          if (provAdj > 0) {
            throw new DomainRuleError(
              'INVALID_INPUT',
              'provincialTaxAdjustmentCadMinor cannot be positive.',
            );
          }
        }
        const gstAdj = assertSafeInt(
          adj.gstHstAdjustmentCadMinor,
          `adj[${adj.id}].gstHstAdjustmentCadMinor`,
        );
        if (gstAdj > 0) {
          throw new DomainRuleError(
            'INVALID_INPUT',
            'gstHstAdjustmentCadMinor cannot be positive.',
          );
        }
        if (
          adj.taxCollectionMode === 'DIRECT_SELLER_COLLECTED' &&
          sale.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
        ) {
          adjGstHstSum += BigInt(gstAdj);
        }

        const itcAdj = assertSafeInt(
          adj.itcAdjustmentCadMinor,
          `adj[${adj.id}].itcAdjustmentCadMinor`,
        );
        if (itcAdj > 0) {
          throw new DomainRuleError(
            'INVALID_INPUT',
            'itcAdjustmentCadMinor cannot be positive.',
          );
        }
        if (isVerifiedFeeTaxInvoice(sale)) {
          adjItcSum += BigInt(itcAdj);
        }
      }

      const netSaleGstHst = BigInt(baseDirectGstHst) + adjGstHstSum;
      const netSaleItc = BigInt(baseVerifiedItc) + adjItcSum;
      directTaxCollected += netSaleGstHst > 0n ? netSaleGstHst : 0n;
      verifiedItcTotal += netSaleItc > 0n ? netSaleItc : 0n;
      continue;
    }

    const isFullyReversedWithoutAdjustments =
      sale.isVoidedOrReversed === true ||
      sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK';

    if (!isFullyReversedWithoutAdjustments) {
      directTaxCollected += BigInt(baseDirectGstHst);
      verifiedItcTotal += BigInt(baseVerifiedItc);
    }
  }

  for (const [originalSaleId, adjs] of adjustmentsBySale.entries()) {
    if (saleMap.has(originalSaleId)) {
      continue;
    }
    for (const adj of adjs) {
      const gstAdj = assertSafeInt(
        adj.gstHstAdjustmentCadMinor,
        `adj[${adj.id}].gstHstAdjustmentCadMinor`,
      );
      if (gstAdj > 0) {
        throw new DomainRuleError(
          'INVALID_INPUT',
          'gstHstAdjustmentCadMinor cannot be positive.',
        );
      }
      if (adj.taxCollectionMode === 'DIRECT_SELLER_COLLECTED') {
        directTaxCollected += BigInt(gstAdj);
      }
      const itcAdj = assertSafeInt(
        adj.itcAdjustmentCadMinor,
        `adj[${adj.id}].itcAdjustmentCadMinor`,
      );
      if (itcAdj > 0) {
        throw new DomainRuleError(
          'INVALID_INPUT',
          'itcAdjustmentCadMinor cannot be positive.',
        );
      }
      if (adj.isFeeTaxInvoiceVerified === true) {
        verifiedItcTotal += BigInt(itcAdj);
      }
    }
  }

  for (const exp of expenses) {
    if (exp.isVoidedOrReversed === true) {
      continue;
    }
    if (!isVerifiedExpenseReceipt(exp)) {
      continue;
    }
    const expItc = assertNonNegativeSafeInt(
      exp.itcReceivableCadMinor,
      `expense[${exp.id}].itcReceivableCadMinor`,
    );
    verifiedItcTotal += BigInt(exp.isReversalEntry ? -expItc : expItc);
  }

  const directClamped =
    directTaxCollected > 0n
      ? bigIntToSafeNumber(
          directTaxCollected,
          'directTaxCollectedNetOfRefundsCadMinor',
        )
      : 0;
  const itcClamped =
    verifiedItcTotal > 0n
      ? bigIntToSafeNumber(verifiedItcTotal, 'verifiedItcReceivableCadMinor')
      : 0;
  const netLiability =
    directTaxCollected <= 0n || directTaxCollected <= verifiedItcTotal
      ? 0
      : bigIntToSafeNumber(
          directTaxCollected - verifiedItcTotal,
          'netHstTrustLiabilityCadMinor',
        );

  return {
    directTaxCollectedNetOfRefundsCadMinor: directClamped,
    verifiedItcReceivableCadMinor: itcClamped,
    netHstTrustLiabilityCadMinor: netLiability,
  };
}

/**
 * Pure CRA GST/HST trust liability calculator (`RULE-TAX-HST-01` / `FIX 06`).
 *
 * Strictly ring-fences:
 * - Direct seller-collected CRA GST/HST (`DIRECT_SELLER_COLLECTED`), excluding standalone
 *   provincial QST/PST (`provincialTaxCadMinor`) and marketplace-remitted buyer taxes.
 * - Verified seller-fee tax ITCs (`isFeeTaxInvoiceVerified === true` + non-empty storage key)
 *   and `VERIFIED_RECEIPT` expense ITCs, ignoring unverified estimates even if populated.
 * - Normalizes `refundAdjustments` against `REFUNDED_OR_CHARGED_BACK` sales without double-deducting.
 * - Clamps at `0` so excess ITC claims never fabricate spendable bank working capital.
 */
export function computeNetHstTrustLiabilityCadMinor(
  input: NetHstTrustLiabilityInput,
): number {
  return computeDetailedTaxCounters(input).netHstTrustLiabilityCadMinor;
}

function addUserFloatDelta(
  bucket: Map<string, bigint>,
  userId: string | null | undefined,
  delta: bigint,
): void {
  if (!isNonEmptyTrimmedString(userId) || delta === 0n) {
    return;
  }
  const key = userId.trim();
  bucket.set(key, (bucket.get(key) ?? 0n) + delta);
}

/**
 * Computes all 7 separated financial & liquidity metrics for an organization (`FIX 05` & `FIX 06`).
 *
 * Strictly invariant against unsafe liquidity flags (`countPendingExportCashAsAvailable`,
 * `countPendingDomesticReceivablesAsAvailable`, `countOperatorFloatInBankWorkingCapital`).
 */
export function computeSeparatedFinancialSnapshot(
  input: FinancialSnapshotInput,
  policy: WorkingCapitalPolicySlice,
): SeparatedFinancialSnapshot {
  const organizationId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );

  const saleMap = assertOrgAndUniqueIds(input.sales, organizationId, 'sale');
  const scrapLogs = input.scrapLogs ?? [];
  assertOrgAndUniqueIds(scrapLogs, organizationId, 'scrapLog');
  const cashTransfers = input.cashTransfers ?? [];
  assertOrgAndUniqueIds(cashTransfers, organizationId, 'cashTransfer');
  const repatriations = input.repatriationSettlements ?? [];
  assertOrgAndUniqueIds(repatriations, organizationId, 'repatriation');
  const expenses = input.expenses ?? [];
  assertOrgAndUniqueIds(expenses, organizationId, 'expense');
  const donorVehicles = input.donorVehicles ?? [];
  assertOrgAndUniqueIds(donorVehicles, organizationId, 'donorVehicle');

  const adjustmentsBySale = groupAdjustmentsBySaleId(
    input.refundAdjustments ?? [],
    organizationId,
  );

  const warnings: string[] = [];
  if (
    policy.operationalGates.workingCapitalGate
      .countPendingExportCashAsAvailable ||
    policy.operationalGates.workingCapitalGate
      .countPendingDomesticReceivablesAsAvailable ||
    policy.operationalGates.workingCapitalGate
      .countOperatorFloatInBankWorkingCapital
  ) {
    warnings.push('IGNORED_UNSAFE_LIQUIDITY_FLAG');
  }

  // Only unlocked tranches enter activeReleasedTrancheCapitalCadMinor.
  const trancheSource =
    input.tranches ?? policy.operationalGates.workingCapitalGate.tranches;
  let releasedTrancheBigInt = 0n;
  const seenTrancheCodes = new Set<string>();
  for (const tranche of trancheSource) {
    const code = assertNonEmptyTrimmedString(
      tranche.trancheCode,
      'INVALID_INPUT',
      'trancheCode is required.',
    );
    if (seenTrancheCodes.has(code)) {
      throw new DomainRuleError(
        'DUPLICATE_ENTITY_ID',
        `Duplicate trancheCode "${code}".`,
      );
    }
    seenTrancheCodes.add(code);
    const principal = assertNonNegativeSafeInt(
      tranche.principalCadMinor,
      `tranche[${code}].principalCadMinor`,
    );
    if (tranche.unlocked === true) {
      releasedTrancheBigInt += BigInt(principal);
    }
  }

  // Validate sweep transfers upfront and detect duplicate sourceSaleIds / sourceScrapIds
  const sweptSaleIds = new Set<string>();
  const sweptScrapIds = new Set<string>();
  let sweepToBankCad = 0n;
  let sweepOutOfFloatCad = 0n;
  const userFloatMap = new Map<string, bigint>();

  for (const transfer of cashTransfers) {
    if (!isNonEmptyTrimmedString(transfer.depositSlipStorageKey)) {
      throw new DomainRuleError(
        'INVALID_DEPOSIT_SLIP_KEY',
        `CashCustodyTransfer "${transfer.id}" requires a non-empty depositSlipStorageKey.`,
      );
    }
    const equivCad = assertPositiveSafeInt(
      transfer.equivalentCadMinor,
      `cashTransfer[${transfer.id}].equivalentCadMinor`,
    );
    if (
      transfer.currency !== 'CAD' &&
      transfer.fromCustodyState === 'HELD_IN_OPERATOR_FLOAT'
    ) {
      throw new DomainRuleError(
        'UNCONVERTED_NON_CAD_AMOUNT',
        `Domestic operator float CashCustodyTransfer "${transfer.id}" must be CAD.`,
      );
    }

    for (const srcSaleId of transfer.sourceSaleIds ?? []) {
      const normalized = assertNonEmptyTrimmedString(
        srcSaleId,
        'INVALID_INPUT',
        'sourceSaleIds entry must be non-empty.',
      );
      if (sweptSaleIds.has(normalized)) {
        throw new DomainRuleError(
          'DUPLICATE_SWEEP_SOURCE_CREDIT',
          `Duplicate sweep sourceSaleId "${normalized}" in transfer "${transfer.id}".`,
        );
      }
      sweptSaleIds.add(normalized);
    }

    for (const srcScrapId of transfer.sourceScrapIds ?? []) {
      const normalized = assertNonEmptyTrimmedString(
        srcScrapId,
        'INVALID_INPUT',
        'sourceScrapIds entry must be non-empty.',
      );
      if (sweptScrapIds.has(normalized)) {
        throw new DomainRuleError(
          'DUPLICATE_SWEEP_SOURCE_CREDIT',
          `Duplicate sweep sourceScrapId "${normalized}" in transfer "${transfer.id}".`,
        );
      }
      sweptScrapIds.add(normalized);
    }

    if (
      transfer.fromCustodyState === 'HELD_IN_OPERATOR_FLOAT' &&
      transfer.toCustodyState === 'SETTLED_ORIGIN_CORP_BANK'
    ) {
      sweepToBankCad += BigInt(equivCad);
      sweepOutOfFloatCad += BigInt(equivCad);
      addUserFloatDelta(userFloatMap, transfer.operatorUserId, -BigInt(equivCad));
    }
  }

  let accountingRevenue = 0n;
  let grossSaleValue = 0n;
  let pendingExternalReceivables = 0n;
  let operatorFloat = -sweepOutOfFloatCad;
  let confirmedCorpBankCash = releasedTrancheBigInt + sweepToBankCad;
  let realizedSaleProfitContribution = 0n;

  for (const sale of input.sales) {
    const subtotal = assertNonNegativeSafeInt(
      sale.subtotalMinor,
      `sale[${sale.id}].subtotalMinor`,
    );
    const taxOrVat = assertNonNegativeSafeInt(
      sale.taxOrVatMinor,
      `sale[${sale.id}].taxOrVatMinor`,
    );
    const grossCollected = assertNonNegativeSafeInt(
      sale.grossCollectedMinor,
      `sale[${sale.id}].grossCollectedMinor`,
    );
    const netRealizedCad = assertSafeInt(
      sale.netRealizedCadMinor,
      `sale[${sale.id}].netRealizedCadMinor`,
    );
    const platformFee = assertNonNegativeSafeInt(
      sale.platformFeeMinor,
      `sale[${sale.id}].platformFeeMinor`,
    );
    const shippingCost = assertNonNegativeSafeInt(
      sale.shippingCostMinor,
      `sale[${sale.id}].shippingCostMinor`,
    );

    const isCadCashPoolSale =
      sale.marketNode === 'DOMESTIC_ORIGIN' ||
      sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' ||
      sale.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT';
    if (isCadCashPoolSale && sale.paymentCurrency !== 'CAD') {
      throw new DomainRuleError(
        'UNCONVERTED_NON_CAD_AMOUNT',
        `Sale "${sale.id}" in domestic/CAD cash pool has non-CAD paymentCurrency "${sale.paymentCurrency}".`,
      );
    }

    const saleAdjustments = adjustmentsBySale.get(sale.id) ?? [];
    const hasExplicitAdjustments = saleAdjustments.length > 0;
    const isFullImplicitReversal =
      !hasExplicitAdjustments &&
      (sale.isVoidedOrReversed === true ||
        sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK');

    if (isFullImplicitReversal) {
      // If a swept cash sale is reversed without explicit refundAdjustments, the original sale's cash moved via CashCustodyTransfer;
      // restore float credit (+grossCollected before sweep) and charge bank (-grossCollected) so net float=0 and net bank=0.
      if (
        sweptSaleIds.has(sale.id) &&
        sale.paymentCurrency === 'CAD'
      ) {
        operatorFloat += BigInt(grossCollected);
        addUserFloatDelta(
          userFloatMap,
          sale.custodyHolderUserId ?? sale.soldByUserId,
          BigInt(grossCollected),
        );
        confirmedCorpBankCash -= BigInt(grossCollected);
      }
      continue;
    }

    let adjSubtotal = 0n;
    let adjGross = 0n;
    let adjNetRealized = 0n;
    let adjBankRefund = 0n;
    let adjFloatRefund = 0n;
    let adjPendingRefund = 0n;
    const floatHolderId = sale.custodyHolderUserId ?? sale.soldByUserId;

    for (const adj of saleAdjustments) {
      const sAdj = assertSafeInt(
        adj.subtotalAdjustmentMinor,
        `adj[${adj.id}].subtotalAdjustmentMinor`,
      );
      const gAdj = assertSafeInt(
        adj.grossAdjustmentMinor,
        `adj[${adj.id}].grossAdjustmentMinor`,
      );
      if (sAdj > 0 || gAdj > 0) {
        throw new DomainRuleError(
          'INVALID_INPUT',
          `Refund adjustment "${adj.id}" cannot have positive subtotal/gross amounts.`,
        );
      }
      adjSubtotal += BigInt(sAdj);
      adjGross += BigInt(gAdj);
      const nAdj =
        adj.netRealizedCadAdjustmentMinor !== undefined
          ? assertSafeInt(
              adj.netRealizedCadAdjustmentMinor,
              `adj[${adj.id}].netRealizedCadAdjustmentMinor`,
            )
          : sAdj;
      adjNetRealized += BigInt(nAdj);

      const resolvedRefundSource =
        adj.refundSettlementAccount ??
        (sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' ||
        sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' ||
        sweptSaleIds.has(sale.id)
          ? 'CORP_BANK'
          : sale.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT'
            ? 'OPERATOR_FLOAT'
            : 'PENDING_EXTERNAL_RECEIVABLE');

      if (resolvedRefundSource === 'CORP_BANK') {
        adjBankRefund += BigInt(gAdj);
      } else if (resolvedRefundSource === 'OPERATOR_FLOAT') {
        adjFloatRefund += BigInt(gAdj);
        addUserFloatDelta(
          userFloatMap,
          adj.custodyHolderUserId ?? floatHolderId,
          BigInt(gAdj),
        );
      } else {
        adjPendingRefund += BigInt(nAdj);
      }
    }

    if (BigInt(subtotal) + adjSubtotal < 0n || BigInt(grossCollected) + adjGross < 0n) {
      throw new DomainRuleError(
        'REFUND_EXCEEDS_ORIGINAL_SALE',
        `Cumulative refund adjustments exceed original sale "${sale.id}".`,
      );
    }

    const activeSubtotal = BigInt(subtotal) + adjSubtotal;
    const activeGrossForValue = BigInt(grossCollected) + adjGross;
    if (sale.paymentCurrency === 'CAD') {
      accountingRevenue += activeSubtotal;
      grossSaleValue += activeGrossForValue > 0n ? activeGrossForValue : 0n;
    }

    const wasSweptFromFloat =
      sale.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT' ||
      sweptSaleIds.has(sale.id);

    if (
      sale.paymentSettlementState === 'MARKETPLACE_PAYOUT_PENDING' ||
      sale.paymentSettlementState === 'BANK_SETTLEMENT_PENDING' ||
      sale.cashCustodyState === 'PENDING_EXTERNAL_RECEIVABLE'
    ) {
      // Pending domestic receivables follow FIX 05: net eBay payout or gross direct e-Transfer receivable
      if (sale.paymentCurrency === 'CAD') {
        const baseReceivable =
          sale.domesticChannel === 'EBAY_MOTORS_SHIPPED'
            ? BigInt(netRealizedCad)
            : BigInt(grossCollected);
        const netPending = baseReceivable + adjPendingRefund;
        pendingExternalReceivables += netPending > 0n ? netPending : 0n;
      }
    } else if (
      wasSweptFromFloat &&
      sale.paymentSettlementState !== 'BANK_SETTLEMENT_CONFIRMED'
    ) {
      // Cash was originally held in operator float (and if refunded post-sweep, adjBankRefund already debits bank while orig grossCollected + adjFloatRefund balances sweep)
      operatorFloat += BigInt(grossCollected) + adjFloatRefund;
      addUserFloatDelta(userFloatMap, floatHolderId, BigInt(grossCollected));
      confirmedCorpBankCash += adjBankRefund;
      realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
    } else if (
      (sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' ||
        (hasExplicitAdjustments &&
          sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK')) &&
      sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'
    ) {
      const bankCleared =
        sale.bankClearedCadMinor !== undefined && sale.bankClearedCadMinor !== null
          ? BigInt(
              assertNonNegativeSafeInt(
                sale.bankClearedCadMinor,
                `sale[${sale.id}].bankClearedCadMinor`,
              ),
            )
          : BigInt(grossCollected) -
            BigInt(platformFee) -
            (sale.shippingDeductedFromPayout === true ? BigInt(shippingCost) : 0n);

      confirmedCorpBankCash += bankCleared + adjBankRefund;
      operatorFloat += adjFloatRefund;
      realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
    }
  }

  let scrapTotalCad = 0n;
  for (const scrap of scrapLogs) {
    const payout = assertNonNegativeSafeInt(
      scrap.payoutCadMinor,
      `scrap[${scrap.id}].payoutCadMinor`,
    );
    scrapTotalCad += BigInt(payout);
    if (scrap.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK') {
      confirmedCorpBankCash += BigInt(payout);
    } else if (scrap.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT') {
      operatorFloat += BigInt(payout);
      addUserFloatDelta(
        userFloatMap,
        scrap.custodyHolderUserId,
        BigInt(payout),
      );
    }
  }

  for (const rep of repatriations) {
    const settled = assertNonNegativeSafeInt(
      rep.targetSettledCadMinor,
      `repatriation[${rep.id}].targetSettledCadMinor`,
    );
    if (rep.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK') {
      confirmedCorpBankCash += BigInt(settled);
      realizedSaleProfitContribution += BigInt(settled);
    }
  }

  let allNonVoidedExpensesForProfit = 0n;
  let accruedUnpaidExpenses = 0n;
  for (const exp of expenses) {
    if (exp.isVoidedOrReversed === true) {
      continue;
    }
    const amt = assertNonNegativeSafeInt(
      exp.amountCadMinor,
      `expense[${exp.id}].amountCadMinor`,
    );
    const floatOffset = assertNonNegativeSafeInt(
      exp.floatOffsetAppliedCadMinor ?? 0,
      `expense[${exp.id}].floatOffsetAppliedCadMinor`,
    );
    if (floatOffset > amt) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        `Expense "${exp.id}" floatOffsetAppliedCadMinor (${floatOffset}) exceeds amountCadMinor (${amt}).`,
      );
    }
    if (floatOffset > 0 && exp.category !== 'PARTNER_PROFIT_DRAW') {
      throw new DomainRuleError(
        'INVALID_INPUT',
        `Non-draw expense "${exp.id}" cannot carry floatOffsetAppliedCadMinor.`,
      );
    }
    if (exp.category === 'PARTNER_TIME_LOG_MEMO') {
      if (
        amt !== 0 ||
        (exp.amountOriginalMinor ?? 0) !== 0 ||
        exp.itcReceivableCadMinor !== 0 ||
        exp.isDeferredIntercompanyAccrual
      ) {
        throw new DomainRuleError(
          'INVALID_INPUT',
          `PARTNER_TIME_LOG_MEMO "${exp.id}" must carry zero financial amounts and zero deferral.`,
        );
      }
      continue;
    }
    if (exp.currencyOriginal !== 'CAD' && amt === 0 && (exp.amountOriginalMinor ?? 0) > 0) {
      throw new DomainRuleError(
        'UNCONVERTED_NON_CAD_AMOUNT',
        `Foreign currency expense "${exp.id}" is missing converted amountCadMinor.`,
      );
    }

    const signedAmt = BigInt(exp.isReversalEntry ? -amt : amt);
    allNonVoidedExpensesForProfit += signedAmt;

    const isUnsettledDeferredAccrual =
      exp.isDeferredIntercompanyAccrual === true && exp.accrualSettledAt == null;

    if (isUnsettledDeferredAccrual) {
      accruedUnpaidExpenses += signedAmt;
      continue;
    }

    if (exp.isWithheldOrNettedInSalePayout === true) {
      // Already netted out of SaleTransaction.bankClearedCadMinor; do not deduct again from bank.
      continue;
    }

    if (exp.category === 'PARTNER_PROFIT_DRAW' && floatOffset > 0) {
      const signedFloatOffset = BigInt(
        exp.isReversalEntry ? -floatOffset : floatOffset,
      );
      const signedBankRemainder = signedAmt - signedFloatOffset;
      operatorFloat -= signedFloatOffset;
      addUserFloatDelta(
        userFloatMap,
        exp.custodyHolderUserId ?? exp.recipientUserId ?? exp.loggedByUserId,
        -signedFloatOffset,
      );
      if (signedBankRemainder !== 0n) {
        confirmedCorpBankCash -= signedBankRemainder;
      }
    } else if (exp.paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT') {
      operatorFloat -= signedAmt;
      addUserFloatDelta(
        userFloatMap,
        exp.custodyHolderUserId ?? exp.recipientUserId ?? exp.loggedByUserId,
        -signedAmt,
      );
    } else {
      confirmedCorpBankCash -= signedAmt;
    }
  }

  const priorDrawsExtra = assertNonNegativeSafeInt(
    input.priorPartnerDrawsCadMinor ?? 0,
    'priorPartnerDrawsCadMinor',
  );
  if (priorDrawsExtra > 0) {
    allNonVoidedExpensesForProfit += BigInt(priorDrawsExtra);
    confirmedCorpBankCash -= BigInt(priorDrawsExtra);
  }

  let estimatedDonorProfit = 0n;
  for (const veh of donorVehicles) {
    const cost = assertNonNegativeSafeInt(
      veh.totalAcquisitionAndStripCostCadMinor,
      `donorVehicle[${veh.id}].totalAcquisitionAndStripCostCadMinor`,
    );
    const scrap = assertNonNegativeSafeInt(
      veh.scrapRecoveryCadMinor,
      `donorVehicle[${veh.id}].scrapRecoveryCadMinor`,
    );
    const realizedParts = assertNonNegativeSafeInt(
      veh.realizedPartSalesCadMinor,
      `donorVehicle[${veh.id}].realizedPartSalesCadMinor`,
    );
    const projectedParts = assertNonNegativeSafeInt(
      veh.projectedRemainingPartsCadMinor,
      `donorVehicle[${veh.id}].projectedRemainingPartsCadMinor`,
    );
    estimatedDonorProfit +=
      BigInt(realizedParts) + BigInt(projectedParts) + BigInt(scrap) - BigInt(cost);
  }

  const netHstTrustLiabilityCadMinor = computeNetHstTrustLiabilityCadMinor({
    organizationId,
    sales: input.sales.map((s) => ({
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
    refundAdjustments: input.refundAdjustments,
  });

  const confirmedBankNumber = bigIntToSafeNumber(
    confirmedCorpBankCash,
    'confirmedCorpBankCashCadMinor',
  );
  const availableWorkingCapitalCadMinor = checkedSub(
    confirmedBankNumber,
    netHstTrustLiabilityCadMinor,
    'availableWorkingCapitalCadMinor',
  );

  const profitPoolRaw =
    realizedSaleProfitContribution +
    scrapTotalCad -
    allNonVoidedExpensesForProfit -
    BigInt(netHstTrustLiabilityCadMinor);
  const distributableRealizedProfitPoolCadMinor =
    profitPoolRaw > 0n
      ? bigIntToSafeNumber(
          profitPoolRaw,
          'distributableRealizedProfitPoolCadMinor',
        )
      : 0;

  const operatorFloatRecord: Record<string, number> = {};
  for (const [uid, balance] of userFloatMap.entries()) {
    operatorFloatRecord[uid] = bigIntToSafeNumber(
      balance,
      `operatorFloatByUserId[${uid}]`,
    );
  }

  return {
    organizationId,
    activeReleasedTrancheCapitalCadMinor: bigIntToSafeNumber(
      releasedTrancheBigInt,
      'activeReleasedTrancheCapitalCadMinor',
    ),
    accountingRevenueCadMinor: bigIntToSafeNumber(
      accountingRevenue,
      'accountingRevenueCadMinor',
    ),
    grossSaleValueCadMinor: bigIntToSafeNumber(
      grossSaleValue,
      'grossSaleValueCadMinor',
    ),
    pendingExternalReceivablesCadMinor: bigIntToSafeNumber(
      pendingExternalReceivables,
      'pendingExternalReceivablesCadMinor',
    ),
    runningOperatorFloatCadMinor: bigIntToSafeNumber(
      operatorFloat,
      'runningOperatorFloatCadMinor',
    ),
    operatorFloatByUserId: operatorFloatRecord,
    confirmedCorpBankCashCadMinor: confirmedBankNumber,
    netHstTrustLiabilityCadMinor,
    estimatedDonorProfitCadMinor: bigIntToSafeNumber(
      estimatedDonorProfit,
      'estimatedDonorProfitCadMinor',
    ),
    availableWorkingCapitalCadMinor,
    distributableRealizedProfitPoolCadMinor,
    accruedUnpaidExpensesCadMinor: bigIntToSafeNumber(
      accruedUnpaidExpenses,
      'accruedUnpaidExpensesCadMinor',
    ),
    warnings,
  };
}

/**
 * Evaluates milestone eligibility for all configured loan tranches without
 * counting `unlocked === false` tranches as active released working capital.
 */
export function evaluateTrancheMilestoneEligibility(
  policy: WorkingCapitalPolicySlice,
  metrics: TrancheMilestoneMetrics,
): TrancheEligibilityResult {
  const shelvedSkus = assertNonNegativeSafeInt(
    metrics.shelvedSkusCount,
    'shelvedSkusCount',
  );
  const scrappedDonors = assertNonNegativeSafeInt(
    metrics.scrappedDonorsCount,
    'scrappedDonorsCount',
  );
  const overdueReceipts = assertNonNegativeSafeInt(
    metrics.overdueFloatReceiptsCount,
    'overdueFloatReceiptsCount',
  );

  let activeReleased = 0n;
  let eligibleUnreleased = 0n;
  const statuses: TrancheEligibilityStatus[] = [];

  for (const tranche of policy.operationalGates.workingCapitalGate.tranches) {
    const principal = assertNonNegativeSafeInt(
      tranche.principalCadMinor,
      `tranche[${tranche.trancheCode}].principalCadMinor`,
    );
    const minSkus = tranche.minShelvedSkus ?? 0;
    const minDonors = tranche.minScrappedDonors ?? 0;
    const requireZeroOverdue = tranche.requireZeroOverdueFloatReceipts ?? false;

    const skusRemaining = Math.max(0, minSkus - shelvedSkus);
    const donorsRemaining = Math.max(0, minDonors - scrappedDonors);
    const overdueBlocking = requireZeroOverdue && overdueReceipts > 0;
    const milestoneMet =
      tranche.unlocked ||
      (skusRemaining === 0 && donorsRemaining === 0 && !overdueBlocking);

    if (tranche.unlocked) {
      activeReleased += BigInt(principal);
    } else if (milestoneMet) {
      eligibleUnreleased += BigInt(principal);
    }

    statuses.push({
      trancheCode: tranche.trancheCode,
      principalCadMinor: principal,
      unlocked: tranche.unlocked,
      milestoneMet,
      shelvedSkusRemaining: skusRemaining,
      scrappedDonorsRemaining: donorsRemaining,
      overdueFloatReceiptsBlocking: overdueBlocking,
    });
  }

  return {
    committedFacilityCadMinor: assertNonNegativeSafeInt(
      policy.operationalGates.workingCapitalGate
        .totalCommittedLoanFacilityCadMinor,
      'totalCommittedLoanFacilityCadMinor',
    ),
    activeReleasedTrancheCapitalCadMinor: bigIntToSafeNumber(
      activeReleased,
      'activeReleasedTrancheCapitalCadMinor',
    ),
    eligibleUnreleasedTrancheCapitalCadMinor: bigIntToSafeNumber(
      eligibleUnreleased,
      'eligibleUnreleasedTrancheCapitalCadMinor',
    ),
    tranches: statuses,
  };
}

/**
 * Evaluates the 3 working-capital & deal-discipline gates (`$7,500` reserve floor,
 * `$3,200` dismantle donor cap, Year-1 `HIGH_END_REBUILD` pause) with 1-Tap `cfoOverride`.
 */
export function evaluateWorkingCapitalGate(
  input: WorkingCapitalGateInput,
  policy: WorkingCapitalPolicySlice,
): WorkingCapitalGateDecision {
  assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const availableCapital = assertSafeInt(
    input.availableWorkingCapitalCadMinor,
    'availableWorkingCapitalCadMinor',
  );
  const outlay = assertNonNegativeSafeInt(
    input.estimatedDealOutlayCadMinor,
    'estimatedDealOutlayCadMinor',
  );

  const wcGate = policy.operationalGates.workingCapitalGate;
  const dealGate = policy.operationalGates.dealDisciplineGate;
  const reserveFloor = assertNonNegativeSafeInt(
    wcGate.minCashReserveFloorCadMinor,
    'minCashReserveFloorCadMinor',
  );
  const maxDonorCap = assertNonNegativeSafeInt(
    dealGate.maxDonorDismantleLandedCadMinor,
    'maxDonorDismantleLandedCadMinor',
  );

  const projectedPostDeal = checkedSub(
    availableCapital,
    outlay,
    'projectedPostDealCapitalCadMinor',
  );

  const blockingCodes: DomainRuleErrorCode[] = [];
  const warnings: string[] = [];

  if (wcGate.enabled && wcGate.enforcementMode !== 'DISABLED') {
    if (projectedPostDeal < reserveFloor) {
      if (wcGate.enforcementMode === 'WARN_ONLY') {
        warnings.push('WORKING_CAPITAL_RESERVE_BREACHED');
      } else {
        blockingCodes.push('WORKING_CAPITAL_RESERVE_BREACHED');
      }
    }
  } else {
    warnings.push('WORKING_CAPITAL_GATE_DISABLED');
  }

  if (
    input.operationalLane === 'DISMANTLE_AND_EXPORT' &&
    outlay > maxDonorCap
  ) {
    blockingCodes.push('DONOR_LANDED_CAP_EXCEEDED');
  }

  if (
    input.operationalLane === 'HIGH_END_REBUILD' &&
    !dealGate.enableHighEndRebuildLane
  ) {
    blockingCodes.push('HIGH_END_REBUILD_LANE_PAUSED');
  }

  const overrideEval = evaluateCfoOverride(input.actor, input.cfoOverride);
  if (overrideEval.requested && !overrideEval.valid) {
    blockingCodes.push(overrideEval.failureCode ?? 'CFO_OVERRIDE_UNAUTHORIZED');
    return {
      allowed: false,
      blockingCodes,
      warnings,
      overrideApplied: false,
      cfoOverrideAudit: overrideEval.audit,
      projectedPostDealCapitalCadMinor: projectedPostDeal,
      minCashReserveFloorCadMinor: reserveFloor,
      maxDonorDismantleLandedCadMinor: maxDonorCap,
    };
  }

  if (blockingCodes.length > 0 && overrideEval.valid) {
    warnings.push(...blockingCodes);
    return {
      allowed: true,
      blockingCodes: [],
      warnings,
      overrideApplied: true,
      cfoOverrideAudit: overrideEval.audit,
      projectedPostDealCapitalCadMinor: projectedPostDeal,
      minCashReserveFloorCadMinor: reserveFloor,
      maxDonorDismantleLandedCadMinor: maxDonorCap,
    };
  }

  return {
    allowed: blockingCodes.length === 0,
    blockingCodes,
    warnings,
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
    projectedPostDealCapitalCadMinor: projectedPostDeal,
    minCashReserveFloorCadMinor: reserveFloor,
    maxDonorDismantleLandedCadMinor: maxDonorCap,
  };
}

/**
 * Pure `RULE-PAY-001` evaluator: authorizes yard-stripper piece-rate payout
 * only when `fluidsDrainedAt !== null` and at least `minShelvedPartsForStripPayout`
 * valid shelved parts (matching donor vehicle, non-blank barcode & bin, >= 1 photo) exist.
 */
export function evaluatePieceRatePayout(
  input: PieceRatePayoutInput,
  policy: WorkingCapitalPolicySlice,
): PieceRatePayoutResult {
  const organizationId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const vehicleId = assertNonEmptyTrimmedString(
    input.vehicleId,
    'INVALID_INPUT',
    'vehicleId is required.',
  );
  assertOrgAndUniqueIds(input.parts, organizationId, 'part');

  let qualifyingCount = 0;
  for (const part of input.parts) {
    if (
      part.donorVehicleId === vehicleId &&
      part.custodyState === 'SHELVED_ORIGIN_CONTAINER' &&
      part.availabilityState !== 'RETURNED_QC_HOLD' &&
      isNonEmptyTrimmedString(part.barcode) &&
      isNonEmptyTrimmedString(part.binLocationCode) &&
      part.rawPhotoUrls.length >= 1 &&
      part.rawPhotoUrls.every((url) => isNonEmptyTrimmedString(url))
    ) {
      qualifyingCount += 1;
    }
  }

  const requiredCount = assertNonNegativeSafeInt(
    policy.compensationRules.minShelvedPartsForStripPayout,
    'minShelvedPartsForStripPayout',
  );
  const pieceRate = assertNonNegativeSafeInt(
    policy.compensationRules.stripperPieceRatePerVehicleCadMinor,
    'stripperPieceRatePerVehicleCadMinor',
  );

  const drained = input.fluidsDrainedAt !== null && input.fluidsDrainedAt !== undefined;
  const eligible = drained && qualifyingCount >= requiredCount;

  return {
    eligible,
    qualifyingShelvedPartsCount: qualifyingCount,
    requiredShelvedPartsCount: requiredCount,
    authorizedPayoutCadMinor: eligible ? pieceRate : 0,
    blockingCodes: eligible ? [] : ['PIECE_RATE_GATE_UNMET'],
  };
}

/**
 * Pure `RULE-PAY-002` & `RULE-PAY-003` evaluator for `PARTNER_PROFIT_DRAW`:
 * - Ring-fences loan tranches, pending receivables, accrued expenses, and `NetHstTrustLiability_CAD`.
 * - Offsets `HUNTER_MECHANIC` draws strictly against that operator's own float first.
 * - Caps bank disbursement by `max(0, AvailableWorkingCapital_CAD - minCashReserveFloorCadMinor)`.
 * - Narrow reserve-floor exception: an authenticated `ARCHITECT_CFO` (`input.actor`) with a
 *   non-blank `cfoOverride.reasonNote` may waive ONLY the `minCashReserveFloorCadMinor` reserve
 *   gate. Profit-pool sufficiency (`distributableRealizedProfitPoolCadMinor`), hard liquidity
 *   (`max(0, availableWorkingCapitalCadMinor)` protecting `NetHstTrustLiability_CAD`), and
 *   caller-supplied role/ID forgery checks remain strictly non-overridable.
 */
export function evaluatePartnerProfitDraw(
  input: PartnerProfitDrawInput,
  policy: WorkingCapitalPolicySlice,
): PartnerProfitDrawResult {
  const organizationId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const targetUserId = assertNonEmptyTrimmedString(
    input.targetUserId,
    'INVALID_INPUT',
    'targetUserId is required.',
  );
  const requestedDrawCadMinor = assertPositiveSafeInt(
    input.requestedDrawCadMinor,
    'requestedDrawCadMinor',
  );

  const snapshot =
    input.snapshot ??
    (input.snapshotInput
      ? computeSeparatedFinancialSnapshot(input.snapshotInput, policy)
      : (() => {
          throw new DomainRuleError(
            'INVALID_INPUT',
            'Either snapshot or snapshotInput is required for evaluatePartnerProfitDraw.',
          );
        })());

  if (snapshot.organizationId !== organizationId) {
    throw new DomainRuleError(
      'ORGANIZATION_MISMATCH',
      `Snapshot organization "${snapshot.organizationId}" does not match "${organizationId}".`,
    );
  }

  const reserveFloor = assertNonNegativeSafeInt(
    policy.operationalGates.workingCapitalGate.minCashReserveFloorCadMinor,
    'minCashReserveFloorCadMinor',
  );
  const profitPool = snapshot.distributableRealizedProfitPoolCadMinor;
  const maxBankDisbursementAllowedCadMinor = Math.max(
    0,
    checkedSub(
      snapshot.availableWorkingCapitalCadMinor,
      reserveFloor,
      'maxBankDisbursementAllowedCadMinor',
    ),
  );
  const hardBankWorkingCapitalCapCadMinor = Math.max(
    0,
    snapshot.availableWorkingCapitalCadMinor,
  );

  const rawTargetFloat =
    input.targetOperatorFloatOverrideCadMinor !== undefined
      ? assertNonNegativeSafeInt(
          input.targetOperatorFloatOverrideCadMinor,
          'targetOperatorFloatOverrideCadMinor',
        )
      : Math.max(0, snapshot.operatorFloatByUserId[targetUserId] ?? 0);

  const shouldOffsetFloat =
    input.targetUserRole === 'HUNTER_MECHANIC' &&
    policy.compensationRules.autoOffsetHunterDrawAgainstFloat;

  const floatOffsetAppliedCadMinor = shouldOffsetFloat
    ? Math.min(requestedDrawCadMinor, rawTargetFloat)
    : 0;
  const netCashDisbursedFromBankCadMinor = checkedSub(
    requestedDrawCadMinor,
    floatOffsetAppliedCadMinor,
    'netCashDisbursedFromBankCadMinor',
  );

  const blockingCodes: DomainRuleErrorCode[] = [];
  const warnings: string[] = [];

  const profitPoolInsufficient = requestedDrawCadMinor > profitPool;
  const exceedsHardWorkingCapital =
    netCashDisbursedFromBankCadMinor > hardBankWorkingCapitalCapCadMinor;
  const breachesReserveFloorOnly =
    !exceedsHardWorkingCapital &&
    netCashDisbursedFromBankCadMinor > maxBankDisbursementAllowedCadMinor;

  if (profitPoolInsufficient) {
    blockingCodes.push('INSUFFICIENT_REALIZED_PROFIT_POOL');
  }
  if (exceedsHardWorkingCapital) {
    blockingCodes.push('INSUFFICIENT_LIQUID_RESERVE_CAPACITY');
  }

  const overrideEval = evaluateCfoOverride(input.actor, input.cfoOverride);
  const actorIsAuthenticatedCfo =
    input.actor?.actorRole === 'ARCHITECT_CFO' &&
    isNonEmptyTrimmedString(input.actor.actorUserId);
  const trustedCfoOverrideValid =
    overrideEval.requested &&
    overrideEval.valid &&
    actorIsAuthenticatedCfo &&
    overrideEval.audit.approvedById === input.actor!.actorUserId.trim();

  if (overrideEval.requested && !trustedCfoOverrideValid) {
    const failureCode =
      overrideEval.failureCode ?? 'CFO_OVERRIDE_UNAUTHORIZED';
    if (!blockingCodes.includes(failureCode)) {
      blockingCodes.push(failureCode);
    }
  }

  let overrideApplied = false;
  let cfoOverrideAudit = {
    overrideApplied: false,
    approvedById: null as string | null,
    reasonNote: null as string | null,
  };

  if (breachesReserveFloorOnly) {
    if (trustedCfoOverrideValid && !profitPoolInsufficient) {
      overrideApplied = true;
      cfoOverrideAudit = overrideEval.audit;
      warnings.push('WORKING_CAPITAL_RESERVE_BREACHED');
    } else {
      blockingCodes.push('INSUFFICIENT_LIQUID_RESERVE_CAPACITY');
    }
  }

  if (
    overrideEval.requested &&
    (profitPoolInsufficient || exceedsHardWorkingCapital)
  ) {
    warnings.push('CFO_OVERRIDE_IGNORED_FOR_SOLVENCY_INVARIANT');
  }

  return {
    allowed: blockingCodes.length === 0,
    blockingCodes,
    warnings,
    overrideApplied,
    cfoOverrideAudit,
    requestedDrawCadMinor,
    distributableRealizedProfitPoolCadMinor: profitPool,
    availableWorkingCapitalCadMinor: snapshot.availableWorkingCapitalCadMinor,
    minCashReserveFloorCadMinor: reserveFloor,
    maxBankDisbursementAllowedCadMinor,
    targetOperatorFloatCadMinor: rawTargetFloat,
    floatOffsetAppliedCadMinor,
    netCashDisbursedFromBankCadMinor,
  };
}
