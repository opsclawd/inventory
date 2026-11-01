# ARCHITECTURE.md — Unified Multi-Tenant Modular Monolith (Salvage Export & Cannabis Compliance ERP)

## 1. System Overview & Architectural Principles

This platform is a **Unified Multi-Tenant Domain-Driven Design (DDD) Modular Monolith** adhering to **Hexagonal Architecture (Ports & Adapters)**. It serves **two independent legal corporations operating at completely separate physical facilities** ([`ADR-0004`](./docs/adr/0004-independent-legal-entities-and-physical-site-separation.md), [`ADR-0005`](./docs/adr/0005-rls-pooler-safety-ebay-billing-agent-and-post2025-cannabis.md)). The corporations share **reusable software infrastructure only** (`shared` PostgreSQL schema and `src/modules/shared-ops`: `8.5" × 11"` 10-MIL synthetic laser QR hang-tag sheet & optional ZPL II generation, mobile camera barcode scanning, generic hierarchical `StorageLocation` custody, receipt-gated `Expense` & cash-custody abstractions, and tenant-segregated Cloudflare R2 storage adapters)—and **never** share physical warehouses, inventory ownership, bank accounts, cash floats, physical label/printer hardware, operating permits, or assumed identical shareholders, directors, employees, or licence holders:

1. **Business A — Automotive & Marine Salvage (`ORG_SALVAGE_EXPORT` — `salvage` DB schema, Independent Salvage Corporation `"Ontario Salvage OpCo Inc."`):**
   * **Node 1 (Kemptville Primary Salvage Operating Location — `KEMP` / `ZONE_CONTAINER_PAD`):** Primary Phase 1A physical operating facility in Kemptville, Ontario (`K0G 1J0`) for vehicle & watercraft acquisition, dismantling, Ontario HTA Section 60 statutory Garage & Wrecking Register intake, `O. Reg. 85/16` EASR threshold tracking (`easrRegistrationNumber`), 5-stream commodity scrap separation (`ScrapComponentLog`), 40ft container parts warehousing (`C01`–`C04`), 3-tap QR hang-tag custody (`PRT-XXXXXX` $\rightarrow$ `SHELVED_ORIGIN_CONTAINER`, plus `RESTOCKED_QC_HOLD` on buyer returns), Zero-Typing Domestic Syndication (`FR-MKT-00` — two-step eBay Seller Hub Bulk CSV with `Relationship=Compatibility` rows and true `Kemptville, ON, K0G 1J0` ship-from location, TDG hazmat parcel blocks [`tdgHazmatCode`], Ottawa/Gatineau B2B Mechanic Powertrain Sheets, and EXIF-stripped FB/Kijiji local classifieds with `"Ottawa South / Hwy 416 Corridor"` `RULE-MKT-002` pickup masking), and Ontario Domestic CAD Checkout (`FR-CHK-01` / `DOMESTIC_ORIGIN`) with channel-split 13% HST & eBay Billing Agent accounting (`RULE-TAX-HST-01`) and independent `ORG_SALVAGE_EXPORT` working-capital/float subledgers. Site-specific environmental and dismantling permissions (`O. Reg. 85/16` / `RULE-ENV-001`) are governed dynamically via configurable per-location `locationOperationalStatus`, `allowsWholeVehicleDismantling`, `maxActiveAssetCapacity`, and `complianceEnforcementMode = "WARN_ONLY"` rather than hardcoded location-name conditionals.
   * **Node 2 (Ramsayville Retail, Shop & Fulfillment Concept — `RAMS` / `ZONE_RAMSAYVILLE_SHOP`, Salvage-Only, Gated Behind `PROPOSED_INACTIVE`):** Salvage-exclusive commercial shop, DriveON 10-day re-inspection / 36-day SSC retail beater flip (`RETAIL_LOT_VEHICLE_SALE`, with `HIGH_END_REBUILD` paused in Year 1), and concrete bay/lot concept belonging **exclusively to `ORG_SALVAGE_EXPORT`**. Seeded with `locationOperationalStatus = 'PROPOSED_INACTIVE'` until Ottawa municipal zoning/licensing is verified (emitting `PROPOSED_INACTIVE_LOCATION_WARNING` in `"WARN_ONLY"` mode if selected).
   * **Node 3 (Pre-Paid Direct Export Consolidation — Salvage-Only):** LCL pallet / FCL container manifesting and broker-ready customs dossier output, governed by the **100% Pre-Paid Origin Export Gate (`RULE-EXP-001`)** prohibiting overseas consignment shipments when no destination vault is active.
   * **Node 4 (Destination Bonded Vault — `POSV` / `ZONE_TRINIDAD_VAULT`, Future/Dormant Salvage-Export Capability):** Landed check-in, B2B reservation holds, MFA `aal2` Cash-on-Delivery (COD) checkout, blind cycle counts, and FX batch settlement—belonging exclusively to `ORG_SALVAGE_EXPORT` and retained dormant in schema (`locationOperationalStatus = 'DORMANT_FUTURE'`) behind `exportPolicy.exportFulfillmentMode` for future overseas vault activation or external Vertical-SaaS tenants.
