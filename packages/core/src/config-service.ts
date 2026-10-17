import { EventEmitter } from 'node:events';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { validateConfig, type McpierConfig } from '@mcpier/shared';
import { ConfigError, parseConfigText, saveConfig, serializeConfig } from './config-store.js';
import type { Logger } from './logger.js';
import { ConflictError, InvalidRequestError } from './manager/errors.js';

/** The config file on disk is invalid; the gateway keeps running on the last good config. */
export interface ConfigProblem {
  file: string;
  problems: string[];
  /** ISO 8601. */
  since: string;
}

export interface ConfigServiceEvents {
  applied: [config: McpierConfig];
  problem: [problem: ConfigProblem | undefined];
}

/**
 * The gateway is the only writer of `config.json` while it runs. This service holds the
 * current config, saves changes atomically, and watches the file for hand edits:
 *
 * - A valid hand edit is applied (as a difference, by the listener).
 * - An invalid one is not applied: every problem is logged and exposed until it is fixed.
 * - The gateway's own saves never cause a reload: the service remembers the exact text it
 *   last wrote or loaded and ignores a file whose content equals it.
 * - While the file on disk is invalid, changes through the API are refused, so a broken hand
 *   edit is never overwritten with the last good config.
 */
export class ConfigService extends EventEmitter<ConfigServiceEvents> {
  private queue: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private currentProblem: ConfigProblem | undefined;

  private constructor(
    readonly file: string,
    private current: McpierConfig,
    private lastText: string,
    private readonly logger: Logger,
    private readonly debounceMs: number,
  ) {
    super();
  }

  /** Loads the file; throws `ConfigError` if it is invalid (the gateway then refuses to start). */
  static async load(file: string, logger: Logger, debounceMs = 250): Promise<ConfigService> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      throw new ConfigError(file, [`cannot be read: ${(error as Error).message}`]);
    }
    return new ConfigService(file, parseConfigText(file, text), text, logger, debounceMs);
  }

  get config(): McpierConfig {
    return this.current;
  }

  get problem(): ConfigProblem | undefined {
    return this.currentProblem;
  }

  /** Starts watching the folder (watching the file itself breaks on atomic replaces). */
  watch(): void {
    if (this.watcher) return;
    const name = basename(this.file).toLowerCase();
    this.watcher = watch(dirname(this.file), (_event, filename) => {
      if (filename && filename.toString().toLowerCase() === name) this.scheduleReload();
    });
    this.watcher.on('error', (error) =>
      this.logger.warn({ err: { message: error.message } }, 'Config watch error'),
    );
  }

  private scheduleReload(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => void this.enqueue(() => this.reloadFromDisk()).catch(() => {}),
      this.debounceMs,
    );
    this.debounceTimer.unref();
  }

  /** Runs tasks one after another, so a save and a reload never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Reads the file now and applies it if it changed (also used by tests instead of waiting). */
  reload(): Promise<void> {
    return this.enqueue(() => this.reloadFromDisk());
  }

  private setProblem(problem: ConfigProblem | undefined): void {
    this.currentProblem = problem;
    this.emit('problem', problem);
  }

  private async reloadFromDisk(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      this.reportProblem([`cannot be read: ${(error as Error).message}`]);
      return;
    }
    if (text === this.lastText) {
      // Our own save, or the file was put back exactly as the last good version.
      if (this.currentProblem) {
        this.logger.info({ file: this.file }, 'Config file is valid again');
        this.setProblem(undefined);
      }
      return;
    }
    let config: McpierConfig;
    try {
      config = parseConfigText(this.file, text);
    } catch (error) {
      if (error instanceof ConfigError) {
        this.reportProblem([...error.problems]);
        return;
      }
      throw error;
    }
    this.lastText = text;
    this.current = config;
    if (this.currentProblem) this.setProblem(undefined);
    this.logger.info({ file: this.file }, 'Config file changed; applying it');
    this.emit('applied', config);
  }

  private reportProblem(problems: string[]): void {
    if (this.currentProblem && JSON.stringify(this.currentProblem.problems) === JSON.stringify(problems))
      return;
    this.logger.warn(
      { file: this.file, problems },
      'Config file is invalid; still running on the last good config until it is fixed',
    );
    this.setProblem({ file: this.file, problems, since: new Date().toISOString() });
  }

  /**
   * Changes the config: picks up any pending hand edit first, refuses while the file is
   * invalid, validates the result (nothing is saved if it is invalid), saves atomically, then
   * applies it. The mutator edits a copy of the current config.
   */
  update(mutate: (draft: McpierConfig) => McpierConfig | void): Promise<McpierConfig> {
    return this.enqueue(async () => {
      await this.reloadFromDisk();
      if (this.currentProblem) {
        throw new ConflictError(
          `config.json has problems; fix the file before changing the config through MCPier:\n` +
            this.currentProblem.problems.map((problem) => `  - ${problem}`).join('\n'),
          'config_invalid',
        );
      }
      const draft = structuredClone(this.current);
      const changed = mutate(draft) ?? draft;
      const result = validateConfig(changed);
      if (!result.ok)
        throw new InvalidRequestError('The change would make the config invalid.', result.problems);
      const text = serializeConfig(result.config);
      const previousText = this.lastText;
      this.lastText = text;
      try {
        await saveConfig(this.file, result.config);
      } catch (error) {
        this.lastText = previousText;
        throw error;
      }
      this.current = result.config;
      this.emit('applied', result.config);
      return result.config;
    });
  }

  close(): void {
    clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
