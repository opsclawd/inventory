import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CashCustodyState,
  CurrencyCode,
  DomesticSaleChannel,
  LocationOperationalStatus,
  PaymentSettlementState,
  Prisma,
  SaleMarketNode,
  TaxCollectionMode,
  UserRole,
  type PrismaClient,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  InMemoryConstraintError,
  InMemoryPhase1AStore,
  createSeededInMemoryPhase1AStore,
} from '@/infrastructure/db/in-memory-phase1a-store';
import {
  EXPECTED_TABLES,
  hasPinnedEmptySearchPath,
  validateMigrationSql,
} from '@/infrastructure/db/sql-constraints-manifest';
import {
  TenantContextError,
  withAuthBootstrapTransaction,
  withTenantTransaction,
} from '@/infrastructure/db/tenant-transaction';
import {
  PHASE1A_SEED_FIXTURES,
  PHASE1A_SEED_IDS,
  SeedConflictError,
  seedPhase1AData,
} from '../../../../prisma/seed';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'prisma/migrations/0001_init_multi_schema_and_constraints/migration.sql',
);

function loadMigrationSql(): string {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

interface FakeRawCall {
  sql: string;
  values: unknown[];
}

function createFakePrismaHarness(options?: {
  returnedOrgId?: string | null;
  returnedUserId?: string | null;
  nestedRow?: { orgId: string | null; userId: string | null; role: string | null };
}) {
  const txCalls: Array<{
    options: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    };
  }> = [];
  const rawCalls: FakeRawCall[] = [];
  const forbiddenCalls: string[] = [];

  const txClient = {
    $queryRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ? ').replace(/\s+/g, ' ').trim();
        rawCalls.push({ sql, values });

        if (sql.includes('current_org_id') && sql.includes('current_role')) {
          return [
            options?.nestedRow ?? {
              orgId:
                options?.returnedOrgId !== undefined
                  ? options.returnedOrgId
                  : PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
              userId:
                options?.returnedUserId !== undefined
                  ? options.returnedUserId
                  : PHASE1A_SEED_IDS.users.hunterMechanic,
              role: UserRole.HUNTER_MECHANIC,
            },
          ];
        }
        if (sql.includes('current_org_id')) {
          return [
            {
              orgId:
                options?.returnedOrgId !== undefined
                  ? options.returnedOrgId
                  : PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
            },
          ];
        }
        if (sql.includes('current_user_id')) {
          return [
            {
              userId:
                options?.returnedUserId !== undefined
                  ? options.returnedUserId
                  : PHASE1A_SEED_IDS.users.architectCfo,
            },
          ];
        }
        return [
          {
            org_id: String(values[0] ?? ''),
            user_id: String(values[1] ?? ''),
            role_name: String(values[2] ?? ''),
            statement_timeout: String(values[3] ?? ''),
          },
        ];
      },
    ),
    $executeRaw: vi.fn(async () => {
      forbiddenCalls.push('$executeRaw');
      throw new Error('$executeRaw must not be invoked by tenant wrapper');
    }),
  } as unknown as Prisma.TransactionClient;

  const prismaClient = {
    $transaction: vi.fn(
      async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        txOpts: {
          isolationLevel?: Prisma.TransactionIsolationLevel;
          maxWait?: number;
          timeout?: number;
        },
      ) => {
        txCalls.push({ options: txOpts });
        return fn(txClient);
      },
    ),
  } as unknown as PrismaClient;

  return { prismaClient, txClient, txCalls, rawCalls, forbiddenCalls };
}

