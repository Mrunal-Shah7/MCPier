// Sprint 7, Phase 1: result sizes measured as the caller received them (after truncation, after
// redaction, with bodies on or off), search sizes, clean errors in the call routes, and the
// usage route over the admin API.
import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MODERN_PROTOCOL_VERSION, resultByteSize } from '@mcpier/core';
import {
  CALL_LOG_PATHS,
  USAGE_PATH,
  type CallDetail,
  type CallListResponse,
  type CallStatsResponse,
  type SearchListResponse,
  type UsageResponse,
} from '@mcpier/shared';
import { fixtureScripts, listenFixture } from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const SECRET = 'usage-api-secret-value-5151';

let home: TempHome;
let t: TestGateway;
let client: Client;

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
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

const latest = async (tool: string) => {
  const list = await api<CallListResponse>(
    'GET',
    `${CALL_LOG_PATHS.calls}?tool=${encodeURIComponent(tool)}&limit=1`,
  );
  return list.body.calls[0]!;
};

beforeAll(async () => {
  home = createTempHome();
  mkdirSync(home.dir, { recursive: true });
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
        { name: 'gone', transport: 'http', url: `http://127.0.0.1:${await getFreePort()}/mcp` },
      ],
    } as never,
  });
  await t.secrets.set('api-key', SECRET);
  await t.gateway.manager.restart('local');
  await waitForStatus(t.gateway, 'local', 'ready');
  t.gateway.meta.refresh();
  client = new Client(
    { name: 'usage-client', version: '1.0' },
    { capabilities: {}, versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } as never },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${t.gateway.url}/mcp`)));
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await t?.cleanup();
  await home?.cleanup();
});

describe('result sizes', () => {
  it('call_tool: measured after truncation; the admin route: the whole result', async () => {
    const viaMcp = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'local__big_output', arguments: { kb: 3 } },
    });
    const modelCall = await latest('local__big_output');
    const { _meta: _ignored, ...shown } = viaMcp as Record<string, unknown>;
    expect(modelCall.resultBytes).toBe(Buffer.byteLength(JSON.stringify(shown), 'utf8'));
    expect(modelCall.resultBytes).toBeLessThan(2 * 1024);
    expect(modelCall.estimatedTokens).toBe(Math.ceil(modelCall.resultBytes! / 4));

    await api('POST', '/api/tools/local__big_output/call', { arguments: { kb: 3 } });
    const raw = await latest('local__big_output');
    expect(raw.era).toBe('admin');
    expect(raw.resultBytes).toBeGreaterThan(3 * 1024);
  });

  it('is measured on the redacted result, and stored with bodies off too', async () => {
    await api('PATCH', '/api/settings', { storeCallBodies: false });
    await api('POST', '/api/tools/local__env_echo/call', { arguments: { name: 'API_SECRET' } });
    const call = await latest('local__env_echo');
    expect(call.bodiesStored).toBe(false);
    const redacted = { content: [{ type: 'text', text: '[secret:api-key]' }] };
    expect(call.resultBytes).toBe(resultByteSize(redacted));
    await api('PATCH', '/api/settings', { storeCallBodies: true });
  });

  it('a refused call gets size 0: the caller received no result', async () => {
    await api('POST', '/api/tools/gone__anything/call', { arguments: {} });
    expect((await latest('gone__anything')).resultBytes).toBe(0);
  });

  it('a search stores the size of what search_tools returned', async () => {
    const answer = await client.callTool({ name: 'search_tools', arguments: { query: 'echo text' } });
    const { _meta: _ignored, ...shown } = answer as Record<string, unknown>;
    const searches = await api<SearchListResponse>('GET', `${CALL_LOG_PATHS.searches}?client=usage-client`);
    expect(searches.body.searches[0]!.resultBytes).toBe(Buffer.byteLength(JSON.stringify(shown), 'utf8'));
    expect(searches.body.searches[0]!.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('clean errors in the call routes', () => {
  it('lists, details and stats return the clean message next to the raw text', async () => {
    const wrapped = `MCP error -32603: ${JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Deep failure' } })}`;
    await api('POST', '/api/tools/local__fail/call', { arguments: { message: wrapped } });
    const item = await latest('local__fail');
    expect(item).toMatchObject({ outcome: 'tool_error', errorMessage: 'Deep failure', errorCode: -32603 });
    expect(item.errorText).toContain('MCP error -32603');
    const detail = await api<CallDetail>('GET', CALL_LOG_PATHS.call(item.id));
    expect(detail.body).toMatchObject({ errorMessage: 'Deep failure', errorText: item.errorText });
    const stats = await api<CallStatsResponse>('GET', CALL_LOG_PATHS.stats);
    expect(stats.body.calls.tokens).toBeGreaterThan(0);
    expect(stats.body.calls.callsWithoutSize).toBe(0);
    expect(stats.body.calls.byServer.find((row) => row.server === 'local')!.tokens).toBeGreaterThan(0);
  });

  it("a server's last error is also returned as a clean message", async () => {
    // A server that answers every request with a JSON-RPC error body.
    const broken = await listenFixture(() =>
      Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The workspace is suspended' } },
        { status: 400 },
      ),
    );
    try {
      const seen: { detail?: string; detailMessage?: string }[] = [];
      t.gateway.manager.on('status', (name, info) => {
        if (name === 'wrapped' && info.state === 'error') seen.push(info);
      });
      await api('POST', '/api/servers', {
        name: 'wrapped',
        transport: 'http',
        url: broken.url,
        protocol: 'legacy',
      });
      await waitUntil(() => seen.length > 0);
      // The raw text keeps the wrapper; the clean message is the sentence inside it.
      expect(seen[0]!.detail).toContain('"jsonrpc"');
      expect(seen[0]!.detailMessage).toBe('The workspace is suspended');
      // A plain error has nothing to unwrap: only the raw detail is sent.
      await waitUntil(() => t.gateway.manager.status('gone').state === 'error');
      const gone = t.gateway.manager.status('gone');
      if (gone.detailMessage !== undefined) expect(gone.detailMessage).not.toBe(gone.detail);
      await api('DELETE', '/api/servers/wrapped');
    } finally {
      await broken.close();
    }
  });
});

