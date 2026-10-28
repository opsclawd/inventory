# PRD.md — Functional Specification & Phased Execution Backlog

## 1. Product Scope & Operational Mandate

This Product Requirements Document (PRD) defines the functional workflows, role permissions, acceptance criteria, and phased delivery milestones for the **Unified Multi-Tenant Modular Monolith**, which powers two distinct partner-operated businesses on **80% shared physical warehouse infrastructure** (`shared` DB schema — `8.5" × 11"` 10-MIL synthetic laser QR hang-tag sheet & optional ZPL printing, mobile camera barcode scanning, hierarchical `StorageLocation` bins, receipt-gated `Expense` subledger, and private Cloudflare R2 evidence storage):

1. **Engine 1 (`ORG_SALVAGE_EXPORT` — `salvage` DB schema):** Canada-First Ontario Auto/Marine Dismantling (`KEMP`), eBay Motors & Local Classifieds Syndication, Ramsayville Vehicle Flips (`RAMS`), and 100% Pre-Paid Direct Export (with the Destination Bonded Vault `POSV` node kept schema-ready and dormant until Phase 3 / overseas facility activation).
2. **Engine 2 (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` DB schema):** Brockville JV & Kemptville Health Canada Cannabis Nursery (mother plants, clones, and genetics) and Processing ("moving the juice" / extraction & bulk lot transformation).

Following the **Canada-First Logistics Pivot** (removing overseas consignment and family-operated Trinidad storage from the immediate rollout), delivery is sequenced to maximize immediate CAD cash velocity while preserving the full multi-node Vertical-SaaS schema:
* **Phase 1A (Days 1–7 — Ontario Domestic Launch MVP):** Shared Core (`shared` schema) + Ontario Dismantling & Retail Intake (`FR-INT-01`, `FR-INT-02`), Tiered Receipt/Voucher Expense & Operator Float Subledger (`FR-EXP-01`, `FR-EXP-02`), **Zero-Typing Domestic Syndication Bridge (`FR-MKT-00` — eBay Seller Hub Bulk CSV Exporter & Bylaw-Stealth Local Classifieds Queue)**, and **Ontario Domestic Mobile Checkout (`FR-CHK-01` in `DOMESTIC_ORIGIN` CAD mode with atomic Anti-Double-Sale Delist Sync)**.
* **Phase 1B (Days 8–21 — Local Chrome Extension, Deal Analyzer & Pre-Paid Direct Export):** Manifest V3 Local FB Marketplace / Kijiji Chrome Extension (`FR-MKT-02`), "Bad Cop" Pre-Auction Deal Analyzer (`FR-DEAL-01`, `FR-DEAL-02`), and **100% Pre-Paid Direct Export Consolidation & Broker Customs Package (`FR-LOG-01`, `FR-LOG-02` gated by `RULE-EXP-001`)** for upfront-paid overseas orders (e.g., watercraft, shop equipment, or pre-sold pallets).
* **Phase 2A (Days 22–45 — Automated eBay Inventory API Sync, Offline Stripper PWA & GL Sync):** Pulled-forward **Automated eBay Inventory API + Browse API Comp Floor + Inbound Order Webhooks** (automating live `quantity = 0` delisting and pick-pull alerts), Offline-first IndexedDB (`Dexie.js`) Yard Stripper PWA, and QuickBooks Online / Xero outbound GL sync (`IAccountingGlPort`).
* **Phase 2B (Days 45–90 — Cannabis Nursery, Mass-Balance Processing & CTLS Compliance):** Cannabis Compliance Module (`cannabis` schema, `FR-CAN-01` to `FR-CAN-04`), leveraging the already-built QR scanner, 10-MIL synthetic laser QR tag sheet (& optional ZPL) generator, hierarchical location engine, and receipt-gated expense ledger as Brockville/Kemptville facility operations come online.
* **Phase 3 (Months 3–6 / Overseas Vault Expansion — Assistive AI Vision & Dormant Destination Bonded Vault Activation):** BullMQ Assistive AI Vision OCR/grading (`FR-AI-01`), plus dormant Destination Bonded Vault workflows (`FR-VLT-01` to `FR-VLT-05`: landed vault check-in, TTD landed-cost floor allocation, MFA `aal2` COD release, weekly blind cycle counts, FX repatriation ledger, Two-Step HMAC Gate Token) and the Two-Tab Live Container B2B Storefront (`FR-MKT-01`).

### 1.1 Phase 1 Operational Proof Gate & Ontario Partnership Governance

Engineering work on Phase 2 scale automation and Phase 3 overseas expansion is gated on the Ontario Domestic + eBay Motors operation clearing four operational thresholds:
1. **14–21 Day Donor Break-Even Velocity (CAD):** Stripped Ontario donor vehicles ($\sim \$2,500\text{ CAD}$ acquisition cost) recover $100\%$ of acquisition and direct strip outlay in settled CAD within **21 days** via local Ottawa major-assembly pickups (`FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `LOCAL_WALK_IN_CASH`, `WHOLESALE_MECHANIC_NETWORK` at $0\%$ fee) plus catalytic converter and hulk scrap recovery (`$400–$800 CAD`).
2. **Multi-Channel Listing & Zero Double-Sale Defects:** At least $40+$ barcoded small/light parts per stripped donor (including `LHD_ONLY` assemblies) are shelved in `KEMP-C01..C04` and uploaded via `FR-MKT-00` to eBay Motors Seller Hub (`SYNDICATED_LIVE`), maintaining **$0$ double-sale defects** between local Ottawa checkouts (`FR-CHK-01`) and eBay Motors.
3. **100% Operator Float & Receipt Reconciliation (4-Pillar Partnership Protection):** Because 100% of physical inventory and local cash buyers reside in Ontario, partner financial governance enforces: (a) CFO control of the Canadian corporate bank account & `workingCapitalGate`, (b) $100\%$ reconciliation of Taz's Operator Float (`HELD_IN_OPERATOR_FLOAT`) against private R2 receipts (`VERIFIED_RECEIPT`), capped under-$\$50$ vouchers (`PETTY_CASH_VOUCHER`), bank sweeps (`CashCustodyTransfer`), or automatic draw offsets (`RULE-PAY-003`), (c) centralized eBay Motors payouts into `SETTLED_ORIGIN_CORP_BANK`, and (d) $100\%$ standalone ERP software IP ownership.
4. **Self-Funding CAD Profit Run-Rate & Zero Consignment Exports (`RULE-EXP-001`):** Combined Ontario dismantling, eBay long-tail sales ($\$2,500\text{–}\$4,000+\text{ CAD}$/car), and Ramsayville vehicle flips (`RETAIL_LOT_VEHICLE_SALE`) demonstrate a self-funding trajectory toward **$\$12,000\text{–}\$20,000+\text{ CAD/month}$ net operating profit**, and $100\%$ of any opportunistic export shipments clear upfront CAD/USD payment (`SETTLED_ORIGIN_CORP_BANK`) prior to freight booking.

---

## 2. Sanitized Role-Based Access Control (RBAC) Matrix & Workspace Switcher

Authentication is enforced via Supabase Auth with Row-Level Security (RLS) and API route guards. Users holding `ARCHITECT_CFO`, `TRINIDAD_VAULT_ADMIN`, or `CANNABIS_QAP_COMPLIANCE` roles MUST have Multi-Factor Authentication (`mfaEnrolled = true`) enabled, and privileged financial, compliance, or gate-release mutations verify active JWT session assurance (`aal2`) via Supabase Auth (`auth.jwt()->>'aal' = 'aal2'`), not merely the `User.mfaEnrolled` boolean.

