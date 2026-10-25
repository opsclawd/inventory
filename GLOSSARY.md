# Unified Operations & Compliance ERP

Multi-tenant physical inventory, chain-of-custody, and unit-economics platform operating both the Ontario-to-Trinidad Auto/Marine Salvage & Flip venture (`ORG_SALVAGE_EXPORT` — `salvage` schema) and the Brockville/Kemptville Health Canada Cannabis Nursery & Processing venture (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` schema), architected with commercial vertical-SaaS generalizations on a shared operational core (`shared` schema).

## Shared Operations, Policy Configuration & Physical Custody (`shared` Schema)

**Organization**:
A distinct legal and regulatory business entity (`OrganizationType`: `SALVAGE_AND_EXPORT` or `CANNABIS_NURSERY_AND_PROCESSING`, identified by `slug` and `code`) whose inventory, locations, expenses, and audit logs are strictly isolated via PostgreSQL multi-schema partitioning and Row-Level Security (RLS), with optional per-tenant JSON policy overrides (`policyConfigJson`).
_Avoid_: Tenant, company, workspace, account

**Organization Membership**:
The binding between a User and an Organization that assigns the User's `UserRole` within that entity and governs which workspaces appear in the top-left Organization Workspace Switcher.
_Avoid_: Team role, user tenant link, account access

**Policy Configuration Port (`IPolicyConfigPort`)**:
The hexagonal port (`getPolicyForOrg(organizationId)`) that loads versioned tariff, FX, margin, compensation, site capacity, and cannabis mass-balance parameters from `src/core/config/pricing-policy.json` merged with any tenant-specific `Organization.policyConfigJson` overrides.
_Avoid_: Hardcoded constants, env config, global settings

**Storage Location**:
A scannable hierarchical physical slot (`Site -> Zone -> Container/Room -> Rack -> Shelf/Table -> Bin`) where a Vehicle, Part, or Cannabis Lot resides, governed by two data-driven columns: `allowedOrgType` (`SALVAGE_AND_EXPORT` vs. `CANNABIS_NURSERY_AND_PROCESSING`) and `maxActiveAssetCapacity` (seeded to `4` for the Kemptville Dismantling Pad, `8` for the Ramsayville Retail Lot, and `null` for standard shelf bins).
_Avoid_: Bin, shelf, warehouse spot, address

**Site Zoning (`RULE-ZONE-001`)**:
The data-driven physical and regulatory boundary enforced by `StorageLocation.allowedOrgType` and `StorageLocation.maxActiveAssetCapacity` that partitions the 19-acre Kemptville property into the salvage container pad (`ZONE_CONTAINER_PAD`, `SALVAGE_AND_EXPORT`, max 4 shells) and the greenhouse/tree-farm agricultural zones (`ZONE_GREENHOUSE_AG`, `ZONE_TREE_FARM`, `CANNABIS_NURSERY_AND_PROCESSING`), rejecting cross-tenant scans with `422 SITE_ZONING_VIOLATION`.
_Avoid_: Hardcoded site check, property split, yard section

**Custody Event**:
An immutable, idempotent (`idempotencyKey`), timestamped record of a physical `Vehicle`, `Part`, or `CannabisLot` (enforced by a single-target SQL `CHECK` constraint) being scanned into a new `StorageLocation` or `ShipmentPallet` by an operator, tracking optimistic concurrency (`expectedVersion` and `hasConflict`).
_Avoid_: Location update, move log, scan history, bin change

**Expense**:
An immutable, receipt-backed (`receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) cost record scoped to an `Organization` and linked to a `Vehicle`, `Shipment`, or `CannabisLot`, corrected exclusively via append-only reversal entries (`isReversalEntry = true`).
_Avoid_: Bill, payout, voucher, cost entry

**Cash Custody Transfer**:
A receipt-backed (`depositSlipStorageKey`) movement of physical cash from an `OperatorFloat` (`HELD_IN_OPERATOR_FLOAT`) into the origin corporate bank (`SETTLED_ORIGIN_CORP_BANK`) or from the destination export vault safe (`HELD_IN_DESTINATION_VAULT`) into a destination commercial bank (`DEPOSITED_DESTINATION_BANK`).
_Avoid_: Bank drop, cash deposit, sweep

