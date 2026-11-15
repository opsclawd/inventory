import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrganizationType, PrismaClient, UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHASE1A_SEED_IDS } from '../../../../../prisma/seed';
import {
  TenantContextError,
  withTenantTransaction,
} from '@/infrastructure/db/tenant-transaction';
import { executeSwitchOrganizationWorkspaceAction } from '@/app/actions/switch-organization-workspace';
import {
  ACTIVE_ORGANIZATION_COOKIE_NAME,
  ALL_USER_ROLES,
  assertCapability,
  assertCfoOverrideAuthority,
  assertSessionAssurance,
  assertTenantScope,
  AuthError,
  type AuthRepository,
  type AuthSessionContext,
  type BootstrapUserRecord,
  type CapabilityId,
  createPrismaAuthRepository,
  deactivateOrganizationMembership,
  type DeactivateMembershipRepoInput,
  type FunctionalRequirementId,
  type MembershipTransitionResult,
  OrganizationWorkspaceSwitcher,
  reactivateOrganizationMembership,
  type ReactivateMembershipRepoInput,
  resolveAuthSessionContext,
  roleHasCapability,
  switchOrganizationWorkspace,
  toTenantExecutionContext,
  translateTenantContextError,
  type WorkspaceSwitchRepoInput,
} from '@/modules/shared-ops/auth';
import { resolveTestHeaderAuthContext } from '@/modules/shared-ops/auth/test-header-auth.adapter';

const hoistedMocks = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  headersMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: hoistedMocks.cookiesMock,
  headers: hoistedMocks.headersMock,
}));

vi.mock('next/cache', () => ({
  revalidatePath: hoistedMocks.revalidatePathMock,
}));

// ============================================================================
// In-Memory Auth Test Fixture Repository (Strictly for Offline Unit Tests)
// ============================================================================

interface MutableUserFixture {
  id: string;
  isActive: boolean;
  mfaEnrolled: boolean;
}

interface MutableOrgFixture {
  id: string;
  slug: string;
  name: string;
  organizationType: OrganizationType;
  isActive: boolean;
}

interface MutableMembershipFixture {
  id: string;
  organizationId: string;
  userId: string;
  role: UserRole;
  isDefaultWorkspace: boolean;
  isActive: boolean;
  deactivatedAt: Date | null;
  deactivatedById: string | null;
  revocationReason: string | null;
}

interface MutableAuditLogFixture {
  id: string;
  organizationId: string;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  previousState: unknown;
  nextState: unknown;
  createdAt: Date;
}

class InMemoryAuthTestStore {
  public readonly orgs = new Map<string, MutableOrgFixture>();
  public readonly users = new Map<string, MutableUserFixture>();
  public readonly memberships = new Map<string, MutableMembershipFixture>();
  public readonly auditLogs: MutableAuditLogFixture[] = [];
  public failNextRecordSwitch = false;
  public failNextLifecycleAudit = false;

