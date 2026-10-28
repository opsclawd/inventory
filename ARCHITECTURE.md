# ARCHITECTURE.md — Unified Multi-Tenant Modular Monolith (Salvage Export & Cannabis Compliance ERP)

## 1. System Overview & Architectural Principles

This platform is a **Unified Multi-Tenant Domain-Driven Design (DDD) Modular Monolith** adhering to **Hexagonal Architecture (Ports & Adapters)**. It runs **two distinct businesses** owned and operated by the partners on **80% shared physical warehouse infrastructure** (QR/ZPL thermal printing, mobile camera barcode scanning, hierarchical location bins, receipt-gated expenses, cash custody tracking, and private Cloudflare R2 evidence storage), while maintaining strict PostgreSQL schema and Row-Level Security (RLS) isolation:

1. **Engine 1 (`ORG_SALVAGE_EXPORT` — `salvage` DB schema):** Canada-First Ontario Auto/Marine Dismantling, eBay Motors & Local Classifieds Syndication, Ramsayville Vehicle Flips, and Pre-Paid Export across four operational nodes:
   * **Node 1 (Kemptville Yard — `ZONE_CONTAINER_PAD`):** Offline-first vehicle/watercraft dismantling, QR tagging, and 40ft container bin storage (`C01`–`C04`), centralizing 100% of stripped parts inventory in Ontario.
   * **Node 2 (Ramsayville Shop & Domestic Fulfillment Hub):** Vehicle repair, Salvage-to-Rebuilt dossier tracking, 8-slot retail vehicle lot (`RETAIL_LOT_VEHICLE_SALE`), eBay Motors courier dispatch (`EBAY_MOTORS_SHIPPED`), and bylaw-stealth local Ottawa classifieds pickup (`"Ramsayville / East Ottawa, ON"` — `RULE-MKT-002`).
   * **Node 3 (Pre-Paid Direct Export Consolidation):** LCL pallet / FCL container manifesting and broker-ready customs dossier output, governed by the **100% Pre-Paid Origin Export Gate (`RULE-EXP-001`)** prohibiting overseas consignment shipments when no destination vault is active.
   * **Node 4 (Destination Bonded Vault — Schema-Ready / Dormant in Phase 1–2):** Landed check-in, B2B reservation holds, MFA `aal2` Cash-on-Delivery (COD) checkout, blind cycle counts, and FX batch settlement (retained in schema behind `exportPolicy.exportFulfillmentMode` for future overseas vault activation and Vertical-SaaS portability).
