import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Client, VersionNegotiationMode } from '@modelcontextprotocol/client';
import type { StdioServerEntry } from '@mcpier/shared';
import { buildChildEnv, type ChildGuard, type Platform } from '../platform/index.js';
import type { Redactor } from '../secrets/redact.js';
import { ChildProcessTransport } from './child-transport.js';
import {
  callUpstreamTool,
  checkAlive,
  createUpstreamClient,
  isTimeout,
  isUnsupportedVersion,
  MODERN_PROTOCOL_VERSION,
} from './client.js';
import { LineSplitter, type ServerLog } from './server-log.js';
import {
  CallTimeoutError,
  ConnectError,
  formatMs,
  type CallOptions,
  type Connector,
  type ConnectorEvents,
  type ToolListing,
  pickServerInfo,
  type UpstreamCallResult,
  type UpstreamServerInfo,
} from './types.js';

/** How long a stopped server gets to exit by itself before its process tree is stopped. */
const STOP_GRACE_MS = 2000;
/** stderr lines kept in memory to explain a failed start. */
const STDERR_TAIL_LINES = 15;

export interface StdioConnectorOptions {
  platform: Platform;
  log: ServerLog;
  /** The gateway's environment, the base for the child's. */
  baseEnv: NodeJS.ProcessEnv;
  extraPath: readonly string[];
  /** The server's `env` with secret references resolved. */
  env: Record<string, string>;
  redact: Redactor;
  /** Tracks the process tree so it cannot outlive the gateway (absent in most tests). */
  guard?: ChildGuard;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  client: Client;
  exited: Promise<string>;
}

/**
 * A stdio server: one long-lived child process, started hidden through the platform layer,
 * spoken to through one SDK client over its stdin and stdout.
 */
export class StdioConnector extends EventEmitter<ConnectorEvents> implements Connector {
  private running: Running | undefined;
  private stopping = false;
  private stderrTail: string[] = [];

  constructor(
    private readonly entry: StdioServerEntry,
    private readonly options: StdioConnectorOptions,
  ) {
    super();
  }

  get protocolVersion(): string | undefined {
    return this.running?.client.getNegotiatedProtocolVersion();
  }

  get serverInfo(): UpstreamServerInfo | undefined {
    return pickServerInfo(this.running?.client.getServerVersion());
  }

  get pid(): number | undefined {
    return this.running?.child.pid;
  }

  async connect(): Promise<void> {
    const { protocol } = this.entry;
    if (protocol === 'modern') return this.attempt({ pin: MODERN_PROTOCOL_VERSION });
    try {
      // `legacy` and `auto` both start with the handshake. `auto` retries once, pinned to
      // 2026-07-28, only when the server rejected the handshake's protocol version; that
      // avoids the SDK's extra probe process on every connect.
      await this.attempt('legacy');
    } catch (error) {
      if (protocol !== 'auto' || !(error instanceof UnsupportedVersionStartError)) throw error;
      this.options.log.write(
        'mcpier',
        'Server rejected the 2025 handshake; retrying with protocol 2026-07-28',
      );
      await this.attempt({ pin: MODERN_PROTOCOL_VERSION });
    }
  }

  private async attempt(mode: VersionNegotiationMode): Promise<void> {
    const { log, platform } = this.options;
    const modeLabel =
      typeof mode === 'string'
        ? `${this.entry.protocol}, 2025 handshake`
        : `${this.entry.protocol}, pinned to ${mode.pin}`;
    log.write('mcpier', `Starting: ${this.describeCommand()} (protocol ${modeLabel})`);
    this.stderrTail = [];

    let child: ChildProcessWithoutNullStreams;
    const startedAtMs = Date.now();
    try {
      child = platform.processes.startAttached({
        command: this.entry.command,
        args: this.entry.args,
        env: buildChildEnv(this.options.baseEnv, this.options.extraPath, this.options.env),
      });
    } catch (error) {
      const message = this.options.redact((error as Error).message);
      log.write('mcpier', `Start failed: ${message}`);
      throw new ConnectError(message);
    }

    const { guard } = this.options;
    const childPid = child.pid;
    if (guard && childPid !== undefined) {
      guard.track(childPid, startedAtMs);
      child.once('exit', () => guard.untrack(childPid));
    }

    const splitter = new LineSplitter();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => splitter.push(chunk, (line) => this.stderrLine(line)));
    child.stderr.on('end', () => splitter.flush((line) => this.stderrLine(line)));

    let spawnError: Error | undefined;
    const exited = new Promise<string>((resolve) => {
      child.once('error', (error) => {
        spawnError = error;
        resolve(`could not be started (${(error as NodeJS.ErrnoException).code ?? error.message})`);
      });
      child.once('exit', (code, signal) =>
        resolve(signal ? `was stopped (${signal})` : `exited with code ${code ?? 'unknown'}`),
      );
    });

