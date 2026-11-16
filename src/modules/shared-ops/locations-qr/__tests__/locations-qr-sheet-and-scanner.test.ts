import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import {
  AssetCategory,
  AssetLifecycleState,
  LocationOperationalStatus,
  OrganizationType,
  UserRole,
} from '@prisma/client';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import * as ZXingNS from '@zxing/library';
import {
  handleLabelSheetGet,
  handleLabelSheetPost,
  type LabelSheetRepository,
} from '@/app/api/shared/labels/sheet/route';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import {
  AuthError,
  type AuthSessionContext,
  toTenantExecutionContext,
} from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import {
  createPrismaCustodyRepository,
  createRecordCustodyScanHandler,
  CUSTODY_SCAN_AUDIT_ACTION,
  CUSTODY_SCAN_AUDIT_ENTITY_TYPE,
  type CustodyScanRepository,
  type CustodyScanTx,
  type InsertCustodyAuditLogRecord,
  type InsertCustodyEventRecord,
  isFluidBearingPowertrainPartCategory,
  LabelTagError,
  LETTER_PAGE_HEIGHT_PT,
  LETTER_PAGE_WIDTH_PT,
  LocationCustodyError,
  LocationZoningService,
  type LockedPartRecord,
  type LockedStorageLocationRecord,
  type LockedVehicleRecord,
  OVAL_SLOT_HEIGHT_PT,
  OVAL_SLOT_WIDTH_PT,
  PRINTABLE_INSET_PT,
  QR_CORE_SIZE_PT,
  QR_OUTER_SIZE_PT,
  QrTagSheetAndZplGenerator,
  recordCustodyScan,
  type RecordCustodyScanInput,
} from '@/modules/shared-ops/locations-qr';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';

const ZXing = ((ZXingNS as unknown as { default?: typeof ZXingNS }).default ??
  ZXingNS) as typeof ZXingNS;

// ============================================================================
// QR Decode & PDF/SVG Rasterization Helpers
// ============================================================================

function decodeQrFromRgba(
  rgba: Uint8ClampedArray,
  imageWidth: number,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
): string {
  const luminances = new Uint8ClampedArray(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const idx = ((cropY + y) * imageWidth + (cropX + x)) * 4;
      luminances[y * cropWidth + x] = Math.round(
        0.299 * rgba[idx]! + 0.587 * rgba[idx + 1]! + 0.114 * rgba[idx + 2]!,
      );
    }
  }
  const source = new ZXing.RGBLuminanceSource(
    luminances,
    cropWidth,
    cropHeight,
  );
  const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
  return new ZXing.QRCodeReader().decode(bitmap).getText();
}

async function decodeCellFromPdf(
  pdfBytes: Uint8Array,
  pageNumber: number,
  cols: number,
  rows: number,
  cellIndex: number,
): Promise<string> {
  const stdFontDir = pathToFileURL(
    path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
  ).href;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    disableWorker: true,
    standardFontDataUrl: stdFontDir,
    verbosity: 0,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;

  const page = await doc.getPage(pageNumber);
  const scale = 3;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const cellW = Math.floor((LETTER_PAGE_WIDTH_PT / cols) * scale);
  const cellH = Math.floor((LETTER_PAGE_HEIGHT_PT / rows) * scale);
  const col = cellIndex % cols;
  const row = Math.floor(cellIndex / cols);

  return decodeQrFromRgba(
    imgData.data,
    canvas.width,
    col * cellW,
    row * cellH,
    cellW,
    cellH,
  );
}

async function decodeCellFromSvg(
  svg: string,
  cols: number,
  rows: number,
  cellIndex: number,
): Promise<string> {
  const scale = 3;
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(LETTER_PAGE_WIDTH_PT * scale, LETTER_PAGE_HEIGHT_PT * scale)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cellW = Math.floor((LETTER_PAGE_WIDTH_PT / cols) * scale);
  const cellH = Math.floor((LETTER_PAGE_HEIGHT_PT / rows) * scale);
  const col = cellIndex % cols;
  const row = Math.floor(cellIndex / cols);

  return decodeQrFromRgba(
    new Uint8ClampedArray(data),
    info.width,
    col * cellW,
    row * cellH,
    cellW,
    cellH,
  );
}

// ============================================================================
// Offline Session & Custody Repository Fixtures
// ============================================================================

function makeTrustedSession(overrides?: {
  userId?: string;
  activeOrganizationId?: string;
  activeOrganizationType?: OrganizationType;
  role?: UserRole;
  aal?: 'aal1' | 'aal2';
  mfaEnrolled?: boolean;
}): AuthSessionContext {
  const orgId =
    overrides?.activeOrganizationId ?? PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
  const orgType =
    overrides?.activeOrganizationType ?? OrganizationType.SALVAGE_AND_EXPORT;
  const role = overrides?.role ?? UserRole.HUNTER_MECHANIC;
  return createAuthSessionContext({
    userId: overrides?.userId ?? PHASE1A_SEED_IDS.users.hunterMechanic,
    activeOrganizationId: orgId,
    role,
    activeOrganizationType: orgType,
    activeMemberships: [
      {
        membershipId: PHASE1A_SEED_IDS.memberships.hunterSalvage,
        organizationId: orgId,
        organizationSlug:
          orgType === OrganizationType.SALVAGE_AND_EXPORT
            ? 'ORG_SALVAGE_EXPORT'
            : 'ORG_CANNABIS_NURSERY_PROC',
        organizationName:
          orgType === OrganizationType.SALVAGE_AND_EXPORT
            ? 'Auto & Marine Salvage (Kemptville)'
            : 'Cannabis Nursery & Processing (Brockville)',
        organizationType: orgType,
        role,
        isDefaultWorkspace: true,
      },
    ],
    aal: overrides?.aal ?? 'aal2',
    mfaEnrolled: overrides?.mfaEnrolled ?? true,
  });
}

interface OfflineOrgState {
  id: string;
  name: string;
  organizationType: OrganizationType;
  policyConfigJson: Record<string, unknown> | null;
}

interface OfflineMembershipState {
  organizationId: string;
  userId: string;
  role: UserRole;
  isActive: boolean;
}

interface OfflineLocationState extends LockedStorageLocationRecord {}

interface OfflineVehicleState {
  id: string;
  organizationId: string;
  assetCategory: AssetCategory;
  lifecycleState: AssetLifecycleState;
  storageLocationId: string | null;
  fluidsDrainedAt: Date | null;
  complianceWarnings: string[];
  version: number;
}

interface OfflinePartState {
  id: string;
  organizationId: string;
  storageLocationId: string | null;
  partCategoryName: string;
  donorVehicleId: string;
  complianceWarnings: string[];
  version: number;
}

interface OfflineCustodyEventState extends InsertCustodyEventRecord {}
interface OfflineAuditLogState extends InsertCustodyAuditLogRecord {}

