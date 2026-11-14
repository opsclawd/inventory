import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AssetCategory,
  AssetLifecycleState,
  AraConditionGradeEnum,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  EbaySyncState,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  Prisma,
  PrismaClient,
  RoadVehicleBrand,
  ScrapStreamCategory,
  StatutoryVehiclePurpose,
  SteeringSideCompatibility,
  TdgHazmatCode,
  UserRole,
  VehicleAcquisitionSource,
} from '@prisma/client';

export class SeedConflictError extends Error {
  public readonly code = 'SEED_CONFLICT_ERROR' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'SeedConflictError';
  }
}

export const PHASE1A_SEED_TIMESTAMP = new Date('2026-11-01T12:00:00.000Z');

export const PHASE1A_SEED_IDS = {
  orgs: {
    ORG_SALVAGE_EXPORT: '10000000-0000-4000-8000-000000000001',
    ORG_CANNABIS_NURSERY_PROC: '10000000-0000-4000-8000-000000000002',
  },
  users: {
    architectCfo: '20000000-0000-4000-8000-000000000001',
    hunterMechanic: '20000000-0000-4000-8000-000000000002',
    ontarioStripper: '20000000-0000-4000-8000-000000000003',
    trinidadVaultAdmin: '20000000-0000-4000-8000-000000000004',
    overseasBuyer: '20000000-0000-4000-8000-000000000005',
    revokedContractor: '20000000-0000-4000-8000-000000000006',
    cannabisQap: '20000000-0000-4000-8000-000000000007',
    nurseryTech: '20000000-0000-4000-8000-000000000008',
  },
  memberships: {
    cfoSalvage: '30000000-0000-4000-8000-000000000001',
    cfoCannabis: '30000000-0000-4000-8000-000000000002',
    hunterSalvage: '30000000-0000-4000-8000-000000000003',
    stripperSalvage: '30000000-0000-4000-8000-000000000004',
    vaultAdminSalvage: '30000000-0000-4000-8000-000000000005',
    buyerSalvage: '30000000-0000-4000-8000-000000000006',
    revokedContractorSalvage: '30000000-0000-4000-8000-000000000007',
    qapCannabis: '30000000-0000-4000-8000-000000000008',
    nurseryTechCannabis: '30000000-0000-4000-8000-000000000009',
  },
  locations: {
    KEMP_ZONE_CONTAINER_PAD: '40000000-0000-4000-8000-000000000001',
    KEMP_C01: '40000000-0000-4000-8000-000000000002',
    KEMP_C02: '40000000-0000-4000-8000-000000000003',
    KEMP_C03: '40000000-0000-4000-8000-000000000004',
    KEMP_C04: '40000000-0000-4000-8000-000000000005',
    RAMS_SHOP: '40000000-0000-4000-8000-000000000006',
    POSV_VAULT: '40000000-0000-4000-8000-000000000007',
    BROCK_SITE_FACILITY: '40000000-0000-4000-8000-000000000008',
    BROCK_PROP_R1_T2: '40000000-0000-4000-8000-000000000009',
  },
  vehicles: {
    donorCrv2018: '50000000-0000-4000-8000-000000000001',
    watercraftSeadoo2019: '50000000-0000-4000-8000-000000000002',
  },
  parts: {
    alternator: '60000000-0000-4000-8000-000000000001',
    steeringRack: '60000000-0000-4000-8000-000000000002',
    airbagModule: '60000000-0000-4000-8000-000000000003',
  },
  scrapLogs: {
    catalyticConverter: '70000000-0000-4000-8000-000000000001',
    alloyWheels: '70000000-0000-4000-8000-000000000002',
  },
  shipments: {
    dormantExport001: '80000000-0000-4000-8000-000000000001',
  },
} as const;

export interface SeedOrganizationInput {
  id: string;
  slug: string;
  name: string;
  legalEntityName: string;
  organizationType: OrganizationType;
  policyConfigJson: Record<string, unknown> | null;
  craBusinessNumberBn15: string | null;
  healthCanadaLicenseNumber: string | null;
  isActive: boolean;
}

export interface SeedUserInput {
  id: string;
  email: string;
  phoneE164: string | null;
  fullName: string;
  role: UserRole;
  mfaEnrolled: boolean;
  commissionRateBps: number;
  isActive: boolean;
}

export interface SeedOrganizationMembershipInput {
  id: string;
  organizationId: string;
  userId: string;
  role: UserRole;
  isDefaultWorkspace: boolean;
  isActive: boolean;
  deactivatedAt: Date | null;
  deactivatedById: string | null;
  revocationReason: string | null;
}

export interface SeedStorageLocationInput {
  id: string;
  organizationId: string;
  allowedOrgType: OrganizationType;
  locationOperationalStatus: LocationOperationalStatus;
  allowsWholeVehicleDismantling: boolean;
  maxActiveAssetCapacity: number | null;
  siteCode: string;
  zoneCode: string;
  containerCode: string;
  rackCode: string;
  shelfCode: string;
  binCode: string;
  fullQrBarcode: string;
  maxWeightKg: number;
}

