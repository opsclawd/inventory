import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageError } from '@/core/ports/storage.port';
import {
  formatValidatedPublicMediaUrl,
  type StorageBackend,
  type StorageClock,
  type StorageSecurityRepository,
  StorageService,
  validatePublicMediaOrigin,
} from './storage.service';

const R2_ACCOUNT_ID_REGEX = /^[a-z0-9][a-z0-9_-]{1,127}$/i;
const R2_BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface R2StorageConfig {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly publicMediaBucket: string;
  readonly privateEvidenceBucket: string;
  readonly publicMediaBaseUrl: string;
}

export interface R2S3ClientTransport {
  send(command: PutObjectCommand | HeadObjectCommand): Promise<unknown>;
}

export type R2Presigner = (
  client: S3Client,
  command: GetObjectCommand,
  options: { readonly expiresIn: number; readonly signingDate: Date },
) => Promise<string>;

export interface R2StorageAdapterOptions {
  readonly config?: R2StorageConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly s3Client?: S3Client;
  readonly transport?: R2S3ClientTransport;
  readonly presigner?: R2Presigner;
  readonly securityRepository?: StorageSecurityRepository;
  readonly clock?: StorageClock;
  readonly idGenerator?: () => string;
}

function requireNonEmptySetting(
  value: unknown,
  settingName: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      `Missing or empty required R2 storage setting: ${settingName}.`,
    );
  }
  return value.trim();
}

/**
 * Validates R2 configuration strictly without echoing credentials in errors.
 */
export function validateR2StorageConfig(
  config: R2StorageConfig,
): R2StorageConfig {
  const accountId = requireNonEmptySetting(config.accountId, 'R2_ACCOUNT_ID');
  if (!R2_ACCOUNT_ID_REGEX.test(accountId)) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'R2_ACCOUNT_ID contains invalid characters.',
    );
  }

  const accessKeyId = requireNonEmptySetting(
    config.accessKeyId,
    'R2_ACCESS_KEY_ID',
  );
  const secretAccessKey = requireNonEmptySetting(
    config.secretAccessKey,
    'R2_SECRET_ACCESS_KEY',
  );

  const publicMediaBucket = requireNonEmptySetting(
    config.publicMediaBucket,
    'R2_PUBLIC_MEDIA_BUCKET',
  );
  const privateEvidenceBucket = requireNonEmptySetting(
    config.privateEvidenceBucket,
    'R2_PRIVATE_EVIDENCE_BUCKET',
  );

  if (!R2_BUCKET_NAME_REGEX.test(publicMediaBucket)) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'R2_PUBLIC_MEDIA_BUCKET is not a valid bucket name.',
    );
  }
  if (!R2_BUCKET_NAME_REGEX.test(privateEvidenceBucket)) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'R2_PRIVATE_EVIDENCE_BUCKET is not a valid bucket name.',
    );
  }
  if (publicMediaBucket === privateEvidenceBucket) {
    throw new StorageError(
      'STORAGE_CONFIGURATION_ERROR',
      'R2_PUBLIC_MEDIA_BUCKET and R2_PRIVATE_EVIDENCE_BUCKET must be distinct buckets.',
    );
  }

  const publicMediaBaseUrl = validatePublicMediaOrigin(
    config.publicMediaBaseUrl,
  );

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    publicMediaBucket,
    privateEvidenceBucket,
    publicMediaBaseUrl,
  };
}

/**
 * Loads and validates Cloudflare R2 configuration from server environment variables.
 */
export function loadR2StorageConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): R2StorageConfig {
  return validateR2StorageConfig({
    accountId: env.R2_ACCOUNT_ID ?? '',
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    publicMediaBucket: env.R2_PUBLIC_MEDIA_BUCKET ?? '',
    privateEvidenceBucket: env.R2_PRIVATE_EVIDENCE_BUCKET ?? '',
    publicMediaBaseUrl: env.R2_PUBLIC_MEDIA_BASE_URL ?? '',
  });
}

function isS3NotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NotFound' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

/**
 * Production S3-compatible Cloudflare R2 `IStoragePort` adapter binding physically
 * segregated `R2_PUBLIC_MEDIA_BUCKET` and `R2_PRIVATE_EVIDENCE_BUCKET`.
 *
 * Operational prerequisites (must be enforced at Cloudflare R2 bucket provisioning):
 * - `R2_PRIVATE_EVIDENCE_BUCKET` must block all public access and attach no custom CDN domain.
 * - Object lifecycle rules must preserve 7-year / 25-year retention requirements.
 */
export class R2StorageAdapter extends StorageService {
  public constructor(options: R2StorageAdapterOptions = {}) {
    const validatedConfig = options.config
      ? validateR2StorageConfig(options.config)
      : loadR2StorageConfigFromEnv(options.env);

    const client =
      options.s3Client ??
      new S3Client({
        region: 'auto',
        endpoint: `https://${validatedConfig.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: validatedConfig.accessKeyId,
          secretAccessKey: validatedConfig.secretAccessKey,
        },
      });

    const transport: R2S3ClientTransport = options.transport ?? client;
    const presigner: R2Presigner =
      options.presigner ??
      ((s3, command, signOptions) => getSignedUrl(s3, command, signOptions));

    const backend: StorageBackend = {
      async putPublicMedia(params): Promise<void> {
        try {
          await transport.send(
            new PutObjectCommand({
              Bucket: validatedConfig.publicMediaBucket,
              Key: params.key,
              Body: params.body,
              ContentType: params.contentType,
              ContentLength: params.body.byteLength,
            }),
          );
        } catch {
          throw new StorageError(
            'STORAGE_PROVIDER_ERROR',
            'Failed to upload public part media to R2.',
          );
        }
      },

      formatPublicMediaUrl(key: string): string {
        return formatValidatedPublicMediaUrl(
          validatedConfig.publicMediaBaseUrl,
          key,
        );
      },

      async putPrivateEvidence(params): Promise<void> {
        try {
          await transport.send(
            new PutObjectCommand({
              Bucket: validatedConfig.privateEvidenceBucket,
              Key: params.key,
              Body: params.body,
              ContentType: params.contentType,
              ContentLength: params.body.byteLength,
            }),
          );
        } catch {
          throw new StorageError(
            'STORAGE_PROVIDER_ERROR',
            'Failed to upload private evidence to R2.',
          );
        }
      },

      async privateEvidenceExists(key: string): Promise<boolean> {
        try {
          await transport.send(
            new HeadObjectCommand({
              Bucket: validatedConfig.privateEvidenceBucket,
              Key: key,
            }),
          );
          return true;
        } catch (error) {
          if (isS3NotFoundError(error)) {
            return false;
          }
          throw new StorageError(
            'STORAGE_PROVIDER_ERROR',
            'Failed to verify private evidence object existence in R2.',
          );
        }
      },

      async createPrivatePresignedGetUrl(params): Promise<string> {
        try {
          return await presigner(
            client,
            new GetObjectCommand({
              Bucket: validatedConfig.privateEvidenceBucket,
              Key: params.key,
            }),
            {
              expiresIn: params.ttlSeconds,
              signingDate: params.issuedAt,
            },
          );
        } catch {
          throw new StorageError(
            'STORAGE_PROVIDER_ERROR',
            'Failed to generate private evidence presigned URL.',
          );
        }
      },
    };

    super({
      backend,
      securityRepository: options.securityRepository,
      clock: options.clock,
      idGenerator: options.idGenerator,
    });
  }
}
