// The Call log page's data: filters kept in the page URL, the queries, and how a live
// `call_recorded` event is matched against the filters.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CALL_LOG_PATHS,
  CALL_OUTCOME_NAMES,
  SEARCH_FOLLOWUPS,
  type CallDetail,
  type CallListResponse,
  type CallOutcomeName,
  type CallStatsResponse,
  type CallSummary,
  type ClearCallLogResponse,
  type SearchFollowup,
  type SearchListResponse,
} from '@mcpier/shared';
import { api } from './api';

export const RANGES = [
  { key: '1h', label: 'Last hour', ms: 3_600_000 },
  { key: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { key: 'custom', label: 'Custom', ms: 0 },
] as const;
export type RangeKey = (typeof RANGES)[number]['key'];
export const DEFAULT_RANGE: RangeKey = '24h';

export interface CallFilters {
  range: RangeKey;
  /** Custom range only (ISO 8601). */
  from?: string;
  to?: string;
  server?: string;
  client?: string;
  outcome?: CallOutcomeName;
  tool?: string;
  /** Search tab only. */
  followup?: SearchFollowup;
}

/** The filter keys in the page URL (the tab and the open call are kept beside them). */
const FILTER_KEYS = ['range', 'from', 'to', 'server', 'client', 'outcome', 'tool', 'followup'] as const;

export function filtersFromParams(params: URLSearchParams): CallFilters {
  const range = RANGES.find((entry) => entry.key === params.get('range'))?.key ?? DEFAULT_RANGE;
  const text = (key: string) => params.get(key)?.trim() || undefined;
  const outcome = params.get('outcome');
  const followup = params.get('followup');
  const time = (key: string) => {
    const value = text(key);
    return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
  };
  return {
    range,
    ...(range === 'custom' && time('from') ? { from: time('from') } : {}),
    ...(range === 'custom' && time('to') ? { to: time('to') } : {}),
    ...(text('server') ? { server: text('server') } : {}),
    ...(text('client') ? { client: text('client') } : {}),
    ...(outcome && (CALL_OUTCOME_NAMES as readonly string[]).includes(outcome)
      ? { outcome: outcome as CallOutcomeName }
      : {}),
    ...(text('tool') ? { tool: text('tool') } : {}),
    ...(followup && (SEARCH_FOLLOWUPS as readonly string[]).includes(followup)
      ? { followup: followup as SearchFollowup }
      : {}),
  };
}

/** Writes the filters into the URL's parameters, keeping the others (tab, call). */
export function withFilters(params: URLSearchParams, filters: CallFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) next.delete(key);
  if (filters.range !== DEFAULT_RANGE) next.set('range', filters.range);
  if (filters.range === 'custom') {
    if (filters.from) next.set('from', filters.from);
    if (filters.to) next.set('to', filters.to);
  }
  for (const key of ['server', 'client', 'outcome', 'tool', 'followup'] as const) {
    const value = filters[key];
    if (value) next.set(key, value);
  }
  return next;
}

/** The time bounds of the filters, in milliseconds, at `now`. */
export function rangeBounds(filters: CallFilters, now = Date.now()): { from?: number; to?: number } {
  if (filters.range === 'custom') {
    return {
      ...(filters.from ? { from: Date.parse(filters.from) } : {}),
      ...(filters.to ? { to: Date.parse(filters.to) } : {}),
    };
  }
  const span = RANGES.find((entry) => entry.key === filters.range)!.ms;
  return { from: now - span };
}

function timeParams(filters: CallFilters, now: number): URLSearchParams {
  const params = new URLSearchParams();
  const { from, to } = rangeBounds(filters, now);
  if (from !== undefined) params.set('from', new Date(from).toISOString());
  if (to !== undefined) params.set('to', new Date(to).toISOString());
  return params;
}

export const PAGE_SIZE = 50;

