'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  ScrapStreamCategory,
  TdgHazmatCode,
  UserRole,
} from '@prisma/client';
import { QrScannerInput } from '@/app/components/QrScannerInput';
import {
  lookupDefaultSteeringSide,
  lookupDefaultTdgHazmatCode,
  lookupSuggestedHsCode,
} from '@/core/config/policy-loader';
import type {
  CompleteHulkResult,
  InspectReturnResult,
  LogScrapResult,
  PrivateTicketUrlResult,
  ReceiveReturnResult,
  SafeDonorSummaryRow,
  SafePartListRow,
  SafeScrapHistoryRow,
  ScrapPaymentReceiptMode,
  ShortAraGrade,
  StripPartResult,
  StripSteeringSideInput,
} from '@/modules/dismantling/part-strip/part-strip.contracts';

export interface PartStripFormProps {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly actorRole: UserRole;
  readonly endpointUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly generateIdempotencyKey?: () => string;
}

type WorkflowTab = 'STRIP' | 'RETURN_QC' | 'SCRAP' | 'HULK';

interface IdempotentActionAttempt {
  key: string;
  sig: string | null;
  deviceTimestamp: string;
}

function createIdempotentAttempt(
  generateKey: () => string,
): IdempotentActionAttempt {
  return {
    key: generateKey(),
    sig: null,
    deviceTimestamp: new Date().toISOString(),
  };
}

function resolveIdempotentAttempt(
  ref: React.MutableRefObject<IdempotentActionAttempt>,
  sig: string,
  generateKey: () => string,
): { readonly key: string; readonly deviceTimestamp: string } {
  if (ref.current.sig !== null && ref.current.sig !== sig) {
    ref.current = {
      key: generateKey(),
      sig,
      deviceTimestamp: new Date().toISOString(),
    };
  } else if (ref.current.sig === null) {
    ref.current = {
      key: ref.current.key,
      sig,
      deviceTimestamp: new Date().toISOString(),
    };
  }
  return {
    key: ref.current.key,
    deviceTimestamp: ref.current.deviceTimestamp,
  };
}

const CANONICAL_PART_CATEGORIES = [
  'Alternator',
  'Complete Engine Assembly',
  'Transmission / Gearbox / Transaxle',
  'Steering Rack',
  'Front Headlamp',
  'Front Bumper',
  'Complete Door',
  'ECU',
  'Safety Airbag',
  'Pyrotechnic Pretensioners',
  'Lead-Acid Wet Battery',
  'Lithium-Ion Battery Pack',
  'Catalytic Converter',
] as const;

const CUSTOM_CATEGORY_SENTINEL = '__CUSTOM__' as const;

const ARA_GRADES: readonly ShortAraGrade[] = ['A', 'B1', 'B2', 'B3', 'C'];

const TDG_CODES: readonly { code: TdgHazmatCode; label: string }[] = [
  { code: 'NONE', label: 'NONE (Parcel OK)' },
  { code: 'UN3268_AIRBAG', label: 'UN3268 Airbag (Quarantine)' },
  { code: 'UN0503_PYROTECHNIC', label: 'UN0503 Pyrotechnic (Quarantine)' },
  { code: 'UN2794_WET_BATTERY', label: 'UN2794 Wet Battery (Local)' },
  { code: 'UN3480_LITHIUM_BATTERY', label: 'UN3480 Lithium Battery (Local)' },
];

const SCRAP_STREAMS: readonly {
  readonly stream: ScrapStreamCategory;
  readonly label: string;
}[] = [
  { stream: 'CATALYTIC_CONVERTER', label: '1. Catalytic Converter' },
  { stream: 'ALUMINUM_ALLOY_WHEELS', label: '2. Alloy Wheels' },
  { stream: 'COPPER_WIRING_HARNESS', label: '3. Copper Loom' },
  { stream: 'ROTORS_AND_BATTERY', label: '4. Rotors & Battery' },
  { stream: 'BARE_STEEL_SHELL', label: '5. Bare Steel Shell' },
];

