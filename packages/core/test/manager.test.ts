import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpierConfig, ServerStatus } from '@mcpier/shared';
import { fixtureScripts, startStatelessServer } from '@mcpier/test-fixtures';
import { catalogEntries, ConflictError, getPlatform, toolNameFlag, type RunningGateway } from '@mcpier/core';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';
import { httpRequest } from '../../../test/helpers/http.js';
import { getFreePort } from '../../../test/helpers/ports.js';

const { processes } = getPlatform();

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: 'stdio' as const,
  command: process.execPath,
  args: [fixtureScripts.stdio],
  ...extra,
});
const http = (name: string, url: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: 'http' as const,
  url,
  ...extra,
});

const running: TestGateway[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.cleanup();
  for (const close of closers.splice(0)) await close().catch(() => {});
});

async function gatewayWith(servers: unknown[], extra: Partial<Parameters<typeof startTestGateway>[0]> = {}) {
  const t = await startTestGateway({ config: { servers } as never, timing: FAST_TIMING, ...extra });
  running.push(t);
  return t;
}

function recordStatuses(gateway: RunningGateway, server: string): ServerStatus[] {
  const seen: ServerStatus[] = [];
  gateway.manager.on('status', (name, info) => {
    if (name === server) seen.push(info.state);
  });
  return seen;
}

function update(gateway: RunningGateway, mutate: (config: McpierConfig) => void) {
  return gateway.config.update((draft) => {
    mutate(draft);
  });
}

describe('server manager: startup and statuses', () => {
  it('starts enabled servers in parallel; one failing server blocks nobody', async () => {
    const stateless = await startStatelessServer();
    closers.push(() => stateless.close());
    const t = await gatewayWith([
      stdio('good-stdio'),
      http('good-http', stateless.url),
      stdio('broken', { command: 'mcpier-no-such-command-x2' }),
      stdio('off', { enabled: false }),
    ]);
    const health = await httpRequest(t.port, { path: '/healthz' });
    expect(health.status).toBe(200);
    await waitForStatus(t.gateway, 'good-stdio', 'ready');
    await waitForStatus(t.gateway, 'good-http', 'ready');
    await waitForStatus(t.gateway, 'broken', ['error', 'crashed']);
    expect(t.gateway.manager.status('off').state).toBe('stopped');
    expect(t.gateway.manager.status('broken').detail).toContain('was not found');
    const summary = t.gateway.manager.summary('good-stdio');
    expect(summary).toMatchObject({ transport: 'stdio', protocolVersion: '2025-11-25', enabled: true });
    expect(summary.tools.total).toBeGreaterThan(5);
    expect(t.gateway.manager.summary('good-http').protocolVersion).toBe('2026-07-28');
  });

  it('goes stopped → starting → ready → stopped, and reports status counts', async () => {
    const t = await gatewayWith([stdio('cycle', { enabled: false })]);
    const seen = recordStatuses(t.gateway, 'cycle');
    await update(t.gateway, (config) => {
      config.servers[0]!.enabled = true;
    });
    await waitForStatus(t.gateway, 'cycle', 'ready');
    expect(t.gateway.manager.statusCounts()).toEqual({ ready: 1 });
    await t.gateway.manager.stop('cycle');
    expect(seen).toEqual(['starting', 'ready', 'stopped']);
  });

  it('marks an oauth server needs_auth without contacting it', async () => {
    const t = await gatewayWith([http('remote-oauth', 'http://127.0.0.1:9/mcp', { auth: 'oauth' })]);
    await waitForStatus(t.gateway, 'remote-oauth', 'needs_auth');
    expect(t.gateway.manager.status('remote-oauth').detail).toBe('Sign in required');
  });

  it('reports a missing secret by name without retrying, and starts once it is set', async () => {
    const t = await gatewayWith([stdio('needs-secret', { env: { TOKEN: 'secret:not-yet-set' } })]);
    await waitForStatus(t.gateway, 'needs-secret', 'error');
    expect(t.gateway.manager.status('needs-secret').detail).toBe(
      'Secret "not-yet-set" is not set. Set it with: mcpier secret set not-yet-set',
    );
    let retries = 0;
    t.gateway.manager.on('retry', () => retries++);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(retries).toBe(0);
    await t.secrets.set('not-yet-set', 'now-it-is-set-1234');
    expect(await t.gateway.manager.restartReferencing('not-yet-set')).toEqual(['needs-secret']);
    await waitForStatus(t.gateway, 'needs-secret', 'ready');
  });
});

