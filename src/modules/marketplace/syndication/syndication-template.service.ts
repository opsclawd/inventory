import type { TdgHazmatCode } from '@prisma/client';
import {
  assertEbayParcelHazmatEligible,
  DomainRuleError,
} from '@/core/domain';
import type { ISyndicationTemplatePort } from '@/core/ports';
import {
  lookupEbayListingCategory,
  resolveAraConditionMetadata,
  SELLER_HUB_CSV_HEADERS,
} from './ebay-listing-metadata';

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const FITMENT_FIELD_DISALLOWED_RE = /[|=;\r\n\u0000-\u001f\u007f]/;

export interface SyndicationTemplateServiceOptions {
  readonly publicPickupLocationLabel?: string;
  readonly ebayShipFromCity?: string;
  readonly ebayShipFromPostalCode?: string;
  readonly heavyLocalOnlyThresholdKg?: number;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeWhitespace(raw: string): string {
  return raw.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
}

function formatCadMinorToTwoDecimals(minor: number): string {
  if (
    typeof minor !== 'number' ||
    !Number.isFinite(minor) ||
    !Number.isSafeInteger(minor) ||
    minor <= 0
  ) {
    throw new DomainRuleError(
      'INVALID_MONETARY_AMOUNT',
      'Syndication price minor units must be a positive safe integer.',
      { minor },
    );
  }
  const dollars = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, '0');
  return `${dollars}.${cents}`;
}

function formatCadDisplay(minor: number): string {
  return `$${formatCadMinorToTwoDecimals(minor)} CAD`;
}

function neutralizeHumanSpreadsheetCell(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const trimmedLeading = cleaned.trimStart();
  if (FORMULA_TRIGGER_RE.test(trimmedLeading)) {
    return `'${cleaned}`;
  }
  return cleaned;
}

function assertSafeMachineCsvCell(raw: string, fieldName: string): string {
  if (CONTROL_CHARS_RE.test(raw)) {
    throw new DomainRuleError(
      'INVALID_INPUT',
      `Machine CSV field "${fieldName}" contains forbidden control characters.`,
      { fieldName },
    );
  }
  if (FORMULA_TRIGGER_RE.test(raw.trimStart())) {
    throw new DomainRuleError(
      'INVALID_INPUT',
      `Machine CSV field "${fieldName}" cannot start with spreadsheet formula character.`,
      { fieldName, raw },
    );
  }
  return raw;
}

