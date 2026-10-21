# ARCHITECTURE.md — Cross-Border Salvage, Rebuild & Vault ERP

## 1. System Overview & Architectural Principles

This platform is a **Domain-Driven Design (DDD) Modular Monolith** adhering to **Hexagonal Architecture (Ports & Adapters)**. It serves as the authoritative **Chain of Custody, Inventory State, and Operational Subledger** across four operational nodes:

1. **Node 1 (Kemptville Yard):** Offline-first vehicle/watercraft dismantling, QR tagging, and container bin storage.
2. **Node 2 (Ramsayville Shop):** Vehicle repair, rebuild dossier tracking, and domestic retail preparation.
3. **Node 3 (Export Consolidation & Transit):** LCL pallet / FCL container manifesting and customs broker data output.
4. **Node 4 (Trinidad Vault):** Landed check-in, B2B reservation holds, strict Cash-on-Delivery (COD) checkout, and FX batch settlement.

### Core Architectural Invariants

1. **PostgreSQL is the Single Source of Inventory Truth:** External marketplaces (eBay) and messaging channels (WhatsApp) are asynchronous projections. External HTTP calls NEVER execute inside a PostgreSQL database transaction.
2. **Transactional Outbox Pattern:** All cross-module side effects and external API calls are persisted as `OutboxEvent` records within the same ACID transaction as the domain state mutation and processed asynchronously by BullMQ workers.
3. **Strict Storage Segregation (Public vs. Private R2):** Publicly accessible commerce images and private financial/compliance records are physically segregated into separate Cloudflare R2 buckets with distinct access policies.
4. **Operational Subledger, External General Ledger:** This system tracks unit-level (VIN/HIN/SKU) cost basis and profitability. Statutory double-entry accounting is delegated to an external General Ledger (QuickBooks Online / Xero) via an outbound sync adapter.

---

## 2. Technical Stack Specification

* **Runtime & Application Framework:** Next.js 15+ (App Router), React 19, Node.js v22 LTS, TypeScript 5.x (`strict: true`).
* **Mobile Offline Client (PWA):** Workbox Service Workers, IndexedDB (`Dexie.js`) for offline mutation queues and binary image blobs, `@zxing/browser` + native `BarcodeDetector` API.
* **Database & ORM:** PostgreSQL 16+ (Supabase) with Row-Level Security (RLS), connection pooling, and Prisma ORM.
* **Queue & Background Workers:** BullMQ backed by Redis 7.x (running in standalone Node.js worker process).
* **Object Storage:** Cloudflare R2:
  * `R2_PUBLIC_MEDIA_BUCKET`: Sanitized, EXIF-stripped WebP product photos for eBay/WhatsApp/Storefront.
  * `R2_PRIVATE_EVIDENCE_BUCKET`: Zero-public-access bucket (accessed strictly via short-lived, audit-logged pre-signed URLs) for expense receipts, bank wire slips, customs docs, and vehicle titles.

---

## 3. Repository Directory Structure

```text
src/
├── core/
│   ├── ports/                     # Hexagonal Port Interfaces (Zero external deps)
│   ├── events/                    # Domain Event contracts & Outbox publisher
│   └── config/                    # Versioned regulatory, tariff & FX parameters
├── modules/
│   ├── dismantling/               # Context 1: Asset intake, stripping, bin custody
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── marketplace/               # Context 2: eBay sync, B2B storefront, WhatsApp
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── logistics-vault/           # Context 3: Pallets, manifests, Trinidad COD Vault
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   └── cfo-subledger/             # Context 4: Capital gate, expenses, FX, GL sync
│       ├── domain/
│       ├── application/
│       └── infrastructure/
├── infrastructure/
│   ├── db/                        # Prisma client, migrations, RLS helpers
│   ├── adapters/                  # Concrete implementations of core/ports
│   └── workers/                   # BullMQ worker entrypoints
└── app/                           # Next.js App Router (UI, Server Actions, Webhooks)
```

## 4. Production Database Schema (`schema.prisma`)

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum UserRole {
  ARCHITECT_CFO
  HUNTER_MECHANIC
  ONTARIO_STRIPPER
  TRINIDAD_VAULT_ADMIN
  OVERSEAS_B2B_BUYER
}

enum AssetCategory {
  AUTOMOBILE
  WATERCRAFT      // Sea-Doo, Yamaha JetBoat/WaveRunner (Bypasses MTO DriveON)
  SHOP_EQUIPMENT  // A/C Recharge Machines, Lifts, Tools
}

enum RoadVehicleBrand {
  NONE
  SALVAGE
  REBUILT
  IRREPARABLE
  NOT_APPLICABLE  // Mandatory default for WATERCRAFT and SHOP_EQUIPMENT
}

enum OperationalLane {
  QUICK_TURN_BEATER
  HIGH_END_REBUILD
  DISMANTLE_AND_EXPORT
  WHOLE_UNIT_EXPORT
}

enum SteeringSideCompatibility {
  UNIVERSAL       // Steering-side geometry neutral (does not bypass OEM part-number fitment verification)
  LHD_ONLY        // North American steering racks, dash, LHD headlamps, master switches
  RHD_ONLY        // RHD-specific steering/interior components
}

enum AssetLifecycleState {
  PROPOSED_DEAL
  ACQUIRED_IN_TRANSIT
  STAGED_ONTARIO_YARD
  IN_RAMSAYVILLE_SHOP
  PENDING_INSPECTION_CERT   // Road vehicles only (DriveON SIC / SSC)
  READY_FOR_RETAIL_SALE
  SOLD_RETAIL_ONTARIO
  DISMANTLING_IN_PROGRESS
  HULK_AWAITING_SCRAP
  SCRAPPED_METAL_CLEARED    // Terminal state for stripped shells (requires weigh ticket)
  MANIFESTED_WHOLE_EXPORT
  LANDED_TRINIDAD_VAULT
  SOLD_EXPORT_COD
}

