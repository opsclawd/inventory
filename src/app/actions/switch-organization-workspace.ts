'use server';

import { revalidatePath } from 'next/cache';
import {
  assertValidUuid,
  AuthError,
  type AuthSessionContext,
} from '@/modules/shared-ops/auth/auth.contracts';
import { resolveAuthSessionContext } from '@/modules/shared-ops/auth/auth-context';
import {
  switchOrganizationWorkspace,
  type SwitchWorkspaceDeps,
} from '@/modules/shared-ops/auth/switch-workspace.use-case';

export interface SwitchOrganizationWorkspaceActionDeps {
  readonly resolveSession?: () => Promise<AuthSessionContext>;
  readonly switchWorkspace?: (
    session: AuthSessionContext,
    targetOrganizationId: string,
    deps?: SwitchWorkspaceDeps,
  ) => Promise<AuthSessionContext>;
  readonly switchDeps?: SwitchWorkspaceDeps;
  readonly revalidate?: () => void;
}

export async function executeSwitchOrganizationWorkspaceAction(
  formData: FormData,
  deps: SwitchOrganizationWorkspaceActionDeps = {},
): Promise<AuthSessionContext> {
  if (!formData || typeof formData.get !== 'function') {
    throw new AuthError(
      'INVALID_AUTH_INPUT',
      'Workspace switch submission requires FormData.',
    );
  }

  const rawTargetOrgId = formData.get('targetOrganizationId');
  if (
    typeof rawTargetOrgId !== 'string' ||
    rawTargetOrgId.trim().length === 0
  ) {
    throw new AuthError(
      'INVALID_AUTH_INPUT',
      'targetOrganizationId is required.',
    );
  }

  const targetOrganizationId = assertValidUuid(
    rawTargetOrgId.trim(),
    'targetOrganizationId',
    'INVALID_AUTH_INPUT',
  );

  const resolveSession =
    deps.resolveSession ??
    (() => resolveAuthSessionContext({ isMutationContext: true }));
  const runSwitch = deps.switchWorkspace ?? switchOrganizationWorkspace;
  const revalidate = deps.revalidate ?? (() => revalidatePath('/', 'layout'));

  const session = await resolveSession();
  const updatedSession = await runSwitch(
    session,
    targetOrganizationId,
    deps.switchDeps,
  );
  revalidate();
  return updatedSession;
}

/**
 * Next.js 15 Server Action for switching the active organization workspace from
 * OrganizationWorkspaceSwitcher. Re-resolves server identity on every invocation.
 */
export async function switchOrganizationWorkspaceAction(
  formData: FormData,
): Promise<void> {
  await executeSwitchOrganizationWorkspaceAction(formData);
}
