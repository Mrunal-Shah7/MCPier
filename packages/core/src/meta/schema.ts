/** An input schema larger than this (serialized) is outlined in search results. */
export const SCHEMA_OUTLINE_THRESHOLD_BYTES = 16 * 1024;

/** Schemas nested deeper than this are not compiled for validation. */
export const MAX_SCHEMA_DEPTH = 32;

export function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** Nesting depth of a JSON value (objects and arrays count one level each). */
export function jsonDepth(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let deepest = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (current === null || typeof current !== 'object') continue;
    const level = depth + 1;
    if (level > deepest) deepest = level;
    if (deepest > limit) return deepest;
    for (const child of Object.values(current as Record<string, unknown>))
      stack.push({ value: child, depth: level });
  }
  return deepest;
}

function typeOf(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const record = schema as Record<string, unknown>;
  if (typeof record.type === 'string') return record.type;
  if (Array.isArray(record.type)) return record.type.join(' | ');
  if (record.$ref) return 'reference';
  if (record.oneOf || record.anyOf) return 'one of several shapes';
  if (record.enum) return 'enum';
  return 'any';
}

/**
 * A short outline of a large input schema: top-level property names, their types, and
 * which are required, with a note that `call_tool`'s validation error returns the full schema.
 */
export function outlineSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [name, { type: typeOf(child) }]),
    ),
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
    description:
      `Outline only: the full input schema is ${Math.round(serializedSize(schema) / 1024)} KB. ` +
      'Call call_tool; if the arguments are wrong, its error result includes the full schema.',
  };
}

/** The schema to show in a search result: as is, or outlined when it is too large. */
export function schemaForSearch(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  outlined: boolean;
} {
  return serializedSize(schema) > SCHEMA_OUTLINE_THRESHOLD_BYTES
    ? { schema: outlineSchema(schema), outlined: true }
    : { schema, outlined: false };
}
