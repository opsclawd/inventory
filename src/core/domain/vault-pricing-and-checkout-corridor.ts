import type {
  AraConditionGradeEnum,
  CashCustodyState,
  DomesticSaleChannel,
  EbaySyncState,
  InventoryAvailabilityState,
  PartCustodyState,
  PaymentSettlementState,
  SaleMarketNode,
  TaxCollectionMode,
} from '@prisma/client';
import type {
  CanadianProvinceOrTerritoryCode,
  PricingAndCompliancePolicy,
} from '../ports';
import {
  addRationals,
  type ActorContext,
  assertNonEmptyTrimmedString,
  assertNonNegativeSafeInt,
  assertPositiveSafeInt,
  bigIntToSafeNumber,
  checkedAdd,
  checkedSub,
  divideBigIntCeil,
  DomainRuleError,
  type DomainRuleErrorCode,
  evaluateCfoOverride,
  type GateDecision,
  isNonEmptyTrimmedString,
  multiplyMinorByBpsHalfUp,
  multiplyMinorByRateHalfUp,
  multiplyMinorByRationalHalfUp,
  multiplyRationals,
  parseDecimalToRational,
  parseUtcDate,
  subtractRationals,
  type TrustedCfoApprovalInput,
} from './domain-primitives';

/**
 * Canonical Issue #3 domestic delivery methods.
 * Persistence mapping to `salvage.SaleTransaction.deliveryMethod`:
 * - `'PICKUP_AT_ORIGIN' | 'LOCAL_DELIVERY_ONTARIO'` -> `'IN_PERSON_PICKUP'`
 * - `'SELLER_SHIPPED_PARCEL_OR_FREIGHT'` -> `'SELLER_SHIPPED'`
 */
export type IssueDomesticDeliveryMethod =
  | 'PICKUP_AT_ORIGIN'
  | 'LOCAL_DELIVERY_ONTARIO'
  | 'SELLER_SHIPPED_PARCEL_OR_FREIGHT';

export type SchemaDeliveryMethod = 'IN_PERSON_PICKUP' | 'SELLER_SHIPPED';

export type CheckoutTaxPolicySlice = Pick<
  PricingAndCompliancePolicy,
  'domesticTaxPolicy' | 'domesticChannelFees'
>;

export interface DomesticSaleTaxInput {
  readonly channel: DomesticSaleChannel;
  readonly deliveryMethod: IssueDomesticDeliveryMethod;
  readonly subtotalMinor: number;
  readonly destinationCountryCode: string;
  readonly destinationProvinceOrState?: string | null;
  readonly exportProofStorageKey?: string | null;
  readonly paymentMethod: string;
  readonly isCashCountedInPerson?: boolean;
  readonly buyerTaxRemittedByPlatformMinor?: number | null;
  readonly platformFeeMinor?: number;
  readonly shippingCostMinor?: number;
  readonly estimatedPlatformFeeTaxCadMinor?: number;
  readonly isFeeTaxInvoiceVerified?: boolean;
  readonly feeTaxInvoiceStorageKey?: string | null;
}

export interface DomesticSaleTaxResult {
  readonly taxCollectionMode: TaxCollectionMode;
  readonly schemaDeliveryMethod: SchemaDeliveryMethod;
  readonly appliedTaxJurisdiction: string;
  readonly appliedTaxRateBps: number;
  readonly gstHstTaxCadMinor: number;
  readonly provincialTaxCadMinor: number;
  readonly taxOrVatMinor: number;
  readonly buyerTaxRemittedByPlatformMinor: number | null;
  readonly platformFeeMinor: number;
  readonly shippingCostMinor: number;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly isItcPersistenceCompatible: boolean;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
}

const VALID_CANADIAN_PROVINCES = new Set<CanadianProvinceOrTerritoryCode>([
  'ON',
  'NS',
  'NB',
  'NL',
  'PE',
  'QC',
  'BC',
  'AB',
  'MB',
  'SK',
  'YT',
  'NT',
  'NU',
]);

const PST_PROVINCES = new Set<'BC' | 'SK' | 'MB' | 'QC'>([
  'BC',
  'SK',
  'MB',
  'QC',
]);

function mapIssueDeliveryToSchema(
  deliveryMethod: IssueDomesticDeliveryMethod,
): SchemaDeliveryMethod {
  return deliveryMethod === 'SELLER_SHIPPED_PARCEL_OR_FREIGHT'
    ? 'SELLER_SHIPPED'
    : 'IN_PERSON_PICKUP';
}

function normalizeCountryCode(raw: string): string {
  if (typeof raw !== 'string') {
    throw new DomainRuleError(
      'INVALID_DESTINATION_COUNTRY',
      'destinationCountryCode must be a valid ISO-3166-1 alpha-2 country code.',
    );
  }
  const trimmed = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(trimmed)) {
    throw new DomainRuleError(
      'INVALID_DESTINATION_COUNTRY',
      `Invalid destinationCountryCode "${raw}".`,
      { destinationCountryCode: raw },
    );
  }
  return trimmed;
}

function resolveInitialSettlementAndCustody(
  channel: DomesticSaleChannel,
  paymentMethod: string,
  isCashCountedInPerson?: boolean,
): {
  paymentSettlementState: PaymentSettlementState;
  cashCustodyState: CashCustodyState;
} {
  if (
    channel === 'EBAY_MOTORS_SHIPPED' ||
    paymentMethod === 'EBAY_MANAGED_PAYOUT'
  ) {
    return {
      paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING',
      cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
    };
  }
  if (paymentMethod === 'CASH') {
    if (isCashCountedInPerson !== false) {
      return {
        paymentSettlementState: 'PAYMENT_CONFIRMED',
        cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
      };
    }
    return {
      paymentSettlementState: 'PAYMENT_INITIATED',
      cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
    };
  }
  return {
    paymentSettlementState: 'BANK_SETTLEMENT_PENDING',
    cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
  };
}

