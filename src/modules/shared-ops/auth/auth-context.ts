import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import type { OrganizationType, PrismaClient, UserRole } from '@prisma/client';
import { cookies, headers } from 'next/headers';
import {
  TenantContextError,
  type TenantExecutionContext,
  withAuthBootstrapTransaction,
  withTenantTransaction,
} from '@/infrastructure/db/tenant-transaction';
import {
  ACTIVE_ORGANIZATION_COOKIE_NAME,
  assertTrustedAuthSession,
  assertValidUuid,
  type ActiveMembershipSummary,
  type AssuranceLevel,
  AuthError,
  type AuthRepository,
  type AuthSessionContext,
  type BootstrapMembershipRecord,
  type BootstrapUserRecord,
  createAuthSessionContext,
  type DeactivateMembershipRepoInput,
  isValidUuid,
  type MembershipTransitionResult,
  type MembershipTransitionSnapshot,
  type ReactivateMembershipRepoInput,
  type WorkspaceSwitchRepoInput,
} from './auth.contracts';
import {
  CAPABILITY_METADATA,
  type CapabilityId,
  type CapabilityInput,
  isRoleAllowedInOrganizationType,
  resolveCapabilityId,
  ROLE_CAPABILITY_MATRIX,
  roleRequiresMfaEnrollment,
} from './rbac-matrix';

export interface SupabaseAuthClaimSet {
  readonly sub?: unknown;
  readonly aal?: unknown;
  readonly exp?: unknown;
}

export interface SupabaseServerAuthClient {
  readonly auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
    getClaims(): Promise<{
      data: { claims: SupabaseAuthClaimSet } | null;
      error: unknown;
    }>;
  };
}

export interface ResolveAuthSessionOptions {
  readonly isMutationContext?: boolean;
  readonly repository?: AuthRepository;
  readonly supabaseClientFactory?: (params: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    cookies: CookieMethodsServer;
  }) => SupabaseServerAuthClient;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function isNextReadOnlyCookieMutationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes(
    'Cookies can only be modified in a Server Action or Route Handler',
  );
}

/**
 * Translates TenantContextError('TENANT_CONTEXT_UNAUTHORIZED') at the auth boundary
 * to HTTP 403 MEMBERSHIP_REVOKED_OR_INACTIVE while preserving infrastructure and programmer errors.
 */
export function translateTenantContextError(error: unknown): never {
  if (
    error instanceof TenantContextError &&
    error.code === 'TENANT_CONTEXT_UNAUTHORIZED'
  ) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'Active organization membership is revoked, inactive, or unauthorized.',
    );
  }
  throw error;
}

async function resolveRuntimePrisma(
  explicitPrisma?: PrismaClient,
): Promise<PrismaClient> {
  if (explicitPrisma) {
    return explicitPrisma;
  }
  const mod = await import('@/infrastructure/db/prisma');
  return mod.prisma;
}

async function runWithTenantTxAuthBoundary<T>(
  prismaClient: PrismaClient,
  ctx: TenantExecutionContext,
  fn: Parameters<typeof withTenantTransaction<T>>[2],
): Promise<T> {
  try {
    return await withTenantTransaction(prismaClient, ctx, fn);
  } catch (error) {
    translateTenantContextError(error);
  }
}

interface RawMembershipRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  isDefaultWorkspace: boolean;
  isActive: boolean;
  deactivatedAt: Date | null;
  deactivatedById: string | null;
  revocationReason: string | null;
}

function toMembershipSnapshot(
  row: RawMembershipRow,
): MembershipTransitionSnapshot {
  return {
    id: row.id.toLowerCase(),
    organizationId: row.organizationId.toLowerCase(),
    userId: row.userId.toLowerCase(),
    role: row.role as UserRole,
    isDefaultWorkspace: row.isDefaultWorkspace,
    isActive: row.isActive,
    deactivatedAt: row.deactivatedAt,
    deactivatedById: row.deactivatedById
      ? row.deactivatedById.toLowerCase()
      : null,
    revocationReason: row.revocationReason,
  };
}

