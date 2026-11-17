import type { AraConditionGradeEnum } from '@prisma/client';
import {
  PART_CATEGORY_HS_CODE_DEFAULTS,
  PART_CATEGORY_STEERING_SIDE_DEFAULTS,
  PART_CATEGORY_TDG_HAZMAT_DEFAULTS,
} from '@/core/config/policy-loader';
import { DomainRuleError } from '@/core/domain';

export const LISTING_METADATA_VERSION = '2026.11.1' as const;
export const SELLER_HUB_CSV_FORMAT_VERSION = 'EBAY_CA_SELLER_HUB_V1' as const;

export const SELLER_HUB_ACTION_HEADER =
  '*Action(SiteID=Canada|Country=CA|Currency=CAD|Version=1193|CC=UTF-8)' as const;

export const SELLER_HUB_CSV_HEADERS: readonly string[] = Object.freeze([
  SELLER_HUB_ACTION_HEADER,
  'CustomLabel',
  '*Category',
  '*Title',
  '*ConditionID',
  '*Description',
  'PicURL',
  '*Quantity',
  '*Format',
  '*StartPrice',
  '*Location',
  'PostalCode',
  'DispatchTimeMax',
  'ReturnsAcceptedOption',
  'ShippingService-1:Option',
  'Brand',
  'Manufacturer Part Number',
  'Relationship',
  'RelationshipDetails',
]);

export interface EbayListingCategoryMapping {
  readonly ebayCategoryId: string;
  readonly ebayCategoryName: string;
  readonly conditionPolicy: 'MOTORS_PARTS_USED';
  readonly conditionId: '3000';
  readonly isPowertrainB2bEligible: boolean;
}

const POWERTRAIN_ENGINE_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33615',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Engines & Engine Parts > Complete Engines',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: true,
});

const POWERTRAIN_TRANSMISSION_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33733',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Transmission & Drivetrain > Automatic & Manual Transmissions',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: true,
});

const POWERTRAIN_AXLE_DIFF_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33731',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Transmission & Drivetrain > Differentials & Parts',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: true,
});

const BUMPERS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33640',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Bumpers & Reinforcements',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const HOODS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33646',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Hoods',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const FENDERS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33644',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Fenders',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const GRILLES_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33645',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Grilles',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const DOORS_PANELS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33642',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Doors & Door Skins',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const REAR_CLIPS_TAILGATES_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33654',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Tailgates & Liftgates',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const FRONT_CLIP_POWERTRAIN_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33640',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Front Clips & Nose Assemblies',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: true,
});

const TAILLIGHTS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33716',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Lighting & Lamps > Tail Lights',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const HEADLAMPS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33710',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Lighting & Lamps > Headlights',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const SUSPENSION_STRUTS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33590',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Suspension & Steering > Shocks & Struts',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const CONTROL_ARMS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33581',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Suspension & Steering > Control Arms & Parts',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const KNUCKLES_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33589',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Suspension & Steering > Spindles & Knuckles',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const WHEELS_RIMS_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '43953',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Wheels, Tires & Parts > Wheels',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const BRAKES_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33563',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Brakes & Brake Parts > Master Cylinders & Boosters',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const AC_COMPRESSOR_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33543',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Air Conditioning & Heating > A/C Compressors & Clutches',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const AC_CONDENSER_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33544',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Air Conditioning & Heating > Condensers',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const RADIATOR_COOLING_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33602',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Cooling Systems > Radiators & Parts',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const ALTERNATOR_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '177697',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Starters, Alternators, ECUs & Wiring > Alternators & Generators',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const STARTER_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '177699',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Starters, Alternators, ECUs & Wiring > Starters',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const ECU_SENSOR_WIRING_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33596',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Starters, Alternators, ECUs & Wiring > ECUs & Computer Modules',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const STEERING_RACK_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33588',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Suspension & Steering > Steering Racks & Gear Boxes',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const INTERIOR_DASH_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33695',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Interior > Dash Parts',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const WIPER_LINKAGE_MOTOR_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '61938',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Exterior > Windshield Wipers & Washers',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const MARINE_ASSEMBLY_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '177710',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Boat Parts > Personal Watercraft Parts',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const SHOP_EQUIPMENT_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '179476',
  ebayCategoryName: 'eBay Motors > Automotive Tools & Supplies > Shop Equipment & Supplies',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const AIRBAG_SAFETY_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '33696',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Safety & Security > Airbags',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

const BATTERY_CAT: EbayListingCategoryMapping = Object.freeze({
  ebayCategoryId: '179846',
  ebayCategoryName: 'eBay Motors > Parts & Accessories > Car & Truck Parts > Charging & Starting Systems > Batteries',
  conditionPolicy: 'MOTORS_PARTS_USED',
  conditionId: '3000',
  isPowertrainB2bEligible: false,
});

/**
 * Exhaustive checked-in mapping from every canonical part category and alias in
 * `policy-loader.ts` (`PART_CATEGORY_STEERING_SIDE_DEFAULTS`,
 * `PART_CATEGORY_TDG_HAZMAT_DEFAULTS`, `PART_CATEGORY_HS_CODE_DEFAULTS`)
 * to explicit numeric eBay Motors Canada Seller Hub category IDs and condition policies.
 */
