import {
  CashCustodyState,
  CurrencyCode,
  DomesticSaleChannel,
  ExportSaleChannel,
  LocationOperationalStatus,
  PaymentSettlementState,
  SaleMarketNode,
  TaxCollectionMode,
  UserRole,
} from '@prisma/client';
import {
  PHASE1A_SEED_FIXTURES,
  SeedConflictError,
  type Phase1ASeedStore,
  type Phase1ASeedTx,
  type SeedOrganizationInput,
  type SeedOrganizationMembershipInput,
  type SeedPartInput,
  type SeedScrapComponentLogInput,
  type SeedShipmentInput,
  type SeedStorageLocationInput,
  type SeedUserInput,
  type SeedVehicleInput,
} from '../../../prisma/seed';
import {
  TenantContextError,
  type TenantExecutionContext,
} from './tenant-transaction';

export class InMemoryConstraintError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'InMemoryConstraintError';
    this.code = code;
  }
}

export interface InMemoryOrganizationRecord extends SeedOrganizationInput {}

export interface InMemoryUserRecord extends SeedUserInput {}

export interface InMemoryMembershipRecord
  extends SeedOrganizationMembershipInput {}

export interface InMemoryStorageLocationRecord
  extends SeedStorageLocationInput {}

export interface InMemoryVehicleRecord extends SeedVehicleInput {}

export interface InMemoryPartRecord extends SeedPartInput {}

export interface InMemoryScrapComponentLogRecord
  extends SeedScrapComponentLogInput {}

export interface InMemoryShipmentRecord extends SeedShipmentInput {}

export interface InMemorySaleTransactionRecord {
  id: string;
  organizationId: string;
  receiptNumber: string;
  marketNode: SaleMarketNode;
  domesticChannel: DomesticSaleChannel | null;
  exportChannel: ExportSaleChannel | null;
  deliveryMethod: string;
  destinationCountryCode: string;
  destinationProvinceOrState: string | null;
  exportProofStorageKey: string | null;
  taxInvoiceNumber: string | null;
  buyerName: string;
  buyerPhoneE164: string | null;
  soldByUserId: string;
  brokerUserId: string | null;
  verifiedByAdminId: string;
  paymentCurrency: CurrencyCode;
  subtotalMinor: number;
  discountAmountMinor: number;
  platformFeeMinor: number;
  shippingCostMinor: number;
  taxCollectionMode: TaxCollectionMode;
  appliedTaxJurisdiction: string;
  appliedTaxRateBps: number;
  taxOrVatMinor: number;
  buyerTaxRemittedByPlatformMinor: number | null;
  estimatedPlatformFeeTaxCadMinor: number;
  itcReceivableCadMinor: number;
  isFeeTaxInvoiceVerified: boolean;
  feeTaxInvoiceStorageKey: string | null;
  grossCollectedMinor: number;
  netRealizedCadMinor: number;
  paymentMethod: string;
  paymentSettlementState: PaymentSettlementState;
  paymentConfirmedAt: Date | null;
  bankSettledAt: Date | null;
  bankDepositReference: string | null;
  settlementProofStorageKey: string | null;
  cashCustodyState: CashCustodyState;
  paymentProofStorageKey: string;
  billOfSaleStorageKey: string | null;
  brokerCommissionBps: number;
  brokerCommissionMinor: number;
  brokerCommissionPaidAt: Date | null;
  isPaymentVerified: boolean;
  isVoidedOrReversed: boolean;
  reversesSaleTxId: string | null;
  voidReason: string | null;
  createdAt: Date;
}

export interface InMemorySalePartItemRecord {
  id: string;
  organizationId: string;
  saleTransactionId: string;
  partId: string;
  soldPriceMinor: number;
  isActiveSale: boolean;
}

export interface InMemorySaleVehicleItemRecord {
  id: string;
  organizationId: string;
  saleTransactionId: string;
  vehicleId: string;
  soldPriceMinor: number;
  isActiveSale: boolean;
}

export interface InMemoryCustodyEventRecord {
  id: string;
  organizationId: string;
  aggregateType: string;
  partId: string | null;
  vehicleId: string | null;
  cannabisLotId: string | null;
  actorUserId: string;
  eventType: string;
  createdAt: Date;
}

export interface InMemoryAuditLogRecord {
  id: string;
  organizationId: string;
  actorUserId: string;
  actionType: string;
  aggregateType: string;
  aggregateId: string;
  createdAt: Date;
}

export interface InMemoryDatabaseState {
  organizations: InMemoryOrganizationRecord[];
  users: InMemoryUserRecord[];
  memberships: InMemoryMembershipRecord[];
  storageLocations: InMemoryStorageLocationRecord[];
  vehicles: InMemoryVehicleRecord[];
  parts: InMemoryPartRecord[];
  scrapLogs: InMemoryScrapComponentLogRecord[];
  shipments: InMemoryShipmentRecord[];
  saleTransactions: InMemorySaleTransactionRecord[];
  salePartItems: InMemorySalePartItemRecord[];
  saleVehicleItems: InMemorySaleVehicleItemRecord[];
  custodyEvents: InMemoryCustodyEventRecord[];
  auditLogs: InMemoryAuditLogRecord[];
}

export type CreateInMemorySaleTransactionInput = Omit<
  InMemorySaleTransactionRecord,
  'createdAt' | 'deliveryMethod' | 'destinationCountryCode' | 'taxOrVatMinor'
> & {
  deliveryMethod?: string;
  destinationCountryCode?: string;
  taxOrVatMinor?: number;
  createdAt?: Date;
  partItems?: Array<{
    id: string;
    partId: string;
    soldPriceMinor: number;
    isActiveSale?: boolean;
  }>;
  vehicleItems?: Array<{
    id: string;
    vehicleId: string;
    soldPriceMinor: number;
    isActiveSale?: boolean;
  }>;
};

