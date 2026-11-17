import { createHash } from 'node:crypto';
import type { AraConditionGradeEnum, AssetCategory } from '@prisma/client';
import {
  checkedAdd,
  computeGradeAdjustedMarketValueCadMinor,
  DomainRuleError,
} from '@/core/domain';
import type { PricingAndCompliancePolicy } from '@/core/ports';
import { validatePublicMediaOrigin } from '@/modules/shared-ops/storage';
import { normalizeCanonicalAraGrade } from './ebay-listing-metadata';

export const PRISMA_INT32_MAX = 2_147_483_647 as const;
export const DEFAULT_LOCAL_PUBLIC_MEDIA_ORIGIN =
  'https://cdn.salvage-erp.local' as const;

const LOWERCASE_UUID_RE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL_UPLOAD_MEDIA_KEY_RE = new RegExp(
  `^(${LOWERCASE_UUID_RE})\\/media\\/${LOWERCASE_UUID_RE}\\.webp$`,
);
const LEGACY_SEED_CLEAN_KEY_RE = new RegExp(
  `^(${LOWERCASE_UUID_RE})\\/parts\\/(PRT-\\d{6})\\/clean-([1-9]\\d*)\\.webp$`,
);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const FITMENT_DELIMITER_RE = /[|=;\r\n\u0000-\u001f\u007f]/;

export type ResolvedPriceSource =
  | 'EXPLICIT_PART_RETAIL'
  | 'GRADE_ADJUSTED_COMPARABLE'
  | 'VEHICLE_TARGET'
  | 'VEHICLE_COST_PLUS_MIN_PROFIT';

export interface ResolvedPrice {
  readonly amountCadMinor: number;
  readonly source: ResolvedPriceSource;
  readonly policyHash: string;
  readonly sourceInputs: Readonly<Record<string, unknown>>;
}

