import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaClientConstructor } from '../prisma';

const VALID_POOLER_URL =
  'postgresql://erp_app_user:offline_secret_pw@127.0.0.1:6543/inventory?pgbouncer=true';
const VALID_PROJECT_QUALIFIED_URL =
  'postgres://erp_app_user.projref123:offline_secret_pw@aws-0-ca-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require';
const VALID_DIRECT_ADMIN_URL =
  'postgresql://postgres:super_secret_admin@127.0.0.1:5432/inventory';

async function loadPrismaModuleWithValidEnv() {
  process.env.DATABASE_URL = VALID_POOLER_URL;
  return import('../prisma');
}

describe('prisma runtime configuration and singleton construction', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete globalThis.__inventoryPrismaClient;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    delete globalThis.__inventoryPrismaClient;
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  describe('validateRuntimeDatabaseUrl', () => {
    it('accepts Supavisor transaction pooler URLs with erp_app_user and project-qualified username', async () => {
      const { validateRuntimeDatabaseUrl } =
        await loadPrismaModuleWithValidEnv();
      expect(validateRuntimeDatabaseUrl(VALID_POOLER_URL)).toBe(
        VALID_POOLER_URL,
      );
      expect(validateRuntimeDatabaseUrl(VALID_PROJECT_QUALIFIED_URL)).toBe(
        VALID_PROJECT_QUALIFIED_URL,
      );
    });

    it('rejects absent, malformed, wrong-protocol, and missing-db URLs with sanitized errors', async () => {
      const { validateRuntimeDatabaseUrl, PrismaRuntimeConfigError } =
        await loadPrismaModuleWithValidEnv();
      for (const badUrl of [
        undefined,
        '',
        '   ',
        'not-a-url',
        'mysql://erp_app_user:secret123@127.0.0.1:6543/inventory?pgbouncer=true',
        'postgresql://erp_app_user:secret123@127.0.0.1:6543/?pgbouncer=true',
        'postgresql://erp_app_user:secret123@127.0.0.1:6543?pgbouncer=true',
      ]) {
        let caught: unknown;
        try {
          validateRuntimeDatabaseUrl(badUrl);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(PrismaRuntimeConfigError);
        expect((caught as Error).message).not.toContain('secret123');
        expect((caught as Error).message).not.toContain('erp_app_user:');
      }
    });

    it('rejects direct port 5432, missing port, and absent or false pgbouncer parameter', async () => {
      const { validateRuntimeDatabaseUrl, PrismaRuntimeConfigError } =
        await loadPrismaModuleWithValidEnv();
      const cases = [
        'postgresql://erp_app_user:secret123@127.0.0.1:5432/inventory?pgbouncer=true',
        'postgresql://erp_app_user:secret123@127.0.0.1/inventory?pgbouncer=true',
        'postgresql://erp_app_user:secret123@127.0.0.1:6543/inventory',
        'postgresql://erp_app_user:secret123@127.0.0.1:6543/inventory?pgbouncer=false',
      ];
      for (const badUrl of cases) {
        expect(() => validateRuntimeDatabaseUrl(badUrl)).toThrowError(
          PrismaRuntimeConfigError,
        );
      }
    });

    it('rejects privileged/non-runtime usernames and redacts credentials from errors', async () => {
      const { validateRuntimeDatabaseUrl, PrismaRuntimeConfigError } =
        await loadPrismaModuleWithValidEnv();
      const badUsers = [
        'postgresql://postgres:secret_pw_999@127.0.0.1:6543/inventory?pgbouncer=true',
        'postgresql://supabase_admin:secret_pw_999@127.0.0.1:6543/inventory?pgbouncer=true',
        'postgresql://migration_owner:secret_pw_999@127.0.0.1:6543/inventory?pgbouncer=true',
        'postgresql://erp_app_user_elevated:secret_pw_999@127.0.0.1:6543/inventory?pgbouncer=true',
        'postgresql://erp_app_user.:secret_pw_999@127.0.0.1:6543/inventory?pgbouncer=true',
      ];
      for (const badUrl of badUsers) {
        let caught: unknown;
        try {
          validateRuntimeDatabaseUrl(badUrl);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(PrismaRuntimeConfigError);
        const msg = (caught as Error).message;
        expect(msg).not.toContain('secret_pw_999');
        expect(msg).not.toContain('127.0.0.1');
        expect(msg).not.toContain('postgres:');
      }
    });
  });

  describe('createPrismaClient', () => {
    it('never falls back to DIRECT_URL when DATABASE_URL is absent', async () => {
      const { createPrismaClient, PrismaRuntimeConfigError } =
        await loadPrismaModuleWithValidEnv();
      expect(() =>
        createPrismaClient({
          env: {
            DIRECT_URL: VALID_DIRECT_ADMIN_URL,
            NODE_ENV: 'test',
          },
        }),
      ).toThrowError(PrismaRuntimeConfigError);
    });

    it('passes only validated DATABASE_URL to injected ClientConstructor without calling $connect', async () => {
      const { createPrismaClient } = await loadPrismaModuleWithValidEnv();
      const receivedOptions: Array<Prisma.PrismaClientOptions | undefined> = [];
      const connectSpy = vi.fn();

      class FakePrismaClient {
        public $connect = connectSpy;

        public constructor(options?: Prisma.PrismaClientOptions) {
          receivedOptions.push(options);
        }
      }

      const client = createPrismaClient({
        env: {
          DATABASE_URL: VALID_POOLER_URL,
          DIRECT_URL: VALID_DIRECT_ADMIN_URL,
          NODE_ENV: 'development',
        },
        ClientConstructor:
          FakePrismaClient as unknown as PrismaClientConstructor,
      });

      expect(client).toBeInstanceOf(FakePrismaClient);
      expect(connectSpy).not.toHaveBeenCalled();
      expect(receivedOptions).toEqual([
        {
          datasources: {
            db: {
              url: VALID_POOLER_URL,
            },
          },
          log: ['warn', 'error'],
        },
      ]);
    });

    it('uses error-only logging outside development', async () => {
      const { createPrismaClient } = await loadPrismaModuleWithValidEnv();
      const receivedOptions: Array<Prisma.PrismaClientOptions | undefined> = [];

      class FakePrismaClient {
        public constructor(options?: Prisma.PrismaClientOptions) {
          receivedOptions.push(options);
        }
      }

      createPrismaClient({
        env: {
          DATABASE_URL: VALID_POOLER_URL,
          NODE_ENV: 'production',
        },
        ClientConstructor:
          FakePrismaClient as unknown as PrismaClientConstructor,
      });

      expect(receivedOptions[0]?.log).toEqual(['error']);
    });
  });

  describe('module singleton lifecycle', () => {
    it('fails closed on import when DATABASE_URL is missing or invalid', async () => {
      delete process.env.DATABASE_URL;
      process.env.DIRECT_URL = VALID_DIRECT_ADMIN_URL;
      vi.resetModules();

      await expect(import('../prisma')).rejects.toMatchObject({
        name: 'PrismaRuntimeConfigError',
        code: 'PRISMA_RUNTIME_CONFIG_ERROR',
      });
    });

    it('caches singleton on globalThis in development and does not cache globally in production', async () => {
      process.env.DATABASE_URL = VALID_POOLER_URL;
      process.env.NODE_ENV = 'development';
      vi.resetModules();

      const devMod1 = await import('../prisma');
      const devClient1: PrismaClient = devMod1.prisma;
      expect(globalThis.__inventoryPrismaClient).toBe(devClient1);

      vi.resetModules();
      const devMod2 = await import('../prisma');
      expect(devMod2.prisma).toBe(devClient1);

      delete globalThis.__inventoryPrismaClient;
      process.env.NODE_ENV = 'production';
      vi.resetModules();

      const prodMod = await import('../prisma');
      expect(prodMod.prisma).toBeDefined();
      expect(globalThis.__inventoryPrismaClient).toBeUndefined();
    });
  });
});
