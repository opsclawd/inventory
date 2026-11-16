import { randomUUID } from 'node:crypto';
import type { CurrencyCode, SaleMarketNode } from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
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
  computeExpenseCommandFingerprint,
  deriveIssue9CommandReceiptId,
  EXPENSE_AUDIT_ACTIONS,
  type ExpenseClock,
  ExpenseError,
  type ExpenseRepository,
  type ExpenseTx,
  type ExpenseUseCaseDeps,
  EXPENSES_RECEIPT_SCHEMA_VERSION,
  isPrismaUniqueViolation,
  MAX_EVIDENCE_BYTES,
  normalizeAndValidateEvidenceMime,
  parseStrictTimestamp,
  type RecordCashCustodyTransferCommand,
  type RecordCashCustodyTransferResult,
  RecordTransferMetadataSchema,
  resolveIdempotentExpenseReplay,
  type StoredCashCustodyTransferRecord,
  toSafeCashCustodyTransferRow,
} from './expenses.contracts';

async function loadPolicyInTx(
  tx: ExpenseTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

function isValidTransferResult(
  raw: unknown,
): raw is RecordCashCustodyTransferResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  const t = r.transfer as Record<string, unknown> | undefined;
  return (
    Boolean(t) &&
    typeof t?.id === 'string' &&
    typeof t?.transferCode === 'string' &&
    typeof t?.amountMinor === 'number' &&
    typeof r.auditLogId === 'string' &&
    typeof r.outboxEventId === 'string'
  );
}

