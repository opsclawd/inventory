import { randomUUID } from 'node:crypto';
import type {
  AraConditionGradeEnum,
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  ClassifiedsSyncState,
  EbaySyncState,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  SteeringSideCompatibility,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import { JsonPolicyConfigAdapter } from '@/core/config/policy-loader';
import { type PricingAndCompliancePolicy } from '@/core/ports';
import {
  buildPersistedLedgerProjection,
  type PersistedLedgerProjection,
  type PersistedSaleLedgerRow,
} from '@/modules/cfo-subledger/financial-snapshot.query';
import {
  type CheckoutLockedPartRow,
  type CheckoutLockedVehicleRow,
  type DomesticCheckoutRepository,
  type DomesticCheckoutTx,
  type EligibleCashSweepTransferRow,
  type PersistedDomesticSaleRecord,
  type StoredCheckoutReceipt,
} from '@/modules/logistics-vault/checkout/domestic-checkout.contracts';
import type { DomesticCheckoutRouteDeps } from '@/modules/logistics-vault/checkout/domestic-checkout-route.handler';
import { ExecuteDomesticCheckoutUseCase } from '@/modules/logistics-vault/checkout/execute-domestic-checkout.use-case';
import {
  type ActiveMembershipSummary,
  type AuthSessionContext,
  createAuthSessionContext,
} from '@/modules/shared-ops/auth/auth.contracts';
import { translateTenantContextError } from '@/modules/shared-ops/auth';
import {
  InMemoryStorageAdapter,
  type StorageSecurityRepository,
} from '@/modules/shared-ops/storage';
import {
  TenantContextError,
  type TenantExecutionContext,
} from '@/infrastructure/db/tenant-transaction';
import { PHASE1A_SEED_IDS } from '../../../../prisma/seed';
import { EbayCsvExporterUseCase } from './ebay-csv-exporter.use-case';
import { LocalClassifiedsQueueUseCase } from './local-classifieds-queue.use-case';
import {
  type ExportEbayCsvResult,
  type PersistSyndicationAuditInput,
  type StoredSyndicationReceipt,
  type SyndicationPartRecord,
  type SyndicationRepository,
  type SyndicationTx,
} from './syndication.contracts';
import type { SyndicationRouteDeps } from './syndication-route.handler';
import { SyndicationTemplateService } from './syndication-template.service';

export const BASELINE_ISSUE10_POLICY: PricingAndCompliancePolicy =
  await new JsonPolicyConfigAdapter().getPolicyForOrg(
    PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
  );

export interface InMemoryHarnessPart {
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
  weightKg: number;
  rawPhotoUrls: string[];
  cleanPhotoUrls: string[];
  compBaselineCadMinor: number | null;
  retailPriceCadMinor: number | null;
  ebayListingId: string | null;
  ebayTitle: string | null;
  ebayCompatibilityJson: unknown;
  storageLocationId: string | null;
  storageLocationBarcode: string | null;
  version: number;
}

export interface InMemoryHarnessVehicle {
  id: string;
  organizationId: string;
  internalStockNumber: string;
  assetCategory: AssetCategory;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  engineSpec: string | null;
  vinOrHin: string;
  odometerKm: number | null;
  engineHours: number | null;
  operationalLane: OperationalLane;
  lifecycleState: AssetLifecycleState;
  availabilityState: InventoryAvailabilityState;
  classifiedsSyncState: ClassifiedsSyncState;
  storageLocationId: string | null;
  storageLocationOrgId: string | null;
  storageLocationAllowedOrgType: OrganizationType | null;
  storageLocationStatus: LocationOperationalStatus | null;
  storageLocationAllowsDismantling: boolean | null;
  fluidsDrainedAt: Date | null;
  actualPurchasePriceCadMinor: number;
  estimatedRepairCadMinor: number;
  targetGrossRealizationMinor: number;
  realizedRetailSaleCadMinor: number | null;
  soldAt: Date | null;
  driveOnInitialFailAt: Date | null;
  driveOnSscIssuedAt: Date | null;
  driveOnSscExpiresAt: Date | null;
  complianceWarnings: string[];
  version: number;
}

export interface InMemoryHarnessCustodyEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly partId: string;
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

export interface InMemoryHarnessOutboxEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

export interface InMemoryHarnessAuditLog {
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

interface MembershipRow {
  userId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationType: OrganizationType;
  role: UserRole;
  isDefaultWorkspace: boolean;
  isActive: boolean;
}

interface HarnessStoreSnapshot {
  organizations: Map<string, { id: string; policyConfigJson: unknown; isActive: boolean }>;
  memberships: MembershipRow[];
  parts: Map<string, InMemoryHarnessPart>;
  vehicles: Map<string, InMemoryHarnessVehicle>;
  sales: Map<string, PersistedDomesticSaleRecord>;
  cashTransfers: EligibleCashSweepTransferRow[];
  custodyEvents: InMemoryHarnessCustodyEvent[];
  outboxEvents: InMemoryHarnessOutboxEvent[];
  auditLogs: InMemoryHarnessAuditLog[];
  receipts: Map<string, StoredCheckoutReceipt | StoredSyndicationReceipt>;
}

export const HARNESS_IDS = {
  orgs: {
    SALVAGE: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
    CANNABIS: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
  },
  users: {
    CFO: PHASE1A_SEED_IDS.users.architectCfo,
    HUNTER: PHASE1A_SEED_IDS.users.hunterMechanic,
    STRIPPER: PHASE1A_SEED_IDS.users.ontarioStripper,
    VAULT: PHASE1A_SEED_IDS.users.trinidadVaultAdmin,
    BUYER: PHASE1A_SEED_IDS.users.overseasBuyer,
    QAP: PHASE1A_SEED_IDS.users.cannabisQap,
  },
  vehicles: {
    CRV_DONOR: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
    SEADOO_DONOR: PHASE1A_SEED_IDS.vehicles.watercraftSeadoo2019,
    RETAIL_CAR: '50000000-0000-4000-8000-000000000010',
    RETAIL_POWERSPORTS: '50000000-0000-4000-8000-000000000011',
  },
  parts: {
    ALTERNATOR: PHASE1A_SEED_IDS.parts.alternator,
    STEERING_RACK: PHASE1A_SEED_IDS.parts.steeringRack,
    AIRBAG: PHASE1A_SEED_IDS.parts.airbagModule,
    ENGINE_POWERTRAIN: '60000000-0000-4000-8000-000000000010',
    STARTER_GRADE_B1: '60000000-0000-4000-8000-000000000011',
    BATTERY_TDG: '60000000-0000-4000-8000-000000000012',
    CANNABIS_FAKE_PART: '60000000-0000-4000-8000-000000000099',
  },
} as const;

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export class Issue10OfflineTestHarness {
  public store: HarnessStoreSnapshot;
  public nowDate: Date;

  public constructor(initialNow = new Date('2026-11-16T15:00:00.000Z')) {
    this.nowDate = initialNow;
    this.store = this.createInitialStore();
  }

  private createInitialStore(): HarnessStoreSnapshot {
    const orgId = HARNESS_IDS.orgs.SALVAGE;
    const cannabisOrgId = HARNESS_IDS.orgs.CANNABIS;

    const organizations = new Map<
      string,
      { id: string; policyConfigJson: unknown; isActive: boolean }
    >([
      [
        orgId,
        {
          id: orgId,
          policyConfigJson: cloneValue(BASELINE_ISSUE10_POLICY),
          isActive: true,
        },
      ],
      [
        cannabisOrgId,
        {
          id: cannabisOrgId,
          policyConfigJson: cloneValue(BASELINE_ISSUE10_POLICY),
          isActive: true,
        },
      ],
    ]);

    const memberships: MembershipRow[] = [
      {
        userId: HARNESS_IDS.users.CFO,
        organizationId: orgId,
        organizationName: 'Kemptville Salvage & Export Corp.',
        organizationSlug: 'kemptville-salvage-export',
        organizationType: 'SALVAGE_AND_EXPORT',
        role: 'ARCHITECT_CFO',
        isDefaultWorkspace: true,
        isActive: true,
      },
      {
        userId: HARNESS_IDS.users.CFO,
        organizationId: cannabisOrgId,
        organizationName: 'Brockville Cannabis Nursery & Proc',
        organizationSlug: 'brockville-cannabis',
        organizationType: 'CANNABIS_NURSERY_AND_PROCESSING',
        role: 'ARCHITECT_CFO',
        isDefaultWorkspace: false,
        isActive: true,
      },
      {
        userId: HARNESS_IDS.users.HUNTER,
        organizationId: orgId,
        organizationName: 'Kemptville Salvage & Export Corp.',
        organizationSlug: 'kemptville-salvage-export',
        organizationType: 'SALVAGE_AND_EXPORT',
        role: 'HUNTER_MECHANIC',
        isDefaultWorkspace: true,
        isActive: true,
      },
      {
        userId: HARNESS_IDS.users.STRIPPER,
        organizationId: orgId,
        organizationName: 'Kemptville Salvage & Export Corp.',
        organizationSlug: 'kemptville-salvage-export',
        organizationType: 'SALVAGE_AND_EXPORT',
        role: 'ONTARIO_STRIPPER',
        isDefaultWorkspace: true,
        isActive: true,
      },
      {
        userId: HARNESS_IDS.users.VAULT,
        organizationId: orgId,
        organizationName: 'Kemptville Salvage & Export Corp.',
        organizationSlug: 'kemptville-salvage-export',
        organizationType: 'SALVAGE_AND_EXPORT',
        role: 'TRINIDAD_VAULT_ADMIN',
        isDefaultWorkspace: true,
        isActive: true,
      },
      {
        userId: HARNESS_IDS.users.QAP,
        organizationId: cannabisOrgId,
        organizationName: 'Brockville Cannabis Nursery & Proc',
        organizationSlug: 'brockville-cannabis',
        organizationType: 'CANNABIS_NURSERY_AND_PROCESSING',
        role: 'CANNABIS_QAP_COMPLIANCE',
        isDefaultWorkspace: true,
        isActive: true,
      },
    ];

    const vehicles = new Map<string, InMemoryHarnessVehicle>([
      [
        HARNESS_IDS.vehicles.CRV_DONOR,
        {
          id: HARNESS_IDS.vehicles.CRV_DONOR,
          organizationId: orgId,
          internalStockNumber: 'STK-2018-CRV',
          assetCategory: 'AUTOMOBILE',
          year: 2018,
          make: 'Honda',
          model: 'CR-V',
          trim: 'EX-L AWD',
          engineSpec: '1.5L L4 Turbo',
          vinOrHin: '2HKRW2H8XJH100001',
          odometerKm: 112_400,
          engineHours: null,
          operationalLane: 'DISMANTLE_AND_EXPORT',
          lifecycleState: 'DISMANTLING_IN_PROGRESS',
          availabilityState: 'AVAILABLE',
          classifiedsSyncState: 'NOT_POSTED',
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
          storageLocationOrgId: orgId,
          storageLocationAllowedOrgType: 'SALVAGE_AND_EXPORT',
          storageLocationStatus: 'ACTIVE',
          storageLocationAllowsDismantling: true,
          fluidsDrainedAt: new Date('2026-10-01T10:00:00Z'),
          actualPurchasePriceCadMinor: 250_000,
          estimatedRepairCadMinor: 0,
          targetGrossRealizationMinor: 500_000,
          realizedRetailSaleCadMinor: null,
          soldAt: null,
          driveOnInitialFailAt: null,
          driveOnSscIssuedAt: null,
          driveOnSscExpiresAt: null,
          complianceWarnings: [],
          version: 1,
        },
      ],
      [
        HARNESS_IDS.vehicles.SEADOO_DONOR,
        {
          id: HARNESS_IDS.vehicles.SEADOO_DONOR,
          organizationId: orgId,
          internalStockNumber: 'STK-2019-SDX',
          assetCategory: 'WATERCRAFT',
          year: 2019,
          make: 'Sea-Doo',
          model: 'GTX 230',
          trim: 'Wake Pro',
          engineSpec: '1630cc Rotax',
          vinOrHin: 'YDV99999A919',
          odometerKm: null,
          engineHours: 78,
          operationalLane: 'DISMANTLE_AND_EXPORT',
          lifecycleState: 'DISMANTLING_IN_PROGRESS',
          availabilityState: 'AVAILABLE',
          classifiedsSyncState: 'NOT_POSTED',
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
          storageLocationOrgId: orgId,
          storageLocationAllowedOrgType: 'SALVAGE_AND_EXPORT',
          storageLocationStatus: 'ACTIVE',
          storageLocationAllowsDismantling: true,
          fluidsDrainedAt: new Date('2026-10-01T10:00:00Z'),
          actualPurchasePriceCadMinor: 350_000,
          estimatedRepairCadMinor: 0,
          targetGrossRealizationMinor: 650_000,
          realizedRetailSaleCadMinor: null,
          soldAt: null,
          driveOnInitialFailAt: null,
          driveOnSscIssuedAt: null,
          driveOnSscExpiresAt: null,
          complianceWarnings: [],
          version: 1,
        },
      ],
      [
        HARNESS_IDS.vehicles.RETAIL_CAR,
        {
          id: HARNESS_IDS.vehicles.RETAIL_CAR,
          organizationId: orgId,
          internalStockNumber: 'STK-100001',
          assetCategory: 'AUTOMOBILE',
          year: 2017,
          make: 'Toyota',
          model: 'Camry',
          trim: 'SE',
          engineSpec: '2.5L I4',
          vinOrHin: '4T1BF1FK8HU100001',
          odometerKm: 138_000,
          engineHours: null,
          operationalLane: 'QUICK_TURN_BEATER',
          lifecycleState: 'READY_FOR_RETAIL_SALE',
          availabilityState: 'AVAILABLE',
          classifiedsSyncState: 'NOT_POSTED',
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
          storageLocationOrgId: orgId,
          storageLocationAllowedOrgType: 'SALVAGE_AND_EXPORT',
          storageLocationStatus: 'ACTIVE',
          storageLocationAllowsDismantling: true,
          fluidsDrainedAt: null,
          actualPurchasePriceCadMinor: 400_000,
          estimatedRepairCadMinor: 100_000,
          targetGrossRealizationMinor: 850_000,
          realizedRetailSaleCadMinor: null,
          soldAt: null,
          driveOnInitialFailAt: null,
          driveOnSscIssuedAt: null,
          driveOnSscExpiresAt: null,
          complianceWarnings: [],
          version: 1,
        },
      ],
      [
        HARNESS_IDS.vehicles.RETAIL_POWERSPORTS,
        {
          id: HARNESS_IDS.vehicles.RETAIL_POWERSPORTS,
          organizationId: orgId,
          internalStockNumber: 'STK-100002',
          assetCategory: 'WATERCRAFT',
          year: 2020,
          make: 'Ski-Doo',
          model: 'Renegade',
          trim: 'X-RS',
          engineSpec: '850 E-TEC',
          vinOrHin: '2BPS99990LV000002',
          odometerKm: 2_800,
          engineHours: null,
          operationalLane: 'QUICK_TURN_BEATER',
          lifecycleState: 'READY_FOR_RETAIL_SALE',
          availabilityState: 'AVAILABLE',
          classifiedsSyncState: 'NOT_POSTED',
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
          storageLocationOrgId: orgId,
          storageLocationAllowedOrgType: 'SALVAGE_AND_EXPORT',
          storageLocationStatus: 'ACTIVE',
          storageLocationAllowsDismantling: true,
          fluidsDrainedAt: null,
          actualPurchasePriceCadMinor: 300_000,
          estimatedRepairCadMinor: 50_000,
          targetGrossRealizationMinor: 0,
          realizedRetailSaleCadMinor: null,
          soldAt: null,
          driveOnInitialFailAt: null,
          driveOnSscIssuedAt: null,
          driveOnSscExpiresAt: null,
          complianceWarnings: [],
          version: 1,
        },
      ],
    ]);

    const parts = new Map<string, InMemoryHarnessPart>([
      [
        HARNESS_IDS.parts.ALTERNATOR,
        {
          id: HARNESS_IDS.parts.ALTERNATOR,
          organizationId: orgId,
          qrSkuCode: 'PRT-884920',
          donorVehicleId: HARNESS_IDS.vehicles.CRV_DONOR,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: 'CLEARED_FOR_SALE',
          partCategoryName: 'Alternator',
          steeringSideCompatibility: 'UNIVERSAL',
          isHazmatOrAirbag: false,
          tdgHazmatCode: 'NONE',
          oemPartNumbers: ['31100-5PA-A01'],
          araGrade: 'GRADE_A',
          araDamageCode: '00-00',
          weightKg: 6.4,
          rawPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/media/99999999-1111-4111-8111-111111111111.webp`,
          ],
          cleanPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/parts/PRT-884920/clean-1.webp`,
          ],
          compBaselineCadMinor: 16_000,
          retailPriceCadMinor: 14_500,
          ebayListingId: null,
          ebayTitle: null,
          ebayCompatibilityJson: null,
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
          storageLocationBarcode: 'KEMP-C01-R01-B01',
          version: 1,
        },
      ],
      [
        HARNESS_IDS.parts.STEERING_RACK,
        {
          id: HARNESS_IDS.parts.STEERING_RACK,
          organizationId: orgId,
          qrSkuCode: 'PRT-884921',
          donorVehicleId: HARNESS_IDS.vehicles.CRV_DONOR,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: 'CLEARED_FOR_SALE',
          partCategoryName: 'Steering Rack',
          steeringSideCompatibility: 'LHD_ONLY',
          isHazmatOrAirbag: false,
          tdgHazmatCode: 'NONE',
          oemPartNumbers: ['53601-TLA-A51'],
          araGrade: 'GRADE_B1',
          araDamageCode: '01-01',
          weightKg: 11.2,
          rawPhotoUrls: [],
          cleanPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/parts/PRT-884921/clean-1.webp`,
          ],
          compBaselineCadMinor: 28_000,
          retailPriceCadMinor: 24_500,
          ebayListingId: null,
          ebayTitle: null,
          ebayCompatibilityJson: null,
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C02,
          storageLocationBarcode: 'KEMP-C02-R01-B01',
          version: 1,
        },
      ],
      [
        HARNESS_IDS.parts.AIRBAG,
        {
          id: HARNESS_IDS.parts.AIRBAG,
          organizationId: orgId,
          qrSkuCode: 'PRT-884922',
          donorVehicleId: HARNESS_IDS.vehicles.CRV_DONOR,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: 'QUARANTINED_RECALL_OR_DG',
          partCategoryName: 'Airbag Module',
          steeringSideCompatibility: 'UNIVERSAL',
          isHazmatOrAirbag: true,
          tdgHazmatCode: 'UN3268_AIRBAG',
          oemPartNumbers: ['77960-TLA-A24'],
          araGrade: 'GRADE_A',
          araDamageCode: '00-00',
          weightKg: 1.5,
          rawPhotoUrls: [],
          cleanPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/media/99999999-2222-4222-8222-222222222222.webp`,
          ],
          compBaselineCadMinor: 19_000,
          retailPriceCadMinor: 18_000,
          ebayListingId: null,
          ebayTitle: null,
          ebayCompatibilityJson: null,
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
          storageLocationBarcode: 'KEMP-C01-R01-B02',
          version: 1,
        },
      ],
      [
        HARNESS_IDS.parts.ENGINE_POWERTRAIN,
        {
          id: HARNESS_IDS.parts.ENGINE_POWERTRAIN,
          organizationId: orgId,
          qrSkuCode: 'PRT-884923',
          donorVehicleId: HARNESS_IDS.vehicles.CRV_DONOR,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: 'CLEARED_FOR_SALE',
          partCategoryName: 'Complete Engine Assembly',
          steeringSideCompatibility: 'UNIVERSAL',
          isHazmatOrAirbag: false,
          tdgHazmatCode: 'NONE',
          oemPartNumbers: ['10002-5PA-A00'],
          araGrade: 'GRADE_A',
          araDamageCode: '00-00',
          weightKg: 135.0,
          rawPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/media/99999999-3333-4333-8333-333333333333.webp`,
          ],
          cleanPhotoUrls: [],
          compBaselineCadMinor: 200_000,
          retailPriceCadMinor: null,
          ebayListingId: null,
          ebayTitle: null,
          ebayCompatibilityJson: null,
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
          storageLocationBarcode: 'KEMP-C01-BULK-01',
          version: 1,
        },
      ],
      [
        HARNESS_IDS.parts.STARTER_GRADE_B1,
        {
          id: HARNESS_IDS.parts.STARTER_GRADE_B1,
          organizationId: orgId,
          qrSkuCode: 'PRT-884924',
          donorVehicleId: HARNESS_IDS.vehicles.CRV_DONOR,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: 'CLEARED_FOR_SALE',
          partCategoryName: 'Starter',
          steeringSideCompatibility: 'UNIVERSAL',
          isHazmatOrAirbag: false,
          tdgHazmatCode: 'NONE',
          oemPartNumbers: ['31200-5PA-A01'],
          araGrade: 'GRADE_B1',
          araDamageCode: '02-01',
          weightKg: 4.5,
          rawPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/media/99999999-4444-4444-8444-444444444444.webp`,
          ],
          cleanPhotoUrls: [],
          compBaselineCadMinor: 20_000,
          retailPriceCadMinor: null,
          ebayListingId: null,
          ebayTitle: null,
          ebayCompatibilityJson: null,
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
          storageLocationBarcode: 'KEMP-C01-R02-B01',
          version: 1,
        },
      ],
      [
        HARNESS_IDS.parts.BATTERY_TDG,
        {
          id: HARNESS_IDS.parts.BATTERY_TDG,
          organizationId: orgId,
          qrSkuCode: 'PRT-884925',
          donorVehicleId: HARNESS_IDS.vehicles.CRV_DONOR,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          ebaySyncState: 'NOT_LISTED',
          classifiedsSyncState: 'NOT_POSTED',
          complianceState: 'CLEARED_FOR_SALE',
          partCategoryName: 'Lead-Acid Wet Battery',
          steeringSideCompatibility: 'UNIVERSAL',
          isHazmatOrAirbag: true,
          tdgHazmatCode: 'UN2794_WET_BATTERY',
          oemPartNumbers: ['31500-TLA-100'],
          araGrade: 'GRADE_A',
          araDamageCode: '00-00',
          weightKg: 12.0,
          rawPhotoUrls: [],
          cleanPhotoUrls: [
            `https://cdn.salvage-erp.local/${orgId}/media/99999999-5555-4555-8555-555555555555.webp`,
          ],
          compBaselineCadMinor: 16_000,
          retailPriceCadMinor: 16_000,
          ebayListingId: null,
          ebayTitle: null,
          ebayCompatibilityJson: null,
          storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
          storageLocationBarcode: 'KEMP-C01-R03-B01',
          version: 1,
        },
      ],
    ]);

    return {
      organizations,
      memberships,
      parts,
      vehicles,
      sales: new Map(),
      cashTransfers: [],
      custodyEvents: [],
      outboxEvents: [],
      auditLogs: [],
      receipts: new Map(),
    };
  }

  public makeSession(options?: {
    userId?: string;
    organizationId?: string;
    role?: UserRole;
    organizationType?: OrganizationType;
    aal?: 'aal1' | 'aal2';
    mfaEnrolled?: boolean;
  }): AuthSessionContext {
    const userId = options?.userId ?? HARNESS_IDS.users.CFO;
    const organizationId = options?.organizationId ?? HARNESS_IDS.orgs.SALVAGE;
    const role = options?.role ?? 'ARCHITECT_CFO';
    const organizationType =
      options?.organizationType ?? 'SALVAGE_AND_EXPORT';

    const activeMemberships: ActiveMembershipSummary[] = this.store.memberships
      .filter((m) => m.userId === userId && m.isActive)
      .map((m) => ({
        membershipId: '30000000-0000-4000-8000-000000000001',
        organizationId: m.organizationId,
        organizationSlug: m.organizationSlug,
        organizationName: m.organizationName,
        organizationType: m.organizationType,
        role: m.role,
        isDefaultWorkspace: m.isDefaultWorkspace,
      }));

    if (
      activeMemberships.length === 0 ||
      !activeMemberships.some((m) => m.organizationId === organizationId)
    ) {
      activeMemberships.push({
        membershipId: '30000000-0000-4000-8000-000000000099',
        organizationId,
        organizationSlug: 'workspace-active',
        organizationName: 'Active Workspace',
        organizationType,
        role,
        isDefaultWorkspace: true,
      });
    }

    return createAuthSessionContext({
      userId,
      activeOrganizationId: organizationId,
      role,
      activeOrganizationType: organizationType,
      activeMemberships,
      aal: options?.aal ?? 'aal2',
      mfaEnrolled: options?.mfaEnrolled ?? true,
    });
  }

  public revokeMembership(userId: string, organizationId: string): void {
    for (const m of this.store.memberships) {
      if (m.userId === userId && m.organizationId === organizationId) {
        m.isActive = false;
      }
    }
  }

  public setPolicyOverride(
    organizationId: string,
    patch: Partial<PricingAndCompliancePolicy>,
  ): void {
    const existing = this.store.organizations.get(organizationId);
    if (!existing) {
      throw new Error(`Unknown organization ${organizationId}`);
    }
    const base =
      (existing.policyConfigJson as PricingAndCompliancePolicy) ??
      BASELINE_ISSUE10_POLICY;
    existing.policyConfigJson = {
      ...base,
      ...patch,
    };
  }

  public addCashSweepTransfer(input: {
    id?: string;
    organizationId: string;
    transferCode: string;
    fromCustodyState?: CashCustodyState;
    toCustodyState?: CashCustodyState;
    amountMinor: number;
    depositSlipStorageKey: string;
    recordedByUserId: string;
    custodyHolderUserId?: string | null;
    transferredAt?: Date;
  }): EligibleCashSweepTransferRow {
    const row: EligibleCashSweepTransferRow = {
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      transferCode: input.transferCode,
      marketNode: 'DOMESTIC_ORIGIN',
      fromCustodyState: input.fromCustodyState ?? 'HELD_IN_OPERATOR_FLOAT',
      toCustodyState: input.toCustodyState ?? 'SETTLED_ORIGIN_CORP_BANK',
      currency: 'CAD',
      amountMinor: input.amountMinor,
      equivalentCadMinor: input.amountMinor,
      depositSlipStorageKey: input.depositSlipStorageKey,
      recordedByUserId: input.recordedByUserId,
      custodyHolderUserId:
        input.custodyHolderUserId === undefined
          ? input.recordedByUserId
          : input.custodyHolderUserId,
      transferredAt: input.transferredAt ?? this.nowDate,
    };
    this.store.cashTransfers.push(row);
    return row;
  }

  private assertActiveMembershipInStore(ctx: TenantExecutionContext): void {
    const org = this.store.organizations.get(ctx.organizationId);
    if (!org || !org.isActive) {
      throw new TenantContextError(
        'TENANT_CONTEXT_UNAUTHORIZED',
        'Active organization missing or inactive.',
      );
    }
    const member = this.store.memberships.find(
      (m) =>
        m.userId === ctx.userId &&
        m.organizationId === ctx.organizationId &&
        m.isActive &&
        m.role === ctx.role,
    );
    if (!member) {
      throw new TenantContextError(
        'TENANT_CONTEXT_UNAUTHORIZED',
        'Membership revoked or inactive for organization.',
      );
    }
  }

  private async runWithRollback<T>(
    ctx: TenantExecutionContext,
    fn: (snapshot: HarnessStoreSnapshot) => Promise<T>,
  ): Promise<T> {
    try {
      this.assertActiveMembershipInStore(ctx);
    } catch (error) {
      translateTenantContextError(error);
    }
    const backup = cloneValue(this.store);
    try {
      return await fn(this.store);
    } catch (error) {
      this.store = backup;
      throw error;
    }
  }

  public createStorageAdapter(): InMemoryStorageAdapter {
    const self = this;
    const securityRepository: StorageSecurityRepository = {
      async verifyActiveTenantAccess(ctx) {
        self.assertActiveMembershipInStore(ctx);
      },
      async recordPrivateEvidenceAudit(ctx, event) {
        self.assertActiveMembershipInStore(ctx);
        self.store.auditLogs.push({
          id: event.auditId,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          entityType: event.entityType,
          entityId: event.entityId,
          action: event.action,
          previousState: null,
          nextState: event.nextState,
          createdAt: event.createdAt,
        });
      },
    };
    return new InMemoryStorageAdapter({
      securityRepository,
      clock: { now: () => this.nowDate },
    });
  }

  private toSyndicationPartRecord(p: InMemoryHarnessPart): SyndicationPartRecord {
    const donor = this.store.vehicles.get(p.donorVehicleId);
    if (!donor) {
      throw new Error(`Missing donor vehicle ${p.donorVehicleId}`);
    }
    const hasActiveSale = [...this.store.sales.values()].some(
      (s) =>
        s.organizationId === p.organizationId &&
        s.partItems.some((item) => item.partId === p.id && item.isActiveSale),
    );
    return {
      ...cloneValue(p),
      hasActiveSale,
      donorVehicle: {
        id: donor.id,
        organizationId: donor.organizationId,
        assetCategory: donor.assetCategory,
        year: donor.year,
        make: donor.make,
        model: donor.model,
        trim: donor.trim,
        engineSpec: donor.engineSpec,
        vinOrHin: donor.vinOrHin,
        odometerKm: donor.odometerKm,
        engineHours: donor.engineHours,
      },
    };
  }

  public computeLedgerProjection(organizationId: string): PersistedLedgerProjection {
    const org = this.store.organizations.get(organizationId);
    const policy =
      (org?.policyConfigJson as PricingAndCompliancePolicy) ??
      BASELINE_ISSUE10_POLICY;

    const saleRows: PersistedSaleLedgerRow[] = [...this.store.sales.values()]
      .filter((s) => s.organizationId === organizationId)
      .map((s) => ({
        id: s.id,
        organizationId: s.organizationId,
        marketNode: s.marketNode,
        domesticChannel: s.domesticChannel,
        exportChannel: s.exportChannel as PersistedSaleLedgerRow['exportChannel'],
        paymentCurrency: s.paymentCurrency,
        taxCollectionMode: s.taxCollectionMode,
        subtotalMinor: s.subtotalMinor,
        taxOrVatMinor: s.taxOrVatMinor,
        buyerTaxRemittedByPlatformMinor: s.buyerTaxRemittedByPlatformMinor,
        platformFeeMinor: s.platformFeeMinor,
        actualPlatformFeeMinor: s.actualPlatformFeeMinor,
        shippingCostMinor: s.shippingCostMinor,
        estimatedPlatformFeeTaxCadMinor: s.estimatedPlatformFeeTaxCadMinor,
        itcReceivableCadMinor: s.itcReceivableCadMinor,
        isFeeTaxInvoiceVerified: s.isFeeTaxInvoiceVerified,
        feeTaxInvoiceStorageKey: s.feeTaxInvoiceStorageKey,
        grossCollectedMinor: s.grossCollectedMinor,
        netRealizedCadMinor: s.netRealizedCadMinor,
        paymentSettlementState: s.paymentSettlementState,
        cashCustodyState: s.cashCustodyState,
        bankSettledAt: s.bankSettledAt,
        bankDepositReference: s.bankDepositReference,
        soldByUserId: s.soldByUserId,
        isVoidedOrReversed: s.isVoidedOrReversed,
        reversesSaleTxId: s.reversesSaleTxId,
      }));

    return buildPersistedLedgerProjection({
      organizationId,
      policy: {
        operationalGates: policy.operationalGates,
        compensationRules: policy.compensationRules,
      },
      saleRows,
      scrapRows: [],
      transferRows: this.store.cashTransfers
        .filter((t) => t.organizationId === organizationId)
        .map((t) => ({
          id: t.id,
          organizationId: t.organizationId,
          marketNode: t.marketNode,
          fromCustodyState: t.fromCustodyState,
          toCustodyState: t.toCustodyState,
          currency: t.currency,
          amountMinor: t.amountMinor,
          equivalentCadMinor: t.equivalentCadMinor,
          depositSlipStorageKey: t.depositSlipStorageKey,
          recordedByUserId: t.recordedByUserId,
          custodyHolderUserId: t.custodyHolderUserId,
        })),
      settlementRows: [],
      expenseRows: [],
    });
  }

  public createSyndicationRepository(): SyndicationRepository {
    const self = this;
    return {
      async withTenantTransaction<T>(
        ctx: TenantExecutionContext,
        fn: (tx: SyndicationTx) => Promise<T>,
      ): Promise<T> {
        return self.runWithRollback(ctx, async (store) => {
          const tx: SyndicationTx = {
            async acquireOrganizationLock() {},
            async readOrganizationPolicyRecord(organizationId) {
              const org = store.organizations.get(organizationId);
              return org
                ? { organizationId: org.id, policyConfigJson: org.policyConfigJson }
                : null;
            },
            async findCommandReceipt(_organizationId, receiptAuditId) {
              const found = store.receipts.get(receiptAuditId);
              return found ? cloneValue(found as StoredSyndicationReceipt) : null;
            },
            async findCommittedExportReceiptByExportId(organizationId, exportId) {
              for (const r of store.receipts.values()) {
                const candidate = r.result as Partial<ExportEbayCsvResult> | null;
                if (
                  candidate &&
                  candidate.format === 'EBAY_CSV' &&
                  candidate.organizationId === organizationId &&
                  candidate.exportId === exportId
                ) {
                  return cloneValue(candidate as ExportEbayCsvResult);
                }
              }
              return null;
            },
            async findPartsForSyndication(organizationId, filter) {
              return [...store.parts.values()]
                .filter((p) => {
                  if (p.organizationId !== organizationId) return false;
                  if (filter?.partIds && filter.partIds.length > 0) {
                    return filter.partIds.includes(p.id);
                  }
                  if (filter?.qrSkuCodeOrId) {
                    return (
                      p.id.toLowerCase() === filter.qrSkuCodeOrId.toLowerCase() ||
                      p.qrSkuCode.toUpperCase() ===
                        filter.qrSkuCodeOrId.toUpperCase()
                    );
                  }
                  return true;
                })
                .map((p) => self.toSyndicationPartRecord(p));
            },
            async lockPartsByIds(organizationId, partIds) {
              return [...store.parts.values()]
                .filter(
                  (p) =>
                    p.organizationId === organizationId && partIds.includes(p.id),
                )
                .map((p) => self.toSyndicationPartRecord(p));
            },
            async ebayListingIdExists(ebayListingId, excludePartId) {
              return [...store.parts.values()].some(
                (p) => p.ebayListingId === ebayListingId && p.id !== excludePartId,
              );
            },
            async updatePartSyndicationState(input) {
              const part = store.parts.get(input.partId);
              if (
                !part ||
                part.organizationId !== input.organizationId ||
                part.version !== input.expectedVersion
              ) {
                return false;
              }
              if (input.ebaySyncState !== undefined) {
                part.ebaySyncState = input.ebaySyncState;
              }
              if (input.classifiedsSyncState !== undefined) {
                part.classifiedsSyncState = input.classifiedsSyncState;
              }
              if (input.ebayListingId !== undefined) {
                part.ebayListingId = input.ebayListingId;
              }
              if (input.ebayTitle !== undefined) {
                part.ebayTitle = input.ebayTitle;
              }
              part.version = input.nextVersion;
              return true;
            },
            async listUrgentDelistParts(organizationId) {
              return [...store.parts.values()]
                .filter(
                  (p) =>
                    p.organizationId === organizationId &&
                    (p.ebaySyncState === 'DELIST_PENDING' ||
                      p.classifiedsSyncState === 'DELIST_REQUIRED'),
                )
                .map((p) => self.toSyndicationPartRecord(p));
            },
            async insertAuditLog(record: PersistSyndicationAuditInput) {
              store.auditLogs.push(cloneValue(record));
              const next = record.nextState as Record<string, unknown>;
              if (
                typeof next.idempotencyKey === 'string' &&
                typeof next.commandFingerprint === 'string' &&
                'result' in next
              ) {
                store.receipts.set(record.id, {
                  auditId: record.id,
                  action:
                    typeof next.action === 'string'
                      ? next.action
                      : record.action,
                  idempotencyKey: next.idempotencyKey,
                  commandFingerprint: next.commandFingerprint,
                  result: cloneValue(next.result),
                });
              }
            },
          };
          return fn(tx);
        });
      },
    };
  }

  public createDomesticCheckoutRepository(): DomesticCheckoutRepository {
    const self = this;
    return {
      async withTenantTransaction<T>(
        ctx: TenantExecutionContext,
        fn: (tx: DomesticCheckoutTx) => Promise<T>,
      ): Promise<T> {
        return self.runWithRollback(ctx, async (store) => {
          const tx: DomesticCheckoutTx = {
            async acquireOrganizationLock() {},
            async readOrganizationPolicyRecord(organizationId) {
              const org = store.organizations.get(organizationId);
              return org
                ? { organizationId: org.id, policyConfigJson: org.policyConfigJson }
                : null;
            },
            async findCommandReceipt(_organizationId, receiptAuditId) {
              const found = store.receipts.get(receiptAuditId);
              return found ? cloneValue(found as StoredCheckoutReceipt) : null;
            },
            async lockPartsByIds(organizationId, partIds) {
              return [...store.parts.values()]
                .filter(
                  (p) =>
                    p.organizationId === organizationId && partIds.includes(p.id),
                )
                .map((p) => self.toCheckoutPartRow(p));
            },
            async lockVehiclesByIds(organizationId, vehicleIds) {
              return [...store.vehicles.values()]
                .filter(
                  (v) =>
                    v.organizationId === organizationId &&
                    vehicleIds.includes(v.id),
                )
                .map((v) => self.toCheckoutVehicleRow(v));
            },
            async lookupCheckoutItems(organizationId, query) {
              const codeFilter = query?.code?.trim().toLowerCase();
              const parts = [...store.parts.values()]
                .filter((p) => {
                  if (p.organizationId !== organizationId) return false;
                  if (!codeFilter) return true;
                  return (
                    p.qrSkuCode.toLowerCase().includes(codeFilter) ||
                    p.id.toLowerCase() === codeFilter
                  );
                })
                .map((p) => self.toCheckoutPartRow(p));

              const vehicles = [...store.vehicles.values()]
                .filter((v) => {
                  if (v.organizationId !== organizationId) return false;
                  if (
                    v.operationalLane !== 'QUICK_TURN_BEATER' &&
                    v.operationalLane !== 'HIGH_END_REBUILD'
                  ) {
                    return false;
                  }
                  if (!codeFilter) return true;
                  return (
                    v.internalStockNumber.toLowerCase().includes(codeFilter) ||
                    v.id.toLowerCase() === codeFilter
                  );
                })
                .map((v) => self.toCheckoutVehicleRow(v));

              return { parts, vehicles };
            },
            async findAndLockSaleTransaction(organizationId, saleId) {
              const sale = store.sales.get(saleId);
              if (!sale || sale.organizationId !== organizationId) {
                return null;
              }
              return cloneValue(sale);
            },
            async findLinkedReversalSale(organizationId, originalSaleId) {
              for (const s of store.sales.values()) {
                if (
                  s.organizationId === organizationId &&
                  s.reversesSaleTxId === originalSaleId
                ) {
                  return cloneValue(s);
                }
              }
              return null;
            },
            async listDomesticSales(organizationId, limit = 100) {
              return [...store.sales.values()]
                .filter(
                  (s) =>
                    s.organizationId === organizationId &&
                    s.marketNode === 'DOMESTIC_ORIGIN',
                )
                .slice(0, limit)
                .map((s) => cloneValue(s));
            },
            async listEligibleFloatToBankTransfers(
              organizationId,
              sellerUserId,
              upTo,
            ) {
              const normalizedSeller = sellerUserId.toLowerCase();
              return store.cashTransfers
                .filter((t) => {
                  const holder = (
                    t.custodyHolderUserId ?? t.recordedByUserId
                  ).toLowerCase();
                  return (
                    t.organizationId === organizationId &&
                    t.marketNode === 'DOMESTIC_ORIGIN' &&
                    t.fromCustodyState === 'HELD_IN_OPERATOR_FLOAT' &&
                    t.toCustodyState === 'SETTLED_ORIGIN_CORP_BANK' &&
                    t.currency === 'CAD' &&
                    t.transferredAt.getTime() <= upTo.getTime() &&
                    holder === normalizedSeller &&
                    t.depositSlipStorageKey.trim().length > 0
                  );
                })
                .sort((a, b) => {
                  const timeDiff =
                    b.transferredAt.getTime() - a.transferredAt.getTime();
                  if (timeDiff !== 0) return timeDiff;
                  return b.id.localeCompare(a.id);
                })
                .map((t) => cloneValue(t));
            },
            async loadLedgerProjection(organizationId) {
              return self.computeLedgerProjection(organizationId);
            },
            async insertSaleTransaction(record) {
              store.sales.set(record.id, {
                ...cloneValue(record),
                partItems: [],
                vehicleItems: [],
              });
            },
            async insertSalePartItems(items) {
              for (const item of items) {
                const sale = store.sales.get(item.saleTransactionId);
                if (sale) {
                  (sale.partItems as Array<typeof item>).push(cloneValue(item));
                }
              }
            },
            async insertSaleVehicleItems(items) {
              for (const item of items) {
                const sale = store.sales.get(item.saleTransactionId);
                if (sale) {
                  (sale.vehicleItems as Array<typeof item>).push(cloneValue(item));
                }
              }
            },
            async updatePartAfterCheckoutOrReturn(input) {
              const part = store.parts.get(input.partId);
              if (
                !part ||
                part.organizationId !== input.organizationId ||
                part.version !== input.expectedVersion
              ) {
                return false;
              }
              part.custodyState = input.custodyState;
              part.availabilityState = input.availabilityState;
              part.ebaySyncState = input.ebaySyncState;
              part.classifiedsSyncState = input.classifiedsSyncState;
              part.complianceState = input.complianceState;
              part.version = input.nextVersion;
              return true;
            },
            async updateVehicleAfterCheckout(input) {
              const v = store.vehicles.get(input.vehicleId);
              if (
                !v ||
                v.organizationId !== input.organizationId ||
                v.version !== input.expectedVersion
              ) {
                return false;
              }
              v.lifecycleState = input.lifecycleState;
              v.availabilityState = input.availabilityState;
              v.classifiedsSyncState = input.classifiedsSyncState;
              v.complianceWarnings = [...input.complianceWarnings];
              v.realizedRetailSaleCadMinor = input.realizedRetailSaleCadMinor;
              v.soldAt = input.soldAt;
              v.version = input.nextVersion;
              return true;
            },
            async updateSaleBankSettlement(input) {
              const sale = store.sales.get(input.saleId);
              if (!sale || sale.organizationId !== input.organizationId) {
                throw new Error(`Missing sale ${input.saleId}`);
              }
              store.sales.set(input.saleId, {
                ...sale,
                paymentSettlementState: input.paymentSettlementState,
                cashCustodyState: input.cashCustodyState,
                paymentConfirmedAt: input.paymentConfirmedAt,
                bankSettledAt: input.bankSettledAt,
                bankDepositReference: input.bankDepositReference,
                settlementProofStorageKey: input.settlementProofStorageKey,
                actualPlatformFeeMinor: input.actualPlatformFeeMinor,
                isFeeTaxInvoiceVerified: input.isFeeTaxInvoiceVerified,
                feeTaxInvoiceStorageKey: input.feeTaxInvoiceStorageKey,
                itcReceivableCadMinor: input.itcReceivableCadMinor,
                isPaymentVerified: input.isPaymentVerified,
                gateReleasedAt: input.gateReleasedAt,
              });
            },
            async markSaleRefundedOrChargedBack(input) {
              const sale = store.sales.get(input.saleId);
              if (!sale || sale.organizationId !== input.organizationId) {
                throw new Error(`Missing sale ${input.saleId}`);
              }
              store.sales.set(input.saleId, {
                ...sale,
                paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
                isVoidedOrReversed: true,
                voidReason: input.voidReason,
                partItems: sale.partItems.map((p) => ({ ...p, isActiveSale: false })),
                vehicleItems: sale.vehicleItems.map((v) => ({
                  ...v,
                  isActiveSale: false,
                })),
              });
            },
            async insertCustodyEvent(record) {
              store.custodyEvents.push(cloneValue(record));
            },
            async insertOutboxEvent(record) {
              store.outboxEvents.push(cloneValue(record));
            },
            async insertAuditLog(record) {
              store.auditLogs.push(cloneValue(record));
              const next = record.nextState as Record<string, unknown>;
              if (
                typeof next.idempotencyKey === 'string' &&
                typeof next.commandFingerprint === 'string' &&
                'result' in next
              ) {
                store.receipts.set(record.id, {
                  auditId: record.id,
                  action:
                    typeof next.action === 'string'
                      ? next.action
                      : record.action,
                  idempotencyKey: next.idempotencyKey,
                  commandFingerprint: next.commandFingerprint,
                  result: cloneValue(next.result),
                });
              }
            },
          };
          return fn(tx);
        });
      },
    };
  }

  private toCheckoutPartRow(p: InMemoryHarnessPart): CheckoutLockedPartRow {
    const hasActiveSale = [...this.store.sales.values()].some(
      (s) =>
        s.organizationId === p.organizationId &&
        s.partItems.some((item) => item.partId === p.id && item.isActiveSale),
    );
    return {
      ...cloneValue(p),
      hasActiveSale,
    };
  }

  private toCheckoutVehicleRow(
    v: InMemoryHarnessVehicle,
  ): CheckoutLockedVehicleRow {
    const hasActiveSale = [...this.store.sales.values()].some(
      (s) =>
        s.organizationId === v.organizationId &&
        s.vehicleItems.some((item) => item.vehicleId === v.id && item.isActiveSale),
    );
    return {
      ...cloneValue(v),
      hasActiveSale,
    };
  }

  public createUseCases(): {
    readonly templateService: SyndicationTemplateService;
    readonly ebayExporter: EbayCsvExporterUseCase;
    readonly localQueue: LocalClassifiedsQueueUseCase;
    readonly checkoutUseCase: ExecuteDomesticCheckoutUseCase;
    readonly storage: InMemoryStorageAdapter;
  } {
    const templateService = new SyndicationTemplateService();
    const syndicationRepo = this.createSyndicationRepository();
    const checkoutRepo = this.createDomesticCheckoutRepository();
    const storage = this.createStorageAdapter();
    const clock = { now: () => this.nowDate };

    return {
      templateService,
      ebayExporter: new EbayCsvExporterUseCase({
        repository: syndicationRepo,
        clock,
      }),
      localQueue: new LocalClassifiedsQueueUseCase({
        repository: syndicationRepo,
        clock,
      }),
      checkoutUseCase: new ExecuteDomesticCheckoutUseCase({
        repository: checkoutRepo,
        storage,
        clock,
      }),
      storage,
    };
  }

  public createRouteDeps(sessionResolver: () => AuthSessionContext): {
    readonly syndicationDeps: SyndicationRouteDeps;
    readonly checkoutDeps: DomesticCheckoutRouteDeps;
    readonly useCases: ReturnType<Issue10OfflineTestHarness['createUseCases']>;
  } {
    const useCases = this.createUseCases();
    return {
      useCases,
      syndicationDeps: {
        resolveSession: async () => sessionResolver(),
        ebayExporterUseCase: useCases.ebayExporter,
        localQueueUseCase: useCases.localQueue,
      },
      checkoutDeps: {
        resolveSession: async () => sessionResolver(),
        checkoutUseCase: useCases.checkoutUseCase,
        storage: useCases.storage,
      },
    };
  }
}
