import { createHash } from 'node:crypto';
import type {
  CashCustodyState,
  CurrencyCode,
  ExpenseCategory,
  OrganizationType,
  ReceiptVerificationState,
  SaleMarketNode,
  UserRole,
} from '@prisma/client';
import { z } from 'zod';
import type { TrancheEligibilityResult } from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import type { IStoragePort } from '@/core/ports/storage.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import type { PersistedLedgerProjection } from '@/modules/cfo-subledger/financial-snapshot.query';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import type {
  LockedDonorPartRow,
  LockedDonorVehicleRow,
} from '@/modules/dismantling/part-strip/part-strip.contracts';

export const PRISMA_INT32_MAX = 2_147_483_647 as const;
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_MULTIPART_METADATA_BYTES = 64 * 1024; // 64 KiB
export const MAX_MULTIPART_REQUEST_BYTES = 12 * 1024 * 1024; // 12 MiB
export const EXPENSES_RECEIPT_SCHEMA_VERSION = 1 as const;

export const ALLOWED_EVIDENCE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

/**
 * Fixed RFC-4122 namespace UUID exclusively for Issue #9 command receipts stored in `shared.AuditLog.id`.
 * Actor and action are intentionally excluded from receipt ID derivation so reusing an idempotency key
 * across different actions or actors within the same organization triggers a deterministic 409 conflict.
 */
export const ISSUE9_COMMAND_RECEIPT_NAMESPACE =
  '9e4c7b20-1d3a-4f8b-8a6c-5e2d1f9b0a4c' as const;

export const EXPENSE_AUDIT_ACTIONS = {
  LOG_EXPENSE: 'EXPENSE_LOGGED',
  ATTACH_RECEIPT: 'EXPENSE_RECEIPT_ATTACHED',
  SETTLE_ACCRUAL: 'DEFERRED_ACCRUAL_SETTLED',
  RECORD_TRANSFER: 'CASH_CUSTODY_TRANSFER_RECORDED',
} as const;

export const PORT_FEE_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
  new Set<ExpenseCategory>([
    'OCEAN_FREIGHT_LCL_FCL',
    'CUSTOMS_BROKERAGE_FEE',
    'DESTINATION_DUTY_AND_VAT',
    'PORT_DRAYAGE',
  ]);

export const NURSERY_SUPPLY_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
  new Set<ExpenseCategory>([
    'PACKAGING_AND_LABELS',
    'NUTRIENTS_AND_GROW_MEDIA',
    'LAB_COA_TESTING_FEE',
    'PROCESSING_SOLVENTS_AND_CONSUMABLES',
  ]);

export const COMPENSATION_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
  new Set<ExpenseCategory>([
    'YARD_STRIPPER_PIECE_RATE',
    'PARTNER_PROFIT_DRAW',
    'PARTNER_TIME_LOG_MEMO',
  ]);

export type ExpenseCommandAction =
  | 'log-expense'
  | 'attach-receipt'
  | 'settle-accrual'
  | 'record-transfer';

export type ExpenseErrorCode =
  | 'INVALID_EXPENSE_INPUT'
  | 'EXPENSE_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'SHIPMENT_NOT_FOUND'
  | 'RECIPIENT_NOT_FOUND'
  | 'EXPENSE_RECEIPT_ALREADY_ATTACHED'
  | 'ACCRUAL_ALREADY_SETTLED'
  | 'DUPLICATE_PIECE_RATE_PAYOUT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PAYLOAD_TOO_LARGE'
  | 'RECEIPT_REQUIRED'
  | 'VOUCHER_REASON_REQUIRED'
  | 'VOUCHER_AMOUNT_EXCEEDS_MAX'
  | 'MONTHLY_VOUCHER_CAP_EXCEEDED'
  | 'INVALID_EVIDENCE_KEY'
  | 'EXPENSE_NOT_DEFERRED_ACCRUAL'
  | 'DEPOSIT_SLIP_REQUIRED'
  | 'INVALID_TRANSFER_PAIR'
  | 'INSUFFICIENT_OPERATOR_FLOAT'
  | 'INSUFFICIENT_VAULT_CASH'
  | 'EXPENSE_INTEGRITY_ERROR';

export type ExpenseErrorStatus = 400 | 404 | 409 | 413 | 422 | 500;

const ERROR_STATUS_BY_CODE: Readonly<
  Record<ExpenseErrorCode, ExpenseErrorStatus>
