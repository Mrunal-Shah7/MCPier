// Sprint 7, Phase 2: icons through a real gateway. Both protocol eras deliver serverInfo icons
// and websiteUrl; the icon route's headers, 304, themes and SVG policy; refresh and removal; the
// folder's permissions; and no credential ever reaching an icon host.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PATHS,
  type ServerDetailResponse,
  type ServerListResponse,
  type ServerResponse,
} from '@mcpier/shared';
import {
  fixtureScripts,
  ICON_HOST_FILES,
  startIconHost,
  startLegacyServer,
  startStatelessServer,
  type IconHost,
  type LegacyFixture,
  type RunningFixture,
} from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';
import { startOAuthWorld, OAUTH_SERVER } from '../../../test/helpers/oauth.js';

const HEADER_SECRET = 'icon-header-secret-value-8181';
const PLAIN_HEADER = 'plain-header-value-8282';

let host: IconHost;
let modern: RunningFixture;
let withHeaders: RunningFixture;
let legacy: LegacyFixture;
let t: TestGateway;

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${t.gateway.url}${path}`, { headers: { authorization: `Bearer ${t.token}`, ...headers } });
}

const summary = (name: string) => t.gateway.manager.summary(name);
const waitForIcon = (name: string) => waitUntil(() => summary(name).icon?.available === true, 15_000);

beforeAll(async () => {
  host = await startIconHost();
  modern = await startStatelessServer({
    serverInfo: {
      icons: [
        { src: `${host.origin}/light.png`, theme: 'light', sizes: ['64x64'] },
        { src: `${host.origin}/dark.png`, theme: 'dark', sizes: ['64x64'] },
        { src: `${host.origin}/plain.png`, sizes: ['64x64'] },
      ],
    },
  });
  withHeaders = await startStatelessServer({
    serverInfo: { icons: [{ src: `${host.origin}/headers.png` }] },
  });
  legacy = await startLegacyServer({ serverInfo: { websiteUrl: `${host.origin}/` } });
  t = await startTestGateway({
    timing: FAST_TIMING,
    config: {
      servers: [
        { name: 'modern', transport: 'http', url: modern.url },
        { name: 'old', transport: 'http', url: legacy.url },
        {
          name: 'local',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          env: {
            MCPIER_FIXTURE_SERVER_INFO: JSON.stringify({
              icons: [
                {
                  src: `data:image/svg+xml;base64,${ICON_HOST_FILES.svg.toString('base64')}`,
                  sizes: ['any'],
                },
              ],
            }),
          },
        },
        {
          name: 'plain',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureScripts.stdio],
          icon: 'none',
        },
        {
          name: 'headers',
          transport: 'http',
          url: withHeaders.url,
          headers: { Authorization: 'Bearer secret:icon-key', 'X-Team': PLAIN_HEADER },
        },
      ],
    } as never,
    extra: { icons: { allowLoopbackHttp: true } },
  });
  await t.secrets.set('icon-key', HEADER_SECRET);
  await t.gateway.manager.restart('headers');
  for (const name of ['modern', 'old', 'local', 'plain', 'headers'])
    await waitForStatus(t.gateway, name, 'ready');
}, 60_000);

afterAll(async () => {
  await t?.cleanup();
  await Promise.all([host?.close(), modern?.close(), withHeaders?.close(), legacy?.close()]);
});

describe('icons from both protocol eras', () => {
  it('a 2026-07-28 server: its own light and dark icons, both stored and served', async () => {
    await waitForIcon('modern');
    expect(summary('modern').icon).toMatchObject({
      available: true,
      source: 'server',
      themes: ['light', 'dark'],
    });
    const dark = await get(`${API_PATHS.serverIcon('modern')}?theme=dark`);
    expect(dark.status).toBe(200);
    expect(Buffer.from(await dark.arrayBuffer()).equals(ICON_HOST_FILES.dark)).toBe(true);
    const light = await get(`${API_PATHS.serverIcon('modern')}?theme=light`);
    expect(Buffer.from(await light.arrayBuffer()).equals(ICON_HOST_FILES.light)).toBe(true);
    const plain = await get(API_PATHS.serverIcon('modern'));
    expect(Buffer.from(await plain.arrayBuffer()).equals(ICON_HOST_FILES.plain)).toBe(true);
  });

  it('a 2025-11-25 server: the favicon of its websiteUrl (apple-touch-icon first)', async () => {
    await waitForIcon('old');
    expect(summary('old').icon).toMatchObject({ available: true, source: 'website' });
    const answer = await get(API_PATHS.serverIcon('old'));
    expect(Buffer.from(await answer.arrayBuffer()).equals(ICON_HOST_FILES.apple)).toBe(true);
  });

  it('a stdio server: a data: SVG, served with the sandbox policy', async () => {
    await waitForIcon('local');
    const answer = await get(API_PATHS.serverIcon('local'));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('image/svg+xml');
    expect(answer.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(await answer.text()).toContain('<svg');
  });
});

describe('the icon route', () => {
  it('200 with the type, nosniff, a private cache and an ETag; 304 on a matching If-None-Match', async () => {
    const answer = await get(API_PATHS.serverIcon('old'));
    expect(answer.headers.get('content-type')).toBe('image/png');
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    expect(answer.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(answer.headers.get('content-security-policy')).toBeNull();
    const etag = answer.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get(API_PATHS.serverIcon('old'), { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('server responses carry icon: { available, source, etag }', async () => {
    const list = (await (await get(API_PATHS.servers)).json()) as ServerListResponse;
    const old = list.servers.find((server) => server.name === 'old')!;
    expect(old.icon).toMatchObject({
      available: true,
      source: 'website',
      etag: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    const detail = (await (await get(API_PATHS.server('old'))).json()) as ServerDetailResponse;
    expect(detail.server.icon).toEqual(old.icon);
  });

  it('404 without an icon ("none"), 404 for an unknown server, 400 for a bad theme, 401 without a token', async () => {
    expect(summary('plain').icon).toEqual({ available: false });
    expect((await get(API_PATHS.serverIcon('plain'))).status).toBe(404);
    expect((await get(API_PATHS.serverIcon('nobody'))).status).toBe(404);
    expect((await get(`${API_PATHS.serverIcon('old')}?theme=blue`)).status).toBe(400);
    expect((await fetch(`${t.gateway.url}${API_PATHS.serverIcon('old')}`)).status).toBe(401);
  });

  it('refresh fetches again now, ignoring the cache', async () => {
    const before = host.paths().filter((path) => path === '/').length;
    const answer = await fetch(`${t.gateway.url}${API_PATHS.serverIconRefresh('old')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}` },
    });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as ServerResponse).server.icon?.available).toBe(true);
    expect(host.paths().filter((path) => path === '/').length).toBe(before + 1);
  });

  it('removing a server deletes its files', async () => {
    const dir = join(t.home.dir, 'icons');
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['old.json', 'old.png']));
    await t.gateway.config.update((draft) => {
      draft.servers = draft.servers.filter((server) => server.name !== 'old');
    });
    await waitUntil(() => !existsSync(join(dir, 'old.png')));
    expect(readdirSync(dir).filter((name) => name.startsWith('old'))).toEqual([]);
  });
});

describe('no credential reaches an icon host', () => {
  it('a server whose headers hold a secret and a plain value', async () => {
    await waitForIcon('headers');
    const requests = host.receivedHeaders();
    expect(requests.length).toBeGreaterThan(0);
    for (const headers of requests) {
      expect(headers).not.toHaveProperty('authorization');
      expect(headers).not.toHaveProperty('cookie');
      expect(headers).not.toHaveProperty('x-team');
      expect(JSON.stringify(headers)).not.toContain(HEADER_SECRET);
      expect(JSON.stringify(headers)).not.toContain(PLAIN_HEADER);
      expect(headers['user-agent']).toMatch(/^MCPier\//);
    }
  });

  it('an OAuth server with tokens', async () => {
    const oauthHost = await startIconHost();
    const world = await startOAuthWorld({
      fixture: { serverInfo: { icons: [{ src: `${oauthHost.origin}/headers.png` }] } },
      extra: { icons: { allowLoopbackHttp: true } },
    });
    try {
      await world.signIn();
      await waitForStatus(world.t.gateway, OAUTH_SERVER, 'ready');
      await waitUntil(() => world.t.gateway.manager.summary(OAUTH_SERVER).icon?.source === 'server', 15_000);
      const record = readdirSync(join(world.t.home.dir, 'oauth'));
      expect(record.length).toBe(1);
      const requests = oauthHost.receivedHeaders();
      expect(requests.length).toBeGreaterThan(0);
      for (const headers of requests) {
        expect(Object.keys(headers).sort()).not.toContain('authorization');
        expect(headers).not.toHaveProperty('cookie');
        expect(JSON.stringify(headers)).not.toMatch(/Bearer|eyJ/);
      }
    } finally {
      await world.close();
      await oauthHost.close();
    }
  });
});
