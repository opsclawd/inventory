import { createHash, randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { OrganizationType, PrismaClient, UserRole } from '@prisma/client';
import sharp from 'sharp';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import {
  withTenantTransaction,
  type TenantExecutionContext,
} from '@/infrastructure/db/tenant-transaction';
import {
  AuthError,
  type AuthRepository,
  type AuthSessionContext,
  type BootstrapMembershipRecord,
  type BootstrapUserRecord,
  type DeactivateMembershipRepoInput,
  type MembershipTransitionResult,
  type ReactivateMembershipRepoInput,
  type WorkspaceSwitchRepoInput,
} from '@/modules/shared-ops/auth';
import { resolveTestHeaderAuthContext } from '@/modules/shared-ops/auth/test-header-auth.adapter';
import {
  assertValidPrivateEvidenceKey,
  assertValidPublicMediaKey,
  computeSha256Hex,
  createPrismaStorageSecurityRepository,
  createStorageService,
  DEFAULT_IN_MEMORY_PRIVATE_BASE_URL,
  DEFAULT_IN_MEMORY_PUBLIC_BASE_URL,
  formatValidatedPublicMediaUrl,
  InMemoryStorageAdapter,
  MAX_PUBLIC_IMAGE_BYTES,
  R2StorageAdapter,
  type R2StorageConfig,
  sanitizePublicImageToWebp,
  type StorageAuditEventInput,
  StorageError,
  type StorageSecurityRepository,
} from '@/modules/shared-ops/storage';

// ============================================================================
// Offline Auth + Storage Security Fixtures
// ============================================================================

interface FixtureOrg {
  id: string;
  slug: string;
  name: string;
  organizationType: OrganizationType;
  isActive: boolean;
}

interface FixtureUser {
  id: string;
  isActive: boolean;
  mfaEnrolled: boolean;
}

interface FixtureMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: UserRole;
  isDefaultWorkspace: boolean;
  isActive: boolean;
}

class OfflineStorageSecurityStore implements AuthRepository, StorageSecurityRepository {
  public readonly orgs = new Map<string, FixtureOrg>();
  public readonly users = new Map<string, FixtureUser>();
  public readonly memberships = new Map<string, FixtureMembership>();
  public readonly auditLogs: StorageAuditEventInput[] = [];
  public failNextAuditWithInfraError = false;
  public activeTransactionDepth = 0;
  public onBeforeAuditInsert?: (event: StorageAuditEventInput) => Promise<void> | void;

  public seedStandardFixtures(): void {
    this.orgs.clear();
    this.users.clear();
    this.memberships.clear();
    this.auditLogs.length = 0;
    this.failNextAuditWithInfraError = false;
    this.activeTransactionDepth = 0;
    this.onBeforeAuditInsert = undefined;

    this.orgs.set(PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT, {
      id: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      slug: 'ORG_SALVAGE_EXPORT',
      name: 'Auto & Marine Salvage (Kemptville)',
      organizationType: OrganizationType.SALVAGE_AND_EXPORT,
      isActive: true,
    });
    this.orgs.set(PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC, {
      id: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      slug: 'ORG_CANNABIS_NURSERY_PROC',
      name: 'Cannabis Nursery & Processing (Brockville)',
      organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      isActive: true,
    });

    this.users.set(PHASE1A_SEED_IDS.users.architectCfo, {
      id: PHASE1A_SEED_IDS.users.architectCfo,
      isActive: true,
      mfaEnrolled: true,
    });
    this.users.set(PHASE1A_SEED_IDS.users.hunterMechanic, {
      id: PHASE1A_SEED_IDS.users.hunterMechanic,
      isActive: true,
      mfaEnrolled: false,
    });
    this.users.set(PHASE1A_SEED_IDS.users.cannabisQap, {
      id: PHASE1A_SEED_IDS.users.cannabisQap,
      isActive: true,
      mfaEnrolled: true,
    });

    this.memberships.set(PHASE1A_SEED_IDS.memberships.cfoSalvage, {
      id: PHASE1A_SEED_IDS.memberships.cfoSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      isDefaultWorkspace: true,
      isActive: true,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.cfoCannabis, {
      id: PHASE1A_SEED_IDS.memberships.cfoCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      isDefaultWorkspace: false,
      isActive: true,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.hunterSalvage, {
      id: PHASE1A_SEED_IDS.memberships.hunterSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.hunterMechanic,
      role: UserRole.HUNTER_MECHANIC,
      isDefaultWorkspace: true,
      isActive: true,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.qapCannabis, {
      id: PHASE1A_SEED_IDS.memberships.qapCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.cannabisQap,
      role: UserRole.CANNABIS_QAP_COMPLIANCE,
      isDefaultWorkspace: true,
      isActive: true,
    });
  }

  public async findActiveUserBootstrap(
    userId: string,
  ): Promise<BootstrapUserRecord | null> {
    const user = this.users.get(userId.toLowerCase());
    if (!user || !user.isActive) {
      return null;
    }
    const memberships: BootstrapMembershipRecord[] = [];
    for (const m of this.memberships.values()) {
      if (m.userId !== user.id || !m.isActive) {
        continue;
      }
      const org = this.orgs.get(m.organizationId);
      if (!org || !org.isActive) {
        continue;
      }
      memberships.push({
        membershipId: m.id,
        organizationId: org.id,
        organizationSlug: org.slug,
        organizationName: org.name,
        organizationType: org.organizationType,
        organizationIsActive: org.isActive,
        role: m.role,
        isDefaultWorkspace: m.isDefaultWorkspace,
        isActive: m.isActive,
      });
    }
    return {
      userId: user.id,
      isActive: user.isActive,
      mfaEnrolled: user.mfaEnrolled,
      memberships,
    };
  }

  public async recordWorkspaceSwitch(_input: WorkspaceSwitchRepoInput): Promise<void> {
    return;
  }

  public async deactivateOrganizationMembership(
    _input: DeactivateMembershipRepoInput,
  ): Promise<MembershipTransitionResult> {
    throw new Error('Not used in storage unit fixture.');
  }

  public async reactivateOrganizationMembership(
    _input: ReactivateMembershipRepoInput,
  ): Promise<MembershipTransitionResult> {
    throw new Error('Not used in storage unit fixture.');
  }

  private assertLiveAccess(ctx: TenantExecutionContext): void {
    const org = this.orgs.get(ctx.organizationId.toLowerCase());
    const user = this.users.get(ctx.userId.toLowerCase());
    const membership = [...this.memberships.values()].find(
      (m) =>
        m.organizationId === ctx.organizationId.toLowerCase() &&
        m.userId === ctx.userId.toLowerCase() &&
        m.role === ctx.role &&
        m.isActive,
    );
    if (!org || !org.isActive || !user || !user.isActive || !membership) {
      throw new AuthError(
        'MEMBERSHIP_REVOKED_OR_INACTIVE',
        'Active organization membership is revoked, inactive, or unauthorized.',
      );
    }
  }

  public async verifyActiveTenantAccess(
    ctx: TenantExecutionContext,
  ): Promise<void> {
    this.activeTransactionDepth += 1;
    try {
      this.assertLiveAccess(ctx);
    } finally {
      this.activeTransactionDepth -= 1;
    }
  }

  public async recordPrivateEvidenceAudit(
    ctx: TenantExecutionContext,
    event: StorageAuditEventInput,
  ): Promise<void> {
    this.activeTransactionDepth += 1;
    try {
      if (this.onBeforeAuditInsert) {
        await this.onBeforeAuditInsert(event);
      }
      this.assertLiveAccess(ctx);
      if (this.failNextAuditWithInfraError) {
        this.failNextAuditWithInfraError = false;
        throw new StorageError(
          'STORAGE_AUDIT_FAILED',
          'Simulated audit transaction rollback.',
        );
      }
      // Snapshot copy to mimic transactional commit boundary
      this.auditLogs.push({
        ...event,
        nextState: { ...event.nextState },
      });
    } finally {
      this.activeTransactionDepth -= 1;
    }
  }
}

function createDeterministicIdGenerator(prefixNum = 1): () => string {
  let counter = prefixNum;
  return () => {
    const hex = counter.toString(16).padStart(12, '0');
    counter += 1;
    return `90000000-0000-4000-8000-${hex}`;
  };
}

/**
 * Builds an asymmetric 12x8 test image (left half bright red, right half bright blue)
 * so EXIF orientation rotation can be verified at the pixel level.
 */
async function createAsymmetricImageBuffer(
  format: 'jpeg' | 'png' | 'webp',
  options?: {
    withExifGps?: boolean;
    orientation?: number;
    withIcc?: boolean;
  },
): Promise<Buffer> {
  const width = 12;
  const height = 8;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      if (x < width / 2) {
        raw[idx] = 240;
        raw[idx + 1] = 20;
        raw[idx + 2] = 20;
      } else {
        raw[idx] = 20;
        raw[idx + 1] = 40;
        raw[idx + 2] = 240;
      }
    }
  }

  let pipeline = sharp(raw, {
    raw: { width, height, channels: 3 },
  });

  if (format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: 95 });
  } else if (format === 'png') {
    pipeline = pipeline.png();
  } else {
    pipeline = pipeline.webp({ quality: 95 });
  }

  if (options?.withExifGps || options?.orientation || options?.withIcc) {
    pipeline = pipeline.withMetadata({
      ...(options.orientation ? { orientation: options.orientation } : {}),
      ...(options.withIcc ? { icc: 'srgb' } : {}),
      ...(options.withExifGps
        ? {
            exif: {
              IFD0: {
                Make: 'SensitivePhoneMake',
                Model: 'SecretGPSCamera9000',
              },
              IFD3: {
                GPSLatitudeRef: 'N',
                GPSLatitude: '45/1 1/1 23/1',
                GPSLongitudeRef: 'W',
                GPSLongitude: '75/1 38/1 12/1',
              },
            },
          }
        : {}),
    });
  }

  return pipeline.toBuffer();
}

