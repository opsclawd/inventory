import { createHash, randomUUID } from 'node:crypto';
import {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  EbaySyncState,
  ExpenseCategory,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  type PrismaClient,
  ScrapStreamCategory,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeSeparatedFinancialSnapshot,
  DomainRuleError,
  recommendDomesticChannels,
  validatePartTransition,
} from '@/core/domain';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { AuthError } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import { LocationCustodyError } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import {
  InMemoryStorageAdapter,
  type StorageAuditEventInput,
  type StorageSecurityRepository,
} from '@/modules/shared-ops/storage';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import {
  CompleteHulkScrapUseCase,
  createProductionStripPartUseCase,
  deriveIssue8CommandReceiptId,
  handleSalvagePartsGet,
  handleSalvagePartsPatch,
  handleSalvagePartsPost,
  type LockedDonorExpenseRow,
  type LockedDonorPartRow,
  type LockedDonorVehicleRow,
  type LockedScrapLogRow,
  type LockedStorageLocationRow,
  LogScrapComponentUseCase,
  MAX_PART_PHOTO_BYTES,
  parseCommandReceiptNextState,
  PartStripError,
  type PartStripRepository,
  type PartStripTx,
  type PersistAuditLogRecord,
  type PersistNewPartRecord,
  type PersistPartCustodyEventRecord,
  type PersistScrapLogRecord,
  StripPartUseCase,
} from '../index';

const ORG_SALVAGE = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
const ORG_SALVAGE_2 = '10000000-0000-4000-8000-000000000099';
const ORG_CANNABIS = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;

const CFO_ID = PHASE1A_SEED_IDS.users.architectCfo;
const HUNTER_ID = PHASE1A_SEED_IDS.users.hunterMechanic;
const STRIPPER_ID = PHASE1A_SEED_IDS.users.ontarioStripper;
const BUYER_ID = PHASE1A_SEED_IDS.users.overseasBuyer;
const VAULT_ADMIN_ID = PHASE1A_SEED_IDS.users.trinidadVaultAdmin;

const LOC_KEMP_C01 = PHASE1A_SEED_IDS.locations.KEMP_C01;
const LOC_KEMP_C04 = PHASE1A_SEED_IDS.locations.KEMP_C04;
const LOC_RAMS = PHASE1A_SEED_IDS.locations.RAMS_SHOP;
const LOC_POSV = PHASE1A_SEED_IDS.locations.POSV_VAULT;
const LOC_BROCK = PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2;
const LOC_SALVAGE2_BIN = '40000000-0000-4000-8000-000000000099';

function makeSession(options?: {
  userId?: string;
  organizationId?: string;
  organizationType?: OrganizationType;
  role?: UserRole;
  aal?: 'aal1' | 'aal2';
  mfaEnrolled?: boolean;
}) {
  const organizationId = options?.organizationId ?? ORG_SALVAGE;
  const organizationType =
    options?.organizationType ??
    (organizationId === ORG_CANNABIS
      ? OrganizationType.CANNABIS_NURSERY_AND_PROCESSING
      : OrganizationType.SALVAGE_AND_EXPORT);
  const role = options?.role ?? UserRole.ONTARIO_STRIPPER;
  const userId =
    options?.userId ??
    (role === UserRole.ARCHITECT_CFO
      ? CFO_ID
      : role === UserRole.HUNTER_MECHANIC
        ? HUNTER_ID
        : role === UserRole.OVERSEAS_B2B_BUYER
          ? BUYER_ID
          : role === UserRole.TRINIDAD_VAULT_ADMIN
            ? VAULT_ADMIN_ID
            : STRIPPER_ID);

  return createAuthSessionContext({
    userId,
    activeOrganizationId: organizationId,
    role,
    activeOrganizationType: organizationType,
    activeMemberships: [
      {
        membershipId: randomUUID(),
        organizationId,
        organizationSlug:
          organizationId === ORG_CANNABIS
            ? 'ORG_CANNABIS_NURSERY_PROC'
            : 'ORG_SALVAGE_EXPORT',
        organizationName: 'Test Workspace',
        organizationType,
        role,
        isDefaultWorkspace: true,
      },
    ],
    aal: options?.aal ?? 'aal2',
    mfaEnrolled: options?.mfaEnrolled ?? true,
  });
}

