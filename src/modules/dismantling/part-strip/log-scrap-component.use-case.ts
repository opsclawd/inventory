import { randomUUID } from 'node:crypto';
import type {
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
} from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  trueUpDonorCostBasis,
  validateVehicleLifecycleTransition,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import type { IStoragePort } from '@/core/ports/storage.port';
import {
  assertCapability,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import { computeSha256Hex } from '@/modules/shared-ops/storage';
import {
  assertValidUuidParam,
  computeCommandFingerprint,
  computeDonorDirectCostLedger,
  deriveIssue8CommandReceiptId,
  isPrismaUniqueViolation,
  type LockedDonorExpenseRow,
  type LockedDonorPartRow,
  type LockedDonorVehicleRow,
  type LockedScrapLogRow,
  type LogScrapCommand,
  LogScrapMetadataSchema,
  type LogScrapResult,
  MAX_SCRAP_TICKET_BYTES,
  PART_STRIP_AUDIT_ACTIONS,
  PART_STRIP_RECEIPT_SCHEMA_VERSION,
  parseStrictTimestamp,
  partitionDonorPartsForTrueUp,
  type PartStripClock,
  PartStripError,
  type PartStripRepository,
  type PartStripTx,
  type PartStripUseCaseDeps,
  resolveIdempotentCommandReplay,
} from './part-strip.contracts';

const ALLOWED_TICKET_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

function normalizeAndValidateTicketMime(rawType: string): string {
  const mime = rawType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_TICKET_MIME_TYPES.has(mime)) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `Scrap ticket contentType "${rawType}" must be image/jpeg, image/png, image/webp, or application/pdf.`,
    );
  }
  return mime;
}

function isValidLogScrapResult(raw: unknown): raw is LogScrapResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    typeof r.scrapLogId === 'string' &&
    typeof r.organizationId === 'string' &&
    typeof r.donorVehicleId === 'string' &&
    typeof r.scrapStream === 'string' &&
    typeof r.payoutCadMinor === 'number' &&
    typeof r.cashCustodyState === 'string' &&
    typeof r.scrapRecoveryCadMinor === 'number' &&
    typeof r.auditLogId === 'string'
  );
}