enum PartCustodyState {
  STRIPPED_RAW_OFFLINE
  SHELVED_ONTARIO_CONTAINER
  ON_EXPORT_PALLET
  IN_TRANSIT_OCEAN_FREIGHT
  CUSTOMS_HOLD_DESTINATION
  SHELVED_TRINIDAD_VAULT
  SOLD_AND_RELEASED
  SCRAPPED_OR_DAMAGED
}

enum InventoryAvailabilityState {
  AVAILABLE
  RESERVED_B2B_HOLD
  COMMITTED_DOMESTIC_SALE
  PENDING_VAULT_COD_PAYMENT
  PAID_SETTLED
}

enum EbaySyncState {
  NOT_LISTED
  SYNDICATED_LIVE
  EXPORT_LOCK_PENDING       // Waiting for automated eBay API 200 OK (Phase 3) or manual delist check (Phase 1)
  EXPORT_LOCK_CONFIRMED     // Verified zero quantity on eBay; safe to seal pallet
}

enum PartComplianceState {
  PENDING_ENRICHMENT
  NEEDS_HUMAN_REVIEW
  CLEARED_FOR_SALE
  QUARANTINED_RECALL_OR_DG
}

enum AraConditionGradeEnum {
  GRADE_A
  GRADE_B1
  GRADE_B2
  GRADE_B3
  GRADE_C
  GRADE_X
}

enum CurrencyCode {
  CAD
  USD
  TTD
}

enum ExpenseCategory {
  AUCTION_PURCHASE_PRICE
  AUCTION_BUYER_FEE
  TOWING_AND_RECOVERY
  RAMSAYVILLE_SHOP_LABOR
  AFTERMARKET_REPAIR_PARTS
  OEM_REBUILD_PARTS
  MTO_INSPECTION_FEE
  REFRIGERANT_EVAC_AND_PREP
  STEAM_CLEANING_EXPORT_PREP
  OCEAN_FREIGHT_LCL_FCL
  CUSTOMS_BROKERAGE_FEE
  DESTINATION_DUTY_AND_VAT
  PORT_DRAYAGE
  PACKAGING_AND_LABELS
}

enum AccountingSyncStatus {
  PENDING_SYNC
  SYNCED_TO_GL
  SYNC_FAILED
}

enum SaleMarketNode {
  ONTARIO_DOMESTIC    // Kemptville Yard / Ramsayville Shop / Ottawa Meetup
  TRINIDAD_VAULT      // Port of Spain Family Warehouse
}

// Explicitly tracks how domestic CAD parts and Ramsayville cars are sold
enum DomesticSaleChannel {
  OTTAWA_WALK_IN_CASH         // Mechanic or buyer walking into Ramsayville/Kemptville
  FB_MARKETPLACE_LOCAL        // Local pickup via Facebook Marketplace listing
  KIJIJI_LOCAL                // Local pickup via Kijiji ad
  RAMSAYVILLE_LOT_RETAIL      // Whole beater / rebuilt salvage car sold off the 8-car lot
  WHOLESALE_MECHANIC_NETWORK  // Direct B2B sale to local Ottawa/Gatineau repair shop
  EBAY_MOTORS_SHIPPED         // Shipped domestic/US order (~13.25% platform fee + label)
  CAR_PART_WHOLESALE          // North American salvage exchange order
}

enum ExportSaleChannel {
  TRINIDAD_VAULT_COD          // Standard Port of Spain Family Vault cash/wire release
  TRINIDAD_PRE_ORDER_PICKUP   // Pre-sold via Mechanic Wish List / "Loading Now" tab
  BARBADOS_B2B_WHOLESALE      // Secondary island wholesale lane
}

enum CashCustodyState {
  HELD_BY_TAZ_FLOAT           // Cash in Taz's hands / Ramsayville shop Petty Cash (Ontario)
  HELD_IN_TRINIDAD_VAULT      // Cash in Family Vault safe awaiting TT bank deposit
  DEPOSITED_TRINIDAD_BANK     // In TT commercial bank awaiting FX conversion batch
  SETTLED_CANADA_BANK         // Interac e-Transfer / Wire / eBay Payout in Canadian Corp Account
}

model User {
  id                String    @id @default(uuid()) @db.Uuid
  email             String    @unique
  phoneE164         String?   @unique
  fullName          String
  role              UserRole
  mfaEnrolled       Boolean   @default(false) // Required true for CFO and VAULT_ADMIN
  commissionRateBps Int       @default(0)     // e.g., 500 = 5.00%, 1000 = 10.00%
  whatsappOptInAt   DateTime?
  whatsappWindowExp DateTime?
  isActive          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  strippedParts     Part[]              @relation("StrippedByUser")
  custodyEvents     CustodyEvent[]
  loggedExpenses    Expense[]           @relation("LoggedByUser")
  salesExecuted     SaleTransaction[]   @relation("SoldByUser")
  brokeredSales     SaleTransaction[]   @relation("BrokerUser")
  verifiedSales     SaleTransaction[]   @relation("VerifiedByAdmin")
  wishLists         PreOrderWishList[]
  auditLogs         AuditLog[]
}

