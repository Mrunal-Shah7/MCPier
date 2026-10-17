// Server process trees must not outlive the gateway, even when it is killed by force.
// Node's own kill-on-close job only covers direct children (libuv allows silent breakaway, so
// a `.cmd` launcher's node grandchild escapes it); the child guard's sentinel covers the rest.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPlatform } from '../src/index.js';
import { descendantsOf, type ProcessInfo } from '../src/platform/windows/process-table.js';

const { processes } = getPlatform();
const builtCore = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpier-orphans-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function waitFor<T>(check: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const readPid = (file: string) =>
  existsSync(file) ? Number(readFileSync(file, 'utf8')) || undefined : undefined;

/**
 * Starts a host process that, like the gateway, starts the child guard and one attached
 * server through a `.cmd` launcher that runs node (the npx shape).
 */
async function startHost(mode: 'stay' | 'release') {
  expect(existsSync(builtCore), 'run "pnpm build" first').toBe(true);
  const grandchildPidFile = join(dir, 'grandchild.pid');
  const launcher = join(dir, 'launch-server.cmd');
  writeFileSync(
    launcher,
    `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${grandchildPidFile}"\r\n`,
  );
  const host = join(dir, 'host.mjs');
  writeFileSync(
    host,
    `import { writeFileSync, existsSync } from 'node:fs';
import { getPlatform } from ${JSON.stringify(new URL(`file:///${builtCore.replace(/\\/g, '/')}`).href)};
const [launcher, launcherPidFile, sentinelPidFile, grandchildPidFile, mode] = process.argv.slice(2);
const { processes } = getPlatform();
const guard = await processes.startChildGuard();
writeFileSync(sentinelPidFile, String(guard.pid));
const startedAt = Date.now();
const child = processes.startAttached({ command: launcher, env: process.env });
guard.track(child.pid, startedAt);
writeFileSync(launcherPidFile, String(child.pid));
if (mode === 'release') {
  while (!existsSync(grandchildPidFile)) await new Promise((r) => setTimeout(r, 50));
  await processes.stopTree(child.pid);
  guard.untrack(child.pid);
  await guard.release();
  process.exit(0);
}
setInterval(() => {}, 1000);
`,
  );
  const files = {
    launcher: join(dir, 'launcher.pid'),
    sentinel: join(dir, 'sentinel.pid'),
    grandchild: grandchildPidFile,
  };
  const hostProcess = spawn(
    process.execPath,
    [host, launcher, files.launcher, files.sentinel, files.grandchild, mode],
    { stdio: 'ignore', windowsHide: true },
  );
  const pids = {
    host: hostProcess.pid!,
    sentinel: await waitFor(() => readPid(files.sentinel)),
    launcher: await waitFor(() => readPid(files.launcher)),
    grandchild: await waitFor(() => readPid(files.grandchild)),
  };
  return { pids, hostProcess };
}

describe.runIf(process.platform === 'win32')('child guard', () => {
  it('stops a .cmd launcher and its node grandchild when the gateway is killed by force (no /T)', async () => {
    const { pids } = await startHost('stay');
    try {
      expect(processes.isAlive(pids.launcher)).toBe(true);
      expect(processes.isAlive(pids.grandchild)).toBe(true);
      expect(processes.isAlive(pids.sentinel)).toBe(true);

      // TerminateProcess on the host only: no exit handler runs, nothing stops the children.
      execFileSync(taskkill, ['/PID', String(pids.host), '/F'], { windowsHide: true });

      await waitFor(
        () =>
          [pids.launcher, pids.grandchild, pids.sentinel].some((pid) => processes.isAlive(pid))
            ? undefined
            : true,
        15_000,
      );
      expect(processes.isAlive(pids.launcher)).toBe(false);
      expect(processes.isAlive(pids.grandchild)).toBe(false);
      expect(processes.isAlive(pids.sentinel)).toBe(false);
    } finally {
      for (const pid of Object.values(pids)) await processes.stopTree(pid).catch(() => {});
    }
  });

  it('ends the sentinel without stopping anything after a clean release', async () => {
    const { pids, hostProcess } = await startHost('release');
    try {
      await new Promise((resolve) => hostProcess.once('exit', resolve));
      await waitFor(() => (processes.isAlive(pids.sentinel) ? undefined : true));
      expect(processes.isAlive(pids.sentinel)).toBe(false);
      expect(processes.isAlive(pids.grandchild)).toBe(false);
    } finally {
      for (const pid of Object.values(pids)) await processes.stopTree(pid).catch(() => {});
    }
  });
});

describe('descendantsOf (sweep rules)', () => {
  const t0 = 1_000_000;
  const proc = (pid: number, ppid: number, createdMs: number): ProcessInfo => ({ pid, ppid, createdMs });

  it('finds a live root and its whole tree', () => {
    const table = [proc(10, 1, t0), proc(11, 10, t0 + 5), proc(12, 11, t0 + 9), proc(99, 1, t0)];
    expect(descendantsOf([{ pid: 10, startedAtMs: t0 }], table).sort()).toEqual([10, 11, 12]);
  });

  it('finds orphaned grandchildren of a root that already exited', () => {
    const table = [proc(11, 10, t0 + 5), proc(12, 11, t0 + 9), proc(50, 1, t0)];
    expect(descendantsOf([{ pid: 10, startedAtMs: t0 }], table).sort()).toEqual([11, 12]);
  });

  it('ignores processes older than their supposed parent (a reused parent pid)', () => {
    const table = [proc(11, 10, t0 - 60_000)];
    expect(descendantsOf([{ pid: 10, startedAtMs: t0 }], table)).toEqual([]);
  });

  it('never takes over a reused root pid or that new process’s children', () => {
    // Pid 10 now belongs to a process started long after ours; 11 is our orphan, 13 is not.
    const table = [proc(10, 1, t0 + 60_000), proc(11, 10, t0 + 5), proc(13, 10, t0 + 61_000)];
    expect(descendantsOf([{ pid: 10, startedAtMs: t0 }], table)).toEqual([11]);
  });
});
