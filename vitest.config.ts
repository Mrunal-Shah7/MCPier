import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// One configuration runs every package's tests. Workspace packages are aliased to their
// TypeScript sources so unit tests never depend on stale build output. Tests that need
// built output (the CLI integration tests, the stdio fixture) run after `pnpm build`,
// which the root `test` script does first.
//
// Two projects: `node` for the gateway, CLI and packages, and `web` for the dashboard's
// component tests in a DOM environment (jsdom).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mcpier\/shared$/, replacement: fromRoot('./packages/shared/src/index.ts') },
      { find: /^@mcpier\/core$/, replacement: fromRoot('./packages/core/src/index.ts') },
      { find: /^@mcpier\/test-fixtures$/, replacement: fromRoot('./packages/test-fixtures/src/index.ts') },
    ],
  },
  test: {
    setupFiles: [fromRoot('./test/setup.ts')],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        resolve: {
          alias: [
            { find: /^@\//, replacement: fromRoot('./apps/web/src/') },
            // As in the build: no run-time <style> injection (BUGS B-4).
            {
              find: /^react-style-singleton$/,
              replacement: fromRoot('./apps/web/src/lib/style-singleton-shim.ts'),
            },
          ],
        },
        define: { __MCPIER_VERSION__: JSON.stringify('0.0.0-test') },
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: [fromRoot('./apps/web/test/setup.ts')],
        },
      },
    ],
  },
});
