import { z } from 'zod';

export const CANADIAN_PROVINCE_OR_TERRITORY_CODES = [
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
] as const;

export type CanadianProvinceOrTerritoryCode =
  (typeof CANADIAN_PROVINCE_OR_TERRITORY_CODES)[number];

const finitePositiveNumber = z.number().finite().positive();
const finiteNonNegativeNumber = z.number().finite().min(0);
const fractionRate = z.number().finite().min(0).max(1);
const nonNegativeSafeInt = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const basisPointsInt = z.number().int().min(0).max(10_000);

const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeRecordKeySchema() {
  return z
    .string()
    .min(1)
    .refine((key) => !FORBIDDEN_RECORD_KEYS.has(key), {
      message: 'Forbidden object key',
    });
}

export const PolicyMetadataSchema = z
  .object({
    verificationStatus: z.string().min(1),
    effectiveDate: z.string().min(1),
    source: z.string().min(1),
    approvedBy: z.string().min(1),
  })
  .strict();

export type PolicyMetadata = z.infer<typeof PolicyMetadataSchema>;

export const FxRatesSchema = z
  .object({
    cadToUsdSpot: finitePositiveNumber,
    usdToTtdOfficialCustoms: finitePositiveNumber,
    usdToTtdShadowRepatriation: finitePositiveNumber,
  })
  .strict();

export const TrinidadImportTaxSchema = z
  .object({
    isTrinidadEntityVatRegistered: z.boolean(),
    defaultAutoPartsDutyRate: fractionRate,
    customsProcessingFeeRate: fractionRate,
    vatRate: fractionRate,
  })
  .strict();

export const OceanFreightSchema = z
  .object({
    allocatedLclFreightUsdPerKg: finiteNonNegativeNumber,
    marineInsuranceRateOfFob: fractionRate,
  })
  .strict();

export const MarginsAndCommissionsSchema = z
  .object({
    targetExportMarkupOnCost: finiteNonNegativeNumber,
    defaultBrokerCommissionRate: fractionRate,
    minBeaterNetProfitCadMinor: nonNegativeSafeInt,
    minRebuildNetProfitCadMinor: nonNegativeSafeInt,
    minPartOutRoiMultiplier: finiteNonNegativeNumber,
  })
  .strict();

export const CanadianProvincialGstHstRatesBpsSchema = z
  .object({
    ON: basisPointsInt,
    NS: basisPointsInt,
    NB: basisPointsInt,
    NL: basisPointsInt,
    PE: basisPointsInt,
    QC: basisPointsInt,
    BC: basisPointsInt,
    AB: basisPointsInt,
    MB: basisPointsInt,
    SK: basisPointsInt,
    YT: basisPointsInt,
    NT: basisPointsInt,
    NU: basisPointsInt,
  })
  .strict();

export const ProvincialPstRegistrationEntrySchema = z
  .object({
    registered: z.boolean(),
    rate: fractionRate,
  })
  .strict();

export const ProvincialPstRegistrationsSchema = z
  .object({
    BC: ProvincialPstRegistrationEntrySchema.optional(),
    SK: ProvincialPstRegistrationEntrySchema.optional(),
    MB: ProvincialPstRegistrationEntrySchema.optional(),
    QC: ProvincialPstRegistrationEntrySchema.optional(),
  })
  .strict();

export const DomesticTaxPolicySchema = z
  .object({
    isGstHstRegistered: z.boolean(),
    isOntarioEntityHstRegistered: z.boolean(),
    isOntarioHstRegistered: z.boolean(),
    isOmvicLicensed: z.boolean(),
    ontarioHstRate: fractionRate,
    canadianProvincialGstHstRatesBps: CanadianProvincialGstHstRatesBpsSchema,
    provincialPstRegistrations: ProvincialPstRegistrationsSchema,
    requireVerifiedTaxInvoiceForFeeItc: z.boolean(),
    publicPickupCityLabel: z.string().min(1),
  })
  .strict();

