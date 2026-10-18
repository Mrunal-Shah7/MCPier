import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDataDir, getPlatform, probeHealth, readAdminToken, readPidFile } from '@mcpier/core';
import { runCli, type CliResult } from '../../../test/helpers/cli.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const { processes } = getPlatform();

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('mcpier CLI basics', () => {
  it('prints the project version', async () => {
    const home = createTempHome();
    try {
      for (const flag of ['--version', '-v']) {
        const result = await runCli([flag], home.env());
        expect(result).toMatchObject({ code: 0, stdout: '1.1.0\n' });
      }
    } finally {
      await home.cleanup();
    }
  });

  it('lists every command in help, and hides the internal one', async () => {
    const home = createTempHome();
    try {
      const result = await runCli(['--help'], home.env());
      expect(result.code).toBe(0);
      for (const command of [
        'start',
        'stop',
        'status',
        'server',
        'tools',
        'secret',
        'connect',
        'stdio',
        'open',
        'auth',
        'autostart',
        'doctor',
      ]) {
        expect(result.stdout).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
      }
      // The internal command stays hidden.
      for (const later of ['run-gateway']) {
        expect(result.stdout).not.toMatch(new RegExp(`^  ${later}\\b`, 'm'));
      }
    } finally {
      await home.cleanup();
    }
  });

  it('reports an unknown command with a non-zero exit', async () => {
    const home = createTempHome();
    try {
      const result = await runCli(['frobnicate'], home.env());
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("unknown command 'frobnicate'");
    } finally {
      await home.cleanup();
    }
  });
});

describe('mcpier start / status / stop (built CLI, temporary home, random port)', () => {
  let home: TempHome;
  let port: number;
  let env: NodeJS.ProcessEnv;
  const outputs: CliResult[] = [];
  const cli = async (...args: string[]) => {
    const result = await runCli(args, env);
    outputs.push(result);
    return result;
  };

  beforeAll(async () => {
    home = createTempHome();
    port = await getFreePort();
    env = home.env(port);
  });

  afterAll(async () => {
    // The token must never appear in anything the CLI prints.
    if (existsSync(home.paths.adminToken)) {
      const token = readAdminToken(home.paths.adminToken);
      for (const output of outputs) expect(output.stdout + output.stderr).not.toContain(token);
    }
    await home.cleanup();
  });

  it('status reports stopped with exit code 3', async () => {
    const result = await cli('status');
    expect(result).toMatchObject({ code: 3, stdout: 'MCPier is stopped.\n' });
    const json = await cli('status', '--json');
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({ running: false, port });
  });

  it('start launches a background gateway that answers the health check', async () => {
    const result = await cli('start');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const pid = readPidFile(home.paths.pidFile)?.pid;
    expect(pid).toBeDefined();
    expect(result.stdout).toBe(
      `MCPier started (pid ${pid}).\nDashboard: http://127.0.0.1:${port}/ (sign in with: mcpier open)\n`,
    );
    // The CLI process has exited; the gateway keeps running on its own.
    expect(processes.isAlive(pid!)).toBe(true);
    expect((await probeHealth(port)).kind).toBe('mcpier');
    expect(existsSync(home.paths.config)).toBe(true);
    expect(existsSync(home.paths.gatewayLog)).toBe(true);
  });

  it('start again reports that it is already running, with exit code 0', async () => {
    const pid = readPidFile(home.paths.pidFile)?.pid;
    const result = await cli('start');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`MCPier is already running (pid ${pid}) at http://127.0.0.1:${port}/\n`);
  });

  it('status shows the running gateway', async () => {
    const result = await cli('status');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('MCPier is running.');
    expect(result.stdout).toContain(`Port:           ${port}`);
    expect(result.stdout).toContain(`Data directory: ${home.dir}`);
    expect(result.stdout).toContain('Servers:        0 configured, 0 enabled');
  });

  it('status --json returns machine-readable details', async () => {
    const result = await cli('status', '--json');
    expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(status).toMatchObject({
      running: true,
      url: `http://127.0.0.1:${port}/`,
      version: '1.1.0',
      pid: readPidFile(home.paths.pidFile)?.pid,
      port,
      dataDir: home.dir,
      servers: { configured: 0, enabled: 0 },
    });
    expect(typeof status.uptimeSeconds).toBe('number');
    expect(typeof status.startedAt).toBe('string');
  });

  it('stop shuts the gateway down and removes the pid file', async () => {
    const pid = readPidFile(home.paths.pidFile)!.pid;
    const result = await cli('stop');
    expect(result).toMatchObject({ code: 0, stdout: 'MCPier stopped.\n' });
    expect(processes.isAlive(pid)).toBe(false);
    expect(existsSync(home.paths.pidFile)).toBe(false);
    expect((await probeHealth(port)).kind).toBe('none');
    const log = readFileSync(home.paths.gatewayLog, 'utf8');
    expect(log).toContain('Gateway stopped');
    expect(log).not.toContain(readAdminToken(home.paths.adminToken));
  });

  it('stop when already stopped says so and exits 0', async () => {
    const result = await cli('stop');
    expect(result).toMatchObject({ code: 0, stdout: 'MCPier is not running.\n' });
  });

  it('start refuses a corrupt config, prints the problems, and leaves the file untouched', async () => {
    const corrupt = '{ "servers": [ { "name": "Has Spaces", "transport": "stdio", "command": "x" } ] }';
    writeFileSync(home.paths.config, corrupt);
    try {
      const result = await cli('start');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`mcpier: The config file ${home.paths.config} is invalid`);
      expect(result.stderr).toContain('servers[0].name: must be a lowercase slug');
      expect(readFileSync(home.paths.config, 'utf8')).toBe(corrupt);
      expect((await probeHealth(port)).kind).toBe('none');
    } finally {
      writeFileSync(home.paths.config, '{}');
    }
  });

  it('start in a fresh home creates the data directory with config, token, pid file and log', async () => {
    const fresh = createTempHome();
    const freshPort = await getFreePort();
    try {
      const result = await runCli(['start'], fresh.env(freshPort));
      outputs.push(result);
      expect(result.code).toBe(0);
      for (const path of [
        fresh.paths.config,
        fresh.paths.adminToken,
        fresh.paths.pidFile,
        fresh.paths.gatewayLog,
      ]) {
        expect(existsSync(path)).toBe(true);
      }
      const stop = await runCli(['stop'], fresh.env(freshPort));
      expect(stop.code).toBe(0);
    } finally {
      await fresh.cleanup();
    }
  });
});

