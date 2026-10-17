// `mcpier doctor` (SPEC 9, D-074): every check reports pass, warn or fail with one line and,
// for anything not passing, the exact fix. Everything it touches comes in through `DoctorDeps`,
// so tests run it against temporary homes, fake secret stores and fake task layers.
// It never writes anything, never opens mcpier.db for writing, and never prints a secret
// value, a token or anything from a client's config file except paths and entry names.
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  AdminAuthError,
  buildChildEnv,
  ConfigError,
  effectivePort,
  FORBIDDEN_HOME_ENV,
  loadConfig,
  OAUTH_KEY_ACCOUNT,
  openDatabaseReadOnly,
  readAdminToken,
  readAutostartStatus,
  readPidFile,
  type AutostartControl,
  type DataPaths,
  type FileSecurity,
  type HealthProbe,
  type SecretStore,
} from '@mcpier/core';
import {
  AUTH_API_PATHS,
  defaultConfig,
  referencedSecretNames,
  type AuthListResponse,
  type DoctorCheck,
  type DoctorReport,
  type McpierConfig,
  type ServerListResponse,
  type StatusResponse,
} from '@mcpier/shared';
import { checkClient, clientTargets } from './clients.js';
import { findCommand } from './find-command.js';

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  paths: DataPaths;
  cliVersion: string;
  nodeVersion: string;
  files: FileSecurity;
  /** Undefined when Credential Manager must not be touched (`skipped` says why). */
  secrets?: SecretStore;
  autostart?: AutostartControl;
  autostartTaskName: string;
  /** Why the secrets, autostart or client checks were skipped (the test guard). */
  skipped?: string;
  probe: (port: number) => Promise<HealthProbe>;
  /** A GET on the running gateway's admin API; throws `AdminAuthError` on a token mismatch. */
  adminGet: <T>(port: number, token: string, path: string) => Promise<T>;
}

const REQUIRED_NODE_MAJOR = 24;