describe('GET /api/usage', () => {
  it('answers a named range with every bucket, and the call sizes', async () => {
    const day = await api<UsageResponse>('GET', `${USAGE_PATH}?range=24h`);
    expect(day.status).toBe(200);
    expect(day.body.bucket).toBe('hour');
    expect(day.body.series).toHaveLength(24);
    expect(day.body.totals.calls).toBeGreaterThan(0);
    expect(day.body.totals.tokens).toBeGreaterThan(0);
    expect(day.body.totals.searches).toBeGreaterThan(0);
    expect(day.body.totals.searchTokens).toBeGreaterThan(0);
    expect(day.body.byServer.map((row) => row.server)).toContain('local');
    expect(day.body.byClient.map((row) => row.client)).toEqual(
      expect.arrayContaining(['usage-client', 'admin-api']),
    );
    const week = await api<UsageResponse>('GET', `${USAGE_PATH}?range=7d&server=local`);
    expect(week.body).toMatchObject({ bucket: 'day', server: 'local', clipped: false });
    expect(week.body.series).toHaveLength(7);
    expect(week.body.byServer.map((row) => row.server)).toEqual(['local']);
  });

  it('takes from, to and bucket, and every tool with tools=all', async () => {
    const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const answer = await api<UsageResponse>(
      'GET',
      `${USAGE_PATH}?from=${encodeURIComponent(from)}&bucket=day&tools=all`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.series.length).toBeGreaterThanOrEqual(4);
    expect(answer.body.heaviestTools.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses bad parameters', async () => {
    for (const query of [
      '',
      '?range=1y',
      '?range=7d&from=2026-01-01T00:00:00Z',
      '?from=yesterday',
      '?from=2026-10-10T00:00:00Z&to=2026-10-01T00:00:00Z',
      '?from=2026-01-01T00:00:00Z&bucket=hour',
      '?range=7d&bucket=week',
      '?range=7d&tools=some',
    ]) {
      const answer = await api<{ error: { code: string } }>('GET', `${USAGE_PATH}${query}`);
      expect(answer.status, query).toBe(400);
      expect(answer.body.error.code).toBe('invalid_request');
    }
  });
});
