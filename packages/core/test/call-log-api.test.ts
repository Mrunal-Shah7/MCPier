// Sprint 6, Phase 2: the call log, search log, stats, validation and Tester routes, the
// call_recorded event, and a leak check over everything a call can reach.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGatewayLogger, MODERN_PROTOCOL_VERSION, openDatabase, SqliteToolCache } from '@mcpier/core';
import {
  CALL_LOG_PATHS,
  TESTER_CLIENT_NAME,
  type CallDetail,
  type CallListResponse,
  type CallStatsResponse,
  type ClearCallLogResponse,
  type SearchListResponse,
  type TesterCallResponse,
  type TesterCallRequest,
  type ValidateArgumentsResponse,
} from '@mcpier/shared';
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
import { getFreePort } from '../../../test/helpers/ports.js';
import { openSse, type SseReader } from '../../../test/helpers/sse.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const SECRET = 'call-log-api-secret-7171';
const ANSWER = 'tester-answer-mark-7272';

let home: TempHome;
let t: TestGateway;
let stateless: RunningFixture;
let legacy: RunningFixture;
let events: SseReader;
const clients: Client[] = [];
/** Every response body seen, except the Tester's input_required answers (they carry MCPier's state). */
const seen: string[] = [];
/** The Tester's input_required answers: MCPier's signed state is in them by design. */
const stateAnswers: string[] = [];
/** Error answers (4xx and 5xx): their help text may name request fields such as inputResponses. */
const errorAnswers: string[] = [];

interface Answer<T> {
  status: number;
  body: T;
  text: string;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetch(`${t.gateway.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const parsed = (text ? JSON.parse(text) : undefined) as T;
  const isStateAnswer =
    (parsed as { result?: { resultType?: string } } | undefined)?.result?.resultType === 'input_required' &&
    path.endsWith('/test');
  (response.status >= 400 ? errorAnswers : isStateAnswer ? stateAnswers : seen).push(text);
  return { status: response.status, body: parsed, text };
}

const test = (tool: string, request: TesterCallRequest) =>
  api<TesterCallResponse>('POST', CALL_LOG_PATHS.test(tool), request);

async function mcpClient(mode: 'modern' | 'legacy', name: string) {
  const client = new Client(
    { name, version: '1.0' },
    {
      capabilities: {},
      versionNegotiation: { mode: mode === 'modern' ? { pin: MODERN_PROTOCOL_VERSION } : 'legacy' } as never,
    },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.gateway.url}/mcp`)));
  clients.push(client);
  return client;
}

const calls = (query = '') => api<CallListResponse>('GET', `${CALL_LOG_PATHS.calls}${query}`);

