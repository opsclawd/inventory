import { createHash } from 'node:crypto';
import type {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  ClassifiedsSyncState,
  CurrencyCode,
  DomesticSaleChannel,
  EbaySyncState,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  PaymentSettlementState,
  SaleMarketNode,
  TaxCollectionMode,
} from '@prisma/client';
import { z } from 'zod';
import type { IssueDomesticDeliveryMethod } from '@/core/domain';
import type { IStoragePort } from '@/core/ports/storage.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import type { PersistedLedgerProjection } from '@/modules/cfo-subledger/financial-snapshot.query';
import type { ResolvedPrice } from '@/modules/marketplace/syndication/syndication-input-resolver';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';

export const PRISMA_INT32_MAX = 2_147_483_647 as const;
export const CHECKOUT_RECEIPT_SCHEMA_VERSION = 1 as const;
export const MAX_CHECKOUT_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_CHECKOUT_METADATA_BYTES = 64 * 1024; // 64 KiB
export const MAX_CHECKOUT_MULTIPART_BYTES = 12 * 1024 * 1024; // 12 MiB

export const ALLOWED_CHECKOUT_EVIDENCE_MIME_TYPES: ReadonlySet<string> =
  new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export const ISSUE10_CHECKOUT_RECEIPT_NAMESPACE =
  'b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e' as const;

export const CHECKOUT_AUDIT_ACTIONS = {
  DOMESTIC_CHECKOUT_EXECUTED: 'DOMESTIC_CHECKOUT_EXECUTED',
  BANK_SETTLEMENT_CONFIRMED: 'SALE_BANK_SETTLEMENT_CONFIRMED',
  SALE_REFUNDED_OR_CHARGED_BACK: 'SALE_REFUNDED_OR_CHARGED_BACK',
} as const;

export type DomesticCheckoutErrorCode =
  | 'INVALID_CHECKOUT_INPUT'
  | 'PART_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'SALE_NOT_FOUND'
  | 'INVENTORY_CONFLICT'
  | 'PART_IN_RETURN_QC_HOLD'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VERSION_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'PAYMENT_PROOF_REQUIRED'
  | 'BILL_OF_SALE_REQUIRED'
  | 'BANK_DEPOSIT_REFERENCE_REQUIRED'
  | 'SETTLEMENT_PROOF_REQUIRED'
  | 'CASH_SALE_REQUIRES_CUSTODY_TRANSFER'
  | 'SALE_ALREADY_BANK_SETTLED'
  | 'SETTLEMENT_CONFLICT'
  | 'SALE_ALREADY_REVERSED'
  | 'CANNOT_REVERSE_REVERSAL_ENTRY'
  | 'ACTUAL_FEE_EBAY_ONLY'
  | 'FEE_TAX_INVOICE_EBAY_ONLY'
  | 'REFUND_REASON_REQUIRED'
  | 'REFUND_EVIDENCE_REQUIRED'
  | 'REFUND_FUNDING_SOURCE_UNRESOLVED'
  | 'OMVIC_LICENSE_REQUIRED'
  | 'CHECKOUT_INTEGRITY_ERROR';

export type DomesticCheckoutErrorStatus = 400 | 404 | 409 | 413 | 422 | 500;

const ERROR_STATUS_BY_CODE: Readonly<
  Record<DomesticCheckoutErrorCode, DomesticCheckoutErrorStatus>
