import { randomUUID } from 'node:crypto';
import {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartCustodyState,
  InventoryAvailabilityState,
  PrismaClient,
  RoadVehicleBrand,
  ScrapStreamCategory,
  UserRole,
} from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import { querySeparatedFinancialSnapshot } from '@/modules/cfo-subledger/financial-snapshot.query';
import type { AuthSessionContext } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import {
  createPrismaStorageSecurityRepository,
  InMemoryStorageAdapter,
} from '@/modules/shared-ops/storage';
import {
  createProductionCompleteHulkScrapUseCase,
  createProductionLogScrapComponentUseCase,
  createProductionStripPartUseCase,
  PartStripError,
} from '../index';

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL part-strip integration tests.`,
    );
  }
  return value;
}

function makeSession(input: {
  userId: string;
  organizationId: string;
  organizationType?: OrganizationType;
  role: UserRole;
}): AuthSessionContext {
  const orgType = input.organizationType ?? OrganizationType.SALVAGE_AND_EXPORT;
  return createAuthSessionContext({
    userId: input.userId,
    activeOrganizationId: input.organizationId,
    role: input.role,
    activeOrganizationType: orgType,
    activeMemberships: [
      {
        membershipId: randomUUID(),
        organizationId: input.organizationId,
        organizationSlug: 'ORG_TEST_PART_STRIP',
        organizationName: 'Test Part Strip Org',
        organizationType: orgType,
        role: input.role,
        isDefaultWorkspace: true,
      },
    ],
    aal: 'aal2',
    mfaEnrolled: true,
  });
}

describe.runIf(HAS_TEST_DATABASE_URL)(
  'Issue 08: Live PostgreSQL erp_app_user Part Strip, Return QC, Scrap & Hulk Integration',
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
              AND NOT EXISTS (SELECT 1 FROM "salvage"."Part" p WHERE p."storageLocationId" = l."id")
              AND NOT EXISTS (SELECT 1 FROM "salvage"."Vehicle" v WHERE v."storageLocationId" = l."id")
          `;
        }
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User" u
            WHERE u."id" = ANY(${createdUserIds}::uuid[])
              AND NOT EXISTS (SELECT 1 FROM "shared"."CustodyEvent" ce WHERE ce."actorUserId" = u."id")
              AND NOT EXISTS (SELECT 1 FROM "shared"."AuditLog" al WHERE al."actorUserId" = u."id")
              AND NOT EXISTS (SELECT 1 FROM "salvage"."Part" p WHERE p."strippedByUserId" = u."id")
              AND NOT EXISTS (SELECT 1 FROM "salvage"."ScrapComponentLog" sl WHERE sl."recordedByUserId" = u."id")
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

    it('enforces erp_app_user NOBYPASSRLS, atomic strip/QC/scrap/hulk, concurrency, append-only triggers, revocation, and FIX 05 snapshot projection', async () => {
      const roleCheck = await runtimePrisma.$queryRaw<
        Array<{ currentUser: string; rolbypassrls: boolean }>
      >`
        SELECT current_user AS "currentUser", r.rolbypassrls
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      expect(roleCheck[0]?.currentUser).toBe('erp_app_user');
      expect(roleCheck[0]?.rolbypassrls).toBe(false);

      const orgId = randomUUID();
      const cannabisOrgId = randomUUID();
      const stripperId = randomUUID();
      const cfoId = randomUUID();
      const bin1Id = randomUUID();
      const bin2Id = randomUUID();
      const cannabisLocId = randomUUID();
      const memStripperId = randomUUID();
      const memCfoId = randomUUID();

      createdOrgIds.push(orgId, cannabisOrgId);
      createdUserIds.push(stripperId, cfoId);
      createdMembershipIds.push(memStripperId, memCfoId);
      createdLocationIds.push(bin1Id, bin2Id, cannabisLocId);

      await ownerPrisma.organization.createMany({
        data: [
          {
            id: orgId,
            slug: `ORG_PS8_${tag}`,
            name: `Part Strip Integration Org ${tag}`,
            organizationType: OrganizationType.SALVAGE_AND_EXPORT,
          },
          {
            id: cannabisOrgId,
            slug: `ORG_CAN8_${tag}`,
            name: `Cannabis Tenant ${tag}`,
            organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
          },
        ],
      });

      await ownerPrisma.user.createMany({
        data: [
          {
            id: stripperId,
            email: `stripper8-${tag}@test.local`,
            fullName: 'Integration Stripper',
            role: UserRole.ONTARIO_STRIPPER,
          },
          {
            id: cfoId,
            email: `cfo8-${tag}@test.local`,
            fullName: 'Integration CFO',
            role: UserRole.ARCHITECT_CFO,
            mfaEnrolled: true,
          },
        ],
      });

      await ownerPrisma.organizationMembership.createMany({
        data: [
          {
            id: memStripperId,
            organizationId: orgId,
            userId: stripperId,
            role: UserRole.ONTARIO_STRIPPER,
            isDefaultWorkspace: true,
            isActive: true,
          },
          {
            id: memCfoId,
            organizationId: orgId,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
            isDefaultWorkspace: true,
            isActive: true,
          },
        ],
      });

      const bin1Barcode = `KEMP-${tag.slice(0, 4)}-R01-S01-B01`;
      const bin2Barcode = `KEMP-${tag.slice(0, 4)}-R01-S01-B02`;
      const cannabisBarcode = `BROCK-${tag.slice(0, 4)}-R1-T1`;

      await ownerPrisma.storageLocation.createMany({
        data: [
          {
            id: bin1Id,
            organizationId: orgId,
            allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
            locationOperationalStatus: LocationOperationalStatus.ACTIVE,
            allowsWholeVehicleDismantling: false,
            maxActiveAssetCapacity: null,
            siteCode: 'KEMP',
            zoneCode: 'ZONE_CONTAINER_PAD',
            containerCode: 'C01',
            rackCode: 'R01',
            shelfCode: 'S01',
            binCode: 'B01',
            fullQrBarcode: bin1Barcode,
          },
          {
            id: bin2Id,
            organizationId: orgId,
            allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
            locationOperationalStatus: LocationOperationalStatus.ACTIVE,
            allowsWholeVehicleDismantling: false,
            maxActiveAssetCapacity: null,
            siteCode: 'KEMP',
            zoneCode: 'ZONE_CONTAINER_PAD',
            containerCode: 'C04',
            rackCode: 'R01',
            shelfCode: 'S01',
            binCode: 'B01',
            fullQrBarcode: bin2Barcode,
          },
          {
            id: cannabisLocId,
            organizationId: cannabisOrgId,
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
            fullQrBarcode: cannabisBarcode,
          },
        ],
      });

      const donorId = randomUUID();
      await ownerPrisma.vehicle.create({
        data: {
          id: donorId,
          organizationId: orgId,
          internalStockNumber: `AST-2026-8${tag.slice(0, 4)}`,
          assetCategory: AssetCategory.AUTOMOBILE,
          vinOrHin: `1HGCM82638A${tag.slice(0, 6)}`,
          year: 2020,
          make: 'Honda',
          model: 'CR-V',
          roadBrand: RoadVehicleBrand.SALVAGE,
          operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
          lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
          estimatedMaxBidCadMinor: 120_000,
          actualPurchasePriceCadMinor: 100_000,
          targetGrossRealizationMinor: 200_000,
          fluidsDrainedAt: new Date('2026-11-01T10:00:00.000Z'),
          catalyticConverterDisposition:
            CatalyticConverterDisposition.PRESENT_AT_INTAKE,
        },
      });

      const storage = new InMemoryStorageAdapter({
        securityRepository: createPrismaStorageSecurityRepository({
          prisma: runtimePrisma,
        }),
      });
      const stripUseCase = createProductionStripPartUseCase({
        prisma: runtimePrisma,
        storage,
      });
      const scrapUseCase = createProductionLogScrapComponentUseCase({
        prisma: runtimePrisma,
        storage,
      });
      const hulkUseCase = createProductionCompleteHulkScrapUseCase({
        prisma: runtimePrisma,
        storage,
      });

      const stripperSession = makeSession({
        userId: stripperId,
        organizationId: orgId,
        role: UserRole.ONTARIO_STRIPPER,
      });
      const cfoSession = makeSession({
        userId: cfoId,
        organizationId: orgId,
        role: UserRole.ARCHITECT_CFO,
      });

      const jpg = Uint8Array.from(
        await sharp({
          create: {
            width: 16,
            height: 16,
            channels: 3,
            background: { r: 22, g: 101, b: 52 },
          },
        })
          .jpeg()
          .toBuffer(),
      );

      // 1. Concurrent same-key strip race applies once via AuditLog receipt PK + CustodyEvent uniqueness
      const numericSku = String(
        Math.floor(100000 + Math.random() * 899999),
      );
      const sku1 = `PRT-${numericSku}`;
      const stripKey = randomUUID();
      const stripTimestamp = new Date();
      const [s1, s2] = await Promise.all([
        stripUseCase.execute(stripperSession, {
          donorVehicleId: donorId,
          donorExpectedVersion: 1,
          partCategoryName: 'Alternator',
          qrSkuCode: sku1,
          araGrade: 'B1',
          compBaselineCadMinor: 50_000,
          weightKg: 5.5,
          destinationBinBarcode: bin1Barcode,
          photos: [{ bytes: jpg }, { bytes: jpg }, { bytes: jpg }],
          idempotencyKey: stripKey,
          deviceTimestamp: stripTimestamp,
        }),
        stripUseCase.execute(stripperSession, {
          donorVehicleId: donorId,
          donorExpectedVersion: 1,
          partCategoryName: 'Alternator',
          qrSkuCode: sku1,
          araGrade: 'B1',
          compBaselineCadMinor: 50_000,
          weightKg: 5.5,
          destinationBinBarcode: bin1Barcode,
          photos: [{ bytes: jpg }, { bytes: jpg }, { bytes: jpg }],
          idempotencyKey: stripKey,
          deviceTimestamp: stripTimestamp,
        }),
      ]);
      expect(s1.partId).toBe(s2.partId);
      expect(s1.replayed || s2.replayed).toBe(true);

      // Cross-tenant bin rejected (422)
      await expect(
        stripUseCase.execute(stripperSession, {
          donorVehicleId: donorId,
          donorExpectedVersion: 2,
          partCategoryName: 'Front Bumper',
          qrSkuCode: `PRT-${String(Number(numericSku) + 1).slice(0, 6)}`,
          araGrade: 'B1',
          compBaselineCadMinor: 25_000,
          weightKg: 7.0,
          destinationBinBarcode: cannabisBarcode,
          photos: [{ bytes: jpg }, { bytes: jpg }, { bytes: jpg }],
          idempotencyKey: randomUUID(),
          deviceTimestamp: new Date(),
        }),
      ).rejects.toMatchObject({ code: 'SITE_ZONING_VIOLATION', status: 422 });

      // 2. Log CASH cat scrap + CONFIRMED_BANK_DEPOSIT shell scrap -> verify FIX 05 snapshot projection
      const catScrap = await scrapUseCase.execute(cfoSession, {
        donorVehicleId: donorId,
        donorExpectedVersion: 2,
        scrapStream: ScrapStreamCategory.CATALYTIC_CONVERTER,
        weightKg: 3.5,
        payoutCadMinor: 20_000,
        recyclerName: 'Ottawa Cats',
        paymentReceiptMode: 'CASH',
        ticketBytes: jpg,
        ticketContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      });
      expect(catScrap.cashCustodyState).toBe(
        CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      );

      const shellScrap = await scrapUseCase.execute(cfoSession, {
        donorVehicleId: donorId,
        donorExpectedVersion: 3,
        scrapStream: ScrapStreamCategory.BARE_STEEL_SHELL,
        weightKg: 900,
        payoutCadMinor: 30_000,
        recyclerName: 'Ottawa Steel',
        paymentReceiptMode: 'CONFIRMED_BANK_DEPOSIT',
        bankDepositConfirmed: true,
        bankDepositReference: `DEP-${tag}`,
        ticketBytes: jpg,
        ticketContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      });
      expect(shellScrap.cashCustodyState).toBe(
        CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      );

      const policy = await new JsonPolicyConfigAdapter().getPolicyForOrg(orgId);
      const snapshot = await withTenantTransaction(
        runtimePrisma,
        {
          organizationId: orgId,
          userId: cfoId,
          role: UserRole.ARCHITECT_CFO,
        },
        (tx) => querySeparatedFinancialSnapshot(tx, orgId, policy),
      );
      expect(snapshot.runningOperatorFloatCadMinor).toBe(20_000);
      expect(snapshot.confirmedCorpBankCashCadMinor).toBe(2_230_000);

      // 3. Return QC real DB transition + append-only trigger check
      await ownerPrisma.part.update({
        where: { id: s1.partId },
        data: {
          custodyState: PartCustodyState.SOLD_AND_RELEASED,
          availabilityState: InventoryAvailabilityState.PAID_SETTLED,
        },
      });
      const qcIn = await stripUseCase.receiveReturnedPartIntoQcHold(
        cfoSession,
        {
          partId: s1.partId,
          expectedVersion: 3, // 1 at strip + 2 from catScrap and shellScrap Stage 2 cost updates
          qcLocationBarcode: bin2Barcode,
          idempotencyKey: randomUUID(),
          deviceTimestamp: new Date(),
        },
      );
      expect(qcIn.custodyState).toBe('RESTOCKED_QC_HOLD');

      // Concurrent conflicting pass vs fail on Return QC -> one succeeds, stale version gets 409 VERSION_CONFLICT
      const qcRace = await Promise.allSettled([
        stripUseCase.completeReturnQcInspection(cfoSession, {
          partId: s1.partId,
          expectedVersion: qcIn.version,
          qcPassed: true,
          inspectedOriginalPhotosAndMarkings: true,
          inspectionNotes: 'OEM stamp matches original photos.',
          destinationBinBarcode: bin1Barcode,
          idempotencyKey: randomUUID(),
          deviceTimestamp: new Date(),
        }),
        stripUseCase.completeReturnQcInspection(cfoSession, {
          partId: s1.partId,
          expectedVersion: qcIn.version,
          qcPassed: false,
          inspectedOriginalPhotosAndMarkings: true,
          inspectionNotes: 'Conflicting inspection fail attempt.',
          idempotencyKey: randomUUID(),
          deviceTimestamp: new Date(),
        }),
      ]);
      expect(qcRace.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const qcRejected = qcRace.filter((r) => r.status === 'rejected');
      expect(qcRejected).toHaveLength(1);
      expect((qcRejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        PartStripError,
      );
      expect(
        ((qcRejected[0] as PromiseRejectedResult).reason as PartStripError).code,
      ).toBe('VERSION_CONFLICT');

      // 4. Hulk clearance
      const hulk = await hulkUseCase.execute(cfoSession, {
        donorVehicleId: donorId,
        donorExpectedVersion: 4,
        bareShellScrapLogId: shellScrap.scrapLogId,
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      });
      expect(hulk.lifecycleState).toBe('SCRAPPED_METAL_CLEARED');

      // 5. Append-only trigger rejects UPDATE on ScrapComponentLog
      await expect(
        ownerPrisma.$executeRaw`
          UPDATE "salvage"."ScrapComponentLog"
          SET "payoutCadMinor" = 999999
          WHERE "id" = ${shellScrap.scrapLogId}::uuid
        `,
      ).rejects.toThrow(/Tampering prohibited/);

      // 6. Live membership revocation denies immediately
      await ownerPrisma.organizationMembership.update({
        where: { id: memStripperId },
        data: { isActive: false, deactivatedAt: new Date() },
      });
      await expect(
        stripUseCase.listDonors(stripperSession),
      ).rejects.toMatchObject({
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        status: 403,
      });
    });
  },
);
