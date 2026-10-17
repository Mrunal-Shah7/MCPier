// Sprint 6, Phase 5: the security review as a test. Every route the gateway registers (read
// from the app itself, so a new route cannot be missed) refuses a foreign Host and a foreign
// Origin; every /api route refuses a request without the token; the routes outside /api are a
// known, reviewed list; and dashboard pages carry the security headers.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DASHBOARD_SECURITY_HEADERS } from '../src/gateway/app.js';
import { httpRequest } from '../../../test/helpers/http.js';
import { startTestGateway, type TestGateway } from '../../../test/helpers/gateway.js';

const webRoot = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));

let t: TestGateway;
beforeAll(async () => {
  t = await startTestGateway(existsSync(join(webRoot, 'index.html')) ? { webRoot } : {});
});
afterAll(async () => t?.cleanup());

/** A concrete path for a route pattern: parameters filled in, alternations by their first choice. */
function concrete(pattern: string): string {
  return pattern
    .replace(/:id\{[^}]*\}/g, '1')
    .replace(/:[A-Za-z]+\{\(\?:([A-Za-z]+)[^}]*\}/g, '$1')
    .replace(/:fullName/g, 'srv__tool')
    .replace(/:[A-Za-z]+/g, 'x');
}

function routes() {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of t.gateway.routes) {
    if (route.path === '/*' || route.path === '*') continue; // middleware and the catch-all
    const method = route.method === 'ALL' ? 'POST' : route.method;
    seen.set(`${method} ${route.path}`, { method, path: route.path });
  }
  return [...seen.values()];
}

const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

describe('security review: every registered route', () => {
  it('the routes outside /api are exactly the reviewed public ones', () => {
    const outside = routes()
      .filter((route) => !isApi(route.path))
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(outside).toEqual(
      [
        'GET /healthz',
        'GET /oauth/callback',
        'GET /oauth/callback.css',
        'GET /auth/handoff',
        'POST /auth/signout',
        'POST /mcp',
      ].sort(),
    );
    // And there are plenty of /api routes to check.
    expect(routes().filter((route) => isApi(route.path)).length).toBeGreaterThanOrEqual(40);
  });

  it('every /api route answers 401 without the token (and with a wrong one)', async () => {
    for (const route of routes().filter((entry) => isApi(entry.path))) {
      const path = concrete(route.path);
      for (const headers of [{}, { authorization: 'Bearer not-the-token' }] as Record<string, string>[]) {
        const response = await httpRequest(t.port, {
          method: route.method,
          path,
          headers: { host: `127.0.0.1:${t.port}`, ...headers },
        });
        expect(response.status, `${route.method} ${path}`).toBe(401);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
      }
    }
  });

  it('every route refuses a foreign Host and a foreign Origin, before any route logic', async () => {
    for (const route of routes()) {
      const path = concrete(route.path);
      const host = await httpRequest(t.port, {
        method: route.method,
        path,
        headers: { host: `evil.example:${t.port}`, authorization: `Bearer ${t.token}` },
      });
      expect(host.status, `Host: ${route.method} ${path}`).toBe(403);
      expect(host.json<{ error: { code: string } }>().error.code).toBe('forbidden_host');
      const origin = await httpRequest(t.port, {
        method: route.method,
        path,
        headers: {
          host: `127.0.0.1:${t.port}`,
          origin: 'http://evil.example',
          authorization: `Bearer ${t.token}`,
        },
      });
      expect(origin.status, `Origin: ${route.method} ${path}`).toBe(403);
      expect(origin.json<{ error: { code: string } }>().error.code).toBe('forbidden_origin');
    }
  });
});

describe.runIf(existsSync(join(webRoot, 'index.html')))('security review: dashboard responses', () => {
  it.each(['/', '/calls', '/tester?tool=x__y', '/settings'])(
    '%s carries the security headers',
    async (path) => {
      const response = await httpRequest(t.port, { path, headers: { host: `127.0.0.1:${t.port}` } });
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
        expect(response.headers[name], name).toBe(value);
      }
    },
  );

  it('the scripts and styles carry them too', async () => {
    const index = await httpRequest(t.port, { path: '/', headers: { host: `127.0.0.1:${t.port}` } });
    const assets = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const response = await httpRequest(t.port, { path: asset, headers: { host: `127.0.0.1:${t.port}` } });
      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toBe(
        DASHBOARD_SECURITY_HEADERS['content-security-policy'],
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});
