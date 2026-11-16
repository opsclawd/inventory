import { createHash, randomUUID } from 'node:crypto';
import type {
  AssetCategory,
  AssetLifecycleState,
  LocationOperationalStatus,
  OrganizationType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import {
  assertCapability,
  assertCfoOverrideAuthority,
  type AuthSessionContext,
  toTenantExecutionContext,
  translateTenantContextError,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import {
  LocationCustodyError,
  LocationZoningService,
  mergeComplianceWarnings,
} from './location-zoning.service';
import { validateCanonicalTagCode } from './qr-tag-sheet-and-zpl.generator';

export const CUSTODY_SCAN_AUDIT_ACTION = 'CUSTODY_SCAN_RECORDED' as const;
export const CUSTODY_SCAN_AUDIT_ENTITY_TYPE = 'CustodyEvent' as const;

export interface CustodyEntityRef {
  readonly kind: 'PART' | 'VEHICLE';
  readonly id: string;
}

export interface RecordCustodyScanInput {
  readonly entity: CustodyEntityRef;
  readonly destinationBarcode: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
  readonly cfoOverride?: boolean;
}

export interface RecordCustodyScanResult {
  readonly custodyEventId: string;
  readonly entity: CustodyEntityRef;
  readonly applied: boolean;
  readonly hasConflict: boolean;
  readonly locationId: string | null;
  readonly locationBarcode: string | null;
  readonly attemptedLocationId: string;
  readonly attemptedLocationBarcode: string;
  readonly version: number;
  readonly complianceWarnings: readonly string[];
  readonly entityComplianceWarnings: readonly string[];
  readonly overrideApplied: boolean;
  readonly fromLocationBarcode: string | null;
  readonly toLocationBarcode: string;
}

export interface LockedPartRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly storageLocationId: string | null;
  readonly currentLocationBarcode: string | null;
  readonly partCategoryName: string;
  readonly donorVehicleId: string;
  readonly donorVehicleFluidsDrainedAt: Date | null;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
}

export interface LockedVehicleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly assetCategory: AssetCategory;
  readonly lifecycleState: AssetLifecycleState;
  readonly storageLocationId: string | null;
  readonly currentLocationBarcode: string | null;
  readonly fluidsDrainedAt: Date | null;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
}

export interface LockedStorageLocationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly allowedOrgType: OrganizationType;
  readonly locationOperationalStatus: LocationOperationalStatus;
  readonly allowsWholeVehicleDismantling: boolean;
  readonly maxActiveAssetCapacity: number | null;
  readonly fullQrBarcode: string;
}

export interface ExistingIdempotentCustodyRecord {
  readonly custodyEventId: string;
  readonly commandFingerprint: string | null;
  readonly scanResult: RecordCustodyScanResult | null;
}

export interface InsertCustodyEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly partId: string | null;
  readonly vehicleId: string | null;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly fromLocationBarcode: string | null;
  readonly toLocationBarcode: string;
  readonly expectedVersion: number;
  readonly hasConflict: boolean;
  readonly complianceWarnings: readonly string[];
  readonly deviceTimestamp: Date;
  readonly serverReceivedAt: Date;
}

export interface InsertCustodyAuditLogRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly entityType: typeof CUSTODY_SCAN_AUDIT_ENTITY_TYPE;
  readonly entityId: string;
  readonly action: typeof CUSTODY_SCAN_AUDIT_ACTION;
  readonly previousState: Readonly<Record<string, unknown>>;
  readonly nextState: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface CustodyScanTx {
  acquireOrganizationLock(organizationId: string): Promise<void>;
  findIdempotentCustodyScan(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<ExistingIdempotentCustodyRecord | null>;
  readOrganizationPolicyRecord(organizationId: string): Promise<{
    organizationId: string;
    policyConfigJson: unknown;
  } | null>;
  findAndLockPartWithDonor(
    organizationId: string,
    partId: string,
  ): Promise<LockedPartRecord | null>;
  findAndLockVehicle(
    organizationId: string,
    vehicleId: string,
  ): Promise<LockedVehicleRecord | null>;
  findAndLockStorageLocationByBarcode(
    organizationId: string,
    fullQrBarcode: string,
  ): Promise<LockedStorageLocationRecord | null>;
  countActiveVehiclesAtLocation(
    organizationId: string,
    storageLocationId: string,
  ): Promise<number>;
  updatePartLocationAndVersion(input: {
    readonly organizationId: string;
    readonly partId: string;
    readonly expectedCurrentVersion: number;
    readonly storageLocationId: string;
    readonly nextVersion: number;
    readonly complianceWarnings: readonly string[];
    readonly updatedAt: Date;
  }): Promise<boolean>;
  updateVehicleLocationAndVersion(input: {
    readonly organizationId: string;
    readonly vehicleId: string;
    readonly expectedCurrentVersion: number;
    readonly storageLocationId: string;
    readonly nextVersion: number;
    readonly complianceWarnings: readonly string[];
    readonly updatedAt: Date;
  }): Promise<boolean>;
  insertCustodyEvent(input: InsertCustodyEventRecord): Promise<void>;
  insertAuditLog(input: InsertCustodyAuditLogRecord): Promise<void>;
}

export interface CustodyScanRepository {
  withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: CustodyScanTx) => Promise<T>,
  ): Promise<T>;
}

export interface CustodyClock {
  now(): Date;
}

export interface RecordCustodyScanDeps {
  readonly repository?: CustodyScanRepository;
  readonly zoningService?: LocationZoningService;
  readonly clock?: CustodyClock;
  readonly idGenerator?: () => string;
}

function organizationAdvisoryLockKeys(organizationId: string): [number, number] {
  const hex = organizationId.replace(/-/g, '').toLowerCase();
  const key1 = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const key2 = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [key1, key2];
}

