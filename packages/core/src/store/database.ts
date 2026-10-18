import { existsSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Logger } from '../logger.js';

export type Db = Database.Database;

/** Opens a database file; replaceable in tests to simulate a file that cannot be opened. */
export type DatabaseOpener = (file: string) => Db;

const defaultOpener: DatabaseOpener = (file) => new Database(file);

/**
 * Forward-only migrations: index `i` takes the schema from version `i` to `i + 1`. Never
 * edit one that has shipped; add a new one.
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // 1: calls, searches, the tool cache.
  (db) => {
    db.exec(`
      CREATE TABLE calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        client_name TEXT,
        client_version TEXT,
        era TEXT NOT NULL,
        tool TEXT NOT NULL,
        server TEXT,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        trace_id TEXT,
        bodies_stored INTEGER NOT NULL DEFAULT 0,
        arguments TEXT,
        arguments_truncated INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        result_truncated INTEGER NOT NULL DEFAULT 0,
        error_text TEXT
      );
      CREATE INDEX calls_at ON calls (at);
      CREATE INDEX calls_server_at ON calls (server, at);
      CREATE INDEX calls_client_at ON calls (client_name, client_version, era, at);
      CREATE INDEX calls_outcome_at ON calls (outcome, at);
      CREATE INDEX calls_tool ON calls (tool);

      CREATE TABLE searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        client_name TEXT,
        client_version TEXT,
        era TEXT NOT NULL,
        query TEXT NOT NULL,
        server TEXT,
        limit_n INTEGER,
        result_count INTEGER NOT NULL,
        results TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        followup TEXT,
        followup_call_id INTEGER,
        hit_rank INTEGER
      );
      CREATE INDEX searches_at ON searches (at);
      CREATE INDEX searches_client_at ON searches (client_name, client_version, era, at);
      CREATE INDEX searches_followup_at ON searches (followup, at);

      CREATE TABLE tool_cache (
        server TEXT PRIMARY KEY,
        tools TEXT NOT NULL,
        listed_at INTEGER NOT NULL
      );
    `);
  },
  // 2 (Sprint 7): result sizes for the token estimate, the clean error message, usage indexes.
  (db) => {
    db.exec(`
      ALTER TABLE calls ADD COLUMN result_bytes INTEGER;
      ALTER TABLE calls ADD COLUMN error_message TEXT;
      ALTER TABLE calls ADD COLUMN error_code INTEGER;
      ALTER TABLE searches ADD COLUMN result_bytes INTEGER;
      CREATE INDEX calls_tool_at ON calls (tool, at);
      CREATE INDEX calls_client_name_at ON calls (client_name, at);
    `);
    backfillResultBytes(db);
  },
];

/**
 * Older calls get a size only from a result body that was stored whole: the same measure the
 * recorder uses (UTF-8 JSON without `_meta`). A cut body, or a call without bodies, stays empty.
 */
function backfillResultBytes(db: Db): void {
  const rows = db
    .prepare(
      `SELECT id, result FROM calls
       WHERE bodies_stored = 1 AND result IS NOT NULL AND result_truncated = 0 AND result_bytes IS NULL`,
    )
    .iterate() as IterableIterator<{ id: number; result: string }>;
  const update = db.prepare('UPDATE calls SET result_bytes = ? WHERE id = ?');
  const sizes: [number, number][] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.result);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && '_meta' in value) {
      const { _meta: _ignored, ...rest } = value as Record<string, unknown>;
      value = rest;
    }
    // A refused call stored `null`: the caller got no result (the recorder records 0).
    sizes.push([value === null ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8'), row.id]);
  }
  for (const [bytes, id] of sizes) update.run(bytes, id);
}

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Opens an existing database read-only (`doctor`, tests). Safe while the gateway has it open:
 * WAL mode allows readers next to the one writer. Throws if the file is missing or unusable.
 */
export function openDatabaseReadOnly(file: string): Db {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/**
 * Runs every migration the file has not had yet, each in its own transaction. `upTo` stops at
 * an older version (tests build a database as an older release left it).
 */
export function migrate(db: Db, upTo: number = MIGRATIONS.length): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  let version = row?.version ?? 0;
  const target = Math.min(upTo, MIGRATIONS.length);
  while (version < target) {
    const next = version + 1;
    db.transaction(() => {
      MIGRATIONS[version]!(db);
      db.prepare('UPDATE schema_version SET version = ?').run(next);
    })();
    version = next;
  }
  return version;
}

/** Opens, switches to WAL, checks, and migrates; throws on any problem. */
function openChecked(file: string, open: DatabaseOpener): Db {
  const db = open(file);
  try {
    // A garbage file opens without complaint; the first statement is what fails.
    db.pragma('journal_mode = WAL');
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`quick_check reported: ${String(check)}`);
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    migrate(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // already unusable
    }
    throw error;
  }
}

export interface OpenedDatabase {
  db?: Db;
  /** Why the database could not be used at all (the caller falls back to the log recorder). */
  problem?: string;
  /** The name the damaged file was moved to, when it was replaced by a new one. */
  movedTo?: string;
}

/**
 * Opens `mcpier.db` in WAL mode and brings its schema up to date. A file that cannot be
 * opened or fails `quick_check` is moved aside as `<file>.corrupt-<time>` (with its `-wal` and
 * `-shm` files, so a stale WAL is never replayed into the new database), a new one is created,
 * and one line is logged. If even that fails, `problem` says why and no database is returned.
 */
export function openDatabase(
  file: string,
  logger: Logger,
  open: DatabaseOpener = defaultOpener,
): OpenedDatabase {
  try {
    return { db: openChecked(file, open) };
  } catch (error) {
    const reason = (error as Error)?.message ?? String(error);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const movedTo = `${file}.corrupt-${stamp}`;
    try {
      if (existsSync(file)) renameSync(file, movedTo);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(file + suffix)) renameSync(file + suffix, movedTo + suffix);
      }
    } catch (renameError) {
      const problem = `mcpier.db could not be opened (${reason}) and could not be moved aside (${(renameError as Error).message})`;
      logger.warn({ file }, problem);
      return { problem };
    }
    logger.warn(
      { file, movedTo },
      `mcpier.db could not be opened (${reason}); moved aside and created a new one`,
    );
    try {
      return { db: openChecked(file, open), movedTo };
    } catch (retryError) {
      const problem = `mcpier.db could not be created: ${(retryError as Error)?.message ?? String(retryError)}`;
      logger.warn({ file }, problem);
      return { problem, movedTo };
    }
  }
}
