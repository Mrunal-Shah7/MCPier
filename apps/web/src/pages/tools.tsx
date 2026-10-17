import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { API_PATHS, type ToolSearchResponse } from '@mcpier/shared';
import { api } from '@/lib/api';
import { useServers, useTools } from '@/lib/queries';
import { useToolToggle } from '@/lib/tool-toggle';
import { EmptyState, ErrorMessage, LoadingRows, PageHeader } from '@/components/common';
import { StatusBadge } from '@/components/status-badge';
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
      wrapperClassName="w-full sm:w-48"
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

/** Exactly what the meta-tool search_tools returns for the same query, limit and server. */
function Search() {
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

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted({ q: text, limit, server });
        }}
      >
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="tool-search">What do you want to do?</Label>
          <Input
            id="tool-search"
            type="search"
            placeholder="read file"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tool-search-limit">Limit</Label>
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tool-search-server">Server</Label>
          <ServerFilter id="tool-search-server" value={server} onChange={setServer} />
        </div>
        <Button type="submit">Search</Button>
      </form>
      {search.isFetching && !search.data ? <LoadingRows label="Searching" /> : null}
      {search.error ? <ErrorMessage error={search.error} title="Search failed" /> : null}
      {search.data ? (
        search.data.results.length === 0 ? (
          <EmptyState title={`No tools match "${search.data.query}"`}>
            Try other words, or look through the catalog.
          </EmptyState>
        ) : (
          <ol className="space-y-2" aria-label="Search results">
            {search.data.results.map((match, index) => {
              const [serverName, toolName] = [match.server, match.name.slice(match.server.length + 2)];
              return (
                <li key={match.name} className="flex gap-3 rounded-md border p-3">
                  <span className="text-muted-foreground w-6 shrink-0 text-right text-sm">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={toolLink(serverName, toolName)}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {match.name}
                      </Link>
                      {match.available ? (
                        <span className="text-xs text-emerald-700 dark:text-emerald-400">available</span>
                      ) : (
                        <>
                          <span className="text-muted-foreground text-xs">unavailable:</span>
                          {match.serverStatus ? <StatusBadge state={match.serverStatus} /> : null}
                        </>
                      )}
                    </div>
                    {match.description ? (
                      <p className="text-muted-foreground mt-1 text-sm">{match.description}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )
      ) : null}
    </div>
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
  const [server, setServer] = useState(ALL);
  const [enabled, setEnabled] = useState(ALL);
  const [available, setAvailable] = useState(ALL);
  if (tools.isPending) return <LoadingRows label="Loading tools" />;
  if (tools.error) return <ErrorMessage error={tools.error} title="Cannot load the tools" />;
  const shown = tools.data.tools.filter(
    (tool) =>
      (server === ALL || tool.server === server) &&
      (enabled === ALL || String(tool.enabled) === enabled) &&
      (available === ALL || String(tool.available) === available),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="catalog-server">Server</Label>
          <ServerFilter id="catalog-server" value={server} onChange={setServer} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="catalog-enabled">Enabled</Label>
          <NativeSelect
            id="catalog-enabled"
            wrapperClassName="w-36"
            value={enabled}
            onChange={(event) => setEnabled(event.target.value)}
          >
            <option value={ALL}>All</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="catalog-available">Available</Label>
          <NativeSelect
            id="catalog-available"
            wrapperClassName="w-36"
            value={available}
            onChange={(event) => setAvailable(event.target.value)}
          >
            <option value={ALL}>All</option>
            <option value="true">Available</option>
            <option value="false">Unavailable</option>
          </NativeSelect>
        </div>
      </div>
      {tools.data.tools.length === 0 ? (
        <EmptyState title="No tools yet">Tools appear once a server is ready. Add a server first.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="No tools match these filters" />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead>Available</TableHead>
                <TableHead>Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((tool) => (
                <TableRow key={tool.fullName} data-tool={tool.fullName}>
                  <TableCell>
                    <Link
                      to={toolLink(tool.server, tool.name)}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {tool.fullName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-md truncate text-xs md:table-cell">
                    {tool.description}
                  </TableCell>
                  <TableCell className="text-xs">{tool.available ? 'yes' : 'no'}</TableCell>
                  <TableCell>
                    <ToolToggle fullName={tool.fullName} enabled={tool.enabled} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function ToolsPage() {
  return (
    <>
      <PageHeader
        title="Tools"
        description="Every tool behind MCPier, and the search clients use to find them."
      />
      <Tabs defaultValue="search">
        <TabsList>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
        </TabsList>
        <TabsContent value="search" className="mt-4">
          <Search />
        </TabsContent>
        <TabsContent value="catalog" className="mt-4">
          <Catalog />
        </TabsContent>
      </Tabs>
    </>
  );
}
