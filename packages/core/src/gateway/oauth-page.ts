import { OAUTH_STYLE_PATH } from '@mcpier/shared';
import type { CallbackOutcome } from '../oauth/service.js';

/**
 * Headers of the OAuth callback page and its stylesheet: never cached, no referrer (the URL
 * held a code), no framing, and a policy that allows the gateway's own stylesheet and nothing
 * else: the page has no script at all.
 */
export const OAUTH_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · MCPier</title>
<link rel="stylesheet" href="${OAUTH_STYLE_PATH}">
</head>
<body>
<main class="card">
<p class="brand">MCPier</p>
${body}
<p class="close">You can close this tab.</p>
</main>
</body>
</html>
`;
}

/**
 * The plain result page of `/oauth/callback`: "Signed in to <server>", or the reason it
 * failed and what to do next. Everything shown is escaped; nothing from the request URL (the
 * code, the state) is ever echoed.
 */
export function callbackPage(outcome: CallbackOutcome): string {
  if (outcome.ok) {
    return page(
      `Signed in to ${outcome.server}`,
      `<h1 class="ok">Signed in to <span class="name">${escapeHtml(outcome.server)}</span></h1>
<p>MCPier now connects to this server with your sign-in. The dashboard updates on its own.</p>`,
    );
  }
  const heading = outcome.server ? `Sign-in to ${outcome.server} failed` : 'Sign-in failed';
  return page(
    heading,
    `<h1 class="failed">${escapeHtml(heading)}</h1>
<p class="reason">${escapeHtml(outcome.reason)}</p>
<p class="next">${escapeHtml(outcome.next)}</p>`,
  );
}

/** Static CSS in the dashboard's neutral style; light or dark from the system setting. */
export const CALLBACK_CSS = `:root {
  color-scheme: light dark;
  --background: oklch(0.985 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --ok: oklch(0.527 0.154 150.069);
  --destructive: oklch(0.577 0.245 27.325);
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --border: oklch(1 0 0 / 10%);
    --ok: oklch(0.723 0.219 149.579);
    --destructive: oklch(0.704 0.191 22.216);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--background);
  color: var(--foreground);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card {
  width: 100%;
  max-width: 32rem;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--card);
  box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
}
.brand { margin: 0 0 12px; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; color: var(--muted-foreground); }
h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
h1.ok::before { content: "\\2713  "; color: var(--ok); }
h1.failed { color: var(--destructive); }
.name { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
p { margin: 0 0 8px; overflow-wrap: anywhere; }
.next, .close { color: var(--muted-foreground); }
.close { margin-top: 16px; font-size: 13px; }
`;
