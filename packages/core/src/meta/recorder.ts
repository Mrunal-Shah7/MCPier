import type { Logger } from '../logger.js';

/** Which side a search or call came from. */
export type ClientEra = 'modern' | 'legacy' | 'admin';

export interface ClientIdentity {
  name?: string;
  version?: string;
}

export interface SearchEvent {
  /** ISO 8601. */
  at: string;
  client: ClientIdentity;
  era: ClientEra;
  query: string;
  server?: string;
  /** The `limit` asked for, when one was given. */
  limit?: number;
  resultCount: number;
  /** Full names returned, in order. */
  results: string[];
  durationMs: number;
}

export const CALL_OUTCOMES = [
  'ok',
  'tool_error',
  'validation_error',
  'not_found',
  'disabled',
  'not_ready',
  'timeout',
  'cancelled',
  'input_required',
  'failed',
] as const;
export type CallOutcomeKind = (typeof CALL_OUTCOMES)[number];

export interface CallEvent {
  /** ISO 8601. */
  at: string;
  client: ClientIdentity;
  era: ClientEra;
  /** The full name the client asked for (it may not exist). */
  tool: string;
  server?: string;
  durationMs: number;
  outcome: CallOutcomeKind;
  /** The trace-id part of the request's `traceparent`, when present. */
  traceId?: string;
  /**
   * The arguments and the result as returned to the caller, **already redacted** with the
   * server's secret values (D-026) and OAuth tokens. Never `requestState`, `inputResponses` or
   * elicitation answers. A recorder stores them only when `storeCallBodies` is on.
   */
  arguments?: unknown;
  result?: unknown;
  /** A short error text for failed outcomes (redacted). */
  errorText?: string;
}

/**
 * Receives one event per search and per tool call. Call events may carry the arguments and
 * the result, redacted by the caller; never elicitation answers, `inputResponses` or
 * `requestState`. The gateway records to SQLite (`CallLog`); `LogRecorder` is the fallback
 * when the database cannot be used.
 */
export interface Recorder {
  searchPerformed(event: SearchEvent): void;
  toolCalled(event: CallEvent): void;
}

/** The trace id of a W3C `traceparent` (`00-<trace-id>-<parent-id>-<flags>`). */
export function traceIdOf(traceparent: unknown): string | undefined {
  if (typeof traceparent !== 'string') return undefined;
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(traceparent.trim());
  return match?.[1]?.toLowerCase();
}

/**
 * The fallback recorder when `mcpier.db` cannot be used: one gateway log line per event, with
 * metadata only (never bodies or error texts).
 */
export class LogRecorder implements Recorder {
  constructor(private readonly logger: Logger) {}

  searchPerformed(event: SearchEvent): void {
    this.logger.info({ event: 'search', ...event }, 'Search performed');
  }

  toolCalled(event: CallEvent): void {
    const { arguments: _arguments, result: _result, errorText: _errorText, ...metadata } = event;
    this.logger.info({ event: 'call', ...metadata }, 'Tool called');
  }
}

/** Keeps events in memory (tests). */
export class MemoryRecorder implements Recorder {
  readonly searches: SearchEvent[] = [];
  readonly calls: CallEvent[] = [];

  searchPerformed(event: SearchEvent): void {
    this.searches.push(event);
  }

  toolCalled(event: CallEvent): void {
    this.calls.push(event);
  }
}