| Capability / Requirement ID | `ARCHITECT_CFO` | `HUNTER_MECHANIC` | `ONTARIO_STRIPPER` | `TRINIDAD_VAULT_ADMIN` | `OVERSEAS_B2B_BUYER` | `CANNABIS_QAP_COMPLIANCE` | `NURSERY_CULTIVATION_TECH` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **FR-DEAL-01:** Create Pre-Auction Deal Proposal | CRUD + Approve | Create / Read | No Access | No Access | No Access | No Access | No Access |
| **FR-DEAL-02:** Override Capital Gate Lock | Execute (Audited) | Denied | No Access | No Access | No Access | No Access | No Access |
| **FR-INT-01:** Intake Whole Asset (Auto / Marine / Equip) | CRUD | Create / Update | Read (Strip Queue) | Read (Exported) | No Access | No Access | No Access |
| **FR-INT-02:** Strip Part, Bind QR & Scan Bin | CRUD | Create / Relocate | Create / Relocate | No Access | No Access | No Access | No Access |
| **FR-EXP-01:** Log Expense with Private Receipt | CRUD + Reversal | Create / Read | No Access | Create (Port Fees) | No Access | Create / Read (Cannabis) | Create (Nursery Supplies) |
| **FR-EXP-02:** Execute Piece-Rate Stripper Payout & Partner Draw (`RULE-PAY-001`–`003`) | CRUD + Approve | Read Own / Float | Read Own Piece-Rate | No Access | No Access | No Access | No Access |
| **FR-LOG-01:** Scan Parts/Assets to Export Pallet | CRUD | Create / Read | Execute Scan | Read Manifest | Read ("Loading" Tab) | No Access | No Access |
| **FR-LOG-02:** Seal Pallet & Export Broker Package | CRUD + Seal | Read Packing List | No Access | Read / Download | No Access | No Access | No Access |
| **FR-CHK-01:** Execute Ontario Domestic Checkout (CAD Walk-In / FB / Kijiji / eBay / Lot) | CRUD | Execute (CAD Only) | No Access | No Access | No Access | No Access | No Access |
| **FR-MKT-00:** Export eBay Seller Hub Bulk CSV & Local Classifieds Queue | CRUD + Export CSV | Execute Local Queue / Read | No Access | No Access | No Access | No Access | No Access |
| **FR-MKT-02:** 1-Click FB Marketplace / Kijiji Copy & Chrome Extension Autofill | Execute | Execute | No Access | No Access | No Access | No Access | No Access |
| **FR-VLT-01:** Check-In Landed Shipment to Vault | CRUD | Read Status | No Access | Execute Check-In | No Access | No Access | No Access |
| **FR-VLT-02:** Create 24h B2B Part/Vehicle Reservation | CRUD | Create (Broker) | No Access | CRUD | Create (Rate-Limited) | No Access | No Access |
| **FR-VLT-03:** Verify Trinidad Vault COD Payment & Release | Execute (MFA aal2 Required) | **Denied (Hard Lock)** | No Access | **Execute (MFA aal2 Required)** | No Access | No Access | No Access |
| **FR-VLT-04:** Log Broker Commission & FX Batch | CRUD + Reconcile | Read Own Leads | No Access | Create / Execute | Read Own Commission | No Access | No Access |
| **FR-VLT-05:** Execute Weekly Blind Cycle Count | CRUD + Trigger + Audit | No Access | No Access | Execute Count | No Access | No Access | No Access |
| **FR-CAN-01:** 3-Tap Nursery Clone & Mother Tracking | CRUD | Create / Relocate | No Access | No Access | No Access | CRUD + Hold/Release | Create / Relocate |
| **FR-CAN-02:** Mass-Balance Processing & Extraction Ledger | CRUD + Audit | Execute Run | No Access | No Access | No Access | CRUD + Verify Variance | Execute Run |
| **FR-CAN-03:** Dual-Witness Destruction Workflow | Execute / Witness | Witness Only | No Access | No Access | No Access | Execute / Witness (QAP) | Execute / Witness |
| **FR-CAN-04:** Health Canada CTLS & CRA B300 Monthly Export | CRUD + Export | Read Summary | No Access | No Access | No Access | CRUD + Sign-Off + Export | No Access |

### 2.1 Organization Workspace Switcher & Multi-Tenant View Isolation

* **Single-Organization Roles:**
  * **Salvage-Only Roles (`ONTARIO_STRIPPER`, `TRINIDAD_VAULT_ADMIN`, `OVERSEAS_B2B_BUYER`):** Bound exclusively to `ORG_SALVAGE_EXPORT`. They only see Salvage/Vault navigation, locations (`KEMP-C01..C04`, `RAMS`, `POSV`), and `salvage` schema views; the Workspace Switcher is hidden.
  * **Cannabis-Only Roles (`CANNABIS_QAP_COMPLIANCE`, `NURSERY_CULTIVATION_TECH`):** Bound exclusively to `ORG_CANNABIS_NURSERY_PROC`. They only see Brockville/Kemptville Nursery & Processing navigation, locations (`BROCK`, `KEMP-GRNH`, `KEMP-TREE`), and `cannabis` schema views; they have zero visibility into `salvage` tables or automotive cash sales.
* **Dual-Workspace Partner Roles (`ARCHITECT_CFO`, `HUNTER_MECHANIC`):**
  * Hold `OrganizationMembership` rows in both `ORG_SALVAGE_EXPORT` and `ORG_CANNABIS_NURSERY_PROC`.
  * Render a persistent header **Organization Workspace Switcher** (`[Auto & Marine Export]` $\leftrightarrow$ `[Cannabis Nursery & Processing]`). Switching workspaces refreshes the active JWT `organization_id` claim so all shared tables (`StorageLocation`, `Expense`, `CashCustodyTransfer`, `CustodyEvent`, `AuditLog`) and domain queries are strictly scoped to the selected business entity.

---

## 3. Phase 1 Functional Requirements (Canada-First Ontario Domestic, eBay Syndication & Pre-Paid Export MVP)

Phase 1A launches **100% Ontario-centralized operations** across Kemptville (`KEMP-C01..C04` container shelving, max 4 shells on pad) and Ramsayville (`RAMS` 8-car retail/repair lot): dismantling 2021–2022 Kia, Hyundai, and Mazda LHD donor SUVs (where **100% of `UNIVERSAL` and `LHD_ONLY` parts** are compatible with North American buyers), exporting small/light parts (`< 15 kg`) via eBay Seller Hub Bulk CSV (`FR-MKT-00`), routing heavy assemblies (`>= 15 kg`) and vehicle flips (`RETAIL_LOT_VEHICLE_SALE`) to Ottawa classifieds with `"Ramsayville / East Ottawa, ON"` bylaw stealth (`RULE-MKT-002`), and executing CAD checkout (`FR-CHK-01`) with auditable Operator Float (`HELD_IN_OPERATOR_FLOAT`) and atomic anti-double-sale delisting. Phase 1B adds the Manifest V3 Chrome Extension (`FR-MKT-02`), Deal Analyzer (`FR-DEAL-01`), and **100% Pre-Paid Direct Export (`FR-LOG-01`, `FR-LOG-02` gated by `RULE-EXP-001`)** for upfront-paid overseas orders (e.g., Yamaha Jet, Yamaha VR, A/C Machine, or pre-sold pallets).

### Module A (Phase 1A): Asset & Part Intake + Append-Only Custody (`src/modules/dismantling`)

#### FR-INT-01: Multi-Category Donor & Whole-Unit Intake
* **Description:** The system shall support registering three distinct `AssetCategory` types: `AUTOMOBILE` (17-character VIN), `WATERCRAFT` (12-character Hull Identification Number / HIN), and `SHOP_EQUIPMENT` (Manufacturer Serial Number).
* **Business Rules:**
  1. When `assetCategory == 'AUTOMOBILE'`, the system calls `IAssetDecoderPort` (NHTSA vPIC) to auto-populate Year, Make, Model, Trim, and Engine, and defaults `steeringSide = 'LHD_ONLY'` for North American acquisitions.
  2. When `assetCategory` is `'WATERCRAFT'` or `'SHOP_EQUIPMENT'`, the system sets `roadBrand = 'NOT_APPLICABLE'`, `steeringSide = 'UNIVERSAL'`, and bypasses all Ontario road-inspection (DriveON SIC/SSC) state guards.
* **Acceptance Criteria:**
  * Given the user inputs Ontario LHD donor SUV VINs (`DISMANTLE_AND_EXPORT`), Ramsayville retail flip VINs (`QUICK_TURN_BEATER` / `HIGH_END_REBUILD`), or whole watercraft/equipment identifiers (Yamaha Jet HIN, Yamaha VR HIN, A/C Machine serial number), the system enforces `workingCapitalGate` (`minCashReserveFloorCadMinor`) and destination `StorageLocation` capacity/zoning (`RULE-ZONE-001`) and creates `Vehicle` records with initial `CustodyEvent` entries (bypassing DriveON safety certificate prompts on watercraft and shop equipment).

