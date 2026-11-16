import { createHash, randomUUID } from 'node:crypto';
import type {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  CurrencyCode,
  ExpenseCategory,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  ReceiptVerificationState,
  RoadVehicleBrand,
  StatutoryVehiclePurpose,
  SteeringSideCompatibility,
  VehicleAcquisitionSource,
} from '@prisma/client';
import { z } from 'zod';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import {
  type ComplianceEnforcementMode,
  computeDriveOnTimers,
  type EasrSiteVehicleCandidate,
  evaluateEasrElvThreshold,
  evaluateRegulatoryComplianceCheck,
  evaluateWorkingCapitalGate,
  type SeparatedFinancialSnapshot,
  type WorkingCapitalPolicySlice,
} from '@/core/domain';
import type { DecodedAssetSpec, PricingAndCompliancePolicy } from '@/core/ports';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import {
  assertCapability,
  assertCfoOverrideAuthority,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import {
  assertTrustedAuthSession,
  isValidUuid,
} from '@/modules/shared-ops/auth/auth.contracts';
import {
  LocationCustodyError,
  LocationZoningService,
  mergeComplianceWarnings,
} from '@/modules/shared-ops/locations-qr/location-zoning.service';
import { validateCanonicalTagCode } from '@/modules/shared-ops/locations-qr/qr-tag-sheet-and-zpl.generator';
import { assertValidPrivateEvidenceKey } from '@/modules/shared-ops/storage/storage.service';
import {
  type AssetDecoderFactory,
  createCategoryAssetDecoderFactory,
  isValidAutomobileVin,
  isValidEquipmentSerial,
  normalizeAssetIdentifier,
  parseWatercraftHin,
} from './asset-decoder.adapter';

export const VEHICLE_INTAKE_AUDIT_ENTITY_TYPE = 'Vehicle' as const;
export const VEHICLE_INTAKE_AUDIT_ACTION = 'VEHICLE_INTAKEN' as const;
export const EXPENSE_LINKED_AUDIT_ENTITY_TYPE = 'Expense' as const;
export const EXPENSE_LINKED_AUDIT_ACTION = 'EXPENSE_LINKED_TO_VEHICLE' as const;

const PRISMA_INT32_MAX = 2_147_483_647;
const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const HS_CODE_REGEX = /^\d{4}(?:\.\d{2}(?:\.\d{2,4})?)?$/;

export const ACQUISITION_EXPENSE_CATEGORIES = [
  'AUCTION_PURCHASE_PRICE',
  'AUCTION_BUYER_FEE',
  'TOWING_AND_RECOVERY',
] as const;

export type AcquisitionExpenseCategory =
  (typeof ACQUISITION_EXPENSE_CATEGORIES)[number];

export type VehicleIntakeErrorCode =
  | 'INVALID_INTAKE_INPUT'
  | 'ASSET_DECODE_FAILED_MANUAL_REQUIRED'
  | 'SITE_ZONING_VIOLATION'
  | 'LOCATION_DORMANT_INACTIVE'
  | 'LOCATION_PROPOSED_INACTIVE'
  | 'ENVIRONMENTAL_ZONING_VIOLATION'
  | 'LOCATION_CAPACITY_EXCEEDED'
  | 'MISSING_HTA_S60_DOCS'
  | 'EASR_REGISTRATION_REQUIRED'
  | 'WORKING_CAPITAL_RESERVE_BREACHED'
  | 'DONOR_LANDED_CAP_EXCEEDED'
  | 'HIGH_END_REBUILD_LANE_PAUSED'
  | 'CFO_OVERRIDE_REASON_REQUIRED'
  | 'CFO_OVERRIDE_UNAUTHORIZED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'VEHICLE_IDENTIFIER_CONFLICT'
  | 'EXPENSE_ALREADY_LINKED'
  | 'INVALID_EXPENSE_REFERENCE'
  | 'INTAKE_INTEGRITY_ERROR';

export type VehicleIntakeErrorStatus = 400 | 409 | 422 | 500;

const ERROR_STATUS_BY_CODE: Readonly<
  Record<VehicleIntakeErrorCode, VehicleIntakeErrorStatus>
> = {
  INVALID_INTAKE_INPUT: 400,
  ASSET_DECODE_FAILED_MANUAL_REQUIRED: 422,
  SITE_ZONING_VIOLATION: 422,
  LOCATION_DORMANT_INACTIVE: 422,
  LOCATION_PROPOSED_INACTIVE: 422,
  ENVIRONMENTAL_ZONING_VIOLATION: 422,
  LOCATION_CAPACITY_EXCEEDED: 422,
  MISSING_HTA_S60_DOCS: 422,
  EASR_REGISTRATION_REQUIRED: 422,
  WORKING_CAPITAL_RESERVE_BREACHED: 422,
  DONOR_LANDED_CAP_EXCEEDED: 422,
  HIGH_END_REBUILD_LANE_PAUSED: 422,
  CFO_OVERRIDE_REASON_REQUIRED: 422,
  CFO_OVERRIDE_UNAUTHORIZED: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  VEHICLE_IDENTIFIER_CONFLICT: 409,
  EXPENSE_ALREADY_LINKED: 409,
  INVALID_EXPENSE_REFERENCE: 422,
  INTAKE_INTEGRITY_ERROR: 500,
};

export class VehicleIntakeError extends Error {
  public readonly code: VehicleIntakeErrorCode;
  public readonly status: VehicleIntakeErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: VehicleIntakeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'VehicleIntakeError';
    this.code = code;
    this.status = ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface PaidAcquisitionComponentInput {
  readonly category: AcquisitionExpenseCategory;
  readonly vendorName: string;
  readonly description?: string;
  readonly amountCadMinor: number;
  readonly paidFromCashCustody:
    | 'SETTLED_ORIGIN_CORP_BANK'
    | 'HELD_IN_OPERATOR_FLOAT';
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey?: string | null;
  readonly receiptSha256Hash?: string | null;
  readonly voucherReason?: string | null;
  readonly itcReceivableCadMinor?: number;
  readonly incurredAt?: string | Date;
}

export interface IntakeCfoOverrideInput {
  readonly approved: true;
  readonly reasonNote: string;
}

interface IntakeVehicleCommonInput {
  readonly vinOrHin: string;
  readonly modelYearHint?: number;
  readonly year?: number;
  readonly make?: string;
  readonly model?: string;
  readonly trim?: string | null;
  readonly engineSpec?: string | null;
  readonly exteriorColor?: string | null;
  readonly destinationBarcode: string;
  readonly operationalLane: OperationalLane;
  readonly acquisitionSource: VehicleAcquisitionSource;
  readonly declaredStatutoryPurpose: StatutoryVehiclePurpose;
  readonly sellerFullName?: string | null;
  readonly sellerAddress?: string | null;
  readonly sellerPhotoIdStorageKey?: string | null;
  readonly ontarioPermitNumber?: string | null;
  readonly fluidsDrainedAt?: string | Date | null;
  readonly suggestedHsCode?: string;
  readonly estimatedMaxBidCadMinor: number;
  readonly actualPurchasePriceCadMinor: number;
  readonly estimatedRepairCadMinor?: number;
  readonly targetGrossRealizationMinor?: number;
  readonly estimatedDealOutlayCadMinor?: number;
  readonly paidAcquisitionComponents?: readonly PaidAcquisitionComponentInput[];
  readonly existingAcquisitionExpenseIds?: readonly string[];
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string | Date;
  readonly cfoOverride?: IntakeCfoOverrideInput;
}

export interface IntakeAutomobileInput extends IntakeVehicleCommonInput {
  readonly assetCategory: 'AUTOMOBILE';
  readonly roadBrand?: 'NONE' | 'SALVAGE' | 'REBUILT' | 'IRREPARABLE';
  readonly odometerKm?: number | null;
  readonly engineHours?: null;
  readonly catalyticConverterDisposition?: CatalyticConverterDisposition;
  readonly driveOnInitialFailAt?: string | Date | null;
  readonly driveOnFailSheetStorageKey?: string | null;
}

export interface IntakeWatercraftInput extends IntakeVehicleCommonInput {
  readonly assetCategory: 'WATERCRAFT';
  readonly roadBrand?: 'NOT_APPLICABLE';
  readonly odometerKm?: null;
  readonly engineHours?: number | null;
}

export interface IntakeShopEquipmentInput extends IntakeVehicleCommonInput {
  readonly assetCategory: 'SHOP_EQUIPMENT';
  readonly roadBrand?: 'NOT_APPLICABLE';
  readonly odometerKm?: null;
  readonly engineHours?: number | null;
}

export type IntakeVehicleInput =
  | IntakeAutomobileInput
  | IntakeWatercraftInput
  | IntakeShopEquipmentInput;

export interface IntakeVehicleResult {
  readonly replayed: boolean;
  readonly vehicleId: string;
  readonly organizationId: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly vinOrHin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly exteriorColor: string | null;
  readonly steeringSide: SteeringSideCompatibility;
  readonly oemFitmentVerified: boolean;
  readonly roadBrand: RoadVehicleBrand;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly storageLocationId: string;
  readonly destinationBarcode: string;
  readonly suggestedHsCode: string;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly driveOnInitialFailAt: string | null;
  readonly driveOnReinspectionDeadlineAt: string | null;
  readonly estimatedMaxBidCadMinor: number;
  readonly actualPurchasePriceCadMinor: number;
  readonly estimatedRepairCadMinor: number;
  readonly estimatedDealOutlayCadMinor: number;
  readonly createdExpenseIds: readonly string[];
  readonly linkedExpenseIds: readonly string[];
  readonly custodyEventId: string;
  readonly auditLogId: string;
  readonly complianceWarnings: readonly string[];
  readonly cfoOverrideApplied: boolean;
  readonly cfoGateApprovedById: string | null;
  readonly cfoGateApprovedAt: string | null;
  readonly cfoGateOverrideReason: string | null;
  readonly availableWorkingCapitalBeforeCadMinor: number;
  readonly projectedPostDealCapitalCadMinor: number;
  readonly createdAt: string;
}

export interface SafeVehicleListRow {
  readonly id: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly vinOrHin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly exteriorColor: string | null;
  readonly steeringSide: SteeringSideCompatibility;
  readonly roadBrand: RoadVehicleBrand;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly storageLocationId: string | null;
  readonly destinationBarcode: string | null;
  readonly suggestedHsCode: string;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly complianceWarnings: readonly string[];
  readonly driveOnReinspectionDeadlineAt: string | null;
  readonly fluidsDrainedAt: string | null;
  readonly createdAt: string;
}

export interface ListVehiclesResult {
  readonly scope: 'FULL' | 'STRIP_QUEUE_ONLY' | 'EXPORTED_ONLY';
  readonly vehicles: readonly SafeVehicleListRow[];
}

export interface HtaSection60RegisterRow {
  readonly internalStockNumber: string;
  readonly vinOrHin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly exteriorColor: string | null;
  readonly recordedIntakeDate: string;
  readonly acquisitionSource: VehicleAcquisitionSource;
  readonly sellerFullName: string | null;
  readonly sellerAddress: string | null;
  readonly ontarioPermitNumber: string | null;
  readonly declaredStatutoryPurpose: StatutoryVehiclePurpose;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly lifecycleState: AssetLifecycleState;
  readonly scrappedClearedAt: string | null;
  readonly soldAt: string | null;
  readonly complianceWarnings: readonly string[];
}

export type HtaSection60RegisterResult =
  | {
      readonly format: 'JSON';
      readonly rows: readonly HtaSection60RegisterRow[];
    }
  | {
      readonly format: 'CSV';
      readonly filename: string;
      readonly csvContent: string;
      readonly rows: readonly HtaSection60RegisterRow[];
    };

export interface LockedIntakeStorageLocation {
  readonly id: string;
  readonly organizationId: string;
  readonly allowedOrgType: OrganizationType;
  readonly locationOperationalStatus: LocationOperationalStatus;
  readonly allowsWholeVehicleDismantling: boolean;
  readonly maxActiveAssetCapacity: number | null;
  readonly fullQrBarcode: string;
}

export interface LockedExistingAcquisitionExpense {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string | null;
  readonly category: ExpenseCategory;
  readonly amountCadMinor: number;
  readonly currencyOriginal: CurrencyCode;
  readonly amountOriginalMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody: CashCustodyState | null;
  readonly isDeferredIntercompanyAccrual: boolean;
  readonly accrualSettledAt: Date | null;
  readonly isReversalEntry: boolean;
  readonly hasReversalEntry: boolean;
  readonly alreadyLinkedInAudit: boolean;
}

export interface ExistingIdempotentIntakeRecord {
  readonly custodyEventId: string;
  readonly vehicleId: string | null;
  readonly auditAction: string | null;
  readonly commandFingerprint: string | null;
  readonly intakeResult: IntakeVehicleResult | null;
}

export interface PersistVehicleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly vinOrHin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly odometerKm: number | null;
  readonly engineHours: number | null;
  readonly exteriorColor: string | null;
  readonly steeringSide: SteeringSideCompatibility;
  readonly oemFitmentVerified: boolean;
  readonly roadBrand: RoadVehicleBrand;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly storageLocationId: string;
  readonly acquisitionSource: VehicleAcquisitionSource;
  readonly sellerFullName: string | null;
  readonly sellerAddress: string | null;
  readonly sellerPhotoIdStorageKey: string | null;
  readonly ontarioPermitNumber: string | null;
  readonly declaredStatutoryPurpose: StatutoryVehiclePurpose;
  readonly suggestedHsCode: string;
  readonly estimatedMaxBidCadMinor: number;
  readonly actualPurchasePriceCadMinor: number;
  readonly estimatedRepairCadMinor: number;
  readonly targetGrossRealizationMinor: number;
  readonly cfoGateApprovedById: string | null;
  readonly cfoGateApprovedAt: Date | null;
  readonly cfoGateOverrideReason: string | null;
  readonly driveOnInitialFailAt: Date | null;
  readonly driveOnReinspectionDeadlineAt: Date | null;
  readonly driveOnFailSheetStorageKey: string | null;
  readonly fluidsDrainedAt: Date | null;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly complianceWarnings: readonly string[];
  readonly version: number;
  readonly createdAt: Date;
}

export interface PersistAcquisitionExpenseRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string;
  readonly loggedByUserId: string;
  readonly category: AcquisitionExpenseCategory;
  readonly vendorName: string;
  readonly description: string;
  readonly amountOriginalMinor: number;
  readonly currencyOriginal: CurrencyCode;
  readonly amountCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly paidFromCashCustody: CashCustodyState;
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey: string | null;
  readonly receiptSha256Hash: string | null;
  readonly voucherReason: string | null;
  readonly incurredAt: Date;
  readonly createdAt: Date;
}

