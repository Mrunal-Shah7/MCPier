// Sprint 3: the three meta-tools over a stub manager, so every check and error path is
// reachable without real servers. The real-server paths are in meta-tools-live.test.ts.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectCleanRecorder } from '../../../test/helpers/recorder-checks.js';
import { defaultConfig, type ServerStatusInfo, type ServerSummary, type ToolInfo } from '@mcpier/shared';
import {
  ArgumentValidator,
  CallTimeoutError,
  callTool as runCallTool,
  ConflictError,
  listServers,
  MemoryRecorder,
  NotFoundError,
  RequestStateSigner,
  SCHEMA_OUTLINE_THRESHOLD_BYTES,
  SearchIndex,
  searchCandidates,
  searchTools as runSearchTools,
  type Caller,
  type CallOutcome,
  type CallToolResult,
  type ManagerCallOptions,
  type MetaToolContext,
  type ServerManager,
} from '@mcpier/core';
import { RICH_INPUT_SCHEMA } from '@mcpier/test-fixtures';

const SECRET = 'stub-secret-value-0123456789';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

interface StubServer {
  name: string;
  enabled?: boolean;
  description?: string;
  status?: Omit<ServerStatusInfo, 'since'>;
  tools: (Partial<ToolInfo> & { name: string })[];
}

type Handler = (
  tool: string,
  args: Record<string, unknown>,
  options: ManagerCallOptions,
) => Promise<CallOutcome>;

/** Just enough of ServerManager for the meta-tools. */
class StubManager {
  servers: StubServer[] = [];
  handler: Handler = async () => ({
    kind: 'result',
    result: { content: [{ type: 'text', text: 'ok' }] },
    durationMs: 1,
  });
  calls: { tool: string; args: Record<string, unknown>; options: ManagerCallOptions }[] = [];

  private find(name: string): StubServer {
    const server = this.servers.find((entry) => entry.name === name);
    if (!server) throw new NotFoundError(`No server named "${name}".`);
    return server;
  }

  has(name: string) {
    return this.servers.some((entry) => entry.name === name);
  }

  status(name: string): ServerStatusInfo {
    return { since: '2026-01-01T00:00:00.000Z', ...(this.find(name).status ?? { state: 'ready' }) };
  }

  summary(name: string): ServerSummary {
    const server = this.find(name);
    const tools = this.tools(name);
    return {
      name,
      transport: 'stdio',
      enabled: server.enabled ?? true,
      status: this.status(name),
      tools: { total: tools.length, enabled: tools.filter((tool) => tool.enabled).length },
      ...(server.description ? { description: server.description } : {}),
    };
  }

  summaries() {
    return this.servers.map((server) => this.summary(server.name));
  }

  tools(server?: string): ToolInfo[] {
    return this.servers
      .filter((entry) => !server || entry.name === server)
      .flatMap((entry) =>
        entry.tools.map((tool) => ({
          fullName: `${entry.name}__${tool.name}`,
          server: entry.name,
          inputSchema: { type: 'object' },
          ...tool,
          enabled: (entry.enabled ?? true) && (tool.enabled ?? true),
          available: (entry.status?.state ?? 'ready') === 'ready',
        })),
      );
  }

  tool(fullName: string): ToolInfo {
    const found = this.tools().find((tool) => tool.fullName === fullName);
    if (!found) throw new NotFoundError(`No tool named "${fullName}".`);
    return found;
  }

  async callTool(tool: string, args: Record<string, unknown>, options: ManagerCallOptions = {}) {
    this.calls.push({ tool, args, options });
    return this.handler(tool, args, options);
  }

  redactFor(_server: string, text: string) {
    return text.split(SECRET).join('[secret:stub]');
  }
}

let manager: StubManager;
let recorder: MemoryRecorder;
let clock: number;
let ctx: MetaToolContext;
let search: SearchIndex;
let settings = defaultConfig().settings;

