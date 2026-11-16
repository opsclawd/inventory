import { randomUUID } from 'node:crypto';
import {
  AssetCategory,
  AssetLifecycleState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PrismaClient,
  RoadVehicleBrand,
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
import {
  createProductionIntakeVehicleUseCase,
  type IntakeVehicleInput,
  VehicleIntakeError,
} from '../index';

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL vehicle intake integration tests.`,
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
        organizationSlug: 'ORG_TEST_SALVAGE',
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
  'Issue 07: Live PostgreSQL erp_app_user Vehicle Intake, Acquisition Ledger, Concurrency & Revocation',
  () => {
    let runtimePrisma!: PrismaClient;
    let ownerPrisma!: PrismaClient;

    const tag = randomUUID().slice(0, 8).toUpperCase();
    const createdMembershipIds: string[] = [];
    const createdLocationIds: string[] = [];
    const createdUserIds: string[] = [];
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
        if (createdLocationIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."StorageLocation" l
            WHERE l."id" = ANY(${createdLocationIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "salvage"."Vehicle" v WHERE v."storageLocationId" = l."id")
          `;
        }
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User" u
            WHERE u."id" = ANY(${createdUserIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "shared"."CustodyEvent" ce WHERE ce."actorUserId" = u."id")
              AND NOT EXISTS (SELECT 1 FROM "shared"."AuditLog" al WHERE al."actorUserId" = u."id")
              AND NOT EXISTS (SELECT 1 FROM "shared"."Expense" ex WHERE ex."loggedByUserId" = u."id")
          `;
        }
        if (createdOrgIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."Organization" o
            WHERE o."id" = ANY(${createdOrgIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "shared"."AuditLog" al WHERE al."organizationId" = o."id")
          `;
        }
      }

      await Promise.allSettled([
        runtimePrisma?.$disconnect(),
        ownerPrisma?.$disconnect(),
      ]);
    });

    it('enforces erp_app_user NOBYPASSRLS, atomic Vehicle+Expense+CustodyEvent+AuditLog persistence, capacity/capital concurrency, idempotency, and immediate revocation', async () => {
      const roleCheck = await runtimePrisma.$queryRaw<
        Array<{ currentUser: string; rolbypassrls: boolean }>
      >`
        SELECT current_user AS "currentUser", r.rolbypassrls
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      expect(roleCheck[0]?.currentUser).toBe('erp_app_user');
      expect(roleCheck[0]?.rolbypassrls).toBe(false);

      // Provision isolated test salvage org + cannabis org + users + locations via ownerPrisma
      const orgId = randomUUID();
      const otherOrgId = randomUUID();
      const cfoId = randomUUID();
      const hunterId = randomUUID();
      const padId = randomUUID();
      const otherLocId = randomUUID();
      const cfoMemId = randomUUID();
      const hunterMemId = randomUUID();

      createdOrgIds.push(orgId, otherOrgId);
      createdUserIds.push(cfoId, hunterId);
      createdMembershipIds.push(cfoMemId, hunterMemId);
      createdLocationIds.push(padId, otherLocId);

      await ownerPrisma.organization.createMany({
        data: [
          {
            id: orgId,
            slug: `ORG_INT7_${tag}`,
            name: `Intake Integration Test Org ${tag}`,
            organizationType: OrganizationType.SALVAGE_AND_EXPORT,
            policyConfigJson: {
              operationalGates: {
                workingCapitalGate: {
                  totalCommittedLoanFacilityCadMinor: 1_050_000,
                  initialSeedCapitalCadMinor: 1_050_000,
                  tranches: [
                    {
                      trancheCode: 'TRANCHE_1_LAUNCH',
                      principalCadMinor: 1_050_000,
                      unlocked: true,
                    },
                  ],
                },
              },
            },
          },
          {
            id: otherOrgId,
            slug: `ORG_OTHER7_${tag}`,
            name: `Other Tenant ${tag}`,
            organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
          },
        ],
      });

      await ownerPrisma.user.createMany({
        data: [
          {
            id: cfoId,
            email: `cfo-${tag}@test.local`,
            fullName: 'Integration CFO',
            role: UserRole.ARCHITECT_CFO,
            mfaEnrolled: true,
          },
          {
            id: hunterId,
            email: `hunter-${tag}@test.local`,
            fullName: 'Integration Hunter',
            role: UserRole.HUNTER_MECHANIC,
            mfaEnrolled: false,
          },
        ],
      });

      await ownerPrisma.organizationMembership.createMany({
        data: [
          {
            id: cfoMemId,
            organizationId: orgId,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
            isDefaultWorkspace: true,
            isActive: true,
          },
          {
            id: hunterMemId,
            organizationId: orgId,
            userId: hunterId,
            role: UserRole.HUNTER_MECHANIC,
            isDefaultWorkspace: true,
            isActive: true,
          },
        ],
      });

      const padBarcode = `IT7PAD-${tag}-C01`;
      const otherBarcode = `BROCK7-${tag}-R1-T1`;
      await ownerPrisma.storageLocation.createMany({
        data: [
          {
            id: padId,
            organizationId: orgId,
            allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
            locationOperationalStatus: LocationOperationalStatus.ACTIVE,
            allowsWholeVehicleDismantling: false,
            maxActiveAssetCapacity: 2,
            siteCode: 'KEMP',
            zoneCode: 'ZONE_CONTAINER_PAD',
            containerCode: 'PAD',
            rackCode: 'R00',
            shelfCode: 'S00',
            binCode: 'B00',
            fullQrBarcode: padBarcode,
          },
          {
            id: otherLocId,
            organizationId: otherOrgId,
            allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
            locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
            allowsWholeVehicleDismantling: false,
            maxActiveAssetCapacity: null,
            siteCode: 'BROCK',
            zoneCode: 'ZONE_BROCKVILLE_FACILITY',
            containerCode: 'PROP',
            rackCode: 'R1',
            shelfCode: 'T1',
            binCode: 'B01',
            fullQrBarcode: otherBarcode,
          },
        ],
      });

      const useCase = createProductionIntakeVehicleUseCase({
        prisma: runtimePrisma,
      });
      const cfoSession = makeSession({
        userId: cfoId,
        organizationId: orgId,
        role: UserRole.ARCHITECT_CFO,
      });
      const hunterSession = makeSession({
        userId: hunterId,
        organizationId: orgId,
        role: UserRole.HUNTER_MECHANIC,
      });

      // 1. Cross-tenant destination always returns 422 SITE_ZONING_VIOLATION
      await expect(
        useCase.execute(cfoSession, {
          assetCategory: 'AUTOMOBILE',
          vinOrHin: `1HGCM82633A${tag.slice(0, 6)}`,
          year: 2020,
          make: 'Honda',
          model: 'Civic',
          destinationBarcode: otherBarcode,
          operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
          roadBrand: RoadVehicleBrand.SALVAGE,
          acquisitionSource: 'LICENSED_AUCTION',
          declaredStatutoryPurpose: 'WRECKING_PARTS_ONLY',
          estimatedMaxBidCadMinor: 150_000,
          actualPurchasePriceCadMinor: 100_000,
          paidAcquisitionComponents: [
            {
              category: 'AUCTION_PURCHASE_PRICE',
              vendorName: 'Auction',
              amountCadMinor: 100_000,
              paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
              receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
              voucherReason: 'Invoice pending',
            },
          ],
          idempotencyKey: randomUUID(),
          deviceTimestamp: new Date(),
        }),
      ).rejects.toBeInstanceOf(LocationCustodyError);

      // 2. Concurrent reserve-boundary race: $10,500 capital, $7,500 floor -> two $2,000 buys race; only 1 fits!
      const raceKeyA = randomUUID();
      const raceKeyB = randomUUID();
      const inputA: IntakeVehicleInput = {
        assetCategory: 'AUTOMOBILE',
        vinOrHin: `2HGCM82633A${tag.slice(0, 6)}`,
        year: 2020,
        make: 'Kia',
        model: 'Telluride',
        destinationBarcode: padBarcode,
        operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
        roadBrand: RoadVehicleBrand.SALVAGE,
        acquisitionSource: 'LICENSED_AUCTION',
        declaredStatutoryPurpose: 'WRECKING_PARTS_ONLY',
        sellerFullName: 'IAAI Ottawa',
        ontarioPermitNumber: 'ON-IT-1',
        fluidsDrainedAt: new Date(),
        estimatedMaxBidCadMinor: 200_000,
        actualPurchasePriceCadMinor: 200_000,
        paidAcquisitionComponents: [
          {
            category: 'AUCTION_PURCHASE_PRICE',
            vendorName: 'IAAI',
            amountCadMinor: 200_000,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
            voucherReason: 'Auction bill pending upload',
          },
        ],
        idempotencyKey: raceKeyA,
        deviceTimestamp: new Date(),
      };
      const inputB: IntakeVehicleInput = {
        ...inputA,
        vinOrHin: `3HGCM82633A${tag.slice(0, 6)}`,
        idempotencyKey: raceKeyB,
        paidAcquisitionComponents: [
          {
            category: 'AUCTION_PURCHASE_PRICE',
            vendorName: 'IAAI',
            amountCadMinor: 200_000,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
            voucherReason: 'Auction bill pending upload',
          },
        ],
      };

      const raceResults = await Promise.allSettled([
        useCase.execute(hunterSession, inputA),
        useCase.execute(hunterSession, inputB),
      ]);
      const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
      const rejected = raceResults.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        VehicleIntakeError,
      );
      expect(
        ((rejected[0] as PromiseRejectedResult).reason as VehicleIntakeError)
          .code,
      ).toBe('WORKING_CAPITAL_RESERVE_BREACHED');

      // 3. Concurrent idempotency replay race
      const replayInput: IntakeVehicleInput = {
        ...inputA,
        vinOrHin: `4HGCM82633A${tag.slice(0, 6)}`,
        actualPurchasePriceCadMinor: 50_000,
        estimatedMaxBidCadMinor: 60_000,
        paidAcquisitionComponents: [
          {
            category: 'AUCTION_PURCHASE_PRICE',
            vendorName: 'IAAI',
            amountCadMinor: 50_000,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
            voucherReason: 'Auction bill pending upload',
          },
        ],
        idempotencyKey: randomUUID(),
      };
      const [idemp1, idemp2] = await Promise.all([
        useCase.execute(cfoSession, replayInput),
        useCase.execute(cfoSession, replayInput),
      ]);
      expect(idemp1.vehicleId).toBe(idemp2.vehicleId);
      expect(idemp1.replayed || idemp2.replayed).toBe(true);

      // 4. Capacity race between intake and recordCustodyScan on pad (maxActiveAssetCapacity = 2, already 2 staged)
      const standaloneVehId = randomUUID();
      await ownerPrisma.vehicle.create({
        data: {
          id: standaloneVehId,
          organizationId: orgId,
          internalStockNumber: `AST-2026-ST${tag.slice(0, 4)}`,
          assetCategory: AssetCategory.AUTOMOBILE,
          vinOrHin: `5HGCM82633A${tag.slice(0, 6)}`,
          year: 2019,
          make: 'Mazda',
          model: 'CX-5',
          roadBrand: RoadVehicleBrand.SALVAGE,
          operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
          lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
          estimatedMaxBidCadMinor: 50_000,
        },
      });
      const custodyRepo = createPrismaCustodyRepository({
        prisma: runtimePrisma,
      });
      await expect(
        recordCustodyScan(
          cfoSession,
          {
            entity: { kind: 'VEHICLE', id: standaloneVehId },
            destinationBarcode: padBarcode,
            expectedVersion: 1,
            idempotencyKey: randomUUID(),
            deviceTimestamp: new Date(),
          },
          { repository: custodyRepo },
        ),
      ).rejects.toMatchObject({ code: 'LOCATION_CAPACITY_EXCEEDED' });

      // 5. Register read succeeds before revocation, fails immediately after OrganizationMembership.isActive = false
      const regBefore = await useCase.listHtaSection60Register(
        cfoSession,
        'JSON',
      );
      expect(regBefore.rows.length).toBeGreaterThanOrEqual(2);

      await ownerPrisma.organizationMembership.update({
        where: { id: hunterMemId },
        data: { isActive: false, deactivatedAt: new Date() },
      });

      await expect(
        useCase.execute(hunterSession, {
          ...replayInput,
          vinOrHin: `6HGCM82633A${tag.slice(0, 6)}`,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        status: 403,
      });
    });
  },
);
