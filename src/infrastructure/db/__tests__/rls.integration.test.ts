import { randomUUID } from 'node:crypto';
import {
  AraConditionGradeEnum,
  CashCustodyState,
  ClassifiedsSyncState,
  CurrencyCode,
  DomesticSaleChannel,
  EbaySyncState,
  InventoryAvailabilityState,
  PartComplianceState,
  PartCustodyState,
  PaymentSettlementState,
  PrismaClient,
  SaleMarketNode,
  SteeringSideCompatibility,
  TaxCollectionMode,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateLiveDatabaseCatalog } from '@/infrastructure/db/sql-constraints-manifest';
import {
  withAuthBootstrapTransaction,
  withTenantTransaction,
} from '@/infrastructure/db/tenant-transaction';
import { PHASE1A_SEED_IDS } from '../../../../prisma/seed';

function requirePostgresUrl(envName: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const raw = process.env[envName];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      `${envName} is required to run PostgreSQL RLS integration tests (fail-closed policy).`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${envName} must be a valid PostgreSQL connection URL.`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `${envName} must use postgresql:// or postgres:// protocol.`,
    );
  }
  return raw;
}

function withSingleConnectionLimit(urlString: string): string {
  const parsed = new URL(urlString);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}

const TEST_DATABASE_URL = requirePostgresUrl('TEST_DATABASE_URL');
const DIRECT_URL = requirePostgresUrl('DIRECT_URL');

const SALVAGE_ORG = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
const CANNABIS_ORG = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;
const CFO_USER = PHASE1A_SEED_IDS.users.architectCfo;
const MECHANIC_USER = PHASE1A_SEED_IDS.users.hunterMechanic;
const STRIPPER_USER = PHASE1A_SEED_IDS.users.ontarioStripper;
const REVOKED_USER = PHASE1A_SEED_IDS.users.revokedContractor;
const CANNABIS_QAP = PHASE1A_SEED_IDS.users.cannabisQap;
const NURSERY_TECH = PHASE1A_SEED_IDS.users.nurseryTech;

let runtimePrisma!: PrismaClient;
let singleConnRuntimePrisma!: PrismaClient;
let ownerPrisma!: PrismaClient;
let ownerSecondConn!: PrismaClient;

beforeAll(async () => {
  runtimePrisma = new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
  });
  singleConnRuntimePrisma = new PrismaClient({
    datasources: { db: { url: withSingleConnectionLimit(TEST_DATABASE_URL) } },
  });
  ownerPrisma = new PrismaClient({
    datasources: { db: { url: DIRECT_URL } },
  });
  ownerSecondConn = new PrismaClient({
    datasources: { db: { url: DIRECT_URL } },
  });

  await Promise.all([
    runtimePrisma.$connect(),
    singleConnRuntimePrisma.$connect(),
    ownerPrisma.$connect(),
    ownerSecondConn.$connect(),
  ]);
});

afterAll(async () => {
  await Promise.allSettled([
    runtimePrisma?.$disconnect(),
    singleConnRuntimePrisma?.$disconnect(),
    ownerPrisma?.$disconnect(),
    ownerSecondConn?.$disconnect(),
  ]);
});

