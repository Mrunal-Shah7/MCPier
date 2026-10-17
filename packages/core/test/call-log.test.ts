// Sprint 6, Phase 1: mcpier.db, its migrations and recovery, the call log (bodies, the
// 64 KB cap, hit-rate linking, retention, batched writes) and its query speed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type Settings } from '@mcpier/shared';
import {
  CallLog,
  capBody,
  createGatewayLogger,
  InvalidCursorError,
  migrate,
  openDatabase,
  openGatewayStore,
  SCHEMA_VERSION,
  SqliteToolCache,
  type CallEvent,
  type Db,
  type GatewayLogger,
  type SearchEvent,
} from '../src/index.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

let home: TempHome;
let log: GatewayLogger;
let logFile: string;
let file: string;
let settings: Settings;
let clock: number;
const open: Db[] = [];

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  home = createTempHome();
  mkdirSync(home.dir, { recursive: true });
  logFile = join(home.dir, '..', 'test.log');
  log = createGatewayLogger({ file: logFile });
  file = join(home.dir, 'mcpier.db');
  settings = defaultConfig().settings;
  clock = T0;
});

afterEach(async () => {
  for (const db of open.splice(0)) if (db.open) db.close();
  log.close();
  await home.cleanup();
});

function newLog(options: { flushIntervalMs?: number; sweepIntervalMs?: number } = {}) {
  const opened = openDatabase(file, log.logger);
  open.push(opened.db!);
  return new CallLog(opened.db!, {
    settings: () => settings,
    logger: log.logger,
    now: () => clock,
    flushIntervalMs: options.flushIntervalMs ?? 10_000,
    ...(options.sweepIntervalMs ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
  });
}

function call(at: number, extra: Partial<CallEvent> = {}): CallEvent {
  return {
    at: iso(at),
    client: { name: 'agent', version: '1.0' },
    era: 'modern',
    tool: 'files__read_file',
    server: 'files',
    durationMs: 12,
    outcome: 'ok',
    arguments: { path: 'a.txt' },
    result: { content: [{ type: 'text', text: 'hello' }] },
    ...extra,
  };
}

function search(at: number, results: string[], extra: Partial<SearchEvent> = {}): SearchEvent {
  return {
    at: iso(at),
    client: { name: 'agent', version: '1.0' },
    era: 'modern',
    query: 'read a file',
    limit: 5,
    resultCount: results.length,
    results,
    durationMs: 3,
    ...extra,
  };
}

describe('mcpier.db', () => {
  it('creates a new database in WAL mode at the current schema version', () => {
    const opened = openDatabase(file, log.logger);
    open.push(opened.db!);
    expect(opened.problem).toBeUndefined();
    expect(opened.db!.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(opened.db!.prepare('SELECT version FROM schema_version').get()).toEqual({
      version: SCHEMA_VERSION,
    });
    const tables = (
      opened.db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual(expect.arrayContaining(['calls', 'schema_version', 'searches', 'tool_cache']));
    const indexes = (
      opened.db!.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'calls_at',
        'calls_server_at',
        'calls_client_at',
        'calls_outcome_at',
        'calls_tool',
      ]),
    );
  });

  it('reopens an existing database without losing data, and migrates one without a version table', () => {
    const first = newLog();
    first.toolCalled(call(T0));
    first.flush();
    open.pop()!.close();
    const again = newLog();
    expect(again.listCalls().calls).toHaveLength(1);
    open.pop()!.close();

    // A file at version 0 (an empty SQLite database) gets every migration; one at the current
    // version gets none, and migrating it again is harmless.
    const legacy = openDatabase(join(home.dir, 'old.db'), log.logger).db!;
    open.push(legacy);
    legacy.exec(
      'DROP TABLE calls; DROP TABLE searches; DROP TABLE tool_cache; UPDATE schema_version SET version = 0',
    );
    expect(migrate(legacy)).toBe(SCHEMA_VERSION);
    expect(legacy.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({ n: 0 });
    expect(migrate(legacy)).toBe(SCHEMA_VERSION);
    expect(legacy.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 1 });
  });

  it('moves a corrupt file (and its WAL) aside, starts a new one, and logs one line', () => {
    writeFileSync(file, 'this is not a database, just text that looks nothing like SQLite');
    writeFileSync(`${file}-wal`, 'stale wal');
    const opened = openDatabase(file, log.logger);
    open.push(opened.db!);
    expect(opened.db).toBeDefined();
    expect(opened.movedTo).toMatch(/mcpier\.db\.corrupt-/);
    // SQLite itself deletes the unusable WAL when the failed connection closes; either way the
    // stale WAL is never replayed into the new database.
    const names = readdirSync(home.dir);
    expect(names.filter((name) => name.includes('.corrupt-'))).toContain(
      opened.movedTo!.split(/[\\/]/).pop(),
    );
    for (const name of names) {
      if (name.startsWith('mcpier.db') && !name.includes('.corrupt-')) {
        expect(readFileSync(join(home.dir, name)).toString('latin1')).not.toContain('stale wal');
      }
    }
    expect(opened.db!.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({ n: 0 });
    expect(readFileSync(logFile, 'utf8').match(/moved aside and created a new one/g)).toHaveLength(1);
  });

  it('falls back to the log recorder when the database cannot be opened at all', () => {
    const store = openGatewayStore({
      file,
      logger: log.logger,
      settings: () => settings,
      opener: () => {
        throw new Error('disk says no');
      },
    });
    expect(store.state.store).toBe('log');
    expect(store.state.problem).toContain('disk says no');
    expect(store.callLog).toBeUndefined();
    store.recorder.toolCalled(call(T0, { arguments: { secret: 'ARG-SECRET' } }));
    const text = readFileSync(logFile, 'utf8');
    expect(text).toContain('"event":"call"');
    // The fallback keeps metadata only.
    expect(text).not.toContain('ARG-SECRET');
    expect(text).toContain('The call log is not available');
  });
});

describe('recording calls', () => {
  it('stores bodies when the setting is on, metadata only when it is off (decided at call time)', () => {
    const calls = newLog();
    calls.toolCalled(call(T0));
    settings = { ...settings, storeCallBodies: false };
    calls.toolCalled(call(T0 + 1, { arguments: { path: 'private.txt' } }));
    settings = { ...settings, storeCallBodies: true };
    calls.flush();
    const [second, first] = calls.listCalls().calls;
    expect(first!.bodiesStored).toBe(true);
    expect(calls.getCall(first!.id)).toMatchObject({
      arguments: { text: '{"path":"a.txt"}', truncated: false },
      result: { text: '{"content":[{"type":"text","text":"hello"}]}', truncated: false },
    });
    expect(second!.bodiesStored).toBe(false);
    const detail = calls.getCall(second!.id)!;
    expect(detail.arguments).toBeUndefined();
    expect(detail.result).toBeUndefined();
    const raw =
      readFileSync(file).toString('latin1') +
      (existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`).toString('latin1') : '');
    expect(raw).not.toContain('private.txt');
  });

  it('cuts each body at 64 KB on a character boundary, with a marker', () => {
    const body = 'é'.repeat(40_000); // 80,000 bytes in UTF-8
    const capped = capBody(JSON.stringify(body));
    expect(capped.truncated).toBe(true);
    expect(capped.text).toMatch(/…\[cut by MCPier: \d+ of 80002 bytes not stored\]$/);
    expect(capped.text).not.toContain('�');
    expect(Buffer.byteLength(capped.text.split('\n…[cut')[0]!, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(capBody('{"small":true}')).toEqual({ text: '{"small":true}', truncated: false });

    const calls = newLog();
    calls.toolCalled(call(T0, { result: { content: [{ type: 'text', text: 'x'.repeat(100_000) }] } }));
    calls.flush();
    const detail = calls.getCall(calls.listCalls().calls[0]!.id)!;
    expect(detail.result!.truncated).toBe(true);
    expect(detail.arguments!.truncated).toBe(false);
  });

  it('keeps a short error text for failed outcomes', () => {
    const calls = newLog();
    calls.toolCalled(call(T0, { outcome: 'failed', errorText: `boom ${'z'.repeat(1000)}` }));
    calls.flush();
    const [item] = calls.listCalls().calls;
    expect(item!.errorText!.startsWith('boom ')).toBe(true);
    expect(item!.errorText!.length).toBe(500);
  });

  it('writes in batches: nothing before the flush interval, everything after, and on close', async () => {
    const calls = newLog({ flushIntervalMs: 40 });
    const db = open.at(-1)!;
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM calls').get() as { n: number }).n;
    for (let i = 0; i < 5; i++) calls.toolCalled(call(T0 + i));
    expect(count()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(count()).toBe(5);
    calls.toolCalled(call(T0 + 10));
    await calls.close();
    expect(count()).toBe(6);
  });

  it('emits each recorded call as a summary, without bodies', () => {
    const calls = newLog();
    const seen: unknown[] = [];
    calls.on('recorded', (summary) => seen.push(summary));
    calls.toolCalled(call(T0, { outcome: 'failed', errorText: 'nope' }));
    calls.flush();
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(
      ['at', 'bodiesStored', 'client', 'durationMs', 'era', 'id', 'outcome', 'server', 'tool'].sort(),
    );
  });
});

describe('hit-rate linking', () => {
  const tools = ['files__read_file', 'files__write_file', 'files__list'];

  it('a call to a returned tool is a hit with its rank; another tool is a miss', () => {
    const calls = newLog();
    calls.searchPerformed(search(T0, tools));
    calls.toolCalled(call(T0 + 10_000, { tool: 'files__write_file' }));
    calls.searchPerformed(search(T0 + 20_000, tools));
    calls.toolCalled(call(T0 + 30_000, { tool: 'github__create_issue' }));
    const [miss, hit] = calls.listSearches().searches;
    expect(hit).toMatchObject({ followup: 'hit', rank: 2, calledTool: 'files__write_file' });
    expect(miss).toMatchObject({ followup: 'miss', calledTool: 'github__create_issue' });
    expect(miss!.rank).toBeUndefined();
  });

  it('no follow-up within 5 minutes is none; until then it is pending', () => {
    const calls = newLog();
    calls.searchPerformed(search(T0, tools));
    clock = T0 + 60_000;
    expect(calls.listSearches().searches[0]!.followup).toBe('pending');
    calls.toolCalled(call(T0 + 5 * 60_000 + 1));
    clock = T0 + 6 * 60_000;
    expect(calls.listSearches().searches[0]!.followup).toBe('none');
    expect(calls.stats().searches).toMatchObject({ hits: 0, misses: 0, none: 1, hitRate: null });
  });

  it('only the next call links: search Z, search A, call, call', () => {
    const calls = newLog();
    calls.searchPerformed(search(T0, ['x__z'], { query: 'Z' }));
    calls.searchPerformed(search(T0 + 1000, tools, { query: 'A' }));
    calls.toolCalled(call(T0 + 2000, { tool: 'files__read_file' }));
    calls.toolCalled(call(T0 + 3000, { tool: 'x__z' }));
    const byQuery = Object.fromEntries(calls.listSearches().searches.map((s) => [s.query, s]));
    expect(byQuery.A).toMatchObject({ followup: 'hit', rank: 1 });
    // Z's next call was the first one (A got it); the second call must not claim Z.
    expect(byQuery.Z).toMatchObject({ followup: 'none' });
  });

  it('different clients, versions and eras are never linked; a client without a version is', () => {
    const calls = newLog();
    calls.searchPerformed(search(T0, tools, { client: { name: 'agent', version: '1.0' } }));
    calls.toolCalled(call(T0 + 1000, { client: { name: 'other', version: '1.0' } }));
    calls.toolCalled(call(T0 + 1000, { client: { name: 'agent', version: '2.0' } }));
    calls.toolCalled(call(T0 + 1000, { era: 'legacy' }));
    expect(calls.listSearches().searches[0]!.followup).toBe('pending');
    calls.searchPerformed(search(T0 + 2000, tools, { client: { name: 'noversion' } }));
    calls.toolCalled(call(T0 + 3000, { client: { name: 'noversion' } }));
    const [unversioned] = calls.listSearches({ client: 'noversion' }).searches;
    expect(unversioned).toMatchObject({ followup: 'hit', rank: 1 });
  });

  it('stats: hit rate, recent misses with the tool called instead, durations and outcomes', () => {
    const calls = newLog();
    calls.searchPerformed(search(T0, tools));
    calls.toolCalled(call(T0 + 1, { tool: 'files__read_file', durationMs: 10 }));
    calls.searchPerformed(search(T0 + 2, tools, { query: 'make an issue' }));
    calls.toolCalled(
      call(T0 + 3, {
        tool: 'github__create_issue',
        server: 'github',
        outcome: 'tool_error',
        durationMs: 100,
      }),
    );
    const stats = calls.stats();
    expect(stats.searches).toMatchObject({ total: 2, hits: 1, misses: 1, hitRate: 0.5 });
    expect(stats.recentMisses).toEqual([
      expect.objectContaining({ query: 'make an issue', results: tools, calledTool: 'github__create_issue' }),
    ]);
    expect(stats.calls).toMatchObject({
      total: 2,
      errors: 1,
      errorRate: 0.5,
      byOutcome: { ok: 1, tool_error: 1 },
    });
    expect(stats.calls.byServer.map((s) => s.server).sort()).toEqual(['files', 'github']);
    const empty = calls.stats({ from: T0 + 10_000, to: T0 + 20_000 });
    expect(empty.calls).toMatchObject({ total: 0, errorRate: null, p50Ms: null });
    expect(empty.searches.hitRate).toBeNull();
  });
});

describe('listing', () => {
  it('pages newest first with a cursor, filters, and refuses a bad cursor', () => {
    const calls = newLog();
    for (let i = 0; i < 25; i++) {
      calls.toolCalled(
        call(T0 + i, {
          tool: i % 2 ? 'files__read_file' : 'github__get_me',
          server: i % 2 ? 'files' : 'github',
          outcome: i % 5 === 0 ? 'failed' : 'ok',
        }),
      );
    }
    const first = calls.listCalls({ limit: 10 });
    expect(first.calls).toHaveLength(10);
    expect(first.calls[0]!.at > first.calls[9]!.at).toBe(true);
    const second = calls.listCalls({ limit: 10, cursor: first.nextCursor });
    const third = calls.listCalls({ limit: 10, cursor: second.nextCursor });
    expect(third.calls).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
    const ids = [...first.calls, ...second.calls, ...third.calls].map((c) => c.id);
    expect(new Set(ids).size).toBe(25);
    expect(calls.listCalls({ server: 'github' }).calls.every((c) => c.server === 'github')).toBe(true);
    expect(calls.listCalls({ outcome: 'failed' }).calls).toHaveLength(5);
    expect(calls.listCalls({ tool: 'get_' }).calls.every((c) => c.tool === 'github__get_me')).toBe(true);
    expect(calls.listCalls({ tool: '%' }).calls).toHaveLength(0);
    expect(calls.listCalls({ from: T0 + 20, to: T0 + 22 }).calls).toHaveLength(3);
    expect(() => calls.listCalls({ cursor: 'not-a-cursor' })).toThrow(InvalidCursorError);
  });
});

describe('retention', () => {
  it('purges records older than the setting at start, on the hourly sweep, and when lowered', async () => {
    settings = { ...settings, logRetentionDays: 30 };
    const day = 86_400_000;
    const calls = newLog({ sweepIntervalMs: 50 });
    const db = open.at(-1)!;
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    for (let i = 0; i < 2500; i++) calls.toolCalled(call(T0 - 40 * day + i));
    calls.toolCalled(call(T0 - 10 * day));
    calls.searchPerformed(search(T0 - 40 * day, ['a__b']));
    calls.flush();
    calls.startSweeps();
    await calls.purge();
    expect(count('calls')).toBe(1);
    expect(count('searches')).toBe(0);

    // The hourly sweep (shortened here) removes what has aged past the limit since.
    calls.toolCalled(call(T0 - 31 * day));
    calls.flush();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(count('calls')).toBe(1);

    // Lowering the setting purges the 10-day-old call.
    settings = { ...settings, logRetentionDays: 7 };
    await calls.purge();
    expect(count('calls')).toBe(0);
    await calls.close();
  });

  it('clear deletes every call and search, but not the tool cache', () => {
    const calls = newLog();
    const cache = new SqliteToolCache(open.at(-1)!, log.logger);
    cache.save('files', [{ name: 'echo', inputSchema: { type: 'object' } }]);
    calls.toolCalled(call(T0));
    calls.searchPerformed(search(T0, []));
    expect(calls.clear()).toEqual({ deletedCalls: 1, deletedSearches: 1 });
    expect(cache.load('files')).toHaveLength(1);
  });
});

describe('tool cache', () => {
  it("saves, replaces and removes a server's tools", () => {
    const opened = openDatabase(file, log.logger);
    open.push(opened.db!);
    const cache = new SqliteToolCache(opened.db!, log.logger);
    expect(cache.load('files')).toBeUndefined();
    cache.save('files', [{ name: 'a', inputSchema: { type: 'object' } }]);
    cache.save('files', [
      { name: 'b', inputSchema: { type: 'object' } },
      { name: 'c', inputSchema: { type: 'object' } },
    ]);
    expect(cache.load('files')!.map((tool) => tool.name)).toEqual(['b', 'c']);
    cache.remove('files');
    expect(cache.load('files')).toBeUndefined();
  });
});

describe('performance', () => {
  it('20,000 calls: every filtered query returns in under 200 ms', () => {
    const calls = newLog();
    const servers = ['files', 'github', 'notion', 'linear'];
    const outcomes = ['ok', 'ok', 'ok', 'tool_error', 'failed', 'timeout'] as const;
    for (let i = 0; i < 20_000; i++) {
      calls.toolCalled(
        call(T0 - i * 1000, {
          tool: `${servers[i % 4]}__tool_${i % 37}`,
          server: servers[i % 4],
          client: { name: `client-${i % 5}`, version: '1.0' },
          outcome: outcomes[i % outcomes.length],
          durationMs: i % 900,
        }),
      );
      if (i % 3 === 0)
        calls.searchPerformed(
          search(T0 - i * 1000 - 500, [`files__tool_${i % 37}`], {
            client: { name: `client-${i % 5}`, version: '1.0' },
          }),
        );
      if (i % 2000 === 1999) calls.flush();
    }
    calls.flush();
    const timed = (label: string, run: () => unknown) => {
      const started = performance.now();
      run();
      const ms = performance.now() - started;
      expect(ms, `${label} took ${ms.toFixed(1)} ms`).toBeLessThan(200);
    };
    const range = { from: T0 - 7 * 86_400_000, to: T0 };
    timed('list', () => calls.listCalls({ limit: 200 }));
    timed('list by server', () => calls.listCalls({ server: 'github', limit: 200, ...range }));
    timed('list by client', () => calls.listCalls({ client: 'client-3', limit: 200 }));
    timed('list by outcome', () => calls.listCalls({ outcome: 'timeout', limit: 200 }));
    timed('list by tool', () => calls.listCalls({ tool: 'tool_17', limit: 200 }));
    const page = calls.listCalls({ limit: 200 });
    timed('next page', () => calls.listCalls({ limit: 200, cursor: page.nextCursor }));
    timed('one call', () => calls.getCall(page.calls[3]!.id));
    timed('searches', () => calls.listSearches({ limit: 200, outcome: 'miss' }));
    timed('stats', () => calls.stats(range));
    timed('stats, all time', () => calls.stats());
  }, 60_000);
});