model StorageLocation {
  id            String    @id @default(uuid()) @db.Uuid
  siteCode      String    // "KEMP", "RAMS", "POSV"
  containerCode String    // "C01".."C04" or "V01"
  rackCode      String    // "R01".."R10"
  shelfCode     String    // "S01".."S05"
  binCode       String    // "B01".."B20"
  fullQrBarcode String    @unique // e.g., "KEMP-C01-R02-S03-B04"
  maxWeightKg   Decimal   @default(150.0) @db.Decimal(6, 2)
  createdAt     DateTime  @default(now())

  parts         Part[]
  vehicles      Vehicle[]

  @@index([siteCode, containerCode])
}

model Vehicle {
  id                          String                     @id @default(uuid()) @db.Uuid
  internalStockNumber         String                     @unique // e.g., "AST-2026-0001"
  assetCategory               AssetCategory              @default(AUTOMOBILE)
  vinOrHin                    String                     @unique // 17-char VIN, 12-char HIN, or Serial#
  year                        Int
  make                        String
  model                       String
  trim                        String?
  engineSpec                  String?
  odometerKm                  Int?                       // Hours or Km for watercraft
  exteriorColor               String?
  steeringSide                SteeringSideCompatibility  @default(LHD_ONLY)
  roadBrand                   RoadVehicleBrand           @default(NONE)
  operationalLane             OperationalLane
  lifecycleState              AssetLifecycleState        @default(PROPOSED_DEAL)
  availabilityState           InventoryAvailabilityState @default(AVAILABLE)
  storageLocationId           String?                    @db.Uuid
  storageLocation             StorageLocation?           @relation(fields: [storageLocationId], references: [id])

  // Capital Gate & CFO Deal Analyzer Baseline (CAD Cents)
  estimatedMaxBidCadMinor     Int
  actualPurchasePriceCadMinor Int                        @default(0)
  estimatedRepairCadMinor     Int                        @default(0)
  targetGrossRealizationMinor Int                        @default(0)
  cfoGateApprovedById         String?                    @db.Uuid
  cfoGateApprovedAt           DateTime?

  // Whole-Unit Export Valuation & Trinidad Vault Pricing (Minor Units / Cents)
  wholesaleFobUsdMinor        Int?
  landedCostTtdMinor          Int?
  vaultFloorPriceTtdMinor     Int?

  // Compliance & Inspection Dossier (Keys pointing to R2_PRIVATE_EVIDENCE_BUCKET)
  rebuildDossierJson          Json?                      // Flexible schema for Reg. 601 photos, frame bench, estimate
  driveOnSicNumber            String?
  driveOnSicPassedAt          DateTime?
  driveOnSscNumber            String?
  driveOnSscIssuedAt          DateTime?
  driveOnSscExpiresAt         DateTime?                  // driveOnSscIssuedAt + 36 calendar days (AUTOMOBILE only)
  uvipStorageKey              String?

  // Environmental & Yard Clearance Evidence (R2_PRIVATE_EVIDENCE_BUCKET keys)
  refrigerantEvacCertKey      String?                    // Certified technician recovery record
  fluidsDrainedAt             DateTime?
  steamCleanedReceiptKey      String?
  scrapMetalTicketKey         String?                    // Weigh-scale ticket required for SCRAPPED_METAL_CLEARED
  scrappedClearedAt           DateTime?

  realizedRetailSaleCadMinor  Int?
  soldAt                      DateTime?
  version                     Int                        @default(1)
  createdAt                   DateTime                   @default(now())
  updatedAt                   DateTime                   @updatedAt

  parts                       Part[]
  expenses                    Expense[]
  custodyHistory              CustodyEvent[]
  b2bReservations             B2BReservation[]
  shipmentId                  String?                    @db.Uuid
  shipment                    Shipment?                  @relation(fields: [shipmentId], references: [id])
  saleTransactionItem         SaleTransactionVehicleItem?

  @@index([lifecycleState, operationalLane])
  @@index([availabilityState])
  @@index([storageLocationId])
  @@index([make, model, year])
}

model Part {
  id                         String                     @id @default(uuid()) @db.Uuid
  qrSkuCode                  String                     @unique // e.g., "PRT-884920"
  donorVehicleId             String                     @db.Uuid
  donorVehicle               Vehicle                    @relation(fields: [donorVehicleId], references: [id])
  strippedByUserId           String                     @db.Uuid
  strippedByUser             User                       @relation("StrippedByUser", fields: [strippedByUserId], references: [id])

  // Orthogonal State Axes
  custodyState               PartCustodyState           @default(STRIPPED_RAW_OFFLINE)
  availabilityState          InventoryAvailabilityState @default(AVAILABLE)
  ebaySyncState              EbaySyncState              @default(NOT_LISTED)
  complianceState            PartComplianceState        @default(PENDING_ENRICHMENT)

  partCategoryName           String                     @default("UNCLASSIFIED")
  steeringSideCompatibility  SteeringSideCompatibility  @default(UNIVERSAL)
  isHazmatOrAirbag           Boolean                    @default(false) // Triggers UN3268 DG / recall check
  oemPartNumbers             String[]
  interchangePartNumbers     String[]
  suggestedHsCode            String                     @default("8708.99")
  brokerVerifiedHsCode       String?                    // Authoritative HS code confirmed by customs broker

  // Grading & Physical Specs
  araGrade                   AraConditionGradeEnum      @default(GRADE_X)
  araDamageCode              String                     @default("000")
  conditionNotes             String?
  aiConfidenceScore          Decimal?                   @db.Decimal(4, 3)
  humanVerifiedAt            DateTime?
  weightKg                   Decimal                    @default(2.50) @db.Decimal(6, 2)
  dimensionsCm               Json?

  // Public Media Assets (R2_PUBLIC_MEDIA_BUCKET URLs — EXIF stripped)
  rawPhotoUrls               String[]
  cleanPhotoUrls             String[]

  // Current Location & Logistics Pointers
  storageLocationId          String?                    @db.Uuid
  storageLocation            StorageLocation?           @relation(fields: [storageLocationId], references: [id])
  shipmentPalletId           String?                    @db.Uuid
  shipmentPallet             ShipmentPallet?            @relation(fields: [shipmentPalletId], references: [id])

  // Pricing & Valuation (Stored in Minor Units / Cents)
  allocatedCostBasisCadMinor Int                        @default(0)
  compBaselineCadMinor       Int?
  retailPriceCadMinor        Int?
  wholesaleFobUsdMinor       Int?
  landedCostTtdMinor         Int?
  vaultFloorPriceTtdMinor    Int?

  // External Marketplace Pointers & Optimistic Concurrency
  ebayOfferId                String?                    @unique
  ebayListingId              String?                    @unique
  ebayTitle                  String?                    @db.VarChar(80)
  ebayAspectsJson            Json?
  ebayCompatibilityJson      Json?
  version                    Int                        @default(1) // Authoritative concurrency counter

  strippedAt                 DateTime                   @default(now())
  updatedAt                  DateTime                   @updatedAt

  custodyHistory             CustodyEvent[]
  b2bReservations            B2BReservation[]
  saleTransactionItem        SaleTransactionPartItem?

  @@index([custodyState, availabilityState])
  @@index([ebaySyncState])
  @@index([complianceState])
  @@index([donorVehicleId])
  @@index([storageLocationId])
  @@index([steeringSideCompatibility])
}

