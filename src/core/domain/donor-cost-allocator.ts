import type { AraConditionGradeEnum, ScrapStreamCategory } from '@prisma/client';
import type { PricingAndCompliancePolicy } from '../ports';
import {
  assertNonEmptyTrimmedString,
  assertNonNegativeSafeInt,
  bigIntToSafeNumber,
  checkedAdd,
  checkedSub,
  DomainRuleError,
  multiplyMinorByRateHalfUp,
  multiplyMinorByRationalHalfUp,
  sumNonNegativeSafeInts,
} from './domain-primitives';

const VALID_SCRAP_STREAMS = new Set<ScrapStreamCategory>([
  'CATALYTIC_CONVERTER',
  'ALUMINUM_ALLOY_WHEELS',
  'COPPER_WIRING_HARNESS',
  'ROTORS_AND_BATTERY',
  'BARE_STEEL_SHELL',
]);

export function computeGradeAdjustedMarketValueCadMinor(
  compBaselineCadMinor: number,
  araGrade: AraConditionGradeEnum,
  policy: Pick<PricingAndCompliancePolicy, 'araGradeMultipliers'>,
): number {
  const baseline = assertNonNegativeSafeInt(
    compBaselineCadMinor,
    'compBaselineCadMinor',
  );
  const multiplier = Object.hasOwn(policy.araGradeMultipliers, araGrade)
    ? policy.araGradeMultipliers[araGrade]
    : undefined;
  if (multiplier === undefined) {
    throw new DomainRuleError(
      'INVALID_ARA_GRADE',
      `No ARA multiplier configured for grade "${araGrade}".`,
      { araGrade },
    );
  }
  return multiplyMinorByRateHalfUp(baseline, multiplier, 'compBaselineCadMinor');
}

export interface ProvisionalPartAllocationInput {
  readonly partId: string;
  readonly organizationId?: string;
  readonly donorVehicleId?: string;
  readonly gradeAdjustedMarketValueCadMinor: number;
}

export interface ProvisionalCostBasisInput {
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly actualPurchasePriceCadMinor: number;
  readonly loggedDirectExpensesCadMinor: number;
  readonly targetGrossRealizationMinor: number;
  readonly strippedParts: ReadonlyArray<ProvisionalPartAllocationInput>;
}

export interface PartCostAllocationRow {
  readonly partId: string;
  readonly allocatedCostBasisCadMinor: number;
}

export interface ProvisionalCostBasisResult {
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly totalAcquisitionAndStripCostCadMinor: number;
  readonly denominatorCadMinor: number;
  readonly sumStrippedMarketValueCadMinor: number;
  readonly allocations: readonly PartCostAllocationRow[];
  readonly totalAllocatedCadMinor: number;
}

function validatePartIdentityAndScope(
  part: {
    readonly partId: string;
    readonly organizationId?: string;
    readonly donorVehicleId?: string;
  },
  expectedOrgId: string,
  expectedDonorId: string,
  seenPartIds: Set<string>,
): string {
  const partId = assertNonEmptyTrimmedString(
    part.partId,
    'INVALID_INPUT',
    'partId must be a non-empty string.',
  );
  if (seenPartIds.has(partId)) {
    throw new DomainRuleError(
      'DUPLICATE_ENTITY_ID',
      `Duplicate partId "${partId}" in donor cost allocation.`,
      { partId },
    );
  }
  seenPartIds.add(partId);

  if (
    part.organizationId !== undefined &&
    part.organizationId.trim() !== expectedOrgId
  ) {
    throw new DomainRuleError(
      'ORGANIZATION_MISMATCH',
      `Part "${partId}" belongs to a different organization.`,
      { partId },
    );
  }
  if (
    part.donorVehicleId !== undefined &&
    part.donorVehicleId.trim() !== expectedDonorId
  ) {
    throw new DomainRuleError(
      'DONOR_VEHICLE_MISMATCH',
      `Part "${partId}" belongs to a different donor vehicle.`,
      { partId },
    );
  }
  return partId;
}

/**
 * Stage 1 Provisional Cost Basis Calculator (DOMAIN-RULES.md §4.4.1).
 */
