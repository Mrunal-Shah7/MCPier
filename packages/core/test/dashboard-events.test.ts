// Sprint 4: the dashboard's event stream (GET /api/events): snapshot, every event type,
// heartbeat, a clean end on shutdown, and no value ever in a payload.
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PATHS, DASHBOARD_API_PATHS } from '@mcpier/shared';
import { fixtureScripts } from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  type TestGateway,
} from '../../../test/helpers/gateway.js';
import { openSse, type SseReader } from '../../../test/helpers/sse.js';

const SECRET = 'event-secret-value-0099-zzzz';
const PLAIN_ENV = 'plain-env-value-0042-yyyy';
const PLAIN_HEADER = 'plain-header-value-0043-xxxx';

let t: TestGateway;
let stream: SseReader;

beforeAll(async () => {
  t = await startTestGateway({
    timing: FAST_TIMING,
    config: {
      servers: [
        {
          name: 'files',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          env: { PLAIN: PLAIN_ENV, TOKEN: 'secret:event-key' },
        },
      ],
    } as never,
    extra: { eventHeartbeatMs: 200 },
  });
  await t.secrets.set('event-key', SECRET);
  await t.gateway.manager.restart('files');
  await waitForStatus(t.gateway, 'files', 'ready');
  stream = await openSse(`${t.gateway.url}${DASHBOARD_API_PATHS.events}`, {
    authorization: `Bearer ${t.token}`,
  });
});

afterAll(async () => {
  stream?.close();
  await t.cleanup();
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${t.gateway.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('event stream', () => {
  it('needs the admin token or cookie', async () => {
    const response = await fetch(`${t.gateway.url}${DASHBOARD_API_PATHS.events}`);
    expect(response.status).toBe(401);
  });

  it('starts with a snapshot of the gateway and every server', async () => {
    const snapshot = (await stream.waitFor((event) => event.event === 'snapshot')) as {
      status: { pid: number };
      servers: { name: string; status: { state: string } }[];
    };
    expect(stream.events[0]!.event).toBe('snapshot');
    expect(snapshot.status.pid).toBe(process.pid);
    expect(snapshot.servers).toEqual([
      expect.objectContaining({ name: 'files', status: expect.objectContaining({ state: 'ready' }) }),
    ]);
  });

  it('sends a heartbeat comment', async () => {
    const deadline = Date.now() + 3000;
    while (!stream.raw().includes(': heartbeat') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stream.raw()).toContain(': heartbeat\n\n');
  });

  it('a status change', async () => {
    await api('POST', API_PATHS.serverAction('files', 'stop'));
    await stream.waitFor(
      (event) =>
        event.event === 'server_status' &&
        (event.data as { name: string; status: { state: string } }).status.state === 'stopped',
    );
    await api('POST', API_PATHS.serverAction('files', 'start'));
    await stream.waitFor(
      (event) =>
        event.event === 'server_status' &&
        (event.data as { status: { state: string } }).status.state === 'ready' &&
        stream.events.filter((e) => e.event === 'server_status').length > 2,
    );
  });

  it('a tool change: counts, and the server edited', async () => {
    const before = stream.events.length;
    await api('POST', API_PATHS.toolAction('files__echo', 'disable'));
    const tools = (await stream.waitFor(
      (event) => event.event === 'server_tools' && stream.events.indexOf(event) >= before,
    )) as { name: string; tools: { total: number; enabled: number } };
    expect(tools.name).toBe('files');
    expect(tools.tools.enabled).toBe(tools.tools.total - 1);
    await stream.waitFor(
      (event) => event.event === 'server_edited' && stream.events.indexOf(event) >= before,
    );
    await api('POST', API_PATHS.toolAction('files__echo', 'enable'));
  });

  it('server added, edited and removed', async () => {
    const entry = {
      name: 'extra',
      transport: 'stdio',
      command: process.execPath,
      args: [fixtureScripts.stdio],
      enabled: false,
    };
    expect((await api('POST', API_PATHS.servers, entry)).status).toBe(201);
    await stream.waitFor(
      (event) => event.event === 'server_added' && (event.data as { name: string }).name === 'extra',
    );
    expect((await api('PATCH', API_PATHS.server('extra'), { description: 'Changed' })).status).toBe(200);
    await stream.waitFor(
      (event) => event.event === 'server_edited' && (event.data as { name: string }).name === 'extra',
    );
    expect((await api('DELETE', API_PATHS.server('extra'))).status).toBe(200);
    await stream.waitFor(
      (event) => event.event === 'server_removed' && (event.data as { name: string }).name === 'extra',
    );
  });

  it('a settings change', async () => {
    expect((await api('PATCH', DASHBOARD_API_PATHS.settings, { resultSizeLimitKb: 64 })).status).toBe(200);
    await stream.waitFor((event) => event.event === 'settings_changed');
  });

  it('secrets changed: names only', async () => {
    expect(
      (await api('PUT', API_PATHS.secret('other-key'), { value: 'another-secret-value-7777' })).status,
    ).toBe(200);
    const changed = (await stream.waitFor((event) => event.event === 'secrets_changed')) as {
      names: string[];
    };
    expect(changed.names).toEqual(['event-key', 'other-key']);
    expect(stream.raw()).not.toContain('another-secret-value-7777');
  });

  it('a config problem appearing and clearing', async () => {
    const good = readFileSync(t.home.paths.config, 'utf8');
    writeFileSync(t.home.paths.config, '{ broken');
    await t.gateway.config.reload();
    const appeared = (await stream.waitFor(
      (event) => event.event === 'config_problem' && (event.data as { problem: unknown }).problem !== null,
    )) as { problem: { problems: string[] } };
    expect(appeared.problem.problems.length).toBeGreaterThan(0);
    writeFileSync(t.home.paths.config, good);
    await t.gateway.config.reload();
    await stream.waitFor(
      (event) => event.event === 'config_problem' && (event.data as { problem: unknown }).problem === null,
    );
  });

  it('never carries a secret or a plain env or header value', async () => {
    // A server with a plain header value, added and removed, plus a restart of the env server.
    const entry = {
      name: 'remote',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { 'X-Plain': PLAIN_HEADER },
      enabled: false,
    };
    await api('POST', API_PATHS.servers, entry);
    await api('POST', API_PATHS.serverAction('files', 'restart'));
    await waitForStatus(t.gateway, 'files', 'ready');
    await api('DELETE', API_PATHS.server('remote'));
    await stream.waitFor(
      (event) => event.event === 'server_removed' && (event.data as { name: string }).name === 'remote',
    );
    for (const value of [SECRET, PLAIN_ENV, PLAIN_HEADER, t.token]) expect(stream.raw()).not.toContain(value);
  });
});

describe('shutdown', () => {
  it('ends open streams cleanly', async () => {
    const own = await startTestGateway();
    const reader = await openSse(`${own.gateway.url}${DASHBOARD_API_PATHS.events}`, {
      authorization: `Bearer ${own.token}`,
    });
    await reader.waitFor((event) => event.event === 'snapshot');
    const started = Date.now();
    await own.gateway.stop('test');
    await reader.ended;
    expect(Date.now() - started).toBeLessThan(900);
    await own.cleanup();
  });
});
