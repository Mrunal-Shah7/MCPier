import { z } from 'zod';

/** Identifier `/healthz` returns, so callers can tell MCPier apart from anything else on the port. */
export const SERVICE_ID = 'mcpier';

/** Public liveness endpoint, outside `/api`. */
export const HEALTH_PATH = '/healthz';

/** Name of the HTTP-only cookie that may carry the admin token (set by the dashboard flow, Sprint 4). */
export const ADMIN_COOKIE_NAME = 'mcpier_admin';

/** `GET /healthz`: minimal and public. Nothing sensitive. */
export const HealthResponseSchema = z.object({
  service: z.literal(SERVICE_ID),
  version: z.string(),
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** `GET /api/status` (token required). */
export const StatusResponseSchema = z.object({
  version: z.string(),
  pid: z.number().int(),
  /** ISO 8601 timestamp. */
  startedAt: z.string(),
  uptimeSeconds: z.number(),
  port: z.number().int(),
  dataDir: z.string(),
  servers: z.object({
    configured: z.number().int(),
    enabled: z.number().int(),
    /** How many servers are in each status (statuses with none are left out). */
    byStatus: z.record(z.string(), z.number().int()).default({}),
  }),
  /** Set while config.json on disk is invalid; the gateway runs on the last good config. */
  configProblem: z.object({ file: z.string(), problems: z.array(z.string()), since: z.string() }).optional(),
  /** Where calls and searches are recorded; `log` when `mcpier.db` could not be used. */
  callLog: z.object({ store: z.enum(['sqlite', 'log']), problem: z.string().optional() }).optional(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** `POST /api/shutdown` (token required). Sent before the gateway begins shutting down. */
export const ShutdownResponseSchema = z.object({
  status: z.literal('shutting_down'),
});
export type ShutdownResponse = z.infer<typeof ShutdownResponseSchema>;

/** Machine-readable codes used in admin API error responses. */
export type ApiErrorCode =
  | 'forbidden_host'
  | 'forbidden_origin'
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_request'
  | 'exists'
  | 'conflict'
  | 'not_ready'
  | 'disabled'
  | 'config_invalid'
  | 'secret_in_use'
  | 'timeout'
  | 'upstream_error'
  | 'internal_error';

/** The single error shape every admin API error uses. */
export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Validation problems, one per line, when the request was invalid. */
    problems: z.array(z.string()).optional(),
  }),
});
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    problems?: string[];
  };
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  problems?: readonly string[],
): ApiErrorResponse {
  return {
    error: { code, message, ...(problems && problems.length > 0 ? { problems: [...problems] } : {}) },
  };
}