export class RecordCashCustodyTransferUseCase {
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
    rawInput: RecordCashCustodyTransferCommand,
  ): Promise<RecordCashCustodyTransferResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-EXP-01:update');
    if (session.role !== 'ARCHITECT_CFO') {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        'Only ARCHITECT_CFO may record cash custody sweeps.',
      );
    }

    if (!rawInput || typeof rawInput !== 'object') {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        'Cash custody transfer command payload is required.',
      );
    }

    const { depositSlipBytes, depositSlipContentType, ...metadataRaw } =
      rawInput as RecordCashCustodyTransferCommand & Record<string, unknown>;

    const parsedMeta = RecordTransferMetadataSchema.safeParse(metadataRaw);
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

    const isOriginSweep =
      meta.fromCustodyState === 'HELD_IN_OPERATOR_FLOAT' &&
      meta.toCustodyState === 'SETTLED_ORIGIN_CORP_BANK';
    const isDestinationSweep =
      meta.fromCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
      meta.toCustodyState === 'DEPOSITED_DESTINATION_BANK';

    const expectedMarketNode: SaleMarketNode = isOriginSweep
      ? 'DOMESTIC_ORIGIN'
      : 'DESTINATION_EXPORT_VAULT';
    const marketNodeForFingerprint: SaleMarketNode =
      meta.marketNode ?? expectedMarketNode;
    const currencyForFingerprint: CurrencyCode | null = isOriginSweep
      ? (meta.currency ?? 'CAD')
      : (meta.currency ?? null);
    const amountMinor = meta.amountMinor;
    const equivalentCadMinorForFingerprint: number | null = isOriginSweep
      ? (meta.equivalentCadMinor ?? amountMinor)
      : (meta.equivalentCadMinor ?? null);

    const custodyHolderUserId = meta.custodyHolderUserId
      ? assertValidUuidParam(meta.custodyHolderUserId, 'custodyHolderUserId')
      : session.userId;

    const hasBytes = depositSlipBytes !== undefined;
    const suppliedKey = meta.depositSlipStorageKey ?? null;
    if (
      hasBytes &&
      depositSlipBytes instanceof Uint8Array &&
      depositSlipBytes.byteLength > MAX_EVIDENCE_BYTES
    ) {
      throw new ExpenseError(
        'PAYLOAD_TOO_LARGE',
        `Deposit slip payload exceeds maximum size of ${MAX_EVIDENCE_BYTES} bytes.`,
      );
    }

    const precomputedSha256: string | null =
      hasBytes &&
      depositSlipBytes instanceof Uint8Array &&
      depositSlipBytes.byteLength > 0
        ? computeSha256Hex(depositSlipBytes)
        : null;
    const rawMimeForFingerprint =
      hasBytes && typeof depositSlipContentType === 'string'
        ? (() => {
            const candidate =
              depositSlipContentType.split(';')[0]?.trim().toLowerCase() ?? '';
            return ALLOWED_EVIDENCE_MIME_TYPES.has(candidate)
              ? candidate
              : depositSlipContentType;
          })()
        : null;

    let transferredAtForFingerprint: string | null = null;
    if (meta.transferredAt !== undefined) {
      const parsedDate =
        meta.transferredAt instanceof Date
          ? new Date(meta.transferredAt.getTime())
          : new Date(meta.transferredAt);
      transferredAtForFingerprint = !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : String(meta.transferredAt);
    }

    const fingerprint = computeExpenseCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'record-transfer',
      payload: {
        marketNode: marketNodeForFingerprint,
        fromCustodyState: meta.fromCustodyState,
        toCustodyState: meta.toCustodyState,
        currency: currencyForFingerprint,
        amountMinor,
        equivalentCadMinor: equivalentCadMinorForFingerprint,
        custodyHolderUserId,
        commercialBankName: meta.commercialBankName ?? null,
        transferCode: meta.transferCode ?? null,
        depositSlipStorageKey: suppliedKey,
        depositSlipSha256Precomputed: precomputedSha256,
        depositSlipContentType: rawMimeForFingerprint,
        transferredAt: transferredAtForFingerprint,
      },
    });

    const validateTransferRules = (): {
      marketNode: SaleMarketNode;
      currency: CurrencyCode;
      equivalentCadMinor: number;
      normalizedMime: string | null;
      transferredAt: Date;
    } => {
      if (!isOriginSweep && !isDestinationSweep) {
        throw new ExpenseError(
          'INVALID_TRANSFER_PAIR',
          `Unsupported custody transfer pair ${meta.fromCustodyState} -> ${meta.toCustodyState}.`,
        );
      }

      const marketNode: SaleMarketNode = meta.marketNode ?? expectedMarketNode;
      if (marketNode !== expectedMarketNode) {
        throw new ExpenseError(
          'INVALID_TRANSFER_PAIR',
          `Transfer pair ${meta.fromCustodyState} -> ${meta.toCustodyState} requires marketNode ${expectedMarketNode}.`,
        );
      }

      const currency: CurrencyCode = isOriginSweep
        ? (meta.currency ?? 'CAD')
        : (() => {
            if (!meta.currency) {
              throw new ExpenseError(
                'INVALID_EXPENSE_INPUT',
                'Destination vault cash transfer requires explicit currency (TTD or USD).',
              );
            }
            return meta.currency;
          })();

      if (isOriginSweep && currency !== 'CAD') {
        throw new ExpenseError(
          'INVALID_TRANSFER_PAIR',
          'Origin operator float bank sweeps must be denominated in CAD.',
        );
      }
      if (isDestinationSweep && currency === 'CAD') {
        throw new ExpenseError(
          'INVALID_TRANSFER_PAIR',
          'Destination vault bank deposits must be denominated in TTD or USD.',
        );
      }

      const equivalentCadMinor = isOriginSweep
        ? (meta.equivalentCadMinor ?? amountMinor)
        : (() => {
            if (meta.equivalentCadMinor === undefined) {
              throw new ExpenseError(
                'INVALID_EXPENSE_INPUT',
                'Destination vault transfer requires explicit equivalentCadMinor.',
              );
            }
            return meta.equivalentCadMinor;
          })();

      if (isOriginSweep && equivalentCadMinor !== amountMinor) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'CAD origin sweep equivalentCadMinor must equal amountMinor.',
        );
      }

      let normalizedMime: string | null = null;
      if (hasBytes) {
        if (suppliedKey !== null) {
          throw new ExpenseError(
            'INVALID_EXPENSE_INPUT',
            'Provide either depositSlipBytes or depositSlipStorageKey, not both.',
          );
        }
        if (
          !(depositSlipBytes instanceof Uint8Array) ||
          depositSlipBytes.byteLength === 0
        ) {
          throw new ExpenseError(
            'DEPOSIT_SLIP_REQUIRED',
            'Private deposit slip bytes must be a non-empty binary payload.',
          );
        }
        if (depositSlipBytes.byteLength > MAX_EVIDENCE_BYTES) {
          throw new ExpenseError(
            'PAYLOAD_TOO_LARGE',
            `Deposit slip payload exceeds maximum size of ${MAX_EVIDENCE_BYTES} bytes.`,
          );
        }
        normalizedMime = normalizeAndValidateEvidenceMime(
          typeof depositSlipContentType === 'string'
            ? depositSlipContentType
            : '',
        );
      } else if (suppliedKey !== null) {
        assertValidPrivateEvidenceKey(suppliedKey, organizationId);
      } else {
        throw new ExpenseError(
          'DEPOSIT_SLIP_REQUIRED',
          'CashCustodyTransfer requires a private deposit slip upload or verified storage key.',
        );
      }

      const transferredAt =
        meta.transferredAt !== undefined
          ? parseStrictTimestamp(meta.transferredAt, 'transferredAt')
          : this.clock.now();

      return {
        marketNode,
        currency,
        equivalentCadMinor,
        normalizedMime,
        transferredAt,
      };
    };

    const receiptAuditId = deriveIssue9CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    const validateFundsInTx = async (
      tx: ExpenseTx,
      currency: CurrencyCode,
    ): Promise<void> => {
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

      if (isOriginSweep) {
        const holderFloat =
          projection.snapshot.operatorFloatByUserId[custodyHolderUserId] ?? 0;
        if (amountMinor > holderFloat) {
          throw new ExpenseError(
            'INSUFFICIENT_OPERATOR_FLOAT',
            `Sweep amount (${amountMinor}) exceeds holder "${custodyHolderUserId}" available float (${holderFloat}).`,
          );
        }
      } else {
        const availableVaultCash =
          projection.destinationVaultCashByCurrency[currency] ?? 0;
        if (amountMinor > availableVaultCash) {
          throw new ExpenseError(
            'INSUFFICIENT_VAULT_CASH',
            `Destination vault transfer (${amountMinor} ${currency}) exceeds available vault cash (${availableVaultCash} ${currency}).`,
          );
        }
      }
    };

    let uploadedKey: string | null = suppliedKey;
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
            expectedAction: 'record-transfer',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: fingerprint,
            hasConflictingRow:
              existingExpense !== null || existingTransfer !== null,
            validateResult: isValidTransferResult,
          });
          if (replayed) {
            return replayed;
          }
          const validated = validateTransferRules();
          preflightNormalizedMime = validated.normalizedMime;
          await validateFundsInTx(tx, validated.currency);
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
        evidence: depositSlipBytes!,
        contentType: preflightNormalizedMime!,
        auditContext: { correlationId: idempotencyKey },
      });
      uploadedKey = uploaded.storageKey;
    }

    const executeCommit = async (): Promise<RecordCashCustodyTransferResult> =>
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
          expectedAction: 'record-transfer',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: fingerprint,
          hasConflictingRow:
            existingExpense !== null || existingTransfer !== null,
          validateResult: isValidTransferResult,
        });
        if (replayed) {
          return replayed;
        }

        const validated = validateTransferRules();
        await validateFundsInTx(tx, validated.currency);

        const evidenceMeta = await tx.findVerifiedEvidenceMetadata(
          organizationId,
          uploadedKey!,
        );
        if (!evidenceMeta) {
          throw new ExpenseError(
            'INVALID_EVIDENCE_KEY',
            'Supplied depositSlipStorageKey does not reference a verified PRIVATE_EVIDENCE_UPLOADED record in this organization.',
          );
        }

        const transferId = this.nextUuid();
        const outboxEventId = this.nextUuid();
        const serverNow = this.clock.now();
        const transferCode =
          meta.transferCode ??
          `${isOriginSweep ? 'DROP-ONT' : 'DROP-POS'}-${transferId.slice(0, 8).toUpperCase()}`;

        const storedRecord: StoredCashCustodyTransferRecord = {
          id: transferId,
          organizationId,
          transferCode,
          marketNode: validated.marketNode,
          fromCustodyState: meta.fromCustodyState,
          toCustodyState: meta.toCustodyState,
          currency: validated.currency,
          amountMinor,
          equivalentCadMinor: validated.equivalentCadMinor,
          commercialBankName: meta.commercialBankName ?? null,
          depositSlipStorageKey: evidenceMeta.storageKey,
          recordedByUserId: tenantCtx.userId,
          custodyHolderUserId,
          idempotencyKey,
          transferredAt: validated.transferredAt,
          createdAt: serverNow,
        };

        await tx.insertCashCustodyTransfer({
          id: transferId,
          organizationId,
          transferCode,
          marketNode: validated.marketNode,
          fromCustodyState: meta.fromCustodyState,
          toCustodyState: meta.toCustodyState,
          currency: validated.currency,
          amountMinor,
          equivalentCadMinor: validated.equivalentCadMinor,
          commercialBankName: meta.commercialBankName ?? null,
          depositSlipStorageKey: evidenceMeta.storageKey,
          recordedByUserId: tenantCtx.userId,
          custodyHolderUserId,
          idempotencyKey,
          transferredAt: validated.transferredAt,
          createdAt: serverNow,
        });

        const safeTransfer = toSafeCashCustodyTransferRow(storedRecord);
        const result: RecordCashCustodyTransferResult = {
          replayed: false,
          transfer: safeTransfer,
          auditLogId: receiptAuditId,
          outboxEventId,
        };

        await tx.insertAuditLog({
          id: receiptAuditId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'CashCustodyTransfer',
          entityId: transferId,
          action: EXPENSE_AUDIT_ACTIONS.RECORD_TRANSFER,
          previousState: null,
          nextState: {
            transfer: safeTransfer,
            depositSlipSha256Hash: evidenceMeta.sha256Hash,
            commandReceipt: {
              schemaVersion: EXPENSES_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'record-transfer',
              commandFingerprint: fingerprint,
              result,
            },
          },
          createdAt: serverNow,
        });

        await tx.insertOutboxEvent({
          id: outboxEventId,
          organizationId,
          aggregateType: 'CashCustodyTransfer',
          aggregateId: transferId,
          eventType: 'CashCustodyTransferRecorded',
          payloadJson: {
            transferId,
            organizationId,
            fromCustodyState: meta.fromCustodyState,
            toCustodyState: meta.toCustodyState,
            currency: validated.currency,
            amountMinor,
            equivalentCadMinor: validated.equivalentCadMinor,
          },
          idempotencyKey: `${organizationId}:cash-transfer:${idempotencyKey}`,
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
            expectedAction: 'record-transfer',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: fingerprint,
            hasConflictingRow:
              existingExpense !== null || existingTransfer !== null,
            validateResult: isValidTransferResult,
          });
          if (replayed) {
            return replayed;
          }
          throw new ExpenseError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key or transferCode conflict while recording cash custody transfer.',
          );
        });
      }
      throw err;
    }
  }
}
