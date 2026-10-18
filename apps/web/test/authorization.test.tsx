// Sprint 5, Phase 4: the Authorization section of an OAuth server (each state, the waiting
// state, each action, the Forget confirmation), Sign in from the Servers row menu, the OAuth
// client group in Add server and Edit, the discovery result, and the CIMD document.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatus, ServerDetailResponse } from '@mcpier/shared';
import { fakeApi, renderApp, server, status } from './helpers';

const AUTH_URL = 'https://auth.example.com/authorize?client_id=dyn-1&state=opaque-state&code_challenge=x';

function oauthDetail(state: 'ready' | 'needs_auth' = 'ready', detail?: string): ServerDetailResponse {
  return {
    server: server({
      name: 'notion',
      transport: 'http',
      status: { state, since: '2026-10-16T08:00:00.000Z', ...(detail ? { detail } : {}) },
    }),
    config: {
      name: 'notion',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: {},
      auth: 'oauth',
      enabled: true,
      timeoutMs: 60000,
      startupTimeoutMs: 90000,
      disabledTools: [],
      protocol: 'auto',
    } as ServerDetailResponse['config'],
    tools: [],
  };
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

function signedIn(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    server: 'notion',
    signedIn: true,
    issuer: 'https://auth.example.com',
    registration: {
      method: 'dynamic',
      clientId: 'dyn-1',
      redirectUri: 'http://127.0.0.1:47800/oauth/callback',
    },
    grantedScopes: ['read', 'offline_access'],
    accessTokenExpiresAt: inAnHour(),
    hasRefreshToken: true,
    lastRefreshAt: new Date(Date.now() - 120_000).toISOString(),
    signedInAt: '2026-10-16T07:00:00.000Z',
    ...overrides,
  };
}

function notSignedIn(reason: AuthStatus['reason'], overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    server: 'notion',
    signedIn: false,
    reason,
    message: `Reason text for ${reason}. Sign in on the server page in the MCPier dashboard, or with: mcpier auth login notion`,
    grantedScopes: [],
    hasRefreshToken: false,
    ...overrides,
  };
}

function routes(auth: AuthStatus, extra: Record<string, unknown> = {}) {
  return {
    'GET /api/status': status(),
    'GET /api/servers': { servers: [oauthDetail().server] },
    'GET /api/servers/notion': oauthDetail(
      auth.signedIn ? 'ready' : 'needs_auth',
      auth.signedIn ? undefined : 'x',
    ),
    'GET /api/servers/notion/auth': { status: auth },
    ...extra,
  };
}

async function section() {
  return screen.findByRole('region', { name: 'Authorization' });
}

/** A fake new tab: `window.open` returns it; the dashboard points it at the authorization URL. */
function stubTab() {
  const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  return { tab, open };
}

