import { describe, expect, it } from 'vitest';
import {
  computeNetHstTrustLiabilityCadMinor,
  computeSeparatedFinancialSnapshot,
  evaluatePartnerProfitDraw,
  evaluatePieceRatePayout,
  evaluateTrancheMilestoneEligibility,
  evaluateWorkingCapitalGate,
  type FinancialSnapshotInput,
  type NetHstTrustLiabilityInput,
  type WorkingCapitalPolicySlice,
} from '../working-capital-and-compensation';
import { DomainRuleError } from '../domain-primitives';

const ORG_SALVAGE = 'org-salvage-001';
const ORG_OTHER = 'org-cannabis-002';

function makePolicy(
  overrides: Partial<{
    workingCapitalGate: Partial<
      WorkingCapitalPolicySlice['operationalGates']['workingCapitalGate']
    >;
    dealDisciplineGate: Partial<
      WorkingCapitalPolicySlice['operationalGates']['dealDisciplineGate']
    >;
    compensationRules: Partial<WorkingCapitalPolicySlice['compensationRules']>;
  }> = {},
): WorkingCapitalPolicySlice {
  return {
    operationalGates: {
      complianceEnforcementMode: 'WARN_ONLY',
      workingCapitalGate: {
        enabled: true,
        enforcementMode: 'HARD_BLOCK',
        totalCommittedLoanFacilityCadMinor: 4_400_000,
        initialSeedCapitalCadMinor: 2_200_000,
        minCashReserveFloorCadMinor: 750_000,
        countPendingExportCashAsAvailable: false,
        countPendingDomesticReceivablesAsAvailable: false,
        countOperatorFloatInBankWorkingCapital: false,
        tranches: [
          {
            trancheCode: 'TRANCHE_1_LAUNCH',
            principalCadMinor: 2_200_000,
            unlocked: true,
            minShelvedSkus: 0,
            minScrappedDonors: 0,
            requireZeroOverdueFloatReceipts: false,
          },
          {
            trancheCode: 'TRANCHE_2_DAY_60',
            principalCadMinor: 1_200_000,
            unlocked: false,
            minShelvedSkus: 120,
            minScrappedDonors: 3,
            requireZeroOverdueFloatReceipts: false,
          },
          {
            trancheCode: 'TRANCHE_3_DAY_120',
            principalCadMinor: 1_000_000,
            unlocked: false,
            minShelvedSkus: 400,
            minScrappedDonors: 8,
            requireZeroOverdueFloatReceipts: true,
          },
        ],
        ...overrides.workingCapitalGate,
      },
      dealDisciplineGate: {
        maxDonorDismantleLandedCadMinor: 320_000,
        enableHighEndRebuildLane: false,
        ...overrides.dealDisciplineGate,
      },
      locationCapacityGate: {
        enforcementMode: 'HARD_BLOCK',
      },
    },
    compensationRules: {
      stripperPieceRatePerVehicleCadMinor: 35_000,
      minShelvedPartsForStripPayout: 35,
      allowFounderDrawFromSeedCapital: false,
      autoOffsetHunterDrawAgainstFloat: true,
      ...overrides.compensationRules,
    },
  };
}

function makeBaseSnapshotInput(
  overrides: Partial<FinancialSnapshotInput> = {},
): FinancialSnapshotInput {
  return {
    organizationId: ORG_SALVAGE,
    tranches: [
      {
        trancheCode: 'TRANCHE_1_LAUNCH',
        principalCadMinor: 2_200_000,
        unlocked: true,
      },
      {
        trancheCode: 'TRANCHE_2_DAY_60',
        principalCadMinor: 1_200_000,
        unlocked: false,
      },
      {
        trancheCode: 'TRANCHE_3_DAY_120',
        principalCadMinor: 1_000_000,
        unlocked: false,
      },
    ],
    sales: [],
    refundAdjustments: [],
    scrapLogs: [],
    cashTransfers: [],
    repatriationSettlements: [],
    expenses: [],
    donorVehicles: [],
    ...overrides,
  };
}

