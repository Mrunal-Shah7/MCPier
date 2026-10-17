import { useMutation } from '@tanstack/react-query';
import { DASHBOARD_API_PATHS, type ConnectionTestResponse } from '@mcpier/shared';
import { CheckCircle2Icon, LoaderCircleIcon, XCircleIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { ErrorMessage } from '@/components/common';
import { Button } from '@/components/ui/button';

export function useConnectionTest() {
  return useMutation({
    mutationFn: (entry: Record<string, unknown>) =>
      api.post<ConnectionTestResponse>(DASHBOARD_API_PATHS.connectionTest, entry),
  });
}

/** A "Test connection" button and its result: tools and protocol, or the error with stderr. */
export function ConnectionTest({
  entry,
  disabled,
}: {
  entry: () => Record<string, unknown>;
  disabled?: boolean;
}) {
  const test = useConnectionTest();
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || test.isPending}
        onClick={() => test.mutate(entry())}
      >
        {test.isPending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
        {test.isPending ? 'Testing…' : 'Test connection'}
      </Button>
      {test.error ? <ErrorMessage error={test.error} title="The test could not run" /> : null}
      {test.data ? <ConnectionTestResult result={test.data} /> : null}
    </div>
  );
}

const METHOD_LABELS = {
  manual: 'your client ID',
  cimd: 'the client ID metadata document',
  dynamic: 'dynamic registration',
} as const;

/** An OAuth entry's test: what discovery found (no sign-in happens before saving). */
function DiscoveryResult({ result }: { result: ConnectionTestResponse }) {
  const discovery = result.discovery!;
  const found = (yes: boolean) => (yes ? 'found' : 'not found');
  return (
    <div
      role={result.ok ? 'status' : 'alert'}
      className={`rounded-md border p-3 text-sm ${result.ok ? 'border-emerald-600/30' : 'border-destructive/40'}`}
    >
      <p className="flex items-center gap-2 font-medium">
        {result.ok ? (
          <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden="true" />
        ) : (
          <XCircleIcon className="text-destructive size-4" aria-hidden="true" />
        )}
        {result.ok
          ? `OAuth discovery worked: save the server, then sign in from its page (${result.durationMs} ms)`
          : `OAuth discovery did not find everything (${result.durationMs} ms)`}
      </p>
      <ul className="mt-2 space-y-1">
        <li>Protected-resource metadata: {found(discovery.protectedResourceMetadata)}</li>
        <li>
          Authorization server: {discovery.authorizationServer ?? '—'} (metadata{' '}
          {found(discovery.authorizationServerMetadata)})
        </li>
        {discovery.registrationMethod ? (
          <li>Sign-in would use {METHOD_LABELS[discovery.registrationMethod]}.</li>
        ) : null}
        {discovery.scopesSupported?.length ? (
          <li>
            Scopes offered: <span className="font-mono text-xs">{discovery.scopesSupported.join(' ')}</span>
          </li>
        ) : null}
      </ul>
      {(result.error ?? discovery.note) ? (
        <p className="mt-2 whitespace-pre-line">{result.error ?? discovery.note}</p>
      ) : null}
    </div>
  );
}

export function ConnectionTestResult({ result }: { result: ConnectionTestResponse }) {
  if (result.discovery) return <DiscoveryResult result={result} />;
  if (result.ok) {
    return (
      <div role="status" className="rounded-md border border-emerald-600/30 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden="true" />
          Connected: {result.tools.count} {result.tools.count === 1 ? 'tool' : 'tools'}, protocol{' '}
          {result.protocolVersion ?? 'unknown'}, in {result.durationMs} ms
        </p>
        {result.tools.names.length > 0 ? (
          <p className="text-muted-foreground mt-1 font-mono text-xs break-words">
            {result.tools.names.join(', ')}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className="border-destructive/40 rounded-md border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <XCircleIcon className="text-destructive size-4" aria-hidden="true" />
        {result.needsAuth ? 'Sign-in needed' : 'Connection failed'} ({result.durationMs} ms)
      </p>
      {result.error ? <p className="mt-1 whitespace-pre-line">{result.error}</p> : null}
      {result.stderr && result.stderr.length > 0 ? (
        <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">
          {result.stderr.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