export const PART_CATEGORY_EBAY_LISTING_MAP: Readonly<
  Record<string, EbayListingCategoryMapping>
> = Object.freeze({
  'Complete Engine Assembly': POWERTRAIN_ENGINE_CAT,
  'Complete Spark-Ignition Engines (>1000cc)': POWERTRAIN_ENGINE_CAT,
  'Transmission / Gearbox / Transaxle': POWERTRAIN_TRANSMISSION_CAT,
  'Gearboxes / Transmissions': POWERTRAIN_TRANSMISSION_CAT,
  Transmission: POWERTRAIN_TRANSMISSION_CAT,
  Gearbox: POWERTRAIN_TRANSMISSION_CAT,
  Transaxle: POWERTRAIN_TRANSMISSION_CAT,
  'Transfer Case': POWERTRAIN_TRANSMISSION_CAT,
  'Drive-Axles & Differentials': POWERTRAIN_AXLE_DIFF_CAT,
  Axle: POWERTRAIN_AXLE_DIFF_CAT,
  Differential: POWERTRAIN_AXLE_DIFF_CAT,
  'Front Clip': FRONT_CLIP_POWERTRAIN_CAT,
  'Front Bumpers, Hoods, Fenders, Grilles': BUMPERS_CAT,
  'Bumpers & Parts Thereof': BUMPERS_CAT,
  'Front Bumper': BUMPERS_CAT,
  'Rear Bumper': BUMPERS_CAT,
  Hood: HOODS_CAT,
  Fender: FENDERS_CAT,
  Grille: GRILLES_CAT,
  'Body Panels, Doors, Hoods, Fenders': DOORS_PANELS_CAT,
  'Complete Doors (Shell, Glass, Latch)': DOORS_PANELS_CAT,
  'Complete Door': DOORS_PANELS_CAT,
  'Door Shell': DOORS_PANELS_CAT,
  'Rear Clips, Tailgates, Rear Bumpers, Taillights': REAR_CLIPS_TAILGATES_CAT,
  'Rear Clip': REAR_CLIPS_TAILGATES_CAT,
  Tailgate: REAR_CLIPS_TAILGATES_CAT,
  Taillight: TAILLIGHTS_CAT,
  'Suspension (Struts, Control Arms, Knuckles, Axles)': SUSPENSION_STRUTS_CAT,
  'Suspension Shock Absorbers & Struts': SUSPENSION_STRUTS_CAT,
  Strut: SUSPENSION_STRUTS_CAT,
  'Shock Absorber': SUSPENSION_STRUTS_CAT,
  'Control Arm': CONTROL_ARMS_CAT,
  Knuckle: KNUCKLES_CAT,
  'Road Wheels & Rims': WHEELS_RIMS_CAT,
  'Brakes & Servo-Brakes': BRAKES_CAT,
  'Brake Booster, Master Cylinder & Pedal Box': BRAKES_CAT,
  'Brake Booster': BRAKES_CAT,
  'Master Cylinder': BRAKES_CAT,
  'Pedal Box': BRAKES_CAT,
  'A/C Compressors, Condensers, Radiators, Alternators': AC_COMPRESSOR_CAT,
  'Radiators & Cooling Systems': RADIATOR_COOLING_CAT,
  'A/C Compressor': AC_COMPRESSOR_CAT,
  Condenser: AC_CONDENSER_CAT,
  Radiator: RADIATOR_COOLING_CAT,
  Alternator: ALTERNATOR_CAT,
  'Other Auto Parts (ECUs, Sensors, Alternators, Starters)': ECU_SENSOR_WIRING_CAT,
  ECU: ECU_SENSOR_WIRING_CAT,
  Sensor: ECU_SENSOR_WIRING_CAT,
  Starter: STARTER_CAT,
  'Watercraft / Marine Assemblies (Rotax / Yamaha)': MARINE_ASSEMBLY_CAT,
  'Personal Watercraft / Jet Boats (Yamaha / Sea-Doo)': MARINE_ASSEMBLY_CAT,
  'Shop Equipment (A/C Recharge Machine)': SHOP_EQUIPMENT_CAT,
  'A/C Recharge Machine': SHOP_EQUIPMENT_CAT,
  'Steering Rack, Steering Column, Intermediate Shaft': STEERING_RACK_CAT,
  'Steering Rack': STEERING_RACK_CAT,
  'Steering Column': STEERING_RACK_CAT,
  'Intermediate Shaft': STEERING_RACK_CAT,
  'Dashboard Assembly, Center Console, Glovebox': INTERIOR_DASH_CAT,
  'Dashboard Assembly': INTERIOR_DASH_CAT,
  'Center Console': INTERIOR_DASH_CAT,
  Glovebox: INTERIOR_DASH_CAT,
  'Front Headlamps (Halogen / LED Projector)': HEADLAMPS_CAT,
  'Front Headlamp': HEADLAMPS_CAT,
  Headlamp: HEADLAMPS_CAT,
  'Windshield Wiper Linkage, Cowl & Motor': WIPER_LINKAGE_MOTOR_CAT,
  'Windshield Wiper Linkage': WIPER_LINKAGE_MOTOR_CAT,
  'Wiper Cowl': WIPER_LINKAGE_MOTOR_CAT,
  'Wiper Motor': WIPER_LINKAGE_MOTOR_CAT,
  'Wiring Harnesses & Cabin/Dash Looms': ECU_SENSOR_WIRING_CAT,
  'Wiring Harness': ECU_SENSOR_WIRING_CAT,
  'Cabin/Dash Loom': ECU_SENSOR_WIRING_CAT,
  'Safety Airbags & Pyrotechnic Pretensioners': AIRBAG_SAFETY_CAT,
  'Safety Airbags': AIRBAG_SAFETY_CAT,
  'Safety Airbag': AIRBAG_SAFETY_CAT,
  'Airbag Module': AIRBAG_SAFETY_CAT,
  'Airbag Inflator': AIRBAG_SAFETY_CAT,
  'Pyrotechnic Pretensioners': AIRBAG_SAFETY_CAT,
  'Seatbelt Pretensioner': AIRBAG_SAFETY_CAT,
  'Pyrotechnic Actuator': AIRBAG_SAFETY_CAT,
  'Lead-Acid Vehicle Battery': BATTERY_CAT,
  'Lead-Acid Wet Battery': BATTERY_CAT,
  'Wet Battery': BATTERY_CAT,
  'Lithium Vehicle Battery': BATTERY_CAT,
  'Lithium-Ion Battery Pack': BATTERY_CAT,
  'Hybrid/EV Lithium Battery': BATTERY_CAT,
});