> = {
  INVALID_CHECKOUT_INPUT: 400,
  PART_NOT_FOUND: 404,
  VEHICLE_NOT_FOUND: 404,
  SALE_NOT_FOUND: 404,
  INVENTORY_CONFLICT: 409,
  PART_IN_RETURN_QC_HOLD: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  PAYMENT_PROOF_REQUIRED: 422,
  BILL_OF_SALE_REQUIRED: 422,
  BANK_DEPOSIT_REFERENCE_REQUIRED: 422,
  SETTLEMENT_PROOF_REQUIRED: 422,
  CASH_SALE_REQUIRES_CUSTODY_TRANSFER: 422,
  SALE_ALREADY_BANK_SETTLED: 409,
  SETTLEMENT_CONFLICT: 409,
  SALE_ALREADY_REVERSED: 409,
  CANNOT_REVERSE_REVERSAL_ENTRY: 422,
  ACTUAL_FEE_EBAY_ONLY: 422,
  FEE_TAX_INVOICE_EBAY_ONLY: 422,
  REFUND_REASON_REQUIRED: 422,
  REFUND_EVIDENCE_REQUIRED: 422,
  REFUND_FUNDING_SOURCE_UNRESOLVED: 422,
  OMVIC_LICENSE_REQUIRED: 422,
  CHECKOUT_INTEGRITY_ERROR: 500,
};

