import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGatewayLogger,
  ensureDataDir,
  FakeSecretStore,
  getPlatform,
  type GatewayLogger,
} from '../src/index.js';
import { OAUTH_KEY_ACCOUNT, OAuthStore, type OAuthRecord } from '../src/oauth/store.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

const ACCESS = `eyJ${'a'.repeat(2997)}`; // longer than Credential Manager's 1,280-character limit
const REFRESH = 'rt-refresh-token-value-0123456789';
const CLIENT_SECRET = 'cs-dynamic-client-secret-value';

function record(server: string, extra: Partial<OAuthRecord> = {}): OAuthRecord {
  return {
    server,
    serverUrl: 'https://mcp.example.com/mcp',
    resource: 'https://mcp.example.com/mcp',
    issuer: 'https://auth.example.com',
    authorizationServerUrl: 'https://auth.example.com',
    registration: {
      method: 'dynamic',
      clientId: 'client-1',
      clientSecret: CLIENT_SECRET,
      redirectUri: 'http://127.0.0.1:47800/oauth/callback',
      issuer: 'https://auth.example.com',
      registeredAt: new Date().toISOString(),
    },
    tokens: {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    },
    grantedScopes: ['read'],
    ...extra,
  };
}

let home: TempHome;
let log: GatewayLogger;
let secrets: FakeSecretStore;
let logFile: string;

const newStore = () => new OAuthStore(home.paths.oauthDir, secrets.internal(), log.logger);
const logText = () => readFileSync(logFile, 'utf8');
const fileText = (server: string) => readFileSync(join(home.paths.oauthDir, `${server}.json`), 'utf8');

beforeEach(() => {
  home = createTempHome();
  // The log sits next to the home, so the home itself can still be created by ensureDataDir.
  logFile = join(home.dir, '..', 'test.log');
  log = createGatewayLogger({ file: logFile });
  secrets = new FakeSecretStore();
});

afterEach(async () => {
  log.close();
  await home.cleanup();
});

