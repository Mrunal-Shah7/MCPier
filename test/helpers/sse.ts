/** A server-sent events reader for tests: collects every event and the raw text. */
export interface SseReader {
  events: { event: string; data: unknown }[];
  /** Everything received, comments (heartbeats) included. */
  raw(): string;
  /** Resolves once an event matching `match` has arrived (or rejects after `timeoutMs`). */
  waitFor(match: (event: { event: string; data: unknown }) => boolean, timeoutMs?: number): Promise<unknown>;
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string>): Promise<SseReader> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`event stream answered HTTP ${response.status}`);
  const events: { event: string; data: unknown }[] = [];
  let raw = '';
  let buffer = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const ended = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        buffer += text;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (event) events.push({ event, data: data ? JSON.parse(data) : undefined });
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  return {
    events,
    raw: () => raw,
    async waitFor(match, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(match);
        if (found) return found.data;
        if (Date.now() > deadline) {
          throw new Error(`no matching event; got ${events.map((event) => event.event).join(', ')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    ended,
    close: () => controller.abort(),
  };
}
