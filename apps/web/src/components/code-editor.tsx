// MCPier's own small code editor (Sprint 7): a textarea with a line-number gutter. CodeMirror and
// Monaco inject styles at run time, which the CSP forbids. The gutter and the text share font,
// line height and padding, and the gutter follows the textarea's scroll, so numbers never drift.
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export function CodeEditor({
  id,
  value,
  onChange,
  label,
  problemLines = [],
  describedBy,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** Lines to mark in the gutter (1-based). */
  problemLines?: readonly number[];
  describedBy?: string;
  className?: string;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const count = Math.max(1, value.split('\n').length);
  const marked = new Set(problemLines);

  // Keep the gutter aligned when the text changes size too (paste, Format).
  useEffect(() => {
    if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop;
  }, [value]);

  return (
    <div
      className={cn(
        'bg-panel-2 grid grid-cols-[44px_minmax(0,1fr)] overflow-hidden rounded-lg border font-mono text-[12.5px] leading-[1.7]',
        'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
        className,
      )}
    >
      <div
        ref={gutter}
        aria-hidden="true"
        data-slot="gutter"
        className="text-faint h-[420px] overflow-hidden border-r py-2.5 pr-2.5 text-right select-none"
      >
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className={marked.has(index + 1) ? 'text-tone-bad-text font-semibold' : undefined}>
            {index + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={area}
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        wrap="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            const element = event.currentTarget;
            element.setRangeText('  ', element.selectionStart, element.selectionEnd, 'end');
            onChange(element.value);
          } else if (event.key === 'Escape') {
            event.currentTarget.blur();
          }
        }}
        className="h-[420px] w-full resize-none overflow-auto bg-transparent px-3.5 py-2.5 whitespace-pre outline-none"
      />
    </div>
  );
}
