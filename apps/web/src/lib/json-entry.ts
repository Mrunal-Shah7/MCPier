// The JSON editor's checks (Sprint 7), in the browser with the shared schema (zod, jitless). A
// syntax error is reported by line and column only: the parser's own message can quote the
// text, which may hold a secret (Sprint 6 B-1).
import { looksSensitive, parseSecretRef, unknownEntryKeys, validateConfig } from '@mcpier/shared';

export interface JsonProblem {
  message: string;
  /** 1-based, when the problem could be placed. */
  line?: number;
}

export interface JsonAnalysis {
  /** Where the JSON stops being JSON. */
  syntax?: { line: number; column: number };
  problems: JsonProblem[];
  /** Keys MCPier does not use (kept as written). */
  warnings: string[];
  /** Plain env or header values that look like credentials. */
  credentials: { location: 'env' | 'header'; key: string }[];
  /** `oauth.clientSecret` holds a plain value (refused: it must be a reference). */
  plainClientSecret: boolean;
  entry?: Record<string, unknown>;
  valid: boolean;
}

/** 1-based line and column of an offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** Where `JSON.parse` failed: the position its message gives, else the end of the text. */
function syntaxPosition(text: string, error: unknown): number {
  const message = String((error as Error)?.message ?? '');
  const position = /position (\d+)/.exec(message);
  if (position) return Number(position[1]);
  const lineColumnMatch = /line (\d+) column (\d+)/.exec(message);
  if (lineColumnMatch) {
    const lines = text.split('\n');
    const line = Number(lineColumnMatch[1]);
    return (
      lines.slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0) +
      Number(lineColumnMatch[2]) -
      1
    );
  }
  return text.length;
}

/** The line of a problem path (`env.API_KEY`, `oauth.clientSecret`, `args[1]`), found by its keys. */
export function lineOfPath(text: string, path: string): number | undefined {
  const keys = path
    .split(/\.|\[|\]/)
    .filter((segment) => segment !== '' && !/^\d+$/.test(segment))
    .map((segment) => segment.replace(/^"|"$/g, ''));
  let offset = 0;
  let found: number | undefined;
  for (const key of keys) {
    const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'g');
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) break;
    offset = match.index + match[0].length;
    found = match.index;
  }
  return found === undefined ? undefined : lineColumn(text, found).line;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function analyzeEntryJson(text: string, name: string): JsonAnalysis {
  const empty: JsonAnalysis = {
    problems: [],
    warnings: [],
    credentials: [],
    plainClientSecret: false,
    valid: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const at = lineColumn(text, syntaxPosition(text, error));
    return {
      ...empty,
      syntax: at,
      problems: [{ message: `Not valid JSON at line ${at.line}, column ${at.column}.`, line: at.line }],
    };
  }
  if (!isRecord(parsed))
    return { ...empty, problems: [{ message: 'The entry must be a JSON object.', line: 1 }] };

  const problems: JsonProblem[] = [];
  if (parsed.name !== name) {
    problems.push({
      message: `name: must stay "${name}"; a server cannot be renamed here.`,
      line: lineOfPath(text, 'name') ?? 1,
    });
  }
  const result = validateConfig({ servers: [parsed] });
  if (!result.ok) {
    for (const problem of result.problems) {
      const relative = problem.replace(/^servers\[0\]\.?/, '');
      const path = relative.split(':')[0]!;
      problems.push({
        message: relative,
        ...(lineOfPath(text, path) !== undefined ? { line: lineOfPath(text, path)! } : {}),
      });
    }
  }

  const credentials: JsonAnalysis['credentials'] = [];
  for (const [location, field] of [
    ['env', 'env'],
    ['header', 'headers'],
  ] as const) {
    const map = parsed[field];
    if (!isRecord(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (
        typeof value === 'string' &&
        value &&
        parseSecretRef(value, location).kind === 'plain' &&
        looksSensitive(location, key)
      ) {
        credentials.push({ location, key });
      }
    }
  }
  const oauth = parsed.oauth;
  const plainClientSecret =
    isRecord(oauth) &&
    typeof oauth.clientSecret === 'string' &&
    parseSecretRef(oauth.clientSecret, 'env').kind === 'plain';

  return {
    problems,
    warnings: unknownEntryKeys(parsed),
    credentials,
    plainClientSecret,
    entry: parsed,
    valid: problems.length === 0,
  };
}
