// The definitive orphan test: the real gateway, started in the background by `mcpier start`,
// with a stdio server launched through a .cmd file (the npx shape: cmd.exe → node).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPlatform, readAdminToken, readPidFile } from '@mcpier/core';
import { fixtureScripts } from '@mcpier/test-fixtures';
import { snapshotProcesses } from '../../../packages/core/src/platform/windows/process-table.js';
import { runCli } from '../../../test/helpers/cli.js';
import { waitUntil } from '../../../test/helpers/gateway.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const { processes } = getPlatform();
const homes: TempHome[] = [];
const leftovers: number[] = [];

afterEach(async () => {
  for (const pid of leftovers.splice(0)) await processes.stopTree(pid).catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function gatewayWithLauncherServer() {
  const home = createTempHome();
  homes.push(home);
  const port = await getFreePort();
  mkdirSync(home.dir, { recursive: true });
  const launcher = join(home.dir, 'launch-fixture.cmd');
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${fixtureScripts.stdio}" %*\r\n`);
  writeFileSync(
    home.paths.config,
    JSON.stringify({ servers: [{ name: 'launched', transport: 'stdio', command: launcher }] }),
  );
  const env = home.env(port);
  const started = await runCli(['start'], env);
  expect(started.code, started.stderr).toBe(0);
  const gatewayPid = readPidFile(home.paths.pidFile)!.pid;
  leftovers.push(gatewayPid);

  const token = readAdminToken(home.paths.adminToken);
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/servers/launched`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { server: { status: { state: string } } };
    return body.server.status.state === 'ready';
  }, 20_000);

  const log = readFileSync(join(home.paths.logsDir, 'launched.log'), 'utf8');
  const serverPid = Number(/\[fake-stdio\] ready pid=(\d+)/.exec(log)![1]);
  leftovers.push(serverPid);
  const table = await snapshotProcesses();
  const children = table.filter((info) => info.ppid === gatewayPid).map((info) => info.pid);
  leftovers.push(...children);
  return { home, env, gatewayPid, serverPid, children };
}

describe.runIf(process.platform === 'win32')('server processes never outlive the gateway', () => {
  it('a clean stop leaves no server, launcher or guard process', async () => {
    const { env, gatewayPid, serverPid, children } = await gatewayWithLauncherServer();
    // The launcher (cmd.exe) and the child guard.
    expect(children.length).toBeGreaterThanOrEqual(2);
    const stopped = await runCli(['stop'], env);
    expect(stopped.stdout).toBe('MCPier stopped.\n');
    await waitUntil(
      () => ![gatewayPid, serverPid, ...children].some((pid) => processes.isAlive(pid)),
      10_000,
    );
  });

  it('a gateway killed by force (no /T) still takes its server tree and guard down', async () => {
    const { gatewayPid, serverPid, children } = await gatewayWithLauncherServer();
    expect(processes.isAlive(serverPid)).toBe(true);
    execFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(gatewayPid), '/F'],
      {
        windowsHide: true,
      },
    );
    await waitUntil(
      () => ![gatewayPid, serverPid, ...children].some((pid) => processes.isAlive(pid)),
      15_000,
    );
    expect(processes.isAlive(serverPid)).toBe(false);
  });
});
