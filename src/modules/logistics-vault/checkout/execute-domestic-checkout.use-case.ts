import { createHash, randomUUID } from 'node:crypto';
import type {
  CashCustodyState,
  PaymentSettlementState,
} from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  assertEbayParcelHazmatEligible,
  checkedAdd,
  computeDriveOnTimers,
  computeDomesticSaleTaxAndSettlement,
  computeRefundTaxAdjustment,
  DomainRuleError,
  evaluateCheckoutPriceFloor,
  evaluateLocationCustodyCheck,
  evaluateRegulatoryComplianceCheck,
  type PartStateSnapshot,
  parseUtcDate,
  type TrustedCfoApprovalInput,
  validatePartTransition,
  validatePaymentSettlementInvariants,
  validatePaymentSettlementTransition,
  validateVehicleLifecycleTransition,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import {
  resolvePartPrice,
  resolveVehiclePrice,
  type ResolvedPrice,
} from '@/modules/marketplace/syndication/syndication-input-resolver';
import {
  assertCapability,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import { assertValidPrivateEvidenceKey } from '@/modules/shared-ops/storage';
import {
  CHECKOUT_AUDIT_ACTIONS,
  CHECKOUT_RECEIPT_SCHEMA_VERSION,
  type CheckoutLockedPartRow,
  type CheckoutLockedVehicleRow,
  type CheckoutLookupItemSummary,
  computeCheckoutCommandFingerprint,
  type ConfirmBankSettlementCommand,
  type ConfirmBankSettlementResult,
  deriveCheckoutReceiptId,
  DomesticCheckoutError,
  type DomesticCheckoutRepository,
  type DomesticCheckoutTx,
  type ExecuteDomesticCheckoutCommand,
  ExecuteDomesticCheckoutSchema,
  type ExecuteDomesticCheckoutResult,
  type CheckoutClock,
  type ExecuteDomesticCheckoutUseCaseDeps,
  type PersistedDomesticSaleRecord,
  PRISMA_INT32_MAX,
  type RecordSaleRefundCommand,
  type RecordSaleRefundResult,
  ConfirmBankSettlementSchema,
  RecordSaleRefundSchema,
} from './domestic-checkout.contracts';

function toPartStateSnapshot(part: CheckoutLockedPartRow): PartStateSnapshot {
  return {
    custodyState: part.custodyState,
    availabilityState: part.availabilityState,
    ebaySyncState: part.ebaySyncState,
    classifiedsSyncState: part.classifiedsSyncState,
    complianceState: part.complianceState,
  };
}

async function loadPolicyInTx(
  tx: DomesticCheckoutTx,
  organizationId: string,
): Promise<PricingAndCompliancePolicy> {
  const adapter = new JsonPolicyConfigAdapter({
    readOrganizationPolicy: (orgId) => tx.readOrganizationPolicyRecord(orgId),
  });
  return adapter.getPolicyForOrg(organizationId);
}

function computeItemPriceBasisHash(
  itemType: 'PART' | 'VEHICLE',
  itemId: string,
  resolvedPrice: ResolvedPrice,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        itemType,
        itemId: itemId.toLowerCase(),
        amountCadMinor: resolvedPrice.amountCadMinor,
        source: resolvedPrice.source,
        policyHash: resolvedPrice.policyHash,
      }),
    )
    .digest('hex');
}

function computeBasketPriceBasisHash(
  items: ReadonlyArray<{
    readonly itemType: 'PART' | 'VEHICLE';
    readonly itemId: string;
    readonly resolvedPrice: ResolvedPrice;
  }>,
): string {
  return [...items]
    .sort((a, b) =>
      a.itemId.toLowerCase().localeCompare(b.itemId.toLowerCase()),
    )
    .map((i) =>
      computeItemPriceBasisHash(i.itemType, i.itemId, i.resolvedPrice),
    )
    .join(',');
}

