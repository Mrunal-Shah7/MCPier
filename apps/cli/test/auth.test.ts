// Sprint 5, Phase 3: the `mcpier auth` commands, run as the built CLI against an in-process
// gateway and the OAuth fixture. No browser is ever opened: sign-ins use --print-url and the
// test follows the link by HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import { cimdDocument, DASHBOARD_API_PATHS } from '@mcpier/shared';
import { runCli, spawnCli, type CliResult } from '../../../test/helpers/cli.js';
import { waitForStatus } from '../../../test/helpers/gateway.js';
import { OAUTH_SERVER, startOAuthWorld, type OAuthWorld } from '../../../test/helpers/oauth.js';

let world: OAuthWorld | undefined;
/** Every CLI output except the sign-in link itself, checked for values at the end of each test. */
let outputs: string[] = [];

afterEach(async () => {
  if (world) {
    const corpus = outputs.join('\n');
    for (const value of [...world.fixture.issuedValues(), ...world.fixture.receivedValues()]) {
      expect(corpus.includes(value), 'a token, code or secret reached CLI output').toBe(false);
    }
  }
  await world?.close();
  world = undefined;
  outputs = [];
});

async function cli(args: string[]): Promise<CliResult> {
  const result = await runCli(args, world!.t.home.env(world!.t.port));
  outputs.push(result.stdout, result.stderr);
  return result;
}

/** `auth login --print-url`: returns the link once printed, and the finished run. */
function loginPrintingUrl(server = OAUTH_SERVER): { url: Promise<string>; done: Promise<CliResult> } {
  const child = spawnCli(['auth', 'login', server, '--print-url'], world!.t.home.env(world!.t.port));
  let stdout = '';
  let stderr = '';
  let gotUrl!: (url: string) => void;
  const url = new Promise<string>((resolve) => (gotUrl = resolve));
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    const line = stdout.split(/\r?\n/).find((text) => text.startsWith('http'));
    if (line) gotUrl(line.trim());
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const done = new Promise<CliResult>((resolve) =>
    child.on('close', (code) => {
      // The link (with its state) is the protocol's own request URL; everything else is checked.
      outputs.push(stdout.replace(/^http\S+$/m, '<link>'), stderr);
      resolve({ code: code ?? -1, stdout, stderr });
    }),
  );
  return { url, done };
}

