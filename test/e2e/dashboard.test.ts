/// <reference lib="dom" />
// Sprint 4 end-to-end smoke test: the built dashboard in the installed Microsoft Edge (driven by
// playwright-core; nothing is downloaded) against a real gateway with a temporary home, a
// random port, the fake secret store and fixture servers. Also checks, in a real browser, that
// the Content Security Policy blocks nothing and that the app stores nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PATHS, DASHBOARD_API_PATHS, type SessionCodeResponse } from '@mcpier/shared';
import { fixtureScripts, startOAuthFixture, type OAuthFixture } from '@mcpier/test-fixtures';
import { FAST_TIMING, startTestGateway, waitForStatus, type TestGateway } from '../helpers/gateway.js';

const webRoot = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean) as string[];
const edgeInstalled = programFiles.some((dir) =>
  existsSync(join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
);
const built = existsSync(join(webRoot, 'index.html'));

describe.runIf(edgeInstalled && built)('dashboard in Edge', () => {
  let t: TestGateway;
  let browser: Browser;
  let page: Page;
  let oauth: OAuthFixture;
  const problems: string[] = [];

  beforeAll(async () => {
    oauth = await startOAuthFixture();
    t = await startTestGateway({
      webRoot,
      timing: FAST_TIMING,
      configDebounceMs: 50,
      config: {
        servers: [
          {
            name: 'files',
            transport: 'stdio',
            command: process.execPath,
            args: [fixtureScripts.stdio],
            description: 'Fixture files',
          },
          { name: 'spare', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
        ],
      } as never,
    });
    await waitForStatus(t.gateway, 'files', 'ready');
    await waitForStatus(t.gateway, 'spare', 'ready');
    t.gateway.config.watch();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Every page of the context (the sign-in tab too) reports console errors and CSP violations.
    context.on('page', (opened) => {
      opened.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console (${opened.url()}): ${message.text()}`);
      });
      opened.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) =>
        console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`),
      );
      // Record any IndexedDB use.
      const open = indexedDB.open.bind(indexedDB);
      (window as unknown as { __idbOpened: number }).__idbOpened = 0;
      indexedDB.open = (...args: Parameters<typeof open>) => {
        (window as unknown as { __idbOpened: number }).__idbOpened++;
        return open(...args);
      };
    });
    page = await context.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await t?.cleanup();
    await oauth?.close();
  });

  const api = (method: string, path: string) =>
    fetch(`${t.gateway.url}${path}`, { method, headers: { authorization: `Bearer ${t.token}` } });

  it('1. signs in through the hand-off; the Servers page shows the fixture servers', async () => {
    await page.goto(`${t.gateway.url}/servers`);
    await page.getByText('not signed in').waitFor();
    const { path } = (await (
      await api('POST', DASHBOARD_API_PATHS.sessionCode)
    ).json()) as SessionCodeResponse;
    await page.goto(`${t.gateway.url}${path}`);
    await page.waitForURL(`${t.gateway.url}/servers`);
    await page.getByRole('link', { name: 'files', exact: true }).waitFor();
    await page.getByRole('link', { name: 'spare', exact: true }).waitFor();
    expect(page.url()).not.toContain('code=');
  }, 30_000);

  it('2. adds a stdio fixture server through the form, tests it, saves it; it reaches ready', async () => {
    await page.getByRole('link', { name: 'Add server' }).first().click();
    await page.getByLabel('Name').fill('added');
    await page.getByLabel('Command').fill(process.execPath);
    await page.getByRole('button', { name: 'Add argument' }).click();
    await page.getByLabel('Argument 1').fill(fixtureScripts.stdio);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText(/Connected: \d+ tools/).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Save server' }).click();
    await page.waitForURL(`${t.gateway.url}/servers/added`);
    await page.locator('[data-status="ready"]').first().waitFor({ timeout: 20_000 });
  }, 60_000);

  it('3. disabling a tool shows in the catalog, and search no longer returns it', async () => {
    await page.getByRole('tab', { name: /Tools/ }).click();
    await page.getByRole('switch', { name: 'Disable added__echo' }).click();
    await page.getByRole('switch', { name: 'Enable added__echo' }).waitFor();
    await page.getByRole('link', { name: 'Tools' }).click();
    await page.getByRole('tab', { name: 'Catalog' }).click();
    const row = page.locator('[data-tool="added__echo"]');
    await expect.poll(() => row.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    await page.getByRole('tab', { name: 'Search' }).click();
    await page.getByLabel('What do you want to do?').fill('echo');
    await page.getByRole('button', { name: 'Search' }).click();
    const results = page.getByRole('list', { name: 'Search results' });
    await results.waitFor();
    await expect.poll(() => results.textContent()).toContain('files__echo');
    expect(await results.textContent()).not.toContain('added__echo');
  }, 60_000);

  it('4. a server stopped from outside the browser changes on the page without a reload', async () => {
    await page.getByRole('link', { name: 'Servers' }).click();
    const row = page.locator('[data-server="spare"]');
    await row.locator('[data-status="ready"]').waitFor();
    const before = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    expect((await api('POST', API_PATHS.serverAction('spare', 'stop'))).status).toBe(200);
    await row.locator('[data-status="stopped"]').waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(before);
  }, 30_000);

  it('5. a broken config.json shows the banner; fixing it removes the banner', async () => {
    const good = readFileSync(t.home.paths.config, 'utf8');
    writeFileSync(t.home.paths.config, '{ "servers": [ { "name": "Bad Name" } ] }');
    const banner = page.getByRole('alert', { name: 'Config problem' });
    await banner.waitFor({ timeout: 10_000 });
    expect(await banner.textContent()).toContain('servers[0]');
    writeFileSync(t.home.paths.config, good);
    await banner.waitFor({ state: 'detached', timeout: 10_000 });
  }, 30_000);

  it('5b. adds the OAuth fixture server, signs in through a new tab, reaches ready, signs out', async () => {
    await page.getByRole('link', { name: 'Servers' }).click();
    await page.getByRole('link', { name: 'Add server' }).first().click();
    await page.getByLabel('Name').fill('notion');
    await page.getByLabel('Transport').selectOption({ label: 'HTTP (a remote URL)' });
    await page.getByLabel('URL', { exact: true }).fill(oauth.mcpUrl);
    await page.getByLabel('Sign-in').selectOption({ label: 'OAuth' });
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('OAuth discovery worked').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Save server' }).click();
    await page.waitForURL(`${t.gateway.url}/servers/notion`);
    const section = page.getByRole('region', { name: 'Authorization' });
    await section.locator('[data-auth-state="sign_in_required"]').waitFor({ timeout: 20_000 });

    // Sign in opens the authorization page in a new top-level tab; the fixture approves at once
    // and redirects to MCPier's callback page.
    const [tab] = await Promise.all([
      page.context().waitForEvent('page'),
      section.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    await tab.waitForURL(/\/oauth\/callback\?/, { timeout: 20_000 });
    await tab.getByRole('heading', { name: 'Signed in to notion' }).waitFor();
    expect(await tab.evaluate(() => document.scripts.length)).toBe(0);
    expect(await tab.evaluate(() => window.opener)).toBeNull();

    // The dashboard tab follows by itself.
    await section.locator('[data-auth-state="signed_in"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-status="ready"]').first().waitFor({ timeout: 20_000 });
    await expect.poll(() => section.textContent()).toContain('Dynamic registration');
    await tab.close();

    await section.getByRole('button', { name: 'Sign out' }).click();
    await section.locator('[data-auth-state="sign_in_required"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-status="needs_auth"]').first().waitFor({ timeout: 10_000 });
    expect(oauth.log.revocations).toHaveLength(1);

    // Overlays (an alert dialog, a dropdown menu) must not trip the CSP either (BUGS B-4).
    await section.getByRole('button', { name: 'Forget registration…' }).click();
    await page.getByRole('alertdialog').getByText('The next sign-in registers MCPier again.').waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('link', { name: 'Servers' }).click();
    await page.getByRole('button', { name: 'Actions for notion' }).click();
    await page.getByRole('menuitem', { name: 'Sign in…' }).waitFor();
    await page.keyboard.press('Escape');
  }, 90_000);

  it('5c. a Tester run (model mode) appears live in the Call log; its detail opens it in the Tester again', async () => {
    // The Call log stays open in the first tab while a second tab runs the tool.
    await page.getByRole('link', { name: 'Call log' }).click();
    await page
      .getByRole('table', { name: 'Calls' })
      .or(page.getByText('No calls match these filters'))
      .waitFor();
    const before = await page.evaluate(() => performance.getEntriesByType('navigation').length);

    const tester = await page.context().newPage();
    await tester.goto(`${t.gateway.url}/tester`);
    await tester.getByLabel('Find a tool').fill('echo');
    await tester.getByRole('button', { name: /^files__echo/ }).click();
    await tester.getByRole('heading', { name: 'files__echo' }).waitFor();
    expect(await tester.getByRole('radio', { name: 'As the model sees it' }).isChecked()).toBe(true);
    await tester.getByLabel(/^text/).fill('from the tester e2e');
    await tester.getByRole('status', { name: 'Validation' }).getByText('The arguments match').waitFor();
    await tester.getByRole('button', { name: 'Run' }).click();
    await tester.getByRole('region', { name: 'Result' }).getByText('from the tester e2e').waitFor();
    await tester.close();

    // Live: no reload in the first tab.
    const row = page
      .locator('[data-call]')
      .filter({ hasText: 'files__echo' })
      .filter({ hasText: 'dashboard-tester' });
    await row.first().waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(before);

    await row
      .first()
      .getByRole('button', { name: /^Details of call \d+ \(files__echo\)$/ })
      .click();
    const detail = page.getByRole('region', { name: 'Call detail' });
    await detail.getByLabel('Arguments').getByText('from the tester e2e').waitFor();
    await detail.getByRole('button', { name: 'Open in Tester' }).click();
    await page.waitForURL(`${t.gateway.url}/tester?tool=files__echo`);
    await expect.poll(() => page.getByLabel(/^text/).inputValue()).toBe('from the tester e2e');
  }, 60_000);

  // For the visual check (set MCPIER_E2E_SHOTS to a folder): pages with the fake secret store,
  // which manual runs cannot use, in both themes at two widths.
  it.runIf(process.env.MCPIER_E2E_SHOTS)(
    'screenshots for the visual check',
    async () => {
      const dir = process.env.MCPIER_E2E_SHOTS!;
      await t.secrets.set('demo-token', 'demo-token-value-0000-1111');
      for (const scheme of ['light', 'dark'] as const) {
        for (const width of [1280, 390]) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 900 });
          for (const path of [
            '/secrets',
            '/servers',
            '/servers/added?tab=tools',
            '/calls',
            '/calls?tab=searches',
            '/tester?tool=files__add',
          ]) {
            await page.goto(`${t.gateway.url}${path}`);
            await page.waitForTimeout(700);
            await page.screenshot({
              path: join(dir, `${scheme}-${width}-${path.replace(/[^a-z]+/g, '_')}.png`),
              fullPage: true,
            });
          }
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    },
    90_000,
  );

  it('6. signing out shows the not-signed-in page', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByText('not signed in').waitFor();
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'mcpier_admin')).toBe(false);
  }, 30_000);

  it('no CSP violation, console error or browser storage along the way', async () => {
    const storage = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      idb: (window as unknown as { __idbOpened: number }).__idbOpened,
    }));
    expect(storage).toEqual({ local: 0, session: 0, idb: 0 });
    // While signed out (the first visit, and after signing out) /api/status answers 401 by
    // design, and the browser logs every failed request as a console error. Nothing else may.
    expect(
      problems.filter((problem) => !problem.includes('status of 401 (Unauthorized)')),
      problems.join(' | '),
    ).toEqual([]);
    expect(problems.filter((problem) => problem.includes('401')).length).toBeLessThanOrEqual(2);
  });
});

// Only when the real tests cannot run: one skipped entry that says why.
if (!edgeInstalled || !built) {
  describe('dashboard in Edge', () => {
    it.skip(`skipped: ${!edgeInstalled ? 'Microsoft Edge is not installed' : 'the dashboard is not built (run pnpm build)'}`, () => {});
  });
}