export function computeProvisionalCostBasis(
  input: ProvisionalCostBasisInput,
): ProvisionalCostBasisResult {
  const orgId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const donorId = assertNonEmptyTrimmedString(
    input.donorVehicleId,
    'INVALID_INPUT',
    'donorVehicleId is required.',
  );
  const purchase = assertNonNegativeSafeInt(
    input.actualPurchasePriceCadMinor,
    'actualPurchasePriceCadMinor',
  );
  const directExpenses = assertNonNegativeSafeInt(
    input.loggedDirectExpensesCadMinor,
    'loggedDirectExpensesCadMinor',
  );
  const targetGross = assertNonNegativeSafeInt(
    input.targetGrossRealizationMinor,
    'targetGrossRealizationMinor',
  );

  const totalAcquisitionAndStripCostCadMinor = checkedAdd(
    purchase,
    directExpenses,
    'totalAcquisitionAndStripCostCadMinor',
  );

  const seenPartIds = new Set<string>();
  const validatedParts: Array<{ partId: string; marketValue: number }> = [];
  const marketValues: number[] = [];

  for (let i = 0; i < input.strippedParts.length; i += 1) {
    const part = input.strippedParts[i]!;
    const partId = validatePartIdentityAndScope(
      part,
      orgId,
      donorId,
      seenPartIds,
    );
    const marketValue = assertNonNegativeSafeInt(
      part.gradeAdjustedMarketValueCadMinor,
      `strippedParts[${i}].gradeAdjustedMarketValueCadMinor`,
    );
    validatedParts.push({ partId, marketValue });
    marketValues.push(marketValue);
  }

  const sumStrippedMarketValueCadMinor = sumNonNegativeSafeInts(
    marketValues,
    'sumStrippedMarketValueCadMinor',
  );
  const denominatorCadMinor = Math.max(
    targetGross,
    sumStrippedMarketValueCadMinor,
  );

  if (denominatorCadMinor <= 0) {
    throw new DomainRuleError(
      'ZERO_ALLOCATION_DENOMINATOR',
      'max(targetGrossRealizationMinor, sumStrippedMarketValueCadMinor) must be positive.',
    );
  }

  const denominatorBigInt = BigInt(denominatorCadMinor);
  const allocations: PartCostAllocationRow[] = validatedParts.map((part) => ({
    partId: part.partId,
    allocatedCostBasisCadMinor: multiplyMinorByRationalHalfUp(
      totalAcquisitionAndStripCostCadMinor,
      BigInt(part.marketValue),
      denominatorBigInt,
      `allocation(${part.partId})`,
    ),
  }));

  const totalAllocatedCadMinor = sumNonNegativeSafeInts(
    allocations.map((a) => a.allocatedCostBasisCadMinor),
    'totalAllocatedCadMinor',
  );

  return {
    organizationId: orgId,
    donorVehicleId: donorId,
    totalAcquisitionAndStripCostCadMinor,
    denominatorCadMinor,
    sumStrippedMarketValueCadMinor,
    allocations,
    totalAllocatedCadMinor,
  };
}

export interface ScrapRecoveryLogEntry {
  readonly id: string;
  readonly organizationId?: string;
  readonly donorVehicleId: string;
  readonly stream: ScrapStreamCategory;
  readonly payoutCadMinor: number;
}

export interface LockedSoldPartCostInput {
  readonly partId: string;
  readonly organizationId?: string;
  readonly donorVehicleId?: string;
  readonly lockedAllocatedCostBasisCadMinor: number;
}

export interface UnsoldPartCostTrueUpInput {
  readonly partId: string;
  readonly organizationId?: string;
  readonly donorVehicleId?: string;
  readonly gradeAdjustedMarketValueCadMinor: number;
}

export interface Stage2DonorCostTrueUpInput {
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly actualPurchasePriceCadMinor: number;
  readonly loggedDirectExpensesCadMinor: number;
  readonly scrapLogs: ReadonlyArray<ScrapRecoveryLogEntry>;
  readonly soldParts: ReadonlyArray<LockedSoldPartCostInput>;
  readonly unsoldParts: ReadonlyArray<UnsoldPartCostTrueUpInput>;
}

export type ScrapByStreamCadMinor = Readonly<
  Record<ScrapStreamCategory, number>
>;

export interface Stage2DonorCostTrueUpResult {
  readonly organizationId: string;
  readonly donorVehicleId: string;
  readonly totalAcquisitionAndStripCostCadMinor: number;
  readonly scrapRecoveryCadMinor: number;
  readonly scrapByStream: ScrapByStreamCadMinor;
  readonly lockedSoldCostBasisCadMinor: number;
  readonly remainingCostBasisToAllocateCadMinor: number;
  readonly soldAllocations: readonly PartCostAllocationRow[];
  readonly unsoldAllocations: readonly PartCostAllocationRow[];
  readonly reconciledTotalCadMinor: number;
}

