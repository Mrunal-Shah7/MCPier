// Admin API routes added for the dashboard (Sprint 4). Everything here is under /api, so the
// Host/Origin and token (or admin cookie) checks run first.
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  AUTH_PATHS,
  AUTOSTART_API_PATH,
  connectSnippets,
  DASHBOARD_API_PATHS,
  HANDOFF_CODE_TTL_SECONDS,
  mcpEndpointUrl,
  MoveToSecretRequestSchema,
  parseSecretRef,
  splitScheme,
  validateConfig,
  type AutostartResponse,
  type ConnectResponse,
  type MoveToSecretResponse,
  type GatewayEvent,
  type SessionCodeResponse,
  type SettingsResponse,
  type SettingsUpdateResponse,
} from '@mcpier/shared';
import type { Logger } from '../logger.js';
import { ConflictError, InvalidRequestError, NotFoundError } from '../manager/errors.js';
import { AUTOSTART_COMMANDS } from '../autostart.js';
import { checkSecretName, checkSecretValue } from '../platform/index.js';
import type { AppServices } from './app.js';

/** Shown instead of real paths when the CLI did not start this gateway (tests, in-process). */
export const PLACEHOLDER_PATHS = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliEntry: '<MCPier repository>\\apps\\cli\\dist\\mcpier.js',
};

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new InvalidRequestError('The request body must be JSON.');
  }
}

