import { EventEmitter } from 'node:events';
import {
  CALL_BODY_LIMIT_BYTES,
  CALL_PAGE_SIZE_MAX,
  CALL_OUTCOME_NAMES,
  isErrorOutcome,
  SEARCH_FOLLOWUP_WINDOW_MS,
  SEARCH_FOLLOWUPS,
  type CallDetail,
  type CallListItem,
  type CallOutcomeName,
  type CallStatsResponse,
  type CallSummary,
  type ClientEraName,
  type SearchFollowup,
  type SearchSummary,
  type ServerCallStats,
  type Settings,
  type StoredBody,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { CallEvent, Recorder, SearchEvent } from '../meta/recorder.js';
import type { Db } from './database.js';

/** Writes are flushed at least this often. */
export const FLUSH_INTERVAL_MS = 250;
/** Retention and stale-search sweeps run this often. */
export const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Rows deleted per purge batch (the gateway gets a turn between batches). */
const PURGE_BATCH = 1000;
/** Longest error text kept with a call. */
const ERROR_TEXT_MAX = 500;
/** Largest page of calls or searches. */
export const PAGE_SIZE_MAX = CALL_PAGE_SIZE_MAX;

export interface CallLogOptions {
  settings: () => Settings;
  logger: Logger;
  now?: () => number;
  flushIntervalMs?: number;
  sweepIntervalMs?: number;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not valid. Start again from the first page.');
    this.name = 'InvalidCursorError';
  }
}

/** Cuts a text at `limit` UTF-8 bytes, on a character boundary, with a marker saying how much went. */
export function capBody(text: string, limit = CALL_BODY_LIMIT_BYTES): StoredBody {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  // Step back over continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const kept = bytes.subarray(0, end).toString('utf8');
  const dropped = bytes.length - end;
  return {
    text: `${kept}\n…[cut by MCPier: ${dropped} of ${bytes.length} bytes not stored]`,
    truncated: true,
  };
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return '"[not serializable]"';
  }
}

export interface CallFilter {
  /** ms since the epoch, inclusive. */
  from?: number;
  to?: number;
  server?: string;
  client?: string;
  outcome?: CallOutcomeName;
  /** A part of the full tool name. */
  tool?: string;
  cursor?: string;
  limit?: number;
}

export interface SearchFilter {
  from?: number;
  to?: number;
  client?: string;
  outcome?: SearchFollowup;
  cursor?: string;
  limit?: number;
}

interface CallRow {
  id: number;
  at: number;
  client_name: string | null;
  client_version: string | null;
  era: string;
  tool: string;
  server: string | null;
  duration_ms: number;
  outcome: string;
  trace_id: string | null;
  bodies_stored: number;
  arguments?: string | null;
  arguments_truncated?: number;
  result?: string | null;
  result_truncated?: number;
  error_text: string | null;
}

interface SearchRow {
  id: number;
  at: number;
  client_name: string | null;
  client_version: string | null;
  era: string;
  query: string;
  server: string | null;
  limit_n: number | null;
  result_count: number;
  results: string;
  duration_ms: number;
  followup: string;
  followup_call_id: number | null;
  hit_rank: number | null;
  called_tool: string | null;
}

type Queued =
  { kind: 'search'; event: SearchEvent } | { kind: 'call'; event: CallEvent; storeBodies: boolean };

