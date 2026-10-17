import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAllowedDataDir, dataPaths, getPlatform, type DataPaths } from '@mcpier/core';

export interface TempHome {
  /** The MCPIER_HOME value. Does not exist yet, so first-run creation can be exercised. */
  dir: string;
  paths: DataPaths;
  /** Environment for child processes: the current env plus MCPIER_HOME (and MCPIER_PORT if given). */
  env(port?: number): NodeJS.ProcessEnv;
  /** Stops any gateway recorded in the pid file, then deletes the folder. */
  cleanup(): Promise<void>;
}

/**
 * Creates a temporary MCPIER_HOME under the system temp folder. Pass `dir` only to test the
 * safety check: a directory resolving to the real data folder is refused.
 */
export function createTempHome(options: { dir?: string } = {}): TempHome {
  const parent = options.dir ? undefined : mkdtempSync(join(tmpdir(), 'mcpier-test-'));
  const dir = options.dir ?? join(parent!, 'home');
  assertAllowedDataDir(dir);
  const paths = dataPaths(dir);
  return {
    dir,
    paths,
    env(port?: number) {
      const env: NodeJS.ProcessEnv = { ...process.env, MCPIER_HOME: dir };
      if (port !== undefined) env.MCPIER_PORT = String(port);
      else delete env.MCPIER_PORT;
      return env;
    },
    async cleanup() {
      await stopRecordedGateway(paths);
      if (parent) rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Stops the process recorded in a home's pid file, if any is still running. */
export async function stopRecordedGateway(paths: DataPaths): Promise<void> {
  let pid: number | undefined;
  try {
    pid = (JSON.parse(readFileSync(paths.pidFile, 'utf8')) as { pid?: number }).pid;
  } catch {
    return;
  }
  if (typeof pid === 'number' && pid !== process.pid) {
    await getPlatform()
      .processes.stopTree(pid)
      .catch(() => {});
  }
}
