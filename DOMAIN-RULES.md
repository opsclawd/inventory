# DOMAIN-RULES.md — Configurable Policy, Tariff, Compatibility & Grading Register


## 1. Architectural Rule: Configuration vs. Code Invariants

To prevent regulatory or market changes from requiring code deployments, the system strictly separates **Hard Code Invariants** from **Versioned Policy Parameters**[span_4](start_span)[span_4](end_span):

* **Hard Code Invariants (Enforced in TypeScript Entities / DB Triggers):** Two-phase eBay export locking (`EXPORT_LOCK_PENDING` -> `EXPORT_LOCK_CONFIRMED`)[span_5](start_span)[span_5](end_span), append-only financial/audit records[span_6](start_span)[span_6](end_span)[span_7](start_span)[span_7](end_span), strict separation of Vault Admin COD verification from sales brokers[span_8](start_span)[span_8](end_span)[span_9](start_span)[span_9](end_span), and single-use HMAC gate pass consumption[span_10](start_span)[span_10](end_span)[span_11](start_span)[span_11](end_span).
* **Configurable Policy Parameters (Stored in `src/core/config/` or `SystemPolicy` DB Table):** Customs duty percentages, VAT rates, shadow FX multipliers, LHD/RHD part-category mappings, ARA grading multipliers, and jurisdiction-specific document checklists[span_12](start_span)[span_12](end_span)[span_13](start_span)[span_13](end_span)[span_14](start_span)[span_14](end_span).

---

## 2. LHD vs. RHD Part Compatibility Matrix (Ontario Donor -> Trinidad Market)

**Context:** Donor vehicles acquired in Ontario are Left-Hand Drive (`LHD_ONLY`), whereas Trinidad & Tobago and Barbados operate predominantly Right-Hand Drive (`RHD_ONLY`) fleets (alongside universal marine watercraft)[span_15](start_span)[span_15](end_span)[span_16](start_span)[span_16](end_span).

* **Rule (`RULE-FIT-001`):** Any stripped automotive part must be assigned a `DriveSideCompatibility` enum (`UNIVERSAL`, `LHD_ONLY`, `RHD_ONLY`) based on its `partCategoryName` default below, unless explicitly overridden by a human reviewer or matched to a verified LHD Caribbean buyer wish-list[span_17](start_span)[span_17](end_span).
* **Rule (`RULE-FIT-002`):** Parts flagged `LHD_ONLY` are automatically routed to **Domestic North American Channels (eBay Motors)** and blocked from being scanned onto a Trinidad LCL/FCL export pallet unless an explicit `PreOrderWishList` override exists[span_18](start_span)[span_18](end_span)[span_19](start_span)[span_19](end_span).

| Part Category (`partCategoryName`) | Default `DriveSideCompatibility` | Export Eligibility (Trinidad / Barbados) | Notes / Physics & Fitment Rationale |
| :--- | :--- | :--- | :--- |
| **Complete Engine Assembly** | `UNIVERSAL` | **Eligible** | Long-block and manifolds cross over; check harness/ECU pins[span_20](start_span)[span_20](end_span). |
| **Transmission / Gearbox / Transaxle** | `UNIVERSAL` | **Eligible** | Direct mechanical crossover[span_21](start_span)[span_21](end_span). |
| **Front Bumpers, Hoods, Fenders, Grilles** | `UNIVERSAL` | **Eligible** | High-velocity collision sheet metal for 2021–2022 Kia/Hyundai/Mazda[span_22](start_span)[span_22](end_span)[span_23](start_span)[span_23](end_span). |
| **Complete Doors (Shell, Glass, Latch)** | `UNIVERSAL` | **Eligible (Shell)** | Physical door shells & glass are symmetric; **Note:** Master window switch bezel is LHD/RHD specific[span_24](start_span)[span_24](end_span). |
| **Rear Clips, Tailgates, Rear Bumpers, Taillights** | `UNIVERSAL` | **Eligible** | Fully symmetrical across LHD and RHD SUVs[span_25](start_span)[span_25](end_span)[span_26](start_span)[span_26](end_span). |
| **Suspension (Struts, Control Arms, Knuckles, Axles)** | `UNIVERSAL` | **Eligible** | High demand due to Caribbean road conditions[span_27](start_span)[span_27](end_span)[span_28](start_span)[span_28](end_span). |
| **A/C Compressors, Condensers, Radiators, Alternators** | `UNIVERSAL` | **Eligible** | Direct accessory bolt-on crossover[span_29](start_span)[span_29](end_span). |
| **Watercraft / Marine Assemblies (Rotax / Yamaha)** | `UNIVERSAL` | **Eligible** | Personal watercraft and jet boats have no LHD/RHD distinction[span_30](start_span)[span_30](end_span)[span_31](start_span)[span_31](end_span). |
| **Steering Rack, Steering Column, Intermediate Shaft** | `LHD_ONLY` | **Blocked (eBay Only)** | Physically mirrored casting; will not bolt into RHD firewall/subframe[span_32](start_span)[span_32](end_span). |
| **Dashboard Assembly, Center Console, Glovebox** | `LHD_ONLY` | **Blocked (eBay Only)** | Molded specifically for left-side driver cockpit[span_33](start_span)[span_33](end_span). |
| **Front Headlamps (Halogen / LED Projector)** | `LHD_ONLY` | **Restricted (Warn)** | Beam cutoff pattern is angled for right-hand traffic (LHT vs RHT); export only if buyer explicitly accepts LHD beam pattern[span_34](start_span)[span_34](end_span). |
| **Windshield Wiper Linkage, Cowl & Motor** | `LHD_ONLY` | **Blocked (eBay Only)** | Sweep geometry and pivot mounts are mirrored for LHD driver visibility[span_35](start_span)[span_35](end_span). |
| **Brake Booster, Master Cylinder & Pedal Box** | `LHD_ONLY` | **Blocked (eBay Only)** | Firewall mounting and brake line routing are side-specific[span_36](start_span)[span_36](end_span). |