export interface PersistInitialCustodyEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly vehicleId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly fromLocationBarcode: null;
  readonly toLocationBarcode: string;
  readonly expectedVersion: 1;
  readonly hasConflict: false;
  readonly complianceWarnings: readonly string[];
  readonly deviceTimestamp: Date;
  readonly serverReceivedAt: Date;
}

export interface PersistIntakeAuditLogRecord {
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

export interface StoredVehicleListProjection {
  readonly id: string;
  readonly internalStockNumber: string;
  readonly assetCategory: AssetCategory;
  readonly vinOrHin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly exteriorColor: string | null;
  readonly steeringSide: SteeringSideCompatibility;
  readonly roadBrand: RoadVehicleBrand;
  readonly operationalLane: OperationalLane;
  readonly lifecycleState: AssetLifecycleState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly storageLocationId: string | null;
  readonly destinationBarcode: string | null;
  readonly suggestedHsCode: string;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly complianceWarnings: readonly string[];
  readonly driveOnReinspectionDeadlineAt: Date | null;
  readonly fluidsDrainedAt: Date | null;
  readonly createdAt: Date;
}

export interface StoredHtaRegisterRow {
  readonly internalStockNumber: string;
  readonly vinOrHin: string;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly exteriorColor: string | null;
  readonly createdAt: Date;
  readonly acquisitionSource: VehicleAcquisitionSource;
  readonly sellerFullName: string | null;
  readonly sellerAddress: string | null;
  readonly ontarioPermitNumber: string | null;
  readonly declaredStatutoryPurpose: StatutoryVehiclePurpose;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly lifecycleState: AssetLifecycleState;
  readonly scrappedClearedAt: Date | null;
  readonly soldAt: Date | null;
  readonly complianceWarnings: readonly string[];
}

export interface IntakeVehicleTx {
  acquireOrganizationLock(organizationId: string): Promise<void>;
  findIdempotentIntake(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<ExistingIdempotentIntakeRecord | null>;
  readOrganizationPolicyRecord(organizationId: string): Promise<{
    organizationId: string;
    policyConfigJson: unknown;
  } | null>;
  findAndLockStorageLocationByBarcode(
    organizationId: string,
    fullQrBarcode: string,
  ): Promise<LockedIntakeStorageLocation | null>;
  findAndLockAcquisitionExpenses(
    organizationId: string,
    expenseIds: readonly string[],
  ): Promise<readonly LockedExistingAcquisitionExpense[]>;
  countActiveVehiclesAtLocation(
    organizationId: string,
    storageLocationId: string,
  ): Promise<number>;
  listActiveAutomobileElvCandidates(
    organizationId: string,
  ): Promise<readonly EasrSiteVehicleCandidate[]>;
  queryFinancialSnapshot(
    organizationId: string,
    policy: WorkingCapitalPolicySlice,
  ): Promise<SeparatedFinancialSnapshot>;
  insertVehicle(input: PersistVehicleRecord): Promise<void>;
  insertExpenses(inputs: readonly PersistAcquisitionExpenseRecord[]): Promise<void>;
  insertCustodyEvent(input: PersistInitialCustodyEventRecord): Promise<void>;
  insertAuditLog(input: PersistIntakeAuditLogRecord): Promise<void>;
  listVehicles(
    organizationId: string,
    filter: {
      readonly scope: 'FULL' | 'STRIP_QUEUE_ONLY' | 'EXPORTED_ONLY';
      readonly limit: number;
    },
  ): Promise<readonly StoredVehicleListProjection[]>;
  listHtaSection60AutomobileRows(
    organizationId: string,
  ): Promise<readonly StoredHtaRegisterRow[]>;
}

export interface IntakeVehicleRepository {
  withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: IntakeVehicleTx) => Promise<T>,
  ): Promise<T>;
}

export interface IntakeClock {
  now(): Date;
}

export interface IntakeVehicleUseCaseDeps {
  readonly repository?: IntakeVehicleRepository;
  readonly decoderFactory?: AssetDecoderFactory;
  readonly zoningService?: LocationZoningService;
  readonly clock?: IntakeClock;
  readonly idGenerator?: () => string;
}