function makeFakeR2Config(
  overrides: Partial<R2StorageConfig> = {},
): R2StorageConfig {
  return {
    accountId: 'cfaccount1234567890abcdef',
    accessKeyId: 'AKIA_TEST_KEY_ID_SECRET',
    secretAccessKey: 'R2_SUPER_SECRET_ACCESS_KEY_999',
    publicMediaBucket: 'inventory-public-media',
    privateEvidenceBucket: 'inventory-private-evidence',
    publicMediaBaseUrl: 'https://cdn.salvage-test.invalid',
    ...overrides,
  };
}

// ============================================================================
// Offline Contract, Sanitization, Security & R2 Command Tests
// ============================================================================

describe('Issue #5: Segregated Storage Port, EXIF Sanitization & Tenant Isolation (Offline)', () => {
  let store: OfflineStorageSecurityStore;
  let salvageCfoSession: AuthSessionContext;
  let salvageHunterSession: AuthSessionContext;
  let cannabisQapSession: AuthSessionContext;

  beforeEach(async () => {
    store = new OfflineStorageSecurityStore();
    store.seedStandardFixtures();

    salvageCfoSession = await resolveTestHeaderAuthContext(
      {
        'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
        'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        'x-test-aal': 'aal2',
      },
      { repository: store },
    );
    salvageHunterSession = await resolveTestHeaderAuthContext(
      {
        'x-test-user-id': PHASE1A_SEED_IDS.users.hunterMechanic,
        'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      },
      { repository: store },
    );
    cannabisQapSession = await resolveTestHeaderAuthContext(
      {
        'x-test-user-id': PHASE1A_SEED_IDS.users.cannabisQap,
        'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        'x-test-aal': 'aal2',
      },
      { repository: store },
    );
  });

  describe('EXIF GPS stripping & pure image sanitizer (RULE-MKT-002)', () => {
    it('strips EXIF GPS, camera make/model, orientation, XMP/IPTC/ICC metadata, applies pixel rotation, and is deterministic', async () => {
      const jpegInput = await createAsymmetricImageBuffer('jpeg', {
        withExifGps: true,
        orientation: 6, // 90 deg CW: 12x8 becomes 8x12 after rotate()
        withIcc: true,
      });
      const inputCopyBefore = Buffer.from(jpegInput);

      const inMeta = await sharp(jpegInput).metadata();
      expect(inMeta.format).toBe('jpeg');
      expect(inMeta.orientation).toBe(6);
      expect(inMeta.exif).toBeDefined();
      expect(jpegInput.includes(Buffer.from('SensitivePhoneMake'))).toBe(true);
      expect(jpegInput.includes(Buffer.from('SecretGPSCamera9000'))).toBe(true);

      const sanitized1 = await sanitizePublicImageToWebp(jpegInput);
      const sanitized2 = await sanitizePublicImageToWebp(jpegInput);

      // Caller input buffer must not be mutated
      expect(Buffer.compare(jpegInput, inputCopyBefore)).toBe(0);
      // Same bytes + options produce deterministic WebP output
      expect(Buffer.compare(Buffer.from(sanitized1), Buffer.from(sanitized2))).toBe(0);

      const outMeta = await sharp(sanitized1).metadata();
      expect(outMeta.format).toBe('webp');
      expect(outMeta.width).toBe(8);
      expect(outMeta.height).toBe(12);
      expect(outMeta.orientation).toBeUndefined();
      expect(outMeta.exif).toBeUndefined();
      expect(outMeta.icc).toBeUndefined();
      expect(outMeta.xmp).toBeUndefined();
      expect(outMeta.iptc).toBeUndefined();

      const outBuf = Buffer.from(sanitized1);
      expect(outBuf.includes(Buffer.from('SensitivePhoneMake'))).toBe(false);
      expect(outBuf.includes(Buffer.from('SecretGPSCamera9000'))).toBe(false);
      expect(outBuf.includes(Buffer.from('EXIF'))).toBe(false);

      // Verify rotated pixel orientation: original left half was red, rotated 90 deg CW -> top half is red
      const { data, info } = await sharp(sanitized1)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const topRowPixelIdx = 1 * info.width * info.channels + 2 * info.channels;
      const bottomRowPixelIdx =
        (info.height - 2) * info.width * info.channels + 2 * info.channels;
      expect(data[topRowPixelIdx]!).toBeGreaterThan(150);
      expect(data[topRowPixelIdx + 2]!).toBeLessThan(80);
      expect(data[bottomRowPixelIdx + 2]!).toBeGreaterThan(150);
      expect(data[bottomRowPixelIdx]!).toBeLessThan(80);
    });

    it('sanitizes metadata-bearing PNG, metadata-bearing WebP, and metadata-free images into clean WebP', async () => {
      const pngWithMeta = await createAsymmetricImageBuffer('png', {
        withExifGps: true,
        withIcc: true,
      });
      const webpWithMeta = await createAsymmetricImageBuffer('webp', {
        withExifGps: true,
        withIcc: true,
      });
      const cleanJpeg = await createAsymmetricImageBuffer('jpeg');

      for (const input of [pngWithMeta, webpWithMeta, cleanJpeg]) {
        const sanitized = await sanitizePublicImageToWebp(input);
        const meta = await sharp(sanitized).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.exif).toBeUndefined();
        expect(meta.icc).toBeUndefined();
        expect(meta.xmp).toBeUndefined();
        expect(meta.iptc).toBeUndefined();
      }
    });

    it('rejects empty, corrupt, truncated, unsupported, animated/APNG, oversize, and excessive-pixel inputs before any bucket write', async () => {
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(),
      });

      const validJpeg = await createAsymmetricImageBuffer('jpeg');
      const truncatedJpeg = validJpeg.subarray(0, Math.floor(validJpeg.length * 0.5));
      const svgPayload = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
      );
      const gifPayload = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .gif()
        .toBuffer();
      const tiffPayload = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .tiff()
        .toBuffer();

      const f1 = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      const f2 = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 0, g: 0, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      const animatedWebp = await sharp([f1, f2], { join: { animated: true } })
        .webp()
        .toBuffer();

      // Synthetic minimal PNG with an acTL chunk before IDAT to prove APNG rejection
      const cleanPng = await createAsymmetricImageBuffer('png');
      const idatOffset = cleanPng.indexOf(Buffer.from('IDAT'));
      expect(idatOffset).toBeGreaterThan(8);
      const acTlChunk = Buffer.from([
        0x00, 0x00, 0x00, 0x08, // length = 8
        0x61, 0x63, 0x54, 0x4c, // 'acTL'
        0x00, 0x00, 0x00, 0x02, // num_frames = 2
        0x00, 0x00, 0x00, 0x00, // num_plays = 0
        0x00, 0x00, 0x00, 0x00, // crc placeholder
      ]);
      const apngLike = Buffer.concat([
        cleanPng.subarray(0, idatOffset - 4),
        acTlChunk,
        cleanPng.subarray(idatOffset - 4),
      ]);

      const invalidInputs: Uint8Array[] = [
        new Uint8Array(0),
        Buffer.from('not-an-image-bytes'),
        truncatedJpeg,
        svgPayload,
        gifPayload,
        tiffPayload,
        Buffer.from('%PDF-1.4\n%corrupt\n'),
        animatedWebp,
        apngLike,
      ];

      for (const badImage of invalidInputs) {
        await expect(
          adapter.uploadPublicPartMedia({
            actor: salvageCfoSession,
            organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
            image: badImage,
          }),
        ).rejects.toMatchObject({
          status: 400,
          code: 'STORAGE_INVALID_IMAGE',
        });
      }

      // Exceed 20 MiB byte ceiling
      const oversizedBytes = new Uint8Array(MAX_PUBLIC_IMAGE_BYTES + 1);
      await expect(
        adapter.uploadPublicPartMedia({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          image: oversizedBytes,
        }),
      ).rejects.toMatchObject({
        status: 413,
        code: 'STORAGE_PAYLOAD_TOO_LARGE',
      });

      // Exceed 40M pixel ceiling (8000 x 6000 = 48,000,000 pixels)
      const excessivePixelPng = await sharp({
        create: {
          width: 8000,
          height: 6000,
          channels: 3,
          background: { r: 10, g: 20, b: 30 },
        },
      })
        .png()
        .toBuffer();
      await expect(
        adapter.uploadPublicPartMedia({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          image: excessivePixelPng,
        }),
      ).rejects.toMatchObject({
        status: 413,
        code: 'STORAGE_PAYLOAD_TOO_LARGE',
      });

      expect(adapter.publicBucket.size).toBe(0);
      expect(adapter.privateBucket.size).toBe(0);
    });
  });

  describe('Bucket segregation, private evidence SHA-256 integrity & snapshot isolation', () => {
    it('routes public uploads exclusively to publicBucket and rejects formatting private evidence keys as public URLs', async () => {
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
      });

      const jpegWithGps = await createAsymmetricImageBuffer('jpeg', {
        withExifGps: true,
      });

      const url = await adapter.uploadPublicPartMedia({
        actor: salvageHunterSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        image: jpegWithGps,
      });

      const expectedKey = `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/media/90000000-0000-4000-8000-000000000001.webp`;
      expect(url).toBe(`${DEFAULT_IN_MEMORY_PUBLIC_BASE_URL}/${expectedKey}`);
      expect(adapter.publicBucket.size).toBe(1);
      expect(adapter.privateBucket.size).toBe(0);

      const stored = adapter.getPublicObjectSnapshot(expectedKey);
      expect(stored?.contentType).toBe('image/webp');
      const storedMeta = await sharp(stored!.body).metadata();
      expect(storedMeta.format).toBe('webp');
      expect(storedMeta.exif).toBeUndefined();

      // Public URL formatter must strictly reject private evidence keys
      const privateKey = `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/evidence/90000000-0000-4000-8000-000000000099`;
      expect(() =>
        formatValidatedPublicMediaUrl(
          DEFAULT_IN_MEMORY_PUBLIC_BASE_URL,
          privateKey,
        ),
      ).toThrowError(StorageError);

      try {
        formatValidatedPublicMediaUrl(
          DEFAULT_IN_MEMORY_PUBLIC_BASE_URL,
          privateKey,
        );
      } catch (err) {
        expect(err).toMatchObject({
          status: 403,
          code: 'STORAGE_KEY_FORBIDDEN',
        });
      }
    });

    it.each([
      {
        label: 'receiptStorageKey',
        contentType: 'image/jpeg',
        payload: Buffer.from('RECEIPT-JPEG-RAW-BYTES-\xff\xd8\xff\xe0'),
      },
      {
        label: 'settlementProofStorageKey',
        contentType: 'application/pdf',
        payload: Buffer.from('%PDF-1.7\nBANK-DEPOSIT-PROOF\n%%EOF'),
      },
      {
        label: 'exportProofStorageKey',
        contentType: 'application/pdf',
        payload: Buffer.from('%PDF-1.7\nCBSA-BILL-OF-LADING\n%%EOF'),
      },
      {
        label: 'feeTaxInvoiceStorageKey',
        contentType: 'application/pdf',
        payload: Buffer.from('%PDF-1.7\nEBAY-SELLER-FEE-HST-INVOICE\n%%EOF'),
      },
      {
        label: 'recyclerTicketStorageKey',
        contentType: 'image/png',
        payload: Buffer.from('RECYCLER-SCALE-TICKET-PNG-BYTES'),
      },
      {
        label: 'sellerPhotoIdStorageKey',
        contentType: 'image/jpeg',
        payload: Buffer.from('HTA-S60-SELLER-ID-BYTES'),
      },
      {
        label: 'driveOnFailSheetStorageKey',
        contentType: 'application/pdf',
        payload: Buffer.from('%PDF-1.7\nMTO-DRIVEON-FAIL-SHEET\n%%EOF'),
      },
      {
        label: 'billOfSaleStorageKey',
        contentType: 'application/pdf',
        payload: Buffer.from('%PDF-1.7\nBILL-OF-SALE\n%%EOF'),
      },
    ])(
      'stores exact unmodified bytes and computes SHA-256 for private evidence ($label)',
      async ({ contentType, payload }) => {
        const adapter = new InMemoryStorageAdapter({
          securityRepository: store,
          idGenerator: createDeterministicIdGenerator(10),
          clock: { now: () => new Date('2026-11-15T10:00:00.000Z') },
        });

        const expectedHash = createHash('sha256')
          .update(payload)
          .digest('hex');

        const result = await adapter.uploadPrivateEvidence({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          evidence: payload,
          contentType,
          auditContext: { ipAddress: '198.51.100.42', correlationId: 'req-123' },
        });

        expect(result.storageKey).toBe(
          `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/evidence/90000000-0000-4000-8000-00000000000a`,
        );
        expect(result.sha256Hash).toBe(expectedHash);
        expect(result.sha256Hash).toMatch(/^[0-9a-f]{64}$/);
        expect(computeSha256Hex(payload)).toBe(expectedHash);

        expect(adapter.publicBucket.size).toBe(0);
        expect(adapter.privateBucket.size).toBe(1);

        const stored = adapter.getPrivateObjectSnapshot(result.storageKey);
        expect(stored?.contentType).toBe(contentType);
        expect(Buffer.compare(Buffer.from(stored!.body), payload)).toBe(0);
      },
    );

    it('isolates adapter maps and protects stored bytes with defensive copies', async () => {
      const adapterA = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
      });
      const adapterB = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
      });

      const mutableInput = Uint8Array.from([1, 2, 3, 4, 5]);
      const originalCopy = Uint8Array.from(mutableInput);

      const { storageKey } = await adapterA.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: mutableInput,
        contentType: 'application/octet-stream',
      });

      // Mutate caller input buffer after upload
      mutableInput.fill(0xff);

      // Mutate returned snapshot buffer & snapshot Map
      const snapshot = adapterA.getPrivateObjectSnapshot(storageKey)!;
      snapshot.body.fill(0xaa);

      const bucketSnapshot = adapterA.privateBucket;
      bucketSnapshot.get(storageKey)!.body.fill(0xbb);

      // Internal stored bytes remain identical to original upload
      const freshSnapshot = adapterA.getPrivateObjectSnapshot(storageKey)!;
      expect(
        Buffer.compare(Buffer.from(freshSnapshot.body), Buffer.from(originalCopy)),
      ).toBe(0);

      // Adapter B remains completely isolated
      expect(adapterB.privateBucket.size).toBe(0);
      expect(adapterB.publicBucket.size).toBe(0);
    });

    it('rejects empty evidence or invalid contentType with 400 STORAGE_INVALID_INPUT', async () => {
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
      });

      await expect(
        adapter.uploadPrivateEvidence({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          evidence: new Uint8Array(0),
          contentType: 'application/pdf',
        }),
      ).rejects.toMatchObject({ status: 400, code: 'STORAGE_INVALID_INPUT' });

      for (const badType of ['', '   ', 'application/pdf\r\nX-Injected: 1', 'invalid-mime']) {
        await expect(
          adapter.uploadPrivateEvidence({
            actor: salvageCfoSession,
            organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
            evidence: Uint8Array.from([1, 2, 3]),
            contentType: badType,
          }),
        ).rejects.toMatchObject({ status: 400, code: 'STORAGE_INVALID_INPUT' });
      }
    });
  });

  describe('Tenant prefix enforcement, path-traversal rejection & cross-tenant isolation', () => {
    it('rejects path traversal, encoding escapes, wrong namespaces, uppercase UUIDs, and cross-tenant keys before backend access', async () => {
      let headOrSignCalls = 0;
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
      });
      // Also test R2StorageAdapter with spy transport to verify ZERO backend calls on bad keys
      const r2Adapter = new R2StorageAdapter({
        config: makeFakeR2Config(),
        securityRepository: store,
        transport: {
          async send() {
            headOrSignCalls += 1;
            return {};
          },
        },
        presigner: async () => {
          headOrSignCalls += 1;
          return 'https://should-never-be-called.invalid';
        },
      });

      const validUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const salvageOrg = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
      const cannabisOrg = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;

      const forbiddenKeys = [
        '',
        `/${salvageOrg}/evidence/${validUuid}`,
        `${salvageOrg}/evidence/${validUuid}/`,
        `${salvageOrg}/evidence/../evidence/${validUuid}`,
        `../${salvageOrg}/evidence/${validUuid}`,
        `${salvageOrg}/evidence/${validUuid}/extra`,
        `${salvageOrg}\\evidence\\${validUuid}`,
        `${salvageOrg}%2fevidence%2f${validUuid}`,
        `${salvageOrg}/evidence/%2e%2e/${validUuid}`,
        `${salvageOrg}/evidence/${validUuid}?download=1`,
        `${salvageOrg}/evidence/${validUuid}#frag`,
        `${salvageOrg}/evidence/${validUuid}\n`,
        `${salvageOrg}/evidence/${validUuid}\u0000`,
        `https://cdn.example.com/${salvageOrg}/evidence/${validUuid}`,
        `${salvageOrg}/media/${validUuid}.webp`, // wrong namespace for private URL
        `${salvageOrg}/other/${validUuid}`,
        `AAAAAAAA-0000-4000-8000-000000000001/evidence/${validUuid}`,
        `${salvageOrg}/evidence/${validUuid.toUpperCase()}`,
        `${salvageOrg}0/evidence/${validUuid}`, // prefix collision
        `${cannabisOrg}/evidence/${validUuid}`, // cross-tenant org prefix
        'ORG_SALVAGE_EXPORT/evidence/' + validUuid, // slug instead of canonical UUID
      ];

      for (const badKey of forbiddenKeys) {
        await expect(
          adapter.createPrivateEvidencePresignedUrl({
            actor: salvageCfoSession,
            organizationId: salvageOrg,
            storageKey: badKey,
          }),
        ).rejects.toMatchObject({
          status: 403,
          code: 'STORAGE_KEY_FORBIDDEN',
        });

        await expect(
          r2Adapter.createPrivateEvidencePresignedUrl({
            actor: salvageCfoSession,
            organizationId: salvageOrg,
            storageKey: badKey,
          }),
        ).rejects.toMatchObject({
          status: 403,
          code: 'STORAGE_KEY_FORBIDDEN',
        });
      }

      expect(headOrSignCalls).toBe(0);
      expect(store.auditLogs).toHaveLength(0);

      // Also verify public key validator rejects traversal/wrong-org/evidence keys
      expect(() =>
        assertValidPublicMediaKey(
          `${cannabisOrg}/media/${validUuid}.webp`,
          salvageOrg,
        ),
      ).toThrowError(StorageError);
      expect(() =>
        assertValidPrivateEvidenceKey(
          `${salvageOrg}/media/${validUuid}.webp`,
          salvageOrg,
        ),
      ).toThrowError(StorageError);
    });

    it('enforces selected active workspace isolation even for a dual-member CFO across Salvage and Cannabis orgs', async () => {
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(50),
      });

      const cannabisCfoSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          'x-test-aal': 'aal2',
        },
        { repository: store },
      );

      // Upload private evidence inside Cannabis workspace
      const { storageKey: cannabisKey } = await adapter.uploadPrivateEvidence({
        actor: cannabisCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        evidence: Buffer.from('BROCKVILLE-COA-EVIDENCE'),
        contentType: 'application/pdf',
      });

      // Dual-member CFO with Salvage selected cannot pass Cannabis organizationId (403 TENANT_SCOPE_MISMATCH)
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          storageKey: cannabisKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'TENANT_SCOPE_MISMATCH',
      });

      // Dual-member CFO with Salvage selected cannot pass Cannabis key under Salvage orgId (403 STORAGE_KEY_FORBIDDEN)
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey: cannabisKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'STORAGE_KEY_FORBIDDEN',
      });

      // Separate Cannabis QAP user also cannot read Salvage keys
      const { storageKey: salvageKey } = await adapter.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: Buffer.from('KEMPTVILLE-SETTLEMENT-PROOF'),
        contentType: 'application/pdf',
      });
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: cannabisQapSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          storageKey: salvageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'STORAGE_KEY_FORBIDDEN',
      });

      // Active Cannabis CFO session CAN presign its own workspace key
      const signedCannabisUrl = await adapter.createPrivateEvidencePresignedUrl({
        actor: cannabisCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        storageKey: cannabisKey,
      });
      expect(signedCannabisUrl).toContain(DEFAULT_IN_MEMORY_PRIVATE_BASE_URL);
    });
  });

  describe('Presigned URL TTL boundaries, missing objects, auth revocation & audit atomicity', () => {
    it('enforces TTL in [1, 900], defaults omitted TTL to 900, and returns 404 for absent private objects', async () => {
      const fixedNow = new Date('2026-11-15T12:00:00.000Z');
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
        clock: { now: () => fixedNow },
      });

      const { storageKey } = await adapter.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: Buffer.from('BILL-OF-LADING-DATA'),
        contentType: 'application/pdf',
      });

      const urlDefault = await adapter.createPrivateEvidencePresignedUrl({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
      });
      expect(urlDefault).toContain('X-TTL-Seconds=900');

      const urlMin = await adapter.createPrivateEvidencePresignedUrl({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
        ttlSeconds: 1,
      });
      expect(urlMin).toContain('X-TTL-Seconds=1');

      const urlMax = await adapter.createPrivateEvidencePresignedUrl({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
        ttlSeconds: 900,
      });
      expect(urlMax).toContain('X-TTL-Seconds=900');

      const auditCountBeforeBadTtl = store.auditLogs.length;

      for (const badTtl of [
        901,
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        await expect(
          adapter.createPrivateEvidencePresignedUrl({
            actor: salvageCfoSession,
            organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
            storageKey,
            ttlSeconds: badTtl,
          }),
        ).rejects.toMatchObject({
          status: 400,
          code: 'STORAGE_INVALID_TTL',
        });
      }

      // Missing authorized object returns 404 without emitting issuance audit
      const missingKey = `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/evidence/99999999-0000-4000-8000-000000000999`;
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey: missingKey,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'STORAGE_OBJECT_NOT_FOUND',
      });

      expect(store.auditLogs.length).toBe(auditCountBeforeBadTtl);
    });

    it('rejects forged actors (401), deactivated memberships (403), inactive users/orgs, role changes, and mid-flight revocations', async () => {
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
      });

      // Forged structural lookalike must fail 401 UNAUTHENTICATED
      const forgedActor = {
        userId: salvageCfoSession.userId,
        activeOrganizationId: salvageCfoSession.activeOrganizationId,
      };
      await expect(
        adapter.uploadPrivateEvidence({
          actor: forgedActor,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          evidence: Buffer.from('FORGED'),
          contentType: 'application/pdf',
        }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

      const { storageKey } = await adapter.uploadPrivateEvidence({
        actor: salvageHunterSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: Buffer.from('HUNTER-RECEIPT'),
        contentType: 'image/jpeg',
      });

      // Deactivate hunter membership while holding previously resolved session
      const hunterMembership = store.memberships.get(
        PHASE1A_SEED_IDS.memberships.hunterSalvage,
      )!;
      hunterMembership.isActive = false;

      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageHunterSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      await expect(
        adapter.uploadPublicPartMedia({
          actor: salvageHunterSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          image: await createAsymmetricImageBuffer('jpeg'),
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Reactivate membership, then test role change & inactive user & inactive org
      hunterMembership.isActive = true;
      hunterMembership.role = UserRole.ONTARIO_STRIPPER;
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageHunterSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      hunterMembership.role = UserRole.HUNTER_MECHANIC;
      store.users.get(PHASE1A_SEED_IDS.users.hunterMechanic)!.isActive = false;
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageHunterSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      store.users.get(PHASE1A_SEED_IDS.users.hunterMechanic)!.isActive = true;
      store.orgs.get(PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT)!.isActive = false;
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageHunterSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Restore org and test concurrent revocation BETWEEN HEAD/upload and audit commit
      store.orgs.get(PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT)!.isActive = true;
      const auditCountBeforeRace = store.auditLogs.length;

      store.onBeforeAuditInsert = () => {
        hunterMembership.isActive = false;
      };

      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageHunterSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      expect(store.auditLogs.length).toBe(auditCountBeforeRace);
    });

    it('writes exact AuditLog metadata without bearer URLs/content and handles audit/provider/expiry failures safely', async () => {
      let currentTime = new Date('2026-11-15T14:00:00.000Z');
      const adapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
        clock: { now: () => currentTime },
      });

      const evidenceBytes = Buffer.from('CONFIDENTIAL-EVIDENCE-PAYLOAD');
      const { storageKey, sha256Hash } = await adapter.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: evidenceBytes,
        contentType: 'application/pdf',
        auditContext: { ipAddress: '203.0.113.7', correlationId: 'corr-abc' },
      });

      const presignedUrl = await adapter.createPrivateEvidencePresignedUrl({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
        ttlSeconds: 300,
        auditContext: { ipAddress: '203.0.113.7', correlationId: 'corr-def' },
      });

      expect(store.auditLogs).toHaveLength(2);
      const [uploadEvent, urlEvent] = store.auditLogs;

      expect(uploadEvent).toMatchObject({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        actorUserId: PHASE1A_SEED_IDS.users.architectCfo,
        entityType: 'PRIVATE_EVIDENCE',
        entityId: storageKey,
        action: 'PRIVATE_EVIDENCE_UPLOADED',
        ipAddress: '203.0.113.7',
        nextState: {
          storageKey,
          bucketClassification: 'PRIVATE_EVIDENCE',
          sha256Hash,
          contentType: 'application/pdf',
          byteLength: evidenceBytes.byteLength,
          correlationId: 'corr-abc',
        },
      });

      expect(urlEvent).toMatchObject({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        actorUserId: PHASE1A_SEED_IDS.users.architectCfo,
        entityType: 'PRIVATE_EVIDENCE',
        entityId: storageKey,
        action: 'PRIVATE_EVIDENCE_PRESIGNED_URL_ISSUED',
        ipAddress: '203.0.113.7',
        nextState: {
          storageKey,
          bucketClassification: 'PRIVATE_EVIDENCE',
          ttlSeconds: 300,
          issuedAt: '2026-11-15T14:00:00.000Z',
          expiresAt: '2026-11-15T14:05:00.000Z',
          correlationId: 'corr-def',
        },
      });
      // Ensure audit state never logs raw content or complete bearer URL
      expect(JSON.stringify(store.auditLogs)).not.toContain(presignedUrl);
      expect(JSON.stringify(store.auditLogs)).not.toContain(
        'CONFIDENTIAL-EVIDENCE-PAYLOAD',
      );

      // Audit rollback on upload leaves only an inaccessible private orphan and no audit event
      store.failNextAuditWithInfraError = true;
      await expect(
        adapter.uploadPrivateEvidence({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          evidence: Buffer.from('ORPHAN-EVIDENCE'),
          contentType: 'application/pdf',
        }),
      ).rejects.toMatchObject({
        status: 500,
        code: 'STORAGE_AUDIT_FAILED',
      });
      expect(store.auditLogs).toHaveLength(2);
      expect(adapter.privateBucket.size).toBe(2); // private orphan retained, key never returned

      // Audit failure on presigning returns no URL and emits no audit row
      store.failNextAuditWithInfraError = true;
      await expect(
        adapter.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
          ttlSeconds: 60,
        }),
      ).rejects.toMatchObject({
        status: 500,
        code: 'STORAGE_AUDIT_FAILED',
      });
      expect(store.auditLogs).toHaveLength(2);

      // Clock advancing past expiresAt during audit finalization rejects URL issuance
      let clockCalls = 0;
      const expiringAdapter = new InMemoryStorageAdapter({
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(90),
        clock: {
          now: () => {
            clockCalls += 1;
            // First call (issuedAt) = 14:00:00, subsequent calls jump past +1s TTL
            if (clockCalls <= 1) {
              return new Date('2026-11-15T14:00:00.000Z');
            }
            return new Date('2026-11-15T14:00:02.000Z');
          },
        },
      });
      const seededKey = `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/evidence/90000000-0000-4000-8000-00000000005a`;
      await expiringAdapter.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: Buffer.from('EXPIRY-TEST'),
        contentType: 'application/pdf',
      });
      clockCalls = 0;
      await expect(
        expiringAdapter.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey: seededKey,
          ttlSeconds: 1,
        }),
      ).rejects.toMatchObject({
        status: 500,
        code: 'STORAGE_PRESIGNED_URL_EXPIRED',
      });
    });
  });

  describe('Composition factory (createStorageService) & R2StorageAdapter command verification', () => {
    it('automatically selects InMemoryStorageAdapter in NODE_ENV=test without R2 or DB config, and validates R2 config in production', () => {
      const testAdapter = createStorageService({
        env: { NODE_ENV: 'test' },
        securityRepository: store,
      });
      expect(testAdapter).toBeInstanceOf(InMemoryStorageAdapter);

      // Missing R2 env vars in production fail closed with 500 STORAGE_CONFIGURATION_ERROR
      expect(() =>
        createStorageService({
          env: { NODE_ENV: 'production' },
          securityRepository: store,
        }),
      ).toThrowError(StorageError);

      // Identical public & private bucket names fail closed and never echo credentials
      let caughtSameBucket: unknown;
      try {
        new R2StorageAdapter({
          config: makeFakeR2Config({
            publicMediaBucket: 'shared-bucket',
            privateEvidenceBucket: 'shared-bucket',
          }),
          securityRepository: store,
        });
      } catch (err) {
        caughtSameBucket = err;
      }
      expect(caughtSameBucket).toMatchObject({
        status: 500,
        code: 'STORAGE_CONFIGURATION_ERROR',
      });
      expect((caughtSameBucket as Error).message).not.toContain(
        'AKIA_TEST_KEY_ID_SECRET',
      );
      expect((caughtSameBucket as Error).message).not.toContain(
        'R2_SUPER_SECRET_ACCESS_KEY_999',
      );

      // Invalid public base URLs (http, path, query, fragment, credentials) fail closed
      for (const badBaseUrl of [
        'http://cdn.salvage-test.invalid',
        'https://cdn.salvage-test.invalid/media',
        'https://cdn.salvage-test.invalid?foo=bar',
        'https://cdn.salvage-test.invalid#frag',
        'https://user:pass@cdn.salvage-test.invalid',
      ]) {
        expect(
          () =>
            new R2StorageAdapter({
              config: makeFakeR2Config({ publicMediaBaseUrl: badBaseUrl }),
              securityRepository: store,
            }),
        ).toThrowError(StorageError);
      }

      // Production composition with valid config yields R2StorageAdapter without network calls
      const prodAdapter = createStorageService({
        env: {
          NODE_ENV: 'production',
          R2_ACCOUNT_ID: 'cfaccount1234567890abcdef',
          R2_ACCESS_KEY_ID: 'AKIA_TEST_KEY_ID_SECRET',
          R2_SECRET_ACCESS_KEY: 'R2_SUPER_SECRET_ACCESS_KEY_999',
          R2_PUBLIC_MEDIA_BUCKET: 'inventory-public-media',
          R2_PRIVATE_EVIDENCE_BUCKET: 'inventory-private-evidence',
          R2_PUBLIC_MEDIA_BASE_URL: 'https://cdn.salvage-test.invalid',
        },
        securityRepository: store,
      });
      expect(prodAdapter).toBeInstanceOf(R2StorageAdapter);
    });

    it('constructs exact R2 S3 commands outside transactions, avoids ACLs, and maps provider/404 errors safely', async () => {
      const sentCommands: Array<{
        command: PutObjectCommand | HeadObjectCommand;
        txDepthAtCall: number;
      }> = [];
      const presignCalls: Array<{
        command: GetObjectCommand;
        expiresIn: number;
        signingDate: Date;
        txDepthAtCall: number;
      }> = [];

      let headReturnsNotFound = false;
      let throwProviderFailure = false;
      let throwSignerFailure = false;

      const r2 = new R2StorageAdapter({
        config: makeFakeR2Config(),
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(1),
        clock: { now: () => new Date('2026-11-15T15:00:00.000Z') },
        transport: {
          async send(command) {
            sentCommands.push({
              command,
              txDepthAtCall: store.activeTransactionDepth,
            });
            if (throwProviderFailure) {
              throw new Error(
                'S3 failure with secret R2_SUPER_SECRET_ACCESS_KEY_999',
              );
            }
            if (command instanceof HeadObjectCommand && headReturnsNotFound) {
              const notFound = new Error('NotFound');
              notFound.name = 'NotFound';
              throw notFound;
            }
            return {};
          },
        },
        presigner: async (_client, command, opts) => {
          presignCalls.push({
            command,
            expiresIn: opts.expiresIn,
            signingDate: opts.signingDate,
            txDepthAtCall: store.activeTransactionDepth,
          });
          if (throwSignerFailure) {
            throw new Error('Signer failure with secret AKIA_TEST_KEY_ID_SECRET');
          }
          return `https://cfaccount1234567890abcdef.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-Expires=${opts.expiresIn}`;
        },
      });

      const jpegInput = await createAsymmetricImageBuffer('jpeg', {
        withExifGps: true,
      });
      const publicUrl = await r2.uploadPublicPartMedia({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        image: jpegInput,
      });
      expect(publicUrl).toBe(
        `https://cdn.salvage-test.invalid/${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/media/90000000-0000-4000-8000-000000000001.webp`,
      );

      const publicCmd = sentCommands[0]!.command as PutObjectCommand;
      expect(publicCmd).toBeInstanceOf(PutObjectCommand);
      expect(sentCommands[0]!.txDepthAtCall).toBe(0);
      expect(publicCmd.input.Bucket).toBe('inventory-public-media');
      expect(publicCmd.input.Key).toBe(
        `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/media/90000000-0000-4000-8000-000000000001.webp`,
      );
      expect(publicCmd.input.ContentType).toBe('image/webp');
      expect(publicCmd.input.ACL).toBeUndefined();
      const publicMeta = await sharp(publicCmd.input.Body as Uint8Array).metadata();
      expect(publicMeta.format).toBe('webp');
      expect(publicMeta.exif).toBeUndefined();

      const rawEvidence = Buffer.from('EXACT-TAX-INVOICE-PDF');
      const { storageKey } = await r2.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: rawEvidence,
        contentType: 'application/pdf',
      });

      const privatePut = sentCommands[1]!.command as PutObjectCommand;
      expect(privatePut).toBeInstanceOf(PutObjectCommand);
      expect(sentCommands[1]!.txDepthAtCall).toBe(0);
      expect(privatePut.input.Bucket).toBe('inventory-private-evidence');
      expect(privatePut.input.Key).toBe(storageKey);
      expect(privatePut.input.ContentType).toBe('application/pdf');
      expect(privatePut.input.ACL).toBeUndefined();
      expect(
        Buffer.compare(Buffer.from(privatePut.input.Body as Uint8Array), rawEvidence),
      ).toBe(0);

      const signedUrl = await r2.createPrivateEvidencePresignedUrl({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
        ttlSeconds: 450,
      });
      expect(signedUrl).toContain('X-Amz-Expires=450');

      const headCmd = sentCommands[2]!.command as HeadObjectCommand;
      expect(headCmd).toBeInstanceOf(HeadObjectCommand);
      expect(sentCommands[2]!.txDepthAtCall).toBe(0);
      expect(headCmd.input.Bucket).toBe('inventory-private-evidence');
      expect(headCmd.input.Key).toBe(storageKey);

      expect(presignCalls[0]!.txDepthAtCall).toBe(0);
      expect(presignCalls[0]!.command).toBeInstanceOf(GetObjectCommand);
      expect(presignCalls[0]!.command.input.Bucket).toBe(
        'inventory-private-evidence',
      );
      expect(presignCalls[0]!.command.input.Key).toBe(storageKey);
      expect(presignCalls[0]!.expiresIn).toBe(450);
      expect(presignCalls[0]!.signingDate.toISOString()).toBe(
        '2026-11-15T15:00:00.000Z',
      );

      // 404 NotFound maps to 404 STORAGE_OBJECT_NOT_FOUND
      headReturnsNotFound = true;
      await expect(
        r2.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: 'STORAGE_OBJECT_NOT_FOUND',
      });
      headReturnsNotFound = false;

      // Provider error maps to 502 STORAGE_PROVIDER_ERROR without leaking secrets
      throwProviderFailure = true;
      let providerErr: unknown;
      try {
        await r2.uploadPrivateEvidence({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          evidence: rawEvidence,
          contentType: 'application/pdf',
        });
      } catch (err) {
        providerErr = err;
      }
      expect(providerErr).toMatchObject({
        status: 502,
        code: 'STORAGE_PROVIDER_ERROR',
      });
      expect((providerErr as Error).message).not.toContain(
        'R2_SUPER_SECRET_ACCESS_KEY_999',
      );
      throwProviderFailure = false;

      // Signer error maps to 502 STORAGE_PROVIDER_ERROR without leaking secrets
      throwSignerFailure = true;
      let signerErr: unknown;
      try {
        await r2.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        });
      } catch (err) {
        signerErr = err;
      }
      expect(signerErr).toMatchObject({
        status: 502,
        code: 'STORAGE_PROVIDER_ERROR',
      });
      expect((signerErr as Error).message).not.toContain(
        'AKIA_TEST_KEY_ID_SECRET',
      );
    });

    const parseAmzDateUtc = (amzDate: string): Date => {
      const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
        amzDate,
      );
      if (!match) {
        throw new Error(`Unexpected X-Amz-Date format: ${amzDate}`);
      }
      return new Date(
        Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        ),
      );
    };

    it('signs private URLs with the default AWS getSignedUrl presigner using canonical whole-second signingDate matching AuditLog', async () => {
      const r2 = new R2StorageAdapter({
        config: makeFakeR2Config(),
        securityRepository: store,
        idGenerator: createDeterministicIdGenerator(200),
        // Non-zero milliseconds test canonical whole-second SigV4 normalization
        clock: { now: () => new Date('2026-11-15T15:00:00.789Z') },
        transport: {
          async send() {
            return {};
          },
        },
      });

      const { storageKey } = await r2.uploadPrivateEvidence({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: Buffer.from('REAL-SDK-SIGNING-DATE-TEST'),
        contentType: 'application/pdf',
      });

      const signedUrl = await r2.createPrivateEvidencePresignedUrl({
        actor: salvageCfoSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
        ttlSeconds: 450,
      });

      const parsedUrl = new URL(signedUrl);
      expect(parsedUrl.origin).toBe(
        'https://inventory-private-evidence.cfaccount1234567890abcdef.r2.cloudflarestorage.com',
      );
      expect(parsedUrl.pathname).toBe(`/${storageKey}`);

      const amzDateParam = parsedUrl.searchParams.get('X-Amz-Date');
      const amzExpiresParam = parsedUrl.searchParams.get('X-Amz-Expires');
      expect(amzDateParam).toBe('20261115T150000Z');
      expect(amzExpiresParam).toBe('450');

      const amzIssuedAt = parseAmzDateUtc(amzDateParam!);
      const amzExpiresAt = new Date(
        amzIssuedAt.getTime() + Number(amzExpiresParam) * 1000,
      );

      const urlAuditEvent = store.auditLogs.find(
        (row) => row.action === 'PRIVATE_EVIDENCE_PRESIGNED_URL_ISSUED',
      );
      expect(urlAuditEvent).toBeDefined();
      expect(urlAuditEvent!.nextState.issuedAt).toBe(
        amzIssuedAt.toISOString(),
      );
      expect(urlAuditEvent!.nextState.expiresAt).toBe(
        amzExpiresAt.toISOString(),
      );
      expect(urlAuditEvent!.nextState.issuedAt).toBe(
        '2026-11-15T15:00:00.000Z',
      );
      expect(urlAuditEvent!.nextState.expiresAt).toBe(
        '2026-11-15T15:07:30.000Z',
      );
    });

    it('keeps X-Amz-Date + X-Amz-Expires aligned with AuditLog and finalization expiry under delayed async real-SDK signing', async () => {
      const cfg = makeFakeR2Config();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-15T16:00:00.250Z'));

        const delayedClient = new S3Client({
          region: 'auto',
          endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
          credentials: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
            };
          },
        });

        const r2 = new R2StorageAdapter({
          config: cfg,
          s3Client: delayedClient,
          securityRepository: store,
          idGenerator: createDeterministicIdGenerator(300),
          clock: { now: () => new Date() },
          transport: {
            async send() {
              return {};
            },
          },
        });

        const { storageKey } = await r2.uploadPrivateEvidence({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          evidence: Buffer.from('DELAYED-REAL-SDK-SIGNING'),
          contentType: 'application/pdf',
        });

        // Case 1: 60s TTL survives a 1500ms async signing delay; X-Amz-Date + X-Amz-Expires
        // must still equal AuditLog issuedAt/expiresAt (not shifted by the 1500ms delay).
        const validPromise = r2.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
          ttlSeconds: 60,
        });
        await vi.advanceTimersByTimeAsync(1500);
        const signedUrl = await validPromise;

        const parsedUrl = new URL(signedUrl);
        const amzDateParam = parsedUrl.searchParams.get('X-Amz-Date');
        const amzExpiresParam = parsedUrl.searchParams.get('X-Amz-Expires');
        expect(amzDateParam).toBe('20261115T160000Z');
        expect(amzExpiresParam).toBe('60');

        const amzIssuedAt = parseAmzDateUtc(amzDateParam!);
        const amzExpiresAt = new Date(
          amzIssuedAt.getTime() + Number(amzExpiresParam) * 1000,
        );

        const urlAuditEvent = store.auditLogs.find(
          (row) => row.action === 'PRIVATE_EVIDENCE_PRESIGNED_URL_ISSUED',
        );
        expect(urlAuditEvent).toBeDefined();
        expect(urlAuditEvent!.nextState.issuedAt).toBe(
          amzIssuedAt.toISOString(),
        );
        expect(urlAuditEvent!.nextState.expiresAt).toBe(
          amzExpiresAt.toISOString(),
        );
        expect(urlAuditEvent!.nextState.expiresAt).toBe(
          '2026-11-15T16:01:00.000Z',
        );

        // Case 2: 1s TTL expires during the 1500ms async signing delay; finalization
        // guard rejects with STORAGE_PRESIGNED_URL_EXPIRED matching the canonical expiry.
        const delayedClient2 = new S3Client({
          region: 'auto',
          endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
          credentials: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
            };
          },
        });
        const r2Delayed2 = new R2StorageAdapter({
          config: cfg,
          s3Client: delayedClient2,
          securityRepository: store,
          idGenerator: createDeterministicIdGenerator(350),
          clock: { now: () => new Date() },
          transport: {
            async send() {
              return {};
            },
          },
        });

        vi.setSystemTime(new Date('2026-11-15T16:05:00.250Z'));
        const expiredPromise = r2Delayed2.createPrivateEvidencePresignedUrl({
          actor: salvageCfoSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
          ttlSeconds: 1,
        });
        const expiredAssertion = expect(expiredPromise).rejects.toMatchObject({
          status: 500,
          code: 'STORAGE_PRESIGNED_URL_EXPIRED',
        });
        await vi.advanceTimersByTimeAsync(1500);
        await expiredAssertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ============================================================================
