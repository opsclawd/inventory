# **Product Requirements Document and Technical Architecture Specification: Cross-Border Automotive Dismantling, Rebuilding, and Bonded-Export ERP Platform** 

## **1. Executive Summary & North Star Metrics** 

### **1.1 Product Vision & Strategic Mandate** 

The Cross-Border Automotive Dismantling, Flipping, and Bonded-Export Enterprise Resource Planning (ERP) platform serves as the operational, logistical, and financial backbone for a multi-node vehicle and recreational watercraft arbitrage joint venture operating between rural Ontario (Kemptville and Ramsayville/Ottawa) and the Caribbean (Port of Spain, Trinidad and Barbados), with secondary wholesale distribution into the Middle East. The overarching strategic mandate of the platform is to transform an informal, high-margin trading operation into an institutional-grade, auditable enterprise capable of achieving a **$2,000,000 CAD exit valuation** within 24 to 36 months. Achieving this valuation requires generating **$400,000 to $500,000+ CAD in verifiable annual Seller’s Discretionary Earnings (SDE) and net profit** , supported by a tamper-proof general ledger that commands a **3.5x to 4.5x valuation multiple** during private equity or strategic buyer due diligence. 

In traditional salvage and cross-border auto parts operations, enterprise value is routinely destroyed by four interconnected structural vulnerabilities. First, unrecorded inventory shrinkage and orphaned stock occur when high-value components—such as 2021–2022 Kia, Hyundai, and Mazda SUV electronics, body panels, and Yamaha marine powertrains—are stripped by low-skill labor and placed into unindexed shipping containers, becoming "dark inventory" that cannot be located or sold. Second, channel conflict and double-selling arise when parts listed on North American retail channels (such as eBay Motors and Car-Part.com) are simultaneously packed into ocean freight pallets bound for the Caribbean, resulting in seller-cancelled orders, marketplace account suspension, and customs manifest discrepancies. Third, cross-border leakage and informal credit default plague Caribbean destination markets whenever commissioned sales brokers or local mechanics are permitted to remove inventory from warehouses on informal credit terms, leading to severe bad-debt write-offs. Fourth, foreign exchange (FX) illiquidity and margin erosion threaten profitability in Trinidad and Tobago, which has experienced a persistent foreign exchange shortage since 2015 due to declining energy sector export earnings. Because the Central Bank of Trinidad and Tobago (CBTT) rations US and Canadian dollar allocations across commercial banks, importers face multi-week approval queues while the parallel market exchange rate exceeds **TTD 7.30+ per USD** . Failing to price FX conversion delays and parallel-market spreads directly into local Trinidad and Tobago Dollar (TTD) wholesale transactions silently erodes Canadian working capital. 

### **1.2 De-Risking the $20,000 CAD Bi-Monthly Capital Infusion** 

The platform enforces algorithmic discipline over the venture's **$20,000 CAD bi-monthly working capital infusion** by operating as a programmatic "Capital Gatekeeper." Every dollar deployed into Ontario salvage auctions (Copart, IAAI, Impact Auto), towing, aftermarket repair parts ("Prime Choice" components), Ramsayville body shop labor, and ocean freight consolidation is tracked at the **Vehicle Identification Number (VIN)** and **Stock Keeping Unit (SKU)** level. 

Capital velocity is dynamically balanced across three distinct revenue lanes to ensure short-term liquidity funds long-tail arbitrage. In the first lane, **Quick-Turn Retail "Beaters" ($5,000 CAD Retail Tier)** involve acquiring unfit or lightly damaged vehicles for 1, 500– 2,000 CAD and patching them within 48 hours at the Ramsayville shop using economical aftermarket parts to pass Ontario's Ministry of Transportation (MTO) **DriveON Safety Standards Certificate (SSC)** inspection. Because an Ontario SSC carries a strict **36-calendar-day validity window** before requiring a paid re-inspection, the software prioritizes rapid retail turnover to generate 1, 500– 2,000 CAD net profit per unit and fund ongoing yard overhead. In the second lane, **High-End Salvage Rebuilds** focus on 4-to-5-year-old luxury vehicles (such as Mercedes-Benz sedans and SUVs) and 300+ HP recreational watercraft (Sea-Doo and Yamaha WaveRunner/JetBoats) requiring frame pulling, paint, and Ontario **DriveON Structural Inspection Certificate (SIC)** re-branding from Salvage to Rebuilt, yielding **$7,000 to $10,000 CAD net profit per unit** . In the third lane, **Dismantling, Domestic eBay Retail, and Caribbean/Middle East Bonded Export** , vehicles branded Irreparable or designated for part-out are stripped at the Kemptville yard. High-velocity domestic parts are syndicated to eBay Motors to recoup the initial vehicle acquisition cost within 14 to 21 days, while high-demand regional assemblies (2021–2022 Korean and Japanese SUV front clips, doors, engines, and marine components) are consolidated into Less-than-Container-Load (LCL) pallets and 20ft/40ft Full-Container-Load (FCL) shipments bound for the Port of Spain "Bonded Vault". 

### **1.3 North Star Metrics & Mathematical Definitions** 

To guarantee operational efficiency across rural Ontario and Port of Spain, the platform tracks and enforces five North Star Key Performance Indicators (KPIs) detailed in Table 1. 

|Metric Name|Target SLA / Threshold|Operational Formula &<br>Measurement Definition|<br>Strategic Impact on<br>$2M Exit Valuation|
|---|---|---|---|
|**Strip-to-Shelf Time**<br>**(T_{\text{intake}})**|**< 30 \text{ seconds}**<br>per part|T_{\text{shelf\_scan}} -<br>T_{\text{camera\_open}<br>} recorded on the<br>Ontario Stripper Mobile<br>PWA.|<br>Eliminates labor<br>bottlenecks; proves<br>low-skill labor<br>scalability without<br>requiring OEM<br>part-number literacy.|
|**Container Retrieval**<br>**Time (T_{\text{pick}})**|**< 5 \text{ minutes}**per<br>part|<br>T_{\text{part\_verified\_<br>scan}} -<br>T_{\text{pick\_order\_di<br>spatched}} across<br>Kemptville's 4<br>containers or Trinidad's<br>warehouse.|<br>Prevents lost sales,<br>eliminates "lost in<br>container" shrinkage,<br>and validates physical<br>inventory accuracy for<br>auditors.|



|Metric Name|Target SLA / Threshold|Operational Formula &<br>Measurement Definition|<br>Strategic Impact on<br>$2M Exit Valuation|
|---|---|---|---|
|**Vehicle Break-Even**<br>**Velocity**<br>**(V_{\text{BE}})**|**\le 21 \text{ days}**<br>(Part-Out)**\le 14 \text{**<br>**days}**(Beater)|Days elapsed until<br>\sum \text{Realized Net<br>Cash}_{\text{VIN}} \ge<br>(\text{Buy Price} +<br>\text{Buyer Fees} +<br>\text{Tow} + \text{Direct<br>Parts/Labor}).|<br> <br>Protects the $20,000<br>CAD bi-monthly capital<br>pool; ensures<br>self-funding cash<br>conversion cycles.|
|**Long-Tail**<br>**Sell-Through Rate**<br>**(STR_{90})**|**\ge 65\%**within 90<br>days of landing|\frac{\sum \text{Parts<br>Sold in Trinidad Vault<br>(COD)}}{\sum<br>\text{Parts Landed in<br>Container}} \times 100<br>over a rolling 90-day<br>window.|Validates cross-border<br>demand accuracy and<br>prevents container<br>space from being<br>wasted on dead stock.|
|**Trinidad FX**<br>**Repatriation Cycle &**<br>**Spread (C_{\text{FX}})**|<br>**\le 30 \text{ days}**<br>cycle;**\le 1.5\%**<br>slippage vs. reserve|Weighted average days<br>from TTD COD<br>collection to settled<br>CAD/USD in Canadian<br>bank account; variance<br>between priced shadow<br>FX rate and actual<br>clearingrate.|<br> <br>Proves to prospective<br>acquirers that<br>Caribbean revenue is<br>convertible into hard<br>Canadian currency<br>without margin<br>destruction.|



## **2. User Personas & Strict RBAC Permission Matrix** 

### **2.1 Operational Personas & Threat Modeling** 

#### **The Architect / CFO (System Owner)** 

The Architect and Chief Financial Officer operates as the primary capital allocator, system owner, deal approval gatekeeper, unit-economics auditor, and customs manifest issuer. Working across desktop workstations and mobile executive dashboards with principal-level technical and financial literacy, this persona approves or rejects pre-auction vehicle bids exceeding capital thresholds, releases tranches of the $20,000 CAD bi-monthly working capital pool, audits Ramsayville repair receipts, generates Canada Border Services Agency (CBSA) Canadian Export Reporting System (CERS) declarations and Trinidad ASYCUDA World commercial invoices, and reconciles TTD-to-CAD foreign exchange settlements. 

#### **The Hunter / Lead Mechanic ("Taz")** 

The Hunter and Lead Mechanic serves as the salvage auction buyer, Ramsayville body shop lead, dismantling planner, and overseas B2B buyer relationship manager. Operating in a high-mobility physical environment across auction yards, tow trucks, the Ramsayville 7-to-8-car retail/repair lot, and the Kemptville staging yard using a smartphone and ruggedized shop tablet, this persona possesses deep mechanical and automotive market expertise paired with moderate software literacy. Core workflows include evaluating salvage vehicles via the 

Pre-Auction Deal Analyzer, logging repair hours and aftermarket "Prime Choice" parts against Ramsayville vehicles, uploading mandatory MTO DriveON before-and-after structural repair photographs, and curating overseas B2B buyer "Wish Lists" for outbound pallets. From a threat-modeling perspective, this persona exhibits natural optimistic bias regarding vehicle repair costs and maintains strong personal rapport with overseas mechanics. Consequently, the system enforces a hard architectural boundary blocking the Hunter from overriding negative-margin acquisition locks, deleting historical expense logs, modifying landed customs valuations, or authorizing the physical release of inventory from the Trinidad Bonded Vault without Family Admin payment verification. 

#### **The Unskilled Yard Stripper (Rural Ontario)** 

The Unskilled Yard Stripper executes the physical dismantling of vehicles, draining of fluids, capping of A/C lines, photographing of stripped components, application of thermal QR labels, and placement of parts into shipping container bins. Working in a harsh outdoor and semi-enclosed rural Ontario environment in Kemptville characterized by -30°C winter temperatures, grease, oil, heavy work gloves, and cellular dead zones behind steel shipping containers, this persona operates with zero knowledge of OEM part numbers or vehicle fitment compatibility. The stripper interacts exclusively with an offline-first Mobile Progressive Web App (PWA) featuring a "Zero-Typing" three-tap workflow: scanning the donor VIN barcode, snapping three guided photos while binding a pre-printed synthetic QR SKU tag, and scanning the destination Container-Rack-Shelf-Bin QR placard. Because the primary operational risks involve mislabeling parts or bypassing intake scans when connectivity drops, the stripper is restricted strictly to the Yard Intake and Pick/Pack PWA views, with zero visibility into part pricing, financial ledgers, or customer records. 

#### **The Trinidad Family Vault Admin (Port of Spain)** 

The Trinidad Family Vault Admin acts as the trusted fiduciary custodian of the Port of Spain commercial warehouse, responsible for container de-consolidation, shelf check-in, Cash-on-Delivery (COD) collection, physical gate release, and FX conversion banking. Operating inside a secure commercial warehouse in Port of Spain with reliable Wi-Fi and cellular connectivity via a tablet and smartphone Point-of-Sale (POS) interface, this persona brings high commercial and banking literacy to the operation. The Family Admin scans incoming container pallets against digital manifests to flag transit shrinkage, accepts TTD or USD cash or verified local bank wires at the warehouse counter, disburses 5%–10% referral commissions to local brokers only after full customer funds clear, and issues cryptographic Digital Gate Passes to release parts at the warehouse exit. Additionally, the Family Admin manages local commercial bank deposits—ensuring balances remain within the **TTD $200,000 per-depositor, per-institution deposit protection limit** across Trinidad's eight licensed commercial banks—and executes FX conversion batches into USD and CAD. To insulate the Family Admin from social pressure exerted by local mechanics or sales contacts requesting informal credit, the software enforces an immutable architectural invariant: a Gate Pass QR code cannot be generated until the transaction state transitions to PAID_SETTLED_IN_VAULT. 

#### **The Overseas B2B Buyer / Commissioned Broker (Trinidad, Barbados, Middle East)** 

The Overseas B2B Buyer and Commissioned Broker persona encompasses independent local sales contacts ("feet on the street" earning a 5%–10% referral commission), Trinidadian and Barbadian collision repair facilities, taxi fleet operators, and regional Yamaha marine dealers. Interacting via WhatsApp and mobile web browsers with high familiarity with vehicle models but zero tolerance for complex ERP interfaces, these users browse the two-tab "Live Container" Storefront ("On the Shelf in Port of Spain" versus "Loading in Ontario Container"), place time-boxed 24-hour reservation holds, receive automated WhatsApp catalog broadcasts, and submit "Mechanic Wish List" requests for specific vehicles or assemblies needed in the Caribbean. To mitigate the risk of competitors scraping inventory or brokers holding stock indefinitely without payment, this persona is restricted to read-only wholesale catalog views displaying TTD/USD wholesale prices only (concealing Canadian acquisition costs and eBay retail prices) and rate-limited reservation holds. 

### **2.2 Strict Role-Based Access Control (RBAC) Permission Matrix** 

The platform enforces Role-Based and Attribute-Based Access Control (RBAC/ABAC) at both the API middleware layer and the PostgreSQL Row-Level Security (RLS) layer, as defined in Table 2. 

