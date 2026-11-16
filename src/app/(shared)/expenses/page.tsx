import React from 'react';
import {
  assertCapability,
  AuthError,
  type AuthSessionContext,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { ExpenseWorkspaceForm } from './expense-form';

export const dynamic = 'force-dynamic';

function assertPageAccess(session: AuthSessionContext): void {
  if (session.role === 'ARCHITECT_CFO') {
    if (session.activeOrganizationType === 'SALVAGE_AND_EXPORT') {
      assertCapability(session, 'FR-EXP-02:read');
    } else {
      assertCapability(session, 'FR-EXP-01:read');
    }
    return;
  }
  if (
    session.role === 'HUNTER_MECHANIC' ||
    session.role === 'CANNABIS_QAP_COMPLIANCE'
  ) {
    assertCapability(session, 'FR-EXP-01:read');
    return;
  }
  if (session.role === 'ONTARIO_STRIPPER') {
    assertCapability(session, 'FR-EXP-02:read-own-piece-rate');
    return;
  }
  if (session.role === 'TRINIDAD_VAULT_ADMIN') {
    assertCapability(session, 'FR-EXP-01:create-port-fees');
    return;
  }
  if (session.role === 'NURSERY_CULTIVATION_TECH') {
    assertCapability(session, 'FR-EXP-01:create-nursery-supplies');
    return;
  }
  throw new AuthError(
    'CAPABILITY_FORBIDDEN',
    `Role ${session.role} is not authorized to access the shared expenses workspace.`,
  );
}

export default async function SharedExpensesPage(): Promise<React.ReactElement> {
  try {
    const session = await resolveAuthSessionContext();
    assertPageAccess(session);

    const activeOrg = session.activeMemberships.find(
      (m) => m.organizationId === session.activeOrganizationId,
    );

    return (
      <ExpenseWorkspaceForm
        organizationId={session.activeOrganizationId}
        organizationName={
          activeOrg?.organizationName ?? 'Active Organization Workspace'
        }
        organizationType={session.activeOrganizationType}
        actorUserId={session.userId}
        actorRole={session.role}
      />
    );
  } catch (error) {
    const message =
      error instanceof AuthError
        ? error.message
        : 'Authentication and active expense subledger permissions are required.';

    return (
      <main
        data-testid="expenses-unauthorized"
        style={{
          maxWidth: '640px',
          margin: '24px auto',
          padding: '16px',
          backgroundColor: '#FEF2F2',
          border: '2px solid #991B1B',
          borderRadius: '10px',
          color: '#991B1B',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h1 style={{ fontSize: '20px', fontWeight: 800, marginTop: 0 }}>
          Expenses &amp; Subledger Access Denied
        </h1>
        <p style={{ fontWeight: 600, marginBottom: 0 }}>{message}</p>
      </main>
    );
  }
}
