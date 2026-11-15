import {
  assertValidUuid,
  type AssuranceLevel,
  AuthError,
  type AuthRepository,
  type AuthSessionContext,
} from './auth.contracts';
import {
  createPrismaAuthRepository,
  resolveSessionFromBootstrapRecord,
} from './auth-context';

export type TestAuthHeaderInput =
  | Headers
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface ResolveTestHeaderAuthOptions {
  readonly repository?: AuthRepository;
}

function readHeaderValue(
  source: TestAuthHeaderInput,
  headerName: string,
): string | undefined {
  if (
    source &&
    typeof source === 'object' &&
    'get' in source &&
    typeof source.get === 'function'
  ) {
    const val = source.get(headerName);
    return val === null ? undefined : val;
  }

  const record = source as Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return value[0];
    }
  }
  return undefined;
}

/**
 * Deterministic test-only header identity resolver enabled strictly when NODE_ENV === 'test'.
 * Accepts only x-test-user-id, x-test-org-id, and x-test-aal; ignores any spoofed role headers
 * and resolves live active OrganizationMembership, User, and Organization state from the repository.
 */
export async function resolveTestHeaderAuthContext(
  headerInput: TestAuthHeaderInput,
  options: ResolveTestHeaderAuthOptions = {},
): Promise<AuthSessionContext> {
  if (process.env.NODE_ENV !== 'test') {
    throw new AuthError(
      'AUTH_CONFIGURATION_ERROR',
      'Test header authentication adapter is strictly forbidden outside NODE_ENV === "test".',
    );
  }

  if (!headerInput || typeof headerInput !== 'object') {
    throw new AuthError(
      'UNAUTHENTICATED',
      'x-test-user-id header is required for test authentication.',
    );
  }

  const rawUserId = readHeaderValue(headerInput, 'x-test-user-id')?.trim();
  if (!rawUserId) {
    throw new AuthError(
      'UNAUTHENTICATED',
      'x-test-user-id header is required for test authentication.',
    );
  }
  const verifiedUserId = assertValidUuid(
    rawUserId,
    'x-test-user-id',
    'INVALID_AUTH_INPUT',
  );

  const rawOrgId = readHeaderValue(headerInput, 'x-test-org-id')?.trim();
  const selectedOrganizationId =
    rawOrgId && rawOrgId.length > 0
      ? assertValidUuid(rawOrgId, 'x-test-org-id', 'INVALID_AUTH_INPUT')
      : undefined;

  const rawAal = readHeaderValue(headerInput, 'x-test-aal')?.trim();
  let aal: AssuranceLevel = 'aal1';
  if (rawAal !== undefined && rawAal.length > 0) {
    if (rawAal !== 'aal1' && rawAal !== 'aal2') {
      throw new AuthError(
        'INVALID_AUTH_INPUT',
        'x-test-aal header must be either "aal1" or "aal2".',
      );
    }
    aal = rawAal;
  }

  const repository = options.repository ?? createPrismaAuthRepository();
  const bootstrap = await repository.findActiveUserBootstrap(verifiedUserId);

  return resolveSessionFromBootstrapRecord({
    userId: verifiedUserId,
    aal,
    selectedOrganizationId,
    bootstrap,
  });
}
