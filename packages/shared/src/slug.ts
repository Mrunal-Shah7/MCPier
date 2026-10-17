/** Maximum length of a server name or secret name. */
export const SLUG_MAX_LENGTH = 48;

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Checks a server or secret name against the slug rule: lowercase letters `a-z`, digits and
 * single hyphens between them, starting with a letter, at most 48 characters, and never a
 * double underscore (`__` separates server and tool names in `server__tool`).
 *
 * Returns a plain-words problem description, or `undefined` when the value is valid.
 */
export function slugProblem(value: string): string | undefined {
  if (value.length === 0) return 'must not be empty';
  if (value.includes('__')) {
    return 'must not contain "__" (a double underscore separates server and tool names)';
  }
  if (value.length > SLUG_MAX_LENGTH) return `must be at most ${SLUG_MAX_LENGTH} characters`;
  if (!SLUG_PATTERN.test(value)) {
    return 'must be a lowercase slug: letters a-z, digits and single hyphens between them, starting with a letter';
  }
  return undefined;
}

export function isSlug(value: string): boolean {
  return slugProblem(value) === undefined;
}