// Append-only custody chain for both stripped Parts and whole Vehicles/Watercraft
model CustodyEvent {
  id                  String   @id @default(uuid()) @db.Uuid
  partId              String?  @db.Uuid
  part                Part?    @relation(fields: [partId], references: [id])
  vehicleId           String?  @db.Uuid
  vehicle             Vehicle? @relation(fields: [vehicleId], references: [id])
  actorUserId         String   @db.Uuid
  actorUser           User     @relation(fields: [actorUserId], references: [id])
  idempotencyKey      String   @unique // Client UUIDv7 generated at scan time
  fromLocationBarcode String?
  toLocationBarcode   String   // Bin QR, Pallet QR, or Vault Shelf QR
  expectedVersion     Int
  hasConflict         Boolean  @default(false) // Flagged true if offline scan version mismatches server
  deviceTimestamp     DateTime
  serverReceivedAt    DateTime @default(now())

  @@index([partId, serverReceivedAt])
  @@index([vehicleId, serverReceivedAt])
}

model Shipment {
  id                        String           @id @default(uuid()) @db.Uuid
  shipmentCode              String           @unique // e.g., "EXP-2026-TT-001"
  mode                      String           // "LCL_PALLET", "FCL_20FT", "FCL_40FT_HC"
  originPort                String           @default("CA_MTR")
  destinationPort           String           @default("TT_POS")
  customsBrokerName         String?
  importerOfRecordName      String?
  importerTaxId             String?          // Trinidad BIR / VAT Registration Number

  // CBSA CERS Export Reporting (6-year Canadian Archive Requirement)
  exporterBn15              String
  cersProofOfReportNumber   String?          @unique
  vesselLoadingCutoffAt     DateTime?
  cersSubmittedAt           DateTime?
  cersArchiveStorageKey     String?          // Canadian-resident storage key

  // Customs Valuation Summary (Minor Units)
  declaredFobTotalUsdMinor  Int              @default(0)
  oceanFreightUsdMinor      Int              @default(0)
  marineInsuranceUsdMinor   Int              @default(0)
  cifTotalUsdMinor          Int              @default(0)
  assessedDutyTtdMinor      Int              @default(0)
  assessedVatTtdMinor       Int              @default(0)

  departedAt                DateTime?
  arrivedPortAt             DateTime?
  clearedCustomsAt          DateTime?
  createdAt                 DateTime         @default(now())

  pallets                   ShipmentPallet[]
  wholeAssets               Vehicle[]
  expenses                  Expense[]
}

model ShipmentPallet {
  id              String    @id @default(uuid()) @db.Uuid
  shipmentId      String    @db.Uuid
  shipment        Shipment  @relation(fields: [shipmentId], references: [id])
  palletQrCode    String    @unique // e.g., "PLT-2026-001"
  tareWeightKg    Decimal   @default(22.0) @db.Decimal(6, 2)
  grossWeightKg   Decimal   @db.Decimal(8, 2)
  dimensionsCm    Json
  sealedAt        DateTime? // Blocked until all child Parts are in EXPORT_LOCK_CONFIRMED or non-syndicated

  parts           Part[]
}

model Expense {
  id                    String               @id @default(uuid()) @db.Uuid
  vehicleId             String?              @db.Uuid
  vehicle               Vehicle?             @relation(fields: [vehicleId], references: [id])
  shipmentId            String?              @db.Uuid
  shipment              Shipment?            @relation(fields: [shipmentId], references: [id])
  loggedByUserId        String               @db.Uuid
  loggedByUser          User                 @relation("LoggedByUser", fields: [loggedByUserId], references: [id])

  category              ExpenseCategory
  vendorName            String
  description           String
  amountOriginalMinor   Int
  currencyOriginal      CurrencyCode         @default(CAD)
  amountCadMinor        Int
  paidFromCashCustody   CashCustodyState?    // Allows deducting shop expenses directly from HELD_BY_TAZ_FLOAT
  isReversalEntry       Boolean              @default(false)
  reversesExpenseId     String?              @db.Uuid

  // Private Evidence (Stored in R2_PRIVATE_EVIDENCE_BUCKET)
  receiptStorageKey     String               // Non-empty DB CHECK constraint enforced in migration
  receiptSha256Hash     String
  receiptOcrJson        Json?

  // External Accounting Subledger Sync
  accountingSyncStatus  AccountingSyncStatus @default(PENDING_SYNC)
  externalGlJournalId   String?

  incurredAt            DateTime
  createdAt             DateTime             @default(now())

  @@index([vehicleId])
  @@index([shipmentId])
}

