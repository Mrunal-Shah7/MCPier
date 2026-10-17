import { CLIENT_NAME_HEADER } from '@mcpier/shared';
import { DASHBOARD_CLIENT_NAME } from './api';

/**
 * Reads a server-sent event stream with fetch until it ends or `signal` aborts. Each event
 * arrives as its type and raw data text.
 */
export async function readSse(
  path: string,
  onEvent: (event: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    headers: { [CLIENT_NAME_HEADER]: DASHBOARD_CLIENT_NAME, accept: 'text/event-stream' },
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`The stream answered HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) onEvent(event, data.join('\n'));
    }
  }
}
