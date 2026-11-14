import { describe, expect, it } from 'vitest';
import type {
  CashCustodyState,
  PaymentSettlementState,
} from '@prisma/client';
import {
  DomainRuleError,
  type DomainRuleErrorCode,
} from '../domain-primitives';
import {
  computeDriveOnTimers,
  evaluateExportFitmentEligibility,
  evaluateExportSealEligibility,
  evaluateLocationCustodyCheck,
  evaluateRegulatoryComplianceCheck,
  recommendDomesticChannels,
  validateAraGrade,
  validateDamageCode,
  validatePartTransition,
  validatePaymentSettlementTransition,
  validateVehicleLifecycleTransition,
  type PartStateSnapshot,
  type PaymentSettlementSnapshot,
  type RegulatoryWarningCode,
} from '../part-state-machine';
import {
  computeGradeAdjustedMarketValueCadMinor,
  computeProvisionalCostBasis,
  trueUpDonorCostBasis,
} from '../donor-cost-allocator';
import type { PricingAndCompliancePolicy } from '../../ports';

const BASE_POLICY_SLICE: Pick<
  PricingAndCompliancePolicy,
  'complianceThresholds' | 'domesticSyndication' | 'operationalGates'
> = {
  complianceThresholds: {
    trinidadFiuCddThresholdTtdMinor: 5_000_000,
    trinidadFiuLargeCashReportTtdMinor: 9_000_000,
    trinidadDepositInsuranceCapTtdMinor: 20_000_000,
    trinidadDepositAlertThresholdTtdMinor: 18_000_000,
    cbsaCersValueThresholdCadMinor: 200_000,
    cbsaMarineCutoffHours: 48,
    driveOnReinspectionWindowDays: 10,
    safetyStandardsCertMaxDays: 36,
    easrRegistrationNumber: null,
    easrActiveElvThreshold: 2,
    minRecordRetentionYears: 7,
  },
  domesticSyndication: {
    publicPickupLocationLabel: 'Ottawa South / Hwy 416 Corridor',
    ebayShipFromCity: 'Kemptville, ON',
    ebayShipFromPostalCode: 'K0G 1J0',
    heavyLocalOnlyThresholdKg: 15.0,
    ebaySiteId: 'Canada',
    ebayCurrency: 'CAD',
  },
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
      tranches: [],
    },
    dealDisciplineGate: {
      maxDonorDismantleLandedCadMinor: 320_000,
      enableHighEndRebuildLane: false,
    },
    locationCapacityGate: {
      enforcementMode: 'HARD_BLOCK',
    },
  },
};

function makeShelvedAvailablePart(
  overrides?: Partial<PartStateSnapshot>,
): PartStateSnapshot {
  return {
    custodyState: 'SHELVED_ORIGIN_CONTAINER',
    availabilityState: 'AVAILABLE',
    ebaySyncState: 'NOT_LISTED',
    classifiedsSyncState: 'NOT_POSTED',
    complianceState: 'CLEARED_FOR_SALE',
    ...overrides,
  };
}