describe('server manager: health checks, backoff and crashes', () => {
  it('marks a server error when its health check fails and reconnects when it is back', async () => {
    const port = await getFreePort();
    let fixture = await startStatelessServer({ port });
    closers.push(() => fixture.close());
    const t = await gatewayWith([http('flaky', fixture.url)]);
    await waitForStatus(t.gateway, 'flaky', 'ready');
    const seen = recordStatuses(t.gateway, 'flaky');

    await fixture.close();
    await waitForStatus(t.gateway, 'flaky', 'error');
    expect(t.gateway.manager.status('flaky').detail).toMatch(/Health check failed|Cannot reach/);

    fixture = await startStatelessServer({ port });
    closers.push(() => fixture.close());
    await waitForStatus(t.gateway, 'flaky', 'ready');
    expect(seen).toContain('error');
    expect(seen.at(-1)).toBe('ready');
  });

  it('backs off 1x, 2x, 4x … up to the cap, and never gives up on an HTTP server', async () => {
    const port = await getFreePort();
    const t = await gatewayWith([http('nobody-home', `http://127.0.0.1:${port}/mcp`)]);
    const delays: number[] = [];
    t.gateway.manager.on('retry', (name, delayMs) => {
      if (name === 'nobody-home') delays.push(delayMs);
    });
    // Each failed attempt includes the connector's own short network retries.
    await waitUntil(() => delays.length >= 5, 60_000);
    expect(delays.slice(0, 5)).toEqual([100, 200, 400, 800, 800]);
    // More failures than crashLimit (3), and still only "error".
    expect(t.gateway.manager.status('nobody-home').state).toBe('error');
  }, 90_000);

  it('marks a stdio server crashed after repeated crashes, and a restart brings it back', async () => {
    const t = await gatewayWith([stdio('crasher')]);
    for (let crash = 0; crash < 3; crash++) {
      await waitForStatus(t.gateway, 'crasher', ['ready', 'crashed']);
      if (t.gateway.manager.status('crasher').state === 'crashed') break;
      await t.gateway.manager.callTool('crasher__crash', {}).catch(() => {});
      await waitForStatus(t.gateway, 'crasher', ['error', 'crashed']);
    }
    await waitForStatus(t.gateway, 'crasher', 'crashed');
    expect(t.gateway.manager.status('crasher').detail).toMatch(/Failed 3 times within 60 s; not restarting/);
    let retries = 0;
    t.gateway.manager.on('retry', () => retries++);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(retries).toBe(0);
    await t.gateway.manager.restart('crasher');
    await waitForStatus(t.gateway, 'crasher', 'ready');
  });

  it('stops every server process on shutdown', async () => {
    const t = await startTestGateway({
      config: { servers: [stdio('one'), stdio('two')] } as never,
      timing: FAST_TIMING,
    });
    await waitForStatus(t.gateway, 'one', 'ready');
    await waitForStatus(t.gateway, 'two', 'ready');
    const pids = [t.gateway.manager.pid('one')!, t.gateway.manager.pid('two')!];
    expect(pids.every((pid) => processes.isAlive(pid))).toBe(true);
    await t.cleanup();
    expect(pids.some((pid) => processes.isAlive(pid))).toBe(false);
  });
});

