// The dashboard's one connection to GET /api/events. Read with fetch (not EventSource), so the
// request carries x-mcpier-client, a 401 is seen as "signed out", and tests can swap it out.
import {
  CLIENT_NAME_HEADER,
  DASHBOARD_API_PATHS,
  GATEWAY_EVENT_TYPES,
  type GatewayEvent,
  type GatewayEventType,
} from '@mcpier/shared';
import { DASHBOARD_CLIENT_NAME } from './api';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface LiveEvents {
  /** Starts the connection (idempotent). */
  start(): void;
  /** Ends it for good. */
  stop(): void;
  subscribe(listener: (event: GatewayEvent) => void): () => void;
  onState(listener: (state: StreamState) => void): () => void;
  /** Called after a dropped stream is open again, so the app can re-fetch. */
  onReconnect(listener: () => void): () => void;
  /** Called on a 401: the browser is not signed in. */
  onUnauthorized(listener: () => void): () => void;
  readonly state: StreamState;
}

/** Parses one SSE block (`event:` / `data:` lines) into a gateway event, or nothing. */
export function parseEventBlock(block: string): GatewayEvent | undefined {
  let type: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!type || !(GATEWAY_EVENT_TYPES as readonly string[]).includes(type)) return undefined;
  try {
    return {
      type: type as GatewayEventType,
      data: data.length > 0 ? JSON.parse(data.join('\n')) : {},
    } as GatewayEvent;
  } catch {
    return undefined;
  }
}

/** Reconnect delays: 1, 2, 4 … up to 30 seconds. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

export function createLiveEvents(fetchImpl: typeof fetch = (...args) => fetch(...args)): LiveEvents {
  const listeners = new Set<(event: GatewayEvent) => void>();
  const stateListeners = new Set<(state: StreamState) => void>();
  const reconnectListeners = new Set<() => void>();
  const unauthorizedListeners = new Set<() => void>();
  let state: StreamState = 'stopped';
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let everOpened = false;
  let running = false;

  const setState = (next: StreamState) => {
    state = next;
    for (const listener of stateListeners) listener(next);
  };

  const scheduleReconnect = () => {
    if (!running) return;
    setState('reconnecting');
    timer = setTimeout(connect, backoffMs(attempt++));
  };

  async function connect(): Promise<void> {
    if (!running) return;
    controller = new AbortController();
    if (!everOpened) setState('connecting');
    let response: Response;
    try {
      response = await fetchImpl(DASHBOARD_API_PATHS.events, {
        headers: { [CLIENT_NAME_HEADER]: DASHBOARD_CLIENT_NAME, accept: 'text/event-stream' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch {
      scheduleReconnect();
      return;
    }
    if (response.status === 401) {
      running = false;
      setState('stopped');
      for (const listener of unauthorizedListeners) listener();
      return;
    }
    if (!response.ok || !response.body) {
      scheduleReconnect();
      return;
    }
    const wasReconnect = everOpened;
    everOpened = true;
    attempt = 0;
    setState('open');
    if (wasReconnect) for (const listener of reconnectListeners) listener();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const event = parseEventBlock(block);
          if (event) for (const listener of listeners) listener(event);
        }
      }
    } catch {
      // Dropped or aborted: reconnect below unless stopped.
    }
    scheduleReconnect();
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (running) return;
      running = true;
      void connect();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      controller?.abort();
      setState('stopped');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    onUnauthorized(listener) {
      unauthorizedListeners.add(listener);
      return () => unauthorizedListeners.delete(listener);
    },
  };
}