/**
 * Constructs the production AuthRepository backed by withAuthBootstrapTransaction and
 * withTenantTransaction. Imports the singleton Prisma client lazily at call time so
 * offline tests and module imports do not require runtime DATABASE_URL configuration.
 */
export function createPrismaAuthRepository(options?: {
  readonly prisma?: PrismaClient;
}): AuthRepository {
  const explicitPrisma = options?.prisma;

  return {
    async findActiveUserBootstrap(
      userId: string,
    ): Promise<BootstrapUserRecord | null> {
      const normalizedUserId = assertValidUuid(
        userId,
        'userId',
        'UNAUTHENTICATED',
      );
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      try {
        return await withAuthBootstrapTransaction(
          prismaClient,
          normalizedUserId,
          async (tx) => {
            const user = await tx.user.findUnique({
              where: { id: normalizedUserId },
              select: {
                id: true,
                isActive: true,
                mfaEnrolled: true,
              },
            });

            if (!user || !user.isActive) {
              return null;
            }

            const memberships = await tx.organizationMembership.findMany({
              where: {
                userId: normalizedUserId,
                isActive: true,
                organization: {
                  isActive: true,
                },
              },
              select: {
                id: true,
                organizationId: true,
                role: true,
                isDefaultWorkspace: true,
                isActive: true,
                organization: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                    organizationType: true,
                    isActive: true,
                  },
                },
              },
              orderBy: {
                organizationId: 'asc',
              },
            });

            return {
              userId: user.id.toLowerCase(),
              isActive: user.isActive,
              mfaEnrolled: user.mfaEnrolled,
              memberships: memberships.map(
                (m): BootstrapMembershipRecord => ({
                  membershipId: m.id.toLowerCase(),
                  organizationId: m.organizationId.toLowerCase(),
                  organizationSlug: m.organization.slug,
                  organizationName: m.organization.name,
                  organizationType: m.organization.organizationType,
                  organizationIsActive: m.organization.isActive,
                  role: m.role,
                  isDefaultWorkspace: m.isDefaultWorkspace,
                  isActive: m.isActive,
                }),
              ),
            };
          },
        );
      } catch (error) {
        if (
          error instanceof TenantContextError &&
          error.code === 'TENANT_CONTEXT_UNAUTHORIZED'
        ) {
          return null;
        }
        throw error;
      }
    },

    async recordWorkspaceSwitch(
      input: WorkspaceSwitchRepoInput,
    ): Promise<void> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);

      // Revalidate source membership in its own root transaction first so a revoked
      // source session cannot be laundered via a switch request.
      await runWithTenantTxAuthBoundary(
        prismaClient,
        input.sourceContext,
        async () => true,
      );

      // Open a fresh root transaction for the target tenant context and record audit intent.
      await runWithTenantTxAuthBoundary(
        prismaClient,
        input.targetContext,
        async (tx) => {
          await tx.auditLog.create({
            data: {
              id: input.auditId,
              organizationId: input.targetContext.organizationId,
              actorUserId: input.targetContext.userId,
              entityType: 'OrganizationMembership',
              entityId: input.targetMembershipId,
              action: 'WORKSPACE_SWITCHED',
              previousState: {
                activeOrganizationId: input.sourceContext.organizationId,
                role: input.sourceContext.role,
              },
              nextState: {
                activeOrganizationId: input.targetContext.organizationId,
                role: input.targetContext.role,
              },
              createdAt: input.occurredAt,
            },
          });
        },
      );
    },

    async deactivateOrganizationMembership(
      input: DeactivateMembershipRepoInput,
    ): Promise<MembershipTransitionResult> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);
      const organizationId = input.actorContext.organizationId.toLowerCase();
      const actorUserId = input.actorContext.userId.toLowerCase();
      const membershipId = input.membershipId.toLowerCase();

      return runWithTenantTxAuthBoundary(
        prismaClient,
        input.actorContext,
        async (tx) => {
          // 1. Serialize all membership lifecycle transitions for the organization.
          const orgRows = await tx.$queryRaw<
            Array<{
              id: string;
              organizationType: OrganizationType;
              isActive: boolean;
            }>
          >`
            SELECT
              "id"::text AS "id",
              "organizationType"::text AS "organizationType",
              "isActive"
            FROM "shared"."Organization"
            WHERE "id" = ${organizationId}::uuid
            FOR UPDATE
          `;
          const orgRow = orgRows[0];
          if (!orgRow || !orgRow.isActive) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Active organization membership is required.',
            );
          }

          // 2. Recheck actor live membership & MFA enrollment under the organization lock.
          const actorRows = await tx.$queryRaw<
            Array<{
              id: string;
              role: string;
              membershipActive: boolean;
              userActive: boolean;
              mfaEnrolled: boolean;
            }>
          >`
            SELECT
              m."id"::text AS "id",
              m."role"::text AS "role",
              m."isActive" AS "membershipActive",
              u."isActive" AS "userActive",
              u."mfaEnrolled" AS "mfaEnrolled"
            FROM "shared"."OrganizationMembership" m
            INNER JOIN "shared"."User" u ON u."id" = m."userId"
            WHERE m."organizationId" = ${organizationId}::uuid
              AND m."userId" = ${actorUserId}::uuid
            FOR UPDATE OF m
          `;
          const actorRow = actorRows[0];
          if (
            !actorRow ||
            !actorRow.membershipActive ||
            !actorRow.userActive
          ) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Actor membership or user account is inactive.',
            );
          }
          if (actorRow.role !== 'ARCHITECT_CFO') {
            throw new AuthError(
              'CAPABILITY_FORBIDDEN',
              'Only an active ARCHITECT_CFO in the organization may deactivate memberships.',
            );
          }
          if (!actorRow.mfaEnrolled) {
            throw new AuthError(
              'MFA_ENROLLMENT_REQUIRED',
              'MFA enrollment is required for membership administration.',
            );
          }

          // 3. Locate target membership strictly scoped to the active organization.
          const targetRows = await tx.$queryRaw<
            Array<RawMembershipRow & { userIsActive: boolean }>
          >`
            SELECT
              m."id"::text AS "id",
              m."organizationId"::text AS "organizationId",
              m."userId"::text AS "userId",
              m."role"::text AS "role",
              m."isDefaultWorkspace",
              m."isActive",
              m."deactivatedAt",
              m."deactivatedById"::text AS "deactivatedById",
              m."revocationReason",
              u."isActive" AS "userIsActive"
            FROM "shared"."OrganizationMembership" m
            INNER JOIN "shared"."User" u ON u."id" = m."userId"
            WHERE m."id" = ${membershipId}::uuid
              AND m."organizationId" = ${organizationId}::uuid
            FOR UPDATE OF m
          `;
          const target = targetRows[0];
          if (!target) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Target membership is unavailable or outside the active organization.',
            );
          }

          // 4. Idempotent no-op if already deactivated (no duplicate audit row).
          if (!target.isActive) {
            return {
              changed: false,
              auditId: null,
              membership: toMembershipSnapshot(target),
            };
          }

          // 5. Enforce last active/effective CFO invariant before modifying state.
          if (target.role === 'ARCHITECT_CFO') {
            const countRows = await tx.$queryRaw<
              Array<{ activeCfoCount: number }>
            >`
              SELECT COUNT(*)::int AS "activeCfoCount"
              FROM "shared"."OrganizationMembership" m
              INNER JOIN "shared"."User" u ON u."id" = m."userId"
              WHERE m."organizationId" = ${organizationId}::uuid
                AND m."role" = 'ARCHITECT_CFO'::"shared"."UserRole"
                AND m."isActive" = true
                AND u."isActive" = true
            `;
            const currentEffectiveCfoCount = countRows[0]?.activeCfoCount ?? 0;
            const remainingEffectiveCfoCount =
              currentEffectiveCfoCount - (target.userIsActive ? 1 : 0);
            if (remainingEffectiveCfoCount < 1) {
              throw new AuthError(
                'LAST_ACTIVE_CFO_PROTECTED',
                'Cannot deactivate the last active ARCHITECT_CFO in this organization.',
              );
            }
          }

          // 6. Single parameterized data-modifying CTE statement so self-revocation
          //    records its immutable AuditLog under the shared statement snapshot before
          //    any subsequent query would observe the revoked membership.
          const previousStateJson = JSON.stringify({
            isActive: target.isActive,
            role: target.role,
            deactivatedAt: target.deactivatedAt?.toISOString() ?? null,
            deactivatedById: target.deactivatedById,
            revocationReason: target.revocationReason,
          });
          const nextStateJson = JSON.stringify({
            isActive: false,
            role: target.role,
            deactivatedAt: input.occurredAt.toISOString(),
            deactivatedById: actorUserId,
            revocationReason: input.reason,
          });

          const updatedRows = await tx.$queryRaw<
            Array<RawMembershipRow & { auditId: string }>
          >`
            WITH inserted_audit AS (
              INSERT INTO "shared"."AuditLog" (
                "id",
                "organizationId",
                "actorUserId",
                "entityType",
                "entityId",
                "action",
                "previousState",
                "nextState",
                "ipAddress",
                "createdAt"
              )
              VALUES (
                ${input.auditId}::uuid,
                ${organizationId}::uuid,
                ${actorUserId}::uuid,
                'OrganizationMembership',
                ${membershipId},
                'MEMBERSHIP_DEACTIVATED',
                ${previousStateJson}::jsonb,
                ${nextStateJson}::jsonb,
                NULL,
                ${input.occurredAt}
              )
              RETURNING "id"::text AS "auditId"
            )
            UPDATE "shared"."OrganizationMembership" AS m
            SET
              "isActive" = false,
              "deactivatedAt" = ${input.occurredAt},
              "deactivatedById" = ${actorUserId}::uuid,
              "revocationReason" = ${input.reason},
              "updatedAt" = ${input.occurredAt}
            FROM inserted_audit AS a
            WHERE m."id" = ${membershipId}::uuid
              AND m."organizationId" = ${organizationId}::uuid
              AND m."isActive" = true
            RETURNING
              m."id"::text AS "id",
              m."organizationId"::text AS "organizationId",
              m."userId"::text AS "userId",
              m."role"::text AS "role",
              m."isDefaultWorkspace",
              m."isActive",
              m."deactivatedAt",
              m."deactivatedById"::text AS "deactivatedById",
              m."revocationReason",
              a."auditId"
          `;

          const updated = updatedRows[0];
          if (!updated) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Membership could not be deactivated due to concurrent state change.',
            );
          }

          return {
            changed: true,
            auditId: updated.auditId.toLowerCase(),
            membership: toMembershipSnapshot(updated),
          };
        },
      );
    },

    async reactivateOrganizationMembership(
      input: ReactivateMembershipRepoInput,
    ): Promise<MembershipTransitionResult> {
      const prismaClient = await resolveRuntimePrisma(explicitPrisma);
      const organizationId = input.actorContext.organizationId.toLowerCase();
      const actorUserId = input.actorContext.userId.toLowerCase();
      const membershipId = input.membershipId.toLowerCase();

      return runWithTenantTxAuthBoundary(
        prismaClient,
        input.actorContext,
        async (tx) => {
          // 1. Serialize membership lifecycle transitions for the organization.
          const orgRows = await tx.$queryRaw<
            Array<{
              id: string;
              organizationType: OrganizationType;
              isActive: boolean;
            }>
          >`
            SELECT
              "id"::text AS "id",
              "organizationType"::text AS "organizationType",
              "isActive"
            FROM "shared"."Organization"
            WHERE "id" = ${organizationId}::uuid
            FOR UPDATE
          `;
          const orgRow = orgRows[0];
          if (!orgRow || !orgRow.isActive) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Active organization membership is required.',
            );
          }

          // 2. Recheck actor live membership & MFA enrollment under the organization lock.
          const actorRows = await tx.$queryRaw<
            Array<{
              id: string;
              role: string;
              membershipActive: boolean;
              userActive: boolean;
              mfaEnrolled: boolean;
            }>
          >`
            SELECT
              m."id"::text AS "id",
              m."role"::text AS "role",
              m."isActive" AS "membershipActive",
              u."isActive" AS "userActive",
              u."mfaEnrolled" AS "mfaEnrolled"
            FROM "shared"."OrganizationMembership" m
            INNER JOIN "shared"."User" u ON u."id" = m."userId"
            WHERE m."organizationId" = ${organizationId}::uuid
              AND m."userId" = ${actorUserId}::uuid
            FOR UPDATE OF m
          `;
          const actorRow = actorRows[0];
          if (
            !actorRow ||
            !actorRow.membershipActive ||
            !actorRow.userActive
          ) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Actor membership or user account is inactive.',
            );
          }
          if (actorRow.role !== 'ARCHITECT_CFO') {
            throw new AuthError(
              'CAPABILITY_FORBIDDEN',
              'Only an active ARCHITECT_CFO in the organization may reactivate memberships.',
            );
          }
          if (!actorRow.mfaEnrolled) {
            throw new AuthError(
              'MFA_ENROLLMENT_REQUIRED',
              'MFA enrollment is required for membership administration.',
            );
          }

          // 3. Locate target membership strictly scoped to the active organization.
          const targetRows = await tx.$queryRaw<
            Array<RawMembershipRow & { userIsActive: boolean }>
          >`
            SELECT
              m."id"::text AS "id",
              m."organizationId"::text AS "organizationId",
              m."userId"::text AS "userId",
              m."role"::text AS "role",
              m."isDefaultWorkspace",
              m."isActive",
              m."deactivatedAt",
              m."deactivatedById"::text AS "deactivatedById",
              m."revocationReason",
              u."isActive" AS "userIsActive"
            FROM "shared"."OrganizationMembership" m
            INNER JOIN "shared"."User" u ON u."id" = m."userId"
            WHERE m."id" = ${membershipId}::uuid
              AND m."organizationId" = ${organizationId}::uuid
            FOR UPDATE OF m
          `;
          const target = targetRows[0];
          if (!target) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Target membership is unavailable or outside the active organization.',
            );
          }

          // 4. Reactivating a membership must never reactivate a globally disabled User.
          if (!target.userIsActive) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Target membership cannot be reactivated while the underlying user or organization is inactive.',
            );
          }

          // 5. Reject incompatible role / organizationType combinations.
          if (
            !isRoleAllowedInOrganizationType(
              target.role as UserRole,
              orgRow.organizationType,
            )
          ) {
            throw new AuthError(
              'CAPABILITY_FORBIDDEN',
              'Target membership role is incompatible with the organization type.',
            );
          }

          // 6. Idempotent no-op if already active (no duplicate audit row).
          if (target.isActive) {
            return {
              changed: false,
              auditId: null,
              membership: toMembershipSnapshot(target),
            };
          }

          // 7. Single atomic CTE transition + immutable AuditLog.
          const previousStateJson = JSON.stringify({
            isActive: target.isActive,
            role: target.role,
            deactivatedAt: target.deactivatedAt?.toISOString() ?? null,
            deactivatedById: target.deactivatedById,
            revocationReason: target.revocationReason,
          });
          const nextStateJson = JSON.stringify({
            isActive: true,
            role: target.role,
            deactivatedAt: null,
            deactivatedById: null,
            revocationReason: null,
          });

          const updatedRows = await tx.$queryRaw<
            Array<RawMembershipRow & { auditId: string }>
          >`
            WITH inserted_audit AS (
              INSERT INTO "shared"."AuditLog" (
                "id",
                "organizationId",
                "actorUserId",
                "entityType",
                "entityId",
                "action",
                "previousState",
                "nextState",
                "ipAddress",
                "createdAt"
              )
              VALUES (
                ${input.auditId}::uuid,
                ${organizationId}::uuid,
                ${actorUserId}::uuid,
                'OrganizationMembership',
                ${membershipId},
                'MEMBERSHIP_REACTIVATED',
                ${previousStateJson}::jsonb,
                ${nextStateJson}::jsonb,
                NULL,
                ${input.occurredAt}
              )
              RETURNING "id"::text AS "auditId"
            )
            UPDATE "shared"."OrganizationMembership" AS m
            SET
              "isActive" = true,
              "deactivatedAt" = NULL,
              "deactivatedById" = NULL,
              "revocationReason" = NULL,
              "updatedAt" = ${input.occurredAt}
            FROM inserted_audit AS a
            WHERE m."id" = ${membershipId}::uuid
              AND m."organizationId" = ${organizationId}::uuid
              AND m."isActive" = false
            RETURNING
              m."id"::text AS "id",
              m."organizationId"::text AS "organizationId",
              m."userId"::text AS "userId",
              m."role"::text AS "role",
              m."isDefaultWorkspace",
              m."isActive",
              m."deactivatedAt",
              m."deactivatedById"::text AS "deactivatedById",
              m."revocationReason",
              a."auditId"
          `;

          const updated = updatedRows[0];
          if (!updated) {
            throw new AuthError(
              'MEMBERSHIP_REVOKED_OR_INACTIVE',
              'Membership could not be reactivated due to concurrent state change.',
            );
          }

          return {
            changed: true,
            auditId: updated.auditId.toLowerCase(),
            membership: toMembershipSnapshot(updated),
          };
        },
      );
    },
  };
}

