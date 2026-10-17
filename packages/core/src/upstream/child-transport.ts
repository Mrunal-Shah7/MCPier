import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';

/**
 * An MCP transport over the stdin and stdout of a process MCPier started itself. The SDK's
 * own stdio transport insists on spawning the process; MCPier needs to control the spawn
 * (cross-spawn for `.cmd` launchers, hidden window, extra PATH, injected env, tree stop).
 * Framing is the SDK's own newline-delimited JSON (`ReadBuffer`, `serializeMessage`).
 */
export class ChildProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private closed = false;
  private started = false;

  /**
   * @param onBadLine called for a stdout line that is not JSON-RPC (some servers print logs
   *   to stdout by mistake). The line is skipped and the connection carries on.
   */
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onBadLine?: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('ChildProcessTransport already started');
    this.started = true;
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.drain();
    });
    // Writing to a process that already exited fails with EPIPE; report it, do not crash.
    this.child.stdin.on('error', (error) => this.onerror?.(error));
    this.child.stdout.on('error', (error) => this.onerror?.(error));
    // 'close' fires once the process has exited and its output is fully read. A process
    // that leaves a grandchild holding the pipes may delay it, so 'exit' starts a fallback.
    this.child.once('close', () => this.finish());
    this.child.once('exit', () => setTimeout(() => this.finish(), 500).unref());
    this.child.once('error', (error) => {
      this.onerror?.(error);
      this.finish();
    });
  }

  private drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        // The bad line has been consumed; keep reading the next ones.
        this.onBadLine?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuffer.clear();
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The server process has exited'));
    return new Promise((resolve, reject) => {
      const json = serializeMessage(message);
      const flushed = this.child.stdin.write(json, (error) => (error ? reject(error) : undefined));
      if (flushed) resolve();
      else this.child.stdin.once('drain', resolve);
    });
  }

  /** Ends stdin (the stdio way to ask a server to exit). Stopping the process is the caller's job. */
  async close(): Promise<void> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    this.finish();
  }
}
