import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePlatform, getPlatform } from '../src/index.js';

const isWindows = process.platform === 'win32';

async function waitFor<T>(check: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let dir: string;
beforeEach(() => {
  // A space in the path exercises argument quoting.
  dir = mkdtempSync(join(tmpdir(), 'mcpier platform '));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.runIf(isWindows)('Windows platform: processes', () => {
  const { processes } = getPlatform();

  it('reports liveness without shelling out', () => {
    expect(processes.isAlive(process.pid)).toBe(true);
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid!;
    expect(processes.isAlive(exited)).toBe(false);
  });

  it('stops a detached process together with its grandchild', async () => {
    const childScript = join(dir, 'child.mjs');
    const pidsFile = join(dir, 'pids.json');
    // The grandchild is itself detached, so it escapes the child's kill-on-close job: only
    // a real process-tree stop can end it.
    writeFileSync(
      childScript,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, windowsHide: true, stdio: 'ignore',
});
writeFileSync(process.argv[2], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`,
    );

    const started = await processes.startDetached({
      command: process.execPath,
      args: [childScript, pidsFile],
    });
    const pids = await waitFor(() =>
      existsSync(pidsFile)
        ? (JSON.parse(readFileSync(pidsFile, 'utf8')) as { child: number; grandchild: number })
        : undefined,
    );
    expect(pids.child).toBe(started.pid);
    expect(processes.isAlive(pids.child)).toBe(true);
    expect(processes.isAlive(pids.grandchild)).toBe(true);

    await processes.stopTree(pids.child);

    expect(processes.isAlive(pids.child)).toBe(false);
    await waitFor(() => (processes.isAlive(pids.grandchild) ? undefined : true), 5000);
    expect(processes.isAlive(pids.grandchild)).toBe(false);
  });

  it('starts a .cmd launcher, passing arguments with spaces', async () => {
    const launcher = join(dir, 'hello launcher.cmd');
    const marker = join(dir, 'marker.txt');
    writeFileSync(launcher, '@echo off\r\n>"%~dp0marker.txt" echo %~1\r\n');

    const started = await processes.startDetached({ command: launcher, args: ['hello world'] });
    expect(started.pid).toBeGreaterThan(0);
    const content = await waitFor(() =>
      existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined,
    );
    expect(content).toBe('hello world');
  });

  it('treats stopping an already-exited process as success', async () => {
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid!;
    await expect(processes.stopTree(exited)).resolves.toBeUndefined();
  });

  it('rejects a command that does not exist', async () => {
    await expect(processes.startDetached({ command: join(dir, 'missing.exe') })).rejects.toThrow();
  });
});

describe('fake platform', () => {
  it('tracks processes in memory', async () => {
    const platform = new FakePlatform('C:\\fake-home');
    const { pid } = await platform.processes.startDetached({ command: 'anything' });
    expect(platform.processes.isAlive(pid)).toBe(true);
    await platform.processes.stopTree(pid);
    expect(platform.processes.isAlive(pid)).toBe(false);
    expect(platform.processes.stopped).toEqual([pid]);
    expect(platform.defaultDataDir({})).toBe('C:\\fake-home');
    expect(platform.defaultDataDir({ MCPIER_HOME: 'C:\\other' })).toBe('C:\\other');
  });
});

describe('platform boundary', () => {
  it('only code inside platform/ imports the Windows implementation', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const roots = ['packages/core/src', 'packages/shared/src', 'apps/cli/src'].map((path) =>
      join(repo, path),
    );
    const platformDir = join(repo, 'packages/core/src/platform') + sep;
    const offenders: string[] = [];
    const walk = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !path.startsWith(platformDir)) {
          if (/platform\/windows/.test(readFileSync(path, 'utf8'))) offenders.push(relative(repo, path));
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
