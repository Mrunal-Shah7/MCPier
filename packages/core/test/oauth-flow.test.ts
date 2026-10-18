// Sprint 5, Phase 2: the OAuth engine end to end against the OAuth fixture, with a real
// gateway on a random port, the fake secret store and a temporary home. The browser is
// replaced by HTTP: the authorization URL is followed through the fixture's auto-approve to
// the gateway's own callback.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_PATHS,
  AUTH_API_PATHS,
  CALL_LOG_PATHS,
  cimdDocument,
  needsAuthDetail,
  USAGE_PATH,
  type AuthStatusResponse,
} from '@mcpier/shared';
import { createGatewayLogger, OAUTH_KEY_ACCOUNT, OAuthStore } from '@mcpier/core';
import { listenFixture, startIconHost, type RunningFixture } from '@mcpier/test-fixtures';
import { getFreePort } from '../../../test/helpers/ports.js';
import { openSse } from '../../../test/helpers/sse.js';
import { waitForStatus, waitUntil } from '../../../test/helpers/gateway.js';
import { OAUTH_SERVER, resultText, startOAuthWorld, type OAuthWorld } from '../../../test/helpers/oauth.js';

let world: OAuthWorld | undefined;
let extra: RunningFixture | undefined;

afterEach(async () => {
  await world?.close();
  await extra?.close();
  world = extra = undefined;
});

/** The record as stored, read with a store of its own (same file, same key). */
async function storedRecord(w: OAuthWorld) {
  const logFile = join(w.t.home.dir, '..', 'reader.log');
  const log = createGatewayLogger({ file: logFile });
  try {
    return await new OAuthStore(w.t.home.paths.oauthDir, w.secrets.internal(), log.logger).load(OAUTH_SERVER);
  } finally {
    log.close();
  }
}

const status = (w: OAuthWorld) => w.t.gateway.manager.status(OAUTH_SERVER);
const gatewayLog = (w: OAuthWorld) => readFileSync(w.t.home.paths.gatewayLog, 'utf8');

