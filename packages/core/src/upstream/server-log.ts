import { join } from 'node:path';
import { RotatingFileSink } from '../logger.js';
import type { Redactor } from '../secrets/redact.js';

/** Where a server log line came from. */
export type ServerLogSource = 'stderr' | 'server' | 'mcpier';

export interface ServerLogLine {
  server: string;
  /** The line as written to the file: `<ISO time> [<source>] <text>`. */
  line: string;
}

/** Path of a server's log file: `logs\<server>.log`. */
export function serverLogPath(logsDir: string, server: string): string {
  return join(logsDir, `${server}.log`);
}

/**
 * One server's log file (`logs\<server>.log`, rotated like the gateway log). It holds the
 * server's stderr, its protocol log messages and MCPier's own connection events. Every line
 * passes through the redactor, so resolved secret values never reach the file or listeners.
 */
export class ServerLog {
  private sink: RotatingFileSink | undefined;
  private redact: Redactor = (text) => text;
  private closed = false;

  constructor(
    readonly server: string,
    private readonly file: string,
    private readonly onLine: (line: ServerLogLine) => void,
  ) {}

  /** Secret values to hide, refreshed whenever the server's secrets are resolved again. */
  setRedactor(redact: Redactor): void {
    this.redact = redact;
  }

  write(source: ServerLogSource, text: string): void {
    if (this.closed) return;
    for (const part of text.split(/\r?\n/)) {
      if (part.length === 0) continue;
      const line = `${new Date().toISOString()} [${source}] ${this.redact(part)}`;
      this.sink ??= new RotatingFileSink(this.file);
      this.sink.write(`${line}\n`);
      this.onLine({ server: this.server, line });
    }
  }

  /** Closes the file for good; later lines are dropped. */
  close(): void {
    this.closed = true;
    this.sink?.close();
    this.sink = undefined;
  }
}

/** Splits a byte stream into lines, holding back a trailing partial line. */
export class LineSplitter {
  private pending = '';

  push(chunk: string, onLine: (line: string) => void): void {
    const text = this.pending + chunk;
    const parts = text.split(/\r?\n/);
    this.pending = parts.pop() ?? '';
    // A runaway line without a newline is flushed rather than held forever.
    if (this.pending.length > 64 * 1024) {
      parts.push(this.pending);
      this.pending = '';
    }
    for (const part of parts) onLine(part);
  }

  flush(onLine: (line: string) => void): void {
    if (this.pending) onLine(this.pending);
    this.pending = '';
  }
}
