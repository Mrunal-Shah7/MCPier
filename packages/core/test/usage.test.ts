// Sprint 7, Phase 1: migration 2 (result sizes, clean errors), what the recorder stores, and the
// usage report (local-time buckets, the previous period, breakdowns, retention, speed).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { defaultConfig, estimateTokens, type Settings } from '@mcpier/shared';
import {
  bucketStarts,
  CallLog,
  createGatewayLogger,
  migrate,
  openDatabase,
  rangeBounds,
  SCHEMA_VERSION,
  type CallEvent,
  type Db,
  type GatewayLogger,
} from '../src/index.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

// Every bucket test runs in a zone with clock changes, whatever the machine's own zone is.
const ZONE = 'Europe/London';
let savedZone: string | undefined;
beforeAll(() => {
  savedZone = process.env.TZ;
  process.env.TZ = ZONE;
});
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

let home: TempHome;
let log: GatewayLogger;
let file: string;
let settings: Settings;
let clock: number;
const open: Db[] = [];

const HOUR = 3_600_000;
const DAY = 86_400_000;
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

beforeEach(() => {
  home = createTempHome();
  mkdirSync(home.dir, { recursive: true });
  log = createGatewayLogger({ file: join(home.dir, '..', 'test.log') });
  file = join(home.dir, 'mcpier.db');
  settings = defaultConfig().settings;
  clock = local(2026, 10, 17, 12, 30);
});

afterEach(async () => {
  for (const db of open.splice(0)) if (db.open) db.close();
  log.close();
  await home.cleanup();
});

function newLog(): CallLog {
  const opened = openDatabase(file, log.logger);
  open.push(opened.db!);
  return new CallLog(opened.db!, {
    settings: () => settings,
    logger: log.logger,
    now: () => clock,
    flushIntervalMs: 60_000,
  });
}

function call(at: number, extra: Partial<CallEvent> = {}): CallEvent {
  return {
    at: new Date(at).toISOString(),
    client: { name: 'agent', version: '1.0' },
    era: 'modern',
    tool: 'files__read_file',
    server: 'files',
    durationMs: 10,
    outcome: 'ok',
    arguments: { path: 'a.txt' },
    result: { content: [{ type: 'text', text: 'hello' }] },
    resultBytes: 400,
    ...extra,
  };
}

