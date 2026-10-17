// Sprint 6, Phase 1, through a running gateway: what reaches mcpier.db (redacted bodies, no
// MCPier state or answers), the fallback when the database cannot be used, the flush on
// shutdown, and the tool catalog cache across restarts.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MODERN_PROTOCOL_VERSION, openDatabaseReadOnly } from '@mcpier/core';
import type { ToolSearchResponse, StatusResponse } from '@mcpier/shared';
import { fixtureScripts, startStatelessServer, type RunningFixture } from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';
import { OAUTH_SERVER, startOAuthWorld, type OAuthWorld } from '../../../test/helpers/oauth.js';

const SECRET = 'call-log-secret-value-6161';
const ANSWER_MARK = 'elicitation-answer-mark-6262';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Everything SQLite has on disk for the database (main file and WAL), as text. */
function dbBytes(file: string): string {
  return [file, `${file}-wal`]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('\n');
}

async function api<T>(t: TestGateway, method: string, path: string, body?: unknown) {
  const response = await fetch(`${t.gateway.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function modernClient(t: TestGateway, answer?: Record<string, unknown>) {
  const client = new Client(
    { name: 'call-log-test', version: '6.0' },
    {
      capabilities: answer ? { elicitation: { form: {} } } : {},
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } as never,
    },
  );
  if (answer) {
    client.setRequestHandler(
      'elicitation/create',
      async () => ({ action: 'accept', content: answer }) as never,
    );
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.gateway.url}/mcp`)));
  cleanups.push(() => client.close().catch(() => {}));
  return client;
}

describe('bodies in mcpier.db', () => {
  it('a secret in arguments or results is stored as its reference, never as the value', async () => {
    const t = await startTestGateway({
      timing: FAST_TIMING,
      config: {
        servers: [
          {
            name: 'local',
            transport: 'stdio',
            command: process.execPath,
            args: [fixtureScripts.stdio],
            env: { LOG_SECRET: 'secret:log-key' },
          },
        ],
      } as never,
    });
    cleanups.push(() => t.cleanup());
    await t.secrets.set('log-key', SECRET);
    await t.gateway.manager.restart('local');
    await waitForStatus(t.gateway, 'local', 'ready');
    t.gateway.meta.refresh();

    const client = await modernClient(t);
    const echoed = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'local__env_echo', arguments: { name: 'LOG_SECRET' } },
    });
    expect(JSON.stringify(echoed)).not.toContain(SECRET);
    await client.callTool({
      name: 'call_tool',
      arguments: { name: 'local__echo', arguments: { text: `pasted ${SECRET} here` } },
    });
    // The admin call route records too (era admin).
    await api(t, 'POST', '/api/tools/local__echo/call', { arguments: { text: SECRET } });

    const callLog = t.gateway.callLog!;
    await waitUntil(() => callLog.listCalls().calls.length >= 3);
    const calls = callLog.listCalls().calls;
    const byTool = (tool: string, era: string) => calls.find((c) => c.tool === tool && c.era === era)!;
    expect(callLog.getCall(byTool('local__env_echo', 'modern').id)!.result!.text).toContain(
      '[secret:log-key]',
    );
    expect(callLog.getCall(byTool('local__echo', 'modern').id)!.arguments!.text).toContain(
      'pasted [secret:log-key] here',
    );
    expect(callLog.getCall(byTool('local__echo', 'admin').id)!.arguments!.text).toContain('[secret:log-key]');

    await t.gateway.stop('test');
    expect(dbBytes(t.home.paths.db)).not.toContain(SECRET);
  });

  it('an input_required round trip stores no requestState, inputResponses or answers', async () => {
    const stateless: RunningFixture = await startStatelessServer();
    cleanups.push(() => stateless.close());
    const t = await startTestGateway({
      timing: FAST_TIMING,
      config: { servers: [{ name: 'modern', transport: 'http', url: stateless.url }] } as never,
    });
    cleanups.push(() => t.cleanup());
    await waitForStatus(t.gateway, 'modern', 'ready');

    const client = await modernClient(t, { confirm: true, [ANSWER_MARK]: ANSWER_MARK });
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'modern__confirm_action', arguments: { action: 'deploy' } },
    });
    expect(JSON.stringify(result)).toContain('accepted');

    const callLog = t.gateway.callLog!;
    await waitUntil(() =>
      callLog.listCalls({ tool: 'confirm_action' }).calls.some((c) => c.outcome === 'ok'),
    );
    const recorded = callLog.listCalls({ tool: 'confirm_action' }).calls;
    expect(recorded.map((c) => c.outcome).sort()).toEqual(['input_required', 'ok']);
    const asked = callLog.getCall(recorded.find((c) => c.outcome === 'input_required')!.id)!;
    expect(JSON.parse(asked.result!.text)).toMatchObject({
      resultType: 'input_required',
      inputRequests: { confirm: { method: 'elicitation/create' } },
    });
    for (const call of recorded) {
      const detail = JSON.stringify(callLog.getCall(call.id));
      expect(detail).not.toContain('requestState');
      expect(detail).not.toContain('mcpier1.');
      expect(detail).not.toContain('inputResponses');
      expect(detail).not.toContain(ANSWER_MARK);
    }

    await t.gateway.stop('test');
    const bytes = dbBytes(t.home.paths.db);
    for (const banned of ['requestState', 'mcpier1.', 'inputResponses', ANSWER_MARK]) {
      expect(bytes).not.toContain(banned);
    }
  });
});

