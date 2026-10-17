import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ServerEntrySchema, type HttpServerEntry, type StdioServerEntry } from '@mcpier/shared';
import {
  fixtureScripts,
  startLegacyServer,
  startStatelessServer,
  STATELESS_TOOL_NAMES,
} from '@mcpier/test-fixtures';
import {
  CallTimeoutError,
  ConnectError,
  createRedactor,
  FakeSecretStore,
  getPlatform,
  HttpConnector,
  resolveServerSecrets,
  ServerLog,
  serverLogPath,
  StdioConnector,
  type CallToolResult,
  type Connector,
} from '../src/index.js';
import { getFreePort } from '../../../test/helpers/ports.js';

const SECRET = 'sk-test-secret-value-9f8e7d6c';
const platform = getPlatform();

let logsDir: string;
const open: Connector[] = [];

beforeAll(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'mcpier-connectors-'));
});

afterEach(async () => {
  for (const connector of open.splice(0)) await connector.close().catch(() => {});
});

afterAll(() => {
  // No secret value may appear in any server log written by these tests.
  for (const file of readdirSync(logsDir)) {
    expect(readFileSync(join(logsDir, file), 'utf8'), file).not.toContain(SECRET);
  }
  rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function stdioEntry(name: string, extra: Record<string, unknown> = {}): StdioServerEntry {
  return ServerEntrySchema.parse({
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [fixtureScripts.stdio],
    ...extra,
  }) as StdioServerEntry;
}

function httpEntry(name: string, url: string, extra: Record<string, unknown> = {}): HttpServerEntry {
  return ServerEntrySchema.parse({ name, transport: 'http', url, ...extra }) as HttpServerEntry;
}

async function makeStdio(entry: StdioServerEntry, store = new FakeSecretStore()) {
  const resolved = await resolveServerSecrets(entry, store);
  const redact = createRedactor(resolved.values);
  const log = new ServerLog(entry.name, serverLogPath(logsDir, entry.name), () => {});
  log.setRedactor(redact);
  const connector = new StdioConnector(entry, {
    platform,
    log,
    baseEnv: process.env,
    extraPath: [],
    env: resolved.env,
    redact,
  });
  open.push(connector);
  return { connector, log, logFile: serverLogPath(logsDir, entry.name) };
}

async function makeHttp(entry: HttpServerEntry, store = new FakeSecretStore()) {
  const resolved = await resolveServerSecrets(entry, store);
  const redact = createRedactor(resolved.values);
  const log = new ServerLog(entry.name, serverLogPath(logsDir, entry.name), () => {});
  log.setRedactor(redact);
  const connector = new HttpConnector(entry, { log, headers: resolved.headers, redact });
  open.push(connector);
  return { connector, logFile: serverLogPath(logsDir, entry.name) };
}

function textOf(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content ?? [])
    .map((block) => block.text ?? '')
    .join('');
}

async function connectError(connector: Connector): Promise<ConnectError> {
  const error = await connector.connect().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConnectError);
  return error as ConnectError;
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('stdio connector', () => {
  it.each([
    ['auto', '2025-11-25'],
    ['legacy', '2025-11-25'],
    ['modern', '2026-07-28'],
  ])('connects with protocol %s (negotiated %s) and calls echo and add', async (protocol, version) => {
    const { connector } = await makeStdio(stdioEntry(`stdio-${protocol}`, { protocol }));
    await connector.connect();
    expect(connector.protocolVersion).toBe(version);
    expect(textOf(await connector.callTool('echo', { text: 'hi' }, { timeoutMs: 5000 }))).toBe('hi');
    const add = (await connector.callTool('add', { a: 2, b: 3 }, { timeoutMs: 5000 })) as CallToolResult;
    expect(add.structuredContent).toEqual({ sum: 5 });
    const { tools } = await connector.listTools();
    expect(tools.map((tool) => tool.name)).toContain('env_echo');
  });

  it('in auto mode retries once with 2026-07-28 when the server rejects the handshake', async () => {
    const { connector, logFile } = await makeStdio(
      stdioEntry('stdio-modern-only', { args: [fixtureScripts.stdio, '--modern-only'] }),
    );
    await connector.connect();
    expect(connector.protocolVersion).toBe('2026-07-28');
    expect(readFileSync(logFile, 'utf8')).toContain('retrying with protocol 2026-07-28');
  });

  it('in legacy mode does not retry against a modern-only server', async () => {
    const { connector } = await makeStdio(
      stdioEntry('stdio-legacy-only', { protocol: 'legacy', args: [fixtureScripts.stdio, '--modern-only'] }),
    );
    const error = await connectError(connector);
    expect(error.message).toContain('rejected the 2025 initialize handshake');
  });

  it('runs ten concurrent slow calls on one process, each with its own result', async () => {
    const { connector } = await makeStdio(stdioEntry('stdio-concurrent'));
    await connector.connect();
    const delays = Array.from({ length: 10 }, (_, index) => 100 + index * 10);
    const results = await Promise.all(
      delays.map((ms) => connector.callTool('slow', { ms }, { timeoutMs: 10_000 })),
    );
    expect(results.map(textOf)).toEqual(delays.map((ms) => `waited ${ms} ms`));
  });

  it('times out a slow call, cancels it upstream, and stays usable', async () => {
    const { connector, logFile } = await makeStdio(stdioEntry('stdio-timeout'));
    await connector.connect();
    const error = await connector.callTool('slow', { ms: 5000 }, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallTimeoutError);
    expect((error as Error).message).toContain('timed out after 300 ms');
    await waitFor(() => readFileSync(logFile, 'utf8').includes('[fake-stdio] cancelled slow'));
    expect(textOf(await connector.callTool('echo', { text: 'still here' }, { timeoutMs: 5000 }))).toBe(
      'still here',
    );
  });

  it('returns a failing tool as an error result, not an exception', async () => {
    const { connector } = await makeStdio(stdioEntry('stdio-fail'));
    await connector.connect();
    const result = (await connector.callTool(
      'fail',
      { message: 'nope' },
      { timeoutMs: 5000 },
    )) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('nope');
  });

  it('passes env values resolved from a secret reference, and keeps them out of the log', async () => {
    const store = new FakeSecretStore();
    await store.set('fixture-token', SECRET);
    const { connector, logFile } = await makeStdio(
      stdioEntry('stdio-env', { env: { FIXTURE_TOKEN: 'secret:fixture-token', PLAIN_VALUE: 'plain' } }),
      store,
    );
    await connector.connect();
    // The connector returns results raw; the manager redacts them (Phase 3).
    const env = await connector.callTool('env_echo', { name: 'FIXTURE_TOKEN' }, { timeoutMs: 5000 });
    expect(textOf(env)).toBe(SECRET);
    expect(textOf(await connector.callTool('env_echo', { name: 'PLAIN_VALUE' }, { timeoutMs: 5000 }))).toBe(
      'plain',
    );
    expect(readFileSync(logFile, 'utf8')).not.toContain(SECRET);
  });

  it('writes stderr lines, protocol log messages and connection events to the server log', async () => {
    const lines: string[] = [];
    const entry = stdioEntry('stdio-log');
    const log = new ServerLog(entry.name, serverLogPath(logsDir, entry.name), (line) =>
      lines.push(line.line),
    );
    const connector = new StdioConnector(entry, {
      platform,
      log,
      baseEnv: process.env,
      extraPath: [],
      env: {},
      redact: (text) => text,
    });
    open.push(connector);
    await connector.connect();
    await connector.callTool('log_message', { message: 'hello from the protocol' }, { timeoutMs: 5000 });
    await waitFor(() => lines.some((line) => line.includes('hello from the protocol')));
    const file = readFileSync(serverLogPath(logsDir, entry.name), 'utf8');
    expect(file).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[stderr\] \[fake-stdio\] ready pid=\d+$/m);
    expect(file).toMatch(/\[stderr\] \[fake-stdio\] call log_message$/m);
    expect(file).toMatch(/\[server\] info fixture: hello from the protocol$/m);
    expect(file).toMatch(/\[mcpier\] Connected \(pid \d+, protocol 2025-11-25\)$/m);
  });

  it('emits toolsChanged when the server announces a new tool list', async () => {
    const { connector } = await makeStdio(stdioEntry('stdio-changed'));
    await connector.connect();
    let changed = 0;
    connector.on('toolsChanged', () => changed++);
    await connector.callTool('change_tools', {}, { timeoutMs: 5000 });
    await waitFor(() => changed > 0);
    expect((await connector.listTools()).tools.map((tool) => tool.name)).toContain('added_tool');
  });

  it('reports a lost connection when the process exits', async () => {
    const { connector } = await makeStdio(stdioEntry('stdio-crash'));
    await connector.connect();
    const lost = new Promise<string>((resolve) => connector.on('lost', resolve));
    await connector.callTool('crash', {}, { timeoutMs: 2000 }).catch(() => {});
    expect(await lost).toContain('exited with code 1');
  });

  it('stops the process on close', async () => {
    const { connector } = await makeStdio(stdioEntry('stdio-close'));
    await connector.connect();
    const pid = connector.pid!;
    expect(platform.processes.isAlive(pid)).toBe(true);
    await connector.close();
    expect(platform.processes.isAlive(pid)).toBe(false);
  });
});

