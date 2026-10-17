import { EventEmitter } from 'node:events';
import {
  assertSecureTokenEndpoint,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  InsufficientScopeError,
  IssuerMismatchError,
  OAuthError,
  refreshAuthorization,
  registerClient,
  RegistrationRejectedError,
  resourceUrlFromServerUrl,
  SdkError,
  SdkErrorCode,
  selectClientAuthMethod,
  startAuthorization,
  validateAuthorizationResponseIssuer,
  type AuthorizationServerMetadata,
  type AuthProvider,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import {
  needsAuthDetail,
  oauthRedirectUri,
  OAUTH_CLIENT_NAME,
  secretRefName,
  splitScopes,
  type AuthStatus,
  type HttpServerEntry,
  type McpierConfig,
  type NeedsAuthReason,
  type OAuthDiscoveryResult,
  type RegistrationMethod,
  type ServerEntry,
  type Settings,
  type SignInStartResponse,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { SecretStore } from '../platform/index.js';
import { isNetworkError } from '../upstream/client.js';
import { NeedsAuthError } from '../upstream/types.js';
import { projectVersion } from '../version.js';
import { newSignInState, PendingSignIns, type PendingSignIn } from './pending.js';
import type { OAuthRecord, OAuthStore, StoredRegistration, StoredTokens } from './store.js';

/** Refresh when less than this much of the access token's life remains. */
export const DEFAULT_REFRESH_MARGIN_MS = 60_000;

/** Time limit for each request to an authorization server (and the sign-in probe). */
const AS_TIMEOUT_MS = 15_000;
/** Time limit for the best-effort revocation on sign-out. */
const REVOKE_TIMEOUT_MS = 5_000;
/** Longest piece of authorization-server text shown to the user. */
const REMOTE_TEXT_MAX = 300;

/** Why a sign-in operation could not be done. `message` is meant for the user, as is. */
export type OAuthFlowCode =
  | 'not_oauth'
  | 'unreachable'
  | 'no_metadata'
  | 'bad_metadata'
  | 'registration_refused'
  | 'needs_client_id'
  | 'missing_secret'
  | 'not_signed_in'
  | 'no_refresh_token'
  | 'refresh_failed'
  | 'sign_in_expired';

export class OAuthFlowError extends Error {
  constructor(
    readonly code: OAuthFlowCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }

  /** HTTP status for the admin API. */
  get httpStatus(): 409 | 502 {
    return ['unreachable', 'no_metadata', 'bad_metadata', 'registration_refused', 'refresh_failed'].includes(
      this.code,
    )
      ? 502
      : 409;
  }
}

/** A refresh could not reach the authorization server (or it failed on its side): an outage. */
export class RefreshUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshUnavailableError';
  }
}

/** What happened with a callback, for the result page. */
export type CallbackOutcome =
  { ok: true; server: string } | { ok: false; server?: string; reason: string; next: string };

/** What the HTTP connector of an OAuth server gets from the service. */
export interface ConnectorAuth {
  authProvider: AuthProvider;
  /** Wraps the transport's fetch to remember which token each 401 rejected. */
  fetch: FetchLike;
  /**
   * Turns an error from a request into `NeedsAuthError` when it means signing in (again), with
   * the side effects: step-up scopes recorded, an unusable sign-in dropped. Anything else
   * gives undefined.
   */
  classify(error: unknown): Promise<NeedsAuthError | undefined>;
}

export type OAuthChange = 'signed_in' | 'signed_out' | 'refreshed' | 'needs_auth' | 'pending';

export interface OAuthServiceEvents {
  /** A server's sign-in changed; `status` carries no values. */
  changed: [server: string, change: OAuthChange, status: AuthStatus];
}

export interface OAuthServiceOptions {
  store: OAuthStore;
  /** The user's secrets (a manual client's secret is a reference). */
  secrets: SecretStore;
  logger: Logger;
  /** The effective port: the redirect URI is `http://127.0.0.1:<port>/oauth/callback`. */
  port: number;
  /** The current config. */
  config: () => McpierConfig;
  now?: () => number;
  refreshMarginMs?: number;
  /** Replaces `fetch` for every request to authorization servers and the probe (tests). */
  fetch?: FetchLike;
}

interface DiscoveryInfo {
  serverUrl: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: OAuthProtectedResourceMetadata;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  issuer: string;
  resource: string;
  /** The `scope` of the server's 401 challenge, if it gave one. */
  challengeScope?: string;
}

interface ClientChoice {
  method: RegistrationMethod;
  client: { clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: string };
  /** A registration to save once the sign-in succeeds. */
  newRegistration?: StoredRegistration;
  warnings: string[];
}

