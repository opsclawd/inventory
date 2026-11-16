// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssetCategory,
  AssetLifecycleState,
  CatalyticConverterDisposition,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartCustodyState,
  InventoryAvailabilityState,
  UserRole,
} from '@prisma/client';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartStripForm } from '@/app/(salvage)/intake/part/part-strip-form';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { AuthError } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import {
  InMemoryStorageAdapter,
  type StorageAuditEventInput,
  type StorageSecurityRepository,
} from '@/modules/shared-ops/storage';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import {
  CompleteHulkScrapUseCase,
  handleSalvagePartsGet,
  handleSalvagePartsPatch,
  handleSalvagePartsPost,
  type LockedDonorPartRow,
  type LockedDonorVehicleRow,
  type LockedScrapLogRow,
  type LockedStorageLocationRow,
  LogScrapComponentUseCase,
  parseCommandReceiptNextState,
  type PartStripRepository,
  type PartStripTx,
  type PersistAuditLogRecord,
  type PersistNewPartRecord,
  type PersistPartCustodyEventRecord,
  type PersistScrapLogRecord,
  StripPartUseCase,
} from '../index';

const ORG_SALVAGE = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
const ORG_SALVAGE_2 = '10000000-0000-4000-8000-000000000099';
const STRIPPER_ID = PHASE1A_SEED_IDS.users.ontarioStripper;

function createSession(orgId: string) {
  return createAuthSessionContext({
    userId: STRIPPER_ID,
    activeOrganizationId: orgId,
    role: UserRole.ONTARIO_STRIPPER,
    activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
    activeMemberships: [
      {
        membershipId: '30000000-0000-4000-8000-000000000004',
        organizationId: orgId,
        organizationSlug: 'ORG_SALVAGE_EXPORT',
        organizationName: 'Auto & Marine Salvage',
        organizationType: OrganizationType.SALVAGE_AND_EXPORT,
        role: UserRole.ONTARIO_STRIPPER,
        isDefaultWorkspace: true,
      },
    ],
    aal: 'aal2',
    mfaEnrolled: true,
  });
}

