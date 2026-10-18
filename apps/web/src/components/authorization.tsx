import { useState } from 'react';
import type { AuthStatus, RegistrationMethod, ScopeSource } from '@mcpier/shared';
import { ExternalLinkIcon, LoaderCircleIcon } from 'lucide-react';
import { useAuthStatus } from '@/lib/queries';
import { useAuthAction, useSignIn } from '@/lib/oauth';
import { ConfirmDialog, ErrorMessage, formatRelative, formatTime, LoadingRows } from '@/components/common';
import { KeyValues, Panel, PanelBody, PanelHeader } from '@/components/kit';
import { Chip, ToneBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';

const METHOD_LABELS: Record<RegistrationMethod, string> = {
  manual: 'Manual client ID',
  cimd: 'Client ID metadata document',
  dynamic: 'Dynamic registration',
};

export const SCOPE_SOURCE_LABELS: Record<ScopeSource, string> = {
  configured: 'configured',
  challenge: "the server's challenge",
  server_metadata: 'server metadata',
  decided_at_sign_in: 'decided at sign-in',
};

/** One label per sign-in state. */
export function authLabel(status: AuthStatus): string {
  if (status.signedIn) return 'Signed in';
  switch (status.reason) {
    case 'sign_in_expired':
      return 'Sign-in expired';
    case 'more_permissions':
      return 'More permissions needed';
    case 'needs_client_id':
      return 'Needs a client ID';
    default:
      return 'Sign-in required';
  }
}

function Scopes({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {scopes.map((scope) => (
        <Chip key={scope} className="font-mono">
          {scope}
        </Chip>
      ))}
    </span>
  );
}

/**
 * The Authorization card of an OAuth server: the sign-in state, the client method, the granted
 * scopes, the scopes the next sign-in requests and where they come from, token times, and the
 * actions. Sign in opens the authorization page in a new tab and waits here for the result.
 */
export function AuthorizationSection({ server }: { server: string }) {
  const query = useAuthStatus(server);
  const status = query.data?.status;
  const signIn = useSignIn(server, status);
  const action = useAuthAction(server);
  const [confirmForget, setConfirmForget] = useState(false);

  if (query.isPending) return <LoadingRows rows={2} label="Loading the sign-in" />;
  if (query.error || !status) return <ErrorMessage error={query.error} title="Cannot load the sign-in" />;

  const holdsTokens = status.signedIn || status.reason === 'more_permissions';
  const busy = signIn.starting || action.isPending;
  const automatic = status.registration && status.registration.method !== 'manual';
  const next = status.nextScopes;

  return (
    <Panel aria-label="Authorization">
      <PanelHeader
        title="Authorization"
        actions={
          <ToneBadge
            tone={status.signedIn ? 'ok' : 'warn'}
            data-auth-state={status.signedIn ? 'signed_in' : (status.reason ?? 'sign_in_required')}
          >
            {authLabel(status)}
          </ToneBadge>
        }
      />
      <PanelBody className="space-y-3">
        {!status.signedIn && status.message ? (
          <p className="wrap-anywhere m-0 text-sm">{status.message}</p>
        ) : null}
        {status.reason === 'more_permissions' && status.requestedScopes?.length ? (
          <p className="m-0 text-sm" data-testid="step-up-scopes">
            The server asked for:{' '}
            <span className="font-mono text-xs">{status.requestedScopes.join(' ')}</span>. The next sign-in
            asks for these too.
          </p>
        ) : null}
        {status.scopesChanged ? (
          <p
            role="note"
            data-testid="scopes-changed"
            className="border-tone-warn/35 bg-tone-warn-soft text-tone-warn-text m-0 rounded-md border px-3 py-2 text-sm"
          >
            Sign in again to use the new scopes. The current sign-in keeps working until then.
          </p>
        ) : null}

        {signIn.wait ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3 text-sm"
          >
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            <span>Waiting for sign-in… Finish it in the new tab; this page updates by itself.</span>
            {signIn.wait.blocked ? (
              <a
                className="inline-flex items-center gap-1 underline"
                href={signIn.wait.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                The browser blocked the new tab: open the sign-in page
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </a>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={signIn.cancel}>
              Stop waiting
            </Button>
          </div>
        ) : null}

        <KeyValues
          rows={[
            [
              'Client',
              <>
                {status.registration ? METHOD_LABELS[status.registration.method] : 'Not registered yet'}
                {status.registration?.clientId ? (
                  <span className="text-muted-foreground wrap-anywhere ml-2 font-mono text-xs">
                    {status.registration.clientId}
                  </span>
                ) : null}
              </>,
            ],
            ['Issuer', <span className="font-mono text-xs">{status.issuer ?? '—'}</span>],
            ['Granted scopes', <Scopes scopes={status.grantedScopes} />],
            [
              'Next sign-in',
              next ? (
                <span className="flex flex-col gap-1" data-testid="next-scopes">
                  {next.scopes.length > 0 ? <Scopes scopes={next.scopes} /> : null}
                  <span className="text-faint text-xs">Scopes: {SCOPE_SOURCE_LABELS[next.source]}</span>
                </span>
              ) : (
                '—'
              ),
            ],
            [
              'Token expires',
              <>
                {status.accessTokenExpiresAt ? (
                  <span title={formatTime(status.accessTokenExpiresAt)}>
                    {formatRelative(status.accessTokenExpiresAt)}
                  </span>
                ) : (
                  '—'
                )}
                {holdsTokens ? (
                  <span className="text-faint ml-2 text-xs">
                    {status.hasRefreshToken
                      ? 'renewed automatically'
                      : 'no refresh token: sign in again when it runs out'}
                  </span>
                ) : null}
              </>,
            ],
            [
              'Last refresh',
              status.lastRefreshAt ? (
                <span title={formatTime(status.lastRefreshAt)}>{formatRelative(status.lastRefreshAt)}</span>
              ) : (
                '—'
              ),
            ],
          ]}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={status.signedIn && !status.scopesChanged ? 'outline' : 'default'}
            disabled={busy || signIn.wait !== undefined}
            onClick={signIn.begin}
          >
            {signIn.starting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
            {holdsTokens || status.reason === 'sign_in_expired' ? 'Sign in again' : 'Sign in'}
          </Button>
          {status.signedIn && status.hasRefreshToken ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate('refresh')}
            >
              Refresh now
            </Button>
          ) : null}
          {holdsTokens ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate('logout')}
            >
              Sign out
            </Button>
          ) : null}
          {automatic ? (
            <Button
              type="button"
              size="sm"
              variant="destructive-ghost"
              disabled={busy}
              onClick={() => setConfirmForget(true)}
            >
              Forget registration…
            </Button>
          ) : null}
        </div>
      </PanelBody>

      <ConfirmDialog
        open={confirmForget}
        onOpenChange={setConfirmForget}
        title={`Forget the registration for ${server}?`}
        description={
          <p>
            MCPier signs out of <strong>{server}</strong> and deletes how it is registered with the
            authorization server. The next sign-in registers MCPier again.
          </p>
        }
        confirmLabel="Forget registration"
        onConfirm={() => action.mutate('forget')}
      />
    </Panel>
  );
}