/** Printable text from an authorization server, without control characters, cut short. */
function cleanRemoteText(text: unknown, redact: (value: string) => string): string {
  // Control characters (C0, DEL and C1) become spaces, by code point rather than a regex range.
  const flat = [...String(text ?? '')]
    .map((char) => {
      const code = char.codePointAt(0)!;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = redact(flat);
  return safe.length > REMOTE_TEXT_MAX ? `${safe.slice(0, REMOTE_TEXT_MAX - 1)}…` : safe;
}

/** An OAuth error code: letters, digits and underscores only. */
function cleanErrorCode(code: unknown): string {
  const value = String(code ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 64);
  return value || 'error';
}

/** Scope tokens from an untrusted header: scope characters only, a few of them, short. */
function cleanScopes(scope: string | undefined): string[] {
  return splitScopes(scope)
    .filter((token) => /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(token))
    .slice(0, 20);
}

function isAccessDeniedGrant(error: unknown): boolean {
  return (
    error instanceof OAuthError &&
    ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)
  );
}

/** The first error in a cause chain that matches. */
function findInChain<T>(error: unknown, test: (value: unknown) => value is T): T | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (test(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isOAuthEntry(entry: ServerEntry | undefined): entry is HttpServerEntry {
  return entry?.transport === 'http' && entry.auth === 'oauth';
}

/**
 * MCPier as the OAuth client of its remote servers (SPEC 7.1): discovery, registration (a
 * manual client, a client ID metadata document, or dynamic registration), the authorization
 * code flow with PKCE and the loopback callback, token storage, refresh (before expiry and
 * on a 401, one at a time per server), step-up, sign-out with revocation, and forgetting a
 * registration. Built on the SDK's low-level auth helpers; see the Sprint 5 notes for why not
 * on `auth()`. No token, code, verifier, `state` or secret is ever logged or returned.
 */
export class OAuthService extends EventEmitter<OAuthServiceEvents> {
  readonly pending: PendingSignIns;
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Problems that live in memory only (a missing client ID shows until the next attempt). */
  private readonly transientProblems = new Map<string, NeedsAuthReason>();
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: OAuthServiceOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.pending = new PendingSignIns(this.now);
    const base = options.fetch ?? fetch;
    // Every authorization-server request has a time limit, unless the caller set a signal.
    this.fetchFn = async (url, init) => {
      const response = await base(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(AS_TIMEOUT_MS),
      });
      // @hono/node-server replaces the global Response once a server exists, so fetch's own
      // responses fail the SDK's `instanceof Response` in parseErrorResponse, and every OAuth
      // error would read as "server_error" (Sprint 5 BUGS B-2). Re-wrap in the current class.
      if (response instanceof Response) return response;
      const foreign = response as unknown as Response;
      return new Response(foreign.body, {
        status: foreign.status,
        statusText: foreign.statusText,
        headers: foreign.headers,
      });
    };
  }

  get redirectUri(): string {
    return oauthRedirectUri(this.options.port);
  }

  private get settings(): Settings {
    return this.options.config().settings;
  }

  private entry(name: string): HttpServerEntry {
    const entry = this.options.config().servers.find((server) => server.name === name);
    if (!entry) throw new OAuthFlowError('not_oauth', `No server named "${name}".`);
    if (!isOAuthEntry(entry)) {
      throw new OAuthFlowError(
        'not_oauth',
        `Server "${name}" does not use OAuth ("auth" is not "oauth"), so there is nothing to sign in to.`,
      );
    }
    return entry;
  }

  /** The stored record, if it still belongs to this entry's URL (otherwise it is deleted). */
  private async record(entry: HttpServerEntry): Promise<OAuthRecord | undefined> {
    const record = await this.options.store.load(entry.name);
    if (record && record.serverUrl !== entry.url) {
      await this.options.store.remove(entry.name);
      this.options.logger.info({ server: entry.name }, 'OAuth sign-in dropped: the server URL changed');
      return undefined;
    }
    return record;
  }

  // ---- Status

  /** One server's sign-in, with no values. */
  async status(name: string): Promise<AuthStatus> {
    const entry = this.entry(name);
    const record = await this.record(entry);
    const pending = this.pending.forServer(name);
    const tokens = record?.tokens;
    const reason = this.reasonOf(entry, record);
    const status: AuthStatus = {
      server: name,
      signedIn: reason === undefined,
      grantedScopes: tokens ? [...(record?.grantedScopes ?? [])] : [],
      hasRefreshToken: Boolean(tokens?.refreshToken),
    };
    if (reason) {
      status.reason = reason;
      status.message = `${needsAuthDetail(reason, record?.stepUpScopes)}. Sign in on the server page in the MCPier dashboard, or with: mcpier auth login ${name}`;
    }
    if (record?.issuer) status.issuer = record.issuer;
    const registration = record?.registration;
    if (registration) {
      status.registration = {
        method: registration.method,
        clientId: registration.clientId,
        redirectUri: registration.redirectUri,
      };
    } else if (entry.oauth?.clientId) {
      status.registration = { method: 'manual', clientId: entry.oauth.clientId };
    }
    if (record?.stepUpScopes?.length) status.requestedScopes = [...record.stepUpScopes];
    if (tokens?.expiresAt !== undefined)
      status.accessTokenExpiresAt = new Date(tokens.expiresAt).toISOString();
    if (tokens && record?.lastRefreshAt) status.lastRefreshAt = record.lastRefreshAt;
    if (tokens && record?.signedInAt) status.signedInAt = record.signedInAt;
    if (pending) status.pending = { expiresAt: new Date(pending.expiresAt).toISOString() };
    return status;
  }

  /** Every OAuth server's status. */
  async statuses(): Promise<AuthStatus[]> {
    const names = this.options
      .config()
      .servers.filter(isOAuthEntry)
      .map((entry) => entry.name)
      .sort();
    return Promise.all(names.map((name) => this.status(name)));
  }

  private reasonOf(entry: HttpServerEntry, record: OAuthRecord | undefined): NeedsAuthReason | undefined {
    if (!record?.tokens) {
      const transient = this.transientProblems.get(entry.name);
      if (transient) return transient;
      return record?.problem === 'sign_in_expired' ? 'sign_in_expired' : 'sign_in_required';
    }
    if (record.problem === 'more_permissions') return 'more_permissions';
    return undefined;
  }

  /**
   * Whether a server may connect now. No tokens (or a pending step-up) means `needs_auth`,
   * decided from the store alone: no network call.
   */
  async connectState(entry: HttpServerEntry): Promise<{ ok: true } | { ok: false; error: NeedsAuthError }> {
    const record = await this.record(entry);
    const reason = this.reasonOf(entry, record);
    if (reason === undefined) return { ok: true };
    return { ok: false, error: new NeedsAuthError(reason, needsAuthDetail(reason, record?.stepUpScopes)) };
  }

  private async announce(name: string, change: OAuthChange): Promise<void> {
    if (!isOAuthEntry(this.options.config().servers.find((server) => server.name === name))) return;
    try {
      this.emit('changed', name, change, await this.status(name));
    } catch (error) {
      this.options.logger.warn(
        { server: name, err: { message: (error as Error).message } },
        'OAuth status unavailable',
      );
    }
  }

  // ---- Discovery and registration

  /**
   * An unauthenticated request to the server, for its `WWW-Authenticate` challenge (the
   * resource metadata URL and the scope). A server that does not answer 401 just gives no hint.
   */
  private async probe(entry: HttpServerEntry): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    let response: Response;
    try {
      response = await this.fetchFn(entry.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'server/discover',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'mcpier-oauth-probe',
          method: 'server/discover',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
        }),
      });
    } catch (error) {
      throw new OAuthFlowError('unreachable', `Cannot reach ${entry.url}: ${(error as Error).message}`);
    }
    await response.body?.cancel().catch(() => {});
    if (response.status !== 401 && response.status !== 403) return {};
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
  }

  /** Protected-resource metadata (from the challenge, else well-known), then the AS metadata. */
  private async discover(entry: HttpServerEntry): Promise<DiscoveryInfo> {
    const hint = await this.probe(entry);
    let info;
    try {
      info = await discoverOAuthServerInfo(entry.url, {
        ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}),
        fetchFn: this.fetchFn,
      });
    } catch (error) {
      if (error instanceof IssuerMismatchError) {
        throw new OAuthFlowError(
          'bad_metadata',
          "The authorization server's metadata names a different issuer than its own address, so it was not trusted.",
        );
      }
      if (error instanceof TypeError || isNetworkError(error)) {
        throw new OAuthFlowError(
          'unreachable',
          `Cannot reach the authorization server: ${(error as Error).message}`,
        );
      }
      throw new OAuthFlowError(
        'bad_metadata',
        `The authorization server's metadata could not be read: ${cleanRemoteText((error as Error).message, (text) => text)}`,
      );
    }
    if (!info.authorizationServerMetadata) {
      throw new OAuthFlowError(
        'no_metadata',
        `No authorization server metadata was found at ${info.authorizationServerUrl} ` +
          `(tried OAuth 2.0 and OpenID Connect discovery)` +
          (info.resourceMetadata ? '.' : ', and the server publishes no protected-resource metadata.'),
      );
    }
    const defaultResource = resourceUrlFromServerUrl(entry.url);
    let resource = defaultResource.href;
    if (info.resourceMetadata) {
      if (
        !checkResourceAllowed({
          requestedResource: defaultResource,
          configuredResource: info.resourceMetadata.resource,
        })
      ) {
        throw new OAuthFlowError(
          'bad_metadata',
          `The server's protected-resource metadata is for a different resource (${cleanRemoteText(info.resourceMetadata.resource, (text) => text)}), not ${entry.url}.`,
        );
      }
      // Sent as written in the metadata (the SDK does the same).
      resource = info.resourceMetadata.resource;
    }
    return {
      serverUrl: entry.url,
      ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl.href } : {}),
      ...(info.resourceMetadata ? { resourceMetadata: info.resourceMetadata } : {}),
      authorizationServerUrl: String(info.authorizationServerUrl),
      metadata: info.authorizationServerMetadata,
      issuer: info.authorizationServerMetadata.issuer,
      resource,
      ...(hint.scope ? { challengeScope: hint.scope } : {}),
    };
  }

  /** The manual client's secret, resolved from its reference. */
  private async manualSecret(entry: HttpServerEntry): Promise<string | undefined> {
    const reference = entry.oauth?.clientSecret;
    if (reference === undefined) return undefined;
    const name = secretRefName(reference, 'env');
    const value = name ? await this.options.secrets.get(name) : undefined;
    if (value === undefined) {
      throw new OAuthFlowError(
        'missing_secret',
        `The client secret "${name ?? reference}" is not set. Set it with: mcpier secret set ${name ?? '<name>'}`,
      );
    }
    return value;
  }

  private dynamicClientMetadata() {
    return {
      client_name: OAUTH_CLIENT_NAME,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // A loopback redirect is only accepted from a native application (RFC 8252).
      application_type: 'native',
      software_id: 'mcpier',
      software_version: projectVersion(),
    };
  }

  /** Which method a sign-in would use, without registering (the connection test). */
  private plannedMethod(
    entry: HttpServerEntry,
    metadata: AuthorizationServerMetadata,
  ): RegistrationMethod | undefined {
    if (entry.oauth?.clientId) return 'manual';
    if (this.settings.cimdUrl && metadata.client_id_metadata_document_supported === true) return 'cimd';
    if (metadata.registration_endpoint) return 'dynamic';
    return undefined;
  }

  private needsClientId(entry: HttpServerEntry): OAuthFlowError {
    return new OAuthFlowError(
      'needs_client_id',
      `The authorization server of "${entry.name}" offers no automatic registration, and no client ID is configured. ` +
        `Create an OAuth client in the provider's console with the redirect URI ${this.redirectUri}, then enter its client ID ` +
        `on the server page in the MCPier dashboard (Edit, Advanced, OAuth client), or set "oauth": { "clientId": "…" } in config.json.`,
    );
  }

  /** Registration order: manual client, CIMD (setting set and supported), dynamic, else none. */
  private async chooseClient(
    entry: HttpServerEntry,
    info: DiscoveryInfo,
    record: OAuthRecord | undefined,
    scope: string | undefined,
  ): Promise<ClientChoice> {
    const redirectUri = this.redirectUri;
    const warnings: string[] = [];
    const registration = record?.registration;
    const boundHere = registration !== undefined && registration.issuer === info.issuer;

    if (entry.oauth?.clientId) {
      if (registration?.method === 'manual' && registration.redirectUri !== redirectUri) {
        warnings.push(
          `The redirect URI changed from ${registration.redirectUri} to ${redirectUri} (the port changed). ` +
            `Add the new one to the OAuth client "${entry.oauth.clientId}" in the provider's console, or the sign-in will be refused.`,
        );
      }
      const clientSecret = await this.manualSecret(entry);
      return {
        method: 'manual',
        client: { clientId: entry.oauth.clientId, ...(clientSecret !== undefined ? { clientSecret } : {}) },
        newRegistration: {
          method: 'manual',
          clientId: entry.oauth.clientId,
          redirectUri,
          issuer: info.issuer,
          registeredAt: new Date(this.now()).toISOString(),
        },
        warnings,
      };
    }

    const cimdUrl = this.settings.cimdUrl;
    const cimdSupported = info.metadata.client_id_metadata_document_supported === true;
    if (cimdUrl && cimdSupported) {
      if (
        boundHere &&
        registration.method === 'cimd' &&
        registration.clientId === cimdUrl &&
        registration.redirectUri !== redirectUri
      ) {
        warnings.push(
          `The redirect URI changed from ${registration.redirectUri} to ${redirectUri} (the port changed). ` +
            `Publish the new client ID metadata document (mcpier auth cimd-document) at ${cimdUrl}, or the sign-in will be refused.`,
        );
      }
      return {
        method: 'cimd',
        client: { clientId: cimdUrl },
        newRegistration: {
          method: 'cimd',
          clientId: cimdUrl,
          redirectUri,
          issuer: info.issuer,
          registeredAt: new Date(this.now()).toISOString(),
        },
        warnings,
      };
    }

    // A dynamic registration is reused only for the same issuer and redirect URI.
    if (boundHere && registration.method === 'dynamic' && registration.redirectUri === redirectUri) {
      return {
        method: 'dynamic',
        client: {
          clientId: registration.clientId,
          ...(registration.clientSecret !== undefined ? { clientSecret: registration.clientSecret } : {}),
          ...(registration.tokenEndpointAuthMethod
            ? { tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod }
            : {}),
        },
        warnings,
      };
    }

    if (!info.metadata.registration_endpoint) throw this.needsClientId(entry);
    if (registration?.method === 'dynamic' && boundHere) {
      warnings.push(
        `Registered again: the redirect URI changed from ${registration.redirectUri} to ${redirectUri}.`,
      );
    }
    let registered;
    try {
      registered = await registerClient(info.authorizationServerUrl, {
        metadata: info.metadata,
        clientMetadata: this.dynamicClientMetadata(),
        ...(scope ? { scope } : {}),
        fetchFn: this.fetchFn,
      });
    } catch (error) {
      if (error instanceof RegistrationRejectedError) {
        let described = '';
        try {
          const body = JSON.parse(error.body) as { error?: unknown; error_description?: unknown };
          const code = body.error ? cleanErrorCode(body.error) : '';
          const text = body.error_description
            ? cleanRemoteText(body.error_description, (value) => value)
            : '';
          described = [code, text].filter(Boolean).join(': ');
        } catch {
          // Not JSON: the status alone is shown.
        }
        throw new OAuthFlowError(
          'registration_refused',
          `The authorization server refused to register MCPier (HTTP ${error.status})${described ? `: ${described}` : '.'}`,
        );
      }
      if (error instanceof TypeError || isNetworkError(error)) {
        throw new OAuthFlowError(
          'unreachable',
          `Cannot reach the authorization server to register: ${(error as Error).message}`,
        );
      }
      throw new OAuthFlowError(
        'registration_refused',
        `Registering with the authorization server failed: ${cleanRemoteText((error as Error).message, (value) => value)}`,
      );
    }
    this.options.logger.info(
      { server: entry.name, issuer: info.issuer },
      'Registered MCPier with the authorization server',
    );
    // RFC 7592 management fields are not in the SDK's type; they are kept if the server sent them.
    const management = registered as unknown as Record<string, unknown>;
    const newRegistration: StoredRegistration = {
      method: 'dynamic',
      clientId: registered.client_id,
      ...(registered.client_secret !== undefined ? { clientSecret: registered.client_secret } : {}),
      ...(registered.client_secret_expires_at !== undefined
        ? { clientSecretExpiresAt: registered.client_secret_expires_at }
        : {}),
      ...(registered.token_endpoint_auth_method
        ? { tokenEndpointAuthMethod: registered.token_endpoint_auth_method }
        : {}),
      ...(typeof management.registration_access_token === 'string'
        ? { registrationAccessToken: management.registration_access_token }
        : {}),
      ...(typeof management.registration_client_uri === 'string'
        ? { registrationClientUri: management.registration_client_uri }
        : {}),
      redirectUri,
      issuer: info.issuer,
      registeredAt: new Date(this.now()).toISOString(),
    };
    return {
      method: 'dynamic',
      client: {
        clientId: newRegistration.clientId,
        ...(newRegistration.clientSecret !== undefined ? { clientSecret: newRegistration.clientSecret } : {}),
        ...(newRegistration.tokenEndpointAuthMethod
          ? { tokenEndpointAuthMethod: newRegistration.tokenEndpointAuthMethod }
          : {}),
      },
      newRegistration,
      warnings,
    };
  }

  /** Scopes to ask for: the challenge's (or the resource's), configured extras, granted, step-up. */
  private scopesFor(entry: HttpServerEntry, info: DiscoveryInfo, record: OAuthRecord | undefined): string[] {
    const base = info.challengeScope ?? info.resourceMetadata?.scopes_supported;
    const scopes = splitScopes(base, entry.oauth?.scopes, record?.grantedScopes, record?.stepUpScopes);
    // OpenID-style servers issue refresh tokens only for offline_access (the SDK's own rule).
    if (
      scopes.length > 0 &&
      info.metadata.scopes_supported?.includes('offline_access') &&
      !scopes.includes('offline_access')
    ) {
      scopes.push('offline_access');
    }
    return scopes;
  }

  /** Discovery only, for the connection test of an unsaved entry: no registration, no sign-in. */
  async discoverOnly(entry: HttpServerEntry): Promise<OAuthDiscoveryResult> {
    const hint = await this.probe(entry).catch(() => ({}) as { resourceMetadataUrl?: URL });
    const result: OAuthDiscoveryResult = {
      protectedResourceMetadata: false,
      authorizationServerMetadata: false,
    };
    let info;
    try {
      info = await this.discover(entry);
    } catch (error) {
      if (hint.resourceMetadataUrl) result.resourceMetadataUrl = hint.resourceMetadataUrl.href;
      result.note = error instanceof OAuthFlowError ? error.message : String((error as Error).message);
      return result;
    }
    result.protectedResourceMetadata = info.resourceMetadata !== undefined;
    if (info.resourceMetadataUrl) result.resourceMetadataUrl = info.resourceMetadataUrl;
    result.authorizationServer = info.authorizationServerUrl;
    result.authorizationServerMetadata = true;
    result.issuer = info.issuer;
    const scopes = info.resourceMetadata?.scopes_supported ?? info.metadata.scopes_supported;
    if (scopes?.length) result.scopesSupported = [...scopes];
    const method = this.plannedMethod(entry, info.metadata);
    if (method) result.registrationMethod = method;
    else result.note = this.needsClientId(entry).message;
    return result;
  }

  // ---- Sign-in

  /**
   * Starts a sign-in: discovery, registration if needed, then a pending sign-in and the
   * authorization URL (PKCE S256, `state`, `resource`, scopes). Opens nothing: the caller
   * shows or opens the URL. A second start for the same server replaces the first.
   */
  async startSignIn(name: string): Promise<SignInStartResponse> {
    const entry = this.entry(name);
    try {
      const info = await this.discover(entry);
      let record = await this.record(entry);
      if (record?.issuer && record.issuer !== info.issuer) {
        // Credentials are bound to the authorization server that issued them.
        this.options.logger.info({ server: name }, 'The authorization server changed; registering again');
        await this.options.store.remove(name);
        record = undefined;
      }
      const scopes = this.scopesFor(entry, info, record);
      const scope = scopes.length > 0 ? scopes.join(' ') : undefined;
      const choice = await this.chooseClient(entry, info, record, scope);

      // A first registration is kept at once (so a retried sign-in does not register again);
      // one that replaces a registration with live tokens waits for the sign-in to succeed.
      let newRegistration = choice.newRegistration;
      if (newRegistration && newRegistration.method === 'dynamic' && !record?.tokens) {
        await this.options.store.update(name, (current) => ({
          ...(current ?? { server: name, serverUrl: entry.url }),
          serverUrl: entry.url,
          issuer: info.issuer,
          authorizationServerUrl: info.authorizationServerUrl,
          authorizationServerMetadata: info.metadata,
          resource: info.resource,
          ...(info.resourceMetadataUrl ? { resourceMetadataUrl: info.resourceMetadataUrl } : {}),
          registration: newRegistration!,
        }));
        newRegistration = undefined;
      }

      const state = newSignInState();
      const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
        metadata: info.metadata,
        clientInformation: { client_id: choice.client.clientId },
        redirectUrl: this.redirectUri,
        ...(scope ? { scope } : {}),
        state,
        resource: info.resource,
      }).catch((error: unknown) => {
        throw new OAuthFlowError(
          'bad_metadata',
          `The authorization server cannot be used: ${(error as Error).message}`,
        );
      });
      const pending = this.pending.add({
        server: name,
        state,
        codeVerifier,
        serverUrl: entry.url,
        issuer: info.issuer,
        authorizationServerUrl: info.authorizationServerUrl,
        metadata: info.metadata,
        client: choice.client,
        ...(newRegistration ? { newRegistration } : {}),
        redirectUri: this.redirectUri,
        resource: info.resource,
        ...(info.resourceMetadataUrl ? { resourceMetadataUrl: info.resourceMetadataUrl } : {}),
        scopes,
      });
      this.transientProblems.delete(name);
      this.options.logger.info(
        { server: name, issuer: info.issuer, registration: choice.method, scopes: scopes.length },
        'OAuth sign-in started',
      );
      await this.announce(name, 'pending');
      return {
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: new Date(pending.expiresAt).toISOString(),
        issuer: info.issuer,
        registrationMethod: choice.method,
        scopes,
        warnings: choice.warnings,
      };
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        this.options.logger.warn({ server: name, reason: error.code }, 'OAuth sign-in could not start');
        if (error.code === 'needs_client_id') {
          this.transientProblems.set(name, 'needs_client_id');
          await this.announce(name, 'needs_auth');
        }
      }
      throw error;
    }
  }

  /**
   * The browser came back to `/oauth/callback`. Checks, in order: the `state` (constant time,
   * single use, not expired), the `iss` (RFC 9207), then the `error` parameter, then
   * exchanges the code with the PKCE verifier and `resource`, and stores the tokens.
   */
  async completeSignIn(params: URLSearchParams): Promise<CallbackOutcome> {
    const pending = this.pending.take(params.get('state'));
    if (!pending) {
      return {
        ok: false,
        reason:
          'This sign-in is no longer valid: it was already used, it expired, or MCPier restarted since it began.',
        next: 'Start the sign-in again from the MCPier dashboard or with: mcpier auth login <server>',
      };
    }
    const name = pending.server;
    const next = `Start the sign-in again from the server page in the MCPier dashboard, or with: mcpier auth login ${name}`;
    // Every value MCPier holds for this sign-in and this server, so authorization-server text
    // that echoes one (by mistake or on purpose) never shows it.
    const stored = await this.options.store.load(name).catch(() => undefined);
    const known = [
      pending.state,
      pending.codeVerifier,
      params.get('code') ?? '',
      pending.client.clientSecret ?? '',
      pending.newRegistration?.clientSecret ?? '',
      pending.newRegistration?.registrationAccessToken ?? '',
      stored?.tokens?.accessToken ?? '',
      stored?.tokens?.refreshToken ?? '',
      stored?.registration?.clientSecret ?? '',
      stored?.registration?.registrationAccessToken ?? '',
    ];
    const redact = (text: string, tokens?: Partial<OAuthTokens>) => {
      let out = text;
      const values = [...known, tokens?.access_token ?? '', tokens?.refresh_token ?? ''].filter(
        (value) => value.length >= 4,
      );
      for (const value of values.sort((a, b) => b.length - a.length))
        out = out.split(value).join('[redacted]');
      return out;
    };
    const fail = async (reason: string): Promise<CallbackOutcome> => {
      await this.announce(name, 'needs_auth');
      return { ok: false, server: name, reason, next };
    };

    const iss = params.get('iss') ?? undefined;
    const issSupported = pending.metadata.authorization_response_iss_parameter_supported === true;
    try {
      validateAuthorizationResponseIssuer({
        iss,
        expectedIssuer: pending.metadata.issuer,
        issParameterSupported: issSupported,
      });
    } catch (error) {
      if (!(error instanceof IssuerMismatchError)) throw error;
      // A mix-up attack is possible: nothing else from this response is shown.
      this.options.logger.warn(
        { server: name, issPresent: iss !== undefined },
        'OAuth callback rejected: issuer check failed',
      );
      return fail(
        iss === undefined
          ? 'The response did not say which authorization server sent it, although that server promises to (RFC 9207). Nothing was stored.'
          : 'The response came from a different authorization server than the one the sign-in started with. Nothing was stored.',
      );
    }
    if (iss === undefined) {
      this.options.logger.info(
        { server: name, issuer: pending.issuer },
        'OAuth callback without "iss" accepted: the authorization server does not advertise RFC 9207 support',
      );
    }

    const errorCode = params.get('error');
    if (errorCode !== null) {
      const description = params.get('error_description');
      const shown = cleanErrorCode(errorCode);
      const text = description ? cleanRemoteText(description, (value) => redact(value)) : '';
      this.options.logger.warn(
        { server: name, error: shown },
        'OAuth sign-in refused by the authorization server',
      );
      return fail(`The authorization server refused the sign-in: ${shown}${text ? ` (${text})` : ''}.`);
    }
    const code = params.get('code');
    if (!code) return fail('The response carried no authorization code.');

    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(pending.authorizationServerUrl, {
        metadata: pending.metadata,
        clientInformation: this.clientInformation(pending.client),
        authorizationCode: code,
        ...(iss !== undefined ? { iss } : {}),
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        ...(pending.resource ? { resource: pending.resource } : {}),
        fetchFn: this.fetchFn,
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        this.options.logger.warn(
          { server: name, error: cleanErrorCode(error.code) },
          'OAuth code exchange refused',
        );
        return fail(
          `The authorization server refused to finish the sign-in: ${cleanErrorCode(error.code)} (${cleanRemoteText(error.message, (value) => redact(value))}).`,
        );
      }
      this.options.logger.warn({ server: name }, 'OAuth code exchange failed');
      if (error instanceof TypeError || isNetworkError(error))
        return fail('MCPier could not reach the authorization server to finish the sign-in.');
      return fail(
        `Finishing the sign-in failed: ${cleanRemoteText((error as Error).message, (value) => redact(value))}`,
      );
    }

    const now = this.now();
    try {
      await this.options.store.update(name, (current) => {
        const registration =
          pending.newRegistration ??
          (current?.registration && current.registration.clientId === pending.client.clientId
            ? current.registration
            : undefined);
        return {
          server: name,
          serverUrl: pending.serverUrl,
          ...(pending.resource ? { resource: pending.resource } : {}),
          ...(pending.resourceMetadataUrl ? { resourceMetadataUrl: pending.resourceMetadataUrl } : {}),
          authorizationServerUrl: pending.authorizationServerUrl,
          issuer: pending.issuer,
          authorizationServerMetadata: pending.metadata,
          ...(registration ? { registration } : {}),
          tokens: this.toStored(tokens, now),
          grantedScopes: splitScopes(tokens.scope ?? pending.scopes),
          signedInAt: new Date(now).toISOString(),
        };
      });
    } catch (error) {
      // Credential Manager (creating the store key) or the file write failed. The message may
      // name a path but never a token; only its code or kind is logged.
      this.options.logger.error(
        {
          server: name,
          reason: (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'unknown',
          message: (error as Error)?.message,
        },
        'Could not save the OAuth sign-in',
      );
      return fail('MCPier could not save the sign-in, so nothing was stored. The gateway log says why.');
    }
    this.transientProblems.delete(name);
    this.options.logger.info(
      { server: name, issuer: pending.issuer, refreshToken: Boolean(tokens.refresh_token) },
      'OAuth sign-in completed',
    );
    await this.announce(name, 'signed_in');
    return { ok: true, server: name };
  }

  private toStored(tokens: OAuthTokens, now: number, previous?: StoredTokens): StoredTokens {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    return {
      accessToken: tokens.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      tokenType: tokens.token_type,
      issuedAt: now,
      ...(tokens.expires_in !== undefined ? { expiresAt: now + Number(tokens.expires_in) * 1000 } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
  }

  /** Client information for the SDK; a registered auth method steers its client authentication. */
  private clientInformation(client: PendingSignIn['client']): OAuthClientInformationMixed {
    return {
      client_id: client.clientId,
      ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}),
      ...(client.tokenEndpointAuthMethod
        ? { token_endpoint_auth_method: client.tokenEndpointAuthMethod, redirect_uris: [this.redirectUri] }
        : {}),
    };
  }

  /** The client a stored record's tokens belong to (a manual client's secret is resolved). */
  private async storedClient(
    entry: HttpServerEntry,
    record: OAuthRecord,
  ): Promise<OAuthClientInformationMixed> {
    const registration = record.registration;
    if (registration?.method === 'manual' || (!registration && entry.oauth?.clientId)) {
      const clientSecret = await this.manualSecret(entry);
      return this.clientInformation({
        clientId: registration?.clientId ?? entry.oauth!.clientId!,
        ...(clientSecret !== undefined ? { clientSecret } : {}),
      });
    }
    if (!registration) throw new NeedsAuthError('sign_in_required', needsAuthDetail('sign_in_required'));
    return this.clientInformation({
      clientId: registration.clientId,
      ...(registration.clientSecret !== undefined ? { clientSecret: registration.clientSecret } : {}),
      ...(registration.tokenEndpointAuthMethod
        ? { tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod }
        : {}),
    });
  }

  // ---- Refresh

  private isDue(tokens: StoredTokens): boolean {
    if (tokens.expiresAt === undefined) return false;
    const lifetime = tokens.expiresAt - tokens.issuedAt;
    // Never refresh before half the token's life has passed, however short it is.
    const margin = lifetime > 0 ? Math.min(this.marginMs, lifetime / 2) : this.marginMs;
    return tokens.expiresAt - this.now() < margin;
  }

  /**
   * Refreshes a server's access token, at most one refresh per server at a time (callers in
   * the meantime wait for the same one). `rejected` is the token a 401 refused: if the stored
   * token is already a different one, another caller refreshed in the meantime and nothing is
   * done. An invalid or revoked grant drops the tokens (`NeedsAuthError` "sign-in expired"); a
   * network failure keeps them (`RefreshUnavailableError`, an outage).
   */
  refresh(name: string, options: { rejected?: string; force?: boolean } = {}): Promise<void> {
    const running = this.refreshing.get(name);
    if (running) return running;
    const work = this.refreshNowLocked(name, options).finally(() => this.refreshing.delete(name));
    this.refreshing.set(name, work);
    return work;
  }

  private async refreshNowLocked(
    name: string,
    options: { rejected?: string; force?: boolean },
  ): Promise<void> {
    const entry = this.entry(name);
    const record = await this.record(entry);
    const tokens = record?.tokens;
    if (!record || !tokens) throw new NeedsAuthError('sign_in_required', needsAuthDetail('sign_in_required'));
    if (options.rejected !== undefined && options.rejected !== tokens.accessToken) return;
    if (options.rejected === undefined && !options.force && !this.isDue(tokens)) return;

    if (!tokens.refreshToken) {
      if (options.rejected === undefined && !options.force) return; // use it until it fails
      if (options.force) {
        throw new OAuthFlowError(
          'no_refresh_token',
          `The authorization server issued no refresh token for "${name}", so the sign-in cannot be renewed; sign in again when it expires.`,
        );
      }
      await this.expire(name, 'its access token was refused and there is no refresh token');
      throw new NeedsAuthError('sign_in_expired', needsAuthDetail('sign_in_expired'));
    }

    const metadata = record.authorizationServerMetadata;
    const authorizationServerUrl = record.authorizationServerUrl ?? record.issuer;
    if (!metadata || !authorizationServerUrl) {
      await this.expire(name, 'the stored sign-in lacks its authorization server');
      throw new NeedsAuthError('sign_in_expired', needsAuthDetail('sign_in_expired'));
    }
    let refreshed: OAuthTokens;
    try {
      refreshed = await refreshAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation: await this.storedClient(entry, record),
        refreshToken: tokens.refreshToken,
        ...(record.resource ? { resource: record.resource } : {}),
        fetchFn: this.fetchFn,
      });
    } catch (error) {
      if (error instanceof NeedsAuthError || error instanceof OAuthFlowError) throw error;
      if (isAccessDeniedGrant(error)) {
        const code = cleanErrorCode((error as OAuthError).code);
        await this.expire(name, `the refresh was refused (${code})`, code !== 'invalid_grant');
        throw new NeedsAuthError('sign_in_expired', needsAuthDetail('sign_in_expired'));
      }
      const why =
        error instanceof OAuthError
          ? `the authorization server answered ${cleanErrorCode(error.code)}`
          : error instanceof TypeError || isNetworkError(error)
            ? 'the authorization server could not be reached'
            : 'the refresh failed';
      this.options.logger.warn({ server: name, reason: why }, 'OAuth refresh failed; keeping the sign-in');
      throw new RefreshUnavailableError(
        `Could not refresh the sign-in for "${name}": ${why}. MCPier will try again.`,
      );
    }
    const now = this.now();
    await this.options.store.update(name, (current) => {
      if (!current?.tokens) return current;
      return {
        ...current,
        tokens: this.toStored(refreshed, now, current.tokens),
        ...(refreshed.scope ? { grantedScopes: splitScopes(refreshed.scope) } : {}),
        lastRefreshAt: new Date(now).toISOString(),
      };
    });
    this.options.logger.info(
      { server: name, rotated: Boolean(refreshed.refresh_token) },
      'OAuth tokens refreshed',
    );
    await this.announce(name, 'refreshed');
  }

  /** "Refresh now" (API and CLI): forces a refresh and explains a failure. */
  async refreshNow(name: string): Promise<AuthStatus> {
    const entry = this.entry(name);
    const record = await this.record(entry);
    if (!record?.tokens) {
      throw new OAuthFlowError(
        'not_signed_in',
        `"${name}" is not signed in. Sign in first: mcpier auth login ${name}`,
      );
    }
    try {
      await this.refresh(name, { force: true });
    } catch (error) {
      if (error instanceof NeedsAuthError) {
        throw new OAuthFlowError('sign_in_expired', `${error.message}: mcpier auth login ${name}`);
      }
      if (error instanceof RefreshUnavailableError) throw new OAuthFlowError('refresh_failed', error.message);
      throw error;
    }
    return this.status(name);
  }

  /** Drops the tokens of an unusable sign-in, remembering why (`sign_in_expired`). */
  private async expire(name: string, why: string, dropRegistration = false): Promise<void> {
    await this.options.store.update(name, (current) => {
      if (!current) return current;
      const { tokens: _tokens, grantedScopes: _granted, stepUpScopes: _stepUp, ...rest } = current;
      return {
        ...rest,
        ...(dropRegistration && current.registration?.method === 'dynamic'
          ? { registration: undefined }
          : {}),
        problem: 'sign_in_expired',
      };
    });
    this.options.logger.warn({ server: name, reason: why }, 'OAuth sign-in expired; tokens deleted');
    await this.announce(name, 'needs_auth');
  }

  /** A 403 `insufficient_scope`: remember the scopes asked for; the tokens are kept. */
  private async stepUp(name: string, scope: string | undefined): Promise<string[]> {
    const scopes = cleanScopes(scope);
    await this.options.store.update(name, (current) =>
      current ? { ...current, stepUpScopes: scopes, problem: 'more_permissions' } : current,
    );
    this.options.logger.warn(
      { server: name, scopes: scopes.join(' ') },
      'The server asks for more permissions',
    );
    await this.announce(name, 'needs_auth');
    return scopes;
  }

  /**
   * The server's current OAuth values (tokens, an issued client secret), for redaction: a server
   * that echoes its own token never gets it into a result, a log or the call log.
   */
  secretValues(name: string): Map<string, string> {
    const record = this.options.store.peek(name);
    const values = new Map<string, string>();
    if (record?.tokens?.accessToken) values.set('oauth-access-token', record.tokens.accessToken);
    if (record?.tokens?.refreshToken) values.set('oauth-refresh-token', record.tokens.refreshToken);
    if (record?.registration?.clientSecret)
      values.set('oauth-client-secret', record.registration.clientSecret);
    if (record?.registration?.registrationAccessToken) {
      values.set('oauth-registration-token', record.registration.registrationAccessToken);
    }
    return values;
  }

  // ---- The connector's side

  /** The authorization plumbing for one OAuth server's HTTP connector. */
  connectorAuth(name: string): ConnectorAuth {
    const rejectedBy = new WeakMap<Response, string>();
    const current = async (): Promise<StoredTokens> => {
      const entry = this.entry(name);
      const record = await this.record(entry);
      if (!record?.tokens) {
        const reason = this.reasonOf(entry, record) ?? 'sign_in_required';
        throw new NeedsAuthError(reason, needsAuthDetail(reason, record?.stepUpScopes));
      }
      return record.tokens;
    };
    const authProvider: AuthProvider = {
      token: async () => {
        let tokens = await current();
        if (this.isDue(tokens) && tokens.refreshToken) {
          try {
            await this.refresh(name);
          } catch (error) {
            // An outage with a token that has not run out yet: keep using it.
            if (!(error instanceof RefreshUnavailableError) || (tokens.expiresAt ?? 0) <= this.now())
              throw error;
          }
          tokens = await current();
        }
        return tokens.accessToken;
      },
      onUnauthorized: async (ctx) => {
        const rejected = rejectedBy.get(ctx.response) ?? (await current()).accessToken;
        await this.refresh(name, { rejected });
      },
    };
    const base = this.options.fetch ?? fetch;
    const recording: FetchLike = async (url, init) => {
      const response = await base(url, init);
      if (response.status === 401) {
        const used = /^Bearer\s+(\S+)$/i.exec(new Headers(init?.headers).get('authorization') ?? '')?.[1];
        if (used) rejectedBy.set(response, used);
      }
      return response;
    };
    return {
      authProvider,
      fetch: recording,
      classify: async (error) => {
        const needsAuth = findInChain(
          error,
          (value): value is NeedsAuthError => value instanceof NeedsAuthError,
        );
        if (needsAuth) return needsAuth;
        const insufficient = findInChain(
          error,
          (value): value is InsufficientScopeError => value instanceof InsufficientScopeError,
        );
        if (insufficient) {
          const scopes = await this.stepUp(name, insufficient.requiredScope);
          return new NeedsAuthError('more_permissions', needsAuthDetail('more_permissions', scopes));
        }
        const rejectedTwice = findInChain(
          error,
          (value): value is SdkError =>
            value instanceof SdkError && value.code === SdkErrorCode.ClientHttpAuthentication,
        );
        if (rejectedTwice) {
          // Even a freshly refreshed token was refused: this sign-in is no good any more.
          await this.expire(name, 'the server refused the refreshed token');
          return new NeedsAuthError('sign_in_expired', needsAuthDetail('sign_in_expired'));
        }
        return undefined;
      },
    };
  }

  // ---- Sign-out

  /**
   * Signs out: revokes the refresh token (or the access token) when the authorization
   * server offers revocation (best effort, short time limit, failures logged without
   * content), then deletes the tokens. The registration is kept.
   */
  async signOut(name: string): Promise<AuthStatus> {
    const entry = this.entry(name);
    this.pending.cancel(name);
    this.transientProblems.delete(name);
    const record = await this.record(entry);
    if (record?.tokens) await this.revoke(entry, record);
    await this.options.store.update(name, (current) => {
      if (!current) return current;
      const {
        tokens: _t,
        grantedScopes: _g,
        stepUpScopes: _s,
        problem: _p,
        lastRefreshAt: _l,
        signedInAt: _i,
        ...rest
      } = current;
      return rest;
    });
    this.options.logger.info({ server: name }, 'OAuth signed out');
    await this.announce(name, 'signed_out');
    return this.status(name);
  }

  /** Signs out, then deletes the stored registration too: the next sign-in registers again. */
  async forget(name: string): Promise<AuthStatus> {
    const entry = this.entry(name);
    this.pending.cancel(name);
    this.transientProblems.delete(name);
    const record = await this.record(entry);
    if (record?.tokens) await this.revoke(entry, record);
    await this.options.store.remove(name);
    this.options.logger.info({ server: name }, 'OAuth registration forgotten');
    await this.announce(name, 'signed_out');
    return this.status(name);
  }

  private async revoke(entry: HttpServerEntry, record: OAuthRecord): Promise<void> {
    // OpenID Connect metadata types lack the RFC 7009 fields; servers still publish them.
    const metadata = record.authorizationServerMetadata as
      | (AuthorizationServerMetadata & {
          revocation_endpoint?: string;
          revocation_endpoint_auth_methods_supported?: string[];
        })
      | undefined;
    const endpoint = metadata?.revocation_endpoint;
    const tokens = record.tokens;
    if (!endpoint || !tokens) return;
    const [token, hint] = tokens.refreshToken
      ? [tokens.refreshToken, 'refresh_token']
      : [tokens.accessToken, 'access_token'];
    try {
      const url = assertSecureTokenEndpoint(endpoint);
      const client = await this.storedClient(entry, record);
      const method = selectClientAuthMethod(
        client,
        metadata?.revocation_endpoint_auth_methods_supported ??
          metadata?.token_endpoint_auth_methods_supported ??
          [],
      );
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers = new Headers({
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      });
      if (method === 'client_secret_basic' && client.client_secret) {
        headers.set('authorization', `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`);
      } else {
        body.set('client_id', client.client_id);
        if (method === 'client_secret_post' && client.client_secret)
          body.set('client_secret', client.client_secret);
      }
      const base = this.options.fetch ?? fetch;
      const response = await base(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) this.options.logger.info({ server: entry.name, token: hint }, 'OAuth token revoked');
      else
        this.options.logger.warn({ server: entry.name, status: response.status }, 'OAuth revocation refused');
    } catch (error) {
      this.options.logger.warn(
        {
          server: entry.name,
          reason: error instanceof TypeError || isNetworkError(error) ? 'unreachable' : 'failed',
        },
        'OAuth revocation failed (the tokens are deleted anyway)',
      );
    }
  }

  // ---- Config

  /** Deletes records of servers that are gone, changed URL or changed manual client. */
  async reconcile(config: McpierConfig): Promise<void> {
    const entries = config.servers.filter(isOAuthEntry);
    const names = new Set(entries.map((entry) => entry.name));
    for (const name of [...this.transientProblems.keys()])
      if (!names.has(name)) this.transientProblems.delete(name);
    const removed = await this.options.store.reconcile(
      entries.map((entry) => ({
        name: entry.name,
        url: entry.url,
        ...(entry.oauth?.clientId ? { clientId: entry.oauth.clientId } : {}),
      })),
    );
    for (const name of removed) {
      this.pending.cancel(name);
      this.options.logger.info({ server: name }, 'OAuth record removed with its server or its URL or client');
    }
  }
}
