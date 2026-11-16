import { randomUUID } from 'node:crypto';
import type {
  CashCustodyState,
  CurrencyCode,
  ExpenseCategory,
  ReceiptVerificationState,
} from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  DomainRuleError,
  evaluatePartnerProfitDraw,
  evaluatePieceRatePayout,
  type PieceRatePartCandidate,
  type TrustedCfoApprovalInput,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import type { IStoragePort } from '@/core/ports/storage.port';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import { computeSha256Hex } from '@/modules/shared-ops/storage';
import { assertValidPrivateEvidenceKey } from '@/modules/shared-ops/storage/storage.service';
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  assertValidUuidParam,
  type AttachExpenseReceiptCommand,
  AttachReceiptMetadataSchema,
  type AttachExpenseReceiptResult,
  COMPENSATION_EXPENSE_CATEGORIES,
  computeExpenseCommandFingerprint,
  deriveIssue9CommandReceiptId,
  EXPENSE_AUDIT_ACTIONS,
  type ExpenseClock,
  type ExpenseCfoOverrideInput,
  ExpenseError,
  type ExpenseRepository,
  type ExpenseTx,
  type ExpenseUseCaseDeps,
  EXPENSES_RECEIPT_SCHEMA_VERSION,
  isPrismaUniqueViolation,
  type LogExpenseCommand,
  LogExpenseMetadataSchema,
  type LogExpenseResult,
  MAX_EVIDENCE_BYTES,
  normalizeAndValidateEvidenceMime,
  NURSERY_SUPPLY_EXPENSE_CATEGORIES,
  parseStrictTimestamp,
  PORT_FEE_EXPENSE_CATEGORIES,
  resolveIdempotentExpenseReplay,
  SettleAccrualCommandSchema,
  type SettleDeferredAccrualCommand,
  type SettleDeferredAccrualResult,
  type StoredExpenseRecord,
  toSafeExpenseRow,
} from './expenses.contracts';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function loadPolicyInTx(
  tx: ExpenseTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

function isValidSafeExpenseRow(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.organizationId === 'string' &&
    typeof r.category === 'string' &&
    typeof r.amountCadMinor === 'number'
  );
}

function isValidLogExpenseResult(raw: unknown): raw is LogExpenseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    isValidSafeExpenseRow(r.expense) &&
    typeof r.rolling30DayVoucherUsedCadMinor === 'number' &&
    typeof r.monthlyVoucherCapCadMinor === 'number' &&
    typeof r.cfoOverrideApplied === 'boolean' &&
    typeof r.auditLogId === 'string' &&
    typeof r.outboxEventId === 'string' &&
    Array.isArray(r.warnings)
  );
}

function isValidAttachReceiptResult(
  raw: unknown,
): raw is AttachExpenseReceiptResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    isValidSafeExpenseRow(r.expense) &&
    typeof r.auditLogId === 'string' &&
    typeof r.outboxEventId === 'string' &&
    Array.isArray(r.warnings)
  );
}

function isValidSettleAccrualResult(
  raw: unknown,
): raw is SettleDeferredAccrualResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    isValidSafeExpenseRow(r.expense) &&
    typeof r.auditLogId === 'string' &&
    typeof r.outboxEventId === 'string'
  );
}

function authorizeLogExpenseCapability(
  session: AuthSessionContext,
  category: ExpenseCategory,
  recipientUserId: string | null,
): void {
  if (
    category === 'YARD_STRIPPER_PIECE_RATE' ||
    category === 'PARTNER_PROFIT_DRAW'
  ) {
    assertCapability(session, 'FR-EXP-02:approve');
    return;
  }

  if (category === 'PARTNER_TIME_LOG_MEMO') {
    if (session.role === 'ARCHITECT_CFO') {
      assertCapability(session, 'FR-EXP-02:approve');
      return;
    }
    assertCapability(session, 'FR-EXP-01:create');
    if (session.activeOrganizationType !== 'SALVAGE_AND_EXPORT') {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        'PARTNER_TIME_LOG_MEMO is permitted only in SALVAGE_AND_EXPORT organizations.',
      );
    }
    if (session.role !== 'HUNTER_MECHANIC') {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        `Role ${session.role} cannot log PARTNER_TIME_LOG_MEMO.`,
      );
    }
    if (recipientUserId !== null && recipientUserId !== session.userId) {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        'Non-CFO operators may only log PARTNER_TIME_LOG_MEMO for themselves.',
      );
    }
    return;
  }

  // Standard operational expenses
  try {
    assertCapability(session, 'FR-EXP-01:create');
    return;
  } catch (err) {
    if (!(err instanceof AuthError) || err.code !== 'CAPABILITY_FORBIDDEN') {
      throw err;
    }
  }

  if (PORT_FEE_EXPENSE_CATEGORIES.has(category)) {
    assertCapability(session, 'FR-EXP-01:create-port-fees');
    return;
  }

  if (NURSERY_SUPPLY_EXPENSE_CATEGORIES.has(category)) {
    assertCapability(session, 'FR-EXP-01:create-nursery-supplies');
    return;
  }

  throw new AuthError(
    'CAPABILITY_FORBIDDEN',
    `Role ${session.role} is not authorized to log expenses in category ${category}.`,
  );
}

function resolveTrustedCfoOverride(
  session: AuthSessionContext,
  rawOverride: ExpenseCfoOverrideInput | null | undefined,
): TrustedCfoApprovalInput | undefined {
  if (!rawOverride || rawOverride.approved !== true) {
    return undefined;
  }
  if (session.role !== 'ARCHITECT_CFO') {
    throw new DomainRuleError(
      'CFO_OVERRIDE_UNAUTHORIZED',
      'Only an authenticated ARCHITECT_CFO session may authorize a CFO override.',
    );
  }
  if (
    rawOverride.approverRole !== undefined &&
    rawOverride.approverRole !== 'ARCHITECT_CFO'
  ) {
    throw new DomainRuleError(
      'CFO_OVERRIDE_UNAUTHORIZED',
      'Invalid approverRole for CFO override.',
    );
  }
  if (
    rawOverride.approvedById !== undefined &&
    rawOverride.approvedById.trim().toLowerCase() !== session.userId
  ) {
    throw new DomainRuleError(
      'CFO_OVERRIDE_UNAUTHORIZED',
      'Client-supplied approvedById cannot impersonate another CFO.',
    );
  }
  const reasonNote = rawOverride.reasonNote?.trim() ?? '';
  if (reasonNote.length === 0) {
    throw new DomainRuleError(
      'CFO_OVERRIDE_REASON_REQUIRED',
      'CFO override requires a non-blank reasonNote.',
    );
  }
  return {
    approved: true,
    approvedById: session.userId,
    approverRole: session.role,
    reasonNote,
  };
}

export class LogExpenseUseCase {
  private readonly repository?: ExpenseRepository;
  private readonly storage?: IStoragePort;
  private readonly clock: ExpenseClock;
  private readonly idGenerator: () => string;

  public constructor(deps: ExpenseUseCaseDeps = {}) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
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

  private nextUuid(): string {
    const id = this.idGenerator();
    if (!isValidUuid(id)) {
      throw new ExpenseError(
        'EXPENSE_INTEGRITY_ERROR',
        'idGenerator must produce a valid UUID string.',
      );
    }
    return id.toLowerCase();
  }

  public async execute(
    session: AuthSessionContext,
    rawInput: LogExpenseCommand,
  ): Promise<LogExpenseResult> {
    assertTrustedAuthSession(session);

    if (!rawInput || typeof rawInput !== 'object') {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        'Expense command payload is required.',
      );
    }

    const { receiptBytes, receiptContentType, ...metadataRaw } =
      rawInput as LogExpenseCommand & Record<string, unknown>;