#### FR-INT-02: 3-Tap Part Strip, QR Hang-Tag Binding & Steering-Side Tagging
* **Description:** Workers stripping a donor vehicle shall loop a pre-printed weatherproof `10-MIL` synthetic laser QR hang tag (`PRT-XXXXXX`, fastened with a `-40°C` black UV zip tie per `RULE-TAG-001`) onto each physical component, capture 3 photos, classify steering-side compatibility, and scan a destination storage bin QR card (`KEMP-C01-R01-S01-B01`).
* **Business Rules:**
  1. All uploaded product photos are stripped of EXIF GPS coordinates and camera metadata before being written to `R2_PUBLIC_MEDIA_BUCKET` (`RULE-MKT-002` Kemptville geolocation stealth).
  2. Each stripped part is tracked across five orthogonal state axes (`custodyState`, `availabilityState`, `ebaySyncState`, `classifiedsSyncState`, `complianceState`) and tagged with `SteeringSideCompatibility`:
     * `UNIVERSAL`: Steering-side geometry neutral (engines, transmissions, doors, body panels, rear clips, suspension, wheels, and all marine components; does not bypass OEM part-number/interchange fitment verification).
     * `LHD_ONLY`: Left-hand-drive steering racks, columns, dashboards, interior trim, master window switches, wiper linkages, and LHD-beam headlamps (100% eligible for Canada/US eBay Motors and Ottawa local sales; blocked from RHD export pallets without buyer override).
  3. **Hazmat & Safety Screen:** Any airbag module (`8708.95`) or uncertified hazardous component must be flagged `isHazmatOrAirbag = true` and automatically placed into `complianceState = 'QUARANTINED_RECALL_OR_DG'` (excluded from eBay CSV export and LCL air/ocean pallet scanning unless dangerous goods documentation is explicitly attached).
  4. **Online vs. Offline Initial Custody State Transition:** When a worker completes the 3-Tap Part Strip workflow online and scans both the part QR (`PRT-XXXXXX`) and a valid destination storage bin QR (`toLocationBarcode`), the system creates the `Part` and immediately transitions `custodyState` to `SHELVED_ORIGIN_CONTAINER` in a single atomic transaction (recording the `CustodyEvent`). `STRIPPED_RAW_OFFLINE` is strictly a transient initial state for parts captured on the yard floor without a destination bin scan or queued offline in IndexedDB prior to container shelving.
  5. **Data-Driven Site Zoning & Capacity Guard (`RULE-ZONE-001`):** Enforced via `StorageLocation.allowedOrgType` (`SALVAGE_AND_EXPORT` vs. `CANNABIS_NURSERY_AND_PROCESSING`) and `StorageLocation.maxActiveAssetCapacity`. Scanning any `salvage.Part` or `salvage.Vehicle` into a Kemptville Greenhouse (`ZONE_GREENHOUSE_AG`), Tree Farm (`ZONE_TREE_FARM`), or Brockville (`BROCK`) location barcode where `allowedOrgType != 'SALVAGE_AND_EXPORT'` is hard-blocked (`422 SITE_ZONING_VIOLATION`).
  6. **Batch `8.5" × 11"` Synthetic Laser QR Tag Sheet Generation (`RULE-TAG-001`):** `shared-ops` generates printable Letter-size PDF and SVG sheets in **`3×4` (12-up)** and **`4×4` (16-up)** grids for matte `10-MIL` waterproof synthetic laser cardstock (`300–400` sequential `PRT-XXXXXX` hang tags per 25-sheet pack with dashed cut lines, $15\text{mm} \times 4\text{mm}$ oval slot-punch marks, and $\ge 1.5" \times 1.5"$ quiet-zone QR codes, plus 2-hole steel rack upright bin cards for `KEMP-C01-*`), keeping Zebra ZPL II output as an optional secondary adapter format.
* **Acceptance Criteria:**
  * Scanning a duplicate `PRT-XXXXXX` code already bound to another part returns HTTP `409 Conflict` and triggers an immediate visual/audio alert.
  * Every location scan (for either a `Part` or a whole `Vehicle`) appends an immutable `CustodyEvent` containing the client's UUIDv7 `idempotencyKey` and `expectedVersion`.

---

### Module B (Phase 1A & 1B): Zero-Typing Domestic Syndication Bridge & Local Chrome Extension (`src/modules/marketplace`)

#### FR-MKT-00: Zero-Typing Domestic Syndication Bridge (Phase 1A Day-1 MVP)
* **Description:** Immediately upon shelving stripped parts in Kemptville (`SHELVED_ORIGIN_CONTAINER`) or preparing retail vehicles in Ramsayville (`READY_FOR_RETAIL_SALE`), the system deterministically generates marketplace-ready SEO listing copy and bulk export feeds without manual typing or waiting for Phase 2A eBay API workers.
* **Business Rules & Outputs:**
  1. **Deterministic SEO Copy & Channel Routing (`ISyndicationTemplatePort` & `RULE-MKT-001`):** Joins decoded NHTSA VIN / Marine HIN specs (`Year`, `Make`, `Model`, `Trim`, `Engine`), `partCategoryName`, `oemPartNumbers`, `araGrade` / `araDamageCode`, and donor odometer/hours provenance to auto-generate an $\le 80$-character SEO eBay Motors title (`Part.ebayTitle`) and structured HTML description. Recommends `EBAY_MOTORS_SHIPPED` for parts `< 15.0 kg` and local Ottawa classifieds (`FB_MARKETPLACE_LOCAL` / `KIJIJI_LOCAL`) for heavy assemblies `>= 15.0 kg` (with 100% of `LHD_ONLY` and `UNIVERSAL` parts eligible).
  2. **eBay Seller Hub Bulk CSV Exporter (`/api/salvage/syndication/ebay-csv`):** Exports selected `SHELVED_ORIGIN_CONTAINER` parts (`availabilityState == 'AVAILABLE'`, `complianceState != 'QUARANTINED_RECALL_OR_DG'`, `isHazmatOrAirbag == false`) into an eBay Seller Hub File Exchange-compatible CSV (`CustomLabel` = `PRT-XXXXXX`, `Title`, `Category`, `ConditionID`, `StartPrice` in CAD, `Quantity=1`, `PicURL`, `Description`, `C:Brand`, `C:OE/OEM Part Number`), atomically transitioning exported parts to `ebaySyncState = 'SYNDICATED_LIVE'` so anti-double-sale tracking is armed on Day 1.
  3. **Bylaw-Stealth Local Classifieds Queue (`/api/marketplace/local-ad-payload/[sku]` & `RULE-MKT-002`):** Formats 1-click copy / mobile Web Share (`navigator.share`) payloads for Ottawa Facebook Marketplace and Kijiji using sanitized `R2_PUBLIC_MEDIA_BUCKET` WebP URLs and hardcoding the pickup location strictly to `domesticSyndication.publicPickupLocationLabel` (`"Ramsayville / East Ottawa, ON"`), never exposing the rural Kemptville dismantling yard (`KEMP`). Marks posted items `classifiedsSyncState = 'POSTED_LIVE'`.
  4. **Urgent Delist Confirmation Queue:** Surfaces a high-visibility queue of any locally sold items in `ebaySyncState == 'DELIST_PENDING'` or `classifiedsSyncState == 'DELIST_REQUIRED'` until confirmed `DELISTED` (manually in Phase 1A or automatically by the BullMQ eBay API worker in Phase 2A).