model PreOrderWishList {
  id                     String                    @id @default(uuid()) @db.Uuid
  requesterUserId        String                    @db.Uuid
  requesterUser          User                      @relation(fields: [requesterUserId], references: [id])
  targetYearStart        Int
  targetYearEnd          Int
  targetMake             String
  targetModel            String
  requiredSteeringSide   SteeringSideCompatibility @default(RHD_ONLY)
  partDescription        String
  oemPartNumberHint      String?
  maxBidWillingTtdMinor  Int
  isFulfilled            Boolean                   @default(false)
  matchedPartId          String?                   @db.Uuid
  createdAt              DateTime                  @default(now())

  @@index([targetMake, targetModel, isFulfilled])
}

model B2BReservation {
  id              String   @id @default(uuid()) @db.Uuid
  partId          String?  @db.Uuid
  part            Part?    @relation(fields: [partId], references: [id])
  vehicleId       String?  @db.Uuid
  vehicle         Vehicle? @relation(fields: [vehicleId], references: [id])
  buyerPhoneE164  String
  brokerUserId    String?  @db.Uuid
  quotedTtdMinor  Int
  expiresAt       DateTime
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())

  @@index([partId, isActive])
  @@index([vehicleId, isActive])
}

model SaleTransaction {
  id                      String               @id @default(uuid()) @db.Uuid
  receiptNumber           String               @unique // "ONT-2026-0041" or "POS-2026-0089"
  marketNode              SaleMarketNode

  // Channel Attribution (Mutually exclusive via DB CHECK constraint)
  domesticChannel         DomesticSaleChannel? // Populated when marketNode == ONTARIO_DOMESTIC
  exportChannel           ExportSaleChannel?   // Populated when marketNode == TRINIDAD_VAULT

  taxInvoiceNumber        String?              @unique
  buyerName               String
  buyerPhoneE164          String?
  buyerNationalIdHash     String?              // Required if Trinidad sale >= TT$50,000 (FIU CDD)

  // Actors & Separation of Duties
  soldByUserId            String               @db.Uuid
  soldByUser              User                 @relation("SoldByUser", fields: [soldByUserId], references: [id])
  brokerUserId            String?              @db.Uuid
  brokerUser              User?                @relation("BrokerUser", fields: [brokerUserId], references: [id])
  verifiedByAdminId       String               @db.Uuid // In Trinidad, MUST be TRINIDAD_VAULT_ADMIN or CFO
  verifiedByAdmin         User                 @relation("VerifiedByAdmin", fields: [verifiedByAdminId], references: [id])

  // Financial Totals (Minor Units / Cents)
  paymentCurrency         CurrencyCode         // CAD (Ontario) or TTD/USD (Trinidad)
  subtotalMinor           Int
  platformFeeMinor        Int                  @default(0) // $0 for FB/Walk-In; ~13.25% for EBAY_MOTORS_SHIPPED
  shippingCostMinor       Int                  @default(0) // $0 for Local Pickup; Courier label cost for eBay
  taxOrVatMinor           Int                  @default(0)
  grossCollectedMinor     Int
  netRealizedCadMinor     Int                  // (gross - platformFee - shipping) in CAD for VIN Break-Even math
  paymentMethod           String               // "CASH", "INTERAC_ETRANSFER", "VERIFIED_BANK_WIRE", "EBAY_MANAGED_PAYOUT"
  cashCustodyState        CashCustodyState

  // Private Evidence (Stored in R2_PRIVATE_EVIDENCE_BUCKET)
  paymentProofStorageKey  String               // Photo of cash, e-Transfer screenshot, or wire slip (Mandatory)
  billOfSaleStorageKey    String?              // Mandatory when domesticChannel == RAMSAYVILLE_LOT_RETAIL
  ttdCommercialBankName   String?

  // Broker Commission (Trinidad / Overseas B2B only)
  brokerCommissionBps     Int                  @default(0)
  brokerCommissionMinor   Int                  @default(0)
  brokerCommissionPaidAt  DateTime?

  // Gate Release Lock (Required for TRINIDAD_VAULT, auto-released for ONTARIO_DOMESTIC)
  isPaymentVerified       Boolean              @default(false)
  gateTokenNonce          String?              @unique
  gateTokenExpiresAt      DateTime?
  gateReleasedAt          DateTime?

  // Accounting & FX Settlement Links
  accountingSyncStatus    AccountingSyncStatus @default(PENDING_SYNC)
  externalGlJournalId     String?
  settlementBatchId       String?              @db.Uuid
  settlementBatch         CurrencySettlement?  @relation(fields: [settlementBatchId], references: [id])
  createdAt               DateTime             @default(now())

  partItems               SaleTransactionPartItem[]
  vehicleItems            SaleTransactionVehicleItem[]

  @@index([marketNode, domesticChannel])
  @@index([marketNode, exportChannel])
  @@index([cashCustodyState])
}

model SaleTransactionPartItem {
  id                String          @id @default(uuid()) @db.Uuid
  saleTransactionId String          @db.Uuid
  saleTransaction   SaleTransaction @relation(fields: [saleTransactionId], references: [id])
  partId            String          @unique @db.Uuid
  part              Part            @relation(fields: [partId], references: [id])
  soldPriceMinor    Int
}

