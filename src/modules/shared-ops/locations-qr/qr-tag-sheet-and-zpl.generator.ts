import QRCode from 'qrcode';
import {
  type GenerateLetterQrTagSheetInput,
  type GenerateZplLabelInput,
  GRID_PRESETS,
  type GridPreset,
  type ILabelTagPort,
  LabelTagError,
  type LetterQrTagSheetResult,
  MAX_TAG_CAPTION_LENGTH,
  MAX_TAG_CODE_LENGTH,
  MAX_TAG_SHEET_TAGS,
  PUNCH_STYLES,
  type PunchStyle,
  type SequentialTagRange,
  type TagDescriptor,
} from '@/core/ports/label-tag.port';

export const LETTER_PAGE_WIDTH_PT = 612 as const;
export const LETTER_PAGE_HEIGHT_PT = 792 as const;
export const PRINTABLE_INSET_PT = 18 as const;
export const QR_CORE_SIZE_PT = 108 as const; // 1.5 inches * 72 pt/in
export const QR_VERSION = 3 as const;
export const QR_MODULE_COUNT = 29 as const;
export const QR_QUIET_ZONE_MODULES = 4 as const;
export const QR_MODULE_SIZE_PT = QR_CORE_SIZE_PT / QR_MODULE_COUNT;
export const QR_QUIET_ZONE_PT = QR_QUIET_ZONE_MODULES * QR_MODULE_SIZE_PT;
export const QR_OUTER_SIZE_PT = QR_CORE_SIZE_PT + 2 * QR_QUIET_ZONE_PT;

const PT_PER_MM = 72 / 25.4;
export const OVAL_SLOT_WIDTH_PT = 15 * PT_PER_MM; // 42.519685... pt
export const OVAL_SLOT_HEIGHT_PT = 4 * PT_PER_MM; // 11.338582... pt
export const DUAL_HOLE_DIAMETER_PT = 4 * PT_PER_MM; // 11.338582... pt
export const DUAL_HOLE_RADIUS_PT = DUAL_HOLE_DIAMETER_PT / 2;
export const DUAL_HOLE_CENTER_SPACING_PT = 30 * PT_PER_MM; // 85.039370... pt

const PUNCH_CENTER_OFFSET_Y_PT = 23.7;
const QR_OUTER_OFFSET_Y_PT = 29.8;
const CODE_TEXT_BASELINE_OFFSET_Y_PT = 174.2;
const CAPTION_TEXT_BASELINE_OFFSET_Y_PT = 179.8;
const CODE_FONT_SIZE_PT = 7.2;
const CAPTION_FONT_SIZE_PT = 5.6;
const BEZIER_KAPPA = 0.5522847498;

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const PRINTABLE_ASCII_REGEX = /^[\u0020-\u007e]*$/;

const PRT_CODE_REGEX = /^PRT-[A-Z0-9]{1,36}$/;
const YEAR_ENTITY_CODE_REGEX = /^(?:AST|PLT|LOT)-(?:19|20)\d{2}-[A-Z0-9]{1,31}$/;
const LOCATION_CODE_REGEX = /^[A-Z][A-Z0-9]{1,15}(?:[-_][A-Z0-9]+)+$/;

const YEAR_ENTITY_PREFIX_REGEX = /^(?:AST|PLT|LOT)-(?:19|20)\d{2}-$/;
const LOCATION_PREFIX_REGEX =
  /^[A-Z][A-Z0-9]{1,15}(?:[-_][A-Z0-9]+)*[-_][A-Z0-9]*$/;

// Standard Helvetica AFM glyph widths (in 1/1000 em units) for ASCII 32..126.
const HELVETICA_CHAR_WIDTHS: Readonly<Record<number, number>> = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
  104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556, 111: 556,
  112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556, 118: 500, 119: 722,
  120: 500, 121: 500, 122: 500, 123: 334, 124: 260, 125: 334, 126: 584,
};

