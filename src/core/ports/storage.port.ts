/**
 * Canonical storage port contracts, DTOs, and deterministic error definitions.
 *
 * Security boundary:
 * - `actor` identity must originate from the server-side auth resolver (#4) and is
 *   verified at runtime via `assertTrustedAuthSession` inside `StorageService`.
 * - Callers never specify target buckets, ACLs, object keys, or public URL origins.
 * - Pure port module: zero imports from Prisma, Next.js, Supabase, AWS SDK, or app modules.
 */

export const MAX_PRESIGNED_URL_TTL_SECONDS = 900 as const;
export const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 900 as const;
export const MIN_PRESIGNED_URL_TTL_SECONDS = 1 as const;

export type StorageErrorCode =
  | 'STORAGE_KEY_FORBIDDEN'
  | 'STORAGE_INVALID_TTL'
  | 'STORAGE_INVALID_IMAGE'
  | 'STORAGE_INVALID_INPUT'
  | 'STORAGE_PAYLOAD_TOO_LARGE'
  | 'STORAGE_OBJECT_NOT_FOUND'
  | 'STORAGE_CONFIGURATION_ERROR'
  | 'STORAGE_PROVIDER_ERROR'
  | 'STORAGE_AUDIT_FAILED'
  | 'STORAGE_PRESIGNED_URL_EXPIRED';

export type StorageErrorStatus = 400 | 403 | 404 | 413 | 500 | 502;

const STORAGE_ERROR_STATUS_BY_CODE: Readonly<
  Record<StorageErrorCode, StorageErrorStatus>
> = {
  STORAGE_KEY_FORBIDDEN: 403,
  STORAGE_INVALID_TTL: 400,
  STORAGE_INVALID_IMAGE: 400,
  STORAGE_INVALID_INPUT: 400,
  STORAGE_PAYLOAD_TOO_LARGE: 413,
  STORAGE_OBJECT_NOT_FOUND: 404,
  STORAGE_CONFIGURATION_ERROR: 500,
  STORAGE_PROVIDER_ERROR: 502,
  STORAGE_AUDIT_FAILED: 500,
  STORAGE_PRESIGNED_URL_EXPIRED: 500,
};

/**
 * Typed fail-closed storage error with deterministic HTTP status mapping.
 */
export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public readonly status: StorageErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: StorageErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = STORAGE_ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

/**
 * Minimal structural actor identity satisfied by a server-resolved `AuthSessionContext`.
 * Runtime implementations validate trusted session provenance before any operation.
 */
export interface StorageActorContext {
  readonly userId: string;
  readonly activeOrganizationId: string;
}

/**
 * Optional server-supplied request metadata for immutable `AuditLog` entries.
 * Never carries or overrides actor identity.
 */
export interface StorageAuditContext {
  readonly ipAddress?: string | null;
  readonly correlationId?: string;
}

export interface UploadPublicPartMediaInput {
  readonly actor: StorageActorContext;
  readonly organizationId: string;
  readonly image: Uint8Array;
}

export interface UploadPrivateEvidenceInput {
  readonly actor: StorageActorContext;
  readonly organizationId: string;
  readonly evidence: Uint8Array;
  readonly contentType: string;
  readonly auditContext?: StorageAuditContext;
}

export interface UploadPrivateEvidenceResult {
  readonly storageKey: string;
  readonly sha256Hash: string;
}

export interface CreatePrivateEvidencePresignedUrlInput {
  readonly actor: StorageActorContext;
  readonly organizationId: string;
  readonly storageKey: string;
  readonly ttlSeconds?: number;
  readonly auditContext?: StorageAuditContext;
}

/**
 * Segregated object storage port enforcing strict public-media vs. private-evidence
 * isolation, tenant key prefixing (`{organizationId}/...`), EXIF GPS stripping,
 * SHA-256 evidence digesting, short-lived presigned URLs, and immutable audit logging.
 */
export interface IStoragePort {
  uploadPublicPartMedia(input: UploadPublicPartMediaInput): Promise<string>;
  uploadPrivateEvidence(
    input: UploadPrivateEvidenceInput,
  ): Promise<UploadPrivateEvidenceResult>;
  createPrivateEvidencePresignedUrl(
    input: CreatePrivateEvidencePresignedUrlInput,
  ): Promise<string>;
}
