import type {
  AssetCategory,
  AssetLifecycleState,
  LocationOperationalStatus,
  OrganizationType,
} from '@prisma/client';
import {
  type ComplianceEnforcementMode,
  evaluateLocationCustodyCheck,
} from '@/core/domain';

export type LocationCustodyErrorCode =
  | 'INVALID_SCAN_INPUT'
  | 'ENTITY_NOT_FOUND'
  | 'SITE_ZONING_VIOLATION'
  | 'LOCATION_DORMANT_INACTIVE'
  | 'LOCATION_PROPOSED_INACTIVE'
  | 'ENVIRONMENTAL_ZONING_VIOLATION'
  | 'LOCATION_CAPACITY_EXCEEDED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'CUSTODY_INTEGRITY_ERROR';

export type LocationCustodyErrorStatus = 400 | 404 | 409 | 422 | 500;

const LOCATION_CUSTODY_ERROR_STATUS_BY_CODE: Readonly<
  Record<LocationCustodyErrorCode, LocationCustodyErrorStatus>
> = {
  INVALID_SCAN_INPUT: 400,
  ENTITY_NOT_FOUND: 404,
  SITE_ZONING_VIOLATION: 422,
  LOCATION_DORMANT_INACTIVE: 422,
  LOCATION_PROPOSED_INACTIVE: 422,
  ENVIRONMENTAL_ZONING_VIOLATION: 422,
  LOCATION_CAPACITY_EXCEEDED: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  CUSTODY_INTEGRITY_ERROR: 500,
};

/**
 * Typed fail-closed location zoning and custody scan error with deterministic HTTP status.
 */
export class LocationCustodyError extends Error {
  public readonly code: LocationCustodyErrorCode;
  public readonly status: LocationCustodyErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: LocationCustodyErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'LocationCustodyError';
    this.code = code;
    this.status = LOCATION_CUSTODY_ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

/**
 * Explicit server-side Phase 1A normalized allowlist of fluid-bearing powertrain
 * part categories derived from `src/core/config/policy-loader.ts`.
 */
export const FLUID_BEARING_POWERTRAIN_PART_CATEGORIES: ReadonlySet<string> =
  new Set([
    'complete engine assembly',
    'complete spark-ignition engines (>1000cc)',
    'transmission / gearbox / transaxle',
    'gearboxes / transmissions',
    'transmission',
    'gearbox',
    'transaxle',
  ]);

export function normalizePartCategoryName(partCategoryName: string): string {
  return partCategoryName.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isFluidBearingPowertrainPartCategory(
  partCategoryName: string,
): boolean {
  if (typeof partCategoryName !== 'string') {
    return false;
  }
  return FLUID_BEARING_POWERTRAIN_PART_CATEGORIES.has(
    normalizePartCategoryName(partCategoryName),
  );
}

export const NON_COUNTED_CAPACITY_LIFECYCLE_STATES: ReadonlySet<AssetLifecycleState> =
  new Set<AssetLifecycleState>([
    'PROPOSED_DEAL',
    'SOLD_RETAIL_ONTARIO',
    'SOLD_EXPORT_COD',
    'SCRAPPED_METAL_CLEARED',
  ]);

export function isCountedCapacityVehicleLifecycleState(
  lifecycleState: AssetLifecycleState,
): boolean {
  return !NON_COUNTED_CAPACITY_LIFECYCLE_STATES.has(lifecycleState);
}

export function mergeComplianceWarnings(
  existingWarnings: readonly string[],
  newWarnings: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const w of existingWarnings) {
    if (!seen.has(w)) {
      seen.add(w);
      merged.push(w);
    }
  }
  for (const w of newWarnings) {
    if (!seen.has(w)) {
      seen.add(w);
      merged.push(w);
    }
  }

  return merged;
}

export interface ZoningLocationSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly allowedOrgType: OrganizationType;
  readonly locationOperationalStatus: LocationOperationalStatus;
  readonly allowsWholeVehicleDismantling: boolean;
  readonly maxActiveAssetCapacity: number | null;
  readonly fullQrBarcode: string;
}

