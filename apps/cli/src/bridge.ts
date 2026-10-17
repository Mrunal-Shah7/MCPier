// The stdio bridge (`mcpier stdio`): a relay between a client that only speaks MCP over
// stdio and the gateway's /mcp endpoint. It never implements meta-tools itself. Its stdout
// carries protocol messages only; every diagnostic goes to the `log` callback (stderr).
import {
  isInitializeRequest,
  isInitializedNotification,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  PROTOCOL_VERSION_META_KEY,
  ReadBuffer,
  SdkHttpError,
  serializeMessage,
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type JSONRPCRequest,
} from '@modelcontextprotocol/client';

type RequestId = string | number;

export interface BridgeOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Diagnostics, one line each. Never written to `output`. */
  log: (line: string) => void;
  /** Makes sure the gateway runs (starting it if needed) and returns its /mcp URL. */
  connect: () => Promise<URL>;
}

interface Outstanding {
  request: JSONRPCRequest;
  /** 2026-07-28 request (cancelled by aborting its HTTP request) or 2025-era (by notification). */
  modern: boolean;
  controller: AbortController;
}

/** Ids the bridge itself uses when it replays `initialize`. */
const REPLAY_PREFIX = 'mcpier-bridge-replay-';

/** JSON-RPC error code for "the gateway could not be reached or did not answer". */
export const BRIDGE_ERROR_CODE = -32603;

