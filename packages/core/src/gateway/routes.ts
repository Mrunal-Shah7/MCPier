import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  API_PATHS,
  apiError,
  CLIENT_NAME_HEADER,
  CallToolRequestSchema,
  EditServerRequestSchema,
  ImportRequestSchema,
  jsonErrorMessage,
  parseImportBlock,
  referencedSecretNames,
  secretHint,
  SetSecretRequestSchema,
  splitFullToolName,
  validateConfig,
  type ApiErrorCode,
  type ImportCandidate,
  type ImportResponse,
  type McpierConfig,
  type SecretDeleteResponse,
  type SecretListResponse,
  type SecretSetResponse,
  type ServerDetailResponse,
  type ServerListResponse,
  type ServerLogResponse,
  type ServerRemovedResponse,
  type ServerResponse,
  type ToolCallResponse,
  type ToolListResponse,
  type ToolResponse,
  type ToolSearchResponse,
} from '@mcpier/shared';
import { readLastLines } from '../log-tail.js';
import { recordedBodies, SEARCH_LIMIT_MAX, searchTools } from '../meta/meta-tools.js';
import type { CallOutcomeKind } from '../meta/recorder.js';
import type { Logger } from '../logger.js';
import { ConflictError, InvalidRequestError, NotFoundError } from '../manager/errors.js';
import { OAuthFlowError } from '../oauth/service.js';
import { checkSecretName, checkSecretValue, SecretInputError } from '../platform/index.js';
import { serverLogPath } from '../upstream/server-log.js';
import { InvalidCursorError } from '../store/call-log.js';
import { CallTimeoutError } from '../upstream/types.js';
import type { AppServices } from './app.js';

type ErrorStatus = 400 | 404 | 409 | 500 | 502 | 504;

/** Maps an error thrown by a route to the standard error response. Unknown errors become 500. */
export function errorToResponse(c: Context, error: unknown, logger: Logger): Response {
  const send = (status: ErrorStatus, code: ApiErrorCode, message: string, problems?: readonly string[]) =>
    c.json(apiError(code, message, problems), status);
  if (error instanceof NotFoundError) return send(404, 'not_found', error.message);
  if (error instanceof ConflictError) return send(409, error.code as ApiErrorCode, error.message);
  if (error instanceof InvalidRequestError)
    return send(400, 'invalid_request', error.message, error.problems);
  if (error instanceof SecretInputError) return send(400, 'invalid_request', error.message);
  if (error instanceof InvalidCursorError) return send(400, 'invalid_request', error.message);
  if (error instanceof CallTimeoutError) return send(504, 'timeout', error.message);
  if (error instanceof OAuthFlowError) {
    if (error.code === 'not_oauth' && /^No server named/.test(error.message))
      return send(404, 'not_found', error.message);
    return send(error.httpStatus, error.httpStatus === 502 ? 'upstream_error' : 'conflict', error.message);
  }
  logger.error(
    { err: { message: (error as Error)?.message, stack: (error as Error)?.stack } },
    'request failed',
  );
  return send(500, 'internal_error', 'Internal error. See the gateway log for details.');
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InvalidRequestError('The request body must be JSON.');
  }
}

/** Validates one server entry on its own, with problems relative to the entry. */
function validateEntry(entry: unknown): void {
  const result = validateConfig({ servers: [entry] });
  if (!result.ok) {
    throw new InvalidRequestError(
      'The server entry is invalid.',
      result.problems.map((problem) => problem.replace(/^servers\[0\]\.?/, '') || problem),
    );
  }
}

/** Rewrites config-level problem paths (`servers[3].url`) to entry-level ones for one server. */
function entryProblems(error: unknown, index: number): never {
  if (error instanceof InvalidRequestError) {
    const prefix = `servers[${index}].`;
    throw new InvalidRequestError(
      'The server entry is invalid.',
      error.problems.map((problem) => (problem.startsWith(prefix) ? problem.slice(prefix.length) : problem)),
    );
  }
  throw error;
}

