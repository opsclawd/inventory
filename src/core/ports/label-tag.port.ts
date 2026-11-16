/**
 * Canonical QR hang-tag sheet & Zebra ZPL II label port contracts (`ADR-0002` / `ADR-0004` / `RULE-TAG-001`).
 *
 * Pure port module: zero imports from Prisma, Next.js, React, QR encoders, or browser APIs.
 * Shared software component across tenants; each organization prints onto its own physical stock.
 */

export const GRID_PRESETS = ['12_UP_3X4', '16_UP_4X4'] as const;
export type GridPreset = (typeof GRID_PRESETS)[number];

export const PUNCH_STYLES = [
  'SINGLE_OVAL_SLOT_15X4MM',
  'DUAL_TOP_RACK_HOLES',
] as const;
export type PunchStyle = (typeof PUNCH_STYLES)[number];

export const MAX_TAG_SHEET_TAGS = 1000 as const;
export const MAX_TAG_CODE_LENGTH = 40 as const;
export const MAX_TAG_CAPTION_LENGTH = 64 as const;
export const MIN_QR_CORE_INCHES = 1.5 as const;
export const MIN_QR_QUIET_ZONE_MODULES = 4 as const;

export type LabelTagErrorCode =
  | 'LABEL_INVALID_INPUT'
  | 'LABEL_EMPTY_INPUT'
  | 'LABEL_DUPLICATE_CODE'
  | 'LABEL_INVALID_CODE'
  | 'LABEL_INVALID_RANGE'
  | 'LABEL_LIMIT_EXCEEDED'
  | 'LABEL_UNSUPPORTED_PRESET'
  | 'LABEL_INVALID_CAPTION'
  | 'LABEL_QR_CAPACITY_EXCEEDED';

export type LabelTagErrorStatus = 400 | 422;

const LABEL_TAG_ERROR_STATUS_BY_CODE: Readonly<
  Record<LabelTagErrorCode, LabelTagErrorStatus>
> = {
  LABEL_INVALID_INPUT: 400,
  LABEL_EMPTY_INPUT: 400,
  LABEL_DUPLICATE_CODE: 400,
  LABEL_INVALID_CODE: 400,
  LABEL_INVALID_RANGE: 400,
  LABEL_LIMIT_EXCEEDED: 400,
  LABEL_UNSUPPORTED_PRESET: 400,
  LABEL_INVALID_CAPTION: 400,
  LABEL_QR_CAPACITY_EXCEEDED: 422,
};

/**
 * Typed fail-closed error thrown by `ILabelTagPort` validators and generators.
 */
export class LabelTagError extends Error {
  public readonly code: LabelTagErrorCode;
  public readonly status: LabelTagErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: LabelTagErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'LabelTagError';
    this.code = code;
    this.status = LABEL_TAG_ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface TagDescriptor {
  readonly code: string;
  readonly caption?: string;
}

export interface SequentialTagRange {
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
  readonly width?: number;
  readonly captionPrefix?: string;
}

export interface LetterQrTagSheetBaseOptions {
  readonly gridPreset?: GridPreset;
  readonly punchStyle?: PunchStyle;
  readonly organizationLabel?: string;
}

export type GenerateLetterQrTagSheetInput =
  | (LetterQrTagSheetBaseOptions & {
      readonly mode?: 'DESCRIPTORS';
      readonly descriptors: readonly TagDescriptor[];
      readonly range?: never;
    })
  | (LetterQrTagSheetBaseOptions & {
      readonly mode?: 'RANGE';
      readonly range: SequentialTagRange;
      readonly descriptors?: never;
    });

export interface GenerateZplLabelInput {
  readonly code: string;
  readonly caption?: string;
  readonly subCaption?: string;
  readonly organizationLabel?: string;
  readonly dpi?: 203 | 300;
  readonly widthDots?: number;
  readonly heightDots?: number;
}

export interface LetterQrTagSheetResult {
  readonly svgPages: readonly string[];
  readonly pdfBytes: Uint8Array;
  readonly pageCount: number;
  readonly tagCount: number;
  readonly gridPreset: GridPreset;
  readonly punchStyle: PunchStyle;
}

/**
 * Shared software QR hang-tag sheet (`8.5" x 11"` Letter SVG + PDF 1.4) and
 * Zebra ZPL II label generator contract.
 */
export interface ILabelTagPort {
  generateLetterQrTagSheet(
    input: GenerateLetterQrTagSheetInput,
  ): LetterQrTagSheetResult;
  generateZplLabel(input: GenerateZplLabelInput): string;
}