describe('Separated 7-Metric Liquidity & Working Capital Snapshot (FIX 05 & FIX 06)', () => {
  it('separates accounting revenue, gross sale value, pending receivables, operator float, bank cash, donor profit, and deployable capital across multi-stage cashflow', () => {
    const policy = makePolicy();

    // Stage 1: Launch tranche only -> $22,000 bank, $22,000 deployable, $0 revenue/profit
    const stage1 = computeSeparatedFinancialSnapshot(
      makeBaseSnapshotInput(),
      policy,
    );
    expect(stage1).toMatchObject({
      activeReleasedTrancheCapitalCadMinor: 2_200_000,
      accountingRevenueCadMinor: 0,
      grossSaleValueCadMinor: 0,
      pendingExternalReceivablesCadMinor: 0,
      runningOperatorFloatCadMinor: 0,
      confirmedCorpBankCashCadMinor: 2_200_000,
      netHstTrustLiabilityCadMinor: 0,
      estimatedDonorProfitCadMinor: 0,
      availableWorkingCapitalCadMinor: 2_200_000,
    });

    // Stage 2: Pending eBay sale ($500 subtotal, $66.25 fee, $18.00 label, $65 platform tax unreported/non-ON)
    // + Pending Interac e-Transfer ($300 subtotal + $39 direct ON HST, $339 receivable)
    // + Counted walk-in physical cash ($200 subtotal + $26 direct ON HST = $226 in operator float)
    // + Donor vehicle projected margin (+$2,800 projected profit — MUST NOT touch bank or revenue!)
    const stage2 = computeSeparatedFinancialSnapshot(
      makeBaseSnapshotInput({
        sales: [
          {
            id: 'sale-ebay-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'EBAY_MOTORS_SHIPPED',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
            subtotalMinor: 50_000,
            gstHstTaxCadMinor: 0,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 0,
            buyerTaxRemittedByPlatformMinor: 6_500,
            platformFeeMinor: 6_625,
            shippingCostMinor: 1_800,
            estimatedPlatformFeeTaxCadMinor: 861,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            feeTaxInvoiceStorageKey: null,
            grossCollectedMinor: 50_000,
            netRealizedCadMinor: 41_575,
            paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING',
            cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
            isVoidedOrReversed: false,
          },
          {
            id: 'sale-etransfer-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'FB_MARKETPLACE_LOCAL',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalMinor: 30_000,
            gstHstTaxCadMinor: 3_900,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 3_900,
            platformFeeMinor: 0,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 33_900,
            netRealizedCadMinor: 30_000,
            paymentSettlementState: 'BANK_SETTLEMENT_PENDING',
            cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
            isVoidedOrReversed: false,
          },
          {
            id: 'sale-cash-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'LOCAL_WALK_IN_CASH',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalMinor: 20_000,
            gstHstTaxCadMinor: 2_600,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 2_600,
            platformFeeMinor: 0,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 22_600,
            netRealizedCadMinor: 20_000,
            paymentSettlementState: 'PAYMENT_CONFIRMED',
            cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
            soldByUserId: 'hunter-1',
            custodyHolderUserId: 'hunter-1',
            isVoidedOrReversed: false,
          },
        ],
        donorVehicles: [
          {
            id: 'veh-1',
            organizationId: ORG_SALVAGE,
            totalAcquisitionAndStripCostCadMinor: 280_000,
            scrapRecoveryCadMinor: 60_000,
            realizedPartSalesCadMinor: 50_000,
            projectedRemainingPartsCadMinor: 450_000,
          },
        ],
      }),
      policy,
    );

    // Accounting revenue = 50,000 + 30,000 + 20,000 = 100,000
    // Gross sale value = 50,000 (excl buyerTaxRemittedByPlatformMinor) + 33,900 + 22,600 = 106,500
    // Pending receivables = eBay net 41,575 + e-Transfer (30,000 + 3,900 = 33,900) = 75,475
    // Operator float = 22,600 (cash sale incl collected physical HST)
    // Confirmed corp bank cash STILL equals tranche launch 2,200,000!
    // Direct HST trust liability = 3,900 + 2,600 = 6,500 (unverified eBay 861 ignored)
    // Deployable working capital = 2,200,000 - 6,500 = 2,193,500
    // Donor profit = 50,000 + 450,000 + 60,000 - 280,000 = 280,000 (separate metric!)
    expect(stage2.accountingRevenueCadMinor).toBe(100_000);
    expect(stage2.grossSaleValueCadMinor).toBe(106_500);
    expect(stage2.pendingExternalReceivablesCadMinor).toBe(75_475);
    expect(stage2.runningOperatorFloatCadMinor).toBe(22_600);
    expect(stage2.confirmedCorpBankCashCadMinor).toBe(2_200_000);
    expect(stage2.netHstTrustLiabilityCadMinor).toBe(6_500);
    expect(stage2.availableWorkingCapitalCadMinor).toBe(2_193_500);
    expect(stage2.estimatedDonorProfitCadMinor).toBe(280_000);

    // Stage 3: eBay settles net 41,575 with verified fee invoice ITC 861; e-Transfer settles 33,900;
    // shop buys $30 supply from float; hunter sweeps $150 from float to bank;
    // recycler pays $550 catalytic converter scrap directly to bank;
    // deferred intercompany yard lease accrual ($1,200) stays unpaid (excluded from bank, in profit pool).
    const stage3 = computeSeparatedFinancialSnapshot(
      makeBaseSnapshotInput({
        sales: [
          {
            id: 'sale-ebay-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'EBAY_MOTORS_SHIPPED',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
            subtotalMinor: 50_000,
            gstHstTaxCadMinor: 0,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 0,
            buyerTaxRemittedByPlatformMinor: 6_500,
            platformFeeMinor: 6_625,
            shippingCostMinor: 1_800,
            estimatedPlatformFeeTaxCadMinor: 861,
            itcReceivableCadMinor: 861,
            isFeeTaxInvoiceVerified: true,
            feeTaxInvoiceStorageKey: 'r2://private/ebay-inv-jan.pdf',
            grossCollectedMinor: 50_000,
            netRealizedCadMinor: 41_575,
            bankClearedCadMinor: 41_575,
            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            bankSettledAt: '2026-04-05T15:00:00Z',
            bankDepositReference: 'EBAY-PAYOUT-101',
            isVoidedOrReversed: false,
          },
          {
            id: 'sale-etransfer-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'FB_MARKETPLACE_LOCAL',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalMinor: 30_000,
            gstHstTaxCadMinor: 3_900,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 3_900,
            platformFeeMinor: 0,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 33_900,
            netRealizedCadMinor: 30_000,
            bankClearedCadMinor: 33_900,
            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            bankSettledAt: '2026-04-05T16:00:00Z',
            bankDepositReference: 'INTERAC-9988',
            isVoidedOrReversed: false,
          },
          {
            id: 'sale-cash-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'LOCAL_WALK_IN_CASH',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalMinor: 20_000,
            gstHstTaxCadMinor: 2_600,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 2_600,
            platformFeeMinor: 0,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 22_600,
            netRealizedCadMinor: 20_000,
            paymentSettlementState: 'PAYMENT_CONFIRMED',
            cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
            soldByUserId: 'hunter-1',
            custodyHolderUserId: 'hunter-1',
            isVoidedOrReversed: false,
          },
        ],
        expenses: [
          {
            id: 'exp-float-1',
            organizationId: ORG_SALVAGE,
            category: 'AFTERMARKET_REPAIR_PARTS',
            currencyOriginal: 'CAD',
            amountCadMinor: 3_000,
            itcReceivableCadMinor: 390,
            paidFromCashCustody: 'HELD_IN_OPERATOR_FLOAT',
            custodyHolderUserId: 'hunter-1',
            isDeferredIntercompanyAccrual: false,
            accrualSettledAt: null,
            receiptVerificationState: 'VERIFIED_RECEIPT',
            receiptStorageKey: 'r2://private/shop-gloves.jpg',
          },
          {
            id: 'exp-accrual-1',
            organizationId: ORG_SALVAGE,
            category: 'STEAM_CLEANING_EXPORT_PREP',
            currencyOriginal: 'CAD',
            amountCadMinor: 120_000,
            itcReceivableCadMinor: 0,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            isDeferredIntercompanyAccrual: true,
            accrualSettledAt: null,
            receiptVerificationState: 'VERIFIED_RECEIPT',
            receiptStorageKey: 'r2://private/lease-accrual.pdf',
          },
        ],
        cashTransfers: [
          {
            id: 'sweep-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
            toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            currency: 'CAD',
            amountMinor: 15_000,
            equivalentCadMinor: 15_000,
            depositSlipStorageKey: 'r2://private/deposit-slip-1.jpg',
            operatorUserId: 'hunter-1',
            sourceSaleIds: ['sale-cash-1'],
          },
        ],
        scrapLogs: [
          {
            id: 'scrap-1',
            organizationId: ORG_SALVAGE,
            vehicleId: 'veh-1',
            payoutCadMinor: 55_000,
            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
          },
        ],
      }),
      policy,
    );

    // Operator float: 22,600 - 3,000 - 15,000 = 4,600
    // Confirmed corp bank cash:
    //   2,200,000 (tranche 1) + 41,575 (ebay) + 33,900 (etransfer)
    //   + 15,000 (sweep) + 55,000 (scrap) - 0 (deferred accrual not paid!) = 2,345,475
    // Net HST trust liability: (3,900 + 2,600) - (861 verified ebay + 390 verified expense) = 6,500 - 1,251 = 5,249
    // Available working capital: 2,345,475 - 5,249 = 2,340,226
    expect(stage3.pendingExternalReceivablesCadMinor).toBe(0);
    expect(stage3.runningOperatorFloatCadMinor).toBe(4_600);
    expect(stage3.operatorFloatByUserId['hunter-1']).toBe(4_600);
    expect(stage3.confirmedCorpBankCashCadMinor).toBe(2_345_475);
    expect(stage3.netHstTrustLiabilityCadMinor).toBe(5_249);
    expect(stage3.availableWorkingCapitalCadMinor).toBe(2_340_226);
  });

  it('prevents double-deduction on bankClearedCadMinor + shipping expense, mirrored donor acquisition/Expense, duplicate sweeps, and handles refunds after float sweeps', () => {
    const policy = makePolicy();

    // Case A: eBay sale cleared 43,375 (where shipping label 1,800 was paid via separate bank Expense)
    // plus a sale with shipping withheld at payout (bankClearedCadMinor = 41,575) with an expense flagged isWithheldOrNettedInSalePayout
    const snapshot = computeSeparatedFinancialSnapshot(
      makeBaseSnapshotInput({
        sales: [
          {
            id: 'sale-ship-sep',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'EBAY_MOTORS_SHIPPED',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
            subtotalMinor: 50_000,
            gstHstTaxCadMinor: 0,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 0,
            platformFeeMinor: 6_625,
            shippingCostMinor: 1_800,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 50_000,
            netRealizedCadMinor: 41_575,
            bankClearedCadMinor: 43_375, // payout net of fee ONLY (shipping paid via bank card expense)
            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            bankSettledAt: '2026-04-06T12:00:00Z',
            bankDepositReference: 'EBAY-PAY-201',
            isVoidedOrReversed: false,
          },
          {
            id: 'sale-cash-swept-then-refunded',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'LOCAL_WALK_IN_CASH',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalMinor: 10_000,
            gstHstTaxCadMinor: 1_300,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 1_300,
            platformFeeMinor: 0,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 11_300,
            netRealizedCadMinor: 10_000,
            paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
            cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
            custodyHolderUserId: 'hunter-1',
            isVoidedOrReversed: true,
          },
        ],
        cashTransfers: [
          {
            id: 'sweep-cash-1',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
            toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            currency: 'CAD',
            amountMinor: 11_300,
            equivalentCadMinor: 11_300,
            depositSlipStorageKey: 'r2://private/slip-sweep-1.jpg',
            operatorUserId: 'hunter-1',
            sourceSaleIds: ['sale-cash-swept-then-refunded'],
          },
        ],
        refundAdjustments: [
          {
            id: 'adj-cash-refund-1',
            organizationId: ORG_SALVAGE,
            originalSaleId: 'sale-cash-swept-then-refunded',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalAdjustmentMinor: -10_000,
            gstHstAdjustmentCadMinor: -1_300,
            provincialTaxAdjustmentCadMinor: 0,
            itcAdjustmentCadMinor: 0,
            grossAdjustmentMinor: -11_300,
            // Omitted explicit refundSettlementAccount -> auto-infers CORP_BANK because sale was swept!
          },
        ],
        expenses: [
          {
            id: 'exp-ship-1',
            organizationId: ORG_SALVAGE,
            category: 'PACKAGING_AND_LABELS',
            currencyOriginal: 'CAD',
            amountCadMinor: 1_800,
            itcReceivableCadMinor: 0,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            isDeferredIntercompanyAccrual: false,
            accrualSettledAt: null,
            receiptVerificationState: 'VERIFIED_RECEIPT',
            receiptStorageKey: 'r2://private/canadapost.pdf',
          },
          {
            id: 'exp-veh-acq',
            organizationId: ORG_SALVAGE,
            category: 'AUCTION_PURCHASE_PRICE',
            vehicleId: 'veh-mirrored',
            currencyOriginal: 'CAD',
            amountCadMinor: 250_000,
            itcReceivableCadMinor: 0,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            isDeferredIntercompanyAccrual: false,
            accrualSettledAt: null,
            receiptVerificationState: 'VERIFIED_RECEIPT',
            receiptStorageKey: 'r2://private/copart-inv.pdf',
          },
        ],
        // Mirrored vehicle summary MUST NOT subtract another 250,000 from bank cash!
        donorVehicles: [
          {
            id: 'veh-mirrored',
            organizationId: ORG_SALVAGE,
            totalAcquisitionAndStripCostCadMinor: 250_000,
            scrapRecoveryCadMinor: 0,
            realizedPartSalesCadMinor: 50_000,
            projectedRemainingPartsCadMinor: 0,
          },
        ],
      }),
      policy,
    );

    // Swept cash refund: +11,300 (orig cash) - 11,300 (sweep) = 0 float!
    // Bank: 2,200,000 + 43,375 (bankCleared) - 1,800 (shipping exp) - 250,000 (veh exp) + 11,300 (sweep) - 11,300 (bank refund!) = 1,991,575
    // Notice original+adjustment normalization did NOT double-deduct because sale is marked REFUNDED_OR_CHARGED_BACK!
    expect(snapshot.runningOperatorFloatCadMinor).toBe(0);
    expect(snapshot.confirmedCorpBankCashCadMinor).toBe(1_991_575);
    expect(snapshot.accountingRevenueCadMinor).toBe(50_000);
    expect(snapshot.grossSaleValueCadMinor).toBe(50_000);
    expect(snapshot.netHstTrustLiabilityCadMinor).toBe(0);

    // Duplicate sweep referencing the same sourceSaleId must throw DUPLICATE_SWEEP_SOURCE_CREDIT
    expect(() =>
      computeSeparatedFinancialSnapshot(
        makeBaseSnapshotInput({
          sales: [
            {
              id: 'sale-cash-ok',
              organizationId: ORG_SALVAGE,
              marketNode: 'DOMESTIC_ORIGIN',
              domesticChannel: 'LOCAL_WALK_IN_CASH',
              paymentCurrency: 'CAD',
              taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
              subtotalMinor: 10_000,
              gstHstTaxCadMinor: 1_300,
              provincialTaxCadMinor: 0,
              taxOrVatMinor: 1_300,
              platformFeeMinor: 0,
              shippingCostMinor: 0,
              estimatedPlatformFeeTaxCadMinor: 0,
              itcReceivableCadMinor: 0,
              isFeeTaxInvoiceVerified: false,
              grossCollectedMinor: 11_300,
              netRealizedCadMinor: 10_000,
              paymentSettlementState: 'PAYMENT_CONFIRMED',
              cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
              isVoidedOrReversed: false,
            },
          ],
          cashTransfers: [
            {
              id: 'sweep-a',
              organizationId: ORG_SALVAGE,
              marketNode: 'DOMESTIC_ORIGIN',
              fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
              toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
              currency: 'CAD',
              amountMinor: 11_300,
              equivalentCadMinor: 11_300,
              depositSlipStorageKey: 'r2://private/slip-a.jpg',
              sourceSaleIds: ['sale-cash-ok'],
            },
            {
              id: 'sweep-b',
              organizationId: ORG_SALVAGE,
              marketNode: 'DOMESTIC_ORIGIN',
              fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
              toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
              currency: 'CAD',
              amountMinor: 11_300,
              equivalentCadMinor: 11_300,
              depositSlipStorageKey: 'r2://private/slip-b.jpg',
              sourceSaleIds: ['sale-cash-ok'],
            },
          ],
        }),
        policy,
      ),
    ).toThrowError(DomainRuleError);
  });

  it('rejects cross-organization rows, duplicate entity IDs, missing sweep deposit slips, and unconverted non-CAD cash', () => {
    const policy = makePolicy();

    expect(() =>
      computeSeparatedFinancialSnapshot(
        makeBaseSnapshotInput({
          sales: [
            {
              id: 'sale-xorg',
              organizationId: ORG_OTHER,
              marketNode: 'DOMESTIC_ORIGIN',
              domesticChannel: 'LOCAL_WALK_IN_CASH',
              paymentCurrency: 'CAD',
              taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
              subtotalMinor: 10_000,
              gstHstTaxCadMinor: 1_300,
              provincialTaxCadMinor: 0,
              taxOrVatMinor: 1_300,
              platformFeeMinor: 0,
              shippingCostMinor: 0,
              estimatedPlatformFeeTaxCadMinor: 0,
              itcReceivableCadMinor: 0,
              isFeeTaxInvoiceVerified: false,
              grossCollectedMinor: 11_300,
              netRealizedCadMinor: 10_000,
              paymentSettlementState: 'PAYMENT_CONFIRMED',
              cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
              isVoidedOrReversed: false,
            },
          ],
        }),
        policy,
      ),
    ).toThrow(/organization/i);

    expect(() =>
      computeSeparatedFinancialSnapshot(
        makeBaseSnapshotInput({
          expenses: [
            {
              id: 'dup-exp',
              organizationId: ORG_SALVAGE,
              category: 'TOWING_AND_RECOVERY',
              currencyOriginal: 'CAD',
              amountCadMinor: 10_000,
              itcReceivableCadMinor: 0,
              paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
              isDeferredIntercompanyAccrual: false,
              accrualSettledAt: null,
              receiptVerificationState: 'VERIFIED_RECEIPT',
              receiptStorageKey: 'r2://a.pdf',
            },
            {
              id: 'dup-exp',
              organizationId: ORG_SALVAGE,
              category: 'TOWING_AND_RECOVERY',
              currencyOriginal: 'CAD',
              amountCadMinor: 10_000,
              itcReceivableCadMinor: 0,
              paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
              isDeferredIntercompanyAccrual: false,
              accrualSettledAt: null,
              receiptVerificationState: 'VERIFIED_RECEIPT',
              receiptStorageKey: 'r2://b.pdf',
            },
          ],
        }),
        policy,
      ),
    ).toThrow(/duplicate/i);

    // Unconverted TTD bank-settled or float sale entering domestic pool without CAD conversion throws UNCONVERTED_NON_CAD_AMOUNT
    try {
      computeSeparatedFinancialSnapshot(
        makeBaseSnapshotInput({
          sales: [
            {
              id: 'sale-ttd-unconverted',
              organizationId: ORG_SALVAGE,
              marketNode: 'DOMESTIC_ORIGIN',
              domesticChannel: 'LOCAL_WALK_IN_CASH',
              paymentCurrency: 'TTD',
              taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
              subtotalMinor: 50_000,
              gstHstTaxCadMinor: 0,
              provincialTaxCadMinor: 0,
              taxOrVatMinor: 0,
              platformFeeMinor: 0,
              shippingCostMinor: 0,
              estimatedPlatformFeeTaxCadMinor: 0,
              itcReceivableCadMinor: 0,
              isFeeTaxInvoiceVerified: false,
              grossCollectedMinor: 50_000,
              netRealizedCadMinor: 50_000,
              paymentSettlementState: 'PAYMENT_CONFIRMED',
              cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
              isVoidedOrReversed: false,
            },
          ],
        }),
        policy,
      );
      expect.unreachable('Should have rejected unconverted non-CAD cash');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainRuleError);
      expect((error as DomainRuleError).code).toBe(
        'UNCONVERTED_NON_CAD_AMOUNT',
      );
    }

    // Blank deposit slip on sweep throws INVALID_DEPOSIT_SLIP_KEY
    try {
      computeSeparatedFinancialSnapshot(
        makeBaseSnapshotInput({
          cashTransfers: [
            {
              id: 'sweep-blank',
              organizationId: ORG_SALVAGE,
              marketNode: 'DOMESTIC_ORIGIN',
              fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
              toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
              currency: 'CAD',
              amountMinor: 5_000,
              equivalentCadMinor: 5_000,
              depositSlipStorageKey: '   ',
            },
          ],
        }),
        policy,
      );
      expect.unreachable('Should have rejected blank deposit slip key');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainRuleError);
      expect((error as DomainRuleError).code).toBe('INVALID_DEPOSIT_SLIP_KEY');
    }
  });
});

