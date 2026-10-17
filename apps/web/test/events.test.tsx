// The event-stream client: parsing, delivery, reconnect after a drop, and stopping on 401.
import { describe, expect, it, vi } from 'vitest';
import { backoffMs, createLiveEvents, parseEventBlock } from '@/lib/events';

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('parseEventBlock', () => {
  it('reads a known event with JSON data', () => {
    expect(parseEventBlock('event: server_removed\ndata: {"name":"files"}')).toEqual({
      type: 'server_removed',
      data: { name: 'files' },
    });
  });

  it('ignores comments, unknown types and bad JSON', () => {
    expect(parseEventBlock(': heartbeat')).toBeUndefined();
    expect(parseEventBlock('event: something_else\ndata: {}')).toBeUndefined();
    expect(parseEventBlock('event: server_removed\ndata: {not json')).toBeUndefined();
  });

  it('backs off 1, 2, 4 … up to 30 seconds', () => {
    expect([0, 1, 2, 3, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 30_000]);
  });
});

describe('createLiveEvents', () => {
  it('delivers events, reconnects after the stream ends, and reports the reconnect', async () => {
    const responses = [
      streamResponse([
        'event: snapshot\ndata: {"status":{},"servers":[]}\n\n: heartbeat\n\n',
        'event: secrets_changed\ndata: {"names":["a"]}\n\n',
      ]),
      streamResponse(['event: server_added\ndata: {"name":"b"}\n\n']),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? new Promise<Response>(() => {}));
    const live = createLiveEvents(fetchMock as unknown as typeof fetch);
    const seen: string[] = [];
    const states: string[] = [];
    let reconnects = 0;
    live.subscribe((event) => seen.push(event.type));
    live.onState((state) => states.push(state));
    live.onReconnect(() => reconnects++);
    live.start();
    await vi.waitFor(() => expect(seen).toEqual(['snapshot', 'secrets_changed', 'server_added']), {
      timeout: 3000,
    });
    expect(reconnects).toBe(1);
    expect(states).toContain('reconnecting');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-mcpier-client']).toBe('dashboard');
    live.stop();
    expect(live.state).toBe('stopped');
  });

  it('stops for good on a 401 and says so', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    const live = createLiveEvents(fetchMock as unknown as typeof fetch);
    let unauthorized = 0;
    live.onUnauthorized(() => unauthorized++);
    live.start();
    await vi.waitFor(() => expect(unauthorized).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(live.state).toBe('stopped');
  });
});
