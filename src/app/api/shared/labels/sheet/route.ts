import type { OrganizationType, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  type GenerateLetterQrTagSheetInput,
  GRID_PRESETS,
  type GridPreset,
  type ILabelTagPort,
  LabelTagError,
  PUNCH_STYLES,
  type PunchStyle,
} from '@/core/ports/label-tag.port';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  type CapabilityId,
  resolveAuthSessionContext,
  toTenantExecutionContext,
  translateTenantContextError,
} from '@/modules/shared-ops/auth';
import { LocationCustodyError } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import {
  expandSequentialTagRange,
  QrTagSheetAndZplGenerator,
  validateCanonicalTagCode,
} from '@/modules/shared-ops/locations-qr/qr-tag-sheet-and-zpl.generator';

export const runtime = 'nodejs';

const ALLOWED_GET_PARAMS = new Set([
  'prefix',
  'start',
  'end',
  'width',
  'captionPrefix',
  'gridPreset',
  'punchStyle',
  'format',
  'page',
  'organizationLabel',
]);

const SheetFormatSchema = z.enum(['pdf', 'svg']);
const GridPresetSchema = z.enum(GRID_PRESETS);
const PunchStyleSchema = z.enum(PUNCH_STYLES);

const TagDescriptorBodySchema = z
  .object({
    code: z.string(),
    caption: z.string().optional(),
  })
  .strict();

const SequentialRangeBodySchema = z
  .object({
    prefix: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    captionPrefix: z.string().optional(),
  })
  .strict();

const PostSheetBodySchema = z
  .object({
    mode: z.enum(['DESCRIPTORS', 'RANGE']).optional(),
    descriptors: z.array(TagDescriptorBodySchema).optional(),
    range: SequentialRangeBodySchema.optional(),
    gridPreset: GridPresetSchema.optional(),
    punchStyle: PunchStyleSchema.optional(),
    format: SheetFormatSchema.optional(),
    page: z.number().int().min(1).optional(),
    organizationLabel: z.string().optional(),
  })
  .strict();

export type LabelSheetTenantInspection =
  | {
      readonly mode: 'DESCRIPTORS';
      readonly locationBarcodes: readonly string[];
    }
  | {
      readonly mode: 'RANGE';
      readonly rangeLocationSiteCode: string | null;
    };

export interface LabelSheetTenantPrintContext {
  readonly organizationName: string;
}

export interface LabelSheetRepository {
  verifyAndResolveTenantPrintContext(
    ctx: TenantExecutionContext,
    activeOrganizationType: OrganizationType,
    inspection: LabelSheetTenantInspection,
  ): Promise<LabelSheetTenantPrintContext>;
}

export interface LabelSheetRouteDeps {
  readonly resolveSession?: () => Promise<AuthSessionContext>;
  readonly repository?: LabelSheetRepository;
  readonly generator?: ILabelTagPort;
}

async function resolveRuntimePrisma(
  explicitPrisma?: PrismaClient,
): Promise<PrismaClient> {
  if (explicitPrisma) {
    return explicitPrisma;
  }
  const mod = await import('@/infrastructure/db/prisma');
  return mod.prisma;
}

/**
 * Production `LabelSheetRepository` executing inside `withTenantTransaction` (`FORCE RLS`)
 * to revalidate live active `OrganizationMembership` and scope location descriptors strictly
 * to the caller's active `Organization`.
 */
