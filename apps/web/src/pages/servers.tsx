import { Link, useSearchParams } from 'react-router';
import { PlusIcon } from 'lucide-react';
import { splitFullToolName, type ServerSummary } from '@mcpier/shared';
import { useServers } from '@/lib/queries';
import { useSignIn } from '@/lib/oauth';
import { useServerAction } from '@/lib/server-actions';
import { STATUS_TONE, TONE_EDGE } from '@/lib/palette';
import { formatDurationMs, formatTokens, useRecentCalls, useUsage } from '@/lib/usage';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorMessage, formatDuration, LoadingRows } from '@/components/common';
import { Sparkline } from '@/components/charts';
import {
  EmptyLine,
  PageTitle,
  Panel,
  PanelHeader,
  PanelBody,
  RailGrid,
  Segmented,
  Stack,
} from '@/components/kit';
import { ServerActionsMenu } from '@/components/server-actions-menu';
import { ServerTile } from '@/components/server-tile';
import { OutcomeBadge, StatusBadge, TransportChip } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Filter = 'all' | 'ready' | 'attention';

/** A server the user should look at: signed out, failing, or enabled but stopped. */
export function needsAttention(server: ServerSummary): boolean {
  const state = server.status.state;
  return (
    state === 'needs_auth' ||
    state === 'error' ||
    state === 'crashed' ||
    (server.enabled && state === 'stopped')
  );
}

const readable = (server: ServerSummary) => server.status.detailMessage ?? server.status.detail;