export interface UpdateInMemorySaleTransactionPatch {
  paymentSettlementState?: PaymentSettlementState;
  cashCustodyState?: CashCustodyState;
  paymentMethod?: string;
  paymentConfirmedAt?: Date | null;
  bankSettledAt?: Date | null;
  bankDepositReference?: string | null;
  settlementProofStorageKey?: string | null;
  isPaymentVerified?: boolean;
  brokerCommissionPaidAt?: Date | null;
  isVoidedOrReversed?: boolean;
  voidReason?: string | null;
  isFeeTaxInvoiceVerified?: boolean;
  itcReceivableCadMinor?: number;
  feeTaxInvoiceStorageKey?: string | null;
  buyerTaxRemittedByPlatformMinor?: number | null;
  // Intentionally exposed in type only as partial record keys so callers testing
  // immutability guards can attempt forbidden mutations.
  subtotalMinor?: number;
  taxOrVatMinor?: number;
  taxCollectionMode?: TaxCollectionMode;
  appliedTaxRateBps?: number;
  netRealizedCadMinor?: number;
  grossCollectedMinor?: number;
  organizationId?: string;
}

export interface InMemoryTenantScope {
  readonly context: TenantExecutionContext;
  listUsers(): InMemoryUserRecord[];
  updateUserProfile(
    targetUserId: string,
    patch: Partial<
      Pick<
        InMemoryUserRecord,
        'fullName' | 'phoneE164' | 'role' | 'isActive' | 'mfaEnrolled' | 'commissionRateBps'
      >
    >,
  ): InMemoryUserRecord;
  insertUserForbidden(input: SeedUserInput): never;
  deleteUserForbidden(userId: string): never;
  listStorageLocations(): InMemoryStorageLocationRecord[];
  listVehicles(): InMemoryVehicleRecord[];
  createVehicle(input: SeedVehicleInput): InMemoryVehicleRecord;
  listParts(): InMemoryPartRecord[];
  createPart(input: SeedPartInput): InMemoryPartRecord;
  listScrapComponentLogs(): InMemoryScrapComponentLogRecord[];
  updateScrapComponentLog(id: string, payoutCadMinor: number): never;
  deleteScrapComponentLog(id: string): never;
  listShipments(): InMemoryShipmentRecord[];
  listSaleTransactions(): InMemorySaleTransactionRecord[];
  createSaleTransaction(
    input: CreateInMemorySaleTransactionInput,
  ): InMemorySaleTransactionRecord;
  updateSaleTransaction(
    saleTxId: string,
    patch: UpdateInMemorySaleTransactionPatch,
  ): InMemorySaleTransactionRecord;
  deleteSaleTransaction(saleTxId: string): never;
  listSalePartItems(saleTxId: string): InMemorySalePartItemRecord[];
  listSaleVehicleItems(saleTxId: string): InMemorySaleVehicleItemRecord[];
  appendCustodyEvent(
    input: Omit<InMemoryCustodyEventRecord, 'createdAt'> & { createdAt?: Date },
  ): InMemoryCustodyEventRecord;
  deleteCustodyEvent(id: string): never;
  appendAuditLog(
    input: Omit<InMemoryAuditLogRecord, 'createdAt'> & { createdAt?: Date },
  ): InMemoryAuditLogRecord;
  deleteAuditLog(id: string): never;
}

export interface InMemoryBootstrapScope {
  readonly userId: string;
  getSelfUser(): InMemoryUserRecord | null;
  listActiveMemberships(): InMemoryMembershipRecord[];
  listAccessibleOrganizations(): InMemoryOrganizationRecord[];
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ROLES = new Set<UserRole>(Object.values(UserRole));

function isNonBlankString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new TenantContextError(
      'INVALID_TENANT_CONTEXT_INPUT',
      `Invalid UUID for ${label}.`,
    );
  }
  return value.toLowerCase();
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function validateSaleSettlementCustody(
  row: InMemorySaleTransactionRecord,
): void {
  const s = row.paymentSettlementState;
  const c = row.cashCustodyState;

  if (
    s === PaymentSettlementState.SALE_RECORDED ||
    s === PaymentSettlementState.PAYMENT_INITIATED ||
    s === PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING ||
    s === PaymentSettlementState.BANK_SETTLEMENT_PENDING
  ) {
    if (
      c !== CashCustodyState.PENDING_EXTERNAL_RECEIVABLE ||
      row.bankSettledAt !== null
    ) {
      throw new InMemoryConstraintError(
        'sale_settlement_custody_consistency',
        `Settlement state ${s} requires PENDING_EXTERNAL_RECEIVABLE and NULL bankSettledAt.`,
      );
    }
    return;
  }

  if (s === PaymentSettlementState.PAYMENT_CONFIRMED) {
    const validCashStates = new Set<CashCustodyState>([
      CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      CashCustodyState.HELD_IN_DESTINATION_VAULT,
      CashCustodyState.DEPOSITED_DESTINATION_BANK,
    ]);
    if (
      !validCashStates.has(c) ||
      row.paymentConfirmedAt === null ||
      row.bankSettledAt !== null
    ) {
      throw new InMemoryConstraintError(
        'sale_settlement_custody_consistency',
        'PAYMENT_CONFIRMED requires field/vault/dest-bank custody, paymentConfirmedAt, and NULL bankSettledAt.',
      );
    }
    return;
  }

  if (s === PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED) {
    if (
      c !== CashCustodyState.SETTLED_ORIGIN_CORP_BANK ||
      row.bankSettledAt === null ||
      !isNonBlankString(row.bankDepositReference)
    ) {
      throw new InMemoryConstraintError(
        'sale_settlement_custody_consistency',
        'BANK_SETTLEMENT_CONFIRMED requires SETTLED_ORIGIN_CORP_BANK, bankSettledAt, and non-blank bankDepositReference.',
      );
    }
    return;
  }

  if (s === PaymentSettlementState.REFUNDED_OR_CHARGED_BACK) {
    if (!row.isVoidedOrReversed || !isNonBlankString(row.voidReason)) {
      throw new InMemoryConstraintError(
        'sale_settlement_custody_consistency',
        'REFUNDED_OR_CHARGED_BACK requires isVoidedOrReversed=true and non-blank voidReason.',
      );
    }
  }
}