---

## 3. Harmonized System (HS) Tariff & Customs Valuation Register

**Rule (`RULE-CUST-001`):** AI-suggested HS codes (`Part.suggestedHsCode`) are **assistive proposals only**[span_37](start_span)[span_37](end_span)[span_38](start_span)[span_38](end_span). For commercial customs filing, the licensed customs broker confirms `Part.brokerVerifiedHsCode`[span_39](start_span)[span_39](end_span)[span_40](start_span)[span_40](end_span).
**Rule (`RULE-CUST-002`):** CBSA CERS export declarations are mandatory for commercial goods valued $\ge \text{CAD } \$2,000$ destined outside the US, and **mandatory for all permanently exported conveyances (vehicles and watercraft) regardless of dollar value**, submitted $\ge 48\text{ hours}$ prior to marine vessel loading[span_41](start_span)[span_41](end_span)[span_42](start_span)[span_42](end_span).

| Asset / Part Category | Default HS Subheading | Default Trinidad CET Duty Rate (Configurable) | Trinidad VAT Rate (Compounded) | Mandatory Environmental & Hazmat Gate |
| :--- | :--- | :--- | :--- | :--- |
| **Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)** | `8903.99` | `20.0%` – `30.0%` *(Verify per hull)* | `12.5%` | Wash/steam clean hull & bilge; drain fuel; permanent conveyance CERS report with 12-char HIN[span_43](start_span)[span_43](end_span)[span_44](start_span)[span_44](end_span). |
| **Shop Equipment (A/C Recharge Machine)** | `8479.89` | `0.0%` – `10.0%` *(Industrial machinery)* | `12.5%` | Internal recovery tank must be evacuated of pressurized refrigerant gas prior to ocean transit[span_45](start_span)[span_45](end_span)[span_46](start_span)[span_46](end_span). |
| **Complete Spark-Ignition Engines (>1000cc)** | `8407.34` | `25.0%` – `30.0%` | `12.5%` | Drain 100% of motor oil and coolant; cap ports; log engine serial number[span_47](start_span)[span_47](end_span). |
| **Bumpers & Parts Thereof** | `8708.10` | `30.0%` | `12.5%` | Clean surface; wrap sharp corners[span_48](start_span)[span_48](end_span). |
| **Body Panels, Doors, Hoods, Fenders** | `8708.29` | `30.0%` | `12.5%` | Clean surface; record 3-char damage code[span_49](start_span)[span_49](end_span). |
| **Brakes & Servo-Brakes** | `8708.30` | `30.0%` | `12.5%` | Drain all brake fluid; cap hydraulic ports[span_50](start_span)[span_50](end_span). |
| **Gearboxes / Transmissions** | `8708.40` | `30.0%` | `12.5%` | Drain 100% of ATF/gear oil; cap cooler lines[span_51](start_span)[span_51](end_span). |
| **Drive-Axles & Differentials** | `8708.50` | `30.0%` | `12.5%` | Drain differential gear oil[span_52](start_span)[span_52](end_span). |
| **Road Wheels & Rims** | `8708.70` | `30.0%` | `12.5%` | Visual crack/distortion inspection mandatory; cracked wheels must be scrapped, never sold[span_53](start_span)[span_53](end_span). |
| **Suspension Shock Absorbers & Struts** | `8708.80` | `30.0%` | `12.5%` | Inspect for hydraulic leaks[span_54](start_span)[span_54](end_span). |
| **Radiators & Cooling Systems** | `8708.91` | `30.0%` | `12.5%` | Drain coolant completely; cap ports[span_55](start_span)[span_55](end_span). |
| **Safety Airbags & Pyrotechnic Pretensioners** | `8708.95` | `30.0%` | `12.5%` | **QUARANTINED BY DEFAULT (`isHazmatOrAirbag = true`)**: Requires VIN recall check + Class 9 DG (`UN3268`) certification. **Excluded from LCL Shipment #1**[span_56](start_span)[span_56](end_span)[span_57](start_span)[span_57](end_span)[span_58](start_span)[span_58](end_span). |
| **Other Auto Parts (ECUs, Sensors, Alternators, Starters)** | `8708.99` | `30.0%` | `12.5%` | Store in dry bin; protect connectors[span_59](start_span)[span_59](end_span). |