> = {
  INVALID_EXPENSE_INPUT: 400,
  EXPENSE_NOT_FOUND: 404,
  VEHICLE_NOT_FOUND: 404,
  SHIPMENT_NOT_FOUND: 404,
  RECIPIENT_NOT_FOUND: 404,
  EXPENSE_RECEIPT_ALREADY_ATTACHED: 409,
  ACCRUAL_ALREADY_SETTLED: 409,
  DUPLICATE_PIECE_RATE_PAYOUT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RECEIPT_REQUIRED: 422,
  VOUCHER_REASON_REQUIRED: 422,
  VOUCHER_AMOUNT_EXCEEDS_MAX: 422,
  MONTHLY_VOUCHER_CAP_EXCEEDED: 422,
  INVALID_EVIDENCE_KEY: 422,
  EXPENSE_NOT_DEFERRED_ACCRUAL: 422,
  DEPOSIT_SLIP_REQUIRED: 422,
  INVALID_TRANSFER_PAIR: 422,
  INSUFFICIENT_OPERATOR_FLOAT: 422,
  INSUFFICIENT_VAULT_CASH: 422,
  EXPENSE_INTEGRITY_ERROR: 500,
};

export class ExpenseError extends Error {
  public readonly code: ExpenseErrorCode;
  public readonly status: ExpenseErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: ExpenseErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ExpenseError';
    this.code = code;
    this.status = ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export const BoundedNonEmptyString = (maxLen: number, fieldName: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length > 0 && v.length <= maxLen, {
      message: `${fieldName} must be 1..${maxLen} characters.`,
    })
    .refine((v) => !CONTROL_CHARS_REGEX.test(v), {
      message: `${fieldName} must not contain control characters.`,
    });

export const BoundedOptionalString = (maxLen: number, fieldName: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length <= maxLen && !CONTROL_CHARS_REGEX.test(v), {
      message: `${fieldName} exceeds ${maxLen} chars or contains control characters.`,
    })
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

export const PositivePrismaInt = z
  .number()
  .int()
  .min(1)
  .max(PRISMA_INT32_MAX);

export const NonNegativePrismaInt = z
  .number()
  .int()
  .min(0)
  .max(PRISMA_INT32_MAX);

export const DateOrIsoSchema = z.union([z.date(), z.string().min(1)]);

export const ExpenseCategorySchema = z.enum([
  'AUCTION_PURCHASE_PRICE',
  'AUCTION_BUYER_FEE',
  'TOWING_AND_RECOVERY',
  'YARD_STRIPPER_PIECE_RATE',
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
  'NUTRIENTS_AND_GROW_MEDIA',
  'LAB_COA_TESTING_FEE',
  'PROCESSING_SOLVENTS_AND_CONSUMABLES',
  'EXCISE_STAMP_AND_DUTY',
  'PARTNER_PROFIT_DRAW',
  'PARTNER_TIME_LOG_MEMO',
]);

export const CurrencyCodeSchema = z.enum(['CAD', 'USD', 'TTD']);

export const ReceiptVerificationStateSchema = z.enum([
  'VERIFIED_RECEIPT',
  'PETTY_CASH_VOUCHER',
  'PENDING_RECEIPT_UPLOAD',
]);

export const PaidFromCashCustodySchema = z.enum([
  'SETTLED_ORIGIN_CORP_BANK',
  'HELD_IN_OPERATOR_FLOAT',
]);

export const CfoOverrideIntentSchema = z
  .object({
    approved: z.boolean(),
    reasonNote: z.string().max(500).optional().default(''),
    approvedById: z.string().optional(),
    approverRole: z.string().optional(),
  })
  .strict();

export const LogExpenseMetadataSchema = z
  .object({
    action: z.literal('log-expense').optional(),
    category: ExpenseCategorySchema,
    vendorName: BoundedNonEmptyString(140, 'vendorName'),
    description: BoundedNonEmptyString(500, 'description'),
    amountOriginalMinor: NonNegativePrismaInt,
    currencyOriginal: CurrencyCodeSchema.optional(),
    amountCadMinor: NonNegativePrismaInt.optional(),
    itcReceivableCadMinor: NonNegativePrismaInt.optional(),
    receiptVerificationState: ReceiptVerificationStateSchema.optional(),
    receiptStorageKey: BoundedOptionalString(200, 'receiptStorageKey'),
    voucherReason: BoundedOptionalString(500, 'voucherReason'),
    paidFromCashCustody: PaidFromCashCustodySchema.nullable().optional(),
    custodyHolderUserId: z.string().min(1).nullable().optional(),
    recipientUserId: z.string().min(1).nullable().optional(),
    vehicleId: z.string().min(1).nullable().optional(),
    shipmentId: z.string().min(1).nullable().optional(),
    isDeferredIntercompanyAccrual: z.boolean().optional(),
    incurredAt: DateOrIsoSchema.optional(),
    cfoOverride: CfoOverrideIntentSchema.nullable().optional(),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema.optional(),
  })
  .strict();

export const AttachReceiptMetadataSchema = z
  .object({
    action: z.literal('attach-receipt').optional(),
    expenseId: z.string().min(1),
    receiptStorageKey: BoundedOptionalString(200, 'receiptStorageKey'),
    itcReceivableCadMinor: NonNegativePrismaInt.optional(),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema.optional(),
  })
  .strict();

export const SettleAccrualCommandSchema = z
  .object({
    action: z.literal('settle-accrual').optional(),
    expenseId: z.string().min(1),
    paidFromCashCustody: PaidFromCashCustodySchema.optional(),
    custodyHolderUserId: z.string().min(1).nullable().optional(),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema.optional(),
  })
  .strict();

export const RecordTransferMetadataSchema = z
  .object({
    action: z.literal('record-transfer').optional(),
    marketNode: z
      .enum(['DOMESTIC_ORIGIN', 'DESTINATION_EXPORT_VAULT'])
      .optional(),
    fromCustodyState: z.enum([
      'HELD_IN_OPERATOR_FLOAT',
      'HELD_IN_DESTINATION_VAULT',
    ]),
    toCustodyState: z.enum([
      'SETTLED_ORIGIN_CORP_BANK',
      'DEPOSITED_DESTINATION_BANK',
    ]),
    currency: CurrencyCodeSchema.optional(),
    amountMinor: PositivePrismaInt,
    equivalentCadMinor: PositivePrismaInt.optional(),
    custodyHolderUserId: z.string().min(1).nullable().optional(),
    commercialBankName: BoundedOptionalString(140, 'commercialBankName'),
    transferCode: BoundedOptionalString(64, 'transferCode'),
    depositSlipStorageKey: BoundedOptionalString(200, 'depositSlipStorageKey'),
    transferredAt: DateOrIsoSchema.optional(),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema.optional(),
  })
  .strict();

export interface ExpenseCfoOverrideInput {
  readonly approved: boolean;
  readonly reasonNote: string;
  readonly approvedById?: string;
  readonly approverRole?: string;
}

export interface LogExpenseCommand {
  readonly category: ExpenseCategory;
  readonly vendorName: string;
  readonly description: string;
  readonly amountOriginalMinor: number;
  readonly currencyOriginal?: CurrencyCode;
  readonly amountCadMinor?: number;
  readonly itcReceivableCadMinor?: number;
  readonly receiptVerificationState?: ReceiptVerificationState;
  readonly receiptStorageKey?: string | null;
  readonly receiptBytes?: Uint8Array;
  readonly receiptContentType?: string;
  readonly voucherReason?: string | null;
  readonly paidFromCashCustody?:
    | 'SETTLED_ORIGIN_CORP_BANK'
    | 'HELD_IN_OPERATOR_FLOAT'
    | null;
  readonly custodyHolderUserId?: string | null;
  readonly recipientUserId?: string | null;
  readonly vehicleId?: string | null;
  readonly shipmentId?: string | null;
  readonly isDeferredIntercompanyAccrual?: boolean;
  readonly incurredAt?: string | Date;
  readonly cfoOverride?: ExpenseCfoOverrideInput | null;
  readonly idempotencyKey: string;
  readonly deviceTimestamp?: string | Date;
}

export interface AttachExpenseReceiptCommand {
  readonly expenseId: string;
  readonly receiptStorageKey?: string | null;
  readonly receiptBytes?: Uint8Array;
  readonly receiptContentType?: string;
  readonly itcReceivableCadMinor?: number;
  readonly idempotencyKey: string;
  readonly deviceTimestamp?: string | Date;
}

export interface SettleDeferredAccrualCommand {
  readonly expenseId: string;
  readonly paidFromCashCustody?:
    | 'SETTLED_ORIGIN_CORP_BANK'
    | 'HELD_IN_OPERATOR_FLOAT';
  readonly custodyHolderUserId?: string | null;
  readonly idempotencyKey: string;
  readonly deviceTimestamp?: string | Date;
}

export interface RecordCashCustodyTransferCommand {
  readonly marketNode?: SaleMarketNode;
  readonly fromCustodyState:
    | 'HELD_IN_OPERATOR_FLOAT'
    | 'HELD_IN_DESTINATION_VAULT';
  readonly toCustodyState:
    | 'SETTLED_ORIGIN_CORP_BANK'
    | 'DEPOSITED_DESTINATION_BANK';
  readonly currency?: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor?: number;
  readonly custodyHolderUserId?: string | null;
  readonly commercialBankName?: string | null;
  readonly transferCode?: string | null;
  readonly depositSlipStorageKey?: string | null;
  readonly depositSlipBytes?: Uint8Array;
  readonly depositSlipContentType?: string;
  readonly transferredAt?: string | Date;
  readonly idempotencyKey: string;
  readonly deviceTimestamp?: string | Date;
}

export interface SafeExpenseRow {
  readonly id: string;
  readonly organizationId: string;
  readonly loggedByUserId: string;
  readonly recipientUserId: string | null;
  readonly custodyHolderUserId: string | null;
  readonly vehicleId: string | null;
  readonly shipmentId: string | null;
  readonly category: ExpenseCategory;
  readonly vendorName: string;
  readonly description: string;
  readonly amountOriginalMinor: number;
  readonly currencyOriginal: CurrencyCode;
  readonly amountCadMinor: number;
  readonly floatOffsetAppliedCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody: CashCustodyState | null;
  readonly isDeferredIntercompanyAccrual: boolean;
  readonly accrualSettledAt: string | null;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly hasReceiptEvidence: boolean;
  readonly receiptSha256Hash: string | null;
  readonly voucherReason: string | null;
  readonly isMemoOnly: boolean;
  readonly isReversalEntry: boolean;
  readonly reversesExpenseId: string | null;
  readonly incurredAt: string;
  readonly createdAt: string;
}

export interface LogExpenseResult {
  readonly replayed: boolean;
  readonly expense: SafeExpenseRow;
  readonly rolling30DayVoucherUsedCadMinor: number;
  readonly monthlyVoucherCapCadMinor: number;
  readonly cfoOverrideApplied: boolean;
  readonly auditLogId: string;
  readonly outboxEventId: string;
  readonly warnings: readonly string[];
}

export interface AttachExpenseReceiptResult {
  readonly replayed: boolean;
  readonly expense: SafeExpenseRow;
  readonly auditLogId: string;
  readonly outboxEventId: string;
  readonly warnings: readonly string[];
}

export interface SettleDeferredAccrualResult {
  readonly replayed: boolean;
  readonly expense: SafeExpenseRow;
  readonly auditLogId: string;
  readonly outboxEventId: string;
}

export interface SafeCashCustodyTransferRow {
  readonly id: string;
  readonly organizationId: string;
  readonly transferCode: string;
  readonly marketNode: SaleMarketNode;
  readonly fromCustodyState: CashCustodyState;
  readonly toCustodyState: CashCustodyState;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor: number;
  readonly commercialBankName: string | null;
  readonly recordedByUserId: string;
  readonly custodyHolderUserId: string | null;
  readonly hasDepositSlipEvidence: boolean;
  readonly transferredAt: string;
  readonly createdAt: string;
}

export interface RecordCashCustodyTransferResult {
  readonly replayed: boolean;
  readonly transfer: SafeCashCustodyTransferRow;
  readonly auditLogId: string;
  readonly outboxEventId: string;
}

export interface DeferredAccrualSummaryRow {
  readonly id: string;
  readonly vendorName: string;
  readonly description: string;
  readonly category: ExpenseCategory;
  readonly amountCadMinor: number;
  readonly incurredAt: string;
  readonly createdAt: string;
  readonly ageDays: number;
  readonly settled: boolean;
  readonly accrualSettledAt: string | null;
}

export interface OperatorFloatMemberBalance {
  readonly userId: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly floatCadMinor: number;
}

export interface CfoSubledgerProjection {
  readonly scope: 'FULL_ORGANIZATION';
  readonly organizationId: string;
  readonly organizationType: OrganizationType;
  readonly activeReleasedTrancheCapitalCadMinor: number;
  readonly accountingRevenueCadMinor: number;
  readonly grossSaleValueCadMinor: number;
  readonly pendingExternalReceivablesCadMinor: number;
  readonly runningOperatorFloatCadMinor: number;
  readonly operatorFloatByUserId: Readonly<Record<string, number>>;
  readonly operatorBalances: readonly OperatorFloatMemberBalance[];
  readonly confirmedCorpBankCashCadMinor: number;
  readonly estimatedDonorProfitCadMinor: number;
  readonly availableWorkingCapitalCadMinor: number;
  readonly distributableRealizedProfitPoolCadMinor: number;
  readonly deferredIntercompanyAccrualCadMinor: number;
  readonly directTaxCollectedNetOfRefundsCadMinor: number;
  readonly buyerTaxRemittedByPlatformCadMinor: number | null;
  readonly hasUnknownMarketplaceBuyerTax: boolean;
  readonly unverifiedPlatformFeeTaxAccruedCadMinor: number;
  readonly verifiedItcReceivableCadMinor: number;
  readonly netHstTrustLiabilityCadMinor: number;
  readonly isGstHstRegistered: boolean;
  readonly minCashReserveFloorCadMinor: number;
  readonly pettyCashVoucherMaxCadMinor: number;
  readonly monthlyUnreceiptedVoucherCapCadMinor: number;
  readonly tranches: TrancheEligibilityResult;
  readonly pendingReceiptExpenses: readonly SafeExpenseRow[];
  readonly deferredAccruals: readonly DeferredAccrualSummaryRow[];
  readonly recentExpenses: readonly SafeExpenseRow[];
  readonly recentTransfers: readonly SafeCashCustodyTransferRow[];
  readonly warnings: readonly string[];
}

export interface OperatorOwnFloatProjection {
  readonly scope: 'OWN_FLOAT_ONLY';
  readonly organizationId: string;
  readonly organizationType: OrganizationType;
  readonly userId: string;
  readonly ownOperatorFloatCadMinor: number;
  readonly ownRolling30DayVoucherUsedCadMinor: number;
  readonly pettyCashVoucherMaxCadMinor: number;
  readonly monthlyUnreceiptedVoucherCapCadMinor: number;
  readonly isGstHstRegistered: boolean;
  readonly pendingReceiptExpenses: readonly SafeExpenseRow[];
  readonly recentExpenses: readonly SafeExpenseRow[];
}

export interface StripperOwnPieceRateProjection {
  readonly scope: 'OWN_PIECE_RATE_ONLY';
  readonly organizationId: string;
  readonly organizationType: OrganizationType;
  readonly userId: string;
  readonly pieceRateExpenses: readonly SafeExpenseRow[];
}

export type ExpenseSubledgerQueryResult =
  | CfoSubledgerProjection
  | OperatorOwnFloatProjection
  | StripperOwnPieceRateProjection;

export interface PrivateEvidencePresignedUrlResult {
  readonly targetType: 'expense' | 'transfer';
  readonly targetId: string;
  readonly url: string;
  readonly ttlSeconds: number;
}

export interface StoredExpenseRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string | null;
  readonly shipmentId: string | null;
  readonly cannabisLotId: string | null;
  readonly loggedByUserId: string;
  readonly recipientUserId: string | null;
  readonly floatOffsetAppliedCadMinor: number;
  readonly custodyHolderUserId: string | null;
  readonly idempotencyKey: string | null;
  readonly category: ExpenseCategory;
  readonly vendorName: string;
  readonly description: string;
  readonly amountOriginalMinor: number;
  readonly currencyOriginal: CurrencyCode;
  readonly amountCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody: CashCustodyState | null;
  readonly isDeferredIntercompanyAccrual: boolean;
  readonly accrualSettledAt: Date | null;
  readonly isReversalEntry: boolean;
  readonly reversesExpenseId: string | null;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey: string | null;
  readonly receiptSha256Hash: string | null;
  readonly voucherReason: string | null;
  readonly incurredAt: Date;
  readonly createdAt: Date;
}

export interface StoredCashCustodyTransferRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly transferCode: string;
  readonly marketNode: SaleMarketNode;
  readonly fromCustodyState: CashCustodyState;
  readonly toCustodyState: CashCustodyState;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor: number;
  readonly commercialBankName: string | null;
  readonly depositSlipStorageKey: string;
  readonly recordedByUserId: string;
  readonly custodyHolderUserId: string | null;
  readonly idempotencyKey: string | null;
  readonly transferredAt: Date;
  readonly createdAt: Date;
}

export interface ActiveOrgMemberRecord {
  readonly userId: string;
  readonly organizationId: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly isActive: boolean;
}

export interface TrustedEvidenceMetadata {
  readonly storageKey: string;
  readonly sha256Hash: string;
}

export interface PersistExpenseRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string | null;
  readonly shipmentId: string | null;
  readonly loggedByUserId: string;
  readonly recipientUserId: string | null;
  readonly floatOffsetAppliedCadMinor: number;
  readonly custodyHolderUserId: string | null;
  readonly idempotencyKey: string;
  readonly category: ExpenseCategory;
  readonly vendorName: string;
  readonly description: string;
  readonly amountOriginalMinor: number;
  readonly currencyOriginal: CurrencyCode;
  readonly amountCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody: CashCustodyState | null;
  readonly isDeferredIntercompanyAccrual: boolean;
  readonly accrualSettledAt: Date | null;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey: string | null;
  readonly receiptSha256Hash: string | null;
  readonly voucherReason: string | null;
  readonly incurredAt: Date;
  readonly createdAt: Date;
}