function validateSaleTaxMode(row: InMemorySaleTransactionRecord): void {
  if (
    row.domesticChannel === DomesticSaleChannel.EBAY_MOTORS_SHIPPED &&
    (row.taxCollectionMode !==
      TaxCollectionMode.MARKETPLACE_FACILITATOR_COLLECTED ||
      row.taxOrVatMinor !== 0)
  ) {
    throw new InMemoryConstraintError(
      'sale_tax_collection_mode_consistency',
      'EBAY_MOTORS_SHIPPED must use MARKETPLACE_FACILITATOR_COLLECTED with taxOrVatMinor = 0.',
    );
  }

  if (
    row.taxCollectionMode !== TaxCollectionMode.DIRECT_SELLER_COLLECTED &&
    row.taxOrVatMinor !== 0
  ) {
    throw new InMemoryConstraintError(
      'sale_tax_collection_mode_consistency',
      'Seller-collected taxOrVatMinor must be 0 unless taxCollectionMode is DIRECT_SELLER_COLLECTED.',
    );
  }

  if (row.taxCollectionMode === TaxCollectionMode.ZERO_RATED_EXPORT) {
    if (
      !row.destinationCountryCode ||
      row.destinationCountryCode === 'CA' ||
      row.deliveryMethod !== 'SELLER_SHIPPED' ||
      !isNonBlankString(row.exportProofStorageKey)
    ) {
      throw new InMemoryConstraintError(
        'sale_tax_collection_mode_consistency',
        'ZERO_RATED_EXPORT requires non-CA destination, SELLER_SHIPPED, and non-blank exportProofStorageKey.',
      );
    }
  }

  if (row.itcReceivableCadMinor !== 0) {
    if (
      !row.isFeeTaxInvoiceVerified ||
      !isNonBlankString(row.feeTaxInvoiceStorageKey)
    ) {
      throw new InMemoryConstraintError(
        'sale_tax_collection_mode_consistency',
        'Non-zero itcReceivableCadMinor requires verified fee tax invoice evidence.',
      );
    }
  }
}

function validateSaleRowConstraints(row: InMemorySaleTransactionRecord): void {
  if (row.brokerCommissionPaidAt !== null && !row.isPaymentVerified) {
    throw new InMemoryConstraintError(
      'commission_requires_verified_payment',
      'brokerCommissionPaidAt requires isPaymentVerified = true.',
    );
  }

  const validDomestic =
    row.marketNode === SaleMarketNode.DOMESTIC_ORIGIN &&
    row.domesticChannel !== null &&
    row.exportChannel === null;
  const validExport =
    row.marketNode === SaleMarketNode.DESTINATION_EXPORT_VAULT &&
    row.exportChannel !== null &&
    row.domesticChannel === null;
  if (!validDomestic && !validExport) {
    throw new InMemoryConstraintError(
      'sale_channel_node_integrity',
      'domesticChannel and exportChannel must be mutually exclusive matching marketNode.',
    );
  }

  if (
    row.domesticChannel === DomesticSaleChannel.RETAIL_LOT_VEHICLE_SALE &&
    !isNonBlankString(row.billOfSaleStorageKey)
  ) {
    throw new InMemoryConstraintError(
      'retail_lot_vehicle_bill_of_sale_required',
      'RETAIL_LOT_VEHICLE_SALE requires a non-blank billOfSaleStorageKey.',
    );
  }

  validateSaleSettlementCustody(row);
  validateSaleTaxMode(row);
}

function validateSaleSettlementTransition(
  prev: InMemorySaleTransactionRecord,
  next: InMemorySaleTransactionRecord,
): void {
  if (next.paymentSettlementState === prev.paymentSettlementState) {
    return;
  }

  if (prev.paymentSettlementState === PaymentSettlementState.REFUNDED_OR_CHARGED_BACK) {
    throw new InMemoryConstraintError(
      'enforce_sale_settlement_transition',
      `Terminal REFUNDED_OR_CHARGED_BACK SaleTransaction cannot transition to ${next.paymentSettlementState}.`,
    );
  }

  let allowed = false;
  if (next.paymentSettlementState === PaymentSettlementState.REFUNDED_OR_CHARGED_BACK) {
    allowed = true;
  } else if (
    prev.paymentSettlementState === PaymentSettlementState.SALE_RECORDED &&
    (next.paymentSettlementState === PaymentSettlementState.PAYMENT_INITIATED ||
      next.paymentSettlementState ===
        PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING)
  ) {
    allowed = true;
  } else if (
    prev.paymentSettlementState === PaymentSettlementState.PAYMENT_INITIATED &&
    (next.paymentSettlementState === PaymentSettlementState.PAYMENT_CONFIRMED ||
      next.paymentSettlementState ===
        PaymentSettlementState.BANK_SETTLEMENT_PENDING)
  ) {
    allowed = true;
  } else if (
    prev.paymentSettlementState ===
      PaymentSettlementState.MARKETPLACE_PAYOUT_PENDING &&
    (next.paymentSettlementState ===
      PaymentSettlementState.BANK_SETTLEMENT_PENDING ||
      next.paymentSettlementState ===
        PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED)
  ) {
    allowed = true;
  } else if (
    prev.paymentSettlementState ===
      PaymentSettlementState.BANK_SETTLEMENT_PENDING &&
    next.paymentSettlementState ===
      PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED
  ) {
    allowed = true;
  } else if (
    next.paymentSettlementState ===
      PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED &&
    next.paymentMethod === 'VERIFIED_BANK_WIRE' &&
    (prev.paymentSettlementState === PaymentSettlementState.SALE_RECORDED ||
      prev.paymentSettlementState === PaymentSettlementState.PAYMENT_INITIATED ||
      prev.paymentMethod === 'VERIFIED_BANK_WIRE')
  ) {
    allowed = true;
  }

  if (!allowed) {
    throw new InMemoryConstraintError(
      'enforce_sale_settlement_transition',
      `Illegal PaymentSettlementState transition from ${prev.paymentSettlementState} to ${next.paymentSettlementState}.`,
    );
  }
}

