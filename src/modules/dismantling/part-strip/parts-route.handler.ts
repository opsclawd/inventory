import { DomainRuleError } from '@/core/domain';
import { StorageError } from '@/core/ports/storage.port';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import { LocationCustodyError } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import { CompleteHulkScrapUseCase } from './complete-hulk-scrap.use-case';
import { LogScrapComponentUseCase } from './log-scrap-component.use-case';
import {
  type CompleteHulkCommand,
  type InspectReturnCommand,
  type LogScrapCommand,
  MAX_MULTIPART_METADATA_BYTES,
  MAX_MULTIPART_REQUEST_BYTES,
  MAX_PART_PHOTO_BYTES,
  MAX_SCRAP_TICKET_BYTES,
  PartStripError,
  type ReceiveReturnCommand,
  type StripPartCommand,
  type StripPartPhotoInput,
} from './part-strip.contracts';
import {
  createProductionCompleteHulkScrapUseCase,
  createProductionLogScrapComponentUseCase,
  createProductionStripPartUseCase,
} from './part-strip.repository';
import { StripPartUseCase } from './strip-part.use-case';

const ALLOWED_GET_PARAMS = new Set([
  'view',
  'limit',
  'donorVehicleId',
  'partId',
  'qrSkuCode',
  'scrapLogId',
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface SalvagePartsRouteDeps {
  readonly resolveSession?: (options?: {
    isMutationContext?: boolean;
  }) => Promise<AuthSessionContext>;
  readonly stripPartUseCase?: Pick<
    StripPartUseCase,
    | 'execute'
    | 'receiveReturnedPartIntoQcHold'
    | 'completeReturnQcInspection'
    | 'listDonors'
    | 'listParts'
    | 'listScrapHistory'
    | 'getScrapTicketPresignedUrl'
  >;
  readonly logScrapUseCase?: Pick<LogScrapComponentUseCase, 'execute'>;
  readonly completeHulkUseCase?: Pick<CompleteHulkScrapUseCase, 'execute'>;
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

function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(status, {
    error: {
      code,
      message,
    },
  });
}

function handleErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof StorageError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof LocationCustodyError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof DomainRuleError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof PartStripError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  return jsonErrorResponse(
    500,
    'INTERNAL_SERVER_ERROR',
    'Unexpected error processing part strip request.',
  );
}

function requireIdempotencyHeader(request: Request): string {
  const headerKey = request.headers.get('idempotency-key');
  if (!headerKey || !isValidUuid(headerKey.trim())) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
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
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Body idempotencyKey must match Idempotency-Key header when provided.',
      );
    }
  }
}

function isFileEntry(value: FormDataEntryValue): value is File {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as File).arrayBuffer === 'function' &&
    typeof (value as File).size === 'number'
  );
}