/**
 * Jurisdiction-Aware CRA Place-of-Supply GST/HST & eBay Canada Billing Agent Calculator
 * (`RULE-TAX-HST-01`, `FIX 05`, `FIX 06`).
 *
 * SQL compatibility note (Issue #2 migration 0001):
 * `sale_tax_collection_mode_consistency` requires `isFeeTaxInvoiceVerified = true`
 * and a non-blank `feeTaxInvoiceStorageKey` whenever `itcReceivableCadMinor > 0`.
 * When `policy.domesticTaxPolicy.requireVerifiedTaxInvoiceForFeeItc === false`
 * (permissive branch), this calculator marks `isItcPersistenceCompatible = false`
 * unless verified invoice evidence is supplied, and `computeNetHstTrustLiabilityCadMinor`
 * never releases trust liability on unverified ITCs.
 */
export function computeDomesticSaleTaxAndSettlement(
  input: DomesticSaleTaxInput,
  policy: CheckoutTaxPolicySlice,
): DomesticSaleTaxResult {
  const subtotalMinor = assertNonNegativeSafeInt(
    input.subtotalMinor,
    'subtotalMinor',
  );
  const shippingCostMinor = assertNonNegativeSafeInt(
    input.shippingCostMinor ?? 0,
    'shippingCostMinor',
  );
  const countryCode = normalizeCountryCode(input.destinationCountryCode);
  const schemaDeliveryMethod = mapIssueDeliveryToSchema(input.deliveryMethod);

  const channelFeeRate = Object.hasOwn(
    policy.domesticChannelFees,
    input.channel,
  )
    ? (policy.domesticChannelFees[input.channel] ?? 0)
    : 0;
  const platformFeeMinor =
    input.platformFeeMinor !== undefined
      ? assertNonNegativeSafeInt(input.platformFeeMinor, 'platformFeeMinor')
      : multiplyMinorByRateHalfUp(
          subtotalMinor,
          channelFeeRate,
          'platformFeeMinor',
        );

  const netRealizedCadMinor = checkedSub(
    checkedSub(subtotalMinor, platformFeeMinor, 'subtotalMinusFee'),
    shippingCostMinor,
    'netRealizedCadMinor',
  );

  const { paymentSettlementState, cashCustodyState } =
    resolveInitialSettlementAndCustody(
      input.channel,
      input.paymentMethod,
      input.isCashCountedInPerson,
    );

  // Branch 1: eBay Motors Canada Billing Agent / Marketplace Facilitator
  // Evaluated first regardless of organization GST/HST registration status.
  if (input.channel === 'EBAY_MOTORS_SHIPPED') {
    const buyerTaxRemittedByPlatformMinor =
      input.buyerTaxRemittedByPlatformMinor !== undefined &&
      input.buyerTaxRemittedByPlatformMinor !== null
        ? assertNonNegativeSafeInt(
            input.buyerTaxRemittedByPlatformMinor,
            'buyerTaxRemittedByPlatformMinor',
          )
        : null;

    const estimatedPlatformFeeTaxCadMinor =
      input.estimatedPlatformFeeTaxCadMinor !== undefined
        ? assertNonNegativeSafeInt(
            input.estimatedPlatformFeeTaxCadMinor,
            'estimatedPlatformFeeTaxCadMinor',
          )
        : multiplyMinorByRateHalfUp(
            platformFeeMinor,
            policy.domesticTaxPolicy.ontarioHstRate,
            'estimatedPlatformFeeTaxCadMinor',
          );

    const hasVerifiedKey = isNonEmptyTrimmedString(
      input.feeTaxInvoiceStorageKey,
    );
    if (input.isFeeTaxInvoiceVerified === true && !hasVerifiedKey) {
      throw new DomainRuleError(
        'FEE_TAX_INVOICE_KEY_REQUIRED',
        'feeTaxInvoiceStorageKey is required when isFeeTaxInvoiceVerified is true.',
      );
    }

    const invoiceVerified =
      input.isFeeTaxInvoiceVerified === true && hasVerifiedKey;

    let itcReceivableCadMinor = 0;
    if (policy.domesticTaxPolicy.isGstHstRegistered) {
      if (policy.domesticTaxPolicy.requireVerifiedTaxInvoiceForFeeItc) {
        itcReceivableCadMinor = invoiceVerified
          ? estimatedPlatformFeeTaxCadMinor
          : 0;
      } else {
        itcReceivableCadMinor = estimatedPlatformFeeTaxCadMinor;
      }
    }

    const provNorm = input.destinationProvinceOrState?.trim().toUpperCase();
    const appliedTaxJurisdiction =
      countryCode === 'CA' && provNorm && provNorm.length > 0
        ? `CA-${provNorm}`
        : countryCode === 'CA'
          ? 'CA-ON'
          : `EXPORT-${countryCode}`;

    return {
      taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
      schemaDeliveryMethod,
      appliedTaxJurisdiction,
      appliedTaxRateBps: 0,
      gstHstTaxCadMinor: 0,
      provincialTaxCadMinor: 0,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor,
      platformFeeMinor,
      shippingCostMinor,
      estimatedPlatformFeeTaxCadMinor,
      itcReceivableCadMinor,
      isItcPersistenceCompatible:
        itcReceivableCadMinor === 0 || invoiceVerified,
      grossCollectedMinor: subtotalMinor,
      netRealizedCadMinor,
      paymentSettlementState,
      cashCustodyState,
    };
  }

  // Branch 2: Direct & Classified Channels when NOT GST/HST registered
  if (!policy.domesticTaxPolicy.isGstHstRegistered) {
    return {
      taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
      schemaDeliveryMethod,
      appliedTaxJurisdiction: 'CA-ON',
      appliedTaxRateBps: 0,
      gstHstTaxCadMinor: 0,
      provincialTaxCadMinor: 0,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: 0,
      platformFeeMinor,
      shippingCostMinor,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isItcPersistenceCompatible: true,
      grossCollectedMinor: subtotalMinor,
      netRealizedCadMinor,
      paymentSettlementState,
      cashCustodyState,
    };
  }

  // Branch 3a: In-Ontario physical pickup or Ontario local delivery -> 13% ON HST
  if (
    input.deliveryMethod === 'PICKUP_AT_ORIGIN' ||
    input.deliveryMethod === 'LOCAL_DELIVERY_ONTARIO'
  ) {
    const appliedTaxRateBps =
      policy.domesticTaxPolicy.canadianProvincialGstHstRatesBps.ON;
    const gstHstTaxCadMinor = multiplyMinorByBpsHalfUp(
      subtotalMinor,
      appliedTaxRateBps,
      'gstHstTaxCadMinor',
    );
    return {
      taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
      schemaDeliveryMethod,
      appliedTaxJurisdiction: 'CA-ON',
      appliedTaxRateBps,
      gstHstTaxCadMinor,
      provincialTaxCadMinor: 0,
      taxOrVatMinor: gstHstTaxCadMinor,
      buyerTaxRemittedByPlatformMinor: 0,
      platformFeeMinor,
      shippingCostMinor,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isItcPersistenceCompatible: true,
      grossCollectedMinor: checkedAdd(
        subtotalMinor,
        gstHstTaxCadMinor,
        'grossCollectedMinor',
      ),
      netRealizedCadMinor,
      paymentSettlementState,
      cashCustodyState,
    };
  }

  // Branch 3b: Seller-shipped within Canada -> CRA place-of-supply rate
  if (countryCode === 'CA') {
    if (!isNonEmptyTrimmedString(input.destinationProvinceOrState)) {
      throw new DomainRuleError(
        'DESTINATION_PROVINCE_REQUIRED_FOR_TAX',
        'destinationProvinceOrState is required for Canadian seller-shipped orders.',
      );
    }
    const provinceCode = input.destinationProvinceOrState
      .trim()
      .toUpperCase() as CanadianProvinceOrTerritoryCode;
    if (!VALID_CANADIAN_PROVINCES.has(provinceCode)) {
      throw new DomainRuleError(
        'INVALID_CANADIAN_PROVINCE_CODE',
        `Unrecognized Canadian province or territory code: "${input.destinationProvinceOrState}".`,
        { destinationProvinceOrState: input.destinationProvinceOrState },
      );
    }

    const appliedTaxRateBps =
      policy.domesticTaxPolicy.canadianProvincialGstHstRatesBps[provinceCode];
    const gstHstTaxCadMinor = multiplyMinorByBpsHalfUp(
      subtotalMinor,
      appliedTaxRateBps,
      'gstHstTaxCadMinor',
    );

    let provincialTaxCadMinor = 0;
    if (PST_PROVINCES.has(provinceCode as 'BC' | 'SK' | 'MB' | 'QC')) {
      const pstConfig =
        policy.domesticTaxPolicy.provincialPstRegistrations[
          provinceCode as 'BC' | 'SK' | 'MB' | 'QC'
        ];
      if (pstConfig?.registered) {
        provincialTaxCadMinor = multiplyMinorByRateHalfUp(
          subtotalMinor,
          pstConfig.rate,
          'provincialTaxCadMinor',
        );
      }
    }

    const taxOrVatMinor = checkedAdd(
      gstHstTaxCadMinor,
      provincialTaxCadMinor,
      'taxOrVatMinor',
    );

    return {
      taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
      schemaDeliveryMethod,
      appliedTaxJurisdiction: `CA-${provinceCode}`,
      appliedTaxRateBps,
      gstHstTaxCadMinor,
      provincialTaxCadMinor,
      taxOrVatMinor,
      buyerTaxRemittedByPlatformMinor: 0,
      platformFeeMinor,
      shippingCostMinor,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isItcPersistenceCompatible: true,
      grossCollectedMinor: checkedAdd(
        subtotalMinor,
        taxOrVatMinor,
        'grossCollectedMinor',
      ),
      netRealizedCadMinor,
      paymentSettlementState,
      cashCustodyState,
    };
  }

  // Branch 3c: Seller-shipped outside Canada -> Zero-rated export with proof
  if (!isNonEmptyTrimmedString(input.exportProofStorageKey)) {
    throw new DomainRuleError(
      'EXPORT_PROOF_REQUIRED_FOR_ZERO_RATING',
      'exportProofStorageKey is required to zero-rate an international seller-shipped export.',
    );
  }

  return {
    taxCollectionMode: 'ZERO_RATED_EXPORT',
    schemaDeliveryMethod,
    appliedTaxJurisdiction: 'EXPORT-OUTSIDE-CA',
    appliedTaxRateBps: 0,
    gstHstTaxCadMinor: 0,
    provincialTaxCadMinor: 0,
    taxOrVatMinor: 0,
    buyerTaxRemittedByPlatformMinor: 0,
    platformFeeMinor,
    shippingCostMinor,
    estimatedPlatformFeeTaxCadMinor: 0,
    itcReceivableCadMinor: 0,
    isItcPersistenceCompatible: true,
    grossCollectedMinor: subtotalMinor,
    netRealizedCadMinor,
    paymentSettlementState,
    cashCustodyState,
  };
}

