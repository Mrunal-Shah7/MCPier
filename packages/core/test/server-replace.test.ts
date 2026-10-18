// Sprint 7, Phase 3: PUT /api/servers/:name replaces a whole entry (the JSON editor).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PATHS,
  type ApiErrorResponse,
  type ServerDetailResponse,
  type ServerReplaceResponse,
} from '@mcpier/shared';
import { fixtureScripts } from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  waitUntil,
  type TestGateway,
} from '../../../test/helpers/gateway.js';

let t: TestGateway;

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${t.gateway.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

const stored = () =>
  (
    JSON.parse(readFileSync(t.home.paths.config, 'utf8')) as { servers: Record<string, unknown>[] }
  ).servers.find((server) => server.name === 'files')!;

const base = () => ({
  name: 'files',
  transport: 'stdio',
  command: process.execPath,
  args: [fixtureScripts.stdio],
  description: 'Fixture files',
});

beforeAll(async () => {
  t = await startTestGateway({
    timing: FAST_TIMING,
    configDebounceMs: 50,
    config: { servers: [{ ...base(), timeoutMs: 30_000 }] } as never,
  });
  await waitForStatus(t.gateway, 'files', 'ready');
});

afterAll(async () => {
  await t?.cleanup();
});

describe('PUT /api/servers/:name', () => {
  it('replaces the whole entry: a key left out is removed, without a restart for plain fields', async () => {
    const pid = t.gateway.manager.pid('files');
    const answer = await api<ServerReplaceResponse>('PUT', API_PATHS.server('files'), {
      ...base(),
      description: 'Renamed description',
    });
    expect(answer.status).toBe(200);
    expect(answer.body.warnings).toEqual([]);
    expect(answer.body.server.description).toBe('Renamed description');
    expect(stored().description).toBe('Renamed description');
    // A defaulted field left out returns to its default (config.json is saved with defaults).
    expect(stored().timeoutMs).toBe(60_000);
    // An optional field left out is gone.
    const { description: _dropped, ...withoutDescription } = base();
    expect((await api('PUT', API_PATHS.server('files'), withoutDescription)).status).toBe(200);
    expect(stored()).not.toHaveProperty('description');
    const detail = await api<ServerDetailResponse>('GET', API_PATHS.server('files'));
    expect(detail.body.config).not.toHaveProperty('description');
    expect(t.gateway.manager.pid('files')).toBe(pid);
  });

  it('keeps unknown keys as written and lists them as not used', async () => {
    const answer = await api<ServerReplaceResponse>('PUT', API_PATHS.server('files'), {
      ...base(),
      team: 'alpha',
    });
    expect(answer.status).toBe(200);
    expect(answer.body.warnings).toEqual(['team: not used by MCPier']);
    expect(stored().team).toBe('alpha');
  });

  it('restarts the server when a connection field changes', async () => {
    const pid = t.gateway.manager.pid('files');
    const answer = await api<ServerReplaceResponse>('PUT', API_PATHS.server('files'), {
      ...base(),
      args: [fixtureScripts.stdio, '--restarted'],
    });
    expect(answer.status).toBe(200);
    await waitUntil(
      () => t.gateway.manager.pid('files') !== pid && t.gateway.manager.status('files').state === 'ready',
    );
  });

  it('refuses a rename, with the problem on the name', async () => {
    const answer = await api<ApiErrorResponse>('PUT', API_PATHS.server('files'), {
      ...base(),
      name: 'other',
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.problems).toEqual([expect.stringMatching(/^name: must stay "files"/)]);
    expect(stored().name).toBe('files');
  });

  it('an invalid entry gives problems with their paths, and nothing is saved', async () => {
    const before = stored();
    const answer = await api<ApiErrorResponse>('PUT', API_PATHS.server('files'), {
      ...base(),
      timeoutMs: 'soon',
      env: { KEY: 'secret:Bad Name' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/^timeoutMs: /), expect.stringMatching(/^env\.KEY: /)]),
    );
    expect(stored()).toEqual(before);
  });

  it('refuses a plain oauth.clientSecret', async () => {
    await api('POST', API_PATHS.servers, {
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      auth: 'oauth',
      enabled: false,
    });
    const answer = await api<ApiErrorResponse>('PUT', API_PATHS.server('remote'), {
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      auth: 'oauth',
      enabled: false,
      oauth: { clientId: 'abc', clientSecret: 'plain-client-secret-9393' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error.problems).toEqual([
      expect.stringMatching(/^oauth\.clientSecret: must be a secret reference/),
    ]);
    expect(JSON.stringify(answer.body)).not.toContain('plain-client-secret-9393');
  });

  it('404 for an unknown server; 400 for a body that is not an object', async () => {
    expect((await api('PUT', API_PATHS.server('nobody'), { ...base(), name: 'nobody' })).status).toBe(404);
    expect((await api('PUT', API_PATHS.server('files'), ['not', 'an', 'object'])).status).toBe(400);
  });
});

describe('POST /api/import with an OAuth client secret', () => {
  it('previews the move, stores nothing on a dry run, and never answers with the value', async () => {
    const VALUE = 'import-route-client-secret-1212';
    const source = {
      mcpServers: {
        box: {
          url: 'https://mcp.example.com/mcp',
          oauth: { clientId: 'b', clientSecret: VALUE },
          disabled: true,
        },
      },
    };
    const preview = await fetch(`${t.gateway.url}${API_PATHS.import}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source, dryRun: true }),
    });
    const previewText = await preview.text();
    expect(previewText).not.toContain(VALUE);
    expect(JSON.parse(previewText).entries[0].oauth).toEqual({
      clientId: 'b',
      scopes: [],
      clientSecret: { kind: 'plain', movedTo: 'box-client-secret' },
    });
    expect(await t.secrets.get('box-client-secret')).toBeUndefined();
    const created = await fetch(`${t.gateway.url}${API_PATHS.import}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    expect(created.status).toBe(201);
    expect(await created.text()).not.toContain(VALUE);
    expect(await t.secrets.get('box-client-secret')).toBe(VALUE);
    expect(readFileSync(t.home.paths.config, 'utf8')).not.toContain(VALUE);
    expect(readFileSync(t.home.paths.config, 'utf8')).toContain('secret:box-client-secret');
  });
});
