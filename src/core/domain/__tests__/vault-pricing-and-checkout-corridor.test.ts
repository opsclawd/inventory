import { describe, expect, it } from 'vitest';
import type { PricingAndCompliancePolicy } from '../../ports';
import { DomainRuleError } from '../domain-primitives';
import {
  computeBrokerCommissionMinor,
  computeDomesticSaleTaxAndSettlement,
  computeRefundTaxAdjustment,
  computeVaultLandedCostAndFloor,
  evaluateCheckoutPriceFloor,
  evaluatePrepaidExportGate,
  type CheckoutTaxPolicySlice,
} from '../vault-pricing-and-checkout-corridor';

const TAX_AND_PRICING_POLICY: CheckoutTaxPolicySlice &
  Pick<
    PricingAndCompliancePolicy,
    | 'fxRates'
    | 'trinidadImportTax'
    | 'oceanFreight'
    | 'marginsAndCommissions'
    | 'araGradeMultipliers'
    | 'checkoutPolicy'
    | 'exportPolicy'
  > = {
  fxRates: {
    cadToUsdSpot: 0.73,
    usdToTtdOfficialCustoms: 6.78297,
    usdToTtdShadowRepatriation: 7.35,
  },
  trinidadImportTax: {
    isTrinidadEntityVatRegistered: false,
    defaultAutoPartsDutyRate: 0.3,
    customsProcessingFeeRate: 0.03,
    vatRate: 0.125,
  },
  oceanFreight: {
    allocatedLclFreightUsdPerKg: 1.85,
    marineInsuranceRateOfFob: 0.015,
  },
  marginsAndCommissions: {
    targetExportMarkupOnCost: 0.65,
    defaultBrokerCommissionRate: 0.1,
    minBeaterNetProfitCadMinor: 150_000,
    minRebuildNetProfitCadMinor: 700_000,
    minPartOutRoiMultiplier: 2.0,
  },
  araGradeMultipliers: {
    GRADE_A: 1.05,
    GRADE_B1: 1.0,
    GRADE_B2: 0.95,
    GRADE_B3: 0.85,
    GRADE_C: 0.7,
    GRADE_X: 0.8,
  },
  domesticChannelFees: {
    LOCAL_WALK_IN_CASH: 0.0,
    FB_MARKETPLACE_LOCAL: 0.0,
    KIJIJI_LOCAL: 0.0,
    RETAIL_LOT_VEHICLE_SALE: 0.0,
    WHOLESALE_MECHANIC_NETWORK: 0.0,
    EBAY_MOTORS_SHIPPED: 0.1325,
    CAR_PART_WHOLESALE: 0.0,
  },
  domesticTaxPolicy: {
    isGstHstRegistered: true,
    isOntarioEntityHstRegistered: true,
    isOntarioHstRegistered: true,
    isOmvicLicensed: false,
    ontarioHstRate: 0.13,
    canadianProvincialGstHstRatesBps: {
      ON: 1300,
      NS: 1400,
      NB: 1500,
      NL: 1500,
      PE: 1500,
      QC: 500,
      BC: 500,
      AB: 500,
      MB: 500,
      SK: 500,
      YT: 500,
      NT: 500,
      NU: 500,
    },
    provincialPstRegistrations: {
      QC: { registered: false, rate: 0.09975 },
      BC: { registered: false, rate: 0.07 },
      SK: { registered: false, rate: 0.06 },
      MB: { registered: false, rate: 0.07 },
    },
    requireVerifiedTaxInvoiceForFeeItc: true,
    publicPickupCityLabel: 'Ottawa South / Hwy 416 Corridor',
  },
  checkoutPolicy: {
    checkoutStrictnessMode: 'BONDED_VAULT_STRICT',
    vaultAdminDiscountToleranceBps: 800,
    vaultAdminSmallRoundingAllowanceTtdMinor: 10_000,
    vaultAdminMaxDiscountCapTtdMinor: 75_000,
    domesticAdminDiscountToleranceBps: 1000,
  },
  exportPolicy: {
    exportFulfillmentMode: 'PREPAID_ORIGIN_ONLY',
    requireFullPrepaymentBeforeShipmentSeal: true,
  },
};

