// Sprint 6, Phase 3: the Call log page: filters in the URL, pages, live calls, the detail
// panel, stats, the Search tab and Clear log.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CallDetail,
  CallListItem,
  CallStatsResponse,
  SearchListResponse,
  SearchSummary,
} from '@mcpier/shared';
import { currentLocation, fakeApi, renderApp, server, status, type FakeCall } from './helpers';

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

function stats(overrides: Partial<CallStatsResponse> = {}): CallStatsResponse {
  return {
    calls: {
      total: 12,
      errors: 3,
      errorRate: 0.25,
      p50Ms: 40,
      p95Ms: 900,
      byOutcome: { ok: 9, failed: 3 },
      byServer: [{ server: 'files', calls: 12, errors: 3, p50Ms: 40, p95Ms: 900 }],
    },
    searches: { total: 4, hits: 2, misses: 1, none: 1, pending: 0, hitRate: 2 / 3 },
    recentMisses: [
      {
        searchId: 7,
        at: new Date(NOW).toISOString(),
        query: 'open an issue',
        results: ['files__read_file'],
        calledTool: 'github__create_issue',
      },
    ],
    ...overrides,
  };
}

function search(id: number, overrides: Partial<SearchSummary> = {}): SearchSummary {
  return {
    id,
    at: new Date(NOW - id * 1000).toISOString(),
    client: { name: 'agent', version: '1.0' },
    era: 'modern',
    query: `query ${id}`,
    resultCount: 2,
    results: ['files__read_file', 'files__write_file'],
    durationMs: 2,
    followup: 'none',
    ...overrides,
  };
}

const callsPaths = (calls: FakeCall[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/calls?'));

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/status': status(),
    'GET /api/servers': { servers: [server(), server({ name: 'github' })] },
    'GET /api/calls': { calls: [call(3), call(2), call(1)] },
    'GET /api/calls/stats': stats(),
    'GET /api/searches': { searches: [] } satisfies SearchListResponse,
    ...extra,
  } as Record<string, object>;
}

afterEach(() => {
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
});

