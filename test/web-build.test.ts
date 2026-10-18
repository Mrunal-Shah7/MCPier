// Sprint 4: the built dashboard holds no token or secret, needs no inline script or style
// (the CSP forbids both), and its own code never touches browser storage or cookies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'apps', 'web', 'dist');
const src = join(root, 'apps', 'web', 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe.runIf(existsSync(join(dist, 'index.html')))('built dashboard (apps/web/dist)', () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const assets = files(dist).filter((file) => /\.(js|css)$/.test(file));

  it('index.html has no inline script, inline style or style attribute', () => {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc="\/assets\//);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('holds no admin token, cookie value or secret', () => {
    const tokens: string[] = [];
    const devToken = join(root, '.dev-home', 'admin-token');
    if (existsSync(devToken)) tokens.push(readFileSync(devToken, 'utf8').trim());
    for (const file of [join(dist, 'index.html'), ...assets]) {
      const text = readFileSync(file, 'utf8');
      for (const token of tokens) expect(text).not.toContain(token);
      expect(text).not.toMatch(/mcpier_admin=[A-Za-z0-9_-]{20,}/);
      expect(text).not.toMatch(/Bearer [A-Za-z0-9_-]{30,}/);
    }
  });

  it('holds no Ajv and no eval or Function-constructor use (Sprint 6: validation is server side)', () => {
    const js = assets.filter((file) => file.endsWith('.js')).map((file) => readFileSync(file, 'utf8'));
    expect(js.length).toBeGreaterThan(0);
    for (const text of js) {
      // Ajv (its compiled-code markers and messages) never reaches the browser.
      expect(text).not.toMatch(/\bajv\b/i);
      expect(text).not.toContain('strict mode: unknown keyword');
      expect(text).not.toContain('validate.errors');
      expect(text).not.toMatch(/\beval\s*\(/);
      expect(text).not.toMatch(/new\s+Function\s*\(/);
      // The Function constructor appears only in zod's two known places, both unreachable with
      // `z.config({ jitless: true })` (src/lib/zod-config.ts): its eval probe and its JIT code
      // builder. Any other use fails here.
      const uses = [...text.matchAll(/(?<![\w$.])Function(?![\w$])/g)].map((match) =>
        text.slice(Math.max(0, match.index - 25), match.index + 25),
      );
      expect(uses.length, uses.join(' | ')).toBeLessThanOrEqual(2);
      for (const use of uses) {
        expect(use, use).toMatch(/try\{return Function\(``\)|let \w+=Function,\w+=this\?\.content/);
      }
    }
  });

  it('injects no <style> element at run time (BUGS B-4: no Radix Select, the scroll-lock shim)', () => {
    const js = assets.filter((file) => file.endsWith('.js')).map((file) => readFileSync(file, 'utf8'));
    for (const text of js) {
      expect(text).not.toContain('data-radix-select-viewport');
      expect(text).not.toMatch(/createElement\(\s*["']style["']\s*\)/);
    }
  });
});

describe('dashboard source', () => {
  it('never uses browser storage, cookies or an Authorization header', () => {
    for (const file of files(src)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      expect(text, file).not.toMatch(/document\.cookie/);
      expect(text, file).not.toMatch(/['"]authorization['"]\s*:/i);
    }
  });

  // Sprint 7: the refresh keeps every style in the built stylesheet. Charts, bars and tiles use
  // SVG attributes and classes; nothing sets a style, a custom property or markup at run time.
  it('sets no style attribute, style prop, custom property or raw HTML', () => {
    for (const file of files(src).filter((name) => /\.(ts|tsx)$/.test(name))) {
      // Code only: comments may name what is avoided.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(text, file).not.toMatch(/\bstyle\s*=\s*[{"']/);
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/);
      expect(text, file).not.toMatch(/\.style\.(setProperty|cssText)|\.style\[/);
      expect(text, file).not.toMatch(/['"]--[a-z][\w-]*['"]\s*:/);
      expect(text, file).not.toMatch(/<style\b|createElement\(\s*["']style["']\s*\)/);
      expect(text, file).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
  });

  it('never refers to the design reference file', () => {
    for (const file of files(src)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/mcpier-design-preview|docs\/design/);
    }
    if (existsSync(dist)) {
      for (const file of files(dist)) expect(file).not.toMatch(/design-preview/);
    }
  });
});
