// An upstream error, readable (Confirmed decisions 8 and 9): the clean message first, wrapping
// inside its card however long the text is, and the raw response behind a disclosure.
import { cn } from '@/lib/utils';

export function ErrorBlock({
  message,
  raw,
  code,
  className,
}: {
  /** The clean message (`cleanErrorMessage`). */
  message: string;
  /** The raw text, shown behind "Raw response" when it differs from the message. */
  raw?: string | undefined;
  code?: number | undefined;
  className?: string;
}) {
  const showRaw = raw !== undefined && raw.trim() !== message.trim();
  return (
    <div
      role="group"
      aria-label="Error"
      data-slot="error-block"
      className={cn('border-tone-bad/30 bg-tone-bad-soft min-w-0 rounded-lg border p-3', className)}
    >
      <p className="wrap-anywhere text-tone-bad-text m-0 text-[13px] whitespace-pre-wrap">{message}</p>
      {code !== undefined ? <p className="text-faint mt-1 text-xs">Code {code}</p> : null}
      {showRaw ? (
        <details className="mt-2">
          <summary className="text-faint cursor-pointer text-xs">Raw response</summary>
          <pre className="wrap-anywhere bg-panel-2 mt-2 max-h-72 overflow-y-auto rounded-md border p-2.5 font-mono text-xs whitespace-pre-wrap">
            {raw}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
