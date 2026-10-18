import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  ADMIN_COOKIE_NAME,
  AUTH_PATHS,
  apiError,
  HEALTH_PATH,
  OAUTH_CALLBACK_PATH,
  OAUTH_STYLE_PATH,
  SERVICE_ID,
  type ApiErrorCode,
  type AutostartStatus,
  type HealthResponse,
  type ShutdownResponse,
  type StatusResponse,
} from '@mcpier/shared';
import { tokensMatch } from '../admin-token.js';
import type { ConfigService } from '../config-service.js';
import type { Logger } from '../logger.js';
import type { ServerManager } from '../manager/manager.js';
import type { MetaToolContext } from '../meta/meta-tools.js';
import type { CallbackOutcome, OAuthService } from '../oauth/service.js';
import type { CallLog } from '../store/call-log.js';
import type { SecretStore } from '../platform/index.js';
import type { GatewayEventHub } from './events.js';
import { safeNextPath, type HandoffCodes } from './handoff.js';
import { registerCallLogRoutes } from './call-log-routes.js';
import { registerDashboardRoutes } from './dashboard-routes.js';
import { errorToResponse, registerApiRoutes } from './routes.js';
import { MCP_PATH } from './mcp-endpoint.js';
import { CALLBACK_CSS, callbackPage, LINK_INVALID_PAGE, OAUTH_PAGE_HEADERS } from './oauth-page.js';
import { registerOAuthRoutes } from './oauth-routes.js';
import { serveWeb } from './web.js';
import type { IconService } from '../icons/service.js';

export interface AppOptions {
  port: number;
  version: string;
  /** The admin token. Only ever compared, never logged or echoed. */
  token: string;
  webRoot: string;
  logger: Logger;
  status: () => StatusResponse;
  /** Called after the shutdown response has been sent. */
  requestShutdown: () => void;
  services: AppServices;
  /** The client endpoint (/mcp). No admin token: it is for MCP clients (SPEC 7.3). */
  mcp: { fetch(request: Request): Promise<Response> };
}

/** What the admin API routes work with. */
export interface AppServices {
  manager: ServerManager;
  config: ConfigService;
  secrets: SecretStore;
  /** The data directory's `logs` folder (server logs live there). */
  logsDir: string;
  /** Aborted when the gateway begins shutting down. */
  closing: AbortSignal;
  /** The meta-tools' search, for `GET /api/tools/search`. */
  meta: MetaToolContext;
  /** Live changes for the dashboard's event stream. */
  events: GatewayEventHub;
  /** One-time codes for the sign-in hand-off. */
  handoff: HandoffCodes;
  /** OAuth sign-in for remote servers. */
  oauth: OAuthService;
  /** The call and search log (absent when `mcpier.db` could not be used). */
  callLog?: CallLog;
  /** Server logos (the icon route and the refresh action). */
  icons: IconService;
  /** Heartbeat interval on the event stream (tests shorten it). */
  heartbeatMs: number;
  /** The port the gateway listens on (for the connect snippets). */
  port: number;
  /** Paths for the stdio snippets; absent when the CLI did not start this gateway. */
  launch?: { nodePath: string; cliEntry: string };
  /** The gateway's own status (for the event stream's snapshot). */
  status: () => StatusResponse;
  /** The autostart logon task's status (read-only). */
  autostart: () => Promise<AutostartStatus>;
}

type ErrorStatus = 401 | 403 | 404 | 405 | 500;

function errorResponse(c: Context, status: ErrorStatus, code: ApiErrorCode, message: string) {
  return c.json(apiError(code, message), status);
}

/**
 * Host and Origin checks for every route, before any route logic. They block DNS-rebinding
 * attacks: a web page on another origin cannot get a browser to talk to this server.
 */
function localOnly(port: number): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    if (!host || !hosts.has(host)) {
      return errorResponse(c, 403, 'forbidden_host', 'Requests must be addressed to 127.0.0.1 or localhost.');
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return errorResponse(c, 403, 'forbidden_origin', 'Cross-origin requests are not allowed.');
    }
    await next();
  };
}

/** Accepts the token as `Authorization: Bearer <token>` or in the admin cookie. */
function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    const candidates: string[] = [];
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    if (bearer?.[1]) candidates.push(bearer[1]);
    const cookie = getCookie(c, ADMIN_COOKIE_NAME);
    if (cookie) candidates.push(cookie);
    // Compare every candidate so timing does not depend on which one matched.
    const results = candidates.map((candidate) => tokensMatch(candidate, token));
    if (!results.includes(true)) {
      c.header('WWW-Authenticate', 'Bearer');
      return errorResponse(c, 401, 'unauthorized', 'Missing or invalid admin token.');
    }
    await next();
  };
}

/** Logs each admin request with explicit fields only: never headers, cookies or query strings. */
function logAdminRequests(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      },
      'admin request',
    );
  };
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function isAuthPath(path: string): boolean {
  return path === '/auth' || path.startsWith('/auth/');
}

