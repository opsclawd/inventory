import { randomUUID } from 'node:crypto';
import {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  CurrencyCode,
  DomesticSaleChannel,
  ExpenseCategory,
  InventoryAvailabilityState,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  PaymentSettlementState,
  PrismaClient,
  ReceiptVerificationState,
  SaleMarketNode,
  TaxCollectionMode,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { DomainRuleError } from '@/core/domain';
import { StorageError } from '@/core/ports/storage.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import {
  buildPersistedLedgerProjection,
  type PersistedDonorPartRow,
  type PersistedDonorVehicleRow,
  type PersistedSaleLedgerRow,
  type PersistedSalePartItemRow,
  type PersistedScrapLedgerRow,
} from '@/modules/cfo-subledger/financial-snapshot.query';
import type {
  LockedDonorPartRow,
  LockedDonorVehicleRow,
} from '@/modules/dismantling/part-strip/part-strip.contracts';
import { AuthError } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import {
  InMemoryStorageAdapter,
  type StorageAuditEventInput,
  type StorageSecurityRepository,
} from '@/modules/shared-ops/storage';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import {
  type ActiveOrgMemberRecord,
  attachExpenseReceipt,
  createExpenseService,
  createProductionExpenseService,
  deriveIssue9CommandReceiptId,
  ExpenseError,
  type ExpenseRepository,
  type ExpenseTx,
  handleSharedExpensesGet,
  handleSharedExpensesPatch,
  handleSharedExpensesPost,
  LogExpenseUseCase,
  type LogExpenseResult,
  parseExpenseCommandReceiptNextState,
  type PersistAuditLogRecord,
  type PersistCashCustodyTransferRecord,
  type PersistOutboxEventRecord,
  settleDeferredAccrual,
  type StoredCashCustodyTransferRecord,
  type StoredExpenseRecord,
} from '../index';

const ORG_SALVAGE = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
const ORG_CANNABIS = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;
const CFO_USER = PHASE1A_SEED_IDS.users.architectCfo;
const HUNTER_1 = PHASE1A_SEED_IDS.users.hunterMechanic;
const HUNTER_2 = '20000000-0000-4000-8000-000000000099';
const STRIPPER_USER = PHASE1A_SEED_IDS.users.ontarioStripper;
const VAULT_ADMIN = PHASE1A_SEED_IDS.users.trinidadVaultAdmin;
const NURSERY_TECH = PHASE1A_SEED_IDS.users.nurseryTech;

function makeSession(params: {
  userId: string;
  organizationId?: string;
  organizationType?: OrganizationType;
  role: UserRole;
  aal?: 'aal1' | 'aal2';
}) {
  const orgId = params.organizationId ?? ORG_SALVAGE;
  const orgType = params.organizationType ?? OrganizationType.SALVAGE_AND_EXPORT;
  return createAuthSessionContext({
    userId: params.userId,
    activeOrganizationId: orgId,
    role: params.role,
    activeOrganizationType: orgType,
    activeMemberships: [
      {
        membershipId: randomUUID(),
        organizationId: orgId,
        organizationSlug:
          orgType === OrganizationType.SALVAGE_AND_EXPORT
            ? 'ORG_SALVAGE_EXPORT'
            : 'ORG_CANNABIS_NURSERY_PROC',
        organizationName: 'Test Org',
        organizationType: orgType,
        role: params.role,
        isDefaultWorkspace: true,
      },
    ],
    aal: params.aal ?? 'aal2',
    mfaEnrolled: true,
  });
}

function membershipKey(orgId: string, userId: string): string {
  return `${orgId.toLowerCase()}:${userId.toLowerCase()}`;
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  const copy = new Map<K, V>();
  for (const [k, v] of source.entries()) {
    copy.set(k, structuredClone(v));
  }
  return copy;
}

interface InMemoryExpenseStore {
  now: Date;
  activeMembers: Map<string, ActiveOrgMemberRecord>;
  policyOverrides: Map<string, Record<string, unknown> | null>;
  vehicles: Map<string, LockedDonorVehicleRow>;
  parts: Map<string, LockedDonorPartRow>;
  shipments: Map<string, { id: string; organizationId: string }>;
  sales: Map<string, PersistedSaleLedgerRow>;
  salePartItems: PersistedSalePartItemRow[];
  scrapLogs: Map<string, PersistedScrapLedgerRow>;
  expenses: Map<string, StoredExpenseRecord>;
  transfers: Map<string, StoredCashCustodyTransferRecord>;
  auditLogs: Map<string, PersistAuditLogRecord>;
  outboxEvents: Map<string, PersistOutboxEventRecord>;
  storageAudits: StorageAuditEventInput[];
  revokeOnNextCommitFor?: string;
  failNextInsertOutbox?: boolean;
}

