import type { UserRole } from '@prisma/client';

export type DomainRuleErrorCode =
  | 'INVALID_MONETARY_AMOUNT'
  | 'NEGATIVE_MONETARY_AMOUNT'
  | 'MONETARY_OVERFLOW'
  | 'INVALID_DECIMAL_RATE'
  | 'INVALID_BASIS_POINTS'
  | 'INVALID_INPUT'
  | 'ORGANIZATION_MISMATCH'
  | 'DONOR_VEHICLE_MISMATCH'
  | 'DUPLICATE_ENTITY_ID'
  | 'INVALID_PART_TRANSITION'
  | 'INVALID_VEHICLE_TRANSITION'
  | 'INVALID_PAYMENT_SETTLEMENT_TRANSITION'
  | 'INVALID_PAYMENT_CUSTODY_STATE'
  | 'EBAY_LISTING_ID_REQUIRED'
  | 'EBAY_DELIST_ATTESTATION_REQUIRED'
  | 'HAZMAT_PARCEL_SHIPPING_BLOCKED'
  | 'PART_NOT_EBAY_PARCEL_ELIGIBLE'
  | 'PART_QUARANTINED'
  | 'PART_QC_HOLD_ACTIVE'
  | 'EXPORT_LOCK_NOT_CONFIRMED'
  | 'SITE_ZONING_VIOLATION'
  | 'LOCATION_DORMANT_FUTURE'
  | 'ENVIRONMENTAL_ZONING_VIOLATION'
  | 'LOCATION_PROPOSED_INACTIVE'
  | 'EASR_REGISTRATION_REQUIRED'
  | 'EXPIRED_OR_MISSING_SAFETY_CERT'
  | 'MISSING_HTA_S60_DOCS'
  | 'UNRECONCILED_CATALYTIC_CONVERTER'
  | 'SCRAP_METAL_TICKET_REQUIRED'
  | 'INVALID_ARA_GRADE'
  | 'INVALID_ARA_DAMAGE_CODE'
  | 'INVALID_PART_WEIGHT'
  | 'INVALID_TIMESTAMP'
  | 'ZERO_ALLOCATION_DENOMINATOR'
  | 'DONOR_COST_RECONCILIATION_EXCEEDED'
  | 'NO_ELIGIBLE_UNSOLD_PARTS_FOR_RECONCILIATION'
  | 'INVALID_SCRAP_STREAM'
  | 'DESTINATION_PROVINCE_REQUIRED_FOR_TAX'
  | 'INVALID_CANADIAN_PROVINCE_CODE'
  | 'INVALID_DESTINATION_COUNTRY'
  | 'EXPORT_PROOF_REQUIRED_FOR_ZERO_RATING'
  | 'FEE_TAX_INVOICE_KEY_REQUIRED'
  | 'REFUND_EXCEEDS_ORIGINAL_SALE'
  | 'REFUND_EXCEEDS_ORIGINAL_ITC'
  | 'CREDIT_NOTE_REFERENCE_REQUIRED'
  | 'DUPLICATE_REFUND_ADJUSTMENT'
  | 'FLOOR_PRICE_OVERRIDE_REQUIRED'
  | 'DISCOUNT_REASON_REQUIRED'
  | 'DISCOUNT_ROLE_UNAUTHORIZED'
  | 'CFO_OVERRIDE_REASON_REQUIRED'
  | 'CFO_OVERRIDE_UNAUTHORIZED'
  | 'PREPAID_EXPORT_REQUIRED'
  | 'EXPORT_ITEMS_REQUIRED'
  | 'INVALID_BROKER_COMMISSION_RATE'
  | 'UNCONVERTED_NON_CAD_AMOUNT'
  | 'DUPLICATE_SWEEP_SOURCE_CREDIT'
  | 'INVALID_DEPOSIT_SLIP_KEY'
  | 'WORKING_CAPITAL_RESERVE_BREACHED'
  | 'DONOR_LANDED_CAP_EXCEEDED'
  | 'HIGH_END_REBUILD_LANE_PAUSED'
  | 'PIECE_RATE_GATE_UNMET'
  | 'INSUFFICIENT_REALIZED_PROFIT_POOL'
  | 'INSUFFICIENT_LIQUID_RESERVE_CAPACITY'
  | 'OEM_FITMENT_UNVERIFIED'
  | 'LHD_PART_BLOCKED_FOR_RHD_EXPORT'
  | 'FIU_CDD_ID_REQUIRED';

export class DomainRuleError<
  TCode extends string = DomainRuleErrorCode,
> extends Error {
  public readonly code: TCode;
  public readonly status = 422 as const;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: TCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainRuleError';
    this.code = code;
    this.details = details;
  }
}

export interface ActorContext {
  readonly actorUserId: string;
  readonly actorRole: UserRole;
}

export interface TrustedCfoApprovalInput {
  readonly approved: boolean;
  readonly approvedById: string;
  readonly approverRole?: UserRole;
  readonly reasonNote: string;
}

export interface CfoOverrideAuditFact {
  readonly overrideApplied: boolean;
  readonly approvedById: string | null;
  readonly reasonNote: string | null;
}