async function createSampleJpegWithGpsExif(): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: 22, g: 101, b: 52 },
    },
  })
    .withExif({
      IFD0: {
        Make: 'TestCam',
        Model: 'YardCam-1',
        ImageDescription: 'GPS 45.01N 75.63W',
      },
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return Uint8Array.from(buf);
}

interface StoredVehicleState extends LockedDonorVehicleRow {
  year: number;
  make: string;
  model: string;
}

type MutableStoredPart = {
  -readonly [K in keyof LockedDonorPartRow]: LockedDonorPartRow[K];
} & {
  strippedAt: Date;
  weightKg: number;
  suggestedHsCode: string;
  steeringSideCompatibility: 'UNIVERSAL' | 'LHD_ONLY' | 'RHD_ONLY';
  isHazmatOrAirbag: boolean;
  araDamageCode: string;
};

interface InMemoryPartStripStore {
  activeMemberships: Set<string>;
  policyOverrides: Map<string, Record<string, unknown> | null>;
  locations: Map<string, LockedStorageLocationRow>;
  vehicles: Map<string, StoredVehicleState>;
  parts: Map<string, MutableStoredPart>;
  expenses: Map<string, LockedDonorExpenseRow>;
  scrapLogs: Map<string, LockedScrapLogRow>;
  custodyEvents: Map<string, PersistPartCustodyEventRecord>;
  auditLogs: Map<string, PersistAuditLogRecord>;
  storageAudits: StorageAuditEventInput[];
  revokeNextCommitMembershipFor?: string;
}

function membershipKey(orgId: string, userId: string): string {
  return `${orgId.toLowerCase()}:${userId.toLowerCase()}`;
}

function createInMemoryStore(): InMemoryPartStripStore {
  const activeMemberships = new Set<string>([
    membershipKey(ORG_SALVAGE, CFO_ID),
    membershipKey(ORG_SALVAGE, HUNTER_ID),
    membershipKey(ORG_SALVAGE, STRIPPER_ID),
    membershipKey(ORG_SALVAGE, BUYER_ID),
    membershipKey(ORG_SALVAGE, VAULT_ADMIN_ID),
    membershipKey(ORG_SALVAGE_2, CFO_ID),
    membershipKey(ORG_CANNABIS, CFO_ID),
  ]);

  const locations = new Map<string, LockedStorageLocationRow>([
    [
      LOC_KEMP_C01,
      {
        id: LOC_KEMP_C01,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'KEMP-C01-R01-S01-B01',
      },
    ],
    [
      LOC_KEMP_C04,
      {
        id: LOC_KEMP_C04,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'KEMP-C04-R01-S01-B01',
      },
    ],
    [
      LOC_RAMS,
      {
        id: LOC_RAMS,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: true,
        maxActiveAssetCapacity: 8,
        fullQrBarcode: 'RAMS-SHOP-R01-S01-B01',
      },
    ],
    [
      LOC_POSV,
      {
        id: LOC_POSV,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.DORMANT_FUTURE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'POSV-V01-R01-S01-B01',
      },
    ],
    [
      LOC_BROCK,
      {
        id: LOC_BROCK,
        organizationId: ORG_CANNABIS,
        allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'BROCK-PROP-R1-T2',
      },
    ],
    [
      LOC_SALVAGE2_BIN,
      {
        id: LOC_SALVAGE2_BIN,
        organizationId: ORG_SALVAGE_2,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'S2-C01-R01-S01-B01',
      },
    ],
  ]);

  return {
    activeMemberships,
    policyOverrides: new Map([[ORG_SALVAGE, null], [ORG_SALVAGE_2, null]]),
    locations,
    vehicles: new Map(),
    parts: new Map(),
    expenses: new Map(),
    scrapLogs: new Map(),
    custodyEvents: new Map(),
    auditLogs: new Map(),
    storageAudits: [],
  };
}

function cloneMap<K, V>(src: Map<K, V>): Map<K, V> {
  const out = new Map<K, V>();
  for (const [k, v] of src.entries()) {
    out.set(k, structuredClone(v));
  }
  return out;
}

function createInMemoryHarness(store: InMemoryPartStripStore): {
  repository: PartStripRepository;
  storage: InMemoryStorageAdapter;
} {
  const securityRepository: StorageSecurityRepository = {
    async verifyActiveTenantAccess(ctx: TenantExecutionContext): Promise<void> {
      if (!store.activeMemberships.has(membershipKey(ctx.organizationId, ctx.userId))) {
        throw new AuthError(
          'MEMBERSHIP_REVOKED_OR_INACTIVE',
          'Membership revoked or inactive.',
        );
      }
    },
    async recordPrivateEvidenceAudit(
      ctx: TenantExecutionContext,
      event: StorageAuditEventInput,
    ): Promise<void> {
      if (!store.activeMemberships.has(membershipKey(ctx.organizationId, ctx.userId))) {
        throw new AuthError(
          'MEMBERSHIP_REVOKED_OR_INACTIVE',
          'Membership revoked or inactive.',
        );
      }
      store.storageAudits.push(event);
    },
  };

  const storage = new InMemoryStorageAdapter({ securityRepository });

  const repository: PartStripRepository = {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: PartStripTx) => Promise<T>,
    ): Promise<T> {
      if (!store.activeMemberships.has(membershipKey(ctx.organizationId, ctx.userId))) {
        throw new AuthError(
          'MEMBERSHIP_REVOKED_OR_INACTIVE',
          'Active organization membership is revoked or inactive.',
        );
      }

      // Snapshot for atomic rollback on any thrown error
      const snapVehicles = cloneMap(store.vehicles);
      const snapParts = cloneMap(store.parts);
      const snapExpenses = cloneMap(store.expenses);
      const snapScrapLogs = cloneMap(store.scrapLogs);
      const snapCustody = cloneMap(store.custodyEvents);
      const snapAudits = cloneMap(store.auditLogs);

      const tx: PartStripTx = {
        async acquireOrganizationLock(organizationId: string): Promise<void> {
          if (
            store.revokeNextCommitMembershipFor ===
            membershipKey(organizationId, ctx.userId)
          ) {
            store.activeMemberships.delete(store.revokeNextCommitMembershipFor);
            store.revokeNextCommitMembershipFor = undefined;
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Membership was revoked before commit.',
            );
          }
        },

        async readOrganizationPolicyRecord(organizationId: string) {
          if (!store.policyOverrides.has(organizationId)) {
            return { organizationId, policyConfigJson: null };
          }
          return {
            organizationId,
            policyConfigJson: store.policyOverrides.get(organizationId) ?? null,
          };
        },

        async findCommandReceipt(organizationId: string, receiptAuditId: string) {
          const audit = store.auditLogs.get(receiptAuditId);
          if (!audit || audit.organizationId !== organizationId) {
            return null;
          }
          return parseCommandReceiptNextState(audit.id, audit.nextState);
        },

        async findCustodyEventByIdempotencyKey(
          organizationId: string,
          idempotencyKey: string,
        ) {
          for (const ev of store.custodyEvents.values()) {
            if (
              ev.organizationId === organizationId &&
              ev.idempotencyKey === idempotencyKey
            ) {
              return { id: ev.id };
            }
          }
          return null;
        },

        async partQrSkuExists(qrSkuCode: string): Promise<boolean> {
          for (const p of store.parts.values()) {
            if (p.qrSkuCode === qrSkuCode) {
              return true;
            }
          }
          return false;
        },

        async findAndLockDonorVehicle(
          organizationId: string,
          donorVehicleId: string,
        ) {
          const v = store.vehicles.get(donorVehicleId);
          if (!v || v.organizationId !== organizationId) {
            return null;
          }
          return structuredClone(v);
        },

        async findAndLockDonorParts(
          organizationId: string,
          donorVehicleId: string,
        ) {
          return [...store.parts.values()]
            .filter(
              (p) =>
                p.organizationId === organizationId &&
                p.donorVehicleId === donorVehicleId,
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((p) => structuredClone(p));
        },

        async findAndLockPart(organizationId: string, partId: string) {
          const p = store.parts.get(partId);
          if (!p || p.organizationId !== organizationId) {
            return null;
          }
          return structuredClone(p);
        },

        async listDonorExpenses(organizationId: string, donorVehicleId: string) {
          return [...store.expenses.values()]
            .filter(
              (e) =>
                e.organizationId === organizationId &&
                e.vehicleId === donorVehicleId,
            )
            .map((e) => structuredClone(e));
        },

        async listDonorScrapLogs(organizationId: string, donorVehicleId: string) {
          return [...store.scrapLogs.values()]
            .filter(
              (s) =>
                s.organizationId === organizationId &&
                s.donorVehicleId === donorVehicleId,
            )
            .map((s) => structuredClone(s));
        },

        async findScrapLogById(organizationId: string, scrapLogId: string) {
          const s = store.scrapLogs.get(scrapLogId);
          if (!s || s.organizationId !== organizationId) {
            return null;
          }
          return structuredClone(s);
        },

        async findAndLockStorageLocationByBarcode(
          organizationId: string,
          fullQrBarcode: string,
        ) {
          for (const loc of store.locations.values()) {
            if (
              loc.organizationId === organizationId &&
              loc.fullQrBarcode === fullQrBarcode
            ) {
              return structuredClone(loc);
            }
          }
          return null;
        },

        async insertPart(input: PersistNewPartRecord): Promise<void> {
          for (const existing of store.parts.values()) {
            if (existing.qrSkuCode === input.qrSkuCode) {
              const err = new Error('Unique constraint failed: Part_qrSkuCode_key') as Error & {
                code: string;
                meta: { target: string[] };
              };
              err.code = 'P2002';
              err.meta = { target: ['qrSkuCode'] };
              throw err;
            }
          }
          const loc = store.locations.get(input.storageLocationId);
          store.parts.set(input.id, {
            id: input.id,
            organizationId: input.organizationId,
            donorVehicleId: input.donorVehicleId,
            qrSkuCode: input.qrSkuCode,
            custodyState: input.custodyState,
            availabilityState: input.availabilityState,
            ebaySyncState: input.ebaySyncState,
            classifiedsSyncState: input.classifiedsSyncState,
            complianceState: input.complianceState,
            partCategoryName: input.partCategoryName,
            tdgHazmatCode: input.tdgHazmatCode,
            araGrade: input.araGrade,
            compBaselineCadMinor: input.compBaselineCadMinor,
            allocatedCostBasisCadMinor: input.allocatedCostBasisCadMinor,
            storageLocationId: input.storageLocationId,
            currentLocationBarcode: loc?.fullQrBarcode ?? null,
            rawPhotoUrls: [...input.rawPhotoUrls],
            complianceWarnings: [...input.complianceWarnings],
            hasActiveSale: false,
            version: input.version,
            strippedAt: input.strippedAt,
            weightKg: input.weightKg,
            suggestedHsCode: input.suggestedHsCode,
            steeringSideCompatibility: input.steeringSideCompatibility,
            isHazmatOrAirbag: input.isHazmatOrAirbag,
            araDamageCode: input.araDamageCode,
          });
        },

        async updatePartStateAndLocation(input): Promise<boolean> {
          const existing = store.parts.get(input.partId);
          if (
            !existing ||
            existing.organizationId !== input.organizationId ||
            existing.version !== input.expectedCurrentVersion
          ) {
            return false;
          }
          const loc = input.storageLocationId
            ? store.locations.get(input.storageLocationId)
            : null;
          store.parts.set(input.partId, {
            ...existing,
            custodyState: input.custodyState,
            availabilityState: input.availabilityState,
            ebaySyncState: input.ebaySyncState,
            classifiedsSyncState: input.classifiedsSyncState,
            complianceState: input.complianceState,
            storageLocationId: input.storageLocationId,
            currentLocationBarcode: loc?.fullQrBarcode ?? null,
            complianceWarnings: [...input.complianceWarnings],
            version: input.nextVersion,
          });
          return true;
        },

        async updatePartCostBasis(input): Promise<boolean> {
          const existing = store.parts.get(input.partId);
          if (
            !existing ||
            existing.organizationId !== input.organizationId ||
            existing.version !== input.expectedCurrentVersion
          ) {
            return false;
          }
          store.parts.set(input.partId, {
            ...existing,
            allocatedCostBasisCadMinor: input.allocatedCostBasisCadMinor,
            version: input.nextVersion,
          });
          return true;
        },

        async updateDonorVehicle(input): Promise<boolean> {
          const existing = store.vehicles.get(input.donorVehicleId);
          if (
            !existing ||
            existing.organizationId !== input.organizationId ||
            existing.version !== input.expectedCurrentVersion
          ) {
            return false;
          }
          store.vehicles.set(input.donorVehicleId, {
            ...existing,
            ...(input.lifecycleState !== undefined
              ? { lifecycleState: input.lifecycleState }
              : {}),
            ...(input.catalyticConverterDisposition !== undefined
              ? {
                  catalyticConverterDisposition:
                    input.catalyticConverterDisposition,
                }
              : {}),
            ...(input.scrapMetalTicketKey !== undefined
              ? { scrapMetalTicketKey: input.scrapMetalTicketKey }
              : {}),
            ...(input.scrapRecoveryCadMinor !== undefined
              ? { scrapRecoveryCadMinor: input.scrapRecoveryCadMinor }
              : {}),
            ...(input.scrappedClearedAt !== undefined
              ? { scrappedClearedAt: input.scrappedClearedAt }
              : {}),
            ...(input.complianceWarnings !== undefined
              ? { complianceWarnings: [...input.complianceWarnings] }
              : {}),
            version: input.nextVersion,
          });
          return true;
        },

        async insertScrapComponentLog(input: PersistScrapLogRecord): Promise<void> {
          store.scrapLogs.set(input.id, {
            id: input.id,
            organizationId: input.organizationId,
            donorVehicleId: input.vehicleId,
            stream: input.scrapStream,
            weightKg: input.weightKg,
            payoutCadMinor: input.payoutCadMinor,
            recyclerName: input.recyclerName,
            recyclerTicketStorageKey: input.recyclerTicketStorageKey,
            cashCustodyState: input.cashCustodyState,
            recordedByUserId: input.recordedByUserId,
            createdAt: input.createdAt,
          });
        },

        async insertCustodyEvent(
          input: PersistPartCustodyEventRecord,
        ): Promise<void> {
          for (const ev of store.custodyEvents.values()) {
            if (
              ev.organizationId === input.organizationId &&
              ev.idempotencyKey === input.idempotencyKey
            ) {
              const err = new Error(
                'Unique constraint failed: CustodyEvent_organizationId_idempotencyKey_key',
              ) as Error & { code: string };
              err.code = 'P2002';
              throw err;
            }
          }
          store.custodyEvents.set(input.id, structuredClone(input));
        },

        async insertAuditLog(input: PersistAuditLogRecord): Promise<void> {
          if (store.auditLogs.has(input.id)) {
            const err = new Error('Unique constraint failed: AuditLog_pkey') as Error & {
              code: string;
            };
            err.code = 'P2002';
            throw err;
          }
          store.auditLogs.set(input.id, structuredClone(input));
        },

        async listStripDonors(organizationId, filter) {
          return [...store.vehicles.values()]
            .filter(
              (v) =>
                v.organizationId === organizationId &&
                v.operationalLane === 'DISMANTLE_AND_EXPORT' &&
                (!filter.donorVehicleId || v.id === filter.donorVehicleId),
            )
            .slice(0, filter.limit)
            .map((v) => ({
              id: v.id,
              internalStockNumber: v.internalStockNumber,
              assetCategory: v.assetCategory,
              year: v.year,
              make: v.make,
              model: v.model,
              operationalLane: v.operationalLane,
              lifecycleState: v.lifecycleState,
              fluidsDrainedAt: v.fluidsDrainedAt?.toISOString() ?? null,
              catalyticConverterDisposition: v.catalyticConverterDisposition,
              scrapRecoveryCadMinor: v.scrapRecoveryCadMinor,
              scrappedClearedAt: v.scrappedClearedAt?.toISOString() ?? null,
              complianceWarnings: v.complianceWarnings,
              bareShellScrapLogIds: [...store.scrapLogs.values()]
                .filter(
                  (s) =>
                    s.organizationId === organizationId &&
                    s.donorVehicleId === v.id &&
                    s.stream === 'BARE_STEEL_SHELL',
                )
                .map((s) => s.id),
              version: v.version,
            }));
        },

        async listParts(organizationId, filter) {
          return [...store.parts.values()]
            .filter(
              (p) =>
                p.organizationId === organizationId &&
                (!filter.donorVehicleId ||
                  p.donorVehicleId === filter.donorVehicleId) &&
                (!filter.partId || p.id === filter.partId) &&
                (!filter.qrSkuCode || p.qrSkuCode === filter.qrSkuCode) &&
                (!filter.qcHoldOnly ||
                  p.custodyState === 'RESTOCKED_QC_HOLD' ||
                  p.availabilityState === 'RETURNED_QC_HOLD'),
            )
            .slice(0, filter.limit)
            .map((p) => ({
              id: p.id,
              qrSkuCode: p.qrSkuCode,
              donorVehicleId: p.donorVehicleId,
              custodyState: p.custodyState,
              availabilityState: p.availabilityState,
              ebaySyncState: p.ebaySyncState,
              classifiedsSyncState: p.classifiedsSyncState,
              complianceState: p.complianceState,
              partCategoryName: p.partCategoryName,
              steeringSideCompatibility: p.steeringSideCompatibility,
              tdgHazmatCode: p.tdgHazmatCode,
              isHazmatOrAirbag: p.isHazmatOrAirbag,
              suggestedHsCode: p.suggestedHsCode,
              araGrade: p.araGrade,
              araDamageCode: p.araDamageCode,
              weightKg: p.weightKg,
              rawPhotoUrls: p.rawPhotoUrls,
              storageLocationId: p.storageLocationId,
              locationBarcode: p.currentLocationBarcode,
              allocatedCostBasisCadMinor: p.allocatedCostBasisCadMinor,
              compBaselineCadMinor: p.compBaselineCadMinor,
              complianceWarnings: p.complianceWarnings,
              version: p.version,
              strippedAt: p.strippedAt.toISOString(),
            }));
        },

        async listScrapHistory(organizationId, filter) {
          return [...store.scrapLogs.values()]
            .filter(
              (s) =>
                s.organizationId === organizationId &&
                (!filter.donorVehicleId ||
                  s.donorVehicleId === filter.donorVehicleId),
            )
            .slice(0, filter.limit)
            .map((s) => ({
              id: s.id,
              vehicleId: s.donorVehicleId,
              scrapStream: s.stream,
              weightKg: s.weightKg,
              payoutCadMinor: s.payoutCadMinor,
              recyclerName: s.recyclerName,
              cashCustodyState: s.cashCustodyState,
              hasTicketEvidence: true,
              createdAt: s.createdAt.toISOString(),
            }));
        },
      };

      try {
        return await fn(tx);
      } catch (err) {
        store.vehicles = snapVehicles;
        store.parts = snapParts;
        store.expenses = snapExpenses;
        store.scrapLogs = snapScrapLogs;
        store.custodyEvents = snapCustody;
        store.auditLogs = snapAudits;
        throw err;
      }
    },
  };

  return { repository, storage };
}