describe('Net GST/HST Trust Liability Ring-Fencing (computeNetHstTrustLiabilityCadMinor)', () => {
  it('ring-fences verified fee/expense ITCs, excludes unverified ITCs and provincial PST/QST, applies credit reversals, and clamps trust at 0', () => {
    const baseInput: NetHstTrustLiabilityInput = {
      organizationId: ORG_SALVAGE,
      sales: [
        {
          id: 'sale-direct-on',
          organizationId: ORG_SALVAGE,
          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
          gstHstTaxCadMinor: 13_000,
          provincialTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        },
        {
          id: 'sale-direct-qc',
          organizationId: ORG_SALVAGE,
          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
          gstHstTaxCadMinor: 5_000, // 5% federal GST
          provincialTaxCadMinor: 9_975, // 9.975% QC QST (MUST NOT pollute CRA GST/HST trust liability!)
          itcReceivableCadMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        },
        {
          // Permissive calculator populated itcReceivableCadMinor=1000 while isFeeTaxInvoiceVerified=false!
          // Strict trust calculation MUST IGNORE unverified fee ITCs!
          id: 'sale-ebay-unverified-itc',
          organizationId: ORG_SALVAGE,
          taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
          gstHstTaxCadMinor: 0,
          provincialTaxCadMinor: 0,
          itcReceivableCadMinor: 1_000,
          estimatedPlatformFeeTaxCadMinor: 1_000,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        },
        {
          id: 'sale-ebay-verified-itc',
          organizationId: ORG_SALVAGE,
          taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
          gstHstTaxCadMinor: 0,
          provincialTaxCadMinor: 0,
          itcReceivableCadMinor: 861,
          estimatedPlatformFeeTaxCadMinor: 861,
          isFeeTaxInvoiceVerified: true,
          feeTaxInvoiceStorageKey: 'r2://private/ebay-fee-tax.pdf',
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        },
      ],
      expenses: [
        {
          id: 'exp-verified-1',
          organizationId: ORG_SALVAGE,
          itcReceivableCadMinor: 2_600,
          receiptVerificationState: 'VERIFIED_RECEIPT',
          receiptStorageKey: 'r2://private/tool-receipt.jpg',
        },
        {
          // Petty cash voucher / pending upload cannot claim verified CRA ITC
          id: 'exp-pending-1',
          organizationId: ORG_SALVAGE,
          itcReceivableCadMinor: 1_500,
          receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
          receiptStorageKey: null,
        },
      ],
      refundAdjustments: [
        {
          id: 'adj-on-1',
          organizationId: ORG_SALVAGE,
          originalSaleId: 'sale-direct-on',
          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
          gstHstAdjustmentCadMinor: -2_600,
          provincialTaxAdjustmentCadMinor: 0,
          itcAdjustmentCadMinor: 0,
        },
        {
          id: 'adj-ebay-credit-1',
          organizationId: ORG_SALVAGE,
          originalSaleId: 'sale-ebay-verified-itc',
          taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
          gstHstAdjustmentCadMinor: 0,
          provincialTaxAdjustmentCadMinor: 0,
          itcAdjustmentCadMinor: -200,
        },
      ],
    };

    // Direct GST/HST collected: 13,000 + 5,000 - 2,600 = 15,400 (QC QST 9,975 excluded!)
    // Verified ITC: (861 - 200) + 2,600 = 3,261 (1,000 unverified fee ITC & 1,500 pending receipt ignored!)
    // Net trust = 15,400 - 3,261 = 12,139
    expect(computeNetHstTrustLiabilityCadMinor(baseInput)).toBe(12_139);

    // Excess verified ITC clamps trust at 0 (never produces negative trust inflating spendable cash)
    expect(
      computeNetHstTrustLiabilityCadMinor({
        ...baseInput,
        expenses: [
          {
            id: 'exp-huge-itc',
            organizationId: ORG_SALVAGE,
            itcReceivableCadMinor: 50_000,
            receiptVerificationState: 'VERIFIED_RECEIPT',
            receiptStorageKey: 'r2://private/truck-purchase.pdf',
          },
        ],
      }),
    ).toBe(0);
  });
});

