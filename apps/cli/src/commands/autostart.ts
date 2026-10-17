import { autostartAction, getPlatform, readAutostartStatus, type AutostartControl } from '@mcpier/core';
import { AUTOSTART_TASK_NAME, type AutostartStatus } from '@mcpier/shared';
import { CliError } from '../errors.js';

/** What the commands work with; tests pass a fake task layer and a test-only task name. */
export interface AutostartDeps {
  control: AutostartControl;
  taskName: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
}

function defaults(): AutostartDeps {
  return {
    control: getPlatform().autostart,
    taskName: AUTOSTART_TASK_NAME,
    nodePath: process.execPath,
    env: process.env,
    out: (line) => console.log(line),
  };
}

export async function autostartEnable(
  options: { cliEntry: string },
  deps: AutostartDeps = defaults(),
): Promise<number> {
  const existed = (await deps.control.query(deps.taskName)) !== undefined;
  const action = autostartAction({ nodePath: deps.nodePath, cliEntry: options.cliEntry, env: deps.env });
  await deps.control.enable(deps.taskName, action);
  deps.out(
    `Autostart is on: the logon task "${deps.taskName}" starts MCPier, hidden, when you sign in to Windows.`,
  );
  if (existed) deps.out('  It replaces the task that was there.');
  deps.out(`  Runs: ${action.command} ${action.arguments}`);
  const home = deps.env.MCPIER_HOME?.trim();
  const port = deps.env.MCPIER_PORT?.trim();
  if (home) deps.out('  It keeps your MCPIER_HOME (passed as --home).');
  if (port) deps.out('  It keeps your MCPIER_PORT (passed as --port).');
  deps.out('If you move this folder or Node.js, run "mcpier autostart enable" again.');
  return 0;
}

export async function autostartDisable(deps: AutostartDeps = defaults()): Promise<number> {
  const removed = await deps.control.disable(deps.taskName);
  deps.out(
    removed
      ? `Autostart is off: removed the logon task "${deps.taskName}".`
      : `Autostart was already off: there is no logon task "${deps.taskName}".`,
  );
  return 0;
}

export async function autostartStatus(
  options: { json?: boolean },
  deps: AutostartDeps = defaults(),
): Promise<number> {
  const status: AutostartStatus = await readAutostartStatus(deps.control, deps.taskName);
  if (status.unknown) throw new CliError(status.detail ?? 'Could not read the logon task.');
  if (options.json) {
    deps.out(JSON.stringify(status, null, 2));
    return 0;
  }
  if (!status.enabled) {
    deps.out('Autostart is off. Turn it on with: mcpier autostart enable');
    return 0;
  }
  deps.out(`Autostart is on (logon task "${deps.taskName}").`);
  deps.out(`  Runs: ${status.command} ${status.arguments}`);
  for (const path of status.paths ?? []) {
    deps.out(
      `  ${path.role === 'node' ? 'node.exe' : 'MCPier'}: ${path.path} (${path.exists ? 'exists' : 'MISSING'})`,
    );
  }
  if ((status.paths ?? []).some((path) => !path.exists)) {
    deps.out('The task points at a path that no longer exists. Run "mcpier autostart enable" to fix it.');
  }
  return 0;
}
