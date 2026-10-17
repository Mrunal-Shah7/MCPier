import { fileURLToPath } from 'node:url';

export * from './tools.js';
export * from './extra-tools.js';
export * from './http-common.js';
export * from './http-stateless.js';
export * from './http-legacy.js';
export * from './http-oauth.js';

const built = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

/**
 * Built entry scripts, for tests that run a fixture as a separate process (`node <path>`).
 * They exist after `pnpm build`.
 */
export const fixtureScripts = {
  /** Fake stdio server. */
  stdio: built('stdio-server.js'),
  /** Stateless HTTP server; accepts `--port <n>` and prints `READY <url>`. */
  statelessHttp: built('http-stateless-main.js'),
  /** Legacy-session HTTP server; accepts `--port <n>` and prints `READY <url>`. */
  legacyHttp: built('http-legacy-main.js'),
  /** OAuth fixture (authorization server + protected MCP server); prints `READY <url> <issuer>`. */
  oauthHttp: built('http-oauth-main.js'),
};