// Sprint 7, BUGS B-2: the gateway runs in its data folder, so a relative MCPIER_HOME must reach
// it already resolved, or it would use <home>\<home>.
describe('mcpier start with a relative MCPIER_HOME', () => {
  it('the gateway uses the folder the caller meant', async () => {
    const home = createTempHome();
    const freshPort = await getFreePort();
    const parent = dirname(home.dir);
    const env = { ...home.env(freshPort), MCPIER_HOME: basename(home.dir) };
    try {
      expect((await runCli(['start'], env, { cwd: parent })).code).toBe(0);
      const status = await runCli(['status', '--json'], env, { cwd: parent });
      expect(JSON.parse(status.stdout)).toMatchObject({ running: true, dataDir: home.dir });
      expect(existsSync(join(home.dir, basename(home.dir)))).toBe(false);
      expect((await runCli(['stop'], env, { cwd: parent })).code).toBe(0);
    } finally {
      await home.cleanup();
    }
  });
});

describe('mcpier stop: forced-stop fallback', () => {
  it(
    'stops a gateway that ignores the shutdown request by its process tree',
    { timeout: 40_000 },
    async () => {
      const home = createTempHome();
      const port = await getFreePort();
      try {
        await ensureDataDir(home.dir, getPlatform());
        // A stand-in gateway: answers like MCPier, accepts the shutdown request, never exits.
        const script = join(home.dir, 'stubborn-gateway.mjs');
        writeFileSync(
          script,
          `import { createServer } from 'node:http';
const port = Number(process.argv[2]);
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/healthz') return res.end(JSON.stringify({ service: 'mcpier', version: '1.0.0', status: 'ok' }));
  if (req.url === '/api/shutdown') return res.end(JSON.stringify({ status: 'shutting_down' }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
}).listen(port, '127.0.0.1');
`,
        );
        const { pid } = await processes.startDetached({
          command: process.execPath,
          args: [script, String(port)],
        });
        writeFileSync(home.paths.pidFile, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }));
        await waitUntil(async () => (await probeHealth(port)).kind === 'mcpier');

        const result = await runCli(['stop'], home.env(port));
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('a forced stop was used');
        expect(processes.isAlive(pid)).toBe(false);
        expect(existsSync(home.paths.pidFile)).toBe(false);
        expect((await probeHealth(port)).kind).toBe('none');
      } finally {
        await home.cleanup();
      }
    },
  );
});