    const parsedMeta = LogExpenseMetadataSchema.safeParse(metadataRaw);
    if (!parsedMeta.success) {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        parsedMeta.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const meta = parsedMeta.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    const idempotencyKey = assertValidUuidParam(
      meta.idempotencyKey,
      'idempotencyKey',
    );
    const vehicleId =
      meta.vehicleId !== undefined && meta.vehicleId !== null
        ? assertValidUuidParam(meta.vehicleId, 'vehicleId')
        : null;
    const shipmentId =
      meta.shipmentId !== undefined && meta.shipmentId !== null
        ? assertValidUuidParam(meta.shipmentId, 'shipmentId')
        : null;
    const requestedRecipientId =
      meta.recipientUserId !== undefined && meta.recipientUserId !== null
        ? assertValidUuidParam(meta.recipientUserId, 'recipientUserId')
        : null;
    const requestedCustodyHolderId =
      meta.custodyHolderUserId !== undefined && meta.custodyHolderUserId !== null
        ? assertValidUuidParam(meta.custodyHolderUserId, 'custodyHolderUserId')
        : null;

    authorizeLogExpenseCapability(session, meta.category, requestedRecipientId);

    const hasBytes = receiptBytes !== undefined;
    const suppliedKey = meta.receiptStorageKey ?? null;
    if (
      hasBytes &&
      receiptBytes instanceof Uint8Array &&
      receiptBytes.byteLength > MAX_EVIDENCE_BYTES
    ) {
      throw new ExpenseError(
        'PAYLOAD_TOO_LARGE',
        `Receipt payload exceeds maximum size of ${MAX_EVIDENCE_BYTES} bytes.`,
      );
    }

    const precomputedReceiptSha256: string | null =
      hasBytes &&
      receiptBytes instanceof Uint8Array &&
      receiptBytes.byteLength > 0
        ? computeSha256Hex(receiptBytes)
        : null;
    const rawMimeForFingerprint =
      hasBytes && typeof receiptContentType === 'string'
        ? (() => {
            const candidate =
              receiptContentType.split(';')[0]?.trim().toLowerCase() ?? '';
            return ALLOWED_EVIDENCE_MIME_TYPES.has(candidate)
              ? candidate
              : receiptContentType;
          })()
        : null;

    const currencyOriginal: CurrencyCode = meta.currencyOriginal ?? 'CAD';
    const isDeferred = meta.isDeferredIntercompanyAccrual ?? false;
    const isMemo = meta.category === 'PARTNER_TIME_LOG_MEMO';
    const isPieceRate = meta.category === 'YARD_STRIPPER_PIECE_RATE';
    const isProfitDraw = meta.category === 'PARTNER_PROFIT_DRAW';

    const receiptVerificationState: ReceiptVerificationState = isMemo
      ? (meta.receiptVerificationState ?? 'PENDING_RECEIPT_UPLOAD')
      : (meta.receiptVerificationState ?? 'VERIFIED_RECEIPT');

    const amountOriginalMinor = meta.amountOriginalMinor;
    const amountCadMinorForFingerprint: number | null = isMemo
      ? 0
      : meta.amountCadMinor !== undefined
        ? meta.amountCadMinor
        : currencyOriginal === 'CAD'
          ? amountOriginalMinor
          : null;

    const requestedItc = meta.itcReceivableCadMinor ?? 0;

    let paidFromCashCustody: CashCustodyState | null;
    if (isMemo || isDeferred) {
      paidFromCashCustody = null;
    } else if (isProfitDraw) {
      paidFromCashCustody = 'SETTLED_ORIGIN_CORP_BANK';
    } else if (
      meta.paidFromCashCustody !== undefined &&
      meta.paidFromCashCustody !== null
    ) {
      paidFromCashCustody = meta.paidFromCashCustody;
    } else if (receiptVerificationState === 'VERIFIED_RECEIPT') {
      paidFromCashCustody = 'SETTLED_ORIGIN_CORP_BANK';
    } else {
      paidFromCashCustody = 'HELD_IN_OPERATOR_FLOAT';
    }

    const effectiveFloatHolderId =
      paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT'
        ? (requestedCustodyHolderId ?? session.userId)
        : null;

    let incurredAtForFingerprint: string | null = null;
    if (meta.incurredAt !== undefined) {
      const parsedDate =
        meta.incurredAt instanceof Date
          ? new Date(meta.incurredAt.getTime())
          : new Date(meta.incurredAt);
      incurredAtForFingerprint = !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : String(meta.incurredAt);
    }

    const cfoOverrideReasonForFingerprint =
      meta.cfoOverride?.approved === true
        ? (meta.cfoOverride.reasonNote?.trim() ?? '')
        : null;

    const fingerprint = computeExpenseCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'log-expense',
      payload: {
        category: meta.category,
        vendorName: meta.vendorName,
        description: meta.description,
        amountOriginalMinor,
        currencyOriginal,
        amountCadMinor: amountCadMinorForFingerprint,
        itcReceivableCadMinor: requestedItc,
        receiptVerificationState,
        receiptStorageKey: suppliedKey,
        receiptSha256Precomputed: precomputedReceiptSha256,
        receiptContentType: rawMimeForFingerprint,
        voucherReason: meta.voucherReason ?? null,
        paidFromCashCustody,
        custodyHolderUserId: effectiveFloatHolderId,
        recipientUserId: requestedRecipientId,
        vehicleId,
        shipmentId,
        isDeferredIntercompanyAccrual: isDeferred,
        incurredAt: incurredAtForFingerprint,
        cfoOverrideReason: cfoOverrideReasonForFingerprint,
      },
    });

    const validateBusinessRules = (): {
      trustedCfoOverride: TrustedCfoApprovalInput | undefined;
      normalizedReceiptMime: string | null;
      amountCadMinor: number;
      incurredAt: Date;
    } => {
      const trustedCfoOverride = resolveTrustedCfoOverride(
        session,
        meta.cfoOverride,
      );

      let normalizedReceiptMime: string | null = null;
      if (hasBytes) {
        if (suppliedKey !== null) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'Provide either receiptBytes or receiptStorageKey, not both.',
          );
        }
        if (
          !(receiptBytes instanceof Uint8Array) ||
          receiptBytes.byteLength === 0
        ) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'Private receipt bytes must be a non-empty binary payload.',
          );
        }
        if (receiptBytes.byteLength > MAX_EVIDENCE_BYTES) {
          throw new ExpenseError(
            'PAYLOAD_TOO_LARGE',
            `Receipt payload exceeds maximum size of ${MAX_EVIDENCE_BYTES} bytes.`,
          );
        }
        normalizedReceiptMime = normalizeAndValidateEvidenceMime(
          typeof receiptContentType === 'string' ? receiptContentType : '',
        );
      } else if (suppliedKey !== null) {
        assertValidPrivateEvidenceKey(suppliedKey, organizationId);
      }

      if (isMemo) {
        if (
          meta.amountOriginalMinor !== 0 ||
          (meta.amountCadMinor !== undefined && meta.amountCadMinor !== 0) ||
          (meta.itcReceivableCadMinor !== undefined &&
            meta.itcReceivableCadMinor !== 0) ||
          isDeferred ||
          (meta.paidFromCashCustody !== undefined &&
            meta.paidFromCashCustody !== null) ||
          receiptVerificationState !== 'PENDING_RECEIPT_UPLOAD' ||
          hasBytes ||
          suppliedKey !== null
        ) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'PARTNER_TIME_LOG_MEMO must have zero monetary amounts, no deferral, no cash custody source, and PENDING_RECEIPT_UPLOAD state.',
          );
        }
      }

      const amountCadMinor = isMemo
        ? 0
        : meta.amountCadMinor !== undefined
          ? meta.amountCadMinor
          : currencyOriginal === 'CAD'
            ? amountOriginalMinor
            : (() => {
                throw new ExpenseError(
                  'INVALID_EXPENSE_INPUT',
                  `Foreign currency (${currencyOriginal}) expense requires explicit amountCadMinor.`,
                );
              })();

      if (!isMemo) {
        if (amountOriginalMinor <= 0 || amountCadMinor <= 0) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'amountOriginalMinor and amountCadMinor must be strictly positive.',
          );
        }
        if (
          currencyOriginal === 'CAD' &&
          amountCadMinor !== amountOriginalMinor
        ) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'CAD expense amountCadMinor must equal amountOriginalMinor.',
          );
        }
      }

      if (requestedItc > amountCadMinor) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'itcReceivableCadMinor cannot exceed amountCadMinor.',
        );
      }

      if (isProfitDraw) {
        if (currencyOriginal !== 'CAD') {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'PARTNER_PROFIT_DRAW must be denominated in CAD.',
          );
        }
        if (isDeferred) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'PARTNER_PROFIT_DRAW cannot be logged as a deferred accrual.',
          );
        }
        if (!requestedRecipientId) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'PARTNER_PROFIT_DRAW requires recipientUserId.',
          );
        }
      }

      if (isPieceRate) {
        if (isDeferred) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'YARD_STRIPPER_PIECE_RATE cannot be logged as a deferred accrual.',
          );
        }
        if (!vehicleId) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'YARD_STRIPPER_PIECE_RATE requires vehicleId.',
          );
        }
      }

      if (receiptVerificationState === 'VERIFIED_RECEIPT') {
        if (!hasBytes && suppliedKey === null) {
          throw new ExpenseError(
            'RECEIPT_REQUIRED',
            'VERIFIED_RECEIPT expenses require a private receipt upload or verified storage key.',
          );
        }
      } else {
        if (hasBytes || suppliedKey !== null) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            `${receiptVerificationState} cannot carry receipt evidence.`,
          );
        }
        const trimmedReason = meta.voucherReason?.trim() ?? '';
        if (trimmedReason.length < 5) {
          throw new ExpenseError(
            'VOUCHER_REASON_REQUIRED',
            `${receiptVerificationState} requires voucherReason of at least 5 characters.`,
          );
        }
      }

      if (
        paidFromCashCustody !== 'HELD_IN_OPERATOR_FLOAT' &&
        requestedCustodyHolderId !== null &&
        !isProfitDraw
      ) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'custodyHolderUserId applies only when paidFromCashCustody is HELD_IN_OPERATOR_FLOAT.',
        );
      }

      if (
        paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT' &&
        requestedCustodyHolderId !== null &&
        requestedCustodyHolderId !== session.userId &&
        session.role !== 'ARCHITECT_CFO'
      ) {
        throw new AuthError(
          'CAPABILITY_FORBIDDEN',
          'Non-CFO operators cannot charge float expenses to another operator.',
        );
      }

      const incurredAt =
        meta.incurredAt !== undefined
          ? parseStrictTimestamp(meta.incurredAt, 'incurredAt')
          : this.clock.now();

      return {
        trustedCfoOverride,
        normalizedReceiptMime,
        amountCadMinor,
        incurredAt,
      };
    };

    const receiptAuditId = deriveIssue9CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    const evaluateAndValidateInTx = async (
      tx: ExpenseTx,
      serverNow: Date,
      validated: {
        trustedCfoOverride: TrustedCfoApprovalInput | undefined;
        amountCadMinor: number;
      },
    ): Promise<{
      policy: PricingAndCompliancePolicy;
      effectiveItcCadMinor: number;
      rollingUsedCadMinor: number;
      floatOffsetAppliedCadMinor: number;
      resolvedPaidFromCustody: CashCustodyState | null;
      resolvedCustodyHolderId: string | null;
      resolvedRecipientId: string | null;
      cfoOverrideApplied: boolean;
      warnings: string[];
    }> => {
      const policy = await loadPolicyInTx(tx, organizationId);
      const warnings: string[] = [];

      if (vehicleId !== null) {
        const veh = await tx.findAndLockVehicle(organizationId, vehicleId);
        if (!veh) {
          throw new ExpenseError(
            'VEHICLE_NOT_FOUND',
            `Vehicle "${vehicleId}" was not found in the active organization.`,
          );
        }
      }

      if (shipmentId !== null) {
        const exists = await tx.shipmentExists(organizationId, shipmentId);
        if (!exists) {
          throw new ExpenseError(
            'SHIPMENT_NOT_FOUND',
            `Shipment "${shipmentId}" was not found in the active organization.`,
          );
        }
      }

      let resolvedRecipientId: string | null = requestedRecipientId;
      let recipientRole: AuthSessionContext['role'] | null = null;
      if (isMemo && !resolvedRecipientId) {
        resolvedRecipientId = session.userId;
      }
      if (resolvedRecipientId !== null) {
        const member = await tx.findActiveOrgMember(
          organizationId,
          resolvedRecipientId,
        );
        if (!member) {
          throw new ExpenseError(
            'RECIPIENT_NOT_FOUND',
            `Target recipient "${resolvedRecipientId}" is not an active member of the organization.`,
          );
        }
        recipientRole = member.role;
      }

      if (effectiveFloatHolderId !== null) {
        const holder = await tx.findActiveOrgMember(
          organizationId,
          effectiveFloatHolderId,
        );
        if (!holder) {
          throw new ExpenseError(
            'RECIPIENT_NOT_FOUND',
            `Custody holder "${effectiveFloatHolderId}" is not an active member of the organization.`,
          );
        }
      }

      let cfoOverrideApplied = false;
      let rollingUsedCadMinor = 0;

      if (receiptVerificationState === 'PETTY_CASH_VOUCHER') {
        const maxPerItem = policy.expensePolicy.pettyCashVoucherMaxCadMinor;
        if (validated.amountCadMinor > maxPerItem) {
          throw new ExpenseError(
            'VOUCHER_AMOUNT_EXCEEDS_MAX',
            `PETTY_CASH_VOUCHER amount (${validated.amountCadMinor}) exceeds max (${maxPerItem}).`,
          );
        }
        const windowStart = new Date(serverNow.getTime() - THIRTY_DAYS_MS);
        const existingUsed = await tx.sumRollingOperatorVouchersCadMinor(
          organizationId,
          tenantCtx.userId,
          windowStart,
          serverNow,
        );
        rollingUsedCadMinor = existingUsed + validated.amountCadMinor;
        const monthlyCap =
          policy.expensePolicy.monthlyUnreceiptedVoucherCapCadMinor;
        if (rollingUsedCadMinor > monthlyCap) {
          if (!validated.trustedCfoOverride) {
            throw new ExpenseError(
              'MONTHLY_VOUCHER_CAP_EXCEEDED',
              `Rolling 30-day PETTY_CASH_VOUCHER total (${rollingUsedCadMinor}) exceeds ${monthlyCap} CAD minor cap without ARCHITECT_CFO override.`,
            );
          }
          cfoOverrideApplied = true;
          warnings.push('MONTHLY_VOUCHER_CAP_OVERRIDDEN');
        }
      }

      // Piece-rate gate (`RULE-PAY-001`)
      if (isPieceRate) {
        const alreadyPaid = await tx.hasUnreversedPieceRatePayoutForVehicle(
          organizationId,
          vehicleId!,
        );
        if (alreadyPaid) {
          throw new ExpenseError(
            'DUPLICATE_PIECE_RATE_PAYOUT',
            `Donor vehicle "${vehicleId}" already has an unreversed YARD_STRIPPER_PIECE_RATE payout.`,
          );
        }
        const vehicle = await tx.findAndLockVehicle(organizationId, vehicleId!);
        if (!vehicle) {
          throw new ExpenseError(
            'VEHICLE_NOT_FOUND',
            `Vehicle "${vehicleId}" was not found in the active organization.`,
          );
        }
        const donorParts = await tx.findAndLockDonorParts(
          organizationId,
          vehicleId!,
        );
        const pieceCandidates: PieceRatePartCandidate[] = donorParts.map((p) => ({
          id: p.id,
          organizationId: p.organizationId,
          donorVehicleId: p.donorVehicleId,
          custodyState: p.custodyState,
          availabilityState: p.availabilityState,
          barcode: p.qrSkuCode,
          binLocationCode: p.currentLocationBarcode,
          rawPhotoUrls: p.rawPhotoUrls,
        }));
        const pieceEval = evaluatePieceRatePayout(
          {
            organizationId,
            vehicleId: vehicleId!,
            fluidsDrainedAt: vehicle.fluidsDrainedAt,
            parts: pieceCandidates,
          },
          policy,
        );
        if (!pieceEval.eligible) {
          throw new DomainRuleError(
            'PIECE_RATE_GATE_UNMET',
            `Donor "${vehicleId}" does not meet RULE-PAY-001 piece-rate gate (${pieceEval.qualifyingShelvedPartsCount}/${pieceEval.requiredShelvedPartsCount} shelved parts, fluidsDrained=${Boolean(vehicle.fluidsDrainedAt)}).`,
          );
        }
        if (validated.amountCadMinor !== pieceEval.authorizedPayoutCadMinor) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            `YARD_STRIPPER_PIECE_RATE amountCadMinor (${validated.amountCadMinor}) must equal policy-configured authorized payout (${pieceEval.authorizedPayoutCadMinor}).`,
          );
        }
      }

      // Partner profit draw (`RULE-PAY-002` & `RULE-PAY-003`)
      let floatOffsetAppliedCadMinor = 0;
      let resolvedPaidFromCustody: CashCustodyState | null = paidFromCashCustody;
      let resolvedCustodyHolderId: string | null = effectiveFloatHolderId;

      if (isProfitDraw) {
        if (
          recipientRole !== 'ARCHITECT_CFO' &&
          recipientRole !== 'HUNTER_MECHANIC'
        ) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            `PARTNER_PROFIT_DRAW recipient must hold ARCHITECT_CFO or HUNTER_MECHANIC role, got ${String(recipientRole)}.`,
          );
        }
        const projection = await tx.loadPersistedSnapshot(organizationId, policy);
        const drawDecision = evaluatePartnerProfitDraw(
          {
            organizationId,
            targetUserId: resolvedRecipientId!,
            targetUserRole: recipientRole,
            requestedDrawCadMinor: validated.amountCadMinor,
            snapshot: projection.snapshot,
            actor: {
              actorUserId: session.userId,
              actorRole: session.role,
            },
            cfoOverride: validated.trustedCfoOverride,
          },
          policy,
        );
        if (!drawDecision.allowed) {
          const primaryCode =
            drawDecision.blockingCodes[0] ?? 'INSUFFICIENT_REALIZED_PROFIT_POOL';
          throw new DomainRuleError(
            primaryCode,
            `PARTNER_PROFIT_DRAW blocked: ${drawDecision.blockingCodes.join(', ')}.`,
            {
              blockingCodes: drawDecision.blockingCodes,
              distributableRealizedProfitPoolCadMinor:
                drawDecision.distributableRealizedProfitPoolCadMinor,
              availableWorkingCapitalCadMinor:
                drawDecision.availableWorkingCapitalCadMinor,
              maxBankDisbursementAllowedCadMinor:
                drawDecision.maxBankDisbursementAllowedCadMinor,
            },
          );
        }
        floatOffsetAppliedCadMinor = drawDecision.floatOffsetAppliedCadMinor;
        resolvedPaidFromCustody =
          drawDecision.netCashDisbursedFromBankCadMinor > 0
            ? 'SETTLED_ORIGIN_CORP_BANK'
            : 'HELD_IN_OPERATOR_FLOAT';
        resolvedCustodyHolderId =
          floatOffsetAppliedCadMinor > 0 ? resolvedRecipientId : null;
        if (drawDecision.overrideApplied) {
          cfoOverrideApplied = true;
          warnings.push(...drawDecision.warnings);
        }
      }

      // Compute verified ITC eligibility (`FIX 06`)
      const canClaimItc =
        policy.domesticTaxPolicy.isGstHstRegistered === true &&
        receiptVerificationState === 'VERIFIED_RECEIPT' &&
        !COMPENSATION_EXPENSE_CATEGORIES.has(meta.category);
      const effectiveItcCadMinor = canClaimItc ? requestedItc : 0;
      if (!canClaimItc && requestedItc > 0) {
        warnings.push('ITC_FORCED_ZERO_UNREGISTERED_OR_UNVERIFIED');
      }

      return {
        policy,
        effectiveItcCadMinor,
        rollingUsedCadMinor,
        floatOffsetAppliedCadMinor,
        resolvedPaidFromCustody,
        resolvedCustodyHolderId,
        resolvedRecipientId,
        cfoOverrideApplied,
        warnings,
      };
    };

    // If uploading raw receipt bytes, run preflight check first before storage I/O
    let uploadedKey: string | null = suppliedKey;
    let uploadedSha256: string | null = null;

    if (hasBytes) {
      let preflightNormalizedMime: string | null = null;
      const preflightReplay = await repository.withTenantTransaction(
        tenantCtx,
        async (tx) => {
          await tx.acquireOrganizationLock(organizationId);
          const [existingReceipt, existingExpense, existingTransfer] =
            await Promise.all([
              tx.findCommandReceipt(organizationId, receiptAuditId),
              tx.findExpenseByIdempotencyKey(organizationId, idempotencyKey),
              tx.findTransferByIdempotencyKey(organizationId, idempotencyKey),
            ]);
          const replayed = resolveIdempotentExpenseReplay({
            existingReceipt,
            expectedAction: 'log-expense',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: fingerprint,
            hasConflictingRow:
              existingExpense !== null || existingTransfer !== null,
            validateResult: isValidLogExpenseResult,
          });
          if (replayed) {
            return replayed;
          }
          const validated = validateBusinessRules();
          preflightNormalizedMime = validated.normalizedReceiptMime;
          await evaluateAndValidateInTx(tx, this.clock.now(), validated);
          return null;
        },
      );
      if (preflightReplay) {
        return preflightReplay;
      }

      const storage = this.requireStorage();
      const uploaded = await storage.uploadPrivateEvidence({
        actor: session,
        organizationId,
        evidence: receiptBytes!,
        contentType: preflightNormalizedMime!,
        auditContext: { correlationId: idempotencyKey },
      });
      uploadedKey = uploaded.storageKey;
      uploadedSha256 = uploaded.sha256Hash;
    }

    const executeCommit = async (): Promise<LogExpenseResult> =>
      repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const [existingReceipt, existingExpense, existingTransfer] =
          await Promise.all([
            tx.findCommandReceipt(organizationId, receiptAuditId),
            tx.findExpenseByIdempotencyKey(organizationId, idempotencyKey),
            tx.findTransferByIdempotencyKey(organizationId, idempotencyKey),
          ]);
        const replayed = resolveIdempotentExpenseReplay({
          existingReceipt,
          expectedAction: 'log-expense',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: fingerprint,
          hasConflictingRow:
            existingExpense !== null || existingTransfer !== null,
          validateResult: isValidLogExpenseResult,
        });
        if (replayed) {
          return replayed;
        }

        const validated = validateBusinessRules();
        const serverNow = this.clock.now();
        const evaluated = await evaluateAndValidateInTx(
          tx,
          serverNow,
          validated,
        );

        let finalReceiptKey: string | null = null;
        let finalReceiptSha256: string | null = null;
        if (receiptVerificationState === 'VERIFIED_RECEIPT') {
          if (!uploadedKey) {
            throw new ExpenseError(
              'RECEIPT_REQUIRED',
              'VERIFIED_RECEIPT requires a private receipt key.',
            );
          }
          const evidenceMeta = await tx.findVerifiedEvidenceMetadata(
            organizationId,
            uploadedKey,
          );
          if (!evidenceMeta) {
            throw new ExpenseError(
              'INVALID_EVIDENCE_KEY',
              'Supplied receiptStorageKey does not reference a verified PRIVATE_EVIDENCE_UPLOADED record in this organization.',
            );
          }
          finalReceiptKey = evidenceMeta.storageKey;
          finalReceiptSha256 = uploadedSha256 ?? evidenceMeta.sha256Hash;
        }

        const expenseId = this.nextUuid();
        const outboxEventId = this.nextUuid();

        const storedRecord: StoredExpenseRecord = {
          id: expenseId,
          organizationId,
          vehicleId,
          shipmentId,
          cannabisLotId: null,
          loggedByUserId: tenantCtx.userId,
          recipientUserId: evaluated.resolvedRecipientId,
          floatOffsetAppliedCadMinor: evaluated.floatOffsetAppliedCadMinor,
          custodyHolderUserId: evaluated.resolvedCustodyHolderId,
          idempotencyKey,
          category: meta.category,
          vendorName: meta.vendorName,
          description: meta.description,
          amountOriginalMinor,
          currencyOriginal,
          amountCadMinor: validated.amountCadMinor,
          itcReceivableCadMinor: evaluated.effectiveItcCadMinor,
          paidFromCashCustody: evaluated.resolvedPaidFromCustody,
          isDeferredIntercompanyAccrual: isDeferred,
          accrualSettledAt: null,
          isReversalEntry: false,
          reversesExpenseId: null,
          receiptVerificationState,
          receiptStorageKey: finalReceiptKey,
          receiptSha256Hash: finalReceiptSha256,
          voucherReason: meta.voucherReason ?? null,
          incurredAt: validated.incurredAt,
          createdAt: serverNow,
        };

        await tx.insertExpense({
          id: expenseId,
          organizationId,
          vehicleId,
          shipmentId,
          loggedByUserId: tenantCtx.userId,
          recipientUserId: evaluated.resolvedRecipientId,
          floatOffsetAppliedCadMinor: evaluated.floatOffsetAppliedCadMinor,
          custodyHolderUserId: evaluated.resolvedCustodyHolderId,
          idempotencyKey,
          category: meta.category,
          vendorName: meta.vendorName,
          description: meta.description,
          amountOriginalMinor,
          currencyOriginal,
          amountCadMinor: validated.amountCadMinor,
          itcReceivableCadMinor: evaluated.effectiveItcCadMinor,
          paidFromCashCustody: evaluated.resolvedPaidFromCustody,
          isDeferredIntercompanyAccrual: isDeferred,
          accrualSettledAt: null,
          receiptVerificationState,
          receiptStorageKey: finalReceiptKey,
          receiptSha256Hash: finalReceiptSha256,
          voucherReason: meta.voucherReason ?? null,
          incurredAt: validated.incurredAt,
          createdAt: serverNow,
        });

        const safeExpense = toSafeExpenseRow(storedRecord);
        const result: LogExpenseResult = {
          replayed: false,
          expense: safeExpense,
          rolling30DayVoucherUsedCadMinor: evaluated.rollingUsedCadMinor,
          monthlyVoucherCapCadMinor:
            evaluated.policy.expensePolicy.monthlyUnreceiptedVoucherCapCadMinor,
          cfoOverrideApplied: evaluated.cfoOverrideApplied,
          auditLogId: receiptAuditId,
          outboxEventId,
          warnings: evaluated.warnings,
        };

        await tx.insertAuditLog({
          id: receiptAuditId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'Expense',
          entityId: expenseId,
          action: EXPENSE_AUDIT_ACTIONS.LOG_EXPENSE,
          previousState: null,
          nextState: {
            expense: safeExpense,
            cfoOverrideApplied: evaluated.cfoOverrideApplied,
            cfoOverrideReason: validated.trustedCfoOverride?.reasonNote ?? null,
            commandReceipt: {
              schemaVersion: EXPENSES_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'log-expense',
              commandFingerprint: fingerprint,
              result,
            },
          },
          createdAt: serverNow,
        });

        await tx.insertOutboxEvent({
          id: outboxEventId,
          organizationId,
          aggregateType: 'Expense',
          aggregateId: expenseId,
          eventType: 'ExpenseLogged',
          payloadJson: {
            expenseId,
            organizationId,
            category: meta.category,
            amountCadMinor: validated.amountCadMinor,
            itcReceivableCadMinor: evaluated.effectiveItcCadMinor,
            isDeferredIntercompanyAccrual: isDeferred,
          },
          idempotencyKey: `${organizationId}:expense-logged:${idempotencyKey}`,
          createdAt: serverNow,
        });

        return result;
      });

    try {
      return await executeCommit();
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        return await repository.withTenantTransaction(tenantCtx, async (tx) => {
          await tx.acquireOrganizationLock(organizationId);
          const [existingReceipt, existingExpense, existingTransfer] =
            await Promise.all([
              tx.findCommandReceipt(organizationId, receiptAuditId),
              tx.findExpenseByIdempotencyKey(organizationId, idempotencyKey),
              tx.findTransferByIdempotencyKey(organizationId, idempotencyKey),
            ]);
          const replayed = resolveIdempotentExpenseReplay({
            existingReceipt,
            expectedAction: 'log-expense',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: fingerprint,
            hasConflictingRow:
              existingExpense !== null || existingTransfer !== null,
            validateResult: isValidLogExpenseResult,
          });
          if (replayed) {
            return replayed;
          }
          throw new ExpenseError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key conflict while recording expense.',
          );
        });
      }
      throw err;
    }
  }

  public attachExpenseReceipt(
    session: AuthSessionContext,
    command: AttachExpenseReceiptCommand,
  ): Promise<AttachExpenseReceiptResult>;
  public attachExpenseReceipt(
    session: AuthSessionContext,
    expenseId: string,
    receiptStorageKey: string,
    itcReceivableCadMinor?: number,
    commandMetadata?: {
      readonly idempotencyKey?: string;
      readonly deviceTimestamp?: string | Date;
    },
  ): Promise<AttachExpenseReceiptResult>;
  public async attachExpenseReceipt(
    session: AuthSessionContext,
    commandOrExpenseId: AttachExpenseReceiptCommand | string,
    receiptStorageKey?: string,
    itcReceivableCadMinor?: number,
    commandMetadata?: {
      readonly idempotencyKey?: string;
      readonly deviceTimestamp?: string | Date;
    },
  ): Promise<AttachExpenseReceiptResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-EXP-01:create');

    let rawInput: AttachExpenseReceiptCommand;
    if (typeof commandOrExpenseId === 'string') {
      let resolvedItc = itcReceivableCadMinor;
      let resolvedMeta = commandMetadata;
      if (
        resolvedMeta === undefined &&
        typeof itcReceivableCadMinor === 'object' &&
        itcReceivableCadMinor !== null &&
        !Array.isArray(itcReceivableCadMinor) &&
        ('idempotencyKey' in (itcReceivableCadMinor as Record<string, unknown>) ||
          'deviceTimestamp' in (itcReceivableCadMinor as Record<string, unknown>))
      ) {
        resolvedMeta = itcReceivableCadMinor as {
          readonly idempotencyKey?: string;
          readonly deviceTimestamp?: string | Date;
        };
        resolvedItc = undefined;
      }
      rawInput = {
        expenseId: commandOrExpenseId,
        receiptStorageKey: receiptStorageKey ?? null,
        ...(resolvedItc !== undefined
          ? { itcReceivableCadMinor: resolvedItc }
          : {}),
        idempotencyKey: resolvedMeta?.idempotencyKey ?? this.nextUuid(),
        ...(resolvedMeta?.deviceTimestamp !== undefined
          ? { deviceTimestamp: resolvedMeta.deviceTimestamp }
          : {}),
      };
    } else {
      rawInput = commandOrExpenseId;
    }

    if (!rawInput || typeof rawInput !== 'object') {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        'Attach receipt command payload is required.',
      );
    }

    const { receiptBytes, receiptContentType, ...metadataRaw } =
      rawInput as AttachExpenseReceiptCommand & Record<string, unknown>;

    const parsedMeta = AttachReceiptMetadataSchema.safeParse(metadataRaw);
    if (!parsedMeta.success) {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        parsedMeta.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const meta = parsedMeta.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const expenseId = assertValidUuidParam(meta.expenseId, 'expenseId');
    const idempotencyKey = assertValidUuidParam(
      meta.idempotencyKey,
      'idempotencyKey',
    );

    const hasBytes = receiptBytes !== undefined;
    const suppliedKey = meta.receiptStorageKey ?? null;
    if (
      hasBytes &&
      receiptBytes instanceof Uint8Array &&
      receiptBytes.byteLength > MAX_EVIDENCE_BYTES
    ) {
      throw new ExpenseError(
        'PAYLOAD_TOO_LARGE',
        `Receipt payload exceeds maximum size of ${MAX_EVIDENCE_BYTES} bytes.`,
      );
    }

    const precomputedSha256: string | null =
      hasBytes &&
      receiptBytes instanceof Uint8Array &&
      receiptBytes.byteLength > 0
        ? computeSha256Hex(receiptBytes)
        : null;
    const rawMimeForFingerprint =
      hasBytes && typeof receiptContentType === 'string'
        ? (() => {
            const candidate =
              receiptContentType.split(';')[0]?.trim().toLowerCase() ?? '';
            return ALLOWED_EVIDENCE_MIME_TYPES.has(candidate)
              ? candidate
              : receiptContentType;
          })()
        : null;

    const requestedItc = meta.itcReceivableCadMinor ?? 0;
    const fingerprint = computeExpenseCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'attach-receipt',
      payload: {
        expenseId,
        receiptStorageKey: suppliedKey,
        receiptSha256Precomputed: precomputedSha256,
        receiptContentType: rawMimeForFingerprint,
        itcReceivableCadMinor: requestedItc,
      },
    });

    const validateAttachInputs = (): string | null => {
      if (hasBytes) {
        if (suppliedKey !== null) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'Provide either receiptBytes or receiptStorageKey, not both.',
          );
        }
        if (
          !(receiptBytes instanceof Uint8Array) ||
          receiptBytes.byteLength === 0
        ) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'Private receipt bytes must be a non-empty binary payload.',
          );
        }
        if (receiptBytes.byteLength > MAX_EVIDENCE_BYTES) {
          throw new ExpenseError(
            'PAYLOAD_TOO_LARGE',
            `Receipt payload exceeds maximum size of ${MAX_EVIDENCE_BYTES} bytes.`,
          );
        }
        return normalizeAndValidateEvidenceMime(
          typeof receiptContentType === 'string' ? receiptContentType : '',
        );
      }
      if (suppliedKey !== null) {
        assertValidPrivateEvidenceKey(suppliedKey, organizationId);
        return null;
      }
      throw new ExpenseError(
        'RECEIPT_REQUIRED',
        'Attaching a receipt requires receiptBytes or a canonical receiptStorageKey.',
      );
    };

    const receiptAuditId = deriveIssue9CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    const validateTargetExpense = async (
      tx: ExpenseTx,
    ): Promise<StoredExpenseRecord> => {
      const target = await tx.findAndLockExpense(organizationId, expenseId);
      if (!target) {
        throw new ExpenseError(
          'EXPENSE_NOT_FOUND',
          `Expense "${expenseId}" was not found in the active organization.`,
        );
      }
      if (
        session.role !== 'ARCHITECT_CFO' &&
        target.loggedByUserId !== session.userId &&
        target.custodyHolderUserId !== session.userId
      ) {
        throw new AuthError(
          'CAPABILITY_FORBIDDEN',
          'Non-CFO operators may only attach receipts to their own pending expenses.',
        );
      }
      if (target.category === 'PARTNER_TIME_LOG_MEMO') {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Cannot attach receipt to a PARTNER_TIME_LOG_MEMO entry.',
        );
      }
      if (
        target.receiptVerificationState === 'VERIFIED_RECEIPT' ||
        target.receiptStorageKey !== null
      ) {
        throw new ExpenseError(
          'EXPENSE_RECEIPT_ALREADY_ATTACHED',
          `Expense "${expenseId}" already has a verified receipt attached.`,
        );
      }
      if (target.receiptVerificationState !== 'PENDING_RECEIPT_UPLOAD') {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          `Cannot attach receipt to expense in ${target.receiptVerificationState} state.`,
        );
      }
      const isReversed = await tx.hasReversalForExpense(
        organizationId,
        expenseId,
      );
      if (isReversed || target.isReversalEntry) {
        throw new ExpenseError(
          'EXPENSE_RECEIPT_ALREADY_ATTACHED',
          `Expense "${expenseId}" has been reversed and cannot be modified.`,
        );
      }
      if (requestedItc > target.amountCadMinor) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'itcReceivableCadMinor cannot exceed expense amountCadMinor.',
        );
      }
      return target;
    };

    let uploadedKey: string | null = suppliedKey;
    let uploadedSha256: string | null = null;

    if (hasBytes) {
      let preflightNormalizedMime: string | null = null;
      const preflightReplay = await repository.withTenantTransaction(
        tenantCtx,
        async (tx) => {
          await tx.acquireOrganizationLock(organizationId);
          const [existingReceipt, existingExpense, existingTransfer] =
            await Promise.all([
              tx.findCommandReceipt(organizationId, receiptAuditId),
              tx.findExpenseByIdempotencyKey(organizationId, idempotencyKey),
              tx.findTransferByIdempotencyKey(organizationId, idempotencyKey),
            ]);
          const replayed = resolveIdempotentExpenseReplay({
            existingReceipt,
            expectedAction: 'attach-receipt',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: fingerprint,
            hasConflictingRow:
              existingExpense !== null || existingTransfer !== null,
            validateResult: isValidAttachReceiptResult,
          });
          if (replayed) {
            return replayed;
          }
          preflightNormalizedMime = validateAttachInputs();
          await validateTargetExpense(tx);
          return null;
        },
      );
      if (preflightReplay) {
        return preflightReplay;
      }

      const storage = this.requireStorage();
      const uploaded = await storage.uploadPrivateEvidence({
        actor: session,
        organizationId,
        evidence: receiptBytes!,
        contentType: preflightNormalizedMime!,
        auditContext: { correlationId: idempotencyKey },
      });
      uploadedKey = uploaded.storageKey;
      uploadedSha256 = uploaded.sha256Hash;
    }

    return repository.withTenantTransaction(tenantCtx, async (tx) => {
      await tx.acquireOrganizationLock(organizationId);

      const [existingReceipt, existingExpense, existingTransfer] =
        await Promise.all([
          tx.findCommandReceipt(organizationId, receiptAuditId),
          tx.findExpenseByIdempotencyKey(organizationId, idempotencyKey),
          tx.findTransferByIdempotencyKey(organizationId, idempotencyKey),
        ]);
      const replayed = resolveIdempotentExpenseReplay({
        existingReceipt,
        expectedAction: 'attach-receipt',
        expectedIdempotencyKey: idempotencyKey,
        expectedFingerprint: fingerprint,
        hasConflictingRow:
          existingExpense !== null || existingTransfer !== null,
        validateResult: isValidAttachReceiptResult,
      });
      if (replayed) {
        return replayed;
      }

      validateAttachInputs();
      const target = await validateTargetExpense(tx);
      const policy = await loadPolicyInTx(tx, organizationId);

      const evidenceMeta = await tx.findVerifiedEvidenceMetadata(
        organizationId,
        uploadedKey!,
      );
      if (!evidenceMeta) {
        throw new ExpenseError(
          'INVALID_EVIDENCE_KEY',
          'Supplied receiptStorageKey does not reference a verified PRIVATE_EVIDENCE_UPLOADED record in this organization.',
        );
      }

      const finalSha256 = uploadedSha256 ?? evidenceMeta.sha256Hash;
      const canClaimItc =
        policy.domesticTaxPolicy.isGstHstRegistered === true &&
        !COMPENSATION_EXPENSE_CATEGORIES.has(target.category);
      const effectiveItcCadMinor = canClaimItc ? requestedItc : 0;
      const warnings: string[] = [];
      if (!canClaimItc && requestedItc > 0) {
        warnings.push('ITC_FORCED_ZERO_UNREGISTERED_OR_UNVERIFIED');
      }

      await tx.updateExpenseReceipt({
        organizationId,
        expenseId,
        receiptStorageKey: evidenceMeta.storageKey,
        receiptSha256Hash: finalSha256,
        itcReceivableCadMinor: effectiveItcCadMinor,
      });

      const updatedRecord: StoredExpenseRecord = {
        ...target,
        receiptVerificationState: 'VERIFIED_RECEIPT',
        receiptStorageKey: evidenceMeta.storageKey,
        receiptSha256Hash: finalSha256,
        itcReceivableCadMinor: effectiveItcCadMinor,
      };
      const safeExpense = toSafeExpenseRow(updatedRecord);
      const serverNow = this.clock.now();
      const outboxEventId = this.nextUuid();

      const result: AttachExpenseReceiptResult = {
        replayed: false,
        expense: safeExpense,
        auditLogId: receiptAuditId,
        outboxEventId,
        warnings,
      };

      await tx.insertAuditLog({
        id: receiptAuditId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'Expense',
        entityId: expenseId,
        action: EXPENSE_AUDIT_ACTIONS.ATTACH_RECEIPT,
        previousState: {
          receiptVerificationState: target.receiptVerificationState,
          receiptStorageKey: target.receiptStorageKey,
          itcReceivableCadMinor: target.itcReceivableCadMinor,
        },
        nextState: {
          receiptVerificationState: 'VERIFIED_RECEIPT',
          receiptStorageKey: evidenceMeta.storageKey,
          receiptSha256Hash: finalSha256,
          itcReceivableCadMinor: effectiveItcCadMinor,
          commandReceipt: {
            schemaVersion: EXPENSES_RECEIPT_SCHEMA_VERSION,
            idempotencyKey,
            action: 'attach-receipt',
            commandFingerprint: fingerprint,
            result,
          },
        },
        createdAt: serverNow,
      });

      await tx.insertOutboxEvent({
        id: outboxEventId,
        organizationId,
        aggregateType: 'Expense',
        aggregateId: expenseId,
        eventType: 'ExpenseReceiptAttached',
        payloadJson: {
          expenseId,
          organizationId,
          itcReceivableCadMinor: effectiveItcCadMinor,
        },
        idempotencyKey: `${organizationId}:expense-receipt:${idempotencyKey}`,
        createdAt: serverNow,
      });

      return result;
    });
  }

  public settleDeferredAccrual(
    session: AuthSessionContext,
    command: SettleDeferredAccrualCommand,
  ): Promise<SettleDeferredAccrualResult>;
  public settleDeferredAccrual(
    session: AuthSessionContext,
    expenseId: string,
    settlement?: {
      readonly paidFromCashCustody?:
        | 'SETTLED_ORIGIN_CORP_BANK'
        | 'HELD_IN_OPERATOR_FLOAT';
      readonly custodyHolderUserId?: string | null;
      readonly idempotencyKey?: string;
      readonly deviceTimestamp?: string | Date;
    },
    commandMetadata?: {
      readonly idempotencyKey?: string;
      readonly deviceTimestamp?: string | Date;
    },
  ): Promise<SettleDeferredAccrualResult>;
  public async settleDeferredAccrual(
    session: AuthSessionContext,
    commandOrExpenseId: SettleDeferredAccrualCommand | string,
    settlement?: {
      readonly paidFromCashCustody?:
        | 'SETTLED_ORIGIN_CORP_BANK'
        | 'HELD_IN_OPERATOR_FLOAT';
      readonly custodyHolderUserId?: string | null;
      readonly idempotencyKey?: string;
      readonly deviceTimestamp?: string | Date;
    },
    commandMetadata?: {
      readonly idempotencyKey?: string;
      readonly deviceTimestamp?: string | Date;
    },
  ): Promise<SettleDeferredAccrualResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-EXP-01:update');
    if (session.role !== 'ARCHITECT_CFO') {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        'Only ARCHITECT_CFO may settle deferred ITA s. 78(1) accruals.',
      );
    }

    let rawInput: SettleDeferredAccrualCommand;
    if (typeof commandOrExpenseId === 'string') {
      if (
        settlement !== undefined &&
        (typeof settlement !== 'object' ||
          settlement === null ||
          Array.isArray(settlement))
      ) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Deferred accrual settlement options must be an object when provided.',
        );
      }
      if (
        settlement?.idempotencyKey !== undefined &&
        commandMetadata?.idempotencyKey !== undefined &&
        settlement.idempotencyKey.trim().toLowerCase() !==
          commandMetadata.idempotencyKey.trim().toLowerCase()
      ) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Conflicting idempotencyKey values between settlement and commandMetadata.',
        );
      }
      rawInput = {
        expenseId: commandOrExpenseId,
        ...(settlement ?? {}),
        ...(commandMetadata ?? {}),
        idempotencyKey:
          commandMetadata?.idempotencyKey ??
          settlement?.idempotencyKey ??
          this.nextUuid(),
      };
    } else {
      rawInput = commandOrExpenseId;
    }

    const parsed = SettleAccrualCommandSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const meta = parsed.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const expenseId = assertValidUuidParam(meta.expenseId, 'expenseId');
    const idempotencyKey = assertValidUuidParam(
      meta.idempotencyKey,
      'idempotencyKey',
    );
    const paidFromCashCustody: CashCustodyState =
      meta.paidFromCashCustody ?? 'SETTLED_ORIGIN_CORP_BANK';
    const requestedCustodyHolderId =
      meta.custodyHolderUserId !== undefined && meta.custodyHolderUserId !== null
        ? assertValidUuidParam(meta.custodyHolderUserId, 'custodyHolderUserId')
        : null;
    const custodyHolderUserId =
      paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT'
        ? (requestedCustodyHolderId ?? session.userId)
        : null;

    const fingerprint = computeExpenseCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'settle-accrual',
      payload: {
        expenseId,
        paidFromCashCustody,
        custodyHolderUserId:
          paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT'
            ? custodyHolderUserId
            : requestedCustodyHolderId,
      },
    });
    const receiptAuditId = deriveIssue9CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    return repository.withTenantTransaction(tenantCtx, async (tx) => {
      await tx.acquireOrganizationLock(organizationId);

      const [existingReceipt, existingExpense, existingTransfer] =
        await Promise.all([
          tx.findCommandReceipt(organizationId, receiptAuditId),
          tx.findExpenseByIdempotencyKey(organizationId, idempotencyKey),
          tx.findTransferByIdempotencyKey(organizationId, idempotencyKey),
        ]);
      const replayed = resolveIdempotentExpenseReplay({
        existingReceipt,
        expectedAction: 'settle-accrual',
        expectedIdempotencyKey: idempotencyKey,
        expectedFingerprint: fingerprint,
        hasConflictingRow:
          existingExpense !== null || existingTransfer !== null,
        validateResult: isValidSettleAccrualResult,
      });
      if (replayed) {
        return replayed;
      }

      if (
        paidFromCashCustody !== 'HELD_IN_OPERATOR_FLOAT' &&
        requestedCustodyHolderId !== null
      ) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'custodyHolderUserId is allowed only when settling from HELD_IN_OPERATOR_FLOAT.',
        );
      }

      const target = await tx.findAndLockExpense(organizationId, expenseId);
      if (!target) {
        throw new ExpenseError(
          'EXPENSE_NOT_FOUND',
          `Expense "${expenseId}" was not found in the active organization.`,
        );
      }
      if (!target.isDeferredIntercompanyAccrual || target.isReversalEntry) {
        throw new ExpenseError(
          'EXPENSE_NOT_DEFERRED_ACCRUAL',
          `Expense "${expenseId}" is not an unsettled deferred accrual.`,
        );
      }
      if (target.accrualSettledAt !== null) {
        throw new ExpenseError(
          'ACCRUAL_ALREADY_SETTLED',
          `Deferred accrual "${expenseId}" is already settled.`,
        );
      }
      const isReversed = await tx.hasReversalForExpense(
        organizationId,
        expenseId,
      );
      if (isReversed) {
        throw new ExpenseError(
          'EXPENSE_NOT_DEFERRED_ACCRUAL',
          `Deferred accrual "${expenseId}" has been reversed and cannot be settled.`,
        );
      }

      if (custodyHolderUserId !== null) {
        const holder = await tx.findActiveOrgMember(
          organizationId,
          custodyHolderUserId,
        );
        if (!holder) {
          throw new ExpenseError(
            'RECIPIENT_NOT_FOUND',
            `Custody holder "${custodyHolderUserId}" is not an active member of the organization.`,
          );
        }
        const policy = await loadPolicyInTx(tx, organizationId);
        const projection = await tx.loadPersistedSnapshot(organizationId, policy);
        const holderFloat =
          projection.snapshot.operatorFloatByUserId[custodyHolderUserId] ?? 0;
        if (target.amountCadMinor > holderFloat) {
          throw new ExpenseError(
            'INSUFFICIENT_OPERATOR_FLOAT',
            `Custody holder float (${holderFloat}) is insufficient to settle accrual (${target.amountCadMinor}).`,
          );
        }
      }

      const settledAt = this.clock.now();
      await tx.settleExpenseDeferredAccrual({
        organizationId,
        expenseId,
        accrualSettledAt: settledAt,
        paidFromCashCustody,
        custodyHolderUserId,
      });

      const updatedRecord: StoredExpenseRecord = {
        ...target,
        accrualSettledAt: settledAt,
        paidFromCashCustody,
        custodyHolderUserId,
      };
      const safeExpense = toSafeExpenseRow(updatedRecord);
      const outboxEventId = this.nextUuid();

      const result: SettleDeferredAccrualResult = {
        replayed: false,
        expense: safeExpense,
        auditLogId: receiptAuditId,
        outboxEventId,
      };

      await tx.insertAuditLog({
        id: receiptAuditId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'Expense',
        entityId: expenseId,
        action: EXPENSE_AUDIT_ACTIONS.SETTLE_ACCRUAL,
        previousState: {
          accrualSettledAt: null,
          paidFromCashCustody: target.paidFromCashCustody,
        },
        nextState: {
          accrualSettledAt: settledAt.toISOString(),
          paidFromCashCustody,
          custodyHolderUserId,
          commandReceipt: {
            schemaVersion: EXPENSES_RECEIPT_SCHEMA_VERSION,
            idempotencyKey,
            action: 'settle-accrual',
            commandFingerprint: fingerprint,
            result,
          },
        },
        createdAt: settledAt,
      });

      await tx.insertOutboxEvent({
        id: outboxEventId,
        organizationId,
        aggregateType: 'Expense',
        aggregateId: expenseId,
        eventType: 'DeferredAccrualSettled',
        payloadJson: {
          expenseId,
          organizationId,
          amountCadMinor: target.amountCadMinor,
          paidFromCashCustody,
          accrualSettledAt: settledAt.toISOString(),
        },
        idempotencyKey: `${organizationId}:accrual-settled:${idempotencyKey}`,
        createdAt: settledAt,
      });

      return result;
    });
  }
}

