import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureScripts } from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';

const SECRET = 'ghp_admin_api_secret_value_5678';

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  text: string;
}

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: 'stdio',
  command: process.execPath,
  args: [fixtureScripts.stdio],
  ...extra,
});

let t: TestGateway;
/** Every response body seen, to check for secret values at the end. */
const seen: string[] = [];

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await fetch(`http://127.0.0.1:${t.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  seen.push(text);
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, text };
}

const errorCode = (result: ApiResult) => (result.body as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  t = await startTestGateway({ timing: FAST_TIMING });
});

afterAll(async () => {
  await t.cleanup();
});

describe('servers', () => {
  it('lists, adds, shows, edits and removes a server', async () => {
    expect((await api('GET', '/api/servers')).body).toEqual({ servers: [] });

    const added = await api<{ server: { name: string; status: { state: string } } }>(
      'POST',
      '/api/servers',
      stdio('srv-one', { description: 'first', vendorExtra: 'kept' }),
    );
    expect(added.status).toBe(201);
    expect(added.body.server.name).toBe('srv-one');
    await waitForStatus(t.gateway, 'srv-one', 'ready');

    const list = await api<{
      servers: { name: string; status: { state: string }; tools: { total: number } }[];
    }>('GET', '/api/servers');
    expect(list.body.servers).toHaveLength(1);
    expect(list.body.servers[0]).toMatchObject({ name: 'srv-one', status: { state: 'ready' } });
    expect(list.body.servers[0]!.tools.total).toBeGreaterThan(5);

    const detail = await api<{
      config: Record<string, unknown>;
      tools: { fullName: string }[];
      server: object;
    }>('GET', '/api/servers/srv-one');
    expect(detail.body.config).toMatchObject({ name: 'srv-one', description: 'first', vendorExtra: 'kept' });
    expect(detail.body.tools.map((tool) => tool.fullName)).toContain('srv-one__echo');

    const pid = t.gateway.manager.pid('srv-one');
    const edited = await api('PATCH', '/api/servers/srv-one', { description: 'second', timeoutMs: 5000 });
    expect(edited.status).toBe(200);
    expect(t.gateway.manager.pid('srv-one')).toBe(pid);
    const stored = JSON.parse(readFileSync(t.home.paths.config, 'utf8')).servers[0];
    expect(stored).toMatchObject({ description: 'second', timeoutMs: 5000, vendorExtra: 'kept' });

    const cleared = await api('PATCH', '/api/servers/srv-one', { description: null });
    expect(cleared.status).toBe(200);
    expect(JSON.parse(readFileSync(t.home.paths.config, 'utf8')).servers[0].description).toBeUndefined();

    const removed = await api('DELETE', '/api/servers/srv-one');
    expect(removed.body).toEqual({ removed: 'srv-one' });
    expect((await api('GET', '/api/servers')).body).toEqual({ servers: [] });
  });

  it('rejects invalid input before saving anything', async () => {
    const before = readFileSync(t.home.paths.config, 'utf8');
    const bad = await api<{ error: { problems: string[] } }>('POST', '/api/servers', {
      name: 'Bad Name',
      transport: 'http',
      url: 'ftp://x',
    });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe('invalid_request');
    expect(bad.body.error.problems).toEqual([
      'name: must be a lowercase slug: letters a-z, digits and single hyphens between them, starting with a letter',
      'url: must be an http:// or https:// URL',
    ]);
    expect((await api('POST', '/api/servers', 'not json')).status).toBe(400);
    expect(readFileSync(t.home.paths.config, 'utf8')).toBe(before);
  });

  it('refuses duplicates, renames and unknown servers', async () => {
    await api('POST', '/api/servers', stdio('dup', { enabled: false }));
    const again = await api('POST', '/api/servers', stdio('dup'));
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('exists');
    expect((await api('PATCH', '/api/servers/dup', { name: 'other' })).status).toBe(400);
    const badEdit = await api<{ error: { problems: string[] } }>('PATCH', '/api/servers/dup', {
      args: 'not a list',
    });
    expect(badEdit.status).toBe(400);
    expect(badEdit.body.error.problems[0]).toMatch(/^args: /);
    for (const [method, path] of [
      ['GET', '/api/servers/ghost'],
      ['PATCH', '/api/servers/ghost'],
      ['DELETE', '/api/servers/ghost'],
      ['POST', '/api/servers/ghost/start'],
      ['GET', '/api/servers/ghost/logs'],
    ] as const) {
      const result = await api(method, path, method === 'PATCH' ? {} : undefined);
      expect(result.status, `${method} ${path}`).toBe(404);
      expect(errorCode(result)).toBe('not_found');
    }
    expect((await api('POST', '/api/servers/dup/explode')).status).toBe(404);
    await api('DELETE', '/api/servers/dup');
  });

  it('starts, stops, restarts, enables, disables and refreshes', async () => {
    await api('POST', '/api/servers', stdio('ops'));
    await waitForStatus(t.gateway, 'ops', 'ready');

    expect(
      (await api<{ server: { status: { state: string } } }>('POST', '/api/servers/ops/stop')).body.server
        .status.state,
    ).toBe('stopped');
    expect((await api('POST', '/api/servers/ops/refresh')).status).toBe(409);
    await api('POST', '/api/servers/ops/start');
    await waitForStatus(t.gateway, 'ops', 'ready');

    const pid = t.gateway.manager.pid('ops');
    await api('POST', '/api/servers/ops/restart');
    await waitUntil(
      () => t.gateway.manager.pid('ops') !== pid && t.gateway.manager.status('ops').state === 'ready',
    );

    const disabled = await api<{ server: { enabled: boolean } }>('POST', '/api/servers/ops/disable');
    expect(disabled.body.server.enabled).toBe(false);
    await waitForStatus(t.gateway, 'ops', 'stopped');
    const startDisabled = await api('POST', '/api/servers/ops/start');
    expect(startDisabled.status).toBe(409);
    expect(errorCode(startDisabled)).toBe('disabled');

    await api('POST', '/api/servers/ops/enable');
    await waitForStatus(t.gateway, 'ops', 'ready');
    expect((await api('POST', '/api/servers/ops/refresh')).status).toBe(200);
    await api('DELETE', '/api/servers/ops');
  });

  it('returns recent log lines and streams new ones', async () => {
    await api('POST', '/api/servers', stdio('logger'));
    await waitForStatus(t.gateway, 'logger', 'ready');
    const recent = await api<{ lines: string[] }>('GET', '/api/servers/logger/logs?lines=3');
    expect(recent.body.lines.length).toBeLessThanOrEqual(3);
    const all = await api<{ lines: string[] }>('GET', '/api/servers/logger/logs');
    expect(all.body.lines.some((line) => line.includes('[stderr] [fake-stdio] ready'))).toBe(true);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${t.port}/api/servers/logger/logs/stream`, {
      headers: { authorization: `Bearer ${t.token}` },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (needle: string) => {
      while (!received.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        received += decoder.decode(value);
      }
    };
    await readUntil('event: ready');
    await t.gateway.manager.callTool('logger__echo', { text: 'stream me' });
    await readUntil('[fake-stdio] call echo');
    expect(received).toMatch(/event: line\ndata: .*\[stderr\] \[fake-stdio\] call echo/);
    controller.abort();
    await api('DELETE', '/api/servers/logger');
  });
});

