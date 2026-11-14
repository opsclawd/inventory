import { ZodError } from 'zod';
import baselinePolicyJson from './pricing-policy.json';
import {
  IPolicyConfigPort,
  PricingAndCompliancePolicy,
  PricingAndCompliancePolicyInput,
  PricingAndCompliancePolicyInputSchema,
  PricingAndCompliancePolicyOverrideSchema,
  PricingAndCompliancePolicySchema,
} from '../ports';

export type SteeringSideCompatibilityValue = 'UNIVERSAL' | 'LHD_ONLY' | 'RHD_ONLY';

export type TdgHazmatCodeValue =
  | 'NONE'
  | 'UN3268_AIRBAG'
  | 'UN0503_PYROTECHNIC'
  | 'UN2794_WET_BATTERY'
  | 'UN3480_LITHIUM_BATTERY';

export class PolicyConfigError extends Error {
  public readonly code:
    | 'INVALID_ORGANIZATION_ID'
    | 'ORGANIZATION_NOT_FOUND'
    | 'ORGANIZATION_MISMATCH'
    | 'INVALID_POLICY_BASELINE'
    | 'INVALID_POLICY_OVERRIDE';

  public constructor(
    code: PolicyConfigError['code'],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PolicyConfigError';
    this.code = code;
  }
}

export interface OrganizationPolicyRecord {
  organizationId: string;
  policyConfigJson: unknown;
}

export type OrganizationPolicyReader = (
  organizationId: string,
) => Promise<OrganizationPolicyRecord | null>;

export interface JsonPolicyConfigAdapterOptions {
  baselinePolicy?: unknown;
  readOrganizationPolicy?: OrganizationPolicyReader;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafePlainTree(value: unknown, path = 'root'): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertSafePlainTree(value[i], `${path}[${i}]`);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new PolicyConfigError(
        'INVALID_POLICY_OVERRIDE',
        `Policy override value at ${path} must be a plain JSON object.`,
      );
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new PolicyConfigError(
          'INVALID_POLICY_OVERRIDE',
          `Forbidden key "${key}" detected at ${path}.`,
        );
      }
      assertSafePlainTree(value[key], `${path}.${key}`);
    }
  }
}

function deepCloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepCloneJson(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = deepCloneJson(value[key]);
    }
    return out as T;
  }
  return value;
}

function deepMergePlainObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = deepCloneJson(base);
  for (const key of Object.keys(override)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new PolicyConfigError(
        'INVALID_POLICY_OVERRIDE',
        `Forbidden key "${key}" detected during policy merge.`,
      );
    }
    const overrideVal = override[key];
    if (overrideVal === undefined) {
      continue;
    }
    const baseVal = result[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMergePlainObjects(baseVal, overrideVal);
    } else {
      result[key] = deepCloneJson(overrideVal);
    }
  }
  return result;
}

function normalizePolicy(
  input: PricingAndCompliancePolicyInput,
): PricingAndCompliancePolicy {
  const normalized: PricingAndCompliancePolicy = {
    ...deepCloneJson(input),
    operationalGates: {
      ...deepCloneJson(input.operationalGates),
      workingCapitalGate: {
        ...deepCloneJson(input.operationalGates.workingCapitalGate),
        tranches: input.operationalGates.workingCapitalGate.tranches.map(
          (tranche) => ({
            trancheCode: tranche.trancheCode,
            principalCadMinor: tranche.principalCadMinor,
            unlocked: tranche.unlocked,
            minShelvedSkus: tranche.minShelvedSkus ?? 0,
            minScrappedDonors: tranche.minScrappedDonors ?? 0,
            requireZeroOverdueFloatReceipts:
              tranche.requireZeroOverdueFloatReceipts ?? false,
          }),
        ),
      },
    },
  };

  return PricingAndCompliancePolicySchema.parse(normalized);
}

