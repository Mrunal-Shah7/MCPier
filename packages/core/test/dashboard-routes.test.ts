// Sprint 4: the connection test (nothing saved, nothing left running, no value echoed),
// settings read and update, and the connect snippets in both modes.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DASHBOARD_API_PATHS,
  type ConnectResponse,
  type ConnectionTestResponse,
  type SettingsUpdateResponse,
} from '@mcpier/shared';
import { getPlatform } from '@mcpier/core';
import {
  fixtureScripts,
  startLegacyServer,
  startStatelessServer,
  type RunningFixture,
} from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';

const SECRET = 'conn-secret-value-0055-qqqq';
const PLAIN = 'conn-plain-value-0066-rrrr';
const PLAIN_HEADER = 'conn-header-value-0077-ssss';
const MOVED_ENV = 'moved-env-value-0088-tttt';
const MOVED_TOKEN = 'moved-header-token-0099-uuuu';

let t: TestGateway;
let stateless: RunningFixture;
let legacy: RunningFixture;
const responses: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'mcpier-conn-'));

beforeAll(async () => {
  stateless = await startStatelessServer();
  legacy = await startLegacyServer();
  t = await startTestGateway({
    timing: FAST_TIMING,
    config: {
      settings: { futureSetting: 'keep me' },
      servers: [
        { name: 'files', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
      ],
    } as never,
  });
  await t.secrets.set('conn-key', SECRET);
  await waitForStatus(t.gateway, 'files', 'ready');
});

afterAll(async () => {
  await t.gateway.stop('test end');
  const log = readFileSync(t.home.paths.gatewayLog, 'utf8');
  for (const value of [SECRET, PLAIN, PLAIN_HEADER, MOVED_ENV, MOVED_TOKEN]) {
    expect(log).not.toContain(value);
    for (const body of responses) expect(body).not.toContain(value);
  }
  await t.cleanup();
  await stateless.close();
  await legacy.close();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${t.gateway.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  responses.push(await response.clone().text());
  return response;
}

async function test(entry: Record<string, unknown>): Promise<ConnectionTestResponse> {
  const response = await api('POST', DASHBOARD_API_PATHS.connectionTest, entry);
  expect(response.status).toBe(200);
  return (await response.json()) as ConnectionTestResponse;
}

const node = (code: string, extra: Record<string, unknown> = {}) => ({
  transport: 'stdio',
  command: process.execPath,
  args: ['-e', code],
  startupTimeoutMs: 5000,
  ...extra,
});

/** Runs the stdio fixture after writing its pid to a file, so the test can check it stopped. */
function fixtureWithPid(pidFile: string) {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [
      '-e',
      "require('fs').writeFileSync(process.argv[1], String(process.pid)); import(require('url').pathToFileURL(process.argv[2]).href)",
      pidFile,
      fixtureScripts.stdio,
    ],
  };
}

describe('connection test', () => {
  it('stdio: connects, lists the tools, then stops the process; nothing is saved', async () => {
    const pidFile = join(scratch, 'ok.pid');
    const result = await test({ name: 'files', ...fixtureWithPid(pidFile) });
    expect(result.ok).toBe(true);
    expect(result.tools.count).toBeGreaterThan(5);
    expect(result.tools.names).toContain('echo');
    expect(result.protocolVersion).toBeTruthy();
    expect(result.durationMs).toBeGreaterThan(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !getPlatform().processes.isAlive(pid), 5000);
    // Nothing saved, nothing in the catalog: the name may even collide with a real server.
    expect(t.gateway.config.config.servers.map((server) => server.name)).toEqual(['files']);
  });

  it.each([['stateless'], ['legacy']])('%s HTTP server', async (kind) => {
    const url = kind === 'stateless' ? stateless.url : legacy.url;
    const result = await test({ name: `remote-${kind}`, transport: 'http', url });
    expect(result).toMatchObject({ ok: true });
    expect(result.tools.names).toContain('add');
    expect(result.protocolVersion).toBe(kind === 'stateless' ? '2026-07-28' : '2025-11-25');
  });

  it('a failing command reports the error and its last stderr lines', async () => {
    const result = await test({
      name: 'broken',
      ...node("console.error('boom line one'); console.error('boom line two'); process.exit(3)"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.stderr).toEqual(expect.arrayContaining(['boom line one', 'boom line two']));
  });

  it('an oauth entry runs discovery only: a server without OAuth metadata is reported', async () => {
    const result = await test({ name: 'oauthy', transport: 'http', url: stateless.url, auth: 'oauth' });
    expect(result).toMatchObject({ ok: false, needsAuth: true, tools: { count: 0, names: [] } });
    expect(result.discovery).toMatchObject({
      protectedResourceMetadata: false,
      authorizationServerMetadata: false,
    });
    expect(result.error).toContain('No authorization server metadata was found');
  });

  it('a missing secret reference is named', async () => {
    const result = await test({
      name: 'nosecret',
      ...node('setTimeout(() => {}, 100)', { env: { T: 'secret:not-set' } }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"not-set"');
  });

  it('never shows a plain or resolved value, in stderr or the error', async () => {
    const result = await test({
      name: 'leaky',
      ...node("console.error('leak', process.env.PLAIN_TOKEN, process.env.SECRET_TOKEN); process.exit(2)", {
        env: { PLAIN_TOKEN: PLAIN, SECRET_TOKEN: 'secret:conn-key' },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.stderr?.join('\n')).toContain('leak [value:PLAIN_TOKEN] [secret:conn-key]');
    const http = await test({
      name: 'leaky-http',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { 'X-Plain': PLAIN_HEADER, Authorization: 'Bearer secret:conn-key' },
      startupTimeoutMs: 2000,
    });
    expect(http.ok).toBe(false);
    expect(JSON.stringify([result, http])).not.toMatch(new RegExp(`${PLAIN}|${PLAIN_HEADER}|${SECRET}`));
  });

  it('one test per name at a time (409), and a timed-out process is stopped', async () => {
    const pidFile = join(scratch, 'hang.pid');
    const hang = {
      name: 'slowpoke',
      ...node(
        "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
        {
          startupTimeoutMs: 2000,
        },
      ),
    };
    (hang.args as string[]).push(pidFile);
    const first = api('POST', DASHBOARD_API_PATHS.connectionTest, hang);
    await waitUntil(() => existsSync(pidFile), 5000);
    const second = await api('POST', DASHBOARD_API_PATHS.connectionTest, hang);
    expect(second.status).toBe(409);
    const firstResult = (await (await first).json()) as ConnectionTestResponse;
    expect(firstResult.ok).toBe(false);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !getPlatform().processes.isAlive(pid), 5000);
    // Free again afterwards.
    expect(
      (await api('POST', DASHBOARD_API_PATHS.connectionTest, { ...hang, startupTimeoutMs: 1000 })).status,
    ).toBe(200);
  });

  it('an invalid entry is a 400 with the problems', async () => {
    const response = await api('POST', DASHBOARD_API_PATHS.connectionTest, {
      name: 'Bad Name',
      transport: 'stdio',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { problems: string[] } };
    expect(body.error.problems.join('\n')).toMatch(/name|command/);
  });
});

describe('move to secret', () => {
  beforeAll(async () => {
    expect(
      (
        await api('POST', '/api/servers', {
          name: 'vault',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          env: { API_KEY: MOVED_ENV, MODE: 'fast' },
          enabled: false,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api('POST', '/api/servers', {
          name: 'webby',
          transport: 'http',
          url: stateless.url,
          headers: { Authorization: `Bearer ${MOVED_TOKEN}` },
          enabled: false,
        })
      ).status,
    ).toBe(201);
  });

  const stored = (name: string) =>
    (
      JSON.parse(readFileSync(t.home.paths.config, 'utf8')) as { servers: Record<string, unknown>[] }
    ).servers.find((server) => server.name === name) as {
      env?: Record<string, string>;
      headers?: Record<string, string>;
    };

  it('moves an env value: the secret holds it, config holds the reference, the value never comes back', async () => {
    const response = await api('POST', DASHBOARD_API_PATHS.moveToSecret('vault'), {
      location: 'env',
      key: 'API_KEY',
      secretName: 'vault-api-key',
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(MOVED_ENV);
    expect(JSON.parse(text)).toMatchObject({ reference: 'secret:vault-api-key', secret: 'vault-api-key' });
    expect(await t.secrets.get('vault-api-key')).toBe(MOVED_ENV);
    expect(stored('vault').env).toEqual({ API_KEY: 'secret:vault-api-key', MODE: 'fast' });
  });

  it('moves a header token and keeps its scheme in config', async () => {
    const response = await api('POST', DASHBOARD_API_PATHS.moveToSecret('webby'), {
      location: 'header',
      key: 'Authorization',
      secretName: 'webby-token',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(MOVED_TOKEN);
    expect(await t.secrets.get('webby-token')).toBe(MOVED_TOKEN);
    expect(stored('webby').headers).toEqual({ Authorization: 'Bearer secret:webby-token' });
  });

  it('refuses a reference, an existing secret name (unless replace), and an unknown key', async () => {
    const again = await api('POST', DASHBOARD_API_PATHS.moveToSecret('vault'), {
      location: 'env',
      key: 'API_KEY',
      secretName: 'other',
    });
    expect(again.status).toBe(409);
    const taken = await api('POST', DASHBOARD_API_PATHS.moveToSecret('vault'), {
      location: 'env',
      key: 'MODE',
      secretName: 'vault-api-key',
    });
    expect(taken.status).toBe(409);
    expect(await t.secrets.get('vault-api-key')).toBe(MOVED_ENV);
    const replaced = await api('POST', DASHBOARD_API_PATHS.moveToSecret('vault'), {
      location: 'env',
      key: 'MODE',
      secretName: 'vault-mode',
      replace: true,
    });
    expect(replaced.status).toBe(200);
    expect(
      (
        await api('POST', DASHBOARD_API_PATHS.moveToSecret('vault'), {
          location: 'env',
          key: 'NOPE',
          secretName: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('POST', DASHBOARD_API_PATHS.moveToSecret('ghost'), {
          location: 'env',
          key: 'A',
          secretName: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('POST', DASHBOARD_API_PATHS.moveToSecret('vault'), {
          location: 'env',
          key: 'A',
          secretName: 'Bad Name',
        })
      ).status,
    ).toBe(400);
  });

  it('the gateway log names keys and secrets, never values', async () => {
    const log = readFileSync(t.home.paths.gatewayLog, 'utf8');
    expect(log).toContain('Value moved to a secret');
    expect(log).not.toContain(MOVED_ENV);
    expect(log).not.toContain(MOVED_TOKEN);
  });
});

describe('settings', () => {
  it('reads the settings', async () => {
    const body = (await (await api('GET', DASHBOARD_API_PATHS.settings)).json()) as {
      settings: Record<string, unknown>;
    };
    expect(body.settings).toMatchObject({ resultSizeLimitKb: 100, futureSetting: 'keep me' });
  });

  it('updates a value, keeps unknown keys, and saves the file', async () => {
    const response = await api('PATCH', DASHBOARD_API_PATHS.settings, { resultSizeLimitKb: 64 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as SettingsUpdateResponse;
    expect(body).toMatchObject({ restartRequired: false, notes: [] });
    expect(body.settings.resultSizeLimitKb).toBe(64);
    const file = JSON.parse(readFileSync(t.home.paths.config, 'utf8')) as {
      settings: Record<string, unknown>;
    };
    expect(file.settings).toMatchObject({ resultSizeLimitKb: 64, futureSetting: 'keep me' });
  });

  it('rejects invalid values with the problems, and saves nothing', async () => {
    const response = await api('PATCH', DASHBOARD_API_PATHS.settings, { resultSizeLimitKb: 0, port: 80 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { problems: string[] } };
    expect(body.error.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('settings.resultSizeLimitKb'),
        expect.stringContaining('settings.port'),
      ]),
    );
    expect(t.gateway.config.config.settings.resultSizeLimitKb).toBe(64);
    expect((await api('PATCH', DASHBOARD_API_PATHS.settings, [1])).status).toBe(400);
  });

  it('a port change is saved and says a restart is needed', async () => {
    const response = await api('PATCH', DASHBOARD_API_PATHS.settings, { port: 48999 });
    const body = (await response.json()) as SettingsUpdateResponse;
    expect(body.restartRequired).toBe(true);
    expect(body.notes[0]).toContain('restart');
    expect(t.gateway.config.config.settings.port).toBe(48999);
    // The gateway itself keeps answering on its current port.
    expect((await api('GET', DASHBOARD_API_PATHS.settings)).status).toBe(200);
  });

  it('null removes an optional setting', async () => {
    await api('PATCH', DASHBOARD_API_PATHS.settings, { cimdUrl: 'https://example.com/cimd.json' });
    expect(t.gateway.config.config.settings.cimdUrl).toBe('https://example.com/cimd.json');
    await api('PATCH', DASHBOARD_API_PATHS.settings, { cimdUrl: null });
    expect(t.gateway.config.config.settings.cimdUrl).toBeUndefined();
  });

  it('changing extraPath restarts stdio servers', async () => {
    const before = t.gateway.manager.pid('files');
    expect(before).toBeDefined();
    await api('PATCH', DASHBOARD_API_PATHS.settings, { extraPath: [scratch] });
    await waitUntil(() => {
      const pid = t.gateway.manager.pid('files');
      return pid !== undefined && pid !== before && t.gateway.manager.status('files').state === 'ready';
    }, 15_000);
  });
});

describe('connect snippets', () => {
  it('without a CLI launch, the paths are placeholders and say so', async () => {
    const body = (await (await api('GET', DASHBOARD_API_PATHS.connect)).json()) as ConnectResponse;
    expect(body).toMatchObject({ placeholder: true, port: t.port, url: `http://127.0.0.1:${t.port}/mcp` });
    expect(body.note).toContain('placeholders');
    expect(body.clients.map((client) => client.client)).toContain('claude-desktop');
  });

  it('started by the CLI, the snippets carry the real node.exe and script paths', async () => {
    const cliEntry = 'C:\\Users\\me\\MCPier\\apps\\cli\\dist\\mcpier.js';
    const own = await startTestGateway({ extra: { cliEntry } });
    try {
      const response = await fetch(`${own.gateway.url}${DASHBOARD_API_PATHS.connect}`, {
        headers: { authorization: `Bearer ${own.token}` },
      });
      const body = (await response.json()) as ConnectResponse;
      expect(body.placeholder).toBe(false);
      expect(body.note).toBeUndefined();
      const desktop = body.clients.find((client) => client.client === 'claude-desktop')!;
      expect(JSON.parse(desktop.snippet).mcpServers.mcpier).toEqual({
        command: process.execPath,
        args: [cliEntry, 'stdio'],
      });
    } finally {
      await own.cleanup();
    }
  });
});