export interface PersistExpenseReceiptUpdate {
  readonly organizationId: string;
  readonly expenseId: string;
  readonly receiptStorageKey: string;
  readonly receiptSha256Hash: string;
  readonly itcReceivableCadMinor: number;
}

export interface PersistDeferredAccrualSettlementUpdate {
  readonly organizationId: string;
  readonly expenseId: string;
  readonly accrualSettledAt: Date;
  readonly paidFromCashCustody: CashCustodyState;
  readonly custodyHolderUserId: string | null;
}

export interface PersistCashCustodyTransferRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly transferCode: string;
  readonly marketNode: SaleMarketNode;
  readonly fromCustodyState: CashCustodyState;
  readonly toCustodyState: CashCustodyState;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly equivalentCadMinor: number;
  readonly commercialBankName: string | null;
  readonly depositSlipStorageKey: string;
  readonly recordedByUserId: string;
  readonly custodyHolderUserId: string | null;
  readonly idempotencyKey: string;
  readonly transferredAt: Date;
  readonly createdAt: Date;
}

export interface PersistAuditLogRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly previousState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface PersistOutboxEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payloadJson: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

export interface StoredCommandReceipt<TResult = unknown> {
  readonly auditLogId: string;
  readonly schemaVersion: number;
  readonly idempotencyKey: string;
  readonly action: ExpenseCommandAction;
  readonly commandFingerprint: string;
  readonly result: TResult;
}

