// Sprint 7, Phase 5: the Usage page: ranges, by server and by client, the table alternative,
// deltas, empty data, calls without a size, and the throttled live refresh.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { defaultConfig, type CallSummary, type UsageResponse, type UsageTotals } from '@mcpier/shared';
import { refreshUsageThrottled, resetUsageThrottle, USAGE_REFRESH_MS, usageKeys } from '@/lib/usage';
import { currentLocation, fakeApi, renderApp, server, status } from './helpers';

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    calls: 0,
    errors: 0,
    errorRate: null,
    tokens: 0,
    avgTokensPerCall: null,
    p95TokensPerCall: null,
    p50Ms: null,
    p95Ms: null,
    callsWithoutSize: 0,
    searchTokens: 0,
    searches: 0,
    ...overrides,
  };
}

const HOUR = 3_600_000;
const START = Date.parse('2026-10-16T00:00:00.000Z');

function report(
  overrides: Partial<UsageResponse> = {},
  buckets = 3,
  bucket: 'hour' | 'day' = 'day',
): UsageResponse {
  const step = bucket === 'hour' ? HOUR : 24 * HOUR;
  return {
    from: new Date(START).toISOString(),
    to: new Date(START + buckets * step).toISOString(),
    bucket,
    timeZone: 'UTC',
    clipped: false,
    retentionDays: 30,
    totals: totals({
      calls: 12,
      errors: 2,
      errorRate: 2 / 12,
      tokens: 4800,
      avgTokensPerCall: 400,
      p95TokensPerCall: 1200,
      p50Ms: 40,
      p95Ms: 300,
    }),
    previous: {
      ...totals({ calls: 8, errors: 2, errorRate: 0.25, tokens: 6000, avgTokensPerCall: 750 }),
      from: new Date(START - buckets * step).toISOString(),
      to: new Date(START).toISOString(),
    },
    series: Array.from({ length: buckets }, (_, index) => ({
      start: new Date(START + index * step).toISOString(),
      calls: 4,
      errors: index === 2 ? 2 : 0,
      tokens: 1600,
      p50Ms: 40,
      byServer: { files: 3, notes: 1 },
      byClient: { 'chat-app': 1, 'code-editor': 3 },
    })),
    byServer: [
      { server: 'files', calls: 9, errors: 2, tokens: 3600, p50Ms: 40, series: [3, 3, 3] },
      { server: 'notes', calls: 3, errors: 0, tokens: 1200, p50Ms: 30, series: [1, 1, 1] },
    ],
    heaviestTools: [
      {
        tool: 'files__read_file',
        server: 'files',
        calls: 9,
        avgTokens: 400,
        tokens: 3600,
        series: [1200, 1200, 1200],
        callSeries: [3, 3, 3],
      },
    ],
    byClient: [
      { client: 'code-editor', calls: 9, share: 0.75 },
      { client: 'chat-app', calls: 3, share: 0.25 },
    ],
    ...overrides,
  };
}

function empty(): UsageResponse {
  return report({
    totals: totals(),
    previous: { ...totals(), from: '', to: '' },
    series: [0, 1, 2].map((index) => ({
      start: new Date(START + index * 24 * HOUR).toISOString(),
      calls: 0,
      errors: 0,
      tokens: 0,
      p50Ms: null,
      byServer: {},
      byClient: {},
    })),
    byServer: [],
    heaviestTools: [],
    byClient: [],
  });
}

function routes(answer: (range: string) => UsageResponse = () => report(), retention = 30) {
  return {
    'GET /api/status': status(),
    'GET /api/servers': {
      servers: [server(), server({ name: 'notes', icon: { available: true, source: 'config', etag: 'n1' } })],
    },
    'GET /api/settings': { settings: { ...defaultConfig().settings, logRetentionDays: retention } },
    'GET /api/usage': (call: { path: string }) => ({
      body: answer(new URL(call.path, 'http://x').searchParams.get('range') ?? ''),
    }),
  };
}

const usageCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((call) => call.method === 'GET' && call.path.startsWith('/api/usage'));

beforeEach(() => resetUsageThrottle());
afterEach(() => {
  resetUsageThrottle();
  vi.useRealTimers();
});