function validateAndSynchronizeTaxAliases(
  baseline: PricingAndCompliancePolicyInput,
  overrideTaxPolicy: Record<string, unknown> | undefined,
): void {
  if (!overrideTaxPolicy) {
    return;
  }

  const canonicalOverride = overrideTaxPolicy.isGstHstRegistered;
  const canonical =
    typeof canonicalOverride === 'boolean'
      ? canonicalOverride
      : baseline.domesticTaxPolicy.isGstHstRegistered;

  if (
    overrideTaxPolicy.isOntarioEntityHstRegistered !== undefined &&
    overrideTaxPolicy.isOntarioEntityHstRegistered !== canonical
  ) {
    throw new PolicyConfigError(
      'INVALID_POLICY_OVERRIDE',
      'Conflicting override for domesticTaxPolicy.isOntarioEntityHstRegistered relative to isGstHstRegistered.',
    );
  }

  if (
    overrideTaxPolicy.isOntarioHstRegistered !== undefined &&
    overrideTaxPolicy.isOntarioHstRegistered !== canonical
  ) {
    throw new PolicyConfigError(
      'INVALID_POLICY_OVERRIDE',
      'Conflicting override for domesticTaxPolicy.isOntarioHstRegistered relative to isGstHstRegistered.',
    );
  }
}

export class JsonPolicyConfigAdapter implements IPolicyConfigPort {
  private readonly baselineSource: unknown;
  private readonly readOrganizationPolicy?: OrganizationPolicyReader;

  public constructor(options: JsonPolicyConfigAdapterOptions = {}) {
    this.baselineSource =
      options.baselinePolicy !== undefined
        ? options.baselinePolicy
        : baselinePolicyJson;
    this.readOrganizationPolicy = options.readOrganizationPolicy;
  }

  private loadValidatedBaselineInput(): PricingAndCompliancePolicyInput {
    try {
      assertSafePlainTree(this.baselineSource, 'baseline');
      return PricingAndCompliancePolicyInputSchema.parse(
        deepCloneJson(this.baselineSource),
      );
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        throw new PolicyConfigError('INVALID_POLICY_BASELINE', err.message, err);
      }
      if (err instanceof ZodError) {
        throw new PolicyConfigError(
          'INVALID_POLICY_BASELINE',
          `Invalid baseline pricing policy: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          err,
        );
      }
      throw new PolicyConfigError(
        'INVALID_POLICY_BASELINE',
        'Failed to load baseline pricing policy.',
        err,
      );
    }
  }

  public async getPolicyForOrg(
    organizationId: string,
  ): Promise<PricingAndCompliancePolicy> {
    if (typeof organizationId !== 'string' || organizationId.trim().length === 0) {
      throw new PolicyConfigError(
        'INVALID_ORGANIZATION_ID',
        'organizationId must be a non-empty string.',
      );
    }

    const baselineInput = this.loadValidatedBaselineInput();

    if (!this.readOrganizationPolicy) {
      return normalizePolicy(baselineInput);
    }

    const record = await this.readOrganizationPolicy(organizationId);
    if (record === null) {
      throw new PolicyConfigError(
        'ORGANIZATION_NOT_FOUND',
        `Organization policy record not found for "${organizationId}".`,
      );
    }

    if (record.organizationId !== organizationId) {
      throw new PolicyConfigError(
        'ORGANIZATION_MISMATCH',
        `Organization policy record mismatch: expected "${organizationId}", received "${record.organizationId}".`,
      );
    }

    if (record.policyConfigJson === null || record.policyConfigJson === undefined) {
      return normalizePolicy(baselineInput);
    }

    if (!isPlainObject(record.policyConfigJson)) {
      throw new PolicyConfigError(
        'INVALID_POLICY_OVERRIDE',
        'Organization.policyConfigJson must be a plain JSON object or null.',
      );
    }

    assertSafePlainTree(record.policyConfigJson, 'override');

    let parsedOverride: Record<string, unknown>;
    try {
      parsedOverride = PricingAndCompliancePolicyOverrideSchema.parse(
        record.policyConfigJson,
      ) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ZodError) {
        throw new PolicyConfigError(
          'INVALID_POLICY_OVERRIDE',
          `Invalid organization policy override: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          err,
        );
      }
      throw new PolicyConfigError(
        'INVALID_POLICY_OVERRIDE',
        'Invalid organization policy override.',
        err,
      );
    }

