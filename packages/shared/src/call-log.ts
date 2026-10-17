// The call log and search log (Sprint 6): what the admin API and the dashboard see. Records
// never carry a secret value, a token, `requestState` or an elicitation answer; bodies are
// redacted before they are stored, and only when the `storeCallBodies` setting is on.
import { z } from 'zod';

/** Which side a call or search came from. */
export const CLIENT_ERAS = ['modern', 'legacy', 'admin'] as const;
export type ClientEraName = (typeof CLIENT_ERAS)[number];

export const CALL_OUTCOME_NAMES = [
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
export type CallOutcomeName = (typeof CALL_OUTCOME_NAMES)[number];

/** Outcomes that count as errors in the stats (everything but ok and input_required). */
export function isErrorOutcome(outcome: CallOutcomeName): boolean {
  return outcome !== 'ok' && outcome !== 'input_required';
}

/** A search's follow-up: the next call from the same client within 5 minutes. */
export const SEARCH_FOLLOWUPS = ['hit', 'miss', 'none', 'pending'] as const;
export type SearchFollowup = (typeof SEARCH_FOLLOWUPS)[number];

/** How long a search waits for its follow-up call. */
export const SEARCH_FOLLOWUP_WINDOW_MS = 5 * 60_000;

/** Each stored body is cut at this many bytes (UTF-8). */
export const CALL_BODY_LIMIT_BYTES = 64 * 1024;

export interface RecordClient {
  name?: string;
  version?: string;
}

/** One call, without bodies (lists and the `call_recorded` event). */
export interface CallSummary {
  id: number;
  /** ISO 8601. */
  at: string;
  client: RecordClient;
  era: ClientEraName;
  /** The full name asked for (it may not exist). */
  tool: string;
  server?: string;
  durationMs: number;
  outcome: CallOutcomeName;
  traceId?: string;
  /** Whether arguments and result were stored for this call. */
  bodiesStored: boolean;
}

/** A stored body: JSON text, possibly cut (then no longer valid JSON). */
export interface StoredBody {
  text: string;
  truncated: boolean;
}

/** `GET /api/calls/:id` */
export interface CallDetail extends CallSummary {
  /** A short error text for failed outcomes (redacted). */
  errorText?: string;
  arguments?: StoredBody;
  result?: StoredBody;
}

/** One entry of the call list: the summary plus the short error text. */
export interface CallListItem extends CallSummary {
  errorText?: string;
}

/** `GET /api/calls` */
export interface CallListResponse {
  calls: CallListItem[];
  /** Pass as `cursor` for the next (older) page; absent on the last page. */
  nextCursor?: string;
}

export interface SearchSummary {
  id: number;
  at: string;
  client: RecordClient;
  era: ClientEraName;
  query: string;
  server?: string;
  limit?: number;
  resultCount: number;
  /** Full tool names returned, in order. */
  results: string[];
  durationMs: number;
  followup: SearchFollowup;
  /** The call that followed (hit or miss). */
  followupCallId?: number;
  /** The tool that call asked for (hit or miss). */
  calledTool?: string;
  /** 1-based rank of the called tool in the results (hits only). */
  rank?: number;
}

/** `GET /api/searches` */
export interface SearchListResponse {
  searches: SearchSummary[];
  nextCursor?: string;
}

export interface ServerCallStats {
  server: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

/** `GET /api/calls/stats?from=&to=` */
export interface CallStatsResponse {
  from?: string;
  to?: string;
  calls: {
    total: number;
    errors: number;
    /** errors ÷ total, or null without calls. */
    errorRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    byOutcome: Partial<Record<CallOutcomeName, number>>;
    byServer: ServerCallStats[];
  };
  searches: {
    total: number;
    hits: number;
    misses: number;
    none: number;
    pending: number;
    /** hits ÷ (hits + misses), or null when there is neither. */
    hitRate: number | null;
  };
  /** The 20 most recent misses: what was searched, what came back, what was called instead. */
  recentMisses: { searchId: number; at: string; query: string; results: string[]; calledTool: string }[];
}

/** `DELETE /api/calls?confirm=true` */
export interface ClearCallLogResponse {
  deletedCalls: number;
  deletedSearches: number;
}

/** Where calls and searches are recorded (`/api/status`). */
export interface CallLogState {
  store: 'sqlite' | 'log';
  /** Why the database is not used (the log recorder took over). */
  problem?: string;
}

const toolPath = (fullName: string) => (fullName.startsWith(':') ? fullName : encodeURIComponent(fullName));

/** Call log and Tester routes under /api (token or cookie required). */
export const CALL_LOG_PATHS = {
  /** `GET` (filters, cursor) and `DELETE ?confirm=true` (clear the log). */
  calls: '/api/calls',
  call: (id: number | string) => `/api/calls/${encodeURIComponent(String(id))}`,
  stats: '/api/calls/stats',
  searches: '/api/searches',
  /** `POST { arguments }`: the validation `call_tool` would run. */
  validate: (fullName: string) => `/api/tools/${toolPath(fullName)}/validate`,
  /** `POST` a Tester run (see `TesterCallRequest`). */
  test: (fullName: string) => `/api/tools/${toolPath(fullName)}/test`,
} as const;

/** Most calls or searches one page holds. */
export const CALL_PAGE_SIZE_MAX = 200;

/** One validation problem, placed for a form: `path` leads from the arguments to the field. */
export interface ArgumentProblem {
  path: (string | number)[];
  /** `arguments.address.zip` */
  location: string;
  message: string;
}

export const ValidateArgumentsRequestSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
});

/** `POST /api/tools/:fullName/validate` */
export type ValidateArgumentsResponse =
  | { result: 'valid' }
  | { result: 'invalid'; problems: ArgumentProblem[] }
  /** The schema could not be compiled (or is too deep): `call_tool` would not validate either. */
  | { result: 'not_validated'; reason: string };

/** The Tester's client name in the call log. */
export const TESTER_CLIENT_NAME = 'dashboard-tester';

/**
 * `model`: exactly as `call_tool` runs it (validation, truncation, `input_required`).
 * `raw`: the admin call route (no validation by MCPier, no truncation, no elicitation).
 */
export const TESTER_MODES = ['model', 'raw'] as const;
export type TesterMode = (typeof TESTER_MODES)[number];

export const TesterCallRequestSchema = z.object({
  mode: z.enum(TESTER_MODES).default('model'),
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** Model mode, a retry after `input_required`: the answers, keyed like `inputRequests`. */
  inputResponses: z.record(z.string(), z.unknown()).optional(),
  /** Model mode, a retry: MCPier's signed state from the `input_required` answer, unchanged. */
  requestState: z.string().optional(),
});
export type TesterCallRequest = z.input<typeof TesterCallRequestSchema>;

/** What the result size limit cut (model mode). */
export interface TesterTruncation {
  text?: { shownBytes: number; droppedBytes: number };
  structuredDroppedBytes?: number;
}

/** `POST /api/tools/:fullName/test` */
export interface TesterCallResponse {
  mode: TesterMode;
  outcome: CallOutcomeName;
  durationMs: number;
  /**
   * What the caller gets: a tool result, or in model mode MCPier's own `input_required`
   * (`inputRequests` and the signed `requestState` to send back with the answers).
   */
  result?: Record<string, unknown>;
  truncation?: TesterTruncation;
  /** Raw mode: why there is no result. */
  error?: string;
}
