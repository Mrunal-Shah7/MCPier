import {
  CLIENT_CAPABILITIES_META_KEY,
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnsupportedProtocolVersionError,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import type { ProtocolMode } from '@mcpier/shared';
import { projectVersion } from '../version.js';
import type { ServerLog } from './server-log.js';
import type { CallOptions, UpstreamCallResult } from './types.js';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** The SDK negotiation mode for a server's `protocol` setting (HTTP; stdio maps `auto` itself). */
export function negotiationMode(protocol: ProtocolMode): VersionNegotiationMode {
  if (protocol === 'legacy') return 'legacy';
  if (protocol === 'modern') return { pin: MODERN_PROTOCOL_VERSION };
  return 'auto';
}

export interface UpstreamClientHooks {
  onToolsChanged: () => void;
  log: ServerLog;
}

/**
 * The one SDK client for a server. It advertises no capabilities at all (no roots, no
 * sampling, no elicitation) and registers no handlers for server-to-client requests, so the
 * SDK answers any such request with an error. Tool-list changes and protocol log messages
 * are the only notifications MCPier acts on; log messages go to the server log only.
 */
export function createUpstreamClient(mode: VersionNegotiationMode, hooks: UpstreamClientHooks): Client {
  const client = new Client(
    { name: 'mcpier', version: projectVersion() },
    { capabilities: {}, versionNegotiation: { mode } },
  );
  client.setNotificationHandler('notifications/tools/list_changed', () => hooks.onToolsChanged());
  client.setNotificationHandler('notifications/message', (notification) => {
    const { level, logger, data } = notification.params;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    hooks.log.write('server', `${level}${logger ? ` ${logger}` : ''}: ${text}`);
  });
  return client;
}

export function isUnsupportedVersion(error: unknown): boolean {
  if (error instanceof UnsupportedProtocolVersionError) return true;
  return (
    error instanceof SdkHttpError &&
    /-32022|Unsupported protocol version/.test(String(error.data?.text ?? ''))
  );
}

export function isTimeout(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}

/** Status code of an HTTP failure, if the error carries one. */
export function httpStatus(error: unknown): number | undefined {
  if (error instanceof SdkHttpError) return error.status;
  return undefined;
}

export function isAuthFailure(error: unknown): boolean {
  if (error instanceof SdkError) {
    if (
      error.code === SdkErrorCode.ClientHttpAuthentication ||
      error.code === SdkErrorCode.ClientHttpForbidden
    ) {
      return true;
    }
  }
  const status = httpStatus(error);
  return status === 401 || status === 403;
}

/** A network-level failure (nothing listening, DNS, reset), as opposed to an answer. */
export function isNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const message = String((current as Error).message ?? '');
    const code = (current as NodeJS.ErrnoException).code;
    if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(message))
      return true;
    if (code && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_)/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The deepest useful message of an error chain, for "cannot reach" explanations. */
export function rootMessage(error: unknown): string {
  let current: unknown = error;
  let message = String((error as Error)?.message ?? error);
  for (let depth = 0; current && depth < 5; depth++) {
    const next = (current as { cause?: unknown }).cause;
    if (!next) break;
    const nextMessage = (next as Error).message;
    if (nextMessage) message = nextMessage;
    current = next;
  }
  return message;
}

/**
 * Liveness check on an open connection. 2025-era servers get `ping`; `ping` does not exist in
 * the 2026-07-28 era (the SDK refuses it locally), so modern servers, and older ones that do
 * not implement ping, get an uncached tool listing instead.
 */
export async function checkAlive(client: Client, timeoutMs: number): Promise<void> {
  const listing = () => client.listTools(undefined, { cacheMode: 'bypass', timeout: timeoutMs });
  if (client.getNegotiatedProtocolVersion() === MODERN_PROTOCOL_VERSION) {
    await listing();
    return;
  }
  try {
    await client.ping({ timeout: timeoutMs });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== -32601 && code !== SdkErrorCode.MethodNotSupportedByProtocolVersion) throw error;
    await listing();
  }
}

/** `_meta` keys MCPier forwards upstream: W3C trace context only. */
export const TRACE_META_KEYS = ['traceparent', 'tracestate', 'baggage'] as const;

/** The trace-context keys of a request's `_meta` (strings only). */
export function traceMetaOf(meta: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of TRACE_META_KEYS) {
    const value = meta?.[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * One upstream `tools/call`. `input_required` comes back as a result (never auto-fulfilled:
 * MCPier has no elicitation handler of its own). On 2026-07-28 connections the downstream
 * client's elicitation capability rides in the per-request `_meta` envelope, and a retry
 * carries `inputResponses` and the upstream `requestState`; legacy connections get the
 * trace keys only.
 */
export async function callUpstreamTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options: CallOptions,
): Promise<UpstreamCallResult> {
  const modern = client.getNegotiatedProtocolVersion() === MODERN_PROTOCOL_VERSION;
  const meta: Record<string, unknown> = { ...options.traceMeta };
  if (modern && options.elicitation)
    meta[CLIENT_CAPABILITIES_META_KEY] = { elicitation: options.elicitation };
  const params: Record<string, unknown> = { name, arguments: args };
  if (Object.keys(meta).length > 0) params._meta = meta;
  if (modern && options.inputResponses) params.inputResponses = options.inputResponses;
  if (modern && options.requestState !== undefined) params.requestState = options.requestState;
  return (await client.callTool(params as Parameters<Client['callTool']>[0], {
    timeout: options.timeoutMs,
    signal: options.signal,
    allowInputRequired: true,
  })) as UpstreamCallResult;
}
