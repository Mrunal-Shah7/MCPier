import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The built CLI entry script. Tests that use it need `pnpm build` first (the root test script does it). */
export const CLI_ENTRY = fileURLToPath(new URL('../../apps/cli/dist/mcpier.js', import.meta.url));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`The CLI is not built (${CLI_ENTRY} is missing). Run "pnpm build" first.`);
  }
}

/**
 * Runs the built CLI as a separate process and captures its output and exit code.
 * `input`, when given, is piped to standard input (which is then not a terminal).
 */
export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { input?: string; timeoutMs?: number; cwd?: string } | number = {},
): Promise<CliResult> {
  assertBuilt();
  const { input, timeoutMs = 60_000, cwd } = typeof options === 'number' ? { timeoutMs: options } : options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', ...(cwd ? { cwd } : {}) },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
    child.stdin?.end(input ?? '');
  });
}

/** Starts the built CLI without waiting for it (for `logs --follow`). */
export function spawnCli(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  assertBuilt();
  return spawn(process.execPath, [CLI_ENTRY, ...args], { env, windowsHide: true });
}