export function computePolicySnapshotHash(
  policy: Pick<
    PricingAndCompliancePolicy,
    | 'araGradeMultipliers'
    | 'marginsAndCommissions'
    | 'checkoutPolicy'
    | 'domesticSyndication'
    | 'domesticTaxPolicy'
    | 'domesticChannelFees'
  >,
): string {
  const canonical = JSON.stringify({
    araGradeMultipliers: policy.araGradeMultipliers,
    marginsAndCommissions: policy.marginsAndCommissions,
    checkoutPolicy: policy.checkoutPolicy,
    domesticSyndication: policy.domesticSyndication,
    domesticTaxPolicy: policy.domesticTaxPolicy,
    domesticChannelFees: policy.domesticChannelFees,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function assertPositivePrismaInt(value: number, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > PRISMA_INT32_MAX
  ) {
    throw new DomainRuleError(
      'INVALID_MONETARY_AMOUNT',
      `${fieldName} must be a positive 32-bit integer minor-unit amount.`,
      { fieldName, value },
    );
  }
  return value;
}

function assertNonNegativePrismaInt(value: number, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PRISMA_INT32_MAX
  ) {
    throw new DomainRuleError(
      'INVALID_MONETARY_AMOUNT',
      `${fieldName} must be a non-negative 32-bit integer minor-unit amount.`,
      { fieldName, value },
    );
  }
  return value;
}

/**
 * Shared price resolver for eBay CSV, B2B Powertrain, LocalAdPayload, lookup, and domestic checkout (Finding 1).
 */
export function resolvePartPrice(
  part: {
    readonly retailPriceCadMinor: number | null;
    readonly compBaselineCadMinor: number | null;
    readonly araGrade: string;
  },
  policy: PricingAndCompliancePolicy,
): ResolvedPrice {
  const policyHash = computePolicySnapshotHash(policy);

  if (part.retailPriceCadMinor !== null && part.retailPriceCadMinor !== undefined) {
    if (
      typeof part.retailPriceCadMinor !== 'number' ||
      !Number.isFinite(part.retailPriceCadMinor) ||
      !Number.isSafeInteger(part.retailPriceCadMinor) ||
      part.retailPriceCadMinor < 0 ||
      part.retailPriceCadMinor > PRISMA_INT32_MAX
    ) {
      throw new DomainRuleError(
        'INVALID_MONETARY_AMOUNT',
        'Part.retailPriceCadMinor must be a non-negative 32-bit safe integer when present.',
        { retailPriceCadMinor: part.retailPriceCadMinor },
      );
    }
    if (part.retailPriceCadMinor > 0) {
      return {
        amountCadMinor: part.retailPriceCadMinor,
        source: 'EXPLICIT_PART_RETAIL',
        policyHash,
        sourceInputs: {
          retailPriceCadMinor: part.retailPriceCadMinor,
        },
      };
    }
  }

  if (
    part.compBaselineCadMinor === null ||
    part.compBaselineCadMinor === undefined ||
    typeof part.compBaselineCadMinor !== 'number' ||
    !Number.isFinite(part.compBaselineCadMinor) ||
    !Number.isSafeInteger(part.compBaselineCadMinor) ||
    part.compBaselineCadMinor <= 0 ||
    part.compBaselineCadMinor > PRISMA_INT32_MAX
  ) {
    throw new DomainRuleError(
      'PART_PRICE_BASELINE_REQUIRED' as never,
      'Part requires either a positive retailPriceCadMinor or a positive compBaselineCadMinor.',
      {
        retailPriceCadMinor: part.retailPriceCadMinor,
        compBaselineCadMinor: part.compBaselineCadMinor,
      },
    );
  }

  const canonicalGrade: AraConditionGradeEnum = normalizeCanonicalAraGrade(
    part.araGrade,
  );
  const multiplier = policy.araGradeMultipliers[canonicalGrade];
  const computed = computeGradeAdjustedMarketValueCadMinor(
    part.compBaselineCadMinor,
    canonicalGrade,
    policy,
  );
  const amountCadMinor = assertPositivePrismaInt(
    computed,
    'gradeAdjustedMarketValueCadMinor',
  );

  return {
    amountCadMinor,
    source: 'GRADE_ADJUSTED_COMPARABLE',
    policyHash,
    sourceInputs: {
      compBaselineCadMinor: part.compBaselineCadMinor,
      rawAraGrade: part.araGrade,
      canonicalAraGrade: canonicalGrade,
      multiplier,
    },
  };
}

/**
 * Shared vehicle floor-price resolver for RETAIL_LOT_VEHICLE_SALE (Finding 1).
 * Never queries or fabricates Vehicle.retailPriceCadMinor.
 */
export function resolveVehiclePrice(
  vehicle: {
    readonly targetGrossRealizationMinor: number;
    readonly actualPurchasePriceCadMinor: number;
    readonly estimatedRepairCadMinor: number;
  },
  policy: PricingAndCompliancePolicy,
): ResolvedPrice {
  const policyHash = computePolicySnapshotHash(policy);
  const target = assertNonNegativePrismaInt(
    vehicle.targetGrossRealizationMinor,
    'targetGrossRealizationMinor',
  );
  if (target > 0) {
    return {
      amountCadMinor: target,
      source: 'VEHICLE_TARGET',
      policyHash,
      sourceInputs: {
        targetGrossRealizationMinor: target,
      },
    };
  }

  const purchase = assertNonNegativePrismaInt(
    vehicle.actualPurchasePriceCadMinor,
    'actualPurchasePriceCadMinor',
  );
  const repair = assertNonNegativePrismaInt(
    vehicle.estimatedRepairCadMinor,
    'estimatedRepairCadMinor',
  );
  const minProfit = assertNonNegativePrismaInt(
    policy.marginsAndCommissions.minBeaterNetProfitCadMinor,
    'minBeaterNetProfitCadMinor',
  );

  const costPlusRepair = checkedAdd(purchase, repair, 'vehicleCostPlusRepair');
  const floorMinor = assertPositivePrismaInt(
    checkedAdd(costPlusRepair, minProfit, 'vehicleFloorPriceCadMinor'),
    'vehicleFloorPriceCadMinor',
  );

  return {
    amountCadMinor: floorMinor,
    source: 'VEHICLE_COST_PLUS_MIN_PROFIT',
    policyHash,
    sourceInputs: {
      actualPurchasePriceCadMinor: purchase,
      estimatedRepairCadMinor: repair,
      minBeaterNetProfitCadMinor: minProfit,
    },
  };
}

export type PublicMediaAssetClassification =
  | 'CANONICAL_SANITIZED_WEBP'
  | 'LEGACY_SEED_DECLARED_WEBP'
  | 'MIXED'
  | 'NONE';

export interface ResolvedPublicMedia {
  readonly sanitizedPublicImageUrls: readonly string[];
  readonly sourceArray: 'CLEAN_PHOTO_URLS' | 'RAW_PHOTO_URLS' | 'NONE';
  readonly classification: PublicMediaAssetClassification;
}

function extractAndValidateMediaKey(
  entry: string,
  expectedOrgId: string,
  expectedSku: string,
  validatedOrigin: string,
): {
  readonly normalizedUrl: string;
  readonly kind: 'CANONICAL' | 'LEGACY_SEED';
} {
  if (
    typeof entry !== 'string' ||
    entry.length === 0 ||
    entry !== entry.trim() ||
    CONTROL_CHARS_RE.test(entry) ||
    entry.includes('..') ||
    entry.includes('\\') ||
    entry.includes('%') ||
    entry.includes('?') ||
    entry.includes('#')
  ) {
    throw new DomainRuleError(
      'UNSAFE_PUBLIC_MEDIA_URL' as never,
      'Public media entry contains invalid characters, query/fragment, or traversal tokens.',
    );
  }

  let keyPart = entry;
  if (entry.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new DomainRuleError(
        'UNSAFE_PUBLIC_MEDIA_URL' as never,
        'Public media absolute URL is malformed.',
      );
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== validatedOrigin
    ) {
      throw new DomainRuleError(
        'UNSAFE_PUBLIC_MEDIA_URL' as never,
        'Public media URL origin, protocol, credentials, or query/fragment is untrusted.',
      );
    }
    keyPart = parsed.pathname.replace(/^\/+/, '');
    if (parsed.pathname.includes('//') || parsed.pathname.includes('/./')) {
      throw new DomainRuleError(
        'UNSAFE_PUBLIC_MEDIA_URL' as never,
        'Public media URL contains unsafe path segments.',
      );
    }
  }

  const normalizedOrg = expectedOrgId.toLowerCase();
  const normalizedSku = expectedSku.trim().toUpperCase();

  const canonicalMatch = CANONICAL_UPLOAD_MEDIA_KEY_RE.exec(keyPart);
  if (canonicalMatch) {
    if (canonicalMatch[1]!.toLowerCase() !== normalizedOrg) {
      throw new DomainRuleError(
        'UNSAFE_PUBLIC_MEDIA_URL' as never,
        'Public media key belongs to a different organization.',
      );
    }
    return {
      normalizedUrl: `${validatedOrigin}/${keyPart}`,
      kind: 'CANONICAL',
    };
  }

  const legacyMatch = LEGACY_SEED_CLEAN_KEY_RE.exec(keyPart);
  if (legacyMatch) {
    if (legacyMatch[1]!.toLowerCase() !== normalizedOrg) {
      throw new DomainRuleError(
        'UNSAFE_PUBLIC_MEDIA_URL' as never,
        'Legacy seed media key belongs to a different organization.',
      );
    }
    if (legacyMatch[2]!.toUpperCase() !== normalizedSku) {
      throw new DomainRuleError(
        'UNSAFE_PUBLIC_MEDIA_URL' as never,
        'Legacy seed media key SKU does not match part qrSkuCode.',
      );
    }
    return {
      normalizedUrl: `${validatedOrigin}/${keyPart}`,
      kind: 'LEGACY_SEED',
    };
  }

  throw new DomainRuleError(
    'UNSAFE_PUBLIC_MEDIA_URL' as never,
    'Public media key does not match canonical sanitized WebP or legacy seed clean WebP contracts.',
  );
}

