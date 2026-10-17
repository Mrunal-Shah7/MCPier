// Sprint 6, Phase 4: `mcpier doctor`. The checks run as a library against temporary homes,
// fake secret stores, a fake task layer, a fake gateway and temporary client config files;
// then the CLI itself for exit codes, --json and leaks. Never a real client config file.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdminAuthError,
  autostartAction,
  ensureDataDir,
  FakeAutostart,
  FakeFileSecurity,
  FakePlatform,
  FakeSecretStore,
  OAUTH_KEY_ACCOUNT,
  openDatabase,
  probeHealth,
  projectVersion,
  readAdminToken,
  type DataPaths,
  type HealthProbe,
} from '@mcpier/core';
import {
  AUTOSTART_TEST_TASK_PREFIX,
  DOCTOR_AREAS,
  type DoctorCheck,
  type DoctorReport,
  type ServerSummary,
} from '@mcpier/shared';
import { fixtureScripts } from '@mcpier/test-fixtures';
import { formatReport } from '../src/commands/doctor.js';
import { runDoctor, type DoctorDeps } from '../src/doctor/checks.js';
import { CLI_ENTRY, runCli } from '../../../test/helpers/cli.js';
import { startTestGateway, waitForStatus } from '../../../test/helpers/gateway.js';
import { getFreePort } from '../../../test/helpers/ports.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const TASK = `${AUTOSTART_TEST_TASK_PREFIX}doctor`;
const SECRET_VALUE = 'doctor-secret-value-8181';
const CLIENT_TOKEN = 'ghp_ClientConfigToken9191';
const OAUTH_KEY = 'oauth-store-key-value-7373';
const VERSION = projectVersion();

