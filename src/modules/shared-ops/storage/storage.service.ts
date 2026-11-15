import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_PRESIGNED_URL_TTL_SECONDS,
  type CreatePrivateEvidencePresignedUrlInput,
  type IStoragePort,
  MAX_PRESIGNED_URL_TTL_SECONDS,
  MIN_PRESIGNED_URL_TTL_SECONDS,
  type StorageAuditContext,
  StorageError,
  type UploadPrivateEvidenceInput,
  type UploadPrivateEvidenceResult,
  type UploadPublicPartMediaInput,
} from '@/core/ports/storage.port';
import {
  TenantContextError,
  type TenantExecutionContext,
  withTenantTransaction,
} from '@/infrastructure/db/tenant-transaction';
import {
  assertTenantScope,
  AuthError,
  toTenantExecutionContext,
  translateTenantContextError,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import {
  computeSha256Hex,
  copyBytes,
  PUBLIC_MEDIA_CONTENT_TYPE,
  sanitizePublicImageToWebp,
} from './exif-sanitizer';

const LOWERCASE_UUID_SEGMENT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const PUBLIC_MEDIA_KEY_REGEX = new RegExp(
  `^${LOWERCASE_UUID_SEGMENT}\\/media\\/${LOWERCASE_UUID_SEGMENT}\\.webp$`,
);

const PRIVATE_EVIDENCE_KEY_REGEX = new RegExp(
  `^${LOWERCASE_UUID_SEGMENT}\\/evidence\\/${LOWERCASE_UUID_SEGMENT}$`,
);

const VALID_MIME_TYPE_REGEX =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n\0]*"))*$/i;

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;

export interface PutPublicMediaParams {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: typeof PUBLIC_MEDIA_CONTENT_TYPE;
}

export interface PutPrivateEvidenceParams {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface CreatePrivatePresignedGetParams {
  readonly key: string;
  readonly ttlSeconds: number;
  readonly issuedAt: Date;
}

/**
 * Internal provider seam implemented by InMemoryStorageAdapter and R2StorageAdapter.
 * Never exposed as an unaudited public application port.
 */
export interface StorageBackend {
  putPublicMedia(params: PutPublicMediaParams): Promise<void>;
  formatPublicMediaUrl(key: string): string;
  putPrivateEvidence(params: PutPrivateEvidenceParams): Promise<void>;
  privateEvidenceExists(key: string): Promise<boolean>;
  createPrivatePresignedGetUrl(
    params: CreatePrivatePresignedGetParams,
  ): Promise<string>;
}

export interface StorageAuditEventInput {
  readonly auditId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly entityType: 'PRIVATE_EVIDENCE';
  readonly entityId: string;
  readonly action:
    | 'PRIVATE_EVIDENCE_UPLOADED'
    | 'PRIVATE_EVIDENCE_PRESIGNED_URL_ISSUED';
  readonly nextState: Readonly<Record<string, unknown>>;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
}

/**
 * Narrow authorization and audit persistence seam backed by `withTenantTransaction`
 * in production and mutable membership/audit fixtures in offline tests.
 */
export interface StorageSecurityRepository {
  verifyActiveTenantAccess(ctx: TenantExecutionContext): Promise<void>;
  recordPrivateEvidenceAudit(
    ctx: TenantExecutionContext,
    event: StorageAuditEventInput,
  ): Promise<void>;
}

export interface StorageClock {
  now(): Date;
}

export interface StorageServiceDependencies {
  readonly backend: StorageBackend;
  readonly securityRepository?: StorageSecurityRepository;
  readonly clock?: StorageClock;
  readonly idGenerator?: () => string;
}

function validateSafeKeyChars(rawKey: unknown): string {
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    throw new StorageError(
      'STORAGE_KEY_FORBIDDEN',
      'Storage key must be a non-empty canonical tenant key.',
    );
  }
  if (
    CONTROL_CHARS_REGEX.test(rawKey) ||
    rawKey.includes('..') ||
    rawKey.includes('\\') ||
    rawKey.includes('%') ||
    rawKey.includes('?') ||
    rawKey.includes('#') ||
    rawKey.includes('://')
  ) {
    throw new StorageError(
      'STORAGE_KEY_FORBIDDEN',
      'Storage key contains forbidden characters or traversal sequences.',
    );
  }
  return rawKey;
}

