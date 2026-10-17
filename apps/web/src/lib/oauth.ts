// Signing in to OAuth servers from the dashboard. The gateway does the OAuth work; the
// dashboard only starts a sign-in, opens the authorization page in a new top-level tab, and
// waits for the `auth_status` event. It never sees a token.
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AUTH_API_PATHS,
  type AuthStatus,
  type AuthStatusResponse,
  type SignInStartResponse,
} from '@mcpier/shared';
import { api, describeError } from './api';
import { queryKeys } from './queries';
import { useToast } from '@/components/toaster';

/**
 * Opens an empty tab while the click is still being handled, so popup blockers allow it. It
 * is pointed at the authorization page once the gateway answers, and loses its link back to
 * the dashboard first (no `opener`). Never a frame: the dashboard's CSP forbids them.
 */
export function openSignInTab(): Window | null {
  const tab = window.open('', '_blank');
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      // Some browsers refuse; the tab is about:blank of our own origin until it navigates.
    }
  }
  return tab;
}

/** What the page shows while a sign-in it started is open in another tab. */
export interface SignInWait {
  /** `signedInAt` before the sign-in started: a different one means it succeeded. */
  before?: string;
  /** The authorization URL, for a link when the browser blocked the new tab. */
  url: string;
  blocked: boolean;
  /** The gateway reported the sign-in as pending at least once. */
  sawPending: boolean;
}

/**
 * Starts a sign-in for one server and follows it. `wait` is set until the auth status shows a
 * new sign-in (success) or the pending sign-in is gone without one (the tab shows why).
 */
export function useSignIn(server: string, status: AuthStatus | undefined) {
  const client = useQueryClient();
  const { notify } = useToast();
  const [wait, setWait] = useState<SignInWait | undefined>();

  const start = useMutation({
    mutationFn: async (tab: Window | null) => {
      try {
        return { started: await api.post<SignInStartResponse>(AUTH_API_PATHS.login(server)), tab };
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    onSuccess: ({ started, tab }) => {
      if (tab) tab.location.replace(started.authorizationUrl);
      const before = client.getQueryData<AuthStatusResponse>(queryKeys.auth(server))?.status.signedInAt;
      setWait({
        ...(before ? { before } : {}),
        url: started.authorizationUrl,
        blocked: !tab,
        sawPending: false,
      });
      for (const warning of started.warnings) notify('info', `Sign-in to ${server}`, warning);
      void client.invalidateQueries({ queryKey: queryKeys.auth(server) });
    },
    onError: (error) => {
      const { message, problems } = describeError(error);
      notify('error', `Could not start the sign-in to ${server}`, [message, ...problems].join('\n'));
      void client.invalidateQueries({ queryKey: queryKeys.auth(server) });
    },
  });

  useEffect(() => {
    if (!wait || !status) return;
    if (status.signedIn && status.signedInAt !== wait.before) {
      setWait(undefined);
      notify('success', `Signed in to ${server}.`);
    } else if (status.pending && !wait.sawPending) {
      setWait({ ...wait, sawPending: true });
    } else if (!status.pending && wait.sawPending) {
      setWait(undefined);
      notify('error', `The sign-in to ${server} did not finish`, 'The sign-in tab shows the reason.');
    }
  }, [status, wait, server, notify]);

  return {
    /** Call from a click handler. */
    begin: useCallback(() => start.mutate(openSignInTab()), [start]),
    starting: start.isPending,
    wait,
    /** Stops waiting on this page (the pending sign-in expires on its own). */
    cancel: useCallback(() => setWait(undefined), []),
  };
}

/** Refresh now, sign out, and forget the registration, each with a toast. */
export function useAuthAction(server: string) {
  const client = useQueryClient();
  const { notify } = useToast();
  return useMutation({
    mutationFn: (action: 'refresh' | 'logout' | 'forget') =>
      api.post<AuthStatusResponse>(AUTH_API_PATHS[action](server)).then((response) => ({ action, response })),
    onSuccess: ({ action, response }) => {
      client.setQueryData<AuthStatusResponse>(queryKeys.auth(server), response);
      notify(
        'success',
        action === 'refresh'
          ? `Refreshed the sign-in to ${server}.`
          : action === 'logout'
            ? `Signed out of ${server}.`
            : `Signed out of ${server} and forgot its registration.`,
      );
    },
    onError: (error, action) => {
      const { message, problems } = describeError(error);
      const verb = action === 'refresh' ? 'refresh' : 'sign out of';
      notify('error', `Could not ${verb} ${server}`, [message, ...problems].join('\n'));
    },
  });
}