const MODERN: Caller = {
  era: 'modern',
  client: { name: 'test-client', version: '1.0' },
  elicitation: { form: {} },
};
const LEGACY: Caller = { era: 'legacy', client: { name: 'old-client', version: '0.9' } };

function rebuild() {
  search.rebuildNow();
}

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
  manager = new StubManager();
  recorder = new MemoryRecorder();
  clock = 1_800_000_000_000;
  settings = defaultConfig().settings;
  const asManager = manager as unknown as ServerManager;
  search = new SearchIndex({
    candidates: () => searchCandidates(asManager),
    weights: () => settings.searchWeights,
  });
  ctx = {
    manager: asManager,
    search,
    validator: new ArgumentValidator(),
    signer: new RequestStateSigner(randomBytes(32), () => clock),
    recorder,
    settings: () => settings,
  };
  manager.servers = [
    {
      name: 'files',
      description: 'Local files',
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          readOnlyHint: true,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        { name: 'write_file', description: 'Write a file', destructiveHint: true },
        { name: 'hidden_tool', enabled: false },
      ],
    },
    {
      name: 'github',
      status: { state: 'needs_auth', detail: 'OAuth sign-in needed' },
      tools: [{ name: 'create_issue', description: 'Open an issue' }],
    },
    {
      name: 'flaky',
      status: { state: 'crashed', detail: 'exited with code 1\nstack…' },
      tools: [{ name: 'run' }],
    },
    { name: 'off', enabled: false, tools: [{ name: 'secret_tool' }] },
  ];
  rebuild();
});

const textOf = (result: CallToolResult) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');

/**
 * No recorded event carries answers, state or secret values. Since Sprint 6 call events carry
 * the (redacted) arguments and result for the call log; nothing else is allowed.
 */
function expectCleanEvents(...forbidden: string[]) {
  const serialized = JSON.stringify({ searches: recorder.searches, calls: recorder.calls });
  for (const value of forbidden) expect(serialized).not.toContain(value);
  expect(serialized).not.toMatch(/mcpier1\./);
  expect(serialized).not.toContain('inputResponses');
  expect(serialized).not.toContain('requestState');
  for (const event of recorder.calls) {
    expect(Object.keys(event).sort()).toEqual(
      expect.arrayContaining(['at', 'client', 'durationMs', 'era', 'outcome', 'tool']),
    );
    for (const key of Object.keys(event)) {
      expect([
        'at',
        'client',
        'era',
        'tool',
        'server',
        'durationMs',
        'outcome',
        'traceId',
        'arguments',
        'result',
        'resultBytes',
        'errorText',
      ]).toContain(key);
    }
  }
}

describe('list_servers', () => {
  it('lists enabled servers with status detail and enabled tool counts', () => {
    const result = listServers(ctx);
    const servers = (result.structuredContent as { servers: Record<string, unknown>[] }).servers;
    expect(servers).toEqual([
      { name: 'files', description: 'Local files', status: 'ready', tools: 2 },
      { name: 'github', status: 'needs_auth', detail: 'needs sign-in in MCPier', tools: 1 },
      { name: 'flaky', status: 'crashed', detail: 'crashed: exited with code 1', tools: 1 },
    ]);
    const text = textOf(result);
    expect(text).toContain('github (needs_auth: needs sign-in in MCPier)');
    expect(text).not.toContain('off');
  });

  it('says so when nothing is connected', () => {
    manager.servers = [];
    expect(textOf(listServers(ctx))).toContain('No servers');
  });
});