function assertValidTenantStorageKey(
  storageKey: unknown,
  pattern: RegExp,
  kindLabel: string,
  expectedOrganizationId?: string,
): string {
  const key = validateSafeKeyChars(storageKey);
  if (!pattern.test(key)) {
    throw new StorageError(
      'STORAGE_KEY_FORBIDDEN',
      `Storage key is not a canonical ${kindLabel} key.`,
    );
  }
  if (expectedOrganizationId !== undefined) {
    const normalizedOrgId = expectedOrganizationId.toLowerCase();
    const firstSlash = key.indexOf('/');
    const keyOrgId = firstSlash === -1 ? '' : key.slice(0, firstSlash);
    if (keyOrgId !== normalizedOrgId) {
      throw new StorageError(
        'STORAGE_KEY_FORBIDDEN',
        'Storage key does not belong to the active organization.',
      );
    }
  }
  return key;
}

/**
 * Strictly validates canonical `{organizationId}/media/{uuid}.webp` syntax and
 * optional active organization prefix equality without normalization or decoding.
 */
export function assertValidPublicMediaKey(
  storageKey: unknown,
  expectedOrganizationId?: string,
): string {
  return assertValidTenantStorageKey(
    storageKey,
    PUBLIC_MEDIA_KEY_REGEX,
    'public media',
    expectedOrganizationId,
  );
}

/**
 * Strictly validates canonical `{organizationId}/evidence/{uuid}` syntax and
 * optional active organization prefix equality without normalization or decoding.
 */
export function assertValidPrivateEvidenceKey(
  storageKey: unknown,
  expectedOrganizationId?: string,
): string {
  return assertValidTenantStorageKey(
    storageKey,
    PRIVATE_EVIDENCE_KEY_REGEX,
    'private evidence',
    expectedOrganizationId,
  );
}

/**
 * Validates that a public media CDN base URL is strictly an HTTPS origin with no
 * embedded credentials, path, query, or fragment.
 */
export function validatePublicMediaOrigin(rawOrigin: unknown): string {
  if (typeof rawOrigin !== 'string' || rawOrigin.trim().length === 0) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'Public media base URL must be a non-empty HTTPS origin.',
    );
  }
  const trimmed = rawOrigin.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'Public media base URL must be a valid HTTPS URL.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'Public media base URL must use the https:// protocol.',
    );
  }
  if (parsed.username || parsed.password) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'Public media base URL must not contain credentials.',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'Public media base URL must not contain query parameters or fragments.',
    );
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'Public media base URL must be an origin without a path.',
    );
  }
  return parsed.origin;
}

/**
 * Formats a public CDN URL exclusively for a validated `{orgId}/media/{uuid}.webp` key.
 * Rejects private evidence keys and non-canonical paths with 403 STORAGE_KEY_FORBIDDEN.
 */
export function formatValidatedPublicMediaUrl(
  publicOrigin: string,
  storageKey: string,
): string {
  const validatedKey = assertValidPublicMediaKey(storageKey);
  const validatedOrigin = validatePublicMediaOrigin(publicOrigin);
  return `${validatedOrigin}/${validatedKey}`;
}

/**
 * Validates presigned URL TTL: defaults to 900s when omitted; explicit values must
 * be safe integers in [1, 900]. Rejects values above the cap rather than truncating.
 */
export function validatePresignedUrlTtl(ttlSeconds: unknown): number {
  if (ttlSeconds === undefined) {
    return DEFAULT_PRESIGNED_URL_TTL_SECONDS;
  }
  if (
    typeof ttlSeconds !== 'number' ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < MIN_PRESIGNED_URL_TTL_SECONDS ||
    ttlSeconds > MAX_PRESIGNED_URL_TTL_SECONDS
  ) {
    throw new StorageError(
      'STORAGE_INVALID_TTL',
      `Presigned URL ttlSeconds must be a safe integer between ${MIN_PRESIGNED_URL_TTL_SECONDS} and ${MAX_PRESIGNED_URL_TTL_SECONDS}.`,
    );
  }
  return ttlSeconds;
}