class InMemoryCustodyTestRepository
  implements CustodyScanRepository, LabelSheetRepository
{
  public readonly orgs = new Map<string, OfflineOrgState>();
  public readonly memberships: OfflineMembershipState[] = [];
  public readonly locations = new Map<string, OfflineLocationState>();
  public readonly vehicles = new Map<string, OfflineVehicleState>();
  public readonly parts = new Map<string, OfflinePartState>();
  public readonly custodyEvents: OfflineCustodyEventState[] = [];
  public readonly auditLogs: OfflineAuditLogState[] = [];
  public failNextAuditInsert = false;

  public constructor() {
    this.seed();
  }

  public seed(): void {
    this.orgs.clear();
    this.memberships.length = 0;
    this.locations.clear();
    this.vehicles.clear();
    this.parts.clear();
    this.custodyEvents.length = 0;
    this.auditLogs.length = 0;
    this.failNextAuditInsert = false;

    const salvageOrgId = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
    const cannabisOrgId = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;

    this.orgs.set(salvageOrgId, {
      id: salvageOrgId,
      name: 'Auto & Marine Salvage (Kemptville)',
      organizationType: OrganizationType.SALVAGE_AND_EXPORT,
      policyConfigJson: null,
    });
    this.orgs.set(cannabisOrgId, {
      id: cannabisOrgId,
      name: 'Cannabis Nursery & Processing (Brockville)',
      organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      policyConfigJson: null,
    });

    this.memberships.push(
      {
        organizationId: salvageOrgId,
        userId: PHASE1A_SEED_IDS.users.architectCfo,
        role: UserRole.ARCHITECT_CFO,
        isActive: true,
      },
      {
        organizationId: salvageOrgId,
        userId: PHASE1A_SEED_IDS.users.hunterMechanic,
        role: UserRole.HUNTER_MECHANIC,
        isActive: true,
      },
      {
        organizationId: salvageOrgId,
        userId: PHASE1A_SEED_IDS.users.ontarioStripper,
        role: UserRole.ONTARIO_STRIPPER,
        isActive: true,
      },
      {
        organizationId: salvageOrgId,
        userId: PHASE1A_SEED_IDS.users.revokedContractor,
        role: UserRole.ONTARIO_STRIPPER,
        isActive: false,
      },
      {
        organizationId: cannabisOrgId,
        userId: PHASE1A_SEED_IDS.users.cannabisQap,
        role: UserRole.CANNABIS_QAP_COMPLIANCE,
        isActive: true,
      },
    );

    const locs: OfflineLocationState[] = [
      {
        id: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: 4,
        fullQrBarcode: 'KEMP_ZONE_CONTAINER_PAD',
      },
      {
        id: PHASE1A_SEED_IDS.locations.KEMP_C01,
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'KEMP-C01-R01-S01-B01',
      },
      {
        id: PHASE1A_SEED_IDS.locations.KEMP_C02,
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'KEMP-C02-R01-S01-B01',
      },
      {
        id: PHASE1A_SEED_IDS.locations.RAMS_SHOP,
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: true,
        maxActiveAssetCapacity: 8,
        fullQrBarcode: 'RAMS-SHOP-R01-S01-B01',
      },
      {
        id: PHASE1A_SEED_IDS.locations.POSV_VAULT,
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.DORMANT_FUTURE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'POSV-V01-R01-S01-B01',
      },
      {
        id: PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2,
        organizationId: cannabisOrgId,
        allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'BROCK-PROP-R1-T2',
      },
    ];
    for (const loc of locs) {
      this.locations.set(loc.id, loc);
    }

    const drainedVehicleId = PHASE1A_SEED_IDS.vehicles.donorCrv2018;
    const undrainedVehicleId = '50000000-0000-4000-8000-000000000099';
    this.vehicles.set(drainedVehicleId, {
      id: drainedVehicleId,
      organizationId: salvageOrgId,
      assetCategory: AssetCategory.AUTOMOBILE,
      lifecycleState: AssetLifecycleState.DISMANTLING_IN_PROGRESS,
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
      fluidsDrainedAt: new Date('2026-11-01T12:00:00.000Z'),
      complianceWarnings: ['EXISTING_UNRELATED_WARNING'],
      version: 1,
    });
    this.vehicles.set(undrainedVehicleId, {
      id: undrainedVehicleId,
      organizationId: salvageOrgId,
      assetCategory: AssetCategory.AUTOMOBILE,
      lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
      storageLocationId: null,
      fluidsDrainedAt: null,
      complianceWarnings: [],
      version: 1,
    });

    this.parts.set(PHASE1A_SEED_IDS.parts.alternator, {
      id: PHASE1A_SEED_IDS.parts.alternator,
      organizationId: salvageOrgId,
      storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_C01,
      partCategoryName: 'Alternator',
      donorVehicleId: drainedVehicleId,
      complianceWarnings: ['EXISTING_PART_NOTE'],
      version: 1,
    });
    this.parts.set('60000000-0000-4000-8000-000000000099', {
      id: '60000000-0000-4000-8000-000000000099',
      organizationId: salvageOrgId,
      storageLocationId: null,
      partCategoryName: 'Complete Engine Assembly',
      donorVehicleId: undrainedVehicleId,
      complianceWarnings: [],
      version: 1,
    });
  }

  private assertActiveMembership(ctx: TenantExecutionContext): void {
    const ok = this.memberships.some(
      (m) =>
        m.organizationId === ctx.organizationId &&
        m.userId === ctx.userId &&
        m.role === ctx.role &&
        m.isActive,
    );
    if (!ok) {
      throw new AuthError(
        'MEMBERSHIP_REVOKED_OR_INACTIVE',
        'Active organization membership is revoked, inactive, or unauthorized.',
      );
    }
  }

  public async verifyAndResolveTenantPrintContext(
    ctx: TenantExecutionContext,
    activeOrganizationType: OrganizationType,
    inspection:
      | { readonly mode: 'DESCRIPTORS'; readonly locationBarcodes: readonly string[] }
      | { readonly mode: 'RANGE'; readonly rangeLocationSiteCode: string | null },
  ): Promise<{ readonly organizationName: string }> {
    this.assertActiveMembership(ctx);
    const org = this.orgs.get(ctx.organizationId);
    if (!org) {
      throw new AuthError(
        'MEMBERSHIP_REVOKED_OR_INACTIVE',
        'Organization not found.',
      );
    }

    if (
      inspection.mode === 'DESCRIPTORS' &&
      inspection.locationBarcodes.length > 0
    ) {
      for (const barcode of inspection.locationBarcodes) {
        const match = [...this.locations.values()].find(
          (l) =>
            l.organizationId === ctx.organizationId &&
            l.fullQrBarcode === barcode &&
            l.allowedOrgType === activeOrganizationType,
        );
        if (!match) {
          throw new LocationCustodyError(
            'SITE_ZONING_VIOLATION',
            `Location barcode "${barcode}" is unauthorized or unavailable in the active organization.`,
          );
        }
      }
    } else if (
      inspection.mode === 'RANGE' &&
      inspection.rangeLocationSiteCode !== null
    ) {
      const siteMatch = [...this.locations.values()].find(
        (l) =>
          l.organizationId === ctx.organizationId &&
          l.fullQrBarcode.startsWith(inspection.rangeLocationSiteCode!) &&
          l.allowedOrgType === activeOrganizationType,
      );
      if (!siteMatch) {
        throw new LocationCustodyError(
          'SITE_ZONING_VIOLATION',
          `Location site "${inspection.rangeLocationSiteCode}" is unauthorized.`,
        );
      }
    }

    return { organizationName: org.name };
  }

  public async withTenantTransaction<T>(
    ctx: TenantExecutionContext,
    fn: (tx: CustodyScanTx) => Promise<T>,
  ): Promise<T> {
    this.assertActiveMembership(ctx);

    // Transactional snapshots for deterministic rollback on error
    const vehiclesSnap = new Map(
      [...this.vehicles.entries()].map(([k, v]) => [
        k,
        { ...v, complianceWarnings: [...v.complianceWarnings] },
      ]),
    );
    const partsSnap = new Map(
      [...this.parts.entries()].map(([k, v]) => [
        k,
        { ...v, complianceWarnings: [...v.complianceWarnings] },
      ]),
    );
    const eventsLen = this.custodyEvents.length;
    const auditsLen = this.auditLogs.length;

    const tx: CustodyScanTx = {
      acquireOrganizationLock: async () => {},
      findIdempotentCustodyScan: async (organizationId, idempotencyKey) => {
        const ev = this.custodyEvents.find(
          (e) =>
            e.organizationId === organizationId &&
            e.idempotencyKey === idempotencyKey,
        );
        if (!ev) {
          return null;
        }
        const audit = this.auditLogs.find(
          (a) =>
            a.organizationId === organizationId &&
            a.entityType === CUSTODY_SCAN_AUDIT_ENTITY_TYPE &&
            a.entityId === ev.id &&
            a.action === CUSTODY_SCAN_AUDIT_ACTION,
        );
        const nextState = audit?.nextState as
          | { commandFingerprint?: string; scanResult?: unknown }
          | undefined;
        return {
          custodyEventId: ev.id,
          commandFingerprint:
            typeof nextState?.commandFingerprint === 'string'
              ? nextState.commandFingerprint
              : null,
          scanResult: (nextState?.scanResult as never) ?? null,
        };
      },
      readOrganizationPolicyRecord: async (organizationId) => {
        const org = this.orgs.get(organizationId);
        return org
          ? {
              organizationId: org.id,
              policyConfigJson: org.policyConfigJson,
            }
          : null;
      },
      findAndLockPartWithDonor: async (organizationId, partId) => {
        const part = this.parts.get(partId);
        if (!part || part.organizationId !== organizationId) {
          return null;
        }
        const donor = this.vehicles.get(part.donorVehicleId);
        if (!donor || donor.organizationId !== organizationId) {
          throw new LocationCustodyError(
            'CUSTODY_INTEGRITY_ERROR',
            'Donor vehicle not found.',
          );
        }
        const loc = part.storageLocationId
          ? this.locations.get(part.storageLocationId)
          : null;
        return {
          id: part.id,
          organizationId: part.organizationId,
          storageLocationId: part.storageLocationId,
          currentLocationBarcode: loc?.fullQrBarcode ?? null,
          partCategoryName: part.partCategoryName,
          donorVehicleId: part.donorVehicleId,
          donorVehicleFluidsDrainedAt: donor.fluidsDrainedAt,
          complianceWarnings: [...part.complianceWarnings],
          version: part.version,
        } satisfies LockedPartRecord;
      },
      findAndLockVehicle: async (organizationId, vehicleId) => {
        const v = this.vehicles.get(vehicleId);
        if (!v || v.organizationId !== organizationId) {
          return null;
        }
        const loc = v.storageLocationId
          ? this.locations.get(v.storageLocationId)
          : null;
        return {
          id: v.id,
          organizationId: v.organizationId,
          assetCategory: v.assetCategory,
          lifecycleState: v.lifecycleState,
          storageLocationId: v.storageLocationId,
          currentLocationBarcode: loc?.fullQrBarcode ?? null,
          fluidsDrainedAt: v.fluidsDrainedAt,
          complianceWarnings: [...v.complianceWarnings],
          version: v.version,
        } satisfies LockedVehicleRecord;
      },
      findAndLockStorageLocationByBarcode: async (
        organizationId,
        fullQrBarcode,
      ) => {
        const loc = [...this.locations.values()].find(
          (l) =>
            l.organizationId === organizationId &&
            l.fullQrBarcode === fullQrBarcode,
        );
        return loc ? { ...loc } : null;
      },
      countActiveVehiclesAtLocation: async (
        organizationId,
        storageLocationId,
      ) => {
        return [...this.vehicles.values()].filter(
          (v) =>
            v.organizationId === organizationId &&
            v.storageLocationId === storageLocationId &&
            v.lifecycleState !== 'PROPOSED_DEAL' &&
            v.lifecycleState !== 'SOLD_RETAIL_ONTARIO' &&
            v.lifecycleState !== 'SOLD_EXPORT_COD' &&
            v.lifecycleState !== 'SCRAPPED_METAL_CLEARED',
        ).length;
      },
      updatePartLocationAndVersion: async (input) => {
        const part = this.parts.get(input.partId);
        if (
          !part ||
          part.organizationId !== input.organizationId ||
          part.version !== input.expectedCurrentVersion
        ) {
          return false;
        }
        part.storageLocationId = input.storageLocationId;
        part.version = input.nextVersion;
        part.complianceWarnings = [...input.complianceWarnings];
        return true;
      },
      updateVehicleLocationAndVersion: async (input) => {
        const v = this.vehicles.get(input.vehicleId);
        if (
          !v ||
          v.organizationId !== input.organizationId ||
          v.version !== input.expectedCurrentVersion
        ) {
          return false;
        }
        v.storageLocationId = input.storageLocationId;
        v.version = input.nextVersion;
        v.complianceWarnings = [...input.complianceWarnings];
        return true;
      },
      insertCustodyEvent: async (input) => {
        if (
          this.custodyEvents.some(
            (e) =>
              e.organizationId === input.organizationId &&
              e.idempotencyKey === input.idempotencyKey,
          )
        ) {
          const err = new Error('Duplicate idempotency key') as Error & {
            code: string;
          };
          err.code = 'IDEMPOTENCY_CONFLICT';
          throw err;
        }
        this.custodyEvents.push({ ...input });
      },
      insertAuditLog: async (input) => {
        if (this.failNextAuditInsert) {
          this.failNextAuditInsert = false;
          throw new Error('Injected audit failure');
        }
        this.auditLogs.push({ ...input });
      },
    };

    try {
      return await fn(tx);
    } catch (err) {
      this.vehicles.clear();
      for (const [k, v] of vehiclesSnap.entries()) {
        this.vehicles.set(k, v);
      }
      this.parts.clear();
      for (const [k, v] of partsSnap.entries()) {
        this.parts.set(k, v);
      }
      this.custodyEvents.length = eventsLen;
      this.auditLogs.length = auditsLen;
      throw err;
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Issue #6: Composition & Server Boundary Smoke Checks', () => {
  it('imports server barrel in Node without browser globals and constructs real production handlers', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe(
      'undefined',
    );
    const generator = new QrTagSheetAndZplGenerator();
    expect(typeof generator.generateLetterQrTagSheet).toBe('function');
    expect(typeof generator.generateZplLabel).toBe('function');
    expect(typeof createPrismaCustodyRepository).toBe('function');
    const handler = createRecordCustodyScanHandler();
    expect(typeof handler).toBe('function');
  });
});

