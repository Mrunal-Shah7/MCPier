// The Add/Edit server form's data, kept separate from the components so it can be tested on
// its own: building a server entry, which values go to Credential Manager first, and
// restoring the plain values that an import preview hides.
import {
  looksSensitive,
  parseSecretRef,
  proposedSecretName,
  secretRefName,
  splitScheme,
  splitScopes,
  type ImportCandidate,
  type ProtocolMode,
  type ServerEntry,
} from '@mcpier/shared';

export type ValueMode = 'plain' | 'new-secret' | 'existing-secret';

/** The OAuth client secret: none (a public client), stored as a new secret, or an existing one. */
export type ClientSecretMode = 'none' | 'new-secret' | 'existing-secret';

export interface ValueRow {
  id: number;
  key: string;
  /** Plain value; for an existing secret on a header, the optional scheme (e.g. Bearer). */
  value: string;
  mode: ValueMode;
  /** Name for a new secret (editable; proposed per D-031). */
  secretName: string;
  /** Name of the existing secret this row refers to. */
  existingSecret: string;
  /** The user changed the mode, so it is no longer chosen automatically. */
  modeTouched: boolean;
}

export interface EntryForm {
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: ValueRow[];
  url: string;
  headers: ValueRow[];
  auth: 'none' | 'oauth';
  protocol: ProtocolMode;
  timeoutMs: string;
  startupTimeoutMs: string;
  enabled: boolean;
  /** OAuth client (Advanced): a client ID from the provider's console, its secret, extra scopes. */
  oauthClientId: string;
  oauthSecretMode: ClientSecretMode;
  /** A new client secret's value: stored as a secret before saving, never in config.json. */
  oauthSecretValue: string;
  oauthSecretName: string;
  oauthExistingSecret: string;
  /** Scopes, separated by spaces: when set, exactly these are requested. */
  oauthScopes: string;
  /** The logo override: an https URL, an absolute path to an image, or "none" (empty: found automatically). */
  icon: string;
}

let rowId = 1;

export function newRow(partial: Partial<ValueRow> = {}): ValueRow {
  return {
    id: rowId++,
    key: '',
    value: '',
    mode: 'plain',
    secretName: '',
    existingSecret: '',
    modeTouched: false,
    ...partial,
  };
}

export function emptyForm(): EntryForm {
  return {
    name: '',
    description: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: [],
    url: '',
    headers: [],
    auth: 'none',
    protocol: 'auto',
    timeoutMs: '',
    startupTimeoutMs: '',
    enabled: true,
    oauthClientId: '',
    oauthSecretMode: 'none',
    oauthSecretValue: '',
    oauthSecretName: '',
    oauthExistingSecret: '',
    oauthScopes: '',
    icon: '',
  };
}

/** The proposed name for a new OAuth client secret. */
export function proposedClientSecretName(serverName: string): string {
  return proposedSecretName(serverName || 'oauth', 'client-secret');
}

/** After the key or server name changed: credential-looking keys default to a new secret. */
export function refreshRow(row: ValueRow, location: 'env' | 'header', serverName: string): ValueRow {
  const sensitive = row.key.length > 0 && looksSensitive(location, row.key);
  const mode: ValueMode = row.modeTouched ? row.mode : sensitive ? 'new-secret' : 'plain';
  const proposed = row.key && serverName ? proposedSecretName(serverName, row.key) : '';
  return { ...row, mode, secretName: row.modeTouched && row.secretName ? row.secretName : proposed };
}

export interface SecretToStore {
  name: string;
  value: string;
}

export interface BuiltEntry {
  entry: Record<string, unknown>;
  /** Stored through the secrets API before the entry is saved. Empty in test mode. */
  secrets: SecretToStore[];
}

function buildMap(
  rows: ValueRow[],
  location: 'env' | 'header',
  purpose: 'save' | 'test',
): { map: Record<string, string>; secrets: SecretToStore[] } {
  const map: Record<string, string> = {};
  const secrets: SecretToStore[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.mode === 'existing-secret') {
      const scheme = location === 'header' ? row.value.trim() : '';
      map[key] = `${scheme ? `${scheme} ` : ''}secret:${row.existingSecret}`;
    } else if (row.mode === 'new-secret') {
      if (purpose === 'test') {
        // A connection test uses the value as typed; the gateway hides it in the result.
        map[key] = row.value;
        continue;
      }
      const { scheme, token } =
        location === 'header' ? splitScheme(row.value) : { scheme: undefined, token: row.value };
      map[key] = `${scheme ? `${scheme} ` : ''}secret:${row.secretName}`;
      secrets.push({ name: row.secretName, value: token });
    } else {
      map[key] = row.value;
    }
  }
  return { map, secrets };
}

