import { randomBytes } from 'node:crypto';
import { HANDOFF_CODE_TTL_SECONDS } from '@mcpier/shared';
import { tokensMatch } from '../admin-token.js';

/**
 * One-time codes for the dashboard sign-in hand-off (SPEC 7.3). `mcpier open` asks for a code
 * with the admin token and opens the browser at the hand-off URL; the gateway swaps the code
 * for the admin cookie. Codes live in memory only, expire after 60 seconds, and work once.
 * Several may be live at once.
 */
export class HandoffCodes {
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = HANDOFF_CODE_TTL_SECONDS * 1000,
  ) {}

  /** 32 random bytes, base64url (43 characters). */
  issue(): string {
    this.prune();
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, this.now() + this.ttlMs);
    return code;
  }

  /**
   * True if `candidate` is a live code, which is then used up. Every live code is compared in
   * constant time, so timing says nothing about which (if any) was close.
   */
  consume(candidate: unknown): boolean {
    this.prune();
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 200) return false;
    let found: string | undefined;
    for (const code of this.codes.keys()) {
      if (tokensMatch(candidate, code)) found = code;
    }
    if (found === undefined) return false;
    this.codes.delete(found);
    return true;
  }

  /** Live codes (tests). */
  get size(): number {
    this.prune();
    return this.codes.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }
}

/** The `next` path after sign-in, only if it is a relative path inside the dashboard. */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return '/';
  // One leading slash, no scheme, no protocol-relative or backslash tricks, no control characters.
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  if ([...next].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return '/';
  let path: string;
  try {
    const url = new URL(next, 'http://dashboard.invalid');
    if (url.origin !== 'http://dashboard.invalid') return '/';
    path = url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
  // Not the API, the hand-off routes or the MCP endpoint: those are not dashboard pages.
  if (/^\/(api|auth|mcp|healthz)(\/|$|\?|#)/i.test(path)) return '/';
  return path;
}