describe('Issue #6: QR Hang-Tag Sheet & ZPL Generator (RULE-TAG-001)', () => {
  const generator = new QrTagSheetAndZplGenerator();

  it('generates deterministic 12_UP_3X4 and 16_UP_4X4 SVG + PDF 1.4 sheets with >=1.5in QR, >=4-module quiet zones, punch guides, and valid QR decoding', async () => {
    const descriptors = [
      { code: 'PRT-884920', caption: 'Honda CR-V Alternator' },
      { code: 'AST-2026-0001', caption: '2018 Honda CR-V EX' },
      { code: 'PLT-2026-001', caption: 'Export Pallet #1' },
      { code: 'KEMP-C01-R01-S01-B01', caption: 'Container 1 Rack 1' },
      { code: 'BROCK-PROP-R1-T2', caption: 'Propagator Rack 1' },
      { code: 'LOT-2026-0001', caption: 'Mother Lot #1' },
    ];

    const res3x4 = generator.generateLetterQrTagSheet({
      descriptors,
      gridPreset: '12_UP_3X4',
      punchStyle: 'SINGLE_OVAL_SLOT_15X4MM',
    });
    const res3x4Repeat = generator.generateLetterQrTagSheet({
      descriptors,
      gridPreset: '12_UP_3X4',
      punchStyle: 'SINGLE_OVAL_SLOT_15X4MM',
    });

    expect(res3x4.pageCount).toBe(1);
    expect(res3x4.tagCount).toBe(6);
    expect(res3x4.svgPages).toHaveLength(1);
    expect(res3x4.svgPages[0]).toBe(res3x4Repeat.svgPages[0]);
    expect(Buffer.from(res3x4.pdfBytes).equals(Buffer.from(res3x4Repeat.pdfBytes))).toBe(true);
    expect(Buffer.from(res3x4.pdfBytes.slice(0, 8)).toString('ascii')).toBe(
      '%PDF-1.4',
    );

    // Geometry invariants in SVG
    const svg = res3x4.svgPages[0]!;
    expect(svg).toContain('width="8.5in"');
    expect(svg).toContain('height="11in"');
    expect(svg).toContain('viewBox="0 0 612 792"');
    expect(svg).toContain(`data-qr-size-pt="${QR_CORE_SIZE_PT}"`);
    expect(svg).toContain('data-punch-guide="SINGLE_OVAL_SLOT_15X4MM"');
    expect(svg).toContain(`width="${OVAL_SLOT_WIDTH_PT.toFixed(3).replace(/\.?0+$/, '')}"`);
    expect(svg).toContain(`height="${OVAL_SLOT_HEIGHT_PT.toFixed(3).replace(/\.?0+$/, '')}"`);
    expect(QR_CORE_SIZE_PT).toBeGreaterThanOrEqual(108);
    expect(QR_OUTER_SIZE_PT).toBeCloseTo((108 * 37) / 29, 4);

    // Verify independent PDF parsing + text extraction + QR round-trip in both PDF and SVG
    const pdfDoc = await pdfjs.getDocument({
      data: new Uint8Array(res3x4.pdfBytes),
      disableWorker: true,
      verbosity: 0,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
    expect(pdfDoc.numPages).toBe(1);
    const pdfPage1 = await pdfDoc.getPage(1);
    expect(pdfPage1.view).toEqual([0, 0, LETTER_PAGE_WIDTH_PT, LETTER_PAGE_HEIGHT_PT]);
    const textContent = await pdfPage1.getTextContent();
    const textJoined = textContent.items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ');
    for (const d of descriptors) {
      expect(textJoined).toContain(d.code);
    }

    for (let i = 0; i < descriptors.length; i += 1) {
      expect(await decodeCellFromPdf(res3x4.pdfBytes, 1, 3, 4, i)).toBe(
        descriptors[i]!.code,
      );
      expect(await decodeCellFromSvg(svg, 3, 4, i)).toBe(
        descriptors[i]!.code,
      );
    }

    // Verify 16_UP_4X4 + DUAL_TOP_RACK_HOLES + 40-char max canonical code
    const maxCode = 'KEMP_ZONE_C01_R02_S03_B04_ABCDEFGHIJKLMN';
    expect(maxCode.length).toBe(40);
    const res4x4 = generator.generateLetterQrTagSheet({
      descriptors: [
        { code: maxCode, caption: 'A & B <Rack> (Upper) \\ Zone' },
        { code: 'PRT-884920', caption: 'Alternator' },
      ],
      gridPreset: '16_UP_4X4',
      punchStyle: 'DUAL_TOP_RACK_HOLES',
    });

    expect(res4x4.svgPages[0]).toContain('data-punch-guide="DUAL_TOP_RACK_HOLES"');
    expect(res4x4.svgPages[0]).toContain('&amp;');
    expect(res4x4.svgPages[0]).toContain('&lt;Rack&gt;');
    expect(await decodeCellFromPdf(res4x4.pdfBytes, 1, 4, 4, 0)).toBe(maxCode);
    expect(await decodeCellFromSvg(res4x4.svgPages[0]!, 4, 4, 0)).toBe(maxCode);
    expect(await decodeCellFromPdf(res4x4.pdfBytes, 1, 4, 4, 1)).toBe('PRT-884920');

    // Ensure no guillotine cut lines cross any QR quiet zone in 16_UP_4X4
    const cellW4 = LETTER_PAGE_WIDTH_PT / 4; // 153
    const quietLeftMargin = (cellW4 - QR_OUTER_SIZE_PT) / 2;
    expect(quietLeftMargin).toBeGreaterThan(7);
    expect(PRINTABLE_INSET_PT).toBe(18);
  });

  it('paginates accurately at 12/13 (3x4) and 16/17 (4x4) boundaries with empty trailing cells on partial pages', () => {
    const p12 = generator.generateLetterQrTagSheet({
      range: { prefix: 'PRT-', start: 1, end: 12, width: 6 },
      gridPreset: '12_UP_3X4',
    });
    expect(p12.pageCount).toBe(1);

    const p13 = generator.generateLetterQrTagSheet({
      range: { prefix: 'PRT-', start: 1, end: 13, width: 6 },
      gridPreset: '12_UP_3X4',
    });
    expect(p13.pageCount).toBe(2);
    expect(p13.svgPages[1]).toContain('PRT-000013');
    expect((p13.svgPages[1]!.match(/data-tag-code=/g) ?? [])).toHaveLength(1);

    const p16 = generator.generateLetterQrTagSheet({
      range: { prefix: 'AST-2026-', start: 1, end: 16, width: 4 },
      gridPreset: '16_UP_4X4',
    });
    expect(p16.pageCount).toBe(1);

    const p17 = generator.generateLetterQrTagSheet({
      range: { prefix: 'PLT-2026-', start: 1, end: 17, width: 3 },
      gridPreset: '16_UP_4X4',
    });
    expect(p17.pageCount).toBe(2);
    expect((p17.svgPages[1]!.match(/data-tag-code=/g) ?? [])).toHaveLength(1);
    expect(p17.svgPages[1]).toContain('PLT-2026-017');
  });

  it('rejects empty, oversized, duplicate, malformed, mixed descriptors+range, overflow, and control-char inputs', () => {
    expect(() =>
      generator.generateLetterQrTagSheet({ descriptors: [] }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'PRT-000001' }],
        range: { prefix: 'PRT-', start: 1, end: 2 },
      } as never),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'PRT-000001' }, { code: 'PRT-000001' }],
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        range: { prefix: 'PRT-', start: 1, end: 1001, width: 6 },
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        range: { prefix: 'PRT-', start: 1, end: 1000, width: 2 },
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        range: { prefix: 'PRT-', start: 5, end: 2 },
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        range: { prefix: 'PRT-', start: -1, end: 2 },
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'https://evil.example/prt-1' }],
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'prt-lowercase' }],
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'PRT-000001', caption: 'Bad\nLine' }],
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'PRT-000001', caption: 'X'.repeat(65) }],
      }),
    ).toThrowError(LabelTagError);

    expect(() =>
      generator.generateLetterQrTagSheet({
        descriptors: [{ code: 'PRT-000001' }],
        gridPreset: '24_UP_4X6' as never,
      }),
    ).toThrowError(LabelTagError);
  });

  it('generates deterministic ZPL II labels and escapes ^, ~, and \\ to prevent command injection', () => {
    const zpl = generator.generateZplLabel({
      code: 'PRT-884920',
      caption: 'Inject^XZ^XA~SD30\\Test',
      organizationLabel: 'Ontario Salvage',
    });
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl.endsWith('^XZ')).toBe(true);
    expect(zpl).toContain('^BQN,2,9^FH\\^FDMA,PRT-884920^FS');
    expect(zpl).toContain('Inject\\5EXZ\\5EXA\\7ESD30\\5CTest');
    expect(zpl.match(/\^XZ/g)).toHaveLength(1);
    expect(generator.generateZplLabel({ code: 'PRT-884920' })).toBe(
      generator.generateZplLabel({ code: 'PRT-884920' }),
    );
  });
});