const shorten = (text: string | undefined, max = 160) => {
  const line = (text ?? '').split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The real user folders, from the forbidden (real) data directory the test setup names. */
function realUserFolders(env: NodeJS.ProcessEnv): string[] {
  const forbidden = env[FORBIDDEN_HOME_ENV]?.trim();
  if (!forbidden) return [];
  const localAppData = dirname(forbidden);
  const appDataRoot = dirname(localAppData);
  return [localAppData, join(appDataRoot, 'Roaming'), dirname(appDataRoot)].map((dir) => dir.toLowerCase());
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const { env, paths } = deps;
  const user =
    env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : (env.USERNAME ?? '%USERNAME%');

  // ---- Config first: most other checks need it.
  let config: McpierConfig | undefined;
  let configError: string[] | undefined;
  if (existsSync(paths.config)) {
    try {
      config = await loadConfig(paths.config);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      configError = [...error.problems];
    }
  }
  const settings = (config ?? defaultConfig()).settings;
  let port: number;
  try {
    port = config
      ? effectivePort(config, env)
      : (readPidFile(paths.pidFile)?.port ?? effectivePort(defaultConfig(), env));
  } catch {
    port = settings.port;
  }
  const childEnv = buildChildEnv(env, settings.extraPath, {});

  // ---- Environment

  const major = Number(deps.nodeVersion.split('.')[0]);
  add(
    major === REQUIRED_NODE_MAJOR
      ? { area: 'environment', id: 'node-version', status: 'pass', message: `Node.js ${deps.nodeVersion}.` }
      : {
          area: 'environment',
          id: 'node-version',
          status: 'fail',
          message: `Node.js ${deps.nodeVersion}; MCPier needs Node.js ${REQUIRED_NODE_MAJOR}.`,
          fix: `Install Node.js ${REQUIRED_NODE_MAJOR} (nodejs.org), then run "pnpm build" in the MCPier folder, "mcpier autostart enable" if autostart is on, and update bridge entries ("mcpier connect <client>").`,
        },
  );

  const usedCommands = new Set(
    (config?.servers ?? [])
      .filter((server) => server.transport === 'stdio')
      .map((server) =>
        basename((server as { command: string }).command)
          .replace(/\.(exe|cmd|bat)$/i, '')
          .toLowerCase(),
      ),
  );
  for (const [command, required] of [
    ['node', true],
    ['npx', true],
    ['uvx', false],
    ['docker', false],
  ] as const) {
    const found = findCommand(command, childEnv);
    const usedByServer = usedCommands.has(command);
    const id = `command-${command}`;
    if (found) {
      add({ area: 'environment', id, status: 'pass', message: `${command} resolves to ${found}.` });
    } else if (command === 'docker' && !usedByServer) {
      add({
        area: 'environment',
        id,
        status: 'pass',
        message: 'docker is not installed (optional: only servers that run in Docker need it).',
      });
    } else {
      add({
        area: 'environment',
        id,
        status: required || usedByServer ? 'fail' : 'warn',
        message: `${command} is not found on the PATH servers get${usedByServer ? ' (a configured server uses it)' : ''}.`,
        fix:
          command === 'uvx'
            ? 'Install uv (it provides uvx: https://docs.astral.sh/uv/), or add its folder to "extraPath" on the Settings page; then restart the servers that use it.'
            : command === 'docker'
              ? 'Install Docker Desktop, or add the folder with docker.exe to "extraPath" on the Settings page.'
              : `Install Node.js ${REQUIRED_NODE_MAJOR} (it provides node and npx), or add its folder to "extraPath" on the Settings page.`,
      });
    }
  }

  if (settings.extraPath.length === 0) {
    add({
      area: 'environment',
      id: 'extra-path',
      status: 'pass',
      message: 'No extra PATH folders are set ("extraPath").',
    });
  } else {
    const missing = settings.extraPath.filter((dir) => !existsSync(dir));
    add(
      missing.length === 0
        ? {
            area: 'environment',
            id: 'extra-path',
            status: 'pass',
            message: `Every "extraPath" folder exists (${settings.extraPath.length}).`,
          }
        : {
            area: 'environment',
            id: 'extra-path',
            status: 'fail',
            message: `"extraPath" folders that do not exist: ${missing.join(', ')}.`,
            fix: `Remove or correct them in "settings.extraPath" (Settings page, or ${paths.config}).`,
          },
    );
  }

  // ---- Data directory

  if (!existsSync(paths.dir)) {
    add({
      area: 'data',
      id: 'data-dir',
      status: 'warn',
      message: `The data directory ${paths.dir} does not exist yet.`,
      fix: 'Run "mcpier start": it creates the data directory with restricted permissions.',
    });
  } else {
    add({ area: 'data', id: 'data-dir', status: 'pass', message: `Data directory: ${paths.dir}.` });

    const targets: { path: string; kind: 'directory' | 'file'; label: string }[] = [
      { path: paths.dir, kind: 'directory', label: 'the data directory' },
      { path: paths.adminToken, kind: 'file', label: 'admin-token' },
      { path: paths.stateKey, kind: 'file', label: 'state-key' },
      { path: paths.oauthDir, kind: 'directory', label: 'the oauth folder' },
    ];
    const open: string[] = [];
    const fixes: string[] = [];
    const unreadable: string[] = [];
    for (const target of targets) {
      if (!existsSync(target.path)) continue;
      try {
        const access = await deps.files.describeAccess(target.path);
        const isRoot = target.path === paths.dir;
        if (!access.restricted || (isRoot && !access.protectedFromInheritance)) {
          open.push(
            `${target.label}${access.others.length ? ` (also open to ${access.others.join(', ')})` : ' (inherits access from its parent)'}`,
          );
          fixes.push(
            isRoot
              ? `icacls "${target.path}" /inheritance:r /grant:r "${user}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"`
              : `icacls "${target.path}" /reset${target.kind === 'directory' ? ' /T' : ''}`,
          );
        }
      } catch {
        unreadable.push(target.label);
      }
    }
    if (open.length > 0) {
      add({
        area: 'data',
        id: 'permissions',
        status: 'fail',
        message: `Not restricted to you: ${open.join('; ')}.`,
        fix: `Run: ${fixes.join(' && ')}`,
      });
    } else if (unreadable.length > 0) {
      add({
        area: 'data',
        id: 'permissions',
        status: 'warn',
        message: `Could not read the permissions of ${unreadable.join(', ')}.`,
        fix: `Check them with: icacls "${paths.dir}"`,
      });
    } else {
      add({
        area: 'data',
        id: 'permissions',
        status: 'pass',
        message:
          'Only you and the system can open the data directory, admin-token, state-key and the oauth folder.',
      });
    }
  }

  if (!existsSync(paths.config)) {
    add({
      area: 'data',
      id: 'config',
      status: 'warn',
      message: `${paths.config} does not exist yet.`,
      fix: 'Run "mcpier start": it creates a default config.json.',
    });
  } else if (configError) {
    add({
      area: 'data',
      id: 'config',
      status: 'fail',
      message: `${paths.config} is invalid: ${configError.join('; ')}.`,
      fix: `Fix those lines in ${paths.config}. A running gateway keeps the last good config until then.`,
    });
  } else {
    add({
      area: 'data',
      id: 'config',
      status: 'pass',
      message: `config.json is valid (${config!.servers.length} ${config!.servers.length === 1 ? 'server' : 'servers'}).`,
    });
  }

  // ---- Gateway (its status also feeds the database, OAuth and server checks)

  const probe = await deps.probe(port);
  let status: StatusResponse | undefined;
  let token: string | undefined;
  if (probe.kind === 'other') {
    add({
      area: 'gateway',
      id: 'gateway',
      status: 'fail',
      message: `Port ${port} is in use by another program, so MCPier cannot listen there.`,
      fix: `Close that program, or choose another port: "settings.port" on the Settings page (or in ${paths.config}), or the MCPIER_PORT variable.`,
    });
  } else if (probe.kind === 'none') {
    add({
      area: 'gateway',
      id: 'gateway',
      status: 'warn',
      message: `MCPier is not running (port ${port}).`,
      fix: 'Start it with: mcpier start',
    });
  } else {
    try {
      token = readAdminToken(paths.adminToken);
      status = await deps.adminGet<StatusResponse>(port, token, '/api/status');
      add({
        area: 'gateway',
        id: 'gateway',
        status: 'pass',
        message: `MCPier is running on port ${port} (pid ${status.pid}).`,
      });
      add(
        status.version === deps.cliVersion
          ? {
              area: 'gateway',
              id: 'gateway-version',
              status: 'pass',
              message: `The gateway and this CLI are both version ${status.version}.`,
            }
          : {
              area: 'gateway',
              id: 'gateway-version',
              status: 'fail',
              message: `The gateway runs version ${status.version}, this CLI is ${deps.cliVersion}.`,
              fix: 'Restart the gateway so it runs the built code: mcpier stop, then mcpier start',
            },
      );
    } catch (error) {
      token = undefined;
      add({
        area: 'gateway',
        id: 'gateway',
        status: 'fail',
        message:
          error instanceof AdminAuthError || !existsSync(paths.adminToken)
            ? `The MCPier gateway on port ${port} uses a different data directory.`
            : `The gateway on port ${port} did not answer: ${shorten((error as Error).message)}.`,
        fix: `Stop the other gateway, or set MCPIER_HOME to its data directory (this one is ${paths.dir}).`,
      });
    }
  }

  if (!deps.autostart) {
    add({
      area: 'gateway',
      id: 'autostart',
      status: 'warn',
      message: `Autostart was not checked: ${deps.skipped ?? 'not available'}.`,
      fix: 'Check it with: mcpier autostart status',
    });
  } else {
    const autostart = await readAutostartStatus(deps.autostart, deps.autostartTaskName);
    if (autostart.unknown) {
      add({
        area: 'gateway',
        id: 'autostart',
        status: 'warn',
        message: shorten(autostart.detail, 200),
        fix: 'Check it with: mcpier autostart status',
      });
    } else if (!autostart.enabled) {
      add({
        area: 'gateway',
        id: 'autostart',
        status: 'pass',
        message: 'Autostart is off (turn it on with: mcpier autostart enable).',
      });
    } else {
      const missing = (autostart.paths ?? []).filter((path) => !path.exists);
      add(
        missing.length === 0
          ? {
              area: 'gateway',
              id: 'autostart',
              status: 'pass',
              message: 'Autostart is on; the task points at an existing node.exe and MCPier.',
            }
          : {
              area: 'gateway',
              id: 'autostart',
              status: 'fail',
              message: `Autostart is on, but the task points at paths that no longer exist: ${missing.map((path) => path.path).join(', ')}.`,
              fix: 'Run: mcpier autostart enable',
            },
      );
    }
  }

  // ---- mcpier.db (read-only: a damaged file is never moved here)

  if (status?.callLog?.store === 'log') {
    add({
      area: 'data',
      id: 'database',
      status: 'fail',
      message: `The running gateway could not use mcpier.db (${shorten(status.callLog.problem)}); calls go to the gateway log only.`,
      fix: 'Run mcpier stop, then mcpier start. If it persists, move mcpier.db out of the data directory; MCPier creates a new one.',
    });
  } else if (!existsSync(paths.db)) {
    add({
      area: 'data',
      id: 'database',
      status: 'pass',
      message: 'mcpier.db does not exist yet (MCPier creates it at start).',
    });
  } else {
    try {
      const db = openDatabaseReadOnly(paths.db);
      try {
        const result = db.pragma('quick_check', { simple: true });
        if (result !== 'ok') throw new Error(`quick_check reported: ${String(result)}`);
      } finally {
        db.close();
      }
      add({
        area: 'data',
        id: 'database',
        status: 'pass',
        message: 'mcpier.db opens and passes its integrity check.',
      });
    } catch (error) {
      add({
        area: 'data',
        id: 'database',
        status: 'fail',
        message: `mcpier.db cannot be read or is damaged (${shorten((error as Error).message)}).`,
        fix: 'Run mcpier stop, then mcpier start: MCPier moves a damaged mcpier.db aside and creates a new one.',
      });
    }
  }
  const corrupt = existsSync(paths.dir)
    ? readdirSync(paths.dir).filter((name) => /^mcpier\.db\.corrupt-/.test(name))
    : [];
  add(
    corrupt.length === 0
      ? {
          area: 'data',
          id: 'corrupt-databases',
          status: 'pass',
          message: 'No damaged databases were moved aside.',
        }
      : {
          area: 'data',
          id: 'corrupt-databases',
          status: 'warn',
          message: `Damaged databases moved aside earlier: ${corrupt.join(', ')}.`,
          fix: `Delete them from ${paths.dir} once you no longer need them.`,
        },
  );

  // ---- Secrets and OAuth

  if (!deps.secrets) {
    add({
      area: 'secrets',
      id: 'credential-manager',
      status: 'warn',
      message: `Credential Manager was not checked: ${deps.skipped ?? 'not available'}.`,
      fix: 'Run mcpier doctor without the test guard.',
    });
  } else {
    let names: string[] | undefined;
    try {
      names = await deps.secrets.listNames();
      add({
        area: 'secrets',
        id: 'credential-manager',
        status: 'pass',
        message: `Credential Manager is reachable (${names.length} MCPier secrets).`,
      });
    } catch (error) {
      add({
        area: 'secrets',
        id: 'credential-manager',
        status: 'fail',
        message: `Credential Manager cannot be read: ${shorten((error as Error).message)}.`,
        fix: 'Open Control Panel > Credential Manager > Windows Credentials and check that it opens; sign out of Windows and back in if it does not.',
      });
    }
    if (names && config) {
      const missing = new Map<string, string[]>();
      for (const server of config.servers) {
        for (const name of referencedSecretNames(server)) {
          if (!names.includes(name)) missing.set(name, [...(missing.get(name) ?? []), server.name]);
        }
      }
      add(
        missing.size === 0
          ? {
              area: 'secrets',
              id: 'secret-references',
              status: 'pass',
              message: 'Every secret the config refers to exists.',
            }
          : {
              area: 'secrets',
              id: 'secret-references',
              status: 'fail',
              message: `Missing secrets: ${[...missing].map(([name, servers]) => `${name} (used by ${servers.join(', ')})`).join('; ')}.`,
              fix: [...missing.keys()].map((name) => `mcpier secret set ${name}`).join(' && '),
            },
      );
    }

    const records = existsSync(paths.oauthDir)
      ? readdirSync(paths.oauthDir).filter((name) => name.endsWith('.json'))
      : [];
    if (records.length > 0) {
      let present: boolean | undefined;
      try {
        present = (await deps.secrets.internal().get(OAUTH_KEY_ACCOUNT)) !== undefined;
      } catch {
        present = undefined;
      }
      add(
        present
          ? {
              area: 'secrets',
              id: 'oauth-store-key',
              status: 'pass',
              message: `The OAuth store key is in Credential Manager (${records.length} sign-in records).`,
            }
          : {
              area: 'secrets',
              id: 'oauth-store-key',
              status: present === undefined ? 'warn' : 'fail',
              message:
                present === undefined
                  ? 'Could not check the OAuth store key in Credential Manager.'
                  : `There are ${records.length} OAuth sign-in records but their key is missing from Credential Manager, so they cannot be read.`,
              fix: `Sign in again to each OAuth server (mcpier auth login <server>); the old records are moved aside as .unreadable.`,
            },
      );
    }
  }

  const unreadableRecords = existsSync(paths.oauthDir)
    ? readdirSync(paths.oauthDir).filter((name) => name.endsWith('.unreadable'))
    : [];
  add(
    unreadableRecords.length === 0
      ? { area: 'secrets', id: 'oauth-unreadable', status: 'pass', message: 'No unreadable OAuth records.' }
      : {
          area: 'secrets',
          id: 'oauth-unreadable',
          status: 'warn',
          message: `Unreadable OAuth records were moved aside: ${unreadableRecords.join(', ')}.`,
          fix: `Sign in again to those servers (${unreadableRecords.map((name) => `mcpier auth login ${name.replace(/\.json\.unreadable$/, '')}`).join(', ')}), then delete the files from ${paths.oauthDir}.`,
        },
  );

  if (status && token) {
    try {
      const auth = await deps.adminGet<AuthListResponse>(port, token, AUTH_API_PATHS.list);
      const waiting = auth.servers.filter((server) => !server.signedIn);
      add(
        waiting.length === 0
          ? {
              area: 'secrets',
              id: 'oauth-sign-in',
              status: 'pass',
              message:
                auth.servers.length === 0
                  ? 'No OAuth servers.'
                  : `Every OAuth server is signed in (${auth.servers.length}).`,
            }
          : {
              area: 'secrets',
              id: 'oauth-sign-in',
              status: 'warn',
              message: `Needs sign-in: ${waiting.map((server) => `${server.server} (${server.reason ?? 'not signed in'})`).join('; ')}.`,
              fix: waiting.map((server) => `mcpier auth login ${server.server}`).join(' && '),
            },
      );
    } catch (error) {
      add({
        area: 'secrets',
        id: 'oauth-sign-in',
        status: 'warn',
        message: `Could not read the OAuth sign-ins: ${shorten((error as Error).message)}.`,
        fix: 'Check them with: mcpier auth status',
      });
    }
  } else if (
    (config?.servers ?? []).some(
      (server) => server.transport === 'http' && (server as { auth?: string }).auth === 'oauth',
    )
  ) {
    add({
      area: 'secrets',
      id: 'oauth-sign-in',
      status: 'warn',
      message: 'OAuth sign-ins were not checked: the gateway is not running.',
      fix: 'Start it (mcpier start), then run mcpier doctor again.',
    });
  }

  // ---- Servers

  for (const server of config?.servers ?? []) {
    if (server.transport !== 'stdio' || server.enabled === false) continue;
    const command = (server as { command: string }).command;
    const serverEnv = buildChildEnv(env, settings.extraPath, {});
    const found = findCommand(command, serverEnv, (server as { cwd?: string }).cwd);
    add(
      found
        ? {
            area: 'servers',
            id: `command-${server.name}`,
            status: 'pass',
            message: `${server.name}: its command ${command} resolves to ${found}.`,
          }
        : {
            area: 'servers',
            id: `command-${server.name}`,
            status: 'fail',
            message: `${server.name}: its command ${command} is not found.`,
            fix: `Install ${command}, or add its folder to "extraPath" on the Settings page; then: mcpier server restart ${server.name}`,
          },
    );
  }
  if (status && token) {
    try {
      const list = await deps.adminGet<ServerListResponse>(port, token, '/api/servers');
      for (const server of list.servers) {
        const id = `server-${server.name}`;
        const state = server.status.state;
        if (!server.enabled) {
          add({ area: 'servers', id, status: 'pass', message: `${server.name}: disabled.` });
        } else if (state === 'ready') {
          add({
            area: 'servers',
            id,
            status: 'pass',
            message: `${server.name}: ready (${server.tools.enabled} tools).`,
          });
        } else if (state === 'starting' || state === 'needs_auth') {
          add({
            area: 'servers',
            id,
            status: 'warn',
            message: `${server.name}: ${state === 'starting' ? 'still starting' : 'needs sign-in'}${server.status.detail ? ` (${shorten(server.status.detail)})` : ''}.`,
            fix:
              state === 'starting'
                ? 'Wait a moment and run mcpier doctor again.'
                : `mcpier auth login ${server.name}`,
          });
        } else if (state === 'stopped') {
          add({
            area: 'servers',
            id,
            status: 'warn',
            message: `${server.name}: stopped.`,
            fix: `mcpier server start ${server.name}`,
          });
        } else {
          add({
            area: 'servers',
            id,
            status: 'fail',
            message: `${server.name}: ${state}${server.status.detail ? `: ${shorten(server.status.detail)}` : ''}.`,
            fix: `Read its log (mcpier server logs ${server.name}), fix the cause, then: mcpier server restart ${server.name}`,
          });
        }
      }
    } catch (error) {
      add({
        area: 'servers',
        id: 'servers',
        status: 'warn',
        message: `Could not read the servers: ${shorten((error as Error).message)}.`,
        fix: 'Check them with: mcpier server list',
      });
    }
  } else if ((config?.servers.length ?? 0) > 0) {
    add({
      area: 'servers',
      id: 'servers',
      status: 'warn',
      message: 'Server statuses were not checked: the gateway is not running.',
      fix: 'Start it (mcpier start), then run mcpier doctor again.',
    });
  }

  // ---- Clients (read-only)

  const real = realUserFolders(env);
  const folders = [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE].map((dir) =>
    dir
      ?.trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase(),
  );
  if (real.length > 0 && folders.some((dir) => dir && real.includes(dir))) {
    add({
      area: 'clients',
      id: 'clients',
      status: 'warn',
      message:
        'Client config files were not checked: under the test guard, APPDATA, LOCALAPPDATA and USERPROFILE must point at temporary folders.',
      fix: 'Set APPDATA, LOCALAPPDATA and USERPROFILE to temporary folders, or run without the test guard.',
    });
  } else {
    for (const target of clientTargets(env)) add(checkClient(target, port, env));
  }

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status]++;
  return { version: deps.cliVersion, checks, summary, ok: summary.fail === 0 };
}
