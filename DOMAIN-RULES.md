# DOMAIN-RULES.md — Configurable Policy, Tariff, Compatibility, Site Zoning & Mass-Balance Register

## 1. Architectural Rule: Configuration vs. Code Invariants

To prevent regulatory or market changes from requiring code deployments, the system strictly separates **Hard Code Invariants** from **Versioned Policy Parameters**:

* **Hard Code Invariants (Enforced in TypeScript Entities / DB Triggers):** Multi-schema tenant isolation (`shared`, `salvage`, `cannabis`), Kemptville 19-acre site zoning firewall (`RULE-ZONE-001`), two-phase eBay export locking (`EXPORT_LOCK_PENDING` $\rightarrow$ `EXPORT_LOCK_CONFIRMED`), append-only financial/audit/destruction records, strict separation of Vault Admin COD verification from sales brokers, single-use HMAC gate pass consumption, gram-accurate cannabis mass-balance identity, and dual-witness cannabis destruction (`primaryUserId != witnessUserId`).
* **Configurable Policy Parameters (Stored in `src/core/config/pricing-policy.json` or `shared.Organization.policyConfigJson` via `IPolicyConfigPort`):** Customs duty percentages, VAT rates, shadow FX multipliers, LHD/RHD part-category mappings, ARA grading multipliers, data-driven physical capacity caps (`StorageLocation.maxActiveAssetCapacity`), cannabis wet-to-dry moisture loss bands, extraction yield ranges, QAP variance alert thresholds (`RULE-CAN-001`), and jurisdiction-specific document checklists.

---

## 2. LHD vs. RHD Part Compatibility Matrix (Ontario Donor -> Trinidad Market)

**Context:** Donor vehicles acquired in Ontario are Left-Hand Drive (`LHD_ONLY`), whereas Trinidad & Tobago and Barbados operate predominantly Right-Hand Drive (`RHD_ONLY`) fleets (alongside universal marine watercraft).

* **Rule (`RULE-FIT-001`):** Any stripped automotive part must be assigned a `SteeringSideCompatibility` enum (`UNIVERSAL`, `LHD_ONLY`, `RHD_ONLY`) based on its `partCategoryName` default below, unless explicitly overridden by a human reviewer or matched to a verified LHD Caribbean buyer wish-list. **Important Fitment Clarification:** `UNIVERSAL` indicates **steering-side geometry neutrality only** (i.e., the part is not physically mirrored between LHD and RHD cockpits/firewalls); it **never** replaces mandatory OEM part-number or Hollander/interchange fitment verification (`oemFitmentVerified = true`) against destination-market vehicles across trim, engine, or model-year variants.
* **Rule (`RULE-FIT-002`):** Parts flagged `LHD_ONLY` are automatically routed to **Domestic North American Channels (eBay Motors)** and blocked from being scanned onto a Trinidad LCL/FCL export pallet unless an explicit `PreOrderWishList` override exists.

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

### 2.1 Multi-Channel Domestic & Export Channel Routing Matrix (`RULE-MKT-001`)

To maximize net margin and velocity while avoiding platform bot bans, inventory is routed across sales channels based on physical weight, steering-side compatibility, and buyer geography:

