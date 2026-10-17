// The built CLI against an in-process gateway (temporary home, random port, fake secret store,
// fixture servers). Every output is collected and checked for secret values at the end.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureScripts, startStatelessServer, type RunningFixture } from '@mcpier/test-fixtures';
import { runCli, spawnCli, type CliResult } from '../../../test/helpers/cli.js';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome } from '../../../test/helpers/temp-home.js';

const SECRETS = {
  piped: 'piped-secret-value-0001-abcd',
  header: 'header-secret-value-0002-efgh',
  imported: 'imported-token-value-0003-ijkl',
  bearer: 'bearer-token-value-0004-mnop',
};

let t: TestGateway;
let stateless: RunningFixture;
const outputs: CliResult[] = [];
const fixture = fixtureScripts.stdio;

async function cli(args: string[], input?: string): Promise<CliResult> {
  const result = await runCli(args, t.home.env(t.port), { input });
  outputs.push(result);
  return result;
}

const storedConfig = () =>
  JSON.parse(readFileSync(t.home.paths.config, 'utf8')) as {
    servers: Record<string, unknown>[];
  };
const stored = (name: string) => storedConfig().servers.find((server) => server.name === name);

beforeAll(async () => {
  t = await startTestGateway({ timing: FAST_TIMING });
  stateless = await startStatelessServer();
});

afterAll(async () => {
  await stateless.close();
  await t.cleanup();
  for (const output of outputs) {
    for (const value of Object.values(SECRETS)) expect(output.stdout + output.stderr).not.toContain(value);
  }
});

describe('when the gateway is not running', () => {
  it.each([
    [['server', 'list']],
    [['tools', 'list']],
    [['secret', 'list']],
    [['server', 'add', 'x', '--', 'node']],
    [['server', 'enable', 'files']],
    [['server', 'disable', 'files']],
  ])('%j says so with a hint and exits non-zero', async (args) => {
    const home = createTempHome();
    try {
      const result = await runCli(args, home.env(await getFreePort()));
      outputs.push(result);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('mcpier: MCPier is not running.\nHint: Start it with: mcpier start\n');
    } finally {
      await home.cleanup();
    }
  });
});