**Outbox Event**:
A transactional domain event persisted in the same ACID database commit as a state change to trigger asynchronous side effects (such as eBay inventory zeroing or QuickBooks/Xero accounting sync) via background workers.
_Avoid_: Webhook job, queue message, async task

**Audit Log**:
An append-only security record protected by PostgreSQL triggers (`prevent_audit_tampering`) capturing actor, action, before/after state, and IP address for privileged mutations and private R2 evidence presigned URL generation.
_Avoid_: Activity log, system history, trace

## Salvage, Dismantling & Domestic Flips (`salvage` Schema)

**Vehicle**:
A whole parent asset (`AST-YYYY-XXXX`) acquired for flipping, rebuilding, dismantling, or whole-unit export, encompassing road automobiles (`AUTOMOBILE` — 17-char VIN), recreational watercraft (`WATERCRAFT` — 12-char HIN, `roadBrand = NOT_APPLICABLE`), and commercial shop equipment (`SHOP_EQUIPMENT` — Serial Number, `roadBrand = NOT_APPLICABLE`).
_Avoid_: Donor, salvage unit, car, unit, asset

**Part**:
A discrete physical component (`Quantity = 1`) stripped from a donor `Vehicle` and identified by a unique weatherproof QR SKU (`PRT-XXXXXX`).
_Avoid_: Component, item, piece, spare

**Operational Lane**:
The commercial track (`OperationalLane`) assigned to a `Vehicle` upon acquisition: `QUICK_TURN_BEATER`, `HIGH_END_REBUILD`, `DISMANTLE_AND_EXPORT`, or `WHOLE_UNIT_EXPORT`.
_Avoid_: Track, workflow, strategy, vehicle type

**Orthogonal Part State Axes**:
The four independent state dimensions governing a `Part` simultaneously without state-explosion:
1. **`PartCustodyState` (Physical Custody):** `STRIPPED_RAW_OFFLINE`, `SHELVED_ORIGIN_CONTAINER`, `ON_EXPORT_PALLET`, `IN_TRANSIT_OCEAN_FREIGHT`, `SHELVED_DESTINATION_VAULT`, `SOLD_AND_RELEASED`, `SCRAPPED_OR_DESTROYED`.
2. **`InventoryAvailabilityState` (Commercial Reservation/Sale):** `AVAILABLE`, `RESERVED_B2B_HOLD`, `COMMITTED_DOMESTIC_ORDER`, `PAID_PENDING_GATE_RELEASE`, `PAID_SETTLED`.
3. **`EbaySyncState` (Marketplace Lock):** `NOT_LISTED`, `DRAFT_ENRICHED`, `SYNDICATED_LIVE`, `EXPORT_LOCK_PENDING`, `EXPORT_LOCK_CONFIRMED`, `DELISTED_SOLD`.
4. **`PartComplianceState` (Safety & Enrichment Readiness):** `CLEAR_FOR_SYNDICATION`, `NEEDS_HUMAN_REVIEW`, `QUARANTINED_RECALL_OR_DG`.
_Avoid_: Part status, single lifecycle enum, item state

**Steering-Side Compatibility**:
The physical cockpit and traffic-side geometry classification of a `Part` (`UNIVERSAL`, `LHD_ONLY`, or `RHD_ONLY`) determining whether it can be exported to Right-Hand-Drive markets (`RULE-FIT-001`, `RULE-FIT-002`).
_Avoid_: Drive side, LHD/RHD flag, fitment type

**OEM Fitment Verification**:
The explicit confirmation (`oemFitmentVerified = true`) that a `Part`'s stamped OEM or interchange part number matches the target destination-market vehicle trim, engine, and model year, independent of `SteeringSideCompatibility`.
_Avoid_: Universal fit, compatibility check, part match

**Uncrushed Hulk**:
A stripped donor `Vehicle` shell (`HULK_AWAITING_SCRAP`) remaining on the dismantling pad prior to being weighed and hauled away by a scrap metal recycler (`SCRAPPED_METAL_CLEARED`).
_Avoid_: Carcass, shell, bare metal, scrap car