describe('server manager: applying config changes as differences', () => {
  async function setup() {
    const stateless = await startStatelessServer();
    closers.push(() => stateless.close());
    const t = await gatewayWith([stdio('alpha'), stdio('beta'), http('remote', stateless.url)]);
    for (const name of ['alpha', 'beta', 'remote']) await waitForStatus(t.gateway, name, 'ready');
    const snapshot = () => ({
      alpha: t.gateway.manager.pid('alpha'),
      beta: t.gateway.manager.has('beta') ? t.gateway.manager.pid('beta') : undefined,
      remoteSince: t.gateway.manager.status('remote').since,
    });
    return { t, snapshot };
  }

  it('starts a new server and stops a removed one (dropping its tools)', async () => {
    const { t, snapshot } = await setup();
    const before = snapshot();
    const betaPid = before.beta!;
    await update(t.gateway, (config) => {
      config.servers = config.servers.filter((server) => server.name !== 'beta');
      config.servers.push({ ...stdio('gamma'), enabled: true } as never);
    });
    await waitForStatus(t.gateway, 'gamma', 'ready');
    await waitUntil(() => !processes.isAlive(betaPid));
    expect(t.gateway.manager.has('beta')).toBe(false);
    expect(t.gateway.manager.tools().some((tool) => tool.server === 'beta')).toBe(false);
    expect(snapshot().alpha).toBe(before.alpha);
    expect(snapshot().remoteSince).toBe(before.remoteSince);
  });

  it('restarts only the server whose connection fields changed', async () => {
    const { t, snapshot } = await setup();
    const before = snapshot();
    await update(t.gateway, (config) => {
      const alpha = config.servers.find((server) => server.name === 'alpha')!;
      if (alpha.transport === 'stdio') alpha.args = [...alpha.args, '--unused-flag'];
    });
    await waitUntil(
      () =>
        t.gateway.manager.pid('alpha') !== before.alpha &&
        t.gateway.manager.status('alpha').state === 'ready',
    );
    expect(snapshot().beta).toBe(before.beta);
    expect(snapshot().remoteSince).toBe(before.remoteSince);
  });

  it('starts and stops on enabled changes', async () => {
    const { t, snapshot } = await setup();
    const before = snapshot();
    await update(t.gateway, (config) => {
      config.servers.find((server) => server.name === 'beta')!.enabled = false;
    });
    await waitForStatus(t.gateway, 'beta', 'stopped');
    await waitUntil(() => !processes.isAlive(before.beta!));
    await update(t.gateway, (config) => {
      config.servers.find((server) => server.name === 'beta')!.enabled = true;
    });
    await waitForStatus(t.gateway, 'beta', 'ready');
    expect(snapshot().alpha).toBe(before.alpha);
  });

  it('applies description, timeoutMs and disabledTools without a restart', async () => {
    const { t, snapshot } = await setup();
    const before = snapshot();
    await update(t.gateway, (config) => {
      const alpha = config.servers.find((server) => server.name === 'alpha')!;
      alpha.description = 'changed';
      alpha.timeoutMs = 1234;
      alpha.disabledTools = ['echo'];
    });
    expect(snapshot()).toEqual(before);
    expect(t.gateway.manager.summary('alpha').description).toBe('changed');
    expect(t.gateway.manager.tool('alpha__echo').enabled).toBe(false);
    await expect(t.gateway.manager.callTool('alpha__echo', { text: 'x' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('restarts stdio servers, and only those, when extraPath changes', async () => {
    const { t, snapshot } = await setup();
    const before = snapshot();
    await update(t.gateway, (config) => {
      config.settings.extraPath = ['C:\\mcpier-test-extra'];
    });
    await waitUntil(
      () =>
        t.gateway.manager.pid('alpha') !== before.alpha &&
        t.gateway.manager.pid('beta') !== before.beta &&
        t.gateway.manager.status('alpha').state === 'ready' &&
        t.gateway.manager.status('beta').state === 'ready',
    );
    expect(snapshot().remoteSince).toBe(before.remoteSince);
    // The new PATH reaches the server process.
    const result = await t.gateway.manager.callTool('alpha__env_echo', { name: 'PATH' });
    expect(JSON.stringify(result)).toContain('mcpier-test-extra');
  });
});

describe('config.json hand edits', () => {
  it('applies a valid edit without restarting, and ignores its own saves', async () => {
    const t = await gatewayWith([stdio('edited')]);
    await waitForStatus(t.gateway, 'edited', 'ready');
    const pid = t.gateway.manager.pid('edited');
    let applied = 0;
    t.gateway.config.on('applied', () => applied++);

    const config = JSON.parse(readFileSync(t.home.paths.config, 'utf8'));
    config.servers[0].description = 'edited by hand';
    writeFileSync(t.home.paths.config, JSON.stringify(config, null, 2));
    await waitUntil(() => t.gateway.manager.summary('edited').description === 'edited by hand');
    expect(t.gateway.manager.pid('edited')).toBe(pid);
    expect(applied).toBe(1);

    // A save through MCPier does not come back as a reload.
    await update(t.gateway, (draft) => {
      draft.servers[0]!.description = 'saved by MCPier';
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(applied).toBe(2);
  });

  it('keeps running on the last good config when an edit is invalid, and shows the problem', async () => {
    const t = await gatewayWith([stdio('steady')]);
    await waitForStatus(t.gateway, 'steady', 'ready');
    const broken = '{ "servers": [ { "name": "Broken Name" } ';
    writeFileSync(t.home.paths.config, broken);
    await waitUntil(() => t.gateway.config.problem !== undefined);
    expect(t.gateway.config.problem!.problems[0]).toMatch(/^not valid JSON/);

    const status = await httpRequest(t.port, {
      path: '/api/status',
      headers: { authorization: `Bearer ${t.token}` },
    });
    expect(status.json<{ configProblem?: { problems: string[] } }>().configProblem?.problems[0]).toMatch(
      /^not valid JSON/,
    );
    expect(t.gateway.manager.status('steady').state).toBe('ready');
    expect(await t.gateway.manager.callTool('steady__echo', { text: 'still works' })).toMatchObject({
      kind: 'result',
      result: {
        content: [{ type: 'text', text: 'still works' }],
      },
    });

    // Changes through MCPier are refused rather than overwriting the broken edit.
    await expect(
      update(t.gateway, (draft) => void (draft.settings.logRetentionDays = 7)),
    ).rejects.toMatchObject({
      code: 'config_invalid',
    });
    expect(readFileSync(t.home.paths.config, 'utf8')).toBe(broken);

    // Fixing the file clears the problem.
    writeFileSync(
      t.home.paths.config,
      JSON.stringify({ servers: [{ ...stdio('steady'), description: 'fixed' }] }, null, 2),
    );
    await waitUntil(() => t.gateway.config.problem === undefined);
    await waitUntil(() => t.gateway.manager.summary('steady').description === 'fixed');
  });

  it('picks up a pending hand edit before saving a change through MCPier', async () => {
    const t = await gatewayWith([stdio('merge', { enabled: false })], { configDebounceMs: 5000 });
    const config = JSON.parse(readFileSync(t.home.paths.config, 'utf8'));
    config.servers[0].description = 'from the hand edit';
    writeFileSync(t.home.paths.config, JSON.stringify(config, null, 2));
    // The watcher has not fired yet (long debounce); the update must still see the edit.
    await update(t.gateway, (draft) => void (draft.settings.logRetentionDays = 9));
    const saved = JSON.parse(readFileSync(t.home.paths.config, 'utf8'));
    expect(saved.servers[0].description).toBe('from the hand edit');
    expect(saved.settings.logRetentionDays).toBe(9);
  });
});

describe('tool catalog', () => {
  it('lists tools by full name with enabled and availability flags', async () => {
    const t = await gatewayWith([
      stdio('cat', { disabledTools: ['fail'] }),
      stdio('quiet', { enabled: false }),
    ]);
    await waitForStatus(t.gateway, 'cat', 'ready');
    const tools = t.gateway.manager.tools('cat');
    expect(tools.map((tool) => tool.fullName)).toContain('cat__echo');
    const echo = t.gateway.manager.tool('cat__echo');
    expect(echo).toMatchObject({ server: 'cat', name: 'echo', enabled: true, available: true });
    expect(echo.description).toBe('Returns the given text unchanged.');
    expect(echo.inputSchema).toMatchObject({ type: 'object' });
    expect(t.gateway.manager.tool('cat__add').outputSchema).toMatchObject({ type: 'object' });
    expect(t.gateway.manager.tool('cat__fail').enabled).toBe(false);
    expect(t.gateway.manager.summary('cat').tools.enabled).toBe(
      t.gateway.manager.summary('cat').tools.total - 1,
    );
    // A disabled server that never ran has no known tools yet.
    expect(t.gateway.manager.tools('quiet')).toEqual([]);
  });

  it('refreshes when the server announces a changed tool list', async () => {
    const t = await gatewayWith([stdio('changing')]);
    await waitForStatus(t.gateway, 'changing', 'ready');
    expect(t.gateway.manager.tools('changing').some((tool) => tool.name === 'added_tool')).toBe(false);
    await t.gateway.manager.callTool('changing__change_tools', {});
    await waitUntil(() => t.gateway.manager.tools('changing').some((tool) => tool.name === 'added_tool'));
    expect(t.gateway.manager.tool('changing__added_tool').available).toBe(true);
  });

  it('refreshes a modern server’s list when its ttlMs passes', async () => {
    const stateless = await startStatelessServer({ toolsTtlMs: 200 });
    closers.push(() => stateless.close());
    const t = await gatewayWith([http('ttl', stateless.url)]);
    await waitForStatus(t.gateway, 'ttl', 'ready');
    const listings = () =>
      stateless.receivedHeaders().filter((headers) => headers['mcp-method'] === 'tools/list').length;
    const first = listings();
    await waitUntil(() => listings() >= first + 2, 5000);
  });

  it('keeps tools, marked unavailable, after a crash or stop; removing the server removes them', async () => {
    const t = await gatewayWith([stdio('fragile')]);
    await waitForStatus(t.gateway, 'fragile', 'ready');
    const total = t.gateway.manager.tools('fragile').length;
    await t.gateway.manager.callTool('fragile__crash', {}).catch(() => {});
    await waitForStatus(t.gateway, 'fragile', ['error', 'starting']);
    await t.gateway.manager.stop('fragile');
    const tools = t.gateway.manager.tools('fragile');
    expect(tools).toHaveLength(total);
    expect(tools.every((tool) => !tool.available)).toBe(true);
    await expect(t.gateway.manager.callTool('fragile__echo', { text: 'x' })).rejects.toThrow(
      /is stopped, not ready/,
    );
    await update(t.gateway, (config) => {
      config.servers = [];
    });
    expect(t.gateway.manager.tools()).toEqual([]);
  });

  it('flags upstream names that break the naming rule but keeps them', () => {
    expect(toolNameFlag('create_issue')).toBeUndefined();
    expect(toolNameFlag('weird__name')).toContain('contains "__"');
    expect(toolNameFlag('has space')).toContain('characters outside');
    const entries = catalogEntries(
      {
        ...stdio('srv'),
        enabled: true,
        disabledTools: [],
        timeoutMs: 1,
        protocol: 'auto',
        startupTimeoutMs: 1000,
        env: {},
      } as never,
      [
        { name: 'weird__name', inputSchema: { type: 'object' } },
        {
          name: 'ok',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ] as never,
      true,
    );
    expect(entries[0]).toMatchObject({ fullName: 'srv__weird__name', name: 'weird__name' });
    expect(entries[0]!.flag).toBeDefined();
    expect(entries[1]).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(entries[1]!.flag).toBeUndefined();
  });
});
