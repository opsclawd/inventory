import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PART_CATEGORY_HS_CODE_DEFAULTS,
  PART_CATEGORY_STEERING_SIDE_DEFAULTS,
  PART_CATEGORY_TDG_HAZMAT_DEFAULTS,
} from '@/core/config/policy-loader';
import { DomainRuleError } from '@/core/domain';
import {
  buildPersistedLedgerProjection,
} from '@/modules/cfo-subledger/financial-snapshot.query';
import {
  handleDomesticCheckoutGet,
  handleDomesticCheckoutPatch,
  handleDomesticCheckoutPost,
} from '@/modules/logistics-vault/checkout/domestic-checkout-route.handler';
import { createProductionDomesticCheckoutUseCase } from '@/modules/logistics-vault/checkout/domestic-checkout.repository';
import { AuthError } from '@/modules/shared-ops/auth';
import {
  getAllPolicyCanonicalCategoryKeys,
  lookupEbayListingCategory,
  SELLER_HUB_CSV_HEADERS,
} from '../ebay-listing-metadata';
import {
  resolvePartCompatibility,
  resolvePartPrice,
  resolvePartPublicMediaUrls,
  resolveVehiclePrice,
} from '../syndication-input-resolver';
import {
  handleEbayCsvGet,
  handleEbayCsvPatch,
  handleEbayCsvPost,
  handleLocalAdPayloadGet,
  handleLocalAdPayloadPatch,
} from '../syndication-route.handler';
import { SyndicationError } from '../syndication.contracts';
import {
  createProductionEbayCsvExporterUseCase,
  createProductionLocalClassifiedsQueueUseCase,
} from '../syndication.repository';
import { SyndicationTemplateService } from '../syndication-template.service';
import {
  BASELINE_ISSUE10_POLICY,
  HARNESS_IDS,
  Issue10OfflineTestHarness,
} from '../syndication-test-harness';

function splitCsvLines(csv: string): string[] {
  return csv.trimEnd().split(/\r?\n/);
}

