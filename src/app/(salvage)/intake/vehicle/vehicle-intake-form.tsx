'use client';

import React, { useCallback, useId, useRef, useState } from 'react';
import type {
  AssetCategory,
  CatalyticConverterDisposition,
  OperationalLane,
  ReceiptVerificationState,
  RoadVehicleBrand,
  StatutoryVehiclePurpose,
  UserRole,
  VehicleAcquisitionSource,
} from '@prisma/client';
import { QrScannerInput } from '@/app/components/QrScannerInput';
import type { IntakeVehicleResult } from '@/modules/dismantling/vehicle-intake/intake-vehicle.use-case';

export interface VehicleIntakeFormProps {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly actorRole: UserRole;
  readonly canCfoOverride: boolean;
  readonly endpointUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly generateIdempotencyKey?: () => string;
}

interface FormState {
  assetCategory: AssetCategory;
  vinOrHin: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  engineSpec: string;
  exteriorColor: string;
  destinationBarcode: string;
  operationalLane: OperationalLane;
  roadBrand: 'NONE' | 'SALVAGE' | 'REBUILT' | 'IRREPARABLE';
  odometerKm: string;
  engineHours: string;
  acquisitionSource: VehicleAcquisitionSource;
  declaredStatutoryPurpose: StatutoryVehiclePurpose;
  sellerFullName: string;
  sellerAddress: string;
  ontarioPermitNumber: string;
  sellerPhotoIdStorageKey: string;
  fluidsDrained: boolean;
  fluidsDrainedAt: string;
  catalyticConverterDisposition: CatalyticConverterDisposition;
  driveOnFailed: boolean;
  driveOnInitialFailAt: string;
  driveOnFailSheetStorageKey: string;
  estimatedMaxBidCad: string;
  actualPurchasePriceCad: string;
  auctionBuyerFeeCad: string;
  towingCad: string;
  estimatedRepairCad: string;
  vendorName: string;
  paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK' | 'HELD_IN_OPERATOR_FLOAT';
  receiptVerificationState: ReceiptVerificationState;
  receiptStorageKey: string;
  voucherReason: string;
  cfoOverrideApproved: boolean;
  cfoOverrideReasonNote: string;
}

const WARNING_LABELS: Readonly<Record<string, string>> = {
  MISSING_EASR_REGISTRATION_WARNING:
    'O. Reg. 85/16 EASR Warning: Active ELV count > 2 without EASR registration number.',
  PROPOSED_INACTIVE_LOCATION_WARNING:
    'Proposed / Inactive Site Warning: Destination location is PROPOSED_INACTIVE.',
  COMPLIANCE_WARNING_UNDRAINED_FARM:
    'Environmental Warning (RULE-ENV-001): Undrained automobile staged on non-dismantling pad.',
  MISSING_HTA_S60_DOCS:
    'HTA Section 60 Warning: Seller / permit / private-seller ID documentation incomplete.',
  WORKING_CAPITAL_RESERVE_BREACHED:
    'CFO Override Applied: Working-capital $7,500 reserve floor waived.',
  DONOR_LANDED_CAP_EXCEEDED:
    'CFO Override Applied: $3,200 donor landed cap waived.',
  HIGH_END_REBUILD_LANE_PAUSED:
    'CFO Override Applied: Year-1 HIGH_END_REBUILD lane pause waived.',
  LOCATION_CAPACITY_EXCEEDED:
    'CFO Override Applied: Destination active-asset capacity limit waived.',
};

function createClientUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-000000000000';
}

