'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  QrScannerInput,
  type QrScannerScanPayload,
} from '@/app/components/QrScannerInput';

export interface DomesticCheckoutFormProps {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

type CheckoutTab = 'checkout' | 'syndication' | 'settlement';

type DomesticChannel =
  | 'LOCAL_WALK_IN_CASH'
  | 'FB_MARKETPLACE_LOCAL'
  | 'KIJIJI_LOCAL'
  | 'RETAIL_LOT_VEHICLE_SALE'
  | 'WHOLESALE_MECHANIC_NETWORK'
  | 'EBAY_MOTORS_SHIPPED'
  | 'CAR_PART_WHOLESALE';

type DeliveryMethod =
  | 'PICKUP_AT_ORIGIN'
  | 'LOCAL_DELIVERY_ONTARIO'
  | 'SELLER_SHIPPED_PARCEL_OR_FREIGHT';

type PaymentMethod =
  | 'CASH'
  | 'INTERAC_ETRANSFER'
  | 'VERIFIED_BANK_WIRE'
  | 'EBAY_MANAGED_PAYOUT';

type EvidenceKind =
  | 'PAYMENT_PROOF'
  | 'BILL_OF_SALE'
  | 'EXPORT_PROOF'
  | 'SETTLEMENT_PROOF'
  | 'FEE_TAX_INVOICE'
  | 'REFUND_PROOF';

interface ResolvedPriceView {
  readonly amountCadMinor: number;
  readonly source: string;
  readonly policyHash: string;
}

interface LookupItemView {
  readonly itemType: 'PART' | 'VEHICLE';
  readonly itemId: string;
  readonly code: string;
  readonly label: string;
  readonly availabilityState: string;
  readonly custodyOrLifecycleState: string;
  readonly ebaySyncState: string | null;
  readonly classifiedsSyncState: string;
  readonly complianceState: string | null;
  readonly tdgHazmatCode: string | null;
  readonly isEbayParcelEligible: boolean;
  readonly inReturnQcHold: boolean;
  readonly hasActiveSale: boolean;
  readonly resolvedPrice: ResolvedPriceView | null;
  readonly priceError: string | null;
  readonly priceBasisHash: string | null;
  readonly warnings: readonly string[];
  readonly version: number;
}

interface BasketLine {
  readonly item: LookupItemView;
  readonly proposedPriceInputCad: string;
}

interface CheckoutReceiptView {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly taxInvoiceNumber: string | null;
  readonly domesticChannel: string;
  readonly deliveryMethod: string;
  readonly destinationCountryCode: string;
  readonly destinationProvinceOrState: string | null;
  readonly floorPriceAtCheckoutMinor: number;
  readonly subtotalMinor: number;
  readonly discountAmountMinor: number;
  readonly cfoOverrideApplied: boolean;
  readonly taxCollectionMode: string;
  readonly appliedTaxJurisdiction: string;
  readonly appliedTaxRateBps: number;
  readonly taxOrVatMinor: number;
  readonly buyerTaxRemittedByPlatformMinor: number | null;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly paymentMethod: string;
  readonly paymentSettlementState: string;
  readonly cashCustodyState: string;
  readonly complianceWarnings: readonly string[];
  readonly outboxEventIds: readonly string[];
}

interface SettlementSaleView {
  readonly id: string;
  readonly receiptNumber: string;
  readonly domesticChannel: string | null;
  readonly buyerName: string;
  readonly paymentMethod: string;
  readonly paymentSettlementState: string;
  readonly cashCustodyState: string;
  readonly grossCollectedMinor: number;
  readonly netRealizedCadMinor: number;
  readonly platformFeeMinor: number;
  readonly actualPlatformFeeMinor: number | null;
  readonly estimatedPlatformFeeTaxCadMinor: number;
  readonly itcReceivableCadMinor: number;
  readonly isFeeTaxInvoiceVerified: boolean;
  readonly bankDepositReference: string | null;
  readonly isVoidedOrReversed: boolean;
  readonly reversesSaleTxId: string | null;
}

interface PreviewEbayCsvView {
  readonly csvContent: string;
  readonly eligiblePartIds: readonly string[];
  readonly eligibleSkus: readonly string[];
  readonly ineligibleParts: ReadonlyArray<{
    readonly partId: string;
    readonly qrSkuCode: string;
    readonly reasonCode: string;
    readonly reasonMessage: string;
  }>;
}

interface ExportEbayCsvView {
  readonly exportId: string;
  readonly csvContent: string;
  readonly exportedPartIds: readonly string[];
  readonly exportedSkus: readonly string[];
  readonly auditLogId: string;
}

interface B2bPowertrainSheetView {
  readonly publicPickupLocationLabel: string;
  readonly whatsappMarkdownText: string;
  readonly csvContent: string;
  readonly items: ReadonlyArray<{
    readonly partId: string;
    readonly qrSkuCode: string;
    readonly year: number;
    readonly make: string;
    readonly model: string;
    readonly engineSpec: string | null;
    readonly odometerKm: number | null;
    readonly partCategoryName: string;
    readonly araGrade: string;
    readonly initialMechanicAskCadMinor: number;
  }>;
}

interface LocalAdPayloadView {
  readonly partId: string;
  readonly qrSkuCode: string;
  readonly title: string;
  readonly body: string;
  readonly askCadMinor: number;
  readonly publicPickupLocationLabel: string;
  readonly isLocalPickupOnly: boolean;
  readonly tdgHazmatCode: string;
  readonly araGrade: string;
  readonly classifiedsSyncState: string;
  readonly ebaySyncState: string;
  readonly version: number;
}

interface UrgentDelistQueueView {
  readonly classifiedsConfirmationNotice: string;
  readonly items: ReadonlyArray<{
    readonly partId: string;
    readonly qrSkuCode: string;
    readonly partCategoryName: string;
    readonly ebaySyncState: string;
    readonly classifiedsSyncState: string;
    readonly ebayListingId: string | null;
    readonly version: number;
  }>;
}

interface RefundOutcomeView {
  readonly originalSaleId: string;
  readonly reversalSaleId: string;
  readonly creditNoteReference: string;
  readonly chosenFundingSource: string;
  readonly proofOrigin: string;
  readonly referenceOrigin: string;
  readonly returnedPartIds: readonly string[];
  readonly bankCashAdjustmentCadMinor: number | null;
}

const TOUCH_BUTTON_STYLE: React.CSSProperties = {
  minWidth: '56px',
  minHeight: '56px',
  padding: '12px 16px',
  borderRadius: '8px',
  border: '2px solid #0F172A',
  fontWeight: 700,
  fontSize: '15px',
  cursor: 'pointer',
  backgroundColor: '#0F172A',
  color: '#FFFFFF',
};

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
  ...TOUCH_BUTTON_STYLE,
  backgroundColor: '#F8FAFC',
  color: '#0F172A',
};

const WARNING_BUTTON_STYLE: React.CSSProperties = {
  ...TOUCH_BUTTON_STYLE,
  backgroundColor: '#B45309',
  borderColor: '#78350F',
  color: '#FFFFFF',
};

const DANGER_BUTTON_STYLE: React.CSSProperties = {
  ...TOUCH_BUTTON_STYLE,
  backgroundColor: '#991B1B',
  borderColor: '#7F1D1D',
  color: '#FFFFFF',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  minHeight: '56px',
  padding: '10px 12px',
  borderRadius: '8px',
  border: '2px solid #334155',
  fontSize: '16px',
  backgroundColor: '#FFFFFF',
  color: '#0F172A',
  boxSizing: 'border-box',
};

const CANADIAN_PROVINCES = [
  { code: 'ON', label: 'ON — Ontario (13% HST)' },
  { code: 'NS', label: 'NS — Nova Scotia (14% HST)' },
  { code: 'NB', label: 'NB — New Brunswick (15% HST)' },
  { code: 'NL', label: 'NL — Newfoundland & Labrador (15% HST)' },
  { code: 'PE', label: 'PE — Prince Edward Island (15% HST)' },
  { code: 'AB', label: 'AB — Alberta (5% GST)' },
  { code: 'BC', label: 'BC — British Columbia (5% GST)' },
  { code: 'MB', label: 'MB — Manitoba (5% GST)' },
  { code: 'SK', label: 'SK — Saskatchewan (5% GST)' },
  { code: 'QC', label: 'QC — Quebec (5% GST)' },
  { code: 'YT', label: 'YT — Yukon (5% GST)' },
  { code: 'NT', label: 'NT — Northwest Territories (5% GST)' },
  { code: 'NU', label: 'NU — Nunavut (5% GST)' },
] as const;

const PRICE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  EXPLICIT_PART_RETAIL: 'Explicit Part Retail Price',
  GRADE_ADJUSTED_COMPARABLE: 'ARA Grade-Adjusted Comp Baseline',
  VEHICLE_TARGET: 'Vehicle Target Gross Realization',
  VEHICLE_COST_PLUS_MIN_PROFIT: 'Vehicle Cost + Minimum Retail Profit',
};

function generateClientUuid(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += '8';
    } else {
      out += hex[(i * 7 + Date.now()) % 16];
    }
  }
  return out;
}

function formatCad(minor: number): string {
  return `$${(minor / 100).toFixed(2)} CAD`;
}

