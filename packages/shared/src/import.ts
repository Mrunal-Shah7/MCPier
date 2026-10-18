import { splitScopes } from './oauth.js';
import { isSecretRef } from './secrets.js';
import { SLUG_MAX_LENGTH, slugProblem } from './slug.js';

/** A plain env value or header that looks like a credential. */
export interface SensitiveValue {
  location: 'env' | 'header';
  key: string;
  /** For `Authorization: Bearer <token>` style headers: the scheme word kept in config. */
  scheme?: string;
}

/** One entry of a pasted block, converted to an MCPier server entry (not yet validated). */
export interface ImportCandidate {
  /** The key as written in the pasted block. */
  key: string;
  /** The key converted to a server name. */
  name: string;
  /** A server entry in config.json form. */
  entry: Record<string, unknown>;
  /** Fields of the pasted entry that MCPier does not use. */
  ignored: string[];
  /** Plain values that look like credentials (candidates for Credential Manager). */
  sensitive: SensitiveValue[];
  /** Things the user should know about this entry (an OAuth block dropped or ignored). */
  notes?: string[];
  /** An OAuth sign-in was detected (an `oauth` block, `"oauth": true` or `"auth": "oauth"`). */
  oauth?: ImportOAuth;
}

/** What the importer understood of an entry's OAuth settings (no secret value). */
export interface ImportOAuth {
  clientId?: string;
  scopes: string[];
  /**
   * The client secret: a reference given as one, or a plain value that is always moved into a
   * secret (`movedTo` names it once planned). The value itself is never part of this.
   */
  clientSecret?: { kind: 'reference'; reference: string } | { kind: 'plain'; movedTo?: string };
}

export interface ImportProblem {
  key: string;
  message: string;
}

export interface ImportParseResult {
  /** Which shape was recognised. */
  shape: 'mcpServers' | 'servers' | 'bare';
  candidates: ImportCandidate[];
  errors: ImportProblem[];
}

/** Lowercase; anything outside a-z and 0-9 becomes a hyphen; no leading, trailing or double hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

const SENSITIVE_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|AUTH/i;
const PAT_PATTERN = /(^|[^A-Za-z])PAT($|[^A-Za-z])/i;
const SCHEME_VALUE = /^(Bearer|Basic|Token)\s+(\S.*)$/i;

/** Whether an env key or header name looks like it holds a credential. */
export function looksSensitive(location: 'env' | 'header', key: string): boolean {
  if (location === 'header' && key.toLowerCase() === 'authorization') return true;
  return SENSITIVE_PATTERN.test(key) || PAT_PATTERN.test(key);
}

/** Splits `Bearer <token>` into scheme and token; other values are all token. */
export function splitScheme(value: string): { scheme?: string; token: string } {
  const match = SCHEME_VALUE.exec(value);
  return match ? { scheme: match[1]!, token: match[2]! } : { token: value };
}

/** Proposed Credential Manager name for a moved value: server name plus key, slugified. */
export function proposedSecretName(server: string, key: string): string {
  return slugify(`${server}-${key}`) || slugify(server);
}

const STDIO_FIELDS = new Set(['command', 'args', 'env', 'type', 'description', 'disabled']);
const HTTP_FIELDS = new Set([
  'url',
  'serverUrl',
  'headers',
  'type',
  'description',
  'disabled',
  'oauth',
  'auth',
]);
const OAUTH_FIELDS = new Set([
  'clientId',
  'client_id',
  'clientSecret',
  'client_secret',
  'scopes',
  'scope',
  'enabled',
]);

interface OAuthRead {
  /** OAuth was asked for and is enabled. */
  oauth?: ImportOAuth & { clientSecretValue?: string };
  /** Fields of the block, ignored by name (`oauth.redirectUri`). */
  ignored: string[];
  notes: string[];
}

/**
 * The OAuth settings of an HTTP entry: `"oauth": { … }`, `"oauth": true`, `"auth": "oauth"`, or
 * `"auth": { "type": "oauth", … }`. A block's fields: `clientId`/`client_id`,
 * `clientSecret`/`client_secret`, `scopes`/`scope` (a list or a space-separated string),
 * `enabled`. With `"enabled": false` the block is dropped (and a plain secret with it).
 */