model SaleTransactionVehicleItem {
  id                String          @id @default(uuid()) @db.Uuid
  saleTransactionId String          @db.Uuid
  saleTransaction   SaleTransaction @relation(fields: [saleTransactionId], references: [id])
  vehicleId         String          @unique @db.Uuid
  vehicle           Vehicle         @relation(fields: [vehicleId], references: [id])
  soldPriceMinor    Int
}

model CurrencySettlement {
  id                         String               @id @default(uuid()) @db.Uuid
  batchCode                  String               @unique
  sourceCurrency             CurrencyCode         @default(TTD)
  targetCurrency             CurrencyCode         @default(CAD)
  totalSourceAmountMinor     BigInt
  totalTargetSettledMinor    BigInt
  officialCbttRate           Decimal              @db.Decimal(10, 6)
  effectiveClearingRate      Decimal              @db.Decimal(10, 6)
  fxSlippageLossCadMinor     Int                  @default(0)
  conversionChannel          String               // "COMMERCIAL_BANK_QUEUE", "AUTHORIZED_FX_DEALER"
  wireProofStorageKey        String               // Private R2 key
  accountingSyncStatus       AccountingSyncStatus @default(PENDING_SYNC)
  externalGlJournalId        String?
  initiatedAt                DateTime             @default(now())
  settledInCanadaAt          DateTime?

  saleTransactions           SaleTransaction[]
}

// Transactional Outbox for reliable asynchronous processing via BullMQ
model OutboxEvent {
  id            String    @id @default(uuid()) @db.Uuid
  aggregateType String    // "Part", "Vehicle", "Shipment", "SaleTransaction"
  aggregateId   String    @db.Uuid
  eventType     String    // e.g., "PartExportLockRequested", "VaultCodVerified"
  payloadJson   Json
  idempotencyKey String   @unique
  status        String    @default("PENDING") // "PENDING", "PROCESSING", "COMPLETED", "DEAD_LETTER"
  retryCount    Int       @default(0)
  lastError     String?
  createdAt     DateTime  @default(now())
  processedAt   DateTime?

  @@index([status, createdAt])
}

model AuditLog {
  id            String   @id @default(uuid()) @db.Uuid
  actorUserId   String   @db.Uuid
  actorUser     User     @relation(fields: [actorUserId], references: [id])
  entityType    String
  entityId      String
  action        String
  previousState Json?
  nextState     Json?
  ipAddress     String?
  createdAt     DateTime @default(now())

  @@index([entityType, entityId])
}
```

### Mandatory Raw SQL Constraints (Applied in Prisma Migration)

Prisma does not natively express `CHECK` constraints or immutable triggers. The initial migration MUST include:

```sql
-- 1. Enforce non-empty private receipt key on Expense
ALTER TABLE "Expense" ADD CONSTRAINT expense_receipt_non_empty CHECK (length(trim("receiptStorageKey")) > 0);

-- 2. Enforce Commission Holdback Invariant at DB level
ALTER TABLE "SaleTransaction" ADD CONSTRAINT commission_requires_verified_payment
  CHECK ("brokerCommissionPaidAt" IS NULL OR "isPaymentVerified" = true);

-- 3. Enforce Watercraft/Equipment bypass of RoadVehicleBrand
ALTER TABLE "Vehicle" ADD CONSTRAINT non_auto_brand_check
  CHECK ("assetCategory" = 'AUTOMOBILE' OR "roadBrand" = 'NOT_APPLICABLE');

-- 4. Block DELETE and destructive UPDATE on financial & audit tables
CREATE OR REPLACE FUNCTION prevent_audit_tampering() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Tampering prohibited on immutable financial/audit table: %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_audit_log BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_expense_delete BEFORE DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_sale_tx_delete BEFORE DELETE ON "SaleTransaction" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();

-- 4b. Block mutation of immutable financial columns on Expense & SaleTransaction while permitting workflow updates
CREATE OR REPLACE FUNCTION prevent_expense_financial_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."amountOriginalMinor" IS DISTINCT FROM OLD."amountOriginalMinor"
     OR NEW."amountCadMinor" IS DISTINCT FROM OLD."amountCadMinor"
     OR NEW."receiptStorageKey" IS DISTINCT FROM OLD."receiptStorageKey" THEN
    RAISE EXCEPTION 'Immutable financial columns on Expense cannot be modified after creation; log a reversal entry instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_expense_immutable_cols BEFORE UPDATE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION prevent_expense_financial_mutation();

CREATE OR REPLACE FUNCTION prevent_sale_tx_financial_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."grossCollectedMinor" IS DISTINCT FROM OLD."grossCollectedMinor"
     OR NEW."netRealizedCadMinor" IS DISTINCT FROM OLD."netRealizedCadMinor"
     OR NEW."paymentProofStorageKey" IS DISTINCT FROM OLD."paymentProofStorageKey" THEN
    RAISE EXCEPTION 'Immutable financial columns on SaleTransaction cannot be modified after creation.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_sale_tx_immutable_cols BEFORE UPDATE ON "SaleTransaction"
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_tx_financial_mutation();

-- 5. Enforce DomesticSaleChannel vs ExportSaleChannel by marketNode
ALTER TABLE "SaleTransaction" ADD CONSTRAINT sale_channel_node_integrity CHECK (
  ("marketNode" = 'ONTARIO_DOMESTIC' AND "domesticChannel" IS NOT NULL AND "exportChannel" IS NULL)
  OR
  ("marketNode" = 'TRINIDAD_VAULT' AND "exportChannel" IS NOT NULL AND "domesticChannel" IS NULL)
);