/**
 * Stage 2 Incremental & Final Donor Cost Basis True-Up (DOMAIN-RULES.md §4.4.1).
 *
 * Uses largest-remainder (Hamilton) allocation with deterministic ascending `partId`
 * tie-breaking so repeated calls and reordered unsold arrays always produce identical
 * cent allocations per `partId`, satisfying:
 *   sum(part.allocatedCostBasisCadMinor) + scrapRecoveryCadMinor === totalAcquisitionAndStripCostCadMinor.
 *
 *Note: `totalAcquisitionAndStripCostCadMinor` is a computed domain aggregate rather than
 * a persisted column on `salvage.Vehicle`.
 */
export function trueUpDonorCostBasis(
  input: Stage2DonorCostTrueUpInput,
): Stage2DonorCostTrueUpResult {
  const orgId = assertNonEmptyTrimmedString(
    input.organizationId,
    'INVALID_INPUT',
    'organizationId is required.',
  );
  const donorId = assertNonEmptyTrimmedString(
    input.donorVehicleId,
    'INVALID_INPUT',
    'donorVehicleId is required.',
  );
  const purchase = assertNonNegativeSafeInt(
    input.actualPurchasePriceCadMinor,
    'actualPurchasePriceCadMinor',
  );
  const directExpenses = assertNonNegativeSafeInt(
    input.loggedDirectExpensesCadMinor,
    'loggedDirectExpensesCadMinor',
  );
  const totalAcquisitionAndStripCostCadMinor = checkedAdd(
    purchase,
    directExpenses,
    'totalAcquisitionAndStripCostCadMinor',
  );

  const seenScrapIds = new Set<string>();
  const scrapByStreamMut: Record<ScrapStreamCategory, number> = {
    CATALYTIC_CONVERTER: 0,
    ALUMINUM_ALLOY_WHEELS: 0,
    COPPER_WIRING_HARNESS: 0,
    ROTORS_AND_BATTERY: 0,
    BARE_STEEL_SHELL: 0,
  };
  const scrapPayouts: number[] = [];

  for (let i = 0; i < input.scrapLogs.length; i += 1) {
    const log = input.scrapLogs[i]!;
    const scrapId = assertNonEmptyTrimmedString(
      log.id,
      'INVALID_INPUT',
      `scrapLogs[${i}].id must be non-empty.`,
    );
    if (seenScrapIds.has(scrapId)) {
      throw new DomainRuleError(
        'DUPLICATE_ENTITY_ID',
        `Duplicate scrap log id "${scrapId}".`,
        { scrapId },
      );
    }
    seenScrapIds.add(scrapId);

    if (
      log.organizationId !== undefined &&
      log.organizationId.trim() !== orgId
    ) {
      throw new DomainRuleError(
        'ORGANIZATION_MISMATCH',
        `Scrap log "${scrapId}" belongs to a different organization.`,
      );
    }
    if (log.donorVehicleId.trim() !== donorId) {
      throw new DomainRuleError(
        'DONOR_VEHICLE_MISMATCH',
        `Scrap log "${scrapId}" belongs to a different donor vehicle.`,
      );
    }
    if (!VALID_SCRAP_STREAMS.has(log.stream)) {
      throw new DomainRuleError(
        'INVALID_SCRAP_STREAM',
        `Invalid scrap stream "${String(log.stream)}".`,
      );
    }
    const payout = assertNonNegativeSafeInt(
      log.payoutCadMinor,
      `scrapLogs[${i}].payoutCadMinor`,
    );
    scrapByStreamMut[log.stream] = checkedAdd(
      scrapByStreamMut[log.stream],
      payout,
      `scrapByStream.${log.stream}`,
    );
    scrapPayouts.push(payout);
  }

  const scrapRecoveryCadMinor = sumNonNegativeSafeInts(
    scrapPayouts,
    'scrapRecoveryCadMinor',
  );

  const seenPartIds = new Set<string>();
  const soldAllocations: PartCostAllocationRow[] = [];
  const soldCosts: number[] = [];

  for (let i = 0; i < input.soldParts.length; i += 1) {
    const sold = input.soldParts[i]!;
    const partId = validatePartIdentityAndScope(
      sold,
      orgId,
      donorId,
      seenPartIds,
    );
    const lockedCost = assertNonNegativeSafeInt(
      sold.lockedAllocatedCostBasisCadMinor,
      `soldParts[${i}].lockedAllocatedCostBasisCadMinor`,
    );
    soldAllocations.push({
      partId,
      allocatedCostBasisCadMinor: lockedCost,
    });
    soldCosts.push(lockedCost);
  }

  const lockedSoldCostBasisCadMinor = sumNonNegativeSafeInts(
    soldCosts,
    'lockedSoldCostBasisCadMinor',
  );

  const unsoldItems: Array<{ partId: string; weight: number }> = [];
  const unsoldWeights: number[] = [];

  for (let i = 0; i < input.unsoldParts.length; i += 1) {
    const unsold = input.unsoldParts[i]!;
    const partId = validatePartIdentityAndScope(
      unsold,
      orgId,
      donorId,
      seenPartIds,
    );
    const weight = assertNonNegativeSafeInt(
      unsold.gradeAdjustedMarketValueCadMinor,
      `unsoldParts[${i}].gradeAdjustedMarketValueCadMinor`,
    );
    unsoldItems.push({ partId, weight });
    unsoldWeights.push(weight);
  }

  const scrapPlusSold = checkedAdd(
    scrapRecoveryCadMinor,
    lockedSoldCostBasisCadMinor,
    'scrapPlusLockedSold',
  );
  const remainingCostBasisToAllocateCadMinor = checkedSub(
    totalAcquisitionAndStripCostCadMinor,
    scrapPlusSold,
    'remainingCostBasisToAllocateCadMinor',
  );

  if (remainingCostBasisToAllocateCadMinor < 0) {
    throw new DomainRuleError(
      'DONOR_COST_RECONCILIATION_EXCEEDED',
      'Scrap recovery plus locked sold part cost exceeds total donor acquisition and strip cost.',
      {
        totalAcquisitionAndStripCostCadMinor,
        scrapRecoveryCadMinor,
        lockedSoldCostBasisCadMinor,
      },
    );
  }

  const allocatedMap = new Map<string, number>();

  if (remainingCostBasisToAllocateCadMinor === 0) {
    for (const item of unsoldItems) {
      allocatedMap.set(item.partId, 0);
    }
  } else {
    const totalUnsoldWeight = sumNonNegativeSafeInts(
      unsoldWeights,
      'totalUnsoldWeight',
    );
    if (unsoldItems.length === 0 || totalUnsoldWeight <= 0) {
      throw new DomainRuleError(
        'NO_ELIGIBLE_UNSOLD_PARTS_FOR_RECONCILIATION',
        'Non-zero remaining donor cost basis requires at least one unsold part with positive grade-adjusted market value.',
        { remainingCostBasisToAllocateCadMinor },
      );
    }

    // Sort canonically by partId so allocation per partId is invariant under input order
    const canonical = [...unsoldItems].sort((a, b) =>
      a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0,
    );

    const remainingBig = BigInt(remainingCostBasisToAllocateCadMinor);
    const totalWeightBig = BigInt(totalUnsoldWeight);

    let floorSum = 0n;
    const rows = canonical.map((item) => {
      const numerator = remainingBig * BigInt(item.weight);
      const floorCents = numerator / totalWeightBig;
      const remainder = numerator % totalWeightBig;
      floorSum += floorCents;
      return {
        partId: item.partId,
        floorCents,
        remainder,
      };
    });

    const leftoverCents = Number(remainingBig - floorSum);
    const tieRanked = [...rows].sort((a, b) => {
      if (a.remainder > b.remainder) return -1;
      if (a.remainder < b.remainder) return 1;
      return a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0;
    });

    const bonusPartIds = new Set<string>();
    for (let i = 0; i < leftoverCents; i += 1) {
      bonusPartIds.add(tieRanked[i]!.partId);
    }

    for (const row of rows) {
      const cents =
        row.floorCents + (bonusPartIds.has(row.partId) ? 1n : 0n);
      allocatedMap.set(
        row.partId,
        bigIntToSafeNumber(cents, `allocation(${row.partId})`),
      );
    }
  }

  const unsoldAllocations: PartCostAllocationRow[] = unsoldItems.map(
    (item) => ({
      partId: item.partId,
      allocatedCostBasisCadMinor: allocatedMap.get(item.partId) ?? 0,
    }),
  );

  const unsoldAllocatedTotal = sumNonNegativeSafeInts(
    unsoldAllocations.map((a) => a.allocatedCostBasisCadMinor),
    'unsoldAllocatedTotal',
  );

  const reconciledTotalCadMinor = checkedAdd(
    checkedAdd(
      lockedSoldCostBasisCadMinor,
      unsoldAllocatedTotal,
      'allPartsAllocated',
    ),
    scrapRecoveryCadMinor,
    'reconciledTotalCadMinor',
  );

  return {
    organizationId: orgId,
    donorVehicleId: donorId,
    totalAcquisitionAndStripCostCadMinor,
    scrapRecoveryCadMinor,
    scrapByStream: Object.freeze(scrapByStreamMut),
    lockedSoldCostBasisCadMinor,
    remainingCostBasisToAllocateCadMinor,
    soldAllocations,
    unsoldAllocations,
    reconciledTotalCadMinor,
  };
}
