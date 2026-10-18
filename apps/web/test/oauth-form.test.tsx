// Sprint 5, Phase 4: the "OAuth client" group in Add server and Edit (the client secret is
// stored as a secret before the server is saved), the connection test's discovery result,
// and the CIMD document on the Settings page.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ServerDetailResponse, Settings } from '@mcpier/shared';
import { defaultConfig } from '@mcpier/shared';
import { buildEntry, emptyForm, formFromEntry } from '@/lib/entry-form';
import { fakeApi, renderApp, server, status } from './helpers';

const CLIENT_SECRET = 'console-client-secret-9876';

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/status': status(),
    'GET /api/servers': { servers: [server()] },
    'GET /api/secrets': { secrets: [{ name: 'existing-key', usedBy: [] }], missing: [] },
    ...extra,
  };
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.selectOptions(screen.getByLabelText(label), option);
}

/** Sprint 7: Transport and Sign-in are segmented controls (a group of pressed buttons). */
async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(within(screen.getByRole('group', { name: label })).getByRole('button', { name: option }));
}

/** Fills in an OAuth HTTP server, up to the OAuth client group. */
async function fillOAuthServer(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Name'), 'notion');
  await pick(user, 'Transport', 'http');
  await user.type(screen.getByLabelText('URL'), 'https://mcp.example.com/mcp');
  await pick(user, 'Sign-in', 'OAuth');
  await user.click(screen.getByText('Advanced'));
}