let defaultLogExpenseUseCaseFactory:
  | (() => Pick<LogExpenseUseCase, 'attachExpenseReceipt' | 'settleDeferredAccrual'>)
  | null = null;

export function registerDefaultLogExpenseUseCaseFactory(
  factory: () => Pick<
    LogExpenseUseCase,
    'attachExpenseReceipt' | 'settleDeferredAccrual'
  >,
): void {
  defaultLogExpenseUseCaseFactory = factory;
}

function resolveDefaultLogExpenseRunner(): Pick<
  LogExpenseUseCase,
  'attachExpenseReceipt' | 'settleDeferredAccrual'
> {
  if (!defaultLogExpenseUseCaseFactory) {
    throw new ExpenseError(
      'EXPENSE_INTEGRITY_ERROR',
      'No LogExpenseUseCase or ExpenseService provided and no production factory is registered.',
    );
  }
  return defaultLogExpenseUseCaseFactory();
}

export function attachExpenseReceipt(
  useCaseOrService: Pick<LogExpenseUseCase, 'attachExpenseReceipt'>,
  session: AuthSessionContext,
  command: AttachExpenseReceiptCommand,
): Promise<AttachExpenseReceiptResult>;
export function attachExpenseReceipt(
  useCaseOrService: Pick<LogExpenseUseCase, 'attachExpenseReceipt'>,
  session: AuthSessionContext,
  expenseId: string,
  receiptStorageKey: string,
  itcReceivableCadMinor?: number,
  commandMetadata?: {
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
): Promise<AttachExpenseReceiptResult>;
export function attachExpenseReceipt(
  session: AuthSessionContext,
  command: AttachExpenseReceiptCommand,
): Promise<AttachExpenseReceiptResult>;
export function attachExpenseReceipt(
  session: AuthSessionContext,
  expenseId: string,
  receiptStorageKey: string,
  itcReceivableCadMinor?: number,
  commandMetadata?: {
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
): Promise<AttachExpenseReceiptResult>;
export function attachExpenseReceipt(
  first:
    | Pick<LogExpenseUseCase, 'attachExpenseReceipt'>
    | AuthSessionContext,
  second: AuthSessionContext | AttachExpenseReceiptCommand | string,
  third?: AttachExpenseReceiptCommand | string,
  fourth?: string | number,
  fifth?:
    | number
    | {
        readonly idempotencyKey?: string;
        readonly deviceTimestamp?: string | Date;
      },
  sixth?: {
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
): Promise<AttachExpenseReceiptResult> {
  if (
    first &&
    typeof first === 'object' &&
    typeof (first as { attachExpenseReceipt?: unknown }).attachExpenseReceipt ===
      'function'
  ) {
    const runner = first as Pick<LogExpenseUseCase, 'attachExpenseReceipt'>;
    const session = second as AuthSessionContext;
    if (typeof third === 'string') {
      return runner.attachExpenseReceipt(
        session,
        third,
        fourth as string,
        fifth as number | undefined,
        sixth,
      );
    }
    return runner.attachExpenseReceipt(
      session,
      third as AttachExpenseReceiptCommand,
    );
  }

  const runner = resolveDefaultLogExpenseRunner();
  const session = first as AuthSessionContext;
  if (typeof second === 'string') {
    return runner.attachExpenseReceipt(
      session,
      second,
      third as string,
      fourth as number | undefined,
      fifth as
        | {
            readonly idempotencyKey?: string;
            readonly deviceTimestamp?: string | Date;
          }
        | undefined,
    );
  }
  return runner.attachExpenseReceipt(
    session,
    second as AttachExpenseReceiptCommand,
  );
}

export function settleDeferredAccrual(
  useCaseOrService: Pick<LogExpenseUseCase, 'settleDeferredAccrual'>,
  session: AuthSessionContext,
  command: SettleDeferredAccrualCommand,
): Promise<SettleDeferredAccrualResult>;
export function settleDeferredAccrual(
  useCaseOrService: Pick<LogExpenseUseCase, 'settleDeferredAccrual'>,
  session: AuthSessionContext,
  expenseId: string,
  settlement?: {
    readonly paidFromCashCustody?:
      | 'SETTLED_ORIGIN_CORP_BANK'
      | 'HELD_IN_OPERATOR_FLOAT';
    readonly custodyHolderUserId?: string | null;
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
  commandMetadata?: {
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
): Promise<SettleDeferredAccrualResult>;
export function settleDeferredAccrual(
  session: AuthSessionContext,
  command: SettleDeferredAccrualCommand,
): Promise<SettleDeferredAccrualResult>;
export function settleDeferredAccrual(
  session: AuthSessionContext,
  expenseId: string,
  settlement?: {
    readonly paidFromCashCustody?:
      | 'SETTLED_ORIGIN_CORP_BANK'
      | 'HELD_IN_OPERATOR_FLOAT';
    readonly custodyHolderUserId?: string | null;
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
  commandMetadata?: {
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
): Promise<SettleDeferredAccrualResult>;
export function settleDeferredAccrual(
  first:
    | Pick<LogExpenseUseCase, 'settleDeferredAccrual'>
    | AuthSessionContext,
  second: AuthSessionContext | SettleDeferredAccrualCommand | string,
  third?:
    | SettleDeferredAccrualCommand
    | string
    | {
        readonly paidFromCashCustody?:
          | 'SETTLED_ORIGIN_CORP_BANK'
          | 'HELD_IN_OPERATOR_FLOAT';
        readonly custodyHolderUserId?: string | null;
        readonly idempotencyKey?: string;
        readonly deviceTimestamp?: string | Date;
      },
  fourth?: {
    readonly paidFromCashCustody?:
      | 'SETTLED_ORIGIN_CORP_BANK'
      | 'HELD_IN_OPERATOR_FLOAT';
    readonly custodyHolderUserId?: string | null;
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
  fifth?: {
    readonly idempotencyKey?: string;
    readonly deviceTimestamp?: string | Date;
  },
): Promise<SettleDeferredAccrualResult> {
  if (
    first &&
    typeof first === 'object' &&
    typeof (first as { settleDeferredAccrual?: unknown })
      .settleDeferredAccrual === 'function'
  ) {
    const runner = first as Pick<LogExpenseUseCase, 'settleDeferredAccrual'>;
    const session = second as AuthSessionContext;
    if (typeof third === 'string') {
      return runner.settleDeferredAccrual(session, third, fourth, fifth);
    }
    return runner.settleDeferredAccrual(
      session,
      third as SettleDeferredAccrualCommand,
    );
  }

  const runner = resolveDefaultLogExpenseRunner();
  const session = first as AuthSessionContext;
  if (typeof second === 'string') {
    return runner.settleDeferredAccrual(
      session,
      second,
      third as
        | {
            readonly paidFromCashCustody?:
              | 'SETTLED_ORIGIN_CORP_BANK'
              | 'HELD_IN_OPERATOR_FLOAT';
            readonly custodyHolderUserId?: string | null;
            readonly idempotencyKey?: string;
            readonly deviceTimestamp?: string | Date;
          }
        | undefined,
      fourth,
    );
  }
  return runner.settleDeferredAccrual(
    session,
    second as SettleDeferredAccrualCommand,
  );
}
