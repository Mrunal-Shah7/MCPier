import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE_NAME } from '@mcpier/shared';
import { GatewayStartError, getPlatform, readPidFile, startGateway } from '../src/index.js';
import { startTestGateway, type TestGateway } from '../../../test/helpers/gateway.js';
import { httpRequest } from '../../../test/helpers/http.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

/** A pid that certainly belonged to a process which has exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  return result.pid!;
}

async function expectStartError(promise: Promise<unknown>): Promise<GatewayStartError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayStartError);
    return error as GatewayStartError;
  }
  throw new Error('expected the gateway to refuse to start');
}

describe('gateway HTTP surface', () => {
  let t: TestGateway;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'mcpier-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>placeholder index</title>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("asset");');
    t = await startTestGateway({ webRoot });
  });

  afterAll(async () => {
    await t.cleanup();
    rmSync(webRoot, { recursive: true, force: true });
  });

  const bearer = () => ({ authorization: `Bearer ${t.token}` });

  it('binds to 127.0.0.1 only', () => {
    expect(t.gateway.address().address).toBe('127.0.0.1');
    expect(t.gateway.address().port).toBe(t.port);
  });

  it('answers /healthz without a token, with nothing sensitive', async () => {
    const response = await httpRequest(t.port, { path: '/healthz' });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ service: 'mcpier', version: '1.1.0', status: 'ok' });
  });

  it('rejects /api/status without a token', async () => {
    const response = await httpRequest(t.port, { path: '/api/status' });
    expect(response.status).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'unauthorized', message: 'Missing or invalid admin token.' },
    });
  });

  it('rejects a wrong token with the same response as a missing one', async () => {
    const wrongHeader = await httpRequest(t.port, {
      path: '/api/status',
      headers: { authorization: 'Bearer not-the-token' },
    });
    const wrongCookie = await httpRequest(t.port, {
      path: '/api/status',
      headers: { cookie: `${ADMIN_COOKIE_NAME}=not-the-token` },
    });
    const missing = await httpRequest(t.port, { path: '/api/status' });
    for (const response of [wrongHeader, wrongCookie]) {
      expect(response.status).toBe(401);
      expect(response.body).toBe(missing.body);
    }
  });

  it('accepts the token as a bearer header', async () => {
    const response = await httpRequest(t.port, { path: '/api/status', headers: bearer() });
    expect(response.status).toBe(200);
    const status = response.json<Record<string, unknown>>();
    expect(status).toMatchObject({
      version: '1.1.0',
      pid: process.pid,
      port: t.port,
      dataDir: t.home.dir,
      servers: { configured: 0, enabled: 0 },
    });
    expect(typeof status.uptimeSeconds).toBe('number');
    expect(new Date(status.startedAt as string).getTime()).toBe(t.gateway.startedAt.getTime());
  });

  it('accepts the token as the admin cookie', async () => {
    const response = await httpRequest(t.port, {
      path: '/api/status',
      headers: { cookie: `other=1; ${ADMIN_COOKIE_NAME}=${t.token}` },
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ['evil.example.com'],
    ['evil.example.com:PORT'],
    ['127.0.0.1:1'],
    ['0.0.0.0:PORT'],
    ['[::1]:PORT'],
  ])('rejects Host: %s on every route', async (hostTemplate) => {
    const host = hostTemplate.replace('PORT', String(t.port));
    for (const path of ['/healthz', '/api/status', '/']) {
      const response = await httpRequest(t.port, { path, headers: { host, ...bearer() } });
      expect(response.status).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden_host');
    }
  });

  it('accepts Host: localhost:<port>', async () => {
    const response = await httpRequest(t.port, {
      path: '/healthz',
      headers: { host: `localhost:${t.port}` },
    });
    expect(response.status).toBe(200);
  });

  it.each([['http://evil.example.com'], ['null'], ['http://127.0.0.1:1'], ['https://127.0.0.1:PORT']])(
    'rejects Origin: %s',
    async (originTemplate) => {
      const origin = originTemplate.replace('PORT', String(t.port));
      const response = await httpRequest(t.port, { path: '/api/status', headers: { origin, ...bearer() } });
      expect(response.status).toBe(403);
      expect(response.json()).toEqual({
        error: { code: 'forbidden_origin', message: 'Cross-origin requests are not allowed.' },
      });
    },
  );

  it('accepts a same-origin Origin header and a request with no Origin', async () => {
    for (const origin of [`http://127.0.0.1:${t.port}`, `http://localhost:${t.port}`]) {
      const response = await httpRequest(t.port, { path: '/api/status', headers: { origin, ...bearer() } });
      expect(response.status).toBe(200);
    }
    const noOrigin = await httpRequest(t.port, { path: '/api/status', headers: bearer() });
    expect(noOrigin.status).toBe(200);
  });

  it('returns 404 with the standard shape for an unknown /api path, after the token check', async () => {
    const unauthenticated = await httpRequest(t.port, { path: '/api/nope' });
    expect(unauthenticated.status).toBe(401);
    for (const path of ['/api/nope', '/api', '/api/']) {
      const response = await httpRequest(t.port, { path, headers: bearer() });
      expect(response.status).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');
    }
    const wrongMethod = await httpRequest(t.port, {
      method: 'GET',
      path: '/api/shutdown',
      headers: bearer(),
    });
    expect(wrongMethod.status).toBe(404);
  });

  it('serves the built web files, with an index fallback for unknown paths', async () => {
    const index = await httpRequest(t.port, { path: '/' });
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('placeholder index');

    const asset = await httpRequest(t.port, { path: '/assets/app.js' });
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toBe('console.log("asset");');

    for (const path of [
      '/servers/github',
      '/missing.png',
      '/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/secret',
    ]) {
      const fallback = await httpRequest(t.port, { path });
      expect(fallback.status).toBe(200);
      expect(fallback.body).toContain('placeholder index');
    }
  });

  it('rejects non-GET requests outside /api', async () => {
    const response = await httpRequest(t.port, { method: 'POST', path: '/' });
    expect(response.status).toBe(405);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('method_not_allowed');
  });

  it.each([
    ['/%61pi/status'],
    ['/api/%73tatus'],
    ['//api/status'],
    ['/api%2Fstatus'],
    ['/API/status'],
    ['/api/status/'],
    ['/api/./status'],
    ['/x/../api/status'],
    ['/api/status?x=1'],
  ])('never serves admin data without a token for the path variant %s', async (path) => {
    const response = await httpRequest(t.port, { path });
    expect(response.body).not.toContain('dataDir');
    expect(response.body).not.toContain(String(process.pid));
    expect(response.body).not.toContain(t.home.dir.replaceAll('\\', '\\\\'));
  });

  it.each([['/%61pi/shutdown'], ['//api/shutdown'], ['/API/shutdown'], ['/api%2Fshutdown']])(
    'never shuts down without a token for the path variant %s',
    async (path) => {
      await httpRequest(t.port, { method: 'POST', path });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const health = await httpRequest(t.port, { path: '/healthz' });
      expect(health.status).toBe(200);
    },
  );
});

describe('gateway without a built dashboard', () => {
  it('serves a page explaining how to build it', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'mcpier-web-empty-'));
    const t = await startTestGateway({ webRoot: emptyRoot });
    try {
      for (const path of ['/', '/anything']) {
        const response = await httpRequest(t.port, { path });
        expect(response.status).toBe(200);
        expect(response.body).toContain('the dashboard has not been built');
        expect(response.body).toContain('pnpm build');
      }
    } finally {
      await t.cleanup();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('gateway lifecycle', () => {
  const homes: TempHome[] = [];
  const gateways: TestGateway[] = [];
  const newHome = () => {
    const home = createTempHome();
    homes.push(home);
    return home;
  };

  afterEach(async () => {
    for (const t of gateways.splice(0)) await t.gateway.stop('test cleanup');
    for (const home of homes.splice(0)) await home.cleanup();
  });

  it('writes a pid file on start and removes it on shutdown via the API', async () => {
    const t = await startTestGateway({ home: newHome() });
    gateways.push(t);
    expect(readPidFile(t.home.paths.pidFile)).toMatchObject({ pid: process.pid, port: t.port });

    const response = await httpRequest(t.port, {
      method: 'POST',
      path: '/api/shutdown',
      headers: { authorization: `Bearer ${t.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ status: 'shutting_down' });

    await t.gateway.stopped;
    expect(existsSync(t.home.paths.pidFile)).toBe(false);
    await expect(httpRequest(t.port, { path: '/healthz' })).rejects.toThrow();
  });

  it('refuses a second instance for the same data directory while the first runs', async () => {
    const home = newHome();
    const first = await startTestGateway({ home });
    gateways.push(first);
    const secondPort = await getFreePort();
    const error = await expectStartError(
      startGateway({ dataDir: home.dir, platform: getPlatform(), env: { MCPIER_PORT: String(secondPort) } }),
    );
    expect(error.code).toBe('already_running');
    expect(error.pid).toBe(process.pid);
    expect(error.message).toBe(
      `MCPier is already running (pid ${process.pid}) on http://127.0.0.1:${first.port}.`,
    );
    // The running gateway's pid file is untouched.
    expect(readPidFile(home.paths.pidFile)?.port).toBe(first.port);
  });

  it('replaces a stale pid file and logs that it did', async () => {
    const home = newHome();
    mkdirSync(home.dir, { recursive: true });
    const stalePid = deadPid();
    writeFileSync(home.paths.pidFile, JSON.stringify({ pid: stalePid, port: 1, startedAt: '' }));

    const t = await startTestGateway({ home });
    gateways.push(t);
    expect(readPidFile(home.paths.pidFile)?.pid).toBe(process.pid);
    const log = readFileSync(home.paths.gatewayLog, 'utf8');
    expect(log).toContain('Replacing stale pid file');
    expect(log).toContain(`"stalePid":${stalePid}`);
  });

  it('treats a pid file as stale when its process is alive but not answering', async () => {
    const home = newHome();
    mkdirSync(home.dir, { recursive: true });
    const unusedPort = await getFreePort();
    writeFileSync(home.paths.pidFile, JSON.stringify({ pid: process.pid, port: unusedPort, startedAt: '' }));
    const t = await startTestGateway({ home });
    gateways.push(t);
    expect(readPidFile(home.paths.pidFile)?.port).toBe(t.port);
  });

  it('reports a port held by another program, naming the setting and variable', async () => {
    const blocker = createServer((_req, res) => res.end('not mcpier'));
    const port = await getFreePort();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    try {
      const home = newHome();
      const error = await expectStartError(
        startGateway({ dataDir: home.dir, platform: getPlatform(), env: { MCPIER_PORT: String(port) } }),
      );
      expect(error.code).toBe('port_in_use');
      expect(error.message).toContain(`Port ${port}`);
      expect(error.message).toContain('"settings.port"');
      expect(error.message).toContain('MCPIER_PORT');
      expect(existsSync(home.paths.pidFile)).toBe(false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('reports MCPier already running when the port is held by this home gateway without a pid file', async () => {
    const home = newHome();
    const first = await startTestGateway({ home });
    gateways.push(first);
    rmSync(home.paths.pidFile);
    const error = await expectStartError(
      startGateway({ dataDir: home.dir, platform: getPlatform(), env: { MCPIER_PORT: String(first.port) } }),
    );
    expect(error.code).toBe('already_running');
    expect(error.message).toBe(
      `MCPier is already running (pid ${process.pid}) on http://127.0.0.1:${first.port}.`,
    );
  });

  it('refuses to start on a corrupt config and leaves the file untouched', async () => {
    const home = newHome();
    const first = await startTestGateway({ home });
    await first.gateway.stop();
    const corrupt = '{ "settings": { "port": 80 }, "servers": [ { "name": "Bad" } ] }';
    writeFileSync(home.paths.config, corrupt);

    const error = await expectStartError(
      startGateway({ dataDir: home.dir, platform: getPlatform(), env: { MCPIER_PORT: String(first.port) } }),
    );
    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain(home.paths.config);
    expect(error.message).toContain('settings.port: must be between 1024 and 65535');
    expect(error.message).toContain('servers[0].transport: must be "stdio" or "http"');
    expect(readFileSync(home.paths.config, 'utf8')).toBe(corrupt);
    expect(existsSync(home.paths.pidFile)).toBe(false);
    expect(readFileSync(home.paths.gatewayLog, 'utf8')).toContain(
      'settings.port: must be between 1024 and 65535',
    );
  });

  it('never writes the token to the log', async () => {
    const t = await startTestGateway({ home: newHome() });
    const auth = { authorization: `Bearer ${t.token}` };
    await httpRequest(t.port, { path: '/api/status', headers: auth });
    await httpRequest(t.port, {
      path: '/api/status',
      headers: { cookie: `${ADMIN_COOKIE_NAME}=${t.token}` },
    });
    await httpRequest(t.port, { path: `/api/status?token=${t.token}`, headers: auth });
    await httpRequest(t.port, { path: '/api/unknown', headers: auth });
    await httpRequest(t.port, { path: '/api/status', headers: { authorization: `Bearer ${t.token}x` } });
    await httpRequest(t.port, { path: '/api/status', headers: { ...auth, host: 'evil.example.com' } });
    await httpRequest(t.port, { method: 'POST', path: '/api/shutdown', headers: auth });
    await t.gateway.stopped;

    const log = readFileSync(t.home.paths.gatewayLog, 'utf8');
    expect(log).not.toContain(t.token);
    expect(log).not.toContain(t.token.slice(0, 16));
    expect(log).toContain('"path":"/api/status","status":200');
    expect(log).toContain('"path":"/api/status","status":401');
    expect(log).toContain('"path":"/api/unknown","status":404');
    expect(log).toContain('Gateway started');
    expect(log).toContain('Gateway stopped');
  });
});