export interface SeedVehicleInput {
  id: string;
  organizationId: string;
  internalStockNumber: string;
  assetCategory: AssetCategory;
  vinOrHin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  engineSpec: string | null;
  odometerKm: number | null;
  engineHours: number | null;
  steeringSide: SteeringSideCompatibility;
  oemFitmentVerified: boolean;
  roadBrand: RoadVehicleBrand;
  operationalLane: OperationalLane;
  lifecycleState: AssetLifecycleState;
  availabilityState: InventoryAvailabilityState;
  storageLocationId: string;
  acquisitionSource: VehicleAcquisitionSource;
  declaredStatutoryPurpose: StatutoryVehiclePurpose;
  estimatedMaxBidCadMinor: number;
  actualPurchasePriceCadMinor: number;
  targetGrossRealizationMinor: number;
  fluidsDrainedAt: Date | null;
  catalyticConverterDisposition: CatalyticConverterDisposition;
  scrapRecoveryCadMinor: number;
}

export interface SeedPartInput {
  id: string;
  organizationId: string;
  qrSkuCode: string;
  donorVehicleId: string;
  strippedByUserId: string;
  custodyState: PartCustodyState;
  availabilityState: InventoryAvailabilityState;
  ebaySyncState: EbaySyncState;
  classifiedsSyncState: ClassifiedsSyncState;
  complianceState: PartComplianceState;
  partCategoryName: string;
  steeringSideCompatibility: SteeringSideCompatibility;
  oemFitmentVerified: boolean;
  isHazmatOrAirbag: boolean;
  tdgHazmatCode: TdgHazmatCode;
  oemPartNumbers: string[];
  interchangePartNumbers: string[];
  suggestedHsCode: string;
  araGrade: AraConditionGradeEnum;
  araDamageCode: string;
  weightKg: number;
  rawPhotoUrls: string[];
  cleanPhotoUrls: string[];
  storageLocationId: string;
  allocatedCostBasisCadMinor: number;
  retailPriceCadMinor: number;
  strippedAt: Date;
}

export interface SeedScrapComponentLogInput {
  id: string;
  organizationId: string;
  vehicleId: string;
  scrapStream: ScrapStreamCategory;
  weightKg: number;
  payoutCadMinor: number;
  recyclerName: string;
  recyclerTicketStorageKey: string;
  cashCustodyState: CashCustodyState;
  recordedByUserId: string;
  createdAt: Date;
}

export interface SeedShipmentInput {
  id: string;
  organizationId: string;
  shipmentCode: string;
  mode: string;
  originPort: string;
  destinationPort: string;
  exporterBn15: string;
  departedAt: Date | null;
  arrivedPortAt: Date | null;
  clearedCustomsAt: Date | null;
  cersProofOfReportNumber: string | null;
  createdAt: Date;
}

export interface Phase1ASeedTx {
  upsertOrganization(input: SeedOrganizationInput): Promise<{ created: boolean }>;
  upsertUser(input: SeedUserInput): Promise<{ created: boolean }>;
  upsertOrganizationMembership(
    input: SeedOrganizationMembershipInput,
  ): Promise<{ created: boolean }>;
  upsertStorageLocation(
    input: SeedStorageLocationInput,
  ): Promise<{ created: boolean }>;
  insertVehicleIfAbsent(input: SeedVehicleInput): Promise<{ created: boolean }>;
  insertPartIfAbsent(input: SeedPartInput): Promise<{ created: boolean }>;
  insertScrapComponentLogIfAbsent(
    input: SeedScrapComponentLogInput,
  ): Promise<{ created: boolean }>;
  insertShipmentIfAbsent(
    input: SeedShipmentInput,
  ): Promise<{ created: boolean }>;
}

export interface Phase1ASeedStore {
  withTransaction<T>(fn: (tx: Phase1ASeedTx) => Promise<T>): Promise<T>;
}

export interface SeedPhase1AResult {
  organizationsCreated: number;
  usersCreated: number;
  membershipsCreated: number;
  storageLocationsCreated: number;
  vehiclesCreated: number;
  partsCreated: number;
  scrapLogsCreated: number;
  shipmentsCreated: number;
}

