import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertEbayParcelHazmatEligible,
  evaluateEasrElvThreshold,
  evaluateFiuRollingWindow,
} from '../fiu-and-salvage-compliance';
import {
  DomainRuleError,
  computeDomesticSaleTaxAndSettlement,
  computeProvisionalCostBasis,
  computeSeparatedFinancialSnapshot,
  evaluateFiuRollingWindow as evaluateFiuFromBarrel,
  evaluateWorkingCapitalGate,
  validatePartTransition,
  type CheckoutTaxPolicySlice,
  type CompliancePolicySlice,
  type WorkingCapitalPolicySlice,
} from '../index';

const ORG_SALVAGE = 'org-salvage-001';
const ORG_OTHER = 'org-cannabis-002';

function makePolicy(
  overrides: Partial<{
    complianceEnforcementMode: 'WARN_ONLY' | 'STRICT_BLOCK';
    easrRegistrationNumber: string | null;
    easrActiveElvThreshold: number;
  }> = {},
): CompliancePolicySlice & CheckoutTaxPolicySlice & WorkingCapitalPolicySlice {
  return {
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
        AB: 500,
        BC: 500,
        MB: 500,
        SK: 500,
        QC: 500,
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
    complianceThresholds: {
      trinidadFiuCddThresholdTtdMinor: 5_000_000,
      trinidadFiuLargeCashReportTtdMinor: 9_000_000,
      trinidadDepositInsuranceCapTtdMinor: 20_000_000,
      trinidadDepositAlertThresholdTtdMinor: 18_000_000,
      cbsaCersValueThresholdCadMinor: 200_000,
      cbsaMarineCutoffHours: 48,
      driveOnReinspectionWindowDays: 10,
      safetyStandardsCertMaxDays: 36,
      easrRegistrationNumber: overrides.easrRegistrationNumber ?? null,
      easrActiveElvThreshold: overrides.easrActiveElvThreshold ?? 2,
      minRecordRetentionYears: 7,
    },
    operationalGates: {
      complianceEnforcementMode:
        overrides.complianceEnforcementMode ?? 'WARN_ONLY',
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
        ],
      },
      dealDisciplineGate: {
        maxDonorDismantleLandedCadMinor: 320_000,
        enableHighEndRebuildLane: false,
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
    },
  };
}

