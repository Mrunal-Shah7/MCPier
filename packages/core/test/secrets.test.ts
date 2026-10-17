import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServerEntrySchema } from '@mcpier/shared';
import {
  buildChildEnv,
  createRedactor,
  FakeSecretStore,
  MissingSecretError,
  redactDeep,
  resolveServerSecrets,
  SecretInputError,
} from '../src/index.js';
import { WindowsSecretStore } from '../src/platform/windows/secret-store.js';

const SECRET = 'ghp_example_value_1234567890';

async function storeWith(values: Record<string, string>): Promise<FakeSecretStore> {
  const store = new FakeSecretStore();
  for (const [name, value] of Object.entries(values)) await store.set(name, value);
  return store;
}

describe('resolveServerSecrets', () => {
  it('passes plain values through and replaces references in env', async () => {
    const entry = ServerEntrySchema.parse({
      name: 'gh',
      transport: 'stdio',
      command: 'x',
      env: { TOKEN: 'secret:github-token', MODE: 'plain', LITERAL: 'Bearer secret:not-a-ref-in-env' },
    });
    const resolved = await resolveServerSecrets(entry, await storeWith({ 'github-token': SECRET }));
    expect(resolved.env).toEqual({ TOKEN: SECRET, MODE: 'plain', LITERAL: 'Bearer secret:not-a-ref-in-env' });
    expect(resolved.headers).toEqual({});
    expect([...resolved.values]).toEqual([['github-token', SECRET]]);
  });

  it('resolves header references, keeping a scheme word', async () => {
    const entry = ServerEntrySchema.parse({
      name: 'web',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret:github-token', 'X-Key': 'secret:api-key', 'X-Plain': 'v' },
    });
    const resolved = await resolveServerSecrets(
      entry,
      await storeWith({ 'github-token': SECRET, 'api-key': 'key-abcdef' }),
    );
    expect(resolved.headers).toEqual({
      Authorization: `Bearer ${SECRET}`,
      'X-Key': 'key-abcdef',
      'X-Plain': 'v',
    });
  });

  it('fails with every missing name and no value', async () => {
    const entry = ServerEntrySchema.parse({
      name: 'gh',
      transport: 'stdio',
      command: 'x',
      env: { A: 'secret:missing-one', B: 'secret:present', C: 'secret:missing-two' },
    });
    const error = await resolveServerSecrets(entry, await storeWith({ present: SECRET })).catch((e) => e);
    expect(error).toBeInstanceOf(MissingSecretError);
    expect((error as MissingSecretError).names).toEqual(['missing-one', 'missing-two']);
    expect(error.message).toBe(
      'Secrets "missing-one", "missing-two" are not set. Set them with: mcpier secret set missing-one, then mcpier secret set missing-two',
    );
    expect(error.message).not.toContain(SECRET);
  });

  it('names a single missing secret and how to set it', async () => {
    const entry = ServerEntrySchema.parse({
      name: 'gh',
      transport: 'stdio',
      command: 'x',
      env: { A: 'secret:github-token' },
    });
    await expect(resolveServerSecrets(entry, new FakeSecretStore())).rejects.toThrow(
      'Secret "github-token" is not set. Set it with: mcpier secret set github-token',
    );
  });
});

describe('redaction', () => {
  it('replaces secret values in text and in nested results', () => {
    const redact = createRedactor(
      new Map([
        ['github-token', SECRET],
        ['tiny', 'abc'],
      ]),
    );
    expect(redact(`token=${SECRET}; again ${SECRET}; abc stays`)).toBe(
      'token=[secret:github-token]; again [secret:github-token]; abc stays',
    );
    const result = redactDeep(
      { content: [{ type: 'text', text: SECRET }], structuredContent: { nested: [SECRET, 1, null] } },
      redact,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.structuredContent.nested).toEqual(['[secret:github-token]', 1, null]);
  });
});

describe('secret stores validate the same way', () => {
  const stores = {
    fake: () => new FakeSecretStore(),
    // The guard runs before any Credential Manager call, so this never touches it.
    windows: () => new WindowsSecretStore('MCPierUnusedTest/'),
  };

  it.each(Object.entries(stores))(
    '%s store rejects bad names and values before storing',
    async (_label, make) => {
      const store = make();
      await expect(store.set('Bad_Name', 'value')).rejects.toBeInstanceOf(SecretInputError);
      await expect(store.set('ok-name', '')).rejects.toThrow('must not be empty');
      await expect(store.set('ok-name', 'x'.repeat(1281))).rejects.toThrow('at most 1280');
      await expect(store.get('Bad_Name')).rejects.toBeInstanceOf(SecretInputError);
    },
  );

  it('fake store round-trips and lists names', async () => {
    const store = new FakeSecretStore();
    await store.set('b-secret', 'value-b');
    await store.set('a-secret', 'value-a');
    expect(await store.get('a-secret')).toBe('value-a');
    expect(await store.listNames()).toEqual(['a-secret', 'b-secret']);
    expect(await store.delete('a-secret')).toBe(true);
    expect(await store.delete('a-secret')).toBe(false);
    expect(await store.get('a-secret')).toBeUndefined();
  });

  it('the real Credential Manager store refuses to run under tests', async () => {
    const real = new WindowsSecretStore();
    await expect(real.listNames()).rejects.toThrow('Refusing to use the real Credential Manager under tests');
    await expect(real.get('anything')).rejects.toThrow('Refusing');
  });
});

describe('buildChildEnv', () => {
  it('prepends extraPath to an existing Path (any case) and applies server env last', () => {
    const env = buildChildEnv({ Path: 'C:\\Windows', HOME: 'h', token: 'old' }, ['C:\\tools', 'D:\\bin'], {
      TOKEN: 'new',
      EXTRA: '1',
    });
    expect(env.Path).toBe(['C:\\tools', 'D:\\bin', 'C:\\Windows'].join(delimiter));
    expect(env.PATH).toBeUndefined();
    expect(env.TOKEN).toBe('new');
    expect(env.token).toBeUndefined();
    expect(env.EXTRA).toBe('1');
    expect(env.HOME).toBe('h');
  });

  it('leaves PATH alone without extraPath', () => {
    expect(buildChildEnv({ PATH: 'p' }, [], {}).PATH).toBe('p');
  });
});
