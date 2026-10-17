// What the autostart logon task runs, and how its status is read back (D-075). Shared by the
// CLI (`mcpier autostart`, `mcpier doctor`) and the gateway (the Settings page's status).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { AUTOSTART_TASK_NAME, type AutostartResponse, type AutostartStatus } from '@mcpier/shared';
import { quoteWindowsArg, splitWindowsArgs } from './platform/index.js';
import type { AutostartAction, AutostartControl } from './platform/types.js';

/** The console host, run headless: the task starts a console program without any window. */
export function headlessHost(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'conhost.exe');
}

export interface AutostartLaunch {
  /** node.exe, absolute. */
  nodePath: string;
  /** The CLI's built entry script, absolute. */
  cliEntry: string;
  /** Carried only when the user has set MCPIER_HOME or MCPIER_PORT. */
  env?: NodeJS.ProcessEnv;
}

/**
 * `conhost.exe --headless "<node.exe>" "<mcpier.js>" start [--home "<dir>"] [--port <n>]`.
 * A task cannot set environment variables, so MCPIER_HOME and MCPIER_PORT, when the user has
 * set them, become `start`'s own options. A relative MCPIER_HOME is made absolute here: the
 * task starts in the user's profile folder, not wherever `autostart enable` ran.
 */
export function autostartAction(launch: AutostartLaunch): AutostartAction {
  const env = launch.env ?? process.env;
  const home = env.MCPIER_HOME?.trim();
  const port = env.MCPIER_PORT?.trim();
  const args = ['--headless', launch.nodePath, launch.cliEntry, 'start'];
  if (home) args.push('--home', isAbsolute(home) ? resolve(home) : resolve(process.cwd(), home));
  if (port) args.push('--port', port);
  return {
    command: headlessHost(env),
    arguments: args.map(quoteWindowsArg).join(' '),
    workingDirectory: homedir(),
  };
}

/** Reads an action back into the parts the status shows. */
export function describeAutostartAction(
  action: AutostartAction,
): Pick<AutostartStatus, 'command' | 'arguments' | 'paths'> {
  const args = splitWindowsArgs(action.arguments);
  const headless = args[0] === '--headless';
  const nodePath = headless ? args[1] : undefined;
  const cliEntry = headless ? args[2] : undefined;
  const paths: NonNullable<AutostartStatus['paths']> = [];
  if (nodePath) paths.push({ role: 'node', path: nodePath, exists: existsSync(nodePath) });
  if (cliEntry) paths.push({ role: 'cli', path: cliEntry, exists: existsSync(cliEntry) });
  return { command: action.command, arguments: action.arguments, paths };
}

/** The task's status; a failure to read it is reported, not thrown. */
export async function readAutostartStatus(
  control: AutostartControl,
  taskName: string = AUTOSTART_TASK_NAME,
): Promise<AutostartStatus> {
  try {
    const action = await control.query(taskName);
    if (!action) return { enabled: false, taskName };
    return { enabled: true, taskName, ...describeAutostartAction(action) };
  } catch (error) {
    return {
      enabled: false,
      unknown: true,
      taskName,
      detail: `Could not read the logon task: ${(error as Error)?.message ?? String(error)}`,
    };
  }
}

export const AUTOSTART_COMMANDS: AutostartResponse['commands'] = {
  enable: 'mcpier autostart enable',
  disable: 'mcpier autostart disable',
};
