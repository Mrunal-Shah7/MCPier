import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { EVENT_HEARTBEAT_MS, type StatusResponse } from '@mcpier/shared';
import { AdminClient, gatewayUrl, probeHealth } from '../admin-client.js';
import { readAdminToken, readStateKey } from '../admin-token.js';
import { readAutostartStatus } from '../autostart.js';
import { ConfigService } from '../config-service.js';
import { ConfigError } from '../config-store.js';
import { ensureDataDir } from '../data-dir.js';
import { createGatewayLogger, type GatewayLogger, type Logger } from '../logger.js';
import { ServerManager } from '../manager/manager.js';
import { createMetaService, type MetaService } from '../meta/service.js';
import type { ManagerTiming } from '../manager/runtime.js';
import { OAuthService } from '../oauth/service.js';
import { OAuthStore } from '../oauth/store.js';
import { openGatewayStore, type CallLog, type DatabaseOpener } from '../store/index.js';
import type { ChildGuard, Platform, SecretStore } from '../platform/index.js';
import { readPidFile, removePidFile, writePidFile } from '../pid-file.js';
import { effectivePort, PORT_ENV } from '../port.js';
import { defaultWebRoot, projectVersion } from '../version.js';
import { createApp } from './app.js';
import { GatewayEventHub } from './events.js';
import { HandoffCodes } from './handoff.js';
import { IconFetcher, type IconFetch } from '../icons/fetcher.js';
import { IconService } from '../icons/service.js';
import { McpEndpoint, type SessionLimits } from './mcp-endpoint.js';

/** The only address the gateway ever binds to. */
export const BIND_ADDRESS = '127.0.0.1';

export interface GatewayOptions {
  dataDir: string;
  platform: Platform;
  /** Source of `MCPIER_PORT`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Folder with the built dashboard. Defaults to `apps/web/dist` in the repository. */
  webRoot?: string;
  /** Mirror log lines to stdout (foreground mode). */
  consoleLog?: boolean;
  /** How long in-flight requests get to finish on shutdown. Default 5 seconds. */
  shutdownGraceMs?: number;
  /** Secret store. Defaults to the platform's (Credential Manager); tests pass a fake. */
  secrets?: SecretStore;
  /** Lifecycle thresholds (tests shorten them). */
  timing?: Partial<ManagerTiming>;
  /**
   * Start the child guard, so server processes cannot outlive a gateway killed by force.
   * On for the real gateway process; off for most in-process tests.
   */
  childGuard?: boolean;
  /** Debounce for config.json hand edits. Default 250 ms. */
  configDebounceMs?: number;
  /** Legacy /mcp session limits (tests shorten them). */
  sessionLimits?: Partial<SessionLimits>;
  /**
   * The CLI entry script that started this gateway (`node <cliEntry> run-gateway`). The
   * dashboard's connect snippets use it; without it they show placeholder paths.
   */
  cliEntry?: string;
  /** Event-stream heartbeat interval. Default 25 seconds. */
  eventHeartbeatMs?: number;
  /** Clock for hand-off code and pending sign-in expiry (tests). */
  now?: () => number;
  /** OAuth tuning (tests): when a refresh is due before expiry. */
  oauth?: { refreshMarginMs?: number };
  /** Call log tuning (tests): flush and sweep intervals, a failing database opener. */
  callLog?: { flushIntervalMs?: number; sweepIntervalMs?: number; opener?: DatabaseOpener };
  /**
   * Icon fetching (tests only): a fake network, shorter timeouts, and plain `http` to loopback
   * fixture hosts. The real gateway process never sets any of these.
   */
  icons?: { fetchFn?: IconFetch; allowLoopbackHttp?: boolean; timeoutMs?: number };
}