describe('Jurisdiction-aware CRA GST/HST & eBay Billing Agent (RULE-TAX-HST-01)', () => {
  it('applies Ontario 13% HST on in-Ontario pickup and local delivery regardless of buyer country', () => {
    for (const deliveryMethod of [
      'PICKUP_AT_ORIGIN',
      'LOCAL_DELIVERY_ONTARIO',
    ] as const) {
      const res = computeDomesticSaleTaxAndSettlement(
        {
          channel: 'FB_MARKETPLACE_LOCAL',
          deliveryMethod,
          subtotalMinor: 10_000,
          destinationCountryCode: 'US',
          destinationProvinceOrState: 'NY',
          paymentMethod: 'CASH',
        },
        TAX_AND_PRICING_POLICY,
      );
      expect(res.taxCollectionMode).toBe('DIRECT_SELLER_COLLECTED');
      expect(res.appliedTaxJurisdiction).toBe('CA-ON');
      expect(res.appliedTaxRateBps).toBe(1300);
      expect(res.gstHstTaxCadMinor).toBe(1300);
      expect(res.provincialTaxCadMinor).toBe(0);
      expect(res.taxOrVatMinor).toBe(1300);
      expect(res.grossCollectedMinor).toBe(11_300);
      expect(res.netRealizedCadMinor).toBe(10_000);
      expect(res.paymentSettlementState).toBe('PAYMENT_CONFIRMED');
      expect(res.cashCustodyState).toBe('HELD_IN_OPERATOR_FLOAT');
      expect(res.schemaDeliveryMethod).toBe('IN_PERSON_PICKUP');
    }
  });

  it('applies configured CRA place-of-supply rates across all 13 Canadian provinces/territories', () => {
    const expectedRates: Array<[string, number]> = [
      ['ON', 1300],
      ['NS', 1400],
      ['NB', 1500],
      ['NL', 1500],
      ['PE', 1500],
      ['QC', 500],
      ['BC', 500],
      ['AB', 500],
      ['MB', 500],
      ['SK', 500],
      ['YT', 500],
      ['NT', 500],
      ['NU', 500],
    ];

    for (const [province, expectedBps] of expectedRates) {
      const res = computeDomesticSaleTaxAndSettlement(
        {
          channel: 'WHOLESALE_MECHANIC_NETWORK',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          subtotalMinor: 10_000,
          destinationCountryCode: 'CA',
          destinationProvinceOrState: province,
          paymentMethod: 'INTERAC_ETRANSFER',
        },
        TAX_AND_PRICING_POLICY,
      );
      expect(res.taxCollectionMode).toBe('DIRECT_SELLER_COLLECTED');
      expect(res.appliedTaxJurisdiction).toBe(`CA-${province}`);
      expect(res.appliedTaxRateBps).toBe(expectedBps);
      expect(res.gstHstTaxCadMinor).toBe(expectedBps); // 10,000 * bps / 10,000 = bps
      expect(res.provincialTaxCadMinor).toBe(0);
      expect(res.taxOrVatMinor).toBe(expectedBps);
      expect(res.paymentSettlementState).toBe('BANK_SETTLEMENT_PENDING');
      expect(res.cashCustodyState).toBe('PENDING_EXTERNAL_RECEIVABLE');
      expect(res.schemaDeliveryMethod).toBe('SELLER_SHIPPED');
    }
  });

  it('computes fractional QC QST (9.975%) separately from GST without compressing appliedTaxRateBps', () => {
    const qcPolicy: typeof TAX_AND_PRICING_POLICY = {
      ...TAX_AND_PRICING_POLICY,
      domesticTaxPolicy: {
        ...TAX_AND_PRICING_POLICY.domesticTaxPolicy,
        provincialPstRegistrations: {
          ...TAX_AND_PRICING_POLICY.domesticTaxPolicy.provincialPstRegistrations,
          QC: { registered: true, rate: 0.09975 },
        },
      },
    };
    const res = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'CAR_PART_WHOLESALE',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        subtotalMinor: 10_000,
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'QC',
        paymentMethod: 'VERIFIED_BANK_WIRE',
      },
      qcPolicy,
    );
    expect(res.appliedTaxRateBps).toBe(500);
    expect(res.gstHstTaxCadMinor).toBe(500);
    expect(res.provincialTaxCadMinor).toBe(998); // round half-up(10,000 * 0.09975) = 998
    expect(res.taxOrVatMinor).toBe(1498);
    expect(res.grossCollectedMinor).toBe(11_498);
    // Method name alone never promotes to BANK_SETTLEMENT_CONFIRMED
    expect(res.paymentSettlementState).toBe('BANK_SETTLEMENT_PENDING');
    expect(res.cashCustodyState).toBe('PENDING_EXTERNAL_RECEIVABLE');
  });

  it('validates province, country, and export proof for seller-shipped and zero-rated exports', () => {
    expect(() =>
      computeDomesticSaleTaxAndSettlement(
        {
          channel: 'CAR_PART_WHOLESALE',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          subtotalMinor: 10_000,
          destinationCountryCode: 'CA',
          destinationProvinceOrState: '  ',
          paymentMethod: 'INTERAC_ETRANSFER',
        },
        TAX_AND_PRICING_POLICY,
      ),
    ).toThrowError(DomainRuleError);

    try {
      computeDomesticSaleTaxAndSettlement(
        {
          channel: 'CAR_PART_WHOLESALE',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          subtotalMinor: 10_000,
          destinationCountryCode: 'CA',
          destinationProvinceOrState: null,
          paymentMethod: 'INTERAC_ETRANSFER',
        },
        TAX_AND_PRICING_POLICY,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as DomainRuleError).code).toBe(
        'DESTINATION_PROVINCE_REQUIRED_FOR_TAX',
      );
    }

    expect(() =>
      computeDomesticSaleTaxAndSettlement(
        {
          channel: 'CAR_PART_WHOLESALE',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          subtotalMinor: 10_000,
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ZZ',
          paymentMethod: 'INTERAC_ETRANSFER',
        },
        TAX_AND_PRICING_POLICY,
      ),
    ).toThrowError(DomainRuleError);

    // Missing export proof throws EXPORT_PROOF_REQUIRED_FOR_ZERO_RATING
    try {
      computeDomesticSaleTaxAndSettlement(
        {
          channel: 'CAR_PART_WHOLESALE',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          subtotalMinor: 25_000,
          destinationCountryCode: 'US',
          destinationProvinceOrState: 'FL',
          exportProofStorageKey: ' ',
          paymentMethod: 'INTERAC_ETRANSFER',
        },
        TAX_AND_PRICING_POLICY,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as DomainRuleError).code).toBe(
        'EXPORT_PROOF_REQUIRED_FOR_ZERO_RATING',
      );
    }

    const exportSale = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'CAR_PART_WHOLESALE',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        subtotalMinor: 25_000,
        destinationCountryCode: 'US',
        destinationProvinceOrState: 'FL',
        exportProofStorageKey: 'org/exports/ups-waybill-101.pdf',
        paymentMethod: 'INTERAC_ETRANSFER',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(exportSale.taxCollectionMode).toBe('ZERO_RATED_EXPORT');
    expect(exportSale.appliedTaxJurisdiction).toBe('EXPORT-OUTSIDE-CA');
    expect(exportSale.appliedTaxRateBps).toBe(0);
    expect(exportSale.taxOrVatMinor).toBe(0);
    expect(exportSale.grossCollectedMinor).toBe(25_000);
  });

  it('handles NOT_REGISTERED_NO_TAX on direct sales while preserving MARKETPLACE_FACILITATOR_COLLECTED on eBay', () => {
    const unregisteredPolicy: typeof TAX_AND_PRICING_POLICY = {
      ...TAX_AND_PRICING_POLICY,
      domesticTaxPolicy: {
        ...TAX_AND_PRICING_POLICY.domesticTaxPolicy,
        isGstHstRegistered: false,
        isOntarioEntityHstRegistered: false,
        isOntarioHstRegistered: false,
      },
    };

    const directUnreg = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'LOCAL_WALK_IN_CASH',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        subtotalMinor: 10_000,
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'CASH',
      },
      unregisteredPolicy,
    );
    expect(directUnreg.taxCollectionMode).toBe('NOT_REGISTERED_NO_TAX');
    expect(directUnreg.taxOrVatMinor).toBe(0);
    expect(directUnreg.itcReceivableCadMinor).toBe(0);

    const ebayUnreg = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'EBAY_MOTORS_SHIPPED',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        subtotalMinor: 20_000,
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'BC',
        paymentMethod: 'EBAY_MANAGED_PAYOUT',
        buyerTaxRemittedByPlatformMinor: 1_000,
        isFeeTaxInvoiceVerified: true,
        feeTaxInvoiceStorageKey: 'org/invoices/ebay-nov.pdf',
      },
      unregisteredPolicy,
    );
    expect(ebayUnreg.taxCollectionMode).toBe('MARKETPLACE_FACILITATOR_COLLECTED');
    expect(ebayUnreg.buyerTaxRemittedByPlatformMinor).toBe(1_000);
    expect(ebayUnreg.taxOrVatMinor).toBe(0);
    expect(ebayUnreg.itcReceivableCadMinor).toBe(0);
  });

  it('preserves authoritative eBay buyer tax verbatim and gates fee ITCs on verification matrix', () => {
    // Unverified invoice -> itcReceivableCadMinor = 0
    const ebayUnverified = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'EBAY_MOTORS_SHIPPED',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        subtotalMinor: 10_000,
        shippingCostMinor: 1_200,
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'BC',
        paymentMethod: 'EBAY_MANAGED_PAYOUT',
        buyerTaxRemittedByPlatformMinor: 1_000, // BC tax preserved verbatim
        isFeeTaxInvoiceVerified: false,
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(ebayUnverified.taxCollectionMode).toBe(
      'MARKETPLACE_FACILITATOR_COLLECTED',
    );
    expect(ebayUnverified.buyerTaxRemittedByPlatformMinor).toBe(1_000);
    expect(ebayUnverified.taxOrVatMinor).toBe(0);
    expect(ebayUnverified.grossCollectedMinor).toBe(10_000);
    expect(ebayUnverified.platformFeeMinor).toBe(1_325); // 13.25% of 10,000
    expect(ebayUnverified.estimatedPlatformFeeTaxCadMinor).toBe(172); // round(1325 * 0.13) = 172.25 -> 172
    expect(ebayUnverified.itcReceivableCadMinor).toBe(0);
    expect(ebayUnverified.netRealizedCadMinor).toBe(7_475); // 10000 - 1325 - 1200
    expect(ebayUnverified.paymentSettlementState).toBe(
      'MARKETPLACE_PAYOUT_PENDING',
    );
    expect(ebayUnverified.cashCustodyState).toBe('PENDING_EXTERNAL_RECEIVABLE');

    // Null buyer tax stays null
    const ebayNullTax = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'EBAY_MOTORS_SHIPPED',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        subtotalMinor: 10_000,
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'EBAY_MANAGED_PAYOUT',
        buyerTaxRemittedByPlatformMinor: null,
        isFeeTaxInvoiceVerified: true,
        feeTaxInvoiceStorageKey: 'org/invoices/ebay-nov.pdf',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(ebayNullTax.buyerTaxRemittedByPlatformMinor).toBeNull();
    expect(ebayNullTax.itcReceivableCadMinor).toBe(172);
    expect(ebayNullTax.isItcPersistenceCompatible).toBe(true);

    // Verified true without storage key fails
    expect(() =>
      computeDomesticSaleTaxAndSettlement(
        {
          channel: 'EBAY_MOTORS_SHIPPED',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          subtotalMinor: 10_000,
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'EBAY_MANAGED_PAYOUT',
          buyerTaxRemittedByPlatformMinor: 1_300,
          isFeeTaxInvoiceVerified: true,
          feeTaxInvoiceStorageKey: ' ',
        },
        TAX_AND_PRICING_POLICY,
      ),
    ).toThrowError(DomainRuleError);

    // Permissive policy flag allows calculator-level ITC promotion while marking SQL mismatch
    const permissivePolicy: typeof TAX_AND_PRICING_POLICY = {
      ...TAX_AND_PRICING_POLICY,
      domesticTaxPolicy: {
        ...TAX_AND_PRICING_POLICY.domesticTaxPolicy,
        requireVerifiedTaxInvoiceForFeeItc: false,
      },
    };
    const permissiveRes = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'EBAY_MOTORS_SHIPPED',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        subtotalMinor: 10_000,
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'EBAY_MANAGED_PAYOUT',
        buyerTaxRemittedByPlatformMinor: null,
        isFeeTaxInvoiceVerified: false,
      },
      permissivePolicy,
    );
    expect(permissiveRes.itcReceivableCadMinor).toBe(172);
    expect(permissiveRes.isItcPersistenceCompatible).toBe(false);
  });
});