describe('OAuth sign-in', () => {
  it('signs in with dynamic registration, reaches ready, and a tool call through /mcp works', async () => {
    world = await startOAuthWorld();
    const w = world;
    // No tokens: needs_auth, and nothing was sent to the server.
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    expect(status(w).detail).toBe('Sign in required');
    expect(w.fixture.log.mcp).toEqual({ ok: 0, unauthorized: 0, forbidden: 0, unauthorizedMethods: [] });

    const started = await w.startSignIn();
    expect(started.registrationMethod).toBe('dynamic');
    expect(started.issuer).toBe(w.fixture.issuer);
    expect(w.fixture.log.registrations).toHaveLength(1);
    expect(w.fixture.log.registrations[0]).toMatchObject({
      application_type: 'native',
      redirect_uris: [`http://127.0.0.1:${w.t.port}/oauth/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      client_name: 'MCPier',
    });

    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('resource')).toBe(w.fixture.resource);
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${w.t.port}/oauth/callback`);
    // The challenge's scope, plus offline_access (the authorization server offers it).
    expect(started.scopes).toEqual(['mcp:tools', 'offline_access']);

    const page = await w.finish(started.authorizationUrl);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Signed in to <span class="name">notion</span>');
    expect(page.html).not.toContain('<script');
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');

    // The token request carried the PKCE verifier and the resource.
    expect(w.fixture.log.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'authorization_code',
      code_verifier: '<code_verifier>',
      resource: w.fixture.resource,
    });
    const result = await w.callTool('notion__echo', { text: 'hello through oauth' });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toBe('hello through oauth');

    const auth = await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER));
    expect(auth.body.status).toMatchObject({
      signedIn: true,
      issuer: w.fixture.issuer,
      registration: { method: 'dynamic' },
      grantedScopes: ['mcp:tools', 'offline_access'],
      hasRefreshToken: true,
    });
    expect(auth.body.status.accessTokenExpiresAt).toBeTruthy();
  });

  it('uses a manual client, with its client secret from a secret reference', async () => {
    world = await startOAuthWorld({
      fixture: {
        registration: false,
        manualClients: [{ clientId: 'manual-1', clientSecret: 'manual-secret-5678' }],
      },
      server: { oauth: { clientId: 'manual-1', clientSecret: 'secret:notion-client' } },
    });
    const w = world;
    await w.secrets.set('notion-client', 'manual-secret-5678');
    const started = await w.signIn();
    expect(started.registrationMethod).toBe('manual');
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe('manual-1');
    expect(w.fixture.log.registrations).toHaveLength(0);
    // The secret went to the token endpoint as client authentication (basic: the server offers it).
    expect(w.fixture.log.tokenRequests.at(-1)?.authorization).toBe('<basic>');
    expect(resultText(await w.callTool('notion__echo', { text: 'manual' }))).toBe('manual');
    expect((await storedRecord(w))?.registration).toMatchObject({ method: 'manual', clientId: 'manual-1' });
    expect(JSON.stringify(await storedRecord(w))).not.toContain('manual-secret-5678');
  });

  it('uses the CIMD URL as client ID when the setting is set and the server supports it', async () => {
    const cimdUrl = 'https://cimd.example.test/mcpier/client.json';
    let port = 0;
    extra = await listenFixture(() => Response.json(cimdDocument(cimdUrl, port)));
    world = await startOAuthWorld({
      fixture: { cimd: true, resolveClientIdUrl: () => extra!.url },
      settings: { cimdUrl },
    });
    port = world.t.port;
    const started = await world.signIn();
    expect(started.registrationMethod).toBe('cimd');
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe(cimdUrl);
    expect(world.fixture.log.registrations).toHaveLength(0);
    expect(world.fixture.log.cimdFetches.length).toBeGreaterThan(0);
  });

  it('uses dynamic registration when the CIMD setting is unset, even if CIMD is supported', async () => {
    world = await startOAuthWorld({ fixture: { cimd: true } });
    const started = await world.signIn();
    expect(started.registrationMethod).toBe('dynamic');
    expect(world.fixture.log.registrations).toHaveLength(1);
  });

  it('without registration and without a client ID: needs_auth "needs a client ID"', async () => {
    world = await startOAuthWorld({ fixture: { registration: false } });
    const w = world;
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    const answer = await w.api<{ error: { code: string; message: string } }>(
      'POST',
      AUTH_API_PATHS.login(OAUTH_SERVER),
    );
    expect(answer.status).toBe(409);
    expect(answer.body.error.message).toContain(
      'offers no automatic registration, and no client ID is configured',
    );
    expect(answer.body.error.message).toContain(`http://127.0.0.1:${w.t.port}/oauth/callback`);
    await waitUntil(() => status(w).detail === needsAuthDetail('needs_client_id'));
    const auth = await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER));
    expect(auth.body.status.reason).toBe('needs_client_id');
  });
});