export interface TrancheLiveCounts {
  readonly shelvedSkusCount: number;
  readonly scrappedDonorsCount: number;
  readonly overdueFloatReceiptsCount: number;
}

export interface ExpenseTx {
  acquireOrganizationLock(organizationId: string): Promise<void>;
  readOrganizationPolicyRecord(
    organizationId: string,
  ): Promise<{ organizationId: string; policyConfigJson: unknown } | null>;
  findCommandReceipt(
    organizationId: string,
    receiptAuditId: string,
  ): Promise<StoredCommandReceipt | null>;
  findExpenseByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<StoredExpenseRecord | null>;
  findTransferByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<StoredCashCustodyTransferRecord | null>;
  findVerifiedEvidenceMetadata(
    organizationId: string,
    storageKey: string,
  ): Promise<TrustedEvidenceMetadata | null>;
  findActiveOrgMember(
    organizationId: string,
    userId: string,
  ): Promise<ActiveOrgMemberRecord | null>;
  listActiveOrgMembers(
    organizationId: string,
  ): Promise<readonly ActiveOrgMemberRecord[]>;
  findAndLockVehicle(
    organizationId: string,
    vehicleId: string,
  ): Promise<LockedDonorVehicleRow | null>;
  findAndLockDonorParts(
    organizationId: string,
    donorVehicleId: string,
  ): Promise<readonly LockedDonorPartRow[]>;
  shipmentExists(organizationId: string, shipmentId: string): Promise<boolean>;
  findAndLockExpense(
    organizationId: string,
    expenseId: string,
  ): Promise<StoredExpenseRecord | null>;
  findTransferById(
    organizationId: string,
    transferId: string,
  ): Promise<StoredCashCustodyTransferRecord | null>;
  sumRollingOperatorVouchersCadMinor(
    organizationId: string,
    loggedByUserId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<number>;
  hasUnreversedPieceRatePayoutForVehicle(
    organizationId: string,
    vehicleId: string,
  ): Promise<boolean>;
  hasReversalForExpense(
    organizationId: string,
    expenseId: string,
  ): Promise<boolean>;
  loadPersistedSnapshot(
    organizationId: string,
    policy: PricingAndCompliancePolicy,
  ): Promise<PersistedLedgerProjection>;
  loadTrancheLiveCounts(
    organizationId: string,
    overdueCutoff: Date,
  ): Promise<TrancheLiveCounts>;
  listExpenses(
    organizationId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly StoredExpenseRecord[]>;
  listCashCustodyTransfers(
    organizationId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly StoredCashCustodyTransferRecord[]>;
  insertExpense(record: PersistExpenseRecord): Promise<void>;
  updateExpenseReceipt(update: PersistExpenseReceiptUpdate): Promise<void>;
  settleExpenseDeferredAccrual(
    update: PersistDeferredAccrualSettlementUpdate,
  ): Promise<void>;
  insertCashCustodyTransfer(
    record: PersistCashCustodyTransferRecord,
  ): Promise<void>;
  insertAuditLog(record: PersistAuditLogRecord): Promise<void>;
  insertOutboxEvent(record: PersistOutboxEventRecord): Promise<void>;
}

export interface ExpenseRepository {
  withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: ExpenseTx) => Promise<T>,
  ): Promise<T>;
}

export interface ExpenseClock {
  now(): Date;
}

export interface ExpenseUseCaseDeps {
  readonly repository?: ExpenseRepository;
  readonly storage?: IStoragePort;
  readonly clock?: ExpenseClock;
  readonly idGenerator?: () => string;
}

/**
 * Shared PostgreSQL transaction-scoped advisory lock key derivation.
 * Matches Issue #7 (`intake-vehicle.repository.ts`) and Issue #8 (`part-strip.repository.ts`)
 * so all financial, intake, dismantling, and future checkout writers serialize on the same lock.
 */
export function organizationAdvisoryLockKeys(
  organizationId: string,
): [number, number] {
  const hex = organizationId.replace(/-/g, '').toLowerCase();
  const key1 = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const key2 = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [key1, key2];
}

export function assertValidUuidParam(value: unknown, fieldName: string): string {
  if (!isValidUuid(value)) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `${fieldName} must be a valid UUID string.`,
    );
  }
  return value.toLowerCase();
}

