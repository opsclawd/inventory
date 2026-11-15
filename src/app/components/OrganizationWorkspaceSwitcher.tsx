import React from 'react';
import type { OrganizationType } from '@prisma/client';
import { switchOrganizationWorkspaceAction } from '@/app/actions/switch-organization-workspace';
import type {
  ActiveMembershipSummary,
  AuthSessionContext,
} from '@/modules/shared-ops/auth/auth.contracts';

const WORKSPACE_LABEL_BY_ORG_TYPE: Readonly<Record<OrganizationType, string>> =
  {
    SALVAGE_AND_EXPORT: 'Auto & Marine Salvage',
    CANNABIS_NURSERY_AND_PROCESSING: 'Cannabis Cultivation & Processing',
  };

function getWorkspaceDisplayLabel(membership: ActiveMembershipSummary): string {
  return (
    WORKSPACE_LABEL_BY_ORG_TYPE[membership.organizationType] ??
    membership.organizationName
  );
}

export interface OrganizationWorkspaceSwitcherProps {
  readonly session: AuthSessionContext;
  readonly action?: (formData: FormData) => void | Promise<void>;
}

/**
 * Top-left header server component rendering the workspace switcher
 * (`[Auto & Marine Salvage]` <-> `[Cannabis Cultivation & Processing]`)
 * strictly when the authenticated user holds more than one active organization membership.
 */
export function OrganizationWorkspaceSwitcher({
  session,
  action = switchOrganizationWorkspaceAction,
}: OrganizationWorkspaceSwitcherProps): React.ReactElement | null {
  if (!session || session.activeMemberships.length <= 1) {
    return null;
  }

  const activeOrgId = session.activeOrganizationId.toLowerCase();

  return (
    <nav
      aria-label="Organization Workspace Switcher"
      data-testid="organization-workspace-switcher"
      data-active-organization-id={activeOrgId}
    >
      <ul
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {session.activeMemberships.map((membership) => {
          const isCurrent =
            membership.organizationId.toLowerCase() === activeOrgId;
          const label = getWorkspaceDisplayLabel(membership);

          if (isCurrent) {
            return (
              <li key={membership.organizationId}>
                <span
                  aria-current="page"
                  data-active="true"
                  data-organization-id={membership.organizationId}
                  title={membership.organizationName}
                >
                  [{label}]
                </span>
              </li>
            );
          }

          return (
            <li key={membership.organizationId}>
              <form action={action}>
                <input
                  type="hidden"
                  name="targetOrganizationId"
                  value={membership.organizationId}
                />
                <button
                  type="submit"
                  data-active="false"
                  data-organization-id={membership.organizationId}
                  title={`Switch to ${membership.organizationName}`}
                >
                  [{label}]
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
