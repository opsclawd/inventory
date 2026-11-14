import type {
  AraConditionGradeEnum,
  AssetCategory,
  AssetLifecycleState,
  CashCustodyState,
  CatalyticConverterDisposition,
  ClassifiedsSyncState,
  DomesticSaleChannel,
  EbaySyncState,
  InventoryAvailabilityState,
  LocationOperationalStatus,
  OperationalLane,
  OrganizationType,
  PartComplianceState,
  PartCustodyState,
  PaymentSettlementState,
  SteeringSideCompatibility,
  TdgHazmatCode,
} from '@prisma/client';
import type { PricingAndCompliancePolicy } from '../ports';
import {
  assertNonEmptyTrimmedString,
  DomainRuleError,
  type DomainRuleErrorCode,
  type GateDecision,
  isNonEmptyTrimmedString,
  parseUtcDate,
} from './domain-primitives';

export type ComplianceEnforcementMode = 'WARN_ONLY' | 'STRICT_BLOCK';

export type RegulatoryWarningCode =
  | 'COMPLIANCE_WARNING_UNDRAINED_FARM'
  | 'PROPOSED_INACTIVE_LOCATION_WARNING'
  | 'MISSING_EASR_REGISTRATION_WARNING'
  | 'DRIVEON_SAFETY_CERT_WARNING'
  | 'MISSING_HTA_S60_DOCS'
  | 'UNRECONCILED_CATALYTIC_CONVERTER';

export type RegulatoryStrictBlockingCode =
  | 'ENVIRONMENTAL_ZONING_VIOLATION'
  | 'LOCATION_PROPOSED_INACTIVE'
  | 'EASR_REGISTRATION_REQUIRED'
  | 'EXPIRED_OR_MISSING_SAFETY_CERT'
  | 'MISSING_HTA_S60_DOCS'
  | 'UNRECONCILED_CATALYTIC_CONVERTER';

const WARNING_TO_STRICT_CODE: Readonly<
  Record<RegulatoryWarningCode, RegulatoryStrictBlockingCode>
> = {
  COMPLIANCE_WARNING_UNDRAINED_FARM: 'ENVIRONMENTAL_ZONING_VIOLATION',
  PROPOSED_INACTIVE_LOCATION_WARNING: 'LOCATION_PROPOSED_INACTIVE',
  MISSING_EASR_REGISTRATION_WARNING: 'EASR_REGISTRATION_REQUIRED',
  DRIVEON_SAFETY_CERT_WARNING: 'EXPIRED_OR_MISSING_SAFETY_CERT',
  MISSING_HTA_S60_DOCS: 'MISSING_HTA_S60_DOCS',
  UNRECONCILED_CATALYTIC_CONVERTER: 'UNRECONCILED_CATALYTIC_CONVERTER',
};

export interface RegulatoryComplianceDecision
  extends GateDecision<RegulatoryStrictBlockingCode> {
  readonly mode: ComplianceEnforcementMode;
  readonly warningCode: RegulatoryWarningCode;
  readonly blockingCode: RegulatoryStrictBlockingCode | null;
}

export function evaluateRegulatoryComplianceCheck(
  mode: ComplianceEnforcementMode,
  warningCode: RegulatoryWarningCode,
): RegulatoryComplianceDecision {
  const strictCode = WARNING_TO_STRICT_CODE[warningCode];
  if (mode === 'WARN_ONLY') {
    return {
      allowed: true,
      mode,
      warningCode,
      blockingCode: null,
      warnings: [warningCode],
      blockingCodes: [],
      overrideApplied: false,
      cfoOverrideAudit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
    };
  }

  return {
    allowed: false,
    mode,
    warningCode,
    blockingCode: strictCode,
    warnings: [],
    blockingCodes: [strictCode],
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
  };
}

export interface LocationCustodyCheckInput {
  readonly entityOrganizationId: string;
  readonly entityDomain: 'SALVAGE' | 'CANNABIS';
  readonly locationOrganizationId: string;
  readonly locationAllowedOrgType: OrganizationType;
  readonly locationOperationalStatus: LocationOperationalStatus;
  readonly allowsWholeVehicleDismantling: boolean;
  readonly requiresFluidDrainageCheck: boolean;
  readonly fluidsDrainedAt: Date | string | null;
  readonly complianceEnforcementMode: ComplianceEnforcementMode;
}

export function evaluateLocationCustodyCheck(
  input: LocationCustodyCheckInput,
): GateDecision {
  const expectedOrgType: OrganizationType =
    input.entityDomain === 'SALVAGE'
      ? 'SALVAGE_AND_EXPORT'
      : 'CANNABIS_NURSERY_AND_PROCESSING';

  if (
    !isNonEmptyTrimmedString(input.entityOrganizationId) ||
    !isNonEmptyTrimmedString(input.locationOrganizationId) ||
    input.entityOrganizationId.trim() !== input.locationOrganizationId.trim() ||
    input.locationAllowedOrgType !== expectedOrgType
  ) {
    return {
      allowed: false,
      blockingCodes: ['SITE_ZONING_VIOLATION'],
      warnings: [],
      overrideApplied: false,
      cfoOverrideAudit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
    };
  }

  if (input.locationOperationalStatus === 'DORMANT_FUTURE') {
    return {
      allowed: false,
      blockingCodes: ['LOCATION_DORMANT_FUTURE'],
      warnings: [],
      overrideApplied: false,
      cfoOverrideAudit: {
        overrideApplied: false,
        approvedById: null,
        reasonNote: null,
      },
    };
  }

  const warnings: string[] = [];
  const blockingCodes: DomainRuleErrorCode[] = [];

  if (input.locationOperationalStatus === 'PROPOSED_INACTIVE') {
    const statusDecision = evaluateRegulatoryComplianceCheck(
      input.complianceEnforcementMode,
      'PROPOSED_INACTIVE_LOCATION_WARNING',
    );
    warnings.push(...statusDecision.warnings);
    blockingCodes.push(...statusDecision.blockingCodes);
  }

  if (
    input.requiresFluidDrainageCheck &&
    !input.allowsWholeVehicleDismantling &&
    input.fluidsDrainedAt === null
  ) {
    const envDecision = evaluateRegulatoryComplianceCheck(
      input.complianceEnforcementMode,
      'COMPLIANCE_WARNING_UNDRAINED_FARM',
    );
    warnings.push(...envDecision.warnings);
    blockingCodes.push(...envDecision.blockingCodes);
  } else if (
    input.requiresFluidDrainageCheck &&
    !input.allowsWholeVehicleDismantling &&
    input.fluidsDrainedAt !== null
  ) {
    parseUtcDate(input.fluidsDrainedAt, 'fluidsDrainedAt');
  }

  return {
    allowed: blockingCodes.length === 0,
    blockingCodes,
    warnings,
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
  };
}

