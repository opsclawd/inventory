import type { OrganizationType, UserRole } from '@prisma/client';
import type { TenantExecutionContext } from '@/infrastructure/db/tenant-transaction';

export const ACTIVE_ORGANIZATION_COOKIE_NAME =
  'inventory_active_organization' as const;

export const ASSURANCE_LEVELS = ['aal1', 'aal2'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export type AuthErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_AUTH_INPUT'
  | 'MEMBERSHIP_REVOKED_OR_INACTIVE'
  | 'CAPABILITY_FORBIDDEN'
  | 'TENANT_SCOPE_MISMATCH'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'MFA_AAL2_REQUIRED'
  | 'LAST_ACTIVE_CFO_PROTECTED'
  | 'AUTH_CONFIGURATION_ERROR';

export type AuthErrorStatus = 400 | 401 | 403 | 422 | 500;

const AUTH_ERROR_STATUS_BY_CODE: Readonly<Record<AuthErrorCode, AuthErrorStatus>> =
  {
    UNAUTHENTICATED: 401,
    INVALID_AUTH_INPUT: 400,
    MEMBERSHIP_REVOKED_OR_INACTIVE: 403,
    CAPABILITY_FORBIDDEN: 403,
    TENANT_SCOPE_MISMATCH: 403,
    MFA_ENROLLMENT_REQUIRED: 403,
    MFA_AAL2_REQUIRED: 403,
    LAST_ACTIVE_CFO_PROTECTED: 422,
    AUTH_CONFIGURATION_ERROR: 500,
  };

/**
 * Typed fail-closed authorization and identity error carrying deterministic HTTP status codes.
 */
export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public readonly status: AuthErrorStatus;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: AuthErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = AUTH_ERROR_STATUS_BY_CODE[code];
    this.details = details;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export function assertValidUuid(
  value: unknown,
  fieldName: string,
  errorCode: AuthErrorCode = 'INVALID_AUTH_INPUT',
): string {
  if (!isValidUuid(value)) {
    throw new AuthError(
      errorCode,
      `${fieldName} must be a valid UUID string.`,
    );
  }
  return value.toLowerCase();
}

export interface ActiveMembershipSummary {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly organizationType: OrganizationType;
  readonly role: UserRole;
  readonly isDefaultWorkspace: boolean;
}

export interface AuthSessionContext {
  readonly userId: string;
  readonly activeOrganizationId: string;
  readonly role: UserRole;
  readonly activeOrganizationType: OrganizationType;
  readonly activeMemberships: readonly ActiveMembershipSummary[];
  readonly aal: AssuranceLevel;
  readonly mfaEnrolled: boolean;
}

const TRUSTED_AUTH_SESSIONS = new WeakSet<AuthSessionContext>();

/**
 * @internal Constructs a frozen, module-trusted AuthSessionContext instance.
 * Not re-exported from the public auth barrel so unverified client objects cannot impersonate server sessions.
 */
export function createAuthSessionContext(input: {
  userId: string;
  activeOrganizationId: string;
  role: UserRole;
  activeOrganizationType: OrganizationType;
  activeMemberships: readonly ActiveMembershipSummary[];
  aal: AssuranceLevel;
  mfaEnrolled: boolean;
}): AuthSessionContext {
  const frozenMemberships = Object.freeze(
    input.activeMemberships.map((m) => Object.freeze({ ...m })),
  );
  const session: AuthSessionContext = Object.freeze({
    userId: input.userId,
    activeOrganizationId: input.activeOrganizationId,
    role: input.role,
    activeOrganizationType: input.activeOrganizationType,
    activeMemberships: frozenMemberships,
    aal: input.aal,
    mfaEnrolled: input.mfaEnrolled,
  });
  TRUSTED_AUTH_SESSIONS.add(session);
  return session;
}

export function assertTrustedAuthSession(
  session: unknown,
): asserts session is AuthSessionContext {
  if (
    !session ||
    typeof session !== 'object' ||
    !TRUSTED_AUTH_SESSIONS.has(session as AuthSessionContext)
  ) {
    throw new AuthError(
      'UNAUTHENTICATED',
      'AuthSessionContext must be resolved on the server for the current request.',
    );
  }
}

export interface BootstrapMembershipRecord {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly organizationType: OrganizationType;
  readonly organizationIsActive: boolean;
  readonly role: UserRole;
  readonly isDefaultWorkspace: boolean;
  readonly isActive: boolean;
}

export interface BootstrapUserRecord {
  readonly userId: string;
  readonly isActive: boolean;
  readonly mfaEnrolled: boolean;
  readonly memberships: readonly BootstrapMembershipRecord[];
}

export interface WorkspaceSwitchRepoInput {
  readonly sourceContext: TenantExecutionContext;
  readonly targetContext: TenantExecutionContext;
  readonly targetMembershipId: string;
  readonly occurredAt: Date;
  readonly auditId: string;
}

export interface DeactivateMembershipRepoInput {
  readonly actorContext: TenantExecutionContext;
  readonly membershipId: string;
  readonly reason: string;
  readonly occurredAt: Date;
  readonly auditId: string;
}

export interface ReactivateMembershipRepoInput {
  readonly actorContext: TenantExecutionContext;
  readonly membershipId: string;
  readonly occurredAt: Date;
  readonly auditId: string;
}

export interface MembershipTransitionSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly isDefaultWorkspace: boolean;
  readonly isActive: boolean;
  readonly deactivatedAt: Date | null;
  readonly deactivatedById: string | null;
  readonly revocationReason: string | null;
}

export interface MembershipTransitionResult {
  readonly changed: boolean;
  readonly auditId: string | null;
  readonly membership: MembershipTransitionSnapshot;
}

export interface AuthRepository {
  findActiveUserBootstrap(userId: string): Promise<BootstrapUserRecord | null>;
  recordWorkspaceSwitch(input: WorkspaceSwitchRepoInput): Promise<void>;
  deactivateOrganizationMembership(
    input: DeactivateMembershipRepoInput,
  ): Promise<MembershipTransitionResult>;
  reactivateOrganizationMembership(
    input: ReactivateMembershipRepoInput,
  ): Promise<MembershipTransitionResult>;
}

export interface AuthCookieWriter {
  setActiveOrganization(organizationId: string): Promise<void>;
}

export interface AuthClock {
  now(): Date;
}