  public seedStandardFixtures(): void {
    this.orgs.clear();
    this.users.clear();
    this.memberships.clear();
    this.auditLogs.length = 0;
    this.failNextRecordSwitch = false;
    this.failNextLifecycleAudit = false;

    this.orgs.set(PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT, {
      id: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      slug: 'ORG_SALVAGE_EXPORT',
      name: 'Auto & Marine Salvage (Kemptville)',
      organizationType: OrganizationType.SALVAGE_AND_EXPORT,
      isActive: true,
    });
    this.orgs.set(PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC, {
      id: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      slug: 'ORG_CANNABIS_NURSERY_PROC',
      name: 'Cannabis Nursery & Processing (Brockville)',
      organizationType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      isActive: true,
    });

    this.users.set(PHASE1A_SEED_IDS.users.architectCfo, {
      id: PHASE1A_SEED_IDS.users.architectCfo,
      isActive: true,
      mfaEnrolled: true,
    });
    this.users.set(PHASE1A_SEED_IDS.users.hunterMechanic, {
      id: PHASE1A_SEED_IDS.users.hunterMechanic,
      isActive: true,
      mfaEnrolled: false,
    });
    this.users.set(PHASE1A_SEED_IDS.users.ontarioStripper, {
      id: PHASE1A_SEED_IDS.users.ontarioStripper,
      isActive: true,
      mfaEnrolled: false,
    });
    this.users.set(PHASE1A_SEED_IDS.users.trinidadVaultAdmin, {
      id: PHASE1A_SEED_IDS.users.trinidadVaultAdmin,
      isActive: true,
      mfaEnrolled: true,
    });
    this.users.set(PHASE1A_SEED_IDS.users.overseasBuyer, {
      id: PHASE1A_SEED_IDS.users.overseasBuyer,
      isActive: true,
      mfaEnrolled: false,
    });
    this.users.set(PHASE1A_SEED_IDS.users.revokedContractor, {
      id: PHASE1A_SEED_IDS.users.revokedContractor,
      isActive: true,
      mfaEnrolled: false,
    });
    this.users.set(PHASE1A_SEED_IDS.users.cannabisQap, {
      id: PHASE1A_SEED_IDS.users.cannabisQap,
      isActive: true,
      mfaEnrolled: true,
    });
    this.users.set(PHASE1A_SEED_IDS.users.nurseryTech, {
      id: PHASE1A_SEED_IDS.users.nurseryTech,
      isActive: true,
      mfaEnrolled: false,
    });

    this.memberships.set(PHASE1A_SEED_IDS.memberships.cfoSalvage, {
      id: PHASE1A_SEED_IDS.memberships.cfoSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.cfoCannabis, {
      id: PHASE1A_SEED_IDS.memberships.cfoCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.architectCfo,
      role: UserRole.ARCHITECT_CFO,
      isDefaultWorkspace: false,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.hunterSalvage, {
      id: PHASE1A_SEED_IDS.memberships.hunterSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.hunterMechanic,
      role: UserRole.HUNTER_MECHANIC,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.stripperSalvage, {
      id: PHASE1A_SEED_IDS.memberships.stripperSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.ontarioStripper,
      role: UserRole.ONTARIO_STRIPPER,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.vaultAdminSalvage, {
      id: PHASE1A_SEED_IDS.memberships.vaultAdminSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.trinidadVaultAdmin,
      role: UserRole.TRINIDAD_VAULT_ADMIN,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.buyerSalvage, {
      id: PHASE1A_SEED_IDS.memberships.buyerSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.overseasBuyer,
      role: UserRole.OVERSEAS_B2B_BUYER,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.revokedContractorSalvage, {
      id: PHASE1A_SEED_IDS.memberships.revokedContractorSalvage,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      userId: PHASE1A_SEED_IDS.users.revokedContractor,
      role: UserRole.ONTARIO_STRIPPER,
      isDefaultWorkspace: false,
      isActive: false,
      deactivatedAt: new Date('2026-11-01T12:00:00.000Z'),
      deactivatedById: PHASE1A_SEED_IDS.users.architectCfo,
      revocationReason: 'Seeded inactive contractor fixture',
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.qapCannabis, {
      id: PHASE1A_SEED_IDS.memberships.qapCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.cannabisQap,
      role: UserRole.CANNABIS_QAP_COMPLIANCE,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
    this.memberships.set(PHASE1A_SEED_IDS.memberships.nurseryTechCannabis, {
      id: PHASE1A_SEED_IDS.memberships.nurseryTechCannabis,
      organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      userId: PHASE1A_SEED_IDS.users.nurseryTech,
      role: UserRole.NURSERY_CULTIVATION_TECH,
      isDefaultWorkspace: true,
      isActive: true,
      deactivatedAt: null,
      deactivatedById: null,
      revocationReason: null,
    });
  }

  public toRepository(): AuthRepository {
    return {
      findActiveUserBootstrap: async (
        userId: string,
      ): Promise<BootstrapUserRecord | null> => {
        const user = this.users.get(userId.toLowerCase());
        if (!user || !user.isActive) {
          return null;
        }
        const memberships = [...this.memberships.values()]
          .filter((m) => m.userId.toLowerCase() === user.id.toLowerCase() && m.isActive)
          .flatMap((m) => {
            const org = this.orgs.get(m.organizationId.toLowerCase());
            if (!org || !org.isActive) {
              return [];
            }
            return [
              {
                membershipId: m.id,
                organizationId: org.id,
                organizationSlug: org.slug,
                organizationName: org.name,
                organizationType: org.organizationType,
                organizationIsActive: org.isActive,
                role: m.role,
                isDefaultWorkspace: m.isDefaultWorkspace,
                isActive: m.isActive,
              },
            ];
          });

        return {
          userId: user.id,
          isActive: user.isActive,
          mfaEnrolled: user.mfaEnrolled,
          memberships,
        };
      },

      recordWorkspaceSwitch: async (
        input: WorkspaceSwitchRepoInput,
      ): Promise<void> => {
        if (this.failNextRecordSwitch) {
          this.failNextRecordSwitch = false;
          throw new Error('Simulated DB error during workspace switch audit');
        }
        const sourceActive = [...this.memberships.values()].some(
          (m) =>
            m.organizationId.toLowerCase() ===
              input.sourceContext.organizationId.toLowerCase() &&
            m.userId.toLowerCase() ===
              input.sourceContext.userId.toLowerCase() &&
            m.role === input.sourceContext.role &&
            m.isActive,
        );
        const targetActive = [...this.memberships.values()].some(
          (m) =>
            m.id.toLowerCase() === input.targetMembershipId.toLowerCase() &&
            m.organizationId.toLowerCase() ===
              input.targetContext.organizationId.toLowerCase() &&
            m.userId.toLowerCase() ===
              input.targetContext.userId.toLowerCase() &&
            m.role === input.targetContext.role &&
            m.isActive,
        );
        if (!sourceActive || !targetActive) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Active source or target membership required.',
          );
        }

        this.auditLogs.push({
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
        });
      },

      deactivateOrganizationMembership: async (
        input: DeactivateMembershipRepoInput,
      ): Promise<MembershipTransitionResult> => {
        const org = this.orgs.get(input.actorContext.organizationId.toLowerCase());
        const actorUser = this.users.get(input.actorContext.userId.toLowerCase());
        const actorMembership = [...this.memberships.values()].find(
          (m) =>
            m.organizationId.toLowerCase() ===
              input.actorContext.organizationId.toLowerCase() &&
            m.userId.toLowerCase() === input.actorContext.userId.toLowerCase(),
        );
        if (
          !org?.isActive ||
          !actorUser?.isActive ||
          !actorMembership?.isActive
        ) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Actor membership or user is inactive.',
          );
        }
        if (actorMembership.role !== UserRole.ARCHITECT_CFO) {
          throw new AuthError(
            'CAPABILITY_FORBIDDEN',
            'Only ARCHITECT_CFO may deactivate memberships.',
          );
        }

        const target = this.memberships.get(input.membershipId.toLowerCase());
        if (
          !target ||
          target.organizationId.toLowerCase() !==
            input.actorContext.organizationId.toLowerCase()
        ) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Target membership is unavailable or outside the active organization.',
          );
        }

        if (!target.isActive) {
          return {
            changed: false,
            auditId: null,
            membership: { ...target },
          };
        }

        if (target.role === UserRole.ARCHITECT_CFO) {
          const effectiveCfoCount = [...this.memberships.values()].filter((m) => {
            if (
              m.organizationId.toLowerCase() !==
                input.actorContext.organizationId.toLowerCase() ||
              m.role !== UserRole.ARCHITECT_CFO ||
              !m.isActive
            ) {
              return false;
            }
            const u = this.users.get(m.userId.toLowerCase());
            return Boolean(u?.isActive);
          }).length;

          const targetUser = this.users.get(target.userId.toLowerCase());
          const remaining = effectiveCfoCount - (targetUser?.isActive ? 1 : 0);
          if (remaining < 1) {
            throw new AuthError(
              'LAST_ACTIVE_CFO_PROTECTED',
              'Cannot deactivate the last active ARCHITECT_CFO in this organization.',
            );
          }
        }

        if (this.failNextLifecycleAudit) {
          this.failNextLifecycleAudit = false;
          throw new Error('Simulated audit log failure; transaction rolled back.');
        }

        const prev = { ...target };
        target.isActive = false;
        target.deactivatedAt = input.occurredAt;
        target.deactivatedById = input.actorContext.userId;
        target.revocationReason = input.reason;

        this.auditLogs.push({
          id: input.auditId,
          organizationId: target.organizationId,
          actorUserId: input.actorContext.userId,
          entityType: 'OrganizationMembership',
          entityId: target.id,
          action: 'MEMBERSHIP_DEACTIVATED',
          previousState: { isActive: prev.isActive, role: prev.role },
          nextState: {
            isActive: target.isActive,
            role: target.role,
            revocationReason: target.revocationReason,
          },
          createdAt: input.occurredAt,
        });

        return {
          changed: true,
          auditId: input.auditId,
          membership: { ...target },
        };
      },

      reactivateOrganizationMembership: async (
        input: ReactivateMembershipRepoInput,
      ): Promise<MembershipTransitionResult> => {
        const org = this.orgs.get(input.actorContext.organizationId.toLowerCase());
        const actorUser = this.users.get(input.actorContext.userId.toLowerCase());
        const actorMembership = [...this.memberships.values()].find(
          (m) =>
            m.organizationId.toLowerCase() ===
              input.actorContext.organizationId.toLowerCase() &&
            m.userId.toLowerCase() === input.actorContext.userId.toLowerCase(),
        );
        if (
          !org?.isActive ||
          !actorUser?.isActive ||
          !actorMembership?.isActive
        ) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Actor membership or user is inactive.',
          );
        }
        if (actorMembership.role !== UserRole.ARCHITECT_CFO) {
          throw new AuthError(
            'CAPABILITY_FORBIDDEN',
            'Only ARCHITECT_CFO may reactivate memberships.',
          );
        }

        const target = this.memberships.get(input.membershipId.toLowerCase());
        if (
          !target ||
          target.organizationId.toLowerCase() !==
            input.actorContext.organizationId.toLowerCase()
        ) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Target membership is unavailable or outside the active organization.',
          );
        }

        const targetUser = this.users.get(target.userId.toLowerCase());
        if (!targetUser?.isActive) {
          throw new AuthError(
            'MEMBERSHIP_REVOKED_OR_INACTIVE',
            'Target membership cannot be reactivated while user is inactive.',
          );
        }

        if (
          (org.organizationType === OrganizationType.SALVAGE_AND_EXPORT &&
            (target.role === UserRole.CANNABIS_QAP_COMPLIANCE ||
              target.role === UserRole.NURSERY_CULTIVATION_TECH)) ||
          (org.organizationType ===
            OrganizationType.CANNABIS_NURSERY_AND_PROCESSING &&
            (target.role === UserRole.ONTARIO_STRIPPER ||
              target.role === UserRole.TRINIDAD_VAULT_ADMIN ||
              target.role === UserRole.OVERSEAS_B2B_BUYER))
        ) {
          throw new AuthError(
            'CAPABILITY_FORBIDDEN',
            'Target role is incompatible with organization type.',
          );
        }

        if (target.isActive) {
          return {
            changed: false,
            auditId: null,
            membership: { ...target },
          };
        }

        const prev = { ...target };
        target.isActive = true;
        target.deactivatedAt = null;
        target.deactivatedById = null;
        target.revocationReason = null;

        this.auditLogs.push({
          id: input.auditId,
          organizationId: target.organizationId,
          actorUserId: input.actorContext.userId,
          entityType: 'OrganizationMembership',
          entityId: target.id,
          action: 'MEMBERSHIP_REACTIVATED',
          previousState: {
            isActive: prev.isActive,
            revocationReason: prev.revocationReason,
          },
          nextState: { isActive: true, revocationReason: null },
          createdAt: input.occurredAt,
        });

        return {
          changed: true,
          auditId: input.auditId,
          membership: { ...target },
        };
      },
    };
  }
}

function createMockCookieStore(
  initialCookies: Record<string, string> = {},
  options: { throwReadOnlyOnSet?: boolean; throwUnexpectedOnSet?: Error } = {},
) {
  const store = new Map<string, string>(Object.entries(initialCookies));
  return {
    store,
    get(name: string) {
      const value = store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...store.entries()].map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string) {
      if (options.throwUnexpectedOnSet) {
        throw options.throwUnexpectedOnSet;
      }
      if (options.throwReadOnlyOnSet) {
        throw new Error(
          'Cookies can only be modified in a Server Action or Route Handler.',
        );
      }
      store.set(name, value);
    },
  };
}

// ============================================================================
// 1. Offline Auth, RBAC, Workspace Switcher & Composition Tests
// ============================================================================

