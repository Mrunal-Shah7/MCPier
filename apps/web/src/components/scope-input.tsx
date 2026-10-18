// OAuth scopes as chips (Sprint 7): Enter, space or comma adds what was typed; each scope is
// checked as an RFC 6749 scope token. The value is the space-separated list the form keeps.
import { useState } from 'react';
import { XIcon } from 'lucide-react';
import { SCOPE_MAX_COUNT, scopeProblem, splitScopes } from '@mcpier/shared';
import { cn } from '@/lib/utils';

export function ScopeInput({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
}) {
  const scopes = splitScopes(value);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  const add = (text: string) => {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0) return;
    for (const part of parts) {
      const reason = scopeProblem(part);
      if (reason) {
        setProblem(`"${part}" ${reason}.`);
        return;
      }
    }
    if (scopes.length + parts.length > SCOPE_MAX_COUNT) {
      setProblem(`At most ${SCOPE_MAX_COUNT} scopes.`);
      return;
    }
    setProblem(undefined);
    setDraft('');
    onChange(splitScopes(scopes, parts).join(' '));
  };

  return (
    <div>
      <div
        className={cn(
          'bg-panel-2 border-input flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          problem ? 'border-tone-bad' : '',
        )}
      >
        {scopes.map((scope) => (
          <span
            key={scope}
            className="border-line-2 text-muted-foreground inline-flex h-6 items-center gap-1 rounded-[5px] border pr-0.5 pl-1.5 font-mono text-[11px]"
          >
            {scope}
            <button
              type="button"
              aria-label={`Remove scope ${scope}`}
              className="hover:bg-panel-3 hover:text-foreground grid size-4 place-items-center rounded"
              onClick={() => onChange(scopes.filter((other) => other !== scope).join(' '))}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          autoComplete="off"
          placeholder={scopes.length === 0 ? 'Add scope…' : ''}
          aria-describedby={describedBy}
          aria-invalid={problem !== undefined}
          className="placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent font-mono text-xs outline-none"
          onChange={(event) => {
            setProblem(undefined);
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === ',') {
              event.preventDefault();
              add(draft);
            } else if (event.key === 'Backspace' && draft === '' && scopes.length > 0) {
              onChange(scopes.slice(0, -1).join(' '));
            }
          }}
          onBlur={() => add(draft)}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (/[\s,]/.test(text)) {
              event.preventDefault();
              add(`${draft}${text}`);
            }
          }}
        />
      </div>
      {problem ? (
        <p className="text-tone-bad-text mt-1 text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