export class DomesticCheckoutError extends Error {
  public readonly code: DomesticCheckoutErrorCode;
  public readonly status: DomesticCheckoutErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: DomesticCheckoutErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomesticCheckoutError';
    this.code = code;
    this.status = ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface CheckoutClock {
  now(): Date;
}

export type CheckoutPaymentMethod =
  | 'CASH'
  | 'INTERAC_ETRANSFER'
  | 'VERIFIED_BANK_WIRE'
  | 'EBAY_MANAGED_PAYOUT';

export type CheckoutEvidenceKind =
  | 'PAYMENT_PROOF'
  | 'BILL_OF_SALE'
  | 'EXPORT_PROOF'
  | 'SETTLEMENT_PROOF'
  | 'FEE_TAX_INVOICE'
  | 'REFUND_PROOF';

export interface CheckoutPartLineInput {
  readonly partId: string;
  readonly proposedPriceCadMinor: number;
  readonly expectedVersion?: number;
}

export interface CheckoutVehicleLineInput {
  readonly vehicleId: string;
  readonly proposedPriceCadMinor: number;
  readonly expectedVersion?: number;
}

export interface ExecuteDomesticCheckoutCommand {
  readonly marketNode?: SaleMarketNode;
  readonly paymentCurrency?: CurrencyCode;
  readonly domesticChannel: DomesticSaleChannel;
  readonly deliveryMethod: IssueDomesticDeliveryMethod;
  readonly destinationCountryCode: string;
  readonly destinationProvinceOrState?: string | null;
  readonly paymentMethod: CheckoutPaymentMethod;
  readonly isCashCountedInPerson?: boolean;
  readonly buyerName: string;
  readonly buyerPhoneE164?: string | null;
  readonly partLines?: readonly CheckoutPartLineInput[];
  readonly vehicleLines?: readonly CheckoutVehicleLineInput[];
  readonly discountReasonCode?: string | null;
  readonly cfoOverrideRequested?: boolean;
  readonly cfoOverrideReasonNote?: string | null;
  readonly paymentProofStorageKey: string;
  readonly billOfSaleStorageKey?: string | null;
  readonly exportProofStorageKey?: string | null;
  readonly buyerTaxRemittedByPlatformMinor?: number | null;
  readonly platformFeeMinor?: number;
  readonly shippingCostMinor?: number;
  readonly estimatedPlatformFeeTaxCadMinor?: number;
  readonly ebayDelistAttestedAt?: string | Date | null;
  readonly acknowledgedPriceBasisHash?: string | null;
  readonly idempotencyKey: string;
}

export interface ConfirmBankSettlementCommand {
  readonly bankDepositReference: string;
  readonly settlementProofStorageKey: string;
  readonly actualPlatformFeeMinor?: number;
  readonly feeTaxInvoiceStorageKey?: string | null;
  readonly idempotencyKey?: string;
}

export interface RecordSaleRefundCommand {
  readonly reasonNote: string;
  readonly returnPartsToQcHold: boolean;
  readonly refundBankReference?: string | null;
  readonly refundProofStorageKey?: string | null;
  readonly idempotencyKey?: string;
}

export interface CheckoutLockedPartRow {
  readonly id: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly donorVehicleId: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly partCategoryName: string;
  readonly tdgHazmatCode:
    | 'NONE'
    | 'UN3268_AIRBAG'
    | 'UN0503_PYROTECHNIC'
    | 'UN2794_WET_BATTERY'
    | 'UN3480_LITHIUM_BATTERY';
  readonly isHazmatOrAirbag: boolean;
  readonly araGrade: string;
  readonly weightKg: number;
  readonly compBaselineCadMinor: number | null;
  readonly retailPriceCadMinor: number | null;
  readonly ebayListingId: string | null;
  readonly storageLocationId: string | null;
  readonly storageLocationBarcode: string | null;
  readonly hasActiveSale: boolean;
  readonly version: number;
}

export interface CheckoutLockedVehicleRow {
  readonly id: string;
  readonly organizationId: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly storageLocationId: string | null;
  readonly storageLocationOrgId: string | null;
  readonly storageLocationAllowedOrgType: OrganizationType | null;
  readonly storageLocationStatus: LocationOperationalStatus | null;
  readonly storageLocationAllowsDismantling: boolean | null;
  readonly fluidsDrainedAt: Date | null;
  readonly actualPurchasePriceCadMinor: number;
  readonly estimatedRepairCadMinor: number;
  readonly targetGrossRealizationMinor: number;
  readonly driveOnInitialFailAt: Date | null;
  readonly driveOnSscIssuedAt: Date | null;
  readonly driveOnSscExpiresAt: Date | null;
  readonly complianceWarnings: readonly string[];
  readonly hasActiveSale: boolean;
  readonly version: number;
}

export interface PersistedDomesticSaleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly receiptNumber: string;
  readonly marketNode: SaleMarketNode;
  readonly domesticChannel: DomesticSaleChannel | null;
  readonly exportChannel: string | null;
  readonly deliveryMethod: string;
  readonly destinationCountryCode: string;
  readonly destinationProvinceOrState: string | null;
  readonly exportProofStorageKey: string | null;
  readonly taxInvoiceNumber: string | null;
  readonly buyerName: string;
  readonly buyerPhoneE164: string | null;
  readonly soldByUserId: string;
  readonly verifiedByAdminId: string;
  readonly paymentCurrency: CurrencyCode;
  readonly floorPriceAtCheckoutMinor: number | null;
  readonly subtotalMinor: number;
  readonly discountAmountMinor: number;
  readonly discountReasonCode: string | null;
  readonly cfoOverrideApprovedById: string | null;
  readonly cfoOverrideReasonNote: string | null;
  readonly platformFeeMinor: number;
  readonly actualPlatformFeeMinor: number | null;
  readonly shippingCostMinor: number;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly appliedTaxJurisdiction: string;
  readonly appliedTaxRateBps: number;
  readonly taxOrVatMinor: number;
  readonly buyerTaxRemittedByPlatformMinor: number | null;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly feeTaxInvoiceStorageKey: string | null;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly paymentMethod: string;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly paymentConfirmedAt: Date | null;
  readonly bankSettledAt: Date | null;
  readonly bankDepositReference: string | null;
  readonly settlementProofStorageKey: string | null;
  readonly cashCustodyState: CashCustodyState;
  readonly ebayDelistAttestedAt: Date | null;
  readonly complianceWarnings: readonly string[];
  readonly paymentProofStorageKey: string;
  readonly billOfSaleStorageKey: string | null;
  readonly isPaymentVerified: boolean;
  readonly gateReleasedAt: Date | null;
  readonly isVoidedOrReversed: boolean;
  readonly reversesSaleTxId: string | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly partItems: ReadonlyArray<{
    readonly id: string;
    readonly partId: string;
    readonly soldPriceMinor: number;
    readonly isActiveSale: boolean;
  }>;
  readonly vehicleItems: ReadonlyArray<{
    readonly id: string;
    readonly vehicleId: string;
    readonly soldPriceMinor: number;
    readonly isActiveSale: boolean;
  }>;
}