function addDonor(
  store: InMemoryPartStripStore,
  overrides: Partial<StoredVehicleState> = {},
): StoredVehicleState {
  const id = overrides.id ?? randomUUID();
  const donor: StoredVehicleState = {
    id,
    organizationId: overrides.organizationId ?? ORG_SALVAGE,
    internalStockNumber:
      overrides.internalStockNumber ?? `AST-2026-${id.slice(0, 4).toUpperCase()}`,
    assetCategory: overrides.assetCategory ?? AssetCategory.AUTOMOBILE,
    operationalLane:
      overrides.operationalLane ?? OperationalLane.DISMANTLE_AND_EXPORT,
    lifecycleState:
      overrides.lifecycleState ?? AssetLifecycleState.DISMANTLING_IN_PROGRESS,
    actualPurchasePriceCadMinor:
      overrides.actualPurchasePriceCadMinor ?? 100_000,
    targetGrossRealizationMinor:
      overrides.targetGrossRealizationMinor ?? 400_000,
    fluidsDrainedAt:
      overrides.fluidsDrainedAt !== undefined
        ? overrides.fluidsDrainedAt
        : new Date('2026-11-01T10:00:00.000Z'),
    catalyticConverterDisposition:
      overrides.catalyticConverterDisposition ??
      CatalyticConverterDisposition.PRESENT_AT_INTAKE,
    scrapMetalTicketKey: overrides.scrapMetalTicketKey ?? null,
    scrapRecoveryCadMinor: overrides.scrapRecoveryCadMinor ?? 0,
    scrappedClearedAt: overrides.scrappedClearedAt ?? null,
    complianceWarnings: overrides.complianceWarnings ?? [],
    version: overrides.version ?? 1,
    year: overrides.year ?? 2020,
    make: overrides.make ?? 'Honda',
    model: overrides.model ?? 'CR-V',
  };
  store.vehicles.set(donor.id, donor);
  return donor;
}