/**
 * Returns the union of all canonical category keys/aliases exported by policy-loader.ts.
 */
export function getAllPolicyCanonicalCategoryKeys(): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(PART_CATEGORY_STEERING_SIDE_DEFAULTS),
      ...Object.keys(PART_CATEGORY_TDG_HAZMAT_DEFAULTS),
      ...Object.keys(PART_CATEGORY_HS_CODE_DEFAULTS),
    ]),
  ].sort();
}

export function lookupEbayListingCategory(
  partCategoryName: string,
): EbayListingCategoryMapping {
  const key = typeof partCategoryName === 'string' ? partCategoryName.trim() : '';
  if (!key || !Object.hasOwn(PART_CATEGORY_EBAY_LISTING_MAP, key)) {
    throw new DomainRuleError(
      'LISTING_METADATA_REQUIRED' as never,
      `No Seller Hub category mapping configured for partCategoryName "${partCategoryName}".`,
      { partCategoryName },
    );
  }
  return PART_CATEGORY_EBAY_LISTING_MAP[key]!;
}

export interface AraConditionMetadata {
  readonly canonicalGrade: AraConditionGradeEnum;
  readonly conditionId: '3000';
  readonly conditionLabel: string;
}

const LEGACY_GRADE_MAP: Readonly<Record<string, AraConditionGradeEnum>> =
  Object.freeze({
    A: 'GRADE_A',
    B: 'GRADE_B1',
    C: 'GRADE_C',
    B1: 'GRADE_B1',
    B2: 'GRADE_B2',
    B3: 'GRADE_B3',
    X: 'GRADE_X',
    GRADE_A: 'GRADE_A',
    GRADE_B1: 'GRADE_B1',
    GRADE_B2: 'GRADE_B2',
    GRADE_B3: 'GRADE_B3',
    GRADE_C: 'GRADE_C',
    GRADE_X: 'GRADE_X',
  });

const GRADE_DISPLAY_LABELS: Readonly<Record<AraConditionGradeEnum, string>> =
  Object.freeze({
    GRADE_A: 'Used — ARA Grade A (Clean OEM Salvage)',
    GRADE_B1: 'Used — ARA Grade B1 (Standard OEM Salvage)',
    GRADE_B2: 'Used — ARA Grade B2 (Minor Cosmetic Wear)',
    GRADE_B3: 'Used — ARA Grade B3 (Visible Wear / Tested Functional)',
    GRADE_C: 'Used — ARA Grade C (Heavy Wear / Repairable)',
    GRADE_X: 'Used — ARA Grade X (Unclassified Salvage / Inspect Photos)',
  });

export function normalizeCanonicalAraGrade(
  rawGrade: string,
): AraConditionGradeEnum {
  const normalized = typeof rawGrade === 'string' ? rawGrade.trim().toUpperCase() : '';
  const mapped = Object.hasOwn(LEGACY_GRADE_MAP, normalized)
    ? LEGACY_GRADE_MAP[normalized]
    : undefined;
  if (!mapped) {
    throw new DomainRuleError(
      'INVALID_ARA_GRADE',
      `Unsupported ARA grade "${rawGrade}".`,
      { rawGrade },
    );
  }
  return mapped;
}

export function resolveAraConditionMetadata(
  rawGrade: string,
): AraConditionMetadata {
  const canonicalGrade = normalizeCanonicalAraGrade(rawGrade);
  return {
    canonicalGrade,
    conditionId: '3000',
    conditionLabel: GRADE_DISPLAY_LABELS[canonicalGrade],
  };
}