beforeAll(async () => {
  stateless = await startStatelessServer();
  legacy = await startLegacyServer();
  home = createTempHome();
  mkdirSync(home.dir, { recursive: true });
  // A server that never connects, with a cached tool whose schema cannot be compiled (a remote
  // $ref): it is listed (unavailable) and its arguments cannot be validated.
  const seedLog = createGatewayLogger({ file: join(home.dir, '..', 'seed.log') });
  const seeded = openDatabase(home.paths.db, seedLog.logger).db!;
  new SqliteToolCache(seeded, seedLog.logger).save('broken', [
    {
      name: 'ref',
      description: 'A tool whose schema points elsewhere.',
      inputSchema: { type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' } } },
    },
  ]);
  seeded.close();
  seedLog.close();

  t = await startTestGateway({
    home,
    timing: FAST_TIMING,
    config: {
      settings: { resultSizeLimitKb: 1 },
      servers: [
        {
          name: 'local',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          env: { API_SECRET: 'secret:api-key' },
        },
        { name: 'modern', transport: 'http', url: stateless.url },
        { name: 'old', transport: 'http', url: legacy.url },
        { name: 'broken', transport: 'http', url: `http://127.0.0.1:${await getFreePort()}/mcp` },
      ],
    } as never,
  });
  await t.secrets.set('api-key', SECRET);
  await t.gateway.manager.restart('local');
  for (const name of ['local', 'modern', 'old']) await waitForStatus(t.gateway, name, 'ready');
  t.gateway.meta.refresh();
  events = await openSse(`${t.gateway.url}/api/events`, { authorization: `Bearer ${t.token}` });
});

afterAll(async () => {
  events?.close();
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await t?.cleanup();
  await home?.cleanup();
  await stateless?.close();
  await legacy?.close();
});

describe('list and get calls', () => {
  it('filters, pages across pages with a cursor, and refuses bad parameters', async () => {
    for (let i = 0; i < 7; i++) {
      await api('POST', '/api/tools/local__add/call', { arguments: { a: i, b: 1 } });
    }
    await api('POST', '/api/tools/local__fail/call', { arguments: {} });
    await api('POST', '/api/tools/nope__missing/call', { arguments: {} });

    const all: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await calls(
        `?tool=local__add&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.status).toBe(200);
      expect(page.body.calls.length).toBeLessThanOrEqual(3);
      for (const call of page.body.calls) {
        expect(call.tool).toBe('local__add');
        expect(call).not.toHaveProperty('arguments');
        expect(call).not.toHaveProperty('result');
      }
      all.push(...page.body.calls.map((call) => call.id));
      cursor = page.body.nextCursor;
      pages++;
    } while (cursor);
    expect(all).toHaveLength(7);
    expect(pages).toBe(3);
    expect([...all].sort((a, b) => b - a)).toEqual(all);

    expect((await calls('?server=local&outcome=tool_error')).body.calls.map((c) => c.tool)).toEqual([
      'local__fail',
    ]);
    expect((await calls('?outcome=not_found')).body.calls.map((c) => c.tool)).toContain('nope__missing');
    expect((await calls('?client=admin-api&limit=200')).body.calls.length).toBeGreaterThanOrEqual(9);
    expect((await calls('?client=someone-else')).body.calls).toEqual([]);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await calls(`?from=${future}`)).body.calls).toEqual([]);
    expect((await calls(`?to=${new Date().toISOString()}&tool=add`)).body.calls.length).toBe(7);

    for (const [query, message] of [
      ['?cursor=garbage', 'cursor is not valid'],
      ['?limit=0', '"limit" must be a whole number from 1 to 200'],
      ['?limit=201', '"limit"'],
      ['?outcome=great', '"outcome" must be one of'],
      ['?from=yesterday', '"from" must be a time'],
    ] as const) {
      const answer = await calls(query);
      expect(answer.status, query).toBe(400);
      expect((answer.body as unknown as { error: { message: string } }).error.message).toContain(message);
    }
  });

  it('gets one call with its bodies; unknown ids and non-numeric ids are 404', async () => {
    const [latest] = (await calls('?tool=local__add&limit=1')).body.calls;
    const detail = await api<CallDetail>('GET', CALL_LOG_PATHS.call(latest!.id));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: latest!.id,
      tool: 'local__add',
      era: 'admin',
      bodiesStored: true,
    });
    expect(JSON.parse(detail.body.arguments!.text)).toEqual({ a: 6, b: 1 });
    expect(detail.body.result!.text).toContain('7');
    expect((await api('GET', CALL_LOG_PATHS.call(999_999))).status).toBe(404);
    expect((await api('GET', '/api/calls/12x')).status).toBe(404);
    // The stats route is not taken for an id.
    expect((await api<CallStatsResponse>('GET', CALL_LOG_PATHS.stats)).body.calls.total).toBeGreaterThan(0);
  });

  it('storeCallBodies off applies to new calls only', async () => {
    expect((await api('PATCH', '/api/settings', { storeCallBodies: false })).status).toBe(200);
    await api('POST', '/api/tools/local__echo/call', { arguments: { text: 'metadata only' } });
    expect((await api('PATCH', '/api/settings', { storeCallBodies: true })).status).toBe(200);
    const [call] = (await calls('?tool=local__echo&limit=1')).body.calls;
    const detail = (await api<CallDetail>('GET', CALL_LOG_PATHS.call(call!.id))).body;
    expect(detail.bodiesStored).toBe(false);
    expect(detail.arguments).toBeUndefined();
    const older = (await calls('?tool=local__add&limit=1')).body.calls[0]!;
    expect((await api<CallDetail>('GET', CALL_LOG_PATHS.call(older.id))).body.arguments).toBeDefined();
  });
});

describe('searches and stats', () => {
  it('lists searches with hit and miss, filtered by client and outcome', async () => {
    const client = 'search-tester';
    const search = (q: string) =>
      fetch(`${t.gateway.url}/api/tools/search?q=${encodeURIComponent(q)}`, {
        headers: { authorization: `Bearer ${t.token}`, 'x-mcpier-client': client },
      }).then((response) => response.text().then((text) => seen.push(text)));
    const callAs = (tool: string, args: Record<string, unknown>) =>
      fetch(`${t.gateway.url}/api/tools/${tool}/call`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t.token}`,
          'x-mcpier-client': client,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ arguments: args }),
      }).then((response) => response.text().then((text) => seen.push(text)));
    await search('add two numbers');
    await callAs('local__add', { a: 1, b: 2 });
    await search('echo text back');
    await callAs('local__add', { a: 3, b: 4 });

    const listed = await api<SearchListResponse>('GET', `${CALL_LOG_PATHS.searches}?client=${client}`);
    expect(listed.body.searches.map((s) => [s.query, s.followup])).toEqual([
      ['echo text back', 'miss'],
      ['add two numbers', 'hit'],
    ]);
    expect(listed.body.searches[1]!.rank).toBeGreaterThanOrEqual(1);
    expect(listed.body.searches[0]!.calledTool).toBe('local__add');
    const hits = await api<SearchListResponse>(
      'GET',
      `${CALL_LOG_PATHS.searches}?client=${client}&outcome=hit`,
    );
    expect(hits.body.searches.map((s) => s.query)).toEqual(['add two numbers']);
    expect((await api('GET', `${CALL_LOG_PATHS.searches}?outcome=maybe`)).status).toBe(400);
    expect((await api('GET', `${CALL_LOG_PATHS.searches}?cursor=zzz`)).status).toBe(400);

    const stats = await api<CallStatsResponse>('GET', CALL_LOG_PATHS.stats);
    expect(stats.body.searches.hits).toBeGreaterThanOrEqual(1);
    expect(stats.body.searches.misses).toBeGreaterThanOrEqual(1);
    expect(stats.body.searches.hitRate).toBeGreaterThan(0);
    expect(stats.body.recentMisses[0]).toMatchObject({ query: 'echo text back', calledTool: 'local__add' });
    expect(stats.body.calls.byServer.find((s) => s.server === 'local')).toMatchObject({
      calls: expect.any(Number),
      p50Ms: expect.any(Number),
      p95Ms: expect.any(Number),
    });
    expect(stats.body.calls.errorRate).toBeGreaterThan(0);
  });

  it('stats over an empty range', async () => {
    const from = '2001-01-01T00:00:00.000Z';
    const to = '2001-01-02T00:00:00.000Z';
    const stats = await api<CallStatsResponse>('GET', `${CALL_LOG_PATHS.stats}?from=${from}&to=${to}`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      from,
      to,
      calls: { total: 0, errors: 0, errorRate: null, p50Ms: null, p95Ms: null, byServer: [] },
      searches: { total: 0, hitRate: null },
      recentMisses: [],
    });
  });
});