    const transport = new ChildProcessTransport(child, (error) =>
      log.write('mcpier', `Ignored a stdout line that is not JSON-RPC: ${error.message}`),
    );
    const client = createUpstreamClient(mode, { log, onToolsChanged: () => this.emit('toolsChanged') });

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.entry.startupTimeoutMs);
    });
    const exitedEarly = exited.then((how) => ({ how }));

    let outcome: 'connected' | 'timeout' | { how: string } | { error: unknown };
    try {
      outcome = await Promise.race([
        client.connect(transport, { timeout: this.entry.startupTimeoutMs }).then(
          () => 'connected' as const,
          (error: unknown) => ({ error }),
        ),
        timedOut,
        exitedEarly,
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (outcome === 'connected') {
      this.running = { child, client, exited };
      log.write('mcpier', `Connected (pid ${child.pid}, protocol ${client.getNegotiatedProtocolVersion()})`);
      void exited.then((how) => {
        if (this.running?.child !== child || this.stopping) return;
        this.running = undefined;
        void client.close().catch(() => {});
        log.write('mcpier', `Process ${how}`);
        this.emit('lost', `The server process ${how}.${this.tailText()}`);
      });
      return;
    }

    // Failed: make sure nothing is left running, then explain.
    await this.stopProcess(child, client, 0);
    // Give stderr a moment to deliver the last lines (for example "is not recognized").
    await Promise.race([exited, delay(500)]);
    await delay(50);

    let reason: string;
    if (outcome === 'timeout') {
      reason =
        `The server did not finish starting within ${formatMs(this.entry.startupTimeoutMs)} and was stopped. ` +
        `First runs of npx/uvx servers can spend a long time downloading; raise "startupTimeoutMs" if needed.`;
    } else if ('how' in outcome) {
      reason = !spawnError
        ? `The server process ${outcome.how} before it was ready.`
        : (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
          ? `The command "${this.entry.command}" was not found. Check the spelling, or add its folder to the "extraPath" setting.`
          : `The server command could not be started: ${spawnError.message}`;
    } else if (isUnsupportedVersion(outcome.error)) {
      log.write('mcpier', 'Server rejected the 2025 handshake (unsupported protocol version)');
      throw new UnsupportedVersionStartError();
    } else {
      // The connect itself failed; if the process died meanwhile, that is the better story.
      const how = await Promise.race([exited, delay(200).then(() => undefined)]);
      reason = how
        ? `The server process ${how} before it was ready.`
        : `Connecting failed: ${(outcome.error as Error).message ?? String(outcome.error)}`;
    }
    const message = this.options.redact(`${reason}${this.tailText()}`);
    log.write('mcpier', `Start failed: ${reason}`);
    throw new ConnectError(message);
  }

  private stderrLine(line: string): void {
    this.options.log.write('stderr', line);
    if (line.trim().length === 0) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
  }

  private tailText(): string {
    if (this.stderrTail.length === 0) return '';
    return `\nLast stderr lines:\n${this.stderrTail.map((line) => `  ${line}`).join('\n')}`;
  }

  private describeCommand(): string {
    // Arguments are shown, environment values never are.
    return [this.entry.command, ...this.entry.args].join(' ');
  }

  private live(): Running {
    if (!this.running) throw new Error(`Server "${this.entry.name}" is not connected.`);
    return this.running;
  }

  async listTools(): Promise<ToolListing> {
    const { client } = this.live();
    const result = await client.listTools(undefined, { cacheMode: 'refresh', timeout: this.entry.timeoutMs });
    return { tools: result.tools, ttlMs: (result as { ttlMs?: number }).ttlMs };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: CallOptions,
  ): Promise<UpstreamCallResult> {
    const { client } = this.live();
    try {
      return await callUpstreamTool(client, name, args, options);
    } catch (error) {
      if (isTimeout(error) && !options.signal?.aborted) {
        throw new CallTimeoutError(this.entry.name, name, options.timeoutMs);
      }
      throw error;
    }
  }

  async check(timeoutMs: number): Promise<void> {
    await checkAlive(this.live().client, timeoutMs);
  }

  async close(): Promise<void> {
    this.stopping = true;
    const running = this.running;
    this.running = undefined;
    if (running) {
      await this.stopProcess(running.child, running.client, STOP_GRACE_MS);
      this.options.log.write('mcpier', 'Stopped');
    }
  }

  /** Closes the client (which ends stdin), waits up to `graceMs`, then stops the process tree. */
  private async stopProcess(
    child: ChildProcessWithoutNullStreams,
    client: Client,
    graceMs: number,
  ): Promise<void> {
    await client.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null && graceMs > 0) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(graceMs)]);
    }
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await this.options.platform.processes.stopTree(child.pid).catch(() => {});
    }
  }
}

/** Internal: the handshake was rejected as an unsupported version (drives the `auto` retry). */
class UnsupportedVersionStartError extends ConnectError {
  constructor() {
    super(
      'The server rejected the 2025 initialize handshake as an unsupported protocol version. ' +
        'Set its "protocol" to "modern" or "auto".',
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