const STDIO_ONLY = ['command', 'args', 'env'];
const HTTP_ONLY = ['url', 'headers', 'auth', 'oauth'];

/** Replaces sensitive plain values in a response: they were pasted, and are not echoed. */
function hideSensitive(candidate: ImportCandidate): ImportCandidate {
  const entry = structuredClone(candidate.entry);
  for (const value of candidate.sensitive) {
    const map = entry[value.location === 'env' ? 'env' : 'headers'] as Record<string, string>;
    const original = map[value.key] ?? '';
    map[value.key] = `<hidden: ${original.length} characters>`;
  }
  return { ...candidate, entry };
}

export type RawCallRun =
  | { ok: true; outcome: CallOutcomeKind; result: Record<string, unknown>; durationMs: number }
  | {
      ok: false;
      outcome: CallOutcomeKind;
      durationMs: number;
      /** Readable and redacted. */
      message: string;
      /** The upstream server answered with an error (502), rather than MCPier refusing. */
      upstream: boolean;
      /** What the admin call route throws (mapped to the standard error response). */
      error: unknown;
    };

/**
 * A tool call through the admin API: no validation by MCPier, no truncation, no elicitation
 * offered (an upstream that asks anyway is shown as is). Recorded like a meta-tool call
 * (era `admin`) with the given client name.
 */
export async function rawToolCall(
  services: Pick<AppServices, 'manager' | 'meta'>,
  fullName: string,
  args: Record<string, unknown>,
  options: { client: string; signal?: AbortSignal },
): Promise<RawCallRun> {
  const { manager, meta } = services;
  const started = performance.now();
  const parts = splitFullToolName(fullName);
  const server = parts && manager.has(parts.server) ? parts.server : undefined;
  const elapsed = () => Math.round(performance.now() - started);
  const record = (outcome: CallOutcomeKind, result: unknown, errorText?: string) =>
    meta.recorder.toolCalled({
      at: new Date().toISOString(),
      client: { name: options.client },
      era: 'admin',
      tool: fullName,
      ...(server ? { server } : {}),
      durationMs: elapsed(),
      outcome,
      ...recordedBodies(meta, server, args, result),
      ...(errorText ? { errorText: server ? manager.redactFor(server, errorText) : errorText } : {}),
    });
  const refused = (outcome: CallOutcomeKind, error: unknown): RawCallRun => {
    const message = (error as Error)?.message ?? String(error);
    record(outcome, undefined, message);
    return {
      ok: false,
      outcome,
      durationMs: elapsed(),
      message: server ? manager.redactFor(server, message) : message,
      upstream: false,
      error,
    };
  };
  try {
    const outcome = await manager.callTool(fullName, args, { signal: options.signal });
    const result = (outcome.kind === 'result' ? outcome.result : outcome.inputRequired) as unknown as Record<
      string,
      unknown
    >;
    const kind: CallOutcomeKind =
      outcome.kind === 'input_required' ? 'input_required' : outcome.result.isError ? 'tool_error' : 'ok';
    record(kind, result);
    return { ok: true, outcome: kind, result, durationMs: outcome.durationMs };
  } catch (error) {
    if (error instanceof NotFoundError) return refused('not_found', error);
    if (error instanceof ConflictError) {
      return refused(
        error.code === 'disabled' ? 'disabled' : error.code === 'not_ready' ? 'not_ready' : 'failed',
        error,
      );
    }
    if (error instanceof CallTimeoutError) {
      return refused(options.signal?.aborted ? 'cancelled' : 'timeout', error);
    }
    // An error from the upstream server (bad arguments, unknown tool, transport failure).
    const name = parts?.server ?? '';
    const redacted = manager.redactFor(name, (error as Error)?.message ?? String(error));
    record('failed', undefined, redacted);
    return {
      ok: false,
      outcome: 'failed',
      durationMs: elapsed(),
      message: `The server "${name}" returned an error: ${redacted}`,
      upstream: true,
      error,
    };
  }
}