/**
 * The entry as config.json holds it. For `save`, values marked "store as secret" become
 * references and are returned separately; for `test`, they are used as typed.
 */
export function buildEntry(form: EntryForm, purpose: 'save' | 'test'): BuiltEntry {
  const entry: Record<string, unknown> = { name: form.name.trim(), transport: form.transport };
  if (form.description.trim()) entry.description = form.description.trim();
  if (form.icon.trim()) entry.icon = form.icon.trim();
  let secrets: SecretToStore[];
  if (form.transport === 'stdio') {
    entry.command = form.command.trim();
    entry.args = form.args.filter((arg) => arg.length > 0);
    const env = buildMap(form.env, 'env', purpose);
    entry.env = env.map;
    secrets = env.secrets;
  } else {
    entry.url = form.url.trim();
    const headers = buildMap(form.headers, 'header', purpose);
    entry.headers = headers.map;
    secrets = headers.secrets;
    if (form.auth === 'oauth') {
      entry.auth = 'oauth';
      const oauth = buildOAuth(form, purpose);
      if (oauth.client) entry.oauth = oauth.client;
      secrets = [...secrets, ...oauth.secrets];
    }
  }
  entry.protocol = form.protocol;
  if (form.timeoutMs.trim()) entry.timeoutMs = Number(form.timeoutMs);
  if (form.startupTimeoutMs.trim()) entry.startupTimeoutMs = Number(form.startupTimeoutMs);
  entry.enabled = form.enabled;
  return { entry, secrets };
}

/**
 * The `oauth` block: a client ID, its secret as a reference (a new value is stored as a
 * secret first, for `save`; a connection test only runs discovery, so it is left out), and
 * extra scopes. Undefined when nothing is set.
 */
function buildOAuth(
  form: EntryForm,
  purpose: 'save' | 'test',
): { client?: Record<string, unknown>; secrets: SecretToStore[] } {
  const client: Record<string, unknown> = {};
  const secrets: SecretToStore[] = [];
  const clientId = form.oauthClientId.trim();
  if (clientId) {
    client.clientId = clientId;
    if (form.oauthSecretMode === 'existing-secret' && form.oauthExistingSecret) {
      client.clientSecret = `secret:${form.oauthExistingSecret}`;
    } else if (form.oauthSecretMode === 'new-secret' && purpose === 'save') {
      client.clientSecret = `secret:${form.oauthSecretName.trim()}`;
      secrets.push({ name: form.oauthSecretName.trim(), value: form.oauthSecretValue });
    }
  }
  const scopes = splitScopes(form.oauthScopes);
  if (scopes.length > 0) client.scopes = scopes;
  return { ...(Object.keys(client).length > 0 ? { client } : {}), secrets };
}

/** Problems with the OAuth client fields a person can fix. */
export function oauthProblems(form: EntryForm): string[] {
  if (form.transport !== 'http' || form.auth !== 'oauth' || form.oauthSecretMode === 'none') return [];
  const problems: string[] = [];
  if (!form.oauthClientId.trim())
    problems.push('OAuth client: enter the client ID the client secret belongs to.');
  if (form.oauthSecretMode === 'new-secret') {
    if (!form.oauthSecretValue) problems.push('OAuth client: enter the client secret to store as a secret.');
    if (!form.oauthSecretName.trim()) problems.push('OAuth client: give the client secret a secret name.');
  }
  if (form.oauthSecretMode === 'existing-secret' && !form.oauthExistingSecret) {
    problems.push('OAuth client: choose the secret that holds the client secret.');
  }
  return problems;
}

/** Problems a person can fix in the rows themselves (missing names or values). */
export function rowProblems(form: EntryForm): string[] {
  const rows = form.transport === 'stdio' ? form.env : form.headers;
  const label = form.transport === 'stdio' ? 'Environment variable' : 'Header';
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      if (row.value) problems.push(`${label} with a value but no name.`);
      continue;
    }
    if (seen.has(key)) problems.push(`${label} "${key}" appears twice.`);
    seen.add(key);
    if (row.mode === 'new-secret' && !row.value)
      problems.push(`${label} "${key}": enter the value to store as a secret.`);
    if (row.mode === 'existing-secret' && !row.existingSecret)
      problems.push(`${label} "${key}": choose a secret.`);
  }
  return problems;
}

