// Request and response types of the admin API routes added in Sprint 2. Every route lives
// under /api and needs the admin token; errors use `ApiErrorResponse`.
import { z } from 'zod';
import type { ImportCandidate, ImportProblem, ImportParseResult } from './import.js';
import type { ServerDetail, ServerStatus, ServerSummary, ToolInfo } from './servers.js';

/** Route paths, shared by the gateway and the CLI so they never drift apart. */
export const API_PATHS = {
  status: '/api/status',
  servers: '/api/servers',
  server: (name: string) => `/api/servers/${encodeURIComponent(name)}`,
  serverAction: (name: string, action: ServerAction) => `/api/servers/${encodeURIComponent(name)}/${action}`,
  serverLogs: (name: string) => `/api/servers/${encodeURIComponent(name)}/logs`,
  serverLogStream: (name: string) => `/api/servers/${encodeURIComponent(name)}/logs/stream`,
  /** `GET [?theme=light|dark]`: the cached logo (404 without one). */
  serverIcon: (name: string) => `/api/servers/${encodeURIComponent(name)}/icon`,
  /** `POST`: fetch the logo again now, ignoring the cache timers. */
  serverIconRefresh: (name: string) => `/api/servers/${encodeURIComponent(name)}/icon/refresh`,
  import: '/api/import',
  tools: '/api/tools',
  toolSearch: '/api/tools/search',
  toolAction: (fullName: string, action: 'enable' | 'disable' | 'call') =>
    `/api/tools/${encodeURIComponent(fullName)}/${action}`,
  secrets: '/api/secrets',
  secret: (name: string) => `/api/secrets/${encodeURIComponent(name)}`,
} as const;

export const SERVER_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable', 'refresh'] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

// ---- Servers

/** `GET /api/servers` */
export interface ServerListResponse {
  servers: ServerSummary[];
}

/** `GET /api/servers/:name` */
export type ServerDetailResponse = ServerDetail;

/**
 * `PATCH /api/servers/:name`: fields to change, merged onto the stored entry (unknown keys on
 * the entry are kept). `null` removes an optional field. The name cannot change.
 */
export const EditServerRequestSchema = z.record(z.string(), z.unknown());

/** `POST /api/servers`, `PATCH /api/servers/:name`, `POST /api/servers/:name/<action>` */
export interface ServerResponse {
  server: ServerSummary;
}

/**
 * `PUT /api/servers/:name`: the whole entry replaces the stored one. Keys left out are
 * removed; keys MCPier does not use are kept and listed in `warnings`. The name cannot change.
 */
export interface ServerReplaceResponse extends ServerResponse {
  /** One line per key MCPier does not use: `<key>: not used by MCPier`. */
  warnings: string[];
}

/** `DELETE /api/servers/:name` */
export interface ServerRemovedResponse {
  removed: string;
}

/** `GET /api/servers/:name/logs?lines=N` (default 100, at most 5000) */
export interface ServerLogResponse {
  server: string;
  lines: string[];
}

// ---- Import

/** `POST /api/import`: a pasted `mcpServers` block, previewed (`dryRun`) or created. */
export const ImportRequestSchema = z.object({
  source: z.unknown(),
  dryRun: z.boolean().optional(),
  /** Refuse (per entry) instead of moving a plain OAuth client secret into a secret. */
  keepSecrets: z.boolean().optional(),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export interface ImportResponse {
  dryRun: boolean;
  shape: ImportParseResult['shape'];
  /** Entries that convert cleanly. In a dry run, sensitive plain values are hidden. */
  entries: ImportCandidate[];
  /** Entries that could not be imported, with the reason. */
  errors: ImportProblem[];
  /** Server names created (empty in a dry run). */
  created: string[];
}

// ---- Tools

/** `GET /api/tools?server=<name>` */
export interface ToolListResponse {
  tools: ToolInfo[];
}

/** One match from tool search (the meta-tool `search_tools` and `GET /api/tools/search`). */
export interface ToolSearchMatch {
  name: string;
  server: string;
  title?: string;
  description?: string;
  /** The input schema, or a short outline of it when it is very large. */
  inputSchema: Record<string, unknown>;
  inputSchemaOutlined?: boolean;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  available: boolean;
  /** The server's status when the tool is not available. */
  serverStatus?: ServerStatus;
}

/** `GET /api/tools/search?q=<query>&limit=<n>&server=<name>` */
export interface ToolSearchResponse {
  query: string;
  results: ToolSearchMatch[];
}

/** Header naming the client of an admin request, for the call and search records. */
export const CLIENT_NAME_HEADER = 'x-mcpier-client';

/** `POST /api/tools/:fullName/enable|disable` */
export interface ToolResponse {
  tool: ToolInfo;
}

/** `POST /api/tools/:fullName/call` */
export const CallToolRequestSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export interface ToolCallResponse {
  /** The upstream result unchanged (content, structuredContent, isError), minus secret values. */
  result: Record<string, unknown>;
  durationMs: number;
}

// ---- Secrets

export interface SecretInfo {
  name: string;
  /** Last four characters, only for values of at least eight. */
  last4?: string;
  /** Servers whose env or headers reference it. */
  usedBy: string[];
}

/** `GET /api/secrets` */
export interface SecretListResponse {
  secrets: SecretInfo[];
  /** Referenced in config but not stored. */
  missing: { name: string; usedBy: string[] }[];
}

/** `PUT /api/secrets/:name` (the body is never logged) */
export const SetSecretRequestSchema = z.object({ value: z.string() });

export interface SecretSetResponse {
  name: string;
  /** Servers restarted because they reference it. */
  restarted: string[];
}

/** `DELETE /api/secrets/:name?force=true` */
export interface SecretDeleteResponse {
  name: string;
  deleted: boolean;
  restarted: string[];
}
