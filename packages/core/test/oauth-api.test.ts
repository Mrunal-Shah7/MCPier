// Sprint 5, Phase 3: the OAuth admin API routes, the auth-status event, the CIMD document
// route and the connection test's discovery for unsaved OAuth entries.
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_API_PATHS,
  DASHBOARD_API_PATHS,
  type AuthListResponse,
  type AuthStatus,
  type AuthStatusResponse,
  type CimdDocumentResponse,
  type ConnectionTestResponse,
} from '@mcpier/shared';
import { startStatelessServer, type RunningFixture } from '@mcpier/test-fixtures';
import { openSse } from '../../../test/helpers/sse.js';
import { waitForStatus } from '../../../test/helpers/gateway.js';
import { OAUTH_SERVER, startOAuthWorld, type OAuthWorld } from '../../../test/helpers/oauth.js';

let world: OAuthWorld | undefined;
let plain: RunningFixture | undefined;

afterEach(async () => {
  await world?.close();
  await plain?.close();
  world = plain = undefined;
});

type ErrorBody = { error: { code: string; message: string } };

/** Keys an auth status may carry: names, times, scopes and flags only. */
const STATUS_KEYS = [
  'server',
  'signedIn',
  'reason',
  'message',
  'issuer',
  'registration',
  'grantedScopes',
  'requestedScopes',
  'accessTokenExpiresAt',
  'hasRefreshToken',
  'lastRefreshAt',
  'signedInAt',
  'pending',
];

function expectNoValues(status: AuthStatus): void {
  for (const key of Object.keys(status)) expect(STATUS_KEYS).toContain(key);
  expect(
    Object.keys(status.registration ?? {}).every((key) =>
      ['method', 'clientId', 'redirectUri'].includes(key),
    ),
  ).toBe(true);
}

async function withPlainServer(): Promise<OAuthWorld> {
  plain = await startStatelessServer();
  world = await startOAuthWorld({ servers: [{ name: 'plain', transport: 'http', url: plain.url }] });
  return world;
}

