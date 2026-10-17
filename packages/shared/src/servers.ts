import type { ServerEntry } from './config.js';

/** Server statuses, as in SPEC section 6.3. */
export const SERVER_STATUSES = ['starting', 'ready', 'needs_auth', 'error', 'crashed', 'stopped'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export interface ServerStatusInfo {
  state: ServerStatus;
  /** Short human-readable detail: the last error, the missing secret name, and so on. */
  detail?: string;
  /** When the server entered this status (ISO 8601). */
  since: string;
}

export interface ServerSummary {
  name: string;
  transport: 'stdio' | 'http';
  description?: string;
  enabled: boolean;
  status: ServerStatusInfo;
  /** Protocol version negotiated on the current (or last) connection. */
  protocolVersion?: string;
  tools: { total: number; enabled: number };
  /** Seconds since the current connection became ready (only while ready). */
  uptimeSeconds?: number;
}

/** One tool in the catalog. */
export interface ToolInfo {
  /** `server__tool`. */
  fullName: string;
  server: string;
  /** The tool's name on its server. */
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /** False when the server is disabled or the tool is in the server's `disabledTools`. */
  enabled: boolean;
  /** False when the server is not `ready`; the tool is the last known definition. */
  available: boolean;
  /** Set when the upstream name breaks MCPier's naming rule; the tool is kept and callable. */
  flag?: string;
}

export interface ServerDetail {
  server: ServerSummary;
  /** The entry exactly as stored in config.json: secret references are never resolved. */
  config: ServerEntry;
  tools: ToolInfo[];
}

/** Separator between server and tool in a full tool name. */
export const TOOL_NAME_SEPARATOR = '__';

/**
 * Splits `server__tool` at the first `__`. Server names never contain `__`, so this is
 * unambiguous even when the tool's own name contains one.
 */
export function splitFullToolName(fullName: string): { server: string; tool: string } | undefined {
  const index = fullName.indexOf(TOOL_NAME_SEPARATOR);
  if (index <= 0 || index + TOOL_NAME_SEPARATOR.length >= fullName.length) return undefined;
  return { server: fullName.slice(0, index), tool: fullName.slice(index + TOOL_NAME_SEPARATOR.length) };
}

export function fullToolName(server: string, tool: string): string {
  return `${server}${TOOL_NAME_SEPARATOR}${tool}`;
}
