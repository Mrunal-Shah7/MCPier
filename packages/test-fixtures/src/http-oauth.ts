// Fake OAuth world for tests: an authorization server and an OAuth-protected MCP server
// (stateless, 2026-07-28, the same tools as the stateless fixture). Tests drive the whole flow
// by HTTP, without a browser: the authorization endpoint approves at once and redirects.
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createFakeServer, type FixtureServerInfo } from './tools.js';

/** Switches. They live on `fixture.options` and may be changed while the fixture runs. */
export interface OAuthFixtureOptions {
  /** Offer dynamic client registration (default true). */
  registration: boolean;
  /** Advertise and accept client ID metadata documents (default false). */
  cimd: boolean;
  /**
   * Where to fetch a CIMD client ID URL from. CIMD URLs are https; tests map them to a local
   * http server. Default: fetch the URL itself.
   */
  resolveClientIdUrl?: (clientIdUrl: string) => string;
  /** Advertise `authorization_response_iss_parameter_supported` (default false). */
  advertiseIss: boolean;
  /** What `iss` the authorization response carries (default the real issuer). */
  iss: 'correct' | 'omit' | 'wrong';
  /** Access-token lifetime in seconds (default 3600). */
  accessTokenLifetimeSeconds: number;
  /** Access-token length in characters (default 64). Tokens start with `eyJ`, like JWTs. */
  accessTokenLength: number;
  /** Issue refresh tokens (default true). Each refresh rotates the refresh token. */
  refreshTokens: boolean;
  /** Scope the MCP server demands; without it the server answers 403 `insufficient_scope`. */
  requiredScope?: string;
  /** Whether `requiredScope` is demanded on every request or on `tools/call` only (default). */
  requireScopeOn: 'all' | 'call';
  /** Make the authorization endpoint redirect back with this error. */
  rejectAuthorization?: { error: string; description?: string };
  /** Clients registered by hand ("in the provider's console"). */
  manualClients: { clientId: string; clientSecret?: string }[];
  /** Dynamic registration issues a client secret (default false: a public client). */
  issueClientSecret: boolean;
  /** The token endpoint drops the connection (a network failure). */
  tokenEndpointDown: boolean;
  /** `scopes_supported` in both metadata documents. */
  scopesSupported: string[];
  /** The scope in the 401 challenge (default "mcp:tools"; null leaves it out). */
  challengeScope?: string | null;
  /** Logos and a website the MCP server announces in its `serverInfo`. */
  serverInfo?: FixtureServerInfo;
}

export interface OAuthFixtureLog {
  /** Bodies of dynamic registration requests. */
  registrations: Record<string, unknown>[];
  /** Query parameters of every authorization request. */
  authorizations: Record<string, string>[];
  /** Form fields of every token request, with the secret values replaced by their kind. */
  tokenRequests: Record<string, string>[];
  refreshes: number;
  /** Revocation requests: the hint and which kind of token it was. */
  revocations: { hint?: string; kind: 'access' | 'refresh' | 'unknown' }[];
  /** CIMD URLs fetched. */
  cimdFetches: string[];
  /** MCP requests by outcome. */
  mcp: {
    ok: number;
    unauthorized: number;
    forbidden: number;
    /** The `Mcp-Method` of each 401, in order (a health check is `tools/list`). */
    unauthorizedMethods: string[];
  };
}

export interface OAuthFixture {
  /** The protected MCP endpoint. */
  mcpUrl: string;
  /** The authorization server's issuer identifier. */
  issuer: string;
  /** The protected-resource metadata URL the 401 names. */
  resourceMetadataUrl: string;
  /** The `resource` value the server expects (its protected-resource metadata says so). */
  resource: string;
  options: OAuthFixtureOptions;
  log: OAuthFixtureLog;
  /** Every token, code and client secret the fixture handed out (for leak checks). */
  issuedValues(): string[];
  /** Secret values the fixture received: PKCE verifiers, presented client secrets (for leak checks). */
  receivedValues(): string[];
  /** Invalidates every access and refresh token (a refresh then gets `invalid_grant`). */
  revokeAllTokens(): void;
  /** Invalidates the access tokens only (the next MCP request gets 401; refresh still works). */
  expireAccessTokens(): void;
  /** Requests the authorization URL and returns where it redirects (the callback URL). */
  approve(authorizationUrl: string): Promise<string>;
  close(): Promise<void>;
}

interface Client {
  clientId: string;
  clientSecret?: string;
  redirectUris?: string[];
}