describe('Issue 08: 3-Tap Part Strip, Return QC Hold, 5-Stream Scrap & Hulk Clearance (Offline Suite)', () => {
  let store!: InMemoryPartStripStore;
  let repository!: PartStripRepository;
  let storage!: InMemoryStorageAdapter;
  let stripUseCase!: StripPartUseCase;
  let scrapUseCase!: LogScrapComponentUseCase;
  let hulkUseCase!: CompleteHulkScrapUseCase;
  let sampleJpeg!: Uint8Array;

  beforeEach(async () => {
    store = createInMemoryStore();
    const harness = createInMemoryHarness(store);
    repository = harness.repository;
    storage = harness.storage;
    stripUseCase = new StripPartUseCase({ repository, storage });
    scrapUseCase = new LogScrapComponentUseCase({ repository, storage });
    hulkUseCase = new CompleteHulkScrapUseCase({ repository });
    sampleJpeg = await createSampleJpegWithGpsExif();
  });

  it('executes online 3-tap strip into SHELVED_ORIGIN_CONTAINER, activates STAGED_ONTARIO_YARD donor, strips EXIF GPS, and records CustodyEvent + AuditLog receipt', async () => {
    const donor = addDonor(store, {
      lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
      actualPurchasePriceCadMinor: 100_000,
      targetGrossRealizationMinor: 200_000,
    });
    const session = makeSession({ role: UserRole.ONTARIO_STRIPPER });
    const idempotencyKey = randomUUID();

    const res = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Alternator',
      qrSkuCode: 'prt-884920',
      araGrade: 'B1',
      compBaselineCadMinor: 50_000,
      weightKg: 5.4,
      destinationBinBarcode: 'kemp-c01-r01-s01-b01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey,
      deviceTimestamp: '2026-11-16T12:00:00.000Z',
    });

    expect(res.replayed).toBe(false);
    expect(res.donorLifecycleState).toBe('DISMANTLING_IN_PROGRESS');
    expect(res.donorVersion).toBe(2);
    expect(res.qrSkuCode).toBe('PRT-884920');
    expect(res.custodyState).toBe(PartCustodyState.SHELVED_ORIGIN_CONTAINER);
    expect(res.availabilityState).toBe(InventoryAvailabilityState.AVAILABLE);
    expect(res.ebaySyncState).toBe(EbaySyncState.NOT_LISTED);
    expect(res.classifiedsSyncState).toBe(ClassifiedsSyncState.NOT_POSTED);
    expect(res.complianceState).toBe(PartComplianceState.CLEARED_FOR_SALE);
    expect(res.steeringSideCompatibility).toBe('UNIVERSAL');
    expect(res.tdgHazmatCode).toBe(TdgHazmatCode.NONE);
    expect(res.isHazmatOrAirbag).toBe(false);
    expect(res.suggestedHsCode).toBe('8708.99');
    expect(res.araGrade).toBe('GRADE_B1');
    expect(res.version).toBe(1);
    // Stage 1: 50_000 * 1.00 / max(200_000, 50_000) * 100_000 = 25_000
    expect(res.allocatedCostBasisCadMinor).toBe(25_000);
    expect(res.rawPhotoUrls).toHaveLength(3);

    // Verify EXIF GPS was stripped from stored WebP images in R2 public bucket
    expect(storage.publicBucket.size).toBe(3);
    for (const stored of storage.publicBucket.values()) {
      expect(stored.contentType).toBe('image/webp');
      expect(stored.key.startsWith(`${ORG_SALVAGE}/media/`)).toBe(true);
      const meta = await sharp(Buffer.from(stored.body)).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
    }

    // Verify CustodyEvent initial creation convention
    const ev = store.custodyEvents.get(res.custodyEventId);
    expect(ev).toBeDefined();
    expect(ev?.fromLocationBarcode).toBeNull();
    expect(ev?.toLocationBarcode).toBe('KEMP-C01-R01-S01-B01');
    expect(ev?.expectedVersion).toBe(1);
    expect(ev?.hasConflict).toBe(false);

    // Idempotent replay with same key + same donorExpectedVersion=1 succeeds even after donor incremented to v2
    // and even if the retry carries a later deviceTimestamp after server receipt commit
    const replay = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Alternator',
      qrSkuCode: 'PRT-884920',
      araGrade: 'B1',
      compBaselineCadMinor: 50_000,
      weightKg: 5.4,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey,
      deviceTimestamp: '2026-11-16T12:05:00.000Z',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.partId).toBe(res.partId);
    expect(storage.publicBucket.size).toBe(3); // Preflight avoided re-upload!
  });

  it('enforces TDG hazmat classification, blocks airbag downgrade to NONE, and separates quarantined airbags from local-only batteries', async () => {
    const donor = addDonor(store);
    const session = makeSession({ role: UserRole.HUNTER_MECHANIC });

    // Downgrading Safety Airbag to NONE is rejected
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Safety Airbag',
        qrSkuCode: 'PRT-100001',
        araGrade: 'B2',
        tdgHazmatCode: 'NONE',
        compBaselineCadMinor: 20_000,
        weightKg: 1.8,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({
      code: 'HAZMAT_DOWNGRADE_FORBIDDEN',
      status: 422,
    });

    // Airbag auto-quarantines
    const airbag = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Safety Airbag',
      qrSkuCode: 'PRT-100002',
      araGrade: 'B2',
      compBaselineCadMinor: 20_000,
      weightKg: 1.8,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(airbag.tdgHazmatCode).toBe('UN3268_AIRBAG');
    expect(airbag.isHazmatOrAirbag).toBe(true);
    expect(airbag.complianceState).toBe('QUARANTINED_RECALL_OR_DG');
    expect(airbag.suggestedHsCode).toBe('8708.95');

    // Pyrotechnic pretensioner auto-quarantines
    const pyro = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Pyrotechnic Pretensioners',
      qrSkuCode: 'PRT-100003',
      araGrade: 'A',
      compBaselineCadMinor: 15_000,
      weightKg: 1.2,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(pyro.tdgHazmatCode).toBe('UN0503_PYROTECHNIC');
    expect(pyro.isHazmatOrAirbag).toBe(true);
    expect(pyro.complianceState).toBe('QUARANTINED_RECALL_OR_DG');

    // Wet & Lithium batteries are CLEARED_FOR_SALE (local pickup eligible, eBay parcel blocked)
    const wetBattery = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Lead-Acid Wet Battery',
      qrSkuCode: 'PRT-100004',
      araGrade: 'B1',
      compBaselineCadMinor: 12_000,
      weightKg: 14.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(wetBattery.tdgHazmatCode).toBe('UN2794_WET_BATTERY');
    expect(wetBattery.isHazmatOrAirbag).toBe(true);
    expect(wetBattery.complianceState).toBe('CLEARED_FOR_SALE');
    expect(wetBattery.suggestedHsCode).toBe('8507.10');

    const lithiumBattery = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Lithium-Ion Battery Pack',
      qrSkuCode: 'PRT-100005',
      araGrade: 'C',
      compBaselineCadMinor: 80_000,
      weightKg: 12.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(lithiumBattery.tdgHazmatCode).toBe('UN3480_LITHIUM_BATTERY');
    expect(lithiumBattery.isHazmatOrAirbag).toBe(true);
    expect(lithiumBattery.complianceState).toBe('CLEARED_FOR_SALE');
    expect(lithiumBattery.suggestedHsCode).toBe('8507.60');

    // Verify local-only vs eBay parcel blocking via domain channel recommender
    const policy = await new JsonPolicyConfigAdapter().getPolicyForOrg(ORG_SALVAGE);
    const rec = recommendDomesticChannels(
      {
        weightKg: 14.0,
        tdgHazmatCode: wetBattery.tdgHazmatCode,
        complianceState: wetBattery.complianceState,
      },
      policy,
    );
    expect(rec.isLocalSaleEligible).toBe(true);
    expect(rec.isEbayParcelEligible).toBe(false);

    // Unknown category requires explicit classification
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Custom Hybrid Inverter',
        qrSkuCode: 'PRT-100006',
        araGrade: 'B1',
        compBaselineCadMinor: 40_000,
        weightKg: 8.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PART_STRIP_INPUT', status: 400 });
  });

  it('rejects duplicate PRT-XXXXXX with 409, cross-tenant donor with 404, cross-tenant bin with 422, and enforces RULE-ENV-001', async () => {
    const donorUndrained = addDonor(store, { fluidsDrainedAt: null });
    const otherDonor = addDonor(store, { organizationId: ORG_SALVAGE_2 });
    const session = makeSession({ role: UserRole.ONTARIO_STRIPPER });

    // Cross-tenant donor -> 404
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: otherDonor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Alternator',
        qrSkuCode: 'PRT-200001',
        araGrade: 'B1',
        compBaselineCadMinor: 20_000,
        weightKg: 5.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', status: 404 });

    // Cross-tenant bin -> 422 SITE_ZONING_VIOLATION
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: donorUndrained.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Alternator',
        qrSkuCode: 'PRT-200002',
        araGrade: 'B1',
        compBaselineCadMinor: 20_000,
        weightKg: 5.0,
        destinationBinBarcode: 'S2-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toBeInstanceOf(LocationCustodyError);

    // RULE-ENV-001: fluid-bearing engine from undrained donor -> WARN_ONLY emits warning
    const engine = await stripUseCase.execute(session, {
      donorVehicleId: donorUndrained.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Complete Engine Assembly',
      qrSkuCode: 'PRT-200003',
      araGrade: 'B2',
      compBaselineCadMinor: 90_000,
      weightKg: 140.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(engine.complianceWarnings).toContain(
      'COMPLIANCE_WARNING_UNDRAINED_FARM',
    );

    // Ordinary dry part from undrained donor does NOT trigger COMPLIANCE_WARNING_UNDRAINED_FARM
    const bumper = await stripUseCase.execute(session, {
      donorVehicleId: donorUndrained.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Front Bumper',
      qrSkuCode: 'PRT-200004',
      araGrade: 'B2',
      compBaselineCadMinor: 30_000,
      weightKg: 8.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(bumper.complianceWarnings).not.toContain(
      'COMPLIANCE_WARNING_UNDRAINED_FARM',
    );

    // Duplicate PRT-200003 -> 409 DUPLICATE_QR_SKU
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: donorUndrained.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Alternator',
        qrSkuCode: 'PRT-200003',
        araGrade: 'B1',
        compBaselineCadMinor: 20_000,
        weightKg: 5.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_QR_SKU', status: 409 });

    // STRICT_BLOCK blocks undrained engine
    store.policyOverrides.set(ORG_SALVAGE, {
      operationalGates: { complianceEnforcementMode: 'STRICT_BLOCK' },
    });
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: donorUndrained.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Transmission / Gearbox / Transaxle',
        qrSkuCode: 'PRT-200005',
        araGrade: 'B1',
        compBaselineCadMinor: 70_000,
        weightKg: 60.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({
      code: 'ENVIRONMENTAL_ZONING_VIOLATION',
      status: 422,
    });
  });

  it('enforces Anti-Part-Swap Return QC Hold: SOLD_AND_RELEASED -> (RESTOCKED_QC_HOLD, RETURNED_QC_HOLD, NEEDS_HUMAN_REVIEW) -> SHELVED_ORIGIN_CONTAINER | SCRAPPED_OR_DAMAGED', async () => {
    const donor = addDonor(store);
    const session = makeSession({ role: UserRole.HUNTER_MECHANIC });

    const stripped = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Steering Rack',
      qrSkuCode: 'PRT-300001',
      araGrade: 'B1',
      compBaselineCadMinor: 50_000,
      weightKg: 9.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(stripped.steeringSideCompatibility).toBe('LHD_ONLY');

    // Simulate checkout + live classifieds prior to return
    const partRec = store.parts.get(stripped.partId)!;
    partRec.custodyState = PartCustodyState.SOLD_AND_RELEASED;
    partRec.availabilityState = InventoryAvailabilityState.PAID_SETTLED;
    partRec.ebaySyncState = EbaySyncState.SYNDICATED_LIVE;
    partRec.classifiedsSyncState = ClassifiedsSyncState.POSTED_LIVE;
    partRec.hasActiveSale = true; // Active sale remains until refund workflow voids it

    const intakeRes = await stripUseCase.receiveReturnedPartIntoQcHold(session, {
      partId: stripped.partId,
      expectedVersion: 1,
      qcLocationBarcode: 'KEMP-C04-R01-S01-B01',
      returnReason: 'Buyer claims wrong fitment',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });

    expect(intakeRes.custodyState).toBe('RESTOCKED_QC_HOLD');
    expect(intakeRes.availabilityState).toBe('RETURNED_QC_HOLD');
    expect(intakeRes.complianceState).toBe('NEEDS_HUMAN_REVIEW');
    expect(intakeRes.ebaySyncState).toBe('DELISTED');
    expect(intakeRes.classifiedsSyncState).toBe('DELIST_REQUIRED');
    expect(intakeRes.version).toBe(2);

    // Pure domain guards block shelving, eBay CSV, classifieds, and checkout while in QC hold
    const heldSnapshot = {
      custodyState: intakeRes.custodyState,
      availabilityState: intakeRes.availabilityState,
      ebaySyncState: intakeRes.ebaySyncState,
      classifiedsSyncState: intakeRes.classifiedsSyncState,
      complianceState: intakeRes.complianceState,
    };
    expect(() =>
      validatePartTransition(heldSnapshot, 'SHELVE_IN_ORIGIN_CONTAINER', {
        originBinBarcode: 'KEMP-C01-R01-S01-B01',
      }),
    ).toThrow(DomainRuleError);
    expect(() =>
      validatePartTransition(heldSnapshot, 'CHECKOUT_DOMESTIC'),
    ).toThrow(DomainRuleError);
    expect(() =>
      validatePartTransition(heldSnapshot, 'EXPORT_EBAY_CSV', {
        tdgHazmatCode: 'NONE',
        weightKg: 9.0,
      }),
    ).toThrow(DomainRuleError);

    // Pass QC inspection after OEM/tamper markings comparison
    const passRes = await stripUseCase.completeReturnQcInspection(session, {
      partId: stripped.partId,
      expectedVersion: 2,
      qcPassed: true,
      inspectedOriginalPhotosAndMarkings: true,
      inspectionNotes: 'Verified OEM stamp 53601-TLA and intact tamper seal.',
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(passRes.custodyState).toBe('SHELVED_ORIGIN_CONTAINER');
    expect(passRes.availabilityState).toBe('AVAILABLE');
    expect(passRes.complianceState).toBe('CLEARED_FOR_SALE');
    expect(passRes.ebaySyncState).toBe('DELISTED');
    expect(passRes.version).toBe(3);

    // Test Fail QC -> SCRAPPED_OR_DAMAGED (without physical bin move -> no CustodyEvent)
    const battery = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Lead-Acid Wet Battery',
      qrSkuCode: 'PRT-300002',
      araGrade: 'B1',
      compBaselineCadMinor: 15_000,
      weightKg: 14.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    const batRec = store.parts.get(battery.partId)!;
    batRec.custodyState = PartCustodyState.SOLD_AND_RELEASED;
    batRec.availabilityState = InventoryAvailabilityState.PAID_SETTLED;

    await stripUseCase.receiveReturnedPartIntoQcHold(session, {
      partId: battery.partId,
      expectedVersion: 1,
      qcLocationBarcode: 'KEMP-C04-R01-S01-B01',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });

    const failRes = await stripUseCase.completeReturnQcInspection(session, {
      partId: battery.partId,
      expectedVersion: 2,
      qcPassed: false,
      inspectedOriginalPhotosAndMarkings: true,
      inspectionNotes: 'Swapped aftermarket core returned; failed OEM tamper check.',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(failRes.custodyState).toBe('SCRAPPED_OR_DAMAGED');
    expect(failRes.availabilityState).toBe('RETURNED_QC_HOLD');
    expect(failRes.complianceState).toBe('NEEDS_HUMAN_REVIEW');
    expect(failRes.custodyEventId).toBeNull();
  });

  it('logs 5-stream scrap with float vs bank separation (FIX 05), nets direct expenses, reconciles Stage 2 exact cents, and clears hulk', async () => {
    const donor = addDonor(store, {
      actualPurchasePriceCadMinor: 100_000,
      targetGrossRealizationMinor: 300_000,
    });

    // Add allowlisted, reversed, excluded, and AUCTION_PURCHASE_PRICE expenses
    const buyerFeeId = randomUUID();
    store.expenses.set(buyerFeeId, {
      id: buyerFeeId,
      organizationId: ORG_SALVAGE,
      vehicleId: donor.id,
      category: ExpenseCategory.AUCTION_BUYER_FEE,
      amountCadMinor: 25_000,
      isReversalEntry: false,
      reversesExpenseId: null,
    });
    const towingId = randomUUID();
    store.expenses.set(towingId, {
      id: towingId,
      organizationId: ORG_SALVAGE,
      vehicleId: donor.id,
      category: ExpenseCategory.TOWING_AND_RECOVERY,
      amountCadMinor: 20_000,
      isReversalEntry: false,
      reversesExpenseId: null,
    });
    // Partial reversal of towing (-5_000 -> net 15_000)
    store.expenses.set(randomUUID(), {
      id: randomUUID(),
      organizationId: ORG_SALVAGE,
      vehicleId: donor.id,
      category: ExpenseCategory.TOWING_AND_RECOVERY,
      amountCadMinor: 5_000,
      isReversalEntry: true,
      reversesExpenseId: towingId,
    });
    // Excluded categories (AUCTION_PURCHASE_PRICE must not double-count, PARTNER_PROFIT_DRAW excluded)
    store.expenses.set(randomUUID(), {
      id: randomUUID(),
      organizationId: ORG_SALVAGE,
      vehicleId: donor.id,
      category: ExpenseCategory.AUCTION_PURCHASE_PRICE,
      amountCadMinor: 100_000,
      isReversalEntry: false,
      reversesExpenseId: null,
    });
    store.expenses.set(randomUUID(), {
      id: randomUUID(),
      organizationId: ORG_SALVAGE,
      vehicleId: donor.id,
      category: ExpenseCategory.PARTNER_PROFIT_DRAW,
      amountCadMinor: 50_000,
      isReversalEntry: false,
      reversesExpenseId: null,
    });
    // Total donor outlay = 100_000 + 25_000 + (20_000 - 5_000) = 140_000 cents

    const session = makeSession({ role: UserRole.HUNTER_MECHANIC });
    const partA = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Alternator',
      qrSkuCode: 'PRT-400001',
      araGrade: 'B1',
      compBaselineCadMinor: 100_000,
      weightKg: 5.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    const partB = await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'ECU',
      qrSkuCode: 'PRT-400002',
      araGrade: 'B1',
      compBaselineCadMinor: 50_000,
      weightKg: 1.5,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });

    // Log stream 1: Catalytic converter CASH -> HELD_IN_OPERATOR_FLOAT
    const catLog = await scrapUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      scrapStream: ScrapStreamCategory.CATALYTIC_CONVERTER,
      weightKg: 3.8,
      payoutCadMinor: 20_000,
      recyclerName: 'Kemptville Cats',
      paymentReceiptMode: 'CASH',
      ticketBytes: sampleJpeg,
      ticketContentType: 'image/jpeg',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(catLog.cashCustodyState).toBe(CashCustodyState.HELD_IN_OPERATOR_FLOAT);
    expect(catLog.catalyticConverterDisposition).toBe('LOGGED_SCRAP_SALE');
    expect(catLog.donorVersion).toBe(2);
    expect(catLog.scrapRecoveryCadMinor).toBe(20_000);
    // Remaining outlay = 140_000 - 20_000 = 120_000; 2:1 ratio -> 80_000 + 40_000
    expect(store.parts.get(partA.partId)?.allocatedCostBasisCadMinor).toBe(80_000);
    expect(store.parts.get(partB.partId)?.allocatedCostBasisCadMinor).toBe(40_000);

    // Log stream 5: Bare Steel Shell CONFIRMED_BANK_DEPOSIT -> SETTLED_ORIGIN_CORP_BANK
    const shellLog = await scrapUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 2,
      scrapStream: ScrapStreamCategory.BARE_STEEL_SHELL,
      weightKg: 920.5,
      payoutCadMinor: 30_000,
      recyclerName: 'Ottawa Steel',
      paymentReceiptMode: 'CONFIRMED_BANK_DEPOSIT',
      bankDepositConfirmed: true,
      bankDepositReference: 'EFT-2026-881',
      ticketBytes: sampleJpeg,
      ticketContentType: 'image/jpeg',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(shellLog.cashCustodyState).toBe(
      CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
    );
    expect(shellLog.donorVersion).toBe(3);
    expect(shellLog.scrapRecoveryCadMinor).toBe(50_000);
    // Remaining outlay = 140_000 - 50_000 = 90_000; 2:1 ratio -> 60_000 + 30_000
    expect(store.parts.get(partA.partId)?.allocatedCostBasisCadMinor).toBe(60_000);
    expect(store.parts.get(partB.partId)?.allocatedCostBasisCadMinor).toBe(30_000);

    // Verify FIX 05 liquidity separation using computeSeparatedFinancialSnapshot
    const policy = await new JsonPolicyConfigAdapter().getPolicyForOrg(ORG_SALVAGE);
    const snapshot = computeSeparatedFinancialSnapshot(
      {
        organizationId: ORG_SALVAGE,
        tranches: policy.operationalGates.workingCapitalGate.tranches,
        sales: [],
        scrapLogs: [...store.scrapLogs.values()].map((l) => ({
          id: l.id,
          organizationId: l.organizationId,
          vehicleId: l.donorVehicleId,
          payoutCadMinor: l.payoutCadMinor,
          cashCustodyState: l.cashCustodyState,
          custodyHolderUserId: l.recordedByUserId,
        })),
        cashTransfers: [],
        repatriationSettlements: [],
        expenses: [],
        priorPartnerDrawsCadMinor: 0,
      },
      policy,
    );
    expect(snapshot.runningOperatorFloatCadMinor).toBe(20_000); // Cash ticket only
    // Confirmed bank = initialSeedCapital (2_200_000) + bank scrap (30_000), NEVER cash float (20_000)
    expect(snapshot.confirmedCorpBankCashCadMinor).toBe(2_230_000);
    expect(snapshot.availableWorkingCapitalCadMinor).toBe(2_230_000);

    // Complete Hulk Clearance reusing BARE_STEEL_SHELL ticket (no double payout)
    const hulkRes = await hulkUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 3,
      bareShellScrapLogId: shellLog.scrapLogId,
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(hulkRes.lifecycleState).toBe('SCRAPPED_METAL_CLEARED');
    expect(hulkRes.scrapRecoveryCadMinor).toBe(50_000);
    expect(hulkRes.complianceWarnings).toEqual([]);

    // Terminal donor cannot accept new strip
    await expect(
      stripUseCase.execute(session, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 4,
        partCategoryName: 'Front Bumper',
        qrSkuCode: 'PRT-400003',
        araGrade: 'B1',
        compBaselineCadMinor: 25_000,
        weightKg: 7.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VEHICLE_TRANSITION', status: 422 });
  });

  it('enforces catalytic disposition conflicts, WARN_ONLY vs STRICT_BLOCK hulk clearance, and true-up rollback', async () => {
    const donor = addDonor(store, {
      actualPurchasePriceCadMinor: 50_000,
      catalyticConverterDisposition:
        CatalyticConverterDisposition.PRESENT_AT_INTAKE,
    });
    const session = makeSession({ role: UserRole.ARCHITECT_CFO });

    await stripUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Alternator',
      qrSkuCode: 'PRT-500001',
      araGrade: 'B1',
      compBaselineCadMinor: 40_000,
      weightKg: 5.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });

    // Excess scrap payout (> total donor outlay 50_000) fails true-up and rolls back scrap log
    await expect(
      scrapUseCase.execute(session, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        scrapStream: ScrapStreamCategory.BARE_STEEL_SHELL,
        weightKg: 900.0,
        payoutCadMinor: 60_000,
        recyclerName: 'Ottawa Steel',
        paymentReceiptMode: 'CASH',
        ticketBytes: sampleJpeg,
        ticketContentType: 'image/jpeg',
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({
      code: 'DONOR_COST_RECONCILIATION_EXCEEDED',
      status: 422,
    });
    expect(store.scrapLogs.size).toBe(0);
    expect(store.vehicles.get(donor.id)?.version).toBe(1);

    // Valid BARE_STEEL_SHELL log, leaving catalyticConverterDisposition = PRESENT_AT_INTAKE
    const shell = await scrapUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      scrapStream: ScrapStreamCategory.BARE_STEEL_SHELL,
      weightKg: 900.0,
      payoutCadMinor: 25_000,
      recyclerName: 'Ottawa Steel',
      paymentReceiptMode: 'CASH',
      ticketBytes: sampleJpeg,
      ticketContentType: 'image/jpeg',
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });

    // STRICT_BLOCK blocks unreconciled cat with 422
    store.policyOverrides.set(ORG_SALVAGE, {
      operationalGates: { complianceEnforcementMode: 'STRICT_BLOCK' },
    });
    await expect(
      hulkUseCase.execute(session, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 2,
        bareShellScrapLogId: shell.scrapLogId,
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({
      code: 'UNRECONCILED_CATALYTIC_CONVERTER',
      status: 422,
    });
    expect(store.vehicles.get(donor.id)?.lifecycleState).toBe(
      'DISMANTLING_IN_PROGRESS',
    );

    // WARN_ONLY succeeds and records UNRECONCILED_CATALYTIC_CONVERTER
    store.policyOverrides.set(ORG_SALVAGE, {
      operationalGates: { complianceEnforcementMode: 'WARN_ONLY' },
    });
    const cleared = await hulkUseCase.execute(session, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 2,
      bareShellScrapLogId: shell.scrapLogId,
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });
    expect(cleared.lifecycleState).toBe('SCRAPPED_METAL_CLEARED');
    expect(cleared.complianceWarnings).toContain(
      'UNRECONCILED_CATALYTIC_CONVERTER',
    );
  });

  it('derives deterministic receipt IDs, rejects key reuse across actions/actors, and enforces live membership revocation', async () => {
    const id1 = deriveIssue8CommandReceiptId(
      ORG_SALVAGE,
      '11111111-1111-4111-8111-111111111111',
    );
    const id2 = deriveIssue8CommandReceiptId(
      ORG_SALVAGE,
      '11111111-1111-4111-8111-111111111111',
    );
    const idOtherOrg = deriveIssue8CommandReceiptId(
      ORG_SALVAGE_2,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(id1).toBe(id2);
    expect(id1).not.toBe(idOtherOrg);

    const donor = addDonor(store);
    const stripperSession = makeSession({ role: UserRole.ONTARIO_STRIPPER });
    const hunterSession = makeSession({ role: UserRole.HUNTER_MECHANIC });
    const sharedKey = randomUUID();

    await stripUseCase.execute(stripperSession, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Alternator',
      qrSkuCode: 'PRT-600001',
      araGrade: 'B1',
      compBaselineCadMinor: 25_000,
      weightKg: 5.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: sharedKey,
      deviceTimestamp: new Date(),
    });

    // Different actor with same key -> 409 IDEMPOTENCY_KEY_REUSED
    await expect(
      stripUseCase.execute(hunterSession, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Alternator',
        qrSkuCode: 'PRT-600001',
        araGrade: 'B1',
        compBaselineCadMinor: 25_000,
        weightKg: 5.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: sharedKey,
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    // Different action with same key -> 409 IDEMPOTENCY_KEY_REUSED
    await expect(
      scrapUseCase.execute(stripperSession, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        scrapStream: ScrapStreamCategory.BARE_STEEL_SHELL,
        weightKg: 900,
        payoutCadMinor: 20_000,
        recyclerName: 'Steel Co',
        paymentReceiptMode: 'CASH',
        ticketBytes: sampleJpeg,
        ticketContentType: 'image/jpeg',
        idempotencyKey: sharedKey,
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    // Live revocation mid-flight denies commit with 403 MEMBERSHIP_REVOKED_OR_INACTIVE
    store.revokeNextCommitMembershipFor = membershipKey(
      ORG_SALVAGE,
      STRIPPER_ID,
    );
    await expect(
      stripUseCase.execute(stripperSession, {
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Front Bumper',
        qrSkuCode: 'PRT-600002',
        araGrade: 'B1',
        compBaselineCadMinor: 25_000,
        weightKg: 7.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        photos: [
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
          { bytes: sampleJpeg },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: new Date(),
      }),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      status: 403,
    });
  });

  it('validates HTTP POST multipart, PATCH JSON, GET views & private ticket presigning, and production Prisma composition', async () => {
    const donor = addDonor(store);
    const stripperSession = makeSession({ role: UserRole.ONTARIO_STRIPPER });
    const buyerSession = makeSession({ role: UserRole.OVERSEAS_B2B_BUYER });
    const cannabisSession = makeSession({
      organizationId: ORG_CANNABIS,
      role: UserRole.ARCHITECT_CFO,
    });

    const routeDeps = {
      resolveSession: async () => stripperSession,
      stripPartUseCase: stripUseCase,
      logScrapUseCase: scrapUseCase,
      completeHulkUseCase: hulkUseCase,
    };

    // RBAC denial for OVERSEAS_B2B_BUYER & CANNABIS workspace
    const deniedBuyer = await handleSalvagePartsGet(
      new Request('http://localhost/api/salvage/parts?view=donors'),
      { ...routeDeps, resolveSession: async () => buyerSession },
    );
    expect(deniedBuyer.status).toBe(403);

    const deniedCannabis = await handleSalvagePartsGet(
      new Request('http://localhost/api/salvage/parts?view=donors'),
      { ...routeDeps, resolveSession: async () => cannabisSession },
    );
    expect(deniedCannabis.status).toBe(403);

    // Forged server fields in POST metadata are rejected (400)
    const forgedForm = new FormData();
    forgedForm.append(
      'metadata',
      JSON.stringify({
        action: 'strip',
        organizationId: ORG_SALVAGE_2,
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Alternator',
        qrSkuCode: 'PRT-700001',
        araGrade: 'B1',
        compBaselineCadMinor: 30_000,
        weightKg: 5.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        deviceTimestamp: new Date().toISOString(),
      }),
    );
    const jpegBlobPart = Uint8Array.from(sampleJpeg);
    forgedForm.append('photos', new File([jpegBlobPart], '1.jpg', { type: 'image/jpeg' }));
    forgedForm.append('photos', new File([jpegBlobPart], '2.jpg', { type: 'image/jpeg' }));
    forgedForm.append('photos', new File([jpegBlobPart], '3.jpg', { type: 'image/jpeg' }));

    const forgedRes = await handleSalvagePartsPost(
      new Request('http://localhost/api/salvage/parts', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: forgedForm,
      }),
      routeDeps,
    );
    expect(forgedRes.status).toBe(400);

    // Oversize file (> 10 MiB) rejected with 413 PAYLOAD_TOO_LARGE
    const oversizeBuf = new Uint8Array(MAX_PART_PHOTO_BYTES + 1);
    const oversizeForm = new FormData();
    oversizeForm.append(
      'metadata',
      JSON.stringify({
        action: 'strip',
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        partCategoryName: 'Alternator',
        qrSkuCode: 'PRT-700002',
        araGrade: 'B1',
        compBaselineCadMinor: 30_000,
        weightKg: 5.0,
        destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
        deviceTimestamp: new Date().toISOString(),
      }),
    );
    oversizeForm.append('photos', new File([oversizeBuf], 'big.jpg', { type: 'image/jpeg' }));
    oversizeForm.append('photos', new File([jpegBlobPart], '2.jpg', { type: 'image/jpeg' }));
    oversizeForm.append('photos', new File([jpegBlobPart], '3.jpg', { type: 'image/jpeg' }));
    const oversizeRes = await handleSalvagePartsPost(
      new Request('http://localhost/api/salvage/parts', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: oversizeForm,
      }),
      routeDeps,
    );
    expect(oversizeRes.status).toBe(413);

    // Strip one part on donor so Stage 2 scrap allocation has an unsold part target
    await stripUseCase.execute(stripperSession, {
      donorVehicleId: donor.id,
      donorExpectedVersion: 1,
      partCategoryName: 'Alternator',
      qrSkuCode: 'PRT-700003',
      araGrade: 'B1',
      compBaselineCadMinor: 40_000,
      weightKg: 5.0,
      destinationBinBarcode: 'KEMP-C01-R01-S01-B01',
      photos: [
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
        { bytes: sampleJpeg },
      ],
      idempotencyKey: randomUUID(),
      deviceTimestamp: new Date(),
    });

    // Valid POST log-scrap & GET view=scrap-history (no private key leak) & GET view=ticket (short-lived URL + no-store)
    const scrapForm = new FormData();
    const scrapKey = randomUUID();
    scrapForm.append(
      'metadata',
      JSON.stringify({
        action: 'log-scrap',
        donorVehicleId: donor.id,
        donorExpectedVersion: 1,
        scrapStream: 'BARE_STEEL_SHELL',
        weightKg: 950.0,
        payoutCadMinor: 25_000,
        recyclerName: 'Kemptville Scrap',
        paymentReceiptMode: 'CASH',
        deviceTimestamp: new Date().toISOString(),
      }),
    );
    scrapForm.append(
      'ticket',
      new File([jpegBlobPart], 'ticket.jpg', { type: 'image/jpeg' }),
    );
    const scrapHttpRes = await handleSalvagePartsPost(
      new Request('http://localhost/api/salvage/parts', {
        method: 'POST',
        headers: { 'Idempotency-Key': scrapKey },
        body: scrapForm,
      }),
      routeDeps,
    );
    expect(scrapHttpRes.status).toBe(201);
    const scrapBody = (await scrapHttpRes.json()) as { scrapLogId: string };

    const historyRes = await handleSalvagePartsGet(
      new Request('http://localhost/api/salvage/parts?view=scrap-history'),
      routeDeps,
    );
    expect(historyRes.status).toBe(200);
    expect(historyRes.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0',
    );
    const historyJson = (await historyRes.json()) as {
      scrapLogs: Array<Record<string, unknown>>;
    };
    expect(historyJson.scrapLogs[0]?.recyclerTicketStorageKey).toBeUndefined();
    expect(historyJson.scrapLogs[0]?.presignedUrl).toBeUndefined();

    const ticketRes = await handleSalvagePartsGet(
      new Request(
        `http://localhost/api/salvage/parts?view=ticket&scrapLogId=${scrapBody.scrapLogId}`,
      ),
      routeDeps,
    );
    expect(ticketRes.status).toBe(200);
    expect(ticketRes.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0',
    );
    const ticketJson = (await ticketRes.json()) as {
      presignedUrl: string;
      ttlSeconds: number;
    };
    expect(ticketJson.ttlSeconds).toBeLessThanOrEqual(900);
    expect(ticketJson.presignedUrl).toContain('private-r2.storage.invalid');

    // Unknown GET query param rejected
    const badQuery = await handleSalvagePartsGet(
      new Request('http://localhost/api/salvage/parts?view=donors&foo=bar'),
      routeDeps,
    );
    expect(badQuery.status).toBe(400);

    // Production composition smoke test: exercises real createPrismaPartStripRepository + withTenantTransaction
    const seenSql: string[] = [];
    const mockPrisma = {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        const fakeTx = {
          $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            seenSql.push(sql);
            if (sql.includes('current_org_id')) {
              return [{ orgId: ORG_SALVAGE }];
            }
            return [];
          },
          vehicle: { findMany: async () => [] },
        };
        return fn(fakeTx);
      },
    } as unknown as PrismaClient;

    const prodUseCase = createProductionStripPartUseCase({
      prisma: mockPrisma,
      storage,
    });
    const prodDonors = await prodUseCase.listDonors(stripperSession);
    expect(prodDonors).toEqual([]);
    expect(seenSql.some((s) => s.includes('set_config'))).toBe(true);
    expect(seenSql.some((s) => s.includes('current_org_id'))).toBe(true);
  });
});
