import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CannabisDestructionStream,
  CannabisProductionRunStatus,
  CannabisRunType,
  CashCustodyState,
  EbaySyncState,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  PartCustodyState,
  PaymentSettlementState,
  Prisma,
  TaxCollectionMode,
  TdgHazmatCode,
  type CanonicalInventoryEvent,
  type Expense,
  type OrganizationMembership,
  type ProductionRun,
  type SaleTransaction,
} from '@prisma/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CANADIAN_PROVINCE_OR_TERRITORY_CODES,
  type IPolicyConfigPort,
  type PricingAndCompliancePolicy,
} from '../../ports';
import {
  JsonPolicyConfigAdapter,
  lookupDefaultSteeringSide,
  lookupDefaultTdgHazmatCode,
  lookupSuggestedHsCode,
  PolicyConfigError,
} from '../policy-loader';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../',
);

async function loadVerifierModule(): Promise<{
  verifyNoStubs: (options?: {
    rootDir?: string;
    fsOps?: {
      lstat: typeof fs.lstat;
      readdir: typeof fs.readdir;
      readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
    };
  }) => Promise<{
    ok: boolean;
    checkedFiles: number;
    violations: Array<{ file: string; line: number; rule: string }>;
  }>;
}> {
  const verifierPath = path.join(REPO_ROOT, 'scripts/verify-no-stubs.mjs');
  return import(verifierPath);
}

