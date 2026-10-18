// Sprint 7, Phase 2: server icons. File-type checks, registrable domains, the discovery order,
// the transport's safety rules (against a fake network keyed by host, so real-looking domains
// can be used), and the cache's timers with an injected clock.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEntry } from '@mcpier/shared';
import { ICON_HOST_FILES, pngIco, solidPng } from '@mcpier/test-fixtures';
import {
  createGatewayLogger,
  discoverIcon,
  ensureDataDir,
  getPlatform,
  domainBases,
  ICON_FAILURE_RETRY_MS,
  ICON_REFRESH_AFTER_MS,
  IconFetcher,
  IconService,
  pageIconLinks,
  registrableDomain,
  sameSite,
  sniffImage,
  type GatewayLogger,
  type IconFetch,
} from '../src/index.js';
import { createTempHome, type TempHome } from '../../../test/helpers/temp-home.js';

type Handler = () => Response;

/** A fake network: `https://host/path` → handler. Records every request with its headers. */
function fakeNet(routes: Record<string, Record<string, Handler | Buffer | string>>) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: IconFetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const route = routes[`${parsed.protocol}//${parsed.host}`]?.[parsed.pathname];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (typeof route === 'function') return route();
    if (typeof route === 'string') return new Response(route, { headers: { 'content-type': 'text/html' } });
    return new Response(new Uint8Array(route), { headers: { 'content-type': 'image/png' } });
  };
  return { fetchFn, requests, fetcher: new IconFetcher({ fetchFn, userAgent: 'MCPier/test' }) };
}

const redirect =
  (location: string): Handler =>
  () =>
    new Response(null, { status: 302, headers: { location } });

const httpEntry = (url: string, extra: Partial<ServerEntry> = {}): ServerEntry =>
  ({
    name: 'remote',
    transport: 'http',
    url,
    headers: {},
    auth: 'none',
    enabled: true,
    timeoutMs: 60_000,
    disabledTools: [],
    protocol: 'auto',
    startupTimeoutMs: 90_000,
    ...extra,
  }) as ServerEntry;

const stdioEntry = (extra: Partial<ServerEntry> = {}): ServerEntry =>
  ({
    name: 'local',
    transport: 'stdio',
    command: 'node',
    args: [],
    env: {},
    enabled: true,
    timeoutMs: 60_000,
    disabledTools: [],
    protocol: 'auto',
    startupTimeoutMs: 90_000,
    ...extra,
  }) as ServerEntry;

const PNG_A = solidPng(64, [1, 2, 3]);
const PNG_B = solidPng(128, [4, 5, 6]);
const PAGE = `<html><head><link rel="shortcut icon" href="/f.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png"></head></html>`;

