// Sprint 3: `mcpier stdio`, the relay for clients that launch a command. Driven by the SDK's
// own stdio client (each mode) and by hand (raw JSON lines), against a temporary home.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MODERN_PROTOCOL_VERSION, probeHealth, serverLogPath } from '@mcpier/core';
import { fixtureScripts } from '@mcpier/test-fixtures';
import { CLI_ENTRY, runCli } from '../../../test/helpers/cli.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

type Mode = 'modern' | 'auto' | 'legacy';

let home: TempHome | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await home?.cleanup();
  home = undefined;
});

async function setup(config?: unknown): Promise<{ home: TempHome; port: number; env: NodeJS.ProcessEnv }> {
  home = createTempHome();
  const port = await getFreePort();
  mkdirSync(home.dir, { recursive: true });
  writeFileSync(
    home.paths.config,
    JSON.stringify(
      config ?? {
        servers: [
          { name: 'local', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
        ],
      },
    ),
  );
  return { home, port, env: home.env(port) };
}

interface Bridged {
  client: Client;
  stderr: () => string;
  errors: Error[];
}

async function connect(
  env: NodeJS.ProcessEnv,
  mode: Mode,
  answer?: Record<string, unknown>,
): Promise<Bridged> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'stdio'],
    env: env as Record<string, string>,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const errors: Error[] = [];
  const client = new Client(
    { name: `bridged-${mode}`, version: '1.0.0' },
    {
      capabilities: answer ? { elicitation: { form: {} } } : {},
      versionNegotiation: { mode: mode === 'modern' ? { pin: MODERN_PROTOCOL_VERSION } : mode } as never,
    },
  );
  if (answer)
    client.setRequestHandler(
      'elicitation/create',
      async () => ({ action: 'accept', content: answer }) as never,
    );
  client.onerror = (error) => errors.push(error);
  await client.connect(transport);
  clients.push(client);
  return { client, stderr: () => stderr, errors };
}

const textOf = (result: unknown) =>
  ((result as { content?: { type: string; text?: string }[] }).content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForTool(client: Client, name: string): Promise<void> {
  await waitUntil(async () => {
    const result = await client.callTool({ name: 'search_tools', arguments: { query: name, limit: 20 } });
    return (result.structuredContent as { results: { name: string; available: boolean }[] }).results.some(
      (match) => match.name === name && match.available,
    );
  });
}

describe.each<Mode>(['modern', 'auto', 'legacy'])('%s client through mcpier stdio', (mode) => {
  it('starts the gateway, relays the meta-tools, and keeps stdout to protocol messages', async () => {
    const { port, env } = await setup();
    const { client, stderr, errors } = await connect(env, mode);
    expect((await probeHealth(port)).kind).toBe('mcpier');
    // For modern and auto negotiation the SDK client first runs a disposable copy of the
    // command for its version probe; that copy may be the one that started the gateway.
    await waitUntil(() => /MCPier started|already running/.test(stderr()), 5000);
    const negotiated = client.getNegotiatedProtocolVersion();
    if (mode === 'legacy') expect(negotiated).not.toBe(MODERN_PROTOCOL_VERSION);
    else expect(negotiated).toBe(MODERN_PROTOCOL_VERSION);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'call_tool',
      'list_servers',
      'search_tools',
    ]);
    await waitForTool(client, 'local__add');
    const sum = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'local__add', arguments: { a: 1, b: 2 } },
    });
    expect(sum.structuredContent).toEqual({ sum: 3 });
    // A non-protocol line on stdout would surface here as a parse error.
    expect(errors).toEqual([]);
  });

  it('cancelling a call reaches the upstream server', async () => {
    const { home, env } = await setup();
    const { client } = await connect(env, mode);
    await waitForTool(client, 'local__slow');
    const log = serverLogPath(home.paths.logsDir, 'local');
    const count = (line: string) => readFileSync(log, 'utf8').split(line).length - 1;
    const controller = new AbortController();
    const pending = client
      .callTool(
        { name: 'call_tool', arguments: { name: 'local__slow', arguments: { ms: 20_000 } } },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    await waitUntil(() => count('call slow') > 0);
    controller.abort();
    await pending;
    await waitUntil(() => count('cancelled slow') > 0);
  });

  it('survives a gateway restart: the next call starts it again', async () => {
    const { port, env } = await setup();
    const { client, stderr, errors } = await connect(env, mode);
    await waitForTool(client, 'local__echo');
    expect((await runCli(['stop'], env)).code).toBe(0);
    expect((await probeHealth(port)).kind).toBe('none');

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'local__echo', arguments: { text: 'back' } },
    });
    // The server may still be starting right after the gateway comes back.
    if (result.isError) {
      await waitForTool(client, 'local__echo');
    } else {
      expect(textOf(result)).toBe('back');
    }
    expect((await probeHealth(port)).kind).toBe('mcpier');
    if (mode === 'legacy') await waitUntil(() => stderr().includes('re-initializing'), 5000);
    expect(errors).toEqual([]);
  });
});

