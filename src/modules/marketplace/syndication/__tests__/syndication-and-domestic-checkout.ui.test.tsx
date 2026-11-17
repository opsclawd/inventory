// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomesticCheckoutForm } from '@/app/(salvage)/checkout/domestic-checkout-form';
import {
  handleDomesticCheckoutGet,
  handleDomesticCheckoutPatch,
  handleDomesticCheckoutPost,
} from '@/modules/logistics-vault/checkout/domestic-checkout-route.handler';
import { AuthError } from '@/modules/shared-ops/auth';
import * as authModule from '@/modules/shared-ops/auth';
import {
  handleEbayCsvGet,
  handleEbayCsvPatch,
  handleEbayCsvPost,
  handleLocalAdPayloadGet,
  handleLocalAdPayloadPatch,
} from '../syndication-route.handler';
import {
  HARNESS_IDS,
  Issue10OfflineTestHarness,
} from '../syndication-test-harness';

function readJsdomFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () =>
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

async function buildRouteRequest(
  url: string,
  method: string,
  init?: RequestInit,
): Promise<Request> {
  const rawBody = init?.body;
  if (rawBody && typeof (rawBody as FormData).getAll === 'function') {
    const jsdomForm = rawBody as FormData;
    const headers = new Headers(init?.headers);
    headers.set('content-type', 'multipart/form-data; boundary=ui-test');

    const rebuilt = new FormData();
    const entries: Array<[string, FormDataEntryValue]> = [];
    jsdomForm.forEach((value, key) => {
      entries.push([key, value]);
    });

    for (const [key, value] of entries) {
      if (typeof value === 'string') {
        rebuilt.append(key, value);
      } else {
        const bytes = await readJsdomFileBytes(value);
        const copied = new Uint8Array(bytes.byteLength);
        copied.set(bytes);
        const ab: ArrayBuffer = copied.buffer;
        const wrappedFile = Object.assign(
          new File([ab], value.name || 'upload.bin', { type: value.type }),
          {
            arrayBuffer: async () => ab,
          },
        );
        rebuilt.append(key, wrappedFile);
      }
    }

    const request = new Request(url, {
      method,
      headers,
    });
    Object.defineProperty(request, 'formData', {
      value: async () => rebuilt,
    });
    return request;
  }

  return new Request(url, {
    ...init,
    method,
  });
}

