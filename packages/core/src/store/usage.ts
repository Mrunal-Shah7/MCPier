// Usage over a time range (Sprint 7), read from `mcpier.db`. Buckets follow the machine's local
// time zone and are built here in JavaScript (calendar arithmetic with local `Date` fields, never
// "add 24 hours"), so a day with a clock change has 23 or 25 hours. Empty buckets are zeros.
import {
  estimateTokens,
  isErrorOutcome,
  USAGE_RANGES,
  USAGE_TOOL_LIMIT,
  type CallOutcomeName,
  type UsageBucket,
  type UsageBucketPoint,
  type UsageClientRow,
  type UsageRangeName,
  type UsageResponse,
  type UsageServerRow,
  type UsageToolRow,
  type UsageTotals,
} from '@mcpier/shared';
import type { Db } from './database.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The start of the local hour or local day that contains `ms`. */
export function bucketStart(ms: number, bucket: UsageBucket): number {
  const date = new Date(ms);
  if (bucket === 'hour') date.setMinutes(0, 0, 0);
  else date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The start of the next bucket. Days step by the calendar, so clock changes are respected. */
export function nextBucketStart(start: number, bucket: UsageBucket): number {
  if (bucket === 'hour') return start + HOUR_MS;
  const date = new Date(start);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/** Every bucket start from the one holding `from` up to the one holding `to`. */
export function bucketStarts(from: number, to: number, bucket: UsageBucket): number[] {
  const starts: number[] = [];
  for (let start = bucketStart(from, bucket); start <= to; start = nextBucketStart(start, bucket)) {
    starts.push(start);
    if (starts.length > 10_000) break;
  }
  return starts;
}

/**
 * A named range ending now: `24h` is the current local hour and the 23 before it, `7d` and
 * `30d` are today and the 6 (or 29) local days before.
 */
export function rangeBounds(
  name: UsageRangeName,
  now: number,
): { from: number; to: number; bucket: UsageBucket } {
  const range = USAGE_RANGES[name];
  if ('hours' in range) {
    return { from: bucketStart(now, 'hour') - (range.hours - 1) * HOUR_MS, to: now, bucket: range.bucket };
  }
  const today = new Date(bucketStart(now, 'day'));
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range.days - 1)).getTime();
  return { from, to: now, bucket: range.bucket };
}

function indexOf(starts: number[], at: number): number {
  let low = 0;
  let high = starts.length - 1;
  if (high < 0 || at < starts[0]!) return -1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= at) low = middle;
    else high = middle - 1;
  }
  return low;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

interface CallRow {
  at: number;
  tool: string;
  server: string | null;
  client_name: string | null;
  outcome: CallOutcomeName;
  duration_ms: number;
  result_bytes: number | null;
}

interface SearchRow {
  at: number;
  result_bytes: number | null;
}

function totalsOf(calls: CallRow[], searches: SearchRow[]): UsageTotals {
  let errors = 0;
  let tokens = 0;
  let withoutSize = 0;
  const durations: number[] = [];
  const perCall: number[] = [];
  for (const call of calls) {
    if (isErrorOutcome(call.outcome)) errors++;
    durations.push(call.duration_ms);
    const estimate = estimateTokens(call.result_bytes);
    if (estimate === undefined) withoutSize++;
    else {
      tokens += estimate;
      perCall.push(estimate);
    }
  }
  durations.sort((a, b) => a - b);
  perCall.sort((a, b) => a - b);
  let searchTokens = 0;
  for (const search of searches) searchTokens += estimateTokens(search.result_bytes) ?? 0;
  return {
    calls: calls.length,
    errors,
    errorRate: calls.length > 0 ? errors / calls.length : null,
    tokens,
    avgTokensPerCall: perCall.length > 0 ? Math.round(tokens / perCall.length) : null,
    p95TokensPerCall: percentile(perCall, 0.95),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    callsWithoutSize: withoutSize,
    searchTokens,
    searches: searches.length,
  };
}

export interface UsageQuery {
  /** ms since the epoch. */
  from: number;
  to: number;
  bucket: UsageBucket;
  server?: string;
  /** Every tool in `heaviestTools` instead of the top 20. */
  allTools?: boolean;
}

/**
 * Totals, the previous period's totals, the series per bucket, and the breakdowns by server,
 * tool and client. A range reaching past the retention period is clipped to it.
 */
