// Sprint 4: `mcpier open` (here with --print-url, so no browser starts): it starts the gateway
// if needed and hands out a single-use sign-in link that never carries the admin token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE_NAME, AUTH_PATHS } from '@mcpier/shared';
import { readAdminToken } from '@mcpier/core';
import { runCli } from '../../../test/helpers/cli.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

let home: TempHome;
let env: NodeJS.ProcessEnv;
let port: number;

beforeAll(async () => {
  home = createTempHome();
  port = await getFreePort();
  env = home.env(port);
});

afterAll(async () => {
  await home.cleanup();
});

describe('mcpier open --print-url', () => {
  it('starts the gateway and prints a one-time link that signs a browser in once', async () => {
    const result = await runCli(['open', '--print-url'], env);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^MCPier started \(pid \d+\)\.$/);
    const link = lines.at(-1)!;
    expect(link).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${port}${AUTH_PATHS.handoff}\\?code=[A-Za-z0-9_-]{43}$`),
    );
    expect(result.stderr).toContain('Do not share it');
    const token = readAdminToken(home.paths.adminToken);
    expect(result.stdout + result.stderr).not.toContain(token);

    const first = await fetch(link, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const cookie = first.headers.getSetCookie().find((value) => value.startsWith(`${ADMIN_COOKIE_NAME}=`));
    expect(cookie).toBeDefined();
    const again = await fetch(link, { redirect: 'manual' });
    expect(again.status).toBe(400);
  });

  it('a second run with the gateway up prints only a fresh link', async () => {
    const result = await runCli(['open', '--print-url'], env);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });
});