function computeScanCommandFingerprint(params: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly entityKind: 'PART' | 'VEHICLE';
  readonly entityId: string;
  readonly destinationBarcode: string;
  readonly expectedVersion: number;
  readonly deviceTimestampIso: string;
  readonly cfoOverride: boolean;
}): string {
  const canonical = JSON.stringify({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    entityKind: params.entityKind,
    entityId: params.entityId,
    destinationBarcode: params.destinationBarcode,
    expectedVersion: params.expectedVersion,
    deviceTimestampIso: params.deviceTimestampIso,
    cfoOverride: params.cfoOverride,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseReplayMetadata(
  nextState: unknown,
): {
  readonly commandFingerprint: string | null;
  readonly scanResult: RecordCustodyScanResult | null;
} {
  if (!isPlainRecord(nextState)) {
    return { commandFingerprint: null, scanResult: null };
  }
  const commandFingerprint =
    typeof nextState.commandFingerprint === 'string' &&
    nextState.commandFingerprint.length > 0
      ? nextState.commandFingerprint
      : null;

  const rawResult = nextState.scanResult;
  if (!isPlainRecord(rawResult)) {
    return { commandFingerprint, scanResult: null };
  }

  if (
    typeof rawResult.custodyEventId !== 'string' ||
    !isPlainRecord(rawResult.entity) ||
    (rawResult.entity.kind !== 'PART' && rawResult.entity.kind !== 'VEHICLE') ||
    typeof rawResult.entity.id !== 'string' ||
    typeof rawResult.applied !== 'boolean' ||
    typeof rawResult.hasConflict !== 'boolean' ||
    (rawResult.locationId !== null && typeof rawResult.locationId !== 'string') ||
    (rawResult.locationBarcode !== null &&
      typeof rawResult.locationBarcode !== 'string') ||
    typeof rawResult.attemptedLocationId !== 'string' ||
    typeof rawResult.attemptedLocationBarcode !== 'string' ||
    typeof rawResult.version !== 'number' ||
    !Array.isArray(rawResult.complianceWarnings) ||
    !Array.isArray(rawResult.entityComplianceWarnings) ||
    typeof rawResult.overrideApplied !== 'boolean' ||
    (rawResult.fromLocationBarcode !== null &&
      typeof rawResult.fromLocationBarcode !== 'string') ||
    typeof rawResult.toLocationBarcode !== 'string'
  ) {
    return { commandFingerprint, scanResult: null };
  }

  return {
    commandFingerprint,
    scanResult: rawResult as unknown as RecordCustodyScanResult,
  };
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const errObj = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (errObj.code === 'P2002' || errObj.code === '23505') {
    return true;
  }
  if (errObj.code === 'IDEMPOTENCY_CONFLICT') {
    return true;
  }
  if (typeof errObj.message === 'string') {
    return (
      errObj.message.includes('CustodyEvent_organizationId_idempotencyKey_key') ||
      errObj.message.includes('23505')
    );
  }
  return false;
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
 * Production `CustodyScanRepository` backed strictly by `withTenantTransaction`
 * (`FORCE ROW LEVEL SECURITY` as `erp_app_user`) and parameterized `tx.$queryRaw` locks.
 */
export function createPrismaCustodyRepository(options?: {
  readonly prisma?: PrismaClient;
}): CustodyScanRepository {
  const explicitPrisma = options?.prisma;

  return {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: CustodyScanTx) => Promise<T>,
    ): Promise<T> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const txAdapter: CustodyScanTx = {
            async acquireOrganizationLock(organizationId: string): Promise<void> {
              const [k1, k2] = organizationAdvisoryLockKeys(organizationId);
              await tx.$queryRaw<Array<{ locked: string }>>`
                SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)::text AS "locked"
              `;
            },

            async findIdempotentCustodyScan(
              organizationId: string,
              idempotencyKey: string,
            ): Promise<ExistingIdempotentCustodyRecord | null> {
              const existing = await tx.custodyEvent.findFirst({
                where: {
                  organizationId,
                  idempotencyKey,
                },
                select: {
                  id: true,
                },
              });
              if (!existing) {
                return null;
              }

              const audit = await tx.auditLog.findFirst({
                where: {
                  organizationId,
                  entityType: CUSTODY_SCAN_AUDIT_ENTITY_TYPE,
                  entityId: existing.id,
                  action: CUSTODY_SCAN_AUDIT_ACTION,
                },
                select: {
                  nextState: true,
                },
              });

              const parsed = parseReplayMetadata(audit?.nextState);
              return {
                custodyEventId: existing.id.toLowerCase(),
                commandFingerprint: parsed.commandFingerprint,
                scanResult: parsed.scanResult,
              };
            },

            async readOrganizationPolicyRecord(organizationId: string) {
              const org = await tx.organization.findUnique({
                where: { id: organizationId },
                select: {
                  id: true,
                  policyConfigJson: true,
                },
              });
              if (!org) {
                return null;
              }
              return {
                organizationId: org.id.toLowerCase(),
                policyConfigJson: org.policyConfigJson,
              };
            },

            async findAndLockPartWithDonor(
              organizationId: string,
              partId: string,
            ): Promise<LockedPartRecord | null> {
              const partRows = await tx.$queryRaw<
                Array<{
                  id: string;
                  organizationId: string;
                  storageLocationId: string | null;
                  partCategoryName: string;
                  donorVehicleId: string;
                  complianceWarnings: string[];
                  version: number;
                }>
              >`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "storageLocationId"::text AS "storageLocationId",
                  "partCategoryName",
                  "donorVehicleId"::text AS "donorVehicleId",
                  "complianceWarnings",
                  "version"
                FROM "salvage"."Part"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ${partId}::uuid
                FOR UPDATE
              `;

              const row = partRows[0];
              if (!row) {
                return null;
              }

              const donorRows = await tx.$queryRaw<
                Array<{ fluidsDrainedAt: Date | null }>
              >`
                SELECT "fluidsDrainedAt"
                FROM "salvage"."Vehicle"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ${row.donorVehicleId}::uuid
              `;
              const donor = donorRows[0];
              if (!donor) {
                throw new LocationCustodyError(
                  'CUSTODY_INTEGRITY_ERROR',
                  `Donor vehicle "${row.donorVehicleId}" for part "${row.id}" was not found.`,
                );
              }

              let currentLocationBarcode: string | null = null;
              if (row.storageLocationId !== null) {
                const loc = await tx.storageLocation.findFirst({
                  where: {
                    organizationId,
                    id: row.storageLocationId,
                  },
                  select: { fullQrBarcode: true },
                });
                currentLocationBarcode = loc?.fullQrBarcode ?? null;
              }

              return {
                id: row.id.toLowerCase(),
                organizationId: row.organizationId.toLowerCase(),
                storageLocationId: row.storageLocationId
                  ? row.storageLocationId.toLowerCase()
                  : null,
                currentLocationBarcode,
                partCategoryName: row.partCategoryName,
                donorVehicleId: row.donorVehicleId.toLowerCase(),
                donorVehicleFluidsDrainedAt: donor.fluidsDrainedAt,
                complianceWarnings: row.complianceWarnings ?? [],
                version: row.version,
              };
            },

            async findAndLockVehicle(
              organizationId: string,
              vehicleId: string,
            ): Promise<LockedVehicleRecord | null> {
              const vehicleRows = await tx.$queryRaw<
                Array<{
                  id: string;
                  organizationId: string;
                  assetCategory: AssetCategory;
                  lifecycleState: AssetLifecycleState;
                  storageLocationId: string | null;
                  fluidsDrainedAt: Date | null;
                  complianceWarnings: string[];
                  version: number;
                }>
              >`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "assetCategory"::text AS "assetCategory",
                  "lifecycleState"::text AS "lifecycleState",
                  "storageLocationId"::text AS "storageLocationId",
                  "fluidsDrainedAt",
                  "complianceWarnings",
                  "version"
                FROM "salvage"."Vehicle"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "id" = ${vehicleId}::uuid
                FOR UPDATE
              `;

              const row = vehicleRows[0];
              if (!row) {
                return null;
              }

              let currentLocationBarcode: string | null = null;
              if (row.storageLocationId !== null) {
                const loc = await tx.storageLocation.findFirst({
                  where: {
                    organizationId,
                    id: row.storageLocationId,
                  },
                  select: { fullQrBarcode: true },
                });
                currentLocationBarcode = loc?.fullQrBarcode ?? null;
              }

              return {
                id: row.id.toLowerCase(),
                organizationId: row.organizationId.toLowerCase(),
                assetCategory: row.assetCategory,
                lifecycleState: row.lifecycleState,
                storageLocationId: row.storageLocationId
                  ? row.storageLocationId.toLowerCase()
                  : null,
                currentLocationBarcode,
                fluidsDrainedAt: row.fluidsDrainedAt,
                complianceWarnings: row.complianceWarnings ?? [],
                version: row.version,
              };
            },

            async findAndLockStorageLocationByBarcode(
              organizationId: string,
              fullQrBarcode: string,
            ): Promise<LockedStorageLocationRecord | null> {
              const locRows = await tx.$queryRaw<
                Array<{
                  id: string;
                  organizationId: string;
                  allowedOrgType: OrganizationType;
                  locationOperationalStatus: LocationOperationalStatus;
                  allowsWholeVehicleDismantling: boolean;
                  maxActiveAssetCapacity: number | null;
                  fullQrBarcode: string;
                }>
              >`
                SELECT
                  "id"::text AS "id",
                  "organizationId"::text AS "organizationId",
                  "allowedOrgType"::text AS "allowedOrgType",
                  "locationOperationalStatus"::text AS "locationOperationalStatus",
                  "allowsWholeVehicleDismantling",
                  "maxActiveAssetCapacity",
                  "fullQrBarcode"
                FROM "shared"."StorageLocation"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "fullQrBarcode" = ${fullQrBarcode}
                FOR UPDATE
              `;

              const row = locRows[0];
              if (!row) {
                return null;
              }

              return {
                id: row.id.toLowerCase(),
                organizationId: row.organizationId.toLowerCase(),
                allowedOrgType: row.allowedOrgType,
                locationOperationalStatus: row.locationOperationalStatus,
                allowsWholeVehicleDismantling: row.allowsWholeVehicleDismantling,
                maxActiveAssetCapacity: row.maxActiveAssetCapacity,
                fullQrBarcode: row.fullQrBarcode,
              };
            },

            async countActiveVehiclesAtLocation(
              organizationId: string,
              storageLocationId: string,
            ): Promise<number> {
              const rows = await tx.$queryRaw<Array<{ count: number }>>`
                SELECT COUNT(*)::int AS "count"
                FROM "salvage"."Vehicle"
                WHERE "organizationId" = ${organizationId}::uuid
                  AND "storageLocationId" = ${storageLocationId}::uuid
                  AND "lifecycleState" NOT IN (
                    'PROPOSED_DEAL'::"salvage"."AssetLifecycleState",
                    'SOLD_RETAIL_ONTARIO'::"salvage"."AssetLifecycleState",
                    'SOLD_EXPORT_COD'::"salvage"."AssetLifecycleState",
                    'SCRAPPED_METAL_CLEARED'::"salvage"."AssetLifecycleState"
                  )
              `;
              return rows[0]?.count ?? 0;
            },

            async updatePartLocationAndVersion(input): Promise<boolean> {
              const res = await tx.part.updateMany({
                where: {
                  organizationId: input.organizationId,
                  id: input.partId,
                  version: input.expectedCurrentVersion,
                },
                data: {
                  storageLocationId: input.storageLocationId,
                  version: input.nextVersion,
                  complianceWarnings: [...input.complianceWarnings],
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async updateVehicleLocationAndVersion(input): Promise<boolean> {
              const res = await tx.vehicle.updateMany({
                where: {
                  organizationId: input.organizationId,
                  id: input.vehicleId,
                  version: input.expectedCurrentVersion,
                },
                data: {
                  storageLocationId: input.storageLocationId,
                  version: input.nextVersion,
                  complianceWarnings: [...input.complianceWarnings],
                  updatedAt: input.updatedAt,
                },
              });
              return res.count === 1;
            },

            async insertCustodyEvent(input): Promise<void> {
              await tx.custodyEvent.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  partId: input.partId,
                  vehicleId: input.vehicleId,
                  cannabisLotId: null,
                  actorUserId: input.actorUserId,
                  idempotencyKey: input.idempotencyKey,
                  fromLocationBarcode: input.fromLocationBarcode,
                  toLocationBarcode: input.toLocationBarcode,
                  expectedVersion: input.expectedVersion,
                  hasConflict: input.hasConflict,
                  complianceWarnings: [...input.complianceWarnings],
                  deviceTimestamp: input.deviceTimestamp,
                  serverReceivedAt: input.serverReceivedAt,
                },
              });
            },

            async insertAuditLog(input): Promise<void> {
              await tx.auditLog.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  actorUserId: input.actorUserId,
                  entityType: input.entityType,
                  entityId: input.entityId,
                  action: input.action,
                  previousState: input.previousState as Prisma.InputJsonValue,
                  nextState: input.nextState as Prisma.InputJsonValue,
                  createdAt: input.createdAt,
                },
              });
            },
          };

          return fn(txAdapter);
        });
      } catch (error) {
        translateTenantContextError(error);
      }
    },
  };
}