export interface GateDecision<TBlockingCode extends string = DomainRuleErrorCode> {
  readonly allowed: boolean;
  readonly blockingCodes: readonly TBlockingCode[];
  readonly warnings: readonly string[];
  readonly overrideApplied: boolean;
  readonly cfoOverrideAudit: CfoOverrideAuditFact;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

export function assertNonEmptyTrimmedString(
  value: unknown,
  code: DomainRuleErrorCode,
  message: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainRuleError(code, message);
  }
  return value.trim();
}

export function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertSafeInt(value: number, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value)
  ) {
    throw new DomainRuleError(
      'INVALID_MONETARY_AMOUNT',
      `${fieldName} must be a finite safe integer minor-unit amount.`,
      { fieldName, value },
    );
  }
  return value;
}

export function assertNonNegativeSafeInt(
  value: number,
  fieldName: string,
): number {
  const checked = assertSafeInt(value, fieldName);
  if (checked < 0) {
    throw new DomainRuleError(
      'NEGATIVE_MONETARY_AMOUNT',
      `${fieldName} must be non-negative.`,
      { fieldName, value: checked },
    );
  }
  return checked;
}

export function assertPositiveSafeInt(value: number, fieldName: string): number {
  const checked = assertSafeInt(value, fieldName);
  if (checked <= 0) {
    throw new DomainRuleError(
      'INVALID_MONETARY_AMOUNT',
      `${fieldName} must be a positive safe integer.`,
      { fieldName, value: checked },
    );
  }
  return checked;
}

export function bigIntToSafeNumber(value: bigint, fieldName: string): number {
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
    throw new DomainRuleError(
      'MONETARY_OVERFLOW',
      `${fieldName} exceeds IEEE-754 safe integer bounds.`,
      { fieldName, value: value.toString() },
    );
  }
  return Number(value);
}

export function checkedAdd(a: number, b: number, fieldName: string): number {
  assertSafeInt(a, `${fieldName}.lhs`);
  assertSafeInt(b, `${fieldName}.rhs`);
  return bigIntToSafeNumber(BigInt(a) + BigInt(b), fieldName);
}

export function checkedSub(a: number, b: number, fieldName: string): number {
  assertSafeInt(a, `${fieldName}.lhs`);
  assertSafeInt(b, `${fieldName}.rhs`);
  return bigIntToSafeNumber(BigInt(a) - BigInt(b), fieldName);
}

export function sumNonNegativeSafeInts(
  values: readonly number[],
  fieldName: string,
): number {
  let total = 0n;
  for (let i = 0; i < values.length; i += 1) {
    const val = assertNonNegativeSafeInt(values[i]!, `${fieldName}[${i}]`);
    total += BigInt(val);
  }
  return bigIntToSafeNumber(total, fieldName);
}

export function sumSignedSafeInts(
  values: readonly number[],
  fieldName: string,
): number {
  let total = 0n;
  for (let i = 0; i < values.length; i += 1) {
    const val = assertSafeInt(values[i]!, `${fieldName}[${i}]`);
    total += BigInt(val);
  }
  return bigIntToSafeNumber(total, fieldName);
}

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function parseDecimalToRational(
  value: number | string,
  fieldName: string,
): Rational {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DomainRuleError(
        'INVALID_DECIMAL_RATE',
        `${fieldName} must be a finite number.`,
        { fieldName, value },
      );
    }
  } else if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainRuleError(
      'INVALID_DECIMAL_RATE',
      `${fieldName} must be a valid decimal string.`,
      { fieldName, value },
    );
  }

  const raw = (typeof value === 'number' ? value.toString() : value).trim();
  const match = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
    raw,
  );
  if (!match) {
    throw new DomainRuleError(
      'INVALID_DECIMAL_RATE',
      `${fieldName} is not a valid decimal representation.`,
      { fieldName, value },
    );
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? match[4] ?? '';
  const exp = match[5] !== undefined ? Number.parseInt(match[5], 10) : 0;
  if (!Number.isSafeInteger(exp)) {
    throw new DomainRuleError(
      'INVALID_DECIMAL_RATE',
      `${fieldName} exponent out of range.`,
      { fieldName, value },
    );
  }

  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '') || '0';
  const baseScale = fracPart.length;
  const netExp = exp - baseScale;

  if (digits === '0') {
    return { num: 0n, den: 1n };
  }

  if (netExp >= 0) {
    return {
      num: sign * BigInt(digits) * 10n ** BigInt(netExp),
      den: 1n,
    };
  }

  return {
    num: sign * BigInt(digits),
    den: 10n ** BigInt(-netExp),
  };
}

export function addRationals(a: Rational, b: Rational): Rational {
  return {
    num: a.num * b.den + b.num * a.den,
    den: a.den * b.den,
  };
}

export function subtractRationals(a: Rational, b: Rational): Rational {
  return {
    num: a.num * b.den - b.num * a.den,
    den: a.den * b.den,
  };
}

export function multiplyRationals(a: Rational, b: Rational): Rational {
  return {
    num: a.num * b.num,
    den: a.den * b.den,
  };
}