-- 6. Enforce Bill of Sale upload on Ramsayville Whole-Vehicle Retail Sales
ALTER TABLE "SaleTransaction" ADD CONSTRAINT ramsayville_vehicle_bill_of_sale_required CHECK (
  "domesticChannel" != 'RAMSAYVILLE_LOT_RETAIL'
  OR ("billOfSaleStorageKey" IS NOT NULL AND length(trim("billOfSaleStorageKey")) > 0)
);

-- 7. Enforce XOR target (Part vs. Vehicle) on CustodyEvent & B2BReservation
ALTER TABLE "CustodyEvent" ADD CONSTRAINT custody_event_target_xor CHECK (
  ("partId" IS NOT NULL AND "vehicleId" IS NULL) OR ("partId" IS NULL AND "vehicleId" IS NOT NULL)
);

ALTER TABLE "B2BReservation" ADD CONSTRAINT b2b_reservation_target_xor CHECK (
  ("partId" IS NOT NULL AND "vehicleId" IS NULL) OR ("partId" IS NULL AND "vehicleId" IS NOT NULL)
);

-- 8. Prevent overlapping active B2B holds on the same Part or Vehicle
CREATE UNIQUE INDEX unique_active_part_reservation ON "B2BReservation" ("partId") WHERE "isActive" = true AND "partId" IS NOT NULL;
CREATE UNIQUE INDEX unique_active_vehicle_reservation ON "B2BReservation" ("vehicleId") WHERE "isActive" = true AND "vehicleId" IS NOT NULL;
```

## 5. Deterministic State Machines & Concurrency Protocols

### 5.1 Two-Phase Marketplace-to-Export Lock (Preventing Double-Selling)

An external HTTP request to eBay cannot run inside a PostgreSQL transaction. To prevent double-selling between eBay Motors and outbound Trinidad pallets, the system enforces a **Two-Phase Reservation State Machine** across the orthogonal `ebaySyncState`, `custodyState`, and `availabilityState` axes:

```text
[ebaySyncState: SYNDICATED_LIVE]
           │
           │ (Worker scans part for Trinidad export OR B2B buyer reserves)
           ▼
  [EXPORT_LOCK_PENDING]  ───(Phase 3: Writes OutboxEvent in same DB TX)───► BullMQ Worker calls eBay API
           │             ───(Phase 1: Supervisor manual delist check)       (bulkUpdatePriceQuantity = 0)
           ├──────────────────────┬──────────────────────────────────────┘
           │                      │
           ▼ (eBay 200 OK /       ▼ (eBay Order Webhook arrived first!)
              Manual Confirm)
[EXPORT_LOCK_CONFIRMED]   [availabilityState: COMMITTED_DOMESTIC_SALE]
           │                      │
           ▼                      ▼
[custodyState: ON_EXPORT_PALLET] (Pushes Alert to Yard PWA: "PULL PART FROM PALLET — SOLD ON EBAY")
```

* **Physical Seal Gate Rule:** `ShipmentPallet.sealedAt` CANNOT be populated if any child `Part` on that pallet has `ebaySyncState == 'EXPORT_LOCK_PENDING'` or `custodyState == 'STRIPPED_RAW_OFFLINE'`. All parts must reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED`) before a pallet can be sealed.

### 5.2 Offline Custody Chain & Conflict Resolution

1. **No Silent Overwrites:** When an offline yard worker scans a part or whole asset into a container bin or onto a pallet, the PWA appends a `CustodyEvent` containing `expectedVersion` and a client UUIDv7 `idempotencyKey`.
2. **Server Reconciliation:** Upon sync, if `version == expectedVersion`, the server updates `storageLocationId` and increments `version`. If the version has diverged (e.g., another worker moved the item or it sold online while the device was offline), the server still records the `CustodyEvent` with `hasConflict = true` and surfaces a supervisor exception rather than silently dropping or overwriting the location.

### 5.3 Adaptive Checkout, Cash Custody & Trinidad Gate Token Protocol

The unified mobile checkout workflow (`/checkout`) adapts dynamically based on the scanned item's custody location (`marketNode`):

1. **Ontario Domestic Mode (`marketNode == 'ONTARIO_DOMESTIC'`):**
   * **Context & Channel Attribution:** Triggered when `HUNTER_MECHANIC` or `ARCHITECT_CFO` scans a `PRT-XXXXXX` part or `AST-XXXXXX` whole vehicle located in Ontario (`KEMP` or `RAMS`). The UI defaults to `CAD` and presents `DomesticSaleChannel` selector pills (`OTTAWA_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RAMSAYVILLE_LOT_RETAIL`, `WHOLESALE_MECHANIC_NETWORK`).
   * **Immediate eBay Delist Outbox:** If any sold part is currently active on eBay (`ebaySyncState == 'SYNDICATED_LIVE'`), the checkout transaction atomically transitions the part to `custodyState = 'SOLD_AND_RELEASED'`, `availabilityState = 'PAID_SETTLED'`, and writes an `OutboxEvent` (`PartSoldLocallyDelistEbayRequested`) to immediately zero out the eBay Motors offer, preventing online double-sales.
   * **Taz's Shop Float & Cash Custody Tracking:** Cash collected in person sets `cashCustodyState = 'HELD_BY_TAZ_FLOAT'`, creating an auditable shop petty-cash float that can be drawn down when logging shop `Expense` receipts (`paidFromCashCustody = 'HELD_BY_TAZ_FLOAT'`). Interac e-Transfers and wires default to `SETTLED_CANADA_BANK`.
   * **Whole-Vehicle Lot Release & Break-Even Velocity:** Whole-vehicle retail sales (`RAMSAYVILLE_LOT_RETAIL`) enforce uploading a signed Bill of Sale (`billOfSaleStorageKey`), transition the `Vehicle` to `lifecycleState = 'SOLD_RETAIL_ONTARIO'` and `availabilityState = 'PAID_SETTLED'` (freeing 1 of the 8 Ramsayville shop lot slots), and credit `netRealizedCadMinor` (`grossCollectedMinor - platformFeeMinor - shippingCostMinor`) toward the donor VIN's Break-Even Velocity counter and the $20k Capital Buffer. Because there is no separate warehouse security gate in Ontario, `isPaymentVerified` is set to `true` and `gateReleasedAt = now()` upon receipt upload.
