import { useMutation } from '@tanstack/react-query';
import { DASHBOARD_API_PATHS, type ConnectionTestResponse } from '@mcpier/shared';
import { LoaderCircleIcon, LockIcon, PlayIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { ErrorMessage } from '@/components/common';
import { ErrorBlock } from '@/components/error-block';
import { KeyValues, Panel, PanelBody, PanelHeader } from '@/components/kit';
import { Chip, ToneBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';

export function useConnectionTest() {
  return useMutation({
    mutationFn: (entry: Record<string, unknown>) =>
      api.post<ConnectionTestResponse>(DASHBOARD_API_PATHS.connectionTest, entry),
  });
}

/** The rail's "Connection test": connects to the unsaved entry, lists its tools, disconnects. */
export function ConnectionTest({
  entry,
  disabled,
  bare = false,
}: {
  entry: () => Record<string, unknown>;
  disabled?: boolean;
  /** Without its own panel (inside a pasted entry's card). */
  bare?: boolean;
}) {
  const test = useConnectionTest();
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || test.isPending}
      onClick={() => test.mutate(entry())}
    >
      {test.isPending ? (
        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
      ) : (
        <PlayIcon aria-hidden="true" />
      )}
      {test.isPending ? 'Testing…' : 'Test connection'}
    </Button>
  );
  const body = (
    <>
      {test.error ? <ErrorMessage error={test.error} title="The test could not run" /> : null}
      {test.data ? <ConnectionTestResult result={test.data} /> : null}
      {!test.error && !test.data && !bare ? (
        <p className="text-muted-foreground m-0 text-sm">
          Connects, lists the tools, disconnects. Nothing is saved.
        </p>
      ) : null}
    </>
  );
  if (bare) {
    return (
      <div className="space-y-3">
        {button}
        {body}
      </div>
    );
  }
  return (
    <Panel aria-label="Connection test">
      <PanelHeader title="Connection test" actions={button} />
      <PanelBody className="space-y-3">{body}</PanelBody>
    </Panel>
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
    <div role={result.ok ? 'status' : 'alert'} className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={result.ok ? 'ok' : 'warn'}>
          {result.ok ? 'Discovery worked' : 'Discovery incomplete'}
        </ToneBadge>
        <span className="text-faint text-xs">{result.durationMs} ms</span>
      </div>
      <p className="m-0">
        {result.ok
          ? 'OAuth discovery worked: save the server, then sign in from its page.'
          : 'OAuth discovery did not find everything.'}
      </p>
      <KeyValues
        rows={[
          ['Resource metadata', found(discovery.protectedResourceMetadata)],
          [
            'Authorization server',
            <span className="font-mono text-xs">
              {discovery.authorizationServer ?? '—'} ({found(discovery.authorizationServerMetadata)})
            </span>,
          ],
          [
            'Sign-in',
            discovery.registrationMethod ? `Would use ${METHOD_LABELS[discovery.registrationMethod]}` : '—',
          ],
          [
            'Scopes offered',
            discovery.scopesSupported?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {discovery.scopesSupported.map((scope) => (
                  <Chip key={scope} className="font-mono">
                    {scope}
                  </Chip>
                ))}
              </span>
            ) : (
              '—'
            ),
          ],
        ]}
      />
      {(result.error ?? discovery.note) ? (
        <p className="wrap-anywhere m-0 whitespace-pre-line">{result.error ?? discovery.note}</p>
      ) : null}
    </div>
  );
}

export function ConnectionTestResult({ result }: { result: ConnectionTestResponse }) {
  if (result.discovery) return <DiscoveryResult result={result} />;
  if (result.ok) {
    const shown = result.tools.names.slice(0, 8);
    return (
      <div role="status" className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <ToneBadge tone="ok">Connected</ToneBadge>
          <span className="text-faint text-xs">{result.durationMs} ms</span>
        </div>
        <p className="m-0">
          Connected: {result.tools.count} {result.tools.count === 1 ? 'tool' : 'tools'}, protocol{' '}
          {result.protocolVersion ?? 'unknown'}, in {result.durationMs} ms
        </p>
        {shown.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {shown.map((name) => (
              <Chip key={name} className="font-mono">
                {name}
              </Chip>
            ))}
            {result.tools.names.length > shown.length ? (
              <span className="text-faint text-xs">+{result.tools.names.length - shown.length}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={result.needsAuth ? 'warn' : 'bad'}>
          {result.needsAuth ? 'Sign-in needed' : 'Connection failed'}
        </ToneBadge>
        <span className="text-faint text-xs">{result.durationMs} ms</span>
      </div>
      {result.error ? <ErrorBlock message={result.error} /> : null}
      {result.stderr && result.stderr.length > 0 ? (
        <pre className="wrap-anywhere bg-panel-2 max-h-48 overflow-y-auto rounded-lg border p-2 font-mono text-xs whitespace-pre-wrap">
          {result.stderr.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

/** The rail's note under the connection test. */
export function SecretsNote() {
  return (
    <p className="text-faint flex items-center gap-1.5 text-xs">
      <LockIcon aria-hidden="true" className="size-3.5" />
      Values marked as secrets go to Credential Manager before saving.
    </p>
  );
}