export const ComplianceThresholdsSchema = z
  .object({
    trinidadFiuCddThresholdTtdMinor: nonNegativeSafeInt,
    trinidadFiuLargeCashReportTtdMinor: nonNegativeSafeInt,
    trinidadDepositInsuranceCapTtdMinor: nonNegativeSafeInt,
    trinidadDepositAlertThresholdTtdMinor: nonNegativeSafeInt,
    cbsaCersValueThresholdCadMinor: nonNegativeSafeInt,
    cbsaMarineCutoffHours: nonNegativeSafeInt,
    driveOnReinspectionWindowDays: nonNegativeSafeInt,
    safetyStandardsCertMaxDays: nonNegativeSafeInt,
    easrRegistrationNumber: z.string().min(1).nullable(),
    easrActiveElvThreshold: nonNegativeSafeInt,
    minRecordRetentionYears: nonNegativeSafeInt,
  })
  .strict();

export const WorkingCapitalTrancheInputSchema = z
  .object({
    trancheCode: z.string().min(1),
    principalCadMinor: nonNegativeSafeInt,
    unlocked: z.boolean(),
    minShelvedSkus: nonNegativeSafeInt.optional(),
    minScrappedDonors: nonNegativeSafeInt.optional(),
    requireZeroOverdueFloatReceipts: z.boolean().optional(),
  })
  .strict();

export const WorkingCapitalTrancheSchema = z
  .object({
    trancheCode: z.string().min(1),
    principalCadMinor: nonNegativeSafeInt,
    unlocked: z.boolean(),
    minShelvedSkus: nonNegativeSafeInt,
    minScrappedDonors: nonNegativeSafeInt,
    requireZeroOverdueFloatReceipts: z.boolean(),
  })
  .strict();

const WorkingCapitalGateFields = {
  enabled: z.boolean(),
  enforcementMode: z.enum(['HARD_BLOCK', 'WARN_ONLY', 'DISABLED']),
  totalCommittedLoanFacilityCadMinor: nonNegativeSafeInt,
  initialSeedCapitalCadMinor: nonNegativeSafeInt,
  minCashReserveFloorCadMinor: nonNegativeSafeInt,
  countPendingExportCashAsAvailable: z.boolean(),
  countPendingDomesticReceivablesAsAvailable: z.boolean(),
  countOperatorFloatInBankWorkingCapital: z.boolean(),
};

export const WorkingCapitalGateInputSchema = z
  .object({
    ...WorkingCapitalGateFields,
    tranches: z.array(WorkingCapitalTrancheInputSchema),
  })
  .strict();

export const WorkingCapitalGateSchema = z
  .object({
    ...WorkingCapitalGateFields,
    tranches: z.array(WorkingCapitalTrancheSchema),
  })
  .strict();

export const DealDisciplineGateSchema = z
  .object({
    maxDonorDismantleLandedCadMinor: nonNegativeSafeInt,
    enableHighEndRebuildLane: z.boolean(),
  })
  .strict();

export const LocationCapacityGateSchema = z
  .object({
    enforcementMode: z.enum(['HARD_BLOCK', 'WARN_ONLY', 'DISABLED']),
  })
  .strict();

export const OperationalGatesInputSchema = z
  .object({
    complianceEnforcementMode: z.enum(['WARN_ONLY', 'STRICT_BLOCK']),
    workingCapitalGate: WorkingCapitalGateInputSchema,
    dealDisciplineGate: DealDisciplineGateSchema,
    locationCapacityGate: LocationCapacityGateSchema,
  })
  .strict();

export const OperationalGatesSchema = z
  .object({
    complianceEnforcementMode: z.enum(['WARN_ONLY', 'STRICT_BLOCK']),
    workingCapitalGate: WorkingCapitalGateSchema,
    dealDisciplineGate: DealDisciplineGateSchema,
    locationCapacityGate: LocationCapacityGateSchema,
  })
  .strict();

export const ExpensePolicySchema = z
  .object({
    pettyCashVoucherMaxCadMinor: nonNegativeSafeInt,
    monthlyUnreceiptedVoucherCapCadMinor: nonNegativeSafeInt,
  })
  .strict();

export const CheckoutPolicySchema = z
  .object({
    checkoutStrictnessMode: z.enum([
      'BONDED_VAULT_STRICT',
      'AUDIT_ENFORCED',
      'STANDARD_POS',
    ]),
    vaultAdminDiscountToleranceBps: basisPointsInt,
    vaultAdminSmallRoundingAllowanceTtdMinor: nonNegativeSafeInt,
    vaultAdminMaxDiscountCapTtdMinor: nonNegativeSafeInt,
    domesticAdminDiscountToleranceBps: basisPointsInt,
  })
  .strict();