export function callsPath(filters: CallFilters, cursor?: string, now = Date.now()): string {
  const params = timeParams(filters, now);
  for (const key of ['server', 'client', 'outcome', 'tool'] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return `${CALL_LOG_PATHS.calls}?${params}`;
}

export function searchesPath(filters: CallFilters, cursor?: string, now = Date.now()): string {
  const params = timeParams(filters, now);
  if (filters.client) params.set('client', filters.client);
  if (filters.followup) params.set('outcome', filters.followup);
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return `${CALL_LOG_PATHS.searches}?${params}`;
}

export function statsPath(filters: CallFilters, now = Date.now()): string {
  const params = timeParams(filters, now);
  const query = params.toString();
  return query ? `${CALL_LOG_PATHS.stats}?${query}` : CALL_LOG_PATHS.stats;
}

/** Whether a new call belongs in the list the filters show. */
export function matchesFilters(call: CallSummary, filters: CallFilters, now = Date.now()): boolean {
  const at = Date.parse(call.at);
  const { from, to } = rangeBounds(filters, now);
  if (from !== undefined && at < from) return false;
  if (to !== undefined && at > to) return false;
  if (filters.server && call.server !== filters.server) return false;
  if (filters.client && call.client.name !== filters.client) return false;
  if (filters.outcome && call.outcome !== filters.outcome) return false;
  if (filters.tool && !call.tool.toLowerCase().includes(filters.tool.toLowerCase())) return false;
  return true;
}

/** Keys without the Search-tab filter for calls, and without the call filters for searches. */
const callKeyOf = ({ followup: _f, ...rest }: CallFilters) => rest;

export const callLogKeys = {
  calls: (filters: CallFilters) => ['calls', callKeyOf(filters)] as const,
  allCalls: ['calls'] as const,
  call: (id: number) => ['call', id] as const,
  stats: (filters: CallFilters) => ['call-stats', filters.range, filters.from, filters.to] as const,
  allStats: ['call-stats'] as const,
  searches: (filters: CallFilters) =>
    ['searches', filters.range, filters.from, filters.to, filters.client, filters.followup] as const,
  allSearches: ['searches'] as const,
};

export const useCalls = (filters: CallFilters) =>
  useInfiniteQuery({
    queryKey: callLogKeys.calls(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<CallListResponse>(callsPath(filters, pageParam)),
    getNextPageParam: (last) => last.nextCursor,
    // New calls arrive by event (or the "N new calls" control); no background refetch.
    staleTime: Infinity,
  });

export const useCallDetail = (id: number | undefined) =>
  useQuery({
    queryKey: callLogKeys.call(id ?? -1),
    enabled: id !== undefined,
    queryFn: () => api.get<CallDetail>(CALL_LOG_PATHS.call(id!)),
    staleTime: Infinity,
  });

export const useCallStats = (filters: CallFilters) =>
  useQuery({
    queryKey: callLogKeys.stats(filters),
    queryFn: () => api.get<CallStatsResponse>(statsPath(filters)),
  });

/** All-time totals (the Clear log confirmation names them). */
export const useAllTimeStats = (enabled: boolean) =>
  useQuery({
    queryKey: [...callLogKeys.allStats, 'all-time'],
    enabled,
    queryFn: () => api.get<CallStatsResponse>(CALL_LOG_PATHS.stats),
    staleTime: 0,
  });

export const useSearches = (filters: CallFilters) =>
  useInfiniteQuery({
    queryKey: callLogKeys.searches(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<SearchListResponse>(searchesPath(filters, pageParam)),
    getNextPageParam: (last) => last.nextCursor,
  });

export function useClearLog() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<ClearCallLogResponse>(`${CALL_LOG_PATHS.calls}?confirm=true`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: callLogKeys.allCalls });
      void client.invalidateQueries({ queryKey: callLogKeys.allStats });
      void client.invalidateQueries({ queryKey: callLogKeys.allSearches });
      client.removeQueries({ queryKey: ['call'] });
    },
  });
}

/** A stored body for people: pretty-printed JSON, or the text as stored (a cut body is not JSON). */
export function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The outcome's colour group. */
export function outcomeTone(outcome: CallOutcomeName): 'ok' | 'info' | 'warn' | 'error' {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'input_required') return 'info';
  if (outcome === 'tool_error' || outcome === 'validation_error' || outcome === 'cancelled') return 'warn';
  return 'error';
}

export const OUTCOME_LABELS: Record<CallOutcomeName, string> = {
  ok: 'OK',
  tool_error: 'Tool error',
  validation_error: 'Invalid arguments',
  not_found: 'Unknown tool',
  disabled: 'Disabled',
  not_ready: 'Server not ready',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
  input_required: 'Input required',
  failed: 'Failed',
};

export const FOLLOWUP_LABELS: Record<SearchFollowup, string> = {
  hit: 'Hit',
  miss: 'Miss',
  none: 'No follow-up',
  pending: 'Waiting',
};

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}
