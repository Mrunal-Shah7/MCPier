// Phase 4: Servers, Tools, Connect and Settings pages: loading, empty and error states,
// main actions, and validation messages.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { connectSnippets, defaultConfig, type ToolInfo } from '@mcpier/shared';
import { fakeApi, renderApp, server, status } from './helpers';

const failing = (message: string) => () => ({
  status: 500,
  body: { error: { code: 'internal_error', message } },
});
const never = () => new Promise<never>(() => {});
// Sprint 7: a server's name also shows in the Needs attention rail; this is its table row.
const rowOf = async (name: string) =>
  (await screen.findAllByText(name)).map((element) => element.closest('tr')).find((row) => row !== null)!;

function tool(name: string, overrides: Partial<ToolInfo> = {}): ToolInfo {
  return {
    fullName: `files__${name}`,
    server: 'files',
    name,
    description: `Does ${name}`,
    inputSchema: { type: 'object' },
    enabled: true,
    available: true,
    ...overrides,
  };
}

describe('Servers page', () => {
  it('loading', async () => {
    const { fetchMock } = fakeApi({ 'GET /api/status': status() });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input).endsWith('/api/servers') ? never() : real(input, init),
    );
    renderApp('/servers');
    expect(await screen.findByRole('status', { name: 'Loading servers' })).toBeInTheDocument();
  });

  it('empty: points to Add server and the CLI', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/servers': { servers: [] } });
    renderApp('/servers');
    expect(await screen.findByText('No servers yet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Add server/ }).length).toBeGreaterThan(0);
    expect(screen.getByText(/mcpier server add/)).toBeInTheDocument();
  });

  it('error', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': failing('Internal error. See the gateway log for details.'),
    });
    renderApp('/servers');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the servers');
  });

  it('shows status detail and runs an action, showing starting at once', async () => {
    let posted: string | undefined;
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': {
        servers: [server({ status: { state: 'stopped', since: 'x' }, description: 'Local files' })],
      },
      'POST /api/servers/files/start': (call) => {
        posted = call.path;
        return { body: { server: server({ status: { state: 'starting', since: 'y' } }) } };
      },
    });
    const user = userEvent.setup();
    renderApp('/servers');
    const row = await rowOf('files');
    expect(within(row).getByText('Stopped')).toBeInTheDocument();
    expect(within(row).getByText('Local files')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Actions for files' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Start' }));
    expect(await within(row).findByText('Starting')).toBeInTheDocument();
    expect(posted).toBe('/api/servers/files/start');
    expect(await screen.findByText('Starting files.')).toBeInTheDocument();
  });

  it('delete asks for confirmation naming the server', async () => {
    let deleted = false;
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'DELETE /api/servers/files': () => {
        deleted = true;
        return { body: { removed: 'files' } };
      },
    });
    const user = userEvent.setup();
    renderApp('/servers');
    await user.click(await screen.findByRole('button', { name: 'Actions for files' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete files?');
    expect(deleted).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete files' }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.queryByRole('row', { name: /files/ })).toBeNull());
  });

  it('a failed action says why', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server({ enabled: false, status: { state: 'stopped', since: 'x' } })] },
      'POST /api/servers/files/enable': () => ({
        status: 409,
        body: { error: { code: 'config_invalid', message: 'config.json has problems; fix the file first.' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/servers');
    await user.click(await screen.findByRole('button', { name: 'Actions for files' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Enable' }));
    expect(await screen.findByText('Could not enable files')).toBeInTheDocument();
    // The toast's screen-reader announcement may briefly repeat the text (Sprint 7: seen under load).
    expect(screen.getAllByText(/fix the file first/).length).toBeGreaterThan(0);
  });
});

describe('Tools page', () => {
  it('search shows what search_tools returns, with the limit and server sent', async () => {
    const { calls } = fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/tools/search': {
        query: 'read file',
        results: [
          {
            name: 'files__read_text_file',
            server: 'files',
            description: 'Read a file',
            inputSchema: {},
            available: true,
          },
          {
            name: 'gh__read_file',
            server: 'gh',
            description: 'Read from GitHub',
            inputSchema: {},
            available: false,
            serverStatus: 'needs_auth',
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderApp('/tools');
    await user.type(await screen.findByLabelText('What do you want to do?'), 'read file');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const results = await screen.findByRole('list', { name: 'Search results' });
    const items = within(results).getAllByRole('listitem');
    // Sprint 7: each result also shows the server tile and the description.
    expect(items[0]).toHaveTextContent(/^1.*files__read_text_file.*available$/);
    expect(items[1]).toHaveTextContent('gh__read_file');
    expect(within(items[1]!).getByText('Needs sign-in')).toBeInTheDocument();
    const search = calls.find((call) => call.path.startsWith('/api/tools/search'))!;
    expect(search.path).toBe('/api/tools/search?q=read+file&limit=5');
    expect(search.headers['x-mcpier-client']).toBe('dashboard');
  });

  it('a search error is shown', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [] },
      'GET /api/tools/search': () => ({
        status: 400,
        body: {
          error: {
            code: 'invalid_request',
            message: 'Give a query (what you want to do), or call list_servers.',
          },
        },
      }),
    });
    const user = userEvent.setup();
    renderApp('/tools');
    await user.click(await screen.findByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give a query');
  });

  it('catalog: filters, toggles, and links to the tool on its server page', async () => {
    let toggled: string | undefined;
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/tools': {
        tools: [tool('read_file'), tool('write_file', { enabled: false }), tool('old', { available: false })],
      },
      'POST /api/tools/files__write_file/enable': (call) => {
        toggled = call.path;
        return { body: { tool: tool('write_file') } };
      },
    });
    const user = userEvent.setup();
    renderApp('/tools');
    await user.click(await screen.findByRole('tab', { name: 'Catalog' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByRole('link', { name: 'files__read_file' })).toHaveAttribute(
      'href',
      '/servers/files?tab=tools&tool=read_file',
    );
    await user.click(within(table).getByRole('switch', { name: 'Enable files__write_file' }));
    await waitFor(() => expect(toggled).toBe('/api/tools/files__write_file/enable'));
    // Filter: unavailable only (Sprint 7: a segmented control instead of a select).
    await user.click(
      within(screen.getByRole('group', { name: 'Available' })).getByRole('button', { name: 'Unavailable' }),
    );
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2));
  });

  it('catalog empty state', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [] },
      'GET /api/tools': { tools: [] },
    });
    const user = userEvent.setup();
    renderApp('/tools');
    await user.click(await screen.findByRole('tab', { name: 'Catalog' }));
    expect(await screen.findByText('No tools yet')).toBeInTheDocument();
  });
});