export interface RefundTaxAdjustmentInput {
  readonly adjustmentId: string;
  readonly originalSaleId: string;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly originalSubtotalMinor: number;
  readonly originalTaxOrVatMinor: number;
  readonly originalGstHstTaxCadMinor?: number;
  readonly originalProvincialTaxCadMinor?: number;
  readonly originalItcReceivableCadMinor: number;
  readonly priorRefundedSubtotalMinor?: number;
  readonly priorRefundedTaxOrVatMinor?: number;
  readonly priorRefundedGstHstTaxCadMinor?: number;
  readonly priorRefundedProvincialTaxCadMinor?: number;
  readonly priorReversedItcCadMinor?: number;
  readonly refundSubtotalMinor: number;
  readonly creditedFeeTaxCadMinor?: number;
  readonly creditNoteReference?: string | null;
  readonly priorAdjustmentIds?: ReadonlyArray<string>;
}

export interface RefundTaxAdjustmentResult {
  readonly adjustmentId: string;
  readonly originalSaleId: string;
  readonly subtotalAdjustmentMinor: number;
  readonly taxOrVatAdjustmentMinor: number;
  readonly gstHstAdjustmentCadMinor: number;
  readonly provincialTaxAdjustmentCadMinor: number;
  readonly itcAdjustmentCadMinor: number;
  readonly grossAdjustmentMinor: number;
  readonly remainingRefundableSubtotalMinor: number;
  readonly remainingRefundableTaxOrVatMinor: number;
  readonly remainingRefundableItcCadMinor: number;
}

