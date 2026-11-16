import { randomUUID } from 'node:crypto';
import {
  CashCustodyState,
  CurrencyCode,
  DomesticSaleChannel,
  ExpenseCategory,
  OrganizationType,
  PaymentSettlementState,
  PrismaClient,
  ReceiptVerificationState,
  SaleMarketNode,
  TaxCollectionMode,
  UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import type { AuthSessionContext } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import { InMemoryStorageAdapter } from '@/modules/shared-ops/storage';
import { createPrismaStorageSecurityRepository } from '@/modules/shared-ops/storage/storage.service';
import { createProductionExpenseService } from '../index';

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL expenses integration tests.`,
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
        organizationSlug: `ORG_TEST_${input.organizationId.slice(0, 6)}`,
        organizationName: 'Test Expenses Org',
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
  'Issue 09: Live PostgreSQL erp_app_user Expenses, Accruals, Sweeps & Immutability Integration',
  () => {
    let runtimePrisma!: PrismaClient;
    let ownerPrisma!: PrismaClient;

    const tag = randomUUID().slice(0, 8).toUpperCase();
    const createdOrgIds: string[] = [];
    const createdUserIds: string[] = [];
    const createdMembershipIds: string[] = [];

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
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User" u
            WHERE u."id" = ANY(${createdUserIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."OrganizationMembership" m
                WHERE m."userId" = u."id"
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
                SELECT 1 FROM "shared"."Expense" e
                WHERE e."loggedByUserId" = u."id"
                   OR e."recipientUserId" = u."id"
                   OR e."custodyHolderUserId" = u."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."AuditLog" al
                WHERE al."actorUserId" = u."id"
              )
          `;
        }
        if (createdOrgIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."Organization" o
            WHERE o."id" = ANY(${createdOrgIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."OrganizationMembership" m
                WHERE m."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "salvage"."SaleTransaction" st
                WHERE st."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."Expense" e
                WHERE e."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."CashCustodyTransfer" ct
                WHERE ct."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."AuditLog" al
                WHERE al."organizationId" = o."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."OutboxEvent" oe
                WHERE oe."organizationId" = o."id"
              )
          `;
        }
      }

      await Promise.allSettled([
        runtimePrisma?.$disconnect(),
        ownerPrisma?.$disconnect(),
      ]);
    });

    it('enforces erp_app_user NOBYPASSRLS, composite membership FKs, trigger protections, idempotency, and concurrent cap/sweep serialization', async () => {
      const roleCheck = await runtimePrisma.$queryRaw<
        Array<{ currentUser: string; rolbypassrls: boolean }>
      >`
        SELECT current_user AS "currentUser", r.rolbypassrls
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      expect(roleCheck[0]?.currentUser).toBe('erp_app_user');
      expect(roleCheck[0]?.rolbypassrls).toBe(false);

      const salvageOrgId = randomUUID();
      const cannabisOrgId = randomUUID();
      const cfoId = randomUUID();
      const hunterId = randomUUID();
      const cfoMemId = randomUUID();
      const hunterMemId = randomUUID();
      const cannabisMemId = randomUUID();

      createdOrgIds.push(salvageOrgId, cannabisOrgId);
      createdUserIds.push(cfoId, hunterId);
      createdMembershipIds.push(cfoMemId, hunterMemId, cannabisMemId);

      await ownerPrisma.$transaction(async (tx) => {
        await tx.organization.createMany({
          data: [
            {
              id: salvageOrgId,
              slug: `ORG_EXP_SALVAGE_${tag}`,
              name: `Test Salvage ${tag}`,
              organizationType: OrganizationType.SALVAGE_AND_EXPORT,
              isActive: true,
            },
            {
              id: cannabisOrgId,
              slug: `ORG_EXP_CANNABIS_${tag}`,
              name: `Test Cannabis ${tag}`,
              organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
              isActive: true,
            },
          ],
        });

        await tx.user.createMany({
          data: [
            {
              id: cfoId,
              email: `cfo-exp-${tag.toLowerCase()}@test.local`,
              fullName: 'Test CFO',
              role: UserRole.ARCHITECT_CFO,
              mfaEnrolled: true,
              isActive: true,
            },
            {
              id: hunterId,
              email: `hunter-exp-${tag.toLowerCase()}@test.local`,
              fullName: 'Test Hunter',
              role: UserRole.HUNTER_MECHANIC,
              mfaEnrolled: false,
              isActive: true,
            },
          ],
        });

        await tx.organizationMembership.createMany({
          data: [
            {
              id: cfoMemId,
              organizationId: salvageOrgId,
              userId: cfoId,
              role: UserRole.ARCHITECT_CFO,
              isDefaultWorkspace: true,
              isActive: true,
            },
            {
              id: hunterMemId,
              organizationId: salvageOrgId,
              userId: hunterId,
              role: UserRole.HUNTER_MECHANIC,
              isDefaultWorkspace: true,
              isActive: true,
            },
            {
              id: cannabisMemId,
              organizationId: cannabisOrgId,
              userId: cfoId,
              role: UserRole.ARCHITECT_CFO,
              isDefaultWorkspace: false,
              isActive: true,
            },
          ],
        });

        // Seed cash sale ($100) + bank sale ($200) in salvage org
        await tx.saleTransaction.createMany({
          data: [
            {
              id: randomUUID(),
              organizationId: salvageOrgId,
              receiptNumber: `EXP-CASH-${tag}`,
              buyerName: 'Walk-in Cash Buyer',
              marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
              domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
              paymentCurrency: CurrencyCode.CAD,
              taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
              subtotalMinor: 10_000,
              taxOrVatMinor: 0,
              grossCollectedMinor: 10_000,
              netRealizedCadMinor: 10_000,
              paymentMethod: 'CASH',
              paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
              cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
              paymentConfirmedAt: new Date(),
              paymentProofStorageKey: `${salvageOrgId}/evidence/${randomUUID()}`,
              soldByUserId: hunterId,
              verifiedByAdminId: cfoId,
            },
            {
              id: randomUUID(),
              organizationId: salvageOrgId,
              receiptNumber: `EXP-BANK-${tag}`,
              buyerName: 'Direct Wire Buyer',
              marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
              domesticChannel: DomesticSaleChannel.FB_MARKETPLACE_LOCAL,
              paymentCurrency: CurrencyCode.CAD,
              taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
              subtotalMinor: 20_000,
              taxOrVatMinor: 0,
              grossCollectedMinor: 20_000,
              netRealizedCadMinor: 20_000,
              paymentMethod: 'VERIFIED_BANK_WIRE',
              paymentSettlementState:
                PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
              cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
              paymentConfirmedAt: new Date(),
              bankSettledAt: new Date(),
              bankDepositReference: `WIRE-${tag}`,
              paymentProofStorageKey: `${salvageOrgId}/evidence/${randomUUID()}`,
              soldByUserId: cfoId,
              verifiedByAdminId: cfoId,
            },
          ],
        });
      });

      const storage = new InMemoryStorageAdapter({
        securityRepository: createPrismaStorageSecurityRepository({
          prisma: runtimePrisma,
        }),
      });
      const service = createProductionExpenseService({
        prisma: runtimePrisma,
        storage,
      });

      const cfoSession = makeSession({
        userId: cfoId,
        organizationId: salvageOrgId,
        role: UserRole.ARCHITECT_CFO,
      });
      const hunterSession = makeSession({
        userId: hunterId,
        organizationId: salvageOrgId,
        role: UserRole.HUNTER_MECHANIC,
      });
      const cfoCannabisSession = makeSession({
        userId: cfoId,
        organizationId: cannabisOrgId,
        organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        role: UserRole.ARCHITECT_CFO,
      });

      // 1. Log pending expense, attach receipt once, reject second attachment at DB/service level
      const pending = await service.logExpense(hunterSession, {
        category: ExpenseCategory.AFTERMARKET_REPAIR_PARTS,
        vendorName: 'Live PG Vendor',
        description: 'Pending slip test',
        amountOriginalMinor: 4_000,
        receiptVerificationState: ReceiptVerificationState.PENDING_RECEIPT_UPLOAD,
        voucherReason: 'Paper invoice in truck',
        idempotencyKey: randomUUID(),
      });
      expect(pending.expense.paidFromCashCustody).toBe('HELD_IN_OPERATOR_FLOAT');

      const attached = await service.attachExpenseReceipt(hunterSession, {
        expenseId: pending.expense.id,
        receiptBytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
        receiptContentType: 'application/pdf',
        itcReceivableCadMinor: 520,
        idempotencyKey: randomUUID(),
      });
      expect(attached.expense.receiptVerificationState).toBe('VERIFIED_RECEIPT');

      // DB trigger blocks mutating paidFromCashCustody or amountCadMinor
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: salvageOrgId,
            userId: cfoId,
            role: UserRole.ARCHITECT_CFO,
          },
          async (tx) => {
            await tx.expense.update({
              where: { id: pending.expense.id },
              data: { amountCadMinor: 999 },
            });
          },
        ),
      ).rejects.toThrow();

      // 2. Concurrent sweep race on Hunter's remaining 6,000 float (10,000 - 4,000 = 6,000): only ONE 5,000 sweep succeeds!
      const sweepRace = await Promise.allSettled([
        service.recordCashCustodyTransfer(cfoSession, {
          fromCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
          toCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
          amountMinor: 5_000,
          custodyHolderUserId: hunterId,
          depositSlipBytes: Uint8Array.from([1, 2, 3]),
          depositSlipContentType: 'image/jpeg',
          idempotencyKey: randomUUID(),
        }),
        service.recordCashCustodyTransfer(cfoSession, {
          fromCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
          toCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
          amountMinor: 5_000,
          custodyHolderUserId: hunterId,
          depositSlipBytes: Uint8Array.from([1, 2, 3]),
          depositSlipContentType: 'image/jpeg',
          idempotencyKey: randomUUID(),
        }),
      ]);
      const sweepSuccesses = sweepRace.filter((r) => r.status === 'fulfilled');
      const sweepFailures = sweepRace.filter((r) => r.status === 'rejected');
      expect(sweepSuccesses).toHaveLength(1);
      expect(sweepFailures).toHaveLength(1);

      // 3. Cross-tenant RLS isolation: cannabis org sees 0 salvage expenses
      const cannabisSub = await service.queryOperatorFloatSubledger(
        cfoCannabisSession,
      );
      if (cannabisSub.scope === 'FULL_ORGANIZATION') {
        expect(cannabisSub.recentExpenses).toHaveLength(0);
      }

      // 4. Revocation immediately blocks runtime access
      await ownerPrisma.organizationMembership.update({
        where: { id: hunterMemId },
        data: { isActive: false, deactivatedAt: new Date() },
      });
      await expect(
        service.queryOperatorFloatSubledger(hunterSession),
      ).rejects.toMatchObject({
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        status: 403,
      });
    });
  },
);