describe('mcpier server', () => {
  it('lists no servers, then adds a stdio server with options and waits for it', async () => {
    expect((await cli(['server', 'list'])).stdout).toContain('No servers configured.');
    expect(JSON.parse((await cli(['server', 'list', '--json'])).stdout)).toEqual({ servers: [] });

    const added = await cli([
      'server',
      'add',
      'files',
      '--description',
      'Fake files',
      '--env',
      'MODE=test',
      '--env',
      'TOKEN=secret:piped-token',
      '--protocol',
      'legacy',
      '--timeout',
      '30000',
      '--startup-timeout',
      '20000',
      '--',
      'node',
      fixture,
    ]);
    // The secret is not set yet: the server reports it by name.
    expect(added.code).toBe(1);
    expect(added.stdout).toContain('Added files.');
    expect(added.stderr).toContain(
      'Secret "piped-token" is not set. Set it with: mcpier secret set piped-token',
    );
    expect(stored('files')).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: [fixture],
      env: { MODE: 'test', TOKEN: 'secret:piped-token' },
      description: 'Fake files',
      protocol: 'legacy',
      timeoutMs: 30000,
      startupTimeoutMs: 20000,
    });
  });

  it('stores a secret from piped input, which restarts the server that uses it', async () => {
    const set = await cli(['secret', 'set', 'piped-token'], SECRETS.piped);
    expect(set.code).toBe(0);
    expect(set.stdout).toBe('Secret piped-token saved in Credential Manager.\nRestarted: files\n');
    expect(await t.secrets.get('piped-token')).toBe(SECRETS.piped);
    await waitForStatus(t.gateway, 'files', 'ready');
    const list = await cli(['server', 'list']);
    expect(list.stdout).toMatch(/^NAME\s+TRANSPORT\s+STATUS\s+PROTOCOL\s+TOOLS\s+LAST ERROR$/m);
    expect(list.stdout).toMatch(/^files\s+stdio\s+ready\s+2025-11-25\s+\d+\/\d+$/m);
  });

  it('adds a remote server with a secret header and waits until it is ready', async () => {
    await t.secrets.set('header-key', SECRETS.header);
    const added = await cli([
      'server',
      'add',
      'remote',
      '--url',
      stateless.url,
      '--header',
      'X-Key: secret:header-key',
    ]);
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(
      /Waiting for remote to start .*\nremote is ready \(protocol 2026-07-28, 9 tools\)\./,
    );
    expect(stored('remote')).toMatchObject({
      transport: 'http',
      url: stateless.url,
      headers: { 'X-Key': 'secret:header-key' },
    });
    expect(stateless.receivedHeaders().at(-1)!['x-key']).toBe(SECRETS.header);
  });

  it('adds an oauth server (needs_auth), a disabled one, and reports a broken command', async () => {
    const oauth = await cli(['server', 'add', 'notion', '--url', 'https://mcp.example.com/mcp', '--oauth']);
    expect(oauth.code).toBe(0);
    expect(oauth.stdout).toContain('notion needs sign-in: Sign in required');
    const disabled = await cli(['server', 'add', 'later', '--disabled', '--', 'node', fixture]);
    expect(disabled.stdout).toBe('Added later.\n');
    const broken = await cli(['server', 'add', 'broken', '--', 'npxx-not-installed', 'foo']);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('broken failed to start');
    expect(broken.stderr).toContain('The command "npxx-not-installed" was not found.');
    expect(broken.stderr).toContain(
      "'npxx-not-installed' is not recognized as an internal or external command",
    );
    await cli(['server', 'remove', 'broken']);
  });

  it('rejects bad add commands with one clear line', async () => {
    const both = await cli(['server', 'add', 'x', '--url', 'https://e.com/mcp', '--', 'node']);
    expect(both.stderr).toBe('mcpier: Give either a command (after --) or --url, not both.\n');
    const neither = await cli(['server', 'add', 'x']);
    expect(neither.stderr).toContain('Give the server command after --');
    expect((await cli(['server', 'add', 'x', '--protocol', 'v9', '--', 'node'])).stderr).toContain(
      '--protocol must be one of',
    );
    const invalid = await cli(['server', 'add', 'Bad_Name', '--', 'node']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toBe(
      'mcpier: The server entry is invalid.\n  - name: must be a lowercase slug: letters a-z, digits and single hyphens between them, starting with a letter\n',
    );
    const duplicate = await cli(['server', 'add', 'files', '--', 'node']);
    expect(duplicate.stderr).toBe('mcpier: A server named "files" already exists.\n');
  });

  it('shows a server as stored, with tools, in text and JSON', async () => {
    const text = await cli(['server', 'show', 'files']);
    expect(text.stdout).toMatch(/^files is ready\n/);
    expect(text.stdout).toContain('"TOKEN": "secret:piped-token"');
    expect(text.stdout).toContain('files__echo');
    const json = JSON.parse((await cli(['server', 'show', 'files', '--json'])).stdout);
    expect(json.config.env.TOKEN).toBe('secret:piped-token');
    expect((await cli(['server', 'show', 'ghost'])).stderr).toBe('mcpier: No server named "ghost".\n');
  });

  it('stops, starts, restarts, disables, enables and refreshes', async () => {
    expect((await cli(['server', 'stop', 'files'])).stdout).toBe('files is stopped.\n');
    expect((await cli(['server', 'start', 'files'])).stdout).toMatch(/files is ready/);
    expect((await cli(['server', 'restart', 'files'])).stdout).toMatch(/files is ready/);
    expect((await cli(['server', 'disable', 'files'])).stdout).toBe('files is disabled.\n');
    const startDisabled = await cli(['server', 'start', 'files']);
    expect(startDisabled.code).toBe(1);
    expect(startDisabled.stderr).toBe('mcpier: Server "files" is disabled. Enable it to start it.\n');
    expect((await cli(['server', 'enable', 'files'])).stdout).toMatch(/files is ready/);
    expect((await cli(['server', 'refresh', 'files'])).stdout).toMatch(
      /^files: \d+ tools \(\d+ enabled\)\.\n$/,
    );
  });

  it('enable and disable: --json, and an unknown server', async () => {
    const disabled = await cli(['server', 'disable', 'files', '--json']);
    expect(disabled.code).toBe(0);
    expect(JSON.parse(disabled.stdout).server).toMatchObject({ name: 'files', enabled: false });
    expect(stored('files')).toMatchObject({ enabled: false });
    const enabled = await cli(['server', 'enable', 'files', '--json']);
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.stdout).server).toMatchObject({
      name: 'files',
      enabled: true,
      status: { state: 'ready' },
    });
    for (const action of ['enable', 'disable']) {
      const unknown = await cli(['server', action, 'ghost']);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toBe('mcpier: No server named "ghost".\n');
    }
  });

  it('prints recent log lines and follows new ones', async () => {
    const recent = await cli(['server', 'logs', 'files', '--lines', '5']);
    expect(recent.stdout.trim().split('\n').length).toBeLessThanOrEqual(5);
    const listening = t.gateway.manager.listenerCount('log');
    const child = spawnCli(['server', 'logs', 'files', '--lines', '0', '--follow'], t.home.env(t.port));
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    try {
      // With --lines 0 only lines written after the stream subscribed are shown: wait until the
      // stream route has subscribed to the manager's log lines, then cause a new one.
      await waitUntil(() => t.gateway.manager.listenerCount('log') > listening, 20_000);
      await t.gateway.manager.callTool('files__echo', { text: 'follow me' });
      const deadline = Date.now() + 10_000;
      while (!output.includes('[fake-stdio] call echo') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output).toMatch(/\[stderr\] \[fake-stdio\] call echo/);
    } finally {
      child.kill();
    }
  });
});

