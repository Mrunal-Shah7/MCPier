import { existsSync } from 'node:fs';
import { AdminAuthError, AdminClient, gatewayUrl, probeHealth, readAdminToken } from '@mcpier/core';
import { CliError } from '../errors.js';
import { cliContext, formatUptime, resolvePort } from '../context.js';

/** Exit code for "not running", so scripts can tell it apart from an error. */
export const EXIT_NOT_RUNNING = 3;

export async function statusCommand(options: { json?: boolean }): Promise<number> {
  const { paths } = cliContext();
  const port = await resolvePort(paths);

  const probe = await probeHealth(port);
  if (probe.kind !== 'mcpier') {
    if (options.json) {
      console.log(JSON.stringify({ running: false, port }, null, 2));
    } else {
      console.log('MCPier is stopped.');
      if (probe.kind === 'other') console.log(`Port ${port} is in use by another program.`);
    }
    return EXIT_NOT_RUNNING;
  }

  const differentHome = new CliError(`The MCPier gateway on port ${port} uses a different data directory.`, {
    hint: 'Set MCPIER_HOME to that directory to see its status.',
  });
  if (!existsSync(paths.adminToken)) throw differentHome;
  let status;
  try {
    status = await new AdminClient(port, readAdminToken(paths.adminToken)).status();
  } catch (error) {
    if (error instanceof AdminAuthError) throw differentHome;
    throw error;
  }

  const url = `${gatewayUrl(port)}/`;
  if (options.json) {
    console.log(JSON.stringify({ running: true, url, ...status }, null, 2));
    return 0;
  }
  console.log('MCPier is running.');
  const rows: [string, string][] = [
    ['Version', status.version],
    ['PID', String(status.pid)],
    ['Uptime', formatUptime(status.uptimeSeconds)],
    ['Port', String(status.port)],
    ['Dashboard', url],
    ['Data directory', status.dataDir],
    ['Servers', serversLine(status.servers)],
  ];
  for (const [label, value] of rows) console.log(`  ${`${label}:`.padEnd(16)}${value}`);
  if (status.configProblem) {
    console.log(`Config problem: ${status.configProblem.file} is invalid; running on the last good config:`);
    for (const problem of status.configProblem.problems) console.log(`  - ${problem}`);
  }
  return 0;
}

function serversLine(servers: {
  configured: number;
  enabled: number;
  byStatus: Record<string, number>;
}): string {
  const counts = Object.entries(servers.byStatus)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
  return `${servers.configured} configured, ${servers.enabled} enabled${counts ? ` (${counts})` : ''}`;
}
