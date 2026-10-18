import { readFileSync } from 'node:fs';
import {
  jsonErrorMessage,
  API_PATHS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  isSecretRef,
  PROTOCOL_MODES,
  scopeProblem,
  splitScopes,
  type ImportResponse,
  type ServerDetailResponse,
  type ServerListResponse,
  type ServerLogResponse,
  type ServerRemovedResponse,
  type ServerResponse,
  type ServerSummary,
} from '@mcpier/shared';
import { connectApi, type Api } from '../api.js';
import { CliError } from '../errors.js';
import { printJson, shorten, statusLine, table } from '../format.js';
import { planImport, type SecretMode } from '../import-plan.js';
import { isInteractive, readStdin, terminalPrompter } from '../prompt.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After add, enable, start or restart: waits until the server leaves `starting` (up to its
 * startup timeout plus a margin), then prints the outcome. Returns the exit code.
 */
export async function waitAndReport(api: Api, name: string, startupTimeoutMs: number): Promise<number> {
  return reportOutcome(api, await waitSettled(api, name, startupTimeoutMs, true));
}

/** Polls until the server leaves `starting`, or its startup timeout plus a margin passes. */
async function waitSettled(
  api: Api,
  name: string,
  startupTimeoutMs: number,
  announce: boolean,
): Promise<ServerSummary> {
  const deadline = Date.now() + startupTimeoutMs + 5000;
  let summary = (await api.request<ServerResponse>('GET', API_PATHS.server(name))).server;
  if (announce && summary.status.state === 'starting') {
    process.stdout.write(`Waiting for ${name} to start (up to ${Math.round(startupTimeoutMs / 1000)} s)…\n`);
  }
  while (summary.status.state === 'starting' && Date.now() < deadline) {
    await sleep(150);
    summary = (await api.request<ServerResponse>('GET', API_PATHS.server(name))).server;
  }
  return summary;
}

/** Exit code for a settled server: 0 unless it failed to start. */
function outcomeCode(server: ServerSummary): number {
  return ['ready', 'needs_auth', 'stopped'].includes(server.status.state) ? 0 : 1;
}

async function reportOutcome(api: Api, server: ServerSummary): Promise<number> {
  const { state, detail } = server.status;
  if (state === 'ready') {
    console.log(
      `${server.name} is ready (protocol ${server.protocolVersion ?? 'unknown'}, ${server.tools.total} tools).`,
    );
    return 0;
  }
  if (state === 'needs_auth') {
    console.log(`${server.name} needs sign-in: ${detail ?? ''}`);
    return 0;
  }
  if (state === 'stopped') {
    console.log(`${server.name} is ${server.enabled ? 'stopped' : 'disabled'}.`);
    return 0;
  }
  if (state === 'starting') {
    console.error(`${server.name} is still starting. Check it with: mcpier server list`);
    return 1;
  }
  console.error(`${server.name} failed to start (${state}):`);
  for (const line of (detail ?? '').split('\n')) console.error(`  ${line}`);
  const logs = await api
    .request<ServerLogResponse>('GET', `${API_PATHS.serverLogs(server.name)}?lines=5`)
    .catch(() => undefined);
  if (logs && logs.lines.length > 0) {
    console.error('Last log lines:');
    for (const line of logs.lines) console.error(`  ${line}`);
  }
  return 1;
}

export async function serverList(options: { json?: boolean }): Promise<number> {
  const api = await connectApi();
  const { servers } = await api.request<ServerListResponse>('GET', API_PATHS.servers);
  if (options.json) {
    printJson({ servers });
    return 0;
  }
  if (servers.length === 0) {
    console.log('No servers configured. Add one with: mcpier server add <name> -- <command> [args…]');
    return 0;
  }
  console.log(
    table(
      ['NAME', 'TRANSPORT', 'STATUS', 'PROTOCOL', 'TOOLS', 'LAST ERROR'],
      servers.map((server) => [
        server.name,
        server.transport,
        server.enabled ? server.status.state : 'disabled',
        server.protocolVersion ?? '-',
        `${server.tools.enabled}/${server.tools.total}`,
        server.status.state === 'error' || server.status.state === 'crashed'
          ? shorten(server.status.detail)
          : '',
      ]),
    ),
  );
  return 0;
}