export function registerDashboardRoutes(app: Hono, services: AppServices, logger: Logger): void {
  const { manager, config, events, handoff, closing, secrets } = services;

  // ---- Sign-in hand-off code (the CLI asks with the token; the code goes in the browser URL)

  app.post(DASHBOARD_API_PATHS.sessionCode, (c) => {
    const code = handoff.issue();
    const body: SessionCodeResponse = {
      code,
      path: `${AUTH_PATHS.handoff}?code=${encodeURIComponent(code)}`,
      expiresInSeconds: HANDOFF_CODE_TTL_SECONDS,
    };
    c.header('cache-control', 'no-store');
    return c.json(body);
  });

  // ---- Live events

  app.get(DASHBOARD_API_PATHS.events, (c) => {
    c.header('cache-control', 'no-store');
    return streamSSE(c, async (stream) => {
      const send = (event: GatewayEvent) =>
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) }).catch(() => {});
      // A reconnecting page is correct at once: gateway status and every server's status.
      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify({ status: services.status(), servers: manager.summaries() }),
      });
      events.on('event', send);
      const heartbeat = setInterval(
        () => void stream.write(': heartbeat\n\n').catch(() => {}),
        services.heartbeatMs,
      );
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        if (closing.aborted) resolve();
        closing.addEventListener('abort', () => resolve(), { once: true });
      });
      clearInterval(heartbeat);
      events.off('event', send);
    });
  });

  // ---- Connection test (nothing is saved)

  app.post(DASHBOARD_API_PATHS.connectionTest, async (c) => {
    const body = await readJson(c);
    const result = validateConfig({ servers: [body] });
    if (!result.ok) {
      throw new InvalidRequestError(
        'The server entry is invalid.',
        result.problems.map((problem) => problem.replace(/^servers\[0\]\.?/, '') || problem),
      );
    }
    const entry = result.config.servers[0]!;
    const outcome = await manager.testConnection(entry);
    // The name only: never the entry's values.
    logger.info({ server: entry.name, ok: outcome.ok, durationMs: outcome.durationMs }, 'Connection test');
    return c.json(outcome);
  });

  // ---- Move a plain env or header value into Credential Manager

  app.post(DASHBOARD_API_PATHS.moveToSecret(':name'), async (c) => {
    const name = c.req.param('name') ?? '';
    const request = MoveToSecretRequestSchema.safeParse(await readJson(c));
    if (!request.success) {
      throw new InvalidRequestError(
        'The body must be { "location": "env" | "header", "key": …, "secretName": …, "replace"?: true }.',
      );
    }
    const { location, key, secretName, replace } = request.data;
    checkSecretName(secretName);
    const stored = config.config.servers.find((server) => server.name === name);
    if (!stored) throw new NotFoundError(`No server named "${name}".`);
    const map =
      (location === 'env'
        ? (stored as { env?: Record<string, string> }).env
        : (stored as { headers?: Record<string, string> }).headers) ?? {};
    const raw = map[key];
    if (raw === undefined)
      throw new NotFoundError(
        `Server "${name}" has no ${location === 'env' ? 'env variable' : 'header'} "${key}".`,
      );
    if (parseSecretRef(raw, location).kind === 'secret') {
      throw new ConflictError(`"${key}" already refers to a secret.`, 'conflict');
    }
    // Headers keep their scheme in config (D-031): "Bearer secret:<name>".
    const { scheme, token } = location === 'header' ? splitScheme(raw) : { scheme: undefined, token: raw };
    const reference = `${scheme ? `${scheme} ` : ''}secret:${secretName}`;
    const existed = (await secrets.get(secretName)) !== undefined;
    if (existed && replace !== true) {
      throw new ConflictError(
        `A secret named "${secretName}" already exists. Choose another name, or replace it.`,
        'exists',
      );
    }
    checkSecretValue(token);
    await secrets.set(secretName, token);
    try {
      await config.update((draft) => {
        const entry = draft.servers.find((server) => server.name === name) as unknown as Record<
          string,
          Record<string, string>
        >;
        entry[location === 'env' ? 'env' : 'headers']![key] = reference;
      });
    } catch (error) {
      // Keep Credential Manager and config in step: drop a secret this request created.
      if (!existed) await secrets.delete(secretName).catch(() => {});
      throw error;
    }
    logger.info({ server: name, location, key, secret: secretName }, 'Value moved to a secret');
    events.secretsChanged(await secrets.listNames());
    return c.json({
      server: manager.summary(name),
      reference,
      secret: secretName,
    } satisfies MoveToSecretResponse);
  });

  // ---- Settings

  app.get(DASHBOARD_API_PATHS.settings, (c) =>
    c.json({ settings: config.config.settings } satisfies SettingsResponse),
  );

  app.patch(DASHBOARD_API_PATHS.settings, async (c) => {
    const patch = await readJson(c);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new InvalidRequestError('The body must be an object of settings to change.');
    }
    const previousPort = config.config.settings.port;
    const updated = await config.update((draft) => {
      // Unknown keys already in the file are kept; `null` removes an optional setting.
      const merged: Record<string, unknown> = { ...(draft.settings as unknown as Record<string, unknown>) };
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      draft.settings = merged as unknown as typeof draft.settings;
    });
    const restartRequired = updated.settings.port !== previousPort;
    const notes = restartRequired
      ? [
          `The port change is saved. MCPier keeps listening on ${services.port} until it restarts ` +
            '(mcpier stop, then mcpier start); then update your clients with mcpier connect.',
        ]
      : [];
    return c.json({ settings: updated.settings, restartRequired, notes } satisfies SettingsUpdateResponse);
  });

  // ---- Autostart (read-only: the CLI changes it)

  app.get(AUTOSTART_API_PATH, async (c) =>
    c.json({ status: await services.autostart(), commands: AUTOSTART_COMMANDS } satisfies AutostartResponse),
  );

  // ---- Connect snippets

  app.get(DASHBOARD_API_PATHS.connect, (c) => {
    const placeholder = services.launch === undefined;
    const paths = services.launch ?? PLACEHOLDER_PATHS;
    const body: ConnectResponse = {
      url: mcpEndpointUrl(services.port),
      port: services.port,
      placeholder,
      ...(placeholder
        ? {
            note:
              'This gateway was not started by the mcpier command, so the node.exe and script paths ' +
              'below are placeholders. Run "mcpier connect <client>" for the real ones.',
          }
        : {}),
      clients: connectSnippets({ nodePath: paths.nodePath, cliEntry: paths.cliEntry, port: services.port }),
    };
    return c.json(body);
  });
}