describe('JsonPolicyConfigAdapter & pricing-policy.json', () => {
  describe('baseline policy validation and normalization', () => {
    it('loads and validates the authoritative baseline policy offline', async () => {
      const adapter: IPolicyConfigPort = new JsonPolicyConfigAdapter();
      const policy = await adapter.getPolicyForOrg('ORG_SALVAGE_EXPORT');

      expect(policy.metadata).toEqual({
        verificationStatus: 'ESTIMATE',
        effectiveDate: '2026-11-01',
        source:
          'ADR-0006 Identity RLS, Settlement Liquidity, Jurisdiction-Aware GST/HST & Trigger-Gated ProductionRun Finalization',
        approvedBy: 'ARCHITECT_CFO',
      });

      const rates = policy.domesticTaxPolicy.canadianProvincialGstHstRatesBps;
      for (const code of CANADIAN_PROVINCE_OR_TERRITORY_CODES) {
        expect(rates[code]).toBeTypeOf('number');
      }
      expect(rates.ON).toBe(1300);
      expect(rates.NS).toBe(1400);
      expect(rates.NB).toBe(1500);
      expect(rates.NL).toBe(1500);
      expect(rates.PE).toBe(1500);
      expect(rates.QC).toBe(500);
      expect(rates.BC).toBe(500);
      expect(rates.AB).toBe(500);
      expect(rates.MB).toBe(500);
      expect(rates.SK).toBe(500);
      expect(rates.YT).toBe(500);
      expect(rates.NT).toBe(500);
      expect(rates.NU).toBe(500);

      expect(policy.domesticTaxPolicy.requireVerifiedTaxInvoiceForFeeItc).toBe(
        true,
      );
      expect(policy.domesticTaxPolicy.isGstHstRegistered).toBe(true);
      expect(policy.domesticTaxPolicy.isOntarioEntityHstRegistered).toBe(true);
      expect(policy.domesticTaxPolicy.isOntarioHstRegistered).toBe(true);

      // Inclusion flags must be false so unsettled/float funds are excluded from deployable liquidity
      const wc = policy.operationalGates.workingCapitalGate;
      expect(wc.countPendingExportCashAsAvailable).toBe(false);
      expect(wc.countPendingDomesticReceivablesAsAvailable).toBe(false);
      expect(wc.countOperatorFloatInBankWorkingCapital).toBe(false);

      expect(policy.operationalGates.complianceEnforcementMode).toBe(
        'WARN_ONLY',
      );
      expect(policy.complianceThresholds.easrRegistrationNumber).toBeNull();
      expect(policy.complianceThresholds.minRecordRetentionYears).toBe(7);

      expect(policy.domesticSyndication.ebayShipFromCity).toBe('Kemptville, ON');
      expect(policy.domesticSyndication.ebayShipFromPostalCode).toBe('K0G 1J0');
      expect(policy.domesticSyndication.publicPickupLocationLabel).toBe(
        'Ottawa South / Hwy 416 Corridor',
      );

      // 3-tranche $44,000 CAD Senior Secured Loan ($22k + $12k + $10k) and sparse tranche normalization
      expect(wc.totalCommittedLoanFacilityCadMinor).toBe(4_400_000);
      const trancheSum = wc.tranches.reduce(
        (sum, t) => sum + t.principalCadMinor,
        0,
      );
      expect(trancheSum).toBe(4_400_000);
      expect(wc.tranches).toEqual([
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
      ]);

      // Dormant post-2025 SOR/2025-43 & SOR/2025-45 parameters
      expect(policy.cannabisCompliance.microCultivationMaxCanopySqm).toBe(800);
      expect(
        policy.cannabisCompliance.microProcessingAnnualDriedEquivMaxKg,
      ).toBe(2400);
      expect(
        policy.cannabisCompliance.extractNonDiscreteContainerMaxThcMg,
      ).toBe(1000);
      expect(policy.cannabisCompliance.minRecordRetentionYears).toBe(7);
      expect(policy.cannabisCompliance.adverseReactionRetentionYears).toBe(25);
    });
  });

  describe('per-organization override merging and isolation', () => {
    it('merges a single nested leaf without clobbering siblings and preserves partial provincial map entries', async () => {
      let requestedOrgId: string | undefined;
      const adapter = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: async (organizationId) => {
          requestedOrgId = organizationId;
          return {
            organizationId,
            policyConfigJson: {
              domesticTaxPolicy: {
                canadianProvincialGstHstRatesBps: {
                  NS: 1450,
                },
                provincialPstRegistrations: {
                  QC: { registered: true },
                },
              },
            },
          };
        },
      });

      const policy = await adapter.getPolicyForOrg('ORG_CUSTOM_TENANT');
      expect(requestedOrgId).toBe('ORG_CUSTOM_TENANT');
      expect(policy.domesticTaxPolicy.canadianProvincialGstHstRatesBps.NS).toBe(
        1450,
      );
      expect(policy.domesticTaxPolicy.canadianProvincialGstHstRatesBps.ON).toBe(
        1300,
      );
      expect(policy.domesticTaxPolicy.canadianProvincialGstHstRatesBps.NB).toBe(
        1500,
      );
      expect(policy.domesticTaxPolicy.provincialPstRegistrations.QC).toEqual({
        registered: true,
        rate: 0.09975,
      });
      expect(policy.domesticTaxPolicy.provincialPstRegistrations.BC).toEqual({
        registered: false,
        rate: 0.07,
      });
    });

    it('replaces arrays wholesale and normalizes omitted tranche fields after merge', async () => {
      const adapter = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: async (organizationId) => ({
          organizationId,
          policyConfigJson: {
            operationalGates: {
              workingCapitalGate: {
                totalCommittedLoanFacilityCadMinor: 1_000_000,
                tranches: [
                  {
                    trancheCode: 'CUSTOM_SEED',
                    principalCadMinor: 1_000_000,
                    unlocked: true,
                  },
                ],
              },
            },
          },
        }),
      });

      const policy = await adapter.getPolicyForOrg('ORG_CUSTOM');
      expect(policy.operationalGates.workingCapitalGate.tranches).toEqual([
        {
          trancheCode: 'CUSTOM_SEED',
          principalCadMinor: 1_000_000,
          unlocked: true,
          minShelvedSkus: 0,
          minScrappedDonors: 0,
          requireZeroOverdueFloatReceipts: false,
        },
      ]);
    });

    it('uses baseline when policyConfigJson is null and keeps concurrent calls and mutations isolated', async () => {
      const overridesByOrg: Record<string, unknown> = {
        ORG_SALVAGE_EXPORT: null,
        ORG_CANNABIS_NURSERY_PROC: {
          operationalGates: {
            complianceEnforcementMode: 'STRICT_BLOCK',
          },
          domesticTaxPolicy: {
            isGstHstRegistered: false,
          },
        },
      };

      const port: IPolicyConfigPort = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: async (organizationId) => ({
          organizationId,
          policyConfigJson: overridesByOrg[organizationId] ?? null,
        }),
      });

      const [salvagePolicy, cannabisPolicy] = await Promise.all([
        port.getPolicyForOrg('ORG_SALVAGE_EXPORT'),
        port.getPolicyForOrg('ORG_CANNABIS_NURSERY_PROC'),
      ]);

      expect(salvagePolicy.operationalGates.complianceEnforcementMode).toBe(
        'WARN_ONLY',
      );
      expect(salvagePolicy.domesticTaxPolicy.isGstHstRegistered).toBe(true);

      expect(cannabisPolicy.operationalGates.complianceEnforcementMode).toBe(
        'STRICT_BLOCK',
      );
      expect(cannabisPolicy.domesticTaxPolicy.isGstHstRegistered).toBe(false);
      expect(
        cannabisPolicy.domesticTaxPolicy.isOntarioEntityHstRegistered,
      ).toBe(false);
      expect(cannabisPolicy.domesticTaxPolicy.isOntarioHstRegistered).toBe(
        false,
      );

      // Caller mutation must not leak to subsequent invocations
      salvagePolicy.domesticTaxPolicy.canadianProvincialGstHstRatesBps.ON = 9999;
      salvagePolicy.operationalGates.workingCapitalGate.tranches.pop();

      const freshSalvagePolicy = await port.getPolicyForOrg(
        'ORG_SALVAGE_EXPORT',
      );
      expect(
        freshSalvagePolicy.domesticTaxPolicy.canadianProvincialGstHstRatesBps
          .ON,
      ).toBe(1300);
      expect(
        freshSalvagePolicy.operationalGates.workingCapitalGate.tranches,
      ).toHaveLength(3);
    });
  });

  describe('invalid input and error handling', () => {
    it('rejects empty organizationId, missing organization record, mismatched record, and reader errors', async () => {
      const noReader = new JsonPolicyConfigAdapter();
      await expect(noReader.getPolicyForOrg('')).rejects.toMatchObject({
        name: 'PolicyConfigError',
        code: 'INVALID_ORGANIZATION_ID',
      });
      await expect(noReader.getPolicyForOrg('   ')).rejects.toMatchObject({
        code: 'INVALID_ORGANIZATION_ID',
      });

      const missingReader = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: async () => null,
      });
      await expect(
        missingReader.getPolicyForOrg('ORG_MISSING'),
      ).rejects.toMatchObject({
        code: 'ORGANIZATION_NOT_FOUND',
      });

      const mismatchReader = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: async () => ({
          organizationId: 'ORG_OTHER',
          policyConfigJson: null,
        }),
      });
      await expect(
        mismatchReader.getPolicyForOrg('ORG_EXPECTED'),
      ).rejects.toMatchObject({
        code: 'ORGANIZATION_MISMATCH',
      });

      const failingReader = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: async () => {
          throw new Error('DB_CONNECTION_LOST');
        },
      });
      await expect(failingReader.getPolicyForOrg('ORG_ANY')).rejects.toThrow(
        'DB_CONNECTION_LOST',
      );
    });

    it('rejects invalid types, nulls, unknown keys, prototype-polluting keys, conflicting aliases, and inconsistent tranche totals', async () => {
      const invalidPayloads: unknown[] = [
        [],
        'not-an-object',
        { unknownTopLevelKey: true },
        { fxRates: { cadToUsdSpot: -0.5 } },
        { fxRates: { cadToUsdSpot: Number.NaN } },
        { marginsAndCommissions: { minBeaterNetProfitCadMinor: 12.5 } },
        { marginsAndCommissions: { minBeaterNetProfitCadMinor: -1 } },
        { operationalGates: { complianceEnforcementMode: 'INVALID_MODE' } },
        {
          operationalGates: {
            workingCapitalGate: {
              tranches: [
                {
                  trancheCode: 'T1',
                  principalCadMinor: 4_400_000,
                  unlocked: true,
                  minShelvedSkus: null,
                },
              ],
            },
          },
        },
        {
          operationalGates: {
            workingCapitalGate: {
              tranches: [
                {
                  trancheCode: 'T1',
                  principalCadMinor: 1_000_000,
                  unlocked: true,
                },
              ],
            },
          },
        },
        {
          operationalGates: {
            workingCapitalGate: {
              totalCommittedLoanFacilityCadMinor: 2_000_000,
              tranches: [
                {
                  trancheCode: 'DUP',
                  principalCadMinor: 1_000_000,
                  unlocked: true,
                },
                {
                  trancheCode: 'DUP',
                  principalCadMinor: 1_000_000,
                  unlocked: false,
                },
              ],
            },
          },
        },
        {
          domesticTaxPolicy: {
            isGstHstRegistered: false,
            isOntarioHstRegistered: true,
          },
        },
        {
          domesticTaxPolicy: {
            isOntarioEntityHstRegistered: false,
          },
        },
        JSON.parse('{"__proto__": {"polluted": true}}'),
        JSON.parse('{"fxRates": {"constructor": {"bad": true}}}'),
        JSON.parse('{"fxRates": {"prototype": {"bad": true}}}'),
      ];

      for (const payload of invalidPayloads) {
        const adapter = new JsonPolicyConfigAdapter({
          readOrganizationPolicy: async (organizationId) => ({
            organizationId,
            policyConfigJson: payload,
          }),
        });
        await expect(adapter.getPolicyForOrg('ORG_TEST')).rejects.toBeInstanceOf(
          PolicyConfigError,
        );
      }
    });

    it('rejects a malformed baseline missing a province rate', async () => {
      const adapter = new JsonPolicyConfigAdapter();
      const valid = await adapter.getPolicyForOrg('ORG_SALVAGE_EXPORT');
      const broken = structuredClone(valid) as unknown as {
        domesticTaxPolicy: {
          canadianProvincialGstHstRatesBps: Record<string, number>;
        };
      };
      delete broken.domesticTaxPolicy.canadianProvincialGstHstRatesBps.NU;

      const brokenAdapter = new JsonPolicyConfigAdapter({
        baselinePolicy: broken,
      });
      await expect(
        brokenAdapter.getPolicyForOrg('ORG_SALVAGE_EXPORT'),
      ).rejects.toMatchObject({
        code: 'INVALID_POLICY_BASELINE',
      });
    });
  });

  describe('category lookup tables', () => {
    it('maps documented steering side, distinct TDG hazmat codes, and suggested HS codes while returning undefined for unknowns', () => {
      expect(lookupDefaultSteeringSide('Complete Engine Assembly')).toBe(
        'UNIVERSAL',
      );
      expect(
        lookupDefaultSteeringSide(
          'Steering Rack, Steering Column, Intermediate Shaft',
        ),
      ).toBe('LHD_ONLY');
      expect(lookupDefaultSteeringSide('Steering Rack')).toBe('LHD_ONLY');

      expect(lookupDefaultTdgHazmatCode('Safety Airbags')).toBe(
        'UN3268_AIRBAG',
      );
      expect(lookupDefaultTdgHazmatCode('Pyrotechnic Pretensioners')).toBe(
        'UN0503_PYROTECHNIC',
      );
      expect(lookupDefaultTdgHazmatCode('Lead-Acid Vehicle Battery')).toBe(
        'UN2794_WET_BATTERY',
      );
      expect(lookupDefaultTdgHazmatCode('Lithium Vehicle Battery')).toBe(
        'UN3480_LITHIUM_BATTERY',
      );
      expect(lookupDefaultTdgHazmatCode('Alternator')).toBe('NONE');
      // Ambiguous grouped hazmat names must not invent a shared hazard code
      expect(
        lookupDefaultTdgHazmatCode('Safety Airbags & Pyrotechnic Pretensioners'),
      ).toBeUndefined();
      expect(
        lookupDefaultTdgHazmatCode('Lead-Acid & Lithium Vehicle Batteries'),
      ).toBeUndefined();

      expect(
        lookupSuggestedHsCode('Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)'),
      ).toBe('8903.99');
      expect(lookupSuggestedHsCode('Lead-Acid Vehicle Battery')).toBe('8507.10');
      expect(lookupSuggestedHsCode('Lithium Vehicle Battery')).toBe('8507.60');
      expect(lookupSuggestedHsCode('Gearboxes / Transmissions')).toBe('8708.40');

      expect(lookupDefaultSteeringSide('Unknown Flux Capacitor')).toBeUndefined();
      expect(lookupDefaultTdgHazmatCode('Unknown Flux Capacitor')).toBeUndefined();
      expect(lookupSuggestedHsCode('Unknown Flux Capacitor')).toBeUndefined();
      expect(lookupDefaultSteeringSide('constructor')).toBeUndefined();
      expect(lookupDefaultTdgHazmatCode('toString')).toBeUndefined();
    });
  });
});

