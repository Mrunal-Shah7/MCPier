import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a wrapped `requestState` stays valid. */
export const REQUEST_STATE_TTL_MS = 15 * 60_000;

const PREFIX = 'mcpier1';

/** What MCPier's own `requestState` carries. */
export interface WrappedState {
  /** Server name. */
  server: string;
  /** Full tool name the state was issued for. */
  tool: string;
  /** The upstream's `requestState`, opaque: never parsed, logged or recorded. */
  upstream?: string;
  /** Expiry, ms since the epoch. */
  expiresAt: number;
}

export type StateCheck =
  | { ok: true; state: WrappedState }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'tool_mismatch' };

/**
 * Signs and checks MCPier's `requestState` for `input_required` pass-through (SPEC 4.3):
 * `mcpier1.<base64url JSON>.<base64url HMAC-SHA256>`, keyed by the `state-key` file. Nothing
 * is stored: the state itself carries the server, tool, upstream state and expiry.
 */
export class RequestStateSigner {
  constructor(
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = REQUEST_STATE_TTL_MS,
  ) {}

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(`${PREFIX}.${body}`).digest();
  }

  sign(state: Omit<WrappedState, 'expiresAt'>): string {
    const payload = { s: state.server, t: state.tool, u: state.upstream, e: this.now() + this.ttlMs };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${PREFIX}.${body}.${this.mac(body).toString('base64url')}`;
  }

  /** Signature first (constant time), then expiry, then that it belongs to `tool`. */
  verify(token: unknown, tool: string): StateCheck {
    if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2])
      return { ok: false, reason: 'malformed' };
    const expected = this.mac(parts[1]);
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: 'signature' };
    }
    let payload: { s?: unknown; t?: unknown; u?: unknown; e?: unknown };
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof payload.s !== 'string' || typeof payload.t !== 'string' || typeof payload.e !== 'number') {
      return { ok: false, reason: 'malformed' };
    }
    if (payload.e <= this.now()) return { ok: false, reason: 'expired' };
    if (payload.t !== tool) return { ok: false, reason: 'tool_mismatch' };
    return {
      ok: true,
      state: {
        server: payload.s,
        tool: payload.t,
        ...(typeof payload.u === 'string' ? { upstream: payload.u } : {}),
        expiresAt: payload.e,
      },
    };
  }
}