export type ZoningEntitySnapshot =
  | {
      readonly kind: 'VEHICLE';
      readonly id: string;
      readonly organizationId: string;
      readonly assetCategory: AssetCategory;
      readonly lifecycleState: AssetLifecycleState;
      readonly storageLocationId: string | null;
      readonly fluidsDrainedAt: Date | string | null;
    }
  | {
      readonly kind: 'PART';
      readonly id: string;
      readonly organizationId: string;
      readonly partCategoryName: string;
      readonly storageLocationId: string | null;
      readonly donorVehicleFluidsDrainedAt: Date | string | null;
    };

export type CapacityGateEnforcementMode = 'HARD_BLOCK' | 'WARN_ONLY' | 'DISABLED';

export interface EvaluateLocationZoningInput {
  readonly activeOrganizationId: string;
  readonly activeOrganizationType: OrganizationType;
  readonly entity: ZoningEntitySnapshot;
  readonly location: ZoningLocationSnapshot;
  readonly complianceEnforcementMode: ComplianceEnforcementMode;
  readonly locationCapacityGateMode: CapacityGateEnforcementMode;
  readonly currentDestinationActiveAssetCount: number;
  readonly evaluateCapacity?: boolean;
  readonly cfoOverrideAuthorized?: boolean;
}

export interface LocationZoningCapacityEvaluation {
  readonly evaluated: boolean;
  readonly maxActiveAssetCapacity: number | null;
  readonly currentActiveAssetCount: number;
  readonly projectedActiveAssetCount: number;
}

export interface LocationZoningDecision {
  readonly allowed: true;
  readonly warnings: readonly string[];
  readonly overrideApplied: boolean;
  readonly capacityEvaluation: LocationZoningCapacityEvaluation;
}

/**
 * Data-driven StorageLocation zoning, operational status, O. Reg. 85/16 fluid drainage,
 * and active whole-asset capacity evaluator (`RULE-ZONE-001` & `RULE-ENV-001`).
 *
 * All evaluations rely strictly on database metadata flags (`allowedOrgType`,
 * `locationOperationalStatus`, `allowsWholeVehicleDismantling`, `maxActiveAssetCapacity`)
 * and never branch on hardcoded site or barcode strings (`KEMP`, `RAMS`, `POSV`, `BROCK`).
 */
