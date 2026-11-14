-- ============================================================================
-- Migration 0001: Multi-Schema DDL, erp_app_user FORCE RLS, Identity Firewall,
-- Financial/Tax/Custody Constraints & Dormant Phase 2B Cannabis Triggers
-- ============================================================================

-- 0. Pre-flight assertion: Migration MUST execute as a BYPASSRLS or SUPERUSER owner
--    so SECURITY DEFINER helpers in shared.* never recurse under FORCE ROW LEVEL SECURITY.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND (rolsuper = true OR rolbypassrls = true)
  ) THEN
    RAISE EXCEPTION 'Migration must execute via DIRECT_URL as a BYPASSRLS or SUPERUSER owner so SECURITY DEFINER RLS helpers cannot recurse under FORCE ROW LEVEL SECURITY.';
  END IF;
END $$;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "cannabis";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "salvage";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shared";

-- CreateEnum
CREATE TYPE "shared"."OrganizationType" AS ENUM ('SALVAGE_AND_EXPORT', 'CANNABIS_NURSERY_AND_PROCESSING');

-- CreateEnum
CREATE TYPE "shared"."UserRole" AS ENUM ('ARCHITECT_CFO', 'HUNTER_MECHANIC', 'ONTARIO_STRIPPER', 'TRINIDAD_VAULT_ADMIN', 'OVERSEAS_B2B_BUYER', 'CANNABIS_QAP_COMPLIANCE', 'NURSERY_CULTIVATION_TECH');

-- CreateEnum
CREATE TYPE "shared"."CurrencyCode" AS ENUM ('CAD', 'USD', 'TTD');

-- CreateEnum
CREATE TYPE "shared"."LocationOperationalStatus" AS ENUM ('ACTIVE', 'PROPOSED_INACTIVE', 'DORMANT_FUTURE');

-- CreateEnum
CREATE TYPE "shared"."ExpenseCategory" AS ENUM ('AUCTION_PURCHASE_PRICE', 'AUCTION_BUYER_FEE', 'TOWING_AND_RECOVERY', 'YARD_STRIPPER_PIECE_RATE', 'RAMSAYVILLE_SHOP_LABOR', 'AFTERMARKET_REPAIR_PARTS', 'OEM_REBUILD_PARTS', 'MTO_INSPECTION_FEE', 'REFRIGERANT_EVAC_AND_PREP', 'STEAM_CLEANING_EXPORT_PREP', 'OCEAN_FREIGHT_LCL_FCL', 'CUSTOMS_BROKERAGE_FEE', 'DESTINATION_DUTY_AND_VAT', 'PORT_DRAYAGE', 'PACKAGING_AND_LABELS', 'NUTRIENTS_AND_GROW_MEDIA', 'LAB_COA_TESTING_FEE', 'PROCESSING_SOLVENTS_AND_CONSUMABLES', 'EXCISE_STAMP_AND_DUTY', 'PARTNER_PROFIT_DRAW');

-- CreateEnum
CREATE TYPE "shared"."AccountingSyncStatus" AS ENUM ('PENDING_SYNC', 'SYNCED_TO_GL', 'SYNC_FAILED');

-- CreateEnum
CREATE TYPE "shared"."ReceiptVerificationState" AS ENUM ('VERIFIED_RECEIPT', 'PETTY_CASH_VOUCHER', 'PENDING_RECEIPT_UPLOAD');

-- CreateEnum
CREATE TYPE "shared"."SaleMarketNode" AS ENUM ('DOMESTIC_ORIGIN', 'DESTINATION_EXPORT_VAULT');

-- CreateEnum
CREATE TYPE "shared"."CashCustodyState" AS ENUM ('PENDING_EXTERNAL_RECEIVABLE', 'HELD_IN_OPERATOR_FLOAT', 'HELD_IN_DESTINATION_VAULT', 'DEPOSITED_DESTINATION_BANK', 'SETTLED_ORIGIN_CORP_BANK');

-- CreateEnum
CREATE TYPE "shared"."PaymentSettlementState" AS ENUM ('SALE_RECORDED', 'PAYMENT_INITIATED', 'PAYMENT_CONFIRMED', 'MARKETPLACE_PAYOUT_PENDING', 'BANK_SETTLEMENT_PENDING', 'BANK_SETTLEMENT_CONFIRMED', 'REFUNDED_OR_CHARGED_BACK');

-- CreateEnum
CREATE TYPE "salvage"."AssetCategory" AS ENUM ('AUTOMOBILE', 'WATERCRAFT', 'SHOP_EQUIPMENT');