/**
 * Computes ETA s. 232 refund / credit-note tax adjustments using cumulative
 * rounding from positive original amounts so repeated partial refunds sum
 * to the exact original tax cents without phantom marketplace credits.
 */
export function computeRefundTaxAdjustment(
  input: RefundTaxAdjustmentInput,
): RefundTaxAdjustmentResult {
  const adjustmentId = assertNonEmptyTrimmedString(
    input.adjustmentId,
    'INVALID_INPUT',
    'adjustmentId is required.',
  );
  const originalSaleId = assertNonEmptyTrimmedString(
    input.originalSaleId,
    'INVALID_INPUT',
    'originalSaleId is required.',
  );
  if (input.priorAdjustmentIds?.includes(adjustmentId)) {
    throw new DomainRuleError(
      'DUPLICATE_REFUND_ADJUSTMENT',
      `Duplicate refund adjustmentId "${adjustmentId}".`,
      { adjustmentId },
    );
  }

  const originalSubtotalMinor = assertPositiveSafeInt(
    input.originalSubtotalMinor,
    'originalSubtotalMinor',
  );
  const originalTaxOrVatMinor = assertNonNegativeSafeInt(
    input.originalTaxOrVatMinor,
    'originalTaxOrVatMinor',
  );
  const originalGstHstTaxCadMinor = assertNonNegativeSafeInt(
    input.originalGstHstTaxCadMinor ?? originalTaxOrVatMinor,
    'originalGstHstTaxCadMinor',
  );
  const originalProvincialTaxCadMinor = assertNonNegativeSafeInt(
    input.originalProvincialTaxCadMinor ?? 0,
    'originalProvincialTaxCadMinor',
  );
  if (
    checkedAdd(
      originalGstHstTaxCadMinor,
      originalProvincialTaxCadMinor,
      'originalTaxComponents',
    ) !== originalTaxOrVatMinor
  ) {
    throw new DomainRuleError(
      'INVALID_INPUT',
      'originalGstHstTaxCadMinor + originalProvincialTaxCadMinor must equal originalTaxOrVatMinor.',
    );
  }

  const originalItcReceivableCadMinor = assertNonNegativeSafeInt(
    input.originalItcReceivableCadMinor,
    'originalItcReceivableCadMinor',
  );
  const priorRefundedSubtotalMinor = assertNonNegativeSafeInt(
    input.priorRefundedSubtotalMinor ?? 0,
    'priorRefundedSubtotalMinor',
  );
  const priorRefundedTaxOrVatMinor = assertNonNegativeSafeInt(
    input.priorRefundedTaxOrVatMinor ?? 0,
    'priorRefundedTaxOrVatMinor',
  );
  const priorRefundedGstHstTaxCadMinor = assertNonNegativeSafeInt(
    input.priorRefundedGstHstTaxCadMinor ?? priorRefundedTaxOrVatMinor,
    'priorRefundedGstHstTaxCadMinor',
  );
  const priorRefundedProvincialTaxCadMinor = assertNonNegativeSafeInt(
    input.priorRefundedProvincialTaxCadMinor ?? 0,
    'priorRefundedProvincialTaxCadMinor',
  );
  const priorReversedItcCadMinor = assertNonNegativeSafeInt(
    input.priorReversedItcCadMinor ?? 0,
    'priorReversedItcCadMinor',
  );

  const refundSubtotalMinor = assertPositiveSafeInt(
    input.refundSubtotalMinor,
    'refundSubtotalMinor',
  );
  const cumulativeRefundedSubtotal = checkedAdd(
    priorRefundedSubtotalMinor,
    refundSubtotalMinor,
    'cumulativeRefundedSubtotal',
  );
  if (cumulativeRefundedSubtotal > originalSubtotalMinor) {
    throw new DomainRuleError(
      'REFUND_EXCEEDS_ORIGINAL_SALE',
      'Cumulative refunded subtotal exceeds original sale subtotal.',
      {
        originalSubtotalMinor,
        priorRefundedSubtotalMinor,
        refundSubtotalMinor,
      },
    );
  }

  let gstHstReversalPositive = 0;
  let provincialReversalPositive = 0;

  if (input.taxCollectionMode === 'DIRECT_SELLER_COLLECTED') {
    const cumulativeGstHst =
      cumulativeRefundedSubtotal === originalSubtotalMinor
        ? originalGstHstTaxCadMinor
        : multiplyMinorByRationalHalfUp(
            originalGstHstTaxCadMinor,
            BigInt(cumulativeRefundedSubtotal),
            BigInt(originalSubtotalMinor),
            'cumulativeGstHstRefund',
          );
    const cumulativeProv =
      cumulativeRefundedSubtotal === originalSubtotalMinor
        ? originalProvincialTaxCadMinor
        : multiplyMinorByRationalHalfUp(
            originalProvincialTaxCadMinor,
            BigInt(cumulativeRefundedSubtotal),
            BigInt(originalSubtotalMinor),
            'cumulativeProvincialRefund',
          );

    gstHstReversalPositive = Math.max(
      0,
      checkedSub(
        cumulativeGstHst,
        priorRefundedGstHstTaxCadMinor,
        'gstHstReversalPositive',
      ),
    );
    provincialReversalPositive = Math.max(
      0,
      checkedSub(
        cumulativeProv,
        priorRefundedProvincialTaxCadMinor,
        'provincialReversalPositive',
      ),
    );
  }

  const taxReversalPositive = checkedAdd(
    gstHstReversalPositive,
    provincialReversalPositive,
    'taxReversalPositive',
  );

  if (
    input.taxCollectionMode === 'DIRECT_SELLER_COLLECTED' &&
    taxReversalPositive > 0 &&
    !isNonEmptyTrimmedString(input.creditNoteReference)
  ) {
    throw new DomainRuleError(
      'CREDIT_NOTE_REFERENCE_REQUIRED',
      'creditNoteReference is required when reversing direct seller-collected GST/HST/PST.',
    );
  }

  const itcReversalPositive = assertNonNegativeSafeInt(
    input.creditedFeeTaxCadMinor ?? 0,
    'creditedFeeTaxCadMinor',
  );
  const cumulativeReversedItc = checkedAdd(
    priorReversedItcCadMinor,
    itcReversalPositive,
    'cumulativeReversedItc',
  );
  if (cumulativeReversedItc > originalItcReceivableCadMinor) {
    throw new DomainRuleError(
      'REFUND_EXCEEDS_ORIGINAL_ITC',
      'Credited fee tax reversal exceeds remaining original ITC.',
    );
  }

  const grossPositive = checkedAdd(
    refundSubtotalMinor,
    taxReversalPositive,
    'grossRefundPositive',
  );

  const negateNonZero = (value: number): number => (value === 0 ? 0 : -value);

  return {
    adjustmentId,
    originalSaleId,
    subtotalAdjustmentMinor: negateNonZero(refundSubtotalMinor),
    taxOrVatAdjustmentMinor: negateNonZero(taxReversalPositive),
    gstHstAdjustmentCadMinor: negateNonZero(gstHstReversalPositive),
    provincialTaxAdjustmentCadMinor: negateNonZero(provincialReversalPositive),
    itcAdjustmentCadMinor: negateNonZero(itcReversalPositive),
    grossAdjustmentMinor: negateNonZero(grossPositive),
    remainingRefundableSubtotalMinor:
      originalSubtotalMinor - cumulativeRefundedSubtotal,
    remainingRefundableTaxOrVatMinor:
      originalTaxOrVatMinor -
      (priorRefundedTaxOrVatMinor + taxReversalPositive),
    remainingRefundableItcCadMinor:
      originalItcReceivableCadMinor - cumulativeReversedItc,
  };
}