function shortTokenFromUuid(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export class ExecuteDomesticCheckoutUseCase {
  private readonly repository: DomesticCheckoutRepository;
  private readonly storage: ExecuteDomesticCheckoutUseCaseDeps['storage'];
  private readonly clock: CheckoutClock;
  private readonly idGenerator: () => string;

  public constructor(deps: ExecuteDomesticCheckoutUseCaseDeps) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
  }

  private nextUuid(): string {
    const id = this.idGenerator();
    if (!isValidUuid(id)) {
      throw new DomesticCheckoutError(
        'CHECKOUT_INTEGRITY_ERROR',
        'idGenerator must produce a valid UUID string.',
      );
    }
    return id.toLowerCase();
  }

  private async verifyPrivateEvidenceKeyExists(
    session: AuthSessionContext,
    organizationId: string,
    rawKey: string,
    missingCode:
      | 'PAYMENT_PROOF_REQUIRED'
      | 'BILL_OF_SALE_REQUIRED'
      | 'SETTLEMENT_PROOF_REQUIRED'
      | 'INVALID_CHECKOUT_INPUT',
  ): Promise<string> {
    const trimmed = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!trimmed) {
      throw new DomesticCheckoutError(
        missingCode,
        `Private evidence storage key is required (${missingCode}).`,
      );
    }
    const validatedKey = assertValidPrivateEvidenceKey(trimmed, organizationId);
    await this.storage.createPrivateEvidencePresignedUrl({
      actor: session,
      organizationId,
      storageKey: validatedKey,
      ttlSeconds: 60,
    });
    return validatedKey;
  }

  public async lookupCheckoutItems(
    session: AuthSessionContext,
    code?: string,
  ): Promise<readonly CheckoutLookupItemSummary[]> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-CHK-01:execute-cad-only');

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const trimmedCode = code?.trim();

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const policy = await loadPolicyInTx(tx, organizationId);
      const now = this.clock.now();
      const { parts, vehicles } = await tx.lookupCheckoutItems(
        organizationId,
        trimmedCode ? { code: trimmedCode } : undefined,
      );

      const results: CheckoutLookupItemSummary[] = [];

      for (const part of parts) {
        const inReturnQcHold =
          part.custodyState === 'RESTOCKED_QC_HOLD' ||
          part.availabilityState === 'RETURNED_QC_HOLD';
        let resolvedPrice: ResolvedPrice | null = null;
        let priceError: string | null = null;
        try {
          resolvedPrice = resolvePartPrice(part, policy);
        } catch (err) {
          priceError =
            err instanceof Error ? err.message : 'Missing price baseline';
        }
        results.push({
          itemType: 'PART',
          itemId: part.id,
          code: part.qrSkuCode,
          label: `${part.qrSkuCode} — ${part.partCategoryName} (${part.araGrade})`,
          availabilityState: part.availabilityState,
          custodyOrLifecycleState: part.custodyState,
          ebaySyncState: part.ebaySyncState,
          classifiedsSyncState: part.classifiedsSyncState,
          complianceState: part.complianceState,
          tdgHazmatCode: part.tdgHazmatCode,
          isEbayParcelEligible:
            part.tdgHazmatCode === 'NONE' &&
            !part.isHazmatOrAirbag &&
            part.weightKg > 0 &&
            part.weightKg < policy.domesticSyndication.heavyLocalOnlyThresholdKg,
          inReturnQcHold,
          hasActiveSale: part.hasActiveSale,
          resolvedPrice,
          priceError,
          priceBasisHash: resolvedPrice
            ? computeItemPriceBasisHash('PART', part.id, resolvedPrice)
            : null,
          warnings: [],
          version: part.version,
        });
      }

      for (const veh of vehicles) {
        let resolvedPrice: ResolvedPrice | null = null;
        let priceError: string | null = null;
        try {
          resolvedPrice = resolveVehiclePrice(veh, policy);
        } catch (err) {
          priceError =
            err instanceof Error ? err.message : 'Missing vehicle floor price';
        }
        const warnings = [...veh.complianceWarnings];
        if (!policy.domesticTaxPolicy.isOmvicLicensed) {
          warnings.push('OMVIC_LICENSE_WARNING');
        }
        if (veh.assetCategory === 'AUTOMOBILE') {
          const timers = computeDriveOnTimers(
            {
              assetCategory: veh.assetCategory,
              driveOnInitialFailAt: veh.driveOnInitialFailAt,
              driveOnSscIssuedAt: veh.driveOnSscIssuedAt,
              now,
            },
            policy,
          );
          if (
            timers.isSscMissingOrExpired &&
            !warnings.includes('DRIVEON_SAFETY_CERT_WARNING')
          ) {
            warnings.push('DRIVEON_SAFETY_CERT_WARNING');
          }
        }

        results.push({
          itemType: 'VEHICLE',
          itemId: veh.id,
          code: veh.internalStockNumber,
          label: `${veh.internalStockNumber} — ${veh.year} ${veh.make} ${veh.model}`,
          availabilityState: veh.availabilityState,
          custodyOrLifecycleState: veh.lifecycleState,
          ebaySyncState: null,
          classifiedsSyncState: veh.classifiedsSyncState,
          complianceState: null,
          tdgHazmatCode: null,
          isEbayParcelEligible: false,
          inReturnQcHold: false,
          hasActiveSale: veh.hasActiveSale,
          resolvedPrice,
          priceError,
          priceBasisHash: resolvedPrice
            ? computeItemPriceBasisHash('VEHICLE', veh.id, resolvedPrice)
            : null,
          warnings,
          version: veh.version,
        });
      }

      return results;
    });
  }

  public async listDomesticSalesForSettlement(
    session: AuthSessionContext,
    limit = 100,
  ): Promise<readonly PersistedDomesticSaleRecord[]> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-CHK-01:read');

    const tenantCtx = toTenantExecutionContext(session);
    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      return tx.listDomesticSales(tenantCtx.organizationId, limit);
    });
  }

  /**
   * Executes Ontario Domestic CAD Checkout (`FR-CHK-01`).
   */
  public async executeDomesticCheckout(
    session: AuthSessionContext,
    rawInput: ExecuteDomesticCheckoutCommand,
  ): Promise<ExecuteDomesticCheckoutResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-CHK-01:execute-cad-only');

    const parsed = ExecuteDomesticCheckoutSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const input = parsed.data;
    const partLines = input.partLines ?? [];
    const vehicleLines = input.vehicleLines ?? [];

    if (
      (partLines.length === 0 && vehicleLines.length === 0) ||
      (partLines.length > 0 && vehicleLines.length > 0)
    ) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'Domestic checkout requires either partLines or vehicleLines (non-empty and mutually exclusive).',
      );
    }

    if (input.domesticChannel === 'RETAIL_LOT_VEHICLE_SALE') {
      if (vehicleLines.length === 0) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'RETAIL_LOT_VEHICLE_SALE requires vehicleLines.',
        );
      }
      if (!input.billOfSaleStorageKey || !input.billOfSaleStorageKey.trim()) {
        throw new DomesticCheckoutError(
          'BILL_OF_SALE_REQUIRED',
          'billOfSaleStorageKey is required for RETAIL_LOT_VEHICLE_SALE.',
        );
      }
    } else if (vehicleLines.length > 0) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'Whole-vehicle checkout must use domesticChannel = RETAIL_LOT_VEHICLE_SALE.',
      );
    }

    if (input.domesticChannel === 'EBAY_MOTORS_SHIPPED') {
      if (input.deliveryMethod !== 'SELLER_SHIPPED_PARCEL_OR_FREIGHT') {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'EBAY_MOTORS_SHIPPED requires deliveryMethod = SELLER_SHIPPED_PARCEL_OR_FREIGHT.',
        );
      }
      if (input.paymentMethod !== 'EBAY_MANAGED_PAYOUT') {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'EBAY_MOTORS_SHIPPED requires paymentMethod = EBAY_MANAGED_PAYOUT.',
        );
      }
    } else if (input.paymentMethod === 'EBAY_MANAGED_PAYOUT') {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'EBAY_MANAGED_PAYOUT is valid only for domesticChannel = EBAY_MOTORS_SHIPPED.',
      );
    }

    // Reject duplicate IDs
    const partIdSet = new Set<string>();
    for (const line of partLines) {
      const id = line.partId.toLowerCase();
      if (partIdSet.has(id)) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          `Duplicate partId "${id}" in checkout basket.`,
        );
      }
      partIdSet.add(id);
    }

    const vehicleIdSet = new Set<string>();
    for (const line of vehicleLines) {
      const id = line.vehicleId.toLowerCase();
      if (vehicleIdSet.has(id)) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          `Duplicate vehicleId "${id}" in checkout basket.`,
        );
      }
      vehicleIdSet.add(id);
    }

    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const idempotencyKey = input.idempotencyKey.toLowerCase();
    const receiptId = deriveCheckoutReceiptId(organizationId, idempotencyKey);

    const commandFingerprint = computeCheckoutCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      action: 'execute-domestic-checkout',
      payload: {
        domesticChannel: input.domesticChannel,
        deliveryMethod: input.deliveryMethod,
        destinationCountryCode: input.destinationCountryCode.toUpperCase(),
        destinationProvinceOrState:
          input.destinationProvinceOrState?.trim().toUpperCase() ?? null,
        paymentMethod: input.paymentMethod,
        isCashCountedInPerson: input.isCashCountedInPerson ?? true,
        buyerName: input.buyerName,
        buyerPhoneE164: input.buyerPhoneE164 ?? null,
        partLines: [...partLines].sort((a, b) =>
          a.partId.localeCompare(b.partId),
        ),
        vehicleLines: [...vehicleLines].sort((a, b) =>
          a.vehicleId.localeCompare(b.vehicleId),
        ),
        discountReasonCode: input.discountReasonCode ?? null,
        cfoOverrideRequested: input.cfoOverrideRequested ?? false,
        cfoOverrideReasonNote: input.cfoOverrideReasonNote ?? null,
        paymentProofStorageKey: input.paymentProofStorageKey.trim(),
        billOfSaleStorageKey: input.billOfSaleStorageKey?.trim() ?? null,
        exportProofStorageKey: input.exportProofStorageKey?.trim() ?? null,
        buyerTaxRemittedByPlatformMinor:
          input.buyerTaxRemittedByPlatformMinor ?? null,
        platformFeeMinor: input.platformFeeMinor ?? null,
        shippingCostMinor: input.shippingCostMinor ?? 0,
        estimatedPlatformFeeTaxCadMinor:
          input.estimatedPlatformFeeTaxCadMinor ?? null,
        ebayDelistAttestedAt: input.ebayDelistAttestedAt
          ? parseUtcDate(input.ebayDelistAttestedAt, 'ebayDelistAttestedAt').toISOString()
          : null,
      },
    });

    // 1. Short preflight idempotency check (no storage I/O inside lock)
    const preflightReplay = await this.repository.withTenantTransaction(
      tenantCtx,
      async (tx) => {
        const existing = await tx.findCommandReceipt(organizationId, receiptId);
        if (!existing) {
          return null;
        }
        if (
          existing.action !== 'execute-domestic-checkout' ||
          existing.commandFingerprint !== commandFingerprint
        ) {
          throw new DomesticCheckoutError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different checkout payload.',
          );
        }
        return existing.result as ExecuteDomesticCheckoutResult;
      },
    );
    if (preflightReplay) {
      return preflightReplay;
    }

    // 2. Verify private evidence keys outside inventory transaction locks
    const paymentProofStorageKey = await this.verifyPrivateEvidenceKeyExists(
      session,
      organizationId,
      input.paymentProofStorageKey,
      'PAYMENT_PROOF_REQUIRED',
    );
    const billOfSaleStorageKey = input.billOfSaleStorageKey?.trim()
      ? await this.verifyPrivateEvidenceKeyExists(
          session,
          organizationId,
          input.billOfSaleStorageKey,
          'BILL_OF_SALE_REQUIRED',
        )
      : null;
    const exportProofStorageKey = input.exportProofStorageKey?.trim()
      ? await this.verifyPrivateEvidenceKeyExists(
          session,
          organizationId,
          input.exportProofStorageKey,
          'INVALID_CHECKOUT_INPUT',
        )
      : null;

    const attestedDate =
      input.ebayDelistAttestedAt !== null &&
      input.ebayDelistAttestedAt !== undefined
        ? parseUtcDate(input.ebayDelistAttestedAt, 'ebayDelistAttestedAt')
        : null;

    // 3. Authoritative locked checkout transaction
    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      const existingReceipt = await tx.findCommandReceipt(
        organizationId,
        receiptId,
      );
      if (existingReceipt) {
        if (
          existingReceipt.action !== 'execute-domestic-checkout' ||
          existingReceipt.commandFingerprint !== commandFingerprint
        ) {
          throw new DomesticCheckoutError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different checkout payload.',
          );
        }
        return existingReceipt.result as ExecuteDomesticCheckoutResult;
      }

      await tx.acquireOrganizationLock(organizationId);

      const recheckReceipt = await tx.findCommandReceipt(
        organizationId,
        receiptId,
      );
      if (recheckReceipt) {
        if (
          recheckReceipt.action !== 'execute-domestic-checkout' ||
          recheckReceipt.commandFingerprint !== commandFingerprint
        ) {
          throw new DomesticCheckoutError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different checkout payload.',
          );
        }
        return recheckReceipt.result as ExecuteDomesticCheckoutResult;
      }

      const policy = await loadPolicyInTx(tx, organizationId);
      const now = this.clock.now();
      const saleId = this.nextUuid();

      let floorPriceAtCheckoutMinor = 0;
      let subtotalMinor = 0;
      const complianceWarnings: string[] = [];
      const resolvedLinePrices: Array<{
        readonly itemId: string;
        readonly itemType: 'PART' | 'VEHICLE';
        readonly code: string;
        readonly soldPriceMinor: number;
        readonly resolvedFloorPrice: ResolvedPrice;
      }> = [];
      const partUpdates: Array<{
        readonly part: CheckoutLockedPartRow;
        readonly nextState: PartStateSnapshot;
        readonly soldPriceMinor: number;
        readonly emitDelistOutbox: boolean;
      }> = [];
      const vehicleUpdates: Array<{
        readonly vehicle: CheckoutLockedVehicleRow;
        readonly nextLifecycle: 'SOLD_RETAIL_ONTARIO';
        readonly warnings: readonly string[];
        readonly soldPriceMinor: number;
      }> = [];

      if (partLines.length > 0) {
        const sortedIds = [...partIdSet].sort();
        const lockedParts = await tx.lockPartsByIds(organizationId, sortedIds);
        if (lockedParts.length !== sortedIds.length) {
          const found = new Set(lockedParts.map((p) => p.id.toLowerCase()));
          const missing = sortedIds.find((id) => !found.has(id));
          throw new DomesticCheckoutError(
            'PART_NOT_FOUND',
            `Part "${missing}" was not found in the active organization.`,
          );
        }

        const lineById = new Map(
          partLines.map((l) => [l.partId.toLowerCase(), l]),
        );

        for (const part of lockedParts) {
          const line = lineById.get(part.id.toLowerCase())!;
          if (
            line.expectedVersion !== undefined &&
            part.version !== line.expectedVersion
          ) {
            throw new DomesticCheckoutError(
              'VERSION_CONFLICT',
              `Part "${part.qrSkuCode}" version conflict.`,
            );
          }

          // Return QC hold check BEFORE guard invocation (422 PART_IN_RETURN_QC_HOLD)
          if (
            part.custodyState === 'RESTOCKED_QC_HOLD' ||
            part.availabilityState === 'RETURNED_QC_HOLD'
          ) {
            throw new DomesticCheckoutError(
              'PART_IN_RETURN_QC_HOLD',
              `Part "${part.qrSkuCode}" is held in return QC hold and cannot be checked out.`,
              { partId: part.id, qrSkuCode: part.qrSkuCode },
            );
          }

          if (
            part.hasActiveSale ||
            part.availabilityState === 'PAID_SETTLED' ||
            part.custodyState === 'SOLD_AND_RELEASED'
          ) {
            throw new DomesticCheckoutError(
              'INVENTORY_CONFLICT',
              `Part "${part.qrSkuCode}" is already sold or committed.`,
              { partId: part.id, qrSkuCode: part.qrSkuCode },
            );
          }

          if (input.deliveryMethod === 'SELLER_SHIPPED_PARCEL_OR_FREIGHT') {
            assertEbayParcelHazmatEligible(part.tdgHazmatCode);
          }

          const resolvedFloor = resolvePartPrice(part, policy);
          floorPriceAtCheckoutMinor = checkedAdd(
            floorPriceAtCheckoutMinor,
            resolvedFloor.amountCadMinor,
            'floorPriceAtCheckoutMinor',
          );
          subtotalMinor = checkedAdd(
            subtotalMinor,
            line.proposedPriceCadMinor,
            'subtotalMinor',
          );
          resolvedLinePrices.push({
            itemId: part.id,
            itemType: 'PART',
            code: part.qrSkuCode,
            soldPriceMinor: line.proposedPriceCadMinor,
            resolvedFloorPrice: resolvedFloor,
          });

          const isEbayChannel = input.domesticChannel === 'EBAY_MOTORS_SHIPPED';
          const wasSyndicatedLive = part.ebaySyncState === 'SYNDICATED_LIVE';

          const transition = validatePartTransition(
            toPartStateSnapshot(part),
            'CHECKOUT_DOMESTIC',
            {
              ebayDelistAttested: attestedDate !== null,
              domesticChannel: input.domesticChannel,
            },
          );

          partUpdates.push({
            part,
            nextState: transition.nextState,
            soldPriceMinor: line.proposedPriceCadMinor,
            emitDelistOutbox: !isEbayChannel && wasSyndicatedLive,
          });
        }
      } else {
        const sortedIds = [...vehicleIdSet].sort();
        const lockedVehicles = await tx.lockVehiclesByIds(
          organizationId,
          sortedIds,
        );
        if (lockedVehicles.length !== sortedIds.length) {
          const found = new Set(lockedVehicles.map((v) => v.id.toLowerCase()));
          const missing = sortedIds.find((id) => !found.has(id));
          throw new DomesticCheckoutError(
            'VEHICLE_NOT_FOUND',
            `Vehicle "${missing}" was not found in the active organization.`,
          );
        }

        const lineById = new Map(
          vehicleLines.map((l) => [l.vehicleId.toLowerCase(), l]),
        );

        for (const veh of lockedVehicles) {
          const line = lineById.get(veh.id.toLowerCase())!;
          if (
            line.expectedVersion !== undefined &&
            veh.version !== line.expectedVersion
          ) {
            throw new DomesticCheckoutError(
              'VERSION_CONFLICT',
              `Vehicle "${veh.internalStockNumber}" version conflict.`,
            );
          }

          if (
            veh.hasActiveSale ||
            veh.lifecycleState === 'SOLD_RETAIL_ONTARIO' ||
            veh.availabilityState === 'PAID_SETTLED'
          ) {
            throw new DomesticCheckoutError(
              'INVENTORY_CONFLICT',
              `Vehicle "${veh.internalStockNumber}" is already sold.`,
            );
          }

          if (
            veh.availabilityState !== 'AVAILABLE' ||
            veh.lifecycleState !== 'READY_FOR_RETAIL_SALE'
          ) {
            throw new DomainRuleError(
              'INVALID_VEHICLE_TRANSITION',
              `Vehicle "${veh.internalStockNumber}" must be READY_FOR_RETAIL_SALE and AVAILABLE (got ${veh.lifecycleState} / ${veh.availabilityState}).`,
            );
          }

          if (veh.storageLocationId && veh.storageLocationStatus) {
            const locDecision = evaluateLocationCustodyCheck({
              entityOrganizationId: organizationId,
              entityDomain: 'SALVAGE',
              locationOrganizationId: veh.storageLocationOrgId ?? '',
              locationAllowedOrgType:
                veh.storageLocationAllowedOrgType ?? 'SALVAGE_AND_EXPORT',
              locationOperationalStatus: veh.storageLocationStatus,
              allowsWholeVehicleDismantling:
                veh.storageLocationAllowsDismantling ?? false,
              requiresFluidDrainageCheck: false,
              fluidsDrainedAt: veh.fluidsDrainedAt,
              complianceEnforcementMode:
                policy.operationalGates.complianceEnforcementMode,
            });
            if (!locDecision.allowed) {
              throw new DomainRuleError(
                locDecision.blockingCodes[0] ?? 'SITE_ZONING_VIOLATION',
                'Vehicle storage location failed compliance check.',
              );
            }
            for (const w of locDecision.warnings) {
              if (!complianceWarnings.includes(w)) {
                complianceWarnings.push(w);
              }
            }
          }

          const vehWarnings = [...veh.complianceWarnings];
          if (!policy.domesticTaxPolicy.isOmvicLicensed) {
            if (
              policy.operationalGates.complianceEnforcementMode === 'STRICT_BLOCK'
            ) {
              throw new DomesticCheckoutError(
                'OMVIC_LICENSE_REQUIRED',
                'OMVIC dealer registration is required for whole-vehicle retail sale in STRICT_BLOCK mode.',
              );
            }
            if (!vehWarnings.includes('OMVIC_LICENSE_WARNING')) {
              vehWarnings.push('OMVIC_LICENSE_WARNING');
            }
            if (!complianceWarnings.includes('OMVIC_LICENSE_WARNING')) {
              complianceWarnings.push('OMVIC_LICENSE_WARNING');
            }
          }

          if (veh.assetCategory === 'AUTOMOBILE') {
            const sscTimers = computeDriveOnTimers(
              {
                assetCategory: veh.assetCategory,
                driveOnInitialFailAt: veh.driveOnInitialFailAt,
                driveOnSscIssuedAt: veh.driveOnSscIssuedAt,
                now,
              },
              policy,
            );
            if (sscTimers.isSscMissingOrExpired) {
              const decision = evaluateRegulatoryComplianceCheck(
                policy.operationalGates.complianceEnforcementMode,
                'DRIVEON_SAFETY_CERT_WARNING',
              );
              if (!decision.allowed) {
                throw new DomainRuleError(
                  decision.blockingCode ?? 'EXPIRED_OR_MISSING_SAFETY_CERT',
                  'Valid DriveON Safety Standards Certificate (<= 36 days) is required for automobile retail sale.',
                );
              }
              for (const w of decision.warnings) {
                if (!vehWarnings.includes(w)) {
                  vehWarnings.push(w);
                }
                if (!complianceWarnings.includes(w)) {
                  complianceWarnings.push(w);
                }
              }
            }
          }

          const lifecycleRes = validateVehicleLifecycleTransition(
            veh.lifecycleState,
            'SOLD_RETAIL_ONTARIO',
            {
              assetCategory: veh.assetCategory,
              operationalLane: veh.operationalLane,
              complianceEnforcementMode:
                policy.operationalGates.complianceEnforcementMode,
            },
          );
          for (const w of lifecycleRes.warnings) {
            if (!vehWarnings.includes(w)) {
              vehWarnings.push(w);
            }
            if (!complianceWarnings.includes(w)) {
              complianceWarnings.push(w);
            }
          }

          const resolvedFloor = resolveVehiclePrice(veh, policy);
          floorPriceAtCheckoutMinor = checkedAdd(
            floorPriceAtCheckoutMinor,
            resolvedFloor.amountCadMinor,
            'floorPriceAtCheckoutMinor',
          );
          subtotalMinor = checkedAdd(
            subtotalMinor,
            line.proposedPriceCadMinor,
            'subtotalMinor',
          );
          resolvedLinePrices.push({
            itemId: veh.id,
            itemType: 'VEHICLE',
            code: veh.internalStockNumber,
            soldPriceMinor: line.proposedPriceCadMinor,
            resolvedFloorPrice: resolvedFloor,
          });

          vehicleUpdates.push({
            vehicle: veh,
            nextLifecycle: 'SOLD_RETAIL_ONTARIO',
            warnings: vehWarnings,
            soldPriceMinor: line.proposedPriceCadMinor,
          });
        }
      }

      if (input.acknowledgedPriceBasisHash) {
        const currentBasisHash = computeBasketPriceBasisHash(
          resolvedLinePrices.map((line) => ({
            itemType: line.itemType,
            itemId: line.itemId,
            resolvedPrice: line.resolvedFloorPrice,
          })),
        );
        const currentBasisDigest = createHash('sha256')
          .update(currentBasisHash)
          .digest('hex');
        if (
          input.acknowledgedPriceBasisHash !== currentBasisHash &&
          input.acknowledgedPriceBasisHash !== currentBasisDigest
        ) {
          throw new DomesticCheckoutError(
            'INVENTORY_CONFLICT',
            'Resolved pricing basis changed since item review; refresh pricing and retry.',
          );
        }
      }

      if (floorPriceAtCheckoutMinor > PRISMA_INT32_MAX || subtotalMinor > PRISMA_INT32_MAX) {
        throw new DomainRuleError(
          'MONETARY_OVERFLOW',
          'Checkout totals exceed 32-bit integer storage bounds.',
        );
      }

      // Trusted server-side CFO override construction (client can never supply approver ID)
      const cfoOverrideInput: TrustedCfoApprovalInput | null =
        input.cfoOverrideRequested && session.role === 'ARCHITECT_CFO'
          ? {
              approved: true,
              approvedById: session.userId,
              approverRole: session.role,
              reasonNote: input.cfoOverrideReasonNote ?? '',
            }
          : input.cfoOverrideRequested && session.role !== 'ARCHITECT_CFO'
            ? {
                approved: true,
                approvedById: session.userId,
                approverRole: session.role,
                reasonNote: input.cfoOverrideReasonNote ?? '',
              }
            : null;

      const floorDecision = evaluateCheckoutPriceFloor(
        {
          marketNode: 'DOMESTIC_ORIGIN',
          floorPriceAtCheckoutMinor,
          subtotalMinor,
          actor: {
            actorUserId: session.userId,
            actorRole: session.role,
          },
          discountReasonCode: input.discountReasonCode,
          cfoOverride: cfoOverrideInput,
        },
        policy,
      );

      if (!floorDecision.allowed) {
        throw new DomainRuleError(
          floorDecision.blockingCodes[0] ?? 'FLOOR_PRICE_OVERRIDE_REQUIRED',
          'Checkout price violates negotiation corridor or CFO override requirements.',
          {
            tier: floorDecision.tier,
            floorPriceAtCheckoutMinor,
            subtotalMinor,
            discountAmountMinor: floorDecision.discountAmountMinor,
            maxAdminDiscountMinor: floorDecision.maxAdminDiscountMinor,
            blockingCodes: floorDecision.blockingCodes,
          },
        );
      }

      const taxAndSettlement = computeDomesticSaleTaxAndSettlement(
        {
          channel: input.domesticChannel,
          deliveryMethod: input.deliveryMethod,
          subtotalMinor,
          destinationCountryCode: input.destinationCountryCode,
          destinationProvinceOrState: input.destinationProvinceOrState,
          exportProofStorageKey,
          paymentMethod: input.paymentMethod,
          isCashCountedInPerson: input.isCashCountedInPerson,
          buyerTaxRemittedByPlatformMinor: input.buyerTaxRemittedByPlatformMinor,
          platformFeeMinor: input.platformFeeMinor,
          shippingCostMinor: input.shippingCostMinor ?? 0,
          estimatedPlatformFeeTaxCadMinor:
            input.estimatedPlatformFeeTaxCadMinor,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
        },
        policy,
      );

      if (taxAndSettlement.grossCollectedMinor > PRISMA_INT32_MAX) {
        throw new DomainRuleError(
          'MONETARY_OVERFLOW',
          'grossCollectedMinor exceeds 32-bit integer bounds.',
        );
      }

      const paymentConfirmedAt =
        taxAndSettlement.paymentSettlementState === 'PAYMENT_CONFIRMED' ||
        taxAndSettlement.paymentSettlementState === 'MARKETPLACE_PAYOUT_PENDING'
          ? now
          : null;
      const bankSettledAt = null;

      validatePaymentSettlementInvariants({
        paymentSettlementState: taxAndSettlement.paymentSettlementState,
        cashCustodyState: taxAndSettlement.cashCustodyState,
        paymentMethod: input.paymentMethod,
        paymentConfirmedAt,
        bankSettledAt,
        bankDepositReference: null,
        isVoidedOrReversed: false,
        voidReason: null,
      });

      const saleShort = shortTokenFromUuid(saleId);
      const year = now.getUTCFullYear();
      const receiptNumber = `ONT-${year}-${saleShort}`;
      const taxInvoiceNumber =
        taxAndSettlement.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
          ? `INV-ON-${year}-${saleShort}`
          : null;

      const isCashPaid =
        taxAndSettlement.paymentSettlementState === 'PAYMENT_CONFIRMED';

      await tx.insertSaleTransaction({
        id: saleId,
        organizationId,
        receiptNumber,
        marketNode: 'DOMESTIC_ORIGIN',
        domesticChannel: input.domesticChannel,
        exportChannel: null,
        deliveryMethod: taxAndSettlement.schemaDeliveryMethod,
        destinationCountryCode: input.destinationCountryCode.trim().toUpperCase(),
        destinationProvinceOrState:
          input.destinationProvinceOrState?.trim().toUpperCase() || null,
        exportProofStorageKey:
          taxAndSettlement.taxCollectionMode === 'ZERO_RATED_EXPORT'
            ? exportProofStorageKey
            : null,
        taxInvoiceNumber,
        buyerName: input.buyerName.trim(),
        buyerPhoneE164: input.buyerPhoneE164?.trim() || null,
        soldByUserId: tenantCtx.userId,
        verifiedByAdminId: tenantCtx.userId,
        paymentCurrency: 'CAD',
        floorPriceAtCheckoutMinor,
        subtotalMinor,
        discountAmountMinor: floorDecision.discountAmountMinor,
        discountReasonCode: floorDecision.acceptedDiscountReasonCode,
        cfoOverrideApprovedById: floorDecision.cfoOverrideAudit.approvedById,
        cfoOverrideReasonNote: floorDecision.cfoOverrideAudit.reasonNote,
        platformFeeMinor: taxAndSettlement.platformFeeMinor,
        actualPlatformFeeMinor: null,
        shippingCostMinor: taxAndSettlement.shippingCostMinor,
        taxCollectionMode: taxAndSettlement.taxCollectionMode,
        appliedTaxJurisdiction: taxAndSettlement.appliedTaxJurisdiction,
        appliedTaxRateBps: taxAndSettlement.appliedTaxRateBps,
        taxOrVatMinor: taxAndSettlement.taxOrVatMinor,
        buyerTaxRemittedByPlatformMinor:
          taxAndSettlement.buyerTaxRemittedByPlatformMinor,
        estimatedPlatformFeeTaxCadMinor:
          taxAndSettlement.estimatedPlatformFeeTaxCadMinor,
        itcReceivableCadMinor: 0,
        isFeeTaxInvoiceVerified: false,
        feeTaxInvoiceStorageKey: null,
        grossCollectedMinor: taxAndSettlement.grossCollectedMinor,
        netRealizedCadMinor: taxAndSettlement.netRealizedCadMinor,
        paymentMethod: input.paymentMethod,
        paymentSettlementState: taxAndSettlement.paymentSettlementState,
        paymentConfirmedAt,
        bankSettledAt,
        bankDepositReference: null,
        settlementProofStorageKey: null,
        cashCustodyState: taxAndSettlement.cashCustodyState,
        ebayDelistAttestedAt: attestedDate,
        complianceWarnings,
        paymentProofStorageKey,
        billOfSaleStorageKey,
        isPaymentVerified: isCashPaid,
        gateReleasedAt: isCashPaid ? now : null,
        isVoidedOrReversed: false,
        reversesSaleTxId: null,
        voidReason: null,
        createdAt: now,
      });

      const outboxEventIds: string[] = [];

      if (partUpdates.length > 0) {
        await tx.insertSalePartItems(
          partUpdates.map((u) => ({
            id: this.nextUuid(),
            organizationId,
            saleTransactionId: saleId,
            partId: u.part.id,
            soldPriceMinor: u.soldPriceMinor,
            isActiveSale: true,
          })),
        );

        for (const u of partUpdates) {
          const ok = await tx.updatePartAfterCheckoutOrReturn({
            organizationId,
            partId: u.part.id,
            expectedVersion: u.part.version,
            nextVersion: u.part.version + 1,
            custodyState: u.nextState.custodyState,
            availabilityState: u.nextState.availabilityState,
            ebaySyncState: u.nextState.ebaySyncState,
            classifiedsSyncState: u.nextState.classifiedsSyncState,
            complianceState: u.nextState.complianceState,
            updatedAt: now,
          });
          if (!ok) {
            throw new DomesticCheckoutError(
              'INVENTORY_CONFLICT',
              `Concurrent modification prevented checkout of part "${u.part.qrSkuCode}".`,
            );
          }

          if (u.emitDelistOutbox) {
            const eventId = this.nextUuid();
            outboxEventIds.push(eventId);
            await tx.insertOutboxEvent({
              id: eventId,
              organizationId,
              aggregateType: 'Part',
              aggregateId: u.part.id,
              eventType: 'PartSoldLocallyDelistEbayRequested',
              payloadJson: {
                schemaVersion: 1,
                organizationId,
                saleId,
                partId: u.part.id,
                qrSkuCode: u.part.qrSkuCode,
                ebayListingId: u.part.ebayListingId,
                aggregateVersion: u.part.version + 1,
                idempotencyKey,
                attestedAt: attestedDate?.toISOString() ?? null,
              },
              idempotencyKey: `${idempotencyKey}:delist:${u.part.id}`,
              createdAt: now,
            });
          }
        }
      }

      if (vehicleUpdates.length > 0) {
        await tx.insertSaleVehicleItems(
          vehicleUpdates.map((u) => ({
            id: this.nextUuid(),
            organizationId,
            saleTransactionId: saleId,
            vehicleId: u.vehicle.id,
            soldPriceMinor: u.soldPriceMinor,
            isActiveSale: true,
          })),
        );

        for (const u of vehicleUpdates) {
          const ok = await tx.updateVehicleAfterCheckout({
            organizationId,
            vehicleId: u.vehicle.id,
            expectedVersion: u.vehicle.version,
            nextVersion: u.vehicle.version + 1,
            lifecycleState: u.nextLifecycle,
            availabilityState: 'PAID_SETTLED',
            classifiedsSyncState:
              u.vehicle.classifiedsSyncState === 'POSTED_LIVE'
                ? 'DELIST_REQUIRED'
                : u.vehicle.classifiedsSyncState,
            complianceWarnings: u.warnings,
            realizedRetailSaleCadMinor: u.soldPriceMinor,
            soldAt: now,
            updatedAt: now,
          });
          if (!ok) {
            throw new DomesticCheckoutError(
              'INVENTORY_CONFLICT',
              `Concurrent modification prevented checkout of vehicle "${u.vehicle.internalStockNumber}".`,
            );
          }
        }
      }

      const result: ExecuteDomesticCheckoutResult = {
        saleId,
        organizationId,
        receiptNumber,
        taxInvoiceNumber,
        marketNode: 'DOMESTIC_ORIGIN',
        domesticChannel: input.domesticChannel,
        paymentCurrency: 'CAD',
        deliveryMethod: taxAndSettlement.schemaDeliveryMethod,
        destinationCountryCode: input.destinationCountryCode.trim().toUpperCase(),
        destinationProvinceOrState:
          input.destinationProvinceOrState?.trim().toUpperCase() || null,
        floorPriceAtCheckoutMinor,
        subtotalMinor,
        discountAmountMinor: floorDecision.discountAmountMinor,
        discountReasonCode: floorDecision.acceptedDiscountReasonCode,
        cfoOverrideApplied: floorDecision.overrideApplied,
        taxCollectionMode: taxAndSettlement.taxCollectionMode,
        appliedTaxJurisdiction: taxAndSettlement.appliedTaxJurisdiction,
        appliedTaxRateBps: taxAndSettlement.appliedTaxRateBps,
        taxOrVatMinor: taxAndSettlement.taxOrVatMinor,
        buyerTaxRemittedByPlatformMinor:
          taxAndSettlement.buyerTaxRemittedByPlatformMinor,
        platformFeeMinor: taxAndSettlement.platformFeeMinor,
        shippingCostMinor: taxAndSettlement.shippingCostMinor,
        estimatedPlatformFeeTaxCadMinor:
          taxAndSettlement.estimatedPlatformFeeTaxCadMinor,
        itcReceivableCadMinor: 0,
        isFeeTaxInvoiceVerified: false,
        grossCollectedMinor: taxAndSettlement.grossCollectedMinor,
        netRealizedCadMinor: taxAndSettlement.netRealizedCadMinor,
        paymentMethod: input.paymentMethod,
        paymentSettlementState: taxAndSettlement.paymentSettlementState,
        cashCustodyState: taxAndSettlement.cashCustodyState,
        paymentConfirmedAt: paymentConfirmedAt?.toISOString() ?? null,
        bankSettledAt: null,
        complianceWarnings,
        outboxEventIds,
        resolvedLinePrices,
        auditLogId: receiptId,
        createdAt: now.toISOString(),
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'SaleTransaction',
        entityId: saleId,
        action: CHECKOUT_AUDIT_ACTIONS.DOMESTIC_CHECKOUT_EXECUTED,
        previousState: null,
        nextState: {
          schemaVersion: CHECKOUT_RECEIPT_SCHEMA_VERSION,
          action: 'execute-domestic-checkout',
          idempotencyKey,
          commandFingerprint,
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }

  /**
   * Confirms bank settlement for pending eBay payouts (`MARKETPLACE_PAYOUT_PENDING`)
   * or pending Interac e-Transfer / wires (`BANK_SETTLEMENT_PENDING`), reconciling optional
   * `actualPlatformFeeMinor` once and promoting `estimatedPlatformFeeTaxCadMinor` to
   * `itcReceivableCadMinor` strictly upon verified tax-invoice evidence.
   */
  public async confirmSaleBankSettlement(
    session: AuthSessionContext,
    saleId: string,
    rawInput: ConfirmBankSettlementCommand,
  ): Promise<ConfirmBankSettlementResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-CHK-01:update');

    if (!isValidUuid(saleId)) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'saleId must be a valid UUID.',
      );
    }

    const parsed = ConfirmBankSettlementSchema.safeParse({
      ...rawInput,
      saleId: saleId.toLowerCase(),
    });
    if (!parsed.success) {
      const hasEmptyRef =
        typeof rawInput?.bankDepositReference !== 'string' ||
        rawInput.bankDepositReference.trim().length === 0;
      if (hasEmptyRef) {
        throw new DomesticCheckoutError(
          'BANK_DEPOSIT_REFERENCE_REQUIRED',
          'A non-empty bankDepositReference is required to confirm bank settlement.',
        );
      }
      const hasEmptyProof =
        typeof rawInput?.settlementProofStorageKey !== 'string' ||
        rawInput.settlementProofStorageKey.trim().length === 0;
      if (hasEmptyProof) {
        throw new DomesticCheckoutError(
          'SETTLEMENT_PROOF_REQUIRED',
          'settlementProofStorageKey is required to confirm bank settlement.',
        );
      }
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const input = parsed.data;
    const normalizedSaleId = saleId.toLowerCase();
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;
    const trimmedRef = input.bankDepositReference.trim();

    const idempotencyKey = input.idempotencyKey
      ? input.idempotencyKey.toLowerCase()
      : null;
    const receiptId = idempotencyKey
      ? deriveCheckoutReceiptId(organizationId, idempotencyKey)
      : this.nextUuid();
    const commandFingerprint = idempotencyKey
      ? computeCheckoutCommandFingerprint({
          organizationId,
          actorUserId: tenantCtx.userId,
          action: 'confirm-bank-settlement',
          payload: {
            saleId: normalizedSaleId,
            bankDepositReference: trimmedRef,
            settlementProofStorageKey: input.settlementProofStorageKey.trim(),
            actualPlatformFeeMinor: input.actualPlatformFeeMinor ?? null,
            feeTaxInvoiceStorageKey:
              input.feeTaxInvoiceStorageKey?.trim() ?? null,
          },
        })
      : '';

    if (idempotencyKey) {
      const replay = await this.repository.withTenantTransaction(
        tenantCtx,
        async (tx) => {
          const existing = await tx.findCommandReceipt(organizationId, receiptId);
          if (!existing) {
            return null;
          }
          if (
            existing.action !== 'confirm-bank-settlement' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new DomesticCheckoutError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different settlement payload.',
            );
          }
          return existing.result as ConfirmBankSettlementResult;
        },
      );
      if (replay) {
        return replay;
      }
    }

    const settlementProofStorageKey = await this.verifyPrivateEvidenceKeyExists(
      session,
      organizationId,
      input.settlementProofStorageKey,
      'SETTLEMENT_PROOF_REQUIRED',
    );
    const feeTaxInvoiceStorageKey = input.feeTaxInvoiceStorageKey?.trim()
      ? await this.verifyPrivateEvidenceKeyExists(
          session,
          organizationId,
          input.feeTaxInvoiceStorageKey,
          'INVALID_CHECKOUT_INPUT',
        )
      : null;

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.findCommandReceipt(organizationId, receiptId);
        if (existing) {
          if (
            existing.action !== 'confirm-bank-settlement' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new DomesticCheckoutError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different settlement payload.',
            );
          }
          return existing.result as ConfirmBankSettlementResult;
        }
      }

      await tx.acquireOrganizationLock(organizationId);
      const sale = await tx.findAndLockSaleTransaction(
        organizationId,
        normalizedSaleId,
      );
      if (!sale) {
        throw new DomesticCheckoutError(
          'SALE_NOT_FOUND',
          `SaleTransaction "${normalizedSaleId}" was not found in the active organization.`,
        );
      }

      if (
        sale.isVoidedOrReversed ||
        sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK'
      ) {
        throw new DomesticCheckoutError(
          'SALE_ALREADY_REVERSED',
          'Terminal refunded/reversed sale cannot be settled to bank.',
        );
      }

      if (
        sale.paymentSettlementState === 'PAYMENT_CONFIRMED' ||
        sale.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT'
      ) {
        throw new DomesticCheckoutError(
          'CASH_SALE_REQUIRES_CUSTODY_TRANSFER',
          'Physical cash in operator float must be deposited via CashCustodyTransfer, not confirmSaleBankSettlement.',
        );
      }

      if (sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED') {
        throw new DomesticCheckoutError(
          'SALE_ALREADY_BANK_SETTLED',
          `Sale "${sale.receiptNumber}" is already BANK_SETTLEMENT_CONFIRMED.`,
        );
      }

      if (
        sale.paymentSettlementState !== 'MARKETPLACE_PAYOUT_PENDING' &&
        sale.paymentSettlementState !== 'BANK_SETTLEMENT_PENDING'
      ) {
        throw new DomainRuleError(
          'INVALID_PAYMENT_SETTLEMENT_TRANSITION',
          `Cannot confirm bank settlement from ${sale.paymentSettlementState}.`,
        );
      }

      if (
        input.actualPlatformFeeMinor !== undefined &&
        sale.domesticChannel !== 'EBAY_MOTORS_SHIPPED'
      ) {
        throw new DomesticCheckoutError(
          'ACTUAL_FEE_EBAY_ONLY',
          'actualPlatformFeeMinor can only be reconciled on EBAY_MOTORS_SHIPPED sales.',
        );
      }

      if (
        feeTaxInvoiceStorageKey !== null &&
        sale.domesticChannel !== 'EBAY_MOTORS_SHIPPED'
      ) {
        throw new DomesticCheckoutError(
          'FEE_TAX_INVOICE_EBAY_ONLY',
          'feeTaxInvoiceStorageKey applies strictly to EBAY_MOTORS_SHIPPED marketplace seller-fee invoices.',
        );
      }

      const policy = await loadPolicyInTx(tx, organizationId);
      const now = this.clock.now();
      const paymentConfirmedAt = sale.paymentConfirmedAt ?? now;

      validatePaymentSettlementTransition(
        {
          paymentSettlementState: sale.paymentSettlementState,
          cashCustodyState: sale.cashCustodyState,
          paymentMethod: sale.paymentMethod,
          paymentConfirmedAt: sale.paymentConfirmedAt,
          bankSettledAt: sale.bankSettledAt,
          bankDepositReference: sale.bankDepositReference,
          isVoidedOrReversed: sale.isVoidedOrReversed,
          voidReason: sale.voidReason,
        },
        {
          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
          cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
          paymentMethod: sale.paymentMethod,
          paymentConfirmedAt,
          bankSettledAt: now,
          bankDepositReference: trimmedRef,
          isVoidedOrReversed: false,
          voidReason: null,
        },
      );

      let nextIsFeeVerified = sale.isFeeTaxInvoiceVerified;
      let nextFeeKey = sale.feeTaxInvoiceStorageKey;
      let nextItc = sale.itcReceivableCadMinor;

      if (feeTaxInvoiceStorageKey !== null) {
        if (policy.domesticTaxPolicy.isGstHstRegistered) {
          nextIsFeeVerified = true;
          nextFeeKey = feeTaxInvoiceStorageKey;
          nextItc = sale.estimatedPlatformFeeTaxCadMinor;
        } else {
          nextIsFeeVerified = false;
          nextFeeKey = feeTaxInvoiceStorageKey;
          nextItc = 0;
        }
      }

      const nextActualFee =
        input.actualPlatformFeeMinor !== undefined
          ? input.actualPlatformFeeMinor
          : sale.actualPlatformFeeMinor;

      await tx.updateSaleBankSettlement({
        organizationId,
        saleId: sale.id,
        paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
        paymentConfirmedAt,
        bankSettledAt: now,
        bankDepositReference: trimmedRef,
        settlementProofStorageKey,
        actualPlatformFeeMinor: nextActualFee,
        isFeeTaxInvoiceVerified: nextIsFeeVerified,
        feeTaxInvoiceStorageKey: nextFeeKey,
        itcReceivableCadMinor: nextItc,
        isPaymentVerified: true,
        gateReleasedAt: sale.gateReleasedAt ?? now,
      });

      const result: ConfirmBankSettlementResult = {
        saleId: sale.id,
        organizationId,
        receiptNumber: sale.receiptNumber,
        paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
        cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
        bankSettledAt: now.toISOString(),
        bankDepositReference: trimmedRef,
        settlementProofStorageKey,
        actualPlatformFeeMinor: nextActualFee,
        estimatedPlatformFeeTaxCadMinor: sale.estimatedPlatformFeeTaxCadMinor,
        isFeeTaxInvoiceVerified: nextIsFeeVerified,
        feeTaxInvoiceStorageKey: nextFeeKey,
        itcReceivableCadMinor: nextItc,
        auditLogId: receiptId,
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'SaleTransaction',
        entityId: sale.id,
        action: CHECKOUT_AUDIT_ACTIONS.BANK_SETTLEMENT_CONFIRMED,
        previousState: {
          paymentSettlementState: sale.paymentSettlementState,
          cashCustodyState: sale.cashCustodyState,
          actualPlatformFeeMinor: sale.actualPlatformFeeMinor,
          isFeeTaxInvoiceVerified: sale.isFeeTaxInvoiceVerified,
          itcReceivableCadMinor: sale.itcReceivableCadMinor,
        },
        nextState: {
          schemaVersion: CHECKOUT_RECEIPT_SCHEMA_VERSION,
          action: 'confirm-bank-settlement',
          ...(idempotencyKey ? { idempotencyKey, commandFingerprint } : {}),
          provenanceClassification:
            feeTaxInvoiceStorageKey !== null ? 'VERIFIED_FEE_INVOICE' : 'EXECUTED',
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }

  /**
   * Records a full-sale refund or chargeback (`ETA s. 232` credit adjustment)
   * with linked immutable reversal entry and optional `RESTOCKED_QC_HOLD` return hold.
   */
  public async recordSaleRefundOrChargeback(
    session: AuthSessionContext,
    saleId: string,
    rawInput: RecordSaleRefundCommand,
  ): Promise<RecordSaleRefundResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-CHK-01:update');

    if (!isValidUuid(saleId)) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'saleId must be a valid UUID.',
      );
    }

    const parsed = RecordSaleRefundSchema.safeParse({
      ...rawInput,
      saleId: saleId.toLowerCase(),
    });
    if (!parsed.success) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const input = parsed.data;
    const trimmedReason = input.reasonNote.trim();
    if (trimmedReason.length < 5) {
      throw new DomesticCheckoutError(
        'REFUND_REASON_REQUIRED',
        'reasonNote must be at least 5 characters.',
      );
    }

    const normalizedSaleId = saleId.toLowerCase();
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    const idempotencyKey = input.idempotencyKey
      ? input.idempotencyKey.toLowerCase()
      : null;
    const receiptId = idempotencyKey
      ? deriveCheckoutReceiptId(organizationId, idempotencyKey)
      : this.nextUuid();
    const commandFingerprint = idempotencyKey
      ? computeCheckoutCommandFingerprint({
          organizationId,
          actorUserId: tenantCtx.userId,
          action: 'record-refund-or-chargeback',
          payload: {
            saleId: normalizedSaleId,
            reasonNote: trimmedReason,
            returnPartsToQcHold: input.returnPartsToQcHold,
            refundBankReference: input.refundBankReference?.trim() ?? null,
            refundProofStorageKey: input.refundProofStorageKey?.trim() ?? null,
          },
        })
      : '';

    if (idempotencyKey) {
      const replay = await this.repository.withTenantTransaction(
        tenantCtx,
        async (tx) => {
          const existing = await tx.findCommandReceipt(organizationId, receiptId);
          if (!existing) {
            return null;
          }
          if (
            existing.action !== 'record-refund-or-chargeback' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new DomesticCheckoutError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different refund payload.',
            );
          }
          return existing.result as RecordSaleRefundResult;
        },
      );
      if (replay) {
        return replay;
      }
    }

    const explicitRefundProofKey = input.refundProofStorageKey?.trim()
      ? await this.verifyPrivateEvidenceKeyExists(
          session,
          organizationId,
          input.refundProofStorageKey,
          'INVALID_CHECKOUT_INPUT',
        )
      : null;

    return this.repository.withTenantTransaction(tenantCtx, async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.findCommandReceipt(organizationId, receiptId);
        if (existing) {
          if (
            existing.action !== 'record-refund-or-chargeback' ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new DomesticCheckoutError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different refund payload.',
            );
          }
          return existing.result as RecordSaleRefundResult;
        }
      }

      await tx.acquireOrganizationLock(organizationId);
      const sale = await tx.findAndLockSaleTransaction(
        organizationId,
        normalizedSaleId,
      );
      if (!sale) {
        throw new DomesticCheckoutError(
          'SALE_NOT_FOUND',
          `SaleTransaction "${normalizedSaleId}" was not found in the active organization.`,
        );
      }

      if (sale.reversesSaleTxId !== null) {
        throw new DomesticCheckoutError(
          'CANNOT_REVERSE_REVERSAL_ENTRY',
          'Cannot reverse an existing reversal SaleTransaction.',
        );
      }

      const existingLinkedReversal = await tx.findLinkedReversalSale(
        organizationId,
        sale.id,
      );
      if (
        sale.isVoidedOrReversed ||
        sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK' ||
        existingLinkedReversal !== null
      ) {
        throw new DomesticCheckoutError(
          'SALE_ALREADY_REVERSED',
          `Sale "${sale.receiptNumber}" has already been refunded or reversed.`,
        );
      }

      const policy = await loadPolicyInTx(tx, organizationId);
      const now = this.clock.now();
      const reversalSaleId = this.nextUuid();
      const creditNoteReference = `CN-${sale.receiptNumber}-${shortTokenFromUuid(reversalSaleId)}`;

      const effectiveFee = sale.actualPlatformFeeMinor ?? sale.platformFeeMinor;
      const effectiveNet =
        sale.subtotalMinor - effectiveFee - sale.shippingCostMinor;

      const taxAdj = computeRefundTaxAdjustment({
        adjustmentId: reversalSaleId,
        originalSaleId: sale.id,
        taxCollectionMode: sale.taxCollectionMode,
        originalSubtotalMinor: sale.subtotalMinor,
        originalTaxOrVatMinor: sale.taxOrVatMinor,
        originalItcReceivableCadMinor: sale.itcReceivableCadMinor,
        refundSubtotalMinor: sale.subtotalMinor,
        creditedFeeTaxCadMinor: 0,
        creditNoteReference,
      });

      const explicitRef = input.refundBankReference?.trim() || null;

      let chosenFundingSource: RecordSaleRefundResult['chosenFundingSource'];
      let reversalPaymentSettlementState: PaymentSettlementState;
      let reversalCashCustodyState: CashCustodyState;
      let reversalPaymentMethod: string;
      let reversalPaymentConfirmedAt: Date | null;
      let reversalBankSettledAt: Date | null;
      let reversalBankDepositReference: string | null;
      let reversalPaymentProofStorageKey: string | null;
      let reversalSettlementProofStorageKey: string | null;
      let proofOrigin: RecordSaleRefundResult['proofOrigin'];
      let referenceOrigin: RecordSaleRefundResult['referenceOrigin'];
      let floatDecisionMetadata: Record<string, unknown> | null = null;

      if (
        sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' &&
        sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'
      ) {
        chosenFundingSource = 'CORP_BANK';
        reversalPaymentSettlementState = 'BANK_SETTLEMENT_CONFIRMED';
        reversalCashCustodyState = 'SETTLED_ORIGIN_CORP_BANK';
        reversalPaymentMethod = 'VERIFIED_BANK_WIRE';
        reversalPaymentConfirmedAt = now;
        reversalBankSettledAt = now;

        if (explicitRef) {
          reversalBankDepositReference = explicitRef;
          referenceOrigin = 'EXPLICIT_REFUND_REFERENCE';
        } else if (
          sale.bankDepositReference &&
          sale.bankDepositReference.trim().length > 0
        ) {
          reversalBankDepositReference = sale.bankDepositReference.trim();
          referenceOrigin = 'INHERITED_SALE_REFERENCE';
        } else {
          reversalBankDepositReference = creditNoteReference;
          referenceOrigin = 'GENERATED_CREDIT_NOTE_REFERENCE';
        }

        if (explicitRefundProofKey) {
          reversalPaymentProofStorageKey = explicitRefundProofKey;
          reversalSettlementProofStorageKey = explicitRefundProofKey;
          proofOrigin = 'EXPLICIT_REFUND_EVIDENCE';
        } else {
          const inherited =
            sale.settlementProofStorageKey?.trim() ||
            sale.paymentProofStorageKey?.trim() ||
            '';
          if (!inherited) {
            throw new DomesticCheckoutError(
              'REFUND_EVIDENCE_REQUIRED',
              'Cannot construct bank-settled reversal without payment or settlement evidence.',
            );
          }
          reversalPaymentProofStorageKey = inherited;
          reversalSettlementProofStorageKey = inherited;
          proofOrigin = 'INHERITED_SALE_EVIDENCE';
        }
      } else if (
        sale.paymentSettlementState === 'PAYMENT_CONFIRMED' &&
        sale.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT'
      ) {
        const [matchingTransfers, ledgerProjection] = await Promise.all([
          tx.listEligibleFloatToBankTransfers(
            organizationId,
            sale.soldByUserId,
            now,
          ),
          tx.loadLedgerProjection(organizationId, policy),
        ]);

        const liveSellerFloat =
          ledgerProjection.snapshot.operatorFloatByUserId[
            sale.soldByUserId.toLowerCase()
          ] ?? 0;

        floatDecisionMetadata = {
          allocationClassification: 'DECLARED_FUNGIBLE_POOL_ALLOCATION',
          sellerUserId: sale.soldByUserId,
          liveSellerFloatCadMinor: liveSellerFloat,
          thresholdGrossCadMinor: sale.grossCollectedMinor,
          consideredTransferIds: matchingTransfers.map((t) => t.id),
        };

        if (
          matchingTransfers.length > 0 &&
          liveSellerFloat < sale.grossCollectedMinor
        ) {
          const latestTransfer = matchingTransfers[0]!;
          chosenFundingSource = 'CORP_BANK';
          reversalPaymentSettlementState = 'BANK_SETTLEMENT_CONFIRMED';
          reversalCashCustodyState = 'SETTLED_ORIGIN_CORP_BANK';
          reversalPaymentMethod = 'VERIFIED_BANK_WIRE';
          reversalPaymentConfirmedAt = now;
          reversalBankSettledAt = now;

          if (explicitRef) {
            reversalBankDepositReference = explicitRef;
            referenceOrigin = 'EXPLICIT_REFUND_REFERENCE';
          } else if (latestTransfer.transferCode.trim().length > 0) {
            reversalBankDepositReference = latestTransfer.transferCode.trim();
            referenceOrigin = 'SWEPT_TRANSFER_CODE';
          } else {
            reversalBankDepositReference = creditNoteReference;
            referenceOrigin = 'GENERATED_CREDIT_NOTE_REFERENCE';
          }

          if (explicitRefundProofKey) {
            reversalPaymentProofStorageKey = explicitRefundProofKey;
            reversalSettlementProofStorageKey = explicitRefundProofKey;
            proofOrigin = 'EXPLICIT_REFUND_EVIDENCE';
          } else if (
            sale.settlementProofStorageKey?.trim() ||
            sale.paymentProofStorageKey?.trim()
          ) {
            const inherited =
              sale.settlementProofStorageKey?.trim() ||
              sale.paymentProofStorageKey?.trim()!;
            reversalPaymentProofStorageKey = inherited;
            reversalSettlementProofStorageKey = inherited;
            proofOrigin = 'INHERITED_SALE_EVIDENCE';
          } else if (latestTransfer.depositSlipStorageKey.trim().length > 0) {
            reversalPaymentProofStorageKey =
              latestTransfer.depositSlipStorageKey.trim();
            reversalSettlementProofStorageKey =
              latestTransfer.depositSlipStorageKey.trim();
            proofOrigin = 'SWEPT_TRANSFER_DEPOSIT_SLIP';
          } else {
            throw new DomesticCheckoutError(
              'REFUND_EVIDENCE_REQUIRED',
              'Missing evidence for swept-cash bank reversal.',
            );
          }
        } else if (liveSellerFloat >= sale.grossCollectedMinor) {
          chosenFundingSource = 'OPERATOR_FLOAT';
          reversalPaymentSettlementState = 'PAYMENT_CONFIRMED';
          reversalCashCustodyState = 'HELD_IN_OPERATOR_FLOAT';
          reversalPaymentMethod = 'CASH';
          reversalPaymentConfirmedAt = now;
          reversalBankSettledAt = null;
          reversalBankDepositReference = null;
          referenceOrigin = 'GENERATED_CREDIT_NOTE_REFERENCE';

          if (explicitRefundProofKey) {
            reversalPaymentProofStorageKey = explicitRefundProofKey;
            proofOrigin = 'EXPLICIT_REFUND_EVIDENCE';
          } else if (sale.paymentProofStorageKey?.trim()) {
            reversalPaymentProofStorageKey = sale.paymentProofStorageKey.trim();
            proofOrigin = 'INHERITED_SALE_EVIDENCE';
          } else {
            throw new DomesticCheckoutError(
              'REFUND_EVIDENCE_REQUIRED',
              'Missing payment proof for operator float reversal.',
            );
          }
          reversalSettlementProofStorageKey = null;
        } else {
          throw new DomesticCheckoutError(
            'REFUND_FUNDING_SOURCE_UNRESOLVED',
            `Seller float (${liveSellerFloat}) is below refund gross (${sale.grossCollectedMinor}) with no eligible confirmed sweep transfer.`,
            floatDecisionMetadata,
          );
        }
      } else if (
        sale.paymentSettlementState === 'MARKETPLACE_PAYOUT_PENDING' ||
        sale.paymentSettlementState === 'BANK_SETTLEMENT_PENDING' ||
        sale.cashCustodyState === 'PENDING_EXTERNAL_RECEIVABLE'
      ) {
        chosenFundingSource = 'PENDING_EXTERNAL_RECEIVABLE';
        reversalPaymentSettlementState = sale.paymentSettlementState;
        reversalCashCustodyState = 'PENDING_EXTERNAL_RECEIVABLE';
        reversalPaymentMethod = sale.paymentMethod;
        reversalPaymentConfirmedAt = sale.paymentConfirmedAt;
        reversalBankSettledAt = null;
        reversalBankDepositReference = null;
        referenceOrigin = 'GENERATED_CREDIT_NOTE_REFERENCE';

        if (explicitRefundProofKey) {
          reversalPaymentProofStorageKey = explicitRefundProofKey;
          proofOrigin = 'EXPLICIT_REFUND_EVIDENCE';
        } else if (sale.paymentProofStorageKey?.trim()) {
          reversalPaymentProofStorageKey = sale.paymentProofStorageKey.trim();
          proofOrigin = 'INHERITED_SALE_EVIDENCE';
        } else {
          throw new DomesticCheckoutError(
            'REFUND_EVIDENCE_REQUIRED',
            'Missing payment proof for pending receivable reversal.',
          );
        }
        reversalSettlementProofStorageKey = null;
      } else {
        throw new DomesticCheckoutError(
          'REFUND_FUNDING_SOURCE_UNRESOLVED',
          `Unsupported settlement/custody pair (${sale.paymentSettlementState} / ${sale.cashCustodyState}) for domestic refund.`,
        );
      }

      if (
        !reversalPaymentProofStorageKey ||
        reversalPaymentProofStorageKey.trim().length === 0
      ) {
        throw new DomesticCheckoutError(
          'REFUND_EVIDENCE_REQUIRED',
          'Reversal SaleTransaction requires non-empty paymentProofStorageKey.',
        );
      }

      validatePaymentSettlementInvariants({
        paymentSettlementState: reversalPaymentSettlementState,
        cashCustodyState: reversalCashCustodyState,
        paymentMethod: reversalPaymentMethod,
        paymentConfirmedAt: reversalPaymentConfirmedAt,
        bankSettledAt: reversalBankSettledAt,
        bankDepositReference: reversalBankDepositReference,
        isVoidedOrReversed: false,
        voidReason: null,
      });

      const reversalSubtotal = Math.abs(taxAdj.subtotalAdjustmentMinor);
      const reversalTax = Math.abs(taxAdj.taxOrVatAdjustmentMinor);
      const reversalGross = Math.abs(taxAdj.grossAdjustmentMinor);

      await tx.insertSaleTransaction({
        id: reversalSaleId,
        organizationId,
        receiptNumber: creditNoteReference,
        marketNode: sale.marketNode,
        domesticChannel: sale.domesticChannel,
        exportChannel: sale.exportChannel,
        deliveryMethod: sale.deliveryMethod,
        destinationCountryCode: sale.destinationCountryCode,
        destinationProvinceOrState: sale.destinationProvinceOrState,
        exportProofStorageKey: sale.exportProofStorageKey,
        taxInvoiceNumber: null,
        buyerName: sale.buyerName,
        buyerPhoneE164: sale.buyerPhoneE164,
        soldByUserId: sale.soldByUserId,
        verifiedByAdminId: tenantCtx.userId,
        paymentCurrency: 'CAD',
        floorPriceAtCheckoutMinor: sale.floorPriceAtCheckoutMinor,
        subtotalMinor: reversalSubtotal,
        discountAmountMinor: 0,
        discountReasonCode: null,
        cfoOverrideApprovedById: null,
        cfoOverrideReasonNote: null,
        platformFeeMinor: effectiveFee,
        actualPlatformFeeMinor: null,
        shippingCostMinor: sale.shippingCostMinor,
        taxCollectionMode: sale.taxCollectionMode,
        appliedTaxJurisdiction: sale.appliedTaxJurisdiction,
        appliedTaxRateBps: sale.appliedTaxRateBps,
        taxOrVatMinor: reversalTax,
        buyerTaxRemittedByPlatformMinor: sale.buyerTaxRemittedByPlatformMinor,
        estimatedPlatformFeeTaxCadMinor: sale.estimatedPlatformFeeTaxCadMinor,
        itcReceivableCadMinor: 0,
        isFeeTaxInvoiceVerified: false,
        feeTaxInvoiceStorageKey: null,
        grossCollectedMinor: reversalGross,
        netRealizedCadMinor: effectiveNet,
        paymentMethod: reversalPaymentMethod,
        paymentSettlementState: reversalPaymentSettlementState,
        paymentConfirmedAt: reversalPaymentConfirmedAt,
        bankSettledAt: reversalBankSettledAt,
        bankDepositReference: reversalBankDepositReference,
        settlementProofStorageKey: reversalSettlementProofStorageKey,
        cashCustodyState: reversalCashCustodyState,
        ebayDelistAttestedAt: sale.ebayDelistAttestedAt,
        complianceWarnings: sale.complianceWarnings,
        paymentProofStorageKey: reversalPaymentProofStorageKey,
        billOfSaleStorageKey: sale.billOfSaleStorageKey,
        isPaymentVerified:
          reversalPaymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' ||
          reversalPaymentSettlementState === 'PAYMENT_CONFIRMED',
        gateReleasedAt: sale.gateReleasedAt,
        isVoidedOrReversed: false,
        reversesSaleTxId: sale.id,
        voidReason: null,
        createdAt: now,
      });

      await tx.markSaleRefundedOrChargedBack({
        organizationId,
        saleId: sale.id,
        voidReason: trimmedReason,
      });

      const returnedPartIds: string[] = [];
      if (input.returnPartsToQcHold && sale.partItems.length > 0) {
        const partIdsToLock = [...new Set(sale.partItems.map((i) => i.partId))].sort();
        const lockedParts = await tx.lockPartsByIds(
          organizationId,
          partIdsToLock,
        );
        for (const part of lockedParts) {
          const alreadyHeldInIssue8Qc =
            part.custodyState === 'RESTOCKED_QC_HOLD' &&
            part.availabilityState === 'RETURNED_QC_HOLD' &&
            part.complianceState === 'NEEDS_HUMAN_REVIEW' &&
            part.ebaySyncState === 'DELISTED';
          if (alreadyHeldInIssue8Qc) {
            returnedPartIds.push(part.id);
            continue;
          }

          const transition = validatePartTransition(
            toPartStateSnapshot(part),
            'RETURN_FROM_BUYER',
            {},
          );
          const nextVersion = part.version + 1;
          const ok = await tx.updatePartAfterCheckoutOrReturn({
            organizationId,
            partId: part.id,
            expectedVersion: part.version,
            nextVersion,
            custodyState: transition.nextState.custodyState,
            availabilityState: transition.nextState.availabilityState,
            ebaySyncState: transition.nextState.ebaySyncState,
            classifiedsSyncState: transition.nextState.classifiedsSyncState,
            complianceState: transition.nextState.complianceState,
            updatedAt: now,
          });
          if (!ok) {
            throw new DomesticCheckoutError(
              'INVENTORY_CONFLICT',
              `Concurrent modification prevented return QC hold for part "${part.qrSkuCode}".`,
            );
          }

          await tx.insertCustodyEvent({
            id: this.nextUuid(),
            organizationId,
            partId: part.id,
            actorUserId: tenantCtx.userId,
            idempotencyKey: `refund-return:${reversalSaleId}:${part.id}`,
            fromLocationBarcode: null,
            toLocationBarcode:
              part.storageLocationBarcode ?? 'RETURN_QC_HOLD',
            expectedVersion: part.version,
            hasConflict: false,
            complianceWarnings: [],
            deviceTimestamp: now,
            serverReceivedAt: now,
          });
          returnedPartIds.push(part.id);
        }
      }

      const isFullEbayCorpBank =
        chosenFundingSource === 'CORP_BANK' &&
        sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' &&
        (sale.domesticChannel === 'EBAY_MOTORS_SHIPPED' ||
          sale.taxCollectionMode === 'MARKETPLACE_FACILITATOR_COLLECTED');
      const bankCashAdjustmentCadMinor =
        chosenFundingSource === 'CORP_BANK'
          ? isFullEbayCorpBank
            ? -Math.max(0, sale.grossCollectedMinor - effectiveFee)
            : -reversalGross
          : null;

      const result: RecordSaleRefundResult = {
        originalSaleId: sale.id,
        reversalSaleId,
        organizationId,
        creditNoteReference,
        originalPaymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
        reversalPaymentSettlementState,
        reversalCashCustodyState,
        chosenFundingSource,
        proofOrigin,
        referenceOrigin,
        subtotalAdjustmentMinor: taxAdj.subtotalAdjustmentMinor,
        taxOrVatAdjustmentMinor: taxAdj.taxOrVatAdjustmentMinor,
        grossAdjustmentMinor: taxAdj.grossAdjustmentMinor,
        netRealizedCadAdjustmentMinor: -effectiveNet,
        bankCashAdjustmentCadMinor,
        returnedPartIds,
        auditLogId: receiptId,
      };

      await tx.insertAuditLog({
        id: receiptId,
        organizationId,
        actorUserId: tenantCtx.userId,
        entityType: 'SaleTransaction',
        entityId: sale.id,
        action: CHECKOUT_AUDIT_ACTIONS.SALE_REFUNDED_OR_CHARGED_BACK,
        previousState: {
          paymentSettlementState: sale.paymentSettlementState,
          cashCustodyState: sale.cashCustodyState,
          isVoidedOrReversed: sale.isVoidedOrReversed,
        },
        nextState: {
          schemaVersion: CHECKOUT_RECEIPT_SCHEMA_VERSION,
          action: 'record-refund-or-chargeback',
          ...(idempotencyKey ? { idempotencyKey, commandFingerprint } : {}),
          effectiveFee,
          effectiveNet,
          floatDecisionMetadata,
          result,
        },
        createdAt: now,
      });

      return result;
    });
  }
}
