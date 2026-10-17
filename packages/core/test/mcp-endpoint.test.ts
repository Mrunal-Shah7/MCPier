// Sprint 3: /mcp end to end with the SDK client in each mode (pinned modern, auto, legacy)
// against a gateway running all three fixture types.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  MCP_INSTRUCTIONS,
  MODERN_PROTOCOL_VERSION,
  serverLogPath,
  TOOLS_LIST_CACHE_HINT,
} from '@mcpier/core';
import {
  fixtureScripts,
  startLegacyServer,
  startStatelessServer,
  type RunningFixture,
} from '@mcpier/test-fixtures';
import { httpRequest } from '../../../test/helpers/http.js';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';

type Mode = 'modern' | 'auto' | 'legacy';
const MODES: Mode[] = ['modern', 'auto', 'legacy'];
const SECRET = 'mcp-endpoint-secret-value-5555';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let t: TestGateway;
let stateless: RunningFixture;
let legacy: RunningFixture;
const open: Client[] = [];

beforeAll(async () => {
  stateless = await startStatelessServer();
  legacy = await startLegacyServer();
  t = await startTestGateway({
    timing: FAST_TIMING,
    config: {
      servers: [
        { name: 'modern', transport: 'http', url: stateless.url },
        { name: 'old', transport: 'http', url: legacy.url },
        {
          name: 'local',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          env: { MCP_SECRET: 'secret:mcp-key' },
        },
      ],
    } as never,
  });
  await t.secrets.set('mcp-key', SECRET);
  await t.gateway.manager.restart('local');
  for (const name of ['modern', 'old', 'local']) await waitForStatus(t.gateway, name, 'ready');
  t.gateway.meta.refresh();
});

afterAll(async () => {
  await Promise.all(open.map((client) => client.close().catch(() => {})));
  await t.cleanup();
  await stateless.close();
  await legacy.close();
});

interface ClientOptions {
  name?: string;
  /** Declare elicitation and answer every form with `answer`. */
  answer?: Record<string, unknown>;
}