2. **Engine 2 (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` DB schema):** Brockville JV & Kemptville Health Canada Cannabis Nursery (mother plants, clones, and genetics) and Processing ("moving the juice" — wet-to-dry curing, biomass extraction, and bulk lot transformation):
   * **Node 5 (Brockville Facility & Kemptville Nursery — `ZONE_GREENHOUSE_AG` / `ZONE_TREE_FARM`):** 3-tap mother-to-clone tray spawning, vegetative batch location tracking, gram-accurate mass-balance extraction/processing transformations, dual-witness destruction logging, and Health Canada CTLS / CRA Excise B300 reporting.

### Core Architectural Invariants

1. **PostgreSQL is the Single Source of Inventory Truth:** External marketplaces (eBay) and messaging channels (WhatsApp) are asynchronous projections. External HTTP calls NEVER execute inside a PostgreSQL database transaction.
2. **Multi-Schema Regulatory & Audit Firewall (`shared`, `salvage`, `cannabis`):** Shared operational infrastructure lives in the `shared` PostgreSQL schema, scoped by `organizationId` and enforced via Supabase Row-Level Security (RLS). Domain-specific tables are physically isolated into the `salvage` and `cannabis` schemas so that a Health Canada CTLS or CRA Excise audit export of `ORG_CANNABIS_NURSERY_PROC` has **zero visibility** into `salvage` tables, Trinidad export manifests, or automotive cash sales.
3. **Transactional Outbox Pattern:** All cross-module side effects and external API calls are persisted as `OutboxEvent` records within the same ACID transaction as the domain state mutation and processed asynchronously by BullMQ workers.
4. **Strict Storage Segregation (Public vs. Private R2):** Publicly accessible commerce images and private financial/compliance records are physically segregated into separate Cloudflare R2 buckets with distinct access policies.
5. **Operational Subledger, External General Ledger:** This system tracks unit-level (VIN/HIN/SKU/Lot) cost basis, mass balance, and profitability. Statutory double-entry accounting is delegated to an external General Ledger (QuickBooks Online / Xero) via an outbound sync adapter.

---

## 2. Technical Stack Specification

* **Runtime & Application Framework:** Next.js 15+ (App Router), React 19, Node.js v22 LTS, TypeScript 5.x (`strict: true`).
* **Mobile Offline Client (PWA):** Workbox Service Workers, IndexedDB (`Dexie.js`) for offline mutation queues and binary image blobs, `@zxing/browser` + native `BarcodeDetector` API.
* **Local Marketplace Browser Extension (`extensions/local-marketplace-lister/`):** Manifest V3 Chrome/Chromium Extension that reads structured listing payloads and sanitized WebP images from the ERP API (`/api/marketplace/local-ad-payload/[sku]`) and autofills Facebook Marketplace and Kijiji listing forms via user-initiated DOM injection (bypassing server-side anti-bot blocks).
* **Database & ORM:** PostgreSQL 16+ (Supabase) with Multi-Schema isolation (`schemas = ["shared", "salvage", "cannabis"]`), Row-Level Security (RLS), connection pooling, and Prisma ORM (`previewFeatures = ["multiSchema"]`).
* **Queue & Background Workers:** BullMQ backed by Redis 7.x (running in standalone Node.js worker process).
* **Object Storage:** Cloudflare R2:
  * `R2_PUBLIC_MEDIA_BUCKET`: Sanitized, EXIF-stripped WebP product photos for eBay/WhatsApp/Storefront.
  * `R2_PRIVATE_EVIDENCE_BUCKET`: Zero-public-access bucket (accessed strictly via short-lived, audit-logged pre-signed URLs) for expense receipts, bank wire slips, customs docs, vehicle titles, customer government IDs, Health Canada Lab Certificates of Analysis (`labCoaStorageKey`), and dual-witness cannabis destruction evidence photos (`evidencePhotoStorageKey`).

---

## 3. Repository Directory Structure

```text
src/
├── core/
│   ├── domain/                    # Pure TypeScript domain calculators & 4-axis state guards
│   ├── ports/                     # Hexagonal Port Interfaces (Zero external deps)
│   ├── events/                    # Domain Event contracts & Outbox publisher
│   └── config/                    # Versioned regulatory, tariff, FX & mass-balance parameters
├── modules/
│   ├── shared-ops/                # Shared Core: QR/ZPL printing, camera scanner, hierarchical
│   │   ├── domain/                # StorageLocation + Kemptville zoning state machine,
│   │   ├── application/           # receipt-gated Expense & float ledger, R2 storage adapters
│   │   └── infrastructure/
│   ├── dismantling/               # Salvage Context 1: Asset intake, stripping, bin custody
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── marketplace/               # Salvage Context 2: eBay sync, B2B storefront, WhatsApp
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── logistics-vault/           # Salvage Context 3: Pallets, manifests, Trinidad COD Vault
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── cannabis-compliance/       # Cannabis Context: Nursery batch tracking, mass-balance
│   │   ├── domain/                # processing transformations, 2-witness destruction logs,
│   │   ├── application/           # Health Canada CTLS & CRA B300 reporting
│   │   └── infrastructure/
│   └── cfo-subledger/             # Financial Context: Capital gate, expenses, FX, GL sync
│       ├── domain/
│       ├── application/
│       └── infrastructure/
├── infrastructure/
│   ├── db/                        # Prisma multi-schema client, migrations, RLS helpers
│   ├── adapters/                  # Concrete implementations of core/ports
│   └── workers/                   # BullMQ worker entrypoints
├── app/                           # Next.js App Router (Workspace Switcher, UI, Server Actions)
└── extensions/
    └── local-marketplace-lister/  # Manifest V3 Chrome Extension for 1-click FB Marketplace & Kijiji autofill
```

---

## 4. Production Database Schema (`schema.prisma`)

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["shared", "salvage", "cannabis"]
}

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

// ============================================================================
// 1. SHARED SCHEMA ENUMS & MODELS (@@schema("shared"))
// ============================================================================

enum OrganizationType {
  SALVAGE_AND_EXPORT
  CANNABIS_NURSERY_AND_PROCESSING

  @@schema("shared")
}

enum UserRole {
  ARCHITECT_CFO
  HUNTER_MECHANIC
  ONTARIO_STRIPPER
  TRINIDAD_VAULT_ADMIN
  OVERSEAS_B2B_BUYER
  CANNABIS_QAP_COMPLIANCE
  NURSERY_CULTIVATION_TECH

  @@schema("shared")
}

enum CurrencyCode {
  CAD
  USD
  TTD

  @@schema("shared")
}

enum ExpenseCategory {
  AUCTION_PURCHASE_PRICE
  AUCTION_BUYER_FEE
  TOWING_AND_RECOVERY
  YARD_STRIPPER_PIECE_RATE            // Per-car piece-rate payout ($300-$400 CAD) gated by RULE-PAY-001
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
  NUTRIENTS_AND_GROW_MEDIA
  LAB_COA_TESTING_FEE
  PROCESSING_SOLVENTS_AND_CONSUMABLES
  EXCISE_STAMP_AND_DUTY
  PARTNER_PROFIT_DRAW                 // Realized-profit partner draw gated by RULE-PAY-002 & RULE-PAY-003

  @@schema("shared")
}

enum AccountingSyncStatus {
  PENDING_SYNC
  SYNCED_TO_GL
  SYNC_FAILED

  @@schema("shared")
}

enum ReceiptVerificationState {
  VERIFIED_RECEIPT        // Standard receipt photo uploaded to R2_PRIVATE_EVIDENCE_BUCKET
  PETTY_CASH_VOUCHER      // Under-$50 CAD unreceipted voucher (capped at $250/mo per operator) with mandatory voucherReason
  PENDING_RECEIPT_UPLOAD  // Temporary unverified operator float hold awaiting receipt photo upload

  @@schema("shared")
}

enum SaleMarketNode {
  DOMESTIC_ORIGIN           // Kemptville Yard / Ramsayville Shop / Local Pickup
  DESTINATION_EXPORT_VAULT  // Port of Spain Family Warehouse / Export Destination Vault

  @@schema("shared")
}

enum CashCustodyState {
  HELD_IN_OPERATOR_FLOAT      // Cash in Operator's hands / Shop Petty Cash Float (Origin)
  HELD_IN_DESTINATION_VAULT   // Cash in Destination Vault safe awaiting bank deposit
  DEPOSITED_DESTINATION_BANK  // In Destination commercial bank awaiting FX conversion batch
  SETTLED_ORIGIN_CORP_BANK    // Interac e-Transfer / Wire / eBay Payout in Origin Corp Account

  @@schema("shared")
}

model Organization {
  id                        String           @id @default(uuid()) @db.Uuid
  slug                      String           @unique // "ORG_SALVAGE_EXPORT" | "ORG_CANNABIS_NURSERY_PROC"
  name                      String
  organizationType          OrganizationType
  policyConfigJson          Json?            // Optional per-tenant JSON policy overrides (merges over pricing-policy.json)
  craBusinessNumberBn15     String?
  healthCanadaLicenseNumber String?          // Populated for ORG_CANNABIS_NURSERY_PROC
  isActive                  Boolean          @default(true)
  createdAt                 DateTime         @default(now())
  updatedAt                 DateTime         @updatedAt

  memberships               OrganizationMembership[]
  storageLocations          StorageLocation[]
  expenses                  Expense[]
  cashCustodyTransfers      CashCustodyTransfer[]
  custodyEvents             CustodyEvent[]
  auditLogs                 AuditLog[]
  cannabisStrains           CannabisStrain[]
  cannabisLots              CannabisLot[]
  cannabisDestructionLogs   CannabisDestructionLog[]

  @@schema("shared")
}

model User {
  id                String    @id @default(uuid()) @db.Uuid
  email             String    @unique
  phoneE164         String?   @unique
  fullName          String
  role              UserRole
  mfaEnrolled       Boolean   @default(false) // Required true for CFO, VAULT_ADMIN, and CANNABIS_QAP_COMPLIANCE
  commissionRateBps Int       @default(0)     // e.g., 500 = 5.00%, 1000 = 10.00%
  whatsappOptInAt   DateTime?
  whatsappWindowExp DateTime?
  isActive          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  memberships             OrganizationMembership[]
  strippedParts           Part[]                      @relation("StrippedByUser")
  custodyEvents           CustodyEvent[]
  loggedExpenses          Expense[]                   @relation("LoggedByUser")
  salesExecuted           SaleTransaction[]           @relation("SoldByUser")
  brokeredSales           SaleTransaction[]           @relation("BrokerUser")
  verifiedSales           SaleTransaction[]           @relation("VerifiedByAdmin")
  cfoOverrideSales        SaleTransaction[]           @relation("CfoOverrideApprover")
  cashTransfersRecorded   CashCustodyTransfer[]       @relation("TransferRecordedByUser")
  cycleCountTasks         CycleCountTask[]            @relation("AssignedVaultAdmin")
  wishLists               PreOrderWishList[]
  auditLogs               AuditLog[]
  executedTransformations CannabisLotTransformation[] @relation("ExecutedByTech")
  verifiedTransformations CannabisLotTransformation[] @relation("VerifiedByQap")
  primaryDestructions     CannabisDestructionLog[]    @relation("PrimaryDestructionUser")
  witnessedDestructions   CannabisDestructionLog[]    @relation("WitnessDestructionUser")

  @@schema("shared")
}

model OrganizationMembership {
  id                 String       @id @default(uuid()) @db.Uuid
  organizationId     String       @db.Uuid
  organization       Organization @relation(fields: [organizationId], references: [id])
  userId             String       @db.Uuid
  user               User         @relation(fields: [userId], references: [id])
  role               UserRole
  isDefaultWorkspace Boolean      @default(false)
  createdAt          DateTime     @default(now())

  @@unique([organizationId, userId])
  @@index([userId])
  @@schema("shared")
}

model StorageLocation {
  id                     String           @id @default(uuid()) @db.Uuid
  organizationId         String           @db.Uuid
  organization           Organization     @relation(fields: [organizationId], references: [id])
  allowedOrgType         OrganizationType // Enforces RULE-ZONE-001 at data layer (SALVAGE_AND_EXPORT vs CANNABIS_NURSERY_AND_PROCESSING)
  maxActiveAssetCapacity Int?             // Configurable active vehicle/shell limit per zone (e.g., 4 for Kemptville Pad, 8 for Ramsayville Lot, null for shelf bins)
  siteCode               String           // "KEMP", "RAMS", "POSV", "BROCK"
  zoneCode               String           @default("ZONE_CONTAINER_PAD") // "ZONE_CONTAINER_PAD", "ZONE_GREENHOUSE_AG", "ZONE_TREE_FARM", "ZONE_RAMSAYVILLE_SHOP", "ZONE_TRINIDAD_VAULT", "ZONE_BROCKVILLE_FACILITY"
  containerCode          String           // "C01".."C04", "V01", "PROP", "EXTR"
  rackCode               String           // "R01".."R10"
  shelfCode              String           // "S01".."S05" or "T01".."T10"
  binCode                String           // "B01".."B20"
  fullQrBarcode          String           @unique // e.g., "KEMP-C01-R02-S03-B04" or "BROCK-PROP-R1-T2"
  maxWeightKg            Decimal          @default(150.0) @db.Decimal(6, 2)
  createdAt              DateTime         @default(now())

  parts          Part[]
  vehicles       Vehicle[]
  cannabisLots   CannabisLot[]

  @@index([organizationId, siteCode, zoneCode])
  @@index([siteCode, containerCode])
  @@schema("shared")
}

// Append-only custody chain for stripped Parts, whole Vehicles/Watercraft, and CannabisLots
model CustodyEvent {
  id                  String       @id @default(uuid()) @db.Uuid
  organizationId      String       @db.Uuid
  organization        Organization @relation(fields: [organizationId], references: [id])
  partId              String?      @db.Uuid
  part                Part?        @relation(fields: [partId], references: [id])
  vehicleId           String?      @db.Uuid
  vehicle             Vehicle?     @relation(fields: [vehicleId], references: [id])
  cannabisLotId       String?      @db.Uuid
  cannabisLot         CannabisLot? @relation(fields: [cannabisLotId], references: [id])
  actorUserId         String       @db.Uuid
  actorUser           User         @relation(fields: [actorUserId], references: [id])
  idempotencyKey      String       @unique // Client UUIDv7 generated at scan time
  fromLocationBarcode String?
  toLocationBarcode   String       // Bin QR, Pallet QR, Vault Shelf QR, or Grow Table QR
  expectedVersion     Int
  hasConflict         Boolean      @default(false) // Flagged true if offline scan version mismatches server
  deviceTimestamp     DateTime
  serverReceivedAt    DateTime     @default(now())

  @@index([organizationId, serverReceivedAt])
  @@index([partId, serverReceivedAt])
  @@index([vehicleId, serverReceivedAt])
  @@index([cannabisLotId, serverReceivedAt])
  @@schema("shared")
}

model Expense {
  id                    String               @id @default(uuid()) @db.Uuid
  organizationId        String               @db.Uuid
  organization          Organization         @relation(fields: [organizationId], references: [id])
  vehicleId             String?              @db.Uuid
  vehicle               Vehicle?             @relation(fields: [vehicleId], references: [id])
  shipmentId            String?              @db.Uuid
  shipment              Shipment?            @relation(fields: [shipmentId], references: [id])
  cannabisLotId         String?              @db.Uuid
  cannabisLot           CannabisLot?         @relation(fields: [cannabisLotId], references: [id])
  loggedByUserId        String               @db.Uuid
  loggedByUser          User                 @relation("LoggedByUser", fields: [loggedByUserId], references: [id])

  category              ExpenseCategory
  vendorName            String
  description           String
  amountOriginalMinor   Int
  currencyOriginal      CurrencyCode         @default(CAD)
  amountCadMinor        Int
  paidFromCashCustody   CashCustodyState?    // Allows deducting shop expenses directly from HELD_IN_OPERATOR_FLOAT
  isReversalEntry       Boolean              @default(false)
  reversesExpenseId     String?              @db.Uuid

  // Tiered Receipt & Voucher Evidence (Stored in R2_PRIVATE_EVIDENCE_BUCKET when VERIFIED_RECEIPT)
  receiptVerificationState ReceiptVerificationState @default(VERIFIED_RECEIPT)
  receiptStorageKey        String?                  // Mandatory when receiptVerificationState == VERIFIED_RECEIPT
  receiptSha256Hash        String?
  voucherReason            String?                  // Mandatory (>= 5 chars) when PETTY_CASH_VOUCHER or PENDING_RECEIPT_UPLOAD
  receiptOcrJson           Json?

  // External Accounting Subledger Sync
  accountingSyncStatus  AccountingSyncStatus @default(PENDING_SYNC)
  externalGlJournalId   String?

  incurredAt            DateTime
  createdAt             DateTime             @default(now())

  @@index([organizationId, incurredAt])
  @@index([vehicleId])
  @@index([shipmentId])
  @@index([cannabisLotId])
  @@schema("shared")
}

// Tracks partial lump-sum cash drops from Operator Float or Destination Vault safe to commercial banks
model CashCustodyTransfer {
  id                     String               @id @default(uuid()) @db.Uuid
  organizationId         String               @db.Uuid
  organization           Organization         @relation(fields: [organizationId], references: [id])
  transferCode           String               @unique // e.g., "DROP-ONT-2026-0012" or "DROP-POS-2026-0008"
  marketNode             SaleMarketNode
  fromCustodyState       CashCustodyState     // HELD_IN_OPERATOR_FLOAT or HELD_IN_DESTINATION_VAULT
  toCustodyState         CashCustodyState     // SETTLED_ORIGIN_CORP_BANK or DEPOSITED_DESTINATION_BANK
  currency               CurrencyCode
  amountMinor            Int
  equivalentCadMinor     Int
  commercialBankName     String?              // Tracked against TT$200,000 DIC cap when toCustodyState == DEPOSITED_DESTINATION_BANK
  depositSlipStorageKey  String               // Mandatory private R2 key (enforced non-empty via SQL CHECK)
  recordedByUserId       String               @db.Uuid
  recordedByUser         User                 @relation("TransferRecordedByUser", fields: [recordedByUserId], references: [id])
  accountingSyncStatus   AccountingSyncStatus @default(PENDING_SYNC)
  externalGlJournalId    String?
  transferredAt          DateTime             @default(now())
  createdAt              DateTime             @default(now())

  @@index([organizationId, transferredAt])
  @@index([marketNode, fromCustodyState, toCustodyState])
  @@index([commercialBankName])
  @@schema("shared")
}

// Transactional Outbox for reliable asynchronous processing via BullMQ
model OutboxEvent {
  id             String    @id @default(uuid()) @db.Uuid
  aggregateType  String    // "Part", "Vehicle", "Shipment", "SaleTransaction", "CannabisLot"
  aggregateId    String    @db.Uuid
  eventType      String    // e.g., "PartExportLockRequested", "VaultCodVerified", "CannabisVarianceAlert"
  payloadJson    Json
  idempotencyKey String    @unique
  status         String    @default("PENDING") // "PENDING", "PROCESSING", "COMPLETED", "DEAD_LETTER"
  retryCount     Int       @default(0)
  lastError      String?
  createdAt      DateTime  @default(now())
  processedAt    DateTime?

  @@index([status, createdAt])
  @@schema("shared")
}

model AuditLog {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id])
  actorUserId    String       @db.Uuid
  actorUser      User         @relation(fields: [actorUserId], references: [id])
  entityType     String
  entityId       String
  action         String
  previousState  Json?
  nextState      Json?
  ipAddress      String?
  createdAt      DateTime     @default(now())

  @@index([organizationId, createdAt])
  @@index([entityType, entityId])
  @@schema("shared")
}

// ============================================================================
// 2. SALVAGE & EXPORT SCHEMA ENUMS & MODELS (@@schema("salvage"))
// ============================================================================

enum AssetCategory {
  AUTOMOBILE
  WATERCRAFT      // Sea-Doo, Yamaha JetBoat/WaveRunner (Bypasses MTO DriveON)
  SHOP_EQUIPMENT  // A/C Recharge Machines, Lifts, Tools

  @@schema("salvage")
}

enum RoadVehicleBrand {
  NONE
  SALVAGE
  REBUILT
  IRREPARABLE
  NOT_APPLICABLE  // Mandatory default for WATERCRAFT and SHOP_EQUIPMENT

  @@schema("salvage")
}

enum OperationalLane {
  QUICK_TURN_BEATER
  HIGH_END_REBUILD
  DISMANTLE_AND_EXPORT
  WHOLE_UNIT_EXPORT

  @@schema("salvage")
}

enum SteeringSideCompatibility {
  UNIVERSAL       // Steering-side geometry neutral (does not bypass OEM part-number fitment verification)
  LHD_ONLY        // North American steering racks, dash, LHD headlamps, master switches
  RHD_ONLY        // RHD-specific steering/interior components

  @@schema("salvage")
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

  @@schema("salvage")
}

enum PartCustodyState {
  STRIPPED_RAW_OFFLINE
  SHELVED_ORIGIN_CONTAINER
  ON_EXPORT_PALLET
  IN_TRANSIT_OCEAN_FREIGHT
  CUSTOMS_HOLD_DESTINATION
  SHELVED_DESTINATION_VAULT
  SOLD_AND_RELEASED
  SCRAPPED_OR_DAMAGED

  @@schema("salvage")
}

enum InventoryAvailabilityState {
  AVAILABLE
  RESERVED_B2B_HOLD
  COMMITTED_DOMESTIC_SALE
  PENDING_VAULT_COD_PAYMENT
  PAID_SETTLED

  @@schema("salvage")
}

enum EbaySyncState {
  NOT_LISTED
  SYNDICATED_LIVE           // Live on eBay Motors (via Phase 1A Bulk CSV or Phase 2A Inventory API)
  DELIST_PENDING            // Sold locally/offline; OutboxEvent emitted, awaiting quantity=0 confirmation
  DELISTED                  // Confirmed ended/zeroed on eBay Motors after domestic sale
  EXPORT_LOCK_PENDING       // Waiting for automated eBay API 200 OK (Phase 2A+) or manual delist check (Phase 1B)
  EXPORT_LOCK_CONFIRMED     // Verified zero quantity on eBay; safe to seal export pallet

  @@schema("salvage")
}

enum ClassifiedsSyncState {
  NOT_POSTED
  POSTED_LIVE               // Posted to FB Marketplace / Kijiji via 1-Click Share or Chrome Extension
  DELIST_REQUIRED           // Sold at checkout; operator must mark local FB/Kijiji ad as sold
  DELISTED                  // Confirmed removed/marked sold on local classifieds

  @@schema("salvage")
}

enum PartComplianceState {
  PENDING_ENRICHMENT
  NEEDS_HUMAN_REVIEW
  CLEARED_FOR_SALE
  QUARANTINED_RECALL_OR_DG

  @@schema("salvage")
}

enum AraConditionGradeEnum {
  GRADE_A
  GRADE_B1
  GRADE_B2
  GRADE_B3
  GRADE_C
  GRADE_X

  @@schema("salvage")
}

// Explicitly tracks how domestic origin parts and retail lot vehicles are sold
enum DomesticSaleChannel {
  LOCAL_WALK_IN_CASH          // Mechanic or buyer walking into origin yard/shop
  FB_MARKETPLACE_LOCAL        // Local pickup via Facebook Marketplace listing
  KIJIJI_LOCAL                // Local pickup via Kijiji ad
  RETAIL_LOT_VEHICLE_SALE     // Whole beater / rebuilt salvage car sold off the retail lot
  WHOLESALE_MECHANIC_NETWORK  // Direct B2B sale to local repair shop
  EBAY_MOTORS_SHIPPED         // Shipped domestic/US order (~13.25% platform fee + label)
  CAR_PART_WHOLESALE          // North American salvage exchange order

  @@schema("salvage")
}

enum ExportSaleChannel {
  DESTINATION_VAULT_COD          // Standard Destination Vault cash/wire release
  DESTINATION_PRE_ORDER_PICKUP   // Pre-sold via Mechanic Wish List / "Loading Now" tab
  SECONDARY_ISLAND_WHOLESALE     // Secondary island wholesale lane

  @@schema("salvage")
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
  odometerKm                  Int?                       // Road odometer in km
  engineHours                 Int?                       // Watercraft / equipment operating hours
  exteriorColor               String?
  steeringSide                SteeringSideCompatibility  @default(LHD_ONLY)
  oemFitmentVerified          Boolean                    @default(false)
  roadBrand                   RoadVehicleBrand           @default(NONE)
  operationalLane             OperationalLane
  lifecycleState              AssetLifecycleState        @default(PROPOSED_DEAL)
  availabilityState           InventoryAvailabilityState @default(AVAILABLE)
  classifiedsSyncState        ClassifiedsSyncState       @default(NOT_POSTED)
  storageLocationId           String?                    @db.Uuid
  storageLocation             StorageLocation?           @relation(fields: [storageLocationId], references: [id])

  // Export Physical Specs & Tariff Classification (For Whole-Unit Exports: Watercraft, Equipment, Cars)
  weightKg                    Decimal?                   @db.Decimal(8, 2)
  dimensionsCm                Json?                      // { "l": 320, "w": 125, "h": 110 }
  suggestedHsCode             String                     @default("8903.99")
  brokerVerifiedHsCode        String?

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
  brokerMarketPriceTtdMinor   Int?                       // Expected local TT selling price quoted by broker

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
  scrapRecoveryCadMinor       Int                        @default(0) // CAD Cents received on scrapMetalTicketKey weigh receipt
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
  cycleCountItems             CycleCountTask[]
  matchedWishLists            PreOrderWishList[]         @relation("MatchedVehicleWishList")
  shipmentId                  String?                    @db.Uuid
  shipment                    Shipment?                  @relation(fields: [shipmentId], references: [id])
  saleTransactionItems        SaleTransactionVehicleItem[]

  @@index([lifecycleState, operationalLane])
  @@index([availabilityState])
  @@index([storageLocationId])
  @@index([make, model, year])
  @@schema("salvage")
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
  classifiedsSyncState       ClassifiedsSyncState       @default(NOT_POSTED)
  complianceState            PartComplianceState        @default(PENDING_ENRICHMENT)

  partCategoryName           String                     @default("UNCLASSIFIED")
  steeringSideCompatibility  SteeringSideCompatibility  @default(UNIVERSAL)
  oemFitmentVerified         Boolean                    @default(false) // Mandatory destination-market OEM part# check
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
  brokerMarketPriceTtdMinor  Int?                       // Expected local TT selling price quoted by broker

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
  cycleCountItems            CycleCountTask[]
  matchedWishLists           PreOrderWishList[]         @relation("MatchedPartWishList")
  saleTransactionItems       SaleTransactionPartItem[]

  @@index([custodyState, availabilityState])
  @@index([ebaySyncState])
  @@index([complianceState])
  @@index([donorVehicleId])
  @@index([storageLocationId])
  @@index([steeringSideCompatibility])
  @@schema("salvage")
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

  @@schema("salvage")
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

  @@schema("salvage")
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
  matchedPart            Part?                     @relation("MatchedPartWishList", fields: [matchedPartId], references: [id])
  matchedVehicleId       String?                   @db.Uuid
  matchedVehicle         Vehicle?                  @relation("MatchedVehicleWishList", fields: [matchedVehicleId], references: [id])
  createdAt              DateTime                  @default(now())

  @@index([targetMake, targetModel, isFulfilled])
  @@index([matchedPartId])
  @@index([matchedVehicleId])
  @@schema("salvage")
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
  @@schema("salvage")
}

model SaleTransaction {
  id                      String               @id @default(uuid()) @db.Uuid
  receiptNumber           String               @unique // "ONT-2026-0041" or "POS-2026-0089"
  marketNode              SaleMarketNode

  // Channel Attribution (Mutually exclusive via DB CHECK constraint)
  domesticChannel         DomesticSaleChannel? // Populated when marketNode == DOMESTIC_ORIGIN
  exportChannel           ExportSaleChannel?   // Populated when marketNode == DESTINATION_EXPORT_VAULT

  taxInvoiceNumber          String?              @unique
  buyerName                 String
  buyerPhoneE164            String?
  buyerIdDocumentStorageKey String?              // Private R2 key of government ID scan/photo (Required if TT sale >= TT$50,000)
  buyerIdNumberEncrypted    String?              // AES-256-GCM application-encrypted ID type and number for FIU audit

  // Actors & Separation of Duties
  soldByUserId            String               @db.Uuid
  soldByUser              User                 @relation("SoldByUser", fields: [soldByUserId], references: [id])
  brokerUserId            String?              @db.Uuid
  brokerUser              User?                @relation("BrokerUser", fields: [brokerUserId], references: [id])
  verifiedByAdminId       String               @db.Uuid // In Trinidad, MUST be TRINIDAD_VAULT_ADMIN or CFO
  verifiedByAdmin         User                 @relation("VerifiedByAdmin", fields: [verifiedByAdminId], references: [id])

  // Financial Totals (Minor Units / Cents)
  paymentCurrency                     CurrencyCode         // CAD (Origin) or TTD/USD (Destination)
  floorPriceAtCheckoutMinor           Int?                 // Snapshot of item(s) floor price at moment of sale for auditability
  subtotalMinor                       Int
  discountAmountMinor                 Int                  @default(0) // max(0, floorPriceAtCheckoutMinor - grossCollectedMinor)
  discountReasonCode                  String?              // "CASH_ROUNDING" | "BUNDLE_DISCOUNT" | "TRANSIT_OR_SHOP_DAMAGE" | "AGED_INVENTORY_CLEARANCE" | "CFO_CUSTOM_OVERRIDE"
  cfoOverrideApprovedById             String?              @db.Uuid    // Populated when discount exceeds Admin Corridor and is overridden by ARCHITECT_CFO
  cfoOverrideApprovedBy               User?                @relation("CfoOverrideApprover", fields: [cfoOverrideApprovedById], references: [id])
  cfoOverrideReasonNote               String?
  platformFeeMinor                    Int                  @default(0) // $0 for FB/Walk-In; ~13.25% for EBAY_MOTORS_SHIPPED
  shippingCostMinor                   Int                  @default(0) // $0 for Local Pickup; Courier label cost for eBay
  taxOrVatMinor                       Int                  @default(0)
  grossCollectedMinor                 Int
  netRealizedCadMinor                 Int                  // (gross - platformFee - shipping) in CAD for VIN Break-Even & Self-Funding Pool math
  paymentMethod                       String               // "CASH", "INTERAC_ETRANSFER", "VERIFIED_BANK_WIRE", "EBAY_MANAGED_PAYOUT"
  cashCustodyState                    CashCustodyState

  // Private Evidence (Stored in R2_PRIVATE_EVIDENCE_BUCKET)
  paymentProofStorageKey              String               // Photo of cash, e-Transfer screenshot, or wire slip (Mandatory)
  billOfSaleStorageKey                String?              // Mandatory when domesticChannel == RETAIL_LOT_VEHICLE_SALE
  ttdCommercialBankName               String?

  // Broker Commission & Counter Netting (Destination / Overseas B2B)
  brokerCommissionBps                 Int                  @default(0)
  brokerCommissionMinor               Int                  @default(0)
  isBrokerCommissionDeductedAtCounter Boolean              @default(false) // When true, physical cash added to HELD_IN_DESTINATION_VAULT is grossCollectedMinor - brokerCommissionMinor
  brokerCommissionPaidAt              DateTime?

  // Gate Release Lock (Phase 1-2: stamped atomically upon payment verification; Phase 3: two-step HMAC Gate Token)
  isPaymentVerified       Boolean              @default(false)
  gateTokenNonce          String?              @unique
  gateTokenExpiresAt      DateTime?
  gateReleasedAt          DateTime?

  // Void / Reversal Support (Allows re-selling items without violating financial table immutability)
  isVoidedOrReversed      Boolean              @default(false)
  reversesSaleTxId        String?              @db.Uuid
  voidReason              String?

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
  @@schema("salvage")
}

model SaleTransactionPartItem {
  id                String          @id @default(uuid()) @db.Uuid
  saleTransactionId String          @db.Uuid
  saleTransaction   SaleTransaction @relation(fields: [saleTransactionId], references: [id])
  partId            String          @db.Uuid // Active uniqueness enforced via partial index unique_active_sold_part
  part              Part            @relation(fields: [partId], references: [id])
  soldPriceMinor    Int
  isActiveSale      Boolean         @default(true)

  @@index([partId])
  @@schema("salvage")
}

model SaleTransactionVehicleItem {
  id                String          @id @default(uuid()) @db.Uuid
  saleTransactionId String          @db.Uuid
  saleTransaction   SaleTransaction @relation(fields: [saleTransactionId], references: [id])
  vehicleId         String          @db.Uuid // Active uniqueness enforced via partial index unique_active_sold_vehicle
  vehicle           Vehicle         @relation(fields: [vehicleId], references: [id])
  soldPriceMinor    Int
  isActiveSale      Boolean         @default(true)

  @@index([vehicleId])
  @@schema("salvage")
}

// Weekly Blind Cycle Count task for physical Trinidad Vault audit & anti-shrinkage reconciliation
model CycleCountTask {
  id                        String    @id @default(uuid()) @db.Uuid
  batchCode                 String    // e.g., "CC-2026-W43"
  partId                    String?   @db.Uuid
  part                      Part?     @relation(fields: [partId], references: [id])
  vehicleId                 String?   @db.Uuid
  vehicle                   Vehicle?  @relation(fields: [vehicleId], references: [id])
  assignedToAdminId         String    @db.Uuid
  assignedToAdmin           User      @relation("AssignedVaultAdmin", fields: [assignedToAdminId], references: [id])
  expectedLocationBarcode   String
  scannedLocationBarcode    String?
  liveVerificationPhotoKey  String?   // Timestamped photo stored in R2_PRIVATE_EVIDENCE_BUCKET
  status                    String    @default("PENDING") // "PENDING", "VERIFIED_MATCH", "DISCREPANCY_ALERT"
  discrepancyNotes          String?
  dueAt                     DateTime
  completedAt               DateTime?
  createdAt                 DateTime  @default(now())

  @@index([status, dueAt])
  @@index([batchCode])
  @@schema("salvage")
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

  @@schema("salvage")
}

// ============================================================================
// 3. CANNABIS NURSERY & PROCESSING SCHEMA ENUMS & MODELS (@@schema("cannabis"))
// ============================================================================

enum CannabisLotStage {
  MOTHER_PLANT
  CLONE_TRAY
  VEGETATIVE_BATCH
  FRESH_HARVEST
  DRIED_FLOWER
  TRIM_BIOMASS
  CRUDE_EXTRACT
  DISTILLATE_OR_ISOLATE

  @@schema("cannabis")
}

enum CannabisTrackingUnit {
  PLANTS
  GRAMS

  @@schema("cannabis")
}

model CannabisStrain {
  id                   String        @id @default(uuid()) @db.Uuid
  organizationId       String        @db.Uuid
  organization         Organization  @relation(fields: [organizationId], references: [id])
  name                 String
  lineage              String?
  targetThcPct         Decimal?      @db.Decimal(5, 2)
  targetTerpeneProfile String?
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt

  lots                 CannabisLot[]

  @@unique([organizationId, name])
  @@index([organizationId])
  @@schema("cannabis")
}

model CannabisLot {
  id                    String                      @id @default(uuid()) @db.Uuid
  organizationId        String                      @db.Uuid
  organization          Organization                @relation(fields: [organizationId], references: [id])
  lotBarcode            String                      @unique // e.g., "LOT-2026-0001"
  strainId              String                      @db.Uuid
  strain                CannabisStrain              @relation(fields: [strainId], references: [id])
  parentMotherLotId     String?                     @db.Uuid
  parentMotherLot       CannabisLot?                @relation("MotherToCloneLots", fields: [parentMotherLotId], references: [id])
  childCloneLots        CannabisLot[]               @relation("MotherToCloneLots")

  lotStage              CannabisLotStage
  trackingUnit          CannabisTrackingUnit
  plantCount            Int                         @default(0)
  netWeightGrams        Decimal                     @default(0.00) @db.Decimal(10, 2)
  storageLocationId     String?                     @db.Uuid
  storageLocation       StorageLocation?            @relation(fields: [storageLocationId], references: [id])
  complianceHold        Boolean                     @default(false)
  labCoaStorageKey      String?                     // Stored in R2_PRIVATE_EVIDENCE_BUCKET
  version               Int                         @default(1)
  createdAt             DateTime                    @default(now())
  updatedAt             DateTime                    @updatedAt

  sourceTransformations CannabisLotTransformation[] @relation("SourceLot")
  targetTransformations CannabisLotTransformation[] @relation("TargetLot")
  destructionLogs       CannabisDestructionLog[]
  custodyHistory        CustodyEvent[]
  expenses              Expense[]

  @@index([organizationId, lotStage])
  @@index([storageLocationId])
  @@index([strainId])
  @@schema("cannabis")
}

model CannabisLotTransformation {
  id                       String      @id @default(uuid()) @db.Uuid
  sourceLotId              String      @db.Uuid
  sourceLot                CannabisLot @relation("SourceLot", fields: [sourceLotId], references: [id])
  targetLotId              String      @db.Uuid
  targetLot                CannabisLot @relation("TargetLot", fields: [targetLotId], references: [id])
  inputWeightGrams         Decimal     @db.Decimal(10, 2)
  outputWeightGrams        Decimal     @db.Decimal(10, 2)
  moistureLossGrams        Decimal     @default(0.00) @db.Decimal(10, 2)
  wasteDestroyedGrams      Decimal     @default(0.00) @db.Decimal(10, 2)
  unaccountedVarianceGrams Decimal     @default(0.00) @db.Decimal(10, 2)
  varianceAlertFlagged     Boolean     @default(false) // Flagged true if |unaccountedVarianceGrams| / inputWeightGrams > 2.0%
  executedByUserId         String      @db.Uuid
  executedByUser           User        @relation("ExecutedByTech", fields: [executedByUserId], references: [id])
  verifiedByQapUserId      String?     @db.Uuid
  verifiedByQapUser        User?       @relation("VerifiedByQap", fields: [verifiedByQapUserId], references: [id])
  createdAt                DateTime    @default(now())

  @@index([sourceLotId])
  @@index([targetLotId])
  @@schema("cannabis")
}

model CannabisDestructionLog {
  id                      String       @id @default(uuid()) @db.Uuid
  organizationId          String       @db.Uuid
  organization            Organization @relation(fields: [organizationId], references: [id])
  lotId                   String       @db.Uuid
  lot                     CannabisLot  @relation(fields: [lotId], references: [id])
  weightDestroyedGrams    Decimal      @default(0.00) @db.Decimal(10, 2)
  plantsDestroyedCount    Int          @default(0)
  destructionReason       String
  destructionMethod       String
  evidencePhotoStorageKey String       // Mandatory private R2 key in R2_PRIVATE_EVIDENCE_BUCKET
  primaryUserId           String       @db.Uuid
  primaryUser             User         @relation("PrimaryDestructionUser", fields: [primaryUserId], references: [id])
  witnessUserId           String       @db.Uuid
  witnessUser             User         @relation("WitnessDestructionUser", fields: [witnessUserId], references: [id])
  destroyedAt             DateTime     @default(now())

  @@index([organizationId, destroyedAt])
  @@index([lotId])
  @@schema("cannabis")
}
```

### Mandatory Raw SQL Constraints & Multi-Tenant RLS (Applied in Prisma Migration)

Prisma does not natively express `CHECK` constraints, immutable triggers, or Row-Level Security policies. The initial migration MUST include:

```sql
-- 1. Enforce tiered receipt/voucher rules on shared.Expense, non-empty slip key on shared.CashCustodyTransfer,
--    and require donor vehicleId linkage on YARD_STRIPPER_PIECE_RATE payouts (RULE-PAY-001)
ALTER TABLE "shared"."Expense" ADD CONSTRAINT expense_receipt_or_voucher_check CHECK (
  ("receiptVerificationState" = 'VERIFIED_RECEIPT' AND "receiptStorageKey" IS NOT NULL AND length(trim("receiptStorageKey")) > 0)
  OR
  ("receiptVerificationState" IN ('PETTY_CASH_VOUCHER', 'PENDING_RECEIPT_UPLOAD') AND "voucherReason" IS NOT NULL AND length(trim("voucherReason")) >= 5)
);
ALTER TABLE "shared"."Expense" ADD CONSTRAINT piece_rate_requires_donor_vehicle CHECK (
  "category" != 'YARD_STRIPPER_PIECE_RATE' OR "vehicleId" IS NOT NULL
);
ALTER TABLE "shared"."CashCustodyTransfer" ADD CONSTRAINT transfer_slip_non_empty CHECK (length(trim("depositSlipStorageKey")) > 0);

-- 2. Enforce Commission Holdback Invariant at DB level
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT commission_requires_verified_payment
  CHECK ("brokerCommissionPaidAt" IS NULL OR "isPaymentVerified" = true);

-- 3. Enforce Watercraft/Equipment bypass of RoadVehicleBrand
ALTER TABLE "salvage"."Vehicle" ADD CONSTRAINT non_auto_brand_check
  CHECK ("assetCategory" = 'AUTOMOBILE' OR "roadBrand" = 'NOT_APPLICABLE');

-- 4. Block DELETE and destructive UPDATE on financial, compliance & audit tables
CREATE OR REPLACE FUNCTION prevent_audit_tampering() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Tampering prohibited on immutable financial/compliance/audit table: %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_audit_log BEFORE UPDATE OR DELETE ON "shared"."AuditLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_expense_delete BEFORE DELETE ON "shared"."Expense" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_sale_tx_delete BEFORE DELETE ON "salvage"."SaleTransaction" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_cash_transfer_delete BEFORE DELETE ON "shared"."CashCustodyTransfer" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_cannabis_destruction_log BEFORE UPDATE OR DELETE ON "cannabis"."CannabisDestructionLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_cannabis_transformation_delete BEFORE DELETE ON "cannabis"."CannabisLotTransformation" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();

-- 4b. Block mutation of immutable financial columns on shared.Expense & salvage.SaleTransaction while permitting
--     attaching a receipt to a PENDING_RECEIPT_UPLOAD expense or voiding a SaleTransaction
CREATE OR REPLACE FUNCTION prevent_expense_financial_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."amountOriginalMinor" IS DISTINCT FROM OLD."amountOriginalMinor"
     OR NEW."amountCadMinor" IS DISTINCT FROM OLD."amountCadMinor"
     OR (OLD."receiptStorageKey" IS NOT NULL AND NEW."receiptStorageKey" IS DISTINCT FROM OLD."receiptStorageKey") THEN
    RAISE EXCEPTION 'Immutable financial columns on Expense cannot be modified after creation; log a reversal entry instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_expense_immutable_cols BEFORE UPDATE ON "shared"."Expense"
  FOR EACH ROW EXECUTE FUNCTION prevent_expense_financial_mutation();

CREATE OR REPLACE FUNCTION prevent_sale_tx_financial_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."grossCollectedMinor" IS DISTINCT FROM OLD."grossCollectedMinor"
     OR NEW."netRealizedCadMinor" IS DISTINCT FROM OLD."netRealizedCadMinor"
     OR NEW."paymentProofStorageKey" IS DISTINCT FROM OLD."paymentProofStorageKey" THEN
    RAISE EXCEPTION 'Immutable financial columns on SaleTransaction cannot be modified after creation.';
  END IF;
  -- If transaction is voided/reversed, automatically release active lock on child line items
  IF NEW."isVoidedOrReversed" = true AND OLD."isVoidedOrReversed" = false THEN
    UPDATE "salvage"."SaleTransactionPartItem" SET "isActiveSale" = false WHERE "saleTransactionId" = NEW."id";
    UPDATE "salvage"."SaleTransactionVehicleItem" SET "isActiveSale" = false WHERE "saleTransactionId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lock_sale_tx_immutable_cols BEFORE UPDATE ON "salvage"."SaleTransaction"
  FOR EACH ROW EXECUTE FUNCTION prevent_sale_tx_financial_mutation();

-- 5. Enforce DomesticSaleChannel vs ExportSaleChannel by marketNode
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT sale_channel_node_integrity CHECK (
  ("marketNode" = 'DOMESTIC_ORIGIN' AND "domesticChannel" IS NOT NULL AND "exportChannel" IS NULL)
  OR
  ("marketNode" = 'DESTINATION_EXPORT_VAULT' AND "exportChannel" IS NOT NULL AND "domesticChannel" IS NULL)
);

-- 6. Enforce Bill of Sale upload on Retail Lot Whole-Vehicle Sales
ALTER TABLE "salvage"."SaleTransaction" ADD CONSTRAINT retail_lot_vehicle_bill_of_sale_required CHECK (
  "domesticChannel" != 'RETAIL_LOT_VEHICLE_SALE'
  OR ("billOfSaleStorageKey" IS NOT NULL AND length(trim("billOfSaleStorageKey")) > 0)
);

-- 7. Enforce exclusive target on CustodyEvent (exactly one of partId, vehicleId, or cannabisLotId),
--    and XOR target (Part vs. Vehicle) on B2BReservation & CycleCountTask
ALTER TABLE "shared"."CustodyEvent" ADD CONSTRAINT custody_event_target_xor CHECK (
  num_nonnulls("partId", "vehicleId", "cannabisLotId") = 1
);

ALTER TABLE "salvage"."B2BReservation" ADD CONSTRAINT b2b_reservation_target_xor CHECK (
  ("partId" IS NOT NULL AND "vehicleId" IS NULL) OR ("partId" IS NULL AND "vehicleId" IS NOT NULL)
);

ALTER TABLE "salvage"."CycleCountTask" ADD CONSTRAINT cycle_count_target_xor CHECK (
  ("partId" IS NOT NULL AND "vehicleId" IS NULL) OR ("partId" IS NULL AND "vehicleId" IS NOT NULL)
);

-- 8. Prevent overlapping active B2B holds and active sales on the same Part or Vehicle
CREATE UNIQUE INDEX unique_active_part_reservation ON "salvage"."B2BReservation" ("partId") WHERE "isActive" = true AND "partId" IS NOT NULL;
CREATE UNIQUE INDEX unique_active_vehicle_reservation ON "salvage"."B2BReservation" ("vehicleId") WHERE "isActive" = true AND "vehicleId" IS NOT NULL;
CREATE UNIQUE INDEX unique_active_sold_part ON "salvage"."SaleTransactionPartItem" ("partId") WHERE "isActiveSale" = true;
CREATE UNIQUE INDEX unique_active_sold_vehicle ON "salvage"."SaleTransactionVehicleItem" ("vehicleId") WHERE "isActiveSale" = true;

-- 9. Enforce Health Canada Dual-Witness Destruction & Non-Empty Evidence Photo on cannabis.CannabisDestructionLog
ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT cannabis_destruction_two_distinct_witnesses
  CHECK ("primaryUserId" != "witnessUserId");

ALTER TABLE "cannabis"."CannabisDestructionLog" ADD CONSTRAINT cannabis_destruction_photo_non_empty
  CHECK (length(trim("evidencePhotoStorageKey")) > 0);

-- 10. Enforce Gram-Accurate Mass-Balance Reconciliation on cannabis.CannabisLotTransformation
ALTER TABLE "cannabis"."CannabisLotTransformation" ADD CONSTRAINT cannabis_mass_balance_reconciliation
  CHECK (
    "inputWeightGrams" > 0
    AND "outputWeightGrams" >= 0
    AND "moistureLossGrams" >= 0
    AND "wasteDestroyedGrams" >= 0
    AND ("outputWeightGrams" + "moistureLossGrams" + "wasteDestroyedGrams" + "unaccountedVarianceGrams") = "inputWeightGrams"
  );

-- 11. Multi-Tenant Supabase Row-Level Security (RLS) Organization Isolation on shared.* & cannabis.* tables
ALTER TABLE "shared"."StorageLocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."Expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."CashCustodyTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."CustodyEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisStrain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisLot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cannabis"."CannabisDestructionLog" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_storage_location ON "shared"."StorageLocation"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_expense ON "shared"."Expense"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_cash_transfer ON "shared"."CashCustodyTransfer"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_custody_event ON "shared"."CustodyEvent"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_audit_log ON "shared"."AuditLog"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_cannabis_strain ON "cannabis"."CannabisStrain"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_cannabis_lot ON "cannabis"."CannabisLot"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
CREATE POLICY tenant_isolation_cannabis_destruction ON "cannabis"."CannabisDestructionLog"
  USING ("organizationId" = (auth.jwt() ->> 'organization_id')::uuid);
```

## 5. Deterministic State Machines & Concurrency Protocols

### 5.1 Anti-Double-Sale Delist Sync (Domestic/eBay) & Pre-Paid Export Lock

An external HTTP request to eBay cannot run inside a PostgreSQL transaction. To prevent double-selling across local Ottawa cash checkouts (`DOMESTIC_ORIGIN`), eBay Motors (`EBAY_MOTORS_SHIPPED`), local classifieds (`FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`), and pre-paid export pallets, the system enforces deterministic state transitions across `ebaySyncState`, `classifiedsSyncState`, `custodyState`, and `availabilityState`:

```text
[ebaySyncState: SYNDICATED_LIVE] ◄── (Phase 1A: Exported via eBay Bulk CSV / Phase 2A: eBay Inventory API)
           │
           ├──► (Path A: Sold at Domestic Checkout — FR-CHK-01)
           │       ├── Sets custodyState = SOLD_AND_RELEASED, availabilityState = PAID_SETTLED
           │       ├── Sets ebaySyncState = DELIST_PENDING & emits OutboxEvent(PartSoldLocallyDelistEbayRequested)
           │       ├── If classifiedsSyncState == POSTED_LIVE -> sets classifiedsSyncState = DELIST_REQUIRED
           │       └── Phase 1A Urgent Delist Banner / Phase 2A BullMQ eBay API 200 OK -> [DELISTED]
           │
           └──► (Path B: Scanned onto Pre-Paid Export Pallet — FR-LOG-01 + RULE-EXP-001)
                   ▼
          [EXPORT_LOCK_PENDING]  ───(Phase 2A+: Writes OutboxEvent in same DB TX)──► BullMQ Worker calls eBay API
                   │             ───(Phase 1B: Supervisor manual delist check)       (bulkUpdatePriceQuantity = 0)
                   ├──────────────────────┬──────────────────────────────────────┘
                   │                      │
                   ▼ (eBay 200 OK /       ▼ (eBay Order Webhook arrived first!)
                      Manual Confirm)
        [EXPORT_LOCK_CONFIRMED]   [availabilityState: COMMITTED_DOMESTIC_SALE]
                   │                      │
                   ▼                      ▼
        [custodyState: ON_EXPORT_PALLET] (Pushes Alert to Yard PWA: "PULL PART FROM PALLET — SOLD ON EBAY")
```

* **Pre-Paid Origin Export Gate (`RULE-EXP-001`):** When `exportPolicy.exportFulfillmentMode == 'PREPAID_ORIGIN_ONLY'` (the default while no family-operated destination vault is active), `ShipmentPallet.sealedAt` and `Shipment.departedAt` CANNOT be populated unless 100% of items on the shipment have verified upfront CAD/USD payment settled in `SETTLED_ORIGIN_CORP_BANK` (or an explicit `ARCHITECT_CFO` verified-deposit override), eliminating overseas consignment credit risk.
* **Physical Seal Gate Rule:** `ShipmentPallet.sealedAt` CANNOT be populated if any child `Part` on that pallet has `ebaySyncState == 'EXPORT_LOCK_PENDING'` or `custodyState == 'STRIPPED_RAW_OFFLINE'`. All parts must reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED` / `DELISTED`) before a pallet can be sealed.
* **Online vs. Offline Initial `PartCustodyState` Assignment:** During 3-tap part intake (`FR-INT-02`), if the worker scans both the part QR (`PRT-XXXXXX`) and a valid destination storage bin QR (`toLocationBarcode`, e.g., `KEMP-C01-R01-S01-B01`) while online (or upon server sync of the intake + bin scan), `Part.custodyState` transitions immediately to `SHELVED_ORIGIN_CONTAINER` (and `storageLocationId` is populated). `STRIPPED_RAW_OFFLINE` is strictly a transient state for parts captured without a destination bin scan or queued locally in IndexedDB awaiting server reconciliation.

### 5.2 Offline Custody Chain, Data-Driven Site Zoning Guard & Conflict Resolution

1. **No Silent Overwrites:** When an offline yard or nursery worker scans a part, whole asset, or cannabis lot into a storage bin, grow table, or pallet, the PWA appends a `CustodyEvent` containing `expectedVersion`, `organizationId`, and a client UUIDv7 `idempotencyKey`.
2. **Data-Driven Site Zoning & Capacity Enforcement (`RULE-ZONE-001`):** Every location scan verifies that `StorageLocation.organizationId` and `StorageLocation.allowedOrgType` match the scanned item's organization (`SALVAGE_AND_EXPORT` vs. `CANNABIS_NURSERY_AND_PROCESSING`) and enforces `StorageLocation.maxActiveAssetCapacity` (seeded to `4` for the Kemptville Dismantling Pad, `8` for the Ramsayville Retail Lot, and `null` for standard shelf bins). Cross-tenant or cross-zone scans are rejected with HTTP `422 Unprocessable Entity` (`SITE_ZONING_VIOLATION`).
3. **Server Reconciliation:** Upon sync, if `version == expectedVersion`, the server updates `storageLocationId` and increments `version`. If the version has diverged (e.g., another worker moved the item or it sold online while the device was offline), the server still records the `CustodyEvent` with `hasConflict = true` and surfaces a supervisor exception rather than silently dropping or overwriting the location.

### 5.3 Adaptive Checkout, Cash Custody, Blind Cycle Counts & Destination Gate Release Protocol

The unified mobile checkout workflow (`/checkout`) adapts dynamically based on the scanned item's custody location (`marketNode`):

1. **Domestic Origin Mode (`marketNode == 'DOMESTIC_ORIGIN'` — Primary Phase 1A Active Node):**
   * **Context & Channel Attribution:** Triggered when `HUNTER_MECHANIC` or `ARCHITECT_CFO` scans a `PRT-XXXXXX` part or `AST-XXXXXX` whole vehicle located in Ontario (`KEMP` or `RAMS`). The UI defaults to `CAD` and presents `DomesticSaleChannel` selector pills (`LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `WHOLESALE_MECHANIC_NETWORK`, `EBAY_MOTORS_SHIPPED`, `CAR_PART_WHOLESALE`).
   * **Ontario 3-Tier Price Floor & 10% Negotiation Corridor:** Evaluates `grossCollectedMinor` against `retailPriceCadMinor` (`floorPriceAtCheckoutMinor`): discounts up to `domesticAdminDiscountToleranceBps = 1000` ($10\%$) are permitted for `HUNTER_MECHANIC` with a mandatory `discountReasonCode`; discounts $> 10\%$ require `ARCHITECT_CFO` or a CFO override (`FLOOR_PRICE_OVERRIDE_REQUIRED`).
   * **Immediate eBay & Local Classifieds Delist Sync:** Atomically transitions sold parts to `custodyState = 'SOLD_AND_RELEASED'` and `availabilityState = 'PAID_SETTLED'`. If `ebaySyncState == 'SYNDICATED_LIVE'`, transitions `ebaySyncState` to `'DELIST_PENDING'` and writes an `OutboxEvent` (`PartSoldLocallyDelistEbayRequested`) to immediately zero out the eBay Motors offer (via Urgent Delist Banner in Phase 1A and automated BullMQ eBay API worker in Phase 2A). If `classifiedsSyncState == 'POSTED_LIVE'`, transitions `classifiedsSyncState` to `'DELIST_REQUIRED'` so local FB/Kijiji ads are removed without delay.
   * **Operator Float & Cash Custody Tracking:** Cash collected in person sets `cashCustodyState = 'HELD_IN_OPERATOR_FLOAT'`, creating an auditable shop petty-cash float that can be drawn down when logging shop `Expense` receipts (`paidFromCashCustody = 'HELD_IN_OPERATOR_FLOAT'`) or offset against partner profit draws (`RULE-PAY-003`). Interac e-Transfers, wires, and eBay Managed Payouts default to `SETTLED_ORIGIN_CORP_BANK`.
   * **Whole-Vehicle Lot Release & Self-Funding Working Capital Credit:** Whole-vehicle retail sales (`RETAIL_LOT_VEHICLE_SALE`) enforce uploading a signed Bill of Sale (`billOfSaleStorageKey`), transition the `Vehicle` to `lifecycleState = 'SOLD_RETAIL_ONTARIO'` and `availabilityState = 'PAID_SETTLED'` (freeing 1 of the 8 Ramsayville shop lot slots, and flagging `classifiedsSyncState = 'DELIST_REQUIRED'` if posted), and credit `netRealizedCadMinor` (`grossCollectedMinor - platformFeeMinor - shippingCostMinor`) toward the donor VIN's Break-Even Velocity counter and the **Self-Funding Working Capital Pool** (`AvailableWorkingCapital_CAD`). Because there is no separate warehouse security gate in Ontario, `isPaymentVerified` is set to `true` and `gateReleasedAt = now()` upon receipt upload.
