import { createHash } from 'node:crypto';
import type {
  AraConditionGradeEnum,
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  EbaySyncState,
  ExpenseCategory,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  ScrapStreamCategory,
  SteeringSideCompatibility,
  TdgHazmatCode,
} from '@prisma/client';
import { z } from 'zod';
import {
  lookupDefaultSteeringSide,
  lookupDefaultTdgHazmatCode,
  lookupSuggestedHsCode,
} from '@/core/config/policy-loader';
import {
  computeGradeAdjustedMarketValueCadMinor,
  DomainRuleError,
  type LockedSoldPartCostInput,
  type ScrapRecoveryLogEntry,
  type UnsoldPartCostTrueUpInput,
  validateAraGrade,
  validateDamageCode,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import type { IStoragePort } from '@/core/ports/storage.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import type { LocationZoningService } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import { validateCanonicalTagCode } from '@/modules/shared-ops/locations-qr/qr-tag-sheet-and-zpl.generator';

export const PRISMA_INT32_MAX = 2_147_483_647 as const;
export const DECIMAL_8_2_MAX = 999_999.99 as const;
export const DECIMAL_6_2_MAX = 9_999.99 as const;

export const MAX_PART_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MiB per photo
export const MAX_SCRAP_TICKET_BYTES = 10 * 1024 * 1024; // 10 MiB per ticket
export const MAX_MULTIPART_METADATA_BYTES = 64 * 1024; // 64 KiB JSON metadata
export const MAX_MULTIPART_REQUEST_BYTES = 32 * 1024 * 1024; // 32 MiB aggregate request limit

export const PART_STRIP_RECEIPT_SCHEMA_VERSION = 1 as const;

/**
 * Fixed RFC-4122 namespace UUID exclusively for Issue #8 command receipts stored in `shared.AuditLog.id`.
 * Actor and action are intentionally excluded from receipt ID derivation so reusing an idempotency key
 * across different actions or actors within the same organization triggers a deterministic 409 conflict.
 */
export const ISSUE8_COMMAND_RECEIPT_NAMESPACE =
  '8b4e3a10-2c7d-4e5f-9a1b-8c7d6e5f4a3b' as const;

export const PART_STRIP_AUDIT_ACTIONS = {
  STRIP_AND_SHELVE: 'PART_STRIPPED_AND_SHELVED',
  DONOR_DISMANTLING_STARTED: 'VEHICLE_DISMANTLING_STARTED',
  RETURN_QC_INTAKE: 'PART_RETURN_QC_INTAKE',
  RETURN_QC_INSPECTED: 'PART_RETURN_QC_INSPECTED',
  LOG_SCRAP: 'SCRAP_COMPONENT_LOGGED',
  HULK_AWAITING_SCRAP: 'VEHICLE_HULK_AWAITING_SCRAP',
  COMPLETE_HULK: 'VEHICLE_HULK_CLEARED',
} as const;

export type PartStripCommandAction =
  | 'strip'
  | 'receive-return'
  | 'inspect-return'
  | 'log-scrap'
  | 'complete-hulk';

export type ShortAraGrade = 'A' | 'B1' | 'B2' | 'B3' | 'C';

export const SHORT_ARA_GRADE_TO_ENUM: Readonly<
  Record<ShortAraGrade, AraConditionGradeEnum>
> = Object.freeze({
  A: 'GRADE_A',
  B1: 'GRADE_B1',
  B2: 'GRADE_B2',
  B3: 'GRADE_B3',
  C: 'GRADE_C',
});

export type StripSteeringSideInput = 'UNIVERSAL' | 'LHD_ONLY';

export type ScrapPaymentReceiptMode = 'CASH' | 'CONFIRMED_BANK_DEPOSIT';

/**
 * Explicit allowlist of donor-linked `ExpenseCategory` values included in
 * `Vehicle.totalAcquisitionAndStripCostCadMinor` alongside `Vehicle.actualPurchasePriceCadMinor`.
 *
 * - `AUCTION_PURCHASE_PRICE` is excluded because `Vehicle.actualPurchasePriceCadMinor` already records it.
 * - Unrelated rebuild/freight/cannabis/partner-draw categories are excluded.
 */
export const ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
  new Set<ExpenseCategory>([
    'AUCTION_BUYER_FEE',
    'TOWING_AND_RECOVERY',
    'YARD_STRIPPER_PIECE_RATE',
    'RAMSAYVILLE_SHOP_LABOR',
    'REFRIGERANT_EVAC_AND_PREP',
  ]);

/**
 * Explicit normalized category names recognized as retail catalytic converter parts
 * (`Vehicle.catalyticConverterDisposition = 'SHELVED_AS_PART'`).
 */
export const CATALYTIC_CONVERTER_PART_CATEGORIES: ReadonlySet<string> =
  new Set([
    'catalytic converter',
    'oem catalytic converter',
    'exhaust catalytic converter',
  ]);

export function isCatalyticConverterPartCategory(categoryName: string): boolean {
  return CATALYTIC_CONVERTER_PART_CATEGORIES.has(
    categoryName.trim().replace(/\s+/g, ' ').toLowerCase(),
  );
}

export type PartStripErrorCode =
  | 'INVALID_PART_STRIP_INPUT'
  | 'ENTITY_NOT_FOUND'
  | 'TICKET_NOT_FOUND'
  | 'DUPLICATE_QR_SKU'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VERSION_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'HAZMAT_DOWNGRADE_FORBIDDEN'
  | 'CATALYTIC_DISPOSITION_CONFLICT'
  | 'SCRAP_LOG_MISMATCH'
  | 'LEGACY_PART_MISSING_BASELINE_VALUE'
  | 'EXPENSE_LEDGER_INTEGRITY_ERROR'
  | 'PART_STRIP_INTEGRITY_ERROR';

export type PartStripErrorStatus = 400 | 404 | 409 | 413 | 422 | 500;

const ERROR_STATUS_BY_CODE: Readonly<
  Record<PartStripErrorCode, PartStripErrorStatus>
> = {
  INVALID_PART_STRIP_INPUT: 400,
  ENTITY_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  DUPLICATE_QR_SKU: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  HAZMAT_DOWNGRADE_FORBIDDEN: 422,
  CATALYTIC_DISPOSITION_CONFLICT: 422,
  SCRAP_LOG_MISMATCH: 422,
  LEGACY_PART_MISSING_BASELINE_VALUE: 422,
  EXPENSE_LEDGER_INTEGRITY_ERROR: 422,
  PART_STRIP_INTEGRITY_ERROR: 500,
};

export class PartStripError extends Error {
  public readonly code: PartStripErrorCode;
  public readonly status: PartStripErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: PartStripErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PartStripError';
    this.code = code;
    this.status = ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const PRT_SIX_DIGIT_REGEX = /^PRT-\d{6}$/;
const HS_CODE_REGEX = /^\d{4}(?:\.\d{2}(?:\.\d{2,4})?)?$/;

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

export const PositiveDecimalKg = (maxVal: number, fieldName: string) =>
  z
    .number()
    .finite()
    .refine((v) => v > 0 && v <= maxVal, {
      message: `${fieldName} must be > 0 and <= ${maxVal}.`,
    })
    .transform((v) => Math.round(v * 100) / 100)
    .refine((v) => v > 0, {
      message: `${fieldName} must round to at least 0.01 kg.`,
    });

export const DateOrIsoSchema = z.union([z.date(), z.string().min(1)]);

export const TdgHazmatCodeSchema = z.enum([
  'NONE',
  'UN3268_AIRBAG',
  'UN0503_PYROTECHNIC',
  'UN2794_WET_BATTERY',
  'UN3480_LITHIUM_BATTERY',
]);

export const ShortAraGradeSchema = z.enum(['A', 'B1', 'B2', 'B3', 'C']);

export const StripSteeringSideSchema = z.enum(['UNIVERSAL', 'LHD_ONLY']);

export const ScrapStreamSchema = z.enum([
  'CATALYTIC_CONVERTER',
  'ALUMINUM_ALLOY_WHEELS',
  'COPPER_WIRING_HARNESS',
  'ROTORS_AND_BATTERY',
  'BARE_STEEL_SHELL',
]);

export interface StripPartPhotoInput {
  readonly bytes: Uint8Array;
  readonly filename?: string;
}

export interface StripPartCommand {
  readonly donorVehicleId: string;
  readonly donorExpectedVersion: number;
  readonly partCategoryName: string;
  readonly qrSkuCode: string;
  readonly araGrade: ShortAraGrade;
  readonly araDamageCode?: string;
  readonly conditionNotes?: string | null;
  readonly steeringSideCompatibility?: StripSteeringSideInput;
  readonly tdgHazmatCode?: TdgHazmatCode;
  readonly suggestedHsCode?: string;
  readonly oemFitmentVerified?: boolean;
  readonly oemPartNumbers?: readonly string[];
  readonly interchangePartNumbers?: readonly string[];
  readonly compBaselineCadMinor: number;
  readonly weightKg: number;
  readonly destinationBinBarcode: string;
  readonly photos: readonly [
    StripPartPhotoInput,
    StripPartPhotoInput,
    StripPartPhotoInput,
  ];
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
}

export interface ReceiveReturnCommand {
  readonly partId: string;
  readonly expectedVersion: number;
  readonly qcLocationBarcode: string;
  readonly returnReason?: string | null;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
}

export interface InspectReturnCommand {
  readonly partId: string;
  readonly expectedVersion: number;
  readonly qcPassed: boolean;
  readonly inspectedOriginalPhotosAndMarkings: true;
  readonly inspectionNotes: string;
  readonly destinationBinBarcode?: string | null;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
}

export interface LogScrapCommand {
  readonly donorVehicleId: string;
  readonly donorExpectedVersion: number;
  readonly scrapStream: ScrapStreamCategory;
  readonly weightKg: number;
  readonly payoutCadMinor: number;
  readonly recyclerName: string;
  readonly paymentReceiptMode: ScrapPaymentReceiptMode;
  readonly bankDepositConfirmed?: boolean;
  readonly bankDepositReference?: string | null;
  readonly ticketBytes: Uint8Array;
  readonly ticketContentType: string;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
}

export interface CompleteHulkCommand {
  readonly donorVehicleId: string;
  readonly donorExpectedVersion: number;
  readonly bareShellScrapLogId: string;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
}

export const StripPartMetadataSchema = z
  .object({
    action: z.literal('strip').optional(),
    donorVehicleId: z.string().min(1),
    donorExpectedVersion: PositivePrismaInt,
    partCategoryName: BoundedNonEmptyString(120, 'partCategoryName'),
    qrSkuCode: BoundedNonEmptyString(40, 'qrSkuCode'),
    araGrade: ShortAraGradeSchema,
    araDamageCode: BoundedNonEmptyString(10, 'araDamageCode').optional(),
    conditionNotes: BoundedOptionalString(500, 'conditionNotes'),
    steeringSideCompatibility: StripSteeringSideSchema.optional(),
    tdgHazmatCode: TdgHazmatCodeSchema.optional(),
    suggestedHsCode: BoundedNonEmptyString(20, 'suggestedHsCode').optional(),
    oemFitmentVerified: z.boolean().optional(),
    oemPartNumbers: z
      .array(BoundedNonEmptyString(64, 'oemPartNumber'))
      .max(20)
      .optional(),
    interchangePartNumbers: z
      .array(BoundedNonEmptyString(64, 'interchangePartNumber'))
      .max(20)
      .optional(),
    compBaselineCadMinor: PositivePrismaInt,
    weightKg: PositiveDecimalKg(DECIMAL_6_2_MAX, 'weightKg'),
    destinationBinBarcode: BoundedNonEmptyString(80, 'destinationBinBarcode'),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema,
  })
  .strict();

export const ReceiveReturnCommandSchema = z
  .object({
    action: z.literal('receive-return').optional(),
    partId: z.string().min(1),
    expectedVersion: PositivePrismaInt,
    qcLocationBarcode: BoundedNonEmptyString(80, 'qcLocationBarcode'),
    returnReason: BoundedOptionalString(300, 'returnReason'),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema,
  })
  .strict();

export const InspectReturnCommandSchema = z
  .object({
    action: z.literal('inspect-return').optional(),
    partId: z.string().min(1),
    expectedVersion: PositivePrismaInt,
    qcPassed: z.boolean(),
    inspectedOriginalPhotosAndMarkings: z.literal(true),
    inspectionNotes: BoundedNonEmptyString(500, 'inspectionNotes').refine(
      (v) => v.length >= 5,
      { message: 'inspectionNotes must be at least 5 characters.' },
    ),
    destinationBinBarcode: BoundedOptionalString(80, 'destinationBinBarcode'),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema,
  })
  .strict();

export const LogScrapMetadataSchema = z
  .object({
    action: z.literal('log-scrap').optional(),
    donorVehicleId: z.string().min(1),
    donorExpectedVersion: PositivePrismaInt,
    scrapStream: ScrapStreamSchema,
    weightKg: PositiveDecimalKg(DECIMAL_8_2_MAX, 'weightKg'),
    payoutCadMinor: NonNegativePrismaInt,
    recyclerName: BoundedNonEmptyString(140, 'recyclerName'),
    paymentReceiptMode: z.enum(['CASH', 'CONFIRMED_BANK_DEPOSIT']),
    bankDepositConfirmed: z.boolean().optional(),
    bankDepositReference: BoundedOptionalString(120, 'bankDepositReference'),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema,
  })
  .strict();

export const CompleteHulkCommandSchema = z
  .object({
    action: z.literal('complete-hulk').optional(),
    donorVehicleId: z.string().min(1),
    donorExpectedVersion: PositivePrismaInt,
    bareShellScrapLogId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    deviceTimestamp: DateOrIsoSchema,
  })
  .strict();

export function assertValidUuidParam(value: unknown, fieldName: string): string {
  if (!isValidUuid(value)) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `${fieldName} must be a valid UUID string.`,
    );
  }
  return value.toLowerCase();
}

