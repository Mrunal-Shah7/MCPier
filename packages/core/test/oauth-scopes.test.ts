// Sprint 7, Phase 3: which scopes a sign-in requests. Without configured scopes the request
// must stay exactly what it was in 1.0.0 (these golden strings were captured against the
// Sprint 6 code before the rule changed); with configured scopes, exactly those are requested.
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_API_PATHS, validateConfig, type AuthStatusResponse } from '@mcpier/shared';
import { waitForStatus } from '../../../test/helpers/gateway.js';
import { OAUTH_SERVER, startOAuthWorld, type OAuthWorld } from '../../../test/helpers/oauth.js';

let world: OAuthWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** The `scope` parameter of the last authorization request the fixture received. */
const lastScope = (w: OAuthWorld) => w.fixture.log.authorizations.at(-1)?.scope;

describe('no configured scopes: unchanged from 1.0.0', () => {
  it("the challenge's scope, plus offline_access", async () => {
    world = await startOAuthWorld();
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools offline_access');
    expect(world.fixture.log.registrations[0]?.scope).toBe('mcp:tools offline_access');
  });

  it("without a challenge scope: the resource's scopes_supported, plus offline_access", async () => {
    world = await startOAuthWorld({ fixture: { challengeScope: null } });
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools mcp:admin offline_access');
  });

  it('a step-up sign-in adds the scopes the 403 asked for', async () => {
    world = await startOAuthWorld({ fixture: { requiredScope: 'mcp:admin' } });
    await world.signIn();
    expect((await world.callTool('notion__echo', { text: 'x' })).isError).toBe(true);
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools offline_access mcp:admin');
  });
});

describe('configured scopes: exactly those', () => {
  it('requests exactly the configured scopes plus offline_access, never the granted ones', async () => {
    world = await startOAuthWorld({ server: { oauth: { scopes: ['mcp:tools', 'mcp:admin'] } } });
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools mcp:admin offline_access');
    // Removing a scope from config really removes it at the next sign-in.
    await world.t.gateway.config.update((draft) => {
      (draft.servers[0] as { oauth?: { scopes?: string[] } }).oauth = { scopes: ['mcp:tools'] };
    });
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools offline_access');
  });

  it('adds offline_access only when the authorization server advertises it', async () => {
    world = await startOAuthWorld({
      fixture: { scopesSupported: ['mcp:tools', 'mcp:admin'] },
      server: { oauth: { scopes: ['mcp:tools'] } },
    });
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools');
  });

  it('a step-up sign-in adds the step-up scopes; only that one', async () => {
    world = await startOAuthWorld({
      fixture: { requiredScope: 'mcp:admin' },
      server: { oauth: { scopes: ['mcp:tools'] } },
    });
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools offline_access');
    expect((await world.callTool('notion__echo', { text: 'x' })).isError).toBe(true);
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools offline_access mcp:admin');
    // The step-up is spent: the next sign-in asks for the configured scopes again.
    await world.signIn();
    expect(lastScope(world)).toBe('mcp:tools offline_access');
  });

  it('changing the configured scopes keeps the tokens and says to sign in again', async () => {
    world = await startOAuthWorld({ server: { oauth: { scopes: ['mcp:tools'] } } });
    await world.signIn();
    const status = async () =>
      (await world!.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER))).body.status;
    expect(await status()).toMatchObject({
      signedIn: true,
      scopesChanged: false,
      nextScopes: { scopes: ['mcp:tools', 'offline_access'], source: 'configured' },
    });
    await world.t.gateway.config.update((draft) => {
      (draft.servers[0] as { oauth?: { scopes?: string[] } }).oauth = { scopes: ['mcp:tools', 'mcp:admin'] };
    });
    await waitForStatus(world.t.gateway, OAUTH_SERVER, 'ready');
    expect(await status()).toMatchObject({
      signedIn: true,
      scopesChanged: true,
      grantedScopes: ['mcp:tools', 'offline_access'],
      nextScopes: { scopes: ['mcp:tools', 'mcp:admin', 'offline_access'], source: 'configured' },
    });
    expect((await world.callTool('notion__echo', { text: 'still works' })).isError).toBeFalsy();
  });
});

describe('the next scopes and their source', () => {
  it('decided at sign-in before discovery; the challenge or server metadata after', async () => {
    world = await startOAuthWorld();
    const status = async () =>
      (await world!.api<AuthStatusResponse>('GET', AUTH_API_PATHS.status(OAUTH_SERVER))).body.status;
    expect((await status()).nextScopes).toEqual({ scopes: [], source: 'decided_at_sign_in' });
    await world.signIn();
    expect((await status()).nextScopes).toEqual({
      scopes: ['mcp:tools', 'offline_access'],
      source: 'challenge',
    });
    await world.close();
    world = await startOAuthWorld({ fixture: { challengeScope: null } });
    await world.signIn();
    expect((await status()).nextScopes?.source).toBe('server_metadata');
  });
});

describe('scope validation', () => {
  const entry = (scopes: unknown) => ({
    servers: [
      { name: 'x', transport: 'http', url: 'https://x.example/mcp', auth: 'oauth', oauth: { scopes } },
    ],
  });
  it('accepts RFC 6749 scope tokens and refuses spaces, quotes, backslashes, length and count', () => {
    expect(
      validateConfig(entry(['read:jira-work', 'https://www.googleapis.com/auth/drive.readonly'])).ok,
    ).toBe(true);
    for (const bad of [['two words'], ['quo"te'], ['back\\slash'], ['x'.repeat(129)], ['']]) {
      expect(validateConfig(entry(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateConfig(entry(Array.from({ length: 51 }, (_, i) => `s${i}`))).ok).toBe(false);
    expect(validateConfig(entry(Array.from({ length: 50 }, (_, i) => `s${i}`))).ok).toBe(true);
  });
});