describe('migration 2', () => {
  it('adds the size and clean-error columns and backfills sizes from uncut bodies only', () => {
    const db = new Database(file);
    open.push(db);
    migrate(db, 1);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 });
    const insert = db.prepare(
      `INSERT INTO calls (at, era, tool, server, duration_ms, outcome, bodies_stored, result, result_truncated, error_text)
       VALUES (1, 'modern', 't', 's', 1, 'ok', @stored, @result, @cut, @error)`,
    );
    const whole = { content: [{ type: 'text', text: 'héllo' }], _meta: { trace: 'x'.repeat(100) } };
    insert.run({ stored: 1, result: JSON.stringify(whole), cut: 0, error: null });
    insert.run({
      stored: 1,
      result: '{"content":[{"type":"text","text":"xxxx…[cut by MCPier',
      cut: 1,
      error: null,
    });
    insert.run({ stored: 0, result: null, cut: 0, error: null });
    insert.run({ stored: 1, result: 'null', cut: 0, error: 'MCP error -32603: {"error":{"message":"old"}}' });
    db.prepare(
      `INSERT INTO searches (at, era, query, result_count, results, duration_ms) VALUES (1, 'modern', 'q', 0, '[]', 1)`,
    ).run();

    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2);
    const sizes = (
      db.prepare('SELECT result_bytes FROM calls ORDER BY id').all() as { result_bytes: number | null }[]
    ).map((row) => row.result_bytes);
    const { _meta: _dropped, ...withoutMeta } = whole;
    expect(sizes).toEqual([Buffer.byteLength(JSON.stringify(withoutMeta), 'utf8'), null, null, 0]);
    expect(db.prepare('SELECT result_bytes FROM searches').get()).toEqual({ result_bytes: null });
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['calls_tool_at', 'calls_client_name_at', 'calls_server_at']),
    );
  });

  it('a row recorded before 1.1.0 gets its clean message when it is read', () => {
    const db = new Database(file);
    migrate(db, 1);
    db.prepare(
      `INSERT INTO calls (at, era, tool, server, duration_ms, outcome, error_text)
       VALUES (?, 'modern', 'files__x', 'files', 1, 'failed', ?)`,
    ).run(
      clock - HOUR,
      'MCP error -32603: {"jsonrpc":"2.0","error":{"code":-32603,"message":"Old failure"}}',
    );
    db.close();
    const calls = newLog().listCalls().calls;
    expect(calls[0]).toMatchObject({ errorMessage: 'Old failure', errorCode: -32603, outcome: 'failed' });
    expect(calls[0]).not.toHaveProperty('resultBytes');
    expect(calls[0]).not.toHaveProperty('estimatedTokens');
  });

  it('a new database is created at version 2 with every column', () => {
    const callLog = newLog();
    const columns = (callLog.db.prepare('PRAGMA table_info(calls)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(expect.arrayContaining(['result_bytes', 'error_message', 'error_code']));
    const searchColumns = (callLog.db.prepare('PRAGMA table_info(searches)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(searchColumns).toContain('result_bytes');
  });
});

describe('what the recorder stores', () => {
  it('stores the size with bodies on and off, and the tokens are estimated when read', () => {
    const callLog = newLog();
    callLog.toolCalled(call(clock - 2 * HOUR, { resultBytes: 1001 }));
    settings = { ...settings, storeCallBodies: false };
    callLog.toolCalled(call(clock - HOUR, { resultBytes: 7 }));
    const [off, on] = callLog.listCalls().calls;
    expect(on).toMatchObject({ bodiesStored: true, resultBytes: 1001, estimatedTokens: 251 });
    expect(off).toMatchObject({ bodiesStored: false, resultBytes: 7, estimatedTokens: 2 });
    expect(callLog.getCall(off!.id)).toMatchObject({ resultBytes: 7, estimatedTokens: 2 });
  });

  it('cleans the full error text before the 500-character cut', () => {
    const callLog = newLog();
    const sentence = 'The path is outside the allowed directories.';
    const raw = `The call to files__read failed: MCP error -32603: ${JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: sentence, data: { stack: 's'.repeat(2000) } },
    })}`;
    callLog.toolCalled(call(clock - HOUR, { outcome: 'failed', errorText: raw }));
    const item = callLog.listCalls().calls[0]!;
    expect(item.errorText).toHaveLength(500);
    expect(item.errorMessage).toBe(sentence);
    expect(item.errorCode).toBe(-32603);
  });

  it('stores the size of what search_tools returned', () => {
    const callLog = newLog();
    callLog.searchPerformed({
      at: new Date(clock - HOUR).toISOString(),
      client: { name: 'agent' },
      era: 'modern',
      query: 'q',
      resultCount: 0,
      results: [],
      durationMs: 1,
      resultBytes: 90,
    });
    expect(callLog.listSearches().searches[0]).toMatchObject({ resultBytes: 90, estimatedTokens: 23 });
  });
});

describe('buckets', () => {
  it('follows local time across clock changes (23- and 25-hour days)', () => {
    const spring = bucketStarts(local(2026, 3, 28, 12), local(2026, 3, 30, 12), 'day');
    expect(spring.map((start) => new Date(start).getDate())).toEqual([28, 29, 30]);
    expect(spring[2]! - spring[1]!).toBe(23 * HOUR);
    const autumn = bucketStarts(local(2026, 10, 24, 12), local(2026, 10, 26, 12), 'day');
    expect(autumn[2]! - autumn[1]!).toBe(25 * HOUR);
    // Every bucket starts at local midnight.
    for (const start of [...spring, ...autumn]) expect(new Date(start).getHours()).toBe(0);
  });

  it('names ranges in local time: 24 hourly buckets, 7 and 30 days', () => {
    const day = rangeBounds('24h', clock);
    expect(bucketStarts(day.from, day.to, day.bucket)).toHaveLength(24);
    const week = rangeBounds('7d', clock);
    expect(new Date(week.from).getHours()).toBe(0);
    expect(bucketStarts(week.from, week.to, week.bucket)).toHaveLength(7);
    expect(
      bucketStarts(...(Object.values(rangeBounds('30d', clock)) as [number, number, 'day'])),
    ).toHaveLength(30);
  });
});

describe('usage report', () => {
  it('an empty range: zeros everywhere, every bucket present', () => {
    const report = newLog().usage({ ...rangeBounds('7d', clock) });
    expect(report.totals).toMatchObject({
      calls: 0,
      errors: 0,
      errorRate: null,
      tokens: 0,
      avgTokensPerCall: null,
      p95TokensPerCall: null,
      p50Ms: null,
      callsWithoutSize: 0,
    });
    expect(report.series).toHaveLength(7);
    expect(report.series.every((point) => point.calls === 0 && point.tokens === 0)).toBe(true);
    expect(report).toMatchObject({
      bucket: 'day',
      clipped: false,
      timeZone: ZONE,
      byServer: [],
      heaviestTools: [],
    });
  });

  it('hour buckets keep empty hours as zeros', () => {
    const callLog = newLog();
    const range = rangeBounds('24h', clock);
    callLog.toolCalled(call(range.from + 10 * 60_000));
    callLog.toolCalled(call(range.from + 5 * HOUR + 60_000, { resultBytes: 8 }));
    callLog.toolCalled(call(range.from + 5 * HOUR + 120_000, { outcome: 'tool_error', resultBytes: 4 }));
    const report = callLog.usage(range);
    expect(report.series).toHaveLength(24);
    expect(report.series.map((point) => point.calls)).toEqual(
      Array.from({ length: 24 }, (_, index) => (index === 0 ? 1 : index === 5 ? 2 : 0)),
    );
    expect(report.series[5]).toMatchObject({
      errors: 1,
      tokens: 3,
      byServer: { files: 2 },
      byClient: { agent: 2 },
    });
  });

  it('day buckets on a clock-change day put late-evening calls on the right day', () => {
    clock = local(2026, 3, 31, 12);
    const callLog = newLog();
    // 23:30 on the 29th (the 23-hour day) and 00:30 on the 30th.
    callLog.toolCalled(call(local(2026, 3, 29, 23, 30)));
    callLog.toolCalled(call(local(2026, 3, 30, 0, 30)));
    const report = callLog.usage({ from: local(2026, 3, 28), to: clock, bucket: 'day' });
    expect(report.series.map((point) => [new Date(point.start).getDate(), point.calls])).toEqual([
      [28, 0],
      [29, 1],
      [30, 1],
      [31, 0],
    ]);
  });

  it('filters by server, and the previous period has its own totals', () => {
    const callLog = newLog();
    const range = rangeBounds('7d', clock);
    const length = range.to - range.from;
    callLog.toolCalled(call(range.from + DAY, { server: 'files', resultBytes: 400 }));
    callLog.toolCalled(call(range.from + DAY, { server: 'notes', tool: 'notes__find', resultBytes: 40 }));
    callLog.toolCalled(call(range.from - length / 2, { server: 'files', outcome: 'failed', resultBytes: 4 }));
    callLog.toolCalled(call(range.from - length - DAY, { server: 'files' }));

    const all = callLog.usage(range);
    expect(all.totals).toMatchObject({ calls: 2, tokens: 110, errors: 0 });
    expect(all.previous).toMatchObject({ calls: 1, errors: 1, errorRate: 1, tokens: 1 });
    expect(Date.parse(all.previous.to)).toBe(range.from);
    expect(Date.parse(all.previous.from)).toBe(range.from - length);

    const files = callLog.usage({ ...range, server: 'files' });
    expect(files.server).toBe('files');
    expect(files.totals).toMatchObject({ calls: 1, tokens: 100 });
    expect(files.byServer.map((row) => row.server)).toEqual(['files']);
  });

  it('orders the heaviest tools by tokens, then calls; series align with the buckets', () => {
    const callLog = newLog();
    const range = rangeBounds('7d', clock);
    const at = range.from + 2 * DAY + HOUR;
    for (let i = 0; i < 3; i++) callLog.toolCalled(call(at, { tool: 'files__small', resultBytes: 40 }));
    callLog.toolCalled(call(at, { tool: 'files__big', resultBytes: 4000 }));
    callLog.toolCalled(call(at, { tool: 'files__tie', resultBytes: 40 }));
    const report = callLog.usage(range);
    expect(report.heaviestTools.map((row) => [row.tool, row.calls, row.tokens, row.avgTokens])).toEqual([
      ['files__big', 1, 1000, 1000],
      ['files__small', 3, 30, 10],
      ['files__tie', 1, 10, 10],
    ]);
    expect(report.heaviestTools[0]!.series).toEqual([0, 0, 1000, 0, 0, 0, 0]);
    expect(report.heaviestTools[1]!.callSeries).toEqual([0, 0, 3, 0, 0, 0, 0]);
    expect(report.byClient).toEqual([{ client: 'agent', calls: 5, share: 1 }]);
  });

  it('counts calls without a size but does not estimate them', () => {
    const callLog = newLog();
    const range = rangeBounds('24h', clock);
    callLog.toolCalled(call(range.from + HOUR, { resultBytes: 4000 }));
    const old = call(range.from + HOUR);
    delete old.resultBytes;
    callLog.toolCalled(old);
    const { totals } = callLog.usage(range);
    expect(totals).toMatchObject({ calls: 2, callsWithoutSize: 1, tokens: 1000, avgTokensPerCall: 1000 });
  });

  it('clips a range that reaches past the retention period, and says so', () => {
    settings = { ...settings, logRetentionDays: 7 };
    const report = newLog().usage({ from: clock - 30 * DAY, to: clock, bucket: 'day' });
    expect(report.clipped).toBe(true);
    expect(report.retentionDays).toBe(7);
    expect(Date.parse(report.from)).toBe(clock - 7 * DAY);
    expect(report.series).toHaveLength(8);
  });

  it('answers in under 200 ms with 20,000 calls, for 30 days and for 24 hours', () => {
    const callLog = newLog();
    const servers = ['files', 'notes', 'tasks', 'docs', 'search'];
    const insert = callLog.db.prepare(
      `INSERT INTO calls (at, client_name, era, tool, server, duration_ms, outcome, result_bytes)
       VALUES (?, ?, 'modern', ?, ?, ?, ?, ?)`,
    );
    callLog.db.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        const server = servers[i % servers.length]!;
        insert.run(
          clock - Math.floor((i / 20_000) * 29 * DAY),
          `client-${i % 4}`,
          `${server}__tool_${i % 37}`,
          server,
          i % 900,
          i % 23 === 0 ? 'tool_error' : 'ok',
          i % 11 === 0 ? null : 200 + (i % 5000),
        );
      }
    })();
    for (const name of ['30d', '24h'] as const) {
      const started = performance.now();
      const report = callLog.usage({ ...rangeBounds(name, clock) });
      const elapsed = performance.now() - started;
      expect(report.totals.calls).toBeGreaterThan(0);
      expect(elapsed, `${name}: ${elapsed.toFixed(1)} ms`).toBeLessThan(200);
    }
  });
});

describe('estimateTokens', () => {
  it('is ceil(bytes / 4), and nothing without a size', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(8)).toBe(2);
    expect(estimateTokens(9)).toBe(3);
    expect(estimateTokens(undefined)).toBeUndefined();
    expect(estimateTokens(null)).toBeUndefined();
  });
});
