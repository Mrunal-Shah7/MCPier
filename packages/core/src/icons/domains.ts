// Registrable domains with the Public Suffix List, private section included (Sprint 7). A server
// on a shared host such as `foo.vercel.app` has the registrable domain `foo.vercel.app`, so the
// host platform's own site (and its logo) is never taken for the server's.
import { parse } from 'tldts';

/**
 * The registrable domain of a host (`mcp.notion.com` → `notion.com`), or undefined for IP
 * addresses, `localhost` and anything the list cannot place.
 */
export function registrableDomain(host: string): string | undefined {
  const parsed = parse(host.toLowerCase().replace(/\.$/, ''), { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain) return undefined;
  return parsed.domain;
}

/** Same registrable domain; for hosts without one (IP addresses, localhost), the same host. */
export function sameSite(hostA: string, hostB: string): boolean {
  const a = hostA.toLowerCase();
  const b = hostB.toLowerCase();
  const domainA = registrableDomain(a);
  const domainB = registrableDomain(b);
  if (domainA === undefined || domainB === undefined) return a === b;
  return domainA === domainB;
}

/** `https://example.com/path?x` → `https://example.com/path`: URLs are logged and stored without queries. */
export function withoutQuery(url: string | URL): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:') return 'data:…';
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return '(not a URL)';
  }
}
