import { createHash } from 'node:crypto';
import type {
  AraConditionGradeEnum,
  AssetCategory,
  ClassifiedsSyncState,
  EbaySyncState,
  InventoryAvailabilityState,
  PartComplianceState,
  PartCustodyState,
  SteeringSideCompatibility,
  TdgHazmatCode,
} from '@prisma/client';
import { z } from 'zod';
import { DomainRuleError } from '@/core/domain';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { isValidUuid } from '@/modules/shared-ops/auth/auth.contracts';
import type {
  FitmentResolutionSource,
  NormalizedVehicleFitmentTuple,
  PublicMediaAssetClassification,
  ResolvedPrice,
} from './syndication-input-resolver';

export const SYNDICATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const RESERVED_URGENT_DELIST_QUEUE_SLUG =
  '__urgent-delist-queue__' as const;

export const ISSUE10_SYNDICATION_RECEIPT_NAMESPACE =
  'a1f2b3c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c' as const;

export const SYNDICATION_AUDIT_ACTIONS = {
  EBAY_CSV_EXPORTED: 'EBAY_SELLER_HUB_CSV_EXPORTED',
  EBAY_LISTING_CONFIRMED_LIVE: 'EBAY_LISTING_CONFIRMED_LIVE',
  CLASSIFIEDS_POSTED_LIVE: 'CLASSIFIEDS_POSTED_LIVE',
  MANUAL_CHANNEL_DELISTED: 'MANUAL_CHANNEL_DELIST_CONFIRMED',
} as const;

export type SyndicationErrorCode =
  | 'INVALID_SYNDICATION_INPUT'
  | 'PART_NOT_FOUND'
  | 'EXPORT_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VERSION_CONFLICT'
  | 'DUPLICATE_EBAY_LISTING_ID'
  | 'NO_ELIGIBLE_PARTS_FOR_EXPORT'
  | 'PART_IN_RETURN_QC_HOLD'
  | 'B2B_POWERTRAIN_INELIGIBLE'
  | 'SYNDICATION_INTEGRITY_ERROR';

export type SyndicationErrorStatus = 400 | 404 | 409 | 422 | 500;

const ERROR_STATUS_BY_CODE: Readonly<
  Record<SyndicationErrorCode, SyndicationErrorStatus>
> = {
  INVALID_SYNDICATION_INPUT: 400,
  PART_NOT_FOUND: 404,
  EXPORT_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_CONFLICT: 409,
  DUPLICATE_EBAY_LISTING_ID: 409,
  NO_ELIGIBLE_PARTS_FOR_EXPORT: 422,
  PART_IN_RETURN_QC_HOLD: 422,
  B2B_POWERTRAIN_INELIGIBLE: 422,
  SYNDICATION_INTEGRITY_ERROR: 500,
};

export class SyndicationError extends Error {
  public readonly code: SyndicationErrorCode;
  public readonly status: SyndicationErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: SyndicationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'SyndicationError';
    this.code = code;
    this.status = ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface SyndicationClock {
  now(): Date;
}

export interface SyndicationPartRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly donorVehicleId: string;
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
  readonly partCategoryName: string;
  readonly steeringSideCompatibility: SteeringSideCompatibility;
  readonly isHazmatOrAirbag: boolean;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly oemPartNumbers: readonly string[];
  readonly araGrade: AraConditionGradeEnum;
  readonly araDamageCode: string;
  readonly weightKg: number;
  readonly rawPhotoUrls: readonly string[];
  readonly cleanPhotoUrls: readonly string[];
  readonly compBaselineCadMinor: number | null;
  readonly retailPriceCadMinor: number | null;
  readonly ebayListingId: string | null;
  readonly ebayTitle: string | null;
  readonly ebayCompatibilityJson: unknown;
  readonly hasActiveSale: boolean;
  readonly version: number;
  readonly donorVehicle: {
    readonly id: string;
    readonly organizationId: string;
    readonly assetCategory: AssetCategory;
    readonly year: number;
    readonly make: string;
    readonly model: string;
    readonly trim: string | null;
    readonly engineSpec: string | null;
    readonly vinOrHin: string;
    readonly odometerKm: number | null;
    readonly engineHours: number | null;
  };
}

