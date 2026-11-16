import React from 'react';
import {
  assertCapability,
  AuthError,
  resolveAuthSessionContext,
} from '@/modules/shared-ops/auth';
import { VehicleIntakeForm } from './vehicle-intake-form';

export const dynamic = 'force-dynamic';

export default async function VehicleIntakePage(): Promise<React.ReactElement> {
  try {
    const session = await resolveAuthSessionContext();
    assertCapability(session, 'FR-INT-01');

    const activeOrg = session.activeMemberships.find(
      (m) => m.organizationId === session.activeOrganizationId,
    );

    const canCfoOverride =
      session.role === 'ARCHITECT_CFO' &&
      session.mfaEnrolled &&
      session.aal === 'aal2';

    return (
      <VehicleIntakeForm
        organizationId={session.activeOrganizationId}
        organizationName={activeOrg?.organizationName ?? 'Active Salvage Workspace'}
        actorRole={session.role}
        canCfoOverride={canCfoOverride}
      />
    );
  } catch (error) {
    const message =
      error instanceof AuthError
        ? error.message
        : 'Authentication and FR-INT-01 salvage intake permission are required.';

    return (
      <main
        data-testid="vehicle-intake-unauthorized"
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
          Vehicle Intake Access Denied
        </h1>
        <p style={{ fontWeight: 600, marginBottom: 0 }}>{message}</p>
      </main>
    );
  }
}