describe('Issue #6: Data-Driven LocationZoningService (RULE-ZONE-001 & RULE-ENV-001)', () => {
  const zoning = new LocationZoningService();
  const salvageOrgId = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
  const cannabisOrgId = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;

  it('normalizes powertrain part categories accurately without false positives on non-powertrain parts', () => {
    expect(isFluidBearingPowertrainPartCategory('Complete Engine Assembly')).toBe(true);
    expect(isFluidBearingPowertrainPartCategory('  transmission / gearbox / transaxle  ')).toBe(true);
    expect(isFluidBearingPowertrainPartCategory('TRANSAXLE')).toBe(true);
    expect(isFluidBearingPowertrainPartCategory('Alternator')).toBe(false);
    expect(isFluidBearingPowertrainPartCategory('Steering Rack')).toBe(false);
  });

  it('always blocks cross-tenant and allowedOrgType mismatches with 422 SITE_ZONING_VIOLATION regardless of compliance mode', () => {
    for (const mode of ['WARN_ONLY', 'STRICT_BLOCK'] as const) {
      expect(() =>
        zoning.evaluateLocationZoning({
          activeOrganizationId: salvageOrgId,
          activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
          entity: {
            kind: 'PART',
            id: 'p1',
            organizationId: salvageOrgId,
            partCategoryName: 'Alternator',
            storageLocationId: null,
            donorVehicleFluidsDrainedAt: null,
          },
          location: {
            id: 'loc-brock',
            organizationId: cannabisOrgId,
            allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
            locationOperationalStatus: LocationOperationalStatus.ACTIVE,
            allowsWholeVehicleDismantling: true,
            maxActiveAssetCapacity: null,
            fullQrBarcode: 'ARBITRARY-CAN-01',
          },
          complianceEnforcementMode: mode,
          locationCapacityGateMode: 'HARD_BLOCK',
          currentDestinationActiveAssetCount: 0,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'SITE_ZONING_VIOLATION',
          status: 422,
        }),
      );
    }
  });

  it('evaluates locationOperationalStatus and RULE-ENV-001 strictly from metadata flags (arbitrary site codes)', () => {
    // DORMANT_FUTURE -> 422 LOCATION_DORMANT_INACTIVE in both modes
    expect(() =>
      zoning.evaluateLocationZoning({
        activeOrganizationId: salvageOrgId,
        activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
        entity: {
          kind: 'PART',
          id: 'p1',
          organizationId: salvageOrgId,
          partCategoryName: 'Alternator',
          storageLocationId: null,
          donorVehicleFluidsDrainedAt: null,
        },
        location: {
          id: 'loc-dormant',
          organizationId: salvageOrgId,
          allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
          locationOperationalStatus: LocationOperationalStatus.DORMANT_FUTURE,
          allowsWholeVehicleDismantling: false,
          maxActiveAssetCapacity: null,
          fullQrBarcode: 'ANYCODE-V99-R1-S1-B1',
        },
        complianceEnforcementMode: 'WARN_ONLY',
        locationCapacityGateMode: 'HARD_BLOCK',
        currentDestinationActiveAssetCount: 0,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'LOCATION_DORMANT_INACTIVE',
        status: 422,
      }),
    );

    // PROPOSED_INACTIVE + allowsWholeVehicleDismantling=false + undrained vehicle -> both warnings in WARN_ONLY
    const bothWarn = zoning.evaluateLocationZoning({
      activeOrganizationId: salvageOrgId,
      activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
      entity: {
        kind: 'VEHICLE',
        id: 'v1',
        organizationId: salvageOrgId,
        assetCategory: AssetCategory.AUTOMOBILE,
        lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
        storageLocationId: null,
        fluidsDrainedAt: null,
      },
      location: {
        id: 'loc-prop',
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: 8,
        fullQrBarcode: 'ARBITRARY-PROP-01',
      },
      complianceEnforcementMode: 'WARN_ONLY',
      locationCapacityGateMode: 'HARD_BLOCK',
      currentDestinationActiveAssetCount: 0,
    });
    expect(bothWarn.warnings).toEqual([
      'PROPOSED_INACTIVE_LOCATION_WARNING',
      'COMPLIANCE_WARNING_UNDRAINED_FARM',
    ]);

    // STRICT_BLOCK orders LOCATION_PROPOSED_INACTIVE ahead of ENVIRONMENTAL_ZONING_VIOLATION
    expect(() =>
      zoning.evaluateLocationZoning({
        activeOrganizationId: salvageOrgId,
        activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
        entity: {
          kind: 'VEHICLE',
          id: 'v1',
          organizationId: salvageOrgId,
          assetCategory: AssetCategory.AUTOMOBILE,
          lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
          storageLocationId: null,
          fluidsDrainedAt: null,
        },
        location: {
          id: 'loc-prop',
          organizationId: salvageOrgId,
          allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
          locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
          allowsWholeVehicleDismantling: false,
          maxActiveAssetCapacity: 8,
          fullQrBarcode: 'ARBITRARY-PROP-01',
        },
        complianceEnforcementMode: 'STRICT_BLOCK',
        locationCapacityGateMode: 'HARD_BLOCK',
        currentDestinationActiveAssetCount: 0,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'LOCATION_PROPOSED_INACTIVE',
        status: 422,
      }),
    );

    // Same-location scan at capacity adds 0; new incoming vehicle at capacity throws 422 unless CFO override
    const sameLocAtCap = zoning.evaluateLocationZoning({
      activeOrganizationId: salvageOrgId,
      activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
      entity: {
        kind: 'VEHICLE',
        id: 'v1',
        organizationId: salvageOrgId,
        assetCategory: AssetCategory.WATERCRAFT,
        lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
        storageLocationId: 'loc-pad',
        fluidsDrainedAt: null,
      },
      location: {
        id: 'loc-pad',
        organizationId: salvageOrgId,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: 4,
        fullQrBarcode: 'ARBITRARY-PAD-01',
      },
      complianceEnforcementMode: 'WARN_ONLY',
      locationCapacityGateMode: 'HARD_BLOCK',
      currentDestinationActiveAssetCount: 4,
    });
    expect(sameLocAtCap.warnings).toEqual([]);
    expect(sameLocAtCap.overrideApplied).toBe(false);
  });
});

