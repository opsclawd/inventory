import type { AssetCategory } from '@prisma/client';
import type { DecodedAssetSpec, IAssetDecoderPort } from '@/core/ports';

const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;
const HIN_REGEX = /^[A-Z0-9]{3}[A-HJ-NPR-Z0-9]{5}[A-L][0-9]{3}$/;
const EQUIPMENT_SERIAL_REGEX = /^[A-Z0-9][A-Z0-9-]{2,62}[A-Z0-9]$/;
const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;

export const DEFAULT_VPIC_BASE_URL =
  'https://vpic.nhtsa.dot.gov/api/vehicles' as const;
export const DEFAULT_DECODER_TIMEOUT_MS = 3_000 as const;

export type AssetDecoderMode = 'LIVE_WITH_OFFLINE_FALLBACK' | 'OFFLINE_ONLY';

export interface ParsedWatercraftHin {
  readonly hin: string;
  readonly mic: string;
  readonly hullSerial: string;
  readonly manufactureMonthCode: string;
  readonly manufactureYearDigit: number;
  readonly modelYear: number;
}

export interface AssetDecoderAdapterOptions {
  readonly assetCategory?: AssetCategory;
  readonly mode?: AssetDecoderMode;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly vpicBaseUrl?: string;
  readonly offlineAdapter?: OfflineAssetDecoderAdapter;
}

interface BundledAssetFixture {
  readonly identifier: string;
  readonly assetCategory: AssetCategory;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly steeringSide: 'LHD_ONLY' | 'RHD_ONLY' | 'UNIVERSAL';
  readonly fixtureLabel: string;
}

/**
 * Deterministic Phase 1A synthetic/test fixtures for offline & headless verification.
 * These are synthetic test descriptors and never represent verified OEM fitment or live vPIC data.
 */
export const BUNDLED_OFFLINE_ASSET_FIXTURES: readonly BundledAssetFixture[] =
  Object.freeze([
    {
      identifier: '5XYP5DHC5LG000001',
      assetCategory: 'AUTOMOBILE',
      year: 2020,
      make: 'Kia',
      model: 'Telluride',
      trim: 'SX AWD',
      engineSpec: '3.8L V6 GDI',
      steeringSide: 'LHD_ONLY',
      fixtureLabel: 'PHASE1A_TEST_FIXTURE_KIA',
    },
    {
      identifier: 'KM8J3CA41LU000001',
      assetCategory: 'AUTOMOBILE',
      year: 2020,
      make: 'Hyundai',
      model: 'Tucson',
      trim: 'SEL AWD',
      engineSpec: '2.4L I4 GDI',
      steeringSide: 'LHD_ONLY',
      fixtureLabel: 'PHASE1A_TEST_FIXTURE_HYUNDAI',
    },
    {
      identifier: 'JM3KFBCM4L0000001',
      assetCategory: 'AUTOMOBILE',
      year: 2020,
      make: 'Mazda',
      model: 'CX-5',
      trim: 'Touring AWD',
      engineSpec: '2.5L Skyactiv-G I4',
      steeringSide: 'LHD_ONLY',
      fixtureLabel: 'PHASE1A_TEST_FIXTURE_MAZDA',
    },
    {
      identifier: 'YAM12345A121',
      assetCategory: 'WATERCRAFT',
      year: 2021,
      make: 'Yamaha',
      model: 'WaveRunner VX Cruiser HO',
      trim: 'HO',
      engineSpec: '1.8L 4-Cyl High Output Marine',
      steeringSide: 'UNIVERSAL',
      fixtureLabel: 'PHASE1A_TEST_FIXTURE_YAMAHA_WATERCRAFT',
    },
    {
      identifier: 'ROB-AC1234-2022-001',
      assetCategory: 'SHOP_EQUIPMENT',
      year: 2022,
      make: 'Robinair',
      model: 'AC1234-4',
      trim: 'R-1234yf Recovery',
      engineSpec: '115V Shop A/C Service Station',
      steeringSide: 'UNIVERSAL',
      fixtureLabel: 'PHASE1A_TEST_FIXTURE_SHOP_EQUIPMENT',
    },
  ]);

