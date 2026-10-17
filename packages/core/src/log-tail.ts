import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** Size of a file in bytes, or 0 if it does not exist. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The last `count` non-empty lines of a text file, reading at most the last 1 MB. Lines
 * written after byte `fromOffset` only, when given. A missing file has no lines.
 */
export function readLastLines(path: string, count: number, fromOffset = 0): string[] {
  const size = fileSize(path);
  if (size <= fromOffset || count <= 0) return [];
  const length = Math.min(size - fromOffset, 1024 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  // When reading from the middle of the file, the first line may be partial.
  if (length < size - fromOffset) lines.shift();
  return lines.slice(-count);
}
