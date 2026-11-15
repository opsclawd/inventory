import { OrganizationType, UserRole } from '@prisma/client';

export const ALL_USER_ROLES = [
  UserRole.ARCHITECT_CFO,
  UserRole.HUNTER_MECHANIC,
  UserRole.ONTARIO_STRIPPER,
  UserRole.TRINIDAD_VAULT_ADMIN,
  UserRole.OVERSEAS_B2B_BUYER,
  UserRole.CANNABIS_QAP_COMPLIANCE,
  UserRole.NURSERY_CULTIVATION_TECH,
] as const;

export const ALL_ORGANIZATION_TYPES = [
  OrganizationType.SALVAGE_AND_EXPORT,
  OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
] as const;

export const MFA_ENROLLMENT_REQUIRED_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ARCHITECT_CFO,
  UserRole.TRINIDAD_VAULT_ADMIN,
  UserRole.CANNABIS_QAP_COMPLIANCE,
]);

/**
 * Explicit organization-type bindings per UserRole (PRD Section 2 & 2.1):
 * - ARCHITECT_CFO and HUNTER_MECHANIC may hold explicit memberships in either entity type
 *   (never inferred across entities; Phase 1A seed keeps HUNTER_MECHANIC salvage-only).
 * - Salvage-only roles are restricted to SALVAGE_AND_EXPORT.
 * - Cannabis-only roles are restricted to CANNABIS_NURSERY_AND_PROCESSING.
 */
export const ROLE_ALLOWED_ORGANIZATION_TYPES: Readonly<
  Record<UserRole, readonly OrganizationType[]>
> = {
  [UserRole.ARCHITECT_CFO]: [
    OrganizationType.SALVAGE_AND_EXPORT,
    OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
  ],
  [UserRole.HUNTER_MECHANIC]: [
    OrganizationType.SALVAGE_AND_EXPORT,
    OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
  ],
  [UserRole.ONTARIO_STRIPPER]: [OrganizationType.SALVAGE_AND_EXPORT],
  [UserRole.TRINIDAD_VAULT_ADMIN]: [OrganizationType.SALVAGE_AND_EXPORT],
  [UserRole.OVERSEAS_B2B_BUYER]: [OrganizationType.SALVAGE_AND_EXPORT],
  [UserRole.CANNABIS_QAP_COMPLIANCE]: [
    OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
  ],
  [UserRole.NURSERY_CULTIVATION_TECH]: [
    OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
  ],
};

export type FunctionalRequirementId =
  | 'FR-DEAL-01'
  | 'FR-DEAL-02'
  | 'FR-INT-01'
  | 'FR-INT-02'
  | 'FR-EXP-01'
  | 'FR-EXP-02'
  | 'FR-LOG-01'
  | 'FR-LOG-02'
  | 'FR-CHK-01'
  | 'FR-MKT-00'
  | 'FR-MKT-02'
  | 'FR-VLT-01'
  | 'FR-VLT-02'
  | 'FR-VLT-03'
  | 'FR-VLT-04'
  | 'FR-VLT-05'
  | 'FR-CAN-01'
  | 'FR-CAN-02'
  | 'FR-CAN-03'
  | 'FR-CAN-04';

export type RequirementId = FunctionalRequirementId | 'AUTH-MEMBERSHIP';

export type CapabilityRestrictionScope =
  | 'NONE'
  | 'OWN_RECORDS'
  | 'OWN_FLOAT_AND_RECORDS'
  | 'OWN_PIECE_RATE'
  | 'OWN_LEADS'
  | 'OWN_COMMISSION'
  | 'STRIP_QUEUE_ONLY'
  | 'EXPORTED_ONLY'
  | 'MANIFEST_ONLY'
  | 'LOADING_TAB_ONLY'
  | 'PACKING_LIST_ONLY'
  | 'PORT_FEES_ONLY'
  | 'NURSERY_SUPPLIES_ONLY'
  | 'CAD_ONLY'
  | 'STATUS_ONLY'
  | 'BROKER_RESERVATION'
  | 'RATE_LIMITED_RESERVATION'
  | 'WITNESS_ONLY'
  | 'SUMMARY_ONLY';

