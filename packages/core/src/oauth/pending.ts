import { randomBytes } from 'node:crypto';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { PENDING_SIGN_IN_TTL_SECONDS } from '@mcpier/shared';
import { tokensMatch } from '../admin-token.js';
import type { StoredRegistration } from './store.js';

/** At most this many sign-ins wait at once; a new one past the limit pushes out the oldest. */
export const MAX_PENDING_SIGN_INS = 20;

/**
 * A sign-in waiting for the browser to come back to the callback. It is a snapshot of
 * everything the code exchange needs, so the exchange runs against exactly what the
 * authorization request used (no rediscovery). Memory only: a gateway restart cancels it.
 */
export interface PendingSignIn {
  server: string;
  /** The `state` value (32 random bytes, base64url). Never logged. */
  state: string;
  /** The PKCE verifier. Never logged. */
  codeVerifier: string;
  serverUrl: string;
  issuer: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  /** The client the authorization request named. */
  client: { clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: string };
  /** A registration made for this sign-in, saved only once the sign-in succeeds. */
  newRegistration?: StoredRegistration;
  redirectUri: string;
  resource?: string;
  resourceMetadataUrl?: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
}

export type PendingInput = Omit<PendingSignIn, 'createdAt' | 'expiresAt'>;

/** A fresh `state` value: 32 random bytes, base64url. */
export function newSignInState(): string {
  return randomBytes(32).toString('base64url');
}

/** The pending sign-ins, keyed by nothing an outsider can guess. */
export class PendingSignIns {
  private readonly entries: PendingSignIn[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PENDING_SIGN_IN_TTL_SECONDS * 1000,
  ) {}

  /** Records a new sign-in (its `state` from `newSignInState`); it replaces any earlier one for that server. */
  add(input: PendingInput): PendingSignIn {
    this.prune();
    this.cancel(input.server);
    while (this.entries.length >= MAX_PENDING_SIGN_INS) this.entries.shift();
    const createdAt = this.now();
    const entry: PendingSignIn = {
      ...input,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * The live sign-in with this `state`, which is then used up. Every live state is compared
   * in constant time with no early exit, so timing says nothing about how close a guess was.
   * Unknown, used, expired and malformed values all give undefined.
   */
  take(candidate: unknown): PendingSignIn | undefined {
    this.prune();
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 200) return undefined;
    let found: PendingSignIn | undefined;
    for (const entry of this.entries) {
      if (tokensMatch(candidate, entry.state)) found = entry;
    }
    if (found) this.entries.splice(this.entries.indexOf(found), 1);
    return found;
  }

  /** The waiting sign-in for a server, if any (its expiry is shown; nothing else leaves). */
  forServer(server: string): PendingSignIn | undefined {
    this.prune();
    return this.entries.find((entry) => entry.server === server);
  }

  /** Drops a server's waiting sign-in (sign-out, server removed). */
  cancel(server: string): boolean {
    const index = this.entries.findIndex((entry) => entry.server === server);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  get size(): number {
    this.prune();
    return this.entries.length;
  }

  private prune(): void {
    const now = this.now();
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index]!.expiresAt <= now) this.entries.splice(index, 1);
    }
  }
}