function isModern(message: JSONRPCRequest | JSONRPCNotification): boolean {
  const meta = (message.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  return typeof meta?.[PROTOCOL_VERSION_META_KEY] === 'string';
}

/**
 * Nothing is listening: the request never reached a gateway, so sending it again is safe. A
 * connection that drops mid-request is not retried; the call may already have run upstream.
 */
function isRefused(error: unknown): boolean {
  if (error instanceof SdkHttpError) return false;
  const text = `${(error as Error)?.message ?? ''} ${String((error as { cause?: unknown })?.cause ?? '')}`;
  return /ECONNREFUSED/i.test(text);
}

function describe(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  const problems = (error as { options?: { problems?: readonly string[] } })?.options?.problems ?? [];
  return [message, ...problems].join(' ');
}

export class StdioBridge {
  private readonly buffer = new ReadBuffer();
  private transport: StreamableHTTPClientTransport | undefined;
  private url: URL | undefined;
  /** Opening the transport (starting the gateway first if needed); shared by concurrent callers. */
  private opening: Promise<StreamableHTTPClientTransport> | undefined;
  /** Recovering a legacy session after the gateway lost it; shared by concurrent callers. */
  private recovering: Promise<void> | undefined;
  private readonly outstanding = new Map<RequestId, Outstanding>();
  /** The legacy handshake, kept so it can be replayed after a gateway restart. */
  private handshake: { initialize: JSONRPCRequest; initialized?: JSONRPCNotification } | undefined;
  private replays = 0;
  /** Messages are handled one after another, in the order they arrived. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly done: Promise<void>;
  private finish!: () => void;

  constructor(private readonly options: BridgeOptions) {
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  /** Runs until stdin ends. */
  async run(): Promise<void> {
    // Start the gateway right away (a 2026-07-28 client may send nothing until it needs a
    // tool), without holding up stdin. A failure here is retried on the first request.
    void this.open().catch((error: unknown) =>
      this.options.log(`Could not reach the MCPier gateway: ${describe(error)}`),
    );
    this.options.input.on('data', (chunk: Buffer) => this.onData(chunk));
    this.options.input.on('end', () => void this.drainThenClose());
    this.options.input.on('error', (error) => {
      this.options.log(`stdin error: ${(error as Error).message}`);
      void this.close();
    });
    await this.done;
  }

  private onData(chunk: Buffer): void {
    this.buffer.append(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        this.options.log(
          `Ignoring a line on stdin that is not a JSON-RPC message: ${(error as Error).message}`,
        );
        continue;
      }
      if (!message) break;
      const current = message;
      this.chain = this.chain
        .then(() => this.handle(current))
        .catch((error: unknown) => {
          this.options.log(`Unexpected bridge error: ${(error as Error)?.message ?? String(error)}`);
        });
    }
  }

  private write(message: JSONRPCMessage): void {
    if (this.closed) return;
    this.options.output.write(serializeMessage(message));
  }

  private replyError(id: RequestId, message: string): void {
    this.outstanding.delete(id);
    this.write({ jsonrpc: '2.0', id, error: { code: BRIDGE_ERROR_CODE, message: `MCPier: ${message}` } });
  }

  // ---- the connection to the gateway

  private open(): Promise<StreamableHTTPClientTransport> {
    if (this.transport) return Promise.resolve(this.transport);
    this.opening ??= (async () => {
      try {
        const url = await this.options.connect();
        if (this.url && this.url.href !== url.href) this.options.log(`The gateway moved to ${url.href}`);
        this.url = url;
        const transport = new StreamableHTTPClientTransport(url);
        transport.onmessage = (message) => this.onGatewayMessage(message);
        // Errors here (a dropped event stream, a refused request) are reported per request;
        // none of them may end the bridge.
        transport.onerror = (error) => this.options.log(`Gateway connection: ${error.message}`);
        await transport.start();
        this.transport = transport;
        return transport;
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
  }

  /** Drops the connection after a network failure; the next send reopens (and restarts the gateway). */
  private dropTransport(): void {
    const transport = this.transport;
    this.transport = undefined;
    if (transport) void transport.close().catch(() => {});
  }

  /** A legacy session is gone (gateway restarted, or the session expired): replay the handshake. */
  private recover(): Promise<void> {
    this.recovering ??= (async () => {
      try {
        const handshake = this.handshake;
        if (!handshake) return;
        this.options.log('The gateway no longer knows this session; re-initializing.');
        const transport = await this.open();
        const id = `${REPLAY_PREFIX}${++this.replays}`;
        await transport.send({ ...handshake.initialize, id });
        if (handshake.initialized) await transport.send(handshake.initialized);
      } finally {
        this.recovering = undefined;
      }
    })();
    return this.recovering;
  }

  // ---- messages from the client (stdin)

  private async handle(message: JSONRPCMessage): Promise<void> {
    if (isJSONRPCRequest(message)) {
      const entry: Outstanding = {
        request: message,
        modern: isModern(message),
        controller: new AbortController(),
      };
      this.outstanding.set(message.id, entry);
      if (isInitializeRequest(message)) this.handshake = { initialize: message };
      try {
        await this.open();
      } catch (error) {
        this.options.log(`Could not reach the MCPier gateway: ${describe(error)}`);
        this.replyError(message.id, `the gateway could not be started: ${describe(error)}`);
        return;
      }
      void this.sendRequest(entry);
      return;
    }

    if (isJSONRPCNotification(message)) {
      if (message.method === 'notifications/cancelled') {
        const id = (message.params as { requestId?: RequestId } | undefined)?.requestId;
        const entry = id === undefined ? undefined : this.outstanding.get(id);
        if (entry?.modern) {
          // 2026-07-28: cancelling is closing the request's HTTP stream.
          this.outstanding.delete(id!);
          entry.controller.abort();
          return;
        }
        if (id !== undefined) this.outstanding.delete(id);
      }
      if (isInitializedNotification(message) && this.handshake) this.handshake.initialized = message;
      await this.sendOther(message);
      return;
    }

    // A response to a request the gateway sent the client (legacy sessions only).
    await this.sendOther(message);
  }

  private async sendRequest(entry: Outstanding, retried = false): Promise<void> {
    const id = entry.request.id;
    let transport: StreamableHTTPClientTransport;
    try {
      transport = await this.open();
    } catch (error) {
      if (this.outstanding.has(id))
        this.replyError(id, `the gateway could not be started: ${describe(error)}`);
      return;
    }
    try {
      await transport.send(entry.request, {
        ...(entry.modern ? { requestSignal: entry.controller.signal } : {}),
        // An event-stream answer ended; if it never carried the answer, say so.
        onRequestStreamEnd: () =>
          setImmediate(() => {
            if (this.outstanding.get(id) === entry) {
              this.replyError(
                id,
                'the gateway closed the connection before answering. The call may or may not have run.',
              );
            }
          }),
      });
    } catch (error) {
      if (entry.controller.signal.aborted || this.outstanding.get(id) !== entry) return;
      if (retried) {
        this.replyError(id, `the request failed: ${describe(error)}`);
        return;
      }
      await this.retryOrFail(entry, error);
    }
  }

  /** One retry when the gateway was not there (restarted or stopped) or lost a legacy session. */
  private async retryOrFail(entry: Outstanding, error: unknown): Promise<void> {
    const id = entry.request.id;
    const lostSession = error instanceof SdkHttpError && error.status === 404 && !entry.modern;
    const refused = isRefused(error);
    if (!lostSession && !refused) {
      this.replyError(id, `the request failed: ${describe(error)}`);
      return;
    }
    if (refused) {
      this.options.log('The gateway is not answering; starting it again.');
      this.dropTransport();
    }
    try {
      if (!entry.modern && !isInitializeRequest(entry.request)) await this.recover();
    } catch (recoverError) {
      this.replyError(id, `the gateway could not be reached again: ${describe(recoverError)}`);
      return;
    }
    if (this.outstanding.get(id) === entry) await this.sendRequest(entry, true);
  }

  private async sendOther(message: JSONRPCMessage): Promise<void> {
    try {
      const transport = await this.open();
      await transport.send(message);
    } catch (error) {
      this.options.log(`Could not forward a message to the gateway: ${describe(error)}`);
    }
  }

  // ---- messages from the gateway (to stdout)

  private onGatewayMessage(message: JSONRPCMessage): void {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const id = message.id;
      if (typeof id === 'string' && id.startsWith(REPLAY_PREFIX)) {
        this.adoptProtocolVersion(message);
        return; // The bridge's own replayed handshake.
      }
      const entry = id === undefined || id === null ? undefined : this.outstanding.get(id);
      if (entry) {
        this.outstanding.delete(id!);
        if (isInitializeRequest(entry.request)) this.adoptProtocolVersion(message);
      }
    }
    this.write(message);
  }

  /** Later 2025-era requests carry the negotiated version in their MCP-Protocol-Version header. */
  private adoptProtocolVersion(message: JSONRPCMessage): void {
    const version = isJSONRPCResultResponse(message)
      ? (message.result as { protocolVersion?: unknown }).protocolVersion
      : undefined;
    if (typeof version === 'string') this.transport?.setProtocolVersion(version);
  }

  /** stdin ended: give answers already on their way a moment to arrive, then close. */
  private async drainThenClose(graceMs = 5000): Promise<void> {
    await this.chain.catch(() => {});
    const deadline = Date.now() + graceMs;
    while (this.outstanding.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await this.close();
  }

  /** Ends the legacy session (if any), closes the connection, and lets `run` return. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.chain.catch(() => {});
    this.closed = true;
    for (const entry of this.outstanding.values()) entry.controller.abort();
    this.outstanding.clear();
    const transport = this.transport;
    this.transport = undefined;
    if (transport) {
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      await transport.close().catch(() => {});
    }
    this.finish();
  }
}