export function parseStrictTimestamp(
  value: Date | string,
  fieldName: string,
): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `${fieldName} must be a valid ISO timestamp or Date.`,
    );
  }
  return date;
}

export function normalizeAndValidateEvidenceMime(rawType: string): string {
  const mime = rawType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_EVIDENCE_MIME_TYPES.has(mime)) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `Evidence contentType "${rawType}" must be image/jpeg, image/png, image/webp, or application/pdf.`,
    );
  }
  return mime;
}

export function isValidSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_REGEX.test(value);
}

export function deriveIssue9CommandReceiptId(
  organizationId: string,
  idempotencyKey: string,
): string {
  const normalizedOrg = assertValidUuidParam(organizationId, 'organizationId');
  const normalizedKey = assertValidUuidParam(idempotencyKey, 'idempotencyKey');
  const digest = createHash('sha256')
    .update(
      `${ISSUE9_COMMAND_RECEIPT_NAMESPACE}:${normalizedOrg}:${normalizedKey}`,
    )
    .digest();

  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const val = (value as Record<string, unknown>)[key];
      if (val !== undefined) {
        out[key] = canonicalizeJsonValue(val);
      }
    }
    return out;
  }
  return value;
}

export function computeExpenseCommandFingerprint(params: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: ExpenseCommandAction;
  readonly payload: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(
    canonicalizeJsonValue({
      schemaVersion: EXPENSES_RECEIPT_SCHEMA_VERSION,
      organizationId: params.organizationId.toLowerCase(),
      actorUserId: params.actorUserId.toLowerCase(),
      action: params.action,
      payload: params.payload,
    }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function parseExpenseCommandReceiptNextState(
  auditLogId: string,
  nextState: unknown,
): StoredCommandReceipt | null {
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    return null;
  }
  const receipt = (nextState as Record<string, unknown>).commandReceipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return null;
  }
  const r = receipt as Record<string, unknown>;
  if (
    r.schemaVersion !== EXPENSES_RECEIPT_SCHEMA_VERSION ||
    typeof r.idempotencyKey !== 'string' ||
    typeof r.action !== 'string' ||
    typeof r.commandFingerprint !== 'string' ||
    r.commandFingerprint.length === 0 ||
    !r.result ||
    typeof r.result !== 'object' ||
    Array.isArray(r.result)
  ) {
    return null;
  }
  return {
    auditLogId: auditLogId.toLowerCase(),
    schemaVersion: r.schemaVersion,
    idempotencyKey: r.idempotencyKey.toLowerCase(),
    action: r.action as ExpenseCommandAction,
    commandFingerprint: r.commandFingerprint,
    result: r.result,
  };
}

export function resolveIdempotentExpenseReplay<
  TResult extends { readonly replayed: boolean },
>(params: {
  readonly existingReceipt: StoredCommandReceipt | null;
  readonly expectedAction: ExpenseCommandAction;
  readonly expectedIdempotencyKey: string;
  readonly expectedFingerprint: string;
  readonly hasConflictingRow: boolean;
  readonly validateResult: (raw: unknown) => raw is TResult;
}): TResult | null {
  const { existingReceipt } = params;
  if (!existingReceipt) {
    if (params.hasConflictingRow) {
      throw new ExpenseError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already consumed by another expense or transfer operation.',
      );
    }
    return null;
  }

  if (
    existingReceipt.schemaVersion !== EXPENSES_RECEIPT_SCHEMA_VERSION ||
    existingReceipt.idempotencyKey !== params.expectedIdempotencyKey.toLowerCase()
  ) {
    throw new ExpenseError(
      'EXPENSE_INTEGRITY_ERROR',
      'Stored expense command receipt failed integrity validation.',
    );
  }

  if (
    existingReceipt.action !== params.expectedAction ||
    existingReceipt.commandFingerprint !== params.expectedFingerprint
  ) {
    throw new ExpenseError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key was already used with a different command, actor, or payload.',
    );
  }

  if (!params.validateResult(existingReceipt.result)) {
    throw new ExpenseError(
      'EXPENSE_INTEGRITY_ERROR',
      'Stored expense command receipt result payload failed schema validation.',
    );
  }

  return {
    ...existingReceipt.result,
    replayed: true,
  };
}

