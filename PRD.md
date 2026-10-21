# PRD-MVP.md — Functional Specification & Phased Execution Backlog

## 1. Product Scope & Operational Mandate

This Product Requirements Document (PRD) defines the functional workflows, role permissions, acceptance criteria, and phased delivery milestones for the **Cross-Border Salvage, Rebuild & Vault ERP**. 

To avoid premature engineering bloat, delivery is strictly gated by operational proof:
* **Phase 1 (Days 1–30 — Chain-of-Custody & Trinidad LCL Shipment #1 MVP):** Asset intake, QR tagging, append-only bin/pallet custody tracking, LHD/RHD compatibility filtering, broker-ready Commercial Invoice & Packing List export, and Trinidad Vault Cash-on-Delivery (COD) checkout.
* **Phase 2 (Days 31–60 — Yard Offline Resilience & CFO Subledger):** Offline-first IndexedDB Stripper PWA, "Bad Cop" Pre-Auction Deal Analyzer, receipt-enforced Expense Subledger, and QuickBooks/Xero GL sync.
* **Phase 3 (Months 3–6 — Assistive AI Vision, Two-Phase eBay Sync & B2B Storefront):** BullMQ AI Vision OCR/grading proposals, eBay Inventory/Browse API integration with Two-Phase Export Locking (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`), and the Live Container B2B Storefront with WhatsApp notifications.

---

## 2. Sanitized Role-Based Access Control (RBAC) Matrix

Authentication is enforced via Supabase Auth with Row-Level Security (RLS) and API route guards. Users holding `ARCHITECT_CFO` or `TRINIDAD_VAULT_ADMIN` roles MUST have Multi-Factor Authentication (`mfaEnrolled = true`) enabled prior to executing financial or gate-release mutations.

| Capability / Requirement ID | `ARCHITECT_CFO` | `HUNTER_MECHANIC` | `ONTARIO_STRIPPER` | `TRINIDAD_VAULT_ADMIN` | `OVERSEAS_B2B_BUYER` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **FR-DEAL-01:** Create Pre-Auction Deal Proposal | CRUD + Approve | Create / Read | No Access | No Access | No Access |
| **FR-DEAL-02:** Override Capital Gate Lock | Execute (Audited) | Denied | No Access | No Access | No Access |
| **FR-INT-01:** Intake Whole Asset (Auto / Marine / Equip) | CRUD | Create / Update | Read (Strip Queue) | Read (Exported) | No Access |
| **FR-INT-02:** Strip Part, Bind QR & Scan Bin | CRUD | Create / Relocate | Create / Relocate | No Access | No Access |
| **FR-EXP-01:** Log Expense with Private Receipt | CRUD + Reversal | Create / Read | No Access | Create (Port Fees) | No Access |
| **FR-LOG-01:** Scan Parts/Assets to Export Pallet | CRUD | Create / Read | Execute Scan | Read Manifest | Read ("Loading" Tab) |
| **FR-LOG-02:** Seal Pallet & Export Broker Package | CRUD + Seal | Read Packing List | No Access | Read / Download | No Access |
| **FR-VLT-01:** Check-In Landed Shipment to Vault | CRUD | Read Status | No Access | Execute Check-In | No Access |
| **FR-VLT-02:** Create 24h B2B Part Reservation | CRUD | Create (Broker) | No Access | CRUD | Create (Rate-Limited) |
| **FR-VLT-03:** Verify COD Payment & Issue Gate Token | Read + Audit | **Denied (Hard Lock)** | No Access | **Execute (Exclusive)** | No Access |
| **FR-VLT-04:** Log Broker Commission & FX Batch | CRUD + Reconcile | Read Own Leads | No Access | Create / Execute | Read Own Commission |

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

#### FR-INT-02: 3-Tap Part Strip, QR Binding & Drive-Side Tagging
* **Description:** Workers stripping a donor vehicle shall bind each physical component to a pre-printed weatherproof QR label (`PRT-XXXXXX`), capture 3 photos, classify drive-side compatibility, and scan a destination storage bin QR code (`KEMP-C01-R01-S01-B01`).
* **Business Rules:**
  1. All uploaded product photos are stripped of EXIF GPS coordinates and camera metadata before being written to `R2_PUBLIC_MEDIA_BUCKET`.
  2. Each stripped part must be tagged with `DriveSideCompatibility`:
     * `UNIVERSAL`: Engines, transmissions, doors, body panels, rear clips, suspension, wheels, and all marine components.
     * `LHD_ONLY`: Left-hand-drive steering racks, columns, dashboards, interior trim, master window switches, wiper linkages, and LHD-beam headlamps.
  3. **Hazmat & Safety Screen:** Any airbag module (`8708.95`) or uncertified hazardous component must be flagged `isHazmatOrAirbag = true` and automatically placed into `QUARANTINED_RECALL_OR_DG` (blocked from LCL air/ocean pallet scanning unless dangerous goods documentation is explicitly attached).
* **Acceptance Criteria:**
  * Scanning a duplicate `PRT-XXXXXX` code already bound to another part returns HTTP `409 Conflict` and triggers an immediate visual/audio alert.
  * Every location scan appends an immutable `PartCustodyEvent` containing the client's UUIDv7 `idempotencyKey` and `expectedPartVersion`.

---

### Module D: Pallet Consolidation & Broker-Ready Customs Package (`src/modules/logistics-vault`)

#### FR-LOG-01: LCL Pallet & Whole-Asset Consolidation Scan
* **Description:** Operators shall create an outbound `Shipment` (e.g., `EXP-2026-TT-001`) and `ShipmentPallet` (`PLT-2026-001`) and scan parts onto the pallet via mobile camera or Bluetooth 2D barcode scanner.
* **Business Rules:**
  1. **LHD-to-RHD Destination Guard:** If `Shipment.destinationPort == 'TT_POS'` (or any RHD market) and a worker scans a part marked `driveSideCompatibility == 'LHD_ONLY'`, the system blocks the scan with a warning modal: *"LHD-ONLY PART BLOCKED: Trinidad is a Right-Hand-Drive market. Confirm explicit buyer override to pack."*
  2. **Two-Phase Marketplace Lock:** If a scanned part is currently in `SYNDICATED_DOMESTIC_LIVE` (active on eBay), scanning it onto a pallet transitions the part to `EXPORT_LOCK_PENDING` and emits an `OutboxEvent` to zero out eBay quantity. The pallet cannot be sealed (`sealedAt`) until all child parts reach `EXPORT_LOCK_CONFIRMED` (or were never listed domestically).
  3. **Environmental Prep Check:** A whole vehicle, watercraft, or drivetrain assembly cannot be sealed onto a shipment until `fluidsDrainedAt` is timestamped (and `steamCleanedReceiptKey` is uploaded for whole vehicles/watercraft).

#### FR-LOG-02: Broker-Ready Export & Customs Package Generator
* **Description:** Instead of attempting direct unverified customs EDI on Shipment #1, the system shall compile a deterministic, human-and-broker-verifiable **Export Compliance Dossier (PDF + CSV + CERS Fixed-Width `.txt`)** from the scanned shipment contents.
* **Outputs Generated:**
  1. **Commercial Invoice (PDF & CSV):** Groups parts by 6-digit HS Tariff Code (`8708.xx` for auto parts, `8407.xx` for engines, `8903.99` for Yamaha watercraft, `8479.89` for the A/C machine), displaying Importer of Record details, item descriptions, donor VIN/HIN provenance, declared Wholesale FOB USD values, freight, insurance, and total CIF USD value.
  2. **Detailed Packing List (PDF & CSV):** Lists each `PLT-XXXXXX` pallet and whole unit, itemizing net weight ($\text{kg}$), crating tare weight ($22.0\text{ kg}$ default per ISPM-15 pallet), gross weight, and dimensions ($\text{L} \times \text{W} \times \text{H cm}$) for the freight forwarder's Ocean Bill of Lading.
  3. **CBSA CERS Bulk Upload Draft (`.txt`) & 48-Hour Marine Countdown:** Generates a fixed-length `.txt` draft conforming to CBSA CERS bulk-load specifications, tracks the mandatory 48-hour prior-to-vessel-loading deadline on the dashboard, and archives the final Proof of Report (POR) and export dossier into Canadian-resident storage for 6 years.

---

### Module E: Trinidad Vault Intake, COD Gate Lock & FX Tracker (`src/modules/logistics-vault`)

#### FR-VLT-01: Landed Container Check-In & Discrepancy Alerting
* **Description:** When a shipment clears Port of Spain customs and arrives at the family warehouse, the `TRINIDAD_VAULT_ADMIN` scans each whole asset and `PRT-XXXXXX` part tag onto a local vault shelf barcode (`POSV-V01-R01-S01-B01`).
* **Acceptance Criteria:**
  * Scanned parts transition from `IN_TRANSIT_OCEAN_FREIGHT` to `SHELVED_TRINIDAD_VAULT` and append a `PartCustodyEvent`.
  * Any manifested SKU not scanned into the vault within 24 hours of unstuffing flags a **Transit Shrinkage Exception** on the CFO dashboard.

#### FR-VLT-02: Landed Cost Allocation & TTD Floor Pricing
* **Description:** Upon entering the final customs broker assessment (`assessedDutyTtdMinor`, `assessedVatTtdMinor`, port drayage, and ocean freight) on the `Shipment`, the system allocates landed costs across all items on the shipment (weighted by declared FOB value and weight) and computes each item's minimum Cash-on-Delivery price (`vaultFloorPriceTtdMinor`):
  $$\text{Floor}_{\text{TTD}} = \frac{\left(\text{CostBasis}_{\text{CAD}} \times (1 + \text{TargetMargin}) \times \text{FX}_{\text{CAD\_to\_USD}} \times \text{FX}_{\text{shadow}}\right) + \text{AllocatedLandedTaxesAndFreight}_{\text{TTD}}}{1 - r_{\text{comm}}}$$
* **Business Rules:**
  * All tariff rates, VAT percentages ($12.5\%$), broker commission rates ($5\%\text{–}10\%$), and shadow FX reserve rates are read from the versioned configuration register (`DOMAIN-RULES.md`), never hardcoded in business logic.

#### FR-VLT-03: Strict COD Verification & Single-Use Gate Token
* **Description:** When a buyer or commissioned broker arrives at the Port of Spain Vault to purchase parts or watercraft, the system enforces a hard separation between sales selection and payment verification.
* **Business Rules:**
  1. Only `TRINIDAD_VAULT_ADMIN` (or `ARCHITECT_CFO`) with active MFA can execute `verifyCodPayment`.
  2. The mutation rejects any payment where `grossCollectedMinor < sum(vaultFloorPriceTtdMinor)` unless an explicit CFO discount override is signed.
  3. The admin must upload a payment proof photo (cash count or verified bank wire receipt) to `R2_PRIVATE_EVIDENCE_BUCKET`.
  4. **Trinidad FIU / CDD Compliance Gate:** If a single transaction or linked buyer transactions total $\ge \text{TT\$50,000}$ (e.g., selling the Yamaha Jet or VR watercraft), the UI enforces capturing the buyer's verified government ID reference (`buyerNationalIdHash`) prior to payment completion.
  5. Upon verification, the system marks the broker's commission as payable and generates a **Single-Use HMAC-SHA256 Gate Release QR Token** (`gateTokenNonce`, valid for 4 hours).
  6. Scanning the Gate Token at the warehouse exit atomically sets `gateReleasedAt = now()` and transitions the items to `RELEASED_AT_VAULT_GATE`. A second scan of the same token returns HTTP `410 Gone` ("GATE PASS ALREADY CONSUMED").

#### FR-VLT-04: Commercial Bank Cap & FX Repatriation Batch Ledger
* **Description:** Tracks TTD cash deposited into Trinidadian commercial banks and logs conversion batches (`CurrencySettlement`) back into CAD/USD.
* **Acceptance Criteria:**
  * Displays running TTD balances per bank institution and triggers a warning banner at $\text{TTD \$180,000}$ (protecting the $\text{TTD \$200,000}$ Deposit Insurance Corporation limit on TTD accounts).
  * Records the `effectiveClearingRate` and `fxSlippageLossCadMinor` on every repatriation wire so future TTD floor prices automatically adjust to real-world FX spreads.

---

## 4. Phase 2 Functional Requirements (Offline PWA & CFO Subledger)

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
  * All AI outputs are treated as assistive proposals. If `aiConfidenceScore < 0.80`, or if no OEM part number is legible, or if the part is safety-critical, the part transitions to `NEEDS_HUMAN_REVIEW` and cannot auto-publish to eBay.
  * Pricing baseline queries use the eBay `Browse API` (active competitor floor/median prices) plus internal historical sell-through data rather than relying on the restricted eBay `Marketplace Insights API`.

#### FR-MKT-01: Two-Tab "Live Container" Storefront & Wish-List Engine
* **Description:** Provides overseas B2B buyers and brokers with a mobile catalog split into **Tab 1 ("In Stock — Port of Spain Vault")** and **Tab 2 ("Loading in Ontario")**, hiding all Canadian acquisition costs and domestic eBay prices.
* **Acceptance Criteria:**
  * Buyers can place a rate-limited 24-hour reservation hold (`B2BReservation`) or submit a `PreOrderWishList` request (filtered by `RHD_ONLY` or `UNIVERSAL` compatibility) that automatically alerts the Deal Analyzer when a matching donor vehicle is evaluated in Ontario.

---

## 6. Non-Functional Requirements (NFRs) & Quality Gates

* **NFR-SEC-01 (Storage Isolation):** `R2_PRIVATE_EVIDENCE_BUCKET` shall block all public access. Receipts, UVIPs, bank deposit slips, and customer ID hashes may only be accessed via server-generated pre-signed URLs with a maximum TTL of 15 minutes, logged in `AuditLog`.
* **NFR-REL-01 (Offline Queue Durability):** The Yard PWA shall queue binary photo blobs and `PartCustodyEvent` mutations in IndexedDB (`Dexie.js`), display a persistent high-contrast badge showing the count of unsynced items, and block user logout or cache clearing while unsynced mutations exist.
* **NFR-IDEM-01 (End-to-End Idempotency):** Every barcode scan, offline batch sync, eBay webhook, and WhatsApp webhook must supply a deterministic `Idempotency-Key` enforced by PostgreSQL unique constraints so network retries or double-taps never duplicate records.
* **NFR-ACC-01 (Gloved & Outdoor Usability):** All mobile scanner and Vault POS screens must conform to WCAG 2.2 AA contrast ratios ($> 4.5:1$), use minimum $56 \times 56\text{ px}$ touch targets for gloved operation, and pair every color indicator (red/green) with distinct text, icon, and audio/haptic cues.