export interface EligibleCashSweepTransferRow {
  readonly id: string;
  readonly organizationId: string;
  readonly transferCode: string;
  readonly marketNode: SaleMarketNode;
  readonly fromCustodyState: CashCustodyState;
  readonly toCustodyState: CashCustodyState;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor: number;
  readonly depositSlipStorageKey: string;
  readonly recordedByUserId: string;
  readonly custodyHolderUserId: string | null;
  readonly transferredAt: Date;
}

export interface StoredCheckoutReceipt {
  readonly auditId: string;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly result: unknown;
}

export interface DomesticCheckoutTx {
  acquireOrganizationLock(organizationId: string): Promise<void>;
  readOrganizationPolicyRecord(organizationId: string): Promise<{
    organizationId: string;
    policyConfigJson: unknown;
  } | null>;
  findCommandReceipt(
    organizationId: string,
    receiptAuditId: string,
  ): Promise<StoredCheckoutReceipt | null>;
  lockPartsByIds(
    organizationId: string,
    partIds: readonly string[],
  ): Promise<readonly CheckoutLockedPartRow[]>;
  lockVehiclesByIds(
    organizationId: string,
    vehicleIds: readonly string[],
  ): Promise<readonly CheckoutLockedVehicleRow[]>;
  lookupCheckoutItems(
    organizationId: string,
    query?: { readonly code?: string },
  ): Promise<{
    readonly parts: readonly CheckoutLockedPartRow[];
    readonly vehicles: readonly CheckoutLockedVehicleRow[];
  }>;
  findAndLockSaleTransaction(
    organizationId: string,
    saleId: string,
  ): Promise<PersistedDomesticSaleRecord | null>;
  findLinkedReversalSale(
    organizationId: string,
    originalSaleId: string,
  ): Promise<PersistedDomesticSaleRecord | null>;
  listDomesticSales(
    organizationId: string,
    limit?: number,
  ): Promise<readonly PersistedDomesticSaleRecord[]>;
  listEligibleFloatToBankTransfers(
    organizationId: string,
    sellerUserId: string,
    upTo: Date,
  ): Promise<readonly EligibleCashSweepTransferRow[]>;
  loadLedgerProjection(
    organizationId: string,
    policy: {
      readonly operationalGates: unknown;
      readonly compensationRules: unknown;
    },
  ): Promise<PersistedLedgerProjection>;
  insertSaleTransaction(
    record: Omit<PersistedDomesticSaleRecord, 'partItems' | 'vehicleItems'>,
  ): Promise<void>;
  insertSalePartItems(
    items: ReadonlyArray<{
      readonly id: string;
      readonly organizationId: string;
      readonly saleTransactionId: string;
      readonly partId: string;
      readonly soldPriceMinor: number;
      readonly isActiveSale: boolean;
    }>,
  ): Promise<void>;
  insertSaleVehicleItems(
    items: ReadonlyArray<{
      readonly id: string;
      readonly organizationId: string;
      readonly saleTransactionId: string;
      readonly vehicleId: string;
      readonly soldPriceMinor: number;
      readonly isActiveSale: boolean;
    }>,
  ): Promise<void>;
  updatePartAfterCheckoutOrReturn(input: {
    readonly organizationId: string;
    readonly partId: string;
    readonly expectedVersion: number;
    readonly nextVersion: number;
    readonly custodyState: PartCustodyState;
    readonly availabilityState: InventoryAvailabilityState;
    readonly ebaySyncState: EbaySyncState;
    readonly classifiedsSyncState: ClassifiedsSyncState;
    readonly complianceState: PartComplianceState;
    readonly updatedAt: Date;
  }): Promise<boolean>;
  updateVehicleAfterCheckout(input: {
    readonly organizationId: string;
    readonly vehicleId: string;
    readonly expectedVersion: number;
    readonly nextVersion: number;
    readonly lifecycleState: AssetLifecycleState;
    readonly availabilityState: InventoryAvailabilityState;
    readonly classifiedsSyncState: ClassifiedsSyncState;
    readonly complianceWarnings: readonly string[];
    readonly realizedRetailSaleCadMinor: number;
    readonly soldAt: Date;
    readonly updatedAt: Date;
  }): Promise<boolean>;
  updateSaleBankSettlement(input: {
    readonly organizationId: string;
    readonly saleId: string;
    readonly paymentSettlementState: PaymentSettlementState;
    readonly cashCustodyState: CashCustodyState;
    readonly paymentConfirmedAt: Date;
    readonly bankSettledAt: Date;
    readonly bankDepositReference: string;
    readonly settlementProofStorageKey: string;
    readonly actualPlatformFeeMinor: number | null;
    readonly isFeeTaxInvoiceVerified: boolean;
    readonly feeTaxInvoiceStorageKey: string | null;
    readonly itcReceivableCadMinor: number;
    readonly isPaymentVerified: boolean;
    readonly gateReleasedAt: Date;
  }): Promise<void>;
  markSaleRefundedOrChargedBack(input: {
    readonly organizationId: string;
    readonly saleId: string;
    readonly voidReason: string;
  }): Promise<void>;
  insertCustodyEvent(record: {
    readonly id: string;
    readonly organizationId: string;
    readonly partId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly fromLocationBarcode: string | null;
    readonly toLocationBarcode: string;
    readonly expectedVersion: number;
    readonly hasConflict: boolean;
    readonly complianceWarnings: readonly string[];
    readonly deviceTimestamp: Date;
    readonly serverReceivedAt: Date;
  }): Promise<void>;
  insertOutboxEvent(record: {
    readonly id: string;
    readonly organizationId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventType: string;
    readonly payloadJson: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly createdAt: Date;
  }): Promise<void>;
  insertAuditLog(record: {
    readonly id: string;
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly action: string;
    readonly previousState: Readonly<Record<string, unknown>> | null;
    readonly nextState: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }): Promise<void>;
}

