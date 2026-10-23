# Unified Multi-Tenant Operations & Compliance ERP

A **Domain-Driven Design (DDD) Multi-Tenant Modular Monolith** built on Next.js 15, React 19, TypeScript 5, PostgreSQL 16 (Supabase multi-schema + RLS), Prisma ORM (`multiSchema`), BullMQ, and Cloudflare R2.

The platform powers **two distinct businesses** owned and operated by the partners on **80% shared physical warehouse infrastructure** (QR/ZPL thermal printing, mobile camera barcode scanning, hierarchical `StorageLocation` bins, receipt-gated expenses, cash custody tracking, and private Cloudflare R2 evidence storage), while keeping domain schemas strictly isolated for regulatory and tax audits:

1. **Engine 1 — Auto/Marine Salvage, Domestic Flips & Trinidad Bonded Vault Export (`ORG_SALVAGE_EXPORT` — `salvage` DB schema):**
   * **Kemptville Yard (`KEMP` — `ZONE_CONTAINER_PAD`):** Offline-first vehicle/watercraft dismantling, 3-tap part QR binding (`PRT-XXXXXX`), and 40ft container bin shelving (`C01`–`C04`, max 4 uncrushed shells).
   * **Ramsayville Shop (`RAMS`):** Salvage-to-Rebuilt MTO Reg. 601 dossier tracking, quick-turn vehicle flips (max 8 active lot slots), and Ontario domestic CAD checkout with Taz's Shop Float subledger.
   * **Export Consolidation & Trinidad Vault (`POSV`):** LCL pallet / FCL container manifesting, LHD-to-RHD destination fitment guards, broker-ready Commercial Invoice & Packing List generation, Port of Spain landed check-in, MFA `aal2` Cash-on-Delivery (COD) verification, FIU Customer Due Diligence encryption, weekly blind cycle counts, and $\text{TTD} \rightarrow \text{CAD}$ FX repatriation batch tracking.
2. **Engine 2 — Health Canada Cannabis Nursery & Processing (`ORG_CANNABIS_NURSERY_PROC` — `cannabis` DB schema):**
   * **Brockville JV Facility (`BROCK`) & Kemptville Nursery (`KEMP` — `ZONE_GREENHOUSE_AG` / `ZONE_TREE_FARM`):** 3-tap mother plant QR scanning to spawn clone tray batches (`LOT-YYYY-XXXX`), weatherproof ZPL tray label printing, and grow room/table custody tracking.
   * **Mass-Balance Processing ("Moving the Juice") & CTLS Compliance:** Wet-to-dry curing and biomass-to-extract (`CRUDE_EXTRACT`, `DISTILLATE_OR_ISOLATE`) transformations reconciled to the gram ($0.01\text{g}$), automatic QAP compliance holds when unaccounted variance exceeds $2.0\%$, Health Canada dual-witness destruction logs (`primaryUserId != witnessUserId`), private R2 Lab CoA attachments, and monthly Health Canada CTLS & CRA Form B300 reporting.

---

## Multi-Schema PostgreSQL Isolation & Regulatory Firewall

The PostgreSQL database is partitioned into three schemas via Prisma `previewFeatures = ["multiSchema"]`:

* **`shared` schema (`@@schema("shared")`):** `Organization`, `User`, `OrganizationMembership`, `StorageLocation`, `CustodyEvent`, `Expense`, `CashCustodyTransfer`, `OutboxEvent`, and `AuditLog`. Every operational record is scoped by `organizationId` and enforced by Supabase Row-Level Security (`organizationId = (auth.jwt() ->> 'organization_id')::uuid`).
* **`salvage` schema (`@@schema("salvage")`):** `Vehicle`, `Part`, `Shipment`, `ShipmentPallet`, `PreOrderWishList`, `B2BReservation`, `SaleTransaction`, `SaleTransactionPartItem`, `SaleTransactionVehicleItem`, `CycleCountTask`, and `CurrencySettlement`.
* **`cannabis` schema (`@@schema("cannabis")`):** `CannabisStrain`, `CannabisLot`, `CannabisLotTransformation`, and `CannabisDestructionLog`.