const BoundedNonEmptyString = (maxLen: number, fieldName: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length > 0 && v.length <= maxLen, {
      message: `${fieldName} must be 1..${maxLen} characters.`,
    })
    .refine((v) => !CONTROL_CHARS_REGEX.test(v), {
      message: `${fieldName} must not contain control characters.`,
    });

const BoundedOptionalString = (maxLen: number, fieldName: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length <= maxLen && !CONTROL_CHARS_REGEX.test(v), {
      message: `${fieldName} exceeds ${maxLen} chars or contains control characters.`,
    })
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

const PrismaNonNegativeInt = z
  .number()
  .int()
  .min(0)
  .max(PRISMA_INT32_MAX);

const DateOrIsoSchema = z.union([z.date(), z.string().min(1)]);

const PaidComponentSchema = z
  .object({
    category: z.enum(ACQUISITION_EXPENSE_CATEGORIES),
    vendorName: BoundedNonEmptyString(120, 'vendorName'),
    description: BoundedOptionalString(240, 'description'),
    amountCadMinor: PrismaNonNegativeInt.refine((v) => v > 0, {
      message: 'amountCadMinor must be > 0.',
    }),
    paidFromCashCustody: z.enum([
      'SETTLED_ORIGIN_CORP_BANK',
      'HELD_IN_OPERATOR_FLOAT',
    ]),
    receiptVerificationState: z.enum([
      'VERIFIED_RECEIPT',
      'PETTY_CASH_VOUCHER',
      'PENDING_RECEIPT_UPLOAD',
    ]),
    receiptStorageKey: BoundedOptionalString(255, 'receiptStorageKey'),
    receiptSha256Hash: BoundedOptionalString(128, 'receiptSha256Hash'),
    voucherReason: BoundedOptionalString(240, 'voucherReason'),
    itcReceivableCadMinor: PrismaNonNegativeInt.optional(),
    incurredAt: DateOrIsoSchema.optional(),
  })
  .strict();

const CfoOverrideSchema = z
  .object({
    approved: z.literal(true),
    reasonNote: z.string(),
  })
  .strict();

const CommonIntakeFields = {
  vinOrHin: BoundedNonEmptyString(64, 'vinOrHin'),
  modelYearHint: z.number().int().min(1900).max(2100).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  make: BoundedOptionalString(80, 'make'),
  model: BoundedOptionalString(80, 'model'),
  trim: BoundedOptionalString(80, 'trim'),
  engineSpec: BoundedOptionalString(120, 'engineSpec'),
  exteriorColor: BoundedOptionalString(60, 'exteriorColor'),
  destinationBarcode: BoundedNonEmptyString(80, 'destinationBarcode'),
  operationalLane: z.enum([
    'QUICK_TURN_BEATER',
    'HIGH_END_REBUILD',
    'DISMANTLE_AND_EXPORT',
    'WHOLE_UNIT_EXPORT',
  ]),
  acquisitionSource: z.enum([
    'LICENSED_AUCTION',
    'PRIVATE_DRIVEWAY_BUY',
    'DEALER_WHOLESALE',
    'TRADE_IN',
  ]),
  declaredStatutoryPurpose: z.enum([
    'WRECKING_PARTS_ONLY',
    'RETAIL_RESALE',
    'EXPORT_WHOLE',
  ]),
  sellerFullName: BoundedOptionalString(140, 'sellerFullName'),
  sellerAddress: BoundedOptionalString(240, 'sellerAddress'),
  sellerPhotoIdStorageKey: BoundedOptionalString(255, 'sellerPhotoIdStorageKey'),
  ontarioPermitNumber: BoundedOptionalString(60, 'ontarioPermitNumber'),
  fluidsDrainedAt: DateOrIsoSchema.nullable().optional(),
  suggestedHsCode: BoundedOptionalString(20, 'suggestedHsCode'),
  estimatedMaxBidCadMinor: PrismaNonNegativeInt,
  actualPurchasePriceCadMinor: PrismaNonNegativeInt,
  estimatedRepairCadMinor: PrismaNonNegativeInt.optional(),
  targetGrossRealizationMinor: PrismaNonNegativeInt.optional(),
  estimatedDealOutlayCadMinor: PrismaNonNegativeInt.optional(),
  paidAcquisitionComponents: z.array(PaidComponentSchema).max(20).optional(),
  existingAcquisitionExpenseIds: z.array(z.string()).max(20).optional(),
  idempotencyKey: z.string().min(1),
  deviceTimestamp: DateOrIsoSchema,
  cfoOverride: CfoOverrideSchema.optional(),
};

const AutomobileIntakeSchema = z
  .object({
    assetCategory: z.literal('AUTOMOBILE'),
    ...CommonIntakeFields,
    roadBrand: z
      .enum(['NONE', 'SALVAGE', 'REBUILT', 'IRREPARABLE'])
      .optional(),
    odometerKm: PrismaNonNegativeInt.nullable().optional(),
    engineHours: z.null().optional(),
    catalyticConverterDisposition: z
      .enum([
        'PRESENT_AT_INTAKE',
        'MISSING_AT_INTAKE',
        'LOGGED_SCRAP_SALE',
        'SHELVED_AS_PART',
      ])
      .optional(),
    driveOnInitialFailAt: DateOrIsoSchema.nullable().optional(),
    driveOnFailSheetStorageKey: BoundedOptionalString(
      255,
      'driveOnFailSheetStorageKey',
    ),
  })
  .strict();

const WatercraftIntakeSchema = z
  .object({
    assetCategory: z.literal('WATERCRAFT'),
    ...CommonIntakeFields,
    roadBrand: z.literal('NOT_APPLICABLE').optional(),
    odometerKm: z.null().optional(),
    engineHours: PrismaNonNegativeInt.nullable().optional(),
  })
  .strict();

const ShopEquipmentIntakeSchema = z
  .object({
    assetCategory: z.literal('SHOP_EQUIPMENT'),
    ...CommonIntakeFields,
    roadBrand: z.literal('NOT_APPLICABLE').optional(),
    odometerKm: z.null().optional(),
    engineHours: PrismaNonNegativeInt.nullable().optional(),
  })
  .strict();

const IntakeVehicleInputSchema = z.discriminatedUnion('assetCategory', [
  AutomobileIntakeSchema,
  WatercraftIntakeSchema,
  ShopEquipmentIntakeSchema,
]);

interface NormalizedPaidComponent {
  readonly category: AcquisitionExpenseCategory;
  readonly vendorName: string;
  readonly description: string;
  readonly amountCadMinor: number;
  readonly paidFromCashCustody:
    | 'SETTLED_ORIGIN_CORP_BANK'
    | 'HELD_IN_OPERATOR_FLOAT';
  readonly receiptVerificationState: ReceiptVerificationState;
  readonly receiptStorageKey: string | null;
  readonly receiptSha256Hash: string | null;
  readonly voucherReason: string | null;
  readonly itcReceivableCadMinor: number;
  readonly incurredAt: Date | null;
}

interface NormalizedIntakeInput {
  readonly assetCategory: AssetCategory;
  readonly vinOrHin: string;
  readonly modelYearHint: number | null;
  readonly manualYear: number | null;
  readonly manualMake: string | null;
  readonly manualModel: string | null;
  readonly manualTrim: string | null;
  readonly manualEngineSpec: string | null;
  readonly exteriorColor: string | null;
  readonly destinationBarcode: string;
  readonly operationalLane: OperationalLane;
  readonly roadBrand: RoadVehicleBrand;
  readonly odometerKm: number | null;
  readonly engineHours: number | null;
  readonly acquisitionSource: VehicleAcquisitionSource;
  readonly declaredStatutoryPurpose: StatutoryVehiclePurpose;
  readonly sellerFullName: string | null;
  readonly sellerAddress: string | null;
  readonly sellerPhotoIdStorageKey: string | null;
  readonly ontarioPermitNumber: string | null;
  readonly fluidsDrainedAt: Date | null;
  readonly catalyticConverterDisposition: CatalyticConverterDisposition;
  readonly driveOnInitialFailAt: Date | null;
  readonly driveOnFailSheetStorageKey: string | null;
  readonly suggestedHsCode: string;
  readonly estimatedMaxBidCadMinor: number;
  readonly actualPurchasePriceCadMinor: number;
  readonly estimatedRepairCadMinor: number;
  readonly targetGrossRealizationMinor: number;
  readonly explicitEstimatedDealOutlayCadMinor: number | null;
  readonly paidAcquisitionComponents: readonly NormalizedPaidComponent[];
  readonly existingAcquisitionExpenseIds: readonly string[];
  readonly idempotencyKey: string;
  readonly deviceTimestamp: Date;
  readonly cfoOverrideRequested: boolean;
  readonly cfoOverrideReasonNote: string | null;
}

function parseStrictTimestamp(value: Date | string, fieldName: string): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      `${fieldName} must be a valid ISO timestamp or Date.`,
    );
  }
  return date;
}

function validatePrivateKeyIfPresent(
  key: string | null | undefined,
  organizationId: string,
  fieldName: string,
): string | null {
  if (key === null || key === undefined) {
    return null;
  }
  try {
    return assertValidPrivateEvidenceKey(key, organizationId);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      `${fieldName} must be a valid tenant private evidence key.`,
    );
  }
}

