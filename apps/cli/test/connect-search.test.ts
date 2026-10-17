// Sprint 3: `mcpier connect` (snippets with this machine's real paths) and
// `mcpier tools search` (the admin search route, recorded as mcpier-cli).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabaseReadOnly } from '@mcpier/core';
import { CONNECT_CLIENTS } from '@mcpier/shared';
import { fixtureScripts } from '@mcpier/test-fixtures';
import { CLI_ENTRY, runCli } from '../../../test/helpers/cli.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

let home: TempHome;
let port: number;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  home = createTempHome();
  port = await getFreePort();
  env = home.env(port);
  mkdirSync(home.dir, { recursive: true });
  writeFileSync(
    home.paths.config,
    JSON.stringify({
      servers: [
        {
          name: 'local',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          description: 'Fixture',
        },
      ],
    }),
  );
});

afterAll(async () => {
  await home.cleanup();
});

describe('mcpier connect', () => {
  it('without a client, lists every supported client and the endpoint', async () => {
    const result = await runCli(['connect'], env);
    expect(result.code).toBe(0);
    for (const client of CONNECT_CLIENTS) expect(result.stdout).toContain(client);
    expect(result.stdout).toContain(`http://127.0.0.1:${port}/mcp`);
  });

  it.each([...CONNECT_CLIENTS])('%s: real paths and port', async (client) => {
    const result = await runCli(['connect', client], env);
    expect(result.code).toBe(0);
    const text = result.stdout;
    if (client === 'claude-desktop') {
      // JSON-escaped paths.
      expect(text).toContain(JSON.stringify(process.execPath));
      expect(text).toContain(JSON.stringify(CLI_ENTRY));
    } else if (client === 'codex') {
      expect(text).toContain(`command = '${process.execPath}'`);
      expect(text).toContain(`args = ['${CLI_ENTRY}', 'stdio']`);
    } else if (client === 'generic') {
      expect(text).toContain(CLI_ENTRY);
      expect(text).toContain(`http://127.0.0.1:${port}/mcp`);
    } else {
      expect(text).toContain(`http://127.0.0.1:${port}/mcp`);
    }
    expect(text).toContain('never edits client config files');
  });

  it('--json prints the snippet as data, and every snippet without a client', async () => {
    const one = JSON.parse((await runCli(['connect', 'claude-desktop', '--json'], env)).stdout) as {
      snippet: string;
      client: string;
    };
    expect(one.client).toBe('claude-desktop');
    expect(JSON.parse(one.snippet).mcpServers.mcpier).toEqual({
      command: process.execPath,
      args: [CLI_ENTRY, 'stdio'],
    });
    const all = JSON.parse((await runCli(['connect', '--json'], env)).stdout) as {
      url: string;
      clients: unknown[];
    };
    expect(all.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(all.clients).toHaveLength(CONNECT_CLIENTS.length);
  });

  it('an unknown client is an error naming the valid ones', async () => {
    const result = await runCli(['connect', 'notepad'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown client "notepad"');
    expect(result.stderr).toContain('claude-desktop');
  });
});

describe('mcpier tools search', () => {
  beforeAll(async () => {
    expect((await runCli(['start'], env)).code).toBe(0);
    // Wait until the fixture server's tools are listed.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await runCli(['tools', 'search', 'echo', '--json'], env);
      if (result.code === 0 && result.stdout.includes('local__echo')) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('fixture tools never appeared');
  }, 40_000);

  it('prints a table of matches', async () => {
    const result = await runCli(['tools', 'search', 'add two numbers'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/TOOL\s+AVAILABLE\s+DESCRIPTION/);
    expect(result.stdout.split('\n')[1]).toContain('local__add');
    expect(result.stdout).toContain('yes');
  });

  it('--json, --limit and --server', async () => {
    const limited = JSON.parse(
      (await runCli(['tools', 'search', 'echo', '--limit', '1', '--json'], env)).stdout,
    ) as {
      results: { name: string; inputSchema: unknown }[];
    };
    expect(limited.results).toHaveLength(1);
    expect(limited.results[0]!.inputSchema).toBeTypeOf('object');
    const scoped = JSON.parse(
      (await runCli(['tools', 'search', 'file', '--server', 'local', '--json'], env)).stdout,
    ) as {
      results: { server: string }[];
    };
    expect(scoped.results.every((match) => match.server === 'local')).toBe(true);
  });

  it('reports a bad limit and an unknown server', async () => {
    const badLimit = await runCli(['tools', 'search', 'x', '--limit', '50'], env);
    expect(badLimit.code).toBe(1);
    expect(badLimit.stderr).toContain('"limit" must be a whole number from 1 to 20');
    const unknown = await runCli(['tools', 'search', 'x', '--server', 'nope'], env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Valid server names: local');
  });

  it('records the searches with the client name mcpier-cli (in the call log)', async () => {
    // The gateway writes within 250 ms; read the database next to it (WAL allows a reader).
    await new Promise((resolve) => setTimeout(resolve, 600));
    const db = openDatabaseReadOnly(home.paths.db);
    try {
      const rows = db.prepare('SELECT client_name, era, query FROM searches').all() as {
        client_name: string | null;
        era: string;
        query: string;
      }[];
      expect(rows.some((row) => row.query === 'add two numbers' && row.client_name === 'mcpier-cli')).toBe(
        true,
      );
      expect(rows.every((row) => row.era === 'admin')).toBe(true);
    } finally {
      db.close();
    }
    // Searches are no longer gateway log lines.
    expect(readFileSync(home.paths.gatewayLog, 'utf8')).not.toContain('"event":"search"');
  });
});
