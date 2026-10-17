/**
 * Secret values shorter than this are not redacted: replacing every occurrence of a one- or
 * two-character string would wreck ordinary text. Such secrets are refused nowhere, but they
 * are also not protected by redaction. (Credential Manager values are normally long tokens.)
 */
export const REDACT_MIN_LENGTH = 4;

export type Redactor = (text: string) => string;

/** Replaces each known secret value with `[secret:<name>]`. */
export function createRedactor(values: ReadonlyMap<string, string>): Redactor {
  // Longest first, so a secret that contains another is replaced whole.
  const pairs = [...values.entries()]
    .filter(([, value]) => value.length >= REDACT_MIN_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  if (pairs.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of pairs) {
      if (out.includes(value)) out = out.split(value).join(`[secret:${name}]`);
    }
    return out;
  };
}

/** Applies a redactor to every string inside a JSON-like value (objects and arrays copied). */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, redact);
    return out as T;
  }
  return value;
}
