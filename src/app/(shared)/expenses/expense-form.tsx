'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CashCustodyState,
  CurrencyCode,
  ExpenseCategory,
  OrganizationType,
  ReceiptVerificationState,
  UserRole,
} from '@prisma/client';
import type {
  AttachExpenseReceiptResult,
  CfoSubledgerProjection,
  ExpenseSubledgerQueryResult,
  LogExpenseResult,
  PrivateEvidencePresignedUrlResult,
  RecordCashCustodyTransferResult,
  SafeExpenseRow,
  SettleDeferredAccrualResult,
} from '@/modules/shared-ops/expenses/expenses.contracts';

export interface ExpenseWorkspaceFormProps {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationType: OrganizationType;
  readonly actorUserId: string;
  readonly actorRole: UserRole;
  readonly endpointUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly generateIdempotencyKey?: () => string;
}

type ActiveTab =
  | 'LOG'
  | 'PENDING_RECEIPTS'
  | 'ACCRUALS'
  | 'SWEEPS'
  | 'HISTORY';

interface IdempotentAttemptState {
  key: string;
  sig: string | null;
}

function createClientUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-000000000000';
}

function resolveIdempotentKey(
  ref: React.MutableRefObject<IdempotentAttemptState>,
  sig: string,
  generateKey: () => string,
): string {
  if (ref.current.sig !== null && ref.current.sig !== sig) {
    ref.current = { key: generateKey(), sig };
  } else if (ref.current.sig === null) {
    ref.current = { key: ref.current.key, sig };
  }
  return ref.current.key;
}

function formatCad(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-CA')}.${cents} CAD`;
}

function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [whole, frac = ''] = trimmed.split('.');
  const cents =
    Number.parseInt(whole ?? '0', 10) * 100 +
    Number.parseInt(frac.padEnd(2, '0'), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

function triggerHapticFeedback(kind: 'success' | 'error'): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(kind === 'success' ? [20] : [40, 30, 40]);
    }
  } catch {
    // Progressive enhancement only
  }
}

const SALVAGE_STANDARD_CATEGORIES: readonly ExpenseCategory[] = [
  'AUCTION_PURCHASE_PRICE',
  'AUCTION_BUYER_FEE',
  'TOWING_AND_RECOVERY',
  'RAMSAYVILLE_SHOP_LABOR',
  'AFTERMARKET_REPAIR_PARTS',
  'OEM_REBUILD_PARTS',
  'MTO_INSPECTION_FEE',
  'REFRIGERANT_EVAC_AND_PREP',
  'STEAM_CLEANING_EXPORT_PREP',
  'OCEAN_FREIGHT_LCL_FCL',
  'CUSTOMS_BROKERAGE_FEE',
  'DESTINATION_DUTY_AND_VAT',
  'PORT_DRAYAGE',
  'PACKAGING_AND_LABELS',
];

const CANNABIS_CATEGORIES: readonly ExpenseCategory[] = [
  'PACKAGING_AND_LABELS',
  'NUTRIENTS_AND_GROW_MEDIA',
  'LAB_COA_TESTING_FEE',
  'PROCESSING_SOLVENTS_AND_CONSUMABLES',
  'EXCISE_STAMP_AND_DUTY',
];

const PORT_FEE_CATEGORIES: readonly ExpenseCategory[] = [
  'PORT_DRAYAGE',
  'CUSTOMS_BROKERAGE_FEE',
  'DESTINATION_DUTY_AND_VAT',
  'OCEAN_FREIGHT_LCL_FCL',
];

const NURSERY_SUPPLY_CATEGORIES: readonly ExpenseCategory[] = [
  'PACKAGING_AND_LABELS',
  'NUTRIENTS_AND_GROW_MEDIA',
  'LAB_COA_TESTING_FEE',
  'PROCESSING_SOLVENTS_AND_CONSUMABLES',
];

function getAllowedCategoriesForRole(
  role: UserRole,
  orgType: OrganizationType,
): readonly ExpenseCategory[] {
  if (role === 'TRINIDAD_VAULT_ADMIN') {
    return PORT_FEE_CATEGORIES;
  }
  if (role === 'NURSERY_CULTIVATION_TECH') {
    return NURSERY_SUPPLY_CATEGORIES;
  }
  if (orgType === 'CANNABIS_NURSERY_AND_PROCESSING') {
    return CANNABIS_CATEGORIES;
  }
  if (role === 'ARCHITECT_CFO') {
    return [
      ...SALVAGE_STANDARD_CATEGORIES,
      'YARD_STRIPPER_PIECE_RATE',
      'PARTNER_PROFIT_DRAW',
      'PARTNER_TIME_LOG_MEMO',
    ];
  }
  if (role === 'HUNTER_MECHANIC') {
    return [...SALVAGE_STANDARD_CATEGORIES, 'PARTNER_TIME_LOG_MEMO'];
  }
  return [];
}

const TOUCH_BUTTON_STYLE: React.CSSProperties = {
  minHeight: '56px',
  minWidth: '56px',
  padding: '12px 16px',
  fontSize: '15px',
  fontWeight: 700,
  borderRadius: '10px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
};

const TOUCH_INPUT_STYLE: React.CSSProperties = {
  minHeight: '56px',
  padding: '12px 14px',
  fontSize: '16px',
  borderRadius: '8px',
  border: '2px solid #1E293B',
  backgroundColor: '#FFFFFF',
  color: '#0F172A',
  width: '100%',
  boxSizing: 'border-box',
};