export function createPrismaLabelSheetRepository(options?: {
  readonly prisma?: PrismaClient;
}): LabelSheetRepository {
  const explicitPrisma = options?.prisma;

  return {
    async verifyAndResolveTenantPrintContext(
      ctx: TenantExecutionContext,
      activeOrganizationType: OrganizationType,
      inspection: LabelSheetTenantInspection,
    ): Promise<LabelSheetTenantPrintContext> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const org = await tx.organization.findUnique({
            where: { id: ctx.organizationId },
            select: { name: true },
          });
          if (!org) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Active organization is unavailable.',
            );
          }

          if (
            inspection.mode === 'DESCRIPTORS' &&
            inspection.locationBarcodes.length > 0
          ) {
            const uniqueBarcodes = [...new Set(inspection.locationBarcodes)];
            const rows = await tx.storageLocation.findMany({
              where: {
                organizationId: ctx.organizationId,
                fullQrBarcode: { in: uniqueBarcodes },
              },
              select: {
                fullQrBarcode: true,
                allowedOrgType: true,
              },
            });

            const byBarcode = new Map(
              rows.map((r) => [r.fullQrBarcode, r.allowedOrgType]),
            );

            for (const barcode of uniqueBarcodes) {
              const allowedType = byBarcode.get(barcode);
              if (!allowedType || allowedType !== activeOrganizationType) {
                throw new LocationCustodyError(
                  'SITE_ZONING_VIOLATION',
                  `Location barcode "${barcode}" is unauthorized or unavailable in the active organization.`,
                );
              }
            }
          } else if (
            inspection.mode === 'RANGE' &&
            inspection.rangeLocationSiteCode !== null
          ) {
            const siteRow = await tx.storageLocation.findFirst({
              where: {
                organizationId: ctx.organizationId,
                siteCode: inspection.rangeLocationSiteCode,
                allowedOrgType: activeOrganizationType,
              },
              select: { id: true },
            });
            if (!siteRow) {
              throw new LocationCustodyError(
                'SITE_ZONING_VIOLATION',
                `Location site "${inspection.rangeLocationSiteCode}" is unauthorized or unavailable in the active organization.`,
              );
            }
          }

          return { organizationName: org.name };
        });
      } catch (error) {
        translateTenantContextError(error);
      }
    },
  };
}

function classifyCodeRequirements(code: string): {
  readonly capabilities: readonly CapabilityId[];
  readonly isLocationBarcode: boolean;
  readonly isLotCode: boolean;
} {
  if (code.startsWith('LOT-')) {
    return {
      capabilities: [],
      isLocationBarcode: false,
      isLotCode: true,
    };
  }
  if (code.startsWith('PRT-')) {
    return {
      capabilities: ['FR-INT-02:create'],
      isLocationBarcode: false,
      isLotCode: false,
    };
  }
  if (code.startsWith('AST-')) {
    return {
      capabilities: ['FR-INT-01:create'],
      isLocationBarcode: false,
      isLotCode: false,
    };
  }
  if (code.startsWith('PLT-')) {
    return {
      capabilities: ['FR-LOG-01:execute-scan'],
      isLocationBarcode: false,
      isLotCode: false,
    };
  }
  return {
    capabilities: ['FR-INT-02:create'],
    isLocationBarcode: true,
    isLotCode: false,
  };
}

function extractLocationSiteCode(prefixOrBarcode: string): string | null {
  const firstDelim = prefixOrBarcode.search(/[-_]/);
  if (firstDelim <= 0) {
    return null;
  }
  return prefixOrBarcode.slice(0, firstDelim);
}

function assertSheetCapabilitiesAndInspectTenantRequirements(
  session: AuthSessionContext,
  sheetInput: GenerateLetterQrTagSheetInput,
): LabelSheetTenantInspection {
  const requiredCaps = new Set<CapabilityId>();

  if (sheetInput.range !== undefined) {
    const expanded = expandSequentialTagRange(sheetInput.range);
    const firstCode = expanded[0]!.code;
    const classified = classifyCodeRequirements(firstCode);
    if (classified.isLotCode) {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        'Phase 1A label sheet endpoint does not permit cannabis LOT descriptors.',
      );
    }
    for (const cap of classified.capabilities) {
      requiredCaps.add(cap);
    }
    for (const cap of requiredCaps) {
      assertCapability(session, cap);
    }
    return {
      mode: 'RANGE',
      rangeLocationSiteCode: classified.isLocationBarcode
        ? extractLocationSiteCode(sheetInput.range.prefix)
        : null,
    };
  }

  const locationBarcodes: string[] = [];
  for (const descriptor of sheetInput.descriptors!) {
    const code = validateCanonicalTagCode(descriptor.code);
    const classified = classifyCodeRequirements(code);
    if (classified.isLotCode) {
      throw new AuthError(
        'CAPABILITY_FORBIDDEN',
        'Phase 1A label sheet endpoint does not permit cannabis LOT descriptors.',
      );
    }
    for (const cap of classified.capabilities) {
      requiredCaps.add(cap);
    }
    if (classified.isLocationBarcode) {
      locationBarcodes.push(code);
    }
  }

  for (const cap of requiredCaps) {
    assertCapability(session, cap);
  }

  return {
    mode: 'DESCRIPTORS',
    locationBarcodes,
  };
}

