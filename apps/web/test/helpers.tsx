// Test helpers: a fake admin API (a stubbed fetch with routes) and a fake event stream.
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation, type InitialEntry } from 'react-router';
import { vi } from 'vitest';
import type { GatewayEvent, ServerSummary, StatusResponse } from '@mcpier/shared';
import { AuthGate, Providers } from '@/App';
import type { LiveEvents, StreamState } from '@/lib/events';
import { createQueryClient } from '@/lib/queries';

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (call: FakeCall) => { status?: number; body?: unknown; raw?: string } | undefined;

/** Routes are `"METHOD /path"` (query string ignored unless written) → handler or body. */
export function fakeApi(routes: Record<string, Handler | object>) {
  const calls: FakeCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1:47800');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: FakeCall = { method, path: url.pathname + url.search, body, headers };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    const result =
      typeof route === 'function'
        ? (route as Handler)(call)
        : route !== undefined
          ? { body: route }
          : {
              status: 404,
              body: { error: { code: 'not_found', message: `No fake route ${method} ${url.pathname}` } },
            };
    const status = result?.status ?? 200;
    if (result && 'raw' in result && result.raw !== undefined) {
      return new Response(result.raw, { status, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(result?.body === undefined ? null : JSON.stringify(result.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** A LiveEvents the test drives by hand. */
export class FakeEvents implements LiveEvents {
  started = 0;
  stopped = 0;
  state: StreamState = 'stopped';
  private listeners = new Set<(event: GatewayEvent) => void>();
  private stateListeners = new Set<(state: StreamState) => void>();
  private reconnectListeners = new Set<() => void>();
  private unauthorizedListeners = new Set<() => void>();

  start(): void {
    this.started++;
    this.setState('open');
  }
  stop(): void {
    this.stopped++;
    this.setState('stopped');
  }
  emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  reconnect(): void {
    this.setState('open');
    for (const listener of this.reconnectListeners) listener();
  }
  setState(state: StreamState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
  subscribe(listener: (event: GatewayEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onState(listener: (state: StreamState) => void) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }
  onUnauthorized(listener: () => void) {
    this.unauthorizedListeners.add(listener);
    return () => this.unauthorizedListeners.delete(listener);
  }
}

/** The router's current path and query, for tests that check what a page put in the URL. */
function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="location" hidden>{`${location.pathname}${location.search}`}</output>;
}

/** The path and query the page is on now. */
export function currentLocation(): string {
  return document.querySelector('[data-testid="location"]')?.textContent ?? '';
}

export function renderApp(path: InitialEntry, events = new FakeEvents()) {
  const client = createQueryClient();
  const view = render(
    <Providers client={client} events={events}>
      <MemoryRouter initialEntries={[path]}>
        <AuthGate />
        <CurrentLocation />
      </MemoryRouter>
    </Providers>,
  );
  return { ...view, events, client };
}

export function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    version: '1.0.0',
    pid: 4242,
    startedAt: '2026-10-16T08:00:00.000Z',
    uptimeSeconds: 60,
    port: 47800,
    dataDir: 'C:\\Users\\me\\AppData\\Local\\MCPier',
    servers: { configured: 1, enabled: 1, byStatus: { ready: 1 } },
    ...overrides,
  };
}

export function server(overrides: Partial<ServerSummary> = {}): ServerSummary {
  return {
    name: 'files',
    transport: 'stdio',
    enabled: true,
    status: { state: 'ready', since: '2026-10-16T08:00:00.000Z' },
    protocolVersion: '2025-11-25',
    tools: { total: 14, enabled: 14 },
    uptimeSeconds: 90,
    ...overrides,
  };
}