#### FR-MKT-02: Local Marketplace Chrome Extension & 1-Click FB/Kijiji Listing Helper (Phase 1B — `extensions/local-marketplace-lister`)
* **Description:** Because Facebook Marketplace and Kijiji prohibit server-side automated listing bots for individual auto parts and retail vehicles, Phase 1B pairs the Phase 1A Local Ad Payload API with a lightweight **Manifest V3 Chrome Extension** (`extensions/local-marketplace-lister/`) for heavy local Ontario inventory (doors, hoods, subframes, engines, transmissions, and Ramsayville $5,000 beater/rebuilt cars).
* **Business Rules & Workflow:**
  1. **ERP Local Ad Payload Endpoint (`/api/marketplace/local-ad-payload/[sku]`):** Serves the SEO Title (`Year Make Model PartName — OEM# [SKU]`), CAD Ask Price (`retailPriceCadMinor`), condition grade, donor VIN/odometer provenance, `"Ramsayville / East Ottawa, ON"` pickup location (`RULE-MKT-002`), and sanitized `R2_PUBLIC_MEDIA_BUCKET` WebP image URLs.
  2. **User-Initiated Browser Extension Autofill:** When `ARCHITECT_CFO` or `HUNTER_MECHANIC` opens `facebook.com/marketplace/create/item`, `facebook.com/marketplace/create/vehicle`, or `kijiji.ca/p-post-ad.html` and clicks **"Fill from SKU"** in the Chrome Extension popup, the content script injects the title, price, category, description, and `"Ramsayville / East Ottawa, ON"` location fields directly into the DOM and provides 1-click drag/drop image staging—reducing local listing time to under 15 seconds from a residential IP with zero account-ban risk.
  3. **Automatic Sold Sync Reminder:** When a locally listed item is checked out via `/checkout` (`FR-CHK-01`), `classifiedsSyncState` transitions to `DELIST_REQUIRED` and the post-checkout screen displays a 1-tap reminder to mark the corresponding FB/Kijiji ad as sold while automatically queuing the eBay offer for delisting via `OutboxEvent`.

---

### Module C (Phase 1A): Ontario Domestic Mobile Checkout, Tiered Expenses & Operator Float (`src/modules/logistics-vault` & `src/modules/shared-ops`)