function fmtPt(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/\.?0+$/, '');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapePdfLiteral(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function escapeZplHex(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' || ch === '^' || ch === '~') {
      const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
      out += `\\${hex}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function measureHelveticaWidthPt(
  text: string,
  fontSizePt: number,
  bold = false,
): number {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    units += HELVETICA_CHAR_WIDTHS[code] ?? 556;
  }
  const boldFactor = bold ? 1.06 : 1.0;
  return (units / 1000) * fontSizePt * boldFactor;
}

function truncateTextToWidth(
  text: string,
  maxWidthPt: number,
  fontSizePt: number,
  bold = false,
): string {
  if (measureHelveticaWidthPt(text, fontSizePt, bold) <= maxWidthPt) {
    return text;
  }
  const ellipsis = '...';
  let end = text.length;
  while (end > 0) {
    const candidate = `${text.slice(0, end).trimEnd()}${ellipsis}`;
    if (measureHelveticaWidthPt(candidate, fontSizePt, bold) <= maxWidthPt) {
      return candidate;
    }
    end -= 1;
  }
  return '';
}

export function validateCanonicalTagCode(rawCode: unknown): string {
  if (typeof rawCode !== 'string' || rawCode.length === 0) {
    throw new LabelTagError(
      'LABEL_INVALID_CODE',
      'Tag code must be a non-empty canonical barcode string.',
    );
  }
  if (rawCode.trim() !== rawCode || CONTROL_CHARS_REGEX.test(rawCode)) {
    throw new LabelTagError(
      'LABEL_INVALID_CODE',
      'Tag code must not contain leading/trailing whitespace or control characters.',
    );
  }
  if (rawCode.length > MAX_TAG_CODE_LENGTH) {
    throw new LabelTagError(
      'LABEL_INVALID_CODE',
      `Tag code exceeds maximum length of ${MAX_TAG_CODE_LENGTH} characters.`,
      { length: rawCode.length },
    );
  }

  let valid = false;
  if (rawCode.startsWith('PRT-')) {
    valid = PRT_CODE_REGEX.test(rawCode);
  } else if (
    rawCode.startsWith('AST-') ||
    rawCode.startsWith('PLT-') ||
    rawCode.startsWith('LOT-')
  ) {
    valid = YEAR_ENTITY_CODE_REGEX.test(rawCode);
  } else {
    valid = LOCATION_CODE_REGEX.test(rawCode);
  }

  if (!valid) {
    throw new LabelTagError(
      'LABEL_INVALID_CODE',
      `Malformed or non-canonical tag barcode: "${rawCode}".`,
    );
  }

  return rawCode;
}

export function validateTagCaption(
  rawCaption: unknown,
  fieldName = 'caption',
): string | undefined {
  if (rawCaption === undefined) {
    return undefined;
  }
  if (typeof rawCaption !== 'string') {
    throw new LabelTagError(
      'LABEL_INVALID_CAPTION',
      `${fieldName} must be a string when provided.`,
    );
  }
  if (CONTROL_CHARS_REGEX.test(rawCaption) || !PRINTABLE_ASCII_REGEX.test(rawCaption)) {
    throw new LabelTagError(
      'LABEL_INVALID_CAPTION',
      `${fieldName} must contain printable ASCII characters without control sequences.`,
    );
  }
  const trimmed = rawCaption.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > MAX_TAG_CAPTION_LENGTH) {
    throw new LabelTagError(
      'LABEL_INVALID_CAPTION',
      `${fieldName} exceeds maximum length of ${MAX_TAG_CAPTION_LENGTH} characters.`,
      { length: trimmed.length },
    );
  }
  return trimmed;
}

function resolveValidatedRangePrefix(rawPrefix: unknown): {
  readonly prefix: string;
  readonly defaultWidth: number;
} {
  if (typeof rawPrefix !== 'string' || rawPrefix.length === 0) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      'Sequential range prefix must be a non-empty string.',
    );
  }
  if (rawPrefix.trim() !== rawPrefix || CONTROL_CHARS_REGEX.test(rawPrefix)) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      'Sequential range prefix must not contain whitespace or control characters.',
    );
  }

  if (rawPrefix.startsWith('PRT-')) {
    if (rawPrefix !== 'PRT-') {
      throw new LabelTagError(
        'LABEL_INVALID_RANGE',
        'Part tag range prefix must be exactly "PRT-".',
      );
    }
    return { prefix: rawPrefix, defaultWidth: 6 };
  }

  if (
    rawPrefix.startsWith('AST-') ||
    rawPrefix.startsWith('PLT-') ||
    rawPrefix.startsWith('LOT-')
  ) {
    if (!YEAR_ENTITY_PREFIX_REGEX.test(rawPrefix)) {
      throw new LabelTagError(
        'LABEL_INVALID_RANGE',
        'Asset, pallet, and lot range prefixes must follow "{AST|PLT|LOT}-YYYY-".',
      );
    }
    return {
      prefix: rawPrefix,
      defaultWidth: rawPrefix.startsWith('PLT-') ? 3 : 4,
    };
  }

  if (!LOCATION_PREFIX_REGEX.test(rawPrefix)) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      `Malformed location range prefix: "${rawPrefix}".`,
    );
  }

  return { prefix: rawPrefix, defaultWidth: 2 };
}

export function expandSequentialTagRange(
  range: SequentialTagRange,
): readonly TagDescriptor[] {
  if (!range || typeof range !== 'object') {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      'Sequential tag range must be an object.',
    );
  }

  const { prefix, defaultWidth } = resolveValidatedRangePrefix(range.prefix);

  if (
    typeof range.start !== 'number' ||
    !Number.isSafeInteger(range.start) ||
    range.start < 0
  ) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      'Range start must be a non-negative safe integer.',
    );
  }
  if (
    typeof range.end !== 'number' ||
    !Number.isSafeInteger(range.end) ||
    range.end < 0
  ) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      'Range end must be a non-negative safe integer.',
    );
  }
  if (range.end < range.start) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      'Range end must be greater than or equal to start.',
    );
  }

  const count = range.end - range.start + 1;
  if (count > MAX_TAG_SHEET_TAGS) {
    throw new LabelTagError(
      'LABEL_LIMIT_EXCEEDED',
      `Tag count ${count} exceeds the maximum of ${MAX_TAG_SHEET_TAGS} tags per request.`,
      { tagCount: count, maxTags: MAX_TAG_SHEET_TAGS },
    );
  }

  let effectiveWidth = defaultWidth;
  if (range.width !== undefined) {
    if (
      typeof range.width !== 'number' ||
      !Number.isSafeInteger(range.width) ||
      range.width < 1 ||
      range.width > 20
    ) {
      throw new LabelTagError(
        'LABEL_INVALID_RANGE',
        'Range width must be a safe integer between 1 and 20.',
      );
    }
    effectiveWidth = range.width;
  }

  const maxDigits = String(range.end).length;
  if (maxDigits > effectiveWidth) {
    throw new LabelTagError(
      'LABEL_INVALID_RANGE',
      `Range end ${range.end} exceeds zero-padded width ${effectiveWidth}.`,
      { end: range.end, width: effectiveWidth },
    );
  }

  if (prefix.length + effectiveWidth > MAX_TAG_CODE_LENGTH) {
    throw new LabelTagError(
      'LABEL_INVALID_CODE',
      `Expanded range code exceeds maximum length of ${MAX_TAG_CODE_LENGTH} characters.`,
    );
  }

  const captionPrefix = validateTagCaption(
    range.captionPrefix,
    'captionPrefix',
  );

  const descriptors: TagDescriptor[] = [];
  for (let n = range.start; n <= range.end; n += 1) {
    const suffix = String(n).padStart(effectiveWidth, '0');
    const code = validateCanonicalTagCode(`${prefix}${suffix}`);
    let caption: string | undefined;
    if (captionPrefix !== undefined) {
      const combined = `${captionPrefix} ${suffix}`;
      caption = validateTagCaption(combined, 'caption');
    }
    descriptors.push(caption !== undefined ? { code, caption } : { code });
  }

  return descriptors;
}

function validateAndNormalizeDescriptors(
  input: GenerateLetterQrTagSheetInput,
): {
  readonly descriptors: readonly TagDescriptor[];
  readonly gridPreset: GridPreset;
  readonly punchStyle: PunchStyle;
  readonly organizationLabel?: string;
} {
  if (!input || typeof input !== 'object') {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'Label sheet generation input must be an object.',
    );
  }

  const raw = input as unknown as {
    mode?: unknown;
    descriptors?: unknown;
    range?: unknown;
    gridPreset?: unknown;
    punchStyle?: unknown;
    organizationLabel?: unknown;
  };

  if (raw.mode !== undefined && raw.mode !== 'DESCRIPTORS' && raw.mode !== 'RANGE') {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'Sheet input mode must be "DESCRIPTORS" or "RANGE" when specified.',
    );
  }

  const hasDescriptors = raw.descriptors !== undefined;
  const hasRange = raw.range !== undefined;
  if (hasDescriptors && hasRange) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'Cannot combine explicit descriptors with a sequential range.',
    );
  }
  if (!hasDescriptors && !hasRange) {
    throw new LabelTagError(
      'LABEL_EMPTY_INPUT',
      'Either descriptors or range must be provided.',
    );
  }
  if (raw.mode === 'DESCRIPTORS' && !hasDescriptors) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'mode "DESCRIPTORS" requires a descriptors array.',
    );
  }
  if (raw.mode === 'RANGE' && !hasRange) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'mode "RANGE" requires a range object.',
    );
  }

  const gridPreset = (raw.gridPreset ?? '12_UP_3X4') as GridPreset;
  if (!GRID_PRESETS.includes(gridPreset)) {
    throw new LabelTagError(
      'LABEL_UNSUPPORTED_PRESET',
      `Unsupported gridPreset: "${String(raw.gridPreset)}".`,
    );
  }

  const punchStyle = (raw.punchStyle ?? 'SINGLE_OVAL_SLOT_15X4MM') as PunchStyle;
  if (!PUNCH_STYLES.includes(punchStyle)) {
    throw new LabelTagError(
      'LABEL_UNSUPPORTED_PRESET',
      `Unsupported punchStyle: "${String(raw.punchStyle)}".`,
    );
  }

  const organizationLabel = validateTagCaption(
    raw.organizationLabel,
    'organizationLabel',
  );

  if (hasRange) {
    return {
      descriptors: expandSequentialTagRange(raw.range as SequentialTagRange),
      gridPreset,
      punchStyle,
      organizationLabel,
    };
  }

  if (!Array.isArray(raw.descriptors)) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'descriptors must be an array.',
    );
  }
  if (raw.descriptors.length === 0) {
    throw new LabelTagError(
      'LABEL_EMPTY_INPUT',
      'descriptors must contain at least one tag.',
    );
  }
  if (raw.descriptors.length > MAX_TAG_SHEET_TAGS) {
    throw new LabelTagError(
      'LABEL_LIMIT_EXCEEDED',
      `Tag count ${raw.descriptors.length} exceeds the maximum of ${MAX_TAG_SHEET_TAGS} tags per request.`,
      { tagCount: raw.descriptors.length, maxTags: MAX_TAG_SHEET_TAGS },
    );
  }

  const seenCodes = new Set<string>();
  const normalized: TagDescriptor[] = [];

  for (let i = 0; i < raw.descriptors.length; i += 1) {
    const item = raw.descriptors[i];
    if (!item || typeof item !== 'object') {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        `Descriptor at index ${i} must be an object.`,
      );
    }
    const code = validateCanonicalTagCode((item as { code?: unknown }).code);
    if (seenCodes.has(code)) {
      throw new LabelTagError(
        'LABEL_DUPLICATE_CODE',
        `Duplicate tag barcode in sheet request: "${code}".`,
        { code },
      );
    }
    seenCodes.add(code);
    const caption = validateTagCaption(
      (item as { caption?: unknown }).caption,
      `descriptors[${i}].caption`,
    );
    normalized.push(caption !== undefined ? { code, caption } : { code });
  }

  return {
    descriptors: normalized,
    gridPreset,
    punchStyle,
    organizationLabel,
  };
}

interface HorizontalRun {
  readonly row: number;
  readonly startCol: number;
  readonly length: number;
}

interface EncodedQrMatrix {
  readonly size: number;
  readonly runs: readonly HorizontalRun[];
}

function encodeCanonicalQrMatrix(code: string): EncodedQrMatrix {
  let qr: QRCode.QRCode;
  try {
    qr = QRCode.create(code, {
      errorCorrectionLevel: 'M',
      version: QR_VERSION,
      maskPattern: 2,
    });
  } catch (err) {
    throw new LabelTagError(
      'LABEL_QR_CAPACITY_EXCEEDED',
      `Payload "${code}" could not fit in fixed QR version ${QR_VERSION} (ECL M).`,
      { code, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  if (qr.version !== QR_VERSION || qr.modules.size !== QR_MODULE_COUNT) {
    throw new LabelTagError(
      'LABEL_QR_CAPACITY_EXCEEDED',
      `Unexpected QR matrix dimensions (${qr.modules.size}x${qr.modules.size}) for "${code}".`,
    );
  }

  const size = qr.modules.size;
  const runs: HorizontalRun[] = [];
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (qr.modules.get(row, col) === 1) {
        const startCol = col;
        while (col < size && qr.modules.get(row, col) === 1) {
          col += 1;
        }
        runs.push({ row, startCol, length: col - startCol });
      } else {
        col += 1;
      }
    }
  }

  return { size, runs };
}

interface PlacedTagModel {
  readonly code: string;
  readonly displayCaption?: string;
  readonly cellX: number;
  readonly cellY: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly punchCenterX: number;
  readonly punchCenterY: number;
  readonly qrOuterX: number;
  readonly qrOuterY: number;
  readonly qrCoreX: number;
  readonly qrCoreY: number;
  readonly qr: EncodedQrMatrix;
  readonly codeFontSizePt: number;
  readonly codeBaselineY: number;
  readonly captionBaselineY: number;
}

interface CutLineModel {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

interface PageDrawingModel {
  readonly pageNumber: number;
  readonly gridPreset: GridPreset;
  readonly punchStyle: PunchStyle;
  readonly cutLines: readonly CutLineModel[];
  readonly tags: readonly PlacedTagModel[];
}

function buildPageModels(
  descriptors: readonly TagDescriptor[],
  gridPreset: GridPreset,
  punchStyle: PunchStyle,
  organizationLabel?: string,
): readonly PageDrawingModel[] {
  const cols = gridPreset === '12_UP_3X4' ? 3 : 4;
  const rows = 4;
  const perPage = cols * rows;
  const cellWidth = LETTER_PAGE_WIDTH_PT / cols;
  const cellHeight = LETTER_PAGE_HEIGHT_PT / rows;
  const maxTextWidthPt = cellWidth - 2 * PRINTABLE_INSET_PT;

  const cutLines: CutLineModel[] = [];
  for (let c = 1; c < cols; c += 1) {
    const x = c * cellWidth;
    cutLines.push({
      x1: x,
      y1: PRINTABLE_INSET_PT,
      x2: x,
      y2: LETTER_PAGE_HEIGHT_PT - PRINTABLE_INSET_PT,
    });
  }
  for (let r = 1; r < rows; r += 1) {
    const y = r * cellHeight;
    cutLines.push({
      x1: PRINTABLE_INSET_PT,
      y1: y,
      x2: LETTER_PAGE_WIDTH_PT - PRINTABLE_INSET_PT,
      y2: y,
    });
  }

  const pageCount = Math.ceil(descriptors.length / perPage);
  const pages: PageDrawingModel[] = [];

  for (let pageIdx = 0; pageIdx < pageCount; pageIdx += 1) {
    const start = pageIdx * perPage;
    const slice = descriptors.slice(start, start + perPage);
    const tags: PlacedTagModel[] = [];

    for (let i = 0; i < slice.length; i += 1) {
      const descriptor = slice[i]!;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cellX = col * cellWidth;
      const cellY = row * cellHeight;

      const qrOuterX = cellX + (cellWidth - QR_OUTER_SIZE_PT) / 2;
      const qrOuterY = cellY + QR_OUTER_OFFSET_Y_PT;
      const qrCoreX = qrOuterX + QR_QUIET_ZONE_PT;
      const qrCoreY = qrOuterY + QR_QUIET_ZONE_PT;

      const rawCaption = descriptor.caption ?? organizationLabel;
      const displayCaption =
        rawCaption !== undefined
          ? truncateTextToWidth(rawCaption, maxTextWidthPt, CAPTION_FONT_SIZE_PT, false)
          : undefined;

      tags.push({
        code: descriptor.code,
        displayCaption:
          displayCaption && displayCaption.length > 0 ? displayCaption : undefined,
        cellX,
        cellY,
        cellWidth,
        cellHeight,
        punchCenterX: cellX + cellWidth / 2,
        punchCenterY: cellY + PUNCH_CENTER_OFFSET_Y_PT,
        qrOuterX,
        qrOuterY,
        qrCoreX,
        qrCoreY,
        qr: encodeCanonicalQrMatrix(descriptor.code),
        codeFontSizePt: CODE_FONT_SIZE_PT,
        codeBaselineY: cellY + CODE_TEXT_BASELINE_OFFSET_Y_PT,
        captionBaselineY: cellY + CAPTION_TEXT_BASELINE_OFFSET_Y_PT,
      });
    }

    pages.push({
      pageNumber: pageIdx + 1,
      gridPreset,
      punchStyle,
      cutLines,
      tags,
    });
  }

  return pages;
}

function renderSvgPage(page: PageDrawingModel): string {
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 ${LETTER_PAGE_WIDTH_PT} ${LETTER_PAGE_HEIGHT_PT}" data-page="${page.pageNumber}" data-grid-preset="${page.gridPreset}" data-punch-style="${page.punchStyle}">`,
    `  <rect x="0" y="0" width="${LETTER_PAGE_WIDTH_PT}" height="${LETTER_PAGE_HEIGHT_PT}" fill="#FFFFFF" />`,
    '  <g data-layer="guillotine-cut-lines" stroke="#888888" stroke-width="0.5" stroke-dasharray="4 3">',
  ];

  for (const line of page.cutLines) {
    lines.push(
      `    <line x1="${fmtPt(line.x1)}" y1="${fmtPt(line.y1)}" x2="${fmtPt(line.x2)}" y2="${fmtPt(line.y2)}" />`,
    );
  }
  lines.push('  </g>');

  for (const tag of page.tags) {
    const escapedCode = escapeXml(tag.code);
    lines.push(
      `  <g data-tag-code="${escapedCode}" data-cell-x="${fmtPt(tag.cellX)}" data-cell-y="${fmtPt(tag.cellY)}">`,
    );

    if (page.punchStyle === 'SINGLE_OVAL_SLOT_15X4MM') {
      const ovalX = tag.punchCenterX - OVAL_SLOT_WIDTH_PT / 2;
      const ovalY = tag.punchCenterY - OVAL_SLOT_HEIGHT_PT / 2;
      const radius = OVAL_SLOT_HEIGHT_PT / 2;
      lines.push(
        `    <rect data-punch-guide="SINGLE_OVAL_SLOT_15X4MM" x="${fmtPt(ovalX)}" y="${fmtPt(ovalY)}" width="${fmtPt(OVAL_SLOT_WIDTH_PT)}" height="${fmtPt(OVAL_SLOT_HEIGHT_PT)}" rx="${fmtPt(radius)}" ry="${fmtPt(radius)}" fill="none" stroke="#444444" stroke-width="0.75" />`,
      );
    } else {
      const halfSpan = DUAL_HOLE_CENTER_SPACING_PT / 2;
      lines.push(
        `    <circle data-punch-guide="DUAL_TOP_RACK_HOLES" cx="${fmtPt(tag.punchCenterX - halfSpan)}" cy="${fmtPt(tag.punchCenterY)}" r="${fmtPt(DUAL_HOLE_RADIUS_PT)}" fill="none" stroke="#444444" stroke-width="0.75" />`,
      );
      lines.push(
        `    <circle data-punch-guide="DUAL_TOP_RACK_HOLES" cx="${fmtPt(tag.punchCenterX + halfSpan)}" cy="${fmtPt(tag.punchCenterY)}" r="${fmtPt(DUAL_HOLE_RADIUS_PT)}" fill="none" stroke="#444444" stroke-width="0.75" />`,
      );
    }

    lines.push(
      `    <rect data-qr-quiet-zone="true" x="${fmtPt(tag.qrOuterX)}" y="${fmtPt(tag.qrOuterY)}" width="${fmtPt(QR_OUTER_SIZE_PT)}" height="${fmtPt(QR_OUTER_SIZE_PT)}" fill="#FFFFFF" />`,
    );
    lines.push(
      `    <g data-qr-core="true" data-qr-size-pt="${QR_CORE_SIZE_PT}" fill="#000000" shape-rendering="crispEdges">`,
    );
    for (const run of tag.qr.runs) {
      const rx = tag.qrCoreX + run.startCol * QR_MODULE_SIZE_PT;
      const ry = tag.qrCoreY + run.row * QR_MODULE_SIZE_PT;
      const rw = run.length * QR_MODULE_SIZE_PT;
      lines.push(
        `      <rect x="${fmtPt(rx)}" y="${fmtPt(ry)}" width="${fmtPt(rw)}" height="${fmtPt(QR_MODULE_SIZE_PT)}" />`,
      );
    }
    lines.push('    </g>');

    const textCenterX = tag.cellX + tag.cellWidth / 2;
    lines.push(
      `    <text x="${fmtPt(textCenterX)}" y="${fmtPt(tag.codeBaselineY)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fmtPt(tag.codeFontSizePt)}" font-weight="bold" fill="#000000">${escapedCode}</text>`,
    );

    if (tag.displayCaption) {
      lines.push(
        `    <text x="${fmtPt(textCenterX)}" y="${fmtPt(tag.captionBaselineY)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fmtPt(CAPTION_FONT_SIZE_PT)}" fill="#222222">${escapeXml(tag.displayCaption)}</text>`,
      );
    }

    lines.push('  </g>');
  }

  lines.push('</svg>');
  return lines.join('\n');
}