**Two-Phase Export Lock**:
The reservation protocol that blocks an eBay-listed `Part` from being sealed into an outbound `ShipmentPallet` until its online marketplace quantity is confirmed zeroed (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`, via supervisor manual verification in Phase 1 or automated eBay API sync in Phase 3).
_Avoid_: eBay sync, delist lock, inventory hold

**Local Ad Payload**:
A pre-formatted bundle of SEO title, CAD ask price (`retailPriceCadMinor`), OEM fitment notes, and sanitized `R2_PUBLIC_MEDIA_BUCKET` WebP URLs consumed by the Manifest V3 Chrome Extension (`FR-MKT-02`) to autofill Facebook Marketplace (`FB_MARKETPLACE_LOCAL`) and Kijiji (`KIJIJI_LOCAL`) listings.
_Avoid_: FB post, Kijiji draft, scraper template

## Export Logistics & Destination Bonded Vault (`salvage` Schema)

**Shipment**:
A consolidated outbound ocean freight movement (`EXP-YYYY-TT-XXX`) travelling from Canada to a destination port (`TT_POS` or `BB_BGI`) under a single customs declaration package.
_Avoid_: Container load, export batch, manifest, vessel run

**Shipment Pallet**:
A physical crated or shrink-wrapped pallet (`PLT-YYYY-XXX`) within a `Shipment` that holds scanned `Part` SKUs (`ON_EXPORT_PALLET`) and cannot be sealed (`sealedAt`) until all child parts reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED`) and clear hazmat/environmental gates.
_Avoid_: Skid, crate, box, lot