export function parseStrictTimestamp(value: Date | string, fieldName: string): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `${fieldName} must be a valid ISO timestamp or Date.`,
    );
  }
  return date;
}

export function normalizeAndValidatePartQrSku(rawCode: string): string {
  const normalized = rawCode.trim().toUpperCase();
  if (!PRT_SIX_DIGIT_REGEX.test(normalized)) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `qrSkuCode "${rawCode}" must match canonical PRT-XXXXXX (6 digits).`,
    );
  }
  try {
    return validateCanonicalTagCode(normalized);
  } catch (error) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      error instanceof Error ? error.message : 'Invalid part QR code.',
    );
  }
}

export function normalizeAndValidateLocationBarcode(
  rawBarcode: string,
  fieldName: string,
): string {
  const normalized = rawBarcode.trim().toUpperCase();
  try {
    return validateCanonicalTagCode(normalized);
  } catch (error) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `${fieldName}: ${error instanceof Error ? error.message : 'Invalid location barcode.'}`,
    );
  }
}

export function mapShortAraGradeToEnum(shortGrade: ShortAraGrade): AraConditionGradeEnum {
  const mapped = SHORT_ARA_GRADE_TO_ENUM[shortGrade];
  return validateAraGrade(mapped);
}

export function validateOptionalDamageCode(rawCode?: string): string {
  if (rawCode === undefined) {
    return '000';
  }
  return validateDamageCode(rawCode.trim().toUpperCase());
}