const FIXTURE_MAP_BY_CATEGORY: ReadonlyMap<
  string,
  BundledAssetFixture
> = new Map(
  BUNDLED_OFFLINE_ASSET_FIXTURES.map((item) => [
    `${item.assetCategory}:${item.identifier}`,
    item,
  ]),
);

export function normalizeAssetIdentifier(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim().toUpperCase();
}

export function isValidAutomobileVin(vin: string): boolean {
  return VIN_REGEX.test(normalizeAssetIdentifier(vin));
}

export function isValidEquipmentSerial(serial: string): boolean {
  if (typeof serial !== 'string' || CONTROL_CHARS_REGEX.test(serial)) {
    return false;
  }
  const normalized = normalizeAssetIdentifier(serial);
  return (
    normalized.length >= 4 &&
    normalized.length <= 64 &&
    EQUIPMENT_SERIAL_REGEX.test(normalized)
  );
}

/**
 * Parses a standard 12-character USCG/Transport Canada Watercraft Hull Identification Number (HIN).
 * Returns structural metadata (`mic`, `hullSerial`, `manufactureMonthCode`, `modelYear`) or `null`
 * when the format is invalid.
 */
export function parseWatercraftHin(rawHin: string): ParsedWatercraftHin | null {
  const hin = normalizeAssetIdentifier(rawHin);
  if (!HIN_REGEX.test(hin)) {
    return null;
  }
  const mic = hin.slice(0, 3);
  const hullSerial = hin.slice(3, 8);
  const manufactureMonthCode = hin.slice(8, 9);
  const manufactureYearDigit = Number.parseInt(hin.slice(9, 10), 10);
  const modelYearTwoDigits = Number.parseInt(hin.slice(10, 12), 10);
  const modelYear =
    modelYearTwoDigits >= 72 ? 1900 + modelYearTwoDigits : 2000 + modelYearTwoDigits;

  return {
    hin,
    mic,
    hullSerial,
    manufactureMonthCode,
    manufactureYearDigit,
    modelYear,
  };
}

function toFixtureDecodedSpec(
  fixture: BundledAssetFixture,
  parsedHin?: ParsedWatercraftHin | null,
): DecodedAssetSpec {
  return {
    identifier: fixture.identifier,
    assetCategory: fixture.assetCategory,
    year: fixture.year,
    make: fixture.make,
    model: fixture.model,
    trim: fixture.trim,
    engineSpec: fixture.engineSpec,
    steeringSide: fixture.steeringSide,
    rawPayload: {
      source: 'OFFLINE_FIXTURE',
      fixtureLabel: fixture.fixtureLabel,
      syntheticTestData: true,
      ...(parsedHin ? { parsedHin } : {}),
    },
  };
}

function inferUnboundCategory(identifier: string): AssetCategory | null {
  if (VIN_REGEX.test(identifier)) {
    return 'AUTOMOBILE';
  }
  if (HIN_REGEX.test(identifier)) {
    return 'WATERCRAFT';
  }
  if (FIXTURE_MAP_BY_CATEGORY.has(`SHOP_EQUIPMENT:${identifier}`)) {
    return 'SHOP_EQUIPMENT';
  }
  return null;
}

/**
 * Deterministic offline asset decoder implementing `IAssetDecoderPort` from bundled Phase 1A
 * synthetic test fixtures. Unknown identifiers return `null` so callers can require explicit
 * manual `year`, `make`, and `model` input without making network calls or fabricating specs.
 */
export class OfflineAssetDecoderAdapter implements IAssetDecoderPort {
  private readonly boundCategory?: AssetCategory;

  public constructor(options?: { readonly assetCategory?: AssetCategory }) {
    this.boundCategory = options?.assetCategory;
  }