function formatCsvCell(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function encodeCsvRow(cells: readonly string[]): string {
  return cells.map((c) => formatCsvCell(c)).join(',');
}

function truncateCodePoints(raw: string, maxCodePoints: number): string {
  const codePoints = Array.from(raw);
  if (codePoints.length <= maxCodePoints) {
    return raw;
  }
  const sliced = codePoints.slice(0, maxCodePoints).join('').trimEnd();
  return sliced;
}

function buildSeoTitle80(tokens: readonly (string | null | undefined)[]): string {
  const cleanedTokens = tokens
    .map((t) => (typeof t === 'string' ? normalizeWhitespace(t) : ''))
    .filter((t) => t.length > 0);

  let current = '';
  for (const token of cleanedTokens) {
    const candidate = current.length === 0 ? token : `${current} ${token}`;
    if (Array.from(candidate).length <= 80) {
      current = candidate;
    } else if (current.length === 0) {
      current = truncateCodePoints(token, 80);
      break;
    }
  }
  return truncateCodePoints(current, 80);
}

function buildCompatibilityRelationshipDetails(tuple: {
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim?: string | null;
  readonly engine?: string | null;
}): string {
  if (
    !Number.isSafeInteger(tuple.year) ||
    tuple.year < 1900 ||
    tuple.year > 2100
  ) {
    throw new DomainRuleError(
      'INVALID_FITMENT_METADATA' as never,
      `Invalid compatibility year "${String(tuple.year)}".`,
    );
  }
  const fields: Array<[string, string]> = [
    ['Year', String(tuple.year)],
    ['Make', normalizeWhitespace(tuple.make)],
    ['Model', normalizeWhitespace(tuple.model)],
  ];
  if (tuple.trim && normalizeWhitespace(tuple.trim).length > 0) {
    fields.push(['Trim', normalizeWhitespace(tuple.trim)]);
  }
  if (tuple.engine && normalizeWhitespace(tuple.engine).length > 0) {
    fields.push(['Engine', normalizeWhitespace(tuple.engine)]);
  }

  const parts: string[] = [];
  for (const [key, val] of fields) {
    if (val.length === 0) {
      throw new DomainRuleError(
        'FITMENT_METADATA_REQUIRED' as never,
        `Compatibility field "${key}" cannot be empty.`,
      );
    }
    if (FITMENT_FIELD_DISALLOWED_RE.test(val)) {
      throw new DomainRuleError(
        'INVALID_FITMENT_METADATA' as never,
        `Compatibility field "${key}" contains unencodable delimiter or control characters.`,
        { key, val },
      );
    }
    parts.push(`${key}=${val}`);
  }
  const encoded = parts.join('|');
  if (FORMULA_TRIGGER_RE.test(encoded)) {
    throw new DomainRuleError(
      'INVALID_FITMENT_METADATA' as never,
      'Encoded RelationshipDetails cannot begin with a formula character.',
    );
  }
  return encoded;
}

/**
 * Deterministic zero-typing domestic syndication template generator (`FR-MKT-00`).
 * Implements `ISyndicationTemplatePort` without mutating database state or calling external APIs.
 */
export class SyndicationTemplateService implements ISyndicationTemplatePort {
  private readonly publicPickupLocationLabel: string;
  private readonly ebayShipFromCity: string;
  private readonly ebayShipFromPostalCode: string;
  private readonly heavyLocalOnlyThresholdKg: number;

  public constructor(options: SyndicationTemplateServiceOptions = {}) {
    this.publicPickupLocationLabel = normalizeWhitespace(
      options.publicPickupLocationLabel ?? 'Ottawa South / Hwy 416 Corridor',
    );
    this.ebayShipFromCity = normalizeWhitespace(
      options.ebayShipFromCity ?? 'Kemptville, ON',
    );
    this.ebayShipFromPostalCode = normalizeWhitespace(
      options.ebayShipFromPostalCode ?? 'K0G 1J0',
    );
    this.heavyLocalOnlyThresholdKg = options.heavyLocalOnlyThresholdKg ?? 15.0;
  }

  public buildPartSyndicationCopy(
    input: Parameters<ISyndicationTemplatePort['buildPartSyndicationCopy']>[0],
  ): ReturnType<ISyndicationTemplatePort['buildPartSyndicationCopy']> {
    if (
      typeof input.weightKg !== 'number' ||
      !Number.isFinite(input.weightKg) ||
      input.weightKg <= 0
    ) {
      throw new DomainRuleError(
        'INVALID_PART_WEIGHT',
        'Part weightKg must be a finite positive number.',
      );
    }

    const priceCadDisplay = formatCadDisplay(input.retailPriceCadMinor);
    const threshold =
      typeof input.heavyLocalOnlyThresholdKg === 'number' &&
      Number.isFinite(input.heavyLocalOnlyThresholdKg) &&
      input.heavyLocalOnlyThresholdKg > 0
        ? input.heavyLocalOnlyThresholdKg
        : this.heavyLocalOnlyThresholdKg;

    const isEbayParcelEligible =
      input.tdgHazmatCode === 'NONE' && input.weightKg < threshold;
    const recommendedPrimaryChannel = isEbayParcelEligible
      ? 'EBAY_MOTORS_SHIPPED'
      : 'FB_MARKETPLACE_LOCAL';

    const conditionMeta = resolveAraConditionMetadata(input.araGrade);
    const shortGradeToken = conditionMeta.canonicalGrade.replace('GRADE_', 'ARA ');
    const primaryOem = input.oemPartNumbers[0] ?? '';

    const rawShipFromCity = normalizeWhitespace(
      input.ebayShipFromCity || this.ebayShipFromCity,
    );
    const rawPickupMask = normalizeWhitespace(
      input.publicPickupLocationLabel || this.publicPickupLocationLabel,
    );

    const ebaySeoTitle80 = buildSeoTitle80([
      String(input.donorVehicle.year),
      input.donorVehicle.make,
      input.donorVehicle.model,
      input.partCategoryName,
      primaryOem,
      input.donorVehicle.trim,
      input.donorVehicle.engineSpec,
      shortGradeToken,
    ]);

    const safeOemList =
      input.oemPartNumbers.length > 0
        ? input.oemPartNumbers.map((o) => normalizeWhitespace(o)).join(', ')
        : 'See Photos / Verify Fitment';

    const donorHeader = [
      String(input.donorVehicle.year),
      normalizeWhitespace(input.donorVehicle.make),
      normalizeWhitespace(input.donorVehicle.model),
      input.donorVehicle.trim ? normalizeWhitespace(input.donorVehicle.trim) : '',
      input.donorVehicle.engineSpec
        ? normalizeWhitespace(input.donorVehicle.engineSpec)
        : '',
    ]
      .filter((s) => s.length > 0)
      .join(' ');

    const mileageLine =
      typeof input.donorVehicle.odometerKm === 'number'
        ? `<li><strong>Donor Odometer:</strong> ${escapeHtml(input.donorVehicle.odometerKm.toLocaleString('en-CA'))} km</li>`
        : typeof input.donorVehicle.engineHours === 'number'
          ? `<li><strong>Donor Engine Hours:</strong> ${escapeHtml(String(input.donorVehicle.engineHours))} hrs</li>`
          : '';

    const ebayHtmlDescription = [
      '<div>',
      `<h2>${escapeHtml(donorHeader)} - ${escapeHtml(normalizeWhitespace(input.partCategoryName))}</h2>`,
      `<p>OEM salvaged component inspected and tagged under SKU <strong>${escapeHtml(normalizeWhitespace(input.qrSkuCode))}</strong>.</p>`,
      '<ul>',
      `<li><strong>Part Category:</strong> ${escapeHtml(normalizeWhitespace(input.partCategoryName))}</li>`,
      `<li><strong>OEM Part Number(s):</strong> ${escapeHtml(safeOemList)}</li>`,
      `<li><strong>Condition:</strong> ${escapeHtml(conditionMeta.conditionLabel)} (Damage Code: ${escapeHtml(normalizeWhitespace(input.araDamageCode))})</li>`,
      `<li><strong>Donor Vehicle:</strong> ${escapeHtml(donorHeader)}</li>`,
      mileageLine,
      `<li><strong>Shipping Weight:</strong> ${escapeHtml(input.weightKg.toFixed(2))} kg</li>`,
      `<li><strong>Ships From:</strong> ${escapeHtml(rawShipFromCity)}</li>`,
      '</ul>',
      '<p>Please match OEM part numbers and inspect all listing photos before purchase.</p>',
      '</div>',
    ]
      .filter((line) => line.length > 0)
      .join('');

    const localPickupNotice = isEbayParcelEligible
      ? 'Local pickup or Canada-wide shipping available.'
      : input.tdgHazmatCode !== 'NONE'
        ? `Local pickup ONLY (${input.tdgHazmatCode} — parcel shipping prohibited).`
        : `Local pickup ONLY (Heavy/Oversized ${input.weightKg.toFixed(1)} kg).`;

    const localClassifiedsTitle = `${donorHeader} ${normalizeWhitespace(input.partCategoryName)} — ${priceCadDisplay} (${rawPickupMask})`;
    const localClassifiedsBody = [
      `${donorHeader} — ${normalizeWhitespace(input.partCategoryName)}`,
      `Price: ${priceCadDisplay}`,
      `Pickup Corridor: ${rawPickupMask}`,
      `SKU: ${normalizeWhitespace(input.qrSkuCode)}`,
      `OEM Part #: ${safeOemList}`,
      `Condition: ${conditionMeta.conditionLabel}`,
      localPickupNotice,
      'Message to confirm availability before pickup.',
    ].join('\n');

    return {
      recommendedPrimaryChannel,
      isEbayParcelEligible,
      ebaySeoTitle80,
      ebayHtmlDescription,
      localClassifiedsTitle,
      localClassifiedsBody,
      publicPickupLocationLabel: rawPickupMask,
    };
  }

  public exportEbaySellerHubCsv(
    parts: Parameters<ISyndicationTemplatePort['exportEbaySellerHubCsv']>[0],
    shipFrom?: Parameters<ISyndicationTemplatePort['exportEbaySellerHubCsv']>[1],
  ): string {
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        'At least one eligible part is required to generate eBay Seller Hub CSV.',
      );
    }

    const city = normalizeWhitespace(shipFrom?.city ?? this.ebayShipFromCity);
    const postalCode = normalizeWhitespace(
      shipFrom?.postalCode ?? this.ebayShipFromPostalCode,
    );
    if (
      city.toLowerCase().includes(this.publicPickupLocationLabel.toLowerCase()) ||
      postalCode
        .toLowerCase()
        .includes(this.publicPickupLocationLabel.toLowerCase())
    ) {
      throw new DomainRuleError(
        'INVALID_INPUT',
        'eBay CSV ship-from location must be the true warehouse address, never the local classifieds corridor label.',
      );
    }
    assertSafeMachineCsvCell(postalCode, 'PostalCode');

    const rows: string[] = [encodeCsvRow(SELLER_HUB_CSV_HEADERS)];

    for (const part of parts) {
      assertEbayParcelHazmatEligible(part.tdgHazmatCode as TdgHazmatCode);

      const categoryMapping = lookupEbayListingCategory(part.partCategoryName);
      const conditionMeta = resolveAraConditionMetadata(part.araGrade);
      const sku = assertSafeMachineCsvCell(
        normalizeWhitespace(part.qrSkuCode),
        'CustomLabel',
      );
      const startPrice = assertSafeMachineCsvCell(
        formatCadMinorToTwoDecimals(part.retailPriceCadMinor),
        '*StartPrice',
      );
      const categoryId = assertSafeMachineCsvCell(
        categoryMapping.ebayCategoryId,
        '*Category',
      );
      const conditionId = assertSafeMachineCsvCell(
        conditionMeta.conditionId,
        '*ConditionID',
      );
      const seoTitle = truncateCodePoints(
        normalizeWhitespace(part.ebaySeoTitle80),
        80,
      );
      const picUrl = part.sanitizedPublicImageUrls
        .map((url) => assertSafeMachineCsvCell(url, 'PicURL'))
        .join('|');
      const oemJoined = part.oemPartNumbers
        .map((n) => normalizeWhitespace(n))
        .filter((n) => n.length > 0)
        .join(', ');

      const parentRow: string[] = [
        'Add',
        sku,
        categoryId,
        neutralizeHumanSpreadsheetCell(seoTitle),
        conditionId,
        neutralizeHumanSpreadsheetCell(part.ebayHtmlDescription),
        picUrl,
        '1',
        'FixedPrice',
        startPrice,
        neutralizeHumanSpreadsheetCell(city),
        postalCode,
        '2',
        'ReturnsAccepted',
        'CA_CanadaPostExpeditedParcel',
        neutralizeHumanSpreadsheetCell(normalizeWhitespace(part.make)),
        neutralizeHumanSpreadsheetCell(oemJoined),
        '',
        '',
      ];
      rows.push(encodeCsvRow(parentRow));

      if (part.compatibleVehicles && part.compatibleVehicles.length > 0) {
        const seenCompat = new Set<string>();
        const sortedCompat = [...part.compatibleVehicles].sort(
          (a, b) =>
            a.year - b.year ||
            a.make.localeCompare(b.make) ||
            a.model.localeCompare(b.model) ||
            (a.trim ?? '').localeCompare(b.trim ?? '') ||
            (a.engine ?? '').localeCompare(b.engine ?? ''),
        );
        for (const compat of sortedCompat) {
          const details = buildCompatibilityRelationshipDetails(compat);
          if (seenCompat.has(details)) {
            continue;
          }
          seenCompat.add(details);
          const childRow: string[] = [
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            'Compatibility',
            details,
          ];
          rows.push(encodeCsvRow(childRow));
        }
      }
    }

    return `${rows.join('\n')}\n`;
  }

  public exportB2bMechanicPowertrainSheet(
    items: Parameters<
      ISyndicationTemplatePort['exportB2bMechanicPowertrainSheet']
    >[0],
  ): ReturnType<ISyndicationTemplatePort['exportB2bMechanicPowertrainSheet']> {
    const csvHeaders = [
      'SKU',
      'Year',
      'Make',
      'Model',
      'Engine',
      'OdometerKm',
      'PartCategory',
      'OemPartNumbers',
      'AraGrade',
      'InitialMechanicAskCad',
      'PickupCorridor',
    ];
    const csvRows: string[] = [encodeCsvRow(csvHeaders)];
    const mdLines: string[] = [
      `*B2B Mechanic Powertrain Availability Sheet*`,
      `Pickup Corridor: ${this.publicPickupLocationLabel}`,
      '',
    ];

    if (items.length === 0) {
      mdLines.push('_No powertrain assemblies currently available._');
    }

    for (const item of items) {
      const sku = assertSafeMachineCsvCell(
        normalizeWhitespace(item.qrSkuCode),
        'SKU',
      );
      const askCad = formatCadMinorToTwoDecimals(item.wholesaleAskCadMinor);
      const oemJoined = item.oemPartNumbers
        .map((n) => normalizeWhitespace(n))
        .filter((n) => n.length > 0)
        .join(', ');
      const engine = item.engineSpec
        ? normalizeWhitespace(item.engineSpec)
        : 'N/A';
      const odo =
        typeof item.odometerKm === 'number'
          ? `${item.odometerKm.toLocaleString('en-CA')} km`
          : 'N/A';
      const condition = resolveAraConditionMetadata(item.araGrade).canonicalGrade;

      mdLines.push(
        `• *${item.year} ${normalizeWhitespace(item.make)} ${normalizeWhitespace(item.model)}* — ${normalizeWhitespace(item.partCategoryName)} | Engine: ${engine} | Odo: ${odo} | OEM: ${oemJoined || 'N/A'} | ${condition} | Ask: *$${askCad} CAD* | SKU: \`${sku}\``,
      );

      csvRows.push(
        encodeCsvRow([
          sku,
          String(item.year),
          neutralizeHumanSpreadsheetCell(normalizeWhitespace(item.make)),
          neutralizeHumanSpreadsheetCell(normalizeWhitespace(item.model)),
          neutralizeHumanSpreadsheetCell(engine),
          item.odometerKm !== null && item.odometerKm !== undefined
            ? String(item.odometerKm)
            : '',
          neutralizeHumanSpreadsheetCell(
            normalizeWhitespace(item.partCategoryName),
          ),
          neutralizeHumanSpreadsheetCell(oemJoined),
          condition,
          askCad,
          neutralizeHumanSpreadsheetCell(this.publicPickupLocationLabel),
        ]),
      );
    }

    return {
      whatsappMarkdownText: mdLines.join('\n'),
      csvContent: `${csvRows.join('\n')}\n`,
    };
  }
}