describe('Connect page', () => {
  const clients = connectSnippets({ nodePath: 'C:\\node.exe', cliEntry: 'C:\\repo\\mcpier.js', port: 47800 });

  it('one card per client, with copy and steps', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/connect': { url: 'http://127.0.0.1:47800/mcp', port: 47800, placeholder: false, clients },
    });
    renderApp('/connect');
    expect(await screen.findByText('Claude Desktop')).toBeInTheDocument();
    for (const client of clients) {
      expect(screen.getByRole('button', { name: `Copy the ${client.title} snippet` })).toBeInTheDocument();
    }
    expect(screen.queryByText('Placeholder paths')).toBeNull();
    expect(screen.getByText(/C:\\\\repo\\\\mcpier.js/)).toBeInTheDocument();
  });

  it('says so when the paths are placeholders', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/connect': {
        url: 'x',
        port: 1,
        placeholder: true,
        note: 'These paths are placeholders.',
        clients,
      },
    });
    renderApp('/connect');
    expect(await screen.findByText('Placeholder paths')).toBeInTheDocument();
    expect(screen.getByText('These paths are placeholders.')).toBeInTheDocument();
  });

  it('error', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/connect': failing('boom') });
    renderApp('/connect');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the snippets');
  });
});

describe('Settings page', () => {
  const settings = defaultConfig().settings;

  it('shows validation messages and saves a valid change with the restart note', async () => {
    let patch: Record<string, unknown> | undefined;
    fakeApi({
      'GET /api/status': status(),
      'GET /api/settings': { settings },
      'PATCH /api/settings': (call) => {
        patch = call.body as Record<string, unknown>;
        return {
          body: {
            settings: { ...settings, resultSizeLimitKb: 64, port: 48000 },
            restartRequired: true,
            notes: ['The port change is saved. MCPier keeps listening on 47800 until it restarts.'],
          },
        };
      },
    });
    const user = userEvent.setup();
    renderApp('/settings');
    const limit = await screen.findByLabelText('Result size limit (KB)');
    await user.clear(limit);
    await user.type(limit, '0');
    expect(await screen.findByText(/Result size limit \(KB\) must be at least 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    await user.clear(limit);
    await user.type(limit, '64');
    const port = screen.getByLabelText('Port');
    await user.clear(port);
    await user.type(port, '80');
    expect(await screen.findByText(/Port must be between 1024 and 65535/)).toBeInTheDocument();
    await user.clear(port);
    await user.type(port, '48000');
    await user.type(screen.getByLabelText(/Client ID Metadata Document URL/), 'http://insecure.example');
    expect(await screen.findByText(/must be an https:\/\/ URL/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Client ID Metadata Document URL/));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(patch).toMatchObject({ resultSizeLimitKb: 64, port: 48000, cimdUrl: null }));
    expect(await screen.findByText(/keeps listening on 47800/)).toBeInTheDocument();
    // Read-only facts.
    expect(screen.getByText('C:\\Users\\me\\AppData\\Local\\MCPier')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
  });

  it('a gateway-side refusal is shown with its problems', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/settings': { settings },
      'PATCH /api/settings': () => ({
        status: 409,
        body: {
          error: {
            code: 'config_invalid',
            message: 'config.json has problems; fix the file first.',
            problems: ['servers[0].name: bad'],
          },
        },
      }),
    });
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: 'Save settings' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save the settings');
    expect(alert).toHaveTextContent('servers[0].name: bad');
  });

  it('error', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/settings': failing('nope') });
    renderApp('/settings');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the settings');
  });
});

describe('loading states', () => {
  // For each page with data: its data request never answers, so the loading state stays.
  it.each([
    ['/servers', '/api/servers', 'Loading servers', undefined],
    ['/tools', '/api/tools', 'Loading tools', 'Catalog'],
    ['/secrets', '/api/secrets', 'Loading secrets', undefined],
    ['/connect', '/api/connect', 'Loading snippets', undefined],
    ['/settings', '/api/settings', 'Loading settings', undefined],
    ['/servers/files', '/api/servers/files', 'Loading files', undefined],
    ['/servers/files/edit', '/api/servers/files', 'Loading the server', undefined],
  ])('%s shows its loading state while %s is pending', async (path, dataPath, label, tab) => {
    const { fetchMock } = fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
      'GET /api/secrets': { secrets: [], missing: [] },
    });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      new URL(String(input), 'http://127.0.0.1').pathname === dataPath ? never() : real(input, init),
    );
    const user = userEvent.setup();
    renderApp(path);
    if (tab) await user.click(await screen.findByRole('tab', { name: tab }));
    expect(await screen.findByRole('status', { name: label })).toBeInTheDocument();
  });
});
