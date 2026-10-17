// Drives the OAuth fixture directly by HTTP: discovery, registration, the authorize redirect,
// the token endpoint, refresh with rotation, revocation, and each switch.
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { listenFixture, startOAuthFixture, type OAuthFixture, type RunningFixture } from '../src/index.js';

const REDIRECT = 'http://127.0.0.1:47999/oauth/callback';

let fixture: OAuthFixture | undefined;
let extra: RunningFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  await extra?.close();
  fixture = extra = undefined;
});

async function register(f: OAuthFixture, body: Record<string, unknown> = {}) {
  const response = await fetch(`${f.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      application_type: 'native',
      redirect_uris: [REDIRECT],
      client_name: 'MCPier',
      ...body,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(
  f: OAuthFixture,
  clientId: string,
  challenge: string,
  extraParams: Record<string, string> = {},
) {
  const url = new URL(`${f.issuer}/authorize`);
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'mcp:tools offline_access',
    resource: f.resource,
    ...extraParams,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function token(f: OAuthFixture, fields: Record<string, string>) {
  const response = await fetch(`${f.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string | number> };
}

/** Registers, authorizes and exchanges the code: returns the client ID and tokens. */
async function signIn(f: OAuthFixture) {
  const { body: client } = await register(f);
  const { verifier, challenge } = pkce();
  const back = new URL(await f.approve(authorizeUrl(f, client.client_id!, challenge)));
  const result = await token(f, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: client.client_id!,
    resource: f.resource,
  });
  expect(result.status).toBe(200);
  return { clientId: client.client_id!, tokens: result.body as Record<string, string> };
}

