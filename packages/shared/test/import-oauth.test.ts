// Sprint 7, Phase 3: the importer's OAuth shapes and the client-secret plan (D-031 updated).
import { describe, expect, it } from 'vitest';
import {
  KEEP_CLIENT_SECRET_MESSAGE,
  parseImportBlock,
  planClientSecrets,
  validateConfig,
} from '../src/index.js';

const URL = 'https://mcp.example.com/mcp';
const one = (entry: Record<string, unknown>) =>
  parseImportBlock({ mcpServers: { remote: { url: URL, ...entry } } });

describe('OAuth shapes', () => {
  it.each([
    ['camelCase', { clientId: 'id-1', clientSecret: 'secret:remote-secret', scopes: ['read', 'write'] }],
    ['snake_case', { client_id: 'id-1', client_secret: 'secret:remote-secret', scope: 'read write' }],
  ])('an oauth block (%s): client ID, secret reference and scopes', (_label, block) => {
    const { candidates, errors } = one({ oauth: block });
    expect(errors).toEqual([]);
    expect(candidates[0]!.entry).toMatchObject({
      auth: 'oauth',
      oauth: { clientId: 'id-1', clientSecret: 'secret:remote-secret', scopes: ['read', 'write'] },
    });
    expect(candidates[0]!.oauth).toEqual({
      clientId: 'id-1',
      scopes: ['read', 'write'],
      clientSecret: { kind: 'reference', reference: 'secret:remote-secret' },
    });
    expect(candidates[0]!.ignored).toEqual([]);
    expect(validateConfig({ servers: [candidates[0]!.entry] }).ok).toBe(true);
  });

  it('"oauth": true, "auth": "oauth" and "auth": { "type": "oauth" } all set auth to oauth', () => {
    for (const shape of [{ oauth: true }, { auth: 'oauth' }, { auth: { type: 'oauth', scopes: 'a b' } }]) {
      const { candidates } = one(shape);
      expect(candidates[0]!.entry.auth, JSON.stringify(shape)).toBe('oauth');
      expect(candidates[0]!.oauth).toBeDefined();
    }
    expect(one({ auth: { type: 'oauth', scopes: 'a b' } }).candidates[0]!.entry.oauth).toEqual({
      scopes: ['a', 'b'],
    });
    expect(one({ oauth: true }).candidates[0]!.entry).not.toHaveProperty('oauth');
  });

  it('"enabled": false keeps auth none and drops the block, naming the fields, a plain secret included', () => {
    const { candidates } = one({
      oauth: { enabled: false, clientId: 'x', clientSecret: 'plain-value-6161' },
    });
    const candidate = candidates[0]!;
    expect(candidate.entry).not.toHaveProperty('auth');
    expect(candidate.entry).not.toHaveProperty('oauth');
    expect(candidate.oauth).toBeUndefined();
    expect(candidate.notes).toEqual([expect.stringContaining('dropped: clientId, clientSecret')]);
    expect(JSON.stringify(candidate)).not.toContain('plain-value-6161');
  });

  it('reports other block fields as ignored, by name only', () => {
    const { candidates } = one({ oauth: { clientId: 'x', redirectUri: 'http://cb', callbackPort: 3334 } });
    expect(candidates[0]!.ignored).toEqual(['oauth.redirectUri', 'oauth.callbackPort']);
    expect(one({ auth: { type: 'oauth', authorizationUrl: 'https://a' } }).candidates[0]!.ignored).toEqual([
      'auth.authorizationUrl',
    ]);
  });

  it('ignores an oauth block on a stdio entry, with a note', () => {
    const { candidates } = parseImportBlock({
      mcpServers: { local: { command: 'node', oauth: { clientId: 'x' } } },
    });
    expect(candidates[0]!.entry).not.toHaveProperty('oauth');
    expect(candidates[0]!.ignored).toEqual(['oauth']);
    expect(candidates[0]!.notes).toEqual([expect.stringContaining('ignored for this stdio server')]);
  });
});

describe('planClientSecrets', () => {
  const block = {
    mcpServers: {
      alpha: { url: URL, oauth: { clientId: 'a', clientSecret: 'plain-alpha-7171' } },
      beta: { url: URL, oauth: { clientId: 'b', client_secret: 'plain-beta-7272' } },
      gamma: { url: URL, oauth: { clientId: 'c', clientSecret: 'secret:existing-ref' } },
      delta: { command: 'node' },
    },
  };

  it('moves every plain client secret, suffixing taken names; an existing reference stays', () => {
    const parsed = parseImportBlock(structuredClone(block));
    const { moves } = planClientSecrets(parsed, ['alpha-client-secret', 'alpha-client-secret-2']);
    expect(moves).toEqual([
      { server: 'alpha', secretName: 'alpha-client-secret-3', value: 'plain-alpha-7171' },
      { server: 'beta', secretName: 'beta-client-secret', value: 'plain-beta-7272' },
    ]);
    const byName = Object.fromEntries(parsed.candidates.map((candidate) => [candidate.name, candidate]));
    expect(byName.alpha!.entry.oauth).toEqual({
      clientId: 'a',
      clientSecret: 'secret:alpha-client-secret-3',
    });
    expect(byName.alpha!.oauth!.clientSecret).toEqual({ kind: 'plain', movedTo: 'alpha-client-secret-3' });
    expect(byName.gamma!.entry.oauth).toEqual({ clientId: 'c', clientSecret: 'secret:existing-ref' });
    // Nothing that is kept, previewed or validated holds a value any more.
    const shown = JSON.stringify(parsed.candidates);
    expect(shown).not.toContain('plain-alpha-7171');
    expect(shown).not.toContain('plain-beta-7272');
    for (const candidate of parsed.candidates)
      expect(validateConfig({ servers: [candidate.entry] }).ok).toBe(true);
  });

  it('with keepSecrets, an entry with a plain client secret is an error; the others go on', () => {
    const parsed = parseImportBlock(structuredClone(block));
    const { moves } = planClientSecrets(parsed, [], { keepSecrets: true });
    expect(moves).toEqual([]);
    expect(parsed.candidates.map((candidate) => candidate.name)).toEqual(['gamma', 'delta']);
    expect(parsed.errors).toEqual([
      { key: 'alpha', message: KEEP_CLIENT_SECRET_MESSAGE },
      { key: 'beta', message: KEEP_CLIENT_SECRET_MESSAGE },
    ]);
    expect(KEEP_CLIENT_SECRET_MESSAGE).toContain('a client secret is always stored in Credential Manager');
  });
});