export function isPrismaUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'P2002';
}

export function toSafeExpenseRow(record: StoredExpenseRecord): SafeExpenseRow {
  const isMemoOnly = record.category === 'PARTNER_TIME_LOG_MEMO';
  return {
    id: record.id.toLowerCase(),
    organizationId: record.organizationId.toLowerCase(),
    loggedByUserId: record.loggedByUserId.toLowerCase(),
    recipientUserId: record.recipientUserId
      ? record.recipientUserId.toLowerCase()
      : null,
    custodyHolderUserId: record.custodyHolderUserId
      ? record.custodyHolderUserId.toLowerCase()
      : null,
    vehicleId: record.vehicleId ? record.vehicleId.toLowerCase() : null,
    shipmentId: record.shipmentId ? record.shipmentId.toLowerCase() : null,
    category: record.category,
    vendorName: record.vendorName,
    description: record.description,
    amountOriginalMinor: record.amountOriginalMinor,
    currencyOriginal: record.currencyOriginal,
    amountCadMinor: record.amountCadMinor,
    floatOffsetAppliedCadMinor: record.floatOffsetAppliedCadMinor,
    itcReceivableCadMinor: record.itcReceivableCadMinor,
    paidFromCashCustody: record.paidFromCashCustody,
    isDeferredIntercompanyAccrual: record.isDeferredIntercompanyAccrual,
    accrualSettledAt: record.accrualSettledAt
      ? record.accrualSettledAt.toISOString()
      : null,
    receiptVerificationState: record.receiptVerificationState,
    hasReceiptEvidence: Boolean(record.receiptStorageKey?.trim()),
    receiptSha256Hash: record.receiptSha256Hash,
    voucherReason: record.voucherReason,
    isMemoOnly,
    isReversalEntry: record.isReversalEntry,
    reversesExpenseId: record.reversesExpenseId
      ? record.reversesExpenseId.toLowerCase()
      : null,
    incurredAt: record.incurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

export function toSafeCashCustodyTransferRow(
  record: StoredCashCustodyTransferRecord,
): SafeCashCustodyTransferRow {
  return {
    id: record.id.toLowerCase(),
    organizationId: record.organizationId.toLowerCase(),
    transferCode: record.transferCode,
    marketNode: record.marketNode,
    fromCustodyState: record.fromCustodyState,
    toCustodyState: record.toCustodyState,
    currency: record.currency,
    amountMinor: record.amountMinor,
    equivalentCadMinor: record.equivalentCadMinor,
    commercialBankName: record.commercialBankName,
    recordedByUserId: record.recordedByUserId.toLowerCase(),
    custodyHolderUserId: record.custodyHolderUserId
      ? record.custodyHolderUserId.toLowerCase()
      : null,
    hasDepositSlipEvidence: Boolean(record.depositSlipStorageKey?.trim()),
    transferredAt: record.transferredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}
