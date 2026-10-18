import { EventEmitter } from 'node:events';
import {
  cleanErrorMessage,
  type ServerEntry,
  type ServerStatus,
  type ServerStatusInfo,
  type Settings,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { ChildGuard, Platform, SecretStore } from '../platform/index.js';
import { createRedactor, redactDeep, type Redactor } from '../secrets/redact.js';
import { MissingSecretError, resolveServerSecrets } from '../secrets/resolve.js';
import { HttpConnector } from '../upstream/http-connector.js';
import type { OAuthChange, OAuthService } from '../oauth/service.js';
import { ServerLog } from '../upstream/server-log.js';
import { StdioConnector } from '../upstream/stdio-connector.js';
import {
  ConnectError,
  NeedsAuthError,
  formatMs,
  type CallOptions,
  type Connector,
  type Tool,
  type UpstreamCallResult,
  type UpstreamServerInfo,
} from '../upstream/types.js';
import { ConflictError } from './errors.js';

/** Lifecycle thresholds. Injectable so tests run in milliseconds instead of minutes. */
export interface ManagerTiming {
  /** How often a `ready` server is checked. */
  healthIntervalMs: number;
  /** Time limit for one health check. */
  healthTimeoutMs: number;
  /** First reconnect delay; doubles each time (1, 2, 4, 8 … s). */
  backoffBaseMs: number;
  /** Reconnect delay cap. */
  backoffMaxMs: number;
  /** A stdio server failing this many times within `crashWindowMs` is marked `crashed`. */
  crashLimit: number;
  crashWindowMs: number;
  /** Shortest wait before refreshing a modern server's tool list after its `ttlMs`. */
  minTtlRefreshMs: number;
}

export const DEFAULT_TIMING: ManagerTiming = {
  healthIntervalMs: 60_000,
  healthTimeoutMs: 10_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  crashLimit: 5,
  crashWindowMs: 5 * 60_000,
  minTtlRefreshMs: 5000,
};

export interface RuntimeContext {
  platform: Platform;
  secrets: SecretStore;
  baseEnv: NodeJS.ProcessEnv;
  settings: () => Settings;
  timing: ManagerTiming;
  logger: Logger;
  guard?: ChildGuard;
  /** Sign-in for `auth: "oauth"` servers. Without it such servers stay `needs_auth`. */
  oauth?: OAuthService;
}

export interface RuntimeEvents {
  status: [info: ServerStatusInfo];
  tools: [];
  /** A reconnect was scheduled (for tests and the dashboard). */
  retry: [delayMs: number, attempt: number];
}

/**
 * One configured server: its status, its connector while connected, its last known tools,
 * and the timers for health checks, reconnects and tool refreshes.
 *
 * Every asynchronous step checks `generation`, so the result of an attempt that was
 * overtaken by a stop or restart is discarded instead of changing state.
 */
export class ServerRuntime extends EventEmitter<RuntimeEvents> {
  private statusInfo: ServerStatusInfo = { state: 'stopped', since: new Date().toISOString() };
  private connector: Connector | undefined;
  private lastTools: Tool[] = [];
  private lastProtocolVersion: string | undefined;
  private lastServerInfo: UpstreamServerInfo | undefined;
  private readySince: number | undefined;
  private generation = 0;
  private failures: number[] = [];
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private ttlTimer: NodeJS.Timeout | undefined;
  private redact: Redactor = (text) => text;
  private starting: Promise<void> | undefined;
  private disposed = false;

  constructor(
    public entry: ServerEntry,
    readonly log: ServerLog,
    private readonly context: RuntimeContext,
  ) {
    super();
  }

  get name(): string {
    return this.entry.name;
  }

  get status(): ServerStatusInfo {
    return this.statusInfo;
  }

  get tools(): readonly Tool[] {
    return this.lastTools;
  }

  get protocolVersion(): string | undefined {
    return this.connector?.protocolVersion ?? this.lastProtocolVersion;
  }

  /** The logo and website the server named when it last connected (icons). */
  get serverInfo(): UpstreamServerInfo | undefined {
    return this.lastServerInfo;
  }

  get uptimeSeconds(): number | undefined {
    return this.statusInfo.state === 'ready' && this.readySince !== undefined
      ? Math.round((Date.now() - this.readySince) / 1000)
      : undefined;
  }

  /** Process id of a running stdio server (for tests and diagnostics). */
  get pid(): number | undefined {
    return this.connector instanceof StdioConnector ? this.connector.pid : undefined;
  }

  /** Resolves when the current start attempt has settled (ready or failed). */
  settled(): Promise<void> {
    return this.starting ?? Promise.resolve();
  }

  private setStatus(state: ServerStatus, detail?: string): void {
    const cleanDetail = detail === undefined ? undefined : this.redact(detail);
    if (this.statusInfo.state === state && this.statusInfo.detail === cleanDetail) return;
    // The sentence inside a wrapped JSON-RPC or OAuth error, for the dashboard (the raw text stays).
    const readable = cleanDetail ? cleanErrorMessage(cleanDetail).message : undefined;
    this.statusInfo = {
      state,
      since: new Date().toISOString(),
      ...(cleanDetail ? { detail: cleanDetail } : {}),
      ...(readable && readable !== cleanDetail ? { detailMessage: readable } : {}),
    };
    if (state !== 'ready') this.readySince = undefined;
    const fields = { server: this.name, status: state, ...(cleanDetail ? { detail: cleanDetail } : {}) };
    if (state === 'error' || state === 'crashed') this.context.logger.warn(fields, 'Server status changed');
    else this.context.logger.info(fields, 'Server status changed');
    this.emit('status', this.statusInfo);
  }

  /** Starts the server (no-op if it is already starting or ready). Clears crash history. */
  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.statusInfo.state === 'ready' || this.statusInfo.state === 'starting') return this.settled();
    this.failures = [];
    this.attempt = 0;
    return this.begin();
  }

  private begin(): Promise<void> {
    const generation = ++this.generation;
    this.clearTimers();
    this.setStatus('starting');
    this.starting = this.connect(generation).finally(() => {
      if (this.generation === generation) this.starting = undefined;
    });
    return this.starting;
  }

  private async connect(generation: number): Promise<void> {
    const entry = this.entry;
    const oauth = entry.transport === 'http' && entry.auth === 'oauth' ? this.context.oauth : undefined;
    if (entry.transport === 'http' && entry.auth === 'oauth') {
      // Decided from the stored sign-in alone: no network call without tokens.
      const state = oauth ? await oauth.connectState(entry) : undefined;
      if (generation !== this.generation) return;
      if (!state || !state.ok) {
        const detail = state && !state.ok ? state.error.message : 'Sign in required';
        this.log.write('mcpier', `Not connecting: ${detail}`);
        this.setStatus('needs_auth', detail);
        return;
      }
    }

    let resolved;
    try {
      resolved = await resolveServerSecrets(entry, this.context.secrets);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof MissingSecretError) {
        // Retrying cannot help until the secret is set, and setting it restarts the server.
        this.log.write('mcpier', `Not started: ${error.message}`);
        this.setStatus('error', error.message);
        return;
      }
      this.setStatus('error', `Could not read secrets: ${(error as Error).message}`);
      this.scheduleRetry(generation);
      return;
    }
    if (generation !== this.generation) return;

    const configured = createRedactor(resolved.values);
    // OAuth tokens change on every refresh, so they are looked up each time.
    this.redact = oauth
      ? (text) => createRedactor(oauth.secretValues(entry.name))(configured(text))
      : configured;
    this.log.setRedactor(this.redact);
    const connector: Connector =
      entry.transport === 'stdio'
        ? new StdioConnector(entry, {
            platform: this.context.platform,
            log: this.log,
            baseEnv: this.context.baseEnv,
            extraPath: this.context.settings().extraPath,
            env: resolved.env,
            redact: this.redact,
            guard: this.context.guard,
          })
        : new HttpConnector(entry, {
            log: this.log,
            headers: resolved.headers,
            redact: this.redact,
            ...(oauth ? { oauth: oauth.connectorAuth(entry.name) } : {}),
          });

    try {
      await connector.connect();
    } catch (error) {
      await connector.close().catch(() => {});
      if (generation !== this.generation) return;
      const message =
        error instanceof ConnectError ? error.message : this.redact(String((error as Error).message));
      if (error instanceof ConnectError && error.status === 'needs_auth') {
        this.setStatus('needs_auth', message);
        return;
      }
      this.fail(generation, message);
      return;
    }

    if (generation !== this.generation) {
      await connector.close().catch(() => {});
      return;
    }
    this.connector = connector;
    this.lastProtocolVersion = connector.protocolVersion;
    this.lastServerInfo = connector.serverInfo;
    connector.on('lost', (reason) => {
      if (generation !== this.generation || this.connector !== connector) return;
      this.connector = undefined;
      void connector.close().catch(() => {});
      this.fail(generation, reason);
    });
    connector.on('toolsChanged', () => {
      if (generation === this.generation) void this.refreshTools().catch(() => {});
    });

    // List the tools before announcing `ready`, so a ready server always has its catalog.
    // A failed listing is logged and the server is still usable.
    await this.refreshTools().catch(() => {});
    if (generation !== this.generation) return;
    this.attempt = 0;
    this.readySince = Date.now();
    this.setStatus('ready');
    this.scheduleHealthCheck(generation);
  }

  /**
   * A failure while running or starting: counts towards `crashed` for stdio servers, and
   * otherwise schedules a reconnect with backoff. HTTP servers never give up.
   */
  private fail(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    const now = Date.now();
    const { crashLimit, crashWindowMs } = this.context.timing;
    this.failures = [...this.failures.filter((at) => now - at < crashWindowMs), now];
    if (this.entry.transport === 'stdio' && this.failures.length >= crashLimit) {
      this.clearTimers();
      this.setStatus(
        'crashed',
        `${reason}\nFailed ${this.failures.length} times within ${formatMs(crashWindowMs)}; not restarting. ` +
          `Start or restart the server to try again.`,
      );
      this.log.write('mcpier', `Marked crashed after ${this.failures.length} failures`);
      return;
    }
    this.setStatus('error', reason);
    this.scheduleRetry(generation);
  }

  private scheduleRetry(generation: number): void {
    const { backoffBaseMs, backoffMaxMs } = this.context.timing;
    const delay = Math.min(backoffBaseMs * 2 ** this.attempt, backoffMaxMs);
    this.attempt++;
    this.log.write('mcpier', `Reconnecting in ${formatMs(delay)} (attempt ${this.attempt})`);
    this.emit('retry', delay, this.attempt);
    this.retryTimer = setTimeout(() => {
      if (generation === this.generation && !this.disposed) void this.begin();
    }, delay);
    this.retryTimer.unref();
  }

  private scheduleHealthCheck(generation: number): void {
    const { healthIntervalMs, healthTimeoutMs } = this.context.timing;
    this.healthTimer = setTimeout(async () => {
      const connector = this.connector;
      if (generation !== this.generation || !connector) return;
      try {
        await connector.check(healthTimeoutMs);
        if (generation === this.generation) this.scheduleHealthCheck(generation);
      } catch (error) {
        if (generation !== this.generation || this.connector !== connector) return;
        if (error instanceof NeedsAuthError) {
          this.enterNeedsAuth(error.message);
          return;
        }
        this.connector = undefined;
        await connector.close().catch(() => {});
        const message = this.redact((error as Error).message ?? String(error));
        this.log.write('mcpier', `Health check failed: ${message}`);
        this.fail(generation, `Health check failed: ${message}`);
      }
    }, healthIntervalMs);
    this.healthTimer.unref();
  }

  /**
   * The tools last listed in an earlier run (the tool cache), shown unavailable until the server
   * is ready. Ignored once the server has listed its tools itself.
   */
  seedTools(tools: readonly Tool[]): void {
    if (this.lastTools.length === 0) this.lastTools = [...tools];
  }

  /** Lists the server's tools again. Keeps the old list if listing fails. */
  async refreshTools(): Promise<void> {
    const connector = this.connector;
    if (!connector)
      throw new ConflictError(`Server "${this.name}" is ${this.statusInfo.state}, not ready.`, 'not_ready');
    const generation = this.generation;
    try {
      const listing = await connector.listTools();
      if (generation !== this.generation) return;
      this.lastTools = listing.tools;
      this.emit('tools');
      clearTimeout(this.ttlTimer);
      // A modern server says how long its list stays fresh; refresh it when that passes.
      if (listing.ttlMs !== undefined && listing.ttlMs > 0) {
        this.ttlTimer = setTimeout(
          () => void this.refreshTools().catch(() => {}),
          Math.max(listing.ttlMs, this.context.timing.minTtlRefreshMs),
        );
        this.ttlTimer.unref();
      }
    } catch (error) {
      this.log.write('mcpier', `Listing tools failed: ${this.redact((error as Error).message)}`);
      if (error instanceof NeedsAuthError && generation === this.generation)
        this.enterNeedsAuth(error.message);
      throw error;
    }
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: Omit<CallOptions, 'timeoutMs'> = {},
  ): Promise<UpstreamCallResult> {
    const connector = this.connector;
    if (!connector || this.statusInfo.state !== 'ready') {
      const detail = this.statusInfo.detail ? ` (${this.statusInfo.detail.split('\n')[0]})` : '';
      throw new ConflictError(
        `Server "${this.name}" is ${this.statusInfo.state}, not ready${detail}.`,
        'not_ready',
      );
    }
    let result: UpstreamCallResult;
    try {
      result = await connector.callTool(tool, args, { ...options, timeoutMs: this.entry.timeoutMs });
    } catch (error) {
      // The sign-in may have been dropped by this very call (a refused refresh), even when the
      // change event closed the connection first and the call only saw "connection closed".
      const lostSignIn = this.currentState() === 'needs_auth' && this.connector !== connector;
      if (!(error instanceof NeedsAuthError) && !lostSignIn) throw error;
      if (error instanceof NeedsAuthError && this.connector === connector) this.enterNeedsAuth(error.message);
      const detail = this.statusInfo.detail ?? (error as Error).message;
      throw new ConflictError(`Server "${this.name}" is needs_auth, not ready (${detail}).`, 'not_ready');
    }
    // Secret values the server echoes back (an env value, a header) never leave MCPier: this
    // covers results and, for input_required, the messages and schemas of each request.
    return redactDeep(result, this.redact);
  }

  /** The status now (a plain read, so it is not narrowed across an await). */
  private currentState(): ServerStatus {
    return this.statusInfo.state;
  }

  /** Text with this server's secret values removed (for error messages). */
  redactText(text: string): string {
    return this.redact(text);
  }

  /**
   * The OAuth server needs signing in (again): disconnect and wait in `needs_auth`. No retry:
   * only a sign-in (which restarts the server) can help.
   */
  private enterNeedsAuth(detail: string): void {
    this.generation++;
    this.clearTimers();
    const connector = this.connector;
    this.connector = undefined;
    this.starting = undefined;
    this.log.write('mcpier', `Disconnected: ${detail}`);
    this.setStatus('needs_auth', detail);
    void connector?.close().catch(() => {});
  }

  /** The server's sign-in changed (signed in or out, expired, step-up, client ID needed). */
  async authChanged(change: OAuthChange): Promise<void> {
    const entry = this.entry;
    const oauth = this.context.oauth;
    if (this.disposed || !entry.enabled || !oauth || entry.transport !== 'http' || entry.auth !== 'oauth')
      return;
    if (change === 'signed_in' || change === 'signed_out') {
      await this.restart();
      return;
    }
    if (change !== 'needs_auth') return;
    const state = await oauth.connectState(entry);
    if (state.ok || this.statusInfo.state === 'stopped') return;
    if (this.statusInfo.state === 'needs_auth') this.setStatus('needs_auth', state.error.message);
    else this.enterNeedsAuth(state.error.message);
  }

  /** Stops the server; its last known tools stay, marked unavailable. */
  async stop(): Promise<void> {
    this.generation++;
    this.clearTimers();
    const connector = this.connector;
    this.connector = undefined;
    this.starting = undefined;
    // Leave `ready` at once, so nobody calls a server that is going away.
    this.setStatus('stopped');
    await connector?.close().catch(() => {});
  }

  async restart(): Promise<void> {
    await this.stop();
    if (!this.disposed) await this.start();
  }

  private clearTimers(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.healthTimer);
    clearTimeout(this.ttlTimer);
    this.retryTimer = this.healthTimer = this.ttlTimer = undefined;
  }

  /** Stops the server for good and closes its log file (server removed or gateway shutting down). */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.log.close();
  }
}
