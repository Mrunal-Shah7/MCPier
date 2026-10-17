import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { isSlug, type NeedsAuthReason, type RegistrationMethod } from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { InternalSecretStore } from '../platform/index.js';

/** The internal Credential Manager account holding the store's 32-byte key (base64url). */
export const OAUTH_KEY_ACCOUNT = 'OAuthStoreKey';

const FORMAT = 'mcpier-oauth-record';
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** How MCPier is registered with a server's authorization server. */
export interface StoredRegistration {
  method: RegistrationMethod;
  clientId: string;
  /** Issued by dynamic registration only (a manual client's secret stays a `secret:` reference). */
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  tokenEndpointAuthMethod?: string;
  /** RFC 7592 management credentials, if the server issued them. */
  registrationAccessToken?: string;
  registrationClientUri?: string;
  /** The redirect URI the registration was made with (it carries the port). */
  redirectUri: string;
  /** The issuer that issued the client ID; a different issuer means registering again. */
  issuer: string;
  registeredAt: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** When the token was received (ms since the epoch). */
  issuedAt: number;
  /** Absolute expiry (ms since the epoch), from `expires_in` when the token was received. */
  expiresAt?: number;
  /** The scope the server granted, as it said. */
  scope?: string;
}

/** Everything MCPier keeps about one OAuth server. Encrypted at rest; never logged. */
export interface OAuthRecord {
  server: string;
  /** The server entry's `url` this record belongs to: tokens are bound to that resource. */
  serverUrl: string;
  /** The RFC 8707 resource indicator sent with authorization and token requests. */
  resource?: string;
  resourceMetadataUrl?: string;
  authorizationServerUrl?: string;
  issuer?: string;
  /** Cached so refresh and revocation need no rediscovery. */
  authorizationServerMetadata?: AuthorizationServerMetadata;
  registration?: StoredRegistration;
  tokens?: StoredTokens;
  grantedScopes?: string[];
  /** Scopes a 403 `insufficient_scope` asked for; the next sign-in requests them too. */
  stepUpScopes?: string[];
  /** Why the server needs signing in, when the tokens were dropped for a reason. */
  problem?: NeedsAuthReason;
  signedInAt?: string;
  lastRefreshAt?: string;
}

/** What the store is reconciled against: the configured OAuth servers. */
export interface OAuthEntryIdentity {
  name: string;
  url: string;
  clientId?: string;
}

interface Envelope {
  format: string;
  version: number;
  iv: string;
  tag: string;
  data: string;
}

/** The ciphertext is bound to the server name, so a record copied to another name fails. */
function aad(server: string): Buffer {
  return Buffer.from(`${FORMAT}:${FORMAT_VERSION}:${server}`, 'utf8');
}

function isRecord(value: unknown, server: string): value is OAuthRecord {
  const record = value as Partial<OAuthRecord> | null;
  if (!record || typeof record !== 'object') return false;
  if (record.server !== server || typeof record.serverUrl !== 'string') return false;
  if (record.tokens !== undefined) {
    const tokens = record.tokens as Partial<StoredTokens>;
    if (typeof tokens.accessToken !== 'string' || typeof tokens.tokenType !== 'string') return false;
  }
  if (record.registration !== undefined) {
    const registration = record.registration as Partial<StoredRegistration>;
    if (typeof registration.clientId !== 'string' || typeof registration.issuer !== 'string') return false;
  }
  return true;
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  // On Windows, antivirus scanners and indexers briefly lock freshly written files.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 9 || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
    }
  }
}

/**
 * One AES-256-GCM-encrypted file per OAuth server in `<data>\oauth\<server>.json`. The key is
 * 32 random bytes in Credential Manager under MCPier's internal service, created on first
 * write. A record that cannot be read (no key, a corrupt or tampered file) counts as absent:
 * the file is renamed `.unreadable` for the user to inspect or delete, and one line is logged
 * without any content. Writes are atomic (temporary file, then rename) and serialized per
 * server. Records are cached in memory after the first read.
 */
