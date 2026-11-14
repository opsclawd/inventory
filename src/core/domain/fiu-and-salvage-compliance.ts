import type {
  AssetCategory,
  AssetLifecycleState,
  CurrencyCode,
  OperationalLane,
  SaleMarketNode,
  TdgHazmatCode,
} from '@prisma/client';
import type { PricingAndCompliancePolicy } from '../ports';
import {
  type DomainRuleErrorCode,
  DomainRuleError,
  assertNonEmptyTrimmedString,
  assertNonNegativeSafeInt,
  bigIntToSafeNumber,
  isNonEmptyTrimmedString,
  parseUtcDate,
} from './domain-primitives';
import { evaluateRegulatoryComplianceCheck } from './part-state-machine';

const THIRTY_DAYS_MS = 30 * 86_400_000;

export type CompliancePolicySlice = Pick<
  PricingAndCompliancePolicy,
  'complianceThresholds' | 'operationalGates'
>;

export interface FiuSaleCandidate {
  readonly id: string;
  readonly organizationId: string;
  readonly marketNode: SaleMarketNode;
  readonly paymentCurrency: CurrencyCode;
  readonly grossCollectedMinor: number;
  readonly paymentMethod: string;
  readonly buyerName: string | null;
  readonly buyerPhoneE164?: string | null;
  readonly buyerIdDocumentStorageKey?: string | null;
  readonly buyerIdNumberEncrypted?: string | null;
  readonly isVoidedOrReversed: boolean;
  readonly createdAt: string | Date;
}

export interface FiuRollingWindowInput {
  readonly organizationId: string;
  readonly evaluatedAt: string | Date;
  readonly currentSale: FiuSaleCandidate;
  readonly priorSales: readonly FiuSaleCandidate[];
}

export interface FiuRollingWindowResult {
  readonly organizationId: string;
  readonly windowStartUtc: string;
  readonly evaluatedAtUtc: string;
  readonly rollingTotalTtdMinor: number;
  readonly rollingCashTotalTtdMinor: number;
  readonly matchedPriorSaleIds: readonly string[];
  readonly cddRequired: boolean;
  readonly cddSatisfied: boolean;
  readonly largeCashAlertRequired: boolean;
  readonly blockingCodes: readonly DomainRuleErrorCode[];
  readonly warnings: readonly string[];
}

export interface EasrSiteVehicleCandidate {
  readonly id?: string;
  readonly assetCategory: AssetCategory;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
}

export interface EasrElvThresholdInput {
  readonly organizationId: string;
  readonly activeElvVehiclesOnSite: readonly EasrSiteVehicleCandidate[];
  readonly incomingVehicle?: {
    readonly assetCategory: AssetCategory;
    readonly operationalLane: OperationalLane;
  };
}

export interface EasrElvThresholdResult {
  readonly allowed: boolean;
  readonly currentActiveElvCount: number;
  readonly projectedActiveElvCount: number;
  readonly easrThreshold: number;
  readonly easrRegistrationPresent: boolean;
  readonly blockingCodes: readonly DomainRuleErrorCode[];
  readonly warnings: readonly string[];
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (!isNonEmptyTrimmedString(phone)) {
    return null;
  }
  const stripped = phone.replace(/[\s()-]+/g, '');
  return stripped.length > 0 ? stripped : null;
}