describe('file types by their bytes', () => {
  it('recognises PNG, JPEG, GIF, WebP and ICO by their first bytes, and an SVG root', () => {
    expect(sniffImage(PNG_A)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe(
      'image/webp',
    );
    expect(sniffImage(pngIco(PNG_A, 64))).toBe('image/x-icon');
    expect(sniffImage(ICON_HOST_FILES.svg)).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('﻿<!-- logo --><!DOCTYPE svg><svg viewBox="0 0 1 1"/>'))).toBe(
      'image/svg+xml',
    );
  });

  it('refuses HTML named .png, an SVG with a script, entities, and anything else', () => {
    expect(sniffImage(ICON_HOST_FILES.fakePng)).toBeUndefined();
    expect(sniffImage(ICON_HOST_FILES.scriptSvg)).toBeUndefined();
    expect(sniffImage(Buffer.from('<svg onload="x()"></svg>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('<html><svg/></html>'))).toBeUndefined();
    expect(sniffImage(new Uint8Array([0, 0, 1, 0, 0, 0]))).toBeUndefined();
    expect(sniffImage(new Uint8Array([0xc3, 0x28]))).toBeUndefined();
  });
});

describe('registrable domains', () => {
  it('uses the Public Suffix List with its private section', () => {
    expect(registrableDomain('mcp.atlassian.com')).toBe('atlassian.com');
    expect(registrableDomain('mcp.notion.com')).toBe('notion.com');
    expect(registrableDomain('api.githubcopilot.com')).toBe('githubcopilot.com');
    expect(registrableDomain('foo.vercel.app')).toBe('foo.vercel.app');
    expect(registrableDomain('127.0.0.1')).toBeUndefined();
    expect(registrableDomain('localhost')).toBeUndefined();
    expect(sameSite('cdn.notion.com', 'mcp.notion.com')).toBe(true);
    expect(sameSite('bar.vercel.app', 'foo.vercel.app')).toBe(false);
    expect(sameSite('127.0.0.1', '127.0.0.1')).toBe(true);
  });

  it('tries the URL origin, then the domain, then www; a shared host never reaches the platform', () => {
    expect(domainBases('https://mcp.notion.com/mcp')).toEqual([
      'https://mcp.notion.com/',
      'https://notion.com/',
      'https://www.notion.com/',
    ]);
    expect(domainBases('https://foo.vercel.app/api/mcp')).toEqual([
      'https://foo.vercel.app/',
      'https://www.foo.vercel.app/',
    ]);
    expect(
      domainBases('https://foo.vercel.app/api/mcp').some((base) => /\/\/(www\.)?vercel\.app\//.test(base)),
    ).toBe(false);
  });

  it('reads page links: apple-touch-icon first, then the largest declared icon', () => {
    const html = `<link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/any.svg" sizes="any">
      <link href='/touch.png' rel='apple-touch-icon'><link rel="mask-icon" href="/mask.svg"><link rel="stylesheet" href="/x.css">`;
    expect(pageIconLinks(html, 'https://a.example/page')).toEqual([
      'https://a.example/touch.png',
      'https://a.example/any.svg',
      'https://a.example/16.png',
    ]);
  });
});

describe('discovery order', () => {
  it('1. the icon field wins: an https URL, a local file, or "none"', async () => {
    const net = fakeNet({ 'https://img.example': { '/logo.png': PNG_A } });
    const fromUrl = await discoverIcon(
      { entry: httpEntry('https://mcp.example.com/mcp', { icon: 'https://img.example/logo.png' }) },
      net.fetcher,
    );
    expect(fromUrl).toMatchObject({ kind: 'found', source: 'config' });

    const home = createTempHome();
    mkdirSync(home.dir, { recursive: true });
    const file = join(home.dir, 'logo.png');
    writeFileSync(file, PNG_B);
    const fromFile = await discoverIcon({ entry: stdioEntry({ icon: file }) }, net.fetcher);
    expect(fromFile).toMatchObject({ kind: 'found', source: 'config' });
    if (fromFile.kind === 'found')
      expect(Buffer.from(fromFile.variants.default.bytes).equals(PNG_B)).toBe(true);
    writeFileSync(join(home.dir, 'fake.png'), ICON_HOST_FILES.fakePng);
    const fake = await discoverIcon({ entry: stdioEntry({ icon: join(home.dir, 'fake.png') }) }, net.fetcher);
    expect(fake.kind).toBe('not_found');
    await home.cleanup();

    const none = await discoverIcon(
      {
        entry: httpEntry('https://mcp.example.com/mcp', { icon: 'none' }),
        serverInfo: { icons: [{ src: 'https://mcp.example.com/a.png' }] },
      },
      net.fetcher,
    );
    expect(none.kind).toBe('disabled');
    expect(net.requests.filter((request) => request.url.includes('mcp.example.com'))).toHaveLength(0);
  });

  it('2. the server icons: closest to 64 px and at least 64, PNG preferred; data: URIs work', async () => {
    const net = fakeNet({
      'https://mcp.example.com': { '/32.png': PNG_A, '/96.png': PNG_B, '/512.png': PNG_A, '/64.jpg': PNG_A },
    });
    const found = await discoverIcon(
      {
        entry: httpEntry('https://mcp.example.com/mcp'),
        serverInfo: {
          icons: [
            { src: 'https://mcp.example.com/32.png', sizes: ['32x32'] },
            { src: 'https://mcp.example.com/512.png', sizes: ['512x512'] },
            { src: 'https://mcp.example.com/96.png', sizes: ['96x96'], mimeType: 'image/png' },
          ],
        },
      },
      net.fetcher,
    );
    expect(found).toMatchObject({ kind: 'found', source: 'server' });
    if (found.kind === 'found') expect(found.variants.default.url).toBe('https://mcp.example.com/96.png');

    const data = `data:image/png;base64,${PNG_A.toString('base64')}`;
    const fromData = await discoverIcon(
      { entry: stdioEntry(), serverInfo: { icons: [{ src: data }] } },
      net.fetcher,
    );
    expect(fromData).toMatchObject({ kind: 'found', source: 'server' });
    if (fromData.kind === 'found') expect(fromData.variants.default.url).toBe('data:…');
  });

  it('2. separate light and dark icons are both kept', async () => {
    const net = fakeNet({
      'https://x.example': { '/light.png': ICON_HOST_FILES.light, '/dark.png': ICON_HOST_FILES.dark },
    });
    const found = await discoverIcon(
      {
        entry: stdioEntry(),
        serverInfo: {
          icons: [
            { src: 'https://x.example/light.png', theme: 'light' },
            { src: 'https://x.example/dark.png', theme: 'dark' },
          ],
        },
      },
      net.fetcher,
    );
    expect(found.kind).toBe('found');
    if (found.kind !== 'found') return;
    expect(Buffer.from(found.variants.light!.bytes).equals(ICON_HOST_FILES.light)).toBe(true);
    expect(Buffer.from(found.variants.dark!.bytes).equals(ICON_HOST_FILES.dark)).toBe(true);
  });

  it('3. the website favicon when the server has no usable icons; 4. the URL site after that', async () => {
    const net = fakeNet({
      'https://www.acme.example': { '/': PAGE, '/touch.png': PNG_B },
      'https://mcp.acme.example': { '/favicon.ico': pngIco(PNG_A, 64) },
    });
    const fromWebsite = await discoverIcon(
      {
        entry: httpEntry('https://mcp.acme.example/mcp'),
        serverInfo: { websiteUrl: 'https://www.acme.example/' },
      },
      net.fetcher,
    );
    expect(fromWebsite).toMatchObject({ kind: 'found', source: 'website' });
    if (fromWebsite.kind === 'found')
      expect(fromWebsite.variants.default.url).toBe('https://www.acme.example/touch.png');

    const fromDomain = await discoverIcon({ entry: httpEntry('https://mcp.acme.example/mcp') }, net.fetcher);
    expect(fromDomain).toMatchObject({ kind: 'found', source: 'domain' });
    if (fromDomain.kind === 'found') expect(fromDomain.variants.default.contentType).toBe('image/x-icon');
  });

  it('4. falls through the URL origin to the registrable domain, then www', async () => {
    const net = fakeNet({ 'https://www.acme.example': { '/favicon.ico': pngIco(PNG_A, 32) } });
    const found = await discoverIcon({ entry: httpEntry('https://mcp.acme.example/mcp') }, net.fetcher);
    expect(found).toMatchObject({ kind: 'found', source: 'domain' });
    expect(net.requests.map((request) => request.url)).toEqual([
      'https://mcp.acme.example/',
      'https://mcp.acme.example/favicon.ico',
      'https://acme.example/',
      'https://acme.example/favicon.ico',
      'https://www.acme.example/',
      'https://www.acme.example/favicon.ico',
    ]);
  });

  it('5. nothing usable: not found (the letter tile); a stdio server has no domain to try', async () => {
    const net = fakeNet({});
    expect((await discoverIcon({ entry: httpEntry('https://mcp.none.example/mcp') }, net.fetcher)).kind).toBe(
      'not_found',
    );
    const stdio = fakeNet({});
    expect((await discoverIcon({ entry: stdioEntry() }, stdio.fetcher)).kind).toBe('not_found');
    expect(stdio.requests).toHaveLength(0);
  });
});

describe('safety', () => {
  it('refuses an icon URL on another registrable domain for an HTTP server (any https host for stdio)', async () => {
    const net = fakeNet({ 'https://evil.example': { '/logo.png': PNG_A } });
    const icons = { icons: [{ src: 'https://evil.example/logo.png' }] };
    const http = await discoverIcon(
      { entry: httpEntry('https://mcp.good.example/mcp'), serverInfo: icons },
      net.fetcher,
    );
    expect(http.kind).toBe('not_found');
    expect(net.requests.some((request) => request.url.startsWith('https://evil.example'))).toBe(false);
    expect(http.attempts[0]).toMatchObject({ source: 'server', result: expect.stringContaining('refused') });
    const stdio = await discoverIcon({ entry: stdioEntry(), serverInfo: icons }, net.fetcher);
    expect(stdio).toMatchObject({ kind: 'found', source: 'server' });
    // The website's registrable domain counts too.
    const viaWebsite = await discoverIcon(
      {
        entry: httpEntry('https://mcp.good.example/mcp'),
        serverInfo: { ...icons, websiteUrl: 'https://www.evil.example/' },
      },
      net.fetcher,
    );
    expect(viaWebsite).toMatchObject({ kind: 'found', source: 'server' });
  });

  it('refuses http (only tests may allow loopback http)', async () => {
    const net = fakeNet({ 'http://plain.example': { '/logo.png': PNG_A } });
    const found = await discoverIcon(
      { entry: stdioEntry(), serverInfo: { icons: [{ src: 'http://plain.example/logo.png' }] } },
      net.fetcher,
    );
    expect(found.kind).toBe('not_found');
    expect(net.requests).toHaveLength(0);
    expect(net.fetcher.allowed(new URL('http://127.0.0.1:1/x'))).toBe(false);
    const loopback = new IconFetcher({ fetchFn: net.fetchFn, userAgent: 'x', allowLoopbackHttp: true });
    expect(loopback.allowed(new URL('http://127.0.0.1:1/x'))).toBe(true);
    expect(loopback.allowed(new URL('http://plain.example/x'))).toBe(false);
  });

  it('follows at most 3 redirects, each to https', async () => {
    const net = fakeNet({
      'https://r.example': {
        '/3': redirect('/2'),
        '/2': redirect('/1'),
        '/1': redirect('/logo.png'),
        '/4': redirect('/3'),
        '/to-http': redirect('http://r.example/logo.png'),
        '/logo.png': PNG_A,
      },
      'http://r.example': { '/logo.png': PNG_A },
    });
    const get = (path: string) => net.fetcher.get(`https://r.example${path}`, 1024 * 1024, 'image/*');
    await expect(get('/3')).resolves.toMatchObject({ url: 'https://r.example/logo.png', complete: true });
    await expect(get('/4')).rejects.toThrow('too many redirects');
    await expect(get('/to-http')).rejects.toThrow('http is not allowed');
    expect(net.requests.some((request) => request.url.startsWith('http://'))).toBe(false);
  });

  it('stops reading at 256 KB and refuses the image; refuses HTML named .png', async () => {
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 64 * 1024;
            controller.enqueue(new Uint8Array(64 * 1024));
            if (pulled > 10 * 1024 * 1024) controller.close();
          },
        }),
      );
    const net = fakeNet({
      'https://x.example': {
        '/big.png': ICON_HOST_FILES.big,
        '/endless.png': endless,
        '/fake.png': ICON_HOST_FILES.fakePng,
      },
    });
    const run = (src: string) =>
      discoverIcon({ entry: stdioEntry(), serverInfo: { icons: [{ src }] } }, net.fetcher);
    const big = await run('https://x.example/big.png');
    expect(big.kind).toBe('not_found');
    expect(big.attempts[0]!.result).toContain('larger than 256 KB');
    await run('https://x.example/endless.png');
    expect(pulled).toBeLessThan(512 * 1024);
    const fake = await run('https://x.example/fake.png');
    expect(fake.attempts[0]!.result).toBe('not an accepted image');
  });

  it('sends only a user agent and an accept header', async () => {
    const net = fakeNet({ 'https://x.example': { '/logo.png': PNG_A } });
    await discoverIcon(
      { entry: stdioEntry(), serverInfo: { icons: [{ src: 'https://x.example/logo.png' }] } },
      net.fetcher,
    );
    expect(Object.keys(net.requests[0]!.headers).sort()).toEqual(['accept', 'user-agent']);
    expect(net.requests[0]!.headers['user-agent']).toBe('MCPier/test');
  });
});