function pdfY(svgY: number): number {
  return LETTER_PAGE_HEIGHT_PT - svgY;
}

function pdfCirclePathCommands(cx: number, svgCy: number, r: number): string {
  const cy = pdfY(svgCy);
  const k = BEZIER_KAPPA * r;
  return [
    `${fmtPt(cx + r)} ${fmtPt(cy)} m`,
    `${fmtPt(cx + r)} ${fmtPt(cy + k)} ${fmtPt(cx + k)} ${fmtPt(cy + r)} ${fmtPt(cx)} ${fmtPt(cy + r)} c`,
    `${fmtPt(cx - k)} ${fmtPt(cy + r)} ${fmtPt(cx - r)} ${fmtPt(cy + k)} ${fmtPt(cx - r)} ${fmtPt(cy)} c`,
    `${fmtPt(cx - r)} ${fmtPt(cy - k)} ${fmtPt(cx - k)} ${fmtPt(cy - r)} ${fmtPt(cx)} ${fmtPt(cy - r)} c`,
    `${fmtPt(cx + k)} ${fmtPt(cy - r)} ${fmtPt(cx + r)} ${fmtPt(cy - k)} ${fmtPt(cx + r)} ${fmtPt(cy)} c`,
    'h S',
  ].join('\n');
}

function pdfOvalSlotPathCommands(
  centerX: number,
  svgCenterY: number,
  width: number,
  height: number,
): string {
  const cy = pdfY(svgCenterY);
  const r = height / 2;
  const k = BEZIER_KAPPA * r;
  const halfStraight = (width - height) / 2;
  const leftCx = centerX - halfStraight;
  const rightCx = centerX + halfStraight;

  return [
    `${fmtPt(leftCx)} ${fmtPt(cy + r)} m`,
    `${fmtPt(rightCx)} ${fmtPt(cy + r)} l`,
    `${fmtPt(rightCx + k)} ${fmtPt(cy + r)} ${fmtPt(rightCx + r)} ${fmtPt(cy + k)} ${fmtPt(rightCx + r)} ${fmtPt(cy)} c`,
    `${fmtPt(rightCx + r)} ${fmtPt(cy - k)} ${fmtPt(rightCx + k)} ${fmtPt(cy - r)} ${fmtPt(rightCx)} ${fmtPt(cy - r)} c`,
    `${fmtPt(leftCx)} ${fmtPt(cy - r)} l`,
    `${fmtPt(leftCx - k)} ${fmtPt(cy - r)} ${fmtPt(leftCx - r)} ${fmtPt(cy - k)} ${fmtPt(leftCx - r)} ${fmtPt(cy)} c`,
    `${fmtPt(leftCx - r)} ${fmtPt(cy + k)} ${fmtPt(leftCx - k)} ${fmtPt(cy + r)} ${fmtPt(leftCx)} ${fmtPt(cy + r)} c`,
    'h S',
  ].join('\n');
}