export const ExportPolicySchema = z
  .object({
    exportFulfillmentMode: z.enum([
      'PREPAID_ORIGIN_ONLY',
      'BONDED_DESTINATION_VAULT_COD',
    ]),
    requireFullPrepaymentBeforeShipmentSeal: z.boolean(),
  })
  .strict();

export const DomesticSyndicationSchema = z
  .object({
    publicPickupLocationLabel: z.string().min(1),
    ebayShipFromCity: z.string().min(1),
    ebayShipFromPostalCode: z.string().min(1),
    heavyLocalOnlyThresholdKg: finitePositiveNumber,
    ebaySiteId: z.string().min(1),
    ebayCurrency: z.enum(['CAD', 'USD']),
  })
  .strict();

export const SiteZoningLimitsSchema = z
  .object({
    kemptvilleMaxUncrushedShellsOnPad: nonNegativeSafeInt,
    kemptvilleContainerCount: nonNegativeSafeInt,
    ramsayvilleMaxActiveShopVehicles: nonNegativeSafeInt,
  })
  .strict();

export const CompensationRulesSchema = z
  .object({
    stripperPieceRatePerVehicleCadMinor: nonNegativeSafeInt,
    minShelvedPartsForStripPayout: nonNegativeSafeInt,
    allowFounderDrawFromSeedCapital: z.boolean(),
    autoOffsetHunterDrawAgainstFloat: z.boolean(),
  })
  .strict();

export const CannabisComplianceSchema = z
  .object({
    microCultivationMaxCanopySqm: finiteNonNegativeNumber,
    microProcessingAnnualDriedEquivMaxKg: finiteNonNegativeNumber,
    extractNonDiscreteContainerMaxThcMg: nonNegativeSafeInt,
    requireSecondWitnessForExciseStampedDestruction: z.boolean(),
    minRecordRetentionYears: nonNegativeSafeInt,
    adverseReactionRetentionYears: nonNegativeSafeInt,
    wetToDryMoistureLossMinPct: fractionRate,
    wetToDryMoistureLossMaxPct: fractionRate,
    biomassToCrudeExtractYieldMinPct: fractionRate,
    biomassToCrudeExtractYieldMaxPct: fractionRate,
    crudeToDistillateRefinementYieldMinPct: fractionRate,
    crudeToDistillateRefinementYieldMaxPct: fractionRate,
    maxUnaccountedVarianceAlertPct: fractionRate,
  })
  .strict();

const DomesticChannelFeesSchema = z.record(safeRecordKeySchema(), fractionRate);
const AraGradeMultipliersSchema = z.record(
  safeRecordKeySchema(),
  finitePositiveNumber,
);

const BasePolicyInputFields = {
  metadata: PolicyMetadataSchema.optional(),
  fxRates: FxRatesSchema,
  trinidadImportTax: TrinidadImportTaxSchema,
  oceanFreight: OceanFreightSchema,
  marginsAndCommissions: MarginsAndCommissionsSchema,
  domesticChannelFees: DomesticChannelFeesSchema,
  domesticTaxPolicy: DomesticTaxPolicySchema,
  araGradeMultipliers: AraGradeMultipliersSchema,
  complianceThresholds: ComplianceThresholdsSchema,
  expensePolicy: ExpensePolicySchema,
  checkoutPolicy: CheckoutPolicySchema,
  exportPolicy: ExportPolicySchema,
  domesticSyndication: DomesticSyndicationSchema,
  siteZoningLimits: SiteZoningLimitsSchema,
  compensationRules: CompensationRulesSchema,
  cannabisCompliance: CannabisComplianceSchema,
};

