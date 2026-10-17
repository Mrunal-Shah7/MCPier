// OAuth for remote servers (Sprint 5): the loopback redirect, the Client ID Metadata Document,
// and the auth-status shapes shared by the gateway, the CLI and the dashboard. Nothing here
// ever carries a token, a code, a PKCE verifier, a `state` value or a client secret.

/** The gateway's own OAuth callback: public, outside /api, behind the Host and Origin checks. */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/** The callback page's stylesheet (static CSS; the page has no script). */
export const OAUTH_STYLE_PATH = '/oauth/callback.css';

/** The client name MCPier registers with and publishes in its CIMD. */
export const OAUTH_CLIENT_NAME = 'MCPier';

/** How long a started sign-in waits for the browser to come back. */
export const PENDING_SIGN_IN_TTL_SECONDS = 600;

/**
 * The loopback redirect URI for a port. Always the host name `127.0.0.1`: the dashboard cookie
 * and the Host check rely on it, and `localhost` is a different site to a browser.
 */
export function oauthRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
}

/** How MCPier got its client ID for a server. */
export const REGISTRATION_METHODS = ['manual', 'cimd', 'dynamic'] as const;
export type RegistrationMethod = (typeof REGISTRATION_METHODS)[number];

/** The Client ID Metadata Document MCPier asks the user to publish at `settings.cimdUrl`. */
export interface ClientIdMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  application_type: 'native';
}

/**
 * The CIMD for a `cimdUrl` and port: MCPier as a native public client (no client
 * authentication) with the loopback redirect, using the authorization-code grant with refresh.
 */
export function cimdDocument(cimdUrl: string, port: number): ClientIdMetadataDocument {
  return {
    client_id: cimdUrl,
    client_name: OAUTH_CLIENT_NAME,
    redirect_uris: [oauthRedirectUri(port)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
}

/** Why an OAuth server is not signed in. */
export const NEEDS_AUTH_REASONS = [
  /** No tokens: the user has never signed in, or signed out. */
  'sign_in_required',
  /** The refresh failed because the grant is invalid or revoked: the tokens were deleted. */
  'sign_in_expired',
  /** The server answered 403 `insufficient_scope`: the next sign-in asks for more. */
  'more_permissions',
  /** No registration is possible and no client ID is configured. */
  'needs_client_id',
] as const;
export type NeedsAuthReason = (typeof NEEDS_AUTH_REASONS)[number];

/**
 * The status detail of a `needs_auth` server, for each reason. The step-up scopes come from
 * the server's `WWW-Authenticate` header and are shown as given (already filtered to scope
 * characters by the gateway).
 */
export function needsAuthDetail(reason: NeedsAuthReason, scopes: readonly string[] = []): string {
  switch (reason) {
    case 'sign_in_required':
      return 'Sign in required';
    case 'sign_in_expired':
      return 'Sign-in expired; sign in again';
    case 'more_permissions':
      return `More permissions needed${scopes.length > 0 ? ` (${scopes.join(' ')})` : ''}; sign in again`;
    case 'needs_client_id':
      return (
        'This server needs a client ID: its authorization server offers no automatic registration. ' +
        'Enter one on the server page (Edit, Advanced, OAuth client) or in config.json ("oauth": { "clientId": "…" })'
      );
  }
}

/** What one OAuth server's sign-in looks like. Never carries a token or secret value. */
export interface AuthStatus {
  server: string;
  signedIn: boolean;
  /** Set when not signed in. */
  reason?: NeedsAuthReason;
  /** A readable sentence for the reason, with where to sign in. */
  message?: string;
  /** The authorization server's issuer identifier. */
  issuer?: string;
  registration?: { method: RegistrationMethod; clientId?: string; redirectUri?: string };
  /** Scopes the current tokens were granted (space-split). */
  grantedScopes: string[];
  /** Scopes the server asked for in a 403 `insufficient_scope` (step-up). */
  requestedScopes?: string[];
  /** When the access token expires (ISO 8601), if the server said. */
  accessTokenExpiresAt?: string;
  /** Whether a refresh token is held (its value never leaves the gateway). */
  hasRefreshToken: boolean;
  /** Last successful refresh (ISO 8601). */
  lastRefreshAt?: string;
  /** Last successful sign-in (ISO 8601). */
  signedInAt?: string;
  /** A sign-in started and waiting for the browser. */
  pending?: { expiresAt: string };
}

/** Admin API routes for OAuth (token or cookie required). */
export const AUTH_API_PATHS = {
  /** `GET`: every OAuth server's `AuthStatus`. */
  list: '/api/auth',
  /** `GET`: the CIMD for the current `cimdUrl` and port (409 when `cimdUrl` is not set). */
  cimdDocument: '/api/auth/cimd-document',
  /** `GET`: one server's `AuthStatus`. */
  status: (name: string) => `/api/servers/${encodeURIComponent(name)}/auth`,
  /** `POST`: start a sign-in; answers with the authorization URL. */
  login: (name: string) => `/api/servers/${encodeURIComponent(name)}/auth/login`,
  /** `POST`: refresh the access token now. */
  refresh: (name: string) => `/api/servers/${encodeURIComponent(name)}/auth/refresh`,
  /** `POST`: revoke (best effort) and delete the tokens. */
  logout: (name: string) => `/api/servers/${encodeURIComponent(name)}/auth/logout`,
  /** `POST`: sign out, then delete the stored registration too. */
  forget: (name: string) => `/api/servers/${encodeURIComponent(name)}/auth/forget`,
} as const;

/** `GET /api/auth` */
export interface AuthListResponse {
  servers: AuthStatus[];
}

/** `GET /api/servers/:name/auth`, and the answer of refresh, logout and forget. */
export interface AuthStatusResponse {
  status: AuthStatus;
}

/** `POST /api/servers/:name/auth/login` */
export interface SignInStartResponse {
  /**
   * Open this in a browser. It is the authorization server's own request URL: it carries the
   * sign-in's `state` and PKCE challenge, so it is not to be shared or logged.
   */
  authorizationUrl: string;
  /** When the pending sign-in expires (ISO 8601). */
  expiresAt: string;
  issuer: string;
  registrationMethod: RegistrationMethod;
  /** Scopes requested, space-split. */
  scopes: string[];
  /** Things the user should know, such as a redirect URI that changed with the port. */
  warnings: string[];
}

/** `GET /api/auth/cimd-document` */
export interface CimdDocumentResponse {
  /** Where the document must be published (the `cimdUrl` setting). */
  url: string;
  redirectUri: string;
  document: ClientIdMetadataDocument;
}

/** What the connection test found for an unsaved OAuth entry (discovery only, no sign-in). */
export interface OAuthDiscoveryResult {
  /** The protected-resource metadata (RFC 9728) was found. */
  protectedResourceMetadata: boolean;
  resourceMetadataUrl?: string;
  /** The authorization server named by that metadata (or the server's origin). */
  authorizationServer?: string;
  /** Its metadata (RFC 8414 or OpenID Connect) was found. */
  authorizationServerMetadata: boolean;
  issuer?: string;
  /** The registration method a sign-in would use, if any applies. */
  registrationMethod?: RegistrationMethod;
  /** Why no method applies, or a remark about the one chosen. */
  note?: string;
  scopesSupported?: string[];
}

/** Space-split scopes, without empties or duplicates, in first-seen order. */
export function splitScopes(...values: (string | readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const parts = typeof value === 'string' ? value.split(/\s+/) : (value ?? []);
    for (const part of parts) if (part) seen.add(part);
  }
  return [...seen];
}