describe('3-Tranche Working Capital & Deal Discipline Gate (evaluateWorkingCapitalGate)', () => {
  it('enforces $22k launch / $7.5k reserve ($14.5k headroom) boundary, donor $3.2k cap, Year-1 rebuild pause, and tranche eligibility vs release', () => {
    const policy = makePolicy();
    const launchHeadroom = 1_450_000; // $22,000 - $7,500 = $14,500.00 CAD

    // Exact reserve equality passes for QUICK_TURN_BEATER (no donor cap)
    const exactOk = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: launchHeadroom,
        operationalLane: 'QUICK_TURN_BEATER',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      policy,
    );
    expect(exactOk.allowed).toBe(true);
    expect(exactOk.blockingCodes).toEqual([]);

    // 1 cent beyond reserve breaches WORKING_CAPITAL_RESERVE_BREACHED
    const oneCentBreach = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: launchHeadroom + 1,
        operationalLane: 'QUICK_TURN_BEATER',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      policy,
    );
    expect(oneCentBreach.allowed).toBe(false);
    expect(oneCentBreach.blockingCodes).toContain(
      'WORKING_CAPITAL_RESERVE_BREACHED',
    );

    // Donor $3,200 equality vs 1-cent breach
    const donorOk = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 320_000,
        operationalLane: 'DISMANTLE_AND_EXPORT',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      policy,
    );
    expect(donorOk.allowed).toBe(true);

    const donorBreach = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 320_001,
        operationalLane: 'DISMANTLE_AND_EXPORT',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      policy,
    );
    expect(donorBreach.allowed).toBe(false);
    expect(donorBreach.blockingCodes).toEqual(['DONOR_LANDED_CAP_EXCEEDED']);

    // Year-1 HIGH_END_REBUILD pause
    const rebuildPaused = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 400_000,
        operationalLane: 'HIGH_END_REBUILD',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      policy,
    );
    expect(rebuildPaused.allowed).toBe(false);
    expect(rebuildPaused.blockingCodes).toEqual(['HIGH_END_REBUILD_LANE_PAUSED']);

    // Tranche milestones: meeting 120 SKUs & 3 donors + 400 SKUs & 8 donors & 0 overdue receipts marks eligible,
    // while keeping locked tranches excluded from active released capital
    const trancheEval1 = evaluateTrancheMilestoneEligibility(policy, {
      shelvedSkusCount: 120,
      scrappedDonorsCount: 3,
      overdueFloatReceiptsCount: 1,
    });
    expect(trancheEval1.activeReleasedTrancheCapitalCadMinor).toBe(2_200_000);
    expect(trancheEval1.committedFacilityCadMinor).toBe(4_400_000);
    expect(trancheEval1.tranches).toEqual([
      expect.objectContaining({
        trancheCode: 'TRANCHE_1_LAUNCH',
        unlocked: true,
        milestoneMet: true,
      }),
      expect.objectContaining({
        trancheCode: 'TRANCHE_2_DAY_60',
        unlocked: false,
        milestoneMet: true,
      }),
      expect.objectContaining({
        trancheCode: 'TRANCHE_3_DAY_120',
        unlocked: false,
        milestoneMet: false, // blocked by SKUs, scrapped donors & 1 overdue float receipt
      }),
    ]);

    const trancheEval2 = evaluateTrancheMilestoneEligibility(policy, {
      shelvedSkusCount: 400,
      scrappedDonorsCount: 8,
      overdueFloatReceiptsCount: 0,
    });
    expect(trancheEval2.tranches[2]?.milestoneMet).toBe(true);
    expect(trancheEval2.activeReleasedTrancheCapitalCadMinor).toBe(2_200_000);
  });

  it('respects HARD_BLOCK/WARN_ONLY/DISABLED modes, trusted vs invalid CFO overrides, and invariance against unsafe liquidity flags', () => {
    const warnPolicy = makePolicy({
      workingCapitalGate: { enforcementMode: 'WARN_ONLY' },
    });
    const warnResult = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 1_500_000, // breaches reserve, does NOT trigger donor cap on QUICK_TURN_BEATER
        operationalLane: 'QUICK_TURN_BEATER',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      warnPolicy,
    );
    expect(warnResult.allowed).toBe(true);
    expect(warnResult.blockingCodes).toEqual([]);
    expect(warnResult.warnings).toContain('WORKING_CAPITAL_RESERVE_BREACHED');

    const disabledPolicy = makePolicy({
      workingCapitalGate: { enabled: false, enforcementMode: 'DISABLED' },
    });
    const disabledResult = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 800_000,
        estimatedDealOutlayCadMinor: 200_000,
        operationalLane: 'QUICK_TURN_BEATER',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
      },
      disabledPolicy,
    );
    expect(disabledResult.allowed).toBe(true);
    expect(disabledResult.blockingCodes).toEqual([]);

    // Valid CFO override unlocks multiple blocks (reserve + donor cap + rebuild pause)
    const hardPolicy = makePolicy();
    const overrideOk = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 1_600_000,
        operationalLane: 'HIGH_END_REBUILD',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
        cfoOverride: {
          approved: true,
          approvedById: 'cfo-1',
          approverRole: 'ARCHITECT_CFO',
          reasonNote: 'Approved classic truck frame-off rebuild with pre-sold buyer deposit.',
        },
      },
      hardPolicy,
    );
    expect(overrideOk.allowed).toBe(true);
    expect(overrideOk.overrideApplied).toBe(true);
    expect(overrideOk.cfoOverrideAudit).toEqual({
      overrideApplied: true,
      approvedById: 'cfo-1',
      reasonNote:
        'Approved classic truck frame-off rebuild with pre-sold buyer deposit.',
    });

    // Forged non-CFO or blank reason override is rejected
    const forgedOverride = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 400_000,
        operationalLane: 'DISMANTLE_AND_EXPORT',
        assetCategory: 'AUTOMOBILE',
        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
        cfoOverride: {
          approved: true,
          approvedById: 'hunter-1',
          approverRole: 'HUNTER_MECHANIC',
          reasonNote: 'Self-approved',
        },
      },
      hardPolicy,
    );
    expect(forgedOverride.allowed).toBe(false);
    expect(forgedOverride.overrideApplied).toBe(false);
    expect(forgedOverride.blockingCodes).toContain('CFO_OVERRIDE_UNAUTHORIZED');

    // Invariance against unsafe policy flags countPending* / countOperatorFloat*
    const unsafeFlagsPolicy = makePolicy({
      workingCapitalGate: {
        countPendingExportCashAsAvailable: true,
        countPendingDomesticReceivablesAsAvailable: true,
        countOperatorFloatInBankWorkingCapital: true,
      },
    });
    const snapshotWithUnsafeFlags = computeSeparatedFinancialSnapshot(
      makeBaseSnapshotInput({
        sales: [
          {
            id: 'sale-pending-flag-test',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'EBAY_MOTORS_SHIPPED',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
            subtotalMinor: 100_000,
            gstHstTaxCadMinor: 0,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 0,
            platformFeeMinor: 13_250,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 100_000,
            netRealizedCadMinor: 86_750,
            paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING',
            cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
            isVoidedOrReversed: false,
          },
          {
            id: 'sale-float-flag-test',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'LOCAL_WALK_IN_CASH',
            paymentCurrency: 'CAD',
            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
            subtotalMinor: 50_000,
            gstHstTaxCadMinor: 6_500,
            provincialTaxCadMinor: 0,
            taxOrVatMinor: 6_500,
            platformFeeMinor: 0,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            grossCollectedMinor: 56_500,
            netRealizedCadMinor: 50_000,
            paymentSettlementState: 'PAYMENT_CONFIRMED',
            cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
            isVoidedOrReversed: false,
          },
        ],
      }),
      unsafeFlagsPolicy,
    );
    // Still ONLY tranche 1 bank cash (2,200,000) minus HST trust (6,500) = 2,193,500
    expect(snapshotWithUnsafeFlags.confirmedCorpBankCashCadMinor).toBe(2_200_000);
    expect(snapshotWithUnsafeFlags.availableWorkingCapitalCadMinor).toBe(
      2_193_500,
    );
  });
});

