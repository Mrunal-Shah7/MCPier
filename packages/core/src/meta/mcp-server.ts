// The MCP server clients talk to on /mcp: three meta-tools over the shared meta-tool
// functions. One factory serves both eras; only how the caller is read differs.
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import {
  callTool,
  listServers,
  searchTools,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type Caller,
  type MetaToolContext,
} from './meta-tools.js';

/** Told to the model in `server/discover` and the legacy `initialize` result. Under 600 characters. */
export const MCP_INSTRUCTIONS =
  'MCPier connects you to the MCP servers this user has set up, through three tools. ' +
  'First call list_servers to see what is connected and whether each server is working. ' +
  'Then call search_tools with a few words about the task to find a tool; each match has its full name ' +
  '(server__tool) and input schema. Then call call_tool with that name and arguments that match the schema. ' +
  'If a server needs sign-in or is not working, tell the user to fix it in MCPier.';

/** `tools/list` never changes (always the same three tools), so clients may cache it for a day. */
export const TOOLS_LIST_CACHE_HINT = { ttlMs: 86_400_000, cacheScope: 'public' } as const;

export type McpEra = 'modern' | 'legacy';

export interface MetaServerOptions {
  meta: MetaToolContext;
  era: McpEra;
  version: string;
  logger: Logger;
}

const statusEnum = z.enum(['starting', 'ready', 'needs_auth', 'error', 'crashed', 'stopped']);

const listServersOutput = z.looseObject({
  servers: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      status: statusEnum,
      detail: z.string().optional(),
      tools: z.number().int(),
    }),
  ),
});

const searchToolsOutput = z.looseObject({
  query: z.string(),
  results: z.array(
    z.looseObject({
      name: z.string(),
      server: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()),
      inputSchemaOutlined: z.boolean().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      available: z.boolean(),
      serverStatus: statusEnum.optional(),
    }),
  ),
});

function callerOf(server: McpServer, ctx: ServerContext, era: McpEra): Caller {
  const request = ctx.mcpReq;
  const envelope = (request.envelope ?? {}) as Record<string, unknown>;
  const info = (era === 'modern' ? envelope[CLIENT_INFO_META_KEY] : server.server.getClientVersion()) as
    { name?: unknown; version?: unknown } | undefined;
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
  const elicitation =
    era === 'modern' && capabilities?.elicitation && typeof capabilities.elicitation === 'object'
      ? (capabilities.elicitation as Record<string, unknown>)
      : undefined;
  const requestState = request.requestState<string>();
  return {
    era,
    client: {
      ...(typeof info?.name === 'string' ? { name: info.name } : {}),
      ...(typeof info?.version === 'string' ? { version: info.version } : {}),
    },
    meta: (request._meta ?? {}) as Record<string, unknown>,
    signal: request.signal,
    ...(elicitation ? { elicitation } : {}),
    ...(request.inputResponses ? { inputResponses: request.inputResponses as Record<string, unknown> } : {}),
    ...(typeof requestState === 'string' ? { requestState } : {}),
  };
}

const internalError = (tool: string) => ({
  content: [
    {
      type: 'text' as const,
      text: `MCPier hit an internal error while running ${tool}. The details are in MCPier's gateway log.`,
    },
  ],
  isError: true,
});

/** A fresh MCP server offering the three meta-tools. */
export function createMetaServer({ meta, era, version, logger }: MetaServerOptions): McpServer {
  const server = new McpServer(
    { name: 'mcpier', title: 'MCPier', version },
    {
      instructions: MCP_INSTRUCTIONS,
      capabilities: { tools: { listChanged: false } },
      cacheHints: { 'tools/list': TOOLS_LIST_CACHE_HINT },
      // Legacy clients cannot answer input_required; call_tool tells them so itself.
      inputRequired: { legacyShim: false },
    },
  );

  /** A tool handler never throws: anything unexpected becomes an error result. */
  const guarded =
    <A>(tool: string, run: (args: A, ctx: ServerContext) => unknown) =>
    async (args: A, ctx: ServerContext) => {
      try {
        return await run(args, ctx);
      } catch (error) {
        logger.error({ tool, err: { message: (error as Error)?.message } }, 'Meta-tool failed unexpectedly');
        return internalError(tool);
      }
    };

  server.registerTool(
    'list_servers',
    {
      title: 'List connected servers',
      description:
        'Lists the MCP servers connected through MCPier, with what each is for, whether it is working, and how many tools it has. Call this first.',
      inputSchema: z.object({}),
      outputSchema: listServersOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('list_servers', () => listServers(meta)) as never,
  );

  server.registerTool(
    'search_tools',
    {
      title: 'Search tools',
      description:
        'Finds tools across every connected server. Give a few words about what you want to do. ' +
        'Each match has the full tool name to pass to call_tool and its input schema.',
      inputSchema: z.object({
        query: z.string().default('').describe('What you want to do, in a few words'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .default(SEARCH_LIMIT_DEFAULT)
          .describe(`How many matches to return (1-${SEARCH_LIMIT_MAX})`),
        server: z.string().optional().describe('Only search this server (a name from list_servers)'),
      }),
      outputSchema: searchToolsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('search_tools', (args: { query: string; limit: number; server?: string }, ctx) =>
      searchTools(meta, args, callerOf(server, ctx, era)),
    ) as never,
  );

  server.registerTool(
    'call_tool',
    {
      title: 'Call a tool',
      description:
        'Runs a tool found with search_tools. Pass its full name (server__tool) and arguments matching its input schema.',
      inputSchema: z.object({
        name: z.string().describe('Full tool name from search_tools, like server__tool'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for the tool'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guarded('call_tool', (args: { name: string; arguments?: Record<string, unknown> }, ctx) =>
      callTool(meta, args, callerOf(server, ctx, era)),
    ) as never,
  );

  return server;
}