describe('Usage page', () => {
  it('KPIs with deltas against the previous period, up and down', async () => {
    fakeApi(routes());
    renderApp('/usage');
    const calls = (await screen.findByText('Calls', { selector: 'span' })).closest('section')!;
    expect(calls).toHaveTextContent('12');
    // 12 vs 8 calls: up 50%, good.
    const up = calls.querySelector('[data-delta]')!;
    expect(up).toHaveAttribute('data-delta', 'up');
    expect(up).toHaveTextContent('50%');
    expect(up.className).toContain('text-tone-ok-text');
    // 4,800 vs 6,000 tokens: down 20%, good (fewer tokens is better).
    const tokens = screen.getByText('Est. tokens returned').closest('section')!;
    const down = tokens.querySelector('[data-delta]')!;
    expect(down).toHaveAttribute('data-delta', 'down');
    expect(down).toHaveTextContent('20%');
    expect(down.className).toContain('text-tone-ok-text');
    // Error rate 16.7% vs 25%: down 8.3 points, good.
    const errors = screen.getByText('Error rate').closest('section')!;
    expect(errors).toHaveTextContent('16.7%');
    expect(errors.querySelector('[data-delta]')).toHaveTextContent('8.3 pts');
    expect(screen.getByText('Avg tokens per call').closest('section')).toHaveTextContent('p95 1.2k');
    // Each KPI with a series has a sparkline with a text alternative.
    expect(screen.getByRole('img', { name: /^Calls per day: 3 points/ })).toBeInTheDocument();
  });

  it('each range asks for its own report; 7 days is the default and stays out of the URL', async () => {
    const { calls } = fakeApi(routes((range) => report({}, range === '24h' ? 24 : range === '30d' ? 30 : 7)));
    const user = userEvent.setup();
    renderApp('/usage');
    await screen.findByRole('img', { name: /^Calls per day: 7 points/ });
    expect(usageCalls(calls).at(-1)!.path).toBe('/api/usage?range=7d');
    const range = screen.getByRole('group', { name: 'Range' });
    await user.click(within(range).getByRole('button', { name: '24 h' }));
    await waitFor(() => expect(usageCalls(calls).at(-1)!.path).toBe('/api/usage?range=24h'));
    expect(currentLocation()).toBe('/usage?range=24h');
    await user.click(within(range).getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(usageCalls(calls).at(-1)!.path).toBe('/api/usage?range=30d'));
    await user.click(within(range).getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(currentLocation()).toBe('/usage'));
  });

  it('hourly buckets for 24 hours', async () => {
    fakeApi(routes(() => report({}, 24, 'hour')));
    renderApp('/usage?range=24h');
    expect(await screen.findByText('Calls per hour')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /^Calls per hour by server: 96 calls in 24 buckets/ }),
    ).toBeInTheDocument();
  });

  it('a range longer than the retention period is disabled, with the reason', async () => {
    fakeApi(routes(undefined, 7));
    renderApp('/usage');
    const range = await screen.findByRole('group', { name: 'Range' });
    await waitFor(() => expect(within(range).getByRole('button', { name: '30 days' })).toBeDisabled());
    expect(within(range).getByRole('button', { name: '30 days' })).toHaveAttribute(
      'title',
      'Longer than the call log keeps (7 days)',
    );
    expect(within(range).getByRole('button', { name: '7 days' })).toBeEnabled();
  });

  it('by server and by client, each with a legend and the same numbers as a table', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/usage');
    const chart = (await screen.findByText('Calls per day')).closest('section')!;
    expect(
      within(chart).getByRole('img', { name: /^Calls per day by server: 12 calls/ }),
    ).toBeInTheDocument();
    expect(
      within(within(chart).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['files', 'notes']);
    await user.click(within(chart).getByRole('button', { name: 'Show as table' }));
    const table = within(chart).getByRole('table', { name: 'Calls per day by server' });
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
      'Bucket',
      'files',
      'notes',
      'Total',
    ]);
    expect([...table.querySelectorAll('tbody tr')][0]!.textContent).toMatch(/314$/);

    await user.click(
      within(screen.getByRole('group', { name: 'Group by' })).getByRole('button', { name: 'By client' }),
    );
    expect(currentLocation()).toBe('/usage?by=client');
    const byClient = within(chart).getByRole('table', { name: 'Calls per day by client' });
    // Highest total first: code-editor (9), then chat-app (3).
    expect([...byClient.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
      'Bucket',
      'code-editor',
      'chat-app',
      'Total',
    ]);
    // Two series in one chart never share a colour.
    await user.click(within(chart).getByRole('button', { name: 'Show as chart' }));
    const swatches = within(within(chart).getByRole('list', { name: 'Legend' }))
      .getAllByRole('listitem')
      .map((item) => item.querySelector('span')!.className);
    expect(new Set(swatches).size).toBe(2);
  });

  it('tokens by server with icons, heaviest tools linking to the tool, and the client shares', async () => {
    fakeApi(routes());
    renderApp('/usage');
    const byServer = await screen.findByRole('list', {
      name: 'Estimated tokens by server: files 3.6k, notes 1.2k',
    });
    expect(byServer.querySelector('img[data-tile="icon"]')!.getAttribute('src')).toContain('v=n1');
    const tools = screen.getByRole('table', { name: 'Heaviest tools' });
    const row = within(tools).getByRole('link', { name: 'read_file' });
    expect(row).toHaveAttribute('href', '/servers/files?tab=tools&tool=read_file');
    expect(row.closest('tr')).toHaveTextContent(/9\s*400\s*3.6k/);
    expect(
      screen.getByRole('list', { name: 'Share of calls by client: code-editor 75%, chat-app 25%' }),
    ).toBeInTheDocument();
  });

  it('empty data: zeros, dashes, and "no calls" instead of charts', async () => {
    fakeApi(routes(() => empty()));
    renderApp('/usage');
    expect(
      await screen.findByRole('img', { name: /^Calls per day by server: 0 calls in 3 buckets$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Avg tokens per call').closest('section')).toHaveTextContent('—');
    expect(screen.getByText('Error rate').closest('section')).toHaveTextContent('no earlier data');
    expect(screen.getAllByText('No calls in this range.')).toHaveLength(3);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('calls without a size are counted and said so; a clipped range says so too', async () => {
    fakeApi(
      routes(() =>
        report({ totals: totals({ calls: 5, callsWithoutSize: 3 }), clipped: true, retentionDays: 7 }),
      ),
    );
    renderApp('/usage?range=30d');
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('3 calls have no size (recorded before 1.1.0): counted, not estimated.');
    expect(note).toHaveTextContent('Limited to the last 7 days the call log keeps.');
  });

  it('the info tooltip explains the estimate', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/usage');
    await user.hover(await screen.findByRole('button', { name: 'About Usage' }));
    expect((await screen.findAllByText(/about 4 bytes of each result/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Image blocks count by their encoded size/).length).toBeGreaterThan(0);
  });

  it('a recorded call refreshes the page live', async () => {
    const { calls } = fakeApi(routes());
    const { events } = renderApp('/usage');
    await screen.findByRole('img', { name: /^Calls per day: 3 points/ });
    const before = usageCalls(calls).length;
    const call: CallSummary = {
      id: 1,
      at: new Date().toISOString(),
      client: { name: 'chat-app' },
      era: 'modern',
      tool: 'files__read_file',
      server: 'files',
      durationMs: 3,
      outcome: 'ok',
      bodiesStored: false,
    };
    act(() => events.emit({ type: 'call_recorded', data: call }));
    await waitFor(() => expect(usageCalls(calls).length).toBeGreaterThan(before));
  });
});

describe('usage refresh throttle', () => {
  it('at most one refetch every 5 seconds, and the last burst is not lost', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    for (let index = 0; index < 10; index++) refreshUsageThrottled(client);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: usageKeys.all });
    vi.advanceTimersByTime(USAGE_REFRESH_MS - 1);
    refreshUsageThrottled(client);
    expect(invalidate).toHaveBeenCalledTimes(1);
    // The calls during the wait lead to exactly one more refetch, when the 5 seconds are up.
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(USAGE_REFRESH_MS * 3);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
