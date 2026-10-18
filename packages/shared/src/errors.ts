// Readable error messages from the texts upstream servers and authorization servers send back
// (Sprint 7). A raw error is often a JSON-RPC or OAuth body wrapped in a prefix; people want the
// sentence inside it. The raw text stays available next to the clean one.

/** The clean form of an error text. */
export interface CleanError {
  message: string;
  /** A JSON-RPC or HTTP code found in the text. */
  code?: number;
}

/** JSON larger than this is never parsed (the original text is returned). */
export const CLEAN_ERROR_PARSE_LIMIT = 64 * 1024;

/** How many levels of JSON inside JSON are unwrapped. */
const MAX_DEPTH = 3;

/** Where the sentence is looked for, in this order. */
const MESSAGE_PATHS: readonly (readonly (string | number)[])[] = [
  ['error', 'message'],
  ['message'],
  ['error_description'],
  ['error'],
  ['detail'],
  ['title'],
  ['errors', 0, 'message'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[key];
    }
  }
  return current;
}

/**
 * The first complete JSON object or array in `text`: where it starts and ends. Brackets inside
 * strings are skipped. Undefined when there is none, or when it is cut off.
 */
function findJson(text: string): { start: number; end: number } | undefined {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index++;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return { start, end: index + 1 };
      }
    }
    // The first candidate never closed: the JSON was cut off. Later brackets would be inside it.
    return undefined;
  }
  return undefined;
}

/** Parses JSON without ever surfacing the parser's message (it can quote the text: Sprint 6 B-1). */
function parseQuietly(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.length > CLEAN_ERROR_PARSE_LIMIT) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function codeOf(value: unknown): number | undefined {
  for (const path of [['error', 'code'], ['code'], ['status'], ['statusCode']] as const) {
    const found = at(value, path);
    if (typeof found === 'number' && Number.isInteger(found)) return found;
  }
  return undefined;
}

function messageOf(value: unknown): string | undefined {
  for (const path of MESSAGE_PATHS) {
    const found = at(value, path);
    if (typeof found === 'string' && found.trim() !== '') return found.trim();
  }
  return undefined;
}

/** A code written in the prefix: `MCP error -32603:`, `HTTP 401`, `status 403`. */
function prefixCode(text: string): number | undefined {
  const match =
    /MCP error (-?\d{1,6})\b/.exec(text) ?? /\b(?:HTTP|status(?: code)?)\s*:?\s*([1-5]\d\d)\b/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * The readable sentence inside an error text, such as
 * `MCP error -32603: {"jsonrpc":"2.0","error":{"code":-32603,"message":"…"}}` or an OAuth body
 * `{"error":"invalid_token","error_description":"…"}`.
 *
 * - Finds the first JSON object or array in the text and parses it (at most 64 KB), then takes
 *   the first non-empty string of `error.message`, `message`, `error_description`, `error` (a
 *   string), `detail`, `title`, `errors[0].message`. In an array, the first element that has one.
 * - When that string is itself JSON or wrapped JSON, it repeats, at most 3 levels deep.
 * - A JSON-RPC or HTTP code it finds is returned as `code`.
 * - When nothing is found, or the JSON cannot be read (cut off, too large), the original text
 *   comes back trimmed. A parser message is never part of the answer.
 */
export function cleanErrorMessage(text: string): CleanError {
  const original = text.trim();
  let current = original;
  let code: number | undefined = prefixCode(original);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const found = findJson(current);
    if (!found) break;
    const parsed = parseQuietly(current.slice(found.start, found.end));
    if (!parsed.ok) break;
    const candidates = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    let message: string | undefined;
    for (const candidate of candidates) {
      message = messageOf(candidate);
      if (message !== undefined) {
        code = codeOf(candidate) ?? code;
        break;
      }
    }
    if (message === undefined) break;
    current = message;
    code ??= prefixCode(message);
  }
  return code === undefined ? { message: current } : { message: current, code };
}
