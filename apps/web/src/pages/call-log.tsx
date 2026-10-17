import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ChevronDownIcon, PlayIcon, Trash2Icon, XIcon } from 'lucide-react';
import {
  CALL_OUTCOME_NAMES,
  SEARCH_FOLLOWUPS,
  splitFullToolName,
  type CallListResponse,
  type CallOutcomeName,
  type CallSummary,
  type SearchFollowup,
  type StoredBody,
} from '@mcpier/shared';
import {
  callLogKeys,
  filtersFromParams,
  FOLLOWUP_LABELS,
  formatMs,
  formatRate,
  matchesFilters,
  OUTCOME_LABELS,
  outcomeTone,
  prettyBody,
  RANGES,
  useAllTimeStats,
  useCallDetail,
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
import { cn } from '@/lib/utils';
import {
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorMessage,
  formatTime,
  LoadingRows,
  PageHeader,
} from '@/components/common';
import { useToast } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TONES = {
  ok: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
  info: 'bg-sky-100 text-sky-800 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-400/30',
  warn: 'bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/30',
  error: 'bg-red-100 text-red-800 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/30',
  muted:
    'bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/20',
} as const;

function Pill({
  tone,
  children,
  data,
}: {
  tone: keyof typeof TONES;
  children: string;
  data?: Record<string, string>;
}) {
  return (
    <span
      {...data}
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: CallOutcomeName }) {
  return (
    <Pill tone={outcomeTone(outcome)} data={{ 'data-outcome': outcome }}>
      {OUTCOME_LABELS[outcome]}
    </Pill>
  );
}

function FollowupBadge({ followup }: { followup: SearchFollowup }) {
  const tone = followup === 'hit' ? 'ok' : followup === 'miss' ? 'error' : 'muted';
  return (
    <Pill tone={tone} data={{ 'data-followup': followup }}>
      {FOLLOWUP_LABELS[followup]}
    </Pill>
  );
}

const ANY = '';

const clientLabel = (client: CallSummary['client']) =>
  client.name ? `${client.name}${client.version ? ` ${client.version}` : ''}` : '(unnamed client)';

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
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="w-full sm:w-44"
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
  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
      <div className="space-y-1.5">
        <Label htmlFor="log-range">Time</Label>
        <NativeSelect
          id="log-range"
          wrapperClassName="w-40"
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
          <div className="space-y-1.5">
            <Label htmlFor="log-from">From</Label>
            <Input
              id="log-from"
              type="datetime-local"
              className="w-52"
              value={toLocalInput(filters.from)}
              onChange={(event) => set({ from: fromLocalInput(event.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="log-to">To</Label>
            <Input
              id="log-to"
              type="datetime-local"
              className="w-52"
              value={toLocalInput(filters.to)}
              onChange={(event) => set({ to: fromLocalInput(event.target.value) })}
            />
          </div>
        </>
      ) : null}
      {tab === 'calls' ? (
        <div className="space-y-1.5">
          <Label htmlFor="log-server">Server</Label>
          <NativeSelect
            id="log-server"
            wrapperClassName="w-full sm:w-44"
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
        placeholder="client name"
        onChange={(client) => set({ client })}
      />
      {tab === 'calls' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="log-outcome">Outcome</Label>
            <NativeSelect
              id="log-outcome"
              wrapperClassName="w-full sm:w-44"
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
            placeholder="read_file"
            onChange={(tool) => set({ tool })}
          />
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="log-followup">Follow-up</Label>
          <NativeSelect
            id="log-followup"
            wrapperClassName="w-full sm:w-44"
            value={filters.followup ?? ANY}
            onChange={(event) =>
              set({ followup: (event.target.value || undefined) as SearchFollowup | undefined })
            }
          >
            <option value={ANY}>All</option>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function StatsStrip({ filters }: { filters: CallFilters }) {
  const stats = useCallStats(filters);
  if (stats.error) return <ErrorMessage error={stats.error} title="Cannot load the stats" />;
  if (!stats.data) return <LoadingRows rows={1} label="Loading stats" />;
  const { calls } = stats.data;
  return (
    <section aria-label="Stats" className="rounded-md border p-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        <Stat label="Calls" value={String(calls.total)} />
        <Stat label="Error rate" value={formatRate(calls.errorRate)} />
        <Stat label="Median" value={formatMs(calls.p50Ms)} />
        <Stat label="95th percentile" value={formatMs(calls.p95Ms)} />
      </dl>
      {calls.byServer.length > 0 ? (
        <ul
          className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
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

function toolHref(call: { tool: string; server?: string }): string | undefined {
  const parts = splitFullToolName(call.tool);
  if (!call.server || !parts) return undefined;
  return `/servers/${encodeURIComponent(call.server)}?tab=tools&tool=${encodeURIComponent(parts.tool)}`;
}

function Body({ title, body }: { title: string; body: StoredBody | undefined }) {
  const [open, setOpen] = useState(true);
  if (!body) {
    return (
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-sm">None.</p>
      </div>
    );
  }
  const text = prettyBody(body.text);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="px-1">
            <ChevronDownIcon
              aria-hidden="true"
              className={cn('transition-transform', open ? '' : '-rotate-90')}
            />
            {title}
          </Button>
        </CollapsibleTrigger>
        <CopyButton text={body.text} label={`Copy ${title.toLowerCase()}`} />
      </div>
      <CollapsibleContent>
        {body.truncated ? (
          <p className="text-muted-foreground mb-1 text-xs">Cut at 64 KB when it was stored.</p>
        ) : null}
        <pre
          aria-label={title}
          className="bg-muted max-h-96 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-all"
        >
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CallDetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useCallDetail(id);
  const navigate = useNavigate();
  const call = detail.data;
  let testerArguments: Record<string, unknown> | undefined;
  if (call?.arguments && !call.arguments.truncated) {
    try {
      const parsed: unknown = JSON.parse(call.arguments.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        testerArguments = parsed as Record<string, unknown>;
    } catch {
      testerArguments = undefined;
    }
  }
  const href = call ? toolHref(call) : undefined;
  return (
    <section aria-label="Call detail" className="space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold">Call {id}</h2>
        <Button type="button" variant="ghost" size="sm" aria-label="Close the call detail" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      {detail.isPending ? <LoadingRows rows={3} label="Loading the call" /> : null}
      {detail.error ? <ErrorMessage error={detail.error} title="Cannot load the call" /> : null}
      {call ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Time</dt>
            <dd>{formatTime(call.at)}</dd>
            <dt className="text-muted-foreground">Client</dt>
            <dd>
              {clientLabel(call.client)} <span className="text-muted-foreground">({call.era})</span>
            </dd>
            <dt className="text-muted-foreground">Tool</dt>
            <dd className="font-mono text-xs">
              {href ? (
                <Link to={href} className="hover:underline">
                  {call.tool}
                </Link>
              ) : (
                call.tool
              )}
            </dd>
            <dt className="text-muted-foreground">Server</dt>
            <dd>
              {call.server ? (
                <Link to={`/servers/${encodeURIComponent(call.server)}`} className="hover:underline">
                  {call.server}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt className="text-muted-foreground">Outcome</dt>
            <dd>
              <OutcomeBadge outcome={call.outcome} />
            </dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{formatMs(call.durationMs)}</dd>
            <dt className="text-muted-foreground">Trace id</dt>
            <dd className="font-mono text-xs break-all">{call.traceId ?? '—'}</dd>
            {call.errorText ? (
              <>
                <dt className="text-muted-foreground">Error</dt>
                <dd className="text-destructive text-sm break-words">{call.errorText}</dd>
              </>
            ) : null}
          </dl>
          {call.bodiesStored ? (
            <div className="space-y-3">
              <Body title="Arguments" body={call.arguments} />
              <Body title="Result" body={call.result} />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm" role="note">
              The arguments and result of this call were not stored: <strong>Store call bodies</strong> was
              off when it ran. Turn it on in{' '}
              <Link to="/settings" className="underline">
                Settings
              </Link>{' '}
              to keep them for new calls.
            </p>
          )}
          {testerArguments ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                navigate(`/tester?tool=${encodeURIComponent(call.tool)}`, {
                  state: { arguments: testerArguments },
                })
              }
            >
              <PlayIcon aria-hidden="true" />
              Open in Tester
            </Button>
          ) : null}
        </>
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
    <div className="space-y-3">
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
      {rows.length === 0 ? (
        <EmptyState title="No calls match these filters">
          Calls appear here as clients use MCPier's tools. Try a longer time range, or run a tool from the{' '}
          <Link to="/tester" className="underline">
            Tester
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table aria-label="Calls">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead className="hidden md:table-cell">Server</TableHead>
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
                >
                  <TableCell className="text-xs whitespace-nowrap">
                    <button
                      type="button"
                      className="hover:underline"
                      aria-label={`Details of call ${call.id} (${call.tool})`}
                      onClick={() => onSelect(call.id)}
                    >
                      {formatTime(call.at)}
                    </button>
                  </TableCell>
                  <TableCell className="text-xs">{clientLabel(call.client)}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs">{call.tool}</TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{call.server ?? '—'}</TableCell>
                  <TableCell>
                    <OutcomeBadge outcome={call.outcome} />
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {formatMs(call.durationMs)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
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
    <div className="space-y-6">
      <section aria-label="Search hit rate" className="rounded-md border p-3">
        {totals ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <Stat label="Hit rate" value={formatRate(totals.hitRate)} />
            <Stat label="Searches" value={String(totals.total)} />
            <Stat label="Hits" value={String(totals.hits)} />
            <Stat label="Misses" value={String(totals.misses)} />
            <Stat label="No follow-up" value={String(totals.none)} />
          </dl>
        ) : (
          <LoadingRows rows={1} label="Loading the hit rate" />
        )}
        <p className="text-muted-foreground mt-2 text-xs">
          A search is a hit when the same client's next call, within 5 minutes, is to a tool it returned; a
          miss when that call is to another tool. Hit rate = hits ÷ (hits + misses).
        </p>
      </section>

      <section aria-label="Recent misses" className="space-y-2">
        <h2 className="text-sm font-semibold">Recent misses</h2>
        {stats.data && stats.data.recentMisses.length === 0 ? (
          <p className="text-muted-foreground text-sm">No misses in this range.</p>
        ) : null}
        {stats.data && stats.data.recentMisses.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <Table aria-label="Recent misses">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Query</TableHead>
                  <TableHead>Search returned</TableHead>
                  <TableHead>Called instead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.data.recentMisses.map((miss) => (
                  <TableRow key={miss.searchId}>
                    <TableCell className="text-xs whitespace-nowrap">{formatTime(miss.at)}</TableCell>
                    <TableCell className="text-sm">{miss.query}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {miss.results.join(', ') || '(nothing)'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{miss.calledTool}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      <section aria-label="Searches" className="space-y-2">
        <h2 className="text-sm font-semibold">Searches</h2>
        {searches.isPending ? <LoadingRows label="Loading searches" /> : null}
        {searches.error ? <ErrorMessage error={searches.error} title="Cannot load the searches" /> : null}
        {searches.data ? (
          searches.data.pages[0]!.searches.length === 0 ? (
            <EmptyState title="No searches match these filters" />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table aria-label="Search list">
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Query</TableHead>
                    <TableHead className="text-right">Results</TableHead>
                    <TableHead>Follow-up</TableHead>
                    <TableHead>Called</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {searches.data.pages
                    .flatMap((page) => page.searches)
                    .map((search) => (
                      <TableRow key={search.id} data-search={search.id}>
                        <TableCell className="text-xs whitespace-nowrap">{formatTime(search.at)}</TableCell>
                        <TableCell className="text-xs">{clientLabel(search.client)}</TableCell>
                        <TableCell className="text-sm">{search.query || '(empty)'}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {search.resultCount}
                        </TableCell>
                        <TableCell>
                          <FollowupBadge followup={search.followup} />
                          {search.rank !== undefined ? (
                            <span className="text-muted-foreground ml-1 text-xs">rank {search.rank}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{search.calledTool ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )
        ) : null}
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
      </section>
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
      <Button type="button" variant="outline" onClick={() => setOpen(true)} disabled={clear.isPending}>
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
      <PageHeader
        title="Call log"
        description="Every tool call and search through MCPier, newest first."
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
        <TabsList>
          <TabsTrigger value="calls">Calls</TabsTrigger>
          <TabsTrigger value="searches">Search</TabsTrigger>
        </TabsList>
        <div className="mt-4 space-y-4">
          <Filters filters={filters} tab={tab} onChange={(next) => setParams(withFilters(params, next))} />
          <TabsContent value="calls" className="space-y-4">
            <StatsStrip filters={filters} />
            <div
              className={cn(
                'grid grid-cols-[minmax(0,1fr)] gap-4',
                selected !== undefined ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]' : '',
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
        </div>
      </Tabs>
    </>
  );
}
