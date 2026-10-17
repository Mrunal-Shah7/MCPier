import { Link } from 'react-router';
import { PlusIcon } from 'lucide-react';
import { useServers } from '@/lib/queries';
import { EmptyState, ErrorMessage, formatDuration, LoadingRows, PageHeader } from '@/components/common';
import { ServerActionsMenu } from '@/components/server-actions-menu';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function ServersPage() {
  const servers = useServers();
  const addButton = (
    <Button asChild>
      <Link to="/servers/new">
        <PlusIcon aria-hidden="true" />
        Add server
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Servers"
        description="The MCP servers behind MCPier. Statuses update live."
        actions={addButton}
      />
      {servers.isPending ? (
        <LoadingRows label="Loading servers" />
      ) : servers.error ? (
        <ErrorMessage error={servers.error} title="Cannot load the servers" />
      ) : servers.data.servers.length === 0 ? (
        <EmptyState title="No servers yet" action={addButton}>
          Add one here, or from a terminal with{' '}
          <code className="font-mono">mcpier server add &lt;name&gt; -- &lt;command&gt;</code>.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Transport</TableHead>
                <TableHead className="hidden lg:table-cell">Protocol</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead className="hidden md:table-cell">Uptime</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.data.servers.map((server) => (
                <TableRow key={server.name} data-server={server.name}>
                  <TableCell className="max-w-64">
                    <Link
                      to={`/servers/${encodeURIComponent(server.name)}`}
                      className="font-medium hover:underline"
                    >
                      {server.name}
                    </Link>
                    {server.description ? (
                      <p className="text-muted-foreground truncate text-xs">{server.description}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <StatusBadge state={server.status.state} />
                    {!server.enabled ? (
                      <span className="text-muted-foreground ml-2 text-xs">disabled</span>
                    ) : null}
                    {server.status.detail && server.status.state !== 'ready' ? (
                      <p
                        className="text-muted-foreground mt-1 line-clamp-2 text-xs whitespace-normal"
                        title={server.status.detail}
                      >
                        {server.status.detail}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{server.transport}</TableCell>
                  <TableCell className="hidden font-mono text-xs lg:table-cell">
                    {server.protocolVersion ?? '—'}
                  </TableCell>
                  <TableCell>
                    {server.tools.enabled}/{server.tools.total}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {server.status.state === 'ready' ? formatDuration(server.uptimeSeconds) : '—'}
                  </TableCell>
                  <TableCell>
                    <ServerActionsMenu server={server} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
