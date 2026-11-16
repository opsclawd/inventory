import React from 'react';
import {
  assertCapability,
  AuthError,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { PartStripForm } from './part-strip-form';

export const dynamic = 'force-dynamic';

export default async function PartStripPage(): Promise<React.ReactElement> {
  try {
    const session = await resolveAuthSessionContext();
    assertCapability(session, 'FR-INT-02');

    const activeOrg = session.activeMemberships.find(
      (m) => m.organizationId === session.activeOrganizationId,
    );

    return (
      <PartStripForm
        organizationId={session.activeOrganizationId}
        organizationName={
          activeOrg?.organizationName ?? 'Active Salvage Workspace'
        }
        actorRole={session.role}
      />
    );
  } catch (error) {
    const message =
      error instanceof AuthError
        ? error.message
        : 'Authentication and FR-INT-02 salvage part-strip permission are required.';

    return (
      <main
        data-testid="part-strip-unauthorized"
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
          Part Strip Access Denied
        </h1>
        <p style={{ fontWeight: 600, marginBottom: 0 }}>{message}</p>
      </main>
    );
  }
}