export const PHASE1A_SEED_FIXTURES = {
  organizations: [
    {
      id: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      slug: 'ORG_SALVAGE_EXPORT',
      name: 'Auto & Marine Salvage (Kemptville)',
      legalEntityName: 'Ontario Salvage OpCo Inc.',
      organizationType: OrganizationType.SALVAGE_AND_EXPORT,
      policyConfigJson: {
        domesticTaxPolicy: {
          isGstHstRegistered: true,
          isOntarioEntityHstRegistered: true,
          isOntarioHstRegistered: true,
          isOmvicLicensed: false,
          publicPickupCityLabel: 'Ottawa South / Hwy 416 Corridor',
        },
        complianceThresholds: {
          easrRegistrationNumber: null,
        },
        domesticSyndication: {
          publicPickupLocationLabel: 'Ottawa South / Hwy 416 Corridor',
          ebayShipFromCity: 'Kemptville, ON',
          ebayShipFromPostalCode: 'K0G 1J0',
        },
        siteZoningLimits: {
          kemptvilleMaxUncrushedShellsOnPad: 4,
          kemptvilleContainerCount: 4,
          ramsayvilleMaxActiveShopVehicles: 8,
        },
      },
      craBusinessNumberBn15: null,
      healthCanadaLicenseNumber: null,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      slug: 'ORG_CANNABIS_NURSERY_PROC',
      name: 'Cannabis Nursery & Processing (Brockville)',
      legalEntityName: 'Brockville Cannabis Operations Inc.',
      organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      policyConfigJson: {
        domesticTaxPolicy: {
          isGstHstRegistered: false,
          isOntarioEntityHstRegistered: false,
          isOntarioHstRegistered: false,
          isOmvicLicensed: false,
        },
      },
      craBusinessNumberBn15: null,
      healthCanadaLicenseNumber: null,
      isActive: true,
    },
  ] satisfies readonly SeedOrganizationInput[],

  users: [
    {
      id: PHASE1A_SEED_IDS.users.architectCfo,
      email: 'cfo@seed.local',
      phoneE164: '+16135550101',
      fullName: 'Seed Architect CFO',
      role: UserRole.ARCHITECT_CFO,
      mfaEnrolled: true,
      commissionRateBps: 0,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.hunterMechanic,
      email: 'hunter.mechanic@seed.local',
      phoneE164: '+16135550102',
      fullName: 'Seed Hunter Mechanic',
      role: UserRole.HUNTER_MECHANIC,
      mfaEnrolled: false,
      commissionRateBps: 1000,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.ontarioStripper,
      email: 'ontario.stripper@seed.local',
      phoneE164: '+16135550103',
      fullName: 'Seed Ontario Stripper',
      role: UserRole.ONTARIO_STRIPPER,
      mfaEnrolled: false,
      commissionRateBps: 0,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.trinidadVaultAdmin,
      email: 'vault.admin@seed.local',
      phoneE164: '+18685550104',
      fullName: 'Seed Trinidad Vault Admin',
      role: UserRole.TRINIDAD_VAULT_ADMIN,
      mfaEnrolled: true,
      commissionRateBps: 0,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.overseasBuyer,
      email: 'overseas.buyer@seed.local',
      phoneE164: '+18685550105',
      fullName: 'Seed Overseas B2B Buyer',
      role: UserRole.OVERSEAS_B2B_BUYER,
      mfaEnrolled: false,
      commissionRateBps: 0,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.revokedContractor,
      email: 'revoked.contractor@seed.local',
      phoneE164: '+16135550106',
      fullName: 'Seed Revoked Contractor',
      role: UserRole.ONTARIO_STRIPPER,
      mfaEnrolled: false,
      commissionRateBps: 0,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.cannabisQap,
      email: 'cannabis.qap@seed.local',
      phoneE164: '+16135550107',
      fullName: 'Seed Cannabis QAP Compliance',
      role: UserRole.CANNABIS_QAP_COMPLIANCE,
      mfaEnrolled: true,
      commissionRateBps: 0,
      isActive: true,
    },
    {
      id: PHASE1A_SEED_IDS.users.nurseryTech,
      email: 'nursery.tech@seed.local',
      phoneE164: '+16135550108',
      fullName: 'Seed Nursery Cultivation Tech',
      role: UserRole.NURSERY_CULTIVATION_TECH,
      mfaEnrolled: false,
      commissionRateBps: 0,
      isActive: true,
    },
  ] satisfies readonly SeedUserInput[],

  memberships: [
    {
      id: PHASE1A_SEED_IDS.memberships.cfoSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.cfoCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      isDefaultWorkspace: false,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.hunterSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.hunterMechanic,
      role: UserRole.HUNTER_MECHANIC,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.stripperSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.ontarioStripper,
      role: UserRole.ONTARIO_STRIPPER,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.vaultAdminSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.trinidadVaultAdmin,
      role: UserRole.TRINIDAD_VAULT_ADMIN,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.buyerSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.overseasBuyer,
      role: UserRole.OVERSEAS_B2B_BUYER,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.revokedContractorSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.revokedContractor,
      role: UserRole.ONTARIO_STRIPPER,
      isDefaultWorkspace: false,
      isActive: false,
      deactivatedAt: PHASE1A_SEED_TIMESTAMP,
      deactivatedById: PHASE1A_SEED_IDS.users.architectCfo,
      revocationReason: 'Seeded revoked contractor fixture',
    },
    {
      id: PHASE1A_SEED_IDS.memberships.qapCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.cannabisQap,
      role: UserRole.CANNABIS_QAP_COMPLIANCE,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
    {
      id: PHASE1A_SEED_IDS.memberships.nurseryTechCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.nurseryTech,
      role: UserRole.NURSERY_CULTIVATION_TECH,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    },
  ] satisfies readonly SeedOrganizationMembershipInput[],

  storageLocations: [
    {
      id: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.ACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: 4,
      siteCode: 'KEMP',
      zoneCode: 'ZONE_CONTAINER_PAD',
      containerCode: 'PAD',
      rackCode: 'R00',
      shelfCode: 'S00',
      binCode: 'B00',
      fullQrBarcode: 'KEMP_ZONE_CONTAINER_PAD',
      maxWeightKg: 5000.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.KEMP_C01,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.ACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'KEMP',
      zoneCode: 'ZONE_CONTAINER_PAD',
      containerCode: 'C01',
      rackCode: 'R01',
      shelfCode: 'S01',
      binCode: 'B01',
      fullQrBarcode: 'KEMP-C01-R01-S01-B01',
      maxWeightKg: 150.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.KEMP_C02,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.ACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'KEMP',
      zoneCode: 'ZONE_CONTAINER_PAD',
      containerCode: 'C02',
      rackCode: 'R01',
      shelfCode: 'S01',
      binCode: 'B01',
      fullQrBarcode: 'KEMP-C02-R01-S01-B01',
      maxWeightKg: 150.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.KEMP_C03,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.ACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'KEMP',
      zoneCode: 'ZONE_CONTAINER_PAD',
      containerCode: 'C03',
      rackCode: 'R01',
      shelfCode: 'S01',
      binCode: 'B01',
      fullQrBarcode: 'KEMP-C03-R01-S01-B01',
      maxWeightKg: 150.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.KEMP_C04,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.ACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'KEMP',
      zoneCode: 'ZONE_CONTAINER_PAD',
      containerCode: 'C04',
      rackCode: 'R01',
      shelfCode: 'S01',
      binCode: 'B01',
      fullQrBarcode: 'KEMP-C04-R01-S01-B01',
      maxWeightKg: 150.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.RAMS_SHOP,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
      allowsWholeVehicleDismantling: true,
      maxActiveAssetCapacity: 8,
      siteCode: 'RAMS',
      zoneCode: 'ZONE_RAMSAYVILLE_SHOP',
      containerCode: 'SHOP',
      rackCode: 'R01',
      shelfCode: 'S01',
      binCode: 'B01',
      fullQrBarcode: 'RAMS-SHOP-R01-S01-B01',
      maxWeightKg: 5000.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.POSV_VAULT,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
      locationOperationalStatus: LocationOperationalStatus.DORMANT_FUTURE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'POSV',
      zoneCode: 'ZONE_TRINIDAD_VAULT',
      containerCode: 'V01',
      rackCode: 'R01',
      shelfCode: 'S01',
      binCode: 'B01',
      fullQrBarcode: 'POSV-V01-R01-S01-B01',
      maxWeightKg: 500.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.BROCK_SITE_FACILITY,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'BROCK',
      zoneCode: 'ZONE_BROCKVILLE_FACILITY',
      containerCode: 'SITE',
      rackCode: 'R00',
      shelfCode: 'T00',
      binCode: 'B00',
      fullQrBarcode: 'BROCK_SITE_FACILITY',
      maxWeightKg: 1000.0,
    },
    {
      id: PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
      allowsWholeVehicleDismantling: false,
      maxActiveAssetCapacity: null,
      siteCode: 'BROCK',
      zoneCode: 'ZONE_BROCKVILLE_FACILITY',
      containerCode: 'PROP',
      rackCode: 'R1',
      shelfCode: 'T2',
      binCode: 'B01',
      fullQrBarcode: 'BROCK-PROP-R1-T2',
      maxWeightKg: 150.0,
    },
  ] satisfies readonly SeedStorageLocationInput[],

  vehicles: [
    {
      id: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      internalStockNumber: 'AST-2026-0001',
      assetCategory: AssetCategory.AUTOMOBILE,
      vinOrHin: '2HKRW2H50JH000001',
      year: 2018,
      make: 'Honda',
      model: 'CR-V',
      trim: 'EX AWD',
      engineSpec: '1.5L Turbo I4',
      odometerKm: 138400,
      engineHours: null,
      steeringSide: SteeringSideCompatibility.LHD_ONLY,
      oemFitmentVerified: true,
      roadBrand: RoadVehicleBrand.SALVAGE,
      operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
      lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
      availabilityState: InventoryAvailabilityState.AVAILABLE,
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
      acquisitionSource: VehicleAcquisitionSource.LICENSED_AUCTION,
      declaredStatutoryPurpose: StatutoryVehiclePurpose.WRECKING_PARTS_ONLY,
      estimatedMaxBidCadMinor: 240000,
      actualPurchasePriceCadMinor: 215000,
      targetGrossRealizationMinor: 620000,
      fluidsDrainedAt: PHASE1A_SEED_TIMESTAMP,
      catalyticConverterDisposition:
        CatalyticConverterDisposition.LOGGED_SCRAP_SALE,
      scrapRecoveryCadMinor: 28500,
    },
    {
      id: PHASE1A_SEED_IDS.vehicles.watercraftSeadoo2019,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      internalStockNumber: 'AST-2026-0002',
      assetCategory: AssetCategory.WATERCRAFT,
      vinOrHin: 'YDV00002A919',
      year: 2019,
      make: 'Sea-Doo',
      model: 'GTI 130',
      trim: null,
      engineSpec: 'Rotax 1503 NA',
      odometerKm: null,
      engineHours: 112,
      steeringSide: SteeringSideCompatibility.UNIVERSAL,
      oemFitmentVerified: true,
      roadBrand: RoadVehicleBrand.NOT_APPLICABLE,
      operationalLane: OperationalLane.WHOLE_UNIT_EXPORT,
      lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
      availabilityState: InventoryAvailabilityState.AVAILABLE,
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
      acquisitionSource: VehicleAcquisitionSource.PRIVATE_DRIVEWAY_BUY,
      declaredStatutoryPurpose: StatutoryVehiclePurpose.EXPORT_WHOLE,
      estimatedMaxBidCadMinor: 420000,
      actualPurchasePriceCadMinor: 390000,
      targetGrossRealizationMinor: 780000,
      fluidsDrainedAt: PHASE1A_SEED_TIMESTAMP,
      catalyticConverterDisposition:
        CatalyticConverterDisposition.MISSING_AT_INTAKE,
      scrapRecoveryCadMinor: 0,
    },
  ] satisfies readonly SeedVehicleInput[],

  parts: [
    {
      id: PHASE1A_SEED_IDS.parts.alternator,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      qrSkuCode: 'PRT-884920',
      donorVehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
      strippedByUserId: PHASE1A_SEED_IDS.users.ontarioStripper,
      custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
      availabilityState: InventoryAvailabilityState.AVAILABLE,
      ebaySyncState: EbaySyncState.NOT_LISTED,
      classifiedsSyncState: ClassifiedsSyncState.NOT_POSTED,
      complianceState: PartComplianceState.CLEARED_FOR_SALE,
      partCategoryName: 'Alternator',
      steeringSideCompatibility: SteeringSideCompatibility.UNIVERSAL,
      oemFitmentVerified: true,
      isHazmatOrAirbag: false,
      tdgHazmatCode: TdgHazmatCode.NONE,
      oemPartNumbers: ['31100-5PA-A01'],
      interchangePartNumbers: ['CSD94'],
      suggestedHsCode: '8708.99',
      araGrade: AraConditionGradeEnum.GRADE_B1,
      araDamageCode: '000',
      weightKg: 5.4,
      rawPhotoUrls: [
        `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/parts/PRT-884920/raw-1.jpg`,
      ],
      cleanPhotoUrls: [
        `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/parts/PRT-884920/clean-1.webp`,
      ],
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
      allocatedCostBasisCadMinor: 4800,
      retailPriceCadMinor: 16500,
      strippedAt: PHASE1A_SEED_TIMESTAMP,
    },
    {
      id: PHASE1A_SEED_IDS.parts.steeringRack,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      qrSkuCode: 'PRT-884921',
      donorVehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
      strippedByUserId: PHASE1A_SEED_IDS.users.ontarioStripper,
      custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
      availabilityState: InventoryAvailabilityState.AVAILABLE,
      ebaySyncState: EbaySyncState.NOT_LISTED,
      classifiedsSyncState: ClassifiedsSyncState.NOT_POSTED,
      complianceState: PartComplianceState.CLEARED_FOR_SALE,
      partCategoryName: 'Steering Rack',
      steeringSideCompatibility: SteeringSideCompatibility.LHD_ONLY,
      oemFitmentVerified: true,
      isHazmatOrAirbag: false,
      tdgHazmatCode: TdgHazmatCode.NONE,
      oemPartNumbers: ['53601-TLA-A61'],
      interchangePartNumbers: [],
      suggestedHsCode: '8708.99',
      araGrade: AraConditionGradeEnum.GRADE_B1,
      araDamageCode: '000',
      weightKg: 11.2,
      rawPhotoUrls: [
        `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/parts/PRT-884921/raw-1.jpg`,
      ],
      cleanPhotoUrls: [
        `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/parts/PRT-884921/clean-1.webp`,
      ],
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C02,
      allocatedCostBasisCadMinor: 11000,
      retailPriceCadMinor: 38000,
      strippedAt: PHASE1A_SEED_TIMESTAMP,
    },
    {
      id: PHASE1A_SEED_IDS.parts.airbagModule,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      qrSkuCode: 'PRT-884922',
      donorVehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
      strippedByUserId: PHASE1A_SEED_IDS.users.ontarioStripper,
      custodyState: PartCustodyState.SHELVED_ORIGIN_CONTAINER,
      availabilityState: InventoryAvailabilityState.AVAILABLE,
      ebaySyncState: EbaySyncState.NOT_LISTED,
      classifiedsSyncState: ClassifiedsSyncState.NOT_POSTED,
      complianceState: PartComplianceState.QUARANTINED_RECALL_OR_DG,
      partCategoryName: 'Safety Airbag',
      steeringSideCompatibility: SteeringSideCompatibility.LHD_ONLY,
      oemFitmentVerified: false,
      isHazmatOrAirbag: true,
      tdgHazmatCode: TdgHazmatCode.UN3268_AIRBAG,
      oemPartNumbers: ['77810-TLA-A81ZA'],
      interchangePartNumbers: [],
      suggestedHsCode: '8708.95',
      araGrade: AraConditionGradeEnum.GRADE_B2,
      araDamageCode: '000',
      weightKg: 1.8,
      rawPhotoUrls: [
        `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/parts/PRT-884922/raw-1.jpg`,
      ],
      cleanPhotoUrls: [],
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C03,
      allocatedCostBasisCadMinor: 0,
      retailPriceCadMinor: 0,
      strippedAt: PHASE1A_SEED_TIMESTAMP,
    },
  ] satisfies readonly SeedPartInput[],

  scrapLogs: [
    {
      id: PHASE1A_SEED_IDS.scrapLogs.catalyticConverter,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      vehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
      scrapStream: ScrapStreamCategory.CATALYTIC_CONVERTER,
      weightKg: 4.2,
      payoutCadMinor: 19500,
      recyclerName: 'Seed Ottawa Metals & Cats',
      recyclerTicketStorageKey: `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/scrap/seed-cat-001.jpg`,
      cashCustodyState: CashCustodyState.SETTLED_ORIGIN_CORP_BANK,
      recordedByUserId: PHASE1A_SEED_IDS.users.hunterMechanic,
      createdAt: PHASE1A_SEED_TIMESTAMP,
    },
    {
      id: PHASE1A_SEED_IDS.scrapLogs.alloyWheels,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      vehicleId: PHASE1A_SEED_IDS.vehicles.donorCrv2018,
      scrapStream: ScrapStreamCategory.ALUMINUM_ALLOY_WHEELS,
      weightKg: 38.5,
      payoutCadMinor: 9000,
      recyclerName: 'Seed Kemptville Scrap Yard',
      recyclerTicketStorageKey: `${PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT}/scrap/seed-wheels-001.jpg`,
      cashCustodyState: CashCustodyState.HELD_IN_OPERATOR_FLOAT,
      recordedByUserId: PHASE1A_SEED_IDS.users.hunterMechanic,
      createdAt: PHASE1A_SEED_TIMESTAMP,
    },
  ] satisfies readonly SeedScrapComponentLogInput[],

  shipments: [
    {
      id: PHASE1A_SEED_IDS.shipments.dormantExport001,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      shipmentCode: 'EXP-2026-TT-001',
      mode: 'LCL_PALLET',
      originPort: 'CA_MTR',
      destinationPort: 'TT_POS',
      exporterBn15: 'SEED-SYNTHETIC-BN15-0000',
      departedAt: null,
      arrivedPortAt: null,
      clearedCustomsAt: null,
      cersProofOfReportNumber: null,
      createdAt: PHASE1A_SEED_TIMESTAMP,
    },
  ] satisfies readonly SeedShipmentInput[],
} as const;

/**
 * Idempotently seeds Phase 1A baseline data inside a single atomic transaction.
 * Preserves existing revocations, policy updates, and operational records while failing
 * closed (and rolling back) if a fixture key already exists under conflicting ownership.
 */
export async function seedPhase1AData(
  store: Phase1ASeedStore,
): Promise<SeedPhase1AResult> {
  return store.withTransaction(async (tx) => {
    let organizationsCreated = 0;
    let usersCreated = 0;
    let membershipsCreated = 0;
    let storageLocationsCreated = 0;
    let vehiclesCreated = 0;
    let partsCreated = 0;
    let scrapLogsCreated = 0;
    let shipmentsCreated = 0;

    for (const org of PHASE1A_SEED_FIXTURES.organizations) {
      const res = await tx.upsertOrganization(org);
      if (res.created) organizationsCreated += 1;
    }

    for (const user of PHASE1A_SEED_FIXTURES.users) {
      const res = await tx.upsertUser(user);
      if (res.created) usersCreated += 1;
    }

    for (const membership of PHASE1A_SEED_FIXTURES.memberships) {
      const res = await tx.upsertOrganizationMembership(membership);
      if (res.created) membershipsCreated += 1;
    }

    for (const loc of PHASE1A_SEED_FIXTURES.storageLocations) {
      const res = await tx.upsertStorageLocation(loc);
      if (res.created) storageLocationsCreated += 1;
    }

    for (const vehicle of PHASE1A_SEED_FIXTURES.vehicles) {
      const res = await tx.insertVehicleIfAbsent(vehicle);
      if (res.created) vehiclesCreated += 1;
    }

    for (const part of PHASE1A_SEED_FIXTURES.parts) {
      const res = await tx.insertPartIfAbsent(part);
      if (res.created) partsCreated += 1;
    }

    for (const scrap of PHASE1A_SEED_FIXTURES.scrapLogs) {
      const res = await tx.insertScrapComponentLogIfAbsent(scrap);
      if (res.created) scrapLogsCreated += 1;
    }

    for (const shipment of PHASE1A_SEED_FIXTURES.shipments) {
      const res = await tx.insertShipmentIfAbsent(shipment);
      if (res.created) shipmentsCreated += 1;
    }

    return {
      organizationsCreated,
      usersCreated,
      membershipsCreated,
      storageLocationsCreated,
      vehiclesCreated,
      partsCreated,
      scrapLogsCreated,
      shipmentsCreated,
    };
  });
}

export function createPrismaPhase1ASeedStore(
  adminPrisma: PrismaClient,
): Phase1ASeedStore {
  return {
    async withTransaction<T>(fn: (tx: Phase1ASeedTx) => Promise<T>): Promise<T> {
      return adminPrisma.$transaction(
        async (tx) => {
          const seedTx: Phase1ASeedTx = {
            async upsertOrganization(input) {
              const existing = await tx.organization.findFirst({
                where: { OR: [{ id: input.id }, { slug: input.slug }] },
                select: { id: true, slug: true, organizationType: true },
              });
              if (existing) {
                if (
                  existing.id !== input.id ||
                  existing.slug !== input.slug ||
                  existing.organizationType !== input.organizationType
                ) {
                  throw new SeedConflictError(
                    `Organization fixture conflict for slug "${input.slug}".`,
                  );
                }
                return { created: false };
              }
              await tx.organization.create({
                data: {
                  id: input.id,
                  slug: input.slug,
                  name: input.name,
                  legalEntityName: input.legalEntityName,
                  organizationType: input.organizationType,
                  policyConfigJson:
                    input.policyConfigJson === null
                      ? Prisma.DbNull
                      : (input.policyConfigJson as Prisma.InputJsonValue),
                  craBusinessNumberBn15: input.craBusinessNumberBn15,
                  healthCanadaLicenseNumber: input.healthCanadaLicenseNumber,
                  isActive: input.isActive,
                },
              });
              return { created: true };
            },

            async upsertUser(input) {
              const existing = await tx.user.findFirst({
                where: { OR: [{ id: input.id }, { email: input.email }] },
                select: { id: true, email: true },
              });
              if (existing) {
                if (existing.id !== input.id || existing.email !== input.email) {
                  throw new SeedConflictError(
                    `User fixture conflict for email "${input.email}".`,
                  );
                }
                return { created: false };
              }
              await tx.user.create({
                data: {
                  id: input.id,
                  email: input.email,
                  phoneE164: input.phoneE164,
                  fullName: input.fullName,
                  role: input.role,
                  mfaEnrolled: input.mfaEnrolled,
                  commissionRateBps: input.commissionRateBps,
                  isActive: input.isActive,
                },
              });
              return { created: true };
            },

            async upsertOrganizationMembership(input) {
              const existing = await tx.organizationMembership.findFirst({
                where: {
                  OR: [
                    { id: input.id },
                    {
                      organizationId: input.organizationId,
                      userId: input.userId,
                    },
                  ],
                },
                select: { id: true, organizationId: true, userId: true },
              });
              if (existing) {
                if (
                  existing.id !== input.id ||
                  existing.organizationId !== input.organizationId ||
                  existing.userId !== input.userId
                ) {
                  throw new SeedConflictError(
                    `OrganizationMembership fixture conflict for (${input.organizationId}, ${input.userId}).`,
                  );
                }
                // Preserve existing revocations/reactivation changes
                return { created: false };
              }
              await tx.organizationMembership.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  userId: input.userId,
                  role: input.role,
                  isDefaultWorkspace: input.isDefaultWorkspace,
                  isActive: input.isActive,
                  deactivatedAt: input.deactivatedAt,
                  deactivatedById: input.deactivatedById,
                  revocationReason: input.revocationReason,
                },
              });
              return { created: true };
            },

            async upsertStorageLocation(input) {
              const existing = await tx.storageLocation.findFirst({
                where: {
                  OR: [
                    { id: input.id },
                    { fullQrBarcode: input.fullQrBarcode },
                  ],
                },
                select: {
                  id: true,
                  organizationId: true,
                  fullQrBarcode: true,
                  allowedOrgType: true,
                },
              });
              if (existing) {
                if (
                  existing.id !== input.id ||
                  existing.organizationId !== input.organizationId ||
                  existing.fullQrBarcode !== input.fullQrBarcode ||
                  existing.allowedOrgType !== input.allowedOrgType
                ) {
                  throw new SeedConflictError(
                    `StorageLocation fixture conflict for barcode "${input.fullQrBarcode}".`,
                  );
                }
                return { created: false };
              }
              await tx.storageLocation.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  allowedOrgType: input.allowedOrgType,
                  locationOperationalStatus: input.locationOperationalStatus,
                  allowsWholeVehicleDismantling:
                    input.allowsWholeVehicleDismantling,
                  maxActiveAssetCapacity: input.maxActiveAssetCapacity,
                  siteCode: input.siteCode,
                  zoneCode: input.zoneCode,
                  containerCode: input.containerCode,
                  rackCode: input.rackCode,
                  shelfCode: input.shelfCode,
                  binCode: input.binCode,
                  fullQrBarcode: input.fullQrBarcode,
                  maxWeightKg: input.maxWeightKg,
                },
              });
              return { created: true };
            },

            async insertVehicleIfAbsent(input) {
              const existing = await tx.vehicle.findFirst({
                where: {
                  OR: [
                    { id: input.id },
                    { internalStockNumber: input.internalStockNumber },
                    { vinOrHin: input.vinOrHin },
                  ],
                },
                select: {
                  id: true,
                  organizationId: true,
                  internalStockNumber: true,
                  vinOrHin: true,
                },
              });
              if (existing) {
                if (
                  existing.id !== input.id ||
                  existing.organizationId !== input.organizationId ||
                  existing.internalStockNumber !== input.internalStockNumber ||
                  existing.vinOrHin !== input.vinOrHin
                ) {
                  throw new SeedConflictError(
                    `Vehicle fixture conflict for stock "${input.internalStockNumber}".`,
                  );
                }
                return { created: false };
              }
              await tx.vehicle.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  internalStockNumber: input.internalStockNumber,
                  assetCategory: input.assetCategory,
                  vinOrHin: input.vinOrHin,
                  year: input.year,
                  make: input.make,
                  model: input.model,
                  trim: input.trim,
                  engineSpec: input.engineSpec,
                  odometerKm: input.odometerKm,
                  engineHours: input.engineHours,
                  steeringSide: input.steeringSide,
                  oemFitmentVerified: input.oemFitmentVerified,
                  roadBrand: input.roadBrand,
                  operationalLane: input.operationalLane,
                  lifecycleState: input.lifecycleState,
                  availabilityState: input.availabilityState,
                  storageLocationId: input.storageLocationId,
                  acquisitionSource: input.acquisitionSource,
                  declaredStatutoryPurpose: input.declaredStatutoryPurpose,
                  estimatedMaxBidCadMinor: input.estimatedMaxBidCadMinor,
                  actualPurchasePriceCadMinor:
                    input.actualPurchasePriceCadMinor,
                  targetGrossRealizationMinor:
                    input.targetGrossRealizationMinor,
                  fluidsDrainedAt: input.fluidsDrainedAt,
                  catalyticConverterDisposition:
                    input.catalyticConverterDisposition,
                  scrapRecoveryCadMinor: input.scrapRecoveryCadMinor,
                },
              });
              return { created: true };
            },

            async insertPartIfAbsent(input) {
              const existing = await tx.part.findFirst({
                where: { OR: [{ id: input.id }, { qrSkuCode: input.qrSkuCode }] },
                select: { id: true, organizationId: true, qrSkuCode: true },
              });
              if (existing) {
                if (
                  existing.id !== input.id ||
                  existing.organizationId !== input.organizationId ||
                  existing.qrSkuCode !== input.qrSkuCode
                ) {
                  throw new SeedConflictError(
                    `Part fixture conflict for SKU "${input.qrSkuCode}".`,
                  );
                }
                return { created: false };
              }
              await tx.part.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  qrSkuCode: input.qrSkuCode,
                  donorVehicleId: input.donorVehicleId,
                  strippedByUserId: input.strippedByUserId,
                  custodyState: input.custodyState,
                  availabilityState: input.availabilityState,
                  ebaySyncState: input.ebaySyncState,
                  classifiedsSyncState: input.classifiedsSyncState,
                  complianceState: input.complianceState,
                  partCategoryName: input.partCategoryName,
                  steeringSideCompatibility: input.steeringSideCompatibility,
                  oemFitmentVerified: input.oemFitmentVerified,
                  isHazmatOrAirbag: input.isHazmatOrAirbag,
                  tdgHazmatCode: input.tdgHazmatCode,
                  oemPartNumbers: input.oemPartNumbers,
                  interchangePartNumbers: input.interchangePartNumbers,
                  suggestedHsCode: input.suggestedHsCode,
                  araGrade: input.araGrade,
                  araDamageCode: input.araDamageCode,
                  weightKg: input.weightKg,
                  rawPhotoUrls: input.rawPhotoUrls,
                  cleanPhotoUrls: input.cleanPhotoUrls,
                  storageLocationId: input.storageLocationId,
                  allocatedCostBasisCadMinor: input.allocatedCostBasisCadMinor,
                  retailPriceCadMinor: input.retailPriceCadMinor,
                  strippedAt: input.strippedAt,
                },
              });
              return { created: true };
            },

            async insertScrapComponentLogIfAbsent(input) {
              const existing = await tx.scrapComponentLog.findUnique({
                where: { id: input.id },
                select: {
                  id: true,
                  organizationId: true,
                  vehicleId: true,
                  scrapStream: true,
                  payoutCadMinor: true,
                },
              });
              if (existing) {
                if (
                  existing.organizationId !== input.organizationId ||
                  existing.vehicleId !== input.vehicleId ||
                  existing.scrapStream !== input.scrapStream ||
                  existing.payoutCadMinor !== input.payoutCadMinor
                ) {
                  throw new SeedConflictError(
                    `Immutable ScrapComponentLog fixture conflict for id "${input.id}".`,
                  );
                }
                return { created: false };
              }
              await tx.scrapComponentLog.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  vehicleId: input.vehicleId,
                  scrapStream: input.scrapStream,
                  weightKg: input.weightKg,
                  payoutCadMinor: input.payoutCadMinor,
                  recyclerName: input.recyclerName,
                  recyclerTicketStorageKey: input.recyclerTicketStorageKey,
                  cashCustodyState: input.cashCustodyState,
                  recordedByUserId: input.recordedByUserId,
                  createdAt: input.createdAt,
                },
              });
              return { created: true };
            },

            async insertShipmentIfAbsent(input) {
              const existing = await tx.shipment.findFirst({
                where: {
                  OR: [
                    { id: input.id },
                    { shipmentCode: input.shipmentCode },
                  ],
                },
                select: {
                  id: true,
                  organizationId: true,
                  shipmentCode: true,
                },
              });
              if (existing) {
                if (
                  existing.id !== input.id ||
                  existing.organizationId !== input.organizationId ||
                  existing.shipmentCode !== input.shipmentCode
                ) {
                  throw new SeedConflictError(
                    `Shipment fixture conflict for code "${input.shipmentCode}".`,
                  );
                }
                return { created: false };
              }
              await tx.shipment.create({
                data: {
                  id: input.id,
                  organizationId: input.organizationId,
                  shipmentCode: input.shipmentCode,
                  mode: input.mode,
                  originPort: input.originPort,
                  destinationPort: input.destinationPort,
                  exporterBn15: input.exporterBn15,
                  departedAt: input.departedAt,
                  arrivedPortAt: input.arrivedPortAt,
                  clearedCustomsAt: input.clearedCustomsAt,
                  cersProofOfReportNumber: input.cersProofOfReportNumber,
                  createdAt: input.createdAt,
                },
              });
              return { created: true };
            },
          };

          return fn(seedTx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    },
  };
}

