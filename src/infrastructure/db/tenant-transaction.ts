import { Prisma, UserRole, type PrismaClient } from '@prisma/client';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_USER_ROLES: ReadonlySet<string> = new Set(Object.values(UserRole));

export const DEFAULT_TENANT_TX_TIMEOUT_MS = 15_000;
export const DEFAULT_BOOTSTRAP_TX_TIMEOUT_MS = 10_000;
export const DEFAULT_TX_MAX_WAIT_MS = 5_000;

export interface TenantExecutionContext {
  organizationId: string;
  userId: string;
  role: UserRole;
}

export interface TenantTransactionOptions {
  maxWait?: number;
  timeout?: number;
}

export type TenantContextErrorCode =
  | 'INVALID_TENANT_CONTEXT_INPUT'
  | 'TENANT_CONTEXT_UNAUTHORIZED'
  | 'NESTED_TENANT_CONTEXT_MISMATCH';

export class TenantContextError extends Error {
  public readonly code: TenantContextErrorCode;

  public constructor(code: TenantContextErrorCode, message: string) {
    super(message);
    this.name = 'TenantContextError';
    this.code = code;
  }
}

function normalizeUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new TenantContextError(
      'INVALID_TENANT_CONTEXT_INPUT',
      `Tenant context ${fieldName} must be a valid UUID.`,
    );
  }
  return value.toLowerCase();
}

function validateUserRole(role: unknown): UserRole {
  if (typeof role !== 'string' || !VALID_USER_ROLES.has(role)) {
    throw new TenantContextError(
      'INVALID_TENANT_CONTEXT_INPUT',
      'Tenant context role must be a valid UserRole enum value.',
    );
  }
  return role as UserRole;
}

function validatePositiveIntOption(
  value: number | undefined,
  defaultValue: number,
  optionName: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TenantContextError(
      'INVALID_TENANT_CONTEXT_INPUT',
      `Transaction option ${optionName} must be a positive safe integer.`,
    );
  }
  return value;
}

function hasTransactionMethod(
  client: PrismaClient | Prisma.TransactionClient,
): boolean {
  return (
    '$transaction' in client &&
    typeof (client as PrismaClient).$transaction === 'function'
  );
}

/**
 * Executes `fn` inside a READ COMMITTED PostgreSQL transaction with transaction-local
 * (`is_local = true`) tenant context GUCs initialized via parameterized `tx.$queryRaw` and
 * immediately verified against live active `OrganizationMembership`, `User`, and `Organization`
 * rows via `shared.current_org_id()`.
 *
 * When passed an existing `Prisma.TransactionClient`, verifies the active transaction-local
 * tuple matches `ctx` exactly and reuses the transaction without resetting claims or timeouts.
 */
export async function withTenantTransaction<T>(
  prismaOrTx: PrismaClient | Prisma.TransactionClient,
  ctx: TenantExecutionContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TenantTransactionOptions,
): Promise<T> {
  if (!ctx || typeof ctx !== 'object') {
    throw new TenantContextError(
      'INVALID_TENANT_CONTEXT_INPUT',
      'TenantExecutionContext is required.',
    );
  }

  const organizationId = normalizeUuid(ctx.organizationId, 'organizationId');
  const userId = normalizeUuid(ctx.userId, 'userId');
  const role = validateUserRole(ctx.role);
  const timeoutMs = validatePositiveIntOption(
    options?.timeout,
    DEFAULT_TENANT_TX_TIMEOUT_MS,
    'timeout',
  );
  const maxWaitMs = validatePositiveIntOption(
    options?.maxWait,
    DEFAULT_TX_MAX_WAIT_MS,
    'maxWait',
  );

  if (!hasTransactionMethod(prismaOrTx)) {
    const existingTx = prismaOrTx as Prisma.TransactionClient;
    const active = await existingTx.$queryRaw<
      Array<{ orgId: string | null; userId: string | null; role: string | null }>
    >`
      SELECT
        "shared"."current_org_id"()::text AS "orgId",
        "shared"."current_user_id"()::text AS "userId",
        "shared"."current_role"() AS "role"
    `;
    const row = active[0];
    if (
      !row ||
      row.orgId?.toLowerCase() !== organizationId ||
      row.userId?.toLowerCase() !== userId ||
      row.role !== role
    ) {
      throw new TenantContextError(
        'NESTED_TENANT_CONTEXT_MISMATCH',
        'Cannot switch or execute an unverified TenantExecutionContext inside an existing Prisma transaction.',
      );
    }
    return fn(existingTx);
  }

  const rootPrisma = prismaOrTx as PrismaClient;
  return rootPrisma.$transaction(
    async (tx) => {
      await tx.$queryRaw<
        Array<{
          org_id: string;
          user_id: string;
          role_name: string;
          statement_timeout: string;
        }>
      >`
        SELECT
          set_config('app.current_org_id', ${organizationId}, true) AS org_id,
          set_config('app.current_user_id', ${userId}, true) AS user_id,
          set_config('app.current_role', ${role}, true) AS role_name,
          set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout
      `;

      const verified = await tx.$queryRaw<Array<{ orgId: string | null }>>`
        SELECT "shared"."current_org_id"()::text AS "orgId"
      `;

      if (verified[0]?.orgId?.toLowerCase() !== organizationId) {
        throw new TenantContextError(
          'TENANT_CONTEXT_UNAUTHORIZED',
          'Authenticated user does not hold an active OrganizationMembership matching the requested organization and role.',
        );
      }

      return fn(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: maxWaitMs,
      timeout: timeoutMs,
    },
  );
}

/**
 * Executes `fn` inside a short-lived READ COMMITTED bootstrap transaction scoped solely to a
 * server-verified active user UUID (`app.current_user_id`) with empty `app.current_org_id` and
 * `app.current_role` claims for non-recursive login workspace discovery.
 */
export async function withAuthBootstrapTransaction<T>(
  prisma: PrismaClient,
  authenticatedUserId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TenantTransactionOptions,
): Promise<T> {
  const userId = normalizeUuid(authenticatedUserId, 'authenticatedUserId');
  const timeoutMs = validatePositiveIntOption(
    options?.timeout,
    DEFAULT_BOOTSTRAP_TX_TIMEOUT_MS,
    'timeout',
  );
  const maxWaitMs = validatePositiveIntOption(
    options?.maxWait,
    DEFAULT_TX_MAX_WAIT_MS,
    'maxWait',
  );

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw<
        Array<{
          org_id: string;
          user_id: string;
          role_name: string;
          statement_timeout: string;
        }>
      >`
        SELECT
          set_config('app.current_org_id', '', true) AS org_id,
          set_config('app.current_user_id', ${userId}, true) AS user_id,
          set_config('app.current_role', '', true) AS role_name,
          set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout
      `;

      const verified = await tx.$queryRaw<Array<{ userId: string | null }>>`
        SELECT "shared"."current_user_id"()::text AS "userId"
      `;

      if (verified[0]?.userId?.toLowerCase() !== userId) {
        throw new TenantContextError(
          'TENANT_CONTEXT_UNAUTHORIZED',
          'Authenticated user record is missing or inactive.',
        );
      }

      return fn(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: maxWaitMs,
      timeout: timeoutMs,
    },
  );
}