describe('Part 5-axis state machine', () => {
  it('enforces two-step eBay CSV export and listing confirmation while preserving untouched axes', () => {
    const initial = makeShelvedAvailablePart({
      classifiedsSyncState: 'POSTED_LIVE',
    });

    // Direct NOT_LISTED -> SYNDICATED_LIVE is denied
    expect(() =>
      validatePartTransition(initial, 'CONFIRM_EBAY_LIVE', {
        ebayListingId: '1234567890',
        tdgHazmatCode: 'NONE',
        weightKg: 3.2,
      }),
    ).toThrowError(DomainRuleError);

    // Step 1: Export CSV -> CSV_EXPORTED_PENDING_CONFIRMATION
    const exported = validatePartTransition(initial, 'EXPORT_EBAY_CSV', {
      tdgHazmatCode: 'NONE',
      weightKg: 3.2,
    });
    expect(exported.nextState).toEqual({
      custodyState: 'SHELVED_ORIGIN_CONTAINER',
      availabilityState: 'AVAILABLE',
      ebaySyncState: 'CSV_EXPORTED_PENDING_CONFIRMATION',
      classifiedsSyncState: 'POSTED_LIVE',
      complianceState: 'CLEARED_FOR_SALE',
    });

    // Step 2: Blank or null ebayListingId fails confirmation
    expect(() =>
      validatePartTransition(exported.nextState, 'CONFIRM_EBAY_LIVE', {
        ebayListingId: '   ',
      }),
    ).toThrowError(DomainRuleError);
    expect(() =>
      validatePartTransition(exported.nextState, 'CONFIRM_EBAY_LIVE', {
        ebayListingId: null,
      }),
    ).toThrowError(DomainRuleError);

    // Step 2: Valid ebayListingId transitions to SYNDICATED_LIVE
    const live = validatePartTransition(
      exported.nextState,
      'CONFIRM_EBAY_LIVE',
      {
        ebayListingId: '  EBAY-991122  ',
      },
    );
    expect(live.nextState).toEqual({
      custodyState: 'SHELVED_ORIGIN_CONTAINER',
      availabilityState: 'AVAILABLE',
      ebaySyncState: 'SYNDICATED_LIVE',
      classifiedsSyncState: 'POSTED_LIVE',
      complianceState: 'CLEARED_FOR_SALE',
    });

    // Re-export after DELISTED repeats two-step confirmation
    const delisted = makeShelvedAvailablePart({ ebaySyncState: 'DELISTED' });
    expect(() =>
      validatePartTransition(delisted, 'CONFIRM_EBAY_LIVE', {
        ebayListingId: 'EBAY-NEW',
      }),
    ).toThrowError(DomainRuleError);
    const reExported = validatePartTransition(delisted, 'EXPORT_EBAY_CSV', {
      tdgHazmatCode: 'NONE',
      weightKg: 2.0,
    });
    expect(reExported.nextState.ebaySyncState).toBe(
      'CSV_EXPORTED_PENDING_CONFIRMATION',
    );
  });

  it('requires Delist on eBay First attestation for live local checkout and transitions eBay + classifieds axes', () => {
    const livePart = makeShelvedAvailablePart({
      ebaySyncState: 'SYNDICATED_LIVE',
      classifiedsSyncState: 'POSTED_LIVE',
    });

    expect(() =>
      validatePartTransition(livePart, 'CHECKOUT_DOMESTIC', {
        ebayDelistAttested: false,
      }),
    ).toThrowError(DomainRuleError);

    const sold = validatePartTransition(livePart, 'CHECKOUT_DOMESTIC', {
      ebayDelistAttested: true,
    });
    expect(sold.nextState).toEqual({
      custodyState: 'SOLD_AND_RELEASED',
      availabilityState: 'PAID_SETTLED',
      ebaySyncState: 'DELIST_PENDING',
      classifiedsSyncState: 'DELIST_REQUIRED',
      complianceState: 'CLEARED_FOR_SALE',
    });
  });

  it('enforces anti-part-swap return QC hold across all modes and requires operator QC clearance or scrap', () => {
    const sold = makeShelvedAvailablePart({
      custodyState: 'SOLD_AND_RELEASED',
      availabilityState: 'PAID_SETTLED',
      ebaySyncState: 'DELIST_PENDING',
      classifiedsSyncState: 'POSTED_LIVE',
    });

    const returned = validatePartTransition(sold, 'RETURN_FROM_BUYER', {});
    expect(returned.nextState).toEqual({
      custodyState: 'RESTOCKED_QC_HOLD',
      availabilityState: 'RETURNED_QC_HOLD',
      ebaySyncState: 'DELISTED',
      classifiedsSyncState: 'DELIST_REQUIRED',
      complianceState: 'NEEDS_HUMAN_REVIEW',
    });

    // Held part cannot be checked out, exported to CSV, posted to classifieds, or directly shelved
    for (const blockedEvent of [
      'CHECKOUT_DOMESTIC',
      'EXPORT_EBAY_CSV',
      'POST_CLASSIFIEDS',
      'SHELVE_IN_ORIGIN_CONTAINER',
      'CLEAR_FOR_SALE',
    ] as const) {
      expect(() =>
        validatePartTransition(returned.nextState, blockedEvent, {
          tdgHazmatCode: 'NONE',
          weightKg: 2.0,
          originBinBarcode: 'KEMP-C01-R01-S01-B01',
          complianceEnforcementMode: 'WARN_ONLY',
        }),
      ).toThrowError(DomainRuleError);
    }

    // Passing QC without bin evidence fails
    expect(() =>
      validatePartTransition(returned.nextState, 'CLEAR_RETURN_QC', {
        qcPassed: true,
        originBinBarcode: '   ',
      }),
    ).toThrowError(DomainRuleError);

    // Passing QC with bin evidence clears back to shelved + available + cleared, keeping eBay DELISTED
    const cleared = validatePartTransition(
      returned.nextState,
      'CLEAR_RETURN_QC',
      {
        qcPassed: true,
        originBinBarcode: 'KEMP-C01-R01-S01-B01',
        tdgHazmatCode: 'NONE',
      },
    );
    expect(cleared.nextState).toEqual({
      custodyState: 'SHELVED_ORIGIN_CONTAINER',
      availabilityState: 'AVAILABLE',
      ebaySyncState: 'DELISTED',
      classifiedsSyncState: 'DELIST_REQUIRED',
      complianceState: 'CLEARED_FOR_SALE',
    });

    // Failed QC scraps part without inventing a nonexistent Availability enum
    const scrapped = validatePartTransition(
      returned.nextState,
      'FAIL_RETURN_QC_SCRAP',
      { qcPassed: false },
    );
    expect(scrapped.nextState).toEqual({
      custodyState: 'SCRAPPED_OR_DAMAGED',
      availabilityState: 'RETURNED_QC_HOLD',
      ebaySyncState: 'DELISTED',
      classifiedsSyncState: 'DELIST_REQUIRED',
      complianceState: 'NEEDS_HUMAN_REVIEW',
    });
  });

  it('enforces export lock confirmation, domestic commitment race, and pallet seal eligibility', () => {
    const live = makeShelvedAvailablePart({ ebaySyncState: 'SYNDICATED_LIVE' });
    const lockPending = validatePartTransition(live, 'REQUEST_EXPORT_LOCK', {});
    expect(lockPending.nextState.ebaySyncState).toBe('EXPORT_LOCK_PENDING');

    // Seal guard rejects EXPORT_LOCK_PENDING and STRIPPED_RAW_OFFLINE
    const pendingSeal = evaluateExportSealEligibility([
      { partId: 'p-1', state: lockPending.nextState },
    ]);
    expect(pendingSeal.allowed).toBe(false);
    expect(pendingSeal.blockingCodes).toContain('EXPORT_LOCK_NOT_CONFIRMED');

    const rawOfflineSeal = evaluateExportSealEligibility([
      {
        partId: 'p-2',
        state: makeShelvedAvailablePart({
          custodyState: 'STRIPPED_RAW_OFFLINE',
        }),
      },
    ]);
    expect(rawOfflineSeal.allowed).toBe(false);

    // Race condition: eBay order webhook arrives before lock confirms
    const raceCommitted = validatePartTransition(
      lockPending.nextState,
      'EBAY_ORDER_COMMITTED_DURING_EXPORT_LOCK',
      {},
    );
    expect(raceCommitted.nextState.availabilityState).toBe(
      'COMMITTED_DOMESTIC_SALE',
    );
    expect(
      evaluateExportSealEligibility([
        { partId: 'p-1', state: raceCommitted.nextState },
      ]).allowed,
    ).toBe(false);

    // Clean lock confirmation allows loading & sealing
    const lockConfirmed = validatePartTransition(
      lockPending.nextState,
      'CONFIRM_EXPORT_LOCK',
      {},
    );
    expect(lockConfirmed.nextState.ebaySyncState).toBe('EXPORT_LOCK_CONFIRMED');
    const onPallet = validatePartTransition(
      lockConfirmed.nextState,
      'LOAD_ONTO_EXPORT_PALLET',
      {
        steeringSideCompatibility: 'UNIVERSAL',
        oemFitmentVerified: true,
        destinationDriveSide: 'RHD',
      },
    );
    expect(onPallet.nextState.custodyState).toBe('ON_EXPORT_PALLET');
    expect(
      evaluateExportSealEligibility([
        { partId: 'p-1', state: onPallet.nextState },
      ]).allowed,
    ).toBe(true);
  });
});

