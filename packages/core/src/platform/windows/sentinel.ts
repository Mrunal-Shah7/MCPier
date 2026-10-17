// The child guard's sentinel: a tiny detached process that outlives the gateway only to clean
// up after it. The gateway holds this process's stdin and writes one line per event:
//   track <pid> <startedAtMs>   a server process tree was started
//   untrack <pid>               it ended normally
//   clean                       the gateway is shutting down cleanly; nothing to do
// If stdin ends without "clean" (the gateway was killed by force), every tracked tree that
// still exists is stopped, including grandchildren whose launcher already died.
import { descendantsOf, forceStopTree, snapshotProcesses, type TrackedRoot } from './process-table.js';

const roots = new Map<number, TrackedRoot>();
let clean = false;
let pending = '';

function handle(line: string): void {
  const [command, pid, startedAt] = line.trim().split(/\s+/);
  if (command === 'track' && pid && startedAt) {
    roots.set(Number(pid), { pid: Number(pid), startedAtMs: Number(startedAt) });
  } else if (command === 'untrack' && pid) {
    roots.delete(Number(pid));
  } else if (command === 'clean') {
    clean = true;
  }
}

async function sweep(): Promise<void> {
  if (clean || roots.size === 0) return;
  const table = await snapshotProcesses();
  const pids = descendantsOf([...roots.values()], table);
  // Stopping each proven pid with /T also covers anything started since the snapshot.
  await Promise.all(pids.map((pid) => forceStopTree(pid)));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  const lines = (pending + chunk).split('\n');
  pending = lines.pop() ?? '';
  lines.forEach(handle);
});
const finish = () => {
  if (pending) handle(pending);
  void sweep()
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.stdin.on('end', finish);
process.stdin.on('error', finish);