export interface DomesticCheckoutRepository {
  withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: DomesticCheckoutTx) => Promise<T>,
  ): Promise<T>;
}

export interface ExecuteDomesticCheckoutUseCaseDeps {
  readonly repository: DomesticCheckoutRepository;
  readonly storage: IStoragePort;
  readonly clock?: CheckoutClock;
  readonly idGenerator?: () => string;
}

export interface ExecuteDomesticCheckoutResult {
  readonly saleId: string;
  readonly organizationId: string;
  readonly receiptNumber: string;
  readonly taxInvoiceNumber: string | null;
  readonly marketNode: SaleMarketNode;
  readonly domesticChannel: DomesticSaleChannel;
  readonly paymentCurrency: CurrencyCode;
  readonly deliveryMethod: string;
  readonly destinationCountryCode: string;
  readonly destinationProvinceOrState: string | null;
  readonly floorPriceAtCheckoutMinor: number;
  readonly subtotalMinor: number;
  readonly discountAmountMinor: number;
  readonly discountReasonCode: string | null;
  readonly cfoOverrideApplied: boolean;
  readonly taxCollectionMode: TaxCollectionMode;
  readonly appliedTaxJurisdiction: string;
  readonly appliedTaxRateBps: number;
  readonly taxOrVatMinor: number;
  readonly buyerTaxRemittedByPlatformMinor: number | null;
  readonly platformFeeMinor: number;
  readonly shippingCostMinor: number;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly paymentMethod: string;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
  readonly paymentConfirmedAt: string | null;
  readonly bankSettledAt: string | null;
  readonly complianceWarnings: readonly string[];
  readonly outboxEventIds: readonly string[];
  readonly resolvedLinePrices: ReadonlyArray<{
    readonly itemId: string;
    readonly itemType: 'PART' | 'VEHICLE';
    readonly code: string;
    readonly soldPriceMinor: number;
    readonly resolvedFloorPrice: ResolvedPrice;
  }>;
  readonly auditLogId: string;
  readonly createdAt: string;
}

