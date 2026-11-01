# Unified Operations & Compliance ERP

Reusable multi-tenant physical inventory, chain-of-custody, and unit-economics ERP platform serving two independent legal corporations operating at separate physical facilities—the Kemptville Auto/Marine Salvage, Syndication, Domestic Flips & Pre-Paid Direct Export corporation (`ORG_SALVAGE_EXPORT` — `salvage` schema at `KEMP`, with `RAMS` preserved as a salvage-only retail/fulfillment concept pending operational verification and `POSV` retained as a dormant future salvage-export vault) and the Brockville Cannabis Cultivation & Processing corporation (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` schema exclusively at `BROCK`, subject to its actual Health Canada licence)—built on shared software infrastructure (`shared` schema) with zero shared physical warehouses, combined inventory, or pooled corporate finances (`ADR-0004`).

## Shared Software Infrastructure, Policy Configuration & Physical Custody (`shared` Schema)

**Organization**:
An independent legal business corporation (`OrganizationType`: `SALVAGE_AND_EXPORT` or `CANNABIS_NURSERY_AND_PROCESSING`, distinguishing software tenant `slug` from corporate `legalEntityName`, CRA BN15, and regulatory licences) whose inventory, physical locations, cash balances, expenses, and audit logs are strictly isolated via PostgreSQL multi-schema partitioning and default-deny Row-Level Security (RLS).
_Avoid_: Tenant, company, workspace, account, co-owned venture

**Organization Membership**:
The explicit per-corporation authorization binding (`OrganizationMembership`) between an authenticated `User` principal and an `Organization` that assigns the User's `UserRole` within that legal entity; common personnel across corporations are never assumed, and the header Organization Workspace Switcher renders only when a User holds active memberships in more than one `Organization`.
_Avoid_: Team role, user tenant link, account access, assumed dual-partner access

**Policy Configuration Port (`IPolicyConfigPort`)**:
The hexagonal port (`getPolicyForOrg(organizationId)`) that loads versioned tariff, FX, margin, compensation, self-funding working capital gate, tiered expense voucher, checkout negotiation corridor, site capacity, and cannabis mass-balance parameters from `src/core/config/pricing-policy.json` merged with any tenant-specific `Organization.policyConfigJson` overrides.
_Avoid_: Hardcoded constants, env config, global settings

**Storage Location**:
A scannable hierarchical physical slot (`Site -> Zone -> Container/Room -> Rack -> Shelf/Table -> Bin`) owned by a single `Organization` (`KEMP` active primary salvage facility, salvage-only `RAMS` concept gated behind `PROPOSED_INACTIVE` until municipal zoning/licensing is verified, dormant salvage `POSV` vault, or `BROCK` cannabis facility) and governed by data-driven `organizationId`, `allowedOrgType`, `locationOperationalStatus`, `allowsWholeVehicleDismantling`, and `maxActiveAssetCapacity` attributes without hardcoded location-name conditionals.
_Avoid_: Bin, shelf, warehouse spot, address, shared warehouse

**Site Zoning & Zero-Fluid Farm Rule (`RULE-ZONE-001` & `RULE-ENV-001`)**:
The data-driven multi-tenant facility and environmental boundary enforced by `StorageLocation.organizationId` and `StorageLocation.allowedOrgType` (always hard-blocking cross-corporation or mismatched-domain scans with `422 SITE_ZONING_VIOLATION`) alongside configurable `StorageLocation.locationOperationalStatus` and `StorageLocation.allowsWholeVehicleDismantling` (appending `PROPOSED_INACTIVE_LOCATION_WARNING` or `COMPLIANCE_WARNING_UNDRAINED_FARM` in `WARN_ONLY` mode when an unverified site or dry-storage container location is selected).
_Avoid_: Hardcoded site check, property split, yard section, shared parcel zoning

**Physical Custody Agility Mode (`complianceEnforcementMode`)**:
The organization-level policy flag (`"WARN_ONLY" | "STRICT_BLOCK"`, defaulting to `"WARN_ONLY"` in Phase 1A) ensuring physical custody scans and lifecycle state transitions never throw blocking HTTP `422` errors when regulatory paperwork or registrations lag—appending structured `complianceWarnings` (`COMPLIANCE_WARNING_UNDRAINED_FARM`, `PROPOSED_INACTIVE_LOCATION_WARNING`, `MISSING_HTA_S60_DOCS`, `MISSING_EASR_REGISTRATION_WARNING`, `UNRECONCILED_CATALYTIC_CONVERTER`, `DRIVEON_SAFETY_CERT_WARNING`) for asynchronous CFO review while keeping PostgreSQL 100% aligned with physical yard truth.
_Avoid_: Disabled validation, silent ignore, skipped compliance

**Custody Event**:
An immutable, idempotent (`idempotencyKey`), timestamped record of a physical `Vehicle`, `Part`, or `CannabisLot` (enforced by a single-target SQL `CHECK` constraint) being scanned into a new `StorageLocation` or `ShipmentPallet` by an operator, tracking optimistic concurrency (`expectedVersion` and `hasConflict`).
_Avoid_: Location update, move log, scan history, bin change

**Synthetic Laser QR Hang-Tag Sheet (`RULE-TAG-001`)**:
An `8.5" × 11"` Letter-size `3×4` (12-up) or `4×4` (16-up) printable PDF/SVG grid rendered onto matte `10-MIL` waterproof synthetic laser cardstock (`PRT-XXXXXX`, `KEMP-C01-*`, `LOT-YYYY-XXXX`) with $\ge 1.5" \times 1.5"$ quiet-zone QR codes and $15\text{mm} \times 4\text{mm}$ slot-punch guides for fastening via $-40^\circ\text{C}$ black UV zip ties.
_Avoid_: Direct-thermal sticker, inkjet paper pouch, white zip-tie tag

**Expense & Tiered Receipt Verification (`ReceiptVerificationState`)**:
An immutable cost record (`Expense`) scoped to an `Organization` and linked to a `Vehicle`, `Shipment`, or `CannabisLot`, governed by three verification states (`expense_receipt_or_voucher_check`):
1. **`VERIFIED_RECEIPT`:** Standard verified expense backed by a non-empty `receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET` (mandatory for all settled expenses $> \$50\text{ CAD}$).
2. **`PETTY_CASH_VOUCHER`:** Pressure-relief tier for minor unreceipted yard/shop cash outlays $\le \$50\text{ CAD}$ (`pettyCashVoucherMaxCadMinor = 5000`) up to $\$250\text{ CAD/month}$ per operator (`monthlyUnreceiptedVoucherCapCadMinor = 25000`), requiring a mandatory text `voucherReason` ($\ge 5\text{ characters}$).
3. **`PENDING_RECEIPT_UPLOAD`:** Temporary hold state for field expenses $> \$50\text{ CAD}$ logged with a `voucherReason` while awaiting photo upload; tracked as an unverified operator float liability until `receiptStorageKey` is attached and transitioned to `VERIFIED_RECEIPT`.
_Avoid_: Unrecorded cash payout, informal bill, untallied expense

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
The five independent state dimensions governing a `Part` simultaneously without state-explosion:
1. **`PartCustodyState` (Physical Custody):** `STRIPPED_RAW_OFFLINE`, `SHELVED_ORIGIN_CONTAINER`, `ON_EXPORT_PALLET`, `IN_TRANSIT_OCEAN_FREIGHT`, `CUSTOMS_HOLD_DESTINATION`, `SHELVED_DESTINATION_VAULT`, `SOLD_AND_RELEASED`, `RESTOCKED_QC_HOLD`, `SCRAPPED_OR_DAMAGED`.
2. **`InventoryAvailabilityState` (Commercial Reservation/Sale):** `AVAILABLE`, `RESERVED_B2B_HOLD`, `COMMITTED_DOMESTIC_SALE`, `PENDING_VAULT_COD_PAYMENT`, `PAID_SETTLED`.
3. **`EbaySyncState` (eBay Motors Delist & Export Lock):** `NOT_LISTED`, `CSV_EXPORTED_PENDING_CONFIRMATION`, `SYNDICATED_LIVE`, `DELIST_PENDING`, `DELISTED`, `EXPORT_LOCK_PENDING`, `EXPORT_LOCK_CONFIRMED`.
4. **`ClassifiedsSyncState` (Local Ottawa Classifieds Delist Queue):** `NOT_POSTED`, `POSTED_LIVE`, `DELIST_REQUIRED`, `DELISTED`.
5. **`PartComplianceState` (Safety & Enrichment Readiness):** `PENDING_ENRICHMENT`, `NEEDS_HUMAN_REVIEW`, `CLEARED_FOR_SALE`, `QUARANTINED_RECALL_OR_DG`.
_Avoid_: Part status, single lifecycle enum, item state

**TDG Hazmat Classification (`TdgHazmatCode`)**:
The Transportation of Dangerous Goods classification on a `Part` (`NONE`, `UN3268_AIRBAG`, `UN0503_PYROTECHNIC`, `UN2794_WET_BATTERY`, `UN3480_LITHIUM_BATTERY`) that hard-blocks courier parcel syndication (`EBAY_MOTORS_SHIPPED`) on hazardous components and restricts non-quarantined batteries to local pickup.
_Avoid_: Generic hazmat flag, parcel override

**Return QC Hold (`RESTOCKED_QC_HOLD`)**:
The mandatory post-return `PartCustodyState` that prevents a buyer-returned `Part` from returning to `SHELVED_ORIGIN_CONTAINER` or auto-relisting online until an operator inspects OEM markings against original strip photos to verify no part-swap fraud occurred.
_Avoid_: Auto-restock, instant relist

**Steering-Side Compatibility**:
The physical cockpit and traffic-side geometry classification of a `Part` (`UNIVERSAL`, `LHD_ONLY`, or `RHD_ONLY`): both `UNIVERSAL` and `LHD_ONLY` parts are 100% compatible with Canadian/North American buyers, whereas `LHD_ONLY` parts remain gated against Right-Hand-Drive export destinations unless explicitly overridden (`RULE-FIT-001`, `RULE-FIT-002`).
_Avoid_: Drive side, LHD/RHD flag, fitment type

**OEM Fitment Verification**:
The explicit confirmation (`oemFitmentVerified = true`) that a `Part`'s stamped OEM or interchange part number matches the target destination-market vehicle trim, engine, and model year, independent of `SteeringSideCompatibility`.
_Avoid_: Universal fit, compatibility check, part match

**Uncrushed Hulk**:
A stripped donor `Vehicle` shell (`HULK_AWAITING_SCRAP`) within `ORG_SALVAGE_EXPORT` prior to being weighed and hauled away by a scrap metal recycler (`SCRAPPED_METAL_CLEARED`).
_Avoid_: Carcass, shell, bare metal, scrap car

**HTA Section 60 Garage & Wrecking Register**:
The statutory Ontario *Highway Traffic Act* Section 60 intake record on `AUTOMOBILE` assets (`acquisitionSource`, `sellerFullName`, `sellerAddress`, `sellerPhotoIdStorageKey`, `ontarioPermitNumber`, `declaredStatutoryPurpose`) exposed as an inspectable register view (`?view=hta-s60-register`) and flagged with `MISSING_HTA_S60_DOCS` in `WARN_ONLY` mode when incomplete.
_Avoid_: Seller note, purchase log, informal bill of sale

**5-Stream Commodity Scrap Log (`ScrapComponentLog`)**:
An immutable recycler payout record separating a dismantled donor `Vehicle`'s scrap recovery across `CATALYTIC_CONVERTER`, `ALUMINUM_ALLOY_WHEELS`, `COPPER_WIRING_HARNESS`, `ROTORS_AND_BATTERY`, and `BARE_STEEL_SHELL` (`$550–$900 CAD` floor), rolling up automatically into `Vehicle.scrapRecoveryCadMinor`, Stage 2 donor cost true-up, and `AvailableWorkingCapital_CAD`.
_Avoid_: Mixed tin payout, lump scrap estimate, unlogged cat sale

**Zero-Typing Domestic Syndication Bridge (`FR-MKT-00`)**:
The deterministic Day-1 listing pipeline that joins decoded donor specs, part category, and condition grade into $\le 80$-character SEO eBay titles, eBay Seller Hub Bulk CSV feeds, Day-1 Ottawa/Gatineau B2B Mechanic Powertrain & Front-Clip Sheets (`exportB2bMechanicPowertrainSheet`, zero Solera Hollander licensing), and local classified ad payloads without manual typing.
_Avoid_: Manual listing draft, ad scraper, CSV dump

**eBay Ship-From Truth & Classifieds Geolocation Stealth (`RULE-MKT-002`)**:
The channel-split location disclosure rule requiring eBay Motors Canada (`EBAY_MOTORS_SHIPPED`) exports to declare the true warehouse ship-from location (`Kemptville, ON, K0G 1J0`) for carrier rating accuracy and eBay policy compliance, while stripping EXIF GPS coordinates from all public photos and masking exact Kemptville pad coordinates behind `"Ottawa South / Hwy 416 Corridor"` strictly on Facebook Marketplace and Kijiji classified ad payloads.
_Avoid_: Fake eBay item location, exposed yard GPS, blanket location masking

**Two-Phase Export Lock**:
The reservation protocol that blocks an eBay-listed `Part` from being sealed into an outbound `ShipmentPallet` until its online marketplace quantity is confirmed zeroed (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`, via supervisor manual verification in Phase 1 or automated eBay API sync in Phase 2A).
_Avoid_: eBay sync, delist lock, inventory hold

