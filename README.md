# Unified Multi-Tenant Operations & Compliance ERP

A **Domain-Driven Design (DDD) Multi-Tenant Modular Monolith** built on Next.js 15, React 19, TypeScript 5, PostgreSQL 16 (Supabase multi-schema + RLS), Prisma ORM (`multiSchema`), BullMQ, and Cloudflare R2.

The platform is a **reusable multi-tenant operations and compliance ERP** serving **two independent legal corporations operating at separate physical facilities**. The businesses share **reusable software infrastructure only** (`shared` PostgreSQL schema and `src/modules/shared-ops`: `8.5" × 11"` 10-MIL synthetic laser QR hang-tag sheet & optional ZPL generation, mobile camera barcode scanning, generic hierarchical `StorageLocation` custody, receipt/voucher-gated `Expense` & cash-custody abstractions, and tenant-segregated Cloudflare R2 storage adapters)—with **no shared physical warehouse, combined inventory, shared bank accounts or cash floats, shared operating permits, or assumed common shareholders, directors, or employees** ([`ADR-0004`](./docs/adr/0004-independent-legal-entities-and-physical-site-separation.md)):

1. **Business A — Automotive & Marine Salvage (`ORG_SALVAGE_EXPORT` — `salvage` DB schema, Independent Legal Entity `"Ontario Salvage OpCo Inc."`):**
   * **Kemptville Primary Salvage Operating Location (`KEMP` — `ZONE_CONTAINER_PAD`):** Primary Phase 1A physical operating facility in Kemptville, Ontario (`KEMP_ZONE_CONTAINER_PAD` seeded with `maxActiveAssetCapacity = 4` and `allowsWholeVehicleDismantling = false`; under `complianceEnforcementMode = "WARN_ONLY"`, whole-vehicle intake or undrained powertrain parts at `KEMP` succeed and append `COMPLIANCE_WARNING_UNDRAINED_FARM` unless `fluidsDrainedAt != null`) for vehicle & watercraft acquisition, dismantling, container parts warehousing (`C01`–`C04`), Ontario HTA Section 60 Statutory Garage & Wrecking Register, **5-Stream Commodity Scrap Separation (`ScrapComponentLog` — `$550–$900 CAD` floor)**, 3-tap `10-MIL` synthetic laser QR hang-tag bin shelving (`PRT-XXXXXX` $\rightarrow$ `SHELVED_ORIGIN_CONTAINER`), **Zero-Typing Domestic Syndication (`FR-MKT-00`)** (eBay Seller Hub Bulk CSVs for `< 15.0 kg` parts across North America including 100% of `LHD_ONLY` parts, **Day-1 Ottawa/Gatineau B2B Mechanic Powertrain & Front-Clip Sheets** with zero Solera Hollander dependency, and EXIF-stripped local Ottawa classified payloads with `"Ottawa South / Hwy 416 Corridor"` `RULE-MKT-002` pickup-label stealth), and **Ontario Domestic CAD Checkout (`FR-CHK-01` / `DOMESTIC_ORIGIN`)** with **13% Ontario HST Trust Ring-Fencing (`RULE-TAX-HST-01`, `isOntarioHstRegistered = true`, `isOmvicLicensed = false`)**, atomic anti-double-sale delist sync, independent `ORG_SALVAGE_EXPORT` Operator Float (`HELD_IN_OPERATOR_FLOAT`) subledger, `ITA s. 78(1)` deferred lease accruals, and **3-Tranche `$44,000 CAD` Senior Secured Loan (`$22k / $12k / $10k`)** with **1-Tap `cfoOverride`** on all capital/deal gates.
   * **Ramsayville Retail, Shop & Fulfillment Concept (`RAMS` — `ZONE_RAMSAYVILLE_SHOP`, Salvage-Only, Subject to Operational Confirmation):** Salvage-exclusive commercial shop, DriveON 10-day re-inspection & deposit-triggered 36-day SSC retail beater flip (`RETAIL_LOT_VEHICLE_SALE`), and concrete bay/lot concept belonging **exclusively to `ORG_SALVAGE_EXPORT`**. Seeded (`maxActiveAssetCapacity = 8`, `allowsWholeVehicleDismantling = true`) for concrete bay/lot routing tests while preserving the architectural distinction without assuming Ramsayville is already an active operational facility prior to verification.
   * **Pre-Paid Direct Export (`RULE-EXP-001`) & Dormant Destination Bonded Vault (`POSV` — `DESTINATION_EXPORT_VAULT`):** Future/dormant salvage-export capability belonging exclusively to `ORG_SALVAGE_EXPORT`. Zero-consignment outbound export pallet/container manifesting (`FR-LOG-01`/`02`) is gated on 100% upfront CAD/USD settlement in `SETTLED_ORIGIN_CORP_BANK` (`exportFulfillmentMode = 'PREPAID_ORIGIN_ONLY'`), LHD-to-RHD destination fitment guards, and broker-ready Commercial Invoice & Packing List generation, while the Trinidad Bonded Vault COD subsystem (`POSV`) remains schema-ready and dormant behind `IPolicyConfigPort`.