function validateAndNormalizeIntakeInput(
  rawInput: unknown,
  organizationId: string,
): NormalizedIntakeInput {
  const parsed = IntakeVehicleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      `Invalid vehicle intake input: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  const data = parsed.data;
  const vinOrHin = normalizeAssetIdentifier(data.vinOrHin);

  if (data.assetCategory === 'AUTOMOBILE') {
    if (!isValidAutomobileVin(vinOrHin)) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'AUTOMOBILE vinOrHin must be a valid 17-character VIN (excluding I, O, Q).',
      );
    }
  } else if (data.assetCategory === 'WATERCRAFT') {
    if (!parseWatercraftHin(vinOrHin)) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'WATERCRAFT vinOrHin must be a valid 12-character Hull Identification Number (HIN).',
      );
    }
  } else if (!isValidEquipmentSerial(vinOrHin)) {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      'SHOP_EQUIPMENT vinOrHin must be a valid 4..64 character serial number.',
    );
  }

  let destinationBarcode: string;
  try {
    destinationBarcode = validateCanonicalTagCode(data.destinationBarcode);
  } catch {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      'destinationBarcode must be a canonical location QR barcode.',
    );
  }

  if (!isValidUuid(data.idempotencyKey)) {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      'idempotencyKey must be a valid UUID string.',
    );
  }
  const idempotencyKey = data.idempotencyKey.toLowerCase();
  const deviceTimestamp = parseStrictTimestamp(
    data.deviceTimestamp,
    'deviceTimestamp',
  );

  const fluidsDrainedAt =
    data.fluidsDrainedAt !== undefined && data.fluidsDrainedAt !== null
      ? parseStrictTimestamp(data.fluidsDrainedAt, 'fluidsDrainedAt')
      : null;

  const sellerPhotoIdStorageKey = validatePrivateKeyIfPresent(
    data.sellerPhotoIdStorageKey,
    organizationId,
    'sellerPhotoIdStorageKey',
  );

  let driveOnInitialFailAt: Date | null = null;
  let driveOnFailSheetStorageKey: string | null = null;
  if (data.assetCategory === 'AUTOMOBILE') {
    const rawFailAt = data.driveOnInitialFailAt ?? null;
    const rawSheetKey = data.driveOnFailSheetStorageKey ?? null;
    if ((rawFailAt !== null) !== (rawSheetKey !== null)) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'driveOnInitialFailAt and driveOnFailSheetStorageKey must either both be provided or both be null.',
      );
    }
    if (rawFailAt !== null && rawSheetKey !== null) {
      driveOnInitialFailAt = parseStrictTimestamp(
        rawFailAt,
        'driveOnInitialFailAt',
      );
      driveOnFailSheetStorageKey = validatePrivateKeyIfPresent(
        rawSheetKey,
        organizationId,
        'driveOnFailSheetStorageKey',
      );
    }
  }

  let suggestedHsCode: string;
  if (data.assetCategory === 'WATERCRAFT') {
    if (data.suggestedHsCode && data.suggestedHsCode !== '8903.99') {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'WATERCRAFT assets must use tariff classification 8903.99.',
      );
    }
    suggestedHsCode = '8903.99';
  } else if (data.assetCategory === 'SHOP_EQUIPMENT') {
    if (data.suggestedHsCode && data.suggestedHsCode !== '8479.89') {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'SHOP_EQUIPMENT assets must use tariff classification 8479.89.',
      );
    }
    suggestedHsCode = '8479.89';
  } else {
    if (data.suggestedHsCode) {
      if (
        data.suggestedHsCode === '8903.99' ||
        !HS_CODE_REGEX.test(data.suggestedHsCode)
      ) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          'AUTOMOBILE suggestedHsCode must be a valid automotive HS subheading (and cannot inherit default 8903.99).',
        );
      }
      suggestedHsCode = data.suggestedHsCode;
    } else {
      suggestedHsCode =
        data.operationalLane === 'DISMANTLE_AND_EXPORT' ? '8708.99' : '8703.23';
    }
  }

  const paidAcquisitionComponents: NormalizedPaidComponent[] = (
    data.paidAcquisitionComponents ?? []
  ).map((comp, idx) => {
    const receiptStorageKey = validatePrivateKeyIfPresent(
      comp.receiptStorageKey,
      organizationId,
      `paidAcquisitionComponents[${idx}].receiptStorageKey`,
    );
    const itc = comp.itcReceivableCadMinor ?? 0;

    if (comp.receiptVerificationState === 'VERIFIED_RECEIPT') {
      if (!receiptStorageKey) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `paidAcquisitionComponents[${idx}] with VERIFIED_RECEIPT requires receiptStorageKey.`,
        );
      }
    } else {
      if (!comp.voucherReason || comp.voucherReason.trim().length < 5) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `paidAcquisitionComponents[${idx}] with ${comp.receiptVerificationState} requires voucherReason (>= 5 chars).`,
        );
      }
      if (itc !== 0) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `paidAcquisitionComponents[${idx}] cannot claim itcReceivableCadMinor without VERIFIED_RECEIPT.`,
        );
      }
    }

    return {
      category: comp.category,
      vendorName: comp.vendorName,
      description:
        comp.description ??
        `Acquisition ${comp.category.toLowerCase()} for ${vinOrHin}`,
      amountCadMinor: comp.amountCadMinor,
      paidFromCashCustody: comp.paidFromCashCustody,
      receiptVerificationState: comp.receiptVerificationState,
      receiptStorageKey,
      receiptSha256Hash: comp.receiptSha256Hash ?? null,
      voucherReason: comp.voucherReason ?? null,
      itcReceivableCadMinor: itc,
      incurredAt: comp.incurredAt
        ? parseStrictTimestamp(
            comp.incurredAt,
            `paidAcquisitionComponents[${idx}].incurredAt`,
          )
        : null,
    };
  });

  const existingExpenseIds: string[] = [];
  const seenExistingIds = new Set<string>();
  for (const rawId of data.existingAcquisitionExpenseIds ?? []) {
    if (!isValidUuid(rawId)) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        'existingAcquisitionExpenseIds entries must be valid UUID strings.',
      );
    }
    const normalizedId = rawId.toLowerCase();
    if (seenExistingIds.has(normalizedId)) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        `Duplicate existingAcquisitionExpenseIds entry "${normalizedId}".`,
      );
    }
    seenExistingIds.add(normalizedId);
    existingExpenseIds.push(normalizedId);
  }
  existingExpenseIds.sort((a, b) => a.localeCompare(b));

  if (
    paidAcquisitionComponents.length === 0 &&
    existingExpenseIds.length === 0
  ) {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      'Paid acquisition components or existing acquisition expense references are required.',
    );
  }

  const cfoOverrideRequested = data.cfoOverride?.approved === true;
  const cfoOverrideReasonNote = cfoOverrideRequested
    ? data.cfoOverride!.reasonNote.trim()
    : null;

  return {
    assetCategory: data.assetCategory,
    vinOrHin,
    modelYearHint: data.modelYearHint ?? null,
    manualYear: data.year ?? null,
    manualMake: data.make ?? null,
    manualModel: data.model ?? null,
    manualTrim: data.trim ?? null,
    manualEngineSpec: data.engineSpec ?? null,
    exteriorColor: data.exteriorColor ?? null,
    destinationBarcode,
    operationalLane: data.operationalLane,
    roadBrand:
      data.assetCategory === 'AUTOMOBILE'
        ? (data.roadBrand ?? 'NONE')
        : 'NOT_APPLICABLE',
    odometerKm:
      data.assetCategory === 'AUTOMOBILE' ? (data.odometerKm ?? null) : null,
    engineHours:
      data.assetCategory === 'AUTOMOBILE' ? null : (data.engineHours ?? null),
    acquisitionSource: data.acquisitionSource,
    declaredStatutoryPurpose: data.declaredStatutoryPurpose,
    sellerFullName: data.sellerFullName ?? null,
    sellerAddress: data.sellerAddress ?? null,
    sellerPhotoIdStorageKey,
    ontarioPermitNumber: data.ontarioPermitNumber ?? null,
    fluidsDrainedAt,
    catalyticConverterDisposition:
      data.assetCategory === 'AUTOMOBILE'
        ? (data.catalyticConverterDisposition ?? 'PRESENT_AT_INTAKE')
        : 'MISSING_AT_INTAKE',
    driveOnInitialFailAt,
    driveOnFailSheetStorageKey,
    suggestedHsCode,
    estimatedMaxBidCadMinor: data.estimatedMaxBidCadMinor,
    actualPurchasePriceCadMinor: data.actualPurchasePriceCadMinor,
    estimatedRepairCadMinor: data.estimatedRepairCadMinor ?? 0,
    targetGrossRealizationMinor: data.targetGrossRealizationMinor ?? 0,
    explicitEstimatedDealOutlayCadMinor:
      data.estimatedDealOutlayCadMinor ?? null,
    paidAcquisitionComponents,
    existingAcquisitionExpenseIds: existingExpenseIds,
    idempotencyKey,
    deviceTimestamp,
    cfoOverrideRequested,
    cfoOverrideReasonNote,
  };
}

function computeIntakeCommandFingerprint(params: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly input: NormalizedIntakeInput;
}): string {
  const i = params.input;
  const canonical = JSON.stringify({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    assetCategory: i.assetCategory,
    vinOrHin: i.vinOrHin,
    modelYearHint: i.modelYearHint,
    manualYear: i.manualYear,
    manualMake: i.manualMake,
    manualModel: i.manualModel,
    manualTrim: i.manualTrim,
    manualEngineSpec: i.manualEngineSpec,
    exteriorColor: i.exteriorColor,
    destinationBarcode: i.destinationBarcode,
    operationalLane: i.operationalLane,
    roadBrand: i.roadBrand,
    odometerKm: i.odometerKm,
    engineHours: i.engineHours,
    acquisitionSource: i.acquisitionSource,
    declaredStatutoryPurpose: i.declaredStatutoryPurpose,
    sellerFullName: i.sellerFullName,
    sellerAddress: i.sellerAddress,
    sellerPhotoIdStorageKey: i.sellerPhotoIdStorageKey,
    ontarioPermitNumber: i.ontarioPermitNumber,
    fluidsDrainedAt: i.fluidsDrainedAt?.toISOString() ?? null,
    catalyticConverterDisposition: i.catalyticConverterDisposition,
    driveOnInitialFailAt: i.driveOnInitialFailAt?.toISOString() ?? null,
    driveOnFailSheetStorageKey: i.driveOnFailSheetStorageKey,
    suggestedHsCode: i.suggestedHsCode,
    estimatedMaxBidCadMinor: i.estimatedMaxBidCadMinor,
    actualPurchasePriceCadMinor: i.actualPurchasePriceCadMinor,
    estimatedRepairCadMinor: i.estimatedRepairCadMinor,
    targetGrossRealizationMinor: i.targetGrossRealizationMinor,
    explicitEstimatedDealOutlayCadMinor: i.explicitEstimatedDealOutlayCadMinor,
    paidAcquisitionComponents: i.paidAcquisitionComponents.map((c) => ({
      ...c,
      incurredAt: c.incurredAt?.toISOString() ?? null,
    })),
    existingAcquisitionExpenseIds: i.existingAcquisitionExpenseIds,
    deviceTimestamp: i.deviceTimestamp.toISOString(),
    cfoOverrideRequested: i.cfoOverrideRequested,
    cfoOverrideReasonNote: i.cfoOverrideReasonNote,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function resolveIdentitySpec(
  input: NormalizedIntakeInput,
  decoded: DecodedAssetSpec | null,
): {
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly engineSpec: string | null;
  readonly oemFitmentVerified: false;
  readonly manualCorrectionApplied: boolean;
  readonly decoderSource: string;
} {
  if (decoded === null) {
    if (
      input.manualYear === null ||
      input.manualMake === null ||
      input.manualModel === null
    ) {
      throw new VehicleIntakeError(
        'ASSET_DECODE_FAILED_MANUAL_REQUIRED',
        `Unable to decode ${input.assetCategory} identifier "${input.vinOrHin}". Explicit manual year, make, and model are required.`,
      );
    }
    return {
      year: input.manualYear,
      make: input.manualMake,
      model: input.manualModel,
      trim: input.manualTrim,
      engineSpec: input.manualEngineSpec,
      oemFitmentVerified: false,
      manualCorrectionApplied: true,
      decoderSource: 'MANUAL_FALLBACK',
    };
  }

  const manualCorrectionApplied =
    (input.manualYear !== null && input.manualYear !== decoded.year) ||
    (input.manualMake !== null && input.manualMake !== decoded.make) ||
    (input.manualModel !== null && input.manualModel !== decoded.model) ||
    (input.manualTrim !== null && input.manualTrim !== decoded.trim) ||
    (input.manualEngineSpec !== null &&
      input.manualEngineSpec !== decoded.engineSpec);

  const sourceRaw = decoded.rawPayload.source;
  const decoderSource =
    typeof sourceRaw === 'string' && sourceRaw.length > 0
      ? sourceRaw
      : 'DECODER';

  return {
    year: input.manualYear ?? decoded.year,
    make: input.manualMake ?? decoded.make,
    model: input.manualModel ?? decoded.model,
    trim: input.manualTrim ?? decoded.trim,
    engineSpec: input.manualEngineSpec ?? decoded.engineSpec,
    oemFitmentVerified: false,
    manualCorrectionApplied,
    decoderSource,
  };
}

/**
 * Generates a globally unique canonical `AST-YYYY-XXXXXXXX` stock number derived from
 * the server-minted UUIDv4 (`vehicleId`), avoiding cross-tenant enumeration while remaining
 * compatible with `validateCanonicalTagCode`.
 */
export function buildServerStockNumber(year: number, vehicleId: string): string {
  const hexSuffix = vehicleId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `AST-${year}-${hexSuffix}`;
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const errObj = error as { code?: unknown; meta?: unknown; message?: unknown };
  const target =
    errObj.meta && typeof errObj.meta === 'object'
      ? JSON.stringify((errObj.meta as { target?: unknown }).target ?? '')
      : '';
  const msg = typeof errObj.message === 'string' ? errObj.message : '';
  if (
    (errObj.code === 'P2002' || errObj.code === '23505') &&
    (target.includes('idempotencyKey') ||
      msg.includes('CustodyEvent_organizationId_idempotencyKey_key'))
  ) {
    return true;
  }
  return msg.includes('CustodyEvent_organizationId_idempotencyKey_key');
}

function isVehicleUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const errObj = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (errObj.code !== 'P2002' && errObj.code !== '23505') {
    return false;
  }
  const target =
    errObj.meta && typeof errObj.meta === 'object'
      ? JSON.stringify((errObj.meta as { target?: unknown }).target ?? '')
      : '';
  const msg = typeof errObj.message === 'string' ? errObj.message : '';
  return (
    target.includes('vinOrHin') ||
    target.includes('internalStockNumber') ||
    msg.includes('Vehicle_vinOrHin_key') ||
    msg.includes('Vehicle_internalStockNumber_key')
  );
}

function neutralizeCsvFormula(cell: string): string {
  if (/^[=+\-@\t\r]/.test(cell)) {
    return `'${cell}`;
  }
  return cell;
}