function parseCadInputToMinor(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [dollarsPart, centsPart = ''] = trimmed.split('.');
  const cents = Number.parseInt(dollarsPart!, 10) * 100 +
    Number.parseInt(centsPart.padEnd(2, '0'), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    payload.error &&
    typeof payload.error === 'object'
  ) {
    const err = payload.error as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' ? err.code : '';
    const msg = typeof err.message === 'string' ? err.message : fallback;
    return code ? `${code}: ${msg}` : msg;
  }
  return fallback;
}

export function DomesticCheckoutForm(
  props: DomesticCheckoutFormProps,
): React.ReactElement {
  const isCfo = props.actorRole === 'ARCHITECT_CFO';
  const activeOrgRef = useRef<string>(props.organizationId);
  const requestSeqRef = useRef<number>(0);

  const [activeTab, setActiveTab] = useState<CheckoutTab>('checkout');
  const [lookupCode, setLookupCode] = useState<string>('');
  const [lookupItems, setLookupItems] = useState<readonly LookupItemView[]>([]);
  const [basket, setBasket] = useState<readonly BasketLine[]>([]);

  const [domesticChannel, setDomesticChannel] = useState<DomesticChannel>(
    'LOCAL_WALK_IN_CASH',
  );
  const [deliveryMethod, setDeliveryMethod] =
    useState<DeliveryMethod>('PICKUP_AT_ORIGIN');
  const [destinationCountryCode, setDestinationCountryCode] =
    useState<string>('CA');
  const [destinationProvinceOrState, setDestinationProvinceOrState] =
    useState<string>('ON');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [isCashCountedInPerson, setIsCashCountedInPerson] =
    useState<boolean>(true);
  const [buyerName, setBuyerName] = useState<string>('');
  const [buyerPhoneE164, setBuyerPhoneE164] = useState<string>('');
  const [discountReasonCode, setDiscountReasonCode] = useState<string>('');
  const [cfoOverrideRequested, setCfoOverrideRequested] =
    useState<boolean>(false);
  const [cfoOverrideReasonNote, setCfoOverrideReasonNote] =
    useState<string>('');

  const [buyerTaxPlatformInput, setBuyerTaxPlatformInput] =
    useState<string>('');
  const [platformFeeInput, setPlatformFeeInput] = useState<string>('0.00');
  const [shippingCostInput, setShippingCostInput] = useState<string>('0.00');
  const [estimatedFeeTaxInput, setEstimatedFeeTaxInput] =
    useState<string>('0.00');

  const [paymentProofStorageKey, setPaymentProofStorageKey] =
    useState<string>('');
  const [billOfSaleStorageKey, setBillOfSaleStorageKey] = useState<string>('');
  const [exportProofStorageKey, setExportProofStorageKey] =
    useState<string>('');
  const [ebayDelistAttestedAt, setEbayDelistAttestedAt] = useState<
    string | null
  >(null);

  const checkoutRetryRef = useRef<{
    signature: string | null;
    idempotencyKey: string;
  }>({
    signature: null,
    idempotencyKey: generateClientUuid(),
  });

  const [lastReceipt, setLastReceipt] = useState<CheckoutReceiptView | null>(
    null,
  );
  const [busy, setBusy] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Syndication state
  const [ebayPreview, setEbayPreview] = useState<PreviewEbayCsvView | null>(
    null,
  );
  const [lastEbayExport, setLastEbayExport] =
    useState<ExportEbayCsvView | null>(null);
  const [confirmPartId, setConfirmPartId] = useState<string>('');
  const [confirmListingId, setConfirmListingId] = useState<string>('');
  const confirmRetryRef = useRef<string>(generateClientUuid());
  const exportRetryRef = useRef<string>(generateClientUuid());
  const [b2bSheet, setB2bSheet] = useState<B2bPowertrainSheetView | null>(null);
  const [localLookupSku, setLocalLookupSku] = useState<string>('');
  const [localAdPayload, setLocalAdPayload] =
    useState<LocalAdPayloadView | null>(null);
  const [urgentQueue, setUrgentQueue] = useState<UrgentDelistQueueView | null>(
    null,
  );

  // CFO Settlement & Refund state
  const [settlementSales, setSettlementSales] = useState<
    readonly SettlementSaleView[]
  >([]);
  const [selectedSaleId, setSelectedSaleId] = useState<string>('');
  const [bankDepositReference, setBankDepositReference] = useState<string>('');
  const [settlementProofStorageKey, setSettlementProofStorageKey] =
    useState<string>('');
  const [actualPlatformFeeInput, setActualPlatformFeeInput] =
    useState<string>('');
  const [feeTaxInvoiceStorageKey, setFeeTaxInvoiceStorageKey] =
    useState<string>('');
  const [refundReasonNote, setRefundReasonNote] = useState<string>('');
  const [returnPartsToQcHold, setReturnPartsToQcHold] =
    useState<boolean>(true);
  const [refundBankReference, setRefundBankReference] = useState<string>('');
  const [refundProofStorageKey, setRefundProofStorageKey] =
    useState<string>('');
  const [lastRefundOutcome, setLastRefundOutcome] =
    useState<RefundOutcomeView | null>(null);

  const refreshLookup = useCallback(
    async (codeFilter?: string) => {
      const orgAtStart = props.organizationId;
      const reqId = ++requestSeqRef.current;
      const params = new URLSearchParams({ view: 'lookup' });
      const trimmed = (codeFilter ?? '').trim();
      if (trimmed.length > 0) {
        params.set('code', trimmed);
      }

      const response = await fetch(
        `/api/salvage/checkout/domestic?${params.toString()}`,
        {
          method: 'GET',
          credentials: 'same-origin',
        },
      );
      if (
        activeOrgRef.current !== orgAtStart ||
        requestSeqRef.current !== reqId
      ) {
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Failed to look up checkout items.'),
        );
        return;
      }
      setLookupItems(Array.isArray(data.items) ? data.items : []);
    },
    [props.organizationId],
  );

  const refreshUrgentDelistQueue = useCallback(async () => {
    const orgAtStart = props.organizationId;
    const response = await fetch(
      '/api/marketplace/local-ad-payload/__urgent-delist-queue__',
      {
        method: 'GET',
        credentials: 'same-origin',
      },
    );
    if (activeOrgRef.current !== orgAtStart) {
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      setErrorMessage(
        readApiErrorMessage(data, 'Failed to load urgent delist queue.'),
      );
      return;
    }
    setUrgentQueue(data as UrgentDelistQueueView);
  }, [props.organizationId]);

  const refreshSettlementQueue = useCallback(async () => {
    if (!isCfo) {
      return;
    }
    const orgAtStart = props.organizationId;
    const response = await fetch(
      '/api/salvage/checkout/domestic?view=settlement-queue',
      {
        method: 'GET',
        credentials: 'same-origin',
      },
    );
    if (activeOrgRef.current !== orgAtStart) {
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      setErrorMessage(
        readApiErrorMessage(data, 'Failed to load settlement queue.'),
      );
      return;
    }
    const sales = Array.isArray(data.sales)
      ? (data.sales as SettlementSaleView[])
      : [];
    setSettlementSales(sales);
    if (sales.length > 0) {
      setSelectedSaleId((prev) => prev || sales[0]!.id);
    }
  }, [isCfo, props.organizationId]);

  // Reset all cross-workspace UI state immediately on active organization switch
  useEffect(() => {
    activeOrgRef.current = props.organizationId;
    requestSeqRef.current += 1;

    setLookupCode('');
    setLookupItems([]);
    setBasket([]);
    setLastReceipt(null);
    setEbayDelistAttestedAt(null);
    setPaymentProofStorageKey('');
    setBillOfSaleStorageKey('');
    setExportProofStorageKey('');
    setDiscountReasonCode('');
    setCfoOverrideRequested(false);
    setCfoOverrideReasonNote('');
    setEbayPreview(null);
    setLastEbayExport(null);
    setConfirmPartId('');
    setConfirmListingId('');
    setB2bSheet(null);
    setLocalLookupSku('');
    setLocalAdPayload(null);
    setUrgentQueue(null);
    setSettlementSales([]);
    setSelectedSaleId('');
    setBankDepositReference('');
    setSettlementProofStorageKey('');
    setActualPlatformFeeInput('');
    setFeeTaxInvoiceStorageKey('');
    setRefundReasonNote('');
    setRefundBankReference('');
    setRefundProofStorageKey('');
    setLastRefundOutcome(null);
    setErrorMessage(null);
    setStatusMessage(null);

    checkoutRetryRef.current = {
      signature: null,
      idempotencyKey: generateClientUuid(),
    };
    confirmRetryRef.current = generateClientUuid();
    exportRetryRef.current = generateClientUuid();

    void refreshLookup();
    void refreshUrgentDelistQueue();
    if (isCfo) {
      void refreshSettlementQueue();
    }
  }, [
    props.organizationId,
    isCfo,
    refreshLookup,
    refreshUrgentDelistQueue,
    refreshSettlementQueue,
  ]);

  const handleScanLookup = async (payload: QrScannerScanPayload) => {
    setErrorMessage(null);
    setLookupCode(payload.code);
    await refreshLookup(payload.code);
  };

  const addToBasket = (item: LookupItemView) => {
    setErrorMessage(null);
    if (!item.resolvedPrice) {
      setErrorMessage(
        item.priceError ?? `No resolved floor price available for ${item.code}.`,
      );
      return;
    }
    if (item.inReturnQcHold) {
      setErrorMessage(
        `${item.code} is in Return QC Hold and cannot be checked out until QC clears.`,
      );
      return;
    }
    if (item.hasActiveSale) {
      setErrorMessage(`${item.code} is already attached to an active sale.`);
      return;
    }
    if (basket.some((line) => line.item.itemId === item.itemId)) {
      return;
    }
    if (basket.some((line) => line.item.itemType !== item.itemType)) {
      setErrorMessage(
        'Cannot mix parts and whole vehicles in a single domestic checkout basket.',
      );
      return;
    }
    const initialCad = (item.resolvedPrice.amountCadMinor / 100).toFixed(2);
    setBasket((prev) => [...prev, { item, proposedPriceInputCad: initialCad }]);
  };

  const removeFromBasket = (itemId: string) => {
    setBasket((prev) => prev.filter((line) => line.item.itemId !== itemId));
  };

  const basketSummary = useMemo(() => {
    let floorTotalMinor = 0;
    let proposedTotalMinor = 0;
    let validPrices = true;
    for (const line of basket) {
      const floor = line.item.resolvedPrice?.amountCadMinor ?? 0;
      floorTotalMinor += floor;
      const parsed = parseCadInputToMinor(line.proposedPriceInputCad);
      if (parsed === null) {
        validPrices = false;
      } else {
        proposedTotalMinor += parsed;
      }
    }
    const discountMinor = Math.max(0, floorTotalMinor - proposedTotalMinor);
    const tierThresholdMinor = Math.floor(floorTotalMinor * 0.9);
    const requiresReason = validPrices && proposedTotalMinor < floorTotalMinor;
    const requiresCfoOverride =
      validPrices && proposedTotalMinor < tierThresholdMinor;
    const hasLiveEbayPart = basket.some(
      (line) =>
        line.item.itemType === 'PART' &&
        line.item.ebaySyncState === 'SYNDICATED_LIVE',
    );
    const requiresDelistAttestation =
      hasLiveEbayPart && domesticChannel !== 'EBAY_MOTORS_SHIPPED';
    const hasVehicle = basket.some((line) => line.item.itemType === 'VEHICLE');
    const requiresExportProof =
      destinationCountryCode.trim().toUpperCase() !== 'CA';

    return {
      floorTotalMinor,
      proposedTotalMinor,
      discountMinor,
      tierThresholdMinor,
      requiresReason,
      requiresCfoOverride,
      requiresDelistAttestation,
      hasVehicle,
      requiresExportProof,
      validPrices,
    };
  }, [basket, domesticChannel, destinationCountryCode]);

  const handleEvidenceUpload = async (
    kind: EvidenceKind,
    file: File | null,
  ) => {
    if (!file) {
      return;
    }
    setErrorMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    const uploadKey = generateClientUuid();

    try {
      const formData = new FormData();
      formData.append(
        'metadata',
        JSON.stringify({
          action: 'upload-evidence',
          evidenceKind: kind,
          idempotencyKey: uploadKey,
        }),
      );
      formData.append('file', file);

      const response = await fetch('/api/salvage/checkout/domestic', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Idempotency-Key': uploadKey,
        },
        body: formData,
      });

      if (activeOrgRef.current !== orgAtStart) {
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(readApiErrorMessage(data, 'Evidence upload failed.'));
        return;
      }

      const key = String(data.storageKey ?? '');
      if (kind === 'PAYMENT_PROOF') setPaymentProofStorageKey(key);
      if (kind === 'BILL_OF_SALE') setBillOfSaleStorageKey(key);
      if (kind === 'EXPORT_PROOF') setExportProofStorageKey(key);
      if (kind === 'SETTLEMENT_PROOF') setSettlementProofStorageKey(key);
      if (kind === 'FEE_TAX_INVOICE') setFeeTaxInvoiceStorageKey(key);
      if (kind === 'REFUND_PROOF') setRefundProofStorageKey(key);
      setStatusMessage(`Uploaded ${kind}: ${key}`);
    } catch {
      if (activeOrgRef.current === orgAtStart) {
        setErrorMessage('Network error while uploading private evidence.');
      }
    } finally {
      if (activeOrgRef.current === orgAtStart) {
        setBusy(false);
      }
    }
  };

  const handleCheckoutSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);

    if (basket.length === 0) {
      setErrorMessage('Add at least one SKU or vehicle to the checkout basket.');
      return;
    }
    if (!basketSummary.validPrices) {
      setErrorMessage('Enter valid positive CAD amounts for all basket lines.');
      return;
    }

    const partLines = basket
      .filter((line) => line.item.itemType === 'PART')
      .map((line) => ({
        partId: line.item.itemId,
        proposedPriceCadMinor: parseCadInputToMinor(
          line.proposedPriceInputCad,
        )!,
        expectedVersion: line.item.version,
      }));

    const vehicleLines = basket
      .filter((line) => line.item.itemType === 'VEHICLE')
      .map((line) => ({
        vehicleId: line.item.itemId,
        proposedPriceCadMinor: parseCadInputToMinor(
          line.proposedPriceInputCad,
        )!,
        expectedVersion: line.item.version,
      }));

    const basisItems = [...basket]
      .filter((l) => l.item.priceBasisHash)
      .sort((a, b) =>
        a.item.itemId.toLowerCase().localeCompare(b.item.itemId.toLowerCase()),
      )
      .map((l) => l.item.priceBasisHash)
      .join(',');

    const parsedPlatformBuyerTax =
      buyerTaxPlatformInput.trim().length > 0
        ? parseCadInputToMinor(buyerTaxPlatformInput)
        : null;
    const parsedPlatformFee = parseCadInputToMinor(platformFeeInput) ?? 0;
    const parsedShippingCost = parseCadInputToMinor(shippingCostInput) ?? 0;
    const parsedEstFeeTax = parseCadInputToMinor(estimatedFeeTaxInput) ?? 0;

    const payloadBody = {
      marketNode: 'DOMESTIC_ORIGIN' as const,
      paymentCurrency: 'CAD' as const,
      domesticChannel,
      deliveryMethod,
      destinationCountryCode: destinationCountryCode.trim().toUpperCase(),
      destinationProvinceOrState:
        destinationCountryCode.trim().toUpperCase() === 'CA'
          ? destinationProvinceOrState.trim().toUpperCase()
          : destinationProvinceOrState.trim() || null,
      paymentMethod,
      isCashCountedInPerson,
      buyerName: buyerName.trim(),
      buyerPhoneE164: buyerPhoneE164.trim() || null,
      partLines: partLines.length > 0 ? partLines : undefined,
      vehicleLines: vehicleLines.length > 0 ? vehicleLines : undefined,
      discountReasonCode: discountReasonCode.trim() || null,
      cfoOverrideRequested,
      cfoOverrideReasonNote: cfoOverrideReasonNote.trim() || null,
      paymentProofStorageKey: paymentProofStorageKey.trim(),
      billOfSaleStorageKey: billOfSaleStorageKey.trim() || null,
      exportProofStorageKey: exportProofStorageKey.trim() || null,
      buyerTaxRemittedByPlatformMinor:
        domesticChannel === 'EBAY_MOTORS_SHIPPED'
          ? parsedPlatformBuyerTax
          : undefined,
      platformFeeMinor: parsedPlatformFee,
      shippingCostMinor: parsedShippingCost,
      estimatedPlatformFeeTaxCadMinor:
        domesticChannel === 'EBAY_MOTORS_SHIPPED' ? parsedEstFeeTax : 0,
      ebayDelistAttestedAt,
      acknowledgedPriceBasisHash: basisItems || null,
    };

    const payloadSignature = JSON.stringify({
      org: props.organizationId,
      basisItems,
      payloadBody,
    });
    if (checkoutRetryRef.current.signature !== payloadSignature) {
      checkoutRetryRef.current = {
        signature: payloadSignature,
        idempotencyKey: generateClientUuid(),
      };
    }

    const requestIdempotencyKey = checkoutRetryRef.current.idempotencyKey;
    const orgAtStart = props.organizationId;
    setBusy(true);

    try {
      const response = await fetch('/api/salvage/checkout/domestic', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': requestIdempotencyKey,
        },
        body: JSON.stringify({
          ...payloadBody,
          idempotencyKey: requestIdempotencyKey,
        }),
      });

      if (activeOrgRef.current !== orgAtStart) {
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(readApiErrorMessage(data, 'Domestic checkout failed.'));
        return;
      }

      setLastReceipt(data as CheckoutReceiptView);
      setBasket([]);
      setEbayDelistAttestedAt(null);
      setStatusMessage(
        `Checkout recorded: Receipt ${(data as CheckoutReceiptView).receiptNumber}`,
      );
      checkoutRetryRef.current = {
        signature: null,
        idempotencyKey: generateClientUuid(),
      };
      await refreshLookup(lookupCode);
      await refreshUrgentDelistQueue();
      if (isCfo) {
        await refreshSettlementQueue();
      }
    } catch {
      if (activeOrgRef.current === orgAtStart) {
        setErrorMessage(
          'Network failure during checkout. Retry safely with preserved Idempotency-Key.',
        );
      }
    } finally {
      if (activeOrgRef.current === orgAtStart) {
        setBusy(false);
      }
    }
  };

  const handleLoadEbayPreview = async () => {
    setErrorMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    try {
      const response = await fetch('/api/salvage/syndication/ebay-csv', {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Failed to preview eBay CSV feed.'),
        );
        return;
      }
      setEbayPreview(data as PreviewEbayCsvView);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleCommitEbayCsv = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    const key = exportRetryRef.current;
    try {
      const response = await fetch('/api/salvage/syndication/ebay-csv', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          format: 'EBAY_CSV',
          idempotencyKey: key,
        }),
      });
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'eBay Seller Hub CSV export failed.'),
        );
        return;
      }
      const exported = data as ExportEbayCsvView;
      setLastEbayExport(exported);
      if (exported.exportedPartIds.length > 0) {
        setConfirmPartId(exported.exportedPartIds[0]!);
      }
      exportRetryRef.current = generateClientUuid();
      setStatusMessage(
        `Exported ${exported.exportedSkus.length} SKU(s) -> CSV_EXPORTED_PENDING_CONFIRMATION.`,
      );
      await handleLoadEbayPreview();
      await refreshLookup(lookupCode);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleConfirmEbayLive = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    if (!confirmPartId.trim() || !confirmListingId.trim()) {
      setErrorMessage(
        'Select exported part and enter Seller Hub eBay Listing ID.',
      );
      return;
    }
    setBusy(true);
    const orgAtStart = props.organizationId;
    const key = confirmRetryRef.current;
    try {
      const response = await fetch('/api/salvage/syndication/ebay-csv', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          action: 'confirm-live',
          partId: confirmPartId.trim(),
          ebayListingId: confirmListingId.trim(),
          idempotencyKey: key,
        }),
      });
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Confirm eBay Listing Live failed.'),
        );
        return;
      }
      confirmRetryRef.current = generateClientUuid();
      setConfirmListingId('');
      setStatusMessage(
        `Operator Assertion recorded: ${data.qrSkuCode} is SYNDICATED_LIVE (${data.ebayListingId}).`,
      );
      await refreshLookup(lookupCode);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleLoadB2bSheet = async () => {
    setErrorMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    try {
      const response = await fetch(
        '/api/salvage/syndication/ebay-csv?format=b2b-powertrain',
        { method: 'GET', credentials: 'same-origin' },
      );
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Failed to load B2B Mechanic Sheet.'),
        );
        return;
      }
      setB2bSheet(data as B2bPowertrainSheetView);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleFetchLocalAd = async (skuOrId: string) => {
    const trimmed = skuOrId.trim();
    if (!trimmed) {
      setErrorMessage('Enter a SKU or Part ID for local classifieds copy.');
      return;
    }
    setErrorMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    try {
      const response = await fetch(
        `/api/marketplace/local-ad-payload/${encodeURIComponent(trimmed)}`,
        { method: 'GET', credentials: 'same-origin' },
      );
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Failed to load local classifieds ad.'),
        );
        return;
      }
      setLocalAdPayload(data as LocalAdPayloadView);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleMarkPostedLocal = async () => {
    if (!localAdPayload) return;
    setErrorMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    const key = generateClientUuid();
    try {
      const response = await fetch(
        `/api/marketplace/local-ad-payload/${encodeURIComponent(localAdPayload.qrSkuCode)}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            action: 'mark-posted',
            expectedVersion: localAdPayload.version,
            idempotencyKey: key,
          }),
        },
      );
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Failed to mark classifieds posted.'),
        );
        return;
      }
      setStatusMessage(
        `${data.qrSkuCode} marked ${data.classifiedsSyncState} (Operator Assertion).`,
      );
      await handleFetchLocalAd(localAdPayload.qrSkuCode);
      await refreshLookup(lookupCode);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleConfirmManualDelist = async (
    sku: string,
    channel: 'EBAY' | 'LOCAL_CLASSIFIEDS',
    version: number,
  ) => {
    setErrorMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    const key = generateClientUuid();
    try {
      const response = await fetch(
        `/api/marketplace/local-ad-payload/${encodeURIComponent(sku)}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            action: 'confirm-manual-delist',
            channel,
            expectedVersion: version,
            idempotencyKey: key,
          }),
        },
      );
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Failed to confirm manual delist.'),
        );
        return;
      }
      setStatusMessage(`Confirmed ${channel} delist for ${data.qrSkuCode}.`);
      await refreshUrgentDelistQueue();
      await refreshLookup(lookupCode);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleConfirmBankSettlement = async () => {
    if (!selectedSaleId) {
      setErrorMessage('Select a sale to confirm bank settlement.');
      return;
    }
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    const key = generateClientUuid();
    const actualFeeMinor =
      actualPlatformFeeInput.trim().length > 0
        ? parseCadInputToMinor(actualPlatformFeeInput)
        : undefined;
    if (actualPlatformFeeInput.trim().length > 0 && actualFeeMinor === null) {
      setErrorMessage('Actual platform fee must be a valid CAD amount.');
      setBusy(false);
      return;
    }

    try {
      const response = await fetch('/api/salvage/checkout/domestic', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          action: 'confirm-bank-settlement',
          saleId: selectedSaleId,
          bankDepositReference: bankDepositReference.trim(),
          settlementProofStorageKey: settlementProofStorageKey.trim(),
          actualPlatformFeeMinor: actualFeeMinor ?? undefined,
          feeTaxInvoiceStorageKey: feeTaxInvoiceStorageKey.trim() || null,
          idempotencyKey: key,
        }),
      });
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Bank settlement confirmation failed.'),
        );
        return;
      }
      setStatusMessage(
        `Bank settlement confirmed for ${data.receiptNumber} -> ${data.cashCustodyState} (ITC Receivable: ${formatCad(data.itcReceivableCadMinor ?? 0)}).`,
      );
      await refreshSettlementQueue();
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const handleRecordRefund = async () => {
    if (!selectedSaleId) {
      setErrorMessage('Select a sale to record refund or chargeback.');
      return;
    }
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    const orgAtStart = props.organizationId;
    const key = generateClientUuid();

    try {
      const response = await fetch('/api/salvage/checkout/domestic', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          action: 'record-refund-or-chargeback',
          saleId: selectedSaleId,
          reasonNote: refundReasonNote.trim(),
          returnPartsToQcHold,
          refundBankReference: refundBankReference.trim() || null,
          refundProofStorageKey: refundProofStorageKey.trim() || null,
          idempotencyKey: key,
        }),
      });
      if (activeOrgRef.current !== orgAtStart) return;
      const data = await response.json();
      if (!response.ok) {
        setErrorMessage(
          readApiErrorMessage(data, 'Recording refund/chargeback failed.'),
        );
        return;
      }
      const outcome = data as RefundOutcomeView;
      setLastRefundOutcome(outcome);
      setStatusMessage(
        `Reversal ${outcome.creditNoteReference} posted (${outcome.chosenFundingSource}, evidence: ${outcome.proofOrigin}).`,
      );
      await refreshSettlementQueue();
      await refreshLookup(lookupCode);
    } finally {
      if (activeOrgRef.current === orgAtStart) setBusy(false);
    }
  };

  const selectedSale = settlementSales.find((s) => s.id === selectedSaleId);

  return (
    <main
      data-testid="domestic-checkout-workspace"
      style={{
        maxWidth: '1040px',
        margin: '0 auto',
        padding: '16px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#0F172A',
      }}
    >
      <header
        style={{
          marginBottom: '16px',
          paddingBottom: '12px',
          borderBottom: '2px solid #CBD5E1',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: '12px',
          alignItems: 'center',
        }}
      >
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0 }}>
            Domestic CAD Checkout &amp; Syndication Desk
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#334155' }}>
            Workspace: <strong>{props.organizationName}</strong> ({props.actorRole})
          </p>
        </div>

        <nav
          aria-label="Checkout workspace tabs"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
        >
          <button
            type="button"
            data-testid="tab-checkout"
            style={
              activeTab === 'checkout'
                ? TOUCH_BUTTON_STYLE
                : SECONDARY_BUTTON_STYLE
            }
            onClick={() => setActiveTab('checkout')}
          >
            CAD Checkout
          </button>
          <button
            type="button"
            data-testid="tab-syndication"
            style={
              activeTab === 'syndication'
                ? TOUCH_BUTTON_STYLE
                : SECONDARY_BUTTON_STYLE
            }
            onClick={() => setActiveTab('syndication')}
          >
            Syndication &amp; B2B
            {urgentQueue && urgentQueue.items.length > 0
              ? ` (${urgentQueue.items.length} Delist)`
              : ''}
          </button>
          {isCfo ? (
            <button
              type="button"
              data-testid="tab-settlement"
              style={
                activeTab === 'settlement'
                  ? TOUCH_BUTTON_STYLE
                  : SECONDARY_BUTTON_STYLE
              }
              onClick={() => {
                setActiveTab('settlement');
                void refreshSettlementQueue();
              }}
            >
              CFO Settlement &amp; Refunds
            </button>
          ) : null}
        </nav>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          data-testid="checkout-error-banner"
          style={{
            marginBottom: '14px',
            padding: '12px 16px',
            borderRadius: '8px',
            backgroundColor: '#FEF2F2',
            border: '2px solid #991B1B',
            color: '#991B1B',
            fontWeight: 700,
          }}
        >
          {errorMessage}
        </div>
      ) : null}

      {statusMessage ? (
        <div
          role="status"
          data-testid="checkout-status-banner"
          style={{
            marginBottom: '14px',
            padding: '12px 16px',
            borderRadius: '8px',
            backgroundColor: '#ECFDF5',
            border: '2px solid #065F46',
            color: '#065F46',
            fontWeight: 700,
          }}
        >
          {statusMessage}
        </div>
      ) : null}

      {activeTab === 'checkout' ? (
        <section aria-label="Domestic CAD Checkout">
          <div
            style={{
              padding: '16px',
              borderRadius: '10px',
              border: '2px solid #CBD5E1',
              backgroundColor: '#F8FAFC',
              marginBottom: '16px',
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: '18px', fontWeight: 800 }}>
              1. Scan SKU / Stock Number
            </h2>
            <QrScannerInput
              onScan={handleScanLookup}
              busy={busy}
              label="Scan Part QR SKU or Vehicle Stock #"
              placeholder="e.g. PRT-884920 or STK-100001"
            />
            <div
              style={{
                display: 'flex',
                gap: '8px',
                marginTop: '10px',
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                aria-label="Filter SKU or Stock Number"
                data-testid="lookup-filter-input"
                value={lookupCode}
                onChange={(e) => setLookupCode(e.target.value)}
                placeholder="Filter by SKU or stock #"
                style={{ ...INPUT_STYLE, flex: '1 1 240px' }}
              />
              <button
                type="button"
                data-testid="lookup-search-button"
                style={SECONDARY_BUTTON_STYLE}
                disabled={busy}
                onClick={() => void refreshLookup(lookupCode)}
              >
                Lookup Inventory
              </button>
            </div>

            <div
              data-testid="lookup-results"
              style={{
                display: 'grid',
                gap: '10px',
                marginTop: '14px',
              }}
            >
              {lookupItems.map((item) => (
                <div
                  key={item.itemId}
                  data-testid={`lookup-item-${item.code}`}
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    border: '2px solid #94A3B8',
                    backgroundColor: '#FFFFFF',
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    gap: '10px',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '16px' }}>
                      {item.code} — {item.label}
                    </div>
                    <div style={{ fontSize: '13px', color: '#334155' }}>
                      Status: <strong>{item.availabilityState}</strong> /{' '}
                      {item.custodyOrLifecycleState}
                      {item.ebaySyncState
                        ? ` | eBay: ${item.ebaySyncState}`
                        : ''}
                      {item.tdgHazmatCode && item.tdgHazmatCode !== 'NONE'
                        ? ` | TDG: ${item.tdgHazmatCode} (Local Pickup Only)`
                        : ''}
                    </div>
                    <div style={{ fontSize: '14px', marginTop: '4px' }}>
                      {item.resolvedPrice ? (
                        <>
                          Floor: <strong>{formatCad(item.resolvedPrice.amountCadMinor)}</strong>{' '}
                          <span
                            data-testid={`price-source-${item.code}`}
                            style={{
                              fontSize: '12px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              backgroundColor: '#E2E8F0',
                            }}
                          >
                            {PRICE_SOURCE_LABELS[item.resolvedPrice.source] ??
                              item.resolvedPrice.source}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: '#991B1B', fontWeight: 700 }}>
                          {item.priceError ?? 'No floor price configured'}
                        </span>
                      )}
                    </div>
                    {item.inReturnQcHold ? (
                      <div
                        data-testid={`qc-hold-badge-${item.code}`}
                        style={{
                          marginTop: '4px',
                          color: '#991B1B',
                          fontWeight: 800,
                          fontSize: '13px',
                        }}
                      >
                        BLOCKED: PART IN RETURN QC HOLD
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    data-testid={`add-basket-${item.code}`}
                    style={
                      item.inReturnQcHold ||
                      item.hasActiveSale ||
                      !item.resolvedPrice
                        ? SECONDARY_BUTTON_STYLE
                        : TOUCH_BUTTON_STYLE
                    }
                    disabled={
                      item.inReturnQcHold ||
                      item.hasActiveSale ||
                      !item.resolvedPrice
                    }
                    onClick={() => addToBasket(item)}
                  >
                    {item.inReturnQcHold
                      ? 'QC Hold'
                      : item.hasActiveSale
                        ? 'Sold/Active'
                        : 'Add to Basket'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <form
            data-testid="domestic-checkout-form"
            onSubmit={handleCheckoutSubmit}
            style={{
              padding: '16px',
              borderRadius: '10px',
              border: '2px solid #0F172A',
              backgroundColor: '#FFFFFF',
              display: 'grid',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>
              2. Basket &amp; Ontario CAD Settlement
            </h2>

            {basket.length === 0 ? (
              <p style={{ margin: 0, color: '#475569' }}>
                Basket is empty. Scan or add a SKU/vehicle above.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: '10px' }}>
                {basket.map((line) => (
                  <div
                    key={line.item.itemId}
                    data-testid={`basket-line-${line.item.code}`}
                    style={{
                      padding: '10px',
                      borderRadius: '8px',
                      border: '1px solid #CBD5E1',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '10px',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <strong>{line.item.code}</strong> ({line.item.label})
                      <div style={{ fontSize: '12px', color: '#475569' }}>
                        Floor:{' '}
                        {formatCad(
                          line.item.resolvedPrice?.amountCadMinor ?? 0,
                        )}{' '}
                        ({line.item.resolvedPrice?.source})
                      </div>
                      {line.item.ebaySyncState === 'SYNDICATED_LIVE' &&
                      domesticChannel !== 'EBAY_MOTORS_SHIPPED' ? (
                        <div
                          style={{
                            marginTop: '6px',
                            padding: '8px',
                            borderRadius: '6px',
                            backgroundColor: '#FFFBEB',
                            border: '1px solid #D97706',
                            fontSize: '13px',
                          }}
                        >
                          <strong>Live on eBay!</strong>{' '}
                          <a
                            href="https://www.ebay.ca/sh/lst/active"
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: '#B45309', fontWeight: 700 }}
                          >
                            Delist on eBay Seller Hub First
                          </a>
                        </div>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                      }}
                    >
                      <label style={{ fontSize: '13px', fontWeight: 700 }}>
                        Ask (CAD)
                        <input
                          type="text"
                          data-testid={`ask-input-${line.item.code}`}
                          value={line.proposedPriceInputCad}
                          onChange={(e) => {
                            const nextVal = e.target.value;
                            setBasket((prev) =>
                              prev.map((entry) =>
                                entry.item.itemId === line.item.itemId
                                  ? { ...entry, proposedPriceInputCad: nextVal }
                                  : entry,
                              ),
                            );
                          }}
                          style={{ ...INPUT_STYLE, width: '130px' }}
                        />
                      </label>
                      <button
                        type="button"
                        style={SECONDARY_BUTTON_STYLE}
                        onClick={() => removeFromBasket(line.item.itemId)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}

                <div
                  data-testid="basket-corridor-summary"
                  style={{
                    padding: '10px',
                    borderRadius: '8px',
                    backgroundColor: '#F1F5F9',
                    fontSize: '14px',
                  }}
                >
                  Floor Total:{' '}
                  <strong>{formatCad(basketSummary.floorTotalMinor)}</strong> |
                  10% Corridor Min:{' '}
                  <strong>{formatCad(basketSummary.tierThresholdMinor)}</strong>{' '}
                  | Proposed:{' '}
                  <strong>{formatCad(basketSummary.proposedTotalMinor)}</strong>
                </div>
              </div>
            )}

            {basketSummary.requiresDelistAttestation ? (
              <div
                data-testid="ebay-delist-attestation-box"
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: '#FEF3C7',
                  border: '2px solid #D97706',
                }}
              >
                <div style={{ fontWeight: 800, marginBottom: '8px' }}>
                  Mandatory Pre-Checkout Action: Delist Live eBay SKU Locally
                </div>
                <button
                  type="button"
                  data-testid="attest-ebay-delisted-button"
                  style={WARNING_BUTTON_STYLE}
                  onClick={() =>
                    setEbayDelistAttestedAt(new Date().toISOString())
                  }
                >
                  {ebayDelistAttestedAt
                    ? `Attested at ${ebayDelistAttestedAt}`
                    : 'I Have Delisted This Part on eBay Seller Hub'}
                </button>
              </div>
            ) : null}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '12px',
              }}
            >
              <label style={{ fontWeight: 700, fontSize: '14px' }}>
                Domestic Sale Channel
                <select
                  data-testid="channel-select"
                  value={domesticChannel}
                  onChange={(e) => {
                    const next = e.target.value as DomesticChannel;
                    setDomesticChannel(next);
                    if (next === 'EBAY_MOTORS_SHIPPED') {
                      setDeliveryMethod('SELLER_SHIPPED_PARCEL_OR_FREIGHT');
                      setPaymentMethod('EBAY_MANAGED_PAYOUT');
                    }
                  }}
                  style={INPUT_STYLE}
                >
                  <option value="LOCAL_WALK_IN_CASH">Local Walk-In Cash</option>
                  <option value="FB_MARKETPLACE_LOCAL">
                    FB Marketplace Local
                  </option>
                  <option value="KIJIJI_LOCAL">Kijiji Local</option>
                  <option value="RETAIL_LOT_VEHICLE_SALE">
                    Retail Lot Vehicle Sale
                  </option>
                  <option value="WHOLESALE_MECHANIC_NETWORK">
                    Wholesale Mechanic Network
                  </option>
                  <option value="EBAY_MOTORS_SHIPPED">
                    eBay Canada Shipped (Billing Agent)
                  </option>
                  <option value="CAR_PART_WHOLESALE">Car-Part Wholesale</option>
                </select>
              </label>

              <label style={{ fontWeight: 700, fontSize: '14px' }}>
                Payment Method
                <select
                  data-testid="payment-method-select"
                  value={paymentMethod}
                  onChange={(e) =>
                    setPaymentMethod(e.target.value as PaymentMethod)
                  }
                  style={INPUT_STYLE}
                >
                  <option value="CASH">Cash (Operator Float)</option>
                  <option value="INTERAC_ETRANSFER">
                    Interac e-Transfer (Pending Bank)
                  </option>
                  <option value="VERIFIED_BANK_WIRE">
                    Bank Wire (Pending Bank)
                  </option>
                  <option value="EBAY_MANAGED_PAYOUT">
                    eBay Managed Payout (Pending Receivable)
                  </option>
                </select>
              </label>

              <label style={{ fontWeight: 700, fontSize: '14px' }}>
                Delivery Method (CRA Place-of-Supply)
                <select
                  data-testid="delivery-method-select"
                  value={deliveryMethod}
                  onChange={(e) =>
                    setDeliveryMethod(e.target.value as DeliveryMethod)
                  }
                  style={INPUT_STYLE}
                >
                  <option value="PICKUP_AT_ORIGIN">
                    Pickup at Kemptville Origin (ON 13%)
                  </option>
                  <option value="LOCAL_DELIVERY_ONTARIO">
                    Local Delivery in Ontario (ON 13%)
                  </option>
                  <option value="SELLER_SHIPPED_PARCEL_OR_FREIGHT">
                    Seller Shipped Parcel / Freight (Destination Tax)
                  </option>
                </select>
              </label>

              <label style={{ fontWeight: 700, fontSize: '14px' }}>
                Destination Country (ISO-2)
                <input
                  type="text"
                  data-testid="destination-country-input"
                  value={destinationCountryCode}
                  onChange={(e) =>
                    setDestinationCountryCode(e.target.value.toUpperCase())
                  }
                  maxLength={2}
                  style={INPUT_STYLE}
                />
              </label>

              {destinationCountryCode.trim().toUpperCase() === 'CA' ? (
                <label style={{ fontWeight: 700, fontSize: '14px' }}>
                  Canadian Destination Province
                  <select
                    data-testid="destination-province-select"
                    value={destinationProvinceOrState}
                    onChange={(e) =>
                      setDestinationProvinceOrState(e.target.value)
                    }
                    style={INPUT_STYLE}
                  >
                    {CANADIAN_PROVINCES.map((prov) => (
                      <option key={prov.code} value={prov.code}>
                        {prov.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label style={{ fontWeight: 700, fontSize: '14px' }}>
                  Destination State / Region
                  <input
                    type="text"
                    data-testid="destination-state-input"
                    value={destinationProvinceOrState}
                    onChange={(e) =>
                      setDestinationProvinceOrState(e.target.value)
                    }
                    placeholder="e.g. NY"
                    style={INPUT_STYLE}
                  />
                </label>
              )}

              <label style={{ fontWeight: 700, fontSize: '14px' }}>
                Buyer Name *
                <input
                  type="text"
                  data-testid="buyer-name-input"
                  value={buyerName}
                  onChange={(e) => setBuyerName(e.target.value)}
                  required
                  style={INPUT_STYLE}
                />
              </label>

              <label style={{ fontWeight: 700, fontSize: '14px' }}>
                Buyer Phone (E.164 optional)
                <input
                  type="text"
                  data-testid="buyer-phone-input"
                  value={buyerPhoneE164}
                  onChange={(e) => setBuyerPhoneE164(e.target.value)}
                  placeholder="+16135550199"
                  style={INPUT_STYLE}
                />
              </label>
            </div>

            {paymentMethod === 'CASH' ? (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontWeight: 700,
                  minHeight: '56px',
                }}
              >
                <input
                  type="checkbox"
                  data-testid="cash-counted-checkbox"
                  checked={isCashCountedInPerson}
                  onChange={(e) => setIsCashCountedInPerson(e.target.checked)}
                  style={{ width: '24px', height: '24px' }}
                />
                Physical cash counted &amp; verified in person
              </label>
            ) : null}

            {domesticChannel === 'EBAY_MOTORS_SHIPPED' ? (
              <div
                data-testid="ebay-tax-channel-panel"
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: '#EFF6FF',
                  border: '2px solid #1D4ED8',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    gridColumn: '1 / -1',
                    fontSize: '13px',
                    fontWeight: 700,
                    color: '#1E3A8A',
                  }}
                >
                  eBay Billing Agent Mode (MARKETPLACE_FACILITATOR_COLLECTED):
                  corporate GST/HST collected = $0.00. Never fabricate buyer tax
                  from 13%; leave blank if marketplace-reported amount is
                  unavailable.
                </div>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Buyer Tax Remitted by eBay (CAD, optional)
                  <input
                    type="text"
                    data-testid="ebay-buyer-tax-input"
                    value={buyerTaxPlatformInput}
                    onChange={(e) => setBuyerTaxPlatformInput(e.target.value)}
                    placeholder="Blank preserves null"
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Platform Fee (CAD)
                  <input
                    type="text"
                    data-testid="ebay-platform-fee-input"
                    value={platformFeeInput}
                    onChange={(e) => setPlatformFeeInput(e.target.value)}
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Shipping Label Cost (CAD)
                  <input
                    type="text"
                    data-testid="ebay-shipping-cost-input"
                    value={shippingCostInput}
                    onChange={(e) => setShippingCostInput(e.target.value)}
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Est. Tax on eBay Seller Fees (CAD)
                  <input
                    type="text"
                    data-testid="ebay-est-fee-tax-input"
                    value={estimatedFeeTaxInput}
                    onChange={(e) => setEstimatedFeeTaxInput(e.target.value)}
                    style={INPUT_STYLE}
                  />
                </label>
              </div>
            ) : null}

            {basketSummary.requiresReason ||
            basketSummary.requiresCfoOverride ||
            discountReasonCode ? (
              <div
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: '#FFF7ED',
                  border: '2px solid #C2410C',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <label style={{ fontSize: '14px', fontWeight: 700 }}>
                  Discount Reason Code (Required below floor price)
                  <input
                    type="text"
                    data-testid="discount-reason-input"
                    value={discountReasonCode}
                    onChange={(e) => setDiscountReasonCode(e.target.value)}
                    placeholder="e.g. COUNTER_BUNDLE_PICKUP"
                    style={INPUT_STYLE}
                  />
                </label>
                {basketSummary.requiresCfoOverride ? (
                  <div style={{ display: 'grid', gap: '8px' }}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        fontWeight: 700,
                      }}
                    >
                      <input
                        type="checkbox"
                        data-testid="cfo-override-checkbox"
                        checked={cfoOverrideRequested}
                        disabled={!isCfo}
                        onChange={(e) =>
                          setCfoOverrideRequested(e.target.checked)
                        }
                        style={{ width: '24px', height: '24px' }}
                      />
                      1-Tap CFO Price Floor Override (below 10% corridor)
                      {!isCfo ? ' — ARCHITECT_CFO required' : ''}
                    </label>
                    <input
                      type="text"
                      data-testid="cfo-override-note-input"
                      value={cfoOverrideReasonNote}
                      disabled={!isCfo}
                      onChange={(e) => setCfoOverrideReasonNote(e.target.value)}
                      placeholder="CFO Override Justification Note"
                      style={INPUT_STYLE}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '12px',
              }}
            >
              <div>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Payment Proof Upload * (Private R2 Evidence)
                  <input
                    type="file"
                    data-testid="payment-proof-file-input"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) =>
                      void handleEvidenceUpload(
                        'PAYMENT_PROOF',
                        e.target.files?.[0] ?? null,
                      )
                    }
                    style={{ display: 'block', marginTop: '6px' }}
                  />
                </label>
                <input
                  type="text"
                  data-testid="payment-proof-key-input"
                  value={paymentProofStorageKey}
                  onChange={(e) => setPaymentProofStorageKey(e.target.value)}
                  placeholder="Storage key from upload"
                  style={{ ...INPUT_STYLE, marginTop: '6px' }}
                />
              </div>

              {basketSummary.hasVehicle ? (
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 700 }}>
                    Signed Ontario Bill of Sale Upload *
                    <input
                      type="file"
                      data-testid="bill-of-sale-file-input"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onChange={(e) =>
                        void handleEvidenceUpload(
                          'BILL_OF_SALE',
                          e.target.files?.[0] ?? null,
                        )
                      }
                      style={{ display: 'block', marginTop: '6px' }}
                    />
                  </label>
                  <input
                    type="text"
                    data-testid="bill-of-sale-key-input"
                    value={billOfSaleStorageKey}
                    onChange={(e) => setBillOfSaleStorageKey(e.target.value)}
                    placeholder="Bill of sale storage key"
                    style={{ ...INPUT_STYLE, marginTop: '6px' }}
                  />
                </div>
              ) : null}

              {basketSummary.requiresExportProof ? (
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 700 }}>
                    Export Proof Upload * (Required for Zero-Rating)
                    <input
                      type="file"
                      data-testid="export-proof-file-input"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onChange={(e) =>
                        void handleEvidenceUpload(
                          'EXPORT_PROOF',
                          e.target.files?.[0] ?? null,
                        )
                      }
                      style={{ display: 'block', marginTop: '6px' }}
                    />
                  </label>
                  <input
                    type="text"
                    data-testid="export-proof-key-input"
                    value={exportProofStorageKey}
                    onChange={(e) => setExportProofStorageKey(e.target.value)}
                    placeholder="Export proof storage key"
                    style={{ ...INPUT_STYLE, marginTop: '6px' }}
                  />
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              data-testid="execute-checkout-button"
              disabled={busy}
              style={{ ...TOUCH_BUTTON_STYLE, width: '100%' }}
            >
              {busy ? 'Recording Sale...' : 'Execute Domestic CAD Checkout'}
            </button>
          </form>

          {lastReceipt ? (
            <section
              data-testid="checkout-receipt-card"
              style={{
                marginTop: '16px',
                padding: '16px',
                borderRadius: '10px',
                border: '2px solid #065F46',
                backgroundColor: '#ECFDF5',
              }}
            >
              <h3 style={{ marginTop: 0, fontSize: '18px' }}>
                Checkout Confirmed: {lastReceipt.receiptNumber}
              </h3>
              <p style={{ margin: '4px 0' }}>
                Settlement Status:{' '}
                <strong data-testid="receipt-settlement-state">
                  {lastReceipt.paymentSettlementState}
                </strong>{' '}
                | Cash Custody:{' '}
                <strong data-testid="receipt-custody-state">
                  {lastReceipt.cashCustodyState}
                </strong>
              </p>
              <p style={{ margin: '4px 0' }}>
                Tax Mode: <strong>{lastReceipt.taxCollectionMode}</strong> |
                Jurisdiction: <strong>{lastReceipt.appliedTaxJurisdiction}</strong>{' '}
                ({(lastReceipt.appliedTaxRateBps / 100).toFixed(0)}%) | Corp
                Tax: <strong>{formatCad(lastReceipt.taxOrVatMinor)}</strong>
                {lastReceipt.buyerTaxRemittedByPlatformMinor !== null
                  ? ` | eBay Platform Remitted Buyer Tax: ${formatCad(lastReceipt.buyerTaxRemittedByPlatformMinor)}`
                  : ''}
              </p>
              <p style={{ margin: '4px 0' }}>
                Gross Collected:{' '}
                <strong>{formatCad(lastReceipt.grossCollectedMinor)}</strong> |
                Net Realized CAD:{' '}
                <strong>{formatCad(lastReceipt.netRealizedCadMinor)}</strong>
              </p>
              {lastReceipt.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT' ? (
                <p style={{ margin: '8px 0 0', fontWeight: 700 }}>
                  Cash is held in Operator Float (excluded from Confirmed Corp
                  Bank Cash).{' '}
                  <a href="/expenses" style={{ color: '#065F46' }}>
                    Record Cash Custody Bank Sweep in /expenses
                  </a>
                </p>
              ) : null}
              {lastReceipt.cashCustodyState === 'PENDING_EXTERNAL_RECEIVABLE' ? (
                <p style={{ margin: '8px 0 0', fontWeight: 700 }}>
                  Pending External Receivable — excluded from Confirmed Corp
                  Bank Cash &amp; Deployable Working Capital until CFO confirms
                  bank deposit settlement.
                </p>
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'syndication' ? (
        <section
          aria-label="Domestic Syndication and B2B Powertrain"
          style={{ display: 'grid', gap: '16px' }}
        >
          <div
            style={{
              padding: '16px',
              borderRadius: '10px',
              border: '2px solid #0F172A',
              backgroundColor: '#FFFFFF',
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: '18px' }}>
              Two-Step eBay Seller Hub Canada CSV Feed
            </h2>
            <p style={{ fontSize: '13px', color: '#334155' }}>
              Exports eligible parts (&lt;15 kg, non-TDG hazmat) with true
              warehouse ship-from (Kemptville, ON / K0G 1J0). Export transitions
              parts to <code>CSV_EXPORTED_PENDING_CONFIRMATION</code>; Seller
              Hub confirmation records an explicit Operator Assertion.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button
                type="button"
                data-testid="preview-ebay-csv-button"
                style={SECONDARY_BUTTON_STYLE}
                disabled={busy}
                onClick={() => void handleLoadEbayPreview()}
              >
                Preview Eligible Parts
              </button>
              <button
                type="button"
                data-testid="commit-ebay-csv-button"
                style={TOUCH_BUTTON_STYLE}
                disabled={busy}
                onClick={() => void handleCommitEbayCsv()}
              >
                Export Seller Hub CSV
              </button>
            </div>

            {ebayPreview ? (
              <div
                data-testid="ebay-preview-panel"
                style={{ marginTop: '12px', fontSize: '14px' }}
              >
                Eligible SKUs:{' '}
                <strong>
                  {ebayPreview.eligibleSkus.join(', ') || 'None'}
                </strong>
                {ebayPreview.ineligibleParts.length > 0 ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                    {ebayPreview.ineligibleParts.map((bad) => (
                      <li key={bad.partId}>
                        <strong>{bad.qrSkuCode}</strong>: {bad.reasonCode} —{' '}
                        {bad.reasonMessage}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {lastEbayExport ? (
              <div
                data-testid="ebay-export-result"
                style={{
                  marginTop: '12px',
                  padding: '10px',
                  backgroundColor: '#F8FAFC',
                  borderRadius: '8px',
                  border: '1px solid #CBD5E1',
                }}
              >
                <div>
                  Export ID: <strong>{lastEbayExport.exportId}</strong> | SKUs:{' '}
                  <strong>{lastEbayExport.exportedSkus.join(', ')}</strong>
                </div>
                <pre
                  style={{
                    maxHeight: '160px',
                    overflow: 'auto',
                    fontSize: '12px',
                    marginTop: '8px',
                  }}
                >
                  {lastEbayExport.csvContent}
                </pre>
              </div>
            ) : null}

            <div
              style={{
                marginTop: '12px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '10px',
                alignItems: 'flex-end',
              }}
            >
              <label style={{ flex: '1 1 220px', fontSize: '13px', fontWeight: 700 }}>
                Part UUID (Operator Assertion)
                <input
                  type="text"
                  data-testid="confirm-live-part-id-input"
                  value={confirmPartId}
                  onChange={(e) => setConfirmPartId(e.target.value)}
                  placeholder="Exported part UUID"
                  style={INPUT_STYLE}
                />
              </label>
              <label style={{ flex: '1 1 200px', fontSize: '13px', fontWeight: 700 }}>
                Seller Hub eBay Listing ID
                <input
                  type="text"
                  data-testid="confirm-live-listing-id-input"
                  value={confirmListingId}
                  onChange={(e) => setConfirmListingId(e.target.value)}
                  placeholder="e.g. 285912345678"
                  style={INPUT_STYLE}
                />
              </label>
              <button
                type="button"
                data-testid="confirm-ebay-live-button"
                style={TOUCH_BUTTON_STYLE}
                disabled={busy}
                onClick={() => void handleConfirmEbayLive()}
              >
                Confirm eBay Listing Live
              </button>
            </div>
          </div>

          <div
            style={{
              padding: '16px',
              borderRadius: '10px',
              border: '2px solid #334155',
              backgroundColor: '#FFFFFF',
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: '18px' }}>
              Day-1 Ottawa/Gatineau B2B Mechanic Powertrain Sheet
            </h2>
            <button
              type="button"
              data-testid="load-b2b-sheet-button"
              style={SECONDARY_BUTTON_STYLE}
              disabled={busy}
              onClick={() => void handleLoadB2bSheet()}
            >
              Load B2B Mechanic Sheet
            </button>
            {b2bSheet ? (
              <div data-testid="b2b-sheet-panel" style={{ marginTop: '12px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>
                  Public Pickup Label: {b2bSheet.publicPickupLocationLabel}
                </div>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    backgroundColor: '#F8FAFC',
                    padding: '10px',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                >
                  {b2bSheet.whatsappMarkdownText}
                </pre>
              </div>
            ) : null}
          </div>

          <div
            style={{
              padding: '16px',
              borderRadius: '10px',
              border: '2px solid #334155',
              backgroundColor: '#FFFFFF',
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: '18px' }}>
              FB Marketplace / Kijiji Local Copy &amp; Urgent Delist Queue
            </h2>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                data-testid="local-ad-sku-input"
                value={localLookupSku}
                onChange={(e) => setLocalLookupSku(e.target.value)}
                placeholder="Enter SKU e.g. PRT-884920"
                style={{ ...INPUT_STYLE, flex: '1 1 220px' }}
              />
              <button
                type="button"
                data-testid="load-local-ad-button"
                style={SECONDARY_BUTTON_STYLE}
                disabled={busy}
                onClick={() => void handleFetchLocalAd(localLookupSku)}
              >
                Load Local Ad Copy
              </button>
            </div>
            {localAdPayload ? (
              <div
                data-testid="local-ad-payload-panel"
                style={{
                  marginTop: '12px',
                  padding: '12px',
                  borderRadius: '8px',
                  backgroundColor: '#F8FAFC',
                }}
              >
                <div>
                  <strong>{localAdPayload.title}</strong> —{' '}
                  {formatCad(localAdPayload.askCadMinor)}
                </div>
                <div style={{ fontSize: '13px', color: '#334155' }}>
                  Corridor Mask:{' '}
                  <strong>{localAdPayload.publicPickupLocationLabel}</strong> |
                  Sync: {localAdPayload.classifiedsSyncState}
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: '13px' }}>
                  {localAdPayload.body}
                </pre>
                <button
                  type="button"
                  data-testid="mark-posted-local-button"
                  style={TOUCH_BUTTON_STYLE}
                  disabled={busy}
                  onClick={() => void handleMarkPostedLocal()}
                >
                  Mark Posted (Operator Assertion)
                </button>
              </div>
            ) : null}

            <div style={{ marginTop: '14px' }}>
              <h3 style={{ marginBottom: '8px', fontSize: '16px' }}>
                Urgent Delist Queue ({urgentQueue?.items.length ?? 0})
              </h3>
              {urgentQueue?.classifiedsConfirmationNotice ? (
                <p
                  data-testid="urgent-delist-classifieds-notice"
                  style={{
                    margin: '0 0 10px 0',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    backgroundColor: '#FEF3C7',
                    border: '1px solid #F59E0B',
                    fontSize: '13px',
                    color: '#78350F',
                  }}
                >
                  {urgentQueue.classifiedsConfirmationNotice}
                </p>
              ) : null}
              {urgentQueue?.items.map((item) => (
                <div
                  key={item.partId}
                  data-testid={`urgent-delist-item-${item.qrSkuCode}`}
                  style={{
                    padding: '10px',
                    borderRadius: '8px',
                    border: '2px solid #D97706',
                    backgroundColor: '#FFFBEB',
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    gap: '8px',
                    alignItems: 'center',
                    marginBottom: '8px',
                  }}
                >
                  <div>
                    <strong>{item.qrSkuCode}</strong> ({item.partCategoryName})
                    — eBay: {item.ebaySyncState} | Classifieds:{' '}
                    {item.classifiedsSyncState}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {item.ebaySyncState === 'DELIST_PENDING' ? (
                      <button
                        type="button"
                        data-testid={`confirm-delist-ebay-${item.qrSkuCode}`}
                        style={WARNING_BUTTON_STYLE}
                        disabled={busy}
                        onClick={() =>
                          void handleConfirmManualDelist(
                            item.qrSkuCode,
                            'EBAY',
                            item.version,
                          )
                        }
                      >
                        Confirm eBay Delisted
                      </button>
                    ) : null}
                    {item.classifiedsSyncState === 'DELIST_REQUIRED' ? (
                      <button
                        type="button"
                        data-testid={`confirm-delist-local-${item.qrSkuCode}`}
                        style={WARNING_BUTTON_STYLE}
                        disabled={busy}
                        onClick={() =>
                          void handleConfirmManualDelist(
                            item.qrSkuCode,
                            'LOCAL_CLASSIFIEDS',
                            item.version,
                          )
                        }
                      >
                        Confirm Classifieds Delisted
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === 'settlement' && isCfo ? (
        <section
          aria-label="CFO Bank Settlement, ITC Verification, and Refunds"
          style={{ display: 'grid', gap: '16px' }}
        >
          <div
            style={{
              padding: '16px',
              borderRadius: '10px',
              border: '2px solid #0F172A',
              backgroundColor: '#FFFFFF',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px' }}>
                Domestic Sales Settlement &amp; Reversal Ledger
              </h2>
              <button
                type="button"
                data-testid="refresh-settlement-queue-button"
                style={SECONDARY_BUTTON_STYLE}
                disabled={busy}
                onClick={() => void refreshSettlementQueue()}
              >
                Refresh Queue
              </button>
            </div>

            <div style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
              {settlementSales.map((sale) => (
                <button
                  key={sale.id}
                  type="button"
                  data-testid={`settlement-sale-${sale.receiptNumber}`}
                  style={{
                    ...SECONDARY_BUTTON_STYLE,
                    textAlign: 'left',
                    borderColor:
                      selectedSaleId === sale.id ? '#1D4ED8' : '#CBD5E1',
                    backgroundColor:
                      selectedSaleId === sale.id ? '#EFF6FF' : '#F8FAFC',
                  }}
                  onClick={() => setSelectedSaleId(sale.id)}
                >
                  <strong>{sale.receiptNumber}</strong> — {sale.buyerName} |{' '}
                  {formatCad(sale.grossCollectedMinor)} |{' '}
                  <span>{sale.paymentSettlementState}</span> /{' '}
                  <span>{sale.cashCustodyState}</span>
                  {sale.isVoidedOrReversed ? ' [REVERSED]' : ''}
                </button>
              ))}
            </div>
          </div>

          {selectedSale ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: '16px',
              }}
            >
              <div
                style={{
                  padding: '16px',
                  borderRadius: '10px',
                  border: '2px solid #065F46',
                  backgroundColor: '#FFFFFF',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <h3 style={{ margin: 0, fontSize: '16px' }}>
                  Confirm Bank Deposit Settlement ({selectedSale.receiptNumber})
                </h3>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Bank Deposit Reference *
                  <input
                    type="text"
                    data-testid="bank-deposit-ref-input"
                    value={bankDepositReference}
                    onChange={(e) => setBankDepositReference(e.target.value)}
                    placeholder="e.g. RBC-DEP-20261116-01"
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Settlement Bank Statement Proof *
                  <input
                    type="file"
                    data-testid="settlement-proof-file-input"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) =>
                      void handleEvidenceUpload(
                        'SETTLEMENT_PROOF',
                        e.target.files?.[0] ?? null,
                      )
                    }
                    style={{ display: 'block', marginTop: '6px' }}
                  />
                </label>
                <input
                  type="text"
                  data-testid="settlement-proof-key-input"
                  value={settlementProofStorageKey}
                  onChange={(e) => setSettlementProofStorageKey(e.target.value)}
                  placeholder="Settlement proof storage key"
                  style={INPUT_STYLE}
                />
                {selectedSale.domesticChannel === 'EBAY_MOTORS_SHIPPED' ? (
                  <>
                    <label style={{ fontSize: '13px', fontWeight: 700 }}>
                      Actual Reconciled eBay Seller Fee (CAD, optional)
                      <input
                        type="text"
                        data-testid="actual-platform-fee-input"
                        value={actualPlatformFeeInput}
                        onChange={(e) =>
                          setActualPlatformFeeInput(e.target.value)
                        }
                        placeholder="e.g. 15.00"
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={{ fontSize: '13px', fontWeight: 700 }}>
                      Verified eBay Fee Tax Invoice (promotes ITC)
                      <input
                        type="file"
                        data-testid="fee-tax-invoice-file-input"
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        onChange={(e) =>
                          void handleEvidenceUpload(
                            'FEE_TAX_INVOICE',
                            e.target.files?.[0] ?? null,
                          )
                        }
                        style={{ display: 'block', marginTop: '6px' }}
                      />
                    </label>
                    <input
                      type="text"
                      data-testid="fee-tax-invoice-key-input"
                      value={feeTaxInvoiceStorageKey}
                      onChange={(e) =>
                        setFeeTaxInvoiceStorageKey(e.target.value)
                      }
                      placeholder="Fee tax invoice storage key"
                      style={INPUT_STYLE}
                    />
                  </>
                ) : null}
                <button
                  type="button"
                  data-testid="confirm-bank-settlement-button"
                  style={TOUCH_BUTTON_STYLE}
                  disabled={busy}
                  onClick={() => void handleConfirmBankSettlement()}
                >
                  Confirm Bank Settlement
                </button>
              </div>

              <div
                style={{
                  padding: '16px',
                  borderRadius: '10px',
                  border: '2px solid #991B1B',
                  backgroundColor: '#FFFFFF',
                  display: 'grid',
                  gap: '10px',
                }}
              >
                <h3 style={{ margin: 0, fontSize: '16px' }}>
                  Record Refund / Chargeback ({selectedSale.receiptNumber})
                </h3>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Reason Note *
                  <input
                    type="text"
                    data-testid="refund-reason-input"
                    value={refundReasonNote}
                    onChange={(e) => setRefundReasonNote(e.target.value)}
                    placeholder="e.g. Buyer return — verify anti-part-swap UV mark"
                    style={INPUT_STYLE}
                  />
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontWeight: 700,
                    minHeight: '56px',
                  }}
                >
                  <input
                    type="checkbox"
                    data-testid="refund-return-qc-checkbox"
                    checked={returnPartsToQcHold}
                    onChange={(e) => setReturnPartsToQcHold(e.target.checked)}
                    style={{ width: '24px', height: '24px' }}
                  />
                  Return parts to QC Hold (RESTOCKED_QC_HOLD / RETURNED_QC_HOLD)
                </label>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Refund Bank Reference (optional if deterministically resolved)
                  <input
                    type="text"
                    data-testid="refund-bank-ref-input"
                    value={refundBankReference}
                    onChange={(e) => setRefundBankReference(e.target.value)}
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={{ fontSize: '13px', fontWeight: 700 }}>
                  Explicit Refund Proof Upload (optional if inherited/swept
                  proof resolves)
                  <input
                    type="file"
                    data-testid="refund-proof-file-input"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) =>
                      void handleEvidenceUpload(
                        'REFUND_PROOF',
                        e.target.files?.[0] ?? null,
                      )
                    }
                    style={{ display: 'block', marginTop: '6px' }}
                  />
                </label>
                <button
                  type="button"
                  data-testid="record-refund-button"
                  style={DANGER_BUTTON_STYLE}
                  disabled={busy}
                  onClick={() => void handleRecordRefund()}
                >
                  Record Full Refund / Chargeback
                </button>
                {lastRefundOutcome ? (
                  <div
                    data-testid="refund-outcome-box"
                    style={{
                      padding: '10px',
                      borderRadius: '8px',
                      backgroundColor: '#FEF2F2',
                      fontSize: '13px',
                    }}
                  >
                    Credit Note: <strong>{lastRefundOutcome.creditNoteReference}</strong>{' '}
                    | Funding: <strong>{lastRefundOutcome.chosenFundingSource}</strong>{' '}
                    | Proof Origin: <strong>{lastRefundOutcome.proofOrigin}</strong>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
