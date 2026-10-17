import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { checkInternalAccount, checkSecretName, checkSecretValue } from '../secret-checks.js';
import type {
  AutostartAction,
  AutostartControl,
  ChildGuard,
  DetachedProcess,
  FileAccess,
  FileSecurity,
  InternalSecretStore,
  Platform,
  ProcessControl,
  SecretStore,
  StartDetachedOptions,
} from '../types.js';

/** In-memory process control for tests: nothing is actually started or stopped. */
export class FakeProcesses implements ProcessControl {
  readonly started: StartDetachedOptions[] = [];
  readonly stopped: number[] = [];
  private readonly alive = new Set<number>();
  private nextPid = 10_000;

  async startDetached(options: StartDetachedOptions): Promise<DetachedProcess> {
    this.started.push(options);
    const pid = this.nextPid++;
    this.alive.add(pid);
    return { pid };
  }

  startAttached(): ChildProcessWithoutNullStreams {
    throw new Error(
      'FakeProcesses cannot start attached processes; use the real platform with a fake secret store.',
    );
  }

  async startChildGuard(): Promise<ChildGuard> {
    return { pid: undefined, track: () => {}, untrack: () => {}, release: async () => {} };
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async stopTree(pid: number): Promise<void> {
    this.stopped.push(pid);
    this.alive.delete(pid);
  }

  /** Test helper: mark a pid as running without starting anything. */
  markAlive(pid: number): void {
    this.alive.add(pid);
  }

  /** Test helper: simulate a process exiting on its own. */
  markExited(pid: number): void {
    this.alive.delete(pid);
  }
}

/** Records restriction requests instead of changing permissions. */
export class FakeFileSecurity implements FileSecurity {
  readonly restricted: { path: string; kind: 'file' | 'directory' }[] = [];
  failWith: Error | undefined;

  /** What `describeAccess` answers per path (default: restricted); an Error makes it reject. */
  readonly access = new Map<string, FileAccess | Error>();

  async restrictToCurrentUser(path: string, kind: 'file' | 'directory'): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.restricted.push({ path, kind });
  }

  async describeAccess(path: string): Promise<FileAccess> {
    const answer = this.access.get(resolve(path));
    if (answer instanceof Error) throw answer;
    return answer ?? { restricted: true, others: [], protectedFromInheritance: true };
  }
}

/** In-memory logon tasks for tests: nothing reaches Task Scheduler. */
export class FakeAutostart implements AutostartControl {
  readonly tasks = new Map<string, AutostartAction>();
  /** Set to make every operation fail (tests of a Task Scheduler failure). */
  failWith: Error | undefined;

  async enable(name: string, action: AutostartAction): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.tasks.set(name, { ...action });
  }

  async disable(name: string): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.tasks.delete(name);
  }

  async query(name: string): Promise<AutostartAction | undefined> {
    if (this.failWith) throw this.failWith;
    const task = this.tasks.get(name);
    return task ? { ...task } : undefined;
  }
}

/** In-memory internal store (MCPier's own keys), kept apart from the fake user secrets. */
export class FakeInternalSecretStore implements InternalSecretStore {
  private readonly values = new Map<string, string>();
  /** Set to make `set` fail (tests of a Credential Manager failure). */
  failWith: Error | undefined;

  async get(account: string): Promise<string | undefined> {
    checkInternalAccount(account);
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    checkInternalAccount(account);
    checkSecretValue(value);
    if (this.failWith) throw this.failWith;
    this.values.set(account, value);
  }

  async delete(account: string): Promise<boolean> {
    checkInternalAccount(account);
    return this.values.delete(account);
  }

  /** Accounts held (tests). */
  accounts(): string[] {
    return [...this.values.keys()].sort();
  }
}

/** In-memory secret store with the same validation as the Credential Manager store. */
export class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  private readonly internalStore = new FakeInternalSecretStore();

  internal(): FakeInternalSecretStore {
    return this.internalStore;
  }

  async get(name: string): Promise<string | undefined> {
    checkSecretName(name);
    return this.values.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    checkSecretName(name);
    checkSecretValue(value);
    this.values.set(name, value);
  }

  async delete(name: string): Promise<boolean> {
    checkSecretName(name);
    return this.values.delete(name);
  }

  async listNames(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }
}

export class FakePlatform implements Platform {
  readonly processes = new FakeProcesses();
  readonly files = new FakeFileSecurity();
  readonly secrets = new FakeSecretStore();
  readonly autostart = new FakeAutostart();

  /** URLs passed to `openUrl` (tests). */
  readonly opened: string[] = [];

  async openUrl(url: string): Promise<void> {
    this.opened.push(url);
  }

  /** @param fallbackDataDir what `defaultDataDir` returns when `MCPIER_HOME` is not set. */
  constructor(private readonly fallbackDataDir?: string) {}

  defaultDataDir(env: NodeJS.ProcessEnv): string {
    const dir = env.MCPIER_HOME?.trim() || this.fallbackDataDir;
    if (!dir) throw new Error('Cannot find the MCPier data directory: MCPIER_HOME is not set.');
    return resolve(dir);
  }
}