**Export Compliance Dossier**:
The deterministic CSV and PDF package generated from a sealed `Shipment` in Phase 1A (`FR-LOG-02`)—comprising the HS-grouped Commercial Invoice (using arm's-length wholesale FOB USD per `RULE-CUST-003`) and Gross/Tare/Net Packing List—handed to the licensed customs broker for CBSA CERS and Trinidad ASYCUDA filing.
_Avoid_: Shipping papers, customs form, export sheet

**Destination Export Vault (`DESTINATION_EXPORT_VAULT`)**:
The bonded family-owned commercial warehouse in Port of Spain (`POSV`) where landed export inventory (`SHELVED_DESTINATION_VAULT` / `LANDED_TRINIDAD_VAULT`) is stored, audited via weekly blind cycle counts (`FR-VLT-05`), and released strictly upon MFA `aal2` verified Cash-on-Delivery payment (`DESTINATION_VAULT_COD`).
_Avoid_: Overseas warehouse, Port of Spain depot, bonded store

**Vault Floor Price (`vaultFloorPriceTtdMinor`)**:
The minimum permissible Trinidad & Tobago Dollar (TTD) selling price for an exported item that recovers allocated Canadian cost basis, target export markup ($65\%$), compounded customs duty/VAT, shadow FX repatriation spread ($\text{FX}_{\text{shadow}}$), and pre-VAT broker commission (`RULE-PRC-002`). Branches on `isTrinidadEntityVatRegistered`: when `false` (Phase 1 default), the $12.5\%$ import VAT is included in the floor numerator as a non-recoverable cost and checkout `taxOrVatMinor = 0`; when `true`, import VAT is excluded as a recoverable Input Tax Credit and $12.5\%$ output VAT is charged at checkout with a `taxInvoiceNumber`.
_Avoid_: Minimum price, reserve price, landed price, wholesale ask

**Broker Market Price (`brokerMarketPriceTtdMinor`)**:
The expected local destination selling price quoted by an on-island sales broker, compared against `vaultFloorPriceTtdMinor` prior to shipping.
_Avoid_: Street price, island price, broker estimate

**Margin Inversion Warning (`RULE-PRC-001`)**:
A pre-shipment block triggered when an item's computed `vaultFloorPriceTtdMinor` exceeds its `brokerMarketPriceTtdMinor`, preventing unprofitable inventory from being packed onto an export pallet without an explicit `ARCHITECT_CFO` override.
_Avoid_: Price alert, loss warning, negative margin flag

**B2B Reservation**:
A time-boxed 24-hour hold (`B2BReservation`) placed by an overseas mechanic or broker on a specific in-stock or in-transit `Part` or `Vehicle`, protected against double-booking by partial unique PostgreSQL indexes (`unique_active_part_reservation`, `unique_active_vehicle_reservation`).
_Avoid_: Pre-order, cart hold, booking

**Pre-Order Wish List**:
A standing demand request (`PreOrderWishList`) from an overseas buyer specifying a target vehicle make, model, year range, and maximum TTD bid for parts not yet in stock (also serving as an explicit buyer override for `LHD_ONLY` parts).
_Avoid_: Backorder, want list, buyer lead

**Sale Transaction**:
An immutable checkout record (`SaleTransaction`) capturing domestic origin (`SaleMarketNode.DOMESTIC_ORIGIN`: `LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `WHOLESALE_MECHANIC_NETWORK`, `EBAY_MOTORS_SHIPPED`, `CAR_PART_WHOLESALE`) or destination export vault (`SaleMarketNode.DESTINATION_EXPORT_VAULT`: `DESTINATION_VAULT_COD`, `DESTINATION_PRE_ORDER_PICKUP`, `SECONDARY_ISLAND_WHOLESALE`) sales, payment proof, channel attribution, `CashCustodyState`, FIU rolling 30-day CDD verification (`RULE-COMP-FIU-01`), and gate release timestamps.
_Avoid_: Order, invoice, receipt, checkout log

**Blind Cycle Count**:
A weekly anti-shrinkage audit task (`CycleCountTask`, `FR-VLT-05`) requiring the `TRINIDAD_VAULT_ADMIN` to physically scan and photograph a random sample of `SHELVED_DESTINATION_VAULT` items without seeing their expected shelf locations beforehand.
_Avoid_: Stocktake, inventory audit, shelf check

**Currency Settlement**:
A batched foreign-exchange conversion (`CurrencySettlement`, `FR-VLT-04`) of deposited TTD funds (`DEPOSITED_DESTINATION_BANK`) from a Trinidad commercial bank into settled CAD/USD in the origin corporate bank account (`SETTLED_ORIGIN_CORP_BANK`), recording `effectiveClearingRate` and `fxSlippageLossCadMinor`.
_Avoid_: Wire transfer, FX trade, repatriation wire

## Unit Economics, Cash Custody & Compensation (`shared` & `salvage` Schemas)

**Working Capital Principal Buffer**:
The $20,000 CAD bi-monthly investor capital pool (`workingCapitalPrincipalBufferCadMinor`) reserved strictly for inventory acquisition, repair parts, piece-rate stripping, and freight—never for founder salaries (`RULE-PAY-002`).
_Avoid_: Investor loan, bank balance, operating budget, slush fund

**Operator Float (`HELD_IN_OPERATOR_FLOAT`)**:
Physical domestic cash collected from local sales (`LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`) and held in the field operator's custody (e.g., Taz's Ontario Shop Float) as an auditable petty-cash subledger balance that can fund receipted shop expenses (`paidFromCashCustody = 'HELD_IN_OPERATOR_FLOAT'`) or be swept to `SETTLED_ORIGIN_CORP_BANK` via `CashCustodyTransfer`.
_Avoid_: Shop cash, pocket cash, petty cash, local float

**Two-Stage Pro-Rata Donor Cost Allocation**:
The accounting algorithm (`DOMAIN-RULES.md` Section 4.4) that resolves the timing gap between stripping a part on Day 2 and scrapping the hulk on Day 14:
1. **Stage 1 (Provisional Cost Basis at Strip Time):** Allocates donor purchase price plus direct expenses logged to date weighted by the part's grade-adjusted market value ($\text{GradeAdjustedMarketValue}_{\text{CAD}}$) divided by $\max(\text{TargetGrossRealization}_{\text{CAD}}, \sum \text{StrippedPartsMarketValue}_{\text{CAD}})$.
2. **Stage 2 (Final Cost Basis True-Up at Hulk Scrap):** Once `scrapRecoveryCadMinor` is recorded from `scrapMetalTicketKey`, reconciles remaining unrecovered donor outlay pro-rata across all remaining unsold parts so $\sum \text{Part.allocatedCostBasisCadMinor}_i + \text{Vehicle.scrapRecoveryCadMinor} = \text{Vehicle.totalAcquisitionAndStripCostCadMinor}$ holds to the exact cent.
_Avoid_: Part cost split, VIN cost sharing, flat average cost

**Piece-Rate Stripper Payout (`RULE-PAY-001`)**:
A flat per-vehicle labor payment (`YARD_STRIPPER_PIECE_RATE`, default $350 CAD) to an unskilled yard stripper (`ONTARIO_STRIPPER`) that unlocks only after `Vehicle.fluidsDrainedAt IS NOT NULL` and at least `minShelvedPartsForStripPayout` (35) barcoded, photographed `Part` records for that donor vehicle reach `SHELVED_ORIGIN_CONTAINER`.
_Avoid_: Stripper wage, hourly yard pay, dismantling fee

**Partner Profit Draw (`RULE-PAY-002` & `RULE-PAY-003`)**:
A founder compensation disbursement (`PARTNER_PROFIT_DRAW`) restricted strictly to positive `DistributableRealizedProfitPool_CAD` (`RULE-PAY-002`) and automatically netted against any outstanding `HELD_IN_OPERATOR_FLOAT` balance (`RULE-PAY-003`) before corporate bank cash is disbursed.
_Avoid_: Owner salary, founder wage, partner payout

## Cannabis Nursery & Processing (`cannabis` Schema)

**Cannabis Strain**:
A distinct genetic cultivar (`CannabisStrain`) registered within `ORG_CANNABIS_NURSERY_PROC` defining lineage, target cannabinoid percentages, and terpene profile for mother plants and downstream lots.
_Avoid_: Variety, SKU, plant type, flavor

**Cannabis Lot**:
A traceable biological or extracted inventory unit (`LOT-YYYY-XXXX`) tracked either by discrete plant count (`trackingUnit = 'PLANTS'`: `MOTHER_PLANT`, `CLONE_TRAY`, `VEGETATIVE_BATCH`) or continuous gram weight (`trackingUnit = 'GRAMS'`: `FRESH_HARVEST`, `DRIED_FLOWER`, `TRIM_BIOMASS`, `CRUDE_EXTRACT`, `DISTILLATE_OR_ISOLATE`).
_Avoid_: Batch, plant group, harvest lot, SKU

**Cannabis Lot Transformation**:
A gram-accurate curing or extraction processing run ("moving the juice", `FR-CAN-02`) where input weight must strictly equal output weight plus moisture loss, witnessed waste destroyed, and unaccounted variance ($\text{InputWeight}_{\text{g}} = \text{OutputWeight}_{\text{g}} + \text{MoistureLoss}_{\text{g}} + \text{WasteDestroyed}_{\text{g}} + \text{UnaccountedVariance}_{\text{g}}$).
_Avoid_: Extraction run, curing job, batch split, processing step

**Unaccounted Variance (`RULE-CAN-001`)**:
The residual gram difference in a `CannabisLotTransformation` after subtracting output weight, moisture loss, and witnessed waste from input weight, triggering an automatic `varianceAlertFlagged = true` and `complianceHold = true` if $|\text{UnaccountedVariance}_{\text{g}}| / \text{InputWeight}_{\text{g}} > 2.0\%$.
_Avoid_: Shrinkage, processing loss, yield gap

**Compliance Hold**:
A regulatory lock (`complianceHold = true`) placed on a `CannabisLot` when `UnaccountedVariance` exceeds $2.0\%$ or a mandatory Lab Certificate of Analysis (`labCoaStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) is missing, blocking transfer or B2B release until `CANNABIS_QAP_COMPLIANCE` sign-off (`verifiedByQapUserId`).
_Avoid_: Quarantine, QA lock, blocked lot

**Dual-Witness Destruction Log**:
An immutable Health Canada compliance record (`CannabisDestructionLog`, `FR-CAN-03`) of destroyed cannabis waste or culled plants signed by two distinct authenticated personnel (`primaryUserId != witnessUserId`, with at least one holding `CANNABIS_QAP_COMPLIANCE` or `ARCHITECT_CFO`) and backed by a timestamped photo (`evidencePhotoStorageKey`) in `R2_PRIVATE_EVIDENCE_BUCKET`.
_Avoid_: Waste log, cull ticket, disposal record