describe('import', () => {
  const block = {
    mcpServers: {
      'Files Server': {
        command: 'npx',
        args: ['-y', 'some-server'],
        env: { API_TOKEN: 'plain-token-12345678' },
        cwd: 'C:\\x',
      },
      remote: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer abcdefgh12345' },
      },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
    },
  };

  it('previews without saving and hides pasted credentials', async () => {
    const before = readFileSync(t.home.paths.config, 'utf8');
    const preview = await api<{
      entries: { name: string; entry: { env?: object; headers?: object }; ignored: string[] }[];
      errors: { key: string; message: string }[];
      created: string[];
    }>('POST', '/api/import', { source: block, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.created).toEqual([]);
    expect(preview.body.entries.map((entry) => entry.name)).toEqual(['files-server', 'remote']);
    expect(preview.body.entries[0]!.ignored).toEqual(['cwd']);
    expect(preview.body.entries[0]!.entry.env).toEqual({ API_TOKEN: '<hidden: 20 characters>' });
    expect(preview.body.entries[1]!.entry.headers).toEqual({ Authorization: '<hidden: 20 characters>' });
    expect(preview.body.errors).toHaveLength(1);
    expect(preview.body.errors[0]).toMatchObject({ key: 'legacy' });
    expect(preview.body.errors[0]!.message).toContain('"type": "sse"');
    expect(preview.text).not.toContain('plain-token-12345678');
    expect(readFileSync(t.home.paths.config, 'utf8')).toBe(before);
  });

  it('creates the valid entries and reports the rest, including collisions', async () => {
    const created = await api<{ created: string[]; errors: { key: string }[] }>('POST', '/api/import', {
      source: JSON.stringify({ mcpServers: { quiet: { command: 'npx', args: ['x'], disabled: true } } }),
    });
    expect(created.status).toBe(201);
    expect(created.body.created).toEqual(['quiet']);
    expect(t.gateway.manager.summary('quiet').enabled).toBe(false);
    const again = await api<{ created: string[]; errors: { key: string; message: string }[] }>(
      'POST',
      '/api/import',
      {
        source: { mcpServers: { quiet: { command: 'npx' } } },
      },
    );
    expect(again.body.created).toEqual([]);
    expect(again.body.errors[0]!.message).toContain('already exists');
    expect((await api('POST', '/api/import', { source: '{ not json' })).status).toBe(400);
    await api('DELETE', '/api/servers/quiet');
  });
});

