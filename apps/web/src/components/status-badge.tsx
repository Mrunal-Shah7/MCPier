// Badges and chips with one colour per meaning, used everywhere (Confirmed decision 2).
import type { ReactNode } from 'react';
import type { CallOutcomeName, SearchFollowup, ServerStatus } from '@mcpier/shared';
import { FOLLOWUP_LABELS, OUTCOME_LABELS } from '@/lib/call-log';
import { OUTCOME_TONE, STATUS_TONE, TONE_BADGE, type Tone } from '@/lib/palette';
import { cn } from '@/lib/utils';

/** One label and one tone per status. */
export const STATUS_STYLES: Record<ServerStatus, { label: string; tone: Tone }> = {
  starting: { label: 'Starting', tone: STATUS_TONE.starting },
  ready: { label: 'Ready', tone: STATUS_TONE.ready },
  needs_auth: { label: 'Needs sign-in', tone: STATUS_TONE.needs_auth },
  error: { label: 'Error', tone: STATUS_TONE.error },
  crashed: { label: 'Crashed', tone: STATUS_TONE.crashed },
  stopped: { label: 'Stopped', tone: STATUS_TONE.stopped },
};

/** A small tinted badge with a dot. */
export function ToneBadge({
  tone,
  children,
  dot = true,
  className,
  ...data
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
} & Record<`data-${string}`, string>) {
  return (
    <span
      {...data}
      data-tone={tone}
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap',
        TONE_BADGE[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function StatusBadge({ state, className }: { state: ServerStatus; className?: string }) {
  const style = STATUS_STYLES[state];
  return (
    <ToneBadge tone={style.tone} data-status={state} className={className}>
      {style.label}
    </ToneBadge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: CallOutcomeName }) {
  return (
    <ToneBadge tone={OUTCOME_TONE[outcome]} data-outcome={outcome}>
      {OUTCOME_LABELS[outcome]}
    </ToneBadge>
  );
}

const FOLLOWUP_TONE: Record<SearchFollowup, Tone> = { hit: 'ok', miss: 'bad', none: 'off', pending: 'info' };

export function FollowupBadge({ followup }: { followup: SearchFollowup }) {
  return (
    <ToneBadge tone={FOLLOWUP_TONE[followup]} data-followup={followup} dot={false}>
      {FOLLOWUP_LABELS[followup]}
    </ToneBadge>
  );
}

const chip =
  'inline-flex h-5 items-center gap-1 rounded-[5px] border px-1.5 text-[11px] font-semibold tracking-wide whitespace-nowrap';

/** stdio in violet, HTTP in sky. */
export function TransportChip({ transport }: { transport: 'stdio' | 'http' }) {
  return (
    <span
      data-transport={transport}
      className={cn(
        chip,
        transport === 'stdio'
          ? 'border-tone-input/40 text-tone-input-text'
          : 'border-tone-info/40 text-tone-info-text',
      )}
    >
      {transport.toUpperCase()}
    </span>
  );
}

/** A `secret:<name>` reference; amber when the secret does not exist. */
export function SecretChip({
  name,
  prefix = '',
  missing = false,
}: {
  name: string;
  prefix?: string;
  missing?: boolean;
}) {
  return (
    <span
      className={cn(
        chip,
        'font-mono font-medium tracking-normal',
        missing ? 'border-tone-warn/40 text-tone-warn-text' : 'border-brand-line text-tone-ok-text',
      )}
    >
      {prefix}secret:{name}
    </span>
  );
}

/** A neutral chip (scopes, tool names). */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(chip, 'border-line-2 text-muted-foreground font-medium', className)}>{children}</span>
  );
}
