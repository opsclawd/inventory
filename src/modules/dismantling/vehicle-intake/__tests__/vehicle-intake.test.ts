import { randomUUID } from 'node:crypto';
import {
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CurrencyCode,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PaymentSettlementState,
  Prisma,
  type PrismaClient,
  ReceiptVerificationState,
  SaleMarketNode,
  TaxCollectionMode,
  UserRole,
} from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselinePolicyJson from '@/core/config/pricing-policy.json';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';
import { AuthError } from '@/modules/shared-ops/auth';
import { createAuthSessionContext } from '@/modules/shared-ops/auth/auth.contracts';
import { StorageError } from '@/core/ports/storage.port';
import { LocationCustodyError } from '@/modules/shared-ops/locations-qr/location-zoning.service';
import { querySeparatedFinancialSnapshot } from '@/modules/cfo-subledger/financial-snapshot.query';
import {
  CompositeAssetDecoderAdapter,
  createCategoryAssetDecoderFactory,
  createProductionIntakeVehicleUseCase,
  handleSalvageVehiclesGet,
  handleSalvageVehiclesPost,
  type IntakeVehicleInput,
  type IntakeVehicleRepository,
  type IntakeVehicleTx,
  IntakeVehicleUseCase,
  type LockedExistingAcquisitionExpense,
  type LockedIntakeStorageLocation,
  OfflineAssetDecoderAdapter,
  parseWatercraftHin,
  type PersistAcquisitionExpenseRecord,
  type PersistInitialCustodyEventRecord,
  type PersistIntakeAuditLogRecord,
  type PersistVehicleRecord,
  VehicleIntakeError,
} from '../index';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';

const ORG_SALVAGE = PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT;
const ORG_CANNABIS = PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC;
const CFO_USER_ID = PHASE1A_SEED_IDS.users.architectCfo;
const HUNTER_USER_ID = PHASE1A_SEED_IDS.users.hunterMechanic;
const STRIPPER_USER_ID = PHASE1A_SEED_IDS.users.ontarioStripper;
const VAULT_ADMIN_USER_ID = PHASE1A_SEED_IDS.users.trinidadVaultAdmin;

function makeSalvageSession(options?: {
  role?: UserRole;
  userId?: string;
  aal?: 'aal1' | 'aal2';
  mfaEnrolled?: boolean;
}) {
  const role = options?.role ?? UserRole.ARCHITECT_CFO;
  const userId =
    options?.userId ??
    (role === UserRole.ARCHITECT_CFO
      ? CFO_USER_ID
      : role === UserRole.HUNTER_MECHANIC
        ? HUNTER_USER_ID
        : role === UserRole.ONTARIO_STRIPPER
          ? STRIPPER_USER_ID
          : VAULT_ADMIN_USER_ID);
  return createAuthSessionContext({
    userId,
    activeOrganizationId: ORG_SALVAGE,
    role,
    activeOrganizationType: OrganizationType.SALVAGE_AND_EXPORT,
    activeMemberships: [
      {
        membershipId: randomUUID(),
        organizationId: ORG_SALVAGE,
        organizationSlug: 'ORG_SALVAGE_EXPORT',
        organizationName: 'Auto & Marine Salvage (Kemptville)',
        organizationType: OrganizationType.SALVAGE_AND_EXPORT,
        role,
        isDefaultWorkspace: true,
      },
    ],
    aal: options?.aal ?? 'aal2',
    mfaEnrolled: options?.mfaEnrolled ?? true,
  });
}

function makeCannabisSession() {
  return createAuthSessionContext({
    userId: CFO_USER_ID,
    activeOrganizationId: ORG_CANNABIS,
    role: UserRole.ARCHITECT_CFO,
    activeOrganizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
    activeMemberships: [
      {
        membershipId: randomUUID(),
        organizationId: ORG_CANNABIS,
        organizationSlug: 'ORG_CANNABIS_NURSERY_PROC',
        organizationName: 'Cannabis Nursery & Processing (Brockville)',
        organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        role: UserRole.ARCHITECT_CFO,
        isDefaultWorkspace: false,
      },
    ],
    aal: 'aal2',
    mfaEnrolled: true,
  });
}

interface InMemoryStoreState {
  policyOverrides: Map<string, Record<string, unknown> | null>;
  locations: Map<string, LockedIntakeStorageLocation>;
  vehicles: Map<string, PersistVehicleRecord & { scrappedClearedAt: Date | null; soldAt: Date | null }>;
  expenses: Map<
    string,
    {
      id: string;
      organizationId: string;
      vehicleId: string | null;
      category: LockedExistingAcquisitionExpense['category'];
      amountOriginalMinor: number;
      currencyOriginal: CurrencyCode;
      amountCadMinor: number;
      itcReceivableCadMinor: number;
      paidFromCashCustody: CashCustodyState | null;
      loggedByUserId: string;
      isDeferredIntercompanyAccrual: boolean;
      accrualSettledAt: Date | null;
      receiptVerificationState: ReceiptVerificationState;
      receiptStorageKey: string | null;
      isReversalEntry: boolean;
      reversesExpenseId: string | null;
    }
  >;
  sales: Array<{
    id: string;
    organizationId: string;
    marketNode: SaleMarketNode;
    domesticChannel: 'EBAY_MOTORS_SHIPPED' | 'LOCAL_WALK_IN_CASH' | null;
    paymentCurrency: CurrencyCode;
    taxCollectionMode: TaxCollectionMode;
    subtotalMinor: number;
    taxOrVatMinor: number;
    buyerTaxRemittedByPlatformMinor: number | null;
    platformFeeMinor: number;
    shippingCostMinor: number;
    estimatedPlatformFeeTaxCadMinor: number;
    itcReceivableCadMinor: number;
    isFeeTaxInvoiceVerified: boolean;
    feeTaxInvoiceStorageKey: string | null;
    grossCollectedMinor: number;
    netRealizedCadMinor: number;
    paymentSettlementState: PaymentSettlementState;
    cashCustodyState: CashCustodyState;
    bankSettledAt: Date | null;
    bankDepositReference: string | null;
    soldByUserId: string;
    isVoidedOrReversed: boolean;
  }>;
  cashTransfers: Array<{
    id: string;
    organizationId: string;
    marketNode: SaleMarketNode;
    fromCustodyState: CashCustodyState;
    toCustodyState: CashCustodyState;
    currency: CurrencyCode;
    amountMinor: number;
    equivalentCadMinor: number;
    depositSlipStorageKey: string;
    recordedByUserId: string;
  }>;
  custodyEvents: Map<string, PersistInitialCustodyEventRecord>;
  auditLogs: PersistIntakeAuditLogRecord[];
}

