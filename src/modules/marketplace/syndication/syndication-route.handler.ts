import { PolicyConfigError } from '@/core/config/policy-loader';
import { DomainRuleError } from '@/core/domain';
import { StorageError } from '@/core/ports/storage.port';
import {
  AuthError,
  type AuthSessionContext,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import { EbayCsvExporterUseCase } from './ebay-csv-exporter.use-case';
import { LocalClassifiedsQueueUseCase } from './local-classifieds-queue.use-case';
import {
  ConfirmEbayLiveCommandSchema,
  ExportEbayCsvCommandSchema,
  LocalQueuePatchSchema,
  RESERVED_URGENT_DELIST_QUEUE_SLUG,
  SyndicationError,
} from './syndication.contracts';
import {
  createProductionEbayCsvExporterUseCase,
  createProductionLocalClassifiedsQueueUseCase,
} from './syndication.repository';

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
} as const;

const ALLOWED_EBAY_CSV_GET_PARAMS = new Set([
  'exportId',
  'format',
  'preview',
  'partIds',
  'download',
  'response',
]);

export interface SyndicationRouteDeps {
  readonly resolveSession?: (options?: {
    isMutationContext?: boolean;
  }) => Promise<AuthSessionContext>;
  readonly ebayExporterUseCase?: Pick<
    EbayCsvExporterUseCase,
    | 'exportEbaySellerHubCsv'
    | 'getCommittedExport'
    | 'previewEbaySellerHubCsv'
    | 'confirmEbayListingLive'
    | 'exportB2bPowertrainSheet'
  >;
  readonly localQueueUseCase?: Pick<
    LocalClassifiedsQueueUseCase,
    | 'getLocalAdPayload'
    | 'markPostedToClassifieds'
    | 'listUrgentDelistQueue'
    | 'confirmManualChannelDelist'
  >;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    },
  });
}

function csvResponse(
  status: number,
  csvContent: string,
  filename: string,
): Response {
  return new Response(csvContent, {
    status,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...SECURITY_HEADERS,
    },
  });
}

function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(status, { error: { code, message } });
}

function handleErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof StorageError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof DomainRuleError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof SyndicationError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof PolicyConfigError) {
    return jsonErrorResponse(422, error.code, error.message);
  }
  return jsonErrorResponse(
    500,
    'INTERNAL_SERVER_ERROR',
    'Unexpected error processing syndication request.',
  );
}

function assertSameOriginIfBrowserRequest(request: Request): void {
  const originHeader = request.headers.get('origin');
  if (originHeader === null) {
    return;
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    throw new AuthError('CAPABILITY_FORBIDDEN', 'Invalid request URL origin.');
  }
  const forwardedHost = request.headers.get('x-forwarded-host');
  const hostHeader = forwardedHost ?? request.headers.get('host');
  const protoHeader =
    request.headers.get('x-forwarded-proto') ??
    requestUrl.protocol.replace(/:$/, '');
  const expectedOrigin = hostHeader
    ? `${protoHeader}://${hostHeader}`
    : requestUrl.origin;

  if (originHeader !== expectedOrigin && originHeader !== requestUrl.origin) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      'Cross-origin mutation request rejected.',
    );
  }
}

function requireIdempotencyHeader(request: Request): string {
  const headerKey = request.headers.get('idempotency-key');
  if (!headerKey || !isValidUuid(headerKey.trim())) {
    throw new SyndicationError(
      'INVALID_SYNDICATION_INPUT',
      'Header "Idempotency-Key" must be a valid UUID string.',
    );
  }
  return headerKey.trim().toLowerCase();
}

function assertHeaderBodyIdempotencyMatch(
  bodyRecord: Record<string, unknown>,
  normalizedHeaderKey: string,
): void {
  if (bodyRecord.idempotencyKey !== undefined) {
    if (
      typeof bodyRecord.idempotencyKey !== 'string' ||
      bodyRecord.idempotencyKey.trim().toLowerCase() !== normalizedHeaderKey
    ) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'Body idempotencyKey must match Idempotency-Key header when provided.',
      );
    }
  }
}

async function parseJsonBodyObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const rawContentType = request.headers.get('content-type') ?? '';
  const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();
  if (mimeType !== 'application/json') {
    throw new SyndicationError(
      'INVALID_SYNDICATION_INPUT',
      'Request requires Content-Type: application/json.',
    );
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new SyndicationError(
      'INVALID_SYNDICATION_INPUT',
      'Malformed JSON request body.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyndicationError(
      'INVALID_SYNDICATION_INPUT',
      'JSON request body must be an object.',
    );
  }
  return parsed as Record<string, unknown>;
}

