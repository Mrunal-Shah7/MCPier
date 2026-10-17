import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defaultConfig } from '@mcpier/shared';
import { ensureAdminToken, ensureStateKey } from './admin-token.js';
import { saveConfig } from './config-store.js';
import type { Platform } from './platform/index.js';

/**
 * Environment variable set by the test setup to the user's real data directory. When it is
 * set, resolving to that directory (or anything inside it) throws, so no test, and no
 * gateway or CLI process a test spawns, can ever touch real data.
 */
export const FORBIDDEN_HOME_ENV = 'MCPIER_TEST_FORBIDDEN_HOME';

export interface DataPaths {
  dir: string;
  config: string;
  adminToken: string;
  /** HMAC key for signing `requestState` (input_required pass-through). */
  stateKey: string;
  pidFile: string;
  logsDir: string;
  gatewayLog: string;
  /** Encrypted OAuth records, one per server (created on first use). */
  oauthDir: string;
  /** The call and search log and the tool cache (SQLite). */
  db: string;
}

export function dataPaths(dir: string): DataPaths {
  const logsDir = join(dir, 'logs');
  return {
    dir,
    config: join(dir, 'config.json'),
    adminToken: join(dir, 'admin-token'),
    stateKey: join(dir, 'state-key'),
    pidFile: join(dir, 'gateway.pid'),
    logsDir,
    gatewayLog: join(logsDir, 'gateway.log'),
    oauthDir: join(dir, 'oauth'),
    db: join(dir, 'mcpier.db'),
  };
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const a = resolve(candidate).toLowerCase();
  const b = resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** Throws if `dir` is the forbidden (real) data directory while running under tests. */
export function assertAllowedDataDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const forbidden = env[FORBIDDEN_HOME_ENV]?.trim();
  if (forbidden && isSameOrInside(dir, forbidden)) {
    throw new Error(
      `Refusing to use the real MCPier data directory (${dir}) under tests. ` +
        'Set MCPIER_HOME to a temporary folder.',
    );
  }
}

/** The data directory: `MCPIER_HOME` if set, otherwise the platform default. */
export function resolveDataDir(platform: Platform, env: NodeJS.ProcessEnv = process.env): string {
  const dir = platform.defaultDataDir(env);
  assertAllowedDataDir(dir, env);
  return dir;
}

export interface EnsureDataDirResult {
  paths: DataPaths;
  /** The data directory itself was created by this call. */
  createdDir: boolean;
  createdConfig: boolean;
  createdToken: boolean;
}

/**
 * First-run setup, safe to call on every start: creates the data directory (restricted to
 * the current user), its `logs` folder, a default `config.json` and the admin token, each
 * only if missing. Never touches an existing config file.
 */
export async function ensureDataDir(dir: string, platform: Platform): Promise<EnsureDataDirResult> {
  assertAllowedDataDir(dir);
  const paths = dataPaths(dir);
  const createdDir = !existsSync(dir);
  if (createdDir) {
    mkdirSync(dir, { recursive: true });
    try {
      await platform.files.restrictToCurrentUser(dir, 'directory');
    } catch (error) {
      // Fail closed: do not leave behind a folder other users can write to.
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  mkdirSync(paths.logsDir, { recursive: true });

  let createdConfig = false;
  if (!existsSync(paths.config)) {
    await saveConfig(paths.config, defaultConfig());
    createdConfig = true;
  }

  const createdToken = await ensureAdminToken(paths.adminToken, platform);
  await ensureStateKey(paths.stateKey, platform);
  return { paths, createdDir, createdConfig, createdToken };
}
