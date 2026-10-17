import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';

export interface RunningFixture {
  /** The MCP endpoint, e.g. http://127.0.0.1:1234/mcp */
  url: string;
  port: number;
  /** Headers of every request received so far (lower-case names), oldest first. For tests. */
  receivedHeaders(): Record<string, string>[];
  close(): Promise<void>;
}

/** Serves `fetch` on 127.0.0.1 (port 0 picks a free port) and resolves once listening. */
export async function listenFixture(
  fetch: (request: Request) => Promise<Response> | Response,
  port = 0,
): Promise<RunningFixture> {
  const received: Record<string, string>[] = [];
  const recordingFetch = (request: Request) => {
    received.push(Object.fromEntries(request.headers.entries()));
    return fetch(request);
  };
  const server = createAdaptorServer({ fetch: recordingFetch }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    port: actualPort,
    receivedHeaders: () => received.map((headers) => ({ ...headers })),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** For the command-line entries: `--port <n>` (default 0 = any free port). */
export function portFromArgs(argv: readonly string[]): number {
  const index = argv.indexOf('--port');
  const value = index >= 0 ? Number(argv[index + 1]) : 0;
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('--port must be 0-65535');
  return value;
}

export const notFound = (): Response => new Response('Not found', { status: 404 });