describe('OAuth store', () => {
  it('round-trips a record through an encrypted file, across store instances', async () => {
    const original = record('notion');
    await newStore().save(original);
    expect(await newStore().load('notion')).toEqual(original);
    // The key lives in the internal store, created on first write, 32 bytes.
    expect(secrets.internal().accounts()).toEqual([OAUTH_KEY_ACCOUNT]);
    expect(Buffer.from((await secrets.internal().get(OAUTH_KEY_ACCOUNT))!, 'base64url')).toHaveLength(32);
  });

  it('stores tokens longer than 1,280 characters', async () => {
    await newStore().save(record('long'));
    expect((await newStore().load('long'))?.tokens?.accessToken).toBe(ACCESS);
  });

  it('never writes a token, client secret or the key in plain form', async () => {
    const store = newStore();
    await store.save(record('notion'));
    const text = fileText('notion');
    const key = (await secrets.internal().get(OAUTH_KEY_ACCOUNT))!;
    for (const value of [
      ACCESS.slice(0, 40),
      REFRESH,
      CLIENT_SECRET,
      key,
      'client-1',
      'auth.example.com',
      'refresh_token',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text.startsWith('eyJ')).toBe(false);
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'version', 'iv', 'tag', 'data']);
    for (const value of [ACCESS.slice(0, 40), REFRESH, CLIENT_SECRET, key])
      expect(logText()).not.toContain(value);
  });

  it('uses a fresh nonce on every write', async () => {
    const store = newStore();
    await store.save(record('notion'));
    const first = JSON.parse(fileText('notion')) as { iv: string; data: string };
    await store.save(record('notion'));
    const second = JSON.parse(fileText('notion')) as { iv: string; data: string };
    expect(second.iv).not.toBe(first.iv);
    expect(second.data).not.toBe(first.data);
  });

  it('detects tampering: the record is absent and the file is moved aside', async () => {
    await newStore().save(record('notion'));
    const envelope = JSON.parse(fileText('notion')) as { data: string };
    const bytes = Buffer.from(envelope.data, 'base64url');
    bytes[5] = bytes[5]! ^ 0xff;
    envelope.data = bytes.toString('base64url');
    writeFileSync(join(home.paths.oauthDir, 'notion.json'), JSON.stringify(envelope));

    expect(await newStore().load('notion')).toBeUndefined();
    expect(existsSync(join(home.paths.oauthDir, 'notion.json'))).toBe(false);
    expect(existsSync(join(home.paths.oauthDir, 'notion.json.unreadable'))).toBe(true);
    const lines = logText()
      .split('\n')
      .filter((line) => line.includes('OAuth record unreadable'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be decrypted');
    expect(lines[0]).not.toContain(envelope.data.slice(0, 20));
  });

  it('refuses a record copied under another server name', async () => {
    await newStore().save(record('alpha'));
    writeFileSync(join(home.paths.oauthDir, 'beta.json'), fileText('alpha'));
    expect(await newStore().load('beta')).toBeUndefined();
    expect(existsSync(join(home.paths.oauthDir, 'beta.json.unreadable'))).toBe(true);
    expect(await newStore().load('alpha')).toBeDefined();
  });

  it('treats a missing key as no record, without crashing', async () => {
    await newStore().save(record('notion'));
    await secrets.internal().delete(OAUTH_KEY_ACCOUNT);
    expect(await newStore().load('notion')).toBeUndefined();
    expect(existsSync(join(home.paths.oauthDir, 'notion.json.unreadable'))).toBe(true);
    expect(logText()).toContain('the OAuth store key is missing');
    // A new key is created on the next write, and the new record reads back.
    const store = newStore();
    await store.save(record('notion'));
    expect(await newStore().load('notion')).toBeDefined();
  });

  it('renames a corrupt file to .unreadable and logs one line without content', async () => {
    mkdirSync(home.paths.oauthDir, { recursive: true });
    writeFileSync(join(home.paths.oauthDir, 'broken.json'), '{ not json at all eyJsecret');
    await secrets.internal().set(OAUTH_KEY_ACCOUNT, Buffer.alloc(32, 7).toString('base64url'));
    expect(await newStore().load('broken')).toBeUndefined();
    expect(readdirSync(home.paths.oauthDir)).toEqual(['broken.json.unreadable']);
    expect(logText()).not.toContain('eyJsecret');
    expect(logText().match(/OAuth record unreadable/g)).toHaveLength(1);
  });

  it('removes a record on request and reports whether one existed', async () => {
    const store = newStore();
    await store.save(record('notion'));
    expect(await store.remove('notion')).toBe(true);
    expect(await store.remove('notion')).toBe(false);
    expect(await newStore().load('notion')).toBeUndefined();
  });

  it('reconcile: deletes records of removed servers', async () => {
    const store = newStore();
    await store.save(record('kept'));
    await store.save(record('gone'));
    expect(await store.reconcile([{ name: 'kept', url: 'https://mcp.example.com/mcp' }])).toEqual(['gone']);
    expect(readdirSync(home.paths.oauthDir)).toEqual(['kept.json']);
  });

  it('reconcile: drops a record whose server URL changed, even one never loaded before', async () => {
    await newStore().save(record('moved'));
    const store = newStore();
    expect(await store.reconcile([{ name: 'moved', url: 'https://elsewhere.example.com/mcp' }])).toEqual([
      'moved',
    ]);
    expect(await store.load('moved')).toBeUndefined();
  });

  it('reconcile: drops a cached record at once, before the file work finishes', async () => {
    const store = newStore();
    await store.save(record('moved'));
    expect(await store.load('moved')).toBeDefined();
    const pending = store.reconcile([{ name: 'moved', url: 'https://elsewhere.example.com/mcp' }]);
    expect(await store.load('moved')).toBeUndefined();
    await pending;
  });

  it('reconcile: drops a record made for a different manual client ID, or before one was configured', async () => {
    const store = newStore();
    await store.save(
      record('manual', { registration: { ...record('x').registration!, method: 'manual', clientId: 'old' } }),
    );
    await store.save(record('dynamic'));
    const removed = await store.reconcile([
      { name: 'manual', url: 'https://mcp.example.com/mcp', clientId: 'new' },
      { name: 'dynamic', url: 'https://mcp.example.com/mcp', clientId: 'configured-now' },
    ]);
    expect(removed.sort()).toEqual(['dynamic', 'manual']);
  });

  it('serializes concurrent updates of one server', async () => {
    const store = newStore();
    await store.save(record('notion', { grantedScopes: [] }));
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update('notion', (current) => ({
          ...current!,
          grantedScopes: [...current!.grantedScopes!, `s${index}`],
        })),
      ),
    );
    expect((await newStore().load('notion'))?.grantedScopes).toHaveLength(10);
  });

  it('keeps the internal key out of the secret listing', async () => {
    await secrets.set('github-token', 'ghp-value-1234');
    await newStore().save(record('notion'));
    expect(await secrets.listNames()).toEqual(['github-token']);
  });
});

describe.runIf(process.platform === 'win32')('OAuth folder permissions (Windows)', () => {
  it('inherits the data directory restriction: only the current user and SYSTEM', async () => {
    await ensureDataDir(home.dir, getPlatform());
    await newStore().save(record('notion'));
    for (const target of [home.paths.oauthDir, join(home.paths.oauthDir, 'notion.json')]) {
      const output = execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        [target],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      const entries = output
        .replace(target, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes(':('));
      expect(entries).toHaveLength(2);
      expect(entries.some((entry) => entry.startsWith('NT AUTHORITY\\SYSTEM:'))).toBe(true);
      expect(
        entries.some((entry) => entry.toLowerCase().includes(`\\${process.env.USERNAME!.toLowerCase()}:`)),
      ).toBe(true);
    }
  });
});