function validateDirectAdminUrl(directUrl: string | undefined): string {
  if (typeof directUrl !== 'string' || directUrl.trim().length === 0) {
    throw new Error(
      'DIRECT_URL is required to execute the Phase 1A admin seed runner.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(directUrl);
  } catch {
    throw new Error('DIRECT_URL must be a valid PostgreSQL connection URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      'DIRECT_URL must use the postgresql:// or postgres:// protocol.',
    );
  }
  return directUrl;
}

async function runSeedCli(): Promise<void> {
  const directUrl = validateDirectAdminUrl(process.env.DIRECT_URL);
  const adminPrisma = new PrismaClient({
    datasources: {
      db: {
        url: directUrl,
      },
    },
    log: ['error'],
  });

  try {
    const roleRows = await adminPrisma.$queryRaw<
      Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>
    >`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname = current_user
    `;
    const caller = roleRows[0];
    if (!caller || (!caller.rolsuper && !caller.rolbypassrls)) {
      throw new Error(
        `Seed runner must connect via DIRECT_URL as a SUPERUSER or BYPASSRLS role (connected as "${caller?.rolname ?? 'unknown'}").`,
      );
    }

    const result = await seedPhase1AData(
      createPrismaPhase1ASeedStore(adminPrisma),
    );
    console.log('[db:seed] Phase 1A seed completed:', JSON.stringify(result));
  } finally {
    await adminPrisma.$disconnect();
  }
}

const isCliEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntrypoint) {
  runSeedCli().catch((err: unknown) => {
    console.error('[db:seed] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
