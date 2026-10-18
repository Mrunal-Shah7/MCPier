import { EventEmitter } from 'node:events';
import { StreamableHTTPClientTransport, type Client } from '@modelcontextprotocol/client';
import type { HttpServerEntry } from '@mcpier/shared';
import type { Redactor } from '../secrets/redact.js';
import {
  callUpstreamTool,
  checkAlive,
  createUpstreamClient,
  httpStatus,
  isAuthFailure,
  isNetworkError,
  isTimeout,
  isUnsupportedVersion,
  MODERN_PROTOCOL_VERSION,
  negotiationMode,
  rootMessage,
} from './client.js';
import type { ConnectorAuth } from '../oauth/service.js';
import type { ServerLog } from './server-log.js';
import {
  CallTimeoutError,
  ConnectError,
  type CallOptions,
  type Connector,
  type ConnectorEvents,
  type ToolListing,
  pickServerInfo,
  type UpstreamCallResult,
  type UpstreamServerInfo,
} from './types.js';

/** Network errors are retried this many extra times, for connecting and listing only. */
const NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 500;

export interface HttpConnectorOptions {
  log: ServerLog;
  /** The server's `headers` with secret references resolved. Never logged. */
  headers: Record<string, string>;
  redact: Redactor;
  /** For an `auth: "oauth"` server: the signed-in tokens, refresh and step-up handling. */
  oauth?: ConnectorAuth;
}

/**
 * A remote server over Streamable HTTP. A 2026-07-28 server gets plain self-contained
 * requests; a legacy server gets one session, re-initialized once when the server reports it
 * expired (HTTP 404 for that session).
 */
export class HttpConnector extends EventEmitter<ConnectorEvents> implements Connector {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  /** Set after the first connect, so re-initializing skips the version probe. */
  private era: 'legacy' | 'modern' | undefined;
  private reconnecting: Promise<void> | undefined;

  constructor(
    private readonly entry: HttpServerEntry,
    private readonly options: HttpConnectorOptions,
  ) {
    super();
  }

  get protocolVersion(): string | undefined {
    return this.client?.getNegotiatedProtocolVersion();
  }

  get serverInfo(): UpstreamServerInfo | undefined {
    return pickServerInfo(this.client?.getServerVersion());
  }

  async connect(): Promise<void> {
    if (this.entry.auth === 'oauth' && !this.options.oauth) {
      throw new ConnectError('Sign in required', 'needs_auth');
    }
    let attempt = 0;
    for (;;) {
      try {
        await this.open();
        const session = this.transport?.sessionId ? `, session ${shortId(this.transport.sessionId)}` : '';
        this.options.log.write(
          'mcpier',
          `Connected to ${this.entry.url} (protocol ${this.protocolVersion}${session})`,
        );
        return;
      } catch (error) {
        await this.discard();
        const needsAuth = await this.options.oauth?.classify(error);
        if (needsAuth) {
          this.options.log.write('mcpier', `Not connected: ${needsAuth.message}`);
          throw new ConnectError(needsAuth.message, 'needs_auth');
        }
        if (isNetworkError(error) && attempt < NETWORK_RETRIES) {
          attempt++;
          await delay(NETWORK_RETRY_DELAY_MS * attempt);
          continue;
        }
        const message = this.explain(error);
        this.options.log.write('mcpier', `Connect failed: ${message}`);
        throw new ConnectError(message);
      }
    }
  }

  private async open(): Promise<void> {
    const mode = this.era === 'legacy' ? 'legacy' : negotiationMode(this.entry.protocol);
    const client = createUpstreamClient(mode, {
      log: this.options.log,
      onToolsChanged: () => this.emit('toolsChanged'),
    });
    const oauth = this.options.oauth;
    const transport = new StreamableHTTPClientTransport(new URL(this.entry.url), {
      requestInit: { headers: this.options.headers },
      // MCPier's own provider: tokens from the encrypted store, refreshed before expiry and
      // once on a 401. A 403 insufficient_scope is reported, never answered with a browser flow.
      ...(oauth
        ? { authProvider: oauth.authProvider, fetch: oauth.fetch, onInsufficientScope: 'throw' as const }
        : {}),
    });
    this.client = client;
    this.transport = transport;
    await client.connect(transport, {
      timeout: this.entry.startupTimeoutMs,
      // Re-initializing a known legacy server skips the server/discover probe.
      ...(this.era === 'legacy' ? { prior: { kind: 'legacy' as const } } : {}),
    });
    this.era = client.getNegotiatedProtocolVersion() === MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy';
  }

