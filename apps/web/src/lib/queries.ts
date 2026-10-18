// Query keys, the queries the pages share, and how live events change their data.
import { QueryClient, useQuery, type QueryClient as Client } from '@tanstack/react-query';
import {
  API_PATHS,
  AUTH_API_PATHS,
  DASHBOARD_API_PATHS,
  type AuthStatusResponse,
  type ConnectResponse,
  type GatewayEvent,
  type SecretListResponse,
  type ServerDetailResponse,
  type ServerListResponse,
  type SettingsResponse,
  type StatusResponse,
  type ToolListResponse,
} from '@mcpier/shared';
import { api, ApiError } from './api';
import { refreshUsageThrottled } from './usage';

export const queryKeys = {
  status: ['status'] as const,
  servers: ['servers'] as const,
  server: (name: string) => ['server', name] as const,
  tools: ['tools'] as const,
  secrets: ['secrets'] as const,
  settings: ['settings'] as const,
  connect: ['connect'] as const,
  auth: (name: string) => ['auth', name] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry only a dropped connection (twice). An answer from the gateway, a 401 above
        // all, is shown as it is: retrying would not change it.
        retry: (count, error) => error instanceof ApiError && error.code === 'network' && count < 2,
        refetchOnWindowFocus: false,
        // Live events keep the data current; no polling.
        staleTime: 30_000,
      },
      mutations: { retry: false },
    },
  });
}

export const useStatus = () =>
  useQuery({ queryKey: queryKeys.status, queryFn: () => api.get<StatusResponse>(API_PATHS.status) });
export const useServers = () =>
  useQuery({ queryKey: queryKeys.servers, queryFn: () => api.get<ServerListResponse>(API_PATHS.servers) });
export const useServer = (name: string) =>
  useQuery({
    queryKey: queryKeys.server(name),
    queryFn: () => api.get<ServerDetailResponse>(API_PATHS.server(name)),
  });
export const useTools = () =>
  useQuery({ queryKey: queryKeys.tools, queryFn: () => api.get<ToolListResponse>(API_PATHS.tools) });
export const useSecrets = () =>
  useQuery({ queryKey: queryKeys.secrets, queryFn: () => api.get<SecretListResponse>(API_PATHS.secrets) });
export const useSettings = () =>
  useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.get<SettingsResponse>(DASHBOARD_API_PATHS.settings),
  });
export const useConnect = () =>
  useQuery({
    queryKey: queryKeys.connect,
    queryFn: () => api.get<ConnectResponse>(DASHBOARD_API_PATHS.connect),
  });

/** One OAuth server's sign-in (no values). Kept current by `auth_status` events. */
export const useAuthStatus = (name: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.auth(name),
    queryFn: () => api.get<AuthStatusResponse>(AUTH_API_PATHS.status(name)),
    enabled,
  });

/**
 * Applies one live event to the cached data. Status and tool counts are written in place (no
 * request); structural changes invalidate the queries that depend on them, which refetch
 * only if a page is showing them.
 */
export function applyEvent(client: Client, event: GatewayEvent): void {
  switch (event.type) {
    case 'snapshot': {
      client.setQueryData(queryKeys.status, event.data.status);
      client.setQueryData<ServerListResponse>(queryKeys.servers, { servers: event.data.servers });
      return;
    }
    case 'server_status': {
      const { name, status, protocolVersion } = event.data;
      client.setQueryData<ServerListResponse>(queryKeys.servers, (old) =>
        old
          ? {
              servers: old.servers.map((server) =>
                server.name === name
                  ? {
                      ...server,
                      status,
                      ...(protocolVersion ? { protocolVersion } : {}),
                      ...(status.state === 'ready' ? {} : { uptimeSeconds: undefined }),
                    }
                  : server,
              ),
            }
          : old,
      );
      client.setQueryData<ServerDetailResponse>(queryKeys.server(name), (old) =>
        old
          ? { ...old, server: { ...old.server, status, ...(protocolVersion ? { protocolVersion } : {}) } }
          : old,
      );
      // Availability of that server's tools follows its status.
      void client.invalidateQueries({ queryKey: queryKeys.tools });
      void client.invalidateQueries({ queryKey: queryKeys.status });
      return;
    }
    case 'server_tools': {
      const { name, tools } = event.data;
      client.setQueryData<ServerListResponse>(queryKeys.servers, (old) =>
        old
          ? { servers: old.servers.map((server) => (server.name === name ? { ...server, tools } : server)) }
          : old,
      );
      void client.invalidateQueries({ queryKey: queryKeys.server(name) });
      void client.invalidateQueries({ queryKey: queryKeys.tools });
      return;
    }
    case 'server_added':
    case 'server_edited':
    case 'server_removed': {
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      void client.invalidateQueries({ queryKey: queryKeys.server(event.data.name) });
      void client.invalidateQueries({ queryKey: queryKeys.tools });
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      void client.invalidateQueries({ queryKey: queryKeys.status });
      return;
    }
    case 'settings_changed': {
      void client.invalidateQueries({ queryKey: queryKeys.settings });
      void client.invalidateQueries({ queryKey: queryKeys.connect });
      return;
    }
    case 'config_problem': {
      const problem = event.data.problem;
      client.setQueryData<StatusResponse>(queryKeys.status, (old) => {
        if (!old) return old;
        const { configProblem: _previous, ...rest } = old;
        return problem ? { ...rest, configProblem: problem } : rest;
      });
      return;
    }
    case 'secrets_changed': {
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      return;
    }
    case 'auth_status': {
      client.setQueryData<AuthStatusResponse>(queryKeys.auth(event.data.server), { status: event.data });
      return;
    }
    case 'call_recorded': {
      // The Call log page inserts the call itself; the stats and searches it shows refetch (only
      // while shown). A search's follow-up may have changed with this call.
      void client.invalidateQueries({ queryKey: ['call-stats'] });
      void client.invalidateQueries({ queryKey: ['searches'] });
      // Charts and rails that count calls refetch at most once every 5 seconds.
      refreshUsageThrottled(client);
      return;
    }
  }
}
