import type {
  AraConditionGradeEnum,
  AssetCategory,
  ClassifiedsSyncState,
  EbaySyncState,
  InventoryAvailabilityState,
  PartComplianceState,
  PartCustodyState,
  Prisma,
  PrismaClient,
  SteeringSideCompatibility,
  TdgHazmatCode,
} from '@prisma/client';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { withTenantTransaction } from '@/infrastructure/db/tenant-transaction';
import { translateTenantContextError } from '@/modules/shared-ops/auth';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import { EbayCsvExporterUseCase } from './ebay-csv-exporter.use-case';
import { LocalClassifiedsQueueUseCase } from './local-classifieds-queue.use-case';
import {
  type ExportEbayCsvResult,
  type PersistSyndicationAuditInput,
  type StoredSyndicationReceipt,
  SYNDICATION_AUDIT_ACTIONS,
  type SyndicationPartRecord,
  type SyndicationRepository,
  type SyndicationTx,
} from './syndication.contracts';

function organizationAdvisoryLockKeys(organizationId: string): [number, number] {
  const hex = organizationId.replace(/-/g, '').toLowerCase();
  const key1 = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const key2 = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [key1, key2];
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseReceipt(
  auditId: string,
  nextState: unknown,
): StoredSyndicationReceipt | null {
  if (!isPlainRecord(nextState)) {
    return null;
  }
  if (
    typeof nextState.action !== 'string' ||
    typeof nextState.idempotencyKey !== 'string' ||
    typeof nextState.commandFingerprint !== 'string' ||
    nextState.result === undefined
  ) {
    return null;
  }
  return {
    auditId: auditId.toLowerCase(),
    action: nextState.action,
    idempotencyKey: nextState.idempotencyKey,
    commandFingerprint: nextState.commandFingerprint,
    result: nextState.result,
  };
}

interface RawPartWithDonor {
  id: string;
  organizationId: string;
  qrSkuCode: string;
  donorVehicleId: string;
  custodyState: PartCustodyState;
  availabilityState: InventoryAvailabilityState;
  ebaySyncState: EbaySyncState;
  classifiedsSyncState: ClassifiedsSyncState;
  complianceState: PartComplianceState;
  partCategoryName: string;
  steeringSideCompatibility: SteeringSideCompatibility;
  isHazmatOrAirbag: boolean;
  tdgHazmatCode: TdgHazmatCode;
  oemPartNumbers: string[];
  araGrade: AraConditionGradeEnum;
  araDamageCode: string;
  weightKg: Prisma.Decimal | number | string;
  rawPhotoUrls: string[];
  cleanPhotoUrls: string[];
  compBaselineCadMinor: number | null;
  retailPriceCadMinor: number | null;
  ebayListingId: string | null;
  ebayTitle: string | null;
  ebayCompatibilityJson: unknown;
  version: number;
  donorId: string;
  donorOrgId: string;
  donorAssetCategory: AssetCategory;
  donorYear: number;
  donorMake: string;
  donorModel: string;
  donorTrim: string | null;
  donorEngineSpec: string | null;
  donorVinOrHin: string;
  donorOdometerKm: number | null;
  donorEngineHours: number | null;
}

async function mapPartRowsWithActiveSale(
  tx: Prisma.TransactionClient,
  organizationId: string,
  rows: readonly RawPartWithDonor[],
): Promise<readonly SyndicationPartRecord[]> {
  if (rows.length === 0) {
    return [];
  }
  const partIds = rows.map((r) => r.id);
  const activeSales = await tx.saleTransactionPartItem.findMany({
    where: {
      organizationId,
      partId: { in: partIds },
      isActiveSale: true,
    },
    select: { partId: true },
  });
  const activeSaleSet = new Set(activeSales.map((s) => s.partId.toLowerCase()));

  return rows.map((row) => ({
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    qrSkuCode: row.qrSkuCode,
    donorVehicleId: row.donorVehicleId.toLowerCase(),
    custodyState: row.custodyState,
    availabilityState: row.availabilityState,
    ebaySyncState: row.ebaySyncState,
    classifiedsSyncState: row.classifiedsSyncState,
    complianceState: row.complianceState,
    partCategoryName: row.partCategoryName,
    steeringSideCompatibility: row.steeringSideCompatibility,
    isHazmatOrAirbag: row.isHazmatOrAirbag,
    tdgHazmatCode: row.tdgHazmatCode,
    oemPartNumbers: row.oemPartNumbers ?? [],
    araGrade: row.araGrade,
    araDamageCode: row.araDamageCode,
    weightKg: Number(row.weightKg),
    rawPhotoUrls: row.rawPhotoUrls ?? [],
    cleanPhotoUrls: row.cleanPhotoUrls ?? [],
    compBaselineCadMinor: row.compBaselineCadMinor,
    retailPriceCadMinor: row.retailPriceCadMinor,
    ebayListingId: row.ebayListingId,
    ebayTitle: row.ebayTitle,
    ebayCompatibilityJson: row.ebayCompatibilityJson,
    hasActiveSale: activeSaleSet.has(row.id.toLowerCase()),
    version: row.version,
    donorVehicle: {
      id: row.donorId.toLowerCase(),
      organizationId: row.donorOrgId.toLowerCase(),
      assetCategory: row.donorAssetCategory,
      year: row.donorYear,
      make: row.donorMake,
      model: row.donorModel,
      trim: row.donorTrim,
      engineSpec: row.donorEngineSpec,
      vinOrHin: row.donorVinOrHin,
      odometerKm: row.donorOdometerKm,
      engineHours: row.donorEngineHours,
    },
  }));
}

export function createPrismaSyndicationRepository(options?: {
  readonly prisma?: PrismaClient;
}): SyndicationRepository {
  const explicitPrisma = options?.prisma;

  return {
    async withTenantTransaction<T>(
      ctx: TenantExecutionContext,
      fn: (tx: SyndicationTx) => Promise<T>,
    ): Promise<T> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);
      try {
        return await withTenantTransaction(prismaClient, ctx, async (tx) => {
          const txAdapter: SyndicationTx = {
            async acquireOrganizationLock(organizationId: string): Promise<void> {
              const [k1, k2] = organizationAdvisoryLockKeys(organizationId);
              await tx.$queryRaw<Array<{ locked: string }>>`
                SELECT pg_advisory_xact_lock(${k1}::int, ${k2}::int)::text AS "locked"
              `;
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

            async findCommandReceipt(
              organizationId: string,
              receiptAuditId: string,
            ): Promise<StoredSyndicationReceipt | null> {
              const audit = await tx.auditLog.findFirst({
                where: {
                  organizationId,
                  id: receiptAuditId,
                },
                select: {
                  id: true,
                  nextState: true,
                },
              });
              if (!audit) {
                return null;
              }
              return parseReceipt(audit.id, audit.nextState);
            },

            async findCommittedExportReceiptByExportId(
              organizationId: string,
              exportId: string,
            ): Promise<ExportEbayCsvResult | null> {
              const audit = await tx.auditLog.findFirst({
                where: {
                  organizationId,
                  entityType: 'SyndicationExport',
                  entityId: exportId,
                  action: SYNDICATION_AUDIT_ACTIONS.EBAY_CSV_EXPORTED,
                },
                select: {
                  nextState: true,
                },
              });
              if (!audit || !isPlainRecord(audit.nextState)) {
                return null;
              }
              const result = audit.nextState.result;
              if (!isPlainRecord(result) || typeof result.csvContent !== 'string') {
                return null;
              }
              return result as unknown as ExportEbayCsvResult;
            },

            async findPartsForSyndication(organizationId, filter) {
              const where: Prisma.PartWhereInput = { organizationId };
              if (filter?.partIds && filter.partIds.length > 0) {
                where.id = { in: [...filter.partIds] };
              } else if (filter?.qrSkuCodeOrId) {
                const candidate: string = filter.qrSkuCodeOrId;
                if (isValidUuid(candidate as unknown)) {
                  where.id = candidate.toLowerCase();
                } else {
                  where.qrSkuCode = candidate.toUpperCase();
                }
              }

              const parts = await tx.part.findMany({
                where,
                orderBy: [{ strippedAt: 'asc' }, { id: 'asc' }],
                include: {
                  donorVehicle: true,
                },
              });

              const rawRows: RawPartWithDonor[] = parts.map((p) => ({
                id: p.id,
                organizationId: p.organizationId,
                qrSkuCode: p.qrSkuCode,
                donorVehicleId: p.donorVehicleId,
                custodyState: p.custodyState,
                availabilityState: p.availabilityState,
                ebaySyncState: p.ebaySyncState,
                classifiedsSyncState: p.classifiedsSyncState,
                complianceState: p.complianceState,
                partCategoryName: p.partCategoryName,
                steeringSideCompatibility: p.steeringSideCompatibility,
                isHazmatOrAirbag: p.isHazmatOrAirbag,
                tdgHazmatCode: p.tdgHazmatCode,
                oemPartNumbers: p.oemPartNumbers,
                araGrade: p.araGrade,
                araDamageCode: p.araDamageCode,
                weightKg: p.weightKg,
                rawPhotoUrls: p.rawPhotoUrls,
                cleanPhotoUrls: p.cleanPhotoUrls,
                compBaselineCadMinor: p.compBaselineCadMinor,
                retailPriceCadMinor: p.retailPriceCadMinor,
                ebayListingId: p.ebayListingId,
                ebayTitle: p.ebayTitle,
                ebayCompatibilityJson: p.ebayCompatibilityJson,
                version: p.version,
                donorId: p.donorVehicle.id,
                donorOrgId: p.donorVehicle.organizationId,
                donorAssetCategory: p.donorVehicle.assetCategory,
                donorYear: p.donorVehicle.year,
                donorMake: p.donorVehicle.make,
                donorModel: p.donorVehicle.model,
                donorTrim: p.donorVehicle.trim,
                donorEngineSpec: p.donorVehicle.engineSpec,
                donorVinOrHin: p.donorVehicle.vinOrHin,
                donorOdometerKm: p.donorVehicle.odometerKm,
                donorEngineHours: p.donorVehicle.engineHours,
              }));

              return mapPartRowsWithActiveSale(tx, organizationId, rawRows);
            },

            async lockPartsByIds(organizationId, partIds) {
              if (partIds.length === 0) {
                return [];
              }
              const sortedIds = [...partIds].map((id) => id.toLowerCase()).sort();
              const rawRows = await tx.$queryRaw<RawPartWithDonor[]>`
                SELECT
                  p."id"::text AS "id",
                  p."organizationId"::text AS "organizationId",
                  p."qrSkuCode",
                  p."donorVehicleId"::text AS "donorVehicleId",
                  p."custodyState"::text AS "custodyState",
                  p."availabilityState"::text AS "availabilityState",
                  p."ebaySyncState"::text AS "ebaySyncState",
                  p."classifiedsSyncState"::text AS "classifiedsSyncState",
                  p."complianceState"::text AS "complianceState",
                  p."partCategoryName",
                  p."steeringSideCompatibility"::text AS "steeringSideCompatibility",
                  p."isHazmatOrAirbag",
                  p."tdgHazmatCode"::text AS "tdgHazmatCode",
                  p."oemPartNumbers",
                  p."araGrade"::text AS "araGrade",
                  p."araDamageCode",
                  p."weightKg",
                  p."rawPhotoUrls",
                  p."cleanPhotoUrls",
                  p."compBaselineCadMinor",
                  p."retailPriceCadMinor",
                  p."ebayListingId",
                  p."ebayTitle",
                  p."ebayCompatibilityJson",
                  p."version",
                  v."id"::text AS "donorId",
                  v."organizationId"::text AS "donorOrgId",
                  v."assetCategory"::text AS "donorAssetCategory",
                  v."year" AS "donorYear",
                  v."make" AS "donorMake",
                  v."model" AS "donorModel",
                  v."trim" AS "donorTrim",
                  v."engineSpec" AS "donorEngineSpec",
                  v."vinOrHin" AS "donorVinOrHin",
                  v."odometerKm" AS "donorOdometerKm",
                  v."engineHours" AS "donorEngineHours"
                FROM "salvage"."Part" p
                INNER JOIN "salvage"."Vehicle" v
                  ON v."organizationId" = p."organizationId"
                 AND v."id" = p."donorVehicleId"
                WHERE p."organizationId" = ${organizationId}::uuid
                  AND p."id" = ANY(${sortedIds}::uuid[])
                ORDER BY p."id" ASC
                FOR UPDATE OF p
              `;
              return mapPartRowsWithActiveSale(tx, organizationId, rawRows);
            },

            async ebayListingIdExists(
              ebayListingId: string,
              excludePartId?: string,
            ): Promise<boolean> {
              const existing = await tx.part.findFirst({
                where: {
                  ebayListingId,
                  ...(excludePartId ? { id: { not: excludePartId } } : {}),
                },
                select: { id: true },
              });
              return existing !== null;
            },

            async updatePartSyndicationState(input): Promise<boolean> {
              const data: Prisma.PartUpdateManyMutationInput = {
                version: input.nextVersion,
                updatedAt: input.updatedAt,
              };
              if (input.ebaySyncState !== undefined) {
                data.ebaySyncState = input.ebaySyncState;
              }
              if (input.classifiedsSyncState !== undefined) {
                data.classifiedsSyncState = input.classifiedsSyncState;
              }
              if (input.ebayListingId !== undefined) {
                data.ebayListingId = input.ebayListingId;
              }
              if (input.ebayTitle !== undefined) {
                data.ebayTitle = input.ebayTitle;
              }
              const res = await tx.part.updateMany({
                where: {
                  id: input.partId,
                  organizationId: input.organizationId,
                  version: input.expectedVersion,
                },
                data,
              });
              return res.count === 1;
            },

            async listUrgentDelistParts(organizationId: string) {
              const parts = await tx.part.findMany({
                where: {
                  organizationId,
                  OR: [
                    { ebaySyncState: 'DELIST_PENDING' },
                    { classifiedsSyncState: 'DELIST_REQUIRED' },
                  ],
                },
                orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                include: {
                  donorVehicle: true,
                },
              });
              const rawRows: RawPartWithDonor[] = parts.map((p) => ({
                id: p.id,
                organizationId: p.organizationId,
                qrSkuCode: p.qrSkuCode,
                donorVehicleId: p.donorVehicleId,
                custodyState: p.custodyState,
                availabilityState: p.availabilityState,
                ebaySyncState: p.ebaySyncState,
                classifiedsSyncState: p.classifiedsSyncState,
                complianceState: p.complianceState,
                partCategoryName: p.partCategoryName,
                steeringSideCompatibility: p.steeringSideCompatibility,
                isHazmatOrAirbag: p.isHazmatOrAirbag,
                tdgHazmatCode: p.tdgHazmatCode,
                oemPartNumbers: p.oemPartNumbers,
                araGrade: p.araGrade,
                araDamageCode: p.araDamageCode,
                weightKg: p.weightKg,
                rawPhotoUrls: p.rawPhotoUrls,
                cleanPhotoUrls: p.cleanPhotoUrls,
                compBaselineCadMinor: p.compBaselineCadMinor,
                retailPriceCadMinor: p.retailPriceCadMinor,
                ebayListingId: p.ebayListingId,
                ebayTitle: p.ebayTitle,
                ebayCompatibilityJson: p.ebayCompatibilityJson,
                version: p.version,
                donorId: p.donorVehicle.id,
                donorOrgId: p.donorVehicle.organizationId,
                donorAssetCategory: p.donorVehicle.assetCategory,
                donorYear: p.donorVehicle.year,
                donorMake: p.donorVehicle.make,
                donorModel: p.donorVehicle.model,
                donorTrim: p.donorVehicle.trim,
                donorEngineSpec: p.donorVehicle.engineSpec,
                donorVinOrHin: p.donorVehicle.vinOrHin,
                donorOdometerKm: p.donorVehicle.odometerKm,
                donorEngineHours: p.donorVehicle.engineHours,
              }));
              return mapPartRowsWithActiveSale(tx, organizationId, rawRows);
            },

            async insertAuditLog(
              record: PersistSyndicationAuditInput,
            ): Promise<void> {
              await tx.auditLog.create({
                data: {
                  id: record.id,
                  organizationId: record.organizationId,
                  actorUserId: record.actorUserId,
                  entityType: record.entityType,
                  entityId: record.entityId,
                  action: record.action,
                  previousState: record.previousState as Prisma.InputJsonValue,
                  nextState: record.nextState as Prisma.InputJsonValue,
                  createdAt: record.createdAt,
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

export function createProductionEbayCsvExporterUseCase(options?: {
  readonly prisma?: PrismaClient;
  readonly publicMediaOrigin?: string;
}): EbayCsvExporterUseCase {
  return new EbayCsvExporterUseCase({
    repository: createPrismaSyndicationRepository({ prisma: options?.prisma }),
    publicMediaOrigin: options?.publicMediaOrigin,
  });
}

export function createProductionLocalClassifiedsQueueUseCase(options?: {
  readonly prisma?: PrismaClient;
  readonly publicMediaOrigin?: string;
}): LocalClassifiedsQueueUseCase {
  return new LocalClassifiedsQueueUseCase({
    repository: createPrismaSyndicationRepository({ prisma: options?.prisma }),
    publicMediaOrigin: options?.publicMediaOrigin,
  });
}