-- CreateEnum
CREATE TYPE "salvage"."RoadVehicleBrand" AS ENUM ('NONE', 'SALVAGE', 'REBUILT', 'IRREPARABLE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "salvage"."OperationalLane" AS ENUM ('QUICK_TURN_BEATER', 'HIGH_END_REBUILD', 'DISMANTLE_AND_EXPORT', 'WHOLE_UNIT_EXPORT');

-- CreateEnum
CREATE TYPE "salvage"."SteeringSideCompatibility" AS ENUM ('UNIVERSAL', 'LHD_ONLY', 'RHD_ONLY');

-- CreateEnum
CREATE TYPE "salvage"."AssetLifecycleState" AS ENUM ('PROPOSED_DEAL', 'ACQUIRED_IN_TRANSIT', 'STAGED_ONTARIO_YARD', 'IN_RAMSAYVILLE_SHOP', 'PENDING_INSPECTION_CERT', 'READY_FOR_RETAIL_SALE', 'SOLD_RETAIL_ONTARIO', 'DISMANTLING_IN_PROGRESS', 'HULK_AWAITING_SCRAP', 'SCRAPPED_METAL_CLEARED', 'MANIFESTED_WHOLE_EXPORT', 'LANDED_TRINIDAD_VAULT', 'SOLD_EXPORT_COD');

-- CreateEnum
CREATE TYPE "salvage"."PartCustodyState" AS ENUM ('STRIPPED_RAW_OFFLINE', 'SHELVED_ORIGIN_CONTAINER', 'ON_EXPORT_PALLET', 'IN_TRANSIT_OCEAN_FREIGHT', 'CUSTOMS_HOLD_DESTINATION', 'SHELVED_DESTINATION_VAULT', 'SOLD_AND_RELEASED', 'RESTOCKED_QC_HOLD', 'SCRAPPED_OR_DAMAGED');

-- CreateEnum
CREATE TYPE "salvage"."InventoryAvailabilityState" AS ENUM ('AVAILABLE', 'RESERVED_B2B_HOLD', 'COMMITTED_DOMESTIC_SALE', 'PENDING_VAULT_COD_PAYMENT', 'PAID_SETTLED', 'RETURNED_QC_HOLD');

-- CreateEnum
CREATE TYPE "salvage"."EbaySyncState" AS ENUM ('NOT_LISTED', 'CSV_EXPORTED_PENDING_CONFIRMATION', 'SYNDICATED_LIVE', 'DELIST_PENDING', 'DELISTED', 'EXPORT_LOCK_PENDING', 'EXPORT_LOCK_CONFIRMED');

-- CreateEnum
CREATE TYPE "salvage"."ClassifiedsSyncState" AS ENUM ('NOT_POSTED', 'POSTED_LIVE', 'DELIST_REQUIRED', 'DELISTED');

-- CreateEnum
CREATE TYPE "salvage"."PartComplianceState" AS ENUM ('PENDING_ENRICHMENT', 'NEEDS_HUMAN_REVIEW', 'CLEARED_FOR_SALE', 'QUARANTINED_RECALL_OR_DG');

-- CreateEnum
CREATE TYPE "salvage"."TdgHazmatCode" AS ENUM ('NONE', 'UN3268_AIRBAG', 'UN0503_PYROTECHNIC', 'UN2794_WET_BATTERY', 'UN3480_LITHIUM_BATTERY');

-- CreateEnum
CREATE TYPE "salvage"."AraConditionGradeEnum" AS ENUM ('GRADE_A', 'GRADE_B1', 'GRADE_B2', 'GRADE_B3', 'GRADE_C', 'GRADE_X');

-- CreateEnum
CREATE TYPE "salvage"."DomesticSaleChannel" AS ENUM ('LOCAL_WALK_IN_CASH', 'FB_MARKETPLACE_LOCAL', 'KIJIJI_LOCAL', 'RETAIL_LOT_VEHICLE_SALE', 'WHOLESALE_MECHANIC_NETWORK', 'EBAY_MOTORS_SHIPPED', 'CAR_PART_WHOLESALE');

-- CreateEnum
CREATE TYPE "salvage"."TaxCollectionMode" AS ENUM ('DIRECT_SELLER_COLLECTED', 'MARKETPLACE_FACILITATOR_COLLECTED', 'ZERO_RATED_EXPORT', 'NOT_REGISTERED_NO_TAX');

-- CreateEnum
CREATE TYPE "salvage"."ExportSaleChannel" AS ENUM ('DESTINATION_VAULT_COD', 'DESTINATION_PRE_ORDER_PICKUP', 'SECONDARY_ISLAND_WHOLESALE');

-- CreateEnum
CREATE TYPE "salvage"."VehicleAcquisitionSource" AS ENUM ('LICENSED_AUCTION', 'PRIVATE_DRIVEWAY_BUY', 'DEALER_WHOLESALE', 'TRADE_IN');

-- CreateEnum
CREATE TYPE "salvage"."StatutoryVehiclePurpose" AS ENUM ('WRECKING_PARTS_ONLY', 'RETAIL_RESALE', 'EXPORT_WHOLE');

-- CreateEnum
CREATE TYPE "salvage"."ScrapStreamCategory" AS ENUM ('CATALYTIC_CONVERTER', 'ALUMINUM_ALLOY_WHEELS', 'COPPER_WIRING_HARNESS', 'ROTORS_AND_BATTERY', 'BARE_STEEL_SHELL');

-- CreateEnum
CREATE TYPE "salvage"."CatalyticConverterDisposition" AS ENUM ('PRESENT_AT_INTAKE', 'MISSING_AT_INTAKE', 'LOGGED_SCRAP_SALE', 'SHELVED_AS_PART');

-- CreateEnum
CREATE TYPE "cannabis"."CannabisLotStage" AS ENUM ('MOTHER_PLANT', 'CLONE_TRAY', 'VEGETATIVE_BATCH', 'FRESH_HARVEST', 'DRIED_FLOWER', 'TRIM_BIOMASS', 'BUBBLE_HASH_INTERMEDIATE', 'LIVE_ROSIN_EXTRACT', 'CRUDE_EXTRACT', 'DISTILLATE_OR_ISOLATE', 'PACKAGED_RETAIL_UNIT');

-- CreateEnum
CREATE TYPE "cannabis"."CannabisTrackingUnit" AS ENUM ('PLANTS', 'TENTH_GRAMS', 'DISCRETE_UNITS');

-- CreateEnum
CREATE TYPE "cannabis"."CannabisRunType" AS ENUM ('DRYING_CURING', 'SOLVENTLESS_ICE_WATER_HASH', 'ROSIN_PRESSING', 'INFUSED_PREROLL_ASSEMBLY', 'PACKAGING_LABELLING');

-- CreateEnum
CREATE TYPE "cannabis"."CannabisProductionRunStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'FINALIZED', 'VOIDED');

-- CreateEnum
CREATE TYPE "cannabis"."CannabisDestructionStream" AS ENUM ('CULTIVATION_WASTE', 'WHOLE_PLANTS', 'OTHER_CANNABIS');

-- CreateEnum
CREATE TYPE "cannabis"."CanonicalCannabisEventType" AS ENUM ('PROPAGATION_SPAWN', 'HARVEST_INTAKE', 'PRODUCTION_INPUT_CONSUME', 'PRODUCTION_OUTPUT_YIELD', 'PROCESS_LOSS', 'DESTRUCTION_DISPOSAL', 'PACKAGING_STAMPED', 'QA_SAMPLE_DRAW', 'INVENTORY_ADJUSTMENT');

-- CreateTable
CREATE TABLE "shared"."Organization" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalEntityName" TEXT,
    "organizationType" "shared"."OrganizationType" NOT NULL,
    "policyConfigJson" JSONB,
    "craBusinessNumberBn15" TEXT,
    "healthCanadaLicenseNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phoneE164" TEXT,
    "fullName" TEXT NOT NULL,
    "role" "shared"."UserRole" NOT NULL,
    "mfaEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "commissionRateBps" INTEGER NOT NULL DEFAULT 0,
    "whatsappOptInAt" TIMESTAMP(3),
    "whatsappWindowExp" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."OrganizationMembership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "shared"."UserRole" NOT NULL,
    "isDefaultWorkspace" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" UUID,
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."StorageLocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "allowedOrgType" "shared"."OrganizationType" NOT NULL,
    "locationOperationalStatus" "shared"."LocationOperationalStatus" NOT NULL DEFAULT 'ACTIVE',
    "allowsWholeVehicleDismantling" BOOLEAN NOT NULL DEFAULT false,
    "maxActiveAssetCapacity" INTEGER,
    "siteCode" TEXT NOT NULL,
    "zoneCode" TEXT NOT NULL DEFAULT 'ZONE_CONTAINER_PAD',
    "containerCode" TEXT NOT NULL,
    "rackCode" TEXT NOT NULL,
    "shelfCode" TEXT NOT NULL,
    "binCode" TEXT NOT NULL,
    "fullQrBarcode" TEXT NOT NULL,
    "maxWeightKg" DECIMAL(6,2) NOT NULL DEFAULT 150.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."CustodyEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partId" UUID,
    "vehicleId" UUID,
    "cannabisLotId" UUID,
    "actorUserId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fromLocationBarcode" TEXT,
    "toLocationBarcode" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "hasConflict" BOOLEAN NOT NULL DEFAULT false,
    "complianceWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceTimestamp" TIMESTAMP(3) NOT NULL,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."Expense" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "vehicleId" UUID,
    "shipmentId" UUID,
    "cannabisLotId" UUID,
    "loggedByUserId" UUID NOT NULL,
    "category" "shared"."ExpenseCategory" NOT NULL,
    "vendorName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountOriginalMinor" INTEGER NOT NULL,
    "currencyOriginal" "shared"."CurrencyCode" NOT NULL DEFAULT 'CAD',
    "amountCadMinor" INTEGER NOT NULL,
    "itcReceivableCadMinor" INTEGER NOT NULL DEFAULT 0,
    "paidFromCashCustody" "shared"."CashCustodyState",
    "isDeferredIntercompanyAccrual" BOOLEAN NOT NULL DEFAULT false,
    "accrualSettledAt" TIMESTAMP(3),
    "isReversalEntry" BOOLEAN NOT NULL DEFAULT false,
    "reversesExpenseId" UUID,
    "receiptVerificationState" "shared"."ReceiptVerificationState" NOT NULL DEFAULT 'VERIFIED_RECEIPT',
    "receiptStorageKey" TEXT,
    "receiptSha256Hash" TEXT,
    "voucherReason" TEXT,
    "receiptOcrJson" JSONB,
    "accountingSyncStatus" "shared"."AccountingSyncStatus" NOT NULL DEFAULT 'PENDING_SYNC',
    "externalGlJournalId" TEXT,
    "incurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."CashCustodyTransfer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "transferCode" TEXT NOT NULL,
    "marketNode" "shared"."SaleMarketNode" NOT NULL,
    "fromCustodyState" "shared"."CashCustodyState" NOT NULL,
    "toCustodyState" "shared"."CashCustodyState" NOT NULL,
    "currency" "shared"."CurrencyCode" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "equivalentCadMinor" INTEGER NOT NULL,
    "commercialBankName" TEXT,
    "depositSlipStorageKey" TEXT NOT NULL,
    "recordedByUserId" UUID NOT NULL,
    "accountingSyncStatus" "shared"."AccountingSyncStatus" NOT NULL DEFAULT 'PENDING_SYNC',
    "externalGlJournalId" TEXT,
    "transferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCustodyTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."OutboxEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared"."AuditLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousState" JSONB,
    "nextState" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."Vehicle" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "internalStockNumber" TEXT NOT NULL,
    "assetCategory" "salvage"."AssetCategory" NOT NULL DEFAULT 'AUTOMOBILE',
    "vinOrHin" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "engineSpec" TEXT,
    "odometerKm" INTEGER,
    "engineHours" INTEGER,
    "exteriorColor" TEXT,
    "steeringSide" "salvage"."SteeringSideCompatibility" NOT NULL DEFAULT 'LHD_ONLY',
    "oemFitmentVerified" BOOLEAN NOT NULL DEFAULT false,
    "roadBrand" "salvage"."RoadVehicleBrand" NOT NULL DEFAULT 'NONE',
    "operationalLane" "salvage"."OperationalLane" NOT NULL,
    "lifecycleState" "salvage"."AssetLifecycleState" NOT NULL DEFAULT 'PROPOSED_DEAL',
    "availabilityState" "salvage"."InventoryAvailabilityState" NOT NULL DEFAULT 'AVAILABLE',
    "classifiedsSyncState" "salvage"."ClassifiedsSyncState" NOT NULL DEFAULT 'NOT_POSTED',
    "storageLocationId" UUID,
    "acquisitionSource" "salvage"."VehicleAcquisitionSource" NOT NULL DEFAULT 'LICENSED_AUCTION',
    "sellerFullName" TEXT,
    "sellerAddress" TEXT,
    "sellerPhotoIdStorageKey" TEXT,
    "ontarioPermitNumber" TEXT,
    "declaredStatutoryPurpose" "salvage"."StatutoryVehiclePurpose" NOT NULL DEFAULT 'WRECKING_PARTS_ONLY',
    "weightKg" DECIMAL(8,2),
    "dimensionsCm" JSONB,
    "suggestedHsCode" TEXT NOT NULL DEFAULT '8903.99',
    "brokerVerifiedHsCode" TEXT,
    "estimatedMaxBidCadMinor" INTEGER NOT NULL,
    "actualPurchasePriceCadMinor" INTEGER NOT NULL DEFAULT 0,
    "estimatedRepairCadMinor" INTEGER NOT NULL DEFAULT 0,
    "targetGrossRealizationMinor" INTEGER NOT NULL DEFAULT 0,
    "cfoGateApprovedById" UUID,
    "cfoGateApprovedAt" TIMESTAMP(3),
    "cfoGateOverrideReason" TEXT,
    "wholesaleFobUsdMinor" INTEGER,
    "landedCostTtdMinor" INTEGER,
    "vaultFloorPriceTtdMinor" INTEGER,
    "brokerMarketPriceTtdMinor" INTEGER,
    "rebuildDossierJson" JSONB,
    "driveOnInitialFailAt" TIMESTAMP(3),
    "driveOnReinspectionDeadlineAt" TIMESTAMP(3),
    "driveOnFailSheetStorageKey" TEXT,
    "driveOnSicNumber" TEXT,
    "driveOnSicPassedAt" TIMESTAMP(3),
    "driveOnSscNumber" TEXT,
    "driveOnSscIssuedAt" TIMESTAMP(3),
    "driveOnSscExpiresAt" TIMESTAMP(3),
    "uvipStorageKey" TEXT,
    "refrigerantEvacCertKey" TEXT,
    "fluidsDrainedAt" TIMESTAMP(3),
    "steamCleanedReceiptKey" TEXT,
    "catalyticConverterDisposition" "salvage"."CatalyticConverterDisposition" NOT NULL DEFAULT 'PRESENT_AT_INTAKE',
    "scrapMetalTicketKey" TEXT,
    "scrapRecoveryCadMinor" INTEGER NOT NULL DEFAULT 0,
    "scrappedClearedAt" TIMESTAMP(3),
    "complianceWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "realizedRetailSaleCadMinor" INTEGER,
    "soldAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "shipmentId" UUID,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."Part" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "qrSkuCode" TEXT NOT NULL,
    "donorVehicleId" UUID NOT NULL,
    "strippedByUserId" UUID NOT NULL,
    "custodyState" "salvage"."PartCustodyState" NOT NULL DEFAULT 'STRIPPED_RAW_OFFLINE',
    "availabilityState" "salvage"."InventoryAvailabilityState" NOT NULL DEFAULT 'AVAILABLE',
    "ebaySyncState" "salvage"."EbaySyncState" NOT NULL DEFAULT 'NOT_LISTED',
    "classifiedsSyncState" "salvage"."ClassifiedsSyncState" NOT NULL DEFAULT 'NOT_POSTED',
    "complianceState" "salvage"."PartComplianceState" NOT NULL DEFAULT 'PENDING_ENRICHMENT',
    "partCategoryName" TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
    "steeringSideCompatibility" "salvage"."SteeringSideCompatibility" NOT NULL DEFAULT 'UNIVERSAL',
    "oemFitmentVerified" BOOLEAN NOT NULL DEFAULT false,
    "isHazmatOrAirbag" BOOLEAN NOT NULL DEFAULT false,
    "tdgHazmatCode" "salvage"."TdgHazmatCode" NOT NULL DEFAULT 'NONE',
    "oemPartNumbers" TEXT[],
    "interchangePartNumbers" TEXT[],
    "suggestedHsCode" TEXT NOT NULL DEFAULT '8708.99',
    "brokerVerifiedHsCode" TEXT,
    "araGrade" "salvage"."AraConditionGradeEnum" NOT NULL DEFAULT 'GRADE_X',
    "araDamageCode" TEXT NOT NULL DEFAULT '000',
    "conditionNotes" TEXT,
    "aiConfidenceScore" DECIMAL(4,3),
    "humanVerifiedAt" TIMESTAMP(3),
    "weightKg" DECIMAL(6,2) NOT NULL DEFAULT 2.50,
    "dimensionsCm" JSONB,
    "rawPhotoUrls" TEXT[],
    "cleanPhotoUrls" TEXT[],
    "storageLocationId" UUID,
    "shipmentPalletId" UUID,
    "allocatedCostBasisCadMinor" INTEGER NOT NULL DEFAULT 0,
    "compBaselineCadMinor" INTEGER,
    "retailPriceCadMinor" INTEGER,
    "wholesaleFobUsdMinor" INTEGER,
    "landedCostTtdMinor" INTEGER,
    "vaultFloorPriceTtdMinor" INTEGER,
    "brokerMarketPriceTtdMinor" INTEGER,
    "ebayOfferId" TEXT,
    "ebayListingId" TEXT,
    "ebayTitle" VARCHAR(80),
    "ebayAspectsJson" JSONB,
    "ebayCompatibilityJson" JSONB,
    "complianceWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "strippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."ScrapComponentLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "scrapStream" "salvage"."ScrapStreamCategory" NOT NULL,
    "weightKg" DECIMAL(8,2),
    "payoutCadMinor" INTEGER NOT NULL,
    "recyclerName" TEXT NOT NULL,
    "recyclerTicketStorageKey" TEXT NOT NULL,
    "cashCustodyState" "shared"."CashCustodyState" NOT NULL DEFAULT 'SETTLED_ORIGIN_CORP_BANK',
    "recordedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScrapComponentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."Shipment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shipmentCode" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "originPort" TEXT NOT NULL DEFAULT 'CA_MTR',
    "destinationPort" TEXT NOT NULL DEFAULT 'TT_POS',
    "customsBrokerName" TEXT,
    "importerOfRecordName" TEXT,
    "importerTaxId" TEXT,
    "exporterBn15" TEXT NOT NULL,
    "cersProofOfReportNumber" TEXT,
    "vesselLoadingCutoffAt" TIMESTAMP(3),
    "cersSubmittedAt" TIMESTAMP(3),
    "cersArchiveStorageKey" TEXT,
    "declaredFobTotalUsdMinor" INTEGER NOT NULL DEFAULT 0,
    "oceanFreightUsdMinor" INTEGER NOT NULL DEFAULT 0,
    "marineInsuranceUsdMinor" INTEGER NOT NULL DEFAULT 0,
    "cifTotalUsdMinor" INTEGER NOT NULL DEFAULT 0,
    "assessedDutyTtdMinor" INTEGER NOT NULL DEFAULT 0,
    "assessedVatTtdMinor" INTEGER NOT NULL DEFAULT 0,
    "departedAt" TIMESTAMP(3),
    "arrivedPortAt" TIMESTAMP(3),
    "clearedCustomsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."ShipmentPallet" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "palletQrCode" TEXT NOT NULL,
    "tareWeightKg" DECIMAL(6,2) NOT NULL DEFAULT 22.0,
    "grossWeightKg" DECIMAL(8,2) NOT NULL,
    "dimensionsCm" JSONB NOT NULL,
    "sealedAt" TIMESTAMP(3),

    CONSTRAINT "ShipmentPallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."PreOrderWishList" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requesterUserId" UUID NOT NULL,
    "targetYearStart" INTEGER NOT NULL,
    "targetYearEnd" INTEGER NOT NULL,
    "targetMake" TEXT NOT NULL,
    "targetModel" TEXT NOT NULL,
    "requiredSteeringSide" "salvage"."SteeringSideCompatibility" NOT NULL DEFAULT 'RHD_ONLY',
    "partDescription" TEXT NOT NULL,
    "oemPartNumberHint" TEXT,
    "maxBidWillingTtdMinor" INTEGER NOT NULL,
    "isFulfilled" BOOLEAN NOT NULL DEFAULT false,
    "matchedPartId" UUID,
    "matchedVehicleId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreOrderWishList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."B2BReservation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partId" UUID,
    "vehicleId" UUID,
    "buyerPhoneE164" TEXT NOT NULL,
    "brokerUserId" UUID,
    "quotedTtdMinor" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2BReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."SaleTransaction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "marketNode" "shared"."SaleMarketNode" NOT NULL,
    "domesticChannel" "salvage"."DomesticSaleChannel",
    "exportChannel" "salvage"."ExportSaleChannel",
    "deliveryMethod" TEXT NOT NULL DEFAULT 'IN_PERSON_PICKUP',
    "destinationCountryCode" TEXT NOT NULL DEFAULT 'CA',
    "destinationProvinceOrState" TEXT,
    "exportProofStorageKey" TEXT,
    "taxInvoiceNumber" TEXT,
    "buyerName" TEXT NOT NULL,
    "buyerPhoneE164" TEXT,
    "buyerIdDocumentStorageKey" TEXT,
    "buyerIdNumberEncrypted" TEXT,
    "soldByUserId" UUID NOT NULL,
    "brokerUserId" UUID,
    "verifiedByAdminId" UUID NOT NULL,
    "paymentCurrency" "shared"."CurrencyCode" NOT NULL,
    "floorPriceAtCheckoutMinor" INTEGER,
    "subtotalMinor" INTEGER NOT NULL,
    "discountAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "discountReasonCode" TEXT,
    "cfoOverrideApprovedById" UUID,
    "cfoOverrideReasonNote" TEXT,
    "platformFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "shippingCostMinor" INTEGER NOT NULL DEFAULT 0,
    "taxCollectionMode" "salvage"."TaxCollectionMode" NOT NULL DEFAULT 'DIRECT_SELLER_COLLECTED',
    "appliedTaxJurisdiction" TEXT NOT NULL DEFAULT 'CA-ON',
    "appliedTaxRateBps" INTEGER NOT NULL DEFAULT 1300,
    "taxOrVatMinor" INTEGER NOT NULL DEFAULT 0,
    "buyerTaxRemittedByPlatformMinor" INTEGER,
    "estimatedPlatformFeeTaxCadMinor" INTEGER NOT NULL DEFAULT 0,
    "itcReceivableCadMinor" INTEGER NOT NULL DEFAULT 0,
    "isFeeTaxInvoiceVerified" BOOLEAN NOT NULL DEFAULT false,
    "feeTaxInvoiceStorageKey" TEXT,
    "grossCollectedMinor" INTEGER NOT NULL,
    "netRealizedCadMinor" INTEGER NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "paymentSettlementState" "shared"."PaymentSettlementState" NOT NULL DEFAULT 'SALE_RECORDED',
    "paymentConfirmedAt" TIMESTAMP(3),
    "bankSettledAt" TIMESTAMP(3),
    "bankDepositReference" TEXT,
    "settlementProofStorageKey" TEXT,
    "cashCustodyState" "shared"."CashCustodyState" NOT NULL,
    "ebayDelistAttestedAt" TIMESTAMP(3),
    "complianceWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "paymentProofStorageKey" TEXT NOT NULL,
    "billOfSaleStorageKey" TEXT,
    "ttdCommercialBankName" TEXT,
    "brokerCommissionBps" INTEGER NOT NULL DEFAULT 0,
    "brokerCommissionMinor" INTEGER NOT NULL DEFAULT 0,
    "isBrokerCommissionDeductedAtCounter" BOOLEAN NOT NULL DEFAULT false,
    "brokerCommissionPaidAt" TIMESTAMP(3),
    "isPaymentVerified" BOOLEAN NOT NULL DEFAULT false,
    "gateTokenNonce" TEXT,
    "gateTokenExpiresAt" TIMESTAMP(3),
    "gateReleasedAt" TIMESTAMP(3),
    "isVoidedOrReversed" BOOLEAN NOT NULL DEFAULT false,
    "reversesSaleTxId" UUID,
    "voidReason" TEXT,
    "accountingSyncStatus" "shared"."AccountingSyncStatus" NOT NULL DEFAULT 'PENDING_SYNC',
    "externalGlJournalId" TEXT,
    "settlementBatchId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."SaleTransactionPartItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "saleTransactionId" UUID NOT NULL,
    "partId" UUID NOT NULL,
    "soldPriceMinor" INTEGER NOT NULL,
    "isActiveSale" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SaleTransactionPartItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."SaleTransactionVehicleItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "saleTransactionId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "soldPriceMinor" INTEGER NOT NULL,
    "isActiveSale" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SaleTransactionVehicleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."CycleCountTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "batchCode" TEXT NOT NULL,
    "partId" UUID,
    "vehicleId" UUID,
    "assignedToAdminId" UUID NOT NULL,
    "expectedLocationBarcode" TEXT NOT NULL,
    "scannedLocationBarcode" TEXT,
    "liveVerificationPhotoKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "discrepancyNotes" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleCountTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salvage"."CurrencySettlement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "batchCode" TEXT NOT NULL,
    "sourceCurrency" "shared"."CurrencyCode" NOT NULL DEFAULT 'TTD',
    "targetCurrency" "shared"."CurrencyCode" NOT NULL DEFAULT 'CAD',
    "totalSourceAmountMinor" BIGINT NOT NULL,
    "totalTargetSettledMinor" BIGINT NOT NULL,
    "officialCbttRate" DECIMAL(10,6) NOT NULL,
    "effectiveClearingRate" DECIMAL(10,6) NOT NULL,
    "fxSlippageLossCadMinor" INTEGER NOT NULL DEFAULT 0,
    "conversionChannel" TEXT NOT NULL,
    "wireProofStorageKey" TEXT NOT NULL,
    "accountingSyncStatus" "shared"."AccountingSyncStatus" NOT NULL DEFAULT 'PENDING_SYNC',
    "externalGlJournalId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledInCanadaAt" TIMESTAMP(3),

    CONSTRAINT "CurrencySettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."CannabisStrain" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lineage" TEXT,
    "targetThcPct" DECIMAL(5,2),
    "targetTerpeneProfile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannabisStrain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."CannabisLot" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lotBarcode" TEXT NOT NULL,
    "strainId" UUID NOT NULL,
    "parentMotherLotId" UUID,
    "lotStage" "cannabis"."CannabisLotStage" NOT NULL,
    "trackingUnit" "cannabis"."CannabisTrackingUnit" NOT NULL DEFAULT 'TENTH_GRAMS',
    "discreteUnits" INTEGER NOT NULL DEFAULT 0,
    "netMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "flowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "nonFlowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "totalThcMg" BIGINT,
    "isGrownOnSite" BOOLEAN NOT NULL DEFAULT true,
    "nncpNoticeId" TEXT,
    "storageLocationId" UUID,
    "complianceHold" BOOLEAN NOT NULL DEFAULT false,
    "labCoaStorageKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannabisLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."ProductionRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "runNumber" TEXT NOT NULL,
    "runType" "cannabis"."CannabisRunType" NOT NULL,
    "status" "cannabis"."CannabisProductionRunStatus" NOT NULL DEFAULT 'DRAFT',
    "totalInputMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "totalOutputMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "processLossMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "destroyedByproductMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "unaccountedVarianceTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "variancePercentage" DECIMAL(6,3) NOT NULL DEFAULT 0.000,
    "requiresQapVarianceReview" BOOLEAN NOT NULL DEFAULT false,
    "qapVarianceReasonNote" TEXT,
    "executedByUserId" UUID NOT NULL,
    "verifiedByQapUserId" UUID,
    "voidReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "reversesProductionRunId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProductionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."ProductionRunInput" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productionRunId" UUID NOT NULL,
    "sourceLotId" UUID NOT NULL,
    "consumedMassTenthGrams" BIGINT NOT NULL,
    "consumedFlowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "consumedNonFlowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "consumedDiscreteUnits" INTEGER NOT NULL DEFAULT 0,
    "consumedTotalThcMg" BIGINT,

    CONSTRAINT "ProductionRunInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."ProductionRunOutput" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productionRunId" UUID NOT NULL,
    "outputLotId" UUID NOT NULL,
    "yieldedMassTenthGrams" BIGINT NOT NULL,
    "yieldedFlowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "yieldedNonFlowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "yieldedDiscreteUnits" INTEGER NOT NULL DEFAULT 0,
    "yieldedTotalThcMg" BIGINT,

    CONSTRAINT "ProductionRunOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."CannabisDestructionLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "destructionStream" "cannabis"."CannabisDestructionStream" NOT NULL,
    "destroyedNetMassTenthGrams" BIGINT,
    "destroyedPlantCount" INTEGER,
    "destructionReason" TEXT NOT NULL,
    "destructionMethod" TEXT NOT NULL,
    "attestationStatement" TEXT,
    "evidencePhotoStorageKey" TEXT,
    "primaryUserId" UUID NOT NULL,
    "witnessUserId" UUID,
    "secondWitnessUserId" UUID,
    "destroyedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CannabisDestructionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cannabis"."CanonicalInventoryEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "cannabisLotId" UUID NOT NULL,
    "productionRunId" UUID,
    "destructionLogId" UUID,
    "eventType" "cannabis"."CanonicalCannabisEventType" NOT NULL,
    "ctlsReportingCategory" TEXT NOT NULL,
    "netMassTenthGrams" BIGINT NOT NULL,
    "flowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "nonFlowerMassTenthGrams" BIGINT NOT NULL DEFAULT 0,
    "discreteUnits" INTEGER NOT NULL DEFAULT 0,
    "totalThcMg" BIGINT,
    "reversesCanonicalEventId" UUID,
    "reasonNote" TEXT,
    "recordedByUserId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanonicalInventoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "shared"."Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "shared"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneE164_key" ON "shared"."User"("phoneE164");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_isActive_idx" ON "shared"."OrganizationMembership"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_id_key" ON "shared"."OrganizationMembership"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "shared"."OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_fullQrBarcode_key" ON "shared"."StorageLocation"("fullQrBarcode");

-- CreateIndex
CREATE INDEX "StorageLocation_organizationId_siteCode_zoneCode_idx" ON "shared"."StorageLocation"("organizationId", "siteCode", "zoneCode");

-- CreateIndex
CREATE INDEX "StorageLocation_siteCode_containerCode_idx" ON "shared"."StorageLocation"("siteCode", "containerCode");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_organizationId_id_key" ON "shared"."StorageLocation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyEvent_idempotencyKey_key" ON "shared"."CustodyEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CustodyEvent_organizationId_serverReceivedAt_idx" ON "shared"."CustodyEvent"("organizationId", "serverReceivedAt");

-- CreateIndex
CREATE INDEX "CustodyEvent_partId_serverReceivedAt_idx" ON "shared"."CustodyEvent"("partId", "serverReceivedAt");

-- CreateIndex
CREATE INDEX "CustodyEvent_vehicleId_serverReceivedAt_idx" ON "shared"."CustodyEvent"("vehicleId", "serverReceivedAt");

-- CreateIndex
CREATE INDEX "CustodyEvent_cannabisLotId_serverReceivedAt_idx" ON "shared"."CustodyEvent"("cannabisLotId", "serverReceivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyEvent_organizationId_id_key" ON "shared"."CustodyEvent"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Expense_organizationId_incurredAt_idx" ON "shared"."Expense"("organizationId", "incurredAt");

-- CreateIndex
CREATE INDEX "Expense_vehicleId_idx" ON "shared"."Expense"("vehicleId");

-- CreateIndex
CREATE INDEX "Expense_shipmentId_idx" ON "shared"."Expense"("shipmentId");

-- CreateIndex
CREATE INDEX "Expense_cannabisLotId_idx" ON "shared"."Expense"("cannabisLotId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_organizationId_id_key" ON "shared"."Expense"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashCustodyTransfer_transferCode_key" ON "shared"."CashCustodyTransfer"("transferCode");

-- CreateIndex
CREATE INDEX "CashCustodyTransfer_organizationId_transferredAt_idx" ON "shared"."CashCustodyTransfer"("organizationId", "transferredAt");

-- CreateIndex
CREATE INDEX "CashCustodyTransfer_marketNode_fromCustodyState_toCustodySt_idx" ON "shared"."CashCustodyTransfer"("marketNode", "fromCustodyState", "toCustodyState");

-- CreateIndex
CREATE INDEX "CashCustodyTransfer_commercialBankName_idx" ON "shared"."CashCustodyTransfer"("commercialBankName");

-- CreateIndex
CREATE UNIQUE INDEX "CashCustodyTransfer_organizationId_id_key" ON "shared"."CashCustodyTransfer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "shared"."OutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_organizationId_status_createdAt_idx" ON "shared"."OutboxEvent"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "shared"."OutboxEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_organizationId_id_key" ON "shared"."OutboxEvent"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "shared"."AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "shared"."AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_organizationId_id_key" ON "shared"."AuditLog"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_internalStockNumber_key" ON "salvage"."Vehicle"("internalStockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vinOrHin_key" ON "salvage"."Vehicle"("vinOrHin");

-- CreateIndex
CREATE INDEX "Vehicle_organizationId_lifecycleState_operationalLane_idx" ON "salvage"."Vehicle"("organizationId", "lifecycleState", "operationalLane");

-- CreateIndex
CREATE INDEX "Vehicle_organizationId_availabilityState_idx" ON "salvage"."Vehicle"("organizationId", "availabilityState");

-- CreateIndex
CREATE INDEX "Vehicle_storageLocationId_idx" ON "salvage"."Vehicle"("storageLocationId");

-- CreateIndex
CREATE INDEX "Vehicle_make_model_year_idx" ON "salvage"."Vehicle"("make", "model", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_organizationId_id_key" ON "salvage"."Vehicle"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Part_qrSkuCode_key" ON "salvage"."Part"("qrSkuCode");

-- CreateIndex
CREATE UNIQUE INDEX "Part_ebayOfferId_key" ON "salvage"."Part"("ebayOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_ebayListingId_key" ON "salvage"."Part"("ebayListingId");

-- CreateIndex
CREATE INDEX "Part_organizationId_custodyState_availabilityState_idx" ON "salvage"."Part"("organizationId", "custodyState", "availabilityState");

-- CreateIndex
CREATE INDEX "Part_ebaySyncState_idx" ON "salvage"."Part"("ebaySyncState");

-- CreateIndex
CREATE INDEX "Part_complianceState_idx" ON "salvage"."Part"("complianceState");

-- CreateIndex
CREATE INDEX "Part_tdgHazmatCode_idx" ON "salvage"."Part"("tdgHazmatCode");

-- CreateIndex
CREATE INDEX "Part_donorVehicleId_idx" ON "salvage"."Part"("donorVehicleId");

-- CreateIndex
CREATE INDEX "Part_storageLocationId_idx" ON "salvage"."Part"("storageLocationId");

-- CreateIndex
CREATE INDEX "Part_steeringSideCompatibility_idx" ON "salvage"."Part"("steeringSideCompatibility");

-- CreateIndex
CREATE UNIQUE INDEX "Part_organizationId_id_key" ON "salvage"."Part"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ScrapComponentLog_organizationId_createdAt_idx" ON "salvage"."ScrapComponentLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ScrapComponentLog_vehicleId_scrapStream_idx" ON "salvage"."ScrapComponentLog"("vehicleId", "scrapStream");

-- CreateIndex
CREATE UNIQUE INDEX "ScrapComponentLog_organizationId_id_key" ON "salvage"."ScrapComponentLog"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_shipmentCode_key" ON "salvage"."Shipment"("shipmentCode");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_cersProofOfReportNumber_key" ON "salvage"."Shipment"("cersProofOfReportNumber");

-- CreateIndex
CREATE INDEX "Shipment_organizationId_createdAt_idx" ON "salvage"."Shipment"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_organizationId_id_key" ON "salvage"."Shipment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentPallet_palletQrCode_key" ON "salvage"."ShipmentPallet"("palletQrCode");

-- CreateIndex
CREATE INDEX "ShipmentPallet_organizationId_shipmentId_idx" ON "salvage"."ShipmentPallet"("organizationId", "shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentPallet_organizationId_id_key" ON "salvage"."ShipmentPallet"("organizationId", "id");

-- CreateIndex
CREATE INDEX "PreOrderWishList_organizationId_targetMake_targetModel_isFu_idx" ON "salvage"."PreOrderWishList"("organizationId", "targetMake", "targetModel", "isFulfilled");

-- CreateIndex
CREATE INDEX "PreOrderWishList_matchedPartId_idx" ON "salvage"."PreOrderWishList"("matchedPartId");

-- CreateIndex
CREATE INDEX "PreOrderWishList_matchedVehicleId_idx" ON "salvage"."PreOrderWishList"("matchedVehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "PreOrderWishList_organizationId_id_key" ON "salvage"."PreOrderWishList"("organizationId", "id");

-- CreateIndex
CREATE INDEX "B2BReservation_organizationId_isActive_idx" ON "salvage"."B2BReservation"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "B2BReservation_partId_isActive_idx" ON "salvage"."B2BReservation"("partId", "isActive");

-- CreateIndex
CREATE INDEX "B2BReservation_vehicleId_isActive_idx" ON "salvage"."B2BReservation"("vehicleId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "B2BReservation_organizationId_id_key" ON "salvage"."B2BReservation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransaction_receiptNumber_key" ON "salvage"."SaleTransaction"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransaction_taxInvoiceNumber_key" ON "salvage"."SaleTransaction"("taxInvoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransaction_gateTokenNonce_key" ON "salvage"."SaleTransaction"("gateTokenNonce");

-- CreateIndex
CREATE INDEX "SaleTransaction_organizationId_createdAt_idx" ON "salvage"."SaleTransaction"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleTransaction_organizationId_paymentSettlementState_cashC_idx" ON "salvage"."SaleTransaction"("organizationId", "paymentSettlementState", "cashCustodyState");

-- CreateIndex
CREATE INDEX "SaleTransaction_marketNode_domesticChannel_idx" ON "salvage"."SaleTransaction"("marketNode", "domesticChannel");

-- CreateIndex
CREATE INDEX "SaleTransaction_marketNode_exportChannel_idx" ON "salvage"."SaleTransaction"("marketNode", "exportChannel");

-- CreateIndex
CREATE INDEX "SaleTransaction_cashCustodyState_idx" ON "salvage"."SaleTransaction"("cashCustodyState");

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransaction_organizationId_id_key" ON "salvage"."SaleTransaction"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SaleTransactionPartItem_organizationId_partId_idx" ON "salvage"."SaleTransactionPartItem"("organizationId", "partId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransactionPartItem_organizationId_id_key" ON "salvage"."SaleTransactionPartItem"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SaleTransactionVehicleItem_organizationId_vehicleId_idx" ON "salvage"."SaleTransactionVehicleItem"("organizationId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransactionVehicleItem_organizationId_id_key" ON "salvage"."SaleTransactionVehicleItem"("organizationId", "id");

-- CreateIndex
CREATE INDEX "CycleCountTask_organizationId_status_dueAt_idx" ON "salvage"."CycleCountTask"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "CycleCountTask_batchCode_idx" ON "salvage"."CycleCountTask"("batchCode");

-- CreateIndex
CREATE UNIQUE INDEX "CycleCountTask_organizationId_id_key" ON "salvage"."CycleCountTask"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CurrencySettlement_batchCode_key" ON "salvage"."CurrencySettlement"("batchCode");

-- CreateIndex
CREATE INDEX "CurrencySettlement_organizationId_initiatedAt_idx" ON "salvage"."CurrencySettlement"("organizationId", "initiatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CurrencySettlement_organizationId_id_key" ON "salvage"."CurrencySettlement"("organizationId", "id");

-- CreateIndex
CREATE INDEX "CannabisStrain_organizationId_idx" ON "cannabis"."CannabisStrain"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CannabisStrain_organizationId_id_key" ON "cannabis"."CannabisStrain"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CannabisStrain_organizationId_name_key" ON "cannabis"."CannabisStrain"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CannabisLot_lotBarcode_key" ON "cannabis"."CannabisLot"("lotBarcode");

-- CreateIndex
CREATE INDEX "CannabisLot_organizationId_lotStage_idx" ON "cannabis"."CannabisLot"("organizationId", "lotStage");

-- CreateIndex
CREATE INDEX "CannabisLot_storageLocationId_idx" ON "cannabis"."CannabisLot"("storageLocationId");

-- CreateIndex
CREATE INDEX "CannabisLot_strainId_idx" ON "cannabis"."CannabisLot"("strainId");

-- CreateIndex
CREATE UNIQUE INDEX "CannabisLot_organizationId_id_key" ON "cannabis"."CannabisLot"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ProductionRun_organizationId_status_startedAt_idx" ON "cannabis"."ProductionRun"("organizationId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "ProductionRun_organizationId_startedAt_idx" ON "cannabis"."ProductionRun"("organizationId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRun_organizationId_id_key" ON "cannabis"."ProductionRun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRun_organizationId_runNumber_key" ON "cannabis"."ProductionRun"("organizationId", "runNumber");

-- CreateIndex
CREATE INDEX "ProductionRunInput_organizationId_productionRunId_idx" ON "cannabis"."ProductionRunInput"("organizationId", "productionRunId");

-- CreateIndex
CREATE INDEX "ProductionRunInput_organizationId_sourceLotId_idx" ON "cannabis"."ProductionRunInput"("organizationId", "sourceLotId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRunInput_organizationId_id_key" ON "cannabis"."ProductionRunInput"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRunInput_organizationId_productionRunId_sourceLot_key" ON "cannabis"."ProductionRunInput"("organizationId", "productionRunId", "sourceLotId");

-- CreateIndex
CREATE INDEX "ProductionRunOutput_organizationId_productionRunId_idx" ON "cannabis"."ProductionRunOutput"("organizationId", "productionRunId");

-- CreateIndex
CREATE INDEX "ProductionRunOutput_organizationId_outputLotId_idx" ON "cannabis"."ProductionRunOutput"("organizationId", "outputLotId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRunOutput_organizationId_id_key" ON "cannabis"."ProductionRunOutput"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRunOutput_organizationId_productionRunId_outputLo_key" ON "cannabis"."ProductionRunOutput"("organizationId", "productionRunId", "outputLotId");

-- CreateIndex
CREATE INDEX "CannabisDestructionLog_organizationId_destroyedAt_idx" ON "cannabis"."CannabisDestructionLog"("organizationId", "destroyedAt");

-- CreateIndex
CREATE INDEX "CannabisDestructionLog_lotId_idx" ON "cannabis"."CannabisDestructionLog"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "CannabisDestructionLog_organizationId_id_key" ON "cannabis"."CannabisDestructionLog"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalInventoryEvent_idempotencyKey_key" ON "cannabis"."CanonicalInventoryEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CanonicalInventoryEvent_organizationId_occurredAt_idx" ON "cannabis"."CanonicalInventoryEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "CanonicalInventoryEvent_organizationId_ctlsReportingCategor_idx" ON "cannabis"."CanonicalInventoryEvent"("organizationId", "ctlsReportingCategory", "occurredAt");

-- CreateIndex
CREATE INDEX "CanonicalInventoryEvent_cannabisLotId_occurredAt_idx" ON "cannabis"."CanonicalInventoryEvent"("cannabisLotId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalInventoryEvent_organizationId_id_key" ON "cannabis"."CanonicalInventoryEvent"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "shared"."OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."StorageLocation" ADD CONSTRAINT "StorageLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT "CustodyEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT "CustodyEvent_organizationId_partId_fkey" FOREIGN KEY ("organizationId", "partId") REFERENCES "salvage"."Part"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT "CustodyEvent_organizationId_vehicleId_fkey" FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT "CustodyEvent_organizationId_cannabisLotId_fkey" FOREIGN KEY ("organizationId", "cannabisLotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT "CustodyEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."Expense" ADD CONSTRAINT "Expense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."Expense" ADD CONSTRAINT "Expense_organizationId_vehicleId_fkey" FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."Expense" ADD CONSTRAINT "Expense_organizationId_shipmentId_fkey" FOREIGN KEY ("organizationId", "shipmentId") REFERENCES "salvage"."Shipment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."Expense" ADD CONSTRAINT "Expense_organizationId_cannabisLotId_fkey" FOREIGN KEY ("organizationId", "cannabisLotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."Expense" ADD CONSTRAINT "Expense_loggedByUserId_fkey" FOREIGN KEY ("loggedByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."Expense" ADD CONSTRAINT "Expense_organizationId_reversesExpenseId_fkey" FOREIGN KEY ("organizationId", "reversesExpenseId") REFERENCES "shared"."Expense"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CashCustodyTransfer" ADD CONSTRAINT "CashCustodyTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."CashCustodyTransfer" ADD CONSTRAINT "CashCustodyTransfer_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."OutboxEvent" ADD CONSTRAINT "OutboxEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared"."AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Vehicle" ADD CONSTRAINT "Vehicle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Vehicle" ADD CONSTRAINT "Vehicle_organizationId_storageLocationId_fkey" FOREIGN KEY ("organizationId", "storageLocationId") REFERENCES "shared"."StorageLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Vehicle" ADD CONSTRAINT "Vehicle_organizationId_shipmentId_fkey" FOREIGN KEY ("organizationId", "shipmentId") REFERENCES "salvage"."Shipment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Part" ADD CONSTRAINT "Part_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Part" ADD CONSTRAINT "Part_organizationId_donorVehicleId_fkey" FOREIGN KEY ("organizationId", "donorVehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Part" ADD CONSTRAINT "Part_strippedByUserId_fkey" FOREIGN KEY ("strippedByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Part" ADD CONSTRAINT "Part_organizationId_storageLocationId_fkey" FOREIGN KEY ("organizationId", "storageLocationId") REFERENCES "shared"."StorageLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Part" ADD CONSTRAINT "Part_organizationId_shipmentPalletId_fkey" FOREIGN KEY ("organizationId", "shipmentPalletId") REFERENCES "salvage"."ShipmentPallet"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."ScrapComponentLog" ADD CONSTRAINT "ScrapComponentLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."ScrapComponentLog" ADD CONSTRAINT "ScrapComponentLog_organizationId_vehicleId_fkey" FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."ScrapComponentLog" ADD CONSTRAINT "ScrapComponentLog_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."Shipment" ADD CONSTRAINT "Shipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."ShipmentPallet" ADD CONSTRAINT "ShipmentPallet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."ShipmentPallet" ADD CONSTRAINT "ShipmentPallet_organizationId_shipmentId_fkey" FOREIGN KEY ("organizationId", "shipmentId") REFERENCES "salvage"."Shipment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."PreOrderWishList" ADD CONSTRAINT "PreOrderWishList_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."PreOrderWishList" ADD CONSTRAINT "PreOrderWishList_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."PreOrderWishList" ADD CONSTRAINT "PreOrderWishList_organizationId_matchedPartId_fkey" FOREIGN KEY ("organizationId", "matchedPartId") REFERENCES "salvage"."Part"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."PreOrderWishList" ADD CONSTRAINT "PreOrderWishList_organizationId_matchedVehicleId_fkey" FOREIGN KEY ("organizationId", "matchedVehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."B2BReservation" ADD CONSTRAINT "B2BReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."B2BReservation" ADD CONSTRAINT "B2BReservation_organizationId_partId_fkey" FOREIGN KEY ("organizationId", "partId") REFERENCES "salvage"."Part"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."B2BReservation" ADD CONSTRAINT "B2BReservation_organizationId_vehicleId_fkey" FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_soldByUserId_fkey" FOREIGN KEY ("soldByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_brokerUserId_fkey" FOREIGN KEY ("brokerUserId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_verifiedByAdminId_fkey" FOREIGN KEY ("verifiedByAdminId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_cfoOverrideApprovedById_fkey" FOREIGN KEY ("cfoOverrideApprovedById") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_organizationId_reversesSaleTxId_fkey" FOREIGN KEY ("organizationId", "reversesSaleTxId") REFERENCES "salvage"."SaleTransaction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT "SaleTransaction_organizationId_settlementBatchId_fkey" FOREIGN KEY ("organizationId", "settlementBatchId") REFERENCES "salvage"."CurrencySettlement"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransactionPartItem" ADD CONSTRAINT "SaleTransactionPartItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransactionPartItem" ADD CONSTRAINT "SaleTransactionPartItem_organizationId_saleTransactionId_fkey" FOREIGN KEY ("organizationId", "saleTransactionId") REFERENCES "salvage"."SaleTransaction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransactionPartItem" ADD CONSTRAINT "SaleTransactionPartItem_organizationId_partId_fkey" FOREIGN KEY ("organizationId", "partId") REFERENCES "salvage"."Part"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransactionVehicleItem" ADD CONSTRAINT "SaleTransactionVehicleItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransactionVehicleItem" ADD CONSTRAINT "SaleTransactionVehicleItem_organizationId_saleTransactionI_fkey" FOREIGN KEY ("organizationId", "saleTransactionId") REFERENCES "salvage"."SaleTransaction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."SaleTransactionVehicleItem" ADD CONSTRAINT "SaleTransactionVehicleItem_organizationId_vehicleId_fkey" FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."CycleCountTask" ADD CONSTRAINT "CycleCountTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."CycleCountTask" ADD CONSTRAINT "CycleCountTask_organizationId_partId_fkey" FOREIGN KEY ("organizationId", "partId") REFERENCES "salvage"."Part"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."CycleCountTask" ADD CONSTRAINT "CycleCountTask_organizationId_vehicleId_fkey" FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "salvage"."Vehicle"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."CycleCountTask" ADD CONSTRAINT "CycleCountTask_assignedToAdminId_fkey" FOREIGN KEY ("assignedToAdminId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salvage"."CurrencySettlement" ADD CONSTRAINT "CurrencySettlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisStrain" ADD CONSTRAINT "CannabisStrain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisLot" ADD CONSTRAINT "CannabisLot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisLot" ADD CONSTRAINT "CannabisLot_organizationId_strainId_fkey" FOREIGN KEY ("organizationId", "strainId") REFERENCES "cannabis"."CannabisStrain"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisLot" ADD CONSTRAINT "CannabisLot_organizationId_parentMotherLotId_fkey" FOREIGN KEY ("organizationId", "parentMotherLotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisLot" ADD CONSTRAINT "CannabisLot_organizationId_storageLocationId_fkey" FOREIGN KEY ("organizationId", "storageLocationId") REFERENCES "shared"."StorageLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT "ProductionRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT "ProductionRun_executedByUserId_fkey" FOREIGN KEY ("executedByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT "ProductionRun_verifiedByQapUserId_fkey" FOREIGN KEY ("verifiedByQapUserId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT "ProductionRun_organizationId_reversesProductionRunId_fkey" FOREIGN KEY ("organizationId", "reversesProductionRunId") REFERENCES "cannabis"."ProductionRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRunInput" ADD CONSTRAINT "ProductionRunInput_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRunInput" ADD CONSTRAINT "ProductionRunInput_organizationId_productionRunId_fkey" FOREIGN KEY ("organizationId", "productionRunId") REFERENCES "cannabis"."ProductionRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRunInput" ADD CONSTRAINT "ProductionRunInput_organizationId_sourceLotId_fkey" FOREIGN KEY ("organizationId", "sourceLotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRunOutput" ADD CONSTRAINT "ProductionRunOutput_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRunOutput" ADD CONSTRAINT "ProductionRunOutput_organizationId_productionRunId_fkey" FOREIGN KEY ("organizationId", "productionRunId") REFERENCES "cannabis"."ProductionRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."ProductionRunOutput" ADD CONSTRAINT "ProductionRunOutput_organizationId_outputLotId_fkey" FOREIGN KEY ("organizationId", "outputLotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT "CannabisDestructionLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT "CannabisDestructionLog_organizationId_lotId_fkey" FOREIGN KEY ("organizationId", "lotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT "CannabisDestructionLog_primaryUserId_fkey" FOREIGN KEY ("primaryUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT "CannabisDestructionLog_witnessUserId_fkey" FOREIGN KEY ("witnessUserId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT "CannabisDestructionLog_secondWitnessUserId_fkey" FOREIGN KEY ("secondWitnessUserId") REFERENCES "shared"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ADD CONSTRAINT "CanonicalInventoryEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "shared"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ADD CONSTRAINT "CanonicalInventoryEvent_organizationId_cannabisLotId_fkey" FOREIGN KEY ("organizationId", "cannabisLotId") REFERENCES "cannabis"."CannabisLot"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ADD CONSTRAINT "CanonicalInventoryEvent_organizationId_productionRunId_fkey" FOREIGN KEY ("organizationId", "productionRunId") REFERENCES "cannabis"."ProductionRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ADD CONSTRAINT "CanonicalInventoryEvent_organizationId_destructionLogId_fkey" FOREIGN KEY ("organizationId", "destructionLogId") REFERENCES "cannabis"."CannabisDestructionLog"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ADD CONSTRAINT "CanonicalInventoryEvent_organizationId_reversesCanonicalEv_fkey" FOREIGN KEY ("organizationId", "reversesCanonicalEventId") REFERENCES "cannabis"."CanonicalInventoryEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ADD CONSTRAINT "CanonicalInventoryEvent_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "shared"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- 0b. Provision & Harden Least-Privilege Runtime Role erp_app_user (ADR-0005 / ADR-0006)
-- ============================================================================
DO $$
DECLARE
  v_inherited_role text;
  v_owned_object text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'erp_app_user') THEN
    SELECT r.rolname
      INTO v_inherited_role
      FROM pg_catalog.pg_auth_members am
      INNER JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      INNER JOIN pg_catalog.pg_roles m ON m.oid = am.member
     WHERE m.rolname = 'erp_app_user'
     LIMIT 1;

    IF v_inherited_role IS NOT NULL THEN
      RAISE EXCEPTION 'Refusing migration: existing role erp_app_user inherits or is granted role "%", which undermines least-privilege isolation.', v_inherited_role;
    END IF;

    SELECT n.nspname || '.' || c.relname
      INTO v_owned_object
      FROM pg_catalog.pg_class c
      INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      INNER JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
     WHERE r.rolname = 'erp_app_user'
       AND n.nspname IN ('shared', 'salvage', 'cannabis')
     LIMIT 1;

    IF v_owned_object IS NOT NULL THEN
      RAISE EXCEPTION 'Refusing migration: runtime role erp_app_user owns application relation "%", which would bypass RLS.', v_owned_object;
    END IF;

    SELECT n.nspname || '.' || p.proname
      INTO v_owned_object
      FROM pg_catalog.pg_proc p
      INNER JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      INNER JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE r.rolname = 'erp_app_user'
       AND n.nspname IN ('shared', 'salvage', 'cannabis')
     LIMIT 1;

    IF v_owned_object IS NOT NULL THEN
      RAISE EXCEPTION 'Refusing migration: runtime role erp_app_user owns function "%".', v_owned_object;
    END IF;
  ELSE
    CREATE ROLE erp_app_user LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;

ALTER ROLE erp_app_user LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
ALTER ROLE erp_app_user SET plan_cache_mode = 'force_custom_plan';

REVOKE ALL ON SCHEMA "shared", "salvage", "cannabis" FROM PUBLIC;
REVOKE CREATE ON SCHEMA "shared", "salvage", "cannabis", "public" FROM erp_app_user;
GRANT USAGE ON SCHEMA "shared", "salvage", "cannabis" TO erp_app_user;

-- ============================================================================
-- 0c. Membership-Verifying Transaction-Local Context & Bootstrap Helpers
--     (Fixed empty search_path, SECURITY DEFINER, owned by BYPASSRLS migration owner)
-- ============================================================================
CREATE OR REPLACE FUNCTION "shared"."current_user_id"() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_raw text;
  v_user_id uuid;
BEGIN
  v_raw := NULLIF(pg_catalog.current_setting('app.current_user_id', true), '');
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_user_id := v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM "shared"."User" u
    WHERE u."id" = v_user_id AND u."isActive" = true
  ) THEN
    RETURN v_user_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "shared"."current_org_id"() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_raw_org text;
  v_raw_user text;
  v_role text;
  v_org_id uuid;
  v_user_id uuid;
BEGIN
  v_raw_org := NULLIF(pg_catalog.current_setting('app.current_org_id', true), '');
  v_raw_user := NULLIF(pg_catalog.current_setting('app.current_user_id', true), '');
  v_role := NULLIF(pg_catalog.current_setting('app.current_role', true), '');
  IF v_raw_org IS NULL OR v_raw_user IS NULL OR v_role IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_org_id := v_raw_org::uuid;
    v_user_id := v_raw_user::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF EXISTS (
    SELECT 1
    FROM "shared"."OrganizationMembership" m
    INNER JOIN "shared"."User" u ON u."id" = m."userId"
    INNER JOIN "shared"."Organization" o ON o."id" = m."organizationId"
    WHERE m."organizationId" = v_org_id
      AND m."userId" = v_user_id
      AND m."role"::text = v_role
      AND m."isActive" = true
      AND u."isActive" = true
      AND o."isActive" = true
  ) THEN
    RETURN v_org_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "shared"."current_role"() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF "shared"."current_org_id"() IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(pg_catalog.current_setting('app.current_role', true), '');
END;
$$;

CREATE OR REPLACE FUNCTION "shared"."is_user_in_current_org"(target_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    "shared"."current_org_id"() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "shared"."OrganizationMembership" m
      WHERE m."organizationId" = "shared"."current_org_id"()
        AND m."userId" = target_user_id
    );
$$;

CREATE OR REPLACE FUNCTION "shared"."can_bootstrap_select_org"(target_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    "shared"."current_org_id"() IS NULL
    AND "shared"."current_user_id"() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "shared"."OrganizationMembership" m
      INNER JOIN "shared"."Organization" o ON o."id" = m."organizationId"
      WHERE m."organizationId" = target_org_id
        AND m."userId" = "shared"."current_user_id"()
        AND m."isActive" = true
        AND o."isActive" = true
    );
$$;

REVOKE ALL ON FUNCTION
  "shared"."current_user_id"(),
  "shared"."current_org_id"(),
  "shared"."current_role"(),
  "shared"."is_user_in_current_org"(uuid),
  "shared"."can_bootstrap_select_org"(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  "shared"."current_user_id"(),
  "shared"."current_org_id"(),
  "shared"."current_role"(),
  "shared"."is_user_in_current_org"(uuid),
  "shared"."can_bootstrap_select_org"(uuid)
TO erp_app_user;

-- ============================================================================
-- 1. Tiered Receipt/Voucher, Piece-Rate Donor & Deposit Slip Constraints
-- ============================================================================
ALTER TABLE "shared"."Expense" ADD CONSTRAINT expense_receipt_or_voucher_check CHECK (
  (
    "receiptVerificationState" = 'VERIFIED_RECEIPT'
    AND "receiptStorageKey" IS NOT NULL
    AND length(trim("receiptStorageKey")) > 0
  )
  OR (
    "receiptVerificationState" IN ('PETTY_CASH_VOUCHER', 'PENDING_RECEIPT_UPLOAD')
    AND "voucherReason" IS NOT NULL
    AND length(trim("voucherReason")) >= 5
  )
);

ALTER TABLE "shared"."Expense" ADD CONSTRAINT piece_rate_requires_donor_vehicle CHECK (
  "category" <> 'YARD_STRIPPER_PIECE_RATE' OR "vehicleId" IS NOT NULL
);

ALTER TABLE "shared"."CashCustodyTransfer" ADD CONSTRAINT transfer_slip_non_empty CHECK (
  "depositSlipStorageKey" IS NOT NULL AND length(trim("depositSlipStorageKey")) > 0
);

-- ============================================================================
-- 2. Commission Holdback, Payment Settlement Liquidity Separation (FIX 05) &
--    Jurisdiction-Aware Tax Collection Mode Consistency (FIX 06)
-- ============================================================================
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT commission_requires_verified_payment CHECK (
  "brokerCommissionPaidAt" IS NULL OR "isPaymentVerified" = true
);

ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT sale_settlement_custody_consistency CHECK (
  (
    "paymentSettlementState" IN ('SALE_RECORDED', 'PAYMENT_INITIATED', 'MARKETPLACE_PAYOUT_PENDING', 'BANK_SETTLEMENT_PENDING')
    AND "cashCustodyState" = 'PENDING_EXTERNAL_RECEIVABLE'
    AND "bankSettledAt" IS NULL
  )
  OR (
    "paymentSettlementState" = 'PAYMENT_CONFIRMED'
    AND "cashCustodyState" IN ('HELD_IN_OPERATOR_FLOAT', 'HELD_IN_DESTINATION_VAULT', 'DEPOSITED_DESTINATION_BANK')
    AND "paymentConfirmedAt" IS NOT NULL
    AND "bankSettledAt" IS NULL
  )
  OR (
    "paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED'
    AND "cashCustodyState" = 'SETTLED_ORIGIN_CORP_BANK'
    AND "bankSettledAt" IS NOT NULL
    AND "bankDepositReference" IS NOT NULL
    AND length(trim("bankDepositReference")) > 0
  )
  OR (
    "paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK'
    AND "isVoidedOrReversed" = true
    AND "voidReason" IS NOT NULL
    AND length(trim("voidReason")) > 0
  )
);

ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT sale_tax_collection_mode_consistency CHECK (
  (
    "domesticChannel" IS DISTINCT FROM 'EBAY_MOTORS_SHIPPED'
    OR (
      "taxCollectionMode" = 'MARKETPLACE_FACILITATOR_COLLECTED'
      AND "taxOrVatMinor" = 0
    )
  )
  AND (
    "taxCollectionMode" = 'DIRECT_SELLER_COLLECTED'
    OR "taxOrVatMinor" = 0
  )
  AND (
    "taxCollectionMode" <> 'ZERO_RATED_EXPORT'
    OR (
      "destinationCountryCode" IS NOT NULL
      AND "destinationCountryCode" <> 'CA'
      AND "deliveryMethod" = 'SELLER_SHIPPED'
      AND "exportProofStorageKey" IS NOT NULL
      AND length(trim("exportProofStorageKey")) > 0
    )
  )
  AND (
    "itcReceivableCadMinor" = 0
    OR (
      "isFeeTaxInvoiceVerified" = true
      AND "feeTaxInvoiceStorageKey" IS NOT NULL
      AND length(trim("feeTaxInvoiceStorageKey")) > 0
    )
  )
);

-- ============================================================================
-- 3. Watercraft / Equipment Bypass of RoadVehicleBrand
-- ============================================================================
ALTER TABLE "salvage"."Vehicle" ADD CONSTRAINT non_auto_brand_check CHECK (
  "assetCategory" = 'AUTOMOBILE' OR "roadBrand" = 'NOT_APPLICABLE'
);

-- ============================================================================
-- 4. Immutability Triggers, Financial Column Protection & Settlement Transitions
-- ============================================================================
CREATE OR REPLACE FUNCTION "shared"."prevent_audit_tampering"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Tampering prohibited on immutable financial/compliance/audit table: %', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER lock_audit_log BEFORE UPDATE OR DELETE ON "shared"."AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_custody_event BEFORE UPDATE OR DELETE ON "shared"."CustodyEvent"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_cash_transfer_mutation BEFORE UPDATE OR DELETE ON "shared"."CashCustodyTransfer"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_scrap_log_mutation BEFORE UPDATE OR DELETE ON "salvage"."ScrapComponentLog"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_cannabis_destruction_log BEFORE UPDATE OR DELETE ON "cannabis"."CannabisDestructionLog"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_canonical_inventory_event BEFORE UPDATE OR DELETE ON "cannabis"."CanonicalInventoryEvent"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();

CREATE TRIGGER lock_expense_delete BEFORE DELETE ON "shared"."Expense"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_sale_tx_delete BEFORE DELETE ON "salvage"."SaleTransaction"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();
CREATE TRIGGER lock_production_run_delete BEFORE DELETE ON "cannabis"."ProductionRun"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_audit_tampering"();

CREATE OR REPLACE FUNCTION "shared"."prevent_expense_financial_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."vehicleId" IS DISTINCT FROM OLD."vehicleId"
     OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId"
     OR NEW."cannabisLotId" IS DISTINCT FROM OLD."cannabisLotId"
     OR NEW."loggedByUserId" IS DISTINCT FROM OLD."loggedByUserId"
     OR NEW."category" IS DISTINCT FROM OLD."category"
     OR NEW."amountOriginalMinor" IS DISTINCT FROM OLD."amountOriginalMinor"
     OR NEW."currencyOriginal" IS DISTINCT FROM OLD."currencyOriginal"
     OR NEW."amountCadMinor" IS DISTINCT FROM OLD."amountCadMinor"
     OR NEW."isDeferredIntercompanyAccrual" IS DISTINCT FROM OLD."isDeferredIntercompanyAccrual"
     OR NEW."isReversalEntry" IS DISTINCT FROM OLD."isReversalEntry"
     OR NEW."reversesExpenseId" IS DISTINCT FROM OLD."reversesExpenseId"
     OR NEW."incurredAt" IS DISTINCT FROM OLD."incurredAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."accrualSettledAt" IS NOT NULL AND NEW."accrualSettledAt" IS DISTINCT FROM OLD."accrualSettledAt")
     OR (OLD."receiptStorageKey" IS NOT NULL AND (
          NEW."receiptVerificationState" IS DISTINCT FROM OLD."receiptVerificationState"
          OR NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor"
          OR NEW."receiptStorageKey" IS DISTINCT FROM OLD."receiptStorageKey"
          OR NEW."receiptSha256Hash" IS DISTINCT FROM OLD."receiptSha256Hash"
        )) THEN
    RAISE EXCEPTION 'Immutable financial columns on Expense cannot be modified after creation; log a reversal entry instead.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lock_expense_immutable_cols BEFORE UPDATE ON "shared"."Expense"
  FOR EACH ROW EXECUTE FUNCTION "shared"."prevent_expense_financial_mutation"();

CREATE OR REPLACE FUNCTION "salvage"."prevent_sale_tx_financial_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."receiptNumber" IS DISTINCT FROM OLD."receiptNumber"
     OR NEW."marketNode" IS DISTINCT FROM OLD."marketNode"
     OR NEW."domesticChannel" IS DISTINCT FROM OLD."domesticChannel"
     OR NEW."exportChannel" IS DISTINCT FROM OLD."exportChannel"
     OR NEW."paymentCurrency" IS DISTINCT FROM OLD."paymentCurrency"
     OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
     OR NEW."discountAmountMinor" IS DISTINCT FROM OLD."discountAmountMinor"
     OR NEW."platformFeeMinor" IS DISTINCT FROM OLD."platformFeeMinor"
     OR NEW."shippingCostMinor" IS DISTINCT FROM OLD."shippingCostMinor"
     OR NEW."grossCollectedMinor" IS DISTINCT FROM OLD."grossCollectedMinor"
     OR NEW."taxCollectionMode" IS DISTINCT FROM OLD."taxCollectionMode"
     OR NEW."appliedTaxJurisdiction" IS DISTINCT FROM OLD."appliedTaxJurisdiction"
     OR NEW."appliedTaxRateBps" IS DISTINCT FROM OLD."appliedTaxRateBps"
     OR NEW."taxOrVatMinor" IS DISTINCT FROM OLD."taxOrVatMinor"
     OR (OLD."buyerTaxRemittedByPlatformMinor" IS NOT NULL AND NEW."buyerTaxRemittedByPlatformMinor" IS DISTINCT FROM OLD."buyerTaxRemittedByPlatformMinor")
     OR NEW."estimatedPlatformFeeTaxCadMinor" IS DISTINCT FROM OLD."estimatedPlatformFeeTaxCadMinor"
     OR (OLD."isFeeTaxInvoiceVerified" = true AND (
          NEW."isFeeTaxInvoiceVerified" = false
          OR NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor"
          OR NEW."feeTaxInvoiceStorageKey" IS DISTINCT FROM OLD."feeTaxInvoiceStorageKey"
        ))
     OR NEW."netRealizedCadMinor" IS DISTINCT FROM OLD."netRealizedCadMinor"
     OR NEW."paymentProofStorageKey" IS DISTINCT FROM OLD."paymentProofStorageKey"
     OR NEW."reversesSaleTxId" IS DISTINCT FROM OLD."reversesSaleTxId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."isVoidedOrReversed" = true AND (
          NEW."isVoidedOrReversed" = false
          OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"
        )) THEN
    RAISE EXCEPTION 'Immutable financial or tax columns on SaleTransaction cannot be modified after creation.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "salvage"."enforce_sale_settlement_transition"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_allowed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK' THEN
      RAISE EXCEPTION 'New SaleTransaction cannot start in terminal REFUNDED_OR_CHARGED_BACK state';
    END IF;
    IF NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED'
       AND NEW."paymentMethod" <> 'VERIFIED_BANK_WIRE' THEN
      RAISE EXCEPTION 'New SaleTransaction can only start in BANK_SETTLEMENT_CONFIRMED with paymentMethod VERIFIED_BANK_WIRE';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."paymentSettlementState" IS DISTINCT FROM OLD."paymentSettlementState" THEN
    IF OLD."paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK' THEN
      RAISE EXCEPTION 'Terminal REFUNDED_OR_CHARGED_BACK SaleTransaction cannot transition to %', NEW."paymentSettlementState";
    END IF;

    IF NEW."paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK' THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'SALE_RECORDED'
          AND NEW."paymentSettlementState" IN ('PAYMENT_INITIATED', 'MARKETPLACE_PAYOUT_PENDING') THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'PAYMENT_INITIATED'
          AND NEW."paymentSettlementState" IN ('PAYMENT_CONFIRMED', 'BANK_SETTLEMENT_PENDING') THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'MARKETPLACE_PAYOUT_PENDING'
          AND NEW."paymentSettlementState" IN ('BANK_SETTLEMENT_PENDING', 'BANK_SETTLEMENT_CONFIRMED') THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'BANK_SETTLEMENT_PENDING'
          AND NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED' THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" <> 'REFUNDED_OR_CHARGED_BACK'
          AND NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED'
          AND NEW."paymentMethod" = 'VERIFIED_BANK_WIRE'
          AND (
            OLD."paymentSettlementState" IN ('SALE_RECORDED', 'PAYMENT_INITIATED')
            OR OLD."paymentMethod" = 'VERIFIED_BANK_WIRE'
          ) THEN
      v_allowed := true;
    END IF;

    IF NOT v_allowed THEN
      RAISE EXCEPTION 'Illegal PaymentSettlementState transition from % to % (paymentMethod=%)',
        OLD."paymentSettlementState", NEW."paymentSettlementState", NEW."paymentMethod";
    END IF;
  END IF;

  -- If transaction is voided/reversed/refunded, automatically release active lock on child line items
  IF NEW."isVoidedOrReversed" = true AND OLD."isVoidedOrReversed" = false THEN
    UPDATE "salvage"."SaleTransactionPartItem"
       SET "isActiveSale" = false
     WHERE "organizationId" = NEW."organizationId"
       AND "saleTransactionId" = NEW."id";
    UPDATE "salvage"."SaleTransactionVehicleItem"
       SET "isActiveSale" = false
     WHERE "organizationId" = NEW."organizationId"
       AND "saleTransactionId" = NEW."id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER a_lock_sale_tx_immutable_cols BEFORE UPDATE ON "salvage"."SaleTransaction"
  FOR EACH ROW EXECUTE FUNCTION "salvage"."prevent_sale_tx_financial_mutation"();

CREATE TRIGGER b_enforce_sale_settlement_transition BEFORE INSERT OR UPDATE ON "salvage"."SaleTransaction"
  FOR EACH ROW EXECUTE FUNCTION "salvage"."enforce_sale_settlement_transition"();

-- ============================================================================
-- 5. Channel Attribution Integrity (DomesticSaleChannel XOR ExportSaleChannel)
-- ============================================================================
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT sale_channel_node_integrity CHECK (
  ("marketNode" = 'DOMESTIC_ORIGIN' AND "domesticChannel" IS NOT NULL AND "exportChannel" IS NULL)
  OR
  ("marketNode" = 'DESTINATION_EXPORT_VAULT' AND "exportChannel" IS NOT NULL AND "domesticChannel" IS NULL)
);

-- ============================================================================
-- 6. Retail Lot Whole-Vehicle Bill of Sale Requirement
-- ============================================================================
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT retail_lot_vehicle_bill_of_sale_required CHECK (
  "domesticChannel" IS DISTINCT FROM 'RETAIL_LOT_VEHICLE_SALE'
  OR ("billOfSaleStorageKey" IS NOT NULL AND length(trim("billOfSaleStorageKey")) > 0)
);

-- ============================================================================
-- 7. Exclusive Target Constraints on CustodyEvent, B2BReservation & CycleCountTask
-- ============================================================================
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT custody_event_target_xor CHECK (
  num_nonnulls("partId", "vehicleId", "cannabisLotId") = 1
);

ALTER TABLE "salvage"."B2BReservation" ADD CONSTRAINT b2b_reservation_target_xor CHECK (
  ("partId" IS NOT NULL AND "vehicleId" IS NULL) OR ("partId" IS NULL AND "vehicleId" IS NOT NULL)
);

ALTER TABLE "salvage"."CycleCountTask" ADD CONSTRAINT cycle_count_target_xor CHECK (
  ("partId" IS NOT NULL AND "vehicleId" IS NULL) OR ("partId" IS NULL AND "vehicleId" IS NOT NULL)
);

-- ============================================================================
-- 8. Partial Unique Indexes Preventing Overlapping Active Holds & Sales
-- ============================================================================
CREATE UNIQUE INDEX unique_active_part_reservation
  ON "salvage"."B2BReservation" ("partId")
  WHERE "isActive" = true AND "partId" IS NOT NULL;

CREATE UNIQUE INDEX unique_active_vehicle_reservation
  ON "salvage"."B2BReservation" ("vehicleId")
  WHERE "isActive" = true AND "vehicleId" IS NOT NULL;

CREATE UNIQUE INDEX unique_active_sold_part
  ON "salvage"."SaleTransactionPartItem" ("partId")
  WHERE "isActiveSale" = true;

CREATE UNIQUE INDEX unique_active_sold_vehicle
  ON "salvage"."SaleTransactionVehicleItem" ("vehicleId")
  WHERE "isActiveSale" = true;

-- ============================================================================
-- 9. Dormant Post-2025 3-Stream Cannabis Destruction Rules (SOR/2025-45)
-- ============================================================================
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT cannabis_destruction_stream_rules CHECK (
  ("destructionStream" = 'CULTIVATION_WASTE')
  OR (
    "destructionStream" = 'WHOLE_PLANTS'
    AND "witnessUserId" IS NOT NULL
    AND "witnessUserId" <> "primaryUserId"
    AND "destroyedPlantCount" IS NOT NULL
    AND "destroyedPlantCount" > 0
  )
  OR (
    "destructionStream" = 'OTHER_CANNABIS'
    AND "witnessUserId" IS NOT NULL
    AND "witnessUserId" <> "primaryUserId"
    AND "destroyedNetMassTenthGrams" IS NOT NULL
    AND "destroyedNetMassTenthGrams" > 0
  )
);

ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT cannabis_destruction_second_witness_distinct CHECK (
  "secondWitnessUserId" IS NULL
  OR (
    "secondWitnessUserId" <> "primaryUserId"
    AND ("witnessUserId" IS NULL OR "secondWitnessUserId" <> "witnessUserId")
  )
);

-- ============================================================================
-- 10. Dormant Phase 2B Cannabis ProductionRun Lifecycle, Child Locking &
--     Finalization Triggers (FIX 04 / ADR-0006)
-- ============================================================================
ALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT cannabis_production_run_non_negative_quantities CHECK (
  "totalInputMassTenthGrams" >= 0
  AND "totalOutputMassTenthGrams" >= 0
  AND "processLossMassTenthGrams" >= 0
  AND "destroyedByproductMassTenthGrams" >= 0
);

ALTER TABLE "cannabis"."ProductionRunInput" ADD CONSTRAINT cannabis_run_input_positive_quantities CHECK (
  "consumedMassTenthGrams" > 0
  AND "consumedFlowerMassTenthGrams" >= 0
  AND "consumedNonFlowerMassTenthGrams" >= 0
  AND "consumedDiscreteUnits" >= 0
  AND ("consumedTotalThcMg" IS NULL OR "consumedTotalThcMg" >= 0)
);

ALTER TABLE "cannabis"."ProductionRunOutput" ADD CONSTRAINT cannabis_run_output_positive_quantities CHECK (
  "yieldedMassTenthGrams" >= 0
  AND ("yieldedMassTenthGrams" > 0 OR "yieldedDiscreteUnits" > 0)
  AND "yieldedFlowerMassTenthGrams" >= 0
  AND "yieldedNonFlowerMassTenthGrams" >= 0
  AND "yieldedDiscreteUnits" >= 0
  AND ("yieldedTotalThcMg" IS NULL OR "yieldedTotalThcMg" >= 0)
);

CREATE OR REPLACE FUNCTION "cannabis"."guard_production_run_child_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_org_id uuid;
  v_run_id uuid;
  v_status "cannabis"."CannabisProductionRunStatus";
BEGIN
  v_org_id := COALESCE(NEW."organizationId", OLD."organizationId");
  v_run_id := COALESCE(NEW."productionRunId", OLD."productionRunId");

  -- Acquire exclusive FOR UPDATE row lock on parent ProductionRun to serialize concurrent child mutations against finalization
  SELECT p."status"
    INTO v_status
    FROM "cannabis"."ProductionRun" p
   WHERE p."organizationId" = v_org_id
     AND p."id" = v_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent ProductionRun (%) not found in organization (%)', v_run_id, v_org_id;
  END IF;

  IF v_status IN ('FINALIZED', 'VOIDED') THEN
    RAISE EXCEPTION 'Cannot insert, update, or delete child rows on % ProductionRun (%)', v_status, v_run_id;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."productionRunId" IS DISTINCT FROM OLD."productionRunId"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
  ) THEN
    RAISE EXCEPTION 'Cannot reassign ProductionRun child row across runs or organizations';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_production_run_input_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON "cannabis"."ProductionRunInput"
  FOR EACH ROW EXECUTE FUNCTION "cannabis"."guard_production_run_child_mutation"();

CREATE TRIGGER guard_production_run_output_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON "cannabis"."ProductionRunOutput"
  FOR EACH ROW EXECUTE FUNCTION "cannabis"."guard_production_run_child_mutation"();

CREATE OR REPLACE FUNCTION "cannabis"."enforce_production_run_lifecycle_and_finalization"() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_input_count integer;
  v_output_count integer;
  v_sum_input_mass numeric;
  v_sum_output_mass numeric;
  v_cross_org_count integer;
  v_unquarantined_outputs integer;
  v_qap_member_valid boolean;
BEGIN
  -- 1. Prevent direct INSERT into FINALIZED or VOIDED before child rows exist
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'New ProductionRun must start in DRAFT or IN_PROGRESS status, got %', NEW."status";
    END IF;
    RETURN NEW;
  END IF;

  -- 2. Prevent cross-organization reassignment
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
    RAISE EXCEPTION 'Cannot reassign ProductionRun (%) across organizations', OLD."id";
  END IF;

  -- 3. Enforce strict immutability of FINALIZED and VOIDED runs (post-finalization errors require compensating reversals)
  IF OLD."status" IN ('FINALIZED', 'VOIDED') THEN
    RAISE EXCEPTION 'ProductionRun (%) in terminal status % is immutable; record a compensating CanonicalInventoryEvent or reversal run instead', OLD."id", OLD."status";
  END IF;

  -- 4. Enforce valid lifecycle transitions from DRAFT / IN_PROGRESS
  IF OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Illegal backward ProductionRun status transition from IN_PROGRESS to DRAFT';
  END IF;

  -- 5. VOIDED requires auditable voidReason and preserves historical trail
  IF NEW."status" = 'VOIDED' THEN
    IF NEW."voidReason" IS NULL OR length(trim(NEW."voidReason")) < 5 THEN
      RAISE EXCEPTION 'Voiding ProductionRun (%) requires voidReason (>= 5 characters)', NEW."id";
    END IF;
    NEW."voidedAt" := COALESCE(NEW."voidedAt", now());
    RETURN NEW;
  END IF;

  -- 6. Atomic finalization checks when transitioning into FINALIZED (parent row is already locked by UPDATE)
  IF NEW."status" = 'FINALIZED' THEN
    SELECT COUNT(*), COALESCE(SUM(i."consumedMassTenthGrams"::numeric), 0)
      INTO v_input_count, v_sum_input_mass
      FROM "cannabis"."ProductionRunInput" i
     WHERE i."organizationId" = NEW."organizationId"
       AND i."productionRunId" = NEW."id";

    SELECT COUNT(*), COALESCE(SUM(o."yieldedMassTenthGrams"::numeric), 0)
      INTO v_output_count, v_sum_output_mass
      FROM "cannabis"."ProductionRunOutput" o
     WHERE o."organizationId" = NEW."organizationId"
       AND o."productionRunId" = NEW."id";

    IF v_input_count < 1 THEN
      RAISE EXCEPTION 'Cannot finalize ProductionRun (%): at least one ProductionRunInput row is required', NEW."id";
    END IF;

    IF v_output_count < 1 THEN
      RAISE EXCEPTION 'Cannot finalize ProductionRun (%): at least one ProductionRunOutput row is required', NEW."id";
    END IF;

    SELECT COUNT(*)
      INTO v_cross_org_count
      FROM (
        SELECT 1 FROM "cannabis"."ProductionRunInput" i
          INNER JOIN "cannabis"."CannabisLot" l ON l."id" = i."sourceLotId"
         WHERE i."productionRunId" = NEW."id"
           AND (i."organizationId" <> NEW."organizationId" OR l."organizationId" <> NEW."organizationId")
        UNION ALL
        SELECT 1 FROM "cannabis"."ProductionRunOutput" o
          INNER JOIN "cannabis"."CannabisLot" l ON l."id" = o."outputLotId"
         WHERE o."productionRunId" = NEW."id"
           AND (o."organizationId" <> NEW."organizationId" OR l."organizationId" <> NEW."organizationId")
      ) cross_org;

    IF v_cross_org_count > 0 THEN
      RAISE EXCEPTION 'Cannot finalize ProductionRun (%): cross-organization input/output lot linkage detected', NEW."id";
    END IF;

    IF NEW."totalInputMassTenthGrams" <= 0 OR NEW."totalInputMassTenthGrams"::numeric <> v_sum_input_mass THEN
      RAISE EXCEPTION 'Cannot finalize ProductionRun (%): totalInputMassTenthGrams (%) disagrees with sum of ProductionRunInput rows (%)',
        NEW."id", NEW."totalInputMassTenthGrams", v_sum_input_mass;
    END IF;

    IF NEW."totalOutputMassTenthGrams"::numeric <> v_sum_output_mass THEN
      RAISE EXCEPTION 'Cannot finalize ProductionRun (%): totalOutputMassTenthGrams (%) disagrees with sum of ProductionRunOutput rows (%)',
        NEW."id", NEW."totalOutputMassTenthGrams", v_sum_output_mass;
    END IF;

    IF (
      NEW."totalOutputMassTenthGrams"::numeric
      + NEW."processLossMassTenthGrams"::numeric
      + NEW."destroyedByproductMassTenthGrams"::numeric
      + NEW."unaccountedVarianceTenthGrams"::numeric
    ) <> NEW."totalInputMassTenthGrams"::numeric THEN
      RAISE EXCEPTION 'Cannot finalize ProductionRun (%): RULE-CAN-001 tenth-gram mass-balance equation violated', NEW."id";
    END IF;

    -- Validate QAP sign-off identity against active same-organization QAP/CFO membership whenever supplied
    IF NEW."verifiedByQapUserId" IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
          FROM "shared"."OrganizationMembership" m
          INNER JOIN "shared"."User" u ON u."id" = m."userId"
          INNER JOIN "shared"."Organization" o ON o."id" = m."organizationId"
         WHERE m."organizationId" = NEW."organizationId"
           AND m."userId" = NEW."verifiedByQapUserId"
           AND m."role"::text IN ('CANNABIS_QAP_COMPLIANCE', 'ARCHITECT_CFO')
           AND m."isActive" = true
           AND u."isActive" = true
           AND o."isActive" = true
      ) INTO v_qap_member_valid;

      IF NOT v_qap_member_valid THEN
        RAISE EXCEPTION 'Cannot finalize ProductionRun (%): verifiedByQapUserId (%) does not hold an active same-organization CANNABIS_QAP_COMPLIANCE or ARCHITECT_CFO membership',
          NEW."id", NEW."verifiedByQapUserId";
      END IF;
    END IF;

    -- RULE-CAN-001 internal 2.0% QAP review gate (strict > 2.0% checked BEFORE rounding using exact numeric arithmetic)
    NEW."variancePercentage" := round(
      ((NEW."unaccountedVarianceTenthGrams"::numeric * 100) / NEW."totalInputMassTenthGrams"::numeric),
      3
    );

    IF (abs(NEW."unaccountedVarianceTenthGrams"::numeric) * 100) > (NEW."totalInputMassTenthGrams"::numeric * 2) THEN
      IF NEW."requiresQapVarianceReview" IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot finalize ProductionRun (%): |unaccountedVariance| > 2.0%% internal threshold requires requiresQapVarianceReview = true', NEW."id";
      END IF;

      SELECT COUNT(*)
        INTO v_unquarantined_outputs
        FROM "cannabis"."ProductionRunOutput" o
        INNER JOIN "cannabis"."CannabisLot" l
          ON l."organizationId" = o."organizationId" AND l."id" = o."outputLotId"
       WHERE o."organizationId" = NEW."organizationId"
         AND o."productionRunId" = NEW."id"
         AND l."complianceHold" = false;

      IF v_unquarantined_outputs > 0 AND (
        NEW."verifiedByQapUserId" IS NULL
        OR NEW."qapVarianceReasonNote" IS NULL
        OR length(trim(NEW."qapVarianceReasonNote")) < 10
      ) THEN
        RAISE EXCEPTION 'Cannot finalize ProductionRun (%): > 2.0%% internal variance requires output lots on complianceHold = true OR active same-org QAP sign-off (verifiedByQapUserId + qapVarianceReasonNote >= 10 chars)', NEW."id";
      END IF;
    END IF;

    NEW."completedAt" := COALESCE(NEW."completedAt", now());
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "cannabis"."enforce_production_run_lifecycle_and_finalization"() FROM PUBLIC;

CREATE TRIGGER enforce_production_run_lifecycle
  BEFORE INSERT OR UPDATE ON "cannabis"."ProductionRun"
  FOR EACH ROW EXECUTE FUNCTION "cannabis"."enforce_production_run_lifecycle_and_finalization"();

-- ============================================================================
-- 11. Explicit Least-Privilege Grants for erp_app_user Across All 28 Tables
--     (Revoke all from PUBLIC & erp_app_user first; no broad ALTER DEFAULT PRIVILEGES)
-- ============================================================================
REVOKE ALL ON ALL TABLES IN SCHEMA "shared", "salvage", "cannabis" FROM PUBLIC, erp_app_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "shared", "salvage", "cannabis" FROM PUBLIC, erp_app_user;

-- shared.* tables (9)
GRANT SELECT ON "shared"."User" TO erp_app_user;
GRANT UPDATE ("fullName", "phoneE164", "whatsappOptInAt", "whatsappWindowExp", "updatedAt") ON "shared"."User" TO erp_app_user;

GRANT SELECT ON "shared"."Organization" TO erp_app_user;
GRANT UPDATE ("policyConfigJson", "updatedAt") ON "shared"."Organization" TO erp_app_user;

GRANT SELECT, INSERT, UPDATE ON "shared"."OrganizationMembership" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "shared"."StorageLocation" TO erp_app_user;
GRANT SELECT, INSERT ON "shared"."CustodyEvent" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE ON "shared"."Expense" TO erp_app_user;
GRANT SELECT, INSERT ON "shared"."CashCustodyTransfer" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "shared"."OutboxEvent" TO erp_app_user;
GRANT SELECT, INSERT ON "shared"."AuditLog" TO erp_app_user;

-- salvage.* tables (12)
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."Vehicle" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."Part" TO erp_app_user;
GRANT SELECT, INSERT ON "salvage"."ScrapComponentLog" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."Shipment" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."ShipmentPallet" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."PreOrderWishList" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."B2BReservation" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE ON "salvage"."SaleTransaction" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."SaleTransactionPartItem" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."SaleTransactionVehicleItem" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."CycleCountTask" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "salvage"."CurrencySettlement" TO erp_app_user;

-- cannabis.* tables (7)
GRANT SELECT, INSERT, UPDATE, DELETE ON "cannabis"."CannabisStrain" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cannabis"."CannabisLot" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE ON "cannabis"."ProductionRun" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cannabis"."ProductionRunInput" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cannabis"."ProductionRunOutput" TO erp_app_user;
GRANT SELECT, INSERT ON "cannabis"."CannabisDestructionLog" TO erp_app_user;
GRANT SELECT, INSERT ON "cannabis"."CanonicalInventoryEvent" TO erp_app_user;

-- ============================================================================
-- 12. Fail-Closed Multi-Tenant & Global Identity Row-Level Security
--     (ENABLE + FORCE ROW LEVEL SECURITY across all 28 tables; zero auth.jwt())
-- ============================================================================
ALTER TABLE "shared"."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."User" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."Organization" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."OrganizationMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."OrganizationMembership" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."StorageLocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."StorageLocation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."Expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."Expense" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."CashCustodyTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."CashCustodyTransfer" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."CustodyEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."CustodyEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."OutboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."OutboxEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "shared"."AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."AuditLog" FORCE ROW LEVEL SECURITY;

ALTER TABLE "salvage"."Vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."Vehicle" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."Part" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."Part" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."ScrapComponentLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."ScrapComponentLog" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."Shipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."Shipment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."ShipmentPallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."ShipmentPallet" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."PreOrderWishList" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."PreOrderWishList" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."B2BReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."B2BReservation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."SaleTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."SaleTransaction" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."SaleTransactionPartItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."SaleTransactionPartItem" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."SaleTransactionVehicleItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."SaleTransactionVehicleItem" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."CycleCountTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."CycleCountTask" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."CurrencySettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salvage"."CurrencySettlement" FORCE ROW LEVEL SECURITY;

ALTER TABLE "cannabis"."CannabisStrain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisStrain" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisLot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisLot" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."ProductionRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."ProductionRun" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."ProductionRunInput" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."ProductionRunInput" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."ProductionRunOutput" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."ProductionRunOutput" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisDestructionLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisDestructionLog" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CanonicalInventoryEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CanonicalInventoryEvent" FORCE ROW LEVEL SECURITY;

-- Identity firewall on shared.User (FIX 02)
CREATE POLICY user_select_self_or_org_comember ON "shared"."User"
  FOR SELECT USING (
    "id" = "shared"."current_user_id"()
    OR "shared"."is_user_in_current_org"("id")
  );
CREATE POLICY user_update_self_profile ON "shared"."User"
  FOR UPDATE
  USING ("id" = "shared"."current_user_id"())
  WITH CHECK ("id" = "shared"."current_user_id"());

-- Organization policies: active tenant read, CFO-only policyConfigJson update, and non-recursive login bootstrap discovery
CREATE POLICY tenant_select_organization ON "shared"."Organization"
  FOR SELECT USING ("id" = "shared"."current_org_id"());
CREATE POLICY tenant_update_organization_cfo ON "shared"."Organization"
  FOR UPDATE
  USING ("id" = "shared"."current_org_id"() AND "shared"."current_role"() = 'ARCHITECT_CFO')
  WITH CHECK ("id" = "shared"."current_org_id"() AND "shared"."current_role"() = 'ARCHITECT_CFO');
CREATE POLICY auth_bootstrap_select_organization ON "shared"."Organization"
  FOR SELECT USING ("shared"."can_bootstrap_select_org"("id"));

-- OrganizationMembership policies: active tenant read, CFO-only activation/revocation/grant management, and active-only login bootstrap
CREATE POLICY tenant_select_org_membership ON "shared"."OrganizationMembership"
  FOR SELECT USING ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_insert_org_membership_cfo ON "shared"."OrganizationMembership"
  FOR INSERT WITH CHECK (
    "organizationId" = "shared"."current_org_id"()
    AND "shared"."current_role"() = 'ARCHITECT_CFO'
  );
CREATE POLICY tenant_update_org_membership_cfo ON "shared"."OrganizationMembership"
  FOR UPDATE
  USING (
    "organizationId" = "shared"."current_org_id"()
    AND "shared"."current_role"() = 'ARCHITECT_CFO'
  )
  WITH CHECK (
    "organizationId" = "shared"."current_org_id"()
    AND "shared"."current_role"() = 'ARCHITECT_CFO'
  );
CREATE POLICY auth_bootstrap_select_membership ON "shared"."OrganizationMembership"
  FOR SELECT USING (
    "shared"."current_org_id"() IS NULL
    AND "shared"."current_user_id"() IS NOT NULL
    AND "userId" = "shared"."current_user_id"()
    AND "isActive" = true
  );

-- Remaining shared.* tenant isolation policies
CREATE POLICY tenant_isolation_storage_location ON "shared"."StorageLocation"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_expense ON "shared"."Expense"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_cash_transfer ON "shared"."CashCustodyTransfer"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_custody_event ON "shared"."CustodyEvent"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_outbox_event ON "shared"."OutboxEvent"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_audit_log ON "shared"."AuditLog"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());

-- salvage.* tenant isolation policies
CREATE POLICY tenant_isolation_vehicle ON "salvage"."Vehicle"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_part ON "salvage"."Part"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_scrap_component_log ON "salvage"."ScrapComponentLog"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_shipment ON "salvage"."Shipment"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_shipment_pallet ON "salvage"."ShipmentPallet"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_wish_list ON "salvage"."PreOrderWishList"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_b2b_reservation ON "salvage"."B2BReservation"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_sale_transaction ON "salvage"."SaleTransaction"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_sale_part_item ON "salvage"."SaleTransactionPartItem"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_sale_vehicle_item ON "salvage"."SaleTransactionVehicleItem"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_cycle_count ON "salvage"."CycleCountTask"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_currency_settlement ON "salvage"."CurrencySettlement"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());

-- cannabis.* tenant isolation policies
CREATE POLICY tenant_isolation_cannabis_strain ON "cannabis"."CannabisStrain"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_cannabis_lot ON "cannabis"."CannabisLot"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_production_run ON "cannabis"."ProductionRun"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_production_run_input ON "cannabis"."ProductionRunInput"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_production_run_output ON "cannabis"."ProductionRunOutput"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_cannabis_destruction ON "cannabis"."CannabisDestructionLog"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY tenant_isolation_canonical_inventory_event ON "cannabis"."CanonicalInventoryEvent"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
