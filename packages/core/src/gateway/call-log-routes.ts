// The call log, search log, stats, argument validation and the Tester (Sprint 6). Lists and
// the stats never carry bodies; one call's detail carries its stored (already redacted)
// arguments and result.
import type { Context, Hono } from 'hono';
import {
  CALL_LOG_PATHS,
  CALL_OUTCOME_NAMES,
  CALL_PAGE_SIZE_MAX,
  SEARCH_FOLLOWUPS,
  TESTER_CLIENT_NAME,
  TesterCallRequestSchema,
  USAGE_BUCKETS,
  USAGE_PATH,
  USAGE_RANGES,
  ValidateArgumentsRequestSchema,
  type UsageBucket,
  type UsageRangeName,
  type UsageResponse,
  type CallListResponse,
  type CallOutcomeName,
  type CallStatsResponse,
  type ClearCallLogResponse,
  type SearchFollowup,
  type SearchListResponse,
  type TesterCallResponse,
  type ValidateArgumentsResponse,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import { ConflictError, InvalidRequestError, NotFoundError } from '../manager/errors.js';
import { runCallTool } from '../meta/meta-tools.js';
import type { CallLog } from '../store/call-log.js';
import { rangeBounds } from '../store/usage.js';
import { isInputRequired } from '../upstream/types.js';
import type { AppServices } from './app.js';
import { rawToolCall } from './routes.js';

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InvalidRequestError('The request body must be JSON.');
  }
}

/** `from` / `to`: an ISO 8601 time (or milliseconds since 1970). */
function timeParam(c: Context, name: 'from' | 'to'): number | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new InvalidRequestError(`"${name}" must be a time in ISO 8601 form, such as 2026-10-17T09:00:00Z.`);
  }
  return ms;
}

function limitParam(c: Context): number | undefined {
  const value = c.req.query('limit');
  if (value === undefined || value === '') return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > CALL_PAGE_SIZE_MAX) {
    throw new InvalidRequestError(`"limit" must be a whole number from 1 to ${CALL_PAGE_SIZE_MAX}.`);
  }
  return limit;
}

