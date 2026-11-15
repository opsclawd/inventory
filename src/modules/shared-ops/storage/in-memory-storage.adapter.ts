import { copyBytes } from './exif-sanitizer';
import {
  formatValidatedPublicMediaUrl,
  type StorageBackend,
  type StorageClock,
  type StorageSecurityRepository,
  StorageService,
  validatePublicMediaOrigin,
} from './storage.service';

export const DEFAULT_IN_MEMORY_PUBLIC_BASE_URL =
  'https://media.storage.invalid' as const;
export const DEFAULT_IN_MEMORY_PRIVATE_BASE_URL =
  'https://private-r2.storage.invalid' as const;

export interface InMemoryStoredObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface InMemoryStorageAdapterOptions {
  readonly securityRepository?: StorageSecurityRepository;
  readonly clock?: StorageClock;
  readonly idGenerator?: () => string;
  readonly publicMediaBaseUrl?: string;
}

function freezeSnapshot(entry: InMemoryStoredObject): InMemoryStoredObject {
  return Object.freeze({
    key: entry.key,
    body: copyBytes(entry.body),
    contentType: entry.contentType,
  });
}

function cloneBucketMap(
  source: ReadonlyMap<string, InMemoryStoredObject>,
): ReadonlyMap<string, InMemoryStoredObject> {
  const snapshot = new Map<string, InMemoryStoredObject>();
  for (const [key, entry] of source.entries()) {
    snapshot.set(key, freezeSnapshot(entry));
  }
  return snapshot;
}

/**
 * Deterministic offline `IStoragePort` adapter backed by isolated per-instance
 * `publicBucket` and `privateBucket` maps. Inherits all session, tenant-prefix,
 * EXIF sanitization, TTL, and audit-logging invariants from `StorageService`.
 */
export class InMemoryStorageAdapter extends StorageService {
  private readonly _publicBucket = new Map<string, InMemoryStoredObject>();
  private readonly _privateBucket = new Map<string, InMemoryStoredObject>();
  private readonly publicMediaOrigin: string;

  public constructor(options: InMemoryStorageAdapterOptions = {}) {
    const publicBucket = new Map<string, InMemoryStoredObject>();
    const privateBucket = new Map<string, InMemoryStoredObject>();
    const publicMediaOrigin = validatePublicMediaOrigin(
      options.publicMediaBaseUrl ?? DEFAULT_IN_MEMORY_PUBLIC_BASE_URL,
    );

    const backend: StorageBackend = {
      async putPublicMedia(params): Promise<void> {
        publicBucket.set(params.key, {
          key: params.key,
          body: copyBytes(params.body),
          contentType: params.contentType,
        });
      },

      formatPublicMediaUrl(key: string): string {
        return formatValidatedPublicMediaUrl(publicMediaOrigin, key);
      },

      async putPrivateEvidence(params): Promise<void> {
        privateBucket.set(params.key, {
          key: params.key,
          body: copyBytes(params.body),
          contentType: params.contentType,
        });
      },

      async privateEvidenceExists(key: string): Promise<boolean> {
        return privateBucket.has(key);
      },

      async createPrivatePresignedGetUrl(params): Promise<string> {
        const encodedKey = params.key
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/');
        const searchParams = new URLSearchParams({
          'X-InMemory-Signature': '1',
          'X-Issued-At': params.issuedAt.toISOString(),
          'X-TTL-Seconds': String(params.ttlSeconds),
        });
        return `${DEFAULT_IN_MEMORY_PRIVATE_BASE_URL}/${encodedKey}?${searchParams.toString()}`;
      },
    };

    super({
      backend,
      securityRepository: options.securityRepository,
      clock: options.clock,
      idGenerator: options.idGenerator,
    });

    this._publicBucket = publicBucket;
    this._privateBucket = privateBucket;
    this.publicMediaOrigin = publicMediaOrigin;
  }

  /**
   * Returns a defensive snapshot of `publicBucket` so caller mutations cannot
   * alter stored media bytes or map entries.
   */
  public get publicBucket(): ReadonlyMap<string, InMemoryStoredObject> {
    return cloneBucketMap(this._publicBucket);
  }

  /**
   * Returns a defensive snapshot of `privateBucket` so caller mutations cannot
   * alter stored evidence bytes or map entries.
   */
  public get privateBucket(): ReadonlyMap<string, InMemoryStoredObject> {
    return cloneBucketMap(this._privateBucket);
  }

  public getPublicObjectSnapshot(key: string): InMemoryStoredObject | undefined {
    const entry = this._publicBucket.get(key);
    return entry ? freezeSnapshot(entry) : undefined;
  }

  public getPrivateObjectSnapshot(
    key: string,
  ): InMemoryStoredObject | undefined {
    const entry = this._privateBucket.get(key);
    return entry ? freezeSnapshot(entry) : undefined;
  }

  public getPublicMediaOrigin(): string {
    return this.publicMediaOrigin;
  }
}
