// The Sprint 7 design's building blocks: panels, the page header with an info tooltip, the
// main-plus-rail grid, segmented controls and KPI cards. Classes only, never inline styles.
import type { ReactNode } from 'react';
import { InfoIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** An "i" that explains something: opens on hover and on keyboard focus. */
export function InfoTip({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'text-faint hover:text-foreground focus-visible:ring-ring/50 inline-grid size-4 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-[3px]',
            className,
          )}
        >
          <InfoIcon aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

/** A page title with an optional info tooltip, a breadcrumb, a leading icon and actions. No subtitle. */
export function PageTitle({
  title,
  info,
  crumb,
  leading,
  meta,
  actions,
}: {
  title: ReactNode;
  info?: ReactNode;
  crumb?: ReactNode;
  leading?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-[18px]">
      {crumb ? <div className="text-faint mb-1 text-xs">{crumb}</div> : null}
      <div className="flex flex-wrap items-center gap-3">
        {leading}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
            {info ? (
              <InfoTip label={`About ${typeof title === 'string' ? title : 'this page'}`}>{info}</InfoTip>
            ) : null}
          </div>
          {meta ? <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Main column plus a 340 px rail at 1280 px and wider; one column below that. */
export function RailGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]', className)}>
      {children}
    </div>
  );
}

export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 flex-col gap-4', className)}>{children}</div>;
}

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.ComponentProps<'section'>) {
  return (
    <section className={cn('bg-card min-w-0 rounded-[10px] border shadow-card', className)} {...rest}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  info,
  actions,
  className,
  id,
}: {
  title: ReactNode;
  info?: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn('flex min-h-11 flex-wrap items-center gap-2 border-b px-3.5 py-2.5', className)}>
      <h2 id={id} className="text-[13px] font-semibold">
        {title}
      </h2>
      {info ? <InfoTip label={`About ${typeof title === 'string' ? title : 'this'}`}>{info}</InfoTip> : null}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('p-3.5', className)}>{children}</div>;
}

/** Key–value rows (`<dl>`), values wrapping anywhere. */
export function KeyValues({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl
      className={cn('grid grid-cols-[minmax(0,130px)_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]', className)}
    >
      {rows.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="wrap-anywhere m-0 min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small set of mutually exclusive choices (pressed buttons, keyboard reachable). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex overflow-hidden rounded-lg border border-line-2', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'focus-visible:ring-ring/50 px-3 py-1.5 text-[12.5px] whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50',
            option.value === value
              ? 'bg-brand-soft text-tone-ok-text font-semibold'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A number with a label, an optional delta line and a sparkline in the corner. */
export function KpiCard({
  label,
  value,
  delta,
  chart,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  chart?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <Panel className={cn('relative flex flex-col gap-1 overflow-hidden p-3.5', className)}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn('text-[22px] font-semibold tracking-tight tabular-nums', valueClassName)}>
        {value}
      </span>
      {delta ? <span className="text-[11.5px]">{delta}</span> : null}
      {chart ? <div className="absolute right-2.5 bottom-2.5 opacity-90">{chart}</div> : null}
    </Panel>
  );
}

/** A KPI delta against the previous period: up or down, coloured by whether that is good. */
export function Delta({
  current,
  previous,
  goodWhen = 'up',
  suffix = '',
  points = false,
}: {
  current: number | null;
  previous: number | null;
  goodWhen?: 'up' | 'down';
  suffix?: string;
  /** Compare rates in percentage points instead of relative change. */
  points?: boolean;
}) {
  if (current === null || previous === null || (!points && previous === 0)) {
    return <span className="text-muted-foreground">no earlier data</span>;
  }
  const change = points ? (current - previous) * 100 : ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.05) return <span className="text-muted-foreground">no change{suffix}</span>;
  const up = change > 0;
  const good = up === (goodWhen === 'up');
  const amount = points ? `${Math.abs(change).toFixed(1)} pts` : `${Math.round(Math.abs(change))}%`;
  return (
    <span data-delta={up ? 'up' : 'down'} className={good ? 'text-tone-ok-text' : 'text-tone-bad-text'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> <span className="sr-only">{up ? 'Up' : 'Down'} </span>
      {amount}
      {suffix}
    </span>
  );
}

/** A one-line empty state: a sentence and one action. */
export function EmptyLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-3 px-6 py-8 text-center text-sm">
      <span>{children}</span>
      {action}
    </div>
  );
}
