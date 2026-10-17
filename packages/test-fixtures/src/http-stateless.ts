// Fake stateless MCP server: protocol 2026-07-28 only, no sessions, no handshake.
import { createMcpHandler } from '@modelcontextprotocol/server';
import { listenFixture, notFound, type RunningFixture } from './http-common.js';
import { createFakeServer } from './tools.js';

/**
 * Starts the stateless fixture. `legacy: 'reject'` makes it strictly 2026-07-28: a client
 * using the old `initialize` handshake gets an unsupported-protocol-version error.
 */
export async function startStatelessServer(
  options: { port?: number; toolsTtlMs?: number } = {},
): Promise<RunningFixture> {
  const handler = createMcpHandler(
    () => createFakeServer('fake-stateless-http', { toolsTtlMs: options.toolsTtlMs, modernTools: true }),
    { legacy: 'reject' },
  );
  const fixture = await listenFixture(
    (request) => (new URL(request.url).pathname === '/mcp' ? handler.fetch(request) : notFound()),
    options.port,
  );
  return {
    ...fixture,
    close: async () => {
      await handler.close();
      await fixture.close();
    },
  };
}
