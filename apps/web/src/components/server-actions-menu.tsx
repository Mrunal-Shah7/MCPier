import { useState } from 'react';
import type { ServerSummary } from '@mcpier/shared';
import { EllipsisIcon } from 'lucide-react';
import { useSignIn } from '@/lib/oauth';
import { useDeleteServer, useServerAction } from '@/lib/server-actions';
import { ConfirmDialog } from '@/components/common';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Enable/disable, start, stop, restart (and refresh), and delete with confirmation. */
export function ServerActionsMenu({
  server,
  withRefresh = false,
  onDeleted,
}: {
  server: ServerSummary;
  withRefresh?: boolean;
  onDeleted?: (name: string) => void;
}) {
  const action = useServerAction();
  const remove = useDeleteServer(onDeleted);
  // Only OAuth servers are ever needs_auth. The status follows by event, so no waiting here.
  const signIn = useSignIn(server.name, undefined);
  const [confirming, setConfirming] = useState(false);
  const run = (kind: Parameters<typeof action.mutate>[0]['action']) =>
    action.mutate({ name: server.name, action: kind });
  const running = server.status.state !== 'stopped';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${server.name}`}
            disabled={action.isPending}
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {server.status.state === 'needs_auth' ? (
            <>
              <DropdownMenuItem onSelect={signIn.begin}>Sign in…</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {server.enabled ? (
            <>
              <DropdownMenuItem onSelect={() => run(running ? 'restart' : 'start')}>
                {running ? 'Restart' : 'Start'}
              </DropdownMenuItem>
              {running ? <DropdownMenuItem onSelect={() => run('stop')}>Stop</DropdownMenuItem> : null}
              {withRefresh ? (
                <DropdownMenuItem onSelect={() => run('refresh')}>Refresh tools</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => run('disable')}>Disable</DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => run('enable')}>Enable</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${server.name}?`}
        description={
          <p>
            This removes <strong>{server.name}</strong> from MCPier and stops it. Its secrets stay in
            Credential Manager.
          </p>
        }
        confirmLabel={`Delete ${server.name}`}
        onConfirm={() => remove.mutate(server.name)}
      />
    </>
  );
}
