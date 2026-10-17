// Fake legacy MCP server: protocol 2025-11-25, `initialize` handshake, Mcp-Session-Id sessions.
import { randomUUID } from 'node:crypto';
import { isInitializeRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { listenFixture, notFound, type RunningFixture } from './http-common.js';
import { createFakeServer } from './tools.js';

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });

export interface LegacyFixture extends RunningFixture {
  /** Session ids currently open. */
  sessionIds(): string[];
  /**
   * Test only: forgets every session, as a server restart or idle expiry would. The next
   * request with an old session id gets 404 "Session not found".
   */
  expireSessions(): Promise<void>;
}

/**
 * Starts the legacy fixture: one transport and server instance per session, created by an
 * `initialize` request and addressed afterwards by the `Mcp-Session-Id` header, the way a
 * 2025-era server works. Anything else without a valid session is rejected.
 */
export async function startLegacyServer(options: { port?: number } = {}): Promise<LegacyFixture> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const handle = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== '/mcp') return notFound();
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const transport = sessions.get(sessionId);
      return transport ? transport.handleRequest(request) : jsonRpcError(404, -32001, 'Session not found');
    }
    if (request.method !== 'POST')
      return jsonRpcError(400, -32000, 'Bad Request: No valid session ID provided');

    const body: unknown = await request.json().catch(() => undefined);
    if (!isInitializeRequest(body)) {
      return jsonRpcError(400, -32000, 'Bad Request: No valid session ID provided');
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await createFakeServer('fake-legacy-http', { legacyTools: true }).connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  };

  const fixture = await listenFixture(handle, options.port);
  return {
    ...fixture,
    sessionIds: () => [...sessions.keys()],
    expireSessions: async () => {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((transport) => transport.close()));
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      await fixture.close();
    },
  };
}