describe('validation', () => {
  it('valid, invalid with locations, not validated with the reason, and an unknown tool', async () => {
    const validate = (tool: string, args: Record<string, unknown>) =>
      api<ValidateArgumentsResponse>('POST', CALL_LOG_PATHS.validate(tool), { arguments: args });
    expect((await validate('local__add', { a: 1, b: 2 })).body).toEqual({ result: 'valid' });
    const invalid = await validate('local__add', { a: 'one' });
    expect(invalid.body.result).toBe('invalid');
    const problems = (invalid.body as { problems: { path: unknown[]; location: string; message: string }[] })
      .problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        { path: ['a'], location: 'arguments.a', message: 'must be number' },
        { path: ['b'], location: 'arguments.b', message: 'is required' },
      ]),
    );
    const skipped = await validate('broken__ref', { a: 1 });
    expect(skipped.body.result).toBe('not_validated');
    expect((skipped.body as { reason: string }).reason).toMatch(/resolve|reference/i);
    expect((await validate('local__ghost', {})).status).toBe(404);
    expect((await api('POST', CALL_LOG_PATHS.validate('local__add'), 'not json')).status).toBe(400);
  });
});

describe('the Tester', () => {
  it('raw mode returns the output untruncated; model mode cuts it to the limit and says so', async () => {
    const raw = await test('local__big_output', { mode: 'raw', arguments: { kb: 3 } });
    expect(raw.body).toMatchObject({ mode: 'raw', outcome: 'ok' });
    const rawText = (raw.body.result as { content: { text: string }[] }).content[0]!.text;
    expect(rawText).toHaveLength(3 * 1024);

    const model = await test('local__big_output', { mode: 'model', arguments: { kb: 3 } });
    expect(model.body).toMatchObject({
      mode: 'model',
      outcome: 'ok',
      truncation: { text: { shownBytes: 1024 } },
    });
    const blocks = (model.body.result as { content: { text: string }[] }).content;
    expect(blocks[0]!.text).toHaveLength(1024);
    expect(blocks.at(-1)!.text).toContain('[MCPier: output truncated.');

    const [recorded] = (await calls(`?client=${TESTER_CLIENT_NAME}&tool=big_output&limit=1`)).body.calls;
    expect(recorded).toMatchObject({ era: 'admin', client: { name: TESTER_CLIENT_NAME } });
  });

  it('model mode reports validation errors as call_tool does; raw mode leaves them to the server', async () => {
    const model = await test('local__add', { mode: 'model', arguments: { a: 'x' } });
    expect(model.body.outcome).toBe('validation_error');
    expect(JSON.stringify(model.body.result)).toContain('do not match its input schema');
    const raw = await test('local__add', { mode: 'raw', arguments: { a: 'x' } });
    expect(raw.body.outcome).not.toBe('validation_error');
  });

  it('an unavailable tool is not run: its server status comes back', async () => {
    const model = await test('broken__ref', { mode: 'model', arguments: {} });
    expect(model.body.outcome).toBe('not_ready');
    const raw = await test('broken__ref', { mode: 'raw', arguments: {} });
    expect(raw.body.outcome).toBe('not_ready');
    expect(raw.body.error).toBeTypeOf('string');
    expect(raw.body.result).toBeUndefined();
    const unknown = await test('local__ghost', { mode: 'raw', arguments: {} });
    expect(unknown.body.outcome).toBe('not_found');
    expect((await api('POST', CALL_LOG_PATHS.test('local__add'), { mode: 'sideways' })).status).toBe(400);
  });

  it('completes a confirm_action round trip through input_required in model mode', async () => {
    const first = await test('modern__confirm_action', { mode: 'model', arguments: { action: 'ship' } });
    expect(first.body.outcome).toBe('input_required');
    const asked = first.body.result as {
      resultType: string;
      requestState: string;
      inputRequests: Record<string, { method: string; params: { message: string } }>;
    };
    expect(asked.resultType).toBe('input_required');
    expect(asked.requestState).toMatch(/^mcpier1\./);
    expect(asked.inputRequests.confirm!.method).toBe('elicitation/create');

    const done = await test('modern__confirm_action', {
      mode: 'model',
      arguments: { action: 'ship' },
      inputResponses: { confirm: { action: 'accept', content: { confirm: true, note: ANSWER } } },
      requestState: asked.requestState,
    });
    expect(done.body.outcome).toBe('ok');
    expect(JSON.stringify(done.body.result)).toContain('confirm_action ship: accepted (confirm=true)');

    // A changed state is refused.
    const tampered = await test('modern__confirm_action', {
      mode: 'model',
      arguments: { action: 'ship' },
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: `${asked.requestState}x`,
    });
    expect(tampered.body.outcome).toBe('failed');

    // Raw mode passes no state on, and refuses answers.
    const raw = await test('modern__confirm_action', { mode: 'raw', arguments: { action: 'ship' } });
    expect(JSON.stringify(raw.body)).not.toContain('requestState');
    const rawAnswer = await test('modern__confirm_action', {
      mode: 'raw',
      arguments: { action: 'ship' },
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
    });
    expect(rawAnswer.status).toBe(400);
  });
});