async function pollUntilWaitingOnLock(
  waitingBackendPid: number,
  blockingBackendPid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await ownerPrisma.$queryRaw<
      Array<{ waitEventType: string | null; blockingPids: number[] }>
    >`
      SELECT
        sa.wait_event_type AS "waitEventType",
        pg_blocking_pids(${waitingBackendPid}::int) AS "blockingPids"
      FROM pg_stat_activity sa
      WHERE sa.pid = ${waitingBackendPid}::int
    `;
    const row = rows[0];
    if (
      row &&
      row.waitEventType === 'Lock' &&
      Array.isArray(row.blockingPids) &&
      row.blockingPids.includes(blockingBackendPid)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe('Live PostgreSQL erp_app_user FORCE RLS, SQL constraints & triggers', () => {
  it('1. connects strictly as least-privilege erp_app_user with NOBYPASSRLS and passes validateLiveDatabaseCatalog()', async () => {
    const roleRows = await runtimePrisma.$queryRaw<
      Array<{
        currentUser: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        planCacheMode: string | null;
      }>
    >`
      SELECT
        current_user::text AS "currentUser",
        r.rolsuper,
        r.rolbypassrls,
        r.rolcreaterole,
        r.rolcreatedb,
        pg_catalog.current_setting('plan_cache_mode', true) AS "planCacheMode"
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user
    `;

    expect(roleRows[0]).toEqual({
      currentUser: 'erp_app_user',
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      planCacheMode: 'force_custom_plan',
    });

    const catalogResult = await validateLiveDatabaseCatalog(ownerPrisma);
    expect(catalogResult.errors).toEqual([]);
    expect(catalogResult.ok).toBe(true);
  });

  it('2. fails closed on missing, invalid, non-existent, and role-spoofed tenant contexts', async () => {
    const unauthVehicles = await runtimePrisma.vehicle.findMany();
    expect(unauthVehicles).toHaveLength(0);

    const helperRows = await runtimePrisma.$queryRaw<
      Array<{ orgId: string | null; userId: string | null }>
    >`
      SELECT
        "shared"."current_org_id"()::text AS "orgId",
        "shared"."current_user_id"()::text AS "userId"
    `;
    expect(helperRows[0]).toEqual({ orgId: null, userId: null });

    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: 'not-a-uuid',
          userId: MECHANIC_USER,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_CONTEXT_INPUT' });

    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: '00000000-0000-0000-0000-000000000099',
          userId: MECHANIC_USER,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'never',
      ),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });

    // Role escalation attempt: hunterMechanic spoofing ARCHITECT_CFO
    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: MECHANIC_USER,
          role: UserRole.ARCHITECT_CFO,
        },
        async () => 'escalated',
      ),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });
  });

  it('3. enforces strict cross-tenant isolation across reads, writes, and composite tenant FKs', async () => {
    const salvageData = await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: MECHANIC_USER,
        role: UserRole.HUNTER_MECHANIC,
      },
      async (tx) => {
        const vehicles = await tx.vehicle.findMany();
        const locations = await tx.storageLocation.findMany();
        return { vehicles, locations };
      },
    );

    expect(salvageData.vehicles.length).toBeGreaterThanOrEqual(2);
    expect(
      salvageData.vehicles.every((v) => v.organizationId === SALVAGE_ORG),
    ).toBe(true);
    expect(
      salvageData.locations.some((l) => l.siteCode === 'BROCK'),
    ).toBe(false);

    // Cannabis nursery tech sees Brockville locations and ZERO salvage rows
    await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: CANNABIS_ORG,
        userId: NURSERY_TECH,
        role: UserRole.NURSERY_CULTIVATION_TECH,
      },
      async (tx) => {
        const vehicles = await tx.vehicle.findMany();
        const parts = await tx.part.findMany();
        const locations = await tx.storageLocation.findMany();
        expect(vehicles).toHaveLength(0);
        expect(parts).toHaveLength(0);
        expect(
          locations.every((l) => l.organizationId === CANNABIS_ORG),
        ).toBe(true);
      },
    );

    // Cross-tenant write rejected by RLS WITH CHECK (separate tx to avoid 25P02 aborted-tx state)
    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: CANNABIS_ORG,
          userId: NURSERY_TECH,
          role: UserRole.NURSERY_CULTIVATION_TECH,
        },
        async (tx) =>
          tx.part.create({
            data: {
              id: randomUUID(),
              organizationId: SALVAGE_ORG,
              qrSkuCode: `BAD-CROSS-${randomUUID().slice(0, 8)}`,
              donorVehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
              strippedByUserId: MECHANIC_USER,
              custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              ebaySyncState: EbaySyncState.NOT_LISTED,
              classifiedsSyncState: ClassifiedsSyncState.NOT_POSTED,
              complianceState: PartComplianceState.CLEARED_FOR_SALE,
              partCategoryName: 'Alternator',
              steeringSideCompatibility: SteeringSideCompatibility.UNIVERSAL,
              tdgHazmatCode: TdgHazmatCode.NONE,
              oemPartNumbers: ['31100-5LA-A01'],
              interchangePartNumbers: [],
              suggestedHsCode: '8511.50',
              araGrade: AraConditionGradeEnum.GRADE_A,
              araDamageCode: '00',
              weightKg: 5,
              storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
              allocatedCostBasisCadMinor: 1000,
              retailPriceCadMinor: 5000,
            },
          }),
      ),
    ).rejects.toThrow();

    // Cross-tenant composite FK rejected even if organizationId matches CANNABIS_ORG
    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: CANNABIS_ORG,
          userId: NURSERY_TECH,
          role: UserRole.NURSERY_CULTIVATION_TECH,
        },
        async (tx) =>
          tx.part.create({
            data: {
              id: randomUUID(),
              organizationId: CANNABIS_ORG,
              qrSkuCode: `BAD-FK-${randomUUID().slice(0, 8)}`,
              donorVehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
              strippedByUserId: NURSERY_TECH,
              custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              ebaySyncState: EbaySyncState.NOT_LISTED,
              classifiedsSyncState: ClassifiedsSyncState.NOT_POSTED,
              complianceState: PartComplianceState.CLEARED_FOR_SALE,
              partCategoryName: 'Alternator',
              steeringSideCompatibility: SteeringSideCompatibility.UNIVERSAL,
              tdgHazmatCode: TdgHazmatCode.NONE,
              oemPartNumbers: ['31100-5LA-A01'],
              interchangePartNumbers: [],
              suggestedHsCode: '8511.50',
              araGrade: AraConditionGradeEnum.GRADE_A,
              araDamageCode: '00',
              weightKg: 5,
              storageLocationId: PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2,
              allocatedCostBasisCadMinor: 1000,
              retailPriceCadMinor: 5000,
            },
          }),
      ),
    ).rejects.toThrow();
  });

  it('4. immediately denies seeded revoked memberships and live mid-session revocations', async () => {
    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: REVOKED_USER,
          role: UserRole.HUNTER_MECHANIC,
        },
        async () => 'should-fail',
      ),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });

    const tempUserId = randomUUID();
    const tempMembershipId = randomUUID();
    await ownerPrisma.user.create({
      data: {
        id: tempUserId,
        email: `ephemeral-${tempUserId.slice(0, 8)}@seed.local`,
        fullName: 'Ephemeral Contractor',
        role: UserRole.HUNTER_MECHANIC,
        isActive: true,
      },
    });
    await ownerPrisma.organizationMembership.create({
      data: {
        id: tempMembershipId,
        organizationId: SALVAGE_ORG,
        userId: tempUserId,
        role: UserRole.HUNTER_MECHANIC,
        isActive: true,
      },
    });

    try {
      const beforeRevoke = await withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: tempUserId,
          role: UserRole.HUNTER_MECHANIC,
        },
        async (tx) => tx.organization.findMany({ select: { id: true } }),
      );
      expect(beforeRevoke).toHaveLength(1);

      await ownerPrisma.organizationMembership.update({
        where: { id: tempMembershipId },
        data: {
          isActive: false,
          deactivatedAt: new Date(),
          revocationReason: 'Integration test live revocation',
        },
      });

      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: SALVAGE_ORG,
            userId: tempUserId,
            role: UserRole.HUNTER_MECHANIC,
          },
          async () => 'denied-immediately',
        ),
      ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });
    } finally {
      await ownerPrisma.organizationMembership.delete({
        where: { id: tempMembershipId },
      });
      await ownerPrisma.user.delete({ where: { id: tempUserId } });
    }
  });

  it('5. enforces shared.User RLS firewall and column-level least-privilege grants', async () => {
    await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: MECHANIC_USER,
        role: UserRole.HUNTER_MECHANIC,
      },
      async (tx) => {
        const users = await tx.user.findMany({ select: { id: true, fullName: true } });
        const userIds = new Set(users.map((u) => u.id));
        expect(userIds.has(MECHANIC_USER)).toBe(true);
        expect(userIds.has(STRIPPER_USER)).toBe(true);
        // Historical inactive co-member in same org remains visible for FK integrity
        expect(userIds.has(REVOKED_USER)).toBe(true);
        // Cannabis-only users cannot be enumerated
        expect(userIds.has(CANNABIS_QAP)).toBe(false);
        expect(userIds.has(NURSERY_TECH)).toBe(false);
      },
    );

    const mechanicCtx = {
      organizationId: SALVAGE_ORG,
      userId: MECHANIC_USER,
      role: UserRole.HUNTER_MECHANIC,
    };

    // Cannot update another user's profile
    await expect(
      withTenantTransaction(runtimePrisma, mechanicCtx, async (tx) =>
        tx.user.update({
          where: { id: STRIPPER_USER },
          data: { fullName: 'Cross-user overwrite' },
        }),
      ),
    ).rejects.toThrow();

    // Cannot update privileged role or isActive columns on own row (42501 privilege error)
    await expect(
      withTenantTransaction(runtimePrisma, mechanicCtx, async (tx) =>
        tx.user.update({
          where: { id: MECHANIC_USER },
          data: { role: UserRole.ARCHITECT_CFO },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(runtimePrisma, mechanicCtx, async (tx) =>
        tx.user.update({
          where: { id: MECHANIC_USER },
          data: { isActive: false },
        }),
      ),
    ).rejects.toThrow();

    // Cannot INSERT or DELETE shared.User
    await expect(
      withTenantTransaction(runtimePrisma, mechanicCtx, async (tx) =>
        tx.user.create({
          data: {
            id: randomUUID(),
            email: 'forged@seed.local',
            fullName: 'Forged User',
            role: UserRole.ARCHITECT_CFO,
          },
        }),
      ),
    ).rejects.toThrow();

    // Allowed self-profile update succeeds and restores original fullName cleanly
    await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: MECHANIC_USER,
        role: UserRole.HUNTER_MECHANIC,
      },
      async (tx) => {
        const updated = await tx.user.update({
          where: { id: MECHANIC_USER },
          data: { fullName: 'Seed Hunter Mechanic (Updated)' },
          select: { fullName: true },
        });
        expect(updated.fullName).toBe('Seed Hunter Mechanic (Updated)');

        await tx.user.update({
          where: { id: MECHANIC_USER },
          data: { fullName: 'Seed Hunter Mechanic' },
        });
      },
    );
  });

  it('6. runs withAuthBootstrapTransaction without 42P17 RLS recursion and enforces CFO org boundary', async () => {
    const cfoWorkspaces = await withAuthBootstrapTransaction(
      runtimePrisma,
      CFO_USER,
      async (tx) => {
        const memberships = await tx.organizationMembership.findMany({
          where: { isActive: true },
          select: { organizationId: true, role: true },
        });
        const orgs = await tx.organization.findMany({
          select: { id: true, slug: true },
        });
        // Tenant tables remain isolated with 0 rows inside bootstrap context
        const vehicles = await tx.vehicle.findMany();
        expect(vehicles).toHaveLength(0);
        return { memberships, orgs };
      },
    );

    expect(cfoWorkspaces.memberships).toHaveLength(2);
    expect(cfoWorkspaces.orgs).toHaveLength(2);

    const revokedMemberships = await withAuthBootstrapTransaction(
      runtimePrisma,
      REVOKED_USER,
      async (tx) =>
        tx.organizationMembership.findMany({ where: { isActive: true } }),
    );
    expect(revokedMemberships).toHaveLength(0);

    // CFO scoped to CANNABIS_ORG sees zero salvage vehicles
    await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: CANNABIS_ORG,
        userId: CFO_USER,
        role: UserRole.ARCHITECT_CFO,
      },
      async (tx) => {
        expect(await tx.vehicle.findMany()).toHaveLength(0);
      },
    );
  });

  it('7. reuses nested Prisma.TransactionClient for identical context and rejects mismatched org/user/role', async () => {
    await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: MECHANIC_USER,
        role: UserRole.HUNTER_MECHANIC,
      },
      async (tx) => {
        const nestedCount = await withTenantTransaction(
          tx,
          {
            organizationId: SALVAGE_ORG.toUpperCase(),
            userId: MECHANIC_USER.toUpperCase(),
            role: UserRole.HUNTER_MECHANIC,
          },
          async (innerTx) => innerTx.vehicle.count(),
        );
        expect(nestedCount).toBeGreaterThanOrEqual(2);

        await expect(
          withTenantTransaction(
            tx,
            {
              organizationId: CANNABIS_ORG,
              userId: MECHANIC_USER,
              role: UserRole.HUNTER_MECHANIC,
            },
            async () => 'switch-org-denied',
          ),
        ).rejects.toMatchObject({ code: 'NESTED_TENANT_CONTEXT_MISMATCH' });

        await expect(
          withTenantTransaction(
            tx,
            {
              organizationId: SALVAGE_ORG,
              userId: CFO_USER,
              role: UserRole.ARCHITECT_CFO,
            },
            async () => 'switch-user-denied',
          ),
        ).rejects.toMatchObject({ code: 'NESTED_TENANT_CONTEXT_MISMATCH' });
      },
    );
  });

  it('8. isolates pooled connections across sequential reuse, rollbacks, and concurrent requests', async () => {
    const pid1 = await withTenantTransaction(
      singleConnRuntimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: CFO_USER,
        role: UserRole.ARCHITECT_CFO,
      },
      async (tx) => {
        const r = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        return r[0]?.pid;
      },
    );

    // Cause deliberate rollback on single-connection pool
    await expect(
      withTenantTransaction(
        singleConnRuntimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: CFO_USER,
          role: UserRole.ARCHITECT_CFO,
        },
        async () => {
          throw new Error('forced rollback');
        },
      ),
    ).rejects.toThrow('forced rollback');

    const postRollbackCheck = await singleConnRuntimePrisma.$queryRaw<
      Array<{ pid: number; orgId: string | null }>
    >`
      SELECT
        pg_backend_pid()::int AS pid,
        "shared"."current_org_id"()::text AS "orgId"
    `;
    expect(postRollbackCheck[0]?.pid).toBe(pid1);
    expect(postRollbackCheck[0]?.orgId).toBeNull();

    // Concurrent salvage and cannabis transactions remain strictly isolated
    const [salvageVehicles, cannabisVehicles] = await Promise.all([
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: MECHANIC_USER,
          role: UserRole.HUNTER_MECHANIC,
        },
        async (tx) => tx.vehicle.count(),
      ),
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: CANNABIS_ORG,
          userId: NURSERY_TECH,
          role: UserRole.NURSERY_CULTIVATION_TECH,
        },
        async (tx) => tx.vehicle.count(),
      ),
    ]);
    expect(salvageVehicles).toBeGreaterThanOrEqual(2);
    expect(cannabisVehicles).toBe(0);
  });

  it('9. enforces append-only immutability, CustodyEvent/CashCustodyTransfer protections, and full 7x7 SaleTransaction settlement transition matrix', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8);

    // CustodyEvent, AuditLog, ScrapComponentLog immutability
    const custodyId = await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: CFO_USER,
        role: UserRole.ARCHITECT_CFO,
      },
      async (tx) => {
        const custody = await tx.custodyEvent.create({
          data: {
            id: randomUUID(),
            organizationId: SALVAGE_ORG,
            partId: PHASE1A_SEED_IDS.parts.alternator,
            actorUserId: CFO_USER,
            idempotencyKey: `TEST_IMMUT_${uniqueSuffix}`,
            toLocationBarcode: PHASE1A_SEED_IDS.locations.KEMP_C01,
            expectedVersion: 1,
            deviceTimestamp: new Date(),
          },
        });
        return custody.id;
      },
    );

    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: CFO_USER,
          role: UserRole.ARCHITECT_CFO,
        },
        async (tx) =>
          tx.custodyEvent.update({
            where: { id: custodyId },
            data: { toLocationBarcode: 'TAMPERED' },
          }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: CFO_USER,
          role: UserRole.ARCHITECT_CFO,
        },
        async (tx) => tx.custodyEvent.delete({ where: { id: custodyId } }),
      ),
    ).rejects.toThrow();

    const states = Object.values(PaymentSettlementState);
    const allowedTransitions = new Map<
      PaymentSettlementState,
      Set<PaymentSettlementState>
    >([
      [
        PaymentSettlementState.SALE_RECORDED,
        new Set([
          PaymentSettlementState.SALE_RECORDED,
          PaymentSettlementState.PAYMENT_INITIATED,
          PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
          PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED, // only when VERIFIED_BANK_WIRE
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        ]),
      ],
      [
        PaymentSettlementState.PAYMENT_INITIATED,
        new Set([
          PaymentSettlementState.PAYMENT_INITIATED,
          PaymentSettlementState.PAYMENT_CONFIRMED,
          PaymentSettlementState.BANK_SETTLEMENT_PENDING,
          PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED, // only when VERIFIED_BANK_WIRE
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        ]),
      ],
      [
        PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
        new Set([
          PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
          PaymentSettlementState.BANK_SETTLEMENT_PENDING,
          PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        ]),
      ],
      [
        PaymentSettlementState.PAYMENT_CONFIRMED,
        new Set([
          PaymentSettlementState.PAYMENT_CONFIRMED,
          PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED, // only when prior paymentMethod == VERIFIED_BANK_WIRE
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        ]),
      ],
      [
        PaymentSettlementState.BANK_SETTLEMENT_PENDING,
        new Set([
          PaymentSettlementState.BANK_SETTLEMENT_PENDING,
          PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        ]),
      ],
      [
        PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
        new Set([
          PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        ]),
      ],
      [
        PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
        new Set([PaymentSettlementState.REFUNDED_OR_CHARGED_BACK]),
      ],
    ]);

    const createSaleFixtureForState = async (
      initialState: PaymentSettlementState,
      paymentMethod: string,
      tag: string,
    ) => {
      const saleId = randomUUID();
      const baseData = {
        id: saleId,
        organizationId: SALVAGE_ORG,
        receiptNumber: `TST-${tag}-${randomUUID().slice(0, 8)}`,
        marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
        domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
        deliveryMethod: 'IN_PERSON_PICKUP',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        buyerName: 'Matrix Tester',
        soldByUserId: MECHANIC_USER,
        verifiedByAdminId: CFO_USER,
        paymentCurrency: CurrencyCode.CAD,
        subtotalMinor: 10_000,
        taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
        appliedTaxJurisdiction: 'CA-ON',
        appliedTaxRateBps: 1300,
        taxOrVatMinor: 1_300,
        grossCollectedMinor: 11_300,
        netRealizedCadMinor: 10_000,
        paymentMethod,
        paymentProofStorageKey: `evidence/${tag}.png`,
      };

      const stateFields =
        initialState === PaymentSettlementState.PAYMENT_CONFIRMED
          ? {
              paymentSettlementState: initialState,
              cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
              paymentConfirmedAt: new Date(),
            }
          : initialState === PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED
            ? {
                paymentSettlementState: initialState,
                cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
                paymentConfirmedAt: new Date(),
                bankSettledAt: new Date(),
                bankDepositReference: `DEP-${tag}`,
              }
            : {
                paymentSettlementState: initialState,
                cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
              };

      await withTenantTransaction(
        runtimePrisma,
        {
          organizationId: SALVAGE_ORG,
          userId: CFO_USER,
          role: UserRole.ARCHITECT_CFO,
        },
        async (tx) => {
          await tx.saleTransaction.create({
            data: { ...baseData, ...stateFields },
          });
        },
      );
      return saleId;
    };

    const buildPatchForTarget = (target: PaymentSettlementState) => {
      if (target === PaymentSettlementState.PAYMENT_CONFIRMED) {
        return {
          paymentSettlementState: target,
          cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
          paymentConfirmedAt: new Date(),
          bankSettledAt: null,
        };
      }
      if (target === PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED) {
        return {
          paymentSettlementState: target,
          cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
          paymentConfirmedAt: new Date(),
          bankSettledAt: new Date(),
          bankDepositReference: `DEP-${randomUUID().slice(0, 6)}`,
        };
      }
      if (target === PaymentSettlementState.REFUNDED_OR_CHARGED_BACK) {
        return {
          paymentSettlementState: target,
          isVoidedOrReversed: true,
          voidReason: 'Matrix refund test',
        };
      }
      return {
        paymentSettlementState: target,
        cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
        bankSettledAt: null,
      };
    };

    // Exhaustive 7x7 transition matrix checks
    for (const fromState of states) {
      if (fromState === PaymentSettlementState.REFUNDED_OR_CHARGED_BACK) {
        // Verify cannot INSERT directly into REFUNDED_OR_CHARGED_BACK
        await expect(
          withTenantTransaction(
            runtimePrisma,
            {
              organizationId: SALVAGE_ORG,
              userId: CFO_USER,
              role: UserRole.ARCHITECT_CFO,
            },
            async (tx) => {
              await tx.saleTransaction.create({
                data: {
                  id: randomUUID(),
                  organizationId: SALVAGE_ORG,
                  receiptNumber: `TST-BAD-START-${randomUUID().slice(0, 8)}`,
                  marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
                  domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
                  buyerName: 'Bad Start',
                  soldByUserId: MECHANIC_USER,
                  verifiedByAdminId: CFO_USER,
                  paymentCurrency: CurrencyCode.CAD,
                  subtotalMinor: 1000,
                  taxOrVatMinor: 130,
                  grossCollectedMinor: 1130,
                  netRealizedCadMinor: 1000,
                  paymentMethod: 'CASH',
                  paymentSettlementState:
                    PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
                  cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
                  isVoidedOrReversed: true,
                  voidReason: 'Invalid start',
                  paymentProofStorageKey: 'evidence/bad.png',
                },
              });
            },
          ),
        ).rejects.toThrow();

        // Create SALE_RECORDED -> REFUNDED_OR_CHARGED_BACK then test outgoing from terminal
        for (const toState of states) {
          if (toState === PaymentSettlementState.REFUNDED_OR_CHARGED_BACK) {
            continue;
          }
          const termId = await createSaleFixtureForState(
            PaymentSettlementState.SALE_RECORDED,
            'CASH',
            'term',
          );
          await expect(
            withTenantTransaction(
              runtimePrisma,
              {
                organizationId: SALVAGE_ORG,
                userId: CFO_USER,
                role: UserRole.ARCHITECT_CFO,
              },
              async (tx) => {
                await tx.saleTransaction.update({
                  where: { id: termId },
                  data: buildPatchForTarget(
                    PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
                  ),
                });
                await tx.saleTransaction.update({
                  where: { id: termId },
                  data: buildPatchForTarget(toState),
                });
              },
            ),
          ).rejects.toThrow();
        }
        continue;
      }

      for (const toState of states) {
        const paymentMethod =
          toState === PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED &&
          (fromState === PaymentSettlementState.SALE_RECORDED ||
            fromState === PaymentSettlementState.PAYMENT_INITIATED ||
            fromState === PaymentSettlementState.PAYMENT_CONFIRMED)
            ? 'VERIFIED_BANK_WIRE'
            : fromState === PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED
              ? 'VERIFIED_BANK_WIRE'
              : 'CASH';

        const saleId = await createSaleFixtureForState(
          fromState,
          paymentMethod,
          `m-${fromState.slice(0, 4)}-${toState.slice(0, 4)}`,
        );

        const isAllowed = allowedTransitions.get(fromState)?.has(toState) ?? false;
        const attempt = withTenantTransaction(
          runtimePrisma,
          {
            organizationId: SALVAGE_ORG,
            userId: CFO_USER,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) =>
            tx.saleTransaction.update({
              where: { id: saleId },
              data: buildPatchForTarget(toState),
              select: { paymentSettlementState: true },
            }),
        );

        if (isAllowed) {
          await expect(attempt).resolves.toMatchObject({
            paymentSettlementState: toState,
          });
        } else {
          await expect(attempt).rejects.toThrow();
        }
      }
    }

    // Refund trigger automatically releases SaleTransactionPartItem.isActiveSale lock
    const partSaleId = randomUUID();
    const ephemeralPartId = randomUUID();
    await withTenantTransaction(
      runtimePrisma,
      {
        organizationId: SALVAGE_ORG,
        userId: CFO_USER,
        role: UserRole.ARCHITECT_CFO,
      },
      async (tx) => {
        await tx.part.create({
          data: {
            id: ephemeralPartId,
            organizationId: SALVAGE_ORG,
            qrSkuCode: `PART-LOCK-${randomUUID().slice(0, 8)}`,
            donorVehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
            strippedByUserId: MECHANIC_USER,
            custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
            availabilityState: InventoryAvailabilityState.AVAILABLE,
            ebaySyncState: EbaySyncState.NOT_LISTED,
            classifiedsSyncState: ClassifiedsSyncState.NOT_POSTED,
            complianceState: PartComplianceState.CLEARED_FOR_SALE,
            partCategoryName: 'Starter',
            steeringSideCompatibility: SteeringSideCompatibility.UNIVERSAL,
            tdgHazmatCode: TdgHazmatCode.NONE,
            oemPartNumbers: [],
            interchangePartNumbers: [],
            suggestedHsCode: '8511.40',
            araGrade: AraConditionGradeEnum.GRADE_A,
            araDamageCode: '00',
            weightKg: 4,
            storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
            allocatedCostBasisCadMinor: 500,
            retailPriceCadMinor: 4000,
          },
        });
        await tx.saleTransaction.create({
          data: {
            id: partSaleId,
            organizationId: SALVAGE_ORG,
            receiptNumber: `LOCK-${randomUUID().slice(0, 8)}`,
            marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
            domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
            buyerName: 'Lock Test Buyer',
            soldByUserId: MECHANIC_USER,
            verifiedByAdminId: CFO_USER,
            paymentCurrency: CurrencyCode.CAD,
            subtotalMinor: 4000,
            taxOrVatMinor: 520,
            grossCollectedMinor: 4520,
            netRealizedCadMinor: 4000,
            paymentMethod: 'CASH',
            paymentSettlementState: PaymentSettlementState.SALE_RECORDED,
            cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
            paymentProofStorageKey: 'evidence/lock.png',
          },
        });
        const item = await tx.saleTransactionPartItem.create({
          data: {
            id: randomUUID(),
            organizationId: SALVAGE_ORG,
            saleTransactionId: partSaleId,
            partId: ephemeralPartId,
            soldPriceMinor: 4000,
            isActiveSale: true,
          },
        });
        expect(item.isActiveSale).toBe(true);

        await tx.saleTransaction.update({
          where: { id: partSaleId },
          data: {
            paymentSettlementState:
              PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
            isVoidedOrReversed: true,
            voidReason: 'Released for resale',
          },
        });

        const released = await tx.saleTransactionPartItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        expect(released.isActiveSale).toBe(false);
      },
    );
  });

  it('10. enforces RULE-TAX-HST-01 marketplace facilitator, zero-rated export, and ETA s.169(4) ITC gates', async () => {
    const cfoSalvageCtx = {
      organizationId: SALVAGE_ORG,
      userId: CFO_USER,
      role: UserRole.ARCHITECT_CFO,
    };

    // eBay order with non-zero seller-collected taxOrVatMinor rejected
    await expect(
      withTenantTransaction(runtimePrisma, cfoSalvageCtx, async (tx) =>
        tx.saleTransaction.create({
          data: {
            id: randomUUID(),
            organizationId: SALVAGE_ORG,
            receiptNumber: `TAX-EBAY-${randomUUID().slice(0, 8)}`,
            marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
            domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
            deliveryMethod: 'SELLER_SHIPPED',
            buyerName: 'eBay Buyer',
            soldByUserId: MECHANIC_USER,
            verifiedByAdminId: CFO_USER,
            paymentCurrency: CurrencyCode.CAD,
            subtotalMinor: 10_000,
            taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
            taxOrVatMinor: 1_300,
            grossCollectedMinor: 11_300,
            netRealizedCadMinor: 10_000,
            paymentMethod: 'EBAY_MANAGED_PAYOUT',
            paymentSettlementState:
              PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
            cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
            paymentProofStorageKey: 'evidence/ebay-bad.png',
          },
        }),
      ),
    ).rejects.toThrow();

    // ZERO_RATED_EXPORT inside CA rejected
    await expect(
      withTenantTransaction(runtimePrisma, cfoSalvageCtx, async (tx) =>
        tx.saleTransaction.create({
          data: {
            id: randomUUID(),
            organizationId: SALVAGE_ORG,
            receiptNumber: `TAX-EXP-${randomUUID().slice(0, 8)}`,
            marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
            domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
            deliveryMethod: 'SELLER_SHIPPED',
            destinationCountryCode: 'CA',
            exportProofStorageKey: 'proof.pdf',
            buyerName: 'Domestic Buyer',
            soldByUserId: MECHANIC_USER,
            verifiedByAdminId: CFO_USER,
            paymentCurrency: CurrencyCode.CAD,
            subtotalMinor: 10_000,
            taxCollectionMode: TaxCollectionMode.ZERO_RATED_EXPORT,
            taxOrVatMinor: 0,
            grossCollectedMinor: 10_000,
            netRealizedCadMinor: 10_000,
            paymentMethod: 'VERIFIED_BANK_WIRE',
            paymentSettlementState:
              PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
            cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
            paymentConfirmedAt: new Date(),
            bankSettledAt: new Date(),
            bankDepositReference: 'WIRE-01',
            paymentProofStorageKey: 'evidence/exp-bad.png',
          },
        }),
      ),
    ).rejects.toThrow();

    // Valid eBay order succeeds, then unverified ITC claim is rejected
    const validEbayId = randomUUID();
    await withTenantTransaction(runtimePrisma, cfoSalvageCtx, async (tx) => {
      await tx.saleTransaction.create({
        data: {
          id: validEbayId,
          organizationId: SALVAGE_ORG,
          receiptNumber: `TAX-EBAY-OK-${randomUUID().slice(0, 8)}`,
          marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
          domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
          deliveryMethod: 'SELLER_SHIPPED',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'NS',
          buyerName: 'Nova Scotia eBay Buyer',
          soldByUserId: MECHANIC_USER,
          verifiedByAdminId: CFO_USER,
          paymentCurrency: CurrencyCode.CAD,
          subtotalMinor: 10_000,
          taxCollectionMode:
            TaxCollectionMode.MARKETPLACE_FACILITATOR_COLLECTED,
          appliedTaxJurisdiction: 'CA-NS',
          appliedTaxRateBps: 1400,
          taxOrVatMinor: 0,
          buyerTaxRemittedByPlatformMinor: 1_400,
          estimatedPlatformFeeTaxCadMinor: 195,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          grossCollectedMinor: 10_000,
          netRealizedCadMinor: 8_500,
          paymentMethod: 'EBAY_MANAGED_PAYOUT',
          paymentSettlementState:
            PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
          cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
          paymentProofStorageKey: 'evidence/ebay-ok.png',
        },
      });
    });

    await expect(
      withTenantTransaction(runtimePrisma, cfoSalvageCtx, async (tx) =>
        tx.saleTransaction.update({
          where: { id: validEbayId },
          data: { itcReceivableCadMinor: 195 },
        }),
      ),
    ).rejects.toThrow();
  });

  it('11. verifies dormant cannabis.ProductionRun SQL DDL triggers (unrounded 2.0% threshold & QAP membership) and DestructionLog CHECKs', async () => {
    const tag = randomUUID().slice(0, 8);
    const strainId = randomUUID();
    const runId = randomUUID();
    const runBoundaryId = randomUUID();
    const inputLotId = randomUUID();
    const outputLotId = randomUUID();
    const boundaryInputLotId = randomUUID();
    const boundaryOutputLotId = randomUUID();
    const brockLoc = PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2;

    await ownerPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        INSERT INTO "cannabis"."CannabisStrain" ("id", "organizationId", "name", "createdAt", "updatedAt")
        VALUES (${strainId}::uuid, ${CANNABIS_ORG}::uuid, ${`Strain-${tag}`}, NOW(), NOW())
      `;

      await tx.$queryRaw`
        INSERT INTO "cannabis"."CannabisLot" ("id", "organizationId", "lotBarcode", "strainId", "lotStage", "netMassTenthGrams", "storageLocationId", "complianceHold", "createdAt", "updatedAt")
        VALUES
          (${inputLotId}::uuid, ${CANNABIS_ORG}::uuid, ${`LOT-IN-${tag}`}, ${strainId}::uuid, 'FRESH_HARVEST', 100000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${outputLotId}::uuid, ${CANNABIS_ORG}::uuid, ${`LOT-OUT-${tag}`}, ${strainId}::uuid, 'BUBBLE_HASH_INTERMEDIATE', 97996, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${boundaryInputLotId}::uuid, ${CANNABIS_ORG}::uuid, ${`LOT-BIN-${tag}`}, ${strainId}::uuid, 'FRESH_HARVEST', 2000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${boundaryOutputLotId}::uuid, ${CANNABIS_ORG}::uuid, ${`LOT-BOUT-${tag}`}, ${strainId}::uuid, 'BUBBLE_HASH_INTERMEDIATE', 1960, ${brockLoc}::uuid, false, NOW(), NOW())
      `;

      // 2004 / 100000 = 2.004%: rounds to 2.004 (or 2.00 in 2-decimal precision), trigger MUST still enforce exact > 2.0% check
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRun" (
          "id", "organizationId", "runNumber", "runType", "status",
          "totalInputMassTenthGrams", "totalOutputMassTenthGrams", "processLossMassTenthGrams", "destroyedByproductMassTenthGrams", "unaccountedVarianceTenthGrams",
          "executedByUserId", "startedAt"
        )
        VALUES (
          ${runId}::uuid, ${CANNABIS_ORG}::uuid, ${`RUN-PREC-${tag}`}, 'SOLVENTLESS_ICE_WATER_HASH', 'IN_PROGRESS',
          100000, 97996, 0, 0, 2004,
          ${NURSERY_TECH}::uuid, NOW()
        )
      `;

      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRunInput" ("id", "organizationId", "productionRunId", "sourceLotId", "consumedMassTenthGrams")
        VALUES (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runId}::uuid, ${inputLotId}::uuid, 100000)
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRunOutput" ("id", "organizationId", "productionRunId", "outputLotId", "yieldedMassTenthGrams")
        VALUES (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runId}::uuid, ${outputLotId}::uuid, 97996)
      `;
    });

    // Attempting FINALIZED without QAP sign-off fails due to strict > 2.0% check (2004 * 100 = 200400 > 100000 * 2)
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          UPDATE "cannabis"."ProductionRun"
             SET "status" = 'FINALIZED', "requiresQapVarianceReview" = true, "completedAt" = NOW()
           WHERE "id" = ${runId}::uuid
        `;
      }),
    ).rejects.toThrow();

    // Salvage mechanic (non-QAP, non-org) cannot sign off on >2.0% variance hold
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          UPDATE "cannabis"."ProductionRun"
             SET "status" = 'FINALIZED',
                 "requiresQapVarianceReview" = true,
                 "verifiedByQapUserId" = ${MECHANIC_USER}::uuid,
                 "qapVarianceReasonNote" = 'Invalid salvage user sign-off test',
                 "completedAt" = NOW()
           WHERE "id" = ${runId}::uuid
        `;
      }),
    ).rejects.toThrow();

    // Exact 2.000% (40 / 2000) succeeds without QAP override; Active CANNABIS_QAP_COMPLIANCE succeeds for runId
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRun" (
          "id", "organizationId", "runNumber", "runType", "status",
          "totalInputMassTenthGrams", "totalOutputMassTenthGrams", "processLossMassTenthGrams", "destroyedByproductMassTenthGrams", "unaccountedVarianceTenthGrams",
          "executedByUserId", "startedAt"
        )
        VALUES (
          ${runBoundaryId}::uuid, ${CANNABIS_ORG}::uuid, ${`RUN-BND-${tag}`}, 'SOLVENTLESS_ICE_WATER_HASH', 'IN_PROGRESS',
          2000, 1960, 0, 0, 40,
          ${NURSERY_TECH}::uuid, NOW()
        )
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRunInput" ("id", "organizationId", "productionRunId", "sourceLotId", "consumedMassTenthGrams")
        VALUES (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runBoundaryId}::uuid, ${boundaryInputLotId}::uuid, 2000)
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRunOutput" ("id", "organizationId", "productionRunId", "outputLotId", "yieldedMassTenthGrams")
        VALUES (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runBoundaryId}::uuid, ${boundaryOutputLotId}::uuid, 1960)
      `;

      await tx.$queryRaw`
        UPDATE "cannabis"."ProductionRun"
           SET "status" = 'FINALIZED', "requiresQapVarianceReview" = false, "completedAt" = NOW()
         WHERE "id" = ${runBoundaryId}::uuid
      `;

      await tx.$queryRaw`
        UPDATE "cannabis"."ProductionRun"
           SET "status" = 'FINALIZED',
               "requiresQapVarianceReview" = true,
               "verifiedByQapUserId" = ${CANNABIS_QAP}::uuid,
               "qapVarianceReasonNote" = 'Verified moisture evaporation variance during press',
               "completedAt" = NOW()
         WHERE "id" = ${runId}::uuid
      `;
    });

    // DestructionLog OTHER_CANNABIS stream requires witnessUserId + evidencePhotoStorageKey
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          INSERT INTO "cannabis"."CannabisDestructionLog" (
            "id", "organizationId", "lotId", "destructionStream", "destroyedNetMassTenthGrams",
            "destructionReason", "destructionMethod", "evidencePhotoStorageKey", "primaryUserId", "witnessUserId", "destroyedAt"
          )
          VALUES (
            ${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${inputLotId}::uuid, 'OTHER_CANNABIS', 100,
            'Spent extraction puck', 'GRIND_AND_CAT_LITTER', 'evidence/dest.jpg', ${NURSERY_TECH}::uuid, NULL, NOW()
          )
        `;
      }),
    ).rejects.toThrow();

    // CanonicalInventoryEvent is strictly append-only (DELETE rejected)
    const eventId = randomUUID();
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        INSERT INTO "cannabis"."CanonicalInventoryEvent" (
          "id", "organizationId", "cannabisLotId", "eventType", "ctlsReportingCategory",
          "netMassTenthGrams", "recordedByUserId", "idempotencyKey", "occurredAt"
        )
        VALUES (
          ${eventId}::uuid, ${CANNABIS_ORG}::uuid, ${inputLotId}::uuid, 'PROCESS_LOSS', 'FRESH_CANNABIS',
          0, ${CANNABIS_QAP}::uuid, ${`IDEM-${tag}`}, NOW()
        )
      `;
    });

    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          DELETE FROM "cannabis"."CanonicalInventoryEvent" WHERE "id" = ${eventId}::uuid
        `;
      }),
    ).rejects.toThrow();
  });

  it('12. proves two-connection FOR UPDATE child/finalizer lock serialization in both lock acquisition orderings', async () => {
    const tag = randomUUID().slice(0, 8);
    const strainId = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    const lotA1 = randomUUID();
    const lotA2 = randomUUID();
    const lotAOut = randomUUID();
    const lotB1 = randomUUID();
    const lotB2 = randomUUID();
    const lotBOut = randomUUID();
    const brockLoc = PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2;

    await ownerPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        INSERT INTO "cannabis"."CannabisStrain" ("id", "organizationId", "name", "createdAt", "updatedAt")
        VALUES (${strainId}::uuid, ${CANNABIS_ORG}::uuid, ${`LockStrain-${tag}`}, NOW(), NOW())
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."CannabisLot" ("id", "organizationId", "lotBarcode", "strainId", "lotStage", "netMassTenthGrams", "storageLocationId", "complianceHold", "createdAt", "updatedAt")
        VALUES
          (${lotA1}::uuid, ${CANNABIS_ORG}::uuid, ${`LA1-${tag}`}, ${strainId}::uuid, 'FRESH_HARVEST', 1000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${lotA2}::uuid, ${CANNABIS_ORG}::uuid, ${`LA2-${tag}`}, ${strainId}::uuid, 'FRESH_HARVEST', 1000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${lotAOut}::uuid, ${CANNABIS_ORG}::uuid, ${`LAO-${tag}`}, ${strainId}::uuid, 'DRIED_FLOWER', 1000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${lotB1}::uuid, ${CANNABIS_ORG}::uuid, ${`LB1-${tag}`}, ${strainId}::uuid, 'FRESH_HARVEST', 1000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${lotB2}::uuid, ${CANNABIS_ORG}::uuid, ${`LB2-${tag}`}, ${strainId}::uuid, 'FRESH_HARVEST', 1000, ${brockLoc}::uuid, false, NOW(), NOW()),
          (${lotBOut}::uuid, ${CANNABIS_ORG}::uuid, ${`LBO-${tag}`}, ${strainId}::uuid, 'DRIED_FLOWER', 1000, ${brockLoc}::uuid, false, NOW(), NOW())
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRun" (
          "id", "organizationId", "runNumber", "runType", "status",
          "totalInputMassTenthGrams", "totalOutputMassTenthGrams", "processLossMassTenthGrams", "destroyedByproductMassTenthGrams", "unaccountedVarianceTenthGrams",
          "executedByUserId", "startedAt"
        )
        VALUES
          (${runA}::uuid, ${CANNABIS_ORG}::uuid, ${`RUN-A-${tag}`}, 'DRYING_CURING', 'IN_PROGRESS', 1000, 1000, 0, 0, 0, ${NURSERY_TECH}::uuid, NOW()),
          (${runB}::uuid, ${CANNABIS_ORG}::uuid, ${`RUN-B-${tag}`}, 'DRYING_CURING', 'IN_PROGRESS', 1000, 1000, 0, 0, 0, ${NURSERY_TECH}::uuid, NOW())
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRunInput" ("id", "organizationId", "productionRunId", "sourceLotId", "consumedMassTenthGrams")
        VALUES
          (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runA}::uuid, ${lotA1}::uuid, 1000),
          (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runB}::uuid, ${lotB1}::uuid, 1000)
      `;
      await tx.$queryRaw`
        INSERT INTO "cannabis"."ProductionRunOutput" ("id", "organizationId", "productionRunId", "outputLotId", "yieldedMassTenthGrams")
        VALUES
          (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runA}::uuid, ${lotAOut}::uuid, 1000),
          (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runB}::uuid, ${lotBOut}::uuid, 1000)
      `;
    });

    // Ordering A: Finalizer holds parent lock first -> child insert waits -> finalizer commits -> child fails with parent FINALIZED
    let releaseConn1!: () => void;
    let resolveConn1Locked!: (pid: number) => void;
    const conn1Locked = new Promise<number>((resolve) => {
      resolveConn1Locked = resolve;
    });
    const conn1TxPromise = ownerSecondConn.$transaction(async (tx2) => {
      const pidRows = await tx2.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      await tx2.$queryRaw`
        SELECT "id" FROM "cannabis"."ProductionRun" WHERE "id" = ${runA}::uuid FOR UPDATE
      `;
      resolveConn1Locked(pidRows[0]!.pid);
      await new Promise<void>((r) => {
        releaseConn1 = r;
      });
      await tx2.$queryRaw`
        UPDATE "cannabis"."ProductionRun"
           SET "status" = 'FINALIZED', "completedAt" = NOW()
         WHERE "id" = ${runA}::uuid
      `;
    });

    const lockOwnerPidA = await conn1Locked;
    const conn2BlockedPromise = withTenantTransaction(
      singleConnRuntimePrisma,
      {
        organizationId: CANNABIS_ORG,
        userId: NURSERY_TECH,
        role: UserRole.NURSERY_CULTIVATION_TECH,
      },
      async (tx) => {
        await tx.$queryRaw`
          INSERT INTO "cannabis"."ProductionRunInput" ("id", "organizationId", "productionRunId", "sourceLotId", "consumedMassTenthGrams")
          VALUES (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runA}::uuid, ${lotA2}::uuid, 500)
        `;
      },
    );

    // Poll via pg_stat_activity for any backend blocked by lockOwnerPidA
    let sawWaitA = false;
    const deadlineA = Date.now() + 5_000;
    while (Date.now() < deadlineA) {
      const blocked = await ownerPrisma.$queryRaw<Array<{ pid: number }>>`
        SELECT sa.pid::int AS pid
        FROM pg_stat_activity sa
        WHERE sa.wait_event_type = 'Lock'
          AND ${lockOwnerPidA}::int = ANY(pg_blocking_pids(sa.pid))
      `;
      if (blocked.length > 0) {
        sawWaitA = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(sawWaitA).toBe(true);
    releaseConn1();
    await conn1TxPromise;
    await expect(conn2BlockedPromise).rejects.toThrow();

    // Ordering B: Child insert acquires parent FOR UPDATE lock via guard trigger first -> finalizer blocks until child commits -> finalizer rejects mismatch
    let releaseChildTx!: () => void;
    let resolveChildLocked!: (pid: number) => void;
    const childLockedPromise = new Promise<number>((res) => {
      resolveChildLocked = res;
    });

    const childTxPromise = withTenantTransaction(
      singleConnRuntimePrisma,
      {
        organizationId: CANNABIS_ORG,
        userId: NURSERY_TECH,
        role: UserRole.NURSERY_CULTIVATION_TECH,
      },
      async (tx) => {
        const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        await tx.$queryRaw`
          INSERT INTO "cannabis"."ProductionRunInput" ("id", "organizationId", "productionRunId", "sourceLotId", "consumedMassTenthGrams")
          VALUES (${randomUUID()}::uuid, ${CANNABIS_ORG}::uuid, ${runB}::uuid, ${lotB2}::uuid, 500)
        `;
        resolveChildLocked(pidRows[0]!.pid);
        await new Promise<void>((r) => {
          releaseChildTx = r;
        });
      },
    );

    const childOwnerPid = await childLockedPromise;

    const finalizerPidHolder: { pid?: number } = {};
    const finalizerBlockedPromise = ownerSecondConn.$transaction(async (tx2) => {
      const pidRows = await tx2.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      finalizerPidHolder.pid = pidRows[0]!.pid;
      await tx2.$queryRaw`
        UPDATE "cannabis"."ProductionRun"
           SET "status" = 'FINALIZED', "completedAt" = NOW()
         WHERE "id" = ${runB}::uuid
      `;
    });

    const pidWaitDeadline = Date.now() + 2_000;
    while (finalizerPidHolder.pid === undefined && Date.now() < pidWaitDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(finalizerPidHolder.pid).toBeDefined();

    const sawWaitB = await pollUntilWaitingOnLock(
      finalizerPidHolder.pid!,
      childOwnerPid,
    );
    expect(sawWaitB).toBe(true);

    releaseChildTx();
    await childTxPromise;
    // Now total inputs = 1500 while declared totalInputMassTenthGrams = 1000 -> trigger rejects FINALIZED!
    await expect(finalizerBlockedPromise).rejects.toThrow();
  });
});