const scratch: string[] = [];
const homes: TempHome[] = [];
const reports: DoctorReport[] = [];
afterAll(async () => {
  for (const home of homes) await home.cleanup();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function touch(file: string, text = ''): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

interface World {
  home: TempHome;
  paths: DataPaths;
  bin: string;
  users: { appData: string; localAppData: string; profile: string };
  files: FakeFileSecurity;
  secrets: FakeSecretStore;
  autostart: FakeAutostart;
  deps: DoctorDeps;
  /** Fake gateway answers by path (an Error is thrown). */
  gateway: Record<string, unknown>;
  probe: HealthProbe;
  config(value: unknown): void;
}

/** A healthy machine: every check passes. Scenarios break one thing at a time. */
async function healthyWorld(): Promise<World> {
  const home = createTempHome();
  homes.push(home);
  const platform = new FakePlatform();
  await ensureDataDir(home.dir, platform);
  const paths = home.paths;
  const bin = tempDir('mcpier-doctor-bin-');
  for (const exe of ['node.exe', 'npx.cmd', 'uvx.exe', 'docker.exe']) touch(join(bin, exe));
  const extra = tempDir('mcpier-doctor-extra-');
  const userRoot = tempDir('mcpier-doctor-user-');
  const users = {
    appData: join(userRoot, 'AppData', 'Roaming'),
    localAppData: join(userRoot, 'AppData', 'Local'),
    profile: userRoot,
  };
  const secrets = new FakeSecretStore();
  await secrets.set('api-key', SECRET_VALUE);
  await secrets.internal().set(OAUTH_KEY_ACCOUNT, OAUTH_KEY);
  touch(join(paths.oauthDir, 'notion.json'), '{"format":"mcpier-oauth-record"}');
  const autostart = new FakeAutostart();
  await autostart.enable(TASK, autostartAction({ nodePath: process.execPath, cliEntry: CLI_ENTRY }));
  const opened = openDatabase(paths.db, { warn() {}, info() {}, error() {}, debug() {} } as never);
  opened.db!.close();

  const port = 47_999;
  const world: World = {
    home,
    paths,
    bin,
    users,
    files: platform.files,
    secrets,
    autostart,
    probe: { kind: 'mcpier', health: { service: 'mcpier', version: VERSION, status: 'ok' } } as HealthProbe,
    gateway: {
      '/api/status': { version: VERSION, pid: 1234, port, callLog: { store: 'sqlite' } },
      '/api/auth': { servers: [{ server: 'notion', signedIn: true, grantedScopes: [] }] },
      '/api/servers': {
        servers: [
          {
            name: 'local',
            transport: 'stdio',
            enabled: true,
            status: { state: 'ready', since: 'x' },
            tools: { total: 3, enabled: 3 },
          },
        ] satisfies Partial<ServerSummary>[],
      },
    },
    config(value: unknown) {
      writeFileSync(paths.config, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
    deps: undefined as never,
  };
  world.config({
    settings: { port, extraPath: [extra] },
    servers: [
      { name: 'local', transport: 'stdio', command: 'node', args: ['x.js'], env: { KEY: 'secret:api-key' } },
      { name: 'notion', transport: 'http', url: 'https://example.com/mcp', auth: 'oauth' },
    ],
  });
  // Clients: a bridge entry, an HTTP entry, VS Code with comments, a Codex table.
  touch(
    join(users.appData, 'Claude', 'claude_desktop_config.json'),
    JSON.stringify({
      mcpServers: {
        mcpier: { command: process.execPath, args: [CLI_ENTRY, 'stdio'] },
        other: { command: 'npx', env: { TOKEN: CLIENT_TOKEN } },
      },
    }),
  );
  touch(
    join(users.profile, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { mcpier: { url: `http://127.0.0.1:${port}/mcp` } } }),
  );
  touch(
    join(users.appData, 'Code', 'User', 'mcp.json'),
    `{\n  // MCP servers\n  "servers": {\n    "mcpier": { "type": "http", "url": "http://127.0.0.1:${port}/mcp" }, /* trailing */\n  },\n}\n`,
  );
  touch(
    join(users.profile, '.codex', 'config.toml'),
    `[other]\nx = 1\n\n[mcp_servers.mcpier]\ncommand = '${process.execPath}'\nargs = [\n  '${CLI_ENTRY}',\n  "stdio",\n]\n`,
  );

  world.deps = {
    env: {
      PATH: bin,
      PATHEXT: '.EXE;.CMD',
      APPDATA: users.appData,
      LOCALAPPDATA: users.localAppData,
      USERPROFILE: users.profile,
      USERDOMAIN: 'PC',
      USERNAME: 'me',
    },
    paths,
    cliVersion: VERSION,
    nodeVersion: '24.21.0',
    files: platform.files,
    secrets,
    autostart,
    autostartTaskName: TASK,
    probe: async () => world.probe,
    adminGet: async <T>(_port: number, token: string, path: string): Promise<T> => {
      expect(token).toBe(readAdminToken(paths.adminToken));
      const answer = world.gateway[path];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`no fake answer for ${path}`);
      return answer as T;
    },
  };
  return world;
}

async function doctor(world: World): Promise<DoctorReport> {
  const report = await runDoctor(world.deps);
  reports.push(report);
  return report;
}

const check = (report: DoctorReport, id: string): DoctorCheck => {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no check ${id}: ${report.checks.map((entry) => entry.id).join(', ')}`);
  return found;
};

describe('doctor: a healthy machine', () => {
  it('every check passes, in every area, and the report is ok', async () => {
    const report = await doctor(await healthyWorld());
    const notPassing = report.checks.filter((entry) => entry.status !== 'pass');
    expect(notPassing, JSON.stringify(notPassing, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(new Set(report.checks.map((entry) => entry.area))).toEqual(new Set(DOCTOR_AREAS));
    for (const id of [
      'node-version',
      'command-node',
      'command-npx',
      'command-uvx',
      'command-docker',
      'extra-path',
      'data-dir',
      'permissions',
      'config',
      'gateway',
      'gateway-version',
      'autostart',
      'database',
      'corrupt-databases',
      'credential-manager',
      'secret-references',
      'oauth-store-key',
      'oauth-unreadable',
      'oauth-sign-in',
      'command-local',
      'server-local',
      'client-claude-desktop',
      'client-claude-desktop-store',
      'client-cursor',
      'client-vscode',
      'client-codex',
    ]) {
      expect(check(report, id).status, id).toBe('pass');
    }
    expect(check(report, 'client-claude-desktop').message).toContain('MCPier entry "mcpier"');
    expect(check(report, 'client-codex').message).toContain('MCPier entry "mcpier"');
    expect(check(report, 'client-claude-desktop-store').message).toContain('no config file');
  });
});

describe('doctor: environment and data failures', () => {
  it('reports each broken piece with its fix', async () => {
    const world = await healthyWorld();
    world.deps.nodeVersion = '22.11.0';
    world.deps.env.PATH = '';
    world.config({
      settings: { port: 47_999, extraPath: ['C:\\no\\such\\folder'] },
      servers: [
        { name: 'py', transport: 'stdio', command: 'uvx', args: ['tool'], env: { KEY: 'secret:not-set' } },
        { name: 'box', transport: 'stdio', command: 'docker', args: ['run'] },
      ],
    });
    world.files.access.set(world.paths.dir, {
      restricted: false,
      others: ['BU'],
      protectedFromInheritance: false,
    });
    world.files.access.set(world.paths.adminToken, {
      restricted: false,
      others: ['WD'],
      protectedFromInheritance: false,
    });
    writeFileSync(world.paths.db, 'not a database at all, just some text');
    touch(join(world.paths.dir, 'mcpier.db.corrupt-2026-10-17T10-00-00-000Z'));
    touch(join(world.paths.oauthDir, 'linear.json.unreadable'));
    await world.secrets.internal().delete(OAUTH_KEY_ACCOUNT);
    world.probe = { kind: 'none' };

    const report = await doctor(world);
    expect(report.ok).toBe(false);
    const expectStatus = (id: string, status: DoctorCheck['status'], fix?: RegExp) => {
      const entry = check(report, id);
      expect(entry.status, `${id}: ${entry.message}`).toBe(status);
      if (fix) expect(entry.fix, id).toMatch(fix);
    };
    expectStatus('node-version', 'fail', /Install Node\.js 24/);
    expectStatus('command-node', 'fail', /extraPath/);
    expectStatus('command-npx', 'fail', /extraPath/);
    expectStatus('command-uvx', 'fail', /Install uv/);
    expectStatus('command-docker', 'fail', /Docker/);
    expectStatus('extra-path', 'fail', /settings\.extraPath/);
    expectStatus(
      'permissions',
      'fail',
      /icacls ".*" \/inheritance:r \/grant:r "PC\\me:\(OI\)\(CI\)F".*icacls ".*admin-token" \/reset/,
    );
    expect(check(report, 'permissions').message).toContain('BU');
    expectStatus('database', 'fail', /moves a damaged mcpier\.db aside/);
    expectStatus('corrupt-databases', 'warn', /Delete them/);
    expectStatus('oauth-unreadable', 'warn', /mcpier auth login linear/);
    expectStatus('oauth-store-key', 'fail', /Sign in again/);
    expectStatus('secret-references', 'fail', /^mcpier secret set not-set$/);
    expectStatus('command-py', 'fail', /mcpier server restart py/);
    expectStatus('gateway', 'warn', /mcpier start/);
    expectStatus('servers', 'warn', /mcpier start/);
    // The database check never moves the file (doctor only reads).
    expect(readFileOrEmpty(world.paths.db)).toBe('not a database at all, just some text');
  });

  it('an invalid config.json is a failure that never quotes the file', async () => {
    const world = await healthyWorld();
    world.config(`{"servers":[{"name":"x","transport":"stdio","command":"y","env":{"T": ${CLIENT_TOKEN}}}]}`);
    const report = await doctor(world);
    expect(check(report, 'config')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('config.json'),
    });
    expect(JSON.stringify(report)).not.toContain(CLIENT_TOKEN.slice(0, 8));
  });

  it('a missing data directory and config are warnings that say to start MCPier', async () => {
    const world = await healthyWorld();
    world.deps.paths = {
      ...world.paths,
      dir: join(world.paths.dir, 'nope'),
      config: join(world.paths.dir, 'nope', 'config.json'),
    };
    const report = await doctor(world);
    expect(check(report, 'data-dir')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('mcpier start'),
    });
    expect(check(report, 'config')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('mcpier start'),
    });
  });

  it('permissions that cannot be read are a warning', async () => {
    const world = await healthyWorld();
    world.files.access.set(world.paths.stateKey, new Error('icacls failed'));
    expect(check(await doctor(world), 'permissions')).toMatchObject({ status: 'warn' });
  });
});

function readFileOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

describe('doctor: the gateway', () => {
  it('port taken by another program, a different data directory, a version mismatch', async () => {
    const world = await healthyWorld();
    world.probe = { kind: 'other' };
    expect(check(await doctor(world), 'gateway')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('MCPIER_PORT'),
    });

    world.probe = {
      kind: 'mcpier',
      health: { service: 'mcpier', version: VERSION, status: 'ok' },
    } as HealthProbe;
    world.gateway['/api/status'] = new AdminAuthError(47_999);
    expect(check(await doctor(world), 'gateway')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('different data directory'),
    });

    world.gateway['/api/status'] = { version: '0.9.0', pid: 1, port: 47_999 };
    const mismatch = await doctor(world);
    expect(check(mismatch, 'gateway-version')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('mcpier stop'),
    });
  });

  it('a gateway that fell back to the log recorder fails the database check', async () => {
    const world = await healthyWorld();
    world.gateway['/api/status'] = {
      version: VERSION,
      pid: 1,
      port: 47_999,
      callLog: { store: 'log', problem: 'disk full' },
    };
    expect(check(await doctor(world), 'database')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('disk full'),
    });
  });

  it('server states: ready, starting, needs sign-in, stopped, error, crashed, disabled; OAuth sign-ins', async () => {
    const world = await healthyWorld();
    const server = (name: string, state: string, extra: object = {}) => ({
      name,
      transport: 'http',
      enabled: true,
      status: { state, since: 'x', detail: `${state} detail` },
      tools: { total: 1, enabled: 1 },
      ...extra,
    });
    world.gateway['/api/servers'] = {
      servers: [
        server('a', 'ready'),
        server('b', 'starting'),
        server('c', 'needs_auth'),
        server('d', 'stopped'),
        server('e', 'error'),
        server('f', 'crashed'),
        server('g', 'error', { enabled: false }),
      ],
    };
    world.gateway['/api/auth'] = {
      servers: [
        { server: 'c', signedIn: false, reason: 'sign_in_expired', grantedScopes: [] },
        { server: 'h', signedIn: true, grantedScopes: [] },
      ],
    };
    const report = await doctor(world);
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => check(report, `server-${name}`).status)).toEqual(
      ['pass', 'warn', 'warn', 'warn', 'fail', 'fail', 'pass'],
    );
    expect(check(report, 'server-e')).toMatchObject({
      message: expect.stringContaining('error detail'),
      fix: expect.stringContaining('mcpier server logs e'),
    });
    expect(check(report, 'server-d').fix).toBe('mcpier server start d');
    expect(check(report, 'oauth-sign-in')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('c (sign_in_expired)'),
      fix: 'mcpier auth login c',
    });
  });
});

describe('doctor: secrets and autostart', () => {
  it('Credential Manager failing, and skipped checks under the test guard', async () => {
    const world = await healthyWorld();
    world.secrets.listNames = async () => {
      throw new Error('The system cannot find the file specified.');
    };
    expect(check(await doctor(world), 'credential-manager')).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('Credential Manager'),
    });

    const skipped = await healthyWorld();
    delete skipped.deps.secrets;
    delete skipped.deps.autostart;
    skipped.deps.skipped = 'skipped under the test guard';
    const report = await doctor(skipped);
    expect(check(report, 'credential-manager')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('skipped under the test guard'),
    });
    expect(check(report, 'autostart')).toMatchObject({ status: 'warn' });
    expect(report.checks.some((entry) => entry.id === 'secret-references')).toBe(false);
  });

  it('autostart off, unreadable, and pointing at a moved folder', async () => {
    const world = await healthyWorld();
    world.autostart.tasks.clear();
    expect(check(await doctor(world), 'autostart')).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('off'),
    });
    await world.autostart.enable(
      TASK,
      autostartAction({ nodePath: process.execPath, cliEntry: 'C:\\moved\\mcpier.js' }),
    );
    expect(check(await doctor(world), 'autostart')).toMatchObject({
      status: 'fail',
      fix: 'Run: mcpier autostart enable',
    });
    world.autostart.failWith = new Error('Task Scheduler is not available');
    expect(check(await doctor(world), 'autostart')).toMatchObject({ status: 'warn' });
  });
});

describe('doctor: clients (read-only)', () => {
  it('no entry, unreadable JSON (never quoted), a bridge pointing at moved paths, a wrong port', async () => {
    const world = await healthyWorld();
    const claude = join(world.users.appData, 'Claude', 'claude_desktop_config.json');
    writeFileSync(
      claude,
      JSON.stringify({ mcpServers: { other: { command: 'npx', env: { TOKEN: CLIENT_TOKEN } } } }),
    );
    const cursor = join(world.users.profile, '.cursor', 'mcp.json');
    writeFileSync(cursor, `{"mcpServers": {"x": {"env": {"T": ${CLIENT_TOKEN}}}}`);
    const store = touch(
      join(
        world.users.localAppData,
        'Packages',
        'Claude_pzs8sxrjxfjjc',
        'LocalCache',
        'Roaming',
        'Claude',
        'claude_desktop_config.json',
      ),
      JSON.stringify({
        mcpServers: {
          mcpier: {
            command: 'C:\\old\\node.exe',
            args: ['C:\\old\\repo\\apps\\cli\\dist\\mcpier.js', 'stdio'],
          },
        },
      }),
    );
    writeFileSync(
      join(world.users.appData, 'Code', 'User', 'mcp.json'),
      JSON.stringify({ servers: { mcpier: { type: 'http', url: 'http://127.0.0.1:1234/mcp' } } }),
    );
    const before = new Map([claude, cursor, store].map((file) => [file, readFileOrEmpty(file)]));
    const report = await doctor(world);
    expect(check(report, 'client-claude-desktop')).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('mcpier connect claude-desktop'),
    });
    expect(check(report, 'client-cursor')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('not valid JSON'),
    });
    expect(check(report, 'client-claude-desktop-store')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('C:\\old\\repo\\apps\\cli\\dist\\mcpier.js'),
    });
    expect(check(report, 'client-vscode')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('port 1234'),
    });
    const text = JSON.stringify(report) + formatReport(report);
    expect(text).not.toContain(CLIENT_TOKEN);
    expect(text).not.toContain(CLIENT_TOKEN.slice(0, 8));
    // Read-only: the files are unchanged.
    for (const [file, content] of before) expect(readFileOrEmpty(file)).toBe(content);
  });

  it('under the test guard, the real user folders are never read', async () => {
    const world = await healthyWorld();
    const forbidden = join(world.users.localAppData, 'MCPier');
    world.deps.env = { ...world.deps.env, MCPIER_TEST_FORBIDDEN_HOME: forbidden };
    const report = await doctor(world);
    expect(check(report, 'clients')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('not checked'),
    });
    expect(report.checks.some((entry) => entry.id.startsWith('client-'))).toBe(false);
  });
});

describe('doctor: mcpier.db with a real gateway (read-only, running and stopped)', () => {
  it('passes while the gateway runs and after it stops, and leaves the files alone', async () => {
    const t = await startTestGateway({
      config: {
        servers: [
          { name: 'local', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
        ],
      } as never,
    });
    try {
      await waitForStatus(t.gateway, 'local', 'ready');
      await t.gateway.manager.callTool('local__echo', { text: 'x' });
      const deps: DoctorDeps = {
        env: {
          PATH: '',
          MCPIER_PORT: String(t.port),
          APPDATA: tempDir('a-'),
          LOCALAPPDATA: tempDir('l-'),
          USERPROFILE: tempDir('p-'),
        },
        paths: t.home.paths,
        cliVersion: VERSION,
        nodeVersion: process.versions.node,
        files: new FakeFileSecurity(),
        secrets: t.secrets,
        autostart: new FakeAutostart(),
        autostartTaskName: TASK,
        probe: (port) => probeHealth(port),
        adminGet: async <T>(port: number, token: string, path: string) => {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          return (await response.json()) as T;
        },
      };
      const running = await runDoctor(deps);
      expect(check(running, 'database').status).toBe('pass');
      expect(check(running, 'gateway').status).toBe('pass');
      expect(check(running, 'server-local').status).toBe('pass');
      await t.gateway.stop('doctor test');
      const stopped = await runDoctor(deps);
      expect(check(stopped, 'database'), check(stopped, 'database').message).toMatchObject({
        status: 'pass',
      });
      expect(check(stopped, 'gateway').status).toBe('warn');
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});

describe('doctor: every non-passing check says how to fix it; nothing secret is printed', () => {
  it('across every report above', () => {
    expect(reports.length).toBeGreaterThan(8);
    for (const report of reports) {
      for (const entry of report.checks) {
        if (entry.status !== 'pass') expect(entry.fix?.trim(), `${entry.id}: ${entry.message}`).toBeTruthy();
        expect(entry.message.trim().length).toBeGreaterThan(0);
      }
      const text = JSON.stringify(report) + formatReport(report);
      for (const value of [SECRET_VALUE, CLIENT_TOKEN, OAUTH_KEY]) expect(text).not.toContain(value);
    }
  });
});

describe('mcpier doctor (the CLI)', () => {
  let home: TempHome;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    home = createTempHome();
    homes.push(home);
    env = {
      ...home.env(await getFreePort()),
      APPDATA: tempDir('cli-appdata-'),
      LOCALAPPDATA: tempDir('cli-local-'),
      USERPROFILE: tempDir('cli-profile-'),
    };
  });

  it('exits 0 with warnings only, prints areas with fixes, and --json gives the same results', async () => {
    const text = await runCli(['doctor'], env);
    expect(text.code, text.stdout + text.stderr).toBe(0);
    expect(text.stdout).toContain('MCPier doctor');
    for (const title of ['Environment', 'Data directory', 'Gateway', 'Secrets and OAuth', 'Clients']) {
      expect(text.stdout).toContain(`\n${title}\n`);
    }
    expect(text.stdout).toContain('skipped under the test guard');
    expect(text.stdout).toMatch(/fix: Start it with: mcpier start/);
    const json = await runCli(['doctor', '--json'], env);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((entry) => entry.id === 'client-claude-desktop')?.status).toBe('pass');
  });

  it('exits 1 on a failure, and never prints the admin token or a value from config.json', async () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.paths.adminToken, 'admin-token-value-that-must-not-print-0000');
    writeFileSync(home.paths.config, `{"servers": [{"name": "x", "env": {"T": ${CLIENT_TOKEN}}}]}`);
    for (const args of [['doctor'], ['doctor', '--json']]) {
      const result = await runCli(args, env);
      expect(result.code).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).not.toContain(CLIENT_TOKEN.slice(0, 8));
      expect(output).not.toContain('admin-token-value');
    }
  });
});
