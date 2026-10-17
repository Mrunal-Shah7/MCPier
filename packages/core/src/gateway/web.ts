import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MCPier</title></head>
<body>
<h1>MCPier</h1>
<p>The gateway is running, but the dashboard has not been built.</p>
<p>Run <code>pnpm build</code> in the MCPier repository, then reload this page.</p>
</body></html>
`;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built dashboard from `webRoot`. Unknown paths fall back to `index.html` so the
 * dashboard can do its own routing; if the build is missing, a page says how to build it.
 */
export function serveWeb(webRoot: string, pathname: string): Response {
  const root = resolve(webRoot);
  const index = resolve(root, 'index.html');
  if (!existsSync(index)) {
    return new Response(NOT_BUILT_PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = '/';
  }
  const candidate = resolve(root, `.${decoded}`);
  const insideRoot = candidate.startsWith(root + sep);
  const file = insideRoot && isFile(candidate) ? candidate : index;

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // Vite puts content-hashed files under /assets; everything else must be revalidated.
  const cache =
    file !== index && decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  return new Response(readFileSync(file), { headers: { 'content-type': type, 'cache-control': cache } });
}