function createInMemoryExpenseHarness() {
  const store: InMemoryExpenseStore = {
    now: new Date('2026-11-16T12:00:00.000Z'),
    activeMembers: new Map([
      [
        membershipKey(ORG_SALVAGE, CFO_USER),
        {
          userId: CFO_USER,
          organizationId: ORG_SALVAGE,
          fullName: 'Architect CFO',
          role: UserRole.ARCHITECT_CFO,
          isActive: true,
        },
      ],
      [
        membershipKey(ORG_SALVAGE, HUNTER_1),
        {
          userId: HUNTER_1,
          organizationId: ORG_SALVAGE,
          fullName: 'Hunter One',
          role: UserRole.HUNTER_MECHANIC,
          isActive: true,
        },
      ],
      [
        membershipKey(ORG_SALVAGE, HUNTER_2),
        {
          userId: HUNTER_2,
          organizationId: ORG_SALVAGE,
          fullName: 'Hunter Two',
          role: UserRole.HUNTER_MECHANIC,
          isActive: true,
        },
      ],
      [
        membershipKey(ORG_SALVAGE, STRIPPER_USER),
        {
          userId: STRIPPER_USER,
          organizationId: ORG_SALVAGE,
          fullName: 'Ontario Stripper',
          role: UserRole.ONTARIO_STRIPPER,
          isActive: true,
        },
      ],
      [
        membershipKey(ORG_SALVAGE, VAULT_ADMIN),
        {
          userId: VAULT_ADMIN,
          organizationId: ORG_SALVAGE,
          fullName: 'Vault Admin',
          role: UserRole.TRINIDAD_VAULT_ADMIN,
          isActive: true,
        },
      ],
      [
        membershipKey(ORG_CANNABIS, CFO_USER),
        {
          userId: CFO_USER,
          organizationId: ORG_CANNABIS,
          fullName: 'Architect CFO',
          role: UserRole.ARCHITECT_CFO,
          isActive: true,
        },
      ],
      [
        membershipKey(ORG_CANNABIS, NURSERY_TECH),
        {
          userId: NURSERY_TECH,
          organizationId: ORG_CANNABIS,
          fullName: 'Nursery Tech',
          role: UserRole.NURSERY_CULTIVATION_TECH,
          isActive: true,
        },
      ],
    ]),
    policyOverrides: new Map([
      [ORG_SALVAGE, null],
      [ORG_CANNABIS, null],
    ]),
    vehicles: new Map(),
    parts: new Map(),
    shipments: new Map(),
    sales: new Map(),
    salePartItems: [],
    scrapLogs: new Map(),
    expenses: new Map(),
    transfers: new Map(),
    auditLogs: new Map(),
    outboxEvents: new Map(),
    storageAudits: [],
  };

  let lockChain: Promise<void> = Promise.resolve();

  const repository: ExpenseRepository = {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: ExpenseTx) => Promise<T>,
    ): Promise<T> {
      const runTx = async (): Promise<T> => {
        const mKey = membershipKey(ctx.organizationId, ctx.userId);
        const activeMember = store.activeMembers.get(mKey);
        if (!activeMember || !activeMember.isActive) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Active organization membership is revoked or inactive.',
          );
        }

        const snapVehicles = cloneMap(store.vehicles);
        const snapParts = cloneMap(store.parts);
        const snapExpenses = cloneMap(store.expenses);
        const snapTransfers = cloneMap(store.transfers);
        const snapAudits = cloneMap(store.auditLogs);
        const snapOutbox = cloneMap(store.outboxEvents);

        const tx: ExpenseTx = {
          async acquireOrganizationLock(organizationId: string): Promise<void> {
            if (
              store.revokeOnNextCommitFor ===
              membershipKey(organizationId, ctx.userId)
            ) {
              store.activeMembers.delete(store.revokeOnNextCommitFor);
              store.revokeOnNextCommitFor = undefined;
              throw new AuthError(
                'MEMBERSHIP_REVOKED_OR_INACTIVE',
                'Membership revoked prior to commit.',
              );
            }
          },
          async readOrganizationPolicyRecord(organizationId: string) {
            if (!store.policyOverrides.has(organizationId)) {
              return null;
            }
            return {
              organizationId,
              policyConfigJson: store.policyOverrides.get(organizationId) ?? null,
            };
          },
          async findCommandReceipt(organizationId, receiptAuditId) {
            const audit = store.auditLogs.get(receiptAuditId);
            if (!audit || audit.organizationId !== organizationId) {
              return null;
            }
            return parseExpenseCommandReceiptNextState(audit.id, audit.nextState);
          },
          async findExpenseByIdempotencyKey(organizationId, idempotencyKey) {
            for (const exp of store.expenses.values()) {
              if (
                exp.organizationId === organizationId &&
                exp.idempotencyKey === idempotencyKey
              ) {
                return structuredClone(exp);
              }
            }
            return null;
          },
          async findTransferByIdempotencyKey(organizationId, idempotencyKey) {
            for (const tr of store.transfers.values()) {
              if (
                tr.organizationId === organizationId &&
                tr.idempotencyKey === idempotencyKey
              ) {
                return structuredClone(tr);
              }
            }
            return null;
          },
          async findVerifiedEvidenceMetadata(organizationId, storageKey) {
            for (const a of store.storageAudits) {
              if (
                a.organizationId === organizationId &&
                a.entityType === 'PRIVATE_EVIDENCE' &&
                a.entityId === storageKey &&
                a.action === 'PRIVATE_EVIDENCE_UPLOADED'
              ) {
                return {
                  storageKey,
                  sha256Hash: String(a.nextState.sha256Hash),
                };
              }
            }
            return null;
          },
          async findActiveOrgMember(organizationId, userId) {
            const m = store.activeMembers.get(membershipKey(organizationId, userId));
            return m && m.isActive ? structuredClone(m) : null;
          },
          async listActiveOrgMembers(organizationId) {
            return [...store.activeMembers.values()]
              .filter((m) => m.organizationId === organizationId && m.isActive)
              .map((m) => structuredClone(m));
          },
          async findAndLockVehicle(organizationId, vehicleId) {
            const v = store.vehicles.get(vehicleId);
            return v && v.organizationId === organizationId
              ? structuredClone(v)
              : null;
          },
          async findAndLockDonorParts(organizationId, donorVehicleId) {
            return [...store.parts.values()]
              .filter(
                (p) =>
                  p.organizationId === organizationId &&
                  p.donorVehicleId === donorVehicleId,
              )
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((p) => structuredClone(p));
          },
          async shipmentExists(organizationId, shipmentId) {
            const s = store.shipments.get(shipmentId);
            return Boolean(s && s.organizationId === organizationId);
          },
          async findAndLockExpense(organizationId, expenseId) {
            const e = store.expenses.get(expenseId);
            return e && e.organizationId === organizationId
              ? structuredClone(e)
              : null;
          },
          async findTransferById(organizationId, transferId) {
            const t = store.transfers.get(transferId);
            return t && t.organizationId === organizationId
              ? structuredClone(t)
              : null;
          },
          async sumRollingOperatorVouchersCadMinor(
            organizationId,
            loggedByUserId,
            windowStart,
            windowEnd,
          ) {
            const vouchers = [...store.expenses.values()].filter(
              (e) =>
                e.organizationId === organizationId &&
                e.loggedByUserId === loggedByUserId &&
                e.receiptVerificationState === 'PETTY_CASH_VOUCHER' &&
                !e.isReversalEntry &&
                e.createdAt >= windowStart &&
                e.createdAt <= windowEnd,
            );
            let sum = 0;
            for (const v of vouchers) {
              const reversed = [...store.expenses.values()]
                .filter(
                  (r) =>
                    r.organizationId === organizationId &&
                    r.isReversalEntry &&
                    r.reversesExpenseId === v.id,
                )
                .reduce((acc, r) => acc + r.amountCadMinor, 0);
              sum += Math.max(0, v.amountCadMinor - reversed);
            }
            return sum;
          },
          async hasUnreversedPieceRatePayoutForVehicle(organizationId, vehicleId) {
            let net = 0;
            for (const e of store.expenses.values()) {
              if (
                e.organizationId === organizationId &&
                e.vehicleId === vehicleId &&
                e.category === 'YARD_STRIPPER_PIECE_RATE'
              ) {
                net += e.isReversalEntry ? -e.amountCadMinor : e.amountCadMinor;
              }
            }
            return net > 0;
          },
          async hasReversalForExpense(organizationId, expenseId) {
            return [...store.expenses.values()].some(
              (e) =>
                e.organizationId === organizationId &&
                e.isReversalEntry &&
                e.reversesExpenseId === expenseId,
            );
          },
          async loadPersistedSnapshot(organizationId, policy) {
            const saleRows = [...store.sales.values()].filter(
              (s) => s.organizationId === organizationId,
            );
            const scrapRows = [...store.scrapLogs.values()].filter(
              (s) => s.organizationId === organizationId,
            );
            const transferRows = [...store.transfers.values()].filter(
              (t) => t.organizationId === organizationId,
            );
            const expenseRows = [...store.expenses.values()].filter(
              (e) => e.organizationId === organizationId,
            );
            const vehicleRows: PersistedDonorVehicleRow[] = [
              ...store.vehicles.values(),
            ]
              .filter((v) => v.organizationId === organizationId)
              .map((v) => ({
                id: v.id,
                organizationId: v.organizationId,
                actualPurchasePriceCadMinor: v.actualPurchasePriceCadMinor,
                scrapRecoveryCadMinor: v.scrapRecoveryCadMinor,
              }));
            const partRows: PersistedDonorPartRow[] = [...store.parts.values()]
              .filter((p) => p.organizationId === organizationId)
              .map((p) => ({
                id: p.id,
                donorVehicleId: p.donorVehicleId,
                compBaselineCadMinor: p.compBaselineCadMinor,
                availabilityState: p.availabilityState,
                custodyState: p.custodyState,
              }));
            const saleIds = new Set(saleRows.map((s) => s.id));
            const salePartItemRows = store.salePartItems.filter((item) =>
              saleIds.has(item.saleTransactionId),
            );
            return buildPersistedLedgerProjection({
              organizationId,
              policy,
              saleRows,
              scrapRows,
              transferRows,
              settlementRows: [],
              expenseRows,
              vehicleRows,
              partRows,
              salePartItemRows,
            });
          },
          async loadTrancheLiveCounts(organizationId, overdueCutoff) {
            const shelvedSkusCount = [...store.parts.values()].filter(
              (p) =>
                p.organizationId === organizationId &&
                p.custodyState === PartCustodyState.SHELVED_ORIGIN_CONTAINER &&
                p.availabilityState !== InventoryAvailabilityState.RETURNED_QC_HOLD,
            ).length;
            const scrappedDonorsCount = [...store.vehicles.values()].filter(
              (v) =>
                v.organizationId === organizationId &&
                v.lifecycleState === AssetLifecycleState.SCRAPPED_METAL_CLEARED,
            ).length;
            const overdueFloatReceiptsCount = [
              ...store.expenses.values(),
            ].filter(
              (e) =>
                e.organizationId === organizationId &&
                e.receiptVerificationState ===
                  ReceiptVerificationState.PENDING_RECEIPT_UPLOAD &&
                e.category !== ExpenseCategory.PARTNER_TIME_LOG_MEMO &&
                !e.isReversalEntry &&
                e.createdAt <= overdueCutoff,
            ).length;
            return {
              shelvedSkusCount,
              scrappedDonorsCount,
              overdueFloatReceiptsCount,
            };
          },
          async listExpenses(organizationId, opts) {
            return [...store.expenses.values()]
              .filter((e) => e.organizationId === organizationId)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .slice(0, opts?.limit ?? 200)
              .map((e) => structuredClone(e));
          },
          async listCashCustodyTransfers(organizationId, opts) {
            return [...store.transfers.values()]
              .filter((t) => t.organizationId === organizationId)
              .sort((a, b) => b.transferredAt.getTime() - a.transferredAt.getTime())
              .slice(0, opts?.limit ?? 100)
              .map((t) => structuredClone(t));
          },
          async insertExpense(record) {
            for (const existing of store.expenses.values()) {
              if (
                existing.organizationId === record.organizationId &&
                existing.idempotencyKey === record.idempotencyKey
              ) {
                throw { code: 'P2002' };
              }
            }
            store.expenses.set(record.id, {
              ...record,
              cannabisLotId: null,
              isReversalEntry: false,
              reversesExpenseId: null,
            });
          },
          async updateExpenseReceipt(update) {
            const existing = store.expenses.get(update.expenseId);
            if (!existing || existing.organizationId !== update.organizationId) {
              throw new Error('Missing expense');
            }
            store.expenses.set(update.expenseId, {
              ...existing,
              receiptVerificationState:
                ReceiptVerificationState.VERIFIED_RECEIPT,
              receiptStorageKey: update.receiptStorageKey,
              receiptSha256Hash: update.receiptSha256Hash,
              itcReceivableCadMinor: update.itcReceivableCadMinor,
            });
          },
          async settleExpenseDeferredAccrual(update) {
            const existing = store.expenses.get(update.expenseId);
            if (!existing || existing.organizationId !== update.organizationId) {
              throw new Error('Missing expense');
            }
            store.expenses.set(update.expenseId, {
              ...existing,
              accrualSettledAt: update.accrualSettledAt,
              paidFromCashCustody: update.paidFromCashCustody,
              custodyHolderUserId: update.custodyHolderUserId,
            });
          },
          async insertCashCustodyTransfer(record) {
            for (const existing of store.transfers.values()) {
              if (
                existing.organizationId === record.organizationId &&
                existing.idempotencyKey === record.idempotencyKey
              ) {
                throw { code: 'P2002' };
              }
            }
            store.transfers.set(record.id, structuredClone(record));
          },
          async insertAuditLog(record) {
            store.auditLogs.set(record.id, structuredClone(record));
          },
          async insertOutboxEvent(record) {
            if (store.failNextInsertOutbox) {
              store.failNextInsertOutbox = false;
              throw new Error('Simulated DB outbox failure');
            }
            store.outboxEvents.set(record.id, structuredClone(record));
          },
        };

        try {
          return await fn(tx);
        } catch (err) {
          store.vehicles = snapVehicles;
          store.parts = snapParts;
          store.expenses = snapExpenses;
          store.transfers = snapTransfers;
          store.auditLogs = snapAudits;
          store.outboxEvents = snapOutbox;
          throw err;
        }
      };

      const next = lockChain.then(runTx, runTx);
      lockChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };

  const securityRepo: StorageSecurityRepository = {
    async verifyActiveTenantAccess(ctx) {
      const m = store.activeMembers.get(
        membershipKey(ctx.organizationId, ctx.userId),
      );
      if (!m || !m.isActive) {
        throw new AuthError(
          'MEMBERSHIP_REVOKED_OR_INACTIVE',
          'Membership revoked.',
        );
      }
    },
    async recordPrivateEvidenceAudit(ctx, event) {
      const m = store.activeMembers.get(
        membershipKey(ctx.organizationId, ctx.userId),
      );
      if (!m || !m.isActive) {
        throw new AuthError(
          'MEMBERSHIP_REVOKED_OR_INACTIVE',
          'Membership revoked.',
        );
      }
      store.storageAudits.push(event);
    },
  };

  const storage = new InMemoryStorageAdapter({
    securityRepository: securityRepo,
    clock: { now: () => store.now },
  });

  const service = createExpenseService({
    repository,
    storage,
    clock: { now: () => store.now },
  });

  return { store, repository, storage, service };
}

