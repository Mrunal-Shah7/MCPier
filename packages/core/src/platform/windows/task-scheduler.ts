// The autostart logon task (D-075), created from an XML definition with schtasks.exe and read
// back with PowerShell's Get-ScheduledTask (UTF-8 output, so non-ASCII paths survive; schtasks
// writes the console code page). Every tool is called with an argument list, never a shell.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AUTOSTART_TASK_NAME, AUTOSTART_TEST_TASK_PREFIX } from '@mcpier/shared';
import type { AutostartAction, AutostartControl } from '../types.js';

const execFileAsync = promisify(execFile);

function systemTool(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(systemRoot, 'System32', ...parts);
}

/** The variable the test setup sets (see `data-dir.ts`); here it guards the real task. */
const FORBIDDEN_HOME_ENV = 'MCPIER_TEST_FORBIDDEN_HOME';

/**
 * Task names are plain (letters, digits, hyphens). Under tests only `MCPierTest-…` names are
 * allowed, for every operation, so no test can create, delete or even read the real task.
 */
export function checkTaskName(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) throw new Error(`Not a valid task name: ${name}`);
  if (env[FORBIDDEN_HOME_ENV] && !name.startsWith(AUTOSTART_TEST_TASK_PREFIX)) {
    throw new Error(
      `Refusing to use the task "${name}" under tests. Use a name starting with ${AUTOSTART_TEST_TASK_PREFIX}.`,
    );
  }
}

/** The real task name, refused under tests by `checkTaskName`. */
export const REAL_TASK_NAME = AUTOSTART_TASK_NAME;

/**
 * Quotes one argument for a Windows command line (the rules `CommandLineToArgvW` and the C
 * runtime parse): backslashes are literal except before a quote, so a trailing backslash in a
 * quoted path is doubled (`"C:\dir\\"`), never left to escape the closing quote.
 */
export function quoteWindowsArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes++;
    } else if (char === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + char;
      backslashes = 0;
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** Splits a Windows command line back into arguments (the inverse of `quoteWindowsArg`). */
export function splitWindowsArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\') {
      let count = 0;
      while (line[i] === '\\') {
        count++;
        i++;
      }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else {
          inQuotes = !inQuotes;
        }
        started = true;
      } else {
        current += '\\'.repeat(count);
        i--;
        started = true;
      }
    } else if (char === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (/\s/.test(char) && !inQuotes) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The task definition (Task Scheduler schema 1.2): at the user's logon, in their interactive
 * session with their own token (no stored password, no elevation), not stopped or held back on
 * battery power, no time limit, normal priority.
 */
export function buildTaskXml(options: {
  userSid: string;
  action: AutostartAction;
  description?: string;
}): string {
  const { userSid, action } = options;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(options.description ?? 'Starts the MCPier gateway when you sign in (mcpier autostart).')}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlEscape(userSid)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(userSid)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(action.command)}</Command>`,
    `      <Arguments>${xmlEscape(action.arguments)}</Arguments>`,
    ...(action.workingDirectory
      ? [`      <WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory>`]
      : []),
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** schtasks.exe reads an XML definition as UTF-16 with a byte-order mark. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  });
  const match = /"(S-1-[0-9-]+)"/.exec(stdout);
  if (!match?.[1]) throw new Error('Could not determine the current Windows user SID');
  return match[1];
}

/** Whether the task exists (`schtasks /Query` exits 0 only then). */
async function exists(name: string): Promise<boolean> {
  try {
    await execFileAsync(systemTool('schtasks.exe'), ['/Query', '/TN', name], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The script that reads the task back; the name arrives in an environment variable, never in the script text. */
const QUERY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$task = Get-ScheduledTask -TaskPath "\\" -TaskName $env:MCPIER_TASK_NAME -ErrorAction SilentlyContinue',
  'if ($null -eq $task) { "null"; exit 0 }',
  '$action = @($task.Actions)[0]',
  '[pscustomobject]@{ command = $action.Execute; arguments = $action.Arguments; workingDirectory = $action.WorkingDirectory } | ConvertTo-Json -Compress',
].join('; ');

export const windowsAutostart: AutostartControl = {
  async enable(name: string, action: AutostartAction): Promise<void> {
    checkTaskName(name);
    const dir = mkdtempSync(join(tmpdir(), 'mcpier-task-'));
    const file = join(dir, 'task.xml');
    try {
      writeFileSync(file, encodeTaskXml(buildTaskXml({ userSid: await currentUserSid(), action })));
      await execFileAsync(systemTool('schtasks.exe'), ['/Create', '/TN', name, '/XML', file, '/F'], {
        windowsHide: true,
      });
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`Could not create the logon task "${name}": ${detail}`, { cause: error });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async disable(name: string): Promise<boolean> {
    checkTaskName(name);
    if (!(await exists(name))) return false;
    try {
      await execFileAsync(systemTool('schtasks.exe'), ['/Delete', '/TN', name, '/F'], { windowsHide: true });
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`Could not remove the logon task "${name}": ${detail}`, { cause: error });
    }
    return true;
  },

  async query(name: string): Promise<AutostartAction | undefined> {
    checkTaskName(name);
    const { stdout } = await execFileAsync(
      systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', QUERY_SCRIPT],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env, MCPIER_TASK_NAME: name } },
    );
    const parsed = JSON.parse(stdout.trim() || 'null') as {
      command?: string | null;
      arguments?: string | null;
      workingDirectory?: string | null;
    } | null;
    if (!parsed) return undefined;
    return {
      command: parsed.command ?? '',
      arguments: parsed.arguments ?? '',
      ...(parsed.workingDirectory ? { workingDirectory: parsed.workingDirectory } : {}),
    };
  },
};
