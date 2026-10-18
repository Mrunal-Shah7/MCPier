import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import {
  CALL_OUTCOME_NAMES,
  SEARCH_FOLLOWUPS,
  splitFullToolName,
  type CallListResponse,
  type CallOutcomeName,
  type CallSummary,
  type SearchFollowup,
} from '@mcpier/shared';
import {
  callLogKeys,
  filtersFromParams,
  FOLLOWUP_LABELS,
  formatMs,
  formatRate,
  matchesFilters,
  OUTCOME_LABELS,
  RANGES,
  useAllTimeStats,
  useCalls,
  useCallStats,
  useClearLog,
  useSearches,
  withFilters,
  type CallFilters,
  type RangeKey,
} from '@/lib/call-log';
import { useLiveEvents } from '@/lib/live';
import { useServers } from '@/lib/queries';
import { useUsage } from '@/lib/usage';
import { cn } from '@/lib/utils';
import { ConfirmDialog, ErrorMessage, formatShortTime, formatTime, LoadingRows } from '@/components/common';
import { CallDetailPanel, clientLabel } from '@/components/call-detail';
import { Ring, Sparkline } from '@/components/charts';
import { EmptyLine, KpiCard, PageTitle, Panel, PanelHeader } from '@/components/kit';
import { ServerTile } from '@/components/server-tile';
import { FollowupBadge, OutcomeBadge } from '@/components/status-badge';
import { useToast } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export { OutcomeBadge } from '@/components/status-badge';

const ANY = '';

/** `datetime-local` value (local time) ⇄ ISO. */
const toLocalInput = (iso: string | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : undefined);