export interface RunningGateway {
  readonly port: number;
  readonly url: string;
  readonly pid: number;
  readonly dataDir: string;
  readonly startedAt: Date;
  /** Every route the app registered (method and path pattern), for the security review test. */
  readonly routes: readonly { method: string; path: string }[];
  readonly logger: Logger;
  readonly manager: ServerManager;
  readonly config: ConfigService;
  readonly secrets: SecretStore;
  /** The meta-tools' index, validator, signer and recorder. */
  readonly meta: MetaService;
  /** The client endpoint (/mcp). */
  readonly mcp: McpEndpoint;
  /** The dashboard's live events. */
  readonly events: GatewayEventHub;
  /** One-time sign-in codes. */
  readonly handoff: HandoffCodes;
  /** OAuth sign-in for remote servers. */
  readonly oauth: OAuthService;
  /** The call and search log (absent when `mcpier.db` could not be used). */
  readonly callLog: CallLog | undefined;
  /** Server logos: discovery, the cache and the files the icon route serves. */
  readonly icons: IconService;
  /** The address the server is bound to. */
  address(): AddressInfo;
  /** Stops the gateway cleanly: every server first, then the HTTP server. Safe to call twice. */
  stop(reason?: string): Promise<void>;
  /** Resolves once the gateway has stopped, whatever stopped it. */
  readonly stopped: Promise<void>;
}

/** Why the gateway refused to start. `message` is meant for the user, as is. */
export class GatewayStartError extends Error {
  constructor(
    message: string,
    readonly code: 'already_running' | 'port_in_use' | 'invalid_config' | 'other',
    readonly pid?: number,
  ) {
    super(message);
    this.name = 'GatewayStartError';
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_ADDRESS);
  });
}

/** Explains who holds the port: this data directory's gateway, another MCPier, or something else. */
async function describePortConflict(
  port: number,
  tokenFile: string,
  configFile: string,
): Promise<GatewayStartError> {
  const probe = await probeHealth(port);
  if (probe.kind === 'mcpier') {
    try {
      const status = await new AdminClient(port, readAdminToken(tokenFile)).status();
      return new GatewayStartError(
        `MCPier is already running (pid ${status.pid}) on ${gatewayUrl(port)}.`,
        'already_running',
        status.pid,
      );
    } catch {
      return new GatewayStartError(
        `Another MCPier gateway (using a different data directory) is already running on port ${port}.`,
        'already_running',
      );
    }
  }
  return new GatewayStartError(
    `Port ${port} on ${BIND_ADDRESS} is already in use by another program. ` +
      `Change "settings.port" in ${configFile}, or set the ${PORT_ENV} environment variable.`,
    'port_in_use',
  );
}