#### FR-CHK-01: Single Adaptive Mobile Checkout (`/checkout` — Phase 1A `DOMESTIC_ORIGIN` Active; `DESTINATION_EXPORT_VAULT` Dormant Until Phase 3)
* **Description:** A single unified mobile checkout workflow (`/checkout`) that creates an immutable `SaleTransaction` and dynamically adapts its UI, currency, channel attribution, and security gates based on the scanned item's custody node (`SaleMarketNode`: `DOMESTIC_ORIGIN` active in Phase 1A; `DESTINATION_EXPORT_VAULT` dormant until Phase 3).
* **Domestic Origin Mode (`marketNode == 'DOMESTIC_ORIGIN'`):**
  * Triggered when `HUNTER_MECHANIC` or `ARCHITECT_CFO` scans a `PRT-XXXXXX` part (`SHELVED_ORIGIN_CONTAINER`) or `AST-XXXXXX` whole vehicle (`READY_FOR_RETAIL_SALE`) located in Ontario (`KEMP` or `RAMS`).
  * Renders CAD pricing (`floorPriceAtCheckoutMinor = retailPriceCadMinor`), enforces the **Ontario 3-Tier Price Floor & 10% Negotiation Corridor** (`domesticAdminDiscountToleranceBps = 1000` [10%] permitted for `HUNTER_MECHANIC` with mandatory `discountReasonCode`; $> 10\%$ discount blocked with `422 FLOOR_PRICE_OVERRIDE_REQUIRED` unless `ARCHITECT_CFO` or CFO override), and requires selecting a `DomesticSaleChannel` pill: `LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `WHOLESALE_MECHANIC_NETWORK`, `EBAY_MOTORS_SHIPPED`, or `CAR_PART_WHOLESALE`.
  * Requires uploading a `paymentProofStorageKey` (photo of cash count, Interac e-Transfer screenshot, wire confirmation, or eBay order payout proof) to `R2_PRIVATE_EVIDENCE_BUCKET`.
* **Automatic Post-Checkout Side Effects in Domestic Origin Mode:**
  1. **Immediate Anti-Double-Sale Delist Sync (`OutboxEvent` & Delist States):** Atomically transitions sold parts to `custodyState = 'SOLD_AND_RELEASED'` and `availabilityState = 'PAID_SETTLED'`. If `ebaySyncState == 'SYNDICATED_LIVE'`, transitions `ebaySyncState` to `'DELIST_PENDING'` and emits `PartSoldLocallyDelistEbayRequested` in the same ACID database transaction (surfacing an urgent delist banner in Phase 1A and triggering automated eBay API `quantity = 0` zeroing in Phase 2A). If `classifiedsSyncState == 'POSTED_LIVE'`, transitions `classifiedsSyncState` to `'DELIST_REQUIRED'`.
  2. **VIN Break-Even Velocity & Self-Funding Working Capital Pool Credit:** Computes `netRealizedCadMinor` (`grossCollectedMinor - platformFeeMinor - shippingCostMinor`, applying `0%` fee on local pickup channels and `13.25%` on `EBAY_MOTORS_SHIPPED`) and credits it directly to the donor vehicle's Break-Even Velocity counter and the **Self-Funding Working Capital Pool** (`AvailableWorkingCapital_CAD`).
  3. **Operator Float Cash-Custody Tracking (`HELD_IN_OPERATOR_FLOAT`):** Tracks physical cash custody (`HELD_IN_OPERATOR_FLOAT` for cash in Taz's hands vs. `SETTLED_ORIGIN_CORP_BANK` for Interac e-Transfer/wire/eBay Managed Payouts) as an auditable shop petty-cash float that can be drawn down when logging shop `Expense` receipts/vouchers (`paidFromCashCustody = 'HELD_IN_OPERATOR_FLOAT'`), offset against partner profit draws (`RULE-PAY-003`), or swept into the Canadian corporate bank account via `CashCustodyTransfer`.
  4. **Whole-Vehicle Lot Release (`RETAIL_LOT_VEHICLE_SALE`):** Enforces uploading a signed Bill of Sale (`billOfSaleStorageKey`) at both the API and PostgreSQL `CHECK` constraint layers (and verifies non-expired DriveON SSC `< 36 days` on road `AUTOMOBILE` units), transitions the `Vehicle` to `SOLD_RETAIL_ONTARIO`, and frees up 1 of the 8 Ramsayville shop lot capacity slots (`StorageLocation.maxActiveAssetCapacity = 8`).

#### FR-EXP-01: Tiered Receipt/Voucher Expense Subledger & External GL Sync (Phase 1A Subledger; Phase 2A QBO/Xero Worker)
* **Description:** Every dollar spent (auction invoice, towing, aftermarket repair parts, shop labor, piece-rate stripping, freight, customs duty, or cannabis nursery/processing supplies and lab CoA fees) must be logged as an `Expense` scoped to an `organizationId` and linked to a `Vehicle`, `Shipment`, or `CannabisLot` under a 3-tier receipt verification model (`ReceiptVerificationState`):
* **Acceptance Criteria:**
  1. **`VERIFIED_RECEIPT` (Default for Expenses $> \$50\text{ CAD}$):** Requires a non-empty `receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET` (enforced at both the API validation layer [HTTP `422`] and PostgreSQL `CHECK` constraint `expense_receipt_or_voucher_check`).
  2. **`PETTY_CASH_VOUCHER` (Under-$\$50\text{ CAD}$ Pressure-Relief Valve):** For minor unreceipted yard/shop cash outlays $\le \text{pettyCashVoucherMaxCadMinor}$ ($\$50\text{ CAD}$), operators can log a `PETTY_CASH_VOUCHER` without a photo by supplying a mandatory text `voucherReason` ($\ge 5\text{ characters}$), up to a rolling monthly cap of `monthlyUnreceiptedVoucherCapCadMinor` ($\$250\text{ CAD/month}$ per operator before requiring `ARCHITECT_CFO` approval).
  3. **`PENDING_RECEIPT_UPLOAD` (Temporary Float Liability Hold):** When an expense $> \$50\text{ CAD}$ is incurred in the field before a paper invoice is digitized, it can be logged as `PENDING_RECEIPT_UPLOAD` with a mandatory `voucherReason`, remaining flagged as an unverified operator float liability until the `receiptStorageKey` photo is uploaded and transitioned to `VERIFIED_RECEIPT`.
  4. Confirmed expenses and sales emit an `OutboxEvent` synced to QuickBooks Online / Xero via `IAccountingGlPort` in Phase 2A.

#### FR-EXP-02: 3-Rule Compensation & Piece-Rate Stripper Payout Gate (Phase 1A — `RULE-PAY-001` to `RULE-PAY-003`)
* **Description:** Enforces strict working-capital discipline on yard stripper labor payouts and founder profit draws so the one-time initial seed capital pool (`initialSeedCapitalCadMinor`) is never depleted by unsupervised hourly wages or unreceipted cash draws.
* **Business Rules:**
  1. **Rule 1 — Piece-Rate Yard Stripper Payout Gate (`RULE-PAY-001`, `category == 'YARD_STRIPPER_PIECE_RATE'`):** Unskilled yard strippers (`ONTARIO_STRIPPER`) are paid a configurable flat piece-rate per completed vehicle ($300–$400 CAD default) rather than hourly wages. The system blocks logging a `YARD_STRIPPER_PIECE_RATE` expense (`422 PIECE_RATE_GATE_UNMET`) unless `vehicleId` is linked, `Vehicle.fluidsDrainedAt IS NOT NULL`, and at least `minShelvedPartsForStripPayout` (default `35` for `AUTOMOBILE`) child `Part` records for that donor vehicle have reached `custodyState == 'SHELVED_ORIGIN_CONTAINER'` with photos and scanned bin barcodes.
  2. **Rule 2 — Zero Founder Salaries from Seed Capital Pool (`RULE-PAY-002`, `category == 'PARTNER_PROFIT_DRAW'`):** Neither partner (`ARCHITECT_CFO`, `HUNTER_MECHANIC`) may draw salary from the one-time initial seed capital principal (`initialSeedCapitalCadMinor`). Logging a `PARTNER_PROFIT_DRAW` is hard-blocked (`422 INSUFFICIENT_REALIZED_PROFIT_POOL`) if the requested draw exceeds the cumulative realized net profit pool (`DistributableRealizedProfitPoolCadMinor`).
  3. **Rule 3 — Bi-Weekly Operator Float Offset (`RULE-PAY-003`):** When executing a `PARTNER_PROFIT_DRAW` for `HUNTER_MECHANIC`, the system automatically nets the payout against his current `RunningOperatorFloat_CAD` (`HELD_IN_OPERATOR_FLOAT`) balance so unreceipted local cash collected in Ontario is settled before any new corporate cash is disbursed.

---

### Module D & F (Phase 1B): "Bad Cop" CFO Deal Analyzer & 100% Pre-Paid Direct Export (`src/modules/cfo-subledger` & `src/modules/logistics-vault`)

#### FR-DEAL-01: Pre-Auction Deal Analyzer & Self-Funding Capital Gate
* **Description:** Before bidding on a vehicle or watercraft, `HUNTER_MECHANIC` enters the VIN/HIN, auction location, estimated repair items, and target operational lane.
* **Business Rules:**
  1. Computes Maximum Allowable Bid ($B_{\text{max}}$) by deducting auction buyer fees, towing, estimated shop labor/parts, inspection fees, and the lane's minimum target profit from conservative gross realization.
  2. Checks active physical capacity limits via `StorageLocation.maxActiveAssetCapacity` (seeded to `8` active vehicles for the Ramsayville Retail Lot and `4` uncrushed stripped shells for the Kemptville Dismantling Pad `ZONE_CONTAINER_PAD`, governed by `locationCapacityGate.enforcementMode`: `"HARD_BLOCK" | "WARN_ONLY" | "DISABLED"`).
  3. Checks the **Self-Funding Working Capital Pool (`workingCapitalGate`):** Evaluates $\text{AvailableWorkingCapital}_{\text{CAD}} = \text{InitialSeedCapital}_{\text{CAD}} + \sum \text{NetRealizedDomesticSales}_{\text{CAD}} + \sum \text{RepatriatedExportSettlements}_{\text{CAD}} - \sum \text{TotalDeployedAcquisitionAndExpenseOutlay}_{\text{CAD}}$ (with `initialSeedCapitalCadMinor` configurable from $\$20,000\text{–}\$50,000\text{ CAD}$, default $\$35,000\text{ CAD}$, and `countPendingExportCashAsAvailable = false` by default). A proposed vehicle acquisition passes the gate if $\text{AvailableWorkingCapital}_{\text{CAD}} - \text{EstimatedDealOutlay}_{\text{CAD}} \ge \text{minCashReserveFloorCadMinor}$ ($\$7,500\text{ CAD}$ liquid reserve floor).
  4. Blocks moving a deal to `ACQUIRED_IN_TRANSIT` if the bid exceeds $B_{\text{max}}$ or breaches capacity/capital gates (`enforcementMode == "HARD_BLOCK"`) without an audit-logged `ARCHITECT_CFO` approval.

#### FR-LOG-01: Pre-Paid LCL Pallet & Whole-Asset Consolidation Scan
* **Description:** When an overseas buyer pre-purchases whole watercraft/equipment (e.g., Yamaha Jet, Yamaha VR, A/C Machine) or a `UNIVERSAL` parts pallet, operators create an outbound `Shipment` (e.g., `EXP-2026-TT-001`) and `ShipmentPallet` (`PLT-2026-001`) and scan items onto the pallet.
* **Business Rules:**
  1. **100% Pre-Paid Origin Export Gate (`RULE-EXP-001`):** While `exportPolicy.exportFulfillmentMode == 'PREPAID_ORIGIN_ONLY'`, sealing a `ShipmentPallet` or departing a `Shipment` is hard-blocked (`422 PREPAID_EXPORT_REQUIRED`) unless $100\%$ of items on the shipment have verified upfront CAD/USD payment settled in `SETTLED_ORIGIN_CORP_BANK` (or an explicit `ARCHITECT_CFO` verified-deposit override), strictly prohibiting consignment exports.
  2. **LHD-to-RHD Destination & OEM Fitment Guard:** If `Shipment.destinationPort == 'TT_POS'` (or any RHD market) and a worker scans a part marked `steeringSideCompatibility == 'LHD_ONLY'`, the system blocks the scan (`422 LHD_EXPORT_BLOCKED`) unless an explicit buyer override exists, and enforces `oemFitmentVerified == true`.
  3. **Floor-Exceeds-Market Guard (`RULE-PRC-001`):** When operating in `BONDED_DESTINATION_VAULT_COD` mode, if an item's computed `vaultFloorPriceTtdMinor > brokerMarketPriceTtdMinor`, flags `MARGIN_INVERSION_WARNING` blocking export packing unless overridden by `ARCHITECT_CFO`.
  4. **Two-Phase Marketplace Lock (Phase 1B Manual Fallback & Phase 2A+ API Sync):** If a scanned part is currently active on eBay (`ebaySyncState == 'SYNDICATED_LIVE'`), scanning it onto a pallet transitions `custodyState` to `ON_EXPORT_PALLET` and `ebaySyncState` to `EXPORT_LOCK_PENDING` (requiring supervisor manual confirmation in Phase 1B or automated BullMQ eBay API zeroing in Phase 2A+). The pallet cannot be sealed (`sealedAt`) until all child parts reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED` / `DELISTED`).
  5. **Environmental Prep Check:** A whole vehicle, watercraft, or drivetrain assembly cannot be sealed onto a shipment until `fluidsDrainedAt` is timestamped (plus `steamCleanedReceiptKey` for whole vehicles/watercraft, or `refrigerantEvacCertKey` for `SHOP_EQUIPMENT`).

#### FR-LOG-02: Broker-Ready Export & Customs Package Generator
* **Description:** Compiles a deterministic, human-and-broker-verifiable **Export Compliance Dossier (PDF + CSV)** from the scanned pre-paid shipment contents (deferring automated CERS fixed-width `.txt` generation to the licensed customs broker).
* **Outputs Generated:**
  1. **Commercial Invoice (PDF & CSV):** Groups items by 6-digit HS Tariff Code (`8708.xx` for auto parts, `8407.xx` for engines, `8903.99` for Yamaha watercraft, `8479.89` for the A/C machine), displaying Importer of Record details, item descriptions, donor VIN/HIN provenance, declared arm's-length Wholesale FOB USD values (`RULE-CUST-003`), freight, insurance, and total CIF USD value.
  2. **Detailed Packing List (PDF & CSV):** Lists each `PLT-XXXXXX` pallet and whole unit, itemizing net weight ($\text{kg}$), crating tare weight ($22.0\text{ kg}$ default per ISPM-15 pallet), gross weight, and dimensions ($\text{L} \times \text{W} \times \text{H cm}$) for the freight forwarder's Ocean Bill of Lading.
  3. **CBSA CERS 48-Hour Marine Countdown & 6-Year Archive:** Tracks the mandatory 48-hour prior-to-vessel-loading CERS deadline and archives the licensed customs broker's final Proof of Report (POR) and export dossier into Canadian-resident storage for 6 years.

