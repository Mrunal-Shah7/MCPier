// A server's Activity tab (Confirmed decision 12): its calls from the call log, newest first and
// live; its output (the server log, streamed); and a rail with the last 24 hours.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  API_PATHS,
  CALL_LOG_PATHS,
  splitFullToolName,
  type CallListResponse,
  type CallSummary,
  type ServerLogResponse,
} from '@mcpier/shared';
import { api } from '@/lib/api';
import { formatMs, formatRate } from '@/lib/call-log';
import { useLiveEvents } from '@/lib/live';
import { readSse } from '@/lib/sse';
import { formatDurationMs, formatTokens, useUsage } from '@/lib/usage';
import { CopyButton, ErrorMessage, formatTime, LoadingRows } from '@/components/common';
import { CallDetailPanel, clientLabel } from '@/components/call-detail';
import { Sparkline } from '@/components/charts';
import { EmptyLine, KpiCard, Panel, PanelHeader, RailGrid, Stack } from '@/components/kit';
import { OutcomeBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const ACTIVITY_PAGE_SIZE = 25;

const activityKey = (server: string) => ['activity-calls', server] as const;

function ServerCalls({
  server,
  selected,
  onSelect,
}: {
  server: string;
  selected: number | undefined;
  onSelect: (id: number) => void;
}) {
  const client = useQueryClient();
  const events = useLiveEvents();
  const calls = useInfiniteQuery({
    queryKey: activityKey(server),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<CallListResponse>(
        `${CALL_LOG_PATHS.calls}?${new URLSearchParams({
          server,
          limit: String(ACTIVITY_PAGE_SIZE),
          ...(pageParam ? { cursor: pageParam } : {}),
        })}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
  });

  // A new call of this server goes straight to the top of the list.
  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type !== 'call_recorded' || event.data.server !== server) return;
        const call: CallSummary = event.data;
        client.setQueryData<InfiniteData<CallListResponse, string | undefined>>(
          activityKey(server),
          (old) => {
            if (!old || old.pages.length === 0) return old;
            if (old.pages.some((page) => page.calls.some((known) => known.id === call.id))) return old;
            const [first, ...rest] = old.pages;
            return { ...old, pages: [{ ...first!, calls: [call, ...first!.calls] }, ...rest] };
          },
        );
      }),
    [events, client, server],
  );

  const rows = calls.data?.pages.flatMap((page) => page.calls) ?? [];
  return (
    <Panel aria-label="Calls of this server" className="overflow-hidden">
      <PanelHeader
        title="Calls"
        actions={
          <Link
            to={`/calls?server=${encodeURIComponent(server)}`}
            className="text-faint text-xs hover:underline"
          >
            Open in Call log →
          </Link>
        }
      />
      {calls.isPending ? <LoadingRows label="Loading calls" /> : null}
      {calls.error ? <ErrorMessage error={calls.error} title="Cannot load the calls" /> : null}
      {calls.data && rows.length === 0 ? <EmptyLine>No calls to this server yet.</EmptyLine> : null}
      {rows.length > 0 ? (
        <Table aria-label="Server calls">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((call) => (
              <TableRow
                key={call.id}
                data-call={call.id}
                data-state={selected === call.id ? 'selected' : undefined}
                className="cursor-pointer"
                onClick={() => onSelect(call.id)}
              >
                <TableCell className="text-muted-foreground font-mono text-xs">
                  <button
                    type="button"
                    className="hover:underline"
                    aria-label={`Details of call ${call.id} (${call.tool})`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(call.id);
                    }}
                  >
                    {formatTime(call.at)}
                  </button>
                </TableCell>
                <TableCell className="max-w-40 truncate text-xs">{clientLabel(call.client)}</TableCell>
                <TableCell className="max-w-56 truncate font-mono text-xs" title={call.tool}>
                  {splitFullToolName(call.tool)?.tool ?? call.tool}
                </TableCell>
                <TableCell>
                  <OutcomeBadge outcome={call.outcome} />
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                  {formatMs(call.durationMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {calls.hasNextPage ? (
        <div className="border-t p-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={calls.isFetchingNextPage}
            onClick={() => void calls.fetchNextPage()}
          >
            {calls.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

const MAX_LINES = 2000;

/** The server's log: the last 200 lines, then live. Pause holds new lines; Follow keeps the end in view. */
export function ServerOutput({ server }: { server: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<unknown>();
  const pausedRef = useRef(false);
  const held = useRef<string[]>([]);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    void (async () => {
      try {
        const recent = await api.get<ServerLogResponse>(`${API_PATHS.serverLogs(server)}?lines=200`, {
          signal: controller.signal,
        });
        setLines(recent.lines);
        await readSse(
          API_PATHS.serverLogStream(server),
          (event, data) => {
            if (event !== 'line') return;
            if (pausedRef.current) held.current.push(data);
            else setLines((current) => [...current, data].slice(-MAX_LINES));
          },
          controller.signal,
        );
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught);
      }
    })();
    return () => controller.abort();
  }, [server]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next && held.current.length > 0) {
      const add = held.current.splice(0);
      setLines((current) => [...current, ...add].slice(-MAX_LINES));
    }
  };

  return (
    <Panel aria-label="Server output">
      <PanelHeader
        title="Server output"
        info="stderr, protocol log messages and MCPier's connection events. Secret values are replaced by their names."
        actions={
          <>
            <span className="text-faint text-xs" role="status">
              {paused
                ? `Paused: new lines are held.${held.current.length > 0 ? ` (${held.current.length})` : ''}`
                : 'Live'}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={togglePause}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={follow}
              onClick={() => setFollow((value) => !value)}
            >
              Follow
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setLines([])}>
              Clear view
            </Button>
            <CopyButton text={lines.join('\n')} label={`Copy the ${server} log`} />
          </>
        }
      />
      <div className="p-3.5">
        {error ? <ErrorMessage error={error} title="The log stream stopped" /> : null}
        <pre
          ref={box}
          aria-label={`${server} log`}
          onScroll={(event) => {
            const element = event.currentTarget;
            const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            if (!atEnd && follow) setFollow(false);
          }}
          className="wrap-anywhere bg-panel-2 h-80 overflow-y-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        >
          {lines.length === 0 ? 'No log lines yet.' : lines.join('\n')}
        </pre>
      </div>
    </Panel>
  );
}

function ActivityRail({ server }: { server: string }) {
  const day = useUsage({ range: '24h', server });
  const totals = day.data?.totals;
  const series = day.data?.series ?? [];
  return (
    <Stack>
      <KpiCard
        label="Calls · 24 h"
        value={totals ? totals.calls.toLocaleString() : '—'}
        delta={
          totals ? (
            <span className={totals.errors > 0 ? 'text-tone-bad-text' : 'text-muted-foreground'}>
              {totals.errors} {totals.errors === 1 ? 'error' : 'errors'}
            </span>
          ) : undefined
        }
        chart={
          <Sparkline values={series.map((point) => point.calls)} label="Calls per hour, last 24 hours" />
        }
      />
      <KpiCard
        label="Errors · 24 h"
        value={totals ? totals.errors.toLocaleString() : '—'}
        valueClassName={totals && totals.errors > 0 ? 'text-tone-bad-text' : undefined}
        delta={
          totals?.errorRate !== null && totals?.errorRate !== undefined ? (
            <span className="text-muted-foreground">{formatRate(totals.errorRate)} of calls</span>
          ) : undefined
        }
        chart={
          <Sparkline
            values={series.map((point) => point.errors)}
            label="Errors per hour, last 24 hours"
            tone="bad"
          />
        }
      />
      <KpiCard
        label="Est. tokens · 24 h"
        value={formatTokens(totals?.tokens)}
        delta={
          totals?.avgTokensPerCall !== null && totals?.avgTokensPerCall !== undefined ? (
            <span className="text-muted-foreground">
              avg {formatTokens(totals.avgTokensPerCall)} per call
            </span>
          ) : undefined
        }
        chart={
          <Sparkline
            values={series.map((point) => point.tokens)}
            label="Estimated tokens per hour"
            tone="info"
          />
        }
      />
      <KpiCard
        label="Median duration"
        value={formatDurationMs(totals?.p50Ms)}
        delta={<span className="text-muted-foreground">p95 {formatDurationMs(totals?.p95Ms)}</span>}
        chart={
          <Sparkline
            values={series.map((point) => point.p50Ms ?? 0)}
            label="Median duration per hour"
            tone="input"
          />
        }
      />
    </Stack>
  );
}

export function ActivityTab({
  server,
  selected,
  onSelect,
}: {
  server: string;
  selected: number | undefined;
  onSelect: (id: number | undefined) => void;
}) {
  return (
    <RailGrid>
      <Stack>
        <ServerCalls server={server} selected={selected} onSelect={onSelect} />
        <ServerOutput server={server} />
      </Stack>
      <Stack>
        {selected !== undefined ? (
          <CallDetailPanel id={selected} onClose={() => onSelect(undefined)} />
        ) : null}
        <ActivityRail server={server} />
      </Stack>
    </RailGrid>
  );
}