function buildPdfPageContentStream(page: PageDrawingModel): string {
  const cmds: string[] = [];

  // White Letter background
  cmds.push(`1 1 1 rg 0 0 ${LETTER_PAGE_WIDTH_PT} ${LETTER_PAGE_HEIGHT_PT} re f`);

  // Dashed guillotine cut lines
  if (page.cutLines.length > 0) {
    cmds.push('q 0.5 w [4 3] 0 d 0.533 0.533 0.533 RG');
    for (const line of page.cutLines) {
      cmds.push(
        `${fmtPt(line.x1)} ${fmtPt(pdfY(line.y1))} m ${fmtPt(line.x2)} ${fmtPt(pdfY(line.y2))} l S`,
      );
    }
    cmds.push('Q');
  }

  for (const tag of page.tags) {
    // Punch guide
    cmds.push('q 0.75 w 0.267 0.267 0.267 RG');
    if (page.punchStyle === 'SINGLE_OVAL_SLOT_15X4MM') {
      cmds.push(
        pdfOvalSlotPathCommands(
          tag.punchCenterX,
          tag.punchCenterY,
          OVAL_SLOT_WIDTH_PT,
          OVAL_SLOT_HEIGHT_PT,
        ),
      );
    } else {
      const halfSpan = DUAL_HOLE_CENTER_SPACING_PT / 2;
      cmds.push(
        pdfCirclePathCommands(
          tag.punchCenterX - halfSpan,
          tag.punchCenterY,
          DUAL_HOLE_RADIUS_PT,
        ),
      );
      cmds.push(
        pdfCirclePathCommands(
          tag.punchCenterX + halfSpan,
          tag.punchCenterY,
          DUAL_HOLE_RADIUS_PT,
        ),
      );
    }
    cmds.push('Q');

    // Explicit white QR quiet zone
    const qrOuterPdfY = pdfY(tag.qrOuterY + QR_OUTER_SIZE_PT);
    cmds.push(
      `1 1 1 rg ${fmtPt(tag.qrOuterX)} ${fmtPt(qrOuterPdfY)} ${fmtPt(QR_OUTER_SIZE_PT)} ${fmtPt(QR_OUTER_SIZE_PT)} re f`,
    );

    // QR modules (black)
    cmds.push('0 0 0 rg');
    for (const run of tag.qr.runs) {
      const rx = tag.qrCoreX + run.startCol * QR_MODULE_SIZE_PT;
      const rySvg = tag.qrCoreY + run.row * QR_MODULE_SIZE_PT;
      const rw = run.length * QR_MODULE_SIZE_PT;
      const rectPdfY = pdfY(rySvg + QR_MODULE_SIZE_PT);
      cmds.push(
        `${fmtPt(rx)} ${fmtPt(rectPdfY)} ${fmtPt(rw)} ${fmtPt(QR_MODULE_SIZE_PT)} re f`,
      );
    }

    // Barcode text
    const centerX = tag.cellX + tag.cellWidth / 2;
    const codeWidth = measureHelveticaWidthPt(tag.code, tag.codeFontSizePt, true);
    const codeX = centerX - codeWidth / 2;
    cmds.push(
      `BT /F2 ${fmtPt(tag.codeFontSizePt)} Tf 0 0 0 rg 1 0 0 1 ${fmtPt(codeX)} ${fmtPt(pdfY(tag.codeBaselineY))} Tm (${escapePdfLiteral(tag.code)}) Tj ET`,
    );

    // Optional caption
    if (tag.displayCaption) {
      const captionWidth = measureHelveticaWidthPt(
        tag.displayCaption,
        CAPTION_FONT_SIZE_PT,
        false,
      );
      const captionX = centerX - captionWidth / 2;
      cmds.push(
        `BT /F1 ${fmtPt(CAPTION_FONT_SIZE_PT)} Tf 0.133 0.133 0.133 rg 1 0 0 1 ${fmtPt(captionX)} ${fmtPt(pdfY(tag.captionBaselineY))} Tm (${escapePdfLiteral(tag.displayCaption)}) Tj ET`,
      );
    }
  }

  return `${cmds.join('\n')}\n`;
}