    const overrideTaxPolicy = isPlainObject(parsedOverride.domesticTaxPolicy)
      ? parsedOverride.domesticTaxPolicy
      : undefined;
    validateAndSynchronizeTaxAliases(baselineInput, overrideTaxPolicy);

    const mergedRaw = deepMergePlainObjects(
      baselineInput as unknown as Record<string, unknown>,
      parsedOverride,
    );

    if (
      overrideTaxPolicy &&
      typeof overrideTaxPolicy.isGstHstRegistered === 'boolean' &&
      isPlainObject(mergedRaw.domesticTaxPolicy)
    ) {
      const canonical = overrideTaxPolicy.isGstHstRegistered;
      mergedRaw.domesticTaxPolicy.isOntarioEntityHstRegistered = canonical;
      mergedRaw.domesticTaxPolicy.isOntarioHstRegistered = canonical;
    }

    try {
      const validatedMerged =
        PricingAndCompliancePolicyInputSchema.parse(mergedRaw);
      return normalizePolicy(validatedMerged);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new PolicyConfigError(
          'INVALID_POLICY_OVERRIDE',
          `Merged policy failed validation: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          err,
        );
      }
      throw new PolicyConfigError(
        'INVALID_POLICY_OVERRIDE',
        'Merged policy failed validation.',
        err,
      );
    }
  }
}

/**
 * Default SteeringSideCompatibility lookup table grounded in DOMAIN-RULES.md Section 2.
 * Steering-side neutrality ('UNIVERSAL') never replaces mandatory OEM fitment verification.
 */
export const PART_CATEGORY_STEERING_SIDE_DEFAULTS: Readonly<
  Record<string, SteeringSideCompatibilityValue>
> = Object.freeze({
  'Complete Engine Assembly': 'UNIVERSAL',
  'Complete Spark-Ignition Engines (>1000cc)': 'UNIVERSAL',
  'Transmission / Gearbox / Transaxle': 'UNIVERSAL',
  'Gearboxes / Transmissions': 'UNIVERSAL',
  Transmission: 'UNIVERSAL',
  Gearbox: 'UNIVERSAL',
  Transaxle: 'UNIVERSAL',
  'Front Bumpers, Hoods, Fenders, Grilles': 'UNIVERSAL',
  'Bumpers & Parts Thereof': 'UNIVERSAL',
  'Front Bumper': 'UNIVERSAL',
  Hood: 'UNIVERSAL',
  Fender: 'UNIVERSAL',
  Grille: 'UNIVERSAL',
  'Body Panels, Doors, Hoods, Fenders': 'UNIVERSAL',
  'Complete Doors (Shell, Glass, Latch)': 'UNIVERSAL',
  'Complete Door': 'UNIVERSAL',
  'Door Shell': 'UNIVERSAL',
  'Rear Clips, Tailgates, Rear Bumpers, Taillights': 'UNIVERSAL',
  'Rear Clip': 'UNIVERSAL',
  Tailgate: 'UNIVERSAL',
  'Rear Bumper': 'UNIVERSAL',
  Taillight: 'UNIVERSAL',
  'Suspension (Struts, Control Arms, Knuckles, Axles)': 'UNIVERSAL',
  'Suspension Shock Absorbers & Struts': 'UNIVERSAL',
  'Drive-Axles & Differentials': 'UNIVERSAL',
  'Road Wheels & Rims': 'UNIVERSAL',
  Strut: 'UNIVERSAL',
  'Shock Absorber': 'UNIVERSAL',
  'Control Arm': 'UNIVERSAL',
  Knuckle: 'UNIVERSAL',
  Axle: 'UNIVERSAL',
  Differential: 'UNIVERSAL',
  'A/C Compressors, Condensers, Radiators, Alternators': 'UNIVERSAL',
  'Radiators & Cooling Systems': 'UNIVERSAL',
  'A/C Compressor': 'UNIVERSAL',
  Condenser: 'UNIVERSAL',
  Radiator: 'UNIVERSAL',
  Alternator: 'UNIVERSAL',
  'Other Auto Parts (ECUs, Sensors, Alternators, Starters)': 'UNIVERSAL',
  ECU: 'UNIVERSAL',
  Sensor: 'UNIVERSAL',
  Starter: 'UNIVERSAL',
  'Watercraft / Marine Assemblies (Rotax / Yamaha)': 'UNIVERSAL',
  'Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)': 'UNIVERSAL',
  'Shop Equipment (A/C Recharge Machine)': 'UNIVERSAL',
  'A/C Recharge Machine': 'UNIVERSAL',
  'Steering Rack, Steering Column, Intermediate Shaft': 'LHD_ONLY',
  'Steering Rack': 'LHD_ONLY',
  'Steering Column': 'LHD_ONLY',
  'Intermediate Shaft': 'LHD_ONLY',
  'Dashboard Assembly, Center Console, Glovebox': 'LHD_ONLY',
  'Dashboard Assembly': 'LHD_ONLY',
  'Center Console': 'LHD_ONLY',
  Glovebox: 'LHD_ONLY',
  'Front Headlamps (Halogen / LED Projector)': 'LHD_ONLY',
  'Front Headlamp': 'LHD_ONLY',
  Headlamp: 'LHD_ONLY',
  'Windshield Wiper Linkage, Cowl & Motor': 'LHD_ONLY',
  'Windshield Wiper Linkage': 'LHD_ONLY',
  'Wiper Cowl': 'LHD_ONLY',
  'Wiper Motor': 'LHD_ONLY',
  'Brake Booster, Master Cylinder & Pedal Box': 'LHD_ONLY',
  'Brakes & Servo-Brakes': 'LHD_ONLY',
  'Brake Booster': 'LHD_ONLY',
  'Master Cylinder': 'LHD_ONLY',
  'Pedal Box': 'LHD_ONLY',
  'Wiring Harnesses & Cabin/Dash Looms': 'LHD_ONLY',
  'Wiring Harness': 'LHD_ONLY',
  'Cabin/Dash Loom': 'LHD_ONLY',
});

/**
 * Default TdgHazmatCode lookup table grounded in DOMAIN-RULES.md Section 3.
 * Airbags (UN3268), pyrotechnic pretensioners (UN0503), wet lead-acid batteries (UN2794),
 * and lithium batteries (UN3480) are explicitly separated into distinct entries.
 */
export const PART_CATEGORY_TDG_HAZMAT_DEFAULTS: Readonly<
  Record<string, TdgHazmatCodeValue>
> = Object.freeze({
  'Safety Airbags': 'UN3268_AIRBAG',
  'Safety Airbag': 'UN3268_AIRBAG',
  'Airbag Module': 'UN3268_AIRBAG',
  'Airbag Inflator': 'UN3268_AIRBAG',
  'Pyrotechnic Pretensioners': 'UN0503_PYROTECHNIC',
  'Seatbelt Pretensioner': 'UN0503_PYROTECHNIC',
  'Pyrotechnic Actuator': 'UN0503_PYROTECHNIC',
  'Lead-Acid Vehicle Battery': 'UN2794_WET_BATTERY',
  'Lead-Acid Wet Battery': 'UN2794_WET_BATTERY',
  'Wet Battery': 'UN2794_WET_BATTERY',
  'Lithium Vehicle Battery': 'UN3480_LITHIUM_BATTERY',
  'Lithium-Ion Battery Pack': 'UN3480_LITHIUM_BATTERY',
  'Hybrid/EV Lithium Battery': 'UN3480_LITHIUM_BATTERY',
  'Complete Engine Assembly': 'NONE',
  'Complete Spark-Ignition Engines (>1000cc)': 'NONE',
  'Transmission / Gearbox / Transaxle': 'NONE',
  'Gearboxes / Transmissions': 'NONE',
  Transmission: 'NONE',
  Gearbox: 'NONE',
  Transaxle: 'NONE',
  'Front Bumpers, Hoods, Fenders, Grilles': 'NONE',
  'Bumpers & Parts Thereof': 'NONE',
  'Front Bumper': 'NONE',
  Hood: 'NONE',
  Fender: 'NONE',
  Grille: 'NONE',
  'Body Panels, Doors, Hoods, Fenders': 'NONE',
  'Complete Doors (Shell, Glass, Latch)': 'NONE',
  'Complete Door': 'NONE',
  'Door Shell': 'NONE',
  'Rear Clips, Tailgates, Rear Bumpers, Taillights': 'NONE',
  'Rear Clip': 'NONE',
  Tailgate: 'NONE',
  'Rear Bumper': 'NONE',
  Taillight: 'NONE',
  'Suspension (Struts, Control Arms, Knuckles, Axles)': 'NONE',
  'Suspension Shock Absorbers & Struts': 'NONE',
  'Drive-Axles & Differentials': 'NONE',
  'Road Wheels & Rims': 'NONE',
  Strut: 'NONE',
  'Shock Absorber': 'NONE',
  'Control Arm': 'NONE',
  Knuckle: 'NONE',
  Axle: 'NONE',
  Differential: 'NONE',
  'A/C Compressors, Condensers, Radiators, Alternators': 'NONE',
  'Radiators & Cooling Systems': 'NONE',
  'A/C Compressor': 'NONE',
  Condenser: 'NONE',
  Radiator: 'NONE',
  Alternator: 'NONE',
  'Other Auto Parts (ECUs, Sensors, Alternators, Starters)': 'NONE',
  ECU: 'NONE',
  Sensor: 'NONE',
  Starter: 'NONE',
  'Watercraft / Marine Assemblies (Rotax / Yamaha)': 'NONE',
  'Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)': 'NONE',
  'Shop Equipment (A/C Recharge Machine)': 'NONE',
  'A/C Recharge Machine': 'NONE',
  'Steering Rack, Steering Column, Intermediate Shaft': 'NONE',
  'Steering Rack': 'NONE',
  'Steering Column': 'NONE',
  'Intermediate Shaft': 'NONE',
  'Dashboard Assembly, Center Console, Glovebox': 'NONE',
  'Dashboard Assembly': 'NONE',
  'Center Console': 'NONE',
  Glovebox: 'NONE',
  'Front Headlamps (Halogen / LED Projector)': 'NONE',
  'Front Headlamp': 'NONE',
  Headlamp: 'NONE',
  'Windshield Wiper Linkage, Cowl & Motor': 'NONE',
  'Windshield Wiper Linkage': 'NONE',
  'Wiper Cowl': 'NONE',
  'Wiper Motor': 'NONE',
  'Brake Booster, Master Cylinder & Pedal Box': 'NONE',
  'Brakes & Servo-Brakes': 'NONE',
  'Brake Booster': 'NONE',
  'Master Cylinder': 'NONE',
  'Pedal Box': 'NONE',
  'Wiring Harnesses & Cabin/Dash Looms': 'NONE',
  'Wiring Harness': 'NONE',
  'Cabin/Dash Loom': 'NONE',
});

/**
 * Default HS tariff subheading suggestions grounded in DOMAIN-RULES.md Section 3.
 * Assistive suggestions only — licensed customs broker confirmation (brokerVerifiedHsCode)
 * is mandatory for commercial customs filings (RULE-CUST-001).
 */
export const PART_CATEGORY_HS_CODE_DEFAULTS: Readonly<Record<string, string>> =
  Object.freeze({
    'Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)': '8903.99',
    'Watercraft / Marine Assemblies (Rotax / Yamaha)': '8903.99',
    'Shop Equipment (A/C Recharge Machine)': '8479.89',
    'A/C Recharge Machine': '8479.89',
    'Complete Spark-Ignition Engines (>1000cc)': '8407.34',
    'Complete Engine Assembly': '8407.34',
    'Bumpers & Parts Thereof': '8708.10',
    'Front Bumpers, Hoods, Fenders, Grilles': '8708.10',
    'Front Bumper': '8708.10',
    'Rear Bumper': '8708.10',
    'Body Panels, Doors, Hoods, Fenders': '8708.29',
    'Complete Doors (Shell, Glass, Latch)': '8708.29',
    'Complete Door': '8708.29',
    'Door Shell': '8708.29',
    Hood: '8708.29',
    Fender: '8708.29',
    Grille: '8708.29',
    Tailgate: '8708.29',
    'Brakes & Servo-Brakes': '8708.30',
    'Brake Booster, Master Cylinder & Pedal Box': '8708.30',
    'Brake Booster': '8708.30',
    'Master Cylinder': '8708.30',
    'Pedal Box': '8708.30',
    'Gearboxes / Transmissions': '8708.40',
    'Transmission / Gearbox / Transaxle': '8708.40',
    Transmission: '8708.40',
    Gearbox: '8708.40',
    Transaxle: '8708.40',
    'Drive-Axles & Differentials': '8708.50',
    Axle: '8708.50',
    Differential: '8708.50',
    'Road Wheels & Rims': '8708.70',
    'Suspension Shock Absorbers & Struts': '8708.80',
    'Suspension (Struts, Control Arms, Knuckles, Axles)': '8708.80',
    Strut: '8708.80',
    'Shock Absorber': '8708.80',
    'Control Arm': '8708.80',
    Knuckle: '8708.80',
    'Radiators & Cooling Systems': '8708.91',
    Radiator: '8708.91',
    Condenser: '8708.91',
    'Safety Airbags & Pyrotechnic Pretensioners': '8708.95',
    'Safety Airbags': '8708.95',
    'Safety Airbag': '8708.95',
    'Airbag Module': '8708.95',
    'Airbag Inflator': '8708.95',
    'Pyrotechnic Pretensioners': '8708.95',
    'Seatbelt Pretensioner': '8708.95',
    'Pyrotechnic Actuator': '8708.95',
    'Lead-Acid Vehicle Battery': '8507.10',
    'Lead-Acid Wet Battery': '8507.10',
    'Wet Battery': '8507.10',
    'Lithium Vehicle Battery': '8507.60',
    'Lithium-Ion Battery Pack': '8507.60',
    'Hybrid/EV Lithium Battery': '8507.60',
    'Other Auto Parts (ECUs, Sensors, Alternators, Starters)': '8708.99',
    ECU: '8708.99',
    Sensor: '8708.99',
    Alternator: '8708.99',
    Starter: '8708.99',
    'A/C Compressor': '8708.99',
    Taillight: '8708.99',
    'Front Headlamps (Halogen / LED Projector)': '8708.99',
    'Front Headlamp': '8708.99',
    Headlamp: '8708.99',
    'Steering Rack, Steering Column, Intermediate Shaft': '8708.99',
    'Steering Rack': '8708.99',
    'Steering Column': '8708.99',
    'Intermediate Shaft': '8708.99',
    'Dashboard Assembly, Center Console, Glovebox': '8708.99',
    'Dashboard Assembly': '8708.99',
    'Center Console': '8708.99',
    Glovebox: '8708.99',
    'Windshield Wiper Linkage, Cowl & Motor': '8708.99',
    'Windshield Wiper Linkage': '8708.99',
    'Wiper Cowl': '8708.99',
    'Wiper Motor': '8708.99',
    'Wiring Harnesses & Cabin/Dash Looms': '8708.99',
    'Wiring Harness': '8708.99',
    'Cabin/Dash Loom': '8708.99',
  });

export function lookupDefaultSteeringSide(
  partCategoryName: string,
): SteeringSideCompatibilityValue | undefined {
  return Object.hasOwn(PART_CATEGORY_STEERING_SIDE_DEFAULTS, partCategoryName)
    ? PART_CATEGORY_STEERING_SIDE_DEFAULTS[partCategoryName]
    : undefined;
}

export function lookupDefaultTdgHazmatCode(
  partCategoryName: string,
): TdgHazmatCodeValue | undefined {
  return Object.hasOwn(PART_CATEGORY_TDG_HAZMAT_DEFAULTS, partCategoryName)
    ? PART_CATEGORY_TDG_HAZMAT_DEFAULTS[partCategoryName]
    : undefined;
}

export function lookupSuggestedHsCode(
  partCategoryName: string,
): string | undefined {
  return Object.hasOwn(PART_CATEGORY_HS_CODE_DEFAULTS, partCategoryName)
    ? PART_CATEGORY_HS_CODE_DEFAULTS[partCategoryName]
    : undefined;
}