export function validateSuggestedHsCodeFormat(rawCode: string): string {
  const trimmed = rawCode.trim();
  if (!HS_CODE_REGEX.test(trimmed)) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `suggestedHsCode "${rawCode}" must match NNNN, NNNN.NN, or NNNN.NN.NNNN.`,
    );
  }
  return trimmed;
}

export interface ResolvedPartClassification {
  readonly partCategoryName: string;
  readonly recognizedCategory: boolean;
  readonly steeringSideCompatibility: StripSteeringSideInput;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly isHazmatOrAirbag: boolean;
  readonly complianceState: PartComplianceState;
  readonly suggestedHsCode: string;
}

/**
 * Resolves and validates category-driven steering compatibility, TDG hazmat code,
 * compliance state, and HS suggestion without substring matching.
 *
 * - Recognized hazardous categories cannot be downgraded to `NONE`.
 * - Unknown categories require explicit `steeringSideCompatibility`, `tdgHazmatCode`,
 *   and `suggestedHsCode`.
 * - `isHazmatOrAirbag` is strictly `tdgHazmatCode !== 'NONE'`.
 */
export function resolvePartClassification(input: {
  readonly partCategoryName: string;
  readonly steeringSideCompatibility?: StripSteeringSideInput;
  readonly tdgHazmatCode?: TdgHazmatCode;
  readonly suggestedHsCode?: string;
}): ResolvedPartClassification {
  const canonicalCategory = input.partCategoryName.trim();
  const defaultSteering = lookupDefaultSteeringSide(canonicalCategory);
  const defaultTdg = lookupDefaultTdgHazmatCode(canonicalCategory);
  const defaultHs = lookupSuggestedHsCode(canonicalCategory);

  const recognizedCategory =
    defaultSteering !== undefined ||
    defaultTdg !== undefined ||
    defaultHs !== undefined;

  if (!recognizedCategory) {
    if (
      !input.steeringSideCompatibility ||
      !input.tdgHazmatCode ||
      !input.suggestedHsCode
    ) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        `Unknown part category "${canonicalCategory}" requires explicit steeringSideCompatibility, tdgHazmatCode, and suggestedHsCode.`,
      );
    }
  }

  let resolvedSteering: StripSteeringSideInput;
  if (input.steeringSideCompatibility !== undefined) {
    resolvedSteering = input.steeringSideCompatibility;
  } else if (defaultSteering === 'UNIVERSAL' || defaultSteering === 'LHD_ONLY') {
    resolvedSteering = defaultSteering;
  } else if (defaultSteering === 'RHD_ONLY') {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `Category "${canonicalCategory}" defaults to RHD_ONLY which is unsupported in Ontario strip intake.`,
    );
  } else if (defaultTdg !== undefined) {
    // Policy-loader hazardous categories (airbags/pretensioners/batteries) do not appear in
    // PART_CATEGORY_STEERING_SIDE_DEFAULTS; default safely to UNIVERSAL when omitted.
    resolvedSteering = 'UNIVERSAL';
  } else {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `steeringSideCompatibility is required for "${canonicalCategory}".`,
    );
  }

  let resolvedTdg: TdgHazmatCode;
  if (defaultTdg !== undefined && defaultTdg !== 'NONE') {
    if (input.tdgHazmatCode !== undefined && input.tdgHazmatCode !== defaultTdg) {
      throw new PartStripError(
        'HAZMAT_DOWNGRADE_FORBIDDEN',
        `Recognized hazardous category "${canonicalCategory}" requires tdgHazmatCode=${defaultTdg} and cannot be downgraded or altered to "${input.tdgHazmatCode}".`,
      );
    }
    resolvedTdg = defaultTdg;
  } else if (input.tdgHazmatCode !== undefined) {
    resolvedTdg = input.tdgHazmatCode;
  } else if (defaultTdg !== undefined) {
    resolvedTdg = defaultTdg;
  } else {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `tdgHazmatCode is required for "${canonicalCategory}".`,
    );
  }

  const rawHs = input.suggestedHsCode ?? defaultHs;
  if (!rawHs) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `suggestedHsCode is required for "${canonicalCategory}".`,
    );
  }
  const resolvedHs = validateSuggestedHsCodeFormat(rawHs);

  const isHazmatOrAirbag = resolvedTdg !== 'NONE';
  const complianceState: PartComplianceState =
    resolvedTdg === 'UN3268_AIRBAG' || resolvedTdg === 'UN0503_PYROTECHNIC'
      ? 'QUARANTINED_RECALL_OR_DG'
      : 'CLEARED_FOR_SALE';

  return {
    partCategoryName: canonicalCategory,
    recognizedCategory,
    steeringSideCompatibility: resolvedSteering,
    tdgHazmatCode: resolvedTdg,
    isHazmatOrAirbag,
    complianceState,
    suggestedHsCode: resolvedHs,
  };
}

