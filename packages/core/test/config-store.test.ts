import { promises as fs, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, saveConfig, type SaveFileOps } from '../src/index.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

let home: TempHome;
let file: string;

beforeEach(async () => {
  home = createTempHome();
  await fs.mkdir(home.dir, { recursive: true });
  file = join(home.dir, 'config.json');
});

afterEach(async () => {
  await home.cleanup();
});

async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('reports invalid JSON with line and column and leaves the file untouched', async () => {
    const text = '{\n  "settings": {\n    "port": 47800,\n  }\n}\n';
    writeFileSync(file, text);
    const before = statSync(file).mtimeMs;
    const error = await expectConfigError(loadConfig(file));
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(/^not valid JSON: .*line 4 column 3/);
    expect(error.message).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('never quotes the file in a JSON error (it may hold plain values) (Sprint 6 BUGS B-1)', async () => {
    const value = 'ghp_PLAINVALUE0123456789';
    for (const text of [
      `{"servers":[{"name":"gh","transport":"stdio","command":"x","env":{"TOKEN": ${value}}}]}`,
      `{"a": ${value}`,
      `${value}`,
    ]) {
      writeFileSync(file, text);
      const error = await expectConfigError(loadConfig(file));
      expect(error.problems[0]).toMatch(/^not valid JSON: /);
      for (const part of [value, value.slice(0, 8), 'PLAINVALUE']) {
        expect(error.message).not.toContain(part);
        expect(error.problems.join('\n')).not.toContain(part);
      }
    }
  });

  it('reports each validation problem with its location', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        settings: { port: 80 },
        servers: [{ name: 'Bad Name', transport: 'stdio', command: 'x' }],
      }),
    );
    const error = await expectConfigError(loadConfig(file));
    expect(error.problems).toEqual([
      'settings.port: must be between 1024 and 65535',
      'servers[0].name: must be a lowercase slug: letters a-z, digits and single hyphens between them, starting with a letter',
    ]);
    expect(error.message).toContain('  - settings.port: must be between 1024 and 65535');
  });

  it('accepts a file saved with a UTF-8 byte order mark', async () => {
    writeFileSync(file, '﻿{"settings":{"port":48001}}');
    expect((await loadConfig(file)).settings.port).toBe(48001);
  });

  it('reports a missing file', async () => {
    const error = await expectConfigError(loadConfig(file));
    expect(error.problems[0]).toMatch(/^cannot be read/);
  });
});

describe('saveConfig', () => {
  it('keeps unknown keys through a load-and-save round trip', async () => {
    const original = {
      handEdited: { note: 'keep me' },
      settings: { port: 48002, experimental: { flag: true } },
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs-server'], custom: 42 },
        { name: 'web', transport: 'http', url: 'https://example.com/mcp', vendorOption: 'x' },
      ],
    };
    writeFileSync(file, JSON.stringify(original));
    await saveConfig(file, await loadConfig(file));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.handEdited).toEqual({ note: 'keep me' });
    expect(saved.settings.experimental).toEqual({ flag: true });
    expect(saved.servers[0].custom).toBe(42);
    expect(saved.servers[1].vendorOption).toBe('x');
    // Defaults are written out too, so the file shows every setting.
    expect(saved.settings.logRetentionDays).toBe(30);
  });

  it('replaces the file and leaves no temporary file behind', async () => {
    writeFileSync(file, '{}');
    const config = await loadConfig(file);
    config.settings.port = 49000;
    await saveConfig(file, config);
    expect(JSON.parse(readFileSync(file, 'utf8')).settings.port).toBe(49000);
    expect(readdirSync(home.dir)).toEqual(['config.json']);
  });

  it('writes to a temporary file in the same folder, then renames it over the original', async () => {
    writeFileSync(file, '{}');
    const config = await loadConfig(file);
    const calls: string[] = [];
    const ops: SaveFileOps = {
      writeFile: async (path, data) => {
        calls.push(`write ${path}`);
        await fs.writeFile(path, data);
      },
      rename: async (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        await fs.rename(from, to);
      },
      unlink: async (path) => {
        calls.push(`unlink ${path}`);
        await fs.unlink(path);
      },
    };
    await saveConfig(file, config, ops);
    expect(calls).toHaveLength(2);
    const tmp = calls[0]!.slice('write '.length);
    expect(tmp.startsWith(join(home.dir, '.config.json.'))).toBe(true);
    expect(calls[1]).toBe(`rename ${tmp} -> ${file}`);
  });

  it('leaves the original intact when the write fails half-way', async () => {
    const original = '{"settings":{"port":48003}}';
    writeFileSync(file, original);
    const config = await loadConfig(file);
    const ops: SaveFileOps = {
      writeFile: async (path, data) => {
        await fs.writeFile(path, data.slice(0, 10));
        throw new Error('simulated crash during write');
      },
      rename: (from, to) => fs.rename(from, to),
      unlink: (path) => fs.unlink(path),
    };
    await expect(saveConfig(file, config, ops)).rejects.toThrow('simulated crash during write');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(home.dir)).toEqual(['config.json']);
  });

  it('leaves the original intact when the rename fails', async () => {
    const original = '{"settings":{"port":48004}}';
    writeFileSync(file, original);
    const config = await loadConfig(file);
    const ops: SaveFileOps = {
      writeFile: (path, data) => fs.writeFile(path, data),
      rename: async () => {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
      },
      unlink: (path) => fs.unlink(path),
    };
    await expect(saveConfig(file, config, ops)).rejects.toThrow('simulated rename failure');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(home.dir)).toEqual(['config.json']);
  });

  it('retries a rename blocked by a briefly locked file', async () => {
    writeFileSync(file, '{}');
    const config = await loadConfig(file);
    let attempts = 0;
    const ops: SaveFileOps = {
      writeFile: (path, data) => fs.writeFile(path, data),
      rename: async (from, to) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        await fs.rename(from, to);
      },
      unlink: (path) => fs.unlink(path),
    };
    await saveConfig(file, config, ops);
    expect(attempts).toBe(3);
  });
});