export interface PartStateSnapshot {
  readonly custodyState: PartCustodyState;
  readonly availabilityState: InventoryAvailabilityState;
  readonly ebaySyncState: EbaySyncState;
  readonly classifiedsSyncState: ClassifiedsSyncState;
  readonly complianceState: PartComplianceState;
}

export type PartTransitionEvent =
  | 'SHELVE_IN_ORIGIN_CONTAINER'
  | 'CLEAR_FOR_SALE'
  | 'EXPORT_EBAY_CSV'
  | 'CONFIRM_EBAY_LIVE'
  | 'POST_CLASSIFIEDS'
  | 'MARK_CLASSIFIEDS_DELISTED'
  | 'CHECKOUT_DOMESTIC'
  | 'CONFIRM_EBAY_DELISTED'
  | 'RETURN_FROM_BUYER'
  | 'CLEAR_RETURN_QC'
  | 'FAIL_RETURN_QC_SCRAP'
  | 'SCRAP_OR_DAMAGE'
  | 'REQUEST_EXPORT_LOCK'
  | 'CONFIRM_EXPORT_LOCK'
  | 'EBAY_ORDER_COMMITTED_DURING_EXPORT_LOCK'
  | 'LOAD_ONTO_EXPORT_PALLET';

export interface PartTransitionFacts {
  readonly ebayListingId?: string | null;
  readonly ebayDelistAttested?: boolean;
  readonly tdgHazmatCode?: TdgHazmatCode;
  readonly weightKg?: number;
  readonly heavyLocalOnlyThresholdKg?: number;
  readonly originBinBarcode?: string | null;
  readonly qcPassed?: boolean;
  readonly steeringSideCompatibility?: SteeringSideCompatibility;
  readonly oemFitmentVerified?: boolean;
  readonly destinationDriveSide?: 'RHD' | 'LHD';
  readonly hasVerifiedBuyerWishListException?: boolean;
  readonly complianceEnforcementMode?: ComplianceEnforcementMode;
  readonly locationCheck?: LocationCustodyCheckInput;
}

export interface PartTransitionResult {
  readonly nextState: PartStateSnapshot;
  readonly warnings: readonly string[];
}

function assertNotQcHeldOrQuarantined(current: PartStateSnapshot): void {
  if (
    current.custodyState === 'RESTOCKED_QC_HOLD' ||
    current.availabilityState === 'RETURNED_QC_HOLD'
  ) {
    throw new DomainRuleError(
      'PART_QC_HOLD_ACTIVE',
      'Returned part is in QC hold and cannot be sold or syndicated until cleared.',
    );
  }
  if (current.complianceState === 'QUARANTINED_RECALL_OR_DG') {
    throw new DomainRuleError(
      'PART_QUARANTINED',
      'Quarantined part cannot be cleared or syndicated for sale.',
    );
  }
}