async function connect(mode: Mode, options: ClientOptions = {}): Promise<Client> {
  const versionNegotiation = {
    mode: mode === 'modern' ? { pin: MODERN_PROTOCOL_VERSION } : mode,
  } as const;
  const client = new Client(
    { name: options.name ?? `test-${mode}`, version: '1.2.3' },
    {
      capabilities: options.answer ? { elicitation: { form: {} } } : {},
      versionNegotiation: versionNegotiation as never,
    },
  );
  if (options.answer) {
    const answer = options.answer;
    client.setRequestHandler(
      'elicitation/create',
      async () => ({ action: 'accept', content: answer }) as never,
    );
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.gateway.url}/mcp`)));
  open.push(client);
  return client;
}

const textOf = (result: unknown) =>
  ((result as { content: { type: string; text?: string }[] }).content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe.each(MODES)('%s client', (mode) => {
  it('connects in the expected era, sees the instructions and exactly three tools', async () => {
    const client = await connect(mode);
    const negotiated = client.getNegotiatedProtocolVersion();
    if (mode === 'legacy') expect(negotiated).not.toBe(MODERN_PROTOCOL_VERSION);
    else expect(negotiated).toBe(MODERN_PROTOCOL_VERSION);
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(600);
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(client.getServerVersion()?.name).toBe('mcpier');
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'call_tool',
      'list_servers',
      'search_tools',
    ]);
    if (mode !== 'legacy') {
      expect(listed).toMatchObject(TOOLS_LIST_CACHE_HINT);
    }
  });

  it('list_servers, search_tools and call_tool on every fixture type', async () => {
    const client = await connect(mode);
    const servers = await client.callTool({ name: 'list_servers', arguments: {} });
    expect((servers.structuredContent as { servers: { name: string }[] }).servers.map((s) => s.name)).toEqual(
      ['local', 'modern', 'old'],
    );
    const found = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'add two numbers', limit: 10 },
    });
    const names = (found.structuredContent as { results: { name: string }[] }).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['local__add', 'modern__add', 'old__add']));
    for (const server of ['local', 'modern', 'old']) {
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: `${server}__add`, arguments: { a: 4, b: 5 } },
      });
      expect(result.structuredContent).toEqual({ sum: 9 });
    }
  });

  it('error paths come back as error results, not protocol errors', async () => {
    const client = await connect(mode);
    const empty = await client.callTool({ name: 'search_tools', arguments: { query: '' } });
    expect(empty.isError).toBe(true);
    const unknownServer = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'x', server: 'nope' },
    });
    expect(unknownServer.isError).toBe(true);
    expect(textOf(unknownServer)).toContain('Valid server names');
    const unknownTool = await client.callTool({ name: 'call_tool', arguments: { name: 'nope__nope' } });
    expect(unknownTool.isError).toBe(true);
    const invalid = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'local__add', arguments: { a: 'x' } },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('arguments.a: must be number');
  });

  it('forwards the client’s traceparent upstream', async () => {
    const client = await connect(mode);
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'modern__meta_echo', arguments: {} },
      _meta: { traceparent: TRACEPARENT },
    });
    expect((result.structuredContent as { meta: Record<string, unknown> }).meta.traceparent).toBe(
      TRACEPARENT,
    );
  });

  it('cancelling a slow call reaches the upstream server', async () => {
    const client = await connect(mode);
    const log = serverLogPath(t.home.paths.logsDir, 'local');
    const count = (line: string) => readFileSync(log, 'utf8').split(line).length - 1;
    const before = { called: count('call slow'), cancelled: count('cancelled slow') };
    const controller = new AbortController();
    const pending = client
      .callTool(
        { name: 'call_tool', arguments: { name: 'local__slow', arguments: { ms: 20_000 } } },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    await waitUntil(() => count('call slow') > before.called, 5000);
    controller.abort();
    await pending;
    await waitUntil(() => count('cancelled slow') > before.cancelled, 8000);
  });
});

describe('confirm_action through /mcp', () => {
  it('modern: the client answers the elicitation and the call completes', async () => {
    const client = await connect('modern', { answer: { confirm: true } });
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'modern__confirm_action', arguments: { action: 'deploy' } },
    });
    expect(textOf(result)).toBe('confirm_action deploy: accepted (confirm=true)');
  });

  it('modern: the raw input_required carries MCPier’s own state', async () => {
    const client = await connect('modern', { answer: { confirm: true } });
    const raw = (await client.callTool(
      { name: 'call_tool', arguments: { name: 'modern__confirm_action', arguments: { action: 'x' } } },
      { allowInputRequired: true } as never,
    )) as unknown as {
      resultType: string;
      requestState: string;
      inputRequests: Record<string, { method: string }>;
    };
    expect(raw.resultType).toBe('input_required');
    expect(raw.requestState).toMatch(/^mcpier1\./);
    expect(raw.inputRequests.confirm!.method).toBe('elicitation/create');
  });

  it('legacy: an error result saying the client cannot provide the input', async () => {
    const client = await connect('legacy', { answer: { confirm: true } });
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'modern__confirm_action', arguments: { action: 'deploy' } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cannot provide');
  });
});

// ---- Raw HTTP: Host, Origin and the 2026-07-28 header rules

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function rawModern(body: Record<string, unknown>, headers: Record<string, string>, host?: string) {
  return httpRequest(t.port, {
    method: 'POST',
    path: '/mcp',
    headers: {
      host: host ?? `127.0.0.1:${t.port}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
}

const listTools = { method: 'tools/list', params: { _meta: MODERN_META } };
const callAdd = {
  method: 'tools/call',
  params: { name: 'list_servers', arguments: {}, _meta: MODERN_META },
};

describe('HTTP rules on /mcp', () => {
  it('a well-formed modern request needs no admin token', async () => {
    const response = await rawModern(listTools, { 'mcp-method': 'tools/list' });
    expect(response.status).toBe(200);
    expect(response.body).toContain('search_tools');
  });

  it.each([['evil.example.com'], ['127.0.0.1:1']])('rejects Host: %s before the handler', async (host) => {
    const response = await rawModern(listTools, { 'mcp-method': 'tools/list' }, host);
    expect(response.status).toBe(403);
  });

  it('rejects a foreign Origin', async () => {
    const response = await rawModern(listTools, {
      'mcp-method': 'tools/list',
      origin: 'http://evil.example.com',
    });
    expect(response.status).toBe(403);
  });

  it.each([
    ['a missing Mcp-Method', listTools, {}],
    ['a wrong Mcp-Method', listTools, { 'mcp-method': 'tools/call' }],
    ['a missing Mcp-Name', callAdd, { 'mcp-method': 'tools/call' }],
    ['a wrong Mcp-Name', callAdd, { 'mcp-method': 'tools/call', 'mcp-name': 'call_tool' }],
  ])('rejects %s with 400 and -32020', async (_label, body, headers) => {
    const response = await rawModern(body, headers as Record<string, string>);
    expect(response.status).toBe(400);
    expect(response.json<{ error: { code: number } }>().error.code).toBe(-32020);
  });

  it('a correct Mcp-Name is accepted', async () => {
    const response = await rawModern(callAdd, { 'mcp-method': 'tools/call', 'mcp-name': 'list_servers' });
    expect(response.status).toBe(200);
  });
});