describe('tools', () => {
  beforeAll(async () => {
    await api('POST', '/api/servers', stdio('tl', { timeoutMs: 400 }));
    await waitForStatus(t.gateway, 'tl', 'ready');
  });
  afterAll(async () => {
    await api('DELETE', '/api/servers/tl');
  });

  it('lists all tools or one server’s, with flags', async () => {
    const all = await api<{ tools: { fullName: string; enabled: boolean; available: boolean }[] }>(
      'GET',
      '/api/tools',
    );
    expect(all.body.tools.some((tool) => tool.fullName === 'tl__echo')).toBe(true);
    const one = await api<{ tools: { server: string }[] }>('GET', '/api/tools?server=tl');
    expect(one.body.tools.every((tool) => tool.server === 'tl')).toBe(true);
    expect((await api('GET', '/api/tools?server=ghost')).status).toBe(404);
  });

  it('disables and enables one tool, stored in disabledTools', async () => {
    const disabled = await api<{ tool: { enabled: boolean } }>('POST', '/api/tools/tl__fail/disable');
    expect(disabled.body.tool.enabled).toBe(false);
    const stored = JSON.parse(readFileSync(t.home.paths.config, 'utf8')).servers.find(
      (server: { name: string }) => server.name === 'tl',
    );
    expect(stored.disabledTools).toEqual(['fail']);
    const call = await api('POST', '/api/tools/tl__fail/call', { arguments: {} });
    expect(call.status).toBe(409);
    expect(errorCode(call)).toBe('disabled');
    expect(
      (await api<{ tool: { enabled: boolean } }>('POST', '/api/tools/tl__fail/enable')).body.tool.enabled,
    ).toBe(true);
    expect((await api('POST', '/api/tools/tl__nope/disable')).status).toBe(404);
    expect((await api('POST', '/api/tools/not-a-full-name/disable')).status).toBe(404);
  });

  it('calls a tool and returns the raw result with its duration', async () => {
    const call = await api<{ result: { content: { text: string }[] }; durationMs: number }>(
      'POST',
      '/api/tools/tl__echo/call',
      {
        arguments: { text: 'via the API' },
      },
    );
    expect(call.status).toBe(200);
    expect(call.body.result.content[0]!.text).toBe('via the API');
    expect(typeof call.body.durationMs).toBe('number');
    const failing = await api<{ result: { isError: boolean } }>('POST', '/api/tools/tl__fail/call', {
      arguments: {},
    });
    expect(failing.body.result.isError).toBe(true);
  });

  it('reports timeouts, unknown tools, bad bodies and servers that are not ready', async () => {
    const slow = await api('POST', '/api/tools/tl__slow/call', { arguments: { ms: 3000 } });
    expect(slow.status).toBe(504);
    expect(errorCode(slow)).toBe('timeout');
    expect((await api('POST', '/api/tools/tl__nope/call', { arguments: {} })).status).toBe(404);
    expect((await api('POST', '/api/tools/tl__echo/call', { arguments: 'x' })).status).toBe(400);
    await api('POST', '/api/servers/tl/stop');
    const notReady = await api('POST', '/api/tools/tl__echo/call', { arguments: { text: 'x' } });
    expect(notReady.status).toBe(409);
    expect(errorCode(notReady)).toBe('not_ready');
    await api('POST', '/api/servers/tl/start');
    await waitForStatus(t.gateway, 'tl', 'ready');
  });
});

