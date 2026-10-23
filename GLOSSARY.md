# Unified Operations & Compliance ERP

Multi-tenant physical inventory, chain-of-custody, and unit-economics platform operating both the Ontario-to-Trinidad Auto/Marine Salvage & Flip venture and the Brockville/Kemptville Health Canada Cannabis Nursery & Processing venture.

## Shared Operations & Physical Custody

**Organization**:
A distinct legal and regulatory business entity (`ORG_SALVAGE_EXPORT` or `ORG_CANNABIS_NURSERY_PROC`) whose inventory, locations, expenses, and audit logs are strictly isolated from other entities.
_Avoid_: Tenant, company, workspace, account

**Storage Location**:
A scannable hierarchical physical slot (`Site -> Zone -> Container/Room -> Rack -> Shelf/Table -> Bin`) where an asset, part, or cannabis lot resides.
_Avoid_: Bin, shelf, warehouse spot, address

**Site Zoning**:
The physical and regulatory boundary dividing the 19-acre Kemptville property into the salvage container pad (`ZONE_CONTAINER_PAD`), the greenhouse agricultural zone (`ZONE_GREENHOUSE_AG`), and the mature tree farm (`ZONE_TREE_FARM`).
_Avoid_: Property split, yard section, land partition

**Custody Event**:
An immutable, timestamped record of a physical item being scanned into a new Storage Location or Shipment Pallet by an operator.
_Avoid_: Location update, move log, scan history, bin change

## Salvage, Dismantling & Domestic Flips

**Vehicle**:
A whole parent asset acquired for flipping, rebuilding, dismantling, or whole-unit export, encompassing road automobiles (VIN), recreational watercraft (HIN), and commercial shop equipment (Serial Number).
_Avoid_: Donor, salvage unit, car, unit, asset

**Part**:
A discrete physical component (`Quantity = 1`) stripped from a donor Vehicle and identified by a unique weatherproof QR SKU (`PRT-XXXXXX`).
_Avoid_: Component, item, piece, spare

**Operational Lane**:
The commercial track assigned to a Vehicle upon acquisition: Quick-Turn Beater, High-End Rebuild, Dismantle and Export, or Whole-Unit Export.
_Avoid_: Track, workflow, strategy, vehicle type

**Steering-Side Compatibility**:
The physical cockpit and traffic-side geometry classification of a Part (`UNIVERSAL`, `LHD_ONLY`, or `RHD_ONLY`) determining whether it can be exported to Right-Hand-Drive markets.
_Avoid_: Drive side, LHD/RHD flag, fitment type

**OEM Fitment Verification**:
The explicit confirmation that a Part's stamped OEM or interchange part number matches the target destination-market vehicle trim, engine, and model year, independent of Steering-Side Compatibility.
_Avoid_: Universal fit, compatibility check, part match

**Uncrushed Hulk**:
A stripped donor Vehicle shell remaining on the Kemptville container pad prior to being weighed and hauled away by a scrap metal recycler.
_Avoid_: Carcass, shell, bare metal, scrap car

**Two-Phase Export Lock**:
The reservation protocol that quarantines an eBay-listed Part from being sealed into an outbound export pallet until its online marketplace quantity is confirmed zeroed (`EXPORT_LOCK_PENDING` to `EXPORT_LOCK_CONFIRMED`).
_Avoid_: eBay sync, delist lock, inventory hold

**Local Ad Payload**:
A pre-formatted bundle of title, CAD price, OEM fitment notes, and sanitized photos consumed by the local Chrome Extension to autofill Facebook Marketplace and Kijiji listings.
_Avoid_: FB post, Kijiji draft, scraper template

## Export Logistics & Trinidad Bonded Vault

**Shipment**:
A consolidated outbound ocean freight movement (LCL pallet batch or FCL container) travelling from Canada to a destination port under a single customs declaration package.
_Avoid_: Container load, export batch, manifest, vessel run

**Shipment Pallet**:
A physical crated or shrink-wrapped pallet (`PLT-XXXXXX`) within a Shipment that holds scanned Parts and cannot be sealed until all child Parts clear export lock and hazmat gates.
_Avoid_: Skid, crate, box, lot

**Trinidad Vault**:
The family-owned secure commercial warehouse in Port of Spain where landed export inventory is stored, audited via blind cycle counts, and released strictly upon verified Cash-on-Delivery payment.
_Avoid_: Overseas warehouse, Port of Spain depot, bonded store