export interface ConfirmBankSettlementResult {
  readonly saleId: string;
  readonly organizationId: string;
  readonly receiptNumber: string;
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
  readonly bankSettledAt: string;
  readonly bankDepositReference: string;
  readonly settlementProofStorageKey: string;
  readonly actualPlatformFeeMinor: number | null;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly feeTaxInvoiceStorageKey: string | null;
  readonly itcReceivableCadMinor: number;
  readonly auditLogId: string;
}

export interface RecordSaleRefundResult {
  readonly originalSaleId: string;
  readonly reversalSaleId: string;
  readonly organizationId: string;
  readonly creditNoteReference: string;
  readonly originalPaymentSettlementState: PaymentSettlementState;
  readonly reversalPaymentSettlementState: PaymentSettlementState;
  readonly reversalCashCustodyState: CashCustodyState;
  readonly chosenFundingSource:
    | 'CORP_BANK'
    | 'OPERATOR_FLOAT'
    | 'PENDING_EXTERNAL_RECEIVABLE';
  readonly proofOrigin:
    | 'EXPLICIT_REFUND_EVIDENCE'
    | 'INHERITED_SALE_EVIDENCE'
    | 'SWEPT_TRANSFER_DEPOSIT_SLIP';
  readonly referenceOrigin:
    | 'EXPLICIT_REFUND_REFERENCE'
    | 'INHERITED_SALE_REFERENCE'
    | 'SWEPT_TRANSFER_CODE'
    | 'GENERATED_CREDIT_NOTE_REFERENCE';
  readonly subtotalAdjustmentMinor: number;
  readonly taxOrVatAdjustmentMinor: number;
  readonly grossAdjustmentMinor: number;
  readonly netRealizedCadAdjustmentMinor: number;
  readonly bankCashAdjustmentCadMinor: number | null;
  readonly returnedPartIds: readonly string[];
  readonly auditLogId: string;
}

export interface CheckoutLookupItemSummary {
  readonly itemType: 'PART' | 'VEHICLE';
  readonly itemId: string;
  readonly code: string;
  readonly label: string;
  readonly availabilityState: InventoryAvailabilityState;
  readonly custodyOrLifecycleState: string;
  readonly ebaySyncState: EbaySyncState | null;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState | null;
  readonly tdgHazmatCode: string | null;
  readonly isEbayParcelEligible: boolean;
  readonly inReturnQcHold: boolean;
  readonly hasActiveSale: boolean;
  readonly resolvedPrice: ResolvedPrice | null;
  readonly priceError: string | null;
  readonly priceBasisHash: string | null;
  readonly warnings: readonly string[];
  readonly version: number;
}