export function divideBigIntHalfUp(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n) {
    throw new DomainRuleError(
      'INVALID_DECIMAL_RATE',
      'Denominator must be strictly positive.',
    );
  }
  if (numerator >= 0n) {
    return (numerator * 2n + denominator) / (2n * denominator);
  }
  const absNum = -numerator;
  return -((absNum * 2n + denominator) / (2n * denominator));
}

export function divideBigIntCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new DomainRuleError(
      'INVALID_DECIMAL_RATE',
      'Denominator must be strictly positive.',
    );
  }
  if (numerator >= 0n) {
    return (numerator + denominator - 1n) / denominator;
  }
  return numerator / denominator;
}

export function multiplyMinorByRationalHalfUp(
  amountMinor: number,
  num: bigint,
  den: bigint,
  fieldName = 'amountMinor',
): number {
  const checked = assertSafeInt(amountMinor, fieldName);
  const rounded = divideBigIntHalfUp(BigInt(checked) * num, den);
  return bigIntToSafeNumber(rounded, fieldName);
}

export function multiplyMinorByRateHalfUp(
  amountMinor: number,
  rate: number,
  fieldName = 'amountMinor',
): number {
  const rational = parseDecimalToRational(rate, `${fieldName}.rate`);
  return multiplyMinorByRationalHalfUp(
    amountMinor,
    rational.num,
    rational.den,
    fieldName,
  );
}

export function multiplyMinorByBpsHalfUp(
  amountMinor: number,
  bps: number,
  fieldName = 'amountMinor',
): number {
  if (
    typeof bps !== 'number' ||
    !Number.isFinite(bps) ||
    !Number.isSafeInteger(bps) ||
    bps < 0
  ) {
    throw new DomainRuleError(
      'INVALID_BASIS_POINTS',
      `${fieldName}.bps must be a non-negative safe integer.`,
      { fieldName, bps },
    );
  }
  return multiplyMinorByRationalHalfUp(
    amountMinor,
    BigInt(bps),
    10_000n,
    fieldName,
  );
}

export function parseUtcDate(value: Date | string, fieldName: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DomainRuleError(
      'INVALID_TIMESTAMP',
      `${fieldName} must be a valid timestamp.`,
      { fieldName },
    );
  }
  return date;
}

export interface EvaluateCfoOverrideResult {
  readonly requested: boolean;
  readonly valid: boolean;
  readonly audit: CfoOverrideAuditFact;
  readonly failureCode: 'CFO_OVERRIDE_REASON_REQUIRED' | 'CFO_OVERRIDE_UNAUTHORIZED' | null;
}

/**
 * Validates trusted server-authenticated CFO override context.
 * A bare boolean (`{ approved: true }`) without authenticated approver identity
 * and a non-blank reason note is never sufficient.
 */
export function evaluateCfoOverride(
  actor: ActorContext | undefined,
  cfoOverride: TrustedCfoApprovalInput | null | undefined,
  options?: { readonly allowDirectCfoExecutionWithoutEnvelope?: boolean },
): EvaluateCfoOverrideResult {
  if (!cfoOverride) {
    if (
      options?.allowDirectCfoExecutionWithoutEnvelope &&
      actor?.actorRole === 'ARCHITECT_CFO' &&
      isNonEmptyTrimmedString(actor.actorUserId)
    ) {
      return {
        requested: true,
        valid: true,
        audit: {
          overrideApplied: true,
          approvedById: actor.actorUserId.trim(),
          reasonNote: null,
        },
        failureCode: null,
      };
    }
    return {
      requested: false,
      valid: false,
      audit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
      failureCode: null,
    };
  }

  if (cfoOverride.approved !== true) {
    return {
      requested: false,
      valid: false,
      audit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
      failureCode: null,
    };
  }

  if (
    cfoOverride.approverRole !== undefined &&
    cfoOverride.approverRole !== 'ARCHITECT_CFO'
  ) {
    return {
      requested: true,
      valid: false,
      audit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
      failureCode: 'CFO_OVERRIDE_UNAUTHORIZED',
    };
  }

  if (!isNonEmptyTrimmedString(cfoOverride.approvedById)) {
    return {
      requested: true,
      valid: false,
      audit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
      failureCode: 'CFO_OVERRIDE_UNAUTHORIZED',
    };
  }

  const trimmedApproverId = cfoOverride.approvedById.trim();
  if (
    actor &&
    actor.actorRole !== 'ARCHITECT_CFO' &&
    trimmedApproverId === actor.actorUserId.trim()
  ) {
    return {
      requested: true,
      valid: false,
      audit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
      failureCode: 'CFO_OVERRIDE_UNAUTHORIZED',
    };
  }

  if (!isNonEmptyTrimmedString(cfoOverride.reasonNote)) {
    return {
      requested: true,
      valid: false,
      audit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
      failureCode: 'CFO_OVERRIDE_REASON_REQUIRED',
    };
  }

  return {
    requested: true,
    valid: true,
    audit: {
      overrideApplied: true,
      approvedById: trimmedApproverId,
      reasonNote: cfoOverride.reasonNote.trim(),
    },
    failureCode: null,
  };
}