  public async decodeIdentifier(
    vinOrHin: string,
    modelYearHint?: number,
  ): Promise<DecodedAssetSpec | null> {
    void modelYearHint;
    const identifier = normalizeAssetIdentifier(vinOrHin);
    if (identifier.length === 0 || CONTROL_CHARS_REGEX.test(vinOrHin)) {
      return null;
    }

    const category = this.boundCategory ?? inferUnboundCategory(identifier);
    if (!category) {
      return null;
    }

    if (category === 'AUTOMOBILE' && !isValidAutomobileVin(identifier)) {
      return null;
    }

    let parsedHin: ParsedWatercraftHin | null = null;
    if (category === 'WATERCRAFT') {
      parsedHin = parseWatercraftHin(identifier);
      if (!parsedHin) {
        return null;
      }
    }

    if (category === 'SHOP_EQUIPMENT' && !isValidEquipmentSerial(identifier)) {
      return null;
    }

    const fixture = FIXTURE_MAP_BY_CATEGORY.get(`${category}:${identifier}`);
    if (!fixture) {
      return null;
    }

    return toFixtureDecodedSpec(fixture, parsedHin);
  }
}

interface VpicDecodeRow {
  readonly ErrorCode?: unknown;
  readonly ErrorText?: unknown;
  readonly Make?: unknown;
  readonly Model?: unknown;
  readonly ModelYear?: unknown;
  readonly Trim?: unknown;
  readonly Series?: unknown;
  readonly DisplacementL?: unknown;
  readonly EngineCylinders?: unknown;
  readonly EngineModel?: unknown;
  readonly FuelTypePrimary?: unknown;
  readonly SteeringLocation?: unknown;
}

function cleanVpicString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.toUpperCase() === 'NOT APPLICABLE' ||
    trimmed.toUpperCase() === 'N/A'
  ) {
    return null;
  }
  return trimmed;
}

function buildVpicEngineSpec(row: VpicDecodeRow): string | null {
  const displacement = cleanVpicString(row.DisplacementL);
  const cylinders = cleanVpicString(row.EngineCylinders);
  const engineModel = cleanVpicString(row.EngineModel);
  const fuel = cleanVpicString(row.FuelTypePrimary);

  const parts: string[] = [];
  if (displacement) {
    parts.push(displacement.endsWith('L') ? displacement : `${displacement}L`);
  }
  if (cylinders) {
    parts.push(`${cylinders}-Cyl`);
  }
  if (engineModel) {
    parts.push(engineModel);
  }
  if (fuel && parts.length === 0) {
    parts.push(fuel);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function parseVpicResponse(
  vin: string,
  payload: unknown,
): DecodedAssetSpec | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const results = (payload as { Results?: unknown }).Results;
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }
  const first = results[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return null;
  }
  const row = first as VpicDecodeRow;

  const errorCode = cleanVpicString(row.ErrorCode);
  if (errorCode && errorCode !== '0') {
    const firstCode = errorCode.split(',')[0]?.trim();
    if (firstCode && firstCode !== '0' && firstCode !== '1' && firstCode !== '6') {
      return null;
    }
  }

  const rawYear = cleanVpicString(row.ModelYear);
  const year = rawYear && /^\d{4}$/.test(rawYear)
    ? Number.parseInt(rawYear, 10)
    : Number.NaN;
  const make = cleanVpicString(row.Make);
  const model = cleanVpicString(row.Model);

  if (!Number.isSafeInteger(year) || year < 1900 || year > 2100 || !make || !model) {
    return null;
  }

  const trim = cleanVpicString(row.Trim) ?? cleanVpicString(row.Series);
  const engineSpec = buildVpicEngineSpec(row);
  const steeringLocation = cleanVpicString(row.SteeringLocation)?.toUpperCase();
  const steeringSide: 'LHD_ONLY' | 'RHD_ONLY' =
    steeringLocation && steeringLocation.includes('RIGHT')
      ? 'RHD_ONLY'
      : 'LHD_ONLY';

  return {
    identifier: vin,
    assetCategory: 'AUTOMOBILE',
    year,
    make,
    model,
    trim,
    engineSpec,
    steeringSide,
    rawPayload: {
      source: 'NHTSA_VPIC',
      result: row,
    },
  };
}

function isDefaultTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    typeof process.env.VITEST !== 'undefined'
  );
}

/**
 * Category-bound asset decoder implementing `IAssetDecoderPort`:
 * - `AUTOMOBILE`: queries NHTSA vPIC `DecodeVinValues` in live mode with single fallback
 *   to `OfflineAssetDecoderAdapter`; in test/offline mode skips network calls.
 * - `WATERCRAFT`: resolves bundled marine fixtures & local 12-char HIN parsing without vPIC calls.
 * - `SHOP_EQUIPMENT`: resolves bundled equipment fixtures only; 12/17-char equipment serials
 *   never route to VIN or HIN decoders.
 */
export class CompositeAssetDecoderAdapter implements IAssetDecoderPort {
  private readonly boundCategory?: AssetCategory;
  private readonly mode: AssetDecoderMode;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly vpicBaseUrl: string;
  private readonly offlineAdapter: OfflineAssetDecoderAdapter;

  public constructor(options: AssetDecoderAdapterOptions = {}) {
    this.boundCategory = options.assetCategory;
    this.mode =
      options.mode ??
      (options.fetchFn
        ? 'LIVE_WITH_OFFLINE_FALLBACK'
        : isDefaultTestEnvironment()
          ? 'OFFLINE_ONLY'
          : 'LIVE_WITH_OFFLINE_FALLBACK');
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DECODER_TIMEOUT_MS;
    this.vpicBaseUrl = (options.vpicBaseUrl ?? DEFAULT_VPIC_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.offlineAdapter =
      options.offlineAdapter ??
      new OfflineAssetDecoderAdapter({ assetCategory: this.boundCategory });
  }

  public async decodeIdentifier(
    vinOrHin: string,
    modelYearHint?: number,
  ): Promise<DecodedAssetSpec | null> {
    const identifier = normalizeAssetIdentifier(vinOrHin);
    if (identifier.length === 0 || CONTROL_CHARS_REGEX.test(vinOrHin)) {
      return null;
    }

    const effectiveCategory =
      this.boundCategory ?? inferUnboundCategory(identifier);
    if (!effectiveCategory) {
      return null;
    }

    if (effectiveCategory !== 'AUTOMOBILE') {
      return this.offlineAdapter.decodeIdentifier(identifier, modelYearHint);
    }

    if (!isValidAutomobileVin(identifier)) {
      return null;
    }

    if (this.mode === 'OFFLINE_ONLY') {
      return this.offlineAdapter.decodeIdentifier(identifier, modelYearHint);
    }

    const yearQuery =
      typeof modelYearHint === 'number' &&
      Number.isSafeInteger(modelYearHint) &&
      modelYearHint >= 1900 &&
      modelYearHint <= 2100
        ? `&modelyear=${modelYearHint}`
        : '';

    const url = `${this.vpicBaseUrl}/DecodeVinValues/${encodeURIComponent(identifier)}?format=json${yearQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.offlineAdapter.decodeIdentifier(identifier, modelYearHint);
      }
      const json: unknown = await response.json();
      const parsed = parseVpicResponse(identifier, json);
      if (parsed) {
        return parsed;
      }
      return this.offlineAdapter.decodeIdentifier(identifier, modelYearHint);
    } catch {
      return this.offlineAdapter.decodeIdentifier(identifier, modelYearHint);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type AssetDecoderFactory = (
  assetCategory: AssetCategory,
) => IAssetDecoderPort;

export function createCategoryAssetDecoderFactory(
  options: Omit<AssetDecoderAdapterOptions, 'assetCategory'> = {},
): AssetDecoderFactory {
  return (assetCategory: AssetCategory) =>
    new CompositeAssetDecoderAdapter({
      ...options,
      assetCategory,
    });
}
