import type { CallLogState, Settings } from '@mcpier/shared';
import type { Logger } from '../logger.js';
import { LogRecorder, type Recorder } from '../meta/recorder.js';
import { CallLog } from './call-log.js';
import { openDatabase, type Db, type DatabaseOpener } from './database.js';
import { SqliteToolCache, type ToolCache } from './tool-cache.js';

export interface GatewayStore {
  /** Where calls and searches go: the SQLite call log, or the log fallback. */
  recorder: Recorder;
  /** The call log, when the database is in use. */
  callLog?: CallLog;
  toolCache?: ToolCache;
  state: CallLogState;
  /** Flushes the call log and closes the database (gateway shutdown). */
  close(): Promise<void>;
}

export interface OpenStoreOptions {
  file: string;
  logger: Logger;
  settings: () => Settings;
  now?: () => number;
  opener?: DatabaseOpener;
  flushIntervalMs?: number;
  sweepIntervalMs?: number;
}

/**
 * Opens `mcpier.db` for the gateway. If it cannot be used even after moving a damaged file
 * aside, calls and searches go to the gateway log instead (one warning), and the gateway runs on.
 */
export function openGatewayStore(options: OpenStoreOptions): GatewayStore {
  const opened = openDatabase(options.file, options.logger, options.opener);
  if (!opened.db) {
    options.logger.warn(
      { reason: opened.problem },
      'The call log is not available; recording to the gateway log',
    );
    return {
      recorder: new LogRecorder(options.logger),
      state: { store: 'log', ...(opened.problem ? { problem: opened.problem } : {}) },
      close: async () => {},
    };
  }
  const db: Db = opened.db;
  const callLog = new CallLog(db, {
    settings: options.settings,
    logger: options.logger,
    ...(options.now ? { now: options.now } : {}),
    ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
    ...(options.sweepIntervalMs !== undefined ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
  });
  return {
    recorder: callLog,
    callLog,
    toolCache: new SqliteToolCache(db, options.logger, options.now),
    state: { store: 'sqlite' },
    async close() {
      await callLog.close();
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

export * from './call-log.js';
export * from './database.js';
export * from './tool-cache.js';
export * from './usage.js';