export function registerApiRoutes(app: Hono, services: AppServices, logger: Logger): void {
  const { manager, config, secrets, logsDir, closing, meta } = services;
  const serverIndex = (draft: McpierConfig, name: string): number => {
    const index = draft.servers.findIndex((server) => server.name === name);
    if (index < 0) throw new NotFoundError(`No server named "${name}".`);
    return index;
  };
  const requireServer = (name: string) => {
    if (!config.config.servers.some((server) => server.name === name)) {
      throw new NotFoundError(`No server named "${name}".`);
    }
  };

  // ---- Servers

  app.get('/api/servers', (c) => c.json({ servers: manager.summaries() } satisfies ServerListResponse));

  app.post('/api/servers', async (c) => {
    const body = await readJson(c);
    validateEntry(body);
    const name = (body as { name: string }).name;
    if (config.config.servers.some((server) => server.name === name)) {
      throw new ConflictError(`A server named "${name}" already exists.`, 'exists');
    }
    await config.update((draft) => {
      draft.servers.push(body as McpierConfig['servers'][number]);
    });
    return c.json({ server: manager.summary(name) } satisfies ServerResponse, 201);
  });

  app.get('/api/servers/:name', (c) => {
    const name = c.req.param('name');
    requireServer(name);
    const stored = config.config.servers.find((server) => server.name === name)!;
    return c.json({
      server: manager.summary(name),
      config: stored,
      tools: manager.tools(name),
    } satisfies ServerDetailResponse);
  });

  app.patch('/api/servers/:name', async (c) => {
    const name = c.req.param('name');
    const patch = EditServerRequestSchema.safeParse(await readJson(c));
    if (!patch.success) throw new InvalidRequestError('The body must be an object of fields to change.');
    if ('name' in patch.data && patch.data.name !== name) {
      throw new InvalidRequestError('A server cannot be renamed; remove it and add it again.');
    }
    let index = -1;
    await config
      .update((draft) => {
        index = serverIndex(draft, name);
        const stored = draft.servers[index] as unknown as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...stored };
        const newTransport = patch.data.transport;
        if (typeof newTransport === 'string' && newTransport !== stored.transport) {
          for (const field of newTransport === 'http' ? STDIO_ONLY : HTTP_ONLY) delete merged[field];
        }
        for (const [key, value] of Object.entries(patch.data)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        draft.servers[index] = merged as unknown as McpierConfig['servers'][number];
      })
      .catch((error: unknown) => entryProblems(error, index));
    return c.json({ server: manager.summary(name) } satisfies ServerResponse);
  });

  app.delete('/api/servers/:name', async (c) => {
    const name = c.req.param('name');
    await config.update((draft) => {
      serverIndex(draft, name);
      draft.servers = draft.servers.filter((server) => server.name !== name);
    });
    return c.json({ removed: name } satisfies ServerRemovedResponse);
  });

  const setEnabled = (name: string, enabled: boolean) =>
    config.update((draft) => {
      draft.servers[serverIndex(draft, name)]!.enabled = enabled;
    });

  // The group matters: Hono does not anchor a bare alternation, so `{start|…|refresh}` also
  // matched `/startx` and `/auth/refresh` (Sprint 5 BUGS B-1).
  app.post('/api/servers/:name/:action{(?:start|stop|restart|enable|disable|refresh)}', async (c) => {
    const name = c.req.param('name');
    const action = c.req.param('action');
    requireServer(name);
    if ((action === 'start' || action === 'restart') && !manager.summary(name).enabled) {
      throw new ConflictError(`Server "${name}" is disabled. Enable it to start it.`, 'disabled');
    }
    // start/restart answer at once with "starting"; callers poll the status.
    if (action === 'start') void manager.start(name).catch(() => {});
    else if (action === 'restart') {
      // Finish stopping first, so the answer already says "starting" for the new attempt.
      await manager.stop(name);
      void manager.start(name).catch(() => {});
    } else if (action === 'stop') await manager.stop(name);
    else if (action === 'enable') await setEnabled(name, true);
    else if (action === 'disable') await setEnabled(name, false);
    else if (action === 'refresh') await manager.refreshTools(name);
    return c.json({ server: manager.summary(name) } satisfies ServerResponse);
  });

  app.get('/api/servers/:name/logs', (c) => {
    const name = c.req.param('name');
    requireServer(name);
    const requested = Number(c.req.query('lines') ?? 100);
    const count = Number.isInteger(requested) && requested >= 0 ? Math.min(requested, 5000) : 100;
    const lines = readLastLines(serverLogPath(logsDir, name), count);
    return c.json({ server: name, lines } satisfies ServerLogResponse);
  });

  app.get('/api/servers/:name/logs/stream', (c) => {
    const name = c.req.param('name');
    requireServer(name);
    return streamSSE(c, async (stream) => {
      const onLine = (line: { server: string; line: string }) => {
        if (line.server === name) void stream.writeSSE({ event: 'line', data: line.line });
      };
      manager.on('log', onLine);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n'), 15_000);
      await stream.writeSSE({ event: 'ready', data: name });
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        if (closing.aborted) resolve();
        closing.addEventListener('abort', () => resolve(), { once: true });
      });
      clearInterval(keepAlive);
      manager.off('log', onLine);
    });
  });

  // ---- Import

  app.post('/api/import', async (c) => {
    const request = ImportRequestSchema.safeParse(await readJson(c));
    if (!request.success)
      throw new InvalidRequestError('The body must be { "source": …, "dryRun"?: boolean }.');
    let source = request.data.source;
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch (error) {
        throw new InvalidRequestError(`The pasted block is not valid JSON: ${jsonErrorMessage(error)}`);
      }
    }
    const parsed = parseImportBlock(
      source,
      config.config.servers.map((server) => server.name),
    );
    const entries: ImportCandidate[] = [];
    const errors = [...parsed.errors];
    for (const candidate of parsed.candidates) {
      const result = validateConfig({ servers: [candidate.entry] });
      if (result.ok) entries.push(candidate);
      else {
        errors.push({
          key: candidate.key,
          message: result.problems.map((problem) => problem.replace(/^servers\[0\]\.?/, '')).join('; '),
        });
      }
    }
    const dryRun = request.data.dryRun === true;
    if (!dryRun && entries.length > 0) {
      await config.update((draft) => {
        for (const candidate of entries)
          draft.servers.push(candidate.entry as McpierConfig['servers'][number]);
      });
    }
    const response: ImportResponse = {
      dryRun,
      shape: parsed.shape,
      // Pasted credential values are never echoed back, whether stored or not.
      entries: entries.map(hideSensitive),
      errors,
      created: dryRun ? [] : entries.map((candidate) => candidate.name),
    };
    return c.json(response, dryRun || entries.length === 0 ? 200 : 201);
  });

  // ---- Tools

  app.get('/api/tools', (c) => {
    const server = c.req.query('server');
    if (server) requireServer(server);
    return c.json({ tools: manager.tools(server || undefined) } satisfies ToolListResponse);
  });

  app.get(API_PATHS.toolSearch, (c) => {
    const limitText = c.req.query('limit');
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX)) {
      throw new InvalidRequestError(`"limit" must be a whole number from 1 to ${SEARCH_LIMIT_MAX}.`);
    }
    const server = c.req.query('server') || undefined;
    // Recorded like a meta-tool search, with the client the request names (the CLI says mcpier-cli).
    const result = searchTools(
      meta,
      {
        query: c.req.query('q') ?? '',
        ...(limit !== undefined ? { limit } : {}),
        ...(server ? { server } : {}),
      },
      { era: 'admin', client: { name: c.req.header(CLIENT_NAME_HEADER) || 'admin-api' } },
    );
    if (result.isError) {
      const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ');
      if (server && !manager.has(server)) throw new NotFoundError(text);
      throw new InvalidRequestError(text);
    }
    return c.json(result.structuredContent as unknown as ToolSearchResponse);
  });

  app.post('/api/tools/:fullName/:action{(?:enable|disable)}', async (c) => {
    const fullName = c.req.param('fullName');
    const enable = c.req.param('action') === 'enable';
    const tool = manager.tool(fullName);
    await config.update((draft) => {
      const entry = draft.servers[serverIndex(draft, tool.server)]!;
      const others = entry.disabledTools.filter((name) => name !== tool.name);
      entry.disabledTools = enable ? others : [...others, tool.name];
    });
    return c.json({ tool: manager.tool(fullName) } satisfies ToolResponse);
  });

  app.post('/api/tools/:fullName/call', async (c) => {
    const fullName = c.req.param('fullName');
    const request = CallToolRequestSchema.safeParse(await readJson(c));
    if (!request.success) throw new InvalidRequestError('The body must be { "arguments": { … } }.');
    // The dashboard's Tester has its own route; the CLI says mcpier-cli.
    const run = await rawToolCall(services, fullName, request.data.arguments, {
      client: c.req.header(CLIENT_NAME_HEADER) || 'admin-api',
      signal: c.req.raw.signal,
    });
    if (run.ok) return c.json({ result: run.result, durationMs: run.durationMs } satisfies ToolCallResponse);
    if (run.upstream) return c.json(apiError('upstream_error', run.message), 502);
    throw run.error;
  });

  // ---- Secrets

  const usage = () => {
    const usedBy = new Map<string, string[]>();
    for (const entry of config.config.servers) {
      for (const name of referencedSecretNames(entry))
        usedBy.set(name, [...(usedBy.get(name) ?? []), entry.name]);
    }
    return usedBy;
  };

  app.get('/api/secrets', async (c) => {
    const names = await secrets.listNames();
    const usedBy = usage();
    const list = await Promise.all(
      names.map(async (name) => {
        const value = await secrets.get(name);
        const hint = value === undefined ? undefined : secretHint(value);
        return { name, ...(hint ? { last4: hint } : {}), usedBy: usedBy.get(name) ?? [] };
      }),
    );
    const missing = [...usedBy.entries()]
      .filter(([name]) => !names.includes(name))
      .map(([name, servers]) => ({ name, usedBy: servers }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ secrets: list, missing } satisfies SecretListResponse);
  });

  app.put('/api/secrets/:name', async (c) => {
    const name = c.req.param('name');
    checkSecretName(name);
    const request = SetSecretRequestSchema.safeParse(await readJson(c));
    if (!request.success) throw new InvalidRequestError('The body must be { "value": "<secret>" }.');
    checkSecretValue(request.data.value);
    await secrets.set(name, request.data.value);
    logger.info({ secret: name }, 'Secret set');
    services.events.secretsChanged(await secrets.listNames());
    const restarted = await manager.restartReferencing(name);
    return c.json({ name, restarted } satisfies SecretSetResponse);
  });

  app.delete('/api/secrets/:name', async (c) => {
    const name = c.req.param('name');
    checkSecretName(name);
    const usedBy = usage().get(name) ?? [];
    if (usedBy.length > 0 && c.req.query('force') !== 'true') {
      throw new ConflictError(
        `Secret "${name}" is used by ${usedBy.map((server) => `"${server}"`).join(', ')}. ` +
          'Delete it anyway with force (those servers will stop with a missing-secret error).',
        'secret_in_use',
      );
    }
    const deleted = await secrets.delete(name);
    if (!deleted) throw new NotFoundError(`No secret named "${name}".`);
    logger.info({ secret: name }, 'Secret deleted');
    services.events.secretsChanged(await secrets.listNames());
    const restarted = await manager.restartReferencing(name);
    return c.json({ name, deleted, restarted } satisfies SecretDeleteResponse);
  });
}