**Local Ad Payload**:
A pre-formatted bundle of SEO title, CAD ask price (`retailPriceCadMinor`), configurable `publicPickupLocationLabel`, OEM fitment notes, and EXIF-stripped `R2_PUBLIC_MEDIA_BUCKET` WebP URLs consumed by the Local Classifieds Queue (`FR-MKT-00`) and Manifest V3 Chrome Extension (`FR-MKT-02`) to publish Facebook Marketplace (`FB_MARKETPLACE_LOCAL`) and Kijiji (`KIJIJI_LOCAL`) listings.
_Avoid_: FB post, Kijiji draft, scraper template

## Export Logistics & Destination Bonded Vault (`salvage` Schema)

**Pre-Paid Origin Export Gate (`RULE-EXP-001`)**:
The zero-credit-risk export rule requiring 100% upfront CAD or USD payment settled in the origin corporate bank account (`SETTLED_ORIGIN_CORP_BANK`) before any outbound export pallet or whole-unit shipment can be sealed when `exportFulfillmentMode` is `PREPAID_ORIGIN_ONLY`.
_Avoid_: Consignment shipment, pay-on-arrival export, open-account freight

**Shipment**:
A consolidated outbound ocean freight movement (`EXP-YYYY-TT-XXX`) travelling from Canada to a destination port (`TT_POS` or `BB_BGI`) under a single customs declaration package.
_Avoid_: Container load, export batch, manifest, vessel run