function AttentionRow({ server }: { server: ServerSummary }) {
  const signIn = useSignIn(server.name, undefined);
  const action = useServerAction();
  const state = server.status.state;
  const button =
    state === 'needs_auth' ? (
      <Button size="xs" onClick={signIn.begin}>
        Sign in
      </Button>
    ) : state === 'stopped' ? (
      <Button
        size="xs"
        variant="outline"
        onClick={() => action.mutate({ name: server.name, action: 'start' })}
      >
        Start
      </Button>
    ) : (
      <Button
        size="xs"
        variant="outline"
        onClick={() => action.mutate({ name: server.name, action: 'restart' })}
      >
        Restart
      </Button>
    );
  return (
    <li className="flex items-center gap-2.5 border-b px-3.5 py-2.5 last:border-b-0">
      <ServerTile name={server.name} icon={server.icon} size="sm" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/servers/${encodeURIComponent(server.name)}`}
          className="block truncate font-semibold hover:underline"
        >
          {server.name}
        </Link>
        <div className="text-faint truncate text-xs" title={readable(server)}>
          {readable(server) ?? (state === 'stopped' ? 'Stopped' : state)}
        </div>
      </div>
      {button}
    </li>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-faint text-xs">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', className)}>{value}</div>
    </div>
  );
}

function Rail({ servers }: { servers: ServerSummary[] }) {
  const attention = servers.filter(needsAttention);
  const day = useUsage({ range: '24h' });
  const recent = useRecentCalls();
  const byName = new Map(servers.map((server) => [server.name, server]));
  return (
    <Stack>
      <Panel aria-labelledby="attention-title">
        <PanelHeader id="attention-title" title="Needs attention" />
        {attention.length === 0 ? (
          <p className="text-muted-foreground px-3.5 py-3 text-sm">Nothing needs attention.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {attention.map((server) => (
              <AttentionRow key={server.name} server={server} />
            ))}
          </ul>
        )}
      </Panel>
      <Panel aria-labelledby="day-title">
        <PanelHeader
          id="day-title"
          title="Last 24 h"
          actions={
            <Link to="/usage" className="text-faint text-xs hover:underline">
              Usage →
            </Link>
          }
        />
        <PanelBody className="grid grid-cols-2 gap-3">
          <Stat label="Calls" value={day.data ? day.data.totals.calls.toLocaleString() : '—'} />
          <Stat
            label="Errors"
            value={day.data ? day.data.totals.errors.toLocaleString() : '—'}
            className={day.data && day.data.totals.errors > 0 ? 'text-tone-bad-text' : undefined}
          />
          <Stat label="Median" value={formatDurationMs(day.data?.totals.p50Ms)} />
          <Stat label="Est. tokens" value={formatTokens(day.data?.totals.tokens)} />
        </PanelBody>
      </Panel>
      <Panel aria-labelledby="recent-title">
        <PanelHeader
          id="recent-title"
          title="Recent calls"
          actions={
            <Link to="/calls" className="text-faint text-xs hover:underline">
              All →
            </Link>
          }
        />
        {recent.data && recent.data.calls.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {recent.data.calls.map((call) => (
              <li key={call.id} className="flex items-center gap-2.5 border-b px-3.5 py-2 last:border-b-0">
                {call.server ? (
                  <ServerTile name={call.server} icon={byName.get(call.server)?.icon} size="sm" />
                ) : null}
                <Link to={`/calls?call=${call.id}`} className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">
                    {splitFullToolName(call.tool)?.tool ?? call.tool}
                  </div>
                  <div className="text-faint truncate text-xs">
                    {call.client.name ?? 'unknown client'} · {new Date(call.at).toLocaleTimeString()}
                  </div>
                </Link>
                <OutcomeBadge outcome={call.outcome} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground px-3.5 py-3 text-sm">No calls yet.</p>
        )}
      </Panel>
    </Stack>
  );
}

export function ServersPage() {
  const servers = useServers();
  const [search, setSearch] = useSearchParams();
  const filter: Filter =
    (['ready', 'attention'] as const).find((value) => value === search.get('filter')) ?? 'all';
  const week = useUsage({ range: '7d' });
  const addButton = (
    <Button asChild>
      <Link to="/servers/new">
        <PlusIcon aria-hidden="true" />
        Add server
      </Link>
    </Button>
  );
  const all = servers.data?.servers ?? [];
  const shown = all.filter((server) =>
    filter === 'ready'
      ? server.status.state === 'ready'
      : filter === 'attention'
        ? needsAttention(server)
        : true,
  );
  const weekly = new Map(week.data?.byServer.map((row) => [row.server, row.series]));

  return (
    <>
      <PageTitle
        title="Servers"
        info="The MCP servers behind MCPier. Statuses update live."
        actions={
          <>
            <Segmented<Filter>
              label="Show"
              value={filter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'ready', label: 'Ready' },
                { value: 'attention', label: 'Attention' },
              ]}
              onChange={(value) => setSearch(value === 'all' ? {} : { filter: value }, { replace: true })}
            />
            {addButton}
          </>
        }
      />
      {servers.isPending ? (
        <LoadingRows label="Loading servers" />
      ) : servers.error ? (
        <ErrorMessage error={servers.error} title="Cannot load the servers" />
      ) : all.length === 0 ? (
        <EmptyState title="No servers yet" action={addButton}>
          Add an MCP server here, or in a terminal with <code className="font-mono">mcpier server add</code>{' '}
          or <code className="font-mono">mcpier server import</code>.
        </EmptyState>
      ) : (
        <RailGrid>
          <Panel className="self-start overflow-hidden">
            {shown.length === 0 ? (
              <EmptyLine>No servers match this filter.</EmptyLine>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Server</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden 2xl:table-cell">Transport</TableHead>
                    <TableHead className="hidden 2xl:table-cell">Protocol</TableHead>
                    <TableHead className="text-right">Tools</TableHead>
                    <TableHead className="hidden lg:table-cell">Calls · 7d</TableHead>
                    <TableHead className="hidden 2xl:table-cell">Uptime</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((server) => (
                    <TableRow
                      key={server.name}
                      data-server={server.name}
                      className={TONE_EDGE[server.enabled ? STATUS_TONE[server.status.state] : 'off']}
                    >
                      <TableCell className="max-w-72">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ServerTile name={server.name} icon={server.icon} />
                          <span className="min-w-0">
                            <Link
                              to={`/servers/${encodeURIComponent(server.name)}`}
                              className="block font-semibold hover:underline"
                            >
                              {server.name}
                            </Link>
                            {server.description ? (
                              <span className="text-faint block truncate text-xs" title={server.description}>
                                {server.description}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <StatusBadge state={server.status.state} />
                          {!server.enabled ? <span className="text-faint text-xs">disabled</span> : null}
                        </div>
                        {server.status.state !== 'ready' && readable(server) ? (
                          <p className="text-faint mt-1 max-w-40 truncate text-xs" title={readable(server)}>
                            {readable(server)}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden 2xl:table-cell">
                        <TransportChip transport={server.transport} />
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden font-mono text-xs 2xl:table-cell">
                        {server.protocolVersion ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {server.tools.enabled}
                        <span className="text-faint">/{server.tools.total}</span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Sparkline
                          values={weekly.get(server.name) ?? []}
                          label={`${server.name} calls per day, last 7 days`}
                          tone={server.status.state === 'ready' ? 'ok' : 'warn'}
                          width={72}
                          height={22}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden tabular-nums 2xl:table-cell">
                        {server.status.state === 'ready' ? formatDuration(server.uptimeSeconds) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <ServerActionsMenu server={server} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
          <Rail servers={all} />
        </RailGrid>
      )}
    </>
  );
}