export type DiscountReasonCode =
  | 'CASH_ROUNDING'
  | 'BUNDLE_DISCOUNT'
  | 'TRANSIT_OR_SHOP_DAMAGE'
  | 'AGED_INVENTORY_CLEARANCE';

const VALID_ADMIN_DISCOUNT_REASONS = new Set<string>([
  'CASH_ROUNDING',
  'BUNDLE_DISCOUNT',
  'TRANSIT_OR_SHOP_DAMAGE',
  'AGED_INVENTORY_CLEARANCE',
]);

export interface CheckoutPriceFloorInput {
  readonly marketNode: SaleMarketNode;
  readonly floorPriceAtCheckoutMinor: number;
  readonly subtotalMinor: number;
  readonly grossCollectedMinor?: number;
  readonly actor: ActorContext;
  readonly discountReasonCode?: string | null;
  readonly cfoOverride?: TrustedCfoApprovalInput | null;
}

export type PriceFloorTier =
  | 'TIER_1_AT_OR_ABOVE_FLOOR'
  | 'TIER_2_ADMIN_CORRIDOR'
  | 'TIER_3_CFO_OVERRIDE';

export interface CheckoutPriceFloorResult extends GateDecision {
  readonly tier: PriceFloorTier;
  readonly floorPriceAtCheckoutMinor: number;
  readonly evaluatedPriceMinor: number;
  readonly discountAmountMinor: number;
  readonly maxAdminDiscountMinor: number;
  readonly acceptedDiscountReasonCode: string | null;
}