function validateEvidenceContentType(contentType: unknown): string {
  if (typeof contentType !== 'string') {
    throw new StorageError(
      'STORAGE_INVALID_INPUT',
      'Private evidence contentType must be a non-empty MIME type string.',
    );
  }
  const trimmed = contentType.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 255 ||
    CONTROL_CHARS_REGEX.test(trimmed) ||
    !VALID_MIME_TYPE_REGEX.test(trimmed)
  ) {
    throw new StorageError(
      'STORAGE_INVALID_INPUT',
      'Private evidence contentType must be a valid MIME type.',
    );
  }
  return trimmed;
}

function normalizeAuditContext(auditContext?: StorageAuditContext): {
  readonly ipAddress: string | null;
  readonly correlationId: string | undefined;
} {
  if (auditContext === undefined) {
    return { ipAddress: null, correlationId: undefined };
  }
  if (!auditContext || typeof auditContext !== 'object') {
    throw new StorageError(
      'STORAGE_INVALID_INPUT',
      'auditContext must be an object when provided.',
    );
  }

  let ipAddress: string | null = null;
  if (auditContext.ipAddress !== undefined && auditContext.ipAddress !== null) {
    if (typeof auditContext.ipAddress !== 'string') {
      throw new StorageError(
        'STORAGE_INVALID_INPUT',
        'auditContext.ipAddress must be a string or null.',
      );
    }
    const trimmedIp = auditContext.ipAddress.trim();
    if (trimmedIp.length > 128 || CONTROL_CHARS_REGEX.test(trimmedIp)) {
      throw new StorageError(
        'STORAGE_INVALID_INPUT',
        'auditContext.ipAddress contains invalid characters or exceeds maximum length.',
      );
    }
    ipAddress = trimmedIp.length > 0 ? trimmedIp : null;
  }

  let correlationId: string | undefined;
  if (auditContext.correlationId !== undefined) {
    if (typeof auditContext.correlationId !== 'string') {
      throw new StorageError(
        'STORAGE_INVALID_INPUT',
        'auditContext.correlationId must be a string.',
      );
    }
    const trimmedCorrelation = auditContext.correlationId.trim();
    if (
      trimmedCorrelation.length > 128 ||
      CONTROL_CHARS_REGEX.test(trimmedCorrelation)
    ) {
      throw new StorageError(
        'STORAGE_INVALID_INPUT',
        'auditContext.correlationId contains invalid characters or exceeds maximum length.',
      );
    }
    if (trimmedCorrelation.length > 0) {
      correlationId = trimmedCorrelation;
    }
  }

  return { ipAddress, correlationId };
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
 * Production `StorageSecurityRepository` backed by `withTenantTransaction` and
 * `shared.AuditLog`. Lazily resolves the runtime Prisma singleton on call so
 * module imports remain side-effect free in offline tests.
 */
export function createPrismaStorageSecurityRepository(options?: {
  readonly prisma?: PrismaClient;
}): StorageSecurityRepository {
  const explicitPrisma = options?.prisma;

  return {
    async verifyActiveTenantAccess(ctx: TenantExecutionContext): Promise<void> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);
      try {
        await withTenantTransaction(prismaClient, ctx, async () => true);
      } catch (error) {
        translateTenantContextError(error);
      }
    },

    async recordPrivateEvidenceAudit(
      ctx: TenantExecutionContext,
      event: StorageAuditEventInput,
    ): Promise<void> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        await withTenantTransaction(prismaClient, ctx, async (tx) => {
          await tx.auditLog.create({
            data: {
              id: event.auditId,
              organizationId: event.organizationId,
              actorUserId: event.actorUserId,
              entityType: event.entityType,
              entityId: event.entityId,
              action: event.action,
              nextState: event.nextState as Prisma.InputJsonValue,
              ipAddress: event.ipAddress,
              createdAt: event.createdAt,
            },
          });
        });
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }
        if (
          error instanceof TenantContextError &&
          error.code === 'TENANT_CONTEXT_UNAUTHORIZED'
        ) {
          translateTenantContextError(error);
        }

        // If an audit INSERT failed (e.g. RLS WITH CHECK after concurrent revocation),
        // recheck live authorization in a separate short transaction so confirmed
        // revocation always surfaces 403 MEMBERSHIP_REVOKED_OR_INACTIVE.
        try {
          await withTenantTransaction(prismaClient, ctx, async () => true);
        } catch (recheckError) {
          if (
            recheckError instanceof TenantContextError &&
            recheckError.code === 'TENANT_CONTEXT_UNAUTHORIZED'
          ) {
            translateTenantContextError(recheckError);
          }
        }

        throw new StorageError(
          'STORAGE_AUDIT_FAILED',
          'Failed to persist immutable audit log for private evidence operation.',
        );
      }
    },
  };
}

