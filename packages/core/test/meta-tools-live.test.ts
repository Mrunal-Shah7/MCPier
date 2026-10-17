// Sprint 3: the meta-tools against real fixture servers (stdio, stateless HTTP, legacy HTTP)
// through a real gateway's manager: validation of the advertised schema, truncation, timeout,
// cancellation reaching upstream, the confirm_action round trip and live index updates.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectCleanRecorder } from '../../../test/helpers/recorder-checks.js';
import {
  callTool as runCallTool,
  createMetaService,
  listServers,
  MemoryRecorder,
  readStateKey,
  searchTools as runSearchTools,
  serverLogPath,
  type Caller,
  type CallToolResult,
  type MetaService,
} from '@mcpier/core';
import {
  ADDED_TOOL_NAME,
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

const SECRET = 'live-secret-value-for-redaction-9876';
const MODERN: Caller = {
  era: 'modern',
  client: { name: 'live-client', version: '2.0' },
  elicitation: { form: {} },
};
const LEGACY: Caller = { era: 'legacy', client: { name: 'live-legacy', version: '1.0' } };

let t: TestGateway;
let stateless: RunningFixture;
let legacy: RunningFixture;
let meta: MetaService;
let recorder: MemoryRecorder;

beforeAll(async () => {
  stateless = await startStatelessServer();
  legacy = await startLegacyServer();
  t = await startTestGateway({
    timing: FAST_TIMING,
    config: {
      settings: { resultSizeLimitKb: 4 },
      servers: [
        { name: 'modern', transport: 'http', url: stateless.url, description: 'Stateless test server' },
        { name: 'old', transport: 'http', url: legacy.url, timeoutMs: 400 },
        {
          name: 'local',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          env: { LIVE_SECRET: 'secret:live-key' },
        },
        {
          name: 'parked',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          enabled: false,
        },
      ],
    } as never,
  });
  await t.secrets.set('live-key', SECRET);
  await t.gateway.manager.restart('local');
  for (const name of ['modern', 'old', 'local']) await waitForStatus(t.gateway, name, 'ready');
});

// Counted wrappers: afterEach checks one recorded event per call and per search.
let counted = { calls: 0, searches: 0 };
const callTool: typeof runCallTool = (...args) => {
  counted.calls++;
  return runCallTool(...args);
};
const searchTools: typeof runSearchTools = (...args) => {
  counted.searches++;
  return runSearchTools(...args);
};

afterEach(() => {
  expectCleanRecorder(recorder, counted);
  counted = { calls: 0, searches: 0 };
});

beforeEach(() => {
  meta?.close();
  recorder = new MemoryRecorder();
  meta = createMetaService({
    manager: t.gateway.manager,
    settings: () => t.gateway.config.config.settings,
    logger: t.gateway.logger,
    stateKey: readStateKey(t.home.paths.stateKey),
    recorder,
    debounceMs: 20,
  });
});

afterAll(async () => {
  meta?.close();
  await t.cleanup();
  await stateless.close();
  await legacy.close();
});

const textOf = (result: unknown) =>
  (result as CallToolResult).content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');

describe('against real servers', () => {
  it('list_servers shows enabled servers only', () => {
    const { servers } = listServers(meta).structuredContent as {
      servers: { name: string; status: string }[];
    };
    expect(servers.map((server) => server.name)).toEqual(['local', 'modern', 'old']);
    expect(servers.every((server) => server.status === 'ready')).toBe(true);
  });

  it('search finds tools on every fixture type, ranked by the name first', () => {
    const result = searchTools(meta, { query: 'echo', limit: 20 }, MODERN);
    const names = (result.structuredContent as { results: { name: string }[] }).results.map(
      (match) => match.name,
    );
    expect(names).toEqual(expect.arrayContaining(['local__echo', 'modern__echo', 'old__echo']));
    expect(names.some((name) => name.startsWith('parked__'))).toBe(false);
  });

  it.each([['local'], ['modern'], ['old']])('call_tool runs %s__add', async (server) => {
    const result = (await callTool(
      meta,
      { name: `${server}__add`, arguments: { a: 2, b: 3 } },
      MODERN,
    )) as CallToolResult;
    expect(result.structuredContent).toEqual({ sum: 5 });
    expect(recorder.calls.at(-1)).toMatchObject({ tool: `${server}__add`, server, outcome: 'ok' });
  });

  it('validates against the schema the server advertises (rich_input)', async () => {
    const bad = await callTool(
      meta,
      {
        name: 'modern__rich_input',
        arguments: { name: 'Ada', kind: 'person', address: { street: 'x', zip: 'nope' } },
      },
      MODERN,
    );
    expect(textOf(bad)).toContain('arguments.address.zip: must match pattern');
    const good = await callTool(
      meta,
      {
        name: 'modern__rich_input',
        arguments: { name: 'Ada', kind: 'person', address: { street: 'x', zip: '12345' } },
      },
      MODERN,
    );
    expect(textOf(good)).toContain('rich_input accepted');
  });

  it('passes an upstream error result through', async () => {
    const result = (await callTool(
      meta,
      { name: 'old__fail', arguments: { message: 'it broke' } },
      LEGACY,
    )) as CallToolResult;
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'it broke' }] });
    expect(recorder.calls.at(-1)!.outcome).toBe('tool_error');
  });

  it('truncates text and drops oversized structured content', async () => {
    const text = await callTool(meta, { name: 'local__big_output', arguments: { kb: 10 } }, MODERN);
    expect(textOf(text)).toContain('output truncated. Showed 4.0 KB of 10 KB; 6.0 KB dropped');
    expect(textOf(text).length).toBeLessThan(5 * 1024);
    const structured = (await callTool(
      meta,
      { name: 'modern__big_structured', arguments: { kb: 8 } },
      MODERN,
    )) as CallToolResult;
    expect(structured.structuredContent).toBeUndefined();
    expect(textOf(structured)).toContain('structured content of 8.0 KB dropped');
  });

  it('a timeout becomes an error result', async () => {
    const result = await callTool(meta, { name: 'old__slow', arguments: { ms: 5000 } }, LEGACY);
    expect(textOf(result)).toContain('timed out after 400 ms');
    expect(recorder.calls.at(-1)!.outcome).toBe('timeout');
  });

  it('cancelling the call aborts it upstream', async () => {
    const controller = new AbortController();
    const pending = callTool(
      meta,
      { name: 'local__slow', arguments: { ms: 10_000 } },
      { ...MODERN, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(textOf(result)).toContain('was cancelled');
    expect(recorder.calls.at(-1)!.outcome).toBe('cancelled');
    const log = serverLogPath(t.home.paths.logsDir, 'local');
    await waitUntil(() => readFileSync(log, 'utf8').includes('[fake-stdio] cancelled slow'));
  });

  it('never shows a secret value', async () => {
    const result = await callTool(
      meta,
      { name: 'local__env_echo', arguments: { name: 'LIVE_SECRET' } },
      MODERN,
    );
    expect(textOf(result)).toBe('[secret:live-key]');
  });
});