describe('Authorization section: states', () => {
  it('signed in: issuer, registration, scopes, expiry, last refresh, and every action', async () => {
    fakeApi(routes(signedIn()));
    renderApp('/servers/notion');
    const part = await section();
    expect(within(part).getByText('Signed in')).toBeInTheDocument();
    expect(part).toHaveTextContent('https://auth.example.com');
    expect(part).toHaveTextContent('Dynamic registration');
    expect(part).toHaveTextContent('dyn-1');
    // Sprint 7: granted scopes are chips.
    expect(within(part).getByText('offline_access')).toBeInTheDocument();
    expect(within(part).getAllByText('read').length).toBeGreaterThan(0);
    expect(part).toHaveTextContent(/Token expires\s*in (59m|1h)/);
    expect(part).toHaveTextContent('renewed automatically');
    expect(part).toHaveTextContent(/Last refresh\s*2m \d+s ago/);
    for (const name of ['Sign in again', 'Refresh now', 'Sign out', 'Forget registration…']) {
      expect(within(part).getByRole('button', { name })).toBeEnabled();
    }
  });

  it('sign-in required: the reason and a Sign in button only', async () => {
    fakeApi(routes(notSignedIn('sign_in_required')));
    renderApp('/servers/notion');
    const part = await section();
    expect(within(part).getByText('Sign-in required')).toBeInTheDocument();
    expect(part).toHaveTextContent('mcpier auth login notion');
    expect(within(part).getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(within(part).queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(within(part).queryByRole('button', { name: 'Refresh now' })).toBeNull();
    expect(part).toHaveTextContent('Not registered yet');
  });

  it('sign-in expired: labelled, with Sign in again', async () => {
    fakeApi(
      routes(notSignedIn('sign_in_expired', { registration: { method: 'dynamic', clientId: 'dyn-1' } })),
    );
    renderApp('/servers/notion');
    const part = await section();
    expect(within(part).getByText('Sign-in expired')).toBeInTheDocument();
    expect(within(part).getByRole('button', { name: 'Sign in again' })).toBeEnabled();
    expect(within(part).getByRole('button', { name: 'Forget registration…' })).toBeEnabled();
  });

  it('more permissions needed: names the scopes the server asked for', async () => {
    fakeApi(
      routes(
        notSignedIn('more_permissions', {
          requestedScopes: ['read', 'write:admin'],
          grantedScopes: ['read'],
          hasRefreshToken: true,
          registration: { method: 'dynamic', clientId: 'dyn-1' },
        }),
      ),
    );
    renderApp('/servers/notion');
    const part = await section();
    expect(within(part).getByText('More permissions needed')).toBeInTheDocument();
    expect(within(part).getByTestId('step-up-scopes')).toHaveTextContent(
      'The server asked for: read write:admin',
    );
    expect(within(part).getByRole('button', { name: 'Sign in again' })).toBeEnabled();
    expect(within(part).getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });

  it('needs a client ID: labelled, with the explanation', async () => {
    fakeApi(routes(notSignedIn('needs_client_id')));
    renderApp('/servers/notion');
    const part = await section();
    expect(within(part).getByText('Needs a client ID')).toBeInTheDocument();
    expect(part).toHaveTextContent('Reason text for needs_client_id');
  });

  it('is not shown for a server without OAuth', async () => {
    const detail = oauthDetail();
    (detail.config as { auth: string }).auth = 'none';
    fakeApi({ ...routes(signedIn()), 'GET /api/servers/notion': detail });
    renderApp('/servers/notion');
    // Sprint 7: the overview's Connection panel shows the page has loaded.
    expect(await screen.findByRole('region', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Authorization' })).toBeNull();
  });
});

describe('Authorization section: signing in', () => {
  it('Sign in starts the sign-in, opens the page in a new tab, waits, and finishes on the event', async () => {
    const { calls } = fakeApi(
      routes(notSignedIn('sign_in_required'), {
        'POST /api/servers/notion/auth/login': {
          authorizationUrl: AUTH_URL,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          issuer: 'https://auth.example.com',
          registrationMethod: 'dynamic',
          scopes: ['read'],
          warnings: [],
        },
      }),
    );
    const { tab, open } = stubTab();
    const user = userEvent.setup();
    const { events } = renderApp('/servers/notion');
    const part = await section();
    await user.click(within(part).getByRole('button', { name: 'Sign in' }));

    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(AUTH_URL));
    expect(
      calls.some((call) => call.method === 'POST' && call.path === '/api/servers/notion/auth/login'),
    ).toBe(true);
    expect(await within(part).findByText(/Waiting for sign-in…/)).toBeInTheDocument();
    expect(within(part).getByRole('button', { name: 'Sign in' })).toBeDisabled();

    act(() =>
      events.emit({
        type: 'auth_status',
        data: { ...notSignedIn('sign_in_required'), pending: { expiresAt: inAnHour() } },
      }),
    );
    act(() => events.emit({ type: 'auth_status', data: signedIn({ signedInAt: new Date().toISOString() }) }));
    await waitFor(() => expect(within(part).queryByText(/Waiting for sign-in…/)).toBeNull());
    expect(within(part).getByText('Signed in')).toBeInTheDocument();
    expect(await screen.findByText('Signed in to notion.')).toBeInTheDocument();
  });

  it('a sign-in that comes back without success stops waiting and says so', async () => {
    fakeApi(
      routes(notSignedIn('sign_in_required'), {
        'POST /api/servers/notion/auth/login': {
          authorizationUrl: AUTH_URL,
          expiresAt: inAnHour(),
          issuer: 'x',
          registrationMethod: 'dynamic',
          scopes: [],
          warnings: [],
        },
      }),
    );
    stubTab();
    const user = userEvent.setup();
    const { events } = renderApp('/servers/notion');
    const part = await section();
    await user.click(within(part).getByRole('button', { name: 'Sign in' }));
    await within(part).findByText(/Waiting for sign-in…/);
    act(() =>
      events.emit({
        type: 'auth_status',
        data: { ...notSignedIn('sign_in_required'), pending: { expiresAt: 'x' } },
      }),
    );
    expect(await within(part).findByText(/Sign-in waiting|Waiting for sign-in…/)).toBeInTheDocument();
    act(() => events.emit({ type: 'auth_status', data: notSignedIn('sign_in_required') }));
    await waitFor(() => expect(within(part).queryByText(/Waiting for sign-in…/)).toBeNull());
    expect(await screen.findByText('The sign-in to notion did not finish')).toBeInTheDocument();
    expect(within(part).queryByText(/Waiting for sign-in…/)).toBeNull();
  });

  it('waiting can be cancelled; a blocked tab gets a link instead', async () => {
    fakeApi(
      routes(notSignedIn('sign_in_required'), {
        'POST /api/servers/notion/auth/login': {
          authorizationUrl: AUTH_URL,
          expiresAt: inAnHour(),
          issuer: 'x',
          registrationMethod: 'dynamic',
          scopes: [],
          warnings: ['The redirect URI changed.'],
        },
      }),
    );
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    renderApp('/servers/notion');
    const part = await section();
    await user.click(within(part).getByRole('button', { name: 'Sign in' }));
    const link = await within(part).findByRole('link', { name: /open the sign-in page/ });
    expect(link).toHaveAttribute('href', AUTH_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await screen.findByText('The redirect URI changed.')).toBeInTheDocument();
    await user.click(within(part).getByRole('button', { name: 'Stop waiting' }));
    expect(within(part).queryByText(/Waiting for sign-in…/)).toBeNull();
    expect(within(part).getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('a sign-in that cannot start closes the tab and shows why', async () => {
    fakeApi(
      routes(notSignedIn('sign_in_required'), {
        'POST /api/servers/notion/auth/login': () => ({
          status: 409,
          body: { error: { code: 'conflict', message: 'No client ID is configured.' } },
        }),
      }),
    );
    const { tab } = stubTab();
    const user = userEvent.setup();
    renderApp('/servers/notion');
    await user.click(within(await section()).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Could not start the sign-in to notion')).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
});

describe('Authorization section: actions', () => {
  it('Refresh now and Sign out call their routes and show the answer', async () => {
    const { calls } = fakeApi(
      routes(signedIn(), {
        'POST /api/servers/notion/auth/refresh': {
          status: signedIn({ lastRefreshAt: new Date().toISOString() }),
        },
        'POST /api/servers/notion/auth/logout': { status: notSignedIn('sign_in_required') },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/notion');
    const part = await section();
    await user.click(within(part).getByRole('button', { name: 'Refresh now' }));
    expect(await screen.findByText('Refreshed the sign-in to notion.')).toBeInTheDocument();
    await user.click(within(part).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signed out of notion.')).toBeInTheDocument();
    expect(await within(part).findByText('Sign-in required')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
      '/api/servers/notion/auth/refresh',
      '/api/servers/notion/auth/logout',
    ]);
  });

  it('Forget registration asks first, explaining the next sign-in registers again', async () => {
    const { calls } = fakeApi(
      routes(signedIn(), {
        'POST /api/servers/notion/auth/forget': { status: notSignedIn('sign_in_required') },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/notion');
    const part = await section();
    await user.click(within(part).getByRole('button', { name: 'Forget registration…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The next sign-in registers MCPier again.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.path.endsWith('/auth/forget'))).toBe(false);

    await user.click(within(part).getByRole('button', { name: 'Forget registration…' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Forget registration' }),
    );
    await waitFor(() =>
      expect(calls.some((call) => call.path === '/api/servers/notion/auth/forget')).toBe(true),
    );
    expect(await screen.findByText('Signed out of notion and forgot its registration.')).toBeInTheDocument();
  });

  it('a manual client offers no Forget registration', async () => {
    fakeApi(routes(signedIn({ registration: { method: 'manual', clientId: 'from-console' } })));
    renderApp('/servers/notion');
    const part = await section();
    expect(part).toHaveTextContent('Manual client ID');
    expect(within(part).queryByRole('button', { name: 'Forget registration…' })).toBeNull();
  });
});

describe('Servers page: Sign in in the row menu', () => {
  it('a needs_auth server offers Sign in, which starts the sign-in in a new tab', async () => {
    const { calls } = fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': {
        servers: [
          server({
            name: 'notion',
            transport: 'http',
            status: { state: 'needs_auth', detail: 'Sign in required', since: 'x' },
          }),
        ],
      },
      'POST /api/servers/notion/auth/login': {
        authorizationUrl: AUTH_URL,
        expiresAt: inAnHour(),
        issuer: 'x',
        registrationMethod: 'dynamic',
        scopes: [],
        warnings: [],
      },
    });
    const { tab } = stubTab();
    const user = userEvent.setup();
    renderApp('/servers');
    await user.click(await screen.findByRole('button', { name: 'Actions for notion' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign in…' }));
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(AUTH_URL));
    expect(calls.some((call) => call.path === '/api/servers/notion/auth/login')).toBe(true);
  });

  it('a ready server has no Sign in item', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/servers': { servers: [server()] } });
    const user = userEvent.setup();
    renderApp('/servers');
    await user.click(await screen.findByRole('button', { name: 'Actions for files' }));
    expect(await screen.findByRole('menuitem', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Sign in…' })).toBeNull();
  });
});