|System Module<br>/ Resource<br>Action|<br>Architect / CFO|Hunter /<br>Mechanic (Taz)|<br>Ontario Yard<br>Stripper|Trinidad Family<br>Admin|<br>Overseas B2B<br>Buyer / Broker|
|---|---|---|---|---|---|
|**Run**<br>**Pre-Auction**<br>**Deal Analyzer**<br>**& Submit Bid**<br>**Proposal**|CRUD +<br>Approve|Create / Read|No Access|No Access|No Access|
|**Override "Bad**<br>**Cop" Capital**<br>**Gate ($20k**<br>**Buffer / Min**<br>**ROI)**|Execute (Audit<br>Logged)|Denied (Hard<br>Lock)|No Access|No Access|No Access|
|**Intake Vehicle**<br>**& Assign Lane**<br>**(Flip / Rebuild**<br>**/ Strip)**|<br>CRUD|Create /<br>Update|Read Only<br>(Strip Queue)|Read Only<br>(Exported)|No Access|
|**Log Shop**<br>**Expenses &**<br>**Parts**<br>**(Mandatory**<br>**Receipt**<br>**Image)**|CRUD + Audit|Create / Read<br>(Append-Only)|No Access|Create<br>(Port/Clearance<br>Fees)|<br>No Access|
|**Upload**<br>**DriveON SIC**<br>**Salvage**<br>**Photos &**<br>**Inspection**<br>**Certs**|CRUD|Create / Read|No Access|No Access|No Access|



|System Module<br>/ Resource<br>Action|<br>Architect / CFO|Hunter /<br>Mechanic (Taz)|<br>Ontario Yard<br>Stripper|Trinidad Family<br>Admin|<br>Overseas B2B<br>Buyer / Broker|
|---|---|---|---|---|---|
|**Execute 3-Tap**<br>**Part Strip, QR**<br>**Bind &**<br>**Container Bin**<br>|CRUD|Create / Read /<br>Relocate|<br>Create /<br>Relocate<br>(PWA)|No Access|No Access|
|**Scan**||||||
|**Review AI**<br>**Vision**<br>**Enrichment,**<br>**ARA Grade &**<br>**Dual Pricing**|CRUD +<br>Override|Read / Suggest<br>Edit|<br>No Access|Read (TTD<br>Wholesale<br>Only)|No Access|
|**Publish /**<br>**Delist eBay**<br>**Motors &**<br>**Domestic**|CRUD + Force<br>Sync|Read / Trigger<br>Hold|No Access|No Access|No Access|
|**Listings **||||||
|**Scan Parts**<br>**into Outbound**<br>**LCL Pallet /**<br>|<br> <br>CRUD|Create / Read|Execute<br>Pick/Pack Scan|<br>Read Manifest|Read<br>("Loading" Tab)|
|**FCL Container**||||||
|**Generate**<br>**CBSA CERS**<br>**Bulk Export &**<br>**ASYCUDA**|CRUD + Export|Read Packing<br>List|No Access|Read /<br>Download<br>Customs Docs|No Access|
|**Invoices**||||||
|**Check-In**<br>**Landed**<br>**Container**<br>**Stock to**<br>**Trinidad Vault**|CRUD|Read Status|No Access|Execute Intake<br>& Discrepancy|No Access|
|**Shelves**||||||
|**Reserve Vault**<br>**Part (24-Hour**<br>**Time-Boxed**<br>**Hold)**|CRUD|Create (For<br>Broker Lead)|No Access|CRUD|Create<br>(Rate-Limited)|
|**Verify COD**<br>**Payment**<br>**(TTD/USD) &**<br>**Issue Gate**<br>**Release Pass**|Read + Audit<br>Override|Denied (Strict<br>Separation)|No Access|Execute<br>(Exclusive<br>Authority)|No Access|
|**Disburse**<br>**Broker**<br>**Commission &**<br>**Log FX**<br>**Settlement**|<br>CRUD +<br>Reconcile|Read Own<br>Lead Status|No Access|Create /<br>Execute<br>Settlement|Read Own<br>Commission|



|System Module<br>/ Resource<br>Action|<br>Architect / CF|O Hunter /<br>Mechanic (Taz)|<br>Ontario Yard<br>Stripper|Trinidad Family<br>Admin|<br>Overseas B2B<br>Buyer / Broker|
|---|---|---|---|---|---|
|**Batch**||||||
|**View Master**<br>**P&L,**<br>**Canadian Cost**<br>**Basis & Exit**<br>**Valuation**<br>**Ledger**|<br>Full Access|Vehicle-Level<br>Gross Margin|No Access|Trinidad Vault<br>Ledger Only|No Access|



## **3. System Architecture (DDD + Clean Architecture Modular Monolith)** 

### **3.1 Technical Stack Specification** 

To maximize development velocity for a Senior Software Engineer while guaranteeing strict domain boundaries, horizontal worker scalability, and zero-downtime auditability, the platform is architected as a **Domain-Driven Design (DDD) Modular Monolith** adhering to **Clean / Hexagonal Architecture (Ports and Adapters)** . 

The frontend and offline mobile client layer is built on **Next.js 15+ (App Router)** with **React 19** and **TypeScript 5.x (Strict Mode)** , configured as an installable Progressive Web App (PWA) utilizing **Workbox Service Workers** , **IndexedDB (via Dexie.js)** for offline mutation queuing and binary blob caching in the rural Kemptville yard, and @zxing/browser paired with the native BarcodeDetector API for sub-100ms VIN and QR code scanning. The backend application core runs on **Node.js (v22 LTS)** executing inside Next.js Server Actions and Route Handlers for synchronous low-latency operations, complemented by standalone Node.js worker processes for heavy asynchronous pipelines. Persistence is managed by **PostgreSQL 16+** hosted on **Supabase** or **Neon** —providing point-in-time recovery, PgBouncer/Supavisor connection pooling, and Row-Level Security—accessed through **Prisma ORM** implementing transactional outbox patterns and optimistic concurrency control. Asynchronous job orchestration and distributed locking rely on **BullMQ** backed by **Redis 7.x** , which coordinates multi-step AI Vision enrichment Directed Acyclic Graphs (DAGs), rate-limited eBay API syndication, WhatsApp broadcast throttling, and Redlock-style inventory reservation locks. Media storage and delivery leverage **Cloudflare R2** (S3-compatible object storage with zero egress fees) fronted by **Cloudflare Workers and Images** for automatic WebP/AVIF transcoding, EXIF GPS coordinate stripping, and public URL provisioning required by the eBay Inventory API and Meta WhatsApp Cloud API media endpoints. 



<!-- Start of picture text -->
io 1: Kemptville Yard DDD Mc<br>LN 4g PWA<br>Node 2: Ramsayville; Repair:  Shop AcquisitioDismantli<br>E Context<br>a‘ Node 3: Ocean Freight Lane wae<br>sy Context<br>Ey<br>Node 4: Trinidad Bonded Vault Se<br><!-- End of picture text -->

### **3.2 Bounded Contexts, Ubiquitous Language & Domain Model** 

The modular monolith is partitioned into four strictly isolated Bounded Contexts under src/modules/, as structured in Table 3. Cross-context communication occurs exclusively via an 

in-process **Transactional Domain Event Bus** backed by a PostgreSQL OutboxEvent table and dispatched by BullMQ workers. 

|Bounded Context|Ubiquitous<br>Language Terms|Core Aggregate<br>Roots & Entities|Key Value Objects<br>(Immutable)|<br>Published Domain<br>Events|
|---|---|---|---|---|
|**1. Acquisition &**<br>**Dismantling**<br>**Context**<br>(src/modules/dism<br>antling)|<br>_Donor Asset,_<br>_Salvage Brand,_<br>_Strip Queue,_<br>_Zero-Typing_<br>_Intake, ARA_<br>_Condition Grade,_<br>_Damage Unit, Bin_<br>_Coordinate, Scrap_<br>_Clearance_|Vehicle (Aggregate<br>Root: Car,<br>Watercraft,<br>Equipment) Part<br>(Aggregate Root)<br>StorageLocation<br>(Site \rightarrow<br>Container<br>\rightarrow Rack<br>\rightarrow Shelf<br>\rightarrow Bin)<br>DismantleTask|<br> <br>VinOrHin (17-char<br>VIN / 12-char HIN)<br>AraConditionGrad<br>e (A, B1, B2, B3,<br>C, X)<br>AraDamageCode<br>(3-char<br>[Loc][Type][Units],<br>e.g., 5P1, 000)<br>BinCoordinate<br>(KEMP-C01-R02-<br>S03-B04)<br>DriveOnDossier<br>(SSC 36-day<br>window, SIC<br>status, 6 salvage<br>photos)|<br> <br>VehicleAcquiredEv<br>ent<br>VehicleBrandedRe<br>builtEvent<br>VehicleScrappedCl<br>earedEvent<br>RawPartStrippedE<br>vent<br>PartEnrichedAndG<br>radedEvent<br>Pa<br>rtShelvedInBinEve<br>nt|
|**2. Multi-Channel**<br>**Marketplace &**<br>**B2B Catalog**<br>**Context**<br>(src/modules/mark<br>etplace)|_Syndicated Offer,_<br>_Fitment Matrix,_<br>_ePID, Live_<br>_Container_<br>_Storefront,_<br>_Time-Boxed Hold,_<br>_Mechanic Wish_<br>_List, 24h Service_<br>_Window_|ChannelListing<br>(Aggregate Root)<br>B2BReservation<br>(Aggregate Root)<br>PreOrderWishList<br>(Aggregate Root)<br>WhatsAppBroadca<br>stCampaign|EbayCompatibility<br>List<br>(Year/Make/Model/<br>Trim/Engine array)<br>DualPriceMatrix<br>(CAD Retail, USD<br>FOB, TTD Landed<br>Wholesale)<br>WhatsAppWindow<br>State (Opt-in<br>timestamp, 24h<br>expiry)|<br> <br>Part[span_37](star<br>t_span)[span_37](<br>end_span)ListedO<br>nEbayEvent<br>EbayOrderReceive<br>dEvent<br>EbayOfferWithdra<br>wnEvent<br>B2BPartReserved<br>Event<br>B2BReservationEx<br>piredEvent<br>WishListMatchedT<br>oDonorEvent|
|**3. Export**<br>**Logistics &**<br>**Trinidad Bonded**<br>**Vault Context**<br>(src/modules/logist<br>ics-vault)|_LCL Pallet, FCL_<br>_Container, CERS_<br>_Proof of Report_<br>_(POR), ASYCUDA_<br>_CIF Value, Bonded_<br>_Vault, COD Gate_<br>_Lock, Broker_<br>_Commission_|<br> <br>Shipment<br>(Aggregate Root)<br>ShippingUnit<br>(Pallet / Container)<br>CustomsManifest<br>VaultTransaction<br>(Aggregate Root)<br>GateReleasePass|<br> <br>HsTariffClassificati<br>on (e.g., 8708.40,<br>8407.34)<br>CersDeclaration<br>(BN15, POR<br>Number, 48h<br>Marine Cutoff)<br>AsycudaLandedCo<br>st (CIF + Duty +<br>Processing + VAT)<br>CryptographicGate<br>Token|<br><br>PartScannedToPal<br>letEvent<br>ShipmentSealedF<br>orExportEvent<br>CersManifestGene<br>ratedEvent<br>ContainerLandedI<br>nTrinidadEvent<br>VaultPartCheckedI<br>nEvent<br>VaultCodPayment<br>VerifiedEvent|



|Bounded Context|Ubiquitous<br>Language Terms|Core Aggregate<br>Roots & Entities|Key Value Objects<br>(Immutable)|Published Domain<br>Events<br>GatePassExecute<br>dEvent|
|---|---|---|---|---|
|**4. Unit**<br>**Economics, CFO**<br>**Ledger & Capital**<br>**Gate Context**<br>(src/modules/cfo-le<br>dger)|_Capital Buffer_<br>_Gate, Deal_<br>_Analyzer, Verified_<br>_Receipt Expense,_<br>_Break-Even_<br>_Velocity, Parallel_<br>_FX Haircut,_<br>_Repatriation_<br>_Batch, SDE Audit_<br>_Trail_|CapitalPool<br>(Aggregate Root)<br>VehicleProfitLossL<br>edger (Aggregate<br>Root)<br>ExpenseEntry<br>(Entity)<br>CurrencySettleme<br>ntBatch<br>(Aggregate Root)|Money (Amount in<br>minor units + CAD<br>/ USD / TTD ISO<br>code)<br>FxExchangeRate<br>(Official CBTT<br>Rate vs. Parallel<br>Shadow Rate)<br>VerifiedReceiptAtt<br>achment (R2 Hash<br>+ OCR Total)|<br>DealProposalAppr<br>ovedEvent<br>DealProposalReje<br>ctedByGateEvent<br>ExpenseLoggedEv<br>ent<br>VehicleBreakEven<br>AchievedEvent<br>TtBankDepositLog<br>gedEvent<br>FxRepatriationSett<br>ledEvent|



#### **Deep-Dive Domain Rules: Automotive Salvage Standards (ARA / CIECA Integration)** 

To ensure parts stripped in Kemptville can be sold seamlessly to North American collision repair facilities (via eBay Motors and Car-Part.com) as well as Caribbean mechanics, the AraConditionGrade and AraDamageCode Value Objects enforce the official **Automotive Recyclers Association (ARA) and CIECA** grading standards. 

For mechanical components—including complete engines, transmissions, drive-axles, and watercraft powertrains—the system computes the grade automatically from the donor vehicle's odometer reading and model year age. Specifically, **Grade A (Excellent)** is assigned when the donor vehicle has logged under 60,000 total miles (\approx 96,560\text{ km}), or if over 60,000 miles, maintains an annual average under 15,000 miles per model year of age (\approx 24,140\text{ km/year}). **Grade B (Good)** applies to functional mechanical components from donor vehicles with 60,000 to 200,000 total miles (\approx 96,560\text{ to }321,868\text{ km}), or vehicles exceeding 60,000 miles whose annual average is 15,000 miles/year or higher. To support European and Caribbean buyer clarity, the domain further supports ARA/CIECA sub-grades B1 (function-tested and ready to fit), B2 (cosmetic marks but fully functional), and B3 (requires minor repair under one hour of labor excluding painting, with zero structural damage). **Grade C (Fair)** is assigned to operational mechanical parts derived from donor vehicles with 200,000 total miles or more (\ge 321,868\text{ km}) regardless of age, while X designates ungraded components awaiting inspection. 

For body panels, sheet metal, and large structural assemblies, grading is governed by surface **"Damage Units,"** where **1.0 Damage Unit is defined as an area not exceeding the surface area of a standard credit card** (\approx 46\text{ cm}^2). Standard body panels (doors, hoods, fenders, decklids) qualify as **Grade A** when exhibiting 0\text{ to }1.0 unit of damage (provided the panel has never been resprayed in a different color), **Grade B** when exhibiting 1.1\text{ to }2.0 units of damage, and **Grade C** when exceeding 2.0 units of damage. For large assemblies (front clips, rear clips, and cabs), the thresholds expand to 0\text{ to }3.0 total units for **Grade A** , 3.1\text{ to }6.0 units for **Grade B** , and >6.0 units for **Grade C** . Every body panel and wheel persists a structured 3-character ARA Damage Code ([Position 1: Clock Location 1–9][Position 2: Damage Type][Position 3: Credit-Card Units]), where Position 2 encodes specific defect types 

(D = Dent, S = Surface Scratch/Scuff, R = Rust/Corrosion, H = Hail, E = Bent, P = Parking Lot Ding, J = Rip/Crack, K = Buckle, G = Gouge, T = Paint/Lacquer problem) and 000 signifies zero damage in any position (for example, 5P1 denotes a center-panel parking lot ding \le 1 credit card area, whereas 2S2 denotes a lower-left surface scrape covering 2 credit card areas). Used alloy and steel wheels undergo mandatory visual screening at strip time: any wheel exhibiting cracks or structural distortion is immediately routed to scrap, as hammering, straightening, or reforming wheels is strictly prohibited under ARA safety standards; undamaged wheels are graded A (zero blemish, 000), B (\le 1 credit-card unit blemish), or C (>1 unit blemish) across Outside Edge, Face, Centre, and Inside Edge zones. 

### **3.3 Hexagonal Architecture: Ports & Adapters Specification** 

All external integrations are abstracted behind TypeScript Domain Port interfaces inside src/core/ports/. Concrete adapters in 

sr[span_75](start_span)[span_75](end_span)[span_80](start_span)[span_80](end_span)c/infras tructure/adapters/ implement these interfaces, allowing external services—such as swapping OpenAI GPT-4o for Claude 3.5 Sonnet or Gemini 1.5 Pro, or switching direct Meta WhatsApp Cloud API calls to a Business Solution Provider (BSP)—to be hot-swapped via dependency injection without modifying domain logic. `// src/core/ports/external-integrations.ports.ts` 

```
export type AraGrade = 'A' | 'B1' | 'B2' | 'B3' | 'C' | 'X';
export interface DecodedVehicleSpec {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  bodyClass: string;
  engineCylinders: number | null;
  displacementL: number | null;
  engineModel: string | null;
  driveType: string | null;
  transmissionStyle: string | null;
  fuelTypePrimary: string | null;
  gvwrClass: string | null;
  plantCountry: string | null;
  rawNhtsaPayload: Record<string, string>;
}
/**
 * 1. VIN DECODER PORT (Implemented by NhtsaVpicAdapter)
 * Calls GET
https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/{vin}?
format=json&modelyear={year}
 */