2. **Trinidad Vault Mode (`marketNode == 'TRINIDAD_VAULT'`):**
   * **Strict Separation of Duties & MFA `aal2` Enforcement:** Users with `HUNTER_MECHANIC` or `OVERSEAS_B2B_BUYER` roles are hard-blocked at the API and RLS layers from mutating `SaleTransaction.isPaymentVerified` when `marketNode == 'TRINIDAD_VAULT'`. Only `TRINIDAD_VAULT_ADMIN` or `ARCHITECT_CFO` holding an active Supabase Auth JWT with Authenticator Assurance Level 2 (`aal2`) can verify payment.
   * **Single-Use Cryptographic Gate Token:** When `TRINIDAD_VAULT_ADMIN` or `ARCHITECT_CFO` verifies full payment (`grossCollectedMinor >= sum(vaultFloorPriceTtdMinor)`), uploads payment proof to `R2_PRIVATE_EVIDENCE_BUCKET`, and satisfies the $\ge \text{TT\$50,000}$ FIU CDD ID hash check, the server sets `cashCustodyState = 'HELD_IN_TRINIDAD_VAULT'` (or `'DEPOSITED_TRINIDAD_BANK'`), updates child items to `availabilityState = 'PAID_SETTLED'`, and generates an HMAC-SHA256 token signed with a KMS secret containing `{ txId, partIds[], vehicleIds[], nonce, exp: now + 4h }`.
   * **Atomic Gate Consumption:** Scanning the Gate QR at the Port of Spain exit door verifies the HMAC signature, checks `gateReleasedAt IS NULL`, and atomically sets `gateReleasedAt = now()`, all child parts to `custodyState = 'SOLD_AND_RELEASED'`, and whole vehicles/watercraft to `lifecycleState = 'SOLD_EXPORT_COD'`. Replay attempts fail immediately with HTTP `410 Gone`.

## 6. Hexagonal Ports Specification (`src/core/ports/index.ts`)

```typescript
// src/core/ports/index.ts

export interface DecodedAssetSpec {
  identifier: string; // 17-char VIN or 12-char HIN
  assetCategory: 'AUTOMOBILE' | 'WATERCRAFT' | 'SHOP_EQUIPMENT';
  year: number;
  make: string;
  model: string;
  trim: string | null;
  engineSpec: string | null;
  steeringSide: 'LHD_ONLY' | 'RHD_ONLY' | 'UNIVERSAL';
  rawPayload: Record<string, unknown>;
}

/**
 * 1. ASSET DECODER PORT
 * Implemented by CompositeAssetDecoderAdapter (routes 17-char VINs to NHTSA vPIC
 * and 12-char Watercraft HINs to Marine HIN Decoder / manual fallback).
 */
export interface IAssetDecoderPort {
  decodeIdentifier(vinOrHin: string, modelYearHint?: number): Promise<DecodedAssetSpec | null>;
}

/**
 * 2. ASSISTIVE AI VISION PORT
 * Outputs are treated as assistive proposals. If confidenceScore < 0.80,
 * Part transitions to NEEDS_HUMAN_REVIEW rather than auto-publishing.
 */
export interface IVisionEnrichmentPort {
  analyzeStrippedPart(input: {
    partId: string;
    sanitizedPublicImageUrls: string[];
    donorSpec?: DecodedAssetSpec;
  }): Promise<{
    extractedOemNumbers: string[];
    partCategoryName: string;
    steeringSideCompatibility: 'UNIVERSAL' | 'LHD_ONLY' | 'RHD_ONLY';
    isHazmatOrAirbag: boolean;
    suggestedHsCode: string;
    suggestedAraGrade: 'GRADE_A' | 'GRADE_B1' | 'GRADE_B2' | 'GRADE_B3' | 'GRADE_C' | 'GRADE_X';
    suggestedDamageCode: string;
    draftEbayTitle: string;
    confidenceScore: number;
  }>;
}

/**
 * 3. MARKETPLACE SYNDICATION PORT
 * Uses eBay Inventory API + Browse API (Active competitor pricing fallback,
 * avoiding reliance on restricted Marketplace Insights API).
 */
export interface IMarketplacePort {
  publishOrUpdateOffer(sku: string): Promise<{ listingId: string; offerId: string }>;
  zeroOutInventory(sku: string, offerId: string): Promise<{ acknowledged: boolean }>;
  fetchActiveCompetitorComps(oemPartNumber: string, query: string): Promise<{
    lowestActiveCadMinor: number;
    medianActiveCadMinor: number;
    activeListingCount: number;
  }>;
}

/**
 * 4. EXTERNAL ACCOUNTING GL SYNC PORT
 * Syncs verified operational subledger transactions to QuickBooks Online / Xero.
 */
export interface IAccountingGlPort {
  postExpenseJournal(expenseId: string): Promise<{ externalGlJournalId: string }>;
  postSaleTransactionJournal(saleTransactionId: string): Promise<{ externalGlJournalId: string }>;
  postFxSettlementJournal(settlementBatchId: string): Promise<{ externalGlJournalId: string }>;
}
```

