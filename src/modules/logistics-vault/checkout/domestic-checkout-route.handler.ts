import { PolicyConfigError } from '@/core/config/policy-loader';
import { DomainRuleError } from '@/core/domain';
import { type IStoragePort, StorageError } from '@/core/ports/storage.port';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import { createStorageService } from '@/modules/shared-ops/storage';
import {
  ALLOWED_CHECKOUT_EVIDENCE_MIME_TYPES,
  type CheckoutEvidenceKind,
  ConfirmBankSettlementSchema,
  DomesticCheckoutError,
  type ExecuteDomesticCheckoutCommand,
  MAX_CHECKOUT_EVIDENCE_BYTES,
  MAX_CHECKOUT_METADATA_BYTES,
  MAX_CHECKOUT_MULTIPART_BYTES,
  RecordSaleRefundSchema,
} from './domestic-checkout.contracts';
import { createProductionDomesticCheckoutUseCase } from './domestic-checkout.repository';
import { ExecuteDomesticCheckoutUseCase } from './execute-domestic-checkout.use-case';

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
} as const;

const ALLOWED_GET_PARAMS = new Set(['view', 'code', 'limit']);

export interface DomesticCheckoutRouteDeps {
  readonly resolveSession?: (options?: {
    isMutationContext?: boolean;
  }) => Promise<AuthSessionContext>;
  readonly checkoutUseCase?: Pick<
    ExecuteDomesticCheckoutUseCase,
    | 'lookupCheckoutItems'
    | 'listDomesticSalesForSettlement'
    | 'executeDomesticCheckout'
    | 'confirmSaleBankSettlement'
    | 'recordSaleRefundOrChargeback'
  >;
  readonly storage?: Pick<IStoragePort, 'uploadPrivateEvidence'>;
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
  if (error instanceof DomesticCheckoutError) {
    return jsonErrorResponse(error.status, error.code, error.message);
  }
  if (error instanceof PolicyConfigError) {
    return jsonErrorResponse(422, error.code, error.message);
  }
  return jsonErrorResponse(
    500,
    'INTERNAL_SERVER_ERROR',
    'Unexpected error processing domestic checkout request.',
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
    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
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
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
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
    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      'Multipart request requires exactly one JSON "metadata" string field.',
    );
  }
  const rawMeta = metaEntries[0];
  if (Buffer.byteLength(rawMeta, 'utf8') > MAX_CHECKOUT_METADATA_BYTES) {
    throw new DomesticCheckoutError(
      'PAYLOAD_TOO_LARGE',
      `Multipart metadata exceeds ${MAX_CHECKOUT_METADATA_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMeta);
  } catch {
    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      'Multipart "metadata" field must contain valid JSON.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
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
    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      `${label} must not be empty.`,
    );
  }
  if (file.size > maxBytes) {
    throw new DomesticCheckoutError(
      'PAYLOAD_TOO_LARGE',
      `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new DomesticCheckoutError(
      bytes.byteLength === 0 ? 'INVALID_CHECKOUT_INPUT' : 'PAYLOAD_TOO_LARGE',
      bytes.byteLength === 0
        ? `${label} must not be empty.`
        : `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
    );
  }
  return bytes;
}

const CFO_ONLY_EVIDENCE_KINDS = new Set<CheckoutEvidenceKind>([
  'SETTLEMENT_PROOF',
  'FEE_TAX_INVOICE',
  'REFUND_PROOF',
]);

const ALL_EVIDENCE_KINDS = new Set<string>([
  'PAYMENT_PROOF',
  'BILL_OF_SALE',
  'EXPORT_PROOF',
  'SETTLEMENT_PROOF',
  'FEE_TAX_INVOICE',
  'REFUND_PROOF',
]);

export async function handleDomesticCheckoutGet(
  request: Request,
  deps: DomesticCheckoutRouteDeps = {},
): Promise<Response> {
  try {
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: false });

    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_GET_PARAMS.has(key)) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          `Unsupported query parameter "${key}".`,
        );
      }
    }

    const view = url.searchParams.get('view') ?? 'lookup';
    const useCase =
      deps.checkoutUseCase ?? createProductionDomesticCheckoutUseCase();

    if (view === 'lookup') {
      const code = url.searchParams.get('code') ?? undefined;
      const items = await useCase.lookupCheckoutItems(session, code);
      return jsonResponse(200, { items });
    }

    if (view === 'settlement-queue') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'limit must be an integer between 1 and 200.',
        );
      }
      const sales = await useCase.listDomesticSalesForSettlement(
        session,
        limit,
      );
      return jsonResponse(200, { sales });
    }

    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      `Unsupported view "${view}".`,
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleDomesticCheckoutPost(
  request: Request,
  deps: DomesticCheckoutRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const idempotencyKey = requireIdempotencyHeader(request);

    const rawContentType = request.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();

    if (mimeType === 'multipart/form-data') {
      const contentLengthHeader = request.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const declaredBytes = Number(contentLengthHeader);
        if (
          Number.isFinite(declaredBytes) &&
          declaredBytes >
            MAX_CHECKOUT_MULTIPART_BYTES + MAX_CHECKOUT_METADATA_BYTES
        ) {
          throw new DomesticCheckoutError(
            'PAYLOAD_TOO_LARGE',
            `Multipart request exceeds maximum size of ${MAX_CHECKOUT_MULTIPART_BYTES} bytes.`,
          );
        }
      }

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'Malformed multipart/form-data request body.',
        );
      }

      const allowedKeys = new Set(['metadata', 'file', 'evidence']);
      for (const key of formData.keys()) {
        if (!allowedKeys.has(key)) {
          throw new DomesticCheckoutError(
            'INVALID_CHECKOUT_INPUT',
            `Unexpected multipart field "${key}".`,
          );
        }
      }

      const metadata = await parseMultipartMetadata(formData);
      assertHeaderBodyIdempotencyMatch(metadata, idempotencyKey);
      if (metadata.action !== 'upload-evidence') {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'Multipart POST /api/salvage/checkout/domestic requires action="upload-evidence".',
        );
      }

      const evidenceKind = metadata.evidenceKind;
      if (
        typeof evidenceKind !== 'string' ||
        !ALL_EVIDENCE_KINDS.has(evidenceKind)
      ) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'Invalid or missing evidenceKind.',
        );
      }

      if (CFO_ONLY_EVIDENCE_KINDS.has(evidenceKind as CheckoutEvidenceKind)) {
        assertCapability(session, 'FR-CHK-01:update');
      } else {
        assertCapability(session, 'FR-CHK-01:execute-cad-only');
      }

      const fileEntries = [
        ...formData.getAll('file'),
        ...formData.getAll('evidence'),
      ];
      if (fileEntries.length !== 1 || !isFileEntry(fileEntries[0]!)) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'Multipart upload-evidence requires exactly one file entry under "file" or "evidence".',
        );
      }

      const file = fileEntries[0]!;
      const normalizedFileMime =
        file.type.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!ALLOWED_CHECKOUT_EVIDENCE_MIME_TYPES.has(normalizedFileMime)) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'Evidence file MIME type must be image/jpeg, image/png, image/webp, or application/pdf.',
        );
      }

      const bytes = await readBoundedFileBytes(
        file,
        MAX_CHECKOUT_EVIDENCE_BYTES,
        'Evidence file',
      );
      const storage = deps.storage ?? createStorageService();
      const uploaded = await storage.uploadPrivateEvidence({
        actor: session,
        organizationId: session.activeOrganizationId,
        evidence: bytes,
        contentType: normalizedFileMime,
        auditContext: { correlationId: idempotencyKey },
      });

      return jsonResponse(201, {
        evidenceKind,
        storageKey: uploaded.storageKey,
        sha256Hash: uploaded.sha256Hash,
      });
    }

    if (mimeType === 'application/json') {
      let parsedJson: unknown;
      try {
        parsedJson = await request.json();
      } catch {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'Malformed JSON request body.',
        );
      }
      if (
        !parsedJson ||
        typeof parsedJson !== 'object' ||
        Array.isArray(parsedJson)
      ) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          'JSON request body must be an object.',
        );
      }
      const bodyRecord = parsedJson as Record<string, unknown>;
      assertHeaderBodyIdempotencyMatch(bodyRecord, idempotencyKey);

      const useCase =
        deps.checkoutUseCase ?? createProductionDomesticCheckoutUseCase();
      const result = await useCase.executeDomesticCheckout(session, {
        ...(bodyRecord as unknown as ExecuteDomesticCheckoutCommand),
        idempotencyKey,
      });
      return jsonResponse(201, result);
    }

    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      'POST /api/salvage/checkout/domestic requires application/json or multipart/form-data.',
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}

export async function handleDomesticCheckoutPatch(
  request: Request,
  deps: DomesticCheckoutRouteDeps = {},
): Promise<Response> {
  try {
    assertSameOriginIfBrowserRequest(request);
    const resolveSession =
      deps.resolveSession ?? ((opts) => resolveAuthSessionContext(opts));
    const session = await resolveSession({ isMutationContext: true });
    const idempotencyKey = requireIdempotencyHeader(request);

    const rawContentType = request.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase();
    if (mimeType !== 'application/json') {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'PATCH /api/salvage/checkout/domestic requires Content-Type: application/json.',
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = await request.json();
    } catch {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'Malformed JSON request body.',
      );
    }
    if (
      !parsedJson ||
      typeof parsedJson !== 'object' ||
      Array.isArray(parsedJson)
    ) {
      throw new DomesticCheckoutError(
        'INVALID_CHECKOUT_INPUT',
        'JSON request body must be an object.',
      );
    }
    const bodyRecord = parsedJson as Record<string, unknown>;
    assertHeaderBodyIdempotencyMatch(bodyRecord, idempotencyKey);

    const useCase =
      deps.checkoutUseCase ?? createProductionDomesticCheckoutUseCase();

    if (bodyRecord.action === 'confirm-bank-settlement') {
      const parsed = ConfirmBankSettlementSchema.safeParse({
        ...bodyRecord,
        idempotencyKey,
      });
      if (!parsed.success) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
            .join('; '),
        );
      }
      const result = await useCase.confirmSaleBankSettlement(
        session,
        parsed.data.saleId,
        parsed.data,
      );
      return jsonResponse(200, result);
    }

    if (bodyRecord.action === 'record-refund-or-chargeback') {
      const parsed = RecordSaleRefundSchema.safeParse({
        ...bodyRecord,
        idempotencyKey,
      });
      if (!parsed.success) {
        throw new DomesticCheckoutError(
          'INVALID_CHECKOUT_INPUT',
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
            .join('; '),
        );
      }
      const result = await useCase.recordSaleRefundOrChargeback(
        session,
        parsed.data.saleId,
        parsed.data,
      );
      return jsonResponse(200, result);
    }

    throw new DomesticCheckoutError(
      'INVALID_CHECKOUT_INPUT',
      'PATCH /api/salvage/checkout/domestic requires action="confirm-bank-settlement" or "record-refund-or-chargeback".',
    );
  } catch (error) {
    return handleErrorResponse(error);
  }
}