/**
 * Derives a valid deterministic RFC-4122 UUID PK for `shared.AuditLog` command receipts.
 */
export function deriveIssue8CommandReceiptId(
  organizationId: string,
  idempotencyKey: string,
): string {
  const normalizedOrg = assertValidUuidParam(organizationId, 'organizationId');
  const normalizedKey = assertValidUuidParam(idempotencyKey, 'idempotencyKey');
  const digest = createHash('sha256')
    .update(
      `${ISSUE8_COMMAND_RECEIPT_NAMESPACE}:${normalizedOrg}:${normalizedKey}`,
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

export function computeCommandFingerprint(params: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: PartStripCommandAction;
  readonly payload: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(
    canonicalizeJsonValue({
      schemaVersion: PART_STRIP_RECEIPT_SCHEMA_VERSION,
      organizationId: params.organizationId.toLowerCase(),
      actorUserId: params.actorUserId.toLowerCase(),
      action: params.action,
      payload: params.payload,
    }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export interface StoredCommandReceipt<TResult = unknown> {
  readonly auditLogId: string;
  readonly schemaVersion: number;
  readonly idempotencyKey: string;
  readonly action: PartStripCommandAction;
  readonly commandFingerprint: string;
  readonly result: TResult;
}

export function parseCommandReceiptNextState(
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
    r.schemaVersion !== PART_STRIP_RECEIPT_SCHEMA_VERSION ||
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
    action: r.action as PartStripCommandAction,
    commandFingerprint: r.commandFingerprint,
    result: r.result,
  };
}

export function resolveIdempotentCommandReplay<
  TResult extends { readonly replayed: boolean },
>(params: {
  readonly existingReceipt: StoredCommandReceipt | null;
  readonly expectedAction: PartStripCommandAction;
  readonly expectedIdempotencyKey: string;
  readonly expectedFingerprint: string;
  readonly hasConflictingCustodyEvent: boolean;
  readonly validateResult: (raw: unknown) => raw is TResult;
}): TResult | null {
  const { existingReceipt } = params;
  if (!existingReceipt) {
    if (params.hasConflictingCustodyEvent) {
      throw new PartStripError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already consumed by another custody operation.',
      );
    }
    return null;
  }

  if (
    existingReceipt.schemaVersion !== PART_STRIP_RECEIPT_SCHEMA_VERSION ||
    existingReceipt.idempotencyKey !== params.expectedIdempotencyKey.toLowerCase()
  ) {
    throw new PartStripError(
      'PART_STRIP_INTEGRITY_ERROR',
      'Stored command receipt failed integrity validation.',
    );
  }

  if (
    existingReceipt.action !== params.expectedAction ||
    existingReceipt.commandFingerprint !== params.expectedFingerprint
  ) {
    throw new PartStripError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key was already used with a different command, actor, or payload.',
    );
  }

  if (!params.validateResult(existingReceipt.result)) {
    throw new PartStripError(
      'PART_STRIP_INTEGRITY_ERROR',
      'Stored command receipt result payload failed schema validation.',
    );
  }

  return {
    ...existingReceipt.result,
    replayed: true,
  };
}

export interface LockedDonorExpenseRow {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string | null;
  readonly category: ExpenseCategory;
  readonly amountCadMinor: number;
  readonly isReversalEntry: boolean;
  readonly reversesExpenseId: string | null;
}

export interface DonorDirectCostLedgerSummary {
  readonly actualPurchasePriceCadMinor: number;
  readonly loggedDirectExpensesCadMinor: number;
  readonly totalAcquisitionAndStripCostCadMinor: number;
  readonly includedExpenseIds: readonly string[];
}

/**
 * Computes `Vehicle.totalAcquisitionAndStripCostCadMinor` strictly from
 * `actualPurchasePriceCadMinor` plus allowlisted donor-linked direct expenses
 * netted by valid compensating `reversesExpenseId` entries.
 */
export function computeDonorDirectCostLedger(params: {
  readonly donorVehicleId: string;
  readonly actualPurchasePriceCadMinor: number;
  readonly expenses: readonly LockedDonorExpenseRow[];
}): DonorDirectCostLedgerSummary {
  const purchase = params.actualPurchasePriceCadMinor;
  if (!Number.isSafeInteger(purchase) || purchase < 0) {
    throw new PartStripError(
      'EXPENSE_LEDGER_INTEGRITY_ERROR',
      'Donor actualPurchasePriceCadMinor must be a non-negative integer.',
    );
  }

  const byId = new Map<string, LockedDonorExpenseRow>();
  for (const exp of params.expenses) {
    if (!Number.isSafeInteger(exp.amountCadMinor) || exp.amountCadMinor < 0) {
      throw new PartStripError(
        'EXPENSE_LEDGER_INTEGRITY_ERROR',
        `Donor expense "${exp.id}" has invalid amountCadMinor.`,
      );
    }
    if (exp.vehicleId !== params.donorVehicleId) {
      throw new PartStripError(
        'EXPENSE_LEDGER_INTEGRITY_ERROR',
        `Expense "${exp.id}" is not linked to donor vehicle "${params.donorVehicleId}".`,
      );
    }
    byId.set(exp.id, exp);
  }

  const reversalsByTargetId = new Map<string, number>();
  for (const exp of params.expenses) {
    if (exp.isReversalEntry) {
      if (!exp.reversesExpenseId) {
        throw new PartStripError(
          'EXPENSE_LEDGER_INTEGRITY_ERROR',
          `Reversal expense "${exp.id}" is missing reversesExpenseId.`,
        );
      }
      const target = byId.get(exp.reversesExpenseId);
      if (!target || target.isReversalEntry) {
        throw new PartStripError(
          'EXPENSE_LEDGER_INTEGRITY_ERROR',
          `Reversal expense "${exp.id}" references missing or invalid target "${exp.reversesExpenseId}".`,
        );
      }
      if (target.category !== exp.category) {
        throw new PartStripError(
          'EXPENSE_LEDGER_INTEGRITY_ERROR',
          `Reversal expense "${exp.id}" category "${exp.category}" mismatches target category "${target.category}".`,
        );
      }
      const prev = reversalsByTargetId.get(target.id) ?? 0;
      reversalsByTargetId.set(target.id, prev + exp.amountCadMinor);
    } else if (exp.reversesExpenseId !== null) {
      throw new PartStripError(
        'EXPENSE_LEDGER_INTEGRITY_ERROR',
        `Non-reversal expense "${exp.id}" cannot populate reversesExpenseId.`,
      );
    }
  }

  let directSum = 0;
  const includedExpenseIds: string[] = [];

  for (const exp of params.expenses) {
    if (exp.isReversalEntry) {
      continue;
    }
    const reversedAmount = reversalsByTargetId.get(exp.id) ?? 0;
    const netAmount = exp.amountCadMinor - reversedAmount;
    if (netAmount < 0) {
      throw new PartStripError(
        'EXPENSE_LEDGER_INTEGRITY_ERROR',
        `Reversal entries (${reversedAmount}) exceed original expense "${exp.id}" (${exp.amountCadMinor}).`,
      );
    }
    if (ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES.has(exp.category)) {
      const nextSum = directSum + netAmount;
      if (!Number.isSafeInteger(nextSum) || nextSum > PRISMA_INT32_MAX) {
        throw new DomainRuleError(
          'MONETARY_OVERFLOW',
          'Donor direct strip cost exceeds safe integer bounds.',
        );
      }
      directSum = nextSum;
      if (netAmount > 0) {
        includedExpenseIds.push(exp.id);
      }
    }
  }

  const total = purchase + directSum;
  if (!Number.isSafeInteger(total)) {
    throw new DomainRuleError(
      'MONETARY_OVERFLOW',
      'totalAcquisitionAndStripCostCadMinor exceeds safe integer bounds.',
    );
  }

  return {
    actualPurchasePriceCadMinor: purchase,
    loggedDirectExpensesCadMinor: directSum,
    totalAcquisitionAndStripCostCadMinor: total,
    includedExpenseIds,
  };
}

export interface LockedDonorPartRow {
  readonly id: string;
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly qrSkuCode: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly partCategoryName: string;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly araGrade: AraConditionGradeEnum;
  readonly compBaselineCadMinor: number | null;
  readonly allocatedCostBasisCadMinor: number;
  readonly storageLocationId: string | null;
  readonly currentLocationBarcode: string | null;
  readonly rawPhotoUrls: readonly string[];
  readonly complianceWarnings: readonly string[];
  readonly hasActiveSale: boolean;
  readonly version: number;
}

export function isFixedCostAllocationPart(
  part: Pick<LockedDonorPartRow, 'custodyState' | 'hasActiveSale'>,
): boolean {
  return (
    part.custodyState === 'SOLD_AND_RELEASED' ||
    part.hasActiveSale ||
    part.custodyState === 'SCRAPPED_OR_DAMAGED'
  );
}

export function computePartGradeAdjustedBaseline(
  part: Pick<LockedDonorPartRow, 'id' | 'araGrade' | 'compBaselineCadMinor'>,
  policy: Pick<PricingAndCompliancePolicy, 'araGradeMultipliers'>,
): number {
  if (
    part.compBaselineCadMinor === null ||
    !Number.isSafeInteger(part.compBaselineCadMinor) ||
    part.compBaselineCadMinor <= 0
  ) {
    throw new PartStripError(
      'LEGACY_PART_MISSING_BASELINE_VALUE',
      `Part "${part.id}" is missing a positive compBaselineCadMinor required for cost allocation.`,
      { partId: part.id },
    );
  }
  return computeGradeAdjustedMarketValueCadMinor(
    part.compBaselineCadMinor,
    part.araGrade,
    policy,
  );
}

export function partitionDonorPartsForTrueUp(params: {
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly parts: readonly LockedDonorPartRow[];
  readonly policy: Pick<PricingAndCompliancePolicy, 'araGradeMultipliers'>;
}): {
  readonly soldParts: readonly LockedSoldPartCostInput[];
  readonly unsoldParts: readonly UnsoldPartCostTrueUpInput[];
  readonly existingVersionByPartId: ReadonlyMap<string, number>;
  readonly existingCostByPartId: ReadonlyMap<string, number>;
} {
  const soldParts: LockedSoldPartCostInput[] = [];
  const unsoldParts: UnsoldPartCostTrueUpInput[] = [];
  const existingVersionByPartId = new Map<string, number>();
  const existingCostByPartId = new Map<string, number>();

  for (const part of params.parts) {
    existingVersionByPartId.set(part.id, part.version);
    existingCostByPartId.set(part.id, part.allocatedCostBasisCadMinor);

    if (isFixedCostAllocationPart(part)) {
      soldParts.push({
        partId: part.id,
        organizationId: params.organizationId,
        donorVehicleId: params.donorVehicleId,
        lockedAllocatedCostBasisCadMinor: part.allocatedCostBasisCadMinor,
      });
    } else {
      const gradeAdjusted = computePartGradeAdjustedBaseline(part, params.policy);
      unsoldParts.push({
        partId: part.id,
        organizationId: params.organizationId,
        donorVehicleId: params.donorVehicleId,
        gradeAdjustedMarketValueCadMinor: gradeAdjusted,
      });
    }
  }

  return {
    soldParts,
    unsoldParts,
    existingVersionByPartId,
    existingCostByPartId,
  };
}

export interface LockedDonorVehicleRow {
  readonly id: string;
  readonly organizationId: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly actualPurchasePriceCadMinor: number;
  readonly targetGrossRealizationMinor: number;
  readonly fluidsDrainedAt: Date | null;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly scrapMetalTicketKey: string | null;
  readonly scrapRecoveryCadMinor: number;
  readonly scrappedClearedAt: Date | null;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
}

export interface LockedStorageLocationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly allowedOrgType: OrganizationType;
  readonly locationOperationalStatus: LocationOperationalStatus;
  readonly allowsWholeVehicleDismantling: boolean;
  readonly maxActiveAssetCapacity: number | null;
  readonly fullQrBarcode: string;
}

export interface LockedScrapLogRow extends ScrapRecoveryLogEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly stream: ScrapStreamCategory;
  readonly weightKg: number | null;
  readonly payoutCadMinor: number;
  readonly recyclerName: string;
  readonly recyclerTicketStorageKey: string;
  readonly cashCustodyState: CashCustodyState;
  readonly recordedByUserId: string;
  readonly createdAt: Date;
}