export interface IVinDecoderPort {
```

```
  decodeVin(vin: string, modelYearHint?: number):
Promise<DecodedVehicleSpec>;
  decodePartialVin(partialVinWithAsterisks: string, modelYearHint?:
number): Promise<DecodedVehicleSpec>;
}
```

```
export interface VisionEnrichmentInput {
  partId: string;
  cleanImageUrls: string[]; // Background-removed Cloudflare R2 public
URLs
  donorVehicle?: DecodedVehicleSpec;
  donorMileageKm?: number;
}
export interface VisionEnrichmentResult {
  extractedOemPartNumbers: string[];
  partCategoryName: string;
  suggestedHsCode: string; // e.g., "8708.40" for gearboxes, "8708.29"
for body panels
  estimatedWeightKg: number;
  araConditionGrade: AraGrade;
  araDamageCode: string; // e.g., "000", "5P1", "2S2"
  conditionNotes: string;
  seoEbayTitle: string; // Strictly <= 80 chars: "[Year] [Make]
[Model] [Part Name] OEM [Part Number]"
  ebayCategoryId: string;
  recommendedAspects: Record<string, string[]>; // eBay
product.aspects format
  confidenceScore: number; // 0.0 to 1.0
}
/**
 * 2. AI VISION & ENRICHMENT PORT (Implemented by OpenAiGpt4oAdapter /
AnthropicClaudeAdapter / GeminiProAdapter)
 */
export interface IVisionEnrichmentPort {
  analyzeStrippedPart(input: VisionEnrichmentInput):
Promise<VisionEnrichmentResult>;
  parseExpenseReceipt(receiptImageUrl: string): Promise<{
    vendorName: string;
    receiptDateIso: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    currency: 'CAD' | 'USD' | 'TTD';
    lineItems: Array<{ description: string; amountMinor: number }>;
  }>;
}
```

```
export interface EbayFitmentVehicle {
  year: string;
  make: string;
  model: string;
  trim?: string;
  engine?: string;
}
export interface MarketplacePublishPayload {
  sku: string;
  title: string;
  descriptionHtml: string;
  priceCadMinor: number;
  conditionEnum: 'USED_EXCELLENT' | 'USED_GOOD' | 'USED_ACCEPTABLE' |
'FOR_PARTS_OR_NOT_WORKING';
  conditionDescription: string; // Includes ARA Grade & 3-char Damage
Code
  imageUrls: string[];
  aspects: Record<string, string[]>; // e.g., { "Brand": ["Kia"],
"Manufacturer Part Number": ["86511-S9000"] }
  epid?: string;
  compatibleVehicles: EbayFitmentVehicle[];
  packageWeightKg: number;
  dimensionsCm: { length: number; width: number; height: number };
}
/**
 * 3. MARKETPLACE SYNDICATION PORT (Implemented by
EbayInventoryApiAdapter, CarPartEdiAdapter)
 * Orchestrates PUT /sell/inventory/v1/inventory_item/{sku},
 * PUT /sell/inventory/v1/inventory_item/{sku}/product_compatibility,
 * POST /sell/inventory/v1/offer, and POST
/sell/inventory/v1/bulk_update_price_quantity
 */
export interface IMarketplaceSyndicationPort {
  upsertAndPublishListing(payload: MarketplacePublishPayload):
Promise<{
    externalListingId: string;
    externalOfferId: string;
    channel: 'EBAY_MOTORS' | 'CAR_PART' | 'FB_MARKETPLACE';
  }>;
  /**
   * Immediately sets availableQuantity = 0 via
bulkUpdatePriceQuantity or withdraws offer
   * the millisecond a part is scanned into a Trinidad pallet or
reserved on WhatsApp.
   */
```

```
  atomicZeroInventoryLock(sku: string, externalOfferId: string,
reason: string): Promise<boolean>;
  fetch90DaySoldComps(oemPartNumber: string, fallbackQuery: string):
Promise<{
    medianSoldPriceCadMinor: number;
    p25SoldPriceCadMinor: number;
    p75SoldPriceCadMinor: number;
    soldCount90d: number;
    activeCompetitorCount: number;
  }>;
}
/**
 * 4. WHATSAPP B2B BROADCAST PORT (Implemented by
MetaWhatsAppCloudApiAdapter)
 * Calls POST
https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
 */
export interface IB2BBroadcastPort {
  sendTemplateMessage(params: {
    recipientPhoneE164: string;
    templateName: string; // Pre-approved Utility or Marketing
template for outside 24h window
    languageCode: string;
    headerMediaUrl?: string; // JPG/PNG <= 5MB or PDF <= 100MB
    bodyVariables: string[];
    ctaButtonUrlSuffix?: string;
  }): Promise<{ metaMessageId: string; status: string }>;
  sendInteractiveCatalogMessage(params: {
    recipientPhoneE164: string; // Allowed only when contact has
active <24h service window
    bodyText: string;
    replyButtons?: Array<{ id: string; title: string }>; // Max 3
buttons
    listSections?: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description: string }>;
    }>; // Max 10 sections
  }): Promise<{ metaMessageId: string }>;
}
```

## **4. Complete Database Schema & State Machines** 

### **4.1 Production PostgreSQL / Prisma Schema** 

The following schema.prisma specification enforces referential integrity, multi-currency minor-unit accounting (BigInt and Int in cents to prevent IEEE 754 floating-point rounding errors), mandatory receipt image tracking, and immutable audit trails. `// prisma/schema.prisma datasource db { provider = "postgresql" url      = env("DATABASE_URL") } generator client { provider = "prisma-client-js" } enum UserRole { ARCHITECT_CFO HUNTER_MECHANIC ONTARIO_STRIPPER TRINIDAD_VAULT_ADMIN OVERSEAS_B2B_BUYER } enum AssetCategory { AUTOMOBILE WATERCRAFT SHOP_EQUIPMENT } enum OntarioVehicleBrand { NONE SALVAGE REBUILT IRREPARABLE NOT_APPLICABLE // Watercraft / Equipment } enum OperationalLane { QUICK_TURN_BEATER HIGH_END_REBUILD DISMANTLE_AND_EXPORT WHOLE_UNIT_EXPORT } enum VehicleLifecycleState { PROPOSED_DEAL ACQUIRED_IN_TRANSIT STAGED_ONTARIO_YARD IN_RAMSAYVILLE_SHOP PENDING_DRIVEON_SIC_SSC` 

```
  READY_FOR_RETAIL_SALE
  SOLD_RETAIL_ONTARIO
  DISMANTLING_IN_PROGRESS
  HULK_STRIPPED_AWAITING_CRUSH
  SCRAPPED_METAL_CLEARED // Mandatory bylaw-compliance terminal state
for stripped shells
  MANIFESTED_WHOLE_EXPORT
  LANDED_TRINIDAD_VAULT
  SOLD_EXPORT_COD
}
enum PartLifecycleState {
  STRIPPED_RAW_OFFLINE
  ENRICHING_AI_VISION
  SHELVED_ONTARIO_CONTAINER
  SYNDICATED_DOMESTIC_LIVE
  RESERVED_B2B_HOLD
  SOLD_DOMESTIC_PENDING_SHIP
  SHIPPED_DOMESTIC_SETTLED
  SCANNED_TO_EXPORT_PALLET
  IN_TRANSIT_OCEAN_FREIGHT
  CUSTOMS_HOLD_PORT_OF_SPAIN
  SHELVED_TRINIDAD_VAULT
  PENDING_VAULT_COD_PAYMENT
  PAID_SETTLED_IN_VAULT
  RELEASED_AT_VAULT_GATE // Terminal state after Family Admin COD
check + Gate scan
  SCRAPPED_OR_DAMAGED
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
```

```
  TOWING_AND_RECOVERY
  RAMSAYVILLE_SHOP_LABOR
  PRIME_CHOICE_AFTERMARKET_PARTS
  OEM_REBUILD_PARTS
  DRIVEON_SIC_INSPECTION_FEE
  DRIVEON_SSC_INSPECTION_FEE
  STEAM_CLEANING_EXPORT_PREP
  OCEAN_FREIGHT_LCL_FCL
  CBSA_CUSTOMS_BROKERAGE
  TRINIDAD_ASYCUDA_DUTY_VAT
  PORT_OF_SPAIN_DRAYAGE
  PACKAGING_AND_THERMAL_LABELS
}
```

```
model User {
  id                String    @id @default(uuid()) @db.Uuid
  email             String    @unique
  phoneE164         String?   @unique
  fullName          String
  role              UserRole
  commissionRateBps Int       @default(0) // e.g., 500 = 5.00%, 1000 =
10.00% for Trinidad brokers
  whatsappOptInAt   DateTime?
  whatsappWindowExp DateTime?
  isActive          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  strippedParts     Part[]             @relation("StrippedByUser")
  loggedExpenses    Expense[]          @relation("LoggedByUser")
  vaultSalesBroker  VaultTransaction[] @relation("BrokerUser")
  vaultAdminRelease VaultTransaction[] @relation("VaultAdminUser")
  wishLists         PreOrderWishList[]
  auditLogs         AuditLog[]
}
```

```
model StorageLocation {
  id            String   @id @default(uuid()) @db.Uuid
  siteCode      String   // "KEMP" (Kemptville), "RAMS" (Ramsayville),
"POSV" (Port of Spain Vault)
  containerCode String   // "C01".."C04" (Ontario) or "V01" (Trinidad
Vault)
  rackCode      String   // "R01".."R10"
  shelfCode     String   // "S01".."S05"
  binCode       String   // "B01".."B20"
  fullQrBarcode String   @unique // e.g., "KEMP-C01-R02-S03-B04"
  maxWeightKg   Decimal  @default(150.0) @db.Decimal(6, 2)
  isHeatedZone  Boolean  @default(false)
```

```
  createdAt     DateTime @default(now())
```

```
  parts         Part[]
  @@index([siteCode, containerCode])
}
model Vehicle {
  id                          String                @id
@default(uuid()) @db.Uuid
  internalStockNumber         String                @unique // e.g.,
"VEH-2026-0042"
  assetCategory               AssetCategory
@default(AUTOMOBILE)
  vinOrHin                    String                @unique // 17-char
VIN or 12-char Watercraft HIN
  year                        Int
  make                        String
  model                       String
  trim                        String?
  engineSpec                  String?               // e.g., "2.5L I4
Smartstream" or "300HP Rotax 1630 ACE"
  odometerKm                  Int?
  exteriorColor               String?
  ontarioBrand                OntarioVehicleBrand   @default(NONE)
  operationalLane             OperationalLane
  lifecycleState              VehicleLifecycleState
@default(PROPOSED_DEAL)
```

```
  // Capital Gate & CFO Deal Analyzer Baseline (Stored in CAD cents)
  estimatedMaxBidCadMinor     Int
  actualPurchasePriceCadMinor Int                   @default(0)
  estimatedRepairCadMinor     Int                   @default(0)
  targetResaleOrPartoutMinor  Int                   @default(0)
  cfoGateApprovedById         String?               @db.Uuid
  cfoGateApprovedAt           DateTime?
  // Ontario MTO DriveON & Salvage-to-Rebuilt Compliance Dossier
  salvageDamagePhotoUrls      String[]              // Mandatory >= 6
colour photos for Salvage -> Rebuilt
  driveOnSicNumber            String?               // Structural
Inspection Certificate ID
  driveOnSicPassedAt          DateTime?
  driveOnSscNumber            String?               // Safety
Standards Certificate ID
  driveOnSscIssuedAt          DateTime?
  driveOnSscExpiresAt         DateTime?             // Strictly
driveOnSscIssuedAt + 36 calendar days
```

```
  uvipDocumentUrl             String?               // Used Vehicle
Information Package PDF
```