function serializePdf14Document(pages: readonly PageDrawingModel[]): Uint8Array {
  // Object numbers:
  // 1: Catalog
  // 2: Pages
  // 3: Font F1 (Helvetica)
  // 4: Font F2 (Helvetica-Bold)
  // For page i (0-based):
  //   5 + 2*i: Page object
  //   6 + 2*i: Content stream object
  const pageObjectIds: number[] = [];
  const bodies: string[] = [];

  for (let i = 0; i < pages.length; i += 1) {
    const pageObjId = 5 + 2 * i;
    const contentObjId = 6 + 2 * i;
    pageObjectIds.push(pageObjId);

    const stream = buildPdfPageContentStream(pages[i]!);
    const streamBytesLen = Buffer.byteLength(stream, 'latin1');

    bodies[pageObjId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LETTER_PAGE_WIDTH_PT} ${LETTER_PAGE_HEIGHT_PT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>`;
    bodies[contentObjId] =
      `<< /Length ${streamBytesLen} >>\nstream\n${stream}endstream`;
  }

  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  bodies[3] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  bodies[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  const totalObjects = 4 + pages.length * 2;
  const chunks: Buffer[] = [];
  const offsets: number[] = [0];
  let byteCursor = 0;

  const pushStr = (text: string): void => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    byteCursor += buf.byteLength;
  };

  // Deterministic PDF 1.4 header (no timestamps or random IDs)
  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  for (let objId = 1; objId <= totalObjects; objId += 1) {
    offsets[objId] = byteCursor;
    pushStr(`${objId} 0 obj\n${bodies[objId]}\nendobj\n`);
  }

  const xrefStart = byteCursor;
  pushStr(`xref\n0 ${totalObjects + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let objId = 1; objId <= totalObjects; objId += 1) {
    const off = String(offsets[objId]!).padStart(10, '0');
    pushStr(`${off} 00000 n \n`);
  }
  pushStr(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Deterministic, purely in-memory `ILabelTagPort` implementation generating:
 * 1) 8.5" x 11" Letter SVG pages and vector PDF 1.4 sheets for 10-MIL laser hang-tag stock
 * 2) Zebra ZPL II thermal command strings with `^FH` command-injection escaping
 */
export class QrTagSheetAndZplGenerator implements ILabelTagPort {
  public generateLetterQrTagSheet(
    input: GenerateLetterQrTagSheetInput,
  ): LetterQrTagSheetResult {
    const { descriptors, gridPreset, punchStyle, organizationLabel } =
      validateAndNormalizeDescriptors(input);

    const pages = buildPageModels(
      descriptors,
      gridPreset,
      punchStyle,
      organizationLabel,
    );

    const svgPages = pages.map((page) => renderSvgPage(page));
    const pdfBytes = serializePdf14Document(pages);

    return {
      svgPages,
      pdfBytes,
      pageCount: pages.length,
      tagCount: descriptors.length,
      gridPreset,
      punchStyle,
    };
  }

  public generateZplLabel(input: GenerateZplLabelInput): string {
    if (!input || typeof input !== 'object') {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        'ZPL label input must be an object.',
      );
    }

    const code = validateCanonicalTagCode(input.code);
    // Verify payload fits canonical QR version 3 M constraints identically to sheet generator
    encodeCanonicalQrMatrix(code);

    const caption = validateTagCaption(input.caption, 'caption');
    const subCaption = validateTagCaption(input.subCaption, 'subCaption');
    const organizationLabel = validateTagCaption(
      input.organizationLabel,
      'organizationLabel',
    );

    const dpi = input.dpi ?? 203;
    if (dpi !== 203 && dpi !== 300) {
      throw new LabelTagError(
        'LABEL_UNSUPPORTED_PRESET',
        `Unsupported ZPL DPI: ${String(input.dpi)}. Expected 203 or 300.`,
      );
    }

    const defaultWidthDots = dpi === 300 ? 1200 : 812;
    const defaultHeightDots = dpi === 300 ? 1800 : 1218;
    const widthDots = input.widthDots ?? defaultWidthDots;
    const heightDots = input.heightDots ?? defaultHeightDots;

    if (
      typeof widthDots !== 'number' ||
      !Number.isSafeInteger(widthDots) ||
      widthDots < 200 ||
      widthDots > 4096 ||
      typeof heightDots !== 'number' ||
      !Number.isSafeInteger(heightDots) ||
      heightDots < 200 ||
      heightDots > 4096
    ) {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        'ZPL widthDots and heightDots must be safe integers between 200 and 4096.',
      );
    }

    const qrMagnification = dpi === 300 ? 12 : 9;
    const marginX = dpi === 300 ? 72 : 48;
    const qrY = dpi === 300 ? 180 : 120;
    const codeY = dpi === 300 ? 640 : 440;
    const captionY = dpi === 300 ? 730 : 500;
    const subCaptionY = dpi === 300 ? 800 : 550;
    const headerY = dpi === 300 ? 60 : 40;

    const zplLines: string[] = [
      '^XA',
      '^CI28',
      `^PW${widthDots}`,
      `^LL${heightDots}`,
    ];

    if (organizationLabel) {
      zplLines.push(
        `^FO${marginX},${headerY}^A0N,${dpi === 300 ? 36 : 24},${dpi === 300 ? 36 : 24}^FH\\^FD${escapeZplHex(organizationLabel)}^FS`,
      );
    }

    zplLines.push(
      `^FO${marginX},${qrY}^BQN,2,${qrMagnification}^FH\\^FDMA,${escapeZplHex(code)}^FS`,
    );
    zplLines.push(
      `^FO${marginX},${codeY}^A0N,${dpi === 300 ? 54 : 36},${dpi === 300 ? 54 : 36}^FH\\^FD${escapeZplHex(code)}^FS`,
    );

    if (caption) {
      zplLines.push(
        `^FO${marginX},${captionY}^A0N,${dpi === 300 ? 40 : 28},${dpi === 300 ? 40 : 28}^FH\\^FD${escapeZplHex(caption)}^FS`,
      );
    }

    if (subCaption) {
      zplLines.push(
        `^FO${marginX},${subCaptionY}^A0N,${dpi === 300 ? 32 : 22},${dpi === 300 ? 32 : 22}^FH\\^FD${escapeZplHex(subCaption)}^FS`,
      );
    }

    zplLines.push('^XZ');
    return zplLines.join('\n');
  }
}