describe('PaymentSettlementState & CashCustodyState transition matrix', () => {
  function makeSettlement(
    overrides?: Partial<PaymentSettlementSnapshot>,
  ): PaymentSettlementSnapshot {
    return {
      paymentSettlementState: 'SALE_RECORDED',
      cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
      paymentMethod: 'INTERAC_ETRANSFER',
      paymentConfirmedAt: null,
      bankSettledAt: null,
      bankDepositReference: null,
      isVoidedOrReversed: false,
      voidReason: null,
      ...overrides,
    };
  }

  const validConfirmed: PaymentSettlementSnapshot = {
    paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
    cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
    paymentMethod: 'INTERAC_ETRANSFER',
    paymentConfirmedAt: '2026-11-10T12:00:00Z',
    bankSettledAt: '2026-11-11T15:00:00Z',
    bankDepositReference: 'RBC-DEP-9901',
    isVoidedOrReversed: false,
    voidReason: null,
  };

  it('allows all required forward edges with valid custody and evidence', () => {
    const saleRecorded = makeSettlement();

    const initiated = validatePaymentSettlementTransition(saleRecorded, {
      ...saleRecorded,
      paymentSettlementState: 'PAYMENT_INITIATED',
    });
    expect(initiated.paymentSettlementState).toBe('PAYMENT_INITIATED');

    const cashConfirmed = validatePaymentSettlementTransition(saleRecorded, {
      ...saleRecorded,
      paymentSettlementState: 'PAYMENT_CONFIRMED',
      cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
      paymentMethod: 'CASH',
      paymentConfirmedAt: '2026-11-10T12:00:00Z',
    });
    expect(cashConfirmed.cashCustodyState).toBe('HELD_IN_OPERATOR_FLOAT');

    // Cash sweep to corporate bank
    const cashSweptToBank = validatePaymentSettlementTransition(cashConfirmed, {
      ...cashConfirmed,
      paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
      cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
      bankSettledAt: '2026-11-12T10:00:00Z',
      bankDepositReference: 'DROP-ONT-2026-0001',
    });
    expect(cashSweptToBank.paymentSettlementState).toBe(
      'BANK_SETTLEMENT_CONFIRMED',
    );

    const mktPending = validatePaymentSettlementTransition(saleRecorded, {
      ...saleRecorded,
      paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING',
      paymentMethod: 'EBAY_MANAGED_PAYOUT',
    });
    expect(mktPending.paymentSettlementState).toBe('MARKETPLACE_PAYOUT_PENDING');

    const bankPendingFromMkt = validatePaymentSettlementTransition(mktPending, {
      ...mktPending,
      paymentSettlementState: 'BANK_SETTLEMENT_PENDING',
    });
    expect(bankPendingFromMkt.paymentSettlementState).toBe(
      'BANK_SETTLEMENT_PENDING',
    );

    const bankConfirmedFromMkt = validatePaymentSettlementTransition(
      mktPending,
      {
        ...mktPending,
        paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
        bankSettledAt: '2026-11-12T10:00:00Z',
        bankDepositReference: 'EBAY-PAYOUT-7788',
      },
    );
    expect(bankConfirmedFromMkt.cashCustodyState).toBe(
      'SETTLED_ORIGIN_CORP_BANK',
    );

    const bankConfirmedFromPending = validatePaymentSettlementTransition(
      bankPendingFromMkt,
      validConfirmed,
    );
    expect(bankConfirmedFromPending.bankDepositReference).toBe('RBC-DEP-9901');

    // Direct verified bank wire initialization
    const directWire = validatePaymentSettlementTransition(saleRecorded, {
      paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
      cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
      paymentMethod: 'VERIFIED_BANK_WIRE',
      paymentConfirmedAt: '2026-11-10T12:00:00Z',
      bankSettledAt: '2026-11-10T12:05:00Z',
      bankDepositReference: 'WIRE-5501',
      isVoidedOrReversed: false,
      voidReason: null,
    });
    expect(directWire.paymentSettlementState).toBe('BANK_SETTLEMENT_CONFIRMED');

    // Refund from confirmed
    const refunded = validatePaymentSettlementTransition(
      bankConfirmedFromPending,
      {
        ...bankConfirmedFromPending,
        paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
        isVoidedOrReversed: true,
        voidReason: 'Customer returned part in good condition',
      },
    );
    expect(refunded.paymentSettlementState).toBe('REFUNDED_OR_CHARGED_BACK');
  });

  it('forbids shortcuts to BANK_SETTLEMENT_CONFIRMED without reference, illegal custody pairings, and exits from refund', () => {
    const saleRecorded = makeSettlement();

    // Generic SALE_RECORDED -> BANK_SETTLEMENT_CONFIRMED without VERIFIED_BANK_WIRE is forbidden
    expect(() =>
      validatePaymentSettlementTransition(saleRecorded, {
        ...validConfirmed,
        paymentMethod: 'INTERAC_ETRANSFER',
      }),
    ).toThrowError(DomainRuleError);

    // Blank bankDepositReference fails
    expect(() =>
      validatePaymentSettlementTransition(
        makeSettlement({ paymentSettlementState: 'BANK_SETTLEMENT_PENDING' }),
        {
          ...validConfirmed,
          bankDepositReference: '   ',
        },
      ),
    ).toThrowError(DomainRuleError);

    // Missing bankSettledAt fails
    expect(() =>
      validatePaymentSettlementTransition(
        makeSettlement({ paymentSettlementState: 'BANK_SETTLEMENT_PENDING' }),
        {
          ...validConfirmed,
          bankSettledAt: null,
        },
      ),
    ).toThrowError(DomainRuleError);

    // PENDING_EXTERNAL_RECEIVABLE cannot pair with BANK_SETTLEMENT_CONFIRMED
    expect(() =>
      validatePaymentSettlementTransition(
        makeSettlement({ paymentSettlementState: 'BANK_SETTLEMENT_PENDING' }),
        {
          ...validConfirmed,
          cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE' as CashCustodyState,
        },
      ),
    ).toThrowError(DomainRuleError);

    // SETTLED_ORIGIN_CORP_BANK cannot pair with MARKETPLACE_PAYOUT_PENDING
    expect(() =>
      validatePaymentSettlementTransition(saleRecorded, {
        ...saleRecorded,
        paymentSettlementState:
          'MARKETPLACE_PAYOUT_PENDING' as PaymentSettlementState,
        cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
      }),
    ).toThrowError(DomainRuleError);

    // PAYMENT_CONFIRMED requires paymentConfirmedAt
    expect(() =>
      validatePaymentSettlementTransition(saleRecorded, {
        ...saleRecorded,
        paymentSettlementState: 'PAYMENT_CONFIRMED',
        cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
        paymentConfirmedAt: null,
      }),
    ).toThrowError(DomainRuleError);

    // REFUNDED_OR_CHARGED_BACK requires voidReason and is terminal
    expect(() =>
      validatePaymentSettlementTransition(validConfirmed, {
        ...validConfirmed,
        paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
        isVoidedOrReversed: true,
        voidReason: '  ',
      }),
    ).toThrowError(DomainRuleError);

    const terminalRefund = makeSettlement({
      paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
      isVoidedOrReversed: true,
      voidReason: 'Chargeback dispute lost',
    });
    expect(() =>
      validatePaymentSettlementTransition(terminalRefund, validConfirmed),
    ).toThrowError(DomainRuleError);
  });
});