function parseStrictNonNegativeIntParam(
  raw: string | null,
  name: string,
): number {
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      `Query parameter "${name}" must be a non-negative integer.`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      `Query parameter "${name}" is out of safe integer range.`,
    );
  }
  return parsed;
}

function parseGetRequest(request: Request): {
  readonly sheetInput: GenerateLetterQrTagSheetInput;
  readonly format: 'pdf' | 'svg';
  readonly page: number;
} {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_GET_PARAMS.has(key)) {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        `Unknown query parameter: "${key}".`,
      );
    }
    if (url.searchParams.getAll(key).length > 1) {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        `Duplicate query parameter: "${key}".`,
      );
    }
  }

  const prefix = url.searchParams.get('prefix');
  if (prefix === null || prefix.length === 0) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'Query parameter "prefix" is required for GET /api/shared/labels/sheet.',
    );
  }

  const start = parseStrictNonNegativeIntParam(
    url.searchParams.get('start'),
    'start',
  );
  const end = parseStrictNonNegativeIntParam(
    url.searchParams.get('end'),
    'end',
  );

  const rawWidth = url.searchParams.get('width');
  let width: number | undefined;
  if (rawWidth !== null) {
    width = parseStrictNonNegativeIntParam(rawWidth, 'width');
    if (width < 1) {
      throw new LabelTagError(
        'LABEL_INVALID_RANGE',
        'Query parameter "width" must be at least 1.',
      );
    }
  }

  const rawFormat = url.searchParams.get('format') ?? 'pdf';
  const formatResult = SheetFormatSchema.safeParse(rawFormat);
  if (!formatResult.success) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      `Unsupported format: "${rawFormat}". Expected "pdf" or "svg".`,
    );
  }

  const rawPage = url.searchParams.get('page');
  let page = 1;
  if (rawPage !== null) {
    page = parseStrictNonNegativeIntParam(rawPage, 'page');
    if (page < 1) {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        'Query parameter "page" must be at least 1.',
      );
    }
  }

  const rawGrid = url.searchParams.get('gridPreset') ?? '12_UP_3X4';
  const gridResult = GridPresetSchema.safeParse(rawGrid);
  if (!gridResult.success) {
    throw new LabelTagError(
      'LABEL_UNSUPPORTED_PRESET',
      `Unsupported gridPreset: "${rawGrid}".`,
    );
  }

  const rawPunch =
    url.searchParams.get('punchStyle') ?? 'SINGLE_OVAL_SLOT_15X4MM';
  const punchResult = PunchStyleSchema.safeParse(rawPunch);
  if (!punchResult.success) {
    throw new LabelTagError(
      'LABEL_UNSUPPORTED_PRESET',
      `Unsupported punchStyle: "${rawPunch}".`,
    );
  }

  const captionPrefix = url.searchParams.get('captionPrefix') ?? undefined;
  const organizationLabel =
    url.searchParams.get('organizationLabel') ?? undefined;

  return {
    sheetInput: {
      mode: 'RANGE',
      range: {
        prefix,
        start,
        end,
        ...(width !== undefined ? { width } : {}),
        ...(captionPrefix !== undefined ? { captionPrefix } : {}),
      },
      gridPreset: gridResult.data as GridPreset,
      punchStyle: punchResult.data as PunchStyle,
      ...(organizationLabel !== undefined ? { organizationLabel } : {}),
    },
    format: formatResult.data,
    page,
  };
}

