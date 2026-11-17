import { randomUUID } from 'node:crypto';
import {
  AraConditionGradeEnum,
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CurrencyCode,
  DomesticSaleChannel,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  PaymentSettlementState,
  PrismaClient,
  RoadVehicleBrand,
  SaleMarketNode,
  TaxCollectionMode,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import { loadPersistedFinancialSnapshot } from '@/modules/cfo-subledger/financial-snapshot.query';
import { createProductionDomesticCheckoutUseCase } from '@/modules/logistics-vault/checkout/domestic-checkout.repository';
import type { AuthSessionContext } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import { createProductionExpenseService } from '@/modules/shared-ops/expenses';
import {
  createPrismaStorageSecurityRepository,
  InMemoryStorageAdapter,
} from '@/modules/shared-ops/storage';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import {
  createProductionEbayCsvExporterUseCase,
  createProductionLocalClassifiedsQueueUseCase,
} from '../syndication.repository';

const BASELINE_POLICY = await new JsonPolicyConfigAdapter().getPolicyForOrg(
  PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
);

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL Issue #10 integration tests.`,
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
        organizationSlug: `ORG_TEST_${input.organizationId.slice(0, 8)}`,
        organizationName: 'Test Issue 10 Org',
        organizationType: orgType,
        role: input.role,
        isDefaultWorkspace: true,
      },
    ],
    aal: 'aal2',
    mfaEnrolled: true,
  });
}

async function loadSnapshotAsTenant(
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
  role: UserRole,
  policySlice: {
    operationalGates: typeof BASELINE_POLICY.operationalGates;
    compensationRules: typeof BASELINE_POLICY.compensationRules;
  },
) {
  return withTenantTransaction(
    prisma,
    { organizationId, userId, role },
    async (tx) =>
      loadPersistedFinancialSnapshot(tx, organizationId, policySlice),
  );
}