---

## 4. Phase 2 Functional Requirements (Phase 2A Automated eBay Sync & Offline PWA + Phase 2B Cannabis Compliance)

### Module B (Phase 2A): Automated eBay Inventory API Sync, Offline Yard PWA & Accounting GL Sync
* **Automated eBay Inventory API & Inbound Order Webhooks (`IMarketplacePort`):** Pulled forward from Phase 3 because eBay Motors is a primary Day-1 Ontario revenue engine. BullMQ workers automatically publish `CLEARED_FOR_SALE` `< 15 kg` parts via the eBay Inventory API, query `Browse API` active competitor comp floors, process `PartSoldLocallyDelistEbayRequested` `OutboxEvent` records to automatically zero eBay quantities (`DELIST_PENDING` $\rightarrow$ `DELISTED`), and ingest inbound eBay sale webhooks to create `EBAY_MOTORS_SHIPPED` `SaleTransaction` records and dispatch pick-pull alerts to Kemptville/Ramsayville.
* **Offline-First IndexedDB Yard Stripper PWA (`NFR-REL-01`):** Queues binary photo blobs and `CustodyEvent` mutations in `Dexie.js` during rural Kemptville cellular dropouts and reconciles optimistic `expectedVersion` counters upon reconnect.
* **External Accounting GL Sync (`IAccountingGlPort`):** Outbound BullMQ worker syncing verified `Expense`, `SaleTransaction`, and `CashCustodyTransfer` journal entries to QuickBooks Online / Xero.

### Module G (Phase 2B): Cannabis Nursery, Mass-Balance Processing & CTLS Compliance (`src/modules/cannabis-compliance`)

#### FR-CAN-01: 3-Tap Nursery Clone & Mother Tracking
* **Description:** Cultivation technicians (`NURSERY_CULTIVATION_TECH`) and QAP staff (`CANNABIS_QAP_COMPLIANCE`) operating in the Brockville JV facility (`BROCK`) or Kemptville agricultural zones (`KEMP` — `ZONE_GREENHOUSE_AG` / `ZONE_TREE_FARM`) shall scan a mother plant QR hang tag (`MOTHER_PLANT`) to spawn child clone tray batches (`LOT-YYYY-XXXX` in `CLONE_TRAY` stage), bind or print weatherproof `10-MIL` synthetic laser QR hang tags / tray cards (or optional ZPL thermal labels per `RULE-TAG-001`), and scan destination grow room/table QR codes (e.g., `BROCK-PROP-R1-T2` or `KEMP-GRNH-R1-T1`).
* **Business Rules:**
  1. **Genetic Lineage Provenance:** Every spawned `CLONE_TRAY` or `VEGETATIVE_BATCH` lot inherits `strainId` from its `parentMotherLotId` and defaults to `trackingUnit = 'PLANTS'` with an explicit `plantCount`.
  2. **Data-Driven Site Zoning Guard (`RULE-ZONE-001`):** `CannabisLot` barcodes can only be scanned into `StorageLocation` records where `allowedOrgType == 'CANNABIS_NURSERY_AND_PROCESSING'` (`BROCK` facility rooms or Kemptville `ZONE_GREENHOUSE_AG` / `ZONE_TREE_FARM`). Scanning a cannabis lot into `ZONE_CONTAINER_PAD`, `RAMS`, or `POSV` where `allowedOrgType == 'SALVAGE_AND_EXPORT'` is hard-blocked (`422 SITE_ZONING_VIOLATION`).
* **Acceptance Criteria:**
  * Spawning a clone tray creates the `CannabisLot` record, emits the printable `10-MIL` synthetic laser QR tag sheet / optional ZPL label via `shared-ops` (`ILabelTagPort`), and records an append-only `CustodyEvent` (`cannabisLotId` populated, `partId` and `vehicleId` null).

#### FR-CAN-02: Mass-Balance Processing & Extraction Ledger ("Moving the Juice")
* **Description:** Operators recording wet-to-dry curing (`FRESH_HARVEST` $\rightarrow$ `DRIED_FLOWER` + `TRIM_BIOMASS`) or biomass-to-extract transformations (`DRIED_FLOWER` / `TRIM_BIOMASS` $\rightarrow$ `CRUDE_EXTRACT` $\rightarrow$ `DISTILLATE_OR_ISOLATE`) shall log a `CannabisLotTransformation` where input weight reconciles to output weight, moisture loss, and witnessed waste to the gram (`0.01g`).
* **Business Rules:**
  1. **Strict Conservation of Mass:** At both the API and PostgreSQL `CHECK` constraint layers, every transformation must satisfy:
     $$\text{InputWeight}_{\text{g}} = \text{OutputWeight}_{\text{g}} + \text{MoistureLoss}_{\text{g}} + \text{WasteDestroyed}_{\text{g}} + \text{UnaccountedVariance}_{\text{g}}$$
  2. **Automatic Variance & QAP Hold Gate (`RULE-CAN-001`):** If unaccounted processing variance exceeds `2.0%` of input weight ($|\text{UnaccountedVariance}_{\text{g}}| / \text{InputWeight}_{\text{g}} > 0.020$), or if curing moisture loss falls outside the configurable `72.0%–80.0%` band without explanation, the system flags `varianceAlertFlagged = true`, places the target `CannabisLot` on `complianceHold = true`, and blocks outbound movement until `CANNABIS_QAP_COMPLIANCE` signs off (`verifiedByQapUserId`).
  3. **Waste Linkage:** Any transformation reporting `wasteDestroyedGrams > 0` requires linking or creating a witnessed `CannabisDestructionLog` (`FR-CAN-03`).

#### FR-CAN-03: Dual-Witness Destruction Workflow
* **Description:** Enforces Health Canada witnessed cannabis destruction rules for plant culls, trim waste, and extraction raffinate/spent biomass.
* **Business Rules:**
  1. Creating a `CannabisDestructionLog` requires capturing `weightDestroyedGrams` (and/or `plantsDestroyedCount`), `destructionReason`, `destructionMethod` (e.g., `COMPOST_DENATURED_50_50`), and uploading a timestamped photo (`evidencePhotoStorageKey`) to `R2_PRIVATE_EVIDENCE_BUCKET`.
  2. **Two Distinct Witnesses (`primaryUserId != witnessUserId`):** Enforced at both the application layer and PostgreSQL `CHECK` constraint (`cannabis_destruction_two_distinct_witnesses`). The primary executor and co-signing witness must be two distinct authenticated users in `ORG_CANNABIS_NURSERY_PROC`, with at least one holding `CANNABIS_QAP_COMPLIANCE` or `ARCHITECT_CFO` authority.
* **Acceptance Criteria:**
  * Attempting to submit a destruction log where `primaryUserId == witnessUserId` or without a private R2 evidence photo is rejected at both the API (HTTP `422`) and PostgreSQL constraint layers.

