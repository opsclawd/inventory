# DOMAIN-RULES.md — Configurable Policy, Tariff, Compatibility & Grading Register

## 1. Architectural Rule: Configuration vs. Code Invariants

To prevent regulatory or market changes from requiring code deployments, the system strictly separates **Hard Code Invariants** from **Versioned Policy Parameters**:

* **Hard Code Invariants (Enforced in TypeScript Entities / DB Triggers):** Two-phase eBay export locking (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`), append-only financial/audit records, strict separation of Vault Admin COD verification from sales brokers, and single-use HMAC gate pass consumption.
* **Configurable Policy Parameters (Stored in `src/core/config/` or `SystemPolicy` DB Table):** Customs duty percentages, VAT rates, shadow FX multipliers, LHD/RHD part-category mappings, ARA grading multipliers, and jurisdiction-specific document checklists.

---

## 2. LHD vs. RHD Part Compatibility Matrix (Ontario Donor -> Trinidad Market)

**Context:** Donor vehicles acquired in Ontario are Left-Hand Drive (`LHD_ONLY`), whereas Trinidad & Tobago and Barbados operate predominantly Right-Hand Drive (`RHD_ONLY`) fleets (alongside universal marine watercraft).

* **Rule (`RULE-FIT-001`):** Any stripped automotive part must be assigned a `SteeringSideCompatibility` enum (`UNIVERSAL`, `LHD_ONLY`, `RHD_ONLY`) based on its `partCategoryName` default below, unless explicitly overridden by a human reviewer or matched to a verified LHD Caribbean buyer wish-list. **Important Fitment Clarification:** `UNIVERSAL` indicates **steering-side geometry neutrality only** (i.e., the part is not physically mirrored between LHD and RHD cockpits/firewalls); it does **not** bypass OEM part-number or Hollander/interchange fitment verification across trim, engine, or model-year variants.
* **Rule (`RULE-FIT-002`):** Parts flagged `LHD_ONLY` are automatically routed to **Domestic North American Channels (eBay Motors)** and blocked from being scanned onto a Trinidad LCL/FCL export pallet unless an explicit `PreOrderWishList` override exists.

| Part Category (`partCategoryName`) | Default `SteeringSideCompatibility` | Export Eligibility (Trinidad / Barbados) | Notes / Physics & Fitment Rationale |
| :--- | :--- | :--- | :--- |
| **Complete Engine Assembly** | `UNIVERSAL` | **Eligible** | Long-block and manifolds cross over; check harness/ECU pins. |
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

---

## 3. Harmonized System (HS) Tariff & Customs Valuation Register

**Rule (`RULE-CUST-001`):** AI-suggested HS codes (`Part.suggestedHsCode`) are **assistive proposals only**. For commercial customs filing, the licensed customs broker confirms `Part.brokerVerifiedHsCode`.
**Rule (`RULE-CUST-002`):** CBSA CERS export declarations are mandatory for commercial goods valued $\ge \text{CAD } \$2,000$ destined outside the US, and **mandatory for all permanently exported conveyances (vehicles and watercraft) regardless of dollar value**, submitted $\ge 48\text{ hours}$ prior to marine vessel loading.

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

All configurable parameters live in `src/core/config/pricing-policy.json` and can be updated via the CFO Dashboard after each shipment clears customs.

### 4.1 Configurable Financial Parameters (Initial Defaults)

```json
{
  "metadata": {
    "verificationStatus": "ESTIMATE",
    "effectiveDate": "2026-10-21",
    "source": "Initial Shipment #1 Baseline (Updated to BROKER_VERIFIED upon customs assessment)",
    "approvedBy": "ARCHITECT_CFO"
  },
  "fxRates": {
    "cadToUsdSpot": 0.73,
    "usdToTtdOfficialCustoms": 6.78297,
    "usdToTtdShadowRepatriation": 7.35
  },
  "trinidadImportTax": {
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
  "domesticChannelFees": {
    "OTTAWA_WALK_IN_CASH": 0.0,
    "FB_MARKETPLACE_LOCAL": 0.0,
    "KIJIJI_LOCAL": 0.0,
    "RAMSAYVILLE_LOT_RETAIL": 0.0,
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
    "cbsaMarineCutoffHours": 48
  }
}
```

### 4.2 Landed Cost & Trinidad Vault COD Floor Formula

1. **CIF Valuation (USD):**
   $$\text{CIF}_{\text{USD}} = \text{FOB}_{\text{USD}} + (\text{Weight}_{\text{kg}} \times C_{\text{freight\_per\_kg}}) + (\text{FOB}_{\text{USD}} \times r_{\text{ins}})$$
2. **Assessed Trinidad Customs Duty & Compounded VAT (TTD):**
   * Note: Customs assesses CIF in TTD using the **Official Customs Rate** ($\approx 6.78297$), whereas VAT ($12.5\%$) is compounded on ($\text{CIF} + \text{Duty} + \text{Processing Fee}$).
   $$\text{CIF}_{\text{TTD}} = \text{CIF}_{\text{USD}} \times \text{FX}_{\text{official}}$$
   $$\text{DutyAndFees}_{\text{TTD}} = \text{CIF}_{\text{TTD}} \times (r_{\text{duty}} + r_{\text{proc}})$$
   $$\text{VAT}_{\text{TTD}} = (\text{CIF}_{\text{TTD}} + \text{DutyAndFees}_{\text{TTD}}) \times r_{\text{VAT}}$$
   $$\text{TotalTaxesAndFreight}_{\text{TTD}} = \text{DutyAndFees}_{\text{TTD}} + \text{VAT}_{\text{TTD}} + (\text{FreightAndIns}_{\text{USD}} \times \text{FX}_{\text{shadow}})$$
3. **Minimum Vault COD Floor Price (TTD) — Markup vs. Realized Margin Clarification:**
   * Note: `targetExportMarkupOnCost` ($0.65$) represents a **$65\%$ markup on allocated cost** (equivalent to a $39.4\%$ gross margin on pre-tax wholesale price before unallocated yard overhead), which is distinct from realized net margin after landed taxes, FX slippage, and broker commissions.
   * Protects Canadian principal against parallel-market FX spread ($\text{FX}_{\text{shadow}}$) and holds back the broker's $10\%$ referral commission:
   $$\text{VaultFloor}_{\text{TTD}} = \frac{\left(\text{AllocatedCost}_{\text{CAD}} \times (1 + \text{TargetMarkup}_{\text{export}}) \times \text{FX}_{\text{CAD}\rightarrow\text{USD}} \times \text{FX}_{\text{shadow}}\right) + \text{TotalTaxesAndFreight}_{\text{TTD}}}{1 - r_{\text{comm}}}$$

### 4.3 Domestic Net Realization & Shop Float Reconciliation Formula

1. **Domestic Channel Fee & Net Realization (`netRealizedCadMinor`):**
   * Local Ontario cash/e-Transfer channels (`OTTAWA_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RAMSAYVILLE_LOT_RETAIL`, `WHOLESALE_MECHANIC_NETWORK`) incur $0\%$ platform fees ($r_{\text{channel\_fee}} = 0.0$), whereas `EBAY_MOTORS_SHIPPED` deducts $13.25\%$ ($r_{\text{channel\_fee}} = 0.1325$) plus outbound courier label costs:
   $$\text{PlatformFee}_{\text{CAD}} = \text{round}\left(\text{Subtotal}_{\text{CAD}} \times r_{\text{channel\_fee}}\right)$$
   $$\text{NetRealized}_{\text{CAD}} = \text{GrossCollected}_{\text{CAD}} - \text{PlatformFee}_{\text{CAD}} - \text{ShippingCost}_{\text{CAD}}$$
   * `netRealizedCadMinor` is credited directly toward the donor `Vehicle` Break-Even Velocity counter and the $20\text{k CAD}$ Working Capital Buffer.
2. **Taz's Ontario Shop Float Reconciliation (`HELD_BY_TAZ_FLOAT`):**
   * Cash collected in Ontario with `cashCustodyState == 'HELD_BY_TAZ_FLOAT'` is tracked as an auditable petty-cash subledger balance that decreases when shop `Expense` receipts are logged with `paidFromCashCustody == 'HELD_BY_TAZ_FLOAT'` or when cash is deposited into the Canadian corporate bank account (`SETTLED_CANADA_BANK`):
   $$\text{RunningFloat}_{\text{CAD}} = \sum \text{CashSales}_{\text{HELD\_BY\_TAZ\_FLOAT}} - \sum \text{Expenses}_{\text{paidFromFloat}} - \sum \text{FloatBankDeposits}_{\text{CAD}}$$

### 4.4 Donor Cost Reconciliation & 3-Tier Shipment Profitability

1. **Donor Cost Allocation Invariant:**
   * Across every dismantled donor `Vehicle`, the sum of allocated part cost bases plus scrap metal recovery value and any retained hull/shell value must reconcile 100% with the donor vehicle's total acquisition and dismantling cost:
   $$\sum \text{Part.allocatedCostBasisCadMinor} + \text{ScrapRecoveryValue}_{\text{CAD}} + \text{RetainedHullValue}_{\text{CAD}} = \text{Vehicle.totalAcquisitionAndStripCost}_{\text{CAD}}$$
2. **Tier 1 — Projected Contribution (CAD):**
   * Estimated pre-sale margin computed from `pricing-policy.json` baseline parameters (`verificationStatus == 'ESTIMATE'`) prior to container unstuffing or sale.
3. **Tier 2 — Realized Operating Profit (TTD & Equivalent CAD):**
   * Completed `SaleTransaction` revenue minus actual broker-verified landed customs duties/VAT (`verificationStatus == 'BROKER_VERIFIED'`), ocean freight, drayage, and paid broker commissions. Unsold landed Vault inventory is tracked separately as working capital at landed cost rather than expensed prematurely against sold items.
4. **Tier 3 — Repatriated Cash Return (Settled CAD):**
   * Actual hard CAD settled in the Canadian corporate bank account via `CurrencySettlement` (`totalTargetSettledMinor` net of `fxSlippageLossCadMinor`) divided by total CAD cash deployed into the shipment:
   $$\text{RepatriatedCashROI} = \frac{\sum \text{CurrencySettlement.totalTargetSettledCadMinor}}{\text{TotalDeployedShipmentCash}_{\text{CAD}}}$$

## 5. Part Condition Grading & Damage Code Reference

### 5.1 Mechanical Components (Engines, Transmissions, Axles, Marine Powertrains)

* **`GRADE_A`:** Donor odometer $< 96,560\text{ km}$ ($60,000\text{ miles}$), OR annual average $< 24,140\text{ km/year}$ ($15,000\text{ miles/year}$).
* **`GRADE_B1`:** $96,560\text{–}321,868\text{ km}$; function-tested prior to strip and ready for bolt-on installation.
* **`GRADE_B2`:** $96,560\text{–}321,868\text{ km}$; minor external cosmetic wear/corrosion, mechanically sound.
* **`GRADE_B3`:** Requires minor accessory/seal repair ($< 1\text{ hour}$ labor); zero internal or structural damage.
* **`GRADE_C`:** Operational mechanical assembly with $\ge 321,868\text{ km}$ ($200,000\text{ miles}$).

### 5.2 Body Panels & Sheet Metal (3-Character Damage Code: `[Loc][Type][Units]`)

* **1.0 Damage Unit:** Surface area not exceeding a standard credit card ($\approx 46\text{ cm}^2$).
* **Position 1 (Location 1–9):** Standard 3x3 grid across the panel face (1 = Top-Left, 5 = Center, 9 = Bottom-Right).
* **Position 2 (Defect Type):** `D` = Dent, `S` = Scratch/Scuff, `R` = Rust, `H` = Hail, `P` = Parking Ding, `J` = Crack/Tear, `K` = Buckle, `G` = Gouge, `T` = Paint peel.
* **Position 3 (Credit-Card Units 1–9):** Count of credit-card-sized damage units (`000` = Undamaged Grade A panel).

## 6. Jurisdiction-Specific Compliance Dossier Checklists

### 6.1 Ontario MTO Salvage-to-Rebuilt File (`R.R.O. 1990, Reg. 601` — Automobiles Only)

Stored in `Vehicle.rebuildDossierJson` with private file keys in `R2_PRIVATE_EVIDENCE_BUCKET`:

1. **`insurerRepairEstimateKey`:** Mandatory insurance company repair estimate (or authorized appraiser estimate).
2. **`preRepairDamagePhotoKeys`:** Minimum **2 colour photographs** showing damaged front/rear and both sides prior to any repair work.
3. **`frameBenchPhotoKey`:** Minimum **1 colour photograph** of the vehicle mounted on the structural frame-alignment bench in Ramsayville.
4. **`rebuiltPartsAuditFormKey`:** Completed MTO Rebuilt Vehicle Parts Audit Form itemizing every major replacement assembly with its donor VIN and linked `Expense` receipt.
5. **`driveOnSicCertKey` & `driveOnSscCertKey`:** Issued Structural Inspection Certificate (SIC) and Safety Standards Certificate (SSC, valid strictly for **36 calendar days** from `driveOnSscIssuedAt`). *(Note: Watercraft and Shop Equipment automatically bypass this checklist.)*

### 6.2 Trinidad & Tobago FIU & Customs Clearance Checklist

1. **Customer Due Diligence (CDD) Gate:** Any single or linked `SaleTransaction` (`marketNode == 'TRINIDAD_VAULT'`) where `grossCollectedMinor >= 5000000` ($\text{TT\$50,000}$) requires capturing the buyer's government ID reference (`buyerNationalIdHash`) and full name before `isPaymentVerified` can be set to `true`.
2. **Large Cash Transaction Alert:** Any cash transaction $\ge \text{TT\$90,000}$ triggers a mandatory FIU compliance notice to the Trinidad Vault Admin and Architect/CFO.