describe('stdio start failures (B-1)', () => {
  it('reports a bare command that does not exist, with the stderr text', async () => {
    const { connector } = await makeStdio(
      stdioEntry('missing-bare', { command: 'mcpier-no-such-command-x1', args: ['foo'] }),
    );
    const error = await connectError(connector);
    expect(error.message).toMatch(
      /^The command "mcpier-no-such-command-x1" was not found. Check the spelling, or add its folder to the "extraPath" setting./,
    );
    expect(error.message).toContain('Last stderr lines:');
    expect(error.message).toMatch(
      /'mcpier-no-such-command-x1' is not recognized as an internal or external command/,
    );
  });

  it('reports a command path that does not exist', async () => {
    const { connector } = await makeStdio(
      stdioEntry('missing-path', { command: 'C:\\no\\such\\dir\\server.exe' }),
    );
    const error = await connectError(connector);
    expect(error.message).toBe('Command not found: C:\\no\\such\\dir\\server.exe');
  });

  it('stops a server that never finishes connecting, and reports the startup timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpier-hang-'));
    const pidFile = join(dir, 'pid.txt');
    const script = join(dir, 'hang.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    );
    try {
      const { connector } = await makeStdio(
        stdioEntry('hangs', { args: [script, pidFile], startupTimeoutMs: 1500 }),
      );
      const started = Date.now();
      const error = await connectError(connector);
      expect(Date.now() - started).toBeLessThan(6000);
      expect(error.message).toContain('did not finish starting within 1500 ms and was stopped');
      expect(error.message).toContain('startupTimeoutMs');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(platform.processes.isAlive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HTTP connector: stateless server (2026-07-28)', () => {
  let fixture: Awaited<ReturnType<typeof startStatelessServer>>;
  beforeAll(async () => {
    fixture = await startStatelessServer();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it.each([['auto'], ['modern']])('connects with protocol %s and calls tools', async (protocol) => {
    const { connector } = await makeHttp(httpEntry(`stateless-${protocol}`, fixture.url, { protocol }));
    await connector.connect();
    expect(connector.protocolVersion).toBe('2026-07-28');
    expect(textOf(await connector.callTool('echo', { text: 'x' }, { timeoutMs: 5000 }))).toBe('x');
    const listing = await connector.listTools();
    expect(listing.tools).toHaveLength(STATELESS_TOOL_NAMES.length);
    expect(listing.ttlMs).toBe(0);
  });

  it('fails clearly in legacy mode', async () => {
    const { connector } = await makeHttp(httpEntry('stateless-legacy', fixture.url, { protocol: 'legacy' }));
    const error = await connectError(connector);
    expect(error.message).toBe(
      'The server does not accept the 2025 initialize handshake (protocol "legacy"). Set "protocol" to "auto" or "modern".',
    );
  });

  it('sends headers with secret references resolved', async () => {
    const store = new FakeSecretStore();
    await store.set('api-token', SECRET);
    const { connector, logFile } = await makeHttp(
      httpEntry('stateless-headers', fixture.url, {
        headers: { Authorization: 'Bearer secret:api-token', 'X-Plain': 'plain-value' },
      }),
      store,
    );
    await connector.connect();
    await connector.callTool('echo', { text: 'x' }, { timeoutMs: 5000 });
    const last = fixture.receivedHeaders().at(-1)!;
    expect(last.authorization).toBe(`Bearer ${SECRET}`);
    expect(last['x-plain']).toBe('plain-value');
    expect(readFileSync(logFile, 'utf8')).not.toContain(SECRET);
  });
});

describe('HTTP connector: legacy server (2025-11-25 sessions)', () => {
  let fixture: Awaited<ReturnType<typeof startLegacyServer>>;
  beforeAll(async () => {
    fixture = await startLegacyServer();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it.each([['auto'], ['legacy']])('connects with protocol %s and calls tools', async (protocol) => {
    const { connector } = await makeHttp(httpEntry(`legacy-${protocol}`, fixture.url, { protocol }));
    await connector.connect();
    expect(connector.protocolVersion).toBe('2025-11-25');
    expect(textOf(await connector.callTool('echo', { text: 'y' }, { timeoutMs: 5000 }))).toBe('y');
  });

  it('re-initializes once after the session expires and the next call succeeds', async () => {
    const { connector, logFile } = await makeHttp(httpEntry('legacy-expiry', fixture.url));
    await connector.connect();
    const before = fixture.sessionIds();
    await fixture.expireSessions();
    expect(textOf(await connector.callTool('echo', { text: 'after expiry' }, { timeoutMs: 5000 }))).toBe(
      'after expiry',
    );
    const after = fixture.sessionIds();
    expect(after).toHaveLength(1);
    expect(before).not.toContain(after[0]);
    const log = readFileSync(logFile, 'utf8');
    expect(log.match(/Session expired; re-initializing/g)).toHaveLength(1);
    expect(log).toContain('Session re-initialized');
    // Health checks reuse the session instead of opening new ones.
    await connector.check(2000);
    await connector.check(2000);
    expect(fixture.sessionIds()).toEqual(after);
  });

  it('fails clearly when pinned to 2026-07-28', async () => {
    const { connector } = await makeHttp(httpEntry('legacy-modern', fixture.url, { protocol: 'modern' }));
    const error = await connectError(connector);
    expect(error.message).toMatch(/negotiation failed|2026-07-28/i);
  });
});

describe('HTTP connector: failures', () => {
  let denying: Server;
  let denyPort: number;
  let requests = 0;

  beforeAll(async () => {
    denying = createServer((_req, res) => {
      requests++;
      res.statusCode = 401;
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => denying.listen(0, '127.0.0.1', resolve));
    denyPort = (denying.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => denying.close(resolve));
  });

  it('reports an outage when nothing is listening', async () => {
    const port = await getFreePort();
    const { connector } = await makeHttp(httpEntry('outage', `http://127.0.0.1:${port}/mcp`));
    const error = await connectError(connector);
    expect(error.status).toBe('error');
    expect(error.message).toMatch(new RegExp(`^Cannot reach http://127\\.0\\.0\\.1:${port}/mcp: `));
  });

  it.each([['auto'], ['legacy']])('explains a 401 as missing credentials (protocol %s)', async (protocol) => {
    const { connector } = await makeHttp(
      httpEntry(`deny-${protocol}`, `http://127.0.0.1:${denyPort}/mcp`, { protocol }),
    );
    const error = await connectError(connector);
    expect(error.status).toBe('error');
    expect(error.message).toMatch(/^The server answered HTTP 401: it needs credentials\./);
  });

  it('marks an oauth server needs_auth without any network call when no sign-in is given', async () => {
    const before = requests;
    const { connector } = await makeHttp(
      httpEntry('oauth-server', `http://127.0.0.1:${denyPort}/mcp`, { auth: 'oauth' }),
    );
    const error = await connectError(connector);
    expect(error.status).toBe('needs_auth');
    expect(error.message).toBe('Sign in required');
    expect(requests).toBe(before);
  });
});

// Make sure the built fixture exists (the root test script builds first).
expect(existsSync(fixtureScripts.stdio)).toBe(true);
