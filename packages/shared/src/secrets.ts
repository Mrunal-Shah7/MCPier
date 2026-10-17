import { slugProblem } from './slug.js';

/** Prefix that marks an `env` or `headers` value as a reference to a stored secret. */
export const SECRET_REF_PREFIX = 'secret:';

/**
 * Where a value appears. `env` values are either plain or a whole `secret:<name>` reference.
 * `header` values may also put one scheme word before the reference, as in
 * `Bearer secret:<name>`, so the scheme stays visible in config while the token is stored.
 */
export type SecretRefContext = 'env' | 'header';

/** Longest value Windows Credential Manager accepts: 2,560 bytes of UTF-16. */
export const SECRET_VALUE_MAX_LENGTH = 1280;

const HEADER_SCHEME_REF = /^(\S+) secret:(.*)$/s;

export type ParsedSecretRef =
  | { kind: 'plain' }
  /** `prefix` is the text before `secret:` (empty, or a scheme word plus one space). */
  | { kind: 'secret'; name: string; prefix: string }
  | { kind: 'malformed'; name: string; problem: string };

/**
 * Classifies an `env` or `headers` value: a plain string, a well-formed secret reference
 * (with its name extracted), or a malformed reference whose name breaks the slug rule.
 */
export function parseSecretRef(value: string, context: SecretRefContext = 'env'): ParsedSecretRef {
  let prefix: string;
  let name: string;
  if (value.startsWith(SECRET_REF_PREFIX)) {
    prefix = '';
    name = value.slice(SECRET_REF_PREFIX.length);
  } else {
    const scheme = context === 'header' ? HEADER_SCHEME_REF.exec(value) : null;
    if (!scheme) return { kind: 'plain' };
    prefix = `${scheme[1]} `;
    name = scheme[2] ?? '';
  }
  const problem = slugProblem(name);
  return problem === undefined ? { kind: 'secret', name, prefix } : { kind: 'malformed', name, problem };
}

/** True when the value is written as a secret reference, valid or not. */
export function isSecretRef(value: string, context: SecretRefContext = 'env'): boolean {
  return parseSecretRef(value, context).kind !== 'plain';
}

/** The secret name of a well-formed reference, or `undefined` for anything else. */
export function secretRefName(value: string, context: SecretRefContext = 'env'): string | undefined {
  const parsed = parseSecretRef(value, context);
  return parsed.kind === 'secret' ? parsed.name : undefined;
}

/** `secret:<name>`, or `<scheme> secret:<name>` when a scheme word is given (headers only). */
export function makeSecretRef(name: string, scheme?: string): string {
  return scheme ? `${scheme} ${SECRET_REF_PREFIX}${name}` : `${SECRET_REF_PREFIX}${name}`;
}

/** Every secret name a server entry references, in `env`, `headers` and the OAuth client secret. */
export function referencedSecretNames(entry: {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: { clientSecret?: string };
}): string[] {
  const names = new Set<string>();
  for (const value of Object.values(entry.env ?? {})) {
    const name = secretRefName(value, 'env');
    if (name) names.add(name);
  }
  for (const value of Object.values(entry.headers ?? {})) {
    const name = secretRefName(value, 'header');
    if (name) names.add(name);
  }
  const clientSecret = entry.oauth?.clientSecret;
  if (clientSecret !== undefined) {
    const name = secretRefName(clientSecret, 'env');
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * Checks a secret value before it is stored. Shared by every secret store, so the real store
 * and the test fake reject exactly the same values. Never includes the value in the message.
 */
export function secretValueProblem(value: string): string | undefined {
  if (value.length === 0) return 'The secret value must not be empty.';
  if (value.length > SECRET_VALUE_MAX_LENGTH) {
    return `The secret value is ${value.length} characters long; Windows Credential Manager stores at most ${SECRET_VALUE_MAX_LENGTH}.`;
  }
  return undefined;
}

/** Last four characters for display, only when the value is long enough not to give it away. */
export function secretHint(value: string): string | undefined {
  return value.length >= 8 ? value.slice(-4) : undefined;
}
