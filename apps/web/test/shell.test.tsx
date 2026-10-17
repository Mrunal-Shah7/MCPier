// Phase 3: the auth gate, error handling, status badge, config-problem banner, and live
// events updating what is shown.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SERVER_STATUSES } from '@mcpier/shared';
import { ApiError, errorFromResponse, request } from '@/lib/api';
import { ErrorMessage } from '@/components/common';
import { STATUS_STYLES, StatusBadge } from '@/components/status-badge';
import { fakeApi, FakeEvents, renderApp, server, status } from './helpers';

describe('auth gate', () => {
  it('signed out: only the not-signed-in page, and no request after /api/status', async () => {
    const { calls } = fakeApi({
      'GET /api/status': () => ({
        status: 401,
        body: { error: { code: 'unauthorized', message: 'Missing or invalid admin token.' } },
      }),
    });
    const { events, container } = renderApp('/servers');
    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument();
    expect(screen.getByText('mcpier open')).toBeInTheDocument();
    // Give anything else a chance to fire, then check nothing did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/status']);
    expect(events.started).toBe(0);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.textContent).not.toMatch(/servers enabled|Port/);
  });

  it('signed in: the layout, the page, and one live connection', async () => {
    const { calls } = fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
    });
    const { events } = renderApp('/servers');
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(await screen.findByText('files')).toBeInTheDocument();
    expect(events.started).toBe(1);
    // Every request names the dashboard as its client and never sends a token.
    for (const call of calls) {
      expect(call.headers['x-mcpier-client']).toBe('dashboard');
      expect(call.headers.authorization).toBeUndefined();
    }
  });

  it('a 401 later (cookie gone) switches to the not-signed-in page', async () => {
    let signedIn = true;
    fakeApi({
      'GET /api/status': () =>
        signedIn
          ? { body: status() }
          : { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } },
      'GET /api/servers': () =>
        signedIn
          ? { body: { servers: [server()] } }
          : { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } },
      'POST /api/servers/files/stop': () => ({
        status: 401,
        body: { error: { code: 'unauthorized', message: 'no' } },
      }),
    });
    renderApp('/servers');
    await screen.findByText('files');
    signedIn = false;
    await act(async () => {
      await request('POST', '/api/servers/files/stop').catch(() => {});
    });
    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument();
  });

  it('a gateway that cannot be reached shows a readable error', async () => {
    fakeApi({
      'GET /api/status': () => ({
        status: 500,
        body: {
          error: { code: 'internal_error', message: 'Internal error. See the gateway log for details.' },
        },
      }),
    });
    renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Internal error. See the gateway log for details.',
    );
  });
});

describe('error shape', () => {
  it('turns { error: { code, message, problems } } into a readable error', async () => {
    const error = await errorFromResponse(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_request',
            message: 'The server entry is invalid.',
            problems: ['name: must be a lowercase slug', 'command: required'],
          },
        }),
        { status: 400 },
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'The server entry is invalid.',
    });
    expect(error.problems).toEqual(['name: must be a lowercase slug', 'command: required']);
    render(<ErrorMessage error={error} title="Could not save" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not save');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['name: must be a lowercase slug', 'command: required']);
  });

  it('a body that is not the standard shape still reads well', async () => {
    const error = await errorFromResponse(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(error.message).toBe('MCPier answered HTTP 502.');
    expect(error.problems).toEqual([]);
  });

  it('a network failure says the gateway cannot be reached', async () => {
    const { fetchMock } = fakeApi({});
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(request('GET', '/api/status')).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('Cannot reach'),
    });
  });
});

describe('status badge', () => {
  it.each(SERVER_STATUSES.map((state) => [state]))('%s has its own label and colour', (state) => {
    render(<StatusBadge state={state} />);
    const badge = screen.getByText(STATUS_STYLES[state].label).closest('[data-status]')!;
    expect(badge).toHaveAttribute('data-status', state);
    expect(badge.className).toContain(STATUS_STYLES[state].className.split(' ')[0]);
  });

  it('labels and colours are all different', () => {
    const styles = Object.values(STATUS_STYLES);
    expect(new Set(styles.map((style) => style.label)).size).toBe(SERVER_STATUSES.length);
    expect(new Set(styles.map((style) => style.className.split(' ')[0])).size).toBe(SERVER_STATUSES.length);
    expect(STATUS_STYLES.needs_auth.label).toBe('Needs sign-in');
  });
});

describe('config problem banner', () => {
  it('shows on every page while the problem exists, and goes when it clears', async () => {
    const problem = {
      file: 'C:\\x\\config.json',
      problems: ['servers[0].name: must be a lowercase slug'],
      since: '2026-10-16T08:00:00.000Z',
    };
    fakeApi({
      'GET /api/status': status({ configProblem: problem }),
      'GET /api/servers': { servers: [] },
      'GET /api/secrets': { secrets: [], missing: [] },
    });
    const { events } = renderApp('/servers');
    const banner = await screen.findByRole('alert', { name: 'Config problem' });
    expect(banner).toHaveTextContent('servers[0].name: must be a lowercase slug');
    expect(banner).toHaveTextContent(/paused until/);
    act(() => events.emit({ type: 'config_problem', data: { problem: null } }));
    await waitFor(() => expect(screen.queryByRole('alert', { name: 'Config problem' })).toBeNull());
    act(() => events.emit({ type: 'config_problem', data: { problem } }));
    expect(await screen.findByRole('alert', { name: 'Config problem' })).toBeInTheDocument();
  });
});

describe('live updates', () => {
  it('a status event changes the page without a re-fetch', async () => {
    const { calls } = fakeApi({
      'GET /api/status': status(),
      'GET /api/servers': { servers: [server()] },
    });
    const events = new FakeEvents();
    renderApp('/servers', events);
    const row = (await screen.findByText('files')).closest('tr')!;
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    const serverFetches = () => calls.filter((call) => call.path === '/api/servers').length;
    const before = serverFetches();
    act(() =>
      events.emit({
        type: 'server_status',
        data: {
          name: 'files',
          status: { state: 'crashed', detail: 'exited with code 1', since: '2026-10-16T08:01:00.000Z' },
        },
      }),
    );
    expect(await within(row).findByText('Crashed')).toBeInTheDocument();
    expect(within(row).getByText('exited with code 1')).toBeInTheDocument();
    expect(serverFetches()).toBe(before);
  });

  it('a tool-count event updates the counts in place', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/servers': { servers: [server()] } });
    const events = new FakeEvents();
    renderApp('/servers', events);
    const row = (await screen.findByText('files')).closest('tr')!;
    expect(row).toHaveTextContent('14/14');
    act(() =>
      events.emit({ type: 'server_tools', data: { name: 'files', tools: { total: 14, enabled: 13 } } }),
    );
    await waitFor(() => expect(row).toHaveTextContent('13/14'));
  });

  it('the connection indicator follows the stream, and a reconnect re-fetches', async () => {
    const { calls } = fakeApi({ 'GET /api/status': status(), 'GET /api/servers': { servers: [server()] } });
    const events = new FakeEvents();
    renderApp('/servers', events);
    await screen.findByText('files');
    expect(screen.getByRole('status', { name: /Live updates: Live/ })).toBeInTheDocument();
    act(() => events.setState('reconnecting'));
    expect(screen.getByRole('status', { name: /Reconnecting/ })).toBeInTheDocument();
    const before = calls.length;
    act(() => events.reconnect());
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(screen.getByRole('status', { name: /Live updates: Live/ })).toBeInTheDocument();
  });
});