```
  // Export & Bylaw Compliance Tracking
  steamCleanedReceiptUrl      String?               // Required by
CBSA / Destination Port to prevent soil quarantine
  fluidsDrainedAndAcCappedAt  DateTime?             // Mandatory ARA /
ICBC environmental & shipping prep
  scrapMetalTicketUrl         String?               // Weigh-scale
receipt proving shell left Kemptville yard
  scrappedClearedAt           DateTime?
  realizedRetailSaleCadMinor  Int?
  soldAt                      DateTime?
  createdAt                   DateTime              @default(now())
  updatedAt                   DateTime              @updatedAt
```

```
  parts                       Part[]
  expenses                    Expense[]
  shipmentId                  String?               @db.Uuid
  shipment                    Shipment?             @relation(fields:
[shipmentId], references: [id])
```

```
  @@index([lifecycleState, operationalLane])
  @@index([make, model, year])
}
model Part {
  id                        String                @id @default(uuid())
@db.Uuid
  qrSkuCode                 String                @unique //
Pre-printed synthetic label e.g., "PRT-884920"
  donorVehicleId            String                @db.Uuid
  donorVehicle              Vehicle               @relation(fields:
[donorVehicleId], references: [id])
  strippedByUserId          String                @db.Uuid
  strippedByUser            User
@relation("StrippedByUser", fields: [strippedByUserId], references:
[id])
  lifecycleState            PartLifecycleState
@default(STRIPPED_RAW_OFFLINE)
  partCategoryName          String
@default("UNCLASSIFIED")
  oemPartNumbers            String[]              // Extracted via
Vision OCR from casting/label
  interchangePartNumbers    String[]              // Hollander / OEM
cross-reference numbers
```

```
  hsTariffCode              String                @default("8708.99")
// e.g., "8708.10" Bumpers, "8708.40" Gearboxes
  // ARA / CIECA Standard Grading
  araGrade                  AraConditionGradeEnum @default(GRADE_X)
  araDamageCode             String                @default("000") //
3-char [Loc][Type][CreditCardUnits] e.g. "5P1"
  conditionNotes            String?
  weightKg                  Decimal               @default(2.50)
@db.Decimal(6, 2)
  dimensionsCm              Json?                 // { "l": 40, "w":
30, "h": 20 }
  // Media Assets (Cloudflare R2)
  rawPhotoUrls              String[]
  cleanPhotoUrls            String[]              //
Background-removed studio-grade WebP images
  // Storage & Logistics Pointers
  storageLocationId         String?               @db.Uuid
  storageLocation           StorageLocation?      @relation(fields:
[storageLocationId], references: [id])
  shipmentPalletId          String?               @db.Uuid
  shipmentPallet            ShipmentPallet?       @relation(fields:
[shipmentPalletId], references: [id])
  // Dual Pricing & Valuation (Minor Units / Cents)
  allocatedCostBasisCadMinor Int                  @default(0)
  ebayCompMedianCadMinor     Int?
  retailPriceCadMinor        Int?                 // Domestic eBay /
Ottawa price
  wholesaleFobUsdMinor       Int?                 // Customs Invoice
FOB declaration value
  landedCostTtdMinor         Int?                 // CIF + Trinidad
Duty + VAT + Freight share
  vaultFloorPriceTtdMinor    Int?                 // Minimum COD price
in Trinidad (includes FX haircut reserve)
  // External Marketplace Sync State & Optimistic Concurrency
  ebayOfferId               String?               @unique
  ebayListingId             String?               @unique
  ebayTitle                 String?               @db.VarChar(80)
  ebayAspectsJson           Json?
  ebayCompatibilityJson     Json?
  version                   Int                   @default(1) //
Optimistic lock counter
  strippedAt                DateTime              @default(now())
```

```
  updatedAt                 DateTime              @updatedAt
```

```
  b2bReservations           B2BReservation[]
  vaultTransactionItem      VaultTransactionItem?
  @@index([lifecycleState])
  @@index([donorVehicleId])
  @@index([storageLocationId])
}
model Shipment {
  id                        String           @id @default(uuid())
@db.Uuid
  shipmentCode              String           @unique // e.g.,
"EXP-2026-TT-001"
  mode                      String           // "LCL_PALLET" or
"FCL_20FT" or "FCL_40FT_HC"
  originPort                String           @default("CA_MTR") //
Montreal or Halifax
  destinationPort           String           @default("TT_POS") //
Port of Spain or Bridgetown
  carrierName               String?
  vesselName                String?
  oceanBillOfLadingNumber   String?
  // CBSA CERS & Canadian Export Compliance
  exporterBn15              String           // 15-character CRA/CBSA
Business Number (RM account)
  cersProofOfReportNumber   String?          @unique // Mandatory CBSA
CERS POR Number
  vesselLoadingCutoffAt     DateTime?        // CERS must be accepted
>= 48 hours prior to this timestamp
  cersSubmittedAt           DateTime?
  // Trinidad ASYCUDA World Customs Valuation Summary (USD & TTD Minor
Units)
  declaredFobTotalUsdMinor  Int              @default(0)
  oceanFreightUsdMinor      Int              @default(0)
  marineInsuranceUsdMinor   Int              @default(0)
  cifTotalUsdMinor          Int              @default(0)
  assessedDutyTtdMinor      Int              @default(0)
  assessedVatTtdMinor       Int              @default(0) // 12.5%
Trinidad VAT on (CIF + Duty + Fees)
```

```
  departedAt                DateTime?
  arrivedPortAt             DateTime?
  clearedCustomsAt          DateTime?
  createdAt                 DateTime         @default(now())
```

```
  pallets                   ShipmentPallet[]
  wholeVehicles             Vehicle[]
  expenses                  Expense[]
}
model ShipmentPallet {
  id              String   @id @default(uuid()) @db.Uuid
  shipmentId      String   @db.Uuid
  shipment        Shipment @relation(fields: [shipmentId], references:
[id])
  palletQrCode    String   @unique // e.g., "PLT-2026-001"
  grossWeightKg   Decimal  @db.Decimal(8, 2)
  dimensionsCm    Json     // { "l": 120, "w": 100, "h": 150 }
  sealedAt        DateTime?
  parts           Part[]
}
model Expense {
  id                  String          @id @default(uuid()) @db.Uuid
  vehicleId           String?         @db.Uuid
  vehicle             Vehicle?        @relation(fields: [vehicleId],
references: [id])
  shipmentId          String?         @db.Uuid
  shipment            Shipment?       @relation(fields: [shipmentId],
references: [id])
  loggedByUserId      String          @db.Uuid
  loggedByUser        User            @relation("LoggedByUser",
fields: [loggedByUserId], references: [id])
  category            ExpenseCategory
  vendorName          String
  description         String
  amountOriginalMinor Int
  currencyOriginal    CurrencyCode    @default(CAD)
  amountCadMinor      Int             // Converted at spot/settlement
rate for unified P&L
  // Strict Audit Enforcement: Every expense requires a non-empty
receipt image in Cloudflare R2
  receiptImageUrl     String          // Validated non-empty at DB &
application layer
  receiptOcrJson      Json?
  incurredAt          DateTime
  createdAt           DateTime        @default(now())
  @@index([vehicleId])
```

```
  @@index([shipmentId])
}
```

```
model PreOrderWishList {
  id                  String    @id @default(uuid()) @db.Uuid
  requesterUserId     String    @db.Uuid
  requesterUser       User      @relation(fields: [requesterUserId],
references: [id])
  targetYearStart     Int
  targetYearEnd       Int
  targetMake          String    // e.g., "Kia", "Hyundai", "Mazda",
"Yamaha"
  targetModel         String    // e.g., "Sportage", "Tucson", "CX-5",
"FX Cruiser SVHO"
  partDescription     String
  oemPartNumberHint   String?
  maxBidWillingTtdMinor Int
  urgencyLevel        String    @default("HIGH")
  isFulfilled         Boolean   @default(false)
  matchedPartId       String?   @db.Uuid
  createdAt           DateTime  @default(now())
```

```
  @@index([targetMake, targetModel, isFulfilled])
}
```

```
model B2BReservation {
  id              String   @id @default(uuid()) @db.Uuid
  partId          String   @db.Uuid
  part            Part     @relation(fields: [partId], references:
[id])
  buyerPhoneE164  String
  brokerUserId    String?  @db.Uuid
  quotedTtdMinor  Int
  expiresAt       DateTime // Strictly 24 hours from creation unless
deposit verified
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
```

```
  @@index([partId, isActive])
}
```

```
model VaultTransaction {
  id                      String                 @id @default(uuid())
@db.Uuid
  receiptNumber           String                 @unique // e.g.,
"POS-COD-2026-0089"
  buyerName               String
  buyerPhoneE164          String
```

```
  brokerUserId            String?                @db.Uuid
  brokerUser              User?
@relation("BrokerUser", fields: [brokerUserId], references: [id])
  authorizedByAdminId     String                 @db.Uuid
  authorizedByAdmin       User
@relation("VaultAdminUser", fields: [authorizedByAdminId], references:
[id])
```

```
  // Financial Totals (Strictly COD)
  paymentCurrency         CurrencyCode           @default(TTD)
  grossCollectedMinor     Int                    // Total TTD or USD
collected at Vault counter
  paymentMethod           String                 // "CASH_TTD",
"CASH_USD", "VERIFIED_TT_BANK_WIRE"
  bankDepositSlipUrl      String?
  ttdCommercialBankName   String?                // Tracked against
TTD $200,000 deposit insurance cap
```

```
  // Broker Commission Accounting (5% - 10%)
  brokerCommissionBps     Int                    @default(0)
  brokerCommissionMinor   Int                    @default(0)
  brokerCommissionPaidAt  DateTime?
```

```
  // Strict Gate Lock State
  isPaymentVerified       Boolean                @default(false)
  cryptographicGateToken  String?                @unique
  gateReleasedAt          DateTime?
  settlementBatchId       String?                @db.Uuid
  settlementBatch         CurrencySettlement?    @relation(fields:
[settlementBatchId], references: [id])
  createdAt               DateTime               @default(now())
  items                   VaultTransactionItem[]
}
```

```
model VaultTransactionItem {
  id                 String           @id @default(uuid()) @db.Uuid
  vaultTransactionId String           @db.Uuid
  vaultTransaction   VaultTransaction @relation(fields:
[vaultTransactionId], references: [id])
  partId             String           @unique @db.Uuid
  part               Part             @relation(fields: [partId],
references: [id])
  soldPriceMinor     Int
}
```

```
model CurrencySettlement {
```

```
  id                        String             @id @default(uuid())
@db.Uuid
  batchCode                 String             @unique // e.g.,
"FX-TTD-CAD-2026-04"
  sourceCurrency            CurrencyCode       @default(TTD)
  targetCurrency            CurrencyCode       @default(CAD)
  totalSourceAmountMinor    BigInt             // Total TTD converted
in batch
  totalTargetSettledMinor   BigInt             // Total CAD/USD landed
in Canadian bank account
  officialCbttRate          Decimal            @db.Decimal(10, 6) //
Official Central Bank rate (~6.78 TTD/USD)
  effectiveClearingRate     Decimal            @db.Decimal(10, 6) //
Actual parallel/bank rate achieved (e.g., 7.35 TTD/USD)
  fxSlippageLossCadMinor    Int                @default(0)
  conversionChannel         String             //
"COMMERCIAL_BANK_QUEUE", "TRADE_OFFSET", "AUTHORIZED_DEALER"
  canadianBankWireProofUrl  String
  initiatedAt               DateTime           @default(now())
  settledInCanadaAt         DateTime?
```

```
  vaultTransactions         VaultTransaction[]
}
```

```
model AuditLog {
  id            String   @id @default(uuid()) @db.Uuid
  actorUserId   String   @db.Uuid
  actorUser     User     @relation(fields: [actorUserId], references:
[id])
  entityType    String
  entityId      String
  action        String
  previousState Json?
  nextState     Json?
  ipAddress     String?
  createdAt     DateTime @default(now())
```

```
  @@index([entityType, entityId])
```

```
}
```

### **4.2 Deterministic State Machines & Domain Invariants** 

#### **Vehicle Lifecycle Invariants (Protecting Municipal Bylaws & MTO DriveON Compliance)** 

The Vehicle aggregate enforces four non-negotiable legal and operational invariants across 

Ontario's regulatory regime. First, the **Kemptville Rural Bylaw Protection Invariant (SCRAPPED_METAL_CLEARED)** addresses rural Ontario municipal "clean yard" and land-use bylaws, which are typically enforced on a complaint-driven basis when visibly stripped car shells accumulate outdoors. The system enforces a hard yard capacity cap allowing no more than **4 active DISMANTLING_IN_PROGRESS or HULK_STRIPPED_AWAITING_CRUSH shells** inside the container-shielded dismantling pad at any time. A stripped vehicle cannot transition to the terminal SCRAPPED_METAL_CLEARED state—and the Hunter (Taz) is programmatically blocked from dispatching a new salvage tow to Kemptville once the 4-shell cap is reached—until both fluidsDrainedAndAcCappedAt is timestamped in accordance with ARA environmental preparation guidelines and a valid scrapMetalTicketUrl (a weigh-scale receipt from a licensed metal recycler) is uploaded. 

Second, the **Ramsayville Lot Capacity Invariant** protects the partner repair shop in Ramsayville, which has physical lot space for **7 to 8 vehicles maximum** . Any state transition from ACQUIRED_IN_TRANSIT to 

IN[span_56](start_span)[span_56](end_span)_RAMSAYVILLE_SHOP executes an atomic count query across active shop states (IN_RAMSAYVILLE_SHOP, 

PENDING_DRIVEON_SIC_SSC, and READY_FOR_RETAIL_SALE). If the count is \ge 8, the transition is rejected until a finished vehicle is sold or relocated to Kemptville staging. Third, the **Ontario Salvage-to-Rebuilt Dossier Invariant (O. Reg. 376/02)** governs any vehicle carrying an ontarioBrand = SALVAGE assigned to the HIGH_END_REBUILD lane. Under Ontario's Mandatory Vehicle Branding Program, a Salvage vehicle cannot be plated for road use until it passes both a structural inspection at a licensed MTO DriveON Vehicle Inspection Centre (VIC) authorized for structural inspections and a separate mechanical safety inspection. Consequently, the ERP blocks transitioning a salvage rebuild to PENDING_DRIVEON_SIC_SSC unless 