function validateAndNormalizeScanInput(input: RecordCustodyScanInput): {
  readonly entityKind: 'PART' | 'VEHICLE';
  readonly entityId: string;
  readonly destinationBarcode: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: Date;
  readonly cfoOverride: boolean;
} {
  if (!input || typeof input !== 'object') {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'Custody scan input must be an object.',
    );
  }

  if (!input.entity || typeof input.entity !== 'object') {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'entity { kind, id } is required.',
    );
  }

  if (input.entity.kind !== 'PART' && input.entity.kind !== 'VEHICLE') {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'entity.kind must be "PART" or "VEHICLE".',
    );
  }

  if (!isValidUuid(input.entity.id)) {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'entity.id must be a valid UUID string.',
    );
  }

  let destinationBarcode: string;
  try {
    destinationBarcode = validateCanonicalTagCode(input.destinationBarcode);
  } catch {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'destinationBarcode must be a canonical location QR barcode.',
    );
  }

  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'expectedVersion must be a positive safe integer.',
    );
  }

  if (!isValidUuid(input.idempotencyKey)) {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'idempotencyKey must be a valid UUID string.',
    );
  }

  const deviceTimestamp =
    input.deviceTimestamp instanceof Date
      ? new Date(input.deviceTimestamp.getTime())
      : new Date(input.deviceTimestamp);
  if (
    (typeof input.deviceTimestamp !== 'string' &&
      !(input.deviceTimestamp instanceof Date)) ||
    Number.isNaN(deviceTimestamp.getTime())
  ) {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'deviceTimestamp must be a valid ISO timestamp or Date.',
    );
  }

  if (
    input.cfoOverride !== undefined &&
    typeof input.cfoOverride !== 'boolean'
  ) {
    throw new LocationCustodyError(
      'INVALID_SCAN_INPUT',
      'cfoOverride must be a boolean when provided.',
    );
  }

  return {
    entityKind: input.entity.kind,
    entityId: input.entity.id.toLowerCase(),
    destinationBarcode,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey.toLowerCase(),
    deviceTimestamp,
    cfoOverride: input.cfoOverride === true,
  };
}

