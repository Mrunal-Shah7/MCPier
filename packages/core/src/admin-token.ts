import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import type { Platform } from './platform/index.js';

/** 32 random bytes, base64url-encoded (43 characters). */
export function generateAdminToken(): string {
  return randomBytes(32).toString('base64url');
}

async function readTokenFile(file: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(file, 'utf8')).trim();
    return value.length > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Creates the admin token file if it is missing or empty. The file is created empty and
 * restricted to the current user *before* the token is written into it, so the value is
 * never readable by anyone else, even briefly. Returns true if a new token was written.
 */
export async function ensureAdminToken(file: string, platform: Platform): Promise<boolean> {
  return ensureRestrictedSecretFile(file, platform, generateAdminToken);
}

/**
 * Creates a secret file (admin token, state key) if it is missing or empty: created empty,
 * restricted to the current user, and only then filled. If the restriction fails the file
 * is deleted and the error thrown (fail closed). Returns true if a new value was written.
 */
export async function ensureRestrictedSecretFile(
  file: string,
  platform: Platform,
  generate: () => string,
): Promise<boolean> {
  if ((await readTokenFile(file)) !== undefined) return false;

  // Create the file exclusively, so two processes setting up the same data directory at
  // once (two bridges on a first run) never write two different values.
  try {
    await (await fs.open(file, 'wx')).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another process is filling it in, or an empty file was left behind: wait for a value.
    // An empty file is taken over only once it is stale (no process takes 5 s to fill it).
    for (;;) {
      if ((await readTokenFile(file)) !== undefined) return false;
      const age = Date.now() - (await fs.stat(file)).mtimeMs;
      if (age > 5000) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fs.writeFile(file, '', { encoding: 'utf8' });
  }
  try {
    await platform.files.restrictToCurrentUser(file, 'file');
  } catch (error) {
    // Fail closed: never keep a secret file whose permissions could not be restricted.
    await fs.unlink(file).catch(() => {});
    throw error;
  }
  await fs.writeFile(file, generate(), { encoding: 'utf8' });
  return true;
}

/** Creates the `state-key` file (32 random bytes, base64url) if missing. */
export function ensureStateKey(file: string, platform: Platform): Promise<boolean> {
  return ensureRestrictedSecretFile(file, platform, () => randomBytes(32).toString('base64url'));
}

/** Reads the HMAC key for `requestState` signing. */
export function readStateKey(file: string): Buffer {
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
  if (key.length < 32)
    throw new Error(`The state key file ${file} is damaged. Delete it and restart MCPier.`);
  return key;
}

/** Reads the admin token. Throws a clear error (never containing the token) if missing. */
export function readAdminToken(file: string): string {
  let value: string;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No admin token found at ${file}. Start the gateway once to create it.`, {
        cause: error,
      });
    }
    throw new Error(
      `Cannot read the admin token file ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
      {
        cause: error,
      },
    );
  }
  if (!value)
    throw new Error(`The admin token file ${file} is empty. Start the gateway to create a new token.`);
  return value;
}

/**
 * Constant-time token comparison. Both sides are hashed first so inputs of different
 * lengths take the same time and never reach `timingSafeEqual` with unequal sizes.
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
