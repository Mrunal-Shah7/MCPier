// Helpers for JSON people paste or edit.
/**
 * A JSON.parse error message without the slice of input some messages quote (`Unexpected
 * token 'g', "{"a": ghp_…"… is not valid JSON`): the input may hold secret values, and these
 * messages reach logs, responses and the terminal (Sprint 6 BUGS B-1).
 */
export function jsonErrorMessage(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  return message.replace(/,\s*(?:\.\.\.)?".*$/s, '').replace(/\s+is not valid JSON$/, '');
}