const encodeCursor = (id: number) => Buffer.from(`c:${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^c:([1-9][0-9]{0,15})$/.exec(text);
  if (!match) throw new InvalidCursorError();
  return Number(match[1]);
}

const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * The call and search log in `mcpier.db` (SPEC 5.2, 8), and the gateway's `Recorder`.
 *
 * - **Writes never block a call:** events are queued and written in one transaction at least
 *   every 250 ms, and on `close()`.
 * - **Bodies:** whether they are stored is decided when the call is recorded (`storeCallBodies`
 *   at that moment). They arrive already redacted and are cut at 64 KB each.
 * - **Hit rate:** linking happens at write time, in recording order, using the events' own
 *   times. A call links the latest search from the same client (name, version, era) made after
 *   that client's previous call and within 5 minutes; it is a hit, with its rank, when the called
 *   tool was among the results, and a miss otherwise. The client's older unlinked searches become
 *   `none`. A search without a follow-up after 5 minutes is `none`.
 * - **Retention:** records older than `logRetentionDays` are purged at start, every hour and on
 *   demand, in batches of 1000 rows with a turn for the gateway in between.
 */
export class CallLog extends EventEmitter<{ recorded: [CallSummary] }> implements Recorder {
  private queue: Queued[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private purging: Promise<number> | undefined;
  private closed = false;
  private readonly now: () => number;

  private readonly insertCall;
  private readonly insertSearch;
  private readonly previousCallAt;
  private readonly latestOpenSearch;
  private readonly linkSearch;
  private readonly closeOlderSearches;

  constructor(
    readonly db: Db,
    private readonly options: CallLogOptions,
  ) {
    super();
    this.setMaxListeners(100);
    this.now = options.now ?? Date.now;
    this.insertCall = db.prepare(
      `INSERT INTO calls (at, client_name, client_version, era, tool, server, duration_ms, outcome, trace_id,
         bodies_stored, arguments, arguments_truncated, result, result_truncated, error_text)
       VALUES (@at, @client_name, @client_version, @era, @tool, @server, @duration_ms, @outcome, @trace_id,
         @bodies_stored, @arguments, @arguments_truncated, @result, @result_truncated, @error_text)`,
    );
    this.insertSearch = db.prepare(
      `INSERT INTO searches (at, client_name, client_version, era, query, server, limit_n, result_count, results, duration_ms)
       VALUES (@at, @client_name, @client_version, @era, @query, @server, @limit_n, @result_count, @results, @duration_ms)`,
    );
    this.previousCallAt = db.prepare(
      `SELECT MAX(at) AS at FROM calls
       WHERE client_name IS @client_name AND client_version IS @client_version AND era = @era AND id < @id`,
    );
    this.latestOpenSearch = db.prepare(
      `SELECT id, results FROM searches
       WHERE client_name IS @client_name AND client_version IS @client_version AND era = @era
         AND followup IS NULL AND at <= @at AND at >= @since
       ORDER BY at DESC, id DESC LIMIT 1`,
    );
    this.linkSearch = db.prepare(
      'UPDATE searches SET followup = @followup, followup_call_id = @call_id, hit_rank = @rank WHERE id = @id',
    );
    this.closeOlderSearches = db.prepare(
      `UPDATE searches SET followup = 'none'
       WHERE client_name IS @client_name AND client_version IS @client_version AND era = @era
         AND followup IS NULL AND at <= @at AND id <> @keep`,
    );
  }

  // ---- Recorder

  searchPerformed(event: SearchEvent): void {
    if (this.closed) return;
    this.queue.push({ kind: 'search', event });
    this.schedule();
  }

  toolCalled(event: CallEvent): void {
    if (this.closed) return;
    // The setting at the moment of the call decides; changing it applies to new calls only.
    this.queue.push({ kind: 'call', event, storeBodies: this.options.settings().storeCallBodies });
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.options.flushIntervalMs ?? FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /** Writes everything queued, in one transaction. Never throws. */
  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const recorded: CallSummary[] = [];
    try {
      this.db.transaction(() => {
        for (const item of batch) {
          if (item.kind === 'search') this.writeSearch(item.event);
          else recorded.push(this.writeCall(item.event, item.storeBodies));
        }
      })();
    } catch (error) {
      this.options.logger.warn(
        { err: { message: (error as Error)?.message }, dropped: batch.length },
        'Could not write to the call log',
      );
      return;
    }
    for (const summary of recorded) this.emit('recorded', summary);
  }

  private writeSearch(event: SearchEvent): void {
    this.insertSearch.run({
      at: Date.parse(event.at),
      client_name: event.client.name ?? null,
      client_version: event.client.version ?? null,
      era: event.era,
      query: event.query,
      server: event.server ?? null,
      limit_n: event.limit ?? null,
      result_count: event.resultCount,
      results: JSON.stringify(event.results),
      duration_ms: Math.round(event.durationMs),
    });
  }

  private writeCall(event: CallEvent, storeBodies: boolean): CallSummary {
    const at = Date.parse(event.at);
    const bodies =
      storeBodies && (event.arguments !== undefined || event.result !== undefined)
        ? { arguments: capBody(serialize(event.arguments ?? {})), result: capBody(serialize(event.result)) }
        : undefined;
    const errorText = event.errorText ? event.errorText.slice(0, ERROR_TEXT_MAX) : null;
    const client = { client_name: event.client.name ?? null, client_version: event.client.version ?? null };
    const info = this.insertCall.run({
      at,
      ...client,
      era: event.era,
      tool: event.tool,
      server: event.server ?? null,
      duration_ms: Math.round(event.durationMs),
      outcome: event.outcome,
      trace_id: event.traceId ?? null,
      bodies_stored: bodies ? 1 : 0,
      arguments: bodies?.arguments.text ?? null,
      arguments_truncated: bodies?.arguments.truncated ? 1 : 0,
      result: bodies?.result.text ?? null,
      result_truncated: bodies?.result.truncated ? 1 : 0,
      error_text: errorText,
    });
    const id = Number(info.lastInsertRowid);
    this.link(id, at, event.tool, { ...client, era: event.era });
    return {
      id,
      at: new Date(at).toISOString(),
      client: { ...event.client },
      era: event.era,
      tool: event.tool,
      ...(event.server ? { server: event.server } : {}),
      durationMs: Math.round(event.durationMs),
      outcome: event.outcome,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      bodiesStored: Boolean(bodies),
    };
  }

  /** The hit-rate link for one call (see the class comment). */
  private link(
    callId: number,
    at: number,
    tool: string,
    who: { client_name: string | null; client_version: string | null; era: string },
  ): void {
    const previous = (this.previousCallAt.get({ ...who, id: callId }) as { at: number | null }).at;
    const since = Math.max(at - SEARCH_FOLLOWUP_WINDOW_MS, previous === null ? -Infinity : previous + 1);
    const search = this.latestOpenSearch.get({ ...who, at, since: Number.isFinite(since) ? since : 0 }) as
      { id: number; results: string } | undefined;
    if (search) {
      const results = JSON.parse(search.results) as string[];
      const rank = results.indexOf(tool) + 1;
      this.linkSearch.run({
        id: search.id,
        call_id: callId,
        followup: rank > 0 ? 'hit' : 'miss',
        rank: rank > 0 ? rank : null,
      });
    }
    this.closeOlderSearches.run({ ...who, at, keep: search?.id ?? -1 });
  }

  // ---- Reading

  private toSummary(row: CallRow): CallListItem {
    return {
      id: row.id,
      at: new Date(row.at).toISOString(),
      client: {
        ...(row.client_name !== null ? { name: row.client_name } : {}),
        ...(row.client_version !== null ? { version: row.client_version } : {}),
      },
      era: row.era as ClientEraName,
      tool: row.tool,
      ...(row.server !== null ? { server: row.server } : {}),
      durationMs: row.duration_ms,
      outcome: row.outcome as CallOutcomeName,
      ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
      bodiesStored: row.bodies_stored === 1,
      ...(row.error_text !== null ? { errorText: row.error_text } : {}),
    };
  }

  /** Newest first, `limit` per page (at most 200), filtered; summaries only. */
  listCalls(filter: CallFilter = {}): { calls: CallListItem[]; nextCursor?: string } {
    this.flush();
    const before = decodeCursor(filter.cursor);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), PAGE_SIZE_MAX);
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: limit + 1 };
    const add = (clause: string, key: string, value: unknown) => {
      where.push(clause);
      params[key] = value;
    };
    if (before !== undefined) add('id < @before', 'before', before);
    if (filter.from !== undefined) add('at >= @from', 'from', filter.from);
    if (filter.to !== undefined) add('at <= @to', 'to', filter.to);
    if (filter.server) add('server = @server', 'server', filter.server);
    if (filter.client) add('client_name = @client', 'client', filter.client);
    if (filter.outcome) add('outcome = @outcome', 'outcome', filter.outcome);
    if (filter.tool) add("tool LIKE @tool ESCAPE '\\'", 'tool', likeContains(filter.tool));
    const rows = this.db
      .prepare(
        `SELECT id, at, client_name, client_version, era, tool, server, duration_ms, outcome, trace_id,
           bodies_stored, error_text
         FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT @limit`,
      )
      .all(params) as CallRow[];
    const page = rows.slice(0, limit).map((row) => this.toSummary(row));
    return rows.length > limit ? { calls: page, nextCursor: encodeCursor(page.at(-1)!.id) } : { calls: page };
  }

  /** One call with its stored bodies, or undefined. */
  getCall(id: number): CallDetail | undefined {
    this.flush();
    const row = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as CallRow | undefined;
    if (!row) return undefined;
    const detail: CallDetail = this.toSummary(row);
    if (row.bodies_stored === 1) {
      if (row.arguments != null)
        detail.arguments = { text: row.arguments, truncated: row.arguments_truncated === 1 };
      if (row.result != null) detail.result = { text: row.result, truncated: row.result_truncated === 1 };
    }
    return detail;
  }

  /** The effective follow-up: an unlinked search becomes `none` once its 5 minutes are up. */
  private followupSql(): string {
    return `COALESCE(s.followup, CASE WHEN s.at < @stale THEN 'none' ELSE 'pending' END)`;
  }

  listSearches(filter: SearchFilter = {}): { searches: SearchSummary[]; nextCursor?: string } {
    this.flush();
    const before = decodeCursor(filter.cursor);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), PAGE_SIZE_MAX);
    const where: string[] = [];
    const params: Record<string, unknown> = {
      limit: limit + 1,
      stale: this.now() - SEARCH_FOLLOWUP_WINDOW_MS,
    };
    const add = (clause: string, key: string, value: unknown) => {
      where.push(clause);
      params[key] = value;
    };
    if (before !== undefined) add('s.id < @before', 'before', before);
    if (filter.from !== undefined) add('s.at >= @from', 'from', filter.from);
    if (filter.to !== undefined) add('s.at <= @to', 'to', filter.to);
    if (filter.client) add('s.client_name = @client', 'client', filter.client);
    if (filter.outcome) add(`${this.followupSql()} = @outcome`, 'outcome', filter.outcome);
    const rows = this.db
      .prepare(
        `SELECT s.id, s.at, s.client_name, s.client_version, s.era, s.query, s.server, s.limit_n, s.result_count,
           s.results, s.duration_ms, ${this.followupSql()} AS followup, s.followup_call_id, s.hit_rank,
           c.tool AS called_tool
         FROM searches s LEFT JOIN calls c ON c.id = s.followup_call_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.id DESC LIMIT @limit`,
      )
      .all(params) as SearchRow[];
    const page = rows.slice(0, limit).map((row): SearchSummary => ({
      id: row.id,
      at: new Date(row.at).toISOString(),
      client: {
        ...(row.client_name !== null ? { name: row.client_name } : {}),
        ...(row.client_version !== null ? { version: row.client_version } : {}),
      },
      era: row.era as ClientEraName,
      query: row.query,
      ...(row.server !== null ? { server: row.server } : {}),
      ...(row.limit_n !== null ? { limit: row.limit_n } : {}),
      resultCount: row.result_count,
      results: JSON.parse(row.results) as string[],
      durationMs: row.duration_ms,
      followup: row.followup as SearchFollowup,
      ...(row.followup_call_id !== null ? { followupCallId: row.followup_call_id } : {}),
      ...(row.called_tool !== null ? { calledTool: row.called_tool } : {}),
      ...(row.hit_rank !== null ? { rank: row.hit_rank } : {}),
    }));
    return rows.length > limit
      ? { searches: page, nextCursor: encodeCursor(page.at(-1)!.id) }
      : { searches: page };
  }

  /** Calls per server and outcome, error rate, durations, searches and hit rate, recent misses. */
  stats(range: { from?: number; to?: number } = {}): CallStatsResponse {
    this.flush();
    const params = {
      from: range.from ?? 0,
      to: range.to ?? Number.MAX_SAFE_INTEGER,
      stale: this.now() - SEARCH_FOLLOWUP_WINDOW_MS,
    };
    const calls = this.db
      .prepare('SELECT server, outcome, duration_ms FROM calls WHERE at >= @from AND at <= @to')
      .all(params) as { server: string | null; outcome: CallOutcomeName; duration_ms: number }[];
    const byOutcome: Partial<Record<CallOutcomeName, number>> = {};
    const perServer = new Map<string, { durations: number[]; errors: number }>();
    const all: number[] = [];
    let errors = 0;
    for (const call of calls) {
      byOutcome[call.outcome] = (byOutcome[call.outcome] ?? 0) + 1;
      const failed = isErrorOutcome(call.outcome);
      if (failed) errors++;
      all.push(call.duration_ms);
      const key = call.server ?? '(unknown)';
      const entry = perServer.get(key) ?? { durations: [], errors: 0 };
      entry.durations.push(call.duration_ms);
      if (failed) entry.errors++;
      perServer.set(key, entry);
    }
    all.sort((a, b) => a - b);
    const byServer: ServerCallStats[] = [...perServer.entries()]
      .map(([server, entry]) => {
        const sorted = entry.durations.sort((a, b) => a - b);
        return {
          server,
          calls: sorted.length,
          errors: entry.errors,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));

    const followups = this.db
      .prepare(
        `SELECT ${this.followupSql()} AS followup, COUNT(*) AS n FROM searches s
         WHERE s.at >= @from AND s.at <= @to GROUP BY 1`,
      )
      .all(params) as { followup: SearchFollowup; n: number }[];
    const count = (kind: SearchFollowup) => followups.find((row) => row.followup === kind)?.n ?? 0;
    const hits = count('hit');
    const misses = count('miss');
    const misses20 = this.db
      .prepare(
        `SELECT s.id, s.at, s.query, s.results, c.tool FROM searches s JOIN calls c ON c.id = s.followup_call_id
         WHERE s.followup = 'miss' AND s.at >= @from AND s.at <= @to ORDER BY s.at DESC, s.id DESC LIMIT 20`,
      )
      .all(params) as { id: number; at: number; query: string; results: string; tool: string }[];

    return {
      ...(range.from !== undefined ? { from: new Date(range.from).toISOString() } : {}),
      ...(range.to !== undefined ? { to: new Date(range.to).toISOString() } : {}),
      calls: {
        total: calls.length,
        errors,
        errorRate: calls.length > 0 ? errors / calls.length : null,
        p50Ms: all.length > 0 ? percentile(all, 0.5) : null,
        p95Ms: all.length > 0 ? percentile(all, 0.95) : null,
        byOutcome,
        byServer,
      },
      searches: {
        total: SEARCH_FOLLOWUPS.reduce((sum, kind) => sum + count(kind), 0),
        hits,
        misses,
        none: count('none'),
        pending: count('pending'),
        hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
      },
      recentMisses: misses20.map((row) => ({
        searchId: row.id,
        at: new Date(row.at).toISOString(),
        query: row.query,
        results: JSON.parse(row.results) as string[],
        calledTool: row.tool,
      })),
    };
  }

  // ---- Upkeep

  /** Deletes every call and search (the tool cache stays). */
  clear(): { deletedCalls: number; deletedSearches: number } {
    this.flush();
    return this.db.transaction(() => ({
      deletedCalls: this.db.prepare('DELETE FROM calls').run().changes,
      deletedSearches: this.db.prepare('DELETE FROM searches').run().changes,
    }))();
  }

  /**
   * Deletes records older than `logRetentionDays`, in batches of 1000 with a turn for the
   * gateway between them; also closes unlinked searches older than 5 minutes. Concurrent calls
   * share one run.
   */
  purge(): Promise<number> {
    this.purging ??= this.runPurge().finally(() => {
      this.purging = undefined;
    });
    return this.purging;
  }

  private async runPurge(): Promise<number> {
    this.flush();
    const cutoff = this.now() - this.options.settings().logRetentionDays * 86_400_000;
    let deleted = 0;
    for (const table of ['calls', 'searches']) {
      const statement = this.db.prepare(
        `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE at < ? LIMIT ${PURGE_BATCH})`,
      );
      for (;;) {
        if (this.closed) return deleted;
        const changes = statement.run(cutoff).changes;
        deleted += changes;
        if (changes < PURGE_BATCH) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (!this.closed) {
      this.db
        .prepare(`UPDATE searches SET followup = 'none' WHERE followup IS NULL AND at < ?`)
        .run(this.now() - SEARCH_FOLLOWUP_WINDOW_MS);
    }
    if (deleted > 0) this.options.logger.info({ deleted }, 'Call log: old records removed');
    return deleted;
  }

  /** Purges now and then every hour. */
  startSweeps(): void {
    void this.purge().catch((error: unknown) =>
      this.options.logger.warn({ err: { message: (error as Error).message } }, 'Call log purge failed'),
    );
    this.sweepTimer = setInterval(() => {
      void this.purge().catch(() => {});
    }, this.options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Writes what is queued and stops the timers. The database stays open (the owner closes it). */
  async close(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    clearInterval(this.sweepTimer);
    this.flush();
    this.closed = true;
    await this.purging?.catch(() => {});
    this.removeAllListeners();
  }
}

export const KNOWN_CALL_OUTCOMES: readonly string[] = CALL_OUTCOME_NAMES;