/**
 * Shared membership selection and fail-closed verification path used identically
 * by both production Supabase SSR auth and the test-only header adapter.
 */
export function resolveSessionFromBootstrapRecord(params: {
  readonly userId: string;
  readonly aal: AssuranceLevel;
  readonly selectedOrganizationId?: string | null;
  readonly bootstrap: BootstrapUserRecord | null;
}): AuthSessionContext {
  const { userId, aal, selectedOrganizationId, bootstrap } = params;

  if (!bootstrap || !bootstrap.isActive) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'Authenticated user does not hold an active organization membership.',
    );
  }

  const normalizedUserId = assertValidUuid(userId, 'userId', 'UNAUTHENTICATED');

  const activeMemberships = bootstrap.memberships
    .filter((m) => m.isActive && m.organizationIsActive)
    .map(
      (m): ActiveMembershipSummary => ({
        membershipId: m.membershipId.toLowerCase(),
        organizationId: m.organizationId.toLowerCase(),
        organizationSlug: m.organizationSlug,
        organizationName: m.organizationName,
        organizationType: m.organizationType,
        role: m.role,
        isDefaultWorkspace: m.isDefaultWorkspace,
      }),
    )
    .sort((a, b) => a.organizationId.localeCompare(b.organizationId));

  if (activeMemberships.length === 0) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'Authenticated user does not hold any active organization membership.',
    );
  }

  let selectedMembership: ActiveMembershipSummary | undefined;

  if (
    selectedOrganizationId !== undefined &&
    selectedOrganizationId !== null &&
    selectedOrganizationId.length > 0
  ) {
    if (!isValidUuid(selectedOrganizationId)) {
      throw new AuthError(
        'MEMBERSHIP_REVOKED_OR_INACTIVE',
        'Selected organization is inactive, revoked, or unavailable.',
      );
    }
    const normalizedSelectedOrgId = selectedOrganizationId.toLowerCase();
    selectedMembership = activeMemberships.find(
      (m) => m.organizationId === normalizedSelectedOrgId,
    );
    if (!selectedMembership) {
      throw new AuthError(
        'MEMBERSHIP_REVOKED_OR_INACTIVE',
        'Selected organization membership is revoked, inactive, or unauthorized.',
      );
    }
  } else {
    selectedMembership =
      activeMemberships.find((m) => m.isDefaultWorkspace) ??
      activeMemberships[0];
  }

  if (!selectedMembership) {
    throw new AuthError(
      'MEMBERSHIP_REVOKED_OR_INACTIVE',
      'No active organization membership is available.',
    );
  }

  if (
    !isRoleAllowedInOrganizationType(
      selectedMembership.role,
      selectedMembership.organizationType,
    )
  ) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      'Membership role is incompatible with the selected organization type.',
    );
  }

  if (
    roleRequiresMfaEnrollment(selectedMembership.role) &&
    !bootstrap.mfaEnrolled
  ) {
    throw new AuthError(
      'MFA_ENROLLMENT_REQUIRED',
      'Multi-factor authentication enrollment is required for this role.',
    );
  }

  return createAuthSessionContext({
    userId: normalizedUserId,
    activeOrganizationId: selectedMembership.organizationId,
    role: selectedMembership.role,
    activeOrganizationType: selectedMembership.organizationType,
    activeMemberships,
    aal,
    mfaEnrolled: bootstrap.mfaEnrolled,
  });
}