describe('mcpier tools', () => {
  it('lists enabled tools, all tools with markers, one server, and JSON', async () => {
    const list = await cli(['tools', 'list', '--server', 'files']);
    expect(list.stdout).toMatch(/^TOOL\s+DESCRIPTION$/m);
    expect(list.stdout).toMatch(/^files__echo\s+Returns the given text unchanged\.$/m);
    const json = JSON.parse((await cli(['tools', 'list', '--json'])).stdout) as {
      tools: { fullName: string }[];
    };
    expect(json.tools.some((tool) => tool.fullName === 'remote__add')).toBe(true);
  });

  it('disables and enables a tool', async () => {
    expect((await cli(['tools', 'disable', 'files__fail'])).stdout).toBe('files__fail is disabled.\n');
    expect((await cli(['tools', 'list', '--server', 'files'])).stdout).not.toContain('files__fail');
    expect((await cli(['tools', 'list', '--server', 'files', '--all'])).stdout).toMatch(
      /^files__fail\s+disabled\s+/m,
    );
    expect(stored('files')).toMatchObject({ disabledTools: ['fail'] });
    expect((await cli(['tools', 'enable', 'files__fail'])).stdout).toBe('files__fail is enabled.\n');
    expect((await cli(['tools', 'disable', 'files__ghost'])).stderr).toBe(
      'mcpier: Server "files" has no tool named "ghost".\n',
    );
  });

  it('calls a tool and prints text, structured output, raw JSON and errors', async () => {
    const echo = await cli(['tools', 'call', 'files__echo', '--args', '{"text":"hello there"}']);
    expect(echo).toMatchObject({ code: 0, stdout: 'hello there\n' });
    const raw = JSON.parse(
      (await cli(['tools', 'call', 'files__add', '--args', '{"a":1,"b":2}', '--json'])).stdout,
    );
    expect(raw.result.structuredContent).toEqual({ sum: 3 });
    expect(typeof raw.durationMs).toBe('number');
    const failing = await cli(['tools', 'call', 'files__fail', '--args', '{"message":"it broke"}']);
    expect(failing).toMatchObject({ code: 1, stderr: 'The tool returned an error:\nit broke\n' });
    const badArgs = await cli(['tools', 'call', 'files__echo', '--args', '{nope']);
    expect(badArgs.code).toBe(1);
    expect(badArgs.stderr).toMatch(/^mcpier: --args is not valid JSON/);
    // The secret reaches the server but never the output.
    const envEcho = await cli(['tools', 'call', 'files__env_echo', '--args', '{"name":"TOKEN"}']);
    expect(envEcho.stdout).toBe('[secret:piped-token]\n');
  });
});