describe('Phase 1A SQL migration manifest validation (offline)', () => {
  it('passes validateMigrationSql against 0001_init_multi_schema_and_constraints/migration.sql', () => {
    const sql = loadMigrationSql();
    const result = validateMigrationSql(sql);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(EXPECTED_TABLES).toHaveLength(28);
  });

  it('fails closed on empty SQL or comment-only security directives', () => {
    expect(validateMigrationSql('').ok).toBe(false);

    const commentedOnly = `
      -- CREATE SCHEMA "shared";
      -- ALTER TABLE "shared"."User" FORCE ROW LEVEL SECURITY;
      -- SECURITY DEFINER SET search_path = ''
    `;
    const res = validateMigrationSql(commentedOnly);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('contains only comments');
  });

  it('fails if FORCE ROW LEVEL SECURITY is removed on shared.User or salvage.Part', () => {
    const baseSql = loadMigrationSql();

    const withoutUserForceRls = baseSql.replace(
      /ALTER TABLE "shared"\."User" FORCE ROW LEVEL SECURITY;/g,
      '',
    );
    const resUser = validateMigrationSql(withoutUserForceRls);
    expect(resUser.ok).toBe(false);
    expect(resUser.errors.some((e) => e.includes('"shared"."User"'))).toBe(
      true,
    );

    const withoutPartForceRls = baseSql.replace(
      /ALTER TABLE "salvage"\."Part" FORCE ROW LEVEL SECURITY;/g,
      '',
    );
    const resPart = validateMigrationSql(withoutPartForceRls);
    expect(resPart.ok).toBe(false);
    expect(resPart.errors.some((e) => e.includes('"salvage"."Part"'))).toBe(
      true,
    );
  });

  it('fails if SECURITY DEFINER helper drops SET search_path = "" or SECURITY DEFINER', () => {
    const baseSql = loadMigrationSql();
    const weakened = baseSql.replace(
      /CREATE OR REPLACE FUNCTION "shared"\."current_org_id"\(\)[\s\S]*?\$\$;/,
      `CREATE OR REPLACE FUNCTION "shared"."current_org_id"() RETURNS uuid LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN NULL; END; $$;`,
    );

    const res = validateMigrationSql(weakened);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('current_org_id'))).toBe(true);
  });

  it('fails if broad ALTER DEFAULT PRIVILEGES or ALL TABLES grants are added to erp_app_user', () => {
    const baseSql = loadMigrationSql();

    const withDefaultPrivs = `${baseSql}\nALTER DEFAULT PRIVILEGES IN SCHEMA salvage GRANT ALL ON TABLES TO erp_app_user;\n`;
    expect(validateMigrationSql(withDefaultPrivs).ok).toBe(false);

    const withAllTablesGrant = `${baseSql}\nGRANT SELECT, INSERT ON ALL TABLES IN SCHEMA salvage TO erp_app_user;\n`;
    expect(validateMigrationSql(withAllTablesGrant).ok).toBe(false);
  });

  it('fails if forbidden table-level UPDATE/INSERT/DELETE grants are granted to erp_app_user', () => {
    const baseSql = loadMigrationSql();

    const userUpdateAll = `${baseSql}\nGRANT UPDATE ON "shared"."User" TO erp_app_user;\n`;
    expect(validateMigrationSql(userUpdateAll).ok).toBe(false);

    const auditDelete = `${baseSql}\nGRANT DELETE ON "shared"."AuditLog" TO erp_app_user;\n`;
    expect(validateMigrationSql(auditDelete).ok).toBe(false);
  });

  it('fails if auth.jwt() appears in any policy or composite tenant FK is replaced by single-column FK', () => {
    const baseSql = loadMigrationSql();

    const withJwt = `${baseSql}\nCREATE POLICY bad_jwt ON "salvage"."Part" FOR SELECT USING ((auth.jwt()->>'org_id')::uuid = "organizationId");\n`;
    expect(validateMigrationSql(withJwt).ok).toBe(false);

    const brokenCompositeFk = baseSql.replace(
      'FOREIGN KEY ("organizationId", "donorVehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id")',
      'FOREIGN KEY ("donorVehicleId") REFERENCES "salvage"."Vehicle"("id")',
    );
    const resFk = validateMigrationSql(brokenCompositeFk);
    expect(resFk.ok).toBe(false);
    expect(
      resFk.errors.some((e) => e.includes('donorVehicleId')),
    ).toBe(true);
  });

  it('fails if SaleTransaction CHECK constraints or settlement trigger are removed', () => {
    const baseSql = loadMigrationSql();

    const noTaxCheck = baseSql.replace(
      /sale_tax_collection_mode_consistency/g,
      'removed_tax_check',
    );
    expect(validateMigrationSql(noTaxCheck).ok).toBe(false);

    const noSettlementCheck = baseSql.replace(
      /sale_settlement_custody_consistency/g,
      'removed_settlement_check',
    );
    expect(validateMigrationSql(noSettlementCheck).ok).toBe(false);

    const noSettlementTrigger = baseSql.replace(
      /b_enforce_sale_settlement_transition/g,
      'removed_trigger',
    );
    expect(validateMigrationSql(noSettlementTrigger).ok).toBe(false);
  });

  it('fails if forbidden cannabis_production_run_mass_balance CHECK exists or FOR UPDATE is removed from child trigger', () => {
    const baseSql = loadMigrationSql();

    const withPrematureCheck = `${baseSql}\nALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT cannabis_production_run_mass_balance CHECK ("variancePercentage" <= 2.0);\n`;
    expect(validateMigrationSql(withPrematureCheck).ok).toBe(false);

    const withoutForUpdate = baseSql.replace(
      /FOR UPDATE;/,
      ';',
    );
    const res = validateMigrationSql(withoutForUpdate);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('FOR UPDATE'))).toBe(true);
  });

  it('accepts PostgreSQL GUC_LIST_QUOTE empty search_path ("search_path=\\"\\"") and rejects non-empty search_path', () => {
    expect(hasPinnedEmptySearchPath(['search_path=""'])).toBe(true);
    expect(hasPinnedEmptySearchPath(['search_path='])).toBe(true);
    expect(hasPinnedEmptySearchPath(["search_path=''"])).toBe(true);

    expect(hasPinnedEmptySearchPath(null)).toBe(false);
    expect(hasPinnedEmptySearchPath([])).toBe(false);
    expect(hasPinnedEmptySearchPath(['search_path=public'])).toBe(false);
    expect(hasPinnedEmptySearchPath(['search_path=pg_temp'])).toBe(false);
  });
});