---

## 4. Algorithmic Pricing, Landed Cost & FX Reserve Formulas

All configurable parameters live in `src/core/config/pricing-policy.json` and can be updated via the CFO Dashboard after each shipment clears customs[span_60](start_span)[span_60](end_span)[span_61](start_span)[span_61](end_span).

### 4.1 Configurable Financial Parameters (Initial Defaults)

```json
{
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

1. **CIF Valuation (USD):**`\text{CIF}_{\text{USD}} = \text{FOB}_{\text{USD}} + (\text{Weight}_{\text{kg}} \times C_{\text{freight\_per\_kg}}) + (\text{FOB}_{\text{USD}} \times r_{\text{ins}})`
2. **Assessed Trinidad Customs Duty & Compounded VAT (TTD):**
   * Note: Customs assesses CIF in TTD using the **Official Customs Rate** (\\approx 6.78297), whereas VAT (12.5\\%) is compounded on (\\text{CIF} + \\text{Duty} + \\text{Processing Fee}).`\text{CIF}_{\text{TTD}} = \text{CIF}_{\text{USD}} \times \text{FX}_{\text{official}}`​`\text{DutyAndFees}_{\text{TTD}} = \text{CIF}_{\text{TTD}} \times (r_{\text{duty}} + r_{\text{proc}})`​`\text{VAT}_{\text{TTD}} = (\text{CIF}_{\text{TTD}} + \text{DutyAndFees}_{\text{TTD}}) \times r_{\text{VAT}}`​`\text{TotalTaxesAndFreight}_{\text{TTD}} = \text{DutyAndFees}_{\text{TTD}} + \text{VAT}_{\text{TTD}} + (\text{FreightAndIns}_{\text{USD}} \times \text{FX}_{\text{shadow}})`
3. **Minimum Vault COD Floor Price (TTD):**
   * Protects Canadian principal against parallel-market FX spread (\\text{FX}\_{\\text{shadow}}) and holds back the broker's 10\\% referral commission:`\text{VaultFloor}_{\text{TTD}} = \frac{\left(\text{AllocatedCost}_{\text{CAD}} \times (1 + \text{TargetMargin}_{\text{export}}) \times \text{FX}_{\text{CAD}\rightarrow\text{USD}} \times \text{FX}_{\text{shadow}}\right) + \text{TotalTaxesAndFreight}_{\text{TTD}}}{1 - r_{\text{comm}}}`

## 5. Part Condition Grading & Damage Code Reference

### 5.1 Mechanical Components (Engines, Transmissions, Axles, Marine Powertrains)

* **`GRADE_A`:** Donor odometer < 96,560\\text{ km} (60,000\\text{ miles}), OR annual average < 24,140\\text{ km/year} (15,000\\text{ miles/year}).
* **`GRADE_B1`:** 96,560\\text{–}321,868\\text{ km}; function-tested prior to strip and ready for bolt-on installation.
* **`GRADE_B2`:** 96,560\\text{–}321,868\\text{ km}; minor external cosmetic wear/corrosion, mechanically sound.
* **`GRADE_B3`:** Requires minor accessory/seal repair (< 1\\text{ hour} labor); zero internal or structural damage.
* **`GRADE_C`:** Operational mechanical assembly with \\ge 321,868\\text{ km} (200,000\\text{ miles}).

### 5.2 Body Panels & Sheet Metal (3-Character Damage Code: `[Loc][Type][Units]`)

* **1.0 Damage Unit:** Surface area not exceeding a standard credit card (\\approx 46\\text{ cm}^2).
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
5. **`driveOnSicCertKey` & `driveOnSscCertKey`:** Issued Structural Inspection Certificate (SIC) and Safety Standards Certificate (SSC, valid strictly for **36 calendar days** from `driveOnSscIssuedAt`).*(Note: Watercraft and Shop Equipment automatically bypass this checklist.)*

### 6.2 Trinidad & Tobago FIU & Customs Clearance Checklist

1. **Customer Due Diligence (CDD) Gate:** Any single or linked `VaultTransaction` where `grossCollectedMinor >= 5000000` (\\text{TT\\\$50,000}) requires capturing the buyer's government ID reference (`buyerNationalIdHash`) and full name before `isPaymentVerified` can be set to `true`.
2. **Large Cash Transaction Alert:** Any cash transaction \\ge \\text{TT\\\$90,000} triggers a mandatory FIU compliance notice to the Trinidad Vault Admin and Architect/CFO.