export interface PersistNewPartRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly donorVehicleId: string;
  readonly strippedByUserId: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly partCategoryName: string;
  readonly steeringSideCompatibility: SteeringSideCompatibility;
  readonly oemFitmentVerified: boolean;
  readonly isHazmatOrAirbag: boolean;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly oemPartNumbers: readonly string[];
  readonly interchangePartNumbers: readonly string[];
  readonly suggestedHsCode: string;
  readonly brokerVerifiedHsCode: null;
  readonly araGrade: AraConditionGradeEnum;
  readonly araDamageCode: string;
  readonly conditionNotes: string | null;
  readonly humanVerifiedAt: Date;
  readonly weightKg: number;
  readonly rawPhotoUrls: readonly string[];
  readonly cleanPhotoUrls: readonly string[];
  readonly storageLocationId: string;
  readonly allocatedCostBasisCadMinor: number;
  readonly compBaselineCadMinor: number;
  readonly complianceWarnings: readonly string[];
  readonly version: 1;
  readonly strippedAt: Date;
}

export interface PersistPartCustodyEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly partId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly fromLocationBarcode: string | null;
  readonly toLocationBarcode: string;
  readonly expectedVersion: number;
  readonly hasConflict: false;
  readonly complianceWarnings: readonly string[];
  readonly deviceTimestamp: Date;
  readonly serverReceivedAt: Date;
}