describe('Vehicle lifecycle, regulatory compliance modes, channel routing, ARA/damage, DriveON timers', () => {
  it('enforces lane-appropriate vehicle branches, shop-to-dismantling diversion, non-auto bypass, and hulk clearance', () => {
    const res1 = validateVehicleLifecycleTransition(
      'STAGED_ONTARIO_YARD',
      'IN_RAMSAYVILLE_SHOP',
      {
        assetCategory: 'AUTOMOBILE',
        operationalLane: 'QUICK_TURN_BEATER',
      },
    );
    expect(res1.nextState).toBe('IN_RAMSAYVILLE_SHOP');

    // Shop-to-dismantling diversion allowed
    expect(
      validateVehicleLifecycleTransition(
        'IN_RAMSAYVILLE_SHOP',
        'DISMANTLING_IN_PROGRESS',
        {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'QUICK_TURN_BEATER',
        },
      ).nextState,
    ).toBe('DISMANTLING_IN_PROGRESS');

    // Non-automobile bypasses PENDING_INSPECTION_CERT
    expect(
      validateVehicleLifecycleTransition(
        'IN_RAMSAYVILLE_SHOP',
        'READY_FOR_RETAIL_SALE',
        {
          assetCategory: 'WATERCRAFT',
          operationalLane: 'QUICK_TURN_BEATER',
        },
      ).nextState,
    ).toBe('READY_FOR_RETAIL_SALE');

    // Automobile cannot skip PENDING_INSPECTION_CERT
    expect(() =>
      validateVehicleLifecycleTransition(
        'IN_RAMSAYVILLE_SHOP',
        'READY_FOR_RETAIL_SALE',
        {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'QUICK_TURN_BEATER',
        },
      ),
    ).toThrowError(DomainRuleError);

    // Hulk clearance requires weigh ticket and checks cat disposition by compliance mode
    expect(() =>
      validateVehicleLifecycleTransition(
        'HULK_AWAITING_SCRAP',
        'SCRAPPED_METAL_CLEARED',
        {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
          scrapMetalTicketKey: ' ',
          catalyticConverterDisposition: 'LOGGED_SCRAP_SALE',
          hasCatalyticConverterScrapLog: true,
        },
      ),
    ).toThrowError(DomainRuleError);

    const warnClearance = validateVehicleLifecycleTransition(
      'HULK_AWAITING_SCRAP',
      'SCRAPPED_METAL_CLEARED',
      {
        assetCategory: 'AUTOMOBILE',
        operationalLane: 'DISMANTLE_AND_EXPORT',
        scrapMetalTicketKey: 'org/tickets/shell-1.jpg',
        catalyticConverterDisposition: 'PRESENT_AT_INTAKE',
        hasCatalyticConverterScrapLog: false,
        complianceEnforcementMode: 'WARN_ONLY',
      },
    );
    expect(warnClearance.nextState).toBe('SCRAPPED_METAL_CLEARED');
    expect(warnClearance.warnings).toContain('UNRECONCILED_CATALYTIC_CONVERTER');

    expect(() =>
      validateVehicleLifecycleTransition(
        'HULK_AWAITING_SCRAP',
        'SCRAPPED_METAL_CLEARED',
        {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
          scrapMetalTicketKey: 'org/tickets/shell-1.jpg',
          catalyticConverterDisposition: 'PRESENT_AT_INTAKE',
          hasCatalyticConverterScrapLog: false,
          complianceEnforcementMode: 'STRICT_BLOCK',
        },
      ),
    ).toThrowError(DomainRuleError);

    // Terminal state exit rejected
    expect(() =>
      validateVehicleLifecycleTransition(
        'SCRAPPED_METAL_CLEARED',
        'HULK_AWAITING_SCRAP',
        {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
        },
      ),
    ).toThrowError(DomainRuleError);
  });

  it('evaluates all 6 regulatory warning codes across WARN_ONLY and STRICT_BLOCK', () => {
    const matrix: Array<[RegulatoryWarningCode, DomainRuleErrorCode]> = [
      ['COMPLIANCE_WARNING_UNDRAINED_FARM', 'ENVIRONMENTAL_ZONING_VIOLATION'],
      ['PROPOSED_INACTIVE_LOCATION_WARNING', 'LOCATION_PROPOSED_INACTIVE'],
      ['MISSING_EASR_REGISTRATION_WARNING', 'EASR_REGISTRATION_REQUIRED'],
      ['DRIVEON_SAFETY_CERT_WARNING', 'EXPIRED_OR_MISSING_SAFETY_CERT'],
      ['MISSING_HTA_S60_DOCS', 'MISSING_HTA_S60_DOCS'],
      ['UNRECONCILED_CATALYTIC_CONVERTER', 'UNRECONCILED_CATALYTIC_CONVERTER'],
    ];

    for (const [warningCode, strictCode] of matrix) {
      const warnResult = evaluateRegulatoryComplianceCheck(
        'WARN_ONLY',
        warningCode,
      );
      expect(warnResult.allowed).toBe(true);
      expect(warnResult.warnings).toEqual([warningCode]);
      expect(warnResult.blockingCodes).toEqual([]);

      const strictResult = evaluateRegulatoryComplianceCheck(
        'STRICT_BLOCK',
        warningCode,
      );
      expect(strictResult.allowed).toBe(false);
      expect(strictResult.warnings).toEqual([]);
      expect(strictResult.blockingCodes).toEqual([strictCode]);
    }
  });

  it('enforces hard cross-org and dormant location blocks regardless of WARN_ONLY', () => {
    const crossOrg = evaluateLocationCustodyCheck({
      entityOrganizationId: 'org-salvage',
      entityDomain: 'SALVAGE',
      locationOrganizationId: 'org-cannabis',
      locationAllowedOrgType: 'CANNABIS_NURSERY_AND_PROCESSING',
      locationOperationalStatus: 'ACTIVE',
      allowsWholeVehicleDismantling: false,
      requiresFluidDrainageCheck: false,
      fluidsDrainedAt: null,
      complianceEnforcementMode: 'WARN_ONLY',
    });
    expect(crossOrg.allowed).toBe(false);
    expect(crossOrg.blockingCodes).toContain('SITE_ZONING_VIOLATION');

    const dormant = evaluateLocationCustodyCheck({
      entityOrganizationId: 'org-salvage',
      entityDomain: 'SALVAGE',
      locationOrganizationId: 'org-salvage',
      locationAllowedOrgType: 'SALVAGE_AND_EXPORT',
      locationOperationalStatus: 'DORMANT_FUTURE',
      allowsWholeVehicleDismantling: false,
      requiresFluidDrainageCheck: false,
      fluidsDrainedAt: null,
      complianceEnforcementMode: 'WARN_ONLY',
    });
    expect(dormant.allowed).toBe(false);
    expect(dormant.blockingCodes).toContain('LOCATION_DORMANT_FUTURE');

    const proposedWarn = evaluateLocationCustodyCheck({
      entityOrganizationId: 'org-salvage',
      entityDomain: 'SALVAGE',
      locationOrganizationId: 'org-salvage',
      locationAllowedOrgType: 'SALVAGE_AND_EXPORT',
      locationOperationalStatus: 'PROPOSED_INACTIVE',
      allowsWholeVehicleDismantling: true,
      requiresFluidDrainageCheck: true,
      fluidsDrainedAt: null,
      complianceEnforcementMode: 'WARN_ONLY',
    });
    expect(proposedWarn.allowed).toBe(true);
    expect(proposedWarn.warnings).toEqual(['PROPOSED_INACTIVE_LOCATION_WARNING']);
  });

  it('enforces RULE-MKT-001 weight threshold (< 15.0 kg) and TDG hazmat separation + RULE-MKT-002 labels', () => {
    const light = recommendDomesticChannels(
      {
        weightKg: 14.99,
        tdgHazmatCode: 'NONE',
        complianceState: 'CLEARED_FOR_SALE',
      },
      BASE_POLICY_SLICE,
    );
    expect(light.isEbayParcelEligible).toBe(true);
    expect(light.recommendedPrimaryChannel).toBe('EBAY_MOTORS_SHIPPED');
    expect(light.ebayShipFromCity).toBe('Kemptville, ON');
    expect(light.ebayShipFromPostalCode).toBe('K0G 1J0');
    expect(light.publicPickupLocationLabel).toBe(
      'Ottawa South / Hwy 416 Corridor',
    );

    const exact15 = recommendDomesticChannels(
      {
        weightKg: 15.0,
        tdgHazmatCode: 'NONE',
        complianceState: 'CLEARED_FOR_SALE',
      },
      BASE_POLICY_SLICE,
    );
    expect(exact15.isEbayParcelEligible).toBe(false);
    expect(exact15.isLocalSaleEligible).toBe(true);
    expect(exact15.recommendedPrimaryChannel).toBe('FB_MARKETPLACE_LOCAL');

    // Non-quarantined batteries route local only
    for (const batteryCode of [
      'UN2794_WET_BATTERY',
      'UN3480_LITHIUM_BATTERY',
    ] as const) {
      const battery = recommendDomesticChannels(
        {
          weightKg: 5.0,
          tdgHazmatCode: batteryCode,
          complianceState: 'CLEARED_FOR_SALE',
        },
        BASE_POLICY_SLICE,
      );
      expect(battery.isEbayParcelEligible).toBe(false);
      expect(battery.isLocalSaleEligible).toBe(true);
      expect(battery.recommendedPrimaryChannel).toBe('FB_MARKETPLACE_LOCAL');
    }

    // Airbags / pyrotechnics are never recommended as saleable local inventory
    for (const pyroCode of ['UN3268_AIRBAG', 'UN0503_PYROTECHNIC'] as const) {
      const pyro = recommendDomesticChannels(
        {
          weightKg: 2.0,
          tdgHazmatCode: pyroCode,
          complianceState: 'QUARANTINED_RECALL_OR_DG',
        },
        BASE_POLICY_SLICE,
      );
      expect(pyro.isEbayParcelEligible).toBe(false);
      expect(pyro.isLocalSaleEligible).toBe(false);
      expect(pyro.recommendedPrimaryChannel).toBeNull();
    }
  });

  it('enforces RULE-FIT-001/002 export fitment rules and ARA grade/damage validation', () => {
    expect(
      evaluateExportFitmentEligibility({
        steeringSideCompatibility: 'UNIVERSAL',
        oemFitmentVerified: false,
        destinationDriveSide: 'RHD',
        hasVerifiedBuyerWishListException: false,
      }).allowed,
    ).toBe(false);

    expect(
      evaluateExportFitmentEligibility({
        steeringSideCompatibility: 'LHD_ONLY',
        oemFitmentVerified: true,
        destinationDriveSide: 'RHD',
        hasVerifiedBuyerWishListException: false,
      }).allowed,
    ).toBe(false);

    const wishListAllowed = evaluateExportFitmentEligibility({
      steeringSideCompatibility: 'LHD_ONLY',
      oemFitmentVerified: true,
      destinationDriveSide: 'RHD',
      hasVerifiedBuyerWishListException: true,
    });
    expect(wishListAllowed.allowed).toBe(true);
    expect(wishListAllowed.wishListExceptionApplied).toBe(true);

    for (const g of [
      'GRADE_A',
      'GRADE_B1',
      'GRADE_B2',
      'GRADE_B3',
      'GRADE_C',
      'GRADE_X',
    ] as const) {
      expect(validateAraGrade(g)).toBe(g);
    }
    expect(() => validateAraGrade('GRADE_Z')).toThrowError(DomainRuleError);

    expect(validateDamageCode('000')).toBe('000');
    expect(validateDamageCode('5D2')).toBe('5D2');
    expect(validateDamageCode('9T9')).toBe('9T9');
    for (const bad of ['0D1', '1Z1', '1D0', '001', '5D10', '']) {
      expect(() => validateDamageCode(bad)).toThrowError(DomainRuleError);
    }
  });

  it('computes UTC DriveON 10-day and 36-day timers accurately across exact expiry and DST-adjacent timestamps', () => {
    const timers = computeDriveOnTimers(
      {
        assetCategory: 'AUTOMOBILE',
        driveOnInitialFailAt: '2026-03-01T12:00:00.000Z',
        driveOnSscIssuedAt: '2026-03-05T12:00:00.000Z',
        now: '2026-03-11T12:00:00.000Z', // Exactly 10 UTC days after fail
      },
      BASE_POLICY_SLICE,
    );
    expect(timers.applicable).toBe(true);
    expect(timers.driveOnReinspectionDeadlineAt?.toISOString()).toBe(
      '2026-03-11T12:00:00.000Z',
    );
    expect(timers.isReinspectionWindowExpired).toBe(false);
    expect(timers.driveOnSscExpiresAt?.toISOString()).toBe(
      '2026-04-10T12:00:00.000Z',
    );
    expect(timers.isSscMissingOrExpired).toBe(false);

    // 1 ms past expiry -> expired
    const expiredTimers = computeDriveOnTimers(
      {
        assetCategory: 'AUTOMOBILE',
        driveOnInitialFailAt: '2026-03-01T12:00:00.000Z',
        driveOnSscIssuedAt: '2026-03-05T12:00:00.000Z',
        now: '2026-04-10T12:00:00.001Z',
      },
      BASE_POLICY_SLICE,
    );
    expect(expiredTimers.isReinspectionWindowExpired).toBe(true);
    expect(expiredTimers.isSscMissingOrExpired).toBe(true);

    // Non-automobile bypasses DriveON timers
    const boat = computeDriveOnTimers(
      {
        assetCategory: 'WATERCRAFT',
        driveOnInitialFailAt: null,
        driveOnSscIssuedAt: null,
        now: '2026-04-10T12:00:00.001Z',
      },
      BASE_POLICY_SLICE,
    );
    expect(boat.applicable).toBe(false);
    expect(boat.isSscMissingOrExpired).toBe(false);
  });
});