describe('call_recorded', () => {
  it('fires for each recorded call with the summary fields only', async () => {
    const before = events.events.length;
    await api('POST', '/api/tools/local__fail/call', { arguments: { message: `fails with ${SECRET}` } });
    const event = (await events.waitFor(
      (e, index = events.events.indexOf(e)) =>
        index >= before && e.event === 'call_recorded' && (e.data as { tool: string }).tool === 'local__fail',
    )) as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(
      [
        'at',
        'bodiesStored',
        'client',
        'durationMs',
        'era',
        'estimatedTokens',
        'id',
        'outcome',
        'resultBytes',
        'server',
        'tool',
      ].sort(),
    );
    expect(event).toMatchObject({
      tool: 'local__fail',
      server: 'local',
      era: 'admin',
      outcome: 'tool_error',
    });
    for (const recorded of events.events.filter((e) => e.event === 'call_recorded')) {
      const data = recorded.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('arguments');
      expect(data).not.toHaveProperty('result');
      expect(data).not.toHaveProperty('errorText');
    }
  });
});

describe('retention through the gateway', () => {
  it('lowering logRetentionDays purges at once', async () => {
    const callLog = t.gateway.callLog!;
    callLog.toolCalled({
      at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      client: { name: 'old-client' },
      era: 'admin',
      tool: 'local__echo',
      server: 'local',
      durationMs: 1,
      outcome: 'ok',
    });
    expect((await calls('?client=old-client')).body.calls).toHaveLength(1);
    expect((await api('PATCH', '/api/settings', { logRetentionDays: 5 })).status).toBe(200);
    await waitUntil(async () => (await calls('?client=old-client')).body.calls.length === 0);
    expect((await calls('?client=admin-api&limit=1')).body.calls).toHaveLength(1);
  });
});