function choiceParam<T extends string>(c: Context, name: string, allowed: readonly T[]): T | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidRequestError(`"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function textParam(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  return value === undefined || value === '' ? undefined : value;
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

export function registerCallLogRoutes(app: Hono, services: AppServices, _logger: Logger): void {
  const { manager, meta } = services;

  /** The call log, or a clear error when `mcpier.db` could not be used (the log recorder took over). */
  const log = (): CallLog => {
    if (services.callLog) return services.callLog;
    const problem = services.status().callLog?.problem;
    throw new ConflictError(
      `The call log is not available${problem ? `: ${problem}` : ''}. Calls are recorded in the gateway log ` +
        'instead (metadata only). Run mcpier doctor for details.',
      'conflict',
    );
  };

  // ---- Calls. `stats` is registered first and ids are digits only, so the two never overlap.

  app.get(CALL_LOG_PATHS.stats, (c) => {
    const from = timeParam(c, 'from');
    const to = timeParam(c, 'to');
    const stats = log().stats({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
    const body: CallStatsResponse = {
      ...stats,
      ...(from !== undefined ? { from: iso(from) } : {}),
      ...(to !== undefined ? { to: iso(to) } : {}),
    };
    return c.json(body);
  });

  app.get(CALL_LOG_PATHS.calls, (c) => {
    const from = timeParam(c, 'from');
    const to = timeParam(c, 'to');
    const limit = limitParam(c);
    const outcome = choiceParam<CallOutcomeName>(c, 'outcome', CALL_OUTCOME_NAMES);
    const filter = {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(outcome ? { outcome } : {}),
      ...(textParam(c, 'server') ? { server: textParam(c, 'server') } : {}),
      ...(textParam(c, 'client') ? { client: textParam(c, 'client') } : {}),
      ...(textParam(c, 'tool') ? { tool: textParam(c, 'tool') } : {}),
      ...(textParam(c, 'cursor') ? { cursor: textParam(c, 'cursor') } : {}),
    };
    return c.json(log().listCalls(filter) satisfies CallListResponse);
  });

  app.get(`${CALL_LOG_PATHS.calls}/:id{[0-9]+}`, (c) => {
    const id = Number(c.req.param('id') ?? '');
    const call = Number.isSafeInteger(id) ? log().getCall(id) : undefined;
    if (!call) throw new NotFoundError(`No call with id ${c.req.param('id') ?? ''} in the call log.`);
    return c.json(call);
  });

  app.delete(CALL_LOG_PATHS.calls, (c) => {
    if (c.req.query('confirm') !== 'true') {
      throw new InvalidRequestError(
        'Clearing the call log deletes every recorded call and search. Send confirm=true to clear it.',
      );
    }
    return c.json(log().clear() satisfies ClearCallLogResponse);
  });

  // ---- Usage: `range=24h|7d|30d`, or `from`, `to` and `bucket=hour|day`; optional `server`.

  app.get(USAGE_PATH, (c) => {
    const rangeName = choiceParam<UsageRangeName>(c, 'range', Object.keys(USAGE_RANGES) as UsageRangeName[]);
    const from = timeParam(c, 'from');
    const to = timeParam(c, 'to');
    const bucketParam = choiceParam<UsageBucket>(c, 'bucket', USAGE_BUCKETS);
    let bounds: { from: number; to: number; bucket: UsageBucket };
    if (rangeName) {
      if (from !== undefined || to !== undefined) {
        throw new InvalidRequestError('Give either "range", or "from" and "to", not both.');
      }
      bounds = rangeBounds(rangeName, log().clock());
      if (bucketParam) bounds.bucket = bucketParam;
    } else {
      if (from === undefined) {
        throw new InvalidRequestError('Give "range" (24h, 7d or 30d), or "from" (and optionally "to").');
      }
      const end = to ?? log().clock();
      if (end < from) throw new InvalidRequestError('"to" must not be before "from".');
      bounds = { from, to: end, bucket: bucketParam ?? (end - from <= 2 * 86_400_000 ? 'hour' : 'day') };
    }
    const span = bounds.to - bounds.from;
    if (bounds.bucket === 'hour' && span > 31 * 86_400_000) {
      throw new InvalidRequestError('Hourly buckets cover at most 31 days; use "bucket=day".');
    }
    const server = textParam(c, 'server');
    const tools = textParam(c, 'tools');
    if (tools !== undefined && tools !== 'all') throw new InvalidRequestError('"tools" can only be "all".');
    const body: UsageResponse = log().usage({
      ...bounds,
      ...(server ? { server } : {}),
      ...(tools === 'all' ? { allTools: true } : {}),
    });
    return c.json(body);
  });

  // ---- Searches

  app.get(CALL_LOG_PATHS.searches, (c) => {
    const from = timeParam(c, 'from');
    const to = timeParam(c, 'to');
    const limit = limitParam(c);
    const outcome = choiceParam<SearchFollowup>(c, 'outcome', SEARCH_FOLLOWUPS);
    const filter = {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(outcome ? { outcome } : {}),
      ...(textParam(c, 'client') ? { client: textParam(c, 'client') } : {}),
      ...(textParam(c, 'cursor') ? { cursor: textParam(c, 'cursor') } : {}),
    };
    return c.json(log().listSearches(filter) satisfies SearchListResponse);
  });

  // ---- Validation (the dashboard never compiles a schema itself: D-067)

  app.post(CALL_LOG_PATHS.validate(':fullName'), async (c) => {
    const request = ValidateArgumentsRequestSchema.safeParse(await readJson(c));
    if (!request.success) throw new InvalidRequestError('The body must be { "arguments": { … } }.');
    const tool = manager.tool(c.req.param('fullName') ?? '');
    const result = meta.validator.validate(tool.fullName, tool.inputSchema, request.data.arguments);
    let body: ValidateArgumentsResponse;
    if (!result.ok) body = { result: 'invalid', problems: result.issues };
    else if (result.skipped !== undefined) body = { result: 'not_validated', reason: result.skipped };
    else body = { result: 'valid' };
    return c.json(body);
  });

  // ---- The Tester

  app.post(CALL_LOG_PATHS.test(':fullName'), async (c) => {
    const fullName = c.req.param('fullName') ?? '';
    const request = TesterCallRequestSchema.safeParse(await readJson(c));
    if (!request.success) {
      throw new InvalidRequestError(
        'The body must be { "mode": "model" | "raw", "arguments": { … }, "inputResponses"?: { … }, "requestState"?: "…" }.',
      );
    }
    const { mode, arguments: args, inputResponses, requestState } = request.data;

    if (mode === 'raw') {
      if (inputResponses !== undefined || requestState !== undefined) {
        throw new InvalidRequestError('Answers to input requests are only sent in model mode.');
      }
      const run = await rawToolCall(services, fullName, args, {
        client: TESTER_CLIENT_NAME,
        signal: c.req.raw.signal,
      });
      const body: TesterCallResponse = run.ok
        ? {
            mode,
            outcome: run.outcome,
            durationMs: run.durationMs,
            // No retry is offered in raw mode, so the upstream's own state is not passed on.
            result: isInputRequired(run.result)
              ? { resultType: run.result.resultType, inputRequests: run.result.inputRequests }
              : run.result,
          }
        : { mode, outcome: run.outcome, durationMs: run.durationMs, error: run.message };
      return c.json(body);
    }

    // Model mode: the call_tool code path. The Tester answers form elicitations itself, so it
    // declares that capability; the signed requestState comes back on the retry unchanged.
    const run = await runCallTool(
      meta,
      { name: fullName, arguments: args },
      {
        era: 'admin',
        client: { name: TESTER_CLIENT_NAME },
        elicitation: { form: {} },
        signal: c.req.raw.signal,
        ...(inputResponses !== undefined ? { inputResponses } : {}),
        ...(requestState !== undefined ? { requestState } : {}),
      },
    );
    const body: TesterCallResponse = {
      mode,
      outcome: run.outcome,
      durationMs: run.durationMs,
      result: run.result as unknown as Record<string, unknown>,
      ...(run.truncation ? { truncation: run.truncation } : {}),
    };
    return c.json(body);
  });
}