/** A text filter that writes to the URL a moment after typing stops. */
function TextFilter({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  placeholder?: string;
  onChange: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value ?? '');
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value ?? ''), [value]);
  useEffect(() => {
    if (text === (value ?? '')) return;
    const timer = setTimeout(() => latest.current(text.trim() || undefined), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  return (
    <div>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Input
        id={id}
        className="h-8 w-full sm:w-44"
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}

function Filters({
  filters,
  onChange,
  tab,
}: {
  filters: CallFilters;
  onChange: (next: CallFilters) => void;
  tab: 'calls' | 'searches';
}) {
  const servers = useServers();
  const set = (patch: Partial<CallFilters>) => onChange({ ...filters, ...patch });
  const select = 'w-full sm:w-40';
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2.5" role="group" aria-label="Filters">
      <div>
        <Label htmlFor="log-range" className="sr-only">
          Time
        </Label>
        <NativeSelect
          id="log-range"
          controlSize="sm"
          wrapperClassName={select}
          value={filters.range}
          onChange={(event) => {
            const range = event.target.value as RangeKey;
            set(
              range === 'custom'
                ? { range, from: filters.from ?? new Date(Date.now() - 86_400_000).toISOString() }
                : { range, from: undefined, to: undefined },
            );
          }}
        >
          {RANGES.map((range) => (
            <option key={range.key} value={range.key}>
              {range.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {filters.range === 'custom' ? (
        <>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="log-from" className="text-muted-foreground text-xs">
              From
            </Label>
            <Input
              id="log-from"
              type="datetime-local"
              className="h-8 w-52"
              value={toLocalInput(filters.from)}
              onChange={(event) => set({ from: fromLocalInput(event.target.value) })}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="log-to" className="text-muted-foreground text-xs">
              To
            </Label>
            <Input
              id="log-to"
              type="datetime-local"
              className="h-8 w-52"
              value={toLocalInput(filters.to)}
              onChange={(event) => set({ to: fromLocalInput(event.target.value) })}
            />
          </div>
        </>
      ) : null}
      {tab === 'calls' ? (
        <div>
          <Label htmlFor="log-server" className="sr-only">
            Server
          </Label>
          <NativeSelect
            id="log-server"
            controlSize="sm"
            wrapperClassName={select}
            value={filters.server ?? ANY}
            onChange={(event) => set({ server: event.target.value || undefined })}
          >
            <option value={ANY}>All servers</option>
            {servers.data?.servers.map((server) => (
              <option key={server.name} value={server.name}>
                {server.name}
              </option>
            ))}
            {filters.server && !servers.data?.servers.some((server) => server.name === filters.server) ? (
              <option value={filters.server}>{filters.server}</option>
            ) : null}
          </NativeSelect>
        </div>
      ) : null}
      <TextFilter
        id="log-client"
        label="Client"
        value={filters.client}
        placeholder="Client"
        onChange={(client) => set({ client })}
      />
      {tab === 'calls' ? (
        <>
          <div>
            <Label htmlFor="log-outcome" className="sr-only">
              Outcome
            </Label>
            <NativeSelect
              id="log-outcome"
              controlSize="sm"
              wrapperClassName={select}
              value={filters.outcome ?? ANY}
              onChange={(event) =>
                set({ outcome: (event.target.value || undefined) as CallOutcomeName | undefined })
              }
            >
              <option value={ANY}>All outcomes</option>
              {CALL_OUTCOME_NAMES.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {OUTCOME_LABELS[outcome]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <TextFilter
            id="log-tool"
            label="Tool name contains"
            value={filters.tool}
            placeholder="Tool contains"
            onChange={(tool) => set({ tool })}
          />
        </>
      ) : (
        <div>
          <Label htmlFor="log-followup" className="sr-only">
            Follow-up
          </Label>
          <NativeSelect
            id="log-followup"
            controlSize="sm"
            wrapperClassName={select}
            value={filters.followup ?? ANY}
            onChange={(event) =>
              set({ followup: (event.target.value || undefined) as SearchFollowup | undefined })
            }
          >
            <option value={ANY}>All follow-ups</option>
            {SEARCH_FOLLOWUPS.map((followup) => (
              <option key={followup} value={followup}>
                {FOLLOWUP_LABELS[followup]}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </div>
  );
}

/** The sparkline range that fits the filter's range (none for a custom one). */
const sparkRange = (range: RangeKey) => (range === '7d' ? '7d' : range === 'custom' ? undefined : '24h');

function StatsStrip({ filters }: { filters: CallFilters }) {
  const stats = useCallStats(filters);
  const range = sparkRange(filters.range);
  const usage = useUsage({ range: range ?? '24h' }, range !== undefined);
  if (stats.error) return <ErrorMessage error={stats.error} title="Cannot load the stats" />;
  if (!stats.data) return <LoadingRows rows={1} label="Loading stats" />;
  const { calls } = stats.data;
  const series = usage.data?.series;
  return (
    <section aria-label="Stats" className="mb-4 space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Calls"
          value={String(calls.total)}
          chart={
            series ? (
              <Sparkline values={series.map((point) => point.calls)} label="Calls per bucket" />
            ) : undefined
          }
        />
        <KpiCard
          label="Error rate"
          value={formatRate(calls.errorRate)}
          valueClassName={calls.errors > 0 ? 'text-tone-bad-text' : undefined}
          chart={
            series ? (
              <Sparkline values={series.map((point) => point.errors)} label="Errors per bucket" tone="bad" />
            ) : undefined
          }
        />
        <KpiCard label="Median" value={formatMs(calls.p50Ms)} />
        <KpiCard label="95th percentile" value={formatMs(calls.p95Ms)} />
      </div>
      {calls.byServer.length > 0 ? (
        <ul
          className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs"
          aria-label="Calls per server"
        >
          {calls.byServer.map((server) => (
            <li key={server.server}>
              <span className="text-foreground font-medium">{server.server}</span> {server.calls}
              {server.errors > 0 ? ` (${server.errors} errors)` : ''} · p50 {formatMs(server.p50Ms)} · p95{' '}
              {formatMs(server.p95Ms)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Near the top of the page: new calls are shown as they arrive. */
function useAtTop(): boolean {
  const [atTop, setAtTop] = useState(() => window.scrollY < 64);
  useEffect(() => {
    const onScroll = () => setAtTop(window.scrollY < 64);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return atTop;
}

/** A call's tool: the server's tile and the short name (the full name for screen readers and search). */
export function ToolCell({ call }: { call: Pick<CallSummary, 'tool' | 'server'> }) {
  const servers = useServers();
  const short = splitFullToolName(call.tool)?.tool ?? call.tool;
  const icon = servers.data?.servers.find((server) => server.name === call.server)?.icon;
  return (
    <span className="flex min-w-0 items-center gap-2" title={call.tool}>
      {call.server ? <ServerTile name={call.server} icon={icon} size="sm" /> : null}
      <span className="sr-only">{call.tool}</span>
      <span aria-hidden="true" className="truncate font-mono text-xs">
        {short}
      </span>
    </span>
  );
}

function CallsTab({
  filters,
  selected,
  onSelect,
}: {
  filters: CallFilters;
  selected: number | undefined;
  onSelect: (id: number | undefined) => void;
}) {
  const calls = useCalls(filters);
  const events = useLiveEvents();
  const client = useQueryClient();
  const atTop = useAtTop();
  const [waiting, setWaiting] = useState<CallSummary[]>([]);
  const atTopRef = useRef(atTop);
  atTopRef.current = atTop;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const key = callLogKeys.calls(filters);
  const keyText = JSON.stringify(key);

  const prepend = (incoming: CallSummary[]) =>
    client.setQueryData<InfiniteData<CallListResponse, string | undefined>>(key, (old) => {
      if (!old || old.pages.length === 0) return old;
      const known = new Set(old.pages.flatMap((page) => page.calls.map((call) => call.id)));
      const fresh = incoming.filter((call) => !known.has(call.id)).sort((a, b) => b.id - a.id);
      const [first, ...rest] = old.pages;
      return { ...old, pages: [{ ...first!, calls: [...fresh, ...first!.calls] }, ...rest] };
    });

  const prependRef = useRef(prepend);
  prependRef.current = prepend;

  // New calls: shown at once at the top of the list, otherwise counted.
  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type !== 'call_recorded' || !matchesFilters(event.data, filtersRef.current)) return;
        if (atTopRef.current) prependRef.current([event.data]);
        else
          setWaiting((list) =>
            list.some((call) => call.id === event.data.id) ? list : [...list, event.data],
          );
      }),
    [events],
  );
  // Other filters: start counting again.
  useEffect(() => setWaiting([]), [keyText]);

  if (calls.isPending) return <LoadingRows label="Loading calls" />;
  if (calls.error) return <ErrorMessage error={calls.error} title="Cannot load the call log" />;
  const rows = calls.data.pages.flatMap((page) => page.calls);
  return (
    <div className="min-w-0 space-y-3">
      {waiting.length > 0 ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            prepend(waiting);
            setWaiting([]);
            window.scrollTo({ top: 0 });
          }}
        >
          {waiting.length === 1 ? 'Show 1 new call' : `Show ${waiting.length} new calls`}
        </Button>
      ) : null}
      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyLine
            action={
              <Link to="/tester" className="text-foreground underline">
                Open the Tester
              </Link>
            }
          >
            No calls match these filters
          </EmptyLine>
        ) : (
          <Table aria-label="Calls">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead className={selected !== undefined ? 'hidden 2xl:table-cell' : undefined}>
                  Client
                </TableHead>
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
                  <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                    <button
                      type="button"
                      className="hover:underline"
                      aria-label={`Details of call ${call.id} (${call.tool})`}
                      title={formatTime(call.at)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(call.id);
                      }}
                    >
                      {formatShortTime(call.at)}
                    </button>
                  </TableCell>
                  <TableCell
                    className={cn('text-xs', selected !== undefined && 'hidden 2xl:table-cell')}
                    title={clientLabel(call.client)}
                  >
                    <span className="block max-w-32 truncate">{clientLabel(call.client)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-48">
                      <ToolCell call={call} />
                    </span>
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
        )}
      </Panel>
      {calls.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={calls.isFetchingNextPage}
          onClick={() => void calls.fetchNextPage()}
        >
          {calls.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}

function SearchesTab({ filters }: { filters: CallFilters }) {
  const searches = useSearches(filters);
  const stats = useCallStats(filters);
  const totals = stats.data?.searches;
  return (
    <div className="space-y-4">
      <section aria-label="Search hit rate" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {totals ? (
          <>
            <Panel className="flex items-center gap-4 p-3.5">
              <Ring value={totals.hitRate} display={formatRate(totals.hitRate)} label="Hit rate" />
              <div>
                <div className="text-muted-foreground text-xs">Hit rate</div>
                <div className="text-faint text-xs">of {totals.total} searches</div>
              </div>
            </Panel>
            <KpiCard label="Hits" value={String(totals.hits)} valueClassName="text-tone-ok-text" />
            <KpiCard label="Misses" value={String(totals.misses)} valueClassName="text-tone-bad-text" />
            <KpiCard label="No follow-up" value={String(totals.none)} />
          </>
        ) : (
          <LoadingRows rows={1} label="Loading the hit rate" />
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <Panel className="overflow-hidden" aria-label="Searches">
            {searches.isPending ? <LoadingRows label="Loading searches" /> : null}
            {searches.error ? <ErrorMessage error={searches.error} title="Cannot load the searches" /> : null}
            {searches.data ? (
              searches.data.pages[0]!.searches.length === 0 ? (
                <EmptyLine>No searches match these filters.</EmptyLine>
              ) : (
                <Table aria-label="Search list">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Query</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="hidden text-right 2xl:table-cell">Rank</TableHead>
                      <TableHead>Called</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {searches.data.pages
                      .flatMap((page) => page.searches)
                      .map((search) => (
                        <TableRow key={search.id} data-search={search.id}>
                          <TableCell
                            className="text-muted-foreground font-mono text-xs whitespace-nowrap"
                            title={formatTime(search.at)}
                          >
                            {formatShortTime(search.at)}
                          </TableCell>
                          <TableCell className="text-xs" title={clientLabel(search.client)}>
                            <span className="block max-w-28 truncate">{clientLabel(search.client)}</span>
                          </TableCell>
                          <TableCell className="text-sm" title={search.query}>
                            <span className="block max-w-40 truncate">{search.query || '(empty)'}</span>
                          </TableCell>
                          <TableCell>
                            <FollowupBadge followup={search.followup} />
                          </TableCell>
                          <TableCell className="hidden text-right text-xs tabular-nums 2xl:table-cell">
                            {search.rank !== undefined ? `rank ${search.rank}` : '—'}
                          </TableCell>
                          <TableCell className="font-mono text-xs" title={search.calledTool}>
                            <span className="block max-w-32 truncate">{search.calledTool ?? '—'}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )
            ) : null}
          </Panel>
          {searches.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={searches.isFetchingNextPage}
              onClick={() => void searches.fetchNextPage()}
            >
              Load more
            </Button>
          ) : null}
        </div>

        <Panel aria-label="Recent misses">
          <PanelHeader
            title="Recent misses"
            info="A search is a hit when the same client's next call, within 5 minutes, is to a tool it returned; a miss when that call is to another tool. Hit rate = hits ÷ (hits + misses)."
          />
          {stats.data && stats.data.recentMisses.length === 0 ? (
            <p className="text-muted-foreground px-3.5 py-3 text-sm">No misses in this range.</p>
          ) : null}
          {stats.data && stats.data.recentMisses.length > 0 ? (
            <Table aria-label="Recent misses">
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  <TableHead>Called instead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.data.recentMisses.map((miss) => (
                  <TableRow key={miss.searchId}>
                    <TableCell className="max-w-40 whitespace-normal">
                      <div className="wrap-anywhere text-sm">“{miss.query}”</div>
                      <div className="text-faint wrap-anywhere text-xs" title={miss.results.join(', ')}>
                        returned {miss.results.join(', ') || '(nothing)'}
                      </div>
                    </TableCell>
                    <TableCell className="text-tone-bad-text wrap-anywhere font-mono text-xs whitespace-normal">
                      {miss.calledTool}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

function ClearLog() {
  const [open, setOpen] = useState(false);
  const totals = useAllTimeStats(open);
  const clear = useClearLog();
  const toast = useToast();
  const counts = totals.data
    ? `${totals.data.calls.total} ${totals.data.calls.total === 1 ? 'call' : 'calls'} and ${totals.data.searches.total} ${totals.data.searches.total === 1 ? 'search' : 'searches'}`
    : 'every recorded call and search';
  return (
    <>
      <Button
        type="button"
        variant="destructive-ghost"
        onClick={() => setOpen(true)}
        disabled={clear.isPending}
      >
        <Trash2Icon aria-hidden="true" />
        Clear log
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Clear the call log?"
        description={
          <>
            <p>
              This deletes {counts} from the call log, with any stored arguments and results, for every time
              range. It cannot be undone.
            </p>
            <p className="mt-2">Servers, tools, settings and the tool catalog are not affected.</p>
          </>
        }
        confirmLabel="Clear log"
        onConfirm={() =>
          clear.mutate(undefined, {
            onSuccess: (result) =>
              toast.notify(
                'success',
                'Call log cleared',
                `${result.deletedCalls} calls and ${result.deletedSearches} searches deleted.`,
              ),
            onError: (error) => toast.notify('error', 'Cannot clear the log', (error as Error).message),
          })
        }
      />
    </>
  );
}

export function CallLogPage() {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const tab = params.get('tab') === 'searches' ? 'searches' : 'calls';
  const selectedText = params.get('call');
  const selected = selectedText && /^\d+$/.test(selectedText) ? Number(selectedText) : undefined;
  const update = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    change(next);
    setParams(next);
  };
  return (
    <>
      <PageTitle
        title="Call log"
        info="Every tool call and search through MCPier, newest first. Errors show their readable message; the raw response is one click away."
        actions={<ClearLog />}
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          update((next) => {
            if (value === 'searches') next.set('tab', 'searches');
            else next.delete('tab');
            next.delete('call');
          })
        }
      >
        <TabsList className="mb-4">
          <TabsTrigger value="calls">Calls</TabsTrigger>
          <TabsTrigger value="searches">Search</TabsTrigger>
        </TabsList>
        <Filters filters={filters} tab={tab} onChange={(next) => setParams(withFilters(params, next))} />
        <TabsContent value="calls">
          <StatsStrip filters={filters} />
          <div
            className={cn(
              'grid grid-cols-1 gap-4',
              selected !== undefined ? 'xl:grid-cols-[minmax(0,1fr)_440px]' : '',
            )}
          >
            <CallsTab
              filters={filters}
              selected={selected}
              onSelect={(id) =>
                update((next) => (id === undefined ? next.delete('call') : next.set('call', String(id))))
              }
            />
            {selected !== undefined ? (
              <CallDetailPanel id={selected} onClose={() => update((next) => next.delete('call'))} />
            ) : null}
          </div>
        </TabsContent>
        <TabsContent value="searches">
          <SearchesTab filters={filters} />
        </TabsContent>
      </Tabs>
    </>
  );
}