describe('generated Prisma exports and multi-schema metadata', () => {
  it('exports required runtime enums across shared, salvage, and dormant cannabis schemas', () => {
    expect(Object.values(PaymentSettlementState)).toEqual([
      'SALE_RECORDED',
      'PAYMENT_INITIATED',
      'PAYMENT_CONFIRMED',
      'MARKETPLACE_PAYOUT_PENDING',
      'BANK_SETTLEMENT_PENDING',
      'BANK_SETTLEMENT_CONFIRMED',
      'REFUNDED_OR_CHARGED_BACK',
    ]);

    expect(Object.values(TaxCollectionMode)).toEqual([
      'DIRECT_SELLER_COLLECTED',
      'MARKETPLACE_FACILITATOR_COLLECTED',
      'ZERO_RATED_EXPORT',
      'NOT_REGISTERED_NO_TAX',
    ]);

    expect(InventoryAvailabilityState.RETURNED_QC_HOLD).toBe(
      'RETURNED_QC_HOLD',
    );
    expect(PartCustodyState.RESTOCKED_QC_HOLD).toBe('RESTOCKED_QC_HOLD');
    expect(EbaySyncState.CSV_EXPORTED_PENDING_CONFIRMATION).toBe(
      'CSV_EXPORTED_PENDING_CONFIRMATION',
    );
    expect(CashCustodyState.PENDING_EXTERNAL_RECEIVABLE).toBe(
      'PENDING_EXTERNAL_RECEIVABLE',
    );
    expect(Object.values(LocationOperationalStatus)).toEqual([
      'ACTIVE',
      'PROPOSED_INACTIVE',
      'DORMANT_FUTURE',
    ]);
    expect(Object.values(TdgHazmatCode)).toEqual([
      'NONE',
      'UN3268_AIRBAG',
      'UN0503_PYROTECHNIC',
      'UN2794_WET_BATTERY',
      'UN3480_LITHIUM_BATTERY',
    ]);

    expect(Object.values(CannabisProductionRunStatus)).toEqual([
      'DRAFT',
      'IN_PROGRESS',
      'FINALIZED',
      'VOIDED',
    ]);
    expect(Object.values(CannabisRunType)).toEqual([
      'DRYING_CURING',
      'SOLVENTLESS_ICE_WATER_HASH',
      'ROSIN_PRESSING',
      'INFUSED_PREROLL_ASSEMBLY',
      'PACKAGING_LABELLING',
    ]);
    expect(Object.values(CannabisDestructionStream)).toEqual([
      'CULTIVATION_WASTE',
      'WHOLE_PLANTS',
      'OTHER_CANNABIS',
    ]);
  });

  it('generates expected TypeScript fields and DMMF defaults/composite keys', () => {
    expectTypeOf<OrganizationMembership['isActive']>().toEqualTypeOf<boolean>();
    expectTypeOf<
      OrganizationMembership['deactivatedAt']
    >().toEqualTypeOf<Date | null>();
    expectTypeOf<
      OrganizationMembership['deactivatedById']
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      OrganizationMembership['revocationReason']
    >().toEqualTypeOf<string | null>();

    expectTypeOf<
      SaleTransaction['buyerTaxRemittedByPlatformMinor']
    >().toEqualTypeOf<number | null>();
    expectTypeOf<
      SaleTransaction['isFeeTaxInvoiceVerified']
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      SaleTransaction['paymentSettlementState']
    >().toEqualTypeOf<PaymentSettlementState>();
    expectTypeOf<
      SaleTransaction['taxCollectionMode']
    >().toEqualTypeOf<TaxCollectionMode>();
    expectTypeOf<Expense['itcReceivableCadMinor']>().toEqualTypeOf<number>();
    expectTypeOf<
      ProductionRun['status']
    >().toEqualTypeOf<CannabisProductionRunStatus>();
    expectTypeOf<
      CanonicalInventoryEvent['reversesCanonicalEventId']
    >().toEqualTypeOf<string | null>();

    const models = Prisma.dmmf.datamodel.models;
    expect(models).toHaveLength(28);

    const membership = models.find((m) => m.name === 'OrganizationMembership')!;
    const isActiveField = membership.fields.find((f) => f.name === 'isActive')!;
    expect(isActiveField.default).toBe(true);

    const saleTx = models.find((m) => m.name === 'SaleTransaction')!;
    const platformBuyerTax = saleTx.fields.find(
      (f) => f.name === 'buyerTaxRemittedByPlatformMinor',
    )!;
    expect(platformBuyerTax.isRequired).toBe(false);

    const prodRun = models.find((m) => m.name === 'ProductionRun')!;
    expect(prodRun.fields.find((f) => f.name === 'status')!.default).toBe(
      'DRAFT',
    );
    expect(
      prodRun.fields.find((f) => f.name === 'totalInputMassTenthGrams')!.default,
    ).toBe('0');
    expect(
      prodRun.fields.find((f) => f.name === 'totalOutputMassTenthGrams')!
        .default,
    ).toBe('0');

    const runInput = models.find((m) => m.name === 'ProductionRunInput')!;
    expect(runInput.uniqueFields).toContainEqual([
      'organizationId',
      'productionRunId',
      'sourceLotId',
    ]);
    const runOutput = models.find((m) => m.name === 'ProductionRunOutput')!;
    expect(runOutput.uniqueFields).toContainEqual([
      'organizationId',
      'productionRunId',
      'outputLotId',
    ]);

    // Verify intra-tenant composite foreign keys on tenant-scoped models
    const partModel = models.find((m) => m.name === 'Part')!;
    const donorRel = partModel.fields.find((f) => f.name === 'donorVehicle')!;
    expect(donorRel.relationFromFields).toEqual([
      'organizationId',
      'donorVehicleId',
    ]);
    expect(donorRel.relationToFields).toEqual(['organizationId', 'id']);
  });
});

