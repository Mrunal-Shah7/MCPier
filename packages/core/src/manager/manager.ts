import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import {
  referencedSecretNames,
  splitFullToolName,
  type McpierConfig,
  type ServerEntry,
  type ServerStatus,
  type ServerStatusInfo,
  type ServerSummary,
  type Settings,
  type ToolInfo,
  type ConnectionTestResponse,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { OAuthService } from '../oauth/service.js';
import type { ToolCache } from '../store/tool-cache.js';
import type { ChildGuard, Platform, SecretStore } from '../platform/index.js';
import { ServerLog, serverLogPath, type ServerLogLine } from '../upstream/server-log.js';
import {
  isInputRequired,
  type CallOptions,
  type CallToolResult,
  type InputRequiredOutcome,
} from '../upstream/types.js';
import { catalogEntries } from './catalog.js';
import { ConnectionTests } from './connection-test.js';
import { ConflictError, NotFoundError } from './errors.js';
import { DEFAULT_TIMING, ServerRuntime, type ManagerTiming } from './runtime.js';

export interface ManagerEvents {
  status: [server: string, info: ServerStatusInfo];
  tools: [server: string];
  log: [line: ServerLogLine];
  retry: [server: string, delayMs: number, attempt: number];
}

export interface ServerManagerOptions {
  platform: Platform;
  secrets: SecretStore;
  logsDir: string;
  logger: Logger;
  baseEnv?: NodeJS.ProcessEnv;
  timing?: Partial<ManagerTiming>;
  guard?: ChildGuard;
  /** OAuth sign-in for `auth: "oauth"` servers. */
  oauth?: OAuthService;
  /** Each server's last listed tools, kept between runs (`mcpier.db`). */
  toolCache?: ToolCache;
}

/** Fields whose change means the server has to reconnect. */
const CONNECTION_FIELDS = [
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'auth',
  'oauth',
  'protocol',
  'startupTimeoutMs',
] as const;

function connectionOf(entry: ServerEntry): Record<string, unknown> {
  const record = entry as unknown as Record<string, unknown>;
  return Object.fromEntries(CONNECTION_FIELDS.map((field) => [field, record[field]]));
}

/** What a call returns: a tool result, or the upstream asking for input first. */
export type CallOutcome =
  | { kind: 'result'; result: CallToolResult; durationMs: number }
  | { kind: 'input_required'; inputRequired: InputRequiredOutcome; durationMs: number };

/** Per-call options beyond the arguments (all optional). */
export type ManagerCallOptions = Omit<CallOptions, 'timeoutMs'>;

/**
 * Owns one runtime per configured server, applies config to them as differences, and holds
 * the tool catalog. One server failing never blocks the others or the gateway.
 */
export class ServerManager extends EventEmitter<ManagerEvents> {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private settings: Settings | undefined;
  private readonly timing: ManagerTiming;
  private readonly connectionTests: ConnectionTests;

  constructor(private readonly options: ServerManagerOptions) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.connectionTests = new ConnectionTests({
      platform: options.platform,
      secrets: options.secrets,
      baseEnv: options.baseEnv ?? process.env,
      settings: () => this.settings!,
      guard: options.guard,
      ...(options.oauth ? { oauth: options.oauth } : {}),
    });
    // A finished sign-in restarts the server; a sign-out, an expired sign-in or a step-up
    // moves it to needs_auth.
    options.oauth?.on('changed', (name, change) => {
      const runtime = this.runtimes.get(name);
      if (!runtime) return;
      void runtime
        .authChanged(change)
        .catch((error: unknown) =>
          this.options.logger.warn(
            { server: name, err: { message: (error as Error).message } },
            'Applying a sign-in change failed',
          ),
        );
    });
  }

  private createRuntime(entry: ServerEntry): ServerRuntime {
    const log = new ServerLog(entry.name, serverLogPath(this.options.logsDir, entry.name), (line) =>
      this.emit('log', line),
    );
    const runtime = new ServerRuntime(entry, log, {
      platform: this.options.platform,
      secrets: this.options.secrets,
      baseEnv: this.options.baseEnv ?? process.env,
      settings: () => this.settings!,
      timing: this.timing,
      logger: this.options.logger,
      guard: this.options.guard,
      ...(this.options.oauth ? { oauth: this.options.oauth } : {}),
    });
    runtime.on('status', (info) => this.emit('status', entry.name, info));
    runtime.on('tools', () => {
      // Only a successful listing emits `tools`: keep it for the next run.
      this.options.toolCache?.save(entry.name, runtime.tools);
      this.emit('tools', entry.name);
    });
    runtime.on('retry', (delayMs, attempt) => this.emit('retry', entry.name, delayMs, attempt));
    return runtime;
  }

  /**
   * Applies a config as a difference from the current one: new servers start, removed ones
   * stop, changed connection fields restart only that server, `enabled` starts or stops it,
   * and description / timeoutMs / disabledTools apply without a restart. A changed
   * `extraPath` restarts stdio servers. Starts are not awaited (use `settled`).
   */
  applyConfig(config: McpierConfig): void {
    const previousSettings = this.settings;
    this.settings = config.settings;
    const extraPathChanged =
      previousSettings !== undefined &&
      !isDeepStrictEqual(previousSettings.extraPath, config.settings.extraPath);

    const wanted = new Map(config.servers.map((entry) => [entry.name, entry]));
    for (const [name, runtime] of this.runtimes) {
      if (!wanted.has(name)) {
        this.runtimes.delete(name);
        this.options.toolCache?.remove(name);
        void runtime.dispose().then(() => this.emit('tools', name));
        this.options.logger.info({ server: name }, 'Server removed');
      }
    }

    for (const entry of config.servers) {
      const runtime = this.runtimes.get(entry.name);
      if (!runtime) {
        const created = this.createRuntime(entry);
        this.runtimes.set(entry.name, created);
        // Searchable at once from the last run's list, marked unavailable until ready.
        const cached = entry.enabled ? this.options.toolCache?.load(entry.name) : undefined;
        if (cached && cached.length > 0) {
          created.seedTools(cached);
          this.emit('tools', entry.name);
        }
        if (entry.enabled) void created.start();
        continue;
      }
      const previous = runtime.entry;
      runtime.entry = entry;
      const connectionChanged = !isDeepStrictEqual(connectionOf(previous), connectionOf(entry));
      if (previous.enabled !== entry.enabled) {
        void (entry.enabled ? runtime.start() : runtime.stop());
      } else if (entry.enabled && (connectionChanged || (entry.transport === 'stdio' && extraPathChanged))) {
        this.options.logger.info({ server: entry.name }, 'Server settings changed; restarting it');
        void runtime.restart();
      }
      if (
        !isDeepStrictEqual(previous.disabledTools, entry.disabledTools) ||
        previous.enabled !== entry.enabled
      ) {
        this.emit('tools', entry.name);
      }
    }
  }

  private runtime(name: string): ServerRuntime {
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new NotFoundError(`No server named "${name}".`);
    return runtime;
  }

  has(name: string): boolean {
    return this.runtimes.has(name);
  }

  /** Waits until a server's current start attempt has settled. */
  async settled(name: string): Promise<void> {
    await this.runtime(name).settled();
  }

  async start(name: string): Promise<void> {
    const runtime = this.runtime(name);
    if (!runtime.entry.enabled) {
      throw new ConflictError(`Server "${name}" is disabled. Enable it to start it.`, 'disabled');
    }
    await runtime.start();
  }

  async stop(name: string): Promise<void> {
    await this.runtime(name).stop();
  }

  async restart(name: string): Promise<void> {
    const runtime = this.runtime(name);
    if (!runtime.entry.enabled) {
      throw new ConflictError(`Server "${name}" is disabled. Enable it to start it.`, 'disabled');
    }
    await runtime.restart();
  }

  async refreshTools(name: string): Promise<void> {
    await this.runtime(name).refreshTools();
  }

  /** Restarts every enabled server whose env or headers reference this secret. */
  async restartReferencing(secret: string): Promise<string[]> {
    const names = this.serversReferencing(secret);
    await Promise.all(
      names.map((name) => {
        const runtime = this.runtimes.get(name)!;
        return runtime.entry.enabled ? runtime.restart() : Promise.resolve();
      }),
    );
    return names;
  }

  serversReferencing(secret: string): string[] {
    return [...this.runtimes.values()]
      .filter((runtime) => referencedSecretNames(runtime.entry).includes(secret))
      .map((runtime) => runtime.name)
      .sort();
  }

  status(name: string): ServerStatusInfo {
    return this.runtime(name).status;
  }

  pid(name: string): number | undefined {
    return this.runtime(name).pid;
  }

  summary(name: string): ServerSummary {
    const runtime = this.runtime(name);
    const tools = this.toolsOf(runtime);
    const summary: ServerSummary = {
      name: runtime.name,
      transport: runtime.entry.transport,
      enabled: runtime.entry.enabled,
      status: runtime.status,
      tools: { total: tools.length, enabled: tools.filter((tool) => tool.enabled).length },
    };
    if (runtime.entry.description) summary.description = runtime.entry.description;
    if (runtime.protocolVersion) summary.protocolVersion = runtime.protocolVersion;
    const uptime = runtime.uptimeSeconds;
    if (uptime !== undefined) summary.uptimeSeconds = uptime;
    return summary;
  }

  summaries(): ServerSummary[] {
    return [...this.runtimes.keys()].sort().map((name) => this.summary(name));
  }

  /** Count of servers per status. */
  statusCounts(): Partial<Record<ServerStatus, number>> {
    const counts: Partial<Record<ServerStatus, number>> = {};
    for (const runtime of this.runtimes.values()) {
      counts[runtime.status.state] = (counts[runtime.status.state] ?? 0) + 1;
    }
    return counts;
  }

  private toolsOf(runtime: ServerRuntime): ToolInfo[] {
    return catalogEntries(runtime.entry, runtime.tools, runtime.status.state === 'ready');
  }

  /** The catalog: every known tool, optionally for one server, sorted by full name. */
  tools(server?: string): ToolInfo[] {
    const runtimes = server ? [this.runtime(server)] : [...this.runtimes.values()];
    return runtimes
      .flatMap((runtime) => this.toolsOf(runtime))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  tool(fullName: string): ToolInfo {
    const parts = splitFullToolName(fullName);
    if (!parts) throw new NotFoundError(`"${fullName}" is not a full tool name (expected server__tool).`);
    const runtime = this.runtimes.get(parts.server);
    if (!runtime) throw new NotFoundError(`No server named "${parts.server}".`);
    const tool = this.toolsOf(runtime).find((candidate) => candidate.name === parts.tool);
    if (!tool) throw new NotFoundError(`Server "${parts.server}" has no tool named "${parts.tool}".`);
    return tool;
  }

  /**
   * Calls a tool by full name. The result comes back unchanged except for secret values; an
   * upstream `input_required` answer is its own outcome, not an error.
   */
  async callTool(
    fullName: string,
    args: Record<string, unknown>,
    options: ManagerCallOptions = {},
  ): Promise<CallOutcome> {
    const tool = this.tool(fullName);
    if (!tool.enabled) {
      throw new ConflictError(`The tool "${fullName}" is disabled. Enable it to call it.`, 'disabled');
    }
    const runtime = this.runtime(tool.server);
    const started = performance.now();
    const result = await runtime.callTool(tool.name, args, options);
    const durationMs = Math.round(performance.now() - started);
    return isInputRequired(result)
      ? { kind: 'input_required', inputRequired: result, durationMs }
      : { kind: 'result', result, durationMs };
  }

  /** Secret-free text for an error raised while calling a server's tool. */
  redactFor(server: string, text: string): string {
    return this.runtimes.get(server)?.redactText(text) ?? text;
  }

  /**
   * Connects to an unsaved entry, lists its tools and disconnects (the Add server page). One
   * test per name at a time; nothing is saved or added to the catalog.
   */
  testConnection(entry: ServerEntry): Promise<ConnectionTestResponse> {
    return this.connectionTests.run(entry);
  }

  /** Stops every server cleanly (gateway shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
  }
}