function makeRouteFetch(
  harness: Issue10OfflineTestHarness,
  getSession: () => ReturnType<Issue10OfflineTestHarness['makeSession']>,
): typeof fetch {
  const { syndicationDeps, checkoutDeps } = harness.createRouteDeps(getSession);

  return async (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = rawUrl.startsWith('http')
      ? rawUrl
      : `https://app.salvage.local${rawUrl}`;
    const method = (init?.method ?? 'GET').toUpperCase();
    const request = await buildRouteRequest(url, method, init);
    const parsed = new URL(url);

    if (parsed.pathname === '/api/salvage/checkout/domestic') {
      if (method === 'GET') return handleDomesticCheckoutGet(request, checkoutDeps);
      if (method === 'POST') return handleDomesticCheckoutPost(request, checkoutDeps);
      if (method === 'PATCH') return handleDomesticCheckoutPatch(request, checkoutDeps);
    }
    if (parsed.pathname === '/api/salvage/syndication/ebay-csv') {
      if (method === 'GET') return handleEbayCsvGet(request, syndicationDeps);
      if (method === 'POST') return handleEbayCsvPost(request, syndicationDeps);
      if (method === 'PATCH') return handleEbayCsvPatch(request, syndicationDeps);
    }
    if (parsed.pathname.startsWith('/api/marketplace/local-ad-payload/')) {
      const sku = decodeURIComponent(
        parsed.pathname.replace('/api/marketplace/local-ad-payload/', ''),
      );
      if (method === 'GET') {
        return handleLocalAdPayloadGet(request, sku, syndicationDeps);
      }
      if (method === 'PATCH') {
        return handleLocalAdPayloadPatch(request, sku, syndicationDeps);
      }
    }
    return new Response(
      JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'Unhandled mock URL' },
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
}

describe('Issue #10 UI — DomesticCheckoutPage & DomesticCheckoutForm', () => {
  let harness: Issue10OfflineTestHarness;

  beforeEach(() => {
    harness = new Issue10OfflineTestHarness();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Server Component renders DomesticCheckoutForm for authorized session and accessible denial on AuthError', async () => {
    const cfo = harness.makeSession();
    vi.spyOn(authModule, 'resolveAuthSessionContext').mockResolvedValueOnce(cfo);

    const { default: DomesticCheckoutPage } = await import(
      '@/app/(salvage)/checkout/page'
    );

    vi.stubGlobal(
      'fetch',
      makeRouteFetch(harness, () => cfo),
    );
    const authorizedTree = await DomesticCheckoutPage();
    render(authorizedTree);
    expect(screen.getByTestId('domestic-checkout-workspace')).toBeTruthy();
    cleanup();

    vi.spyOn(authModule, 'resolveAuthSessionContext').mockRejectedValueOnce(
      new AuthError('CAPABILITY_FORBIDDEN', 'Role denied for domestic checkout.'),
    );
    const deniedTree = await DomesticCheckoutPage();
    render(deniedTree);
    expect(
      screen.getByTestId('domestic-checkout-unauthorized').textContent,
    ).toContain('Role denied for domestic checkout.');
  });

  it('enforces 56x56 touch targets, scans SKU, completes cash checkout with /expenses sweep link, runs local/B2B syndication, and hides CFO tab from mechanics', async () => {
    const user = userEvent.setup();
    const hunter = harness.makeSession({
      userId: HARNESS_IDS.users.HUNTER,
      role: 'HUNTER_MECHANIC',
    });

    vi.stubGlobal(
      'fetch',
      makeRouteFetch(harness, () => hunter),
    );

    render(
      <DomesticCheckoutForm
        organizationId={HARNESS_IDS.orgs.SALVAGE}
        organizationName="Kemptville Salvage & Export Corp."
        actorUserId={hunter.userId}
        actorRole={hunter.role}
      />,
    );

    // Mechanic never sees CFO Settlement & Refunds tab
    expect(screen.queryByTestId('tab-settlement')).toBeNull();

    // Primary button enforces >= 56x56 touch target
    const execButton = screen.getByTestId('execute-checkout-button');
    expect(execButton.style.minHeight).toBe('56px');
    expect(execButton.style.minWidth).toBe('56px');

    await waitFor(() => {
      expect(screen.getByTestId('lookup-item-PRT-884920')).toBeTruthy();
    });

    // Simulate barcode scan via QrScannerInput
    await user.clear(screen.getByTestId('simulated-barcode-input'));
    await user.type(
      screen.getByTestId('simulated-barcode-input'),
      'PRT-884920',
    );
    await user.click(screen.getByTestId('simulated-barcode-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('price-source-PRT-884920').textContent).toContain(
        'Explicit Part Retail Price',
      );
    });

    await user.click(screen.getByTestId('add-basket-PRT-884920'));
    expect(screen.getByTestId('basket-line-PRT-884920')).toBeTruthy();

    // Upload payment proof file via FormData route -> real InMemoryStorageAdapter key
    const proofFile = new File(['proof-bytes'], 'cash-receipt.png', {
      type: 'image/png',
    });
    const fileInput = screen.getByTestId('payment-proof-file-input');
    fireEvent.change(fileInput, { target: { files: [proofFile] } });

    await waitFor(() => {
      expect(
        (screen.getByTestId('payment-proof-key-input') as HTMLInputElement).value,
      ).toContain('/evidence/');
    });

    await user.type(screen.getByTestId('buyer-name-input'), 'Ottawa Garage Buyer');
    await user.click(screen.getByTestId('execute-checkout-button'));

    await waitFor(() => {
      expect(screen.getByTestId('checkout-receipt-card')).toBeTruthy();
    });
    expect(screen.getByTestId('receipt-custody-state').textContent).toBe(
      'HELD_IN_OPERATOR_FLOAT',
    );
    expect(screen.getByTestId('checkout-receipt-card').textContent).toContain(
      '/expenses',
    );

    // Switch to Syndication & B2B tab -> preview eBay CSV, load B2B, load local copy, mark posted
    await user.click(screen.getByTestId('tab-syndication'));
    await user.click(screen.getByTestId('preview-ebay-csv-button'));
    await waitFor(() => {
      expect(screen.getByTestId('ebay-preview-panel').textContent).toContain(
        'PRT-884924',
      );
    });

    await user.click(screen.getByTestId('load-b2b-sheet-button'));
    await waitFor(() => {
      expect(screen.getByTestId('b2b-sheet-panel').textContent).toContain(
        'Ottawa South / Hwy 416 Corridor',
      );
    });

    await user.type(screen.getByTestId('local-ad-sku-input'), 'PRT-884925');
    await user.click(screen.getByTestId('load-local-ad-button'));
    await waitFor(() => {
      expect(
        screen.getByTestId('local-ad-payload-panel').textContent,
      ).toContain('Ottawa South / Hwy 416 Corridor');
    });

    await user.click(screen.getByTestId('mark-posted-local-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-status-banner').textContent).toContain(
        'POSTED_LIVE',
      );
    });
  });

  it('supports CFO two-step eBay export/confirm, bank settlement + refund QC hold, reuses Idempotency-Key on retries, and resets state cleanly on workspace switch', async () => {
    const user = userEvent.setup();
    const cfo = harness.makeSession();
    const seenCheckoutKeys: string[] = [];

    const routeFetch = makeRouteFetch(harness, () => cfo);
    let resolveSlowOrg1!: (r: Response) => void;
    let firstOrgLookup = true;

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        if (
          url.includes('/api/salvage/checkout/domestic') &&
          method === 'POST'
        ) {
          const headers = new Headers(init?.headers);
          const contentType = headers.get('content-type') ?? '';
          if (contentType.includes('application/json')) {
            const key = headers.get('idempotency-key') ?? '';
            seenCheckoutKeys.push(key);
            if (seenCheckoutKeys.length === 1) {
              throw new TypeError('Simulated transient offline error');
            }
          }
        }
        if (
          url.includes('/api/salvage/checkout/domestic?view=lookup') &&
          firstOrgLookup
        ) {
          firstOrgLookup = false;
          return new Promise<Response>((resolve) => {
            resolveSlowOrg1 = resolve;
          });
        }
        return routeFetch(input, init);
      },
    );

    const { rerender } = render(
      <DomesticCheckoutForm
        organizationId={HARNESS_IDS.orgs.SALVAGE}
        organizationName="Kemptville Salvage & Export Corp."
        actorUserId={cfo.userId}
        actorRole={cfo.role}
      />,
    );

    // Switch organization before slow Salvage lookup resolves -> stale lookup must be dropped
    rerender(
      <DomesticCheckoutForm
        organizationId={HARNESS_IDS.orgs.CANNABIS}
        organizationName="Brockville Cannabis Nursery"
        actorUserId={cfo.userId}
        actorRole={cfo.role}
      />,
    );

    // Resolve slow stale Salvage response -> Cannabis workspace must NOT show PRT-884920
    resolveSlowOrg1(
      new Response(
        JSON.stringify({
          items: [
            {
              itemType: 'PART',
              itemId: HARNESS_IDS.parts.ALTERNATOR,
              code: 'PRT-884920',
              label: 'Stale Alternator',
              availabilityState: 'AVAILABLE',
              custodyOrLifecycleState: 'SHELVED_ORIGIN_CONTAINER',
              ebaySyncState: 'NOT_LISTED',
              classifiedsSyncState: 'NOT_POSTED',
              complianceState: 'CLEARED_FOR_SALE',
              tdgHazmatCode: 'NONE',
              isEbayParcelEligible: true,
              inReturnQcHold: false,
              hasActiveSale: false,
              resolvedPrice: {
                amountCadMinor: 14_500,
                source: 'EXPLICIT_PART_RETAIL',
                policyHash: 'abc',
              },
              priceError: null,
              priceBasisHash: 'hash',
              warnings: [],
              version: 1,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await waitFor(() => {
      expect(screen.queryByTestId('lookup-item-PRT-884920')).toBeNull();
    });

    // Switch back to Salvage workspace with normal fast fetch
    rerender(
      <DomesticCheckoutForm
        organizationId={HARNESS_IDS.orgs.SALVAGE}
        organizationName="Kemptville Salvage & Export Corp."
        actorUserId={cfo.userId}
        actorRole={cfo.role}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('lookup-item-PRT-884924')).toBeTruthy();
    });

    // CFO exports Seller Hub CSV + confirms PRT-884920 live
    await user.click(screen.getByTestId('tab-syndication'));
    await user.click(screen.getByTestId('commit-ebay-csv-button'));
    await waitFor(() => {
      expect(screen.getByTestId('ebay-export-result').textContent).toContain(
        'Kemptville, ON',
      );
    });
    await user.type(
      screen.getByTestId('confirm-live-listing-id-input'),
      '285955556666',
    );
    await user.click(screen.getByTestId('confirm-ebay-live-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-status-banner').textContent).toContain(
        'SYNDICATED_LIVE',
      );
    });

    // Switch back to checkout and execute an eBay sale with simulated network error on 1st try
    await user.click(screen.getByTestId('tab-checkout'));
    await user.click(screen.getByTestId('add-basket-PRT-884924'));
    await user.selectOptions(
      screen.getByTestId('channel-select'),
      'EBAY_MOTORS_SHIPPED',
    );
    await user.type(screen.getByTestId('buyer-name-input'), 'eBay Buyer UI');

    // Upload real payment proof through FormData route
    const payFile = new File(['ebay-pay'], 'ebay-order.png', {
      type: 'image/png',
    });
    fireEvent.change(screen.getByTestId('payment-proof-file-input'), {
      target: { files: [payFile] },
    });
    await waitFor(() => {
      expect(
        (screen.getByTestId('payment-proof-key-input') as HTMLInputElement).value,
      ).toContain('/evidence/');
    });

    await user.clear(screen.getByTestId('ebay-platform-fee-input'));
    await user.type(screen.getByTestId('ebay-platform-fee-input'), '13.00');
    await user.clear(screen.getByTestId('ebay-est-fee-tax-input'));
    await user.type(screen.getByTestId('ebay-est-fee-tax-input'), '1.69');

    // First click triggers transient error
    await user.click(screen.getByTestId('execute-checkout-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-error-banner')).toBeTruthy();
    });

    // Retry click succeeds and sends exact same Idempotency-Key
    await user.click(screen.getByTestId('execute-checkout-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-receipt-card')).toBeTruthy();
    });
    expect(seenCheckoutKeys).toHaveLength(2);
    expect(seenCheckoutKeys[0]).toBe(seenCheckoutKeys[1]);
    expect(screen.getByTestId('receipt-settlement-state').textContent).toBe(
      'MARKETPLACE_PAYOUT_PENDING',
    );

    // CFO opens Settlement & Refunds tab, uploads real settlement proof & fee tax invoice, confirms settlement, then records refund
    await user.click(screen.getByTestId('tab-settlement'));
    await waitFor(() => {
      expect(screen.getByTestId('bank-deposit-ref-input')).toBeTruthy();
    });

    await user.type(
      screen.getByTestId('bank-deposit-ref-input'),
      'EBAY-DEP-UI-1',
    );
    const settleFile = new File(['bank-stmt'], 'settlement.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(screen.getByTestId('settlement-proof-file-input'), {
      target: { files: [settleFile] },
    });
    await waitFor(() => {
      expect(
        (screen.getByTestId('settlement-proof-key-input') as HTMLInputElement)
          .value,
      ).toContain('/evidence/');
    });

    await user.type(screen.getByTestId('actual-platform-fee-input'), '15.00');
    const feeTaxFile = new File(['fee-tax'], 'ebay-fee-invoice.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(screen.getByTestId('fee-tax-invoice-file-input'), {
      target: { files: [feeTaxFile] },
    });
    await waitFor(() => {
      expect(
        (screen.getByTestId('fee-tax-invoice-key-input') as HTMLInputElement)
          .value,
      ).toContain('/evidence/');
    });

    await user.click(screen.getByTestId('confirm-bank-settlement-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-status-banner').textContent).toContain(
        'SETTLED_ORIGIN_CORP_BANK',
      );
    });

    await user.type(
      screen.getByTestId('refund-reason-input'),
      'UI Return QC Test',
    );
    await user.click(screen.getByTestId('record-refund-button'));

    await waitFor(() => {
      expect(screen.getByTestId('refund-outcome-box').textContent).toContain(
        'INHERITED_SALE_EVIDENCE',
      );
    });

    // Verify Urgent Delist Queue UI for both eBay DELIST_PENDING and Classifieds DELIST_REQUIRED
    await user.click(screen.getByTestId('tab-syndication'));
    await user.clear(screen.getByTestId('local-ad-sku-input'));
    await user.type(screen.getByTestId('local-ad-sku-input'), 'PRT-884920');
    await user.click(screen.getByTestId('load-local-ad-button'));
    await waitFor(() => {
      expect(
        screen.getByTestId('local-ad-payload-panel').textContent,
      ).toContain('PRT-884920');
    });
    await user.click(screen.getByTestId('mark-posted-local-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-status-banner').textContent).toContain(
        'POSTED_LIVE',
      );
    });

    await user.click(screen.getByTestId('tab-checkout'));
    await user.click(screen.getByTestId('add-basket-PRT-884920'));
    await user.selectOptions(
      screen.getByTestId('channel-select'),
      'LOCAL_WALK_IN_CASH',
    );
    await user.selectOptions(
      screen.getByTestId('payment-method-select'),
      'CASH',
    );
    await user.selectOptions(
      screen.getByTestId('delivery-method-select'),
      'PICKUP_AT_ORIGIN',
    );
    await user.click(screen.getByTestId('attest-ebay-delisted-button'));
    await user.clear(screen.getByTestId('buyer-name-input'));
    await user.type(screen.getByTestId('buyer-name-input'), 'Delist UI Buyer');
    await user.click(screen.getByTestId('execute-checkout-button'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-receipt-card')).toBeTruthy();
    });

    await user.click(screen.getByTestId('tab-syndication'));
    await waitFor(() => {
      expect(
        screen.getByTestId('urgent-delist-item-PRT-884920'),
      ).toBeTruthy();
    });
    expect(
      screen.getByTestId('urgent-delist-classifieds-notice').textContent,
    ).toContain('FB Marketplace and Kijiji');
    expect(screen.getByTestId('confirm-delist-ebay-PRT-884920')).toBeTruthy();
    expect(screen.getByTestId('confirm-delist-local-PRT-884920')).toBeTruthy();

    await user.click(screen.getByTestId('confirm-delist-ebay-PRT-884920'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-status-banner').textContent).toContain(
        'Confirmed EBAY delist for PRT-884920',
      );
    });
    expect(screen.getByTestId('confirm-delist-local-PRT-884920')).toBeTruthy();

    await user.click(screen.getByTestId('confirm-delist-local-PRT-884920'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-status-banner').textContent).toContain(
        'Confirmed LOCAL_CLASSIFIEDS delist for PRT-884920',
      );
    });
    expect(screen.queryByTestId('urgent-delist-item-PRT-884920')).toBeNull();
  });
});