/**
 * Deterministic public-media resolver (Finding 2).
 * Prefers `cleanPhotoUrls` when non-empty; otherwise validates `rawPhotoUrls`
 * strictly under the sanitized WebP contract. Never silently falls back from
 * an invalid `cleanPhotoUrls` entry to `rawPhotoUrls`.
 */
export function resolvePartPublicMediaUrls(input: {
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly cleanPhotoUrls: readonly string[];
  readonly rawPhotoUrls: readonly string[];
  readonly publicMediaOrigin?: string;
}): ResolvedPublicMedia {
  const validatedOrigin = validatePublicMediaOrigin(
    input.publicMediaOrigin ?? DEFAULT_LOCAL_PUBLIC_MEDIA_ORIGIN,
  );

  const hasClean = input.cleanPhotoUrls.length > 0;
  const candidateArray = hasClean ? input.cleanPhotoUrls : input.rawPhotoUrls;
  const sourceArray: ResolvedPublicMedia['sourceArray'] = hasClean
    ? 'CLEAN_PHOTO_URLS'
    : input.rawPhotoUrls.length > 0
      ? 'RAW_PHOTO_URLS'
      : 'NONE';

  if (candidateArray.length === 0) {
    return {
      sanitizedPublicImageUrls: [],
      sourceArray: 'NONE',
      classification: 'NONE',
    };
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  let sawCanonical = false;
  let sawLegacy = false;

  for (const entry of candidateArray) {
    const validated = extractAndValidateMediaKey(
      entry,
      input.organizationId,
      input.qrSkuCode,
      validatedOrigin,
    );
    if (validated.kind === 'CANONICAL') {
      sawCanonical = true;
    } else {
      sawLegacy = true;
    }
    if (!seen.has(validated.normalizedUrl)) {
      seen.add(validated.normalizedUrl);
      urls.push(validated.normalizedUrl);
    }
  }

  const classification: PublicMediaAssetClassification =
    sawCanonical && sawLegacy
      ? 'MIXED'
      : sawCanonical
        ? 'CANONICAL_SANITIZED_WEBP'
        : 'LEGACY_SEED_DECLARED_WEBP';

  return {
    sanitizedPublicImageUrls: urls,
    sourceArray,
    classification,
  };
}

export interface NormalizedVehicleFitmentTuple {
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engine: string | null;
}

export type FitmentResolutionSource =
  | 'DECLARED_COMPATIBILITY'
  | 'DONOR_VEHICLE_FALLBACK'
  | 'NON_AUTOMOBILE_NO_COMPATIBILITY';

export interface ResolvedPartCompatibility {
  readonly compatibleVehicles: readonly NormalizedVehicleFitmentTuple[];
  readonly source: FitmentResolutionSource;
  readonly donorVehicleId: string;
}

const MAX_EXPANDED_YEAR_SPAN = 40;
const MIN_VEHICLE_YEAR = 1900;
const MAX_VEHICLE_YEAR = 2100;

function validateFitmentField(
  raw: unknown,
  fieldName: string,
  required: true,
): string;
function validateFitmentField(
  raw: unknown,
  fieldName: string,
  required: false,
): string | null;
function validateFitmentField(
  raw: unknown,
  fieldName: string,
  required: boolean,
): string | null {
  if (raw === undefined || raw === null) {
    if (required) {
      throw new DomainRuleError(
        'FITMENT_METADATA_REQUIRED' as never,
        `Fitment field "${fieldName}" is required.`,
      );
    }
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainRuleError(
      'INVALID_FITMENT_METADATA' as never,
      `Fitment field "${fieldName}" must be a string.`,
    );
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) {
    if (required) {
      throw new DomainRuleError(
        'FITMENT_METADATA_REQUIRED' as never,
        `Fitment field "${fieldName}" must be non-empty.`,
      );
    }
    return null;
  }
  if (FITMENT_DELIMITER_RE.test(trimmed)) {
    throw new DomainRuleError(
      'INVALID_FITMENT_METADATA' as never,
      `Fitment field "${fieldName}" contains unencodable relationship delimiter or control characters.`,
      { fieldName, value: trimmed },
    );
  }
  return trimmed;
}

function validateFitmentYear(raw: unknown, label: string): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < MIN_VEHICLE_YEAR ||
    raw > MAX_VEHICLE_YEAR
  ) {
    throw new DomainRuleError(
      'INVALID_FITMENT_METADATA' as never,
      `${label} must be an integer year between ${MIN_VEHICLE_YEAR} and ${MAX_VEHICLE_YEAR}.`,
      { label, value: raw },
    );
  }
  return raw;
}