/**
 * Resolves the trusted server-side AuthSessionContext for a Next.js 15 App Router request
 * using awaited cookies()/headers(), @supabase/ssr getUser() + verified JWT claims AAL,
 * and active OrganizationMembership verification inside withAuthBootstrapTransaction.
 */
export async function resolveAuthSessionContext(
  options: ResolveAuthSessionOptions = {},
): Promise<AuthSessionContext> {
  const env = options.env ?? process.env;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  const supabaseAnonKey =
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (
    typeof supabaseUrl !== 'string' ||
    supabaseUrl.trim().length === 0 ||
    typeof supabaseAnonKey !== 'string' ||
    supabaseAnonKey.trim().length === 0
  ) {
    throw new AuthError(
      'AUTH_CONFIGURATION_ERROR',
      'Supabase server URL and publishable/anon key must be configured.',
    );
  }

  const cookieStore = await cookies();
  const headerList = await headers();
  void headerList;

  const isMutationContext = options.isMutationContext === true;

  const cookieAdapter: CookieMethodsServer = {
    getAll() {
      return cookieStore.getAll();
    },
    setAll(cookiesToSet) {
      try {
        for (const { name, value, options: cookieOptions } of cookiesToSet) {
          cookieStore.set(name, value, cookieOptions);
        }
      } catch (error) {
        if (!isMutationContext && isNextReadOnlyCookieMutationError(error)) {
          return;
        }
        throw error;
      }
    },
  };

  const clientFactory =
    options.supabaseClientFactory ??
    ((params) =>
      createServerClient(params.supabaseUrl, params.supabaseAnonKey, {
        cookies: params.cookies,
      }) as unknown as SupabaseServerAuthClient);

  const supabase = clientFactory({
    supabaseUrl,
    supabaseAnonKey,
    cookies: cookieAdapter,
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user?.id) {
    throw new AuthError('UNAUTHENTICATED', 'Authentication is required.');
  }

  const verifiedUserId = assertValidUuid(
    userData.user.id,
    'authenticatedUserId',
    'UNAUTHENTICATED',
  );

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (claimsError || !claims) {
    throw new AuthError(
      'UNAUTHENTICATED',
      'Verified session claims are unavailable.',
    );
  }

  if (
    typeof claims.sub !== 'string' ||
    !isValidUuid(claims.sub) ||
    claims.sub.toLowerCase() !== verifiedUserId
  ) {
    throw new AuthError(
      'UNAUTHENTICATED',
      'Verified session claims subject does not match authenticated user.',
    );
  }

  if (
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  ) {
    throw new AuthError('UNAUTHENTICATED', 'Verified session has expired.');
  }

  if (claims.aal !== 'aal1' && claims.aal !== 'aal2') {
    throw new AuthError(
      'UNAUTHENTICATED',
      'Verified session assurance level (aal) is missing or invalid.',
    );
  }

  const repository = options.repository ?? createPrismaAuthRepository();
  const bootstrap = await repository.findActiveUserBootstrap(verifiedUserId);
  const selectedOrgCookie = cookieStore.get(
    ACTIVE_ORGANIZATION_COOKIE_NAME,
  )?.value;

  return resolveSessionFromBootstrapRecord({
    userId: verifiedUserId,
    aal: claims.aal,
    selectedOrganizationId: selectedOrgCookie,
    bootstrap,
  });
}

/**
 * Converts a freshly resolved AuthSessionContext into a TenantExecutionContext
 * for passing directly into withTenantTransaction(prisma, ctx, fn).
 */
export function toTenantExecutionContext(
  session: AuthSessionContext,
): TenantExecutionContext {
  assertTrustedAuthSession(session);
  return {
    organizationId: session.activeOrganizationId,
    userId: session.userId,
    role: session.role,
  };
}

/**
 * Verifies that the session holds the specified capability (or base FR primary operation)
 * in the active organization, satisfies role/organizationType compatibility, and meets
 * role MFA enrollment and action-level aal2 session assurance requirements.
 */
export function assertCapability(
  session: AuthSessionContext,
  capabilityInput: CapabilityInput,
): void {
  assertTrustedAuthSession(session);

  const resolvedId = resolveCapabilityId(capabilityInput);
  if (!resolvedId) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      `Unknown or unauthorized capability: ${String(capabilityInput)}.`,
    );
  }

  if (
    !isRoleAllowedInOrganizationType(
      session.role,
      session.activeOrganizationType,
    )
  ) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      `Role ${session.role} is not permitted in organization type ${session.activeOrganizationType}.`,
    );
  }

  const descriptor = CAPABILITY_METADATA[resolvedId];
  if (
    !descriptor.allowedOrganizationTypes.includes(
      session.activeOrganizationType,
    )
  ) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      `Capability ${resolvedId} is not permitted in organization type ${session.activeOrganizationType}.`,
    );
  }

  // Verify role grant before assurance checks so unauthorized roles receive CAPABILITY_FORBIDDEN.
  if (
    !CAPABILITY_METADATA[resolvedId] ||
    !roleRequiresOrAllowsCapability(session.role, resolvedId)
  ) {
    throw new AuthError(
      'CAPABILITY_FORBIDDEN',
      `Role ${session.role} does not hold capability ${resolvedId}.`,
    );
  }

  if (roleRequiresMfaEnrollment(session.role) && !session.mfaEnrolled) {
    throw new AuthError(
      'MFA_ENROLLMENT_REQUIRED',
      `Role ${session.role} requires active MFA enrollment.`,
    );
  }

  if (descriptor.requiresAal2 && session.aal !== 'aal2') {
    throw new AuthError(
      'MFA_AAL2_REQUIRED',
      `Capability ${resolvedId} requires an MFA-verified aal2 session.`,
    );
  }
}