export class InMemoryPhase1AStore implements Phase1ASeedStore {
  private state: InMemoryDatabaseState;
  private activeNestedContext: TenantExecutionContext | null = null;

  public constructor(initialState?: Partial<InMemoryDatabaseState>) {
    this.state = {
      organizations: cloneValue(initialState?.organizations ?? []),
      users: cloneValue(initialState?.users ?? []),
      memberships: cloneValue(initialState?.memberships ?? []),
      storageLocations: cloneValue(initialState?.storageLocations ?? []),
      vehicles: cloneValue(initialState?.vehicles ?? []),
      parts: cloneValue(initialState?.parts ?? []),
      scrapLogs: cloneValue(initialState?.scrapLogs ?? []),
      shipments: cloneValue(initialState?.shipments ?? []),
      saleTransactions: cloneValue(initialState?.saleTransactions ?? []),
      salePartItems: cloneValue(initialState?.salePartItems ?? []),
      saleVehicleItems: cloneValue(initialState?.saleVehicleItems ?? []),
      custodyEvents: cloneValue(initialState?.custodyEvents ?? []),
      auditLogs: cloneValue(initialState?.auditLogs ?? []),
    };
  }

  public getSnapshot(): InMemoryDatabaseState {
    return cloneValue(this.state);
  }

  public getOrganizationPolicy(organizationId: string): {
    organizationId: string;
    policyConfigJson: unknown;
  } | null {
    const org = this.state.organizations.find((o) => o.id === organizationId);
    if (!org) {
      return null;
    }
    return {
      organizationId: org.id,
      policyConfigJson: cloneValue(org.policyConfigJson),
    };
  }

  /** Admin/owner test helper simulating membership revocation outside tenant scope. */
  public setMembershipActive(
    organizationId: string,
    userId: string,
    isActive: boolean,
    revocationReason: string | null = null,
  ): void {
    const membership = this.state.memberships.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (!membership) {
      throw new Error(
        `Membership (${organizationId}, ${userId}) not found in InMemoryPhase1AStore.`,
      );
    }
    membership.isActive = isActive;
    membership.deactivatedAt = isActive ? null : new Date();
    membership.revocationReason = isActive ? null : revocationReason;
  }

  public async withTransaction<T>(
    fn: (tx: Phase1ASeedTx) => Promise<T>,
  ): Promise<T> {
    const draft = cloneValue(this.state);
    const seedTx = this.createSeedTx(draft);
    const result = await fn(seedTx);
    this.state = draft;
    return result;
  }

  public async withAuthBootstrapTransaction<T>(
    authenticatedUserId: string,
    fn: (tx: InMemoryBootstrapScope) => Promise<T>,
  ): Promise<T> {
    const userId = normalizeUuid(authenticatedUserId, 'authenticatedUserId');
    const draft = cloneValue(this.state);

    const bootstrapTx: InMemoryBootstrapScope = {
      userId,
      getSelfUser: () => {
        const user = draft.users.find((u) => u.id === userId);
        return user ? cloneValue(user) : null;
      },
      listActiveMemberships: () =>
        cloneValue(
          draft.memberships.filter(
            (m) => m.userId === userId && m.isActive,
          ),
        ),
      listAccessibleOrganizations: () => {
        const orgIds = new Set(
          draft.memberships
            .filter((m) => m.userId === userId && m.isActive)
            .map((m) => m.organizationId),
        );
        return cloneValue(
          draft.organizations.filter((o) => orgIds.has(o.id) && o.isActive),
        );
      },
    };

    const result = await fn(bootstrapTx);
    this.state = draft;
    return result;
  }