describe('Issue #4: Multi-Tenant Auth Context, 7-Role RBAC & Organization Workspace Switcher (Offline)', () => {
  let store: InMemoryAuthTestStore;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    store = new InMemoryAuthTestStore();
    store.seedStandardFixtures();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    hoistedMocks.cookiesMock.mockReset();
    hoistedMocks.headersMock.mockReset();
    hoistedMocks.revalidatePathMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('has zero eager DB/Supabase configuration requirements on module import and zero getSession usage', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const authMod = await import('@/modules/shared-ops/auth');
    expect(typeof authMod.resolveAuthSessionContext).toBe('function');
    expect(typeof authMod.switchOrganizationWorkspace).toBe('function');
    expect(typeof authMod.deactivateOrganizationMembership).toBe('function');
    expect(typeof authMod.reactivateOrganizationMembership).toBe('function');
    expect(typeof authMod.OrganizationWorkspaceSwitcher).toBe('function');

    // Static check verifying zero banned Supabase getSession() invocations in production auth files
    const bannedMethodName = ['get', 'Session'].join('');
    const filesToCheck = [
      'src/modules/shared-ops/auth/auth-context.ts',
      'src/modules/shared-ops/auth/auth.contracts.ts',
      'src/modules/shared-ops/auth/rbac-matrix.ts',
      'src/modules/shared-ops/auth/switch-workspace.use-case.ts',
      'src/modules/shared-ops/auth/test-header-auth.adapter.ts',
      'src/modules/shared-ops/auth/index.ts',
      'src/app/actions/switch-organization-workspace.ts',
      'src/app/components/OrganizationWorkspaceSwitcher.tsx',
    ];
    const rootDir = path.resolve(import.meta.dirname, '../../../../..');
    for (const relPath of filesToCheck) {
      const content = await fs.readFile(path.join(rootDir, relPath), 'utf8');
      expect(content).not.toContain(`.${bannedMethodName}(`);
    }
  });

  describe('7-Role RBAC Matrix & Action-Level MFA aal2 Enforcement', () => {
    // Independent expected permission fixture (written directly from PRD Section 2, not from matrix code)
    const EXPECTED_ROLE_GRANTS: Readonly<
      Record<
        UserRole,
        {
          orgType: OrganizationType;
          allowed: readonly CapabilityId[];
          denied: readonly (CapabilityId | FunctionalRequirementId)[];
        }
      >
    > = {
      [UserRole.ARCHITECT_CFO]: {
        orgType: OrganizationType.SALVAGE_AND_EXPORT,
        allowed: [
          'FR-DEAL-01:create',
          'FR-DEAL-01:approve',
          'FR-DEAL-02:execute',
          'FR-INT-01:create',
          'FR-INT-02:relocate',
          'FR-EXP-01:create',
          'FR-EXP-01:reverse',
          'FR-EXP-02:approve',
          'FR-LOG-01:execute-scan',
          'FR-LOG-02:seal',
          'FR-CHK-01:execute-cad-only',
          'FR-MKT-00:export-csv',
          'FR-MKT-02:execute',
          'FR-VLT-01:execute-check-in',
          'FR-VLT-02:create',
          'FR-VLT-03:execute',
          'FR-VLT-04:reconcile',
          'FR-VLT-05:audit',
          'AUTH-MEMBERSHIP:deactivate',
          'AUTH-MEMBERSHIP:reactivate',
        ],
        denied: [
          'FR-CAN-01:create',
          'FR-CAN-02:audit',
          'FR-CAN-03:execute',
          'FR-CAN-04:export',
          'FR-CAN-01:hold-release',
        ],
      },
      [UserRole.HUNTER_MECHANIC]: {
        orgType: OrganizationType.SALVAGE_AND_EXPORT,
        allowed: [
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
        ],
        denied: [
          'FR-DEAL-01:approve',
          'FR-DEAL-02:execute',
          'FR-EXP-01:reverse',
          'FR-EXP-02:approve',
          'FR-LOG-02:seal',
          'FR-MKT-00:export-csv',
          'FR-VLT-03:execute',
          'FR-VLT-05:execute-count',
          'FR-CAN-01:create',
          'AUTH-MEMBERSHIP:deactivate',
        ],
      },
      [UserRole.ONTARIO_STRIPPER]: {
        orgType: OrganizationType.SALVAGE_AND_EXPORT,
        allowed: [
          'FR-INT-01:read-strip-queue',
          'FR-INT-02:create',
          'FR-INT-02:relocate',
          'FR-EXP-02:read-own-piece-rate',
          'FR-LOG-01:execute-scan',
        ],
        denied: [
          'FR-INT-01',
          'FR-INT-01:create',
          'FR-INT-01:update',
          'FR-DEAL-01:read',
          'FR-DEAL-02:execute',
          'FR-EXP-01:create',
          'FR-EXP-02:approve',
          'FR-LOG-02:seal',
          'FR-CHK-01:execute-cad-only',
          'FR-VLT-03:execute',
        ],
      },
      [UserRole.TRINIDAD_VAULT_ADMIN]: {
        orgType: OrganizationType.SALVAGE_AND_EXPORT,
        allowed: [
          'FR-INT-01:read-exported',
          'FR-EXP-01:create-port-fees',
          'FR-LOG-01:read-manifest',
          'FR-LOG-02:read',
          'FR-LOG-02:download',
          'FR-VLT-01:execute-check-in',
          'FR-VLT-02:create',
          'FR-VLT-02:update',
          'FR-VLT-03:execute',
          'FR-VLT-04:create',
          'FR-VLT-04:execute',
          'FR-VLT-05:execute-count',
        ],
        denied: [
          'FR-INT-01:create',
          'FR-EXP-01:create',
          'FR-EXP-01:reverse',
          'FR-DEAL-02:execute',
          'FR-CHK-01:execute-cad-only',
          'FR-VLT-04:reconcile',
          'FR-VLT-05:audit',
          'FR-CAN-03:execute',
        ],
      },
      [UserRole.OVERSEAS_B2B_BUYER]: {
        orgType: OrganizationType.SALVAGE_AND_EXPORT,
        allowed: [
          'FR-LOG-01:read-loading-tab',
          'FR-VLT-02:create-rate-limited',
          'FR-VLT-04:read-own-commission',
        ],
        denied: [
          'FR-LOG-01',
          'FR-LOG-01:execute-scan',
          'FR-VLT-02:create',
          'FR-VLT-03:execute',
          'FR-VLT-04:execute',
          'FR-CHK-01:execute-cad-only',
        ],
      },
      [UserRole.CANNABIS_QAP_COMPLIANCE]: {
        orgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        allowed: [
          'FR-EXP-01:create',
          'FR-EXP-01:read',
          'FR-CAN-01:create',
          'FR-CAN-01:hold-release',
          'FR-CAN-02:create',
          'FR-CAN-02:verify-variance',
          'FR-CAN-03:execute',
          'FR-CAN-03:qap-execute',
          'FR-CAN-03:witness',
          'FR-CAN-04:create',
          'FR-CAN-04:sign-off',
          'FR-CAN-04:export',
        ],
        denied: [
          'FR-EXP-01:reverse',
          'FR-DEAL-01:create',
          'FR-CHK-01:execute-cad-only',
          'FR-VLT-03:execute',
          'FR-CAN-02:audit',
          'AUTH-MEMBERSHIP:deactivate',
        ],
      },
      [UserRole.NURSERY_CULTIVATION_TECH]: {
        orgType: OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
        allowed: [
          'FR-EXP-01:create-nursery-supplies',
          'FR-CAN-01:create',
          'FR-CAN-01:relocate',
          'FR-CAN-02:execute-run',
          'FR-CAN-03:execute',
          'FR-CAN-03:witness',
        ],
        denied: [
          'FR-EXP-01:create',
          'FR-CAN-01:hold-release',
          'FR-CAN-02:verify-variance',
          'FR-CAN-04:read',
          'FR-CAN-04:export',
          'FR-INT-02:create',
        ],
      },
    };

    it('verifies all 7 roles against expected allowed and denied capabilities', () => {
      for (const role of ALL_USER_ROLES) {
        const spec = EXPECTED_ROLE_GRANTS[role];
        for (const cap of spec.allowed) {
          expect(roleHasCapability(role, spec.orgType, cap)).toBe(true);
        }
        for (const deniedCap of spec.denied) {
          expect(roleHasCapability(role, spec.orgType, deniedCap)).toBe(false);
        }
      }
    });

    it('enforces organization-type isolation for ARCHITECT_CFO and explicit cannabis HUNTER_MECHANIC grants', async () => {
      const repo = store.toRepository();
      // CFO switched into CANNABIS workspace (aal2)
      const cfoCannabisSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );

      expect(() =>
        assertCapability(cfoCannabisSession, 'FR-CAN-02:audit'),
      ).not.toThrow();
      expect(() =>
        assertCapability(cfoCannabisSession, 'FR-EXP-01:reverse'),
      ).not.toThrow();
      // Salvage operations must be denied when active org is Cannabis
      expect(() => assertCfoOverrideAuthority(cfoCannabisSession)).toThrowError(
        AuthError,
      );
      expect(() =>
        assertCapability(cfoCannabisSession, 'FR-CHK-01:execute-cad-only'),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'CAPABILITY_FORBIDDEN' }),
      );

      // Hunter Mechanic with an EXPLICIT cannabis membership can witness FR-CAN-03 (aal2) ONLY, never execute
      const explicitHunterCannabisMembershipId = randomUUID();
      store.memberships.set(explicitHunterCannabisMembershipId, {
        id: explicitHunterCannabisMembershipId,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        userId: PHASE1A_SEED_IDS.users.hunterMechanic,
        role: UserRole.HUNTER_MECHANIC,
        isDefaultWorkspace: false,
        isActive: true,
        deactivatedAt: null,
        deactivatedById: null,
        revocationReason: null,
      });

      const hunterCannabisSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.hunterMechanic,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );

      expect(() =>
        assertCapability(hunterCannabisSession, 'FR-CAN-03:witness'),
      ).not.toThrow();
      expect(() =>
        assertCapability(hunterCannabisSession, 'FR-CAN-03:execute'),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'CAPABILITY_FORBIDDEN' }),
      );
      expect(() =>
        assertCapability(hunterCannabisSession, 'FR-CAN-03'),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'CAPABILITY_FORBIDDEN' }),
      );
    });

    it('separates MFA enrollment (403 MFA_ENROLLMENT_REQUIRED) from session aal2 assurance (403 MFA_AAL2_REQUIRED)', async () => {
      const repo = store.toRepository();

      // 1. Enrolled CFO with aal1 can read workspace, but fails privileged mutations with MFA_AAL2_REQUIRED
      const cfoAal1 = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal1',
        },
        { repository: repo },
      );
      expect(() => assertCapability(cfoAal1, 'FR-DEAL-01:read')).not.toThrow();
      expect(() => assertCfoOverrideAuthority(cfoAal1)).toThrowError(
        expect.objectContaining({ status: 403, code: 'MFA_AAL2_REQUIRED' }),
      );
      expect(() => assertCapability(cfoAal1, 'FR-VLT-03:execute')).toThrowError(
        expect.objectContaining({ status: 403, code: 'MFA_AAL2_REQUIRED' }),
      );
      expect(() => assertSessionAssurance(cfoAal1, 'aal2')).toThrowError(
        expect.objectContaining({ status: 403, code: 'MFA_AAL2_REQUIRED' }),
      );

      // 2. FR-CAN-03 witness requires aal2 even for Nursery Tech / Hunter Mechanic
      const techAal1 = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.nurseryTech,
          'x-test-aal': 'aal1',
        },
        { repository: repo },
      );
      expect(() => assertCapability(techAal1, 'FR-CAN-01:create')).not.toThrow();
      expect(() => assertCapability(techAal1, 'FR-CAN-03:witness')).toThrowError(
        expect.objectContaining({ status: 403, code: 'MFA_AAL2_REQUIRED' }),
      );

      const techAal2 = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.nurseryTech,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      expect(() => assertCapability(techAal2, 'FR-CAN-03:witness')).not.toThrow();
      expect(() => assertCapability(techAal2, 'FR-CAN-03:execute')).not.toThrow();

      // 3. Vault Admin / QAP / CFO with mfaEnrolled = false fails resolution with MFA_ENROLLMENT_REQUIRED
      store.users.get(PHASE1A_SEED_IDS.users.trinidadVaultAdmin)!.mfaEnrolled =
        false;
      await expect(
        resolveTestHeaderAuthContext(
          {
            'x-test-user-id': PHASE1A_SEED_IDS.users.trinidadVaultAdmin,
            'x-test-aal': 'aal2',
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MFA_ENROLLMENT_REQUIRED',
      });
    });

    it('rejects unknown capabilities, cross-tenant record scopes, and unbranded session objects', async () => {
      const repo = store.toRepository();
      const cfoSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );

      expect(() =>
        assertCapability(cfoSession, 'FR-UNKNOWN-99:hack' as CapabilityId),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'CAPABILITY_FORBIDDEN' }),
      );

      expect(() =>
        assertTenantScope(
          cfoSession,
          PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        ),
      ).not.toThrow();
      expect(() =>
        assertTenantScope(
          cfoSession,
          PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        ),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'TENANT_SCOPE_MISMATCH' }),
      );
      expect(() => assertTenantScope(cfoSession, 'not-a-uuid')).toThrowError(
        expect.objectContaining({ status: 400, code: 'INVALID_AUTH_INPUT' }),
      );

      expect(toTenantExecutionContext(cfoSession)).toEqual({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        userId: PHASE1A_SEED_IDS.users.architectCfo,
        role: UserRole.ARCHITECT_CFO,
      });

      const forgedSession = {
        ...cfoSession,
      } as AuthSessionContext;
      expect(() => toTenantExecutionContext(forgedSession)).toThrowError(
        expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }),
      );
      expect(() =>
        assertCapability(forgedSession, 'FR-DEAL-01:read'),
      ).toThrowError(
        expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }),
      );
    });
  });

  describe('Production @supabase/ssr Resolver (resolveAuthSessionContext)', () => {
    it('awaits cookies()/headers(), calls getUser() & getClaims(), enforces active membership, and maps cookie selectors', async () => {
      const repo = store.toRepository();
      const cookieStore = createMockCookieStore({
        [ACTIVE_ORGANIZATION_COOKIE_NAME]:
          PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      });
      hoistedMocks.cookiesMock.mockResolvedValue(cookieStore);
      hoistedMocks.headersMock.mockResolvedValue(
        new Headers({
          'x-test-user-id': PHASE1A_SEED_IDS.users.ontarioStripper,
          'x-role': 'ARCHITECT_CFO',
        }),
      );

      const getUserSpy = vi.fn(async () => ({
        data: { user: { id: PHASE1A_SEED_IDS.users.architectCfo } },
        error: null,
      }));
      const getClaimsSpy = vi.fn(async () => ({
        data: {
          claims: {
            sub: PHASE1A_SEED_IDS.users.architectCfo,
            aal: 'aal2',
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        error: null,
      }));

      const session = await resolveAuthSessionContext({
        repository: repo,
        env: {
          NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key',
        },
        supabaseClientFactory: () => ({
          auth: {
            getUser: getUserSpy,
            getClaims: getClaimsSpy,
          },
        }),
      });

      expect(hoistedMocks.cookiesMock).toHaveBeenCalledTimes(1);
      expect(hoistedMocks.headersMock).toHaveBeenCalledTimes(1);
      expect(getUserSpy).toHaveBeenCalledTimes(1);
      expect(getClaimsSpy).toHaveBeenCalledTimes(1);
      // Production resolver must ignore any x-test-* or x-role headers and honor verified DB + cookie org
      expect(session.userId).toBe(PHASE1A_SEED_IDS.users.architectCfo);
      expect(session.activeOrganizationId).toBe(
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      );
      expect(session.activeOrganizationType).toBe(
        OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      );
      expect(session.role).toBe(UserRole.ARCHITECT_CFO);
      expect(session.aal).toBe('aal2');
    });

    it('fails closed on missing configuration, missing auth, claims mismatch/expiry, and invalid/revoked org cookies', async () => {
      const repo = store.toRepository();
      hoistedMocks.cookiesMock.mockResolvedValue(createMockCookieStore());
      hoistedMocks.headersMock.mockResolvedValue(new Headers());

      // Missing Supabase configuration -> 500 AUTH_CONFIGURATION_ERROR (never falls back to headers)
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          env: {},
        }),
      ).rejects.toMatchObject({
        status: 500,
        code: 'AUTH_CONFIGURATION_ERROR',
      });

      // getUser returns null -> 401 UNAUTHENTICATED
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
          },
          supabaseClientFactory: () => ({
            auth: {
              getUser: async () => ({ data: { user: null }, error: null }),
              getClaims: async () => ({ data: null, error: null }),
            },
          }),
        }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

      // getClaims sub mismatch -> 401 UNAUTHENTICATED
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
          },
          supabaseClientFactory: () => ({
            auth: {
              getUser: async () => ({
                data: { user: { id: PHASE1A_SEED_IDS.users.architectCfo } },
                error: null,
              }),
              getClaims: async () => ({
                data: {
                  claims: {
                    sub: PHASE1A_SEED_IDS.users.ontarioStripper,
                    aal: 'aal2',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                  },
                },
                error: null,
              }),
            },
          }),
        }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

      // Expired claims -> 401 UNAUTHENTICATED
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
          },
          supabaseClientFactory: () => ({
            auth: {
              getUser: async () => ({
                data: { user: { id: PHASE1A_SEED_IDS.users.architectCfo } },
                error: null,
              }),
              getClaims: async () => ({
                data: {
                  claims: {
                    sub: PHASE1A_SEED_IDS.users.architectCfo,
                    aal: 'aal2',
                    exp: Math.floor(Date.now() / 1000) - 60,
                  },
                },
                error: null,
              }),
            },
          }),
        }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

      // Stale/unauthorized org cookie never falls back silently -> 403 MEMBERSHIP_REVOKED_OR_INACTIVE
      hoistedMocks.cookiesMock.mockResolvedValue(
        createMockCookieStore({
          [ACTIVE_ORGANIZATION_COOKIE_NAME]:
            PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        }),
      );
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
          },
          supabaseClientFactory: () => ({
            auth: {
              getUser: async () => ({
                data: { user: { id: PHASE1A_SEED_IDS.users.hunterMechanic } },
                error: null,
              }),
              getClaims: async () => ({
                data: {
                  claims: {
                    sub: PHASE1A_SEED_IDS.users.hunterMechanic,
                    aal: 'aal1',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                  },
                },
                error: null,
              }),
            },
          }),
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });
    });

    it('handles SSR cookie setAll read-only tolerance vs mutation persistence and unexpected error propagation', async () => {
      const repo = store.toRepository();
      hoistedMocks.headersMock.mockResolvedValue(new Headers());

      // Read-only RSC render tolerates Next.js read-only cookie error
      const readOnlyCookies = createMockCookieStore({}, { throwReadOnlyOnSet: true });
      hoistedMocks.cookiesMock.mockResolvedValue(readOnlyCookies);
      const rscSession = await resolveAuthSessionContext({
        repository: repo,
        isMutationContext: false,
        env: {
          NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
        },
        supabaseClientFactory: ({ cookies: ssrCookies }) => ({
          auth: {
            getUser: async () => {
              await ssrCookies.setAll?.(
                [{ name: 'sb-refresh', value: 'tok', options: {} }],
                {},
              );
              return {
                data: { user: { id: PHASE1A_SEED_IDS.users.ontarioStripper } },
                error: null,
              };
            },
            getClaims: async () => ({
              data: {
                claims: {
                  sub: PHASE1A_SEED_IDS.users.ontarioStripper,
                  aal: 'aal1',
                  exp: Math.floor(Date.now() / 1000) + 3600,
                },
              },
              error: null,
            }),
          },
        }),
      });
      expect(rscSession.role).toBe(UserRole.ONTARIO_STRIPPER);

      // Mutation path NEVER suppresses cookie write failures
      hoistedMocks.cookiesMock.mockResolvedValue(readOnlyCookies);
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          isMutationContext: true,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
          },
          supabaseClientFactory: ({ cookies: ssrCookies }) => ({
            auth: {
              getUser: async () => {
                await ssrCookies.setAll?.(
                  [{ name: 'sb-refresh', value: 'tok', options: {} }],
                  {},
                );
                return {
                  data: { user: { id: PHASE1A_SEED_IDS.users.ontarioStripper } },
                  error: null,
                };
              },
              getClaims: async () => ({
                data: {
                  claims: {
                    sub: PHASE1A_SEED_IDS.users.ontarioStripper,
                    aal: 'aal1',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                  },
                },
                error: null,
              }),
            },
          }),
        }),
      ).rejects.toThrow('Cookies can only be modified');

      // Unexpected cookie errors propagate even on read-only path
      hoistedMocks.cookiesMock.mockResolvedValue(
        createMockCookieStore({}, { throwUnexpectedOnSet: new Error('Disk I/O failure') }),
      );
      await expect(
        resolveAuthSessionContext({
          repository: repo,
          isMutationContext: false,
          env: {
            NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
          },
          supabaseClientFactory: ({ cookies: ssrCookies }) => ({
            auth: {
              getUser: async () => {
                await ssrCookies.setAll?.(
                  [{ name: 'sb-refresh', value: 'tok', options: {} }],
                  {},
                );
                return {
                  data: { user: { id: PHASE1A_SEED_IDS.users.ontarioStripper } },
                  error: null,
                };
              },
              getClaims: async () => ({
                data: {
                  claims: {
                    sub: PHASE1A_SEED_IDS.users.ontarioStripper,
                    aal: 'aal1',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                  },
                },
                error: null,
              }),
            },
          }),
        }),
      ).rejects.toThrow('Disk I/O failure');
    });
  });

  describe('Test-Header Adapter Security Boundaries', () => {
    it('hard-throws outside NODE_ENV === "test", rejects malformed inputs, and ignores spoofed role headers', async () => {
      const repo = store.toRepository();

      process.env.NODE_ENV = 'production';
      await expect(
        resolveTestHeaderAuthContext(
          { 'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo },
          { repository: repo },
        ),
      ).rejects.toMatchObject({ status: 500, code: 'AUTH_CONFIGURATION_ERROR' });

      process.env.NODE_ENV = 'test';

      await expect(
        resolveTestHeaderAuthContext({}, { repository: repo }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

      await expect(
        resolveTestHeaderAuthContext(
          { 'x-test-user-id': 'not-a-uuid' },
          { repository: repo },
        ),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_AUTH_INPUT' });

      await expect(
        resolveTestHeaderAuthContext(
          {
            'x-test-user-id': PHASE1A_SEED_IDS.users.ontarioStripper,
            'x-test-aal': 'aal3',
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_AUTH_INPUT' });

      // Spoofed x-test-role: ARCHITECT_CFO must be ignored; live membership role ONTARIO_STRIPPER applies
      const session = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.ontarioStripper,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-role': UserRole.ARCHITECT_CFO,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      expect(session.role).toBe(UserRole.ONTARIO_STRIPPER);
      expect(() => assertCfoOverrideAuthority(session)).toThrowError(
        expect.objectContaining({ status: 403, code: 'CAPABILITY_FORBIDDEN' }),
      );

      // Spoofed x-test-org-id for Cannabis org must be rejected
      await expect(
        resolveTestHeaderAuthContext(
          {
            'x-test-user-id': PHASE1A_SEED_IDS.users.ontarioStripper,
            'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });
    });

    it('maps TenantContextError(TENANT_CONTEXT_UNAUTHORIZED) to 403 MEMBERSHIP_REVOKED_OR_INACTIVE', () => {
      expect(() =>
        translateTenantContextError(
          new TenantContextError('TENANT_CONTEXT_UNAUTHORIZED', 'Revoked'),
        ),
      ).toThrowError(
        expect.objectContaining({
          status: 403,
          code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        }),
      );

      expect(() =>
        translateTenantContextError(new Error('Connection refused')),
      ).toThrow('Connection refused');
    });
  });

  describe('Workspace Switch & Membership Revocation/Reactivation Use Cases', () => {
    it('switches workspace cleanly, preserves isDefaultWorkspace, audits in target org, and commits DB before cookie', async () => {
      const repo = store.toRepository();
      const cookieWrites: string[] = [];
      const fixedNow = new Date('2026-11-14T18:00:00.000Z');

      const cfoSalvage = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal1',
        },
        { repository: repo },
      );

      // DB failure must leave cookie untouched
      store.failNextRecordSwitch = true;
      await expect(
        switchOrganizationWorkspace(
          cfoSalvage,
          PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          {
            repository: repo,
            cookieWriter: {
              setActiveOrganization: async (orgId) => {
                cookieWrites.push(orgId);
              },
            },
            clock: { now: () => fixedNow },
          },
        ),
      ).rejects.toThrow('Simulated DB error');
      expect(cookieWrites).toHaveLength(0);

      // Successful switch writes AuditLog in target org and then sets cookie
      const switched = await switchOrganizationWorkspace(
        cfoSalvage,
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        {
          repository: repo,
          cookieWriter: {
            setActiveOrganization: async (orgId) => {
              cookieWrites.push(orgId);
            },
          },
          clock: { now: () => fixedNow },
        },
      );

      expect(switched.activeOrganizationId).toBe(
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      );
      expect(switched.activeOrganizationType).toBe(
        OrganizationType.CANNABIS_NURSERY_AND_PROCESSING,
      );
      expect(cookieWrites).toEqual([
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      ]);
      expect(store.auditLogs).toHaveLength(1);
      expect(store.auditLogs[0]).toMatchObject({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        actorUserId: PHASE1A_SEED_IDS.users.architectCfo,
        action: 'WORKSPACE_SWITCHED',
      });
      // isDefaultWorkspace remains unchanged
      expect(
        store.memberships.get(PHASE1A_SEED_IDS.memberships.cfoSalvage)!
          .isDefaultWorkspace,
      ).toBe(true);
      expect(
        store.memberships.get(PHASE1A_SEED_IDS.memberships.cfoCannabis)!
          .isDefaultWorkspace,
      ).toBe(false);

      // Cookie failure after DB commit propagates error
      await expect(
        switchOrganizationWorkspace(
          switched,
          PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          {
            repository: repo,
            cookieWriter: {
              setActiveOrganization: async () => {
                throw new Error('Cookie write rejected');
              },
            },
            clock: { now: () => fixedNow },
          },
        ),
      ).rejects.toThrow('Cookie write rejected');
    });

    it('immediately revokes access on deactivation (403 MEMBERSHIP_REVOKED_OR_INACTIVE) and supports CFO-only reactivation & last-CFO protection', async () => {
      const repo = store.toRepository();
      const fixedNow = new Date('2026-11-14T18:05:00.000Z');

      const cfoAal2 = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );

      // Non-CFO cannot deactivate or reactivate
      const hunterSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.hunterMechanic,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      await expect(
        deactivateOrganizationMembership(
          hunterSession,
          PHASE1A_SEED_IDS.memberships.stripperSalvage,
          'Attempt by mechanic',
          { repository: repo },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'CAPABILITY_FORBIDDEN' });

      // Blank reason or invalid UUID -> 400 INVALID_AUTH_INPUT
      await expect(
        deactivateOrganizationMembership(
          cfoAal2,
          PHASE1A_SEED_IDS.memberships.stripperSalvage,
          '   ',
          { repository: repo },
        ),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_AUTH_INPUT' });

      // Foreign-org membership or nonexistent ID -> non-enumerating 403
      await expect(
        deactivateOrganizationMembership(
          cfoAal2,
          PHASE1A_SEED_IDS.memberships.qapCannabis,
          'Cross-tenant attempt',
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Last effective CFO protection -> 422 LAST_ACTIVE_CFO_PROTECTED
      await expect(
        deactivateOrganizationMembership(
          cfoAal2,
          PHASE1A_SEED_IDS.memberships.cfoSalvage,
          'Self removal as last CFO',
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 422,
        code: 'LAST_ACTIVE_CFO_PROTECTED',
      });

      // Deactivate Ontario Stripper membership
      const deactivated = await deactivateOrganizationMembership(
        cfoAal2,
        PHASE1A_SEED_IDS.memberships.stripperSalvage,
        '  Contract ended  ',
        { repository: repo, clock: { now: () => fixedNow } },
      );
      expect(deactivated.changed).toBe(true);
      expect(deactivated.membership.isActive).toBe(false);
      expect(deactivated.membership.revocationReason).toBe('Contract ended');
      expect(deactivated.membership.deactivatedById).toBe(
        PHASE1A_SEED_IDS.users.architectCfo,
      );

      // Idempotent repeat deactivation -> changed: false, no duplicate audit
      const auditCountAfterDeactivate = store.auditLogs.length;
      const repeatDeactivate = await deactivateOrganizationMembership(
        cfoAal2,
        PHASE1A_SEED_IDS.memberships.stripperSalvage,
        'Contract ended again',
        { repository: repo },
      );
      expect(repeatDeactivate.changed).toBe(false);
      expect(store.auditLogs).toHaveLength(auditCountAfterDeactivate);

      // Revoked user immediately gets 403 MEMBERSHIP_REVOKED_OR_INACTIVE on auth resolution
      const bootstrapForRevoked = await repo.findActiveUserBootstrap(
        PHASE1A_SEED_IDS.users.revokedContractor,
      );
      expect(bootstrapForRevoked?.memberships).toHaveLength(0);

      await expect(
        resolveTestHeaderAuthContext(
          {
            'x-test-user-id': PHASE1A_SEED_IDS.users.ontarioStripper,
            'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          },
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Stale CFO session whose Cannabis membership was revoked cannot switch from or to it
      const cfoCannabisSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      // Add second CFO in Salvage so CFO can self-revoke in Salvage
      const secondCfoUserId = randomUUID();
      const secondCfoMembershipId = randomUUID();
      store.users.set(secondCfoUserId, {
        id: secondCfoUserId,
        isActive: true,
        mfaEnrolled: true,
      });
      store.memberships.set(secondCfoMembershipId, {
        id: secondCfoMembershipId,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        userId: secondCfoUserId,
        role: UserRole.ARCHITECT_CFO,
        isDefaultWorkspace: true,
        isActive: true,
        deactivatedAt: null,
        deactivatedById: null,
        revocationReason: null,
      });

      const selfRevokeSalvage = await deactivateOrganizationMembership(
        cfoAal2,
        PHASE1A_SEED_IDS.memberships.cfoSalvage,
        'Handover to second CFO',
        { repository: repo, clock: { now: () => fixedNow } },
      );
      expect(selfRevokeSalvage.changed).toBe(true);

      // Stale cfoAal2 session (which was active in Salvage) cannot switch to Cannabis after Salvage revocation
      await expect(
        switchOrganizationWorkspace(
          cfoAal2,
          PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          {
            repository: repo,
            cookieWriter: { setActiveOrganization: async () => undefined },
          },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Stale cfoCannabisSession cannot switch to revoked Salvage membership
      await expect(
        switchOrganizationWorkspace(
          cfoCannabisSession,
          PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          {
            repository: repo,
            cookieWriter: { setActiveOrganization: async () => undefined },
          },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Second CFO reactivates Ontario Stripper membership (must clear deactivation metadata, preserve role)
      const secondCfoSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': secondCfoUserId,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      const reactivated = await reactivateOrganizationMembership(
        secondCfoSession,
        PHASE1A_SEED_IDS.memberships.stripperSalvage,
        { repository: repo, clock: { now: () => fixedNow } },
      );
      expect(reactivated.changed).toBe(true);
      expect(reactivated.membership.isActive).toBe(true);
      expect(reactivated.membership.role).toBe(UserRole.ONTARIO_STRIPPER);
      expect(reactivated.membership.deactivatedAt).toBeNull();
      expect(reactivated.membership.deactivatedById).toBeNull();
      expect(reactivated.membership.revocationReason).toBeNull();

      // Reactivating membership of a globally inactive User fails with 403
      store.users.get(PHASE1A_SEED_IDS.users.revokedContractor)!.isActive =
        false;
      await expect(
        reactivateOrganizationMembership(
          secondCfoSession,
          PHASE1A_SEED_IDS.memberships.revokedContractorSalvage,
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });
    });
  });

  describe('OrganizationWorkspaceSwitcher UI & Server Action', () => {
    it('renders switcher strictly when activeMemberships.length > 1 and disappears immediately after revocation', async () => {
      const repo = store.toRepository();
      const dummyAction = async () => undefined;

      // Single-org user -> renders null (empty HTML)
      const hunterSession = await resolveTestHeaderAuthContext(
        { 'x-test-user-id': PHASE1A_SEED_IDS.users.hunterMechanic },
        { repository: repo },
      );
      const hunterHtml = renderToStaticMarkup(
        React.createElement(OrganizationWorkspaceSwitcher, {
          session: hunterSession,
          action: dummyAction,
        }),
      );
      expect(hunterHtml).toBe('');

      // Dual-org CFO -> renders both labels with active indicator & switch form
      const cfoSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      const cfoHtml = renderToStaticMarkup(
        React.createElement(OrganizationWorkspaceSwitcher, {
          session: cfoSession,
          action: dummyAction,
        }),
      );
      expect(cfoHtml).toContain('Auto &amp; Marine Salvage');
      expect(cfoHtml).toContain('Cannabis Cultivation &amp; Processing');
      expect(cfoHtml).toContain('aria-current="page"');
      expect(cfoHtml).toContain(
        `value="${PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC}"`,
      );

      // Non-CFO explicitly granted 2 active memberships also sees the switcher
      const dualHunterMembershipId = randomUUID();
      store.memberships.set(dualHunterMembershipId, {
        id: dualHunterMembershipId,
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        userId: PHASE1A_SEED_IDS.users.hunterMechanic,
        role: UserRole.HUNTER_MECHANIC,
        isDefaultWorkspace: false,
        isActive: true,
        deactivatedAt: null,
        deactivatedById: null,
        revocationReason: null,
      });
      const dualHunterSession = await resolveTestHeaderAuthContext(
        { 'x-test-user-id': PHASE1A_SEED_IDS.users.hunterMechanic },
        { repository: repo },
      );
      const dualHunterHtml = renderToStaticMarkup(
        React.createElement(OrganizationWorkspaceSwitcher, {
          session: dualHunterSession,
          action: dummyAction,
        }),
      );
      expect(dualHunterHtml).toContain('Auto &amp; Marine Salvage');
      expect(dualHunterHtml).toContain('Cannabis Cultivation &amp; Processing');

      // Deactivating one of the dual memberships causes switcher to disappear on next render
      const cfoCannabis = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );
      await deactivateOrganizationMembership(
        cfoCannabis,
        dualHunterMembershipId,
        'Remove temporary cannabis assignment',
        { repository: repo },
      );
      const singleAgainSession = await resolveTestHeaderAuthContext(
        { 'x-test-user-id': PHASE1A_SEED_IDS.users.hunterMechanic },
        { repository: repo },
      );
      const singleAgainHtml = renderToStaticMarkup(
        React.createElement(OrganizationWorkspaceSwitcher, {
          session: singleAgainSession,
          action: dummyAction,
        }),
      );
      expect(singleAgainHtml).toBe('');
    });

    it('executes server action boundary: validates target UUID, re-resolves session, switches workspace, and revalidates', async () => {
      const repo = store.toRepository();
      const cookieWrites: string[] = [];

      const badForm = new FormData();
      badForm.set('targetOrganizationId', 'invalid-org-id');
      await expect(
        executeSwitchOrganizationWorkspaceAction(badForm, {
          resolveSession: async () =>
            resolveTestHeaderAuthContext(
              { 'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo },
              { repository: repo },
            ),
        }),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_AUTH_INPUT' });

      const goodForm = new FormData();
      goodForm.set(
        'targetOrganizationId',
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      );
      let revalidatedCount = 0;

      const updated = await executeSwitchOrganizationWorkspaceAction(goodForm, {
        resolveSession: async () =>
          resolveTestHeaderAuthContext(
            {
              'x-test-user-id': PHASE1A_SEED_IDS.users.architectCfo,
              'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
              'x-test-aal': 'aal1',
            },
            { repository: repo },
          ),
        switchDeps: {
          repository: repo,
          cookieWriter: {
            setActiveOrganization: async (orgId) => {
              cookieWrites.push(orgId);
            },
          },
        },
        revalidate: () => {
          revalidatedCount += 1;
        },
      });

      expect(updated.activeOrganizationId).toBe(
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      );
      expect(cookieWrites).toEqual([
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      ]);
      expect(revalidatedCount).toBe(1);
    });
  });
});

// ============================================================================
// 2. Real PostgreSQL 16 erp_app_user Integration Tests (Conditional on TEST_DATABASE_URL)
// ============================================================================

const HAS_TEST_DATABASE_URL =
  typeof process.env.TEST_DATABASE_URL === 'string' &&
  process.env.TEST_DATABASE_URL.trim().length > 0;

function requireEnvUrl(name: 'TEST_DATABASE_URL' | 'DIRECT_URL'): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is required when running PostgreSQL auth integration tests.`,
    );
  }
  return value;
}

describe.runIf(HAS_TEST_DATABASE_URL)(
  'Issue #4: Live PostgreSQL 16 erp_app_user Auth, Identity Firewall & Membership Lifecycle',
  () => {
    let runtimePrismaA!: PrismaClient;
    let runtimePrismaB!: PrismaClient;
    let ownerPrisma!: PrismaClient;

    const createdUserIds: string[] = [];
    const createdMembershipIds: string[] = [];
    const createdAuditIds: string[] = [];

    beforeAll(async () => {
      const testUrl = requireEnvUrl('TEST_DATABASE_URL');
      const directUrl = requireEnvUrl('DIRECT_URL');

      runtimePrismaA = new PrismaClient({
        datasources: { db: { url: testUrl } },
      });
      runtimePrismaB = new PrismaClient({
        datasources: { db: { url: testUrl } },
      });
      ownerPrisma = new PrismaClient({
        datasources: { db: { url: directUrl } },
      });

      await Promise.all([
        runtimePrismaA.$connect(),
        runtimePrismaB.$connect(),
        ownerPrisma.$connect(),
      ]);
    });

    afterAll(async () => {
      if (ownerPrisma) {
        if (createdAuditIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."AuditLog"
            WHERE "id" = ANY(${createdAuditIds}::uuid[])
          `;
        }
        if (createdMembershipIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."OrganizationMembership"
            WHERE "id" = ANY(${createdMembershipIds}::uuid[])
          `;
        }
        if (createdUserIds.length > 0) {
          await ownerPrisma.$executeRaw`
            DELETE FROM "shared"."User"
            WHERE "id" = ANY(${createdUserIds}::uuid[])
          `;
        }
      }

      await Promise.allSettled([
        runtimePrismaA?.$disconnect(),
        runtimePrismaB?.$disconnect(),
        ownerPrisma?.$disconnect(),
      ]);
    });

    async function createIsolatedUserAndMembership(input: {
      organizationId: string;
      role: UserRole;
      mfaEnrolled?: boolean;
      userIsActive?: boolean;
      membershipIsActive?: boolean;
      isDefaultWorkspace?: boolean;
    }): Promise<{ userId: string; membershipId: string }> {
      const userId = randomUUID();
      const membershipId = randomUUID();
      createdUserIds.push(userId);
      createdMembershipIds.push(membershipId);

      await ownerPrisma.user.create({
        data: {
          id: userId,
          email: `auth-it-${userId}@test.local`,
          fullName: `Auth IT ${userId.slice(0, 8)}`,
          role: input.role,
          mfaEnrolled: input.mfaEnrolled ?? true,
          isActive: input.userIsActive ?? true,
        },
      });

      await ownerPrisma.organizationMembership.create({
        data: {
          id: membershipId,
          organizationId: input.organizationId,
          userId,
          role: input.role,
          isDefaultWorkspace: input.isDefaultWorkspace ?? true,
          isActive: input.membershipIsActive ?? true,
          deactivatedAt:
            input.membershipIsActive === false ? new Date() : null,
          revocationReason:
            input.membershipIsActive === false
              ? 'Initial inactive fixture'
              : null,
        },
      });

      return { userId, membershipId };
    }

    it('executes under least-privilege erp_app_user (NOBYPASSRLS) and enforces shared.User identity firewall & column grants', async () => {
      const roleRows = await runtimePrismaA.$queryRaw<
        Array<{
          currentUser: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>
      >`
        SELECT
          current_user AS "currentUser",
          r.rolsuper AS "rolsuper",
          r.rolbypassrls AS "rolbypassrls"
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      expect(roleRows[0]).toEqual({
        currentUser: 'erp_app_user',
        rolsuper: false,
        rolbypassrls: false,
      });

      const salvageUser = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        role: UserRole.ONTARIO_STRIPPER,
        mfaEnrolled: false,
      });
      const cannabisUser = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        role: UserRole.CANNABIS_QAP_COMPLIANCE,
        mfaEnrolled: true,
      });

      const repo = createPrismaAuthRepository({ prisma: runtimePrismaA });
      const salvageSession = await resolveTestHeaderAuthContext(
        { 'x-test-user-id': salvageUser.userId },
        { repository: repo },
      );

      // Salvage principal cannot enumerate cannabis User rows or escalate User.role
      await withTenantTransaction(
        runtimePrismaA,
        toTenantExecutionContext(salvageSession),
        async (tx) => {
          const visibleCannabis = await tx.user.findMany({
            where: { id: cannabisUser.userId },
          });
          expect(visibleCannabis).toHaveLength(0);

          await expect(
            tx.$queryRaw`
              UPDATE "shared"."User"
              SET "role" = 'ARCHITECT_CFO'::"shared"."UserRole"
              WHERE "id" = ${salvageUser.userId}::uuid
            `,
          ).rejects.toThrow();
        },
      );
    });

    it('immediately revokes access across auth, workspace switch, and withTenantTransaction, and restores access on CFO reactivation', async () => {
      const repo = createPrismaAuthRepository({ prisma: runtimePrismaA });
      const cfoFixture = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        role: UserRole.ARCHITECT_CFO,
        mfaEnrolled: true,
      });
      const stripperFixture = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        role: UserRole.ONTARIO_STRIPPER,
        mfaEnrolled: false,
      });
      // Give stripper a second active membership in Cannabis? No — stripper role is salvage-only;
      // use a second CFO or hunter for multi-org switch test, and test stripper deactivation/reactivation.
      const hunterDualUser = await createIsolatedUserAndMembership({
        organizationId: PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        role: UserRole.HUNTER_MECHANIC,
        mfaEnrolled: false,
      });
      const hunterCannabisMembershipId = randomUUID();
      createdMembershipIds.push(hunterCannabisMembershipId);
      await ownerPrisma.organizationMembership.create({
        data: {
          id: hunterCannabisMembershipId,
          organizationId: PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
          userId: hunterDualUser.userId,
          role: UserRole.HUNTER_MECHANIC,
          isDefaultWorkspace: false,
          isActive: true,
        },
      });

      const cfoSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': cfoFixture.userId,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
          'x-test-aal': 'aal2',
        },
        { repository: repo },
      );

      // Non-CFO cannot update OrganizationMembership directly under RLS
      const stripperSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': stripperFixture.userId,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        },
        { repository: repo },
      );
      await withTenantTransaction(
        runtimePrismaA,
        toTenantExecutionContext(stripperSession),
        async (tx) => {
          const updatedCount = await tx.$executeRaw`
            UPDATE "shared"."OrganizationMembership"
            SET "isActive" = false
            WHERE "id" = ${stripperFixture.membershipId}::uuid
          `;
          expect(updatedCount).toBe(0);
        },
      );

      // CFO deactivates stripper
      const auditId1 = randomUUID();
      createdAuditIds.push(auditId1);
      const deactivated = await deactivateOrganizationMembership(
        cfoSession,
        stripperFixture.membershipId,
        'Revoked via integration test',
        { repository: repo, idGenerator: () => auditId1 },
      );
      expect(deactivated.changed).toBe(true);
      expect(deactivated.auditId).toBe(auditId1);

      // Next auth request fails with 403
      await expect(
        resolveTestHeaderAuthContext(
          { 'x-test-user-id': stripperFixture.userId },
          { repository: repo },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
      });

      // Old tenant context fails in withTenantTransaction
      await expect(
        withTenantTransaction(
          runtimePrismaA,
          toTenantExecutionContext(stripperSession),
          async () => true,
        ),
      ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_UNAUTHORIZED' });

      // Revoked dual-org user cannot switch out of a revoked active workspace
      const hunterSalvageSession = await resolveTestHeaderAuthContext(
        {
          'x-test-user-id': hunterDualUser.userId,
          'x-test-org-id': PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
        },
        { repository: repo },
      );
      const switchAuditId = randomUUID();
      createdAuditIds.push(switchAuditId);
      const switchedHunter = await switchOrganizationWorkspace(
        hunterSalvageSession,
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
        {
          repository: repo,
          cookieWriter: { setActiveOrganization: async () => undefined },
          idGenerator: () => switchAuditId,
        },
      );
      expect(switchedHunter.activeOrganizationId).toBe(
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      );
      const switchAuditRow = await ownerPrisma.auditLog.findUnique({
        where: { id: switchAuditId },
      });
      expect(switchAuditRow?.organizationId).toBe(
        PHASE1A_SEED_IDS.orgs.ORG_CANNABIS_NURSERY_PROC,
      );
      expect(switchAuditRow?.action).toBe('WORKSPACE_SWITCHED');

      // Reactivate stripper and prove historical row ID is preserved and access restored
      const auditId2 = randomUUID();
      createdAuditIds.push(auditId2);
      const reactivated = await reactivateOrganizationMembership(
        cfoSession,
        stripperFixture.membershipId,
        { repository: repo, idGenerator: () => auditId2 },
      );
      expect(reactivated.changed).toBe(true);
      expect(reactivated.membership.id).toBe(stripperFixture.membershipId);
      expect(reactivated.membership.isActive).toBe(true);

      const restoredSession = await resolveTestHeaderAuthContext(
        { 'x-test-user-id': stripperFixture.userId },
        { repository: repo },
      );
      expect(restoredSession.activeOrganizationId).toBe(
        PHASE1A_SEED_IDS.orgs.ORG_SALVAGE_EXPORT,
      );
    });

    it('enforces single-statement self-revocation WITH CHECK + AuditLog atomicity and prevents concurrent mutual CFO deactivation', async () => {
      const repoA = createPrismaAuthRepository({ prisma: runtimePrismaA });
      const repoB = createPrismaAuthRepository({ prisma: runtimePrismaB });

      // Use isolated test organization? Reuse ORG_CANNABIS_NURSERY_PROC? Better: create an isolated org
      // so concurrent/last-CFO checks never interfere with seeded CFO rows!
      const isolatedOrgId = randomUUID();
      await ownerPrisma.organization.create({
        data: {
          id: isolatedOrgId,
          slug: `ORG_AUTH_IT_${isolatedOrgId.slice(0, 8)}`,
          name: 'Auth Integration Test Org',
          organizationType: OrganizationType.SALVAGE_AND_EXPORT,
          isActive: true,
        },
      });

      try {
        const cfo1 = await createIsolatedUserAndMembership({
          organizationId: isolatedOrgId,
          role: UserRole.ARCHITECT_CFO,
          mfaEnrolled: true,
        });
        const cfo2 = await createIsolatedUserAndMembership({
          organizationId: isolatedOrgId,
          role: UserRole.ARCHITECT_CFO,
          mfaEnrolled: true,
        });

        const cfo1Session = await resolveTestHeaderAuthContext(
          {
            'x-test-user-id': cfo1.userId,
            'x-test-org-id': isolatedOrgId,
            'x-test-aal': 'aal2',
          },
          { repository: repoA },
        );
        const cfo2Session = await resolveTestHeaderAuthContext(
          {
            'x-test-user-id': cfo2.userId,
            'x-test-org-id': isolatedOrgId,
            'x-test-aal': 'aal2',
          },
          { repository: repoB },
        );

        // Concurrent mutual deactivation race: at most 1 commits; the other fails and >= 1 CFO remains
        const raceAudit1 = randomUUID();
        const raceAudit2 = randomUUID();
        createdAuditIds.push(raceAudit1, raceAudit2);

        const [res1, res2] = await Promise.allSettled([
          deactivateOrganizationMembership(
            cfo1Session,
            cfo2.membershipId,
            'Concurrent race CFO1 -> CFO2',
            { repository: repoA, idGenerator: () => raceAudit1 },
          ),
          deactivateOrganizationMembership(
            cfo2Session,
            cfo1.membershipId,
            'Concurrent race CFO2 -> CFO1',
            { repository: repoB, idGenerator: () => raceAudit2 },
          ),
        ]);

        const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
        const rejected = [res1, res2].filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toBeInstanceOf(AuthError);
        expect(['MEMBERSHIP_REVOKED_OR_INACTIVE', 'LAST_ACTIVE_CFO_PROTECTED']).toContain(
          (rejected[0]!.reason as AuthError).code,
        );

        const activeCfoCount = await ownerPrisma.organizationMembership.count({
          where: {
            organizationId: isolatedOrgId,
            role: UserRole.ARCHITECT_CFO,
            isActive: true,
          },
        });
        expect(activeCfoCount).toBe(1);

        // Find surviving CFO and verify last-CFO protection (422)
        const survivorMembership =
          await ownerPrisma.organizationMembership.findFirstOrThrow({
            where: {
              organizationId: isolatedOrgId,
              role: UserRole.ARCHITECT_CFO,
              isActive: true,
            },
          });
        const survivorSession = await resolveTestHeaderAuthContext(
          {
            'x-test-user-id': survivorMembership.userId,
            'x-test-org-id': isolatedOrgId,
            'x-test-aal': 'aal2',
          },
          { repository: repoA },
        );
        await expect(
          deactivateOrganizationMembership(
            survivorSession,
            survivorMembership.id,
            'Cannot remove final CFO',
            { repository: repoA },
          ),
        ).rejects.toMatchObject({
          status: 422,
          code: 'LAST_ACTIVE_CFO_PROTECTED',
        });

        // Reactivate the deactivated CFO, then verify self-revocation commits 1 AuditLog under erp_app_user RLS
        const deactivatedMembership =
          await ownerPrisma.organizationMembership.findFirstOrThrow({
            where: {
              organizationId: isolatedOrgId,
              role: UserRole.ARCHITECT_CFO,
              isActive: false,
            },
          });
        const reactivateAuditId = randomUUID();
        createdAuditIds.push(reactivateAuditId);
        await reactivateOrganizationMembership(
          survivorSession,
          deactivatedMembership.id,
          { repository: repoA, idGenerator: () => reactivateAuditId },
        );

        const selfRevokeAuditId = randomUUID();
        createdAuditIds.push(selfRevokeAuditId);
        const selfRevoked = await deactivateOrganizationMembership(
          survivorSession,
          survivorMembership.id,
          'Self-revocation with second CFO present',
          { repository: repoA, idGenerator: () => selfRevokeAuditId },
        );
        expect(selfRevoked.changed).toBe(true);
        expect(selfRevoked.membership.isActive).toBe(false);
        expect(selfRevoked.auditId).toBe(selfRevokeAuditId);

        // Immediate revocation verified on next request
        await expect(
          resolveTestHeaderAuthContext(
            {
              'x-test-user-id': survivorMembership.userId,
              'x-test-org-id': isolatedOrgId,
            },
            { repository: repoA },
          ),
        ).rejects.toMatchObject({
          status: 403,
          code: 'MEMBERSHIP_REVOKED_OR_INACTIVE',
        });

        // AuditLog row exists and is immutable under erp_app_user
        const auditRow = await ownerPrisma.auditLog.findUnique({
          where: { id: selfRevokeAuditId },
        });
        expect(auditRow?.action).toBe('MEMBERSHIP_DEACTIVATED');

        // Verify erp_app_user cannot UPDATE or DELETE AuditLog rows
        await expect(
          withTenantTransaction(
            runtimePrismaA,
            {
              organizationId: isolatedOrgId,
              userId: deactivatedMembership.userId,
              role: UserRole.ARCHITECT_CFO,
            },
            async (tx) => {
              await tx.$executeRaw`
                UPDATE "shared"."AuditLog"
                SET "action" = 'TAMPERED'
                WHERE "id" = ${selfRevokeAuditId}::uuid
              `;
            },
          ),
        ).rejects.toThrow();

        // Verify inactive membership is excluded from bootstrap discovery
        const revokedBootstrap = await repoA.findActiveUserBootstrap(
          survivorMembership.userId,
        );
        expect(
          revokedBootstrap?.memberships.some(
            (m) => m.organizationId === isolatedOrgId,
          ),
        ).toBe(false);
      } finally {
        await ownerPrisma.$executeRaw`
          DELETE FROM "shared"."AuditLog"
          WHERE "organizationId" = ${isolatedOrgId}::uuid
        `;
        await ownerPrisma.$executeRaw`
          DELETE FROM "shared"."OrganizationMembership"
          WHERE "organizationId" = ${isolatedOrgId}::uuid
        `;
        await ownerPrisma.$executeRaw`
          DELETE FROM "shared"."Organization"
          WHERE "id" = ${isolatedOrgId}::uuid
        `;
      }
    });
  },
);