export async function handleEbayCsvGet(
  request: Request,
  deps: SyndicationRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: false });

    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_EBAY_CSV_GET_PARAMS.has(key)) {
        throw new SyndicationError(
          'INVALID_SYNDICATION_INPUT',
          `Unsupported query parameter "${key}".`,
        );
      }
    }

    const useCase =
      deps.ebayExporterUseCase ?? createProductionEbayCsvExporterUseCase();

    const exportId = url.searchParams.get('exportId');
    if (exportId !== null) {
      const committed = await useCase.getCommittedExport(session, exportId);
      if (url.searchParams.get('response') === 'json') {
        return jsonResponse(200, committed);
      }
      return csvResponse(
        200,
        committed.csvContent,
        `ebay-seller-hub-${committed.exportId}.csv`,
      );
    }

    const format = url.searchParams.get('format');
    if (format === 'b2b-powertrain') {
      const sheet = await useCase.exportB2bPowertrainSheet(session);
      if (url.searchParams.get('download') === 'csv') {
        return csvResponse(
          200,
          sheet.csvContent,
          'b2b-mechanic-powertrain.csv',
        );
      }
      return jsonResponse(200, sheet);
    }
    if (format !== null) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        `Unsupported format "${format}".`,
      );
    }

    const rawPartIds = url.searchParams.get('partIds');
    const partIds =
      rawPartIds && rawPartIds.trim().length > 0
        ? rawPartIds.split(',').map((s) => s.trim())
        : undefined;
    const preview = await useCase.previewEbaySellerHubCsv(session, partIds);
    return jsonResponse(200, preview);
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleEbayCsvPost(
  request: Request,
  deps: SyndicationRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const idempotencyKey = requireIdempotencyHeader(request);
    const body = await parseJsonBodyObject(request);
    assertHeaderBodyIdempotencyMatch(body, idempotencyKey);

    const parsed = ExportEbayCsvCommandSchema.safeParse({
      ...body,
      idempotencyKey,
    });
    if (!parsed.success) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const useCase =
      deps.ebayExporterUseCase ?? createProductionEbayCsvExporterUseCase();
    const result = await useCase.exportEbaySellerHubCsv(session, parsed.data);
    return jsonResponse(200, result);
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleEbayCsvPatch(
  request: Request,
  deps: SyndicationRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const idempotencyKey = requireIdempotencyHeader(request);
    const body = await parseJsonBodyObject(request);
    assertHeaderBodyIdempotencyMatch(body, idempotencyKey);

    const parsed = ConfirmEbayLiveCommandSchema.safeParse({
      ...body,
      idempotencyKey,
    });
    if (!parsed.success) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const useCase =
      deps.ebayExporterUseCase ?? createProductionEbayCsvExporterUseCase();
    const result = await useCase.confirmEbayListingLive(
      session,
      parsed.data.partId,
      parsed.data.ebayListingId,
      {
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey,
      },
    );
    return jsonResponse(200, result);
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleLocalAdPayloadGet(
  request: Request,
  sku: string,
  deps: SyndicationRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: false });

    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length > 0) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'Unexpected query parameters on local-ad-payload endpoint.',
      );
    }

    const useCase =
      deps.localQueueUseCase ?? createProductionLocalClassifiedsQueueUseCase();
    if (sku === RESERVED_URGENT_DELIST_QUEUE_SLUG) {
      const queue = await useCase.listUrgentDelistQueue(session);
      return jsonResponse(200, queue);
    }

    const payload = await useCase.getLocalAdPayload(session, sku);
    return jsonResponse(200, payload);
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleLocalAdPayloadPatch(
  request: Request,
  sku: string,
  deps: SyndicationRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const idempotencyKey = requireIdempotencyHeader(request);

    if (sku === RESERVED_URGENT_DELIST_QUEUE_SLUG) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        'PATCH is not valid on the reserved urgent-delist-queue view; target a concrete SKU.',
      );
    }

    const body = await parseJsonBodyObject(request);
    assertHeaderBodyIdempotencyMatch(body, idempotencyKey);

    const parsed = LocalQueuePatchSchema.safeParse({
      ...body,
      idempotencyKey,
    });
    if (!parsed.success) {
      throw new SyndicationError(
        'INVALID_SYNDICATION_INPUT',
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
      );
    }

    const useCase =
      deps.localQueueUseCase ?? createProductionLocalClassifiedsQueueUseCase();

    if (parsed.data.action === 'mark-posted') {
      const result = await useCase.markPostedToClassifieds(session, {
        qrSkuCodeOrPartId: sku,
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey,
      });
      return jsonResponse(200, result);
    }

    const result = await useCase.confirmManualChannelDelist(session, {
      qrSkuCodeOrPartId: sku,
      channel: parsed.data.channel,
      expectedVersion: parsed.data.expectedVersion,
      idempotencyKey,
    });
    return jsonResponse(200, result);
  } catch (error) {
    return handleErrorResponse(error);
  }
}