describe('Issue #6: recordCustodyScan Use Case (Zoning, Conflict, Capacity, CFO Override, Idempotency)', () => {
  it('enforces RAMS PROPOSED_INACTIVE, POSV DORMANT_FUTURE, BROCK cross-tenant, RULE-ENV-001, capacity + CFO override, conflicts, and NFR-IDEM-01', async () => {
    const repo = new InMemoryCustodyTestRepository();
    const mechanicSession = makeTrustedSession({
      userId: PHASE1A_SEED_IDS.users.hunterMechanic,
      role: UserRole.HUNTER_MECHANIC,
      aal: 'aal1',
      mfaEnrolled: false,
    });
    const cfoAal2Session = makeTrustedSession({
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      aal: 'aal2',
      mfaEnrolled: true,
    });
    const cfoAal1Session = makeTrustedSession({
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      aal: 'aal1',
      mfaEnrolled: true,
    });

    // 1. Cross-tenant BROCK-PROP-R1-T2 -> 422 SITE_ZONING_VIOLATION, zero writes
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'BROCK-PROP-R1-T2',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000001',
          deviceTimestamp: '2026-11-15T10:00:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'SITE_ZONING_VIOLATION', status: 422 });
    expect(repo.custodyEvents).toHaveLength(0);

    // 2. POSV DORMANT_FUTURE -> 422 LOCATION_DORMANT_INACTIVE, zero writes
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'POSV-V01-R01-S01-B01',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000002',
          deviceTimestamp: '2026-11-15T10:01:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'LOCATION_DORMANT_INACTIVE', status: 422 });
    expect(repo.custodyEvents).toHaveLength(0);

    // 3. RAMS PROPOSED_INACTIVE in WARN_ONLY -> allows scan, emits PROPOSED_INACTIVE_LOCATION_WARNING, preserves existing warnings
    const ramsWarnRes = await recordCustodyScan(
      mechanicSession,
      {
        entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
        destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
        expectedVersion: 1,
        idempotencyKey: '01933000-0000-7000-8000-000000000003',
        deviceTimestamp: '2026-11-15T10:02:00.000Z',
      },
      { repository: repo },
    );
    expect(ramsWarnRes.applied).toBe(true);
    expect(ramsWarnRes.version).toBe(2);
    expect(ramsWarnRes.complianceWarnings).toEqual([
      'PROPOSED_INACTIVE_LOCATION_WARNING',
    ]);
    expect(ramsWarnRes.entityComplianceWarnings).toEqual([
      'EXISTING_PART_NOTE',
      'PROPOSED_INACTIVE_LOCATION_WARNING',
    ]);

    // 4. Exact idempotent retry even after a subsequent move returns exact original result
    const moveToKempC02 = await recordCustodyScan(
      mechanicSession,
      {
        entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
        destinationBarcode: 'KEMP-C02-R01-S01-B01',
        expectedVersion: 2,
        idempotencyKey: '01933000-0000-7000-8000-000000000004',
        deviceTimestamp: '2026-11-15T10:03:00.000Z',
      },
      { repository: repo },
    );
    expect(moveToKempC02.version).toBe(3);

    const replayRamsRes = await recordCustodyScan(
      mechanicSession,
      {
        entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
        destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
        expectedVersion: 1,
        idempotencyKey: '01933000-0000-7000-8000-000000000003',
        deviceTimestamp: '2026-11-15T10:02:00.000Z',
      },
      { repository: repo },
    );
    expect(replayRamsRes).toEqual(ramsWarnRes);
    expect(repo.parts.get(PHASE1A_SEED_IDS.parts.alternator)!.version).toBe(3);

    // 5. Same idempotency key with different payload -> 409 IDEMPOTENCY_KEY_REUSED
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'KEMP-C01-R01-S01-B01',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000003',
          deviceTimestamp: '2026-11-15T10:02:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

    // 6. Stale expectedVersion -> hasConflict = true, records event & audit without overwriting entity
    const staleRes = await recordCustodyScan(
      mechanicSession,
      {
        entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
        destinationBarcode: 'KEMP-C01-R01-S01-B01',
        expectedVersion: 1, // stale (server is at 3)
        idempotencyKey: '01933000-0000-7000-8000-000000000005',
        deviceTimestamp: '2026-11-15T10:04:00.000Z',
      },
      { repository: repo },
    );
    expect(staleRes.applied).toBe(false);
    expect(staleRes.hasConflict).toBe(true);
    expect(staleRes.version).toBe(3);
    expect(staleRes.locationId).toBe(PHASE1A_SEED_IDS.locations.KEMP_C02);
    expect(repo.parts.get(PHASE1A_SEED_IDS.parts.alternator)!.storageLocationId).toBe(
      PHASE1A_SEED_IDS.locations.KEMP_C02,
    );

    // 7. RULE-ENV-001: undrained powertrain Part ("Complete Engine Assembly") at KEMP -> COMPLIANCE_WARNING_UNDRAINED_FARM
    const undrainedEngineId = '60000000-0000-4000-8000-000000000099';
    const engineScan = await recordCustodyScan(
      mechanicSession,
      {
        entity: { kind: 'PART', id: undrainedEngineId },
        destinationBarcode: 'KEMP-C01-R01-S01-B01',
        expectedVersion: 1,
        idempotencyKey: '01933000-0000-7000-8000-000000000006',
        deviceTimestamp: '2026-11-15T10:05:00.000Z',
      },
      { repository: repo },
    );
    expect(engineScan.complianceWarnings).toEqual([
      'COMPLIANCE_WARNING_UNDRAINED_FARM',
    ]);

    // 8. Rollback atomicity: audit insert failure reverts Part update & CustodyEvent
    repo.failNextAuditInsert = true;
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'KEMP-C01-R01-S01-B01',
          expectedVersion: 3,
          idempotencyKey: '01933000-0000-7000-8000-000000000007',
          deviceTimestamp: '2026-11-15T10:06:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toThrow('Injected audit failure');
    expect(repo.parts.get(PHASE1A_SEED_IDS.parts.alternator)!.version).toBe(3);

    // 9. Capacity = 4 on KEMP_ZONE_CONTAINER_PAD + 1-Tap cfoOverride (aal2 CFO vs mechanic vs aal1 CFO)
    for (let i = 0; i < 3; i += 1) {
      repo.vehicles.set(`50000000-0000-4000-8000-00000000010${i}`, {
        id: `50000000-0000-4000-8000-00000000010${i}`,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        assetCategory: AssetCategory.AUTOMOBILE,
        lifecycleState: AssetLifecycleState.STAGED_ONTARIO_YARD,
        storageLocationId: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
        fluidsDrainedAt: new Date('2026-11-01T12:00:00.000Z'),
        complianceWarnings: [],
        version: 1,
      });
    }
    const undrainedVehId = '50000000-0000-4000-8000-000000000099';

    // 4 vehicles already on pad -> 5th blocked without override
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'VEHICLE', id: undrainedVehId },
          destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000008',
          deviceTimestamp: '2026-11-15T10:07:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'LOCATION_CAPACITY_EXCEEDED', status: 422 });

    // Non-CFO or aal1 CFO cannot spoof cfoOverride
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'VEHICLE', id: undrainedVehId },
          destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000009',
          deviceTimestamp: '2026-11-15T10:08:00.000Z',
          cfoOverride: true,
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', status: 403 });

    await expect(
      recordCustodyScan(
        cfoAal1Session,
        {
          entity: { kind: 'VEHICLE', id: undrainedVehId },
          destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000010',
          deviceTimestamp: '2026-11-15T10:09:00.000Z',
          cfoOverride: true,
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'MFA_AAL2_REQUIRED', status: 403 });

    // aal2 ARCHITECT_CFO succeeds with overrideApplied = true AND still records UNDRAINED warning
    const overrideRes = await recordCustodyScan(
      cfoAal2Session,
      {
        entity: { kind: 'VEHICLE', id: undrainedVehId },
        destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
        expectedVersion: 1,
        idempotencyKey: '01933000-0000-7000-8000-000000000011',
        deviceTimestamp: '2026-11-15T10:10:00.000Z',
        cfoOverride: true,
      },
      { repository: repo },
    );
    expect(overrideRes.applied).toBe(true);
    expect(overrideRes.overrideApplied).toBe(true);
    expect(overrideRes.complianceWarnings).toEqual([
      'COMPLIANCE_WARNING_UNDRAINED_FARM',
    ]);

    // 10. STRICT_BLOCK complianceEnforcementMode blocks RAMS with 422 LOCATION_PROPOSED_INACTIVE
    repo.orgs.get(PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT)!.policyConfigJson = {
      operationalGates: { complianceEnforcementMode: 'STRICT_BLOCK' },
    };
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
          expectedVersion: 3,
          idempotencyKey: '01933000-0000-7000-8000-000000000012',
          deviceTimestamp: '2026-11-15T10:11:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'LOCATION_PROPOSED_INACTIVE', status: 422 });

    // 11. Revoked membership is denied 403 even on idempotent replay
    const mechanicMembership = repo.memberships.find(
      (m) => m.userId === PHASE1A_SEED_IDS.users.hunterMechanic,
    )!;
    mechanicMembership.isActive = false;

    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000003',
          deviceTimestamp: '2026-11-15T10:02:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      status: 403,
    });

    // 12. Missing entity -> 404 ENTITY_NOT_FOUND
    mechanicMembership.isActive = true;
    await expect(
      recordCustodyScan(
        mechanicSession,
        {
          entity: { kind: 'PART', id: randomUUID() },
          destinationBarcode: 'KEMP-C01-R01-S01-B01',
          expectedVersion: 1,
          idempotencyKey: '01933000-0000-7000-8000-000000000013',
          deviceTimestamp: '2026-11-15T10:12:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', status: 404 });
  });

  it('rejects pre-feature custody rows missing replay metadata with 500 CUSTODY_INTEGRITY_ERROR instead of mutating', async () => {
    const repo = new InMemoryCustodyTestRepository();
    const session = makeTrustedSession();
    const key = '01933000-0000-7000-8000-0000000000aa';

    repo.custodyEvents.push({
      id: randomUUID(),
      organizationId: session.activeOrganizationId,
      partId: PHASE1A_SEED_IDS.parts.alternator,
      vehicleId: null,
      actorUserId: session.userId,
      idempotencyKey: key,
      fromLocationBarcode: null,
      toLocationBarcode: 'KEMP-C01-R01-S01-B01',
      expectedVersion: 1,
      hasConflict: false,
      complianceWarnings: [],
      deviceTimestamp: new Date('2026-11-15T10:00:00.000Z'),
      serverReceivedAt: new Date('2026-11-15T10:00:01.000Z'),
    });

    await expect(
      recordCustodyScan(
        session,
        {
          entity: { kind: 'PART', id: PHASE1A_SEED_IDS.parts.alternator },
          destinationBarcode: 'KEMP-C02-R01-S01-B01',
          expectedVersion: 1,
          idempotencyKey: key,
          deviceTimestamp: '2026-11-15T10:00:00.000Z',
        },
        { repository: repo },
      ),
    ).rejects.toMatchObject({ code: 'CUSTODY_INTEGRITY_ERROR', status: 500 });
    expect(repo.parts.get(PHASE1A_SEED_IDS.parts.alternator)!.version).toBe(1);
  });
});

