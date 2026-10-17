import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';
import type {
  ChildGuard,
  DetachedProcess,
  FileAccess,
  FileSecurity,
  Platform,
  ProcessControl,
  StartAttachedOptions,
  StartDetachedOptions,
} from '../types.js';
import { WindowsSecretStore } from './secret-store.js';
import { windowsAutostart } from './task-scheduler.js';

const execFileAsync = promisify(execFile);

/** Absolute path to a Windows system tool, so PATH and the calling shell never matter. */
function systemTool(name: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(systemRoot, 'System32', name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * For a command given as a path, whether the file exists (trying PATHEXT extensions when it
 * has none). Bare names such as `npx` are looked up on PATH by the launcher instead.
 */
function pathCommandExists(command: string, cwd: string | undefined): boolean {
  if (!/[\\/]/.test(command)) return true;
  const full = resolve(cwd ?? process.cwd(), command);
  if (existsSync(full)) return true;
  if (extname(full)) return false;
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return extensions.some((ext) => existsSync(full + ext));
}

export const windowsProcesses: ProcessControl = {
  startDetached(options: StartDetachedOptions): Promise<DetachedProcess> {
    // cross-spawn turns a command it cannot find into `cmd.exe /c <command>`, which starts
    // successfully and fails later; catch the common case of a wrong path up front.
    if (!pathCommandExists(options.command, options.cwd)) {
      return Promise.reject(new Error(`Command not found: ${options.command}`));
    }
    return new Promise((resolvePromise, reject) => {
      // cross-spawn wraps `.cmd` / `.bat` launchers in `cmd.exe /d /s /c` with correct
      // quoting; Node refuses to spawn those files directly. `detached` gives the child no
      // console of its own (DETACHED_PROCESS) and its own process group, and keeps it out of
      // the parent's kill-on-close job, so it survives the caller and its terminal.
      // `windowsHide` stops any console window from flashing.
      const child = crossSpawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.removeListener('error', reject);
        // Errors after spawn are not interesting to the caller; keep them from crashing it.
        child.on('error', () => {});
        const pid = child.pid;
        child.unref();
        if (pid === undefined) reject(new Error(`Could not start ${options.command}`));
        else resolvePromise({ pid });
      });
    });
  },

  startAttached(options: StartAttachedOptions): ChildProcessWithoutNullStreams {
    if (!pathCommandExists(options.command, options.cwd)) {
      throw new Error(`Command not found: ${options.command}`);
    }
    // Not detached: Node puts the child in its kill-on-close job object, so the child (and
    // anything it starts) ends when the gateway ends, even when the gateway is killed.
    // `windowsHide` matters doubly here: the gateway has no console, so a console child
    // started without it would get a visible window of its own.
    return crossSpawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  },

  async startChildGuard(): Promise<ChildGuard> {
    return startSentinel();
  },

  isAlive(pid: number): boolean {
    try {
      // Signal 0 checks for existence without touching the process.
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means it exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },

  async stopTree(pid: number): Promise<void> {
    if (!windowsProcesses.isAlive(pid)) return;
    // taskkill /T stops the whole tree, /F forces it. Called directly with an argument
    // array: no shell (Git Bash would rewrite "/T" into a path) and no console window.
    try {
      await execFileAsync(systemTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
      });
    } catch {
      // taskkill exits non-zero when the process vanished meanwhile or a child could not be
      // stopped; the liveness check below decides whether this was a real failure.
    }
    for (let waited = 0; waited < 5000; waited += 50) {
      if (!windowsProcesses.isAlive(pid)) return;
      await sleep(50);
    }
    throw new Error(`Process ${pid} is still running after a forced stop`);
  },
};

/**
 * The sentinel script. Next to this file when running the build; when running the TypeScript
 * sources (tests), the built copy in `dist` is used.
 */
function sentinelScript(): string {
  const beside = fileURLToPath(new URL('./sentinel.js', import.meta.url));
  if (existsSync(beside)) return beside;
  const built = beside.replace(/([\\/])src([\\/]platform[\\/]windows[\\/])/, '$1dist$2');
  if (existsSync(built)) return built;
  throw new Error(`The child guard script is missing (${beside}). Run "pnpm build".`);
}

/**
 * Starts the sentinel: detached (outside this process's kill-on-close job, so it survives
 * the gateway) and hidden, with only its stdin connected. When this process ends for any
 * reason, Windows closes the pipe and the sentinel sees end-of-file at once.
 */
