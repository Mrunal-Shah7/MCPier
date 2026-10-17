import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMON_TOOL_NAMES,
  LEGACY_TOOL_NAMES,
  STATELESS_TOOL_NAMES,
  fixtureScripts,
  STDIO_ONLY_TOOL_NAMES,
  startLegacyServer,
  startStatelessServer,
  type RunningFixture,
} from '../src/index.js';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

function newClient(mode: 'legacy' | { pin: string }): Client {
  const client = new Client(
    { name: 'mcpier-fixture-smoke', version: '0.0.0' },
    { versionNegotiation: { mode } },
  );
  cleanups.push(() => client.close());
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? '').join('');
}

/** Lists the tools, then calls `echo` and `add`, checking text and structured output. */
async function smoke(client: Client, expectedTools: readonly string[]): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
  for (const tool of tools) {
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema.type).toBe('object');
  }

  const echo = await client.callTool({ name: 'echo', arguments: { text: 'hello fixture' } });
  expect(textOf(echo)).toBe('hello fixture');
  expect(echo.isError).toBeFalsy();

  const add = await client.callTool({ name: 'add', arguments: { a: 2, b: 40 } });
  expect(textOf(add)).toBe('42');
  expect(add.structuredContent).toEqual({ sum: 42 });
}

/** Runs an HTTP fixture's built entry as its own process and waits for its READY line. */
async function startFixtureProcess(script: string): Promise<{ url: string; child: ChildProcess }> {
  expect(existsSync(script), `${script} is missing; run "pnpm build" first`).toBe(true);
  const child = spawn(process.execPath, [script, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  cleanups.push(async () => child.kill());
  const lines = createInterface({ input: child.stdout! });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not report READY')), 10_000);
    lines.on('line', (line) => {
      const match = /^READY (\S+)$/.exec(line);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => reject(new Error(`fixture exited early with code ${code}`)));
  });
  return { url, child };
}

describe('fake stdio server', () => {
  const allTools = [...COMMON_TOOL_NAMES, ...STDIO_ONLY_TOOL_NAMES];

  function stdioTransport() {
    expect(existsSync(fixtureScripts.stdio), 'run "pnpm build" first').toBe(true);
    return new StdioClientTransport({
      command: process.execPath,
      args: [fixtureScripts.stdio],
      env: { ...(process.env as Record<string, string>), FIXTURE_TEST_VALUE: 'from-the-environment' },
      stderr: 'pipe',
    });
  }

  it('serves the 2025 handshake: lists tools, calls echo and add', async () => {
    const client = newClient('legacy');
    await client.connect(stdioTransport());
    expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);
    await smoke(client, allTools);
  });

  it(`also serves ${MODERN}`, async () => {
    const client = newClient({ pin: MODERN });
    await client.connect(stdioTransport());
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    await smoke(client, allTools);
  });

  it('writes to stderr on startup and on each call, and echoes environment variables', async () => {
    const transport = stdioTransport();
    const stderr: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    const client = newClient('legacy');
    await client.connect(transport);
    const env = await client.callTool({ name: 'env_echo', arguments: { name: 'FIXTURE_TEST_VALUE' } });
    expect(textOf(env)).toBe('from-the-environment');
    await client.callTool({ name: 'echo', arguments: { text: 'x' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = stderr.join('');
    expect(output).toMatch(/\[fake-stdio\] ready pid=\d+/);
    expect(output).toContain('[fake-stdio] call env_echo');
    expect(output).toContain('[fake-stdio] call echo');
  });
});

describe(`fake stateless HTTP server (${MODERN})`, () => {
  async function start(): Promise<RunningFixture> {
    const fixture = await startStatelessServer();
    cleanups.push(() => fixture.close());
    return fixture;
  }

  it('speaks 2026-07-28 with no session: lists tools, calls echo and add', async () => {
    const fixture = await start();
    const transport = new StreamableHTTPClientTransport(new URL(fixture.url));
    const client = newClient({ pin: MODERN });
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    await smoke(client, STATELESS_TOOL_NAMES);
    expect(transport.sessionId).toBeUndefined();
  });

  it('rejects a client that uses the legacy handshake', async () => {
    const fixture = await start();
    const client = newClient('legacy');
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(fixture.url)))).rejects.toThrow();
  });

  it('runs as a separate process on a chosen port and reports when ready', async () => {
    const { url } = await startFixtureProcess(fixtureScripts.statelessHttp);
    const client = newClient({ pin: MODERN });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    await smoke(client, STATELESS_TOOL_NAMES);
  });
});

describe(`fake legacy HTTP server (${LEGACY}, sessions)`, () => {
  it('speaks 2025-11-25 with a session id: lists tools, calls echo and add', async () => {
    const fixture = await startLegacyServer();
    cleanups.push(() => fixture.close());
    const transport = new StreamableHTTPClientTransport(new URL(fixture.url));
    const client = newClient('legacy');
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.sessionIds()).toEqual([transport.sessionId]);
    await smoke(client, LEGACY_TOOL_NAMES);
  });

  it('does not speak 2026-07-28', async () => {
    const fixture = await startLegacyServer();
    cleanups.push(() => fixture.close());
    const client = newClient({ pin: MODERN });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(fixture.url)))).rejects.toThrow();
  });

  it('runs as a separate process on a chosen port and reports when ready', async () => {
    const { url } = await startFixtureProcess(fixtureScripts.legacyHttp);
    const client = newClient('legacy');
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();
    await smoke(client, LEGACY_TOOL_NAMES);
  });
});