**Vault Floor Price**:
The minimum permissible Trinidad & Tobago Dollar (TTD) selling price for an exported item that recovers Canadian cost basis, target markup, compounded customs duty/VAT, shadow FX repatriation spread, and broker commission.
_Avoid_: Minimum price, reserve price, landed price, wholesale ask

**Broker Market Price**:
The expected local Trinidad selling price quoted by an on-island sales broker, compared against the Vault Floor Price prior to shipping to prevent margin inversion.
_Avoid_: Street price, island price, broker estimate

**B2B Reservation**:
A time-boxed 24-hour hold placed by an overseas mechanic or broker on a specific in-stock or in-transit Part or Vehicle.
_Avoid_: Pre-order, cart hold, booking

**Pre-Order Wish List**:
A standing demand request from an overseas buyer specifying a target vehicle make, model, year range, and maximum TTD bid for parts not yet in stock.
_Avoid_: Backorder, want list, buyer lead

**Blind Cycle Count**:
A weekly anti-shrinkage audit task requiring the Trinidad Vault Admin to physically scan and photograph a random sample of Vault items without seeing their expected shelf locations beforehand.
_Avoid_: Stocktake, inventory audit, shelf check

## Unit Economics, Cash Custody & Compensation

**Working Capital Principal Buffer**:
The $20,000 CAD bi-monthly investor capital pool reserved strictly for inventory acquisition, repair parts, piece-rate stripping, and freight—never for founder salaries.
_Avoid_: Investor loan, bank balance, operating budget, slush fund

**Taz Float**:
Physical Canadian cash collected from local Ontario sales and held in the Hunter/Mechanic's custody (`HELD_BY_TAZ_FLOAT`) as an auditable petty-cash subledger balance.
_Avoid_: Shop cash, pocket cash, petty cash, local float

**Cash Custody Transfer**:
A receipt-backed movement of physical cash from the Taz Float or Trinidad Vault safe into a commercial bank account.
_Avoid_: Bank drop, cash deposit, sweep

**Currency Settlement**:
A batched foreign-exchange conversion of deposited TTD funds from a Trinidad commercial bank into settled CAD/USD in the Canadian corporate bank account, recording effective clearing rate and FX slippage.
_Avoid_: Wire transfer, FX trade, repatriation wire

**Two-Stage Cost Allocation**:
The accounting method that assigns a provisional cost basis to each stripped Part upon removal and executes a final pro-rata cost true-up once the Uncrushed Hulk is weighed and scrapped.
_Avoid_: Part cost split, VIN cost sharing

**Piece-Rate Stripper Payout**:
A flat per-vehicle labor payment to an Ontario yard stripper that unlocks only after fluids are drained and at least 35 barcoded, photographed Parts are shelved into a Kemptville container.
_Avoid_: Stripper wage, hourly yard pay, dismantling fee

**Partner Profit Draw**:
A founder compensation disbursement restricted to the cumulative realized net profit pool and automatically netted against any outstanding Taz Float balance.
_Avoid_: Owner salary, founder wage, partner payout

## Cannabis Nursery & Processing

**Cannabis Lot**:
A traceable biological or extracted inventory unit (`LOT-YYYY-XXXX`) tracked either by discrete plant count (`MOTHER_PLANT`, `CLONE_TRAY`, `VEGETATIVE_BATCH`) or continuous gram weight (`FRESH_HARVEST`, `DRIED_FLOWER`, `TRIM_BIOMASS`, `CRUDE_EXTRACT`, `DISTILLATE_OR_ISOLATE`).
_Avoid_: Batch, plant group, harvest lot, SKU

**Cannabis Lot Transformation**:
A gram-accurate curing or extraction processing run ("moving the juice") where input weight must strictly equal output weight plus moisture loss, witnessed waste destroyed, and unaccounted variance.
_Avoid_: Extraction run, curing job, batch split, processing step

**Unaccounted Variance**:
The residual gram difference in a Cannabis Lot Transformation after subtracting output weight, moisture loss, and witnessed waste from input weight, triggering an automatic compliance hold if it exceeds 2.0%.
_Avoid_: Shrinkage, processing loss, yield gap

**Compliance Hold**:
A regulatory lock placed on a Cannabis Lot when Unaccounted Variance exceeds 2.0% or a mandatory Lab Certificate of Analysis (CoA) is missing, blocking transfer or sale until Quality Assurance Person (QAP) sign-off.
_Avoid_: Quarantine, QA lock, blocked lot

**Dual-Witness Destruction Log**:
An immutable Health Canada compliance record of destroyed cannabis waste or culled plants signed by two distinct authenticated personnel (including at least one QAP or CFO) with photographic evidence.
_Avoid_: Waste log, cull ticket, disposal record