async function listTools(f: OAuthFixture, accessToken: string): Promise<string[]> {
  const client = new Client(
    { name: 'fixture-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe('OAuth fixture', () => {
  it('answers an unauthenticated MCP request with 401 naming its resource metadata, and serves it', async () => {
    fixture = await startOAuthFixture();
    const response = await fetch(fixture.mcpUrl, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${fixture.resourceMetadataUrl}", scope="mcp:tools"`,
    );
    const prm = (await (await fetch(fixture.resourceMetadataUrl)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: fixture.resource, authorization_servers: [fixture.issuer] });
    const metadata = (await (
      await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: fixture.issuer,
      registration_endpoint: `${fixture.issuer}/register`,
      revocation_endpoint: `${fixture.issuer}/revoke`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(metadata.client_id_metadata_document_supported).toBeUndefined();
    expect(metadata.authorization_response_iss_parameter_supported).toBeUndefined();
  });

  it('registers only native clients with loopback redirects', async () => {
    fixture = await startOAuthFixture();
    expect((await register(fixture, { application_type: 'web' })).status).toBe(400);
    expect((await register(fixture, { redirect_uris: ['https://example.com/cb'] })).body.error).toBe(
      'invalid_redirect_uri',
    );
    const ok = await register(fixture);
    expect(ok.status).toBe(201);
    expect(ok.body.client_id).toMatch(/^dyn-/);
    expect(ok.body.client_secret).toBeUndefined();
    expect(fixture.log.registrations.at(-1)).toMatchObject({ application_type: 'native' });
  });

  it('runs the code flow: redirect with code, state and iss; PKCE and resource checked; tools work', async () => {
    fixture = await startOAuthFixture();
    const { body: client } = await register(fixture);
    const { verifier, challenge } = pkce();
    const back = new URL(await fixture.approve(authorizeUrl(fixture, client.client_id!, challenge)));
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-123');
    expect(back.searchParams.get('iss')).toBe(fixture.issuer);
    const code = back.searchParams.get('code')!;
    const base = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id!,
    };

    expect((await token(fixture, { ...base, code_verifier: verifier })).body.error).toBe('invalid_target');
    expect(
      (await token(fixture, { ...base, code_verifier: 'wrong', resource: fixture.resource })).body.error,
    ).toBe('invalid_grant');
    // The code was used up by the failed attempt.
    expect(
      (await token(fixture, { ...base, code_verifier: verifier, resource: fixture.resource })).body.error,
    ).toBe('invalid_grant');

    const { tokens } = await signIn(fixture);
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:tools offline_access',
    });
    expect(tokens.access_token).toMatch(/^eyJ/);
    expect(await listTools(fixture, tokens.access_token!)).toContain('echo');
  });

  it('refreshes with rotation: the old refresh token is used up', async () => {
    fixture = await startOAuthFixture();
    const { clientId, tokens } = await signIn(fixture);
    const refresh = (value: string) =>
      token(fixture!, {
        grant_type: 'refresh_token',
        refresh_token: value,
        client_id: clientId,
        resource: fixture!.resource,
      });
    const first = await refresh(tokens.refresh_token!);
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await refresh(tokens.refresh_token!)).body.error).toBe('invalid_grant');
    expect((await refresh(first.body.refresh_token as string)).status).toBe(200);
    expect(fixture.log.refreshes).toBe(3);
  });

  it('revokes a refresh token and the access tokens of that client', async () => {
    fixture = await startOAuthFixture();
    const { clientId, tokens } = await signIn(fixture);
    const response = await fetch(`${fixture.issuer}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokens.refresh_token!,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }),
    });
    expect(response.status).toBe(200);
    expect(fixture.log.revocations).toEqual([{ hint: 'refresh_token', kind: 'refresh' }]);
    const again = await token(fixture, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: clientId,
      resource: fixture.resource,
    });
    expect(again.body.error).toBe('invalid_grant');
    expect(
      (
        await fetch(fixture.mcpUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(401);
  });

  it('switch: no registration endpoint, with a client registered by hand (and its secret)', async () => {
    fixture = await startOAuthFixture({
      registration: false,
      manualClients: [{ clientId: 'manual-1', clientSecret: 'manual-secret-1' }],
    });
    const metadata = (await (
      await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata.registration_endpoint).toBeUndefined();
    expect((await fetch(`${fixture.issuer}/register`, { method: 'POST', body: '{}' })).status).toBe(404);
    const { verifier, challenge } = pkce();
    const back = new URL(await fixture.approve(authorizeUrl(fixture, 'manual-1', challenge)));
    const fields = {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'manual-1',
      resource: fixture.resource,
    };
    expect((await token(fixture, fields)).body.error).toBe('invalid_client');
    // A second code, this time with the client secret.
    const second = pkce();
    const back2 = new URL(await fixture.approve(authorizeUrl(fixture, 'manual-1', second.challenge)));
    const ok = await token(fixture, {
      ...fields,
      code: back2.searchParams.get('code')!,
      code_verifier: second.verifier,
      client_secret: 'manual-secret-1',
    });
    expect(ok.status).toBe(200);
  });

  it('switch: CIMD, fetching the client ID URL from a local test server', async () => {
    const clientIdUrl = 'https://cimd.example.test/mcpier/client.json';
    extra = await listenFixture(() =>
      Response.json({ client_id: clientIdUrl, client_name: 'MCPier', redirect_uris: [REDIRECT] }),
    );
    fixture = await startOAuthFixture({ cimd: true, resolveClientIdUrl: () => extra!.url });
    const metadata = (await (
      await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    const { challenge } = pkce();
    const back = new URL(await fixture.approve(authorizeUrl(fixture, clientIdUrl, challenge)));
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(fixture.log.cimdFetches).toEqual([clientIdUrl]);
    // A redirect the document does not list is refused.
    const refused = await fetch(
      authorizeUrl(fixture, clientIdUrl, challenge, { redirect_uri: 'http://127.0.0.1:1/x' }),
      {
        redirect: 'manual',
      },
    );
    expect(refused.status).toBe(400);
  });

  it('switches: iss omitted, wrong, and advertised', async () => {
    fixture = await startOAuthFixture({ iss: 'omit', advertiseIss: true });
    const metadata = (await (
      await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    const { body: client } = await register(fixture);
    const { challenge } = pkce();
    const omitted = new URL(await fixture.approve(authorizeUrl(fixture, client.client_id!, challenge)));
    expect(omitted.searchParams.has('iss')).toBe(false);
    fixture.options.iss = 'wrong';
    const wrong = new URL(await fixture.approve(authorizeUrl(fixture, client.client_id!, challenge)));
    expect(wrong.searchParams.get('iss')).not.toBe(fixture.issuer);
  });

  it('switches: token lifetime and length (over 1,280 characters), no refresh tokens', async () => {
    fixture = await startOAuthFixture({
      accessTokenLifetimeSeconds: 2,
      accessTokenLength: 3000,
      refreshTokens: false,
    });
    const { tokens } = await signIn(fixture);
    expect(tokens.access_token).toHaveLength(3000);
    expect(tokens.expires_in).toBe(2);
    expect(tokens.refresh_token).toBeUndefined();
    expect(await listTools(fixture, tokens.access_token!)).toContain('echo');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const expired = await fetch(fixture.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('switches: revoke every token, or only the access tokens', async () => {
    fixture = await startOAuthFixture();
    const { clientId, tokens } = await signIn(fixture);
    fixture.expireAccessTokens();
    expect(
      (
        await fetch(fixture.mcpUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(401);
    const refreshed = await token(fixture, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: clientId,
      resource: fixture.resource,
    });
    expect(refreshed.status).toBe(200);
    fixture.revokeAllTokens();
    const after = await token(fixture, {
      grant_type: 'refresh_token',
      refresh_token: refreshed.body.refresh_token as string,
      client_id: clientId,
      resource: fixture.resource,
    });
    expect(after.body.error).toBe('invalid_grant');
  });

  it('switch: a demanded scope gives 403 insufficient_scope on tools/call only', async () => {
    fixture = await startOAuthFixture({ requiredScope: 'mcp:admin' });
    const { tokens } = await signIn(fixture);
    const client = new Client(
      { name: 't', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(fixture.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
        onInsufficientScope: 'throw',
      }),
    );
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await expect(client.callTool({ name: 'echo', arguments: { text: 'x' } })).rejects.toMatchObject({
      name: 'InsufficientScopeError',
      requiredScope: 'mcp:tools offline_access mcp:admin',
    });
    await client.close();
    expect(fixture.log.mcp.forbidden).toBe(1);
  });

  it('switch: the authorization request is rejected with an error and a description', async () => {
    fixture = await startOAuthFixture({
      rejectAuthorization: { error: 'access_denied', description: 'The user said no' },
    });
    const { body: client } = await register(fixture);
    const back = new URL(await fixture.approve(authorizeUrl(fixture, client.client_id!, pkce().challenge)));
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('error_description')).toBe('The user said no');
    expect(back.searchParams.get('state')).toBe('state-123');
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('switch: the token endpoint drops the connection', async () => {
    fixture = await startOAuthFixture({ tokenEndpointDown: true });
    await expect(token(fixture, { grant_type: 'refresh_token' })).rejects.toThrow(/fetch failed/);
  });
});