export interface PersistScrapLogRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string;
  readonly scrapStream: ScrapStreamCategory;
  readonly weightKg: number;
  readonly payoutCadMinor: number;
  readonly recyclerName: string;
  readonly recyclerTicketStorageKey: string;
  readonly cashCustodyState: CashCustodyState;
  readonly recordedByUserId: string;
  readonly createdAt: Date;
}

export interface PersistAuditLogRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly previousState: Readonly<Record<string, unknown>> | null;
  readonly nextState: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface SafeDonorSummaryRow {
  readonly id: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly fluidsDrainedAt: string | null;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly scrapRecoveryCadMinor: number;
  readonly scrappedClearedAt: string | null;
  readonly complianceWarnings: readonly string[];
  readonly bareShellScrapLogIds: readonly string[];
  readonly version: number;
}

export interface SafePartListRow {
  readonly id: string;
  readonly qrSkuCode: string;
  readonly donorVehicleId: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly partCategoryName: string;
  readonly steeringSideCompatibility: SteeringSideCompatibility;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly isHazmatOrAirbag: boolean;
  readonly suggestedHsCode: string;
  readonly araGrade: AraConditionGradeEnum;
  readonly araDamageCode: string;
  readonly weightKg: number;
  readonly rawPhotoUrls: readonly string[];
  readonly storageLocationId: string | null;
  readonly locationBarcode: string | null;
  readonly allocatedCostBasisCadMinor: number;
  readonly compBaselineCadMinor: number | null;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
  readonly strippedAt: string;
}

