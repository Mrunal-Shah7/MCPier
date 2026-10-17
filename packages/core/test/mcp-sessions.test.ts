// Sprint 3: legacy (2025-era) sessions on /mcp: idle expiry, the cap with oldest-idle
// eviction, DELETE, clean 400s, and re-initializing after a gateway restart.
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startTestGateway, waitUntil, type TestGateway } from '../../../test/helpers/gateway.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

let t: TestGateway | undefined;
let home: TempHome | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
  await home?.cleanup();
  home = undefined;
});

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function post(body: unknown, sessionId?: string, protocol = '2025-11-25') {
  return fetch(`${t!.gateway.url}/mcp`, {
    method: 'POST',
    headers: {
      ...HEADERS,
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocol } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Reads a JSON or single-event SSE response body as a JSON-RPC message. */
async function message(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data:'))!
      .slice(5)
      .trim();
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

/** A legacy handshake by hand; returns the session id. */
async function initialize(name = 'raw-legacy'): Promise<string> {
  const response = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name, version: '1' } },
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  await response.text();
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);
  expect(initialized.status).toBe(202);
  return sessionId!;
}

async function listTools(sessionId: string): Promise<Response> {
  return post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
}

describe('legacy sessions', () => {
  it('serves a session, then ends it on DELETE', async () => {
    t = await startTestGateway();
    const id = await initialize();
    expect(t.gateway.mcp.sessionIds()).toEqual([id]);
    const listed = await message(await listTools(id));
    expect(JSON.stringify(listed)).toContain('call_tool');

    const deleted = await fetch(`${t.gateway.url}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' },
    });
    expect(deleted.status).toBe(200);
    await waitUntil(() => t!.gateway.mcp.sessionIds().length === 0);
    const after = await listTools(id);
    expect(after.status).toBe(404);
    expect(((await after.json()) as { error: { code: number } }).error.code).toBe(-32001);
  });

  it('answers an unknown session with 404, and requests without a session with a clean 400', async () => {
    t = await startTestGateway();
    expect((await listTools('no-such-session')).status).toBe(404);

    const noSession = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    expect(noSession.status).toBe(400);
    expect(((await noSession.json()) as { error: { message: string } }).error.message).toContain(
      'No valid session ID',
    );

    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${t.gateway.url}/mcp`, {
        method,
        headers: { accept: 'text/event-stream' },
      });
      expect(response.status).toBe(400);
      await response.text();
    }

    const garbage = await fetch(`${t.gateway.url}/mcp`, {
      method: 'POST',
      headers: HEADERS,
      body: '{ not json',
    });
    expect(garbage.status).toBe(400);
    await garbage.text();
  });

  it('closes a session left idle past the limit', async () => {
    t = await startTestGateway({ sessionLimits: { idleMs: 300, sweepIntervalMs: 50 } });
    const id = await initialize();
    await waitUntil(() => t!.gateway.mcp.sessionIds().length === 0, 5000);
    expect((await listTools(id)).status).toBe(404);
  });

  it('use keeps a session alive', async () => {
    t = await startTestGateway({ sessionLimits: { idleMs: 400, sweepIntervalMs: 50 } });
    const id = await initialize();
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await listTools(id)).status).toBe(200);
    }
  });

  it('at the cap, evicts the oldest idle session for a new one', async () => {
    t = await startTestGateway({ sessionLimits: { maxSessions: 2 } });
    const first = await initialize('first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await initialize('second');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Using the first makes the second the oldest idle one.
    expect((await listTools(first)).status).toBe(200);
    const third = await initialize('third');
    expect(t.gateway.mcp.sessionIds().sort()).toEqual([first, third].sort());
    expect((await listTools(second)).status).toBe(404);
    expect((await listTools(first)).status).toBe(200);
  });

  it('after a gateway restart, old sessions get 404 and the client can re-initialize', async () => {
    home = createTempHome();
    t = await startTestGateway({ home });
    const port = t.port;
    const id = await initialize();
    await t.gateway.stop('restart test');

    t = await startTestGateway({ home, port });
    const stale = await listTools(id);
    expect(stale.status).toBe(404);
    await stale.text();
    const fresh = await initialize();
    expect(fresh).not.toBe(id);
    expect((await listTools(fresh)).status).toBe(200);
  });

  it('shutdown closes every session, including open event streams', async () => {
    t = await startTestGateway();
    const client = new Client(
      { name: 'streaming', version: '1' },
      { versionNegotiation: { mode: 'legacy' } as never },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.gateway.url}/mcp`)));
    await waitUntil(() => t!.gateway.mcp.sessionIds().length === 1);
    const started = Date.now();
    await t.gateway.stop('shutdown test');
    // Well inside the 1 s grace period the test gateway uses: nothing held the server open.
    expect(Date.now() - started).toBeLessThan(900);
    expect(t.gateway.mcp.sessionIds()).toEqual([]);
    await client.close().catch(() => {});
  });
});
