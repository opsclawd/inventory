import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const includeRlsTests = process.env.VITEST_INCLUDE_RLS === '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    exclude: includeRlsTests
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, 'src/infrastructure/db/__tests__/rls.integration.test.ts'],
  },
});
