import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangleIcon, SearchIcon } from 'lucide-react';
import {
  API_PATHS,
  CALL_LOG_PATHS,
  type CallStatsResponse,
  type ToolInfo,
  type ToolSearchResponse,
} from '@mcpier/shared';
import { api } from '@/lib/api';
import { formatRate } from '@/lib/call-log';
import { useServers, useTools } from '@/lib/queries';
import { useToolToggle } from '@/lib/tool-toggle';
import { useUsage } from '@/lib/usage';
import { EmptyState, ErrorMessage, LoadingRows } from '@/components/common';
import { Sparkline } from '@/components/charts';
import { EmptyLine, PageTitle, Panel, PanelBody, PanelHeader, RailGrid, Segmented } from '@/components/kit';
import { ServerTile } from '@/components/server-tile';
import { StatusBadge, ToneBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const ALL = '__all';

function ServerFilter({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  const servers = useServers();
  return (
    <NativeSelect
      id={id}
      wrapperClassName="w-full sm:w-44"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value={ALL}>All servers</option>
      {servers.data?.servers.map((server) => (
        <option key={server.name} value={server.name}>
          {server.name}
        </option>
      ))}
    </NativeSelect>
  );
}

const toolLink = (server: string, tool: string) =>
  `/servers/${encodeURIComponent(server)}?tab=tools&tool=${encodeURIComponent(tool)}`;

function Hints({ tool }: { tool: Pick<ToolInfo, 'readOnlyHint' | 'destructiveHint'> }) {
  if (!tool.readOnlyHint && !tool.destructiveHint) return <span className="text-faint">—</span>;
  return (
    <span className="flex gap-1.5">
      {tool.readOnlyHint ? (
        <ToneBadge tone="info" dot={false}>
          read-only
        </ToneBadge>
      ) : null}
      {tool.destructiveHint ? (
        <ToneBadge tone="bad" dot={false}>
          destructive
        </ToneBadge>
      ) : null}
    </span>
  );
}

/** The search hit rate over 7 days, as a share bar. */
function HitRate() {
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const stats = useQuery({
    queryKey: ['call-stats', 'tools-hit-rate'],
    queryFn: () => api.get<CallStatsResponse>(`${CALL_LOG_PATHS.stats}?from=${encodeURIComponent(from)}`),
  });
  const rate = stats.data?.searches.hitRate ?? null;
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span>Hit rate · 7 d</span>
        <span className="text-tone-ok-text ml-auto text-base font-bold">{formatRate(rate)}</span>
      </div>
      <svg
        aria-hidden="true"
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        className="mt-2 block h-2 w-full"
      >
        <rect x={0} y={0} width={100} height={8} rx={4} className="fill-panel-3" />
        {rate ? (
          <rect x={0} y={0} width={Math.max(rate * 100, 1)} height={8} rx={4} className="fill-tone-ok" />
        ) : null}
      </svg>
    </div>
  );
}

/** Exactly what the meta-tool search_tools returns for the same query, limit and server. */
function Search() {
  const servers = useServers();
  const [text, setText] = useState('');
  const [limit, setLimit] = useState('5');
  const [server, setServer] = useState(ALL);
  const [submitted, setSubmitted] = useState<{ q: string; limit: string; server: string } | undefined>();
  const search = useQuery({
    queryKey: ['search', submitted],
    enabled: submitted !== undefined,
    queryFn: () => {
      const params = new URLSearchParams({ q: submitted!.q, limit: submitted!.limit });
      if (submitted!.server !== ALL) params.set('server', submitted!.server);
      return api.get<ToolSearchResponse>(`${API_PATHS.toolSearch}?${params}`);
    },
  });
  const iconOf = (name: string) => servers.data?.servers.find((item) => item.name === name)?.icon;

  return (
    <RailGrid>
      <div className="min-w-0 space-y-4">
        <form
          className="flex flex-wrap items-center gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted({ q: text, limit, server });
          }}
        >
          <div className="bg-panel-2 border-input focus-within:border-ring focus-within:ring-ring/50 flex h-10 min-w-48 flex-1 items-center gap-2 rounded-md border px-3 focus-within:ring-[3px]">
            <SearchIcon aria-hidden="true" className="text-muted-foreground size-4" />
            <Label htmlFor="tool-search" className="sr-only">
              What do you want to do?
            </Label>
            <input
              id="tool-search"
              type="search"
              placeholder="What do you want to do?"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <Label htmlFor="tool-search-server" className="sr-only">
            Server
          </Label>
          <ServerFilter id="tool-search-server" value={server} onChange={setServer} />
          <Label htmlFor="tool-search-limit" className="sr-only">
            Limit
          </Label>
          <NativeSelect
            id="tool-search-limit"
            wrapperClassName="w-20"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          >
            {[1, 3, 5, 10, 20].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit">Search</Button>
        </form>
        {search.isFetching && !search.data ? <LoadingRows label="Searching" /> : null}
        {search.error ? <ErrorMessage error={search.error} title="Search failed" /> : null}
        {search.data ? (
          <Panel>
            {search.data.results.length === 0 ? (
              <EmptyLine>No tools match "{search.data.query}".</EmptyLine>
            ) : (
              <ol className="m-0 list-none p-0" aria-label="Search results">
                {search.data.results.map((match, index) => {
                  const toolName = match.name.slice(match.server.length + 2);
                  return (
                    <li
                      key={match.name}
                      className="flex items-center gap-2.5 border-b px-3.5 py-2.5 last:border-b-0"
                    >
                      <span className="text-faint w-5 shrink-0 text-right tabular-nums">{index + 1}</span>
                      <ServerTile name={match.server} icon={iconOf(match.server)} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link
                          to={toolLink(match.server, toolName)}
                          className="font-mono text-[13px] hover:underline"
                        >
                          {match.name}
                        </Link>
                        {match.description ? (
                          <p className="text-faint m-0 truncate text-xs" title={match.description}>
                            {match.description}
                          </p>
                        ) : null}
                      </div>
                      <Hints tool={match} />
                      {match.available ? (
                        <span className="sr-only">available</span>
                      ) : (
                        <>
                          <span className="sr-only">unavailable:</span>
                          {match.serverStatus ? <StatusBadge state={match.serverStatus} /> : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>
        ) : null}
      </div>
      <Panel aria-label="How the model sees it">
        <PanelHeader title="How the model sees it" />
        <PanelBody className="text-muted-foreground space-y-3 text-sm">
          <p className="m-0 flex gap-2">
            <SearchIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <b className="text-foreground font-mono">search_tools</b> returns this exact ranking.
            </span>
          </p>
          <p className="m-0 flex gap-2">
            <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Unavailable tools rank last, with the reason.
          </p>
          <div className="border-t pt-3">
            <HitRate />
          </div>
        </PanelBody>
      </Panel>
    </RailGrid>
  );
}

function ToolToggle({ fullName, enabled }: { fullName: string; enabled: boolean }) {
  const toggle = useToolToggle();
  return (
    <Switch
      aria-label={`${enabled ? 'Disable' : 'Enable'} ${fullName}`}
      checked={enabled}
      disabled={toggle.isPending}
      onCheckedChange={(enable) => toggle.mutate({ fullName, enable })}
    />
  );
}

function Catalog() {
  const tools = useTools();
  const servers = useServers();
  const week = useUsage({ range: '7d', allTools: true });
  const [server, setServer] = useState(ALL);
  const [enabled, setEnabled] = useState<'all' | 'true' | 'false'>('all');
  const [available, setAvailable] = useState<'all' | 'true' | 'false'>('all');
  const [name, setName] = useState('');
  if (tools.isPending) return <LoadingRows label="Loading tools" />;
  if (tools.error) return <ErrorMessage error={tools.error} title="Cannot load the tools" />;
  const query = name.trim().toLowerCase();
  const shown = tools.data.tools.filter(
    (tool) =>
      (server === ALL || tool.server === server) &&
      (enabled === 'all' || String(tool.enabled) === enabled) &&
      (available === 'all' || String(tool.available) === available) &&
      (!query || tool.fullName.toLowerCase().includes(query)),
  );
  const calls = new Map(week.data?.heaviestTools.map((row) => [row.tool, row.callSeries]));
  const summaries = new Map(servers.data?.servers.map((item) => [item.name, item]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Label htmlFor="catalog-server" className="sr-only">
          Server
        </Label>
        <ServerFilter id="catalog-server" value={server} onChange={setServer} />
        <Segmented
          label="Enabled"
          value={enabled}
          options={[
            { value: 'all', label: 'All' },
            { value: 'true', label: 'Enabled' },
            { value: 'false', label: 'Disabled' },
          ]}
          onChange={setEnabled}
        />
        <Segmented
          label="Available"
          value={available}
          options={[
            { value: 'all', label: 'Any' },
            { value: 'true', label: 'Available' },
            { value: 'false', label: 'Unavailable' },
          ]}
          onChange={setAvailable}
        />
        <span className="flex-1" />
        <Label htmlFor="catalog-name" className="sr-only">
          Filter by name
        </Label>
        <Input
          id="catalog-name"
          className="h-8 w-full sm:w-56"
          placeholder="Filter by name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {tools.data.tools.length === 0 ? (
        <EmptyState title="No tools yet">They appear once a server is ready.</EmptyState>
      ) : (
        <Panel className="overflow-hidden">
          {shown.length === 0 ? (
            <EmptyLine>No tools match these filters.</EmptyLine>
          ) : (
            <Table aria-label="Catalog">
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead className="hidden md:table-cell">Server</TableHead>
                  <TableHead className="hidden lg:table-cell">Hints</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Calls · 7d</TableHead>
                  <TableHead className="text-right">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((tool) => {
                  const status = summaries.get(tool.server)?.status.state;
                  return (
                    <TableRow key={tool.fullName} data-tool={tool.fullName}>
                      <TableCell className="max-w-72">
                        <Link
                          to={toolLink(tool.server, tool.name)}
                          className="block truncate font-mono text-xs hover:underline"
                        >
                          <span className="sr-only">{tool.fullName}</span>
                          <span aria-hidden="true">{tool.name}</span>
                        </Link>
                        {tool.description ? (
                          <span
                            className="text-faint block max-w-72 truncate text-xs"
                            title={tool.description}
                          >
                            {tool.description}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="flex items-center gap-2">
                          <ServerTile name={tool.server} icon={summaries.get(tool.server)?.icon} size="sm" />
                          {tool.server}
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Hints tool={tool} />
                      </TableCell>
                      <TableCell>
                        {tool.available ? (
                          <ToneBadge tone="ok">Available</ToneBadge>
                        ) : status ? (
                          <StatusBadge state={status} />
                        ) : (
                          <ToneBadge tone="off">Unavailable</ToneBadge>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex justify-end">
                          <Sparkline
                            values={calls.get(tool.fullName) ?? []}
                            label={`${tool.fullName} calls per day`}
                            width={60}
                            height={18}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <ToolToggle fullName={tool.fullName} enabled={tool.enabled} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}
    </div>
  );
}

export function ToolsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'catalog' ? 'catalog' : 'search';
  const tools = useTools();
  const servers = useServers();
  return (
    <>
      <PageTitle
        title="Tools"
        info="Every tool behind MCPier, and the search clients use to find them."
        actions={
          tools.data ? (
            <span className="text-faint text-xs">
              {tools.data.tools.length} tools · {servers.data?.servers.length ?? 0} servers
            </span>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => setParams(value === 'search' ? {} : { tab: value }, { replace: true })}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
        </TabsList>
        <TabsContent value="search">
          <Search />
        </TabsContent>
        <TabsContent value="catalog">
          <Catalog />
        </TabsContent>
      </Tabs>
    </>
  );
}
