import type { S3Client } from '@aws-sdk/client-s3';
import type { IStoragePort } from '@/core/ports/storage.port';
import { InMemoryStorageAdapter } from './in-memory-storage.adapter';
import {
  type R2Presigner,
  type R2S3ClientTransport,
  R2StorageAdapter,
  type R2StorageConfig,
} from './r2-storage.adapter';
import type {
  StorageClock,
  StorageSecurityRepository,
} from './storage.service';

export {
  DEFAULT_PRESIGNED_URL_TTL_SECONDS,
  MAX_PRESIGNED_URL_TTL_SECONDS,
  MIN_PRESIGNED_URL_TTL_SECONDS,
  StorageError,
  type CreatePrivateEvidencePresignedUrlInput,
  type IStoragePort,
  type StorageActorContext,
  type StorageAuditContext,
  type StorageErrorCode,
  type StorageErrorStatus,
  type UploadPrivateEvidenceInput,
  type UploadPrivateEvidenceResult,
  type UploadPublicPartMediaInput,
} from '@/core/ports/storage.port';

export {
  ALLOWED_PUBLIC_IMAGE_FORMATS,
  computeSha256Hex,
  copyBytes,
  MAX_PUBLIC_IMAGE_BYTES,
  MAX_PUBLIC_IMAGE_PIXELS,
  PUBLIC_MEDIA_CONTENT_TYPE,
  PUBLIC_WEBP_ENCODE_OPTIONS,
  sanitizePublicImageToWebp,
} from './exif-sanitizer';

export {
  assertValidPrivateEvidenceKey,
  assertValidPublicMediaKey,
  createPrismaStorageSecurityRepository,
  formatValidatedPublicMediaUrl,
  StorageService,
  validatePresignedUrlTtl,
  validatePublicMediaOrigin,
  type CreatePrivatePresignedGetParams,
  type PutPrivateEvidenceParams,
  type PutPublicMediaParams,
  type StorageAuditEventInput,
  type StorageBackend,
  type StorageClock,
  type StorageSecurityRepository,
  type StorageServiceDependencies,
} from './storage.service';

export {
  DEFAULT_IN_MEMORY_PRIVATE_BASE_URL,
  DEFAULT_IN_MEMORY_PUBLIC_BASE_URL,
  InMemoryStorageAdapter,
  type InMemoryStorageAdapterOptions,
  type InMemoryStoredObject,
} from './in-memory-storage.adapter';

export {
  loadR2StorageConfigFromEnv,
  R2StorageAdapter,
  validateR2StorageConfig,
  type R2Presigner,
  type R2S3ClientTransport,
  type R2StorageAdapterOptions,
  type R2StorageConfig,
} from './r2-storage.adapter';

/**
 * Composition options for `createStorageService`.
 *
 * Production settings read from `env` (default `process.env`) outside `NODE_ENV === 'test'`:
 * - `R2_ACCOUNT_ID`
 * - `R2_ACCESS_KEY_ID`
 * - `R2_SECRET_ACCESS_KEY`
 * - `R2_PUBLIC_MEDIA_BUCKET`
 * - `R2_PRIVATE_EVIDENCE_BUCKET` (must differ from `R2_PUBLIC_MEDIA_BUCKET`)
 * - `R2_PUBLIC_MEDIA_BASE_URL` (strict `https://` origin without path/query/fragment)
 *
 * When `NODE_ENV === 'test'`, selects `InMemoryStorageAdapter` before inspecting R2
 * settings. Supply an explicit `securityRepository` fixture for 100% offline execution.
 */
export interface CreateStorageServiceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly securityRepository?: StorageSecurityRepository;
  readonly clock?: StorageClock;
  readonly idGenerator?: () => string;
  readonly publicMediaBaseUrl?: string;
  readonly r2Config?: R2StorageConfig;
  readonly s3Client?: S3Client;
  readonly transport?: R2S3ClientTransport;
  readonly presigner?: R2Presigner;
}

/**
 * Default composition factory for `IStoragePort`.
 * Automatically selects `InMemoryStorageAdapter` when `NODE_ENV === 'test'` and
 * `R2StorageAdapter` otherwise. Importing this barrel initializes neither Prisma
 * nor Cloudflare R2 clients.
 */
export function createStorageService(
  options: CreateStorageServiceOptions = {},
): IStoragePort {
  const env = options.env ?? process.env;
  const nodeEnv = env.NODE_ENV ?? process.env.NODE_ENV;

  if (nodeEnv === 'test') {
    return new InMemoryStorageAdapter({
      securityRepository: options.securityRepository,
      clock: options.clock,
      idGenerator: options.idGenerator,
      publicMediaBaseUrl: options.publicMediaBaseUrl,
    });
  }

  return new R2StorageAdapter({
    config: options.r2Config,
    env,
    s3Client: options.s3Client,
    transport: options.transport,
    presigner: options.presigner,
    securityRepository: options.securityRepository,
    clock: options.clock,
    idGenerator: options.idGenerator,
  });
}