2. **Business B — Cannabis Cultivation & Processing (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` DB schema, Independent Cannabis Corporation `"Brockville Cannabis Operations Inc."`, Dormant Until Phase 2B):**
   * **Node 5 (Brockville Cannabis Cultivation & Processing Facility — `BROCK` / `ZONE_BROCKVILLE_FACILITY`):** Exclusive physical operating location in Brockville, Ontario for all planned Phase 2B licensed cannabis cultivation (`800 m²` micro-cultivation canopy limit per s. 13(1)(a)), genetics and propagation (3-tap mother-to-clone tray spawning `LOT-YYYY-XXXX`), cannabis processing (`2,400 kg` micro-processing cap + s. 21(3) unlimited on-site grown exemption; M:N `ProductionRun` + append-only `CanonicalInventoryEvent` tenth-gram / mg-THC mass-balance ledger), QAP quality assurance (s. 88.94 PCP, 60-day extract NNCP, s. 101.3 `<= 1,000 mg` THC container cap), post-2025 `SOR/2025-45` 3-stream destruction (`CULTIVATION_WASTE`, `WHOLE_PLANTS`, `OTHER_CANNABIS`), and Health Canada CTLS / CRA Form B300 reporting (`7-year` / `25-year` retention), subject to the corporation's actual Health Canada licence and authorized activities. *(Kemptville is strictly a salvage site and has zero cannabis greenhouses, nursery zones, processing rooms, or shared cannabis inventory; zero cannabis application code executes in Phase 1A.)*

### Core Architectural Invariants

1. **PostgreSQL is the Single Source of Inventory Truth:** External marketplaces (eBay) and messaging channels (WhatsApp) are asynchronous projections. External HTTP calls NEVER execute inside a PostgreSQL database transaction.
2. **Multi-Schema, `FORCE ROW LEVEL SECURITY`, `erp_app_user` & Composite-FK Tenant Firewall (`ADR-0005`):** The `shared` PostgreSQL schema is strictly a **technical multi-tenant table grouping** for reusable software abstractions—never evidence of shared corporate finances or physical operations. Because Prisma connects directly over TCP rather than PostgREST (`auth.jwt()` is `NULL` and default `postgres` table-owner connections bypass RLS), runtime database traffic over Supavisor transaction pooling (`?pgbouncer=true` on port `6543`) connects exclusively as a dedicated least-privilege role `erp_app_user` (`NOBYPASSRLS`, `plan_cache_mode = force_custom_plan`), every tenant table across `shared`, `salvage`, and `cannabis` enforces `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` evaluating `"organizationId" = shared.current_org_id()` (failing closed on `NULL`) plus composite intra-tenant foreign keys (`@@unique([organizationId, id])`), and 100% of repository queries execute inside `withTenantTransaction(prisma, ctx, fn)` using transaction-local `set_config(..., true)` (banning session-level `SET` and autocommit `set_config`).
3. **Transactional Outbox Pattern:** All cross-module side effects and external API calls are persisted as `organizationId`-scoped `OutboxEvent` records within the same ACID transaction as the domain state mutation and processed asynchronously by BullMQ workers.
4. **Strict Storage & Tenant Object-Prefix Segregation (Public vs. Private R2):** Publicly accessible commerce images (`R2_PUBLIC_MEDIA_BUCKET`) and private financial/compliance records (`R2_PRIVATE_EVIDENCE_BUCKET`) are physically segregated into separate Cloudflare R2 buckets, with all object keys namespaced under `{organizationId}/...` and presigned URL generation gated by active `OrganizationMembership` verification.
5. **Independent Operational Subledgers, Independent External General Ledgers & No-Stub Composition Gate:** This system tracks unit-level (VIN/HIN/SKU/Lot) cost basis, mass balance, cash custody, and profitability independently per `Organization` (syncing to each entity's independent QuickBooks Online / Xero tenant). Server authentication uses `@supabase/ssr` `await supabase.auth.getUser()` (banning `getSession()`) with awaited Next.js 15 `cookies()`/`headers()`, and CI enforces `! grep -rnE "not wired|TODO.*compose" src/ app/` alongside real PostgreSQL RLS integration tests running as `erp_app_user`.

---

## 2. Technical Stack Specification

* **Runtime & Application Framework:** Next.js 15+ (App Router with awaited `await cookies()` and `await headers()`), React 19, Node.js v22 LTS, TypeScript 5.x (`strict: true`), `@supabase/ssr` (`await supabase.auth.getUser()`; server-side `getSession()` prohibited).
* **Mobile Offline Client (PWA):** Workbox Service Workers, IndexedDB (`Dexie.js`, partitioned by `organizationId`) for offline mutation queues and binary image blobs, `@zxing/browser` + native `BarcodeDetector` API.
* **Local Marketplace Browser Extension (`extensions/local-marketplace-lister/`):** Manifest V3 Chrome/Chromium Extension that reads structured listing payloads and sanitized WebP images from the ERP API (`/api/marketplace/local-ad-payload/[sku]`) and autofills Facebook Marketplace and Kijiji listing forms via user-initiated DOM injection (bypassing server-side anti-bot blocks).
* **Database, Supavisor Transaction Pooling & ORM (`ADR-0005`):** PostgreSQL 16+ (Supabase) with Multi-Schema isolation (`schemas = ["shared", "salvage", "cannabis"]`), `FORCE ROW LEVEL SECURITY` across all three schemas (`"organizationId" = shared.current_org_id()`), Supavisor transaction-mode connection pooling (`DATABASE_URL` on port `6543` with `?pgbouncer=true` running as `erp_app_user` [`NOBYPASSRLS`, `plan_cache_mode = force_custom_plan`]; `DIRECT_URL` on port `5432` for Prisma DDL migrations), composite intra-tenant foreign keys (`@@unique([organizationId, id])`), and Prisma ORM (`previewFeatures = ["multiSchema"]`) wrapped exclusively via `withTenantTransaction(prisma, ctx, fn)`.
* **Queue & Background Workers:** BullMQ backed by Redis 7.x (running in standalone Node.js worker process).
* **Object Storage:** Cloudflare R2 (all keys prefixed by `{organizationId}/...`, retained minimum `7 years` general / `25 years` s. 248 adverse-reaction summaries):
  * `R2_PUBLIC_MEDIA_BUCKET`: Sanitized, EXIF-stripped WebP product photos for eBay/WhatsApp/Storefront.
  * `R2_PRIVATE_EVIDENCE_BUCKET`: Zero-public-access bucket (accessed strictly via short-lived, tenant-verified, audit-logged pre-signed URLs) for expense receipts, bank wire slips, customs docs, HTA s. 60 seller photo IDs, DriveON fail/SSC sheets, 5-stream recycler tickets, vehicle titles/Bills of Sale, customer government IDs, Health Canada Lab Certificates of Analysis (`labCoaStorageKey`), and post-2025 cannabis destruction evidence photos (`evidencePhotoStorageKey`).

---

## 3. Repository Directory Structure

```text
src/
├── core/
│   ├── domain/                    # Pure TypeScript domain calculators & 5-axis state guards
│   ├── ports/                     # Hexagonal Port Interfaces (Zero external deps)
│   ├── events/                    # Domain Event contracts & Outbox publisher
│   └── config/                    # Versioned regulatory, tariff, FX & mass-balance parameters
├── modules/
│   ├── shared-ops/                # Shared Software Core: 8.5"x11" synthetic laser QR tag sheets (+ ZPL),
│   │   ├── domain/                # camera scanner, hierarchical StorageLocation + tenant/facility isolation,
│   │   ├── application/           # org-scoped receipt-gated Expense & float ledger, R2 storage adapters
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
│   ├── cannabis-compliance/       # Dormant Phase 2B Cannabis Context: Brockville batch genealogy, M:N ProductionRun
│   │   ├── domain/                # + CanonicalInventoryEvent tenth-gram/THC ledger, SOR/2025-45 3-stream destruction,
│   │   ├── application/           # Health Canada CTLS & CRA Form B300 reporting (Zero Phase 1A application code)
│   │   └── infrastructure/
│   └── cfo-subledger/             # Financial Context: Capital gate, expenses, FX, GL sync
│       ├── domain/
│       ├── application/
│       └── infrastructure/
├── infrastructure/
│   ├── db/                        # Prisma multi-schema client, withTenantTransaction RLS wrapper, migrations
│   ├── adapters/                  # Concrete implementations of core/ports
│   └── workers/                   # BullMQ worker entrypoints
├── app/                           # Next.js 15 App Router (awaited cookies/headers, @supabase/ssr getUser, UI, API)
└── extensions/
    └── local-marketplace-lister/  # Manifest V3 Chrome Extension for 1-click FB Marketplace & Kijiji autofill
```

---

## 4. Production Database Schema (`schema.prisma`)

```prisma
// prisma/schema.prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL") // Supavisor transaction pooler (:6543?pgbouncer=true) connecting as erp_app_user (NOBYPASSRLS)
  directUrl = env("DIRECT_URL")   // Direct PostgreSQL (:5432) used strictly for Prisma DDL migrations
  schemas   = ["shared", "salvage", "cannabis"]
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

enum LocationOperationalStatus {
  ACTIVE             // Verified operational facility (e.g., KEMP_ZONE_CONTAINER_PAD & KEMP-C01..C04)
  PROPOSED_INACTIVE  // Gated until municipal zoning/licensing is verified (e.g., RAMS, BROCK Phase 1A seed)
  DORMANT_FUTURE     // Dormant future phase capability (e.g., POSV Trinidad bonded vault)

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
  DOMESTIC_ORIGIN           // Salvage Domestic Origin (Kemptville primary facility; optional Ramsayville node if verified)
  DESTINATION_EXPORT_VAULT  // Dormant/Future Salvage Export Destination Vault (Port of Spain POSV)

  @@schema("shared")
}

enum CashCustodyState {
  HELD_IN_OPERATOR_FLOAT      // Cash in Operator's hands / Shop Petty Cash Float (Origin, org-scoped)
  HELD_IN_DESTINATION_VAULT   // Cash in Destination Vault safe awaiting bank deposit (Dormant POSV)
  DEPOSITED_DESTINATION_BANK  // In Destination commercial bank awaiting FX conversion batch
  SETTLED_ORIGIN_CORP_BANK    // Interac e-Transfer / Wire / eBay Payout in Origin Corp Bank Account (org-scoped)

  @@schema("shared")
}

// Software tenant record mapped 1:1 to an independent legal corporation (distinct from physical StorageLocation sites,
// regulatory licences, and per-user OrganizationMembership authorization)
model Organization {
  id                        String           @id @default(uuid()) @db.Uuid
  slug                      String           @unique // Software tenant key: "ORG_SALVAGE_EXPORT" | "ORG_CANNABIS_NURSERY_PROC"
  name                      String           // Display workspace name
  legalEntityName           String?          // Independent corporate legal name (e.g., "Ontario Salvage OpCo Inc." vs. "Brockville Cannabis Operations Inc.")
  organizationType          OrganizationType
  policyConfigJson          Json?            // Optional per-tenant JSON policy overrides (merges over pricing-policy.json)
  craBusinessNumberBn15     String?          // Independent CRA BN15 / HST / Excise account per legal corporation
  healthCanadaLicenseNumber String?          // Populated strictly for ORG_CANNABIS_NURSERY_PROC (Brockville facility licence)
  isActive                  Boolean          @default(true)
  createdAt                 DateTime         @default(now())
  updatedAt                 DateTime         @updatedAt

  memberships                 OrganizationMembership[]
  storageLocations            StorageLocation[]
  expenses                    Expense[]
  cashCustodyTransfers        CashCustodyTransfer[]
  custodyEvents               CustodyEvent[]
  outboxEvents                OutboxEvent[]
  auditLogs                   AuditLog[]
  vehicles                    Vehicle[]
  parts                       Part[]
  scrapComponentLogs          ScrapComponentLog[]
  shipments                   Shipment[]
  shipmentPallets             ShipmentPallet[]
  preOrderWishLists           PreOrderWishList[]
  b2bReservations             B2BReservation[]
  saleTransactions            SaleTransaction[]
  saleTransactionPartItems    SaleTransactionPartItem[]
  saleTransactionVehicleItems SaleTransactionVehicleItem[]
  cycleCountTasks             CycleCountTask[]
  currencySettlements         CurrencySettlement[]
  cannabisStrains             CannabisStrain[]
  cannabisLots                CannabisLot[]
  productionRuns              ProductionRun[]
  productionRunInputs         ProductionRunInput[]
  productionRunOutputs        ProductionRunOutput[]
  cannabisDestructionLogs     CannabisDestructionLog[]
  canonicalInventoryEvents    CanonicalInventoryEvent[]

  @@schema("shared")
}

// Authentication principal only. All tenant data access and role permissions derive strictly from
// OrganizationMembership for the active organizationId (common users across corporations are never assumed).
model User {
  id                String    @id @default(uuid()) @db.Uuid
  email             String    @unique
  phoneE164         String?   @unique
  fullName          String
  role              UserRole  // Primary/fallback profile role descriptor; runtime authorization uses OrganizationMembership.role
  mfaEnrolled       Boolean   @default(false) // Required true for CFO, VAULT_ADMIN, and CANNABIS_QAP_COMPLIANCE
  commissionRateBps Int       @default(0)     // e.g., 500 = 5.00%, 1000 = 10.00%
  whatsappOptInAt   DateTime?
  whatsappWindowExp DateTime?
  isActive          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  memberships                 OrganizationMembership[]
  strippedParts               Part[]                    @relation("StrippedByUser")
  custodyEvents               CustodyEvent[]
  loggedExpenses              Expense[]                 @relation("LoggedByUser")
  recordedScrapLogs           ScrapComponentLog[]       @relation("ScrapRecordedByUser")
  salesExecuted               SaleTransaction[]         @relation("SoldByUser")
  brokeredSales               SaleTransaction[]         @relation("BrokerUser")
  verifiedSales               SaleTransaction[]         @relation("VerifiedByAdmin")
  cfoOverrideSales            SaleTransaction[]         @relation("CfoOverrideApprover")
  cashTransfersRecorded       CashCustodyTransfer[]     @relation("TransferRecordedByUser")
  cycleCountTasks             CycleCountTask[]          @relation("AssignedVaultAdmin")
  wishLists                   PreOrderWishList[]
  auditLogs                   AuditLog[]
  executedProductionRuns      ProductionRun[]           @relation("ExecutedByTech")
  verifiedProductionRuns      ProductionRun[]           @relation("VerifiedByQap")
  primaryDestructions         CannabisDestructionLog[]  @relation("PrimaryDestructionUser")
  witnessedDestructions       CannabisDestructionLog[]  @relation("WitnessDestructionUser")
  secondWitnessedDestructions CannabisDestructionLog[]  @relation("SecondWitnessDestructionUser")
  recordedCanonicalEvents     CanonicalInventoryEvent[] @relation("CanonicalEventRecordedByUser")

  @@schema("shared")
}

model OrganizationMembership {
  id                 String       @id @default(uuid()) @db.Uuid
  organizationId     String       @db.Uuid
  organization       Organization @relation(fields: [organizationId], references: [id])
  userId             String       @db.Uuid
  user               User         @relation(fields: [userId], references: [id])
  role               UserRole     // Authoritative RBAC role within this specific Organization
  isDefaultWorkspace Boolean      @default(false)
  createdAt          DateTime     @default(now())

  @@unique([organizationId, id])
  @@unique([organizationId, userId])
  @@index([userId])
  @@schema("shared")
}

model StorageLocation {
  id                            String                    @id @default(uuid()) @db.Uuid
  organizationId                String                    @db.Uuid
  organization                  Organization              @relation(fields: [organizationId], references: [id])
  allowedOrgType                OrganizationType          // Enforces RULE-ZONE-001 at data layer (SALVAGE_AND_EXPORT vs CANNABIS_NURSERY_AND_PROCESSING)
  locationOperationalStatus     LocationOperationalStatus @default(ACTIVE) // RAMS seeded as PROPOSED_INACTIVE until Ottawa zoning/licensing verified
  allowsWholeVehicleDismantling Boolean                   @default(false)  // Configurable per-location O. Reg. 85/16 RULE-ENV-001 flag
  maxActiveAssetCapacity        Int?                      // Configurable active whole-asset limit per zone (e.g., 4 on KEMP_ZONE_CONTAINER_PAD, 8 on RAMS, null for shelf bins)
  siteCode                      String                    // "KEMP" (Salvage primary), "RAMS" (Salvage-only concept, PROPOSED_INACTIVE), "POSV" (Salvage dormant export vault), "BROCK" (Cannabis facility)
  zoneCode                      String                    @default("ZONE_CONTAINER_PAD") // "ZONE_CONTAINER_PAD", "ZONE_RAMSAYVILLE_SHOP", "ZONE_TRINIDAD_VAULT", "ZONE_BROCKVILLE_FACILITY"
  containerCode                 String                    // "C01".."C04", "V01", "PROP", "EXTR"
  rackCode                      String                    // "R01".."R10"
  shelfCode                     String                    // "S01".."S05" or "T01".."T10"
  binCode                       String                    // "B01".."B20"
  fullQrBarcode                 String                    @unique // e.g., "KEMP-C01-R02-S03-B04" or "BROCK-PROP-R1-T2"
  maxWeightKg                   Decimal                   @default(150.0) @db.Decimal(6, 2)
  createdAt                     DateTime                  @default(now())

  parts          Part[]
  vehicles       Vehicle[]
  cannabisLots   CannabisLot[]

  @@unique([organizationId, id])
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
  part                Part?        @relation(fields: [organizationId, partId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  vehicleId           String?      @db.Uuid
  vehicle             Vehicle?     @relation(fields: [organizationId, vehicleId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  cannabisLotId       String?      @db.Uuid
  cannabisLot         CannabisLot? @relation(fields: [organizationId, cannabisLotId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  actorUserId         String       @db.Uuid
  actorUser           User         @relation(fields: [actorUserId], references: [id])
  idempotencyKey      String       @unique // Client UUIDv7 generated at scan time
  fromLocationBarcode String?
  toLocationBarcode   String       // Bin QR, Pallet QR, Vault Shelf QR, or Grow Table QR
  expectedVersion     Int
  hasConflict         Boolean      @default(false) // Flagged true if offline scan version mismatches server
  complianceWarnings  String[]     @default([])    // Non-blocking WARN_ONLY flags emitted on scan (COMPLIANCE_WARNING_UNDRAINED_FARM, PROPOSED_INACTIVE_LOCATION_WARNING)
  deviceTimestamp     DateTime
  serverReceivedAt    DateTime     @default(now())

  @@unique([organizationId, id])
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
  vehicle               Vehicle?             @relation(fields: [organizationId, vehicleId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  shipmentId            String?              @db.Uuid
  shipment              Shipment?            @relation(fields: [organizationId, shipmentId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  cannabisLotId         String?              @db.Uuid
  cannabisLot           CannabisLot?         @relation(fields: [organizationId, cannabisLotId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  loggedByUserId        String               @db.Uuid
  loggedByUser          User                 @relation("LoggedByUser", fields: [loggedByUserId], references: [id])

  category                      ExpenseCategory
  vendorName                    String
  description                   String
  amountOriginalMinor           Int
  currencyOriginal              CurrencyCode         @default(CAD)
  amountCadMinor                Int
  itcReceivableCadMinor         Int                  @default(0) // Recoverable 13% Ontario HST paid on VERIFIED_RECEIPT purchases (offsets hstCollectedDirect per RULE-TAX-HST-01)
  paidFromCashCustody           CashCustodyState?    // Allows deducting shop expenses directly from HELD_IN_OPERATOR_FLOAT
  isDeferredIntercompanyAccrual Boolean              @default(false) // Generic ITA s. 78(1) non-arm's-length accrued lease liability within the owning Organization's independent books; excluded from liquid cash outlay until accrualSettledAt != null
  accrualSettledAt              DateTime?            // Populated when deferred accrual is actually paid in cash
  isReversalEntry               Boolean              @default(false)
  reversesExpenseId             String?              @db.Uuid
  reversesExpense               Expense?             @relation("ExpenseReversal", fields: [organizationId, reversesExpenseId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  reversedByExpenses            Expense[]            @relation("ExpenseReversal")

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

  @@unique([organizationId, id])
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

  @@unique([organizationId, id])
  @@index([organizationId, transferredAt])
  @@index([marketNode, fromCustodyState, toCustodyState])
  @@index([commercialBankName])
  @@schema("shared")
}

// Transactional Outbox for reliable asynchronous processing via BullMQ (strictly scoped by organizationId)
model OutboxEvent {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id])
  aggregateType  String       // "Part", "Vehicle", "Shipment", "SaleTransaction", "CannabisLot", "ProductionRun"
  aggregateId    String       @db.Uuid
  eventType      String       // e.g., "PartSoldLocallyDelistEbayRequested", "PartExportLockRequested", "VaultCodVerified", "CannabisVarianceAlert"
  payloadJson    Json
  idempotencyKey String       @unique
  status         String       @default("PENDING") // "PENDING", "PROCESSING", "COMPLETED", "DEAD_LETTER"
  retryCount     Int          @default(0)
  lastError      String?
  createdAt      DateTime     @default(now())
  processedAt    DateTime?

  @@unique([organizationId, id])
  @@index([organizationId, status, createdAt])
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

  @@unique([organizationId, id])
  @@index([organizationId, createdAt])
  @@index([entityType, entityId])
  @@schema("shared")
}

// ============================================================================
// 2. SALVAGE & EXPORT SCHEMA ENUMS & MODELS (@@schema("salvage"))
// ============================================================================

enum AssetCategory {
  AUTOMOBILE
  WATERCRAFT      // Sea-Doo, Yamaha JetBoat/WaveRunner (Bypasses MTO DriveON & HTA s. 60)
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
  RESTOCKED_QC_HOLD         // Returned part locked against auto-relist until operator inspection clears part-swap fraud
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
  CSV_EXPORTED_PENDING_CONFIRMATION // Seller Hub Bulk CSV exported; awaiting ebayListingId upload confirmation
  SYNDICATED_LIVE                   // Confirmed live on eBay Motors (ebayListingId recorded or Phase 2A publishOffer 200 OK)
  DELIST_PENDING                    // Sold locally/offline; OutboxEvent emitted, awaiting quantity=0 confirmation
  DELISTED                          // Confirmed ended/zeroed on eBay Motors after domestic sale
  EXPORT_LOCK_PENDING               // Waiting for automated eBay API 200 OK (Phase 2A+) or manual delist check (Phase 1B)
  EXPORT_LOCK_CONFIRMED             // Verified zero quantity on eBay; safe to seal export pallet

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

enum TdgHazmatCode {
  NONE
  UN3268_AIRBAG             // Safety airbag inflators/modules (quarantined & blocked from eBay parcel shipping)
  UN0503_PYROTECHNIC        // Seatbelt pretensioners / pyrotechnic actuators (blocked from eBay parcel shipping)
  UN2794_WET_BATTERY        // Lead-acid wet automotive/marine batteries (local pickup only; blocked from eBay parcel shipping)
  UN3480_LITHIUM_BATTERY    // Hybrid/EV lithium-ion packs & modules (local pickup only; blocked from eBay parcel shipping)

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
  LOCAL_WALK_IN_CASH          // Direct Ottawa/Kemptville walk-in cash sale (collects 13% direct HST)
  FB_MARKETPLACE_LOCAL        // Local pickup via Facebook Marketplace listing (collects 13% direct HST)
  KIJIJI_LOCAL                // Local pickup via Kijiji ad (collects 13% direct HST)
  RETAIL_LOT_VEHICLE_SALE     // Whole beater / rebuilt car sold off retail lot (collects 13% direct HST)
  WHOLESALE_MECHANIC_NETWORK  // Direct B2B sale to Ottawa/Gatineau repair shop (collects 13% direct HST)
  EBAY_MOTORS_SHIPPED         // Shipped eBay Canada (EBAY_CA) order — eBay remits buyer GST/HST as Billing Agent; fee HST is ITC
  CAR_PART_WHOLESALE          // Direct North American salvage exchange order (collects 13% direct HST on CA buyers)

  @@schema("salvage")
}

enum ExportSaleChannel {
  DESTINATION_VAULT_COD          // Standard Destination Vault cash/wire release
  DESTINATION_PRE_ORDER_PICKUP   // Pre-sold via Mechanic Wish List / "Loading Now" tab
  SECONDARY_ISLAND_WHOLESALE     // Secondary island wholesale lane

  @@schema("salvage")
}

// HTA Section 60 Statutory Garage & Wrecking Register Enums
enum VehicleAcquisitionSource {
  LICENSED_AUCTION       // Copart / IAAI / OMVIC wholesale auction
  PRIVATE_DRIVEWAY_BUY   // Direct rural/local owner acquisition (~$800-$1,035 driveway buy)
  DEALER_WHOLESALE
  TRADE_IN

  @@schema("salvage")
}

enum StatutoryVehiclePurpose {
  WRECKING_PARTS_ONLY
  RETAIL_RESALE
  EXPORT_WHOLE

  @@schema("salvage")
}

// 5-Stream Commodity Scrap Recovery Protocol & Cat Shrinkage Tracking
enum ScrapStreamCategory {
  CATALYTIC_CONVERTER
  ALUMINUM_ALLOY_WHEELS
  COPPER_WIRING_HARNESS
  ROTORS_AND_BATTERY
  BARE_STEEL_SHELL

  @@schema("salvage")
}

enum CatalyticConverterDisposition {
  PRESENT_AT_INTAKE
  MISSING_AT_INTAKE
  LOGGED_SCRAP_SALE
  SHELVED_AS_PART

  @@schema("salvage")
}

model Vehicle {
  id                          String                        @id @default(uuid()) @db.Uuid
  organizationId              String                        @db.Uuid
  organization                Organization                  @relation(fields: [organizationId], references: [id])
  internalStockNumber         String                        @unique // e.g., "AST-2026-0001"
  assetCategory               AssetCategory                 @default(AUTOMOBILE)
  vinOrHin                    String                        @unique // 17-char VIN, 12-char HIN, or Serial#
  year                        Int
  make                        String
  model                       String
  trim                        String?
  engineSpec                  String?
  odometerKm                  Int?                          // Road odometer in km
  engineHours                 Int?                          // Watercraft / equipment operating hours
  exteriorColor               String?
  steeringSide                SteeringSideCompatibility     @default(LHD_ONLY)
  oemFitmentVerified          Boolean                       @default(false)
  roadBrand                   RoadVehicleBrand              @default(NONE)
  operationalLane             OperationalLane
  lifecycleState              AssetLifecycleState           @default(PROPOSED_DEAL)
  availabilityState           InventoryAvailabilityState    @default(AVAILABLE)
  classifiedsSyncState        ClassifiedsSyncState          @default(NOT_POSTED)
  storageLocationId           String?                       @db.Uuid
  storageLocation             StorageLocation?              @relation(fields: [organizationId, storageLocationId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)

  // Ontario HTA Section 60 Statutory Garage & Wrecking Register
  acquisitionSource           VehicleAcquisitionSource      @default(LICENSED_AUCTION)
  sellerFullName              String?
  sellerAddress               String?
  sellerPhotoIdStorageKey     String?                       // Private R2 key (R2_PRIVATE_EVIDENCE_BUCKET)
  ontarioPermitNumber         String?                       // Green-slip vehicle permit #
  declaredStatutoryPurpose    StatutoryVehiclePurpose       @default(WRECKING_PARTS_ONLY)

  // Export Physical Specs & Tariff Classification (For Whole-Unit Exports: Watercraft, Equipment, Cars)
  weightKg                    Decimal?                      @db.Decimal(8, 2)
  dimensionsCm                Json?                         // { "l": 320, "w": 125, "h": 110 }
  suggestedHsCode             String                        @default("8903.99")
  brokerVerifiedHsCode        String?

  // Capital Gate, Deal Discipline Caps & 1-Tap CFO Override Baseline (CAD Cents)
  estimatedMaxBidCadMinor     Int
  actualPurchasePriceCadMinor Int                           @default(0)
  estimatedRepairCadMinor     Int                           @default(0)
  targetGrossRealizationMinor Int                           @default(0)
  cfoGateApprovedById         String?                       @db.Uuid
  cfoGateApprovedAt           DateTime?
  cfoGateOverrideReason       String?                       // 1-Tap cfoOverride reason note for reserve floor, $3,200 donor cap, or lane pause

  // Whole-Unit Export Valuation & Trinidad Vault Pricing (Minor Units / Cents)
  wholesaleFobUsdMinor        Int?
  landedCostTtdMinor          Int?
  vaultFloorPriceTtdMinor     Int?
  brokerMarketPriceTtdMinor   Int?                          // Expected local TT selling price quoted by broker

  // Compliance & DriveON 10-Day Re-Inspection / 36-Day SSC Dossier (R2_PRIVATE_EVIDENCE_BUCKET)
  rebuildDossierJson            Json?                       // Flexible schema for Reg. 601 photos, frame bench, estimate
  driveOnInitialFailAt          DateTime?                   // Initial DriveON tablet inspection fail timestamp
  driveOnReinspectionDeadlineAt DateTime?                   // driveOnInitialFailAt + 10 calendar days (discounted punch-list re-test window)
  driveOnFailSheetStorageKey    String?                     // Private R2 key for DriveON initial fail punch-list
  driveOnSicNumber              String?
  driveOnSicPassedAt            DateTime?
  driveOnSscNumber              String?
  driveOnSscIssuedAt            DateTime?                   // Triggered upon buyer deposit to maximize 36-day window
  driveOnSscExpiresAt           DateTime?                   // driveOnSscIssuedAt + 36 calendar days (AUTOMOBILE only)
  uvipStorageKey                String?

  // Environmental, 5-Stream Scrap & Async WARN_ONLY Compliance Flags (R2_PRIVATE_EVIDENCE_BUCKET)
  refrigerantEvacCertKey        String?                     // Certified technician recovery record
  fluidsDrainedAt               DateTime?                   // Fluid depollution timestamp per O. Reg. 85/16
  steamCleanedReceiptKey        String?
  catalyticConverterDisposition CatalyticConverterDisposition @default(PRESENT_AT_INTAKE)
  scrapMetalTicketKey           String?                     // Final bare-shell weigh-scale ticket
  scrapRecoveryCadMinor         Int                         @default(0) // Rolled-up CAD cents from ScrapComponentLog streams (+ legacy hull ticket)
  scrappedClearedAt             DateTime?
  complianceWarnings            String[]                    @default([]) // Async review flags in WARN_ONLY mode (COMPLIANCE_WARNING_UNDRAINED_FARM, PROPOSED_INACTIVE_LOCATION_WARNING, MISSING_HTA_S60_DOCS, MISSING_EASR_REGISTRATION_WARNING, UNRECONCILED_CATALYTIC_CONVERTER, DRIVEON_SAFETY_CERT_WARNING)

  realizedRetailSaleCadMinor  Int?
  soldAt                      DateTime?
  version                     Int                           @default(1)
  createdAt                   DateTime                      @default(now())
  updatedAt                   DateTime                      @updatedAt

  parts                       Part[]
  scrapComponentLogs          ScrapComponentLog[]
  expenses                    Expense[]
  custodyHistory              CustodyEvent[]
  b2bReservations             B2BReservation[]
  cycleCountItems             CycleCountTask[]
  matchedWishLists            PreOrderWishList[]         @relation("MatchedVehicleWishList")
  shipmentId                  String?                    @db.Uuid
  shipment                    Shipment?                  @relation(fields: [organizationId, shipmentId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  saleTransactionItems        SaleTransactionVehicleItem[]

  @@unique([organizationId, id])
  @@index([organizationId, lifecycleState, operationalLane])
  @@index([organizationId, availabilityState])
  @@index([storageLocationId])
  @@index([make, model, year])
  @@schema("salvage")
}

model Part {
  id                         String                     @id @default(uuid()) @db.Uuid
  organizationId             String                     @db.Uuid
  organization               Organization               @relation(fields: [organizationId], references: [id])
  qrSkuCode                  String                     @unique // e.g., "PRT-884920"
  donorVehicleId             String                     @db.Uuid
  donorVehicle               Vehicle                    @relation(fields: [organizationId, donorVehicleId], references: [organizationId, id])
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
  isHazmatOrAirbag           Boolean                    @default(false) // True whenever tdgHazmatCode != NONE
  tdgHazmatCode              TdgHazmatCode              @default(NONE)  // Hard-blocks EBAY_MOTORS_SHIPPED parcel export when != NONE
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

  // Public Media Assets (R2_PUBLIC_MEDIA_BUCKET URLs — EXIF stripped, {organizationId}/... prefixed)
  rawPhotoUrls               String[]
  cleanPhotoUrls             String[]

  // Current Location & Logistics Pointers
  storageLocationId          String?                    @db.Uuid
  storageLocation            StorageLocation?           @relation(fields: [organizationId, storageLocationId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  shipmentPalletId           String?                    @db.Uuid
  shipmentPallet             ShipmentPallet?            @relation(fields: [organizationId, shipmentPalletId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)

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
  ebayListingId              String?                    @unique // Populating transitions CSV_EXPORTED_PENDING_CONFIRMATION -> SYNDICATED_LIVE
  ebayTitle                  String?                    @db.VarChar(80)
  ebayAspectsJson            Json?
  ebayCompatibilityJson      Json?
  complianceWarnings         String[]                   @default([]) // Non-blocking WARN_ONLY flags (e.g., COMPLIANCE_WARNING_UNDRAINED_FARM)
  version                    Int                        @default(1) // Authoritative concurrency counter

  strippedAt                 DateTime                   @default(now())
  updatedAt                  DateTime                   @updatedAt

  custodyHistory             CustodyEvent[]
  b2bReservations            B2BReservation[]
  cycleCountItems            CycleCountTask[]
  matchedWishLists           PreOrderWishList[]         @relation("MatchedPartWishList")
  saleTransactionItems       SaleTransactionPartItem[]

  @@unique([organizationId, id])
  @@index([organizationId, custodyState, availabilityState])
  @@index([ebaySyncState])
  @@index([complianceState])
  @@index([tdgHazmatCode])
  @@index([donorVehicleId])
  @@index([storageLocationId])
  @@index([steeringSideCompatibility])
  @@schema("salvage")
}

// 5-Stream Commodity Scrap Recovery Log (Cats, Alloy Wheels, Copper Looms, Rotors/Batteries, Bare Shell)
model ScrapComponentLog {
  id                       String              @id @default(uuid()) @db.Uuid
  organizationId           String              @db.Uuid
  organization             Organization        @relation(fields: [organizationId], references: [id])
  vehicleId                String              @db.Uuid
  vehicle                  Vehicle             @relation(fields: [organizationId, vehicleId], references: [organizationId, id])
  scrapStream              ScrapStreamCategory
  weightKg                 Decimal?            @db.Decimal(8, 2)
  payoutCadMinor           Int                 // Gross CAD cents received from metal/cat recycler
  recyclerName             String
  recyclerTicketStorageKey String              // Weigh-scale or cat payout receipt in R2_PRIVATE_EVIDENCE_BUCKET
  cashCustodyState         CashCustodyState    @default(SETTLED_ORIGIN_CORP_BANK) // Or HELD_IN_OPERATOR_FLOAT when paid in cash
  recordedByUserId         String              @db.Uuid
  recordedByUser           User                @relation("ScrapRecordedByUser", fields: [recordedByUserId], references: [id])
  createdAt                DateTime            @default(now())

  @@unique([organizationId, id])
  @@index([organizationId, createdAt])
  @@index([vehicleId, scrapStream])
  @@schema("salvage")
}

model Shipment {
  id                        String           @id @default(uuid()) @db.Uuid
  organizationId            String           @db.Uuid
  organization              Organization     @relation(fields: [organizationId], references: [id])
  shipmentCode              String           @unique // e.g., "EXP-2026-TT-001"
  mode                      String           // "LCL_PALLET", "FCL_20FT", "FCL_40FT_HC"
  originPort                String           @default("CA_MTR")
  destinationPort           String           @default("TT_POS")
  customsBrokerName         String?
  importerOfRecordName      String?
  importerTaxId             String?          // Trinidad BIR / VAT Registration Number

  // CBSA CERS Export Reporting (7-year Platform Archive Requirement, satisfying CBSA 6-year rule)
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

  @@unique([organizationId, id])
  @@index([organizationId, createdAt])
  @@schema("salvage")
}

model ShipmentPallet {
  id              String       @id @default(uuid()) @db.Uuid
  organizationId  String       @db.Uuid
  organization    Organization @relation(fields: [organizationId], references: [id])
  shipmentId      String       @db.Uuid
  shipment        Shipment     @relation(fields: [organizationId, shipmentId], references: [organizationId, id])
  palletQrCode    String       @unique // e.g., "PLT-2026-001"
  tareWeightKg    Decimal      @default(22.0) @db.Decimal(6, 2)
  grossWeightKg   Decimal      @db.Decimal(8, 2)
  dimensionsCm    Json
  sealedAt        DateTime?    // Blocked until all child Parts are in EXPORT_LOCK_CONFIRMED or non-syndicated

  parts           Part[]

  @@unique([organizationId, id])
  @@index([organizationId, shipmentId])
  @@schema("salvage")
}

model PreOrderWishList {
  id                     String                    @id @default(uuid()) @db.Uuid
  organizationId         String                    @db.Uuid
  organization           Organization              @relation(fields: [organizationId], references: [id])
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
  matchedPart            Part?                     @relation("MatchedPartWishList", fields: [organizationId, matchedPartId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  matchedVehicleId       String?                   @db.Uuid
  matchedVehicle         Vehicle?                  @relation("MatchedVehicleWishList", fields: [organizationId, matchedVehicleId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  createdAt              DateTime                  @default(now())

  @@unique([organizationId, id])
  @@index([organizationId, targetMake, targetModel, isFulfilled])
  @@index([matchedPartId])
  @@index([matchedVehicleId])
  @@schema("salvage")
}

model B2BReservation {
  id              String       @id @default(uuid()) @db.Uuid
  organizationId  String       @db.Uuid
  organization    Organization @relation(fields: [organizationId], references: [id])
  partId          String?      @db.Uuid
  part            Part?        @relation(fields: [organizationId, partId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  vehicleId       String?      @db.Uuid
  vehicle         Vehicle?     @relation(fields: [organizationId, vehicleId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  buyerPhoneE164  String
  brokerUserId    String?      @db.Uuid
  quotedTtdMinor  Int
  expiresAt       DateTime
  isActive        Boolean      @default(true)
  createdAt       DateTime     @default(now())

  @@unique([organizationId, id])
  @@index([organizationId, isActive])
  @@index([partId, isActive])
  @@index([vehicleId, isActive])
  @@schema("salvage")
}

model SaleTransaction {
  id                      String               @id @default(uuid()) @db.Uuid
  organizationId          String               @db.Uuid
  organization            Organization         @relation(fields: [organizationId], references: [id])
  receiptNumber           String               @unique // "ONT-2026-0041" or "POS-2026-0089"
  marketNode              SaleMarketNode

  // Channel Attribution (Mutually exclusive via DB CHECK constraint)
  domesticChannel         DomesticSaleChannel? // Populated when marketNode == DOMESTIC_ORIGIN
  exportChannel           ExportSaleChannel?   // Populated when marketNode == DESTINATION_EXPORT_VAULT

  taxInvoiceNumber          String?              @unique // Direct HST / VAT invoice number when seller collects output tax directly
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

  // Financial Totals & Channel-Split Ontario HST / eBay Billing Agent Accounting (Minor Units / Cents)
  paymentCurrency                     CurrencyCode         // CAD (Origin) or TTD/USD (Destination)
  floorPriceAtCheckoutMinor           Int?                 // Snapshot of item(s) floor price at moment of sale for auditability
  subtotalMinor                       Int
  discountAmountMinor                 Int                  @default(0) // max(0, floorPriceAtCheckoutMinor - subtotalMinor) in Ontario / gross in TT
  discountReasonCode                  String?              // "CASH_ROUNDING" | "BUNDLE_DISCOUNT" | "TRANSIT_OR_SHOP_DAMAGE" | "AGED_INVENTORY_CLEARANCE" | "CFO_CUSTOM_OVERRIDE"
  cfoOverrideApprovedById             String?              @db.Uuid    // Populated when discount exceeds Admin Corridor and is overridden by ARCHITECT_CFO
  cfoOverrideApprovedBy               User?                @relation("CfoOverrideApprover", fields: [cfoOverrideApprovedById], references: [id])
  cfoOverrideReasonNote               String?
  platformFeeMinor                    Int                  @default(0) // $0 for FB/Walk-In; ~13.25% pre-tax fee for EBAY_MOTORS_SHIPPED
  shippingCostMinor                   Int                  @default(0) // $0 for Local Pickup; Courier label cost for eBay
  taxOrVatMinor                       Int                  @default(0) // Direct 13% Ontario HST (0 on EBAY_MOTORS_SHIPPED under Billing Agent rule!) or 12.5% TT VAT
  buyerTaxRemittedByPlatformMinor     Int                  @default(0) // Populated on EBAY_MOTORS_SHIPPED: buyer GST/HST collected & remitted directly to CRA by eBay
  itcReceivableCadMinor               Int                  @default(0) // Populated on EBAY_MOTORS_SHIPPED: 13% HST charged by eBay ON eBay seller fees (recoverable ITC)
  grossCollectedMinor                 Int                  // subtotalMinor + taxOrVatMinor (excludes platform-remitted buyerTaxRemittedByPlatformMinor)
  netRealizedCadMinor                 Int                  // (subtotalMinor - platformFeeMinor - shippingCostMinor) in CAD; excludes CRA HST trust funds
  paymentMethod                       String               // "CASH", "INTERAC_ETRANSFER", "VERIFIED_BANK_WIRE", "EBAY_MANAGED_PAYOUT"
  cashCustodyState                    CashCustodyState
  ebayDelistAttestedAt                DateTime?            // Operator attestation of "Delist on eBay First" deep-link prompt when checking out a SYNDICATED_LIVE item locally
  complianceWarnings                  String[]             @default([]) // Non-blocking WARN_ONLY flags (e.g., DRIVEON_SAFETY_CERT_WARNING)

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
  reversesSaleTx          SaleTransaction?     @relation("SaleTxReversal", fields: [organizationId, reversesSaleTxId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  reversedBySaleTxs       SaleTransaction[]    @relation("SaleTxReversal")
  voidReason              String?

  // Accounting & FX Settlement Links
  accountingSyncStatus    AccountingSyncStatus @default(PENDING_SYNC)
  externalGlJournalId     String?
  settlementBatchId       String?              @db.Uuid
  settlementBatch         CurrencySettlement?  @relation(fields: [organizationId, settlementBatchId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  createdAt               DateTime             @default(now())

  partItems               SaleTransactionPartItem[]
  vehicleItems            SaleTransactionVehicleItem[]

  @@unique([organizationId, id])
  @@index([organizationId, createdAt])
  @@index([marketNode, domesticChannel])
  @@index([marketNode, exportChannel])
  @@index([cashCustodyState])
  @@schema("salvage")
}

model SaleTransactionPartItem {
  id                String          @id @default(uuid()) @db.Uuid
  organizationId    String          @db.Uuid
  organization      Organization    @relation(fields: [organizationId], references: [id])
  saleTransactionId String          @db.Uuid
  saleTransaction   SaleTransaction @relation(fields: [organizationId, saleTransactionId], references: [organizationId, id])
  partId            String          @db.Uuid // Active uniqueness enforced via partial index unique_active_sold_part
  part              Part            @relation(fields: [organizationId, partId], references: [organizationId, id])
  soldPriceMinor    Int
  isActiveSale      Boolean         @default(true)

  @@unique([organizationId, id])
  @@index([organizationId, partId])
  @@schema("salvage")
}

model SaleTransactionVehicleItem {
  id                String          @id @default(uuid()) @db.Uuid
  organizationId    String          @db.Uuid
  organization      Organization    @relation(fields: [organizationId], references: [id])
  saleTransactionId String          @db.Uuid
  saleTransaction   SaleTransaction @relation(fields: [organizationId, saleTransactionId], references: [organizationId, id])
  vehicleId         String          @db.Uuid // Active uniqueness enforced via partial index unique_active_sold_vehicle
  vehicle           Vehicle         @relation(fields: [organizationId, vehicleId], references: [organizationId, id])
  soldPriceMinor    Int
  isActiveSale      Boolean         @default(true)

  @@unique([organizationId, id])
  @@index([organizationId, vehicleId])
  @@schema("salvage")
}

// Weekly Blind Cycle Count task for physical Trinidad Vault audit & anti-shrinkage reconciliation
model CycleCountTask {
  id                        String       @id @default(uuid()) @db.Uuid
  organizationId            String       @db.Uuid
  organization              Organization @relation(fields: [organizationId], references: [id])
  batchCode                 String       // e.g., "CC-2026-W43"
  partId                    String?      @db.Uuid
  part                      Part?        @relation(fields: [organizationId, partId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  vehicleId                 String?      @db.Uuid
  vehicle                   Vehicle?     @relation(fields: [organizationId, vehicleId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  assignedToAdminId         String       @db.Uuid
  assignedToAdmin           User         @relation("AssignedVaultAdmin", fields: [assignedToAdminId], references: [id])
  expectedLocationBarcode   String
  scannedLocationBarcode    String?
  liveVerificationPhotoKey  String?      // Timestamped photo stored in R2_PRIVATE_EVIDENCE_BUCKET
  status                    String       @default("PENDING") // "PENDING", "VERIFIED_MATCH", "DISCREPANCY_ALERT"
  discrepancyNotes          String?
  dueAt                     DateTime
  completedAt               DateTime?
  createdAt                 DateTime     @default(now())

  @@unique([organizationId, id])
  @@index([organizationId, status, dueAt])
  @@index([batchCode])
  @@schema("salvage")
}

model CurrencySettlement {
  id                         String               @id @default(uuid()) @db.Uuid
  organizationId             String               @db.Uuid
  organization               Organization         @relation(fields: [organizationId], references: [id])
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

  @@unique([organizationId, id])
  @@index([organizationId, initiatedAt])
  @@schema("salvage")
}

// ============================================================================
// 3. DORMANT PHASE 2B CANNABIS CULTIVATION & PROCESSING SCHEMA (@@schema("cannabis"))
//    Post-2025 SOR/2025-43 & SOR/2025-45 Compliant DDL Only — Zero Phase 1A Application Code
// ============================================================================

enum CannabisLotStage {
  MOTHER_PLANT
  CLONE_TRAY
  VEGETATIVE_BATCH
  FRESH_HARVEST
  DRIED_FLOWER
  TRIM_BIOMASS
  BUBBLE_HASH_INTERMEDIATE
  LIVE_ROSIN_EXTRACT
  CRUDE_EXTRACT
  DISTILLATE_OR_ISOLATE
  PACKAGED_RETAIL_UNIT

  @@schema("cannabis")
}

enum CannabisTrackingUnit {
  PLANTS
  TENTH_GRAMS     // Exact 0.1g (0.0001 kg) integer units preventing floating-point drift on CTLS & B300
  DISCRETE_UNITS

  @@schema("cannabis")
}

enum CannabisRunType {
  DRYING_CURING
  SOLVENTLESS_ICE_WATER_HASH
  ROSIN_PRESSING
  INFUSED_PREROLL_ASSEMBLY
  PACKAGING_LABELLING

  @@schema("cannabis")
}

// Post-2025 SOR/2025-45 3-Stream Destruction Classification (ss. 43 & 229)
enum CannabisDestructionStream {
  CULTIVATION_WASTE  // Leaves, shoots, branches: 0 witnesses, 0 s. 229 records, 0 CTLS reporting
  WHOLE_PLANTS       // Whole cannabis plants: 1 employee witness (no security clearance) + plantCount only (no weight required)
  OTHER_CANNABIS     // Buds, hash, rosin, spent pucks, packaged units: 1 employee witness + pre-destruction net weight (optional 2nd witness toggle for excise-stamped goods)

  @@schema("cannabis")
}

enum CanonicalCannabisEventType {
  PROPAGATION_SPAWN
  HARVEST_INTAKE
  PRODUCTION_INPUT_CONSUME
  PRODUCTION_OUTPUT_YIELD
  PROCESS_LOSS
  DESTRUCTION_DISPOSAL
  PACKAGING_STAMPED
  QA_SAMPLE_DRAW
  INVENTORY_ADJUSTMENT

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

  @@unique([organizationId, id])
  @@unique([organizationId, name])
  @@index([organizationId])
  @@schema("cannabis")
}

model CannabisLot {
  id                      String                    @id @default(uuid()) @db.Uuid
  organizationId          String                    @db.Uuid
  organization            Organization              @relation(fields: [organizationId], references: [id])
  lotBarcode              String                    @unique // e.g., "LOT-2026-0001"
  strainId                String                    @db.Uuid
  strain                  CannabisStrain            @relation(fields: [organizationId, strainId], references: [organizationId, id])
  parentMotherLotId       String?                   @db.Uuid
  parentMotherLot         CannabisLot?              @relation("MotherToCloneLots", fields: [organizationId, parentMotherLotId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  childCloneLots          CannabisLot[]             @relation("MotherToCloneLots")

  lotStage                CannabisLotStage
  trackingUnit            CannabisTrackingUnit      @default(TENTH_GRAMS)
  discreteUnits           Int                       @default(0)  // Plant count or discrete packaged retail units
  netMassTenthGrams       BigInt                    @default(0)  // 0.1g = 0.0001 kg exact integer mass for Health Canada CTLS kg reporting
  flowerMassTenthGrams    BigInt                    @default(0)  // CRA Form B300 Flowering material mass ($1.00/g excise base)
  nonFlowerMassTenthGrams BigInt                    @default(0)  // CRA Form B300 Non-Flowering trim mass ($0.30/g excise base)
  totalThcMg              BigInt?                                // Total mg THC for CRA B300 extract excise duty & s. 101.3 <= 1,000 mg container cap
  isGrownOnSite           Boolean                   @default(true) // Tracks s. 21(3) unlimited on-site micro-processing exemption eligibility
  nncpNoticeId            String?                                // Mandatory 60-day NNCP notice ID for extracts (dried/fresh exempt under s. 244)
  storageLocationId       String?                   @db.Uuid
  storageLocation         StorageLocation?          @relation(fields: [organizationId, storageLocationId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  complianceHold          Boolean                   @default(false)
  labCoaStorageKey        String?                   // Stored in R2_PRIVATE_EVIDENCE_BUCKET
  version                 Int                       @default(1)
  createdAt               DateTime                  @default(now())
  updatedAt               DateTime                  @updatedAt

  runInputs               ProductionRunInput[]
  runOutputs              ProductionRunOutput[]
  destructionLogs         CannabisDestructionLog[]
  canonicalEvents         CanonicalInventoryEvent[]
  custodyHistory          CustodyEvent[]
  expenses                Expense[]

  @@unique([organizationId, id])
  @@index([organizationId, lotStage])
  @@index([storageLocationId])
  @@index([strainId])
  @@schema("cannabis")
}

// M:N Production Run header replacing 1:1 CannabisLotTransformation (supports multi-lot fresh-frozen wash -> multi-micron hash grades + spent puck)
model ProductionRun {
  id                              String                @id @default(uuid()) @db.Uuid
  organizationId                  String                @db.Uuid
  organization                    Organization          @relation(fields: [organizationId], references: [id])
  runNumber                       String                // e.g., "RUN-BROCK-2026-0001"
  runType                         CannabisRunType
  totalInputMassTenthGrams        BigInt
  totalOutputMassTenthGrams       BigInt
  processLossMassTenthGrams       BigInt                @default(0) // Moisture curing loss / wash screen loss
  destroyedByproductMassTenthGrams BigInt               @default(0) // Spent extraction pucks routed to OTHER_CANNABIS destruction
  unaccountedVarianceTenthGrams   BigInt                @default(0)
  variancePercentage              Decimal               @default(0.000) @db.Decimal(6, 3)
  requiresQapVarianceReview       Boolean               @default(false) // Flagged true if |unaccountedVariance| / totalInput > 2.0%
  executedByUserId                String                @db.Uuid
  executedByUser                  User                  @relation("ExecutedByTech", fields: [executedByUserId], references: [id])
  verifiedByQapUserId             String?               @db.Uuid
  verifiedByQapUser               User?                 @relation("VerifiedByQap", fields: [verifiedByQapUserId], references: [id])
  startedAt                       DateTime              @default(now())
  completedAt                     DateTime?

  inputs                          ProductionRunInput[]
  outputs                         ProductionRunOutput[]
  canonicalEvents                 CanonicalInventoryEvent[]

  @@unique([organizationId, id])
  @@unique([organizationId, runNumber])
  @@index([organizationId, startedAt])
  @@schema("cannabis")
}

model ProductionRunInput {
  id                             String        @id @default(uuid()) @db.Uuid
  organizationId                 String        @db.Uuid
  organization                   Organization  @relation(fields: [organizationId], references: [id])
  productionRunId                String        @db.Uuid
  productionRun                  ProductionRun @relation(fields: [organizationId, productionRunId], references: [organizationId, id])
  sourceLotId                    String        @db.Uuid
  sourceLot                      CannabisLot   @relation(fields: [organizationId, sourceLotId], references: [organizationId, id])
  consumedMassTenthGrams         BigInt
  consumedFlowerMassTenthGrams   BigInt        @default(0)
  consumedNonFlowerMassTenthGrams BigInt       @default(0)
  consumedDiscreteUnits          Int           @default(0)
  consumedTotalThcMg             BigInt?

  @@unique([organizationId, id])
  @@index([organizationId, productionRunId])
  @@index([organizationId, sourceLotId])
  @@schema("cannabis")
}

model ProductionRunOutput {
  id                            String        @id @default(uuid()) @db.Uuid
  organizationId                String        @db.Uuid
  organization                  Organization  @relation(fields: [organizationId], references: [id])
  productionRunId               String        @db.Uuid
  productionRun                 ProductionRun @relation(fields: [organizationId, productionRunId], references: [organizationId, id])
  outputLotId                   String        @db.Uuid
  outputLot                     CannabisLot   @relation(fields: [organizationId, outputLotId], references: [organizationId, id])
  yieldedMassTenthGrams         BigInt
  yieldedFlowerMassTenthGrams   BigInt        @default(0)
  yieldedNonFlowerMassTenthGrams BigInt       @default(0)
  yieldedDiscreteUnits          Int           @default(0)
  yieldedTotalThcMg             BigInt?

  @@unique([organizationId, id])
  @@index([organizationId, productionRunId])
  @@index([organizationId, outputLotId])
  @@schema("cannabis")
}

model CannabisDestructionLog {
  id                         String                    @id @default(uuid()) @db.Uuid
  organizationId             String                    @db.Uuid
  organization               Organization              @relation(fields: [organizationId], references: [id])
  lotId                      String                    @db.Uuid
  lot                        CannabisLot               @relation(fields: [organizationId, lotId], references: [organizationId, id])
  destructionStream          CannabisDestructionStream // CULTIVATION_WASTE | WHOLE_PLANTS | OTHER_CANNABIS (SOR/2025-45)
  destroyedNetMassTenthGrams BigInt?                   // Required > 0 for OTHER_CANNABIS; not required for WHOLE_PLANTS or CULTIVATION_WASTE
  destroyedPlantCount        Int?                      // Required > 0 for WHOLE_PLANTS
  destructionReason          String
  destructionMethod          String
  attestationStatement       String?                   // s. 229 witness attestation statement
  evidencePhotoStorageKey    String?                   // Private R2 key in R2_PRIVATE_EVIDENCE_BUCKET (required for WHOLE_PLANTS & OTHER_CANNABIS)
  primaryUserId              String                    @db.Uuid
  primaryUser                User                      @relation("PrimaryDestructionUser", fields: [primaryUserId], references: [id])
  witnessUserId              String?                   @db.Uuid // 1 employee witness required for WHOLE_PLANTS & OTHER_CANNABIS; null permitted for CULTIVATION_WASTE
  witnessUser                User?                     @relation("WitnessDestructionUser", fields: [witnessUserId], references: [id])
  secondWitnessUserId        String?                   @db.Uuid // Optional 2nd witness toggle strictly for excise-stamped goods
  secondWitnessUser          User?                     @relation("SecondWitnessDestructionUser", fields: [secondWitnessUserId], references: [id])
  destroyedAt                DateTime                  @default(now())

  canonicalEvents            CanonicalInventoryEvent[]

  @@unique([organizationId, id])
  @@index([organizationId, destroyedAt])
  @@index([lotId])
  @@schema("cannabis")
}

// Append-only double-entry mass & excise ledger powering Health Canada CTLS (kg) and CRA Form B300 ($1.00/g flower, $0.30/g trim, mg THC extracts)
model CanonicalInventoryEvent {
  id                      String                     @id @default(uuid()) @db.Uuid
  organizationId          String                     @db.Uuid
  organization            Organization               @relation(fields: [organizationId], references: [id])
  cannabisLotId           String                     @db.Uuid
  cannabisLot             CannabisLot                @relation(fields: [organizationId, cannabisLotId], references: [organizationId, id])
  productionRunId         String?                    @db.Uuid
  productionRun           ProductionRun?             @relation(fields: [organizationId, productionRunId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  destructionLogId        String?                    @db.Uuid
  destructionLog          CannabisDestructionLog?    @relation(fields: [organizationId, destructionLogId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
  eventType               CanonicalCannabisEventType
  ctlsReportingCategory   String                     // Canonical CTLS monthly bucket (e.g., "VEGETATIVE_PLANTS", "FRESH_CANNABIS", "DRIED_CANNABIS", "PURE_INTERMEDIATES", "EXTRACTS_INHALED")
  netMassTenthGrams       BigInt                     // Signed delta in 0.1g (0.0001 kg) units
  flowerMassTenthGrams    BigInt                     @default(0)
  nonFlowerMassTenthGrams BigInt                     @default(0)
  discreteUnits           Int                        @default(0)
  totalThcMg              BigInt?
  recordedByUserId        String                     @db.Uuid
  recordedByUser          User                       @relation("CanonicalEventRecordedByUser", fields: [recordedByUserId], references: [id])
  idempotencyKey          String                     @unique
  occurredAt              DateTime                   @default(now())

  @@unique([organizationId, id])
  @@index([organizationId, occurredAt])
  @@index([organizationId, ctlsReportingCategory, occurredAt])
  @@index([cannabisLotId, occurredAt])
  @@schema("cannabis")
}
```

### Mandatory Raw SQL Constraints & Multi-Tenant RLS (Applied in Prisma Migration)

Prisma does not natively express `CHECK` constraints, immutable triggers, dedicated `NOBYPASSRLS` runtime roles, or `FORCE ROW LEVEL SECURITY` policies. Because Prisma connects directly to PostgreSQL/Supavisor over TCP rather than PostgREST, `auth.jwt()` evaluates to `NULL` and default `postgres` table-owner connections bypass RLS (`ADR-0005`). The initial migration MUST include:

```sql
-- 0. Provision dedicated non-owner runtime role for Prisma + Supavisor transaction pooling (ADR-0005)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app_user') THEN
    CREATE ROLE erp_app_user LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER ROLE erp_app_user NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE erp_app_user SET plan_cache_mode = 'force_custom_plan';

GRANT USAGE ON SCHEMA "shared", "salvage", "cannabis" TO erp_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "shared", "salvage", "cannabis" TO erp_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA "shared", "salvage", "cannabis"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app_user;

-- Transaction-local context accessors (evaluate to NULL and fail closed when set_config(..., true) was not called)
CREATE OR REPLACE FUNCTION "shared"."current_org_id"() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION "shared"."current_user_id"() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION "shared"."current_role"() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_role', true), '');
$$;

GRANT EXECUTE ON FUNCTION "shared"."current_org_id"(), "shared"."current_user_id"(), "shared"."current_role"() TO erp_app_user;

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
CREATE TRIGGER lock_scrap_log_delete BEFORE UPDATE OR DELETE ON "salvage"."ScrapComponentLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_cash_transfer_delete BEFORE DELETE ON "shared"."CashCustodyTransfer" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_cannabis_destruction_log BEFORE UPDATE OR DELETE ON "cannabis"."CannabisDestructionLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_production_run_delete BEFORE DELETE ON "cannabis"."ProductionRun" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();
CREATE TRIGGER lock_canonical_inventory_event BEFORE UPDATE OR DELETE ON "cannabis"."CanonicalInventoryEvent" FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();

-- 4b. Block mutation of immutable financial columns on shared.Expense & salvage.SaleTransaction while permitting
--     attaching a receipt to a PENDING_RECEIPT_UPLOAD expense or voiding a SaleTransaction
CREATE OR REPLACE FUNCTION prevent_expense_financial_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."amountOriginalMinor" IS DISTINCT FROM OLD."amountOriginalMinor"
     OR NEW."amountCadMinor" IS DISTINCT FROM OLD."amountCadMinor"
     OR (OLD."receiptStorageKey" IS NOT NULL AND NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor")
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
     OR NEW."taxOrVatMinor" IS DISTINCT FROM OLD."taxOrVatMinor"
     OR NEW."buyerTaxRemittedByPlatformMinor" IS DISTINCT FROM OLD."buyerTaxRemittedByPlatformMinor"
     OR NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor"
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

-- 9. Enforce Post-2025 3-Stream Cannabis Destruction Rules (SOR/2025-45; Cannabis Regulations ss. 43, 229)
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

-- 10. Enforce Tenth-Gram Mass-Balance Reconciliation on Dormant M:N cannabis.ProductionRun (ADR-0005)
ALTER TABLE "cannabis"."ProductionRun" ADD CONSTRAINT cannabis_production_run_mass_balance
  CHECK (
    "totalInputMassTenthGrams" > 0
    AND "totalOutputMassTenthGrams" >= 0
    AND "processLossMassTenthGrams" >= 0
    AND "destroyedByproductMassTenthGrams" >= 0
    AND ("totalOutputMassTenthGrams" + "processLossMassTenthGrams" + "destroyedByproductMassTenthGrams" + "unaccountedVarianceTenthGrams") = "totalInputMassTenthGrams"
  );

-- 11. Fail-Closed Multi-Tenant Row-Level Security (ENABLE + FORCE ROW LEVEL SECURITY via shared.current_org_id())
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

CREATE POLICY tenant_isolation_organization ON "shared"."Organization"
  USING ("id" = "shared"."current_org_id"())
  WITH CHECK ("id" = "shared"."current_org_id"());
-- Allow authenticated login bootstrap (when current_org_id() is NULL but current_user_id() is set) to list user's own active organizations
CREATE POLICY auth_bootstrap_select_organization ON "shared"."Organization"
  FOR SELECT USING (
    "shared"."current_org_id"() IS NULL
    AND "shared"."current_user_id"() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shared"."OrganizationMembership" m
      WHERE m."organizationId" = "Organization"."id"
        AND m."userId" = "shared"."current_user_id"()
        AND m."isActive" = true
    )
  );

CREATE POLICY tenant_isolation_org_membership ON "shared"."OrganizationMembership"
  USING ("organizationId" = "shared"."current_org_id"())
  WITH CHECK ("organizationId" = "shared"."current_org_id"());
CREATE POLICY auth_bootstrap_select_membership ON "shared"."OrganizationMembership"
  FOR SELECT USING (
    "shared"."current_org_id"() IS NULL
    AND "userId" = "shared"."current_user_id"()
  );

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
```

### Transaction-Local Tenant Context Wrapper (`src/infrastructure/db/tenant-transaction.ts`)

Under Supavisor transaction pooling (`?pgbouncer=true` on port `6543`), session-level `SET` statements leak across pooled connections, while autocommit `set_config(..., true)` calls vanish before the next query executes (`ADR-0005`). Every repository read or write MUST execute inside `withTenantTransaction`:

```typescript
// src/infrastructure/db/tenant-transaction.ts
import type { Prisma, PrismaClient } from '@prisma/client';

export interface TenantExecutionContext {
  organizationId: string;
  userId: string;
  role: string;
}

export async function withTenantTransaction<T>(
  prisma: PrismaClient,
  ctx: TenantExecutionContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number }
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        SELECT
          set_config('app.current_org_id', ${ctx.organizationId}, true),
          set_config('app.current_user_id', ${ctx.userId}, true),
          set_config('app.current_role', ${ctx.role}, true)
      `;
      return fn(tx);
    },
    { maxWait: options?.maxWait ?? 5_000, timeout: options?.timeout ?? 15_000 }
  );
}
```

## 5. Deterministic State Machines & Concurrency Protocols

### 5.1 Two-Step eBay CSV Confirmation, Anti-Double-Sale Delist Sync, Return QC Hold & Pre-Paid Export Lock

An external HTTP request or manual Seller Hub CSV upload to eBay cannot run inside a PostgreSQL transaction. To prevent phantom "live" statuses, double-selling across local Ontario cash checkouts (`DOMESTIC_ORIGIN`), eBay Motors Canada (`EBAY_MOTORS_SHIPPED`), local classifieds (`FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`), hazmat shipping violations, and part-swap return fraud (`ADR-0005`), the system enforces deterministic state transitions across `ebaySyncState`, `classifiedsSyncState`, `custodyState`, and `availabilityState`:

```text
[ebaySyncState: NOT_LISTED]
           │
           ├── (Phase 1A Bulk Seller Hub CSV Export w/ Parent + Child Relationship=Compatibility Rows;
           │    tdgHazmatCode == 'NONE' required; exports true ship-from "Kemptville, ON / K0G 1J0")
           ▼
[ebaySyncState: CSV_EXPORTED_PENDING_CONFIRMATION]
           │
           ├── (Operator confirms Seller Hub upload w/ ebayListingId, OR Phase 2A API publishOffer 200 OK)
           ▼
[ebaySyncState: SYNDICATED_LIVE]
           │
           ├──► (Path A: Sold at Domestic Checkout — FR-CHK-01)
           │       ├── Prompts "Delist on eBay First" deep-link attestation (stamps SaleTransaction.ebayDelistAttestedAt)
           │       ├── Sets custodyState = SOLD_AND_RELEASED, availabilityState = PAID_SETTLED
           │       ├── Sets ebaySyncState = DELIST_PENDING & emits OutboxEvent(PartSoldLocallyDelistEbayRequested)
           │       ├── If classifiedsSyncState == POSTED_LIVE -> sets classifiedsSyncState = DELIST_REQUIRED
           │       ├── Phase 1A Urgent Delist Banner / Phase 2A BullMQ eBay API 200 OK -> [DELISTED]
           │       └── If Buyer Later Returns Part -> custodyState = [RESTOCKED_QC_HOLD] (blocks auto-relist until QC inspected)
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

* **TDG Hazmat Parcel Guard (`Part.tdgHazmatCode`):** Any part tagged with `UN3268_AIRBAG`, `UN0503_PYROTECHNIC`, `UN2794_WET_BATTERY`, or `UN3480_LITHIUM_BATTERY` is hard-blocked from eBay Seller Hub parcel CSV export and eBay API shipping syndication (`422 HAZMAT_PARCEL_SHIPPING_BLOCKED`); non-quarantined lead-acid or lithium batteries are routed strictly to local pickup (`FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `LOCAL_WALK_IN_CASH`).
* **Anti-Part-Swap Return QC Hold (`PartCustodyState.RESTOCKED_QC_HOLD`):** Buyer returns transition `SOLD_AND_RELEASED -> RESTOCKED_QC_HOLD` with `availabilityState = 'NEEDS_HUMAN_REVIEW'` and `ebaySyncState = 'DELISTED'`, preventing automatic relisting until an operator verifies original OEM/tamper markings and clears the part back to `SHELVED_ORIGIN_CONTAINER` (or `SCRAPPED_OR_DAMAGED`).
* **Pre-Paid Origin Export Gate (`RULE-EXP-001`):** When `exportPolicy.exportFulfillmentMode == 'PREPAID_ORIGIN_ONLY'` (the default while no destination vault is active), `ShipmentPallet.sealedAt` and `Shipment.departedAt` CANNOT be populated unless 100% of items on the shipment have verified upfront CAD/USD payment settled in `SETTLED_ORIGIN_CORP_BANK` (or an explicit `ARCHITECT_CFO` verified-deposit override), eliminating overseas consignment credit risk.
* **Physical Seal Gate Rule:** `ShipmentPallet.sealedAt` CANNOT be populated if any child `Part` on that pallet has `ebaySyncState == 'EXPORT_LOCK_PENDING'` or `custodyState == 'STRIPPED_RAW_OFFLINE'`. All parts must reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED` / `DELISTED`) before a pallet can be sealed.
* **Online vs. Offline Initial `PartCustodyState` Assignment:** During 3-tap part intake (`FR-INT-02`), if the worker scans both the part QR (`PRT-XXXXXX`) and a valid destination storage bin QR (`toLocationBarcode`, e.g., `KEMP-C01-R01-S01-B01`) while online (or upon server sync of the intake + bin scan), `Part.custodyState` transitions immediately to `SHELVED_ORIGIN_CONTAINER` (and `storageLocationId` is populated). `STRIPPED_RAW_OFFLINE` is strictly a transient state for parts captured without a destination bin scan or queued locally in IndexedDB awaiting server reconciliation.

### 5.2 Offline Custody Chain, Multi-Tenant Location Isolation, `PROPOSED_INACTIVE` Site Gate, `O. Reg. 85/16` EASR/Fluid Flags & `WARN_ONLY` Physical Custody Agility

1. **No Silent Overwrites:** When an offline yard or cultivation worker scans a part, whole asset, or cannabis lot into a storage bin, grow table, or pallet, the PWA appends a `CustodyEvent` containing `expectedVersion`, `organizationId`, and a client UUIDv7 `idempotencyKey`.
2. **Hard Multi-Tenant Firewall (`RULE-ZONE-001`) vs. `WARN_ONLY` Environmental/Compliance Agility (`RULE-ENV-001` / `ADR-0003` / `ADR-0004` / `ADR-0005`):**
   * **Cross-Tenant Ownership & `allowedOrgType` Firewall (Always Hard-Blocked):** Every location scan runs inside `withTenantTransaction` (`FORCE ROW LEVEL SECURITY`) and verifies `StorageLocation.organizationId == activeOrganizationId` and `StorageLocation.allowedOrgType` (`SALVAGE_AND_EXPORT` at Kemptville `KEMP` / proposed Ramsayville `RAMS` / dormant `POSV` vs. `CANNABIS_NURSERY_AND_PROCESSING` exclusively at Brockville `BROCK`). Cross-tenant or mismatched `allowedOrgType` scans are always rejected with HTTP `422 Unprocessable Entity` (`SITE_ZONING_VIOLATION`).
   * **`StorageLocation.locationOperationalStatus` Gate (`RAMS` = `PROPOSED_INACTIVE`):** Unverified sites such as `RAMS` are seeded with `locationOperationalStatus = 'PROPOSED_INACTIVE'` until municipal zoning and licensing are verified (`KEMP` is seeded `ACTIVE`; `POSV` is `DORMANT_FUTURE`). Selecting or scanning a `PROPOSED_INACTIVE` location appends `'PROPOSED_INACTIVE_LOCATION_WARNING'` in `"WARN_ONLY"` mode (and throws HTTP `422 LOCATION_PROPOSED_INACTIVE` in `"STRICT_BLOCK"` mode). `DORMANT_FUTURE` locations remain blocked until explicitly activated.
   * **Configurable Capacity Gate (`maxActiveAssetCapacity`, 1-Tap `cfoOverride`):** Enforces `StorageLocation.maxActiveAssetCapacity` (data-driven per zone; `null` on container shelf bins) according to `locationCapacityGate.enforcementMode`, accepting an audited **1-Tap `cfoOverride`** when `ARCHITECT_CFO` approves temporary overflow.
   * **Data-Driven Environmental Dismantling & `O. Reg. 85/16` EASR Threshold (`RULE-ENV-001`):**
     * Scanning a whole `AUTOMOBILE` or an undrained powertrain `Part` (`Vehicle.fluidsDrainedAt == null`) into a location where `allowsWholeVehicleDismantling == false` appends `'COMPLIANCE_WARNING_UNDRAINED_FARM'` in `"WARN_ONLY"` mode (preserving physical custody truth) or rejects with `422 ENVIRONMENTAL_ZONING_VIOLATION` in `"STRICT_BLOCK"` mode.
     * Intaking whole `AUTOMOBILE` ELV `#3+` when `complianceThresholds.easrRegistrationNumber == null` (the Ontario `O. Reg. 85/16` $> 2$ ELV threshold) appends `'MISSING_EASR_REGISTRATION_WARNING'` in `"WARN_ONLY"` mode without blocking intake (or rejects with `422 EASR_REGISTRATION_REQUIRED` in `"STRICT_BLOCK"` mode).
   * The exact same `complianceEnforcementMode` (`"WARN_ONLY"` default vs. `"STRICT_BLOCK"`) governs **HTA s. 60 Seller Docs (`MISSING_HTA_S60_DOCS`)** on `FR-INT-01`, **Catalytic Converter Reconciliation (`UNRECONCILED_CATALYTIC_CONVERTER`)** on hulk clearance, and **DriveON Safety Timer Warnings (`DRIVEON_SAFETY_CERT_WARNING`)** on domestic vehicle checkout.
3. **Server Reconciliation:** Upon sync, if `version == expectedVersion`, the server updates `storageLocationId` and increments `version`. If the version has diverged (e.g., another worker moved the item or it sold online while the device was offline), the server still records the `CustodyEvent` with `hasConflict = true` and surfaces a supervisor exception rather than silently dropping or overwriting the location.

### 5.3 Adaptive Checkout, Channel-Split Ontario HST & eBay Billing Agent Rule (`RULE-TAX-HST-01`), Cash Custody & Destination Gate Release Protocol

The unified mobile checkout workflow (`/checkout`) operates strictly within `ORG_SALVAGE_EXPORT` and adapts dynamically based on the scanned item's custody location (`marketNode`):

1. **Domestic Origin Mode (`marketNode == 'DOMESTIC_ORIGIN'` — Primary Phase 1A Active Node):**
   * **Context & Channel Attribution:** Triggered when `HUNTER_MECHANIC` or `ARCHITECT_CFO` scans a `PRT-XXXXXX` part or `AST-XXXXXX` whole vehicle located in Ontario (`KEMP`, or `RAMS` if verified active). The UI defaults to `CAD` and presents `DomesticSaleChannel` selector pills (`LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `WHOLESALE_MECHANIC_NETWORK`, `EBAY_MOTORS_SHIPPED`, `CAR_PART_WHOLESALE`).
   * **Ontario 3-Tier Price Floor & 10% Negotiation Corridor (1-Tap `cfoOverride`):** Evaluates pre-tax `subtotalMinor` against `retailPriceCadMinor` (`floorPriceAtCheckoutMinor`): discounts up to `domesticAdminDiscountToleranceBps = 1000` ($10\%$) are permitted for `HUNTER_MECHANIC` with a mandatory `discountReasonCode`; discounts $> 10\%$ require `ARCHITECT_CFO` or a 1-tap `cfoOverride` (`FLOOR_PRICE_OVERRIDE_REQUIRED`).
   * **Channel-Split Ontario 13% HST & eBay Canada Billing Agent Rule (`RULE-TAX-HST-01` / `ADR-0005`):** When `domesticTaxPolicy.isOntarioEntityHstRegistered == true` (`ORG_SALVAGE_EXPORT` default):
     * **eBay Motors Canada (`domesticChannel == 'EBAY_MOTORS_SHIPPED'`):** Under CRA's marketplace facilitator / Billing Agent election, eBay collects and remits 100% of buyer GST/HST directly to the CRA. Checkout records `buyerTaxRemittedByPlatformMinor` (e.g., `round(subtotalMinor * 0.13)` or actual platform buyer tax) strictly for audit visibility, sets corporate `taxOrVatMinor = 0` (`0` added to corporate HST trust liability), records the 13% HST charged by eBay *on eBay seller fees* (`round(platformFeeMinor * 0.13)`) in `SaleTransaction.itcReceivableCadMinor` as a recoverable Input Tax Credit, sets `grossCollectedMinor = subtotalMinor`, and computes `netRealizedCadMinor = subtotalMinor - platformFeeMinor - shippingCostMinor`.
     * **Direct & Local Classified Channels (`LOCAL_WALK_IN_CASH`, `WHOLESALE_MECHANIC_NETWORK`, `KIJIJI_LOCAL`, `FB_MARKETPLACE_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `CAR_PART_WHOLESALE`):** Collects 13% Ontario HST directly (`taxOrVatMinor = round(subtotalMinor * 0.13)`, `buyerTaxRemittedByPlatformMinor = 0`, `itcReceivableCadMinor = 0`, `grossCollectedMinor = subtotalMinor + taxOrVatMinor`, `netRealizedCadMinor = subtotalMinor - platformFeeMinor - shippingCostMinor`).
     * **Corporate Net HST Trust Liability Ring-Fencing:** Subledger calculations compute `verifiedItcReceivableCadMinor = sum(SaleTransaction.itcReceivableCadMinor) + sum(Expense.itcReceivableCadMinor where VERIFIED_RECEIPT)` and ring-fence `netHstTrustLiabilityCadMinor = max(0, hstCollectedDirectCadMinor - verifiedItcReceivableCadMinor)` out of both `AvailableWorkingCapital_CAD` and `DistributableRealizedProfitPool_CAD`.
   * **Immediate eBay Delist Attestation & Local Classifieds Delist Sync:** Atomically transitions sold parts to `custodyState = 'SOLD_AND_RELEASED'` and `availabilityState = 'PAID_SETTLED'`. If `ebaySyncState == 'SYNDICATED_LIVE'` on a local checkout, prompts a **"Delist on eBay First"** deep-link attestation (stamping `SaleTransaction.ebayDelistAttestedAt`), transitions `ebaySyncState` to `'DELIST_PENDING'`, and writes an `OutboxEvent` (`PartSoldLocallyDelistEbayRequested`). If `classifiedsSyncState == 'POSTED_LIVE'`, transitions `classifiedsSyncState` to `'DELIST_REQUIRED'` so local FB/Kijiji ads are removed without delay.
   * **Operator Float & Cash Custody Tracking:** Cash collected in person sets `cashCustodyState = 'HELD_IN_OPERATOR_FLOAT'` (scoped strictly to `ORG_SALVAGE_EXPORT`), creating an auditable petty-cash float that can be drawn down when logging `ORG_SALVAGE_EXPORT` `Expense` receipts (`paidFromCashCustody = 'HELD_IN_OPERATOR_FLOAT'`) or offset against `ORG_SALVAGE_EXPORT` profit draws (`RULE-PAY-003`). Interac e-Transfers, wires, and eBay Managed Payouts default to `SETTLED_ORIGIN_CORP_BANK`.
   * **Whole-Vehicle Lot Release, DriveON Warning Agility & Working Capital Credit:** Whole-vehicle retail sales (`RETAIL_LOT_VEHICLE_SALE`) enforce uploading a signed Bill of Sale (`billOfSaleStorageKey`), evaluate the DriveON 36-day SSC window (`DRIVEON_SAFETY_CERT_WARNING` appended in `"WARN_ONLY"` mode vs. `422 EXPIRED_OR_MISSING_SAFETY_CERT` in `"STRICT_BLOCK"` mode), transition the `Vehicle` to `lifecycleState = 'SOLD_RETAIL_ONTARIO'` and `availabilityState = 'PAID_SETTLED'` (freeing 1 active `maxActiveAssetCapacity` slot on its assigned `StorageLocation`, and flagging `classifiedsSyncState = 'DELIST_REQUIRED'` if posted), and credit `netRealizedCadMinor` toward the vehicle's Break-Even counter and `ORG_SALVAGE_EXPORT`'s **3-Tranche Self-Funding Working Capital Pool** (`AvailableWorkingCapital_CAD`). Because there is no separate warehouse security gate in Ontario, `isPaymentVerified` is set to `true` and `gateReleasedAt = now()` upon receipt upload.
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

### 5.4 Dormant Phase 2B Cannabis M:N Production Runs, Canonical Tenth-Gram Ledger & Post-2025 3-Stream Destruction (`SOR/2025-43` & `SOR/2025-45`)

> **Phase 1A Scope Boundary (`ADR-0005`):** The `cannabis.*` schema tables and SQL `CHECK` constraints are provisioned as **dormant DDL only** in Phase 1A (`Issue #1` & `Issue #2`). Zero cannabis application use cases, UI screens, or CTLS/B300 reporting engines execute in Phase 1A; all Brockville (`BROCK`) operational workflows are deferred strictly to Phase 2B.

1. **M:N Production Runs & Tenth-Gram Mass-Balance (`ProductionRun` + `CanonicalInventoryEvent`):**
   * Real curing, ice-water bubble hash washing, rosin pressing, and infused pre-roll blending combine multiple source lots into multiple output lots. `ProductionRun` (`ProductionRunInput` $\times$ `ProductionRunOutput`) enforces conservation of mass in exact `BigInt` tenth-gram (`0.1 g` = `0.0001 kg`) integer units at the PostgreSQL `CHECK` constraint layer:
     $$\text{TotalInputMass}_{0.1\text{g}} = \text{TotalOutputMass}_{0.1\text{g}} + \text{ProcessLossMass}_{0.1\text{g}} + \text{DestroyedByproductMass}_{0.1\text{g}} + \text{UnaccountedVariance}_{0.1\text{g}}$$
   * Every inventory change writes an immutable `CanonicalInventoryEvent` capturing `netMassTenthGrams`, `flowerMassTenthGrams` (CRA Form B300 Flowering `$1.00/g`), `nonFlowerMassTenthGrams` (Non-Flowering trim `$0.30/g`), `discreteUnits`, and `totalThcMg` (extract duty basis + `<= 1,000 mg` Total THC non-discrete container cap under s. 101.3).
   * In Phase 2B, if $|\text{UnaccountedVariance}_{0.1\text{g}}| / \text{TotalInputMass}_{0.1\text{g}} > 2.0\%$ (`RULE-CAN-001`), the run flags `varianceAlertFlagged = true`, sets `CannabisLot.complianceHold = true` on output lots, and requires `CANNABIS_QAP_COMPLIANCE` sign-off (`verifiedByQapUserId`).
2. **Post-2025 3-Stream Destruction (`CannabisDestructionLog` — `SOR/2025-45` / ss. 43, 229):**
   * **`CULTIVATION_WASTE`** (leaves, shoots, branches): `0` witnesses required, `0` s. 229 destruction particulars required, `0` CTLS destruction reporting required.
   * **`WHOLE_PLANTS`**: `1` employee witness (`witnessUserId != primaryUserId`, no security clearance required) + `destroyedPlantCount > 0` (no mandatory pre-destruction weight).
   * **`OTHER_CANNABIS`** (dried/fresh buds, bubble hash, live rosin, spent wash/rosin pucks, packaged units): `1` employee witness (`witnessUserId != primaryUserId`) + `destroyedNetMassTenthGrams > 0`, with `secondWitnessUserId` available as an optional tenant policy toggle (`requireSecondWitnessForExciseStampedDestruction`) for CRA excise-stamped goods.

### 5.5 3-Rule Compensation & Piece-Rate Payout Protocol (`RULE-PAY-001` to `RULE-PAY-003`)

To prevent working-capital bleed on unsupervised yard labor and partner draws, `src/modules/cfo-subledger` enforces three domain guards before committing compensation `Expense` records:

1. **Piece-Rate Yard Stripper Payout Gate (`RULE-PAY-001` — `category == 'YARD_STRIPPER_PIECE_RATE'`):**
   * Unskilled rural yard labor is paid per completed vehicle rather than hourly. Logging a `YARD_STRIPPER_PIECE_RATE` expense requires a linked `vehicleId` (enforced by SQL `CHECK` constraint `piece_rate_requires_donor_vehicle`), `Vehicle.fluidsDrainedAt != null`, and at least `minShelvedPartsForStripPayout` (default `35` for `AUTOMOBILE`) child `Part` records bound to that `donorVehicleId` in `custodyState == 'SHELVED_ORIGIN_CONTAINER'` (with QR code, $\ge 1$ photo, and scanned container bin).
2. **Self-Funding Seed Capital Protection (`RULE-PAY-002` — `category == 'PARTNER_PROFIT_DRAW'`):**
   * Neither founder (`ARCHITECT_CFO`, `HUNTER_MECHANIC`) may draw salary from the one-time initial seed capital pool (`initialSeedCapitalCadMinor`). The domain service blocks `PARTNER_PROFIT_DRAW` if `requestedDrawCadMinor > DistributableRealizedProfitPoolCadMinor` (cumulative realized net profit across completed domestic and repatriated export sales minus unrecovered expenses, `netHstTrustLiabilityCadMinor`, and prior partner draws).
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
  domesticTaxPolicy: {
    isOntarioEntityHstRegistered: boolean;
    isOntarioHstRegistered: boolean;       // Seeded true on ORG_SALVAGE_EXPORT
    isOmvicLicensed: boolean;              // Seeded false on ORG_SALVAGE_EXPORT
    ontarioHstRate: number;                // e.g., 0.13 (channel-split per RULE-TAX-HST-01: eBay Billing Agent vs. direct HST trust)
    publicPickupCityLabel: string;         // Default "Ottawa South / Hwy 416 Corridor" (restricted strictly to FB/Kijiji copy; RULE-MKT-002)
  };
  araGradeMultipliers: Record<string, number>;
  complianceThresholds: {
    trinidadFiuCddThresholdTtdMinor: number;
    trinidadFiuLargeCashReportTtdMinor: number;
    trinidadDepositInsuranceCapTtdMinor: number;
    trinidadDepositAlertThresholdTtdMinor: number;
    cbsaCersValueThresholdCadMinor: number;
    cbsaMarineCutoffHours: number;
    driveOnReinspectionWindowDays: number; // e.g., 10 calendar days
    safetyStandardsCertMaxDays: number;    // e.g., 36 calendar days
    easrRegistrationNumber: string | null; // Seeded null on ORG_SALVAGE_EXPORT; vehicle #3+ emits MISSING_EASR_REGISTRATION_WARNING in WARN_ONLY
    easrActiveElvThreshold: number;        // Ontario O. Reg. 85/16 threshold = 2 ELVs (> 2 requires EASR registration)
    minRecordRetentionYears: number;       // 7 years (satisfies 6-year CRAITA/ETA/Excise s. 206 rules)
  };
  operationalGates: {
    complianceEnforcementMode: 'WARN_ONLY' | 'STRICT_BLOCK'; // Default 'WARN_ONLY' in Phase 1A to preserve physical custody truth
    workingCapitalGate: {
      enabled: boolean;
      enforcementMode: 'HARD_BLOCK' | 'WARN_ONLY' | 'DISABLED';
      totalCommittedLoanFacilityCadMinor: number; // $44,000 CAD ($22k + $12k + $10k Senior Secured Loan)
      initialSeedCapitalCadMinor: number;         // Active Tranche 1 baseline ($22,000 CAD)
      minCashReserveFloorCadMinor: number;        // $7,500 CAD reserve floor
      countPendingExportCashAsAvailable: boolean;
      tranches: Array<{
        trancheCode: 'TRANCHE_1_LAUNCH' | 'TRANCHE_2_DAY_60' | 'TRANCHE_3_DAY_120' | string;
        principalCadMinor: number;
        unlocked: boolean;
        minShelvedSkus: number;
        minScrappedDonors: number;
        requireZeroOverdueFloatReceipts: boolean;
      }>;
    };
    dealDisciplineGate: {
      maxDonorDismantleLandedCadMinor: number; // $3,200 CAD cap per donor SUV (1-tap cfoOverride supported)
      enableHighEndRebuildLane: boolean;       // false in Year 1 to prevent $15k-$22k 90-day lockups (1-tap cfoOverride supported)
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
    publicPickupLocationLabel: string; // Default "Ottawa South / Hwy 416 Corridor" (FB Marketplace & Kijiji ONLY; RULE-MKT-002)
    ebayShipFromCity: string;          // True warehouse ship-from city on EBAY_CA: "Kemptville, ON"
    ebayShipFromPostalCode: string;    // True warehouse ship-from postal code on EBAY_CA: "K0G 1J0"
    heavyLocalOnlyThresholdKg: number; // e.g., 15.0 (< 15kg & tdgHazmatCode == 'NONE' -> eBay Motors; >= 15kg or non-quarantined battery -> Local Classifieds)
    ebaySiteId: string;                // e.g., "Canada"
    ebayCurrency: 'CAD' | 'USD';
  };
  siteZoningLimits: {
    kemptvilleMaxUncrushedShellsOnPad: number; // Default 4 (aligned with KEMP_ZONE_CONTAINER_PAD.maxActiveAssetCapacity = 4)
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
    microCultivationMaxCanopySqm: number;                  // 800 m2 post-SOR/2025-43 (s. 13(1)(a))
    microProcessingAnnualDriedEquivMaxKg: number;          // 2,400 kg/year post-SOR/2025-43 (s. 21(2)), subject to s. 21(3) on-site grown exemption
    extractNonDiscreteContainerMaxThcMg: number;           // 1,000 mg Total THC per non-discrete container (s. 101.3)
    requireSecondWitnessForExciseStampedDestruction: boolean; // Optional tenant toggle on OTHER_CANNABIS destruction
    minRecordRetentionYears: number;                       // 7 years (satisfies 6-year CRA Excise Act, 2001 s. 206)
    adverseReactionRetentionYears: number;                 // 25 years (Cannabis Regulations s. 248)
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
    tdgHazmatCode: 'NONE' | 'UN3268_AIRBAG' | 'UN0503_PYROTECHNIC' | 'UN2794_WET_BATTERY' | 'UN3480_LITHIUM_BATTERY';
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
 * File Exchange CSV rows (with true ship-from "Kemptville, ON / K0G 1J0" & parent/child
 * Relationship=Compatibility fitment rows), and bylaw-stealth ("Ottawa South / Hwy 416 Corridor")
 * local FB Marketplace / Kijiji classified ad payloads (RULE-MKT-002).
 */
export interface ISyndicationTemplatePort {
  buildPartSyndicationCopy(input: {
    qrSkuCode: string;
    partCategoryName: string;
    oemPartNumbers: string[];
    araGrade: 'GRADE_A' | 'GRADE_B1' | 'GRADE_B2' | 'GRADE_B3' | 'GRADE_C' | 'GRADE_X';
    araDamageCode: string;
    weightKg: number;
    tdgHazmatCode: 'NONE' | 'UN3268_AIRBAG' | 'UN0503_PYROTECHNIC' | 'UN2794_WET_BATTERY' | 'UN3480_LITHIUM_BATTERY';
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
    ebayShipFromCity: string;
    ebayShipFromPostalCode: string;
    heavyLocalOnlyThresholdKg: number;
  }): {
    recommendedPrimaryChannel: 'EBAY_MOTORS_SHIPPED' | 'FB_MARKETPLACE_LOCAL';
    isEbayParcelEligible: boolean;
    ebaySeoTitle80: string;
    ebayHtmlDescription: string;
    localClassifiedsTitle: string;
    localClassifiedsBody: string;
    publicPickupLocationLabel: string;
  };
  exportEbaySellerHubCsv(
    parts: Array<{
      qrSkuCode: string;
      ebaySeoTitle80: string;
      ebayHtmlDescription: string;
      partCategoryName: string;
      oemPartNumbers: string[];
      araGrade: string;
      tdgHazmatCode: 'NONE' | 'UN3268_AIRBAG' | 'UN0503_PYROTECHNIC' | 'UN2794_WET_BATTERY' | 'UN3480_LITHIUM_BATTERY';
      retailPriceCadMinor: number;
      sanitizedPublicImageUrls: string[];
      make: string;
      compatibleVehicles?: Array<{ year: number; make: string; model: string; trim?: string | null; engine?: string | null }>;
    }>,
    shipFrom?: { city: string; postalCode: string }
  ): string;
  exportB2bMechanicPowertrainSheet(items: Array<{
    qrSkuCode: string;
    year: number;
    make: string;
    model: string;
    engineSpec?: string | null;
    odometerKm?: number | null;
    partCategoryName: string;
    oemPartNumbers: string[];
    araGrade: string;
    wholesaleAskCadMinor: number;
  }>): {
    whatsappMarkdownText: string;
    csvContent: string;
  };
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

> **Additional Shared-Ops Module Ports (`src/core/ports/*.port.ts`):**
> * **`IStoragePort` (`src/core/ports/storage.port.ts`):** Enforces `R2_PUBLIC_MEDIA_BUCKET` (with mandatory `RULE-MKT-002` EXIF GPS stripping) vs. `R2_PRIVATE_EVIDENCE_BUCKET` (SHA-256 hashed private evidence accessed strictly via $\le 900\text{s}$ audit-logged presigned URLs).
> * **`ILabelTagPort` (`src/core/ports/label-tag.port.ts` — `ADR-0002` / `RULE-TAG-001`):** Generates deterministic in-memory **`8.5" × 11"` Letter PDF (`Uint8Array`) and SVG printable sheets** (`12_UP_3X4` [12 tags/sheet] and `16_UP_4X4` [16 tags/sheet, $2.125" \times 2.75"$]) for `10-MIL` matte waterproof synthetic laser cardstock—rendering $\ge 1.5" \times 1.5"$ high-contrast QR codes with $\ge 4$-module quiet zones, dashed cut guidelines, and **$15\text{mm} \times 4\text{mm}$ oval zip-tie slot-punch guides** (or `2_HOLE_RACK_CARD` dual top holes for `KEMP-C01-*` steel rack upright cards)—alongside secondary `generateZplLabel(...)` Zebra ZPL II output for external SaaS yards and future $4" \times 6"$ outbound parcel labels.
