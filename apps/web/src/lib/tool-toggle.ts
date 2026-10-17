import { useMutation, useQueryClient } from '@tanstack/react-query';
import { API_PATHS, type ToolResponse } from '@mcpier/shared';
import { api, describeError } from './api';
import { queryKeys } from './queries';
import { useToast } from '@/components/toaster';

/** Enable or disable one tool (saved in the server's disabledTools). */
export function useToolToggle() {
  const client = useQueryClient();
  const { notify } = useToast();
  return useMutation({
    mutationFn: ({ fullName, enable }: { fullName: string; enable: boolean }) =>
      api.post<ToolResponse>(API_PATHS.toolAction(fullName, enable ? 'enable' : 'disable')),
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: queryKeys.tools });
      void client.invalidateQueries({ queryKey: queryKeys.server(response.tool.server) });
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      notify('success', `${response.tool.fullName} is ${response.tool.enabled ? 'enabled' : 'disabled'}.`);
    },
    onError: (error, { fullName }) => {
      const { message, problems } = describeError(error);
      notify('error', `Could not change ${fullName}`, [message, ...problems].join('\n'));
    },
  });
}