describe('Trinidad FIU 30-Day Rolling Window (RULE-COMP-FIU-01)', () => {
  const policy = makePolicy();
  const now = new Date('2026-05-01T12:00:00.000Z');
  const exactBoundaryMs = now.getTime() - 30 * 86_400_000;
  const exactBoundaryIso = new Date(exactBoundaryMs).toISOString();
  const justOutsideIso = new Date(exactBoundaryMs - 1).toISOString();
  const futureIso = new Date(now.getTime() + 60_000).toISOString();

  it('triggers CDD at TT$50,000 and Large Cash Alert at TT$90,000 for single and OR-linked transactions without double-counting', () => {
    // Below TT$50,000 single -> neither threshold triggered
    const belowCdd = evaluateFiuRollingWindow(
      {
        organizationId: ORG_SALVAGE,
        evaluatedAt: now,
        currentSale: {
          id: 'tx-curr-1',
          organizationId: ORG_SALVAGE,
          marketNode: 'DESTINATION_EXPORT_VAULT',
          paymentCurrency: 'TTD',
          grossCollectedMinor: 4_999_999,
          paymentMethod: 'CASH',
          buyerName: 'Devon Mohammed',
          buyerPhoneE164: '+18685550101',
          buyerIdDocumentStorageKey: null,
          buyerIdNumberEncrypted: null,
          isVoidedOrReversed: false,
          createdAt: now,
        },
        priorSales: [],
      },
      policy,
    );
    expect(belowCdd.cddRequired).toBe(false);
    expect(belowCdd.largeCashAlertRequired).toBe(false);
    expect(belowCdd.cddSatisfied).toBe(true);
    expect(belowCdd.rollingTotalTtdMinor).toBe(4_999_999);

    // Linked across OR criteria (phone, lower(trim(name)), encrypted ID), deduplicated when multiple keys match AND deduplicated if currentSale.id appears in priorSales
    const linked = evaluateFiuRollingWindow(
      {
        organizationId: ORG_SALVAGE,
        evaluatedAt: now,
        currentSale: {
          id: 'tx-curr-2',
          organizationId: ORG_SALVAGE,
          marketNode: 'DESTINATION_EXPORT_VAULT',
          paymentCurrency: 'TTD',
          grossCollectedMinor: 2_500_000,
          paymentMethod: 'CASH',
          buyerName: '  Devon  Mohammed  ',
          buyerPhoneE164: '+18685550101',
          buyerIdDocumentStorageKey: null,
          buyerIdNumberEncrypted: 'enc:tt-dp-8899',
          isVoidedOrReversed: false,
          createdAt: now,
        },
        priorSales: [
          // Duplicate of currentSale.id -> MUST NOT double count
          {
            id: 'tx-curr-2',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 2_500_000,
            paymentMethod: 'CASH',
            buyerName: 'Devon Mohammed',
            buyerPhoneE164: '+18685550101',
            buyerIdNumberEncrypted: 'enc:tt-dp-8899',
            isVoidedOrReversed: false,
            createdAt: now,
          },
          // Matches BOTH phone AND name -> counted ONCE (+1,500,000), right on exact 30d boundary
          {
            id: 'tx-prev-phone-and-name',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 1_500_000,
            paymentMethod: 'CASH',
            buyerName: 'DEVON  mohammed',
            buyerPhoneE164: '+18685550101',
            buyerIdNumberEncrypted: null,
            isVoidedOrReversed: false,
            createdAt: exactBoundaryIso,
          },
          // Matches encrypted ID only (+1,000,000) -> total = 2.5M + 1.5M + 1.0M = 5.0M exact!
          {
            id: 'tx-prev-id-only',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 1_000_000,
            paymentMethod: 'INTERAC_ETRANSFER',
            buyerName: 'Different Alias',
            buyerPhoneE164: '+18685559999',
            buyerIdNumberEncrypted: 'enc:tt-dp-8899',
            isVoidedOrReversed: false,
            createdAt: '2026-04-20T10:00:00Z',
          },
        ],
      },
      policy,
    );
    expect(linked.rollingTotalTtdMinor).toBe(5_000_000);
    expect(linked.cddRequired).toBe(true);
    expect(linked.cddSatisfied).toBe(false); // missing buyerIdDocumentStorageKey
    expect(linked.blockingCodes).toContain('FIU_CDD_ID_REQUIRED');
    expect(linked.largeCashAlertRequired).toBe(false);
    expect(linked.matchedPriorSaleIds).toEqual([
      'tx-prev-phone-and-name',
      'tx-prev-id-only',
    ]);

    // Large Cash Alert at exact TT$90,000 with ID docs uploaded -> CDD satisfied, alert triggered
    const largeCash = evaluateFiuRollingWindow(
      {
        organizationId: ORG_SALVAGE,
        evaluatedAt: now,
        currentSale: {
          id: 'tx-large-cash',
          organizationId: ORG_SALVAGE,
          marketNode: 'DESTINATION_EXPORT_VAULT',
          paymentCurrency: 'TTD',
          grossCollectedMinor: 9_000_000,
          paymentMethod: 'CASH',
          buyerName: 'Devon Mohammed',
          buyerPhoneE164: '+18685550101',
          buyerIdDocumentStorageKey: 'r2://private/fiu-id-devon.jpg',
          buyerIdNumberEncrypted: 'enc:tt-dp-8899',
          isVoidedOrReversed: false,
          createdAt: now,
        },
        priorSales: [],
      },
      policy,
    );
    expect(largeCash.cddRequired).toBe(true);
    expect(largeCash.cddSatisfied).toBe(true);
    expect(largeCash.largeCashAlertRequired).toBe(true);
    expect(largeCash.blockingCodes).toEqual([]);
  });

  it('excludes outside-window, future, voided, wrong-market, non-TTD, wrong-org, and blank/null identifier collisions', () => {
    const res = evaluateFiuRollingWindow(
      {
        organizationId: ORG_SALVAGE,
        evaluatedAt: now,
        currentSale: {
          id: 'tx-curr-clean',
          organizationId: ORG_SALVAGE,
          marketNode: 'DESTINATION_EXPORT_VAULT',
          paymentCurrency: 'TTD',
          grossCollectedMinor: 4_000_000,
          paymentMethod: 'CASH',
          buyerName: '   ', // blank name MUST NOT match other blank names
          buyerPhoneE164: null, // null phone MUST NOT match other nulls
          buyerIdDocumentStorageKey: null,
          buyerIdNumberEncrypted: null,
          isVoidedOrReversed: false,
          createdAt: now,
        },
        priorSales: [
          {
            // 1ms before 30-day window -> excluded
            id: 'tx-expired',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 2_000_000,
            paymentMethod: 'CASH',
            buyerName: '   ',
            buyerPhoneE164: '+18685550101',
            isVoidedOrReversed: false,
            createdAt: justOutsideIso,
          },
          {
            // Future timestamp -> excluded
            id: 'tx-future',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 2_000_000,
            paymentMethod: 'CASH',
            buyerName: 'Match Me',
            isVoidedOrReversed: false,
            createdAt: futureIso,
          },
          {
            // Voided -> excluded
            id: 'tx-voided',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 5_000_000,
            paymentMethod: 'CASH',
            buyerName: '   ',
            buyerIdNumberEncrypted: null,
            isVoidedOrReversed: true,
            createdAt: now,
          },
          {
            // Wrong marketNode -> excluded
            id: 'tx-domestic',
            organizationId: ORG_SALVAGE,
            marketNode: 'DOMESTIC_ORIGIN',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 5_000_000,
            paymentMethod: 'CASH',
            buyerName: '   ',
            isVoidedOrReversed: false,
            createdAt: now,
          },
          {
            // Non-TTD currency -> excluded
            id: 'tx-usd',
            organizationId: ORG_SALVAGE,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'USD',
            grossCollectedMinor: 5_000_000,
            paymentMethod: 'CASH',
            buyerName: '   ',
            isVoidedOrReversed: false,
            createdAt: now,
          },
          {
            // Wrong organization -> excluded
            id: 'tx-wrong-org',
            organizationId: ORG_OTHER,
            marketNode: 'DESTINATION_EXPORT_VAULT',
            paymentCurrency: 'TTD',
            grossCollectedMinor: 5_000_000,
            paymentMethod: 'CASH',
            buyerName: '   ',
            isVoidedOrReversed: false,
            createdAt: now,
          },
        ],
      },
      policy,
    );

    expect(res.matchedPriorSaleIds).toEqual([]);
    expect(res.rollingTotalTtdMinor).toBe(4_000_000);
    expect(res.cddRequired).toBe(false);
  });
});

