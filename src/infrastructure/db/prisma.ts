import { Prisma, PrismaClient } from '@prisma/client';

export class PrismaRuntimeConfigError extends Error {
  public readonly code = 'PRISMA_RUNTIME_CONFIG_ERROR' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'PrismaRuntimeConfigError';
  }
}

export type PrismaClientConstructor = new (
  options?: Prisma.PrismaClientOptions,
) => PrismaClient;

export interface CreatePrismaClientOptions {
  env?: Readonly<Record<string, string | undefined>>;
  ClientConstructor?: PrismaClientConstructor;
}

declare global {
  var __inventoryPrismaClient: PrismaClient | undefined;
}

function isErpAppUserRole(rawUsername: string): boolean {
  let username: string;
  try {
    username = decodeURIComponent(rawUsername);
  } catch {
    return false;
  }

  if (username === 'erp_app_user') {
    return true;
  }

  // Supavisor transaction pooling uses project-qualified usernames: erp_app_user.<project-ref>
  if (username.startsWith('erp_app_user.')) {
    const projectRef = username.slice('erp_app_user.'.length);
    return projectRef.length > 0 && !projectRef.includes(':');
  }

  return false;
}

/**
 * Validates the runtime DATABASE_URL for Supavisor transaction pooling as least-privilege
 * erp_app_user (:6543?pgbouncer=true). Never falls back to DIRECT_URL and never echoes
 * credentials or full URLs in thrown error messages.
 */
export function validateRuntimeDatabaseUrl(
  databaseUrl: string | undefined,
): string {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL is required for runtime Prisma client initialization.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL must be a syntactically valid PostgreSQL connection URL.',
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL must use the postgresql:// or postgres:// protocol.',
    );
  }

  if (!parsed.hostname || parsed.pathname.length <= 1) {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL must include both a hostname and a database name.',
    );
  }

  if (parsed.port !== '6543') {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL must target the Supavisor transaction pooler on port 6543.',
    );
  }

  if (parsed.searchParams.get('pgbouncer') !== 'true') {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL must enable Supavisor transaction pooling with pgbouncer=true.',
    );
  }

  if (!isErpAppUserRole(parsed.username)) {
    throw new PrismaRuntimeConfigError(
      'DATABASE_URL must authenticate as least-privilege runtime role erp_app_user.',
    );
  }

  return databaseUrl;
}

/**
 * Constructs a PrismaClient bound strictly to the validated runtime DATABASE_URL.
 * Does not call $connect(), execute queries, or mutate PostgreSQL session settings.
 */
export function createPrismaClient(
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  const env = options.env ?? process.env;
  const ClientConstructor = options.ClientConstructor ?? PrismaClient;
  const databaseUrl = validateRuntimeDatabaseUrl(env.DATABASE_URL);

  return new ClientConstructor({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

function getOrCreateSingletonPrismaClient(): PrismaClient {
  if (process.env.NODE_ENV !== 'production' && globalThis.__inventoryPrismaClient) {
    return globalThis.__inventoryPrismaClient;
  }

  const client = createPrismaClient();

  if (process.env.NODE_ENV !== 'production') {
    globalThis.__inventoryPrismaClient = client;
  }

  return client;
}

export const prisma: PrismaClient = getOrCreateSingletonPrismaClient();