describe('Call log: filters', () => {
  it('reads the filters from the URL and sends them to the API', async () => {
    const { calls } = fakeApi(routes());
    renderApp('/calls?range=7d&server=files&outcome=failed&tool=read&client=agent');
    await screen.findByRole('table', { name: 'Calls' });
    expect(screen.getByLabelText('Time')).toHaveValue('7d');
    expect(screen.getByLabelText('Server')).toHaveValue('files');
    expect(screen.getByLabelText('Outcome')).toHaveValue('failed');
    expect(screen.getByLabelText('Tool name contains')).toHaveValue('read');
    const sent = new URL(callsPaths(calls).at(-1)!.path, 'http://x').searchParams;
    expect(sent.get('server')).toBe('files');
    expect(sent.get('outcome')).toBe('failed');
    expect(sent.get('tool')).toBe('read');
    expect(sent.get('client')).toBe('agent');
    // 7 days back from about now.
    expect(Math.abs(Date.parse(sent.get('from')!) - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
  });

  it('puts changed filters in the URL, so a view can be bookmarked', async () => {
    const { calls } = fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/calls');
    await screen.findByRole('table', { name: 'Calls' });
    await user.selectOptions(screen.getByLabelText('Outcome'), 'failed');
    await waitFor(() => expect(currentLocation()).toContain('outcome=failed'));
    await user.selectOptions(screen.getByLabelText('Server'), 'github');
    await user.type(screen.getByLabelText('Tool name contains'), 'issue');
    await waitFor(() => expect(currentLocation()).toContain('tool=issue'));
    expect(currentLocation()).toContain('server=github');
    await user.selectOptions(screen.getByLabelText('Time'), 'custom');
    await waitFor(() => expect(currentLocation()).toContain('range=custom'));
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    await waitFor(() => {
      const sent = new URL(callsPaths(calls).at(-1)!.path, 'http://x').searchParams;
      expect(sent.get('tool')).toBe('issue');
      expect(sent.get('server')).toBe('github');
    });
  });
});

describe('Call log: list', () => {
  it('loads more with the cursor', async () => {
    const { calls } = fakeApi(
      routes({
        'GET /api/calls': (request: FakeCall) =>
          request.path.includes('cursor=next1')
            ? { body: { calls: [call(1, { tool: 'files__older' })] } }
            : { body: { calls: [call(3), call(2)], nextCursor: 'next1' } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/calls');
    const table = await screen.findByRole('table', { name: 'Calls' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(table).findByText('files__older')).toBeInTheDocument();
    expect(callsPaths(calls).some((c) => c.path.includes('cursor=next1'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows a new call at once at the top, when it matches the filters', async () => {
    fakeApi(routes());
    const { events } = renderApp('/calls?server=files');
    const table = await screen.findByRole('table', { name: 'Calls' });
    act(() => events.emit({ type: 'call_recorded', data: call(10, { tool: 'files__brand_new' }) }));
    act(() =>
      events.emit({ type: 'call_recorded', data: call(11, { tool: 'github__elsewhere', server: 'github' }) }),
    );
    await within(table).findByText('files__brand_new');
    expect(within(table).queryByText('github__elsewhere')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('files__brand_new');
  });

  it('scrolled down: counts new calls, and shows them on request', async () => {
    fakeApi(routes());
    const { events } = renderApp('/calls');
    const table = await screen.findByRole('table', { name: 'Calls' });
    Object.defineProperty(window, 'scrollY', { value: 600, configurable: true, writable: true });
    fireEvent.scroll(window);
    act(() => {
      events.emit({ type: 'call_recorded', data: call(20, { tool: 'files__first_new' }) });
      events.emit({ type: 'call_recorded', data: call(21, { tool: 'files__second_new' }) });
    });
    const show = await screen.findByRole('button', { name: 'Show 2 new calls' });
    expect(within(table).queryByText('files__first_new')).not.toBeInTheDocument();
    await userEvent.setup().click(show);
    expect(await within(table).findByText('files__second_new')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('files__second_new');
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('files__first_new');
    expect(screen.queryByRole('button', { name: /new call/ })).not.toBeInTheDocument();
  });

  it('empty', async () => {
    fakeApi(routes({ 'GET /api/calls': { calls: [] } }));
    renderApp('/calls');
    expect(await screen.findByText('No calls match these filters')).toBeInTheDocument();
  });
});

describe('Call log: detail', () => {
  const detail = (overrides: Partial<CallDetail> = {}): CallDetail => ({
    ...call(2, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }),
    arguments: { text: '{"path":"notes.txt"}', truncated: false },
    result: { text: '{"content":[{"type":"text","text":"hello"}]}', truncated: false },
    ...overrides,
  });

  it('with bodies: summary, trace id, pretty bodies, links, and Open in Tester', async () => {
    fakeApi(routes({ 'GET /api/calls/2': detail() }));
    const user = userEvent.setup();
    renderApp('/calls');
    await user.click(await screen.findByRole('button', { name: 'Details of call 2 (files__read_file)' }));
    await waitFor(() => expect(currentLocation()).toContain('call=2'));
    const panel = await screen.findByRole('region', { name: 'Call detail' });
    expect(await within(panel).findByText('4bf92f3577b34da6a3ce929d0e0e4736')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Arguments')).toHaveTextContent('"path": "notes.txt"');
    expect(within(panel).getByLabelText('Result')).toHaveTextContent('"text": "hello"');
    expect(within(panel).getByRole('link', { name: 'files' })).toHaveAttribute('href', '/servers/files');
    expect(within(panel).getByRole('link', { name: 'files__read_file' })).toHaveAttribute(
      'href',
      '/servers/files?tab=tools&tool=read_file',
    );
    await user.click(within(panel).getByRole('button', { name: 'Open in Tester' }));
    await waitFor(() => expect(currentLocation()).toBe('/tester?tool=files__read_file'));
  });

  it('without bodies: says so and points to the setting', async () => {
    fakeApi(
      routes({
        'GET /api/calls/2': { ...call(2, { bodiesStored: false, outcome: 'failed', errorText: 'boom' }) },
      }),
    );
    renderApp('/calls?call=2');
    const panel = await screen.findByRole('region', { name: 'Call detail' });
    const note = await within(panel).findByRole('note');
    expect(note).toHaveTextContent('were not stored');
    expect(within(note).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(within(panel).getByText('boom')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Open in Tester' })).not.toBeInTheDocument();
  });

  it('a body cut at 64 KB is marked, and cannot be opened in the Tester', async () => {
    fakeApi(
      routes({
        'GET /api/calls/2': detail({
          arguments: { text: '{"path":"no…[cut by MCPier: 10 of 70000 bytes not stored]', truncated: true },
        }),
      }),
    );
    renderApp('/calls?call=2');
    const panel = await screen.findByRole('region', { name: 'Call detail' });
    expect(await within(panel).findAllByText('Cut at 64 KB when it was stored.')).toHaveLength(1);
    expect(within(panel).queryByRole('button', { name: 'Open in Tester' })).not.toBeInTheDocument();
  });
});

describe('Call log: stats', () => {
  it('shows totals, error rate, median, 95th percentile and per-server counts', async () => {
    fakeApi(routes());
    renderApp('/calls');
    const strip = await screen.findByRole('region', { name: 'Stats' });
    await within(strip).findByText('12');
    expect(strip).toHaveTextContent('Error rate25%');
    expect(strip).toHaveTextContent('Median40 ms');
    expect(strip).toHaveTextContent('95th percentile900 ms');
    expect(within(strip).getByRole('list', { name: 'Calls per server' })).toHaveTextContent(
      'files 12 (3 errors)',
    );
  });
});

describe('Call log: Search tab', () => {
  it('hit rate, searches with hits, misses and ranks, and recent misses', async () => {
    const { calls } = fakeApi(
      routes({
        'GET /api/searches': {
          searches: [
            search(3, { followup: 'hit', rank: 2, calledTool: 'files__write_file', followupCallId: 9 }),
            search(2, { followup: 'miss', calledTool: 'github__create_issue', followupCallId: 8 }),
            search(1, { followup: 'pending' }),
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/calls');
    await user.click(await screen.findByRole('tab', { name: 'Search' }));
    await waitFor(() => expect(currentLocation()).toContain('tab=searches'));
    const rate = await screen.findByRole('region', { name: 'Search hit rate' });
    expect(await within(rate).findByText('66.7%')).toBeInTheDocument();
    const list = await screen.findByRole('table', { name: 'Search list' });
    const rows = within(list).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Hit');
    expect(rows[1]).toHaveTextContent('rank 2');
    expect(rows[2]).toHaveTextContent('Miss');
    expect(rows[2]).toHaveTextContent('github__create_issue');
    expect(rows[3]).toHaveTextContent('Waiting');
    const misses = screen.getByRole('table', { name: 'Recent misses' });
    expect(misses).toHaveTextContent('open an issue');
    expect(misses).toHaveTextContent('github__create_issue');

    await user.selectOptions(screen.getByLabelText('Follow-up'), 'miss');
    await waitFor(() => expect(currentLocation()).toContain('followup=miss'));
    await waitFor(() =>
      expect(calls.some((c) => c.path.startsWith('/api/searches?') && c.path.includes('outcome=miss'))).toBe(
        true,
      ),
    );
  });
});

describe('Call log: Clear log', () => {
  it('asks first, naming what is deleted; then clears with confirm=true', async () => {
    let deleted: string | undefined;
    fakeApi(
      routes({
        'DELETE /api/calls': (request: FakeCall) => {
          deleted = request.path;
          return { body: { deletedCalls: 12, deletedSearches: 4 } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/calls');
    await screen.findByRole('table', { name: 'Calls' });
    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/12 calls and 4 searches/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deleted).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear log' }),
    );
    await waitFor(() => expect(deleted).toBe('/api/calls?confirm=true'));
    expect(await screen.findByText('Call log cleared')).toBeInTheDocument();
  });
});