describe('mcpier auth', () => {
  it('login --print-url: prints the link, waits, and reports success once the flow completes', async () => {
    world = await startOAuthWorld();
    const w = world;
    const { url, done } = loginPrintingUrl();
    const link = await url;
    expect(new URL(link).origin).toBe(w.fixture.issuer);
    const page = await w.finish(link);
    expect(page.status).toBe(200);
    const result = await done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Waiting for the sign-in to finish (up to 10 minutes; Ctrl+C stops waiting)',
    );
    expect(result.stdout).toContain('Signed in to notion.');
    expect(result.stdout).toContain('Scopes: mcp:tools offline_access.');
    expect(result.stderr).toContain('do not share it');
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'ready');
  });

  it('login reports a sign-in the authorization server refused', async () => {
    world = await startOAuthWorld({
      fixture: { rejectAuthorization: { error: 'access_denied', description: 'No.' } },
    });
    const { url, done } = loginPrintingUrl();
    await world.finish(await url);
    const result = await done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The sign-in to notion did not finish.');
    expect(result.stderr).toContain('The browser tab shows the reason');
  });

  it('login explains a server that cannot start a sign-in', async () => {
    world = await startOAuthWorld({ fixture: { registration: false } });
    const result = await cli(['auth', 'login', OAUTH_SERVER, '--print-url']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no client ID is configured');
    expect(result.stdout).toBe('');
  });

  it('status: a table, one server, --json, and an unknown server', async () => {
    world = await startOAuthWorld();
    const before = await cli(['auth', 'status']);
    expect(before.code).toBe(0);
    expect(before.stdout).toMatch(/^SERVER\s+STATUS\s+REGISTRATION\s+TOKEN EXPIRES\s+SCOPES/);
    expect(before.stdout).toMatch(/notion\s+not signed in/);

    await world.signIn();
    const table = await cli(['auth', 'status']);
    expect(table.stdout).toMatch(
      /notion\s+signed in\s+dynamic\s+in (\d+[dhm] )*\d+[dhms]\s+mcp:tools offline_access/,
    );

    const one = await cli(['auth', 'status', OAUTH_SERVER]);
    expect(one.stdout).toContain('Status:          signed in');
    expect(one.stdout).toContain(`Issuer:          ${world.fixture.issuer}`);
    expect(one.stdout).toContain('Registration:    dynamic registration');
    expect(one.stdout).toContain('Granted scopes:  mcp:tools offline_access');
    expect(one.stdout).toContain('Refresh token:   yes');

    const json = await cli(['auth', 'status', OAUTH_SERVER, '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      server: OAUTH_SERVER,
      signedIn: true,
      hasRefreshToken: true,
    });
    const all = await cli(['auth', 'status', '--json']);
    expect((JSON.parse(all.stdout) as unknown[]).length).toBe(1);

    const unknown = await cli(['auth', 'status', 'ghost']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No server named "ghost"');
  });

  it('refresh reports the new expiry, and explains a server that is not signed in', async () => {
    world = await startOAuthWorld();
    const notYet = await cli(['auth', 'refresh', OAUTH_SERVER]);
    expect(notYet.code).toBe(1);
    expect(notYet.stderr).toContain('"notion" is not signed in');
    await world.signIn();
    const result = await cli(['auth', 'refresh', OAUTH_SERVER]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /^Refreshed notion: the access token now expires at \S+ \(in (\d+[dhm] )*\d+[dhms]\)\./,
    );
    expect(world.fixture.log.refreshes).toBe(1);
  });

  it('logout signs out (revoking); --forget-client forgets the registration too', async () => {
    world = await startOAuthWorld();
    const w = world;
    await w.signIn();
    const out = await cli(['auth', 'logout', OAUTH_SERVER]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Signed out of notion. Sign in again with: mcpier auth login notion');
    expect(w.fixture.log.revocations).toHaveLength(1);
    await waitForStatus(w.t.gateway, OAUTH_SERVER, 'needs_auth');

    await w.signIn();
    expect(w.fixture.log.registrations).toHaveLength(1);
    const forgot = await cli(['auth', 'logout', OAUTH_SERVER, '--forget-client']);
    expect(forgot.code).toBe(0);
    expect(forgot.stdout).toContain('forgot its registration');
    await w.signIn();
    expect(w.fixture.log.registrations).toHaveLength(2);
  });

  it('cimd-document: fails clearly without the setting, prints the document with it', async () => {
    world = await startOAuthWorld();
    const unset = await cli(['auth', 'cimd-document']);
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('The "cimdUrl" setting is not set');
    expect(unset.stdout).toBe('');

    const url = 'https://example.org/mcpier/client.json';
    await world.api('PATCH', DASHBOARD_API_PATHS.settings, { cimdUrl: url });
    const set = await cli(['auth', 'cimd-document']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual(cimdDocument(url, world.t.port));
    expect(set.stderr).toContain(`Publish this JSON at ${url}`);
  });

  it('the OAuth store key never shows in the secrets list (API and CLI)', async () => {
    world = await startOAuthWorld();
    await world.secrets.set('github-token', 'ghp-value-0000-1111');
    await world.signIn();
    expect(world.secrets.internal().accounts()).toEqual(['OAuthStoreKey']);
    const api = await world.api<{ secrets: { name: string }[]; missing: unknown[] }>('GET', '/api/secrets');
    expect(api.body.secrets.map((secret) => secret.name)).toEqual(['github-token']);
    const listed = await cli(['secret', 'list', '--json']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toMatch(/oauth/i);
    expect(listed.stdout).toContain('github-token');
  });

  it('every auth command says when the gateway is not running', async () => {
    world = await startOAuthWorld();
    await world.t.gateway.stop('test');
    const result = await cli(['auth', 'status']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('MCPier is not running.');
  });
});