describe('confirm_action through MCPier', () => {
  it('round trip: input_required with MCPier’s state, then the answer reaches upstream', async () => {
    const first = (await callTool(
      meta,
      { name: 'modern__confirm_action', arguments: { action: 'ship' } },
      MODERN,
    )) as {
      resultType: string;
      inputRequests: Record<string, { method: string }>;
      requestState: string;
    };
    expect(first.resultType).toBe('input_required');
    expect(first.inputRequests.confirm!.method).toBe('elicitation/create');
    expect(first.requestState).toMatch(/^mcpier1\./);

    const retry = await callTool(
      meta,
      { name: 'modern__confirm_action', arguments: { action: 'ship' } },
      {
        ...MODERN,
        requestState: first.requestState,
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      },
    );
    expect(textOf(retry)).toBe('confirm_action ship: accepted (confirm=true)');
    expect(recorder.calls.map((event) => event.outcome)).toEqual(['input_required', 'ok']);
    expect(JSON.stringify(recorder.calls)).not.toContain(first.requestState);
  });

  it('a legacy client gets the error result', async () => {
    const result = await callTool(
      meta,
      { name: 'modern__confirm_action', arguments: { action: 'ship' } },
      LEGACY,
    );
    expect(textOf(result)).toContain('cannot provide');
    expect(recorder.calls.at(-1)!.outcome).toBe('input_required');
  });

  it('a legacy upstream asking for elicitation mid-call is declined, not hung', async () => {
    const result = await callTool(meta, { name: 'old__ask_legacy', arguments: {} }, MODERN);
    expect(textOf(result)).toMatch(/^ask_legacy: /);
  });
});

describe('live index updates', () => {
  it('a tool list change shows up in search', async () => {
    const find = () =>
      (
        searchTools(meta, { query: 'added', limit: 20 }, MODERN).structuredContent as {
          results: { name: string }[];
        }
      ).results.map((match) => match.name);
    expect(find()).not.toContain(`local__${ADDED_TOOL_NAME}`);
    await callTool(meta, { name: 'local__change_tools', arguments: {} }, MODERN);
    await waitUntil(() => find().includes(`local__${ADDED_TOOL_NAME}`));
  });

  it('a server going down keeps its tools searchable, as unavailable', async () => {
    await t.gateway.manager.stop('old');
    try {
      await waitUntil(() => {
        const hits = (
          searchTools(meta, { query: 'echo', limit: 20 }, MODERN).structuredContent as {
            results: { name: string; available: boolean; serverStatus?: string }[];
          }
        ).results;
        const old = hits.find((hit) => hit.name === 'old__echo');
        return (
          old?.available === false &&
          old.serverStatus === 'stopped' &&
          hits.slice(hits.indexOf(old)).every((hit) => !hit.available)
        );
      });
      const result = await callTool(meta, { name: 'old__echo', arguments: { text: 'x' } }, MODERN);
      expect(textOf(result)).toContain('stopped in MCPier');
    } finally {
      await t.gateway.manager.start('old');
      await waitForStatus(t.gateway, 'old', 'ready');
    }
  });
});
