// Sprint 7, Phase 5: a server's Activity tab: its calls (filtered, live, detail, load more, the
// link to the Call log), its output (pause, follow), the rail, and the old Logs URL.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CallListItem, ServerDetailResponse, UsageResponse } from '@mcpier/shared';
import { currentLocation, fakeApi, renderApp, server, status } from './helpers';

const NOW = Date.now();

function call(id: number, overrides: Partial<CallListItem> = {}): CallListItem {
  return {
    id,
    at: new Date(NOW - (100 - id) * 1000).toISOString(),
    client: { name: 'agent', version: '1.0' },
    era: 'modern',
    tool: 'files__read_file',
    server: 'files',
    durationMs: 12,
    outcome: 'ok',
    bodiesStored: true,
    ...overrides,
  };
}

function detail(): ServerDetailResponse {
  return {
    server: server(),
    config: {
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
      enabled: true,
      timeoutMs: 60000,
      startupTimeoutMs: 90000,
      disabledTools: [],
      protocol: 'auto',
    } as ServerDetailResponse['config'],
    tools: [],
  };
}

const usage = {
  from: '',
  to: '',
  bucket: 'hour',
  timeZone: 'UTC',
  clipped: false,
  retentionDays: 30,
  totals: {
    calls: 7,
    errors: 1,
    errorRate: 1 / 7,
    tokens: 2400,
    avgTokensPerCall: 343,
    p95TokensPerCall: 900,
    p50Ms: 40,
    p95Ms: 1400,
    callsWithoutSize: 0,
    searchTokens: 0,
    searches: 0,
  },
  previous: {} as UsageResponse['previous'],
  series: [],
  byServer: [],
  heaviestTools: [],
  byClient: [],
} as unknown as UsageResponse;

/** A log stream the test writes to. */
function controlledStream() {
  let push: (text: string) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (text) => controller.enqueue(encoder.encode(text));
    },
  });
  return { stream, line: (text: string) => push(`event: line\ndata: ${text}\n\n`) };
}

