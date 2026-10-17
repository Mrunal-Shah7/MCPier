import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  API_PATHS,
  type ServerAction,
  type ServerListResponse,
  type ServerRemovedResponse,
  type ServerResponse,
} from '@mcpier/shared';
import { api, describeError } from './api';
import { queryKeys } from './queries';
import { useToast } from '@/components/toaster';

const PAST: Record<ServerAction, string> = {
  start: 'Starting',
  stop: 'Stopped',
  restart: 'Restarting',
  enable: 'Enabled',
  disable: 'Disabled',
  refresh: 'Refreshed the tools of',
};

/** Server actions with a toast for the result; start, restart and enable show `starting` at once. */
export function useServerAction() {
  const client = useQueryClient();
  const { notify } = useToast();
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: ServerAction }) =>
      api.post<ServerResponse>(API_PATHS.serverAction(name, action)),
    onMutate: ({ name, action }) => {
      if (action === 'start' || action === 'restart' || action === 'enable') {
        client.setQueryData<ServerListResponse>(queryKeys.servers, (old) =>
          old
            ? {
                servers: old.servers.map((server) =>
                  server.name === name
                    ? { ...server, status: { state: 'starting', since: new Date().toISOString() } }
                    : server,
                ),
              }
            : old,
        );
      }
    },
    onSuccess: (response, { name, action }) => {
      client.setQueryData<ServerListResponse>(queryKeys.servers, (old) =>
        old
          ? { servers: old.servers.map((server) => (server.name === name ? response.server : server)) }
          : old,
      );
      void client.invalidateQueries({ queryKey: queryKeys.server(name) });
      notify('success', `${PAST[action]} ${name}.`);
    },
    onError: (error, { name, action }) => {
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      const { message, problems } = describeError(error);
      notify('error', `Could not ${action} ${name}`, [message, ...problems].join('\n'));
    },
  });
}

export function useDeleteServer(onDeleted?: (name: string) => void) {
  const client = useQueryClient();
  const { notify } = useToast();
  return useMutation({
    mutationFn: (name: string) => api.delete<ServerRemovedResponse>(API_PATHS.server(name)),
    onSuccess: (_response, name) => {
      client.setQueryData<ServerListResponse>(queryKeys.servers, (old) =>
        old ? { servers: old.servers.filter((server) => server.name !== name) } : old,
      );
      void client.invalidateQueries({ queryKey: queryKeys.tools });
      notify('success', `Removed ${name}.`);
      onDeleted?.(name);
    },
    onError: (error, name) => {
      const { message, problems } = describeError(error);
      notify('error', `Could not remove ${name}`, [message, ...problems].join('\n'));
    },
  });
}
