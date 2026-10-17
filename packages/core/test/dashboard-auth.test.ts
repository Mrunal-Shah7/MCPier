// Sprint 4: the sign-in hand-off (single-use 60-second codes swapped for the admin cookie),
// sign-out, and the security headers on every dashboard response.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE_NAME, AUTH_PATHS, DASHBOARD_API_PATHS, type SessionCodeResponse } from '@mcpier/shared';
import { HandoffCodes, safeNextPath } from '../src/index.js';
import { DASHBOARD_SECURITY_HEADERS } from '../src/gateway/app.js';
import { startTestGateway, type TestGateway } from '../../../test/helpers/gateway.js';

let t: TestGateway;
let clock = Date.now();
let webRoot: string;
const issued: string[] = [];

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), 'mcpier-web-'));
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>dashboard</title>');
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  t = await startTestGateway({ webRoot, extra: { now: () => clock } });
});

afterAll(async () => {
  await t.gateway.stop('test end');
  // No code (and never the token) reaches the gateway log; the hand-off route is logged by path.
  const log = readFileSync(t.home.paths.gatewayLog, 'utf8');
  expect(issued.length).toBeGreaterThan(5);
  for (const code of issued) expect(log).not.toContain(code);
  expect(log).not.toContain(t.token);
  expect(log).toContain('"path":"/auth/handoff"');
  await t.cleanup();
});

const url = (path: string) => `${t.gateway.url}${path}`;
const bearer = () => ({ authorization: `Bearer ${t.token}` });

async function newCode(): Promise<string> {
  const response = await fetch(url(DASHBOARD_API_PATHS.sessionCode), { method: 'POST', headers: bearer() });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as SessionCodeResponse;
  expect(body.expiresInSeconds).toBe(60);
  expect(body.path).toBe(`${AUTH_PATHS.handoff}?code=${body.code}`);
  issued.push(body.code);
  return body.code;
}

const handoff = (query: string) => fetch(url(`${AUTH_PATHS.handoff}${query}`), { redirect: 'manual' });

function adminCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${ADMIN_COOKIE_NAME}=`));
}

describe('hand-off codes', () => {
  it('needs the admin token to issue a code', async () => {
    const response = await fetch(url(DASHBOARD_API_PATHS.sessionCode), { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('a valid code sets an HTTP-only, SameSite=Strict cookie and redirects to the dashboard', async () => {
    const code = await newCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await handoff(`?code=${code}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = adminCookie(response)!;
    expect(cookie).toBeDefined();
    const attributes = cookie.split(';').map((part) => part.trim().toLowerCase());
    expect(attributes).toEqual(expect.arrayContaining(['httponly', 'samesite=strict', 'path=/']));
    expect(attributes).not.toContain('secure');

    // The cookie alone authorizes the admin API.
    const value = cookie.split(';')[0]!;
    const status = await fetch(url('/api/status'), { headers: { cookie: value } });
    expect(status.status).toBe(200);
  });

  it('a used, expired, unknown or malformed code gets the same page', async () => {
    const used = await newCode();
    expect((await handoff(`?code=${used}`)).status).toBe(302);
    const expired = await newCode();
    clock += 61_000;
    const pages: string[] = [];
    for (const query of [
      `?code=${used}`,
      `?code=${expired}`,
      '?code=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '?code=',
      '',
      `?code=${'x'.repeat(5000)}`,
      `?code=${used}&code=${used}`,
    ]) {
      const response = await handoff(query);
      expect(response.status).toBe(400);
      expect(adminCookie(response)).toBeUndefined();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      pages.push(await response.text());
    }
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toContain('no longer valid');
    expect(pages[0]).toContain('mcpier open');
  });

  it('several codes can be live at once, each usable once', async () => {
    const [a, b] = [await newCode(), await newCode()];
    expect((await handoff(`?code=${b}`)).status).toBe(302);
    expect((await handoff(`?code=${a}`)).status).toBe(302);
    expect((await handoff(`?code=${a}`)).status).toBe(400);
  });

  it.each([
    ['/servers/files?tab=logs', '/servers/files?tab=logs'],
    ['/tools', '/tools'],
    ['http://evil.example.com/', '/'],
    ['//evil.example.com/', '/'],
    ['/\\evil.example.com', '/'],
    ['https:evil', '/'],
    ['/api/status', '/'],
    ['/auth/signout', '/'],
    ['javascript:alert(1)', '/'],
  ])('next=%s redirects to %s', async (next, expected) => {
    const code = await newCode();
    const response = await handoff(`?code=${code}&next=${encodeURIComponent(next)}`);
    expect(response.headers.get('location')).toBe(expected);
  });

  it('sign-out clears the cookie and returns to the dashboard root', async () => {
    const response = await fetch(url(AUTH_PATHS.signout), { method: 'POST', redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = adminCookie(response)!;
    expect(cookie).toMatch(/max-age=0/i);
    expect(cookie.split(';')[0]).toBe(`${ADMIN_COOKIE_NAME}=`);
  });

  it('the hand-off routes still enforce Host and Origin', async () => {
    const code = await newCode();
    const foreign = await fetch(url(`${AUTH_PATHS.handoff}?code=${code}`), {
      redirect: 'manual',
      headers: { origin: 'http://evil.example.com' },
    });
    expect(foreign.status).toBe(403);
  });
});

describe('unit: HandoffCodes and safeNextPath', () => {
  it('expires codes after 60 seconds and forgets used ones', () => {
    let now = 1000;
    const codes = new HandoffCodes(() => now);
    const code = codes.issue();
    expect(codes.size).toBe(1);
    now += 59_999;
    expect(codes.consume(code)).toBe(true);
    expect(codes.consume(code)).toBe(false);
    const late = codes.issue();
    now += 60_000;
    expect(codes.consume(late)).toBe(false);
    expect(codes.size).toBe(0);
    expect(codes.consume(undefined)).toBe(false);
    expect(codes.consume(42)).toBe(false);
  });

  it('keeps only relative dashboard paths', () => {
    expect(safeNextPath('/servers/a#tools')).toBe('/servers/a#tools');
    expect(safeNextPath('/MCP')).toBe('/');
    expect(safeNextPath('/healthz')).toBe('/');
    expect(safeNextPath('/a\u0000b')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });
});

describe('security headers', () => {
  it.each([['/'], ['/assets/app.js'], ['/servers/some/page']])('%s carries them', async (path) => {
    const response = await fetch(url(path));
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