export function evaluateCheckoutPriceFloor(
  input: CheckoutPriceFloorInput,
  policy: Pick<PricingAndCompliancePolicy, 'checkoutPolicy'>,
): CheckoutPriceFloorResult {
  const floorMinor = assertNonNegativeSafeInt(
    input.floorPriceAtCheckoutMinor,
    'floorPriceAtCheckoutMinor',
  );
  const subtotalMinor = assertNonNegativeSafeInt(
    input.subtotalMinor,
    'subtotalMinor',
  );
  const grossMinor =
    input.grossCollectedMinor !== undefined
      ? assertNonNegativeSafeInt(
          input.grossCollectedMinor,
          'grossCollectedMinor',
        )
      : subtotalMinor;

  const evaluatedPriceMinor =
    input.marketNode === 'DOMESTIC_ORIGIN' ? subtotalMinor : grossMinor;
  const discountAmountMinor = Math.max(0, floorMinor - evaluatedPriceMinor);

  let maxAdminDiscountMinor = 0;
  if (input.marketNode === 'DOMESTIC_ORIGIN') {
    maxAdminDiscountMinor = multiplyMinorByBpsHalfUp(
      floorMinor,
      policy.checkoutPolicy.domesticAdminDiscountToleranceBps,
      'domesticAdminDiscount',
    );
  } else {
    const pctBand = multiplyMinorByBpsHalfUp(
      floorMinor,
      policy.checkoutPolicy.vaultAdminDiscountToleranceBps,
      'vaultAdminDiscountBand',
    );
    maxAdminDiscountMinor = Math.min(
      policy.checkoutPolicy.vaultAdminMaxDiscountCapTtdMinor,
      Math.max(
        policy.checkoutPolicy.vaultAdminSmallRoundingAllowanceTtdMinor,
        pctBand,
      ),
    );
  }

  // Tier 1: At or above floor
  if (discountAmountMinor === 0) {
    return {
      allowed: true,
      tier: 'TIER_1_AT_OR_ABOVE_FLOOR',
      floorPriceAtCheckoutMinor: floorMinor,
      evaluatedPriceMinor,
      discountAmountMinor: 0,
      maxAdminDiscountMinor,
      acceptedDiscountReasonCode: null,
      blockingCodes: [],
      warnings: [],
      overrideApplied: false,
      cfoOverrideAudit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
    };
  }

  // Tier 2: Within Admin Negotiation Corridor
  if (discountAmountMinor <= maxAdminDiscountMinor) {
    const allowedRole =
      input.marketNode === 'DOMESTIC_ORIGIN'
        ? input.actor.actorRole === 'HUNTER_MECHANIC' ||
          input.actor.actorRole === 'ARCHITECT_CFO'
        : input.actor.actorRole === 'TRINIDAD_VAULT_ADMIN' ||
          input.actor.actorRole === 'ARCHITECT_CFO';

    const blockingCodes: DomainRuleErrorCode[] = [];
    if (!allowedRole) {
      blockingCodes.push('DISCOUNT_ROLE_UNAUTHORIZED');
    }

    const trimmedReason = input.discountReasonCode?.trim() ?? null;
    const validAdminReason =
      trimmedReason !== null && VALID_ADMIN_DISCOUNT_REASONS.has(trimmedReason);

    const overrideEval = evaluateCfoOverride(input.actor, input.cfoOverride);
    if (overrideEval.requested && overrideEval.valid) {
      return {
        allowed: true,
        tier: 'TIER_2_ADMIN_CORRIDOR',
        floorPriceAtCheckoutMinor: floorMinor,
        evaluatedPriceMinor,
        discountAmountMinor,
        maxAdminDiscountMinor,
        acceptedDiscountReasonCode:
          validAdminReason ? trimmedReason : 'CFO_CUSTOM_OVERRIDE',
        blockingCodes: [],
        warnings: [],
        overrideApplied: true,
        cfoOverrideAudit: overrideEval.audit,
      };
    }

    if (!validAdminReason) {
      blockingCodes.push('DISCOUNT_REASON_REQUIRED');
    }

    return {
      allowed: blockingCodes.length === 0,
      tier: 'TIER_2_ADMIN_CORRIDOR',
      floorPriceAtCheckoutMinor: floorMinor,
      evaluatedPriceMinor,
      discountAmountMinor,
      maxAdminDiscountMinor,
      acceptedDiscountReasonCode:
        blockingCodes.length === 0 ? trimmedReason : null,
      blockingCodes,
      warnings: [],
      overrideApplied: false,
      cfoOverrideAudit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
    };
  }

  // Tier 3: Beyond Admin Corridor -> CFO Override required
  const overrideEval = evaluateCfoOverride(input.actor, input.cfoOverride, {
    allowDirectCfoExecutionWithoutEnvelope: true,
  });

  if (overrideEval.valid) {
    return {
      allowed: true,
      tier: 'TIER_3_CFO_OVERRIDE',
      floorPriceAtCheckoutMinor: floorMinor,
      evaluatedPriceMinor,
      discountAmountMinor,
      maxAdminDiscountMinor,
      acceptedDiscountReasonCode: 'CFO_CUSTOM_OVERRIDE',
      blockingCodes: [],
      warnings: [],
      overrideApplied: true,
      cfoOverrideAudit: overrideEval.audit,
    };
  }

  const blockingCodes: DomainRuleErrorCode[] = ['FLOOR_PRICE_OVERRIDE_REQUIRED'];
  if (overrideEval.failureCode !== null) {
    blockingCodes.push(overrideEval.failureCode);
  }

  return {
    allowed: false,
    tier: 'TIER_3_CFO_OVERRIDE',
    floorPriceAtCheckoutMinor: floorMinor,
    evaluatedPriceMinor,
    discountAmountMinor,
    maxAdminDiscountMinor,
    acceptedDiscountReasonCode: null,
    blockingCodes,
    warnings: [],
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
  };
}

export interface PrepaidExportItemInput {
  readonly itemId: string;
  readonly itemType: 'PART' | 'VEHICLE';
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
  readonly bankSettledAt: Date | string | null;
  readonly bankDepositReference: string | null;
  readonly isVoidedOrReversed: boolean;
  readonly ebaySyncState?: EbaySyncState;
  readonly partCustodyState?: PartCustodyState;
  readonly availabilityState?: InventoryAvailabilityState;
}

export interface PrepaidExportGateInput {
  readonly items: ReadonlyArray<PrepaidExportItemInput>;
  readonly actor?: ActorContext;
  readonly cfoOverride?: TrustedCfoApprovalInput | null;
}

export interface PrepaidExportGateResult
  extends GateDecision<'PREPAID_EXPORT_REQUIRED' | 'EXPORT_ITEMS_REQUIRED' | 'EXPORT_LOCK_NOT_CONFIRMED'> {
  readonly unconfirmedItemIds: readonly string[];
}

/**
 * Evaluates RULE-EXP-001 (100% Pre-Paid Origin Export Gate).
 * Even CFO approval cannot make pending, float, or unverified funds eligible;
 * every item must hold `BANK_SETTLEMENT_CONFIRMED` + `SETTLED_ORIGIN_CORP_BANK`
 * with valid `bankSettledAt` and non-empty `bankDepositReference`.
 */
export function evaluatePrepaidExportGate(
  input: PrepaidExportGateInput,
  policy: Pick<PricingAndCompliancePolicy, 'exportPolicy'>,
): PrepaidExportGateResult {
  if (input.items.length === 0) {
    return {
      allowed: false,
      blockingCodes: ['EXPORT_ITEMS_REQUIRED'],
      warnings: [],
      unconfirmedItemIds: [],
      overrideApplied: false,
      cfoOverrideAudit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
    };
  }

  const requiresPrepayment =
    policy.exportPolicy.exportFulfillmentMode === 'PREPAID_ORIGIN_ONLY' ||
    policy.exportPolicy.requireFullPrepaymentBeforeShipmentSeal;

  const blockingCodes = new Set<
    'PREPAID_EXPORT_REQUIRED' | 'EXPORT_LOCK_NOT_CONFIRMED'
  >();
  const unconfirmedItemIds: string[] = [];

  for (const item of input.items) {
    let itemFailed = false;
    if (requiresPrepayment) {
      let validSettledTimestamp = false;
      if (item.bankSettledAt !== null) {
        try {
          parseUtcDate(item.bankSettledAt, 'bankSettledAt');
          validSettledTimestamp = true;
        } catch {
          validSettledTimestamp = false;
        }
      }

      const isBankConfirmed =
        item.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' &&
        item.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' &&
        validSettledTimestamp &&
        isNonEmptyTrimmedString(item.bankDepositReference) &&
        item.isVoidedOrReversed === false;

      if (!isBankConfirmed) {
        blockingCodes.add('PREPAID_EXPORT_REQUIRED');
        itemFailed = true;
      }
    }

    if (item.itemType === 'PART') {
      const lockBlocked =
        item.ebaySyncState === 'EXPORT_LOCK_PENDING' ||
        item.ebaySyncState === 'SYNDICATED_LIVE' ||
        item.ebaySyncState === 'CSV_EXPORTED_PENDING_CONFIRMATION' ||
        item.ebaySyncState === 'DELIST_PENDING' ||
        item.partCustodyState === 'STRIPPED_RAW_OFFLINE' ||
        item.partCustodyState === 'RESTOCKED_QC_HOLD' ||
        item.partCustodyState === 'SCRAPPED_OR_DAMAGED' ||
        item.availabilityState === 'COMMITTED_DOMESTIC_SALE' ||
        item.availabilityState === 'RETURNED_QC_HOLD';
      if (lockBlocked) {
        blockingCodes.add('EXPORT_LOCK_NOT_CONFIRMED');
        itemFailed = true;
      }
    }

    if (itemFailed) {
      unconfirmedItemIds.push(item.itemId);
    }
  }

  return {
    allowed: blockingCodes.size === 0,
    blockingCodes: [...blockingCodes],
    warnings: [],
    unconfirmedItemIds,
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
  };
}

