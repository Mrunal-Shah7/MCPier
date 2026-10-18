// MCPier's own small SVG charts (Confirmed decision 5): geometry comes from SVG attributes and
// colour from a fixed set of classes, never from `style`. Each has a hover tooltip (SVG <title>)
// and a text alternative (an aria-label summary, or a table for the stacked bars).
import { useState, type ReactNode } from 'react';
import { TONE_STROKE, type Tone } from '@/lib/palette';
import { cn } from '@/lib/utils';

const round = (value: number) => Math.round(value * 10) / 10;

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${round(value / 1_000_000)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${round(value / 1000)}k`;
  return String(value);
}

// ---- Sparkline

export function Sparkline({
  values,
  label,
  tone = 'ok',
  strokeClass,
  width = 84,
  height = 26,
  pointLabel,
  className,
}: {
  values: readonly number[];
  /** What the line shows, for the text alternative ("Calls per day"). */
  label: string;
  tone?: Tone;
  /** A palette stroke class instead of a tone. */
  strokeClass?: string;
  width?: number;
  height?: number;
  /** The tooltip text of one point. */
  pointLabel?: (value: number, index: number) => string;
  className?: string;
}) {
  const stroke = strokeClass ?? TONE_STROKE[tone];
  const max = Math.max(...values, 1);
  const summary =
    values.length === 0
      ? `${label}: no data`
      : `${label}: ${values.length} points, from ${values[0]} to ${values.at(-1)}, highest ${Math.max(...values)}`;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index) => [
    round(values.length > 1 ? index * step : width / 2),
    round(height - 2 - (value / max) * (height - 6)),
  ]);
  return (
    <svg
      role="img"
      aria-label={summary}
      data-chart="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('block overflow-visible', className)}
    >
      <title>{summary}</title>
      {values.length === 0 ? (
        <line x1={0} x2={width} y1={height - 2} y2={height - 2} className="stroke-line-2" strokeWidth={1.5} />
      ) : values.length === 1 ? (
        <circle
          cx={points[0]![0]}
          cy={points[0]![1]}
          r={2.5}
          className={cn(stroke, 'fill-current')}
          strokeWidth={1.5}
        />
      ) : (
        <polyline
          points={points.map((point) => point.join(',')).join(' ')}
          fill="none"
          className={stroke}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {values.length > 1
        ? points.map(([x, y], index) => (
            <circle key={index} cx={x} cy={y} r={Math.max(step / 2, 3)} className="fill-transparent">
              <title>{pointLabel ? pointLabel(values[index]!, index) : String(values[index])}</title>
            </circle>
          ))
        : null}
    </svg>
  );
}

// ---- Stacked bars

export interface BarSeries {
  key: string;
  label: string;
  values: readonly number[];
  /** A palette or tone fill class. */
  fillClass: string;
  /** The legend swatch (a background class of the same colour). */
  swatchClass: string;
}

export function StackedBars({
  labels,
  series,
  title,
  unit = 'calls',
}: {
  /** One label per bucket ("Mon 14", "09:00"). */
  labels: readonly string[];
  series: readonly BarSeries[];
  /** What the chart shows, for the text alternative. */
  title: string;
  unit?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const W = 760;
  const H = 220;
  const pad = 28;
  const count = labels.length;
  const totals = labels.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const slot = count > 0 ? (W - pad * 2) / count : 0;
  const barWidth = Math.max(Math.min(slot * 0.7, 46), 2);
  const every = Math.max(1, Math.ceil(count / 10));
  const grand = totals.reduce((sum, value) => sum + value, 0);
  const summary = `${title}: ${grand} ${unit} in ${count} buckets${
    grand > 0 ? `, most in ${labels[totals.indexOf(Math.max(...totals))]} (${Math.max(...totals)})` : ''
  }`;

  return (
    <div data-chart="stacked-bars">
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-faint">
                <th className="px-2 py-1 text-left font-medium">Bucket</th>
                {series.map((item) => (
                  <th key={item.key} className="px-2 py-1 text-right font-medium">
                    {item.label}
                  </th>
                ))}
                <th className="px-2 py-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((label, index) => (
                <tr key={index} className="border-t">
                  <td className="px-2 py-1 whitespace-nowrap">{label}</td>
                  {series.map((item) => (
                    <td key={item.key} className="px-2 py-1 text-right tabular-nums">
                      {item.values[index] ?? 0}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-medium tabular-nums">{totals[index]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
          <title>{summary}</title>
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const y = round(H - pad - (H - pad * 2) * fraction);
            return (
              <line
                key={fraction}
                x1={pad}
                x2={W - pad}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
              />
            );
          })}
          {labels.map((label, index) => {
            let y = H - pad;
            const x = round(pad + index * slot + (slot - barWidth) / 2);
            return (
              <g key={index}>
                {series.map((item) => {
                  const value = item.values[index] ?? 0;
                  if (value === 0) return null;
                  const height = (value / max) * (H - pad * 2);
                  y -= height;
                  return (
                    <rect
                      key={item.key}
                      x={x}
                      y={round(y)}
                      width={round(barWidth)}
                      height={round(Math.max(height - 1.5, 1))}
                      rx={3}
                      className={item.fillClass}
                    >
                      <title>{`${item.label}: ${value} ${unit} (${label})`}</title>
                    </rect>
                  );
                })}
                {index % every === 0 ? (
                  <text
                    x={round(x + barWidth / 2)}
                    y={H - 8}
                    textAnchor="middle"
                    fontSize={11}
                    className="fill-faint"
                  >
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs">
        <ul className="text-muted-foreground flex flex-wrap gap-x-3.5 gap-y-1" aria-label="Legend">
          {series.map((item) => (
            <li key={item.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn('inline-block size-[9px] rounded-[3px]', item.swatchClass)}
              />
              {item.label}
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((value) => !value)}
          className="text-muted-foreground hover:text-foreground ml-auto underline-offset-2 hover:underline"
        >
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
    </div>
  );
}

// ---- Bar list

export interface BarListRow {
  key: string;
  label: ReactNode;
  /** The label as text (tooltip and text alternative). */
  text: string;
  value: number;
  display: string;
  fillClass: string;
}

/** Horizontal bars, longest first as given: a share or an amount per row. */
export function BarList({ rows, title, max }: { rows: readonly BarListRow[]; title: string; max?: number }) {
  const top = max ?? Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul
      data-chart="bar-list"
      aria-label={`${title}: ${rows.map((row) => `${row.text} ${row.display}`).join(', ') || 'no data'}`}
      className="flex flex-col gap-3"
    >
      {rows.map((row) => {
        const width = top > 0 ? round((row.value / top) * 100) : 0;
        return (
          <li key={row.key} title={`${row.text}: ${row.display}`}>
            <div className="flex items-center gap-2 text-xs">
              <div className="min-w-0 flex-1 truncate">{row.label}</div>
              <span className="text-muted-foreground tabular-nums">{row.display}</span>
            </div>
            <svg
              aria-hidden="true"
              viewBox="0 0 100 8"
              preserveAspectRatio="none"
              className="mt-1.5 block h-2 w-full"
            >
              <rect x={0} y={0} width={100} height={8} rx={4} className="fill-panel-3" />
              {width > 0 ? (
                <rect x={0} y={0} width={Math.max(width, 1)} height={8} rx={4} className={row.fillClass} />
              ) : null}
            </svg>
          </li>
        );
      })}
    </ul>
  );
}

// ---- Ring

/** A share from 0 to 1 as a ring with the percentage in the middle. */
export function Ring({
  value,
  label,
  display,
  size = 92,
}: {
  value: number | null;
  label: string;
  /** The text in the middle (default: the rounded percentage). */
  display?: string;
  size?: number;
}) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const share = value === null ? 0 : Math.min(Math.max(value, 0), 1);
  const text = display ?? (value === null ? '—' : `${Math.round(share * 100)}%`);
  return (
    <svg
      role="img"
      aria-label={`${label}: ${value === null ? 'no data' : text}`}
      data-chart="ring"
      width={size}
      height={size}
      viewBox="0 0 92 92"
      className="block shrink-0"
    >
      <title>{`${label}: ${value === null ? 'no data' : text}`}</title>
      <circle cx={46} cy={46} r={radius} fill="none" strokeWidth={10} className="stroke-panel-3" />
      {share > 0 ? (
        <circle
          cx={46}
          cy={46}
          r={radius}
          fill="none"
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${round(share * circumference)} ${round(circumference)}`}
          transform="rotate(-90 46 46)"
          className="stroke-tone-ok"
        />
      ) : null}
      <text x={46} y={52} textAnchor="middle" fontSize={18} fontWeight={700} className="fill-foreground">
        {text}
      </text>
    </svg>
  );
}