  public async withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: InMemoryTenantScope) => Promise<T>,
  ): Promise<T> {
    const normalizedCtx: TenantExecutionContext = {
      organizationId: normalizeUuid(ctx.organizationId, 'organizationId'),
      userId: normalizeUuid(ctx.userId, 'userId'),
      role: ctx.role,
    };
    if (!VALID_ROLES.has(normalizedCtx.role)) {
      throw new TenantContextError(
        'INVALID_TENANT_CONTEXT_INPUT',
        `Unsupported role "${String(normalizedCtx.role)}".`,
      );
    }

    if (this.activeNestedContext) {
      if (
        this.activeNestedContext.organizationId !== normalizedCtx.organizationId ||
        this.activeNestedContext.userId !== normalizedCtx.userId ||
        this.activeNestedContext.role !== normalizedCtx.role
      ) {
        throw new TenantContextError(
          'NESTED_TENANT_CONTEXT_MISMATCH',
          'Nested withTenantTransaction cannot switch organizationId, userId, or role inside an active transaction.',
        );
      }
      this.assertAuthorized(this.state, normalizedCtx);
      return fn(this.createTenantScope(this.state, normalizedCtx));
    }

    const draft = cloneValue(this.state);
    this.assertAuthorized(draft, normalizedCtx);

    this.activeNestedContext = normalizedCtx;
    try {
      const scope = this.createTenantScope(draft, normalizedCtx);
      const result = await fn(scope);
      this.state = draft;
      return result;
    } finally {
      this.activeNestedContext = null;
    }
  }

  private assertAuthorized(
    db: InMemoryDatabaseState,
    ctx: TenantExecutionContext,
  ): void {
    const org = db.organizations.find((o) => o.id === ctx.organizationId);
    const user = db.users.find((u) => u.id === ctx.userId);
    const membership = db.memberships.find(
      (m) =>
        m.organizationId === ctx.organizationId &&
        m.userId === ctx.userId &&
        m.role === ctx.role,
    );
    if (
      !org ||
      !org.isActive ||
      !user ||
      !user.isActive ||
      !membership ||
      !membership.isActive
    ) {
      throw new TenantContextError(
        'TENANT_CONTEXT_UNAUTHORIZED',
        `Tenant context denied for org=${ctx.organizationId} user=${ctx.userId} role=${ctx.role}.`,
      );
    }
  }

  private createSeedTx(draft: InMemoryDatabaseState): Phase1ASeedTx {
    return {
      upsertOrganization: async (input) => {
        const existing = draft.organizations.find(
          (o) => o.id === input.id || o.slug === input.slug,
        );
        if (existing) {
          if (
            existing.id !== input.id ||
            existing.slug !== input.slug ||
            existing.organizationType !== input.organizationType
          ) {
            throw new SeedConflictError(
              `Organization fixture conflict for slug "${input.slug}".`,
            );
          }
          return { created: false };
        }
        draft.organizations.push(cloneValue(input));
        return { created: true };
      },

      upsertUser: async (input) => {
        const existing = draft.users.find(
          (u) => u.id === input.id || u.email === input.email,
        );
        if (existing) {
          if (existing.id !== input.id || existing.email !== input.email) {
            throw new SeedConflictError(
              `User fixture conflict for email "${input.email}".`,
            );
          }
          return { created: false };
        }
        draft.users.push(cloneValue(input));
        return { created: true };
      },

      upsertOrganizationMembership: async (input) => {
        const existing = draft.memberships.find(
          (m) =>
            m.id === input.id ||
            (m.organizationId === input.organizationId &&
              m.userId === input.userId),
        );
        if (existing) {
          if (
            existing.id !== input.id ||
            existing.organizationId !== input.organizationId ||
            existing.userId !== input.userId
          ) {
            throw new SeedConflictError(
              `OrganizationMembership fixture conflict for (${input.organizationId}, ${input.userId}).`,
            );
          }
          return { created: false };
        }
        if (!draft.organizations.some((o) => o.id === input.organizationId)) {
          throw new InMemoryConstraintError(
            'fk_organization',
            `Missing Organization ${input.organizationId}.`,
          );
        }
        if (!draft.users.some((u) => u.id === input.userId)) {
          throw new InMemoryConstraintError(
            'fk_user',
            `Missing User ${input.userId}.`,
          );
        }
        draft.memberships.push(cloneValue(input));
        return { created: true };
      },

      upsertStorageLocation: async (input) => {
        const existing = draft.storageLocations.find(
          (s) => s.id === input.id || s.fullQrBarcode === input.fullQrBarcode,
        );
        if (existing) {
          if (
            existing.id !== input.id ||
            existing.organizationId !== input.organizationId ||
            existing.fullQrBarcode !== input.fullQrBarcode ||
            existing.allowedOrgType !== input.allowedOrgType
          ) {
            throw new SeedConflictError(
              `StorageLocation fixture conflict for barcode "${input.fullQrBarcode}".`,
            );
          }
          return { created: false };
        }
        if (!draft.organizations.some((o) => o.id === input.organizationId)) {
          throw new InMemoryConstraintError(
            'fk_organization',
            `Missing Organization ${input.organizationId}.`,
          );
        }
        draft.storageLocations.push(cloneValue(input));
        return { created: true };
      },

      insertVehicleIfAbsent: async (input) => {
        const existing = draft.vehicles.find(
          (v) =>
            v.id === input.id ||
            v.internalStockNumber === input.internalStockNumber ||
            v.vinOrHin === input.vinOrHin,
        );
        if (existing) {
          if (
            existing.id !== input.id ||
            existing.organizationId !== input.organizationId ||
            existing.internalStockNumber !== input.internalStockNumber ||
            existing.vinOrHin !== input.vinOrHin
          ) {
            throw new SeedConflictError(
              `Vehicle fixture conflict for stock "${input.internalStockNumber}".`,
            );
          }
          return { created: false };
        }
        assertSameOrgLocation(draft, input.organizationId, input.storageLocationId);
        draft.vehicles.push(cloneValue(input));
        return { created: true };
      },

      insertPartIfAbsent: async (input) => {
        const existing = draft.parts.find(
          (p) => p.id === input.id || p.qrSkuCode === input.qrSkuCode,
        );
        if (existing) {
          if (
            existing.id !== input.id ||
            existing.organizationId !== input.organizationId ||
            existing.qrSkuCode !== input.qrSkuCode
          ) {
            throw new SeedConflictError(
              `Part fixture conflict for SKU "${input.qrSkuCode}".`,
            );
          }
          return { created: false };
        }
        assertSameOrgVehicle(draft, input.organizationId, input.donorVehicleId);
        assertSameOrgLocation(draft, input.organizationId, input.storageLocationId);
        draft.parts.push(cloneValue(input));
        return { created: true };
      },

      insertScrapComponentLogIfAbsent: async (input) => {
        const existing = draft.scrapLogs.find((s) => s.id === input.id);
        if (existing) {
          if (
            existing.organizationId !== input.organizationId ||
            existing.vehicleId !== input.vehicleId ||
            existing.scrapStream !== input.scrapStream ||
            existing.payoutCadMinor !== input.payoutCadMinor
          ) {
            throw new SeedConflictError(
              `Immutable ScrapComponentLog fixture conflict for id "${input.id}".`,
            );
          }
          return { created: false };
        }
        assertSameOrgVehicle(draft, input.organizationId, input.vehicleId);
        draft.scrapLogs.push(cloneValue(input));
        return { created: true };
      },

      insertShipmentIfAbsent: async (input) => {
        const existing = draft.shipments.find(
          (s) => s.id === input.id || s.shipmentCode === input.shipmentCode,
        );
        if (existing) {
          if (
            existing.id !== input.id ||
            existing.organizationId !== input.organizationId ||
            existing.shipmentCode !== input.shipmentCode
          ) {
            throw new SeedConflictError(
              `Shipment fixture conflict for code "${input.shipmentCode}".`,
            );
          }
          return { created: false };
        }
        draft.shipments.push(cloneValue(input));
        return { created: true };
      },
    };
  }

  private createTenantScope(
    draft: InMemoryDatabaseState,
    ctx: TenantExecutionContext,
  ): InMemoryTenantScope {
    const orgId = ctx.organizationId;

    const assertMutableOrgScope = (targetOrgId: string) => {
      if (targetOrgId !== orgId) {
        throw new InMemoryConstraintError(
          'RLS_VIOLATION',
          `Cross-tenant write denied: context org ${orgId} cannot write org ${targetOrgId}.`,
        );
      }
    };

    const getVisibleUserIds = (): Set<string> => {
      // Mirrors user_select_self_or_org_comember: self OR any co-member
      // (including deactivated historical FKs) in ctx.organizationId.
      const ids = new Set<string>([ctx.userId]);
      for (const m of draft.memberships) {
        if (m.organizationId === orgId) {
          ids.add(m.userId);
        }
      }
      return ids;
    };

    return {
      context: { ...ctx },

      listUsers: () => {
        const visibleIds = getVisibleUserIds();
        return cloneValue(draft.users.filter((u) => visibleIds.has(u.id)));
      },

      updateUserProfile: (targetUserId, patch) => {
        if (targetUserId !== ctx.userId) {
          throw new InMemoryConstraintError(
            'RLS_VIOLATION',
            'user_update_self_profile denies updating another user row.',
          );
        }
        if (
          patch.role !== undefined ||
          patch.isActive !== undefined ||
          patch.mfaEnrolled !== undefined ||
          patch.commissionRateBps !== undefined
        ) {
          throw new InMemoryConstraintError(
            'PERMISSION_DENIED',
            'erp_app_user cannot update privileged User columns (role, isActive, mfaEnrolled, commissionRateBps).',
          );
        }
        const user = draft.users.find((u) => u.id === targetUserId);
        if (!user) {
          throw new InMemoryConstraintError('NOT_FOUND', 'User not found.');
        }
        if (patch.fullName !== undefined) {
          user.fullName = patch.fullName;
        }
        if (patch.phoneE164 !== undefined) {
          user.phoneE164 = patch.phoneE164;
        }
        return cloneValue(user);
      },

      insertUserForbidden: () => {
        throw new InMemoryConstraintError(
          'PERMISSION_DENIED',
          'erp_app_user has no INSERT privilege on shared.User.',
        );
      },

      deleteUserForbidden: () => {
        throw new InMemoryConstraintError(
          'PERMISSION_DENIED',
          'erp_app_user has no DELETE privilege on shared.User.',
        );
      },

      listStorageLocations: () =>
        cloneValue(
          draft.storageLocations.filter((s) => s.organizationId === orgId),
        ),

      listVehicles: () =>
        cloneValue(draft.vehicles.filter((v) => v.organizationId === orgId)),

      createVehicle: (input) => {
        assertMutableOrgScope(input.organizationId);
        assertSameOrgLocation(draft, orgId, input.storageLocationId);
        if (
          input.assetCategory !== 'AUTOMOBILE' &&
          input.roadBrand !== 'NOT_APPLICABLE'
        ) {
          throw new InMemoryConstraintError(
            'non_auto_brand_check',
            'Non-automobile vehicles must have roadBrand = NOT_APPLICABLE.',
          );
        }
        const record = cloneValue(input);
        draft.vehicles.push(record);
        return cloneValue(record);
      },

      listParts: () =>
        cloneValue(draft.parts.filter((p) => p.organizationId === orgId)),

      createPart: (input) => {
        assertMutableOrgScope(input.organizationId);
        assertSameOrgVehicle(draft, orgId, input.donorVehicleId);
        assertSameOrgLocation(draft, orgId, input.storageLocationId);
        const record = cloneValue(input);
        draft.parts.push(record);
        return cloneValue(record);
      },

      listScrapComponentLogs: () =>
        cloneValue(draft.scrapLogs.filter((l) => l.organizationId === orgId)),

      updateScrapComponentLog: () => {
        throw new InMemoryConstraintError(
          'IMMUTABLE_TABLE',
          'ScrapComponentLog is append-only.',
        );
      },

      deleteScrapComponentLog: () => {
        throw new InMemoryConstraintError(
          'IMMUTABLE_TABLE',
          'ScrapComponentLog cannot be deleted.',
        );
      },

      listShipments: () =>
        cloneValue(draft.shipments.filter((s) => s.organizationId === orgId)),

      listSaleTransactions: () =>
        cloneValue(
          draft.saleTransactions.filter((s) => s.organizationId === orgId),
        ),

      createSaleTransaction: (input) => {
        assertMutableOrgScope(input.organizationId);
        if (
          input.paymentSettlementState ===
          PaymentSettlementState.REFUNDED_OR_CHARGED_BACK
        ) {
          throw new InMemoryConstraintError(
            'enforce_sale_settlement_transition',
            'New SaleTransaction cannot start in terminal REFUNDED_OR_CHARGED_BACK state.',
          );
        }
        if (
          input.paymentSettlementState ===
            PaymentSettlementState.BANK_SETTLEMENT_CONFIRMED &&
          input.paymentMethod !== 'VERIFIED_BANK_WIRE'
        ) {
          throw new InMemoryConstraintError(
            'enforce_sale_settlement_transition',
            'New SaleTransaction can only start in BANK_SETTLEMENT_CONFIRMED with paymentMethod VERIFIED_BANK_WIRE.',
          );
        }

        const record: InMemorySaleTransactionRecord = {
          ...cloneValue(input),
          deliveryMethod: input.deliveryMethod ?? 'IN_PERSON_PICKUP',
          destinationCountryCode: input.destinationCountryCode ?? 'CA',
          taxOrVatMinor: input.taxOrVatMinor ?? 0,
          createdAt: input.createdAt ?? new Date(),
        };
        validateSaleRowConstraints(record);

        if (record.reversesSaleTxId !== null) {
          const reversed = draft.saleTransactions.find(
            (s) =>
              s.organizationId === orgId && s.id === record.reversesSaleTxId,
          );
          if (!reversed) {
            throw new InMemoryConstraintError(
              'composite_fk_violation',
              'reversesSaleTxId must belong to the same organization.',
            );
          }
        }

        for (const item of input.partItems ?? []) {
          assertSameOrgPart(draft, orgId, item.partId);
          const isActiveSale = item.isActiveSale ?? true;
          if (
            isActiveSale &&
            draft.salePartItems.some(
              (existing) => existing.partId === item.partId && existing.isActiveSale,
            )
          ) {
            throw new InMemoryConstraintError(
              'unique_active_sale_part_item',
              `Part ${item.partId} already has an active SaleTransactionPartItem.`,
            );
          }
          draft.salePartItems.push({
            id: item.id,
            organizationId: orgId,
            saleTransactionId: record.id,
            partId: item.partId,
            soldPriceMinor: item.soldPriceMinor,
            isActiveSale,
          });
        }

        for (const item of input.vehicleItems ?? []) {
          assertSameOrgVehicle(draft, orgId, item.vehicleId);
          const isActiveSale = item.isActiveSale ?? true;
          if (
            isActiveSale &&
            draft.saleVehicleItems.some(
              (existing) =>
                existing.vehicleId === item.vehicleId && existing.isActiveSale,
            )
          ) {
            throw new InMemoryConstraintError(
              'unique_active_sale_vehicle_item',
              `Vehicle ${item.vehicleId} already has an active SaleTransactionVehicleItem.`,
            );
          }
          draft.saleVehicleItems.push({
            id: item.id,
            organizationId: orgId,
            saleTransactionId: record.id,
            vehicleId: item.vehicleId,
            soldPriceMinor: item.soldPriceMinor,
            isActiveSale,
          });
        }

        draft.saleTransactions.push(record);
        return cloneValue(record);
      },

      updateSaleTransaction: (saleTxId, patch) => {
        const idx = draft.saleTransactions.findIndex(
          (s) => s.id === saleTxId && s.organizationId === orgId,
        );
        if (idx === -1) {
          throw new InMemoryConstraintError(
            'RLS_OR_NOT_FOUND',
            `SaleTransaction ${saleTxId} not found in organization ${orgId}.`,
          );
        }
        const prev = draft.saleTransactions[idx]!;
        if (
          patch.organizationId !== undefined &&
          patch.organizationId !== prev.organizationId
        ) {
          throw new InMemoryConstraintError(
            'prevent_sale_tx_financial_mutation',
            'Immutable organizationId on SaleTransaction cannot be modified.',
          );
        }
        if (
          (patch.subtotalMinor !== undefined &&
            patch.subtotalMinor !== prev.subtotalMinor) ||
          (patch.taxOrVatMinor !== undefined &&
            patch.taxOrVatMinor !== prev.taxOrVatMinor) ||
          (patch.taxCollectionMode !== undefined &&
            patch.taxCollectionMode !== prev.taxCollectionMode) ||
          (patch.appliedTaxRateBps !== undefined &&
            patch.appliedTaxRateBps !== prev.appliedTaxRateBps) ||
          (patch.netRealizedCadMinor !== undefined &&
            patch.netRealizedCadMinor !== prev.netRealizedCadMinor) ||
          (patch.grossCollectedMinor !== undefined &&
            patch.grossCollectedMinor !== prev.grossCollectedMinor) ||
          (prev.isFeeTaxInvoiceVerified &&
            ((patch.isFeeTaxInvoiceVerified !== undefined &&
              !patch.isFeeTaxInvoiceVerified) ||
              (patch.itcReceivableCadMinor !== undefined &&
                patch.itcReceivableCadMinor !== prev.itcReceivableCadMinor) ||
              (patch.feeTaxInvoiceStorageKey !== undefined &&
                patch.feeTaxInvoiceStorageKey !== prev.feeTaxInvoiceStorageKey))) ||
          (prev.isVoidedOrReversed &&
            ((patch.isVoidedOrReversed !== undefined &&
              !patch.isVoidedOrReversed) ||
              (patch.voidReason !== undefined &&
                patch.voidReason !== prev.voidReason)))
        ) {
          throw new InMemoryConstraintError(
            'prevent_sale_tx_financial_mutation',
            'Immutable financial or tax columns on SaleTransaction cannot be modified after creation.',
          );
        }

        const next: InMemorySaleTransactionRecord = {
          ...prev,
          paymentSettlementState:
            patch.paymentSettlementState ?? prev.paymentSettlementState,
          cashCustodyState: patch.cashCustodyState ?? prev.cashCustodyState,
          paymentMethod: patch.paymentMethod ?? prev.paymentMethod,
          paymentConfirmedAt:
            patch.paymentConfirmedAt !== undefined
              ? patch.paymentConfirmedAt
              : prev.paymentConfirmedAt,
          bankSettledAt:
            patch.bankSettledAt !== undefined
              ? patch.bankSettledAt
              : prev.bankSettledAt,
          bankDepositReference:
            patch.bankDepositReference !== undefined
              ? patch.bankDepositReference
              : prev.bankDepositReference,
          settlementProofStorageKey:
            patch.settlementProofStorageKey !== undefined
              ? patch.settlementProofStorageKey
              : prev.settlementProofStorageKey,
          isPaymentVerified: patch.isPaymentVerified ?? prev.isPaymentVerified,
          brokerCommissionPaidAt:
            patch.brokerCommissionPaidAt !== undefined
              ? patch.brokerCommissionPaidAt
              : prev.brokerCommissionPaidAt,
          isVoidedOrReversed:
            patch.isVoidedOrReversed ?? prev.isVoidedOrReversed,
          voidReason:
            patch.voidReason !== undefined ? patch.voidReason : prev.voidReason,
          isFeeTaxInvoiceVerified:
            patch.isFeeTaxInvoiceVerified ?? prev.isFeeTaxInvoiceVerified,
          itcReceivableCadMinor:
            patch.itcReceivableCadMinor ?? prev.itcReceivableCadMinor,
          feeTaxInvoiceStorageKey:
            patch.feeTaxInvoiceStorageKey !== undefined
              ? patch.feeTaxInvoiceStorageKey
              : prev.feeTaxInvoiceStorageKey,
          buyerTaxRemittedByPlatformMinor:
            patch.buyerTaxRemittedByPlatformMinor !== undefined
              ? patch.buyerTaxRemittedByPlatformMinor
              : prev.buyerTaxRemittedByPlatformMinor,
        };

        validateSaleSettlementTransition(prev, next);
        validateSaleRowConstraints(next);

        if (next.isVoidedOrReversed && !prev.isVoidedOrReversed) {
          for (const item of draft.salePartItems) {
            if (
              item.organizationId === orgId &&
              item.saleTransactionId === next.id
            ) {
              item.isActiveSale = false;
            }
          }
          for (const item of draft.saleVehicleItems) {
            if (
              item.organizationId === orgId &&
              item.saleTransactionId === next.id
            ) {
              item.isActiveSale = false;
            }
          }
        }

        draft.saleTransactions[idx] = next;
        return cloneValue(next);
      },

      deleteSaleTransaction: () => {
        throw new InMemoryConstraintError(
          'IMMUTABLE_TABLE',
          'SaleTransaction cannot be deleted.',
        );
      },

      listSalePartItems: (saleTxId) =>
        cloneValue(
          draft.salePartItems.filter(
            (i) => i.organizationId === orgId && i.saleTransactionId === saleTxId,
          ),
        ),

      listSaleVehicleItems: (saleTxId) =>
        cloneValue(
          draft.saleVehicleItems.filter(
            (i) => i.organizationId === orgId && i.saleTransactionId === saleTxId,
          ),
        ),

      appendCustodyEvent: (input) => {
        assertMutableOrgScope(input.organizationId);
        const targetCount = [
          input.partId,
          input.vehicleId,
          input.cannabisLotId,
        ].filter((v) => v !== null).length;
        if (targetCount !== 1) {
          throw new InMemoryConstraintError(
            'custody_event_target_xor',
            'CustodyEvent must reference exactly one of partId, vehicleId, or cannabisLotId.',
          );
        }
        if (input.partId !== null) {
          assertSameOrgPart(draft, orgId, input.partId);
        }
        if (input.vehicleId !== null) {
          assertSameOrgVehicle(draft, orgId, input.vehicleId);
        }
        const record: InMemoryCustodyEventRecord = {
          ...cloneValue(input),
          createdAt: input.createdAt ?? new Date(),
        };
        draft.custodyEvents.push(record);
        return cloneValue(record);
      },

      deleteCustodyEvent: () => {
        throw new InMemoryConstraintError(
          'IMMUTABLE_TABLE',
          'CustodyEvent is append-only.',
        );
      },

      appendAuditLog: (input) => {
        assertMutableOrgScope(input.organizationId);
        const record: InMemoryAuditLogRecord = {
          ...cloneValue(input),
          createdAt: input.createdAt ?? new Date(),
        };
        draft.auditLogs.push(record);
        return cloneValue(record);
      },

      deleteAuditLog: () => {
        throw new InMemoryConstraintError(
          'IMMUTABLE_TABLE',
          'AuditLog is append-only.',
        );
      },
    };
  }
}

