// Phase 4: Add server, form and paste: secrets stored before the server is saved, saved
// entries holding references, the import preview, and the connection test.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { buildEntry, emptyForm, entryFromCandidate, newRow, refreshRow } from '@/lib/entry-form';
import { fakeApi, renderApp, server, status } from './helpers';

const TOKEN = 'ghp_formvalue_0123456789abcdef';

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/status': status(),
    'GET /api/servers': { servers: [server()] },
    'GET /api/secrets': { secrets: [{ name: 'existing-key', usedBy: [] }], missing: [] },
    ...extra,
  };
}

describe('Add server: form', () => {
  it('validates the name live (slug rule, existing names)', async () => {
    fakeApi(baseRoutes());
    const user = userEvent.setup();
    renderApp('/servers/new');
    const name = await screen.findByLabelText('Name');
    await user.type(name, 'Bad Name');
    expect(await screen.findByText(/must be a lowercase slug/)).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'files');
    expect(await screen.findByText('A server named "files" already exists.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save server' }));
    expect(await screen.findAllByText(/already exists/)).not.toHaveLength(0);
  });

  it('a credential-looking value is stored as a secret first; the saved entry holds the reference', async () => {
    const { calls } = fakeApi(
      baseRoutes({
        'PUT /api/secrets/github-github-token': { name: 'github-github-token', restarted: [] },
        'POST /api/servers': (call: { body: { name: string } }) => ({
          status: 201,
          body: { server: server({ name: call.body.name, status: { state: 'starting', since: 'x' } }) },
        }),
        'GET /api/servers/github': {
          server: server({ name: 'github' }),
          config: {
            name: 'github',
            transport: 'stdio',
            command: 'npx',
            args: [],
            env: {},
            enabled: true,
            timeoutMs: 1,
            startupTimeoutMs: 1,
            disabledTools: [],
            protocol: 'auto',
          },
          tools: [],
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await user.type(await screen.findByLabelText('Name'), 'github');
    await user.type(screen.getByLabelText('Command'), 'npx');
    await user.click(screen.getByRole('button', { name: 'Add argument' }));
    await user.type(screen.getByLabelText('Argument 1'), '-y');
    await user.click(screen.getByRole('button', { name: /Add variable/ }));
    await user.type(screen.getByLabelText('Environment variable 1 name'), 'GITHUB_TOKEN');
    // Credential-looking: "store as a secret" is chosen by default, with a proposed name.
    expect(screen.getByLabelText('Environment variable 1 storage')).toHaveDisplayValue('Store as a secret');
    expect(screen.getByLabelText('Environment variable 1 secret name')).toHaveValue('github-github-token');
    const value = screen.getByLabelText('Environment variable 1 value');
    expect(value).toHaveAttribute('type', 'password');
    await user.type(value, TOKEN);
    await user.click(screen.getByRole('button', { name: 'Save server' }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers')).toBe(true),
    );
    const putIndex = calls.findIndex((call) => call.method === 'PUT');
    const postIndex = calls.findIndex((call) => call.method === 'POST' && call.path === '/api/servers');
    expect(putIndex).toBeGreaterThanOrEqual(0);
    expect(putIndex).toBeLessThan(postIndex);
    expect(calls[putIndex]).toMatchObject({
      path: '/api/secrets/github-github-token',
      body: { value: TOKEN },
    });
    const saved = calls[postIndex]!.body as { env: Record<string, string>; args: string[] };
    expect(saved.env).toEqual({ GITHUB_TOKEN: 'secret:github-github-token' });
    expect(saved.args).toEqual(['-y']);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(await screen.findByText('Added github.')).toBeInTheDocument();
  });

  it('a failing secret store stops before the server is saved', async () => {
    const { calls } = fakeApi(
      baseRoutes({
        'PUT /api/secrets/svc-api-key': () => ({
          status: 400,
          body: { error: { code: 'invalid_request', message: 'The value is too long.' } },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await user.type(await screen.findByLabelText('Name'), 'svc');
    await user.type(screen.getByLabelText('Command'), 'node');
    await user.click(screen.getByRole('button', { name: /Add variable/ }));
    await user.type(screen.getByLabelText('Environment variable 1 name'), 'API_KEY');
    await user.type(screen.getByLabelText('Environment variable 1 value'), 'x'.repeat(10));
    await user.click(screen.getByRole('button', { name: 'Save server' }));
    expect(await screen.findByText('Could not save the server')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers')).toBe(false);
  });

  it('connection test: success with tools, and failure with stderr; plain values used as typed', async () => {
    let tested: Record<string, unknown> | undefined;
    let ok = true;
    fakeApi(
      baseRoutes({
        'POST /api/connection-test': (call: { body: Record<string, unknown> }) => {
          tested = call.body;
          return {
            body: ok
              ? {
                  ok: true,
                  protocolVersion: '2025-11-25',
                  tools: { count: 2, names: ['echo', 'add'] },
                  durationMs: 321,
                }
              : {
                  ok: false,
                  tools: { count: 0, names: [] },
                  durationMs: 40,
                  error: 'The server exited (code 3).',
                  stderr: ['boom [value:API_KEY]'],
                },
          };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await user.type(await screen.findByLabelText('Name'), 'probe');
    await user.type(screen.getByLabelText('Command'), 'node');
    await user.click(screen.getByRole('button', { name: /Add variable/ }));
    await user.type(screen.getByLabelText('Environment variable 1 name'), 'API_KEY');
    await user.type(screen.getByLabelText('Environment variable 1 value'), 'typed-value');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected: 2 tools, protocol 2025-11-25, in 321 ms/)).toBeInTheDocument();
    expect(screen.getByText('echo, add')).toBeInTheDocument();
    expect(tested).toMatchObject({ name: 'probe', command: 'node', env: { API_KEY: 'typed-value' } });

    ok = false;
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const failure = await screen.findByText('Connection failed (40 ms)');
    const box = failure.closest('[role="alert"]')!;
    expect(box).toHaveTextContent('The server exited (code 3).');
    expect(box).toHaveTextContent('boom [value:API_KEY]');
  });
});

describe('Add server: paste JSON', () => {
  const pasted = {
    mcpServers: {
      files: { command: 'npx', args: ['-y', 'fs'] },
      github: {
        command: 'npx',
        args: ['-y', 'gh'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_pasted_9876543210' },
        autoApprove: [],
      },
    },
  };

  it('previews collisions, ignored fields and credential values; saves secrets first and references only', async () => {
    const { calls } = fakeApi(
      baseRoutes({
        'POST /api/import': {
          dryRun: true,
          shape: 'mcpServers',
          entries: [
            {
              key: 'github',
              name: 'github',
              entry: {
                name: 'github',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', 'gh'],
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<hidden: 21 characters>' },
              },
              ignored: ['autoApprove'],
              sensitive: [{ location: 'env', key: 'GITHUB_PERSONAL_ACCESS_TOKEN' }],
            },
          ],
          errors: [{ key: 'files', message: 'A server named "files" already exists.' }],
          created: [],
        },
        'PUT /api/secrets/github-github-personal-access-token': {
          name: 'github-github-personal-access-token',
          restarted: [],
        },
        'POST /api/servers': {
          server: server({ name: 'github', status: { state: 'starting', since: 'x' } }),
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await user.click(await screen.findByRole('tab', { name: 'Paste JSON' }));
    const area = screen.getByLabelText('A mcpServers block');
    await user.click(area);
    await user.paste(JSON.stringify(pasted));
    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('files: not imported')).toBeInTheDocument();
    expect(screen.getByText('A server named "files" already exists.')).toBeInTheDocument();
    const card = screen.getByText('github', { selector: 'p' }).closest('[data-candidate]') as HTMLElement;
    expect(within(card).getByText('Ignored fields: autoApprove')).toBeInTheDocument();
    expect(within(card).getByText(/looks like a credential/)).toBeInTheDocument();
    expect(
      within(card).getByRole('switch', { name: 'Store GITHUB_PERSONAL_ACCESS_TOKEN as a secret' }),
    ).toBeChecked();
    expect(within(card).getByLabelText('Secret name for GITHUB_PERSONAL_ACCESS_TOKEN')).toHaveValue(
      'github-github-personal-access-token',
    );
    // The preview request itself was a dry run.
    expect(calls.find((call) => call.path === '/api/import')?.body).toMatchObject({ dryRun: true });

    await user.click(screen.getByRole('button', { name: 'Save 1 server' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers')).toBe(true),
    );
    const put = calls.findIndex((call) => call.method === 'PUT');
    const post = calls.findIndex((call) => call.method === 'POST' && call.path === '/api/servers');
    expect(put).toBeLessThan(post);
    expect(calls[put]!.body).toEqual({ value: 'ghp_pasted_9876543210' });
    expect(calls[post]!.body).toMatchObject({
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret:github-github-personal-access-token' },
    });
    expect(JSON.stringify(calls[post]!.body)).not.toContain('ghp_pasted');
  });
});

describe('Edit server', () => {
  it('is prefilled, keeps references as references, and saves with PATCH', async () => {
    let patch: Record<string, unknown> | undefined;
    fakeApi(
      baseRoutes({
        'GET /api/servers/files': {
          server: server(),
          config: {
            name: 'files',
            transport: 'stdio',
            description: 'Local files',
            command: 'npx',
            args: ['-y', 'fs'],
            env: { API_KEY: 'secret:existing-key', MODE: 'fast' },
            enabled: true,
            timeoutMs: 60000,
            startupTimeoutMs: 90000,
            disabledTools: [],
            protocol: 'auto',
          },
          tools: [],
        },
        'PATCH /api/servers/files': (call: { body: Record<string, unknown> }) => {
          patch = call.body;
          return { body: { server: server() } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    expect(await screen.findByLabelText('Name')).toBeDisabled();
    expect(screen.getByLabelText('Name')).toHaveValue('files');
    expect(screen.getByLabelText('Environment variable 1 storage')).toHaveDisplayValue(
      'Use an existing secret',
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Environment variable 1 secret')).toHaveDisplayValue('existing-key'),
    );
    await user.clear(screen.getByLabelText('Description'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patch).toBeDefined());
    expect(patch).not.toHaveProperty('name');
    expect(patch).toMatchObject({
      description: null,
      command: 'npx',
      args: ['-y', 'fs'],
      env: { API_KEY: 'secret:existing-key', MODE: 'fast' },
    });
  });
});

describe('entry-form helpers', () => {
  it('headers keep their scheme in config, and only the token is stored', () => {
    const form = { ...emptyForm(), name: 'api', transport: 'http' as const, url: 'https://x.example/mcp' };
    form.headers = [
      refreshRow(newRow({ key: 'Authorization', value: 'Bearer abc123token' }), 'header', 'api'),
    ];
    const built = buildEntry(form, 'save');
    expect(built.entry.headers).toEqual({ Authorization: 'Bearer secret:api-authorization' });
    expect(built.secrets).toEqual([{ name: 'api-authorization', value: 'abc123token' }]);
    expect(buildEntry(form, 'test').entry.headers).toEqual({ Authorization: 'Bearer abc123token' });
  });

  it('a value kept plain stays plain', () => {
    const form = { ...emptyForm(), name: 'svc', command: 'node' };
    form.env = [
      {
        ...refreshRow(newRow({ key: 'API_KEY', value: 'v' }), 'env', 'svc'),
        mode: 'plain',
        modeTouched: true,
      },
    ];
    expect(buildEntry(form, 'save')).toMatchObject({ entry: { env: { API_KEY: 'v' } }, secrets: [] });
  });

  it('restores hidden pasted values for a test, and references for saving', () => {
    const candidate = {
      key: 'Remote API',
      name: 'remote-api',
      entry: {
        name: 'remote-api',
        transport: 'http',
        url: 'https://x',
        headers: { Authorization: '<hidden: 9 characters>' },
      },
      ignored: [],
      sensitive: [{ location: 'header' as const, key: 'Authorization', scheme: 'Bearer' }],
    };
    const pastedBlock = {
      mcpServers: { 'Remote API': { url: 'https://x', headers: { Authorization: 'Bearer tok123456' } } },
    };
    const choice = { secretNames: new Map([['Remote API\u0000header\u0000Authorization', 'remote-key']]) };
    expect(entryFromCandidate(candidate, pastedBlock, 'mcpServers', choice, 'test').entry.headers).toEqual({
      Authorization: 'Bearer tok123456',
    });
    const saved = entryFromCandidate(candidate, pastedBlock, 'mcpServers', choice, 'save');
    expect(saved.entry.headers).toEqual({ Authorization: 'Bearer secret:remote-key' });
    expect(saved.secrets).toEqual([{ name: 'remote-key', value: 'tok123456' }]);
  });
});
