// The client endpoint, /mcp (SPEC 4.2, 7.3). 2026-07-28 requests go to a stateless handler
// that builds a server per request; 2025-era requests go to sessionful transports that
// MCPier keeps in memory (idle expiry, a cap, DELETE).
import { randomUUID } from 'node:crypto';
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { Logger } from '../logger.js';
import { createMetaServer } from '../meta/mcp-server.js';
import type { MetaToolContext } from '../meta/meta-tools.js';

export const MCP_PATH = '/mcp';

export interface SessionLimits {
  /** A legacy session unused this long is closed. Default 30 minutes. */
  idleMs: number;
  /** Most legacy sessions at once; the oldest idle one is evicted for a new one. Default 100. */
  maxSessions: number;
  /** How often idle sessions are swept. Default 60 seconds. */
  sweepIntervalMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  idleMs: 30 * 60_000,
  maxSessions: 100,
  sweepIntervalMs: 60_000,
};

export interface McpEndpointOptions {
  meta: MetaToolContext;
  version: string;
  logger: Logger;
  limits?: Partial<SessionLimits>;
  /** Clock for idle expiry (tests). */
  now?: () => number;
}

interface LegacySession {
  id: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
  /** POST requests being answered right now (an open GET event stream does not count). */
  busy: number;
}

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });

const SESSION_NOT_FOUND = () => jsonRpcError(404, -32001, 'Session not found');
const NO_SESSION = () => jsonRpcError(400, -32000, 'Bad Request: No valid session ID provided');

export class McpEndpoint {
  private readonly modern;
  private readonly sessions = new Map<string, LegacySession>();
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly sweeper: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: McpEndpointOptions) {
    this.limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.modern = createMcpHandler(() => this.newServer('modern'), {
      legacy: 'reject',
      onerror: (error) => options.logger.debug({ err: { message: error.message } }, 'MCP request rejected'),
    });
    this.sweeper = setInterval(() => void this.sweep(), this.limits.sweepIntervalMs);
    this.sweeper.unref();
  }

  private newServer(era: 'modern' | 'legacy'): McpServer {
    return createMetaServer({
      meta: this.options.meta,
      era,
      version: this.options.version,
      logger: this.options.logger,
    });
  }

  /** Open legacy session ids (tests and status). */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async fetch(request: Request): Promise<Response> {
    if (this.closed) return jsonRpcError(503, -32000, 'MCPier is shutting down.');
    if (!(await isLegacyRequest(request).catch(() => true))) return this.modern.fetch(request);
    return this.legacy(request);
  }

  private async legacy(request: Request): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || this.isExpired(session)) {
        if (session) await this.closeSession(session, 'idle');
        return SESSION_NOT_FOUND();
      }
      return this.serve(session, request);
    }
    if (request.method !== 'POST') return NO_SESSION();
    const body: unknown = await request.json().catch(() => undefined);
    if (!isInitializeRequest(body)) return NO_SESSION();
    return this.initialize(request, body);
  }

  private async serve(session: LegacySession, request: Request): Promise<Response> {
    const counts = request.method === 'POST';
    session.lastUsed = this.now();
    if (counts) session.busy++;
    try {
      return await session.transport.handleRequest(request);
    } finally {
      if (counts) session.busy--;
      session.lastUsed = this.now();
    }
  }

  private async initialize(request: Request, body: unknown): Promise<Response> {
    if (this.sessions.size >= this.limits.maxSessions) {
      const idle = [...this.sessions.values()].filter((session) => session.busy === 0);
      const oldest = idle.sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) return jsonRpcError(503, -32000, 'Too many MCP sessions are busy. Try again shortly.');
      await this.closeSession(oldest, 'evicted');
    }
    const server = this.newServer('legacy');
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { id, transport, server, lastUsed: this.now(), busy: 0 });
        this.options.logger.info(
          { session: id.slice(0, 8), sessions: this.sessions.size },
          'MCP session opened',
        );
      },
      onsessionclosed: (id) => {
        const session = this.sessions.get(id);
        if (session) void this.closeSession(session, 'deleted');
      },
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  }

  private isExpired(session: LegacySession): boolean {
    return session.busy === 0 && this.now() - session.lastUsed >= this.limits.idleMs;
  }

  private async closeSession(session: LegacySession, reason: 'idle' | 'evicted' | 'deleted' | 'shutdown') {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    this.options.logger.info({ session: session.id.slice(0, 8), reason }, 'MCP session closed');
    await session.server.close().catch(() => {});
  }

  /** Closes sessions idle for longer than the limit. */
  async sweep(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].filter((s) => this.isExpired(s)).map((s) => this.closeSession(s, 'idle')),
    );
  }

  /** Closes every session and the modern handler (gateway shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((session) => this.closeSession(session, 'shutdown')));
    await this.modern.close();
  }
}
