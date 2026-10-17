// Sprint 6, Phase 4: the autostart logon task. Pure parts (the XML, Windows quoting, the
// action, reading the status back, the test guard) everywhere; one Windows-only test creates
// and deletes a real task under a test-only name (never the real MCPier task).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AUTOSTART_API_PATH,
  AUTOSTART_TASK_NAME,
  AUTOSTART_TEST_TASK_PREFIX,
  type AutostartResponse,
} from '@mcpier/shared';
import { startTestGateway } from '../../../test/helpers/gateway.js';
import {
  accessFromSddl,
  autostartAction,
  buildTaskXml,
  checkTaskName,
  describeAutostartAction,
  encodeTaskXml,
  FakeAutostart,
  quoteWindowsArg,
  readAutostartStatus,
  splitWindowsArgs,
} from '../src/index.js';
import { windowsAutostart } from '../src/platform/windows/task-scheduler.js';

const SID = 'S-1-5-21-111-222-333-1001';

describe('the task definition', () => {
  const action = {
    command: 'C:\\Windows\\System32\\conhost.exe',
    arguments: '--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\R&D <x>\\mcpier.js" start',
    workingDirectory: 'C:\\Users\\me',
  };
  const xml = buildTaskXml({ userSid: SID, action });

  it("starts at the user's logon, in their session, without a password or elevation", () => {
    expect(xml).toMatch(
      /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-111-222-333-1001<\/UserId>/,
    );
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).not.toMatch(/Password|S4U|HighestAvailable/);
  });

  it('is not stopped or held back on battery, has no time limit, runs at normal priority', () => {
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<Priority>5</Priority>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('escapes the action for XML and is written as UTF-16 with a byte-order mark', () => {
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(xml).toContain('&quot;C:\\R&amp;D &lt;x&gt;\\mcpier.js&quot;');
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\me</WorkingDirectory>');
    const bytes = encodeTaskXml(xml);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe(xml);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
  });
});

describe('Windows command-line quoting', () => {
  it.each([
    ['plain', 'plain'],
    ['C:\\Program Files\\nodejs\\node.exe', '"C:\\Program Files\\nodejs\\node.exe"'],
    ['C:\\My Dir\\', '"C:\\My Dir\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['', '""'],
    ['C:\\Users\\José\\mcpier.js', 'C:\\Users\\José\\mcpier.js'],
  ])('%s', (value, quoted) => {
    expect(quoteWindowsArg(value)).toBe(quoted);
    expect(splitWindowsArgs(quoted)).toEqual([value]);
  });

  it('round-trips a whole command line', () => {
    const args = [
      '--headless',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\a b\\mcpier.js',
      'start',
      '--home',
      'C:\\x y\\',
      '--port',
      '4790',
    ];
    expect(splitWindowsArgs(args.map(quoteWindowsArg).join(' '))).toEqual(args);
  });
});

describe('the action and its status', () => {
  const launch = {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliEntry: 'C:\\repo\\apps\\cli\\dist\\mcpier.js',
  };

  it('runs the headless console host with node, the CLI and start; nothing else by default', () => {
    const action = autostartAction({ ...launch, env: { SystemRoot: 'C:\\Windows' } });
    expect(action.command).toBe('C:\\Windows\\System32\\conhost.exe');
    expect(splitWindowsArgs(action.arguments)).toEqual([
      '--headless',
      launch.nodePath,
      launch.cliEntry,
      'start',
    ]);
    expect(action.workingDirectory).toBeTruthy();
  });

  it('carries MCPIER_HOME (made absolute) and MCPIER_PORT only when they are set', () => {
    const action = autostartAction({
      ...launch,
      env: { SystemRoot: 'C:\\Windows', MCPIER_HOME: 'rel\\home', MCPIER_PORT: '4790' },
    });
    const args = splitWindowsArgs(action.arguments);
    expect(args.slice(4)).toEqual(['--home', join(process.cwd(), 'rel', 'home'), '--port', '4790']);
  });

  it('reads the paths back and says whether they exist', async () => {
    const control = new FakeAutostart();
    const name = `${AUTOSTART_TEST_TASK_PREFIX}status`;
    expect(await readAutostartStatus(control, name)).toEqual({ enabled: false, taskName: name });
    await control.enable(
      name,
      autostartAction({ nodePath: process.execPath, cliEntry: 'C:\\gone\\mcpier.js' }),
    );
    const status = await readAutostartStatus(control, name);
    expect(status).toMatchObject({ enabled: true, taskName: name });
    expect(status.paths).toEqual([
      { role: 'node', path: process.execPath, exists: true },
      { role: 'cli', path: 'C:\\gone\\mcpier.js', exists: false },
    ]);
    control.failWith = new Error('scheduler down');
    expect(await readAutostartStatus(control, name)).toMatchObject({
      enabled: false,
      unknown: true,
      detail: expect.stringContaining('scheduler down'),
    });
    expect(describeAutostartAction({ command: 'x.exe', arguments: 'other args' }).paths).toEqual([]);
  });
});

describe('the test guard', () => {
  it('refuses the real task name for every operation under tests, before running anything', async () => {
    expect(process.env.MCPIER_TEST_FORBIDDEN_HOME).toBeTruthy();
    expect(() => checkTaskName(AUTOSTART_TASK_NAME)).toThrow(/Refusing to use the task "MCPier" under tests/);
    await expect(windowsAutostart.query(AUTOSTART_TASK_NAME)).rejects.toThrow(/Refusing/);
    await expect(windowsAutostart.disable(AUTOSTART_TASK_NAME)).rejects.toThrow(/Refusing/);
    await expect(
      windowsAutostart.enable(AUTOSTART_TASK_NAME, { command: 'x', arguments: '' }),
    ).rejects.toThrow(/Refusing/);
    expect(() => checkTaskName('MCPier Gateway')).toThrow(/Not a valid task name/);
    expect(() => checkTaskName('..\\evil')).toThrow(/Not a valid task name/);
    expect(() => checkTaskName(`${AUTOSTART_TEST_TASK_PREFIX}ok-1`)).not.toThrow();
    // Without the guard the real name is fine.
    expect(() => checkTaskName(AUTOSTART_TASK_NAME, {})).not.toThrow();
  });
});

describe('file access from a security descriptor', () => {
  const user = 'S-1-5-21-1-2-3-1001';
  it('restricted: only the user and SYSTEM, protected', () => {
    expect(accessFromSddl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})`, user)).toEqual({
      restricted: true,
      others: [],
      protectedFromInheritance: true,
    });
  });
  it('open to others, inheriting; deny entries do not count', () => {
    expect(
      accessFromSddl(`D:AI(A;ID;FA;;;${user})(A;ID;0x1200a9;;;BU)(A;ID;FA;;;BA)(D;;FA;;;WD)`, user),
    ).toEqual({
      restricted: false,
      others: ['BA', 'BU'],
      protectedFromInheritance: false,
    });
  });
});

const schtasks = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');

/** Test-named tasks left by an interrupted run (never the real one). */
function leftoverTestTasks(): string[] {
  const listing = execFileSync(schtasks, ['/Query', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return [...listing.matchAll(/^"\\(MCPierTest-[A-Za-z0-9-]+)"/gm)].map((match) => match[1]!);
}

describe.runIf(process.platform === 'win32')('a real logon task under a test-only name', () => {
  const name = `${AUTOSTART_TEST_TASK_PREFIX}${randomBytes(4).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'mcpier task é '));
  const cliEntry = join(dir, 'mcpier.js');
  writeFileSync(cliEntry, '// not run');

  afterAll(async () => {
    try {
      for (const leftover of leftoverTestTasks()) await windowsAutostart.disable(leftover);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates, reads back (with a non-ASCII path), replaces and deletes it; nothing is left', async () => {
    expect(name).not.toBe(AUTOSTART_TASK_NAME);
    for (const leftover of leftoverTestTasks()) await windowsAutostart.disable(leftover);
    try {
      const action = autostartAction({
        nodePath: process.execPath,
        cliEntry,
        env: { ...process.env, MCPIER_PORT: '4791' },
      });
      await windowsAutostart.enable(name, action);
      const read = await windowsAutostart.query(name);
      expect(read).toEqual(action);
      expect(describeAutostartAction(read!).paths).toEqual([
        { role: 'node', path: process.execPath, exists: true },
        { role: 'cli', path: cliEntry, exists: true },
      ]);
      // Enabling again replaces it.
      await windowsAutostart.enable(name, { ...action, arguments: `${action.arguments} --port 4792` });
      expect((await windowsAutostart.query(name))?.arguments).toContain('4792');
      expect(await windowsAutostart.disable(name)).toBe(true);
      expect(await windowsAutostart.query(name)).toBeUndefined();
      expect(await windowsAutostart.disable(name)).toBe(false);
    } finally {
      await windowsAutostart.disable(name).catch(() => false);
    }
    expect(leftoverTestTasks()).not.toContain(name);
  }, 60_000);
});

describe('GET /api/autostart', () => {
  it('answers with the status and the commands; under tests the real task is never read', async () => {
    const t = await startTestGateway();
    try {
      const response = await fetch(`${t.gateway.url}${AUTOSTART_API_PATH}`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as AutostartResponse;
      expect(body.commands).toEqual({
        enable: 'mcpier autostart enable',
        disable: 'mcpier autostart disable',
      });
      expect(body.status).toMatchObject({ enabled: false, unknown: true, taskName: AUTOSTART_TASK_NAME });
      expect(body.status.detail).toContain('Refusing to use the task "MCPier" under tests');
      expect((await fetch(`${t.gateway.url}${AUTOSTART_API_PATH}`)).status).toBe(401);
    } finally {
      await t.cleanup();
    }
  });
});
