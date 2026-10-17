import { existsSync } from 'node:fs';
import { effectivePort, loadConfig } from '@mcpier/core';
import {
  AUTH_API_PATHS,
  cimdDocument,
  defaultConfig,
  oauthRedirectUri,
  PENDING_SIGN_IN_TTL_SECONDS,
  type AuthListResponse,
  type AuthStatus,
  type AuthStatusResponse,
  type SignInStartResponse,
} from '@mcpier/shared';
import { connectApi, type Api } from '../api.js';
import { cliContext, formatUptime } from '../context.js';
import { CliError } from '../errors.js';
import { printJson, table } from '../format.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often `auth login` checks whether the sign-in finished. */
const LOGIN_POLL_MS = 500;

const METHOD_NAMES = {
  manual: 'manual client ID',
  cimd: 'client ID metadata document',
  dynamic: 'dynamic registration',
};

/** "in 59m 12s" or "3m 4s ago", for an ISO time. */
function relative(iso: string | undefined): string {
  if (!iso) return '';
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  return seconds >= 0 ? `in ${formatUptime(seconds)}` : `${formatUptime(-seconds)} ago`;
}

function statusWord(status: AuthStatus): string {
  if (status.signedIn) return 'signed in';
  if (status.reason === 'sign_in_expired') return 'sign-in expired';
  if (status.reason === 'more_permissions') return 'more permissions needed';
  if (status.reason === 'needs_client_id') return 'needs a client ID';
  return 'not signed in';
}

function printStatus(status: AuthStatus): void {
  const rows: [string, string][] = [['Status', statusWord(status)]];
  if (status.message) rows.push(['Reason', status.message]);
  if (status.issuer) rows.push(['Issuer', status.issuer]);
  if (status.registration) {
    rows.push(['Registration', METHOD_NAMES[status.registration.method]]);
    if (status.registration.clientId) rows.push(['Client ID', status.registration.clientId]);
  }
  rows.push(['Granted scopes', status.grantedScopes.length > 0 ? status.grantedScopes.join(' ') : '(none)']);
  if (status.requestedScopes?.length) rows.push(['Asked for', status.requestedScopes.join(' ')]);
  if (status.accessTokenExpiresAt) {
    rows.push(['Token expires', `${status.accessTokenExpiresAt} (${relative(status.accessTokenExpiresAt)})`]);
  }
  rows.push(['Refresh token', status.hasRefreshToken ? 'yes' : 'no']);
  if (status.lastRefreshAt)
    rows.push(['Last refresh', `${status.lastRefreshAt} (${relative(status.lastRefreshAt)})`]);
  if (status.signedInAt) rows.push(['Signed in', `${status.signedInAt} (${relative(status.signedInAt)})`]);
  if (status.pending) rows.push(['Sign-in waiting', `until ${status.pending.expiresAt}`]);
  console.log(status.server);
  for (const [label, value] of rows) console.log(`  ${`${label}:`.padEnd(17)}${value}`);
}

async function authStatusOf(api: Api, server: string): Promise<AuthStatus> {
  return (await api.request<AuthStatusResponse>('GET', AUTH_API_PATHS.status(server))).status;
}

/**
 * `mcpier auth login <server> [--print-url]`: starts a sign-in, opens the authorization page
 * in the default browser (or prints its URL), then waits up to 10 minutes for the sign-in to
 * finish. Ctrl+C stops waiting; the pending sign-in then expires on its own.
 */