describe('verify-no-stubs.mjs fail-closed verification', () => {
  async function createCleanFixtureRoot(): Promise<string> {
    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'verify-no-stubs-fixture-'),
    );
    await fs.mkdir(path.join(tmpRoot, 'prisma'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'src/core'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'src/infrastructure'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpRoot, 'prisma/schema.prisma'),
      'datasource db { provider = "postgresql"\n url = env("DATABASE_URL") }\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'src/core/clean.ts'),
      'export const ok = true;\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'src/infrastructure/tx.ts'),
      [
        'export async function setCtx(tx: { $queryRaw: Function; $executeRaw: Function }) {',
        '  await tx.$queryRaw`SELECT set_config(\'app.current_org_id\', \'id\', true)`;',
        '  await tx.$executeRaw`SELECT 1`;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    return tmpRoot;
  }

  it('passes on the real repository via CLI execution', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/verify-no-stubs.mjs')],
      { cwd: REPO_ROOT },
    );
    expect(stdout).toContain('[verify:no-stubs] OK');
  });

  it('passes on a clean fixture containing safe parameterized $queryRaw set_config and unrelated $executeRaw', async () => {
    const { verifyNoStubs } = await loadVerifierModule();
    const tmpRoot = await createCleanFixtureRoot();
    try {
      const result = await verifyNoStubs({ rootDir: tmpRoot });
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.checkedFiles).toBe(3);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on missing required paths, wrong entry types, malformed JSON, broken symlinks, and fs read errors', async () => {
    const { verifyNoStubs } = await loadVerifierModule();

    // Missing prisma/schema.prisma
    const tmpMissingSchema = await createCleanFixtureRoot();
    try {
      await fs.rm(path.join(tmpMissingSchema, 'prisma/schema.prisma'));
      const res = await verifyNoStubs({ rootDir: tmpMissingSchema });
      expect(res.ok).toBe(false);
      expect(res.violations).toContainEqual({
        file: 'prisma/schema.prisma',
        line: 0,
        rule: 'MISSING_REQUIRED_PATH',
      });
    } finally {
      await fs.rm(tmpMissingSchema, { recursive: true, force: true });
    }

    // Missing src/core & file-instead-of-directory src/infrastructure
    const tmpWrongTypes = await createCleanFixtureRoot();
    try {
      await fs.rm(path.join(tmpWrongTypes, 'src/core'), {
        recursive: true,
        force: true,
      });
      await fs.rm(path.join(tmpWrongTypes, 'src/infrastructure'), {
        recursive: true,
        force: true,
      });
      await fs.writeFile(
        path.join(tmpWrongTypes, 'src/infrastructure'),
        'not a directory',
        'utf8',
      );
      const res = await verifyNoStubs({ rootDir: tmpWrongTypes });
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.file === 'src/core')).toBe(true);
      expect(res.violations.some((v) => v.file === 'src/infrastructure')).toBe(
        true,
      );
    } finally {
      await fs.rm(tmpWrongTypes, { recursive: true, force: true });
    }

    // Malformed JSON and broken symlink
    const tmpBadAssets = await createCleanFixtureRoot();
    try {
      await fs.writeFile(
        path.join(tmpBadAssets, 'src/core/broken.json'),
        '{ invalid json',
        'utf8',
      );
      await fs.symlink(
        '/nonexistent-target-path',
        path.join(tmpBadAssets, 'src/core/dangling.ts'),
      );
      const res = await verifyNoStubs({ rootDir: tmpBadAssets });
      expect(res.ok).toBe(false);
      expect(res.violations).toContainEqual({
        file: 'src/core/broken.json',
        line: 1,
        rule: 'MALFORMED_JSON',
      });
      expect(res.violations).toContainEqual({
        file: 'src/core/dangling.ts',
        line: 0,
        rule: 'UNSAFE_SYMLINK',
      });
    } finally {
      await fs.rm(tmpBadAssets, { recursive: true, force: true });
    }

    // Simulated unreadable file / readdir exception via fsOps seam (root-safe)
    const tmpPerm = await createCleanFixtureRoot();
    try {
      const res = await verifyNoStubs({
        rootDir: tmpPerm,
        fsOps: {
          lstat: fs.lstat,
          readdir: fs.readdir,
          readFile: async (filePath, encoding) => {
            if (String(filePath).endsWith('clean.ts')) {
              throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            }
            return fs.readFile(filePath, encoding);
          },
        },
      });
      expect(res.ok).toBe(false);
      expect(res.violations).toContainEqual({
        file: 'src/core/clean.ts',
        line: 0,
        rule: 'UNREADABLE_FILE',
      });

      const dirFailRes = await verifyNoStubs({
        rootDir: tmpPerm,
        fsOps: {
          lstat: fs.lstat,
          readdir: (async (dirPath: Parameters<typeof fs.readdir>[0]) => {
            if (String(dirPath).endsWith(`${path.sep}infrastructure`)) {
              throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            }
            return fs.readdir(dirPath);
          }) as typeof fs.readdir,
          readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
        },
      });
      expect(dirFailRes.ok).toBe(false);
      expect(dirFailRes.violations).toContainEqual({
        file: 'src/infrastructure',
        line: 0,
        rule: 'UNREADABLE_DIRECTORY',
      });
    } finally {
      await fs.rm(tmpPerm, { recursive: true, force: true });
    }
  });

  it('detects every stub marker and banned security pattern independently', async () => {
    const { verifyNoStubs } = await loadVerifierModule();

    const badFixtures: Array<{ relPath: string; content: string; rule: string }> =
      [
        {
          relPath: 'src/core/nested/a.ts',
          content: `export const msg = '${'not ' + 'wired'}';\n`,
          rule: 'STUB_NOT_WIRED',
        },
        {
          relPath: 'src/core/nested/b.ts',
          content: `// ${'TO' + 'DO'}: ${'com' + 'pose'} adapter\n`,
          rule: 'STUB_TODO_COMPOSE',
        },
        {
          relPath: 'src/core/nested/c.ts',
          content: `// ${'FIX' + 'ME'}: ${'com' + 'pose'} port\n`,
          rule: 'STUB_FIXME_COMPOSE',
        },
        {
          relPath: 'src/core/nested/d.ts',
          content: `export function f() { throw new Error("${'Not ' + 'implemented'}"); }\n`,
          rule: 'STUB_NOT_IMPLEMENTED',
        },
        {
          relPath: 'src/core/nested/e.ts',
          content: `export function f() { throw new Error('${'Not ' + 'implemented'}'); }\n`,
          rule: 'STUB_NOT_IMPLEMENTED',
        },
        {
          relPath: 'src/infrastructure/auth1.ts',
          content: `export const s = (sb: any) => sb.${'auth'}.${'getSession'}();\n`,
          rule: 'BANNED_AUTH_GET_SESSION',
        },
        {
          relPath: 'src/infrastructure/auth2.ts',
          content: `export const s = (sb: any) => sb\n  .${'auth'}\n  ?.${'getSession'}();\n`,
          rule: 'BANNED_AUTH_GET_SESSION',
        },
        {
          relPath: 'src/infrastructure/sql1.ts',
          content: `export const q = (p: any) => p.${'$queryRaw' + 'Unsafe'}('SELECT 1');\n`,
          rule: 'BANNED_QUERY_RAW_UNSAFE',
        },
        {
          relPath: 'src/infrastructure/sql2.ts',
          content: `export const q = (p: any) => p.${'$executeRaw' + 'Unsafe'}('SELECT 1');\n`,
          rule: 'BANNED_EXECUTE_RAW_UNSAFE',
        },
        {
          relPath: 'src/infrastructure/sql3.ts',
          content: [
            `export const q = (tx: any) => tx.${'$execute' + 'Raw'}\``,
            `  SELECT ${'set_' + 'config'}('app.current_org_id', 'x', true)`,
            '`;',
          ].join('\n'),
          rule: 'BANNED_EXECUTE_RAW_SET_CONFIG',
        },
        {
          relPath: 'src/infrastructure/sql4.ts',
          content: `export const q = (tx: any) => tx.${'$execute' + 'Raw'}(\n  "SELECT ${'set_' + 'config'}(\'a\', \'b\', true)"\n);\n`,
          rule: 'BANNED_EXECUTE_RAW_SET_CONFIG',
        },
      ];

    for (const fixture of badFixtures) {
      const tmpRoot = await createCleanFixtureRoot();
      try {
        const target = path.join(tmpRoot, fixture.relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, fixture.content, 'utf8');

        const res = await verifyNoStubs({ rootDir: tmpRoot });
        expect(res.ok).toBe(false);
        expect(res.violations.some((v) => v.file === fixture.relPath && v.rule === fixture.rule)).toBe(true);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    }
  });
});

// Compile-time structural check ensuring PricingAndCompliancePolicy matches Section 6 contract
export type _CheckPolicyMetadata = PricingAndCompliancePolicy['metadata'];
