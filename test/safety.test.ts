// The test harness must never touch the user's real data directory.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDir, FORBIDDEN_HOME_ENV, getPlatform, resolveDataDir, startGateway } from '@mcpier/core';
import { runCli } from './helpers/cli.js';
import { getFreePort } from './helpers/ports.js';
import { createTempHome } from './helpers/temp-home.js';

const realHome = process.env[FORBIDDEN_HOME_ENV]!;

describe('real data directory safety check', () => {
  it('is armed by the test setup', () => {
    expect(realHome).toBeTruthy();
    expect(realHome.toLowerCase()).toBe(join(process.env.LOCALAPPDATA ?? '', 'MCPier').toLowerCase());
    expect(process.env.MCPIER_HOME).toBeUndefined();
  });

  const existedBefore = existsSync(realHome);

  it('fails a helper asked to use the real data directory', () => {
    expect(() => createTempHome({ dir: realHome })).toThrow(/Refusing to use the real MCPier data directory/);
    expect(() => createTempHome({ dir: realHome.toUpperCase() })).toThrow(/Refusing/);
    expect(() => createTempHome({ dir: join(realHome, 'logs') })).toThrow(/Refusing/);
  });

  it('fails resolution when MCPIER_HOME is missing, instead of falling back to real data', () => {
    expect(() => resolveDataDir(getPlatform())).toThrow(/Refusing/);
  });

  it('fails first-run setup and an in-process gateway pointed at the real directory', async () => {
    await expect(ensureDataDir(realHome, getPlatform())).rejects.toThrow(/Refusing/);
    await expect(
      startGateway({
        dataDir: realHome,
        platform: getPlatform(),
        env: { MCPIER_PORT: String(await getFreePort()) },
      }),
    ).rejects.toThrow(/Refusing/);
  });

  it('fails a CLI process started without MCPIER_HOME', async () => {
    const env = { ...process.env };
    delete env.MCPIER_HOME;
    const result = await runCli(['status'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing to use the real MCPier data directory');
  });

  it('left the real data directory exactly as it was', () => {
    expect(existsSync(realHome)).toBe(existedBefore);
  });
});

describe('test harness helpers', () => {
  it('creates temporary homes under the system temp folder and removes them', async () => {
    const home = createTempHome();
    expect(home.dir.toLowerCase().startsWith(realHome.toLowerCase())).toBe(false);
    expect(home.env(1234)).toMatchObject({ MCPIER_HOME: home.dir, MCPIER_PORT: '1234' });
    await ensureDataDir(home.dir, getPlatform());
    expect(existsSync(home.paths.config)).toBe(true);
    await home.cleanup();
    expect(existsSync(home.dir)).toBe(false);
  });

  it('hands out free ports above the privileged range', async () => {
    const ports = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
    for (const port of ports) expect(port).toBeGreaterThan(1023);
  });
});