export class OAuthStore {
  private readonly cache = new Map<string, OAuthRecord | null>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private key: Buffer | undefined;

  constructor(
    readonly dir: string,
    private readonly secrets: InternalSecretStore,
    private readonly logger: Logger,
  ) {}

  fileOf(server: string): string {
    if (!isSlug(server)) throw new Error(`"${server}" is not a server name.`);
    return join(this.dir, `${server}.json`);
  }

  /** Runs one operation per server at a time, in order. */
  private serialize<T>(server: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(server) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(server, next);
    // Tidy the queue either way. `then(done, done)`, not `finally`: a `finally` chain would
    // re-raise a failed write as an unhandled rejection, and Node ends the process on one
    // (Sprint 5 BUGS B-5). The caller still gets the failure through `next`.
    const done = () => {
      if (this.queues.get(server) === next) this.queues.delete(server);
    };
    void next.then(done, done);
    return next;
  }

  /** The key, or undefined when none exists and `create` is false. */
  private async loadKey(create: boolean): Promise<Buffer | undefined> {
    if (this.key) return this.key;
    const stored = await this.secrets.get(OAUTH_KEY_ACCOUNT);
    if (stored !== undefined) {
      const key = Buffer.from(stored, 'base64url');
      if (key.length !== KEY_BYTES) throw new Error('The OAuth store key in Credential Manager is damaged.');
      this.key = key;
      return key;
    }
    if (!create) return undefined;
    const key = randomBytes(KEY_BYTES);
    await this.secrets.set(OAUTH_KEY_ACCOUNT, key.toString('base64url'));
    this.key = key;
    this.logger.info('Created the OAuth store key in Credential Manager');
    return key;
  }

  /** The record as last read or written, without touching the disk (undefined if not loaded). */
  peek(server: string): OAuthRecord | undefined {
    return this.cache.get(server) ?? undefined;
  }

  /** The record for a server, or undefined. Never throws for a bad file or a missing key. */
  load(server: string): Promise<OAuthRecord | undefined> {
    const cached = this.cache.get(server);
    if (cached !== undefined) return Promise.resolve(cached ?? undefined);
    return this.serialize(server, () => this.read(server));
  }

