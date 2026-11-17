import React from 'react';
import {
  assertCapability,
  AuthError,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { DomesticCheckoutForm } from './domestic-checkout-form';

export const dynamic = 'force-dynamic';

export default async function DomesticCheckoutPage(): Promise<React.ReactElement> {
  try {
    const session = await resolveAuthSessionContext();
    assertCapability(session, 'FR-CHK-01:execute-cad-only');

    const activeOrg = session.activeMemberships.find(
      (m) => m.organizationId === session.activeOrganizationId,
    );

    return (
      <DomesticCheckoutForm
        organizationId={session.activeOrganizationId}
        organizationName={
          activeOrg?.organizationName ?? 'Active Salvage Workspace'
        }
        actorUserId={session.userId}
        actorRole={session.role}
      />
    );
  } catch (error) {
    const message =
      error instanceof AuthError
        ? error.message
        : 'Authentication and FR-CHK-01 domestic CAD checkout permissions are required.';

    return (
      <main
        data-testid="domestic-checkout-unauthorized"
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
          Domestic Checkout Access Denied
        </h1>
        <p style={{ fontWeight: 600, marginBottom: 0 }}>{message}</p>
      </main>
    );
  }
}