function normalizeBuyerName(name: string | null | undefined): string | null {
  if (!isNonEmptyTrimmedString(name)) {
    return null;
  }
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeEncryptedId(
  encryptedId: string | null | undefined,
): string | null {
  if (!isNonEmptyTrimmedString(encryptedId)) {
    return null;
  }
  return encryptedId.trim();
}

function isEligibleFiuRow(
  row: FiuSaleCandidate,
  organizationId: string,
  windowStartMs: number,
  evaluatedAtMs: number,
): boolean {
  if (
    row.organizationId !== organizationId ||
    row.isVoidedOrReversed === true ||
    row.marketNode !== 'DESTINATION_EXPORT_VAULT' ||
    row.paymentCurrency !== 'TTD'
  ) {
    return false;
  }
  const createdAtMs = parseUtcDate(row.createdAt, `sale[${row.id}].createdAt`).getTime();
  return createdAtMs >= windowStartMs && createdAtMs <= evaluatedAtMs;
}

/**
 * Pure Trinidad FIU 30-day rolling linked-transaction evaluator (`RULE-COMP-FIU-01`).
 *
 * OR-matches non-blank normalized `buyerPhoneE164`, `lower(trim(buyerName))`, and
 * `buyerIdNumberEncrypted`, deduplicating by transaction ID and excluding voided,
 * non-TTD, non-vault, cross-organization, future, or expired (`> 30 UTC days`) records.
 */
export function evaluateFiuRollingWindow(
  input: FiuRollingWindowInput,
  policy: CompliancePolicySlice,
): FiuRollingWindowResult {
  const organizationId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const evaluatedAtDate = parseUtcDate(input.evaluatedAt, 'evaluatedAt');
  const evaluatedAtMs = evaluatedAtDate.getTime();
  const windowStartMs = evaluatedAtMs - THIRTY_DAYS_MS;

  const current = input.currentSale;
  const currentId = assertNonEmptyTrimmedString(
    current.id,
    'INVALID_INPUT',
    'currentSale.id is required.',
  );
  if (current.organizationId !== organizationId) {
    throw new DomainRuleError(
      'ORGANIZATION_MISMATCH',
      `currentSale "${currentId}" belongs to "${current.organizationId}", expected "${organizationId}".`,
    );
  }

  const currentAmount = assertNonNegativeSafeInt(
    current.grossCollectedMinor,
    'currentSale.grossCollectedMinor',
  );

  const currPhone = normalizePhone(current.buyerPhoneE164);
  const currName = normalizeBuyerName(current.buyerName);
  const currIdEnc = normalizeEncryptedId(current.buyerIdNumberEncrypted);

  const cddThreshold = assertNonNegativeSafeInt(
    policy.complianceThresholds.trinidadFiuCddThresholdTtdMinor,
    'trinidadFiuCddThresholdTtdMinor',
  );
  const largeCashThreshold = assertNonNegativeSafeInt(
    policy.complianceThresholds.trinidadFiuLargeCashReportTtdMinor,
    'trinidadFiuLargeCashReportTtdMinor',
  );

  const currentCounts = isEligibleFiuRow(
    current,
    organizationId,
    windowStartMs,
    evaluatedAtMs,
  );
  let totalTtd = currentCounts ? BigInt(currentAmount) : 0n;
  let cashTotalTtd =
    currentCounts && current.paymentMethod.trim().toUpperCase() === 'CASH'
      ? BigInt(currentAmount)
      : 0n;

  const seenIds = new Set<string>([currentId]);
  const matchedPriorSaleIds: string[] = [];

  for (const prior of input.priorSales) {
    const priorId = assertNonEmptyTrimmedString(
      prior.id,
      'INVALID_INPUT',
      'priorSale.id is required.',
    );
    if (seenIds.has(priorId)) {
      continue;
    }
    seenIds.add(priorId);

    if (!isEligibleFiuRow(prior, organizationId, windowStartMs, evaluatedAtMs)) {
      continue;
    }

    const priorPhone = normalizePhone(prior.buyerPhoneE164);
    const priorName = normalizeBuyerName(prior.buyerName);
    const priorIdEnc = normalizeEncryptedId(prior.buyerIdNumberEncrypted);

    const matchedByPhone = currPhone !== null && priorPhone === currPhone;
    const matchedByName = currName !== null && priorName === currName;
    const matchedByEncryptedId =
      currIdEnc !== null && priorIdEnc === currIdEnc;

    if (!matchedByPhone && !matchedByName && !matchedByEncryptedId) {
      continue;
    }

    const priorAmt = assertNonNegativeSafeInt(
      prior.grossCollectedMinor,
      `priorSale[${priorId}].grossCollectedMinor`,
    );
    totalTtd += BigInt(priorAmt);
    if (prior.paymentMethod.trim().toUpperCase() === 'CASH') {
      cashTotalTtd += BigInt(priorAmt);
    }
    matchedPriorSaleIds.push(priorId);
  }

  const rollingTotalTtdMinor = bigIntToSafeNumber(
    totalTtd,
    'rollingTotalTtdMinor',
  );
  const rollingCashTotalTtdMinor = bigIntToSafeNumber(
    cashTotalTtd,
    'rollingCashTotalTtdMinor',
  );

  const cddRequired = rollingTotalTtdMinor >= cddThreshold;
  const cddSatisfied =
    !cddRequired ||
    (isNonEmptyTrimmedString(current.buyerName) &&
      isNonEmptyTrimmedString(current.buyerIdDocumentStorageKey) &&
      isNonEmptyTrimmedString(current.buyerIdNumberEncrypted));
  const largeCashAlertRequired = rollingCashTotalTtdMinor >= largeCashThreshold;

  const blockingCodes: DomainRuleErrorCode[] = [];
  if (cddRequired && !cddSatisfied) {
    blockingCodes.push('FIU_CDD_ID_REQUIRED');
  }

  const warnings: string[] = [];
  if (largeCashAlertRequired) {
    warnings.push('FIU_LARGE_CASH_ALERT_REQUIRED');
  }

  return {
    organizationId,
    windowStartUtc: new Date(windowStartMs).toISOString(),
    evaluatedAtUtc: evaluatedAtDate.toISOString(),
    rollingTotalTtdMinor,
    rollingCashTotalTtdMinor,
    matchedPriorSaleIds,
    cddRequired,
    cddSatisfied,
    largeCashAlertRequired,
    blockingCodes,
    warnings,
  };
}

/**
 * Blocks any TDG hazardous-material part or unknown hazmat code from parcel shipping
 * (`422 HAZMAT_PARCEL_SHIPPING_BLOCKED`).
 */
export function assertEbayParcelHazmatEligible(
  tdgHazmatCode: TdgHazmatCode,
): void {
  if (tdgHazmatCode !== 'NONE') {
    throw new DomainRuleError(
      'HAZMAT_PARCEL_SHIPPING_BLOCKED',
      `Part with TDG hazmat code "${String(tdgHazmatCode)}" cannot be shipped via parcel or listed on eBay parcel shipping.`,
      { tdgHazmatCode },
    );
  }
}

function isCountedActiveAutomobileElv(vehicle: {
  readonly assetCategory: AssetCategory;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState?: AssetLifecycleState;
}): boolean {
  if (
    vehicle.assetCategory !== 'AUTOMOBILE' ||
    vehicle.operationalLane !== 'DISMANTLE_AND_EXPORT'
  ) {
    return false;
  }
  return (
    vehicle.lifecycleState !== 'SCRAPPED_METAL_CLEARED' &&
    vehicle.lifecycleState !== 'SOLD_RETAIL_ONTARIO' &&
    vehicle.lifecycleState !== 'SOLD_EXPORT_COD'
  );
}

/**
 * Evaluates Ontario `O. Reg. 85/16` EASR active End-of-Life Vehicle threshold (`> 2` ELVs).
 * Excludes watercraft, shop equipment, and already cleared/sold units.
 */
export function evaluateEasrElvThreshold(
  input: EasrElvThresholdInput,
  policy: CompliancePolicySlice,
): EasrElvThresholdResult {
  assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );

  const easrThreshold = assertNonNegativeSafeInt(
    policy.complianceThresholds.easrActiveElvThreshold,
    'easrActiveElvThreshold',
  );
  const easrRegistrationPresent = isNonEmptyTrimmedString(
    policy.complianceThresholds.easrRegistrationNumber,
  );

  const currentActiveElvCount = input.activeElvVehiclesOnSite.filter((v) =>
    isCountedActiveAutomobileElv(v),
  ).length;

  const incomingAddsElv =
    input.incomingVehicle !== undefined &&
    isCountedActiveAutomobileElv(input.incomingVehicle)
      ? 1
      : 0;
  const projectedActiveElvCount = currentActiveElvCount + incomingAddsElv;

  if (projectedActiveElvCount <= easrThreshold || easrRegistrationPresent) {
    return {
      allowed: true,
      currentActiveElvCount,
      projectedActiveElvCount,
      easrThreshold,
      easrRegistrationPresent,
      blockingCodes: [],
      warnings: [],
    };
  }

  const check = evaluateRegulatoryComplianceCheck(
    policy.operationalGates.complianceEnforcementMode,
    'MISSING_EASR_REGISTRATION_WARNING',
  );

  return {
    allowed: check.allowed,
    currentActiveElvCount,
    projectedActiveElvCount,
    easrThreshold,
    easrRegistrationPresent,
    blockingCodes: check.blockingCodes,
    warnings: check.warnings,
  };
}
