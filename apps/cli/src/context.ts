import { existsSync } from 'node:fs';
import {
  ConfigError,
  dataPaths,
  effectivePort,
  getPlatform,
  loadConfig,
  readPidFile,
  resolveDataDir,
  type DataPaths,
  type Platform,
} from '@mcpier/core';
import { defaultConfig } from '@mcpier/shared';

export interface CliContext {
  platform: Platform;
  paths: DataPaths;
}

/** Resolves the data directory exactly as the gateway does (MCPIER_HOME, else %LOCALAPPDATA%\MCPier). */
export function cliContext(): CliContext {
  const platform = getPlatform();
  return { platform, paths: dataPaths(resolveDataDir(platform)) };
}

/**
 * The port the gateway uses: MCPIER_PORT, else the config's port. Before the first run there
 * is no config yet, so the default applies. If the config is invalid, the port recorded in
 * the pid file is used so `status` and `stop` still work; otherwise the config error is shown.
 */
export async function resolvePort(paths: DataPaths): Promise<number> {
  if (!existsSync(paths.config)) return effectivePort(defaultConfig());
  try {
    return effectivePort(await loadConfig(paths.config));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // MCPIER_PORT (if set) still applies; effectivePort only reads the config's port without it.
    const fallback = process.env.MCPIER_PORT
      ? effectivePort(defaultConfig())
      : readPidFile(paths.pidFile)?.port;
    if (fallback === undefined) throw error;
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
