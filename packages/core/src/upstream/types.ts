import type { EventEmitter } from 'node:events';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { NeedsAuthReason } from '@mcpier/shared';

export type { CallToolResult, Tool };

/** A server's tools as last listed, with the cache hint a 2026-07-28 server may send. */
export interface ToolListing {
  tools: Tool[];
  /** How long the list stays fresh, in ms (modern servers only). */
  ttlMs?: number;
}

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Trace context to forward upstream: only `traceparent`, `tracestate` and `baggage`. */
  traceMeta?: Record<string, string>;
  /**
   * The downstream client's `elicitation` capability. Forwarded per request to 2026-07-28
   * upstreams only, so they may answer with `input_required`. Nothing else about the
   * downstream client is forwarded.
   */
  elicitation?: Record<string, unknown>;
  /** A retry after `input_required`: the client's answers, keyed as the upstream asked. */
  inputResponses?: Record<string, unknown>;
  /** A retry after `input_required`: the upstream's own `requestState`, echoed back. */
  requestState?: string;
}

/** An upstream answered a call with `input_required` (2026-07-28 multi-round-trip). */
export interface InputRequiredOutcome {
  resultType: 'input_required';
  inputRequests?: Record<string, unknown>;
  requestState?: string;
}

export type UpstreamCallResult = CallToolResult | InputRequiredOutcome;

export function isInputRequired(result: unknown): result is InputRequiredOutcome {
  return (result as { resultType?: unknown } | undefined)?.resultType === 'input_required';
}

/** Events a connector emits while connected. */
export interface ConnectorEvents {
  /** The server announced that its tool list changed. */
  toolsChanged: [];
  /**
   * The connection ended without being asked to (process exited, transport closed).
   * The manager decides whether to reconnect.
   */
  lost: [reason: string];
}

/**
 * One upstream server connection. Callers (the server manager now, the meta-tools in
 * Sprint 3) only use this interface. One connector holds exactly one SDK client, shared by
 * every caller; the SDK assigns request ids, so concurrent calls never collide.
 */
export interface Connector extends Pick<EventEmitter<ConnectorEvents>, 'on' | 'off' | 'once'> {
  /** The protocol version negotiated with the server, once connected. */
  readonly protocolVersion: string | undefined;
  /** Connects; rejects with `ConnectError` (already explained for the user) on failure. */
  connect(): Promise<void>;
  listTools(): Promise<ToolListing>;
  callTool(name: string, args: Record<string, unknown>, options: CallOptions): Promise<UpstreamCallResult>;
  /** Liveness check: `ping`, or a tool listing if the server does not implement ping. */
  check(timeoutMs: number): Promise<void>;
  /** Disconnects and releases everything (stdio: grace period, then process-tree stop). */
  close(): Promise<void>;
}

/** Status a failed connect leaves the server in. */
export type FailureStatus = 'error' | 'needs_auth';

/** A connect failure with a message meant for the user (secret values already removed). */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly status: FailureStatus = 'error',
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

/**
 * An OAuth server needs the user to sign in (again): no tokens, an expired or revoked grant,
 * or more permissions. Carries no token or secret; `message` is the status detail.
 */
export class NeedsAuthError extends Error {
  constructor(
    readonly reason: NeedsAuthReason,
    message: string,
  ) {
    super(message);
    this.name = 'NeedsAuthError';
  }
}

/** A tool call that ran out of time. The request was cancelled upstream. */
export class CallTimeoutError extends Error {
  constructor(
    readonly server: string,
    readonly tool: string,
    readonly timeoutMs: number,
  ) {
    super(
      `The call to ${tool} on server "${server}" timed out after ${formatMs(timeoutMs)} and was cancelled. ` +
        `The server's per-call limit is "timeoutMs".`,
    );
    this.name = 'CallTimeoutError';
  }
}

export function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