export async function authLogin(
  server: string,
  options: { printUrl?: boolean; open?: (url: string) => Promise<void> } = {},
): Promise<number> {
  const api = await connectApi();
  const before = await authStatusOf(api, server);
  const started = await api.request<SignInStartResponse>('POST', AUTH_API_PATHS.login(server));
  for (const warning of started.warnings) console.error(`Warning: ${warning}`);
  if (options.printUrl) {
    console.log(started.authorizationUrl);
    console.error('This link starts your sign-in. Open it in a browser on this computer; do not share it.');
  } else {
    await (options.open ?? ((url: string) => cliContext().platform.openUrl(url)))(started.authorizationUrl);
    console.log(`Opened the sign-in page for ${server} in your browser.`);
  }
  console.log(
    `Waiting for the sign-in to finish (up to ${PENDING_SIGN_IN_TTL_SECONDS / 60} minutes; Ctrl+C stops waiting)…`,
  );

  const deadline = Date.parse(started.expiresAt);
  for (;;) {
    await sleep(LOGIN_POLL_MS);
    const now = await authStatusOf(api, server);
    if (now.signedIn && now.signedInAt !== before.signedInAt) {
      console.log(`Signed in to ${server}.`);
      const scopes = now.grantedScopes.length > 0 ? ` Scopes: ${now.grantedScopes.join(' ')}.` : '';
      const expiry = now.accessTokenExpiresAt
        ? ` The access token expires ${relative(now.accessTokenExpiresAt)}.`
        : '';
      console.log(`${scopes}${expiry}`.trim() || 'The server is connecting now.');
      return 0;
    }
    if (!now.pending) {
      // The browser came back, but the sign-in did not succeed (the page there says why).
      throw new CliError(`The sign-in to ${server} did not finish. ${now.message ?? ''}`.trim(), {
        hint: `The browser tab shows the reason. Try again with: mcpier auth login ${server}`,
      });
    }
    if (Date.now() > deadline) {
      throw new CliError(
        `The sign-in to ${server} was not finished within ${PENDING_SIGN_IN_TTL_SECONDS / 60} minutes.`,
        {
          hint: `Start it again with: mcpier auth login ${server}`,
        },
      );
    }
  }
}

/** `mcpier auth status [server] [--json]` */
export async function authStatus(server: string | undefined, options: { json?: boolean }): Promise<number> {
  const api = await connectApi();
  if (server) {
    const status = await authStatusOf(api, server);
    if (options.json) printJson(status);
    else printStatus(status);
    return 0;
  }
  const { servers } = await api.request<AuthListResponse>('GET', AUTH_API_PATHS.list);
  if (options.json) {
    printJson(servers);
    return 0;
  }
  if (servers.length === 0) {
    console.log('No server uses OAuth. Add one with: mcpier server add <name> --url <url> --oauth');
    return 0;
  }
  console.log(
    table(
      ['SERVER', 'STATUS', 'REGISTRATION', 'TOKEN EXPIRES', 'SCOPES'],
      servers.map((status) => [
        status.server,
        statusWord(status),
        status.registration?.method ?? '',
        status.accessTokenExpiresAt ? relative(status.accessTokenExpiresAt) : '',
        status.grantedScopes.join(' '),
      ]),
    ),
  );
  return 0;
}

/** `mcpier auth refresh <server>` */
export async function authRefresh(server: string): Promise<number> {
  const api = await connectApi();
  const { status } = await api.request<AuthStatusResponse>('POST', AUTH_API_PATHS.refresh(server));
  if (status.accessTokenExpiresAt) {
    console.log(
      `Refreshed ${server}: the access token now expires at ${status.accessTokenExpiresAt} (${relative(status.accessTokenExpiresAt)}).`,
    );
  } else {
    console.log(`Refreshed ${server}: the server did not say when the new access token expires.`);
  }
  return 0;
}

/** `mcpier auth logout <server> [--forget-client]` */
export async function authLogout(server: string, options: { forgetClient?: boolean }): Promise<number> {
  const api = await connectApi();
  const path = options.forgetClient ? AUTH_API_PATHS.forget(server) : AUTH_API_PATHS.logout(server);
  await api.request<AuthStatusResponse>('POST', path);
  console.log(
    options.forgetClient
      ? `Signed out of ${server} and forgot its registration; the next sign-in registers MCPier again.`
      : `Signed out of ${server}. Sign in again with: mcpier auth login ${server}`,
  );
  return 0;
}

/**
 * `mcpier auth cimd-document`: the client ID metadata document for the current `cimdUrl`
 * setting and port, worked out from config.json (no gateway needed). Standard output carries
 * the JSON only, so it can be redirected to a file; where to publish it goes to standard error.
 */
export async function authCimdDocument(): Promise<number> {
  const { paths } = cliContext();
  const config = existsSync(paths.config) ? await loadConfig(paths.config) : defaultConfig();
  const url = config.settings.cimdUrl;
  if (!url) {
    throw new CliError('The "cimdUrl" setting is not set, so there is no client ID metadata document yet.', {
      hint:
        'Choose the https:// address where you will publish it, set it on the Settings page of the dashboard ' +
        '(or "settings": { "cimdUrl": "…" } in config.json), then run this again.',
    });
  }
  const port = effectivePort(config);
  printJson(cimdDocument(url, port));
  console.error(
    `Publish this JSON at ${url} (served as application/json over https). Its redirect URI, ${oauthRedirectUri(port)}, ` +
      'uses the current port: publish it again if the port changes.',
  );
  return 0;
}