function readOAuth(raw: Record<string, unknown>): OAuthRead {
  const out: OAuthRead = { ignored: [], notes: [] };
  let block: Record<string, unknown> | undefined;
  let prefix = 'oauth';
  if (raw.oauth === true || raw.auth === 'oauth') block = {};
  if (isRecord(raw.oauth)) block = raw.oauth;
  else if (raw.oauth !== undefined && raw.oauth !== true && raw.oauth !== false) out.ignored.push('oauth');
  if (isRecord(raw.auth)) {
    if (typeof raw.auth.type === 'string' && raw.auth.type.toLowerCase() === 'oauth') {
      const { type: _type, ...rest } = raw.auth;
      block = { ...rest, ...(block ?? {}) };
      prefix = isRecord(raw.oauth) ? 'oauth' : 'auth';
    } else out.ignored.push('auth');
  } else if (raw.auth !== undefined && raw.auth !== 'oauth' && raw.auth !== 'none') out.ignored.push('auth');
  if (!block) return out;

  for (const key of Object.keys(block)) if (!OAUTH_FIELDS.has(key)) out.ignored.push(`${prefix}.${key}`);
  const text = (...keys: string[]) => {
    for (const key of keys) if (typeof block[key] === 'string' && block[key] !== '') return block[key];
    return undefined;
  };
  const clientId = text('clientId', 'client_id');
  const clientSecret = text('clientSecret', 'client_secret');
  const rawScopes = block.scopes ?? block.scope;
  const scopes = Array.isArray(rawScopes)
    ? splitScopes(rawScopes.filter((scope): scope is string => typeof scope === 'string'))
    : typeof rawScopes === 'string'
      ? splitScopes(rawScopes)
      : [];

  if (block.enabled === false) {
    const dropped = [
      clientId && 'clientId',
      clientSecret && 'clientSecret',
      scopes.length > 0 && 'scopes',
    ].filter(Boolean);
    out.notes.push(
      `OAuth is turned off in this entry ("enabled": false), so it was not set up${dropped.length > 0 ? `; dropped: ${dropped.join(', ')}` : ''}.`,
    );
    return out;
  }
  out.oauth = {
    ...(clientId !== undefined ? { clientId } : {}),
    scopes,
    ...(clientSecret !== undefined
      ? isSecretRef(clientSecret, 'env')
        ? { clientSecret: { kind: 'reference' as const, reference: clientSecret } }
        : { clientSecret: { kind: 'plain' as const }, clientSecretValue: clientSecret }
      : {}),
  };
  return out;
}
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamablehttp', 'streamable_http']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeEntry(value: unknown): boolean {
  return isRecord(value) && ('command' in value || 'url' in value || 'serverUrl' in value);
}

function stringMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`"${what}" must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`"${what}.${key}" must be a string`);
    out[key] = item;
  }
  return out;
}

function sensitiveOf(map: Record<string, string>, location: 'env' | 'header'): SensitiveValue[] {
  const found: SensitiveValue[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (!value || isSecretRef(value, location) || !looksSensitive(location, key)) continue;
    const { scheme } = location === 'header' ? splitScheme(value) : {};
    found.push(scheme ? { location, key, scheme } : { location, key });
  }
  return found;
}

function convert(key: string, name: string, raw: Record<string, unknown>): ImportCandidate {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  if (type === 'sse') {
    throw new Error(
      'uses the deprecated HTTP+SSE transport ("type": "sse"), which MCPier does not support. ' +
        "Use the server's Streamable HTTP endpoint instead, if it has one.",
    );
  }
  const common: Record<string, unknown> = {};
  if (typeof raw.description === 'string') common.description = raw.description;
  if (raw.disabled === true) common.enabled = false;

  if (typeof raw.command === 'string') {
    if (type !== undefined && type !== 'stdio') throw new Error(`has a command but "type": "${raw.type}"`);
    const args = raw.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('"args" must be a list of strings');
    }
    const env = stringMap(raw.env, 'env');
    const hasOAuth = raw.oauth !== undefined || raw.auth !== undefined;
    return {
      key,
      name,
      entry: { name, ...common, transport: 'stdio', command: raw.command, args, env },
      ignored: Object.keys(raw).filter((field) => !STDIO_FIELDS.has(field)),
      sensitive: sensitiveOf(env, 'env'),
      // OAuth is for remote servers; a stdio server's block is ignored.
      ...(hasOAuth
        ? { notes: ['OAuth settings are for remote servers; they were ignored for this stdio server.'] }
        : {}),
    };
  }

  const url =
    typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : undefined;
  if (url !== undefined) {
    if (type !== undefined && !HTTP_TYPES.has(type))
      throw new Error(`has a URL but an unknown "type": "${raw.type}"`);
    const headers = stringMap(raw.headers, 'headers');
    const auth = readOAuth(raw);
    const ignored = [...Object.keys(raw).filter((field) => !HTTP_FIELDS.has(field)), ...auth.ignored];
    if (typeof raw.url === 'string' && typeof raw.serverUrl === 'string') ignored.push('serverUrl');
    const entry: Record<string, unknown> = { name, ...common, transport: 'http', url, headers };
    let oauth: ImportOAuth | undefined;
    if (auth.oauth) {
      const { clientSecretValue, ...shown } = auth.oauth;
      oauth = shown;
      entry.auth = 'oauth';
      const settings = {
        ...(shown.clientId !== undefined ? { clientId: shown.clientId } : {}),
        // A plain secret stays here only until the import plan moves it into a secret.
        ...(shown.clientSecret?.kind === 'reference' ? { clientSecret: shown.clientSecret.reference } : {}),
        ...(clientSecretValue !== undefined ? { clientSecret: clientSecretValue } : {}),
        ...(shown.scopes.length > 0 ? { scopes: shown.scopes } : {}),
      };
      if (Object.keys(settings).length > 0) entry.oauth = settings;
    }
    return {
      key,
      name,
      entry,
      ignored,
      sensitive: sensitiveOf(headers, 'header'),
      ...(auth.notes.length > 0 ? { notes: auth.notes } : {}),
      ...(oauth ? { oauth } : {}),
    };
  }
  throw new Error('has neither a "command" (stdio server) nor a "url" (remote server)');
}

/**
 * Parses a pasted `mcpServers` block, the format server READMEs and other clients publish.
 * Accepts `{ "mcpServers": { … } }`, VS Code's `{ "servers": { … } }`, or a bare map of entries.
 * One bad entry never stops the others; each problem is reported against its key.
 */
export function parseImportBlock(source: unknown, existingNames: readonly string[] = []): ImportParseResult {
  let map: Record<string, unknown>;
  let shape: ImportParseResult['shape'];
  if (isRecord(source) && isRecord(source.mcpServers)) {
    map = source.mcpServers;
    shape = 'mcpServers';
  } else if (isRecord(source) && isRecord(source.servers)) {
    map = source.servers;
    shape = 'servers';
  } else if (isRecord(source) && Object.values(source).some(looksLikeEntry)) {
    map = source;
    shape = 'bare';
  } else {
    return {
      shape: 'bare',
      candidates: [],
      errors: [
        {
          key: '(top level)',
          message: 'Expected an object with "mcpServers" (or "servers"), or a map of server entries.',
        },
      ],
    };
  }

  const taken = new Set(existingNames);
  const candidates: ImportCandidate[] = [];
  const errors: ImportProblem[] = [];
  for (const [key, raw] of Object.entries(map)) {
    const name = slugify(key);
    const problem = name ? slugProblem(name) : 'is empty after conversion';
    if (problem) {
      errors.push({ key, message: `cannot be used as a server name ("${name}" ${problem}).` });
      continue;
    }
    if (taken.has(name)) {
      errors.push({
        key,
        message: existingNames.includes(name)
          ? `becomes the server name "${name}", which already exists.`
          : `becomes the server name "${name}", which another entry in this block already uses.`,
      });
      continue;
    }
    if (!isRecord(raw)) {
      errors.push({ key, message: 'is not an object.' });
      continue;
    }
    try {
      candidates.push(convert(key, name, raw));
      taken.add(name);
    } catch (error) {
      errors.push({ key, message: (error as Error).message });
    }
  }
  return { shape, candidates, errors };
}

/** A pasted plain client secret, to be stored under `secretName` before the entry is saved. */
export interface ClientSecretMove {
  server: string;
  secretName: string;
  /** Never printed, logged or sent back. */
  value: string;
}

export const KEEP_CLIENT_SECRET_MESSAGE =
  'has a plain client secret, and a client secret is always stored in Credential Manager (it cannot be kept as plain text). Import it without --keep-secrets.';

/**
 * Moves every plain OAuth client secret of a parsed block into a secret, in place: the entry
 * gets `secret:<name>` and the preview names it. The name is `<server>-client-secret`, or with
 * `-2`, `-3`… when that name is taken (an existing secret is never overwritten or read). With
 * `keepSecrets`, such an entry is an error and is left out; the others go on. The same for the
 * CLI and `POST /api/import`.
 */
export function planClientSecrets(
  parsed: ImportParseResult,
  existingSecretNames: readonly string[],
  options: { keepSecrets?: boolean } = {},
): { moves: ClientSecretMove[] } {
  const taken = new Set(existingSecretNames);
  const moves: ClientSecretMove[] = [];
  const kept: ImportCandidate[] = [];
  for (const candidate of parsed.candidates) {
    const settings = candidate.entry.oauth as Record<string, unknown> | undefined;
    if (candidate.oauth?.clientSecret?.kind !== 'plain' || typeof settings?.clientSecret !== 'string') {
      kept.push(candidate);
      continue;
    }
    if (options.keepSecrets) {
      parsed.errors.push({ key: candidate.key, message: KEEP_CLIENT_SECRET_MESSAGE });
      continue;
    }
    const base = proposedSecretName(candidate.name, 'client-secret');
    let secretName = base;
    for (let n = 2; taken.has(secretName); n++) {
      secretName = `${base.slice(0, SLUG_MAX_LENGTH - String(n).length - 1).replace(/-+$/, '')}-${n}`;
    }
    taken.add(secretName);
    moves.push({ server: candidate.name, secretName, value: settings.clientSecret });
    settings.clientSecret = `secret:${secretName}`;
    candidate.oauth.clientSecret = { kind: 'plain', movedTo: secretName };
    kept.push(candidate);
  }
  parsed.candidates = kept;
  return { moves };
}