describe('the cache', () => {
  let home: TempHome;
  let log: GatewayLogger;
  let clock: number;
  let dir: string;

  beforeEach(() => {
    home = createTempHome();
    mkdirSync(home.dir, { recursive: true });
    dir = join(home.dir, 'icons');
    log = createGatewayLogger({ file: join(home.dir, '..', 'icons.log') });
    clock = Date.parse('2026-10-17T10:00:00Z');
  });
  afterEach(async () => {
    log.close();
    await home.cleanup();
  });

  const service = (fetchFn: IconFetch) =>
    new IconService({
      dir,
      fetcher: new IconFetcher({ fetchFn, userAgent: 'x' }),
      logger: log.logger,
      now: () => clock,
    });

  it('stores files with metadata, reuses them within 7 days, fetches again after', async () => {
    const net = fakeNet({ 'https://x.example': { '/logo.png': PNG_A } });
    const icons = service(net.fetchFn);
    const entry = stdioEntry();
    const info = { icons: [{ src: 'https://x.example/logo.png?token=hidden' }] };
    await icons.consider(entry, info, 'ready');
    expect(icons.info('local')).toMatchObject({ available: true, source: 'server' });
    expect(readdirSync(dir).sort()).toEqual(['local.json', 'local.png']);
    const meta = JSON.parse(readFileSync(join(dir, 'local.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({
      source: 'server',
      variants: { default: { contentType: 'image/png', url: 'https://x.example/logo.png' } },
    });
    expect(JSON.stringify(meta)).not.toContain('hidden');
    expect(icons.file('local')!.etag).toMatch(/^"[0-9a-f]{32}"$/);

    clock += ICON_REFRESH_AFTER_MS - 1000;
    await icons.consider(entry, info, 'ready');
    expect(net.requests).toHaveLength(1);
    clock += 2000;
    await icons.consider(entry, info, 'ready');
    expect(net.requests).toHaveLength(2);
    // A new service reads what is on disk.
    expect(service(net.fetchFn).info('local')).toMatchObject({ available: true, source: 'server' });
  });

  it('remembers a failure for a day; refresh ignores both timers', async () => {
    const net = fakeNet({});
    const icons = service(net.fetchFn);
    const entry = httpEntry('https://mcp.down.example/mcp');
    await icons.consider(entry, undefined, 'not_ready');
    const first = net.requests.length;
    expect(first).toBeGreaterThan(0);
    expect(icons.info('remote')).toEqual({ available: false });
    clock += ICON_FAILURE_RETRY_MS - 1000;
    await icons.consider(entry, undefined, 'not_ready');
    expect(net.requests).toHaveLength(first);
    await icons.refresh(entry, undefined);
    expect(net.requests).toHaveLength(2 * first);
    clock += ICON_FAILURE_RETRY_MS;
    await icons.consider(entry, undefined, 'not_ready');
    expect(net.requests).toHaveLength(3 * first);
  });

  it('a decision made before the server described itself is reconsidered when it is ready', async () => {
    const net = fakeNet({
      'https://mcp.acme.example': { '/favicon.ico': pngIco(PNG_A, 32), '/logo.png': PNG_B },
    });
    const icons = service(net.fetchFn);
    const entry = httpEntry('https://mcp.acme.example/mcp');
    await icons.consider(entry, undefined, 'not_ready');
    expect(icons.info('remote').source).toBe('domain');
    await icons.consider(entry, { icons: [{ src: 'https://mcp.acme.example/logo.png' }] }, 'ready');
    expect(icons.info('remote').source).toBe('server');
  });

  it('a server that becomes ready during a fetch is looked at again when that fetch ends', async () => {
    // The not-ready fetch of the site is held open; the server becomes ready meanwhile.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const net = fakeNet({
      'https://mcp.acme.example': {
        '/': () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
        '/logo.png': PNG_B,
      },
    });
    const icons = service(async (url, init) => {
      if (new URL(url).pathname === '/') await held;
      return net.fetchFn(url, init);
    });
    const entry = httpEntry('https://mcp.acme.example/mcp');
    const notReady = icons.consider(entry, undefined, 'not_ready');
    const ready = icons.consider(entry, { icons: [{ src: 'https://mcp.acme.example/logo.png' }] }, 'ready');
    release();
    await notReady;
    await ready;
    expect(icons.info('remote')).toMatchObject({ available: true, source: 'server' });
    // A second request with nothing new adds no fetch.
    const count = net.requests.length;
    await Promise.all([
      icons.consider(entry, undefined, 'not_ready'),
      icons.consider(entry, undefined, 'not_ready'),
    ]);
    expect(net.requests).toHaveLength(count);
  });

  it('stores and serves both themes, and removing deletes every file', async () => {
    const net = fakeNet({
      'https://x.example': { '/l.png': ICON_HOST_FILES.light, '/d.png': ICON_HOST_FILES.dark },
    });
    const icons = service(net.fetchFn);
    const changed: string[] = [];
    icons.on('changed', (name) => changed.push(name));
    await icons.consider(
      stdioEntry(),
      {
        icons: [
          { src: 'https://x.example/l.png', theme: 'light' },
          { src: 'https://x.example/d.png', theme: 'dark' },
        ],
      },
      'ready',
    );
    expect(changed).toEqual(['local']);
    expect(icons.info('local').themes).toEqual(['light', 'dark']);
    expect(readFileSync(icons.file('local', 'dark')!.path).equals(ICON_HOST_FILES.dark)).toBe(true);
    expect(readFileSync(icons.file('local', 'light')!.path).equals(ICON_HOST_FILES.light)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['local-dark.png', 'local-light.png', 'local.json', 'local.png']);
    icons.remove('local');
    expect(readdirSync(dir)).toEqual([]);
    expect(icons.info('local')).toEqual({ available: false });
  });

  it('"none" stores no file and fetches nothing; a changed icon field is fetched again', async () => {
    const net = fakeNet({ 'https://x.example': { '/logo.png': PNG_A } });
    const icons = service(net.fetchFn);
    await icons.consider(
      stdioEntry({ icon: 'none' }),
      { icons: [{ src: 'https://x.example/logo.png' }] },
      'ready',
    );
    expect(net.requests).toHaveLength(0);
    expect(icons.info('local')).toEqual({ available: false });
    expect(existsSync(join(dir, 'local.png'))).toBe(false);
    await icons.consider(stdioEntry(), { icons: [{ src: 'https://x.example/logo.png' }] }, 'ready');
    expect(icons.info('local').available).toBe(true);
  });
});

describe.runIf(process.platform === 'win32')('icons folder permissions (Windows)', () => {
  it('inherits the data directory restriction: only the current user and SYSTEM', async () => {
    const home = createTempHome();
    const log = createGatewayLogger({ file: join(home.dir, '..', 'perm.log') });
    try {
      const { paths } = await ensureDataDir(home.dir, getPlatform());
      const net = fakeNet({ 'https://x.example': { '/logo.png': PNG_A } });
      const icons = new IconService({ dir: paths.iconsDir, fetcher: net.fetcher, logger: log.logger });
      await icons.consider(stdioEntry(), { icons: [{ src: 'https://x.example/logo.png' }] }, 'ready');
      for (const target of [
        paths.iconsDir,
        join(paths.iconsDir, 'local.png'),
        join(paths.iconsDir, 'local.json'),
      ]) {
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
        expect(entries, target).toHaveLength(2);
        expect(entries.some((entry) => entry.startsWith('NT AUTHORITY\\SYSTEM:'))).toBe(true);
      }
    } finally {
      log.close();
      await home.cleanup();
    }
  });
});