salvageDamagePh[span_33](start_span)[span_33](end_span)otoUrls.length >= 6 (verifying the mandatory minimum of six colour photographs showing the front, both sides, rear, VIN plate, and odometer in its damaged state prior to repair), all major replacement components have linked donor VINs and verified purchase invoices attached in the Expense table, and the vehicle is verified not to be a motorcycle (as Ontario law since July 16, 2007 prohibits issuing a Structural Inspection Certificate for a salvage motorcycle, automatically routing salvage motorcycles to DISMANTLE_AND_EXPORT). 

Fourth, the **36-Day DriveON Safety Standards Certificate (SSC) Expiry Timer** tracks the statutory validity window of Ontario safety certificates. When driveOnSscIssuedAt is recorded upon receiving an emailed confirmation from a licensed DriveON VIC, the system automatically computes driveOnSscExpiresAt = driveOnSscIssuedAt + 36 calendar days. If a retail beater or rebuilt vehicle is not registered/transferred to a buyer before Day 30, high-priority alerts fire to Taz and the CFO; at Day 37, if still unsold, the vehicle automatically reverts from READY_FOR_RETAIL_SALE to PENDING_DRIVEON_SIC_SSC to account for the mandatory re-inspection cost. 

#### **Part Lifecycle Invariants (Zero Double-Selling & Strict Trinidad COD Lock)** 

The Part aggregate eliminates cross-border channel conflict and credit leakage through three atomic state guards. First, the **Atomic Channel Lock** prevents double-selling between eBay Motors and ocean freight containers. A part in SYNDICATED_DOMESTIC_LIVE maintains an active offer on eBay Motors (ebayOfferId). The millisecond a worker in Kemptville scans that part's QR code onto an outbound Trinidad pallet 

(SCANNED_T[span_25](start_span)[span_25](end_span)O_EXPORT_PALLET) or an overseas buyer places a reservation (RESERVED_B2B_HOLD), the database transaction increments Part.version (optimistic concurrency lock) and synchronously invokes EbayInventoryApiAdapter.atomicZeroInventoryLock(sku, ebayOfferId), which executes eBay's bulkUpdatePriceQuantity API method to set availableQuantity = 0. Conversely, if an inbound eBay order webhook signals a domestic sale first, the part immediately transitions to SOLD_DOMESTIC_PENDING_SHIP, causing the Kemptville Yard Scanner PWA to emit an audible alarm and render a full-screen red lock ("STOP: SOLD ON EBAY — DO NOT PACK IN TRINIDAD CONTAINER") if a worker attempts to scan it onto an export pallet. Second, the Trinidad Bonded Vault COD Gate Lock (PAID_SETTLED_IN_VAULT) enforces the strict separation of sales and collection in Port of Spain. Once a part is checked into the Trinidad warehouse (SHELVED_TRINIDAD_VAULT), neither the Hunter (Taz) nor any local commissioned broker possesses permissions to transition the part to RELEASED_AT_VAULT_GATE. Only a user authenticated with role = TRINIDAD_VAULT_ADMIN (or ARCHITECT_CFO) can execute the verifyCodPayment mutation, which requires recording grossCollectedMinor >= part.vaultFloorPriceTtdMinor, specifying the verified payment method (CASH_TTD, CASH_USD, or VERIFIED_TT_BANK_WIRE), and generating an HMAC-SHA256 signed cryptographicGateToken. Third, the **Commission Holdback Invariant** guarantees at the database level that VaultTransaction.brokerCommissionPaidAt cannot be populated until isPaymentVerified == true, mathematically preventing commissioned sales brokers from collecting referral payouts on uncollected or partial customer payments. 

## **5. Core Functional Modules & Detailed User Stories** 

### **5.1 Module A: Offline-First "Zero-Typing" Yard Intake PWA** 

Module A enables an unskilled yard stripper working in -30°C Kemptville weather with greasy gloves and zero cellular signal behind steel shipping containers to catalog a stripped automotive or marine part, bind it to a weatherproof QR tag, and assign it to a container shelf bin in under 30 seconds without typing a single character. 

The interface enforces a deterministic three-tap workflow. In **Tap 1 (Donor Context Lock)** , at the beginning of a dismantling session, the worker scans the donor vehicle's door-jamb VIN barcode or selects the vehicle's high-contrast photograph from the offline cached "Active Strip Queue." The PWA locks the donor vehicleId in localStorage and IndexedDB for all subsequent parts until explicitly switched, while displaying a visual compliance banner for mechanical and A/C components reminding the worker to drain all fluids and cap and seal A/C lines at the time of dismantling. In **Tap 2 (Guided 3-Photo Capture & QR Tag Binding)** , the worker attaches a pre-printed synthetic QR SKU tag (PRT-XXXXXX) to the part and captures three rapid photographs using a guided camera viewfinder overlay: Frame 1 captures a wide overview of the component; Frame 2 uses a macro framing box to capture the stamped OEM part number or casting serial sticker; and Frame 3 captures the attached PRT-XXXXXX QR label alongside any visible surface damage. An in-browser @zxing/browser Web Worker automatically decodes the PRT-XXXXXX QR payload directly from Frame 3 (or via a 200ms live viewfinder pass), binding the digital record to the physical tag without requiring a separate barcode scan step. In **Tap 3 (Container Shelf Bin Scan)** , the worker carries the part into one of the four Kemptville shipping containers and scans the QR placard on the destination shelf bin (such as 

KEMP-C02-R04-S02-B08). The PWA emits a high-decibel confirmation chime, triggers haptic vibration, and immediately resets to Frame 1 for the next stripped part. 

To guarantee offline resilience across rural cellular dead zones, all captured photos are compressed client-side via OffscreenCanvas into WebP format (1600\text{px} maximum dimension, \approx 180\text{ KB} per image) and persisted as binary Blob records in IndexedDB alongside an immutable OfflineIntakeMutation payload containing a client-generated UUIDv7 idempotencyKey, donorVehicleId, qrSkuCode, binQrBarcode, and strippedAt timestamp. When the worker walks back toward the yard office Wi-Fi or regains LTE connectivity, the Workbox Service Worker drains the IndexedDB outbox queue via multipart pre-signed Cloudflare R2 uploads followed by an idempotent batch POST to /api/v1/yard/intake-sync. If an offline worker inadvertently scans the same PRT-XXXXXX sticker onto two different parts while disconnected, a local IndexedDB unique index on qrSkuCode immediately triggers a red visual and audio error ("DUPLICATE TAG SCANNED — PEEL A NEW QR LABEL") before the worker leaves the tagging bench. 

### **5.2 Module B: Asynchronous AI Vision & Auto-Pricing Pipeline** 

Module B automatically transforms raw yard photographs into SEO-optimized eBay Motors listings complete with extracted OEM part numbers, NHTSA vehicle fitment tables, ARA condition grades, and dual CAD/TTD pricing without manual clerical entry. Upon receiving a RawPartStrippedEvent, the BullMQ part-enrichment-queue executes a five-stage asynchronous Directed Acyclic Graph (DAG) workflow. In **Stage 1 (Automated Background Removal & Studio Enhancement)** , the worker fetches the raw WebP images from Cloudflare R2, invokes an automated background-removal API (Photoroom API, Remove.bg, or a self-hosted rembg ONNX worker), composites the part onto a pure #FFFFFF studio canvas with a subtle drop shadow, overlays a corner watermark badge bearing the qrSkuCode, and writes the clean WebP URLs back to R2. In **Stage 2 (NHTSA vPIC Donor Vehicle Enrichment)** , if the donor vehicle's specifications are not yet cached, the worker queries the NHTSA Product Information Catalog and Vehicle Listing (vPIC) flat-format extended endpoint (GET 

https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/{vin}?format=json&modelyear ={year}) to retrieve exact values for Make, Model, ModelYear, Trim, BodyClass, EngineCylinders, DisplacementL, DriveType, and TransmissionStyle, including support for partial VIN decoding using asterisks (*) if a salvage VIN plate is partially damaged. In **Stage 3 (Multimodal LLM OCR & ARA Condition Grading)** , the worker dispatches the three studio images alongside the decoded NHTSA donor specification and donor odometer reading (odometerKm) to IVisionEnrichmentPort (implemented via OpenAI GPT-4o, Anthropic Claude 3.5 Sonnet, or Google Gemini 1.5 Pro using strict JSON Schema structured outputs). The multimodal model extracts stamped or molded OEM part numbers from dirty castings, estimates visible surface damage in credit-card units (1.0\text{ unit} \approx 46\text{ cm}^2) to output a valid 3-character ARA Damage Code (000 for undamaged panels, or [ClockPosition 1-9][Type D/S/R/H/E/P/J/K/G/T][Units]), combines donor mileage with visual inspection to assign the deterministic ARA Condition Grade (A, B1, B2, B3, or C), classifies the 6-digit Harmonized System (HS) Tariff Code under Heading 8708 (or 8407/8408 for complete engines), and generates an SEO-optimized eBay title strictly \le 80 characters formatted as [Year] [Make] [Model] [Part Name] OEM [Part Number] alongside required product.aspects arrays. In **Stage 4 (eBay 90-Day Sold Comp Scraping & Fitment Expansion)** , the worker queries the eBay Marketplace Insights / Browse API by exact OEM part number to calculate the 90-day 

median sold price (P_{\text{ebay\_median}}), 25th percentile (P_{25}), 75th percentile (P_{75}), and active competitor count, while retrieving the eBay Product ID (ePID) compatibility matrix via the Catalog API. Finally, in **Stage 5 (Algorithmic Dual-Pricing Engine)** , the worker calculates both the domestic CAD retail price and the Trinidad Bonded Vault TTD floor price: \text{Price}_{\text{CAD\_Retail}} = \text{round}\left( P_{\text{ebay\_median}} \times \gamma_{\text{ARA}} \right) 

where the ARA condition grade multiplier \gamma_{\text{ARA}} is defined as 1.05 for GRADE_A, 1.00 for GRADE_B1 and GRADE_B2, 0.85 for GRADE_B3, and 0.70 for GRADE_C. For the Trinidad Bonded Vault, customs valuation is anchored on a conservative Wholesale FOB USD transfer value (V_{\text{FOB\_USD}}), while the minimum COD floor price in TTD (\text{Floor}_{\text{TTD}}) explicitly embeds allocated ocean freight, Trinidad customs duty (r_{\text{duty}}, typically 4\%\text{–}30\% across Heading 8407/8708), processing fees (r_{\text{proc}}), Value Added Tax (r_{\text{VAT}} applied to the compounded landed sum of \text{CIF} + \text{Duty} + \text{Fees}), local broker referral commission (r_{\text{comm}} = 10\%), and the **Parallel FX Haircut Reserve** (\text{FX}_{\text{shadow}} \approx 7.35\text{ TTD/USD} versus the official \text{FX}_{\text{official}} \approx 6.78\text{ TTD/USD}): 

\text{CIF}_{\text{USD}} = V_{\text{FOB\_USD}} + \left(\text{Weight}_{\text{kg}} \times C_{\text{freight\_per\_kg}}\right) + C_{\text{ins\_USD}} \text{LandedCost}_{\text{TTD}} = \text{CIF}_{\text{USD}} \times \text{FX}_{\text{official}} \times (1 + r_{\text{duty}} + r_{\text{proc}}) \times (1 + r_{\text{VAT}}) \text{Floor}_{\text{TTD}} = \frac{\left(\text{CostBasis}_{\text{CAD}} \times (1 + \text{TargetMargin}_{\text{export}}) \times \text{FX}_{\text{CAD\_to\_USD}} \times \text{FX}_{\text{shadow}}\right) + \text{TaxesAndDuty}_{\text{TTD}}}{1 - r_{\text{comm}}} If the multimodal LLM's OCR confidence score falls below 0.75 (for instance, when an OEM serial number is obscured by heavy rustproofing undercoating), the part remains in SHELVED_ONTARIO_CONTAINER and routes to a "Needs Human Review" queue for Taz or the CFO rather than publishing an unverified listing to eBay Motors. 

### **5.3 Module C: Multi-Channel Syndication & "Live Container" Wholesale Portal** 

Module C synchronizes inventory across North American retail channels and Caribbean/Middle East wholesale buyers while providing a mobile-first B2B catalog and reverse-sourcing demand engine. 

When publishing a part to eBay Motors via the RESTful Inventory API, the adapter executes a three-step sequence that avoids legacy Trading API lock-in (since listings created via the Inventory API cannot be revised via Trading API calls). First, it invokes PUT /sell/inventory/v1/inventory_item/{sku} (createOrReplaceInventoryItem) passing product.title, product.description, product.imageUrls, condition, and product.aspects formatted in strict compliance with eBay's JSON array specification (e.g., "aspects": { "Brand": ["Kia"], "Manufacturer Part Number": ["86511-S9000"] }) to prevent ITEM_SPECIFIC_MISSING or ASPECTS_ASSOCIATION_INVALID compliance rejections. Second, it invokes PUT /sell/inventory/v1/inventory_item/{sku}/product_compatibility (createOrReplaceProductCompatibility) to attach the full list of compatible motor vehicles (Year, Make, Model, Trim, Engine) to the SKU. Third, it creates and publishes the marketplace offer via POST /sell/inventory/v1/offer and POST /sell/inventory/v1/offer/{offerId}/publish. Whenever a part is subsequently scanned onto a Trinidad export pallet in Kemptville or reserved via WhatsApp, the adapter immediately executes POST 

/sell/inventory/v1/bulk_update_price_quantity to set availableQuantity = 0 (or invokes deleteProductCompatibility and withdraws the offer), eliminating double-selling within milliseconds. 

For Caribbean and Middle East buyers, the **Two-Tab "Live Container" B2B Storefront** presents a frictionless mobile web catalog. **Tab 1 ("In Stock — Port of Spain Vault")** displays all parts in SHELVED_TRINIDAD_VAULT with local TTD wholesale pricing, ARA condition grade badges, studio photos, and a one-tap **"Reserve for 24h Vault Pickup"** button. **Tab 2 ("Loading Now in Ontario")** displays parts currently in SHELVED_ONTARIO_CONTAINER or SCANNED_TO_EXPORT_PALLET alongside the upcoming container's departure countdown, enabling overseas mechanics and dealers to pre-reserve components before the vessel sails. This storefront is tightly coupled with the **Meta WhatsApp Business Cloud API Engine** , which dispatches all traffic through POST 