2. **Destination Export Vault Mode (`marketNode == 'DESTINATION_EXPORT_VAULT'` — Schema-Ready / Dormant Until Phase 3 Overseas Vault Activation):**
   * **Strict Separation of Duties & MFA `aal2` Enforcement:** Users with `HUNTER_MECHANIC` or `OVERSEAS_B2B_BUYER` roles are hard-blocked at the API and RLS layers from mutating `SaleTransaction.isPaymentVerified` when `marketNode == 'DESTINATION_EXPORT_VAULT'`. Only `TRINIDAD_VAULT_ADMIN` or `ARCHITECT_CFO` holding an active Supabase Auth JWT with Authenticator Assurance Level 2 (`aal2`) can verify payment.
   * **3-Tier Price Floor Evaluation & Negotiation Corridor (`checkoutPolicy`):**
     1. **Tier 1 (At or Above Floor):** `grossCollectedMinor >= floorPriceAtCheckoutMinor` $\rightarrow$ Passes automatically (`discountReasonCode = null`).
     2. **Tier 2 (Within Admin Negotiation Corridor):** Discount is $\le \min(\text{vaultAdminMaxDiscountCapTtdMinor}, \max(\text{vaultAdminSmallRoundingAllowanceTtdMinor}, \text{floorPriceAtCheckoutMinor} \times 0.08))$ $\rightarrow$ Permitted for `TRINIDAD_VAULT_ADMIN` (or `HUNTER_MECHANIC` in Ontario under `domesticAdminDiscountToleranceBps`) **if and only if** a valid `discountReasonCode` (`"CASH_ROUNDING" | "BUNDLE_DISCOUNT" | "TRANSIT_OR_SHOP_DAMAGE" | "AGED_INVENTORY_CLEARANCE"`) is selected.
     3. **Tier 3 (Beyond Admin Corridor — Hard Lock / CFO Override Required):** Discount exceeds the Admin Corridor $\rightarrow$ Throws `FLOOR_PRICE_OVERRIDE_REQUIRED` unless `actorRole === 'ARCHITECT_CFO'` or a valid `cfoOverrideApprovedById` + `cfoOverrideReasonNote` is supplied.
   * **Broker Commission Counter Netting (`isBrokerCommissionDeductedAtCounter`):** When `isBrokerCommissionDeductedAtCounter == true`, the system records that the broker retained their commission directly from the cash handed over at the counter, so the physical cash added to `HELD_IN_DESTINATION_VAULT` is `grossCollectedMinor - brokerCommissionMinor`, keeping physical vault safe cash 100% accurate.
   * **Encrypted FIU Customer Due Diligence (CDD) Storage:** When a single or linked transaction totals $\ge \text{TT\$50,000}$, the checkout requires uploading a private photo/scan of the buyer's government ID (`buyerIdDocumentStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) and storing the AES-256-GCM application-encrypted ID type and number (`buyerIdNumberEncrypted`) so records can be produced during a statutory Trinidad FIU audit.
   * **Phased Gate Release vs. Weekly Blind Cycle Counts:**
     * **Phase 1 & 2 (Atomic Checkout Release + Weekly Blind Cycle Counts):** While the Vault counter and exit gate are operated by the same team, verifying payment (passing the 3-Tier Price Floor check) and uploading payment proof atomically stamps `isPaymentVerified = true`, `gateReleasedAt = now()`, and transitions child parts to `custodyState = 'SOLD_AND_RELEASED'` (and whole assets to `lifecycleState = 'SOLD_EXPORT_COD'`). Physical shrinkage and off-book cash sales are policed via **Weekly Blind Cycle Counts (`CycleCountTask`)** (sampling up to 10 random `SHELVED_DESTINATION_VAULT` items per week requiring a physical shelf QR scan + live timestamped photo) reconciled against TTD bank deposit slips.
     * **Phase 3+ (Two-Step HMAC-SHA256 Gate Token):** Once dedicated exit gate guards are staffed separately from the payment desk, payment verification issues a single-use HMAC-SHA256 QR token (`gateTokenNonce`, valid for 4 hours), and scanning the token at the exit door atomically stamps `gateReleasedAt = now()` (returning HTTP `410 Gone` on replay).