function roleRequiresOrAllowsCapability(
  role: UserRole,
  capabilityId: CapabilityId,
): boolean {
  const grants = ROLE_CAPABILITY_MATRIX[role];
  return Boolean(grants && grants.has(capabilityId));
}

export function assertSessionAssurance(
  session: AuthSessionContext,
  requiredAal: AssuranceLevel,
): void {
  assertTrustedAuthSession(session);
  if (requiredAal === 'aal2' && session.aal !== 'aal2') {
    throw new AuthError(
      'MFA_AAL2_REQUIRED',
      'This operation requires an MFA-verified aal2 session.',
    );
  }
}

/**
 * Enforces FR-DEAL-02 1-Tap CFO Override authority exclusively for ARCHITECT_CFO
 * within an active SALVAGE_AND_EXPORT workspace with MFA enrollment and aal2 session assurance.
 */
export function assertCfoOverrideAuthority(session: AuthSessionContext): void {
  assertCapability(session, 'FR-DEAL-02:execute');
}

/**
 * Verifies that a domain record's organizationId strictly matches the session's
 * activeOrganizationId before performing reads or mutations.
 */
export function assertTenantScope(
  session: AuthSessionContext,
  recordOrganizationId: string,
): void {
  assertTrustedAuthSession(session);
  const normalizedRecordOrgId = assertValidUuid(
    recordOrganizationId,
    'recordOrganizationId',
    'INVALID_AUTH_INPUT',
  );
  if (normalizedRecordOrgId !== session.activeOrganizationId.toLowerCase()) {
    throw new AuthError(
      'TENANT_SCOPE_MISMATCH',
      'Target record does not belong to the active organization workspace.',
    );
  }
}