function formatCsvCell(rawValue: string | number | null | undefined): string {
  const raw = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const safe = neutralizeCsvFormula(raw);
  if (
    safe.includes(',') ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r') ||
    safe.startsWith("'")
  ) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

const HTA_S60_CSV_HEADERS = [
  'internalStockNumber',
  'vinOrHin',
  'year',
  'make',
  'model',
  'exteriorColor',
  'recordedIntakeDate',
  'acquisitionSource',
  'sellerFullName',
  'sellerAddress',
  'ontarioPermitNumber',
  'declaredStatutoryPurpose',
  'catalyticConverterDisposition',
  'lifecycleState',
  'scrappedClearedAt',
  'soldAt',
  'complianceWarnings',
] as const;

export function formatHtaSection60RegisterCsv(
  rows: readonly HtaSection60RegisterRow[],
): string {
  const lines: string[] = [HTA_S60_CSV_HEADERS.join(',')];
  for (const row of rows) {
    const cells = [
      row.internalStockNumber,
      row.vinOrHin,
      row.year,
      row.make,
      row.model,
      row.exteriorColor,
      row.recordedIntakeDate,
      row.acquisitionSource,
      row.sellerFullName,
      row.sellerAddress,
      row.ontarioPermitNumber,
      row.declaredStatutoryPurpose,
      row.catalyticConverterDisposition,
      row.lifecycleState,
      row.scrappedClearedAt,
      row.soldAt,
      row.complianceWarnings.join('; '),
    ].map(formatCsvCell);
    lines.push(cells.join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function evaluateHtaSection60(
  input: NormalizedIntakeInput,
  mode: ComplianceEnforcementMode,
): { readonly warnings: readonly string[] } {
  if (input.assetCategory !== 'AUTOMOBILE') {
    return { warnings: [] };
  }

  const missingSellerName = !input.sellerFullName;
  const missingPermit = !input.ontarioPermitNumber;
  const missingPrivatePhotoId =
    input.acquisitionSource === 'PRIVATE_DRIVEWAY_BUY' &&
    !input.sellerPhotoIdStorageKey;

  if (!missingSellerName && !missingPermit && !missingPrivatePhotoId) {
    return { warnings: [] };
  }

  const decision = evaluateRegulatoryComplianceCheck(
    mode,
    'MISSING_HTA_S60_DOCS',
  );
  if (!decision.allowed) {
    throw new VehicleIntakeError(
      'MISSING_HTA_S60_DOCS',
      'Ontario HTA Section 60 requires sellerFullName, ontarioPermitNumber, and private-seller photo ID storage key under STRICT_BLOCK mode.',
      {
        missingSellerName,
        missingPermit,
        missingPrivatePhotoId,
      },
    );
  }
  return { warnings: decision.warnings };
}

function resolveIdempotentIntakeReplay(
  existing: ExistingIdempotentIntakeRecord,
  expectedFingerprint: string,
): IntakeVehicleResult {
  if (existing.auditAction !== VEHICLE_INTAKE_AUDIT_ACTION) {
    throw new VehicleIntakeError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key has already been used by another operation.',
    );
  }
  if (!existing.commandFingerprint || !existing.intakeResult) {
    throw new VehicleIntakeError(
      'INTAKE_INTEGRITY_ERROR',
      `CustodyEvent "${existing.custodyEventId}" is missing immutable vehicle intake replay metadata.`,
    );
  }
  if (existing.commandFingerprint !== expectedFingerprint) {
    throw new VehicleIntakeError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key has already been used with a different vehicle intake command.',
    );
  }
  return {
    ...existing.intakeResult,
    replayed: true,
  };
}

function addSafeIntSum(values: readonly number[], fieldName: string): number {
  let total = 0n;
  for (const val of values) {
    total += BigInt(val);
  }
  if (total > BigInt(PRISMA_INT32_MAX)) {
    throw new VehicleIntakeError(
      'INVALID_INTAKE_INPUT',
      `${fieldName} exceeds supported integer bounds.`,
    );
  }
  return Number(total);
}

/**
 * Orchestrates `FR-INT-01` parent asset intake (`AUTOMOBILE`, `WATERCRAFT`, `SHOP_EQUIPMENT`),
 * HTA Section 60 Garage & Wrecking Register exports, `O. Reg. 85/16` EASR thresholds,
 * DriveON 10-day re-inspection timers, `LocationZoningService`, and settlement-confirmed
 * working-capital & deal-discipline gates with 1-Tap `ARCHITECT_CFO` `aal2` override.
 */
export class IntakeVehicleUseCase {
  private readonly repository: IntakeVehicleRepository;
  private readonly decoderFactory: AssetDecoderFactory;
  private readonly zoningService: LocationZoningService;
  private readonly clock: IntakeClock;
  private readonly idGenerator: () => string;

  public constructor(deps: IntakeVehicleUseCaseDeps = {}) {
    if (!deps.repository) {
      throw new VehicleIntakeError(
        'INTAKE_INTEGRITY_ERROR',
        'IntakeVehicleUseCase requires an IntakeVehicleRepository implementation.',
      );
    }
    this.repository = deps.repository;
    this.decoderFactory =
      deps.decoderFactory ?? createCategoryAssetDecoderFactory();
    this.zoningService = deps.zoningService ?? new LocationZoningService();
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGenerator = deps.idGenerator ?? (() => randomUUID());
  }

  public async execute(
    session: AuthSessionContext,
    rawInput: IntakeVehicleInput,
  ): Promise<IntakeVehicleResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-01');
    const tenantCtx = toTenantExecutionContext(session);
    const organizationId = tenantCtx.organizationId;

    const input = validateAndNormalizeIntakeInput(rawInput, organizationId);

    if (input.cfoOverrideRequested) {
      assertCfoOverrideAuthority(session);
      if (
        !input.cfoOverrideReasonNote ||
        input.cfoOverrideReasonNote.length === 0
      ) {
        throw new VehicleIntakeError(
          'CFO_OVERRIDE_REASON_REQUIRED',
          '1-Tap CFO Override requires a non-empty reasonNote.',
        );
      }
    }

    const decoder = this.decoderFactory(input.assetCategory);
    const decoded = await decoder.decodeIdentifier(
      input.vinOrHin,
      input.modelYearHint ?? undefined,
    );
    const resolvedSpec = resolveIdentitySpec(input, decoded);

    const commandFingerprint = computeIntakeCommandFingerprint({
      organizationId,
      actorUserId: tenantCtx.userId,
      input,
    });

    const executeTx = async (): Promise<IntakeVehicleResult> =>
      this.repository.withTenantTransaction(tenantCtx, async (tx) => {
        await tx.acquireOrganizationLock(organizationId);

        const existingReplay = await tx.findIdempotentIntake(
          organizationId,
          input.idempotencyKey,
        );
        if (existingReplay) {
          return resolveIdempotentIntakeReplay(
            existingReplay,
            commandFingerprint,
          );
        }

        const policyAdapter = new JsonPolicyConfigAdapter({
          readOrganizationPolicy: (orgId) =>
            tx.readOrganizationPolicyRecord(orgId),
        });
        const policy: PricingAndCompliancePolicy =
          await policyAdapter.getPolicyForOrg(organizationId);

        const destination = await tx.findAndLockStorageLocationByBarcode(
          organizationId,
          input.destinationBarcode,
        );
        if (!destination) {
          throw new LocationCustodyError(
            'SITE_ZONING_VIOLATION',
            `Destination location "${input.destinationBarcode}" is unavailable in the active organization.`,
          );
        }

        const existingExpenses =
          input.existingAcquisitionExpenseIds.length > 0
            ? await tx.findAndLockAcquisitionExpenses(
                organizationId,
                input.existingAcquisitionExpenseIds,
              )
            : [];

        this.assertExistingAcquisitionExpensesValid(
          input.existingAcquisitionExpenseIds,
          existingExpenses,
        );
        this.assertPaidComponentsWithinPolicy(
          input.paidAcquisitionComponents,
          policy,
        );

        const {
          estimatedDealOutlayCadMinor,
          alreadyDebitedBankDealCostCadMinor,
        } = this.reconcileAcquisitionCosts(input, existingExpenses);

        const currentDestActiveCount =
          await tx.countActiveVehiclesAtLocation(organizationId, destination.id);
        const activeElvCandidates =
          input.assetCategory === 'AUTOMOBILE'
            ? await tx.listActiveAutomobileElvCandidates(organizationId)
            : [];
        const snapshot = await tx.queryFinancialSnapshot(
          organizationId,
          policy,
        );

        const now = this.clock.now();
        const provisionalVehicleId = this.nextUuid();

        const zoningDecision = this.zoningService.evaluateLocationZoning({
          activeOrganizationId: organizationId,
          activeOrganizationType: session.activeOrganizationType,
          entity: {
            kind: 'VEHICLE',
            id: provisionalVehicleId,
            organizationId,
            assetCategory: input.assetCategory,
            lifecycleState: 'STAGED_ONTARIO_YARD',
            storageLocationId: null,
            fluidsDrainedAt: input.fluidsDrainedAt,
          },
          location: destination,
          complianceEnforcementMode:
            policy.operationalGates.complianceEnforcementMode,
          locationCapacityGateMode:
            policy.operationalGates.locationCapacityGate.enforcementMode,
          currentDestinationActiveAssetCount: currentDestActiveCount,
          evaluateCapacity: true,
          cfoOverrideAuthorized: input.cfoOverrideRequested,
        });

        const htaDecision = evaluateHtaSection60(
          input,
          policy.operationalGates.complianceEnforcementMode,
        );

        const easrDecision =
          input.assetCategory === 'AUTOMOBILE'
            ? evaluateEasrElvThreshold(
                {
                  organizationId,
                  activeElvVehiclesOnSite: activeElvCandidates,
                  incomingVehicle: {
                    assetCategory: input.assetCategory,
                    operationalLane: input.operationalLane,
                  },
                },
                policy,
              )
            : {
                allowed: true,
                warnings: [] as string[],
                blockingCodes: [],
              };

        if (!easrDecision.allowed) {
          throw new VehicleIntakeError(
            'EASR_REGISTRATION_REQUIRED',
            'Ontario O. Reg. 85/16 EASR registration number is required for active ELV #3+ under STRICT_BLOCK mode.',
          );
        }

        const driveOnTimers = computeDriveOnTimers(
          {
            assetCategory: input.assetCategory,
            driveOnInitialFailAt: input.driveOnInitialFailAt,
            driveOnSscIssuedAt: null,
            now,
          },
          policy,
        );

        const gateAvailableCapitalCadMinor =
          snapshot.availableWorkingCapitalCadMinor +
          alreadyDebitedBankDealCostCadMinor;

        const wcDecision = evaluateWorkingCapitalGate(
          {
            organizationId,
            availableWorkingCapitalCadMinor: gateAvailableCapitalCadMinor,
            estimatedDealOutlayCadMinor,
            operationalLane: input.operationalLane,
            assetCategory: input.assetCategory,
            actor: {
              actorUserId: tenantCtx.userId,
              actorRole: tenantCtx.role,
            },
            cfoOverride: input.cfoOverrideRequested
              ? {
                  approved: true,
                  approvedById: tenantCtx.userId,
                  approverRole: tenantCtx.role,
                  reasonNote: input.cfoOverrideReasonNote!,
                }
              : undefined,
          },
          policy,
        );

        if (!wcDecision.allowed) {
          const code =
            wcDecision.blockingCodes[0] ?? 'WORKING_CAPITAL_RESERVE_BREACHED';
          throw new VehicleIntakeError(
            code as VehicleIntakeErrorCode,
            `Vehicle intake blocked by working-capital/deal gate (${code}).`,
            {
              blockingCodes: wcDecision.blockingCodes,
              availableWorkingCapitalCadMinor:
                snapshot.availableWorkingCapitalCadMinor,
              gateAvailableCapitalCadMinor,
              estimatedDealOutlayCadMinor,
              projectedPostDealCapitalCadMinor:
                wcDecision.projectedPostDealCapitalCadMinor,
              minCashReserveFloorCadMinor:
                wcDecision.minCashReserveFloorCadMinor,
            },
          );
        }

        const capacityOverrideWarnings = zoningDecision.overrideApplied
          ? ['LOCATION_CAPACITY_EXCEEDED']
          : [];

        const complianceWarnings = mergeComplianceWarnings(
          zoningDecision.warnings,
          [
            ...capacityOverrideWarnings,
            ...htaDecision.warnings,
            ...easrDecision.warnings,
            ...wcDecision.warnings,
          ],
        );

        const cfoOverrideApplied =
          zoningDecision.overrideApplied || wcDecision.overrideApplied;
        const cfoGateApprovedById = cfoOverrideApplied
          ? tenantCtx.userId
          : null;
        const cfoGateApprovedAt = cfoOverrideApplied ? now : null;
        const cfoGateOverrideReason = cfoOverrideApplied
          ? input.cfoOverrideReasonNote
          : null;

        const internalStockNumber = buildServerStockNumber(
          resolvedSpec.year,
          provisionalVehicleId,
        );
        const custodyEventId = this.nextUuid();
        const intakeAuditId = this.nextUuid();

        const createdExpenseRecords: PersistAcquisitionExpenseRecord[] =
          input.paidAcquisitionComponents.map((comp) => ({
            id: this.nextUuid(),
            organizationId,
            vehicleId: provisionalVehicleId,
            loggedByUserId: tenantCtx.userId,
            category: comp.category,
            vendorName: comp.vendorName,
            description: comp.description,
            amountOriginalMinor: comp.amountCadMinor,
            currencyOriginal: 'CAD',
            amountCadMinor: comp.amountCadMinor,
            itcReceivableCadMinor: comp.itcReceivableCadMinor,
            paidFromCashCustody: comp.paidFromCashCustody,
            receiptVerificationState: comp.receiptVerificationState,
            receiptStorageKey: comp.receiptStorageKey,
            receiptSha256Hash: comp.receiptSha256Hash,
            voucherReason: comp.voucherReason,
            incurredAt: comp.incurredAt ?? now,
            createdAt: now,
          }));

        const linkedExpenseIds = existingExpenses.map((e) => e.id);
        const createdExpenseIds = createdExpenseRecords.map((e) => e.id);

        const result: IntakeVehicleResult = {
          replayed: false,
          vehicleId: provisionalVehicleId,
          organizationId,
          internalStockNumber,
          assetCategory: input.assetCategory,
          vinOrHin: input.vinOrHin,
          year: resolvedSpec.year,
          make: resolvedSpec.make,
          model: resolvedSpec.model,
          trim: resolvedSpec.trim,
          engineSpec: resolvedSpec.engineSpec,
          exteriorColor: input.exteriorColor,
          steeringSide:
            input.assetCategory === 'AUTOMOBILE' ? 'LHD_ONLY' : 'UNIVERSAL',
          oemFitmentVerified: false,
          roadBrand: input.roadBrand,
          operationalLane: input.operationalLane,
          lifecycleState: 'STAGED_ONTARIO_YARD',
          availabilityState: 'AVAILABLE',
          classifiedsSyncState: 'NOT_POSTED',
          storageLocationId: destination.id,
          destinationBarcode: destination.fullQrBarcode,
          suggestedHsCode: input.suggestedHsCode,
          catalyticConverterDisposition: input.catalyticConverterDisposition,
          driveOnInitialFailAt:
            input.driveOnInitialFailAt?.toISOString() ?? null,
          driveOnReinspectionDeadlineAt:
            driveOnTimers.driveOnReinspectionDeadlineAt?.toISOString() ?? null,
          estimatedMaxBidCadMinor: input.estimatedMaxBidCadMinor,
          actualPurchasePriceCadMinor: input.actualPurchasePriceCadMinor,
          estimatedRepairCadMinor: input.estimatedRepairCadMinor,
          estimatedDealOutlayCadMinor,
          createdExpenseIds,
          linkedExpenseIds,
          custodyEventId,
          auditLogId: intakeAuditId,
          complianceWarnings,
          cfoOverrideApplied,
          cfoGateApprovedById,
          cfoGateApprovedAt: cfoGateApprovedAt?.toISOString() ?? null,
          cfoGateOverrideReason,
          availableWorkingCapitalBeforeCadMinor:
            snapshot.availableWorkingCapitalCadMinor,
          projectedPostDealCapitalCadMinor:
            wcDecision.projectedPostDealCapitalCadMinor,
          createdAt: now.toISOString(),
        };

        await tx.insertVehicle({
          id: provisionalVehicleId,
          organizationId,
          internalStockNumber,
          assetCategory: input.assetCategory,
          vinOrHin: input.vinOrHin,
          year: resolvedSpec.year,
          make: resolvedSpec.make,
          model: resolvedSpec.model,
          trim: resolvedSpec.trim,
          engineSpec: resolvedSpec.engineSpec,
          odometerKm: input.odometerKm,
          engineHours: input.engineHours,
          exteriorColor: input.exteriorColor,
          steeringSide: result.steeringSide,
          oemFitmentVerified: false,
          roadBrand: input.roadBrand,
          operationalLane: input.operationalLane,
          lifecycleState: 'STAGED_ONTARIO_YARD',
          availabilityState: 'AVAILABLE',
          classifiedsSyncState: 'NOT_POSTED',
          storageLocationId: destination.id,
          acquisitionSource: input.acquisitionSource,
          sellerFullName: input.sellerFullName,
          sellerAddress: input.sellerAddress,
          sellerPhotoIdStorageKey: input.sellerPhotoIdStorageKey,
          ontarioPermitNumber: input.ontarioPermitNumber,
          declaredStatutoryPurpose: input.declaredStatutoryPurpose,
          suggestedHsCode: input.suggestedHsCode,
          estimatedMaxBidCadMinor: input.estimatedMaxBidCadMinor,
          actualPurchasePriceCadMinor: input.actualPurchasePriceCadMinor,
          estimatedRepairCadMinor: input.estimatedRepairCadMinor,
          targetGrossRealizationMinor: input.targetGrossRealizationMinor,
          cfoGateApprovedById,
          cfoGateApprovedAt,
          cfoGateOverrideReason,
          driveOnInitialFailAt: input.driveOnInitialFailAt,
          driveOnReinspectionDeadlineAt:
            driveOnTimers.driveOnReinspectionDeadlineAt,
          driveOnFailSheetStorageKey: input.driveOnFailSheetStorageKey,
          fluidsDrainedAt: input.fluidsDrainedAt,
          catalyticConverterDisposition: input.catalyticConverterDisposition,
          complianceWarnings,
          version: 1,
          createdAt: now,
        });

        if (createdExpenseRecords.length > 0) {
          await tx.insertExpenses(createdExpenseRecords);
        }

        for (const existingExp of existingExpenses) {
          await tx.insertAuditLog({
            id: this.nextUuid(),
            organizationId,
            actorUserId: tenantCtx.userId,
            entityType: EXPENSE_LINKED_AUDIT_ENTITY_TYPE,
            entityId: existingExp.id,
            action: EXPENSE_LINKED_AUDIT_ACTION,
            previousState: { vehicleId: null },
            nextState: {
              vehicleId: provisionalVehicleId,
              category: existingExp.category,
              amountCadMinor: existingExp.amountCadMinor,
            },
            createdAt: now,
          });
        }

        await tx.insertCustodyEvent({
          id: custodyEventId,
          organizationId,
          vehicleId: provisionalVehicleId,
          actorUserId: tenantCtx.userId,
          idempotencyKey: input.idempotencyKey,
          fromLocationBarcode: null,
          toLocationBarcode: destination.fullQrBarcode,
          expectedVersion: 1,
          hasConflict: false,
          complianceWarnings,
          deviceTimestamp: input.deviceTimestamp,
          serverReceivedAt: now,
        });

        await tx.insertAuditLog({
          id: intakeAuditId,
          organizationId,
          actorUserId: tenantCtx.userId,
          entityType: VEHICLE_INTAKE_AUDIT_ENTITY_TYPE,
          entityId: provisionalVehicleId,
          action: VEHICLE_INTAKE_AUDIT_ACTION,
          previousState: null,
          nextState: {
            commandFingerprint,
            intakeResult: result,
            decoderAudit: {
              source: resolvedSpec.decoderSource,
              matched: decoded !== null,
              manualCorrectionApplied: resolvedSpec.manualCorrectionApplied,
            },
            gateEvaluation: {
              availableWorkingCapitalBeforeCadMinor:
                snapshot.availableWorkingCapitalCadMinor,
              alreadyDebitedBankDealCostCadMinor,
              gateAvailableCapitalCadMinor,
              estimatedDealOutlayCadMinor,
              projectedPostDealCapitalCadMinor:
                wcDecision.projectedPostDealCapitalCadMinor,
              pendingExternalReceivablesCadMinor:
                snapshot.pendingExternalReceivablesCadMinor,
              runningOperatorFloatCadMinor:
                snapshot.runningOperatorFloatCadMinor,
              cfoOverrideRequested: input.cfoOverrideRequested,
              cfoOverrideApplied,
              complianceWarnings,
            },
          },
          createdAt: now,
        });

        return result;
      });

    try {
      return await executeTx();
    } catch (error) {
      if (isIdempotencyUniqueViolation(error)) {
        const replayed = await this.repository.withTenantTransaction(
          tenantCtx,
          async (tx) => {
            await tx.acquireOrganizationLock(organizationId);
            const existing = await tx.findIdempotentIntake(
              organizationId,
              input.idempotencyKey,
            );
            if (!existing) {
              throw new VehicleIntakeError(
                'IDEMPOTENCY_KEY_REUSED',
                'Idempotency key conflicted with a concurrent operation.',
              );
            }
            return resolveIdempotentIntakeReplay(existing, commandFingerprint);
          },
        );
        return replayed;
      }

      if (isVehicleUniqueViolation(error)) {
        throw new VehicleIntakeError(
          'VEHICLE_IDENTIFIER_CONFLICT',
          'An asset with this VIN/HIN or stock number already exists.',
        );
      }

      throw error;
    }
  }

  public async listVehicles(
    session: AuthSessionContext,
    options: { readonly limit?: number } = {},
  ): Promise<ListVehiclesResult> {
    assertTrustedAuthSession(session);
    const scope = this.resolveListScope(session);
    const limit =
      typeof options.limit === 'number' &&
      Number.isSafeInteger(options.limit) &&
      options.limit >= 1
        ? Math.min(options.limit, 200)
        : 50;

    const tenantCtx = toTenantExecutionContext(session);
    const rows = await this.repository.withTenantTransaction(
      tenantCtx,
      async (tx) =>
        tx.listVehicles(tenantCtx.organizationId, {
          scope,
          limit,
        }),
    );

    return {
      scope,
      vehicles: rows.map((row) => ({
        id: row.id,
        internalStockNumber: row.internalStockNumber,
        assetCategory: row.assetCategory,
        vinOrHin: row.vinOrHin,
        year: row.year,
        make: row.make,
        model: row.model,
        trim: row.trim,
        engineSpec: row.engineSpec,
        exteriorColor: row.exteriorColor,
        steeringSide: row.steeringSide,
        roadBrand: row.roadBrand,
        operationalLane: row.operationalLane,
        lifecycleState: row.lifecycleState,
        availabilityState: row.availabilityState,
        storageLocationId: row.storageLocationId,
        destinationBarcode: row.destinationBarcode,
        suggestedHsCode: row.suggestedHsCode,
        catalyticConverterDisposition: row.catalyticConverterDisposition,
        complianceWarnings: [...row.complianceWarnings],
        driveOnReinspectionDeadlineAt:
          row.driveOnReinspectionDeadlineAt?.toISOString() ?? null,
        fluidsDrainedAt: row.fluidsDrainedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  public async listHtaSection60Register(
    session: AuthSessionContext,
    format: 'JSON' | 'CSV' = 'JSON',
  ): Promise<HtaSection60RegisterResult> {
    assertTrustedAuthSession(session);
    assertCapability(session, 'FR-INT-01:read');

    const tenantCtx = toTenantExecutionContext(session);
    const storedRows = await this.repository.withTenantTransaction(
      tenantCtx,
      async (tx) =>
        tx.listHtaSection60AutomobileRows(tenantCtx.organizationId),
    );

    const rows: HtaSection60RegisterRow[] = storedRows.map((row) => ({
      internalStockNumber: row.internalStockNumber,
      vinOrHin: row.vinOrHin,
      year: row.year,
      make: row.make,
      model: row.model,
      exteriorColor: row.exteriorColor,
      recordedIntakeDate: row.createdAt.toISOString(),
      acquisitionSource: row.acquisitionSource,
      sellerFullName: row.sellerFullName,
      sellerAddress: row.sellerAddress,
      ontarioPermitNumber: row.ontarioPermitNumber,
      declaredStatutoryPurpose: row.declaredStatutoryPurpose,
      catalyticConverterDisposition: row.catalyticConverterDisposition,
      lifecycleState: row.lifecycleState,
      scrappedClearedAt: row.scrappedClearedAt?.toISOString() ?? null,
      soldAt: row.soldAt?.toISOString() ?? null,
      complianceWarnings: [...row.complianceWarnings],
    }));

    if (format === 'CSV') {
      return {
        format: 'CSV',
        filename: 'hta-s60-register.csv',
        csvContent: formatHtaSection60RegisterCsv(rows),
        rows,
      };
    }

    return {
      format: 'JSON',
      rows,
    };
  }

  private resolveListScope(
    session: AuthSessionContext,
  ): 'FULL' | 'STRIP_QUEUE_ONLY' | 'EXPORTED_ONLY' {
    try {
      assertCapability(session, 'FR-INT-01:read');
      return 'FULL';
    } catch {
      // Check restricted read scopes next
    }
    try {
      assertCapability(session, 'FR-INT-01:read-strip-queue');
      return 'STRIP_QUEUE_ONLY';
    } catch {
      // Check exported scope next
    }
    assertCapability(session, 'FR-INT-01:read-exported');
    return 'EXPORTED_ONLY';
  }

  private assertExistingAcquisitionExpensesValid(
    requestedIds: readonly string[],
    lockedExpenses: readonly LockedExistingAcquisitionExpense[],
  ): void {
    if (requestedIds.length === 0) {
      return;
    }
    const byId = new Map(lockedExpenses.map((e) => [e.id, e]));
    for (const id of requestedIds) {
      const exp = byId.get(id);
      if (!exp) {
        throw new VehicleIntakeError(
          'INVALID_EXPENSE_REFERENCE',
          `Referenced acquisition expense "${id}" was not found in the active organization.`,
        );
      }
      if (exp.vehicleId !== null || exp.alreadyLinkedInAudit) {
        throw new VehicleIntakeError(
          'EXPENSE_ALREADY_LINKED',
          `Referenced acquisition expense "${id}" is already bound to a vehicle.`,
        );
      }
      if (
        !ACQUISITION_EXPENSE_CATEGORIES.includes(
          exp.category as AcquisitionExpenseCategory,
        )
      ) {
        throw new VehicleIntakeError(
          'INVALID_EXPENSE_REFERENCE',
          `Referenced expense "${id}" category "${exp.category}" is not an acquisition expense category.`,
        );
      }
      if (exp.isReversalEntry || exp.hasReversalEntry) {
        throw new VehicleIntakeError(
          'INVALID_EXPENSE_REFERENCE',
          `Referenced acquisition expense "${id}" is reversed or a reversal entry.`,
        );
      }
      if (exp.isDeferredIntercompanyAccrual && exp.accrualSettledAt === null) {
        throw new VehicleIntakeError(
          'INVALID_EXPENSE_REFERENCE',
          `Referenced acquisition expense "${id}" is an unsettled deferred accrual.`,
        );
      }
      if (
        exp.paidFromCashCustody !== null &&
        exp.paidFromCashCustody !== 'SETTLED_ORIGIN_CORP_BANK' &&
        exp.paidFromCashCustody !== 'HELD_IN_OPERATOR_FLOAT'
      ) {
        throw new VehicleIntakeError(
          'INVALID_EXPENSE_REFERENCE',
          `Referenced acquisition expense "${id}" has unsupported cash custody state "${exp.paidFromCashCustody}".`,
        );
      }
      if (exp.currencyOriginal !== 'CAD' && exp.amountCadMinor === 0) {
        throw new VehicleIntakeError(
          'INVALID_EXPENSE_REFERENCE',
          `Referenced acquisition expense "${id}" is missing converted CAD amount.`,
        );
      }
    }
  }

  private assertPaidComponentsWithinPolicy(
    components: readonly NormalizedPaidComponent[],
    policy: PricingAndCompliancePolicy,
  ): void {
    for (const comp of components) {
      if (
        comp.receiptVerificationState === 'PETTY_CASH_VOUCHER' &&
        comp.amountCadMinor > policy.expensePolicy.pettyCashVoucherMaxCadMinor
      ) {
        throw new VehicleIntakeError(
          'INVALID_INTAKE_INPUT',
          `PETTY_CASH_VOUCHER amount (${comp.amountCadMinor}) exceeds policy max (${policy.expensePolicy.pettyCashVoucherMaxCadMinor}).`,
        );
      }
    }
  }

  private reconcileAcquisitionCosts(
    input: NormalizedIntakeInput,
    existingExpenses: readonly LockedExistingAcquisitionExpense[],
  ): {
    readonly estimatedDealOutlayCadMinor: number;
    readonly alreadyDebitedBankDealCostCadMinor: number;
  } {
    const purchaseAmounts: number[] = [];
    const feeAndTowingAmounts: number[] = [];
    const alreadyDebitedBankAmounts: number[] = [];

    for (const comp of input.paidAcquisitionComponents) {
      if (comp.category === 'AUCTION_PURCHASE_PRICE') {
        purchaseAmounts.push(comp.amountCadMinor);
      } else {
        feeAndTowingAmounts.push(comp.amountCadMinor);
      }
    }

    for (const exp of existingExpenses) {
      if (exp.category === 'AUCTION_PURCHASE_PRICE') {
        purchaseAmounts.push(exp.amountCadMinor);
      } else {
        feeAndTowingAmounts.push(exp.amountCadMinor);
      }
      if (exp.paidFromCashCustody !== 'HELD_IN_OPERATOR_FLOAT') {
        alreadyDebitedBankAmounts.push(exp.amountCadMinor);
      }
    }

    const totalPaidPurchaseCadMinor = addSafeIntSum(
      purchaseAmounts,
      'purchasePriceComponents',
    );
    if (totalPaidPurchaseCadMinor !== input.actualPurchasePriceCadMinor) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        `Sum of AUCTION_PURCHASE_PRICE components (${totalPaidPurchaseCadMinor}) must equal actualPurchasePriceCadMinor (${input.actualPurchasePriceCadMinor}).`,
      );
    }

    const totalFeesAndTowingCadMinor = addSafeIntSum(
      feeAndTowingAmounts,
      'acquisitionFeesAndTowing',
    );
    const estimatedDealOutlayCadMinor = addSafeIntSum(
      [
        input.actualPurchasePriceCadMinor,
        totalFeesAndTowingCadMinor,
        input.estimatedRepairCadMinor,
      ],
      'estimatedDealOutlayCadMinor',
    );

    if (
      input.explicitEstimatedDealOutlayCadMinor !== null &&
      input.explicitEstimatedDealOutlayCadMinor !== estimatedDealOutlayCadMinor
    ) {
      throw new VehicleIntakeError(
        'INVALID_INTAKE_INPUT',
        `estimatedDealOutlayCadMinor (${input.explicitEstimatedDealOutlayCadMinor}) does not match purchase + fees + towing + estimatedRepairCadMinor (${estimatedDealOutlayCadMinor}).`,
      );
    }

    const alreadyDebitedBankDealCostCadMinor = addSafeIntSum(
      alreadyDebitedBankAmounts,
      'alreadyDebitedBankDealCostCadMinor',
    );

    return {
      estimatedDealOutlayCadMinor,
      alreadyDebitedBankDealCostCadMinor,
    };
  }

  private nextUuid(): string {
    const id = this.idGenerator();
    if (!isValidUuid(id)) {
      throw new VehicleIntakeError(
        'INTAKE_INTEGRITY_ERROR',
        'idGenerator must produce a valid UUID string.',
      );
    }
    return id.toLowerCase();
  }
}
