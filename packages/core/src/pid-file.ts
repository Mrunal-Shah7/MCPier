import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Contents of `gateway.pid`: which process runs the gateway, and on which port. */
export interface PidFileContent {
  pid: number;
  port: number;
  /** ISO 8601 timestamp. */
  startedAt: string;
}

/** Reads the pid file. Returns `undefined` if it is missing or unreadable. */
export function readPidFile(file: string): PidFileContent | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PidFileContent>;
    if (Number.isInteger(value.pid) && Number.isInteger(value.port)) {
      return { pid: value.pid!, port: value.port!, startedAt: String(value.startedAt ?? '') };
    }
  } catch {
    // Missing or corrupt: treated the same as no pid file.
  }
  return undefined;
}

export function writePidFile(file: string, content: PidFileContent): void {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(content)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Removes the pid file, but only if it still names `pid` (another gateway may own it now). */
export function removePidFile(file: string, pid: number): void {
  if (readPidFile(file)?.pid === pid) rmSync(file, { force: true });
}
