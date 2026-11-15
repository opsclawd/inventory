import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  ACTIVE_ORGANIZATION_COOKIE_NAME,
  assertTrustedAuthSession,
  assertValidUuid,
  type AuthClock,
  type AuthCookieWriter,
  AuthError,
  type AuthRepository,
  type AuthSessionContext,
  type MembershipTransitionResult,
} from './auth.contracts';
import {
  assertCapability,
  createPrismaAuthRepository,
  resolveSessionFromBootstrapRecord,
  toTenantExecutionContext,
} from './auth-context';
import {
  isRoleAllowedInOrganizationType,
  roleRequiresMfaEnrollment,
} from './rbac-matrix';

const DEFAULT_AUTH_CLOCK: AuthClock = {
  now: () => new Date(),
};

export function createNextActiveOrganizationCookieWriter(): AuthCookieWriter {
  return {
    async setActiveOrganization(organizationId: string): Promise<void> {
      const normalizedOrgId = assertValidUuid(
        organizationId,
        'organizationId',
        'INVALID_AUTH_INPUT',
      );
      const cookieStore = await cookies();
      cookieStore.set(ACTIVE_ORGANIZATION_COOKIE_NAME, normalizedOrgId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
    },
  };
}

export interface SwitchWorkspaceDeps {
  readonly repository?: AuthRepository;
  readonly cookieWriter?: AuthCookieWriter;
  readonly clock?: AuthClock;
  readonly idGenerator?: () => string;
}

export interface MembershipLifecycleDeps {
  readonly repository?: AuthRepository;
  readonly clock?: AuthClock;
  readonly idGenerator?: () => string;
}

/**
 * Switches the authenticated user's active organization workspace after revalidating
 * both the source active membership and the target active membership, recording an
 * immutable WORKSPACE_SWITCHED AuditLog inside a fresh root target tenant transaction,
 * and updating the active organization preference cookie only after commit succeeds.
 */
export async function switchOrganizationWorkspace(
  session: AuthSessionContext,
  targetOrganizationId: string,
  deps: SwitchWorkspaceDeps = {},
): Promise<AuthSessionContext> {
  assertTrustedAuthSession(session);

  const normalizedTargetOrgId = assertValidUuid(
    targetOrganizationId,
    'targetOrganizationId',
    'INVALID_AUTH_INPUT',
  );

  const repository = deps.repository ?? createPrismaAuthRepository();
  const cookieWriter =
    deps.cookieWriter ?? createNextActiveOrganizationCookieWriter();
  const clock = deps.clock ?? DEFAULT_AUTH_CLOCK;
  const idGenerator = deps.idGenerator ?? randomUUID;

  const bootstrap = await repository.findActiveUserBootstrap(session.userId);
  if (!bootstrap || !bootstrap.isActive) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'Authenticated user or active memberships are no longer active.',
    );
  }

  const normalizedSourceOrgId = session.activeOrganizationId.toLowerCase();
  const sourceMembership = bootstrap.memberships.find(
    (m) =>
      m.isActive &&
      m.organizationIsActive &&
      m.organizationId.toLowerCase() === normalizedSourceOrgId &&
      m.role === session.role,
  );
  if (!sourceMembership) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'Current active organization membership has been revoked or deactivated.',
    );
  }

  const targetMembership = bootstrap.memberships.find(
    (m) =>
      m.isActive &&
      m.organizationIsActive &&
      m.organizationId.toLowerCase() === normalizedTargetOrgId,
  );
  if (!targetMembership) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'Target organization membership is revoked, inactive, or unauthorized.',
    );
  }

  if (
    !isRoleAllowedInOrganizationType(
      targetMembership.role,
      targetMembership.organizationType,
    )
  ) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      'Target membership role is incompatible with the target organization type.',
    );
  }

  if (
    roleRequiresMfaEnrollment(targetMembership.role) &&
    !bootstrap.mfaEnrolled
  ) {
    throw new AuthError(
      'MFA_ENROLLMENT_REQUIRED',
      'Multi-factor authentication enrollment is required for the target role.',
    );
  }

  await repository.recordWorkspaceSwitch({
    sourceContext: toTenantExecutionContext(session),
    targetContext: {
      organizationId: targetMembership.organizationId.toLowerCase(),
      userId: session.userId.toLowerCase(),
      role: targetMembership.role,
    },
    targetMembershipId: targetMembership.membershipId.toLowerCase(),
    occurredAt: clock.now(),
    auditId: idGenerator(),
  });

  // Update the untrusted preference cookie strictly after the audit transaction commits.
  await cookieWriter.setActiveOrganization(normalizedTargetOrgId);

  return resolveSessionFromBootstrapRecord({
    userId: session.userId,
    aal: session.aal,
    selectedOrganizationId: normalizedTargetOrgId,
    bootstrap,
  });
}

/**
 * Soft-revokes an OrganizationMembership inside session.activeOrganizationId
 * (ARCHITECT_CFO + MFA aal2 required), preserving historical User FKs, protecting
 * the last effective active CFO (422 LAST_ACTIVE_CFO_PROTECTED), and writing an
 * immutable AuditLog entry in the same atomic statement.
 */
export async function deactivateOrganizationMembership(
  session: AuthSessionContext,
  membershipId: string,
  reason: string,
  deps: MembershipLifecycleDeps = {},
): Promise<MembershipTransitionResult> {
  assertTrustedAuthSession(session);

  const normalizedMembershipId = assertValidUuid(
    membershipId,
    'membershipId',
    'INVALID_AUTH_INPUT',
  );

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new AuthError(
      'INVALID_AUTH_INPUT',
      'A non-empty revocation reason is required.',
    );
  }

  assertCapability(session, 'AUTH-MEMBERSHIP:deactivate');

  const repository = deps.repository ?? createPrismaAuthRepository();
  const clock = deps.clock ?? DEFAULT_AUTH_CLOCK;
  const idGenerator = deps.idGenerator ?? randomUUID;

  return repository.deactivateOrganizationMembership({
    actorContext: toTenantExecutionContext(session),
    membershipId: normalizedMembershipId,
    reason: reason.trim(),
    occurredAt: clock.now(),
    auditId: idGenerator(),
  });
}

/**
 * Reactivates a soft-revoked OrganizationMembership inside session.activeOrganizationId
 * (ARCHITECT_CFO + MFA aal2 required), clearing deactivation metadata while preserving
 * immutable prior revocation AuditLog evidence and never altering User.role or User.isActive.
 */
export async function reactivateOrganizationMembership(
  session: AuthSessionContext,
  membershipId: string,
  deps: MembershipLifecycleDeps = {},
): Promise<MembershipTransitionResult> {
  assertTrustedAuthSession(session);

  const normalizedMembershipId = assertValidUuid(
    membershipId,
    'membershipId',
    'INVALID_AUTH_INPUT',
  );

  assertCapability(session, 'AUTH-MEMBERSHIP:reactivate');

  const repository = deps.repository ?? createPrismaAuthRepository();
  const clock = deps.clock ?? DEFAULT_AUTH_CLOCK;
  const idGenerator = deps.idGenerator ?? randomUUID;

  return repository.reactivateOrganizationMembership({
    actorContext: toTenantExecutionContext(session),
    membershipId: normalizedMembershipId,
    occurredAt: clock.now(),
    auditId: idGenerator(),
  });
}