describe('the callback', () => {
  it('rejects a wrong iss and stores nothing', async () => {
    world = await startOAuthWorld({ fixture: { iss: 'wrong' } });
    const page = await world.finish((await world.startSignIn()).authorizationUrl);
    expect(page.status).toBe(400);
    expect(page.html).toContain('came from a different authorization server');
    expect(page.html).not.toContain('not-the-issuer');
    expect((await storedRecord(world))?.tokens).toBeUndefined();
    expect(status(world).state).toBe('needs_auth');
  });

  it('rejects a missing iss when the server advertises it', async () => {
    world = await startOAuthWorld({ fixture: { iss: 'omit', advertiseIss: true } });
    const page = await world.finish((await world.startSignIn()).authorizationUrl);
    expect(page.status).toBe(400);
    expect(page.html).toContain('did not say which authorization server sent it');
    expect((await storedRecord(world))?.tokens).toBeUndefined();
  });

  it('accepts a missing iss from a server that does not advertise it, and logs that', async () => {
    world = await startOAuthWorld({ fixture: { iss: 'omit' } });
    await world.signIn();
    expect(gatewayLog(world)).toContain('OAuth callback without \\"iss\\" accepted');
  });

  it('rejects unknown, reused and expired states with the same page, echoing nothing', async () => {
    let clock = Date.now();
    world = await startOAuthWorld({ extra: { now: () => clock } });
    const w = world;
    const port = w.t.port;
    const unknown = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc&state=nope`);
    const unknownHtml = await unknown.text();
    expect(unknown.status).toBe(400);
    expect(unknownHtml).toContain('This sign-in is no longer valid');
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    expect(unknown.headers.get('referrer-policy')).toBe('no-referrer');
    expect(unknown.headers.get('content-security-policy')).toContain("default-src 'none'");

    const started = await w.startSignIn();
    const first = await w.finish(started.authorizationUrl);
    expect(first.status).toBe(200);
    const reused = await fetch(first.callbackUrl);
    const reusedHtml = await reused.text();
    expect(reused.status).toBe(400);
    expect(reusedHtml).toBe(unknownHtml);

    const again = await w.startSignIn();
    clock += 10 * 60_000 + 1;
    const expired = await w.finish(again.authorizationUrl);
    expect(expired.status).toBe(400);
    expect(expired.html).toBe(unknownHtml);

    const callback = new URL(first.callbackUrl);
    for (const html of [unknownHtml, reusedHtml, first.html, expired.html]) {
      expect(html).not.toContain(callback.searchParams.get('code')!);
      expect(html).not.toContain(callback.searchParams.get('state')!);
    }
  });

  it('shows the authorization server error and description, sanitized and escaped', async () => {
    world = await startOAuthWorld({
      fixture: {
        rejectAuthorization: { error: 'access_denied', description: 'The user said <b>no</b>\u0007 thanks' },
      },
    });
    const page = await world.finish((await world.startSignIn()).authorizationUrl);
    expect(page.status).toBe(400);
    expect(page.html).toContain(
      'refused the sign-in: access_denied (The user said &lt;b&gt;no&lt;/b&gt; thanks)',
    );
    expect(page.html).not.toContain('<b>');
    expect(page.html).toContain('mcpier auth login notion');
  });

  it('a sign-in that cannot be saved (Credential Manager fails) shows the page, stores nothing', async () => {
    // A manual client: the callback is the store's first write, so it creates the key there.
    world = await startOAuthWorld({
      fixture: { registration: false, manualClients: [{ clientId: 'manual-1' }] },
      server: { oauth: { clientId: 'manual-1' } },
    });
    const w = world;
    w.secrets.internal().failWith = new Error('Platform secure storage failure');
    const started = await w.startSignIn();
    const page = await w.finish(started.authorizationUrl);
    expect(page.status).toBe(400);
    expect(page.html).toContain('Sign-in to notion failed');
    expect(page.html).toContain('MCPier could not save the sign-in, so nothing was stored.');
    const callback = new URL(page.callbackUrl);
    expect(page.html).not.toContain(callback.searchParams.get('code')!);
    expect(page.html).not.toContain(callback.searchParams.get('state')!);
    const again = await fetch(page.callbackUrl);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect(again.headers.get('referrer-policy')).toBe('no-referrer');
    await again.text();
    expect(status(w).state).toBe('needs_auth');
    expect(await storedRecord(w)).toBeUndefined();
    expect(gatewayLog(w)).toContain('Could not save the OAuth sign-in');
    for (const value of w.fixture.issuedValues()) expect(gatewayLog(w)).not.toContain(value);
  });

  it('refuses a callback whose Host is not the gateway', async () => {
    world = await startOAuthWorld();
    const { httpRequest } = await import('../../../test/helpers/http.js');
    const answer = await httpRequest(world.t.port, {
      path: '/oauth/callback?code=a&state=b',
      headers: { host: 'evil.example.com' },
    });
    expect(answer.status).toBe(403);
  });
});

describe('refresh', () => {
  it('refreshes before expiry, without waiting for a 401', async () => {
    world = await startOAuthWorld({
      fixture: { accessTokenLifetimeSeconds: 3 },
      extra: { oauth: { refreshMarginMs: 1000 } },
    });
    const w = world;
    await w.signIn();
    const unauthorized = w.fixture.log.mcp.unauthorized;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(resultText(await w.callTool('notion__echo', { text: 'fresh' }))).toBe('fresh');
    expect(w.fixture.log.refreshes).toBeGreaterThanOrEqual(1);
    expect(w.fixture.log.mcp.unauthorized).toBe(unauthorized);
    expect((await storedRecord(w))?.lastRefreshAt).toBeTruthy();
  });

  it('on a 401 mid-call: one refresh, one retry, and the rotated refresh token is stored', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const before = await storedRecord(w);
    w.fixture.expireAccessTokens();
    const seen = w.fixture.log.mcp.unauthorizedMethods.length;
    expect(resultText(await w.callTool('notion__echo', { text: 'after 401' }))).toBe('after 401');
    expect(w.fixture.log.refreshes).toBe(1);
    // Exactly one 401 for the call itself; a health check (tools/list) may land in between and
    // take its own 401 under load, which single flight absorbs (Sprint 7 BUGS B-1).
    const calls401 = w.fixture.log.mcp.unauthorizedMethods
      .slice(seen)
      .filter((method) => method === 'tools/call');
    expect(calls401).toHaveLength(1);
    const after = await storedRecord(w);
    expect(after?.tokens?.refreshToken).toBeTruthy();
    expect(after?.tokens?.refreshToken).not.toBe(before?.tokens?.refreshToken);
    expect(after?.tokens?.accessToken).not.toBe(before?.tokens?.accessToken);
  });

  it('runs a single refresh for ten concurrent calls that all got a 401', async () => {
    world = await startOAuthWorld({ fixture: { accessTokenLength: 2000 } });
    const w = world;
    await w.signIn();
    w.fixture.expireAccessTokens();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        w.t.gateway.manager.callTool('notion__echo', { text: `call ${index}` }),
      ),
    );
    expect(results.map((outcome) => (outcome.kind === 'result' ? resultText(outcome.result) : ''))).toEqual(
      Array.from({ length: 10 }, (_, index) => `call ${index}`),
    );
    expect(w.fixture.log.refreshes).toBe(1);
    expect(status(w).state).toBe('ready');
  });

  it('a revoked grant drops the tokens: needs_auth "Sign-in expired; sign in again"', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    w.fixture.revokeAllTokens();
    const result = await w.callTool('notion__echo', { text: 'x' });
    expect(result.isError).toBe(true);
    expect(status(w)).toMatchObject({ state: 'needs_auth', detail: 'Sign-in expired; sign in again' });
    const record = await storedRecord(w);
    expect(record?.tokens).toBeUndefined();
    expect(record?.registration).toBeDefined();
    const auth = await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER));
    expect(auth.body.status).toMatchObject({ signedIn: false, reason: 'sign_in_expired' });
  });

  it('a network failure during refresh is an outage: the tokens are kept, and it recovers', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const tokens = (await storedRecord(w))?.tokens;
    w.fixture.options.tokenEndpointDown = true;
    w.fixture.expireAccessTokens();
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'error');
    expect(status(w).detail).toContain('Could not refresh the sign-in');
    expect((await storedRecord(w))?.tokens).toEqual(tokens);
    w.fixture.options.tokenEndpointDown = false;
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
    expect(resultText(await w.callTool('notion__echo', { text: 'back' }))).toBe('back');
  });

  it('"refresh now" reports the new expiry', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const answer = await w.api<AuthStatusResponse>('POST', AUTH_API_PATHS.refresh(OAUTH_SERVER));
    expect(answer.status).toBe(200);
    expect(answer.body.status.lastRefreshAt).toBeTruthy();
    expect(w.fixture.log.refreshes).toBe(1);
  });
});

describe('step-up', () => {
  it('a 403 insufficient_scope gives needs_auth naming the scopes; the next sign-in asks for the union', async () => {
    world = await startOAuthWorld({ fixture: { requiredScope: 'mcp:admin' } });
    const w = world;
    await w.signIn();
    const denied = await w.callTool('notion__echo', { text: 'x' });
    expect(denied.isError).toBe(true);
    expect(resultText(denied)).toContain('More permissions needed (mcp:tools offline_access mcp:admin)');
    expect(status(w).state).toBe('needs_auth');
    const auth = await w.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER));
    expect(auth.body.status).toMatchObject({
      reason: 'more_permissions',
      requestedScopes: ['mcp:tools', 'offline_access', 'mcp:admin'],
      grantedScopes: ['mcp:tools', 'offline_access'],
    });
    // A gateway restart keeps it waiting for the sign-in (the tokens are kept, but not used).
    await w.restart();
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');

    const started = await w.signIn();
    expect(started.scopes).toEqual(['mcp:tools', 'offline_access', 'mcp:admin']);
    expect(resultText(await w.callTool('notion__echo', { text: 'allowed' }))).toBe('allowed');
  });
});

describe('storage and lifecycle', () => {
  it('stores and uses access tokens longer than 1,280 characters', async () => {
    world = await startOAuthWorld({ fixture: { accessTokenLength: 3000 } });
    await world.signIn();
    expect((await storedRecord(world))?.tokens?.accessToken).toHaveLength(3000);
    expect(resultText(await world.callTool('notion__echo', { text: 'long' }))).toBe('long');
  });

  it('tokens survive a restart; pending sign-ins do not', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    await w.restart();
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
    expect(resultText(await w.callTool('notion__echo', { text: 'again' }))).toBe('again');

    const started = await w.startSignIn();
    await w.restart();
    const page = await w.finish(started.authorizationUrl);
    expect(page.status).toBe(400);
    expect(page.html).toContain('This sign-in is no longer valid');
  });

  it('sign-out revokes at the server and leads to needs_auth; forget registers again next time', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const out = await w.api<AuthStatusResponse>('POST', AUTH_API_PATHS.logout(OAUTH_SERVER));
    expect(out.body.status).toMatchObject({
      signedIn: false,
      reason: 'sign_in_required',
      hasRefreshToken: false,
    });
    expect(w.fixture.log.revocations).toEqual([{ hint: 'refresh_token', kind: 'refresh' }]);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    expect(status(w).detail).toBe('Sign in required');

    // Signing in again reuses the registration…
    await w.signIn();
    expect(w.fixture.log.registrations).toHaveLength(1);
    // …until it is forgotten.
    const forgotten = await w.api<AuthStatusResponse>('POST', AUTH_API_PATHS.forget(OAUTH_SERVER));
    expect(forgotten.body.status.registration).toBeUndefined();
    expect(await storedRecord(w)).toBeUndefined();
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    await w.signIn();
    expect(w.fixture.log.registrations).toHaveLength(2);
  });

  it('a port change redoes a dynamic registration with the new redirect URI', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const newPort = await getFreePort();
    await w.restart(newPort);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
    const started = await w.startSignIn();
    expect(w.fixture.log.registrations).toHaveLength(2);
    expect(w.fixture.log.registrations[1]?.redirect_uris).toEqual([
      `http://127.0.0.1:${newPort}/oauth/callback`,
    ]);
    expect(started.warnings.join(' ')).toContain('Registered again: the redirect URI changed');
    const page = await w.finish(started.authorizationUrl);
    expect(page.status).toBe(200);
    expect((await storedRecord(w))?.registration?.redirectUri).toBe(
      `http://127.0.0.1:${newPort}/oauth/callback`,
    );
  });

  it('removing the server or changing its URL deletes the record', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const patched = await w.api('PATCH', `/api/servers/${OAUTH_SERVER}`, {
      url: `${w.fixture.mcpUrl}?moved=1`,
    });
    expect(patched.status).toBe(200);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    await waitUntil(async () => (await storedRecord(w)) === undefined);
    await w.api('PATCH', `/api/servers/${OAUTH_SERVER}`, { url: w.fixture.mcpUrl });
    await w.signIn();
    await w.api('DELETE', `/api/servers/${OAUTH_SERVER}`);
    await waitUntil(() => !readdirSync(w.t.home.paths.oauthDir).includes(`${OAUTH_SERVER}.json`));
  });
});