function setup(extra: Record<string, unknown> = {}) {
  const log = controlledStream();
  const api = fakeApi({
    'GET /api/status': status(),
    'GET /api/servers': { servers: [server()] },
    'GET /api/servers/files': detail(),
    'GET /api/servers/files/logs?lines=200': { server: 'files', lines: ['old line'] },
    'GET /api/usage': usage,
    'GET /api/calls': (request: { path: string }) => {
      const params = new URL(request.path, 'http://x').searchParams;
      return {
        body: params.get('cursor')
          ? { calls: [call(1, { tool: 'files__list' })] }
          : { calls: [call(3), call(2, { outcome: 'tool_error' })], nextCursor: 'c-2' },
      };
    },
    'GET /api/calls/2': { ...call(2, { outcome: 'tool_error' }), errorText: 'boom', errorMessage: 'boom' },
    ...extra,
  });
  const real = api.fetchMock.getMockImplementation()!;
  api.fetchMock.mockImplementation(async (input, init) =>
    String(input).endsWith('/logs/stream')
      ? new Response(log.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : real(input, init),
  );
  return { ...api, log };
}

const callsOf = (calls: { method: string; path: string }[]) =>
  calls.filter((request) => request.method === 'GET' && request.path.startsWith('/api/calls?'));

describe('Activity tab: calls', () => {
  it("lists this server's calls, newest first, with a link to the filtered Call log", async () => {
    const { calls } = setup();
    renderApp('/servers/files?tab=activity');
    const table = await screen.findByRole('table', { name: 'Server calls' });
    expect(callsOf(calls)[0]!.path).toBe('/api/calls?server=files&limit=25');
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.getAttribute('data-call')),
    ).toEqual(['3', '2']);
    expect(screen.getByRole('link', { name: 'Open in Call log →' })).toHaveAttribute(
      'href',
      '/calls?server=files',
    );
  });

  it("a recorded call of this server appears at the top, live; another server's does not", async () => {
    const { calls } = setup();
    const { events } = renderApp('/servers/files?tab=activity');
    const table = await screen.findByRole('table', { name: 'Server calls' });
    const fetched = callsOf(calls).length;
    act(() => events.emit({ type: 'call_recorded', data: call(9, { tool: 'files__write_file' }) }));
    act(() =>
      events.emit({ type: 'call_recorded', data: call(10, { server: 'notes', tool: 'notes__echo' }) }),
    );
    // The same call twice is shown once.
    act(() => events.emit({ type: 'call_recorded', data: call(9, { tool: 'files__write_file' }) }));
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole('row')
          .slice(1)
          .map((row) => row.getAttribute('data-call')),
      ).toEqual(['9', '3', '2']),
    );
    expect(callsOf(calls)).toHaveLength(fetched);
  });

  it("a row opens the Call log's detail panel, kept in the URL", async () => {
    setup();
    const user = userEvent.setup();
    renderApp('/servers/files?tab=activity');
    await user.click(await screen.findByRole('button', { name: 'Details of call 2 (files__read_file)' }));
    await waitFor(() => expect(currentLocation()).toBe('/servers/files?tab=activity&call=2'));
    const panel = await screen.findByRole('region', { name: 'Call detail' });
    expect(await within(panel).findByText('boom')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(currentLocation()).toBe('/servers/files?tab=activity'));
  });

  it('Load more fetches the next page with the cursor and appends it', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    renderApp('/servers/files?tab=activity');
    const table = await screen.findByRole('table', { name: 'Server calls' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(callsOf(calls).at(-1)!.path).toBe('/api/calls?server=files&limit=25&cursor=c-2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('the rail: calls and errors, tokens, and median and 95th-percentile duration', async () => {
    const { calls } = setup();
    renderApp('/servers/files?tab=activity');
    const rail = (await screen.findByText('Calls · 24 h')).closest('section')!;
    await waitFor(() => expect(rail).toHaveTextContent('1 error'));
    expect(rail).toHaveTextContent('7');
    const errors = screen.getByText('Errors · 24 h').closest('section')!;
    expect(errors).toHaveTextContent('14.3% of calls');
    expect(within(errors).getByRole('img', { name: /^Errors per hour, last 24 hours/ })).toBeInTheDocument();
    expect(screen.getByText('Est. tokens · 24 h').closest('section')).toHaveTextContent('2.4k');
    expect(screen.getByText('Median duration').closest('section')).toHaveTextContent(/40 ms.*p95 1.40 s/);
    expect(calls.some((request) => request.path === '/api/usage?range=24h&server=files')).toBe(true);
  });

  it('the old Logs URL opens the Activity tab', async () => {
    setup();
    renderApp('/servers/files?tab=logs');
    await screen.findByRole('table', { name: 'Server calls' });
    expect(currentLocation()).toBe('/servers/files?tab=activity');
  });
});

describe('Activity tab: server output', () => {
  it('shows the last lines, then live ones; Pause holds new lines until Resume', async () => {
    const { log } = setup();
    const user = userEvent.setup();
    renderApp('/servers/files?tab=activity');
    const output = await screen.findByLabelText('files log');
    await waitFor(() => expect(output).toHaveTextContent('old line'));
    act(() => log.line('live one'));
    await waitFor(() => expect(output).toHaveTextContent('live one'));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Paused: new lines are held.')).toBeInTheDocument();
    act(() => log.line('held two'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).not.toHaveTextContent('held two');
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(output).toHaveTextContent('held two'));
    expect(
      within(screen.getByRole('region', { name: 'Server output' })).getByRole('status'),
    ).toHaveTextContent('Live');
  });

  it('Follow is on by default, can be turned off, and scrolling up turns it off', async () => {
    setup();
    const user = userEvent.setup();
    renderApp('/servers/files?tab=activity');
    const output = await screen.findByLabelText('files log');
    const follow = screen.getByRole('button', { name: 'Follow' });
    expect(follow).toHaveAttribute('aria-pressed', 'true');
    await user.click(follow);
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    await user.click(follow);
    expect(follow).toHaveAttribute('aria-pressed', 'true');
    Object.defineProperties(output, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    output.scrollTop = 100;
    act(() => output.dispatchEvent(new Event('scroll')));
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Copy the files log' })).toBeInTheDocument();
  });
});