https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages authenticated via a non-expiring System User Access Token. The engine tracks every B2B contact's explicit opt-in record (source, timestamp, channel) and live 24-hour customer service window countdown, blocking any outbound API call lacking opt-in with a 422 validation guard. When reaching out proactively outside an active 24-hour window (such as announcing a newly loaded Ontario container or matching a wish-list item), the system dispatches Meta-approved template messages (Marketing or Utility categories) supporting rich media headers (JPG/PNG up to 5 MB or PDF manifests up to 100 MB). Once a Trinidadian mechanic replies or taps a Call-to-Action (CTA) button, an inbound webhook (verified via HMAC signature and deduplicated in Redis) opens a 24-hour interactive session window. Within this window, the bot responds dynamically using native WhatsApp interactive list messages (up to 10 sections of matching Kia, Hyundai, Mazda, or Yamaha parts) and quick-reply buttons (up to 3 tap-to-answer buttons: [Reserve 24h], [Request HD Photos], [Add to Wish List]). Any item submitted to the **Mechanic "Wish List" Reverse-Sourcing Engine** persists a PreOrderWishList record that automatically joins against decoded VINs inside Module F's Pre-Auction Deal Analyzer, alerting Taz in real time when an Ontario salvage auction vehicle contains pre-sold Caribbean demand. 

### **5.4 Module D: One-Click Freight Forwarder & Customs Manifest Engine** 

Module D automates the export compliance and freight documentation required by Canadian freight forwarders, the Canada Border Services Agency (CBSA), and the Trinidad and Tobago Customs and Excise Division (ASYCUDA World format) for both LCL pallets and 20ft/40ft FCL containers. 

During physical consolidation in Kemptville, workers scan a master pallet QR barcode (PLT-2026-001) and then scan each part's PRT-XXXXXX QR label as it is wrapped onto the pallet. The system aggregates net part weights (Part.weightKg), adds the tare weight of heat-treated ISPM-15 crating (22.0\text{ kg}), verifies that mechanical parts have been drained of fluids and A/C components capped, and transitions each part to SCANNED_TO_EXPORT_PALLET. 

With a single click on **"Generate Customs & Freight Package,"** the ERP produces four synchronized regulatory artifacts. First, it generates a **CBSA CERS Portal Bulk Upload File (.txt / .xml)** and enforces the statutory marine reporting countdown. Under the _Reporting of Exported Goods Regulations_ and CBSA Memorandum D20-1-1, all commercial goods valued at **CAN $2,000 or more** exported from Canada to any destination outside the United States must 

be reported electronically via the **Canadian Export Reporting System (CERS)** using the exporter's 15-character Business Number (BN15 with an active CARM RM export program identifier). Crucially, for **Marine (Vessel) exports** , the CERS export declaration must be submitted, validated, and accepted by the CBSA **not less than 48 hours before the goods are loaded onto the vessel** at the port of exit (Montreal or Halifax). Module D outputs the exact CERS .txt bulk-load file, tracks the 48-hour vessel cutoff deadline on the CFO dashboard, stores the resulting CBSA **Proof of Report (POR) number** required by the ocean carrier prior to loading, and archives the complete digital export dossier in Canada for the mandatory **6-year statutory retention period** . 

Second, Module D generates the Trinidad ASYCUDA World Commercial Invoice & CARICOM Tariff Calculation Sheet (PDF/XML). Line items are automatically grouped by their 6-digit Harmonized System (HS) subheading under Heading 8708 (8708.10 Bumpers, 8708.21 Seat belts, 8708.22 Windshields/glass, 8708.29 Body panels and doors, 8708.30 Brakes, 8708.40 Gearboxes/transmissions, 8708.50 Drive-axles with differential, 8708.70 Road wheels, 8708.80 Suspension systems/shock absorbers, 8708.91 Radiators, 8708.92 Exhaust silencers/pipes, 8708.93 Clutches, 8708.94 Steering wheels/columns/boxes, 8708.95 Safety airbags with inflator system, and 8708.99 Other parts), Heading 8407/8408 for complete spark-ignition and compression-ignition engines, Heading 8703 for passenger vehicles, and Heading 8903 for recreational watercraft. Because automotive parts manufactured in South Korea, Japan, or Europe and stripped in Canada do not meet CARICOM regional origin criteria, they are subject to Trinidad's Common External Tariff (CET) ad valorem customs duty on the **CIF (Cost, Insurance, and Freight)** value, plus processing fees and Value Added Tax (VAT) levied on the total landed cost (\text{CIF} + \text{Duty} + \text{Fees}). Third, the engine outputs the **Detailed Packing List & Weight/Cube Manifest** itemizing pallet dimensions, cubic meters (CBM), net weight, and gross weight for the LCL consolidator or Ocean Bill of Lading (OBL). Fourth, for whole vehicles or watercraft, it compiles the **Cleanliness & Title Dossier** , binding the provincial ownership registration, lien clearance, and mandatory **wash and steam-cleaning receipts** proving all soil and agricultural contaminants were removed prior to containerization to prevent port quarantine or confiscation. 

### **5.5 Module E: The Trinidad "Bonded Vault" Cash Register & FX Ledger** 

Module E governs the Port of Spain commercial warehouse, enforcing the strict separation of sales and collection, tracking local broker commissions, preventing bank deposit concentration risk, and auditing foreign exchange repatriation into Canada. 

When an LCL pallet or FCL container clears customs in Port of Spain, the Family Vault Admin opens the digital Shipment Manifest on a warehouse tablet and scans each part's PRT-XXXXXX QR label onto a local rack bin (POSV-V01-R01-S02-B05). Any manifested SKU not scanned onto a vault shelf within 24 hours of container unstuffing triggers an immediate **Transit Shrinkage Alert** on the CFO dashboard. 

During daily commercial operations, local commissioned sales brokers bring Trinidadian mechanics, collision shop owners, and Yamaha marine dealers to the warehouse counter to inspect reserved components. The broker selects the customer's items and tags their brokerUserId on the counter terminal, creating a PENDING_VAULT_COD_PAYMENT transaction. By architectural design, neither the broker nor the Hunter (Taz) can mark the invoice paid or generate a gate release pass. Instead, the **Trinidad Family Vault Admin** must 

