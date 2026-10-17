import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { AuthStatus, CallSummary, GatewayEvent, McpierConfig } from '@mcpier/shared';
import type { ConfigService } from '../config-service.js';
import type { ServerManager } from '../manager/manager.js';
import type { OAuthService } from '../oauth/service.js';
import type { CallLog } from '../store/call-log.js';

/**
 * Turns manager, config and secret changes into the dashboard's event stream (SPEC 8). Events
 * carry names, statuses and counts only: never a secret value, a plain env or header value,
 * tool arguments or results. Status details are already redacted by the manager (D-026). A
 * recorded call is published as its summary only: no arguments, result or error text.
 */
export class GatewayEventHub extends EventEmitter<{ event: [GatewayEvent] }> {
  private previous: McpierConfig;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly manager: ServerManager,
    private readonly config: ConfigService,
    oauth?: OAuthService,
    callLog?: CallLog,
  ) {
    super();
    this.setMaxListeners(100);
    this.previous = structuredClone(config.config);

    const onStatus = (name: string) => {
      if (!manager.has(name)) return;
      const summary = manager.summary(name);
      this.publish({
        type: 'server_status',
        data: {
          name,
          status: summary.status,
          ...(summary.protocolVersion ? { protocolVersion: summary.protocolVersion } : {}),
        },
      });
    };
    const onTools = (name: string) => {
      if (!manager.has(name)) return;
      this.publish({ type: 'server_tools', data: { name, tools: manager.summary(name).tools } });
    };
    const onApplied = (next: McpierConfig) => this.diff(next);
    const onProblem = (problem: { file: string; problems: string[]; since: string } | undefined) =>
      this.publish({ type: 'config_problem', data: { problem: problem ?? null } });

    // Sign-in, refresh, sign-out and step-up: the same fields as the auth-status route.
    const onAuth = (_name: string, _change: string, status: AuthStatus) =>
      this.publish({ type: 'auth_status', data: status });
    oauth?.on('changed', onAuth);
    if (oauth) this.unsubscribe.push(() => oauth.off('changed', onAuth));
    // Fields picked one by one, so nothing added to the stored record can reach the stream.
    const onRecorded = (call: CallSummary) =>
      this.publish({
        type: 'call_recorded',
        data: {
          id: call.id,
          at: call.at,
          client: {
            ...(call.client.name !== undefined ? { name: call.client.name } : {}),
            ...(call.client.version !== undefined ? { version: call.client.version } : {}),
          },
          era: call.era,
          tool: call.tool,
          ...(call.server !== undefined ? { server: call.server } : {}),
          durationMs: call.durationMs,
          outcome: call.outcome,
          ...(call.traceId !== undefined ? { traceId: call.traceId } : {}),
          bodiesStored: call.bodiesStored,
        },
      });
    callLog?.on('recorded', onRecorded);
    if (callLog) this.unsubscribe.push(() => callLog.off('recorded', onRecorded));
    manager.on('status', onStatus);
    manager.on('tools', onTools);
    config.on('applied', onApplied);
    config.on('problem', onProblem);
    this.unsubscribe.push(
      () => manager.off('status', onStatus),
      () => manager.off('tools', onTools),
      () => config.off('applied', onApplied),
      () => config.off('problem', onProblem),
    );
  }

  /** Secrets were set or deleted: the current names, never values. */
  secretsChanged(names: string[]): void {
    this.publish({ type: 'secrets_changed', data: { names: [...names].sort() } });
  }

  private publish(event: GatewayEvent): void {
    this.emit('event', event);
  }

  /** Added, edited and removed servers, and settings, between the last config and this one. */
  private diff(next: McpierConfig): void {
    const before = new Map(this.previous.servers.map((server) => [server.name, server]));
    const after = new Map(next.servers.map((server) => [server.name, server]));
    for (const [name, entry] of after) {
      const old = before.get(name);
      if (!old) this.publish({ type: 'server_added', data: { name } });
      else if (!isDeepStrictEqual(old, entry)) this.publish({ type: 'server_edited', data: { name } });
    }
    for (const name of before.keys()) {
      if (!after.has(name)) this.publish({ type: 'server_removed', data: { name } });
    }
    if (!isDeepStrictEqual(this.previous.settings, next.settings)) {
      this.publish({ type: 'settings_changed', data: {} });
    }
    this.previous = structuredClone(next);
  }

  close(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.removeAllListeners();
  }
}