function addPolicyCrossFieldIssues(
  data: {
    domesticTaxPolicy: z.infer<typeof DomesticTaxPolicySchema>;
    operationalGates: {
      workingCapitalGate: {
        totalCommittedLoanFacilityCadMinor: number;
        tranches: Array<{ trancheCode: string; principalCadMinor: number }>;
      };
    };
    cannabisCompliance: z.infer<typeof CannabisComplianceSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  const {
    isGstHstRegistered,
    isOntarioEntityHstRegistered,
    isOntarioHstRegistered,
  } = data.domesticTaxPolicy;

  if (isOntarioEntityHstRegistered !== isGstHstRegistered) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['domesticTaxPolicy', 'isOntarioEntityHstRegistered'],
      message:
        'isOntarioEntityHstRegistered must match canonical isGstHstRegistered.',
    });
  }

  if (isOntarioHstRegistered !== isGstHstRegistered) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['domesticTaxPolicy', 'isOntarioHstRegistered'],
      message:
        'isOntarioHstRegistered must match canonical isGstHstRegistered.',
    });
  }

  const gate = data.operationalGates.workingCapitalGate;
  const seenCodes = new Set<string>();
  let principalSum = 0;

  for (let i = 0; i < gate.tranches.length; i += 1) {
    const tranche = gate.tranches[i]!;
    if (seenCodes.has(tranche.trancheCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationalGates', 'workingCapitalGate', 'tranches', i, 'trancheCode'],
        message: `Duplicate working capital trancheCode: ${tranche.trancheCode}`,
      });
    }
    seenCodes.add(tranche.trancheCode);
    principalSum += tranche.principalCadMinor;
  }

  if (principalSum !== gate.totalCommittedLoanFacilityCadMinor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operationalGates', 'workingCapitalGate', 'totalCommittedLoanFacilityCadMinor'],
      message:
        'Sum of tranche principalCadMinor must equal totalCommittedLoanFacilityCadMinor.',
    });
  }

  const c = data.cannabisCompliance;
  if (c.wetToDryMoistureLossMinPct > c.wetToDryMoistureLossMaxPct) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cannabisCompliance', 'wetToDryMoistureLossMinPct'],
      message: 'wetToDryMoistureLossMinPct cannot exceed wetToDryMoistureLossMaxPct.',
    });
  }
  if (c.biomassToCrudeExtractYieldMinPct > c.biomassToCrudeExtractYieldMaxPct) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cannabisCompliance', 'biomassToCrudeExtractYieldMinPct'],
      message:
        'biomassToCrudeExtractYieldMinPct cannot exceed biomassToCrudeExtractYieldMaxPct.',
    });
  }
  if (
    c.crudeToDistillateRefinementYieldMinPct >
    c.crudeToDistillateRefinementYieldMaxPct
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cannabisCompliance', 'crudeToDistillateRefinementYieldMinPct'],
      message:
        'crudeToDistillateRefinementYieldMinPct cannot exceed crudeToDistillateRefinementYieldMaxPct.',
    });
  }
}

export const PricingAndCompliancePolicyInputSchema = z
  .object({
    ...BasePolicyInputFields,
    operationalGates: OperationalGatesInputSchema,
  })
  .strict()
  .superRefine(addPolicyCrossFieldIssues);

export type PricingAndCompliancePolicyInput = z.infer<
  typeof PricingAndCompliancePolicyInputSchema
>;

export const PricingAndCompliancePolicySchema = z
  .object({
    ...BasePolicyInputFields,
    operationalGates: OperationalGatesSchema,
  })
  .strict()
  .superRefine(addPolicyCrossFieldIssues);

export type PricingAndCompliancePolicy = z.infer<
  typeof PricingAndCompliancePolicySchema
>;