describe('secrets', () => {
  it('sets, lists (last four only), refuses deleting a used secret unless forced', async () => {
    expect((await api('GET', '/api/secrets')).body).toEqual({ secrets: [], missing: [] });
    const set = await api('PUT', '/api/secrets/demo-token', { value: 'value-demo-0000-wxyz' });
    expect(set.body).toEqual({ name: 'demo-token', restarted: [] });

    await api(
      'POST',
      '/api/servers',
      stdio('uses-demo', { env: { DEMO: 'secret:demo-token', OTHER: 'secret:not-set' } }),
    );
    const list = await api('GET', '/api/secrets');
    expect(list.body).toEqual({
      secrets: [{ name: 'demo-token', last4: 'wxyz', usedBy: ['uses-demo'] }],
      missing: [{ name: 'not-set', usedBy: ['uses-demo'] }],
    });
    expect(list.text).not.toContain('value-demo-0000-wxyz');

    const refused = await api('DELETE', '/api/secrets/demo-token');
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('secret_in_use');
    const forced = await api('DELETE', '/api/secrets/demo-token?force=true');
    expect(forced.body).toEqual({ name: 'demo-token', deleted: true, restarted: ['uses-demo'] });
    expect((await api('DELETE', '/api/secrets/demo-token?force=true')).status).toBe(404);
    await api('DELETE', '/api/servers/uses-demo');
  });

  it('validates names and values', async () => {
    expect((await api('PUT', '/api/secrets/Bad_Name', { value: 'x' })).status).toBe(400);
    expect((await api('PUT', '/api/secrets/ok-name', { value: '' })).status).toBe(400);
    const tooLong = await api('PUT', '/api/secrets/ok-name', { value: 'x'.repeat(1281) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.text).toContain('at most 1280');
    expect((await api('PUT', '/api/secrets/ok-name', { nope: 1 })).status).toBe(400);
  });

  it('setting a secret restarts the servers that use it', async () => {
    await api('POST', '/api/servers', stdio('waits-for-secret', { env: { TOKEN: 'secret:late-token' } }));
    await waitForStatus(t.gateway, 'waits-for-secret', 'error');
    const set = await api('PUT', '/api/secrets/late-token', { value: 'late-value-123456' });
    expect(set.body).toEqual({ name: 'late-token', restarted: ['waits-for-secret'] });
    await waitForStatus(t.gateway, 'waits-for-secret', 'ready');
    await api('DELETE', '/api/servers/waits-for-secret');
  });
});

describe('no secret value leaks', () => {
  it('keeps the value out of every response and log after set, add, get and an env_echo call', async () => {
    await api('PUT', '/api/secrets/leak-check', { value: SECRET });
    await api('POST', '/api/servers', stdio('leaky', { env: { LEAK_CHECK: 'secret:leak-check' } }));
    await waitForStatus(t.gateway, 'leaky', 'ready');
    const detail = await api<{ config: { env: Record<string, string> } }>('GET', '/api/servers/leaky');
    expect(detail.body.config.env).toEqual({ LEAK_CHECK: 'secret:leak-check' });
    const call = await api<{ result: { content: { text: string }[] } }>(
      'POST',
      '/api/tools/leaky__env_echo/call',
      {
        arguments: { name: 'LEAK_CHECK' },
      },
    );
    expect(call.body.result.content[0]!.text).toBe('[secret:leak-check]');
    await api('GET', '/api/secrets');
    await api('GET', '/api/servers/leaky/logs');

    for (const body of seen) expect(body).not.toContain(SECRET);
    expect(readFileSync(t.home.paths.gatewayLog, 'utf8')).not.toContain(SECRET);
    for (const file of readdirSync(t.home.paths.logsDir)) {
      expect(readFileSync(join(t.home.paths.logsDir, file), 'utf8'), file).not.toContain(SECRET);
    }
    expect(readFileSync(t.home.paths.config, 'utf8')).not.toContain(SECRET);
  });
});