describe('Refund tax adjustments (ETA s. 232)', () => {
  it('reverses direct tax cumulatively so repeated partial refunds recover exact original tax cents', () => {
    const partial1 = computeRefundTaxAdjustment({
      adjustmentId: 'adj-1',
      originalSaleId: 'sale-1',
      taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
      originalSubtotalMinor: 10_001,
      originalTaxOrVatMinor: 1_300,
      originalItcReceivableCadMinor: 0,
      refundSubtotalMinor: 3_333,
      creditNoteReference: 'CN-2026-001',
    });
    // round(1300 * 3333 / 10001) = 433
    expect(partial1.gstHstAdjustmentCadMinor).toBe(-433);
    expect(partial1.taxOrVatAdjustmentMinor).toBe(-433);

    const partial2 = computeRefundTaxAdjustment({
      adjustmentId: 'adj-2',
      originalSaleId: 'sale-1',
      taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
      originalSubtotalMinor: 10_001,
      originalTaxOrVatMinor: 1_300,
      originalItcReceivableCadMinor: 0,
      priorRefundedSubtotalMinor: 3_333,
      priorRefundedTaxOrVatMinor: 433,
      refundSubtotalMinor: 6_668,
      creditNoteReference: 'CN-2026-002',
      priorAdjustmentIds: ['adj-1'],
    });
    expect(partial2.gstHstAdjustmentCadMinor).toBe(-867);
    expect(433 + 867).toBe(1_300);
    expect(partial2.remainingRefundableSubtotalMinor).toBe(0);
    expect(partial2.remainingRefundableTaxOrVatMinor).toBe(0);
  });

  it('rejects overrefunds, duplicate adjustment IDs, missing credit notes, and never invents marketplace tax credits', () => {
    expect(() =>
      computeRefundTaxAdjustment({
        adjustmentId: 'adj-1',
        originalSaleId: 'sale-1',
        taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
        originalSubtotalMinor: 10_000,
        originalTaxOrVatMinor: 1_300,
        originalItcReceivableCadMinor: 0,
        refundSubtotalMinor: 10_001,
        creditNoteReference: 'CN-1',
      }),
    ).toThrowError(DomainRuleError);

    expect(() =>
      computeRefundTaxAdjustment({
        adjustmentId: 'adj-1',
        originalSaleId: 'sale-1',
        taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
        originalSubtotalMinor: 10_000,
        originalTaxOrVatMinor: 1_300,
        originalItcReceivableCadMinor: 0,
        refundSubtotalMinor: 5_000,
        creditNoteReference: 'CN-1',
        priorAdjustmentIds: ['adj-1'],
      }),
    ).toThrowError(DomainRuleError);

    expect(() =>
      computeRefundTaxAdjustment({
        adjustmentId: 'adj-1',
        originalSaleId: 'sale-1',
        taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
        originalSubtotalMinor: 10_000,
        originalTaxOrVatMinor: 1_300,
        originalItcReceivableCadMinor: 0,
        refundSubtotalMinor: 5_000,
        creditNoteReference: ' ',
      }),
    ).toThrowError(DomainRuleError);

    // Marketplace refund: 0 seller tax reversal, only explicit credited fee tax reverses ITC
    const mktRefund = computeRefundTaxAdjustment({
      adjustmentId: 'adj-ebay-1',
      originalSaleId: 'sale-ebay-1',
      taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
      originalSubtotalMinor: 10_000,
      originalTaxOrVatMinor: 0,
      originalItcReceivableCadMinor: 172,
      refundSubtotalMinor: 10_000,
      creditedFeeTaxCadMinor: 172,
    });
    expect(mktRefund.taxOrVatAdjustmentMinor).toBe(0);
    expect(mktRefund.itcAdjustmentCadMinor).toBe(-172);

    expect(() =>
      computeRefundTaxAdjustment({
        adjustmentId: 'adj-ebay-2',
        originalSaleId: 'sale-ebay-1',
        taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
        originalSubtotalMinor: 10_000,
        originalTaxOrVatMinor: 0,
        originalItcReceivableCadMinor: 172,
        refundSubtotalMinor: 10_000,
        creditedFeeTaxCadMinor: 173,
      }),
    ).toThrowError(DomainRuleError);
  });
});