// Live PostgreSQL 16 erp_app_user Transaction, RLS & Audit Integration Suite
// ============================================================================

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL storage integration tests.`,
    );
  }
  return value;
}

describe.runIf(HAS_TEST_DATABASE_URL)(
  'Issue #5: Live PostgreSQL 16 erp_app_user Storage Security, AuditLog & RLS',
  () => {
    let runtimePrisma!: PrismaClient;
    let ownerPrisma!: PrismaClient;

    const createdUserIds: string[] = [];
    const createdMembershipIds: string[] = [];

    beforeAll(async () => {
      const testUrl = requireEnvUrl('TEST_DATABASE_URL');
      const directUrl = requireEnvUrl('DIRECT_URL');

      runtimePrisma = new PrismaClient({
        datasources: { db: { url: testUrl } },
      });
      ownerPrisma = new PrismaClient({
        datasources: { db: { url: directUrl } },
      });

      await Promise.all([runtimePrisma.$connect(), ownerPrisma.$connect()]);
    });

    afterAll(async () => {
      if (ownerPrisma) {
        if (createdMembershipIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."OrganizationMembership"
            WHERE "id" = ANY(${createdMembershipIds}::uuid[])
          `;
        }
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User" u
            WHERE u."id" = ANY(${createdUserIds}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM "shared"."AuditLog" a
                WHERE a."actorUserId" = u."id"
              )
          `;
        }
      }

      await Promise.allSettled([
        runtimePrisma?.$disconnect(),
        ownerPrisma?.$disconnect(),
      ]);
    });

    async function createIsolatedUserAndMembership(input: {
      organizationId: string;
      role: UserRole;
      mfaEnrolled?: boolean;
    }): Promise<{ userId: string; membershipId: string }> {
      const userId = randomUUID();
      const membershipId = randomUUID();
      createdUserIds.push(userId);
      createdMembershipIds.push(membershipId);

      await ownerPrisma.user.create({
        data: {
          id: userId,
          email: `storage-it-${userId}@test.local`,
          fullName: `Storage IT ${userId.slice(0, 8)}`,
          role: input.role,
          mfaEnrolled: input.mfaEnrolled ?? true,
          isActive: true,
        },
      });

      await ownerPrisma.organizationMembership.create({
        data: {
          id: membershipId,
          organizationId: input.organizationId,
          userId,
          role: input.role,
          isDefaultWorkspace: true,
          isActive: true,
        },
      });

      return { userId, membershipId };
    }

    it('persists immutable AuditLog rows under erp_app_user RLS, isolates tenants, and immediately denies deactivated memberships', async () => {
      const roleRows = await runtimePrisma.$queryRaw<
        Array<{
          currentUser: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>
      >`
        SELECT
          current_user AS "currentUser",
          r.rolsuper AS "rolsuper",
          r.rolbypassrls AS "rolbypassrls"
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      expect(roleRows[0]).toEqual({
        currentUser: 'erp_app_user',
        rolsuper: false,
        rolbypassrls: false,
      });

      const salvagePrincipal = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        role: UserRole.HUNTER_MECHANIC,
        mfaEnrolled: false,
      });
      const cannabisPrincipal = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        role: UserRole.CANNABIS_QAP_COMPLIANCE,
        mfaEnrolled: true,
      });

      const { createPrismaAuthRepository } = await import(
        '@/modules/shared-ops/auth'
      );
      const authRepo = createPrismaAuthRepository({ prisma: runtimePrisma });
      const salvageSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': salvagePrincipal.userId,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        },
        { repository: authRepo },
      );
      const cannabisSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': cannabisPrincipal.userId,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          'x-test-aal': 'aal2',
        },
        { repository: authRepo },
      );

      const storageSecurityRepo = createPrismaStorageSecurityRepository({
        prisma: runtimePrisma,
      });
      const storage = new InMemoryStorageAdapter({
        securityRepository: storageSecurityRepo,
      });

      // 1. Upload private evidence and issue presigned URL under real erp_app_user transactions
      const evidencePayload = Buffer.from('%PDF-1.7\nLIVE-POSTGRES-EVIDENCE');
      const { storageKey, sha256Hash } = await storage.uploadPrivateEvidence({
        actor: salvageSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        evidence: evidencePayload,
        contentType: 'application/pdf',
        auditContext: { ipAddress: '198.51.100.88' },
      });

      const presignedUrl = await storage.createPrivateEvidencePresignedUrl({
        actor: salvageSession,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        storageKey,
        ttlSeconds: 300,
      });
      expect(presignedUrl).toContain('X-TTL-Seconds=300');

      // 2. Salvage tenant can read its AuditLog rows; Cannabis tenant sees 0 rows under RLS
      const salvageAuditRows = await withTenantTransaction(
        runtimePrisma,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          userId: salvagePrincipal.userId,
          role: UserRole.HUNTER_MECHANIC,
        },
        async (tx) =>
          tx.auditLog.findMany({
            where: { entityType: 'PRIVATE_EVIDENCE', entityId: storageKey },
            orderBy: { createdAt: 'asc' },
          }),
      );
      expect(salvageAuditRows).toHaveLength(2);
      expect(salvageAuditRows.map((r) => r.action)).toEqual([
        'PRIVATE_EVIDENCE_UPLOADED',
        'PRIVATE_EVIDENCE_PRESIGNED_URL_ISSUED',
      ]);
      expect(salvageAuditRows[0]!.nextState).toMatchObject({
        storageKey,
        sha256Hash,
        bucketClassification: 'PRIVATE_EVIDENCE',
      });

      const cannabisAuditRows = await withTenantTransaction(
        runtimePrisma,
        {
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          userId: cannabisPrincipal.userId,
          role: UserRole.CANNABIS_QAP_COMPLIANCE,
        },
        async (tx) =>
          tx.auditLog.findMany({
            where: { entityType: 'PRIVATE_EVIDENCE', entityId: storageKey },
          }),
      );
      expect(cannabisAuditRows).toHaveLength(0);

      // Opposite tenant cannot obtain presigned URL for Salvage key
      await expect(
        storage.createPrivateEvidencePresignedUrl({
          actor: cannabisSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'STORAGE_KEY_FORBIDDEN',
      });

      // Unbound runtime query without tenant context sees 0 AuditLog rows under FORCE RLS
      const unboundRows = await runtimePrisma.auditLog.findMany({
        where: { entityType: 'PRIVATE_EVIDENCE', entityId: storageKey },
      });
      expect(unboundRows).toHaveLength(0);

      // 3. erp_app_user cannot UPDATE or DELETE AuditLog rows
      await expect(
        withTenantTransaction(
          runtimePrisma,
          {
            organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
            userId: salvagePrincipal.userId,
            role: UserRole.HUNTER_MECHANIC,
          },
          async (tx) => {
            await tx.$executeRaw`
              UPDATE "shared"."AuditLog"
              SET "action" = 'TAMPERED'
              WHERE "id" = ${salvageAuditRows[0]!.id}::uuid
            `;
          },
        ),
      ).rejects.toThrow();

      // 4. Deactivate membership via owner connection -> same session immediately fails 403
      await ownerPrisma.organizationMembership.update({
        where: { id: salvagePrincipal.membershipId },
        data: {
          isActive: false,
          deactivatedAt: new Date(),
          revocationReason: 'Storage live DB revocation check',
        },
      });

      await expect(
        storage.createPrivateEvidencePresignedUrl({
          actor: salvageSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Confirm no extra audit row was written after deactivation
      const postRevokeRows = await ownerPrisma.auditLog.findMany({
        where: { entityType: 'PRIVATE_EVIDENCE', entityId: storageKey },
      });
      expect(postRevokeRows).toHaveLength(2);

      // 5. Reactivate, then simulate revocation BETWEEN HEAD and final audit transaction
      await ownerPrisma.organizationMembership.update({
        where: { id: salvagePrincipal.membershipId },
        data: {
          isActive: true,
          deactivatedAt: null,
          revocationReason: null,
        },
      });

      const baseBackend = {
        async putPublicMedia() {
          return;
        },
        formatPublicMediaUrl(key: string) {
          return formatValidatedPublicMediaUrl(
            DEFAULT_IN_MEMORY_PUBLIC_BASE_URL,
            key,
          );
        },
        async putPrivateEvidence() {
          return;
        },
        async privateEvidenceExists() {
          // Simulate concurrent deactivation happening during HEAD before final audit tx
          await ownerPrisma.organizationMembership.update({
            where: { id: salvagePrincipal.membershipId },
            data: {
              isActive: false,
              deactivatedAt: new Date(),
              revocationReason: 'Revoked mid-flight during HEAD',
            },
          });
          return true;
        },
        async createPrivatePresignedGetUrl() {
          return `${DEFAULT_IN_MEMORY_PRIVATE_BASE_URL}/${storageKey}?X-InMemory-Signature=1`;
        },
      };

      const { StorageService } = await import('@/modules/shared-ops/storage');
      const raceStorage = new StorageService({
        backend: baseBackend,
        securityRepository: storageSecurityRepo,
      });

      await expect(
        raceStorage.createPrivateEvidencePresignedUrl({
          actor: salvageSession,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          storageKey,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      const postRaceRows = await ownerPrisma.auditLog.findMany({
        where: { entityType: 'PRIVATE_EVIDENCE', entityId: storageKey },
      });
      expect(postRaceRows).toHaveLength(2);
    });
  },
);