function assertSameOrgLocation(
  draft: InMemoryDatabaseState,
  organizationId: string,
  storageLocationId: string,
): void {
  const loc = draft.storageLocations.find(
    (l) => l.organizationId === organizationId && l.id === storageLocationId,
  );
  if (!loc) {
    throw new InMemoryConstraintError(
      'composite_fk_violation',
      `StorageLocation ${storageLocationId} does not exist in organization ${organizationId}.`,
    );
  }
}

function assertSameOrgVehicle(
  draft: InMemoryDatabaseState,
  organizationId: string,
  vehicleId: string,
): void {
  const vehicle = draft.vehicles.find(
    (v) => v.organizationId === organizationId && v.id === vehicleId,
  );
  if (!vehicle) {
    throw new InMemoryConstraintError(
      'composite_fk_violation',
      `Vehicle ${vehicleId} does not exist in organization ${organizationId}.`,
    );
  }
}

function assertSameOrgPart(
  draft: InMemoryDatabaseState,
  organizationId: string,
  partId: string,
): void {
  const part = draft.parts.find(
    (p) => p.organizationId === organizationId && p.id === partId,
  );
  if (!part) {
    throw new InMemoryConstraintError(
      'composite_fk_violation',
      `Part ${partId} does not exist in organization ${organizationId}.`,
    );
  }
}

export async function createSeededInMemoryPhase1AStore(): Promise<InMemoryPhase1AStore> {
  const { seedPhase1AData } = await import('../../../prisma/seed');
  const store = new InMemoryPhase1AStore();
  await seedPhase1AData(store);
  return store;
}

export { PHASE1A_SEED_FIXTURES, LocationOperationalStatus };