interface Grant {
  clientId: string;
  scope: string[];
  resource: string;
}

interface AccessToken extends Grant {
  expiresAt: number;
  valid: boolean;
}

interface Code extends Grant {
  redirectUri: string;
  challenge: string;
  used: boolean;
}

const DEFAULTS: OAuthFixtureOptions = {
  registration: true,
  cimd: false,
  advertiseIss: false,
  iss: 'correct',
  accessTokenLifetimeSeconds: 3600,
  accessTokenLength: 64,
  refreshTokens: true,
  requireScopeOn: 'call',
  manualClients: [],
  issueClientSecret: false,
  tokenEndpointDown: false,
  scopesSupported: ['mcp:tools', 'mcp:admin', 'offline_access'],
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function random(length: number): string {
  let out = '';
  while (out.length < length) out += randomBytes(48).toString('base64url');
  return out.slice(0, length);
}

function isLoopbackRedirect(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

/** What a handler needs of the Node request: its socket, to simulate a dropped connection. */
interface Incoming {
  socket: { destroy(): void };
}

type Handler = (request: Request, incoming: Incoming) => Promise<Response | undefined>;

async function listen(handler: Handler): Promise<{ server: Server; port: number }> {
  const server = createAdaptorServer({
    fetch: async (request: Request, env: { incoming: Incoming }) => {
      const response = await handler(request, env.incoming);
      return response ?? new Response('Not found', { status: 404 });
    },
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Starts the authorization server and the protected MCP server on two free ports. */
export async function startOAuthFixture(overrides: Partial<OAuthFixtureOptions> = {}): Promise<OAuthFixture> {
  const options: OAuthFixtureOptions = { ...DEFAULTS, ...overrides };
  const log: OAuthFixtureLog = {
    registrations: [],
    authorizations: [],
    tokenRequests: [],
    refreshes: 0,
    revocations: [],
    cimdFetches: [],
    mcp: { ok: 0, unauthorized: 0, forbidden: 0, unauthorizedMethods: [] },
  };
  const issued: string[] = [];
  const received: string[] = [];
  const registered = new Map<string, Client>();
  const codes = new Map<string, Code>();
  const accessTokens = new Map<string, AccessToken>();
  /** Live refresh tokens; a rotated or revoked one is removed. */
  const refreshTokens = new Map<string, Grant>();

  // Ports are known only after listening, so the handlers read these.
  let issuer = '';
  let resource = '';
  let resourceMetadataUrl = '';

  const clientOf = async (clientId: string): Promise<Client | undefined> => {
    const manual = options.manualClients.find((client) => client.clientId === clientId);
    if (manual) return manual;
    const dynamic = registered.get(clientId);
    if (dynamic) return dynamic;
    if (options.cimd && clientId.startsWith('https://')) {
      const where = options.resolveClientIdUrl?.(clientId) ?? clientId;
      log.cimdFetches.push(clientId);
      try {
        const response = await fetch(where);
        if (!response.ok) return undefined;
        const document = (await response.json()) as { client_id?: string; redirect_uris?: string[] };
        if (document.client_id !== clientId) return undefined;
        return { clientId, redirectUris: document.redirect_uris ?? [] };
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  /** Client authentication at the token and revocation endpoints. */
  const authenticate = async (request: Request, form: URLSearchParams): Promise<Client | Response> => {
    let clientId = form.get('client_id') ?? undefined;
    let secret = form.get('client_secret') ?? undefined;
    const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    if (basic?.[1]) {
      const [id, value] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(value ?? '');
    }
    if (!clientId) return oauthError('invalid_client', 'No client_id.', 401);
    const client = await clientOf(clientId);
    if (!client) return oauthError('invalid_client', 'Unknown client.', 401);
    if (client.clientSecret !== undefined && client.clientSecret !== secret) {
      return oauthError('invalid_client', 'Client authentication failed.', 401);
    }
    return client;
  };

  const issueTokens = (grant: Grant): Record<string, unknown> => {
    const access = `eyJ${random(Math.max(4, options.accessTokenLength) - 3)}`;
    issued.push(access);
    accessTokens.set(access, {
      ...grant,
      expiresAt: Date.now() + options.accessTokenLifetimeSeconds * 1000,
      valid: true,
    });
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: options.accessTokenLifetimeSeconds,
      scope: grant.scope.join(' '),
    };
    if (options.refreshTokens) {
      const refresh = `rt-${random(48)}`;
      issued.push(refresh);
      refreshTokens.set(refresh, grant);
      body.refresh_token = refresh;
    }
    return body;
  };

  const asHandler: Handler = async (request, incoming) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(options.registration ? { registration_endpoint: `${issuer}/register` } : {}),
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        scopes_supported: options.scopesSupported,
        ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(options.advertiseIss ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }

    if (request.method === 'POST' && path === '/register') {
      if (!options.registration) return undefined;
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      log.registrations.push(body);
      if (body.application_type !== 'native') {
        return oauthError(
          'invalid_client_metadata',
          'application_type must be "native" for a loopback redirect.',
        );
      }
      const redirects = body.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(isLoopbackRedirect)) {
        return oauthError('invalid_redirect_uri', 'Only loopback http redirect URIs are accepted.');
      }
      const clientId = `dyn-${random(16)}`;
      const client: Client = { clientId, redirectUris: redirects as string[] };
      if (options.issueClientSecret) {
        client.clientSecret = `cs-${random(32)}`;
        issued.push(client.clientSecret);
      }
      registered.set(clientId, client);
      const registrationToken = `rat-${random(24)}`;
      issued.push(registrationToken);
      return json(
        {
          ...body,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: client.clientSecret ? 'client_secret_basic' : 'none',
          ...(client.clientSecret ? { client_secret: client.clientSecret, client_secret_expires_at: 0 } : {}),
          registration_access_token: registrationToken,
          registration_client_uri: `${issuer}/register/${clientId}`,
        },
        201,
      );
    }

    if (request.method === 'GET' && path === '/authorize') {
      const params = Object.fromEntries(url.searchParams.entries());
      log.authorizations.push(params);
      const client = params.client_id ? await clientOf(params.client_id) : undefined;
      if (!client) return new Response('Unknown client', { status: 400 });
      const redirectUri = params.redirect_uri ?? '';
      const redirectAllowed = client.redirectUris
        ? client.redirectUris.includes(redirectUri)
        : isLoopbackRedirect(redirectUri);
      if (!redirectAllowed)
        return new Response('Redirect URI not registered for this client', { status: 400 });
      const back = new URL(redirectUri);
      if (params.state) back.searchParams.set('state', params.state);
      const issValue = options.iss === 'wrong' ? 'http://127.0.0.1:1/not-the-issuer' : issuer;
      if (options.iss !== 'omit') back.searchParams.set('iss', issValue);
      const fail = (error: string, description: string) => {
        back.searchParams.set('error', error);
        back.searchParams.set('error_description', description);
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      };
      if (options.rejectAuthorization) {
        return fail(options.rejectAuthorization.error, options.rejectAuthorization.description ?? '');
      }
      if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only "code".');
      if (params.code_challenge_method !== 'S256' || !params.code_challenge) {
        return fail('invalid_request', 'PKCE with S256 is required.');
      }
      if (params.resource !== resource) return fail('invalid_target', 'Unknown resource.');
      const code = `code-${random(32)}`;
      issued.push(code);
      codes.set(code, {
        clientId: client.clientId,
        scope: (params.scope ?? '').split(' ').filter(Boolean),
        resource: params.resource,
        redirectUri,
        challenge: params.code_challenge,
        used: false,
      });
      back.searchParams.set('code', code);
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }

    if (request.method === 'POST' && path === '/token') {
      if (options.tokenEndpointDown) {
        incoming.socket.destroy();
        return new Response(null, { status: 500 });
      }
      const form = new URLSearchParams(await request.text());
      for (const key of ['code_verifier', 'client_secret']) {
        const value = form.get(key);
        if (value) received.push(value);
      }
      const recorded = Object.fromEntries(form.entries());
      for (const key of ['code', 'code_verifier', 'refresh_token', 'client_secret']) {
        if (recorded[key] !== undefined) recorded[key] = `<${key}>`;
      }
      if (request.headers.has('authorization')) recorded.authorization = '<basic>';
      log.tokenRequests.push(recorded);
      const client = await authenticate(request, form);
      if (client instanceof Response) return client;
      const requestedResource = form.get('resource');
      if (requestedResource !== resource)
        return oauthError('invalid_target', 'The resource parameter is missing or wrong.');

      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        if (!code || code.used || code.clientId !== client.clientId) {
          return oauthError('invalid_grant', 'Unknown or used authorization code.');
        }
        code.used = true;
        if (form.get('redirect_uri') !== code.redirectUri)
          return oauthError('invalid_grant', 'redirect_uri mismatch.');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== code.challenge) return oauthError('invalid_grant', 'PKCE verification failed.');
        return json(issueTokens({ clientId: code.clientId, scope: code.scope, resource: code.resource }));
      }

      if (form.get('grant_type') === 'refresh_token') {
        log.refreshes++;
        const presented = form.get('refresh_token') ?? '';
        const grant = refreshTokens.get(presented);
        if (!grant || grant.clientId !== client.clientId) {
          return oauthError('invalid_grant', 'The refresh token is invalid, expired or revoked.');
        }
        refreshTokens.delete(presented); // rotation: the old one is used up
        return json(issueTokens(grant));
      }
      return oauthError('unsupported_grant_type', 'Unsupported grant type.');
    }

    if (request.method === 'POST' && path === '/revoke') {
      const form = new URLSearchParams(await request.text());
      const client = await authenticate(request, form);
      if (client instanceof Response) return client;
      const token = form.get('token') ?? '';
      const kind = refreshTokens.has(token) ? 'refresh' : accessTokens.has(token) ? 'access' : 'unknown';
      log.revocations.push({
        ...(form.get('token_type_hint') ? { hint: form.get('token_type_hint')! } : {}),
        kind,
      });
      const grant = refreshTokens.get(token);
      refreshTokens.delete(token);
      if (grant) {
        for (const access of accessTokens.values())
          if (access.clientId === grant.clientId) access.valid = false;
      }
      const access = accessTokens.get(token);
      if (access) access.valid = false;
      return new Response(null, { status: 200 });
    }
    return undefined;
  };

  const handler = createMcpHandler(
    () =>
      createFakeServer('fake-oauth-http', {
        modernTools: true,
        ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
      }),
    {
      legacy: 'reject',
    },
  );

  const rsHandler: Handler = async (request) => {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
        url.pathname === '/.well-known/oauth-protected-resource')
    ) {
      return json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: options.scopesSupported.filter((scope) => scope !== 'offline_access'),
        bearer_methods_supported: ['header'],
        resource_name: 'Fake OAuth MCP server',
      });
    }
    if (url.pathname !== '/mcp') return undefined;
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    const token = bearer ? accessTokens.get(bearer) : undefined;
    const scope = options.challengeScope === undefined ? 'mcp:tools' : options.challengeScope;
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl}"${scope === null ? '' : `, scope="${scope}"`}`;
    if (!token || !token.valid || token.expiresAt <= Date.now() || token.resource !== resource) {
      log.mcp.unauthorized++;
      log.mcp.unauthorizedMethods.push(request.headers.get('mcp-method') ?? request.method);
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': bearer ? `${challenge}, error="invalid_token"` : challenge,
        },
      });
    }
    if (options.requiredScope && !token.scope.includes(options.requiredScope)) {
      const method = request.method === 'POST' ? request.headers.get('mcp-method') : undefined;
      if (options.requireScopeOn === 'all' || method === 'tools/call') {
        log.mcp.forbidden++;
        const scopes = [...new Set([...token.scope, options.requiredScope])].join(' ');
        return new Response(JSON.stringify({ error: 'insufficient_scope' }), {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': `Bearer error="insufficient_scope", scope="${scopes}", resource_metadata="${resourceMetadataUrl}", error_description="This tool needs ${options.requiredScope}"`,
          },
        });
      }
    }
    log.mcp.ok++;
    return handler.fetch(request);
  };

  const as = await listen(asHandler);
  const rs = await listen(rsHandler);
  issuer = `http://127.0.0.1:${as.port}`;
  resource = `http://127.0.0.1:${rs.port}/mcp`;
  resourceMetadataUrl = `http://127.0.0.1:${rs.port}/.well-known/oauth-protected-resource/mcp`;

  return {
    mcpUrl: resource,
    issuer,
    resourceMetadataUrl,
    resource,
    options,
    log,
    issuedValues: () => [...issued],
    receivedValues: () => [...received],
    revokeAllTokens() {
      for (const access of accessTokens.values()) access.valid = false;
      refreshTokens.clear();
    },
    expireAccessTokens() {
      for (const access of accessTokens.values()) access.valid = false;
    },
    async approve(authorizationUrl: string) {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      await response.text().catch(() => '');
      const location = response.headers.get('location');
      if (response.status !== 302 || !location) {
        throw new Error(`The authorization endpoint answered ${response.status} without a redirect.`);
      }
      return location;
    },
    async close() {
      await handler.close();
      await close(rs.server);
      await close(as.server);
    },
  };
}