/** A form filled from a stored entry (Edit). References stay references. */
export function formFromEntry(entry: ServerEntry): EntryForm {
  const rows = (map: Record<string, string>, location: 'env' | 'header') =>
    Object.entries(map).map(([key, value]) => {
      const parsed = parseSecretRef(value, location);
      return parsed.kind === 'secret'
        ? newRow({
            key,
            value: parsed.prefix.trim(),
            mode: 'existing-secret',
            existingSecret: parsed.name,
            modeTouched: true,
          })
        : newRow({
            key,
            value,
            mode: 'plain',
            secretName: proposedSecretName(entry.name, key),
            modeTouched: true,
          });
    });
  const base = emptyForm();
  return {
    ...base,
    name: entry.name,
    description: entry.description ?? '',
    icon: entry.icon ?? '',
    transport: entry.transport,
    ...(entry.transport === 'stdio'
      ? { command: entry.command, args: [...entry.args], env: rows(entry.env, 'env') }
      : {
          url: entry.url,
          headers: rows(entry.headers, 'header'),
          auth: entry.auth === 'oauth' ? 'oauth' : 'none',
          oauthClientId: entry.oauth?.clientId ?? '',
          oauthSecretMode: entry.oauth?.clientSecret ? 'existing-secret' : 'none',
          oauthExistingSecret: entry.oauth?.clientSecret
            ? (secretRefName(entry.oauth.clientSecret) ?? '')
            : '',
          oauthSecretName: proposedClientSecretName(entry.name),
          oauthScopes: (entry.oauth?.scopes ?? []).join(' '),
        }),
    protocol: entry.protocol,
    timeoutMs: String(entry.timeoutMs),
    startupTimeoutMs: String(entry.startupTimeoutMs),
    enabled: entry.enabled,
  };
}

// ---- Paste JSON

/** The pasted block's entry for a preview candidate (the preview hides credential values). */
function sourceEntry(pasted: unknown, shape: string, key: string): Record<string, unknown> | undefined {
  if (!pasted || typeof pasted !== 'object') return undefined;
  const record = pasted as Record<string, unknown>;
  const container = (
    shape === 'mcpServers' ? record.mcpServers : shape === 'servers' ? record.servers : record
  ) as Record<string, unknown> | undefined;
  const entry = container?.[key];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

export interface PastedChoice {
  /** `${candidateKey}\u0000${location}\u0000${key}` → store as this secret name (absent: keep plain). */
  secretNames: Map<string, string>;
}

export const choiceKey = (candidate: string, location: 'env' | 'header', key: string) =>
  `${candidate}\u0000${location}\u0000${key}`;

/**
 * Turns a preview candidate back into a full entry, using the pasted text for the values the
 * preview hid. Values chosen for Credential Manager become references (`save`) or stay as
 * typed (`test`).
 */
export function entryFromCandidate(
  candidate: ImportCandidate,
  pasted: unknown,
  shape: string,
  choice: PastedChoice,
  purpose: 'save' | 'test',
): BuiltEntry {
  const source = sourceEntry(pasted, shape, candidate.key);
  const entry = structuredClone(candidate.entry);
  const secrets: SecretToStore[] = [];
  for (const sensitive of candidate.sensitive) {
    const field = sensitive.location === 'env' ? 'env' : 'headers';
    const original = (source?.[field] as Record<string, unknown> | undefined)?.[sensitive.key];
    const map = { ...((entry[field] ?? {}) as Record<string, string>) };
    entry[field] = map;
    if (typeof original !== 'string') continue;
    const secretName = choice.secretNames.get(choiceKey(candidate.key, sensitive.location, sensitive.key));
    if (!secretName || purpose === 'test') {
      map[sensitive.key] = original;
      continue;
    }
    const { scheme, token } =
      sensitive.location === 'header' ? splitScheme(original) : { scheme: undefined, token: original };
    map[sensitive.key] = `${scheme ? `${scheme} ` : ''}secret:${secretName}`;
    secrets.push({ name: secretName, value: token });
  }
  // A plain OAuth client secret: the preview named its secret (D-031); store the pasted value
  // under that name before saving. A connection test runs discovery only and needs no secret.
  const planned = candidate.oauth?.clientSecret;
  if (planned?.kind === 'plain' && planned.movedTo && purpose === 'save') {
    const block = [source?.oauth, source?.auth].find(
      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    );
    const value = block?.clientSecret ?? block?.client_secret;
    if (typeof value === 'string' && value) secrets.push({ name: planned.movedTo, value });
  }
  return { entry, secrets };
}