function isOAuthPath(path: string): boolean {
  return path === '/oauth' || path.startsWith('/oauth/');
}

function onlyForApi(middleware: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (isApiPath(c.req.path) ? middleware(c, next) : next());
}

/**
 * Headers on every dashboard page and asset (SPEC 7.3): scripts, styles, images, fonts and
 * connections from the dashboard's own origin only, no inline scripts or styles, no framing.
 */
export const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** The hand-off and sign-out answers are never cached and never leak a referrer. */
const AUTH_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // Order matters: admin requests are logged whatever the outcome, the Host/Origin checks
  // run before any route logic, and the token check guards everything under /api. The
  // hand-off and OAuth callback routes are logged too, by path only (codes and `state` are
  // in their query strings).
  app.use('*', (c, next) =>
    isApiPath(c.req.path) || isAuthPath(c.req.path) || isOAuthPath(c.req.path)
      ? logAdminRequests(options.logger)(c, next)
      : next(),
  );
  app.use('*', localOnly(options.port));
  app.use('*', onlyForApi(requireToken(options.token)));

  app.get(HEALTH_PATH, (c) => {
    const body: HealthResponse = { service: SERVICE_ID, version: options.version, status: 'ok' };
    return c.json(body);
  });

  app.get('/api/status', (c) => c.json(options.status()));

  app.post('/api/shutdown', (c) => {
    // Shut down only after this response has gone out.
    setImmediate(options.requestShutdown);
    const body: ShutdownResponse = { status: 'shutting_down' };
    return c.json(body);
  });

  registerApiRoutes(app, options.services, options.logger);
  registerDashboardRoutes(app, options.services, options.logger);
  registerOAuthRoutes(app, options.services, options.logger);
  registerCallLogRoutes(app, options.services, options.logger);

  // ---- OAuth callback (public, outside /api; the Host/Origin checks still apply). A browser
  // arriving here from the authorization server is a top-level navigation: no Origin header.

  app.get(OAUTH_CALLBACK_PATH, async (c) => {
    let outcome: CallbackOutcome;
    try {
      outcome = await options.services.oauth.completeSignIn(new URL(c.req.url).searchParams);
    } catch (error) {
      // A backstop: every outcome gets the same page and headers, never the JSON error shape.
      options.logger.error({ kind: (error as Error)?.name ?? 'unknown' }, 'OAuth callback failed');
      outcome = {
        ok: false,
        reason:
          'The sign-in could not be finished because of an internal error. The gateway log has details.',
        next: 'Start the sign-in again from the MCPier dashboard or with: mcpier auth login <server>',
      };
    }
    return c.html(callbackPage(outcome), outcome.ok ? 200 : 400, OAUTH_PAGE_HEADERS);
  });

  app.get(OAUTH_STYLE_PATH, (c) =>
    c.body(CALLBACK_CSS, 200, { ...OAUTH_PAGE_HEADERS, 'content-type': 'text/css; charset=utf-8' }),
  );

  // ---- Sign-in hand-off (public, outside /api; the Host/Origin checks still apply).

  app.get(AUTH_PATHS.handoff, (c) => {
    for (const [name, value] of Object.entries(AUTH_HEADERS)) c.header(name, value);
    if (!options.services.handoff.consume(c.req.query('code'))) {
      // Unknown, used, expired or malformed: one answer for all of them.
      // The same static page and policy as the OAuth callback: own stylesheet, no script.
      return c.html(LINK_INVALID_PAGE, 400, { ...AUTH_HEADERS, ...OAUTH_PAGE_HEADERS });
    }
    setCookie(c, ADMIN_COOKIE_NAME, options.token, { path: '/', httpOnly: true, sameSite: 'Strict' });
    options.logger.info('Dashboard signed in');
    return c.redirect(safeNextPath(c.req.query('next')), 302);
  });

  app.post(AUTH_PATHS.signout, (c) => {
    for (const [name, value] of Object.entries(AUTH_HEADERS)) c.header(name, value);
    deleteCookie(c, ADMIN_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'Strict' });
    return c.redirect('/', 303);
  });

  // After the Host/Origin checks; the token check only covers /api.
  app.all(MCP_PATH, (c) => options.mcp.fetch(c.req.raw));

  app.all('*', (c) => {
    if (isApiPath(c.req.path)) {
      return errorResponse(c, 404, 'not_found', `No admin API route ${c.req.method} ${c.req.path}.`);
    }
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return withHeaders(serveWeb(options.webRoot, c.req.path), DASHBOARD_SECURITY_HEADERS);
    }
    return errorResponse(c, 405, 'method_not_allowed', `${c.req.method} is not allowed here.`);
  });

  app.onError((error, c) => errorToResponse(c, error, options.logger));

  return app;
}
