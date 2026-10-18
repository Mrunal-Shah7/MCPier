// Sprint 7, Phase 5: OAuth scopes in the dashboard: the chips input with its checks, and the
// Authorization card's next-sign-in scopes with their source and the "Sign in again" hint.
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuthStatus, ServerDetailResponse } from '@mcpier/shared';
import { SCOPE_MAX_COUNT } from '@mcpier/shared';
import { ScopeInput } from '@/components/scope-input';
import { fakeApi, renderApp, server, status } from './helpers';

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="scopes">Scopes</label>
      <ScopeInput id="scopes" value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

const value = () => screen.getByTestId('value').textContent;
const chips = () =>
  screen
    .queryAllByRole('button', { name: /^Remove scope / })
    .map((button) => button.getAttribute('aria-label')!.slice(13));

describe('scopes input', () => {
  it('Enter, space and comma turn what was typed into chips; leaving the field keeps the last one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Scopes');
    await user.type(input, 'read{Enter}write files:read,');
    await user.type(input, 'mcp:tools');
    await user.tab();
    expect(chips()).toEqual(['read', 'write', 'files:read', 'mcp:tools']);
    expect(value()).toBe('read write files:read mcp:tools');
    expect(input).toHaveValue('');
  });

  it('a pasted list is split; a scope already there is not added twice', async () => {
    const user = userEvent.setup();
    render(<Harness initial="read" />);
    await user.click(screen.getByLabelText('Scopes'));
    await user.paste('read write, admin');
    expect(chips()).toEqual(['read', 'write', 'admin']);
  });

  it('refuses a scope with a quote or a backslash, or longer than 128 characters, and says why', async () => {
    const user = userEvent.setup();
    render(<Harness initial="read" />);
    const input = screen.getByLabelText('Scopes');
    for (const bad of ['say"hi', 'back\\slash', 'x'.repeat(129)]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByRole('alert')).toHaveTextContent(bad.length > 100 ? /^"x+"/ : bad);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(chips()).toEqual(['read']);
    }
    // Typing again clears the problem; a valid scope is accepted, including URL-like ones.
    await user.clear(input);
    await user.type(input, 'https://graph.example.com/Files.Read{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chips()).toEqual(['read', 'https://graph.example.com/Files.Read']);
    fireEvent.change(input, { target: { value: 'x'.repeat(128) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(chips()).toHaveLength(3);
  });

  it(`at most ${SCOPE_MAX_COUNT} scopes`, () => {
    const many = Array.from({ length: SCOPE_MAX_COUNT }, (_, index) => `s${index}`).join(' ');
    render(<Harness initial={many} />);
    const input = screen.getByLabelText('Scopes');
    fireEvent.change(input, { target: { value: 'one-more' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent(`At most ${SCOPE_MAX_COUNT} scopes.`);
    expect(chips()).toHaveLength(SCOPE_MAX_COUNT);
  });

  it('a chip is removed with its button, or the last one with Backspace in the empty field', async () => {
    const user = userEvent.setup();
    render(<Harness initial="read write admin" />);
    await user.click(screen.getByRole('button', { name: 'Remove scope write' }));
    expect(chips()).toEqual(['read', 'admin']);
    await user.click(screen.getByLabelText('Scopes'));
    await user.keyboard('{Backspace}');
    expect(chips()).toEqual(['read']);
    expect(value()).toBe('read');
  });
});

function detail(): ServerDetailResponse {
  return {
    server: server({ name: 'notion', transport: 'http' }),
    config: {
      name: 'notion',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: {},
      auth: 'oauth',
      oauth: { scopes: ['read', 'write'] },
      enabled: true,
      timeoutMs: 60000,
      startupTimeoutMs: 90000,
      disabledTools: [],
      protocol: 'auto',
    } as ServerDetailResponse['config'],
    tools: [],
  };
}

function auth(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    server: 'notion',
    signedIn: true,
    issuer: 'https://auth.example.com',
    registration: {
      method: 'cimd',
      clientId: 'https://example.org/client.json',
      redirectUri: 'http://127.0.0.1:47800/oauth/callback',
    },
    grantedScopes: ['read', 'offline_access'],
    hasRefreshToken: true,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    nextScopes: { scopes: ['read', 'write', 'offline_access'], source: 'configured' },
    ...overrides,
  };
}

function open(status_: AuthStatus) {
  fakeApi({
    'GET /api/status': status(),
    'GET /api/servers': { servers: [detail().server] },
    'GET /api/servers/notion': detail(),
    'GET /api/servers/notion/auth': { status: status_ },
  });
  renderApp('/servers/notion');
  return screen.findByRole('region', { name: 'Authorization' });
}

describe('Authorization card: scopes', () => {
  it('shows the client method, granted scopes, and the next sign-in scopes with their source', async () => {
    const card = await open(auth());
    expect(card).toHaveTextContent('Client ID metadata document');
    const next = within(card).getByTestId('next-scopes');
    expect([...next.querySelectorAll('span.font-mono')].map((chip) => chip.textContent)).toEqual([
      'read',
      'write',
      'offline_access',
    ]);
    expect(next).toHaveTextContent('Scopes: configured');
    expect(within(card).queryByTestId('scopes-changed')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Sign in again' }).className).not.toContain('bg-primary');
  });

  it.each([
    ['challenge', "Scopes: the server's challenge"],
    ['server_metadata', 'Scopes: server metadata'],
  ] as const)('source %s is named', async (source, text) => {
    const card = await open(auth({ nextScopes: { scopes: ['mcp:tools'], source } }));
    expect(within(card).getByTestId('next-scopes')).toHaveTextContent(text);
  });

  it('before discovery: decided at sign-in, with no scopes listed', async () => {
    const card = await open(
      auth({
        signedIn: false,
        reason: 'sign_in_required',
        grantedScopes: [],
        nextScopes: { scopes: [], source: 'decided_at_sign_in' },
      }),
    );
    const next = within(card).getByTestId('next-scopes');
    expect(next).toHaveTextContent('Scopes: decided at sign-in');
    expect(next.querySelectorAll('span.font-mono')).toHaveLength(0);
  });

  it('changed scopes: "Sign in again to use the new scopes", with Sign in again as the main action', async () => {
    const card = await open(auth({ scopesChanged: true }));
    expect(within(card).getByTestId('scopes-changed')).toHaveTextContent(
      'Sign in again to use the new scopes. The current sign-in keeps working until then.',
    );
    expect(within(card).getByRole('button', { name: 'Sign in again' }).className).toContain('bg-primary');
    // The current sign-in still shows as signed in.
    expect(within(card).getByText('Signed in')).toBeInTheDocument();
  });
});
