import { closeSync, existsSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export interface RotatingFileOptions {
  /** Rotate once the current file would exceed this size. Default 5 MB. */
  maxBytes?: number;
  /** Rotated files to keep (`gateway.log.1` … `.N`). Default 3. */
  maxFiles?: number;
}

/**
 * A synchronous, size-rotating log file. Lines are on disk as soon as `write` returns, so
 * nothing is lost when the process exits or is stopped by force, and the live file keeps
 * its name (`gateway.log`); older content moves to `gateway.log.1`, `.2`, … .
 */
export class RotatingFileSink {
  private fd: number;
  private size: number;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly file: string,
    options: RotatingFileOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.fd = openSync(file, 'a');
    this.size = fstatSync(this.fd).size;
  }

  write(line: string): void {
    // A late line after shutdown (an async status change finishing) is dropped, not a crash.
    if (this.fd < 0) return;
    const data = Buffer.from(line, 'utf8');
    if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotate();
    writeSync(this.fd, data);
    this.size += data.length;
  }

  close(): void {
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
  }

  private rotate(): void {
    closeSync(this.fd);
    try {
      rmSync(`${this.file}.${this.maxFiles}`, { force: true });
      for (let index = this.maxFiles - 1; index >= 1; index--) {
        const from = `${this.file}.${index}`;
        if (existsSync(from)) renameSync(from, `${this.file}.${index + 1}`);
      }
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // Another program (an editor, `tail`) may hold a rotated file open on Windows. Keep
      // writing to the current file rather than losing log lines; rotation retries later.
    }
    this.fd = openSync(this.file, 'a');
    this.size = fstatSync(this.fd).size;
  }
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** Formats a pino JSON line for a person reading the terminal. */
function consoleLine(json: string): string {
  try {
    const {
      level,
      time,
      msg,
      pid: _pid,
      hostname: _hostname,
      ...fields
    } = JSON.parse(json) as Record<string, unknown>;
    const clock = typeof time === 'string' ? time.slice(11, 19) : '';
    const extra = Object.entries(fields)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    const name = LEVEL_NAMES[level as number] ?? String(level);
    return `${clock} ${name.padEnd(5)} ${String(msg ?? '')}${extra ? `  ${extra}` : ''}\n`;
  } catch {
    return json;
  }
}

export interface GatewayLoggerOptions {
  file: string;
  /** Also print a readable copy of each line to stdout (foreground mode). */
  console?: boolean;
  rotation?: RotatingFileOptions;
}

export interface GatewayLogger {
  logger: Logger;
  close(): void;
}

/**
 * The gateway log. Callers log explicit fields only (never request headers); the redact
 * list is a second line of defence so a token or cookie value can never reach the file.
 */
export function createGatewayLogger(options: GatewayLoggerOptions): GatewayLogger {
  const sink = new RotatingFileSink(options.file, options.rotation);
  const destination = {
    write(line: string) {
      sink.write(line);
      if (options.console) process.stdout.write(consoleLine(line));
    },
  };
  const logger = pino(
    {
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ['token', 'authorization', 'cookie', '*.token', '*.authorization', '*.cookie', 'headers'],
        censor: '[redacted]',
      },
    },
    destination,
  );
  return { logger, close: () => sink.close() };
}