export const PricingAndCompliancePolicyOverrideSchema = z
  .object({
    metadata: PolicyMetadataSchema.partial().strict().optional(),
    fxRates: FxRatesSchema.partial().strict().optional(),
    trinidadImportTax: TrinidadImportTaxSchema.partial().strict().optional(),
    oceanFreight: OceanFreightSchema.partial().strict().optional(),
    marginsAndCommissions: MarginsAndCommissionsSchema.partial()
      .strict()
      .optional(),
    domesticChannelFees: DomesticChannelFeesSchema.optional(),
    domesticTaxPolicy: DomesticTaxPolicySchema.extend({
      canadianProvincialGstHstRatesBps:
        CanadianProvincialGstHstRatesBpsSchema.partial().strict(),
      provincialPstRegistrations: z
        .object({
          BC: ProvincialPstRegistrationEntrySchema.partial().strict().optional(),
          SK: ProvincialPstRegistrationEntrySchema.partial().strict().optional(),
          MB: ProvincialPstRegistrationEntrySchema.partial().strict().optional(),
          QC: ProvincialPstRegistrationEntrySchema.partial().strict().optional(),
        })
        .strict(),
    })
      .partial()
      .strict()
      .optional(),
    araGradeMultipliers: AraGradeMultipliersSchema.optional(),
    complianceThresholds: ComplianceThresholdsSchema.partial()
      .strict()
      .optional(),
    operationalGates: z
      .object({
        complianceEnforcementMode: z
          .enum(['WARN_ONLY', 'STRICT_BLOCK'])
          .optional(),
        workingCapitalGate: WorkingCapitalGateInputSchema.partial()
          .strict()
          .optional(),
        dealDisciplineGate: DealDisciplineGateSchema.partial()
          .strict()
          .optional(),
        locationCapacityGate: LocationCapacityGateSchema.partial()
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    expensePolicy: ExpensePolicySchema.partial().strict().optional(),
    checkoutPolicy: CheckoutPolicySchema.partial().strict().optional(),
    exportPolicy: ExportPolicySchema.partial().strict().optional(),
    domesticSyndication: DomesticSyndicationSchema.partial().strict().optional(),
    siteZoningLimits: SiteZoningLimitsSchema.partial().strict().optional(),
    compensationRules: CompensationRulesSchema.partial().strict().optional(),
    cannabisCompliance: CannabisComplianceSchema.partial().strict().optional(),
  })
  .strict();

export type PricingAndCompliancePolicyOverride = z.infer<
  typeof PricingAndCompliancePolicyOverrideSchema
>;

/**
 * 0. ORGANIZATION-SCOPED POLICY CONFIGURATION PORT
 * In Phase 1A, the default adapter loads and validates src/core/config/pricing-policy.json
 * with Zod, while allowing per-tenant JSON overrides via shared.Organization.policyConfigJson
 * for future Vertical SaaS tenants.
 */
export interface IPolicyConfigPort {
  getPolicyForOrg(organizationId: string): Promise<PricingAndCompliancePolicy>;
}

export interface DecodedAssetSpec {
  identifier: string; // 17-char VIN or 12-char HIN
  assetCategory: 'AUTOMOBILE' | 'WATERCRAFT' | 'SHOP_EQUIPMENT';
  year: number;
  make: string;
  model: string;
  trim: string | null;
  engineSpec: string | null;
  steeringSide: 'LHD_ONLY' | 'RHD_ONLY' | 'UNIVERSAL';
  rawPayload: Record<string, unknown>;
}

/**
 * 1. ASSET DECODER PORT
 * Implemented by CompositeAssetDecoderAdapter (routes 17-char VINs to NHTSA vPIC
 * and 12-char Watercraft HINs to Marine HIN Decoder / manual fallback).
 */
export interface IAssetDecoderPort {
  decodeIdentifier(
    vinOrHin: string,
    modelYearHint?: number,
  ): Promise<DecodedAssetSpec | null>;
}

/**
 * 2. ASSISTIVE AI VISION PORT
 * Outputs are treated as assistive proposals. If confidenceScore < 0.80,
 * Part transitions to NEEDS_HUMAN_REVIEW rather than auto-publishing.
 */
export interface IVisionEnrichmentPort {
  analyzeStrippedPart(input: {
    partId: string;
    sanitizedPublicImageUrls: string[];
    donorSpec?: DecodedAssetSpec;
  }): Promise<{
    extractedOemNumbers: string[];
    partCategoryName: string;
    steeringSideCompatibility: 'UNIVERSAL' | 'LHD_ONLY' | 'RHD_ONLY';
    isHazmatOrAirbag: boolean;
    tdgHazmatCode:
      | 'NONE'
      | 'UN3268_AIRBAG'
      | 'UN0503_PYROTECHNIC'
      | 'UN2794_WET_BATTERY'
      | 'UN3480_LITHIUM_BATTERY';
    suggestedHsCode: string;
    suggestedAraGrade:
      | 'GRADE_A'
      | 'GRADE_B1'
      | 'GRADE_B2'
      | 'GRADE_B3'
      | 'GRADE_C'
      | 'GRADE_X';
    suggestedDamageCode: string;
    draftEbayTitle: string;
    confidenceScore: number;
  }>;
}

/**
 * 3. ZERO-TYPING DOMESTIC SYNDICATION TEMPLATE PORT (PHASE 1A DAY-1 BRIDGE)
 * Deterministically generates <= 80-char SEO eBay titles, HTML descriptions, eBay Seller Hub
 * File Exchange CSV rows (with true ship-from "Kemptville, ON / K0G 1J0" & parent/child
 * Relationship=Compatibility fitment rows), and bylaw-stealth ("Ottawa South / Hwy 416 Corridor")
 * local FB Marketplace / Kijiji classified ad payloads (RULE-MKT-002).
 */
export interface ISyndicationTemplatePort {
  buildPartSyndicationCopy(input: {
    qrSkuCode: string;
    partCategoryName: string;
    oemPartNumbers: string[];
    araGrade:
      | 'GRADE_A'
      | 'GRADE_B1'
      | 'GRADE_B2'
      | 'GRADE_B3'
      | 'GRADE_C'
      | 'GRADE_X';
    araDamageCode: string;
    weightKg: number;
    tdgHazmatCode:
      | 'NONE'
      | 'UN3268_AIRBAG'
      | 'UN0503_PYROTECHNIC'
      | 'UN2794_WET_BATTERY'
      | 'UN3480_LITHIUM_BATTERY';
    retailPriceCadMinor: number;
    sanitizedPublicImageUrls: string[];
    donorVehicle: {
      year: number;
      make: string;
      model: string;
      trim?: string | null;
      engineSpec?: string | null;
      vinOrHin: string;
      odometerKm?: number | null;
      engineHours?: number | null;
    };
    publicPickupLocationLabel: string;
    ebayShipFromCity: string;
    ebayShipFromPostalCode: string;
    heavyLocalOnlyThresholdKg: number;
  }): {
    recommendedPrimaryChannel: 'EBAY_MOTORS_SHIPPED' | 'FB_MARKETPLACE_LOCAL';
    isEbayParcelEligible: boolean;
    ebaySeoTitle80: string;
    ebayHtmlDescription: string;
    localClassifiedsTitle: string;
    localClassifiedsBody: string;
    publicPickupLocationLabel: string;
  };
  exportEbaySellerHubCsv(
    parts: Array<{
      qrSkuCode: string;
      ebaySeoTitle80: string;
      ebayHtmlDescription: string;
      partCategoryName: string;
      oemPartNumbers: string[];
      araGrade: string;
      tdgHazmatCode:
        | 'NONE'
        | 'UN3268_AIRBAG'
        | 'UN0503_PYROTECHNIC'
        | 'UN2794_WET_BATTERY'
        | 'UN3480_LITHIUM_BATTERY';
      retailPriceCadMinor: number;
      sanitizedPublicImageUrls: string[];
      make: string;
      compatibleVehicles?: Array<{
        year: number;
        make: string;
        model: string;
        trim?: string | null;
        engine?: string | null;
      }>;
    }>,
    shipFrom?: { city: string; postalCode: string },
  ): string;
  exportB2bMechanicPowertrainSheet(
    items: Array<{
      qrSkuCode: string;
      year: number;
      make: string;
      model: string;
      engineSpec?: string | null;
      odometerKm?: number | null;
      partCategoryName: string;
      oemPartNumbers: string[];
      araGrade: string;
      wholesaleAskCadMinor: number;
    }>,
  ): {
    whatsappMarkdownText: string;
    csvContent: string;
  };
}

/**
 * 4. LIVE MARKETPLACE API SYNDICATION PORT (PHASE 2A AUTOMATED EBAY API)
 * Uses eBay Inventory API + Browse API (Active competitor pricing fallback,
 * avoiding reliance on restricted Marketplace Insights API).
 */
export interface IMarketplacePort {
  publishOrUpdateOffer(
    sku: string,
  ): Promise<{ listingId: string; offerId: string }>;
  zeroOutInventory(
    sku: string,
    offerId: string,
  ): Promise<{ acknowledged: boolean }>;
  fetchActiveCompetitorComps(
    oemPartNumber: string,
    query: string,
  ): Promise<{
    lowestActiveCadMinor: number;
    medianActiveCadMinor: number;
    activeListingCount: number;
  }>;
}

/**
 * 5. EXTERNAL ACCOUNTING GL SYNC PORT
 * Syncs verified operational subledger transactions to QuickBooks Online / Xero.
 */
export interface IAccountingGlPort {
  postExpenseJournal(expenseId: string): Promise<{ externalGlJournalId: string }>;
  postSaleTransactionJournal(
    saleTransactionId: string,
  ): Promise<{ externalGlJournalId: string }>;
  postFxSettlementJournal(
    settlementBatchId: string,
  ): Promise<{ externalGlJournalId: string }>;
}