### 5.4 Cannabis Mass-Balance Transformation & Dual-Witness Destruction Protocol

1. **Gram-Accurate Mass-Balance Transformation (`CannabisLotTransformation`):**
   * Every curing (`FRESH_HARVEST` $\rightarrow$ `DRIED_FLOWER` / `TRIM_BIOMASS`) or extraction/refinement (`DRIED_FLOWER` / `TRIM_BIOMASS` $\rightarrow$ `CRUDE_EXTRACT` $\rightarrow$ `DISTILLATE_OR_ISOLATE`) run must satisfy the strict conservation-of-mass identity at the PostgreSQL `CHECK` constraint layer:
     $$\text{InputWeight}_{\text{g}} = \text{OutputWeight}_{\text{g}} + \text{MoistureLoss}_{\text{g}} + \text{WasteDestroyed}_{\text{g}} + \text{UnaccountedVariance}_{\text{g}}$$
   * If $|\text{UnaccountedVariance}_{\text{g}}| / \text{InputWeight}_{\text{g}} > 2.0\%$ (`RULE-CAN-001`), the transaction atomically flags `varianceAlertFlagged = true`, sets `CannabisLot.complianceHold = true` on the target lot, and emits an `OutboxEvent` (`CannabisVarianceAlert`) requiring `CANNABIS_QAP_COMPLIANCE` sign-off (`verifiedByQapUserId`) before the lot can be moved or packaged.
