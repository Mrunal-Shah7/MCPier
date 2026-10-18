// Finding a server's logo (Sprint 7), in order of preference:
//   1. the entry's `icon` field (an https URL, a local file, or "none");
//   2. the server's own `serverInfo.icons` (SEP-973), choosing by theme, size and type;
//   3. the favicon of `serverInfo.websiteUrl`;
//   4. the favicon of the server URL's site (HTTP servers): its own origin, then the registrable
//      domain, then `www.` of it;
//   5. nothing: the dashboard draws the letter tile.
// Every network call goes through the one `IconFetcher`; no third-party favicon service is used.
import { readFile, stat } from 'node:fs/promises';
import type { IconSource, ServerEntry } from '@mcpier/shared';
import type { UpstreamIcon, UpstreamServerInfo } from '../upstream/types.js';
import { registrableDomain, sameSite, withoutQuery } from './domains.js';
import {
  decodeDataUri,
  ICON_IMAGE_LIMIT,
  ICON_PAGE_LIMIT,
  IconFetchError,
  type IconFetcher,
} from './fetcher.js';
import { sniffImage, type IconContentType } from './image-type.js';

export type IconTheme = 'light' | 'dark';
export type IconVariantName = 'default' | IconTheme;

export interface IconVariant {
  bytes: Uint8Array;
  contentType: IconContentType;
  /** Where it came from, without a query string (`file`, `data:…` or a URL). */
  url: string;
}

/** One thing that was tried, for the log line (no query strings, no values). */
export interface IconAttempt {
  source: IconSource;
  url: string;
  result: string;
  bytes?: number;
}

export type IconDiscovery =
  | {
      kind: 'found';
      source: IconSource;
      variants: { default: IconVariant; light?: IconVariant; dark?: IconVariant };
      attempts: IconAttempt[];
    }
  /** `icon: "none"`: always the letter tile. */
  | { kind: 'disabled'; attempts: IconAttempt[] }
  | { kind: 'not_found'; attempts: IconAttempt[] };

export interface DiscoverInput {
  entry: ServerEntry;
  /** What the server said about itself, when it has connected. */
  serverInfo?: UpstreamServerInfo;
}

/** Most links tried from one page, so a page full of icon tags cannot keep the fetcher busy. */
const MAX_PAGE_LINKS = 4;

class Attempts {
  readonly list: IconAttempt[] = [];
  add(source: IconSource, url: string, result: string, bytes?: number): void {
    this.list.push({
      source,
      url: url.startsWith('data:') ? 'data:…' : withoutQuery(url),
      result,
      ...(bytes !== undefined ? { bytes } : {}),
    });
  }
}

/** Reads and checks one image from a URL or a `data:` URI. Throws `IconFetchError` with the reason. */
async function fetchImage(fetcher: IconFetcher, url: string): Promise<IconVariant> {
  if (url.startsWith('data:')) {
    const decoded = decodeDataUri(url, ICON_IMAGE_LIMIT);
    if (!decoded) throw new IconFetchError('a malformed or oversized data: URI');
    const type = sniffImage(decoded.bytes);
    if (!type) throw new IconFetchError('not an accepted image');
    return { bytes: decoded.bytes, contentType: type, url: 'data:…' };
  }
  const body = await fetcher.get(
    url,
    ICON_IMAGE_LIMIT,
    'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
  );
  if (!body.complete) throw new IconFetchError(`larger than ${ICON_IMAGE_LIMIT / 1024} KB`);
  const type = sniffImage(body.bytes);
  if (!type) throw new IconFetchError('not an accepted image');
  return { bytes: body.bytes, contentType: type, url: withoutQuery(body.url) };
}

async function readLocalImage(path: string): Promise<IconVariant> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new IconFetchError('the file cannot be read');
  }
  if (size > ICON_IMAGE_LIMIT) throw new IconFetchError(`larger than ${ICON_IMAGE_LIMIT / 1024} KB`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new IconFetchError('the file cannot be read');
  }
  const type = sniffImage(bytes);
  if (!type) throw new IconFetchError('not an accepted image');
  return { bytes, contentType: type, url: 'file' };
}

// ---- Choosing among the server's own icons

