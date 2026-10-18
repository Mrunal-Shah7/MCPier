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

type Mark = 'brand' | 'ok' | 'failed';

const MARKS: Record<Mark, string> = {
  brand: '<div class="mark brand" aria-hidden="true">M</div>',
  ok: '<div class="mark ok" aria-hidden="true">&#10003;</div>',
  failed: '<div class="mark failed" aria-hidden="true">&#10005;</div>',
};

/**
 * One centred card: a mark (the M, a check or a cross), then the body. Static HTML with the
 * gateway's own stylesheet, no script; served with {@link OAUTH_PAGE_HEADERS}.
 */
export function statusPage(title: string, mark: Mark, body: string): string {
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
${MARKS[mark]}
${body}
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
    return statusPage(
      `Signed in to ${outcome.server}`,
      'ok',
      `<p class="badge ok">Signed in</p>
<h1>Signed in to <span class="name">${escapeHtml(outcome.server)}</span></h1>
<p class="next">MCPier now connects to this server with your sign-in. The dashboard updates on its own.</p>
<p class="close">You can close this tab.</p>`,
    );
  }
  const heading = outcome.server ? `Sign-in to ${outcome.server} failed` : 'Sign-in failed';
  return statusPage(
    heading,
    'failed',
    `<p class="badge failed">Sign-in didn&#39;t finish</p>
<h1 class="failed">${escapeHtml(heading)}</h1>
<p class="reason">${escapeHtml(outcome.reason)}</p>
<p class="next">${escapeHtml(outcome.next)}</p>
<p class="close">You can close this tab.</p>`,
  );
}

/** The answer of the sign-in hand-off to a code that is unknown, used, expired or malformed. */
export const LINK_INVALID_PAGE = statusPage(
  'Link no longer valid',
  'brand',
  `<h1>This sign-in link is no longer valid.</h1>
<p class="next">Run it again in a terminal to open the dashboard:</p>
<pre>mcpier open</pre>`,
);

/** Static CSS with the dashboard's tokens (Sprint 7); light or dark from the system setting. */
export const CALLBACK_CSS = `:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --panel-2: #f8f9fb;
  --border: #e3e7ec;
  --text: #14181f;
  --muted: #5d6675;
  --ok: #047857;
  --ok-soft: rgb(16 185 129 / 12%);
  --bad: #be123c;
  --bad-soft: rgb(244 63 94 / 12%);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0b0d;
    --panel: #111317;
    --panel-2: #161a1f;
    --border: #232831;
    --text: #e7e9ec;
    --muted: #8a93a2;
    --ok: #10b981;
    --ok-soft: rgb(16 185 129 / 14%);
    --bad: #fb7185;
    --bad-soft: rgb(244 63 94 / 14%);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
}
.card {
  width: 100%;
  max-width: 400px;
  padding: 28px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  text-align: center;
  box-shadow: 0 6px 18px rgb(0 0 0 / 8%);
}
.mark {
  width: 44px;
  height: 44px;
  margin: 0 auto 14px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-size: 20px;
  font-weight: 800;
}
.mark.brand { background: linear-gradient(135deg, #10b981, #0ea5e9); color: #04140e; }
.mark.ok { background: var(--ok-soft); color: var(--ok); }
.mark.failed { background: var(--bad-soft); color: var(--bad); }
.badge {
  display: inline-block;
  margin: 0 0 10px;
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
}
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.failed { background: var(--bad-soft); color: var(--bad); }
h1 { margin: 0 0 10px; font-size: 17px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
h1.failed { color: var(--bad); }
.name, pre { font-family: "Cascadia Code", Consolas, ui-monospace, monospace; }
p { margin: 0 0 8px; overflow-wrap: anywhere; }
.next, .close { color: var(--muted); }
.close { margin-top: 14px; font-size: 12px; }
pre {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  font-size: 13px;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
`;