#### FR-CAN-04: Health Canada CTLS & CRA B300 Monthly Export
* **Description:** Generates monthly regulatory mass-balance inventory summaries for the **Health Canada Cannabis Tracking and Licensing System (CTLS)** and **CRA Form B300 (Cannabis Duty and Information Return)**, and manages Lab Certificate of Analysis (CoA) attachments.
* **Outputs & Business Rules:**
  1. **Monthly Mass-Balance Ledger (CSV & PDF):** Aggregates opening inventory, additions (propagation/harvest/processing in), reductions (processing out, witnessed destruction, B2B bulk transfers), and closing inventory across canonical CTLS categories: **Seeds / Vegetative Plants (`PLANTS`), Whole Cannabis Plants / Fresh (`GRAMS`), Dried Cannabis (`GRAMS`), and Cannabis Extracts / Distillate (`GRAMS`)**.
  2. **Lab CoA Gate (`labCoaStorageKey`):** Bulk extract or dried flower lots cannot be cleared for B2B wholesale release while `complianceHold == true` or without a private Lab CoA PDF (`labCoaStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) verified by `CANNABIS_QAP_COMPLIANCE`.
  3. **Strict Audit Isolation:** CTLS and CRA B300 export queries run exclusively against `cannabis.*` and `shared.*` rows where `organizationId == ORG_CANNABIS_NURSERY_PROC`, guaranteeing zero leakage of `salvage.*` records.

---

## 5. Phase 3 Functional Requirements (Assistive AI Vision & Dormant Destination Bonded Vault Expansion)

### Module B (Phase 3): Assistive AI Vision Enrichment (`src/modules/marketplace`)

#### FR-AI-01: Human-in-the-Loop AI Vision Enrichment
* **Description:** A BullMQ worker processes newly stripped parts through background cleanup and `IVisionEnrichmentPort` to extract stamped OEM part numbers, suggest ARA condition grades (`A`, `B1`, `B2`, `B3`, `C`), and draft an 80-character eBay title.
* **Acceptance Criteria:**
  * All AI outputs are treated as assistive proposals. If `aiConfidenceScore < 0.80`, or if no OEM part number is legible, or if the part is safety-critical, the part transitions to `complianceState = 'NEEDS_HUMAN_REVIEW'` and cannot auto-publish to eBay.
  * Pricing baseline queries use the eBay `Browse API` (active competitor floor/median prices) plus internal historical sell-through data rather than relying on the restricted eBay `Marketplace Insights API`.

### Module E (Phase 3 — Dormant Until Overseas Bonded Facility Activation): Destination Bonded Vault, COD Gate Lock & FX Tracker (`src/modules/logistics-vault`)

> **Dormant Node Note (`ADR-0001`):** All Destination Bonded Vault models and calculators remain intact in `salvage` schema for Vertical-SaaS portability and future overseas activation when `exportPolicy.exportFulfillmentMode` is switched from `'PREPAID_ORIGIN_ONLY'` to `'BONDED_DESTINATION_VAULT_COD'`.

#### FR-MKT-01: Two-Tab "Live Container" Storefront & Wish-List Engine
* **Description:** Provides overseas B2B buyers and brokers with a mobile catalog split into **Tab 1 ("In Stock — Destination Vault")** and **Tab 2 ("Loading in Ontario")**, hiding all Canadian acquisition costs and domestic eBay prices.
* **Acceptance Criteria:**
  * Buyers can place a rate-limited 24-hour reservation hold (`B2BReservation` on either a `Part` or a whole `Vehicle`, enforced by partial unique indexes to prevent overlapping active holds) or submit a `PreOrderWishList` request (filtered by `RHD_ONLY` or `UNIVERSAL` `SteeringSideCompatibility`) that automatically alerts the Deal Analyzer when a matching donor vehicle is evaluated in Ontario.

#### FR-VLT-01: Landed Container Check-In & Discrepancy Alerting
* **Description:** When a shipment clears Port of Spain customs and arrives at a bonded destination warehouse, the `TRINIDAD_VAULT_ADMIN` scans each whole asset and `PRT-XXXXXX` part tag onto a local vault shelf barcode (`POSV-V01-R01-S01-B01`).
* **Acceptance Criteria:**
  * Scanned parts transition `custodyState` from `IN_TRANSIT_OCEAN_FREIGHT` to `SHELVED_DESTINATION_VAULT` (whole vehicles/watercraft transition `lifecycleState` to `LANDED_TRINIDAD_VAULT`), update `storageLocationId`, and append a `CustodyEvent`.
  * Any manifested SKU not scanned into the vault within 24 hours of unstuffing flags a **Transit Shrinkage Exception** on the CFO dashboard.

#### FR-VLT-02: Landed Cost Allocation, TTD Floor Pricing & 3-Tier Shipment P&L
* **Description:** Upon entering the final customs broker assessment (`assessedDutyTtdMinor`, `assessedVatTtdMinor`, port drayage, and ocean freight) on the `Shipment`, the system allocates landed costs across all parts and whole units on the shipment (weighted by declared FOB value and weight), computes each item's minimum Cash-on-Delivery price (`vaultFloorPriceTtdMinor`), and tracks the shipment across the **3-Tier Shipment Profitability Model** (Tier 1 Projected Contribution CAD, Tier 2 Realized Operating Profit TTD/CAD, and Tier 3 Repatriated Cash Return CAD as defined in `DOMAIN-RULES.md` Section 4.4):
  $$\text{Floor}_{\text{TTD}} = \frac{\left(\text{CostBasis}_{\text{CAD}} \times (1 + \text{TargetMarkup}) \times \text{FX}_{\text{CAD\_to\_USD}} \times \text{FX}_{\text{shadow}}\right) + \text{AllocatedLandedTaxesAndFreight}_{\text{TTD}}}{1 - r_{\text{comm}}}$$
* **Business Rules:**
  * All tariff rates, VAT percentages ($12.5\%$), broker commission rates ($5\%\text{–}10\%$, calculated strictly on pre-tax `subtotalMinor` per `RULE-PRC-002`), and shadow FX reserve rates are read from the versioned configuration register (`DOMAIN-RULES.md`), never hardcoded in business logic.

#### FR-VLT-03: Strict COD Verification, 3-Tier Negotiation Corridor & Phased Gate Release
* **Description:** When a buyer or commissioned broker arrives at the Destination Vault to purchase parts or watercraft, the system enforces a hard separation between sales selection and payment verification while providing a bounded Vault Admin negotiation corridor and counter commission netting.
* **Business Rules:**
  1. Only `TRINIDAD_VAULT_ADMIN` or `ARCHITECT_CFO` with an active MFA-verified JWT session (`aal2`) can execute `verifyCodPayment` (`checkoutStrictnessMode == 'BONDED_VAULT_STRICT'` default for `ORG_SALVAGE_EXPORT`, configurable to `'AUDIT_ENFORCED'` or `'STANDARD_POS'` for external SaaS yards).
  2. **3-Tier Price Floor Evaluation & Negotiation Corridor (`floorPriceAtCheckoutMinor`):**
     * **Tier 1 (At or Above Floor):** `grossCollectedMinor >= floorPriceAtCheckoutMinor` $\rightarrow$ Passes automatically (`discountReasonCode = null`).
     * **Tier 2 (Within Admin Negotiation Corridor):** Discount (`discountAmountMinor`) is $\le \min(\text{vaultAdminMaxDiscountCapTtdMinor } [\text{TT\$750}],\; \max(\text{vaultAdminSmallRoundingAllowanceTtdMinor } [\text{TT\$100}],\; \text{floorPriceAtCheckoutMinor} \times 0.08))$ $\rightarrow$ Allowed for `TRINIDAD_VAULT_ADMIN` (or `HUNTER_MECHANIC` in Ontario under `domesticAdminDiscountToleranceBps = 1000` [10%]) **if and only if** a valid `discountReasonCode` (`"CASH_ROUNDING" | "BUNDLE_DISCOUNT" | "TRANSIT_OR_SHOP_DAMAGE" | "AGED_INVENTORY_CLEARANCE"`) is selected.
     * **Tier 3 (Beyond Admin Corridor — Hard Lock / CFO Override Required):** Discount exceeds the Admin Corridor $\rightarrow$ Rejects with `422 FLOOR_PRICE_OVERRIDE_REQUIRED` unless `actorRole === 'ARCHITECT_CFO'` or a valid `cfoOverrideApprovedById` + `cfoOverrideReasonNote` (via CFO Override PIN/approval) is supplied.
  3. **Broker Commission Deducted at Counter Toggle (`isBrokerCommissionDeductedAtCounter`):** When `isBrokerCommissionDeductedAtCounter == true`, the broker retained their commission directly from the cash handed over at the counter, so the physical cash added to `HELD_IN_DESTINATION_VAULT` is `grossCollectedMinor - brokerCommissionMinor` (keeping physical vault safe cash 100% accurate).
  4. The admin must upload a payment proof photo (cash count or verified bank wire receipt) to `R2_PRIVATE_EVIDENCE_BUCKET`.
  5. **Trinidad FIU / CDD Compliance Gate (`RULE-COMP-FIU-01` — Encrypted Private ID Storage & 30-Day Rolling Window):** If a single transaction or linked buyer transactions total $\ge \text{TT\$50,000}$ (`5000000` minor units), the UI enforces uploading a photo/scan of the buyer's government ID (`buyerIdDocumentStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) and capturing the AES-256-GCM application-encrypted ID type and number (`buyerIdNumberEncrypted`). Linked transactions are evaluated deterministically across all non-voided `SaleTransaction` records (`marketNode == 'DESTINATION_EXPORT_VAULT'` and `isVoidedOrReversed == false`) within a **rolling 30-calendar-day window (`createdAt >= now() - 30 days`)** matching the same `buyerPhoneE164`, normalized `lower(trim(buyerName))`, or `buyerIdNumberEncrypted` (triggering the Government ID gate at $\ge \text{TT\$50,000}$ and the mandatory Large Cash Transaction Alert at $\ge \text{TT\$90,000}$).
  6. **Atomic Release vs. Two-Step Gate Token:** While counter and exit are operated by the same team, payment verification atomically stamps `gateReleasedAt = now()`, transitioning child parts to `custodyState = 'SOLD_AND_RELEASED'` (and whole assets to `lifecycleState = 'SOLD_EXPORT_COD'`). When dedicated exit guards operate separately from counter staff, verification issues a **Single-Use HMAC-SHA256 Gate Release QR Token** (`gateTokenNonce`, valid for 4 hours) consumed at the warehouse exit (returning HTTP `410 Gone` on replay).