export function ExpenseWorkspaceForm(
  props: ExpenseWorkspaceFormProps,
): React.ReactElement {
  const {
    organizationId,
    organizationName,
    organizationType,
    actorUserId,
    actorRole,
    endpointUrl = '/api/shared/expenses',
    fetchFn = fetch,
    generateIdempotencyKey = createClientUuid,
  } = props;

  const isCfo = actorRole === 'ARCHITECT_CFO';
  const isStripper = actorRole === 'ONTARIO_STRIPPER';
  const canReadSubledger =
    isCfo ||
    actorRole === 'HUNTER_MECHANIC' ||
    actorRole === 'CANNABIS_QAP_COMPLIANCE' ||
    isStripper;
  const allowedCategories = getAllowedCategoriesForRole(
    actorRole,
    organizationType,
  );
  const canLogExpenses = allowedCategories.length > 0;

  const [activeTab, setActiveTab] = useState<ActiveTab>(
    canLogExpenses ? 'LOG' : 'HISTORY',
  );
  const [subledger, setSubledger] =
    useState<ExpenseSubledgerQueryResult | null>(null);
  const [loadingSubledger, setLoadingSubledger] = useState(false);
  const [subledgerError, setSubledgerError] = useState<string | null>(null);

  // Log Expense form state
  const [category, setCategory] = useState<ExpenseCategory>(
    allowedCategories[0] ?? 'AFTERMARKET_REPAIR_PARTS',
  );
  const [vendorName, setVendorName] = useState('');
  const [description, setDescription] = useState('');
  const [amountOriginalInput, setAmountOriginalInput] = useState('');
  const [currencyOriginal, setCurrencyOriginal] = useState<CurrencyCode>('CAD');
  const [amountCadInput, setAmountCadInput] = useState('');
  const [itcInput, setItcInput] = useState('');
  const [receiptState, setReceiptState] =
    useState<ReceiptVerificationState>('VERIFIED_RECEIPT');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [voucherReason, setVoucherReason] = useState('');
  const [paidFromCustody, setPaidFromCustody] = useState<
    'SETTLED_ORIGIN_CORP_BANK' | 'HELD_IN_OPERATOR_FLOAT'
  >('SETTLED_ORIGIN_CORP_BANK');
  const [isDeferredAccrual, setIsDeferredAccrual] = useState(false);
  const [vehicleIdInput, setVehicleIdInput] = useState('');
  const [recipientUserIdInput, setRecipientUserIdInput] = useState('');
  const [cfoOverrideApproved, setCfoOverrideApproved] = useState(false);
  const [cfoOverrideReason, setCfoOverrideReason] = useState('');

  // Pending Receipt Attachment state
  const [attachFilesByExpenseId, setAttachFilesByExpenseId] = useState<
    Record<string, File | null>
  >({});
  const [attachItcByExpenseId, setAttachItcByExpenseId] = useState<
    Record<string, string>
  >({});

  // Bank Sweep form state
  const [sweepDirection, setSweepDirection] = useState<
    'ORIGIN_FLOAT_TO_BANK' | 'DESTINATION_VAULT_TO_BANK'
  >('ORIGIN_FLOAT_TO_BANK');
  const [sweepHolderUserId, setSweepHolderUserId] = useState(actorUserId);
  const [sweepAmountInput, setSweepAmountInput] = useState('');
  const [sweepEquivCadInput, setSweepEquivCadInput] = useState('');
  const [sweepCurrency, setSweepCurrency] = useState<CurrencyCode>('CAD');
  const [sweepBankName, setSweepBankName] = useState('');
  const [sweepFile, setSweepFile] = useState<File | null>(null);

  // Submission feedback
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [evidencePreviewUrl, setEvidencePreviewUrl] = useState<string | null>(
    null,
  );

  // Idempotency key refs & stale-response guards
  const activeOrgRef = useRef(organizationId);
  const loadSeqRef = useRef(0);
  const logAttemptRef = useRef<IdempotentAttemptState>({
    key: generateIdempotencyKey(),
    sig: null,
  });
  const attachAttemptRef = useRef<IdempotentAttemptState>({
    key: generateIdempotencyKey(),
    sig: null,
  });
  const settleAttemptRef = useRef<IdempotentAttemptState>({
    key: generateIdempotencyKey(),
    sig: null,
  });
  const sweepAttemptRef = useRef<IdempotentAttemptState>({
    key: generateIdempotencyKey(),
    sig: null,
  });

  const loadSubledger = useCallback(async () => {
    if (!canReadSubledger) {
      setSubledger(null);
      return;
    }
    const seq = ++loadSeqRef.current;
    const requestedOrgId = organizationId;
    setLoadingSubledger(true);
    setSubledgerError(null);
    try {
      const response = await fetchFn(`${endpointUrl}?view=subledger`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      if (
        activeOrgRef.current !== requestedOrgId ||
        loadSeqRef.current !== seq
      ) {
        return;
      }
      if (!response.ok) {
        setSubledgerError(
          data?.error?.message ?? 'Failed to load financial subledger.',
        );
        return;
      }
      setSubledger(data as ExpenseSubledgerQueryResult);
    } catch {
      if (
        activeOrgRef.current === requestedOrgId &&
        loadSeqRef.current === seq
      ) {
        setSubledgerError('Network error loading financial subledger.');
      }
    } finally {
      if (
        activeOrgRef.current === requestedOrgId &&
        loadSeqRef.current === seq
      ) {
        setLoadingSubledger(false);
      }
    }
  }, [canReadSubledger, endpointUrl, fetchFn, organizationId]);

  useEffect(() => {
    activeOrgRef.current = organizationId;
    setSubledger(null);
    setActionError(null);
    setActionSuccess(null);
    setEvidencePreviewUrl(null);
    setCategory(
      getAllowedCategoriesForRole(actorRole, organizationType)[0] ??
        'AFTERMARKET_REPAIR_PARTS',
    );
    setSweepHolderUserId(actorUserId);
    logAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
    attachAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
    settleAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
    sweepAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
    void loadSubledger();
  }, [
    actorRole,
    actorUserId,
    generateIdempotencyKey,
    loadSubledger,
    organizationId,
    organizationType,
  ]);

  const handleLogExpenseSubmit = async (
    event: React.FormEvent,
  ): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);

    const isMemo = category === 'PARTNER_TIME_LOG_MEMO';
    const origCents = isMemo ? 0 : dollarsToCents(amountOriginalInput);
    if (origCents === null || (!isMemo && origCents <= 0)) {
      setActionError('Enter a valid positive monetary amount.');
      triggerHapticFeedback('error');
      return;
    }

    const cadCents = isMemo
      ? 0
      : currencyOriginal === 'CAD'
        ? origCents
        : dollarsToCents(amountCadInput);
    if (cadCents === null || (!isMemo && cadCents <= 0)) {
      setActionError('Enter a valid CAD equivalent amount.');
      triggerHapticFeedback('error');
      return;
    }

    const itcCents =
      isMemo || itcInput.trim().length === 0 ? 0 : dollarsToCents(itcInput);
    if (itcCents === null || itcCents < 0) {
      setActionError('Enter a valid non-negative ITC amount.');
      triggerHapticFeedback('error');
      return;
    }

    const effectiveReceiptState: ReceiptVerificationState = isMemo
      ? 'PENDING_RECEIPT_UPLOAD'
      : receiptState;

    if (effectiveReceiptState === 'VERIFIED_RECEIPT' && !receiptFile) {
      setActionError(
        'VERIFIED_RECEIPT requires selecting a receipt photo or PDF file.',
      );
      triggerHapticFeedback('error');
      return;
    }

    const metadata: Record<string, unknown> = {
      action: 'log-expense',
      category,
      vendorName: vendorName.trim(),
      description: description.trim(),
      amountOriginalMinor: origCents,
      currencyOriginal,
      amountCadMinor: cadCents,
      itcReceivableCadMinor: itcCents,
      receiptVerificationState: effectiveReceiptState,
      isDeferredIntercompanyAccrual: isMemo ? false : isDeferredAccrual,
      ...(effectiveReceiptState !== 'VERIFIED_RECEIPT'
        ? { voucherReason: voucherReason.trim() }
        : {}),
      ...(!isMemo && !isDeferredAccrual
        ? { paidFromCashCustody: paidFromCustody }
        : {}),
      ...(vehicleIdInput.trim().length > 0
        ? { vehicleId: vehicleIdInput.trim() }
        : {}),
      ...(recipientUserIdInput.trim().length > 0
        ? { recipientUserId: recipientUserIdInput.trim() }
        : {}),
      ...(isCfo && cfoOverrideApproved
        ? {
            cfoOverride: {
              approved: true,
              reasonNote: cfoOverrideReason.trim(),
            },
          }
        : {}),
    };

    const sig = JSON.stringify({
      org: organizationId,
      metadata,
      fileName: receiptFile?.name ?? null,
      fileSize: receiptFile?.size ?? null,
    });
    const idempotencyKey = resolveIdempotentKey(
      logAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    setIsSubmitting(true);
    try {
      let response: Response;
      if (receiptFile) {
        const fd = new FormData();
        fd.append('metadata', JSON.stringify({ ...metadata, idempotencyKey }));
        fd.append('receipt', receiptFile);
        response = await fetchFn(endpointUrl, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: fd,
        });
      } else {
        response = await fetchFn(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ ...metadata, idempotencyKey }),
        });
      }

      const data = await response.json();
      if (!response.ok) {
        setActionError(
          `${data?.error?.code ?? 'ERROR'}: ${data?.error?.message ?? 'Expense submission failed.'}`,
        );
        triggerHapticFeedback('error');
        return;
      }

      const result = data as LogExpenseResult;
      logAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
      setVendorName('');
      setDescription('');
      setAmountOriginalInput('');
      setAmountCadInput('');
      setItcInput('');
      setVoucherReason('');
      setReceiptFile(null);
      setCfoOverrideApproved(false);
      setCfoOverrideReason('');
      setActionSuccess(
        `Saved ${result.expense.category} (${result.expense.isMemoOnly ? 'Memo Only' : formatCad(result.expense.amountCadMinor)})${result.replayed ? ' [Idempotent Replay]' : ''}.`,
      );
      triggerHapticFeedback('success');
      await loadSubledger();
    } catch {
      setActionError(
        'Network error submitting expense. Retry with the same form values to reuse the Idempotency-Key safely.',
      );
      triggerHapticFeedback('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAttachReceipt = async (expense: SafeExpenseRow): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    const file = attachFilesByExpenseId[expense.id];
    if (!file) {
      setActionError('Select a receipt photo or PDF before attaching.');
      triggerHapticFeedback('error');
      return;
    }
    const rawItc = attachItcByExpenseId[expense.id] ?? '';
    const itcCents = rawItc.trim().length === 0 ? 0 : dollarsToCents(rawItc);
    if (itcCents === null || itcCents < 0) {
      setActionError('Enter a valid non-negative ITC amount.');
      triggerHapticFeedback('error');
      return;
    }

    const metadata = {
      action: 'attach-receipt',
      expenseId: expense.id,
      itcReceivableCadMinor: itcCents,
    };
    const sig = JSON.stringify({
      org: organizationId,
      metadata,
      fileName: file.name,
      fileSize: file.size,
    });
    const idempotencyKey = resolveIdempotentKey(
      attachAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    setIsSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('metadata', JSON.stringify({ ...metadata, idempotencyKey }));
      fd.append('receipt', file);
      const response = await fetchFn(endpointUrl, {
        method: 'PATCH',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: fd,
      });
      const data = await response.json();
      if (!response.ok) {
        setActionError(
          `${data?.error?.code ?? 'ERROR'}: ${data?.error?.message ?? 'Receipt attachment failed.'}`,
        );
        triggerHapticFeedback('error');
        return;
      }
      const result = data as AttachExpenseReceiptResult;
      attachAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
      setActionSuccess(
        `Attached verified receipt to "${result.expense.vendorName}" (ITC: ${formatCad(result.expense.itcReceivableCadMinor)}).`,
      );
      triggerHapticFeedback('success');
      await loadSubledger();
    } catch {
      setActionError('Network error attaching receipt. Safe to retry.');
      triggerHapticFeedback('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSettleAccrual = async (
    expenseId: string,
    custody: CashCustodyState = 'SETTLED_ORIGIN_CORP_BANK',
  ): Promise<void> => {
    if (isSubmitting) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);

    const metadata = {
      action: 'settle-accrual',
      expenseId,
      paidFromCashCustody: custody,
    };
    const sig = JSON.stringify({ org: organizationId, metadata });
    const idempotencyKey = resolveIdempotentKey(
      settleAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    setIsSubmitting(true);
    try {
      const response = await fetchFn(endpointUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ ...metadata, idempotencyKey }),
      });
      const data = await response.json();
      if (!response.ok) {
        setActionError(
          `${data?.error?.code ?? 'ERROR'}: ${data?.error?.message ?? 'Accrual settlement failed.'}`,
        );
        triggerHapticFeedback('error');
        return;
      }
      const result = data as SettleDeferredAccrualResult;
      settleAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
      setActionSuccess(
        `Settled deferred accrual "${result.expense.vendorName}" (${formatCad(result.expense.amountCadMinor)}).`,
      );
      triggerHapticFeedback('success');
      await loadSubledger();
    } catch {
      setActionError('Network error settling accrual. Safe to retry.');
      triggerHapticFeedback('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSweepSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);

    const amtCents = dollarsToCents(sweepAmountInput);
    if (amtCents === null || amtCents <= 0) {
      setActionError('Enter a positive transfer amount.');
      triggerHapticFeedback('error');
      return;
    }
    if (!sweepFile) {
      setActionError('Select a deposit slip photo or PDF.');
      triggerHapticFeedback('error');
      return;
    }

    const isOrigin = sweepDirection === 'ORIGIN_FLOAT_TO_BANK';
    const equivCad = isOrigin
      ? amtCents
      : dollarsToCents(sweepEquivCadInput);
    if (equivCad === null || equivCad <= 0) {
      setActionError('Enter a valid CAD equivalent for destination transfer.');
      triggerHapticFeedback('error');
      return;
    }

    const metadata: Record<string, unknown> = {
      action: 'record-transfer',
      marketNode: isOrigin ? 'DOMESTIC_ORIGIN' : 'DESTINATION_EXPORT_VAULT',
      fromCustodyState: isOrigin
        ? 'HELD_IN_OPERATOR_FLOAT'
        : 'HELD_IN_DESTINATION_VAULT',
      toCustodyState: isOrigin
        ? 'SETTLED_ORIGIN_CORP_BANK'
        : 'DEPOSITED_DESTINATION_BANK',
      currency: isOrigin ? 'CAD' : sweepCurrency,
      amountMinor: amtCents,
      equivalentCadMinor: equivCad,
      custodyHolderUserId: sweepHolderUserId || actorUserId,
      ...(sweepBankName.trim().length > 0
        ? { commercialBankName: sweepBankName.trim() }
        : {}),
    };

    const sig = JSON.stringify({
      org: organizationId,
      metadata,
      fileName: sweepFile.name,
      fileSize: sweepFile.size,
    });
    const idempotencyKey = resolveIdempotentKey(
      sweepAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    setIsSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('metadata', JSON.stringify({ ...metadata, idempotencyKey }));
      fd.append('depositSlip', sweepFile);
      const response = await fetchFn(endpointUrl, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: fd,
      });
      const data = await response.json();
      if (!response.ok) {
        setActionError(
          `${data?.error?.code ?? 'ERROR'}: ${data?.error?.message ?? 'Bank sweep failed.'}`,
        );
        triggerHapticFeedback('error');
        return;
      }
      const result = data as RecordCashCustodyTransferResult;
      sweepAttemptRef.current = { key: generateIdempotencyKey(), sig: null };
      setSweepAmountInput('');
      setSweepEquivCadInput('');
      setSweepBankName('');
      setSweepFile(null);
      setActionSuccess(
        `Recorded bank sweep ${result.transfer.transferCode} (${formatCad(result.transfer.equivalentCadMinor)}).`,
      );
      triggerHapticFeedback('success');
      await loadSubledger();
    } catch {
      setActionError('Network error recording bank sweep. Safe to retry.');
      triggerHapticFeedback('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleViewEvidence = async (
    targetType: 'expense' | 'transfer',
    targetId: string,
  ): Promise<void> => {
    setActionError(null);
    try {
      const response = await fetchFn(
        `${endpointUrl}?view=evidence&targetType=${targetType}&targetId=${targetId}`,
        { method: 'GET', headers: { Accept: 'application/json' } },
      );
      const data = await response.json();
      if (!response.ok) {
        setActionError(
          `${data?.error?.code ?? 'ERROR'}: ${data?.error?.message ?? 'Unable to load evidence link.'}`,
        );
        return;
      }
      const presigned = data as PrivateEvidencePresignedUrlResult;
      setEvidencePreviewUrl(presigned.url);
    } catch {
      setActionError('Network error loading private evidence URL.');
    }
  };

  const cfoSubledger: CfoSubledgerProjection | null =
    subledger?.scope === 'FULL_ORGANIZATION' ? subledger : null;

  return (
    <main
      data-testid="expenses-workspace"
      style={{
        maxWidth: '960px',
        margin: '0 auto',
        padding: '16px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#0F172A',
        backgroundColor: '#F8FAFC',
      }}
    >
      <header
        style={{
          marginBottom: '16px',
          padding: '14px 16px',
          backgroundColor: '#0F172A',
          color: '#FFFFFF',
          borderRadius: '12px',
        }}
      >
        <h1 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 4px 0' }}>
          Expenses, Float &amp; Liquidity Subledger
        </h1>
        <p style={{ margin: 0, fontSize: '14px', color: '#E2E8F0' }}>
          Workspace: <strong>{organizationName}</strong> ({actorRole})
        </p>
      </header>

      {subledgerError && (
        <div
          role="alert"
          data-testid="subledger-error"
          style={{
            padding: '12px 14px',
            marginBottom: '12px',
            backgroundColor: '#FEF2F2',
            border: '2px solid #B91C1C',
            borderRadius: '10px',
            color: '#991B1B',
            fontWeight: 700,
          }}
        >
          [Error] {subledgerError}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          data-testid="action-error"
          style={{
            padding: '12px 14px',
            marginBottom: '12px',
            backgroundColor: '#FEF2F2',
            border: '2px solid #B91C1C',
            borderRadius: '10px',
            color: '#991B1B',
            fontWeight: 700,
          }}
        >
          [Blocked] {actionError}
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          aria-live="polite"
          data-testid="action-success"
          style={{
            padding: '12px 14px',
            marginBottom: '12px',
            backgroundColor: '#ECFDF5',
            border: '2px solid #047857',
            borderRadius: '10px',
            color: '#065F46',
            fontWeight: 700,
          }}
        >
          [Confirmed] {actionSuccess}
        </div>
      )}

      {/* CFO Full 7-Metric Liquidity, Tax/ITC & Tranche Dashboard */}
      {cfoSubledger && (
        <section
          aria-label="CFO 7-Metric Financial & Liquidity Dashboard"
          data-testid="cfo-7-metric-dashboard"
          style={{ marginBottom: '20px' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '10px',
              marginBottom: '12px',
            }}
          >
            <div
              data-testid="metric-accounting-revenue"
              style={{
                padding: '12px',
                backgroundColor: '#FFFFFF',
                border: '2px solid #CBD5E1',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#475569' }}>
                1. Accounting Revenue (Pre-Tax)
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>
                {formatCad(cfoSubledger.accountingRevenueCadMinor)}
              </div>
            </div>
            <div
              data-testid="metric-gross-sale-value"
              style={{
                padding: '12px',
                backgroundColor: '#FFFFFF',
                border: '2px solid #CBD5E1',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#475569' }}>
                2. Gross Sale Value
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>
                {formatCad(cfoSubledger.grossSaleValueCadMinor)}
              </div>
            </div>
            <div
              data-testid="metric-pending-receivables"
              style={{
                padding: '12px',
                backgroundColor: '#FFFBEB',
                border: '2px solid #D97706',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#92400E' }}>
                3. Pending Marketplace / Bank Receivables (Not Bank Cash)
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#92400E' }}>
                {formatCad(cfoSubledger.pendingExternalReceivablesCadMinor)}
              </div>
            </div>
            <div
              data-testid="metric-operator-float"
              style={{
                padding: '12px',
                backgroundColor: '#FFFBEB',
                border: '2px solid #B45309',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#92400E' }}>
                4. Running Operator Float (Physical Cash — Unswept)
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#92400E' }}>
                {formatCad(cfoSubledger.runningOperatorFloatCadMinor)}
              </div>
            </div>
            <div
              data-testid="metric-confirmed-bank-cash"
              style={{
                padding: '12px',
                backgroundColor: '#EFF6FF',
                border: '2px solid #1D4ED8',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#1E40AF' }}>
                5. Confirmed Corporate Bank Cash
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#1E3A8A' }}>
                {formatCad(cfoSubledger.confirmedCorpBankCashCadMinor)}
              </div>
            </div>
            <div
              data-testid="metric-estimated-donor-profit"
              style={{
                padding: '12px',
                backgroundColor: '#F8FAFC',
                border: '2px solid #64748B',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#334155' }}>
                6. Estimated Donor Profit (Accrual Projection)
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>
                {formatCad(cfoSubledger.estimatedDonorProfitCadMinor)}
              </div>
            </div>
            <div
              data-testid="metric-available-working-capital"
              style={{
                padding: '12px',
                backgroundColor: '#ECFDF5',
                border: '2px solid #047857',
                borderRadius: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#065F46' }}>
                7. Available Bank Working Capital (Deployable)
              </div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#065F46' }}>
                {formatCad(cfoSubledger.availableWorkingCapitalCadMinor)}
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '10px',
            }}
          >
            <div
              data-testid="tax-itc-trust-card"
              style={{
                padding: '12px',
                backgroundColor: '#FFFFFF',
                border: '2px solid #1E293B',
                borderRadius: '10px',
                fontSize: '14px',
              }}
            >
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '0 0 8px 0' }}>
                CRA GST/HST &amp; Verified vs. Accrued ITC Trust
              </h2>
              <div>
                Direct Output Tax (Net of Refunds):{' '}
                <strong>
                  {formatCad(cfoSubledger.directTaxCollectedNetOfRefundsCadMinor)}
                </strong>
              </div>
              <div>
                Marketplace Buyer Tax Remitted by Platform:{' '}
                <strong data-testid="platform-buyer-tax">
                  {cfoSubledger.buyerTaxRemittedByPlatformCadMinor !== null
                    ? formatCad(cfoSubledger.buyerTaxRemittedByPlatformCadMinor)
                    : 'Not Reported'}
                </strong>
                {cfoSubledger.hasUnknownMarketplaceBuyerTax
                  ? ' (Incomplete — some orders unreported)'
                  : ''}
              </div>
              <div>
                Unverified Platform Fee Tax Accrued (Pending ETA s. 169(4) Invoice):{' '}
                <strong data-testid="unverified-fee-tax">
                  {formatCad(
                    cfoSubledger.unverifiedPlatformFeeTaxAccruedCadMinor,
                  )}
                </strong>
              </div>
              <div>
                Verified Recoverable ITCs:{' '}
                <strong data-testid="verified-itc">
                  {formatCad(cfoSubledger.verifiedItcReceivableCadMinor)}
                </strong>
              </div>
              <div>
                Net HST Trust Liability:{' '}
                <strong data-testid="net-hst-trust">
                  {formatCad(cfoSubledger.netHstTrustLiabilityCadMinor)}
                </strong>
              </div>
            </div>

            <div
              data-testid="tranche-capital-card"
              style={{
                padding: '12px',
                backgroundColor: '#FFFFFF',
                border: '2px solid #1E293B',
                borderRadius: '10px',
                fontSize: '14px',
              }}
            >
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '0 0 8px 0' }}>
                3-Tranche Capital, Profit Pool &amp; Deferred Accruals
              </h2>
              <div>
                Released / Committed Facility:{' '}
                <strong>
                  {formatCad(cfoSubledger.activeReleasedTrancheCapitalCadMinor)} /{' '}
                  {formatCad(cfoSubledger.tranches.committedFacilityCadMinor)}
                </strong>
              </div>
              <div>
                Distributable Realized Profit Pool:{' '}
                <strong data-testid="distributable-profit-pool">
                  {formatCad(
                    cfoSubledger.distributableRealizedProfitPoolCadMinor,
                  )}
                </strong>
              </div>
              <div>
                Deferred ITA s. 78(1) Accruals (Unpaid):{' '}
                <strong data-testid="deferred-accrual-total">
                  {formatCad(cfoSubledger.deferredIntercompanyAccrualCadMinor)}
                </strong>
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {cfoSubledger.tranches.tranches.map((t) => (
                  <li key={t.trancheCode}>
                    {t.trancheCode}: {formatCad(t.principalCadMinor)} —{' '}
                    {t.unlocked
                      ? 'RELEASED'
                      : t.milestoneMet
                        ? 'ELIGIBLE'
                        : `LOCKED (${t.shelvedSkusRemaining} SKUs / ${t.scrappedDonorsRemaining} donors${t.overdueFloatReceiptsBlocking ? ' / Overdue Float Receipts' : ''})`}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Restricted Operator Own-Float Summary */}
      {subledger?.scope === 'OWN_FLOAT_ONLY' && (
        <section
          data-testid="own-float-dashboard"
          style={{
            padding: '14px',
            marginBottom: '16px',
            backgroundColor: '#FFFFFF',
            border: '2px solid #1E293B',
            borderRadius: '10px',
          }}
        >
          <h2 style={{ fontSize: '16px', fontWeight: 800, margin: '0 0 8px 0' }}>
            My Operator Float &amp; Monthly Petty-Cash Allowance
          </h2>
          <div>
            My Running Operator Float:{' '}
            <strong data-testid="own-float-balance">
              {formatCad(subledger.ownOperatorFloatCadMinor)}
            </strong>
          </div>
          <div>
            30-Day Petty-Cash Vouchers Used:{' '}
            <strong data-testid="own-voucher-usage">
              {formatCad(subledger.ownRolling30DayVoucherUsedCadMinor)} /{' '}
              {formatCad(subledger.monthlyUnreceiptedVoucherCapCadMinor)}
            </strong>
          </div>
        </section>
      )}

      {/* Navigation Tabs */}
      <nav
        aria-label="Expense workflow tabs"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          marginBottom: '16px',
        }}
      >
        {canLogExpenses && (
          <button
            type="button"
            data-testid="tab-log-expense"
            onClick={() => setActiveTab('LOG')}
            style={{
              ...TOUCH_BUTTON_STYLE,
              backgroundColor: activeTab === 'LOG' ? '#0F172A' : '#E2E8F0',
              color: activeTab === 'LOG' ? '#FFFFFF' : '#0F172A',
              border: '2px solid #0F172A',
            }}
          >
            Log Expense
          </button>
        )}
        {(subledger?.scope === 'FULL_ORGANIZATION' ||
          subledger?.scope === 'OWN_FLOAT_ONLY') && (
          <button
            type="button"
            data-testid="tab-pending-receipts"
            onClick={() => setActiveTab('PENDING_RECEIPTS')}
            style={{
              ...TOUCH_BUTTON_STYLE,
              backgroundColor:
                activeTab === 'PENDING_RECEIPTS' ? '#0F172A' : '#E2E8F0',
              color: activeTab === 'PENDING_RECEIPTS' ? '#FFFFFF' : '#0F172A',
              border: '2px solid #0F172A',
            }}
          >
            Pending Receipts ({subledger.pendingReceiptExpenses.length})
          </button>
        )}
        {cfoSubledger && (
          <>
            <button
              type="button"
              data-testid="tab-accruals"
              onClick={() => setActiveTab('ACCRUALS')}
              style={{
                ...TOUCH_BUTTON_STYLE,
                backgroundColor:
                  activeTab === 'ACCRUALS' ? '#0F172A' : '#E2E8F0',
                color: activeTab === 'ACCRUALS' ? '#FFFFFF' : '#0F172A',
                border: '2px solid #0F172A',
              }}
            >
              Deferred Accruals ({cfoSubledger.deferredAccruals.length})
            </button>
            <button
              type="button"
              data-testid="tab-sweeps"
              onClick={() => setActiveTab('SWEEPS')}
              style={{
                ...TOUCH_BUTTON_STYLE,
                backgroundColor: activeTab === 'SWEEPS' ? '#0F172A' : '#E2E8F0',
                color: activeTab === 'SWEEPS' ? '#FFFFFF' : '#0F172A',
                border: '2px solid #0F172A',
              }}
            >
              Bank Sweep
            </button>
          </>
        )}
        {canReadSubledger && (
          <button
            type="button"
            data-testid="tab-history"
            onClick={() => setActiveTab('HISTORY')}
            style={{
              ...TOUCH_BUTTON_STYLE,
              backgroundColor: activeTab === 'HISTORY' ? '#0F172A' : '#E2E8F0',
              color: activeTab === 'HISTORY' ? '#FFFFFF' : '#0F172A',
              border: '2px solid #0F172A',
            }}
          >
            History
          </button>
        )}
      </nav>

      {/* Tab: Log Expense */}
      {activeTab === 'LOG' && canLogExpenses && (
        <form
          onSubmit={handleLogExpenseSubmit}
          noValidate
          data-testid="log-expense-form"
          style={{
            padding: '16px',
            backgroundColor: '#FFFFFF',
            border: '2px solid #1E293B',
            borderRadius: '12px',
            display: 'grid',
            gap: '12px',
          }}
        >
          <label style={{ fontWeight: 700 }}>
            Expense Category
            <select
              data-testid="select-expense-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            >
              {allowedCategories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontWeight: 700 }}>
            Vendor / Counterparty Name
            <input
              type="text"
              data-testid="input-vendor-name"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              required
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            />
          </label>

          <label style={{ fontWeight: 700 }}>
            Description / Work Note
            <input
              type="text"
              data-testid="input-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            />
          </label>

          {category !== 'PARTNER_TIME_LOG_MEMO' && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '10px',
                }}
              >
                <label style={{ fontWeight: 700 }}>
                  Currency
                  <select
                    data-testid="select-currency"
                    value={currencyOriginal}
                    onChange={(e) =>
                      setCurrencyOriginal(e.target.value as CurrencyCode)
                    }
                    style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                  >
                    <option value="CAD">CAD</option>
                    <option value="USD">USD</option>
                    <option value="TTD">TTD</option>
                  </select>
                </label>

                <label style={{ fontWeight: 700 }}>
                  Amount ({currencyOriginal} Dollars)
                  <input
                    type="text"
                    inputMode="decimal"
                    data-testid="input-amount-original"
                    placeholder="45.00"
                    value={amountOriginalInput}
                    onChange={(e) => setAmountOriginalInput(e.target.value)}
                    required
                    style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                  />
                </label>

                {currencyOriginal !== 'CAD' && (
                  <label style={{ fontWeight: 700 }}>
                    CAD Equivalent (Dollars)
                    <input
                      type="text"
                      inputMode="decimal"
                      data-testid="input-amount-cad"
                      placeholder="62.00"
                      value={amountCadInput}
                      onChange={(e) => setAmountCadInput(e.target.value)}
                      required
                      style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                    />
                  </label>
                )}

                <label style={{ fontWeight: 700 }}>
                  Recoverable HST ITC (CAD Dollars)
                  <input
                    type="text"
                    inputMode="decimal"
                    data-testid="input-itc-cad"
                    placeholder="0.00"
                    value={itcInput}
                    onChange={(e) => setItcInput(e.target.value)}
                    style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                  />
                </label>
              </div>

              <fieldset
                style={{
                  border: '2px solid #CBD5E1',
                  borderRadius: '10px',
                  padding: '10px',
                }}
              >
                <legend style={{ fontWeight: 800 }}>
                  Receipt Verification Tier
                </legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {(
                    [
                      ['VERIFIED_RECEIPT', 'Verified Receipt (Upload)'],
                      ['PETTY_CASH_VOUCHER', 'Petty Cash Voucher (<= $50)'],
                      ['PENDING_RECEIPT_UPLOAD', 'Pending Receipt Hold'],
                    ] as const
                  ).map(([tier, label]) => (
                    <button
                      key={tier}
                      type="button"
                      data-testid={`btn-tier-${tier}`}
                      onClick={() => setReceiptState(tier)}
                      style={{
                        ...TOUCH_BUTTON_STYLE,
                        backgroundColor:
                          receiptState === tier ? '#1D4ED8' : '#F1F5F9',
                        color: receiptState === tier ? '#FFFFFF' : '#0F172A',
                        border: '2px solid #1E293B',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>

              {receiptState === 'VERIFIED_RECEIPT' && (
                <label style={{ fontWeight: 700 }}>
                  Private Receipt Image / PDF
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    data-testid="input-receipt-file"
                    onChange={(e) =>
                      setReceiptFile(e.target.files?.[0] ?? null)
                    }
                    style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                  />
                </label>
              )}
            </>
          )}

          {(category === 'PARTNER_TIME_LOG_MEMO' ||
            receiptState !== 'VERIFIED_RECEIPT') && (
            <label style={{ fontWeight: 700 }}>
              Voucher / Memo Reason (min 5 chars)
              <input
                type="text"
                data-testid="input-voucher-reason"
                value={voucherReason}
                onChange={(e) => setVoucherReason(e.target.value)}
                required
                style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
              />
            </label>
          )}

          {category !== 'PARTNER_TIME_LOG_MEMO' &&
            category !== 'PARTNER_PROFIT_DRAW' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '10px',
                }}
              >
                <label style={{ fontWeight: 700 }}>
                  Payment Custody Source
                  <select
                    data-testid="select-paid-custody"
                    value={paidFromCustody}
                    onChange={(e) =>
                      setPaidFromCustody(
                        e.target.value as
                          | 'SETTLED_ORIGIN_CORP_BANK'
                          | 'HELD_IN_OPERATOR_FLOAT',
                      )
                    }
                    disabled={isDeferredAccrual}
                    style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                  >
                    <option value="SETTLED_ORIGIN_CORP_BANK">
                      Corporate Bank Account
                    </option>
                    <option value="HELD_IN_OPERATOR_FLOAT">
                      Operator Physical Float
                    </option>
                  </select>
                </label>

                <label
                  style={{
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '56px',
                  }}
                >
                  <input
                    type="checkbox"
                    data-testid="checkbox-deferred-accrual"
                    checked={isDeferredAccrual}
                    onChange={(e) => setIsDeferredAccrual(e.target.checked)}
                    style={{ width: '28px', height: '28px' }}
                  />
                  Defer under ITA s. 78(1) (No immediate cash outlay)
                </label>
              </div>
            )}

          {(category === 'YARD_STRIPPER_PIECE_RATE' ||
            category === 'AUCTION_BUYER_FEE' ||
            category === 'TOWING_AND_RECOVERY') && (
            <label style={{ fontWeight: 700 }}>
              Donor Vehicle UUID {category === 'YARD_STRIPPER_PIECE_RATE' ? '(Required)' : '(Optional)'}
              <input
                type="text"
                data-testid="input-vehicle-id"
                value={vehicleIdInput}
                onChange={(e) => setVehicleIdInput(e.target.value)}
                required={category === 'YARD_STRIPPER_PIECE_RATE'}
                style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
              />
            </label>
          )}

          {(category === 'PARTNER_PROFIT_DRAW' ||
            category === 'YARD_STRIPPER_PIECE_RATE' ||
            (isCfo && category === 'PARTNER_TIME_LOG_MEMO')) && (
            <label style={{ fontWeight: 700 }}>
              Recipient Member UUID {category === 'PARTNER_PROFIT_DRAW' ? '(Required)' : '(Optional)'}
              <input
                type="text"
                data-testid="input-recipient-user-id"
                value={recipientUserIdInput}
                onChange={(e) => setRecipientUserIdInput(e.target.value)}
                required={category === 'PARTNER_PROFIT_DRAW'}
                style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
              />
            </label>
          )}

          {isCfo && (
            <div
              style={{
                padding: '10px',
                backgroundColor: '#FFFBEB',
                border: '2px solid #D97706',
                borderRadius: '10px',
                display: 'grid',
                gap: '8px',
              }}
            >
              <label
                style={{
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  minHeight: '56px',
                }}
              >
                <input
                  type="checkbox"
                  data-testid="checkbox-cfo-override"
                  checked={cfoOverrideApproved}
                  onChange={(e) => setCfoOverrideApproved(e.target.checked)}
                  style={{ width: '28px', height: '28px' }}
                />
                Apply 1-Tap CFO Override (Monthly voucher cap or reserve floor)
              </label>
              {cfoOverrideApproved && (
                <input
                  type="text"
                  data-testid="input-cfo-override-reason"
                  placeholder="Mandatory CFO override reason"
                  value={cfoOverrideReason}
                  onChange={(e) => setCfoOverrideReason(e.target.value)}
                  required
                  style={TOUCH_INPUT_STYLE}
                />
              )}
            </div>
          )}

          <button
            type="submit"
            data-testid="submit-log-expense"
            disabled={isSubmitting}
            style={{
              ...TOUCH_BUTTON_STYLE,
              backgroundColor: isSubmitting ? '#94A3B8' : '#047857',
              color: '#FFFFFF',
              border: '2px solid #064E3B',
              width: '100%',
            }}
          >
            {isSubmitting ? 'Submitting...' : 'Save Expense Entry'}
          </button>
        </form>
      )}

      {/* Tab: Pending Receipts */}
      {activeTab === 'PENDING_RECEIPTS' &&
        (subledger?.scope === 'FULL_ORGANIZATION' ||
          subledger?.scope === 'OWN_FLOAT_ONLY') && (
          <section
            data-testid="pending-receipts-queue"
            style={{ display: 'grid', gap: '12px' }}
          >
            {subledger.pendingReceiptExpenses.length === 0 ? (
              <p>No pending receipt uploads.</p>
            ) : (
              subledger.pendingReceiptExpenses.map((exp) => (
                <div
                  key={exp.id}
                  data-testid={`pending-expense-${exp.id}`}
                  style={{
                    padding: '14px',
                    backgroundColor: '#FFFFFF',
                    border: '2px solid #1E293B',
                    borderRadius: '10px',
                    display: 'grid',
                    gap: '8px',
                  }}
                >
                  <div>
                    <strong>{exp.vendorName}</strong> — {formatCad(exp.amountCadMinor)}{' '}
                    ({exp.category})
                  </div>
                  <div style={{ fontSize: '13px', color: '#475569' }}>
                    Reason: {exp.voucherReason}
                  </div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    data-testid={`attach-file-${exp.id}`}
                    onChange={(e) =>
                      setAttachFilesByExpenseId((prev) => ({
                        ...prev,
                        [exp.id]: e.target.files?.[0] ?? null,
                      }))
                    }
                    style={TOUCH_INPUT_STYLE}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Verified ITC CAD (e.g. 6.50)"
                    data-testid={`attach-itc-${exp.id}`}
                    value={attachItcByExpenseId[exp.id] ?? ''}
                    onChange={(e) =>
                      setAttachItcByExpenseId((prev) => ({
                        ...prev,
                        [exp.id]: e.target.value,
                      }))
                    }
                    style={TOUCH_INPUT_STYLE}
                  />
                  <button
                    type="button"
                    data-testid={`btn-attach-receipt-${exp.id}`}
                    disabled={isSubmitting}
                    onClick={() => void handleAttachReceipt(exp)}
                    style={{
                      ...TOUCH_BUTTON_STYLE,
                      backgroundColor: '#1D4ED8',
                      color: '#FFFFFF',
                      border: '2px solid #1E3A8A',
                    }}
                  >
                    Attach Verified Receipt
                  </button>
                </div>
              ))
            )}
          </section>
        )}

      {/* Tab: Deferred Accruals */}
      {activeTab === 'ACCRUALS' && cfoSubledger && (
        <section
          data-testid="deferred-accruals-list"
          style={{ display: 'grid', gap: '12px' }}
        >
          {cfoSubledger.deferredAccruals.length === 0 ? (
            <p>No deferred accruals recorded.</p>
          ) : (
            cfoSubledger.deferredAccruals.map((accrual) => (
              <div
                key={accrual.id}
                data-testid={`accrual-item-${accrual.id}`}
                style={{
                  padding: '14px',
                  backgroundColor: '#FFFFFF',
                  border: '2px solid #1E293B',
                  borderRadius: '10px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <div>
                  <strong>{accrual.vendorName}</strong> —{' '}
                  {formatCad(accrual.amountCadMinor)}
                  <div style={{ fontSize: '13px', color: '#475569' }}>
                    {accrual.description} | Age: {accrual.ageDays} days | Status:{' '}
                    <strong>{accrual.settled ? 'Settled' : 'Unsettled'}</strong>
                  </div>
                </div>
                {!accrual.settled && (
                  <button
                    type="button"
                    data-testid={`btn-settle-accrual-${accrual.id}`}
                    disabled={isSubmitting}
                    onClick={() =>
                      void handleSettleAccrual(
                        accrual.id,
                        'SETTLED_ORIGIN_CORP_BANK',
                      )
                    }
                    style={{
                      ...TOUCH_BUTTON_STYLE,
                      backgroundColor: '#047857',
                      color: '#FFFFFF',
                      border: '2px solid #064E3B',
                    }}
                  >
                    Settle from Bank
                  </button>
                )}
              </div>
            ))
          )}
        </section>
      )}

      {/* Tab: Bank Sweep */}
      {activeTab === 'SWEEPS' && cfoSubledger && (
        <form
          onSubmit={handleSweepSubmit}
          noValidate
          data-testid="bank-sweep-form"
          style={{
            padding: '16px',
            backgroundColor: '#FFFFFF',
            border: '2px solid #1E293B',
            borderRadius: '12px',
            display: 'grid',
            gap: '12px',
          }}
        >
          <label style={{ fontWeight: 700 }}>
            Custody Transfer Route
            <select
              data-testid="select-sweep-direction"
              value={sweepDirection}
              onChange={(e) => {
                const dir = e.target.value as
                  | 'ORIGIN_FLOAT_TO_BANK'
                  | 'DESTINATION_VAULT_TO_BANK';
                setSweepDirection(dir);
                setSweepCurrency(dir === 'ORIGIN_FLOAT_TO_BANK' ? 'CAD' : 'TTD');
              }}
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            >
              <option value="ORIGIN_FLOAT_TO_BANK">
                Operator Float -&gt; Origin Corporate Bank (CAD)
              </option>
              <option value="DESTINATION_VAULT_TO_BANK">
                Destination Vault -&gt; Destination Commercial Bank
              </option>
            </select>
          </label>

          <label style={{ fontWeight: 700 }}>
            Cash Custody Holder UUID
            <input
              type="text"
              data-testid="input-sweep-holder"
              value={sweepHolderUserId}
              onChange={(e) => setSweepHolderUserId(e.target.value)}
              required
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            />
          </label>

          <label style={{ fontWeight: 700 }}>
            Sweep Amount ({sweepDirection === 'ORIGIN_FLOAT_TO_BANK' ? 'CAD' : sweepCurrency})
            <input
              type="text"
              inputMode="decimal"
              data-testid="input-sweep-amount"
              placeholder="600.00"
              value={sweepAmountInput}
              onChange={(e) => setSweepAmountInput(e.target.value)}
              required
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            />
          </label>

          {sweepDirection === 'DESTINATION_VAULT_TO_BANK' && (
            <>
              <label style={{ fontWeight: 700 }}>
                Currency
                <select
                  data-testid="select-sweep-currency"
                  value={sweepCurrency}
                  onChange={(e) =>
                    setSweepCurrency(e.target.value as CurrencyCode)
                  }
                  style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                >
                  <option value="TTD">TTD</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <label style={{ fontWeight: 700 }}>
                CAD Equivalent (Audit Only)
                <input
                  type="text"
                  inputMode="decimal"
                  data-testid="input-sweep-equiv-cad"
                  value={sweepEquivCadInput}
                  onChange={(e) => setSweepEquivCadInput(e.target.value)}
                  required
                  style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                />
              </label>
              <label style={{ fontWeight: 700 }}>
                Commercial Bank Name
                <input
                  type="text"
                  data-testid="input-sweep-bank-name"
                  value={sweepBankName}
                  onChange={(e) => setSweepBankName(e.target.value)}
                  style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
                />
              </label>
            </>
          )}

          <label style={{ fontWeight: 700 }}>
            Private Deposit Slip (Photo / PDF)
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              data-testid="input-sweep-slip"
              onChange={(e) => setSweepFile(e.target.files?.[0] ?? null)}
              required
              style={{ ...TOUCH_INPUT_STYLE, marginTop: '4px' }}
            />
          </label>

          <button
            type="submit"
            data-testid="submit-bank-sweep"
            disabled={isSubmitting}
            style={{
              ...TOUCH_BUTTON_STYLE,
              backgroundColor: isSubmitting ? '#94A3B8' : '#1D4ED8',
              color: '#FFFFFF',
              border: '2px solid #1E3A8A',
              width: '100%',
            }}
          >
            {isSubmitting ? 'Recording...' : 'Record Bank Deposit Sweep'}
          </button>
        </form>
      )}

      {/* Tab: History */}
      {activeTab === 'HISTORY' && canReadSubledger && (
        <section data-testid="expense-history-list" style={{ display: 'grid', gap: '10px' }}>
          {loadingSubledger && <p>Loading subledger...</p>}
          {evidencePreviewUrl && (
            <div
              data-testid="evidence-preview-banner"
              style={{
                padding: '10px',
                backgroundColor: '#EFF6FF',
                border: '2px solid #1D4ED8',
                borderRadius: '8px',
              }}
            >
              Short-Lived Evidence Link:{' '}
              <a href={evidencePreviewUrl} target="_blank" rel="noreferrer">
                Open Authorized Evidence
              </a>
            </div>
          )}
          {(subledger?.scope === 'FULL_ORGANIZATION'
            ? subledger.recentExpenses
            : subledger?.scope === 'OWN_FLOAT_ONLY'
              ? subledger.recentExpenses
              : subledger?.scope === 'OWN_PIECE_RATE_ONLY'
                ? subledger.pieceRateExpenses
                : []
          ).map((exp) => (
            <div
              key={exp.id}
              data-testid={`history-expense-${exp.id}`}
              style={{
                padding: '12px',
                backgroundColor: '#FFFFFF',
                border: '2px solid #CBD5E1',
                borderRadius: '10px',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <div>
                <strong>{exp.vendorName}</strong> —{' '}
                {exp.isMemoOnly
                  ? 'Memo Only ($0 Cash Impact)'
                  : formatCad(exp.amountCadMinor)}
                <div style={{ fontSize: '13px', color: '#475569' }}>
                  {exp.category} | {exp.receiptVerificationState} | ITC:{' '}
                  {formatCad(exp.itcReceivableCadMinor)}
                </div>
              </div>
              {exp.hasReceiptEvidence && (
                <button
                  type="button"
                  data-testid={`btn-view-evidence-${exp.id}`}
                  onClick={() => void handleViewEvidence('expense', exp.id)}
                  style={{
                    ...TOUCH_BUTTON_STYLE,
                    backgroundColor: '#F1F5F9',
                    color: '#0F172A',
                    border: '2px solid #1E293B',
                  }}
                >
                  View Receipt
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