export class LocationZoningService {
  public evaluateLocationZoning(
    input: EvaluateLocationZoningInput,
  ): LocationZoningDecision {
    const activeOrgId = input.activeOrganizationId.trim().toLowerCase();
    const entityOrgId = input.entity.organizationId.trim().toLowerCase();
    const locationOrgId = input.location.organizationId.trim().toLowerCase();

    if (
      activeOrgId.length === 0 ||
      input.activeOrganizationType !== 'SALVAGE_AND_EXPORT' ||
      entityOrgId !== activeOrgId
    ) {
      throw new LocationCustodyError(
        'SITE_ZONING_VIOLATION',
        'Active organization workspace does not match target salvage inventory.',
      );
    }

    const requiresFluidDrainageCheck =
      input.entity.kind === 'VEHICLE'
        ? input.entity.assetCategory === 'AUTOMOBILE'
        : isFluidBearingPowertrainPartCategory(input.entity.partCategoryName);

    const fluidsDrainedAt =
      input.entity.kind === 'VEHICLE'
        ? input.entity.fluidsDrainedAt
        : input.entity.donorVehicleFluidsDrainedAt;

    const custodyDecision = evaluateLocationCustodyCheck({
      entityOrganizationId: entityOrgId,
      entityDomain: 'SALVAGE',
      locationOrganizationId: locationOrgId,
      locationAllowedOrgType: input.location.allowedOrgType,
      locationOperationalStatus: input.location.locationOperationalStatus,
      allowsWholeVehicleDismantling:
        input.location.allowsWholeVehicleDismantling,
      requiresFluidDrainageCheck,
      fluidsDrainedAt,
      complianceEnforcementMode: input.complianceEnforcementMode,
    });

    if (!custodyDecision.allowed) {
      const firstBlock = custodyDecision.blockingCodes[0];
      switch (firstBlock) {
        case 'SITE_ZONING_VIOLATION':
          throw new LocationCustodyError(
            'SITE_ZONING_VIOLATION',
            'Destination storage location violates multi-tenant or organization-type zoning (RULE-ZONE-001).',
            { fullQrBarcode: input.location.fullQrBarcode },
          );
        case 'LOCATION_DORMANT_FUTURE':
          throw new LocationCustodyError(
            'LOCATION_DORMANT_INACTIVE',
            `Destination location "${input.location.fullQrBarcode}" is DORMANT_FUTURE and cannot accept custody scans.`,
            { fullQrBarcode: input.location.fullQrBarcode },
          );
        case 'LOCATION_PROPOSED_INACTIVE':
          throw new LocationCustodyError(
            'LOCATION_PROPOSED_INACTIVE',
            `Destination location "${input.location.fullQrBarcode}" is PROPOSED_INACTIVE and blocked under STRICT_BLOCK compliance mode.`,
            { fullQrBarcode: input.location.fullQrBarcode },
          );
        case 'ENVIRONMENTAL_ZONING_VIOLATION':
          throw new LocationCustodyError(
            'ENVIRONMENTAL_ZONING_VIOLATION',
            `Destination location "${input.location.fullQrBarcode}" prohibits undrained automobile or fluid-bearing powertrain storage under STRICT_BLOCK mode (RULE-ENV-001).`,
            { fullQrBarcode: input.location.fullQrBarcode },
          );
        default:
          throw new LocationCustodyError(
            'SITE_ZONING_VIOLATION',
            'Destination storage location denied custody scan.',
          );
      }
    }

    const warnings = mergeComplianceWarnings([], custodyDecision.warnings);
    const evaluateCapacity = input.evaluateCapacity !== false;
    const currentCount = input.currentDestinationActiveAssetCount;

    if (
      !Number.isSafeInteger(currentCount) ||
      currentCount < 0
    ) {
      throw new LocationCustodyError(
        'CUSTODY_INTEGRITY_ERROR',
        'currentDestinationActiveAssetCount must be a non-negative integer.',
      );
    }

    const maxCapacity = input.location.maxActiveAssetCapacity;
    if (
      maxCapacity !== null &&
      (!Number.isSafeInteger(maxCapacity) || maxCapacity < 0)
    ) {
      throw new LocationCustodyError(
        'CUSTODY_INTEGRITY_ERROR',
        'StorageLocation.maxActiveAssetCapacity must be null or a non-negative integer.',
      );
    }

    if (
      !evaluateCapacity ||
      input.entity.kind !== 'VEHICLE' ||
      maxCapacity === null
    ) {
      return {
        allowed: true,
        warnings,
        overrideApplied: false,
        capacityEvaluation: {
          evaluated: false,
          maxActiveAssetCapacity: maxCapacity,
          currentActiveAssetCount: currentCount,
          projectedActiveAssetCount: currentCount,
        },
      };
    }

    const incomingContributesOne =
      isCountedCapacityVehicleLifecycleState(input.entity.lifecycleState) &&
      input.entity.storageLocationId !== input.location.id;
    const projectedCount = currentCount + (incomingContributesOne ? 1 : 0);

    let overrideApplied = false;

    if (projectedCount > maxCapacity) {
      if (input.locationCapacityGateMode === 'WARN_ONLY') {
        warnings.push('LOCATION_CAPACITY_WARNING');
      } else if (input.locationCapacityGateMode === 'HARD_BLOCK') {
        if (input.cfoOverrideAuthorized === true) {
          overrideApplied = true;
        } else {
          throw new LocationCustodyError(
            'LOCATION_CAPACITY_EXCEEDED',
            `Destination location "${input.location.fullQrBarcode}" has reached maxActiveAssetCapacity (${maxCapacity}).`,
            {
              fullQrBarcode: input.location.fullQrBarcode,
              maxActiveAssetCapacity: maxCapacity,
              currentActiveAssetCount: currentCount,
              projectedActiveAssetCount: projectedCount,
            },
          );
        }
      }
    }

    return {
      allowed: true,
      warnings: mergeComplianceWarnings([], warnings),
      overrideApplied,
      capacityEvaluation: {
        evaluated: true,
        maxActiveAssetCapacity: maxCapacity,
        currentActiveAssetCount: currentCount,
        projectedActiveAssetCount: projectedCount,
      },
    };
  }
}