export interface VaultLandedCostInput {
  readonly allocatedCostCadMinor: number;
  readonly wholesaleFobUsdMinor: number;
  readonly weightKg: number;
  readonly araGrade: AraConditionGradeEnum;
  readonly compBaselineCadMinor?: number | null;
  readonly dutyRateOverride?: number;
  readonly brokerCommissionRateOverride?: number;
}

export interface VaultLandedCostResult {
  readonly freightUsdMinor: number;
  readonly insuranceUsdMinor: number;
  readonly cifUsdMinor: number;
  readonly cifTtdMinor: number;
  readonly dutyAndFeesTtdMinor: number;
  readonly importVatTtdMinor: number;
  readonly freightAndInsuranceShadowTtdMinor: number;
  readonly totalTaxesAndFreightTtdMinor: number;
  readonly landedCostTtdMinor: number;
  readonly principalCostPlusMarkupTtdMinor: number;
  readonly vaultFloorPriceTtdMinor: number;
  readonly gradeAdjustedMarketValueCadMinor: number | null;
  readonly recommendedAskTtdMinor: number | null;
}

/**
 * Dormant Trinidad Vault Landed Cost & Floor Calculator (DOMAIN-RULES.md §4.2).
 * Uses exact rational arithmetic with `BigInt` intermediates and ceiling division
 * at the final `(1 - brokerCommissionRate)` division so rounding cannot undercut the floor.
 */