const WARNING_LABELS: Readonly<Record<string, string>> = {
  COMPLIANCE_WARNING_UNDRAINED_FARM:
    'Environmental Warning (RULE-ENV-001): Undrained donor fluid-bearing powertrain staged in dry bin.',
  PROPOSED_INACTIVE_LOCATION_WARNING:
    'Proposed Site Warning: Bin is at a PROPOSED_INACTIVE location.',
  UNRECONCILED_CATALYTIC_CONVERTER:
    'Catalytic Converter Warning: Converter disposition is unreconciled.',
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
    return null;
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

function createSafeObjectUrl(file: File): string | null {
  if (
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    try {
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }
  return null;
}

function revokeSafeObjectUrl(url: string | null): void {
  if (
    url &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore cleanup failures
    }
  }
}

const TOUCH_INPUT_STYLE: React.CSSProperties = {
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

const TOUCH_BTN_BASE: React.CSSProperties = {
  minHeight: '56px',
  minWidth: '56px',
  padding: '12px 16px',
  fontSize: '15px',
  fontWeight: 700,
  borderRadius: '8px',
  border: '2px solid #0F172A',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  cursor: 'pointer',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '15px',
  fontWeight: 700,
  color: '#0F172A',
  marginBottom: '6px',
};

const CARD_STYLE: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  border: '2px solid #0F172A',
  borderRadius: '10px',
  padding: '16px',
  marginBottom: '16px',
};

export function PartStripForm({
  organizationId,
  organizationName,
  actorRole,
  endpointUrl = '/api/salvage/parts',
  fetchFn,
  generateIdempotencyKey = createClientUuid,
}: PartStripFormProps): React.ReactElement {
  const formId = useId();
  const [activeTab, setActiveTab] = useState<WorkflowTab>('STRIP');

  // Workspace-scoped loaded operational data
  const [donors, setDonors] = useState<readonly SafeDonorSummaryRow[]>([]);
  const [parts, setParts] = useState<readonly SafePartListRow[]>([]);
  const [qcQueue, setQcQueue] = useState<readonly SafePartListRow[]>([]);
  const [scrapHistory, setScrapHistory] = useState<readonly SafeScrapHistoryRow[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // Shared donor selection (retained across successive stripped parts)
  const [selectedDonorId, setSelectedDonorId] = useState('');

  // Tab 1: 3-Tap Part Strip state
  const [selectedCategoryOption, setSelectedCategoryOption] =
    useState<string>('Alternator');
  const [customCategoryName, setCustomCategoryName] = useState('');
  const [araGrade, setAraGrade] = useState<ShortAraGrade>('B1');
  const [tdgHazmatCode, setTdgHazmatCode] = useState<TdgHazmatCode>('NONE');
  const [steeringSide, setSteeringSide] =
    useState<StripSteeringSideInput>('UNIVERSAL');
  const [suggestedHsCode, setSuggestedHsCode] = useState('8708.99');
  const [compBaselineCad, setCompBaselineCad] = useState('150.00');
  const [weightKg, setWeightKg] = useState('5.4');
  const [conditionNotes, setConditionNotes] = useState('');
  const [qrSkuCode, setQrSkuCode] = useState('');
  const [destinationBinBarcode, setDestinationBinBarcode] = useState('');
  const [photos, setPhotos] = useState<
    readonly [File | null, File | null, File | null]
  >([null, null, null]);
  const [photoPreviewUrls, setPhotoPreviewUrls] = useState<
    readonly [string | null, string | null, string | null]
  >([null, null, null]);
  const [stripResult, setStripResult] = useState<StripPartResult | null>(null);

  // Tab 2: Return QC Intake & Inspection state
  const [returnPartId, setReturnPartId] = useState('');
  const [returnExpectedVersion, setReturnExpectedVersion] = useState('1');
  const [returnQcLocationBarcode, setReturnQcLocationBarcode] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnIntakeResult, setReturnIntakeResult] =
    useState<ReceiveReturnResult | null>(null);

  const [selectedQcPartId, setSelectedQcPartId] = useState('');
  const [qcAttested, setQcAttested] = useState(false);
  const [qcInspectionNotes, setQcInspectionNotes] = useState('');
  const [qcRestockBinBarcode, setQcRestockBinBarcode] = useState('');
  const [qcInspectResult, setQcInspectResult] =
    useState<InspectReturnResult | null>(null);

  // Tab 3: 5-Stream Scrap Logger state
  const [scrapStream, setScrapStream] =
    useState<ScrapStreamCategory>('CATALYTIC_CONVERTER');
  const [scrapWeightKg, setScrapWeightKg] = useState('4.2');
  const [scrapPayoutCad, setScrapPayoutCad] = useState('180.00');
  const [recyclerName, setRecyclerName] = useState('Kemptville Metals Inc.');
  const [paymentReceiptMode, setPaymentReceiptMode] =
    useState<ScrapPaymentReceiptMode>('CASH');
  const [bankDepositConfirmed, setBankDepositConfirmed] = useState(false);
  const [bankDepositReference, setBankDepositReference] = useState('');
  const [scrapTicketFile, setScrapTicketFile] = useState<File | null>(null);
  const [scrapResult, setScrapResult] = useState<LogScrapResult | null>(null);
  const [ticketViewResult, setTicketViewResult] =
    useState<PrivateTicketUrlResult | null>(null);

  // Tab 4: Hulk Clearance state
  const [selectedBareShellLogId, setSelectedBareShellLogId] = useState('');
  const [hulkResult, setHulkResult] = useState<CompleteHulkResult | null>(null);

  // Shared mutation status + per-action idempotency refs
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>(
    'Ready for part strip, return QC, scrap logging, or hulk clearance.',
  );

  const submitLockRef = useRef(false);
  const previewUrlsRef = useRef<readonly (string | null)[]>([null, null, null]);
  previewUrlsRef.current = photoPreviewUrls;

  const stripAttemptRef = useRef<IdempotentActionAttempt>(
    createIdempotentAttempt(generateIdempotencyKey),
  );
  const returnIntakeAttemptRef = useRef<IdempotentActionAttempt>(
    createIdempotentAttempt(generateIdempotencyKey),
  );
  const qcInspectAttemptRef = useRef<IdempotentActionAttempt>(
    createIdempotentAttempt(generateIdempotencyKey),
  );
  const scrapAttemptRef = useRef<IdempotentActionAttempt>(
    createIdempotentAttempt(generateIdempotencyKey),
  );
  const hulkAttemptRef = useRef<IdempotentActionAttempt>(
    createIdempotentAttempt(generateIdempotencyKey),
  );

  const transport = fetchFn ?? fetch;

  const effectiveCategoryName =
    selectedCategoryOption === CUSTOM_CATEGORY_SENTINEL
      ? customCategoryName.trim()
      : selectedCategoryOption;

  const lockedDefaultTdg =
    selectedCategoryOption === CUSTOM_CATEGORY_SENTINEL
      ? undefined
      : lookupDefaultTdgHazmatCode(selectedCategoryOption);
  const isTdgLockedHazardous =
    lockedDefaultTdg !== undefined && lockedDefaultTdg !== 'NONE';

  const loadWorkspaceData = useCallback(async () => {
    setLoadingData(true);
    setDataError(null);
    try {
      const [donorsRes, partsRes, qcRes, scrapRes] = await Promise.all([
        transport(`${endpointUrl}?view=donors&limit=50`, { method: 'GET' }),
        transport(`${endpointUrl}?view=parts&limit=50`, { method: 'GET' }),
        transport(`${endpointUrl}?view=qc-queue&limit=50`, { method: 'GET' }),
        transport(`${endpointUrl}?view=scrap-history&limit=50`, {
          method: 'GET',
        }),
      ]);

      if (!donorsRes.ok || !partsRes.ok || !qcRes.ok || !scrapRes.ok) {
        setDataError('Failed to load salvage workspace inventory views.');
        return;
      }

      const [donorsJson, partsJson, qcJson, scrapJson] = (await Promise.all([
        donorsRes.json(),
        partsRes.json(),
        qcRes.json(),
        scrapRes.json(),
      ])) as [
        { donors?: SafeDonorSummaryRow[] },
        { parts?: SafePartListRow[] },
        { parts?: SafePartListRow[] },
        { scrapLogs?: SafeScrapHistoryRow[] },
      ];

      const nextDonors = donorsJson.donors ?? [];
      const nextParts = partsJson.parts ?? [];
      const nextQc = qcJson.parts ?? [];
      const nextScrap = scrapJson.scrapLogs ?? [];

      setDonors(nextDonors);
      setParts(nextParts);
      setQcQueue(nextQc);
      setScrapHistory(nextScrap);

      setSelectedDonorId((prev) => {
        if (prev && nextDonors.some((d) => d.id === prev)) {
          return prev;
        }
        return (
          nextDonors.find((d) => d.lifecycleState !== 'SCRAPPED_METAL_CLEARED')
            ?.id ??
          nextDonors[0]?.id ??
          ''
        );
      });
      setSelectedQcPartId((prev) => {
        if (prev && nextQc.some((p) => p.id === prev)) {
          return prev;
        }
        return nextQc[0]?.id ?? '';
      });
    } catch (err) {
      setDataError(
        err instanceof Error
          ? err.message
          : 'Network error loading salvage inventory data.',
      );
    } finally {
      setLoadingData(false);
    }
  }, [endpointUrl, transport]);

  const clearPreviewUrls = useCallback(() => {
    for (const url of previewUrlsRef.current) {
      revokeSafeObjectUrl(url);
    }
    setPhotoPreviewUrls([null, null, null]);
  }, []);

  // Reset drafts and refetch tenant-scoped data whenever workspace changes
  useEffect(() => {
    clearPreviewUrls();
    setSelectedDonorId('');
    setQrSkuCode('');
    setDestinationBinBarcode('');
    setPhotos([null, null, null]);
    setStripResult(null);
    setReturnPartId('');
    setReturnExpectedVersion('1');
    setReturnQcLocationBarcode('');
    setReturnReason('');
    setReturnIntakeResult(null);
    setSelectedQcPartId('');
    setQcAttested(false);
    setQcInspectionNotes('');
    setQcRestockBinBarcode('');
    setQcInspectResult(null);
    setScrapTicketFile(null);
    setScrapResult(null);
    setTicketViewResult(null);
    setSelectedBareShellLogId('');
    setHulkResult(null);
    setErrorBanner(null);

    stripAttemptRef.current = createIdempotentAttempt(generateIdempotencyKey);
    returnIntakeAttemptRef.current = createIdempotentAttempt(
      generateIdempotencyKey,
    );
    qcInspectAttemptRef.current = createIdempotentAttempt(
      generateIdempotencyKey,
    );
    scrapAttemptRef.current = createIdempotentAttempt(generateIdempotencyKey);
    hulkAttemptRef.current = createIdempotentAttempt(generateIdempotencyKey);

    void loadWorkspaceData();
  }, [
    organizationId,
    clearPreviewUrls,
    generateIdempotencyKey,
    loadWorkspaceData,
  ]);

  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) {
        revokeSafeObjectUrl(url);
      }
    };
  }, []);

  const selectedDonor =
    donors.find((d) => d.id === selectedDonorId) ?? null;

  const selectedQcPart =
    qcQueue.find((p) => p.id === selectedQcPartId) ?? null;

  const donorBareShellLogs = scrapHistory.filter(
    (s) =>
      s.vehicleId === selectedDonorId && s.scrapStream === 'BARE_STEEL_SHELL',
  );

  useEffect(() => {
    if (
      selectedBareShellLogId &&
      donorBareShellLogs.some((l) => l.id === selectedBareShellLogId)
    ) {
      return;
    }
    setSelectedBareShellLogId(donorBareShellLogs[0]?.id ?? '');
  }, [donorBareShellLogs, selectedBareShellLogId]);

  const handleCategorySelection = useCallback((nextValue: string) => {
    setSelectedCategoryOption(nextValue);
    if (nextValue === CUSTOM_CATEGORY_SENTINEL) {
      return;
    }
    const defSteer = lookupDefaultSteeringSide(nextValue);
    const defTdg = lookupDefaultTdgHazmatCode(nextValue);
    const defHs = lookupSuggestedHsCode(nextValue);
    if (defSteer === 'UNIVERSAL' || defSteer === 'LHD_ONLY') {
      setSteeringSide(defSteer);
    } else if (defTdg !== undefined) {
      setSteeringSide('UNIVERSAL');
    }
    if (defTdg !== undefined) {
      setTdgHazmatCode(defTdg);
    }
    if (defHs !== undefined) {
      setSuggestedHsCode(defHs);
    }
  }, []);

  const handlePhotoFileChange = useCallback(
    (slotIndex: 0 | 1 | 2, file: File | null) => {
      setPhotos((prev) => {
        const next: [File | null, File | null, File | null] = [
          prev[0],
          prev[1],
          prev[2],
        ];
        next[slotIndex] = file;
        return next;
      });
      setPhotoPreviewUrls((prev) => {
        revokeSafeObjectUrl(prev[slotIndex]);
        const next: [string | null, string | null, string | null] = [
          prev[0],
          prev[1],
          prev[2],
        ];
        next[slotIndex] = file ? createSafeObjectUrl(file) : null;
        return next;
      });
    },
    [],
  );

  const isStripReadyForCommit = useCallback(
    (binOverride?: string): boolean => {
      const bin = (binOverride ?? destinationBinBarcode).trim();
      const baseline = dollarsToCents(compBaselineCad);
      const parsedWeight = Number(weightKg);
      return Boolean(
        selectedDonor &&
          photos[0] &&
          photos[1] &&
          photos[2] &&
          effectiveCategoryName.length > 0 &&
          suggestedHsCode.trim().length > 0 &&
          baseline !== null &&
          baseline > 0 &&
          Number.isFinite(parsedWeight) &&
          parsedWeight > 0 &&
          /^PRT-\d{6}$/i.test(qrSkuCode.trim()) &&
          bin.length > 0,
      );
    },
    [
      compBaselineCad,
      destinationBinBarcode,
      effectiveCategoryName,
      photos,
      qrSkuCode,
      selectedDonor,
      suggestedHsCode,
      weightKg,
    ],
  );

  const submitPartStrip = useCallback(
    async (binOverride?: string) => {
      if (submitLockRef.current || isSubmitting) {
        return;
      }
      const bin = (binOverride ?? destinationBinBarcode).trim().toUpperCase();
      if (!selectedDonor) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Select a donor vehicle first.',
        });
        return;
      }
      if (!photos[0] || !photos[1] || !photos[2]) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'All 3 part photos are required.',
        });
        return;
      }
      const baselineMinor = dollarsToCents(compBaselineCad);
      if (baselineMinor === null || baselineMinor <= 0) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Baseline market value must be greater than $0.00.',
        });
        return;
      }
      const parsedWeight = Number(weightKg);
      if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Part weight (kg) must be a positive number.',
        });
        return;
      }
      if (!effectiveCategoryName) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Part category name is required.',
        });
        return;
      }
      if (!qrSkuCode.trim()) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Bind a PRT-XXXXXX hang-tag QR before committing.',
        });
        return;
      }
      if (!bin) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Scan a destination bin barcode to shelve the part.',
        });
        return;
      }

      const metadata = {
        action: 'strip' as const,
        donorVehicleId: selectedDonor.id,
        donorExpectedVersion: selectedDonor.version,
        partCategoryName: effectiveCategoryName,
        qrSkuCode: qrSkuCode.trim().toUpperCase(),
        araGrade,
        ...(conditionNotes.trim().length > 0
          ? { conditionNotes: conditionNotes.trim() }
          : {}),
        steeringSideCompatibility: steeringSide,
        tdgHazmatCode,
        suggestedHsCode: suggestedHsCode.trim(),
        compBaselineCadMinor: baselineMinor,
        weightKg: parsedWeight,
        destinationBinBarcode: bin,
      };

      const intentSig = JSON.stringify({
        ...metadata,
        photoNames: photos.map((p) => `${p?.name ?? ''}:${p?.size ?? 0}`),
      });
      const { key, deviceTimestamp } = resolveIdempotentAttempt(
        stripAttemptRef,
        intentSig,
        generateIdempotencyKey,
      );

      const formData = new FormData();
      formData.append(
        'metadata',
        JSON.stringify({
          ...metadata,
          idempotencyKey: key,
          deviceTimestamp,
        }),
      );
      formData.append('photos', photos[0]);
      formData.append('photos', photos[1]);
      formData.append('photos', photos[2]);

      submitLockRef.current = true;
      setIsSubmitting(true);
      setErrorBanner(null);

      try {
        const res = await transport(endpointUrl, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: formData,
        });
        const payload = (await res.json()) as
          | StripPartResult
          | { error?: { code?: string; message?: string } };
        if (!res.ok) {
          const errObj = (
            payload as { error?: { code?: string; message?: string } }
          ).error;
          setErrorBanner({
            code: errObj?.code ?? `HTTP_${res.status}`,
            message:
              errObj?.message ?? `Part strip failed with HTTP ${res.status}.`,
          });
          setStatusMessage(
            `Strip failed: ${errObj?.message ?? `HTTP ${res.status}`}`,
          );
          return;
        }

        const result = payload as StripPartResult;
        setStripResult(result);
        setStatusMessage(
          `Shelved ${result.qrSkuCode} into ${result.destinationBinBarcode} (${result.complianceState}).`,
        );

        // Retain donor & category for next part; clear part-specific fields & mint next key
        stripAttemptRef.current = createIdempotentAttempt(
          generateIdempotencyKey,
        );
        setQrSkuCode('');
        setDestinationBinBarcode('');
        setConditionNotes('');
        clearPreviewUrls();
        setPhotos([null, null, null]);
        await loadWorkspaceData();
      } catch (err) {
        setErrorBanner({
          code: 'NETWORK_ERROR',
          message:
            err instanceof Error && err.message.trim().length > 0
              ? err.message
              : 'Network error submitting part strip. Retry safely with the same idempotency key.',
        });
      } finally {
        submitLockRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      araGrade,
      clearPreviewUrls,
      compBaselineCad,
      conditionNotes,
      destinationBinBarcode,
      effectiveCategoryName,
      endpointUrl,
      generateIdempotencyKey,
      isSubmitting,
      loadWorkspaceData,
      photos,
      qrSkuCode,
      selectedDonor,
      steeringSide,
      suggestedHsCode,
      tdgHazmatCode,
      transport,
      weightKg,
    ],
  );

  const submitReturnIntake = useCallback(async () => {
    if (submitLockRef.current || isSubmitting) {
      return;
    }
    const partId = returnPartId.trim();
    const expectedVersion = Number.parseInt(returnExpectedVersion.trim(), 10);
    const qcLoc = returnQcLocationBarcode.trim().toUpperCase();
    if (!partId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !qcLoc) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message:
          'Part ID, positive expected version, and QC hold destination barcode are required.',
      });
      return;
    }

    const body = {
      action: 'receive-return' as const,
      partId,
      expectedVersion,
      qcLocationBarcode: qcLoc,
      ...(returnReason.trim().length > 0
        ? { returnReason: returnReason.trim() }
        : {}),
    };
    const sig = JSON.stringify(body);
    const { key, deviceTimestamp } = resolveIdempotentAttempt(
      returnIntakeAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    submitLockRef.current = true;
    setIsSubmitting(true);
    setErrorBanner(null);

    try {
      const res = await transport(endpointUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          ...body,
          idempotencyKey: key,
          deviceTimestamp,
        }),
      });
      const payload = (await res.json()) as
        | ReceiveReturnResult
        | { error?: { code?: string; message?: string } };
      if (!res.ok) {
        const errObj = (
          payload as { error?: { code?: string; message?: string } }
        ).error;
        setErrorBanner({
          code: errObj?.code ?? `HTTP_${res.status}`,
          message: errObj?.message ?? `Return intake failed with HTTP ${res.status}.`,
        });
        return;
      }

      const result = payload as ReceiveReturnResult;
      setReturnIntakeResult(result);
      setStatusMessage(
        `Part ${result.qrSkuCode} placed into ${result.custodyState} (${result.availabilityState}).`,
      );
      returnIntakeAttemptRef.current = createIdempotentAttempt(
        generateIdempotencyKey,
      );
      await loadWorkspaceData();
    } catch (err) {
      setErrorBanner({
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error ? err.message : 'Network error during return intake.',
      });
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    endpointUrl,
    generateIdempotencyKey,
    isSubmitting,
    loadWorkspaceData,
    returnExpectedVersion,
    returnPartId,
    returnQcLocationBarcode,
    returnReason,
    transport,
  ]);

  const submitReturnInspection = useCallback(
    async (qcPassed: boolean) => {
      if (submitLockRef.current || isSubmitting) {
        return;
      }
      if (!selectedQcPart) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Select a part from the Return QC queue first.',
        });
        return;
      }
      if (!qcAttested) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message:
            'Confirm physical inspection against original photos and OEM/tamper markings.',
        });
        return;
      }
      if (qcInspectionNotes.trim().length < 5) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Inspection notes must be at least 5 characters.',
        });
        return;
      }
      const bin = qcRestockBinBarcode.trim().toUpperCase();
      if (qcPassed && !bin) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message: 'Scan a destination origin bin before passing QC.',
        });
        return;
      }

      const body = {
        action: 'inspect-return' as const,
        partId: selectedQcPart.id,
        expectedVersion: selectedQcPart.version,
        qcPassed,
        inspectedOriginalPhotosAndMarkings: true as const,
        inspectionNotes: qcInspectionNotes.trim(),
        ...(bin ? { destinationBinBarcode: bin } : {}),
      };
      const sig = JSON.stringify(body);
      const { key, deviceTimestamp } = resolveIdempotentAttempt(
        qcInspectAttemptRef,
        sig,
        generateIdempotencyKey,
      );

      submitLockRef.current = true;
      setIsSubmitting(true);
      setErrorBanner(null);

      try {
        const res = await transport(endpointUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            ...body,
            idempotencyKey: key,
            deviceTimestamp,
          }),
        });
        const payload = (await res.json()) as
          | InspectReturnResult
          | { error?: { code?: string; message?: string } };
        if (!res.ok) {
          const errObj = (
            payload as { error?: { code?: string; message?: string } }
          ).error;
          setErrorBanner({
            code: errObj?.code ?? `HTTP_${res.status}`,
            message:
              errObj?.message ?? `QC inspection failed with HTTP ${res.status}.`,
          });
          return;
        }

        const result = payload as InspectReturnResult;
        setQcInspectResult(result);
        setStatusMessage(
          `Return QC ${result.qcPassed ? 'PASSED' : 'FAILED'}: ${result.qrSkuCode} -> ${result.custodyState} (${result.availabilityState}).`,
        );
        qcInspectAttemptRef.current = createIdempotentAttempt(
          generateIdempotencyKey,
        );
        setQcAttested(false);
        setQcInspectionNotes('');
        setQcRestockBinBarcode('');
        await loadWorkspaceData();
      } catch (err) {
        setErrorBanner({
          code: 'NETWORK_ERROR',
          message:
            err instanceof Error
              ? err.message
              : 'Network error during QC inspection.',
        });
      } finally {
        submitLockRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      endpointUrl,
      generateIdempotencyKey,
      isSubmitting,
      loadWorkspaceData,
      qcAttested,
      qcInspectionNotes,
      qcRestockBinBarcode,
      selectedQcPart,
      transport,
    ],
  );

  const submitScrapLog = useCallback(async () => {
    if (submitLockRef.current || isSubmitting) {
      return;
    }
    if (!selectedDonor) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message: 'Select a donor vehicle first.',
      });
      return;
    }
    if (!scrapTicketFile) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message: 'Upload a private recycler ticket image or PDF.',
      });
      return;
    }
    const parsedWeight = Number(scrapWeightKg);
    const payoutMinor = dollarsToCents(scrapPayoutCad);
    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message: 'Scrap weight (kg) must be greater than 0.',
      });
      return;
    }
    if (payoutMinor === null || payoutMinor < 0) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message: 'Scrap payout must be a non-negative CAD dollar amount.',
      });
      return;
    }
    if (!recyclerName.trim()) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message: 'Recycler name is required.',
      });
      return;
    }
    if (paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT') {
      if (!bankDepositConfirmed || !bankDepositReference.trim()) {
        setErrorBanner({
          code: 'INVALID_PART_STRIP_INPUT',
          message:
            'Confirmed bank deposit requires deposit reference and confirmation checkbox.',
        });
        return;
      }
    }

    const metadata = {
      action: 'log-scrap' as const,
      donorVehicleId: selectedDonor.id,
      donorExpectedVersion: selectedDonor.version,
      scrapStream,
      weightKg: parsedWeight,
      payoutCadMinor: payoutMinor,
      recyclerName: recyclerName.trim(),
      paymentReceiptMode,
      ...(paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT'
        ? {
            bankDepositConfirmed: true,
            bankDepositReference: bankDepositReference.trim(),
          }
        : {}),
    };
    const sig = JSON.stringify({
      ...metadata,
      ticket: `${scrapTicketFile.name}:${scrapTicketFile.size}`,
    });
    const { key, deviceTimestamp } = resolveIdempotentAttempt(
      scrapAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    const formData = new FormData();
    formData.append(
      'metadata',
      JSON.stringify({
        ...metadata,
        idempotencyKey: key,
        deviceTimestamp,
      }),
    );
    formData.append('ticket', scrapTicketFile);

    submitLockRef.current = true;
    setIsSubmitting(true);
    setErrorBanner(null);

    try {
      const res = await transport(endpointUrl, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: formData,
      });
      const payload = (await res.json()) as
        | LogScrapResult
        | { error?: { code?: string; message?: string } };
      if (!res.ok) {
        const errObj = (
          payload as { error?: { code?: string; message?: string } }
        ).error;
        setErrorBanner({
          code: errObj?.code ?? `HTTP_${res.status}`,
          message: errObj?.message ?? `Scrap log failed with HTTP ${res.status}.`,
        });
        return;
      }

      const result = payload as LogScrapResult;
      setScrapResult(result);
      setStatusMessage(
        `Logged ${result.scrapStream} ($${(result.payoutCadMinor / 100).toFixed(2)} CAD, ${result.cashCustodyState}).`,
      );
      scrapAttemptRef.current = createIdempotentAttempt(generateIdempotencyKey);
      setScrapTicketFile(null);
      setBankDepositConfirmed(false);
      setBankDepositReference('');
      await loadWorkspaceData();
    } catch (err) {
      setErrorBanner({
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error
            ? err.message
            : 'Network error logging scrap component.',
      });
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    bankDepositConfirmed,
    bankDepositReference,
    endpointUrl,
    generateIdempotencyKey,
    isSubmitting,
    loadWorkspaceData,
    paymentReceiptMode,
    recyclerName,
    scrapPayoutCad,
    scrapStream,
    scrapTicketFile,
    scrapWeightKg,
    selectedDonor,
    transport,
  ]);

  const submitHulkClearance = useCallback(async () => {
    if (submitLockRef.current || isSubmitting) {
      return;
    }
    if (!selectedDonor) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message: 'Select a donor vehicle first.',
      });
      return;
    }
    if (!selectedBareShellLogId) {
      setErrorBanner({
        code: 'INVALID_PART_STRIP_INPUT',
        message:
          'Record and select a BARE_STEEL_SHELL scrap log before clearing the hulk.',
      });
      return;
    }

    const body = {
      action: 'complete-hulk' as const,
      donorVehicleId: selectedDonor.id,
      donorExpectedVersion: selectedDonor.version,
      bareShellScrapLogId: selectedBareShellLogId,
    };
    const sig = JSON.stringify(body);
    const { key, deviceTimestamp } = resolveIdempotentAttempt(
      hulkAttemptRef,
      sig,
      generateIdempotencyKey,
    );

    submitLockRef.current = true;
    setIsSubmitting(true);
    setErrorBanner(null);

    try {
      const res = await transport(endpointUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          ...body,
          idempotencyKey: key,
          deviceTimestamp,
        }),
      });
      const payload = (await res.json()) as
        | CompleteHulkResult
        | { error?: { code?: string; message?: string } };
      if (!res.ok) {
        const errObj = (
          payload as { error?: { code?: string; message?: string } }
        ).error;
        setErrorBanner({
          code: errObj?.code ?? `HTTP_${res.status}`,
          message:
            errObj?.message ?? `Hulk clearance failed with HTTP ${res.status}.`,
        });
        return;
      }

      const result = payload as CompleteHulkResult;
      setHulkResult(result);
      setStatusMessage(
        `Donor finalized to ${result.lifecycleState} (total scrap recovery $${(result.scrapRecoveryCadMinor / 100).toFixed(2)} CAD).`,
      );
      hulkAttemptRef.current = createIdempotentAttempt(generateIdempotencyKey);
      await loadWorkspaceData();
    } catch (err) {
      setErrorBanner({
        code: 'NETWORK_ERROR',
        message:
          err instanceof Error ? err.message : 'Network error finalizing hulk.',
      });
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    endpointUrl,
    generateIdempotencyKey,
    isSubmitting,
    loadWorkspaceData,
    selectedBareShellLogId,
    selectedDonor,
    transport,
  ]);

  const handleViewTicket = useCallback(
    async (scrapLogId: string) => {
      setErrorBanner(null);
      try {
        const res = await transport(
          `${endpointUrl}?view=ticket&scrapLogId=${encodeURIComponent(scrapLogId)}`,
          { method: 'GET' },
        );
        const payload = (await res.json()) as
          | PrivateTicketUrlResult
          | { error?: { code?: string; message?: string } };
        if (!res.ok) {
          const errObj = (
            payload as { error?: { code?: string; message?: string } }
          ).error;
          setErrorBanner({
            code: errObj?.code ?? `HTTP_${res.status}`,
            message: errObj?.message ?? 'Failed to retrieve private ticket URL.',
          });
          return;
        }
        setTicketViewResult(payload as PrivateTicketUrlResult);
      } catch (err) {
        setErrorBanner({
          code: 'NETWORK_ERROR',
          message:
            err instanceof Error ? err.message : 'Error loading ticket URL.',
        });
      }
    },
    [endpointUrl, transport],
  );

  return (
    <main
      data-testid="part-strip-page"
      data-organization-id={organizationId}
      style={{
        maxWidth: '760px',
        margin: '0 auto',
        padding: '16px',
        backgroundColor: '#F8FAFC',
        color: '#0F172A',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <header style={CARD_STYLE}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: '0 0 4px 0' }}>
          Part Strip, Return QC &amp; 5-Stream Scrap (FR-INT-02)
        </h1>
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#334155' }}>
          Workspace: {organizationName} · Role: {actorRole}
        </p>
      </header>

      {/* Mode Tabs */}
      <nav
        aria-label="Part Strip Workflow Modes"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: '8px',
          marginBottom: '16px',
        }}
      >
        {(
          [
            { id: 'STRIP', label: '3-Tap Strip', testId: 'tab-strip' },
            { id: 'RETURN_QC', label: 'Return QC', testId: 'tab-return-qc' },
            { id: 'SCRAP', label: '5-Stream Scrap', testId: 'tab-scrap' },
            { id: 'HULK', label: 'Hulk Clear', testId: 'tab-hulk' },
          ] as const
        ).map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={tab.testId}
              aria-pressed={active}
              onClick={() => setActiveTab(tab.id)}
              style={{
                ...TOUCH_BTN_BASE,
                backgroundColor: active ? '#1E40AF' : '#FFFFFF',
                color: active ? '#FFFFFF' : '#0F172A',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Live Status & Error Announcements */}
      <div
        role="status"
        aria-live="polite"
        data-testid="part-strip-live-status"
        style={{
          padding: '10px 14px',
          borderRadius: '8px',
          border: '2px solid #334155',
          backgroundColor: '#FFFFFF',
          fontSize: '14px',
          fontWeight: 600,
          marginBottom: '12px',
        }}
      >
        {loadingData ? 'Loading workspace inventory...' : statusMessage}
      </div>

      {dataError && (
        <div
          role="alert"
          data-testid="workspace-data-error"
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            border: '2px solid #991B1B',
            backgroundColor: '#FEF2F2',
            color: '#991B1B',
            fontWeight: 700,
            marginBottom: '12px',
          }}
        >
          {dataError}
        </div>
      )}

      {errorBanner && (
        <div
          role="alert"
          data-testid="part-strip-error-banner"
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            border: '2px solid #991B1B',
            backgroundColor: '#FEF2F2',
            color: '#991B1B',
            fontWeight: 700,
            marginBottom: '16px',
          }}
        >
          [{errorBanner.code}] {errorBanner.message}
        </div>
      )}

      {/* Shared Donor Vehicle Selector for STRIP, SCRAP, and HULK */}
      {activeTab !== 'RETURN_QC' && (
        <section style={CARD_STYLE} aria-label="Donor Vehicle Selection">
          <label htmlFor={`${formId}-donor`} style={LABEL_STYLE}>
            Donor Vehicle (Retained Across Parts)
          </label>
          {donors.length === 0 && !loadingData ? (
            <p data-testid="empty-donors-state" style={{ margin: 0, fontWeight: 600 }}>
              No DISMANTLE_AND_EXPORT donor vehicles found in this workspace.
            </p>
          ) : (
            <select
              id={`${formId}-donor`}
              data-testid="select-donor-vehicle"
              value={selectedDonorId}
              disabled={isSubmitting}
              onChange={(e) => setSelectedDonorId(e.target.value)}
              style={TOUCH_INPUT_STYLE}
            >
              <option value="">-- Select Donor Vehicle --</option>
              {donors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.internalStockNumber} · {d.year} {d.make} {d.model} (
                  {d.lifecycleState}, v{d.version})
                </option>
              ))}
            </select>
          )}
          {selectedDonor && (
            <p
              data-testid="selected-donor-summary"
              style={{
                margin: '8px 0 0 0',
                fontSize: '13px',
                fontWeight: 600,
                color: '#334155',
              }}
            >
              State: {selectedDonor.lifecycleState} · Cat:{' '}
              {selectedDonor.catalyticConverterDisposition} · Fluids Drained:{' '}
              {selectedDonor.fluidsDrainedAt ? 'YES' : 'NO'} · Scrap Recovery: $
              {(selectedDonor.scrapRecoveryCadMinor / 100).toFixed(2)} CAD
            </p>
          )}
        </section>
      )}

      {/* TAB 1: 3-TAP PART STRIP */}
      {activeTab === 'STRIP' && (
        <section aria-label="3-Tap Part Strip Workflow">
          <div style={CARD_STYLE}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
              Stage 1: 3 Photos &amp; Classification
            </h2>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: '10px',
                marginBottom: '14px',
              }}
            >
              {([0, 1, 2] as const).map((idx) => (
                <div key={idx}>
                  <label
                    htmlFor={`${formId}-photo-${idx}`}
                    style={LABEL_STYLE}
                  >
                    Photo {idx + 1} *
                  </label>
                  <input
                    id={`${formId}-photo-${idx}`}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    data-testid={`photo-input-${idx + 1}`}
                    disabled={isSubmitting}
                    onChange={(e) =>
                      handlePhotoFileChange(idx, e.target.files?.[0] ?? null)
                    }
                    style={{
                      ...TOUCH_INPUT_STYLE,
                      padding: '10px',
                      fontSize: '13px',
                    }}
                  />
                  {photoPreviewUrls[idx] && (
                    <img
                      src={photoPreviewUrls[idx]!}
                      alt={`Part photo ${idx + 1} preview`}
                      style={{
                        marginTop: '6px',
                        width: '72px',
                        height: '72px',
                        objectFit: 'cover',
                        borderRadius: '6px',
                        border: '1px solid #334155',
                      }}
                    />
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label htmlFor={`${formId}-category`} style={LABEL_STYLE}>
                Part Category *
              </label>
              <select
                id={`${formId}-category`}
                data-testid="select-part-category"
                value={selectedCategoryOption}
                disabled={isSubmitting}
                onChange={(e) => handleCategorySelection(e.target.value)}
                style={TOUCH_INPUT_STYLE}
              >
                {CANONICAL_PART_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
                <option value={CUSTOM_CATEGORY_SENTINEL}>
                  Custom / Other Category
                </option>
              </select>
            </div>

            {selectedCategoryOption === CUSTOM_CATEGORY_SENTINEL && (
              <div style={{ marginBottom: '12px' }}>
                <label
                  htmlFor={`${formId}-custom-category`}
                  style={LABEL_STYLE}
                >
                  Custom Part Category Name *
                </label>
                <input
                  id={`${formId}-custom-category`}
                  type="text"
                  data-testid="input-custom-category"
                  value={customCategoryName}
                  disabled={isSubmitting}
                  placeholder="Enter exact part category"
                  onChange={(e) => setCustomCategoryName(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
            )}

            {/* ARA Grade Quick-Pills */}
            <div style={{ marginBottom: '14px' }}>
              <span style={LABEL_STYLE}>ARA Condition Grade *</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {ARA_GRADES.map((g) => {
                  const active = araGrade === g;
                  return (
                    <button
                      key={g}
                      type="button"
                      data-testid={`ara-grade-pill-${g}`}
                      aria-pressed={active}
                      disabled={isSubmitting}
                      onClick={() => setAraGrade(g)}
                      style={{
                        ...TOUCH_BTN_BASE,
                        backgroundColor: active ? '#1E40AF' : '#FFFFFF',
                        color: active ? '#FFFFFF' : '#0F172A',
                      }}
                    >
                      Grade {g}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* TDG Hazmat Quick-Pills */}
            <div style={{ marginBottom: '14px' }}>
              <span style={LABEL_STYLE}>
                TDG Hazmat Classification *{' '}
                {isTdgLockedHazardous ? '(Locked by Category Safety Policy)' : ''}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {TDG_CODES.map((item) => {
                  const active = tdgHazmatCode === item.code;
                  return (
                    <button
                      key={item.code}
                      type="button"
                      data-testid={`tdg-pill-${item.code}`}
                      aria-pressed={active}
                      disabled={isSubmitting || isTdgLockedHazardous}
                      onClick={() => setTdgHazmatCode(item.code)}
                      style={{
                        ...TOUCH_BTN_BASE,
                        backgroundColor: active ? '#0F172A' : '#FFFFFF',
                        color: active ? '#FFFFFF' : '#0F172A',
                        opacity:
                          isTdgLockedHazardous && !active ? 0.5 : 1,
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '12px',
                marginBottom: '12px',
              }}
            >
              <div>
                <label htmlFor={`${formId}-steering`} style={LABEL_STYLE}>
                  Steering Side *
                </label>
                <select
                  id={`${formId}-steering`}
                  data-testid="select-steering-side"
                  value={steeringSide}
                  disabled={isSubmitting}
                  onChange={(e) =>
                    setSteeringSide(e.target.value as StripSteeringSideInput)
                  }
                  style={TOUCH_INPUT_STYLE}
                >
                  <option value="UNIVERSAL">UNIVERSAL</option>
                  <option value="LHD_ONLY">LHD_ONLY</option>
                </select>
              </div>
              <div>
                <label htmlFor={`${formId}-hs`} style={LABEL_STYLE}>
                  Suggested HS Code *
                </label>
                <input
                  id={`${formId}-hs`}
                  type="text"
                  data-testid="input-suggested-hs"
                  value={suggestedHsCode}
                  disabled={isSubmitting}
                  onChange={(e) => setSuggestedHsCode(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor={`${formId}-baseline`} style={LABEL_STYLE}>
                  Baseline Comp Value (CAD $) *
                </label>
                <input
                  id={`${formId}-baseline`}
                  type="text"
                  data-testid="input-comp-baseline"
                  value={compBaselineCad}
                  disabled={isSubmitting}
                  onChange={(e) => setCompBaselineCad(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor={`${formId}-weight`} style={LABEL_STYLE}>
                  Weight (kg) *
                </label>
                <input
                  id={`${formId}-weight`}
                  type="text"
                  data-testid="input-weight-kg"
                  value={weightKg}
                  disabled={isSubmitting}
                  onChange={(e) => setWeightKg(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
            </div>

            <div>
              <label htmlFor={`${formId}-notes`} style={LABEL_STYLE}>
                Condition Notes (Optional)
              </label>
              <input
                id={`${formId}-notes`}
                type="text"
                data-testid="input-condition-notes"
                value={conditionNotes}
                disabled={isSubmitting}
                onChange={(e) => setConditionNotes(e.target.value)}
                style={TOUCH_INPUT_STYLE}
              />
            </div>
          </div>

          {/* Stage 2: Bind Part Hang-Tag QR */}
          <div style={CARD_STYLE} data-testid="part-qr-scanner-section">
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
              Stage 2: Bind Part Hang-Tag QR (PRT-XXXXXX)
            </h2>
            <QrScannerInput
              label="Scan Part Hang-Tag QR"
              placeholder="PRT-884920"
              disabled={isSubmitting}
              onScan={({ code }) => {
                setQrSkuCode(code);
                setStatusMessage(`Bound part hang-tag ${code}.`);
              }}
            />
            <div style={{ marginTop: '10px' }}>
              <span
                data-testid="bound-part-qr-badge"
                style={{
                  display: 'inline-block',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  backgroundColor: qrSkuCode ? '#F0FDF4' : '#F8FAFC',
                  border: '1px solid #334155',
                  fontWeight: 700,
                }}
              >
                Bound Tag: {qrSkuCode || 'Not yet scanned'}
              </span>
            </div>
          </div>

          {/* Stage 3: Scan Destination Container Bin & Commit */}
          <div style={CARD_STYLE} data-testid="bin-qr-scanner-section">
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
              Stage 3: Scan Destination Container Bin &amp; Shelve
            </h2>
            <QrScannerInput
              label="Scan Destination Container Bin QR"
              placeholder="KEMP-C01-R01-S01-B01"
              disabled={isSubmitting}
              onScan={async ({ code }) => {
                setDestinationBinBarcode(code);
                if (isStripReadyForCommit(code)) {
                  await submitPartStrip(code);
                } else {
                  setStatusMessage(
                    `Destination bin ${code} scanned. Complete Stage 1 & 2 fields, then tap Commit Part Strip.`,
                  );
                }
              }}
            />

            <div
              style={{
                marginTop: '12px',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
              }}
            >
              <span
                data-testid="bound-bin-qr-badge"
                style={{ fontWeight: 700, fontSize: '14px' }}
              >
                Destination Bin: {destinationBinBarcode || 'Not yet scanned'}
              </span>

              <button
                type="button"
                data-testid="submit-part-strip"
                disabled={isSubmitting}
                onClick={() => void submitPartStrip()}
                style={{
                  ...TOUCH_BTN_BASE,
                  backgroundColor: '#1E40AF',
                  color: '#FFFFFF',
                  opacity: isSubmitting ? 0.65 : 1,
                }}
              >
                {isSubmitting ? 'Submitting...' : 'Commit Part Strip'}
              </button>
            </div>
          </div>

          {stripResult && (
            <section
              data-testid="strip-success-card"
              style={{
                ...CARD_STYLE,
                borderColor: '#166534',
                backgroundColor: '#F0FDF4',
              }}
            >
              <h3 style={{ marginTop: 0, color: '#166534' }}>
                Part Shelved: {stripResult.qrSkuCode}
              </h3>
              <p style={{ fontWeight: 700, margin: '4px 0' }}>
                Custody: {stripResult.custodyState} · Availability:{' '}
                {stripResult.availabilityState} · Compliance:{' '}
                {stripResult.complianceState}
              </p>
              <p style={{ fontWeight: 600, margin: '4px 0' }}>
                TDG: {stripResult.tdgHazmatCode} · Allocated Cost Basis: $
                {(stripResult.allocatedCostBasisCadMinor / 100).toFixed(2)} CAD
                · Bin: {stripResult.destinationBinBarcode}
              </p>
              {stripResult.complianceWarnings.length > 0 && (
                <ul data-testid="strip-warning-list">
                  {stripResult.complianceWarnings.map((w) => (
                    <li
                      key={w}
                      data-testid={`warning-badge-${w}`}
                      style={{ fontWeight: 700, color: '#92400E' }}
                    >
                      {WARNING_LABELS[w] ?? w}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </section>
      )}

      {/* TAB 2: RETURN QC INTAKE & INSPECTION */}
      {activeTab === 'RETURN_QC' && (
        <section aria-label="Return QC Hold Workflow">
          <div style={CARD_STYLE}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
              1. Intake Returned Part into QC Hold
            </h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '12px',
                marginBottom: '12px',
              }}
            >
              <div>
                <label htmlFor={`${formId}-return-part`} style={LABEL_STYLE}>
                  Returned Part ID *
                </label>
                <input
                  id={`${formId}-return-part`}
                  type="text"
                  data-testid="input-return-part-id"
                  value={returnPartId}
                  disabled={isSubmitting}
                  placeholder="UUID of SOLD_AND_RELEASED part"
                  onChange={(e) => setReturnPartId(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor={`${formId}-return-ver`} style={LABEL_STYLE}>
                  Expected Version *
                </label>
                <input
                  id={`${formId}-return-ver`}
                  type="text"
                  data-testid="input-return-expected-version"
                  value={returnExpectedVersion}
                  disabled={isSubmitting}
                  onChange={(e) => setReturnExpectedVersion(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label htmlFor={`${formId}-return-reason`} style={LABEL_STYLE}>
                Return Reason (Optional)
              </label>
              <input
                id={`${formId}-return-reason`}
                type="text"
                data-testid="input-return-reason"
                value={returnReason}
                disabled={isSubmitting}
                onChange={(e) => setReturnReason(e.target.value)}
                style={TOUCH_INPUT_STYLE}
              />
            </div>

            <div data-testid="return-qc-location-scanner">
              <QrScannerInput
                label="Scan Return QC Hold Bin QR"
                placeholder="KEMP-C04-R01-S01-B01"
                disabled={isSubmitting}
                onScan={({ code }) => setReturnQcLocationBarcode(code)}
              />
            </div>

            <div
              style={{
                marginTop: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <span style={{ fontWeight: 700 }}>
                QC Hold Location: {returnQcLocationBarcode || 'Not scanned'}
              </span>
              <button
                type="button"
                data-testid="submit-return-intake"
                disabled={isSubmitting}
                onClick={() => void submitReturnIntake()}
                style={{
                  ...TOUCH_BTN_BASE,
                  backgroundColor: '#1E40AF',
                  color: '#FFFFFF',
                }}
              >
                Receive into Return QC Hold
              </button>
            </div>

            {returnIntakeResult && (
              <p
                data-testid="return-intake-success"
                style={{ fontWeight: 700, color: '#166534', marginBottom: 0 }}
              >
                Received {returnIntakeResult.qrSkuCode} {'->'}{' '}
                {returnIntakeResult.custodyState} /{' '}
                {returnIntakeResult.availabilityState} /{' '}
                {returnIntakeResult.complianceState}
              </p>
            )}
          </div>

          <div style={CARD_STYLE}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
              2. Return QC Inspection Queue ({qcQueue.length})
            </h2>

            {qcQueue.length === 0 ? (
              <p data-testid="empty-qc-queue" style={{ fontWeight: 600 }}>
                No parts currently held in RESTOCKED_QC_HOLD.
              </p>
            ) : (
              <div
                data-testid="qc-queue-list"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  marginBottom: '14px',
                }}
              >
                {qcQueue.map((item) => {
                  const active = item.id === selectedQcPartId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`qc-queue-item-${item.id}`}
                      aria-pressed={active}
                      onClick={() => setSelectedQcPartId(item.id)}
                      style={{
                        ...TOUCH_BTN_BASE,
                        backgroundColor: active ? '#1E40AF' : '#FFFFFF',
                        color: active ? '#FFFFFF' : '#0F172A',
                      }}
                    >
                      {item.qrSkuCode} · {item.partCategoryName} (v{item.version})
                    </button>
                  );
                })}
              </div>
            )}

            {selectedQcPart && (
              <div data-testid="qc-selected-part-panel">
                <p style={{ fontWeight: 700 }}>
                  Inspecting: {selectedQcPart.qrSkuCode} ·{' '}
                  {selectedQcPart.partCategoryName} · TDG:{' '}
                  {selectedQcPart.tdgHazmatCode} · State:{' '}
                  {selectedQcPart.custodyState} /{' '}
                  {selectedQcPart.availabilityState}
                </p>

                <div
                  data-testid="qc-original-photos"
                  style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}
                >
                  {selectedQcPart.rawPhotoUrls.map((url, idx) => (
                    <img
                      key={url}
                      src={url}
                      alt={`Original part photo ${idx + 1}`}
                      style={{
                        width: '88px',
                        height: '88px',
                        objectFit: 'cover',
                        borderRadius: '6px',
                        border: '2px solid #0F172A',
                      }}
                    />
                  ))}
                </div>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '56px',
                    fontWeight: 700,
                    marginBottom: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    data-testid="qc-attestation-toggle"
                    checked={qcAttested}
                    disabled={isSubmitting}
                    onChange={(e) => setQcAttested(e.target.checked)}
                    style={{ width: '24px', height: '24px' }}
                  />
                  <span>
                    I compared this returned part against the original photos
                    and OEM/tamper markings
                  </span>
                </label>

                <div style={{ marginBottom: '12px' }}>
                  <label htmlFor={`${formId}-qc-notes`} style={LABEL_STYLE}>
                    Inspection Notes * (min 5 chars)
                  </label>
                  <input
                    id={`${formId}-qc-notes`}
                    type="text"
                    data-testid="qc-inspection-notes"
                    value={qcInspectionNotes}
                    disabled={isSubmitting}
                    placeholder="OEM stamp & tamper seal match original photos"
                    onChange={(e) => setQcInspectionNotes(e.target.value)}
                    style={TOUCH_INPUT_STYLE}
                  />
                </div>

                <div data-testid="qc-pass-bin-scanner">
                  <QrScannerInput
                    label="Scan Origin Restock Bin QR (Required to Pass QC)"
                    placeholder="KEMP-C01-R01-S01-B01"
                    disabled={isSubmitting}
                    onScan={({ code }) => setQcRestockBinBarcode(code)}
                  />
                </div>

                <div
                  style={{
                    marginTop: '12px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '12px',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontWeight: 700 }}>
                    Restock Bin: {qcRestockBinBarcode || 'Not scanned'}
                  </span>
                  <button
                    type="button"
                    data-testid="submit-qc-pass"
                    disabled={isSubmitting}
                    onClick={() => void submitReturnInspection(true)}
                    style={{
                      ...TOUCH_BTN_BASE,
                      backgroundColor: '#166534',
                      color: '#FFFFFF',
                    }}
                  >
                    Pass QC &amp; Restock
                  </button>
                  <button
                    type="button"
                    data-testid="submit-qc-fail"
                    disabled={isSubmitting}
                    onClick={() => void submitReturnInspection(false)}
                    style={{
                      ...TOUCH_BTN_BASE,
                      backgroundColor: '#991B1B',
                      color: '#FFFFFF',
                    }}
                  >
                    Fail QC &amp; Scrap
                  </button>
                </div>
              </div>
            )}

            {qcInspectResult && (
              <p
                data-testid="qc-inspect-success"
                style={{ fontWeight: 700, color: '#166534', marginBottom: 0 }}
              >
                QC Result ({qcInspectResult.qcPassed ? 'PASS' : 'FAIL'}):{' '}
                {qcInspectResult.custodyState} /{' '}
                {qcInspectResult.availabilityState} /{' '}
                {qcInspectResult.complianceState}
              </p>
            )}
          </div>
        </section>
      )}

      {/* TAB 3: 5-STREAM SCRAP LOGGER */}
      {activeTab === 'SCRAP' && (
        <section aria-label="5-Stream Scrap Logger">
          <div style={CARD_STYLE}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
              Log 5-Stream Commodity Scrap Ticket
            </h2>

            <div style={{ marginBottom: '14px' }}>
              <span style={LABEL_STYLE}>Scrap Stream *</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {SCRAP_STREAMS.map((s) => {
                  const active = scrapStream === s.stream;
                  return (
                    <button
                      key={s.stream}
                      type="button"
                      data-testid={`scrap-stream-pill-${s.stream}`}
                      aria-pressed={active}
                      disabled={isSubmitting}
                      onClick={() => setScrapStream(s.stream)}
                      style={{
                        ...TOUCH_BTN_BASE,
                        backgroundColor: active ? '#1E40AF' : '#FFFFFF',
                        color: active ? '#FFFFFF' : '#0F172A',
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '12px',
                marginBottom: '12px',
              }}
            >
              <div>
                <label htmlFor={`${formId}-scrap-weight`} style={LABEL_STYLE}>
                  Weight (kg) *
                </label>
                <input
                  id={`${formId}-scrap-weight`}
                  type="text"
                  data-testid="input-scrap-weight"
                  value={scrapWeightKg}
                  disabled={isSubmitting}
                  onChange={(e) => setScrapWeightKg(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor={`${formId}-scrap-payout`} style={LABEL_STYLE}>
                  Payout (CAD $) *
                </label>
                <input
                  id={`${formId}-scrap-payout`}
                  type="text"
                  data-testid="input-scrap-payout"
                  value={scrapPayoutCad}
                  disabled={isSubmitting}
                  onChange={(e) => setScrapPayoutCad(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
              </div>
            </div>

            <div style={{ marginBottom: '12px' }}>
              <label htmlFor={`${formId}-recycler`} style={LABEL_STYLE}>
                Recycler Name *
              </label>
              <input
                id={`${formId}-recycler`}
                type="text"
                data-testid="input-recycler-name"
                value={recyclerName}
                disabled={isSubmitting}
                onChange={(e) => setRecyclerName(e.target.value)}
                style={TOUCH_INPUT_STYLE}
              />
            </div>

            <div style={{ marginBottom: '14px' }}>
              <span style={LABEL_STYLE}>
                Cash Custody Mode * (Liquidity Separation FIX 05)
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <button
                  type="button"
                  data-testid="scrap-mode-CASH"
                  aria-pressed={paymentReceiptMode === 'CASH'}
                  disabled={isSubmitting}
                  onClick={() => setPaymentReceiptMode('CASH')}
                  style={{
                    ...TOUCH_BTN_BASE,
                    backgroundColor:
                      paymentReceiptMode === 'CASH' ? '#0F172A' : '#FFFFFF',
                    color:
                      paymentReceiptMode === 'CASH' ? '#FFFFFF' : '#0F172A',
                  }}
                >
                  Cash (HELD_IN_OPERATOR_FLOAT)
                </button>
                <button
                  type="button"
                  data-testid="scrap-mode-CONFIRMED_BANK_DEPOSIT"
                  aria-pressed={
                    paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT'
                  }
                  disabled={isSubmitting}
                  onClick={() =>
                    setPaymentReceiptMode('CONFIRMED_BANK_DEPOSIT')
                  }
                  style={{
                    ...TOUCH_BTN_BASE,
                    backgroundColor:
                      paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT'
                        ? '#0F172A'
                        : '#FFFFFF',
                    color:
                      paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT'
                        ? '#FFFFFF'
                        : '#0F172A',
                  }}
                >
                  Confirmed Bank Deposit (SETTLED_ORIGIN_CORP_BANK)
                </button>
              </div>
            </div>

            {paymentReceiptMode === 'CONFIRMED_BANK_DEPOSIT' && (
              <div
                data-testid="bank-deposit-fields"
                style={{ marginBottom: '12px' }}
              >
                <label htmlFor={`${formId}-deposit-ref`} style={LABEL_STYLE}>
                  Bank Deposit Reference *
                </label>
                <input
                  id={`${formId}-deposit-ref`}
                  type="text"
                  data-testid="input-bank-deposit-ref"
                  value={bankDepositReference}
                  disabled={isSubmitting}
                  placeholder="DEP-2026-0041"
                  onChange={(e) => setBankDepositReference(e.target.value)}
                  style={TOUCH_INPUT_STYLE}
                />
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '56px',
                    fontWeight: 700,
                    marginTop: '8px',
                  }}
                >
                  <input
                    type="checkbox"
                    data-testid="checkbox-bank-deposit-confirmed"
                    checked={bankDepositConfirmed}
                    disabled={isSubmitting}
                    onChange={(e) => setBankDepositConfirmed(e.target.checked)}
                    style={{ width: '24px', height: '24px' }}
                  />
                  <span>
                    Confirm funds have cleared corporate bank account
                  </span>
                </label>
              </div>
            )}

            <div style={{ marginBottom: '14px' }}>
              <label htmlFor={`${formId}-ticket-file`} style={LABEL_STYLE}>
                Private Recycler Ticket (Image / PDF) *
              </label>
              <input
                id={`${formId}-ticket-file`}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                data-testid="scrap-ticket-file-input"
                disabled={isSubmitting}
                onChange={(e) =>
                  setScrapTicketFile(e.target.files?.[0] ?? null)
                }
                style={TOUCH_INPUT_STYLE}
              />
            </div>

            <button
              type="button"
              data-testid="submit-scrap-log"
              disabled={isSubmitting}
              onClick={() => void submitScrapLog()}
              style={{
                ...TOUCH_BTN_BASE,
                backgroundColor: '#1E40AF',
                color: '#FFFFFF',
              }}
            >
              {isSubmitting ? 'Logging...' : 'Log Scrap Recovery Ticket'}
            </button>

            {scrapResult && (
              <p
                data-testid="scrap-success-summary"
                style={{ fontWeight: 700, color: '#166534', marginBottom: 0 }}
              >
                Logged {scrapResult.scrapStream} ($
                {(scrapResult.payoutCadMinor / 100).toFixed(2)} CAD ·{' '}
                {scrapResult.cashCustodyState}) · Donor Scrap Recovery: $
                {(scrapResult.scrapRecoveryCadMinor / 100).toFixed(2)} CAD
              </p>
            )}
          </div>

          <div style={CARD_STYLE}>
            <h3 style={{ marginTop: 0 }}>
              Recorded Scrap Tickets ({scrapHistory.length})
            </h3>
            {scrapHistory.length === 0 ? (
              <p data-testid="empty-scrap-history">No scrap tickets logged yet.</p>
            ) : (
              <ul
                data-testid="scrap-history-list"
                style={{ listStyle: 'none', padding: 0, margin: 0 }}
              >
                {scrapHistory.map((log) => (
                  <li
                    key={log.id}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 0',
                      borderBottom: '1px solid #CBD5E1',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {log.scrapStream} · ${(log.payoutCadMinor / 100).toFixed(2)}{' '}
                      CAD · {log.cashCustodyState} ({log.recyclerName})
                    </span>
                    <button
                      type="button"
                      data-testid={`view-ticket-btn-${log.id}`}
                      onClick={() => void handleViewTicket(log.id)}
                      style={{
                        ...TOUCH_BTN_BASE,
                        backgroundColor: '#FFFFFF',
                        color: '#0F172A',
                      }}
                    >
                      View Private Ticket
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {ticketViewResult && (
              <p
                data-testid="ticket-presigned-url-banner"
                style={{ fontWeight: 700, marginTop: '10px', marginBottom: 0 }}
              >
                Short-Lived Ticket URL ({ticketViewResult.ttlSeconds}s):{' '}
                <a
                  href={ticketViewResult.presignedUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Verified Ticket
                </a>
              </p>
            )}
          </div>
        </section>
      )}

      {/* TAB 4: HULK CLEARANCE */}
      {activeTab === 'HULK' && (
        <section aria-label="Hulk Scrap Clearance" style={CARD_STYLE}>
          <h2 style={{ fontSize: '18px', fontWeight: 800, marginTop: 0 }}>
            Complete Hulk Scrap Clearance (SCRAPPED_METAL_CLEARED)
          </h2>

          <div style={{ marginBottom: '14px' }}>
            <label htmlFor={`${formId}-bare-shell`} style={LABEL_STYLE}>
              Recorded BARE_STEEL_SHELL Scrap Ticket *
            </label>
            {donorBareShellLogs.length === 0 ? (
              <p data-testid="empty-bare-shell-logs" style={{ fontWeight: 600 }}>
                No BARE_STEEL_SHELL ticket logged for the selected donor yet.
                Log stream #5 under 5-Stream Scrap first.
              </p>
            ) : (
              <select
                id={`${formId}-bare-shell`}
                data-testid="select-bare-shell-log"
                value={selectedBareShellLogId}
                disabled={isSubmitting}
                onChange={(e) => setSelectedBareShellLogId(e.target.value)}
                style={TOUCH_INPUT_STYLE}
              >
                {donorBareShellLogs.map((log) => (
                  <option key={log.id} value={log.id}>
                    {log.recyclerName} · ${(log.payoutCadMinor / 100).toFixed(2)}{' '}
                    CAD ({log.cashCustodyState})
                  </option>
                ))}
              </select>
            )}
          </div>

          <button
            type="button"
            data-testid="submit-hulk-clearance"
            disabled={isSubmitting || donorBareShellLogs.length === 0}
            onClick={() => void submitHulkClearance()}
            style={{
              ...TOUCH_BTN_BASE,
              backgroundColor: '#166534',
              color: '#FFFFFF',
              opacity:
                isSubmitting || donorBareShellLogs.length === 0 ? 0.65 : 1,
            }}
          >
            {isSubmitting
              ? 'Finalizing...'
              : 'Finalize Hulk Scrap Clearance'}
          </button>

          {hulkResult && (
            <section
              data-testid="hulk-success-card"
              style={{
                marginTop: '14px',
                padding: '12px',
                borderRadius: '8px',
                border: '2px solid #166534',
                backgroundColor: '#F0FDF4',
              }}
            >
              <p style={{ fontWeight: 700, margin: '0 0 4px 0' }}>
                Lifecycle: {hulkResult.lifecycleState} · Total Recovery: $
                {(hulkResult.scrapRecoveryCadMinor / 100).toFixed(2)} CAD
              </p>
              {hulkResult.complianceWarnings.length > 0 && (
                <ul data-testid="hulk-warning-list">
                  {hulkResult.complianceWarnings.map((w) => (
                    <li
                      key={w}
                      data-testid={`hulk-warning-${w}`}
                      style={{ fontWeight: 700, color: '#92400E' }}
                    >
                      {WARNING_LABELS[w] ?? w}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </section>
      )}

      {/* Recent Workspace Parts Preview */}
      {parts.length > 0 && (
        <section style={CARD_STYLE} aria-label="Recent Stripped Parts">
          <h3 style={{ marginTop: 0 }}>
            Workspace Stripped Parts ({parts.length})
          </h3>
          <ul
            data-testid="workspace-parts-list"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {parts.slice(0, 10).map((p) => (
              <li
                key={p.id}
                style={{
                  padding: '6px 0',
                  borderBottom: '1px solid #CBD5E1',
                  fontSize: '14px',
                  fontWeight: 600,
                }}
              >
                {p.qrSkuCode} · {p.partCategoryName} ({p.araGrade}) ·{' '}
                {p.custodyState} / {p.availabilityState} / {p.complianceState} ·
                Basis: ${(p.allocatedCostBasisCadMinor / 100).toFixed(2)} CAD
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