function createUiTestHarness() {
  const donor1Id = '50000000-0000-4000-8000-000000000011';
  const donor2Id = '50000000-0000-4000-8000-000000000022';

  const vehicles = new Map<
    string,
    LockedDonorVehicleRow & { year: number; make: string; model: string }
  >([
    [
      donor1Id,
      {
        id: donor1Id,
        organizationId: ORG_SALVAGE,
        internalStockNumber: 'AST-2026-0011',
        assetCategory: AssetCategory.AUTOMOBILE,
        operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
        lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
        actualPurchasePriceCadMinor: 100_000,
        targetGrossRealizationMinor: 300_000,
        fluidsDrainedAt: new Date('2026-11-01T10:00:00.000Z'),
        catalyticConverterDisposition:
          CatalyticConverterDisposition.PRESENT_AT_INTAKE,
        scrapMetalTicketKey: null,
        scrapRecoveryCadMinor: 0,
        scrappedClearedAt: null,
        complianceWarnings: [],
        version: 1,
        year: 2019,
        make: 'Honda',
        model: 'CR-V',
      },
    ],
    [
      donor2Id,
      {
        id: donor2Id,
        organizationId: ORG_SALVAGE_2,
        internalStockNumber: 'AST-2026-0022',
        assetCategory: AssetCategory.AUTOMOBILE,
        operationalLane: OperationalLane.DISMANTLE_AND_EXPORT,
        lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
        actualPurchasePriceCadMinor: 80_000,
        targetGrossRealizationMinor: 200_000,
        fluidsDrainedAt: new Date('2026-11-01T10:00:00.000Z'),
        catalyticConverterDisposition:
          CatalyticConverterDisposition.PRESENT_AT_INTAKE,
        scrapMetalTicketKey: null,
        scrapRecoveryCadMinor: 0,
        scrappedClearedAt: null,
        complianceWarnings: [],
        version: 1,
        year: 2021,
        make: 'Toyota',
        model: 'RAV4',
      },
    ],
  ]);

  const locations = new Map<string, LockedStorageLocationRow>([
    [
      PHASE1A_SEED_IDS.locations.KEMP_C01,
      {
        id: PHASE1A_SEED_IDS.locations.KEMP_C01,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'KEMP-C01-R01-S01-B01',
      },
    ],
    [
      PHASE1A_SEED_IDS.locations.KEMP_C04,
      {
        id: PHASE1A_SEED_IDS.locations.KEMP_C04,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'KEMP-C04-R01-S01-B01',
      },
    ],
  ]);

  const parts = new Map<
    string,
    {
      -readonly [K in keyof LockedDonorPartRow]: LockedDonorPartRow[K];
    } & {
      strippedAt: Date;
      weightKg: number;
      suggestedHsCode: string;
      steeringSideCompatibility: 'UNIVERSAL' | 'LHD_ONLY' | 'RHD_ONLY';
      isHazmatOrAirbag: boolean;
      araDamageCode: string;
    }
  >();
  const scrapLogs = new Map<string, LockedScrapLogRow>();
  const custodyEvents = new Map<string, PersistPartCustodyEventRecord>();
  const auditLogs = new Map<string, PersistAuditLogRecord>();

  const securityRepository: StorageSecurityRepository = {
    async verifyActiveTenantAccess() {},
    async recordPrivateEvidenceAudit(
      _ctx: TenantExecutionContext,
      _event: StorageAuditEventInput,
    ) {},
  };
  const storage = new InMemoryStorageAdapter({ securityRepository });

  const repository: PartStripRepository = {
    async withTenantTransaction<T>(
      _ctx: TenantExecutionContext,
      fn: (tx: PartStripTx) => Promise<T>,
    ): Promise<T> {
      const tx: PartStripTx = {
        async acquireOrganizationLock() {},
        async readOrganizationPolicyRecord(organizationId) {
          return { organizationId, policyConfigJson: null };
        },
        async findCommandReceipt(organizationId, receiptAuditId) {
          const audit = auditLogs.get(receiptAuditId);
          if (!audit || audit.organizationId !== organizationId) {
            return null;
          }
          return parseCommandReceiptNextState(audit.id, audit.nextState);
        },
        async findCustodyEventByIdempotencyKey(organizationId, idempotencyKey) {
          for (const ev of custodyEvents.values()) {
            if (
              ev.organizationId === organizationId &&
              ev.idempotencyKey === idempotencyKey
            ) {
              return { id: ev.id };
            }
          }
          return null;
        },
        async partQrSkuExists(qrSkuCode) {
          for (const p of parts.values()) {
            if (p.qrSkuCode === qrSkuCode) return true;
          }
          return false;
        },
        async findAndLockDonorVehicle(organizationId, donorVehicleId) {
          const v = vehicles.get(donorVehicleId);
          return v && v.organizationId === organizationId
            ? structuredClone(v)
            : null;
        },
        async findAndLockDonorParts(organizationId, donorVehicleId) {
          return [...parts.values()]
            .filter(
              (p) =>
                p.organizationId === organizationId &&
                p.donorVehicleId === donorVehicleId,
            )
            .map((p) => structuredClone(p));
        },
        async findAndLockPart(organizationId, partId) {
          const p = parts.get(partId);
          return p && p.organizationId === organizationId
            ? structuredClone(p)
            : null;
        },
        async listDonorExpenses() {
          return [];
        },
        async listDonorScrapLogs(organizationId, donorVehicleId) {
          return [...scrapLogs.values()]
            .filter(
              (s) =>
                s.organizationId === organizationId &&
                s.donorVehicleId === donorVehicleId,
            )
            .map((s) => structuredClone(s));
        },
        async findScrapLogById(organizationId, scrapLogId) {
          const s = scrapLogs.get(scrapLogId);
          return s && s.organizationId === organizationId
            ? structuredClone(s)
            : null;
        },
        async findAndLockStorageLocationByBarcode(organizationId, barcode) {
          for (const loc of locations.values()) {
            if (
              loc.organizationId === organizationId &&
              loc.fullQrBarcode === barcode
            ) {
              return structuredClone(loc);
            }
          }
          return null;
        },
        async insertPart(input: PersistNewPartRecord) {
          const loc = locations.get(input.storageLocationId);
          parts.set(input.id, {
            ...input,
            currentLocationBarcode: loc?.fullQrBarcode ?? null,
            hasActiveSale: false,
          });
        },
        async updatePartStateAndLocation(input) {
          const existing = parts.get(input.partId);
          if (!existing || existing.version !== input.expectedCurrentVersion) {
            return false;
          }
          const loc = input.storageLocationId
            ? locations.get(input.storageLocationId)
            : null;
          parts.set(input.partId, {
            ...existing,
            custodyState: input.custodyState,
            availabilityState: input.availabilityState,
            ebaySyncState: input.ebaySyncState,
            classifiedsSyncState: input.classifiedsSyncState,
            complianceState: input.complianceState,
            storageLocationId: input.storageLocationId,
            currentLocationBarcode: loc?.fullQrBarcode ?? null,
            complianceWarnings: [...input.complianceWarnings],
            version: input.nextVersion,
          });
          return true;
        },
        async updatePartCostBasis(input) {
          const existing = parts.get(input.partId);
          if (!existing || existing.version !== input.expectedCurrentVersion) {
            return false;
          }
          parts.set(input.partId, {
            ...existing,
            allocatedCostBasisCadMinor: input.allocatedCostBasisCadMinor,
            version: input.nextVersion,
          });
          return true;
        },
        async updateDonorVehicle(input) {
          const existing = vehicles.get(input.donorVehicleId);
          if (!existing || existing.version !== input.expectedCurrentVersion) {
            return false;
          }
          vehicles.set(input.donorVehicleId, {
            ...existing,
            ...(input.lifecycleState !== undefined
              ? { lifecycleState: input.lifecycleState }
              : {}),
            ...(input.catalyticConverterDisposition !== undefined
              ? {
                  catalyticConverterDisposition:
                    input.catalyticConverterDisposition,
                }
              : {}),
            ...(input.scrapMetalTicketKey !== undefined
              ? { scrapMetalTicketKey: input.scrapMetalTicketKey }
              : {}),
            ...(input.scrapRecoveryCadMinor !== undefined
              ? { scrapRecoveryCadMinor: input.scrapRecoveryCadMinor }
              : {}),
            ...(input.scrappedClearedAt !== undefined
              ? { scrappedClearedAt: input.scrappedClearedAt }
              : {}),
            ...(input.complianceWarnings !== undefined
              ? { complianceWarnings: [...input.complianceWarnings] }
              : {}),
            version: input.nextVersion,
          });
          return true;
        },
        async insertScrapComponentLog(input: PersistScrapLogRecord) {
          scrapLogs.set(input.id, {
            id: input.id,
            organizationId: input.organizationId,
            donorVehicleId: input.vehicleId,
            stream: input.scrapStream,
            weightKg: input.weightKg,
            payoutCadMinor: input.payoutCadMinor,
            recyclerName: input.recyclerName,
            recyclerTicketStorageKey: input.recyclerTicketStorageKey,
            cashCustodyState: input.cashCustodyState,
            recordedByUserId: input.recordedByUserId,
            createdAt: input.createdAt,
          });
        },
        async insertCustodyEvent(input: PersistPartCustodyEventRecord) {
          custodyEvents.set(input.id, input);
        },
        async insertAuditLog(input: PersistAuditLogRecord) {
          auditLogs.set(input.id, input);
        },
        async listStripDonors(organizationId) {
          return [...vehicles.values()]
            .filter((v) => v.organizationId === organizationId)
            .map((v) => ({
              id: v.id,
              internalStockNumber: v.internalStockNumber,
              assetCategory: v.assetCategory,
              year: v.year,
              make: v.make,
              model: v.model,
              operationalLane: v.operationalLane,
              lifecycleState: v.lifecycleState,
              fluidsDrainedAt: v.fluidsDrainedAt?.toISOString() ?? null,
              catalyticConverterDisposition: v.catalyticConverterDisposition,
              scrapRecoveryCadMinor: v.scrapRecoveryCadMinor,
              scrappedClearedAt: v.scrappedClearedAt?.toISOString() ?? null,
              complianceWarnings: v.complianceWarnings,
              bareShellScrapLogIds: [...scrapLogs.values()]
                .filter(
                  (s) =>
                    s.organizationId === organizationId &&
                    s.donorVehicleId === v.id &&
                    s.stream === 'BARE_STEEL_SHELL',
                )
                .map((s) => s.id),
              version: v.version,
            }));
        },
        async listParts(organizationId, filter) {
          return [...parts.values()]
            .filter(
              (p) =>
                p.organizationId === organizationId &&
                (!filter.qcHoldOnly ||
                  p.custodyState === 'RESTOCKED_QC_HOLD' ||
                  p.availabilityState === 'RETURNED_QC_HOLD'),
            )
            .map((p) => ({
              id: p.id,
              qrSkuCode: p.qrSkuCode,
              donorVehicleId: p.donorVehicleId,
              custodyState: p.custodyState,
              availabilityState: p.availabilityState,
              ebaySyncState: p.ebaySyncState,
              classifiedsSyncState: p.classifiedsSyncState,
              complianceState: p.complianceState,
              partCategoryName: p.partCategoryName,
              steeringSideCompatibility: p.steeringSideCompatibility as 'UNIVERSAL' | 'LHD_ONLY',
              tdgHazmatCode: p.tdgHazmatCode,
              isHazmatOrAirbag: p.isHazmatOrAirbag,
              suggestedHsCode: p.suggestedHsCode,
              araGrade: p.araGrade,
              araDamageCode: p.araDamageCode,
              weightKg: p.weightKg,
              rawPhotoUrls: p.rawPhotoUrls,
              storageLocationId: p.storageLocationId,
              locationBarcode: p.currentLocationBarcode,
              allocatedCostBasisCadMinor: p.allocatedCostBasisCadMinor,
              compBaselineCadMinor: p.compBaselineCadMinor,
              complianceWarnings: p.complianceWarnings,
              version: p.version,
              strippedAt: p.strippedAt.toISOString(),
            }));
        },
        async listScrapHistory(organizationId) {
          return [...scrapLogs.values()]
            .filter((s) => s.organizationId === organizationId)
            .map((s) => ({
              id: s.id,
              vehicleId: s.donorVehicleId,
              scrapStream: s.stream,
              weightKg: s.weightKg,
              payoutCadMinor: s.payoutCadMinor,
              recyclerName: s.recyclerName,
              cashCustodyState: s.cashCustodyState,
              hasTicketEvidence: true,
              createdAt: s.createdAt.toISOString(),
            }));
        },
      };
      return fn(tx);
    },
  };

  const stripUseCase = new StripPartUseCase({ repository, storage });
  const scrapUseCase = new LogScrapComponentUseCase({ repository, storage });
  const hulkUseCase = new CompleteHulkScrapUseCase({ repository });

  return {
    donor1Id,
    donor2Id,
    parts,
    stripUseCase,
    scrapUseCase,
    hulkUseCase,
  };
}