function createInMemoryState(): InMemoryStoreState {
  const locations = new Map<string, LockedIntakeStorageLocation>([
    [
      'KEMP_ZONE_CONTAINER_PAD',
      {
        id: PHASE1A_SEED_IDS.locations.KEMP_ZONE_CONTAINER_PAD,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.ACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: 4,
        fullQrBarcode: 'KEMP_ZONE_CONTAINER_PAD',
      },
    ],
    [
      'RAMS-SHOP-R01-S01-B01',
      {
        id: PHASE1A_SEED_IDS.locations.RAMS_SHOP,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: true,
        maxActiveAssetCapacity: 8,
        fullQrBarcode: 'RAMS-SHOP-R01-S01-B01',
      },
    ],
    [
      'POSV-V01-R01-S01-B01',
      {
        id: PHASE1A_SEED_IDS.locations.POSV_VAULT,
        organizationId: ORG_SALVAGE,
        allowedOrgType: OrganizationType.SALVAGE_AND_EXPORT,
        locationOperationalStatus: LocationOperationalStatus.DORMANT_FUTURE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'POSV-V01-R01-S01-B01',
      },
    ],
    [
      'BROCK-PROP-R1-T2',
      {
        id: PHASE1A_SEED_IDS.locations.BROCK_PROP_R1_T2,
        organizationId: ORG_CANNABIS,
        allowedOrgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        locationOperationalStatus: LocationOperationalStatus.PROPOSED_INACTIVE,
        allowsWholeVehicleDismantling: false,
        maxActiveAssetCapacity: null,
        fullQrBarcode: 'BROCK-PROP-R1-T2',
      },
    ],
  ]);

  return {
    policyOverrides: new Map([[ORG_SALVAGE, null], [ORG_CANNABIS, null]]),
    locations,
    vehicles: new Map(),
    expenses: new Map(),
    sales: [],
    cashTransfers: [],
    custodyEvents: new Map(),
    auditLogs: [],
  };
}

function cloneState(state: InMemoryStoreState): InMemoryStoreState {
  return {
    policyOverrides: new Map(state.policyOverrides),
    locations: new Map(state.locations),
    vehicles: new Map(state.vehicles),
    expenses: new Map(state.expenses),
    sales: [...state.sales],
    cashTransfers: [...state.cashTransfers],
    custodyEvents: new Map(state.custodyEvents),
    auditLogs: [...state.auditLogs],
  };
}