export interface SafeScrapHistoryRow {
  readonly id: string;
  readonly vehicleId: string;
  readonly scrapStream: ScrapStreamCategory;
  readonly weightKg: number | null;
  readonly payoutCadMinor: number;
  readonly recyclerName: string;
  readonly cashCustodyState: CashCustodyState;
  readonly hasTicketEvidence: boolean;
  readonly createdAt: string;
}

export interface StripPartResult {
  readonly replayed: boolean;
  readonly partId: string;
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly donorLifecycleState: AssetLifecycleState;
  readonly donorVersion: number;
  readonly qrSkuCode: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly partCategoryName: string;
  readonly steeringSideCompatibility: SteeringSideCompatibility;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly isHazmatOrAirbag: boolean;
  readonly suggestedHsCode: string;
  readonly araGrade: AraConditionGradeEnum;
  readonly araDamageCode: string;
  readonly allocatedCostBasisCadMinor: number;
  readonly storageLocationId: string;
  readonly destinationBinBarcode: string;
  readonly rawPhotoUrls: readonly string[];
  readonly complianceWarnings: readonly string[];
  readonly version: number;
  readonly custodyEventId: string;
  readonly auditLogId: string;
  readonly strippedAt: string;
}

export interface ReceiveReturnResult {
  readonly replayed: boolean;
  readonly partId: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly storageLocationId: string;
  readonly qcLocationBarcode: string;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
  readonly custodyEventId: string;
  readonly auditLogId: string;
}

export interface InspectReturnResult {
  readonly replayed: boolean;
  readonly partId: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly qcPassed: boolean;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly storageLocationId: string | null;
  readonly destinationBinBarcode: string | null;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
  readonly custodyEventId: string | null;
  readonly auditLogId: string;
}

export interface LogScrapResult {
  readonly replayed: boolean;
  readonly scrapLogId: string;
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly donorLifecycleState: AssetLifecycleState;
  readonly donorVersion: number;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly scrapStream: ScrapStreamCategory;
  readonly payoutCadMinor: number;
  readonly cashCustodyState: CashCustodyState;
  readonly recyclerTicketSha256Hash: string;
  readonly scrapRecoveryCadMinor: number;
  readonly remainingCostBasisToAllocateCadMinor: number;
  readonly updatedPartIds: readonly string[];
  readonly auditLogId: string;
  readonly createdAt: string;
}

export interface CompleteHulkResult {
  readonly replayed: boolean;
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly lifecycleState: AssetLifecycleState;
  readonly donorVersion: number;
  readonly bareShellScrapLogId: string;
  readonly scrapRecoveryCadMinor: number;
  readonly remainingCostBasisToAllocateCadMinor: number;
  readonly updatedPartIds: readonly string[];
  readonly complianceWarnings: readonly string[];
  readonly auditLogId: string;
  readonly scrappedClearedAt: string;
}