**Shipment Pallet**:
A physical crated or shrink-wrapped pallet (`PLT-YYYY-XXX`) within a `Shipment` that holds scanned `Part` SKUs (`ON_EXPORT_PALLET`) and cannot be sealed (`sealedAt`) until all child parts reach `EXPORT_LOCK_CONFIRMED` (or `NOT_LISTED` / `DELISTED`) and clear hazmat/environmental and prepayment (`RULE-EXP-001`) gates.
_Avoid_: Skid, crate, box, lot

**Export Compliance Dossier**:
The deterministic CSV and PDF package generated from a sealed `Shipment` (`FR-LOG-02`)—comprising the HS-grouped Commercial Invoice (using arm's-length wholesale FOB USD per `RULE-CUST-003`) and Gross/Tare/Net Packing List—handed to the licensed customs broker for CBSA CERS and destination customs filing.
_Avoid_: Shipping papers, customs form, export sheet

**Destination Export Vault (`DESTINATION_EXPORT_VAULT`)**:
An optional overseas bonded commercial warehouse node (such as Port of Spain `POSV`, schema-ready and dormant in Phase 1 while `exportFulfillmentMode = 'PREPAID_ORIGIN_ONLY'`) where landed export inventory (`SHELVED_DESTINATION_VAULT`) is stored, audited via weekly blind cycle counts (`FR-VLT-05`), and released strictly upon MFA `aal2` verified Cash-on-Delivery payment (`DESTINATION_VAULT_COD`) once activated.
_Avoid_: Overseas warehouse, Port of Spain depot, bonded store

**Vault Floor Price (`vaultFloorPriceTtdMinor`)**:
The minimum permissible Trinidad & Tobago Dollar (TTD) selling price for an exported item that recovers allocated Canadian cost basis, target export markup ($65\%$), compounded customs duty/VAT, shadow FX repatriation spread ($\text{FX}_{\text{shadow}}$), and pre-VAT broker commission (`RULE-PRC-002`). Branches on `isTrinidadEntityVatRegistered`: when `false` (Phase 1 default), the $12.5\%$ import VAT is included in the floor numerator as a non-recoverable cost and checkout `taxOrVatMinor = 0`; when `true`, import VAT is excluded as a recoverable Input Tax Credit and $12.5\%$ output VAT is charged at checkout with a `taxInvoiceNumber`.
_Avoid_: Minimum price, reserve price, landed price, wholesale ask

**3-Tier Checkout Negotiation Corridor (`checkoutPolicy`)**:
The structured price-floor evaluation rule on `SaleTransaction` (governed by `checkoutStrictnessMode`: `BONDED_VAULT_STRICT | AUDIT_ENFORCED | STANDARD_POS`):
1. **Tier 1 (At or Above Floor):** `grossCollectedMinor >= floorPriceAtCheckoutMinor` $\rightarrow$ Passes automatically (`discountReasonCode = null`).
2. **Tier 2 (Within Admin Negotiation Corridor):** Discount (`discountAmountMinor`) is $\le \min(\text{vaultAdminMaxDiscountCapTtdMinor } [\text{TT\$750}],\; \max(\text{vaultAdminSmallRoundingAllowanceTtdMinor } [\text{TT\$100}],\; \text{floorPriceAtCheckoutMinor} \times 0.08))$ (or $\le 10\%$ in Ontario via `domesticAdminDiscountToleranceBps = 1000`) $\rightarrow$ Permitted for `TRINIDAD_VAULT_ADMIN` (or `HUNTER_MECHANIC` in Ontario) **if and only if** a valid `discountReasonCode` (`CASH_ROUNDING | BUNDLE_DISCOUNT | TRANSIT_OR_SHOP_DAMAGE | AGED_INVENTORY_CLEARANCE`) is selected.
3. **Tier 3 (Beyond Admin Corridor — Hard Lock / CFO Override Required):** Discount exceeds the Admin Corridor $\rightarrow$ Throws `FLOOR_PRICE_OVERRIDE_REQUIRED` unless `actorRole === 'ARCHITECT_CFO'` or a valid `cfoOverrideApprovedById` + `cfoOverrideReasonNote` is supplied.
_Avoid_: Informal haggling, unlogged discount, ad-hoc price drop

**Broker Commission Deducted at Counter (`isBrokerCommissionDeductedAtCounter`)**:
The boolean flag on `SaleTransaction` recording whether an on-island broker retained their referral commission (`brokerCommissionMinor`) directly from the cash handed over at the Vault counter; when `true`, the net physical cash added to `HELD_IN_DESTINATION_VAULT` is `grossCollectedMinor - brokerCommissionMinor` so physical safe cash reconciles to the cent.
_Avoid_: Off-book broker cut, pocketed commission

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
An immutable checkout record (`SaleTransaction`) capturing domestic origin (`SaleMarketNode.DOMESTIC_ORIGIN`: `LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `WHOLESALE_MECHANIC_NETWORK`, `EBAY_MOTORS_SHIPPED`, `CAR_PART_WHOLESALE`) or destination export vault (`SaleMarketNode.DESTINATION_EXPORT_VAULT`: `DESTINATION_VAULT_COD`, `DESTINATION_PRE_ORDER_PICKUP`, `SECONDARY_ISLAND_WHOLESALE`) sales, `floorPriceAtCheckoutMinor`, 3-tier negotiation corridor fields, `isBrokerCommissionDeductedAtCounter`, payment proof, `CashCustodyState`, FIU rolling 30-day CDD verification (`RULE-COMP-FIU-01`), and gate release timestamps.
_Avoid_: Order, invoice, receipt, checkout log

**Blind Cycle Count**:
A weekly anti-shrinkage audit task (`CycleCountTask`, `FR-VLT-05`) requiring the `TRINIDAD_VAULT_ADMIN` to physically scan and photograph a random sample of `SHELVED_DESTINATION_VAULT` items without seeing their expected shelf locations beforehand.
_Avoid_: Stocktake, inventory audit, shelf check

**Currency Settlement**:
A batched foreign-exchange conversion (`CurrencySettlement`, `FR-VLT-04`) of deposited TTD funds (`DEPOSITED_DESTINATION_BANK`) from a Trinidad commercial bank into settled CAD/USD in the origin corporate bank account (`SETTLED_ORIGIN_CORP_BANK`), recording `effectiveClearingRate` and `fxSlippageLossCadMinor`.
_Avoid_: Wire transfer, FX trade, repatriation wire

## Unit Economics, Cash Custody & Compensation (`shared` & `salvage` Schemas)

**Self-Funding Working Capital Pool (`AvailableWorkingCapital_CAD`)**:
The self-sustaining capital pool backed by a 3-tranche `$44,000 CAD` Senior Secured Working Capital Loan Facility (`ActiveReleasedTrancheCapital_CAD`: `$22,000` Tranche 1 at launch, `$12,000` Tranche 2 at Day 60, `$10,000` Tranche 3 at Day 120) and replenished strictly by pre-HST realized domestic sales (`netRealizedCadMinor`), 5-stream scrap payouts (`ScrapComponentLog.payoutCadMinor`), and repatriated export settlements (`SETTLED_ORIGIN_CORP_BANK`), while excluding unsettled `ITA s. 78(1)` deferred inter-company accruals:
$$\text{AvailableWorkingCapital}_{\text{CAD}} = \text{ActiveReleasedTrancheCapital}_{\text{CAD}} + \sum \text{NetRealizedDomesticSales}_{\text{CAD}} + \sum \text{ScrapComponentLog.payoutCadMinor} + \sum \text{RepatriatedExportSettlements}_{\text{CAD}} - \sum \text{CashDeployedAcquisitionsAndSettledExpenses}_{\text{CAD}}$$
Every vehicle acquisition enforces `minCashReserveFloorCadMinor` ($\$7,500\text{ CAD}$), `maxDonorDismantleLandedCadMinor` ($\$3,200\text{ CAD}$), and `enableHighEndRebuildLane = false` (all supporting a **1-Tap `cfoOverride`** by `ARCHITECT_CFO`), while protecting loan principal and HST trust funds from founder draws (`RULE-PAY-002`).
_Avoid_: Bi-monthly infusion, recurring investor top-up, slush fund

**Deferred Inter-Company Lease Accrual (`ITA s. 78(1)`)**:
A container-pad rent or software/equipment lease `Expense` incurred within an `Organization`'s independent corporate books and flagged `isDeferredIntercompanyAccrual = true` (`accrualSettledAt = null`) that accrues on its GL balance sheet without reducing liquid buying power in `AvailableWorkingCapital_CAD` until settled in cash (subject to counterparty `ITA s. 78(1)` tax verification).
_Avoid_: Forgiven rent, off-ledger lease, free yard use, cross-entity subsidy

**Ontario HST Trust Ring-Fencing & eBay Billing Agent Split (`RULE-TAX-HST-01`)**:
The channel-split tax accounting invariant (`isOntarioHstRegistered = true`, `13%` rate): on `EBAY_MOTORS_SHIPPED`, eBay collects and remits 100% of buyer GST/HST directly to the CRA as Billing Agent (`buyerTaxRemittedByPlatformMinor`, adding `0` to corporate `taxOrVatMinor`) while 13% HST charged on eBay seller fees is tracked as recoverable Input Tax Credit (`itcReceivableCadMinor`); on direct and local classified channels, 13% HST (`taxOrVatMinor`) is collected directly and `netHstTrustLiability = max(0, hstCollectedDirect - verifiedItcReceivable)` is strictly ring-fenced out of `AvailableWorkingCapital_CAD` and `DistributableRealizedProfitPool_CAD`.
_Avoid_: Double-remitting eBay buyer HST, tax-inclusive margin, spendable HST

**Operator Float (`HELD_IN_OPERATOR_FLOAT`)**:
Physical domestic cash collected within `ORG_SALVAGE_EXPORT` from local sales (`SaleTransaction.grossCollectedMinor`) and cash scrap recycler payouts (`ScrapComponentLog.payoutCadMinor`) held in the salvage field operator's custody as an auditable petty-cash subledger balance that can fund receipted/vouchered shop expenses (`paidFromCashCustody = 'HELD_IN_OPERATOR_FLOAT'`), offset partner draws (`RULE-PAY-003`), or be swept to `SETTLED_ORIGIN_CORP_BANK` via `CashCustodyTransfer`.
_Avoid_: Shop cash, pocket cash, petty cash, local float, shared entity float

**Two-Stage Pro-Rata Donor Cost Allocation**:
The accounting algorithm (`DOMAIN-RULES.md` Section 4.4) that resolves the timing gap between stripping a part on Day 2 and scrapping the hulk on Day 14:
1. **Stage 1 (Provisional Cost Basis at Strip Time):** Allocates donor purchase price plus direct expenses logged to date weighted by the part's grade-adjusted market value ($\text{GradeAdjustedMarketValue}_{\text{CAD}}$) divided by $\max(\text{TargetGrossRealization}_{\text{CAD}}, \sum \text{StrippedPartsMarketValue}_{\text{CAD}})$.
2. **Stage 2 (Final Cost Basis True-Up at Hulk Scrap):** Once `scrapRecoveryCadMinor` is recorded from `scrapMetalTicketKey`, reconciles remaining unrecovered donor outlay pro-rata across all remaining unsold parts so $\sum \text{Part.allocatedCostBasisCadMinor}_i + \text{Vehicle.scrapRecoveryCadMinor} = \text{Vehicle.totalAcquisitionAndStripCostCadMinor}$ holds to the exact cent.
_Avoid_: Part cost split, VIN cost sharing, flat average cost

**Piece-Rate Stripper Payout (`RULE-PAY-001`)**:
A flat per-vehicle labor payment (`YARD_STRIPPER_PIECE_RATE`, default $350 CAD) to an unskilled yard stripper (`ONTARIO_STRIPPER`) that unlocks only after `Vehicle.fluidsDrainedAt IS NOT NULL` and at least `minShelvedPartsForStripPayout` (35) barcoded, photographed `Part` records for that donor vehicle reach `SHELVED_ORIGIN_CONTAINER`.
_Avoid_: Stripper wage, hourly yard pay, dismantling fee

**Partner Profit Draw (`RULE-PAY-002` & `RULE-PAY-003`)**:
A founder compensation disbursement (`PARTNER_PROFIT_DRAW`) restricted strictly to positive `DistributableRealizedProfitPool_CAD` (`RULE-PAY-002`, protecting `initialSeedCapitalCadMinor`) and automatically netted against any outstanding `HELD_IN_OPERATOR_FLOAT` balance (`RULE-PAY-003`) before corporate bank cash is disbursed.
_Avoid_: Owner salary, founder wage, partner payout

## Brockville Cannabis Cultivation & Processing (`cannabis` Schema — `ORG_CANNABIS_NURSERY_PROC`, Dormant Until Phase 2B)

**Cannabis Strain**:
A distinct genetic cultivar (`CannabisStrain`) registered within `ORG_CANNABIS_NURSERY_PROC` defining lineage, target cannabinoid percentages, and terpene profile for mother plants and downstream lots.
_Avoid_: Variety, SKU, plant type, flavor

**Cannabis Lot**:
A traceable biological, cured, or extracted inventory unit (`LOT-YYYY-XXXX`) tracked in integer tenth-grams (`0.1g` = `0.0001 kg`), discrete units/plants, and milligrams of Total THC (`totalThcMg`), including on-site cultivation provenance (`isGrownOnSite` for the *Cannabis Regulations* s. 21(3) micro-processing exemption).
_Avoid_: Batch, plant group, harvest lot, SKU

**Production Run (`ProductionRun`)**:
A multi-input, multi-output (`ProductionRunInput` / `ProductionRunOutput`) curing, solventless ice-water hash, rosin pressing, infused pre-roll, or packaging batch transformation ("moving the juice", `FR-CAN-02`) where total input tenth-grams strictly equal output yield plus process loss, destroyed byproduct, and unaccounted variance.
_Avoid_: 1:1 lot transformation, single-output batch, processing step

**Canonical Inventory Event (`CanonicalInventoryEvent`)**:
An append-only regulatory ledger record capturing signed tenth-gram mass (`netMassTenthGrams`), flowering vs. non-flowering mass (`flowerMassTenthGrams`, `nonFlowerMassTenthGrams`), discrete units, and Total THC (`totalThcMg`) to reconcile both Health Canada CTLS kilogram reports and CRA Form B300 excise duty returns (`$1.00/g` flowering, `$0.30/g` non-flowering, and extract mg-THC duty).
_Avoid_: Mutable lot balance, floating-point weight log

**Unaccounted Variance (`RULE-CAN-001`)**:
The residual tenth-gram difference in a `ProductionRun` after subtracting output yield, process loss, and destroyed byproduct from total input mass, triggering an automatic QAP variance review and `complianceHold = true` if $|\text{UnaccountedVariance}| / \text{TotalInputMass} > 2.0\%$.
_Avoid_: Shrinkage, processing loss, yield gap

**Compliance Hold**:
A regulatory lock (`complianceHold = true`) placed on a `CannabisLot` when `UnaccountedVariance` exceeds $2.0\%$, a mandatory 60-day extract NNCP (`nncpNoticeId`) or s. 88.94 Preventive Control Plan check is incomplete, or a Lab Certificate of Analysis (`labCoaStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) is missing, blocking transfer or release until `CANNABIS_QAP_COMPLIANCE` sign-off.
_Avoid_: Quarantine, QA lock, blocked lot

**Three-Stream Cannabis Destruction (`CannabisDestructionLog` — `SOR/2025-45`)**:
The post-2025 federal cannabis destruction classification (`FR-CAN-03`, ss. 43 & 229) distinguishing `CULTIVATION_WASTE` (leaves, shoots, branches: `0` witnesses, `0` s. 229 records, `0` CTLS reporting), `WHOLE_PLANTS` (`1` employee witness with no security clearance + `plantCount` only, no mandatory weight), and `OTHER_CANNABIS` (buds, hash, rosin, spent pucks, packaged units: `1` employee witness + pre-destruction net weight, with an optional 2nd witness toggle for excise-stamped goods).
_Avoid_: Blanket dual-witness rule, security-cleared witness requirement, cultivation waste weighing
