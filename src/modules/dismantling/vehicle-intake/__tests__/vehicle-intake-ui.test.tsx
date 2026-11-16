// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserRole } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VehicleIntakeForm } from '@/app/(salvage)/intake/vehicle/vehicle-intake-form';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';

const ORG_SALVAGE = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;

describe('Issue 07: Mobile Parent Asset Intake UI (VehicleIntakeForm & NFR-ACC-01)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders 56px gloved-friendly controls, hides CFO drawer for non-CFO, scans destination without submitting, and clears auto-only fields on category switch', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();

    render(
      <VehicleIntakeForm
        organizationId={ORG_SALVAGE}
        organizationName="Auto & Marine Salvage (Kemptville)"
        actorRole={UserRole.HUNTER_MECHANIC}
        canCfoOverride={false}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );

    // CFO drawer must NOT render for non-CFO
    expect(screen.queryByTestId('cfo-override-section')).toBeNull();

    // 56px touch target check on primary controls
    const autoBtn = screen.getByTestId('category-btn-AUTOMOBILE');
    const submitBtn = screen.getByTestId('submit-vehicle-intake');
    expect(autoBtn.style.minHeight).toBe('56px');
    expect(submitBtn.style.minHeight).toBe('56px');

    // Scan destination via QrScannerInput -> updates destinationBarcode WITHOUT submitting
    const scanInput = screen.getByTestId('simulated-barcode-input');
    const scanSubmit = screen.getByTestId('simulated-barcode-submit');
    await user.clear(scanInput);
    await user.type(scanInput, 'RAMS-SHOP-R01-S01-B01');
    await user.click(scanSubmit);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId('input-destination-barcode') as HTMLInputElement).value,
    ).toBe('RAMS-SHOP-R01-S01-B01');

    // Populate automobile-only fields then switch to WATERCRAFT -> cleared & hidden
    await user.type(screen.getByTestId('input-seller-name'), 'Bob Seller');
    await user.click(screen.getByTestId('toggle-driveon-fail'));
    expect(screen.getByTestId('driveon-fail-fields')).toBeTruthy();

    await user.click(screen.getByTestId('category-btn-WATERCRAFT'));
    expect(screen.queryByTestId('automobile-compliance-section')).toBeNull();

    await user.click(screen.getByTestId('category-btn-AUTOMOBILE'));
    expect(
      (screen.getByTestId('input-seller-name') as HTMLInputElement).value,
    ).toBe('');
    expect(screen.queryByTestId('driveon-fail-fields')).toBeNull();
  });

  it('reuses stable Idempotency-Key across failed retries, prevents duplicate submit while pending, displays warning badges, and supports CFO drawer', async () => {
    const user = userEvent.setup();
    let keyCounter = 0;
    const keys = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const genKey = () => keys[keyCounter++] ?? keys[1]!;

    let rejectFirst!: (err: Error) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            replayed: false,
            vehicleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            organizationId: ORG_SALVAGE,
            internalStockNumber: 'AST-2026-AAAAAAAA',
            assetCategory: 'AUTOMOBILE',
            vinOrHin: '5XYP5DHC5LG000001',
            year: 2020,
            make: 'Kia',
            model: 'Telluride',
            trim: 'SX AWD',
            engineSpec: '3.8L V6 GDI',
            exteriorColor: null,
            steeringSide: 'LHD_ONLY',
            oemFitmentVerified: false,
            roadBrand: 'SALVAGE',
            operationalLane: 'DISMANTLE_AND_EXPORT',
            lifecycleState: 'STAGED_ONTARIO_YARD',
            availabilityState: 'AVAILABLE',
            classifiedsSyncState: 'NOT_POSTED',
            storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
            destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
            suggestedHsCode: '8708.99',
            catalyticConverterDisposition: 'PRESENT_AT_INTAKE',
            driveOnInitialFailAt: null,
            driveOnReinspectionDeadlineAt: null,
            estimatedMaxBidCadMinor: 200000,
            actualPurchasePriceCadMinor: 150000,
            estimatedRepairCadMinor: 0,
            estimatedDealOutlayCadMinor: 150000,
            createdExpenseIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
            linkedExpenseIds: [],
            custodyEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            auditLogId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            complianceWarnings: [
              'MISSING_EASR_REGISTRATION_WARNING',
              'PROPOSED_INACTIVE_LOCATION_WARNING',
            ],
            cfoOverrideApplied: true,
            cfoGateApprovedById: PHASE1A_SEED_IDS.users.architectCfo,
            cfoGateApprovedAt: '2026-11-16T12:00:00.000Z',
            cfoGateOverrideReason: 'Emergency override',
            availableWorkingCapitalBeforeCadMinor: 2200000,
            projectedPostDealCapitalCadMinor: 2050000,
            createdAt: '2026-11-16T12:00:00.000Z',
          }),
          { status: 201 },
        ),
      );

    render(
      <VehicleIntakeForm
        organizationId={ORG_SALVAGE}
        organizationName="Auto & Marine Salvage (Kemptville)"
        actorRole={UserRole.ARCHITECT_CFO}
        canCfoOverride={true}
        fetchFn={fetchMock as unknown as typeof fetch}
        generateIdempotencyKey={genKey}
      />,
    );

    await user.type(screen.getByTestId('input-vin-or-hin'), '5XYP5DHC5LG000001');
    await user.click(screen.getByTestId('toggle-cfo-drawer'));
    await user.click(screen.getByTestId('toggle-cfo-override-approve'));
    await user.type(
      screen.getByTestId('input-cfo-override-reason'),
      'Emergency override',
    );

    const submitBtn = screen.getByTestId(
      'submit-vehicle-intake',
    ) as HTMLButtonElement;
    await user.click(submitBtn);
    expect(submitBtn.disabled).toBe(true);

    // Duplicate click while in flight is ignored
    await user.click(submitBtn);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First attempt fails with network error -> form retained, error banner shown
    rejectFirst(new Error('Offline timeout'));
    await waitFor(() => {
      expect(screen.getByTestId('intake-error-banner').textContent).toContain(
        'Offline timeout',
      );
    });
    expect(submitBtn.disabled).toBe(false);

    // Retry sends the SAME Idempotency-Key
    await user.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByTestId('intake-success-card')).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>;
    const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(firstHeaders['Idempotency-Key']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(secondHeaders['Idempotency-Key']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );

    expect(
      screen.getByTestId('warning-badge-MISSING_EASR_REGISTRATION_WARNING'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('warning-badge-PROPOSED_INACTIVE_LOCATION_WARNING'),
    ).toBeTruthy();
  });
});
