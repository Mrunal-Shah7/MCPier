import type { Hono } from 'hono';
import {
  AUTH_API_PATHS,
  cimdDocument,
  oauthRedirectUri,
  type AuthListResponse,
  type AuthStatusResponse,
  type CimdDocumentResponse,
  type SignInStartResponse,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import { ConflictError } from '../manager/errors.js';
import type { AppServices } from './app.js';

/**
 * OAuth routes under /api (token or cookie required, standard error shape). Answers carry
 * statuses only, never a value; the one exception is the start route's authorization URL,
 * which is the authorization server's own request (it holds the `state` and the PKCE
 * challenge, and is answered with `Cache-Control: no-store`).
 */
export function registerOAuthRoutes(app: Hono, services: AppServices, logger: Logger): void {
  const { oauth, config, port } = services;

  app.get(AUTH_API_PATHS.list, async (c) =>
    c.json({ servers: await oauth.statuses() } satisfies AuthListResponse),
  );

  app.get(AUTH_API_PATHS.cimdDocument, (c) => {
    const url = config.config.settings.cimdUrl;
    if (!url) {
      throw new ConflictError(
        'The "cimdUrl" setting is not set. Set it to the https:// address where you will publish the document ' +
          '(Settings page, or "settings": { "cimdUrl": "…" } in config.json), then ask again.',
        'conflict',
      );
    }
    return c.json({
      url,
      redirectUri: oauthRedirectUri(port),
      document: cimdDocument(url, port),
    } satisfies CimdDocumentResponse);
  });

  app.get('/api/servers/:name/auth', async (c) =>
    c.json({ status: await oauth.status(c.req.param('name')) } satisfies AuthStatusResponse),
  );

  app.post('/api/servers/:name/auth/login', async (c) => {
    const started: SignInStartResponse = await oauth.startSignIn(c.req.param('name'));
    c.header('cache-control', 'no-store');
    return c.json(started);
  });

  app.post('/api/servers/:name/auth/refresh', async (c) =>
    c.json({ status: await oauth.refreshNow(c.req.param('name')) } satisfies AuthStatusResponse),
  );

  app.post('/api/servers/:name/auth/logout', async (c) => {
    const status = await oauth.signOut(c.req.param('name'));
    logger.info({ server: status.server }, 'Signed out through the admin API');
    return c.json({ status } satisfies AuthStatusResponse);
  });

  app.post('/api/servers/:name/auth/forget', async (c) =>
    c.json({ status: await oauth.forget(c.req.param('name')) } satisfies AuthStatusResponse),
  );
}