#### FR-VLT-04: Commercial Bank Cap, Cash Custody Transfers & FX Repatriation Batch Ledger
* **Description:** Tracks TTD cash deposited from the Vault safe (`HELD_IN_DESTINATION_VAULT`) into Trinidadian commercial banks (`DEPOSITED_DESTINATION_BANK`) via `CashCustodyTransfer` and logs conversion batches (`CurrencySettlement`) back into CAD/USD (`SETTLED_ORIGIN_CORP_BANK`).
* **Acceptance Criteria:**
  * Displays running TTD balances per bank institution and triggers a warning banner at $\text{TTD \$180,000}$ (protecting the $\text{TTD \$200,000}$ Deposit Insurance Corporation limit on TTD accounts).
  * Records the `effectiveClearingRate` and `fxSlippageLossCadMinor` on every repatriation wire so future TTD floor prices automatically adjust to real-world FX spreads.

#### FR-VLT-05: Weekly Blind Cycle Counts & Bank Deposit Reconciliation
* **Description:** Once per week (or triggered on demand by `ARCHITECT_CFO`), generates a `CycleCountTask` batch selecting up to 10 random `SHELVED_DESTINATION_VAULT` parts/vehicles without revealing the expected shelf bin prior to arrival.
* **Acceptance Criteria:**
  * `TRINIDAD_VAULT_ADMIN` must scan the physical QR code on the shelf (`scannedLocationBarcode`) and capture a live timestamped photo (`liveVerificationPhotoKey` in `R2_PRIVATE_EVIDENCE_BUCKET`).
  * Any missing or unverified item transitions the task to `DISCREPANCY_ALERT` on the CFO Dashboard and cross-checks physical Vault stock against recorded `SaleTransaction` rows and TTD bank deposit slips.

### 5.1 Phased Delivery Roadmap Alignment (Canada-First Domestic, eBay Motors & Pre-Paid Export Rollout)

| Phase | Target Window | Active Schemas | Core Deliverables & Operational Focus |
| :--- | :--- | :--- | :--- |
| **Phase 1A** | Days 1–7 (Ontario Domestic Launch MVP) | `shared` + `salvage` | Shared Core (`Organization`, `User`, `StorageLocation`, `Expense`, `CustodyEvent`, R2 buckets, `8.5"×11"` 10-MIL synthetic laser QR tag sheets + QR scanner) + Salvage Intake (`FR-INT-01`, `FR-INT-02`) + Tiered Expense & Operator Float Subledger (`FR-EXP-01`, `FR-EXP-02`) + **Zero-Typing Domestic Syndication Bridge (`FR-MKT-00` eBay Bulk CSV & Stealth Local Queue)** + **Ontario Domestic Mobile Checkout (`FR-CHK-01` with Anti-Double-Sale Delist Sync)**. |
| **Phase 1B** | Days 8–21 (Local Extension & Pre-Paid Export) | `shared` + `salvage` | Local FB/Kijiji Manifest V3 Chrome Extension (`FR-MKT-02`), "Bad Cop" Pre-Auction Deal Analyzer (`FR-DEAL-01`, `FR-DEAL-02`), and **100% Pre-Paid Direct Export Consolidation & Broker Package (`FR-LOG-01`, `FR-LOG-02` gated by `RULE-EXP-001`)**. |
| **Phase 2A** | Days 22–45 (eBay API Automation & Offline PWA) | `shared` + `salvage` | **Pulled-forward Automated eBay Inventory API + Browse API Comp Floor + Inbound Order Webhooks**, Offline-first IndexedDB Yard Stripper PWA (`NFR-REL-01`), and QuickBooks/Xero GL sync (`IAccountingGlPort`). |
| **Phase 2B** | Days 45–90 (Brockville/Kemptville Ag Online) | `shared` + `cannabis` | Workspace Switcher, 3-Tap Nursery Clone/Mother Tracking (`FR-CAN-01`), Mass-Balance Extraction Ledger (`FR-CAN-02`), Dual-Witness Destruction (`FR-CAN-03`), and CTLS / CRA B300 Reporting (`FR-CAN-04`) reusing 80% of Phase 1 `shared-ops` infrastructure. |
| **Phase 3** | Months 3–6 (AI Vision & Dormant Overseas Vault) | `shared` + `salvage` + `cannabis` | Assistive AI Vision (`FR-AI-01`), plus dormant Destination Bonded Vault workflows (`FR-VLT-01`–`FR-VLT-05`), Two-Step HMAC Gate Token exit scanning, and Live Container B2B Storefront (`FR-MKT-01`). |

---

## 6. Non-Functional Requirements (NFRs) & Quality Gates

* **NFR-SEC-01 (Storage Isolation):** `R2_PRIVATE_EVIDENCE_BUCKET` shall block all public access. Receipts, UVIPs, bank deposit slips, encrypted customer government ID documents (`buyerIdDocumentStorageKey`), Lab CoA PDFs (`labCoaStorageKey`), and cannabis destruction evidence photos (`evidencePhotoStorageKey`) may only be accessed via server-generated pre-signed URLs with a maximum TTL of 15 minutes, logged in `AuditLog`.
* **NFR-SEC-02 (Multi-Schema & RLS Audit Firewall):** PostgreSQL tables are isolated across `shared`, `salvage`, and `cannabis` schemas with Supabase RLS policies enforcing `organizationId = (auth.jwt() ->> 'organization_id')::uuid` so a Health Canada CTLS or CRA Excise audit of `ORG_CANNABIS_NURSERY_PROC` has zero visibility into `salvage` tables or automotive cash sales.
* **NFR-REL-01 (Offline Queue Durability):** The Yard & Nursery PWA shall queue binary photo blobs and `CustodyEvent` mutations in IndexedDB (`Dexie.js`), display a persistent high-contrast badge showing the count of unsynced items, and block user logout or cache clearing while unsynced mutations exist.
* **NFR-IDEM-01 (End-to-End Idempotency):** Every barcode scan, offline batch sync, eBay webhook, and WhatsApp webhook must supply a deterministic `Idempotency-Key` enforced by PostgreSQL unique constraints so network retries or double-taps never duplicate records.
* **NFR-ACC-01 (Gloved & Outdoor Usability):** All mobile scanner, nursery, and Vault POS screens must conform to WCAG 2.2 AA contrast ratios ($> 4.5:1$), use minimum $56 \times 56\text{ px}$ touch targets for gloved operation, and pair every color indicator (red/green) with distinct text, icon, and audio/haptic cues.