export const ExecuteDomesticCheckoutSchema = z
  .object({
    action: z.literal('execute-checkout').optional(),
    marketNode: z.literal('DOMESTIC_ORIGIN').optional(),
    paymentCurrency: z.literal('CAD').optional(),
    domesticChannel: z.enum([
      'LOCAL_WALK_IN_CASH',
      'FB_MARKETPLACE_LOCAL',
      'KIJIJI_LOCAL',
      'RETAIL_LOT_VEHICLE_SALE',
      'WHOLESALE_MECHANIC_NETWORK',
      'EBAY_MOTORS_SHIPPED',
      'CAR_PART_WHOLESALE',
    ]),
    deliveryMethod: z.enum([
      'PICKUP_AT_ORIGIN',
      'LOCAL_DELIVERY_ONTARIO',
      'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
    ]),
    destinationCountryCode: z.string().trim().min(2).max(2),
    destinationProvinceOrState: z.string().trim().max(32).nullable().optional(),
    paymentMethod: z.enum([
      'CASH',
      'INTERAC_ETRANSFER',
      'VERIFIED_BANK_WIRE',
      'EBAY_MANAGED_PAYOUT',
    ]),
    isCashCountedInPerson: z.boolean().optional(),
    buyerName: z.string().trim().min(1).max(200),
    buyerPhoneE164: z.string().trim().max(32).nullable().optional(),
    partLines: z
      .array(
        z
          .object({
            partId: z.string().uuid(),
            proposedPriceCadMinor: z
              .number()
              .int()
              .min(0)
              .max(PRISMA_INT32_MAX),
            expectedVersion: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    vehicleLines: z
      .array(
        z
          .object({
            vehicleId: z.string().uuid(),
            proposedPriceCadMinor: z
              .number()
              .int()
              .min(0)
              .max(PRISMA_INT32_MAX),
            expectedVersion: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    discountReasonCode: z.string().trim().max(64).nullable().optional(),
    cfoOverrideRequested: z.boolean().optional(),
    cfoOverrideReasonNote: z.string().trim().max(500).nullable().optional(),
    paymentProofStorageKey: z.string().trim().min(1).max(255),
    billOfSaleStorageKey: z.string().trim().max(255).nullable().optional(),
    exportProofStorageKey: z.string().trim().max(255).nullable().optional(),
    buyerTaxRemittedByPlatformMinor: z
      .number()
      .int()
      .min(0)
      .max(PRISMA_INT32_MAX)
      .nullable()
      .optional(),
    platformFeeMinor: z.number().int().min(0).max(PRISMA_INT32_MAX).optional(),
    shippingCostMinor: z.number().int().min(0).max(PRISMA_INT32_MAX).optional(),
    estimatedPlatformFeeTaxCadMinor: z
      .number()
      .int()
      .min(0)
      .max(PRISMA_INT32_MAX)
      .optional(),
    ebayDelistAttestedAt: z
      .union([z.date(), z.string().min(1)])
      .nullable()
      .optional(),
    acknowledgedPriceBasisHash: z.string().trim().max(4096).nullable().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const ConfirmBankSettlementSchema = z
  .object({
    action: z.literal('confirm-bank-settlement').optional(),
    saleId: z.string().uuid(),
    bankDepositReference: z.string().trim().min(1).max(160),
    settlementProofStorageKey: z.string().trim().min(1).max(255),
    actualPlatformFeeMinor: z
      .number()
      .int()
      .min(0)
      .max(PRISMA_INT32_MAX)
      .optional(),
    feeTaxInvoiceStorageKey: z.string().trim().max(255).nullable().optional(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export const RecordSaleRefundSchema = z
  .object({
    action: z.literal('record-refund-or-chargeback').optional(),
    saleId: z.string().uuid(),
    reasonNote: z.string().trim().min(1).max(500),
    returnPartsToQcHold: z.boolean(),
    refundBankReference: z.string().trim().max(160).nullable().optional(),
    refundProofStorageKey: z.string().trim().max(255).nullable().optional(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export function deriveCheckoutReceiptId(
  organizationId: string,
  idempotencyKey: string,
): string {
  if (!isValidUuid(organizationId) || !isValidUuid(idempotencyKey)) {
    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      'organizationId and idempotencyKey must be valid UUIDs.',
    );
  }
  const digest = createHash('sha256')
    .update(
      `${ISSUE10_CHECKOUT_RECEIPT_NAMESPACE}:${organizationId.toLowerCase()}:${idempotencyKey.toLowerCase()}`,
    )
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export function computeCheckoutCommandFingerprint(params: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly payload: unknown;
}): string {
  const canonical = JSON.stringify({
    organizationId: params.organizationId.toLowerCase(),
    actorUserId: params.actorUserId.toLowerCase(),
    action: params.action,
    payload: params.payload,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