describe('call_tool messages', () => {
  it('names the reason and where to sign in, for each needs_auth reason', async () => {
    world = await startOAuthWorld({ fixture: { requiredScope: 'mcp:admin' } });
    const w = world;
    // A server that never connected has no known tools yet: the model is told so.
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    expect(resultText(await w.callTool('notion__echo', { text: 'x' }))).toContain('There is no tool named');

    await w.signIn();
    const more = resultText(await w.callTool('notion__echo', { text: 'x' }));
    expect(more).toContain(
      'The server "notion" needs sign-in in MCPier (More permissions needed (mcp:tools offline_access mcp:admin); sign in again)',
    );
    expect(more).toContain('mcpier auth login notion');
    expect(more).toContain("on the server's page in the MCPier dashboard");

    w.fixture.options.requiredScope = undefined;
    await w.signIn();
    w.fixture.revokeAllTokens();
    const expiredNow = resultText(await w.callTool('notion__echo', { text: 'x' }));
    expect(expiredNow).toContain('needs sign-in in MCPier (Sign-in expired; sign in again)');
    const expiredLater = resultText(await w.callTool('notion__echo', { text: 'x' }));
    expect(expiredLater).toContain('needs sign-in in MCPier (Sign-in expired; sign in again)');

    w.fixture.revokeAllTokens();
    await w.signIn();
    await w.api('POST', AUTH_API_PATHS.logout(OAUTH_SERVER));
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');
    const required = resultText(await w.callTool('notion__echo', { text: 'x' }));
    expect(required).toContain('needs sign-in in MCPier (Sign in required)');
  });
});