  private async read(server: string): Promise<OAuthRecord | undefined> {
    const cached = this.cache.get(server);
    if (cached !== undefined) return cached ?? undefined;
    const file = this.fileOf(server);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache.set(server, null);
        return undefined;
      }
      this.logger.warn(
        { server, code: (error as NodeJS.ErrnoException).code },
        'Cannot read the OAuth record',
      );
      return undefined;
    }
    let key: Buffer | undefined;
    try {
      key = await this.loadKey(false);
    } catch (error) {
      // Credential Manager itself failed: treat the record as absent for now, but keep the
      // file, since the problem may pass.
      this.logger.warn(
        { server, err: { message: (error as Error).message } },
        'Cannot read the OAuth store key',
      );
      return undefined;
    }
    const record = key ? this.decrypt(server, text, key) : undefined;
    if (!record) {
      await this.quarantine(server, key ? 'it could not be decrypted' : 'the OAuth store key is missing');
      return undefined;
    }
    this.cache.set(server, record);
    return record;
  }

  private decrypt(server: string, text: string, key: Buffer): OAuthRecord | undefined {
    try {
      const envelope = JSON.parse(text) as Partial<Envelope>;
      if (envelope.format !== FORMAT || envelope.version !== FORMAT_VERSION) return undefined;
      const iv = Buffer.from(String(envelope.iv), 'base64url');
      const tag = Buffer.from(String(envelope.tag), 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(server));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.data), 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const record: unknown = JSON.parse(plain);
      return isRecord(record, server) ? record : undefined;
    } catch {
      return undefined;
    }
  }

  /** Moves an unreadable file aside as `<server>.json.unreadable`; logs one line, no content. */
  private async quarantine(server: string, why: string): Promise<void> {
    const file = this.fileOf(server);
    const target = `${file}.unreadable`;
    try {
      await renameWithRetry(file, target);
      this.logger.warn({ server, file: target }, `OAuth record unreadable (${why}); sign in again`);
    } catch (error) {
      this.logger.warn(
        { server, code: (error as NodeJS.ErrnoException).code },
        `OAuth record unreadable (${why}) and could not be moved aside`,
      );
    }
    this.cache.set(server, null);
  }

  /** Encrypts and writes a record atomically. */
  save(record: OAuthRecord): Promise<void> {
    const snapshot = structuredClone(record);
    return this.serialize(record.server, () => this.write(snapshot));
  }

  private async write(record: OAuthRecord): Promise<void> {
    const server = record.server;
    const key = (await this.loadKey(true))!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(server));
    const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      format: FORMAT,
      version: FORMAT_VERSION,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      data: data.toString('base64url'),
    };
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileOf(server);
    const tmp = join(this.dir, `.${server}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(tmp, 'wx');
      try {
        await handle.writeFile(JSON.stringify(envelope), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tmp, file);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
    this.cache.set(server, record);
  }

  /**
   * Reads, changes and writes a record as one step, serialized with every other operation on
   * that server. Returning undefined deletes the record.
   */
  update(
    server: string,
    change: (record: OAuthRecord | undefined) => OAuthRecord | undefined,
  ): Promise<OAuthRecord | undefined> {
    return this.serialize(server, async () => {
      const current = await this.read(server);
      const next = change(current ? structuredClone(current) : undefined);
      if (next === undefined) {
        if (current) await this.unlink(server);
        return undefined;
      }
      await this.write(structuredClone(next));
      return next;
    });
  }

  /** Deletes a server's record. Returns true if one existed. */
  remove(server: string): Promise<boolean> {
    this.cache.set(server, null);
    return this.serialize(server, () => this.unlink(server));
  }

  private async unlink(server: string): Promise<boolean> {
    this.cache.set(server, null);
    try {
      await fs.unlink(this.fileOf(server));
      this.logger.info({ server }, 'OAuth record deleted');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Brings the folder in line with the configured OAuth servers: a record whose server is
   * gone (or no longer uses OAuth) is deleted; so is one made for a different `url` (its
   * tokens were bound to the old resource, and the authorization server may differ) or for a
   * different manual client ID. Cached records are dropped at once, before any file work, so
   * a server restarted by the same config change never sees stale tokens.
   */
  async reconcile(entries: readonly OAuthEntryIdentity[]): Promise<string[]> {
    const wanted = new Map(entries.map((entry) => [entry.name, entry]));
    const stale = (record: OAuthRecord, entry: OAuthEntryIdentity) =>
      record.serverUrl !== entry.url ||
      (record.registration?.method === 'manual' && record.registration.clientId !== entry.clientId) ||
      (entry.clientId !== undefined &&
        record.registration !== undefined &&
        record.registration.method !== 'manual');
    for (const [server, record] of this.cache) {
      const entry = wanted.get(server);
      if (record && (!entry || stale(record, entry))) this.cache.set(server, null);
    }
    let names: string[];
    try {
      names = (await fs.readdir(this.dir))
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .filter(isSlug);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const removed: string[] = [];
    for (const server of names) {
      const entry = wanted.get(server);
      let remove = !entry;
      if (entry) {
        // Read the file itself: the cache may already have been cleared above.
        this.cache.delete(server);
        const record = await this.load(server);
        remove = record !== undefined && stale(record, entry);
      }
      if (remove && (await this.remove(server))) removed.push(server);
    }
    return removed;
  }

  /** Waits for every queued write (shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queued) => queued.catch(() => {})));
  }
}