function collectPairs(values: readonly string[], separator: '=' | ':', what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf(separator);
    const key = index > 0 ? value.slice(0, index).trim() : '';
    if (!key)
      throw new CliError(
        `${what} "${value}" must look like ${separator === '=' ? 'KEY=VALUE' : '"Name: value"'}.`,
      );
    out[key] = value.slice(index + 1).trim();
  }
  return out;
}

function lineCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new CliError('--lines must be a whole number (0 or more).');
  return number;
}

function positiveInt(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0)
    throw new CliError(`${option} must be a whole number of milliseconds.`);
  return number;
}

export interface ServerAddOptions {
  url?: string;
  oauth?: boolean;
  /** Repeatable; a value with spaces is split into several scopes. */
  scope?: string[];
  clientId?: string;
  /** Only `secret:<name>`: a plain value is refused and never echoed. */
  clientSecret?: string;
  description?: string;
  env?: string[];
  header?: string[];
  protocol?: string;
  timeout?: string;
  startupTimeout?: string;
  disabled?: boolean;
}

export async function serverAdd(name: string, command: string[], options: ServerAddOptions): Promise<number> {
  if (options.url && command.length > 0) {
    throw new CliError('Give either a command (after --) or --url, not both.');
  }
  if (!options.url && command.length === 0) {
    throw new CliError('Give the server command after --, or --url for a remote server.', {
      hint: 'mcpier server add files -- npx -y @modelcontextprotocol/server-filesystem "C:\\data"',
    });
  }
  if (options.protocol && !(PROTOCOL_MODES as readonly string[]).includes(options.protocol)) {
    throw new CliError(`--protocol must be one of: ${PROTOCOL_MODES.join(', ')}.`);
  }
  // The OAuth client flags imply --oauth, and only make sense for a remote server.
  const scopes = splitScopes(...(options.scope ?? []));
  const oauthFlags =
    scopes.length > 0 || options.clientId !== undefined || options.clientSecret !== undefined;
  if (oauthFlags && !options.url) {
    throw new CliError('--scope, --client-id and --client-secret are for remote servers (--url).');
  }
  for (const scope of scopes) {
    const problem = scopeProblem(scope);
    if (problem) throw new CliError(`--scope "${scope}" ${problem}.`);
  }
  if (options.clientSecret !== undefined && !isSecretRef(options.clientSecret, 'env')) {
    // Never echo the value: it may be a real client secret typed by mistake.
    throw new CliError(
      '--client-secret takes only a reference, such as secret:<name>, never the secret itself.',
      {
        hint: 'Store it first with: mcpier secret set <name>, then pass --client-secret secret:<name>',
      },
    );
  }
  if (options.clientSecret !== undefined && options.clientId === undefined) {
    throw new CliError('--client-secret needs --client-id too: a client secret belongs to a client ID.');
  }
  const entry: Record<string, unknown> = { name };
  if (options.description) entry.description = options.description;
  if (options.disabled) entry.enabled = false;
  if (options.protocol) entry.protocol = options.protocol;
  const timeoutMs = positiveInt(options.timeout, '--timeout');
  if (timeoutMs) entry.timeoutMs = timeoutMs;
  const startupTimeoutMs = positiveInt(options.startupTimeout, '--startup-timeout');
  if (startupTimeoutMs) entry.startupTimeoutMs = startupTimeoutMs;
  if (options.url) {
    if (options.env?.length)
      throw new CliError('--env is for stdio servers; use --header for a remote server.');
    Object.assign(entry, {
      transport: 'http',
      url: options.url,
      headers: collectPairs(options.header ?? [], ':', 'Header'),
    });
    if (options.oauth || oauthFlags) entry.auth = 'oauth';
    if (oauthFlags) {
      entry.oauth = {
        ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
        ...(options.clientSecret !== undefined ? { clientSecret: options.clientSecret } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
      };
    }
  } else {
    if (options.header?.length || options.oauth) {
      throw new CliError('--header and --oauth are for remote servers (--url).');
    }
    const [executable, ...args] = command;
    Object.assign(entry, {
      transport: 'stdio',
      command: executable,
      args,
      env: collectPairs(options.env ?? [], '=', 'Env value'),
    });
  }

  const api = await connectApi();
  await api.request<ServerResponse>('POST', API_PATHS.servers, entry);
  console.log(`Added ${name}.`);
  if (options.disabled) return 0;
  return waitAndReport(api, name, startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
}

export interface ServerImportOptions {
  dryRun?: boolean;
  moveSecrets?: boolean;
  keepSecrets?: boolean;
}

export async function serverImport(file: string, options: ServerImportOptions): Promise<number> {
  if (options.moveSecrets && options.keepSecrets)
    throw new CliError('Use either --move-secrets or --keep-secrets.');
  let text: string;
  try {
    text = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
  } catch (error) {
    throw new CliError(
      `Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
  let pasted: unknown;
  try {
    pasted = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new CliError(`${file === '-' ? 'The input' : file} is not valid JSON: ${jsonErrorMessage(error)}`);
  }

  const api = await connectApi();
  const existing = (await api.request<ServerListResponse>('GET', API_PATHS.servers)).servers.map(
    (server) => server.name,
  );
  // Questions need a terminal on both sides; a block read from standard input has used it up.
  const canAsk = file !== '-' && isInteractive();
  const mode: SecretMode = options.moveSecrets
    ? 'move'
    : options.keepSecrets
      ? 'keep'
      : canAsk
        ? 'ask'
        : 'keep';
  const plan = await planImport(pasted, existing, mode, mode === 'ask' ? terminalPrompter() : undefined);

  if (!options.dryRun) {
    for (const move of plan.moves) {
      await api.request('PUT', API_PATHS.secret(move.secretName), { value: move.value });
    }
  }
  // A plain OAuth client secret is moved into a secret by the gateway itself (the same planner
  // as the dashboard), never kept as plain text; --keep-secrets refuses such an entry.
  const result = await api.request<ImportResponse>('POST', API_PATHS.import, {
    source: plan.source,
    dryRun: options.dryRun === true,
    ...(options.keepSecrets ? { keepSecrets: true } : {}),
  });

  const verb = options.dryRun ? 'Would create' : 'Created';
  for (const entry of result.entries) {
    const target =
      entry.entry.transport === 'stdio'
        ? [entry.entry.command, ...((entry.entry.args as string[]) ?? [])].join(' ')
        : String(entry.entry.url);
    console.log(`${verb} ${entry.name} (${entry.entry.transport}): ${target}`);
    if (entry.oauth) {
      const details = [
        entry.oauth.clientId ? `client ID ${entry.oauth.clientId}` : undefined,
        entry.oauth.scopes.length > 0 ? `scopes ${entry.oauth.scopes.join(' ')}` : undefined,
      ].filter(Boolean);
      console.log(`  OAuth detected${details.length > 0 ? `: ${details.join(', ')}` : ''}`);
      const secret = entry.oauth.clientSecret;
      if (secret?.kind === 'plain' && secret.movedTo) {
        console.log(
          `  clientSecret → secret:${secret.movedTo} (${options.dryRun ? 'would be stored' : 'stored'} in Credential Manager)`,
        );
      } else if (secret?.kind === 'reference') {
        console.log(`  clientSecret → ${secret.reference}`);
      }
    }
    for (const note of entry.notes ?? []) console.log(`  Note: ${note}`);
    if (entry.ignored.length > 0) console.log(`  Ignored fields: ${entry.ignored.join(', ')}`);
  }
  for (const move of plan.moves) {
    console.log(
      `${options.dryRun ? 'Would store' : 'Stored'} ${move.server} ${move.location} ${move.key} as secret "${move.secretName}".`,
    );
  }
  if (plan.kept.length > 0) {
    const list = plan.kept.map((value) => `${value.server} ${value.location} ${value.key}`).join(', ');
    console.error(
      `Warning: ${options.dryRun ? 'would keep' : 'kept'} as plain text in config.json: ${list}.`,
    );
    console.error('  Move them later with "mcpier secret set <name>" and a secret:<name> reference.');
  }
  for (const error of result.errors) console.error(`Not imported: "${error.key}" ${error.message}`);
  if (result.entries.length === 0 && result.errors.length === 0) console.log('Nothing to import.');
  if (!options.dryRun && result.created.length > 0)
    console.log('Check their status with: mcpier server list');
  return result.errors.length > 0 ? 1 : 0;
}

export async function serverShow(name: string, options: { json?: boolean }): Promise<number> {
  const api = await connectApi();
  const detail = await api.request<ServerDetailResponse>('GET', API_PATHS.server(name));
  if (options.json) {
    printJson(detail);
    return 0;
  }
  const { server, config, tools } = detail;
  console.log(statusLine(server).split('\n')[0]);
  if (server.status.detail?.includes('\n')) {
    for (const line of server.status.detail.split('\n').slice(1)) console.log(`  ${line}`);
  }
  if (server.protocolVersion) console.log(`Protocol: ${server.protocolVersion}`);
  if (server.uptimeSeconds !== undefined) console.log(`Uptime: ${server.uptimeSeconds} s`);
  console.log('Config (as stored in config.json):');
  for (const line of JSON.stringify(config, null, 2).split('\n')) console.log(`  ${line}`);
  console.log(`Tools (${tools.filter((tool) => tool.enabled).length} enabled of ${tools.length}):`);
  for (const tool of tools) {
    const marks = [
      !tool.enabled && 'disabled',
      !tool.available && 'unavailable',
      tool.flag && 'flagged',
    ].filter(Boolean);
    console.log(`  ${tool.fullName}${marks.length > 0 ? `  [${marks.join(', ')}]` : ''}`);
  }
  return 0;
}

export async function serverAction(
  action: 'enable' | 'disable' | 'start' | 'stop' | 'restart' | 'refresh',
  name: string,
  options: { json?: boolean } = {},
): Promise<number> {
  const api = await connectApi();
  const { server } = await api.request<ServerResponse>('POST', API_PATHS.serverAction(name, action));
  if (action === 'enable' || action === 'start' || action === 'restart') {
    const detail = await api.request<ServerDetailResponse>('GET', API_PATHS.server(name));
    const timeout = (detail.config.startupTimeoutMs as number | undefined) ?? DEFAULT_STARTUP_TIMEOUT_MS;
    if (options.json) {
      const settled = await waitSettled(api, name, timeout, false);
      printJson({ server: settled });
      return outcomeCode(settled);
    }
    return waitAndReport(api, name, timeout);
  }
  if (options.json) {
    printJson({ server });
    return 0;
  }
  if (action === 'refresh') {
    console.log(`${name}: ${server.tools.total} tools (${server.tools.enabled} enabled).`);
  } else {
    console.log(`${name} is ${action === 'disable' ? 'disabled' : server.status.state}.`);
  }
  return 0;
}

export async function serverRemove(name: string): Promise<number> {
  const api = await connectApi();
  const { removed } = await api.request<ServerRemovedResponse>('DELETE', API_PATHS.server(name));
  console.log(`Removed ${removed}.`);
  return 0;
}

export async function serverLogs(
  name: string,
  options: { lines?: string; follow?: boolean },
): Promise<number> {
  const api = await connectApi();
  const lines = lineCount(options.lines) ?? 50;
  const recent = await api.request<ServerLogResponse>('GET', `${API_PATHS.serverLogs(name)}?lines=${lines}`);
  for (const line of recent.lines) console.log(line);
  if (!options.follow) return 0;

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const response = await api.stream(API_PATHS.serverLogStream(name), controller.signal);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        if (!/^event: line$/m.test(event)) continue;
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        console.log(data);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  return 0;
}
