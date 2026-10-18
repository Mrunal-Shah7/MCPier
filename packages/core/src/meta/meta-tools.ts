// The three tools clients see (SPEC 5): list_servers, search_tools, call_tool. Plain functions
// over the manager, so the /mcp endpoint, the admin API and tests all run the same code.
// Every failure a model can act on is an error *result* (isError), never a protocol error.
import type { ServerStatus, ServerSummary, Settings, ToolSearchMatch } from '@mcpier/shared';
import { redactDeep } from '../secrets/redact.js';
import { CallTimeoutError, isInputRequired } from '../upstream/types.js';
import type { CallToolResult, InputRequiredOutcome } from '../upstream/types.js';
import { traceMetaOf } from '../upstream/client.js';
import { ConflictError, NotFoundError } from '../manager/errors.js';
import type { ServerManager } from '../manager/manager.js';
import {
  resultByteSize,
  traceIdOf,
  type CallOutcomeKind,
  type ClientEra,
  type ClientIdentity,
  type Recorder,
} from './recorder.js';
import type { RequestStateSigner } from './request-state.js';
import { schemaForSearch } from './schema.js';
import type { SearchIndex } from './search.js';
import { truncateResult, type TruncationReport } from './truncate.js';
import type { ArgumentValidator } from './validation.js';

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 20;

export interface MetaToolContext {
  manager: ServerManager;
  search: SearchIndex;
  validator: ArgumentValidator;
  signer: RequestStateSigner;
  recorder: Recorder;
  settings: () => Settings;
}

/** Who is calling, and what came with the request. */
export interface Caller {
  era: ClientEra;
  client: ClientIdentity;
  /** The request's `_meta` (trace context is taken from it). */
  meta?: Record<string, unknown>;
  /** The client's declared `elicitation` capability (2026-07-28 clients only). */
  elicitation?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Retry after input_required: the client's answers. */
  inputResponses?: Record<string, unknown>;
  /** Retry after input_required: MCPier's own state, as issued. */
  requestState?: string;
}

/** What `call_tool` answers with: a tool result, or MCPier's own `input_required`. */
export type MetaCallResult = CallToolResult | InputRequiredOutcome;

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
});

