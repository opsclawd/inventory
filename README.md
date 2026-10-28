# Unified Multi-Tenant Operations & Compliance ERP

A **Domain-Driven Design (DDD) Multi-Tenant Modular Monolith** built on Next.js 15, React 19, TypeScript 5, PostgreSQL 16 (Supabase multi-schema + RLS), Prisma ORM (`multiSchema`), BullMQ, and Cloudflare R2.

The platform powers **two distinct businesses** owned and operated by the partners on **80% shared physical warehouse infrastructure** (QR/ZPL thermal printing, mobile camera barcode scanning, hierarchical `StorageLocation` bins, tiered receipt/voucher-gated expenses, cash custody tracking, and private Cloudflare R2 evidence storage), while keeping domain schemas strictly isolated for regulatory and tax audits:

1. **Engine 1 — Canada-First Auto/Marine Salvage, eBay/Classifieds Syndication, Domestic Flips & Pre-Paid Direct Export (`ORG_SALVAGE_EXPORT` — `salvage` DB schema):**
   * **Kemptville Yard (`KEMP` — `ZONE_CONTAINER_PAD`):** Offline-first Ontario LHD vehicle/watercraft dismantling, 3-tap part QR binding (`PRT-XXXXXX` $\rightarrow$ `SHELVED_ORIGIN_CONTAINER`), 40ft container bin shelving (`C01`–`C04`, data-driven `StorageLocation.maxActiveAssetCapacity = 4` uncrushed shells), and **Zero-Typing Domestic Syndication (`FR-MKT-00`)** generating eBay Seller Hub Bulk CSVs (`< 15.0 kg` parts across North America, including 100% of `LHD_ONLY` parts) and EXIF-stripped local Ottawa classified payloads (`>= 15.0 kg` heavy assemblies).
   * **Ramsayville Shop (`RAMS`):** Salvage-to-Rebuilt MTO Reg. 601 dossier tracking, quick-turn vehicle flips (`RETAIL_LOT_VEHICLE_SALE`, `maxActiveAssetCapacity = 8` active lot slots), municipal bylaw stealth pickup hub (`"Ramsayville / East Ottawa, ON"`, `RULE-MKT-002`), and **Ontario Domestic CAD Checkout (`FR-CHK-01` / `DOMESTIC_ORIGIN`)** with atomic anti-double-sale delist sync (`DELIST_PENDING` / `DELIST_REQUIRED`), 10% negotiation corridor (`domesticAdminDiscountToleranceBps = 1000`), Operator Float (`HELD_IN_OPERATOR_FLOAT` — Taz's Shop Float) subledger, and **Self-Funding Working Capital Pool** (`initialSeedCapitalCadMinor` + realized CAD profits).
   * **Pre-Paid Direct Export (`RULE-EXP-001`) & Dormant Destination Bonded Vault (`POSV` — `DESTINATION_EXPORT_VAULT`):** Zero-consignment outbound export pallet/container manifesting (`FR-LOG-01`/`02`) gated on 100% upfront CAD/USD settlement in `SETTLED_ORIGIN_CORP_BANK` (`exportFulfillmentMode = 'PREPAID_ORIGIN_ONLY'`), LHD-to-RHD destination fitment guards, and broker-ready Commercial Invoice & Packing List generation. The full overseas Bonded Vault COD subsystem (`SHELVED_DESTINATION_VAULT`, MFA `aal2` `DESTINATION_VAULT_COD`, 3-tier TTD negotiation corridor, FIU CDD encryption, blind cycle counts, and $\text{TTD} \rightarrow \text{CAD}$ FX repatriation) remains schema-ready and dormant behind `IPolicyConfigPort` until Phase 3 overseas facility activation or external SaaS tenant use.
2. **Engine 2 — Health Canada Cannabis Nursery & Processing (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` DB schema):**
   * **Brockville JV Facility (`BROCK`) & Kemptville Nursery (`KEMP` — `ZONE_GREENHOUSE_AG` / `ZONE_TREE_FARM`):** 3-tap mother plant QR scanning to spawn clone tray batches (`LOT-YYYY-XXXX`), weatherproof ZPL tray label printing, and grow room/table custody tracking (`allowedOrgType = CANNABIS_NURSERY_AND_PROCESSING`).
   * **Mass-Balance Processing ("Moving the Juice") & CTLS Compliance:** Wet-to-dry curing and biomass-to-extract (`CRUDE_EXTRACT`, `DISTILLATE_OR_ISOLATE`) transformations reconciled to the gram ($0.01\text{g}$), automatic QAP compliance holds when unaccounted variance exceeds $2.0\%$, Health Canada dual-witness destruction logs (`primaryUserId != witnessUserId`), private R2 Lab CoA attachments, and monthly Health Canada CTLS & CRA Form B300 reporting.

---

## Multi-Schema PostgreSQL Isolation, Regulatory Firewall & SaaS Portability

The PostgreSQL database is partitioned into three schemas via Prisma `previewFeatures = ["multiSchema"]`:

* **`shared` schema (`@@schema("shared")`):** `Organization` (`id`, `slug`, `code`, `organizationType`, `policyConfigJson`), `User`, `OrganizationMembership`, `StorageLocation` (with data-driven `allowedOrgType` and `maxActiveAssetCapacity`), `CustodyEvent`, `Expense`, `CashCustodyTransfer`, `OutboxEvent`, and `AuditLog`. Every operational record is scoped by `organizationId` and enforced by Supabase Row-Level Security (`organizationId = (auth.jwt() ->> 'organization_id')::uuid`).
* **`salvage` schema (`@@schema("salvage")`):** `Vehicle`, `Part`, `Shipment`, `ShipmentPallet`, `PreOrderWishList`, `B2BReservation`, `SaleTransaction`, `SaleTransactionPartItem`, `SaleTransactionVehicleItem`, `CycleCountTask`, and `CurrencySettlement`.
* **`cannabis` schema (`@@schema("cannabis")`):** `CannabisStrain`, `CannabisLot`, `CannabisLotTransformation`, and `CannabisDestructionLog`.
* **Commercial Vertical-SaaS Portability (`IPolicyConfigPort`):** All market nodes (`DOMESTIC_ORIGIN`, `DESTINATION_EXPORT_VAULT`), sales channels (`LOCAL_WALK_IN_CASH`, `RETAIL_LOT_VEHICLE_SALE`, `DESTINATION_VAULT_COD`), cash custody states (`HELD_IN_OPERATOR_FLOAT`, `HELD_IN_DESTINATION_VAULT`, `SETTLED_ORIGIN_CORP_BANK`), and location zoning/capacity rules are data-driven and resolved per tenant via `IPolicyConfigPort` (`src/core/config/pricing-policy.json` with optional `Organization.policyConfigJson` overrides).

> **Audit Isolation Guarantee:** A Health Canada CTLS inspector or CRA Excise auditor reviewing `ORG_CANNABIS_NURSERY_PROC` has **zero visibility** into `salvage` schema tables, Trinidad export manifests, or Ontario automotive cash sales. Simultaneously, data-driven site zoning (`RULE-ZONE-001` via `StorageLocation.allowedOrgType`) hard-blocks scanning any `salvage` vehicle/part into a Greenhouse or Tree Farm barcode (`422 SITE_ZONING_VIOLATION`).

---

## Modular Directory Structure

```text
src/
├── core/
│   ├── domain/                    # Pure TypeScript domain calculators & 4-axis state guards
│   ├── ports/                     # Hexagonal Port Interfaces (IPolicyConfigPort, IStoragePort, etc.)
│   ├── events/                    # Domain Event contracts & Outbox publisher
│   └── config/                    # Versioned regulatory, tariff, FX & mass-balance parameters
├── modules/
│   ├── shared-ops/                # QR/ZPL printing, camera scanner, hierarchical StorageLocation
│   │                              # state machine, receipt-gated Expense & float ledger, R2 adapters
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
| **Phase 1A** | Days 1–7 (Ontario Domestic Launch MVP) | `shared` + `salvage` | Shared Core + Ontario Salvage Intake & 3-Tap Part Stripping (`FR-INT-01`, `FR-INT-02`), Tiered Expense & Working Capital Gate (`FR-EXP-01`, `FR-EXP-02`), **Zero-Typing Domestic Syndication Bridge (`FR-MKT-00`)**, and **Ontario Domestic CAD Checkout with Anti-Double-Sale Delist Sync (`FR-CHK-01`)**. |
| **Phase 1B** | Days 8–21 (Ottawa Velocity & Pre-Paid Export) | `shared` + `salvage` | 1-Click FB Marketplace / Kijiji Manifest V3 Chrome Extension (`FR-MKT-02`), "Bad Cop" Auction Deal Analyzer (`FR-DEAL-01`), and **100% Pre-Paid Direct Export Manifesting & Broker Dossier (`FR-LOG-01`, `FR-LOG-02`, `RULE-EXP-001`)**. |
| **Phase 2A** | Days 22–45 (Automated eBay API & Offline PWA) | `shared` + `salvage` | **Pulled-forward Automated eBay Inventory API Listing & Webhook Delist Sync**, Offline-first IndexedDB Stripper PWA, and QuickBooks/Xero GL sync. |
| **Phase 2B** | Days 45–90 (Brockville/Kemptville Ag Online) | `shared` + `cannabis` | Organization Workspace Switcher, 3-Tap Nursery Clone/Mother Tracking (`FR-CAN-01`), Mass-Balance Extraction Ledger (`FR-CAN-02`), Dual-Witness Destruction (`FR-CAN-03`), and Health Canada CTLS / CRA B300 Export (`FR-CAN-04`). |
| **Phase 3** | Months 3–6 (AI Vision & Dormant Overseas Bonded Vault) | `shared` + `salvage` + `cannabis` | Assistive AI Vision (`FR-AI-01`), **Dormant Overseas Bonded Vault Activation (`FR-VLT-01`–`FR-VLT-05`)**, Two-Step HMAC Gate Token exit scanning, and Live Container B2B Storefront (`FR-MKT-01`). |

---

## Authoritative Specification Documents

* **[`ARCHITECTURE.md`](./ARCHITECTURE.md):** System topology, Hexagonal Ports, multi-schema Prisma specification (`shared`, `salvage`, `cannabis`), mandatory PostgreSQL triggers/`CHECK` constraints/RLS policies, and 5-axis state machines.
* **[`PRD.md`](./PRD.md):** Functional requirements (`FR-*`), 7-role RBAC matrix, Organization Workspace Switcher rules, Phase 1 Ontario Domestic Operational Proof Gate & 4-Pillar Partnership Governance, and Non-Functional Requirements (`NFR-*`).
* **[`DOMAIN-RULES.md`](./DOMAIN-RULES.md):** LHD vs. RHD part compatibility matrix, multi-channel routing (`RULE-MKT-001`), Kemptville bylaw geolocation stealth (`RULE-MKT-002`), 100% pre-paid origin export gate (`RULE-EXP-001`), HS tariff & customs valuation register, Trinidad landed cost & shadow FX formulas, 3-Rule Compensation Protocol (`RULE-PAY-001`–`003`), Kemptville 19-acre site zoning (`RULE-ZONE-001`), and cannabis mass-balance & CTLS rules (`RULE-CAN-001`).
* **[`GLOSSARY.md`](./GLOSSARY.md):** Canonical ubiquitous language across Shared Operations, Salvage & Domestic Flips, Export & Destination Bonded Vault, Unit Economics & Cash Custody, and Cannabis Nursery & Processing.