export function computeVaultLandedCostAndFloor(
  input: VaultLandedCostInput,
  policy: Pick<
    PricingAndCompliancePolicy,
    | 'fxRates'
    | 'trinidadImportTax'
    | 'oceanFreight'
    | 'marginsAndCommissions'
    | 'araGradeMultipliers'
  >,
): VaultLandedCostResult {
  const allocatedCostCadMinor = assertNonNegativeSafeInt(
    input.allocatedCostCadMinor,
    'allocatedCostCadMinor',
  );
  const wholesaleFobUsdMinor = assertNonNegativeSafeInt(
    input.wholesaleFobUsdMinor,
    'wholesaleFobUsdMinor',
  );
  if (
    typeof input.weightKg !== 'number' ||
    !Number.isFinite(input.weightKg) ||
    input.weightKg < 0
  ) {
    throw new DomainRuleError(
      'INVALID_PART_WEIGHT',
      'weightKg must be a finite non-negative number.',
      { weightKg: input.weightKg },
    );
  }

  const commissionRate =
    input.brokerCommissionRateOverride ??
    policy.marginsAndCommissions.defaultBrokerCommissionRate;
  if (
    typeof commissionRate !== 'number' ||
    !Number.isFinite(commissionRate) ||
    commissionRate < 0 ||
    commissionRate >= 1
  ) {
    throw new DomainRuleError(
      'INVALID_BROKER_COMMISSION_RATE',
      'brokerCommissionRate must be in [0, 1).',
      { commissionRate },
    );
  }

  const dutyRate =
    input.dutyRateOverride ?? policy.trinidadImportTax.defaultAutoPartsDutyRate;
  if (
    typeof dutyRate !== 'number' ||
    !Number.isFinite(dutyRate) ||
    dutyRate < 0 ||
    dutyRate > 1
  ) {
    throw new DomainRuleError(
      'INVALID_DECIMAL_RATE',
      'dutyRate must be in [0, 1].',
      { dutyRate },
    );
  }

  const araMultiplier = Object.hasOwn(
    policy.araGradeMultipliers,
    input.araGrade,
  )
    ? policy.araGradeMultipliers[input.araGrade]
    : undefined;
  if (araMultiplier === undefined) {
    throw new DomainRuleError(
      'INVALID_ARA_GRADE',
      `No ARA multiplier configured for "${input.araGrade}".`,
    );
  }

  // 1. CIF USD
  const weightRational = parseDecimalToRational(input.weightKg, 'weightKg');
  const freightPerKgRational = parseDecimalToRational(
    policy.oceanFreight.allocatedLclFreightUsdPerKg,
    'allocatedLclFreightUsdPerKg',
  );
  const freightUsdRational = multiplyRationals(
    weightRational,
    freightPerKgRational,
  );
  const freightUsdMinor = multiplyMinorByRationalHalfUp(
    100,
    freightUsdRational.num,
    freightUsdRational.den,
    'freightUsdMinor',
  );
  const insuranceUsdMinor = multiplyMinorByRateHalfUp(
    wholesaleFobUsdMinor,
    policy.oceanFreight.marineInsuranceRateOfFob,
    'insuranceUsdMinor',
  );
  const freightAndInsuranceUsdMinor = checkedAdd(
    freightUsdMinor,
    insuranceUsdMinor,
    'freightAndInsuranceUsdMinor',
  );
  const cifUsdMinor = checkedAdd(
    wholesaleFobUsdMinor,
    freightAndInsuranceUsdMinor,
    'cifUsdMinor',
  );

  // 2. Assessed Customs Duty & Compounded Import VAT (Official Customs FX)
  const cifTtdMinor = multiplyMinorByRateHalfUp(
    cifUsdMinor,
    policy.fxRates.usdToTtdOfficialCustoms,
    'cifTtdMinor',
  );
  const dutyPlusProcRational = addRationals(
    parseDecimalToRational(dutyRate, 'dutyRate'),
    parseDecimalToRational(
      policy.trinidadImportTax.customsProcessingFeeRate,
      'customsProcessingFeeRate',
    ),
  );
  const dutyAndFeesTtdMinor = multiplyMinorByRationalHalfUp(
    cifTtdMinor,
    dutyPlusProcRational.num,
    dutyPlusProcRational.den,
    'dutyAndFeesTtdMinor',
  );
  const importVatTtdMinor = multiplyMinorByRateHalfUp(
    checkedAdd(cifTtdMinor, dutyAndFeesTtdMinor, 'vatBaseTtdMinor'),
    policy.trinidadImportTax.vatRate,
    'importVatTtdMinor',
  );

  // 3. Freight & Insurance Shadow Repatriation + VAT Register Branch
  const freightAndInsuranceShadowTtdMinor = multiplyMinorByRateHalfUp(
    freightAndInsuranceUsdMinor,
    policy.fxRates.usdToTtdShadowRepatriation,
    'freightAndInsuranceShadowTtdMinor',
  );

  const recoverableImportVat =
    policy.trinidadImportTax.isTrinidadEntityVatRegistered;
  const totalTaxesAndFreightTtdMinor = checkedAdd(
    dutyAndFeesTtdMinor,
    checkedAdd(
      recoverableImportVat ? 0 : importVatTtdMinor,
      freightAndInsuranceShadowTtdMinor,
      'vatAndShadowFreightTtd',
    ),
    'totalTaxesAndFreightTtdMinor',
  );

  const landedCostTtdMinor = checkedAdd(
    cifTtdMinor,
    checkedAdd(
      dutyAndFeesTtdMinor,
      recoverableImportVat ? 0 : importVatTtdMinor,
      'landedDutyAndVat',
    ),
    'landedCostTtdMinor',
  );

  // 4. Principal Protection + Floor Price (ceil division by 1 - r_comm)
  const markupFactor = addRationals(
    { num: 1n, den: 1n },
    parseDecimalToRational(
      policy.marginsAndCommissions.targetExportMarkupOnCost,
      'targetExportMarkupOnCost',
    ),
  );
  const spotRational = parseDecimalToRational(
    policy.fxRates.cadToUsdSpot,
    'cadToUsdSpot',
  );
  const shadowRational = parseDecimalToRational(
    policy.fxRates.usdToTtdShadowRepatriation,
    'usdToTtdShadowRepatriation',
  );
  const principalFactor = multiplyRationals(
    multiplyRationals(markupFactor, spotRational),
    shadowRational,
  );
  const principalCostPlusMarkupTtdMinor = multiplyMinorByRationalHalfUp(
    allocatedCostCadMinor,
    principalFactor.num,
    principalFactor.den,
    'principalCostPlusMarkupTtdMinor',
  );

  const numeratorTtdMinor = checkedAdd(
    principalCostPlusMarkupTtdMinor,
    totalTaxesAndFreightTtdMinor,
    'vaultFloorNumeratorTtdMinor',
  );

  const oneMinusComm = subtractRationals(
    { num: 1n, den: 1n },
    parseDecimalToRational(commissionRate, 'brokerCommissionRate'),
  );
  const vaultFloorBigInt = divideBigIntCeil(
    BigInt(numeratorTtdMinor) * oneMinusComm.den,
    oneMinusComm.num,
  );
  const vaultFloorPriceTtdMinor = bigIntToSafeNumber(
    vaultFloorBigInt,
    'vaultFloorPriceTtdMinor',
  );

  // 5. Grade-Adjusted Market Baseline & Recommended Ask (distinct from hard floor)
  let gradeAdjustedMarketValueCadMinor: number | null = null;
  let recommendedAskTtdMinor: number | null = null;
  if (
    input.compBaselineCadMinor !== undefined &&
    input.compBaselineCadMinor !== null
  ) {
    const compBaseline = assertNonNegativeSafeInt(
      input.compBaselineCadMinor,
      'compBaselineCadMinor',
    );
    gradeAdjustedMarketValueCadMinor = multiplyMinorByRateHalfUp(
      compBaseline,
      araMultiplier,
      'gradeAdjustedMarketValueCadMinor',
    );
    const cadToTtdShadow = multiplyRationals(spotRational, shadowRational);
    recommendedAskTtdMinor = multiplyMinorByRationalHalfUp(
      gradeAdjustedMarketValueCadMinor,
      cadToTtdShadow.num,
      cadToTtdShadow.den,
      'recommendedAskTtdMinor',
    );
  }

  return {
    freightUsdMinor,
    insuranceUsdMinor,
    cifUsdMinor,
    cifTtdMinor,
    dutyAndFeesTtdMinor,
    importVatTtdMinor,
    freightAndInsuranceShadowTtdMinor,
    totalTaxesAndFreightTtdMinor,
    landedCostTtdMinor,
    principalCostPlusMarkupTtdMinor,
    vaultFloorPriceTtdMinor,
    gradeAdjustedMarketValueCadMinor,
    recommendedAskTtdMinor,
  };
}

/**
 * RULE-PRC-002: Broker commission is strictly calculated on pre-tax subtotal.
 */
export function computeBrokerCommissionMinor(
  subtotalMinor: number,
  brokerCommissionBps: number,
): number {
  const subtotal = assertNonNegativeSafeInt(subtotalMinor, 'subtotalMinor');
  return multiplyMinorByBpsHalfUp(
    subtotal,
    brokerCommissionBps,
    'brokerCommissionMinor',
  );
}