describe('the gateway and the store', () => {
  it('falls back to the log recorder when mcpier.db cannot be opened, and says so in status', async () => {
    const t = await startTestGateway({
      timing: FAST_TIMING,
      config: {
        servers: [
          { name: 'local', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
        ],
      } as never,
      extra: {
        callLog: {
          opener: () => {
            throw new Error('simulated: cannot open');
          },
        },
      },
    });
    cleanups.push(() => t.cleanup());
    expect(t.gateway.callLog).toBeUndefined();
    const status = await api<StatusResponse>(t, 'GET', '/api/status');
    expect(status.body.callLog).toMatchObject({ store: 'log' });
    expect(status.body.callLog!.problem).toContain('simulated: cannot open');

    await waitForStatus(t.gateway, 'local', 'ready');
    const call = await api(t, 'POST', '/api/tools/local__echo/call', { arguments: { text: 'still works' } });
    expect(call.status).toBe(200);
    await waitUntil(() => readFileSync(t.home.paths.gatewayLog, 'utf8').includes('"event":"call"'));
    const lines = readFileSync(t.home.paths.gatewayLog, 'utf8');
    expect(lines).not.toContain('still works');
    expect(lines.match(/The call log is not available/g)).toHaveLength(1);
  });

  it('queued records are written when the gateway stops', async () => {
    const t = await startTestGateway({
      timing: FAST_TIMING,
      config: {
        servers: [
          { name: 'local', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
        ],
      } as never,
      extra: { callLog: { flushIntervalMs: 60_000 } },
    });
    cleanups.push(() => t.cleanup());
    await waitForStatus(t.gateway, 'local', 'ready');
    await api(t, 'POST', '/api/tools/local__echo/call', { arguments: { text: 'queued' } });
    await api(t, 'GET', '/api/tools/search?q=echo');
    await t.gateway.stop('test');
    const db = openDatabaseReadOnly(t.home.paths.db);
    try {
      expect(db.prepare('SELECT tool FROM calls').all()).toEqual([{ tool: 'local__echo' }]);
      expect(db.prepare('SELECT query FROM searches').all()).toEqual([{ query: 'echo' }]);
    } finally {
      db.close();
    }
  });
});

describe('the tool catalog cache', () => {
  let world: OAuthWorld;

  it("after a restart a needs_auth server's tools are searchable as unavailable; listing replaces them; removal deletes them", async () => {
    world = await startOAuthWorld();
    cleanups.push(() => world.close());
    await world.signIn();
    await waitUntil(() => world.t.gateway.manager.tools(OAUTH_SERVER).length > 0);

    // The tokens stop working: after the restart the server needs a sign-in again.
    world.fixture.revokeAllTokens();
    await world.restart();
    await waitForStatus(world.t.gateway, OAUTH_SERVER, 'needs_auth');
    // The search index rebuilds shortly (debounced) after the status change.
    const findEcho = async () =>
      (await api<ToolSearchResponse>(world.t, 'GET', '/api/tools/search?q=echo')).body.results.find(
        (match) => match.name === `${OAUTH_SERVER}__echo`,
      );
    await waitUntil(async () => (await findEcho()) !== undefined);
    expect(await findEcho()).toMatchObject({
      server: OAUTH_SERVER,
      available: false,
      serverStatus: 'needs_auth',
    });

    const db = () => openDatabaseReadOnly(world.t.home.paths.db);
    const listedAt = () => {
      const handle = db();
      try {
        return (
          handle.prepare('SELECT listed_at FROM tool_cache WHERE server = ?').get(OAUTH_SERVER) as
            { listed_at: number } | undefined
        )?.listed_at;
      } finally {
        handle.close();
      }
    };
    const before = listedAt();
    expect(before).toBeTypeOf('number');

    // A fresh listing after the sign-in replaces the cached one.
    await world.signIn();
    await waitUntil(() => (listedAt() ?? 0) > before!);
    await waitUntil(async () => (await findEcho())?.available === true);

    // Removing the server deletes its entry.
    expect((await api(world.t, 'DELETE', `/api/servers/${OAUTH_SERVER}`)).status).toBe(200);
    await waitUntil(() => listedAt() === undefined);
  }, 60_000);
});
