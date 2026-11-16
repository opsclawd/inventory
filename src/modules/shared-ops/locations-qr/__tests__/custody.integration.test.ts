import { randomUUID } from 'node:crypto';
import {
  AssetCategory,
  AssetLifecycleState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  PrismaClient,
  RoadVehicleBrand,
  SteeringSideCompatibility,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthSessionContext } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import {
  createPrismaCustodyRepository,
  LocationCustodyError,
  recordCustodyScan,
} from '@/modules/shared-ops/locations-qr';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL custody integration tests.`,
    );
  }
  return value;
}

function makeSession(input: {
  userId: string;
  organizationId: string;
  role: UserRole;
  aal?: 'aal1' | 'aal2';
  mfaEnrolled?: boolean;
}): AuthSessionContext {
  return createAuthSessionContext({
    userId: input.userId,
    activeOrganizationId: input.organizationId,
    role: input.role,
    activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
    activeMemberships: [
      {
        membershipId: randomUUID(),
        organizationId: input.organizationId,
        organizationSlug: 'ORG_SALVAGE_TEST',
        organizationName: 'Test Salvage Org',
        organizationType: OrganizationType.SALVAGE_AND_EXPORT,
        role: input.role,
        isDefaultWorkspace: true,
      },
    ],
    aal: input.aal ?? 'aal2',
    mfaEnrolled: input.mfaEnrolled ?? true,
  });
}

describe.runIf(HAS_TEST_DATABASE_URL)(
  'Issue #6: Live PostgreSQL erp_app_user Custody Transactions, Concurrency, Capacity & Tenant Idempotency',
  () => {
    let runtimePrisma!: PrismaClient;
    let ownerPrisma!: PrismaClient;

    const tag = randomUUID().slice(0, 8).toUpperCase();
    const salvageOrgId = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
    const cfoUserId = PHASE1A_SEED_IDS.users.architectCfo;

    const createdMembershipIds: string[] = [];
    const createdUserIds: string[] = [];
    const createdPartIds: string[] = [];
    const createdVehicleIds: string[] = [];
    const createdLocationIds: string[] = [];
    const createdOrgIds: string[] = [];

    beforeAll(async () => {
      runtimePrisma = new PrismaClient({
        datasources: { db: { url: requireEnvUrl('TEST_DATABASE_URL') } },
      });
      ownerPrisma = new PrismaClient({
        datasources: { db: { url: requireEnvUrl('DIRECT_URL') } },
      });
      await Promise.all([runtimePrisma.$connect(), ownerPrisma.$connect()]);
    });

    afterAll(async () => {
      if (ownerPrisma) {
        if (createdMembershipIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."OrganizationMembership"
            WHERE "id" = ANY(${createdMembershipIds}::uuid[])
          `;
        }
        if (createdPartIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "salvage"."Part" p
            WHERE p."id" = ANY(${createdPartIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CustodyEvent" ce WHERE ce."partId" = p."id"
              )
          `;
        }
        if (createdVehicleIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "salvage"."Vehicle" v
            WHERE v."id" = ANY(${createdVehicleIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CustodyEvent" ce WHERE ce."vehicleId" = v."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Part" p WHERE p."donorVehicleId" = v."id"
              )
          `;
        }
        if (createdLocationIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."StorageLocation" l
            WHERE l."id" = ANY(${createdLocationIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "salvage"."Vehicle" v WHERE v."storageLocationId" = l."id")
              AND NOT EXISTS (SELECT 1 FROM "salvage"."Part" p WHERE p."storageLocationId" = l."id")
          `;
        }
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User" u
            WHERE u."id" = ANY(${createdUserIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "shared"."CustodyEvent" ce WHERE ce."actorUserId" = u."id")
              AND NOT EXISTS (SELECT 1 FROM "shared"."AuditLog" al WHERE al."actorUserId" = u."id")
          `;
        }
        if (createdOrgIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."Organization" o
            WHERE o."id" = ANY(${createdOrgIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "shared"."CustodyEvent" ce WHERE ce."organizationId" = o."id")
          `;
        }
      }

      await Promise.allSettled([
        runtimePrisma?.$disconnect(),
        ownerPrisma?.$disconnect(),
      ]);
    });

    it('enforces concurrent capacity serialization, idempotency, cross-tenant key isolation, zoning, and immediate revocation as erp_app_user', async () => {
      const repo = createPrismaCustodyRepository({ prisma: runtimePrisma });

      const capPadId = randomUUID();
      const capPadBarcode = `TESTPAD-${tag}-C01`;
      const binId = randomUUID();
      const binBarcode = `TESTBIN-${tag}-B01`;
      createdLocationIds.push(capPadId, binId);

      await ownerPrisma.storageLocation.createMany({
        data: [
          {
            id: capPadId,
            organizationId: salvageOrgId,
            allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
            locationOperationalStatus: LocationOperationalStatus.ACTIVE,
            allowsWholeVehicleDismantling: false,
            maxActiveAssetCapacity: 1,
            siteCode: 'KEMP',
            zoneCode: 'ZONE_TEST_CAP',
            containerCode: 'TST',
            rackCode: 'R01',
            shelfCode: 'S01',
            binCode: 'B01',
            fullQrBarcode: capPadBarcode,
          },
          {
            id: binId,
            organizationId: salvageOrgId,
            allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
            locationOperationalStatus: LocationOperationalStatus.ACTIVE,
            allowsWholeVehicleDismantling: false,
            maxActiveAssetCapacity: null,
            siteCode: 'KEMP',
            zoneCode: 'ZONE_TEST_BIN',
            containerCode: 'TST',
            rackCode: 'R02',
            shelfCode: 'S01',
            binCode: 'B01',
            fullQrBarcode: binBarcode,
          },
        ],
      });

      const veh1Id = randomUUID();
      const veh2Id = randomUUID();
      createdVehicleIds.push(veh1Id, veh2Id);

      await ownerPrisma.vehicle.createMany({
        data: [
          {
            id: veh1Id,
            organizationId: salvageOrgId,
            internalStockNumber: `AST-2026-T1${tag.slice(0, 4)}`,
            assetCategory: AssetCategory.AUTOMOBILE,
            vinOrHin: `1HGCM82633A${tag.slice(0, 6)}`,
            year: 2020,
            make: 'Honda',
            model: 'Civic',
            roadBrand: RoadVehicleBrand.SALVAGE,
            operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
            lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
            estimatedMaxBidCadMinor: 100_000,
            fluidsDrainedAt: null,
          },
          {
            id: veh2Id,
            organizationId: salvageOrgId,
            internalStockNumber: `AST-2026-T2${tag.slice(0, 4)}`,
            assetCategory: AssetCategory.AUTOMOBILE,
            vinOrHin: `2HGCM82633A${tag.slice(0, 6)}`,
            year: 2021,
            make: 'Toyota',
            model: 'Corolla',
            roadBrand: RoadVehicleBrand.SALVAGE,
            operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
            lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
            estimatedMaxBidCadMinor: 100_000,
            fluidsDrainedAt: null,
          },
        ],
      });

      const enginePartId = randomUUID();
      createdPartIds.push(enginePartId);
      await ownerPrisma.part.create({
        data: {
          id: enginePartId,
          organizationId: salvageOrgId,
          qrSkuCode: `PRT-T${tag}`,
          donorVehicleId: veh1Id,
          strippedByUserId: cfoUserId,
          custodyState: PartCustodyState.STRIPPED_RAW_OFFLINE,
          complianceState: PartComplianceState.PENDING_ENRICHMENT,
          partCategoryName: 'Complete Engine Assembly',
          steeringSideCompatibility: SteeringSideCompatibility.UNIVERSAL,
          tdgHazmatCode: TdgHazmatCode.NONE,
          oemPartNumbers: [],
          interchangePartNumbers: [],
          rawPhotoUrls: [],
          cleanPhotoUrls: [],
        },
      });

      // Ephemeral user + membership so we can test immediate revocation cleanly
      const tempUserId = randomUUID();
      const tempMembershipId = randomUUID();
      createdUserIds.push(tempUserId);
      createdMembershipIds.push(tempMembershipId);

      await ownerPrisma.user.create({
        data: {
          id: tempUserId,
          email: `custody-it-${tag}@test.local`,
          fullName: `Custody IT ${tag}`,
          role: UserRole.HUNTER_MECHANIC,
          mfaEnrolled: false,
          isActive: true,
        },
      });
      await ownerPrisma.organizationMembership.create({
        data: {
          id: tempMembershipId,
          organizationId: salvageOrgId,
          userId: tempUserId,
          role: UserRole.HUNTER_MECHANIC,
          isDefaultWorkspace: true,
          isActive: true,
        },
      });

      const mechSession = makeSession({
        userId: tempUserId,
        organizationId: salvageOrgId,
        role: UserRole.HUNTER_MECHANIC,
        aal: 'aal1',
        mfaEnrolled: false,
      });
      const cfoSession = makeSession({
        userId: cfoUserId,
        organizationId: salvageOrgId,
        role: UserRole.ARCHITECT_CFO,
        aal: 'aal2',
        mfaEnrolled: true,
      });

      // 1. Cross-tenant BROCK-PROP-R1-T2 fails with 422 SITE_ZONING_VIOLATION under FORCE RLS
      await expect(
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'PART', id: enginePartId },
            destinationBarcode: 'BROCK-PROP-R1-T2',
            expectedVersion: 1,
            idempotencyKey: randomUUID(),
            deviceTimestamp: new Date(),
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({ code: 'SITE_ZONING_VIOLATION', status: 422 });

      // 2. Concurrent identical-key submissions produce exactly one event/update
      const sharedIdemKey = randomUUID();
      const [r1, r2] = await Promise.all([
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'PART', id: enginePartId },
            destinationBarcode: binBarcode,
            expectedVersion: 1,
            idempotencyKey: sharedIdemKey,
            deviceTimestamp: '2026-11-15T12:00:00.000Z',
          },
          { repository: repo },
        ),
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'PART', id: enginePartId },
            destinationBarcode: binBarcode,
            expectedVersion: 1,
            idempotencyKey: sharedIdemKey,
            deviceTimestamp: '2026-11-15T12:00:00.000Z',
          },
          { repository: repo },
        ),
      ]);
      expect(r1).toEqual(r2);
      expect(r1.version).toBe(2);
      expect(r1.complianceWarnings).toEqual([
        'COMPLIANCE_WARNING_UNDRAINED_FARM',
      ]);

      // Different payload with same idempotencyKey -> 409 IDEMPOTENCY_KEY_REUSED
      await expect(
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'PART', id: enginePartId },
            destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
            expectedVersion: 1,
            idempotencyKey: sharedIdemKey,
            deviceTimestamp: '2026-11-15T12:00:00.000Z',
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

      // 3. Two vehicles racing for the 1 slot on capPad: exactly one succeeds
      const raceResults = await Promise.allSettled([
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'VEHICLE', id: veh1Id },
            destinationBarcode: capPadBarcode,
            expectedVersion: 1,
            idempotencyKey: randomUUID(),
            deviceTimestamp: new Date(),
          },
          { repository: repo },
        ),
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'VEHICLE', id: veh2Id },
            destinationBarcode: capPadBarcode,
            expectedVersion: 1,
            idempotencyKey: randomUUID(),
            deviceTimestamp: new Date(),
          },
          { repository: repo },
        ),
      ]);

      const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
      const rejected = raceResults.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
      ).toBeInstanceOf(LocationCustodyError);
      expect(
        ((rejected[0] as PromiseRejectedResult).reason as LocationCustodyError)
          .code,
      ).toBe('LOCATION_CAPACITY_EXCEEDED');

      // Winner vehicle can still rescan same location at capacity; loser requires CFO override
      const loserVehId =
        fulfilled[0]!.value.entity.id === veh1Id ? veh2Id : veh1Id;
      const cfoOverrideRes = await recordCustodyScan(
        cfoSession,
        {
          entity: { kind: 'VEHICLE', id: loserVehId },
          destinationBarcode: capPadBarcode,
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
          deviceTimestamp: new Date(),
          cfoOverride: true,
        },
        { repository: repo },
      );
      expect(cfoOverrideRes.overrideApplied).toBe(true);

      // 4. Same idempotencyKey works in an independent second tenant (tenant-scoped unique index)
      const secondOrgId = randomUUID();
      const secondLocId = randomUUID();
      const secondVehId = randomUUID();
      const secondUserId = randomUUID();
      const secondMembershipId = randomUUID();
      createdOrgIds.push(secondOrgId);
      createdLocationIds.push(secondLocId);
      createdVehicleIds.push(secondVehId);
      createdUserIds.push(secondUserId);
      createdMembershipIds.push(secondMembershipId);

      await ownerPrisma.organization.create({
        data: {
          id: secondOrgId,
          slug: `ORG_SECOND_${tag}`,
          name: `Second Salvage Org ${tag}`,
          organizationType: OrganizationType.SALVAGE_AND_EXPORT,
          isActive: true,
        },
      });
      await ownerPrisma.user.create({
        data: {
          id: secondUserId,
          email: `second-it-${tag}@test.local`,
          fullName: `Second IT ${tag}`,
          role: UserRole.HUNTER_MECHANIC,
          isActive: true,
        },
      });
      await ownerPrisma.organizationMembership.create({
        data: {
          id: secondMembershipId,
          organizationId: secondOrgId,
          userId: secondUserId,
          role: UserRole.HUNTER_MECHANIC,
          isDefaultWorkspace: true,
          isActive: true,
        },
      });
      await ownerPrisma.storageLocation.create({
        data: {
          id: secondLocId,
          organizationId: secondOrgId,
          allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
          locationOperationalStatus: LocationOperationalStatus.ACTIVE,
          allowsWholeVehicleDismantling: true,
          maxActiveAssetCapacity: null,
          siteCode: 'SEC',
          zoneCode: 'ZONE_SEC',
          containerCode: 'C01',
          rackCode: 'R01',
          shelfCode: 'S01',
          binCode: 'B01',
          fullQrBarcode: `SEC-${tag}-B01`,
        },
      });
      await ownerPrisma.vehicle.create({
        data: {
          id: secondVehId,
          organizationId: secondOrgId,
          internalStockNumber: `AST-2026-S${tag.slice(0, 5)}`,
          assetCategory: AssetCategory.AUTOMOBILE,
          vinOrHin: `3HGCM82633A${tag.slice(0, 6)}`,
          year: 2022,
          make: 'Mazda',
          model: '3',
          roadBrand: RoadVehicleBrand.SALVAGE,
          operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
          lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
          estimatedMaxBidCadMinor: 100_000,
        },
      });

      const secondSession = makeSession({
        userId: secondUserId,
        organizationId: secondOrgId,
        role: UserRole.HUNTER_MECHANIC,
        aal: 'aal1',
        mfaEnrolled: false,
      });

      const crossTenantSameKey = await recordCustodyScan(
        secondSession,
        {
          entity: { kind: 'VEHICLE', id: secondVehId },
          destinationBarcode: `SEC-${tag}-B01`,
          expectedVersion: 1,
          idempotencyKey: sharedIdemKey,
          deviceTimestamp: '2026-11-15T12:00:00.000Z',
        },
        { repository: repo },
      );
      expect(crossTenantSameKey.applied).toBe(true);

      // 5. Immediate revocation denial even on idempotent replay
      await ownerPrisma.organizationMembership.update({
        where: { id: tempMembershipId },
        data: { isActive: false, deactivatedAt: new Date() },
      });

      await expect(
        recordCustodyScan(
          mechSession,
          {
            entity: { kind: 'PART', id: enginePartId },
            destinationBarcode: binBarcode,
            expectedVersion: 1,
            idempotencyKey: sharedIdemKey,
            deviceTimestamp: '2026-11-15T12:00:00.000Z',
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        status: 403,
      });
    });
  },
);
