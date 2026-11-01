# DOMAIN-RULES.md — Configurable Policy, Tariff, Compatibility, Site Zoning & Mass-Balance Register

## 1. Architectural Rule: Configuration vs. Code Invariants

To prevent regulatory or market changes from requiring code deployments, the system strictly separates **Hard Code Invariants** from **Versioned Policy Parameters**:

* **Hard Code Invariants (Enforced in TypeScript Entities / DB Triggers):** Multi-schema & default-deny RLS tenant isolation across two independent legal corporations (`shared`, `salvage`, `cannabis` per `ADR-0004`), multi-tenant organization & facility location firewall (`RULE-ZONE-001`), two-phase eBay export locking (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`), append-only financial/scrap/audit/destruction records, strict separation of Vault Admin COD verification from sales brokers, single-use HMAC gate pass consumption, gram-accurate cannabis mass-balance identity, and dual-witness cannabis destruction (`primaryUserId != witnessUserId`).
* **Configurable Policy Parameters (Stored in `src/core/config/pricing-policy.json` or `shared.Organization.policyConfigJson` via `IPolicyConfigPort`):** Regulatory agility mode (`operationalGates.complianceEnforcementMode`: `"WARN_ONLY" | "STRICT_BLOCK"`, defaulting to `"WARN_ONLY"` in Phase 1A so physical custody truth is never blocked by lagging paperwork), 3-tranche `$44,000 CAD` Senior Secured Loan release milestones (`$22k / $12k / $10k`), deal discipline caps (`$3,200` donor cap & Year-1 `HIGH_END_REBUILD` pause with 1-tap `cfoOverride`), Ontario 13% HST trust ring-fencing (`domesticTaxPolicy`), DriveON 10-day re-inspection & 36-day SSC timers, customs duty/VAT rates, shadow FX multipliers, LHD/RHD part-category mappings, ARA grading multipliers, data-driven location capacity & environmental dismantling flags (`StorageLocation.maxActiveAssetCapacity`, `allowsWholeVehicleDismantling`), and cannabis mass-balance tolerances (`RULE-CAN-001`).

---

## 2. LHD vs. RHD Part Compatibility & Canada-First Multi-Channel Routing

**Context:** Donor vehicles acquired in Ontario are Left-Hand Drive (`LHD_ONLY`). Under the **Canada-First Domestic & eBay Motors Primary Rollout**, **100% of stripped parts from Ontario LHD donors** (both `UNIVERSAL` and `LHD_ONLY`) are immediately compatible with North American buyers (`EBAY_MOTORS_SHIPPED` and local Ottawa classifieds), completely eliminating LHD-to-RHD part waste. When fulfilling pre-paid export orders to Right-Hand Drive (`RHD_ONLY`) markets such as Trinidad & Tobago or Barbados, steering-side filtering applies automatically:

* **Rule (`RULE-FIT-001`):** Any stripped automotive part must be assigned a `SteeringSideCompatibility` enum (`UNIVERSAL`, `LHD_ONLY`, `RHD_ONLY`) based on its `partCategoryName` default below, unless explicitly overridden by a human reviewer or matched to a verified LHD Caribbean buyer wish-list. **Important Fitment Clarification:** `UNIVERSAL` indicates **steering-side geometry neutrality only** (i.e., the part is not physically mirrored between LHD and RHD cockpits/firewalls); it **never** replaces mandatory OEM part-number or Hollander/interchange fitment verification (`oemFitmentVerified = true`) against destination-market vehicles across trim, engine, or model-year variants.
* **Rule (`RULE-FIT-002`):** Parts flagged `LHD_ONLY` are sold directly through **Domestic North American Channels (`EBAY_MOTORS_SHIPPED`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`)** and blocked from being scanned onto an RHD-destined export pallet (`TT_POS`, `BB_BGI`) unless an explicit `PreOrderWishList` override exists.

| Part Category (`partCategoryName`) | Default `SteeringSideCompatibility` | Export Eligibility (Trinidad / Barbados) | Notes / Physics & Fitment Rationale |
| :--- | :--- | :--- | :--- |
| **Complete Engine Assembly** | `UNIVERSAL` | **Eligible** | Long-block and manifolds cross over; check harness/ECU pins (`oemFitmentVerified = true`). |
| **Transmission / Gearbox / Transaxle** | `UNIVERSAL` | **Eligible** | Direct mechanical crossover. |
| **Front Bumpers, Hoods, Fenders, Grilles** | `UNIVERSAL` | **Eligible** | High-velocity collision sheet metal for 2021–2022 Kia/Hyundai/Mazda. |
| **Complete Doors (Shell, Glass, Latch)** | `UNIVERSAL` | **Eligible (Shell)** | Physical door shells & glass are symmetric; **Note:** Master window switch bezel is LHD/RHD specific. |
| **Rear Clips, Tailgates, Rear Bumpers, Taillights** | `UNIVERSAL` | **Eligible** | Fully symmetrical across LHD and RHD SUVs. |
| **Suspension (Struts, Control Arms, Knuckles, Axles)** | `UNIVERSAL` | **Eligible** | High demand due to Caribbean road conditions. |
| **A/C Compressors, Condensers, Radiators, Alternators** | `UNIVERSAL` | **Eligible** | Direct accessory bolt-on crossover. |
| **Watercraft / Marine Assemblies (Rotax / Yamaha)** | `UNIVERSAL` | **Eligible** | Personal watercraft and jet boats have no LHD/RHD distinction. |
| **Steering Rack, Steering Column, Intermediate Shaft** | `LHD_ONLY` | **Blocked (eBay Only)** | Physically mirrored casting; will not bolt into RHD firewall/subframe. |
| **Dashboard Assembly, Center Console, Glovebox** | `LHD_ONLY` | **Blocked (eBay Only)** | Molded specifically for left-side driver cockpit. |
| **Front Headlamps (Halogen / LED Projector)** | `LHD_ONLY` | **Restricted (Warn)** | Beam cutoff pattern is angled for right-hand traffic (LHT vs RHT); export only if buyer explicitly accepts LHD beam pattern. |
| **Windshield Wiper Linkage, Cowl & Motor** | `LHD_ONLY` | **Blocked (eBay Only)** | Sweep geometry and pivot mounts are mirrored for LHD driver visibility. |
| **Brake Booster, Master Cylinder & Pedal Box** | `LHD_ONLY` | **Blocked (eBay Only)** | Firewall mounting and brake line routing are side-specific. |
| **Wiring Harnesses & Cabin/Dash Looms** | `LHD_ONLY` | **Blocked (eBay Only)** | Loom lengths, fuse-box breakouts, and firewall grommets are routed specifically for LHD cockpits. |

### 2.1 Multi-Channel Domestic & Pre-Paid Export Routing Matrix (`RULE-MKT-001`, `RULE-MKT-002` & `RULE-EXP-001`)

To maximize net CAD margin and cash velocity ($7\text{–}21$ day donor break-even) while avoiding platform bot bans, municipal bylaw complaints, and overseas credit risk, inventory is routed across channels via three operational rules:

* **Rule (`RULE-MKT-001` — Weight, Geography & Day-1 B2B Mechanic Channel Split [Zero Hollander Dependency]):** Small/light parts (`weightKg < heavyLocalOnlyThresholdKg` [$15.0\text{ kg}$]) default to `EBAY_MOTORS_SHIPPED` for North America-wide courier fulfillment; heavy/bulky assemblies (`weightKg >= 15.0 kg`) and retail lot vehicles default to local Ottawa pickup channels (`FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `LOCAL_WALK_IN_CASH`, `WHOLESALE_MECHANIC_NETWORK`, `CAR_PART_WHOLESALE`, `RETAIL_LOT_VEHICLE_SALE`). For high-ticket powertrains and collision front-clips, `ISyndicationTemplatePort.exportB2bMechanicPowertrainSheet` generates a Day-1 **Ottawa/Gatineau B2B Mechanic WhatsApp Markdown + CSV Broadcast Sheet** using free NHTSA vPIC + eBay Compatibility APIs (explicitly bypassing `$350–$600/mo` Solera Hollander yard-management licensing).
* **Rule (`RULE-MKT-002` — Kemptville Bylaw & Geolocation Stealth):** Because `ORG_SALVAGE_EXPORT`'s primary operating facility in rural Kemptville (`KEMP`) is subject to complaint-driven municipal clean-yard bylaws and `O. Reg. 85/16` storage perimeters, $100\%$ of product photos uploaded to `R2_PUBLIC_MEDIA_BUCKET` have EXIF GPS coordinates stripped, and $100\%$ of local classified ad payloads (`FR-MKT-00` / `FR-MKT-02`) format the public pickup location strictly from configurable `domesticTaxPolicy.publicPickupCityLabel` / `domesticSyndication.publicPickupLocationLabel` (default `"Ottawa South / Hwy 416 Corridor"`, masking exact Kemptville container pad coordinates behind an approved regional corridor label).
* **Rule (`RULE-EXP-001` — Zero Speculative Export / 100% Pre-Paid Origin Export Gate):** While `exportPolicy.exportFulfillmentMode == 'PREPAID_ORIGIN_ONLY'` (default when no destination bonded vault is active), shipping unpurchased inventory overseas on consignment is strictly prohibited. Any export `Shipment` or `ShipmentPallet` (whole watercraft, shop equipment, or `UNIVERSAL` parts pallets to Trinidad, Barbados, or the Middle East) is hard-blocked from sealing (`422 PREPAID_EXPORT_REQUIRED`) unless $100\%$ of items on the shipment have verified upfront CAD/USD payment settled in `SETTLED_ORIGIN_CORP_BANK` (or an explicit `ARCHITECT_CFO` verified-deposit override).

| Inventory Class | Primary Sales Channel(s) | Listing & Syndication Mechanism | Fee & Logistics Rationale |
| :--- | :--- | :--- | :--- |
| **Small / Light Electronics, Trim & `LHD_ONLY` Parts (`< 15 kg`: ECUs, radar sensors, clusters, switches, taillights, steering racks, headlamps)** | `EBAY_MOTORS_SHIPPED` | **Phase 1A Zero-Typing eBay Seller Hub Bulk CSV (`FR-MKT-00`)** $\rightarrow$ **Phase 2A Automated eBay Inventory API + Webhooks** | `50%–75%` net margin (`$2,500–$4,000+` CAD long-tail profit/car); easy to box and courier across Canada/US after `13.25%` platform fee. |
| **Heavy / Bulky Domestic Assemblies (`>= 15 kg`: engines, transmissions, doors, hoods, bumpers, subframes, seats)** | `WHOLESALE_MECHANIC_NETWORK`, `CAR_PART_WHOLESALE`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `LOCAL_WALK_IN_CASH` | **Phase 1A 1-Click B2B Mechanic Powertrain Sheet & Local Ad Payload (`FR-MKT-00`)** + **Phase 1B Manifest V3 Chrome Extension (`FR-MKT-02`)** with `publicPickupLocationLabel` stealth (`RULE-MKT-002`) | `60%–85%` net margin in `1–14 days`; `0%` platform fee, `$0` freight, `$0` Hollander fee, `0%` FX loss—recovers `~$2,500–$3,200` donor cost in `14–21 days`. |
| **Quick-Turn $5,000 Beaters (Salvage Retail Concept `RAMS`, Subject to Operational Verification; `HIGH_END_REBUILD` Paused in Year 1 Unless `cfoOverride`)** | `RETAIL_LOT_VEHICLE_SALE`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL` | Local Ad Queue (`FR-MKT-00`) + Chrome Extension Vehicle Autofill (`FR-MKT-02`) + configurable `StorageLocation.maxActiveAssetCapacity` | Turns CAD every `7–14 days` (`$1.5k–$2k`/beater) at `0%` fee with DriveON 10-day punch-list / deposit-triggered 36-day SSC & signed Bill of Sale (`FR-CHK-01`). |
| **Pre-Paid Direct Exports (`UNIVERSAL` Pallets, Watercraft & Shop Equipment)** | `DESTINATION_PRE_ORDER_PICKUP`, `SECONDARY_ISLAND_WHOLESALE` *(or Phase 3 `DESTINATION_VAULT_COD`)* | **100% Pre-Paid Origin Export Gate (`RULE-EXP-001`)** + Broker-Ready Commercial Invoice & Packing List (`FR-LOG-01`, `FR-LOG-02`) | Eliminates overseas consignment/shrinkage risk and `60–120 day` TTD FX lockup; Destination Bonded Vault (`FR-VLT-01..05`) stays dormant until Phase 3. |

---

## 3. Harmonized System (HS) Tariff & Customs Valuation Register

**Rule (`RULE-CUST-001`):** AI-suggested HS codes (`Part.suggestedHsCode`) are **assistive proposals only**. For commercial customs filing, the licensed customs broker confirms `Part.brokerVerifiedHsCode`.
**Rule (`RULE-CUST-002`):** CBSA CERS export declarations are mandatory for commercial goods valued $\ge \text{CAD } \$2,000$ destined outside the US, and **mandatory for all permanently exported conveyances (vehicles and watercraft) regardless of dollar value**, submitted $\ge 48\text{ hours}$ prior to marine vessel loading.
**Rule (`RULE-CUST-003` — Arm's-Length FOB Transfer Pricing):** Declared Wholesale FOB USD values (`wholesaleFobUsdMinor`) on the Commercial Invoice must reflect defensible arm's-length wholesale cost-plus transfer pricing derived from documented Canadian acquisition receipts (`Expense.receiptStorageKey`) plus pro-rata dismantling cost allocation, never arbitrary under-invoicing.

| Asset / Part Category | Default HS Subheading | Default Trinidad CET Duty Rate (Configurable) | Trinidad VAT Rate (Compounded) | Mandatory Environmental & Hazmat Gate |
| :--- | :--- | :--- | :--- | :--- |
| **Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)** | `8903.99` | `20.0%` – `30.0%` *(Verify per hull)* | `12.5%` | Wash/steam clean hull & bilge; drain fuel; permanent conveyance CERS report with 12-char HIN. |
| **Shop Equipment (A/C Recharge Machine)** | `8479.89` | `0.0%` – `10.0%` *(Industrial machinery)* | `12.5%` | Internal recovery tank must be evacuated of pressurized refrigerant gas prior to ocean transit. |
| **Complete Spark-Ignition Engines (>1000cc)** | `8407.34` | `25.0%` – `30.0%` | `12.5%` | Drain 100% of motor oil and coolant; cap ports; log engine serial number. |
| **Bumpers & Parts Thereof** | `8708.10` | `30.0%` | `12.5%` | Clean surface; wrap sharp corners. |
| **Body Panels, Doors, Hoods, Fenders** | `8708.29` | `30.0%` | `12.5%` | Clean surface; record 3-char damage code. |
| **Brakes & Servo-Brakes** | `8708.30` | `30.0%` | `12.5%` | Drain all brake fluid; cap hydraulic ports. |
| **Gearboxes / Transmissions** | `8708.40` | `30.0%` | `12.5%` | Drain 100% of ATF/gear oil; cap cooler lines. |
| **Drive-Axles & Differentials** | `8708.50` | `30.0%` | `12.5%` | Drain differential gear oil. |
| **Road Wheels & Rims** | `8708.70` | `30.0%` | `12.5%` | Visual crack/distortion inspection mandatory; cracked wheels must be scrapped, never sold. |
| **Suspension Shock Absorbers & Struts** | `8708.80` | `30.0%` | `12.5%` | Inspect for hydraulic leaks. |
| **Radiators & Cooling Systems** | `8708.91` | `30.0%` | `12.5%` | Drain coolant completely; cap ports. |
| **Safety Airbags & Pyrotechnic Pretensioners** | `8708.95` | `30.0%` | `12.5%` | **QUARANTINED BY DEFAULT (`isHazmatOrAirbag = true`)**: Requires VIN recall check + Class 9 DG (`UN3268`) certification. **Excluded from LCL Shipment #1**. |
| **Other Auto Parts (ECUs, Sensors, Alternators, Starters)** | `8708.99` | `30.0%` | `12.5%` | Store in dry bin; protect connectors. |

---

## 4. Algorithmic Pricing, Landed Cost & FX Reserve Formulas

All configurable parameters live in `src/core/config/pricing-policy.json` and can be updated via the CFO Dashboard after each shipment clears customs or when regulatory tolerances are adjusted.

### 4.1 Configurable Financial, Site Zoning & Cannabis Compliance Parameters (Initial Defaults)

```json
{
  "metadata": {
    "verificationStatus": "ESTIMATE",
    "effectiveDate": "2026-10-21",
    "source": "Initial Shipment #1 & Multi-Tenant Dual-Engine Baseline",
    "approvedBy": "ARCHITECT_CFO"
  },
  "fxRates": {
    "cadToUsdSpot": 0.73,
    "usdToTtdOfficialCustoms": 6.78297,
    "usdToTtdShadowRepatriation": 7.35
  },
  "trinidadImportTax": {
    "isTrinidadEntityVatRegistered": false,
    "defaultAutoPartsDutyRate": 0.30,
    "customsProcessingFeeRate": 0.03,
    "vatRate": 0.125
  },
  "oceanFreight": {
    "allocatedLclFreightUsdPerKg": 1.85,
    "marineInsuranceRateOfFob": 0.015
  },
  "marginsAndCommissions": {
    "targetExportMarkupOnCost": 0.65,
    "defaultBrokerCommissionRate": 0.10,
    "minBeaterNetProfitCadMinor": 150000,
    "minRebuildNetProfitCadMinor": 700000,
    "minPartOutRoiMultiplier": 2.0
  },
  "domesticTaxPolicy": {
    "isOntarioEntityHstRegistered": true,
    "isOntarioHstRegistered": true,
    "isOmvicLicensed": false,
    "ontarioHstRate": 0.13,
    "publicPickupCityLabel": "Ottawa South / Hwy 416 Corridor"
  },
  "domesticChannelFees": {
    "LOCAL_WALK_IN_CASH": 0.0,
    "FB_MARKETPLACE_LOCAL": 0.0,
    "KIJIJI_LOCAL": 0.0,
    "RETAIL_LOT_VEHICLE_SALE": 0.0,
    "WHOLESALE_MECHANIC_NETWORK": 0.0,
    "EBAY_MOTORS_SHIPPED": 0.1325,
    "CAR_PART_WHOLESALE": 0.0
  },
  "araGradeMultipliers": {
    "GRADE_A": 1.05,
    "GRADE_B1": 1.00,
    "GRADE_B2": 0.95,
    "GRADE_B3": 0.85,
    "GRADE_C": 0.70,
    "GRADE_X": 0.80
  },
  "complianceThresholds": {
    "trinidadFiuCddThresholdTtdMinor": 5000000,
    "trinidadFiuLargeCashReportTtdMinor": 9000000,
    "trinidadDepositInsuranceCapTtdMinor": 20000000,
    "trinidadDepositAlertThresholdTtdMinor": 18000000,
    "cbsaCersValueThresholdCadMinor": 200000,
    "cbsaMarineCutoffHours": 48,
    "driveOnReinspectionWindowDays": 10,
    "safetyStandardsCertMaxDays": 36
  },
  "operationalGates": {
    "complianceEnforcementMode": "WARN_ONLY",
    "workingCapitalGate": {
      "enabled": true,
      "enforcementMode": "HARD_BLOCK",
      "totalCommittedLoanFacilityCadMinor": 4400000,
      "initialSeedCapitalCadMinor": 2200000,
      "minCashReserveFloorCadMinor": 750000,
      "countPendingExportCashAsAvailable": false,
      "tranches": [
        {
          "trancheCode": "TRANCHE_1_LAUNCH",
          "principalCadMinor": 2200000,
          "unlocked": true
        },
        {
          "trancheCode": "TRANCHE_2_DAY_60",
          "principalCadMinor": 1200000,
          "unlocked": false,
          "minShelvedSkus": 120,
          "minScrappedDonors": 3
        },
        {
          "trancheCode": "TRANCHE_3_DAY_120",
          "principalCadMinor": 1000000,
          "unlocked": false,
          "minShelvedSkus": 400,
          "minScrappedDonors": 8,
          "requireZeroOverdueFloatReceipts": true
        }
      ]
    },
    "dealDisciplineGate": {
      "maxDonorDismantleLandedCadMinor": 320000,
      "enableHighEndRebuildLane": false
    },
    "locationCapacityGate": {
      "enforcementMode": "HARD_BLOCK"
    }
  },
  "expensePolicy": {
    "pettyCashVoucherMaxCadMinor": 5000,
    "monthlyUnreceiptedVoucherCapCadMinor": 25000
  },
  "checkoutPolicy": {
    "checkoutStrictnessMode": "BONDED_VAULT_STRICT",
    "vaultAdminDiscountToleranceBps": 800,
    "vaultAdminSmallRoundingAllowanceTtdMinor": 10000,
    "vaultAdminMaxDiscountCapTtdMinor": 75000,
    "domesticAdminDiscountToleranceBps": 1000
  },
  "exportPolicy": {
    "exportFulfillmentMode": "PREPAID_ORIGIN_ONLY",
    "requireFullPrepaymentBeforeShipmentSeal": true
  },
  "domesticSyndication": {
    "publicPickupLocationLabel": "Ottawa South / Hwy 416 Corridor",
    "heavyLocalOnlyThresholdKg": 15.0,
    "ebaySiteId": "Canada",
    "ebayCurrency": "CAD"
  },
  "siteZoningLimits": {
    "kemptvilleMaxUncrushedShellsOnPad": 4,
    "kemptvilleContainerCount": 4,
    "ramsayvilleMaxActiveShopVehicles": 8
  },
  "compensationRules": {
    "stripperPieceRatePerVehicleCadMinor": 35000,
    "minShelvedPartsForStripPayout": 35,
    "allowFounderDrawFromSeedCapital": false,
    "autoOffsetHunterDrawAgainstFloat": true
  },
  "cannabisCompliance": {
    "wetToDryMoistureLossMinPct": 0.72,
    "wetToDryMoistureLossMaxPct": 0.80,
    "biomassToCrudeExtractYieldMinPct": 0.10,
    "biomassToCrudeExtractYieldMaxPct": 0.25,
    "crudeToDistillateRefinementYieldMinPct": 0.65,
    "crudeToDistillateRefinementYieldMaxPct": 0.88,
    "maxUnaccountedVarianceAlertPct": 0.02
  }
}
```

### 4.2 Landed Cost & Trinidad Vault COD Floor Formula (Branching on VAT Registration)

1. **CIF Valuation (USD):**
   $$\text{CIF}_{\text{USD}} = \text{FOB}_{\text{USD}} + (\text{Weight}_{\text{kg}} \times C_{\text{freight\_per\_kg}}) + (\text{FOB}_{\text{USD}} \times r_{\text{ins}})$$
2. **Assessed Trinidad Customs Duty & Compounded VAT (TTD):**
   * Note: Customs assesses CIF in TTD using the **Official Customs Rate** ($\approx 6.78297$), whereas VAT ($12.5\%$) is compounded on ($\text{CIF} + \text{Duty} + \text{Processing Fee}$).
   $$\text{CIF}_{\text{TTD}} = \text{CIF}_{\text{USD}} \times \text{FX}_{\text{official}}$$
   $$\text{DutyAndFees}_{\text{TTD}} = \text{CIF}_{\text{TTD}} \times (r_{\text{duty}} + r_{\text{proc}})$$
   $$\text{VAT}_{\text{TTD}} = (\text{CIF}_{\text{TTD}} + \text{DutyAndFees}_{\text{TTD}}) \times r_{\text{VAT}}$$
   * **Non-Recoverable vs. Recoverable Import VAT (`isTrinidadEntityVatRegistered`):**
     * **When `isTrinidadEntityVatRegistered == false` (Phase 1 Default):** The $12.5\%$ import VAT paid at customs (`VAT_TTD`) is non-recoverable and **IS included** in $\text{TotalTaxesAndFreight}_{\text{TTD}}$ inside the floor price numerator, while checkout `taxOrVatMinor` is forced to `0` and `taxInvoiceNumber` is omitted:
       $$\text{TotalTaxesAndFreight}_{\text{TTD}} = \text{DutyAndFees}_{\text{TTD}} + \text{VAT}_{\text{TTD}} + (\text{FreightAndIns}_{\text{USD}} \times \text{FX}_{\text{shadow}})$$
     * **When `isTrinidadEntityVatRegistered == true`:** The $12.5\%$ import VAT paid at customs is a recoverable Input Tax Credit and is **EXCLUDED** from $\text{TotalTaxesAndFreight}_{\text{TTD}}$ in the floor price numerator; instead, $12.5\%$ output VAT is added on top of the sale price at checkout (`taxOrVatMinor`) with a mandatory `taxInvoiceNumber`:
       $$\text{TotalTaxesAndFreight}_{\text{TTD}} = \text{DutyAndFees}_{\text{TTD}} + (\text{FreightAndIns}_{\text{USD}} \times \text{FX}_{\text{shadow}})$$
3. **Minimum Vault COD Floor Price (TTD) — Markup vs. Realized Margin Clarification:**
   * Note: `targetExportMarkupOnCost` ($0.65$) represents a **$65\%$ markup on allocated cost** (equivalent to a $39.4\%$ gross margin on pre-tax wholesale price before unallocated yard overhead), which is distinct from realized net margin after landed taxes, FX slippage, and broker commissions.
   * Protects Canadian principal against parallel-market FX spread ($\text{FX}_{\text{shadow}}$) and holds back the broker's $10\%$ referral commission:
   $$\text{VaultFloor}_{\text{TTD}} = \frac{\left(\text{AllocatedCost}_{\text{CAD}} \times (1 + \text{TargetMarkup}_{\text{export}}) \times \text{FX}_{\text{CAD}\rightarrow\text{USD}} \times \text{FX}_{\text{shadow}}\right) + \text{TotalTaxesAndFreight}_{\text{TTD}}}{1 - r_{\text{comm}}}$$
4. **Grade-Adjusted Market Baseline & Recommended Wholesale Ask vs. Hard Cost Floor:**
   * Using $\gamma_{\text{ARA}}$ from `araGradeMultipliers` corresponding to `Part.conditionGrade`:
   $$\text{GradeAdjustedMarketValue}_{\text{CAD}} = \text{round}\left(\text{CompBaseline}_{\text{CAD}} \times \gamma_{\text{ARA}}\right)$$
   * Domestic `retailPriceCadMinor` defaults to $\text{GradeAdjustedMarketValue}_{\text{CAD}}$.
   * In Trinidad, the **Recommended Wholesale Ask Price (`recommendedAskTtdMinor`)** scales with $\gamma_{\text{ARA}}$, while the **Minimum Vault COD Floor Price (`vaultFloorPriceTtdMinor`)** remains strictly anchored to actual allocated cost basis + landed taxes/freight so discounting a `GRADE_C` part never breaches hard cost recovery without an explicit CFO override.
5. **Rule `RULE-PRC-002` (Pre-VAT Broker Commission Base & Counter Netting):**
   * `SaleTransaction.brokerCommissionMinor` is always calculated strictly on the **pre-tax subtotal (`subtotalMinor`)**, never on collected output VAT (`taxOrVatMinor`):
   $$\text{brokerCommissionMinor} = \text{round}\left(\text{subtotalMinor} \times \frac{\text{brokerCommissionBps}}{10000}\right)$$
   * **Broker Commission Deducted at Counter (`isBrokerCommissionDeductedAtCounter`):** When `isBrokerCommissionDeductedAtCounter == true`, the broker retained their commission directly from the cash handed over at the counter, so the physical cash added to `HELD_IN_DESTINATION_VAULT` is `grossCollectedMinor - brokerCommissionMinor`, keeping physical vault cash 100% accurate.
6. **3-Tier Price Floor Evaluation & Negotiation Corridor (`checkoutPolicy`):**
   * At checkout, the system snapshots `floorPriceAtCheckoutMinor` and computes $\text{discountAmountMinor} = \max(0,\; \text{floorPriceAtCheckoutMinor} - \text{grossCollectedMinor})$, evaluating three deterministic tiers:
     1. **Tier 1 (At or Above Floor):** `grossCollectedMinor >= floorPriceAtCheckoutMinor` $\rightarrow$ Passes automatically (`discountReasonCode = null`).
     2. **Tier 2 (Within Admin Negotiation Corridor):** In Trinidad (`DESTINATION_EXPORT_VAULT`), the maximum admin discount corridor is bounded by the 8.0% tolerance band (`vaultAdminDiscountToleranceBps = 800`), the $\text{TT\$100}$ small-part rounding floor (`vaultAdminSmallRoundingAllowanceTtdMinor = 10000`), and the $\text{TT\$750}$ hard dollar cap on high-ticket boats/engines (`vaultAdminMaxDiscountCapTtdMinor = 75000`):
        $$\text{MaxAdminDiscount}_{\text{TTD}} = \min\left(\text{vaultAdminMaxDiscountCapTtdMinor},\; \max\left(\text{vaultAdminSmallRoundingAllowanceTtdMinor},\; \text{round}(\text{floorPriceAtCheckoutMinor} \times 0.08)\right)\right)$$
        When $\text{discountAmountMinor} \le \text{MaxAdminDiscount}_{\text{TTD}}$ (or $\le 10.0\%$ in Ontario under `domesticAdminDiscountToleranceBps = 1000`), the sale is allowed for `TRINIDAD_VAULT_ADMIN` (or `HUNTER_MECHANIC` in Ontario) **IF AND ONLY IF** a valid `discountReasonCode` (`"CASH_ROUNDING" | "BUNDLE_DISCOUNT" | "TRANSIT_OR_SHOP_DAMAGE" | "AGED_INVENTORY_CLEARANCE"`) is selected.
     3. **Tier 3 (Beyond Admin Corridor — Hard Lock / CFO Override Required):** When $\text{discountAmountMinor} > \text{MaxAdminDiscount}_{\text{TTD}}$, the mutation throws `FLOOR_PRICE_OVERRIDE_REQUIRED` unless either (a) `actorRole === 'ARCHITECT_CFO'`, or (b) a valid `cfoOverrideApprovedById` + `cfoOverrideReasonNote` (via CFO Override PIN/approval) is supplied.

### 4.3 3-Tranche Working Capital Pool, Ontario 13% HST Ring-Fencing, Deferred Lease Accruals & Operator Float (Organization-Scoped to `ORG_SALVAGE_EXPORT`)

> **Entity Financial Isolation Note (`ADR-0004`):** Every working-capital pool, loan tranche, cash float (`HELD_IN_OPERATOR_FLOAT`), bank account (`SETTLED_ORIGIN_CORP_BANK`), CRA HST trust counter, and deferred lease accrual is computed strictly per `organizationId`. `ORG_SALVAGE_EXPORT` and `ORG_CANNABIS_NURSERY_PROC` are independent legal entities and never pool cash, bank accounts, loan facilities, or liabilities.

1. **3-Tranche `$44,000 CAD` Senior Secured Loan, Deferred Accruals & Deal Discipline Gates (`operationalGates.workingCapitalGate` & `dealDisciplineGate`):**
   * Rather than deploying `$44,000 CAD` upfront as unprotected equity, `ORG_SALVAGE_EXPORT`'s seed capital is structured as a **Senior Secured Working Capital Loan Facility (`totalCommittedLoanFacilityCadMinor = 4400000`)** released in **3 milestone tranches** (`TRANCHE_1_LAUNCH = $22,000 CAD` [`unlocked: true`, yielding `$14,500 CAD` active Day-1 buying power above the `$7,500 CAD` reserve floor to fund 2 quick-turn beaters + 3 donor SUVs], `TRANCHE_2_DAY_60 = $12,000 CAD` [`minShelvedSkus: 120`, `minScrappedDonors: 3`], and `TRANCHE_3_DAY_120 = $10,000 CAD` [`minShelvedSkus: 400`, `minScrappedDonors: 8`, `requireZeroOverdueFloatReceipts: true`]).
   * **Deferred Lease / Service Accrual (`ITA s. 78(1)` — `Expense.isDeferredIntercompanyAccrual`):** Yard/container pad storage rent or software/equipment lease invoices incurred by `ORG_SALVAGE_EXPORT` and logged with `isDeferredIntercompanyAccrual == true` and `accrualSettledAt == null` accrue on `ORG_SALVAGE_EXPORT`'s independent GL balance sheet (subject to counterparty corporate tax verification under Canadian *Income Tax Act* `s. 78(1)`) and are **excluded from liquid cash drain** in `AvailableWorkingCapital_CAD` until `accrualSettledAt` is stamped:
   $$\text{ActiveReleasedTrancheCapital}_{\text{CAD}} = \sum_{t \in \text{Tranches},\; t.\text{unlocked}=\text{true}} t.\text{principalCadMinor} \quad (\$22,000\text{ CAD at Launch})$$
   $$\text{AvailableWorkingCapital}_{\text{CAD}} = \text{ActiveReleasedTrancheCapital}_{\text{CAD}} + \sum \text{NetRealizedDomesticSales}_{\text{CAD}} + \sum \text{ScrapComponentLog.payoutCadMinor} + \sum \text{RepatriatedExportSettlements}_{\text{CAD}} - \sum \text{CashDeployedAcquisitionsAndSettledExpenses}_{\text{CAD}}$$
   * **Enforced Capital & Deal Discipline Caps with 1-Tap `cfoOverride`:**
     1. **Reserve Floor Gate:** $\text{AvailableWorkingCapital}_{\text{CAD}} - \text{EstimatedDealOutlay}_{\text{CAD}} \ge \text{minCashReserveFloorCadMinor}$ ($\$7,500\text{ CAD}$).
     2. **Donor SUV Landed Cap (`maxDonorDismantleLandedCadMinor = 320000`):** Blocks `DISMANTLE_AND_EXPORT` acquisitions whose estimated landed outlay (bid + auction fee + tow) exceeds **`$3,200.00 CAD`**.
     3. **Year-1 High-End Rebuild Pause (`enableHighEndRebuildLane = false`):** Blocks `operationalLane == 'HIGH_END_REBUILD'` acquisitions during Year 1 to prevent 60–120 day frame-bench/MTO inspection cash lockups.
     4. **1-Tap `cfoOverride` Escape Hatch:** Every capital, tranche, donor-cap, lane-pause, and `StorageLocation.maxActiveAssetCapacity` gate supports a **1-Tap `cfoOverride`** (`cfoOverride: { approved: true, reasonNote }` executed by `ARCHITECT_CFO`), persisting `cfoGateApprovedById`, `cfoGateApprovedAt`, `cfoGateOverrideReason`, and an immutable `AuditLog` entry without blocking opportunistic deals.
2. **Rule `RULE-TAX-HST-01` — Ontario 13% HST Trust Ring-Fencing & Domestic Net Realization (`domesticTaxPolicy`):**
   * Because the venture exceeds the `$30,000 CAD` CRA Small Supplier threshold within Quarter 1, `domesticTaxPolicy.isOntarioEntityHstRegistered` defaults to `true` (`ontarioHstRate = 0.13`) so Day-1 Input Tax Credits (ITCs) on vehicle acquisitions, tools, and supplies are recoverable while collected output HST is strictly ring-fenced as CRA trust money:
   $$\text{TaxOrVat}_{\text{CAD}} = \begin{cases} \text{round}\left(\text{Subtotal}_{\text{CAD}} \times 0.13\right) & \text{if } \text{isOntarioEntityHstRegistered} = \text{true} \\ 0 & \text{otherwise} \end{cases}$$
   $$\text{GrossCollected}_{\text{CAD}} = \text{Subtotal}_{\text{CAD}} + \text{TaxOrVat}_{\text{CAD}}$$
   $$\text{PlatformFee}_{\text{CAD}} = \text{round}\left(\text{Subtotal}_{\text{CAD}} \times r_{\text{channel\_fee}}\right)$$
   $$\text{NetRealized}_{\text{CAD}} = \text{Subtotal}_{\text{CAD}} - \text{PlatformFee}_{\text{CAD}} - \text{ShippingCost}_{\text{CAD}}$$
   * **Hard Invariant:** `taxOrVatMinor` (`13%` HST collected on `DOMESTIC_ORIGIN` sales) is tracked in a dedicated CRA HST Trust Liability counter (`RunningHstPayableTrust_CAD`) and is **NEVER** included in `netRealizedCadMinor`, donor `Vehicle` Break-Even Velocity, `AvailableWorkingCapital_CAD`, or `DistributableRealizedProfitPool_CAD` (`RULE-PAY-002`).
3. **Operator Float Reconciliation & Tiered Receipt/Voucher Policy (`HELD_IN_OPERATOR_FLOAT` & `expensePolicy`):**
   * Physical cash collected in Ontario with `cashCustodyState == 'HELD_IN_OPERATOR_FLOAT'`—comprising both taxable/non-taxable cash sales (`SaleTransaction.grossCollectedMinor`, which includes any physical HST cash handed to the operator) and cash recycler payouts (`ScrapComponentLog.payoutCadMinor`)—is tracked as an auditable petty-cash subledger balance that decreases when shop `Expense` rows are logged with `paidFromCashCustody == 'HELD_IN_OPERATOR_FLOAT'` or when physical cash is deposited into the Canadian corporate bank account via `CashCustodyTransfer` (`SETTLED_ORIGIN_CORP_BANK`):
   $$\text{RunningOperatorFloat}_{\text{CAD}} = \sum \text{SaleTransaction.grossCollectedMinor}_{\text{FLOAT}} + \sum \text{ScrapComponentLog.payoutCadMinor}_{\text{FLOAT}} - \sum \text{Expense}_{\text{paidFromFloat}} - \sum \text{CashCustodyTransfer}_{\text{FLOAT}\rightarrow\text{ORIGIN\_CORP\_BANK}}$$
   * **Tiered Receipt Verification (`ReceiptVerificationState`):**
     * `VERIFIED_RECEIPT`: Required for all expenses $> \text{pettyCashVoucherMaxCadMinor}$ ($\$50\text{ CAD}$) prior to final settlement; enforces non-empty `receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`.
     * `PETTY_CASH_VOUCHER`: Permitted for minor unreceipted cash expenses $\le \$50\text{ CAD}$ with a mandatory `voucherReason` ($\ge 5\text{ chars}$), subject to a rolling 30-day operator cap of `monthlyUnreceiptedVoucherCapCadMinor` ($\$250\text{ CAD/month}$).
     * `PENDING_RECEIPT_UPLOAD`: Temporary hold state for field expenses $> \$50\text{ CAD}$ logged with a `voucherReason` while awaiting receipt photo upload; tracked as an unverified operator float liability until transitioned to `VERIFIED_RECEIPT`.
4. **Destination Commercial Bank Cap Reconciliation (`trinidadDepositAlertThresholdTtdMinor`):**
   * Running TTD balances per Trinidadian commercial bank institution ($k$) reconcile direct buyer bank transfers, physical Vault cash deposits (`HELD_IN_DESTINATION_VAULT` $\rightarrow$ `DEPOSITED_DESTINATION_BANK`, where physical vault cash from counter sales equals $\text{grossCollectedMinor} - (\text{isBrokerCommissionDeductedAtCounter} \text{ ? } \text{brokerCommissionMinor} : 0)$) via `CashCustodyTransfer`, and outbound FX repatriation batches (`CurrencySettlement` $\rightarrow$ `SETTLED_ORIGIN_CORP_BANK`):
   $$\text{DestinationBankBalance}_{\text{Bank } k} = \sum \text{DirectWireSales}_{\text{Bank } k} + \sum \text{CashCustodyTransfer}_{\text{VAULT}\rightarrow\text{Bank } k} - \sum \text{CurrencySettlement}_{\text{From Bank } k}$$

### 4.4 5-Stream Commodity Scrap Protocol (`ScrapComponentLog`), Two-Stage Donor Cost Allocation & 3-Tier Shipment Profitability

1. **5-Stream Commodity Scrap Separation (`ScrapComponentLog`) & Two-Stage Donor Cost Allocation:**
   * Crushing an unstripped shell as mixed tin yields only `$180–$320 CAD`, whereas separating the **5 high-value scrap streams** via `salvage.ScrapComponentLog` (`CATALYTIC_CONVERTER`, `ALUMINUM_ALLOY_WHEELS`, `COPPER_WIRING_HARNESS`, `ROTORS_AND_BATTERY`, `BARE_STEEL_SHELL`) establishes a **`$550–$900 CAD` hard cash recovery floor** per donor SUV (`weightKg`, `payoutCadMinor`, `recyclerName`, `recyclerTicketStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`, and `cashCustodyState`: `SETTLED_ORIGIN_CORP_BANK` or `HELD_IN_OPERATOR_FLOAT`).
   * **Catalytic Converter Anti-Shrinkage Check (`catalyticConverterDisposition`):** Transitioning an `AUTOMOBILE` to `SCRAPPED_METAL_CLEARED` verifies whether `catalyticConverterDisposition` is reconciled (`MISSING_AT_INTAKE`, `LOGGED_SCRAP_SALE` with a matching `CATALYTIC_CONVERTER` `ScrapComponentLog`, or `SHELVED_AS_PART`). Under `complianceEnforcementMode == 'WARN_ONLY'` (Phase 1A default), an unreconciled cat **never blocks** hulk clearance—the transition succeeds and appends `'UNRECONCILED_CATALYTIC_CONVERTER'` to `Vehicle.complianceWarnings` and `AuditLog` (`422` in `'STRICT_BLOCK'`).
   * **Stage 1 — Provisional Cost Basis (At Part Strip Time):** When a part is stripped from an active donor vehicle (`DISMANTLING_IN_PROGRESS`), its initial `allocatedCostBasisCadMinor` is computed using the vehicle's acquisition price plus logged direct expenses (towing, auction buyer fees, strip labor) to date, weighted against the greater of the vehicle's target gross realization or cumulative stripped parts market value:
     $$\text{ProvisionalCostBasis}_{\text{Part}} = \left(\text{ActualPurchasePrice}_{\text{CAD}} + \text{LoggedDirectExpenses}_{\text{CAD}}\right) \times \frac{\text{GradeAdjustedMarketValue}_{\text{CAD}}}{\max\left(\text{TargetGrossRealization}_{\text{CAD}}, \sum \text{StrippedPartsMarketValue}_{\text{CAD}}\right)}$$
   * **Stage 2 — Incremental & Final Cost Basis True-Up (On Each `ScrapComponentLog` & At `SCRAPPED_METAL_CLEARED`):** `Vehicle.scrapRecoveryCadMinor` equals $\sum \text{ScrapComponentLog.payoutCadMinor}$. As each commodity stream and final hulk scale ticket is recorded, the system reconciles the exact remaining unrecovered donor cost ($\text{TotalDonorOutlay}_{\text{CAD}} - \text{ScrapRecovery}_{\text{CAD}} - \sum \text{AlreadySoldPartsAllocatedCost}_{\text{CAD}}$) pro-rata across all remaining unsold stripped parts so the accounting identity holds $100\%$:
     $$\sum_{i=1}^{n} \text{Part.allocatedCostBasisCadMinor}_i + \text{Vehicle.scrapRecoveryCadMinor} = \text{Vehicle.totalAcquisitionAndStripCostCadMinor}$$
2. **Rule `RULE-PRC-001` (Floor-Exceeds-Market Guard):**
   * During pre-auction Deal Analysis and pre-shipment Pallet Scanning, if an item's computed `vaultFloorPriceTtdMinor > brokerMarketPriceTtdMinor`, the system flags a high-visibility `MARGIN_INVERSION_WARNING` blocking export packing unless explicitly overridden by `ARCHITECT_CFO`.
3. **Tier 1 — Projected Contribution (CAD):**
   * Estimated pre-sale margin computed from `pricing-policy.json` baseline parameters (`verificationStatus == 'ESTIMATE'`) prior to container unstuffing or sale.
4. **Tier 2 — Realized Operating Profit (TTD & Equivalent CAD):**
   * Completed `SaleTransaction` revenue minus actual broker-verified landed customs duties/VAT (`verificationStatus == 'BROKER_VERIFIED'`), ocean freight, drayage, and paid broker commissions. Unsold landed Vault inventory is tracked separately as working capital at landed cost rather than expensed prematurely against sold items.
5. **Tier 3 — Repatriated Cash Return (Settled CAD):**
   * Actual hard CAD settled in the Canadian corporate bank account via `CurrencySettlement` (`totalTargetSettledMinor` net of `fxSlippageLossCadMinor`) divided by total CAD cash deployed into the shipment:
   $$\text{RepatriatedCashROI} = \frac{\sum \text{CurrencySettlement.totalTargetSettledCadMinor}}{\text{TotalDeployedShipmentCash}_{\text{CAD}}}$$

### 4.5 The 3-Rule Compensation & Piece-Rate Payout Protocol (`RULE-PAY-001` to `RULE-PAY-003`)

To prevent working-capital burn on unsupervised yard labor or premature founder draws, the subledger enforces three mathematical gates:

1. **Rule `RULE-PAY-001` (Piece-Rate Yard Stripper Payout Gate — `YARD_STRIPPER_PIECE_RATE`):**
   * Unskilled yard labor is compensated per completed vehicle (`stripperPieceRatePerVehicleCadMinor`, default `$350.00 CAD` / `$300–$400 CAD` range) rather than hourly wages.
   * A donor `Vehicle` ($v$) is eligible for a `YARD_STRIPPER_PIECE_RATE` expense payout if and only if:
     $$\text{Vehicle}_v.\text{fluidsDrainedAt} \neq \text{NULL} \quad \land \quad \left|\left\{ p \in \text{Parts}(v) \;\middle|\; p.\text{custodyState} = \text{'SHELVED\_ORIGIN\_CONTAINER'} \land |p.\text{rawPhotoUrls}| \ge 1 \right\}\right| \ge N_{\text{min\_shelved}}$$
     where $N_{\text{min\_shelved}} = 35$ (`minShelvedPartsForStripPayout` for `AUTOMOBILE`).
2. **Rule `RULE-PAY-002` (Loan Principal & HST Trust Protection — Zero Founder Salaries from Loan Facility or CRA HST):**
   * The `$44,000 CAD` Senior Secured Working Capital Loan Facility (`ActiveReleasedTrancheCapital_CAD` / `initialSeedCapitalCadMinor`) and collected 13% Ontario HST trust funds (`taxOrVatMinor` per `RULE-TAX-HST-01`) are strictly ring-fenced from founder draws (`allowFounderDrawFromSeedCapital = false`).
   * Founder profit draws (`category == 'PARTNER_PROFIT_DRAW'`) may only be disbursed when cumulative pre-HST realized net profit across completed domestic sales, 5-stream scrap recoveries (`Vehicle.scrapRecoveryCadMinor`), and repatriated export sales exceeds cumulative expenses (including accrued expenses) and prior draws:
     $$\text{DistributableRealizedProfitPool}_{\text{CAD}} = \sum \text{SaleTransaction.netRealizedCadMinor}_{\text{settled}} + \sum \text{Vehicle.scrapRecoveryCadMinor} - \sum \text{Expense.amountCadMinor}_{\text{all\_non\_voided}}$$
     $$\text{RequestedPartnerDraw}_{\text{CAD}} \le \max\left(0,\; \text{DistributableRealizedProfitPool}_{\text{CAD}}\right)$$
3. **Rule `RULE-PAY-003` (Bi-Weekly Operator Float Offset on Partner Draws):**
   * When disbursing an approved `PARTNER_PROFIT_DRAW` ($\text{DrawApproved}_{\text{CAD}}$) to `HUNTER_MECHANIC`, any positive cash balance currently held in `RunningOperatorFloat_CAD` (`HELD_IN_OPERATOR_FLOAT`) is deducted first:
     $$\text{FloatOffsetApplied}_{\text{CAD}} = \min\left(\text{DrawApproved}_{\text{CAD}},\; \max(0, \text{RunningOperatorFloat}_{\text{CAD}})\right)$$
     $$\text{NetCashDisbursedFromBank}_{\text{CAD}} = \text{DrawApproved}_{\text{CAD}} - \text{FloatOffsetApplied}_{\text{CAD}}$$

---

## 5. Part Condition Grading & Damage Code Reference

### 5.1 Mechanical Components (Engines, Transmissions, Axles, Marine Powertrains)

* **Automotive / Road Vehicles (`odometerKm`):**
  * **`GRADE_A`:** Donor odometer $< 96,560\text{ km}$ ($60,000\text{ miles}$), OR annual average $< 24,140\text{ km/year}$ ($15,000\text{ miles/year}$).
  * **`GRADE_B1`:** $96,560\text{–}321,868\text{ km}$; function-tested prior to strip and ready for bolt-on installation.
  * **`GRADE_B2`:** $96,560\text{–}321,868\text{ km}$; minor external cosmetic wear/corrosion, mechanically sound.
  * **`GRADE_B3`:** Requires minor accessory/seal repair ($< 1\text{ hour}$ labor); zero internal or structural damage.
  * **`GRADE_C`:** Operational mechanical assembly with $\ge 321,868\text{ km}$ ($200,000\text{ miles}$).
* **Watercraft / Marine Powertrains (`engineHours`):**
  * **`GRADE_A`:** $< 150\text{ engine hours}$; compression-tested and fresh-water flushed.
  * **`GRADE_B1` / `GRADE_B2`:** $150\text{–}400\text{ engine hours}$; mechanically sound (`GRADE_B1` ready for turnkey drop-in; `GRADE_B2` minor external cosmetic/salt wear).
  * **`GRADE_C`:** $> 400\text{ engine hours}$; operational high-hour marine assembly or rebuildable core.

### 5.2 Body Panels & Sheet Metal (3-Character Damage Code: `[Loc][Type][Units]`)

* **1.0 Damage Unit:** Surface area not exceeding a standard credit card ($\approx 46\text{ cm}^2$).
* **Position 1 (Location 1–9):** Standard 3x3 grid across the panel face (1 = Top-Left, 5 = Center, 9 = Bottom-Right).
* **Position 2 (Defect Type):** `D` = Dent, `S` = Scratch/Scuff, `R` = Rust, `H` = Hail, `P` = Parking Ding, `J` = Crack/Tear, `K` = Buckle, `G` = Gouge, `T` = Paint peel.
* **Position 3 (Credit-Card Units 1–9):** Count of credit-card-sized damage units (`000` = Undamaged Grade A panel).

---

## 6. Jurisdiction-Specific Compliance Dossier Checklists & `WARN_ONLY` Agility Protocol

> **Phase 1A Physical Custody Agility Invariant (`operationalGates.complianceEnforcementMode`):** When `complianceEnforcementMode == 'WARN_ONLY'` (Phase 1A default), missing paperwork or timestamps across Ontario HTA s. 60 intake, `O. Reg. 85/16` farm scans, catalytic converter hulk clearance, or DriveON SSC checkout **NEVER throws a blocking HTTP `422`**—the physical custody scan or state transition always succeeds so PostgreSQL matches physical yard reality, appending structured warning codes (`MISSING_HTA_S60_DOCS`, `COMPLIANCE_WARNING_UNDRAINED_FARM`, `UNRECONCILED_CATALYTIC_CONVERTER`, `DRIVEON_SAFETY_CERT_WARNING`) to `complianceWarnings` (`String[]`) and `AuditLog` for asynchronous CFO clearance. Switching `complianceEnforcementMode` to `'STRICT_BLOCK'` escalates all four checks to hard HTTP `422` blocks.

### 6.1 Ontario HTA Section 60 Register, DriveON 10-Day / 36-Day Timers & MTO Reg. 601 (`AUTOMOBILE` Only)

1. **Ontario *Highway Traffic Act* Section 60 Statutory Garage & Wrecking Register (`FR-INT-01`):**
   * Every `AUTOMOBILE` intake captures `acquisitionSource` (`LICENSED_AUCTION | PRIVATE_DRIVEWAY_BUY | DEALER_WHOLESALE | TRADE_IN`), `sellerFullName`, `sellerAddress`, `sellerPhotoIdStorageKey` (mandatory in `R2_PRIVATE_EVIDENCE_BUCKET` for `PRIVATE_DRIVEWAY_BUY` / `TRADE_IN`), `ontarioPermitNumber` (6–12 char MTO green-slip permit #), and `declaredStatutoryPurpose` (`WRECKING_PARTS_ONLY | RETAIL_RESALE | EXPORT_WHOLE`), powering a read-only statutory police/MTO inspection register view (`?view=hta-s60-register`).
   * Missing `sellerFullName`, `ontarioPermitNumber`, or private-seller `sellerPhotoIdStorageKey` appends `'MISSING_HTA_S60_DOCS'` in `'WARN_ONLY'` mode (or throws `422 MISSING_HTA_S60_DOCS` in `'STRICT_BLOCK'` mode).
2. **DriveON 10-Day Re-Inspection Punch-List & Deposit-Triggered 36-Day SSC (`driveOnReinspectionWindowDays = 10`, `safetyStandardsCertMaxDays = 36`):**
   * **Pre-Sale Punch-List Strategy:** Retail flip beaters (`QUICK_TURN_BEATER`) undergo an initial DriveON tablet inspection upon shop arrival (`driveOnInitialFailAt`, `driveOnFailSheetStorageKey`), automatically computing `driveOnReinspectionDeadlineAt = driveOnInitialFailAt + 10 calendar days` (`driveOnReinspectionWindowDays`) so repairs are completed inside the reduced-fee re-inspection window without starting the 36-day SSC expiration clock prematurely.
   * **Deposit-Triggered Final SSC:** The final DriveON Safety Standards Certificate (`driveOnSscIssuedAt`, `driveOnSscExpiresAt = driveOnSscIssuedAt + 36 calendar days`) is pulled once a buyer deposit is secured. At `RETAIL_LOT_VEHICLE_SALE` checkout (`FR-CHK-01`), an absent or expired SSC (`now() > driveOnSscExpiresAt`) appends `'DRIVEON_SAFETY_CERT_WARNING'` in `'WARN_ONLY'` mode (or throws `422 EXPIRED_OR_MISSING_SAFETY_CERT` in `'STRICT_BLOCK'` mode), while signed `billOfSaleStorageKey` and `paymentProofStorageKey` remain strictly mandatory.
3. **MTO Salvage-to-Rebuilt Dossier (`R.R.O. 1990, Reg. 601` — `Vehicle.rebuildDossierJson` in `R2_PRIVATE_EVIDENCE_BUCKET`):**
   * *(Paused in Year 1 unless `cfoOverride` per `dealDisciplineGate.enableHighEndRebuildLane = false`)*: `insurerRepairEstimateKey`, `preRepairDamagePhotoKeys` ($\ge 2$ colour photos), `frameBenchPhotoKey` ($\ge 1$ frame-alignment bench photo), `rebuiltPartsAuditFormKey` (itemizing donor VINs & linked `Expense` receipts), and `driveOnSicCertKey` + `driveOnSscCertKey`. *(Watercraft and Shop Equipment automatically bypass all HTA/DriveON/MTO checklists.)*

### 6.2 Trinidad & Tobago FIU & Customs Clearance Checklist

1. **Customer Due Diligence (CDD) Gate (Encrypted Private ID Storage):** Any single or linked `SaleTransaction` (`marketNode == 'DESTINATION_EXPORT_VAULT'`) where `grossCollectedMinor >= 5000000` ($\text{TT\$50,000}$) requires uploading a private scan/photo of the buyer's government ID (`buyerIdDocumentStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`), storing the AES-256-GCM application-encrypted ID type and number (`buyerIdNumberEncrypted`), and recording the buyer's full name before `isPaymentVerified` can be set to `true` (ensuring auditability upon statutory FIU inspection).
2. **Large Cash Transaction Alert:** Any single or linked cash transaction $\ge \text{TT\$90,000}$ (`9000000` minor units) triggers a mandatory FIU compliance notice to the Trinidad Vault Admin and Architect/CFO.
3. **Rule `RULE-COMP-FIU-01` (Deterministic 30-Day Rolling Window for Linked FIU Transactions):** A transaction is evaluated as **linked** if the current `SaleTransaction.grossCollectedMinor` plus the sum of `grossCollectedMinor` across all non-voided `SaleTransaction` records (`marketNode == 'DESTINATION_EXPORT_VAULT'` and `isVoidedOrReversed == false`) within a **rolling 30-calendar-day window (`createdAt >= now() - 30 days`)** matching the same `buyerPhoneE164`, normalized `lower(trim(buyerName))`, or `buyerIdNumberEncrypted` reaches or exceeds `5000000` ($\text{TT\$50,000}$) for the CDD Government ID gate, or `9000000` ($\text{TT\$90,000}$) for the Large Cash Transaction Alert.

---

## 7. Multi-Tenant Organization & Physical-Facility Location Firewall (`RULE-ZONE-001` & `RULE-ENV-001`)

**Context (`ADR-0004`):** `ORG_SALVAGE_EXPORT` and `ORG_CANNABIS_NURSERY_PROC` are two independent legal corporations operating at **completely separate physical facilities**—`ORG_SALVAGE_EXPORT` at **Kemptville, Ontario (`KEMP`)** (with **Ramsayville `RAMS`** preserved as a salvage-only shop/retail/fulfillment concept subject to operational confirmation, and **Port of Spain `POSV`** retained as a dormant future salvage-export vault), and `ORG_CANNABIS_NURSERY_PROC` exclusively at **Brockville, Ontario (`BROCK`)** (**Kemptville has zero cannabis greenhouses, nursery zones, processing rooms, or cannabis inventory**). To guarantee multi-tenant custody isolation and site-specific environmental governance (such as Ontario `O. Reg. 85/16` impermeable-surface fluid depollution rules) without brittle hardcoded location-name conditionals, every `shared.StorageLocation` record is governed by four data-driven columns: `organizationId`, `allowedOrgType`, `allowsWholeVehicleDismantling`, and `maxActiveAssetCapacity`:

* **Rules (`RULE-ZONE-001` & `RULE-ENV-001`):**
  1. **`KEMP` / `ZONE_CONTAINER_PAD` (Primary Salvage Operating Facility — Kemptville, ON, `KEMP_ZONE_CONTAINER_PAD` & `KEMP-C01-R01-S01-B01..B04`):** Owned exclusively by `ORG_SALVAGE_EXPORT` (`legalEntityName = "Ontario Salvage OpCo Inc."`, `allowedOrgType = 'SALVAGE_AND_EXPORT'`). Seeded as the primary Phase 1A salvage site with `maxActiveAssetCapacity = 4` on `KEMP_ZONE_CONTAINER_PAD` (`null` on individual `C01`–`C04` container shelf bins) and `allowsWholeVehicleDismantling = false` (configurable per verified `O. Reg. 85/16` sealed-surface fluid containment):
     * **`complianceEnforcementMode == 'WARN_ONLY'` (Phase 1A Default):** Whole-vehicle intake or shelving an undrained fluid-bearing powertrain `Part` at `KEMP` (`allowsWholeVehicleDismantling == false`) **succeeds** so physical custody truth is never lost, and `'COMPLIANCE_WARNING_UNDRAINED_FARM'` is appended to `CustodyEvent.complianceWarnings`, the target entity's `complianceWarnings`, and `AuditLog` unless `Vehicle.fluidsDrainedAt != null` (when `fluidsDrainedAt != null`, zero warning is emitted).
     * **`complianceEnforcementMode == 'STRICT_BLOCK'`:** Rejected with HTTP `422 Unprocessable Entity` (`ENVIRONMENTAL_ZONING_VIOLATION`) when `fluidsDrainedAt == null` on whole-vehicle / fluid-bearing powertrain intake into `allowsWholeVehicleDismantling == false`.
  2. **`RAMS` / `ZONE_RAMSAYVILLE_SHOP` (Salvage-Only Shop, Retail & Fulfillment Concept — Operational Status Subject to Confirmation):** Owned exclusively by `ORG_SALVAGE_EXPORT` (`allowedOrgType = 'SALVAGE_AND_EXPORT'`). Seeded (`allowsWholeVehicleDismantling = true`, `maxActiveAssetCapacity = 8`, overridable via 1-tap `cfoOverride`) for concrete bay/lot routing tests while preserving the salvage-only shop/retail architectural distinction without assuming `RAMS` is already an active operational facility.
  3. **`POSV` / `ZONE_TRINIDAD_VAULT` (Dormant/Future Salvage-Export Vault):** Owned exclusively by `ORG_SALVAGE_EXPORT` (`allowedOrgType = 'SALVAGE_AND_EXPORT'`, `allowsWholeVehicleDismantling = false`). Schema-ready and dormant until Phase 3 overseas bonded vault activation.
  4. **`BROCK` / `ZONE_BROCKVILLE_FACILITY` (Brockville Cannabis Cultivation & Processing Facility — `BROCK_SITE_FACILITY`, `BROCK-PROP-R1-T2`):** Owned exclusively by `ORG_CANNABIS_NURSERY_PROC` (`legalEntityName = "Brockville Cannabis Operations Inc."`, `allowedOrgType = 'CANNABIS_NURSERY_AND_PROCESSING'`, `allowsWholeVehicleDismantling = false`). Seeded minimally in Phase 1A (`BROCK_SITE_FACILITY` and `BROCK-PROP-R1-T2`) strictly to verify cross-tenant RLS denial and `RULE-ZONE-001` (`422 SITE_ZONING_VIOLATION`), while all functional cannabis cultivation, propagation, processing, lot genealogy, QA, and CTLS/B300 workflows remain in Phase 2B, subject to `ORG_CANNABIS_NURSERY_PROC`'s actual Health Canada licence.
  5. **Cross-Tenant & Cross-Domain Scan Hard Block (Always Enforced Regardless of `complianceEnforcementMode`):** Scanning any `salvage.Vehicle` or `salvage.Part` into a `StorageLocation` owned by another `organizationId` or where `allowedOrgType != 'SALVAGE_AND_EXPORT'`—or scanning any `cannabis.CannabisLot` into a `StorageLocation` owned by another `organizationId` or where `allowedOrgType != 'CANNABIS_NURSERY_AND_PROCESSING'`—is **ALWAYS hard-blocked** at the application and database layers (HTTP `422 Unprocessable Entity` — `SITE_ZONING_VIOLATION`).

| Site & Zone Code (`siteCode` / `zoneCode`) | Owning Legal Entity (`Organization.slug` / `legalEntityName`) | Operational Status | `allowedOrgType` | `allowsWholeVehicleDismantling` (Configurable) | `maxActiveAssetCapacity` (Configurable) | Allowed Domain Entities & Compliance Gate |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **`KEMP` / `ZONE_CONTAINER_PAD`** | `ORG_SALVAGE_EXPORT` (`"Ontario Salvage OpCo Inc."`) | **Active Primary Salvage Site (Phase 1A)** | `SALVAGE_AND_EXPORT` | `false` *(default; configurable per verified `O. Reg. 85/16` containment)* | `4` (`KEMP_ZONE_CONTAINER_PAD`) / `null` (Bins `C01`–`C04`) | `salvage.Part`, `salvage.Vehicle` — Primary Phase 1A salvage & dry container parts warehouse; whole `AUTOMOBILE` / undrained powertrain scan succeeds with `COMPLIANCE_WARNING_UNDRAINED_FARM` in `WARN_ONLY` unless `fluidsDrainedAt != null` (`422` in `STRICT_BLOCK`). |
| **`RAMS` / `ZONE_RAMSAYVILLE_SHOP`** | `ORG_SALVAGE_EXPORT` (`"Ontario Salvage OpCo Inc."`) | **Salvage-Only Concept (Seeded for Concrete Routing Tests; Subject to Verification)** | `SALVAGE_AND_EXPORT` | `true` | `8` (Shop + Lot) | `salvage.Vehicle`, `salvage.Part` — Seeded for concrete bay/lot routing tests (`maxActiveAssetCapacity = 8`, 1-tap `cfoOverride`); operational status subject to confirmation. |
| **`POSV` / `ZONE_TRINIDAD_VAULT`** | `ORG_SALVAGE_EXPORT` (`"Ontario Salvage OpCo Inc."`) | **Dormant / Future Export Capability (Phase 3)** | `SALVAGE_AND_EXPORT` | `false` | `null` | `salvage.Vehicle`, `salvage.Part` — Dormant Phase 3 bonded warehouse in Port of Spain; weekly blind cycle counts (`FR-VLT-05`). |
| **`BROCK` / `ZONE_BROCKVILLE_FACILITY`** | `ORG_CANNABIS_NURSERY_PROC` (`"Brockville Cannabis Operations Inc."`) | **Planned Cannabis Facility (Phase 2B; Minimal Seed in Phase 1A for RLS/`RULE-ZONE-001` Tests)** | `CANNABIS_NURSERY_AND_PROCESSING` | `false` | `null` | `cannabis.CannabisLot` — Seeded (`BROCK_SITE_FACILITY`, `BROCK-PROP-R1-T2`) in Phase 1A strictly to test cross-tenant RLS denial & `422 SITE_ZONING_VIOLATION`; functional cannabis workflows in Phase 2B, subject to actual Health Canada licence. |

---

### 7.1 Shared Software QR Hang-Tag & Cold-Chain Container Labelling Standard (`RULE-TAG-001` / `ADR-0002` / `ADR-0004`)

> **Shared Software, Separate Physical Consumables (`ADR-0004`):** `ILabelTagPort` (`src/modules/shared-ops`) is a reusable software generator shared across tenants. `ORG_SALVAGE_EXPORT` (at Kemptville `KEMP`) and `ORG_CANNABIS_NURSERY_PROC` (at Brockville `BROCK`) procure, print, and apply their own physical label stock on their own separate laser/thermal printers.

1. **Matte 10-MIL Synthetic Laser Hang-Tag Sheets Over Adhesive Thermal Stickers:**
   * Direct-thermal labels blacken on contact with heat, motor oil, or brake cleaner, while industrial adhesive stickers fail to bond below $+10^\circ\text{C}$ and curl off small curved castings, sensors, wiring harnesses, and marine parts in unheated $-30^\circ\text{C}$ Kemptville containers (`KEMP-C01`–`C04`).
   * Primary Day-1 tagging software output for both `ORG_SALVAGE_EXPORT` (`PRT-XXXXXX`, `AST-YYYY-XXXX`, `PLT-YYYY-XXX`, `KEMP-C01-*`) and `ORG_CANNABIS_NURSERY_PROC` (`LOT-YYYY-XXXX` mother plants, clone trays, and harvest bins at `BROCK-*`) targets **matte `10-MIL` (`120 lb` cover) waterproof synthetic laser sheets (`8.5" × 11"` Letter, e.g., TerraSlate)** printed exclusively with **fused laser toner** (never inkjet ink) in **`3×4` (12-up)** or **`4×4` (16-up, $2.125" \times 2.75"$)** batch PDF/SVG grids (`300–400` tags per 25-sheet pack; zero glossy PVC pouches required).
2. **Slot-Punch & `-40°C` Black UV Zip-Tie Fastening Rule:**
   * Single-hang tags (`PRT-XXXXXX`, `LOT-YYYY-XXXX`) include a pre-marked **$15\text{mm} \times 4\text{mm}$ oval PVC badge slot-punch guide**; container rack bin cards (`KEMP-C01-R01-S01-B01`) include **dual top punch guides** to zip-tie directly to steel rack uprights (or slide into magnetic C-channels) so bin barcodes never peel off in winter.
   * Tags are fastened exclusively with **Black UV-Stabilized Nylon 6/6 Zip Ties rated to $-40^\circ\text{C}$** ($4"$–$12"$ assorted ties looped through sensor pigtails, bolt holes, or painted door/hood/tailgate latch strikers for zero paint residue; heavy-duty $14"$ ties for engines, transmissions, and subframes). Standard white nylon zip ties are prohibited in unheated outdoor/container zones due to brittle fracture below $-20^\circ\text{C}$.
3. **Dark-Container Camera Scan Geometry (`@zxing/browser`):**
   * Every printed tag renders a high-contrast QR matrix **$\ge 1.5" \times 1.5"$ ($38\text{mm} \times 38\text{mm}$, Error Correction Level `M` or `Q`)** with a **$\ge 4$-module white quiet zone** on matte glare-free stock so mobile camera flash inside unlit sea cans locks on instantly without specular reflection. Zebra ZPL II output remains available as a secondary adapter format for Vertical-SaaS tenants and Phase 2A/3 $4" \times 6"$ parcel shipping labels.

## 8. Brockville Cannabis Mass-Balance, Extraction Yield & CTLS Category Rules (`RULE-CAN-001`)

**Context:** Applies exclusively to **`ORG_CANNABIS_NURSERY_PROC`** at the **Brockville, Ontario (`BROCK`)** facility, subject to the corporation's actual Health Canada licence class(es) and authorized activities. Where cultivation, propagation, curing, or processing activities are authorized under the active licence, Health Canada's Cannabis Tracking and Licensing System (CTLS) and the Canada Revenue Agency (CRA Form B300, where excise-applicable) require gram-accurate monthly reconciliation across active lot stages.

### 8.1 Mass-Balance Reconciliation & Automatic QAP Alert Rules (`RULE-CAN-001`)

1. **Gram-Accurate Mass-Balance Equation:**
   Every processing or curing transformation (`CannabisLotTransformation`) must satisfy:
   $$\text{InputWeight}_{\text{g}} = \text{OutputWeight}_{\text{g}} + \text{MoistureLoss}_{\text{g}} + \text{WasteDestroyed}_{\text{g}} + \text{UnaccountedVariance}_{\text{g}}$$
2. **Wet-to-Dry Curing Moisture Loss Tolerance (`wetToDryMoistureLossMinPct` / `MaxPct`):**
   * When transforming `FRESH_HARVEST` into `DRIED_FLOWER` and `TRIM_BIOMASS`, expected water weight loss is **`72.0%`–`80.0%`** of `inputWeightGrams` (yielding `20.0%`–`28.0%` dry biomass). Curing runs outside this band require a QAP review note.
3. **Extraction & Refinement Yield Ranges ("Moving the Juice"):**
   * **Primary Extraction (`DRIED_FLOWER` / `TRIM_BIOMASS` $\rightarrow$ `CRUDE_EXTRACT`):** Expected yield range of **`10.0%`–`25.0%`** of input biomass weight; spent raffinate/biomass must be logged under `wasteDestroyedGrams` and linked to a dual-witness `CannabisDestructionLog`.
   * **Distillation / Isolation (`CRUDE_EXTRACT` $\rightarrow$ `DISTILLATE_OR_ISOLATE`):** Expected yield range of **`65.0%`–`88.0%`** of crude input weight.
4. **Automatic QAP Variance Hold (`maxUnaccountedVarianceAlertPct = 2.0%`):**
   * Whenever unaccounted processing variance exceeds **`2.0%`** of input weight:
     $$\frac{|\text{UnaccountedVariance}_{\text{g}}|}{\text{InputWeight}_{\text{g}}} > 0.020$$
   * The system automatically sets `CannabisLotTransformation.varianceAlertFlagged = true`, places the target `CannabisLot` into `complianceHold = true`, and blocks outbound transfer or sale until `CANNABIS_QAP_COMPLIANCE` signs off (`verifiedByQapUserId`).

### 8.2 Canonical Health Canada CTLS & CRA B300 Stage Mapping

| `CannabisLotStage` | `trackingUnit` | CTLS Monthly Reporting Category | Mandatory Compliance & Quality Gate |
| :--- | :---: | :--- | :--- |
| **`MOTHER_PLANT`** | `PLANTS` | Vegetative Cannabis Plants | Bound to `CannabisStrain`; parent source for `CLONE_TRAY` batches. |
| **`CLONE_TRAY`** | `PLANTS` | Vegetative Cannabis Plants | Spawned via 3-Tap Mother scan (`FR-CAN-01`); 10-MIL synthetic laser QR tray tag (or optional ZPL label) printed. |
| **`VEGETATIVE_BATCH`** | `PLANTS` | Vegetative Cannabis Plants | Tracked by plant count; any culled plants require dual-witness `CannabisDestructionLog`. |
| **`FRESH_HARVEST`** | `GRAMS` | Whole Cannabis Plants / Fresh Cannabis | Wet harvest weight recorded immediately upon chop prior to drying room hang. |
| **`DRIED_FLOWER`** | `GRAMS` | Dried Cannabis | Reconciled against `FRESH_HARVEST` (`72%–80%` moisture loss); requires `labCoaStorageKey` for release. |
| **`TRIM_BIOMASS`** | `GRAMS` | Dried Cannabis (Trim / Shake) | Input feedstock for extraction ("moving the juice"). |
| **`CRUDE_EXTRACT`** | `GRAMS` | Cannabis Extracts (Unrefined) | Reconciled against input biomass + spent raffinate destruction log. |
| **`DISTILLATE_OR_ISOLATE`** | `GRAMS` | Cannabis Extracts (Refined) | Requires private R2 Lab CoA PDF (`labCoaStorageKey`) and `complianceHold == false` prior to B2B transfer. |
