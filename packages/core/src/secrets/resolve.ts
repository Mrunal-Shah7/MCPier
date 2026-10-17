import { parseSecretRef, type SecretRefContext, type ServerEntry } from '@mcpier/shared';
import type { SecretStore } from '../platform/index.js';

/** A referenced secret is not in the store. Names only, never values. */
export class MissingSecretError extends Error {
  constructor(readonly names: readonly string[]) {
    const list = names.map((name) => `"${name}"`).join(', ');
    const how = names.map((name) => `mcpier secret set ${name}`).join(', then ');
    super(
      `${names.length === 1 ? 'Secret' : 'Secrets'} ${list} ${names.length === 1 ? 'is' : 'are'} not set. Set ${names.length === 1 ? 'it' : 'them'} with: ${how}`,
    );
    this.name = 'MissingSecretError';
  }
}

export interface ResolvedSecrets {
  /** `env` with every reference replaced by its value (stdio servers). */
  env: Record<string, string>;
  /** `headers` with every reference replaced by its value (HTTP servers). */
  headers: Record<string, string>;
  /** Secret name → value, for redacting these values from logs and results. */
  values: Map<string, string>;
}

async function resolveMap(
  map: Record<string, string>,
  context: SecretRefContext,
  store: SecretStore,
  values: Map<string, string>,
  missing: Set<string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(map)) {
    const parsed = parseSecretRef(raw, context);
    if (parsed.kind !== 'secret') {
      // Plain values pass through unchanged (malformed ones never pass config validation).
      out[key] = raw;
      continue;
    }
    let value = values.get(parsed.name);
    if (value === undefined && !missing.has(parsed.name)) {
      value = await store.get(parsed.name);
      if (value === undefined) missing.add(parsed.name);
      else values.set(parsed.name, value);
    }
    if (value !== undefined) out[key] = parsed.prefix + value;
  }
  return out;
}

/**
 * Turns a server entry's `env` and `headers` into real values just before connecting.
 * Throws `MissingSecretError` naming every missing secret. The result lives only in memory,
 * for as long as the connection needs it.
 */
export async function resolveServerSecrets(entry: ServerEntry, store: SecretStore): Promise<ResolvedSecrets> {
  const values = new Map<string, string>();
  const missing = new Set<string>();
  const env = entry.transport === 'stdio' ? await resolveMap(entry.env, 'env', store, values, missing) : {};
  const headers =
    entry.transport === 'http' ? await resolveMap(entry.headers, 'header', store, values, missing) : {};
  if (missing.size > 0) throw new MissingSecretError([...missing].sort());
  return { env, headers, values };
}