async function parsePostRequest(request: Request): Promise<{
  readonly sheetInput: GenerateLetterQrTagSheetInput;
  readonly format: 'pdf' | 'svg';
  readonly page: number;
}> {
  const rawContentType = request.headers.get('content-type') ?? '';
  const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();
  if (mimeType !== 'application/json') {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'POST /api/shared/labels/sheet requires Content-Type: application/json.',
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = await request.json();
  } catch {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'Malformed JSON request body.',
    );
  }

  const bodyResult = PostSheetBodySchema.safeParse(parsedJson);
  if (!bodyResult.success) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      `Invalid label sheet request body: ${bodyResult.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const body = bodyResult.data;
  const format = body.format ?? 'pdf';
  const page = body.page ?? 1;
  const gridPreset = body.gridPreset ?? '12_UP_3X4';
  const punchStyle = body.punchStyle ?? 'SINGLE_OVAL_SLOT_15X4MM';

  if (body.descriptors !== undefined && body.range !== undefined) {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'Cannot combine descriptors and range in the same request.',
    );
  }
  if (body.descriptors === undefined && body.range === undefined) {
    throw new LabelTagError(
      'LABEL_EMPTY_INPUT',
      'Request body must provide either descriptors or range.',
    );
  }

  if (body.range !== undefined) {
    if (body.mode === 'DESCRIPTORS') {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        'mode "DESCRIPTORS" cannot be paired with range.',
      );
    }
    return {
      sheetInput: {
        mode: 'RANGE',
        range: body.range,
        gridPreset,
        punchStyle,
        ...(body.organizationLabel !== undefined
          ? { organizationLabel: body.organizationLabel }
          : {}),
      },
      format,
      page,
    };
  }

  if (body.mode === 'RANGE') {
    throw new LabelTagError(
      'LABEL_INVALID_INPUT',
      'mode "RANGE" cannot be paired with descriptors.',
    );
  }

  return {
    sheetInput: {
      mode: 'DESCRIPTORS',
      descriptors: body.descriptors!,
      gridPreset,
      punchStyle,
      ...(body.organizationLabel !== undefined
        ? { organizationLabel: body.organizationLabel }
        : {}),
    },
    format,
    page,
  };
}

function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

function handleErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof LabelTagError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof LocationCustodyError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  return jsonErrorResponse(
    500,
    'INTERNAL_SERVER_ERROR',
    'Unexpected error generating label sheet.',
  );
}

async function executeLabelSheetRequest(
  parseFn: () => Promise<{
    readonly sheetInput: GenerateLetterQrTagSheetInput;
    readonly format: 'pdf' | 'svg';
    readonly page: number;
  }>,
  deps: LabelSheetRouteDeps,
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? (() => resolveAuthSessionContext());
    const session = await resolveSession();

    const { sheetInput, format, page } = await parseFn();

    const inspection = assertSheetCapabilitiesAndInspectTenantRequirements(
      session,
      sheetInput,
    );

    const generator = deps.generator ?? new QrTagSheetAndZplGenerator();
    // Validate and generate descriptors/range upfront so invalid codes/ranges fail
    // deterministically before database I/O, while tenant print context resolves inside RLS.
    const repository = deps.repository ?? createPrismaLabelSheetRepository();
    const ctx = toTenantExecutionContext(session);
    const tenantPrintCtx = await repository.verifyAndResolveTenantPrintContext(
      ctx,
      session.activeOrganizationType,
      inspection,
    );

    const effectiveInput: GenerateLetterQrTagSheetInput = {
      ...sheetInput,
      organizationLabel:
        sheetInput.organizationLabel ?? tenantPrintCtx.organizationName,
    };

    const result = generator.generateLetterQrTagSheet(effectiveInput);

    if (page > result.pageCount) {
      throw new LabelTagError(
        'LABEL_INVALID_INPUT',
        `Requested page ${page} exceeds generated pageCount ${result.pageCount}.`,
        { page, pageCount: result.pageCount },
      );
    }

    const commonHeaders = {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Page-Count': String(result.pageCount),
      'X-Tag-Count': String(result.tagCount),
    };

    if (format === 'svg') {
      const svgContent = result.svgPages[page - 1];
      if (svgContent === undefined) {
        throw new LabelTagError(
          'LABEL_INVALID_INPUT',
          `Requested SVG page ${page} is unavailable.`,
        );
      }
      return new Response(svgContent, {
        status: 200,
        headers: {
          ...commonHeaders,
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Disposition': `inline; filename="qr-tag-sheet-page-${page}.svg"`,
        },
      });
    }

    return new Response(Buffer.from(result.pdfBytes), {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="qr-tag-sheet.pdf"',
      },
    });
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleLabelSheetGet(
  request: Request,
  deps: LabelSheetRouteDeps = {},
): Promise<Response> {
  return executeLabelSheetRequest(
    async () => parseGetRequest(request),
    deps,
  );
}

export async function handleLabelSheetPost(
  request: Request,
  deps: LabelSheetRouteDeps = {},
): Promise<Response> {
  return executeLabelSheetRequest(() => parsePostRequest(request), deps);
}

export async function GET(request: Request): Promise<Response> {
  return handleLabelSheetGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleLabelSheetPost(request);
}
