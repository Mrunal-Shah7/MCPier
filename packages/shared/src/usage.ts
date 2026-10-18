// Usage (Sprint 7): calls over time, estimated tokens returned, the heaviest tools, and usage by
// server and by client, all from `mcpier.db` (so within the retention period). Tokens are an
// estimate from the size of each result as the caller received it.

/** Bytes per token in the estimate. One place, so the ratio can change later. */
export const BYTES_PER_TOKEN = 4;

/**
 * Estimated tokens for a result of `bytes` (UTF-8 JSON, as the caller received it): about four
 * bytes per token. Nothing for a call recorded without a size (before 1.1.0).
 */
export function estimateTokens(bytes: number | null | undefined): number | undefined {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export const USAGE_BUCKETS = ['hour', 'day'] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

/** The ranges the dashboard offers: 24 hours by hour, 7 and 30 days by day. */
export const USAGE_RANGES = {
  '24h': { hours: 24, bucket: 'hour' },
  '7d': { days: 7, bucket: 'day' },
  '30d': { days: 30, bucket: 'day' },
} as const satisfies Record<string, { hours?: number; days?: number; bucket: UsageBucket }>;
export type UsageRangeName = keyof typeof USAGE_RANGES;

/** Most tools the heaviest-tools list holds by default; `tools=all` lifts it. */
export const USAGE_TOOL_LIMIT = 20;

export interface UsageTotals {
  calls: number;
  errors: number;
  /** errors ÷ calls, or null without calls. */
  errorRate: number | null;
  /** Estimated tokens of every call with a size. */
  tokens: number;
  /** Over calls with a size: the average and the 95th percentile of tokens per call. */
  avgTokensPerCall: number | null;
  p95TokensPerCall: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Calls recorded without a size (before 1.1.0): counted, not estimated. */
  callsWithoutSize: number;
  /** Estimated tokens of what `search_tools` returned (not part of `tokens`). */
  searchTokens: number;
  searches: number;
}

/** One bucket of the series. `start` is the bucket's start in the machine's local time zone. */
export interface UsageBucketPoint {
  /** ISO 8601. */
  start: string;
  calls: number;
  errors: number;
  tokens: number;
  /** Median duration of the calls in this bucket, or null without calls. */
  p50Ms: number | null;
  /** Calls per server in this bucket (servers with none are left out). */
  byServer: Record<string, number>;
  /** Calls per client name in this bucket. */
  byClient: Record<string, number>;
}

export interface UsageServerRow {
  server: string;
  calls: number;
  errors: number;
  tokens: number;
  p50Ms: number | null;
  /** Calls per bucket, aligned with `series`. */
  series: number[];
}

export interface UsageToolRow {
  tool: string;
  server?: string;
  calls: number;
  /** Over calls with a size. */
  avgTokens: number | null;
  tokens: number;
  /** Tokens per bucket, aligned with `series`. */
  series: number[];
  /** Calls per bucket, aligned with `series`. */
  callSeries: number[];
}

export interface UsageClientRow {
  /** The client name, or "(unknown)". */
  client: string;
  calls: number;
  /** calls ÷ all calls in the range. */
  share: number;
}

/** `GET /api/usage?from=&to=&bucket=hour|day&server=&tools=all` */
export interface UsageResponse {
  /** The range answered, after clipping to the retention period (ISO 8601). */
  from: string;
  to: string;
  bucket: UsageBucket;
  server?: string;
  /** The machine's IANA time zone the buckets follow. */
  timeZone: string;
  /** The requested range reached past `logRetentionDays` and was clipped. */
  clipped: boolean;
  retentionDays: number;
  totals: UsageTotals;
  /** The same totals for the period of equal length just before `from`. */
  previous: UsageTotals & { from: string; to: string };
  series: UsageBucketPoint[];
  byServer: UsageServerRow[];
  /** By total tokens, highest first: the top 20 (or every tool with `tools=all`). */
  heaviestTools: UsageToolRow[];
  byClient: UsageClientRow[];
}

export const USAGE_PATH = '/api/usage';
