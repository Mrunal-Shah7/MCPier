// Opt-in test against the REAL Windows Credential Manager. Skipped unless MCPIER_TEST_KEYRING=1.
// It only uses the separate services "MCPierTest/" (secrets) and "MCPierTest-internal" (MCPier's
// own keys), and deletes everything in both before and after, including leftovers from earlier
// interrupted runs. It never lists or reads the real services. Run by hand:
//   MCPIER_TEST_KEYRING=1 pnpm exec vitest run packages/core/test/keyring.opt-in.test.ts
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET_SERVICE, WindowsSecretStore } from '../src/platform/windows/secret-store.js';

const TEST_SERVICE = 'MCPierTest/';
const TEST_INTERNAL_SERVICE = 'MCPierTest-internal';
const enabled = process.platform === 'win32' && process.env.MCPIER_TEST_KEYRING === '1';

type Keyring = typeof import('@napi-rs/keyring');
const keyring = () => createRequire(import.meta.url)('@napi-rs/keyring') as Keyring;

describe.runIf(enabled)('Windows Credential Manager secret store (opt-in)', () => {
  const store = new WindowsSecretStore(TEST_SERVICE);
  const names = ['opt-in-alpha', 'opt-in-beta'];

  /** Deletes every entry of both test services (never the real ones). */
  async function removeAll(): Promise<void> {
    for (const service of [TEST_SERVICE, TEST_INTERNAL_SERVICE]) {
      for (const credential of keyring().findCredentials(service)) {
        new (keyring().Entry)(service, credential.account).deletePassword();
      }
    }
  }

  const remaining = () =>
    [TEST_SERVICE, TEST_INTERNAL_SERVICE].flatMap((service) => keyring().findCredentials(service));

  beforeAll(removeAll);
  afterAll(async () => {
    await removeAll();
    expect(remaining()).toEqual([]);
  });

  it('sets, reads, lists, deletes and confirms the deletion', async () => {
    await store.set(names[0]!, 'value-alpha-1234');
    await store.set(names[1]!, 'value-beta-5678');
    expect(await store.get(names[0]!)).toBe('value-alpha-1234');
    expect(await store.listNames()).toEqual(names);

    // Overwrite keeps one entry.
    await store.set(names[0]!, 'value-alpha-changed');
    expect(await store.get(names[0]!)).toBe('value-alpha-changed');
    expect(await store.listNames()).toEqual(names);

    expect(await store.delete(names[0]!)).toBe(true);
    expect(await store.get(names[0]!)).toBeUndefined();
    expect(await store.delete(names[0]!)).toBe(false);
    expect(await store.listNames()).toEqual([names[1]]);
  });

  it('accepts a value at the 1280-character limit and rejects one over it without storing it', async () => {
    await store.set('opt-in-long', 'x'.repeat(1280));
    expect((await store.get('opt-in-long'))?.length).toBe(1280);
    await expect(store.set('opt-in-over', 'x'.repeat(1281))).rejects.toThrow('at most 1280');
    expect(await store.listNames()).not.toContain('opt-in-over');
  });

  it('keeps test entries out of the production service listing', async () => {
    await store.set('opt-in-gamma', 'value-gamma-0000');
    // The production listing, names only (the guard is bypassed on purpose, read-only).
    const productionNames = keyring()
      .findCredentials(SECRET_SERVICE)
      .map((credential) => credential.account);
    expect(productionNames).not.toContain('opt-in-gamma');
  });

  it('the internal store (Sprint 6): its own test service, apart from the secrets', async () => {
    const internal = store.internal();
    expect(internal.service).toBe(TEST_INTERNAL_SERVICE);
    expect(await internal.get('OptInKey')).toBeUndefined();
    await internal.set('OptInKey', 'internal-value-1111');
    expect(await internal.get('OptInKey')).toBe('internal-value-1111');
    await internal.set('OptInKey', 'internal-value-2222');
    expect(await internal.get('OptInKey')).toBe('internal-value-2222');
    expect(
      keyring()
        .findCredentials(TEST_INTERNAL_SERVICE)
        .map((c) => c.account),
    ).toEqual(['OptInKey']);
    // Never in the secrets listing, and a secret name cannot be an internal account.
    expect(await store.listNames()).not.toContain('OptInKey');
    await expect(internal.set('opt-in-alpha', 'x')).rejects.toThrow();
    expect(await internal.delete('OptInKey')).toBe(true);
    expect(await internal.get('OptInKey')).toBeUndefined();
    expect(await internal.delete('OptInKey')).toBe(false);
  });
});