physically count the tendered TTD or USD cash (or confirm settled funds inside the family's Trinidadian commercial bank account), capture a mandatory verification photograph of the cash count or bank transfer receipt, and execute the **"Verify Full Payment & Issue Gate Pass"** action. This atomic transaction transitions each SKU to PAID_SETTLED_IN_VAULT, unlocks the broker's 5%–10% referral commission as PAYABLE, and generates a dynamic, single-use **Cryptographic Gate Release QR Token** . At the warehouse exit gate, scanning this token against the physical part's PRT-XXXXXX tag transitions the part to its terminal RELEASED_AT_VAULT_GATE state. 

To manage banking and foreign exchange risk in Trinidad and Tobago, Module E incorporates a **Commercial Bank Cap & FX Repatriation Batch Tracker** . Because deposit insurance through the Deposit Insurance Corporation in Trinidad and Tobago is capped at **TTD $200,000 per depositor, per institution** across the nation's eight licensed commercial banks, the dashboard monitors running TTD cash balances per bank and alerts the Family Admin to route deposits to a secondary commercial bank whenever a balance approaches TTD 180,000. Furthermore, because CBTT foreign exchange rationing creates multi-week bank queues at the official pegged rate (\approx 6.78\text{ TTD/USD}) and forces importers onto parallel markets (\ge 7.30+\text{ TTD/USD}), every conversion of TTD into CAD or USD—whether via commercial bank FX allocation queues, legitimate trade-offset arrangements, or authorized dealers—is logged as a `CurrencySettlement` 

batch[span_187](start_span)[span_187](end_span)[span_188](start_span)[span_188](end_spa n). The system computes the exact **Effective Clearing Rate**, **FX Slippage Loss (CAD)**, and **Repatriation Cycle Time** (days elapsed from COD collection to settled CAD wire arrival in Ontario), dynamically updating Module B's shadow FX reserve multiplier (\text{FX}_{\text{shadow}}$) so local TTD wholesale prices automatically adjust to protect Canadian net margins. 

### **5.6 Module F: The "Bad Cop" CFO Deal Analyzer & Unit Economics Dashboard** 

Module F operates as an objective programmatic gatekeeper over the $20,000 CAD bi-monthly working capital pool, preventing emotional auction overbidding and maintaining an institutional-grade financial ledger for a $2,000,000 CAD exit. 

Before Taz places a bid on any salvage car, luxury rebuild, or watercraft at auction, he enters the VIN/HIN, auction location, damage summary, and target operational lane (QUICK_TURN_BEATER, HIGH_END_REBUILD, or DISMANTLE_AND_EXPORT) into the **Pre-Auction "Bad Cop" Deal Analyzer** . The engine decodes the VIN via NHTSA vPIC, cross-references active Trinidad PreOrderWishList demand and 90-day eBay sold comps for the vehicle's top 15 assemblies, and computes the **Maximum Allowable Bid (B_{\text{max}})** : B_{\text{max}} = \text{ProjectedGrossRealization}_{\text{Lane}} - \left( \text{AuctionFees} + \text{TowCost} + \text{ShopLaborEst} + \text{PartsEst} + \text{InspectionFees} + \text{TargetMinProfit}_{\text{Lane}} \righ[span_15](start_span)[span_15](end_span)t) where \text{TargetMinProfit}_{\text{Lane}} is strictly enforced at **\ge \$1,500\text{ CAD}** for Quick-Turn Beaters, **\ge \$7,000\text{ CAD}** for High-End Salvage Rebuilds, and **\ge 100\%\text{ Net ROI}** (2.0\times total landed acquisition and dismantling cost) for Dismantle/Export units. Simultaneously, the analyzer checks the **14-Day Working Capital Buffer Gate** : 

\text{AvailableCapital}_{\text{14d}} = \$20,000 - \sum \text{UnrecoveredOutflows}_{\text{14d}} + 

##### \sum \text{RealizedNetInflows}_{\text{14d}} 

If the proposed acquisition and repair outlay exceeds \text{AvailableCapital}_{\text{14d}}, or if the Ramsayville shop lot already holds 8 vehicles, or if the Kemptville yard holds 4 uncrushed stripped shells, the deal is automatically locked in REJECTED_BY_CAPITAL_GATE unless the Architect/CFO executes an audit-logged override. 

For active inventory, the **Per-Vehicle P&L Waterfall Dashboard** tracks every dollar of cost basis (Auction Purchase Price + Buyer Fees + Towing + Ramsayville Shop Labor + "Prime Choice" Aftermarket Parts + MTO DriveON SIC/SSC Inspection Fees + Allocated Ocean Freight and Trinidad Customs Duty/VAT) against Realized Revenue (settled eBay orders + Ontario retail sales + settled Trinidad COD transactions converted at the realized FX batch rate) and Unrealized Container Stock (valued conservatively at 50\% of eBay P_{25} sold comps). To guarantee corporate audit readiness, the database and API layers enforce a strict **Zero-Receipt, Zero-Reimbursement Rule** : submitting any Expense mutation without a valid receiptImageUrl stored in Cloudflare R2 is rejected with HTTP 422 Unprocessable Entity, and a background AI Vision worker performs OCR on every uploaded receipt image to flag any discrepancy between the user-entered amount and the printed vendor total. 

## **6. Hardware, Physical Labeling & Container Layout SOPs** 

### **6.1 Harsh-Environment Thermal Printing & The -30°C Winter Physics Solution** 

Operating an outdoor and semi-enclosed dismantling yard in Kemptville, Ontario subjects physical barcode labels to extreme thermal and chemical stress: unheated steel shipping containers drop to **-30°C in January** and exceed **+45°C in July** , while drivetrain and suspension components are coated in petroleum grease, synthetic motor oil, brake fluid, and road salt. Standard direct-thermal paper labels (such as basic paper shipping labels) fail rapidly in this environment because heat, friction, UV exposure, and solvents turn the thermosensitive coating black, while standard rubber or general-purpose adhesives freeze and delaminate from cold metal. 

To guarantee multi-year scannability from Ontario winter storage through tropical ocean freight to Port of Spain, the platform standardizes on **Thermal Transfer (TT)** printing using a specialized synthetic media stack. For part and bin tagging, the operation specifies **Zebra 8000T Ultra High-Tack Matte** labels, constructed from a **61-micron matte white topcoated polyester facestock** paired with a heavy-coat-weight **104-micron permanent high-tack, high-shear acrylic adhesive** over a 79-micron glassine liner (244\text{ microns}\pm 10\% total thickness). This media is engineered specifically for capital asset and industrial machinery labeling on bare metal, painted metal, textured plastics, and surfaces exposed to oil, alcohol, dirt, and water. For overhead long-range rack headers inside dark containers, the operation pairs this with **Zebra 8000T Retroscan** retro-reflective polyester labels. Printing is executed exclusively with a **Zebra 5095 High-Performance Full Resin Ribbon** (or **Zebra 4800 Resin Ribbon** ), which fuses resin pigment into the topcoated polyester facestock to provide maximum resistance to chemicals, abrasion, and temperature extremes. 

#### **Solving the -30°C Service vs. +10°C Application Temperature Paradox (Critical** 

#### **SOP)** 

Engineering research into the Zebra 8000T Ultra High-Tack Matte specification reveals a critical physical constraint that must be solved by the Kemptville Yard Standard Operating Procedure (SOP): while the label media boasts a **Service Temperature Range of -40°C to +150°C** (-40°F to +302°F) following correct application and a 24-hour dwell time, its **Minimum Application Temperature is +10°C (+50°F)** . If a worker attempts to press an adhesive label directly onto a -25°C frozen alternator or greasy engine block outdoors in January, the acrylic adhesive polymer is below its glass-transition wetting temperature and will immediately pop off the metal surface. 

To resolve this thermal physics paradox, Node 1 (Kemptville) implements a **Two-Tier Winter Tagging Protocol** . First, the thermal transfer printer and rolls of Zebra 8000T labels are housed inside an insulated, thermostatically controlled **Heated Tagging Enclosure maintained at +18°C to +21°C (50% relative humidity)** inside the dismantling work bay. Second, during sub-zero winter months—or whenever tagging greasy mechanical assemblies (engines, transmissions, axles, knuckles) whose surfaces cannot be degreased and warmed above +10°C—workers never apply adhesive stickers directly to cold metal. Instead, inside the +18°C enclosure, the Zebra 8000T Ultra High-Tack label is pre-applied onto a room-temperature **10-mil tear-proof HDPE / Valeron reinforced grommet hang-tag** and allowed a 24-hour dwell time at +20°C so the acrylic adhesive achieves full shear strength and locks in its **-40°C to +150°C service rating** . When a part is stripped in the cold yard, the worker secures this pre-bonded synthetic hang-tag to the part using a **UV-stabilized, cold-weather Nylon 6/6 heavy-duty zip-tie rated to -40°C** , scans the QR code, and places the part directly into the unheated -30°C shipping container rack without any risk of adhesive delamination. 

### **6.2 Recommended Hardware Bill of Materials (BOM)** 

Table 4 specifies the exact industrial hardware stack selected for the Kemptville dismantling <u>yard, the Ramsayville shop, and the Port of Spain Bonded Vault.</u> 

|Hardware Category|Recommended Make &<br>Model|<br>Environment & Spec<br>Justification|Deployment Node|
|---|---|---|---|
|**Industrial Thermal**<br>**Transfer Printer**|**Zebra ZT411 (4-inch,**<br>**300 dpi)**or**Zebra**<br>**ZD621T**|All-metal frame<br>(ZT411), supports 300<br>dpi high-density QR<br>codes, full-resin ribbon<br>tensioning (Zebra<br>5095), ZPL II native<br>firmware.|Kemptville Heated<br>Tagging Bench (1x) &<br>Port of Spain Vault (1x)|
|**Part & Bin Label**<br>**Media**|**Zebra 8000T Ultra**<br>**High-Tack Matte**<br>(2^{\prime\prime} \times<br>1^{\prime\prime} and<br>4^{\prime\prime} \times<br>2^{\prime\prime}) +<br>**Zebra 5095 Resin**<br>**Ribbon**|<br>61-micron matte white<br>polyester + 104-micron<br>high-tack acrylic<br>adhesive; service<br>temperature**-40°C to**<br>**+150°C**; resists oil,<br>grease, water, and UV.|<br>Kemptville Yard & Port<br>of Spain Vault|
|**Overhead Rack**|**Zebra 8000T**|Retro-reflective|Kemptville Containers|



|Hardware Category|Recommended Make &<br>Model|<br>Environment & Spec<br>Justification|Deployment Node|
|---|---|---|---|
|**Header Media**|**Retroscan**<br>(4^{\prime\prime} \times<br>6^{\prime\prime})|<br>polyester engineered<br>for long-range barcode<br>scanning inside dark<br>shipping containers;<br>service temperature<br>down to -40°F/-40°C.|C01–C04 & Trinidad<br>Vault Racks|
|**Ruggedized Yard**<br>**Mobile Computer /**<br>**PWA Device**|**Zebra TC58e / TC27**or<br>**Samsung Galaxy**<br>**XCover6 Pro**(in<br>OtterBox Defender<br>case)|<br>IP68 water/dust/grease<br>sealed, MIL-STD-810H<br>drop-rated to concrete,<br>capacitive touchscreen<br>engineered for**wet and**<br>**gloved finger**<br>**operation**down to<br>-20°C/-30°C.|<br> <br>Kemptville Stripper<br>(2x), Hunter/Taz (1x),<br>Trinidad Vault Admin<br>(2x)|
|**Companion Bluetooth**<br>**2D Imager (Optional)**|<br>**Zebra DS3678-ER**<br>**(Ultra-Rugged**<br>**Extended Range)**|IP67 sealed, survives<br>2.4m drops to concrete<br>at -30°C, reads<br>dirty/scratched 2D QR<br>codes from 7 cm to 21<br>m with physical trigger<br>programmable for thick<br>winter mittens.|Kemptville Container<br>Pick/Pack & Pallet<br>Loading|



### **6.3 Container Barrier Layout, Physical QR Taxonomy & ZPL II Specification** 

At Node 1 (Kemptville), the **four 40-foot high-cube shipping containers (C01 through C04)** are arranged in a perimeter **L-shaped / U-shaped visual and acoustic barrier** that completely shields the central concrete/gravel fluid-drain and vehicle dismantling pad (capped at 4 active vehicle shells) from municipal roadways and neighboring sightlines. This physical geometry directly satisfies rural "clean yard" bylaw requirements while providing 1,280 square feet of weatherproof, lockable high-density storage. Internally, each container is outfitted with heavy-duty steel pallet and cantilever racking: Containers C01 and C02 house five-shelf steel bin racks for small-to-medium mechanical, electrical, and cooling components (alternators, ECUs, radar sensors, headlights, turbochargers); Container C03 is configured with padded vertical dividers and cantilever arms for sheet metal body panels, doors, hoods, and bumpers; and Container C04 is reinforced for palletized complete engines, transmissions, watercraft jet pumps, and outbound LCL pallet staging. 

Every physical storage bin across Kemptville, Ramsayville, and Port of Spain is indexed by a deterministic, 5-level hierarchical QR coordinate barcode formatted as [SITE (4 chars)]-[CONTAINER/ZONE (3 chars)]-[RACK (3 chars)]-[SHELF (3 chars)]-[BIN (3 chars)]. For example, KEMP-C01-R03-S02-B05 uniquely identifies Kemptville Yard, Container 1, Rack 3, Shelf 2, Bin 5; KEMP-C03-R01-S01-B01 identifies Kemptville Container 3, Rack 1, Shelf 1, Bin 1 (Body Panel Cantilever Bay); and POSV-V01-R04-S03-B12 identifies Port of Spain Bonded Vault, Warehouse Zone 1, Rack 4, Shelf 3, Bin 12. 

When printing 4^{\prime\prime} \times 2^{\prime\prime} part labels on the Zebra ZT411/ZD621T 

at 300 dpi, the ERP dispatches the following native **ZPL II** payload featuring both a high-error-correction (H-level, 30% redundancy) QR code and a redundant Code 128 linear barcode so partially grease-smudged labels still scan on the first pass: `^XA ^CI28 ^PW1200 ^LL600 ^LH0,0 ^FO40,40^BQN,2,10,H,7^FDHA,PRT-884920^FS ^FO340,45^A0N,55,55^FDPRT-884920^FS ^FO340,115^A0N,38,38^FD2022 KIA SPORTAGE 2.5L^FS ^FO340,165^A0N,34,34^FDOEM: 86511-DW000^FS ^FO340,215^GB820,4,4^FS ^FO340,235^A0N,42,42^FDARA GRADE: A (000)^FS ^FO340,290^A0N,38,38^FDBIN: KEMP-C01-R03-S02-B05^FS ^FO340,345^A0N,32,32^FDDONOR VIN: KNDP6CAC7N7012345^FS ^FO40,420^BY3,2,110^BCN,110,Y,N,N^FDPRT-884920^FS ^XZ` 

## **7. Non-Functional Requirements & Risk Mitigation** 

### **7.1 Offline Resilience & Conflict Resolution** 

To ensure uninterrupted operation in Kemptville's rural cellular dead zones, the Yard Intake PWA requests persistent storage permissions (navigator.storage.persist()) at login so mobile operating system memory pressure never evicts queued IndexedDB photographs or scan mutations. Conflict resolution is bifurcated by domain criticality: physical bin location updates (PartShelvedInBinEvent, PartScannedToPalletEvent) resolve via **Last-Write-Wins (LWW)** ordered by a hybrid logical clock (monotonic sequence counter plus device timestamp), whereas financial and marketplace availability state transitions (RESERVED_B2B_HOLD, SOLD_DOMESTIC_PENDING_SHIP, PAID_SETTLED_IN_VAULT) enforce **Strict Server-Authoritative Optimistic Concurrency** against Part.version. If an offline yard worker scans a part onto an outbound Trinidad pallet three minutes after that exact SKU sold on eBay Motors, the server sync endpoint rejects the pallet mutation for that SKU and pushes a high-priority "Pull Part From Pallet — Sold on eBay" alert to the worker's device the instant connectivity is restored. 

### **7.2 Image Compression & Zero-Egress CDN Architecture** 

Each stripped component generates three raw photographs and three background-removed studio images (six media objects per part). Across 5,000+ stripped parts per year alongside mandatory 6-photo DriveON salvage rebuild dossiers and expense receipts, media storage scales cost-effectively on **Cloudflare R2** , which eliminates S3 egress bandwidth charges when serving high-resolution images to eBay Motors, Car-Part.com, and WhatsApp B2B catalogs. Client-side OffscreenCanvas WebP encoding caps the three-photo intake upload payload at \le 600\text{ KB} per part, enabling background synchronization over weak rural 3G/LTE 

connections (1\text{ Mbps} uplink) to complete in under 5 seconds per part. 

### **7.3 Cryptographic Idempotency on Webhooks & Barcode Scans** 

All hardware barcode scans, offline PWA sync batches, eBay webhook notifications, and Meta WhatsApp Cloud API inbound webhooks enforce strict idempotency. Every mutation carries a deterministic Idempotency-Key (client UUIDv7 for scans, Meta messages[0].id for WhatsApp events, or eBay notificationId) cached in Redis with a 7-day Time-to-Live (TTL) and backed by PostgreSQL unique constraints. Consequently, a worker double-tapping a physical scanner trigger with thick winter gloves or Meta replaying an inbound webhook after a network blip never creates duplicate inventory records or double-books a customer reservation. 

### **7.4 Anti-Shrinkage Security & Immutable Audit Logging** 

To protect enterprise valuation during M&A due diligence and prevent internal shrinkage, a PostgreSQL database trigger (prevent_update_delete_on_audit_tables) strictly blocks DELETE statements on AuditLog, VaultTransaction, CurrencySettlement, and Expense, while restricting financial adjustments to append-only compensating journal entries signed by ARCHITECT_CFO. In Port of Spain, the warehouse exit gate is linked to a motion- and webhook-triggered IP camera that captures a timestamped still frame whenever a GateReleasePass QR code is scanned. Furthermore, the system generates mandatory weekly **Blind Cycle-Count Tasks** on the Trinidad Family Admin's tablet, randomly selecting 15 SHELVED_TRINIDAD_VAULT SKUs that require a live physical QR barcode scan alongside a live camera frame to verify that zero inventory has left the building via unauthorized "favour" releases. 

### **7.5 Regulatory Stealth, OMVIC & Municipal Bylaw Protection** 

To insulate the Kemptville rural property from municipal bylaw complaints and unplanned foot traffic, the Cloudflare Worker upload pipeline automatically strips all EXIF metadata—specifically GPSLatitude, GPSLongitude, camera serial numbers, and timestamps—from every uploaded photograph before writing to Cloudflare R2. Furthermore, all domestic retail vehicle advertisements (Quick-Turn Beaters and High-End Salvage Rebuilds) are geocoded and addressed exclusively to the commercial Ramsayville (Ottawa) partner shop lot, never exposing the Kemptville yard address. All Ontario retail vehicle transactions enforce full documentary compliance with Ontario Motor Vehicle Industry Council (OMVIC) disclosure standards and MTO DriveON regulations by binding the Used Vehicle Information Package (UVIP), signed Bill of Sale, DriveON Safety Standards Certificate (SSC), and DriveON Structural Inspection Certificate (SIC) directly to the vehicle's digital closing file. 

## **8. Phased Implementation Roadmap (Weekend MVP to Month 12)** 

### **8.1 Phase 1: Weekend MVP to Day 30 — The Trinidad LCL Proof-of-Concept** 

Phase 1 focuses on immediate operational execution: manifesting, shipping, and clearing the initial proof-of-concept Less-than-Container-Load (LCL) shipment to Port of Spain—comprising **one Yamaha Jet Boat/Watercraft, one Yamaha VR watercraft, one Automotive A/C Recharge Machine, and one consolidated LCL pallet of 2021–2022 Kia, Hyundai, and Mazda SUV hot parts** —and executing the first Cash-on-Delivery (COD) checkout inside the Trinidad Family Vault. During Days 1 to 30, the engineering build provisions the Next.js 15 App Router monorepo, the Supabase PostgreSQL schema (Vehicle, Part, StorageLocation, Shipment, ShipmentPallet, VaultTransaction), RBAC authentication middleware, and the Cloudflare R2 media bucket. The team prints the first batch of 500 PRT-XXXXXX and PLT-XXXXXX Zebra 8000T polyester labels, binds the Yamaha watercraft, A/C machine, and Kia/Hyundai/Mazda pallet parts via the mobile scanner view, and deploys the MVP **One-Click Customs & Manifest Generator** to produce the ASYCUDA World Commercial Invoice (with HS codes 8708.xx, 8407.xx, 8903.99, and 8479.89), Packing List, and CBSA CERS export data sheet at least 48 hours prior to vessel loading. Simultaneously, the **Trinidad Bonded Vault POS & COD Gate Lock** interface goes live for the Family Admin in Port of Spain to check in the landed shipment, verify TTD/USD COD payments, log 5%–10% broker commissions, and issue cryptographic Gate Release Passes. 

### **8.2 Phase 2: Days 30 to 60 — Kemptville Yard Automation, AI Enrichment & CFO Ledger** 

Phase 2 scales the rural Ontario dismantling operation by outfitting Kemptville Containers C01 and C02 with internal steel racking and QR bin placards, deploying the **Offline-First Yard Stripper PWA** (with Workbox Service Workers, IndexedDB outbox queuing, and the +18°C Heated Tagging Bench SOP) to local yard labor, and activating the asynchronous **BullMQ + Redis AI Vision Pipeline** . This pipeline chains automated background removal, NHTSA vPIC VIN decoding (DecodeVinValuesExtended), and Multimodal LLM OCR (GPT-4o / Claude 3.5 Sonnet) to extract stamped OEM part numbers, assign deterministic ARA Condition Grades (A/B/C) and 3-character Damage Codes, and calculate dual CAD/TTD pricing. Phase 2 also activates **Module F ("Bad Cop" CFO Deal Analyzer & Expense Ledger)** , enforcing the $20,000 CAD bi-monthly capital gate, mandatory receipt photo uploads, the Ramsayville 8-car lot cap, the Kemptville 4-shell scrap ticket bylaw lock, and MTO DriveON 36-day SSC and 6-photo SIC compliance tracking. 

### **8.3 Phase 3: Months 3 to 6 — Two-Way eBay API Sync, WhatsApp Broadcasts & 4-Container Scale** 

Phase 3 expands Kemptville storage across all four 40-foot shipping containers (C01–C04), automates domestic eBay Motors cash recovery, and launches the live Caribbean B2B Storefront and WhatsApp automation engine. Engineering deliverables include full integration with the **eBay Inventory API** (createOrReplaceInventoryItem, 

createOrReplaceProductCompatibility, publishOffer, and 90-day sold comp lookups) paired with atomic bulkUpdatePriceQuantity = 0 inventory locking the instant a part is scanned onto an export pallet. Concurrently, the **Meta WhatsApp Business Cloud API Integration** (POST /{PHONE_NUMBER_ID}/messages) launches with opt-in tracking, 24-hour service window timers, pre-approved Marketing/Utility templates, and interactive list messages, connected to the **Two-Tab Trinidad Storefront** ("On the Shelf in Trinidad" versus "Loading in Ontario"), the 

**Mechanic Wish-List Reverse-Sourcing Engine** , and the **Trinidad FX Settlement & Commercial Bank Cap Tracker** (monitoring the TTD $200,000 deposit protection cap and real-time parallel-market FX spreads). 

### **8.4 Phase 4: Months 6 to 12 — Car-Part.com EDI, Middle East Expansion & $2M Exit Data Room** 

Phase 4 scales wholesale container exports to Barbados and Middle East B2B buyers, syndicates inventory to North American collision repair shops via a **Car-Part.com / Hollander Interchange EDI Bridge** , and automates the institutional financial reporting package required for a **$2,000,000 CAD valuation exit** . Module D's tariff and tax engine is parameterized to support Barbados ASYCUDA World entries and Gulf Cooperation Council (GCC 5% customs duty / 5% VAT) container lanes alongside Port of Spain. Finally, the **Automated M&A Exit Data Room Generator** compiles GAAP/ASPE-reconciled monthly income statements, balance sheets, aged inventory velocity metrics (verifying Strip-to-Shelf <30\text{s} and Container Retrieval <5\text{m}), VIN-by-VIN unit economics audit trails, and 6-year CBSA export compliance archives into a single diligence-ready export package. 

## **9. Cross-Border Regulatory Reference & Exit Valuation Synthesis** 

### **9.1 Comprehensive HS Tariff & Customs Valuation Reference Matrix** 

To guarantee zero customs holds or retroactive penalties during CBSA CERS export filing and Trinidad and Tobago Customs and Excise Division (ASYCUDA World) import clearance, Module D pre-populates the Harmonized System (HS) classifications, statutory reporting windows, <u>valuation formulas, and environmental preparation requirements detailed in Table 5.</u> 

|Asset /<br>Component<br>Category|HS Tariff Heading /<br>Subheading|<br>CBSA CERS<br>Export<br>Requirement<br>(Canada<br>Outbound)|Trinidad & Tobago<br>ASYCUDA World<br>Import Valuation<br>Basis|<br>Mandatory<br>Environmental &<br>Prep Compliance|
|---|---|---|---|---|
|**Complete**<br>**Passenger**<br>**Vehicles & SUVs**|**8703.21 – 8703.90**<br>(by engine<br>displacement &<br>propulsion)|Mandatory CERS<br>declaration \ge<br>48\text{h} prior to<br>vessel loading if<br>value \ge<br>\$2,000\text{<br>CAD}; original<br>provincial title &<br>lien clearance.|\text{CIF Value} =<br>\text{FOB} +<br>\text{Freight} +<br>\text{Insurance};<br>subject to Motor<br>Vehicle Import<br>Duty, Motor<br>Vehicle Tax, and<br>compounded VAT<br>on landed total.|Wash and**steam**<br>**clean**to remove<br>all soil/pests<br>(retain receipt);<br>empty all loose<br>personal items.|
|**Complete Spark /**<br>**Compression**<br>**Engines**|<br>**8407.34**(Gasoline<br>>1000\text{cc}) /<br>**8408.20**(Diesel)|<br>CERS commodity<br>line item with<br>engine serial<br>number and donor|<br>Ad valorem<br>customs duty on<br>CIF value +<br>processingfee +|**Completely drain**<br>**all motor oil and**<br>**coolant**prior to<br>crating;sealports.|



|Asset /<br>Component<br>Category|HS Tariff Heading /<br>Subheading|<br>CBSA CERS<br>Export<br>Requirement<br>(Canada<br>Outbound)|Trinidad & Tobago<br>ASYCUDA World<br>Import Valuation<br>Basis|<br>Mandatory<br>Environmental &<br>Prep Compliance|
|---|---|---|---|---|
|||VIN<br>cross-reference.|compounded VAT.||
|**Bumpers, Doors,**<br>**Hoods & Body**<br>**Panels**|<br>**8708.10**<br>(Bumpers)<br>**8708.29**(Body<br>panels/doors)|Grouped by 8-digit<br>Canadian Export<br>Classification code<br>in CERS bulk .txt<br>upload.|<br> <br>Classified under<br>Heading 8708 by<br>assembly type (not<br>vehicle make);<br>duty assessed on<br>CIF value.|<br>Clean surfaces;<br>apply ARA 3-digit<br>damage code<br>(000, 5P1) and<br>wrap sharp edges.|
|**Transmissions,**<br>**Axles, Brakes &**<br>**Suspension**|**8708.40**<br>(Gearboxes)<br>**8708.50**<br>(Drive-axles)<br>**8708.30**(Brakes)<br>**8708.80**<br>(Suspension)|Reported by net<br>weight (\text{kg})<br>and FOB CAD<br>value in CERS.|Assessed under<br>respective 8708.xx<br>subheading on CIF<br>basis.|<br> <br>**Drain all**<br>**transmission/gea**<br>**r oil and brake**<br>**fluid**; cap<br>hydraulic lines.|
|**Road Wheels,**<br>**Steering,**<br>**Radiators &**<br>**Airbags**|**8708.70**(Wheels)<br>**8708.94**(Steering)<br>**8708.91**<br>(Radiators)<br>**8708.95**(Airbags)|<br>Note: 8708.95<br>(Airbags) requires<br>Class 9<br>Dangerous Goods<br>(UN3268)<br>declaration if<br>shipped via ocean<br>freight.|<br> <br>Standard<br>8[span_239](start_<br>span)[span_239](e<br>nd_span)708.xx<br>CIF duty + VAT;<br>cracked/distorted<br>wheels must be<br>scrapped in<br>Ontario and never<br>exported.|<br>**Cap and seal all**<br>**A/C condensers**<br>**and lines**at time<br>of<br>evacuation/disman<br>tling.|
|**Recreational**<br>**Watercraft**<br>**(Sea-Doo /**<br>**Yamaha)**<br>**9.2 Architectu**<br>**Valuation**|**8903.99**(Personal<br>watercraft / Jet<br>boats) &**8407.21**/<br>**8407.29**(Marine<br>engines)<br>**ral Synthesis:**|<br> <br>Reported as<br>conveyance/vesse<br>in CERS \ge<br>48\text{h} prior to<br>vessel loading with<br>12-char HIN.<br>**Defending the**|l<br> <br>CIF valuation +<br>Caribbean<br>luxury/marine tariff<br>+ VAT.<br>**$2,000,000 C**|<br>Steam clean<br>hull/bilge; drain<br>fuel tank and oil<br>reservoirs.<br>**AD Exit**|



When a private equity roll-up or strategic automotive recycling group evaluates this enterprise at Month 24 to 36, the custom ERP directly converts operational discipline into valuation multiple expansion across three dimensions. First, the platform establishes **verifiable unit-level margin integrity** : every dollar of the $400,000 to $500,000+ CAD annual Seller's Discretionary Earnings is traceable from the initial Copart or IAAI auction invoice, through receipt-verified Ramsayville repair costs and MTO DriveON Structural and Safety Standards Certificates, to the exact eBay order ID or Port of Spain Vault COD receipt and Canadian bank FX settlement wire. Second, the architecture proves **turnkey labor scalability** : by reducing Kemptville yard intake to an 

offline-first, three-tap camera and QR scan workflow backed by automated AI Vision OCR and deterministic ARA condition grading, the operation demonstrates that it does not rely on the founder's personal presence to strip, grade, and price 100+ salvage vehicles and watercraft annually. Third, the system enforces **institutionalized cross-border risk controls** : combining millisecond eBay-to-container inventory locking, automated CBSA CERS 48-hour marine export compliance, strict separation of sales and collection in the Trinidad Bonded Vault, and algorithmic parallel-market FX reserve pricing transforms an informal international arbitrage hustle into a repeatable, defensible, and auditable cross-border supply chain enterprise. 

#### **Works cited** 

1. ebay.inventory(v1.5.1) - Ballerina Central, 

https://central.ballerina.io/ballerinax/ebay.inventory/latest 2. Exporters' guide to reporting, https://www.cbsa-asfc.gc.ca/services/export/guide-eng.html 3. The Foreign Exchange Challenges in Trinidad and Tobago and the, https://eurochamtt.org/the-foreign-exchange-challenges-in-trinidad-and-tobago-and-the-impacton-foreign-investors-summary/ 4. Trinidad and Tobago - Banking - Expat Focus, https://www.expatfocus.com/trinidad-and-tobago/guide/trinidad-and-tobago-banking 5. Why Trinidad and Tobago Must Rethink Its Foreign Exchange Regime., 

https://www.thevaluecritic.com/post/breaking-the-impossible-trinity-why-trinidad-and-tobago-mus t-rethink-its-foreign-exchange-regime 6. Vehicle API - NHTSA vPIC - Department of Transportation, https://vpic.nhtsa.dot.gov/api/ 7. Safety standards certificate | ontario.ca, https://www.ontario.ca/page/safety-standards-certificate 8. Mandatory Vehicle Branding Program | ontario.ca, https://www.ontario.ca/page/mandatory-vehicle-branding-program 9. Exporting Vehicles from Canada: Your Complete 2026 Guide, 

https://www.freightamigo.com/en/blog/logistics/exporting-vehicles-from-canada-your-complete-2 026-guide/ 10. Canadian Export Reporting System (CERS) User Guide, https://www.cbsa-asfc.gc.ca/services/export/cers-guide-scde-eng.html 11. Structural Safety Inspection in Thornhill - ZhoopZhoop, 

https://zhoopzhoopauto.com/structural-safety-inspection-thornhill/ 12. Getting it Straight - Automotive Retailers Association, 

https://www.ara.bc.ca/wp-content/uploads/2021/02/ICBC-Standards-of-Performance-for-Recycle d-Parts.pdf 13. WhatsApp Business API for Teams & Brands | SabNode, https://sabnode.com/features/whatsapp-business-api 14. WhatsApp Cloud API: Direct Integration with Meta - DevOps School, 

https://www.devopsschool.com/blog/whatsapp-cloud-api-direct-integration-with-meta/ 15. ARA Grade A, B, C Explained - Radar Parts, https://radarparts.com/resources/ara-condition-grades 16. Used Car Parts Grades Explained – What Do A, B and C Mean?, https://www.autoparts-24.com/car-breakers/grades/ 17. parts-standards - Charlton Recycled Autoparts Ltd, https://www.charltonautoparts.co.uk/Parts-Standards 18. Content Modules - Parts Hotlines, https://www.partshotlines.com/about-us/our-partners/64-sample-data-articles/joomla/extensions/ modules/articles-modules.html 19. Understanding Used Part Grading - All American Auto Salvage, https://allamericanautosalvage.com/understanding-used-part-grading/ 20. WhatsApp Business Cloud API: A Simplified Guide in 2026 - Zixflow, 

https://zixflow.com/blog/send-message-through-whatsapp-api/ 21. (DriveON) Safety - Fort Erie Pit Stop, https://www.forteriepitstop.ca/services/driveon-safety 22. Car Insurance for a Rebuilt or Salvage Title Vehicle, 

https://www.mybrokers.ca/blogs/how-does-car-insurance-work-for-a-rebuilt-or-salvage-title-vehic le 23. NHTSA API - PublicAPI, https://publicapi.dev/nhtsa-api 24. HS Codes for Automotive Cargo: Cars, Trucks, EVs & Parts - Logisoft, 

https://www.logisoft.io/blog/what-are-hs-codes-for-automotive-cargo-a-guide-to-import-and-expo rt 25. Using Compliance API reason codes to revise listings, 

https://developer.ebay.com/api-docs/sell/static/inventory/pbse-compliance-reason-codes.html 26. Api (Grade A) - Claude Skill - Skills Directory, https://www.skillsdirectory.com/skills/lap-platform-api-8521cc8a 27. Thailand's Top Car Exporter to Peru, the Trinidad and Tobago and, 

https://www.jimsoni.com/thailand-top-car-exporter-to-peru.html 28. Customs Duty List | PDF - Scribd, https://www.scribd.com/document/987920523/Customs-Duty-List 29. Import Regulations | japan4wd.com, https://www.japan4wd.com/import 30. 8 Excises in: Tax Law Design and Drafting, Volume 1 - IMF eLibrary, 

https://www.elibrary.imf.org/display/book/9781557755872/CH008.xml 31. Associating catalog products to special listings, 

https://developer.ebay.com/api-docs/sell/static/inventory/pbse-special-listings.html 32. Release Notes - eBay Developers Program, 

https://developer.ebay.com/api-docs/sell/finances/release-notes.html 33. WhatsApp integration | Documentation, https://docs.weweb.io/integrations/whatsapp.html 34. WhatsApp Business Cloud API Console - PANTHM AI Labs, https://panthm.com/solutions/blockchain 35. WhatsApp Business Cloud API Setup - hermes-agent - GitHub, 

https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/ whatsapp-cloud.md 36. Technical guide for the Canadian Export Reporting System (CERS, https://www.cbsa-asfc.gc.ca/prog/cers-scde/ch25/eccrdcers-deccescde-04-eng.html 37. Memorandum D20-1-1: Exporter Reporting, 

https://www.cbsa-asfc.gc.ca/publications/dm-md/d20/d20-1-1-eng.html 38. Exporting Vehicles from Canada: Step-by-Step Guide, 

https://nabrokers.ca/exporting-vehicles-from-canada-a-step-by-step-guide/ 39. 8000T Ultra High-Tack Matte - Zebra Technologies, 

https://www.zebra.com/content/dam/zebra_dam/en_gb/spec-sheets/8000t-ultra-high-tack-mattespec-sheet-en-gb.pdf 40. Zebra 8000T Retroscan for Long-Range Scanning PaladinID, LLC, https://paladinid.com/enhance-your-labeling-with-the-zebra-8000t-retroscan-the-ideal-solution-fo r-long-range-scanning/ 41. Products.Car-Part.com - Tools for Recyclers, https://products.car-part.com/newsletters/scoop/cps20080319.html 