export function usageReport(
  db: Db,
  query: UsageQuery,
  options: { now: number; retentionDays: number },
): UsageResponse {
  const retentionStart = options.now - options.retentionDays * DAY_MS;
  const clipped = query.from < retentionStart;
  const from = clipped ? retentionStart : query.from;
  const to = Math.max(query.to, from);
  const length = to - from;
  const previousFrom = from - length;

  const serverClause = query.server !== undefined ? 'AND server = @server' : '';
  const params = { from: previousFrom, to, server: query.server ?? null };
  const rows = db
    .prepare(
      `SELECT at, tool, server, client_name, outcome, duration_ms, result_bytes FROM calls
       WHERE at >= @from AND at <= @to ${serverClause} ORDER BY at`,
    )
    .all(params) as CallRow[];
  const searchRows = db
    .prepare(
      `SELECT at, result_bytes FROM searches WHERE at >= @from AND at <= @to ${serverClause} ORDER BY at`,
    )
    .all(params) as SearchRow[];

  const current = rows.filter((row) => row.at >= from);
  const before = rows.filter((row) => row.at < from);
  const currentSearches = searchRows.filter((row) => row.at >= from);
  const searchesBefore = searchRows.filter((row) => row.at < from);

  const starts = bucketStarts(from, to, query.bucket);
  const empty = () => starts.map(() => 0);
  const series: UsageBucketPoint[] = starts.map((start) => ({
    start: new Date(start).toISOString(),
    calls: 0,
    errors: 0,
    tokens: 0,
    p50Ms: null,
    byServer: {},
    byClient: {},
  }));
  const bucketDurations: number[][] = starts.map(() => []);
  const servers = new Map<
    string,
    { calls: number; errors: number; tokens: number; durations: number[]; series: number[] }
  >();
  const tools = new Map<
    string,
    { server?: string; calls: number; sized: number; tokens: number; series: number[]; callSeries: number[] }
  >();
  const clients = new Map<string, number>();

  for (const row of current) {
    const index = indexOf(starts, row.at);
    const point = index >= 0 ? series[index] : undefined;
    const failed = isErrorOutcome(row.outcome);
    const tokens = estimateTokens(row.result_bytes);
    const serverName = row.server ?? '(unknown)';
    const clientName = row.client_name ?? '(unknown)';
    if (point) {
      point.calls++;
      if (failed) point.errors++;
      point.tokens += tokens ?? 0;
      point.byServer[serverName] = (point.byServer[serverName] ?? 0) + 1;
      point.byClient[clientName] = (point.byClient[clientName] ?? 0) + 1;
      bucketDurations[index]!.push(row.duration_ms);
    }
    const server = servers.get(serverName) ?? {
      calls: 0,
      errors: 0,
      tokens: 0,
      durations: [],
      series: empty(),
    };
    server.calls++;
    if (failed) server.errors++;
    server.tokens += tokens ?? 0;
    server.durations.push(row.duration_ms);
    if (index >= 0) server.series[index]!++;
    servers.set(serverName, server);

    const tool = tools.get(row.tool) ?? {
      ...(row.server !== null ? { server: row.server } : {}),
      calls: 0,
      sized: 0,
      tokens: 0,
      series: empty(),
      callSeries: empty(),
    };
    tool.calls++;
    if (tokens !== undefined) {
      tool.sized++;
      tool.tokens += tokens;
      if (index >= 0) tool.series[index]! += tokens;
    }
    if (index >= 0) tool.callSeries[index]!++;
    tools.set(row.tool, tool);

    clients.set(clientName, (clients.get(clientName) ?? 0) + 1);
  }

  series.forEach((point, index) => {
    point.p50Ms = percentile(
      bucketDurations[index]!.sort((a, b) => a - b),
      0.5,
    );
  });

  const byServer: UsageServerRow[] = [...servers.entries()]
    .map(([server, entry]) => ({
      server,
      calls: entry.calls,
      errors: entry.errors,
      tokens: entry.tokens,
      p50Ms: percentile(
        entry.durations.sort((a, b) => a - b),
        0.5,
      ),
      series: entry.series,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.server.localeCompare(b.server));

  const heaviestTools: UsageToolRow[] = [...tools.entries()]
    .map(([tool, entry]) => ({
      tool,
      ...(entry.server !== undefined ? { server: entry.server } : {}),
      calls: entry.calls,
      avgTokens: entry.sized > 0 ? Math.round(entry.tokens / entry.sized) : null,
      tokens: entry.tokens,
      series: entry.series,
      callSeries: entry.callSeries,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, query.allTools ? undefined : USAGE_TOOL_LIMIT);

  const total = current.length;
  const byClient: UsageClientRow[] = [...clients.entries()]
    .map(([client, calls]) => ({ client, calls, share: total > 0 ? calls / total : 0 }))
    .sort((a, b) => b.calls - a.calls || a.client.localeCompare(b.client));

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucket: query.bucket,
    ...(query.server !== undefined ? { server: query.server } : {}),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    clipped,
    retentionDays: options.retentionDays,
    totals: totalsOf(current, currentSearches),
    previous: {
      ...totalsOf(before, searchesBefore),
      from: new Date(previousFrom).toISOString(),
      to: new Date(from).toISOString(),
    },
    series,
    byServer,
    heaviestTools,
    byClient,
  };
}