function addDonorWithParts(
  store: InMemoryExpenseStore,
  vehicleId: string,
  opts: { drained: boolean; partCount: number; compBaseline?: number | null },
) {
  store.vehicles.set(vehicleId, {
    id: vehicleId,
    organizationId: ORG_SALVAGE,
    internalStockNumber: `AST-${vehicleId.slice(0, 6)}`,
    assetCategory: AssetCategory.AUTOMOBILE,
    operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
    lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
    actualPurchasePriceCadMinor: 200_000,
    targetGrossRealizationMinor: 500_000,
    fluidsDrainedAt: opts.drained ? new Date('2026-11-10T10:00:00.000Z') : null,
    catalyticConverterDisposition:
      CatalyticConverterDisposition.PRESENT_AT_INTAKE,
    scrapMetalTicketKey: null,
    scrapRecoveryCadMinor: 0,
    scrappedClearedAt: null,
    complianceWarnings: [],
    version: 1,
  });

  for (let i = 0; i < opts.partCount; i += 1) {
    const partId = randomUUID();
    store.parts.set(partId, {
      id: partId,
      organizationId: ORG_SALVAGE,
      donorVehicleId: vehicleId,
      qrSkuCode: `PRT-${String(100000 + i)}`,
      custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
      availabilityState: InventoryAvailabilityState.AVAILABLE,
      ebaySyncState: 'NOT_LISTED',
      classifiedsSyncState: 'NOT_POSTED',
      complianceState: PartComplianceState.CLEARED_FOR_SALE,
      partCategoryName: 'Alternator',
      tdgHazmatCode: TdgHazmatCode.NONE,
      araGrade: 'GRADE_B1',
      compBaselineCadMinor:
        opts.compBaseline === undefined ? 15_000 : opts.compBaseline,
      allocatedCostBasisCadMinor: 5_000,
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
      currentLocationBarcode: 'KEMP-C01-R01-S01-B01',
      rawPhotoUrls: ['https://media.storage.invalid/org/media/a.webp'],
      complianceWarnings: [],
      hasActiveSale: false,
      version: 1,
    });
  }
}