function createFakeIntakeRepository(
  state: InMemoryStoreState,
): IntakeVehicleRepository {
  return {
    async withTenantTransaction<T>(
      _ctx: TenantExecutionContext,
      fn: (tx: IntakeVehicleTx) => Promise<T>,
    ): Promise<T> {
      const working = cloneState(state);

      const tx: IntakeVehicleTx = {
        async acquireOrganizationLock() {},

        async findIdempotentIntake(organizationId, idempotencyKey) {
          for (const ev of working.custodyEvents.values()) {
            if (
              ev.organizationId === organizationId &&
              ev.idempotencyKey === idempotencyKey
            ) {
              const intakeAudit = working.auditLogs.find(
                (a) =>
                  a.organizationId === organizationId &&
                  a.entityType === 'Vehicle' &&
                  a.entityId === ev.vehicleId &&
                  a.action === 'VEHICLE_INTAKEN',
              );
              if (intakeAudit) {
                return {
                  custodyEventId: ev.id,
                  vehicleId: ev.vehicleId,
                  auditAction: intakeAudit.action,
                  commandFingerprint:
                    (intakeAudit.nextState.commandFingerprint as string) ?? null,
                  intakeResult:
                    (intakeAudit.nextState.intakeResult as never) ?? null,
                };
              }
              const otherAudit = working.auditLogs.find(
                (a) => a.organizationId === organizationId && a.entityId === ev.id,
              );
              return {
                custodyEventId: ev.id,
                vehicleId: ev.vehicleId,
                auditAction: otherAudit?.action ?? null,
                commandFingerprint: null,
                intakeResult: null,
              };
            }
          }
          return null;
        },

        async readOrganizationPolicyRecord(organizationId) {
          if (!working.policyOverrides.has(organizationId)) {
            return null;
          }
          return {
            organizationId,
            policyConfigJson: working.policyOverrides.get(organizationId) ?? null,
          };
        },

        async findAndLockStorageLocationByBarcode(
          organizationId,
          fullQrBarcode,
        ) {
          const loc = working.locations.get(fullQrBarcode);
          if (!loc || loc.organizationId !== organizationId) {
            return null;
          }
          return loc;
        },

        async findAndLockAcquisitionExpenses(organizationId, expenseIds) {
          const out: LockedExistingAcquisitionExpense[] = [];
          for (const id of expenseIds) {
            const exp = working.expenses.get(id);
            if (!exp || exp.organizationId !== organizationId) {
              continue;
            }
            const hasReversal = [...working.expenses.values()].some(
              (r) =>
                r.organizationId === organizationId &&
                r.reversesExpenseId === exp.id,
            );
            const alreadyLinkedInAudit = working.auditLogs.some(
              (a) =>
                a.organizationId === organizationId &&
                a.entityType === 'Expense' &&
                a.entityId === exp.id &&
                a.action === 'EXPENSE_LINKED_TO_VEHICLE',
            );
            out.push({
              id: exp.id,
              organizationId: exp.organizationId,
              vehicleId: exp.vehicleId,
              category: exp.category,
              amountCadMinor: exp.amountCadMinor,
              currencyOriginal: exp.currencyOriginal,
              amountOriginalMinor: exp.amountOriginalMinor,
              itcReceivableCadMinor: exp.itcReceivableCadMinor,
              paidFromCashCustody: exp.paidFromCashCustody,
              isDeferredIntercompanyAccrual: exp.isDeferredIntercompanyAccrual,
              accrualSettledAt: exp.accrualSettledAt,
              isReversalEntry: exp.isReversalEntry,
              hasReversalEntry: hasReversal,
              alreadyLinkedInAudit,
            });
          }
          return out;
        },

        async countActiveVehiclesAtLocation(
          organizationId,
          storageLocationId,
        ) {
          let count = 0;
          for (const v of working.vehicles.values()) {
            if (
              v.organizationId === organizationId &&
              v.storageLocationId === storageLocationId &&
              v.lifecycleState !== 'PROPOSED_DEAL' &&
              v.lifecycleState !== 'SOLD_RETAIL_ONTARIO' &&
              v.lifecycleState !== 'SOLD_EXPORT_COD' &&
              v.lifecycleState !== 'SCRAPPED_METAL_CLEARED'
            ) {
              count += 1;
            }
          }
          return count;
        },

        async listActiveAutomobileElvCandidates(organizationId) {
          const out = [];
          for (const v of working.vehicles.values()) {
            if (
              v.organizationId === organizationId &&
              v.assetCategory === 'AUTOMOBILE' &&
              v.operationalLane === 'DISMANTLE_AND_EXPORT' &&
              v.lifecycleState !== 'PROPOSED_DEAL' &&
              v.lifecycleState !== 'SCRAPPED_METAL_CLEARED' &&
              v.lifecycleState !== 'SOLD_RETAIL_ONTARIO' &&
              v.lifecycleState !== 'SOLD_EXPORT_COD'
            ) {
              out.push({
                id: v.id,
                assetCategory: v.assetCategory,
                operationalLane: v.operationalLane,
                lifecycleState: v.lifecycleState,
              });
            }
          }
          return out;
        },

        async queryFinancialSnapshot(organizationId, policy) {
          const { computeSeparatedFinancialSnapshot } = await import(
            '@/core/domain'
          );
          return computeSeparatedFinancialSnapshot(
            {
              organizationId,
              tranches: policy.operationalGates.workingCapitalGate.tranches,
              sales: working.sales
                .filter((s) => s.organizationId === organizationId)
                .map((s) => ({
                  ...s,
                  gstHstTaxCadMinor:
                    s.marketNode === 'DOMESTIC_ORIGIN' &&
                    s.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
                      ? s.taxOrVatMinor
                      : 0,
                })),
              cashTransfers: working.cashTransfers.filter(
                (t) => t.organizationId === organizationId,
              ),
              expenses: [...working.expenses.values()].filter(
                (e) => e.organizationId === organizationId,
              ),
              priorPartnerDrawsCadMinor: 0,
            },
            policy,
          );
        },

        async insertVehicle(input) {
          for (const existing of working.vehicles.values()) {
            if (
              existing.vinOrHin === input.vinOrHin ||
              existing.internalStockNumber === input.internalStockNumber
            ) {
              const err = new Error('Unique constraint failed on vinOrHin');
              (err as { code?: string; meta?: { target?: string[] } }).code =
                'P2002';
              (err as { meta?: { target?: string[] } }).meta = {
                target: ['vinOrHin'],
              };
              throw err;
            }
          }
          working.vehicles.set(input.id, {
            ...input,
            scrappedClearedAt: null,
            soldAt: null,
          });
        },

        async insertExpenses(inputs: readonly PersistAcquisitionExpenseRecord[]) {
          for (const exp of inputs) {
            working.expenses.set(exp.id, {
              id: exp.id,
              organizationId: exp.organizationId,
              vehicleId: exp.vehicleId,
              category: exp.category,
              amountOriginalMinor: exp.amountOriginalMinor,
              currencyOriginal: exp.currencyOriginal,
              amountCadMinor: exp.amountCadMinor,
              itcReceivableCadMinor: exp.itcReceivableCadMinor,
              paidFromCashCustody: exp.paidFromCashCustody,
              loggedByUserId: exp.loggedByUserId,
              isDeferredIntercompanyAccrual: false,
              accrualSettledAt: null,
              receiptVerificationState: exp.receiptVerificationState,
              receiptStorageKey: exp.receiptStorageKey,
              isReversalEntry: false,
              reversesExpenseId: null,
            });
          }
        },

        async insertCustodyEvent(input) {
          for (const existing of working.custodyEvents.values()) {
            if (
              existing.organizationId === input.organizationId &&
              existing.idempotencyKey === input.idempotencyKey
            ) {
              const err = new Error(
                'Unique constraint failed on CustodyEvent_organizationId_idempotencyKey_key',
              );
              (err as { code?: string }).code = 'P2002';
              throw err;
            }
          }
          working.custodyEvents.set(input.id, input);
        },

        async insertAuditLog(input) {
          working.auditLogs.push(input);
        },

        async listVehicles(organizationId, filter) {
          const all = [...working.vehicles.values()]
            .filter((v) => v.organizationId === organizationId)
            .filter((v) => {
              if (filter.scope === 'STRIP_QUEUE_ONLY') {
                return (
                  v.operationalLane === 'DISMANTLE_AND_EXPORT' &&
                  (v.lifecycleState === 'STAGED_ONTARIO_YARD' ||
                    v.lifecycleState === 'DISMANTLING_IN_PROGRESS' ||
                    v.lifecycleState === 'HULK_AWAITING_SCRAP')
                );
              }
              if (filter.scope === 'EXPORTED_ONLY') {
                return (
                  v.operationalLane === 'WHOLE_UNIT_EXPORT' ||
                  v.lifecycleState === 'MANIFESTED_WHOLE_EXPORT' ||
                  v.lifecycleState === 'LANDED_TRINIDAD_VAULT' ||
                  v.lifecycleState === 'SOLD_EXPORT_COD'
                );
              }
              return true;
            })
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            )
            .slice(0, filter.limit);

          return all.map((v) => {
            const loc = [...working.locations.values()].find(
              (l) => l.id === v.storageLocationId,
            );
            return {
              id: v.id,
              internalStockNumber: v.internalStockNumber,
              assetCategory: v.assetCategory,
              vinOrHin: v.vinOrHin,
              year: v.year,
              make: v.make,
              model: v.model,
              trim: v.trim,
              engineSpec: v.engineSpec,
              exteriorColor: v.exteriorColor,
              steeringSide: v.steeringSide,
              roadBrand: v.roadBrand,
              operationalLane: v.operationalLane,
              lifecycleState: v.lifecycleState,
              availabilityState: v.availabilityState,
              storageLocationId: v.storageLocationId,
              destinationBarcode: loc?.fullQrBarcode ?? null,
              suggestedHsCode: v.suggestedHsCode,
              catalyticConverterDisposition: v.catalyticConverterDisposition,
              complianceWarnings: v.complianceWarnings,
              driveOnReinspectionDeadlineAt: v.driveOnReinspectionDeadlineAt,
              fluidsDrainedAt: v.fluidsDrainedAt,
              createdAt: v.createdAt,
            };
          });
        },

        async listHtaSection60AutomobileRows(organizationId) {
          return [...working.vehicles.values()]
            .filter(
              (v) =>
                v.organizationId === organizationId &&
                v.assetCategory === 'AUTOMOBILE' &&
                v.lifecycleState !== 'PROPOSED_DEAL',
            )
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            )
            .map((v) => ({
              internalStockNumber: v.internalStockNumber,
              vinOrHin: v.vinOrHin,
              year: v.year,
              make: v.make,
              model: v.model,
              exteriorColor: v.exteriorColor,
              createdAt: v.createdAt,
              acquisitionSource: v.acquisitionSource,
              sellerFullName: v.sellerFullName,
              sellerAddress: v.sellerAddress,
              ontarioPermitNumber: v.ontarioPermitNumber,
              declaredStatutoryPurpose: v.declaredStatutoryPurpose,
              catalyticConverterDisposition: v.catalyticConverterDisposition,
              lifecycleState: v.lifecycleState,
              scrappedClearedAt: v.scrappedClearedAt,
              soldAt: v.soldAt,
              complianceWarnings: v.complianceWarnings,
            }));
        },
      };

      const res = await fn(tx);
      // Commit working state back on success
      state.vehicles = working.vehicles;
      state.expenses = working.expenses;
      state.custodyEvents = working.custodyEvents;
      state.auditLogs = working.auditLogs;
      return res;
    },
  };
}

