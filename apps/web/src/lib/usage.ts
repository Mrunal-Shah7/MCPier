// Usage data for the dashboard (Sprint 7): the usage route, recent calls, and formatting.
import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  CALL_LOG_PATHS,
  USAGE_PATH,
  type CallListResponse,
  type UsageBucket,
  type UsageRangeName,
  type UsageResponse,
} from '@mcpier/shared';
import { api } from './api';

export interface UsageQuery {
  range: UsageRangeName;
  server?: string;
  /** Every tool, not only the 20 heaviest (the Tools catalog's sparklines). */
  allTools?: boolean;
}

export const usageKeys = {
  all: ['usage'] as const,
  one: (query: UsageQuery) => ['usage', query.range, query.server ?? '', query.allTools === true] as const,
  recent: (server?: string) => ['usage', 'recent-calls', server ?? ''] as const,
};

export function usagePath(query: UsageQuery): string {
  const params = new URLSearchParams({ range: query.range });
  if (query.server) params.set('server', query.server);
  if (query.allTools) params.set('tools', 'all');
  return `${USAGE_PATH}?${params}`;
}

export const useUsage = (query: UsageQuery, enabled = true) =>
  useQuery({
    queryKey: usageKeys.one(query),
    queryFn: () => api.get<UsageResponse>(usagePath(query)),
    enabled,
  });

/** The last few calls, optionally of one server (rails). */
export const useRecentCalls = (server?: string, limit = 5) =>
  useQuery({
    queryKey: [...usageKeys.recent(server), limit],
    queryFn: () =>
      api.get<CallListResponse>(
        `${CALL_LOG_PATHS.calls}?${new URLSearchParams({ limit: String(limit), ...(server ? { server } : {}) })}`,
      ),
  });

/** At most one usage refetch every 5 seconds while calls stream in (Phase 5.1). */
export const USAGE_REFRESH_MS = 5_000;
let lastRefresh = 0;
let pending: ReturnType<typeof setTimeout> | undefined;

export function refreshUsageThrottled(client: QueryClient, now = Date.now()): void {
  const run = () => {
    lastRefresh = Date.now();
    pending = undefined;
    void client.invalidateQueries({ queryKey: usageKeys.all });
  };
  if (pending) return;
  const wait = lastRefresh + USAGE_REFRESH_MS - now;
  if (wait <= 0) run();
  else pending = setTimeout(run, wait);
}

/** Tests: forget the throttle state. */
export function resetUsageThrottle(): void {
  if (pending) clearTimeout(pending);
  pending = undefined;
  lastRefresh = 0;
}

export function bucketLabel(iso: string, bucket: UsageBucket): string {
  const date = new Date(iso);
  if (bucket === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`;
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(Math.round(value / 100_000) / 10).toString()}M`;
  if (value >= 1000) return `${(Math.round(value / 100) / 10).toString()}k`;
  return value.toLocaleString();
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}