describe('3-Rule Compensation Protocol (RULE-PAY-001 to RULE-PAY-003)', () => {
  it('enforces RULE-PAY-001 piece-rate gate requiring fluidsDrainedAt and >= 35 valid shelved parts for that donor', () => {
    const policy = makePolicy();
    const makeValidPart = (idx: number, overrides: Record<string, unknown> = {}) => ({
      id: `part-${idx}`,
      organizationId: ORG_SALVAGE,
      donorVehicleId: 'veh-1',
      custodyState: 'SHELVED_ORIGIN_CONTAINER' as const,
      availabilityState: 'AVAILABLE' as const,
      barcode: `SKU-${idx}`,
      binLocationCode: 'KEMP-C01-R01-S01-B01',
      rawPhotoUrls: [`r2://parts/p-${idx}.jpg`],
      ...overrides,
    });

    // 34 valid parts -> blocked
    const parts34 = Array.from({ length: 34 }, (_, i) => makeValidPart(i + 1));
    const fail34 = evaluatePieceRatePayout(
      {
        organizationId: ORG_SALVAGE,
        vehicleId: 'veh-1',
        fluidsDrainedAt: '2026-04-01T10:00:00Z',
        parts: parts34,
      },
      policy,
    );
    expect(fail34.eligible).toBe(false);
    expect(fail34.qualifyingShelvedPartsCount).toBe(34);
    expect(fail34.authorizedPayoutCadMinor).toBe(0);
    expect(fail34.blockingCodes).toContain('PIECE_RATE_GATE_UNMET');

    // 35th part from wrong donor, missing barcode, return QC hold, or no photo does NOT qualify!
    const pollutedParts = [
      ...parts34,
      makeValidPart(35, { donorVehicleId: 'veh-other' }),
      makeValidPart(36, { barcode: '   ' }),
      makeValidPart(37, { rawPhotoUrls: [] }),
      makeValidPart(38, {
        custodyState: 'RESTOCKED_QC_HOLD',
        availabilityState: 'RETURNED_QC_HOLD',
      }),
      makeValidPart(39, { binLocationCode: '' }),
    ];
    const failPolluted = evaluatePieceRatePayout(
      {
        organizationId: ORG_SALVAGE,
        vehicleId: 'veh-1',
        fluidsDrainedAt: '2026-04-01T10:00:00Z',
        parts: pollutedParts,
      },
      policy,
    );
    expect(failPolluted.eligible).toBe(false);
    expect(failPolluted.qualifyingShelvedPartsCount).toBe(34);

    // 35th valid part WITH fluidsDrainedAt=null -> blocked
    const parts35 = [...parts34, makeValidPart(35)];
    const failUndrained = evaluatePieceRatePayout(
      {
        organizationId: ORG_SALVAGE,
        vehicleId: 'veh-1',
        fluidsDrainedAt: null,
        parts: parts35,
      },
      policy,
    );
    expect(failUndrained.eligible).toBe(false);
    expect(failUndrained.blockingCodes).toContain('PIECE_RATE_GATE_UNMET');

    // 35 valid parts + fluidsDrainedAt populated -> passes with policy piece-rate ($350 CAD)
    const pass35 = evaluatePieceRatePayout(
      {
        organizationId: ORG_SALVAGE,
        vehicleId: 'veh-1',
        fluidsDrainedAt: '2026-04-01T10:00:00Z',
        parts: parts35,
      },
      policy,
    );
    expect(pass35.eligible).toBe(true);
    expect(pass35.qualifyingShelvedPartsCount).toBe(35);
    expect(pass35.authorizedPayoutCadMinor).toBe(35_000);
    expect(pass35.blockingCodes).toEqual([]);
  });

  it('enforces RULE-PAY-002 & RULE-PAY-003 profit pool, pending exclusion, accrued lease deduction, operator-specific float offset, reserve floor, and zero CFO bypass', () => {
    const policy = makePolicy();

    // Seed-only launch state ($22k bank, $0 realized sales): profit pool is 0 even with CFO override
    const seedOnlyDraw = evaluatePartnerProfitDraw(
      {
        organizationId: ORG_SALVAGE,
        targetUserId: 'hunter-1',
        targetUserRole: 'HUNTER_MECHANIC',
        requestedDrawCadMinor: 10_000,
        snapshotInput: makeBaseSnapshotInput(),
        actor: { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' },
        cfoOverride: {
          approved: true,
          approvedById: 'cfo-1',
          approverRole: 'ARCHITECT_CFO',
          reasonNote: 'Try to draw from launch tranche',
        },
      },
      policy,
    );
    expect(seedOnlyDraw.allowed).toBe(false);
    expect(seedOnlyDraw.overrideApplied).toBe(false);
    expect(seedOnlyDraw.distributableRealizedProfitPoolCadMinor).toBe(0);
    expect(seedOnlyDraw.blockingCodes).toContain(
      'INSUFFICIENT_REALIZED_PROFIT_POOL',
    );

    // Rich scenario:
    // - Pending eBay sale net 100,000 -> EXCLUDED from profit pool!
    // - Confirmed bank sale subtotal 200,000, fee 0, ship 0, direct ON HST 26,000 -> netRealized 200,000
    // - Cash sale held by hunter-2 = 40,000 subtotal + 5,200 HST (45,200 in hunter-2 float) -> hunter-1 CANNOT offset against hunter-2's float!
    // - Cash sale held by hunter-1 = 30,000 subtotal + 3,900 HST (33,900 in hunter-1 float)
    // - Bank scrap recovery = 60,000
    // - Deferred unpaid lease accrual = 50,000 (reduces profit pool!)
    // - Prior partner profit draw = 20,000 (reduces profit pool!)
    // Direct HST = 26,000 + 5,200 + 3,900 = 35,100
    // Realized net profit pool BEFORE trust check? Check DOMAIN-RULES 4.5 Eq:
    //   confirmed netRealized (200,000 + 40,000 + 30,000 = 270,000) + scrap (60,000)
    //   - all non-voided expenses (50,000 accrual + 20,000 prior draw = 70,000)
    //   - NetHstTrustLiability (35,100)
    //   = 270,000 + 60,000 - 70,000 - 35,100 = 224,900!
    //   Wait: look carefully at confirmedCorpBankCashCadMinor & availableWorkingCapital:
    //   Suppose bank had $0 tranche unlocked? No, launch tranche = 2,200,000.
    //   Bank = 2,200,000 + 226,000 (confirmed bank sale incl HST) + 60,000 (scrap) - 20,000 (prior draw) = 2,466,000
    //   AvailableWorkingCapital = 2,466,000 - 35,100 (HST trust) = 2,430,900
    //   Reserve headroom = 2,430,900 - 750,000 = 1,680,900
    const richInput: FinancialSnapshotInput = makeBaseSnapshotInput({
      sales: [
        {
          id: 's-pending',
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'EBAY_MOTORS_SHIPPED',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
          subtotalMinor: 100_000,
          gstHstTaxCadMinor: 0,
          provincialTaxCadMinor: 0,
          taxOrVatMinor: 0,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          grossCollectedMinor: 100_000,
          netRealizedCadMinor: 100_000,
          paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING',
          cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
          isVoidedOrReversed: false,
        },
        {
          id: 's-bank',
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'FB_MARKETPLACE_LOCAL',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
          subtotalMinor: 200_000,
          gstHstTaxCadMinor: 26_000,
          provincialTaxCadMinor: 0,
          taxOrVatMinor: 26_000,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          grossCollectedMinor: 226_000,
          netRealizedCadMinor: 200_000,
          bankClearedCadMinor: 226_000,
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
          cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
          bankSettledAt: '2026-04-06T12:00:00Z',
          bankDepositReference: 'INT-1',
          isVoidedOrReversed: false,
        },
        {
          id: 's-hunter2-float',
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
          subtotalMinor: 40_000,
          gstHstTaxCadMinor: 5_200,
          provincialTaxCadMinor: 0,
          taxOrVatMinor: 5_200,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          grossCollectedMinor: 45_200,
          netRealizedCadMinor: 40_000,
          paymentSettlementState: 'PAYMENT_CONFIRMED',
          cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
          custodyHolderUserId: 'hunter-2',
          isVoidedOrReversed: false,
        },
        {
          id: 's-hunter1-float',
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
          subtotalMinor: 30_000,
          gstHstTaxCadMinor: 3_900,
          provincialTaxCadMinor: 0,
          taxOrVatMinor: 3_900,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          grossCollectedMinor: 33_900,
          netRealizedCadMinor: 30_000,
          paymentSettlementState: 'PAYMENT_CONFIRMED',
          cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
          custodyHolderUserId: 'hunter-1',
          isVoidedOrReversed: false,
        },
      ],
      scrapLogs: [
        {
          id: 'scrap-rich',
          organizationId: ORG_SALVAGE,
          vehicleId: 'veh-1',
          payoutCadMinor: 60_000,
          cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
        },
      ],
      expenses: [
        {
          id: 'exp-accrual-rich',
          organizationId: ORG_SALVAGE,
          category: 'STEAM_CLEANING_EXPORT_PREP',
          currencyOriginal: 'CAD',
          amountCadMinor: 50_000,
          itcReceivableCadMinor: 0,
          paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
          isDeferredIntercompanyAccrual: true,
          accrualSettledAt: null,
          receiptVerificationState: 'VERIFIED_RECEIPT',
          receiptStorageKey: 'r2://lease.pdf',
        },
        {
          id: 'exp-prior-draw',
          organizationId: ORG_SALVAGE,
          category: 'PARTNER_PROFIT_DRAW',
          currencyOriginal: 'CAD',
          amountCadMinor: 20_000,
          itcReceivableCadMinor: 0,
          paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
          isDeferredIntercompanyAccrual: false,
          accrualSettledAt: null,
          receiptVerificationState: 'VERIFIED_RECEIPT',
          receiptStorageKey: 'r2://draw-1.pdf',
        },
      ],
    });

    // Draw 100,000 for hunter-1:
    // Offsets hunter-1's own 33,900 float first (never hunter-2's 45,200 float!)
    // Remaining bank disbursement = 100,000 - 33,900 = 66,100
    const hunter1Draw = evaluatePartnerProfitDraw(
      {
        organizationId: ORG_SALVAGE,
        targetUserId: 'hunter-1',
        targetUserRole: 'HUNTER_MECHANIC',
        requestedDrawCadMinor: 100_000,
        snapshotInput: richInput,
      },
      policy,
    );
    expect(hunter1Draw.allowed).toBe(true);
    expect(hunter1Draw.distributableRealizedProfitPoolCadMinor).toBe(224_900);
    expect(hunter1Draw.targetOperatorFloatCadMinor).toBe(33_900);
    expect(hunter1Draw.floatOffsetAppliedCadMinor).toBe(33_900);
    expect(hunter1Draw.netCashDisbursedFromBankCadMinor).toBe(66_100);

    // Draw 224,901 fails profit pool even if bank headroom is huge
    const overPoolDraw = evaluatePartnerProfitDraw(
      {
        organizationId: ORG_SALVAGE,
        targetUserId: 'hunter-1',
        targetUserRole: 'HUNTER_MECHANIC',
        requestedDrawCadMinor: 224_901,
        snapshotInput: richInput,
      },
      policy,
    );
    expect(overPoolDraw.allowed).toBe(false);
    expect(overPoolDraw.blockingCodes).toContain(
      'INSUFFICIENT_REALIZED_PROFIT_POOL',
    );

    // Scenario with huge profit pool (because tranche was $0 / low bank after paying expenses)
    // where bank cash headroom < requested bank disbursement -> blocked by INSUFFICIENT_LIQUID_RESERVE_CAPACITY
    const lowBankReserveInput = makeBaseSnapshotInput({
      tranches: [
        {
          trancheCode: 'TRANCHE_1_LAUNCH',
          principalCadMinor: 0,
          unlocked: true,
        },
      ],
      sales: [
        {
          id: 's-profit-in-bank',
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'FB_MARKETPLACE_LOCAL',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
          subtotalMinor: 800_000,
          gstHstTaxCadMinor: 0,
          provincialTaxCadMinor: 0,
          taxOrVatMinor: 0,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          grossCollectedMinor: 800_000,
          netRealizedCadMinor: 800_000,
          bankClearedCadMinor: 800_000,
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
          cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
          bankSettledAt: '2026-04-06T12:00:00Z',
          bankDepositReference: 'INT-2',
          isVoidedOrReversed: false,
        },
      ],
    });
    // Profit pool is 800,000, bank is 800,000, reserve floor is 750,000 -> bank draw max = 50,000
    const reserveLockedDraw = evaluatePartnerProfitDraw(
      {
        organizationId: ORG_SALVAGE,
        targetUserId: 'cfo-1',
        targetUserRole: 'ARCHITECT_CFO',
        requestedDrawCadMinor: 50_001,
        snapshotInput: lowBankReserveInput,
        actor: { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' },
        cfoOverride: {
          approved: true,
          approvedById: 'cfo-1',
          approverRole: 'ARCHITECT_CFO',
          reasonNote: 'Attempt to breach bank reserve via CFO override',
        },
      },
      policy,
    );
    expect(reserveLockedDraw.allowed).toBe(false);
    expect(reserveLockedDraw.overrideApplied).toBe(false);
    expect(reserveLockedDraw.blockingCodes).toContain(
      'INSUFFICIENT_LIQUID_RESERVE_CAPACITY',
    );
  });
});
