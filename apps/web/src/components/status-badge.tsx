import type { ServerStatus } from '@mcpier/shared';
import { cn } from '@/lib/utils';

/** One label and one colour per status, used everywhere a status is shown. */
export const STATUS_STYLES: Record<ServerStatus, { label: string; className: string }> = {
  starting: {
    label: 'Starting',
    className:
      'bg-sky-100 text-sky-800 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-400/30',
  },
  ready: {
    label: 'Ready',
    className:
      'bg-emerald-100 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
  },
  needs_auth: {
    label: 'Needs sign-in',
    className:
      'bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/30',
  },
  error: {
    label: 'Error',
    className:
      'bg-red-100 text-red-800 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/30',
  },
  crashed: {
    label: 'Crashed',
    className:
      'bg-rose-200 text-rose-900 ring-rose-700/30 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/40',
  },
  stopped: {
    label: 'Stopped',
    className:
      'bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/20',
  },
};

export function StatusBadge({ state, className }: { state: ServerStatus; className?: string }) {
  const style = STATUS_STYLES[state];
  return (
    <span
      data-status={state}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        style.className,
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {style.label}
    </span>
  );
}