describe('OAuth admin routes', () => {
  it('need the admin token', async () => {
    world = await startOAuthWorld();
    for (const [method, path] of [
      ['GET', AUTH_API_PATHS.list],
      ['GET', AUTH_API_PATHS.status(OAUTH_SERVER)],
      ['POST', AUTH_API_PATHS.login(OAUTH_SERVER)],
      ['POST', AUTH_API_PATHS.refresh(OAUTH_SERVER)],
      ['POST', AUTH_API_PATHS.logout(OAUTH_SERVER)],
      ['POST', AUTH_API_PATHS.forget(OAUTH_SERVER)],
      ['GET', AUTH_API_PATHS.cimdDocument],
    ] as const) {
      const response = await fetch(`${world.t.gateway.url}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(world.fixture.log.registrations).toHaveLength(0);
  });

  it('status, login, refresh, logout and forget for an OAuth server, with no values', async () => {
    const w = await withPlainServer();
    const before = await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER));
    expect(before.status).toBe(200);
    expect(before.body.status).toMatchObject({
      server: OAUTH_SERVER,
      signedIn: false,
      reason: 'sign_in_required',
    });
    expect(before.body.status.message).toContain('mcpier auth login notion');

    const login = await fetch(`${w.t.gateway.url}${AUTH_API_PATHS.login(OAUTH_SERVER)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.t.token}` },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const started = (await login.json()) as { authorizationUrl: string; expiresAt: string };
    const minutes = (Date.parse(started.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThanOrEqual(10);
    const pending = await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER));
    expect(pending.body.status.pending?.expiresAt).toBe(started.expiresAt);

    await w.finish(started.authorizationUrl);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
    const signedIn = (await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER))).body
      .status;
    expect(signedIn).toMatchObject({
      signedIn: true,
      registration: { method: 'dynamic' },
      hasRefreshToken: true,
    });
    expect(signedIn.pending).toBeUndefined();
    expectNoValues(signedIn);

    const refreshed = await w.api<AuthStatusResponse>('POST', AUTH_API_PATHS.refresh(OAUTH_SERVER));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.status.lastRefreshAt).toBeTruthy();
    expectNoValues(refreshed.body.status);

    const list = await w.api<AuthListResponse>('GET', AUTH_API_PATHS.list);
    expect(list.body.servers.map((status) => status.server)).toEqual([OAUTH_SERVER]);

    const out = await w.api<AuthStatusResponse>('POST', AUTH_API_PATHS.logout(OAUTH_SERVER));
    expect(out.body.status).toMatchObject({ signedIn: false, registration: { method: 'dynamic' } });
    const forgot = await w.api<AuthStatusResponse>('POST', AUTH_API_PATHS.forget(OAUTH_SERVER));
    expect(forgot.body.status.registration).toBeUndefined();
  });

  it('refresh when not signed in, and without a refresh token, explain themselves', async () => {
    world = await startOAuthWorld({ fixture: { refreshTokens: false } });
    const w = world;
    const notSignedIn = await w.api<ErrorBody>('POST', AUTH_API_PATHS.refresh(OAUTH_SERVER));
    expect(notSignedIn.status).toBe(409);
    expect(notSignedIn.body.error.message).toContain('is not signed in');
    await w.signIn();
    const noRefresh = await w.api<ErrorBody>('POST', AUTH_API_PATHS.refresh(OAUTH_SERVER));
    expect(noRefresh.status).toBe(409);
    expect(noRefresh.body.error.message).toContain('issued no refresh token');
  });

  it('refuse non-OAuth servers (409) and unknown servers (404)', async () => {
    const w = await withPlainServer();
    for (const [method, path] of [
      ['GET', AUTH_API_PATHS.status('plain')],
      ['POST', AUTH_API_PATHS.login('plain')],
      ['POST', AUTH_API_PATHS.refresh('plain')],
      ['POST', AUTH_API_PATHS.logout('plain')],
      ['POST', AUTH_API_PATHS.forget('plain')],
    ] as const) {
      const answer = await w.api<ErrorBody>(method, path);
      expect(answer.status, `${method} ${path}`).toBe(409);
      expect(answer.body.error).toMatchObject({ code: 'conflict' });
      expect(answer.body.error.message).toContain('does not use OAuth');
    }
    for (const [method, path] of [
      ['GET', AUTH_API_PATHS.status('ghost')],
      ['POST', AUTH_API_PATHS.login('ghost')],
      ['POST', AUTH_API_PATHS.logout('ghost')],
    ] as const) {
      const answer = await w.api<ErrorBody>(method, path);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.body.error.code).toBe('not_found');
    }
    expect((await w.api<AuthListResponse>('GET', AUTH_API_PATHS.list)).body.servers).toHaveLength(1);
  });

  it('a sign-in that cannot start answers 502 with a readable reason', async () => {
    world = await startOAuthWorld();
    await world.fixture.close();
    const answer = await world.api<ErrorBody>('POST', AUTH_API_PATHS.login(OAUTH_SERVER));
    expect(answer.status).toBe(502);
    expect(answer.body.error).toMatchObject({ code: 'upstream_error' });
    expect(answer.body.error.message).toMatch(/^Cannot reach http:\/\/127\.0\.0\.1:\d+\/mcp/);
  });

  it('server actions match exactly (B-1)', async () => {
    const w = await withPlainServer();
    expect((await w.api('POST', '/api/servers/plain/startx')).status).toBe(404);
    expect((await w.api('POST', '/api/servers/plain/xrefresh')).status).toBe(404);
    expect((await w.api('POST', '/api/tools/plain__echo/enablex')).status).toBe(404);
    expect((await w.api('POST', '/api/servers/plain/refresh')).status).toBe(200);
  });
});

describe('the auth-status event', () => {
  it('fires on sign-in, refresh, step-up and sign-out, with the route fields only', async () => {
    world = await startOAuthWorld({ fixture: { requiredScope: 'mcp:admin' } });
    const w = world;
    const events = await openSse(`${w.t.gateway.url}/api/events`, { authorization: `Bearer ${w.t.token}` });
    const authEvents = () =>
      events.events.filter((event) => event.event === 'auth_status').map((event) => event.data as AuthStatus);

    await w.signIn();
    await events.waitFor((event) => event.event === 'auth_status' && (event.data as AuthStatus).signedIn);
    await w.api('POST', AUTH_API_PATHS.refresh(OAUTH_SERVER));
    await events.waitFor(
      (event) => event.event === 'auth_status' && Boolean((event.data as AuthStatus).lastRefreshAt),
    );
    await w.callTool('notion__echo', { text: 'x' });
    await events.waitFor(
      (event) => event.event === 'auth_status' && (event.data as AuthStatus).reason === 'more_permissions',
    );
    await w.api('POST', AUTH_API_PATHS.logout(OAUTH_SERVER));
    await events.waitFor(
      (event) =>
        event.event === 'auth_status' &&
        (event.data as AuthStatus).reason === 'sign_in_required' &&
        !(event.data as AuthStatus).pending,
    );
    events.close();
    for (const status of authEvents()) expectNoValues(status);
    const route = (await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER))).body.status;
    expect(authEvents().at(-1)).toEqual(route);
    const raw = events.raw();
    for (const value of w.fixture.issuedValues()) expect(raw.includes(value)).toBe(false);
  });
});

describe('the CIMD document route', () => {
  it('answers 409 without the setting, and the document with it', async () => {
    world = await startOAuthWorld();
    const unset = await world.api<ErrorBody>('GET', AUTH_API_PATHS.cimdDocument);
    expect(unset.status).toBe(409);
    expect(unset.body.error.message).toContain('"cimdUrl" setting is not set');

    const url = 'https://example.org/mcpier/client.json';
    expect((await world.api('PATCH', DASHBOARD_API_PATHS.settings, { cimdUrl: url })).status).toBe(200);
    const set = await world.api<CimdDocumentResponse>('GET', AUTH_API_PATHS.cimdDocument);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      url,
      redirectUri: `http://127.0.0.1:${world.t.port}/oauth/callback`,
      document: {
        client_id: url,
        client_name: 'MCPier',
        redirect_uris: [`http://127.0.0.1:${world.t.port}/oauth/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      },
    });
  });
});

describe('the connection test for an unsaved OAuth entry', () => {
  const entry = (w: OAuthWorld, extra: Record<string, unknown> = {}) => ({
    name: 'unsaved',
    transport: 'http',
    url: w.fixture.mcpUrl,
    auth: 'oauth',
    ...extra,
  });

  it('runs discovery only and reports the metadata and the method a sign-in would use', async () => {
    world = await startOAuthWorld();
    const w = world;
    const answer = await w.api<ConnectionTestResponse>('POST', DASHBOARD_API_PATHS.connectionTest, entry(w));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true,
      needsAuth: true,
      tools: { count: 0, names: [] },
      discovery: {
        protectedResourceMetadata: true,
        resourceMetadataUrl: w.fixture.resourceMetadataUrl,
        authorizationServer: w.fixture.issuer,
        authorizationServerMetadata: true,
        issuer: w.fixture.issuer,
        registrationMethod: 'dynamic',
        scopesSupported: ['mcp:tools', 'mcp:admin'],
      },
    });
    // Nothing was registered, no sign-in started, no token exists.
    expect(w.fixture.log.registrations).toHaveLength(0);
    expect(w.fixture.log.authorizations).toHaveLength(0);
    expect(w.fixture.log.tokenRequests).toHaveLength(0);
  });

  it('names a manual client, and explains when a client ID is needed', async () => {
    world = await startOAuthWorld({ fixture: { registration: false } });
    const w = world;
    const manual = await w.api<ConnectionTestResponse>(
      'POST',
      DASHBOARD_API_PATHS.connectionTest,
      entry(w, { oauth: { clientId: 'from-console' } }),
    );
    expect(manual.body.discovery?.registrationMethod).toBe('manual');
    const none = await w.api<ConnectionTestResponse>('POST', DASHBOARD_API_PATHS.connectionTest, entry(w));
    expect(none.body).toMatchObject({ ok: false, needsAuth: true });
    expect(none.body.discovery?.registrationMethod).toBeUndefined();
    expect(none.body.error).toContain('no client ID is configured');
  });

  it('reports CIMD when the setting is set and the server supports it', async () => {
    world = await startOAuthWorld({
      fixture: { cimd: true },
      settings: { cimdUrl: 'https://example.org/c.json' },
    });
    const answer = await world.api<ConnectionTestResponse>(
      'POST',
      DASHBOARD_API_PATHS.connectionTest,
      entry(world),
    );
    expect(answer.body.discovery?.registrationMethod).toBe('cimd');
  });
});