function resolveIdempotentReplay(
  existing: ExistingIdempotentCustodyRecord,
  expectedFingerprint: string,
): RecordCustodyScanResult {
  if (!existing.commandFingerprint || !existing.scanResult) {
    throw new LocationCustodyError(
      'CUSTODY_INTEGRITY_ERROR',
      `CustodyEvent "${existing.custodyEventId}" is missing immutable audit replay metadata.`,
    );
  }
  if (existing.commandFingerprint !== expectedFingerprint) {
    throw new LocationCustodyError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key has already been used with a different custody scan command.',
    );
  }
  return existing.scanResult;
}

/**
 * Executes an atomic, idempotent, RLS-isolated custody scan for a `salvage.Part` or
 * `salvage.Vehicle`, enforcing `RULE-ZONE-001`, `StorageLocation.locationOperationalStatus`,
 * `RULE-ENV-001`, `maxActiveAssetCapacity` (with optional `ARCHITECT_CFO` `aal2` 1-Tap
 * `cfoOverride`), optimistic version conflict recording (`hasConflict`), and immutable
 * `CustodyEvent` + `AuditLog` persistence inside `withTenantTransaction`.
 */
export async function recordCustodyScan(
  session: AuthSessionContext,
  input: RecordCustodyScanInput,
  deps: RecordCustodyScanDeps = {},
): Promise<RecordCustodyScanResult> {
  assertTrustedAuthSession(session);
  const normalized = validateAndNormalizeScanInput(input);

  if (normalized.entityKind === 'PART') {
    assertCapability(session, 'FR-INT-02:relocate');
  } else {
    assertCapability(session, 'FR-INT-01:update');
  }

  if (normalized.cfoOverride) {
    assertCfoOverrideAuthority(session);
  }

  const ctx = toTenantExecutionContext(session);
  const repository = deps.repository ?? createPrismaCustodyRepository();
  const zoningService = deps.zoningService ?? new LocationZoningService();
  const clock = deps.clock ?? { now: () => new Date() };
  const idGenerator = deps.idGenerator ?? (() => randomUUID());

  const commandFingerprint = computeScanCommandFingerprint({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    entityKind: normalized.entityKind,
    entityId: normalized.entityId,
    destinationBarcode: normalized.destinationBarcode,
    expectedVersion: normalized.expectedVersion,
    deviceTimestampIso: normalized.deviceTimestamp.toISOString(),
    cfoOverride: normalized.cfoOverride,
  });

  const nextUuid = (label: string): string => {
    const candidate = idGenerator();
    if (!isValidUuid(candidate)) {
      throw new LocationCustodyError(
        'CUSTODY_INTEGRITY_ERROR',
        `Custody idGenerator must return a valid UUID for ${label}.`,
      );
    }
    return candidate.toLowerCase();
  };

  try {
    return await repository.withTenantTransaction(ctx, async (tx) => {
      await tx.acquireOrganizationLock(ctx.organizationId);

      const existing = await tx.findIdempotentCustodyScan(
        ctx.organizationId,
        normalized.idempotencyKey,
      );
      if (existing) {
        return resolveIdempotentReplay(existing, commandFingerprint);
      }

      const policyAdapter = new JsonPolicyConfigAdapter({
        readOrganizationPolicy: (organizationId) =>
          tx.readOrganizationPolicyRecord(organizationId),
      });
      const policy = await policyAdapter.getPolicyForOrg(ctx.organizationId);

      const part =
        normalized.entityKind === 'PART'
          ? await tx.findAndLockPartWithDonor(
              ctx.organizationId,
              normalized.entityId,
            )
          : null;
      const vehicle =
        normalized.entityKind === 'VEHICLE'
          ? await tx.findAndLockVehicle(
              ctx.organizationId,
              normalized.entityId,
            )
          : null;

      if (!part && !vehicle) {
        throw new LocationCustodyError(
          'ENTITY_NOT_FOUND',
          `${normalized.entityKind} "${normalized.entityId}" was not found in the active organization.`,
        );
      }

      const destination = await tx.findAndLockStorageLocationByBarcode(
        ctx.organizationId,
        normalized.destinationBarcode,
      );
      if (!destination) {
        throw new LocationCustodyError(
          'SITE_ZONING_VIOLATION',
          `Destination location "${normalized.destinationBarcode}" is unauthorized or unavailable for the active organization.`,
          { destinationBarcode: normalized.destinationBarcode },
        );
      }

      const currentVersion = part ? part.version : vehicle!.version;
      const hasConflict = currentVersion !== normalized.expectedVersion;

      const currentDestinationActiveAssetCount =
        vehicle && !hasConflict && destination.maxActiveAssetCapacity !== null
          ? await tx.countActiveVehiclesAtLocation(
              ctx.organizationId,
              destination.id,
            )
          : 0;

      const zoningDecision = zoningService.evaluateLocationZoning({
        activeOrganizationId: ctx.organizationId,
        activeOrganizationType: session.activeOrganizationType,
        entity: part
          ? {
              kind: 'PART',
              id: part.id,
              organizationId: part.organizationId,
              partCategoryName: part.partCategoryName,
              storageLocationId: part.storageLocationId,
              donorVehicleFluidsDrainedAt: part.donorVehicleFluidsDrainedAt,
            }
          : {
              kind: 'VEHICLE',
              id: vehicle!.id,
              organizationId: vehicle!.organizationId,
              assetCategory: vehicle!.assetCategory,
              lifecycleState: vehicle!.lifecycleState,
              storageLocationId: vehicle!.storageLocationId,
              fluidsDrainedAt: vehicle!.fluidsDrainedAt,
            },
        location: destination,
        complianceEnforcementMode:
          policy.operationalGates.complianceEnforcementMode,
        locationCapacityGateMode:
          policy.operationalGates.locationCapacityGate.enforcementMode,
        currentDestinationActiveAssetCount,
        evaluateCapacity: !hasConflict,
        cfoOverrideAuthorized: normalized.cfoOverride,
      });

      const serverNow = clock.now();
      if (Number.isNaN(serverNow.getTime())) {
        throw new LocationCustodyError(
          'CUSTODY_INTEGRITY_ERROR',
          'Custody clock must return a valid Date.',
        );
      }

      const custodyEventId = nextUuid('custodyEventId');
      const auditLogId = nextUuid('auditLogId');
      const priorWarnings = part
        ? part.complianceWarnings
        : vehicle!.complianceWarnings;
      const priorLocationId = part
        ? part.storageLocationId
        : vehicle!.storageLocationId;
      const fromLocationBarcode = part
        ? part.currentLocationBarcode
        : vehicle!.currentLocationBarcode;

      let resultLocationId: string | null = priorLocationId;
      let resultLocationBarcode: string | null = fromLocationBarcode;
      let resultVersion = currentVersion;
      let mergedEntityWarnings = [...priorWarnings];

      if (!hasConflict) {
        resultVersion = currentVersion + 1;
        resultLocationId = destination.id;
        resultLocationBarcode = destination.fullQrBarcode;
        mergedEntityWarnings = mergeComplianceWarnings(
          priorWarnings,
          zoningDecision.warnings,
        );

        const updated = part
          ? await tx.updatePartLocationAndVersion({
              organizationId: ctx.organizationId,
              partId: part.id,
              expectedCurrentVersion: currentVersion,
              storageLocationId: destination.id,
              nextVersion: resultVersion,
              complianceWarnings: mergedEntityWarnings,
              updatedAt: serverNow,
            })
          : await tx.updateVehicleLocationAndVersion({
              organizationId: ctx.organizationId,
              vehicleId: vehicle!.id,
              expectedCurrentVersion: currentVersion,
              storageLocationId: destination.id,
              nextVersion: resultVersion,
              complianceWarnings: mergedEntityWarnings,
              updatedAt: serverNow,
            });

        if (!updated) {
          throw new LocationCustodyError(
            'CUSTODY_INTEGRITY_ERROR',
            'Concurrent modification prevented atomic version update.',
          );
        }
      }

      const scanResult: RecordCustodyScanResult = {
        custodyEventId,
        entity: {
          kind: normalized.entityKind,
          id: normalized.entityId,
        },
        applied: !hasConflict,
        hasConflict,
        locationId: resultLocationId,
        locationBarcode: resultLocationBarcode,
        attemptedLocationId: destination.id,
        attemptedLocationBarcode: destination.fullQrBarcode,
        version: resultVersion,
        complianceWarnings: [...zoningDecision.warnings],
        entityComplianceWarnings: mergedEntityWarnings,
        overrideApplied: hasConflict ? false : zoningDecision.overrideApplied,
        fromLocationBarcode,
        toLocationBarcode: destination.fullQrBarcode,
      };

      await tx.insertCustodyEvent({
        id: custodyEventId,
        organizationId: ctx.organizationId,
        partId: part ? part.id : null,
        vehicleId: vehicle ? vehicle.id : null,
        actorUserId: ctx.userId,
        idempotencyKey: normalized.idempotencyKey,
        fromLocationBarcode,
        toLocationBarcode: destination.fullQrBarcode,
        expectedVersion: normalized.expectedVersion,
        hasConflict,
        complianceWarnings: [...zoningDecision.warnings],
        deviceTimestamp: normalized.deviceTimestamp,
        serverReceivedAt: serverNow,
      });

      await tx.insertAuditLog({
        id: auditLogId,
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        entityType: CUSTODY_SCAN_AUDIT_ENTITY_TYPE,
        entityId: custodyEventId,
        action: CUSTODY_SCAN_AUDIT_ACTION,
        previousState: {
          entityKind: normalized.entityKind,
          entityId: normalized.entityId,
          storageLocationId: priorLocationId,
          locationBarcode: fromLocationBarcode,
          version: currentVersion,
          complianceWarnings: [...priorWarnings],
        },
        nextState: {
          commandFingerprint,
          scanResult,
          evaluatedCapacity: zoningDecision.capacityEvaluation,
          cfoOverrideAudit: {
            requested: normalized.cfoOverride,
            overrideApplied: scanResult.overrideApplied,
            approvedById: scanResult.overrideApplied ? ctx.userId : null,
            actorRole: session.role,
            aal: session.aal,
          },
        },
        createdAt: serverNow,
      });

      return scanResult;
    });
  } catch (error) {
    if (!isIdempotencyUniqueViolation(error)) {
      throw error;
    }

    // Transaction rolled back on unique violation; verify in a fresh authorized lookup
    // rather than querying inside an aborted PostgreSQL transaction.
    return repository.withTenantTransaction(ctx, async (tx) => {
      const existing = await tx.findIdempotentCustodyScan(
        ctx.organizationId,
        normalized.idempotencyKey,
      );
      if (!existing) {
        throw new LocationCustodyError(
          'CUSTODY_INTEGRITY_ERROR',
          'Idempotency conflict could not be resolved after rollback.',
        );
      }
      return resolveIdempotentReplay(existing, commandFingerprint);
    });
  }
}

export function createRecordCustodyScanHandler(
  deps: RecordCustodyScanDeps = {},
): (
  session: AuthSessionContext,
  input: RecordCustodyScanInput,
) => Promise<RecordCustodyScanResult> {
  const repository = deps.repository ?? createPrismaCustodyRepository();
  const zoningService = deps.zoningService ?? new LocationZoningService();
  return (session, input) =>
    recordCustodyScan(session, input, {
      ...deps,
      repository,
      zoningService,
    });
}