async function loadPolicyInTx(
  tx: PartStripTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

export class LogScrapComponentUseCase {
  private readonly repository?: PartStripRepository;
  private readonly storage?: IStoragePort;
  private readonly clock: PartStripClock;
  private readonly idGenerator: () => string;

  public constructor(deps: PartStripUseCaseDeps = {}) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
  }

  private requireRepository(): PartStripRepository {
    if (!this.repository) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'PartStripRepository dependency is required.',
      );
    }
    return this.repository;
  }

  private requireStorage(): IStoragePort {
    if (!this.storage) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'IStoragePort dependency is required.',
      );
    }
    return this.storage;
  }

  private nextUuid(): string {
    const id = this.idGenerator();
    if (!isValidUuid(id)) {
      throw new PartStripError(
        'PART_STRIP_INTEGRITY_ERROR',
        'idGenerator must produce a valid UUID string.',
      );
    }
    return id.toLowerCase();
  }

  /**
   * Logs an immutable 5-stream `ScrapComponentLog` inside `withTenantTransaction`,
   * enforcing float vs. confirmed-bank cash custody separation (`FIX 05`), catalytic
   * disposition consistency, and incremental Stage 2 donor cost true-up.
   */
  public async execute(
    session: AuthSessionContext,
    rawInput: LogScrapCommand,
  ): Promise<LogScrapResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');

    if (!rawInput || typeof rawInput !== 'object') {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Log scrap command payload is required.',
      );
    }

    const { ticketBytes, ticketContentType, ...metadataRaw } =
      rawInput as LogScrapCommand & Record<string, unknown>;

    const parsedMeta = LogScrapMetadataSchema.safeParse(metadataRaw);
    if (!parsedMeta.success) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        parsedMeta.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    if (!(ticketBytes instanceof Uint8Array) || ticketBytes.byteLength === 0) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Private recycler ticket bytes must be a non-empty binary payload.',
      );
    }
    if (ticketBytes.byteLength > MAX_SCRAP_TICKET_BYTES) {
      throw new PartStripError(
        'PAYLOAD_TOO_LARGE',
        `Recycler ticket exceeds maximum size of ${MAX_SCRAP_TICKET_BYTES} bytes.`,
      );
    }
    const normalizedMime = normalizeAndValidateTicketMime(
      typeof ticketContentType === 'string' ? ticketContentType : '',
    );
    const ticketSha256Precomputed = computeSha256Hex(ticketBytes);

    const meta = parsedMeta.data;
    const bankDepositReference = meta.bankDepositReference ?? null;

    if (meta.paymentReceiptMode === 'CASH') {
      if (meta.bankDepositConfirmed === true || bankDepositReference !== null) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'CASH scrap receipt mode cannot include bankDepositConfirmed or bankDepositReference.',
        );
      }
    } else {
      if (meta.bankDepositConfirmed !== true || !bankDepositReference) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'CONFIRMED_BANK_DEPOSIT requires bankDepositConfirmed=true and a non-empty bankDepositReference.',
        );
      }
    }

    const cashCustodyState: CashCustodyState =
      meta.paymentReceiptMode === 'CASH'
        ? 'HELD_IN_OPERATOR_FLOAT'
        : 'SETTLED_ORIGIN_CORP_BANK';

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const donorVehicleId = assertValidUuidParam(
      meta.donorVehicleId,
      'donorVehicleId',
    );
    const idempotencyKey = assertValidUuidParam(
      meta.idempotencyKey,
      'idempotencyKey',
    );
    const deviceTimestamp = parseStrictTimestamp(
      meta.deviceTimestamp,
      'deviceTimestamp',
    );

    const commandFingerprint = computeCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'log-scrap',
      payload: {
        donorVehicleId,
        donorExpectedVersion: meta.donorExpectedVersion,
        scrapStream: meta.scrapStream,
        weightKg: meta.weightKg,
        payoutCadMinor: meta.payoutCadMinor,
        recyclerName: meta.recyclerName,
        paymentReceiptMode: meta.paymentReceiptMode,
        bankDepositConfirmed: meta.bankDepositConfirmed ?? false,
        bankDepositReference,
        ticketSha256Precomputed,
        ticketContentType: normalizedMime,
      },
    });

    const receiptId = deriveIssue8CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();
    const storage = this.requireStorage();

    // 1. Short authorized preflight before uploading private evidence
    const preflightReplay = await repository.withTenantTransaction(
      tenantCtx,
      async (tx) => {
        const existingReceipt = await tx.findCommandReceipt(
          organizationId,
          receiptId,
        );
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'log-scrap',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: false,
          validateResult: isValidLogScrapResult,
        });
        if (replayed) {
          return replayed;
        }

        const [policy, donor, parts, expenses, scrapLogs] = await Promise.all([
          loadPolicyInTx(tx, organizationId),
          tx.findAndLockDonorVehicle(organizationId, donorVehicleId),
          tx.findAndLockDonorParts(organizationId, donorVehicleId),
          tx.listDonorExpenses(organizationId, donorVehicleId),
          tx.listDonorScrapLogs(organizationId, donorVehicleId),
        ]);

        this.evaluateScrapPreconditionsAndTrueUp({
          donor,
          donorExpectedVersion: meta.donorExpectedVersion,
          scrapStream: meta.scrapStream,
          payoutCadMinor: meta.payoutCadMinor,
          provisionalScrapLogId: '00000000-0000-4000-8000-000000000000',
          parts,
          expenses,
          scrapLogs,
          policy,
        });

        return null;
      },
    );

    if (preflightReplay) {
      return preflightReplay;
    }

    // 2. Upload private recycler ticket outside any DB transaction
    const uploadedTicket = await storage.uploadPrivateEvidence({
      actor: session,
      organizationId,
      evidence: ticketBytes,
      contentType: normalizedMime,
      auditContext: { correlationId: idempotencyKey },
    });

    // 3. Final locked atomic transaction
    const commitScrap = async (): Promise<LogScrapResult> =>
      repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const existingReceipt = await tx.findCommandReceipt(
          organizationId,
          receiptId,
        );
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'log-scrap',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: false,
          validateResult: isValidLogScrapResult,
        });
        if (replayed) {
          return replayed;
        }

        const policy = await loadPolicyInTx(tx, organizationId);
        const donor = await tx.findAndLockDonorVehicle(
          organizationId,
          donorVehicleId,
        );
        const parts = await tx.findAndLockDonorParts(
          organizationId,
          donorVehicleId,
        );
        const expenses = await tx.listDonorExpenses(
          organizationId,
          donorVehicleId,
        );
        const scrapLogs = await tx.listDonorScrapLogs(
          organizationId,
          donorVehicleId,
        );

        const scrapLogId = this.nextUuid();
        const now = this.clock.now();

        const evaluated = this.evaluateScrapPreconditionsAndTrueUp({
          donor,
          donorExpectedVersion: meta.donorExpectedVersion,
          scrapStream: meta.scrapStream,
          payoutCadMinor: meta.payoutCadMinor,
          provisionalScrapLogId: scrapLogId,
          parts,
          expenses,
          scrapLogs,
          policy,
        });

        await tx.insertScrapComponentLog({
          id: scrapLogId,
          organizationId,
          vehicleId: evaluated.donor.id,
          scrapStream: meta.scrapStream,
          weightKg: meta.weightKg,
          payoutCadMinor: meta.payoutCadMinor,
          recyclerName: meta.recyclerName,
          recyclerTicketStorageKey: uploadedTicket.storageKey,
          cashCustodyState,
          recordedByUserId: tenantCtx.userId,
          createdAt: now,
        });

        const updatedPartIds: string[] = [];
        for (const update of evaluated.adjustablePartUpdates) {
          const ok = await tx.updatePartCostBasis({
            organizationId,
            partId: update.partId,
            expectedCurrentVersion: update.expectedCurrentVersion,
            nextVersion: update.expectedCurrentVersion + 1,
            allocatedCostBasisCadMinor: update.newAllocatedCostCadMinor,
            updatedAt: now,
          });
          if (!ok) {
            throw new PartStripError(
              'VERSION_CONFLICT',
              `Concurrent modification detected on part "${update.partId}" during scrap cost true-up.`,
            );
          }
          updatedPartIds.push(update.partId);
        }

        const nextDonorVersion = evaluated.donor.version + 1;
        const donorUpdated = await tx.updateDonorVehicle({
          organizationId,
          donorVehicleId: evaluated.donor.id,
          expectedCurrentVersion: evaluated.donor.version,
          nextVersion: nextDonorVersion,
          lifecycleState: evaluated.nextDonorLifecycleState,
          catalyticConverterDisposition: evaluated.nextCatDisposition,
          scrapRecoveryCadMinor: evaluated.scrapRecoveryCadMinor,
          updatedAt: now,
        });
        if (!donorUpdated) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            'Donor vehicle version changed concurrently during scrap logging.',
          );
        }

        if (evaluated.nextDonorLifecycleState !== undefined) {
          await tx.insertAuditLog({
            id: this.nextUuid(),
            organizationId,
            actorUserId: tenantCtx.userId,
            entityType: 'Vehicle',
            entityId: evaluated.donor.id,
            action: PART_STRIP_AUDIT_ACTIONS.DONOR_DISMANTLING_STARTED,
            previousState: {
              lifecycleState: evaluated.donor.lifecycleState,
              version: evaluated.donor.version,
            },
            nextState: {
              lifecycleState: evaluated.nextDonorLifecycleState,
              version: nextDonorVersion,
              triggeredByScrapLogId: scrapLogId,
            },
            createdAt: now,
          });
        }

        const finalLifecycleState =
          evaluated.nextDonorLifecycleState ?? evaluated.donor.lifecycleState;
        const finalCatDisposition =
          evaluated.nextCatDisposition ??
          evaluated.donor.catalyticConverterDisposition;

        const result: LogScrapResult = {
          replayed: false,
          scrapLogId,
          organizationId,
          donorVehicleId: evaluated.donor.id,
          donorLifecycleState: finalLifecycleState,
          donorVersion: nextDonorVersion,
          catalyticConverterDisposition: finalCatDisposition,
          scrapStream: meta.scrapStream,
          payoutCadMinor: meta.payoutCadMinor,
          cashCustodyState,
          recyclerTicketSha256Hash: uploadedTicket.sha256Hash,
          scrapRecoveryCadMinor: evaluated.scrapRecoveryCadMinor,
          remainingCostBasisToAllocateCadMinor:
            evaluated.remainingCostBasisToAllocateCadMinor,
          updatedPartIds,
          auditLogId: receiptId,
          createdAt: now.toISOString(),
        };

        await tx.insertAuditLog({
          id: receiptId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'ScrapComponentLog',
          entityId: scrapLogId,
          action: PART_STRIP_AUDIT_ACTIONS.LOG_SCRAP,
          previousState: {
            donorScrapRecoveryCadMinor: evaluated.donor.scrapRecoveryCadMinor,
            catalyticConverterDisposition:
              evaluated.donor.catalyticConverterDisposition,
            donorVersion: evaluated.donor.version,
          },
          nextState: {
            commandReceipt: {
              schemaVersion: PART_STRIP_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'log-scrap',
              commandFingerprint,
              result,
            },
            recyclerTicketStorageKey: uploadedTicket.storageKey,
            recyclerTicketSha256Hash: uploadedTicket.sha256Hash,
            bankDepositConfirmed:
              meta.paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT',
            bankDepositReference,
            fixedPartIds: evaluated.fixedPartIds,
            adjustablePartAllocations: evaluated.adjustablePartAllocationsAudit,
          },
          createdAt: now,
        });

        return result;
      });

    try {
      return await commitScrap();
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        return repository.withTenantTransaction(tenantCtx, async (tx) => {
          await tx.acquireOrganizationLock(organizationId);
          const existingReceipt = await tx.findCommandReceipt(
            organizationId,
            receiptId,
          );
          const resolved = resolveIdempotentCommandReplay({
            existingReceipt,
            expectedAction: 'log-scrap',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: commandFingerprint,
            hasConflictingCustodyEvent: false,
            validateResult: isValidLogScrapResult,
          });
          if (!resolved) {
            throw new PartStripError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key conflicted with a concurrent operation.',
            );
          }
          return resolved;
        });
      }
      throw error;
    }
  }

  private evaluateScrapPreconditionsAndTrueUp(params: {
    readonly donor: LockedDonorVehicleRow | null;
    readonly donorExpectedVersion: number;
    readonly scrapStream: LogScrapCommand['scrapStream'];
    readonly payoutCadMinor: number;
    readonly provisionalScrapLogId: string;
    readonly parts: readonly LockedDonorPartRow[];
    readonly expenses: readonly LockedDonorExpenseRow[];
    readonly scrapLogs: readonly LockedScrapLogRow[];
    readonly policy: PricingAndCompliancePolicy;
  }) {
    const { donor, policy } = params;
    if (!donor) {
      throw new PartStripError(
        'ENTITY_NOT_FOUND',
        'Donor vehicle was not found in the active organization.',
      );
    }
    if (donor.version !== params.donorExpectedVersion) {
      throw new PartStripError(
        'VERSION_CONFLICT',
        `Donor vehicle version conflict: expected ${params.donorExpectedVersion}, found ${donor.version}.`,
      );
    }

    let nextDonorLifecycleState: AssetLifecycleState | undefined;
    if (donor.lifecycleState === 'STAGED_ONTARIO_YARD') {
      const activation = validateVehicleLifecycleTransition(
        donor.lifecycleState,
        'DISMANTLING_IN_PROGRESS',
        {
          assetCategory: donor.assetCategory,
          operationalLane: donor.operationalLane,
          complianceEnforcementMode:
            policy.operationalGates.complianceEnforcementMode,
        },
      );
      nextDonorLifecycleState = activation.nextState;
    } else if (
      donor.lifecycleState !== 'DISMANTLING_IN_PROGRESS' &&
      donor.lifecycleState !== 'HULK_AWAITING_SCRAP'
    ) {
      validateVehicleLifecycleTransition(
        donor.lifecycleState,
        'DISMANTLING_IN_PROGRESS',
        {
          assetCategory: donor.assetCategory,
          operationalLane: donor.operationalLane,
          complianceEnforcementMode:
            policy.operationalGates.complianceEnforcementMode,
        },
      );
    }

    let nextCatDisposition: CatalyticConverterDisposition | undefined;
    if (params.scrapStream === 'CATALYTIC_CONVERTER') {
      if (
        donor.catalyticConverterDisposition === 'MISSING_AT_INTAKE' ||
        donor.catalyticConverterDisposition === 'SHELVED_AS_PART'
      ) {
        throw new PartStripError(
          'CATALYTIC_DISPOSITION_CONFLICT',
          `Cannot log CATALYTIC_CONVERTER scrap sale when donor disposition is "${donor.catalyticConverterDisposition}".`,
        );
      }
      if (donor.catalyticConverterDisposition === 'PRESENT_AT_INTAKE') {
        nextCatDisposition = 'LOGGED_SCRAP_SALE';
      }
    }

    const costLedger = computeDonorDirectCostLedger({
      donorVehicleId: donor.id,
      actualPurchasePriceCadMinor: donor.actualPurchasePriceCadMinor,
      expenses: params.expenses,
    });

    const partitioned = partitionDonorPartsForTrueUp({
      organizationId: donor.organizationId,
      donorVehicleId: donor.id,
      parts: params.parts,
      policy,
    });

    const allScrapEntries = [
      ...params.scrapLogs.map((s) => ({
        id: s.id,
        organizationId: s.organizationId,
        donorVehicleId: s.donorVehicleId,
        stream: s.stream,
        payoutCadMinor: s.payoutCadMinor,
      })),
      {
        id: params.provisionalScrapLogId,
        organizationId: donor.organizationId,
        donorVehicleId: donor.id,
        stream: params.scrapStream,
        payoutCadMinor: params.payoutCadMinor,
      },
    ];

    const trueUp = trueUpDonorCostBasis({
      organizationId: donor.organizationId,
      donorVehicleId: donor.id,
      actualPurchasePriceCadMinor: costLedger.actualPurchasePriceCadMinor,
      loggedDirectExpensesCadMinor: costLedger.loggedDirectExpensesCadMinor,
      scrapLogs: allScrapEntries,
      soldParts: partitioned.soldParts,
      unsoldParts: partitioned.unsoldParts,
    });

    const adjustablePartUpdates: Array<{
      readonly partId: string;
      readonly expectedCurrentVersion: number;
      readonly newAllocatedCostCadMinor: number;
    }> = [];
    const adjustablePartAllocationsAudit: Array<{
      readonly partId: string;
      readonly oldAllocatedCostCadMinor: number;
      readonly newAllocatedCostCadMinor: number;
    }> = [];

    for (const row of trueUp.unsoldAllocations) {
      const oldCost = partitioned.existingCostByPartId.get(row.partId) ?? 0;
      const oldVersion = partitioned.existingVersionByPartId.get(row.partId);
      adjustablePartAllocationsAudit.push({
        partId: row.partId,
        oldAllocatedCostCadMinor: oldCost,
        newAllocatedCostCadMinor: row.allocatedCostBasisCadMinor,
      });
      if (
        oldVersion !== undefined &&
        oldCost !== row.allocatedCostBasisCadMinor
      ) {
        adjustablePartUpdates.push({
          partId: row.partId,
          expectedCurrentVersion: oldVersion,
          newAllocatedCostCadMinor: row.allocatedCostBasisCadMinor,
        });
      }
    }

    return {
      donor,
      nextDonorLifecycleState,
      nextCatDisposition,
      scrapRecoveryCadMinor: trueUp.scrapRecoveryCadMinor,
      remainingCostBasisToAllocateCadMinor:
        trueUp.remainingCostBasisToAllocateCadMinor,
      fixedPartIds: partitioned.soldParts.map((p) => p.partId),
      adjustablePartUpdates,
      adjustablePartAllocationsAudit,
    };
  }
}