// ---- Secrets, concurrency and recording

describe('secrets never leave MCPier', () => {
  it('env_echo of a secret reference is redacted in both eras, and the log has no value', async () => {
    for (const mode of MODES) {
      const client = await connect(mode);
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'local__env_echo', arguments: { name: 'MCP_SECRET' } },
      });
      expect(textOf(result)).toBe('[secret:mcp-key]');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    const logs = [t.home.paths.gatewayLog, serverLogPath(t.home.paths.logsDir, 'local')];
    for (const file of logs) expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
  });
});

describe('concurrency', () => {
  it('20 concurrent call_tool requests from three clients (mixed eras) all return correctly', async () => {
    const clients = await Promise.all([connect('modern'), connect('legacy'), connect('auto')]);
    const servers = ['local', 'modern', 'old'];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        clients[i % 3]!.callTool({
          name: 'call_tool',
          arguments: { name: `${servers[i % 3]}__add`, arguments: { a: i, b: 1000 } },
        }),
      ),
    );
    expect(results.map((result) => (result.structuredContent as { sum: number }).sum)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1000),
    );
  });
});

describe('recording', () => {
  it('logs each search and call with the client name and version of either era', async () => {
    const modern = await connect('modern', { name: 'recorded-modern' });
    const old = await connect('legacy', { name: 'recorded-legacy' });
    await modern.callTool({ name: 'search_tools', arguments: { query: 'echo' } });
    await old.callTool({
      name: 'call_tool',
      arguments: { name: 'local__echo', arguments: { text: 'PRIVATE-ARG' } },
    });
    const callLog = t.gateway.callLog!;
    await waitUntil(() => callLog.listCalls({ client: 'recorded-legacy' }).calls.length > 0);
    expect(callLog.listSearches({ client: 'recorded-modern' }).searches).toEqual([
      expect.objectContaining({
        era: 'modern',
        query: 'echo',
        client: { name: 'recorded-modern', version: '1.2.3' },
      }),
    ]);
    const [call] = callLog.listCalls({ client: 'recorded-legacy' }).calls;
    expect(call).toMatchObject({
      era: 'legacy',
      tool: 'local__echo',
      outcome: 'ok',
      client: { name: 'recorded-legacy', version: '1.2.3' },
      bodiesStored: true,
    });
    // The arguments are in the call log; calls and searches are no longer gateway log lines.
    expect(callLog.getCall(call!.id)?.arguments?.text).toContain('PRIVATE-ARG');
    expect(readFileSync(t.home.paths.gatewayLog, 'utf8')).not.toContain('PRIVATE-ARG');
    expect(readFileSync(t.home.paths.gatewayLog, 'utf8')).not.toContain('recorded-legacy');
  });
});

describe('config changes reach search', () => {
  it('a tool disabled through the config disappears from search_tools', async () => {
    const client = await connect('modern');
    const find = async () =>
      (
        (await client.callTool({ name: 'search_tools', arguments: { query: 'echo', limit: 20 } }))
          .structuredContent as {
          results: { name: string }[];
        }
      ).results.map((result) => result.name);
    expect(await find()).toContain('old__echo');
    await t.gateway.config.update((draft) => {
      draft.servers.find((server) => server.name === 'old')!.disabledTools = ['echo'];
    });
    try {
      await waitUntil(async () => !(await find()).includes('old__echo'));
    } finally {
      await t.gateway.config.update((draft) => {
        draft.servers.find((server) => server.name === 'old')!.disabledTools = [];
      });
    }
    await waitUntil(async () => (await find()).includes('old__echo'));
  });
});