describe('mcpier stdio', () => {
  it('reports "already running" on stderr and works with a gateway that is already up', async () => {
    const { env } = await setup();
    expect((await runCli(['start'], env)).code).toBe(0);
    const { client, stderr } = await connect(env, 'auto');
    await waitUntil(() => stderr().includes('already running'), 5000);
    expect((await client.listTools()).tools).toHaveLength(3);
  });

  it('passes elicitation through (modern): confirm_action round trip', async () => {
    const { port } = await setup({ servers: [] });
    // A stateless fixture is needed for confirm_action; run one in this test process.
    const { startStatelessServer } = await import('@mcpier/test-fixtures');
    const stateless = await startStatelessServer();
    try {
      writeFileSync(
        home!.paths.config,
        JSON.stringify({ servers: [{ name: 'modern', transport: 'http', url: stateless.url }] }),
      );
      const { client } = await connect(home!.env(port), 'modern', { confirm: true });
      await waitForTool(client, 'modern__confirm_action');
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'modern__confirm_action', arguments: { action: 'ship' } },
      });
      expect(textOf(result)).toBe('confirm_action ship: accepted (confirm=true)');
    } finally {
      await stateless.close();
    }
  });

  it('answers each request with an error when the gateway cannot start (corrupt config), and stays up', async () => {
    const { env } = await setup();
    writeFileSync(home!.paths.config, '{ corrupt');
    const child = spawn(process.execPath, [CLI_ENTRY, 'stdio'], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    try {
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      await waitUntil(() => stdout.trim().split('\n').filter(Boolean).length >= 2);
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: number; error?: { message: string } });
      expect(lines.map((line) => line.id).sort()).toEqual([1, 2]);
      for (const line of lines) {
        expect(line.error?.message).toContain('could not be started');
        expect(line.error?.message).toContain('is invalid');
        expect(line.error?.message).toContain(home!.paths.gatewayLog);
      }
      expect(stderr).toContain('is invalid');
      expect(child.exitCode).toBeNull();

      // Fix the config: the next request starts the gateway.
      writeFileSync(home!.paths.config, '{}');
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      });
      await waitUntil(() => stdout.includes('"id":3'));
      const third = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
        result?: { serverInfo: { name: string } };
      };
      expect(third.result?.serverInfo.name).toBe('mcpier');
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  it.each<Mode>(['legacy', 'modern'])(
    '%s: a gateway restarted between calls (stale session for legacy) is used without a hitch',
    async (mode) => {
      const { env } = await setup();
      const { client, stderr, errors } = await connect(env, mode);
      await waitForTool(client, 'local__echo');
      // Stop and start again before the next call: the gateway is answering, but a legacy
      // client's session id is unknown to it (404), so the bridge must replay initialize.
      expect((await runCli(['stop'], env)).code).toBe(0);
      expect((await runCli(['start'], env)).code).toBe(0);
      await waitForTool(client, 'local__echo');
      const result = await client.callTool({
        name: 'call_tool',
        arguments: { name: 'local__echo', arguments: { text: 'after restart' } },
      });
      expect(textOf(result)).toBe('after restart');
      if (mode === 'legacy') await waitUntil(() => stderr().includes('re-initializing'), 5000);
      expect(errors).toEqual([]);
    },
  );

  it('a call cut off by the gateway stopping gets an error, not silence', async () => {
    const { env } = await setup();
    const { client } = await connect(env, 'legacy');
    await waitForTool(client, 'local__slow');
    const pending = client
      .callTool({ name: 'call_tool', arguments: { name: 'local__slow', arguments: { ms: 20_000 } } })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runCli(['stop'], env);
    const outcome = (await pending) as { result?: unknown; error?: Error };
    // Either the gateway's own error result for the cancelled call, or the bridge's error.
    if (outcome.error) expect(outcome.error.message).toMatch(/MCPier|gateway/);
    else expect((outcome.result as { isError?: boolean }).isError).toBe(true);
  });

  it('two bridges racing to start the gateway both name the gateway that is serving', async () => {
    // A fresh home: the race also covers first-run setup (one admin token, not two).
    home = createTempHome();
    const env = home.env(await getFreePort());
    const bridges = [0, 1].map(() =>
      spawn(process.execPath, [CLI_ENTRY, 'stdio'], { env, windowsHide: true }),
    );
    const stderr = ['', ''];
    bridges.forEach((child, index) =>
      child.stderr.on('data', (chunk: Buffer) => (stderr[index] += chunk.toString('utf8'))),
    );
    try {
      await waitUntil(() =>
        stderr.every((text) => /MCPier (started|is running|is already running)/.test(text)),
      );
      const serving = JSON.parse(readFileSync(home.paths.pidFile, 'utf8')) as { pid: number };
      for (const text of stderr) {
        const named = /\(pid (\d+)\)/.exec(text);
        expect(named?.[1]).toBe(String(serving.pid));
      }
      // At most one of them may say it started the gateway.
      expect(stderr.filter((text) => text.includes('MCPier started')).length).toBeLessThanOrEqual(1);
      // The CLI's token still matches the gateway's: the shared home was set up once.
      const status = await runCli(['status', '--json'], env);
      expect(JSON.parse(status.stdout)).toMatchObject({ running: true, pid: serving.pid });
    } finally {
      for (const child of bridges) child.stdin.end();
      await Promise.all(bridges.map((child) => new Promise((resolve) => child.once('exit', resolve))));
    }
  });

  it('exits when stdin ends', async () => {
    const { env } = await setup();
    const child = spawn(process.execPath, [CLI_ENTRY, 'stdio'], { env, windowsHide: true });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
  });
});