async function startSentinel(): Promise<ChildGuard> {
  const child = crossSpawn(process.execPath, [sentinelScript()], {
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolvePromise());
  });
  child.unref();
  const stdin = child.stdin!;
  stdin.on('error', () => {});
  // Do not let the pipe keep the gateway's event loop alive.
  (stdin as unknown as { unref?: () => void }).unref?.();
  const send = (line: string) => {
    if (!stdin.destroyed) stdin.write(`${line}\n`);
  };
  return {
    pid: child.pid,
    track: (pid, startedAtMs) => send(`track ${pid} ${startedAtMs}`),
    untrack: (pid) => send(`untrack ${pid}`),
    release: () =>
      new Promise<void>((resolvePromise) => {
        if (stdin.destroyed) return resolvePromise();
        stdin.end('clean\n', () => resolvePromise());
      }),
  };
}

let cachedUserSid: string | undefined;

async function currentUserSid(): Promise<string> {
  if (cachedUserSid) return cachedUserSid;
  const { stdout } = await execFileAsync(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  });
  const match = /"(S-1-[0-9-]+)"/.exec(stdout);
  if (!match?.[1]) throw new Error('Could not determine the current Windows user SID');
  cachedUserSid = match[1];
  return cachedUserSid;
}

/** Well-known SID of the operating system account (NT AUTHORITY\SYSTEM). */
const SYSTEM_SID = 'S-1-5-18';

export const windowsFileSecurity: FileSecurity = {
  async restrictToCurrentUser(path: string, kind: 'file' | 'directory'): Promise<void> {
    const sid = await currentUserSid();
    const inherit = kind === 'directory' ? '(OI)(CI)' : '';
    // /inheritance:r drops entries inherited from the parent folder; /grant:r replaces any
    // explicit grant for these two SIDs with Full control. Nobody else keeps access.
    try {
      await execFileAsync(
        systemTool('icacls.exe'),
        [path, '/inheritance:r', '/grant:r', `*${sid}:${inherit}F`, `*${SYSTEM_SID}:${inherit}F`],
        { windowsHide: true },
      );
    } catch (error) {
      const detail =
        (error as { stdout?: string; stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`Could not restrict access to ${path}: ${detail}`, { cause: error });
    }
  },

  async describeAccess(path: string): Promise<FileAccess> {
    // `icacls /save` writes the security descriptor as SDDL (SIDs, not localized names) to a
    // UTF-16 file: line 1 is the name, line 2 the descriptor. Nothing is changed.
    const dir = mkdtempSync(join(tmpdir(), 'mcpier-acl-'));
    const file = join(dir, 'acl.txt');
    try {
      await execFileAsync(systemTool('icacls.exe'), [path, '/save', file], { windowsHide: true });
      const text = readFileSync(file)
        .toString('utf16le')
        .replace(/^\uFEFF/, '');
      const sddl = text.split(/\r?\n/).find((line) => line.startsWith('D:')) ?? '';
      return accessFromSddl(sddl, await currentUserSid());
    } catch (error) {
      const detail =
        (error as { stdout?: string; stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`Could not read the permissions of ${path}: ${detail}`, { cause: error });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/**
 * Reads the DACL part of an SDDL string: who is allowed in besides the current user and the
 * operating system (`SY`), and whether inherited entries are blocked (`P`).
 */
export function accessFromSddl(sddl: string, userSid: string): FileAccess {
  const dacl = /^D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) throw new Error('No access list found');
  const flags = dacl[1] ?? '';
  const others = new Set<string>();
  for (const [, ace] of (dacl[2] ?? '').matchAll(/\(([^)]*)\)/g)) {
    const fields = (ace ?? '').split(';');
    const type = fields[0];
    const trustee = fields[5] ?? '';
    // Only grants matter here; a deny entry takes access away.
    if (type !== 'A') continue;
    if (trustee === 'SY' || trustee === SYSTEM_SID || trustee === userSid) continue;
    others.add(trustee);
  }
  return {
    restricted: others.size === 0,
    others: [...others].sort(),
    protectedFromInheritance: flags.includes('P'),
  };
}

export function windowsDefaultDataDir(env: NodeJS.ProcessEnv): string {
  const override = env.MCPIER_HOME?.trim();
  if (override) return isAbsolute(override) ? resolve(override) : resolve(process.cwd(), override);
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) return join(localAppData, 'MCPier');
  throw new Error(
    'Cannot find the MCPier data directory: neither MCPIER_HOME nor LOCALAPPDATA is set. ' +
      'Set MCPIER_HOME to the folder MCPier should use.',
  );
}

/** Hands an http(s) URL to the default browser through the URL protocol handler. */
async function windowsOpenUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`);
  // rundll32 with an argument list: no shell, so the URL's & and ? characters stay as they are.
  await execFileAsync(systemTool('rundll32.exe'), ['url.dll,FileProtocolHandler', url], {
    windowsHide: true,
  });
}

export const windowsPlatform: Platform = {
  processes: windowsProcesses,
  files: windowsFileSecurity,
  secrets: new WindowsSecretStore(),
  autostart: windowsAutostart,
  defaultDataDir: windowsDefaultDataDir,
  openUrl: windowsOpenUrl,
};
