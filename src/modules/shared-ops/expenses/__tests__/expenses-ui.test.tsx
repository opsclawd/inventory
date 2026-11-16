// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CashCustodyState,
  CurrencyCode,
  ExpenseCategory,
  OrganizationType,
  ReceiptVerificationState,
  UserRole,
} from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpenseWorkspaceForm } from '@/app/(shared)/expenses/expense-form';
import { AuthError } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import type {
  CfoSubledgerProjection,
  OperatorOwnFloatProjection,
  SafeExpenseRow,
} from '../expenses.contracts';

const ORG_SALVAGE = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
const ORG_CANNABIS = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;
const CFO_USER = PHASE1A_SEED_IDS.users.architectCfo;
const HUNTER_USER = PHASE1A_SEED_IDS.users.hunterMechanic;

function makeCfoSubledger(
  overrides: Partial<CfoSubledgerProjection> = {},
): CfoSubledgerProjection {
  return {
    scope: 'FULL_ORGANIZATION',
    organizationId: ORG_SALVAGE,
    organizationType: OrganizationType.SALVAGE_AND_EXPORT,
    activeReleasedTrancheCapitalCadMinor: 2_200_000,
    accountingRevenueCadMinor: 300_000,
    grossSaleValueCadMinor: 326_000,
    pendingExternalReceivablesCadMinor: 213_000,
    runningOperatorFloatCadMinor: 113_000,
    operatorFloatByUserId: { [HUNTER_USER]: 113_000 },
    operatorBalances: [
      {
        userId: HUNTER_USER,
        fullName: 'Hunter One',
        role: UserRole.HUNTER_MECHANIC,
        floatCadMinor: 113_000,
      },
    ],
    confirmedCorpBankCashCadMinor: 2_200_000,
    estimatedDonorProfitCadMinor: 150_000,
    availableWorkingCapitalCadMinor: 2_174_000,
    distributableRealizedProfitPoolCadMinor: 74_000,
    deferredIntercompanyAccrualCadMinor: 10_000,
    directTaxCollectedNetOfRefundsCadMinor: 26_000,
    buyerTaxRemittedByPlatformCadMinor: null,
    hasUnknownMarketplaceBuyerTax: true,
    unverifiedPlatformFeeTaxAccruedCadMinor: 1_700,
    verifiedItcReceivableCadMinor: 0,
    netHstTrustLiabilityCadMinor: 26_000,
    isGstHstRegistered: true,
    minCashReserveFloorCadMinor: 750_000,
    pettyCashVoucherMaxCadMinor: 5_000,
    monthlyUnreceiptedVoucherCapCadMinor: 25_000,
    tranches: {
      committedFacilityCadMinor: 4_400_000,
      activeReleasedTrancheCapitalCadMinor: 2_200_000,
      eligibleUnreleasedTrancheCapitalCadMinor: 0,
      tranches: [
        {
          trancheCode: 'TRANCHE_1_LAUNCH',
          principalCadMinor: 2_200_000,
          unlocked: true,
          milestoneMet: true,
          shelvedSkusRemaining: 0,
          scrappedDonorsRemaining: 0,
          overdueFloatReceiptsBlocking: false,
        },
      ],
    },
    pendingReceiptExpenses: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        organizationId: ORG_SALVAGE,
        loggedByUserId: HUNTER_USER,
        recipientUserId: null,
        custodyHolderUserId: HUNTER_USER,
        vehicleId: null,
        shipmentId: null,
        category: ExpenseCategory.TOWING_AND_RECOVERY,
        vendorName: 'Field Tow Co',
        description: 'Cash tow awaiting slip',
        amountOriginalMinor: 10_000,
        currencyOriginal: CurrencyCode.CAD,
        amountCadMinor: 10_000,
        floatOffsetAppliedCadMinor: 0,
        itcReceivableCadMinor: 0,
        paidFromCashCustody: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
        isDeferredIntercompanyAccrual: false,
        accrualSettledAt: null,
        receiptVerificationState: ReceiptVerificationState.PENDING_RECEIPT_UPLOAD,
        hasReceiptEvidence: false,
        receiptSha256Hash: null,
        voucherReason: 'Driver left invoice at yard',
        isMemoOnly: false,
        isReversalEntry: false,
        reversesExpenseId: null,
        incurredAt: '2026-11-15T10:00:00.000Z',
        createdAt: '2026-11-15T10:00:00.000Z',
      },
    ],
    deferredAccruals: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        vendorName: 'Kemptville Yard Lessor',
        description: 'Monthly container pad lease',
        category: ExpenseCategory.STEAM_CLEANING_EXPORT_PREP,
        amountCadMinor: 10_000,
        incurredAt: '2026-11-01T10:00:00.000Z',
        createdAt: '2026-11-01T10:00:00.000Z',
        ageDays: 15,
        settled: false,
        accrualSettledAt: null,
      },
    ],
    recentExpenses: [],
    recentTransfers: [],
    warnings: [],
    ...overrides,
  };
}

