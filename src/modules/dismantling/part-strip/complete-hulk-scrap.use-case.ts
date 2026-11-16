import { randomUUID } from 'node:crypto';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  trueUpDonorCostBasis,
  validateVehicleLifecycleTransition,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import {
  assertCapability,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import { mergeComplianceWarnings } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import {
  assertValidUuidParam,
  CompleteHulkCommandSchema,
  type CompleteHulkCommand,
  type CompleteHulkResult,
  computeCommandFingerprint,
  computeDonorDirectCostLedger,
  deriveIssue8CommandReceiptId,
  isPrismaUniqueViolation,
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

function isValidCompleteHulkResult(raw: unknown): raw is CompleteHulkResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  return (
    typeof r.organizationId === 'string' &&
    typeof r.donorVehicleId === 'string' &&
    typeof r.lifecycleState === 'string' &&
    typeof r.bareShellScrapLogId === 'string' &&
    typeof r.scrapRecoveryCadMinor === 'number' &&
    typeof r.auditLogId === 'string' &&
    typeof r.scrappedClearedAt === 'string'
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

export class CompleteHulkScrapUseCase {
  private readonly repository?: PartStripRepository;
  private readonly clock: PartStripClock;
  private readonly idGenerator: () => string;

  public constructor(deps: PartStripUseCaseDeps = {}) {
    this.repository = deps.repository;
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
   * Finalizes donor `SCRAPPED_METAL_CLEARED` inside `withTenantTransaction`,
   * reusing an existing same-donor `BARE_STEEL_SHELL` ticket, evaluating catalytic
   * converter reconciliation (`WARN_ONLY` vs `STRICT_BLOCK`), and executing final
   * Stage 2 donor cost true-up.
   */
  public async execute(
    session: AuthSessionContext,
    rawInput: CompleteHulkCommand,
  ): Promise<CompleteHulkResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-02');

    const parsed = CompleteHulkCommandSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const input = parsed.data;
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const donorVehicleId = assertValidUuidParam(
      input.donorVehicleId,
      'donorVehicleId',
    );
    const bareShellScrapLogId = assertValidUuidParam(
      input.bareShellScrapLogId,
      'bareShellScrapLogId',
    );
    const idempotencyKey = assertValidUuidParam(
      input.idempotencyKey,
      'idempotencyKey',
    );
    const deviceTimestamp = parseStrictTimestamp(
      input.deviceTimestamp,
      'deviceTimestamp',
    );

    const commandFingerprint = computeCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'complete-hulk',
      payload: {
        donorVehicleId,
        donorExpectedVersion: input.donorExpectedVersion,
        bareShellScrapLogId,
      },
    });

    const receiptId = deriveIssue8CommandReceiptId(
      organizationId,
      idempotencyKey,
    );
    const repository = this.requireRepository();

    const executeTx = async (): Promise<CompleteHulkResult> =>
      repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const existingReceipt = await tx.findCommandReceipt(
          organizationId,
          receiptId,
        );
        const replayed = resolveIdempotentCommandReplay({
          existingReceipt,
          expectedAction: 'complete-hulk',
          expectedIdempotencyKey: idempotencyKey,
          expectedFingerprint: commandFingerprint,
          hasConflictingCustodyEvent: false,
          validateResult: isValidCompleteHulkResult,
        });
        if (replayed) {
          return replayed;
        }

        const policy = await loadPolicyInTx(tx, organizationId);
        const donor = await tx.findAndLockDonorVehicle(
          organizationId,
          donorVehicleId,
        );
        if (!donor) {
          throw new PartStripError(
            'ENTITY_NOT_FOUND',
            `Donor vehicle "${donorVehicleId}" was not found in the active organization.`,
          );
        }

        if (donor.version !== input.donorExpectedVersion) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            `Donor vehicle version conflict: expected ${input.donorExpectedVersion}, found ${donor.version}.`,
          );
        }

        const shellLog = await tx.findScrapLogById(
          organizationId,
          bareShellScrapLogId,
        );
        if (!shellLog) {
          throw new PartStripError(
            'ENTITY_NOT_FOUND',
            `Bare steel shell scrap log "${bareShellScrapLogId}" was not found in the active organization.`,
          );
        }
        if (
          shellLog.donorVehicleId !== donor.id ||
          shellLog.stream !== 'BARE_STEEL_SHELL'
        ) {
          throw new PartStripError(
            'SCRAP_LOG_MISMATCH',
            'Referenced scrap log must be a BARE_STEEL_SHELL log belonging to the target donor vehicle.',
          );
        }

        const [parts, expenses, scrapLogs] = await Promise.all([
          tx.findAndLockDonorParts(organizationId, donor.id),
          tx.listDonorExpenses(organizationId, donor.id),
          tx.listDonorScrapLogs(organizationId, donor.id),
        ]);

        const hasCatalyticConverterScrapLog = scrapLogs.some(
          (l) => l.stream === 'CATALYTIC_CONVERTER',
        );
        const enforcementMode =
          policy.operationalGates.complianceEnforcementMode;

        let intermediateAwaitingScrap = false;
        let finalTransition: ReturnType<
          typeof validateVehicleLifecycleTransition
        >;

        if (donor.lifecycleState === 'DISMANTLING_IN_PROGRESS') {
          validateVehicleLifecycleTransition(
            'DISMANTLING_IN_PROGRESS',
            'HULK_AWAITING_SCRAP',
            {
              assetCategory: donor.assetCategory,
              operationalLane: donor.operationalLane,
              complianceEnforcementMode: enforcementMode,
            },
          );
          intermediateAwaitingScrap = true;
          finalTransition = validateVehicleLifecycleTransition(
            'HULK_AWAITING_SCRAP',
            'SCRAPPED_METAL_CLEARED',
            {
              assetCategory: donor.assetCategory,
              operationalLane: donor.operationalLane,
              scrapMetalTicketKey: shellLog.recyclerTicketStorageKey,
              catalyticConverterDisposition:
                donor.catalyticConverterDisposition,
              hasCatalyticConverterScrapLog,
              complianceEnforcementMode: enforcementMode,
            },
          );
        } else if (donor.lifecycleState === 'HULK_AWAITING_SCRAP') {
          finalTransition = validateVehicleLifecycleTransition(
            'HULK_AWAITING_SCRAP',
            'SCRAPPED_METAL_CLEARED',
            {
              assetCategory: donor.assetCategory,
              operationalLane: donor.operationalLane,
              scrapMetalTicketKey: shellLog.recyclerTicketStorageKey,
              catalyticConverterDisposition:
                donor.catalyticConverterDisposition,
              hasCatalyticConverterScrapLog,
              complianceEnforcementMode: enforcementMode,
            },
          );
        } else {
          finalTransition = validateVehicleLifecycleTransition(
            donor.lifecycleState,
            'SCRAPPED_METAL_CLEARED',
            {
              assetCategory: donor.assetCategory,
              operationalLane: donor.operationalLane,
              scrapMetalTicketKey: shellLog.recyclerTicketStorageKey,
              catalyticConverterDisposition:
                donor.catalyticConverterDisposition,
              hasCatalyticConverterScrapLog,
              complianceEnforcementMode: enforcementMode,
            },
          );
        }

        const costLedger = computeDonorDirectCostLedger({
          donorVehicleId: donor.id,
          actualPurchasePriceCadMinor: donor.actualPurchasePriceCadMinor,
          expenses,
        });

        const partitioned = partitionDonorPartsForTrueUp({
          organizationId: donor.organizationId,
          donorVehicleId: donor.id,
          parts,
          policy,
        });

        const trueUp = trueUpDonorCostBasis({
          organizationId: donor.organizationId,
          donorVehicleId: donor.id,
          actualPurchasePriceCadMinor: costLedger.actualPurchasePriceCadMinor,
          loggedDirectExpensesCadMinor:
            costLedger.loggedDirectExpensesCadMinor,
          scrapLogs: scrapLogs.map((s) => ({
            id: s.id,
            organizationId: s.organizationId,
            donorVehicleId: s.donorVehicleId,
            stream: s.stream,
            payoutCadMinor: s.payoutCadMinor,
          })),
          soldParts: partitioned.soldParts,
          unsoldParts: partitioned.unsoldParts,
        });

        const now = this.clock.now();
        const updatedPartIds: string[] = [];
        const adjustablePartAllocationsAudit: Array<{
          readonly partId: string;
          readonly oldAllocatedCostCadMinor: number;
          readonly newAllocatedCostCadMinor: number;
        }> = [];

        for (const row of trueUp.unsoldAllocations) {
          const oldCost = partitioned.existingCostByPartId.get(row.partId) ?? 0;
          const oldVersion = partitioned.existingVersionByPartId.get(
            row.partId,
          );
          adjustablePartAllocationsAudit.push({
            partId: row.partId,
            oldAllocatedCostCadMinor: oldCost,
            newAllocatedCostCadMinor: row.allocatedCostBasisCadMinor,
          });
          if (
            oldVersion !== undefined &&
            oldCost !== row.allocatedCostBasisCadMinor
          ) {
            const ok = await tx.updatePartCostBasis({
              organizationId,
              partId: row.partId,
              expectedCurrentVersion: oldVersion,
              nextVersion: oldVersion + 1,
              allocatedCostBasisCadMinor: row.allocatedCostBasisCadMinor,
              updatedAt: now,
            });
            if (!ok) {
              throw new PartStripError(
                'VERSION_CONFLICT',
                `Concurrent modification detected on part "${row.partId}" during hulk finalization.`,
              );
            }
            updatedPartIds.push(row.partId);
          }
        }

        const nextWarnings = mergeComplianceWarnings(
          donor.complianceWarnings,
          finalTransition.warnings,
        );
        const nextDonorVersion = donor.version + 1;

        const donorUpdated = await tx.updateDonorVehicle({
          organizationId,
          donorVehicleId: donor.id,
          expectedCurrentVersion: donor.version,
          nextVersion: nextDonorVersion,
          lifecycleState: finalTransition.nextState,
          scrapMetalTicketKey: shellLog.recyclerTicketStorageKey,
          scrapRecoveryCadMinor: trueUp.scrapRecoveryCadMinor,
          scrappedClearedAt: now,
          complianceWarnings: nextWarnings,
          updatedAt: now,
        });
        if (!donorUpdated) {
          throw new PartStripError(
            'VERSION_CONFLICT',
            'Donor vehicle version changed concurrently during hulk clearance.',
          );
        }

        if (intermediateAwaitingScrap) {
          await tx.insertAuditLog({
            id: this.nextUuid(),
            organizationId,
            actorUserId: tenantCtx.userId,
            entityType: 'Vehicle',
            entityId: donor.id,
            action: PART_STRIP_AUDIT_ACTIONS.HULK_AWAITING_SCRAP,
            previousState: {
              lifecycleState: 'DISMANTLING_IN_PROGRESS',
              version: donor.version,
            },
            nextState: {
              lifecycleState: 'HULK_AWAITING_SCRAP',
              bareShellScrapLogId: shellLog.id,
            },
            createdAt: now,
          });
        }

        const result: CompleteHulkResult = {
          replayed: false,
          organizationId,
          donorVehicleId: donor.id,
          lifecycleState: finalTransition.nextState,
          donorVersion: nextDonorVersion,
          bareShellScrapLogId: shellLog.id,
          scrapRecoveryCadMinor: trueUp.scrapRecoveryCadMinor,
          remainingCostBasisToAllocateCadMinor:
            trueUp.remainingCostBasisToAllocateCadMinor,
          updatedPartIds,
          complianceWarnings: nextWarnings,
          auditLogId: receiptId,
          scrappedClearedAt: now.toISOString(),
        };

        await tx.insertAuditLog({
          id: receiptId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: 'Vehicle',
          entityId: donor.id,
          action: PART_STRIP_AUDIT_ACTIONS.COMPLETE_HULK,
          previousState: {
            lifecycleState: donor.lifecycleState,
            scrapMetalTicketKey: donor.scrapMetalTicketKey,
            scrapRecoveryCadMinor: donor.scrapRecoveryCadMinor,
            version: donor.version,
          },
          nextState: {
            commandReceipt: {
              schemaVersion: PART_STRIP_RECEIPT_SCHEMA_VERSION,
              idempotencyKey,
              action: 'complete-hulk',
              commandFingerprint,
              result,
            },
            bareShellScrapLogId: shellLog.id,
            scrapMetalTicketKey: shellLog.recyclerTicketStorageKey,
            fixedPartIds: partitioned.soldParts.map((p) => p.partId),
            adjustablePartAllocations: adjustablePartAllocationsAudit,
          },
          createdAt: now,
        });

        return result;
      });

    try {
      return await executeTx();
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
            expectedAction: 'complete-hulk',
            expectedIdempotencyKey: idempotencyKey,
            expectedFingerprint: commandFingerprint,
            hasConflictingCustodyEvent: false,
            validateResult: isValidCompleteHulkResult,
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
}