describe('no values anywhere', () => {
  it('after a whole sequence, no token, code, verifier, state, client secret or key leaks', async () => {
    // Sprint 7: the server also announces a logo, so an icon is fetched and cached.
    const iconHost = await startIconHost();
    world = await startOAuthWorld({
      fixture: {
        issueClientSecret: true,
        accessTokenLength: 1500,
        requiredScope: 'mcp:admin',
        serverInfo: { icons: [{ src: `${iconHost.origin}/headers.png` }] },
      },
      extra: { icons: { allowLoopbackHttp: true } },
    });
    const w = world;
    const events = await openSse(`${w.t.gateway.url}/api/events`, { authorization: `Bearer ${w.t.token}` });
    const states: string[] = [];
    const remember = (url: string) => states.push(new URL(url).searchParams.get('state')!);

    let started = await w.startSignIn();
    remember(started.authorizationUrl);
    await w.finish(started.authorizationUrl);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
    await w.callTool('notion__echo', { text: 'one' }); // step-up
    w.fixture.options.requiredScope = undefined;
    started = await w.startSignIn();
    remember(started.authorizationUrl);
    await w.finish(started.authorizationUrl);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
    w.fixture.expireAccessTokens();
    await w.callTool('notion__echo', { text: 'two' }); // refresh on 401
    await w.api('POST', AUTH_API_PATHS.refresh(OAUTH_SERVER));
    await w.api('GET', AUTH_API_PATHS.list);
    await w.api('GET', `/api/servers/${OAUTH_SERVER}`);
    await w.api('GET', `/api/servers/${OAUTH_SERVER}/logs?lines=500`);
    await w.api('POST', AUTH_API_PATHS.logout(OAUTH_SERVER));
    await w.callTool('notion__echo', { text: 'three' });
    started = await w.startSignIn();
    remember(started.authorizationUrl);
    await w.api('POST', AUTH_API_PATHS.forget(OAUTH_SERVER));
    // A callback whose error description echoes the client secret MCPier holds for it.
    started = await w.startSignIn();
    remember(started.authorizationUrl);
    const planted = [...w.fixture.issuedValues()].reverse().find((value) => value.startsWith('cs-'))!;
    w.fixture.options.rejectAuthorization = { error: 'access_denied', description: `leak ${planted}` };
    const refused = await w.finish(started.authorizationUrl);
    expect(refused.html).toContain('access_denied (leak [redacted])');

    // Sprint 7: an import carrying a plain client secret (a dry run, then for real), Tester runs
    // in both modes while signed in, the call and usage routes, and the icon fetch and route.
    const IMPORTED = 'imported-client-secret-value-5150';
    const source = {
      mcpServers: {
        box: {
          url: w.fixture.mcpUrl,
          oauth: { clientId: 'box-app', clientSecret: IMPORTED },
          disabled: true,
        },
      },
    };
    expect((await w.api('POST', API_PATHS.import, { source, dryRun: true })).status).toBe(200);
    expect((await w.api('POST', API_PATHS.import, { source })).status).toBe(201);
    expect(await w.secrets.get('box-client-secret')).toBe(IMPORTED);
    w.fixture.options.rejectAuthorization = undefined;
    await w.signIn();
    for (const mode of ['model', 'raw'] as const) {
      const run = await w.api('POST', CALL_LOG_PATHS.test('notion__echo'), {
        mode,
        arguments: { text: mode },
      });
      expect(run.status).toBe(200);
    }
    await w.api('GET', `${CALL_LOG_PATHS.calls}?limit=200`);
    await w.api('GET', `${USAGE_PATH}?range=24h`);
    await waitUntil(() => w.t.gateway.manager.summary(OAUTH_SERVER).icon?.available === true, 15_000);
    const icon = await fetch(`${w.t.gateway.url}${API_PATHS.serverIcon(OAUTH_SERVER)}`, {
      headers: { authorization: `Bearer ${w.t.token}` },
    });
    expect(icon.status).toBe(200);
    expect(iconHost.receivedHeaders().length).toBeGreaterThan(0);
    for (const headers of iconHost.receivedHeaders()) expect(headers).not.toHaveProperty('authorization');
    await new Promise((resolve) => setTimeout(resolve, 300));
    events.close();
    // Stopped, so every queued call-log write is on disk.
    await w.t.gateway.stop('leak check');
    await iconHost.close();

    const key = (await w.secrets.internal().get(OAUTH_KEY_ACCOUNT))!;
    const values = [
      ...w.fixture.issuedValues(),
      ...w.fixture.receivedValues(),
      ...states,
      key,
      IMPORTED,
    ].filter((value) => value.length >= 8);
    expect(values.length).toBeGreaterThan(10);
    const logsDir = w.t.home.paths.logsDir;
    const corpus = [
      ...w.seen,
      events.raw(),
      readFileSync(w.t.home.paths.config, 'utf8'),
      ...readdirSync(logsDir).map((file) => readFileSync(join(logsDir, file), 'utf8')),
      // The call log read raw (with its write-ahead log), and the icon cache's metadata.
      ...[w.t.home.paths.db, `${w.t.home.paths.db}-wal`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file, 'latin1')),
      ...readdirSync(join(w.t.home.dir, 'icons'))
        .filter((file) => file.endsWith('.json'))
        .map((file) => readFileSync(join(w.t.home.dir, 'icons', file), 'utf8')),
    ].join('\n');
    for (const value of values)
      expect(corpus.includes(value), `leaked a value of ${value.length} characters`).toBe(false);
    expect(corpus).not.toMatch(/eyJ[A-Za-z0-9_-]{20}/);
    // The raw database holds the Tester runs and the icon metadata exists: the check saw them.
    expect(corpus).toContain('dashboard-tester');
    expect(readdirSync(join(w.t.home.dir, 'icons'))).toContain(`${OAUTH_SERVER}.json`);
    expect(events.events.some((event) => event.event === 'auth_status')).toBe(true);
  });
});