/**
 * Starts the gateway: first-run setup, config, single-instance check, the HTTP server on
 * 127.0.0.1, then every enabled server (in the background; none can block the gateway).
 * Throws `GatewayStartError` (already logged) when it refuses to start.
 */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const { paths } = await ensureDataDir(options.dataDir, options.platform);
  // The log exists before anything can fail, so a failed background start can be explained
  // from the log alone.
  const log: GatewayLogger = createGatewayLogger({ file: paths.gatewayLog, console: options.consoleLog });
  const { logger } = log;

  const refuse = (error: GatewayStartError): never => {
    logger.error({ reason: error.code }, `Gateway not started: ${error.message}`);
    log.close();
    throw error;
  };

  try {
    const configService = await ConfigService.load(paths.config, logger, options.configDebounceMs).catch(
      (error: unknown) => {
        if (error instanceof ConfigError) refuse(new GatewayStartError(error.message, 'invalid_config'));
        throw error;
      },
    );
    const port = effectivePort(configService.config, options.env ?? process.env);
    const token = readAdminToken(paths.adminToken);
    const version = projectVersion();

    // Single instance per data directory.
    const recorded = readPidFile(paths.pidFile);
    if (recorded) {
      const answering =
        options.platform.processes.isAlive(recorded.pid) &&
        (await probeHealth(recorded.port)).kind === 'mcpier';
      if (answering) {
        refuse(
          new GatewayStartError(
            `MCPier is already running (pid ${recorded.pid}) on ${gatewayUrl(recorded.port)}.`,
            'already_running',
            recorded.pid,
          ),
        );
      }
      logger.warn({ stalePid: recorded.pid }, 'Replacing stale pid file');
    }

    const secrets = options.secrets ?? options.platform.secrets;
    // The store key is read from the internal store on first use only, so a gateway that has
    // no OAuth server never touches it.
    const oauth = new OAuthService({
      store: new OAuthStore(paths.oauthDir, secrets.internal(), logger),
      secrets,
      logger,
      port,
      config: () => configService.config,
      ...(options.now ? { now: options.now } : {}),
      ...(options.oauth?.refreshMarginMs !== undefined
        ? { refreshMarginMs: options.oauth.refreshMarginMs }
        : {}),
    });
    await oauth
      .reconcile(configService.config)
      .catch((error: unknown) =>
        logger.warn({ err: { message: (error as Error).message } }, 'Could not tidy the OAuth records'),
      );
    // Calls, searches and the tool cache. Without a usable database, the gateway log records
    // calls and searches instead, and the gateway runs on.
    const store = openGatewayStore({
      file: paths.db,
      logger,
      settings: () => configService.config.settings,
      ...(options.now ? { now: options.now } : {}),
      ...options.callLog,
    });
    const guard: ChildGuard | undefined = options.childGuard
      ? await options.platform.processes.startChildGuard()
      : undefined;
    const manager = new ServerManager({
      platform: options.platform,
      secrets,
      logsDir: paths.logsDir,
      logger,
      timing: options.timing,
      guard,
      oauth,
      ...(store.toolCache ? { toolCache: store.toolCache } : {}),
    });

    const meta = createMetaService({
      manager,
      settings: () => configService.config.settings,
      logger,
      stateKey: readStateKey(paths.stateKey),
      recorder: store.recorder,
    });
    const mcp = new McpEndpoint({ meta, version, logger, limits: options.sessionLimits });
    const events = new GatewayEventHub(manager, configService, oauth, store.callLog);
    const handoff = new HandoffCodes(options.now);

    // Server logos, fetched in the background: never with the server's headers or tokens.
    const icons = new IconService({
      dir: paths.iconsDir,
      fetcher: new IconFetcher({ userAgent: `MCPier/${version}`, ...options.icons }),
      logger,
      ...(options.now ? { now: options.now } : {}),
    });
    manager.setIconInfo((name) => icons.info(name));
    icons.on('changed', (name) => events.iconChanged(name));
    manager.on('status', (name, info) => {
      if (!manager.has(name)) return;
      const entry = manager.entry(name);
      if (info.state === 'ready') void icons.consider(entry, manager.serverInfo(name), 'ready');
      else if (info.state === 'needs_auth' || info.state === 'error')
        void icons.consider(entry, undefined, 'not_ready');
    });

    const startedAt = new Date();
    let stopPromise: Promise<void> | undefined;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
    /** Aborted when shutdown begins, so long-lived responses (log streams) end at once. */
    const closing = new AbortController();

    const status = (): StatusResponse => {
      const config = configService.config;
      const problem = configService.problem;
      return {
        version,
        pid: process.pid,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        port,
        dataDir: paths.dir,
        servers: {
          configured: config.servers.length,
          enabled: config.servers.filter((server) => server.enabled).length,
          byStatus: manager.statusCounts(),
        },
        ...(problem ? { configProblem: problem } : {}),
        callLog: store.state,
      };
    };

    const app = createApp({
      port,
      version,
      token,
      webRoot: options.webRoot ?? defaultWebRoot(),
      logger,
      status,
      requestShutdown: () => void gateway.stop('admin API request'),
      services: {
        manager,
        config: configService,
        secrets,
        logsDir: paths.logsDir,
        closing: closing.signal,
        meta,
        events,
        handoff,
        oauth,
        icons,
        ...(store.callLog ? { callLog: store.callLog } : {}),
        heartbeatMs: options.eventHeartbeatMs ?? EVENT_HEARTBEAT_MS,
        autostart: () => readAutostartStatus(options.platform.autostart),
        port,
        status,
        ...(options.cliEntry ? { launch: { nodePath: process.execPath, cliEntry: options.cliEntry } } : {}),
      },
      mcp,
    });
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;

    try {
      await listen(server, port);
    } catch (error) {
      await guard?.release();
      await store.close();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        refuse(await describePortConflict(port, paths.adminToken, paths.config));
      }
      throw error;
    }

    writePidFile(paths.pidFile, { pid: process.pid, port, startedAt: startedAt.toISOString() });
    logger.info({ version, port, dataDir: paths.dir }, 'Gateway started');

    let retentionDays = configService.config.settings.logRetentionDays;
    let iconFields = new Map(configService.config.servers.map((entry) => [entry.name, entry.icon]));
    configService.on('applied', (config) => {
      // A removed server's icons go; a changed `icon` field is fetched again at once.
      const next = new Map(config.servers.map((entry) => [entry.name, entry.icon]));
      for (const name of iconFields.keys()) if (!next.has(name)) icons.remove(name);
      for (const entry of config.servers) {
        if (iconFields.has(entry.name) && iconFields.get(entry.name) !== entry.icon) {
          void icons.consider(entry, manager.serverInfo(entry.name), 'config');
        }
      }
      iconFields = next;
      // A changed retention applies at once (a lower one purges now).
      if (config.settings.logRetentionDays !== retentionDays) {
        retentionDays = config.settings.logRetentionDays;
        void store.callLog?.purge().catch(() => {});
      }
      // First, so a server restarted by this change never sees a record of its old URL.
      void oauth
        .reconcile(config)
        .catch((error: unknown) =>
          logger.warn({ err: { message: (error as Error).message } }, 'Could not tidy the OAuth records'),
        );
      manager.applyConfig(config);
      // Descriptions, disabled tools and search weights change without a tools event.
      meta.search.invalidate();
    });
    manager.applyConfig(configService.config);
    configService.watch();
    store.callLog?.startSweeps();

    const gateway: RunningGateway = {
      port,
      url: gatewayUrl(port),
      pid: process.pid,
      dataDir: paths.dir,
      startedAt,
      routes: app.routes.map((route) => ({ method: route.method, path: route.path })),
      logger,
      manager,
      config: configService,
      secrets,
      meta,
      mcp,
      events,
      handoff,
      oauth,
      callLog: store.callLog,
      icons,
      stopped,
      address: () => server.address() as AddressInfo,
      stop(reason = 'requested') {
        stopPromise ??= (async () => {
          logger.info({ reason }, 'Gateway shutting down');
          closing.abort();
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          server.closeIdleConnections();
          // Legacy event streams would otherwise hold the server open until the grace period.
          await mcp.close();
          meta.close();
          events.close();
          icons.close();
          const grace = setTimeout(() => server.closeAllConnections(), options.shutdownGraceMs ?? 5000);
          configService.close();
          await manager.stopAll();
          // Calls cut off by the shutdown are recorded too, then the database is closed.
          await store.close();
          await guard?.release();
          // Streams ended by `closing` (events, logs) leave keep-alive connections that went
          // idle after the first sweep; close those too instead of waiting for the grace timer.
          server.closeIdleConnections();
          await closed;
          clearTimeout(grace);
          removePidFile(paths.pidFile, process.pid);
          logger.info('Gateway stopped');
          log.close();
          resolveStopped();
        })();
        return stopPromise;
      },
    };
    return gateway;
  } catch (error) {
    if (!(error instanceof GatewayStartError)) {
      logger.error({ err: { message: (error as Error).message } }, 'Gateway failed to start');
      log.close();
    }
    throw error;
  }
}