describe('Issue #10 — Offline Domain, Resolvers, Syndication & Domestic Checkout', () => {
  let harness: Issue10OfflineTestHarness;

  beforeEach(() => {
    harness = new Issue10OfflineTestHarness();
  });

  describe('Finding 1: Unified Price Resolution Precedence & Grade Fallbacks', () => {
    it('resolves Issue #8 stripped part with retailPriceCadMinor=null & compBaselineCadMinor=20000 across all canonical ARA grades', () => {
      const policy = BASELINE_ISSUE10_POLICY;

      // Exact witness from Issue #10 Finding 1: Grade B1 on 20000 minor = 20000
      const b1 = resolvePartPrice(
        {
          araGrade: 'B1',
          compBaselineCadMinor: 20_000,
          retailPriceCadMinor: null,
        },
        policy,
      );
      expect(b1.source).toBe('GRADE_ADJUSTED_COMPARABLE');
      expect(b1.amountCadMinor).toBe(20_000);

      for (const grade of [
        'GRADE_A',
        'GRADE_B1',
        'GRADE_B2',
        'GRADE_B3',
        'GRADE_C',
        'GRADE_X',
      ] as const) {
        const res = resolvePartPrice(
          {
            araGrade: grade,
            compBaselineCadMinor: 200_000,
            retailPriceCadMinor: null,
          },
          policy,
        );
        expect(res.source).toBe('GRADE_ADJUSTED_COMPARABLE');
        expect(res.amountCadMinor).toBeGreaterThan(0);
      }

      // Explicit retailPriceCadMinor always takes strict precedence over compBaselineCadMinor
      const explicit = resolvePartPrice(
        {
          araGrade: 'GRADE_A',
          compBaselineCadMinor: 16_000,
          retailPriceCadMinor: 14_500,
        },
        policy,
      );
      expect(explicit.source).toBe('EXPLICIT_PART_RETAIL');
      expect(explicit.amountCadMinor).toBe(14_500);

      // Missing both throws DomainRuleError
      expect(() =>
        resolvePartPrice(
          {
            araGrade: 'GRADE_A',
            compBaselineCadMinor: null,
            retailPriceCadMinor: null,
          },
          policy,
        ),
      ).toThrowError(DomainRuleError);
    });

    it('resolves retail vehicle floor from targetGrossRealizationMinor or falls back to cost + minBeaterNetProfitCadMinor', () => {
      const policy = BASELINE_ISSUE10_POLICY;
      const targetVeh = harness.store.vehicles.get(HARNESS_IDS.vehicles.RETAIL_CAR)!;
      const resolvedTarget = resolveVehiclePrice(targetVeh, policy);
      expect(resolvedTarget.source).toBe('VEHICLE_TARGET');
      expect(resolvedTarget.amountCadMinor).toBe(850_000);

      const costPlusVeh = harness.store.vehicles.get(
        HARNESS_IDS.vehicles.RETAIL_POWERSPORTS,
      )!;
      const resolvedCostPlus = resolveVehiclePrice(costPlusVeh, policy);
      expect(resolvedCostPlus.source).toBe('VEHICLE_COST_PLUS_MIN_PROFIT');
      expect(resolvedCostPlus.amountCadMinor).toBe(
        300_000 +
          50_000 +
          policy.marginsAndCommissions.minBeaterNetProfitCadMinor,
      );
    });
  });

  describe('Finding 2: Public Media Sanitization & Issue #8 rawPhotoUrls Fallback', () => {
    const orgId = HARNESS_IDS.orgs.SALVAGE;

    it('prefers cleanPhotoUrls strictly when populated, falls back to rawPhotoUrls when empty, and rejects unsafe/foreign/evidence/raw-JPEG URLs', () => {
      const origin = 'https://cdn.salvage-erp.local';

      // Prefers whole cleanPhotoUrls array when non-empty
      const cleanWin = resolvePartPublicMediaUrls({
        organizationId: orgId,
        qrSkuCode: 'PRT-884920',
        rawPhotoUrls: [
          `${origin}/${orgId}/media/11111111-1111-4111-8111-111111111111.webp`,
        ],
        cleanPhotoUrls: [
          `${origin}/${orgId}/parts/PRT-884920/clean-1.webp`,
        ],
        publicMediaOrigin: origin,
      });
      expect(cleanWin.sourceArray).toBe('CLEAN_PHOTO_URLS');
      expect(cleanWin.sanitizedPublicImageUrls).toEqual([
        `${origin}/${orgId}/parts/PRT-884920/clean-1.webp`,
      ]);

      // Reads Issue #8 rawPhotoUrls canonical key when cleanPhotoUrls is []
      const rawFallback = resolvePartPublicMediaUrls({
        organizationId: orgId,
        qrSkuCode: 'PRT-884923',
        rawPhotoUrls: [
          `${origin}/${orgId}/media/99999999-3333-4333-8333-333333333333.webp`,
        ],
        cleanPhotoUrls: [],
        publicMediaOrigin: origin,
      });
      expect(rawFallback.sourceArray).toBe('RAW_PHOTO_URLS');
      expect(rawFallback.classification).toBe('CANONICAL_SANITIZED_WEBP');
      expect(rawFallback.sanitizedPublicImageUrls).toHaveLength(1);

      // Fail-closed checks
      const badInputs = [
        `http://cdn.salvage-erp.local/${orgId}/media/99999999-3333-4333-8333-333333333333.webp`,
        `https://evil.example/${orgId}/media/99999999-3333-4333-8333-333333333333.webp`,
        `${origin}/${HARNESS_IDS.orgs.CANNABIS}/media/99999999-3333-4333-8333-333333333333.webp`,
        `${origin}/${orgId}/evidence/99999999-3333-4333-8333-333333333333`,
        `${origin}/${orgId}/parts/PRT-999999/clean-1.webp`,
        `${origin}/${orgId}/media/raw.jpg`,
        `${origin}/${orgId}/media/99999999-3333-4333-8333-333333333333.webp?token=secret`,
      ];
      for (const bad of badInputs) {
        expect(() =>
          resolvePartPublicMediaUrls({
            organizationId: orgId,
            qrSkuCode: 'PRT-884923',
            rawPhotoUrls: [bad],
            cleanPhotoUrls: [],
            publicMediaOrigin: origin,
          }),
        ).toThrowError(DomainRuleError);
      }
    });
  });

  describe('Finding 3: Complete Category Coverage, Fixture Header Parity & Compatibility Rows', () => {
    it('covers 100% of canonical category keys across steering/TDG/HS maps and keeps Seller Hub Category distinct from HS codes', () => {
      const unionKeys = new Set([
        ...Object.keys(PART_CATEGORY_STEERING_SIDE_DEFAULTS),
        ...Object.keys(PART_CATEGORY_TDG_HAZMAT_DEFAULTS),
        ...Object.keys(PART_CATEGORY_HS_CODE_DEFAULTS),
      ]);
      const allCanonical = getAllPolicyCanonicalCategoryKeys();
      for (const category of unionKeys) {
        expect(allCanonical).toContain(category);
        const meta = lookupEbayListingCategory(category);
        expect(meta.ebayCategoryId).toMatch(/^\d+$/);
        expect(meta.ebayCategoryId).not.toContain('.');
        expect(meta.conditionId).toBe('3000');
      }
    });

    it('matches pinned Seller Hub Canada CSV fixture headers, emits Relationship=Compatibility child rows cleanly, and restricts masking vs true ship-from', () => {
      const fixturePath = join(
        process.cwd(),
        'src/modules/marketplace/syndication/__tests__/fixtures/seller-hub-canada.csv',
      );
      const fixtureLines = splitCsvLines(readFileSync(fixturePath, 'utf8'));
      const service = new SyndicationTemplateService();
      const alt = harness.store.parts.get(HARNESS_IDS.parts.ALTERNATOR)!;
      const crv = harness.store.vehicles.get(HARNESS_IDS.vehicles.CRV_DONOR)!;

      const copy = service.buildPartSyndicationCopy({
        qrSkuCode: alt.qrSkuCode,
        partCategoryName: alt.partCategoryName,
        oemPartNumbers: alt.oemPartNumbers,
        araGrade: 'GRADE_A',
        araDamageCode: '00-00',
        weightKg: alt.weightKg,
        tdgHazmatCode: 'NONE',
        retailPriceCadMinor: 14_500,
        sanitizedPublicImageUrls: alt.cleanPhotoUrls,
        donorVehicle: {
          year: crv.year,
          make: crv.make,
          model: crv.model,
          trim: crv.trim,
          engineSpec: crv.engineSpec,
          vinOrHin: crv.vinOrHin,
          odometerKm: crv.odometerKm,
          engineHours: crv.engineHours,
        },
        publicPickupLocationLabel: 'Ottawa South / Hwy 416 Corridor',
        ebayShipFromCity: 'Kemptville, ON',
        ebayShipFromPostalCode: 'K0G 1J0',
        heavyLocalOnlyThresholdKg: 15.0,
      });

      expect([...copy.ebaySeoTitle80].length).toBeLessThanOrEqual(80);
      expect(copy.ebaySeoTitle80).not.toContain('<script');
      expect(copy.ebayHtmlDescription).not.toContain('Ottawa South');
      expect(copy.localClassifiedsBody).toContain(
        'Ottawa South / Hwy 416 Corridor',
      );
      expect(copy.localClassifiedsBody).not.toContain('K0G 1J0');

      const compat = resolvePartCompatibility({
        ebayCompatibilityJson: [
          {
            yearStart: 2017,
            yearEnd: 2019,
            make: 'Honda',
            model: 'CR-V',
            trim: 'EX-L AWD',
            engine: '1.5L L4 Turbo',
          },
        ],
        donorVehicle: {
          id: crv.id,
          assetCategory: crv.assetCategory,
          year: crv.year,
          make: crv.make,
          model: crv.model,
          trim: crv.trim,
          engineSpec: crv.engineSpec,
        },
      });
      expect(compat.compatibleVehicles).toHaveLength(3);

      const csv = service.exportEbaySellerHubCsv(
        [
          {
            qrSkuCode: alt.qrSkuCode,
            ebaySeoTitle80: copy.ebaySeoTitle80,
            ebayHtmlDescription: copy.ebayHtmlDescription,
            partCategoryName: alt.partCategoryName,
            oemPartNumbers: alt.oemPartNumbers,
            araGrade: 'GRADE_A',
            tdgHazmatCode: 'NONE',
            retailPriceCadMinor: 14_500,
            sanitizedPublicImageUrls: alt.cleanPhotoUrls,
            make: crv.make,
            compatibleVehicles: [...compat.compatibleVehicles],
          },
        ],
        { city: 'Kemptville, ON', postalCode: 'K0G 1J0' },
      );

      const csvLines = splitCsvLines(csv);
      expect(csvLines[0]).toBe(fixtureLines[0]);
      expect(csvLines[0]).toBe([...SELLER_HUB_CSV_HEADERS].join(','));
      expect(csvLines[1]).toContain('PRT-884920');
      expect(csvLines[1]).toContain('Kemptville, ON');
      expect(csvLines[1]).toContain('K0G 1J0');
      expect(csvLines[2]).toContain('Compatibility');
      expect(csvLines[2]).toContain('Year=2017|Make=Honda|Model=CR-V');

      // Non-automobile donor without explicit ebayCompatibilityJson omits compatibility child rows
      const marineFitment = resolvePartCompatibility({
        ebayCompatibilityJson: null,
        donorVehicle: {
          id: HARNESS_IDS.vehicles.SEADOO_DONOR,
          assetCategory: 'WATERCRAFT',
          year: 2019,
          make: 'Sea-Doo',
          model: 'GTX 230',
          trim: 'Wake Pro',
          engineSpec: '1630cc Rotax',
        },
      });
      expect(marineFitment.source).toBe('NON_AUTOMOBILE_NO_COMPATIBILITY');
      expect(marineFitment.compatibleVehicles).toEqual([]);

      // Delimiter characters inside compatibility tuple are rejected
      expect(() =>
        resolvePartCompatibility({
          ebayCompatibilityJson: null,
          donorVehicle: {
            id: crv.id,
            assetCategory: 'AUTOMOBILE',
            year: 2018,
            make: 'Honda|Bad',
            model: 'CR-V',
            trim: null,
            engineSpec: null,
          },
        }),
      ).toThrowError(DomainRuleError);

      // TDG hazmat parcel export throws 422 HAZMAT_PARCEL_SHIPPING_BLOCKED
      expect(() =>
        service.exportEbaySellerHubCsv(
          [
            {
              qrSkuCode: 'PRT-884925',
              ebaySeoTitle80: 'Battery Pack',
              ebayHtmlDescription: '<p>Battery</p>',
              partCategoryName: 'Lead-Acid Wet Battery',
              oemPartNumbers: ['31500-TLA-100'],
              araGrade: 'GRADE_A',
              tdgHazmatCode: 'UN2794_WET_BATTERY',
              retailPriceCadMinor: 16_000,
              sanitizedPublicImageUrls: [],
              make: 'Honda',
              compatibleVehicles: [],
            },
          ],
          { city: 'Kemptville, ON', postalCode: 'K0G 1J0' },
        ),
      ).toThrowError(DomainRuleError);
    });
  });

  describe('FR-MKT-00: Two-Step eBay CSV, Confirmation, B2B Powertrain & Local Classifieds Queue', () => {
    it('runs preview (read-only), export commit, idempotency replay/conflict, confirmEbayListingLive, B2B sheet, and local classifieds queue', async () => {
      const { ebayExporter, localQueue } = harness.createUseCases();
      const cfo = harness.makeSession();
      const hunter = harness.makeSession({
        userId: HARNESS_IDS.users.HUNTER,
        role: 'HUNTER_MECHANIC',
      });

      const preview = await ebayExporter.previewEbaySellerHubCsv(hunter);
      expect(preview.persistedMutation).toBe(false);
      expect(preview.eligibleSkus).toContain('PRT-884920');
      expect(preview.eligibleSkus).toContain('PRT-884924');
      expect(preview.eligibleSkus).not.toContain('PRT-884922');
      expect(preview.eligibleSkus).not.toContain('PRT-884925');
      expect(preview.eligibleSkus).not.toContain('PRT-884923');

      const exportKey = '11111111-1111-4111-8111-111111111111';
      await expect(
        ebayExporter.exportEbaySellerHubCsv(hunter, {
          idempotencyKey: exportKey,
        }),
      ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', status: 403 });

      const exported = await ebayExporter.exportEbaySellerHubCsv(cfo, {
        idempotencyKey: exportKey,
      });
      if (exported.format !== 'EBAY_CSV') {
        throw new Error('Expected EBAY_CSV export result.');
      }
      expect(exported.exportedSkus).toContain('PRT-884920');
      expect(exported.csvContent).toContain('Kemptville, ON');
      expect(exported.csvContent).not.toContain('Ottawa South');

      // Replay with same key & payload returns exact receipt without re-mutating
      const replayed = await ebayExporter.exportEbaySellerHubCsv(cfo, {
        idempotencyKey: exportKey,
      });
      if (replayed.format !== 'EBAY_CSV') {
        throw new Error('Expected EBAY_CSV replay result.');
      }
      expect(replayed.exportId).toBe(exported.exportId);

      // Reusing same key with different payload rejects with 409 IDEMPOTENCY_KEY_REUSED
      await expect(
        ebayExporter.exportEbaySellerHubCsv(cfo, {
          partIds: [HARNESS_IDS.parts.ALTERNATOR],
          idempotencyKey: exportKey,
        }),
      ).rejects.toThrowError(SyndicationError);

      expect(
        harness.store.parts.get(HARNESS_IDS.parts.ALTERNATOR)!.ebaySyncState,
      ).toBe('CSV_EXPORTED_PENDING_CONFIRMATION');

      // Confirm live via exact 3-arg signature
      const confirmed = await ebayExporter.confirmEbayListingLive(
        cfo,
        HARNESS_IDS.parts.ALTERNATOR,
        '285900001111',
      );
      expect(confirmed.ebaySyncState).toBe('SYNDICATED_LIVE');
      expect(confirmed.provenanceClassification).toBe('OPERATOR_ASSERTION');

      // Duplicate eBay listing ID on another part rejects
      await expect(
        ebayExporter.confirmEbayListingLive(
          cfo,
          HARNESS_IDS.parts.STEERING_RACK,
          '285900001111',
        ),
      ).rejects.toThrowError(SyndicationError);

      // B2B Mechanic Powertrain Sheet leaves ebaySyncState untouched
      const b2b = await ebayExporter.exportB2bPowertrainSheet(hunter);
      expect(b2b.persistedMutation).toBe(false);
      expect(b2b.publicPickupLocationLabel).toBe(
        'Ottawa South / Hwy 416 Corridor',
      );
      expect(b2b.items.map((i) => i.qrSkuCode)).toContain('PRT-884923');
      expect(
        harness.store.parts.get(HARNESS_IDS.parts.ENGINE_POWERTRAIN)!
          .ebaySyncState,
      ).toBe('NOT_LISTED');

      // Local classifieds ad copy + mark-posted
      const localAd = await localQueue.getLocalAdPayload(
        hunter,
        'PRT-884925',
      );
      expect(localAd.isLocalPickupOnly).toBe(true);
      expect(localAd.publicPickupLocationLabel).toBe(
        'Ottawa South / Hwy 416 Corridor',
      );

      const posted = await localQueue.markPostedToClassifieds(hunter, {
        qrSkuCodeOrPartId: 'PRT-884925',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      });
      expect(posted.classifiedsSyncState).toBe('POSTED_LIVE');
    });
  });

  describe('FR-CHK-01, FIX 05, FIX 06 & Finding 4: Checkout, Place-of-Supply Tax, Bank Settlement & Refund QC Hold', () => {
    it('enforces CRA place-of-supply tax rates across provinces, zero-rated export proof, and unregistered tax mode', async () => {
      const { checkoutUseCase, storage } = harness.createUseCases();
      const cfo = harness.makeSession();
      const orgId = HARNESS_IDS.orgs.SALVAGE;

      const proof = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([1, 2, 3, 4]),
        contentType: 'image/png',
        auditContext: { correlationId: 'pay-proof-1' },
      });
      const exportProof = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([5, 6, 7, 8]),
        contentType: 'application/pdf',
        auditContext: { correlationId: 'exp-proof-1' },
      });

      // Missing export proof on international sale -> 422
      await expect(
        checkoutUseCase.executeDomesticCheckout(cfo, {
          domesticChannel: 'FB_MARKETPLACE_LOCAL',
          deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
          destinationCountryCode: 'US',
          destinationProvinceOrState: 'NY',
          paymentMethod: 'INTERAC_ETRANSFER',
          buyerName: 'US Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.ALTERNATOR,
              proposedPriceCadMinor: 14_500,
            },
          ],
          paymentProofStorageKey: proof.storageKey,
          idempotencyKey: '33333333-3333-4333-8333-333333333301',
        }),
      ).rejects.toThrowError(DomainRuleError);

      // NS destination -> 1400 bps (14% HST)
      const nsSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'FB_MARKETPLACE_LOCAL',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'NS',
        paymentMethod: 'INTERAC_ETRANSFER',
        buyerName: 'Halifax Buyer',
        partLines: [
          {
            partId: HARNESS_IDS.parts.ALTERNATOR,
            proposedPriceCadMinor: 14_500,
          },
        ],
        paymentProofStorageKey: proof.storageKey,
        idempotencyKey: '33333333-3333-4333-8333-333333333302',
      });
      expect(nsSale.appliedTaxJurisdiction).toBe('CA-NS');
      expect(nsSale.appliedTaxRateBps).toBe(1400);
      expect(nsSale.taxOrVatMinor).toBe(Math.round((14_500 * 1400) / 10_000));
      expect(nsSale.paymentSettlementState).toBe('BANK_SETTLEMENT_PENDING');
      expect(nsSale.cashCustodyState).toBe('PENDING_EXTERNAL_RECEIVABLE');

      // AB destination -> 500 bps (5% GST)
      const abSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'KIJIJI_LOCAL',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'AB',
        paymentMethod: 'VERIFIED_BANK_WIRE',
        buyerName: 'Calgary Buyer',
        partLines: [
          {
            partId: HARNESS_IDS.parts.STEERING_RACK,
            proposedPriceCadMinor: 24_500,
          },
        ],
        paymentProofStorageKey: proof.storageKey,
        idempotencyKey: '33333333-3333-4333-8333-333333333303',
      });
      expect(abSale.appliedTaxJurisdiction).toBe('CA-AB');
      expect(abSale.appliedTaxRateBps).toBe(500);
      expect(abSale.taxOrVatMinor).toBe(Math.round((24_500 * 500) / 10_000));

      // International zero-rated export with valid proof -> 0 bps
      const usExport = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'WHOLESALE_MECHANIC_NETWORK',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        destinationCountryCode: 'US',
        destinationProvinceOrState: 'NY',
        paymentMethod: 'VERIFIED_BANK_WIRE',
        buyerName: 'Watertown Shop',
        partLines: [
          {
            partId: HARNESS_IDS.parts.STARTER_GRADE_B1,
            proposedPriceCadMinor: 20_000,
          },
        ],
        paymentProofStorageKey: proof.storageKey,
        exportProofStorageKey: exportProof.storageKey,
        idempotencyKey: '33333333-3333-4333-8333-333333333304',
      });
      expect(usExport.appliedTaxJurisdiction).toBe('EXPORT-OUTSIDE-CA');
      expect(usExport.appliedTaxRateBps).toBe(0);
      expect(usExport.taxOrVatMinor).toBe(0);

      // Pending Interac refund / cancellation leaves zero pending receivable & zero HST
      const pendingRefund = await checkoutUseCase.recordSaleRefundOrChargeback(
        cfo,
        nsSale.saleId,
        {
          reasonNote: 'Buyer cancelled before dispatch',
          returnPartsToQcHold: true,
        },
      );
      expect(pendingRefund.chosenFundingSource).toBe(
        'PENDING_EXTERNAL_RECEIVABLE',
      );
      expect(pendingRefund.taxOrVatAdjustmentMinor).toBe(
        -nsSale.taxOrVatMinor,
      );
      expect(
        harness.store.parts.get(HARNESS_IDS.parts.ALTERNATOR)!.custodyState,
      ).toBe('RESTOCKED_QC_HOLD');

      // Re-checkout QC-held part rejects with 422 PART_IN_RETURN_QC_HOLD
      await expect(
        checkoutUseCase.executeDomesticCheckout(cfo, {
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Walk-in Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.ALTERNATOR,
              proposedPriceCadMinor: 14_500,
            },
          ],
          paymentProofStorageKey: proof.storageKey,
          idempotencyKey: '33333333-3333-4333-8333-333333333305',
        }),
      ).rejects.toMatchObject({ code: 'PART_IN_RETURN_QC_HOLD', status: 422 });

      // Unregistered org tax mode applies 0 bps
      harness.setPolicyOverride(orgId, {
        domesticTaxPolicy: {
          ...BASELINE_ISSUE10_POLICY.domesticTaxPolicy,
          isGstHstRegistered: false,
          isOntarioEntityHstRegistered: false,
          isOntarioHstRegistered: false,
        },
      });
      const unregSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'LOCAL_WALK_IN_CASH',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'CASH',
        isCashCountedInPerson: true,
        buyerName: 'Cash Buyer',
        partLines: [
          {
            partId: HARNESS_IDS.parts.BATTERY_TDG,
            proposedPriceCadMinor: 16_000,
          },
        ],
        paymentProofStorageKey: proof.storageKey,
        idempotencyKey: '33333333-3333-4333-8333-333333333306',
      });
      expect(unregSale.taxCollectionMode).toBe('NOT_REGISTERED_NO_TAX');
      expect(unregSale.appliedTaxRateBps).toBe(0);
      expect(unregSale.taxOrVatMinor).toBe(0);
      expect(unregSale.paymentSettlementState).toBe('PAYMENT_CONFIRMED');
      expect(unregSale.cashCustodyState).toBe('HELD_IN_OPERATOR_FLOAT');
    });

    it('handles eBay Billing Agent (null/verbatim buyer tax, ITC verified invoice gate, actualPlatformFeeMinor), and exact two-field Finding 4 refunds', async () => {
      const { checkoutUseCase, storage } = harness.createUseCases();
      const cfo = harness.makeSession();
      const orgId = HARNESS_IDS.orgs.SALVAGE;

      const payProof = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([1, 1, 1]),
        contentType: 'image/png',
        auditContext: { correlationId: 'ebay-pay' },
      });
      const settleProof = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([2, 2, 2]),
        contentType: 'application/pdf',
        auditContext: { correlationId: 'ebay-settle' },
      });
      const feeTaxInv = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([3, 3, 3]),
        contentType: 'application/pdf',
        auditContext: { correlationId: 'ebay-itc' },
      });

      const ebaySale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'EBAY_MOTORS_SHIPPED',
        deliveryMethod: 'SELLER_SHIPPED_PARCEL_OR_FREIGHT',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'EBAY_MANAGED_PAYOUT',
        buyerName: 'eBay Buyer 1',
        partLines: [
          {
            partId: HARNESS_IDS.parts.STARTER_GRADE_B1,
            proposedPriceCadMinor: 20_000,
          },
        ],
        paymentProofStorageKey: payProof.storageKey,
        buyerTaxRemittedByPlatformMinor: null,
        platformFeeMinor: 1_300,
        shippingCostMinor: 0,
        estimatedPlatformFeeTaxCadMinor: 169,
        idempotencyKey: '44444444-4444-4444-8444-444444444401',
      });

      expect(ebaySale.taxCollectionMode).toBe(
        'MARKETPLACE_FACILITATOR_COLLECTED',
      );
      expect(ebaySale.taxOrVatMinor).toBe(0);
      expect(ebaySale.buyerTaxRemittedByPlatformMinor).toBeNull();
      expect(ebaySale.estimatedPlatformFeeTaxCadMinor).toBe(169);
      expect(ebaySale.itcReceivableCadMinor).toBe(0);
      expect(ebaySale.isFeeTaxInvoiceVerified).toBe(false);
      expect(ebaySale.paymentSettlementState).toBe('MARKETPLACE_PAYOUT_PENDING');
      expect(ebaySale.cashCustodyState).toBe('PENDING_EXTERNAL_RECEIVABLE');

      const baselineLedger = harness.computeLedgerProjection(orgId);
      const openingBankCash =
        baselineLedger.snapshot.confirmedCorpBankCashCadMinor;

      let ledger = harness.computeLedgerProjection(orgId);
      expect(ledger.snapshot.confirmedCorpBankCashCadMinor).toBe(
        openingBankCash,
      );
      expect(ledger.snapshot.pendingExternalReceivablesCadMinor).toBe(18_700);
      expect(ledger.taxCounters.verifiedItcReceivableCadMinor).toBe(0);

      // CFO confirms bank settlement with reconciled actualPlatformFeeMinor = 1,500 and verified feeTaxInvoiceStorageKey
      const settled = await checkoutUseCase.confirmSaleBankSettlement(
        cfo,
        ebaySale.saleId,
        {
          bankDepositReference: 'EBAY-PAYOUT-001',
          settlementProofStorageKey: settleProof.storageKey,
          actualPlatformFeeMinor: 1_500,
          feeTaxInvoiceStorageKey: feeTaxInv.storageKey,
        },
      );
      expect(settled.cashCustodyState).toBe('SETTLED_ORIGIN_CORP_BANK');
      expect(settled.actualPlatformFeeMinor).toBe(1_500);
      expect(settled.isFeeTaxInvoiceVerified).toBe(true);
      expect(settled.itcReceivableCadMinor).toBe(169);

      ledger = harness.computeLedgerProjection(orgId);
      expect(ledger.snapshot.confirmedCorpBankCashCadMinor).toBe(
        openingBankCash + 18_500,
      );
      expect(ledger.snapshot.pendingExternalReceivablesCadMinor).toBe(0);
      expect(ledger.taxCounters.verifiedItcReceivableCadMinor).toBe(169);

      // Exact two-field signature from Issue #10 Finding 4
      const refund = await checkoutUseCase.recordSaleRefundOrChargeback(
        cfo,
        ebaySale.saleId,
        {
          reasonNote: 'Defective starter returned by buyer',
          returnPartsToQcHold: true,
        },
      );
      expect(refund.chosenFundingSource).toBe('CORP_BANK');
      expect(refund.proofOrigin).toBe('INHERITED_SALE_EVIDENCE');
      expect(refund.bankCashAdjustmentCadMinor).toBe(-18_500);
      expect(refund.returnedPartIds).toEqual([
        HARNESS_IDS.parts.STARTER_GRADE_B1,
      ]);

      ledger = harness.computeLedgerProjection(orgId);
      expect(ledger.snapshot.confirmedCorpBankCashCadMinor).toBe(
        openingBankCash,
      );
      expect(ledger.snapshot.pendingExternalReceivablesCadMinor).toBe(0);
      expect(ledger.snapshot.accountingRevenueCadMinor).toBe(0);
      expect(ledger.snapshot.distributableRealizedProfitPoolCadMinor).toBe(0);

      const qcPart = harness.store.parts.get(HARNESS_IDS.parts.STARTER_GRADE_B1)!;
      expect(qcPart.custodyState).toBe('RESTOCKED_QC_HOLD');
      expect(qcPart.availabilityState).toBe('RETURNED_QC_HOLD');
      expect(qcPart.complianceState).toBe('NEEDS_HUMAN_REVIEW');
      expect(qcPart.ebaySyncState).toBe('DELISTED');
    });

    it('handles swept cash refund (CORP_BANK via SWEPT_TRANSFER_DEPOSIT_SLIP), unswept cash refund (OPERATOR_FLOAT), and buildPersistedLedgerProjection directly', async () => {
      const { checkoutUseCase, storage } = harness.createUseCases();
      const cfo = harness.makeSession();
      const orgId = HARNESS_IDS.orgs.SALVAGE;

      const payProof = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([4, 4, 4]),
        contentType: 'image/png',
        auditContext: { correlationId: 'cash-pay' },
      });

      const cashSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'LOCAL_WALK_IN_CASH',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'CASH',
        isCashCountedInPerson: true,
        buyerName: 'Counter Buyer',
        partLines: [
          {
            partId: HARNESS_IDS.parts.ALTERNATOR,
            proposedPriceCadMinor: 14_500,
          },
        ],
        paymentProofStorageKey: payProof.storageKey,
        idempotencyKey: '55555555-5555-4555-8555-555555555501',
      });

      const grossCash = cashSale.grossCollectedMinor;
      harness.addCashSweepTransfer({
        organizationId: orgId,
        transferCode: 'DROP-ONT-2026-0042',
        amountMinor: grossCash,
        depositSlipStorageKey: `${orgId}/evidence/99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        recordedByUserId: cfo.userId,
        custodyHolderUserId: cfo.userId,
      });

      const ledgerBeforeCash = harness.computeLedgerProjection(orgId);
      const sweptRefund = await checkoutUseCase.recordSaleRefundOrChargeback(
        cfo,
        cashSale.saleId,
        {
          reasonNote: 'Returned at counter after cash deposit',
          returnPartsToQcHold: true,
        },
      );
      expect(sweptRefund.chosenFundingSource).toBe('CORP_BANK');
      expect(sweptRefund.proofOrigin).toBe('INHERITED_SALE_EVIDENCE');
      expect(sweptRefund.referenceOrigin).toBe('SWEPT_TRANSFER_CODE');

      const ledgerAfterSweptRefund = harness.computeLedgerProjection(orgId);
      expect(ledgerAfterSweptRefund.snapshot.confirmedCorpBankCashCadMinor).toBe(
        ledgerBeforeCash.snapshot.confirmedCorpBankCashCadMinor - grossCash,
      );
      expect(ledgerAfterSweptRefund.snapshot.runningOperatorFloatCadMinor).toBe(
        0,
      );

      // Second cash sale WITHOUT sweep -> refund draws from OPERATOR_FLOAT cleanly
      const unsweptSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'LOCAL_WALK_IN_CASH',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'CASH',
        isCashCountedInPerson: true,
        buyerName: 'Counter Buyer 2',
        partLines: [
          {
            partId: HARNESS_IDS.parts.STEERING_RACK,
            proposedPriceCadMinor: 24_500,
          },
        ],
        paymentProofStorageKey: payProof.storageKey,
        idempotencyKey: '55555555-5555-4555-8555-555555555502',
      });
      const floatRefund = await checkoutUseCase.recordSaleRefundOrChargeback(
        cfo,
        unsweptSale.saleId,
        {
          reasonNote: 'Counter immediate return',
          returnPartsToQcHold: false,
        },
      );
      expect(floatRefund.chosenFundingSource).toBe('OPERATOR_FLOAT');
      expect(floatRefund.proofOrigin).toBe('INHERITED_SALE_EVIDENCE');
      expect(
        harness.computeLedgerProjection(orgId).snapshot
          .runningOperatorFloatCadMinor,
      ).toBe(0);

      // Swept cash refund with custodyHolderUserId=null falls back to recordedByUserId,
      // and picks latest transfer by transferredAt DESC, id DESC
      const hunter = harness.makeSession({
        userId: HARNESS_IDS.users.HUNTER,
        role: 'HUNTER_MECHANIC',
      });
      const hunterPayProof = await storage.uploadPrivateEvidence({
        actor: hunter,
        organizationId: orgId,
        evidence: Uint8Array.from([5, 5, 5]),
        contentType: 'image/png',
        auditContext: { correlationId: 'hunter-null-holder' },
      });
      const nullHolderCashSale = await checkoutUseCase.executeDomesticCheckout(
        hunter,
        {
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Counter Buyer Null Holder',
          partLines: [
            {
              partId: HARNESS_IDS.parts.STARTER_GRADE_B1,
              proposedPriceCadMinor: 20_000,
            },
          ],
          paymentProofStorageKey: hunterPayProof.storageKey,
          idempotencyKey: '55555555-5555-4555-8555-555555555503',
        },
      );
      harness.addCashSweepTransfer({
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        organizationId: orgId,
        transferCode: 'DROP-OLDER',
        amountMinor: 5_000,
        depositSlipStorageKey: `${orgId}/evidence/99999999-aaaa-4aaa-8aaa-aaaaaaaaaaab`,
        recordedByUserId: hunter.userId,
        custodyHolderUserId: null,
        transferredAt: new Date('2026-11-16T14:58:00Z'),
      });
      harness.addCashSweepTransfer({
        id: 'aaaaaaaa-0000-4000-8000-000000000003',
        organizationId: orgId,
        transferCode: 'DROP-LATEST-TIE-A',
        amountMinor: 5_000,
        depositSlipStorageKey: `${orgId}/evidence/99999999-aaaa-4aaa-8aaa-aaaaaaaaaaac`,
        recordedByUserId: hunter.userId,
        custodyHolderUserId: null,
        transferredAt: new Date('2026-11-16T14:59:00Z'),
      });
      harness.addCashSweepTransfer({
        id: 'aaaaaaaa-0000-4000-8000-000000000004',
        organizationId: orgId,
        transferCode: 'DROP-LATEST-NULL-HOLDER',
        amountMinor: nullHolderCashSale.grossCollectedMinor - 10_000,
        depositSlipStorageKey: `${orgId}/evidence/99999999-aaaa-4aaa-8aaa-aaaaaaaaaaad`,
        recordedByUserId: hunter.userId,
        custodyHolderUserId: null,
        transferredAt: new Date('2026-11-16T14:59:00Z'),
      });
      const nullHolderRefund = await checkoutUseCase.recordSaleRefundOrChargeback(
        cfo,
        nullHolderCashSale.saleId,
        {
          reasonNote: 'Return after null-holder sweep',
          returnPartsToQcHold: false,
        },
      );
      expect(nullHolderRefund.chosenFundingSource).toBe('CORP_BANK');
      expect(nullHolderRefund.referenceOrigin).toBe('SWEPT_TRANSFER_CODE');
      expect(
        harness.store.sales.get(nullHolderRefund.reversalSaleId)!
          .bankDepositReference,
      ).toBe('DROP-LATEST-NULL-HOLDER');

      // Direct verification of buildPersistedLedgerProjection with actualPlatformFeeMinor
      const directProjection = buildPersistedLedgerProjection({
        organizationId: orgId,
        policy: {
          operationalGates: {
            ...BASELINE_ISSUE10_POLICY.operationalGates,
            workingCapitalGate: {
              ...BASELINE_ISSUE10_POLICY.operationalGates.workingCapitalGate,
              tranches: [
                {
                  trancheCode: 'TRANCHE_1',
                  principalCadMinor: 100_000,
                  minShelvedSkus: 0,
                  minScrappedDonors: 0,
                  requireZeroOverdueFloatReceipts: false,
                  unlocked: true,
                },
              ],
            },
          },
          compensationRules: BASELINE_ISSUE10_POLICY.compensationRules,
        },
        saleRows: [
          {
            id: 's1',
            organizationId: orgId,
            marketNode: 'DOMESTIC_ORIGIN',
            domesticChannel: 'EBAY_MOTORS_SHIPPED',
            exportChannel: null,
            paymentCurrency: 'CAD',
            taxCollectionMode: 'MARKETPLACE_FACILITATOR_COLLECTED',
            subtotalMinor: 10_000,
            taxOrVatMinor: 0,
            buyerTaxRemittedByPlatformMinor: null,
            platformFeeMinor: 1_300,
            actualPlatformFeeMinor: 1_500,
            shippingCostMinor: 0,
            estimatedPlatformFeeTaxCadMinor: 0,
            itcReceivableCadMinor: 0,
            isFeeTaxInvoiceVerified: false,
            feeTaxInvoiceStorageKey: null,
            grossCollectedMinor: 10_000,
            netRealizedCadMinor: 8_700,
            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
            bankSettledAt: new Date('2026-11-16T12:00:00Z'),
            bankDepositReference: 'EBAY-DIRECT-1',
            soldByUserId: cfo.userId,
            isVoidedOrReversed: false,
            reversesSaleTxId: null,
          },
        ],
        scrapRows: [],
        transferRows: [],
        settlementRows: [],
        expenseRows: [],
      });
      expect(directProjection.snapshot.confirmedCorpBankCashCadMinor).toBe(
        108_500,
      );
    });

    it('enforces Delist-on-eBay attestation, 10% corridor + 1-Tap CFO override, OMVIC/DriveON gates, RBAC, revocation, and route security', async () => {
      const { ebayExporter, checkoutUseCase, storage } = harness.createUseCases();
      const cfo = harness.makeSession();
      const hunter = harness.makeSession({
        userId: HARNESS_IDS.users.HUNTER,
        role: 'HUNTER_MECHANIC',
      });
      const orgId = HARNESS_IDS.orgs.SALVAGE;

      const payProof = await storage.uploadPrivateEvidence({
        actor: hunter,
        organizationId: orgId,
        evidence: Uint8Array.from([7, 7, 7]),
        contentType: 'image/png',
        auditContext: { correlationId: 'hunter-pay' },
      });
      const billOfSale = await storage.uploadPrivateEvidence({
        actor: cfo,
        organizationId: orgId,
        evidence: Uint8Array.from([8, 8, 8]),
        contentType: 'application/pdf',
        auditContext: { correlationId: 'bos' },
      });

      await ebayExporter.exportEbaySellerHubCsv(cfo, {
        partIds: [HARNESS_IDS.parts.ALTERNATOR],
        idempotencyKey: '66666666-6666-4666-8666-666666666601',
      });
      await ebayExporter.confirmEbayListingLive(
        cfo,
        HARNESS_IDS.parts.ALTERNATOR,
        '285999888777',
      );

      // Local checkout without attestation throws DomainRuleError
      await expect(
        checkoutUseCase.executeDomesticCheckout(hunter, {
          domesticChannel: 'FB_MARKETPLACE_LOCAL',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Local Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.ALTERNATOR,
              proposedPriceCadMinor: 14_500,
            },
          ],
          paymentProofStorageKey: payProof.storageKey,
          idempotencyKey: '66666666-6666-4666-8666-666666666602',
        }),
      ).rejects.toThrowError(DomainRuleError);

      // Hunter cannot override below 10% corridor -> fail-closed 422 FLOOR_PRICE_OVERRIDE_REQUIRED
      await expect(
        checkoutUseCase.executeDomesticCheckout(hunter, {
          domesticChannel: 'FB_MARKETPLACE_LOCAL',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Local Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.ALTERNATOR,
              proposedPriceCadMinor: 12_000,
            },
          ],
          discountReasonCode: 'LOW_OFFER',
          cfoOverrideRequested: true,
          cfoOverrideReasonNote: 'Attempted non-CFO override',
          ebayDelistAttestedAt: '2026-11-16T15:00:00Z',
          paymentProofStorageKey: payProof.storageKey,
          idempotencyKey: '66666666-6666-4666-8666-666666666603',
        }),
      ).rejects.toMatchObject({
        code: 'FLOOR_PRICE_OVERRIDE_REQUIRED',
        status: 422,
      });

      // CFO with AAL2 succeeds with 1-Tap override + Delist attestation -> DELIST_PENDING + OutboxEvent
      const overrideSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'FB_MARKETPLACE_LOCAL',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'CASH',
        isCashCountedInPerson: true,
        buyerName: 'Local Buyer',
        partLines: [
          {
            partId: HARNESS_IDS.parts.ALTERNATOR,
            proposedPriceCadMinor: 12_000,
          },
        ],
        discountReasonCode: 'BUNDLE_DEAL',
        cfoOverrideRequested: true,
        cfoOverrideReasonNote: 'CFO approved clearance bundle',
        ebayDelistAttestedAt: '2026-11-16T15:00:00Z',
        paymentProofStorageKey: payProof.storageKey,
        idempotencyKey: '66666666-6666-4666-8666-666666666604',
      });
      expect(overrideSale.cfoOverrideApplied).toBe(true);
      expect(overrideSale.outboxEventIds).toHaveLength(1);
      expect(
        harness.store.parts.get(HARNESS_IDS.parts.ALTERNATOR)!.ebaySyncState,
      ).toBe('DELIST_PENDING');

      // Whole vehicle retail sale records OMVIC + DriveON warnings in WARN_ONLY mode
      const vehSale = await checkoutUseCase.executeDomesticCheckout(cfo, {
        domesticChannel: 'RETAIL_LOT_VEHICLE_SALE',
        deliveryMethod: 'PICKUP_AT_ORIGIN',
        destinationCountryCode: 'CA',
        destinationProvinceOrState: 'ON',
        paymentMethod: 'VERIFIED_BANK_WIRE',
        buyerName: 'Retail Car Buyer',
        vehicleLines: [
          {
            vehicleId: HARNESS_IDS.vehicles.RETAIL_CAR,
            proposedPriceCadMinor: 850_000,
          },
        ],
        paymentProofStorageKey: payProof.storageKey,
        billOfSaleStorageKey: billOfSale.storageKey,
        idempotencyKey: '66666666-6666-4666-8666-666666666605',
      });
      expect(vehSale.complianceWarnings).toContain('OMVIC_LICENSE_WARNING');
      expect(vehSale.complianceWarnings).toContain(
        'DRIVEON_SAFETY_CERT_WARNING',
      );

      // acknowledgedPriceBasisHash: matching single-item & sorted multi-item passes, stale pricing basis rejects with 409 INVENTORY_CONFLICT
      const lookupBefore = await checkoutUseCase.lookupCheckoutItems(cfo);
      const starterLookup = lookupBefore.find(
        (i) => i.itemId === HARNESS_IDS.parts.STARTER_GRADE_B1,
      )!;
      const batteryLookup = lookupBefore.find(
        (i) => i.itemId === HARNESS_IDS.parts.BATTERY_TDG,
      )!;
      expect(starterLookup.priceBasisHash).toBeTruthy();
      expect(batteryLookup.priceBasisHash).toBeTruthy();

      // Mutate resolved pricing basis between review and checkout -> 409 INVENTORY_CONFLICT
      harness.store.parts.get(HARNESS_IDS.parts.STARTER_GRADE_B1)!.retailPriceCadMinor =
        21_500;
      await expect(
        checkoutUseCase.executeDomesticCheckout(cfo, {
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Stale Basis Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.STARTER_GRADE_B1,
              proposedPriceCadMinor: 21_500,
            },
          ],
          paymentProofStorageKey: payProof.storageKey,
          acknowledgedPriceBasisHash: starterLookup.priceBasisHash,
          idempotencyKey: '66666666-6666-4666-8666-666666666606',
        }),
      ).rejects.toMatchObject({
        code: 'INVENTORY_CONFLICT',
        status: 409,
      });

      // Refresh lookup and check out multi-item basket using sorted comma-joined priceBasisHash
      const lookupRefreshed = await checkoutUseCase.lookupCheckoutItems(cfo);
      const refreshedPair = [
        lookupRefreshed.find(
          (i) => i.itemId === HARNESS_IDS.parts.STARTER_GRADE_B1,
        )!,
        lookupRefreshed.find(
          (i) => i.itemId === HARNESS_IDS.parts.BATTERY_TDG,
        )!,
      ].sort((a, b) =>
        a.itemId.toLowerCase().localeCompare(b.itemId.toLowerCase()),
      );
      const joinedBasisHash = refreshedPair
        .map((i) => i.priceBasisHash)
        .join(',');
      const basisMatchSale = await checkoutUseCase.executeDomesticCheckout(
        cfo,
        {
          domesticChannel: 'LOCAL_WALK_IN_CASH',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Fresh Multi Basis Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.BATTERY_TDG,
              proposedPriceCadMinor:
                batteryLookup.resolvedPrice!.amountCadMinor,
            },
            {
              partId: HARNESS_IDS.parts.STARTER_GRADE_B1,
              proposedPriceCadMinor: 21_500,
            },
          ],
          paymentProofStorageKey: payProof.storageKey,
          acknowledgedPriceBasisHash: joinedBasisHash,
          idempotencyKey: '66666666-6666-4666-8666-666666666607',
        },
      );
      expect(basisMatchSale.subtotalMinor).toBe(
        21_500 + batteryLookup.resolvedPrice!.amountCadMinor,
      );

      // Immediate membership revocation denies operations
      harness.revokeMembership(hunter.userId, orgId);
      await expect(
        checkoutUseCase.lookupCheckoutItems(hunter),
      ).rejects.toThrowError(AuthError);
      await expect(
        checkoutUseCase.executeDomesticCheckout(cfo, {
          domesticChannel: 'FB_MARKETPLACE_LOCAL',
          deliveryMethod: 'PICKUP_AT_ORIGIN',
          destinationCountryCode: 'CA',
          destinationProvinceOrState: 'ON',
          paymentMethod: 'CASH',
          isCashCountedInPerson: true,
          buyerName: 'Local Buyer',
          partLines: [
            {
              partId: HARNESS_IDS.parts.ALTERNATOR,
              proposedPriceCadMinor: 12_000,
            },
          ],
          discountReasonCode: 'BUNDLE_DEAL',
          cfoOverrideRequested: true,
          cfoOverrideReasonNote: 'CFO approved clearance bundle',
          ebayDelistAttestedAt: '2026-11-16T15:00:00Z',
          paymentProofStorageKey: payProof.storageKey,
          idempotencyKey: '66666666-6666-4666-8666-666666666604',
        }),
      ).resolves.toMatchObject({ saleId: overrideSale.saleId });
    });

    it('route handlers enforce Cache-Control/X-Content-Type-Options, reject unknown params & cross-origin mutations, and DI factories construct cleanly offline', async () => {
      const cfo = harness.makeSession();
      const { syndicationDeps, checkoutDeps } = harness.createRouteDeps(
        () => cfo,
      );

      const getPreview = await handleEbayCsvGet(
        new Request('https://app.local/api/salvage/syndication/ebay-csv'),
        syndicationDeps,
      );
      expect(getPreview.status).toBe(200);
      expect(getPreview.headers.get('cache-control')).toBe(
        'private, no-store, max-age=0',
      );
      expect(getPreview.headers.get('x-content-type-options')).toBe('nosniff');

      const badOriginPost = await handleEbayCsvPost(
        new Request('https://app.local/api/salvage/syndication/ebay-csv', {
          method: 'POST',
          headers: {
            origin: 'https://evil.example',
            'content-type': 'application/json',
            'idempotency-key': '77777777-7777-4777-8777-777777777701',
          },
          body: JSON.stringify({
            idempotencyKey: '77777777-7777-4777-8777-777777777701',
          }),
        }),
        syndicationDeps,
      );
      expect(badOriginPost.status).toBe(403);

      const lookupResp = await handleDomesticCheckoutGet(
        new Request(
          'https://app.local/api/salvage/checkout/domestic?view=lookup',
        ),
        checkoutDeps,
      );
      expect(lookupResp.status).toBe(200);

      const unknownParam = await handleDomesticCheckoutGet(
        new Request(
          'https://app.local/api/salvage/checkout/domestic?view=lookup&bogus=1',
        ),
        checkoutDeps,
      );
      expect(unknownParam.status).toBe(400);

      const badPatchAction = await handleDomesticCheckoutPatch(
        new Request('https://app.local/api/salvage/checkout/domestic', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': '77777777-7777-4777-8777-777777777702',
          },
          body: JSON.stringify({ action: 'unknown' }),
        }),
        checkoutDeps,
      );
      expect(badPatchAction.status).toBe(400);

      const queueResp = await handleLocalAdPayloadGet(
        new Request(
          'https://app.local/api/marketplace/local-ad-payload/__urgent-delist-queue__',
        ),
        '__urgent-delist-queue__',
        syndicationDeps,
      );
      expect(queueResp.status).toBe(200);

      const badPatchQueue = await handleLocalAdPayloadPatch(
        new Request(
          'https://app.local/api/marketplace/local-ad-payload/__urgent-delist-queue__',
          {
            method: 'PATCH',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': '77777777-7777-4777-8777-777777777703',
            },
            body: JSON.stringify({}),
          },
        ),
        '__urgent-delist-queue__',
        syndicationDeps,
      );
      expect(badPatchQueue.status).toBe(400);

      const badUploadPost = await handleDomesticCheckoutPost(
        new Request('https://app.local/api/salvage/checkout/domestic', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'bad-uuid',
          },
          body: '{}',
        }),
        checkoutDeps,
      );
      expect(badUploadPost.status).toBe(400);

      const badConfirmPatch = await handleEbayCsvPatch(
        new Request('https://app.local/api/salvage/syndication/ebay-csv', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': '77777777-7777-4777-8777-777777777704',
          },
          body: JSON.stringify({ action: 'confirm-live', partId: 'not-uuid' }),
        }),
        syndicationDeps,
      );
      expect(badConfirmPatch.status).toBe(400);

      // DI smoke checks: factory instantiation does not open DB connections eagerly
      expect(() => createProductionEbayCsvExporterUseCase()).not.toThrow();
      expect(() => createProductionLocalClassifiedsQueueUseCase()).not.toThrow();
      expect(() => createProductionDomesticCheckoutUseCase()).not.toThrow();
    });
  });
});
