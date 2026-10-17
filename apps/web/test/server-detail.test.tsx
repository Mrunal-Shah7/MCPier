// Phase 4: Server detail: overview with masking, reveal and "move to secret", tools with
// schemas and toggles, and logs. (The Authorization section has its own tests.)
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ServerDetailResponse } from '@mcpier/shared';
import { fakeApi, renderApp, server, status } from './helpers';

const PLAIN_TOKEN = 'plain-token-value-4444-abcd';

function detail(overrides: Partial<ServerDetailResponse> = {}): ServerDetailResponse {
  return {
    server: server({ name: 'files', description: 'Local files' }),
    config: {
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { API_TOKEN: PLAIN_TOKEN, MODE: 'fast', GH: 'secret:github-token' },
      enabled: true,
      timeoutMs: 60000,
      startupTimeoutMs: 90000,
      disabledTools: [],
      protocol: 'auto',
    } as ServerDetailResponse['config'],
    tools: [
      {
        fullName: 'files__read_file',
        server: 'files',
        name: 'read_file',
        title: 'Read File',
        description: 'Reads a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        readOnlyHint: true,
        enabled: true,
        available: true,
      },
      {
        fullName: 'files__weird name',
        server: 'files',
        name: 'weird name',
        inputSchema: { type: 'object' },
        destructiveHint: true,
        enabled: false,
        available: true,
        flag: 'The tool name uses characters outside A-Z.',
      },
    ],
    ...overrides,
  };
}

describe('Server detail: overview', () => {
  it('masks credential-looking plain values, with reveal; references stay references', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/servers/files': detail(),
    });
    const user = userEvent.setup();
    renderApp('/servers/files');
    expect(await screen.findByLabelText('API_TOKEN is hidden')).toBeInTheDocument();
    expect(screen.queryByText(PLAIN_TOKEN)).toBeNull();
    expect(screen.getByText('fast')).toBeInTheDocument();
    expect(screen.getByText('secret:github-token')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reveal API_TOKEN' }));
    expect(screen.getByText(PLAIN_TOKEN)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide API_TOKEN' }));
    expect(screen.queryByText(PLAIN_TOKEN)).toBeNull();
    // Only the credential-looking value offers the move.
    expect(screen.getAllByRole('button', { name: 'Move to secret' })).toHaveLength(1);
  });

  it('move to secret sends names only, and the reference replaces the value', async () => {
    let moved: unknown;
    let after = false;
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/servers/files': () => ({
        body: after
          ? detail({
              config: {
                ...detail().config,
                env: { API_TOKEN: 'secret:files-api-token', MODE: 'fast', GH: 'secret:github-token' },
              } as ServerDetailResponse['config'],
            })
          : detail(),
      }),
      'GET /api/secrets': { secrets: [], missing: [] },
      'POST /api/servers/files/move-to-secret': (call) => {
        moved = call.body;
        after = true;
        return { body: { server: server(), reference: 'secret:files-api-token', secret: 'files-api-token' } };
      },
    });
    const user = userEvent.setup();
    renderApp('/servers/files');
    await user.click(await screen.findByRole('button', { name: 'Move to secret' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Secret name')).toHaveValue('files-api-token');
    await user.click(within(dialog).getByRole('button', { name: 'Move to secret' }));
    await waitFor(() =>
      expect(moved).toEqual({ location: 'env', key: 'API_TOKEN', secretName: 'files-api-token' }),
    );
    expect(JSON.stringify(moved)).not.toContain(PLAIN_TOKEN);
    expect(await screen.findByText('secret:files-api-token')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal API_TOKEN' })).toBeNull();
  });

  it('a live status event updates the detail page', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/servers/files': detail(),
    });
    const { events } = renderApp('/servers/files');
    expect(await screen.findAllByText('Ready')).not.toHaveLength(0);
    act(() =>
      events.emit({
        type: 'server_status',
        data: { name: 'files', status: { state: 'stopped', since: 'z' } },
      }),
    );
    expect(await screen.findAllByText('Stopped')).not.toHaveLength(0);
  });

  it('error', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers/ghost': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'No server named "ghost".' } },
      }),
    });
    renderApp('/servers/ghost');
    expect(await screen.findByRole('alert')).toHaveTextContent('No server named "ghost".');
  });
});

describe('Server detail: tools and logs', () => {
  it('tools show hints and flags, expand to schemas, and toggle', async () => {
    let toggled: string | undefined;
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/servers/files': detail(),
      'POST /api/tools/files__weird%20name/enable': (call) => {
        toggled = call.path;
        return { body: { tool: { ...detail().tools[1]!, enabled: true } } };
      },
    });
    const user = userEvent.setup();
    renderApp('/servers/files?tab=tools&tool=read_file');
    const row = (await screen.findByText('read_file')).closest('[data-tool]') as HTMLElement;
    expect(within(row).getByText('read-only')).toBeInTheDocument();
    // Opened from a deep link: the schemas are visible.
    expect(within(row).getByText('Input schema')).toBeInTheDocument();
    expect(within(row).getByText('Output schema')).toBeInTheDocument();
    const weird = screen.getByText('weird name').closest('[data-tool]') as HTMLElement;
    expect(within(weird).getByText('destructive')).toBeInTheDocument();
    expect(within(weird).getByText('flagged name')).toBeInTheDocument();
    await user.click(within(weird).getByRole('switch', { name: 'Enable files__weird name' }));
    await waitFor(() => expect(toggled).toBe('/api/tools/files__weird%20name/enable'));
  });

  it('logs: the last lines, then live lines, with pause and clear', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/servers/files': detail(),
      'GET /api/servers/files/logs?lines=200': { server: 'files', lines: ['old line one', 'old line two'] },
      'GET /api/servers/files/logs/stream': () => ({
        raw: 'event: ready\ndata: files\n\nevent: line\ndata: live line three\n\n',
      }),
    });
    const user = userEvent.setup();
    renderApp('/servers/files?tab=logs');
    const log = await screen.findByLabelText('files log');
    await waitFor(() => expect(log).toHaveTextContent('old line one'));
    await waitFor(() => expect(log).toHaveTextContent('live line three'));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Paused: new lines are held.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear view' }));
    expect(log).toHaveTextContent('No log lines yet.');
  });
});