describe('TDG Hazmat eBay Parcel Guard (assertEbayParcelHazmatEligible)', () => {
  it('allows NONE and blocks all TDG hazmat codes and unknown codes with HTTP 422 HAZMAT_PARCEL_SHIPPING_BLOCKED', () => {
    expect(() => assertEbayParcelHazmatEligible('NONE')).not.toThrow();

    const blockedCodes: ReadonlyArray<Parameters<typeof assertEbayParcelHazmatEligible>[0]> = [
      'UN3268_AIRBAG',
      'UN0503_PYROTECHNIC',
      'UN2794_WET_BATTERY',
      'UN3480_LITHIUM_BATTERY',
      'UNKNOWN_RUNTIME_HAZMAT' as unknown as Parameters<typeof assertEbayParcelHazmatEligible>[0],
    ];

    for (const code of blockedCodes) {
      try {
        assertEbayParcelHazmatEligible(code);
        expect.unreachable(`Expected hazmat code ${String(code)} to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainRuleError);
        expect((error as DomainRuleError).code).toBe(
          'HAZMAT_PARCEL_SHIPPING_BLOCKED',
        );
        expect((error as DomainRuleError).status).toBe(422);
      }
    }
  });
});

describe('Ontario O. Reg. 85/16 EASR ELV Threshold (evaluateEasrElvThreshold)', () => {
  it('distinguishes ELV #2 vs #3+ under WARN_ONLY and STRICT_BLOCK and exempts registered sites & non-ELVs', () => {
    const warnPolicy = makePolicy({ complianceEnforcementMode: 'WARN_ONLY' });
    const strictPolicy = makePolicy({
      complianceEnforcementMode: 'STRICT_BLOCK',
    });
    const registeredPolicy = makePolicy({
      complianceEnforcementMode: 'STRICT_BLOCK',
      easrRegistrationNumber: 'EASR-ON-2026-0099',
    });

    // Proposed #2 ELV (1 active + 1 incoming = 2 <= threshold 2) -> passes with 0 warnings
    const atThreshold = evaluateEasrElvThreshold(
      {
        organizationId: ORG_SALVAGE,
        activeElvVehiclesOnSite: [
          {
            id: 'v1',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'DISMANTLING_IN_PROGRESS',
          },
          // Watercraft & Shop Equipment MUST NOT count toward automobile ELV limit
          {
            id: 'w1',
            assetCategory: 'WATERCRAFT',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'STAGED_ONTARIO_YARD',
          },
          // Already scrapped hulk -> no longer an active ELV
          {
            id: 'v-cleared',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'SCRAPPED_METAL_CLEARED',
          },
        ],
        incomingVehicle: {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
        },
      },
      strictPolicy,
    );
    expect(atThreshold.allowed).toBe(true);
    expect(atThreshold.projectedActiveElvCount).toBe(2);
    expect(atThreshold.warnings).toEqual([]);
    expect(atThreshold.blockingCodes).toEqual([]);

    // Proposed #3 ELV under WARN_ONLY with null registration -> allowed + MISSING_EASR_REGISTRATION_WARNING
    const thirdWarn = evaluateEasrElvThreshold(
      {
        organizationId: ORG_SALVAGE,
        activeElvVehiclesOnSite: [
          {
            id: 'v1',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'DISMANTLING_IN_PROGRESS',
          },
          {
            id: 'v2',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'STAGED_ONTARIO_YARD',
          },
        ],
        incomingVehicle: {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
        },
      },
      warnPolicy,
    );
    expect(thirdWarn.allowed).toBe(true);
    expect(thirdWarn.projectedActiveElvCount).toBe(3);
    expect(thirdWarn.warnings).toEqual(['MISSING_EASR_REGISTRATION_WARNING']);

    // Proposed #3 ELV under STRICT_BLOCK with null registration -> blocked!
    const thirdStrict = evaluateEasrElvThreshold(
      {
        organizationId: ORG_SALVAGE,
        activeElvVehiclesOnSite: [
          {
            id: 'v1',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'DISMANTLING_IN_PROGRESS',
          },
          {
            id: 'v2',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'STAGED_ONTARIO_YARD',
          },
        ],
        incomingVehicle: {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
        },
      },
      strictPolicy,
    );
    expect(thirdStrict.allowed).toBe(false);
    expect(thirdStrict.blockingCodes).toContain('EASR_REGISTRATION_REQUIRED');

    // Registered EASR permits #3+ cleanly even in STRICT_BLOCK
    const thirdRegistered = evaluateEasrElvThreshold(
      {
        organizationId: ORG_SALVAGE,
        activeElvVehiclesOnSite: [
          {
            id: 'v1',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'DISMANTLING_IN_PROGRESS',
          },
          {
            id: 'v2',
            assetCategory: 'AUTOMOBILE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'STAGED_ONTARIO_YARD',
          },
        ],
        incomingVehicle: {
          assetCategory: 'AUTOMOBILE',
          operationalLane: 'DISMANTLE_AND_EXPORT',
        },
      },
      registeredPolicy,
    );
    expect(thirdRegistered.allowed).toBe(true);
    expect(thirdRegistered.warnings).toEqual([]);
  });
});

describe('Barrel Export Smoke Test & Pure Domain Boundary Verification', () => {
  it('exposes cohesive domain modules via src/core/domain/index.ts with zero DB/UI/filesystem/network/cannabis runtime dependencies', () => {
    const policy = makePolicy();

    // Smoke-exercise every domain module through the barrel import
    const transition = validatePartTransition(
      {
        custodyState: 'SHELVED_ORIGIN_CONTAINER',
        availabilityState: 'AVAILABLE',
        ebaySyncState: 'NOT_LISTED',
        classifiedsSyncState: 'NOT_POSTED',
        complianceState: 'CLEARED_FOR_SALE',
      },
      'EXPORT_EBAY_CSV',
      {
        weightKg: 8.5,
        tdgHazmatCode: 'NONE',
      },
    );
    expect(transition.nextState.ebaySyncState).toBe(
      'CSV_EXPORTED_PENDING_CONFIRMATION',
    );

    const cost = computeProvisionalCostBasis({
      organizationId: ORG_SALVAGE,
      donorVehicleId: 'veh-smoke-1',
      actualPurchasePriceCadMinor: 150_000,
      loggedDirectExpensesCadMinor: 50_000,
      targetGrossRealizationMinor: 400_000,
      strippedParts: [
        {
          partId: 'p1',
          gradeAdjustedMarketValueCadMinor: 100_000,
        },
      ],
    });
    expect(cost.allocations[0]?.allocatedCostBasisCadMinor).toBe(50_000);

    const tax = computeDomesticSaleTaxAndSettlement(
      {
        channel: 'LOCAL_WALK_IN_CASH',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        subtotalMinor: 10_000,
        paymentMethod: 'CASH',
      },
      policy,
    );
    expect(tax.gstHstTaxCadMinor).toBe(1_300);

    const snap = computeSeparatedFinancialSnapshot(
      {
        organizationId: ORG_SALVAGE,
        sales: [],
      },
      policy,
    );
    expect(snap.availableWorkingCapitalCadMinor).toBe(2_200_000);

    const gate = evaluateWorkingCapitalGate(
      {
        organizationId: ORG_SALVAGE,
        availableWorkingCapitalCadMinor: 2_200_000,
        estimatedDealOutlayCadMinor: 300_000,
        operationalLane: 'DISMANTLE_AND_EXPORT',
        assetCategory: 'AUTOMOBILE',
      },
      policy,
    );
    expect(gate.allowed).toBe(true);

    const fiu = evaluateFiuFromBarrel(
      {
        organizationId: ORG_SALVAGE,
        evaluatedAt: new Date('2026-05-01T00:00:00Z'),
        currentSale: {
          id: 'tx-smoke',
          organizationId: ORG_SALVAGE,
          marketNode: 'DESTINATION_EXPORT_VAULT',
          paymentCurrency: 'TTD',
          grossCollectedMinor: 100_000,
          paymentMethod: 'CASH',
          buyerName: 'Smoke Buyer',
          isVoidedOrReversed: false,
          createdAt: '2026-05-01T00:00:00Z',
        },
        priorSales: [],
      },
      policy,
    );
    expect(fiu.cddRequired).toBe(false);

    // Dependency boundary audit across all production files in src/core/domain/
    const domainDir = join(__dirname, '..');
    const entries = readdirSync(domainDir).filter((name) => name.endsWith('.ts'));
    expect(entries.sort()).toEqual([
      'domain-primitives.ts',
      'donor-cost-allocator.ts',
      'fiu-and-salvage-compliance.ts',
      'index.ts',
      'part-state-machine.ts',
      'vault-pricing-and-checkout-corridor.ts',
      'working-capital-and-compensation.ts',
    ]);

    const bannedPatterns = [
      /from\s+['"]@prisma\/client['"]/, // non-type runtime import from @prisma/client
      /policy-loader/,
      /node:fs/,
      /node:http/,
      /src\/infrastructure/,
      /next\//,
      /react/,
      /Date\.now\(/,
      /Math\.random\(/,
      /CannabisLot|ProductionRun|ExciseStamp/i,
    ];

    for (const file of entries) {
      const content = readFileSync(join(domainDir, file), 'utf8');
      // Strip `import type ...` statements before checking `@prisma/client` runtime import
      const withoutTypeImports = content.replace(
        /import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/g,
        '',
      );
      for (const pattern of bannedPatterns) {
        expect(
          withoutTypeImports,
          `Boundary violation (${String(pattern)}) in ${file}`,
        ).not.toMatch(pattern);
      }
    }
  });
});