2. **Business B — Cannabis Cultivation & Processing (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` DB schema, Independent Legal Entity `"Brockville Cannabis Operations Inc."`):**
   * **Brockville Cannabis Cultivation & Processing Facility (`BROCK` — `ZONE_BROCKVILLE_FACILITY`):** Exclusive physical operating location in Brockville, Ontario (`BROCK_SITE_FACILITY` and `BROCK-PROP-R1-T2` seeded minimally in Phase 1A strictly to test cross-tenant RLS denial and `422 SITE_ZONING_VIOLATION`, with functional cannabis workflows delivered in Phase 2B) for all planned licensed cannabis cultivation, genetics and propagation (3-tap mother plant QR scanning to spawn `LOT-YYYY-XXXX` clone tray batches), `10-MIL` synthetic laser QR hang-tag / tray-card printing (with optional ZPL support), and grow room/table custody tracking (`allowedOrgType = CANNABIS_NURSERY_AND_PROCESSING`), subject to the corporation's actual Health Canada licence and authorized activities. *(Kemptville is strictly a salvage site and is never a cannabis nursery, greenhouse, cultivation, or processing location.)*
   * **Lot/Batch Genealogy, Mass-Balance Processing ("Moving the Juice"), QA & Regulatory Reporting:** Wet-to-dry curing and biomass-to-extract (`CRUDE_EXTRACT`, `DISTILLATE_OR_ISOLATE`) transformations reconciled to the gram ($0.01\text{g}$), automatic QAP compliance holds when unaccounted variance exceeds $2.0\%$, Health Canada dual-witness destruction logs (`primaryUserId != witnessUserId`), private R2 Lab CoA attachments, and monthly Health Canada CTLS & CRA Form B300 reporting, subject to authorized licence scope.

---

## Multi-Schema PostgreSQL Isolation, Regulatory Firewall & SaaS Portability

The PostgreSQL database is partitioned into three schemas via Prisma `previewFeatures = ["multiSchema"]`—where `shared` is strictly a **technical multi-tenant table grouping** (not evidence of shared corporate finances, combined inventory, or shared facilities), and cross-tenant data access is prohibited by default across all three schemas:

* **`shared` schema (`@@schema("shared")`):** `Organization` (`id`, `slug`, `name`, `legalEntityName`, `organizationType`, `policyConfigJson`, `craBusinessNumberBn15`, `healthCanadaLicenseNumber`), `User` (authentication principal), `OrganizationMembership` (explicit per-organization authorization), `StorageLocation` (with data-driven `organizationId`, `allowedOrgType`, `allowsWholeVehicleDismantling`, and `maxActiveAssetCapacity`), `CustodyEvent` (with `complianceWarnings`), `Expense` (with `isDeferredIntercompanyAccrual`), `CashCustodyTransfer`, `OutboxEvent`, and `AuditLog`. Every operational record is scoped by `organizationId` and enforced by default-deny Supabase Row-Level Security (`organizationId = (auth.jwt() ->> 'organization_id')::uuid`).
* **`salvage` schema (`@@schema("salvage")`):** `Vehicle` (with HTA s. 60 register & DriveON 10-day/36-day timers), `Part`, `ScrapComponentLog` (5-stream commodity scrap ledger), `Shipment`, `ShipmentPallet`, `PreOrderWishList`, `B2BReservation`, `SaleTransaction` (with 13% HST ring-fencing), `SaleTransactionPartItem`, `SaleTransactionVehicleItem`, `CycleCountTask`, and `CurrencySettlement`—all owned independently by `ORG_SALVAGE_EXPORT` (`organizationId` + RLS).
* **`cannabis` schema (`@@schema("cannabis")`):** `CannabisStrain`, `CannabisLot`, `CannabisLotTransformation`, and `CannabisDestructionLog`—all owned independently by `ORG_CANNABIS_NURSERY_PROC` (`organizationId` + RLS).
* **Commercial Vertical-SaaS Portability (`IPolicyConfigPort`):** All market nodes (`DOMESTIC_ORIGIN`, `DESTINATION_EXPORT_VAULT`), sales channels (`LOCAL_WALK_IN_CASH`, `RETAIL_LOT_VEHICLE_SALE`, `DESTINATION_VAULT_COD`), cash custody states (`HELD_IN_OPERATOR_FLOAT`, `HELD_IN_DESTINATION_VAULT`, `SETTLED_ORIGIN_CORP_BANK`), and location zoning/capacity rules are data-driven and resolved per organization via `IPolicyConfigPort` (`src/core/config/pricing-policy.json` with optional `Organization.policyConfigJson` overrides).

> **Audit & Entity Isolation Guarantee:** `ORG_SALVAGE_EXPORT` (Kemptville) and `ORG_CANNABIS_NURSERY_PROC` (Brockville) share zero inventory, cash balances, R2 object prefixes, or physical facilities. A Health Canada CTLS inspector or CRA Excise auditor reviewing `ORG_CANNABIS_NURSERY_PROC` has **zero visibility** into `salvage` schema tables, export manifests, or Ontario automotive cash sales. Simultaneously, data-driven location isolation (`RULE-ZONE-001` via `StorageLocation.organizationId` and `StorageLocation.allowedOrgType`) hard-blocks scanning any `salvage` asset/part into a `cannabis` facility location or vice versa (`422 SITE_ZONING_VIOLATION`).

---

## Modular Directory Structure

```text
src/
├── core/
│   ├── domain/                    # Pure TypeScript domain calculators & 5-axis state guards
│   ├── ports/                     # Hexagonal Port Interfaces (IPolicyConfigPort, IStoragePort, ILabelTagPort, etc.)
│   ├── events/                    # Domain Event contracts & Outbox publisher
│   └── config/                    # Versioned regulatory, tariff, FX & mass-balance parameters
├── modules/
│   ├── shared-ops/                # 8.5"x11" synthetic laser QR tag sheets (+ ZPL), camera scanner,
│   │                              # hierarchical StorageLocation, receipt-gated Expense & float ledger, R2 adapters
│   ├── dismantling/               # Salvage Context 1: Asset intake, stripping, bin custody
│   ├── marketplace/               # Salvage Context 2: eBay sync, B2B storefront, WhatsApp
│   ├── logistics-vault/           # Salvage Context 3: Pallets, manifests, Trinidad COD Vault
│   ├── cannabis-compliance/       # Cannabis Context: Nursery batch tracking, mass-balance
│   │                              # transformations, 2-witness destruction, CTLS & CRA B300
│   └── cfo-subledger/             # Financial Context: Capital gate, expenses, FX, GL sync
├── infrastructure/
│   ├── db/                        # Prisma multi-schema client, migrations, RLS helpers
│   ├── adapters/                  # Concrete implementations of core/ports
│   └── workers/                   # BullMQ worker entrypoints
├── app/                           # Next.js App Router (Workspace Switcher, UI, Server Actions)
└── extensions/
    └── local-marketplace-lister/  # Manifest V3 Chrome Extension for 1-click FB Marketplace & Kijiji autofill
```

---

## Phased Delivery Roadmap (Canada-First Ontario Domestic & Pre-Paid Export Launch)

| Phase | Target Window | Active Schemas | Scope & Milestone |
| :--- | :--- | :--- | :--- |
| **Phase 1A** | Days 1–7 (Kemptville Salvage Launch MVP) | `shared` + `salvage` | Shared Core + Kemptville Salvage Intake & 3-Tap Part Stripping (`FR-INT-01`, `FR-INT-02`), Tiered Expense & Working Capital Gate (`FR-EXP-01`, `FR-EXP-02`), **Zero-Typing Domestic Syndication Bridge (`FR-MKT-00`)**, and **Ontario Domestic CAD Checkout with Anti-Double-Sale Delist Sync (`FR-CHK-01`)**. |
| **Phase 1B** | Days 8–21 (Ottawa Velocity & Pre-Paid Export) | `shared` + `salvage` | 1-Click FB Marketplace / Kijiji Manifest V3 Chrome Extension (`FR-MKT-02`), "Bad Cop" Auction Deal Analyzer (`FR-DEAL-01`), and **100% Pre-Paid Direct Export Manifesting & Broker Dossier (`FR-LOG-01`, `FR-LOG-02`, `RULE-EXP-001`)**. |
| **Phase 2A** | Days 22–45 (Automated eBay API & Offline PWA) | `shared` + `salvage` | **Pulled-forward Automated eBay Inventory API Listing & Webhook Delist Sync**, Offline-first IndexedDB Stripper PWA, and QuickBooks/Xero GL sync. |
| **Phase 2B** | Days 45–90 (Brockville Cannabis Facility Online) | `shared` + `cannabis` | Multi-Tenant Workspace Switcher (for explicitly multi-org users), Brockville (`BROCK`) 3-Tap Propagation/Mother Tracking (`FR-CAN-01`), Mass-Balance Extraction Ledger (`FR-CAN-02`), Dual-Witness Destruction (`FR-CAN-03`), and Health Canada CTLS / CRA B300 Export (`FR-CAN-04`) reusing `shared-ops` software components. |
| **Phase 3** | Months 3–6 (AI Vision & Dormant Overseas Bonded Vault) | `shared` + `salvage` + `cannabis` | Assistive AI Vision (`FR-AI-01`), **Dormant Overseas Bonded Vault Activation (`FR-VLT-01`–`FR-VLT-05`)**, Two-Step HMAC Gate Token exit scanning, and Live Container B2B Storefront (`FR-MKT-01`). |

---

## Authoritative Specification Documents

* **[`ARCHITECTURE.md`](./ARCHITECTURE.md):** System topology, Hexagonal Ports, multi-schema Prisma specification (`shared`, `salvage`, `cannabis`), mandatory PostgreSQL triggers/`CHECK` constraints/default-deny RLS policies across all three schemas, and 5-axis state machines.
* **[`PRD.md`](./PRD.md):** Functional requirements (`FR-*`), organization-scoped 7-role RBAC matrix, Organization Workspace Switcher rules, Phase 1 Ontario Domestic Operational Proof Gate, and Non-Functional Requirements (`NFR-*`).
* **[`DOMAIN-RULES.md`](./DOMAIN-RULES.md):** LHD vs. RHD part compatibility matrix, multi-channel routing (`RULE-MKT-001`), Kemptville bylaw geolocation stealth (`RULE-MKT-002`), 100% pre-paid origin export gate (`RULE-EXP-001`), HS tariff & customs valuation register, Trinidad landed cost & shadow FX formulas, 3-Rule Compensation Protocol (`RULE-PAY-001`–`003`), multi-tenant organization & facility location isolation (`RULE-ZONE-001`, `RULE-ENV-001`), and Brockville cannabis mass-balance & CTLS rules (`RULE-CAN-001`).
* **[`GLOSSARY.md`](./GLOSSARY.md):** Canonical ubiquitous language across Shared Software Infrastructure, Kemptville Salvage & Domestic Flips, Export & Dormant Destination Bonded Vault, Unit Economics & Cash Custody, and Brockville Cannabis Cultivation & Processing.
* **[`docs/adr/`](./docs/adr/):** Architectural Decision Records, including [`ADR-0004`](./docs/adr/0004-independent-legal-entities-and-physical-site-separation.md) establishing the two independent legal entities, Kemptville vs. Brockville physical-site separation, and shared-software-only boundary.
