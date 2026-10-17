import { parseSecretRef, type ConnectionTestResponse, type ServerEntry, type Settings } from '@mcpier/shared';
import type { OAuthService } from '../oauth/service.js';
import type { ChildGuard, Platform, SecretStore } from '../platform/index.js';
import { createRedactor, type Redactor } from '../secrets/redact.js';
import { MissingSecretError, resolveServerSecrets } from '../secrets/resolve.js';
import { HttpConnector } from '../upstream/http-connector.js';
import { ServerLog, type ServerLogSource } from '../upstream/server-log.js';
import { StdioConnector } from '../upstream/stdio-connector.js';
import { ConnectError, type Connector } from '../upstream/types.js';
import { ConflictError } from './errors.js';

export interface ConnectionTestContext {
  platform: Platform;
  secrets: SecretStore;
  baseEnv: NodeJS.ProcessEnv;
  settings: () => Settings;
  guard?: ChildGuard;
  /** Runs discovery for an OAuth entry (no sign-in, no tokens). */
  oauth?: OAuthService;
}

const STDERR_LINES = 20;

/** A server log that keeps lines in memory only: a test leaves no log file behind. */
class MemoryServerLog extends ServerLog {
  readonly lines: { source: ServerLogSource; text: string }[] = [];
  private redactLine: Redactor = (text) => text;

  constructor(name: string) {
    super(name, '', () => {});
  }

  override setRedactor(redact: Redactor): void {
    this.redactLine = redact;
  }

  override write(source: ServerLogSource, text: string): void {
    for (const part of text.split(/\r?\n/)) {
      if (part.length > 0) this.lines.push({ source, text: this.redactLine(part) });
    }
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }

  override close(): void {}
}

/**
 * Hides every value in the entry's `env` and `headers`, plain or resolved, as
 * `[secret:<name>]` for references and `[value:<KEY>]` for plain values (D-026's redaction).
 */
function entryRedactor(entry: ServerEntry, resolvedValues: ReadonlyMap<string, string>): Redactor {
  const values = new Map<string, string>();
  for (const [name, value] of resolvedValues) values.set(`secret:${name}`, value);
  const maps: [Record<string, string>, 'env' | 'header'][] =
    entry.transport === 'stdio' ? [[entry.env, 'env']] : [[entry.headers, 'header']];
  for (const [map, context] of maps) {
    for (const [key, raw] of Object.entries(map)) {
      const parsed = parseSecretRef(raw, context);
      if (parsed.kind === 'secret') continue;
      values.set(`value:${key}`, raw);
    }
  }
  // createRedactor writes [secret:<name>]; turn the labels into the two forms above.
  const redact = createRedactor(values);
  return (text) =>
    redact(text).replace(/\[secret:(secret|value):([^\]]+)\]/g, (_m, kind, name) =>
      kind === 'secret' ? `[secret:${name}]` : `[value:${name}]`,
    );
}

/**
 * Connects to an unsaved server entry, lists its tools, and disconnects, stopping any process
 * it started on every path. Nothing is saved or added to the catalog, and nothing the entry
 * holds in `env` or `headers` appears in the result.
 */
export async function testConnection(
  entry: ServerEntry,
  context: ConnectionTestContext,
): Promise<ConnectionTestResponse> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const empty = { tools: { count: 0, names: [] as string[] } };

  if (entry.transport === 'http' && entry.auth === 'oauth') {
    // Discovery only: the protected-resource and authorization-server metadata, and which
    // registration method a sign-in would use. Nothing is registered and no token exists.
    if (!context.oauth) {
      return { ok: false, needsAuth: true, ...empty, durationMs: elapsed(), error: 'Save it, then sign in.' };
    }
    const discovery = await context.oauth.discoverOnly(entry);
    const ok = discovery.authorizationServerMetadata && discovery.registrationMethod !== undefined;
    return {
      ok,
      needsAuth: true,
      discovery,
      ...empty,
      durationMs: elapsed(),
      ...(ok ? {} : { error: discovery.note ?? 'Discovery failed.' }),
    };
  }

  let resolved;
  try {
    resolved = await resolveServerSecrets(entry, context.secrets);
  } catch (error) {
    const message =
      error instanceof MissingSecretError
        ? error.message
        : `Could not read secrets: ${(error as Error).message}`;
    return { ok: false, ...empty, durationMs: elapsed(), error: message };
  }

  const redact = entryRedactor(entry, resolved.values);
  const log = new MemoryServerLog(entry.name);
  log.setRedactor(redact);
  const connector: Connector =
    entry.transport === 'stdio'
      ? new StdioConnector(entry, {
          platform: context.platform,
          log,
          baseEnv: context.baseEnv,
          extraPath: context.settings().extraPath,
          env: resolved.env,
          redact,
          guard: context.guard,
        })
      : new HttpConnector(entry, { log, headers: resolved.headers, redact });

  const stderr = () => {
    const lines = log.lines.filter((line) => line.source === 'stderr').map((line) => line.text);
    return lines.slice(-STDERR_LINES);
  };

  try {
    await connector.connect();
    const listing = await connector.listTools();
    const names = listing.tools.map((tool) => tool.name).sort();
    return {
      ok: true,
      ...(connector.protocolVersion ? { protocolVersion: connector.protocolVersion } : {}),
      tools: { count: names.length, names },
      durationMs: elapsed(),
    };
  } catch (error) {
    const message =
      error instanceof ConnectError ? error.message : ((error as Error)?.message ?? String(error));
    const lines = stderr();
    return {
      ok: false,
      ...(error instanceof ConnectError && error.status === 'needs_auth' ? { needsAuth: true } : {}),
      ...empty,
      durationMs: elapsed(),
      error: redact(message),
      ...(lines.length > 0 ? { stderr: lines } : {}),
    };
  } finally {
    await connector.close().catch(() => {});
  }
}

/** Runs at most one connection test per entry name at a time. */
export class ConnectionTests {
  private readonly running = new Set<string>();

  constructor(private readonly context: ConnectionTestContext) {}

  async run(entry: ServerEntry): Promise<ConnectionTestResponse> {
    if (this.running.has(entry.name)) {
      throw new ConflictError(
        `A connection test for "${entry.name}" is already running. Wait for it to finish.`,
        'conflict',
      );
    }
    this.running.add(entry.name);
    try {
      return await testConnection(entry, this.context);
    } finally {
      this.running.delete(entry.name);
    }
  }
}