| Inventory Class | Primary Sales Channel(s) | Listing & Syndication Mechanism | Fee & Logistics Rationale |
| :--- | :--- | :--- | :--- |
| **Small / Light Electronics & `LHD_ONLY` Parts (`< 15 kg`: ECUs, radar sensors, clusters, switches, steering racks, headlamps)** | `EBAY_MOTORS_SHIPPED` | Automated eBay Inventory API + Browse API comp floor (`FR-AI-01`) | High North American demand; easy to box and ship via courier despite `13.25%` platform fee. |
| **Heavy / Bulky Domestic Parts (`>= 15 kg`: doors, hoods, bumpers, subframes, engines, transmissions)** | `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `LOCAL_WALK_IN_CASH` | **Manifest V3 Chrome Extension (`FR-MKT-02`)** autofilling Facebook Marketplace & Kijiji forms from `/api/marketplace/local-ad-payload/[sku]` | `0%` platform fee; eliminates `$150–$400` LTL freight/crating headaches via Ottawa/Ramsayville local pickup. |
| **Quick-Turn $5,000 Beaters & Rebuilt Salvage Cars (`RAMS` Lot)** | `RETAIL_LOT_VEHICLE_SALE`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL` | Chrome Extension Vehicle Autofill (`FR-MKT-02`) + Physical Ramsayville 8-car retail lot (`StorageLocation.maxActiveAssetCapacity = 8`) | Turns Canadian cash every 7–14 days (`0%` fee) with mandatory DriveON SSC & signed Bill of Sale (`FR-CHK-01`). |
| **`UNIVERSAL` SUV Assemblies, Watercraft & Shop Equipment (`TT_POS`)** | `DESTINATION_VAULT_COD`, `DESTINATION_PRE_ORDER_PICKUP`, `SECONDARY_ISLAND_WHOLESALE` | Two-Tab "Live Container" B2B Storefront (`FR-MKT-01`) + WhatsApp B2B Alerts | Captures Caribbean arbitrage margin via Family Bonded Vault with `0` third-party rent and strict MFA `aal2` COD release (`FR-VLT-03`). |

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
    "cbsaMarineCutoffHours": 48
  },
  "operationalGates": {
    "workingCapitalGate": {
      "enabled": true,
      "enforcementMode": "HARD_BLOCK",
      "initialSeedCapitalCadMinor": 3500000,
      "minCashReserveFloorCadMinor": 750000,
      "countPendingExportCashAsAvailable": false
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

### 4.3 Self-Funding Working Capital Pool, Domestic Net Realization, Operator Float & Destination Bank Cap Formulas

1. **Self-Funding Available Working Capital Formula (`operationalGates.workingCapitalGate`):**
   * Rather than relying on recurring external capital infusions, the venture operates on a one-time initial seed investment (`initialSeedCapitalCadMinor`, configurable $\$20,000\text{–}\$50,000\text{ CAD}$, default $\$35,000\text{ CAD}$) that self-funds strictly out of realized domestic sales and repatriated export settlements (`SETTLED_ORIGIN_CORP_BANK`, when `countPendingExportCashAsAvailable == false`):
   $$\text{AvailableWorkingCapital}_{\text{CAD}} = \text{InitialSeedCapital}_{\text{CAD}} + \sum \text{NetRealizedDomesticSales}_{\text{CAD}} + \sum \text{RepatriatedExportSettlements}_{\text{CAD}} - \sum \text{TotalDeployedAcquisitionAndExpenseOutlay}_{\text{CAD}}$$
   * A proposed vehicle acquisition passes the Working Capital Gate (`FR-DEAL-01` / `FR-INT-01`) if and only if:
   $$\text{AvailableWorkingCapital}_{\text{CAD}} - \text{EstimatedDealOutlay}_{\text{CAD}} \ge \text{minCashReserveFloorCadMinor} \quad (\$7,500\text{ CAD})$$
   (or if `enforcementMode == "WARN_ONLY" | "DISABLED"` or explicitly overridden by `ARCHITECT_CFO`).
2. **Domestic Channel Fee & Net Realization (`netRealizedCadMinor`):**
   * Local origin cash/e-Transfer channels (`LOCAL_WALK_IN_CASH`, `FB_MARKETPLACE_LOCAL`, `KIJIJI_LOCAL`, `RETAIL_LOT_VEHICLE_SALE`, `WHOLESALE_MECHANIC_NETWORK`) incur $0\%$ platform fees ($r_{\text{channel\_fee}} = 0.0$), whereas `EBAY_MOTORS_SHIPPED` deducts $13.25\%$ ($r_{\text{channel\_fee}} = 0.1325$) plus outbound courier label costs:
   $$\text{PlatformFee}_{\text{CAD}} = \text{round}\left(\text{Subtotal}_{\text{CAD}} \times r_{\text{channel\_fee}}\right)$$
   $$\text{NetRealized}_{\text{CAD}} = \text{GrossCollected}_{\text{CAD}} - \text{PlatformFee}_{\text{CAD}} - \text{ShippingCost}_{\text{CAD}}$$
   * `netRealizedCadMinor` is credited directly toward the donor `Vehicle` Break-Even Velocity counter and the **Self-Funding Working Capital Pool** (`AvailableWorkingCapital_CAD`).
3. **Operator Float Reconciliation & Tiered Receipt/Voucher Policy (`HELD_IN_OPERATOR_FLOAT` & `expensePolicy`):**
   * Cash collected in Ontario with `cashCustodyState == 'HELD_IN_OPERATOR_FLOAT'` is tracked as an auditable petty-cash subledger balance that decreases when shop `Expense` rows are logged with `paidFromCashCustody == 'HELD_IN_OPERATOR_FLOAT'` or when physical cash is deposited into the Canadian corporate bank account via `CashCustodyTransfer` (`SETTLED_ORIGIN_CORP_BANK`):
   $$\text{RunningOperatorFloat}_{\text{CAD}} = \sum \text{SaleTransaction}_{\text{HELD\_IN\_OPERATOR\_FLOAT}} - \sum \text{Expense}_{\text{paidFromFloat}} - \sum \text{CashCustodyTransfer}_{\text{FLOAT}\rightarrow\text{ORIGIN\_CORP\_BANK}}$$
   * **Tiered Receipt Verification (`ReceiptVerificationState`):**
     * `VERIFIED_RECEIPT`: Required for all expenses $> \text{pettyCashVoucherMaxCadMinor}$ ($\$50\text{ CAD}$) prior to final settlement; enforces non-empty `receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`.
     * `PETTY_CASH_VOUCHER`: Permitted for minor unreceipted cash expenses $\le \$50\text{ CAD}$ with a mandatory `voucherReason` ($\ge 5\text{ chars}$), subject to a rolling 30-day operator cap of `monthlyUnreceiptedVoucherCapCadMinor` ($\$250\text{ CAD/month}$).
     * `PENDING_RECEIPT_UPLOAD`: Temporary hold state for field expenses $> \$50\text{ CAD}$ logged with a `voucherReason` while awaiting receipt photo upload; tracked as an unverified operator float liability until transitioned to `VERIFIED_RECEIPT`.
4. **Destination Commercial Bank Cap Reconciliation (`trinidadDepositAlertThresholdTtdMinor`):**
   * Running TTD balances per Trinidadian commercial bank institution ($k$) reconcile direct buyer bank transfers, physical Vault cash deposits (`HELD_IN_DESTINATION_VAULT` $\rightarrow$ `DEPOSITED_DESTINATION_BANK`, where physical vault cash from counter sales equals $\text{grossCollectedMinor} - (\text{isBrokerCommissionDeductedAtCounter} \text{ ? } \text{brokerCommissionMinor} : 0)$) via `CashCustodyTransfer`, and outbound FX repatriation batches (`CurrencySettlement` $\rightarrow$ `SETTLED_ORIGIN_CORP_BANK`):
   $$\text{DestinationBankBalance}_{\text{Bank } k} = \sum \text{DirectWireSales}_{\text{Bank } k} + \sum \text{CashCustodyTransfer}_{\text{VAULT}\rightarrow\text{Bank } k} - \sum \text{CurrencySettlement}_{\text{From Bank } k}$$

### 4.4 Two-Stage Donor Cost Allocation, Market Price Guard & 3-Tier Shipment Profitability

1. **Two-Stage Donor Cost Allocation Rule (Provisional at Strip $\rightarrow$ Final True-Up at Hulk Scrap):**
   * To resolve the operational timing mismatch between stripping/pricing a part on Day 2 and weighing the crushed scrap hulk on Day 14, donor cost allocation operates in two stages:
   * **Stage 1 — Provisional Cost Basis (At Part Strip Time):** When a part is stripped from an active donor vehicle (`DISMANTLING_IN_PROGRESS`), its initial `allocatedCostBasisCadMinor` is computed using the vehicle's acquisition price plus logged direct expenses (towing, auction buyer fees, strip labor) to date, weighted against the greater of the vehicle's target gross realization or cumulative stripped parts market value:
     $$\text{ProvisionalCostBasis}_{\text{Part}} = \left(\text{ActualPurchasePrice}_{\text{CAD}} + \text{LoggedDirectExpenses}_{\text{CAD}}\right) \times \frac{\text{GradeAdjustedMarketValue}_{\text{CAD}}}{\max\left(\text{TargetGrossRealization}_{\text{CAD}}, \sum \text{StrippedPartsMarketValue}_{\text{CAD}}\right)}$$
   * **Stage 2 — Final Cost Basis True-Up (At `HULK_AWAITING_SCRAP` / `SCRAPPED_METAL_CLEARED`):** When dismantling completes and `scrapRecoveryCadMinor` is recorded from `scrapMetalTicketKey`, the system reconciles the exact remaining unrecovered donor cost ($\text{TotalDonorOutlay}_{\text{CAD}} - \text{ScrapRecovery}_{\text{CAD}} - \sum \text{AlreadySoldPartsAllocatedCost}_{\text{CAD}}$) pro-rata across all remaining unsold stripped parts so the accounting identity holds $100\%$:
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
2. **Rule `RULE-PAY-002` (Seed Capital Protection — Zero Founder Salaries from Initial Seed Principal):**
   * The one-time initial seed capital pool (`initialSeedCapitalCadMinor`, configurable $\$20,000\text{–}\$50,000\text{ CAD}$) is strictly reserved for inventory acquisition, repair parts, piece-rate stripping, and freight/customs (`allowFounderDrawFromSeedCapital = false`).
   * Founder profit draws (`category == 'PARTNER_PROFIT_DRAW'`) may only be disbursed when cumulative realized net profit across completed domestic and repatriated export sales exceeds cumulative expenses and prior draws:
     $$\text{DistributableRealizedProfitPool}_{\text{CAD}} = \sum \text{SaleTransaction.netRealizedCadMinor}_{\text{settled}} + \sum \text{Vehicle.scrapRecoveryCadMinor} - \sum \text{Expense.amountCadMinor}_{\text{settled}}$$
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

## 6. Jurisdiction-Specific Compliance Dossier Checklists

### 6.1 Ontario MTO Salvage-to-Rebuilt File (`R.R.O. 1990, Reg. 601` — Automobiles Only)

Stored in `Vehicle.rebuildDossierJson` with private file keys in `R2_PRIVATE_EVIDENCE_BUCKET`:

1. **`insurerRepairEstimateKey`:** Mandatory insurance company repair estimate (or authorized appraiser estimate).
2. **`preRepairDamagePhotoKeys`:** Minimum **2 colour photographs** showing damaged front/rear and both sides prior to any repair work.
3. **`frameBenchPhotoKey`:** Minimum **1 colour photograph** of the vehicle mounted on the structural frame-alignment bench in Ramsayville.
4. **`rebuiltPartsAuditFormKey`:** Completed MTO Rebuilt Vehicle Parts Audit Form itemizing every major replacement assembly with its donor VIN and linked `Expense` receipt.
5. **`driveOnSicCertKey` & `driveOnSscCertKey`:** Issued Structural Inspection Certificate (SIC) and Safety Standards Certificate (SSC, valid strictly for **36 calendar days** from `driveOnSscIssuedAt`). *(Note: Watercraft and Shop Equipment automatically bypass this checklist.)*

### 6.2 Trinidad & Tobago FIU & Customs Clearance Checklist

1. **Customer Due Diligence (CDD) Gate (Encrypted Private ID Storage):** Any single or linked `SaleTransaction` (`marketNode == 'DESTINATION_EXPORT_VAULT'`) where `grossCollectedMinor >= 5000000` ($\text{TT\$50,000}$) requires uploading a private scan/photo of the buyer's government ID (`buyerIdDocumentStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`), storing the AES-256-GCM application-encrypted ID type and number (`buyerIdNumberEncrypted`), and recording the buyer's full name before `isPaymentVerified` can be set to `true` (ensuring auditability upon statutory FIU inspection).
2. **Large Cash Transaction Alert:** Any single or linked cash transaction $\ge \text{TT\$90,000}$ (`9000000` minor units) triggers a mandatory FIU compliance notice to the Trinidad Vault Admin and Architect/CFO.
3. **Rule `RULE-COMP-FIU-01` (Deterministic 30-Day Rolling Window for Linked FIU Transactions):** A transaction is evaluated as **linked** if the current `SaleTransaction.grossCollectedMinor` plus the sum of `grossCollectedMinor` across all non-voided `SaleTransaction` records (`marketNode == 'DESTINATION_EXPORT_VAULT'` and `isVoidedOrReversed == false`) within a **rolling 30-calendar-day window (`createdAt >= now() - 30 days`)** matching the same `buyerPhoneE164`, normalized `lower(trim(buyerName))`, or `buyerIdNumberEncrypted` reaches or exceeds `5000000` ($\text{TT\$50,000}$) for the CDD Government ID gate, or `9000000` ($\text{TT\$90,000}$) for the Large Cash Transaction Alert.

---

## 7. Data-Driven Site Zoning & Multi-Tenant Location Invariant (`RULE-ZONE-001`)

**Context:** The 19-acre Kemptville property (`siteCode == 'KEMP'`) hosts both a dedicated 100ft x 100ft salvage container pad (`ORG_SALVAGE_EXPORT`) and agricultural/nursery zones (`ORG_CANNABIS_NURSERY_PROC`). Rather than hardcoding site names in TypeScript services, physical location barcodes are governed by two data-driven columns on `shared.StorageLocation` (`allowedOrgType` and `maxActiveAssetCapacity`) to protect municipal clean-yard compliance, Health Canada site inspection optics, and commercial SaaS portability:

* **Rule (`RULE-ZONE-001`):**
  1. **`ZONE_CONTAINER_PAD` (100ft x 100ft Pad, Containers `C01`–`C04`, e.g., `KEMP-C01-R01-S01-B01`):** Configured with `allowedOrgType = 'SALVAGE_AND_EXPORT'` and `maxActiveAssetCapacity = 4` on the dismantling pad (and `null` on individual shelf bins). Strictly restricted to `ORG_SALVAGE_EXPORT` assets (`salvage.Vehicle` and `salvage.Part`), enforcing a maximum of **4 uncrushed vehicle shells** (`STAGED_ONTARIO_YARD`, `DISMANTLING_IN_PROGRESS`, or `HULK_AWAITING_SCRAP`) on the pad at any time.
  2. **`ZONE_GREENHOUSE_AG` & `ZONE_TREE_FARM` (e.g., `KEMP-GRNH-R1-T1`, `KEMP-TREE-R1-B1`) and Brockville Facility (`BROCK-PROP-R1-T2`):** Configured with `allowedOrgType = 'CANNABIS_NURSERY_AND_PROCESSING'`. Strictly restricted to agricultural and nursery operations (`ORG_CANNABIS_NURSERY_PROC` — `cannabis.CannabisLot`).
  3. **Cross-Zone & Cross-Tenant Scan Hard Block:** Scanning any `salvage.Vehicle` or `salvage.Part` into a location where `allowedOrgType != 'SALVAGE_AND_EXPORT'`—or scanning any `cannabis.CannabisLot` into a location where `allowedOrgType != 'CANNABIS_NURSERY_AND_PROCESSING'`—is **hard-blocked** at the application and database layers (HTTP `422 Unprocessable Entity` — `SITE_ZONING_VIOLATION`).

| Site & Zone Code (`siteCode` / `zoneCode`) | Owning Organization (`Organization.code`) | `StorageLocation.allowedOrgType` | `StorageLocation.maxActiveAssetCapacity` | Allowed Domain Entities & Compliance Gate |
| :--- | :--- | :--- | :---: | :--- |
| **`KEMP` / `ZONE_CONTAINER_PAD`** | `ORG_SALVAGE_EXPORT` | `SALVAGE_AND_EXPORT` | `4` (Pad) / `null` (Bins) | `salvage.Vehicle`, `salvage.Part` — Max 4 uncrushed shells on 100ft x 100ft pad; 4x 40ft containers (`C01`–`C04`). |
| **`KEMP` / `ZONE_GREENHOUSE_AG`** | `ORG_CANNABIS_NURSERY_PROC` | `CANNABIS_NURSERY_AND_PROCESSING` | `null` | `cannabis.CannabisLot` — Zero automotive/marine salvage items permitted; Health Canada nursery perimeter. |
| **`KEMP` / `ZONE_TREE_FARM`** | `ORG_CANNABIS_NURSERY_PROC` | `CANNABIS_NURSERY_AND_PROCESSING` | `null` | `cannabis.CannabisLot` — Agricultural/horticultural propagation only; zero salvage parts/vehicles permitted. |
| **`RAMS` / `ZONE_RAMSAYVILLE_SHOP`** | `ORG_SALVAGE_EXPORT` | `SALVAGE_AND_EXPORT` | `8` (Retail Lot) | `salvage.Vehicle`, `salvage.Part` — Max 8 active vehicles (`ramsayvilleMaxActiveShopVehicles = 8`). |
| **`POSV` / `ZONE_TRINIDAD_VAULT`** | `ORG_SALVAGE_EXPORT` | `SALVAGE_AND_EXPORT` | `null` | `salvage.Vehicle`, `salvage.Part` — Bonded family warehouse in Port of Spain; weekly blind cycle counts (`FR-VLT-05`). |
| **`BROCK` / `ZONE_BROCKVILLE_FACILITY`** | `ORG_CANNABIS_NURSERY_PROC` | `CANNABIS_NURSERY_AND_PROCESSING` | `null` | `cannabis.CannabisLot` — Indoor propagation, drying/curing, extraction ("moving the juice"), and CTLS vault. |

---

## 8. Cannabis Mass-Balance, Extraction Yield & CTLS Category Rules (`RULE-CAN-001`)

**Context:** Health Canada's Cannabis Tracking and Licensing System (CTLS) and the Canada Revenue Agency (CRA Form B300) require gram-accurate monthly reconciliation across all cultivation and processing stages.

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
| **`CLONE_TRAY`** | `PLANTS` | Vegetative Cannabis Plants | Spawned via 3-Tap Mother scan (`FR-CAN-01`); ZPL tray tag printed. |
| **`VEGETATIVE_BATCH`** | `PLANTS` | Vegetative Cannabis Plants | Tracked by plant count; any culled plants require dual-witness `CannabisDestructionLog`. |
| **`FRESH_HARVEST`** | `GRAMS` | Whole Cannabis Plants / Fresh Cannabis | Wet harvest weight recorded immediately upon chop prior to drying room hang. |
| **`DRIED_FLOWER`** | `GRAMS` | Dried Cannabis | Reconciled against `FRESH_HARVEST` (`72%–80%` moisture loss); requires `labCoaStorageKey` for release. |
| **`TRIM_BIOMASS`** | `GRAMS` | Dried Cannabis (Trim / Shake) | Input feedstock for extraction ("moving the juice"). |
| **`CRUDE_EXTRACT`** | `GRAMS` | Cannabis Extracts (Unrefined) | Reconciled against input biomass + spent raffinate destruction log. |
| **`DISTILLATE_OR_ISOLATE`** | `GRAMS` | Cannabis Extracts (Refined) | Requires private R2 Lab CoA PDF (`labCoaStorageKey`) and `complianceHold == false` prior to B2B transfer. |