function shorten(value: string | undefined, max = 140): string {
  const first = (value ?? '').split('\n')[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** What a model should know about a server that is not ready. */
export function statusHint(state: ServerStatus, detail?: string): string | undefined {
  switch (state) {
    case 'ready':
      return undefined;
    case 'needs_auth':
      return 'needs sign-in in MCPier';
    case 'starting':
      return 'starting; try again in a moment';
    case 'stopped':
      return 'stopped in MCPier';
    case 'crashed':
      return `crashed: ${shorten(detail)}`;
    case 'error':
      return `error: ${shorten(detail)}`;
  }
}

/** For a call to a server that is not ready: the state and what the user should do. */
function notReadyMessage(server: string, state: ServerStatus, detail?: string): string {
  const reason = detail ? ` (${shorten(detail)})` : '';
  switch (state) {
    case 'needs_auth':
      // The detail names the reason: sign-in required, sign-in expired, or more permissions.
      return (
        `The server "${server}" needs sign-in in MCPier${reason}. Ask the user to sign in to "${server}" in MCPier: ` +
        `on the server's page in the MCPier dashboard, or with: mcpier auth login ${server}. Then try again.`
      );
    case 'crashed':
      return `The server "${server}" crashed${reason}. Ask the user to restart it in MCPier (mcpier server restart ${server}).`;
    case 'starting':
      return `The server "${server}" is still starting. Try again in a few seconds.`;
    case 'stopped':
      return `The server "${server}" is stopped in MCPier. Ask the user to start it (mcpier server start ${server}).`;
    default:
      return `The server "${server}" is not working right now${reason}. MCPier keeps retrying; ask the user to check it in MCPier if this persists.`;
  }
}

// ---- list_servers

export interface ListServersOutput {
  servers: { name: string; description?: string; status: ServerStatus; detail?: string; tools: number }[];
}

export function listServers(ctx: MetaToolContext): CallToolResult {
  const servers = ctx.manager
    .summaries()
    .filter((server) => server.enabled)
    .map((server: ServerSummary) => {
      const detail = statusHint(server.status.state, server.status.detail);
      return {
        name: server.name,
        ...(server.description ? { description: server.description } : {}),
        status: server.status.state,
        ...(detail ? { detail } : {}),
        tools: server.tools.enabled,
      };
    });
  const lines = servers.map(
    (server) =>
      `- ${server.name} (${server.status}${server.detail && server.status !== 'ready' ? `: ${server.detail}` : ''})` +
      `${server.description ? `: ${server.description}` : ''} — ${server.tools} tools`,
  );
  const output: ListServersOutput = { servers };
  return {
    content: [
      {
        type: 'text',
        text:
          servers.length === 0
            ? 'No servers are connected through MCPier yet.'
            : `Servers connected through MCPier:\n${lines.join('\n')}\n\nUse search_tools to find a tool, then call_tool to run it.`,
      },
    ],
    structuredContent: output as unknown as Record<string, unknown>,
  };
}

// ---- search_tools

export interface SearchToolsInput {
  query?: string;
  limit?: number;
  server?: string;
}

export type SearchToolsMatch = ToolSearchMatch;

export function searchTools(ctx: MetaToolContext, input: SearchToolsInput, caller: Caller): CallToolResult {
  const started = performance.now();
  const query = (input.query ?? '').trim();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? SEARCH_LIMIT_DEFAULT), 1), SEARCH_LIMIT_MAX);
  // Recorded with the size of exactly what is returned, so every path records its own result.
  const record = (names: string[], result: CallToolResult): CallToolResult => {
    ctx.recorder.searchPerformed({
      at: new Date().toISOString(),
      client: caller.client,
      era: caller.era,
      query,
      ...(input.server ? { server: input.server } : {}),
      limit,
      resultCount: names.length,
      results: names,
      durationMs: Math.round(performance.now() - started),
      resultBytes: resultByteSize(result),
    });
    return result;
  };

  if (input.server !== undefined) {
    const enabled = ctx.manager.summaries().filter((server) => server.enabled);
    if (!enabled.some((server) => server.name === input.server)) {
      const known = ctx.manager.has(input.server);
      return record(
        [],
        text(
          known
            ? `The server "${input.server}" is disabled in MCPier. Its tools cannot be searched or called until the user enables it.`
            : `There is no server named "${input.server}". Valid server names: ${enabled.map((server) => server.name).join(', ') || '(none)'}.`,
          true,
        ),
      );
    }
  }
  if (!query && input.server === undefined) {
    return record(
      [],
      text('Give a query (what you want to do), or call list_servers to see what is connected.', true),
    );
  }

  const hits = ctx.search.search({ query, limit, ...(input.server ? { server: input.server } : {}) });
  const matches: SearchToolsMatch[] = hits.map((hit) => {
    const { schema, outlined } = schemaForSearch(hit.tool.inputSchema);
    return {
      name: hit.tool.fullName,
      server: hit.tool.server,
      ...(hit.tool.title ? { title: hit.tool.title } : {}),
      ...(hit.tool.description ? { description: hit.tool.description } : {}),
      inputSchema: schema,
      ...(outlined ? { inputSchemaOutlined: true } : {}),
      ...(hit.tool.readOnlyHint !== undefined ? { readOnlyHint: hit.tool.readOnlyHint } : {}),
      ...(hit.tool.destructiveHint !== undefined ? { destructiveHint: hit.tool.destructiveHint } : {}),
      available: hit.available,
      ...(hit.available ? {} : { serverStatus: hit.serverStatus }),
    };
  });
  const blocks = matches.map((match) => {
    const hints = [match.readOnlyHint && 'read-only', match.destructiveHint && 'destructive'].filter(Boolean);
    const availability = match.available
      ? ''
      : ` [unavailable: server ${statusHint(match.serverStatus!, ctx.manager.status(match.server).detail)}]`;
    return [
      `${match.name}${hints.length > 0 ? ` (${hints.join(', ')})` : ''}${availability}`,
      match.description ? `  ${shorten(match.description, 300)}` : undefined,
      `  inputSchema: ${JSON.stringify(match.inputSchema)}`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  const summary =
    matches.length === 0
      ? `No tools match "${query}"${input.server ? ` on ${input.server}` : ''}. Try other words, or call list_servers.`
      : `${matches.length} tool${matches.length === 1 ? '' : 's'}${query ? ` for "${query}"` : ` on ${input.server}`}. Call one with call_tool { "name": "<name>", "arguments": { … } }.\n\n${blocks.join('\n\n')}`;
  return record(
    matches.map((match) => match.name),
    {
      content: [{ type: 'text', text: summary }],
      structuredContent: { query, results: matches } as unknown as Record<string, unknown>,
    },
  );
}

// ---- call_tool

function redactFor(ctx: MetaToolContext, server: string | undefined, text: string): string {
  return server ? ctx.manager.redactFor(server, text) : text;
}

/** The first text block of a result (an error message), for the call log. */
function firstText(result: MetaCallResult): string | undefined {
  if (isInputRequired(result)) return undefined;
  const block = result.content.find((item) => item.type === 'text') as { text?: string } | undefined;
  return block?.text;
}

/**
 * The arguments and the result as the caller saw them, redacted with the server's secret
 * values and OAuth tokens. An `input_required` answer is kept without its `requestState`.
 */
export function recordedBodies(
  ctx: MetaToolContext,
  server: string | undefined,
  args: Record<string, unknown>,
  result: unknown,
): { arguments: unknown; result: unknown; resultBytes: number } {
  const redact = (value: unknown) =>
    server ? redactDeep(value, (text) => ctx.manager.redactFor(server, text)) : value;
  const shown = isInputRequired(result)
    ? { resultType: result.resultType, inputRequests: result.inputRequests }
    : result;
  const redacted = redact(shown);
  // Measured here, on what the caller received (redacted), before the body cap and whether or
  // not bodies are stored.
  return { arguments: redact(args), result: redacted, resultBytes: resultByteSize(redacted) };
}

export interface CallToolInput {
  name: string;
  arguments?: Record<string, unknown>;
}

const NEEDS_INPUT_MESSAGE =
  'This tool needs input from the user (an elicitation) that this client cannot provide. ' +
  'Tell the user to run it from a client that supports MCP elicitation, or to use the server directly.';

const INVALID_STATE_MESSAGE =
  'This request has expired or is not valid (requestState). Call the tool again without requestState and inputResponses.';

/** A `call_tool` run with what the Tester shows besides the result. */
export interface CallToolRun {
  result: MetaCallResult;
  outcome: CallOutcomeKind;
  durationMs: number;
  /** What the result size limit cut, when it cut anything. */
  truncation?: TruncationReport;
}

export async function callTool(
  ctx: MetaToolContext,
  input: CallToolInput,
  caller: Caller,
): Promise<MetaCallResult> {
  return (await runCallTool(ctx, input, caller)).result;
}

/**
 * `call_tool` (SPEC 5.3) with its outcome. Elicitation is offered upstream only to a caller
 * that declares it and is not a legacy client: modern clients, and the dashboard's Tester
 * (era `admin`), which answers forms itself.
 */
export async function runCallTool(
  ctx: MetaToolContext,
  input: CallToolInput,
  caller: Caller,
): Promise<CallToolRun> {
  const started = performance.now();
  const name = input.name;
  const args = input.arguments ?? {};
  const offersElicitation = caller.era !== 'legacy' && caller.elicitation !== undefined;
  let server: string | undefined;
  let truncation: TruncationReport | undefined;
  const finish = (outcome: CallOutcomeKind, result: MetaCallResult): CallToolRun => {
    const durationMs = Math.round(performance.now() - started);
    const traceId = traceIdOf(caller.meta?.traceparent);
    const errorText = outcome === 'ok' || outcome === 'input_required' ? undefined : firstText(result);
    ctx.recorder.toolCalled({
      at: new Date().toISOString(),
      client: caller.client,
      era: caller.era,
      tool: name,
      ...(server ? { server } : {}),
      durationMs,
      outcome,
      ...(traceId ? { traceId } : {}),
      // Bodies for the call log: redacted here, before they are stored. Never inputResponses
      // or answers (they are not in `args`), and never requestState (stripped below).
      ...recordedBodies(ctx, server, args, result),
      ...(errorText ? { errorText: redactFor(ctx, server, errorText) } : {}),
    });
    return { result, outcome, durationMs, ...(truncation ? { truncation } : {}) };
  };

  // 1. Unknown name.
  let tool;
  try {
    tool = ctx.manager.tool(name);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // A disabled server that never connected has no tools in the catalog; say it is disabled.
    const prefix = name.split('__')[0]!;
    if (name.includes('__') && ctx.manager.has(prefix) && !ctx.manager.summary(prefix).enabled) {
      server = prefix;
      return finish(
        'disabled',
        text(
          `The server "${prefix}" is disabled in MCPier. The user can enable it on the Servers page of the MCPier dashboard, or with: mcpier server enable ${prefix}.`,
          true,
        ),
      );
    }
    const guesses = ctx.search.suggest(name, 3);
    return finish(
      'not_found',
      text(
        `There is no tool named "${name}".${guesses.length > 0 ? ` Did you mean: ${guesses.join(', ')}?` : ''} ` +
          'Use search_tools to find the right name (full names look like server__tool).',
        true,
      ),
    );
  }
  server = tool.server;

  // 2. Disabled tool or server.
  if (!tool.enabled) {
    const serverEnabled = ctx.manager.summary(tool.server).enabled;
    return finish(
      'disabled',
      text(
        serverEnabled
          ? `The tool "${name}" is disabled in MCPier. The user can enable it (mcpier tools enable ${name}).`
          : `The server "${tool.server}" is disabled in MCPier. The user can enable it on the Servers page of the MCPier dashboard, or with: mcpier server enable ${tool.server}.`,
        true,
      ),
    );
  }

  // 3. Server not ready.
  const status = ctx.manager.status(tool.server);
  if (status.state !== 'ready') {
    return finish('not_ready', text(notReadyMessage(tool.server, status.state, status.detail), true));
  }

  // 4. Arguments against the input schema.
  const validation = ctx.validator.validate(name, tool.inputSchema, args);
  if (!validation.ok) {
    return finish(
      'validation_error',
      text(
        `The arguments for ${name} do not match its input schema:\n` +
          validation.problems.map((problem) => `- ${problem}`).join('\n') +
          `\n\nFull input schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
        true,
      ),
    );
  }

  // A retry after input_required must carry MCPier's own, valid state for this tool.
  let upstreamState: string | undefined;
  if (caller.requestState !== undefined) {
    const check = ctx.signer.verify(caller.requestState, name);
    if (!check.ok) return finish('failed', text(INVALID_STATE_MESSAGE, true));
    upstreamState = check.state.upstream;
  }

  // 5. The call itself.
  try {
    const outcome = await ctx.manager.callTool(name, args, {
      signal: caller.signal,
      traceMeta: traceMetaOf(caller.meta),
      ...(offersElicitation ? { elicitation: caller.elicitation } : {}),
      ...(caller.inputResponses ? { inputResponses: caller.inputResponses } : {}),
      ...(upstreamState !== undefined ? { requestState: upstreamState } : {}),
    });
    if (outcome.kind === 'input_required') {
      const requests = Object.values(outcome.inputRequired.inputRequests ?? {}) as { method?: string }[];
      const canAnswer =
        offersElicitation &&
        requests.length > 0 &&
        requests.every((request) => request.method === 'elicitation/create');
      if (!canAnswer) return finish('input_required', text(NEEDS_INPUT_MESSAGE, true));
      return finish('input_required', {
        resultType: 'input_required',
        inputRequests: outcome.inputRequired.inputRequests,
        requestState: ctx.signer.sign({
          server: tool.server,
          tool: name,
          ...(outcome.inputRequired.requestState !== undefined
            ? { upstream: outcome.inputRequired.requestState }
            : {}),
        }),
      });
    }
    const { result, report } = truncateResult(outcome.result, ctx.settings().resultSizeLimitKb);
    if (report.text || report.structuredDroppedBytes !== undefined) truncation = report;
    return finish(result.isError ? 'tool_error' : 'ok', result);
  } catch (error) {
    if (caller.signal?.aborted) return finish('cancelled', text(`The call to ${name} was cancelled.`, true));
    if (error instanceof CallTimeoutError) return finish('timeout', text(error.message, true));
    if (error instanceof ConflictError && error.code === 'not_ready') {
      const now = ctx.manager.status(tool.server);
      return finish('not_ready', text(notReadyMessage(tool.server, now.state, now.detail), true));
    }
    if ((error as { code?: unknown }).code === -32021)
      return finish('input_required', text(NEEDS_INPUT_MESSAGE, true));
    const message = ctx.manager.redactFor(tool.server, (error as Error)?.message ?? String(error));
    return finish('failed', text(`The call to ${name} failed: ${message}`, true));
  }
}
