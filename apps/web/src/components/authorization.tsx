import { useState } from 'react';
import type { AuthStatus, RegistrationMethod } from '@mcpier/shared';
import { ExternalLinkIcon, KeyRoundIcon, LoaderCircleIcon } from 'lucide-react';
import { useAuthStatus } from '@/lib/queries';
import { useAuthAction, useSignIn } from '@/lib/oauth';
import { ConfirmDialog, ErrorMessage, formatRelative, formatTime, LoadingRows } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const METHOD_LABELS: Record<RegistrationMethod, string> = {
  manual: 'Manual client ID',
  cimd: 'Client ID metadata document',
  dynamic: 'Dynamic registration',
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * The Authorization part of an OAuth server's Overview: the sign-in state and why, the
 * issuer, how MCPier is registered, the scopes and token times, and the actions. Sign in
 * opens the authorization page in a new tab and waits here for the result.
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

  return (
    <section aria-label="Authorization" className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRoundIcon className="size-4" aria-hidden="true" />
          Authorization
        </h2>
        <Badge
          variant={status.signedIn ? 'secondary' : 'outline'}
          className={
            status.signedIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
          }
          data-auth-state={status.signedIn ? 'signed_in' : status.reason}
        >
          {authLabel(status)}
        </Badge>
      </div>

      {!status.signedIn && status.message ? <p className="text-sm">{status.message}</p> : null}
      {status.reason === 'more_permissions' && status.requestedScopes?.length ? (
        <p className="text-sm" data-testid="step-up-scopes">
          The server asked for: <span className="font-mono text-xs">{status.requestedScopes.join(' ')}</span>.
          The next sign-in asks for these too.
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

      <dl className="divide-y">
        <Row label="Issuer">{status.issuer ?? '—'}</Row>
        <Row label="Registration">
          {status.registration ? METHOD_LABELS[status.registration.method] : 'Not registered yet'}
          {status.registration?.clientId ? (
            <span className="text-muted-foreground ml-2 font-mono text-xs break-all">
              {status.registration.clientId}
            </span>
          ) : null}
        </Row>
        <Row label="Granted scopes">
          {status.grantedScopes.length > 0 ? (
            <span className="font-mono text-xs">{status.grantedScopes.join(' ')}</span>
          ) : (
            '—'
          )}
        </Row>
        <Row label="Token expires">
          {status.accessTokenExpiresAt ? (
            <span title={formatTime(status.accessTokenExpiresAt)}>
              {formatRelative(status.accessTokenExpiresAt)}
            </span>
          ) : (
            '—'
          )}
          {holdsTokens ? (
            <span className="text-muted-foreground ml-2 text-xs">
              {status.hasRefreshToken
                ? 'renewed automatically'
                : 'no refresh token: sign in again when it runs out'}
            </span>
          ) : null}
        </Row>
        <Row label="Last refresh">
          {status.lastRefreshAt ? (
            <span title={formatTime(status.lastRefreshAt)}>{formatRelative(status.lastRefreshAt)}</span>
          ) : (
            '—'
          )}
        </Row>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={status.signedIn ? 'outline' : 'default'}
          disabled={busy || signIn.wait !== undefined}
          onClick={signIn.begin}
        >
          {signIn.starting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
          {holdsTokens || status.reason === 'sign_in_expired' ? 'Sign in again' : 'Sign in'}
        </Button>
        {status.signedIn && status.hasRefreshToken ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => action.mutate('refresh')}>
            Refresh now
          </Button>
        ) : null}
        {holdsTokens ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => action.mutate('logout')}>
            Sign out
          </Button>
        ) : null}
        {automatic ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmForget(true)}>
            Forget registration…
          </Button>
        ) : null}
      </div>

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
    </section>
  );
}