describe('withTenantTransaction & withAuthBootstrapTransaction wrapper', () => {
  it('opens READ COMMITTED transaction, initializes GUCs via parameterized $queryRaw, normalizes UUIDs, and verifies current_org_id()', async () => {
    const harness = createFakePrismaHarness({
      returnedOrgId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
    });

    const result = await withTenantTransaction(
      harness.prismaClient,
      {
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT.toUpperCase(),
        userId: PHASE1A_SEED_IDS.users.hunterMechanic.toUpperCase(),
        role: UserRole.HUNTER_MECHANIC,
      },
      async () => 'ok',
      { maxWait: 2500, timeout: 9000 },
    );

    expect(result).toBe('ok');
    expect(harness.forbiddenCalls).toEqual([]);
    expect(harness.txCalls).toHaveLength(1);
    expect(harness.txCalls[0]?.options).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 2500,
      timeout: 9000,
    });

    expect(harness.rawCalls).toHaveLength(2);
    expect(harness.rawCalls[0]?.sql).toContain("set_config('app.current_org_id'");
    expect(harness.rawCalls[0]?.values).toEqual([
      PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      PHASE1A_SEED_IDS.users.hunterMechanic,
      UserRole.HUNTER_MECHANIC,
      '9000',
    ]);
    expect(harness.rawCalls[1]?.sql).toContain('"shared"."current_org_id"()');
  });

  it('rejects invalid UUIDs, roles, and transaction options before touching Prisma', async () => {
    const harness = createFakePrismaHarness();

    await expect(
      withTenantTransaction(
        harness.prismaClient,
        {
          organizationId: 'not-a-uuid',
          userId: PHASE1A_SEED_IDS.users.hunterMechanic,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_CONTEXT_INPUT' });

    await expect(
      withTenantTransaction(
        harness.prismaClient,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          userId: PHASE1A_SEED_IDS.users.hunterMechanic,
          role: 'SUPER_ADMIN' as UserRole,
        },
        async () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_CONTEXT_INPUT' });

    await expect(
      withTenantTransaction(
        harness.prismaClient,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          userId: PHASE1A_SEED_IDS.users.hunterMechanic,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'never',
        { timeout: -5 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_CONTEXT_INPUT' });

    expect(harness.txCalls).toHaveLength(0);
  });

  it('throws TENANT_CONTEXT_UNAUTHORIZED and skips callback when current_org_id() returns null or different org', async () => {
    const harness = createFakePrismaHarness({ returnedOrgId: null });
    const callback = vi.fn(async () => 'should-not-run');

    await expect(
      withTenantTransaction(
        harness.prismaClient,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          userId: PHASE1A_SEED_IDS.users.revokedContractor,
          role: UserRole.HUNTER_MECHANIC,
        },
        callback,
      ),
    ).rejects.toBeInstanceOf(TenantContextError);

    expect(callback).not.toHaveBeenCalled();
  });

  it('reuses matching nested Prisma.TransactionClient and rejects mismatched org/user/role', async () => {
    const harness = createFakePrismaHarness({
      nestedRow: {
        orgId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        userId: PHASE1A_SEED_IDS.users.hunterMechanic,
        role: UserRole.HUNTER_MECHANIC,
      },
    });

    const nestedOk = await withTenantTransaction(
      harness.txClient,
      {
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT.toUpperCase(),
        userId: PHASE1A_SEED_IDS.users.hunterMechanic,
        role: UserRole.HUNTER_MECHANIC,
      },
      async () => 'nested-reused',
    );
    expect(nestedOk).toBe('nested-reused');
    expect(harness.txCalls).toHaveLength(0);

    await expect(
      withTenantTransaction(
        harness.txClient,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          userId: PHASE1A_SEED_IDS.users.hunterMechanic,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'mismatch',
      ),
    ).rejects.toMatchObject({ code: 'NESTED_TENANT_CONTEXT_MISMATCH' });

    await expect(
      withTenantTransaction(
        harness.txClient,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          userId: PHASE1A_SEED_IDS.users.hunterMechanic,
          role: UserRole.ARCHITECT_CFO,
        },
        async () => 'mismatch',
      ),
    ).rejects.toMatchObject({ code: 'NESTED_TENANT_CONTEXT_MISMATCH' });
  });

  it('initializes and verifies withAuthBootstrapTransaction safely without calling callback if inactive', async () => {
    const okHarness = createFakePrismaHarness({
      returnedUserId: PHASE1A_SEED_IDS.users.architectCfo,
    });
    const out = await withAuthBootstrapTransaction(
      okHarness.prismaClient,
      PHASE1A_SEED_IDS.users.architectCfo.toUpperCase(),
      async () => 'bootstrapped',
    );
    expect(out).toBe('bootstrapped');
    expect(okHarness.rawCalls[0]?.values[0]).toBe(
      PHASE1A_SEED_IDS.users.architectCfo,
    );

    const deniedHarness = createFakePrismaHarness({ returnedUserId: null });
    const spy = vi.fn(async () => 'nope');
    await expect(
      withAuthBootstrapTransaction(
        deniedHarness.prismaClient,
        PHASE1A_SEED_IDS.users.architectCfo,
        spy,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('InMemoryPhase1AStore & seedPhase1AData offline parity', () => {
  it('seeds deterministically on run 1, produces 0 creates on run 2, and passes JsonPolicyConfigAdapter validation', async () => {
    const store = new InMemoryPhase1AStore();

    const first = await seedPhase1AData(store);
    expect(first).toEqual({
      organizationsCreated: 2,
      usersCreated: 8,
      membershipsCreated: 9,
      storageLocationsCreated: 9,
      vehiclesCreated: 2,
      partsCreated: 3,
      scrapLogsCreated: 2,
      shipmentsCreated: 1,
    });

    const second = await seedPhase1AData(store);
    expect(second).toEqual({
      organizationsCreated: 0,
      usersCreated: 0,
      membershipsCreated: 0,
      storageLocationsCreated: 0,
      vehiclesCreated: 0,
      partsCreated: 0,
      scrapLogsCreated: 0,
      shipmentsCreated: 0,
    });

    const snap = store.getSnapshot();
    const salvageOrg = snap.organizations.find(
      (o) => o.id === PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
    );
    const cannabisOrg = snap.organizations.find(
      (o) => o.id === PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
    );
    expect(salvageOrg?.legalEntityName).toBe('Ontario Salvage OpCo Inc.');
    expect(cannabisOrg?.legalEntityName).toBe(
      'Brockville Cannabis Operations Inc.',
    );

    const policyAdapter = new JsonPolicyConfigAdapter({
      readOrganizationPolicy: async (organizationId) =>
        store.getOrganizationPolicy(organizationId),
    });

    const salvagePolicy = await policyAdapter.getPolicyForOrg(
      PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
    );
    expect(salvagePolicy.domesticTaxPolicy.isGstHstRegistered).toBe(true);
    expect(salvagePolicy.domesticTaxPolicy.isOmvicLicensed).toBe(false);
    expect(salvagePolicy.complianceThresholds.easrRegistrationNumber).toBeNull();
    expect(salvagePolicy.domesticSyndication.ebayShipFromCity).toBe(
      'Kemptville, ON',
    );
    expect(salvagePolicy.domesticSyndication.ebayShipFromPostalCode).toBe(
      'K0G 1J0',
    );
    expect(salvagePolicy.domesticSyndication.publicPickupLocationLabel).toBe(
      'Ottawa South / Hwy 416 Corridor',
    );

    const cannabisPolicy = await policyAdapter.getPolicyForOrg(
      PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
    );
    expect(cannabisPolicy.domesticTaxPolicy.isGstHstRegistered).toBe(false);
    expect(cannabisPolicy.domesticTaxPolicy.isOmvicLicensed).toBe(false);

    const kempPad = snap.storageLocations.find(
      (l) => l.id === PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
    );
    const ramsShop = snap.storageLocations.find(
      (l) => l.id === PHASE1A_SEED_IDS.locations.RAMS_SHOP,
    );
    const posvVault = snap.storageLocations.find(
      (l) => l.id === PHASE1A_SEED_IDS.locations.POSV_VAULT,
    );
    const brockFacility = snap.storageLocations.find(
      (l) => l.id === PHASE1A_SEED_IDS.locations.BROCK_SITE_FACILITY,
    );
    expect(kempPad?.locationOperationalStatus).toBe(
      LocationOperationalStatus.ACTIVE,
    );
    expect(ramsShop?.locationOperationalStatus).toBe(
      LocationOperationalStatus.PROPOSED_INACTIVE,
    );
    expect(posvVault?.locationOperationalStatus).toBe(
      LocationOperationalStatus.DORMANT_FUTURE,
    );
    expect(brockFacility?.locationOperationalStatus).toBe(
      LocationOperationalStatus.PROPOSED_INACTIVE,
    );
    expect(brockFacility?.allowsWholeVehicleDismantling).toBe(false);
  });

  it('preserves existing revocations and rolls back atomically on SeedConflictError', async () => {
    const store = await createSeededInMemoryPhase1AStore();
    store.setMembershipActive(
      PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      PHASE1A_SEED_IDS.users.hunterMechanic,
      false,
      'Temporary suspension',
    );

    await seedPhase1AData(store);

    const membershipAfterReseed = store
      .getSnapshot()
      .memberships.find(
        (m) =>
          m.organizationId === PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT &&
          m.userId === PHASE1A_SEED_IDS.users.hunterMechanic,
      );
    expect(membershipAfterReseed?.isActive).toBe(false);
    expect(membershipAfterReseed?.revocationReason).toBe('Temporary suspension');

    const conflictStore = new InMemoryPhase1AStore();
    await conflictStore.withTransaction(async (tx) => {
      await tx.upsertOrganization({
        ...PHASE1A_SEED_FIXTURES.organizations[0]!,
        id: '99999999-0000-4000-8000-000000000001',
      });
    });

    await expect(seedPhase1AData(conflictStore)).rejects.toBeInstanceOf(
      SeedConflictError,
    );
    expect(conflictStore.getSnapshot().users).toHaveLength(0);
    expect(conflictStore.getSnapshot().organizations).toHaveLength(1);
  });

  it('enforces tenant isolation, revocation denial, User isolation, composite FKs, and SaleTransaction invariants', async () => {
    const store = await createSeededInMemoryPhase1AStore();

    // Salvage mechanic sees salvage rows and salvage co-members only (not cannabis-only personnel)
    await store.withTenantTransaction(
      {
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        userId: PHASE1A_SEED_IDS.users.hunterMechanic,
        role: UserRole.HUNTER_MECHANIC,
      },
      async (tx) => {
        expect(tx.listVehicles()).toHaveLength(2);
        expect(tx.listParts()).toHaveLength(3);
        const visibleUsers = tx.listUsers();
        const visibleIds = new Set(visibleUsers.map((u) => u.id));
        expect(visibleIds.has(PHASE1A_SEED_IDS.users.hunterMechanic)).toBe(
          true,
        );
        // Seeded deactivated salvage co-member remains visible to salvage org for historical FK integrity
        expect(visibleIds.has(PHASE1A_SEED_IDS.users.revokedContractor)).toBe(
          true,
        );
        // Cannabis-only users remain invisible
        expect(visibleIds.has(PHASE1A_SEED_IDS.users.cannabisQap)).toBe(false);
        expect(visibleIds.has(PHASE1A_SEED_IDS.users.nurseryTech)).toBe(false);

        // Cannot update privileged role/isActive columns or another user's profile
        expect(() =>
          tx.updateUserProfile(PHASE1A_SEED_IDS.users.hunterMechanic, {
            role: UserRole.ARCHITECT_CFO,
          }),
        ).toThrow(InMemoryConstraintError);
        expect(() =>
          tx.updateUserProfile(PHASE1A_SEED_IDS.users.ontarioStripper, {
            fullName: 'Tampered',
          }),
        ).toThrow(InMemoryConstraintError);

        // Cross-tenant composite FK rejected (salvage part referencing brockville location)
        expect(() =>
          tx.createPart({
            ...PHASE1A_SEED_FIXTURES.parts[0]!,
            id: '60000000-0000-4000-8000-000000000099',
            qrSkuCode: 'PART-BAD-LOC',
            storageLocationId: PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2,
          }),
        ).toThrow(InMemoryConstraintError);
      },
    );

    // Seeded revoked contractor denied
    await expect(
      store.withTenantTransaction(
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          userId: PHASE1A_SEED_IDS.users.revokedContractor,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'denied',
      ),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });

    // Dual-org bootstrap sees both orgs for CFO, 1 org for mechanic, 0 for revoked contractor
    const cfoOrgs = await store.withAuthBootstrapTransaction(
      PHASE1A_SEED_IDS.users.architectCfo,
      async (tx) => tx.listAccessibleOrganizations(),
    );
    expect(cfoOrgs).toHaveLength(2);

    const revokedOrgs = await store.withAuthBootstrapTransaction(
      PHASE1A_SEED_IDS.users.revokedContractor,
      async (tx) => tx.listAccessibleOrganizations(),
    );
    expect(revokedOrgs).toHaveLength(0);

    // SaleTransaction tax, custody, settlement transitions, and refund line-item release
    const saleId = '90000000-0000-4000-8000-000000000001';
    const partItemId = '91000000-0000-4000-8000-000000000001';
    await store.withTenantTransaction(
      {
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        userId: PHASE1A_SEED_IDS.users.architectCfo,
        role: UserRole.ARCHITECT_CFO,
      },
      async (tx) => {
        // eBay order cannot set taxCollectionMode != MARKETPLACE_FACILITATOR_COLLECTED
        expect(() =>
          tx.createSaleTransaction({
            id: '90000000-0000-4000-8000-000000000099',
            organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
            receiptNumber: 'ONT-BAD-EBAY-1',
            marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
            domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
            exportChannel: null,
            deliveryMethod: 'SELLER_SHIPPED',
            destinationCountryCode: 'CA',
            destinationProvinceOrState: 'NS',
            exportProofStorageKey: null,
            taxInvoiceNumber: null,
            buyerName: 'eBay Buyer',
            buyerPhoneE164: null,
            soldByUserId: PHASE1A_SEED_IDS.users.architectCfo,
            brokerUserId: null,
            verifiedByAdminId: PHASE1A_SEED_IDS.users.architectCfo,
            paymentCurrency: CurrencyCode.CAD,
            subtotalMinor: 10_000,
            discountAmountMinor: 0,
            platformFeeMinor: 1_300,
            shippingCostMinor: 1_500,
            taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
            appliedTaxJurisdiction: 'CA-NS',
            appliedTaxRateBps: 1400,
            taxOrVatMinor: 1_400,
            buyerTaxRemittedByPlatformMinor: null,
            estimatedPlatformFeeTaxCadMinor: 195,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            feeTaxInvoiceStorageKey: null,
            grossCollectedMinor: 11_400,
            netRealizedCadMinor: 7_200,
            paymentMethod: 'EBAY_MANAGED_PAYOUT',
            paymentSettlementState:
              PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
            paymentConfirmedAt: null,
            bankSettledAt: null,
            bankDepositReference: null,
            settlementProofStorageKey: null,
            cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
            paymentProofStorageKey: 'evidence/ebay-1.png',
            billOfSaleStorageKey: null,
            brokerCommissionBps: 0,
            brokerCommissionMinor: 0,
            brokerCommissionPaidAt: null,
            isPaymentVerified: false,
            isVoidedOrReversed: false,
            reversesSaleTxId: null,
            voidReason: null,
          }),
        ).toThrow(InMemoryConstraintError);

        tx.createSaleTransaction({
          id: saleId,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          receiptNumber: 'ONT-2026-0001',
          marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
          domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
          exportChannel: null,
          deliveryMethod: 'IN_PERSON_PICKUP',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          exportProofStorageKey: null,
          taxInvoiceNumber: 'INV-2026-0001',
          buyerName: 'Walk-in Buyer',
          buyerPhoneE164: '+16135550199',
          soldByUserId: PHASE1A_SEED_IDS.users.hunterMechanic,
          brokerUserId: null,
          verifiedByAdminId: PHASE1A_SEED_IDS.users.architectCfo,
          paymentCurrency: CurrencyCode.CAD,
          subtotalMinor: 15_000,
          discountAmountMinor: 0,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
          appliedTaxJurisdiction: 'CA-ON',
          appliedTaxRateBps: 1300,
          taxOrVatMinor: 1_950,
          buyerTaxRemittedByPlatformMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          grossCollectedMinor: 16_950,
          netRealizedCadMinor: 15_000,
          paymentMethod: 'CASH',
          paymentSettlementState: PaymentSettlementState.SALE_RECORDED,
          paymentConfirmedAt: null,
          bankSettledAt: null,
          bankDepositReference: null,
          settlementProofStorageKey: null,
          cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
          paymentProofStorageKey: 'evidence/sale-1.png',
          billOfSaleStorageKey: null,
          brokerCommissionBps: 0,
          brokerCommissionMinor: 0,
          brokerCommissionPaidAt: null,
          isPaymentVerified: false,
          isVoidedOrReversed: false,
          reversesSaleTxId: null,
          voidReason: null,
          partItems: [
            {
              id: partItemId,
              partId: PHASE1A_SEED_IDS.parts.alternator,
              soldPriceMinor: 15_000,
            },
          ],
        });

        // Cannot jump SALE_RECORDED -> BANK_SETTLEMENT_CONFIRMED with CASH
        expect(() =>
          tx.updateSaleTransaction(saleId, {
            paymentSettlementState:
              PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
            cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
            bankSettledAt: new Date(),
            bankDepositReference: 'DEP-BAD',
          }),
        ).toThrow(InMemoryConstraintError);

        // Refund transitions cleanly and releases active SaleTransactionPartItem lock
        tx.updateSaleTransaction(saleId, {
          paymentSettlementState:
            PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
          isVoidedOrReversed: true,
          voidReason: 'Customer returned part before pickup',
        });
        expect(tx.listSalePartItems(saleId)[0]?.isActiveSale).toBe(false);

        // Terminal state cannot transition further
        expect(() =>
          tx.updateSaleTransaction(saleId, {
            paymentSettlementState: PaymentSettlementState.PAYMENT_INITIATED,
          }),
        ).toThrow(InMemoryConstraintError);
      },
    );
  });
});

if (
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0 &&
  process.env.VITEST_INCLUDE_RLS !== '1'
) {
  await import('./rls.integration.test');
}
