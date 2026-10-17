import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '@mcpier/shared';
import {
  effectivePort,
  ensureDataDir,
  FakePlatform,
  FORBIDDEN_HOME_ENV,
  getPlatform,
  readAdminToken,
  resolveDataDir,
  tokensMatch,
} from '../src/index.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

let home: TempHome;

/** An empty secret file left behind long ago (a crash between creating and filling it). */
function leaveStaleEmpty(path: string): void {
  writeFileSync(path, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
}

beforeEach(() => {
  home = createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

describe('ensureDataDir (first run)', () => {
  it('creates the folder, logs, default config and admin token', async () => {
    const platform = new FakePlatform();
    const result = await ensureDataDir(home.dir, platform);
    expect(result).toMatchObject({ createdDir: true, createdConfig: true, createdToken: true });
    expect(existsSync(home.paths.logsDir)).toBe(true);
    expect(JSON.parse(readFileSync(home.paths.config, 'utf8'))).toEqual(defaultConfig());
    const token = readAdminToken(home.paths.adminToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The folder is restricted on creation; the token file is restricted before it is written.
    expect(platform.files.restricted).toEqual([
      { path: home.dir, kind: 'directory' },
      { path: home.paths.adminToken, kind: 'file' },
      { path: home.paths.stateKey, kind: 'file' },
    ]);
    expect(readFileSync(home.paths.stateKey, 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reuses the existing config and token on later runs', async () => {
    const platform = new FakePlatform();
    await ensureDataDir(home.dir, platform);
    const token = readAdminToken(home.paths.adminToken);
    writeFileSync(home.paths.config, '{"settings":{"port":48100}}');

    const again = await ensureDataDir(home.dir, platform);
    expect(again).toMatchObject({ createdDir: false, createdConfig: false, createdToken: false });
    expect(readAdminToken(home.paths.adminToken)).toBe(token);
    expect(readFileSync(home.paths.config, 'utf8')).toBe('{"settings":{"port":48100}}');
  });

  it('never overwrites a corrupt config', async () => {
    const platform = new FakePlatform();
    await ensureDataDir(home.dir, platform);
    writeFileSync(home.paths.config, '{ corrupt');
    await ensureDataDir(home.dir, platform);
    expect(readFileSync(home.paths.config, 'utf8')).toBe('{ corrupt');
  });

  it('replaces an empty token file', async () => {
    const platform = new FakePlatform();
    await ensureDataDir(home.dir, platform);
    leaveStaleEmpty(home.paths.adminToken);
    const again = await ensureDataDir(home.dir, platform);
    expect(again.createdToken).toBe(true);
    expect(readAdminToken(home.paths.adminToken)).toHaveLength(43);
  });

  it('waits for a value another process is writing instead of replacing it', async () => {
    const platform = new FakePlatform();
    await ensureDataDir(home.dir, platform);
    // A fresh empty file: another process has just created it and is filling it in.
    writeFileSync(home.paths.adminToken, '');
    setTimeout(() => writeFileSync(home.paths.adminToken, 'value-from-the-other-process-0123456789abc'), 300);
    const again = await ensureDataDir(home.dir, platform);
    expect(again.createdToken).toBe(false);
    expect(readAdminToken(home.paths.adminToken)).toBe('value-from-the-other-process-0123456789abc');
  });

  it('removes the folder it created if it cannot be restricted', async () => {
    const platform = new FakePlatform();
    platform.files.failWith = new Error('simulated permission failure');
    await expect(ensureDataDir(home.dir, platform)).rejects.toThrow('simulated permission failure');
    expect(existsSync(home.dir)).toBe(false);
  });

  it('deletes the token file if it cannot be restricted', async () => {
    const platform = new FakePlatform();
    await ensureDataDir(home.dir, platform);
    leaveStaleEmpty(home.paths.adminToken);
    platform.files.failWith = new Error('simulated permission failure');
    await expect(ensureDataDir(home.dir, platform)).rejects.toThrow('simulated permission failure');
    expect(existsSync(home.paths.adminToken)).toBe(false);
  });

  it('keeps the state key across runs, and deletes it if it cannot be restricted', async () => {
    const platform = new FakePlatform();
    await ensureDataDir(home.dir, platform);
    const key = readFileSync(home.paths.stateKey, 'utf8');
    await ensureDataDir(home.dir, platform);
    expect(readFileSync(home.paths.stateKey, 'utf8')).toBe(key);

    leaveStaleEmpty(home.paths.stateKey);
    platform.files.failWith = new Error('simulated permission failure');
    await expect(ensureDataDir(home.dir, platform)).rejects.toThrow('simulated permission failure');
    expect(existsSync(home.paths.stateKey)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('token file permissions (Windows)', () => {
  it('grants access only to the current user and SYSTEM, with no inherited entries', async () => {
    await ensureDataDir(home.dir, getPlatform());
    for (const target of [home.paths.adminToken, home.paths.stateKey, home.dir]) {
      const output = execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        [target],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      const entries = output
        .replace(target, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes(':('));
      expect(entries).toHaveLength(2);
      expect(entries.some((entry) => entry.startsWith('NT AUTHORITY\\SYSTEM:'))).toBe(true);
      expect(
        entries.some((entry) => entry.toLowerCase().includes(`\\${process.env.USERNAME!.toLowerCase()}:`)),
      ).toBe(true);
      expect(entries.every((entry) => !entry.includes('(I)'))).toBe(true);
    }
  });
});

describe('resolveDataDir', () => {
  const platform = getPlatform();

  it('uses MCPIER_HOME when set', () => {
    expect(resolveDataDir(platform, { MCPIER_HOME: home.dir, LOCALAPPDATA: 'C:\\Elsewhere' })).toBe(home.dir);
  });

  it('falls back to LOCALAPPDATA\\MCPier', () => {
    expect(resolveDataDir(platform, { LOCALAPPDATA: 'C:\\SomeUser\\AppData\\Local' })).toBe(
      join('C:\\SomeUser\\AppData\\Local', 'MCPier'),
    );
  });

  it('fails clearly when neither is set', () => {
    expect(() => resolveDataDir(platform, {})).toThrow(/neither MCPIER_HOME nor LOCALAPPDATA is set/);
  });

  it('refuses the forbidden directory, in any letter case', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\Someone\\AppData\\Local',
      [FORBIDDEN_HOME_ENV]: 'C:\\Users\\Someone\\AppData\\Local\\MCPier',
    };
    expect(() => resolveDataDir(platform, env)).toThrow(/Refusing to use the real MCPier data directory/);
    expect(() =>
      resolveDataDir(platform, { ...env, MCPIER_HOME: 'c:\\users\\someone\\appdata\\local\\mcpier\\sub' }),
    ).toThrow(/Refusing/);
  });
});

describe('effectivePort', () => {
  const config = defaultConfig();

  it('uses the config port by default and MCPIER_PORT when set', () => {
    expect(effectivePort(config, {})).toBe(47800);
    expect(effectivePort(config, { MCPIER_PORT: '48123' })).toBe(48123);
  });

  it.each([['abc'], ['80'], ['70000'], ['1.5']])('rejects MCPIER_PORT=%s', (value) => {
    expect(() => effectivePort(config, { MCPIER_PORT: value })).toThrow(/MCPIER_PORT must be/);
  });
});

describe('tokensMatch', () => {
  it('compares tokens of any length safely', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('', 'abc')).toBe(false);
    expect(tokensMatch('a-much-longer-candidate-value', 'abc')).toBe(false);
  });
});