/**
 * Shared checked implementation of `IStoragePort`. Both `InMemoryStorageAdapter`
 * and `R2StorageAdapter` extend `StorageService` so session validation, tenant
 * prefix checks, EXIF stripping, TTL caps, and transaction-scoped audit logging
 * cannot be bypassed or duplicated.
 */
export class StorageService implements IStoragePort {
  private readonly backend: StorageBackend;
  private readonly securityRepository: StorageSecurityRepository;
  private readonly clock: StorageClock;
  private readonly idGenerator: () => string;

  public constructor(deps: StorageServiceDependencies) {
    this.backend = deps.backend;
    this.securityRepository =
      deps.securityRepository ?? createPrismaStorageSecurityRepository();
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
  }

  public async uploadPublicPartMedia(
    input: UploadPublicPartMediaInput,
  ): Promise<string> {
    assertTrustedAuthSession(input.actor);
    assertTenantScope(input.actor, input.organizationId);
    const ctx = toTenantExecutionContext(input.actor);

    await this.securityRepository.verifyActiveTenantAccess(ctx);

    const sanitizedWebp = await sanitizePublicImageToWebp(input.image);
    const mediaKey = assertValidPublicMediaKey(
      `${ctx.organizationId}/media/${this.nextUuid()}.webp`,
      ctx.organizationId,
    );

    await this.executeBackend(() =>
      this.backend.putPublicMedia({
        key: mediaKey,
        body: sanitizedWebp,
        contentType: PUBLIC_MEDIA_CONTENT_TYPE,
      }),
    );

    return this.backend.formatPublicMediaUrl(mediaKey);
  }

  public async uploadPrivateEvidence(
    input: UploadPrivateEvidenceInput,
  ): Promise<UploadPrivateEvidenceResult> {
    assertTrustedAuthSession(input.actor);
    assertTenantScope(input.actor, input.organizationId);

    if (
      !(input.evidence instanceof Uint8Array) ||
      input.evidence.byteLength === 0
    ) {
      throw new StorageError(
        'STORAGE_INVALID_INPUT',
        'Private evidence payload must be a non-empty Uint8Array or Buffer.',
      );
    }

    const contentType = validateEvidenceContentType(input.contentType);
    const auditCtx = normalizeAuditContext(input.auditContext);
    const ctx = toTenantExecutionContext(input.actor);

    // 1. Verify live membership in a short tenant transaction before storage I/O.
    await this.securityRepository.verifyActiveTenantAccess(ctx);

    // 2. Snapshot/hash exact original bytes and upload outside any DB transaction.
    const evidenceSnapshot = copyBytes(input.evidence);
    const sha256Hash = computeSha256Hex(evidenceSnapshot);
    const storageKey = assertValidPrivateEvidenceKey(
      `${ctx.organizationId}/evidence/${this.nextUuid()}`,
      ctx.organizationId,
    );

    await this.executeBackend(() =>
      this.backend.putPrivateEvidence({
        key: storageKey,
        body: evidenceSnapshot,
        contentType,
      }),
    );

    // 3. Re-verify live membership and record immutable AuditLog inside a fresh
    //    withTenantTransaction; return key/hash only after commit.
    //    If audit persistence fails after the R2 write, the unreferenced private
    //    object remains inaccessible and no key/hash is returned.
    await this.executeAudit(() =>
      this.securityRepository.recordPrivateEvidenceAudit(ctx, {
        auditId: this.nextUuid(),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        entityType: 'PRIVATE_EVIDENCE',
        entityId: storageKey,
        action: 'PRIVATE_EVIDENCE_UPLOADED',
        nextState: {
          storageKey,
          bucketClassification: 'PRIVATE_EVIDENCE',
          sha256Hash,
          contentType,
          byteLength: evidenceSnapshot.byteLength,
          ...(auditCtx.correlationId
            ? { correlationId: auditCtx.correlationId }
            : {}),
        },
        ipAddress: auditCtx.ipAddress,
        createdAt: this.clock.now(),
      }),
    );

    return {
      storageKey,
      sha256Hash,
    };
  }