describe('Add server: OAuth client', () => {
  it('appears only for OAuth; stores the client secret first, then saves references only', async () => {
    const order: string[] = [];
    let saved: Record<string, unknown> | undefined;
    let stored: unknown;
    fakeApi(
      baseRoutes({
        'PUT /api/secrets/notion-client-secret': (call: { body: unknown }) => {
          order.push('secret');
          stored = call.body;
          return { body: { name: 'notion-client-secret', restarted: [] } };
        },
        'POST /api/servers': (call: { body: Record<string, unknown> }) => {
          order.push('server');
          saved = call.body;
          return { status: 201, body: { server: server({ name: 'notion', transport: 'http' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await user.type(await screen.findByLabelText('Name'), 'notion');
    await pick(user, 'Transport', 'http');
    expect(screen.queryByRole('group', { name: 'OAuth client' })).toBeNull();
    await user.type(screen.getByLabelText('URL'), 'https://mcp.example.com/mcp');
    await pick(user, 'Sign-in', 'OAuth');
    await user.click(screen.getByText('Advanced'));
    const group = screen.getByRole('group', { name: 'OAuth client' });
    await user.type(within(group).getByLabelText('Client ID'), 'from-console');
    // Sprint 7: scopes are chips; a space adds what was typed.
    await user.type(within(group).getByLabelText('Scopes'), 'read  write');
    await choose(user, 'Client secret', 'Store as a secret');
    expect(within(group).getByLabelText('Secret name')).toHaveValue('notion-client-secret');
    await user.type(within(group).getByLabelText('Client secret value'), CLIENT_SECRET);
    expect(within(group).getByLabelText('Client secret value')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Save server' }));

    await waitFor(() => expect(order).toEqual(['secret', 'server']));
    expect(stored).toEqual({ value: CLIENT_SECRET });
    expect(saved).toMatchObject({
      name: 'notion',
      transport: 'http',
      auth: 'oauth',
      oauth: {
        clientId: 'from-console',
        clientSecret: 'secret:notion-client-secret',
        scopes: ['read', 'write'],
      },
    });
    expect(JSON.stringify(saved)).not.toContain(CLIENT_SECRET);
  });

  it('a failed secret store saves nothing; a missing value is reported before anything is sent', async () => {
    const { calls } = fakeApi(
      baseRoutes({
        'PUT /api/secrets/notion-client-secret': () => ({
          status: 400,
          body: { error: { code: 'invalid_request', message: 'too long' } },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await fillOAuthServer(user);
    const group = screen.getByRole('group', { name: 'OAuth client' });
    await choose(user, 'Client secret', 'Store as a secret');
    await user.click(screen.getByRole('button', { name: 'Save server' }));
    expect(
      await screen.findByText('OAuth client: enter the client ID the client secret belongs to.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('OAuth client: enter the client secret to store as a secret.'),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);

    await user.type(within(group).getByLabelText('Client ID'), 'from-console');
    await user.type(within(group).getByLabelText('Client secret value'), CLIENT_SECRET);
    await user.click(screen.getByRole('button', { name: 'Save server' }));
    expect(await screen.findByText('too long')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers')).toBe(false);
  });

  it('the connection test shows what OAuth discovery found', async () => {
    let tested: Record<string, unknown> | undefined;
    fakeApi(
      baseRoutes({
        'POST /api/connection-test': (call: { body: Record<string, unknown> }) => {
          tested = call.body;
          return {
            body: {
              ok: true,
              needsAuth: true,
              tools: { count: 0, names: [] },
              durationMs: 42,
              discovery: {
                protectedResourceMetadata: true,
                authorizationServer: 'https://auth.example.com',
                authorizationServerMetadata: true,
                issuer: 'https://auth.example.com',
                registrationMethod: 'dynamic',
                scopesSupported: ['read', 'write'],
              },
            },
          };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await fillOAuthServer(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const result = await screen.findByRole('status', { name: '' });
    expect(result).toHaveTextContent('OAuth discovery worked: save the server, then sign in from its page');
    // Sprint 7: what was found is a key/value list, scopes as chips.
    expect(result).toHaveTextContent(/Resource metadata\s*found/);
    expect(result).toHaveTextContent(/Authorization server\s*https:\/\/auth\.example\.com \(found\)/);
    expect(result).toHaveTextContent(/Sign-in\s*Would use dynamic registration/);
    expect(within(result).getByText('read')).toBeInTheDocument();
    expect(within(result).getByText('write')).toBeInTheDocument();
    expect(tested).toMatchObject({ auth: 'oauth', url: 'https://mcp.example.com/mcp' });
  });

  it('a discovery that found no registration method explains what is missing', async () => {
    fakeApi(
      baseRoutes({
        'POST /api/connection-test': {
          ok: false,
          needsAuth: true,
          tools: { count: 0, names: [] },
          durationMs: 5,
          error: 'The authorization server offers no automatic registration, and no client ID is configured.',
          discovery: { protectedResourceMetadata: true, authorizationServerMetadata: true },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/new');
    await fillOAuthServer(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const result = await screen.findByRole('alert');
    expect(result).toHaveTextContent('OAuth discovery did not find everything');
    expect(result).toHaveTextContent('no client ID is configured');
  });
});

describe('Edit server: OAuth client', () => {
  function oauthEntry(oauth?: Record<string, unknown>): ServerDetailResponse {
    return {
      server: server({ name: 'notion', transport: 'http' }),
      config: {
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {},
        auth: 'oauth',
        ...(oauth ? { oauth } : {}),
        enabled: true,
        timeoutMs: 60000,
        startupTimeoutMs: 90000,
        disabledTools: [],
        protocol: 'auto',
      } as ServerDetailResponse['config'],
      tools: [],
    };
  }

  it('is filled from config, references stay references, and clearing it sends null', async () => {
    let patch: Record<string, unknown> | undefined;
    fakeApi(
      baseRoutes({
        'GET /api/servers/notion': oauthEntry({
          clientId: 'from-console',
          clientSecret: 'secret:existing-key',
          scopes: ['read'],
        }),
        'PATCH /api/servers/notion': (call: { body: Record<string, unknown> }) => {
          patch = call.body;
          return { body: { server: server({ name: 'notion' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/notion/edit');
    await user.click(await screen.findByText('Advanced'));
    const group = screen.getByRole('group', { name: 'OAuth client' });
    expect(within(group).getByLabelText('Client ID')).toHaveValue('from-console');
    expect(within(group).getByRole('button', { name: 'Remove scope read' })).toBeInTheDocument();
    expect(within(group).getByLabelText('Client secret')).toHaveDisplayValue('Use an existing secret');
    await waitFor(() => expect(within(group).getByLabelText('Secret')).toHaveDisplayValue('existing-key'));

    // Saved unchanged: the same references go back.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patch).toBeDefined());
    expect(patch?.oauth).toEqual({
      clientId: 'from-console',
      clientSecret: 'secret:existing-key',
      scopes: ['read'],
    });
  });

  it('removing the client ID and scopes removes the block', async () => {
    let patch: Record<string, unknown> | undefined;
    fakeApi(
      baseRoutes({
        'GET /api/servers/notion': oauthEntry({ clientId: 'from-console' }),
        'PATCH /api/servers/notion': (call: { body: Record<string, unknown> }) => {
          patch = call.body;
          return { body: { server: server({ name: 'notion' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/notion/edit');
    await user.click(await screen.findByText('Advanced'));
    await user.clear(within(screen.getByRole('group', { name: 'OAuth client' })).getByLabelText('Client ID'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patch).toBeDefined());
    expect(patch).toMatchObject({ auth: 'oauth', oauth: null });
  });
});

describe('entry-form OAuth helpers', () => {
  it('a test never carries a new client secret; a save turns it into a reference', () => {
    const form = {
      ...emptyForm(),
      name: 'notion',
      transport: 'http' as const,
      url: 'https://x/mcp',
      auth: 'oauth' as const,
      oauthClientId: 'id-1',
      oauthSecretMode: 'new-secret' as const,
      oauthSecretValue: CLIENT_SECRET,
      oauthSecretName: 'notion-client-secret',
    };
    expect(buildEntry(form, 'test').entry.oauth).toEqual({ clientId: 'id-1' });
    expect(buildEntry(form, 'test').secrets).toEqual([]);
    const saved = buildEntry(form, 'save');
    expect(saved.entry.oauth).toEqual({ clientId: 'id-1', clientSecret: 'secret:notion-client-secret' });
    expect(saved.secrets).toEqual([{ name: 'notion-client-secret', value: CLIENT_SECRET }]);
    expect(buildEntry({ ...form, auth: 'none' }, 'save').entry.oauth).toBeUndefined();
  });

  it('round-trips an entry through the form', () => {
    const entry = {
      name: 'notion',
      transport: 'http',
      url: 'https://x/mcp',
      headers: {},
      auth: 'oauth',
      oauth: { clientId: 'id-1', clientSecret: 'secret:k', scopes: ['a', 'b'] },
      enabled: true,
      timeoutMs: 1,
      startupTimeoutMs: 1000,
      disabledTools: [],
      protocol: 'auto',
    } as Parameters<typeof formFromEntry>[0];
    expect(buildEntry(formFromEntry(entry), 'save').entry.oauth).toEqual(
      entry.transport === 'http' ? entry.oauth : {},
    );
  });
});

describe('Settings: the CIMD document', () => {
  const settingsWith = (cimdUrl?: string): Settings => ({
    ...defaultConfig().settings,
    ...(cimdUrl ? { cimdUrl } : {}),
  });

  it('is disabled until a CIMD URL is saved, then shows the document with a copy button', async () => {
    const url = 'https://example.org/mcpier/client.json';
    fakeApi({
      'GET /api/status': status(),
      'GET /api/settings': { settings: settingsWith(url) },
      'GET /api/auth/cimd-document': {
        url,
        redirectUri: 'http://127.0.0.1:47800/oauth/callback',
        document: {
          client_id: url,
          client_name: 'MCPier',
          redirect_uris: ['http://127.0.0.1:47800/oauth/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          application_type: 'native',
        },
      },
    });
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: 'Show CIMD document' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('cimd-json')).toHaveTextContent('"client_name": "MCPier"');
    expect(dialog).toHaveTextContent(`Publish at ${url}`);
    expect(within(dialog).getByRole('button', { name: 'Copy the CIMD document' })).toBeInTheDocument();
  });

  it('without a CIMD URL the action is disabled', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/settings': { settings: settingsWith() } });
    renderApp('/settings');
    expect(await screen.findByRole('button', { name: 'Show CIMD document' })).toBeDisabled();
  });
});