2. **Dual-Witness Destruction (`CannabisDestructionLog`):**
   * Any plant cull or processing waste destruction (`wasteDestroyedGrams > 0` or `plantsDestroyedCount > 0`) requires an immutable `CannabisDestructionLog` entry containing a private timestamped photo (`evidencePhotoStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) and two distinct authenticated user signatures (`primaryUserId != witnessUserId`), where at least one witness holds `CANNABIS_QAP_COMPLIANCE` or `ARCHITECT_CFO` authority.

### 5.5 3-Rule Compensation & Piece-Rate Payout Protocol (`RULE-PAY-001` to `RULE-PAY-003`)

To prevent working-capital bleed on unsupervised yard labor and partner draws, `src/modules/cfo-subledger` enforces three domain guards before committing compensation `Expense` records:

1. **Piece-Rate Yard Stripper Payout Gate (`RULE-PAY-001` — `category == 'YARD_STRIPPER_PIECE_RATE'`):**
   * Unskilled rural yard labor is paid per completed vehicle rather than hourly. Logging a `YARD_STRIPPER_PIECE_RATE` expense requires a linked `vehicleId` (enforced by SQL `CHECK` constraint `piece_rate_requires_donor_vehicle`), `Vehicle.fluidsDrainedAt != null`, and at least `minShelvedPartsForStripPayout` (default `35` for `AUTOMOBILE`) child `Part` records bound to that `donorVehicleId` in `custodyState == 'SHELVED_ORIGIN_CONTAINER'` (with QR code, $\ge 1$ photo, and scanned container bin).
2. **Self-Funding Seed Capital Protection (`RULE-PAY-002` — `category == 'PARTNER_PROFIT_DRAW'`):**
   * Neither founder (`ARCHITECT_CFO`, `HUNTER_MECHANIC`) may draw salary from the one-time initial seed capital pool (`initialSeedCapitalCadMinor`). The domain service blocks `PARTNER_PROFIT_DRAW` if `requestedDrawCadMinor > DistributableRealizedProfitPoolCadMinor` (cumulative realized net profit across completed domestic and repatriated export sales minus unrecovered expenses and prior partner draws).
3. **Bi-Weekly Operator Float Offset (`RULE-PAY-003`):**
   * Whenever a `PARTNER_PROFIT_DRAW` is executed for `HUNTER_MECHANIC` while `RunningOperatorFloat_CAD > 0` (`HELD_IN_OPERATOR_FLOAT`), the system automatically nets the draw against the outstanding float balance first (recording the float settlement in the same transaction) so unreceipted shop cash never becomes unrecorded bonus pay.

## 6. Hexagonal Ports Specification (`src/core/ports/index.ts`)

```typescript
// src/core/ports/index.ts

export interface PricingAndCompliancePolicy {
  fxRates: {
    cadToUsdSpot: number;
    usdToTtdOfficialCustoms: number;
    usdToTtdShadowRepatriation: number;
  };
  trinidadImportTax: {
    isTrinidadEntityVatRegistered: boolean;
    defaultAutoPartsDutyRate: number;
    customsProcessingFeeRate: number;
    vatRate: number;
  };
  oceanFreight: {
    allocatedLclFreightUsdPerKg: number;
    marineInsuranceRateOfFob: number;
  };
  marginsAndCommissions: {
    targetExportMarkupOnCost: number;
    defaultBrokerCommissionRate: number;
    minBeaterNetProfitCadMinor: number;
    minRebuildNetProfitCadMinor: number;
    minPartOutRoiMultiplier: number;
  };
  domesticChannelFees: Record<string, number>;
  araGradeMultipliers: Record<string, number>;
  complianceThresholds: {
    trinidadFiuCddThresholdTtdMinor: number;
    trinidadFiuLargeCashReportTtdMinor: number;
    trinidadDepositInsuranceCapTtdMinor: number;
    trinidadDepositAlertThresholdTtdMinor: number;
    cbsaCersValueThresholdCadMinor: number;
    cbsaMarineCutoffHours: number;
  };
  operationalGates: {
    workingCapitalGate: {
      enabled: boolean;
      enforcementMode: 'HARD_BLOCK' | 'WARN_ONLY' | 'DISABLED';
      initialSeedCapitalCadMinor: number;
      minCashReserveFloorCadMinor: number;
      countPendingExportCashAsAvailable: boolean;
    };
    locationCapacityGate: {
      enforcementMode: 'HARD_BLOCK' | 'WARN_ONLY' | 'DISABLED';
    };
  };
  expensePolicy: {
    pettyCashVoucherMaxCadMinor: number;
    monthlyUnreceiptedVoucherCapCadMinor: number;
  };
  checkoutPolicy: {
    checkoutStrictnessMode: 'BONDED_VAULT_STRICT' | 'AUDIT_ENFORCED' | 'STANDARD_POS';
    vaultAdminDiscountToleranceBps: number;
    vaultAdminSmallRoundingAllowanceTtdMinor: number;
    vaultAdminMaxDiscountCapTtdMinor: number;
    domesticAdminDiscountToleranceBps: number;
  };
  exportPolicy: {
    exportFulfillmentMode: 'PREPAID_ORIGIN_ONLY' | 'BONDED_DESTINATION_VAULT_COD';
    requireFullPrepaymentBeforeShipmentSeal: boolean;
  };
  domesticSyndication: {
    publicPickupLocationLabel: string; // e.g., "Ramsayville / East Ottawa, ON" (RULE-MKT-002 Kemptville stealth)
    heavyLocalOnlyThresholdKg: number; // e.g., 15.0 (< 15kg -> eBay Motors, >= 15kg -> Local Classifieds)
    ebaySiteId: string;                // e.g., "Canada"
    ebayCurrency: 'CAD' | 'USD';
  };
  siteZoningLimits: {
    kemptvilleMaxUncrushedShellsOnPad: number;
    kemptvilleContainerCount: number;
    ramsayvilleMaxActiveShopVehicles: number;
  };
  compensationRules: {
    stripperPieceRatePerVehicleCadMinor: number;
    minShelvedPartsForStripPayout: number;
    allowFounderDrawFromSeedCapital: boolean;
    autoOffsetHunterDrawAgainstFloat: boolean;
  };
  cannabisCompliance: {
    wetToDryMoistureLossMinPct: number;
    wetToDryMoistureLossMaxPct: number;
    biomassToCrudeExtractYieldMinPct: number;
    biomassToCrudeExtractYieldMaxPct: number;
    crudeToDistillateRefinementYieldMinPct: number;
    crudeToDistillateRefinementYieldMaxPct: number;
    maxUnaccountedVarianceAlertPct: number;
  };
}

/**
 * 0. ORGANIZATION-SCOPED POLICY CONFIGURATION PORT
 * In Phase 1A, the default adapter loads and validates src/core/config/pricing-policy.json
 * with Zod, while allowing per-tenant JSON overrides via shared.Organization.policyConfigJson
 * for future Vertical SaaS tenants.
 */
export interface IPolicyConfigPort {
  getPolicyForOrg(organizationId: string): Promise<PricingAndCompliancePolicy>;
}

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
 * 3. ZERO-TYPING DOMESTIC SYNDICATION TEMPLATE PORT (PHASE 1A DAY-1 BRIDGE)
 * Deterministically generates <= 80-char SEO eBay titles, HTML descriptions, eBay Seller Hub
 * File Exchange CSV rows, and bylaw-stealth ("Ramsayville / East Ottawa, ON") local classified
 * ad payloads from decoded NHTSA VIN/HIN specs + part category + ARA condition grade.
 */
export interface ISyndicationTemplatePort {
  buildPartSyndicationCopy(input: {
    qrSkuCode: string;
    partCategoryName: string;
    oemPartNumbers: string[];
    araGrade: 'GRADE_A' | 'GRADE_B1' | 'GRADE_B2' | 'GRADE_B3' | 'GRADE_C' | 'GRADE_X';
    araDamageCode: string;
    weightKg: number;
    retailPriceCadMinor: number;
    sanitizedPublicImageUrls: string[];
    donorVehicle: {
      year: number;
      make: string;
      model: string;
      trim?: string | null;
      engineSpec?: string | null;
      vinOrHin: string;
      odometerKm?: number | null;
      engineHours?: number | null;
    };
    publicPickupLocationLabel: string;
    heavyLocalOnlyThresholdKg: number;
  }): {
    recommendedPrimaryChannel: 'EBAY_MOTORS_SHIPPED' | 'FB_MARKETPLACE_LOCAL';
    ebaySeoTitle80: string;
    ebayHtmlDescription: string;
    localClassifiedsTitle: string;
    localClassifiedsBody: string;
    publicPickupLocationLabel: string;
  };
  exportEbaySellerHubCsv(parts: Array<{
    qrSkuCode: string;
    ebaySeoTitle80: string;
    ebayHtmlDescription: string;
    partCategoryName: string;
    oemPartNumbers: string[];
    araGrade: string;
    retailPriceCadMinor: number;
    sanitizedPublicImageUrls: string[];
    make: string;
  }>): string;
}

/**
 * 4. LIVE MARKETPLACE API SYNDICATION PORT (PHASE 2A AUTOMATED EBAY API)
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
 * 5. EXTERNAL ACCOUNTING GL SYNC PORT
 * Syncs verified operational subledger transactions to QuickBooks Online / Xero.
 */
export interface IAccountingGlPort {
  postExpenseJournal(expenseId: string): Promise<{ externalGlJournalId: string }>;
  postSaleTransactionJournal(saleTransactionId: string): Promise<{ externalGlJournalId: string }>;
  postFxSettlementJournal(settlementBatchId: string): Promise<{ externalGlJournalId: string }>;
}
```