export function validatePartTransition(
  current: PartStateSnapshot,
  event: PartTransitionEvent,
  facts: PartTransitionFacts = {},
): PartTransitionResult {
  const next: PartStateSnapshot = { ...current };
  const warnings: string[] = [];

  if (facts.locationCheck) {
    const locDecision = evaluateLocationCustodyCheck(facts.locationCheck);
    if (!locDecision.allowed) {
      throw new DomainRuleError(
        locDecision.blockingCodes[0] ?? 'SITE_ZONING_VIOLATION',
        'Location custody check denied transition.',
        { blockingCodes: locDecision.blockingCodes },
      );
    }
    warnings.push(...locDecision.warnings);
  }

  switch (event) {
    case 'SHELVE_IN_ORIGIN_CONTAINER': {
      if (
        current.custodyState === 'RESTOCKED_QC_HOLD' ||
        current.availabilityState === 'RETURNED_QC_HOLD'
      ) {
        throw new DomainRuleError(
          'PART_QC_HOLD_ACTIVE',
          'Returned QC-held part must pass CLEAR_RETURN_QC rather than normal shelving.',
        );
      }
      if (current.custodyState !== 'STRIPPED_RAW_OFFLINE') {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot shelve part from custodyState ${current.custodyState}.`,
        );
      }
      assertNonEmptyTrimmedString(
        facts.originBinBarcode,
        'INVALID_PART_TRANSITION',
        'originBinBarcode is required to shelve part in origin container.',
      );
      return {
        nextState: {
          ...next,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
        },
        warnings,
      };
    }

    case 'CLEAR_FOR_SALE': {
      assertNotQcHeldOrQuarantined(current);
      if (
        current.complianceState !== 'PENDING_ENRICHMENT' &&
        current.complianceState !== 'NEEDS_HUMAN_REVIEW'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot clear compliance from ${current.complianceState}.`,
        );
      }
      if (
        facts.tdgHazmatCode === 'UN3268_AIRBAG' ||
        facts.tdgHazmatCode === 'UN0503_PYROTECHNIC'
      ) {
        throw new DomainRuleError(
          'PART_QUARANTINED',
          `Airbag/pyrotechnic TDG hazmat (${facts.tdgHazmatCode}) remains quarantined.`,
        );
      }
      return {
        nextState: {
          ...next,
          complianceState: 'CLEARED_FOR_SALE',
        },
        warnings,
      };
    }

    case 'EXPORT_EBAY_CSV': {
      assertNotQcHeldOrQuarantined(current);
      if (
        current.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
        current.availabilityState !== 'AVAILABLE' ||
        current.complianceState !== 'CLEARED_FOR_SALE'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'Part must be SHELVED_ORIGIN_CONTAINER, AVAILABLE, and CLEARED_FOR_SALE for eBay CSV export.',
        );
      }
      if (
        current.ebaySyncState !== 'NOT_LISTED' &&
        current.ebaySyncState !== 'DELISTED'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot export eBay CSV from ebaySyncState ${current.ebaySyncState}.`,
        );
      }
      if (!facts.tdgHazmatCode || facts.tdgHazmatCode !== 'NONE') {
        throw new DomainRuleError(
          'HAZMAT_PARCEL_SHIPPING_BLOCKED',
          'TDG hazmat parts cannot be exported for eBay parcel shipping.',
        );
      }
      const threshold = facts.heavyLocalOnlyThresholdKg ?? 15.0;
      if (
        typeof facts.weightKg !== 'number' ||
        !Number.isFinite(facts.weightKg) ||
        facts.weightKg <= 0 ||
        facts.weightKg >= threshold
      ) {
        throw new DomainRuleError(
          'PART_NOT_EBAY_PARCEL_ELIGIBLE',
          'Part weight is ineligible for eBay parcel shipping.',
        );
      }
      return {
        nextState: {
          ...next,
          ebaySyncState: 'CSV_EXPORTED_PENDING_CONFIRMATION',
        },
        warnings,
      };
    }

    case 'CONFIRM_EBAY_LIVE': {
      assertNotQcHeldOrQuarantined(current);
      if (
        current.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
        current.availabilityState !== 'AVAILABLE' ||
        current.complianceState !== 'CLEARED_FOR_SALE' ||
        current.ebaySyncState !== 'CSV_EXPORTED_PENDING_CONFIRMATION'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Two-step confirmation requires CSV_EXPORTED_PENDING_CONFIRMATION; got ${current.ebaySyncState}.`,
        );
      }
      assertNonEmptyTrimmedString(
        facts.ebayListingId,
        'EBAY_LISTING_ID_REQUIRED',
        'A non-empty ebayListingId is required to confirm SYNDICATED_LIVE.',
      );
      return {
        nextState: {
          ...next,
          ebaySyncState: 'SYNDICATED_LIVE',
        },
        warnings,
      };
    }

    case 'POST_CLASSIFIEDS': {
      assertNotQcHeldOrQuarantined(current);
      if (
        current.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
        current.availabilityState !== 'AVAILABLE' ||
        current.complianceState !== 'CLEARED_FOR_SALE'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'Part must be shelved, available, and cleared to post to classifieds.',
        );
      }
      if (
        current.classifiedsSyncState !== 'NOT_POSTED' &&
        current.classifiedsSyncState !== 'DELISTED'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot post classifieds from ${current.classifiedsSyncState}.`,
        );
      }
      return {
        nextState: {
          ...next,
          classifiedsSyncState: 'POSTED_LIVE',
        },
        warnings,
      };
    }

    case 'MARK_CLASSIFIEDS_DELISTED': {
      if (
        current.classifiedsSyncState !== 'POSTED_LIVE' &&
        current.classifiedsSyncState !== 'DELIST_REQUIRED'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot mark classifieds delisted from ${current.classifiedsSyncState}.`,
        );
      }
      return {
        nextState: {
          ...next,
          classifiedsSyncState: 'DELISTED',
        },
        warnings,
      };
    }

    case 'CHECKOUT_DOMESTIC': {
      assertNotQcHeldOrQuarantined(current);
      if (current.custodyState !== 'SHELVED_ORIGIN_CONTAINER') {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot checkout part in custodyState ${current.custodyState}.`,
        );
      }
      if (
        current.availabilityState !== 'AVAILABLE' &&
        current.availabilityState !== 'RESERVED_B2B_HOLD'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot checkout part in availabilityState ${current.availabilityState}.`,
        );
      }
      if (current.complianceState !== 'CLEARED_FOR_SALE') {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Part complianceState ${current.complianceState} is not CLEARED_FOR_SALE.`,
        );
      }
      if (
        current.ebaySyncState === 'EXPORT_LOCK_PENDING' ||
        current.ebaySyncState === 'EXPORT_LOCK_CONFIRMED'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Part is in export lock state ${current.ebaySyncState}.`,
        );
      }

      let nextEbaySyncState = current.ebaySyncState;
      if (current.ebaySyncState === 'SYNDICATED_LIVE') {
        if (facts.ebayDelistAttested !== true) {
          throw new DomainRuleError(
            'EBAY_DELIST_ATTESTATION_REQUIRED',
            'Operator must attest "Delist on eBay First" when checking out a SYNDICATED_LIVE part locally.',
          );
        }
        nextEbaySyncState = 'DELIST_PENDING';
      } else if (current.ebaySyncState === 'CSV_EXPORTED_PENDING_CONFIRMATION') {
        nextEbaySyncState = 'DELIST_PENDING';
      }

      const nextClassifiedsState: ClassifiedsSyncState =
        current.classifiedsSyncState === 'POSTED_LIVE'
          ? 'DELIST_REQUIRED'
          : current.classifiedsSyncState;

      return {
        nextState: {
          ...next,
          custodyState: 'SOLD_AND_RELEASED',
          availabilityState: 'PAID_SETTLED',
          ebaySyncState: nextEbaySyncState,
          classifiedsSyncState: nextClassifiedsState,
        },
        warnings,
      };
    }

    case 'CONFIRM_EBAY_DELISTED': {
      if (
        current.ebaySyncState !== 'DELIST_PENDING' &&
        current.ebaySyncState !== 'SYNDICATED_LIVE' &&
        current.ebaySyncState !== 'EXPORT_LOCK_PENDING'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot confirm eBay delisted from ${current.ebaySyncState}.`,
        );
      }
      return {
        nextState: {
          ...next,
          ebaySyncState: 'DELISTED',
        },
        warnings,
      };
    }

    case 'RETURN_FROM_BUYER': {
      if (current.custodyState !== 'SOLD_AND_RELEASED') {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Only SOLD_AND_RELEASED parts can enter buyer return QC hold; got ${current.custodyState}.`,
        );
      }
      return {
        nextState: {
          custodyState: 'RESTOCKED_QC_HOLD',
          availabilityState: 'RETURNED_QC_HOLD',
          ebaySyncState: 'DELISTED',
          classifiedsSyncState:
            current.classifiedsSyncState === 'POSTED_LIVE'
              ? 'DELIST_REQUIRED'
              : current.classifiedsSyncState,
          complianceState: 'NEEDS_HUMAN_REVIEW',
        },
        warnings,
      };
    }

    case 'CLEAR_RETURN_QC': {
      if (
        current.custodyState !== 'RESTOCKED_QC_HOLD' ||
        current.availabilityState !== 'RETURNED_QC_HOLD'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'Part must be in RESTOCKED_QC_HOLD + RETURNED_QC_HOLD to clear return QC.',
        );
      }
      if (facts.qcPassed !== true) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'Explicit passed operator QC inspection (qcPassed=true) is required.',
        );
      }
      assertNonEmptyTrimmedString(
        facts.originBinBarcode,
        'INVALID_PART_TRANSITION',
        'Origin bin evidence is required to restock a QC-cleared return.',
      );
      if (
        facts.tdgHazmatCode === 'UN3268_AIRBAG' ||
        facts.tdgHazmatCode === 'UN0503_PYROTECHNIC'
      ) {
        throw new DomainRuleError(
          'PART_QUARANTINED',
          'Quarantined airbag/pyrotechnic parts cannot be cleared to AVAILABLE.',
        );
      }
      return {
        nextState: {
          ...next,
          custodyState: 'SHELVED_ORIGIN_CONTAINER',
          availabilityState: 'AVAILABLE',
          complianceState: 'CLEARED_FOR_SALE',
          ebaySyncState: 'DELISTED',
        },
        warnings,
      };
    }

    case 'FAIL_RETURN_QC_SCRAP': {
      if (
        current.custodyState !== 'RESTOCKED_QC_HOLD' ||
        current.availabilityState !== 'RETURNED_QC_HOLD'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'FAIL_RETURN_QC_SCRAP applies only to parts in RESTOCKED_QC_HOLD.',
        );
      }
      if (facts.qcPassed !== false) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'qcPassed must be false to scrap a failed return.',
        );
      }
      return {
        nextState: {
          ...next,
          custodyState: 'SCRAPPED_OR_DAMAGED',
          availabilityState: 'RETURNED_QC_HOLD',
          complianceState:
            current.complianceState === 'QUARANTINED_RECALL_OR_DG'
              ? 'QUARANTINED_RECALL_OR_DG'
              : 'NEEDS_HUMAN_REVIEW',
          ebaySyncState:
            current.ebaySyncState === 'SYNDICATED_LIVE'
              ? 'DELIST_PENDING'
              : 'DELISTED',
          classifiedsSyncState:
            current.classifiedsSyncState === 'POSTED_LIVE'
              ? 'DELIST_REQUIRED'
              : current.classifiedsSyncState,
        },
        warnings,
      };
    }

    case 'SCRAP_OR_DAMAGE': {
      if (
        current.custodyState === 'SOLD_AND_RELEASED' ||
        current.custodyState === 'SCRAPPED_OR_DAMAGED' ||
        current.custodyState === 'IN_TRANSIT_OCEAN_FREIGHT'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Cannot scrap part from custodyState ${current.custodyState}.`,
        );
      }
      return {
        nextState: {
          ...next,
          custodyState: 'SCRAPPED_OR_DAMAGED',
          availabilityState: 'RETURNED_QC_HOLD',
          complianceState:
            current.complianceState === 'QUARANTINED_RECALL_OR_DG'
              ? 'QUARANTINED_RECALL_OR_DG'
              : 'NEEDS_HUMAN_REVIEW',
          ebaySyncState:
            current.ebaySyncState === 'SYNDICATED_LIVE'
              ? 'DELIST_PENDING'
              : current.ebaySyncState,
          classifiedsSyncState:
            current.classifiedsSyncState === 'POSTED_LIVE'
              ? 'DELIST_REQUIRED'
              : current.classifiedsSyncState,
        },
        warnings,
      };
    }

    case 'REQUEST_EXPORT_LOCK': {
      assertNotQcHeldOrQuarantined(current);
      if (
        current.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
        current.availabilityState !== 'AVAILABLE' ||
        current.complianceState !== 'CLEARED_FOR_SALE' ||
        current.ebaySyncState !== 'SYNDICATED_LIVE'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'REQUEST_EXPORT_LOCK requires SHELVED_ORIGIN_CONTAINER, AVAILABLE, CLEARED_FOR_SALE, and SYNDICATED_LIVE.',
        );
      }
      return {
        nextState: {
          ...next,
          ebaySyncState: 'EXPORT_LOCK_PENDING',
        },
        warnings,
      };
    }

    case 'CONFIRM_EXPORT_LOCK': {
      if (current.ebaySyncState !== 'EXPORT_LOCK_PENDING') {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `CONFIRM_EXPORT_LOCK requires EXPORT_LOCK_PENDING; got ${current.ebaySyncState}.`,
        );
      }
      if (current.availabilityState === 'COMMITTED_DOMESTIC_SALE') {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'Part was committed to a domestic eBay order during export lock.',
        );
      }
      return {
        nextState: {
          ...next,
          ebaySyncState: 'EXPORT_LOCK_CONFIRMED',
        },
        warnings,
      };
    }

    case 'EBAY_ORDER_COMMITTED_DURING_EXPORT_LOCK': {
      if (
        current.ebaySyncState !== 'EXPORT_LOCK_PENDING' &&
        current.ebaySyncState !== 'SYNDICATED_LIVE'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          `Unexpected eBay order commitment in ebaySyncState ${current.ebaySyncState}.`,
        );
      }
      return {
        nextState: {
          ...next,
          availabilityState: 'COMMITTED_DOMESTIC_SALE',
          ebaySyncState: 'DELISTED',
        },
        warnings,
      };
    }

    case 'LOAD_ONTO_EXPORT_PALLET': {
      assertNotQcHeldOrQuarantined(current);
      if (
        current.custodyState !== 'SHELVED_ORIGIN_CONTAINER' ||
        current.availabilityState !== 'AVAILABLE' ||
        current.complianceState !== 'CLEARED_FOR_SALE'
      ) {
        throw new DomainRuleError(
          'INVALID_PART_TRANSITION',
          'Part must be SHELVED_ORIGIN_CONTAINER, AVAILABLE, and CLEARED_FOR_SALE to load onto export pallet.',
        );
      }
      if (
        current.ebaySyncState !== 'NOT_LISTED' &&
        current.ebaySyncState !== 'DELISTED' &&
        current.ebaySyncState !== 'EXPORT_LOCK_CONFIRMED'
      ) {
        throw new DomainRuleError(
          'EXPORT_LOCK_NOT_CONFIRMED',
          `Cannot load onto export pallet while ebaySyncState is ${current.ebaySyncState}.`,
        );
      }
      if (facts.steeringSideCompatibility !== undefined) {
        const fitment = evaluateExportFitmentEligibility({
          steeringSideCompatibility: facts.steeringSideCompatibility,
          oemFitmentVerified: facts.oemFitmentVerified ?? false,
          destinationDriveSide: facts.destinationDriveSide ?? 'RHD',
          hasVerifiedBuyerWishListException:
            facts.hasVerifiedBuyerWishListException ?? false,
        });
        if (!fitment.allowed) {
          throw new DomainRuleError(
            fitment.blockingCodes[0] ?? 'LHD_PART_BLOCKED_FOR_RHD_EXPORT',
            'Part failed export fitment eligibility.',
            { blockingCodes: fitment.blockingCodes },
          );
        }
      }
      return {
        nextState: {
          ...next,
          custodyState: 'ON_EXPORT_PALLET',
        },
        warnings,
      };
    }
  }
}

export interface ExportSealCandidatePart {
  readonly partId: string;
  readonly state: PartStateSnapshot;
}

export interface ExportSealEligibilityResult
  extends GateDecision<'EXPORT_LOCK_NOT_CONFIRMED' | 'INVALID_PART_TRANSITION'> {
  readonly blockingPartIds: readonly string[];
}

export function evaluateExportSealEligibility(
  parts: ReadonlyArray<ExportSealCandidatePart>,
): ExportSealEligibilityResult {
  const blockingCodes = new Set<
    'EXPORT_LOCK_NOT_CONFIRMED' | 'INVALID_PART_TRANSITION'
  >();
  const blockingPartIds: string[] = [];

  for (const item of parts) {
    const { state } = item;
    let partBlocked = false;
    if (
      state.ebaySyncState === 'EXPORT_LOCK_PENDING' ||
      state.ebaySyncState === 'SYNDICATED_LIVE' ||
      state.ebaySyncState === 'CSV_EXPORTED_PENDING_CONFIRMATION' ||
      state.ebaySyncState === 'DELIST_PENDING'
    ) {
      blockingCodes.add('EXPORT_LOCK_NOT_CONFIRMED');
      partBlocked = true;
    }
    if (
      state.custodyState === 'STRIPPED_RAW_OFFLINE' ||
      state.custodyState === 'RESTOCKED_QC_HOLD' ||
      state.custodyState === 'SCRAPPED_OR_DAMAGED' ||
      state.custodyState === 'SOLD_AND_RELEASED' ||
      state.availabilityState === 'COMMITTED_DOMESTIC_SALE' ||
      state.availabilityState === 'RETURNED_QC_HOLD' ||
      state.availabilityState === 'PAID_SETTLED' ||
      state.complianceState === 'QUARANTINED_RECALL_OR_DG'
    ) {
      blockingCodes.add('INVALID_PART_TRANSITION');
      partBlocked = true;
    }
    if (partBlocked) {
      blockingPartIds.push(item.partId);
    }
  }

  return {
    allowed: blockingCodes.size === 0,
    blockingCodes: [...blockingCodes],
    warnings: [],
    blockingPartIds,
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
  };
}

export interface PaymentSettlementSnapshot {
  readonly paymentSettlementState: PaymentSettlementState;
  readonly cashCustodyState: CashCustodyState;
  readonly paymentMethod: string;
  readonly paymentConfirmedAt: Date | string | null;
  readonly bankSettledAt: Date | string | null;
  readonly bankDepositReference: string | null;
  readonly isVoidedOrReversed: boolean;
  readonly voidReason: string | null;
}

const ALLOWED_SETTLEMENT_EDGES: Readonly<
  Record<PaymentSettlementState, ReadonlySet<PaymentSettlementState>>
> = {
  SALE_RECORDED: new Set<PaymentSettlementState>([
    'SALE_RECORDED',
    'PAYMENT_INITIATED',
    'PAYMENT_CONFIRMED',
    'MARKETPLACE_PAYOUT_PENDING',
    'BANK_SETTLEMENT_PENDING',
    'BANK_SETTLEMENT_CONFIRMED', // Guarded strictly below for VERIFIED_BANK_WIRE only
    'REFUNDED_OR_CHARGED_BACK',
  ]),
  PAYMENT_INITIATED: new Set<PaymentSettlementState>([
    'PAYMENT_INITIATED',
    'PAYMENT_CONFIRMED',
    'BANK_SETTLEMENT_PENDING',
    'BANK_SETTLEMENT_CONFIRMED', // Guarded strictly below for VERIFIED_BANK_WIRE only
    'REFUNDED_OR_CHARGED_BACK',
  ]),
  PAYMENT_CONFIRMED: new Set<PaymentSettlementState>([
    'PAYMENT_CONFIRMED',
    'BANK_SETTLEMENT_CONFIRMED', // Verified cash sweep to corporate bank
    'REFUNDED_OR_CHARGED_BACK',
  ]),
  MARKETPLACE_PAYOUT_PENDING: new Set<PaymentSettlementState>([
    'MARKETPLACE_PAYOUT_PENDING',
    'BANK_SETTLEMENT_PENDING',
    'BANK_SETTLEMENT_CONFIRMED',
    'REFUNDED_OR_CHARGED_BACK',
  ]),
  BANK_SETTLEMENT_PENDING: new Set<PaymentSettlementState>([
    'BANK_SETTLEMENT_PENDING',
    'BANK_SETTLEMENT_CONFIRMED',
    'REFUNDED_OR_CHARGED_BACK',
  ]),
  BANK_SETTLEMENT_CONFIRMED: new Set<PaymentSettlementState>([
    'BANK_SETTLEMENT_CONFIRMED',
    'REFUNDED_OR_CHARGED_BACK',
  ]),
  REFUNDED_OR_CHARGED_BACK: new Set<PaymentSettlementState>([
    'REFUNDED_OR_CHARGED_BACK',
  ]),
};

export function validatePaymentSettlementInvariants(
  snapshot: PaymentSettlementSnapshot,
): PaymentSettlementSnapshot {
  const {
    paymentSettlementState,
    cashCustodyState,
    paymentConfirmedAt,
    bankSettledAt,
    bankDepositReference,
    isVoidedOrReversed,
    voidReason,
  } = snapshot;

  if (
    paymentSettlementState === 'SALE_RECORDED' ||
    paymentSettlementState === 'PAYMENT_INITIATED' ||
    paymentSettlementState === 'MARKETPLACE_PAYOUT_PENDING' ||
    paymentSettlementState === 'BANK_SETTLEMENT_PENDING'
  ) {
    if (cashCustodyState !== 'PENDING_EXTERNAL_RECEIVABLE') {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        `${paymentSettlementState} must pair with PENDING_EXTERNAL_RECEIVABLE; got ${cashCustodyState}.`,
      );
    }
    if (bankSettledAt !== null) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        `${paymentSettlementState} cannot have bankSettledAt populated.`,
      );
    }
    if (isVoidedOrReversed) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        `${paymentSettlementState} cannot have isVoidedOrReversed = true.`,
      );
    }
  } else if (paymentSettlementState === 'PAYMENT_CONFIRMED') {
    if (
      cashCustodyState !== 'HELD_IN_OPERATOR_FLOAT' &&
      cashCustodyState !== 'HELD_IN_DESTINATION_VAULT' &&
      cashCustodyState !== 'DEPOSITED_DESTINATION_BANK'
    ) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        `PAYMENT_CONFIRMED requires float/vault custody; got ${cashCustodyState}.`,
      );
    }
    if (paymentConfirmedAt === null) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        'PAYMENT_CONFIRMED requires paymentConfirmedAt.',
      );
    }
    parseUtcDate(paymentConfirmedAt, 'paymentConfirmedAt');
    if (bankSettledAt !== null) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        'PAYMENT_CONFIRMED cannot have bankSettledAt populated before bank settlement.',
      );
    }
    if (isVoidedOrReversed) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        'PAYMENT_CONFIRMED cannot have isVoidedOrReversed = true.',
      );
    }
  } else if (paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED') {
    if (cashCustodyState !== 'SETTLED_ORIGIN_CORP_BANK') {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        `BANK_SETTLEMENT_CONFIRMED requires SETTLED_ORIGIN_CORP_BANK; got ${cashCustodyState}.`,
      );
    }
    if (bankSettledAt === null) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        'BANK_SETTLEMENT_CONFIRMED requires bankSettledAt.',
      );
    }
    parseUtcDate(bankSettledAt, 'bankSettledAt');
    assertNonEmptyTrimmedString(
      bankDepositReference,
      'INVALID_PAYMENT_CUSTODY_STATE',
      'BANK_SETTLEMENT_CONFIRMED requires a non-empty bankDepositReference.',
    );
    if (isVoidedOrReversed) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        'BANK_SETTLEMENT_CONFIRMED cannot have isVoidedOrReversed = true.',
      );
    }
  } else if (paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK') {
    if (!isVoidedOrReversed) {
      throw new DomainRuleError(
        'INVALID_PAYMENT_CUSTODY_STATE',
        'REFUNDED_OR_CHARGED_BACK requires isVoidedOrReversed = true.',
      );
    }
    assertNonEmptyTrimmedString(
      voidReason,
      'INVALID_PAYMENT_CUSTODY_STATE',
      'REFUNDED_OR_CHARGED_BACK requires a non-empty voidReason.',
    );
  }

  return {
    ...snapshot,
    bankDepositReference: bankDepositReference?.trim() ?? null,
    voidReason: voidReason?.trim() ?? null,
  };
}

/**
 * Authoritative pure PaymentSettlementState x CashCustodyState transition guard (FIX 05).
 *
 * SQL compatibility note (Issue #2 migration 0001):
 * `salvage.enforce_sale_settlement_transition()` in migration 0001 currently allows
 * `SALE_RECORDED -> PAYMENT_INITIATED | MARKETPLACE_PAYOUT_PENDING` only and does not
 * yet permit `SALE_RECORDED -> PAYMENT_CONFIRMED | BANK_SETTLEMENT_PENDING` or
 * `PAYMENT_CONFIRMED -> BANK_SETTLEMENT_CONFIRMED` (cash sweep). Future DB integration
 * must reconcile that trigger before persisting those additional valid forward edges.
 */
export function validatePaymentSettlementTransition(
  current: PaymentSettlementSnapshot,
  target: PaymentSettlementSnapshot,
): PaymentSettlementSnapshot {
  if (
    current.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK' &&
    target.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK'
  ) {
    throw new DomainRuleError(
      'INVALID_PAYMENT_SETTLEMENT_TRANSITION',
      'REFUNDED_OR_CHARGED_BACK is terminal and cannot transition to another state.',
    );
  }

  const allowedTargets =
    ALLOWED_SETTLEMENT_EDGES[current.paymentSettlementState];
  if (!allowedTargets.has(target.paymentSettlementState)) {
    throw new DomainRuleError(
      'INVALID_PAYMENT_SETTLEMENT_TRANSITION',
      `Illegal payment settlement transition from ${current.paymentSettlementState} to ${target.paymentSettlementState}.`,
    );
  }

  if (
    (current.paymentSettlementState === 'SALE_RECORDED' ||
      current.paymentSettlementState === 'PAYMENT_INITIATED') &&
    target.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' &&
    target.paymentMethod !== 'VERIFIED_BANK_WIRE'
  ) {
    throw new DomainRuleError(
      'INVALID_PAYMENT_SETTLEMENT_TRANSITION',
      'Direct confirmation from SALE_RECORDED/PAYMENT_INITIATED requires VERIFIED_BANK_WIRE.',
    );
  }

  return validatePaymentSettlementInvariants(target);
}

export interface VehicleLifecycleFacts {
  readonly assetCategory: AssetCategory;
  readonly operationalLane: OperationalLane;
  readonly scrapMetalTicketKey?: string | null;
  readonly catalyticConverterDisposition?: CatalyticConverterDisposition;
  readonly hasCatalyticConverterScrapLog?: boolean;
  readonly complianceEnforcementMode?: ComplianceEnforcementMode;
}

export interface VehicleLifecycleResult {
  readonly nextState: AssetLifecycleState;
  readonly warnings: readonly string[];
}

const VEHICLE_TERMINAL_STATES = new Set<AssetLifecycleState>([
  'SOLD_RETAIL_ONTARIO',
  'SCRAPPED_METAL_CLEARED',
  'SOLD_EXPORT_COD',
]);

export function validateVehicleLifecycleTransition(
  current: AssetLifecycleState,
  target: AssetLifecycleState,
  facts: VehicleLifecycleFacts,
): VehicleLifecycleResult {
  if (VEHICLE_TERMINAL_STATES.has(current)) {
    throw new DomainRuleError(
      'INVALID_VEHICLE_TRANSITION',
      `Vehicle lifecycle state ${current} is terminal.`,
    );
  }

  const warnings: string[] = [];
  let allowed = false;

  switch (current) {
    case 'PROPOSED_DEAL':
      allowed = target === 'ACQUIRED_IN_TRANSIT';
      break;
    case 'ACQUIRED_IN_TRANSIT':
      allowed = target === 'STAGED_ONTARIO_YARD';
      break;
    case 'STAGED_ONTARIO_YARD':
      if (target === 'IN_RAMSAYVILLE_SHOP') {
        allowed =
          facts.operationalLane === 'QUICK_TURN_BEATER' ||
          facts.operationalLane === 'HIGH_END_REBUILD';
      } else if (target === 'DISMANTLING_IN_PROGRESS') {
        allowed = facts.operationalLane === 'DISMANTLE_AND_EXPORT';
      } else if (target === 'MANIFESTED_WHOLE_EXPORT') {
        allowed = facts.operationalLane === 'WHOLE_UNIT_EXPORT';
      }
      break;
    case 'IN_RAMSAYVILLE_SHOP':
      if (target === 'DISMANTLING_IN_PROGRESS') {
        // Explicit shop-to-dismantling diversion
        allowed = true;
      } else if (target === 'PENDING_INSPECTION_CERT') {
        allowed = facts.assetCategory === 'AUTOMOBILE';
      } else if (target === 'READY_FOR_RETAIL_SALE') {
        // Non-automobile assets bypass DriveON road inspection checks
        allowed = facts.assetCategory !== 'AUTOMOBILE';
      }
      break;
    case 'PENDING_INSPECTION_CERT':
      allowed = target === 'READY_FOR_RETAIL_SALE';
      break;
    case 'READY_FOR_RETAIL_SALE':
      allowed = target === 'SOLD_RETAIL_ONTARIO';
      break;
    case 'DISMANTLING_IN_PROGRESS':
      allowed = target === 'HULK_AWAITING_SCRAP';
      break;
    case 'HULK_AWAITING_SCRAP':
      if (target === 'SCRAPPED_METAL_CLEARED') {
        assertNonEmptyTrimmedString(
          facts.scrapMetalTicketKey,
          'SCRAP_METAL_TICKET_REQUIRED',
          'Final bare-shell weigh-scale ticket is required to clear hulk.',
        );
        if (facts.assetCategory === 'AUTOMOBILE') {
          const catReconciled =
            facts.catalyticConverterDisposition === 'MISSING_AT_INTAKE' ||
            facts.catalyticConverterDisposition === 'SHELVED_AS_PART' ||
            (facts.catalyticConverterDisposition === 'LOGGED_SCRAP_SALE' &&
              facts.hasCatalyticConverterScrapLog === true);

          if (!catReconciled) {
            const catDecision = evaluateRegulatoryComplianceCheck(
              facts.complianceEnforcementMode ?? 'WARN_ONLY',
              'UNRECONCILED_CATALYTIC_CONVERTER',
            );
            if (!catDecision.allowed) {
              throw new DomainRuleError(
                catDecision.blockingCode ?? 'UNRECONCILED_CATALYTIC_CONVERTER',
                'Catalytic converter disposition is unreconciled.',
              );
            }
            warnings.push(...catDecision.warnings);
          }
        }
        allowed = true;
      }
      break;
    case 'MANIFESTED_WHOLE_EXPORT':
      allowed = target === 'LANDED_TRINIDAD_VAULT';
      break;
    case 'LANDED_TRINIDAD_VAULT':
      allowed = target === 'SOLD_EXPORT_COD';
      break;
  }

  if (!allowed) {
    throw new DomainRuleError(
      'INVALID_VEHICLE_TRANSITION',
      `Illegal Vehicle lifecycle transition from ${current} to ${target} (category=${facts.assetCategory}, lane=${facts.operationalLane}).`,
    );
  }

  return { nextState: target, warnings };
}

export interface ChannelRecommendationInput {
  readonly weightKg: number;
  readonly tdgHazmatCode: TdgHazmatCode;
  readonly complianceState: PartComplianceState;
}

export interface ChannelRecommendationResult {
  readonly isEbayParcelEligible: boolean;
  readonly isLocalSaleEligible: boolean;
  readonly isQuarantined: boolean;
  readonly recommendedPrimaryChannel: DomesticSaleChannel | null;
  readonly allowedLocalChannels: readonly DomesticSaleChannel[];
  readonly ebayShipFromCity: string;
  readonly ebayShipFromPostalCode: string;
  readonly publicPickupLocationLabel: string;
}

const LOCAL_PICKUP_CHANNELS: readonly DomesticSaleChannel[] = [
  'FB_MARKETPLACE_LOCAL',
  'KIJIJI_LOCAL',
  'LOCAL_WALK_IN_CASH',
  'WHOLESALE_MECHANIC_NETWORK',
  'CAR_PART_WHOLESALE',
];

export function recommendDomesticChannels(
  input: ChannelRecommendationInput,
  policy: Pick<PricingAndCompliancePolicy, 'domesticSyndication'>,
): ChannelRecommendationResult {
  if (
    typeof input.weightKg !== 'number' ||
    !Number.isFinite(input.weightKg) ||
    input.weightKg <= 0
  ) {
    throw new DomainRuleError(
      'INVALID_PART_WEIGHT',
      'weightKg must be a finite positive number.',
      { weightKg: input.weightKg },
    );
  }

  const isQuarantined =
    input.complianceState === 'QUARANTINED_RECALL_OR_DG' ||
    input.tdgHazmatCode === 'UN3268_AIRBAG' ||
    input.tdgHazmatCode === 'UN0503_PYROTECHNIC';

  if (isQuarantined) {
    return {
      isEbayParcelEligible: false,
      isLocalSaleEligible: false,
      isQuarantined: true,
      recommendedPrimaryChannel: null,
      allowedLocalChannels: [],
      ebayShipFromCity: policy.domesticSyndication.ebayShipFromCity,
      ebayShipFromPostalCode: policy.domesticSyndication.ebayShipFromPostalCode,
      publicPickupLocationLabel:
        policy.domesticSyndication.publicPickupLocationLabel,
    };
  }

  const isEbayParcelEligible =
    input.weightKg < policy.domesticSyndication.heavyLocalOnlyThresholdKg &&
    input.tdgHazmatCode === 'NONE';

  return {
    isEbayParcelEligible,
    isLocalSaleEligible: true,
    isQuarantined: false,
    recommendedPrimaryChannel: isEbayParcelEligible
      ? 'EBAY_MOTORS_SHIPPED'
      : 'FB_MARKETPLACE_LOCAL',
    allowedLocalChannels: LOCAL_PICKUP_CHANNELS,
    ebayShipFromCity: policy.domesticSyndication.ebayShipFromCity,
    ebayShipFromPostalCode: policy.domesticSyndication.ebayShipFromPostalCode,
    publicPickupLocationLabel:
      policy.domesticSyndication.publicPickupLocationLabel,
  };
}

export interface ExportFitmentEligibilityInput {
  readonly steeringSideCompatibility: SteeringSideCompatibility;
  readonly oemFitmentVerified: boolean;
  readonly destinationDriveSide?: 'RHD' | 'LHD';
  readonly hasVerifiedBuyerWishListException: boolean;
}

export interface ExportFitmentEligibilityResult
  extends GateDecision<
    'OEM_FITMENT_UNVERIFIED' | 'LHD_PART_BLOCKED_FOR_RHD_EXPORT'
  > {
  readonly wishListExceptionApplied: boolean;
}

export function evaluateExportFitmentEligibility(
  input: ExportFitmentEligibilityInput,
): ExportFitmentEligibilityResult {
  const blockingCodes: Array<
    'OEM_FITMENT_UNVERIFIED' | 'LHD_PART_BLOCKED_FOR_RHD_EXPORT'
  > = [];

  if (!input.oemFitmentVerified) {
    blockingCodes.push('OEM_FITMENT_UNVERIFIED');
  }

  const destinationDriveSide = input.destinationDriveSide ?? 'RHD';
  const wishListExceptionApplied =
    destinationDriveSide === 'RHD' &&
    input.steeringSideCompatibility === 'LHD_ONLY' &&
    input.hasVerifiedBuyerWishListException;

  if (
    destinationDriveSide === 'RHD' &&
    input.steeringSideCompatibility === 'LHD_ONLY' &&
    !input.hasVerifiedBuyerWishListException
  ) {
    blockingCodes.push('LHD_PART_BLOCKED_FOR_RHD_EXPORT');
  }

  return {
    allowed: blockingCodes.length === 0,
    blockingCodes,
    warnings: [],
    wishListExceptionApplied,
    overrideApplied: false,
    cfoOverrideAudit: {
      overrideApplied: false,
      approvedById: null,
      reasonNote: null,
    },
  };
}

const VALID_ARA_GRADES = new Set<AraConditionGradeEnum>([
  'GRADE_A',
  'GRADE_B1',
  'GRADE_B2',
  'GRADE_B3',
  'GRADE_C',
  'GRADE_X',
]);

export function validateAraGrade(grade: string): AraConditionGradeEnum {
  if (!VALID_ARA_GRADES.has(grade as AraConditionGradeEnum)) {
    throw new DomainRuleError(
      'INVALID_ARA_GRADE',
      `Invalid ARA condition grade: "${grade}".`,
      { grade },
    );
  }
  return grade as AraConditionGradeEnum;
}

const ARA_DAMAGE_CODE_PATTERN = /^(?:000|[1-9][DSRHPJKGT][1-9])$/;

export function validateDamageCode(code: string): string {
  if (typeof code !== 'string' || !ARA_DAMAGE_CODE_PATTERN.test(code)) {
    throw new DomainRuleError(
      'INVALID_ARA_DAMAGE_CODE',
      `Invalid 3-character ARA damage code: "${code}".`,
      { code },
    );
  }
  return code;
}

const MS_PER_UTC_DAY = 86_400_000;

export interface DriveOnTimersInput {
  readonly assetCategory: AssetCategory;
  readonly driveOnInitialFailAt: Date | string | null;
  readonly driveOnSscIssuedAt: Date | string | null;
  readonly now: Date | string;
}

export interface DriveOnTimersResult {
  readonly applicable: boolean;
  readonly driveOnReinspectionDeadlineAt: Date | null;
  readonly isReinspectionWindowExpired: boolean;
  readonly driveOnSscExpiresAt: Date | null;
  readonly isSscMissingOrExpired: boolean;
}

/**
 * Computes DriveON 10-day re-inspection and 36-day Safety Standards Certificate
 * deadlines using UTC calendar-day arithmetic (+ days * 86,400,000 ms).
 * Expiration triggers strictly when `now > expiry`.
 */
export function computeDriveOnTimers(
  input: DriveOnTimersInput,
  policy: Pick<PricingAndCompliancePolicy, 'complianceThresholds'>,
): DriveOnTimersResult {
  if (input.assetCategory !== 'AUTOMOBILE') {
    return {
      applicable: false,
      driveOnReinspectionDeadlineAt: null,
      isReinspectionWindowExpired: false,
      driveOnSscExpiresAt: null,
      isSscMissingOrExpired: false,
    };
  }

  const nowDate = parseUtcDate(input.now, 'now');
  const nowMs = nowDate.getTime();

  let driveOnReinspectionDeadlineAt: Date | null = null;
  let isReinspectionWindowExpired = false;
  if (input.driveOnInitialFailAt !== null) {
    const failDate = parseUtcDate(
      input.driveOnInitialFailAt,
      'driveOnInitialFailAt',
    );
    driveOnReinspectionDeadlineAt = new Date(
      failDate.getTime() +
        policy.complianceThresholds.driveOnReinspectionWindowDays *
          MS_PER_UTC_DAY,
    );
    isReinspectionWindowExpired =
      nowMs > driveOnReinspectionDeadlineAt.getTime();
  }

  let driveOnSscExpiresAt: Date | null = null;
  let isSscMissingOrExpired = true;
  if (input.driveOnSscIssuedAt !== null) {
    const issuedDate = parseUtcDate(
      input.driveOnSscIssuedAt,
      'driveOnSscIssuedAt',
    );
    driveOnSscExpiresAt = new Date(
      issuedDate.getTime() +
        policy.complianceThresholds.safetyStandardsCertMaxDays * MS_PER_UTC_DAY,
    );
    isSscMissingOrExpired = nowMs > driveOnSscExpiresAt.getTime();
  }

  return {
    applicable: true,
    driveOnReinspectionDeadlineAt,
    isReinspectionWindowExpired,
    driveOnSscExpiresAt,
    isSscMissingOrExpired,
  };
}
