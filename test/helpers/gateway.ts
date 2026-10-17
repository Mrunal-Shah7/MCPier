import { mkdirSync, writeFileSync } from 'node:fs';
import {
  FakeSecretStore,
  getPlatform,
  readAdminToken,
  startGateway,
  type ManagerTiming,
  type RunningGateway,
  type SecretStore,
  type SessionLimits,
  type GatewayOptions,
} from '@mcpier/core';
import type { McpierConfigInput, ServerStatus } from '@mcpier/shared';
import { getFreePort } from './ports.js';
import { createTempHome, type TempHome } from './temp-home.js';

/** Short lifecycle thresholds so restart and crash tests run in milliseconds. */
export const FAST_TIMING: Partial<ManagerTiming> = {
  healthIntervalMs: 300,
  healthTimeoutMs: 2000,
  backoffBaseMs: 100,
  backoffMaxMs: 800,
  crashLimit: 3,
  crashWindowMs: 60_000,
  minTtlRefreshMs: 100,
};

export interface TestGateway {
  gateway: RunningGateway;
  home: TempHome;
  port: number;
  /** The admin token. Tests may use it but must never print it. */
  token: string;
  /** The secret store the gateway uses (a fake unless one was passed). */
  secrets: SecretStore;
  /** Stops the gateway and, if the helper created the home, deletes it. */
  cleanup(): Promise<void>;
}

export interface TestGatewayOptions {
  home?: TempHome;
  port?: number;
  webRoot?: string;
  /** Written to config.json before the gateway starts. */
  config?: McpierConfigInput;
  /** Defaults to a fresh `FakeSecretStore`: tests never reach Credential Manager. */
  secrets?: SecretStore;
  timing?: Partial<ManagerTiming>;
  childGuard?: boolean;
  configDebounceMs?: number;
  sessionLimits?: Partial<SessionLimits>;
  /** Any other gateway options (cliEntry, eventHeartbeatMs, now, ...). */
  extra?: Partial<GatewayOptions>;
}

/** Starts a gateway in this process on a random free port, with a temporary home. */
export async function startTestGateway(options: TestGatewayOptions = {}): Promise<TestGateway> {
  const home = options.home ?? createTempHome();
  const port = options.port ?? (await getFreePort());
  if (options.config) {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(home.paths.config, JSON.stringify(options.config, null, 2));
  }
  const secrets = options.secrets ?? new FakeSecretStore();
  const gateway = await startGateway({
    dataDir: home.dir,
    platform: getPlatform(),
    env: { MCPIER_PORT: String(port) },
    webRoot: options.webRoot,
    shutdownGraceMs: 1000,
    secrets,
    timing: options.timing,
    childGuard: options.childGuard,
    configDebounceMs: options.configDebounceMs ?? 100,
    sessionLimits: options.sessionLimits,
    ...options.extra,
  });
  return {
    gateway,
    home,
    port,
    secrets,
    token: readAdminToken(home.paths.adminToken),
    async cleanup() {
      await gateway.stop('test cleanup');
      if (!options.home) await home.cleanup();
    },
  };
}

/** Waits until a server reaches one of the given statuses. */
export async function waitForStatus(
  gateway: RunningGateway,
  server: string,
  states: ServerStatus | ServerStatus[],
  timeoutMs = 15_000,
): Promise<void> {
  const wanted = Array.isArray(states) ? states : [states];
  const deadline = Date.now() + timeoutMs;
  while (!wanted.includes(gateway.manager.status(server).state)) {
    if (Date.now() > deadline) {
      const status = gateway.manager.status(server);
      throw new Error(
        `Server "${server}" did not reach ${wanted.join('/')} within ${timeoutMs} ms (it is ${status.state}: ${status.detail ?? ''})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits until a condition holds. */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