export interface PrivateTicketUrlResult {
  readonly scrapLogId: string;
  readonly presignedUrl: string;
  readonly ttlSeconds: number;
}

export interface PartStripTx {
  acquireOrganizationLock(organizationId: string): Promise<void>;
  readOrganizationPolicyRecord(organizationId: string): Promise<{
    organizationId: string;
    policyConfigJson: unknown;
  } | null>;
  findCommandReceipt(
    organizationId: string,
    receiptAuditId: string,
  ): Promise<StoredCommandReceipt | null>;
  findCustodyEventByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<{ id: string } | null>;
  partQrSkuExists(qrSkuCode: string): Promise<boolean>;
  findAndLockDonorVehicle(
    organizationId: string,
    donorVehicleId: string,
  ): Promise<LockedDonorVehicleRow | null>;
  findAndLockDonorParts(
    organizationId: string,
    donorVehicleId: string,
  ): Promise<readonly LockedDonorPartRow[]>;
  findAndLockPart(
    organizationId: string,
    partId: string,
  ): Promise<LockedDonorPartRow | null>;
  listDonorExpenses(
    organizationId: string,
    donorVehicleId: string,
  ): Promise<readonly LockedDonorExpenseRow[]>;
  listDonorScrapLogs(
    organizationId: string,
    donorVehicleId: string,
  ): Promise<readonly LockedScrapLogRow[]>;
  findScrapLogById(
    organizationId: string,
    scrapLogId: string,
  ): Promise<LockedScrapLogRow | null>;
  findAndLockStorageLocationByBarcode(
    organizationId: string,
    fullQrBarcode: string,
  ): Promise<LockedStorageLocationRow | null>;
  insertPart(input: PersistNewPartRecord): Promise<void>;
  updatePartStateAndLocation(input: {
    readonly organizationId: string;
    readonly partId: string;
    readonly expectedCurrentVersion: number;
    readonly nextVersion: number;
    readonly custodyState: PartCustodyState;
    readonly availabilityState: InventoryAvailabilityState;
    readonly ebaySyncState: EbaySyncState;
    readonly classifiedsSyncState: ClassifiedsSyncState;
    readonly complianceState: PartComplianceState;
    readonly storageLocationId: string | null;
    readonly complianceWarnings: readonly string[];
    readonly humanVerifiedAt?: Date;
    readonly updatedAt: Date;
  }): Promise<boolean>;
  updatePartCostBasis(input: {
    readonly organizationId: string;
    readonly partId: string;
    readonly expectedCurrentVersion: number;
    readonly nextVersion: number;
    readonly allocatedCostBasisCadMinor: number;
    readonly updatedAt: Date;
  }): Promise<boolean>;
  updateDonorVehicle(input: {
    readonly organizationId: string;
    readonly donorVehicleId: string;
    readonly expectedCurrentVersion: number;
    readonly nextVersion: number;
    readonly lifecycleState?: AssetLifecycleState;
    readonly catalyticConverterDisposition?: CatalyticConverterDisposition;
    readonly scrapMetalTicketKey?: string | null;
    readonly scrapRecoveryCadMinor?: number;
    readonly scrappedClearedAt?: Date | null;
    readonly complianceWarnings?: readonly string[];
    readonly updatedAt: Date;
  }): Promise<boolean>;
  insertScrapComponentLog(input: PersistScrapLogRecord): Promise<void>;
  insertCustodyEvent(input: PersistPartCustodyEventRecord): Promise<void>;
  insertAuditLog(input: PersistAuditLogRecord): Promise<void>;
  listStripDonors(
    organizationId: string,
    filter: { readonly donorVehicleId?: string; readonly limit: number },
  ): Promise<readonly SafeDonorSummaryRow[]>;
  listParts(
    organizationId: string,
    filter: {
      readonly donorVehicleId?: string;
      readonly partId?: string;
      readonly qrSkuCode?: string;
      readonly qcHoldOnly?: boolean;
      readonly limit: number;
    },
  ): Promise<readonly SafePartListRow[]>;
  listScrapHistory(
    organizationId: string,
    filter: { readonly donorVehicleId?: string; readonly limit: number },
  ): Promise<readonly SafeScrapHistoryRow[]>;
}

export interface PartStripRepository {
  withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: PartStripTx) => Promise<T>,
  ): Promise<T>;
}

export interface PartStripClock {
  now(): Date;
}

export interface PartStripUseCaseDeps {
  readonly repository?: PartStripRepository;
  readonly storage?: IStoragePort;
  readonly zoningService?: LocationZoningService;
  readonly clock?: PartStripClock;
  readonly idGenerator?: () => string;
}

export function isPrismaUniqueViolation(
  error: unknown,
  constraintHint?: string,
): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    code?: unknown;
    meta?: { target?: unknown };
    message?: unknown;
  };
  const isP2002 = err.code === 'P2002' || err.code === '23505';
  const msg = typeof err.message === 'string' ? err.message : '';
  if (!constraintHint) {
    return isP2002 || msg.includes('23505');
  }
  if (isP2002) {
    const target = err.meta?.target;
    if (Array.isArray(target) && target.some((t) => String(t).includes(constraintHint))) {
      return true;
    }
    if (typeof target === 'string' && target.includes(constraintHint)) {
      return true;
    }
  }
  return msg.includes(constraintHint);
}
