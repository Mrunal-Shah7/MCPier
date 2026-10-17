import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Platform interfaces. Everything outside `platform/` depends on these types only, never on
 * the Windows implementation directly. Tests use the in-memory fakes in `platform/fake`.
 */

export interface StartDetachedOptions {
  /** Executable or launcher. May be a `.cmd` / `.bat` file on Windows. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Full environment for the child. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
}

export interface DetachedProcess {
  pid: number;
}

export interface StartAttachedOptions {
  /** Executable or launcher, as written in config: `npx`, `uvx`, `cmd`, a path, … */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Full environment for the child (see `buildChildEnv`). */
  env: NodeJS.ProcessEnv;
}

/**
 * Makes sure server process trees never outlive the gateway, even when the gateway is killed
 * by force (which no exit handler sees). See DECISIONS for why Node's own job object is not
 * enough on Windows.
 */
export interface ChildGuard {
  /** Process id of the guard's helper process, if it has one. */
  readonly pid: number | undefined;
  /** A server process tree was started (`startedAtMs` taken just before spawning). */
  track(pid: number, startedAtMs: number): void;
  /** That tree ended normally. */
  untrack(pid: number): void;
  /** Clean shutdown: the guard ends without stopping anything. */
  release(): Promise<void>;
}

export interface ProcessControl {
  /**
   * Starts a hidden background process that is not tied to the caller's console and keeps
   * running after the caller exits. Resolves once the process has been created.
   */
  startDetached(options: StartDetachedOptions): Promise<DetachedProcess>;
  /**
   * Starts a hidden child process with piped stdin, stdout and stderr, tied to this process:
   * it must not outlive the gateway. Throws if a command given as a path does not exist;
   * other start failures arrive as the child's `error` or `exit` events.
   */
  startAttached(options: StartAttachedOptions): ChildProcessWithoutNullStreams;
  /** Starts the child guard (one per gateway). */
  startChildGuard(): Promise<ChildGuard>;
  /** Whether a process with this id currently exists. */
  isAlive(pid: number): boolean;
  /**
   * Stops a process and every descendant. Resolves when the process is gone (or was
   * already gone). Rejects if it is still alive after the stop attempt.
   */
  stopTree(pid: number): Promise<void>;
}

export interface FileSecurity {
  /**
   * Restricts a file or directory so only the current user (and the operating system
   * itself) can access it. For a directory, the restriction is inherited by new children.
   * Rejects if the restriction cannot be applied.
   */
  restrictToCurrentUser(path: string, kind: 'file' | 'directory'): Promise<void>;
  /**
   * Who may access a file or directory (read-only; `mcpier doctor`). Rejects if it cannot be
   * read.
   */
  describeAccess(path: string): Promise<FileAccess>;
}

export interface FileAccess {
  /** Only the current user and the operating system have access. */
  restricted: boolean;
  /** Everyone else who is allowed in (account names or SIDs, as the system reports them). */
  others: string[];
  /** Entries inherited from the parent folder are blocked (the data directory's own rule). */
  protectedFromInheritance: boolean;
}

/** What the autostart logon task runs. */
export interface AutostartAction {
  /** An absolute path. */
  command: string;
  /** One command line (Windows quoting). */
  arguments: string;
  workingDirectory?: string;
}

/**
 * The logon task that starts MCPier when the user signs in to Windows (`mcpier autostart`,
 * D-075). Test runs (the test guard is set) refuse the real task name for every operation,
 * reading included; tests use names starting with `MCPierTest-`.
 */
export interface AutostartControl {
  /** Creates the task, replacing one with the same name. */
  enable(name: string, action: AutostartAction): Promise<void>;
  /** Removes the task. Resolves false when there was none. */
  disable(name: string): Promise<boolean>;
  /** The task's action, or undefined when there is no such task. */
  query(name: string): Promise<AutostartAction | undefined>;
}

/**
 * Secret storage (Windows Credential Manager in production, `platform/windows/secret-store.ts`).
 * Names follow the slug rule; values never appear in logs or errors. Every implementation
 * validates input with `checkSecretName` / `checkSecretValue` so they reject the same things.
 */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** Returns true if a secret was deleted, false if none existed. */
  delete(name: string): Promise<boolean>;
  listNames(): Promise<string[]>;
  /**
   * MCPier's own keys (the OAuth store key), kept apart from the user's secrets: a separate
   * Credential Manager service that `listNames` never enumerates. A fake store returns a fake
   * internal store, so tests that pass a fake never reach the real one.
   */
  internal(): InternalSecretStore;
}

/**
 * Values MCPier stores for its own use. Accounts are fixed names chosen by MCPier (never
 * slugs, so even a listing that matched too broadly would drop them); values never appear in
 * logs or errors.
 */
export interface InternalSecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  /** Returns true if a value was deleted, false if none existed. */
  delete(account: string): Promise<boolean>;
}

export interface Platform {
  processes: ProcessControl;
  files: FileSecurity;
  secrets: SecretStore;
  autostart: AutostartControl;
  /**
   * The data directory: `MCPIER_HOME` if set, otherwise the per-user default
   * (`%LOCALAPPDATA%\MCPier` on Windows). Throws a clear error if neither resolves.
   * Callers should use `resolveDataDir` in `data-dir.ts`, which adds the test guard.
   */
  defaultDataDir(env: NodeJS.ProcessEnv): string;
  /**
   * Opens an http(s) URL in the default browser: no shell, an argument list, no console
   * window. Resolves once the request has been handed to the system.
   */
  openUrl(url: string): Promise<void>;
}
