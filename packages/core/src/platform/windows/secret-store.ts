import { createRequire } from 'node:module';
import { isSlug } from '@mcpier/shared';
import { checkInternalAccount, checkSecretName, checkSecretValue } from '../secret-checks.js';
import type { InternalSecretStore, SecretStore } from '../types.js';

/** The Credential Manager service every MCPier secret is stored under. */
export const SECRET_SERVICE = 'MCPier/';

/**
 * The service for MCPier's own keys (the OAuth store key). It does not contain `MCPier/`, so
 * enumerating the secrets service never matches it; its accounts are not slugs either.
 */
export const INTERNAL_SECRET_SERVICE = 'MCPier-internal';

type Keyring = typeof import('@napi-rs/keyring');

let keyring: Keyring | undefined;

/** The native module is loaded on first use, so nothing that never touches secrets loads it. */
function loadKeyring(): Keyring {
  keyring ??= createRequire(import.meta.url)('@napi-rs/keyring') as Keyring;
  return keyring;
}

/** Tests must never reach the user's real secrets or keys (the setup sets this variable). */
function guard(service: string): void {
  if (
    (service === SECRET_SERVICE || service === INTERNAL_SECRET_SERVICE) &&
    process.env.MCPIER_TEST_FORBIDDEN_HOME
  ) {
    throw new Error('Refusing to use the real Credential Manager under tests. Use a fake secret store.');
  }
}

/** The internal service that goes with a secrets service (a test service gets its own). */
function internalServiceFor(service: string): string {
  return service === SECRET_SERVICE ? INTERNAL_SECRET_SERVICE : `${service.replace(/\/+$/, '')}-internal`;
}

/** MCPier's own keys in Credential Manager: one generic credential per account. */
export class WindowsInternalSecretStore implements InternalSecretStore {
  constructor(readonly service: string = INTERNAL_SECRET_SERVICE) {}

  private entry(account: string) {
    return new (loadKeyring().AsyncEntry)(this.service, account);
  }

  async get(account: string): Promise<string | undefined> {
    guard(this.service);
    checkInternalAccount(account);
    return (await this.entry(account).getPassword()) ?? undefined;
  }

  async set(account: string, value: string): Promise<void> {
    guard(this.service);
    checkInternalAccount(account);
    checkSecretValue(value);
    await this.entry(account).setPassword(value);
  }

  async delete(account: string): Promise<boolean> {
    guard(this.service);
    checkInternalAccount(account);
    return this.entry(account).deleteCredential();
  }
}

/**
 * Secrets in Windows Credential Manager, one generic credential per secret: service
 * `MCPier/`, account = the secret name (Credential Manager shows the target as
 * `<name>.MCPier/`). Listing enumerates the service, so no names index is kept on disk.
 */
export class WindowsSecretStore implements SecretStore {
  private readonly internalStore: WindowsInternalSecretStore;

  constructor(private readonly service: string = SECRET_SERVICE) {
    this.internalStore = new WindowsInternalSecretStore(internalServiceFor(service));
  }

  internal(): WindowsInternalSecretStore {
    return this.internalStore;
  }

  private entry(name: string) {
    return new (loadKeyring().AsyncEntry)(this.service, name);
  }

  async get(name: string): Promise<string | undefined> {
    guard(this.service);
    checkSecretName(name);
    return (await this.entry(name).getPassword()) ?? undefined;
  }

  async set(name: string, value: string): Promise<void> {
    guard(this.service);
    checkSecretName(name);
    checkSecretValue(value);
    await this.entry(name).setPassword(value);
  }

  async delete(name: string): Promise<boolean> {
    guard(this.service);
    checkSecretName(name);
    return this.entry(name).deleteCredential();
  }

  async listNames(): Promise<string[]> {
    guard(this.service);
    const credentials = await loadKeyring().findCredentialsAsync(this.service);
    // Only the account names are kept; the values the call returns are dropped right here.
    // Only slugs are secret names, so an internal account could never appear even if matched.
    return [...new Set(credentials.map((credential) => credential.account).filter(isSlug))].sort();
  }
}
