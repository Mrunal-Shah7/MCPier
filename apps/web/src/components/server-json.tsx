// The Edit page's JSON tab (Confirmed decision 16): the stored entry as JSON (references as
// references; no secret or OAuth value is ever in config), checked as you type, saved whole
// with PUT /api/servers/:name.
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, TriangleAlertIcon, WandIcon } from 'lucide-react';
import { API_PATHS, proposedSecretName, type ServerReplaceResponse } from '@mcpier/shared';
import { api } from '@/lib/api';
import { analyzeEntryJson, type JsonAnalysis } from '@/lib/json-entry';
import { queryKeys } from '@/lib/queries';
import { ErrorMessage } from '@/components/common';
import { CodeEditor } from '@/components/code-editor';
import { ToneBadge } from '@/components/status-badge';
import { useToast } from '@/components/toaster';
import { Button } from '@/components/ui/button';

export const VALIDATE_DELAY_MS = 300;

/** Debounced analysis: the editor checks 300 ms after typing stops. */
export function useJsonAnalysis(text: string, name: string): JsonAnalysis | undefined {
  const [analysis, setAnalysis] = useState<JsonAnalysis | undefined>(() => analyzeEntryJson(text, name));
  useEffect(() => {
    const timer = setTimeout(() => setAnalysis(analyzeEntryJson(text, name)), VALIDATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, name]);
  return analysis;
}

export function ServerJson({
  name,
  text,
  onText,
  onSaved,
  onMoveToSecret,
}: {
  name: string;
  text: string;
  onText: (text: string) => void;
  /** After a save: the entry as saved. */
  onSaved: (entry: Record<string, unknown>) => void;
  /** Offer Move to secret for a plain credential-looking value (after saving). */
  onMoveToSecret: (target: { location: 'env' | 'header'; key: string }) => void;
}) {
  const analysis = useJsonAnalysis(text, name);
  const client = useQueryClient();
  const { notify } = useToast();
  const [saved, setSaved] = useState<
    { credentials: JsonAnalysis['credentials']; warnings: string[] } | undefined
  >();

  const save = useMutation({
    mutationFn: (entry: Record<string, unknown>) =>
      api.put<ServerReplaceResponse>(API_PATHS.server(name), entry),
    onSuccess: (response, entry) => {
      void client.invalidateQueries({ queryKey: queryKeys.server(name) });
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      setSaved({ credentials: analyzeEntryJson(text, name).credentials, warnings: response.warnings });
      notify(
        'success',
        `Saved ${name}.`,
        response.warnings.length > 0 ? response.warnings.join('\n') : undefined,
      );
      onSaved(entry);
    },
  });

  const saveSecret = useMutation({
    mutationFn: async () => {
      const entry = JSON.parse(text) as Record<string, unknown>;
      const oauth = entry.oauth as Record<string, unknown>;
      const secretName = proposedSecretName(name, 'client-secret');
      // The value goes to Credential Manager once; the editor then holds only the reference.
      await api.put(API_PATHS.secret(secretName), { value: String(oauth.clientSecret) });
      oauth.clientSecret = `secret:${secretName}`;
      return { text: JSON.stringify(entry, null, 2), secretName };
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      onText(result.text);
      notify('success', `The client secret is stored as ${result.secretName}.`);
    },
  });

  const format = () => {
    try {
      onText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      // Not JSON: nothing to format; the problem is listed below.
    }
  };

  const problemLines = analysis?.problems.flatMap((problem) => (problem.line ? [problem.line] : [])) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {analysis?.valid ? (
          <ToneBadge tone="ok" data-json-state="valid">
            Valid
          </ToneBadge>
        ) : (
          <ToneBadge tone="bad" data-json-state="invalid">
            {analysis?.syntax ? 'Not JSON' : `${analysis?.problems.length ?? 0} problems`}
          </ToneBadge>
        )}
        <span id="json-hint" className="text-faint text-xs">
          Saving replaces the whole entry · name can't change here
        </span>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={format}>
          <WandIcon aria-hidden="true" />
          Format
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => notify('success', 'Copied the JSON.'))
          }
        >
          <CopyIcon aria-hidden="true" />
          Copy
        </Button>
      </div>
      <CodeEditor
        id="server-json"
        label={`${name} as JSON`}
        value={text}
        onChange={onText}
        problemLines={problemLines}
        describedBy="json-hint json-help"
      />
      <p id="json-help" className="sr-only">
        Tab inserts two spaces; Escape leaves the editor.
      </p>
      {analysis && analysis.problems.length > 0 ? (
        <ul
          aria-label="Problems"
          className="border-tone-bad/30 bg-tone-bad-soft m-0 list-none space-y-1 rounded-lg border p-3 text-sm"
        >
          {analysis.problems.map((problem, index) => (
            <li key={index} className="text-tone-bad-text wrap-anywhere">
              {problem.line ? <span className="font-semibold">Line {problem.line}: </span> : null}
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
      {analysis?.plainClientSecret ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>oauth.clientSecret must be a secret: reference.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saveSecret.isPending}
            onClick={() => saveSecret.mutate()}
          >
            Save as secret
          </Button>
        </div>
      ) : null}
      {saveSecret.error ? (
        <ErrorMessage error={saveSecret.error} title="Could not store the client secret" />
      ) : null}
      {analysis && analysis.warnings.length > 0 ? (
        <p className="text-tone-warn-text m-0 text-sm" role="note">
          Not used by MCPier (kept as written): {analysis.warnings.join(', ')}
        </p>
      ) : null}
      {analysis && analysis.credentials.length > 0 ? (
        <div
          role="note"
          className="border-tone-warn/35 bg-tone-warn-soft text-tone-warn-text flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Plain values that look like credentials:{' '}
            {analysis.credentials.map((value) => value.key).join(', ')}. After saving, move them to secrets.
          </span>
        </div>
      ) : null}
      {saved && saved.credentials.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Move to secret">
          {saved.credentials.map((value) => (
            <Button
              key={`${value.location}:${value.key}`}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onMoveToSecret(value)}
            >
              Move {value.key} to secret
            </Button>
          ))}
        </div>
      ) : null}
      {save.error ? <ErrorMessage error={save.error} title="Could not save" /> : null}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={!analysis?.valid || save.isPending}
          onClick={() => {
            // The text as it is now, not the debounced analysis, which can be 300 ms behind.
            const current = analyzeEntryJson(text, name);
            if (current.valid && current.entry) save.mutate(current.entry);
          }}
        >
          Save JSON
        </Button>
      </div>
    </div>
  );
}