export interface StoredSyndicationReceipt {
  readonly auditId: string;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly result: unknown;
}

export interface PersistSyndicationAuditInput {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly previousState: Readonly<Record<string, unknown>> | null;
  readonly nextState: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface SyndicationTx {
  acquireOrganizationLock(organizationId: string): Promise<void>;
  readOrganizationPolicyRecord(organizationId: string): Promise<{
    organizationId: string;
    policyConfigJson: unknown;
  } | null>;
  findCommandReceipt(
    organizationId: string,
    receiptAuditId: string,
  ): Promise<StoredSyndicationReceipt | null>;
  findCommittedExportReceiptByExportId(
    organizationId: string,
    exportId: string,
  ): Promise<ExportEbayCsvResult | null>;
  findPartsForSyndication(
    organizationId: string,
    filter?: {
      readonly partIds?: readonly string[];
      readonly qrSkuCodeOrId?: string;
    },
  ): Promise<readonly SyndicationPartRecord[]>;
  lockPartsByIds(
    organizationId: string,
    partIds: readonly string[],
  ): Promise<readonly SyndicationPartRecord[]>;
  ebayListingIdExists(
    ebayListingId: string,
    excludePartId?: string,
  ): Promise<boolean>;
  updatePartSyndicationState(input: {
    readonly organizationId: string;
    readonly partId: string;
    readonly expectedVersion: number;
    readonly nextVersion: number;
    readonly ebaySyncState?: EbaySyncState;
    readonly classifiedsSyncState?: ClassifiedsSyncState;
    readonly ebayListingId?: string | null;
    readonly ebayTitle?: string | null;
    readonly updatedAt: Date;
  }): Promise<boolean>;
  listUrgentDelistParts(
    organizationId: string,
  ): Promise<readonly SyndicationPartRecord[]>;
  insertAuditLog(record: PersistSyndicationAuditInput): Promise<void>;
}

export interface SyndicationRepository {
  withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: SyndicationTx) => Promise<T>,
  ): Promise<T>;
}

export interface ExportPartProvenance {
  readonly partId: string;
  readonly qrSkuCode: string;
  readonly previousVersion: number;
  readonly nextVersion: number;
  readonly ebaySeoTitle80: string;
  readonly resolvedPrice: ResolvedPrice;
  readonly mediaSource: 'CLEAN_PHOTO_URLS' | 'RAW_PHOTO_URLS' | 'NONE';
  readonly mediaClassification: PublicMediaAssetClassification;
  readonly sanitizedPublicImageUrls: readonly string[];
  readonly fitmentSource: FitmentResolutionSource;
  readonly compatibleVehicles: readonly NormalizedVehicleFitmentTuple[];
  readonly ebayCategoryId: string;
  readonly conditionId: string;
}

export interface ExportEbayCsvResult {
  readonly exportId: string;
  readonly organizationId: string;
  readonly format: 'EBAY_CSV';
  readonly csvContent: string;
  readonly exportedPartIds: readonly string[];
  readonly exportedSkus: readonly string[];
  readonly mappingVersion: string;
  readonly csvFormatVersion: string;
  readonly policyHash: string;
  readonly partProvenance: readonly ExportPartProvenance[];
  readonly auditLogId: string;
  readonly createdAt: string;
}

export interface PreviewEbayCsvResult {
  readonly isPreview: true;
  readonly persistedMutation: false;
  readonly organizationId: string;
  readonly csvContent: string;
  readonly eligiblePartIds: readonly string[];
  readonly eligibleSkus: readonly string[];
  readonly ineligibleParts: ReadonlyArray<{
    readonly partId: string;
    readonly qrSkuCode: string;
    readonly reasonCode: string;
    readonly reasonMessage: string;
  }>;
  readonly mappingVersion: string;
  readonly csvFormatVersion: string;
}

export interface B2bPowertrainItemSummary {
  readonly partId: string;
  readonly qrSkuCode: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly engineSpec: string | null;
  readonly odometerKm: number | null;
  readonly partCategoryName: string;
  readonly oemPartNumbers: readonly string[];
  readonly araGrade: AraConditionGradeEnum;
  readonly initialMechanicAskCadMinor: number;
  readonly resolvedPrice: ResolvedPrice;
  readonly publicPickupLocationLabel: string;
}