describe('3-Tier checkout corridor, prepaid export gate, and dormant vault landed cost', () => {
  it('enforces domestic 10% corridor equality, 1 cent beyond, roles/reasons, and trusted CFO vs forged overrides', () => {
    const floor = 10_000;
    const hunter = { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' as const };
    const cfo = { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' as const };

    // Tier 1: at floor
    const t1 = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 10_000,
        actor: hunter,
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(t1.allowed).toBe(true);
    expect(t1.tier).toBe('TIER_1_AT_OR_ABOVE_FLOOR');

    // Tier 2: exactly 10% off (9,000) with valid reason passes for HUNTER_MECHANIC
    const t2Exact = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 9_000,
        actor: hunter,
        discountReasonCode: 'CASH_ROUNDING',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(t2Exact.allowed).toBe(true);
    expect(t2Exact.tier).toBe('TIER_2_ADMIN_CORRIDOR');

    // Tier 2 without reason fails
    const t2NoReason = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 9_500,
        actor: hunter,
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(t2NoReason.allowed).toBe(false);
    expect(t2NoReason.blockingCodes).toContain('DISCOUNT_REASON_REQUIRED');

    // Tier 2 with unauthorized role fails
    const t2WrongRole = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 9_500,
        actor: { actorUserId: 'stripper-1', actorRole: 'ONTARIO_STRIPPER' },
        discountReasonCode: 'CASH_ROUNDING',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(t2WrongRole.allowed).toBe(false);
    expect(t2WrongRole.blockingCodes).toContain('DISCOUNT_ROLE_UNAUTHORIZED');

    // Tier 3: 1 cent beyond 10% (8,999) requires CFO override
    const t3Blocked = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 8_999,
        actor: hunter,
        discountReasonCode: 'BUNDLE_DISCOUNT',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(t3Blocked.allowed).toBe(false);
    expect(t3Blocked.blockingCodes).toContain('FLOOR_PRICE_OVERRIDE_REQUIRED');

    // Forged self-approval or blank reason fails
    const forged = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 8_500,
        actor: hunter,
        cfoOverride: {
          approved: true,
          approvedById: 'hunter-1',
          reasonNote: 'Self-approved',
        },
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(forged.allowed).toBe(false);

    const blankReason = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 8_500,
        actor: hunter,
        cfoOverride: {
          approved: true,
          approvedById: 'cfo-1',
          reasonNote: '   ',
        },
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(blankReason.allowed).toBe(false);

    // Valid CFO approval succeeds
    const approved = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 8_000,
        actor: hunter,
        cfoOverride: {
          approved: true,
          approvedById: 'cfo-1',
          approverRole: 'ARCHITECT_CFO',
          reasonNote: 'Long-term shop bundle clearance',
        },
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(approved.allowed).toBe(true);
    expect(approved.overrideApplied).toBe(true);
    expect(approved.cfoOverrideAudit.approvedById).toBe('cfo-1');

    // Direct CFO execution succeeds
    const directCfo = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DOMESTIC_ORIGIN',
        floorPriceAtCheckoutMinor: floor,
        subtotalMinor: 7_500,
        actor: cfo,
        discountReasonCode: 'CFO_CUSTOM_OVERRIDE',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(directCfo.allowed).toBe(true);
  });

  it('enforces Trinidad vault corridor band, small rounding floor, and $750 TTD hard cap', () => {
    const admin = { actorUserId: 'vault-1', actorRole: 'TRINIDAD_VAULT_ADMIN' as const };
    // Small item: floor 50,000 TTD cents (8% = 4,000, small rounding allowance = 10,000 -> cap = 10,000)
    const smallAllow = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DESTINATION_EXPORT_VAULT',
        floorPriceAtCheckoutMinor: 50_000,
        subtotalMinor: 40_000,
        grossCollectedMinor: 40_000,
        actor: admin,
        discountReasonCode: 'CASH_ROUNDING',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(smallAllow.maxAdminDiscountMinor).toBe(10_000);
    expect(smallAllow.allowed).toBe(true);

    // High-ticket item: floor 2,000,000 TTD cents (8% = 160,000, hard cap = 75,000)
    const highCap = evaluateCheckoutPriceFloor(
      {
        marketNode: 'DESTINATION_EXPORT_VAULT',
        floorPriceAtCheckoutMinor: 2_000_000,
        subtotalMinor: 1_924_999,
        grossCollectedMinor: 1_924_999,
        actor: admin,
        discountReasonCode: 'BUNDLE_DISCOUNT',
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(highCap.maxAdminDiscountMinor).toBe(75_000);
    expect(highCap.allowed).toBe(false);
    expect(highCap.blockingCodes).toContain('FLOOR_PRICE_OVERRIDE_REQUIRED');
  });

  it('enforces RULE-EXP-001 prepaid export gate strictly on BANK_SETTLEMENT_CONFIRMED even with CFO override', () => {
    for (const badState of [
      {
        paymentSettlementState: 'BANK_SETTLEMENT_PENDING' as const,
        cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE' as const,
        bankSettledAt: null,
        bankDepositReference: null,
      },
      {
        paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING' as const,
        cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE' as const,
        bankSettledAt: null,
        bankDepositReference: null,
      },
      {
        paymentSettlementState: 'PAYMENT_CONFIRMED' as const,
        cashCustodyState: 'HELD_IN_OPERATOR_FLOAT' as const,
        bankSettledAt: null,
        bankDepositReference: null,
      },
    ]) {
      const blocked = evaluatePrepaidExportGate(
        {
          items: [
            {
              itemId: 'part-1',
              itemType: 'PART',
              ...badState,
              isVoidedOrReversed: false,
            },
          ],
          cfoOverride: {
            approved: true,
            approvedById: 'cfo-1',
            approverRole: 'ARCHITECT_CFO',
            reasonNote: 'Attempt override for pending funds',
          },
        },
        TAX_AND_PRICING_POLICY,
      );
      expect(blocked.allowed).toBe(false);
      expect(blocked.blockingCodes).toContain('PREPAID_EXPORT_REQUIRED');
    }

    const cleared = evaluatePrepaidExportGate(
      {
        items: [
          {
            itemId: 'part-1',
            itemType: 'PART',
            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            bankSettledAt: '2026-11-12T10:00:00Z',
            bankDepositReference: 'WIRE-EXP-01',
            isVoidedOrReversed: false,
            ebaySyncState: 'EXPORT_LOCK_CONFIRMED',
            partCustodyState: 'ON_EXPORT_PALLET',
            availabilityState: 'PAID_SETTLED',
          },
        ],
      },
      TAX_AND_PRICING_POLICY,
    );
    expect(cleared.allowed).toBe(true);
  });

  it('computes dormant Trinidad Vault landed cost, VAT branching, ceiling floor, grade ask, and pre-tax broker commission', () => {
    const unregGradeA = computeVaultLandedCostAndFloor(
      {
        allocatedCostCadMinor: 10_000, // $100.00 CAD
        wholesaleFobUsdMinor: 10_000, // $100.00 USD
        weightKg: 10,
        araGrade: 'GRADE_A',
        compBaselineCadMinor: 20_000,
      },
      TAX_AND_PRICING_POLICY,
    );
    // freight = 10 * 1.85 * 100 = 1,850 USD cents
    // insurance = 10,000 * 0.015 = 150 USD cents
    // CIF USD = 10,000 + 1,850 + 150 = 12,000
    expect(unregGradeA.freightUsdMinor).toBe(1_850);
    expect(unregGradeA.insuranceUsdMinor).toBe(150);
    expect(unregGradeA.cifUsdMinor).toBe(12_000);
    // CIF TTD = round(12000 * 6.78297) = 81,395.64 -> 81,396
    expect(unregGradeA.cifTtdMinor).toBe(81_396);
    // Duty & Proc = round(81396 * 0.33) = 26,860.68 -> 26,861
    expect(unregGradeA.dutyAndFeesTtdMinor).toBe(26_861);
    // Import VAT = round((81396 + 26861) * 0.125) = round(108257 * 0.125) = round(13532.125) = 13,532
    expect(unregGradeA.importVatTtdMinor).toBe(13_532);
    // Freight & Ins shadow TTD = round(2000 * 7.35) = 14,700
    expect(unregGradeA.freightAndInsuranceShadowTtdMinor).toBe(14_700);
    // Unregistered includes import VAT: 26861 + 13532 + 14700 = 55,093
    expect(unregGradeA.totalTaxesAndFreightTtdMinor).toBe(55_093);
    // Principal protection = round(10000 * 1.65 * 0.73 * 7.35) = round(88530.75) = 88,531
    expect(unregGradeA.principalCostPlusMarkupTtdMinor).toBe(88_531);
    // Numerator = 88531 + 55093 = 143,624; / 0.90 = 159,582.222... -> ceil = 159,583
    expect(unregGradeA.vaultFloorPriceTtdMinor).toBe(159_583);

    const unregGradeC = computeVaultLandedCostAndFloor(
      {
        allocatedCostCadMinor: 10_000,
        wholesaleFobUsdMinor: 10_000,
        weightKg: 10,
        araGrade: 'GRADE_C',
        compBaselineCadMinor: 20_000,
      },
      TAX_AND_PRICING_POLICY,
    );
    // Hard floor anchored to allocated cost (unchanged across grades), ask scales with ARA grade
    expect(unregGradeC.vaultFloorPriceTtdMinor).toBe(
      unregGradeA.vaultFloorPriceTtdMinor,
    );
    expect(unregGradeC.recommendedAskTtdMinor!).toBeLessThan(
      unregGradeA.recommendedAskTtdMinor!,
    );

    // VAT-registered entity excludes import VAT from floor numerator
    const regPolicy: typeof TAX_AND_PRICING_POLICY = {
      ...TAX_AND_PRICING_POLICY,
      trinidadImportTax: {
        ...TAX_AND_PRICING_POLICY.trinidadImportTax,
        isTrinidadEntityVatRegistered: true,
      },
    };
    const regRes = computeVaultLandedCostAndFloor(
      {
        allocatedCostCadMinor: 10_000,
        wholesaleFobUsdMinor: 10_000,
        weightKg: 10,
        araGrade: 'GRADE_A',
      },
      regPolicy,
    );
    expect(regRes.totalTaxesAndFreightTtdMinor).toBe(26_861 + 14_700);
    expect(regRes.vaultFloorPriceTtdMinor).toBeLessThan(
      unregGradeA.vaultFloorPriceTtdMinor,
    );

    // Commission >= 1 rejected
    expect(() =>
      computeVaultLandedCostAndFloor(
        {
          allocatedCostCadMinor: 10_000,
          wholesaleFobUsdMinor: 10_000,
          weightKg: 0,
          araGrade: 'GRADE_B1',
          brokerCommissionRateOverride: 1.0,
        },
        TAX_AND_PRICING_POLICY,
      ),
    ).toThrowError(DomainRuleError);

    // Broker commission strictly on pre-tax subtotal
    expect(computeBrokerCommissionMinor(100_000, 1000)).toBe(10_000);
  });
});