describe('Two-stage donor cost allocation', () => {
  it('computes Stage 1 provisional cost basis across both denominator branches and ARA grade multipliers', () => {
    const araPolicy = {
      araGradeMultipliers: {
        GRADE_A: 1.05,
        GRADE_B1: 1.0,
        GRADE_B2: 0.95,
        GRADE_B3: 0.85,
        GRADE_C: 0.7,
        GRADE_X: 0.8,
      },
    };
    expect(
      computeGradeAdjustedMarketValueCadMinor(20_000, 'GRADE_A', araPolicy),
    ).toBe(21_000);
    expect(
      computeGradeAdjustedMarketValueCadMinor(20_000, 'GRADE_C', araPolicy),
    ).toBe(14_000);

    // Branch 1: targetGrossRealizationMinor > sum(stripped market values)
    const targetBranch = computeProvisionalCostBasis({
      organizationId: 'org-salvage',
      donorVehicleId: 'veh-1',
      actualPurchasePriceCadMinor: 200_000,
      loggedDirectExpensesCadMinor: 50_000,
      targetGrossRealizationMinor: 500_000,
      strippedParts: [
        { partId: 'p-1', gradeAdjustedMarketValueCadMinor: 100_000 },
        { partId: 'p-2', gradeAdjustedMarketValueCadMinor: 50_000 },
      ],
    });
    expect(targetBranch.totalAcquisitionAndStripCostCadMinor).toBe(250_000);
    expect(targetBranch.denominatorCadMinor).toBe(500_000);
    expect(targetBranch.allocations).toEqual([
      { partId: 'p-1', allocatedCostBasisCadMinor: 50_000 },
      { partId: 'p-2', allocatedCostBasisCadMinor: 25_000 },
    ]);

    // Branch 2: sum(stripped market values) > targetGrossRealizationMinor
    const strippedBranch = computeProvisionalCostBasis({
      organizationId: 'org-salvage',
      donorVehicleId: 'veh-1',
      actualPurchasePriceCadMinor: 200_000,
      loggedDirectExpensesCadMinor: 50_000,
      targetGrossRealizationMinor: 300_000,
      strippedParts: [
        { partId: 'p-1', gradeAdjustedMarketValueCadMinor: 300_000 },
        { partId: 'p-2', gradeAdjustedMarketValueCadMinor: 200_000 },
      ],
    });
    expect(strippedBranch.denominatorCadMinor).toBe(500_000);
    expect(strippedBranch.allocations).toEqual([
      { partId: 'p-1', allocatedCostBasisCadMinor: 150_000 },
      { partId: 'p-2', allocatedCostBasisCadMinor: 100_000 },
    ]);

    // Zero denominator throws
    expect(() =>
      computeProvisionalCostBasis({
        organizationId: 'org-salvage',
        donorVehicleId: 'veh-1',
        actualPurchasePriceCadMinor: 100_000,
        loggedDirectExpensesCadMinor: 0,
        targetGrossRealizationMinor: 0,
        strippedParts: [
          { partId: 'p-1', gradeAdjustedMarketValueCadMinor: 0 },
        ],
      }),
    ).toThrowError(DomainRuleError);
  });

  it('performs Stage 2 incremental and final 5-stream scrap true-up with exact cent reconciliation and deterministic tie-breaking', () => {
    const frozenInput = Object.freeze({
      organizationId: 'org-salvage',
      donorVehicleId: 'veh-1',
      actualPurchasePriceCadMinor: 220_000,
      loggedDirectExpensesCadMinor: 40_000, // Total = 260,000
      scrapLogs: Object.freeze([
        Object.freeze({
          id: 'scrap-1',
          donorVehicleId: 'veh-1',
          stream: 'CATALYTIC_CONVERTER' as const,
          payoutCadMinor: 25_000,
        }),
        Object.freeze({
          id: 'scrap-2',
          donorVehicleId: 'veh-1',
          stream: 'ALUMINUM_ALLOY_WHEELS' as const,
          payoutCadMinor: 15_000,
        }),
        Object.freeze({
          id: 'scrap-3',
          donorVehicleId: 'veh-1',
          stream: 'COPPER_WIRING_HARNESS' as const,
          payoutCadMinor: 5_000,
        }),
        Object.freeze({
          id: 'scrap-4',
          donorVehicleId: 'veh-1',
          stream: 'ROTORS_AND_BATTERY' as const,
          payoutCadMinor: 4_000,
        }),
        Object.freeze({
          id: 'scrap-5',
          donorVehicleId: 'veh-1',
          stream: 'BARE_STEEL_SHELL' as const,
          payoutCadMinor: 21_000,
        }),
      ]), // Scrap sum = 70,000
      soldParts: Object.freeze([
        Object.freeze({
          partId: 'part-sold-1',
          lockedAllocatedCostBasisCadMinor: 89_999,
        }),
      ]), // Remaining to allocate = 260,000 - 70,000 - 89,999 = 100,001
      unsoldParts: Object.freeze([
        Object.freeze({
          partId: 'part-c',
          gradeAdjustedMarketValueCadMinor: 10_000,
        }),
        Object.freeze({
          partId: 'part-a',
          gradeAdjustedMarketValueCadMinor: 10_000,
        }),
        Object.freeze({
          partId: 'part-b',
          gradeAdjustedMarketValueCadMinor: 10_000,
        }),
      ]),
    });

    // 100,001 / 3 -> 33,333 each + 2 remainder cents -> part-a and part-b get +1
    const res1 = trueUpDonorCostBasis(frozenInput);
    expect(res1.totalAcquisitionAndStripCostCadMinor).toBe(260_000);
    expect(res1.scrapRecoveryCadMinor).toBe(70_000);
    expect(res1.lockedSoldCostBasisCadMinor).toBe(89_999);
    expect(res1.remainingCostBasisToAllocateCadMinor).toBe(100_001);
    expect(res1.reconciledTotalCadMinor).toBe(260_000);
    expect(res1.unsoldAllocations).toEqual([
      { partId: 'part-c', allocatedCostBasisCadMinor: 33_333 },
      { partId: 'part-a', allocatedCostBasisCadMinor: 33_334 },
      { partId: 'part-b', allocatedCostBasisCadMinor: 33_334 },
    ]);

    // Reordered unsold parts produce the exact same per-partId allocation
    const reordered = trueUpDonorCostBasis({
      ...frozenInput,
      unsoldParts: [
        frozenInput.unsoldParts[1]!,
        frozenInput.unsoldParts[2]!,
        frozenInput.unsoldParts[0]!,
      ],
    });
    const map1 = new Map(
      res1.unsoldAllocations.map((a) => [a.partId, a.allocatedCostBasisCadMinor]),
    );
    const map2 = new Map(
      reordered.unsoldAllocations.map((a) => [
        a.partId,
        a.allocatedCostBasisCadMinor,
      ]),
    );
    expect(map2).toEqual(map1);
  });

  it('handles zero residual with no unsold parts and rejects invalid reconciliation states', () => {
    const exactZero = trueUpDonorCostBasis({
      organizationId: 'org-salvage',
      donorVehicleId: 'veh-1',
      actualPurchasePriceCadMinor: 100_000,
      loggedDirectExpensesCadMinor: 0,
      scrapLogs: [
        {
          id: 's-1',
          donorVehicleId: 'veh-1',
          stream: 'BARE_STEEL_SHELL',
          payoutCadMinor: 20_000,
        },
      ],
      soldParts: [
        { partId: 'p-1', lockedAllocatedCostBasisCadMinor: 80_000 },
      ],
      unsoldParts: [],
    });
    expect(exactZero.remainingCostBasisToAllocateCadMinor).toBe(0);
    expect(exactZero.reconciledTotalCadMinor).toBe(100_000);

    // Scrap + locked sold exceeds total outlay
    expect(() =>
      trueUpDonorCostBasis({
        organizationId: 'org-salvage',
        donorVehicleId: 'veh-1',
        actualPurchasePriceCadMinor: 100_000,
        loggedDirectExpensesCadMinor: 0,
        scrapLogs: [
          {
            id: 's-1',
            donorVehicleId: 'veh-1',
            stream: 'BARE_STEEL_SHELL',
            payoutCadMinor: 30_000,
          },
        ],
        soldParts: [
          { partId: 'p-1', lockedAllocatedCostBasisCadMinor: 80_000 },
        ],
        unsoldParts: [
          { partId: 'p-2', gradeAdjustedMarketValueCadMinor: 10_000 },
        ],
      }),
    ).toThrowError(DomainRuleError);

    // Nonzero residual with zero-weight or empty unsold parts
    expect(() =>
      trueUpDonorCostBasis({
        organizationId: 'org-salvage',
        donorVehicleId: 'veh-1',
        actualPurchasePriceCadMinor: 100_000,
        loggedDirectExpensesCadMinor: 0,
        scrapLogs: [],
        soldParts: [],
        unsoldParts: [],
      }),
    ).toThrowError(DomainRuleError);

    // Duplicate scrap ID or wrong donorVehicleId rejected
    expect(() =>
      trueUpDonorCostBasis({
        organizationId: 'org-salvage',
        donorVehicleId: 'veh-1',
        actualPurchasePriceCadMinor: 100_000,
        loggedDirectExpensesCadMinor: 0,
        scrapLogs: [
          {
            id: 's-dup',
            donorVehicleId: 'veh-1',
            stream: 'BARE_STEEL_SHELL',
            payoutCadMinor: 10_000,
          },
          {
            id: 's-dup',
            donorVehicleId: 'veh-1',
            stream: 'CATALYTIC_CONVERTER',
            payoutCadMinor: 10_000,
          },
        ],
        soldParts: [],
        unsoldParts: [
          { partId: 'p-1', gradeAdjustedMarketValueCadMinor: 10_000 },
        ],
      }),
    ).toThrowError(DomainRuleError);
  });
});