export type CapabilityId =
  // FR-DEAL-01: Create Pre-Auction Deal Proposal
  | 'FR-DEAL-01:create'
  | 'FR-DEAL-01:read'
  | 'FR-DEAL-01:update'
  | 'FR-DEAL-01:delete'
  | 'FR-DEAL-01:approve'
  // FR-DEAL-02: Override Capital Gate Lock
  | 'FR-DEAL-02:execute'
  // FR-INT-01: Intake Whole Asset
  | 'FR-INT-01:create'
  | 'FR-INT-01:read'
  | 'FR-INT-01:update'
  | 'FR-INT-01:delete'
  | 'FR-INT-01:read-strip-queue'
  | 'FR-INT-01:read-exported'
  // FR-INT-02: Strip Part, Bind QR & Scan Bin
  | 'FR-INT-02:create'
  | 'FR-INT-02:read'
  | 'FR-INT-02:update'
  | 'FR-INT-02:delete'
  | 'FR-INT-02:relocate'
  // FR-EXP-01: Log Expense with Private Receipt
  | 'FR-EXP-01:create'
  | 'FR-EXP-01:read'
  | 'FR-EXP-01:update'
  | 'FR-EXP-01:delete'
  | 'FR-EXP-01:reverse'
  | 'FR-EXP-01:create-port-fees'
  | 'FR-EXP-01:create-nursery-supplies'
  // FR-EXP-02: Execute Piece-Rate Stripper Payout & Partner Draw
  | 'FR-EXP-02:create'
  | 'FR-EXP-02:read'
  | 'FR-EXP-02:update'
  | 'FR-EXP-02:delete'
  | 'FR-EXP-02:approve'
  | 'FR-EXP-02:read-own-float'
  | 'FR-EXP-02:read-own-piece-rate'
  // FR-LOG-01: Scan Parts/Assets to Export Pallet
  | 'FR-LOG-01:create'
  | 'FR-LOG-01:read'
  | 'FR-LOG-01:update'
  | 'FR-LOG-01:delete'
  | 'FR-LOG-01:execute-scan'
  | 'FR-LOG-01:read-manifest'
  | 'FR-LOG-01:read-loading-tab'
  // FR-LOG-02: Seal Pallet & Export Broker Package
  | 'FR-LOG-02:create'
  | 'FR-LOG-02:read'
  | 'FR-LOG-02:update'
  | 'FR-LOG-02:delete'
  | 'FR-LOG-02:seal'
  | 'FR-LOG-02:export'
  | 'FR-LOG-02:read-packing-list'
  | 'FR-LOG-02:download'
  // FR-CHK-01: Execute Ontario Domestic Checkout
  | 'FR-CHK-01:create'
  | 'FR-CHK-01:read'
  | 'FR-CHK-01:update'
  | 'FR-CHK-01:delete'
  | 'FR-CHK-01:execute-cad-only'
  // FR-MKT-00: Export eBay Seller Hub Bulk CSV & Local Classifieds Queue
  | 'FR-MKT-00:create'
  | 'FR-MKT-00:read'
  | 'FR-MKT-00:update'
  | 'FR-MKT-00:delete'
  | 'FR-MKT-00:export-csv'
  | 'FR-MKT-00:execute-local-queue'
  // FR-MKT-02: 1-Click FB Marketplace / Kijiji Copy & Chrome Extension Autofill
  | 'FR-MKT-02:execute'
  // FR-VLT-01: Check-In Landed Shipment to Vault
  | 'FR-VLT-01:create'
  | 'FR-VLT-01:read'
  | 'FR-VLT-01:update'
  | 'FR-VLT-01:delete'
  | 'FR-VLT-01:execute-check-in'
  | 'FR-VLT-01:read-status'
  // FR-VLT-02: Create 24h B2B Part/Vehicle Reservation
  | 'FR-VLT-02:create'
  | 'FR-VLT-02:read'
  | 'FR-VLT-02:update'
  | 'FR-VLT-02:delete'
  | 'FR-VLT-02:create-broker'
  | 'FR-VLT-02:create-rate-limited'
  // FR-VLT-03: Verify Trinidad Vault COD Payment & Release
  | 'FR-VLT-03:execute'
  // FR-VLT-04: Log Broker Commission & FX Batch
  | 'FR-VLT-04:create'
  | 'FR-VLT-04:read'
  | 'FR-VLT-04:update'
  | 'FR-VLT-04:delete'
  | 'FR-VLT-04:execute'
  | 'FR-VLT-04:reconcile'
  | 'FR-VLT-04:read-own-leads'
  | 'FR-VLT-04:read-own-commission'
  // FR-VLT-05: Execute Weekly Blind Cycle Count
  | 'FR-VLT-05:create'
  | 'FR-VLT-05:read'
  | 'FR-VLT-05:update'
  | 'FR-VLT-05:delete'
  | 'FR-VLT-05:trigger'
  | 'FR-VLT-05:audit'
  | 'FR-VLT-05:execute-count'
  // FR-CAN-01: 3-Tap Nursery Clone & Mother Tracking
  | 'FR-CAN-01:create'
  | 'FR-CAN-01:read'
  | 'FR-CAN-01:update'
  | 'FR-CAN-01:delete'
  | 'FR-CAN-01:relocate'
  | 'FR-CAN-01:hold-release'
  // FR-CAN-02: M:N Production Run & Tenth-Gram Ledger
  | 'FR-CAN-02:create'
  | 'FR-CAN-02:read'
  | 'FR-CAN-02:update'
  | 'FR-CAN-02:delete'
  | 'FR-CAN-02:audit'
  | 'FR-CAN-02:verify-variance'
  | 'FR-CAN-02:execute-run'
  // FR-CAN-03: Post-2025 3-Stream Destruction Workflow
  | 'FR-CAN-03:execute'
  | 'FR-CAN-03:qap-execute'
  | 'FR-CAN-03:witness'
  // FR-CAN-04: Health Canada CTLS & CRA B300 Monthly Export
  | 'FR-CAN-04:create'
  | 'FR-CAN-04:read'
  | 'FR-CAN-04:update'
  | 'FR-CAN-04:delete'
  | 'FR-CAN-04:sign-off'
  | 'FR-CAN-04:export'
  | 'FR-CAN-04:read-summary'
  // Internal membership administration (ARCHITECT_CFO only)
  | 'AUTH-MEMBERSHIP:deactivate'
  | 'AUTH-MEMBERSHIP:reactivate';