describe.runIf(HAS_TEST_DATABASE_URL)(
  'Issue #10: Live PostgreSQL erp_app_user Syndication, Checkout, Settlement & Refund Integration',
  () => {
    let runtimePrisma!: PrismaClient;
    let ownerPrisma!: PrismaClient;

    const tag = randomUUID().slice(0, 8).toUpperCase();
    const createdOrgIds: string[] = [];
    const createdUserIds: string[] = [];
    const createdMembershipIds: string[] = [];
    const createdLocationIds: string[] = [];
    const createdVehicleIds: string[] = [];
    const createdPartIds: string[] = [];

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
            DELETE FROM "shared"."OrganizationMembership" m
            WHERE m."id" = ANY(${createdMembershipIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."Expense" e
                WHERE e."organizationId" = m."organizationId"
                  AND (e."recipientUserId" = m."userId" OR e."custodyHolderUserId" = m."userId")
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CashCustodyTransfer" ct
                WHERE ct."organizationId" = m."organizationId"
                  AND ct."custodyHolderUserId" = m."userId"
              )
          `;
        }
        if (createdPartIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "salvage"."Part" p
            WHERE p."id" = ANY(${createdPartIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CustodyEvent" ce
                WHERE ce."organizationId" = p."organizationId"
                  AND ce."partId" = p."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."SaleTransactionPartItem" sp
                WHERE sp."organizationId" = p."organizationId"
                  AND sp."partId" = p."id"
              )
          `;
        }
        if (createdVehicleIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "salvage"."Vehicle" v
            WHERE v."id" = ANY(${createdVehicleIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Part" p
                WHERE p."donorVehicleId" = v."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CustodyEvent" ce
                WHERE ce."organizationId" = v."organizationId"
                  AND ce."vehicleId" = v."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."SaleTransactionVehicleItem" sv
                WHERE sv."organizationId" = v."organizationId"
                  AND sv."vehicleId" = v."id"
              )
          `;
        }
        if (createdLocationIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."StorageLocation" l
            WHERE l."id" = ANY(${createdLocationIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Vehicle" v WHERE v."storageLocationId" = l."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Part" p WHERE p."storageLocationId" = l."id"
              )
          `;
        }
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User" u
            WHERE u."id" = ANY(${createdUserIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."OrganizationMembership" m WHERE m."userId" = u."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."SaleTransaction" st
                WHERE st."soldByUserId" = u."id"
                   OR st."brokerUserId" = u."id"
                   OR st."verifiedByAdminId" = u."id"
                   OR st."cfoOverrideApprovedById" = u."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CashCustodyTransfer" ct
                WHERE ct."recordedByUserId" = u."id"
                   OR ct."custodyHolderUserId" = u."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CustodyEvent" ce
                WHERE ce."actorUserId" = u."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."AuditLog" al
                WHERE al."actorUserId" = u."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Part" p
                WHERE p."strippedByUserId" = u."id"
              )
          `;
        }
        if (createdOrgIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."Organization" o
            WHERE o."id" = ANY(${createdOrgIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."OrganizationMembership" m WHERE m."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."SaleTransaction" st WHERE st."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CashCustodyTransfer" ct WHERE ct."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."AuditLog" al WHERE al."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."OutboxEvent" oe WHERE oe."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Part" p WHERE p."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."Vehicle" v WHERE v."organizationId" = o."id"
              )
          `;
        }
      }

      await Promise.allSettled([
        runtimePrisma?.$disconnect(),
        ownerPrisma?.$disconnect(),
      ]);
    });

    it('enforces erp_app_user NOBYPASSRLS, multi-tenant isolation, migration 0005 triggers/checks, concurrent checkout exclusion, settled-eBay & swept-cash two-field refund conservation, and immediate revocation', async () => {
      const roleCheck = await runtimePrisma.$queryRaw<
        Array<{ currentUser: string; rolbypassrls: boolean }>
      >`
        SELECT current_user AS "currentUser", r.rolbypassrls
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      expect(roleCheck[0]?.currentUser).toBe('erp_app_user');
      expect(roleCheck[0]?.rolbypassrls).toBe(false);

      const salvageOrg1Id = randomUUID();
      const salvageOrg2Id = randomUUID();
      const cannabisOrgId = randomUUID();
      const cfoId = randomUUID();
      const hunterId = randomUUID();
      const cfoMem1Id = randomUUID();
      const hunterMem1Id = randomUUID();
      const cfoMem2Id = randomUUID();
      const cfoCannabisMemId = randomUUID();
      const loc1Id = randomUUID();
      const loc2Id = randomUUID();
      const veh1Id = randomUUID();
      const veh2Id = randomUUID();
      const part1Id = randomUUID();
      const part2Id = randomUUID();
      const part3Id = randomUUID();
      const partOrg2Id = randomUUID();

      createdOrgIds.push(salvageOrg1Id, salvageOrg2Id, cannabisOrgId);
      createdUserIds.push(cfoId, hunterId);
      createdMembershipIds.push(
        cfoMem1Id,
        hunterMem1Id,
        cfoMem2Id,
        cfoCannabisMemId,
      );
      createdLocationIds.push(loc1Id, loc2Id);
      createdVehicleIds.push(veh1Id, veh2Id);
      createdPartIds.push(part1Id, part2Id, part3Id, partOrg2Id);

      await ownerPrisma.$transaction(async (tx) => {
        await tx.organization.createMany({
          data: [
            {
              id: salvageOrg1Id,
              slug: `ORG_I10_SALVAGE_1_${tag}`,
              name: `Issue 10 Salvage 1 ${tag}`,
              organizationType: OrganizationType.SALVAGE_AND_EXPORT,
              isActive: true,
            },
            {
              id: salvageOrg2Id,
              slug: `ORG_I10_SALVAGE_2_${tag}`,
              name: `Issue 10 Salvage 2 ${tag}`,
              organizationType: OrganizationType.SALVAGE_AND_EXPORT,
              isActive: true,
            },
            {
              id: cannabisOrgId,
              slug: `ORG_I10_CANNABIS_${tag}`,
              name: `Issue 10 Cannabis ${tag}`,
              organizationType:
                OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
              isActive: true,
            },
          ],
        });

        await tx.user.createMany({
          data: [
            {
              id: cfoId,
              email: `cfo-i10-${tag.toLowerCase()}@test.local`,
              fullName: 'Issue 10 Test CFO',
              role: UserRole.ARCHITECT_CFO,
              mfaEnrolled: true,
              isActive: true,
            },
            {
              id: hunterId,
              email: `hunter-i10-${tag.toLowerCase()}@test.local`,
              fullName: 'Issue 10 Test Hunter',
              role: UserRole.HUNTER_MECHANIC,
              mfaEnrolled: false,
              isActive: true,
            },
          ],
        });

        await tx.organizationMembership.createMany({
          data: [
            {
              id: cfoMem1Id,
              organizationId: salvageOrg1Id,
              userId: cfoId,
              role: UserRole.ARCHITECT_CFO,
              isDefaultWorkspace: true,
              isActive: true,
            },
            {
              id: hunterMem1Id,
              organizationId: salvageOrg1Id,
              userId: hunterId,
              role: UserRole.HUNTER_MECHANIC,
              isDefaultWorkspace: true,
              isActive: true,
            },
            {
              id: cfoMem2Id,
              organizationId: salvageOrg2Id,
              userId: cfoId,
              role: UserRole.ARCHITECT_CFO,
              isDefaultWorkspace: false,
              isActive: true,
            },
            {
              id: cfoCannabisMemId,
              organizationId: cannabisOrgId,
              userId: cfoId,
              role: UserRole.ARCHITECT_CFO,
              isDefaultWorkspace: false,
              isActive: true,
            },
          ],
        });

        await tx.storageLocation.createMany({
          data: [
            {
              id: loc1Id,
              organizationId: salvageOrg1Id,
              siteCode: 'KEMP',
              zoneCode: 'ZONE_CONTAINER_PAD',
              containerCode: 'C01',
              rackCode: 'R01',
              shelfCode: 'S01',
              binCode: `B${tag.slice(0, 4)}`,
              fullQrBarcode: `I10-LOC1-${tag}`,
              allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
              locationOperationalStatus: LocationOperationalStatus.ACTIVE,
              allowsWholeVehicleDismantling: true,
            },
            {
              id: loc2Id,
              organizationId: salvageOrg2Id,
              siteCode: 'KEMP',
              zoneCode: 'ZONE_CONTAINER_PAD',
              containerCode: 'C02',
              rackCode: 'R01',
              shelfCode: 'S01',
              binCode: `B${tag.slice(0, 4)}`,
              fullQrBarcode: `I10-LOC2-${tag}`,
              allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
              locationOperationalStatus: LocationOperationalStatus.ACTIVE,
              allowsWholeVehicleDismantling: true,
            },
          ],
        });

        await tx.vehicle.createMany({
          data: [
            {
              id: veh1Id,
              organizationId: salvageOrg1Id,
              internalStockNumber: `I10-STK1-${tag}`,
              vinOrHin: `1HGCM82633A${tag.slice(0, 6)}`,
              assetCategory: AssetCategory.AUTOMOBILE,
              roadBrand: RoadVehicleBrand.SALVAGE,
              year: 2019,
              make: 'Honda',
              model: 'Civic',
              trim: 'EX',
              engineSpec: '2.0L',
              estimatedMaxBidCadMinor: 200_000,
              operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
              lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              storageLocationId: loc1Id,
            },
            {
              id: veh2Id,
              organizationId: salvageOrg2Id,
              internalStockNumber: `I10-STK2-${tag}`,
              vinOrHin: `2HGCM82633A${tag.slice(0, 6)}`,
              assetCategory: AssetCategory.AUTOMOBILE,
              roadBrand: RoadVehicleBrand.SALVAGE,
              year: 2020,
              make: 'Toyota',
              model: 'Corolla',
              trim: 'SE',
              engineSpec: '2.0L',
              estimatedMaxBidCadMinor: 200_000,
              operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
              lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              storageLocationId: loc2Id,
            },
          ],
        });

        await tx.part.createMany({
          data: [
            {
              id: part1Id,
              organizationId: salvageOrg1Id,
              donorVehicleId: veh1Id,
              storageLocationId: loc1Id,
              strippedByUserId: hunterId,
              qrSkuCode: `PRT-${tag.slice(0, 5)}1`,
              partCategoryName: 'Alternator',
              araGrade: AraConditionGradeEnum.GRADE_A,
              araDamageCode: '00-00',
              weightKg: 6.2,
              compBaselineCadMinor: 10_000,
              retailPriceCadMinor: 10_000,
              custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              complianceState: PartComplianceState.CLEARED_FOR_SALE,
              rawPhotoUrls: [
                `https://cdn.salvage-erp.local/${salvageOrg1Id}/media/${randomUUID()}.webp`,
              ],
              cleanPhotoUrls: [],
            },
            {
              id: part2Id,
              organizationId: salvageOrg1Id,
              donorVehicleId: veh1Id,
              storageLocationId: loc1Id,
              strippedByUserId: hunterId,
              qrSkuCode: `PRT-${tag.slice(0, 5)}2`,
              partCategoryName: 'Starter',
              araGrade: AraConditionGradeEnum.GRADE_B1,
              araDamageCode: '01-00',
              weightKg: 4.1,
              compBaselineCadMinor: 20_000,
              retailPriceCadMinor: null,
              custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              complianceState: PartComplianceState.CLEARED_FOR_SALE,
              rawPhotoUrls: [
                `https://cdn.salvage-erp.local/${salvageOrg1Id}/media/${randomUUID()}.webp`,
              ],
              cleanPhotoUrls: [],
            },
            {
              id: part3Id,
              organizationId: salvageOrg1Id,
              donorVehicleId: veh1Id,
              storageLocationId: loc1Id,
              strippedByUserId: hunterId,
              qrSkuCode: `PRT-${tag.slice(0, 5)}3`,
              partCategoryName: 'Steering Rack',
              araGrade: AraConditionGradeEnum.GRADE_A,
              araDamageCode: '00-00',
              weightKg: 10.5,
              compBaselineCadMinor: 10_000,
              retailPriceCadMinor: 10_000,
              custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              complianceState: PartComplianceState.CLEARED_FOR_SALE,
              rawPhotoUrls: [
                `https://cdn.salvage-erp.local/${salvageOrg1Id}/media/${randomUUID()}.webp`,
              ],
              cleanPhotoUrls: [],
            },
            {
              id: partOrg2Id,
              organizationId: salvageOrg2Id,
              donorVehicleId: veh2Id,
              storageLocationId: loc2Id,
              strippedByUserId: cfoId,
              qrSkuCode: `PRT-${tag.slice(0, 5)}9`,
              partCategoryName: 'Alternator',
              araGrade: AraConditionGradeEnum.GRADE_A,
              araDamageCode: '00-00',
              weightKg: 6.0,
              compBaselineCadMinor: 12_000,
              retailPriceCadMinor: 12_000,
              custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
              availabilityState: InventoryAvailabilityState.AVAILABLE,
              complianceState: PartComplianceState.CLEARED_FOR_SALE,
              rawPhotoUrls: [
                `https://cdn.salvage-erp.local/${salvageOrg2Id}/media/${randomUUID()}.webp`,
              ],
              cleanPhotoUrls: [],
            },
          ],
        });
      });

      const storage = new InMemoryStorageAdapter({
        securityRepository: createPrismaStorageSecurityRepository({
          prisma: runtimePrisma,
        }),
      });
      const exporter = createProductionEbayCsvExporterUseCase({
        prisma: runtimePrisma,
      });
      const localQueue = createProductionLocalClassifiedsQueueUseCase({
        prisma: runtimePrisma,
      });
      const checkout = createProductionDomesticCheckoutUseCase({
        prisma: runtimePrisma,
        storage,
      });
      const expenseService = createProductionExpenseService({
        prisma: runtimePrisma,
        storage,
      });

      const cfoSalvage1 = makeSession({
        userId: cfoId,
        organizationId: salvageOrg1Id,
        role: UserRole.ARCHITECT_CFO,
      });
      const hunterSalvage1 = makeSession({
        userId: hunterId,
        organizationId: salvageOrg1Id,
        role: UserRole.HUNTER_MECHANIC,
      });
      const cfoSalvage2 = makeSession({
        userId: cfoId,
        organizationId: salvageOrg2Id,
        role: UserRole.ARCHITECT_CFO,
      });
      const cfoCannabis = makeSession({
        userId: cfoId,
        organizationId: cannabisOrgId,
        organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        role: UserRole.ARCHITECT_CFO,
      });

      // 1. Cross-tenant RLS isolation: cannabis org and second salvage org cannot see org1 parts
      await expect(
        localQueue.getLocalAdPayload(cfoCannabis, part1Id),
      ).rejects.toBeDefined();
      await expect(
        localQueue.getLocalAdPayload(cfoSalvage2, part1Id),
      ).rejects.toBeDefined();
      const org2Lookup = await checkout.lookupCheckoutItems(cfoSalvage2);
      expect(org2Lookup.some((i) => i.itemId === part1Id)).toBe(false);
      expect(org2Lookup.some((i) => i.itemId === partOrg2Id)).toBe(true);

      // 2. Two-step eBay export + live confirm under erp_app_user
      const csvOut = await exporter.exportEbaySellerHubCsv(cfoSalvage1, {
        partIds: [part1Id],
        idempotencyKey: randomUUID(),
      });
      if (csvOut.format !== 'EBAY_CSV') {
        throw new Error('Expected EBAY_CSV export result.');
      }
      expect(csvOut.exportedPartIds).toContain(part1Id);

      const confirmed = await exporter.confirmEbayListingLive(
        cfoSalvage1,
        part1Id,
        `2859${tag}`,
      );
      expect(confirmed.ebaySyncState).toBe('SYNDICATED_LIVE');

      const payProof = await storage.uploadPrivateEvidence({
        actor: cfoSalvage1,
        organizationId: salvageOrg1Id,
        evidence: Uint8Array.from([1, 2, 3]),
        contentType: 'image/png',
        auditContext: { correlationId: `i10-${tag}` },
      });
      const hunterPayProof = await storage.uploadPrivateEvidence({
        actor: hunterSalvage1,
        organizationId: salvageOrg1Id,
        evidence: Uint8Array.from([2, 3, 4]),
        contentType: 'image/png',
        auditContext: { correlationId: `i10-h-${tag}` },
      });
      const settleProof = await storage.uploadPrivateEvidence({
        actor: cfoSalvage1,
        organizationId: salvageOrg1Id,
        evidence: Uint8Array.from([4, 5, 6]),
        contentType: 'application/pdf',
        auditContext: { correlationId: `i10-s-${tag}` },
      });
      const feeTaxInvoice = await storage.uploadPrivateEvidence({
        actor: cfoSalvage1,
        organizationId: salvageOrg1Id,
        evidence: Uint8Array.from([7, 8, 9]),
        contentType: 'application/pdf',
        auditContext: { correlationId: `i10-itc-${tag}` },
      });

      const policySlice = {
        operationalGates: BASELINE_POLICY.operationalGates,
        compensationRules: BASELINE_POLICY.compensationRules,
      };
      const baselineSnapshot = await loadSnapshotAsTenant(
        runtimePrisma,
        salvageOrg1Id,
        cfoId,
        UserRole.ARCHITECT_CFO,
        policySlice,
      );

      // 3. Migration 0005 INSERT check: actualPlatformFeeMinor MUST start NULL
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: salvageOrg1Id,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) => {
            await tx.saleTransaction.create({
              data: {
                id: randomUUID(),
                organizationId: salvageOrg1Id,
                receiptNumber: `BAD-INS-${tag}`,
                marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
                domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
                paymentCurrency: CurrencyCode.CAD,
                taxCollectionMode:
                  TaxCollectionMode.MARKETPLACE_FACILITATOR_COLLECTED,
                buyerName: 'Bad Insert Buyer',
                soldByUserId: cfoId,
                verifiedByAdminId: cfoId,
                subtotalMinor: 10_000,
                taxOrVatMinor: 0,
                grossCollectedMinor: 10_000,
                netRealizedCadMinor: 8_700,
                actualPlatformFeeMinor: 100,
                paymentMethod: 'EBAY_MANAGED_PAYOUT',
                paymentSettlementState:
                  PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
                cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
                paymentProofStorageKey: payProof.storageKey,
              },
            });
          },
        ),
      ).rejects.toThrow(/actualPlatformFeeMinor/i);

      // 4. Concurrent double checkout on part1Id -> exactly 1 succeeds, 1 fails
      const [c1, c2] = await Promise.allSettled([
        checkout.executeDomesticCheckout(cfoSalvage1, {
          domesticChannel: 'EBAY_MOTORS_SHIPPED',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'EBAY_MANAGED_PAYOUT',
          buyerName: 'Live DB Buyer A',
          partLines: [{ partId: part1Id, proposedPriceCadMinor: 10_000 }],
          paymentProofStorageKey: payProof.storageKey,
          platformFeeMinor: 1_300,
          estimatedPlatformFeeTaxCadMinor: 169,
          idempotencyKey: randomUUID(),
        }),
        checkout.executeDomesticCheckout(cfoSalvage1, {
          domesticChannel: 'EBAY_MOTORS_SHIPPED',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'EBAY_MANAGED_PAYOUT',
          buyerName: 'Live DB Buyer B',
          partLines: [{ partId: part1Id, proposedPriceCadMinor: 10_000 }],
          paymentProofStorageKey: payProof.storageKey,
          platformFeeMinor: 1_300,
          estimatedPlatformFeeTaxCadMinor: 169,
          idempotencyKey: randomUUID(),
        }),
      ]);
      const fulfilled = [c1, c2].filter((r) => r.status === 'fulfilled');
      const rejected = [c1, c2].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const sale1 = fulfilled[0]!.value;

      // Cross-tenant settlement attempt by second salvage org is denied
      await expect(
        checkout.confirmSaleBankSettlement(cfoSalvage2, sale1.saleId, {
          bankDepositReference: `DEP-X-${tag}`,
          settlementProofStorageKey: settleProof.storageKey,
        }),
      ).rejects.toBeDefined();

      // Migration 0005 checks on unsettled eBay sale1:
      // (a) negative actualPlatformFeeMinor on settlement rejects
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: salvageOrg1Id,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) => {
            await tx.saleTransaction.update({
              where: { id: sale1.saleId },
              data: {
                paymentSettlementState:
                  PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
                cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
                actualPlatformFeeMinor: -1,
              },
            });
          },
        ),
      ).rejects.toThrow();

      // (b) setting actualPlatformFeeMinor while staying MARKETPLACE_PAYOUT_PENDING rejects
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: salvageOrg1Id,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) => {
            await tx.saleTransaction.update({
              where: { id: sale1.saleId },
              data: { actualPlatformFeeMinor: 1_500 },
            });
          },
        ),
      ).rejects.toThrow();

      // 5. Settled eBay sale1 WITH verified fee tax invoice -> +8,500 bank cash & +169 ITC
      const settled1 = await checkout.confirmSaleBankSettlement(
        cfoSalvage1,
        sale1.saleId,
        {
          bankDepositReference: `DEP1-${tag}`,
          settlementProofStorageKey: settleProof.storageKey,
          actualPlatformFeeMinor: 1_500,
          feeTaxInvoiceStorageKey: feeTaxInvoice.storageKey,
        },
      );
      expect(settled1.actualPlatformFeeMinor).toBe(1_500);
      expect(settled1.itcReceivableCadMinor).toBe(169);

      const postSettle1Snapshot = await loadSnapshotAsTenant(
        runtimePrisma,
        salvageOrg1Id,
        cfoId,
        UserRole.ARCHITECT_CFO,
        policySlice,
      );
      expect(
        postSettle1Snapshot.snapshot.confirmedCorpBankCashCadMinor -
          baselineSnapshot.snapshot.confirmedCorpBankCashCadMinor,
      ).toBe(8_500);
      expect(
        postSettle1Snapshot.taxCounters.verifiedItcReceivableCadMinor -
          baselineSnapshot.taxCounters.verifiedItcReceivableCadMinor,
      ).toBe(169);

      // (c) Migration 0005 once-set immutability: rewriting actualPlatformFeeMinor rejects
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: salvageOrg1Id,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) => {
            await tx.saleTransaction.update({
              where: { id: sale1.saleId },
              data: { actualPlatformFeeMinor: 1_600 },
            });
          },
        ),
      ).rejects.toThrow(/Immutable financial or tax columns/i);

      // Two-field refund on settled eBay sale1 -> returns bank/pending/revenue/profit to baseline, retains +169 verified ITC, puts part1 in QC hold
      const refunded1 = await checkout.recordSaleRefundOrChargeback(
        cfoSalvage1,
        sale1.saleId,
        {
          reasonNote: `Live DB Refund 1 ${tag}`,
          returnPartsToQcHold: true,
        },
      );
      expect(refunded1.chosenFundingSource).toBe('CORP_BANK');
      expect(refunded1.bankCashAdjustmentCadMinor).toBe(-8_500);

      const postRefund1Snapshot = await loadSnapshotAsTenant(
        runtimePrisma,
        salvageOrg1Id,
        cfoId,
        UserRole.ARCHITECT_CFO,
        policySlice,
      );
      expect(postRefund1Snapshot.snapshot.confirmedCorpBankCashCadMinor).toBe(
        baselineSnapshot.snapshot.confirmedCorpBankCashCadMinor,
      );
      expect(
        postRefund1Snapshot.snapshot.pendingExternalReceivablesCadMinor,
      ).toBe(baselineSnapshot.snapshot.pendingExternalReceivablesCadMinor);
      expect(postRefund1Snapshot.snapshot.accountingRevenueCadMinor).toBe(
        baselineSnapshot.snapshot.accountingRevenueCadMinor,
      );
      expect(
        postRefund1Snapshot.snapshot.distributableRealizedProfitPoolCadMinor,
      ).toBe(baselineSnapshot.snapshot.distributableRealizedProfitPoolCadMinor);
      expect(
        postRefund1Snapshot.taxCounters.verifiedItcReceivableCadMinor -
          baselineSnapshot.taxCounters.verifiedItcReceivableCadMinor,
      ).toBe(169);

      const part1AfterReturn = await ownerPrisma.part.findUniqueOrThrow({
        where: { id: part1Id },
      });
      expect(part1AfterReturn.custodyState).toBe('RESTOCKED_QC_HOLD');
      expect(part1AfterReturn.availabilityState).toBe('RETURNED_QC_HOLD');
      expect(part1AfterReturn.complianceState).toBe('NEEDS_HUMAN_REVIEW');
      expect(part1AfterReturn.ebaySyncState).toBe('DELISTED');

      // 6. Settled eBay sale2 WITHOUT fee tax invoice (part2 uses GRADE_B1 fallback on 20,000)
      const sale2 = await checkout.executeDomesticCheckout(cfoSalvage1, {
        domesticChannel: 'EBAY_MOTORS_SHIPPED',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'EBAY_MANAGED_PAYOUT',
        buyerName: 'Live DB Buyer No ITC',
        partLines: [{ partId: part2Id, proposedPriceCadMinor: 20_000 }],
        paymentProofStorageKey: payProof.storageKey,
        platformFeeMinor: 2_650,
        estimatedPlatformFeeTaxCadMinor: 345,
        idempotencyKey: randomUUID(),
      });
      const settled2 = await checkout.confirmSaleBankSettlement(
        cfoSalvage1,
        sale2.saleId,
        {
          bankDepositReference: `DEP2-${tag}`,
          settlementProofStorageKey: settleProof.storageKey,
          actualPlatformFeeMinor: 2_500,
        },
      );
      expect(settled2.isFeeTaxInvoiceVerified).toBe(false);
      expect(settled2.itcReceivableCadMinor).toBe(0);

      const refunded2 = await checkout.recordSaleRefundOrChargeback(
        cfoSalvage1,
        sale2.saleId,
        {
          reasonNote: `Live DB Refund 2 ${tag}`,
          returnPartsToQcHold: false,
        },
      );
      expect(refunded2.bankCashAdjustmentCadMinor).toBe(-17_500);

      const postRefund2Snapshot = await loadSnapshotAsTenant(
        runtimePrisma,
        salvageOrg1Id,
        cfoId,
        UserRole.ARCHITECT_CFO,
        policySlice,
      );
      expect(postRefund2Snapshot.snapshot.confirmedCorpBankCashCadMinor).toBe(
        baselineSnapshot.snapshot.confirmedCorpBankCashCadMinor,
      );
      expect(
        postRefund2Snapshot.snapshot.pendingExternalReceivablesCadMinor,
      ).toBe(baselineSnapshot.snapshot.pendingExternalReceivablesCadMinor);
      expect(postRefund2Snapshot.snapshot.accountingRevenueCadMinor).toBe(
        baselineSnapshot.snapshot.accountingRevenueCadMinor,
      );
      expect(
        postRefund2Snapshot.snapshot.distributableRealizedProfitPoolCadMinor,
      ).toBe(baselineSnapshot.snapshot.distributableRealizedProfitPoolCadMinor);

      // 7. Persisted swept-cash two-field refund conservation + non-eBay actualPlatformFeeMinor trigger rejection
      const cashSale = await checkout.executeDomesticCheckout(hunterSalvage1, {
        domesticChannel: 'LOCAL_WALK_IN_CASH',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'CASH',
        isCashCountedInPerson: true,
        buyerName: 'Walk-in Cash Buyer',
        partLines: [{ partId: part3Id, proposedPriceCadMinor: 10_000 }],
        paymentProofStorageKey: hunterPayProof.storageKey,
        idempotencyKey: randomUUID(),
      });
      expect(cashSale.taxOrVatMinor).toBe(1_300);
      expect(cashSale.grossCollectedMinor).toBe(11_300);
      expect(cashSale.cashCustodyState).toBe('HELD_IN_OPERATOR_FLOAT');

      // (d) Migration 0005 check: non-eBay sale cannot set actualPlatformFeeMinor
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: salvageOrg1Id,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) => {
            await tx.saleTransaction.update({
              where: { id: cashSale.saleId },
              data: {
                paymentSettlementState:
                  PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
                cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
                actualPlatformFeeMinor: 500,
              },
            });
          },
        ),
      ).rejects.toThrow();

      // Sweep Hunter's 11,300 float into corporate bank via real CashCustodyTransfer
      await expenseService.recordCashCustodyTransfer(cfoSalvage1, {
        fromCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
        toCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
        amountMinor: 11_300,
        custodyHolderUserId: hunterId,
        depositSlipBytes: Uint8Array.from([1, 2, 3, 4]),
        depositSlipContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
      });

      const postSweepSnapshot = await loadSnapshotAsTenant(
        runtimePrisma,
        salvageOrg1Id,
        cfoId,
        UserRole.ARCHITECT_CFO,
        policySlice,
      );
      expect(
        postSweepSnapshot.snapshot.confirmedCorpBankCashCadMinor -
          baselineSnapshot.snapshot.confirmedCorpBankCashCadMinor,
      ).toBe(11_300);
      expect(postSweepSnapshot.snapshot.runningOperatorFloatCadMinor).toBe(
        baselineSnapshot.snapshot.runningOperatorFloatCadMinor,
      );
      expect(
        postSweepSnapshot.taxCounters.directTaxCollectedNetOfRefundsCadMinor -
          baselineSnapshot.taxCounters.directTaxCollectedNetOfRefundsCadMinor,
      ).toBe(1_300);

      // Exact two-field refund on swept cash sale draws from CORP_BANK
      const sweptRefund = await checkout.recordSaleRefundOrChargeback(
        cfoSalvage1,
        cashSale.saleId,
        {
          reasonNote: `Swept cash refund ${tag}`,
          returnPartsToQcHold: true,
        },
      );
      expect(sweptRefund.chosenFundingSource).toBe('CORP_BANK');
      expect(sweptRefund.reversalCashCustodyState).toBe(
        'SETTLED_ORIGIN_CORP_BANK',
      );
      expect(sweptRefund.taxOrVatAdjustmentMinor).toBe(-1_300);
      expect(sweptRefund.grossAdjustmentMinor).toBe(-11_300);
      expect(sweptRefund.bankCashAdjustmentCadMinor).toBe(-11_300);

      const postSweptRefundSnapshot = await loadSnapshotAsTenant(
        runtimePrisma,
        salvageOrg1Id,
        cfoId,
        UserRole.ARCHITECT_CFO,
        policySlice,
      );
      expect(
        postSweptRefundSnapshot.snapshot.confirmedCorpBankCashCadMinor,
      ).toBe(baselineSnapshot.snapshot.confirmedCorpBankCashCadMinor);
      expect(
        postSweptRefundSnapshot.snapshot.runningOperatorFloatCadMinor,
      ).toBe(baselineSnapshot.snapshot.runningOperatorFloatCadMinor);
      expect(
        postSweptRefundSnapshot.taxCounters
          .directTaxCollectedNetOfRefundsCadMinor,
      ).toBe(
        baselineSnapshot.taxCounters.directTaxCollectedNetOfRefundsCadMinor,
      );
      expect(postSweptRefundSnapshot.snapshot.accountingRevenueCadMinor).toBe(
        baselineSnapshot.snapshot.accountingRevenueCadMinor,
      );
      expect(
        postSweptRefundSnapshot.snapshot
          .distributableRealizedProfitPoolCadMinor,
      ).toBe(baselineSnapshot.snapshot.distributableRealizedProfitPoolCadMinor);

      // 8. Immediate OrganizationMembership.isActive = false revocation blocks runtime access
      await ownerPrisma.organizationMembership.update({
        where: { id: hunterMem1Id },
        data: { isActive: false, deactivatedAt: new Date() },
      });
      await expect(
        checkout.lookupCheckoutItems(hunterSalvage1),
      ).rejects.toMatchObject({
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        status: 403,
      });
    });
  },
);
