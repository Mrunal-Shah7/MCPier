import { resolve } from 'node:path';
import {
  AdminAuthError,
  AdminClient,
  ConfigError,
  ensureDataDir,
  gatewayUrl,
  loadConfig,
  probeHealth,
  readAdminToken,
  fileSize,
  readLastLines,
  readPidFile,
  runGatewayProcess,
  type DataPaths,
} from '@mcpier/core';
import { CliError } from '../errors.js';
import { cliContext, resolvePort, sleep } from '../context.js';

const START_TIMEOUT_MS = 10_000;

/** Fails with the config problems if the config file is invalid. */
async function checkConfig(paths: DataPaths): Promise<void> {
  try {
    await loadConfig(paths.config);
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message);
    throw error;
  }
}

/** If this data directory's gateway is already up, describes it; throws if the port is taken. */
async function findRunningGateway(
  paths: DataPaths,
  port: number,
): Promise<{ port: number; message: string } | undefined> {
  // A gateway from this data directory may run on another port (MCPIER_PORT changed).
  const recorded = readPidFile(paths.pidFile);
  const ports = recorded && recorded.port !== port ? [port, recorded.port] : [port];
  for (const candidate of ports) {
    const probe = await probeHealth(candidate);
    if (probe.kind === 'none') continue;
    if (probe.kind === 'other') {
      if (candidate !== port) continue;
      throw new CliError(`Port ${port} is already in use by another program.`, {
        hint: `Change "settings.port" in ${paths.config}, or set the MCPIER_PORT environment variable.`,
      });
    }
    try {
      const status = await new AdminClient(candidate, readAdminToken(paths.adminToken)).status();
      return {
        port: candidate,
        message: `MCPier is already running (pid ${status.pid}) at ${gatewayUrl(candidate)}/`,
      };
    } catch (error) {
      if (error instanceof AdminAuthError && candidate === port) {
        throw new CliError(
          `Another MCPier gateway, using a different data directory, is already running on port ${port}.`,
          { hint: 'Stop it first, or set MCPIER_PORT to use a different port.' },
        );
      }
    }
  }
  return undefined;
}

/** The pid of the gateway answering on `port`, from its own status. */
async function servingPid(paths: DataPaths, port: number): Promise<number | undefined> {
  try {
    return (await new AdminClient(port, readAdminToken(paths.adminToken)).status()).pid;
  } catch {
    return undefined;
  }
}

export interface RunningGatewayInfo {
  port: number;
  /** False when it was already running. */
  started: boolean;
  /** What to tell the user, one line each. */
  lines: string[];
}

/**
 * Makes sure this data directory's gateway is running, starting it in the background if it
 * is not. Prints nothing: callers decide where the lines go (`start` uses stdout, the stdio
 * bridge stderr, since its stdout carries protocol messages only). If the gateway does not
 * come up, throws a CliError whose problems are the last lines of the gateway log.
 */
export async function ensureGatewayRunning(
  cliEntry: string,
  timeoutMs = START_TIMEOUT_MS,
): Promise<RunningGatewayInfo> {
  const { platform, paths } = cliContext();
  // First-run setup happens here too, so setup problems are reported to the caller.
  await ensureDataDir(paths.dir, platform);
  await checkConfig(paths);
  const port = await resolvePort(paths);

  const running = await findRunningGateway(paths, port);
  if (running) return { port: running.port, started: false, lines: [running.message] };

  const logOffset = fileSize(paths.gatewayLog);
  const child = await platform.processes.startDetached({
    command: process.execPath,
    args: [cliEntry, 'run-gateway'],
    // Not the caller's folder: a running process keeps its working folder from being deleted.
    cwd: paths.dir,
    // The resolved folder, so a relative MCPIER_HOME is not resolved again from that new working
    // folder (BUGS B-2: it made the gateway use <home>\<home>).
    env: process.env.MCPIER_HOME?.trim() ? { ...process.env, MCPIER_HOME: paths.dir } : process.env,
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeHealth(port, 500)).kind === 'mcpier') {
      // Name the gateway that is actually serving: when two starts race (two bridges, say),
      // the process this call spawned may be the one that refused to start.
      const serving = await servingPid(paths, port);
      const url = gatewayUrl(port);
      if (serving !== undefined && serving !== child.pid) {
        return {
          port,
          started: false,
          lines: [
            `MCPier is running (pid ${serving}) at ${url}/. It was started at the same time by another command.`,
          ],
        };
      }
      return {
        port,
        started: true,
        lines: [
          `MCPier started (pid ${serving ?? child.pid}).`,
          `Dashboard: ${url}/ (sign in with: mcpier open)`,
        ],
      };
    }
    if (!platform.processes.isAlive(child.pid)) {
      // Ours exited. If another gateway for this data directory is starting, wait for it.
      const recorded = readPidFile(paths.pidFile);
      if (!recorded || recorded.pid === child.pid || !platform.processes.isAlive(recorded.pid)) break;
    }
    await sleep(100);
  }

  // Did not come up: make sure no half-started process is left behind, then explain.
  if (platform.processes.isAlive(child.pid)) await platform.processes.stopTree(child.pid).catch(() => {});
  const lines = readLastLines(paths.gatewayLog, 20, logOffset);
  throw new CliError('The gateway did not start.', {
    problems: lines.length > 0 ? [`Last lines of ${paths.gatewayLog}:`, ...lines] : [],
    hint:
      lines.length > 0
        ? undefined
        : `Nothing was written to ${paths.gatewayLog}. Try "mcpier start --foreground" to see the error.`,
  });
}

export async function startCommand(options: { foreground?: boolean; cliEntry: string }): Promise<number> {
  if (options.foreground) return runGatewayProcess({ foreground: true, cliEntry: options.cliEntry });
  const { lines } = await ensureGatewayRunning(options.cliEntry);
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * `start --home <dir>` and `start --port <n>`: the same as MCPIER_HOME and MCPIER_PORT, set
 * before anything resolves the data directory or the port (the background gateway inherits
 * them). The autostart task passes them this way, because a task cannot set variables.
 */
export function applyStartOverrides(options: { home?: string; port?: string }): void {
  if (options.home !== undefined) {
    if (!options.home.trim()) throw new CliError('--home needs a folder.');
    process.env.MCPIER_HOME = resolve(options.home.trim());
  }
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new CliError(`--port must be a whole number between 1024 and 65535 (got "${options.port}").`);
    }
    process.env.MCPIER_PORT = String(port);
  }
}