export type CapabilityInput = CapabilityId | FunctionalRequirementId;

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly requirementId: RequirementId;
  readonly action: string;
  readonly allowedOrganizationTypes: readonly OrganizationType[];
  readonly requiresAal2: boolean;
  readonly restrictionScope: CapabilityRestrictionScope;
}

const SALVAGE_ONLY = [OrganizationType.SALVAGE_AND_EXPORT] as const;
const CANNABIS_ONLY = [
  OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
] as const;
const BOTH_ORG_TYPES = [
  OrganizationType.SALVAGE_AND_EXPORT,
  OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
] as const;

export const CAPABILITY_METADATA: Readonly<
  Record<CapabilityId, CapabilityDescriptor>
> = {
  // FR-DEAL-01
  'FR-DEAL-01:create': {
    id: 'FR-DEAL-01:create',
    requirementId: 'FR-DEAL-01',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-DEAL-01:read': {
    id: 'FR-DEAL-01:read',
    requirementId: 'FR-DEAL-01',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-DEAL-01:update': {
    id: 'FR-DEAL-01:update',
    requirementId: 'FR-DEAL-01',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-DEAL-01:delete': {
    id: 'FR-DEAL-01:delete',
    requirementId: 'FR-DEAL-01',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-DEAL-01:approve': {
    id: 'FR-DEAL-01:approve',
    requirementId: 'FR-DEAL-01',
    action: 'approve',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-DEAL-02
  'FR-DEAL-02:execute': {
    id: 'FR-DEAL-02:execute',
    requirementId: 'FR-DEAL-02',
    action: 'execute',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },

  // FR-INT-01
  'FR-INT-01:create': {
    id: 'FR-INT-01:create',
    requirementId: 'FR-INT-01',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-01:read': {
    id: 'FR-INT-01:read',
    requirementId: 'FR-INT-01',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-01:update': {
    id: 'FR-INT-01:update',
    requirementId: 'FR-INT-01',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-01:delete': {
    id: 'FR-INT-01:delete',
    requirementId: 'FR-INT-01',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-01:read-strip-queue': {
    id: 'FR-INT-01:read-strip-queue',
    requirementId: 'FR-INT-01',
    action: 'read-strip-queue',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'STRIP_QUEUE_ONLY',
  },
  'FR-INT-01:read-exported': {
    id: 'FR-INT-01:read-exported',
    requirementId: 'FR-INT-01',
    action: 'read-exported',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'EXPORTED_ONLY',
  },

  // FR-INT-02
  'FR-INT-02:create': {
    id: 'FR-INT-02:create',
    requirementId: 'FR-INT-02',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-02:read': {
    id: 'FR-INT-02:read',
    requirementId: 'FR-INT-02',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-02:update': {
    id: 'FR-INT-02:update',
    requirementId: 'FR-INT-02',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-02:delete': {
    id: 'FR-INT-02:delete',
    requirementId: 'FR-INT-02',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-INT-02:relocate': {
    id: 'FR-INT-02:relocate',
    requirementId: 'FR-INT-02',
    action: 'relocate',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-EXP-01
  'FR-EXP-01:create': {
    id: 'FR-EXP-01:create',
    requirementId: 'FR-EXP-01',
    action: 'create',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-01:read': {
    id: 'FR-EXP-01:read',
    requirementId: 'FR-EXP-01',
    action: 'read',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-EXP-01:update': {
    id: 'FR-EXP-01:update',
    requirementId: 'FR-EXP-01',
    action: 'update',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-01:delete': {
    id: 'FR-EXP-01:delete',
    requirementId: 'FR-EXP-01',
    action: 'delete',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-01:reverse': {
    id: 'FR-EXP-01:reverse',
    requirementId: 'FR-EXP-01',
    action: 'reverse',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-01:create-port-fees': {
    id: 'FR-EXP-01:create-port-fees',
    requirementId: 'FR-EXP-01',
    action: 'create-port-fees',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'PORT_FEES_ONLY',
  },
  'FR-EXP-01:create-nursery-supplies': {
    id: 'FR-EXP-01:create-nursery-supplies',
    requirementId: 'FR-EXP-01',
    action: 'create-nursery-supplies',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NURSERY_SUPPLIES_ONLY',
  },

  // FR-EXP-02
  'FR-EXP-02:create': {
    id: 'FR-EXP-02:create',
    requirementId: 'FR-EXP-02',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-02:read': {
    id: 'FR-EXP-02:read',
    requirementId: 'FR-EXP-02',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-EXP-02:update': {
    id: 'FR-EXP-02:update',
    requirementId: 'FR-EXP-02',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-02:delete': {
    id: 'FR-EXP-02:delete',
    requirementId: 'FR-EXP-02',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-02:approve': {
    id: 'FR-EXP-02:approve',
    requirementId: 'FR-EXP-02',
    action: 'approve',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-EXP-02:read-own-float': {
    id: 'FR-EXP-02:read-own-float',
    requirementId: 'FR-EXP-02',
    action: 'read-own-float',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'OWN_FLOAT_AND_RECORDS',
  },
  'FR-EXP-02:read-own-piece-rate': {
    id: 'FR-EXP-02:read-own-piece-rate',
    requirementId: 'FR-EXP-02',
    action: 'read-own-piece-rate',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'OWN_PIECE_RATE',
  },

  // FR-LOG-01
  'FR-LOG-01:create': {
    id: 'FR-LOG-01:create',
    requirementId: 'FR-LOG-01',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-01:read': {
    id: 'FR-LOG-01:read',
    requirementId: 'FR-LOG-01',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-01:update': {
    id: 'FR-LOG-01:update',
    requirementId: 'FR-LOG-01',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-01:delete': {
    id: 'FR-LOG-01:delete',
    requirementId: 'FR-LOG-01',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-01:execute-scan': {
    id: 'FR-LOG-01:execute-scan',
    requirementId: 'FR-LOG-01',
    action: 'execute-scan',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-01:read-manifest': {
    id: 'FR-LOG-01:read-manifest',
    requirementId: 'FR-LOG-01',
    action: 'read-manifest',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'MANIFEST_ONLY',
  },
  'FR-LOG-01:read-loading-tab': {
    id: 'FR-LOG-01:read-loading-tab',
    requirementId: 'FR-LOG-01',
    action: 'read-loading-tab',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'LOADING_TAB_ONLY',
  },

  // FR-LOG-02
  'FR-LOG-02:create': {
    id: 'FR-LOG-02:create',
    requirementId: 'FR-LOG-02',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-02:read': {
    id: 'FR-LOG-02:read',
    requirementId: 'FR-LOG-02',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-02:update': {
    id: 'FR-LOG-02:update',
    requirementId: 'FR-LOG-02',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-02:delete': {
    id: 'FR-LOG-02:delete',
    requirementId: 'FR-LOG-02',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-02:seal': {
    id: 'FR-LOG-02:seal',
    requirementId: 'FR-LOG-02',
    action: 'seal',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-02:export': {
    id: 'FR-LOG-02:export',
    requirementId: 'FR-LOG-02',
    action: 'export',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-LOG-02:read-packing-list': {
    id: 'FR-LOG-02:read-packing-list',
    requirementId: 'FR-LOG-02',
    action: 'read-packing-list',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'PACKING_LIST_ONLY',
  },
  'FR-LOG-02:download': {
    id: 'FR-LOG-02:download',
    requirementId: 'FR-LOG-02',
    action: 'download',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-CHK-01
  'FR-CHK-01:create': {
    id: 'FR-CHK-01:create',
    requirementId: 'FR-CHK-01',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CHK-01:read': {
    id: 'FR-CHK-01:read',
    requirementId: 'FR-CHK-01',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CHK-01:update': {
    id: 'FR-CHK-01:update',
    requirementId: 'FR-CHK-01',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CHK-01:delete': {
    id: 'FR-CHK-01:delete',
    requirementId: 'FR-CHK-01',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CHK-01:execute-cad-only': {
    id: 'FR-CHK-01:execute-cad-only',
    requirementId: 'FR-CHK-01',
    action: 'execute-cad-only',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'CAD_ONLY',
  },

  // FR-MKT-00
  'FR-MKT-00:create': {
    id: 'FR-MKT-00:create',
    requirementId: 'FR-MKT-00',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-MKT-00:read': {
    id: 'FR-MKT-00:read',
    requirementId: 'FR-MKT-00',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-MKT-00:update': {
    id: 'FR-MKT-00:update',
    requirementId: 'FR-MKT-00',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-MKT-00:delete': {
    id: 'FR-MKT-00:delete',
    requirementId: 'FR-MKT-00',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-MKT-00:export-csv': {
    id: 'FR-MKT-00:export-csv',
    requirementId: 'FR-MKT-00',
    action: 'export-csv',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-MKT-00:execute-local-queue': {
    id: 'FR-MKT-00:execute-local-queue',
    requirementId: 'FR-MKT-00',
    action: 'execute-local-queue',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-MKT-02
  'FR-MKT-02:execute': {
    id: 'FR-MKT-02:execute',
    requirementId: 'FR-MKT-02',
    action: 'execute',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-VLT-01
  'FR-VLT-01:create': {
    id: 'FR-VLT-01:create',
    requirementId: 'FR-VLT-01',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-01:read': {
    id: 'FR-VLT-01:read',
    requirementId: 'FR-VLT-01',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-01:update': {
    id: 'FR-VLT-01:update',
    requirementId: 'FR-VLT-01',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-01:delete': {
    id: 'FR-VLT-01:delete',
    requirementId: 'FR-VLT-01',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-01:execute-check-in': {
    id: 'FR-VLT-01:execute-check-in',
    requirementId: 'FR-VLT-01',
    action: 'execute-check-in',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-01:read-status': {
    id: 'FR-VLT-01:read-status',
    requirementId: 'FR-VLT-01',
    action: 'read-status',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'STATUS_ONLY',
  },

  // FR-VLT-02
  'FR-VLT-02:create': {
    id: 'FR-VLT-02:create',
    requirementId: 'FR-VLT-02',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-02:read': {
    id: 'FR-VLT-02:read',
    requirementId: 'FR-VLT-02',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-02:update': {
    id: 'FR-VLT-02:update',
    requirementId: 'FR-VLT-02',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-02:delete': {
    id: 'FR-VLT-02:delete',
    requirementId: 'FR-VLT-02',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-02:create-broker': {
    id: 'FR-VLT-02:create-broker',
    requirementId: 'FR-VLT-02',
    action: 'create-broker',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'BROKER_RESERVATION',
  },
  'FR-VLT-02:create-rate-limited': {
    id: 'FR-VLT-02:create-rate-limited',
    requirementId: 'FR-VLT-02',
    action: 'create-rate-limited',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'RATE_LIMITED_RESERVATION',
  },

  // FR-VLT-03
  'FR-VLT-03:execute': {
    id: 'FR-VLT-03:execute',
    requirementId: 'FR-VLT-03',
    action: 'execute',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },

  // FR-VLT-04
  'FR-VLT-04:create': {
    id: 'FR-VLT-04:create',
    requirementId: 'FR-VLT-04',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-VLT-04:read': {
    id: 'FR-VLT-04:read',
    requirementId: 'FR-VLT-04',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-04:update': {
    id: 'FR-VLT-04:update',
    requirementId: 'FR-VLT-04',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-VLT-04:delete': {
    id: 'FR-VLT-04:delete',
    requirementId: 'FR-VLT-04',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-VLT-04:execute': {
    id: 'FR-VLT-04:execute',
    requirementId: 'FR-VLT-04',
    action: 'execute',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-VLT-04:reconcile': {
    id: 'FR-VLT-04:reconcile',
    requirementId: 'FR-VLT-04',
    action: 'reconcile',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-VLT-04:read-own-leads': {
    id: 'FR-VLT-04:read-own-leads',
    requirementId: 'FR-VLT-04',
    action: 'read-own-leads',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'OWN_LEADS',
  },
  'FR-VLT-04:read-own-commission': {
    id: 'FR-VLT-04:read-own-commission',
    requirementId: 'FR-VLT-04',
    action: 'read-own-commission',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'OWN_COMMISSION',
  },

  // FR-VLT-05
  'FR-VLT-05:create': {
    id: 'FR-VLT-05:create',
    requirementId: 'FR-VLT-05',
    action: 'create',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-05:read': {
    id: 'FR-VLT-05:read',
    requirementId: 'FR-VLT-05',
    action: 'read',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-05:update': {
    id: 'FR-VLT-05:update',
    requirementId: 'FR-VLT-05',
    action: 'update',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-05:delete': {
    id: 'FR-VLT-05:delete',
    requirementId: 'FR-VLT-05',
    action: 'delete',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-05:trigger': {
    id: 'FR-VLT-05:trigger',
    requirementId: 'FR-VLT-05',
    action: 'trigger',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-05:audit': {
    id: 'FR-VLT-05:audit',
    requirementId: 'FR-VLT-05',
    action: 'audit',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-VLT-05:execute-count': {
    id: 'FR-VLT-05:execute-count',
    requirementId: 'FR-VLT-05',
    action: 'execute-count',
    allowedOrganizationTypes: SALVAGE_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-CAN-01
  'FR-CAN-01:create': {
    id: 'FR-CAN-01:create',
    requirementId: 'FR-CAN-01',
    action: 'create',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-01:read': {
    id: 'FR-CAN-01:read',
    requirementId: 'FR-CAN-01',
    action: 'read',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-01:update': {
    id: 'FR-CAN-01:update',
    requirementId: 'FR-CAN-01',
    action: 'update',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-01:delete': {
    id: 'FR-CAN-01:delete',
    requirementId: 'FR-CAN-01',
    action: 'delete',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-01:relocate': {
    id: 'FR-CAN-01:relocate',
    requirementId: 'FR-CAN-01',
    action: 'relocate',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-01:hold-release': {
    id: 'FR-CAN-01:hold-release',
    requirementId: 'FR-CAN-01',
    action: 'hold-release',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },

  // FR-CAN-02
  'FR-CAN-02:create': {
    id: 'FR-CAN-02:create',
    requirementId: 'FR-CAN-02',
    action: 'create',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-02:read': {
    id: 'FR-CAN-02:read',
    requirementId: 'FR-CAN-02',
    action: 'read',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-02:update': {
    id: 'FR-CAN-02:update',
    requirementId: 'FR-CAN-02',
    action: 'update',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-02:delete': {
    id: 'FR-CAN-02:delete',
    requirementId: 'FR-CAN-02',
    action: 'delete',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-02:audit': {
    id: 'FR-CAN-02:audit',
    requirementId: 'FR-CAN-02',
    action: 'audit',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CAN-02:verify-variance': {
    id: 'FR-CAN-02:verify-variance',
    requirementId: 'FR-CAN-02',
    action: 'verify-variance',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CAN-02:execute-run': {
    id: 'FR-CAN-02:execute-run',
    requirementId: 'FR-CAN-02',
    action: 'execute-run',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },

  // FR-CAN-03
  'FR-CAN-03:execute': {
    id: 'FR-CAN-03:execute',
    requirementId: 'FR-CAN-03',
    action: 'execute',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CAN-03:qap-execute': {
    id: 'FR-CAN-03:qap-execute',
    requirementId: 'FR-CAN-03',
    action: 'qap-execute',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CAN-03:witness': {
    id: 'FR-CAN-03:witness',
    requirementId: 'FR-CAN-03',
    action: 'witness',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'WITNESS_ONLY',
  },

  // FR-CAN-04
  'FR-CAN-04:create': {
    id: 'FR-CAN-04:create',
    requirementId: 'FR-CAN-04',
    action: 'create',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-04:read': {
    id: 'FR-CAN-04:read',
    requirementId: 'FR-CAN-04',
    action: 'read',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-04:update': {
    id: 'FR-CAN-04:update',
    requirementId: 'FR-CAN-04',
    action: 'update',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-04:delete': {
    id: 'FR-CAN-04:delete',
    requirementId: 'FR-CAN-04',
    action: 'delete',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'NONE',
  },
  'FR-CAN-04:sign-off': {
    id: 'FR-CAN-04:sign-off',
    requirementId: 'FR-CAN-04',
    action: 'sign-off',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CAN-04:export': {
    id: 'FR-CAN-04:export',
    requirementId: 'FR-CAN-04',
    action: 'export',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'FR-CAN-04:read-summary': {
    id: 'FR-CAN-04:read-summary',
    requirementId: 'FR-CAN-04',
    action: 'read-summary',
    allowedOrganizationTypes: CANNABIS_ONLY,
    requiresAal2: false,
    restrictionScope: 'SUMMARY_ONLY',
  },

  // Internal membership lifecycle administration
  'AUTH-MEMBERSHIP:deactivate': {
    id: 'AUTH-MEMBERSHIP:deactivate',
    requirementId: 'AUTH-MEMBERSHIP',
    action: 'deactivate',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
  'AUTH-MEMBERSHIP:reactivate': {
    id: 'AUTH-MEMBERSHIP:reactivate',
    requirementId: 'AUTH-MEMBERSHIP',
    action: 'reactivate',
    allowedOrganizationTypes: BOTH_ORG_TYPES,
    requiresAal2: true,
    restrictionScope: 'NONE',
  },
};

export const BASE_FR_PRIMARY_CAPABILITY: Readonly<
  Record<FunctionalRequirementId, CapabilityId>
> = {
  'FR-DEAL-01': 'FR-DEAL-01:create',
  'FR-DEAL-02': 'FR-DEAL-02:execute',
  'FR-INT-01': 'FR-INT-01:create',
  'FR-INT-02': 'FR-INT-02:create',
  'FR-EXP-01': 'FR-EXP-01:create',
  'FR-EXP-02': 'FR-EXP-02:approve',
  'FR-LOG-01': 'FR-LOG-01:execute-scan',
  'FR-LOG-02': 'FR-LOG-02:seal',
  'FR-CHK-01': 'FR-CHK-01:execute-cad-only',
  'FR-MKT-00': 'FR-MKT-00:export-csv',
  'FR-MKT-02': 'FR-MKT-02:execute',
  'FR-VLT-01': 'FR-VLT-01:execute-check-in',
  'FR-VLT-02': 'FR-VLT-02:create',
  'FR-VLT-03': 'FR-VLT-03:execute',
  'FR-VLT-04': 'FR-VLT-04:execute',
  'FR-VLT-05': 'FR-VLT-05:execute-count',
  'FR-CAN-01': 'FR-CAN-01:create',
  'FR-CAN-02': 'FR-CAN-02:execute-run',
  'FR-CAN-03': 'FR-CAN-03:execute',
  'FR-CAN-04': 'FR-CAN-04:export',
};

function freezeSet(capabilities: readonly CapabilityId[]): ReadonlySet<CapabilityId> {
  return new Set<CapabilityId>(capabilities);
}

/**
 * Exhaustive 7-role RBAC permission matrix faithfully encoding PRD Section 2.
 */
export const ROLE_CAPABILITY_MATRIX: Readonly<
  Record<UserRole, ReadonlySet<CapabilityId>>
> = {
  [UserRole.ARCHITECT_CFO]: freezeSet([
    'FR-DEAL-01:create',
    'FR-DEAL-01:read',
    'FR-DEAL-01:update',
    'FR-DEAL-01:delete',
    'FR-DEAL-01:approve',
    'FR-DEAL-02:execute',
    'FR-INT-01:create',
    'FR-INT-01:read',
    'FR-INT-01:update',
    'FR-INT-01:delete',
    'FR-INT-02:create',
    'FR-INT-02:read',
    'FR-INT-02:update',
    'FR-INT-02:delete',
    'FR-INT-02:relocate',
    'FR-EXP-01:create',
    'FR-EXP-01:read',
    'FR-EXP-01:update',
    'FR-EXP-01:delete',
    'FR-EXP-01:reverse',
    'FR-EXP-02:create',
    'FR-EXP-02:read',
    'FR-EXP-02:update',
    'FR-EXP-02:delete',
    'FR-EXP-02:approve',
    'FR-LOG-01:create',
    'FR-LOG-01:read',
    'FR-LOG-01:update',
    'FR-LOG-01:delete',
    'FR-LOG-01:execute-scan',
    'FR-LOG-02:create',
    'FR-LOG-02:read',
    'FR-LOG-02:update',
    'FR-LOG-02:delete',
    'FR-LOG-02:seal',
    'FR-LOG-02:export',
    'FR-CHK-01:create',
    'FR-CHK-01:read',
    'FR-CHK-01:update',
    'FR-CHK-01:delete',
    'FR-CHK-01:execute-cad-only',
    'FR-MKT-00:create',
    'FR-MKT-00:read',
    'FR-MKT-00:update',
    'FR-MKT-00:delete',
    'FR-MKT-00:export-csv',
    'FR-MKT-00:execute-local-queue',
    'FR-MKT-02:execute',
    'FR-VLT-01:create',
    'FR-VLT-01:read',
    'FR-VLT-01:update',
    'FR-VLT-01:delete',
    'FR-VLT-01:execute-check-in',
    'FR-VLT-02:create',
    'FR-VLT-02:read',
    'FR-VLT-02:update',
    'FR-VLT-02:delete',
    'FR-VLT-03:execute',
    'FR-VLT-04:create',
    'FR-VLT-04:read',
    'FR-VLT-04:update',
    'FR-VLT-04:delete',
    'FR-VLT-04:execute',
    'FR-VLT-04:reconcile',
    'FR-VLT-05:create',
    'FR-VLT-05:read',
    'FR-VLT-05:update',
    'FR-VLT-05:delete',
    'FR-VLT-05:trigger',
    'FR-VLT-05:audit',
    'FR-VLT-05:execute-count',
    'FR-CAN-01:create',
    'FR-CAN-01:read',
    'FR-CAN-01:update',
    'FR-CAN-01:delete',
    'FR-CAN-02:create',
    'FR-CAN-02:read',
    'FR-CAN-02:update',
    'FR-CAN-02:delete',
    'FR-CAN-02:audit',
    'FR-CAN-03:execute',
    'FR-CAN-03:witness',
    'FR-CAN-04:create',
    'FR-CAN-04:read',
    'FR-CAN-04:update',
    'FR-CAN-04:delete',
    'FR-CAN-04:export',
    'AUTH-MEMBERSHIP:deactivate',
    'AUTH-MEMBERSHIP:reactivate',
  ]),

  [UserRole.HUNTER_MECHANIC]: freezeSet([
    'FR-DEAL-01:create',
    'FR-DEAL-01:read',
    'FR-INT-01:create',
    'FR-INT-01:update',
    'FR-INT-02:create',
    'FR-INT-02:relocate',
    'FR-EXP-01:create',
    'FR-EXP-01:read',
    'FR-EXP-02:read-own-float',
    'FR-LOG-01:create',
    'FR-LOG-01:read',
    'FR-LOG-02:read-packing-list',
    'FR-CHK-01:execute-cad-only',
    'FR-MKT-00:execute-local-queue',
    'FR-MKT-00:read',
    'FR-MKT-02:execute',
    'FR-VLT-01:read-status',
    'FR-VLT-02:create-broker',
    'FR-VLT-04:read-own-leads',
    // Cannabis grants apply strictly if holding an explicit CANNABIS_NURSERY_AND_PROCESSING membership
    'FR-CAN-01:create',
    'FR-CAN-01:relocate',
    'FR-CAN-02:execute-run',
    'FR-CAN-03:witness',
    'FR-CAN-04:read-summary',
  ]),

  [UserRole.ONTARIO_STRIPPER]: freezeSet([
    'FR-INT-01:read-strip-queue',
    'FR-INT-02:create',
    'FR-INT-02:relocate',
    'FR-EXP-02:read-own-piece-rate',
    'FR-LOG-01:execute-scan',
  ]),

  [UserRole.TRINIDAD_VAULT_ADMIN]: freezeSet([
    'FR-INT-01:read-exported',
    'FR-EXP-01:create-port-fees',
    'FR-LOG-01:read-manifest',
    'FR-LOG-02:read',
    'FR-LOG-02:download',
    'FR-VLT-01:execute-check-in',
    'FR-VLT-02:create',
    'FR-VLT-02:read',
    'FR-VLT-02:update',
    'FR-VLT-02:delete',
    'FR-VLT-03:execute',
    'FR-VLT-04:create',
    'FR-VLT-04:execute',
    'FR-VLT-05:execute-count',
  ]),

  [UserRole.OVERSEAS_B2B_BUYER]: freezeSet([
    'FR-LOG-01:read-loading-tab',
    'FR-VLT-02:create-rate-limited',
    'FR-VLT-04:read-own-commission',
  ]),

  [UserRole.CANNABIS_QAP_COMPLIANCE]: freezeSet([
    'FR-EXP-01:create',
    'FR-EXP-01:read',
    'FR-CAN-01:create',
    'FR-CAN-01:read',
    'FR-CAN-01:update',
    'FR-CAN-01:delete',
    'FR-CAN-01:hold-release',
    'FR-CAN-02:create',
    'FR-CAN-02:read',
    'FR-CAN-02:update',
    'FR-CAN-02:delete',
    'FR-CAN-02:verify-variance',
    'FR-CAN-03:execute',
    'FR-CAN-03:qap-execute',
    'FR-CAN-03:witness',
    'FR-CAN-04:create',
    'FR-CAN-04:read',
    'FR-CAN-04:update',
    'FR-CAN-04:delete',
    'FR-CAN-04:sign-off',
    'FR-CAN-04:export',
  ]),

  [UserRole.NURSERY_CULTIVATION_TECH]: freezeSet([
    'FR-EXP-01:create-nursery-supplies',
    'FR-CAN-01:create',
    'FR-CAN-01:relocate',
    'FR-CAN-02:execute-run',
    'FR-CAN-03:execute',
    'FR-CAN-03:witness',
  ]),
};

export function isKnownCapability(value: unknown): value is CapabilityInput {
  if (typeof value !== 'string') {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(CAPABILITY_METADATA, value) ||
    Object.prototype.hasOwnProperty.call(BASE_FR_PRIMARY_CAPABILITY, value)
  );
}

export function resolveCapabilityId(
  capabilityInput: CapabilityInput,
): CapabilityId | null {
  if (typeof capabilityInput !== 'string') {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(CAPABILITY_METADATA, capabilityInput)
  ) {
    return capabilityInput as CapabilityId;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      BASE_FR_PRIMARY_CAPABILITY,
      capabilityInput,
    )
  ) {
    return BASE_FR_PRIMARY_CAPABILITY[
      capabilityInput as FunctionalRequirementId
    ];
  }
  return null;
}

export function isRoleAllowedInOrganizationType(
  role: UserRole,
  organizationType: OrganizationType,
): boolean {
  const allowed = ROLE_ALLOWED_ORGANIZATION_TYPES[role];
  return Array.isArray(allowed) && allowed.includes(organizationType);
}

export function roleRequiresMfaEnrollment(role: UserRole): boolean {
  return MFA_ENROLLMENT_REQUIRED_ROLES.has(role);
}

export function roleHasCapability(
  role: UserRole,
  organizationType: OrganizationType,
  capabilityInput: CapabilityInput,
): boolean {
  if (!isRoleAllowedInOrganizationType(role, organizationType)) {
    return false;
  }
  const resolvedId = resolveCapabilityId(capabilityInput);
  if (!resolvedId) {
    return false;
  }
  const descriptor = CAPABILITY_METADATA[resolvedId];
  if (!descriptor.allowedOrganizationTypes.includes(organizationType)) {
    return false;
  }
  const roleGrants = ROLE_CAPABILITY_MATRIX[role];
  return Boolean(roleGrants && roleGrants.has(resolvedId));
}

export function getCapabilitiesForRole(
  role: UserRole,
  organizationType?: OrganizationType,
): readonly CapabilityId[] {
  const roleGrants = ROLE_CAPABILITY_MATRIX[role];
  if (!roleGrants) {
    return [];
  }
  const list = [...roleGrants];
  if (!organizationType) {
    return list;
  }
  if (!isRoleAllowedInOrganizationType(role, organizationType)) {
    return [];
  }
  return list.filter((capId) =>
    CAPABILITY_METADATA[capId].allowedOrganizationTypes.includes(
      organizationType,
    ),
  );
}