describe('Issue 09: Mobile Gloved-Friendly Expense & Float Subledger UI', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders 7-metric CFO dashboard, >=56px controls, retries with stable Idempotency-Key, attaches receipts, settles accruals, and records sweeps', async () => {
    const user = userEvent.setup();
    let currentSubledger = makeCfoSubledger();
    const seenKeys: string[] = [];
    let failFirstPost = true;
    let keyCounter = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const idempotencyKey = headers.get('Idempotency-Key');

      if (method === 'GET' && url.includes('view=subledger')) {
        return new Response(JSON.stringify(currentSubledger), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'POST') {
        if (idempotencyKey) {
          seenKeys.push(idempotencyKey);
        }
        if (failFirstPost) {
          failFirstPost = false;
          throw new Error('Transient network failure');
        }
        if (init?.body instanceof FormData) {
          const metaRaw = String(init.body.get('metadata'));
          const meta = JSON.parse(metaRaw) as { action: string };
          if (meta.action === 'record-transfer') {
            currentSubledger = makeCfoSubledger({
              runningOperatorFloatCadMinor: 53_000,
              confirmedCorpBankCashCadMinor: 2_260_000,
            });
            return new Response(
              JSON.stringify({
                replayed: false,
                transfer: {
                  id: '33333333-3333-4333-8333-333333333333',
                  organizationId: ORG_SALVAGE,
                  transferCode: 'DROP-ONT-33333333',
                  marketNode: 'DOMESTIC_ORIGIN',
                  fromCustodyState: 'HELD_IN_OPERATOR_FLOAT',
                  toCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
                  currency: 'CAD',
                  amountMinor: 60_000,
                  equivalentCadMinor: 60_000,
                  commercialBankName: null,
                  recordedByUserId: CFO_USER,
                  custodyHolderUserId: HUNTER_USER,
                  hasDepositSlipEvidence: true,
                  transferredAt: '2026-11-16T12:00:00.000Z',
                  createdAt: '2026-11-16T12:00:00.000Z',
                },
                auditLogId: '44444444-4444-4444-8444-444444444444',
                outboxEventId: '55555555-5555-4555-8555-555555555555',
              }),
              { status: 201 },
            );
          }
        }
        const savedExpense: SafeExpenseRow = {
          id: '66666666-6666-4666-8666-666666666666',
          organizationId: ORG_SALVAGE,
          loggedByUserId: CFO_USER,
          recipientUserId: null,
          custodyHolderUserId: CFO_USER,
          vehicleId: null,
          shipmentId: null,
          category: ExpenseCategory.AFTERMARKET_REPAIR_PARTS,
          vendorName: 'NAPA Auto',
          description: 'Shop sockets',
          amountOriginalMinor: 4_000,
          currencyOriginal: CurrencyCode.CAD,
          amountCadMinor: 4_000,
          floatOffsetAppliedCadMinor: 0,
          itcReceivableCadMinor: 0,
          paidFromCashCustody: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
          isDeferredIntercompanyAccrual: false,
          accrualSettledAt: null,
          receiptVerificationState: ReceiptVerificationState.PETTY_CASH_VOUCHER,
          hasReceiptEvidence: false,
          receiptSha256Hash: null,
          voucherReason: 'Urgent socket replacement',
          isMemoOnly: false,
          isReversalEntry: false,
          reversesExpenseId: null,
          incurredAt: '2026-11-16T12:00:00.000Z',
          createdAt: '2026-11-16T12:00:00.000Z',
        };
        return new Response(
          JSON.stringify({
            replayed: false,
            expense: savedExpense,
            rolling30DayVoucherUsedCadMinor: 4_000,
            monthlyVoucherCapCadMinor: 25_000,
            cfoOverrideApplied: false,
            auditLogId: '77777777-7777-4777-8777-777777777777',
            outboxEventId: '88888888-8888-4888-8888-888888888888',
            warnings: [],
          }),
          { status: 201 },
        );
      }

      if (method === 'PATCH') {
        if (init?.body instanceof FormData) {
          currentSubledger = makeCfoSubledger({
            pendingReceiptExpenses: [],
            verifiedItcReceivableCadMinor: 1_300,
          });
          return new Response(
            JSON.stringify({
              replayed: false,
              expense: {
                ...makeCfoSubledger().pendingReceiptExpenses[0]!,
                receiptVerificationState: 'VERIFIED_RECEIPT',
                hasReceiptEvidence: true,
                itcReceivableCadMinor: 1_300,
              },
              auditLogId: '99999999-9999-4999-8999-999999999999',
              outboxEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              warnings: [],
            }),
            { status: 200 },
          );
        }
        currentSubledger = makeCfoSubledger({
          deferredIntercompanyAccrualCadMinor: 0,
          deferredAccruals: [
            {
              ...makeCfoSubledger().deferredAccruals[0]!,
              settled: true,
              accrualSettledAt: '2026-11-16T12:00:00.000Z',
            },
          ],
        });
        return new Response(
          JSON.stringify({
            replayed: false,
            expense: {
              id: '22222222-2222-4222-8222-222222222222',
              organizationId: ORG_SALVAGE,
              loggedByUserId: CFO_USER,
              recipientUserId: null,
              custodyHolderUserId: null,
              vehicleId: null,
              shipmentId: null,
              category: ExpenseCategory.STEAM_CLEANING_EXPORT_PREP,
              vendorName: 'Kemptville Yard Lessor',
              description: 'Monthly container pad lease',
              amountOriginalMinor: 10_000,
              currencyOriginal: CurrencyCode.CAD,
              amountCadMinor: 10_000,
              floatOffsetAppliedCadMinor: 0,
              itcReceivableCadMinor: 0,
              paidFromCashCustody: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
              isDeferredIntercompanyAccrual: true,
              accrualSettledAt: '2026-11-16T12:00:00.000Z',
              receiptVerificationState: ReceiptVerificationState.VERIFIED_RECEIPT,
              hasReceiptEvidence: true,
              receiptSha256Hash: 'a'.repeat(64),
              voucherReason: null,
              isMemoOnly: false,
              isReversalEntry: false,
              reversesExpenseId: null,
              incurredAt: '2026-11-01T10:00:00.000Z',
              createdAt: '2026-11-01T10:00:00.000Z',
            },
            auditLogId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            outboxEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 404 });
    };

    render(
      <ExpenseWorkspaceForm
        organizationId={ORG_SALVAGE}
        organizationName="Ontario Salvage OpCo"
        organizationType={OrganizationType.SALVAGE_AND_EXPORT}
        actorUserId={CFO_USER}
        actorRole={UserRole.ARCHITECT_CFO}
        fetchFn={mockFetch}
        generateIdempotencyKey={() =>
          `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, '0')}`
        }
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('cfo-7-metric-dashboard')).toBeTruthy();
    });

    // Verify all 7 distinct metrics & tax/tranche cards are rendered with clear labels
    expect(screen.getByTestId('metric-pending-receivables').textContent).toContain(
      'Not Bank Cash',
    );
    expect(screen.getByTestId('metric-operator-float').textContent).toContain(
      '$1,130.00 CAD',
    );
    expect(screen.getByTestId('metric-confirmed-bank-cash').textContent).toContain(
      '$22,000.00 CAD',
    );
    expect(screen.getByTestId('platform-buyer-tax').textContent).toBe(
      'Not Reported',
    );
    expect(screen.getByTestId('unverified-fee-tax').textContent).toContain(
      '$17.00 CAD',
    );

    // Verify >= 56px touch controls (NFR-ACC-01)
    const submitBtn = screen.getByTestId('submit-log-expense');
    expect(submitBtn.style.minHeight).toBe('56px');
    expect(submitBtn.style.minWidth).toBe('56px');

    // Submit a petty cash voucher -> network failure -> retry preserves exact Idempotency-Key
    await user.type(screen.getByTestId('input-vendor-name'), 'NAPA Auto');
    await user.type(screen.getByTestId('input-description'), 'Shop sockets');
    await user.type(screen.getByTestId('input-amount-original'), '40.00');
    await user.click(screen.getByTestId('btn-tier-PETTY_CASH_VOUCHER'));
    await user.type(
      screen.getByTestId('input-voucher-reason'),
      'Urgent socket replacement',
    );

    await user.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByTestId('action-error')).toBeTruthy();
    });

    await user.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByTestId('action-success').textContent).toContain(
        '$40.00 CAD',
      );
    });
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);

    // Pending receipt attachment
    await user.click(screen.getByTestId('tab-pending-receipts'));
    const expId = '11111111-1111-4111-8111-111111111111';
    const receiptFile = new File([Uint8Array.from([1, 2, 3])], 'receipt.jpg', {
      type: 'image/jpeg',
    });
    fireEvent.change(screen.getByTestId(`attach-file-${expId}`), {
      target: { files: [receiptFile] },
    });
    await user.type(screen.getByTestId(`attach-itc-${expId}`), '13.00');
    await user.click(screen.getByTestId(`btn-attach-receipt-${expId}`));
    await waitFor(() => {
      expect(screen.getByTestId('verified-itc').textContent).toContain(
        '$13.00 CAD',
      );
    });

    // Deferred accrual settlement
    await user.click(screen.getByTestId('tab-accruals'));
    const accrualId = '22222222-2222-4222-8222-222222222222';
    await user.click(screen.getByTestId(`btn-settle-accrual-${accrualId}`));
    await waitFor(() => {
      expect(screen.getByTestId('deferred-accrual-total').textContent).toContain(
        '$0.00 CAD',
      );
    });

    // Bank sweep
    await user.click(screen.getByTestId('tab-sweeps'));
    await user.type(screen.getByTestId('input-sweep-amount'), '600.00');
    const slipFile = new File([Uint8Array.from([1, 2, 3])], 'slip.pdf', {
      type: 'application/pdf',
    });
    await user.upload(screen.getByTestId('input-sweep-slip'), slipFile);
    await user.click(screen.getByTestId('submit-bank-sweep'));
    await waitFor(() => {
      expect(screen.getByTestId('metric-confirmed-bank-cash').textContent).toContain(
        '$22,600.00 CAD',
      );
    });
  });

  it('renders restricted own-float UI for HUNTER_MECHANIC and discards stale responses on workspace switch', async () => {
    let resolveSlowSalvage!: (value: Response) => void;
    const slowSalvagePromise = new Promise<Response>((resolve) => {
      resolveSlowSalvage = resolve;
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('view=subledger')) {
        if (callCount === 0) {
          callCount += 1;
          return slowSalvagePromise;
        }
        const ownFloatProjection: OperatorOwnFloatProjection = {
          scope: 'OWN_FLOAT_ONLY',
          organizationId: ORG_CANNABIS,
          organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
          userId: HUNTER_USER,
          ownOperatorFloatCadMinor: 25_000,
          ownRolling30DayVoucherUsedCadMinor: 5_000,
          pettyCashVoucherMaxCadMinor: 5_000,
          monthlyUnreceiptedVoucherCapCadMinor: 25_000,
          isGstHstRegistered: true,
          pendingReceiptExpenses: [],
          recentExpenses: [],
        };
        return new Response(JSON.stringify(ownFloatProjection), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    let callCount = 0;

    const { rerender } = render(
      <ExpenseWorkspaceForm
        organizationId={ORG_SALVAGE}
        organizationName="Salvage OpCo"
        organizationType={OrganizationType.SALVAGE_AND_EXPORT}
        actorUserId={HUNTER_USER}
        actorRole={UserRole.HUNTER_MECHANIC}
        fetchFn={mockFetch}
      />,
    );

    // Switch organization before slow response resolves
    rerender(
      <ExpenseWorkspaceForm
        organizationId={ORG_CANNABIS}
        organizationName="Brockville Cannabis"
        organizationType={OrganizationType.CANNABIS_NURSERY_AND_PROCESSING}
        actorUserId={HUNTER_USER}
        actorRole={UserRole.HUNTER_MECHANIC}
        fetchFn={mockFetch}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('own-float-balance').textContent).toContain(
        '$250.00 CAD',
      );
    });

    // Now resolve stale Salvage response with $9,999.00 -> MUST be discarded!
    const staleSalvage: OperatorOwnFloatProjection = {
      scope: 'OWN_FLOAT_ONLY',
      organizationId: ORG_SALVAGE,
      organizationType: OrganizationType.SALVAGE_AND_EXPORT,
      userId: HUNTER_USER,
      ownOperatorFloatCadMinor: 999_900,
      ownRolling30DayVoucherUsedCadMinor: 0,
      pettyCashVoucherMaxCadMinor: 5_000,
      monthlyUnreceiptedVoucherCapCadMinor: 25_000,
      isGstHstRegistered: true,
      pendingReceiptExpenses: [],
      recentExpenses: [],
    };
    resolveSlowSalvage(
      new Response(JSON.stringify(staleSalvage), { status: 200 }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('own-float-balance').textContent).toContain(
        '$250.00 CAD',
      );
    });

    // Hunter never sees CFO-only 7-metric dashboard or Bank Sweep tab
    expect(screen.queryByTestId('cfo-7-metric-dashboard')).toBeNull();
    expect(screen.queryByTestId('tab-sweeps')).toBeNull();
    void createAuthSessionContext;
    void AuthError;
  });
});
