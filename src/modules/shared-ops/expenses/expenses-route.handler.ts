import { PolicyConfigError } from '@/core/config/policy-loader';
import { DomainRuleError } from '@/core/domain';
import { StorageError } from '@/core/ports/storage.port';
import {
  AuthError,
  type AuthSessionContext,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import {
  type AttachExpenseReceiptCommand,
  ExpenseError,
  type LogExpenseCommand,
  MAX_EVIDENCE_BYTES,
  MAX_MULTIPART_METADATA_BYTES,
  MAX_MULTIPART_REQUEST_BYTES,
  type RecordCashCustodyTransferCommand,
  type SettleDeferredAccrualCommand,
} from './expenses.contracts';
import {
  createProductionExpenseService,
  type ExpenseService,
} from './expenses.repository';

const ALLOWED_GET_PARAMS = new Set([
  'view',
  'limit',
  'targetType',
  'targetId',
  'ttlSeconds',
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface SharedExpensesRouteDeps {
  readonly resolveSession?: (options?: {
    isMutationContext?: boolean;
  }) => Promise<AuthSessionContext>;
  readonly expenseService?: Pick<
    ExpenseService,
    | 'logExpense'
    | 'attachExpenseReceipt'
    | 'settleDeferredAccrual'
    | 'recordCashCustodyTransfer'
    | 'queryOperatorFloatSubledger'
    | 'getEvidencePresignedUrl'
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
  if (error instanceof DomainRuleError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof ExpenseError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof PolicyConfigError) {
    return jsonErrorResponse(422, error.code, error.message);
  }
  return jsonErrorResponse(
    500,
    'INTERNAL_SERVER_ERROR',
    'Unexpected error processing shared expense request.',
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
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
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
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
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
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      'Multipart request requires exactly one JSON "metadata" string field.',
    );
  }

  const rawMeta = metaEntries[0];
  if (Buffer.byteLength(rawMeta, 'utf8') > MAX_MULTIPART_METADATA_BYTES) {
    throw new ExpenseError(
      'PAYLOAD_TOO_LARGE',
      `Multipart metadata exceeds ${MAX_MULTIPART_METADATA_BYTES} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMeta);
  } catch {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      'Multipart "metadata" field must contain valid JSON.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
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
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `${label} must not be empty.`,
    );
  }
  if (file.size > maxBytes) {
    throw new ExpenseError(
      'PAYLOAD_TOO_LARGE',
      `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
    );
  }
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  if (bytes.byteLength === 0) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `${label} must not be empty.`,
    );
  }
  if (bytes.byteLength > maxBytes) {
    throw new ExpenseError(
      'PAYLOAD_TOO_LARGE',
      `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
    );
  }
  return bytes;
}

async function parseMutationRequestPayload(
  request: Request,
  allowedFileFieldNames: readonly string[],
): Promise<{
  readonly metadata: Record<string, unknown>;
  readonly fileBytes?: Uint8Array;
  readonly fileContentType?: string;
  readonly fileFieldName?: string;
}> {
  const rawContentType = request.headers.get('content-type') ?? '';
  const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();

  if (mimeType === 'application/json') {
    let parsedJson: unknown;
    try {
      parsedJson = await request.json();
    } catch {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        'Malformed JSON request body.',
      );
    }
    if (
      !parsedJson ||
      typeof parsedJson !== 'object' ||
      Array.isArray(parsedJson)
    ) {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        'JSON request body must be an object.',
      );
    }
    return { metadata: parsedJson as Record<string, unknown> };
  }

  if (mimeType === 'multipart/form-data') {
    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declaredBytes = Number(contentLengthHeader);
      if (
        Number.isFinite(declaredBytes) &&
        declaredBytes > MAX_MULTIPART_REQUEST_BYTES + MAX_MULTIPART_METADATA_BYTES
      ) {
        throw new ExpenseError(
          'PAYLOAD_TOO_LARGE',
          `Multipart request exceeds maximum size of ${MAX_MULTIPART_REQUEST_BYTES} bytes.`,
        );
      }
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new ExpenseError(
        'INVALID_EXPENSE_INPUT',
        'Malformed multipart/form-data request body.',
      );
    }

    const allowedKeys = new Set(['metadata', ...allowedFileFieldNames]);
    for (const key of formData.keys()) {
      if (!allowedKeys.has(key)) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          `Unexpected multipart field "${key}".`,
        );
      }
    }

    const metadata = await parseMultipartMetadata(formData);
    let selectedFile: File | undefined;
    let selectedFieldName: string | undefined;

    for (const fieldName of allowedFileFieldNames) {
      const entries = formData.getAll(fieldName);
      if (entries.length === 0) {
        continue;
      }
      if (selectedFile !== undefined || entries.length > 1) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Provide at most one private evidence file upload.',
        );
      }
      const entry = entries[0]!;
      if (!isFileEntry(entry)) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          `Multipart field "${fieldName}" must be a file.`,
        );
      }
      selectedFile = entry;
      selectedFieldName = fieldName;
    }

    if (selectedFile) {
      const fileBytes = await readBoundedFileBytes(
        selectedFile,
        MAX_EVIDENCE_BYTES,
        'Evidence file',
      );
      return {
        metadata,
        fileBytes,
        fileContentType: selectedFile.type,
        fileFieldName: selectedFieldName,
      };
    }

    return { metadata };
  }

  throw new ExpenseError(
    'INVALID_EXPENSE_INPUT',
    'Request requires Content-Type: application/json or multipart/form-data.',
  );
}

export async function handleSharedExpensesPost(
  request: Request,
  deps: SharedExpensesRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const normalizedHeaderKey = requireIdempotencyHeader(request);

    const parsed = await parseMutationRequestPayload(request, [
      'receipt',
      'depositSlip',
    ]);
    assertHeaderBodyIdempotencyMatch(parsed.metadata, normalizedHeaderKey);

    const service = deps.expenseService ?? createProductionExpenseService();
    const action = parsed.metadata.action;

    if (action === 'log-expense') {
      if (parsed.fileFieldName === 'depositSlip') {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Unexpected "depositSlip" field for action=log-expense.',
        );
      }
      const result = await service.logExpense(session, {
        ...parsed.metadata,
        idempotencyKey: normalizedHeaderKey,
        ...(parsed.fileBytes
          ? {
              receiptBytes: parsed.fileBytes,
              receiptContentType: parsed.fileContentType,
            }
          : {}),
      } as LogExpenseCommand);
      return jsonResponse(result.replayed ? 200 : 201, result);
    }

    if (action === 'record-transfer') {
      if (parsed.fileFieldName === 'receipt') {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Unexpected "receipt" field for action=record-transfer.',
        );
      }
      const result = await service.recordCashCustodyTransfer(session, {
        ...parsed.metadata,
        idempotencyKey: normalizedHeaderKey,
        ...(parsed.fileBytes
          ? {
              depositSlipBytes: parsed.fileBytes,
              depositSlipContentType: parsed.fileContentType,
            }
          : {}),
      } as RecordCashCustodyTransferCommand);
      return jsonResponse(result.replayed ? 200 : 201, result);
    }

    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `Unsupported POST action "${String(action)}". Expected "log-expense" or "record-transfer".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleSharedExpensesPatch(
  request: Request,
  deps: SharedExpensesRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const normalizedHeaderKey = requireIdempotencyHeader(request);

    const parsed = await parseMutationRequestPayload(request, ['receipt']);
    assertHeaderBodyIdempotencyMatch(parsed.metadata, normalizedHeaderKey);

    const service = deps.expenseService ?? createProductionExpenseService();
    const action = parsed.metadata.action;

    if (action === 'attach-receipt') {
      const result = await service.attachExpenseReceipt(session, {
        ...parsed.metadata,
        idempotencyKey: normalizedHeaderKey,
        ...(parsed.fileBytes
          ? {
              receiptBytes: parsed.fileBytes,
              receiptContentType: parsed.fileContentType,
            }
          : {}),
      } as AttachExpenseReceiptCommand);
      return jsonResponse(200, result);
    }

    if (action === 'settle-accrual') {
      if (parsed.fileBytes) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Unexpected file upload for action=settle-accrual.',
        );
      }
      const result = await service.settleDeferredAccrual(session, {
        ...parsed.metadata,
        idempotencyKey: normalizedHeaderKey,
      } as SettleDeferredAccrualCommand);
      return jsonResponse(200, result);
    }

    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `Unsupported PATCH action "${String(action)}". Expected "attach-receipt" or "settle-accrual".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}

function parseOptionalIntParam(
  raw: string | null,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `Query parameter "${name}" must be a positive integer.`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `Query parameter "${name}" must be between ${min} and ${max}.`,
    );
  }
  return value;
}

export async function handleSharedExpensesGet(
  request: Request,
  deps: SharedExpensesRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: false });

    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_GET_PARAMS.has(key)) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          `Unknown query parameter: "${key}".`,
        );
      }
      if (url.searchParams.getAll(key).length > 1) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          `Duplicate query parameter: "${key}".`,
        );
      }
    }

    const view = url.searchParams.get('view') ?? 'subledger';
    const rawLimit = url.searchParams.get('limit');
    const targetType = url.searchParams.get('targetType');
    const targetId = url.searchParams.get('targetId');
    const rawTtl = url.searchParams.get('ttlSeconds');

    const service = deps.expenseService ?? createProductionExpenseService();

    if (view === 'subledger') {
      if (
        targetType !== null ||
        targetId !== null ||
        rawTtl !== null
      ) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'view=subledger supports only optional "limit" parameter.',
        );
      }
      const limit = parseOptionalIntParam(rawLimit, 'limit', 1, 200);
      const projection = await service.queryOperatorFloatSubledger(session, {
        limit,
      });
      return jsonResponse(200, projection);
    }

    if (view === 'evidence') {
      if (rawLimit !== null) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'Query parameter "limit" is not supported with view=evidence.',
        );
      }
      if (targetType !== 'expense' && targetType !== 'transfer') {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'view=evidence requires targetType="expense" or "transfer".',
        );
      }
      if (!targetId) {
        throw new ExpenseError(
          'INVALID_EXPENSE_INPUT',
          'view=evidence requires targetId.',
        );
      }
      const ttlSeconds =
        rawTtl !== null
          ? (/^-?\d+$/.test(rawTtl)
              ? Number.parseInt(rawTtl, 10)
              : Number.NaN)
          : undefined;
      const presigned = await service.getEvidencePresignedUrl(session, {
        targetType,
        targetId,
        ttlSeconds,
      });
      return jsonResponse(200, presigned);
    }

    throw new ExpenseError(
      'INVALID_EXPENSE_INPUT',
      `Unsupported view parameter: "${view}".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}