function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [whole, frac = ''] = trimmed.split('.');
  const cents =
    Number.parseInt(whole ?? '0', 10) * 100 +
    Number.parseInt(frac.padEnd(2, '0'), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

function createInitialFormState(): FormState {
  return {
    assetCategory: 'AUTOMOBILE',
    vinOrHin: '',
    year: '',
    make: '',
    model: '',
    trim: '',
    engineSpec: '',
    exteriorColor: '',
    destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
    operationalLane: 'DISMANTLE_AND_EXPORT',
    roadBrand: 'SALVAGE',
    odometerKm: '',
    engineHours: '',
    acquisitionSource: 'LICENSED_AUCTION',
    declaredStatutoryPurpose: 'WRECKING_PARTS_ONLY',
    sellerFullName: '',
    sellerAddress: '',
    ontarioPermitNumber: '',
    sellerPhotoIdStorageKey: '',
    fluidsDrained: false,
    fluidsDrainedAt: '',
    catalyticConverterDisposition: 'PRESENT_AT_INTAKE',
    driveOnFailed: false,
    driveOnInitialFailAt: '',
    driveOnFailSheetStorageKey: '',
    estimatedMaxBidCad: '2000.00',
    actualPurchasePriceCad: '1500.00',
    auctionBuyerFeeCad: '0.00',
    towingCad: '0.00',
    estimatedRepairCad: '0.00',
    vendorName: 'Ontario Salvage Auction',
    paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
    receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
    receiptStorageKey: '',
    voucherReason: 'Auction invoice queued for upload',
    cfoOverrideApproved: false,
    cfoOverrideReasonNote: '',
  };
}

const TOUCH_TARGET_INPUT_STYLE: React.CSSProperties = {
  minHeight: '56px',
  minWidth: '56px',
  padding: '12px 14px',
  fontSize: '16px',
  fontWeight: 600,
  backgroundColor: '#FFFFFF',
  color: '#0F172A',
  border: '2px solid #0F172A',
  borderRadius: '8px',
  width: '100%',
  boxSizing: 'border-box',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '15px',
  fontWeight: 700,
  color: '#0F172A',
  marginBottom: '6px',
};

export function VehicleIntakeForm({
  organizationId,
  organizationName,
  actorRole,
  canCfoOverride,
  endpointUrl = '/api/salvage/vehicles',
  fetchFn,
  generateIdempotencyKey = createClientUuid,
}: VehicleIntakeFormProps): React.ReactElement {
  const formId = useId();
  const [form, setForm] = useState<FormState>(createInitialFormState);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [intakeResult, setIntakeResult] = useState<IntakeVehicleResult | null>(
    null,
  );

  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey());
  const lastSubmittedIntentRef = useRef<string | null>(null);
  const submitLockRef = useRef(false);

  const updateField = useCallback(
    <K extends keyof FormState>(field: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleCategoryChange = useCallback((nextCategory: AssetCategory) => {
    setForm((prev) => {
      if (nextCategory === 'AUTOMOBILE') {
        return {
          ...prev,
          assetCategory: 'AUTOMOBILE',
          engineHours: '',
        };
      }
      return {
        ...prev,
        assetCategory: nextCategory,
        roadBrand: 'SALVAGE',
        odometerKm: '',
        catalyticConverterDisposition: 'PRESENT_AT_INTAKE',
        driveOnFailed: false,
        driveOnInitialFailAt: '',
        driveOnFailSheetStorageKey: '',
        sellerFullName: '',
        sellerAddress: '',
        ontarioPermitNumber: '',
        sellerPhotoIdStorageKey: '',
        operationalLane:
          prev.operationalLane === 'HIGH_END_REBUILD'
            ? 'WHOLE_UNIT_EXPORT'
            : prev.operationalLane,
      };
    });
  }, []);

  const handleDestinationScan = useCallback(
    (payload: { readonly code: string }) => {
      updateField('destinationBarcode', payload.code);
    },
    [updateField],
  );

  const buildRequestBody = useCallback(():
    | { ok: true; body: Record<string, unknown>; intentSignature: string }
    | { ok: false; message: string } => {
    const vinOrHin = form.vinOrHin.trim().toUpperCase();
    if (vinOrHin.length === 0) {
      return { ok: false, message: 'VIN / HIN / Serial is required.' };
    }
    const destinationBarcode = form.destinationBarcode.trim().toUpperCase();
    if (destinationBarcode.length === 0) {
      return { ok: false, message: 'Destination QR barcode is required.' };
    }

    const maxBidMinor = dollarsToCents(form.estimatedMaxBidCad);
    const purchaseMinor = dollarsToCents(form.actualPurchasePriceCad);
    const feeMinor = dollarsToCents(form.auctionBuyerFeeCad);
    const towingMinor = dollarsToCents(form.towingCad);
    const repairMinor = dollarsToCents(form.estimatedRepairCad);
    if (
      maxBidMinor === null ||
      purchaseMinor === null ||
      feeMinor === null ||
      towingMinor === null ||
      repairMinor === null
    ) {
      return {
        ok: false,
        message: 'CAD dollar inputs must be valid non-negative amounts (e.g., 1450.00).',
      };
    }

    const vendorName = form.vendorName.trim();
    if (vendorName.length === 0) {
      return { ok: false, message: 'Acquisition vendor name is required.' };
    }

    if (form.receiptVerificationState === 'VERIFIED_RECEIPT') {
      if (form.receiptStorageKey.trim().length === 0) {
        return {
          ok: false,
          message: 'Private receipt storage key is required for VERIFIED_RECEIPT.',
        };
      }
    } else if (form.voucherReason.trim().length < 5) {
      return {
        ok: false,
        message: 'Voucher / pending-receipt reason must be at least 5 characters.',
      };
    }

    const paidAcquisitionComponents: Array<Record<string, unknown>> = [];
    if (purchaseMinor > 0) {
      paidAcquisitionComponents.push({
        category: 'AUCTION_PURCHASE_PRICE',
        vendorName,
        amountCadMinor: purchaseMinor,
        paidFromCashCustody: form.paidFromCashCustody,
        receiptVerificationState: form.receiptVerificationState,
        receiptStorageKey:
          form.receiptVerificationState === 'VERIFIED_RECEIPT'
            ? form.receiptStorageKey.trim()
            : null,
        voucherReason:
          form.receiptVerificationState === 'VERIFIED_RECEIPT'
            ? null
            : form.voucherReason.trim(),
      });
    }
    if (feeMinor > 0) {
      paidAcquisitionComponents.push({
        category: 'AUCTION_BUYER_FEE',
        vendorName,
        amountCadMinor: feeMinor,
        paidFromCashCustody: form.paidFromCashCustody,
        receiptVerificationState: form.receiptVerificationState,
        receiptStorageKey:
          form.receiptVerificationState === 'VERIFIED_RECEIPT'
            ? form.receiptStorageKey.trim()
            : null,
        voucherReason:
          form.receiptVerificationState === 'VERIFIED_RECEIPT'
            ? null
            : form.voucherReason.trim(),
      });
    }
    if (towingMinor > 0) {
      paidAcquisitionComponents.push({
        category: 'TOWING_AND_RECOVERY',
        vendorName,
        amountCadMinor: towingMinor,
        paidFromCashCustody: form.paidFromCashCustody,
        receiptVerificationState: form.receiptVerificationState,
        receiptStorageKey:
          form.receiptVerificationState === 'VERIFIED_RECEIPT'
            ? form.receiptStorageKey.trim()
            : null,
        voucherReason:
          form.receiptVerificationState === 'VERIFIED_RECEIPT'
            ? null
            : form.voucherReason.trim(),
      });
    }

    const parsedYear =
      form.year.trim().length > 0 ? Number.parseInt(form.year.trim(), 10) : undefined;
    if (
      parsedYear !== undefined &&
      (!Number.isSafeInteger(parsedYear) || parsedYear < 1900 || parsedYear > 2100)
    ) {
      return { ok: false, message: 'Model year must be between 1900 and 2100.' };
    }

    const baseBody: Record<string, unknown> = {
      assetCategory: form.assetCategory,
      vinOrHin,
      ...(parsedYear !== undefined ? { year: parsedYear } : {}),
      ...(form.make.trim().length > 0 ? { make: form.make.trim() } : {}),
      ...(form.model.trim().length > 0 ? { model: form.model.trim() } : {}),
      ...(form.trim.trim().length > 0 ? { trim: form.trim.trim() } : {}),
      ...(form.engineSpec.trim().length > 0
        ? { engineSpec: form.engineSpec.trim() }
        : {}),
      ...(form.exteriorColor.trim().length > 0
        ? { exteriorColor: form.exteriorColor.trim() }
        : {}),
      destinationBarcode,
      operationalLane: form.operationalLane,
      acquisitionSource: form.acquisitionSource,
      declaredStatutoryPurpose: form.declaredStatutoryPurpose,
      fluidsDrainedAt: form.fluidsDrained
        ? form.fluidsDrainedAt.trim() || new Date().toISOString()
        : null,
      estimatedMaxBidCadMinor: maxBidMinor,
      actualPurchasePriceCadMinor: purchaseMinor,
      estimatedRepairCadMinor: repairMinor,
      paidAcquisitionComponents,
    };

    if (form.assetCategory === 'AUTOMOBILE') {
      baseBody.roadBrand = form.roadBrand as RoadVehicleBrand;
      if (form.odometerKm.trim().length > 0) {
        const odom = Number.parseInt(form.odometerKm.trim(), 10);
        if (!Number.isSafeInteger(odom) || odom < 0) {
          return { ok: false, message: 'Odometer km must be a non-negative integer.' };
        }
        baseBody.odometerKm = odom;
      }
      if (form.sellerFullName.trim().length > 0) {
        baseBody.sellerFullName = form.sellerFullName.trim();
      }
      if (form.sellerAddress.trim().length > 0) {
        baseBody.sellerAddress = form.sellerAddress.trim();
      }
      if (form.ontarioPermitNumber.trim().length > 0) {
        baseBody.ontarioPermitNumber = form.ontarioPermitNumber.trim();
      }
      if (form.sellerPhotoIdStorageKey.trim().length > 0) {
        baseBody.sellerPhotoIdStorageKey = form.sellerPhotoIdStorageKey.trim();
      }
      baseBody.catalyticConverterDisposition = form.catalyticConverterDisposition;
      if (form.driveOnFailed) {
        if (
          form.driveOnInitialFailAt.trim().length === 0 ||
          form.driveOnFailSheetStorageKey.trim().length === 0
        ) {
          return {
            ok: false,
            message:
              'DriveON initial fail timestamp and fail sheet private key are both required when DriveON Fail is enabled.',
          };
        }
        baseBody.driveOnInitialFailAt = form.driveOnInitialFailAt.trim();
        baseBody.driveOnFailSheetStorageKey =
          form.driveOnFailSheetStorageKey.trim();
      }
    } else {
      baseBody.roadBrand = 'NOT_APPLICABLE';
      if (form.engineHours.trim().length > 0) {
        const hrs = Number.parseInt(form.engineHours.trim(), 10);
        if (!Number.isSafeInteger(hrs) || hrs < 0) {
          return { ok: false, message: 'Engine hours must be a non-negative integer.' };
        }
        baseBody.engineHours = hrs;
      }
    }

    if (canCfoOverride && form.cfoOverrideApproved) {
      baseBody.cfoOverride = {
        approved: true,
        reasonNote: form.cfoOverrideReasonNote.trim(),
      };
    }

    const intentSignature = JSON.stringify(baseBody);
    return { ok: true, body: baseBody, intentSignature };
  }, [canCfoOverride, form]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitLockRef.current || isSubmitting) {
        return;
      }

      const built = buildRequestBody();
      if (!built.ok) {
        setErrorBanner({ code: 'INVALID_INTAKE_INPUT', message: built.message });
        return;
      }

      if (
        lastSubmittedIntentRef.current !== null &&
        lastSubmittedIntentRef.current !== built.intentSignature
      ) {
        idempotencyKeyRef.current = generateIdempotencyKey();
      }
      lastSubmittedIntentRef.current = built.intentSignature;
      const requestIdempotencyKey = idempotencyKeyRef.current;

      submitLockRef.current = true;
      setIsSubmitting(true);
      setErrorBanner(null);

      try {
        const transport = fetchFn ?? fetch;
        const response = await transport(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': requestIdempotencyKey,
          },
          body: JSON.stringify({
            ...built.body,
            idempotencyKey: requestIdempotencyKey,
            deviceTimestamp: new Date().toISOString(),
          }),
        });

        const payload = (await response.json()) as
          | IntakeVehicleResult
          | { error?: { code?: string; message?: string } };

        if (!response.ok) {
          const errObj = (payload as { error?: { code?: string; message?: string } }).error;
          setErrorBanner({
            code: errObj?.code ?? `HTTP_${response.status}`,
            message:
              errObj?.message ?? `Intake failed with HTTP ${response.status}.`,
          });
          return;
        }

        setIntakeResult(payload as IntakeVehicleResult);
        // Mint a fresh key for the next distinct command once this submission succeeded.
        idempotencyKeyRef.current = generateIdempotencyKey();
        lastSubmittedIntentRef.current = null;
      } catch (err) {
        setErrorBanner({
          code: 'NETWORK_ERROR',
          message:
            err instanceof Error && err.message.trim().length > 0
              ? err.message
              : 'Network error submitting vehicle intake. Retry safely with the same idempotency key.',
        });
      } finally {
        submitLockRef.current = false;
        setIsSubmitting(false);
      }
    },
    [buildRequestBody, endpointUrl, fetchFn, generateIdempotencyKey, isSubmitting],
  );

  const focusOutline = (name: string): React.CSSProperties => ({
    outline: focusedField === name ? '3px solid #2563EB' : 'none',
    outlineOffset: '2px',
  });

  return (
    <main
      data-testid="vehicle-intake-page"
      data-organization-id={organizationId}
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '16px',
        backgroundColor: '#F8FAFC',
        color: '#0F172A',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <header
        style={{
          marginBottom: '16px',
          padding: '14px 16px',
          backgroundColor: '#FFFFFF',
          border: '2px solid #0F172A',
          borderRadius: '10px',
        }}
      >
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: '0 0 4px 0' }}>
          Parent Asset Intake (FR-INT-01)
        </h1>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#334155' }}>
          Workspace: {organizationName} · Role: {actorRole}
        </p>
      </header>

      <section
        aria-label="Asset Category Selector"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: '8px',
          marginBottom: '16px',
        }}
      >
        {(
          [
            { id: 'AUTOMOBILE', label: 'Automobile' },
            { id: 'WATERCRAFT', label: 'Watercraft' },
            { id: 'SHOP_EQUIPMENT', label: 'Equipment' },
          ] as const
        ).map((cat) => {
          const active = form.assetCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              data-testid={`category-btn-${cat.id}`}
              aria-pressed={active}
              disabled={isSubmitting}
              onClick={() => handleCategoryChange(cat.id)}
              onFocus={() => setFocusedField(`cat-${cat.id}`)}
              onBlur={() => setFocusedField(null)}
              style={{
                minHeight: '56px',
                minWidth: '56px',
                padding: '10px 8px',
                fontSize: '15px',
                fontWeight: 700,
                backgroundColor: active ? '#1E40AF' : '#FFFFFF',
                color: active ? '#FFFFFF' : '#0F172A',
                border: '2px solid #0F172A',
                borderRadius: '8px',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                ...focusOutline(`cat-${cat.id}`),
              }}
            >
              {cat.label}
            </button>
          );
        })}
      </section>

      <div style={{ marginBottom: '16px' }}>
        <QrScannerInput
          label="Scan Destination Zone / Pad QR"
          placeholder="KEMP_ZONE_CONTAINER_PAD or RAMS-SHOP-R01-S01-B01"
          initialCode={form.destinationBarcode}
          disabled={isSubmitting}
          enableFeedbackCues={true}
          onScan={handleDestinationScan}
        />
      </div>

      {errorBanner && (
        <div
          role="alert"
          data-testid="intake-error-banner"
          style={{
            backgroundColor: '#FEF2F2',
            border: '2px solid #991B1B',
            color: '#991B1B',
            borderRadius: '8px',
            padding: '12px 14px',
            marginBottom: '16px',
            fontWeight: 700,
          }}
        >
          <div>Error ({errorBanner.code}): {errorBanner.message}</div>
        </div>
      )}

      {intakeResult && (
        <section
          aria-live="polite"
          data-testid="intake-success-card"
          style={{
            backgroundColor: '#F0FDF4',
            border: '2px solid #166534',
            color: '#166534',
            borderRadius: '8px',
            padding: '14px',
            marginBottom: '16px',
          }}
        >
          <div style={{ fontWeight: 800, fontSize: '16px', marginBottom: '6px' }}>
            Asset Staged: {intakeResult.internalStockNumber} (
            {intakeResult.year} {intakeResult.make} {intakeResult.model})
          </div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            Vehicle ID: {intakeResult.vehicleId} · Destination:{' '}
            {intakeResult.destinationBarcode} · HS: {intakeResult.suggestedHsCode}
          </div>
          {intakeResult.driveOnReinspectionDeadlineAt && (
            <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>
              DriveON 10-Day Re-Inspection Deadline:{' '}
              {intakeResult.driveOnReinspectionDeadlineAt}
            </div>
          )}
          {intakeResult.complianceWarnings.length > 0 && (
            <ul
              data-testid="intake-warnings-list"
              style={{
                margin: '10px 0 0 0',
                padding: 0,
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              {intakeResult.complianceWarnings.map((code) => (
                <li
                  key={code}
                  data-testid={`warning-badge-${code}`}
                  style={{
                    backgroundColor: '#FFFBEB',
                    border: '2px solid #92400E',
                    color: '#92400E',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '14px',
                    fontWeight: 700,
                  }}
                >
                  [WARNING: {code}] {WARNING_LABELS[code] ?? code}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          backgroundColor: '#FFFFFF',
          border: '2px solid #0F172A',
          borderRadius: '10px',
          padding: '16px',
        }}
      >
        <div>
          <label htmlFor={`${formId}-vin`} style={LABEL_STYLE}>
            {form.assetCategory === 'AUTOMOBILE'
              ? '17-Char VIN'
              : form.assetCategory === 'WATERCRAFT'
                ? '12-Char Watercraft HIN'
                : 'Equipment Serial Number'}
          </label>
          <input
            id={`${formId}-vin`}
            data-testid="input-vin-or-hin"
            type="text"
            value={form.vinOrHin}
            disabled={isSubmitting}
            onChange={(e) => updateField('vinOrHin', e.target.value)}
            onFocus={() => setFocusedField('vin')}
            onBlur={() => setFocusedField(null)}
            placeholder={
              form.assetCategory === 'AUTOMOBILE'
                ? '5XYP5DHC5LG000001'
                : form.assetCategory === 'WATERCRAFT'
                  ? 'YAM12345A121'
                  : 'ROB-AC1234-2022-001'
            }
            style={{ ...TOUCH_TARGET_INPUT_STYLE, ...focusOutline('vin') }}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '8px',
          }}
        >
          <div>
            <label htmlFor={`${formId}-year`} style={LABEL_STYLE}>
              Year (Fallback/Manual)
            </label>
            <input
              id={`${formId}-year`}
              data-testid="input-year"
              type="text"
              inputMode="numeric"
              value={form.year}
              disabled={isSubmitting}
              onChange={(e) => updateField('year', e.target.value)}
              style={TOUCH_TARGET_INPUT_STYLE}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-make`} style={LABEL_STYLE}>
              Make
            </label>
            <input
              id={`${formId}-make`}
              data-testid="input-make"
              type="text"
              value={form.make}
              disabled={isSubmitting}
              onChange={(e) => updateField('make', e.target.value)}
              style={TOUCH_TARGET_INPUT_STYLE}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-model`} style={LABEL_STYLE}>
              Model
            </label>
            <input
              id={`${formId}-model`}
              data-testid="input-model"
              type="text"
              value={form.model}
              disabled={isSubmitting}
              onChange={(e) => updateField('model', e.target.value)}
              style={TOUCH_TARGET_INPUT_STYLE}
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${formId}-dest`} style={LABEL_STYLE}>
            Destination Location Barcode
          </label>
          <input
            id={`${formId}-dest`}
            data-testid="input-destination-barcode"
            type="text"
            value={form.destinationBarcode}
            disabled={isSubmitting}
            onChange={(e) => updateField('destinationBarcode', e.target.value)}
            style={TOUCH_TARGET_INPUT_STYLE}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '10px',
          }}
        >
          <div>
            <label htmlFor={`${formId}-lane`} style={LABEL_STYLE}>
              Operational Lane
            </label>
            <select
              id={`${formId}-lane`}
              data-testid="select-operational-lane"
              value={form.operationalLane}
              disabled={isSubmitting}
              onChange={(e) =>
                updateField(
                  'operationalLane',
                  e.target.value as OperationalLane,
                )
              }
              style={TOUCH_TARGET_INPUT_STYLE}
            >
              <option value="DISMANTLE_AND_EXPORT">DISMANTLE_AND_EXPORT</option>
              <option value="QUICK_TURN_BEATER">QUICK_TURN_BEATER</option>
              <option value="WHOLE_UNIT_EXPORT">WHOLE_UNIT_EXPORT</option>
              <option value="HIGH_END_REBUILD">HIGH_END_REBUILD</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${formId}-source`} style={LABEL_STYLE}>
              Acquisition Source
            </label>
            <select
              id={`${formId}-source`}
              data-testid="select-acquisition-source"
              value={form.acquisitionSource}
              disabled={isSubmitting}
              onChange={(e) =>
                updateField(
                  'acquisitionSource',
                  e.target.value as VehicleAcquisitionSource,
                )
              }
              style={TOUCH_TARGET_INPUT_STYLE}
            >
              <option value="LICENSED_AUCTION">LICENSED_AUCTION</option>
              <option value="PRIVATE_DRIVEWAY_BUY">PRIVATE_DRIVEWAY_BUY</option>
              <option value="DEALER_WHOLESALE">DEALER_WHOLESALE</option>
              <option value="TRADE_IN">TRADE_IN</option>
            </select>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '10px',
          }}
        >
          <div>
            <label htmlFor={`${formId}-purchase`} style={LABEL_STYLE}>
              Actual Purchase Price (CAD)
            </label>
            <input
              id={`${formId}-purchase`}
              data-testid="input-purchase-cad"
              type="text"
              inputMode="decimal"
              value={form.actualPurchasePriceCad}
              disabled={isSubmitting}
              onChange={(e) =>
                updateField('actualPurchasePriceCad', e.target.value)
              }
              style={TOUCH_TARGET_INPUT_STYLE}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-repair`} style={LABEL_STYLE}>
              Estimated Repair (CAD)
            </label>
            <input
              id={`${formId}-repair`}
              data-testid="input-repair-cad"
              type="text"
              inputMode="decimal"
              value={form.estimatedRepairCad}
              disabled={isSubmitting}
              onChange={(e) =>
                updateField('estimatedRepairCad', e.target.value)
              }
              style={TOUCH_TARGET_INPUT_STYLE}
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${formId}-vendor`} style={LABEL_STYLE}>
            Paid Acquisition Vendor / Auction
          </label>
          <input
            id={`${formId}-vendor`}
            data-testid="input-vendor-name"
            type="text"
            value={form.vendorName}
            disabled={isSubmitting}
            onChange={(e) => updateField('vendorName', e.target.value)}
            style={TOUCH_TARGET_INPUT_STYLE}
          />
        </div>

        {form.assetCategory === 'AUTOMOBILE' && (
          <fieldset
            data-testid="automobile-compliance-section"
            style={{
              border: '2px solid #334155',
              borderRadius: '8px',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <legend style={{ fontWeight: 800, padding: '0 6px' }}>
              Ontario HTA s. 60, DriveON & Fluid Depollution
            </legend>

            <div>
              <label htmlFor={`${formId}-seller-name`} style={LABEL_STYLE}>
                Seller / Auction Full Name
              </label>
              <input
                id={`${formId}-seller-name`}
                data-testid="input-seller-name"
                type="text"
                value={form.sellerFullName}
                disabled={isSubmitting}
                onChange={(e) => updateField('sellerFullName', e.target.value)}
                style={TOUCH_TARGET_INPUT_STYLE}
              />
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '10px',
              }}
            >
              <div>
                <label htmlFor={`${formId}-permit`} style={LABEL_STYLE}>
                  Ontario Green-Slip Permit #
                </label>
                <input
                  id={`${formId}-permit`}
                  data-testid="input-ontario-permit"
                  type="text"
                  value={form.ontarioPermitNumber}
                  disabled={isSubmitting}
                  onChange={(e) =>
                    updateField('ontarioPermitNumber', e.target.value)
                  }
                  style={TOUCH_TARGET_INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor={`${formId}-cat`} style={LABEL_STYLE}>
                  Catalytic Converter
                </label>
                <select
                  id={`${formId}-cat`}
                  data-testid="select-cat-disposition"
                  value={form.catalyticConverterDisposition}
                  disabled={isSubmitting}
                  onChange={(e) =>
                    updateField(
                      'catalyticConverterDisposition',
                      e.target.value as CatalyticConverterDisposition,
                    )
                  }
                  style={TOUCH_TARGET_INPUT_STYLE}
                >
                  <option value="PRESENT_AT_INTAKE">PRESENT_AT_INTAKE</option>
                  <option value="MISSING_AT_INTAKE">MISSING_AT_INTAKE</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              data-testid="toggle-fluids-drained"
              aria-pressed={form.fluidsDrained}
              disabled={isSubmitting}
              onClick={() => updateField('fluidsDrained', !form.fluidsDrained)}
              style={{
                minHeight: '56px',
                minWidth: '56px',
                padding: '12px 16px',
                fontSize: '15px',
                fontWeight: 700,
                backgroundColor: form.fluidsDrained ? '#166534' : '#FFFFFF',
                color: form.fluidsDrained ? '#FFFFFF' : '#0F172A',
                border: '2px solid #0F172A',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              {form.fluidsDrained
                ? 'Fluids Drained (O. Reg. 85/16 Cleared)'
                : 'Mark Fluids Drained (Optional)'}
            </button>

            <button
              type="button"
              data-testid="toggle-driveon-fail"
              aria-pressed={form.driveOnFailed}
              disabled={isSubmitting}
              onClick={() => updateField('driveOnFailed', !form.driveOnFailed)}
              style={{
                minHeight: '56px',
                minWidth: '56px',
                padding: '12px 16px',
                fontSize: '15px',
                fontWeight: 700,
                backgroundColor: form.driveOnFailed ? '#92400E' : '#FFFFFF',
                color: form.driveOnFailed ? '#FFFFFF' : '#0F172A',
                border: '2px solid #0F172A',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              {form.driveOnFailed
                ? 'DriveON Initial Fail Sheet Attached (10-Day Timer Active)'
                : 'Log DriveON Initial Fail Sheet (10-Day Timer)'}
            </button>

            {form.driveOnFailed && (
              <div
                data-testid="driveon-fail-fields"
                style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
              >
                <div>
                  <label htmlFor={`${formId}-driveon-ts`} style={LABEL_STYLE}>
                    DriveON Initial Fail Timestamp (ISO)
                  </label>
                  <input
                    id={`${formId}-driveon-ts`}
                    data-testid="input-driveon-fail-at"
                    type="text"
                    value={form.driveOnInitialFailAt}
                    disabled={isSubmitting}
                    onChange={(e) =>
                      updateField('driveOnInitialFailAt', e.target.value)
                    }
                    placeholder="2026-11-16T12:00:00.000Z"
                    style={TOUCH_TARGET_INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor={`${formId}-driveon-key`} style={LABEL_STYLE}>
                    DriveON Fail Sheet Private Evidence Key
                  </label>
                  <input
                    id={`${formId}-driveon-key`}
                    data-testid="input-driveon-sheet-key"
                    type="text"
                    value={form.driveOnFailSheetStorageKey}
                    disabled={isSubmitting}
                    onChange={(e) =>
                      updateField('driveOnFailSheetStorageKey', e.target.value)
                    }
                    placeholder={`${organizationId}/evidence/...`}
                    style={TOUCH_TARGET_INPUT_STYLE}
                  />
                </div>
              </div>
            )}
          </fieldset>
        )}

        {canCfoOverride && (
          <section
            data-testid="cfo-override-section"
            style={{
              border: '2px solid #1E40AF',
              borderRadius: '8px',
              padding: '12px',
              backgroundColor: '#EFF6FF',
            }}
          >
            <button
              type="button"
              data-testid="toggle-cfo-drawer"
              aria-expanded={drawerOpen}
              disabled={isSubmitting}
              onClick={() => setDrawerOpen((prev) => !prev)}
              style={{
                minHeight: '56px',
                minWidth: '56px',
                width: '100%',
                padding: '12px 16px',
                fontSize: '15px',
                fontWeight: 700,
                backgroundColor: '#1E40AF',
                color: '#FFFFFF',
                border: '2px solid #1E3A8A',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              1-Tap ARCHITECT_CFO Override Drawer
            </button>

            {drawerOpen && (
              <div
                data-testid="cfo-override-drawer"
                style={{
                  marginTop: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <button
                  type="button"
                  data-testid="toggle-cfo-override-approve"
                  aria-pressed={form.cfoOverrideApproved}
                  disabled={isSubmitting}
                  onClick={() =>
                    updateField('cfoOverrideApproved', !form.cfoOverrideApproved)
                  }
                  style={{
                    minHeight: '56px',
                    minWidth: '56px',
                    padding: '12px 16px',
                    fontSize: '15px',
                    fontWeight: 700,
                    backgroundColor: form.cfoOverrideApproved
                      ? '#991B1B'
                      : '#FFFFFF',
                    color: form.cfoOverrideApproved ? '#FFFFFF' : '#0F172A',
                    border: '2px solid #0F172A',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
                >
                  {form.cfoOverrideApproved
                    ? 'CFO Override Armed (Reserve / Cap / Lane / Capacity)'
                    : 'Arm 1-Tap CFO Override'}
                </button>

                <div>
                  <label htmlFor={`${formId}-cfo-reason`} style={LABEL_STYLE}>
                    CFO Override Reason Note
                  </label>
                  <input
                    id={`${formId}-cfo-reason`}
                    data-testid="input-cfo-override-reason"
                    type="text"
                    value={form.cfoOverrideReasonNote}
                    disabled={isSubmitting}
                    onChange={(e) =>
                      updateField('cfoOverrideReasonNote', e.target.value)
                    }
                    placeholder="Emergency donor approval reason"
                    style={TOUCH_TARGET_INPUT_STYLE}
                  />
                </div>
              </div>
            )}
          </section>
        )}

        <button
          type="submit"
          data-testid="submit-vehicle-intake"
          disabled={isSubmitting}
          onFocus={() => setFocusedField('submit')}
          onBlur={() => setFocusedField(null)}
          style={{
            minHeight: '56px',
            minWidth: '56px',
            padding: '14px 20px',
            fontSize: '17px',
            fontWeight: 800,
            backgroundColor: '#1E40AF',
            color: '#FFFFFF',
            border: '2px solid #1E3A8A',
            borderRadius: '8px',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            opacity: isSubmitting ? 0.65 : 1,
            ...focusOutline('submit'),
          }}
        >
          {isSubmitting ? 'Recording Intake...' : 'Confirm & Stage Asset'}
        </button>
      </form>
    </main>
  );
}