describe('Issue #6: /api/shared/labels/sheet GET & POST Route Contracts', () => {
  it('serves printable PDF and multi-page SVG with strict security headers and tenant/capability enforcement', async () => {
    const repo = new InMemoryCustodyTestRepository();
    const cfoSession = makeTrustedSession({
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
    });
    const stripperSession = makeTrustedSession({
      userId: PHASE1A_SEED_IDS.users.ontarioStripper,
      role: UserRole.ONTARIO_STRIPPER,
      aal: 'aal1',
      mfaEnrolled: false,
    });
    const cannabisSession = makeTrustedSession({
      userId: PHASE1A_SEED_IDS.users.cannabisQap,
      activeOrganizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      activeOrganizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      role: UserRole.CANNABIS_QAP_COMPLIANCE,
    });

    // 1. GET PDF range
    const getPdf = await handleLabelSheetGet(
      new Request(
        'https://erp.local/api/shared/labels/sheet?prefix=PRT-&start=1&end=13&width=6&gridPreset=12_UP_3X4',
      ),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(getPdf.status).toBe(200);
    expect(getPdf.headers.get('content-type')).toBe('application/pdf');
    expect(getPdf.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0',
    );
    expect(getPdf.headers.get('x-content-type-options')).toBe('nosniff');
    expect(getPdf.headers.get('x-page-count')).toBe('2');
    expect(getPdf.headers.get('x-tag-count')).toBe('13');
    const pdfBytes = new Uint8Array(await getPdf.arrayBuffer());
    expect(Buffer.from(pdfBytes.slice(0, 8)).toString('ascii')).toBe('%PDF-1.4');

    // 2. GET SVG page 2 + out-of-range page 3 -> 400
    const getSvg2 = await handleLabelSheetGet(
      new Request(
        'https://erp.local/api/shared/labels/sheet?prefix=PRT-&start=1&end=13&width=6&format=svg&page=2',
      ),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(getSvg2.status).toBe(200);
    expect(getSvg2.headers.get('content-type')).toContain('image/svg+xml');
    expect(await getSvg2.text()).toContain('PRT-000013');

    const getSvgOutOfRange = await handleLabelSheetGet(
      new Request(
        'https://erp.local/api/shared/labels/sheet?prefix=PRT-&start=1&end=13&width=6&format=svg&page=3',
      ),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(getSvgOutOfRange.status).toBe(400);

    // 3. Unknown query param -> 400
    const getUnknownParam = await handleLabelSheetGet(
      new Request(
        'https://erp.local/api/shared/labels/sheet?prefix=PRT-&start=1&end=2&extra=1',
      ),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(getUnknownParam.status).toBe(400);

    // 4. POST valid salvage descriptors (part + seeded KEMP location)
    const postOk = await handleLabelSheetPost(
      new Request('https://erp.local/api/shared/labels/sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptors: [
            { code: 'PRT-884920', caption: 'Alternator' },
            { code: 'KEMP-C01-R01-S01-B01', caption: 'Bin 1' },
          ],
          format: 'svg',
          gridPreset: '16_UP_4X4',
          punchStyle: 'DUAL_TOP_RACK_HOLES',
        }),
      }),
      { resolveSession: async () => stripperSession, repository: repo },
    );
    expect(postOk.status).toBe(200);

    // 5. Foreign BROCK location -> 422 SITE_ZONING_VIOLATION
    const postForeignLoc = await handleLabelSheetPost(
      new Request('https://erp.local/api/shared/labels/sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptors: [{ code: 'BROCK-PROP-R1-T2' }],
        }),
      }),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(postForeignLoc.status).toBe(422);

    // 6. Cannabis LOT blocked on Phase 1A route -> 403 CAPABILITY_FORBIDDEN
    const postLot = await handleLabelSheetPost(
      new Request('https://erp.local/api/shared/labels/sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptors: [{ code: 'LOT-2026-0001' }],
        }),
      }),
      { resolveSession: async () => cannabisSession, repository: repo },
    );
    expect(postLot.status).toBe(403);

    // 7. Mixed sheet capability check: stripper lacks FR-INT-01:create -> 403
    const postMixedDenied = await handleLabelSheetPost(
      new Request('https://erp.local/api/shared/labels/sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          descriptors: [
            { code: 'PRT-884920' },
            { code: 'AST-2026-0001' },
          ],
        }),
      }),
      { resolveSession: async () => stripperSession, repository: repo },
    );
    expect(postMixedDenied.status).toBe(403);

    // 8. Unauthenticated -> 401; Revoked membership -> 403
    const unauthRes = await handleLabelSheetGet(
      new Request(
        'https://erp.local/api/shared/labels/sheet?prefix=PRT-&start=1&end=1',
      ),
      {
        resolveSession: async () => {
          throw new AuthError('UNAUTHENTICATED', 'Auth required.');
        },
        repository: repo,
      },
    );
    expect(unauthRes.status).toBe(401);

    repo.memberships.find(
      (m) => m.userId === PHASE1A_SEED_IDS.users.architectCfo,
    )!.isActive = false;
    const revokedRes = await handleLabelSheetGet(
      new Request(
        'https://erp.local/api/shared/labels/sheet?prefix=PRT-&start=1&end=1',
      ),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(revokedRes.status).toBe(403);

    // 9. Malformed JSON & wrong MIME -> 400
    const badMime = await handleLabelSheetPost(
      new Request('https://erp.local/api/shared/labels/sheet', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      }),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(badMime.status).toBe(400);

    const badJson = await handleLabelSheetPost(
      new Request('https://erp.local/api/shared/labels/sheet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid',
      }),
      { resolveSession: async () => cfoSession, repository: repo },
    );
    expect(badJson.status).toBe(400);
    expect(toTenantExecutionContext(cfoSession).organizationId).toBe(
      PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
    );
  });
});