describe('Issue 09: Tiered Expenses, Deferred Accruals, Float Sweeps & 7-Metric Subledger', () => {
  it('(a) enforces VERIFIED_RECEIPT evidence, rejects non-private/foreign/unverified keys, and captures ITC only when isGstHstRegistered === true', async () => {
    const { store, storage, service } = createInMemoryExpenseHarness();
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    // Missing receipt -> 422 RECEIPT_REQUIRED
    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'NAPA Kemptville',
        description: 'Brake caliper hardware',
        amountOriginalMinor: 8_000,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RECEIPT_REQUIRED', status: 422 });

    // Public media key or foreign-org key rejected
    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'NAPA',
        description: 'Public URL spoof',
        amountOriginalMinor: 8_000,
        receiptStorageKey: `${ORG_SALVAGE}/media/${randomUUID()}.webp`,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(StorageError);

    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'NAPA',
        description: 'Foreign org key',
        amountOriginalMinor: 8_000,
        receiptStorageKey: `${ORG_CANNABIS}/evidence/${randomUUID()}`,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_KEY_FORBIDDEN', status: 403 });

    // Unregistered canonical-looking key without PRIVATE_EVIDENCE_UPLOADED audit -> 422 INVALID_EVIDENCE_KEY
    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'NAPA',
        description: 'Unverified key',
        amountOriginalMinor: 8_000,
        receiptStorageKey: `${ORG_SALVAGE}/evidence/${randomUUID()}`,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE_KEY', status: 422 });

    // Valid private upload captures supplied ITC when registered
    const receiptBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
    const logged = await service.logExpense(hunter, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Canadian Tire',
      description: 'Impact sockets',
      amountOriginalMinor: 10_000,
      itcReceivableCadMinor: 1_300,
      receiptBytes,
      receiptContentType: 'image/jpeg',
      idempotencyKey: randomUUID(),
    });
    expect(logged.expense.receiptVerificationState).toBe('VERIFIED_RECEIPT');
    expect(logged.expense.hasReceiptEvidence).toBe(true);
    expect(logged.expense.receiptSha256Hash).toMatch(/^[0-9a-f]{64}$/);
    expect(logged.expense.itcReceivableCadMinor).toBe(1_300);

    // When isGstHstRegistered === false -> ITC forced to 0
    store.policyOverrides.set(ORG_SALVAGE, {
      domesticTaxPolicy: {
        isGstHstRegistered: false,
        isOntarioEntityHstRegistered: false,
        isOntarioHstRegistered: false,
      },
    });
    const uploaded = await storage.uploadPrivateEvidence({
      actor: cfo,
      organizationId: ORG_SALVAGE,
      evidence: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'application/pdf',
    });
    const unregisteredRes = await service.logExpense(cfo, {
      category: 'TOWING_AND_RECOVERY',
      vendorName: 'Rideau Tow',
      description: 'Flatbed haul',
      amountOriginalMinor: 20_000,
      itcReceivableCadMinor: 2_600,
      receiptStorageKey: uploaded.storageKey,
      idempotencyKey: randomUUID(),
    });
    expect(unregisteredRes.expense.itcReceivableCadMinor).toBe(0);
    expect(unregisteredRes.warnings).toContain(
      'ITC_FORCED_ZERO_UNREGISTERED_OR_UNVERIFIED',
    );
  });

  it('(b) enforces PETTY_CASH_VOUCHER $50 item limit, >=5-char reason, and rolling 30-day $250/mo cap with CFO override', async () => {
    const { store, service } = createInMemoryExpenseHarness();
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    // 5001 rejected
    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Local Hardware',
        description: 'Fasteners',
        amountOriginalMinor: 5_001,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Bolts and washers for shop',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'VOUCHER_AMOUNT_EXCEEDS_MAX', status: 422 });

    // 4-char trimmed reason rejected
    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Local Hardware',
        description: 'Fasteners',
        amountOriginalMinor: 5_000,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: '  abcd  ',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'VOUCHER_REASON_REQUIRED', status: 422 });

    // 5 x $50 = $250.00 allowed (forces ITC = 0)
    for (let i = 0; i < 5; i += 1) {
      const res = await service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Local Hardware',
        description: `Shop supplies #${i + 1}`,
        amountOriginalMinor: 5_000,
        itcReceivableCadMinor: 650,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Emergency shop consumables',
        // Attempting backdated incurredAt does not evade createdAt rolling cap
        incurredAt: '2026-01-01T00:00:00.000Z',
        idempotencyKey: randomUUID(),
      });
      expect(res.expense.itcReceivableCadMinor).toBe(0);
      expect(res.rolling30DayVoucherUsedCadMinor).toBe((i + 1) * 5_000);
    }

    // $250.01 rejected for hunter even with forged cfoOverride
    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Local Hardware',
        description: 'Exceeds cap',
        amountOriginalMinor: 1,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Small bolt purchase',
        cfoOverride: {
          approved: true,
          approvedById: CFO_USER,
          approverRole: 'ARCHITECT_CFO',
          reasonNote: 'Forged by hunter',
        },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CFO_OVERRIDE_UNAUTHORIZED' });

    await expect(
      service.logExpense(hunter, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Local Hardware',
        description: 'Exceeds cap',
        amountOriginalMinor: 1,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Small bolt purchase',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'MONTHLY_VOUCHER_CAP_EXCEEDED', status: 422 });

    // Other operator (HUNTER_2) has independent 30-day cap
    const hunter2 = makeSession({ userId: HUNTER_2, role: UserRole.HUNTER_MECHANIC });
    const h2Res = await service.logExpense(hunter2, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Local Hardware',
      description: 'Independent operator cap',
      amountOriginalMinor: 5_000,
      receiptVerificationState: 'PETTY_CASH_VOUCHER',
      voucherReason: 'Zip ties and heat shrink',
      idempotencyKey: randomUUID(),
    });
    expect(h2Res.rolling30DayVoucherUsedCadMinor).toBe(5_000);

    // CFO cap override succeeds for >$250 when CFO approves with reason
    for (let i = 0; i < 5; i += 1) {
      await service.logExpense(cfo, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Local Hardware',
        description: `CFO voucher #${i + 1}`,
        amountOriginalMinor: 5_000,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Shop consumables batch',
        idempotencyKey: randomUUID(),
      });
    }
    const cfoOverCap = await service.logExpense(cfo, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Local Hardware',
      description: 'Over monthly cap with CFO approval',
      amountOriginalMinor: 2_500,
      receiptVerificationState: 'PETTY_CASH_VOUCHER',
      voucherReason: 'Approved emergency petty cash',
      cfoOverride: {
        approved: true,
        reasonNote: 'Approved overrun for urgent yard prep',
      },
      idempotencyKey: randomUUID(),
    });
    expect(cfoOverCap.cfoOverrideApplied).toBe(true);
    expect(cfoOverCap.warnings).toContain('MONTHLY_VOUCHER_CAP_OVERRIDDEN');

    // Advancing clock past 30 days frees hunter's rolling cap
    store.now = new Date(store.now.getTime() + 31 * 24 * 60 * 60 * 1000);
    const after30Days = await service.logExpense(hunter, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Local Hardware',
      description: 'New rolling window',
      amountOriginalMinor: 5_000,
      receiptVerificationState: 'PETTY_CASH_VOUCHER',
      voucherReason: 'New month shop supplies',
      idempotencyKey: randomUUID(),
    });
    expect(after30Days.rolling30DayVoucherUsedCadMinor).toBe(5_000);
  });

  it('(c) transitions PENDING_RECEIPT_UPLOAD -> VERIFIED_RECEIPT once without charging cash twice, and fails closed on revocation', async () => {
    const { store, storage, service, repository } = createInMemoryExpenseHarness();
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });
    const hunter2 = makeSession({ userId: HUNTER_2, role: UserRole.HUNTER_MECHANIC });
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    // Seed $200 cash sale in Hunter 1's float
    store.sales.set('sale-cash-h1', {
      id: 'sale-cash-h1',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 20_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 20_000,
      netRealizedCadMinor: 20_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: HUNTER_1,
      isVoidedOrReversed: false,
    });

    const pending = await service.logExpense(hunter, {
      category: 'TOWING_AND_RECOVERY',
      vendorName: 'Field Tow Co',
      description: 'Roadside tow paid in cash awaiting paper slip',
      amountOriginalMinor: 10_000,
      receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
      voucherReason: 'Driver left invoice at yard',
      idempotencyKey: randomUUID(),
    });
    // Defaults to HELD_IN_OPERATOR_FLOAT for Hunter 1 -> float drops 20,000 -> 10,000 immediately
    expect(pending.expense.paidFromCashCustody).toBe('HELD_IN_OPERATOR_FLOAT');
    expect(pending.expense.custodyHolderUserId).toBe(HUNTER_1);

    const beforeAttach = await service.queryOperatorFloatSubledger(cfo);
    expect(beforeAttach.scope).toBe('FULL_ORGANIZATION');
    if (beforeAttach.scope === 'FULL_ORGANIZATION') {
      expect(beforeAttach.runningOperatorFloatCadMinor).toBe(10_000);
      expect(beforeAttach.verifiedItcReceivableCadMinor).toBe(0);
      expect(beforeAttach.pendingReceiptExpenses).toHaveLength(1);
    }

    // Hunter 2 cannot attach receipt to Hunter 1's row
    const h2Evidence = await storage.uploadPrivateEvidence({
      actor: hunter2,
      organizationId: ORG_SALVAGE,
      evidence: Uint8Array.from([9, 8, 7]),
      contentType: 'image/png',
    });
    await expect(
      service.attachExpenseReceipt(hunter2, {
        expenseId: pending.expense.id,
        receiptStorageKey: h2Evidence.storageKey,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', status: 403 });

    // Attach receipt with $13.00 ITC using exact idempotencyKey + test replay & conflict
    const attachKey = randomUUID();
    const h1Evidence = await storage.uploadPrivateEvidence({
      actor: hunter,
      organizationId: ORG_SALVAGE,
      evidence: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'image/jpeg',
    });
    const useCase = new LogExpenseUseCase({ repository, storage, clock: { now: () => store.now } });
    const attached = await attachExpenseReceipt(
      useCase,
      hunter,
      pending.expense.id,
      h1Evidence.storageKey,
      1_300,
      { idempotencyKey: attachKey },
    );
    expect(attached.expense.receiptVerificationState).toBe('VERIFIED_RECEIPT');
    expect(attached.expense.itcReceivableCadMinor).toBe(1_300);

    // Matching replay returns original result
    const replayed = await attachExpenseReceipt(
      useCase,
      hunter,
      pending.expense.id,
      h1Evidence.storageKey,
      1_300,
      { idempotencyKey: attachKey },
    );
    expect(replayed.replayed).toBe(true);

    // Conflicting second attachment on same expense fails with 409 EXPENSE_RECEIPT_ALREADY_ATTACHED
    await expect(
      service.attachExpenseReceipt(hunter, {
        expenseId: pending.expense.id,
        receiptStorageKey: h1Evidence.storageKey,
        itcReceivableCadMinor: 500,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'EXPENSE_RECEIPT_ALREADY_ATTACHED',
      status: 409,
    });

    // Float remains 10,000 (cash was NOT charged twice!), verified ITC increased to 1,300
    const afterAttach = await service.queryOperatorFloatSubledger(cfo);
    if (afterAttach.scope === 'FULL_ORGANIZATION') {
      expect(afterAttach.runningOperatorFloatCadMinor).toBe(10_000);
      expect(afterAttach.verifiedItcReceivableCadMinor).toBe(1_300);
      expect(afterAttach.pendingReceiptExpenses).toHaveLength(0);
    }

    // Membership revoked between upload & commit denies access
    const pending2 = await service.logExpense(hunter, {
      category: 'TOWING_AND_RECOVERY',
      vendorName: 'Field Tow 2',
      description: 'Second pending',
      amountOriginalMinor: 5_000,
      receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
      voucherReason: 'Pending receipt upload',
      idempotencyKey: randomUUID(),
    });
    store.revokeOnNextCommitFor = membershipKey(ORG_SALVAGE, HUNTER_1);
    await expect(
      service.attachExpenseReceipt(hunter, {
        expenseId: pending2.expense.id,
        receiptBytes: Uint8Array.from([5, 6, 7]),
        receiptContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      status: 403,
    });
  });

  it('(d) records generic ITA s. 78(1) deferred accruals without draining bank cash until settled once', async () => {
    const { store, service, repository } = createInMemoryExpenseHarness();
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    // Realized bank sale of $500 so profit pool & bank cash exist
    store.sales.set('sale-bank-500', {
      id: 'sale-bank-500',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.FB_MARKETPLACE_LOCAL,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 50_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 50_000,
      netRealizedCadMinor: 50_000,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-01T10:00:00.000Z'),
      bankDepositReference: 'INT-500',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });

    const accrual = await service.logExpense(cfo, {
      category: 'STEAM_CLEANING_EXPORT_PREP',
      vendorName: 'Kemptville Industrial Yard Lessor',
      description: 'Monthly container pad lease accrual (ITA s. 78(1))',
      amountOriginalMinor: 10_000,
      isDeferredIntercompanyAccrual: true,
      receiptBytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
      receiptContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    expect(accrual.expense.isDeferredIntercompanyAccrual).toBe(true);
    expect(accrual.expense.accrualSettledAt).toBeNull();
    expect(accrual.expense.paidFromCashCustody).toBeNull();

    const beforeSettle = await service.queryOperatorFloatSubledger(cfo);
    if (beforeSettle.scope === 'FULL_ORGANIZATION') {
      // Bank cash unchanged ($22,000 tranche + $500 = $22,500), profit pool reduced ($500 - $100 = $400)
      expect(beforeSettle.confirmedCorpBankCashCadMinor).toBe(2_250_000);
      expect(beforeSettle.availableWorkingCapitalCadMinor).toBe(2_250_000);
      expect(beforeSettle.distributableRealizedProfitPoolCadMinor).toBe(40_000);
      expect(beforeSettle.deferredIntercompanyAccrualCadMinor).toBe(10_000);
    }

    // Hunter cannot settle deferred accrual
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });
    await expect(
      service.settleDeferredAccrual(hunter, {
        expenseId: accrual.expense.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', status: 403 });

    // CFO settles deferred accrual -> bank cash drops by $100 once, profit stays $400!
    const useCase = new LogExpenseUseCase({ repository, clock: { now: () => store.now } });
    const settled = await settleDeferredAccrual(useCase, cfo, accrual.expense.id, {
      paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
      idempotencyKey: randomUUID(),
    });
    expect(settled.expense.accrualSettledAt).not.toBeNull();
    expect(settled.expense.paidFromCashCustody).toBe('SETTLED_ORIGIN_CORP_BANK');

    const afterSettle = await service.queryOperatorFloatSubledger(cfo);
    if (afterSettle.scope === 'FULL_ORGANIZATION') {
      expect(afterSettle.confirmedCorpBankCashCadMinor).toBe(2_240_000);
      expect(afterSettle.availableWorkingCapitalCadMinor).toBe(2_240_000);
      expect(afterSettle.distributableRealizedProfitPoolCadMinor).toBe(40_000);
      expect(afterSettle.deferredIntercompanyAccrualCadMinor).toBe(0);
    }

    // Second settlement fails with 409 ACCRUAL_ALREADY_SETTLED
    await expect(
      service.settleDeferredAccrual(cfo, {
        expenseId: accrual.expense.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ACCRUAL_ALREADY_SETTLED', status: 409 });
  });

  it('(e & f) proves 7-metric separation (FIX 05), verified vs unverified ITC & refund normalization (FIX 06), donor margin isolation, and fail-closed sweeps', async () => {
    const { store, service } = createInMemoryExpenseHarness();
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    // 1. Pending eBay net payout $1,000 ($1,000 subtotal, $0 fee/ship, $130 platform tax, $170 unverified fee tax)
    store.sales.set('sale-ebay-pending', {
      id: 'sale-ebay-pending',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.MARKETPLACE_FACILITATOR_COLLECTED,
      subtotalMinor: 100_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null, // unreported -> null sum / incomplete indicator
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 1_700,
      itcReceivableCadMinor: 1_700, // Even if populated, isFeeTaxInvoiceVerified=false MUST ignore!
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 100_000,
      netRealizedCadMinor: 100_000,
      paymentSettlementState: PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
      cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });

    // 2. Pending direct e-Transfer $1,130 ($1,000 subtotal + $130 ON HST)
    store.sales.set('sale-etransfer-pending', {
      id: 'sale-etransfer-pending',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.FB_MARKETPLACE_LOCAL,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
      subtotalMinor: 100_000,
      taxOrVatMinor: 13_000,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 113_000,
      netRealizedCadMinor: 100_000,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_PENDING,
      cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });

    // 3. Physical cash walk-in $1,130 ($1,000 subtotal + $130 ON HST) held by Hunter 1
    store.sales.set('sale-cash-1130', {
      id: 'sale-cash-1130',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
      subtotalMinor: 100_000,
      taxOrVatMinor: 13_000,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 113_000,
      netRealizedCadMinor: 100_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: HUNTER_1,
      isVoidedOrReversed: false,
    });

    // 4. Donor vehicle with missing compBaselineCadMinor part -> emits warning, never enters bank cash
    const vehId = randomUUID();
    addDonorWithParts(store, vehId, {
      drained: true,
      partCount: 2,
      compBaseline: null,
    });

    const beforeSweep = await service.queryOperatorFloatSubledger(cfo);
    expect(beforeSweep.scope).toBe('FULL_ORGANIZATION');
    if (beforeSweep.scope === 'FULL_ORGANIZATION') {
      expect(beforeSweep.accountingRevenueCadMinor).toBe(300_000);
      expect(beforeSweep.grossSaleValueCadMinor).toBe(326_000);
      expect(beforeSweep.pendingExternalReceivablesCadMinor).toBe(213_000);
      expect(beforeSweep.runningOperatorFloatCadMinor).toBe(113_000);
      expect(beforeSweep.confirmedCorpBankCashCadMinor).toBe(2_200_000);
      expect(beforeSweep.directTaxCollectedNetOfRefundsCadMinor).toBe(26_000);
      expect(beforeSweep.buyerTaxRemittedByPlatformCadMinor).toBeNull();
      expect(beforeSweep.hasUnknownMarketplaceBuyerTax).toBe(true);
      expect(beforeSweep.unverifiedPlatformFeeTaxAccruedCadMinor).toBe(1_700);
      expect(beforeSweep.verifiedItcReceivableCadMinor).toBe(0);
      expect(beforeSweep.netHstTrustLiabilityCadMinor).toBe(26_000);
      expect(beforeSweep.availableWorkingCapitalCadMinor).toBe(2_174_000);
      expect(beforeSweep.estimatedDonorProfitCadMinor).toBe(-200_000);
      expect(beforeSweep.warnings).toContain('DONOR_MISSING_PART_COMP_BASELINE');
    }

    // Over-sweep (> 113,000) fails closed
    await expect(
      service.recordCashCustodyTransfer(cfo, {
        fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
        toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
        amountMinor: 113_001,
        custodyHolderUserId: HUNTER_1,
        depositSlipBytes: Uint8Array.from([1, 2, 3]),
        depositSlipContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_OPERATOR_FLOAT', status: 422 });

    // Destination vault sweep with 0 vault cash fails closed
    await expect(
      service.recordCashCustodyTransfer(cfo, {
        fromCustodyState: 'HELD_IN_DESTINATION_VAULT',
        toCustodyState: 'DEPOSITED_DESTINATION_BANK',
        currency: 'TTD',
        amountMinor: 50_000,
        equivalentCadMinor: 10_000,
        depositSlipBytes: Uint8Array.from([1, 2, 3]),
        depositSlipContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_VAULT_CASH', status: 422 });

    // Sweep $600 (60,000) from Hunter 1 float to corp bank
    const sweep = await service.recordCashCustodyTransfer(cfo, {
      fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
      toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
      amountMinor: 60_000,
      custodyHolderUserId: HUNTER_1,
      depositSlipBytes: Uint8Array.from([1, 2, 3, 4]),
      depositSlipContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    expect(sweep.transfer.equivalentCadMinor).toBe(60_000);

    const afterSweep = await service.queryOperatorFloatSubledger(cfo);
    if (afterSweep.scope === 'FULL_ORGANIZATION') {
      expect(afterSweep.runningOperatorFloatCadMinor).toBe(53_000);
      expect(afterSweep.confirmedCorpBankCashCadMinor).toBe(2_260_000);
      expect(afterSweep.availableWorkingCapitalCadMinor).toBe(2_234_000);
      // Accounting revenue & profit unaffected by sweep
      expect(afterSweep.accountingRevenueCadMinor).toBe(300_000);
      expect(afterSweep.distributableRealizedProfitPoolCadMinor).toBe(74_000);
    }

    // Add a verified eBay invoice sale + linked partial/full reversal SaleTransaction
    store.sales.set('sale-ebay-verified', {
      id: 'sale-ebay-verified',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.MARKETPLACE_FACILITATOR_COLLECTED,
      subtotalMinor: 50_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: 6_500,
      platformFeeMinor: 6_625,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 861,
      itcReceivableCadMinor: 861,
      isFeeTaxInvoiceVerified: true,
      feeTaxInvoiceStorageKey: `${ORG_SALVAGE}/evidence/${randomUUID()}`,
      grossCollectedMinor: 50_000,
      netRealizedCadMinor: 43_375,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-12T10:00:00.000Z'),
      bankDepositReference: 'EBAY-VER-1',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });
    // Refund $200 + $26 HST on sale-etransfer-pending? Wait: refund $100 + $13 HST from CORP_BANK on a confirmed bank sale
    store.sales.set('sale-bank-direct', {
      id: 'sale-bank-direct',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.WHOLESALE_MECHANIC_NETWORK,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
      subtotalMinor: 40_000,
      taxOrVatMinor: 5_200,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 45_200,
      netRealizedCadMinor: 40_000,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-12T11:00:00.000Z'),
      bankDepositReference: 'WIRE-DIRECT',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });
    store.sales.set('sale-bank-direct-rev', {
      id: 'sale-bank-direct-rev',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.WHOLESALE_MECHANIC_NETWORK,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
      subtotalMinor: 10_000,
      taxOrVatMinor: 1_300,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 11_300,
      netRealizedCadMinor: 10_000,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-13T11:00:00.000Z'),
      bankDepositReference: 'REV-DIRECT',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
      reversesSaleTxId: 'sale-bank-direct',
    });

    const afterTaxAndRefund = await service.queryOperatorFloatSubledger(cfo);
    if (afterTaxAndRefund.scope === 'FULL_ORGANIZATION') {
      // Direct tax: 13,000 + 13,000 + (5,200 - 1,300) = 29,900
      // Verified ITC: 861
      // Net trust: 29,039
      expect(afterTaxAndRefund.directTaxCollectedNetOfRefundsCadMinor).toBe(29_900);
      expect(afterTaxAndRefund.verifiedItcReceivableCadMinor).toBe(861);
      expect(afterTaxAndRefund.netHstTrustLiabilityCadMinor).toBe(29_039);
      expect(afterTaxAndRefund.buyerTaxRemittedByPlatformCadMinor).toBe(6_500);
      expect(afterTaxAndRefund.hasUnknownMarketplaceBuyerTax).toBe(true);
      // Bank cash: 2,260,000 + 43,375 (ebay) + 45,200 (direct) - 11,300 (refund) = 2,337,275
      expect(afterTaxAndRefund.confirmedCorpBankCashCadMinor).toBe(2_337_275);
      // Revenue: 300,000 + 50,000 + 40,000 - 10,000 = 380,000
      expect(afterTaxAndRefund.accountingRevenueCadMinor).toBe(380_000);
    }

    // Malformed reversal referencing missing sale fails closed
    store.sales.set('bad-rev', {
      id: 'bad-rev',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 1_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 1_000,
      netRealizedCadMinor: 1_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
      reversesSaleTxId: randomUUID(),
    });
    await expect(service.queryOperatorFloatSubledger(cfo)).rejects.toBeInstanceOf(
      DomainRuleError,
    );
  });

  it('(g) enforces RULE-PAY-001 piece-rate gates, zero-cash PARTNER_TIME_LOG_MEMO, and RULE-PAY-002/003 draw splits & reserve override', async () => {
    const { store, service } = createInMemoryExpenseHarness();
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });

    // Undrained donor with 35 parts fails piece rate
    const undrainedId = randomUUID();
    addDonorWithParts(store, undrainedId, { drained: false, partCount: 35 });
    await expect(
      service.logExpense(cfo, {
        category: 'YARD_STRIPPER_PIECE_RATE',
        vendorName: 'Ontario Stripper',
        description: 'Piece rate payout',
        amountOriginalMinor: 35_000,
        vehicleId: undrainedId,
        recipientUserId: STRIPPER_USER,
        receiptBytes: Uint8Array.from([1, 2, 3]),
        receiptContentType: 'application/pdf',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PIECE_RATE_GATE_UNMET', status: 422 });

    // Drained donor with 34 parts fails piece rate
    const parts34Id = randomUUID();
    addDonorWithParts(store, parts34Id, { drained: true, partCount: 34 });
    await expect(
      service.logExpense(cfo, {
        category: 'YARD_STRIPPER_PIECE_RATE',
        vendorName: 'Ontario Stripper',
        description: 'Piece rate payout',
        amountOriginalMinor: 35_000,
        vehicleId: parts34Id,
        recipientUserId: STRIPPER_USER,
        receiptBytes: Uint8Array.from([1, 2, 3]),
        receiptContentType: 'application/pdf',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PIECE_RATE_GATE_UNMET', status: 422 });

    // Drained donor with 35 parts succeeds once, rejects duplicate
    const parts35Id = randomUUID();
    addDonorWithParts(store, parts35Id, { drained: true, partCount: 35 });
    const pieceRate = await service.logExpense(cfo, {
      category: 'YARD_STRIPPER_PIECE_RATE',
      vendorName: 'Ontario Stripper',
      description: 'Piece rate payout',
      amountOriginalMinor: 35_000,
      vehicleId: parts35Id,
      recipientUserId: STRIPPER_USER,
      receiptBytes: Uint8Array.from([1, 2, 3]),
      receiptContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    expect(pieceRate.expense.amountCadMinor).toBe(35_000);

    await expect(
      service.logExpense(cfo, {
        category: 'YARD_STRIPPER_PIECE_RATE',
        vendorName: 'Ontario Stripper',
        description: 'Duplicate piece rate payout',
        amountOriginalMinor: 35_000,
        vehicleId: parts35Id,
        recipientUserId: STRIPPER_USER,
        receiptBytes: Uint8Array.from([1, 2, 3]),
        receiptContentType: 'application/pdf',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_PIECE_RATE_PAYOUT', status: 409 });

    // PARTNER_TIME_LOG_MEMO has zero cash/profit impact and is excluded from pending receipts queue
    const memo = await service.logExpense(hunter, {
      category: 'PARTNER_TIME_LOG_MEMO',
      vendorName: 'Hunter One',
      description: 'Shop teardown hours',
      amountOriginalMinor: 0,
      voucherReason: '6 hours teardown & rack prep',
      idempotencyKey: randomUUID(),
    });
    expect(memo.expense.isMemoOnly).toBe(true);
    expect(memo.expense.paidFromCashCustody).toBeNull();

    // Pending receivable alone cannot fund PARTNER_PROFIT_DRAW
    store.sales.set('pending-only', {
      id: 'pending-only',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.EBAY_MOTORS_SHIPPED,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.MARKETPLACE_FACILITATOR_COLLECTED,
      subtotalMinor: 100_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: 13_000,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 100_000,
      netRealizedCadMinor: 100_000,
      paymentSettlementState: PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING,
      cashCustodyState: CashCustodyState.PENDING_EXTERNAL_RECEIVABLE,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });

    await expect(
      service.logExpense(cfo, {
        category: 'PARTNER_PROFIT_DRAW',
        vendorName: 'Hunter One',
        description: 'Attempt draw from pending eBay',
        amountOriginalMinor: 10_000,
        recipientUserId: HUNTER_1,
        receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
        voucherReason: 'Quarterly draw memo',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_REALIZED_PROFIT_POOL',
      status: 422,
    });

    // Add realized profit: $500 bank sale + $40 cash held by Hunter 1 + $50 cash held by Hunter 2
    // Notice $350 piece-rate expense was already deducted from profit pool, so add $1,000 bank sale
    store.sales.set('bank-realized', {
      id: 'bank-realized',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.FB_MARKETPLACE_LOCAL,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 100_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 100_000,
      netRealizedCadMinor: 100_000,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-12T10:00:00.000Z'),
      bankDepositReference: 'BANK-1000',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });
    store.sales.set('h1-float-40', {
      id: 'h1-float-40',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 4_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 4_000,
      netRealizedCadMinor: 4_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: HUNTER_1,
      isVoidedOrReversed: false,
    });
    store.sales.set('h2-float-50', {
      id: 'h2-float-50',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 5_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 5_000,
      netRealizedCadMinor: 5_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: HUNTER_2,
      isVoidedOrReversed: false,
    });

    const preDrawSub = await service.queryOperatorFloatSubledger(cfo);
    let bankBeforeDraw = 0;
    let profitBeforeDraw = 0;
    if (preDrawSub.scope === 'FULL_ORGANIZATION') {
      bankBeforeDraw = preDrawSub.confirmedCorpBankCashCadMinor;
      profitBeforeDraw = preDrawSub.distributableRealizedProfitPoolCadMinor;
    }

    // CFO records $100 draw for Hunter 1 -> consumes $40 Hunter 1 float + $60 bank, $100 profit, leaves Hunter 2 float ($50) untouched
    const draw = await service.logExpense(cfo, {
      category: 'PARTNER_PROFIT_DRAW',
      vendorName: 'Hunter One',
      description: 'Profit draw split test',
      amountOriginalMinor: 10_000,
      recipientUserId: HUNTER_1,
      receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
      voucherReason: 'Authorized partner draw',
      idempotencyKey: randomUUID(),
    });
    expect(draw.expense.floatOffsetAppliedCadMinor).toBe(4_000);
    expect(draw.expense.recipientUserId).toBe(HUNTER_1);
    expect(draw.expense.loggedByUserId).toBe(CFO_USER);

    const postDrawSub = await service.queryOperatorFloatSubledger(cfo);
    if (postDrawSub.scope === 'FULL_ORGANIZATION') {
      expect(postDrawSub.operatorFloatByUserId[HUNTER_1]).toBe(0);
      expect(postDrawSub.operatorFloatByUserId[HUNTER_2]).toBe(5_000);
      expect(postDrawSub.confirmedCorpBankCashCadMinor).toBe(
        bankBeforeDraw - 6_000,
      );
      expect(postDrawSub.distributableRealizedProfitPoolCadMinor).toBe(
        profitBeforeDraw - 10_000,
      );
      // Memo is excluded from pending receipt queue!
      expect(
        postDrawSub.pendingReceiptExpenses.some(
          (e) => e.category === 'PARTNER_TIME_LOG_MEMO',
        ),
      ).toBe(false);
    }
  });

  it('(h) enforces cross-tenant isolation, role-restricted projections, rollback atomicity, HTTP route validation, and production composition', async () => {
    const { store, service, repository } = createInMemoryExpenseHarness();
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });
    const stripper = makeSession({
      userId: STRIPPER_USER,
      role: UserRole.ONTARIO_STRIPPER,
    });
    const vaultAdmin = makeSession({
      userId: VAULT_ADMIN,
      role: UserRole.TRINIDAD_VAULT_ADMIN,
    });
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });
    const cfoCannabis = makeSession({
      userId: CFO_USER,
      organizationId: ORG_CANNABIS,
      organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      role: UserRole.ARCHITECT_CFO,
    });

    // Hunter gets OWN_FLOAT_ONLY projection (never CFO bank/profit metrics)
    const hunterView = await service.queryOperatorFloatSubledger(hunter);
    expect(hunterView.scope).toBe('OWN_FLOAT_ONLY');
    expect('confirmedCorpBankCashCadMinor' in hunterView).toBe(false);

    // Stripper gets OWN_PIECE_RATE_ONLY projection
    const stripperView = await service.queryOperatorFloatSubledger(stripper);
    expect(stripperView.scope).toBe('OWN_PIECE_RATE_ONLY');

    // Vault admin can log PORT_DRAYAGE, blocked on non-port fees & blocked on GET subledger
    const portFee = await service.logExpense(vaultAdmin, {
      category: 'PORT_DRAYAGE',
      vendorName: 'POS Port Drayage',
      description: 'Container haul',
      amountOriginalMinor: 50_000,
      currencyOriginal: 'TTD',
      amountCadMinor: 10_000,
      receiptBytes: Uint8Array.from([1, 2, 3]),
      receiptContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    expect(portFee.expense.amountCadMinor).toBe(10_000);

    await expect(
      service.logExpense(vaultAdmin, {
        category: 'TOWING_AND_RECOVERY',
        vendorName: 'Forbidden Category',
        description: 'Not port fee',
        amountOriginalMinor: 5_000,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Should be rejected',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', status: 403 });

    await expect(
      service.queryOperatorFloatSubledger(vaultAdmin),
    ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', status: 403 });

    // Cross-tenant isolation: cannabis org cannot see salvage expenses
    const cannabisView = await service.queryOperatorFloatSubledger(cfoCannabis);
    if (cannabisView.scope === 'FULL_ORGANIZATION') {
      expect(cannabisView.recentExpenses).toHaveLength(0);
    }

    // Transaction failure rolls back expense, audit, and outbox
    const beforeRollbackCount = store.expenses.size;
    store.failNextInsertOutbox = true;
    await expect(
      service.logExpense(cfo, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Rollback Test',
        description: 'Should roll back',
        amountOriginalMinor: 2_000,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'Rollback test reason',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/Simulated DB outbox failure/);
    expect(store.expenses.size).toBe(beforeRollbackCount);

    // HTTP route handler tests: Idempotency-Key conflict (409), Origin check (403), GET subledger & evidence URL
    const idemKey = randomUUID();
    const postRes1 = await handleSharedExpensesPost(
      new Request('https://erp.local/api/shared/expenses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey,
          Origin: 'https://erp.local',
        },
        body: JSON.stringify({
          action: 'log-expense',
          category: 'AFTERMARKET_REPAIR_PARTS',
          vendorName: 'HTTP Route Parts',
          description: 'Route handler test',
          amountOriginalMinor: 3_000,
          receiptVerificationState: 'PETTY_CASH_VOUCHER',
          voucherReason: 'Shop consumables',
          idempotencyKey: idemKey,
        }),
      }),
      {
        resolveSession: async () => cfo,
        expenseService: service,
      },
    );
    expect(postRes1.status).toBe(201);
    const createdBody = (await postRes1.json()) as LogExpenseResult;

    // Changed payload with same Idempotency-Key -> 409 IDEMPOTENCY_KEY_REUSED
    const postResConflict = await handleSharedExpensesPost(
      new Request('https://erp.local/api/shared/expenses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey,
        },
        body: JSON.stringify({
          action: 'log-expense',
          category: 'AFTERMARKET_REPAIR_PARTS',
          vendorName: 'HTTP Route Parts',
          description: 'Mutated payload',
          amountOriginalMinor: 3_500,
          receiptVerificationState: 'PETTY_CASH_VOUCHER',
          voucherReason: 'Shop consumables',
        }),
      }),
      {
        resolveSession: async () => cfo,
        expenseService: service,
      },
    );
    expect(postResConflict.status).toBe(409);

    // Cross-origin mutation rejected
    const csrfRes = await handleSharedExpensesPatch(
      new Request('https://erp.local/api/shared/expenses', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({
          action: 'settle-accrual',
          expenseId: createdBody.expense.id,
        }),
      }),
      {
        resolveSession: async () => cfo,
        expenseService: service,
      },
    );
    expect(csrfRes.status).toBe(403);

    // GET subledger works with private/no-store cache headers
    const getRes = await handleSharedExpensesGet(
      new Request('https://erp.local/api/shared/expenses?view=subledger'),
      {
        resolveSession: async () => cfo,
        expenseService: service,
      },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0',
    );

    // Production factory composition works offline with injected Prisma mock
    const mockPrisma = {
      $transaction: async () => {
        throw new Error('Mock transaction invoked');
      },
    } as unknown as PrismaClient;
    const prodService = createProductionExpenseService({
      prisma: mockPrisma,
      storage: new InMemoryStorageAdapter({
        securityRepository: {
          verifyActiveTenantAccess: async () => {},
          recordPrivateEvidenceAudit: async () => {},
        },
      }),
    });
    expect(typeof prodService.logExpense).toBe('function');
    expect(typeof prodService.queryOperatorFloatSubledger).toBe('function');
    void deriveIssue9CommandReceiptId;
    void repository;
  });

  it('supports positional attachExpenseReceipt and settleDeferredAccrual signatures on ExpenseService, LogExpenseUseCase, and standalone helpers', async () => {
    const { store, service, storage, repository } = createInMemoryExpenseHarness();
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });
    const hunter = makeSession({ userId: HUNTER_1, role: UserRole.HUNTER_MECHANIC });

    store.sales.set('sale-pos-1', {
      id: 'sale-pos-1',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 30_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 30_000,
      netRealizedCadMinor: 30_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: HUNTER_1,
      isVoidedOrReversed: false,
    });

    const pendingA = await service.logExpense(hunter, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Positional Vendor A',
      description: 'Pending A',
      amountOriginalMinor: 5_000,
      receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
      voucherReason: 'Paper receipt pending scan',
      idempotencyKey: randomUUID(),
    });
    const pendingB = await service.logExpense(hunter, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Positional Vendor B',
      description: 'Pending B',
      amountOriginalMinor: 6_000,
      receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
      voucherReason: 'Paper receipt pending scan B',
      idempotencyKey: randomUUID(),
    });

    const evA = await storage.uploadPrivateEvidence({
      actor: hunter,
      organizationId: ORG_SALVAGE,
      evidence: Uint8Array.from([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    const evB = await storage.uploadPrivateEvidence({
      actor: hunter,
      organizationId: ORG_SALVAGE,
      evidence: Uint8Array.from([4, 5, 6]),
      contentType: 'image/jpeg',
    });

    // Positional call on ExpenseService directly (5 args including commandMetadata)
    const attachKeyA = randomUUID();
    const attachedViaService = await service.attachExpenseReceipt(
      hunter,
      pendingA.expense.id,
      evA.storageKey,
      500,
      { idempotencyKey: attachKeyA },
    );
    expect(attachedViaService.expense.receiptVerificationState).toBe(
      'VERIFIED_RECEIPT',
    );
    expect(attachedViaService.expense.itcReceivableCadMinor).toBe(500);

    // Positional replay on ExpenseService
    const replayedViaService = await service.attachExpenseReceipt(
      hunter,
      pendingA.expense.id,
      evA.storageKey,
      500,
      { idempotencyKey: attachKeyA },
    );
    expect(replayedViaService.replayed).toBe(true);

    // Positional call via standalone helper accepting ExpenseService (4 args, no metadata)
    const attachedViaHelper = await attachExpenseReceipt(
      service,
      hunter,
      pendingB.expense.id,
      evB.storageKey,
      600,
    );
    expect(attachedViaHelper.expense.receiptVerificationState).toBe(
      'VERIFIED_RECEIPT',
    );
    expect(attachedViaHelper.expense.itcReceivableCadMinor).toBe(600);

    // Positional settleDeferredAccrual on ExpenseService and LogExpenseUseCase
    const accrualA = await service.logExpense(cfo, {
      category: 'STEAM_CLEANING_EXPORT_PREP',
      vendorName: 'Positional Lessor A',
      description: 'Accrual A',
      amountOriginalMinor: 8_000,
      isDeferredIntercompanyAccrual: true,
      receiptBytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
      receiptContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    const settleKeyA = randomUUID();
    const settledViaService = await service.settleDeferredAccrual(
      cfo,
      accrualA.expense.id,
      { paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK' },
      { idempotencyKey: settleKeyA },
    );
    expect(settledViaService.expense.accrualSettledAt).not.toBeNull();
    expect(settledViaService.expense.paidFromCashCustody).toBe(
      'SETTLED_ORIGIN_CORP_BANK',
    );

    const settledReplay = await service.settleDeferredAccrual(
      cfo,
      accrualA.expense.id,
      { paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK' },
      { idempotencyKey: settleKeyA },
    );
    expect(settledReplay.replayed).toBe(true);

    const useCase = new LogExpenseUseCase({
      repository,
      storage,
      clock: { now: () => store.now },
    });
    const accrualB = await useCase.execute(cfo, {
      category: 'STEAM_CLEANING_EXPORT_PREP',
      vendorName: 'Positional Lessor B',
      description: 'Accrual B',
      amountOriginalMinor: 4_000,
      isDeferredIntercompanyAccrual: true,
      receiptBytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
      receiptContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    const settledViaUseCase = await useCase.settleDeferredAccrual(
      cfo,
      accrualB.expense.id,
      { paidFromCashCustody: 'HELD_IN_OPERATOR_FLOAT', custodyHolderUserId: HUNTER_1 },
    );
    expect(settledViaUseCase.expense.paidFromCashCustody).toBe(
      'HELD_IN_OPERATOR_FLOAT',
    );
    expect(settledViaUseCase.expense.custodyHolderUserId).toBe(HUNTER_1);

    const accrualC = await service.logExpense(cfo, {
      category: 'STEAM_CLEANING_EXPORT_PREP',
      vendorName: 'Positional Lessor C',
      description: 'Accrual C',
      amountOriginalMinor: 3_000,
      isDeferredIntercompanyAccrual: true,
      receiptBytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
      receiptContentType: 'application/pdf',
      idempotencyKey: randomUUID(),
    });
    const settledViaStandalone = await settleDeferredAccrual(
      service,
      cfo,
      accrualC.expense.id,
    );
    expect(settledViaStandalone.expense.accrualSettledAt).not.toBeNull();
  });

  it('acquires organization advisory lock on preflight/evidence reads and returns 409 IDEMPOTENCY_KEY_REUSED before business-rule 422s', async () => {
    const { store, repository, storage } = createInMemoryExpenseHarness();
    const lockCalls: string[] = [];
    const instrumentedRepo: ExpenseRepository = {
      withTenantTransaction(ctx, fn) {
        return repository.withTenantTransaction(ctx, (tx) =>
          fn({
            ...tx,
            async acquireOrganizationLock(orgId) {
              lockCalls.push(orgId);
              return tx.acquireOrganizationLock(orgId);
            },
          }),
        );
      },
    };
    const service = createExpenseService({
      repository: instrumentedRepo,
      storage,
      clock: { now: () => store.now },
    });
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    store.sales.set('sale-cash-lock', {
      id: 'sale-cash-lock',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.LOCAL_WALK_IN_CASH,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.NOT_REGISTERED_NO_TAX,
      subtotalMinor: 50_000,
      taxOrVatMinor: 0,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 50_000,
      netRealizedCadMinor: 50_000,
      paymentSettlementState: PaymentSettlementState.PAYMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      bankSettledAt: null,
      bankDepositReference: null,
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
    });

    // 1. Committed expense with receiptBytes exercises preflightReplay + commit lock acquisition
    const expKey = randomUUID();
    const lockBeforeLog = lockCalls.length;
    const created = await service.logExpense(cfo, {
      category: 'AFTERMARKET_REPAIR_PARTS',
      vendorName: 'Lock & Idempotency Parts',
      description: 'Valid receipt upload',
      amountOriginalMinor: 4_000,
      receiptBytes: Uint8Array.from([10, 20, 30]),
      receiptContentType: 'image/jpeg',
      idempotencyKey: expKey,
    });
    // preflightReplay + executeCommit both acquired organization lock
    expect(lockCalls.length - lockBeforeLog).toBe(2);

    // 2. getEvidencePresignedUrl acquires organization lock before locking Expense
    const lockBeforePresign = lockCalls.length;
    const urlResult = await service.getEvidencePresignedUrl(cfo, {
      targetType: 'expense',
      targetId: created.expense.id,
    });
    expect(urlResult.targetId).toBe(created.expense.id);
    expect(lockCalls.length - lockBeforePresign).toBe(1);

    // 3. Reusing expKey with mutated payloads that violate pre-lock business rules must return 409 IDEMPOTENCY_KEY_REUSED (not 422)
    await expect(
      service.logExpense(cfo, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Lock & Idempotency Parts',
        description: 'Missing receipt should hit 409 first',
        amountOriginalMinor: 4_000,
        receiptVerificationState: 'VERIFIED_RECEIPT',
        idempotencyKey: expKey,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    await expect(
      service.logExpense(cfo, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Lock & Idempotency Parts',
        description: 'Short voucher reason should hit 409 first',
        amountOriginalMinor: 4_000,
        receiptVerificationState: 'PETTY_CASH_VOUCHER',
        voucherReason: 'ab',
        idempotencyKey: expKey,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    await expect(
      service.logExpense(cfo, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Lock & Idempotency Parts',
        description: 'Blank CFO override reason should hit 409 first',
        amountOriginalMinor: 4_000,
        receiptBytes: Uint8Array.from([10, 20, 30]),
        receiptContentType: 'image/jpeg',
        cfoOverride: { approved: true, reasonNote: '   ' },
        idempotencyKey: expKey,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    // Cross-action reuse on recordCashCustodyTransfer with invalid pair/missing slip -> 409 IDEMPOTENCY_KEY_REUSED
    await expect(
      service.recordCashCustodyTransfer(cfo, {
        fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
        toCustodyState: 'DEPOSITED_DESTINATION_BANK',
        amountMinor: 5_000,
        idempotencyKey: expKey,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    // 4. Committed transfer with depositSlipBytes exercises preflight lock + 409 on mutated invalid transfer
    const transferKey = randomUUID();
    const lockBeforeTransfer = lockCalls.length;
    await service.recordCashCustodyTransfer(cfo, {
      fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
      toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
      amountMinor: 10_000,
      depositSlipBytes: Uint8Array.from([7, 8, 9]),
      depositSlipContentType: 'image/png',
      idempotencyKey: transferKey,
    });
    expect(lockCalls.length - lockBeforeTransfer).toBe(2);

    await expect(
      service.recordCashCustodyTransfer(cfo, {
        fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
        toCustodyState: 'DEPOSITED_DESTINATION_BANK',
        amountMinor: 10_000,
        idempotencyKey: transferKey,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    await expect(
      service.logExpense(cfo, {
        category: 'AFTERMARKET_REPAIR_PARTS',
        vendorName: 'Cross-table reuse',
        description: 'Missing receipt on transfer key',
        amountOriginalMinor: 1_000,
        idempotencyKey: transferKey,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });

  it('normalizes REFUNDED_OR_CHARGED_BACK SETTLED_ORIGIN_CORP_BANK sales with linked reversal SaleTransaction in persisted subledger', async () => {
    const { store, service } = createInMemoryExpenseHarness();
    const cfo = makeSession({ userId: CFO_USER, role: UserRole.ARCHITECT_CFO });

    store.sales.set('sale-bank-parent-refunded', {
      id: 'sale-bank-parent-refunded',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.FB_MARKETPLACE_LOCAL,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
      subtotalMinor: 30_000,
      taxOrVatMinor: 3_900,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: 33_900,
      netRealizedCadMinor: 30_000,
      paymentSettlementState: PaymentSettlementState.REFUNDED_OR_CHARGED_BACK,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-10T10:00:00.000Z'),
      bankDepositReference: 'BANK-PARENT-1',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: true,
    });

    store.sales.set('sale-bank-reversal-child', {
      id: 'sale-bank-reversal-child',
      organizationId: ORG_SALVAGE,
      marketNode: SaleMarketNode.DOMESTIC_ORIGIN,
      domesticChannel: DomesticSaleChannel.FB_MARKETPLACE_LOCAL,
      exportChannel: null,
      paymentCurrency: CurrencyCode.CAD,
      taxCollectionMode: TaxCollectionMode.DIRECT_SELLER_COLLECTED,
      subtotalMinor: -30_000,
      taxOrVatMinor: -3_900,
      buyerTaxRemittedByPlatformMinor: null,
      platformFeeMinor: 0,
      shippingCostMinor: 0,
      estimatedPlatformFeeTaxCadMinor: 0,
      itcReceivableCadMinor: 0,
      isFeeTaxInvoiceVerified: false,
      feeTaxInvoiceStorageKey: null,
      grossCollectedMinor: -33_900,
      netRealizedCadMinor: -30_000,
      paymentSettlementState: PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      bankSettledAt: new Date('2026-11-12T10:00:00.000Z'),
      bankDepositReference: 'BANK-REV-1',
      soldByUserId: CFO_USER,
      isVoidedOrReversed: false,
      reversesSaleTxId: 'sale-bank-parent-refunded',
    });

    const subledger = await service.queryOperatorFloatSubledger(cfo);
    expect(subledger.scope).toBe('FULL_ORGANIZATION');
    if (subledger.scope === 'FULL_ORGANIZATION') {
      expect(subledger.accountingRevenueCadMinor).toBe(0);
      expect(subledger.grossSaleValueCadMinor).toBe(0);
      // Base tranche $22,000 + 33,900 cleared - 33,900 bank refund = 2,200,000
      expect(subledger.confirmedCorpBankCashCadMinor).toBe(2_200_000);
      expect(subledger.directTaxCollectedNetOfRefundsCadMinor).toBe(0);
      expect(subledger.netHstTrustLiabilityCadMinor).toBe(0);
      expect(subledger.availableWorkingCapitalCadMinor).toBe(2_200_000);
      expect(subledger.distributableRealizedProfitPoolCadMinor).toBe(0);
    }
  });
});
