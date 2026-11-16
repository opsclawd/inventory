import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import { evaluateTrancheMilestoneEligibility } from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import {
  DEFAULT_PRESIGNED_URL_TTL_SECONDS,
  type IStoragePort,
} from '@/core/ports/storage.port';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import { assertTrustedAuthSession } from '@/modules/shared-ops/auth/auth.contracts';
import {
  assertValidUuidParam,
  type CfoSubledgerProjection,
  type DeferredAccrualSummaryRow,
  ExpenseError,
  type ExpenseRepository,
  type ExpenseSubledgerQueryResult,
  type ExpenseTx,
  type ExpenseUseCaseDeps,
  type OperatorFloatMemberBalance,
  type OperatorOwnFloatProjection,
  type PrivateEvidencePresignedUrlResult,
  type StripperOwnPieceRateProjection,
  toSafeCashCustodyTransferRow,
  toSafeExpenseRow,
} from './expenses.contracts';

const OVERDUE_RECEIPT_WINDOW_MS = 48 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function loadPolicyInTx(
  tx: ExpenseTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

export class OperatorFloatSubledgerQueryService {
  private readonly repository?: ExpenseRepository;
  private readonly storage?: IStoragePort;
  private readonly clock: { now(): Date };

  public constructor(deps: ExpenseUseCaseDeps = {}) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  private requireRepository(): ExpenseRepository {
    if (!this.repository) {
      throw new ExpenseError(
        'EXPENSE_INTEGRITY_ERROR',
        'ExpenseRepository dependency is required.',
      );
    }
    return this.repository;
  }

  private requireStorage(): IStoragePort {
    if (!this.storage) {
      throw new ExpenseError(
        'EXPENSE_INTEGRITY_ERROR',
        'IStoragePort dependency is required.',
      );
    }
    return this.storage;
  }

  public async query(
    session: AuthSessionContext,
    options?: { readonly limit?: number },
  ): Promise<ExpenseSubledgerQueryResult> {
    assertTrustedAuthSession(session);
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);

    // Determine capability-gated projection level
    let mode: 'CFO_FULL' | 'OWN_FLOAT' | 'OWN_PIECE_RATE';
    if (session.role === 'ARCHITECT_CFO') {
      if (session.activeOrganizationType === 'SALVAGE_AND_EXPORT') {
        assertCapability(session, 'FR-EXP-02:read');
      } else {
        assertCapability(session, 'FR-EXP-01:read');
      }
      mode = 'CFO_FULL';
    } else if (session.role === 'HUNTER_MECHANIC') {
      assertCapability(session, 'FR-EXP-01:read');
      if (session.activeOrganizationType === 'SALVAGE_AND_EXPORT') {
        assertCapability(session, 'FR-EXP-02:read-own-float');
      }
      mode = 'OWN_FLOAT';
    } else if (session.role === 'CANNABIS_QAP_COMPLIANCE') {
      assertCapability(session, 'FR-EXP-01:read');
      mode = 'OWN_FLOAT';
    } else if (session.role === 'ONTARIO_STRIPPER') {
      assertCapability(session, 'FR-EXP-02:read-own-piece-rate');
      mode = 'OWN_PIECE_RATE';
    } else {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        `Role ${session.role} does not have expense subledger read access.`,
      );
    }

    const repository = this.requireRepository();
    return repository.withTenantTransaction(tenantCtx, async (tx) => {
      await tx.acquireOrganizationLock(organizationId);

      const serverNow = this.clock.now();
      const policy = await loadPolicyInTx(tx, organizationId);
      const expenses = await tx.listExpenses(organizationId, { limit });

      const reversedExpenseIds = new Set(
        expenses
          .filter((e) => e.isReversalEntry && e.reversesExpenseId)
          .map((e) => e.reversesExpenseId!),
      );

      if (mode === 'OWN_PIECE_RATE') {
        const pieceRateExpenses = expenses
          .filter(
            (e) =>
              e.category === 'YARD_STRIPPER_PIECE_RATE' &&
              (e.recipientUserId === session.userId ||
                e.loggedByUserId === session.userId),
          )
          .map(toSafeExpenseRow);

        const result: StripperOwnPieceRateProjection = {
          scope: 'OWN_PIECE_RATE_ONLY',
          organizationId,
          organizationType: session.activeOrganizationType,
          userId: session.userId,
          pieceRateExpenses,
        };
        return result;
      }

      const projection = await tx.loadPersistedSnapshot(organizationId, policy);

      if (mode === 'OWN_FLOAT') {
        const windowStart = new Date(
          serverNow.getTime() - THIRTY_DAYS_MS,
        );
        const ownRolling30DayVoucherUsedCadMinor =
          await tx.sumRollingOperatorVouchersCadMinor(
            organizationId,
            session.userId,
            windowStart,
            serverNow,
          );

        const ownExpenses = expenses.filter(
          (e) =>
            e.loggedByUserId === session.userId ||
            e.custodyHolderUserId === session.userId ||
            e.recipientUserId === session.userId,
        );

        const pendingReceiptExpenses = ownExpenses
          .filter(
            (e) =>
              e.receiptVerificationState === 'PENDING_RECEIPT_UPLOAD' &&
              e.category !== 'PARTNER_TIME_LOG_MEMO' &&
              !e.isReversalEntry &&
              !reversedExpenseIds.has(e.id),
          )
          .map(toSafeExpenseRow);

        const result: OperatorOwnFloatProjection = {
          scope: 'OWN_FLOAT_ONLY',
          organizationId,
          organizationType: session.activeOrganizationType,
          userId: session.userId,
          ownOperatorFloatCadMinor:
            projection.snapshot.operatorFloatByUserId[session.userId] ?? 0,
          ownRolling30DayVoucherUsedCadMinor,
          pettyCashVoucherMaxCadMinor:
            policy.expensePolicy.pettyCashVoucherMaxCadMinor,
          monthlyUnreceiptedVoucherCapCadMinor:
            policy.expensePolicy.monthlyUnreceiptedVoucherCapCadMinor,
          isGstHstRegistered: policy.domesticTaxPolicy.isGstHstRegistered,
          pendingReceiptExpenses,
          recentExpenses: ownExpenses.map(toSafeExpenseRow),
        };
        return result;
      }

      // CFO_FULL projection
      const overdueCutoff = new Date(
        serverNow.getTime() - OVERDUE_RECEIPT_WINDOW_MS,
      );
      const [liveCounts, transfers, activeMembers] = await Promise.all([
        tx.loadTrancheLiveCounts(organizationId, overdueCutoff),
        tx.listCashCustodyTransfers(organizationId, { limit }),
        tx.listActiveOrgMembers(organizationId),
      ]);

      const tranches = evaluateTrancheMilestoneEligibility(policy, liveCounts);

      const pendingReceiptExpenses = expenses
        .filter(
          (e) =>
            e.receiptVerificationState === 'PENDING_RECEIPT_UPLOAD' &&
            e.category !== 'PARTNER_TIME_LOG_MEMO' &&
            !e.isReversalEntry &&
            !reversedExpenseIds.has(e.id),
        )
        .map(toSafeExpenseRow);

      const deferredAccruals: DeferredAccrualSummaryRow[] = expenses
        .filter(
          (e) =>
            e.isDeferredIntercompanyAccrual &&
            !e.isReversalEntry &&
            !reversedExpenseIds.has(e.id),
        )
        .sort((a, b) => a.incurredAt.getTime() - b.incurredAt.getTime())
        .map((e) => ({
          id: e.id,
          vendorName: e.vendorName,
          description: e.description,
          category: e.category,
          amountCadMinor: e.amountCadMinor,
          incurredAt: e.incurredAt.toISOString(),
          createdAt: e.createdAt.toISOString(),
          ageDays: Math.max(
            0,
            Math.floor((serverNow.getTime() - e.incurredAt.getTime()) / DAY_MS),
          ),
          settled: e.accrualSettledAt !== null,
          accrualSettledAt: e.accrualSettledAt
            ? e.accrualSettledAt.toISOString()
            : null,
        }));

      const operatorBalances: OperatorFloatMemberBalance[] = activeMembers.map(
        (m) => ({
          userId: m.userId,
          fullName: m.fullName,
          role: m.role,
          floatCadMinor:
            projection.snapshot.operatorFloatByUserId[m.userId] ?? 0,
        }),
      );

      const result: CfoSubledgerProjection = {
        scope: 'FULL_ORGANIZATION',
        organizationId,
        organizationType: session.activeOrganizationType,
        activeReleasedTrancheCapitalCadMinor:
          projection.snapshot.activeReleasedTrancheCapitalCadMinor,
        accountingRevenueCadMinor:
          projection.snapshot.accountingRevenueCadMinor,
        grossSaleValueCadMinor: projection.snapshot.grossSaleValueCadMinor,
        pendingExternalReceivablesCadMinor:
          projection.snapshot.pendingExternalReceivablesCadMinor,
        runningOperatorFloatCadMinor:
          projection.snapshot.runningOperatorFloatCadMinor,
        operatorFloatByUserId: projection.snapshot.operatorFloatByUserId,
        operatorBalances,
        confirmedCorpBankCashCadMinor:
          projection.snapshot.confirmedCorpBankCashCadMinor,
        estimatedDonorProfitCadMinor:
          projection.snapshot.estimatedDonorProfitCadMinor,
        availableWorkingCapitalCadMinor:
          projection.snapshot.availableWorkingCapitalCadMinor,
        distributableRealizedProfitPoolCadMinor:
          projection.snapshot.distributableRealizedProfitPoolCadMinor,
        deferredIntercompanyAccrualCadMinor:
          projection.snapshot.accruedUnpaidExpensesCadMinor,
        directTaxCollectedNetOfRefundsCadMinor:
          projection.taxCounters.directTaxCollectedNetOfRefundsCadMinor,
        buyerTaxRemittedByPlatformCadMinor:
          projection.taxCounters.buyerTaxRemittedByPlatformCadMinor,
        hasUnknownMarketplaceBuyerTax:
          projection.taxCounters.hasUnknownMarketplaceBuyerTax,
        unverifiedPlatformFeeTaxAccruedCadMinor:
          projection.taxCounters.unverifiedPlatformFeeTaxAccruedCadMinor,
        verifiedItcReceivableCadMinor:
          projection.taxCounters.verifiedItcReceivableCadMinor,
        netHstTrustLiabilityCadMinor:
          projection.taxCounters.netHstTrustLiabilityCadMinor,
        isGstHstRegistered: policy.domesticTaxPolicy.isGstHstRegistered,
        minCashReserveFloorCadMinor:
          policy.operationalGates.workingCapitalGate
            .minCashReserveFloorCadMinor,
        pettyCashVoucherMaxCadMinor:
          policy.expensePolicy.pettyCashVoucherMaxCadMinor,
        monthlyUnreceiptedVoucherCapCadMinor:
          policy.expensePolicy.monthlyUnreceiptedVoucherCapCadMinor,
        tranches,
        pendingReceiptExpenses,
        deferredAccruals,
        recentExpenses: expenses.map(toSafeExpenseRow),
        recentTransfers: transfers.map(toSafeCashCustodyTransferRow),
        warnings: projection.snapshot.warnings,
      };
      return result;
    });
  }

  public async getEvidencePresignedUrl(
    session: AuthSessionContext,
    input: {
      readonly targetType: 'expense' | 'transfer';
      readonly targetId: string;
      readonly ttlSeconds?: number;
    },
  ): Promise<PrivateEvidencePresignedUrlResult> {
    assertTrustedAuthSession(session);
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const targetId = assertValidUuidParam(input.targetId, 'targetId');

    if (input.targetType === 'transfer') {
      if (session.role !== 'ARCHITECT_CFO') {
        throw new AuthError(
          'CAPABILITY_FORBIDDEN',
          'Only ARCHITECT_CFO may access cash custody transfer deposit slips.',
        );
      }
      if (session.activeOrganizationType === 'SALVAGE_AND_EXPORT') {
        assertCapability(session, 'FR-EXP-02:read');
      } else {
        assertCapability(session, 'FR-EXP-01:read');
      }
    } else {
      if (session.role === 'ONTARIO_STRIPPER') {
        assertCapability(session, 'FR-EXP-02:read-own-piece-rate');
      } else {
        assertCapability(session, 'FR-EXP-01:read');
      }
    }

    const repository = this.requireRepository();
    const storage = this.requireStorage();

    const storageKey = await repository.withTenantTransaction(
      tenantCtx,
      async (tx) => {
        await tx.acquireOrganizationLock(organizationId);
        if (input.targetType === 'transfer') {
          const transfer = await tx.findTransferById(organizationId, targetId);
          if (!transfer) {
            throw new ExpenseError(
              'EXPENSE_NOT_FOUND',
              `CashCustodyTransfer "${targetId}" was not found in the active organization.`,
            );
          }
          return transfer.depositSlipStorageKey;
        }

        const expense = await tx.findAndLockExpense(organizationId, targetId);
        if (!expense) {
          throw new ExpenseError(
            'EXPENSE_NOT_FOUND',
            `Expense "${targetId}" was not found in the active organization.`,
          );
        }
        if (
          session.role !== 'ARCHITECT_CFO' &&
          expense.loggedByUserId !== session.userId &&
          expense.custodyHolderUserId !== session.userId &&
          expense.recipientUserId !== session.userId
        ) {
          throw new AuthError(
            'CAPABILITY_FORBIDDEN',
            'Non-CFO operators may only access private receipts for their own expense records.',
          );
        }
        if (!expense.receiptStorageKey) {
          throw new ExpenseError(
            'RECEIPT_REQUIRED',
            `Expense "${targetId}" does not have an attached receipt.`,
          );
        }
        return expense.receiptStorageKey;
      },
    );

    const ttlSeconds = input.ttlSeconds ?? DEFAULT_PRESIGNED_URL_TTL_SECONDS;
    const url = await storage.createPrivateEvidencePresignedUrl({
      actor: session,
      organizationId,
      storageKey,
      ttlSeconds,
    });

    return {
      targetType: input.targetType,
      targetId,
      url,
      ttlSeconds,
    };
  }
}
