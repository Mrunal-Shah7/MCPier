import { existsSync } from 'node:fs';
import {
  AdminAuthError,
  AdminClient,
  probeHealth,
  readAdminToken,
  readPidFile,
  removePidFile,
} from '@mcpier/core';
import { CliError } from '../errors.js';
import { cliContext, resolvePort, sleep } from '../context.js';

const STOP_TIMEOUT_MS = 10_000;

export async function stopCommand(): Promise<number> {
  const { platform, paths } = cliContext();
  const port = await resolvePort(paths);
  const recorded = readPidFile(paths.pidFile);

  const probe = await probeHealth(port);
  if (probe.kind === 'other') {
    throw new CliError(`Port ${port} is used by another program, not MCPier.`);
  }
  if (probe.kind === 'none') {
    if (recorded && !platform.processes.isAlive(recorded.pid)) removePidFile(paths.pidFile, recorded.pid);
    console.log('MCPier is not running.');
    return 0;
  }

  if (!existsSync(paths.adminToken)) {
    throw new CliError(`The MCPier gateway on port ${port} uses a different data directory.`);
  }
  const client = new AdminClient(port, readAdminToken(paths.adminToken));
  let pid = recorded?.port === port ? recorded.pid : undefined;
  try {
    pid ??= (await client.status()).pid;
    await client.shutdown();
  } catch (error) {
    if (error instanceof AdminAuthError) {
      throw new CliError(`The MCPier gateway on port ${port} uses a different data directory.`, {
        hint: 'Set MCPIER_HOME to that directory to stop it.',
      });
    }
    // A gateway that does not answer the shutdown request is stopped by force below.
    if (pid === undefined) throw error;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!platform.processes.isAlive(pid)) {
      console.log('MCPier stopped.');
      return 0;
    }
    await sleep(100);
  }

  await platform.processes.stopTree(pid);
  removePidFile(paths.pidFile, pid);
  console.log(
    `MCPier did not stop within ${STOP_TIMEOUT_MS / 1000} seconds, so a forced stop was used (process tree ${pid}).`,
  );
  return 0;
}