describe('Issue 08: Mobile Part Strip, Return QC, Scrap & Hulk UI (jsdom Headless Workflow & NFR-ACC-01)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('executes full headless 3-tap strip (simulated-barcode-input + photo upload), return QC with original photos, 5-stream scrap, hulk clearance, 56px touch targets, and retry key stability', async () => {
    const user = userEvent.setup();
    const harness = createUiTestHarness();
    let currentOrg: string = ORG_SALVAGE;
    let failNextPost = false;
    let dropNextPostResponseAfterCommit = false;
    let lastPostReplayStatus: number | null = null;

    const jpgBytes = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 30, g: 64, b: 175 },
      },
    })
      .jpeg()
      .toBuffer();

    const makeRouteDeps = () => ({
      resolveSession: async () => createSession(currentOrg),
      stripPartUseCase: harness.stripUseCase,
      logScrapUseCase: harness.scrapUseCase,
      completeHulkUseCase: harness.hulkUseCase,
    });

    const recordedPostKeys: string[] = [];
    const recordedPostTimestamps: string[] = [];
    const fetchAdapter = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const fullUrl = url.startsWith('http') ? url : `http://localhost${url}`;

      if (method === 'POST') {
        const hdrs = init?.headers as Record<string, string> | undefined;
        if (hdrs?.['Idempotency-Key']) {
          recordedPostKeys.push(hdrs['Idempotency-Key']);
        }
        const formBody = init?.body as FormData;
        const metaRaw = formBody.get('metadata');
        if (typeof metaRaw === 'string') {
          const parsedMeta = JSON.parse(metaRaw) as {
            deviceTimestamp?: string;
          };
          if (parsedMeta.deviceTimestamp) {
            recordedPostTimestamps.push(parsedMeta.deviceTimestamp);
          }
        }
        if (failNextPost) {
          failNextPost = false;
          throw new Error('Simulated offline timeout');
        }
        const reqHeaders = new Headers(init?.headers);
        if (!reqHeaders.has('content-type')) {
          reqHeaders.set('content-type', 'multipart/form-data; boundary=jsdom-test');
        }
        const fakeMultipartReq = {
          url: fullUrl,
          method: 'POST',
          headers: reqHeaders,
          formData: async () => formBody,
        } as unknown as Request;
        const response = await handleSalvagePartsPost(
          fakeMultipartReq,
          makeRouteDeps(),
        );
        if (dropNextPostResponseAfterCommit) {
          dropNextPostResponseAfterCommit = false;
          throw new Error('Connection reset after server commit');
        }
        lastPostReplayStatus = response.status;
        return response;
      }

      if (method === 'PATCH') {
        return handleSalvagePartsPatch(
          new Request(fullUrl, {
            method: 'PATCH',
            headers: init?.headers,
            body: init?.body,
          }),
          makeRouteDeps(),
        );
      }

      return handleSalvagePartsGet(
        new Request(fullUrl, { method: 'GET' }),
        makeRouteDeps(),
      );
    }) as typeof fetch;

    const keyList = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999',
    ];
    let keyIdx = 0;
    const genKey = () => keyList[keyIdx++] ?? crypto.randomUUID();

    const { rerender } = render(
      <PartStripForm
        organizationId={ORG_SALVAGE}
        organizationName="Auto & Marine Salvage (Kemptville)"
        actorRole={UserRole.ONTARIO_STRIPPER}
        fetchFn={fetchAdapter}
        generateIdempotencyKey={genKey}
      />,
    );

    // Wait for donors to load
    await waitFor(() => {
      expect(
        (screen.getByTestId('select-donor-vehicle') as HTMLSelectElement).value,
      ).toBe(harness.donor1Id);
    });

    // Verify 56px touch targets on primary controls
    expect(screen.getByTestId('tab-strip').style.minHeight).toBe('56px');
    expect(screen.getByTestId('submit-part-strip').style.minHeight).toBe(
      '56px',
    );
    expect(screen.getByTestId('ara-grade-pill-A').style.minHeight).toBe('56px');

    // Upload 3 photos + select Safety Airbag (verifies auto TDG lock & quarantine) -> then test normal Alternator
    const photoFile = new File([jpgBytes], 'part.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('photo-input-1'), {
      target: { files: [photoFile] },
    });
    fireEvent.change(screen.getByTestId('photo-input-2'), {
      target: { files: [photoFile] },
    });
    fireEvent.change(screen.getByTestId('photo-input-3'), {
      target: { files: [photoFile] },
    });

    await user.selectOptions(
      screen.getByTestId('select-part-category'),
      'Safety Airbag',
    );
    expect(
      (screen.getByTestId('tdg-pill-NONE') as HTMLButtonElement).disabled,
    ).toBe(true);

    // Switch back to Alternator & select ARA Grade A
    await user.selectOptions(
      screen.getByTestId('select-part-category'),
      'Alternator',
    );
    await user.click(screen.getByTestId('ara-grade-pill-A'));

    // Stage 2: Scan part hang-tag QR via simulated-barcode-input
    const partQrSection = screen.getByTestId('part-qr-scanner-section');
    const partInput = within(partQrSection).getByTestId(
      'simulated-barcode-input',
    );
    const partSubmit = within(partQrSection).getByTestId(
      'simulated-barcode-submit',
    );
    await user.type(partInput, 'PRT-884920');
    await user.click(partSubmit);
    expect(screen.getByTestId('bound-part-qr-badge').textContent).toContain(
      'PRT-884920',
    );

    // Stage 3: Simulate network error on first bin-scan commit -> verify stable Idempotency-Key on retry!
    failNextPost = true;
    const binQrSection = screen.getByTestId('bin-qr-scanner-section');
    const binInput = within(binQrSection).getByTestId(
      'simulated-barcode-input',
    );
    const binSubmit = within(binQrSection).getByTestId(
      'simulated-barcode-submit',
    );
    await user.type(binInput, 'KEMP-C01-R01-S01-B01');
    await user.click(binSubmit);

    await waitFor(() => {
      expect(screen.getByTestId('part-strip-error-banner').textContent).toContain(
        'Simulated offline timeout',
      );
    });

    // Retry via Commit button -> reuses EXACT SAME Idempotency-Key!
    await user.click(screen.getByTestId('submit-part-strip'));
    await waitFor(() => {
      expect(screen.getByTestId('strip-success-card').textContent).toContain(
        'PRT-884920',
      );
    });
    expect(recordedPostKeys.length).toBe(2);
    expect(recordedPostKeys[0]).toBe(recordedPostKeys[1]);
    expect(recordedPostTimestamps[0]).toBe(recordedPostTimestamps[1]);

    // Donor remains selected across successive parts!
    expect(
      (screen.getByTestId('select-donor-vehicle') as HTMLSelectElement).value,
    ).toBe(harness.donor1Id);

    // Simulate checkout on PRT-884920 then test Return QC tab with original photos
    const [createdPart] = [...harness.parts.values()];
    createdPart!.custodyState = PartCustodyState.SOLD_AND_RELEASED;
    createdPart!.availabilityState = InventoryAvailabilityState.PAID_SETTLED;

    await user.click(screen.getByTestId('tab-return-qc'));
    await user.type(
      screen.getByTestId('input-return-part-id'),
      createdPart!.id,
    );
    const qcLocScanner = screen.getByTestId('return-qc-location-scanner');
    await user.type(
      within(qcLocScanner).getByTestId('simulated-barcode-input'),
      'KEMP-C04-R01-S01-B01',
    );
    await user.click(
      within(qcLocScanner).getByTestId('simulated-barcode-submit'),
    );
    await user.click(screen.getByTestId('submit-return-intake'));

    await waitFor(() => {
      expect(screen.getByTestId('return-intake-success').textContent).toContain(
        'RESTOCKED_QC_HOLD',
      );
    });

    // Inspect original photos & pass QC
    await waitFor(() => {
      expect(
        screen.getByTestId(`qc-queue-item-${createdPart!.id}`),
      ).toBeTruthy();
    });
    expect(
      within(screen.getByTestId('qc-original-photos')).getAllByRole('img'),
    ).toHaveLength(3);

    await user.click(screen.getByTestId('qc-attestation-toggle'));
    await user.type(
      screen.getByTestId('qc-inspection-notes'),
      'OEM stamp verified intact',
    );
    const passBinScanner = screen.getByTestId('qc-pass-bin-scanner');
    await user.type(
      within(passBinScanner).getByTestId('simulated-barcode-input'),
      'KEMP-C01-R01-S01-B01',
    );
    await user.click(
      within(passBinScanner).getByTestId('simulated-barcode-submit'),
    );
    await user.click(screen.getByTestId('submit-qc-pass'));

    await waitFor(() => {
      expect(screen.getByTestId('qc-inspect-success').textContent).toContain(
        'SHELVED_ORIGIN_CONTAINER',
      );
    });

    // Tab 3: Log BARE_STEEL_SHELL scrap under CASH (HELD_IN_OPERATOR_FLOAT)
    // Simulate a post-commit network drop where the server creates the receipt, then the response is lost.
    await user.click(screen.getByTestId('tab-scrap'));
    await user.click(screen.getByTestId('scrap-stream-pill-BARE_STEEL_SHELL'));
    await user.click(screen.getByTestId('scrap-mode-CASH'));
    fireEvent.change(screen.getByTestId('scrap-ticket-file-input'), {
      target: { files: [photoFile] },
    });
    dropNextPostResponseAfterCommit = true;
    await user.click(screen.getByTestId('submit-scrap-log'));

    await waitFor(() => {
      expect(screen.getByTestId('part-strip-error-banner').textContent).toContain(
        'Connection reset after server commit',
      );
    });

    // Retrying submits the same Idempotency-Key and deviceTimestamp and replays HTTP 200
    await user.click(screen.getByTestId('submit-scrap-log'));

    await waitFor(() => {
      expect(screen.getByTestId('scrap-success-summary').textContent).toContain(
        'HELD_IN_OPERATOR_FLOAT',
      );
    });
    expect(lastPostReplayStatus).toBe(200);
    expect(recordedPostKeys[2]).toBe(recordedPostKeys[3]);
    expect(recordedPostTimestamps[2]).toBe(recordedPostTimestamps[3]);

    // Tab 4: Complete Hulk Clearance
    await user.click(screen.getByTestId('tab-hulk'));
    await user.click(screen.getByTestId('submit-hulk-clearance'));

    await waitFor(() => {
      expect(screen.getByTestId('hulk-success-card').textContent).toContain(
        'SCRAPPED_METAL_CLEARED',
      );
      expect(
        screen.getByTestId('hulk-warning-UNRECONCILED_CATALYTIC_CONVERTER'),
      ).toBeTruthy();
    });

    // Workspace change clears drafts and fetches tenant-scoped donors
    currentOrg = ORG_SALVAGE_2;
    rerender(
      <PartStripForm
        organizationId={ORG_SALVAGE_2}
        organizationName="Salvage Org 2"
        actorRole={UserRole.ONTARIO_STRIPPER}
        fetchFn={fetchAdapter}
        generateIdempotencyKey={genKey}
      />,
    );

    await waitFor(() => {
      expect(
        (screen.getByTestId('select-donor-vehicle') as HTMLSelectElement).value,
      ).toBe(harness.donor2Id);
    });
    expect(screen.queryByTestId('hulk-success-card')).toBeNull();
  });
});