describe('clear the log', () => {
  it('needs confirm=true, then deletes every call and search', async () => {
    const before = (await api<CallStatsResponse>('GET', CALL_LOG_PATHS.stats)).body;
    expect(before.calls.total).toBeGreaterThan(0);
    for (const query of ['', '?confirm=yes', '?confirm=1']) {
      const refused = await api('DELETE', `${CALL_LOG_PATHS.calls}${query}`);
      expect(refused.status, query).toBe(400);
      expect(refused.text).toContain('confirm=true');
    }
    expect((await api<CallStatsResponse>('GET', CALL_LOG_PATHS.stats)).body.calls.total).toBe(
      before.calls.total,
    );

    const cleared = await api<ClearCallLogResponse>('DELETE', `${CALL_LOG_PATHS.calls}?confirm=true`);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({
      deletedCalls: before.calls.total,
      deletedSearches: before.searches.total,
    });
    expect((await calls()).body.calls).toEqual([]);
    expect((await api<SearchListResponse>('GET', CALL_LOG_PATHS.searches)).body.searches).toEqual([]);
    // The catalog cache is not part of the log: the broken server's cached tool is still there.
    expect((await api('POST', CALL_LOG_PATHS.validate('broken__ref'), { arguments: {} })).status).toBe(200);
  });
});

describe('no secret value, state or answer leaks', () => {
  it('after calls through /mcp (both eras), the Tester and the admin route', async () => {
    const modern = await mcpClient('modern', 'leak-modern');
    const old = await mcpClient('legacy', 'leak-legacy');
    for (const client of [modern, old]) {
      const echoed = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'local__env_echo', arguments: { name: 'API_SECRET' } },
      });
      seen.push(JSON.stringify(echoed));
      seen.push(
        JSON.stringify(
          await client.callTool({
            name: 'call_tool',
            arguments: { name: 'local__echo', arguments: { text: `my key is ${SECRET}` } },
          }),
        ),
      );
    }
    for (const mode of ['model', 'raw'] as const) {
      await test('local__env_echo', { mode, arguments: { name: 'API_SECRET' } });
      await test('local__echo', { mode, arguments: { text: SECRET } });
    }
    await api('POST', '/api/tools/local__env_echo/call', { arguments: { name: 'API_SECRET' } });
    await api('POST', '/api/tools/local__echo/call', { arguments: { text: SECRET } });

    // Read every list and detail.
    const listed = await calls('?limit=200');
    for (const call of listed.body.calls) await api('GET', CALL_LOG_PATHS.call(call.id));
    await api('GET', `${CALL_LOG_PATHS.searches}?limit=200`);
    await api('GET', CALL_LOG_PATHS.stats);
    const stored = (
      await api<CallDetail>(
        'GET',
        CALL_LOG_PATHS.call(listed.body.calls.find((c) => c.tool === 'local__env_echo')!.id),
      )
    ).body;
    expect(stored.result!.text).toContain('[secret:api-key]');

    // Every call so far has been published as an event.
    const newest = listed.body.calls[0]!.id;
    await waitUntil(() =>
      events.events.some((e) => e.event === 'call_recorded' && (e.data as { id: number }).id === newest),
    );
    await t.gateway.stop('leak check');

    // inputResponses as a JSON key: MCPier's own messages may name the field in prose.
    const banned = [SECRET, 'mcpier1.', '"inputResponses"', ANSWER];
    const corpus: [string, string][] = [
      ['responses', seen.join('\n')],
      ['error responses', errorAnswers.join('\n')],
      ['events', events.raw()],
      ['gateway.log', readFileSync(t.home.paths.gatewayLog, 'utf8')],
      ...[t.home.paths.db, `${t.home.paths.db}-wal`]
        .filter((file) => existsSync(file))
        .map((file): [string, string] => [file, readFileSync(file).toString('latin1')]),
      ...readdirSync(t.home.paths.logsDir).map((file): [string, string] => [
        file,
        readFileSync(join(t.home.paths.logsDir, file), 'utf8'),
      ]),
    ];
    for (const [where, text] of corpus) {
      // A 400's help text names the request fields (it explains the expected body).
      const checked = where === 'error responses' ? banned.filter((v) => v !== '"inputResponses"') : banned;
      for (const value of checked) {
        expect(text.includes(value), `${value} in ${where}`).toBe(false);
      }
    }
    // The only place MCPier's signed state appears: the Tester's input_required answer itself.
    expect(stateAnswers.length).toBeGreaterThan(0);
    for (const text of stateAnswers) {
      expect(text).toContain('mcpier1.');
      expect(text).not.toContain(SECRET);
    }
  });
});
