// Sprint 6, Phase 4: `mcpier autostart enable | disable | status` against the fake task layer
// (every path), the guard against the real task in a CLI process, and `start --home --port`.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeAutostart, splitWindowsArgs } from '@mcpier/core';
import { AUTOSTART_TEST_TASK_PREFIX, type AutostartStatus } from '@mcpier/shared';
import {
  autostartDisable,
  autostartEnable,
  autostartStatus,
  type AutostartDeps,
} from '../src/commands/autostart.js';
import { CliError } from '../src/errors.js';
import { CLI_ENTRY, runCli } from '../../../test/helpers/cli.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const TASK = `${AUTOSTART_TEST_TASK_PREFIX}cli`;

function deps(env: NodeJS.ProcessEnv = {}, control = new FakeAutostart()) {
  const lines: string[] = [];
  const value: AutostartDeps = {
    control,
    taskName: TASK,
    nodePath: process.execPath,
    env: { SystemRoot: 'C:\\Windows', ...env },
    out: (line) => lines.push(line),
  };
  return { deps: value, control, lines, text: () => lines.join('\n') };
}

describe('mcpier autostart (fake task layer)', () => {
  it('enable creates the task with this node.exe and CLI; enabling again replaces it', async () => {
    const run = deps();
    expect(await autostartEnable({ cliEntry: CLI_ENTRY }, run.deps)).toBe(0);
    const task = run.control.tasks.get(TASK)!;
    expect(task.command).toBe('C:\\Windows\\System32\\conhost.exe');
    expect(splitWindowsArgs(task.arguments)).toEqual(['--headless', process.execPath, CLI_ENTRY, 'start']);
    expect(run.text()).toContain(`Autostart is on: the logon task "${TASK}"`);
    expect(run.text()).not.toContain('replaces');
    expect(await autostartEnable({ cliEntry: CLI_ENTRY }, run.deps)).toBe(0);
    expect(run.text()).toContain('It replaces the task that was there.');
    expect(run.control.tasks.size).toBe(1);
  });

  it('enable keeps MCPIER_HOME and MCPIER_PORT only when set', async () => {
    const run = deps({ MCPIER_HOME: 'C:\\data\\mcpier home', MCPIER_PORT: '4799' });
    await autostartEnable({ cliEntry: CLI_ENTRY }, run.deps);
    expect(splitWindowsArgs(run.control.tasks.get(TASK)!.arguments).slice(4)).toEqual([
      '--home',
      'C:\\data\\mcpier home',
      '--port',
      '4799',
    ]);
    expect(run.text()).toContain('It keeps your MCPIER_HOME');
    expect(run.text()).toContain('It keeps your MCPIER_PORT');
  });

  it('status: off, on with existing paths, on with a missing path, and --json', async () => {
    const run = deps();
    expect(await autostartStatus({}, run.deps)).toBe(0);
    expect(run.text()).toContain('Autostart is off. Turn it on with: mcpier autostart enable');

    await autostartEnable({ cliEntry: CLI_ENTRY }, run.deps);
    run.lines.length = 0;
    await autostartStatus({}, run.deps);
    expect(run.text()).toContain(`Autostart is on (logon task "${TASK}")`);
    expect(run.text()).toContain(`node.exe: ${process.execPath} (exists)`);
    expect(run.text()).toContain(`MCPier: ${CLI_ENTRY} (exists)`);

    await autostartEnable({ cliEntry: 'C:\\moved\\away\\mcpier.js' }, run.deps);
    run.lines.length = 0;
    await autostartStatus({}, run.deps);
    expect(run.text()).toContain('MCPier: C:\\moved\\away\\mcpier.js (MISSING)');
    expect(run.text()).toContain('Run "mcpier autostart enable" to fix it');

    run.lines.length = 0;
    await autostartStatus({ json: true }, run.deps);
    const status = JSON.parse(run.text()) as AutostartStatus;
    expect(status).toMatchObject({ enabled: true, taskName: TASK });
    expect(status.paths?.find((path) => path.role === 'cli')).toEqual({
      role: 'cli',
      path: 'C:\\moved\\away\\mcpier.js',
      exists: false,
    });
  });

  it('disable removes the task, and says so when there was none', async () => {
    const run = deps();
    await autostartEnable({ cliEntry: CLI_ENTRY }, run.deps);
    expect(await autostartDisable(run.deps)).toBe(0);
    expect(run.text()).toContain(`Autostart is off: removed the logon task "${TASK}".`);
    expect(run.control.tasks.size).toBe(0);
    expect(await autostartDisable(run.deps)).toBe(0);
    expect(run.text()).toContain(`Autostart was already off: there is no logon task "${TASK}".`);
  });

  it('a Task Scheduler failure is an error, not a crash', async () => {
    const run = deps();
    run.control.failWith = new Error('Access is denied.');
    await expect(autostartStatus({}, run.deps)).rejects.toBeInstanceOf(CliError);
    await expect(autostartEnable({ cliEntry: CLI_ENTRY }, run.deps)).rejects.toThrow('Access is denied.');
  });
});

describe('the CLI under the test guard', () => {
  let home: TempHome;
  afterAll(async () => home?.cleanup());

  it('never reaches the real task: status, enable and disable all refuse', async () => {
    home = createTempHome();
    const env = home.env(await getFreePort());
    for (const args of [
      ['autostart', 'status'],
      ['autostart', 'enable'],
      ['autostart', 'disable'],
    ]) {
      const result = await runCli(args, env);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('Refusing to use the task "MCPier" under tests');
    }
  });
});

describe('mcpier start --home --port', () => {
  let home: TempHome;
  let port: number;
  afterAll(async () => {
    if (home) {
      await runCli(['stop'], home.env(port));
      await home.cleanup();
    }
  });

  it('uses the given data directory and port with neither variable set', async () => {
    home = createTempHome();
    port = await getFreePort();
    mkdirSync(join(home.dir, '..'), { recursive: true });
    const env = { ...home.env() };
    delete env.MCPIER_HOME;
    delete env.MCPIER_PORT;
    // Without --home the test guard refuses the real data directory, so this only passes
    // when the option took effect before anything resolved the data directory.
    const started = await runCli(['start', '--home', home.dir, '--port', String(port)], env);
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    expect(started.stdout).toContain(`127.0.0.1:${port}`);
    expect(existsSync(home.paths.config)).toBe(true);
    const status = await runCli(['status', '--json'], home.env(port));
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true, port, dataDir: home.dir });

    const bad = await runCli(['start', '--home', home.dir, '--port', '80'], env);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--port must be a whole number between 1024 and 65535');
  }, 60_000);
});