function makeAutoInput(
  overrides: Partial<Extract<IntakeVehicleInput, { assetCategory: 'AUTOMOBILE' }>> = {},
): Extract<IntakeVehicleInput, { assetCategory: 'AUTOMOBILE' }> {
  const purchase = overrides.actualPurchasePriceCadMinor ?? 150_000;
  return {
    assetCategory: 'AUTOMOBILE',
    vinOrHin: '5XYP5DHC5LG000001',
    destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
    operationalLane: 'DISMANTLE_AND_EXPORT',
    roadBrand: 'SALVAGE',
    acquisitionSource: 'LICENSED_AUCTION',
    declaredStatutoryPurpose: 'WRECKING_PARTS_ONLY',
    sellerFullName: 'IAAI Ontario Auto Auction',
    sellerAddress: '100 Auction Way, Ottawa, ON',
    ontarioPermitNumber: 'ON-P-10001',
    estimatedMaxBidCadMinor: 200_000,
    actualPurchasePriceCadMinor: purchase,
    estimatedRepairCadMinor: 0,
    paidAcquisitionComponents: [
      {
        category: 'AUCTION_PURCHASE_PRICE',
        vendorName: 'IAAI Ontario',
        amountCadMinor: purchase,
        paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
        receiptVerificationState: 'VERIFIED_RECEIPT',
        receiptStorageKey: `${ORG_SALVAGE}/evidence/${randomUUID()}`,
      },
    ],
    idempotencyKey: randomUUID(),
    deviceTimestamp: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('Issue 07: AssetDecoder, HTA s.60 Register, EASR #3+, Settlement-Confirmed Capital Gate & Parent Intake', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('Unexpected live HTTP fetch during offline tests!');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('AssetDecoderAdapter (Offline Fixtures & Mocked vPIC Fallback)', () => {
    it('decodes deterministic Kia, Hyundai, Mazda, Yamaha, and Equipment fixtures without live HTTP', async () => {
      const factory = createCategoryAssetDecoderFactory();

      const kia = await factory('AUTOMOBILE').decodeIdentifier('5xyp5dhc5lg000001');
      expect(kia).toMatchObject({
        identifier: '5XYP5DHC5LG000001',
        assetCategory: 'AUTOMOBILE',
        year: 2020,
        make: 'Kia',
        model: 'Telluride',
        steeringSide: 'LHD_ONLY',
      });

      const hyundai = await factory('AUTOMOBILE').decodeIdentifier('KM8J3CA41LU000001');
      expect(hyundai).toMatchObject({
        year: 2020,
        make: 'Hyundai',
        model: 'Tucson',
      });

      const mazda = await factory('AUTOMOBILE').decodeIdentifier('JM3KFBCM4L0000001');
      expect(mazda).toMatchObject({
        year: 2020,
        make: 'Mazda',
        model: 'CX-5',
      });

      const yamaha = await factory('WATERCRAFT').decodeIdentifier('yam12345a121');
      expect(yamaha).toMatchObject({
        identifier: 'YAM12345A121',
        assetCategory: 'WATERCRAFT',
        year: 2021,
        make: 'Yamaha',
        model: 'WaveRunner VX Cruiser HO',
        steeringSide: 'UNIVERSAL',
      });

      const equip = await factory('SHOP_EQUIPMENT').decodeIdentifier('ROB-AC1234-2022-001');
      expect(equip).toMatchObject({
        assetCategory: 'SHOP_EQUIPMENT',
        year: 2022,
        make: 'Robinair',
        model: 'AC1234-4',
        steeringSide: 'UNIVERSAL',
      });

      // Unknown lookup returns null and never touches fetch
      expect(
        await new OfflineAssetDecoderAdapter({ assetCategory: 'AUTOMOBILE' }).decodeIdentifier(
          '1HGCM82633A999999',
        ),
      ).toBeNull();

      // 17-char equipment serial bound as SHOP_EQUIPMENT never routes to VIN decoder
      const eqDecoder = new CompositeAssetDecoderAdapter({
        assetCategory: 'SHOP_EQUIPMENT',
        mode: 'LIVE_WITH_OFFLINE_FALLBACK',
        fetchFn: vi.fn(() => {
          throw new Error('SHOP_EQUIPMENT must never call vPIC');
        }) as unknown as typeof fetch,
      });
      expect(await eqDecoder.decodeIdentifier('5XYP5DHC5LG000001')).toBeNull();

      // Local HIN structural parser
      expect(parseWatercraftHin('YAM12345A121')).toEqual({
        hin: 'YAM12345A121',
        mic: 'YAM',
        hullSerial: '12345',
        manufactureMonthCode: 'A',
        manufactureYearDigit: 1,
        modelYear: 2021,
      });
    });

    it('uses injected vPIC transport in live mode and falls back once to offline fixtures on error/timeout/non-2xx', async () => {
      const okFetch = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toContain('DecodeVinValues/1HGCM82633A123456?format=json&modelyear=2021');
        return new Response(
          JSON.stringify({
            Results: [
              {
                ErrorCode: '0',
                Make: 'HONDA',
                Model: 'Accord',
                ModelYear: '2021',
                Trim: 'Sport',
                DisplacementL: '2.0',
                EngineCylinders: '4',
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const liveSuccess = await new CompositeAssetDecoderAdapter({
        assetCategory: 'AUTOMOBILE',
        mode: 'LIVE_WITH_OFFLINE_FALLBACK',
        fetchFn: okFetch,
      }).decodeIdentifier('1HGCM82633A123456', 2021);
      expect(liveSuccess).toMatchObject({
        year: 2021,
        make: 'HONDA',
        model: 'Accord',
        trim: 'Sport',
        engineSpec: '2.0L 4-Cyl',
        steeringSide: 'LHD_ONLY',
      });

      const failFetch = vi.fn(async () => new Response('Server Error', { status: 503 })) as unknown as typeof fetch;
      const fallbackKia = await new CompositeAssetDecoderAdapter({
        assetCategory: 'AUTOMOBILE',
        mode: 'LIVE_WITH_OFFLINE_FALLBACK',
        fetchFn: failFetch,
      }).decodeIdentifier('5XYP5DHC5LG000001');
      expect(fallbackKia).toMatchObject({ make: 'Kia', model: 'Telluride' });
    });
  });

  describe('Zoning, EASR #3+, HTA s.60 & Category Bypass', () => {
    it('stages Kia/Hyundai/Mazda donor SUVs at KEMP, handles RAMS PROPOSED_INACTIVE, undrained farm warning, and cross-tenant BROCK block', async () => {
      const state = createInMemoryState();
      const repo = createFakeIntakeRepository(state);
      const clockNow = new Date('2026-11-16T12:00:00.000Z');
      const useCase = new IntakeVehicleUseCase({
        repository: repo,
        decoderFactory: createCategoryAssetDecoderFactory(),
        clock: { now: () => clockNow },
      });
      const hunter = makeSalvageSession({ role: UserRole.HUNTER_MECHANIC });
      const cfo = makeSalvageSession({ role: UserRole.ARCHITECT_CFO });

      // 1. Undrained Kia at KEMP -> COMPLIANCE_WARNING_UNDRAINED_FARM
      const kiaRes = await useCase.execute(hunter, makeAutoInput());
      expect(kiaRes.replayed).toBe(false);
      expect(kiaRes.lifecycleState).toBe('STAGED_ONTARIO_YARD');
      expect(kiaRes.steeringSide).toBe('LHD_ONLY');
      expect(kiaRes.classifiedsSyncState).toBe('NOT_POSTED');
      expect(kiaRes.catalyticConverterDisposition).toBe('PRESENT_AT_INTAKE');
      expect(kiaRes.complianceWarnings).toEqual([
        'COMPLIANCE_WARNING_UNDRAINED_FARM',
      ]);
      expect(kiaRes.createdExpenseIds).toHaveLength(1);
      expect(state.custodyEvents.get(kiaRes.custodyEventId)).toMatchObject({
        fromLocationBarcode: null,
        toLocationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
        expectedVersion: 1,
        hasConflict: false,
      });

      // 2. Drained Hyundai at RAMS -> PROPOSED_INACTIVE_LOCATION_WARNING (no undrained warning because RAMS allows dismantling)
      const hyundaiRes = await useCase.execute(
        hunter,
        makeAutoInput({
          vinOrHin: 'KM8J3CA41LU000001',
          destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
          fluidsDrainedAt: '2026-11-16T11:00:00.000Z',
        }),
      );
      expect(hyundaiRes.complianceWarnings).toEqual([
        'PROPOSED_INACTIVE_LOCATION_WARNING',
      ]);

      // 3. Third active ELV (Mazda) with easrRegistrationNumber: null -> MISSING_EASR_REGISTRATION_WARNING
      const mazdaRes = await useCase.execute(
        hunter,
        makeAutoInput({
          vinOrHin: 'JM3KFBCM4L0000001',
          fluidsDrainedAt: '2026-11-16T11:30:00.000Z',
        }),
      );
      expect(mazdaRes.complianceWarnings).toEqual([
        'MISSING_EASR_REGISTRATION_WARNING',
      ]);

      // 4. Cross-tenant BROCK destination -> 422 SITE_ZONING_VIOLATION even with CFO override
      await expect(
        useCase.execute(
          cfo,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000099',
            year: 2020,
            make: 'Honda',
            model: 'Civic',
            destinationBarcode: 'BROCK-PROP-R1-T2',
            cfoOverride: { approved: true, reasonNote: 'Attempted cross-tenant' },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'SITE_ZONING_VIOLATION',
        status: 422,
      });

      // 5. Dormant POSV destination -> 422 LOCATION_DORMANT_INACTIVE even with CFO override
      await expect(
        useCase.execute(
          cfo,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000098',
            year: 2020,
            make: 'Honda',
            model: 'Civic',
            destinationBarcode: 'POSV-V01-R01-S01-B01',
            cfoOverride: { approved: true, reasonNote: 'Attempted dormant' },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'LOCATION_DORMANT_INACTIVE',
        status: 422,
      });
    });

    it('suppresses EASR warning when easrRegistrationNumber is populated, and blocks in STRICT_BLOCK mode', async () => {
      const state = createInMemoryState();
      const repo = createFakeIntakeRepository(state);
      const useCase = new IntakeVehicleUseCase({ repository: repo });
      const cfo = makeSalvageSession();

      // Seed 2 active ELVs
      await useCase.execute(
        cfo,
        makeAutoInput({
          vinOrHin: '5XYP5DHC5LG000001',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      await useCase.execute(
        cfo,
        makeAutoInput({
          vinOrHin: 'KM8J3CA41LU000001',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );

      // Populate EASR registration -> 3rd ELV succeeds with zero EASR warning
      state.policyOverrides.set(ORG_SALVAGE, {
        complianceThresholds: { easrRegistrationNumber: 'EASR-ON-2026-999' },
      });
      const withReg = await useCase.execute(
        cfo,
        makeAutoInput({
          vinOrHin: 'JM3KFBCM4L0000001',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      expect(withReg.complianceWarnings).toEqual([]);

      // Clear EASR registration and enable STRICT_BLOCK -> blocks 4th ELV with 422 EASR_REGISTRATION_REQUIRED
      state.policyOverrides.set(ORG_SALVAGE, {
        complianceThresholds: { easrRegistrationNumber: null },
        operationalGates: { complianceEnforcementMode: 'STRICT_BLOCK' },
      });
      await expect(
        useCase.execute(
          cfo,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000077',
            year: 2021,
            make: 'Honda',
            model: 'Accord',
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
            cfoOverride: {
              approved: true,
              reasonNote: 'CFO override cannot waive STRICT_BLOCK EASR',
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'EASR_REGISTRATION_REQUIRED',
        status: 422,
      });

      // STRICT_BLOCK also blocks RAMS PROPOSED_INACTIVE, undrained KEMP, and missing HTA s.60 docs
      state.policyOverrides.set(ORG_SALVAGE, {
        complianceThresholds: { easrRegistrationNumber: 'EASR-ON-2026-999' },
        operationalGates: { complianceEnforcementMode: 'STRICT_BLOCK' },
      });
      await expect(
        useCase.execute(
          cfo,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000078',
            year: 2021,
            make: 'Honda',
            model: 'Accord',
            destinationBarcode: 'RAMS-SHOP-R01-S01-B01',
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'LOCATION_PROPOSED_INACTIVE',
        status: 422,
      });
      await expect(
        useCase.execute(
          cfo,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000079',
            year: 2021,
            make: 'Honda',
            model: 'Accord',
            destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
            fluidsDrainedAt: null,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'ENVIRONMENTAL_ZONING_VIOLATION',
        status: 422,
      });
      await expect(
        useCase.execute(
          cfo,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000080',
            year: 2021,
            make: 'Honda',
            model: 'Accord',
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
            acquisitionSource: 'PRIVATE_DRIVEWAY_BUY',
            sellerPhotoIdStorageKey: null,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'MISSING_HTA_S60_DOCS',
        status: 422,
      });
    });

    it('applies HTA s.60 WARN_ONLY warning for missing docs and forces watercraft/equipment defaults & bypasses', async () => {
      const state = createInMemoryState();
      const repo = createFakeIntakeRepository(state);
      const useCase = new IntakeVehicleUseCase({ repository: repo });
      const hunter = makeSalvageSession({ role: UserRole.HUNTER_MECHANIC });

      // Private driveway buy missing seller photo ID -> MISSING_HTA_S60_DOCS warning
      const privAuto = await useCase.execute(
        hunter,
        makeAutoInput({
          acquisitionSource: 'PRIVATE_DRIVEWAY_BUY',
          sellerFullName: 'Jane Seller',
          ontarioPermitNumber: 'ON-9988',
          sellerPhotoIdStorageKey: null,
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      expect(privAuto.complianceWarnings).toEqual(['MISSING_HTA_S60_DOCS']);

      // Watercraft bypasses HTA s.60, EASR, and undrained-auto checks
      const watercraft = await useCase.execute(hunter, {
        assetCategory: 'WATERCRAFT',
        vinOrHin: 'YAM12345A121',
        destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
        operationalLane: 'WHOLE_UNIT_EXPORT',
        acquisitionSource: 'PRIVATE_DRIVEWAY_BUY',
        declaredStatutoryPurpose: 'EXPORT_WHOLE',
        estimatedMaxBidCadMinor: 250_000,
        actualPurchasePriceCadMinor: 200_000,
        paidAcquisitionComponents: [
          {
            category: 'AUCTION_PURCHASE_PRICE',
            vendorName: 'Private Marine Seller',
            amountCadMinor: 200_000,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
            voucherReason: 'Bill of sale queued',
          },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: '2026-11-16T10:00:00.000Z',
      });
      expect(watercraft.roadBrand).toBe('NOT_APPLICABLE');
      expect(watercraft.steeringSide).toBe('UNIVERSAL');
      expect(watercraft.suggestedHsCode).toBe('8903.99');
      expect(watercraft.complianceWarnings).toEqual([]);

      // Equipment forces 8479.89, UNIVERSAL, NOT_APPLICABLE
      const equip = await useCase.execute(hunter, {
        assetCategory: 'SHOP_EQUIPMENT',
        vinOrHin: 'ROB-AC1234-2022-001',
        destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
        operationalLane: 'WHOLE_UNIT_EXPORT',
        acquisitionSource: 'DEALER_WHOLESALE',
        declaredStatutoryPurpose: 'EXPORT_WHOLE',
        estimatedMaxBidCadMinor: 150_000,
        actualPurchasePriceCadMinor: 120_000,
        paidAcquisitionComponents: [
          {
            category: 'AUCTION_PURCHASE_PRICE',
            vendorName: 'Tool Distributor',
            amountCadMinor: 120_000,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
            voucherReason: 'Invoice pending scan',
          },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: '2026-11-16T10:00:00.000Z',
      });
      expect(equip.roadBrand).toBe('NOT_APPLICABLE');
      expect(equip.steeringSide).toBe('UNIVERSAL');
      expect(equip.suggestedHsCode).toBe('8479.89');
      expect(equip.complianceWarnings).toEqual([]);
    });
  });

  describe('Settlement-Confirmed Capital Gate (FIX 05), Donor Cap, Lane Pause, Capacity & 1-Tap cfoOverride', () => {
    it('enforces $7,500 reserve floor strictly against bank-settled cash and ignores pending eBay payouts, pending e-Transfers, and unswept float', async () => {
      const state = createInMemoryState();
      // Configure small initial seed capital ($9,000 = 900,000 cents) so boundary is exact
      state.policyOverrides.set(ORG_SALVAGE, {
        operationalGates: {
          workingCapitalGate: {
            totalCommittedLoanFacilityCadMinor: 900_000,
            initialSeedCapitalCadMinor: 900_000,
            tranches: [
              { trancheCode: 'TRANCHE_1_LAUNCH', principalCadMinor: 900_000, unlocked: true },
            ],
          },
        },
      });

      // Add huge pending eBay payout, pending Interac e-Transfer, and unswept operator float
      state.sales.push(
        {
          id: randomUUID(),
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'EBAY_MOTORS_SHIPPED',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
          subtotalMinor: 5_000_000,
          taxOrVatMinor: 0,
          buyerTaxRemittedByPlatformMinor: 650_000,
          platformFeeMinor: 662_500,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 86_125,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          grossCollectedMinor: 5_000_000,
          netRealizedCadMinor: 4_337_500,
          paymentSettlementState: 'MARKETPLACE_PAYOUT_PENDING',
          cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
          bankSettledAt: null,
          bankDepositReference: null,
          soldByUserId: HUNTER_USER_ID,
          isVoidedOrReversed: false,
        },
        {
          id: randomUUID(),
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
          subtotalMinor: 2_000_000,
          taxOrVatMinor: 0,
          buyerTaxRemittedByPlatformMinor: 0,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          grossCollectedMinor: 2_000_000,
          netRealizedCadMinor: 2_000_000,
          paymentSettlementState: 'BANK_SETTLEMENT_PENDING',
          cashCustodyState: 'PENDING_EXTERNAL_RECEIVABLE',
          bankSettledAt: null,
          bankDepositReference: null,
          soldByUserId: HUNTER_USER_ID,
          isVoidedOrReversed: false,
        },
        {
          id: randomUUID(),
          organizationId: ORG_SALVAGE,
          marketNode: 'DOMESTIC_ORIGIN',
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          paymentCurrency: 'CAD',
          taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
          subtotalMinor: 1_500_000,
          taxOrVatMinor: 0,
          buyerTaxRemittedByPlatformMinor: 0,
          platformFeeMinor: 0,
          shippingCostMinor: 0,
          estimatedPlatformFeeTaxCadMinor: 0,
          itcReceivableCadMinor: 0,
          isFeeTaxInvoiceVerified: false,
          feeTaxInvoiceStorageKey: null,
          grossCollectedMinor: 1_500_000,
          netRealizedCadMinor: 1_500_000,
          paymentSettlementState: 'PAYMENT_CONFIRMED',
          cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
          bankSettledAt: null,
          bankDepositReference: null,
          soldByUserId: HUNTER_USER_ID,
          isVoidedOrReversed: false,
        },
      );

      const repo = createFakeIntakeRepository(state);
      const useCase = new IntakeVehicleUseCase({ repository: repo });
      const hunter = makeSalvageSession({ role: UserRole.HUNTER_MECHANIC });
      const cfoAal2 = makeSalvageSession({ role: UserRole.ARCHITECT_CFO, aal: 'aal2' });
      const cfoAal1 = makeSalvageSession({ role: UserRole.ARCHITECT_CFO, aal: 'aal1' });

      // 150,001 cents outlay leaves 749,999 < 750,000 floor -> BLOCKED despite $85k+ pending/float
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            actualPurchasePriceCadMinor: 150_001,
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'WORKING_CAPITAL_RESERVE_BREACHED',
        status: 422,
      });

      // Exact boundary 150,000 cents leaves 750,000 == 750,000 -> ALLOWED
      const allowedAtBoundary = await useCase.execute(
        hunter,
        makeAutoInput({
          actualPurchasePriceCadMinor: 150_000,
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      expect(allowedAtBoundary.availableWorkingCapitalBeforeCadMinor).toBe(900_000);
      expect(allowedAtBoundary.projectedPostDealCapitalCadMinor).toBe(750_000);

      // Next intake sees bank balance reduced to 750,000 by the prior Expense!
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            vinOrHin: 'KM8J3CA41LU000001',
            actualPurchasePriceCadMinor: 100_000,
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'WORKING_CAPITAL_RESERVE_BREACHED',
        status: 422,
      });

      // Non-CFO or aal1 CFO cannot override
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            vinOrHin: 'KM8J3CA41LU000001',
            actualPurchasePriceCadMinor: 100_000,
            cfoOverride: { approved: true, reasonNote: 'Unauthorized' },
          }),
        ),
      ).rejects.toBeInstanceOf(AuthError);

      await expect(
        useCase.execute(
          cfoAal1,
          makeAutoInput({
            vinOrHin: 'KM8J3CA41LU000001',
            actualPurchasePriceCadMinor: 100_000,
            cfoOverride: { approved: true, reasonNote: 'Requires aal2' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'MFA_AAL2_REQUIRED', status: 403 });

      // Valid aal2 CFO override with reason succeeds and stamps override columns
      const overridden = await useCase.execute(
        cfoAal2,
        makeAutoInput({
          vinOrHin: 'KM8J3CA41LU000001',
          actualPurchasePriceCadMinor: 100_000,
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          cfoOverride: {
            approved: true,
            reasonNote: 'Approved winter donor inventory buy',
          },
        }),
      );
      expect(overridden.cfoOverrideApplied).toBe(true);
      expect(overridden.cfoGateApprovedById).toBe(CFO_USER_ID);
      expect(overridden.cfoGateOverrideReason).toBe(
        'Approved winter donor inventory buy',
      );
      expect(overridden.complianceWarnings).toContain(
        'WORKING_CAPITAL_RESERVE_BREACHED',
      );
    });

    it('enforces $3,200 donor cap, HIGH_END_REBUILD pause, KEMP 4-slot capacity, and existing acquisition Expense binding without double-debit', async () => {
      const state = createInMemoryState();
      const repo = createFakeIntakeRepository(state);
      const useCase = new IntakeVehicleUseCase({ repository: repo });
      const hunter = makeSalvageSession({ role: UserRole.HUNTER_MECHANIC });
      const cfo = makeSalvageSession({ role: UserRole.ARCHITECT_CFO });

      // $3,201 (320,100 cents) exceeds $3,200 donor cap
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            actualPurchasePriceCadMinor: 320_000,
            estimatedRepairCadMinor: 100,
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'DONOR_LANDED_CAP_EXCEEDED',
        status: 422,
      });

      // HIGH_END_REBUILD paused in Year 1
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            operationalLane: 'HIGH_END_REBUILD',
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'HIGH_END_REBUILD_LANE_PAUSED',
        status: 422,
      });

      // Pre-posted existing acquisition expense (already deducted from snapshot)
      const preExpId = randomUUID();
      state.expenses.set(preExpId, {
        id: preExpId,
        organizationId: ORG_SALVAGE,
        vehicleId: null,
        category: 'AUCTION_PURCHASE_PRICE',
        amountOriginalMinor: 180_000,
        currencyOriginal: 'CAD',
        amountCadMinor: 180_000,
        itcReceivableCadMinor: 0,
        paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
        loggedByUserId: CFO_USER_ID,
        isDeferredIntercompanyAccrual: false,
        accrualSettledAt: null,
        receiptVerificationState: 'VERIFIED_RECEIPT',
        receiptStorageKey: `${ORG_SALVAGE}/evidence/${randomUUID()}`,
        isReversalEntry: false,
        reversesExpenseId: null,
      });

      const linkedRes = await useCase.execute(
        hunter,
        makeAutoInput({
          vinOrHin: '5XYP5DHC5LG000001',
          actualPurchasePriceCadMinor: 180_000,
          paidAcquisitionComponents: [],
          existingAcquisitionExpenseIds: [preExpId],
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      expect(linkedRes.linkedExpenseIds).toEqual([preExpId]);
      expect(linkedRes.createdExpenseIds).toEqual([]);
      // Re-using same existing expense ID for a 2nd vehicle fails with 409 EXPENSE_ALREADY_LINKED
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            vinOrHin: 'KM8J3CA41LU000001',
            actualPurchasePriceCadMinor: 180_000,
            paidAcquisitionComponents: [],
            existingAcquisitionExpenseIds: [preExpId],
          }),
        ),
      ).rejects.toMatchObject({
        code: 'EXPENSE_ALREADY_LINKED',
        status: 409,
      });

      // Fill remaining 3 KEMP pad slots (total 4), then verify 5th blocks unless CFO overrides
      await useCase.execute(
        hunter,
        makeAutoInput({
          vinOrHin: 'KM8J3CA41LU000001',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      await useCase.execute(
        hunter,
        makeAutoInput({
          vinOrHin: 'JM3KFBCM4L0000001',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );
      await useCase.execute(
        hunter,
        makeAutoInput({
          vinOrHin: '1HGCM82633A000004',
          year: 2019,
          make: 'Honda',
          model: 'Civic',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
        }),
      );

      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            vinOrHin: '1HGCM82633A000005',
            year: 2019,
            make: 'Honda',
            model: 'Accord',
            fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'LOCATION_CAPACITY_EXCEEDED',
        status: 422,
      });

      const capOverride = await useCase.execute(
        cfo,
        makeAutoInput({
          vinOrHin: '1HGCM82633A000005',
          year: 2019,
          make: 'Honda',
          model: 'Accord',
          fluidsDrainedAt: '2026-11-16T10:00:00.000Z',
          cfoOverride: {
            approved: true,
            reasonNote: 'Temporary pad overflow authorized',
          },
        }),
      );
      expect(capOverride.cfoOverrideApplied).toBe(true);
      expect(capOverride.complianceWarnings).toContain('LOCATION_CAPACITY_EXCEEDED');
    });
  });

  describe('DriveON 10-Day Timer, Idempotency, HTA s.60 Register, RBAC & HTTP Route', () => {
    it('computes exact DriveON 10-day deadline, handles idempotent replay & 409 conflicts, and enforces RBAC + CSV formula safety', async () => {
      const state = createInMemoryState();
      const repo = createFakeIntakeRepository(state);
      const useCase = new IntakeVehicleUseCase({ repository: repo });
      const cfo = makeSalvageSession({ role: UserRole.ARCHITECT_CFO });
      const hunter = makeSalvageSession({ role: UserRole.HUNTER_MECHANIC });
      const stripper = makeSalvageSession({ role: UserRole.ONTARIO_STRIPPER });
      const vaultAdmin = makeSalvageSession({ role: UserRole.TRINIDAD_VAULT_ADMIN });

      const idempKey = randomUUID();
      const failSheetKey = `${ORG_SALVAGE}/evidence/${randomUUID()}`;
      const input = makeAutoInput({
        idempotencyKey: idempKey,
        sellerFullName: '=CMD("calc")',
        sellerAddress: '123 Main St, Kemptville, ON',
        driveOnInitialFailAt: '2026-11-10T15:30:00.000Z',
        driveOnFailSheetStorageKey: failSheetKey,
        fluidsDrainedAt: '2026-11-10T16:00:00.000Z',
      });

      // POST via HTTP handler -> 201
      const postReq1 = new Request('http://localhost/api/salvage/vehicles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify(input),
      });
      const res1 = await handleSalvageVehiclesPost(postReq1, {
        resolveSession: async () => hunter,
        useCase,
      });
      expect(res1.status).toBe(201);
      expect(res1.headers.get('Cache-Control')).toContain('no-store');
      const body1 = (await res1.json()) as {
        vehicleId: string;
        replayed: boolean;
        driveOnReinspectionDeadlineAt: string;
      };
      expect(body1.replayed).toBe(false);
      expect(body1.driveOnReinspectionDeadlineAt).toBe(
        '2026-11-20T15:30:00.000Z',
      );

      // Replay exact same command -> 200 with replayed=true, zero duplicate vehicles/expenses
      const postReq2 = new Request('http://localhost/api/salvage/vehicles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify(input),
      });
      const res2 = await handleSalvageVehiclesPost(postReq2, {
        resolveSession: async () => hunter,
        useCase,
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { vehicleId: string; replayed: boolean };
      expect(body2.replayed).toBe(true);
      expect(body2.vehicleId).toBe(body1.vehicleId);
      expect(state.vehicles.size).toBe(1);

      // Same idempotencyKey with altered payload -> 409 IDEMPOTENCY_KEY_REUSED
      const postReqConflict = new Request('http://localhost/api/salvage/vehicles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
        },
        body: JSON.stringify({ ...input, actualPurchasePriceCadMinor: 160_000 }),
      });
      const resConflict = await handleSalvageVehiclesPost(postReqConflict, {
        resolveSession: async () => hunter,
        useCase,
      });
      expect(resConflict.status).toBe(409);

      // Also intake a watercraft so we prove register excludes non-autos
      await useCase.execute(hunter, {
        assetCategory: 'WATERCRAFT',
        vinOrHin: 'YAM12345A121',
        destinationBarcode: 'KEMP_ZONE_CONTAINER_PAD',
        operationalLane: 'WHOLE_UNIT_EXPORT',
        acquisitionSource: 'PRIVATE_DRIVEWAY_BUY',
        declaredStatutoryPurpose: 'EXPORT_WHOLE',
        estimatedMaxBidCadMinor: 250_000,
        actualPurchasePriceCadMinor: 200_000,
        paidAcquisitionComponents: [
          {
            category: 'AUCTION_PURCHASE_PRICE',
            vendorName: 'Marine Seller',
            amountCadMinor: 200_000,
            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
            voucherReason: 'Marine bill of sale queued',
          },
        ],
        idempotencyKey: randomUUID(),
        deviceTimestamp: '2026-11-16T10:00:00.000Z',
      });

      // HTA s.60 Register CSV (CFO only, formula-safe, excludes watercraft, omits private storage keys)
      const csvRes = await handleSalvageVehiclesGet(
        new Request('http://localhost/api/salvage/vehicles?view=hta-s60-register&format=csv'),
        { resolveSession: async () => cfo, useCase },
      );
      expect(csvRes.status).toBe(200);
      expect(csvRes.headers.get('Content-Type')).toContain('text/csv');
      const csvText = await csvRes.text();
      expect(csvText).toContain(`"'=CMD(""calc"")"`);
      expect(csvText).not.toContain('YAM12345A121');
      expect(csvText).not.toContain(failSheetKey);

      // HUNTER_MECHANIC denied GET register & GET list (403)
      const hunterGet = await handleSalvageVehiclesGet(
        new Request('http://localhost/api/salvage/vehicles?view=hta-s60-register'),
        { resolveSession: async () => hunter, useCase },
      );
      expect(hunterGet.status).toBe(403);

      // ONTARIO_STRIPPER gets STRIP_QUEUE_ONLY without seller identity fields
      const stripperList = await handleSalvageVehiclesGet(
        new Request('http://localhost/api/salvage/vehicles'),
        { resolveSession: async () => stripper, useCase },
      );
      expect(stripperList.status).toBe(200);
      const stripperBody = (await stripperList.json()) as {
        scope: string;
        vehicles: Array<Record<string, unknown>>;
      };
      expect(stripperBody.scope).toBe('STRIP_QUEUE_ONLY');
      expect(stripperBody.vehicles).toHaveLength(1);
      expect(stripperBody.vehicles[0]).not.toHaveProperty('sellerFullName');

      // TRINIDAD_VAULT_ADMIN gets EXPORTED_ONLY (watercraft in WHOLE_UNIT_EXPORT)
      const vaultList = await handleSalvageVehiclesGet(
        new Request('http://localhost/api/salvage/vehicles'),
        { resolveSession: async () => vaultAdmin, useCase },
      );
      expect(vaultList.status).toBe(200);
      const vaultBody = (await vaultList.json()) as {
        scope: string;
        vehicles: Array<Record<string, unknown>>;
      };
      expect(vaultBody.scope).toBe('EXPORTED_ONLY');
      expect(vaultBody.vehicles).toHaveLength(1);
      expect(vaultBody.vehicles[0]?.vinOrHin).toBe('YAM12345A121');

      // Cannabis org session cannot invoke salvage endpoint (403)
      const cannabisIdempKey = randomUUID();
      const cannabisPost = await handleSalvageVehiclesPost(
        new Request('http://localhost/api/salvage/vehicles', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': cannabisIdempKey,
          },
          body: JSON.stringify(makeAutoInput({ idempotencyKey: cannabisIdempKey })),
        }),
        { resolveSession: async () => makeCannabisSession(), useCase },
      );
      expect(cannabisPost.status).toBe(403);
    });

    it('rejects spoofed client fields and public media URLs used as private evidence keys', async () => {
      const state = createInMemoryState();
      const repo = createFakeIntakeRepository(state);
      const useCase = new IntakeVehicleUseCase({ repository: repo });
      const hunter = makeSalvageSession({ role: UserRole.HUNTER_MECHANIC });

      // Spoofed organizationId / availableWorkingCapitalCadMinor rejected with 400
      await expect(
        useCase.execute(hunter, {
          ...makeAutoInput(),
          organizationId: ORG_CANNABIS,
        } as unknown as IntakeVehicleInput),
      ).rejects.toBeInstanceOf(VehicleIntakeError);

      // Public media key rejected with 403 StorageError
      await expect(
        useCase.execute(
          hunter,
          makeAutoInput({
            sellerPhotoIdStorageKey: `${ORG_SALVAGE}/media/${randomUUID()}.webp`,
          }),
        ),
      ).rejects.toBeInstanceOf(StorageError);
    });

    it('composes production use case and querySeparatedFinancialSnapshot against mock Prisma transaction client', async () => {
      const mockTx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = strings.join('?');
          if (sql.includes('current_org_id')) {
            return [{ orgId: ORG_SALVAGE }];
          }
          if (sql.includes('pg_advisory_xact_lock')) {
            return [{ locked: '1' }];
          }
          return [];
        }),
        custodyEvent: { findFirst: vi.fn(async () => null) },
        organization: {
          findUnique: vi.fn(async () => ({
            id: ORG_SALVAGE,
            policyConfigJson: null,
          })),
        },
        saleTransaction: { findMany: vi.fn(async () => []) },
        scrapComponentLog: { findMany: vi.fn(async () => []) },
        cashCustodyTransfer: { findMany: vi.fn(async () => []) },
        currencySettlement: { findMany: vi.fn(async () => []) },
        expense: { findMany: vi.fn(async () => []) },
      } as unknown as Prisma.TransactionClient;

      const snapshot = await querySeparatedFinancialSnapshot(
        mockTx,
        ORG_SALVAGE,
        baselinePolicyJson as never,
      );
      expect(snapshot.availableWorkingCapitalCadMinor).toBe(2_200_000);

      const mockPrisma = {
        $transaction: vi.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          fn(mockTx),
        ),
      } as unknown as PrismaClient;

      const prodUseCase = createProductionIntakeVehicleUseCase({
        prisma: mockPrisma,
      });
      expect(prodUseCase).toBeInstanceOf(IntakeVehicleUseCase);

      // Calling execute hits real Prisma tx wrapper and fails closed on missing destination
      await expect(
        prodUseCase.execute(makeSalvageSession(), makeAutoInput()),
      ).rejects.toBeInstanceOf(LocationCustodyError);
    });
  });
});