> **Audit Isolation Guarantee:** A Health Canada CTLS inspector or CRA Excise auditor reviewing `ORG_CANNABIS_NURSERY_PROC` has **zero visibility** into `salvage` schema tables, Trinidad export manifests, or Ontario automotive cash sales. Simultaneously, Kemptville 19-acre site zoning (`RULE-ZONE-001`) hard-blocks scanning any `salvage` vehicle/part into a Greenhouse or Tree Farm barcode (`422 SITE_ZONING_VIOLATION`).

---

## Modular Directory Structure

```text
src/
├── core/
│   ├── ports/                     # Hexagonal Port Interfaces (Zero external deps)
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

## Phased Delivery Roadmap (Zero Delay to Trinidad Shipment #1)

| Phase | Target Window | Active Schemas | Scope & Milestone |
| :--- | :--- | :--- | :--- |
| **Phase 1A** | Weekend Build (Pre-Vessel Departure) | `shared` + `salvage` | Shared Core + Salvage Intake (`FR-INT-01`, `FR-INT-02`), Expense Logging (`FR-EXP-01`), and Broker-Ready Commercial Invoice & Packing List CSV/PDF (`FR-LOG-01`, `FR-LOG-02`) for **Trinidad Shipment #1** (1x Yamaha Jet, 1x Yamaha VR, 1x A/C Machine, 1x Kia/Hyundai/Mazda SUV pallet). |
| **Phase 1B** | Days 1–14 (During Ocean Transit) | `shared` + `salvage` | Trinidad Vault Check-In (`FR-VLT-01`), Landed Cost & TTD Floor Allocation (`FR-VLT-02`), Adaptive Mobile Checkout (`FR-CHK-01` / `FR-VLT-03`), and FX Repatriation Batch Ledger (`FR-VLT-04`). |
| **Phase 2A** | Days 31–60 (Post Shipment #1 Proof Gate) | `shared` + `salvage` | Offline-first IndexedDB Stripper PWA, Weekly Blind Cycle Counts (`FR-VLT-05`), Local FB/Kijiji Chrome Extension (`FR-MKT-02`), "Bad Cop" Deal Analyzer (`FR-DEAL-01`), 3-Rule Compensation & Piece-Rate Gate (`FR-EXP-02`), and QuickBooks/Xero GL sync. |
| **Phase 2B** | Days 45–90 (Brockville/Kemptville Ag Online) | `shared` + `cannabis` | Organization Workspace Switcher, 3-Tap Nursery Clone/Mother Tracking (`FR-CAN-01`), Mass-Balance Extraction Ledger (`FR-CAN-02`), Dual-Witness Destruction (`FR-CAN-03`), and Health Canada CTLS / CRA B300 Export (`FR-CAN-04`). |
| **Phase 3** | Months 3–6 (Scale & Automation) | `shared` + `salvage` + `cannabis` | Assistive AI Vision (`FR-AI-01`), Automated Two-Phase eBay Inventory API Sync, Two-Step HMAC Gate Token exit scanning, and Live Container B2B Storefront (`FR-MKT-01`). |

---

## Authoritative Specification Documents

* **[`ARCHITECTURE.md`](./ARCHITECTURE.md):** System topology, Hexagonal Ports, multi-schema Prisma specification (`shared`, `salvage`, `cannabis`), mandatory PostgreSQL triggers/`CHECK` constraints/RLS policies, and state machines.
* **[`PRD.md`](./PRD.md):** Functional requirements (`FR-*`), 7-role RBAC matrix, Organization Workspace Switcher rules, Phase 1 Operational Proof Gate, and Non-Functional Requirements (`NFR-*`).
* **[`DOMAIN-RULES.md`](./DOMAIN-RULES.md):** LHD vs. RHD part compatibility matrix, multi-channel routing (`RULE-MKT-001`), HS tariff & customs valuation register, Trinidad landed cost & shadow FX formulas, 3-Rule Compensation Protocol (`RULE-PAY-001`–`003`), Kemptville 19-acre site zoning (`RULE-ZONE-001`), and cannabis mass-balance & CTLS rules (`RULE-CAN-001`).
* **[`GLOSSARY.md`](./GLOSSARY.md):** Canonical ubiquitous language across Shared Operations, Salvage & Domestic Flips, Export & Trinidad Bonded Vault, Unit Economics & Cash Custody, and Cannabis Nursery & Processing.