/** The declared pixel sizes (`"48x48 96x96"`, `"any"`): the largest edge of each, `Infinity` for any. */
function declaredSizes(sizes: readonly string[] | undefined): number[] {
  const out: number[] = [];
  for (const entry of sizes ?? []) {
    for (const part of entry.split(/\s+/)) {
      if (part.toLowerCase() === 'any') out.push(Number.POSITIVE_INFINITY);
      const match = /^(\d+)x(\d+)$/i.exec(part);
      if (match) out.push(Math.max(Number(match[1]), Number(match[2])));
    }
  }
  return out;
}

function typeOf(icon: { src: string; mimeType?: string }): string {
  if (icon.mimeType) return icon.mimeType.toLowerCase();
  if (icon.src.startsWith('data:')) return (/^data:([^;,]*)/.exec(icon.src)?.[1] ?? '').toLowerCase();
  const path = (() => {
    try {
      return new URL(icon.src).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return '';
}

/**
 * Lower is better: an icon of at least 64 px, closest to 64 (any size, an SVG, counts as a
 * perfect fit), before smaller ones and ones without sizes; then PNG, WebP or SVG.
 */
function rank(icon: UpstreamIcon): [number, number, number] {
  const sizes = declaredSizes(icon.sizes);
  const big = sizes.filter((size) => size >= 64);
  const sizeRank: [number, number] =
    big.length > 0
      ? [0, Math.min(...big.map((size) => (size === Number.POSITIVE_INFINITY ? 0 : size - 64)))]
      : sizes.length > 0
        ? [1, 64 - Math.max(...sizes)]
        : [2, 0];
  const type = typeOf(icon);
  const typeRank = ['image/png', 'image/webp', 'image/svg+xml'].includes(type) ? 0 : 1;
  return [sizeRank[0], sizeRank[1], typeRank];
}

function ordered(icons: UpstreamIcon[]): UpstreamIcon[] {
  return icons
    .map((icon, index) => ({ icon, key: [...rank(icon), index] }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
      return 0;
    })
    .map((entry) => entry.icon);
}

/** Whether a `serverInfo.icons` URL may be fetched for this server (Confirmed decision 14). */
function iconUrlAccepted(
  entry: ServerEntry,
  src: string,
  websiteUrl: string | undefined,
  fetcher: IconFetcher,
): boolean {
  if (src.startsWith('data:')) return true;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (!fetcher.allowed(url)) return false;
  // The user chose to run a stdio program: any https host is accepted.
  if (entry.transport === 'stdio') return true;
  const hosts = [entry.url, websiteUrl].flatMap((value) => {
    try {
      return value ? [new URL(value).hostname] : [];
    } catch {
      return [];
    }
  });
  return hosts.some((host) => sameSite(url.hostname, host));
}

// ---- Favicons of a site

interface PageLink {
  href: string;
  apple: boolean;
  size: number;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replace(/&amp;/g, '&').trim();
}

/** The `<link rel="…icon…">` tags of a page, apple-touch-icon first, then the largest declared. */
export function pageIconLinks(html: string, pageUrl: string): string[] {
  const links: PageLink[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attribute(tag, 'href');
    if (!href) continue;
    const apple = rel.some(
      (token) => token === 'apple-touch-icon' || token === 'apple-touch-icon-precomposed',
    );
    if (!apple && !rel.includes('icon')) continue;
    const sizes = declaredSizes([attribute(tag, 'sizes') ?? '']);
    const size = sizes.length > 0 ? Math.max(...sizes) : apple ? 180 : 0;
    let resolved: string;
    try {
      resolved = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    links.push({ href: resolved, apple, size });
  }
  links.sort((a, b) => Number(b.apple) - Number(a.apple) || b.size - a.size);
  return [...new Set(links.map((link) => link.href))];
}

/** The favicon of one site: its page's icon links, then `/favicon.ico`. */
async function siteFavicon(
  fetcher: IconFetcher,
  pageUrl: string,
  source: IconSource,
  attempts: Attempts,
): Promise<IconVariant | undefined> {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (!fetcher.allowed(page)) {
    attempts.add(source, pageUrl, 'not https');
    return undefined;
  }
  const candidates: string[] = [];
  try {
    const body = await fetcher.get(page.href, ICON_PAGE_LIMIT, 'text/html,application/xhtml+xml');
    // Reading stops at the limit; the links are in the head, so a partial page is still read.
    const html = new TextDecoder('utf-8').decode(body.bytes);
    candidates.push(...pageIconLinks(html, body.url).slice(0, MAX_PAGE_LINKS));
  } catch (error) {
    attempts.add(source, page.href, `page: ${(error as Error).message}`);
  }
  candidates.push(new URL('/favicon.ico', page).href);
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!fetcher.allowed(new URL(candidate))) {
        attempts.add(source, candidate, 'not https');
        continue;
      }
      const image = await fetchImage(fetcher, candidate);
      attempts.add(source, candidate, 'ok', image.bytes.byteLength);
      return image;
    } catch (error) {
      attempts.add(source, candidate, (error as Error).message);
    }
  }
  return undefined;
}

/** The bases tried for an HTTP server's own site: its origin, the registrable domain, then www. */
export function domainBases(serverUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return [];
  }
  const bases = [`${url.protocol}//${url.host}/`];
  const domain = registrableDomain(url.hostname);
  if (domain) bases.push(`https://${domain}/`, `https://www.${domain}/`);
  return [...new Set(bases)];
}