export interface ExportB2bPowertrainSheetResult {
  readonly organizationId: string;
  readonly format: 'B2B_POWERTRAIN';
  readonly persistedMutation: false;
  readonly publicPickupLocationLabel: string;
  readonly whatsappMarkdownText: string;
  readonly csvContent: string;
  readonly items: readonly B2bPowertrainItemSummary[];
}

export interface ConfirmEbayListingLiveResult {
  readonly partId: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly ebayListingId: string;
  readonly ebaySyncState: EbaySyncState;
  readonly version: number;
  readonly auditLogId: string;
  readonly provenanceClassification: 'OPERATOR_ASSERTION';
}

export interface LocalAdPayload {
  readonly partId: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly title: string;
  readonly body: string;
  readonly askCadMinor: number;
  readonly resolvedPrice: ResolvedPrice;
  readonly publicPickupLocationLabel: string;
  readonly sanitizedPublicImageUrls: readonly string[];
  readonly mediaClassification: PublicMediaAssetClassification;
  readonly isLocalPickupOnly: boolean;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly araGrade: AraConditionGradeEnum;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly ebaySyncState: EbaySyncState;
  readonly donorVehicle: {
    readonly year: number;
    readonly make: string;
    readonly model: string;
    readonly trim: string | null;
    readonly engineSpec: string | null;
    readonly odometerKm: number | null;
  };
  readonly version: number;
}

export interface ClassifiedsStateUpdateResult {
  readonly partId: string;
  readonly organizationId: string;
  readonly qrSkuCode: string;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly version: number;
  readonly auditLogId: string;
}

export interface UrgentDelistQueueItem {
  readonly partId: string;
  readonly qrSkuCode: string;
  readonly partCategoryName: string;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly ebayListingId: string | null;
  readonly ebayTitle: string | null;
  readonly version: number;
}

export interface UrgentDelistQueueResult {
  readonly organizationId: string;
  readonly items: readonly UrgentDelistQueueItem[];
  readonly classifiedsConfirmationNotice: string;
}

export const ExportEbayCsvCommandSchema = z
  .object({
    partIds: z.array(z.string().uuid()).max(200).optional(),
    format: z.enum(['EBAY_CSV', 'B2B_POWERTRAIN']).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const ConfirmEbayLiveCommandSchema = z
  .object({
    action: z.literal('confirm-live').optional(),
    partId: z.string().uuid(),
    ebayListingId: z.string().trim().min(1).max(128),
    expectedVersion: z.number().int().positive().optional(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export const LocalQueuePatchSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('mark-posted'),
      expectedVersion: z.number().int().positive().optional(),
      idempotencyKey: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('confirm-manual-delist'),
      channel: z.enum(['EBAY', 'LOCAL_CLASSIFIEDS']),
      expectedVersion: z.number().int().positive().optional(),
      idempotencyKey: z.string().uuid(),
    })
    .strict(),
]);

export function deriveSyndicationReceiptId(
  organizationId: string,
  idempotencyKey: string,
): string {
  if (!isValidUuid(organizationId) || !isValidUuid(idempotencyKey)) {
    throw new SyndicationError(
      'INVALID_SYNDICATION_INPUT',
      'organizationId and idempotencyKey must be valid UUIDs.',
    );
  }
  const digest = createHash('sha256')
    .update(
      `${ISSUE10_SYNDICATION_RECEIPT_NAMESPACE}:${organizationId.toLowerCase()}:${idempotencyKey.toLowerCase()}`,
    )
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export function computeSyndicationCommandFingerprint(params: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly payload: unknown;
}): string {
  const canonical = JSON.stringify({
    organizationId: params.organizationId.toLowerCase(),
    actorUserId: params.actorUserId.toLowerCase(),
    action: params.action,
    payload: params.payload,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function mapSyndicationDomainError(error: unknown): never {
  if (error instanceof DomainRuleError) {
    throw error;
  }
  throw error;
}