describe('search_tools', () => {
  it('returns matches with schema, hints, availability and server status', () => {
    const result = searchTools(ctx, { query: 'file' }, MODERN);
    expect(result.isError).toBeUndefined();
    const { results } = result.structuredContent as { results: Record<string, unknown>[] };
    expect(results.map((match) => match.name)).toEqual(['files__read_file', 'files__write_file']);
    expect(results[0]).toMatchObject({
      server: 'files',
      description: 'Read a file',
      readOnlyHint: true,
      available: true,
      inputSchema: { properties: { path: { type: 'string' } } },
    });
    expect(results[1]).toMatchObject({ destructiveHint: true });
    expect(textOf(result)).toContain('files__read_file (read-only)');
    expect(recorder.searches).toEqual([
      expect.objectContaining({
        query: 'file',
        era: 'modern',
        client: { name: 'test-client', version: '1.0' },
        resultCount: 2,
        results: ['files__read_file', 'files__write_file'],
      }),
    ]);
  });

  it('includes unavailable tools after available ones, with the server status', () => {
    const result = searchTools(ctx, { query: 'issue' }, MODERN);
    const { results } = result.structuredContent as { results: Record<string, unknown>[] };
    expect(results[0]).toMatchObject({
      name: 'github__create_issue',
      available: false,
      serverStatus: 'needs_auth',
    });
    expect(textOf(result)).toContain('[unavailable: server needs sign-in in MCPier]');
  });

  it('never returns disabled tools or tools of disabled servers', () => {
    const all = searchTools(ctx, { query: 'secret hidden tool', limit: 20 }, MODERN);
    const { results } = all.structuredContent as { results: { name: string }[] };
    expect(results.map((match) => match.name)).not.toContain('off__secret_tool');
    expect(results.map((match) => match.name)).not.toContain('files__hidden_tool');
  });

  it('an empty query with no server is an error result', () => {
    const result = searchTools(ctx, { query: '  ' }, MODERN);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('list_servers');
    expect(recorder.searches).toHaveLength(1);
  });

  it('an empty query with a server lists that server’s tools up to the limit', () => {
    const result = searchTools(ctx, { server: 'files', limit: 1 }, MODERN);
    const { results } = result.structuredContent as { results: { name: string }[] };
    expect(results.map((match) => match.name)).toEqual(['files__read_file']);
  });

  it('an unknown server is an error result listing the valid names', () => {
    const result = searchTools(ctx, { query: 'x', server: 'nope' }, MODERN);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Valid server names: files, github, flaky.');
    const disabled = searchTools(ctx, { query: 'x', server: 'off' }, MODERN);
    expect(textOf(disabled)).toContain('disabled');
  });

  it('clamps the limit between 1 and 20', () => {
    manager.servers = [
      { name: 'many', tools: Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}` })) },
    ];
    rebuild();
    const count = (limit: number) =>
      (searchTools(ctx, { query: 'tool', limit }, MODERN).structuredContent as { results: unknown[] }).results
        .length;
    expect(count(0)).toBe(1);
    expect(count(100)).toBe(20);
    expect(count(3)).toBe(3);
  });

  it('outlines an input schema above the threshold', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(40) }]),
    );
    const inputSchema = { type: 'object', properties, required: ['field_0'] };
    expect(JSON.stringify(inputSchema).length).toBeGreaterThan(SCHEMA_OUTLINE_THRESHOLD_BYTES);
    manager.servers = [{ name: 'big', tools: [{ name: 'huge', inputSchema }] }];
    rebuild();
    const result = searchTools(ctx, { query: 'huge' }, MODERN);
    const match = (result.structuredContent as { results: Record<string, unknown>[] }).results[0]!;
    expect(match.inputSchemaOutlined).toBe(true);
    const outline = match.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      description: string;
    };
    expect(outline.properties.field_0).toEqual({ type: 'string' });
    expect(outline.required).toEqual(['field_0']);
    expect(outline.description).toContain('call_tool');
    expect(JSON.stringify(outline).length).toBeLessThan(SCHEMA_OUTLINE_THRESHOLD_BYTES);
  });
});

describe('call_tool checks, in order', () => {
  it('1. an unknown name suggests up to three likely names', async () => {
    const result = (await callTool(ctx, { name: 'files__read_fil' }, MODERN)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'There is no tool named "files__read_fil". Did you mean: files__read_file',
    );
    expect(recorder.calls[0]).toMatchObject({ tool: 'files__read_fil', outcome: 'not_found' });
    expect(recorder.calls[0]!.server).toBeUndefined();
    expect(manager.calls).toHaveLength(0);
  });

  it('2. a disabled tool, and a tool of a disabled server', async () => {
    const tool = (await callTool(ctx, { name: 'files__hidden_tool' }, MODERN)) as CallToolResult;
    expect(textOf(tool)).toContain('is disabled in MCPier');
    expect(textOf(tool)).toContain('mcpier tools enable files__hidden_tool');
    const server = (await callTool(ctx, { name: 'off__secret_tool' }, MODERN)) as CallToolResult;
    expect(textOf(server)).toContain('The server "off" is disabled in MCPier');
    expect(textOf(server)).toContain('mcpier server enable off');
    expect(textOf(server)).toContain('Servers page of the MCPier dashboard');
    expect(recorder.calls.map((event) => event.outcome)).toEqual(['disabled', 'disabled']);
    expect(manager.calls).toHaveLength(0);
  });

  it('2. a disabled server that never listed tools still reads as disabled', async () => {
    manager.servers.push({ name: 'never', enabled: false, tools: [] });
    const result = (await callTool(ctx, { name: 'never__anything' }, MODERN)) as CallToolResult;
    expect(textOf(result)).toContain('The server "never" is disabled');
    expect(textOf(result)).toContain('mcpier server enable never');
    expect(recorder.calls[0]).toMatchObject({ server: 'never', outcome: 'disabled' });
  });

  it('3. a server that is not ready names its state and what to do', async () => {
    const auth = (await callTool(ctx, { name: 'github__create_issue' }, MODERN)) as CallToolResult;
    expect(auth.isError).toBe(true);
    expect(textOf(auth)).toContain('needs sign-in');
    expect(textOf(auth)).toContain('sign in to "github" in MCPier');
    const crashed = (await callTool(ctx, { name: 'flaky__run' }, MODERN)) as CallToolResult;
    expect(textOf(crashed)).toContain('crashed (exited with code 1)');
    expect(textOf(crashed)).toContain('restart it in MCPier');
    expect(recorder.calls.map((event) => event.outcome)).toEqual(['not_ready', 'not_ready']);
    expect(manager.calls).toHaveLength(0);
  });

  it('3. comes before validation', async () => {
    manager.servers[1]!.tools[0]!.inputSchema = { type: 'object', required: ['title'] };
    const result = (await callTool(
      ctx,
      { name: 'github__create_issue', arguments: {} },
      MODERN,
    )) as CallToolResult;
    expect(recorder.calls[0]!.outcome).toBe('not_ready');
    expect(textOf(result)).not.toContain('input schema');
  });

  it('4. invalid arguments list each problem with its location, then the full schema', async () => {
    const result = (await callTool(
      ctx,
      { name: 'files__read_file', arguments: { path: 7 } },
      MODERN,
    )) as CallToolResult;
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('- arguments.path: must be string');
    expect(text).toContain('Full input schema:');
    expect(text).toContain('"required": [');
    expect(recorder.calls[0]!.outcome).toBe('validation_error');
    expect(manager.calls).toHaveLength(0);
    // The call log keeps what was sent, so the user can see why it failed.
    expect(recorder.calls[0]!.arguments).toEqual({ path: 7 });
    expect(recorder.calls[0]!.errorText).toContain('do not match its input schema');
    expectCleanEvents();
  });

  it('missing arguments mean an empty object', async () => {
    await callTool(ctx, { name: 'files__write_file' }, MODERN);
    expect(manager.calls[0]!.args).toEqual({});
  });

  it('5. passes the trace context, signal and nothing else from the caller', async () => {
    const controller = new AbortController();
    await callTool(
      ctx,
      { name: 'files__read_file', arguments: { path: 'a.txt' } },
      {
        ...LEGACY,
        meta: { traceparent: TRACEPARENT, progressToken: 5, other: 'x' },
        signal: controller.signal,
      },
    );
    expect(manager.calls[0]!.options.traceMeta).toEqual({ traceparent: TRACEPARENT });
    expect(manager.calls[0]!.options.signal).toBe(controller.signal);
    expect(manager.calls[0]!.options.elicitation).toBeUndefined();
    expect(recorder.calls[0]).toMatchObject({
      outcome: 'ok',
      era: 'legacy',
      server: 'files',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    });
  });

  it('5. upstream error results pass through unchanged', async () => {
    const upstream: CallToolResult = {
      content: [{ type: 'text', text: 'Nope: [secret:key]' }],
      isError: true,
    };
    manager.handler = async () => ({ kind: 'result', result: upstream, durationMs: 1 });
    const result = await callTool(ctx, { name: 'files__write_file' }, MODERN);
    expect(result).toEqual(upstream);
    expect(recorder.calls[0]!.outcome).toBe('tool_error');
  });

  it('5. a timeout becomes an error result naming it', async () => {
    manager.handler = async () => {
      throw new CallTimeoutError('files', 'write_file', 1500);
    };
    const result = (await callTool(ctx, { name: 'files__write_file' }, MODERN)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('timed out after');
    expect(recorder.calls[0]!.outcome).toBe('timeout');
  });

  it('5. a cancelled call becomes an error result naming it', async () => {
    const controller = new AbortController();
    manager.handler = async (_tool, _args, options) => {
      controller.abort();
      throw options.signal?.reason ?? new Error('aborted');
    };
    const result = (await callTool(
      ctx,
      { name: 'files__write_file' },
      { ...MODERN, signal: controller.signal },
    )) as CallToolResult;
    expect(textOf(result)).toContain('was cancelled');
    expect(recorder.calls[0]!.outcome).toBe('cancelled');
  });

  it('5. a server that stops being ready mid-way is reported as not ready', async () => {
    manager.handler = async () => {
      manager.servers[0]!.status = { state: 'starting' };
      throw new ConflictError('not ready', 'not_ready');
    };
    const result = (await callTool(ctx, { name: 'files__write_file' }, MODERN)) as CallToolResult;
    expect(textOf(result)).toContain('still starting');
    expect(recorder.calls[0]!.outcome).toBe('not_ready');
  });

  it('5. other failures are error results with secret values redacted', async () => {
    manager.handler = async () => {
      throw new Error(`connection reset while sending ${SECRET}`);
    };
    const result = (await callTool(ctx, { name: 'files__write_file' }, MODERN)) as CallToolResult;
    expect(textOf(result)).toContain('failed: connection reset while sending [secret:stub]');
    expect(textOf(result)).not.toContain(SECRET);
    expect(recorder.calls[0]!.outcome).toBe('failed');
  });

  it('5. an upstream refusing input_required (-32021) reads as input the client cannot give', async () => {
    manager.handler = async () => {
      throw Object.assign(new Error('missing capability'), { code: -32021 });
    };
    const result = (await callTool(ctx, { name: 'files__write_file' }, LEGACY)) as CallToolResult;
    expect(textOf(result)).toContain('cannot provide');
    expect(recorder.calls[0]!.outcome).toBe('input_required');
  });
});

describe('validation', () => {
  beforeEach(() => {
    manager.servers = [
      { name: 'rich', tools: [{ name: 'rich_input', inputSchema: RICH_INPUT_SCHEMA as never }] },
    ];
    rebuild();
  });

  const valid = {
    name: 'Ada',
    kind: 'person',
    address: { street: '1 Main St', zip: '12345' },
    contact: { email: 'ada@example.com' },
    tags: ['a'],
  };
  const call = (args: Record<string, unknown>) =>
    callTool(ctx, { name: 'rich__rich_input', arguments: args }, MODERN) as Promise<CallToolResult>;

  it('valid input passes', async () => {
    const result = await call(valid);
    expect(result.isError).toBeUndefined();
    expect(manager.calls).toHaveLength(1);
  });

  it.each([
    [
      'a missing required property',
      { ...valid, kind: undefined },
      "arguments: must have required property 'kind'",
    ],
    ['a wrong type', { ...valid, name: 3 }, 'arguments.name: must be string'],
    [
      'a nested pattern',
      { ...valid, address: { street: 'x', zip: 'abc' } },
      'arguments.address.zip: must match pattern',
    ],
    ['an enum', { ...valid, kind: 'robot' }, 'arguments.kind: must be one of "person", "company"'],
    [
      'an array limit',
      { ...valid, tags: ['a', 'b', 'c', 'd'] },
      'arguments.tags: must NOT have more than 3 items',
    ],
    ['an array item', { ...valid, tags: [1] }, 'arguments.tags[0]: must be string'],
    ['oneOf', { ...valid, contact: { fax: 1 } }, 'arguments.contact: must match exactly one schema in oneOf'],
  ])('reports %s with its location', async (_label, args, problem) => {
    const result = await call(JSON.parse(JSON.stringify(args)));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(problem);
    expect(manager.calls).toHaveLength(0);
  });

  it('reports several problems at once', async () => {
    const result = await call({ name: '', kind: 'robot', address: {} });
    const problems = textOf(result)
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts a draft-07 schema', async () => {
    manager.servers = [
      {
        name: 'old',
        tools: [
          {
            name: 'echo',
            inputSchema: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    ];
    const bad = (await callTool(ctx, { name: 'old__echo', arguments: {} }, MODERN)) as CallToolResult;
    expect(textOf(bad)).toContain("must have required property 'text'");
    const good = (await callTool(
      ctx,
      { name: 'old__echo', arguments: { text: 'hi' } },
      MODERN,
    )) as CallToolResult;
    expect(good.isError).toBeUndefined();
  });

  it('never fetches a remote reference: the schema is skipped and calls go through', async () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      throw new Error('no network in tests');
    }) as typeof fetch;
    try {
      manager.servers = [
        {
          name: 'remote',
          tools: [
            {
              name: 'ref',
              inputSchema: { type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' } } },
            },
          ],
        },
      ];
      const result = (await callTool(
        ctx,
        { name: 'remote__ref', arguments: { a: 1 } },
        MODERN,
      )) as CallToolResult;
      expect(result.isError).toBeUndefined();
      expect(manager.calls).toHaveLength(1);
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('skips a schema deeper than the limit', async () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { next: deep } };
    manager.servers = [{ name: 'deep', tools: [{ name: 'nest', inputSchema: deep }] }];
    const result = (await callTool(
      ctx,
      { name: 'deep__nest', arguments: { next: 'wrong type' } },
      MODERN,
    )) as CallToolResult;
    expect(result.isError).toBeUndefined();
    expect(manager.calls).toHaveLength(1);
  });

  it('recompiles when a tool’s schema changes', async () => {
    const tool = manager.servers[0]!.tools[0]!;
    expect((await call({ anything: 1 })).isError).toBe(true);
    tool.inputSchema = { type: 'object' };
    expect((await call({ anything: 1 })).isError).toBeUndefined();
  });
});

describe('truncation', () => {
  it('cuts text at resultSizeLimitKb and says how much was shown and dropped', async () => {
    settings = { ...settings, resultSizeLimitKb: 1 };
    manager.handler = async () => ({
      kind: 'result',
      result: {
        content: [
          { type: 'text', text: 'a'.repeat(800) },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'b'.repeat(800) },
          { type: 'text', text: 'c'.repeat(800) },
        ],
      },
      durationMs: 1,
    });
    const result = (await callTool(ctx, { name: 'files__write_file' }, MODERN)) as CallToolResult;
    const blocks = result.content;
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image', 'text', 'text']);
    expect((blocks[0] as { text: string }).text).toHaveLength(800);
    expect((blocks[2] as { text: string }).text).toHaveLength(224);
    expect((blocks[3] as { text: string }).text).toContain(
      'output truncated. Showed 1.0 KB of 2.3 KB; 1.3 KB dropped',
    );
    expect(blocks[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });

  it('never splits a multi-byte character', async () => {
    settings = { ...settings, resultSizeLimitKb: 1 };
    manager.handler = async () => ({
      kind: 'result',
      result: { content: [{ type: 'text', text: '€'.repeat(1000) }] },
      durationMs: 1,
    });
    const result = (await callTool(ctx, { name: 'files__write_file' }, MODERN)) as CallToolResult;
    const kept = (result.content[0] as { text: string }).text;
    expect(kept).toBe('€'.repeat(341));
  });

  it('drops structured content over the limit, with a note', async () => {
    settings = { ...settings, resultSizeLimitKb: 1 };
    manager.handler = async () => ({
      kind: 'result',
      result: { content: [{ type: 'text', text: 'small' }], structuredContent: { data: 'y'.repeat(2048) } },
      durationMs: 1,
    });
    const result = (await callTool(ctx, { name: 'files__write_file' }, MODERN)) as CallToolResult;
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toContain('structured content of 2.0 KB dropped');
  });

  it('leaves results under the limit untouched', async () => {
    const upstream: CallToolResult = {
      content: [{ type: 'text', text: 'small' }],
      structuredContent: { a: 1 },
    };
    manager.handler = async () => ({ kind: 'result', result: upstream, durationMs: 1 });
    expect(await callTool(ctx, { name: 'files__write_file' }, MODERN)).toEqual(upstream);
  });
});

describe('input_required', () => {
  const UPSTREAM_STATE = 'upstream-opaque-state-with-private-data';
  const ELICIT = {
    method: 'elicitation/create',
    params: { mode: 'form', message: 'Sure?', requestedSchema: { type: 'object', properties: {} } },
  };

  beforeEach(() => {
    manager.handler = async (_tool, _args, options) =>
      options.requestState === undefined
        ? {
            kind: 'input_required',
            inputRequired: {
              resultType: 'input_required',
              inputRequests: { confirm: ELICIT },
              requestState: UPSTREAM_STATE,
            },
            durationMs: 1,
          }
        : { kind: 'result', result: { content: [{ type: 'text', text: 'done' }] }, durationMs: 1 };
  });

  async function firstCall(caller: Caller = MODERN) {
    return callTool(ctx, { name: 'files__write_file', arguments: { x: 1 } }, caller);
  }

  it('a modern client with elicitation gets MCPier’s own signed state', async () => {
    const result = (await firstCall()) as {
      resultType: string;
      inputRequests: unknown;
      requestState: string;
    };
    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests).toEqual({ confirm: ELICIT });
    expect(result.requestState).toMatch(/^mcpier1\./);
    expect(result.requestState).not.toContain(UPSTREAM_STATE);
    expect(manager.calls[0]!.options.elicitation).toEqual({ form: {} });
    expect(recorder.calls[0]!.outcome).toBe('input_required');
  });

  it('the retry unwraps the state and passes the answers upstream', async () => {
    const first = (await firstCall()) as { requestState: string };
    const answers = { confirm: { action: 'accept', content: { ok: true } } };
    const retry = (await callTool(
      ctx,
      { name: 'files__write_file', arguments: { x: 1 } },
      { ...MODERN, requestState: first.requestState, inputResponses: answers },
    )) as CallToolResult;
    expect(textOf(retry)).toBe('done');
    expect(manager.calls[1]!.options).toMatchObject({
      requestState: UPSTREAM_STATE,
      inputResponses: answers,
    });
    expect(manager.calls[1]!.args).toEqual({ x: 1 });
    expect(recorder.calls.map((event) => event.outcome)).toEqual(['input_required', 'ok']);
    // The arguments are recorded; the answers and both states never are.
    expect(recorder.calls[1]!.arguments).toEqual({ x: 1 });
    expect(recorder.calls[0]!.result).toEqual({
      resultType: 'input_required',
      inputRequests: expect.any(Object),
    });
    expectCleanEvents(UPSTREAM_STATE, first.requestState, '"accept"', 'confirm":{"action');
  });

  it('a legacy client gets an error result instead', async () => {
    const result = (await firstCall(LEGACY)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cannot provide');
    expect(manager.calls[0]!.options.elicitation).toBeUndefined();
    expect(recorder.calls[0]!.outcome).toBe('input_required');
  });

  it('a modern client without elicitation gets the error result', async () => {
    const result = (await firstCall({ era: 'modern', client: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  it('requests other than elicitation are not passed through', async () => {
    manager.handler = async () => ({
      kind: 'input_required',
      inputRequired: {
        resultType: 'input_required',
        inputRequests: { s: { method: 'sampling/createMessage', params: {} } },
      },
      durationMs: 1,
    });
    const result = (await firstCall()) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  async function retryWith(
    state: string,
    name = 'files__write_file',
    args: Record<string, unknown> = { x: 1 },
  ) {
    return (await callTool(
      ctx,
      { name, arguments: args },
      { ...MODERN, requestState: state, inputResponses: {} },
    )) as CallToolResult;
  }

  it('rejects a tampered state', async () => {
    const { requestState } = (await firstCall()) as { requestState: string };
    const [prefix, body, mac] = requestState.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), u: 'other' }),
    ).toString('base64url');
    for (const bad of [`${prefix}.${forged}.${mac}`, `${requestState}x`, 'garbage', `${prefix}.${body}.`]) {
      const result = await retryWith(bad);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('expired or is not valid');
    }
    expect(manager.calls).toHaveLength(1);
  });

  it('rejects an expired state', async () => {
    const { requestState } = (await firstCall()) as { requestState: string };
    clock += 15 * 60_000 + 1;
    expect(textOf(await retryWith(requestState))).toContain('expired or is not valid');
    expect(manager.calls).toHaveLength(1);
  });

  it('accepts a state just before expiry', async () => {
    const { requestState } = (await firstCall()) as { requestState: string };
    clock += 15 * 60_000 - 1;
    expect(textOf(await retryWith(requestState))).toBe('done');
  });

  it('rejects a state reused with a different tool', async () => {
    const { requestState } = (await firstCall()) as { requestState: string };
    expect(textOf(await retryWith(requestState, 'files__read_file', { path: 'a.txt' }))).toContain(
      'expired or is not valid',
    );
    expect(manager.calls).toHaveLength(1);
  });

  it('rejects a state signed with another key', async () => {
    const other = new RequestStateSigner(randomBytes(32), () => clock);
    const foreign = other.sign({ server: 'files', tool: 'files__write_file', upstream: 'x' });
    expect(textOf(await retryWith(foreign))).toContain('expired or is not valid');
  });
});

describe('recorded events', () => {
  it('every call is recorded with client, era and timing, and its bodies for the call log', async () => {
    manager.handler = async () => ({
      kind: 'result',
      result: { content: [{ type: 'text', text: 'RESULT-BODY' }] },
      durationMs: 1,
    });
    await callTool(ctx, { name: 'files__write_file', arguments: { secretArg: 'ARG-VALUE' } }, MODERN);
    await callTool(ctx, { name: 'nope__nope', arguments: { secretArg: 'ARG-VALUE' } }, LEGACY);
    searchTools(ctx, { query: 'file' }, { era: 'admin', client: { name: 'mcpier-cli' } });
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0]).toMatchObject({
      client: { name: 'test-client', version: '1.0' },
      era: 'modern',
    });
    expect(recorder.calls[1]).toMatchObject({ era: 'legacy', outcome: 'not_found' });
    expect(recorder.searches[0]).toMatchObject({ era: 'admin', client: { name: 'mcpier-cli' } });
    for (const event of recorder.calls) expect(typeof event.durationMs).toBe('number');
    expect(recorder.calls[0]).toMatchObject({
      arguments: { secretArg: 'ARG-VALUE' },
      result: { content: [{ type: 'text', text: 'RESULT-BODY' }] },
    });
    expect(recorder.calls[0]!.errorText).toBeUndefined();
    expect(recorder.calls[1]!.errorText).toContain('There is no tool named');
    expect(recorder.searches[0]).toMatchObject({
      limit: 5,
      results: ['files__read_file', 'files__write_file'],
    });
    expectCleanEvents();
  });
});
