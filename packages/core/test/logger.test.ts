import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayLogger, RotatingFileSink } from '../src/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpier-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RotatingFileSink', () => {
  it('rotates by size and keeps a fixed number of old files', () => {
    const file = join(dir, 'gateway.log');
    const sink = new RotatingFileSink(file, { maxBytes: 100, maxFiles: 2 });
    for (let i = 0; i < 10; i++) sink.write(`line ${i} ${'x'.repeat(40)}\n`);
    sink.close();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('line 9');
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(100);
  });
});

describe('createGatewayLogger', () => {
  it('writes JSON lines immediately and redacts secret-looking fields', () => {
    const file = join(dir, 'gateway.log');
    const log = createGatewayLogger({ file });
    log.logger.info(
      { token: 'abc', authorization: 'Bearer abc', headers: { cookie: 'x' }, port: 1 },
      'hello',
    );
    const line = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
    log.close();
    expect(line).toMatchObject({ msg: 'hello', port: 1, token: '[redacted]', authorization: '[redacted]' });
    expect(line.headers).toBe('[redacted]');
  });
});