describe('mcpier secret', () => {
  it('lists names with last four characters and users', async () => {
    const list = await cli(['secret', 'list']);
    expect(list.stdout).toMatch(/^NAME\s+LAST 4\s+USED BY$/m);
    expect(list.stdout).toMatch(/^piped-token\s+abcd\s+files$/m);
    expect(list.stdout).toMatch(/^header-key\s+efgh\s+remote$/m);
    const json = JSON.parse((await cli(['secret', 'list', '--json'])).stdout);
    expect(json.secrets).toContainEqual({ name: 'piped-token', last4: 'abcd', usedBy: ['files'] });
  });

  it('refuses to delete a used secret unless forced, and never takes a value as an argument', async () => {
    const refused = await cli(['secret', 'delete', 'header-key']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Secret "header-key" is used by "remote"');
    const forced = await cli(['secret', 'delete', 'header-key', '--force']);
    expect(forced.stdout).toBe('Secret header-key deleted.\nRestarted: remote\n');
    await waitForStatus(t.gateway, 'remote', 'error');
    const extra = await cli(['secret', 'set', 'some-name', 'the-value-as-arg']);
    expect(extra.code).not.toBe(0);
    expect(extra.stderr).toContain('too many arguments');
    const empty = await cli(['secret', 'set', 'empty-one'], '');
    expect(empty.stderr).toBe('mcpier: No value given; nothing was stored.\n');
    expect((await cli(['secret', 'set', 'Bad_Name'], 'x')).stderr).toContain('Secret name "Bad_Name"');
  });
});

describe('mcpier server import', () => {
  const writeBlock = (name: string, block: unknown) => {
    const file = join(t.home.dir, name);
    writeFileSync(file, JSON.stringify(block));
    return file;
  };

  it('previews with --dry-run without saving or storing anything', async () => {
    const before = readFileSync(t.home.paths.config, 'utf8');
    const file = writeBlock('dry.json', {
      mcpServers: { 'Dry Run': { command: 'node', args: [fixture], env: { API_TOKEN: SECRETS.imported } } },
    });
    const result = await cli(['server', 'import', file, '--dry-run', '--move-secrets']);
    expect(result.stdout).toContain(`Would create dry-run (stdio): node ${fixture}`);
    expect(result.stdout).toContain('Would store dry-run env API_TOKEN as secret "dry-run-api-token".');
    expect(readFileSync(t.home.paths.config, 'utf8')).toBe(before);
    expect(await t.secrets.get('dry-run-api-token')).toBeUndefined();
  });

  it('moves credential-looking values into the secret store with --move-secrets', async () => {
    const file = writeBlock('move.json', {
      mcpServers: {
        Imported: {
          command: 'node',
          args: [fixture],
          env: { API_TOKEN: SECRETS.imported, MODE: 'plain' },
          cwd: 'C:\\',
        },
        'Remote Two': {
          type: 'http',
          url: stateless.url,
          headers: { Authorization: `Bearer ${SECRETS.bearer}` },
        },
      },
    });
    const result = await cli(['server', 'import', file, '--move-secrets']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Created imported (stdio): node ${fixture}`);
    expect(result.stdout).toContain('  Ignored fields: cwd');
    expect(result.stdout).toContain('Stored imported env API_TOKEN as secret "imported-api-token".');
    expect(result.stdout).toContain(
      'Stored remote-two header Authorization as secret "remote-two-authorization".',
    );
    expect(stored('imported')).toMatchObject({
      env: { API_TOKEN: 'secret:imported-api-token', MODE: 'plain' },
    });
    expect(stored('remote-two')).toMatchObject({
      headers: { Authorization: 'Bearer secret:remote-two-authorization' },
    });
    expect(await t.secrets.get('imported-api-token')).toBe(SECRETS.imported);
    expect(await t.secrets.get('remote-two-authorization')).toBe(SECRETS.bearer);
    await waitForStatus(t.gateway, 'remote-two', 'ready');
    expect(stateless.receivedHeaders().at(-1)!.authorization).toBe(`Bearer ${SECRETS.bearer}`);
    expect(readFileSync(t.home.paths.config, 'utf8')).not.toContain(SECRETS.imported);
  });

  it('keeps plain values with --keep-secrets, and warns (names only) when it cannot ask', async () => {
    const keep = await cli([
      'server',
      'import',
      writeBlock('keep.json', {
        servers: { kept: { command: 'node', args: [fixture], env: { DB_PASSWORD: 'pw-plain-1' } } },
      }),
      '--keep-secrets',
    ]);
    expect(keep.stdout).toContain('Created kept (stdio)');
    expect(stored('kept')).toMatchObject({ env: { DB_PASSWORD: 'pw-plain-1' } });
    // Standard input is not a terminal here, so no question is asked.
    const piped = await cli(
      ['server', 'import', '-'],
      JSON.stringify({
        quiet: { command: 'node', args: [fixture], env: { GH_PAT: 'pat-plain-2' }, disabled: true },
      }),
    );
    expect(piped.stdout).toContain('Created quiet (stdio)');
    expect(piped.stderr).toContain('Warning: kept as plain text in config.json: quiet env GH_PAT.');
    expect(piped.stderr).not.toContain('pat-plain-2');
  });

  it('reports sse entries, collisions and Windows cmd /c entries', async () => {
    const result = await cli([
      'server',
      'import',
      writeBlock('mixed.json', {
        mcpServers: {
          files: { command: 'node' },
          old: { type: 'sse', url: 'https://x.example/sse' },
          'Win Style': { command: 'cmd', args: ['/c', 'npx', '-y', '@scope/server'], disabled: true },
        },
      }),
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Created win-style (stdio): cmd /c npx -y @scope/server');
    expect(result.stderr).toContain(
      'Not imported: "files" becomes the server name "files", which already exists.',
    );
    expect(result.stderr).toContain('Not imported: "old" uses the deprecated HTTP+SSE transport');
    expect(stored('win-style')).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@scope/server'],
      enabled: false,
    });
    const bad = await cli([
      'server',
      'import',
      writeBlock('bad.json', 'not json at all').replace('bad.json', 'missing.json'),
    ]);
    expect(bad.stderr).toMatch(/^mcpier: Cannot read .*missing\.json: ENOENT/);
  });
});

describe('mcpier status with servers', () => {
  it('shows counts per status', async () => {
    const status = await cli(['status']);
    expect(status.stdout).toMatch(/Servers:\s+\d+ configured, \d+ enabled \(.*\d+ ready.*\)/);
  });

  it('removes servers', async () => {
    expect((await cli(['server', 'remove', 'later'])).stdout).toBe('Removed later.\n');
    expect((await cli(['server', 'remove', 'later'])).stderr).toBe('mcpier: No server named "later".\n');
  });
});
