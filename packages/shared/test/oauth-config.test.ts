import { describe, expect, it } from 'vitest';
import {
  cimdDocument,
  oauthRedirectUri,
  referencedSecretNames,
  splitScopes,
  validateConfig,
  type HttpServerEntry,
} from '../src/index.js';

const oauthServer = (extra: Record<string, unknown> = {}) => ({
  name: 'notion',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  auth: 'oauth',
  ...extra,
});

function entryOf(value: unknown): HttpServerEntry {
  const result = validateConfig({ servers: [value] });
  if (!result.ok) throw new Error(result.problems.join('\n'));
  return result.config.servers[0] as HttpServerEntry;
}

function problemsOf(value: unknown): string[] {
  const result = validateConfig({ servers: [value] });
  if (result.ok) throw new Error('expected the entry to be invalid');
  return result.problems;
}

describe('OAuth client fields', () => {
  it('loads an old OAuth entry unchanged (no oauth block)', () => {
    const entry = entryOf(oauthServer());
    expect(entry.auth).toBe('oauth');
    expect(entry.oauth).toBeUndefined();
  });

  it('accepts a client ID, a client secret reference and extra scopes', () => {
    const entry = entryOf(
      oauthServer({
        oauth: {
          clientId: 'abc-123',
          clientSecret: 'secret:notion-client',
          scopes: ['read', 'offline_access'],
        },
      }),
    );
    expect(entry.oauth).toEqual({
      clientId: 'abc-123',
      clientSecret: 'secret:notion-client',
      scopes: ['read', 'offline_access'],
    });
  });

  it('rejects a plain client secret, naming the fix without echoing the value', () => {
    const problems = problemsOf(
      oauthServer({ oauth: { clientId: 'abc', clientSecret: 'plain-value-1234' } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^servers\[0\]\.oauth\.clientSecret: must be a secret reference/);
    expect(problems[0]).toContain('mcpier secret set');
    expect(problems[0]).not.toContain('plain-value-1234');
  });

  it('rejects a malformed reference, a secret without a client ID, empty IDs and scopes with spaces', () => {
    expect(problemsOf(oauthServer({ oauth: { clientId: 'a', clientSecret: 'secret:Bad_Name' } }))[0]).toMatch(
      /clientSecret: is a malformed secret reference/,
    );
    expect(problemsOf(oauthServer({ oauth: { clientSecret: 'secret:client' } }))[0]).toMatch(
      /clientSecret: needs "clientId" too/,
    );
    expect(problemsOf(oauthServer({ oauth: { clientId: '' } }))[0]).toMatch(/clientId: must not be empty/);
    expect(problemsOf(oauthServer({ oauth: { scopes: ['two words'] } }))[0]).toMatch(
      /scopes\[0\]: must be one scope/,
    );
  });

  it('keeps unknown keys inside the oauth block', () => {
    const entry = entryOf(oauthServer({ oauth: { clientId: 'x', futureField: 1 } }));
    expect((entry.oauth as Record<string, unknown>).futureField).toBe(1);
  });

  it('counts the client secret as a referenced secret', () => {
    const entry = entryOf(
      oauthServer({ headers: { 'X-A': 'secret:a' }, oauth: { clientId: 'x', clientSecret: 'secret:b' } }),
    );
    expect(referencedSecretNames(entry)).toEqual(['a', 'b']);
  });
});

describe('OAuth helpers', () => {
  it('builds the loopback redirect URI with 127.0.0.1 and the port', () => {
    expect(oauthRedirectUri(47800)).toBe('http://127.0.0.1:47800/oauth/callback');
  });

  it('builds the CIMD: native public client, loopback redirect, code + refresh', () => {
    expect(cimdDocument('https://example.org/mcpier/client.json', 47999)).toEqual({
      client_id: 'https://example.org/mcpier/client.json',
      client_name: 'MCPier',
      redirect_uris: ['http://127.0.0.1:47999/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    });
  });

  it('splits and unions scopes in first-seen order', () => {
    expect(splitScopes('a b', ['b', 'c'], undefined, '  d  a ')).toEqual(['a', 'b', 'c', 'd']);
  });
});