  public async createPrivateEvidencePresignedUrl(
    input: CreatePrivateEvidencePresignedUrlInput,
  ): Promise<string> {
    assertTrustedAuthSession(input.actor);
    assertTenantScope(input.actor, input.organizationId);
    const ctx = toTenantExecutionContext(input.actor);

    const storageKey = assertValidPrivateEvidenceKey(
      input.storageKey,
      ctx.organizationId,
    );
    const ttlSeconds = validatePresignedUrlTtl(input.ttlSeconds);
    const auditCtx = normalizeAuditContext(input.auditContext);

    // 1. Verify live membership in a short tenant transaction before HEAD/sign.
    await this.securityRepository.verifyActiveTenantAccess(ctx);

    // 2. Check object existence and sign outside any DB transaction.
    const exists = await this.executeBackend(() =>
      this.backend.privateEvidenceExists(storageKey),
    );
    if (!exists) {
      throw new StorageError(
        'STORAGE_OBJECT_NOT_FOUND',
        'Authorized private evidence object was not found.',
      );
    }

    const rawIssuedAtMs = this.clock.now().getTime();
    if (!Number.isFinite(rawIssuedAtMs)) {
      throw new StorageError(
        'STORAGE_CONFIGURATION_ERROR',
        'Storage clock must return a valid Date.',
      );
    }
    // SigV4 X-Amz-Date has whole-second resolution; normalize issuedAt once so
    // SDK signing, AuditLog metadata, and expiry checks share one instant.
    const issuedAt = new Date(Math.floor(rawIssuedAtMs / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    const presignedUrl = await this.executeBackend(() =>
      this.backend.createPrivatePresignedGetUrl({
        key: storageKey,
        ttlSeconds,
        issuedAt,
      }),
    );

    // 3. Re-verify live membership and record immutable AuditLog inside a fresh
    //    withTenantTransaction before returning the bearer URL.
    await this.executeAudit(() =>
      this.securityRepository.recordPrivateEvidenceAudit(ctx, {
        auditId: this.nextUuid(),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        entityType: 'PRIVATE_EVIDENCE',
        entityId: storageKey,
        action: 'PRIVATE_EVIDENCE_PRESIGNED_URL_ISSUED',
        nextState: {
          storageKey,
          bucketClassification: 'PRIVATE_EVIDENCE',
          ttlSeconds,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          ...(auditCtx.correlationId
            ? { correlationId: auditCtx.correlationId }
            : {}),
        },
        ipAddress: auditCtx.ipAddress,
        createdAt: this.clock.now(),
      }),
    );

    if (this.clock.now().getTime() >= expiresAt.getTime()) {
      throw new StorageError(
        'STORAGE_PRESIGNED_URL_EXPIRED',
        'Presigned URL expired before audit finalization completed.',
      );
    }

    return presignedUrl;
  }

  private nextUuid(): string {
    const candidate = this.idGenerator();
    if (!isValidUuid(candidate)) {
      throw new StorageError(
        'STORAGE_CONFIGURATION_ERROR',
        'Storage idGenerator must produce a valid UUID string.',
      );
    }
    return candidate.toLowerCase();
  }

  private async executeBackend<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StorageError || error instanceof AuthError) {
        throw error;
      }
      throw new StorageError(
        'STORAGE_PROVIDER_ERROR',
        'Storage provider operation failed.',
      );
    }
  }

  private async executeAudit<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StorageError || error instanceof AuthError) {
        throw error;
      }
      if (
        error instanceof TenantContextError &&
        error.code === 'TENANT_CONTEXT_UNAUTHORIZED'
      ) {
        translateTenantContextError(error);
      }
      throw new StorageError(
        'STORAGE_AUDIT_FAILED',
        'Failed to persist immutable audit log for private evidence operation.',
      );
    }
  }
}