async function parseMultipartMetadata(
  formData: FormData,
): Promise<Record<string, unknown>> {
  const metaEntries = formData.getAll('metadata');
  if (metaEntries.length !== 1 || typeof metaEntries[0] !== 'string') {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      'Multipart request requires exactly one JSON "metadata" string field.',
    );
  }

  const rawMeta = metaEntries[0];
  if (Buffer.byteLength(rawMeta, 'utf8') > MAX_MULTIPART_METADATA_BYTES) {
    throw new PartStripError(
      'PAYLOAD_TOO_LARGE',
      `Multipart metadata exceeds ${MAX_MULTIPART_METADATA_BYTES} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMeta);
  } catch {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      'Multipart "metadata" field must contain valid JSON.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      'Multipart "metadata" JSON must be an object.',
    );
  }

  return parsed as Record<string, unknown>;
}

async function readBoundedFileBytes(
  file: File,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (file.size <= 0) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `${label} must not be empty.`,
    );
  }
  if (file.size > maxBytes) {
    throw new PartStripError(
      'PAYLOAD_TOO_LARGE',
      `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
    );
  }
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  if (bytes.byteLength === 0) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `${label} must not be empty.`,
    );
  }
  if (bytes.byteLength > maxBytes) {
    throw new PartStripError(
      'PAYLOAD_TOO_LARGE',
      `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
    );
  }
  return bytes;
}

export async function handleSalvagePartsPost(
  request: Request,
  deps: SalvagePartsRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    assertCapability(session, 'FR-INT-02');

    const rawContentType = request.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();
    if (mimeType !== 'multipart/form-data') {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'POST /api/salvage/parts requires Content-Type: multipart/form-data.',
      );
    }

    const normalizedHeaderKey = requireIdempotencyHeader(request);

    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declaredBytes = Number(contentLengthHeader);
      if (
        Number.isFinite(declaredBytes) &&
        declaredBytes > MAX_MULTIPART_REQUEST_BYTES + MAX_MULTIPART_METADATA_BYTES
      ) {
        throw new PartStripError(
          'PAYLOAD_TOO_LARGE',
          `Multipart request exceeds maximum size of ${MAX_MULTIPART_REQUEST_BYTES} bytes.`,
        );
      }
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Malformed multipart/form-data request body.',
      );
    }

    const metadata = await parseMultipartMetadata(formData);
    assertHeaderBodyIdempotencyMatch(metadata, normalizedHeaderKey);

    const action = metadata.action;

    if (action === 'strip') {
      const allowedKeys = new Set([
        'metadata',
        'photos',
        'photo1',
        'photo2',
        'photo3',
      ]);
      for (const key of formData.keys()) {
        if (!allowedKeys.has(key)) {
          throw new PartStripError(
            'INVALID_PART_STRIP_INPUT',
            `Unexpected multipart field "${key}" for action=strip.`,
          );
        }
      }

      const arrayPhotos = formData.getAll('photos');
      const p1 = formData.getAll('photo1');
      const p2 = formData.getAll('photo2');
      const p3 = formData.getAll('photo3');

      let photoFiles: File[];
      if (arrayPhotos.length > 0) {
        if (p1.length > 0 || p2.length > 0 || p3.length > 0) {
          throw new PartStripError(
            'INVALID_PART_STRIP_INPUT',
            'Provide either "photos" (3 files) or "photo1"/"photo2"/"photo3", not both.',
          );
        }
        if (arrayPhotos.length !== 3 || !arrayPhotos.every(isFileEntry)) {
          throw new PartStripError(
            'INVALID_PART_STRIP_INPUT',
            'Exactly 3 image file entries are required under "photos".',
          );
        }
        photoFiles = arrayPhotos;
      } else {
        if (
          p1.length !== 1 ||
          p2.length !== 1 ||
          p3.length !== 1 ||
          !isFileEntry(p1[0]!) ||
          !isFileEntry(p2[0]!) ||
          !isFileEntry(p3[0]!)
        ) {
          throw new PartStripError(
            'INVALID_PART_STRIP_INPUT',
            'Exactly 3 image files ("photos" or "photo1"/"photo2"/"photo3") are required.',
          );
        }
        photoFiles = [p1[0]!, p2[0]!, p3[0]!];
      }

      let aggregateBytes = Buffer.byteLength(
        JSON.stringify(metadata),
        'utf8',
      );
      const photoInputs: StripPartPhotoInput[] = [];
      for (let i = 0; i < photoFiles.length; i += 1) {
        const file = photoFiles[i]!;
        const bytes = await readBoundedFileBytes(
          file,
          MAX_PART_PHOTO_BYTES,
          `Photo ${i + 1}`,
        );
        aggregateBytes += bytes.byteLength;
        if (aggregateBytes > MAX_MULTIPART_REQUEST_BYTES) {
          throw new PartStripError(
            'PAYLOAD_TOO_LARGE',
            `Aggregate multipart payload exceeds ${MAX_MULTIPART_REQUEST_BYTES} bytes.`,
          );
        }
        photoInputs.push({ bytes, filename: file.name });
      }

      const useCase =
        deps.stripPartUseCase ?? createProductionStripPartUseCase();
      const result = await useCase.execute(session, {
        ...metadata,
        idempotencyKey: normalizedHeaderKey,
        photos: photoInputs as unknown as StripPartCommand['photos'],
      } as StripPartCommand);

      return jsonResponse(result.replayed ? 200 : 201, result);
    }

    if (action === 'log-scrap') {
      const allowedKeys = new Set(['metadata', 'ticket', 'recyclerTicket']);
      for (const key of formData.keys()) {
        if (!allowedKeys.has(key)) {
          throw new PartStripError(
            'INVALID_PART_STRIP_INPUT',
            `Unexpected multipart field "${key}" for action=log-scrap.`,
          );
        }
      }

      const ticketEntries = formData.getAll('ticket');
      const recyclerTicketEntries = formData.getAll('recyclerTicket');
      if (ticketEntries.length > 0 && recyclerTicketEntries.length > 0) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'Provide only one private ticket file field ("ticket" or "recyclerTicket").',
        );
      }

      const selected =
        ticketEntries.length > 0 ? ticketEntries : recyclerTicketEntries;
      if (selected.length !== 1 || !isFileEntry(selected[0]!)) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'Exactly 1 private recycler ticket file is required.',
        );
      }

      const ticketFile = selected[0]!;
      const ticketBytes = await readBoundedFileBytes(
        ticketFile,
        MAX_SCRAP_TICKET_BYTES,
        'Recycler ticket',
      );

      const useCase =
        deps.logScrapUseCase ?? createProductionLogScrapComponentUseCase();
      const result = await useCase.execute(session, {
        ...metadata,
        idempotencyKey: normalizedHeaderKey,
        ticketBytes,
        ticketContentType: ticketFile.type,
      } as unknown as LogScrapCommand);

      return jsonResponse(result.replayed ? 200 : 201, result);
    }

    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `Unsupported POST multipart action "${String(action)}". Expected "strip" or "log-scrap".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleSalvagePartsPatch(
  request: Request,
  deps: SalvagePartsRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    assertCapability(session, 'FR-INT-02');

    const rawContentType = request.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();
    if (mimeType !== 'application/json') {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'PATCH /api/salvage/parts requires Content-Type: application/json.',
      );
    }

    const normalizedHeaderKey = requireIdempotencyHeader(request);

    let parsedJson: unknown;
    try {
      parsedJson = await request.json();
    } catch {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'Malformed JSON request body.',
      );
    }

    if (
      !parsedJson ||
      typeof parsedJson !== 'object' ||
      Array.isArray(parsedJson)
    ) {
      throw new PartStripError(
        'INVALID_PART_STRIP_INPUT',
        'PATCH request body must be a JSON object.',
      );
    }

    const bodyRecord = parsedJson as Record<string, unknown>;
    assertHeaderBodyIdempotencyMatch(bodyRecord, normalizedHeaderKey);

    const action = bodyRecord.action;
    if (action === 'receive-return') {
      const useCase =
        deps.stripPartUseCase ?? createProductionStripPartUseCase();
      const result = await useCase.receiveReturnedPartIntoQcHold(session, {
        ...bodyRecord,
        idempotencyKey: normalizedHeaderKey,
      } as unknown as ReceiveReturnCommand);
      return jsonResponse(200, result);
    }

    if (action === 'inspect-return') {
      const useCase =
        deps.stripPartUseCase ?? createProductionStripPartUseCase();
      const result = await useCase.completeReturnQcInspection(session, {
        ...bodyRecord,
        idempotencyKey: normalizedHeaderKey,
      } as unknown as InspectReturnCommand);
      return jsonResponse(200, result);
    }

    if (action === 'complete-hulk') {
      const useCase =
        deps.completeHulkUseCase ?? createProductionCompleteHulkScrapUseCase();
      const result = await useCase.execute(session, {
        ...bodyRecord,
        idempotencyKey: normalizedHeaderKey,
      } as unknown as CompleteHulkCommand);
      return jsonResponse(200, result);
    }

    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `Unsupported PATCH action "${String(action)}". Expected "receive-return", "inspect-return", or "complete-hulk".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}

function parseOptionalLimit(rawLimit: string | null): number | undefined {
  if (rawLimit === null) {
    return undefined;
  }
  if (!/^\d+$/.test(rawLimit)) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      'Query parameter "limit" must be a positive integer.',
    );
  }
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      'Query parameter "limit" must be between 1 and 200.',
    );
  }
  return limit;
}

export async function handleSalvagePartsGet(
  request: Request,
  deps: SalvagePartsRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: false });
    assertCapability(session, 'FR-INT-02');

    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_GET_PARAMS.has(key)) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          `Unknown query parameter: "${key}".`,
        );
      }
      if (url.searchParams.getAll(key).length > 1) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          `Duplicate query parameter: "${key}".`,
        );
      }
    }

    const view = url.searchParams.get('view') ?? 'parts';
    const rawLimit = url.searchParams.get('limit');
    const donorVehicleId = url.searchParams.get('donorVehicleId') ?? undefined;
    const partId = url.searchParams.get('partId') ?? undefined;
    const qrSkuCode = url.searchParams.get('qrSkuCode') ?? undefined;
    const scrapLogId = url.searchParams.get('scrapLogId') ?? undefined;

    const useCase =
      deps.stripPartUseCase ?? createProductionStripPartUseCase();

    if (view === 'donors') {
      if (
        partId !== undefined ||
        qrSkuCode !== undefined ||
        scrapLogId !== undefined
      ) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'view=donors supports only optional donorVehicleId and limit parameters.',
        );
      }
      const limit = parseOptionalLimit(rawLimit);
      const donors = await useCase.listDonors(session, {
        donorVehicleId,
        limit,
      });
      return jsonResponse(200, {
        view: 'donors',
        count: donors.length,
        donors,
      });
    }

    if (view === 'parts') {
      if (scrapLogId !== undefined) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'Query parameter "scrapLogId" is not supported with view=parts.',
        );
      }
      const limit = parseOptionalLimit(rawLimit);
      const parts = await useCase.listParts(session, {
        donorVehicleId,
        partId,
        qrSkuCode,
        limit,
      });
      return jsonResponse(200, {
        view: 'parts',
        count: parts.length,
        parts,
      });
    }

    if (view === 'qc-queue') {
      if (donorVehicleId !== undefined || scrapLogId !== undefined) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'view=qc-queue supports only optional partId, qrSkuCode, and limit parameters.',
        );
      }
      const limit = parseOptionalLimit(rawLimit);
      const parts = await useCase.listParts(session, {
        partId,
        qrSkuCode,
        qcHoldOnly: true,
        limit,
      });
      return jsonResponse(200, {
        view: 'qc-queue',
        count: parts.length,
        parts,
      });
    }

    if (view === 'scrap-history') {
      if (
        partId !== undefined ||
        qrSkuCode !== undefined ||
        scrapLogId !== undefined
      ) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'view=scrap-history supports only optional donorVehicleId and limit parameters.',
        );
      }
      const limit = parseOptionalLimit(rawLimit);
      const scrapLogs = await useCase.listScrapHistory(session, {
        donorVehicleId,
        limit,
      });
      return jsonResponse(200, {
        view: 'scrap-history',
        count: scrapLogs.length,
        scrapLogs,
      });
    }

    if (view === 'ticket') {
      if (
        rawLimit !== null ||
        donorVehicleId !== undefined ||
        partId !== undefined ||
        qrSkuCode !== undefined
      ) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'view=ticket accepts only scrapLogId.',
        );
      }
      if (!scrapLogId) {
        throw new PartStripError(
          'INVALID_PART_STRIP_INPUT',
          'Query parameter "scrapLogId" is required with view=ticket.',
        );
      }
      const ticket = await useCase.getScrapTicketPresignedUrl(
        session,
        scrapLogId,
      );
      return jsonResponse(200, ticket);
    }

    throw new PartStripError(
      'INVALID_PART_STRIP_INPUT',
      `Unsupported view parameter: "${view}".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}
