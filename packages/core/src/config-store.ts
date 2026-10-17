import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { jsonErrorMessage, validateConfig, type McpierConfig } from '@mcpier/shared';

/** The config file exists but cannot be used. The file is never modified in this case. */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(
      [
        `The config file ${file} is invalid and was left unchanged:`,
        ...problems.map((problem) => `  - ${problem}`),
        'Fix the file and try again.',
      ].join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/** Line and column (1-based) of a character offset. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return { line, column };
}

export function describeJsonError(text: string, error: Error): string {
  // Node quotes a slice of the input in some messages (`Unexpected token 'g', "{"a": ghp_…"…
  // is not valid JSON`). The file may hold plain env or header values, and this text reaches
  // the gateway log, the dashboard banner and the CLI: keep the message, drop the excerpt.
  let message = jsonErrorMessage(error);
  if (!/line \d+/.test(message)) {
    const position = /position (\d+)/.exec(message);
    if (position?.[1]) {
      const { line, column } = lineAndColumn(text, Number(position[1]));
      message += ` (line ${line} column ${column})`;
    }
  }
  return `not valid JSON: ${message}`;
}

/** Reads, parses and validates the config file. Throws `ConfigError` with every problem found. */
export async function loadConfig(file: string): Promise<McpierConfig> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(file, [`cannot be read: ${(error as Error).message}`]);
  }
  return parseConfigText(file, text);
}

/** Parses and validates config file content. Throws `ConfigError` with every problem found. */
export function parseConfigText(file: string, text: string): McpierConfig {
  // Editors such as Notepad may save a UTF-8 byte order mark, which JSON.parse rejects.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(file, [describeJsonError(text, error as Error)]);
  }

  const result = validateConfig(raw);
  if (!result.ok) throw new ConfigError(file, result.problems);
  return result.config;
}

/** The exact text `saveConfig` writes for a config. */
export function serializeConfig(config: McpierConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** File operations used by `saveConfig`; replaceable in tests to simulate failures. */
export interface SaveFileOps {
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultOps: SaveFileOps = {
  async writeFile(path, data) {
    const handle = await fs.open(path, 'wx');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
};

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(ops: SaveFileOps, from: string, to: string): Promise<void> {
  // On Windows, antivirus scanners and indexers briefly lock freshly written files.
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 9 || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
    }
  }
}

/**
 * Writes the config atomically: the content goes to a temporary file in the same folder,
 * which then replaces the original with a rename. A crash mid-save leaves either the old
 * file or the new one, never a half-written file.
 */
export async function saveConfig(
  file: string,
  config: McpierConfig,
  ops: SaveFileOps = defaultOps,
): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const data = serializeConfig(config);
  try {
    await ops.writeFile(tmp, data);
    await renameWithRetry(ops, tmp, file);
  } catch (error) {
    await ops.unlink(tmp).catch(() => {});
    throw error;
  }
}
