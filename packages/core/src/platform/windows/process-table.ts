import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Creation time, ms since the epoch (0 when Windows does not report it). */
  createdMs: number;
}

function systemRoot(): string {
  return process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
}

/** FILETIME (100 ns ticks since 1601) to ms since 1970. */
function fileTimeToMs(fileTime: bigint): number {
  return Number(fileTime / 10_000n) - 11_644_473_600_000;
}

/**
 * One snapshot of every process with its parent and creation time, from Windows' own
 * process table (CIM, through PowerShell called directly with an argument list).
 */
export async function snapshotProcesses(): Promise<ProcessInfo[]> {
  const powershell = join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId," +
    '$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }';
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d+)$/.exec(line.trim());
    if (!match) continue;
    const fileTime = BigInt(match[3]!);
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      createdMs: fileTime === 0n ? 0 : fileTimeToMs(fileTime),
    });
  }
  return processes;
}

/** A process tree root recorded when it was started. */
export interface TrackedRoot {
  pid: number;
  /** When MCPier started it (ms since the epoch, taken just before spawning). */
  startedAtMs: number;
}

/** Allowed difference between our recorded start time and Windows' creation time. */
const CLOCK_TOLERANCE_MS = 3000;

/**
 * Every process that provably belongs to a recorded tree: the root itself if it is still the
 * same process, and descendants found through parent links where each child was created no
 * earlier than its parent (so a reused pid never pulls in an unrelated process). Works when
 * the root has already exited, which `taskkill /T` cannot do. Never matches by name.
 */
export function descendantsOf(roots: readonly TrackedRoot[], table: readonly ProcessInfo[]): number[] {
  const byPid = new Map(table.map((info) => [info.pid, info]));
  const children = new Map<number, ProcessInfo[]>();
  for (const info of table) {
    const list = children.get(info.ppid) ?? [];
    list.push(info);
    children.set(info.ppid, list);
  }

  const found = new Set<number>();
  for (const root of roots) {
    const earliest = root.startedAtMs - CLOCK_TOLERANCE_MS;
    const current = byPid.get(root.pid);
    // The pid may now belong to a newer, unrelated process: then only children created
    // before that process can be ours.
    const rootIsOurs =
      current !== undefined &&
      current.createdMs >= earliest &&
      current.createdMs <= root.startedAtMs + CLOCK_TOLERANCE_MS;
    const reusedAfter = current !== undefined && !rootIsOurs ? current.createdMs : Number.POSITIVE_INFINITY;
    if (rootIsOurs) found.add(root.pid);

    const queue: { pid: number; createdMs: number; first: boolean }[] = [
      { pid: root.pid, createdMs: rootIsOurs ? current!.createdMs : earliest, first: true },
    ];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const child of children.get(parent.pid) ?? []) {
        if (found.has(child.pid) || child.pid === parent.pid) continue;
        if (child.createdMs < parent.createdMs) continue;
        if (parent.first && !rootIsOurs && child.createdMs >= reusedAfter) continue;
        found.add(child.pid);
        queue.push({ pid: child.pid, createdMs: child.createdMs, first: false });
      }
    }
  }
  return [...found];
}

/** Forced stop of one process tree, called directly (no shell, no window). */
export async function forceStopTree(pid: number): Promise<void> {
  await execFileAsync(join(systemRoot(), 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
  }).catch(() => {});
}