function deduplicateAndSortTuples(
  tuples: readonly NormalizedVehicleFitmentTuple[],
): NormalizedVehicleFitmentTuple[] {
  const seen = new Set<string>();
  const unique: NormalizedVehicleFitmentTuple[] = [];
  for (const t of tuples) {
    const key = `${t.year}\u0001${t.make}\u0001${t.model}\u0001${t.trim ?? ''}\u0001${t.engine ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(t);
    }
  }
  unique.sort(
    (a, b) =>
      a.year - b.year ||
      a.make.localeCompare(b.make) ||
      a.model.localeCompare(b.model) ||
      (a.trim ?? '').localeCompare(b.trim ?? '') ||
      (a.engine ?? '').localeCompare(b.engine ?? ''),
  );
  return unique;
}

/**
 * Resolves and validates eBay Compatibility tuples (Finding 3).
 * Decodes explicit `ebayCompatibilityJson` when non-empty; otherwise falls back
 * strictly to own `donorVehicle` identity on `AUTOMOBILE` donors.
 */
export function resolvePartCompatibility(input: {
  readonly ebayCompatibilityJson: unknown;
  readonly donorVehicle: {
    readonly id: string;
    readonly assetCategory: AssetCategory;
    readonly year: number;
    readonly make: string;
    readonly model: string;
    readonly trim: string | null;
    readonly engineSpec: string | null;
  };
}): ResolvedPartCompatibility {
  const rawCompat = input.ebayCompatibilityJson;

  if (rawCompat !== null && rawCompat !== undefined) {
    let entries: unknown[];
    if (Array.isArray(rawCompat)) {
      entries = rawCompat;
    } else if (
      typeof rawCompat === 'object' &&
      !Array.isArray(rawCompat) &&
      Array.isArray((rawCompat as Record<string, unknown>).vehicles)
    ) {
      entries = (rawCompat as Record<string, unknown>).vehicles as unknown[];
    } else {
      throw new DomainRuleError(
        'INVALID_FITMENT_METADATA' as never,
        'ebayCompatibilityJson must be an array or { vehicles: [...] }.',
      );
    }

    if (entries.length > 0) {
      const expanded: NormalizedVehicleFitmentTuple[] = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new DomainRuleError(
            'INVALID_FITMENT_METADATA' as never,
            'Each compatibility entry must be a vehicle tuple object.',
          );
        }
        const rec = entry as Record<string, unknown>;
        const make = validateFitmentField(rec.make, 'make', true);
        const model = validateFitmentField(rec.model, 'model', true);
        const trim = validateFitmentField(rec.trim, 'trim', false);
        const engine = validateFitmentField(
          rec.engine !== undefined ? rec.engine : rec.engineSpec,
          'engine',
          false,
        );

        if (rec.year !== undefined) {
          const year = validateFitmentYear(rec.year, 'year');
          expanded.push({ year, make, model, trim, engine });
        } else if (rec.yearStart !== undefined && rec.yearEnd !== undefined) {
          const start = validateFitmentYear(rec.yearStart, 'yearStart');
          const end = validateFitmentYear(rec.yearEnd, 'yearEnd');
          if (start > end || end - start > MAX_EXPANDED_YEAR_SPAN) {
            throw new DomainRuleError(
              'INVALID_FITMENT_METADATA' as never,
              `Bounded compatibility year range ${start}..${end} is invalid or exceeds ${MAX_EXPANDED_YEAR_SPAN} years.`,
            );
          }
          for (let y = start; y <= end; y += 1) {
            expanded.push({ year: y, make, model, trim, engine });
          }
        } else {
          throw new DomainRuleError(
            'INVALID_FITMENT_METADATA' as never,
            'Compatibility entry requires integer year or bounded yearStart/yearEnd.',
          );
        }
      }

      return {
        compatibleVehicles: deduplicateAndSortTuples(expanded),
        source: 'DECLARED_COMPATIBILITY',
        donorVehicleId: input.donorVehicle.id,
      };
    }
  }

  if (input.donorVehicle.assetCategory !== 'AUTOMOBILE') {
    return {
      compatibleVehicles: [],
      source: 'NON_AUTOMOBILE_NO_COMPATIBILITY',
      donorVehicleId: input.donorVehicle.id,
    };
  }

  const year = validateFitmentYear(input.donorVehicle.year, 'donorVehicle.year');
  const make = validateFitmentField(
    input.donorVehicle.make,
    'donorVehicle.make',
    true,
  );
  const model = validateFitmentField(
    input.donorVehicle.model,
    'donorVehicle.model',
    true,
  );
  const trim = validateFitmentField(
    input.donorVehicle.trim,
    'donorVehicle.trim',
    false,
  );
  const engine = validateFitmentField(
    input.donorVehicle.engineSpec,
    'donorVehicle.engineSpec',
    false,
  );

  return {
    compatibleVehicles: [{ year, make, model, trim, engine }],
    source: 'DONOR_VEHICLE_FALLBACK',
    donorVehicleId: input.donorVehicle.id,
  };
}