  /** A user-facing explanation of a connect failure, with secret values removed. */
  private explain(error: unknown): string {
    const redact = this.options.redact;
    if (error instanceof Error && error.name === 'RefreshUnavailableError') return error.message;
    if (isAuthFailure(error) && this.options.oauth) {
      const status = httpStatus(error) ?? (/403/.test(String(error)) ? 403 : 401);
      return `The server refused access (HTTP ${status}) although MCPier is signed in to it.`;
    }
    if (isAuthFailure(error)) {
      const status = httpStatus(error) ?? (/403/.test(String(error)) ? 403 : 401);
      return (
        `The server answered HTTP ${status}: it needs credentials. Add a header with a secret reference ` +
        `(for example "Authorization: Bearer secret:<name>"), or set "auth" to "oauth" if it uses OAuth.`
      );
    }
    if (isUnsupportedVersion(error)) {
      return (
        `The server does not accept the 2025 initialize handshake (protocol "${this.entry.protocol}"). ` +
        `Set "protocol" to "auto" or "modern".`
      );
    }
    if (isTimeout(error)) {
      return `The server did not answer within ${this.entry.startupTimeoutMs / 1000} s (counted as unreachable).`;
    }
    if (isNetworkError(error)) return redact(`Cannot reach ${this.entry.url}: ${rootMessage(error)}`);
    const status = httpStatus(error);
    const message = redact((error as Error)?.message ?? String(error));
    return status ? `The server answered HTTP ${status}: ${message}` : message;
  }

  private live(): Client {
    if (!this.client) throw new Error(`Server "${this.entry.name}" is not connected.`);
    return this.client;
  }

  /** True when a legacy server forgot our session (it answers 404 for it). */
  private isExpiredSession(error: unknown): boolean {
    return this.era === 'legacy' && httpStatus(error) === 404 && Boolean(this.transport?.sessionId);
  }

  /** Opens a fresh session once; concurrent callers share the same re-initialize. */
  private async reinitialize(): Promise<void> {
    this.reconnecting ??= (async () => {
      this.options.log.write('mcpier', 'Session expired; re-initializing');
      await this.discard();
      try {
        await this.open();
        this.options.log.write(
          'mcpier',
          `Session re-initialized (session ${shortId(this.transport?.sessionId)})`,
        );
      } catch (error) {
        const message = this.explain(error);
        this.options.log.write('mcpier', `Re-initializing failed: ${message}`);
        throw new ConnectError(message);
      }
    })().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  /**
   * Runs an operation; if the legacy session expired, re-initializes once and retries once.
   * A 404 for the session means the request never ran, so even a tool call may be retried.
   */
  private async withSession<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    try {
      if (this.reconnecting) await this.reconnecting;
      try {
        return await operation(this.live());
      } catch (error) {
        if (!this.isExpiredSession(error)) throw error;
        await this.reinitialize();
        return await operation(this.live());
      }
    } catch (error) {
      // An OAuth server that needs signing in (again) says so with its own error type.
      const needsAuth = await this.options.oauth?.classify(error);
      if (needsAuth) throw needsAuth;
      throw error;
    }
  }

  async listTools(): Promise<ToolListing> {
    // Listing has no side effects, so network errors are retried here (never for calls).
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.withSession((client) =>
          client.listTools(undefined, { cacheMode: 'refresh', timeout: this.entry.timeoutMs }),
        );
        return { tools: result.tools, ttlMs: (result as { ttlMs?: number }).ttlMs };
      } catch (error) {
        if (!isNetworkError(error) || attempt >= NETWORK_RETRIES) throw error;
        attempt++;
        await delay(NETWORK_RETRY_DELAY_MS * attempt);
      }
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: CallOptions,
  ): Promise<UpstreamCallResult> {
    try {
      return await this.withSession((client) => callUpstreamTool(client, name, args, options));
    } catch (error) {
      if (isTimeout(error) && !options.signal?.aborted) {
        throw new CallTimeoutError(this.entry.name, name, options.timeoutMs);
      }
      throw error;
    }
  }

  async check(timeoutMs: number): Promise<void> {
    await this.withSession((client) => checkAlive(client, timeoutMs));
  }

  private async discard(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    await client?.close().catch(() => {});
  }

  async close(): Promise<void> {
    const hadClient = Boolean(this.client);
    // A legacy session is ended politely; servers that do not support it answer 405.
    await this.transport?.terminateSession().catch(() => {});
    await this.discard();
    if (hadClient) this.options.log.write('mcpier', 'Disconnected');
  }
}

function shortId(id: string | undefined): string {
  return id ? `${id.slice(0, 8)}…` : 'none';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
