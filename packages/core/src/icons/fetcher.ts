// The one way MCPier fetches anything for an icon (Sprint 7). `https` only, at most 3 redirects
// (each to `https`), 5 seconds in all, a byte limit (reading stops there), and a plain user
// agent. No cookies, no Authorization header and none of the server's configured headers: this
// fetcher never sees them. Tests may allow plain `http` to loopback hosts through an option the
// gateway never sets.

export type IconFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface IconFetcherOptions {
  /** The network call (tests pass a fake or a fixture host). Defaults to the global `fetch`. */
  fetchFn?: IconFetch;
  /** `MCPier/<version>`. */
  userAgent: string;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Tests only: plain `http` to 127.0.0.1, ::1 or localhost. The gateway never sets this. */
  allowLoopbackHttp?: boolean;
}

export const ICON_TIMEOUT_MS = 5_000;
export const ICON_MAX_REDIRECTS = 3;
/** Largest image read (reading stops there and the image is refused). */
export const ICON_IMAGE_LIMIT = 256 * 1024;
/** Most of a web page read when looking for its icon links. */
export const ICON_PAGE_LIMIT = 512 * 1024;

/** Why a fetch gave nothing usable: a short, value-free reason for the log. */
export class IconFetchError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'IconFetchError';
  }
}

export interface FetchedBody {
  bytes: Uint8Array;
  /** Where the body really came from, after redirects. */
  url: string;
  /** The declared type (never trusted on its own). */
  contentType?: string;
  /** False when the body was longer than the limit and reading stopped. */
  complete: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

export class IconFetcher {
  private readonly fetchFn: IconFetch;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(private readonly options: IconFetcherOptions) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? ICON_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? ICON_MAX_REDIRECTS;
  }

  /** Whether a URL may be fetched at all: `https`, or loopback `http` when tests allow it. */
  allowed(url: URL): boolean {
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && this.options.allowLoopbackHttp === true && LOOPBACK.has(url.hostname);
  }

  /** GETs a URL, following up to 3 redirects by hand, and reads at most `limit` bytes. */
  async get(target: string, limit: number, accept: string): Promise<FetchedBody> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new IconFetchError('not a URL');
    }
    for (let redirects = 0; ; redirects++) {
      if (!this.allowed(url)) throw new IconFetchError(`${url.protocol.replace(':', '')} is not allowed`);
      let response: Response;
      try {
        response = await this.fetchFn(url.href, {
          method: 'GET',
          redirect: 'manual',
          // Exactly these headers: nothing of the server's, no cookies, no credentials.
          headers: { 'user-agent': this.options.userAgent, accept },
          signal,
        });
      } catch (error) {
        throw new IconFetchError(
          signal.aborted ? 'timed out' : `unreachable (${(error as Error)?.name ?? 'error'})`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) throw new IconFetchError(`redirect without a location (${response.status})`);
        if (redirects >= this.maxRedirects) throw new IconFetchError('too many redirects');
        try {
          url = new URL(location, url);
        } catch {
          throw new IconFetchError('redirect to something that is not a URL');
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        throw new IconFetchError(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? undefined;
      const { bytes, complete } = await readLimited(response, limit, signal);
      return { bytes, url: url.href, complete, ...(contentType ? { contentType } : {}) };
    }
  }
}

async function readLimited(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), complete: true };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new IconFetchError('timed out');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { bytes: concat(chunks, limit), complete: false };
      }
    }
  } catch (error) {
    if (error instanceof IconFetchError) throw error;
    throw new IconFetchError(signal.aborted ? 'timed out' : 'the body could not be read');
  }
  return { bytes: concat(chunks, size), complete: true };
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= length) break;
  }
  return out;
}

/** A `data:` URI's bytes and declared type, or undefined when it is malformed or over `limit`. */
export function decodeDataUri(
  uri: string,
  limit: number,
): { bytes: Uint8Array; contentType?: string } | undefined {
  const match = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!match) return undefined;
  const meta = match[1]!;
  const payload = match[2]!;
  const base64 = /;base64$/i.test(meta);
  const contentType =
    meta
      .replace(/;base64$/i, '')
      .split(';')[0]!
      .trim() || undefined;
  // A rough bound before decoding: base64 is 4 characters per 3 bytes.
  if ((base64 ? (payload.length * 3) / 4 : payload.length) > limit * 3) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = base64
      ? new Uint8Array(Buffer.from(payload.replace(/\s+/g, ''), 'base64'))
      : new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
  if (bytes.byteLength > limit) return undefined;
  return { bytes, ...(contentType ? { contentType } : {}) };
}