/** Finds the icon for a server (see the module comment). Never throws. */
export async function discoverIcon(input: DiscoverInput, fetcher: IconFetcher): Promise<IconDiscovery> {
  const { entry, serverInfo } = input;
  const attempts = new Attempts();

  // 1. The override.
  if (entry.icon === 'none') return { kind: 'disabled', attempts: attempts.list };
  if (entry.icon !== undefined) {
    try {
      const image = /^https?:\/\//i.test(entry.icon)
        ? await fetchImage(fetcher, entry.icon)
        : await readLocalImage(entry.icon);
      attempts.add(
        'config',
        /^https?:/i.test(entry.icon) ? entry.icon : 'file',
        'ok',
        image.bytes.byteLength,
      );
      return { kind: 'found', source: 'config', variants: { default: image }, attempts: attempts.list };
    } catch (error) {
      attempts.add('config', /^https?:/i.test(entry.icon) ? entry.icon : 'file', (error as Error).message);
    }
  }

  // 2. The server's own icons: the best per theme; both kept when it gave a light and a dark one.
  const icons = (serverInfo?.icons ?? []).filter((icon) => {
    const accepted = iconUrlAccepted(entry, icon.src, serverInfo?.websiteUrl, fetcher);
    if (!accepted) attempts.add('server', icon.src, 'refused: not https, or another site than the server');
    return accepted;
  });
  if (icons.length > 0) {
    const pick = async (list: UpstreamIcon[]): Promise<IconVariant | undefined> => {
      for (const icon of ordered(list)) {
        try {
          const image = await fetchImage(fetcher, icon.src);
          attempts.add('server', icon.src, 'ok', image.bytes.byteLength);
          return image;
        } catch (error) {
          attempts.add('server', icon.src, (error as Error).message);
        }
      }
      return undefined;
    };
    const light = await pick(icons.filter((icon) => icon.theme === 'light'));
    const dark = await pick(icons.filter((icon) => icon.theme === 'dark'));
    const plain = await pick(icons.filter((icon) => icon.theme === undefined));
    const chosen = plain ?? light ?? dark;
    if (chosen) {
      return {
        kind: 'found',
        source: 'server',
        variants: { default: chosen, ...(light && dark ? { light, dark } : {}) },
        attempts: attempts.list,
      };
    }
  }

  // 3. The website the server named.
  const tried = new Set<string>();
  if (serverInfo?.websiteUrl) {
    const image = await siteFavicon(fetcher, serverInfo.websiteUrl, 'website', attempts);
    try {
      tried.add(new URL(serverInfo.websiteUrl).origin);
    } catch {
      // not a URL; already recorded
    }
    if (image)
      return { kind: 'found', source: 'website', variants: { default: image }, attempts: attempts.list };
  }

  // 4. The server URL's own site (HTTP servers only).
  if (entry.transport === 'http') {
    for (const base of domainBases(entry.url)) {
      const origin = new URL(base).origin;
      if (tried.has(origin)) continue;
      tried.add(origin);
      const image = await siteFavicon(fetcher, base, 'domain', attempts);
      if (image)
        return { kind: 'found', source: 'domain', variants: { default: image }, attempts: attempts.list };
    }
  }

  return { kind: 'not_found', attempts: attempts.list };
}
