# PRD-MVP.md — Functional Specification & Phased Execution Backlog

## 1. Product Scope & Operational Mandate

This Product Requirements Document (PRD) defines the functional workflows, role permissions, acceptance criteria, and phased delivery milestones for the **Cross-Border Salvage, Rebuild & Vault ERP**. 

To avoid premature engineering bloat, delivery is strictly gated by operational proof and split so software never blocks vessel departure:
* **Phase 1A (Pre-Vessel Departure — Weekend Build):** Asset & Part QR/photo/bin intake (`FR-INT-01`, `FR-INT-02`), Expense logging with receipt photo (`FR-EXP-01`), and Broker-Ready Commercial Invoice & Packing List CSV/PDF export (`FR-LOG-01`, `FR-LOG-02`). *(Automated CERS fixed-width `.txt` generation is deferred to the licensed customs broker for Shipment #1).*
* **Phase 1B (During 14-Day Ocean Transit):** Trinidad Vault check-in (`FR-VLT-01`), Landed Cost allocation (`FR-VLT-02`), and Adaptive Mobile Checkout (`FR-CHK-01` / `FR-VLT-03`) covering both Ontario Domestic sales (CAD + Taz's Shop Float) and Trinidad Vault Cash-on-Delivery (COD) release.
* **Phase 2 (Days 31–60 — Yard Offline Resilience, Blind Cycle Counts & CFO Subledger):** Offline-first IndexedDB Stripper PWA, Weekly Blind Cycle Counts (`FR-VLT-05`), "Bad Cop" Pre-Auction Deal Analyzer, receipt-enforced Expense Subledger, and QuickBooks/Xero GL sync.
* **Phase 3 (Months 3–6 — Assistive AI Vision, Two-Phase eBay Sync, Two-Step Gate Token & B2B Storefront):** BullMQ AI Vision OCR/grading proposals, eBay Inventory/Browse API integration with Two-Phase Export Locking (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`), Two-Step HMAC Gate Token exit scanning, and the Live Container B2B Storefront with WhatsApp notifications.

### 1.1 Phase 1 Operational Proof Gate (Pass/Fail Criteria to Unlock Phase 2)

Engineering work on Phase 2 and Phase 3 is strictly gated on Shipment #1 clearing the following four operational thresholds:
1. **Landed Cost Accuracy:** Actual Port of Spain customs duty, VAT, and drayage land within $\pm 15\%$ of the `DOMAIN-RULES.md` model.
2. **Market Price Validation:** At least $60\%$ of Shipment #1 items have a verified local Trinidad market price (`brokerMarketPriceTtdMinor`) equal to or greater than their computed `vaultFloorPriceTtdMinor`.
3. **90-Day Sell-Through & Cash Recovery:** At least $50\%$ of Shipment #1 landed value is sold and collected in verified COD funds within 60 days of vault check-in, and at least one $\text{TTD} \rightarrow \text{CAD}$ repatriation batch clears into the Canadian corporate bank account with total effective FX + wire slippage $\le 12\%$ over official CBTT spot.
4. **Kill / Pivot Rule:** If any SKU class (e.g., specific Korean SUV body panels or watercraft) fails to clear `vaultFloorPriceTtdMinor` due to Japanese RHD import competition or customs tariff friction, freeze Ontario acquisitions for that category before starting Phase 2.

---

## 2. Sanitized Role-Based Access Control (RBAC) Matrix

Authentication is enforced via Supabase Auth with Row-Level Security (RLS) and API route guards. Users holding `ARCHITECT_CFO` or `TRINIDAD_VAULT_ADMIN` roles MUST have Multi-Factor Authentication (`mfaEnrolled = true`) enabled, and privileged financial or gate-release mutations verify active JWT session assurance (`aal2`) via Supabase Auth (`auth.jwt()->>'aal' = 'aal2'`), not merely the `User.mfaEnrolled` boolean.

| Capability / Requirement ID | `ARCHITECT_CFO` | `HUNTER_MECHANIC` | `ONTARIO_STRIPPER` | `TRINIDAD_VAULT_ADMIN` | `OVERSEAS_B2B_BUYER` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **FR-DEAL-01:** Create Pre-Auction Deal Proposal | CRUD + Approve | Create / Read | No Access | No Access | No Access |
| **FR-DEAL-02:** Override Capital Gate Lock | Execute (Audited) | Denied | No Access | No Access | No Access |
| **FR-INT-01:** Intake Whole Asset (Auto / Marine / Equip) | CRUD | Create / Update | Read (Strip Queue) | Read (Exported) | No Access |
| **FR-INT-02:** Strip Part, Bind QR & Scan Bin | CRUD | Create / Relocate | Create / Relocate | No Access | No Access |
| **FR-EXP-01:** Log Expense with Private Receipt | CRUD + Reversal | Create / Read | No Access | Create (Port Fees) | No Access |
| **FR-LOG-01:** Scan Parts/Assets to Export Pallet | CRUD | Create / Read | Execute Scan | Read Manifest | Read ("Loading" Tab) |
| **FR-LOG-02:** Seal Pallet & Export Broker Package | CRUD + Seal | Read Packing List | No Access | Read / Download | No Access |
| **FR-CHK-01:** Execute Ontario Domestic Checkout (CAD Walk-In / FB / Kijiji / Lot) | CRUD | Execute (CAD Only) | No Access | No Access | No Access |
| **FR-VLT-01:** Check-In Landed Shipment to Vault | CRUD | Read Status | No Access | Execute Check-In | No Access |
| **FR-VLT-02:** Create 24h B2B Part/Vehicle Reservation | CRUD | Create (Broker) | No Access | CRUD | Create (Rate-Limited) |
| **FR-VLT-03:** Verify Trinidad Vault COD Payment & Release | Execute (MFA aal2 Required) | **Denied (Hard Lock)** | No Access | **Execute (MFA aal2 Required)** | No Access |
| **FR-VLT-04:** Log Broker Commission & FX Batch | CRUD + Reconcile | Read Own Leads | No Access | Create / Execute | Read Own Commission |
| **FR-VLT-05:** Execute Weekly Blind Cycle Count | CRUD + Trigger + Audit | No Access | No Access | Execute Count | No Access |

---

## 3. Phase 1 Functional Requirements (Trinidad LCL Shipment #1 MVP)

Phase 1 is engineered around the immediate proof-of-concept shipment to Port of Spain: **1x Yamaha Jet Boat/Watercraft, 1x Yamaha VR Watercraft, 1x Automotive A/C Recharge Machine, and 1x consolidated LCL pallet of 2021–2022 Kia, Hyundai, and Mazda SUV parts**.

### Module A: Asset & Part Intake + Append-Only Custody (`src/modules/dismantling`)

#### FR-INT-01: Multi-Category Donor & Whole-Unit Intake
* **Description:** The system shall support registering three distinct `AssetCategory` types: `AUTOMOBILE` (17-character VIN), `WATERCRAFT` (12-character Hull Identification Number / HIN), and `SHOP_EQUIPMENT` (Manufacturer Serial Number).
* **Business Rules:**
  1. When `assetCategory == 'AUTOMOBILE'`, the system calls `IAssetDecoderPort` (NHTSA vPIC) to auto-populate Year, Make, Model, Trim, and Engine, and defaults `steeringSide = 'LHD_ONLY'` for North American acquisitions.
  2. When `assetCategory` is `'WATERCRAFT'` or `'SHOP_EQUIPMENT'`, the system sets `roadBrand = 'NOT_APPLICABLE'`, `steeringSide = 'UNIVERSAL'`, and bypasses all Ontario road-inspection (DriveON SIC/SSC) state guards.
* **Acceptance Criteria:**
  * Given the user inputs the Yamaha Jet HIN, Yamaha VR HIN, and A/C Machine serial number with `operationalLane = 'WHOLE_UNIT_EXPORT'`, the system creates `Vehicle` records ready for direct assignment to Shipment `EXP-2026-TT-001` without prompting for automotive salvage photos or safety certificates.

#### FR-INT-02: 3-Tap Part Strip, QR Binding & Steering-Side Tagging
* **Description:** Workers stripping a donor vehicle shall bind each physical component to a pre-printed weatherproof QR label (`PRT-XXXXXX`), capture 3 photos, classify steering-side compatibility, and scan a destination storage bin QR code (`KEMP-C01-R01-S01-B01`).
* **Business Rules:**
  1. All uploaded product photos are stripped of EXIF GPS coordinates and camera metadata before being written to `R2_PUBLIC_MEDIA_BUCKET`.
  2. Each stripped part is tracked across four orthogonal state axes (`custodyState`, `availabilityState`, `ebaySyncState`, `complianceState`) and tagged with `SteeringSideCompatibility`:
     * `UNIVERSAL`: Steering-side geometry neutral (engines, transmissions, doors, body panels, rear clips, suspension, wheels, and all marine components; does not bypass OEM part-number/interchange fitment verification).
     * `LHD_ONLY`: Left-hand-drive steering racks, columns, dashboards, interior trim, master window switches, wiper linkages, and LHD-beam headlamps.
  3. **Hazmat & Safety Screen:** Any airbag module (`8708.95`) or uncertified hazardous component must be flagged `isHazmatOrAirbag = true` and automatically placed into `complianceState = 'QUARANTINED_RECALL_OR_DG'` (blocked from LCL air/ocean pallet scanning unless dangerous goods documentation is explicitly attached).
* **Acceptance Criteria:**
  * Scanning a duplicate `PRT-XXXXXX` code already bound to another part returns HTTP `409 Conflict` and triggers an immediate visual/audio alert.
  * Every location scan (for either a `Part` or a whole `Vehicle`) appends an immutable `CustodyEvent` containing the client's UUIDv7 `idempotencyKey` and `expectedVersion`.

---

### Module D: Pallet Consolidation & Broker-Ready Customs Package (`src/modules/logistics-vault`)

#### FR-LOG-01: LCL Pallet & Whole-Asset Consolidation Scan
* **Description:** Operators shall create an outbound `Shipment` (e.g., `EXP-2026-TT-001`) and `ShipmentPallet` (`PLT-2026-001`) and scan parts onto the pallet via mobile camera or Bluetooth 2D barcode scanner.
* **Business Rules:**
  1. **LHD-to-RHD Destination & OEM Fitment Guard:** If `Shipment.destinationPort == 'TT_POS'` (or any RHD market) and a worker scans a part marked `steeringSideCompatibility == 'LHD_ONLY'`, the system blocks the scan with a warning modal: *"LHD-ONLY PART BLOCKED: Trinidad is a Right-Hand-Drive market. Confirm explicit buyer override to pack."* Additionally, parts must have `oemFitmentVerified == true` prior to export packing.
  2. **Floor-Exceeds-Market Guard (`RULE-PRC-001`):** If an item's computed `vaultFloorPriceTtdMinor > brokerMarketPriceTtdMinor`, the system flags a high-visibility `MARGIN_INVERSION_WARNING` blocking export packing unless explicitly overridden by `ARCHITECT_CFO`.
  3. **Two-Phase Marketplace Lock (Phase 1 Manual Fallback & Phase 3 API Sync):** If a scanned part is currently active on eBay (`ebaySyncState == 'SYNDICATED_LIVE'`), scanning it onto a pallet transitions `custodyState` to `ON_EXPORT_PALLET` and `ebaySyncState` to `EXPORT_LOCK_PENDING`. In **Phase 1** (prior to Phase 3 automated eBay API integration), transitioning from `EXPORT_LOCK_PENDING` to `EXPORT_LOCK_CONFIRMED` requires an explicit supervisor manual verification action confirming the eBay listing was ended/zeroed (logging the actor and timestamp in `AuditLog`). In **Phase 3+**, an `OutboxEvent` triggers the BullMQ worker to zero out eBay quantity automatically and reconciles against any late-arriving eBay order webhooks. The pallet cannot be sealed (`sealedAt`) until all child parts reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED`).
  4. **Environmental Prep Check:** A whole vehicle, watercraft, or drivetrain assembly cannot be sealed onto a shipment until `fluidsDrainedAt` is timestamped (and `steamCleanedReceiptKey` is uploaded for whole vehicles/watercraft).

#### FR-LOG-02: Broker-Ready Export & Customs Package Generator
* **Description:** Instead of attempting direct unverified customs EDI on Shipment #1, the system shall compile a deterministic, human-and-broker-verifiable **Export Compliance Dossier (PDF + CSV)** from the scanned shipment contents in **Phase 1A** (deferring automated CERS fixed-width `.txt` generation to the licensed customs broker for Shipment #1).
* **Outputs Generated:**
  1. **Commercial Invoice (PDF & CSV):** Groups parts by 6-digit HS Tariff Code (`8708.xx` for auto parts, `8407.xx` for engines, `8903.99` for Yamaha watercraft, `8479.89` for the A/C machine), displaying Importer of Record details, item descriptions, donor VIN/HIN provenance, declared arm's-length Wholesale FOB USD values (`RULE-CUST-003`), freight, insurance, and total CIF USD value.
  2. **Detailed Packing List (PDF & CSV):** Lists each `PLT-XXXXXX` pallet and whole unit, itemizing net weight ($\text{kg}$), crating tare weight ($22.0\text{ kg}$ default per ISPM-15 pallet), gross weight, and dimensions ($\text{L} \times \text{W} \times \text{H cm}$) for the freight forwarder's Ocean Bill of Lading.
  3. **CBSA CERS 48-Hour Marine Countdown & 6-Year Archive:** Tracks the mandatory 48-hour prior-to-vessel-loading CERS deadline on the dashboard and archives the licensed customs broker's final Proof of Report (POR) and export dossier into Canadian-resident storage for 6 years (automated CERS `.txt` bulk-load draft generation unlocks after Shipment #1).

---

### Module E: Adaptive Checkout, Trinidad Vault Intake, COD Gate Lock & FX Tracker (`src/modules/logistics-vault`)

#### FR-CHK-01: Single Adaptive Mobile Checkout (`/checkout`)
* **Description:** A single unified mobile checkout workflow (`/checkout`) that creates a `SaleTransaction` and dynamically adapts its UI, currency, channel attribution, and security gates based on the scanned item's custody node (`SaleMarketNode`: `ONTARIO_DOMESTIC` vs. `TRINIDAD_VAULT`).
* **Ontario Domestic Mode (`marketNode == 'ONTARIO_DOMESTIC'`):**
  * Triggered when `HUNTER_MECHANIC` or `ARCHITECT_CFO` scans a `PRT-XXXXXX` part or `AST-XXXXXX` whole vehicle located in Ontario (`KEMP` or `RAMS`).
  * Renders CAD pricing and requires selecting one of the `DomesticSaleChannel` selector pills: `OTTAWA_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RAMSAYVILLE_LOT_RETAIL`, or `WHOLESALE_MECHANIC_NETWORK` (plus `EBAY_MOTORS_SHIPPED` and `CAR_PART_WHOLESALE` for non-walk-in domestic fulfillment).
  * Requires uploading a `paymentProofStorageKey` (photo of cash count, Interac e-Transfer screenshot, or wire confirmation) to `R2_PRIVATE_EVIDENCE_BUCKET`.
* **Automatic Post-Checkout Side Effects in Ontario Mode:**
  1. **Immediate eBay Delist (`OutboxEvent`):** Emits `PartSoldLocallyDelistEbayRequested` in the same ACID database transaction to immediately zero out / withdraw any active eBay Motors offer so local cash sales never double-sell online.
  2. **VIN Break-Even Velocity & Capital Buffer Credit:** Computes `netRealizedCadMinor` (`grossCollectedMinor - platformFeeMinor - shippingCostMinor`) and credits it directly to the donor vehicle's Break-Even Velocity counter and the $20k Capital Buffer.
  3. **Taz's Shop Float Cash-Custody Tracking:** Tracks physical cash custody (`HELD_BY_TAZ_FLOAT` for cash in Taz's hands vs. `SETTLED_CANADA_BANK` for Interac e-Transfer/wire/payouts) as an auditable shop petty-cash float that can be drawn down when logging shop `Expense` receipts (`paidFromCashCustody = 'HELD_BY_TAZ_FLOAT'`).
  4. **Whole-Vehicle Lot Release (`RAMSAYVILLE_LOT_RETAIL`):** Enforces uploading a signed Bill of Sale (`billOfSaleStorageKey`) at both the API and PostgreSQL `CHECK` constraint layers, transitions the `Vehicle` to `SOLD_RETAIL_ONTARIO`, and frees up 1 of the 8 Ramsayville shop lot capacity slots.

#### FR-VLT-01: Landed Container Check-In & Discrepancy Alerting
* **Description:** When a shipment clears Port of Spain customs and arrives at the family warehouse, the `TRINIDAD_VAULT_ADMIN` scans each whole asset and `PRT-XXXXXX` part tag onto a local vault shelf barcode (`POSV-V01-R01-S01-B01`).
* **Acceptance Criteria:**
  * Scanned parts transition `custodyState` from `IN_TRANSIT_OCEAN_FREIGHT` to `SHELVED_TRINIDAD_VAULT` (whole vehicles/watercraft transition `lifecycleState` to `LANDED_TRINIDAD_VAULT`), update `storageLocationId`, and append a `CustodyEvent`.
  * Any manifested SKU not scanned into the vault within 24 hours of unstuffing flags a **Transit Shrinkage Exception** on the CFO dashboard.

#### FR-VLT-02: Landed Cost Allocation, TTD Floor Pricing & 3-Tier Shipment P&L
* **Description:** Upon entering the final customs broker assessment (`assessedDutyTtdMinor`, `assessedVatTtdMinor`, port drayage, and ocean freight) on the `Shipment`, the system allocates landed costs across all parts and whole units on the shipment (weighted by declared FOB value and weight), computes each item's minimum Cash-on-Delivery price (`vaultFloorPriceTtdMinor`), and tracks the shipment across the **3-Tier Shipment Profitability Model** (Tier 1 Projected Contribution CAD, Tier 2 Realized Operating Profit TTD/CAD, and Tier 3 Repatriated Cash Return CAD as defined in `DOMAIN-RULES.md` Section 4.4):
  $$\text{Floor}_{\text{TTD}} = \frac{\left(\text{CostBasis}_{\text{CAD}} \times (1 + \text{TargetMarkup}) \times \text{FX}_{\text{CAD\_to\_USD}} \times \text{FX}_{\text{shadow}}\right) + \text{AllocatedLandedTaxesAndFreight}_{\text{TTD}}}{1 - r_{\text{comm}}}$$
* **Business Rules:**
  * All tariff rates, VAT percentages ($12.5\%$), broker commission rates ($5\%\text{–}10\%$), and shadow FX reserve rates are read from the versioned configuration register (`DOMAIN-RULES.md`), never hardcoded in business logic.

#### FR-VLT-03: Strict COD Verification & Phased Gate Release
* **Description:** When a buyer or commissioned broker arrives at the Port of Spain Vault to purchase parts or watercraft, the system enforces a hard separation between sales selection and payment verification.
* **Business Rules:**
  1. Only `TRINIDAD_VAULT_ADMIN` or `ARCHITECT_CFO` with an active MFA-verified JWT session (`aal2`) can execute `verifyCodPayment`.
  2. The mutation rejects any payment where `grossCollectedMinor < sum(vaultFloorPriceTtdMinor)` unless an explicit CFO discount override is signed.
  3. The admin must upload a payment proof photo (cash count or verified bank wire receipt) to `R2_PRIVATE_EVIDENCE_BUCKET`.
  4. **Trinidad FIU / CDD Compliance Gate (Encrypted Private ID Storage):** If a single transaction or linked buyer transactions total $\ge \text{TT\$50,000}$ (e.g., selling the Yamaha Jet or VR watercraft), the UI enforces uploading a photo/scan of the buyer's government ID (`buyerIdDocumentStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) and capturing the AES-256-GCM application-encrypted ID type and number (`buyerIdNumberEncrypted`) so records can be produced during a statutory FIU audit.
  5. **Phase 1 & 2 Atomic Release vs. Phase 3 Two-Step Gate Token:** In **Phase 1 and 2**, upon payment verification, the system marks the broker's commission as payable, sets item `availabilityState = 'PAID_SETTLED'`, and atomically stamps `gateReleasedAt = now()`, transitioning child parts to `custodyState = 'SOLD_AND_RELEASED'` (and whole assets to `lifecycleState = 'SOLD_EXPORT_COD'`). In **Phase 3** (when dedicated exit guards operate separately from counter staff), verification issues a **Single-Use HMAC-SHA256 Gate Release QR Token** (`gateTokenNonce`, valid for 4 hours) consumed at the warehouse exit (returning HTTP `410 Gone` on replay).

#### FR-VLT-04: Commercial Bank Cap & FX Repatriation Batch Ledger
* **Description:** Tracks TTD cash deposited into Trinidadian commercial banks and logs conversion batches (`CurrencySettlement`) back into CAD/USD.
* **Acceptance Criteria:**
  * Displays running TTD balances per bank institution and triggers a warning banner at $\text{TTD \$180,000}$ (protecting the $\text{TTD \$200,000}$ Deposit Insurance Corporation limit on TTD accounts).
  * Records the `effectiveClearingRate` and `fxSlippageLossCadMinor` on every repatriation wire so future TTD floor prices automatically adjust to real-world FX spreads.

---

## 4. Phase 2 Functional Requirements (Offline PWA, Blind Cycle Counts & CFO Subledger)

### Module E (Phase 2 Extension): Vault Anti-Shrinkage & Deposit Reconciliation (`src/modules/logistics-vault`)

#### FR-VLT-05: Weekly Blind Cycle Counts & Bank Deposit Reconciliation
* **Description:** Replaces single-operator gate-token theatre with physical inventory verification. Once per week (or triggered on demand by `ARCHITECT_CFO`), the system generates a `CycleCountTask` batch selecting up to 10 random `SHELVED_TRINIDAD_VAULT` parts/vehicles without revealing the expected shelf bin prior to arrival.
* **Acceptance Criteria:**
  * `TRINIDAD_VAULT_ADMIN` must scan the physical QR code on the shelf (`scannedLocationBarcode`) and capture a live timestamped photo (`liveVerificationPhotoKey` in `R2_PRIVATE_EVIDENCE_BUCKET`).
  * Any missing or unverified item transitions the task to `DISCREPANCY_ALERT` on the CFO Dashboard and cross-checks physical Vault stock against recorded `SaleTransaction` rows and TTD bank deposit slips.

### Module F: "Bad Cop" CFO Deal Analyzer & Expense Subledger (`src/modules/cfo-subledger`)

#### FR-DEAL-01: Pre-Auction Deal Analyzer & Capital Gate
* **Description:** Before bidding on a vehicle or watercraft, `HUNTER_MECHANIC` enters the VIN/HIN, auction location, estimated repair items, and target operational lane.
* **Business Rules:**
  1. Computes Maximum Allowable Bid ($B_{\text{max}}$) by deducting auction buyer fees, towing, estimated shop labor/parts, inspection fees, and the lane's minimum target profit from conservative gross realization.
  2. Checks active physical capacity limits (max 8 active vehicles at Ramsayville shop; max 4 uncrushed stripped shells at Kemptville yard) and available working capital pool.
  3. Blocks moving a deal to `ACQUIRED_IN_TRANSIT` if the bid exceeds $B_{\text{max}}$ or breaches capacity/capital gates without an audit-logged `ARCHITECT_CFO` approval.

#### FR-EXP-01: Receipt-Enforced Expense Subledger & External GL Sync
* **Description:** Every dollar spent (auction invoice, towing, aftermarket repair parts, shop labor, freight, customs duty) must be logged as an `Expense` linked to a `Vehicle` or `Shipment`.
* **Acceptance Criteria:**
  * Submitting an expense without a valid `receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET` fails at both the API validation layer (HTTP `422`) and the PostgreSQL `CHECK` constraint layer.
  * Confirmed expenses and vault sales emit an `OutboxEvent` that syncs the journal entry to QuickBooks Online / Xero via `IAccountingGlPort`.

---

## 5. Phase 3 Functional Requirements (Assistive AI, eBay & B2B Portal)

### Module B & C: Assistive AI Vision & Multi-Channel Syndication (`src/modules/marketplace`)

#### FR-AI-01: Human-in-the-Loop AI Vision Enrichment
* **Description:** A BullMQ worker processes newly stripped parts through background cleanup and `IVisionEnrichmentPort` to extract stamped OEM part numbers, suggest ARA condition grades (`A`, `B1`, `B2`, `B3`, `C`), and draft an 80-character eBay title.
* **Acceptance Criteria:**
  * All AI outputs are treated as assistive proposals. If `aiConfidenceScore < 0.80`, or if no OEM part number is legible, or if the part is safety-critical, the part transitions to `complianceState = 'NEEDS_HUMAN_REVIEW'` and cannot auto-publish to eBay.
  * Pricing baseline queries use the eBay `Browse API` (active competitor floor/median prices) plus internal historical sell-through data rather than relying on the restricted eBay `Marketplace Insights API`.

#### FR-MKT-01: Two-Tab "Live Container" Storefront & Wish-List Engine
* **Description:** Provides overseas B2B buyers and brokers with a mobile catalog split into **Tab 1 ("In Stock — Port of Spain Vault")** and **Tab 2 ("Loading in Ontario")**, hiding all Canadian acquisition costs and domestic eBay prices.
* **Acceptance Criteria:**
  * Buyers can place a rate-limited 24-hour reservation hold (`B2BReservation` on either a `Part` or a whole `Vehicle`, enforced by partial unique indexes to prevent overlapping active holds) or submit a `PreOrderWishList` request (filtered by `RHD_ONLY` or `UNIVERSAL` `SteeringSideCompatibility`) that automatically alerts the Deal Analyzer when a matching donor vehicle is evaluated in Ontario.

---

## 6. Non-Functional Requirements (NFRs) & Quality Gates

* **NFR-SEC-01 (Storage Isolation):** `R2_PRIVATE_EVIDENCE_BUCKET` shall block all public access. Receipts, UVIPs, bank deposit slips, and encrypted customer government ID documents (`buyerIdDocumentStorageKey`) may only be accessed via server-generated pre-signed URLs with a maximum TTL of 15 minutes, logged in `AuditLog`.
* **NFR-REL-01 (Offline Queue Durability):** The Yard PWA shall queue binary photo blobs and `CustodyEvent` mutations in IndexedDB (`Dexie.js`), display a persistent high-contrast badge showing the count of unsynced items, and block user logout or cache clearing while unsynced mutations exist.
* **NFR-IDEM-01 (End-to-End Idempotency):** Every barcode scan, offline batch sync, eBay webhook, and WhatsApp webhook must supply a deterministic `Idempotency-Key` enforced by PostgreSQL unique constraints so network retries or double-taps never duplicate records.
* **NFR-ACC-01 (Gloved & Outdoor Usability):** All mobile scanner and Vault POS screens must conform to WCAG 2.2 AA contrast ratios ($> 4.5:1$), use minimum $56 \times 56\text{ px}$ touch targets for gloved operation, and pair every color indicator (red/green) with distinct text, icon, and audio/haptic cues.