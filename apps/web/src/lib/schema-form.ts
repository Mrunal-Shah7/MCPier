// The Tester's form model: a tool's input schema read into fields MCPier's own renderer can
// draw. Nothing here compiles a schema (no Ajv, no `new Function`): it only reads keywords.
// Validation happens on the gateway through the validate route (D-067). Anything the renderer
// does not draw (oneOf, anyOf, allOf, a $ref that is not local, conditionals, arrays of
// objects, …) becomes a JSON editor for that one field.

type Json = unknown;

export type PrimitiveField =
  | {
      kind: 'string';
      enum?: string[];
      /** A `format` hint (date, date-time, email, uri, …), shown and used for the input type. */
      format?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | { kind: 'number' | 'integer'; minimum?: number; maximum?: number; enum?: number[] }
  | { kind: 'boolean' };

export type Field = (
  | PrimitiveField
  | { kind: 'array'; items: PrimitiveField; minItems?: number; maxItems?: number }
  | { kind: 'object'; properties: ObjectProperty[] }
  | { kind: 'json'; reason: string }
) & {
  title?: string;
  description?: string;
  /** The schema's `default`, shown as a hint (never filled in by itself). */
  defaultValue?: Json;
};

export interface ObjectProperty {
  name: string;
  required: boolean;
  field: Field;
}

/** How deep nested objects are drawn before the rest falls back to JSON. */
const MAX_FORM_DEPTH = 6;

const UNSUPPORTED = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'patternProperties',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `#/$defs/name` or `#/definitions/name` inside the same schema; anything else is not followed. */
function resolveLocal(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return undefined;
  const defs = root[match[1]!];
  const name = decodeURIComponent(match[2]!.replace(/~1/g, '/').replace(/~0/g, '~'));
  return isObject(defs) && isObject(defs[name]) ? (defs[name] as Record<string, unknown>) : undefined;
}

function common(schema: Record<string, unknown>): Pick<Field, 'title' | 'description' | 'defaultValue'> {
  return {
    ...(typeof schema.title === 'string' ? { title: schema.title } : {}),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    ...('default' in schema ? { defaultValue: schema.default } : {}),
  };
}

/** The single type a schema names; `["string", "null"]` counts as string. */
function typeOf(schema: Record<string, unknown>): string | undefined {
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const real = type.filter((entry) => entry !== 'null');
    return real.length === 1 && typeof real[0] === 'string' ? real[0] : undefined;
  }
  if (isObject(schema.properties)) return 'object';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every((value) => typeof value === 'string')) return 'string';
    if (schema.enum.every((value) => typeof value === 'number')) return 'number';
  }
  return undefined;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function primitive(schema: Record<string, unknown>, type: string): PrimitiveField | undefined {
  if (type === 'string') {
    const values = Array.isArray(schema.enum) ? schema.enum : undefined;
    if (values && !values.every((value) => typeof value === 'string')) return undefined;
    if ('const' in schema && typeof schema.const !== 'string') return undefined;
    const enumValues = values ?? (typeof schema.const === 'string' ? [schema.const] : undefined);
    return {
      kind: 'string',
      ...(enumValues ? { enum: enumValues as string[] } : {}),
      ...(typeof schema.format === 'string' ? { format: schema.format } : {}),
      ...(num(schema.minLength) !== undefined ? { minLength: num(schema.minLength) } : {}),
      ...(num(schema.maxLength) !== undefined ? { maxLength: num(schema.maxLength) } : {}),
      ...(typeof schema.pattern === 'string' ? { pattern: schema.pattern } : {}),
    };
  }
  if (type === 'number' || type === 'integer') {
    const values = Array.isArray(schema.enum) ? schema.enum : undefined;
    if (values && !values.every((value) => typeof value === 'number')) return undefined;
    return {
      kind: type,
      ...(num(schema.minimum) !== undefined ? { minimum: num(schema.minimum) } : {}),
      ...(num(schema.maximum) !== undefined ? { maximum: num(schema.maximum) } : {}),
      ...(values ? { enum: values as number[] } : {}),
    };
  }
  if (type === 'boolean') return { kind: 'boolean' };
  return undefined;
}

/**
 * Reads one schema into a field. `root` is the whole input schema (for local `$ref`s), `seen`
 * the references being followed (a cycle becomes JSON).
 */
export function readField(
  schema: unknown,
  root: Record<string, unknown>,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): Field {
  if (schema === true || (isObject(schema) && Object.keys(schema).length === 0)) {
    return { kind: 'json', reason: 'any JSON value' };
  }
  if (!isObject(schema)) return { kind: 'json', reason: 'the schema is not an object' };

  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (seen.has(ref)) return { ...common(schema), kind: 'json', reason: 'a recursive reference' };
    const target = resolveLocal(root, ref);
    if (!target)
      return { ...common(schema), kind: 'json', reason: `a reference the form cannot follow (${ref})` };
    const { $ref: _ref, ...rest } = schema;
    const field = readField({ ...target, ...rest }, root, depth, new Set([...seen, ref]));
    return field;
  }
  const unsupported = UNSUPPORTED.find((keyword) => keyword in schema);
  if (unsupported) return { ...common(schema), kind: 'json', reason: `uses ${unsupported}` };

  const type = typeOf(schema);
  if (!type) return { ...common(schema), kind: 'json', reason: 'no single type' };

  const simple = primitive(schema, type);
  if (simple) return { ...common(schema), ...simple };

  if (type === 'array') {
    const items = schema.items;
    if (!isObject(items))
      return { ...common(schema), kind: 'json', reason: 'an array without one item schema' };
    const item = readField(items, root, depth + 1, seen);
    if (item.kind === 'array' || item.kind === 'object' || item.kind === 'json') {
      return { ...common(schema), kind: 'json', reason: 'an array of objects or arrays' };
    }
    const { title: _t, description: _d, defaultValue: _v, ...itemField } = item;
    return {
      ...common(schema),
      kind: 'array',
      items: itemField as PrimitiveField,
      ...(num(schema.minItems) !== undefined ? { minItems: num(schema.minItems) } : {}),
      ...(num(schema.maxItems) !== undefined ? { maxItems: num(schema.maxItems) } : {}),
    };
  }

  if (type === 'object') {
    if (depth >= MAX_FORM_DEPTH)
      return { ...common(schema), kind: 'json', reason: 'nested too deeply for the form' };
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Object.keys(properties).length === 0 && schema.additionalProperties !== false) {
      return { ...common(schema), kind: 'json', reason: 'an object with free-form keys' };
    }
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : [],
    );
    return {
      ...common(schema),
      kind: 'object',
      properties: Object.entries(properties).map(([name, child]) => ({
        name,
        required: required.has(name),
        field: readField(child, root, depth + 1, seen),
      })),
    };
  }
  return { ...common(schema), kind: 'json', reason: `the type ${type}` };
}

/** The whole input schema as a form: always an object at the top (tools take an object). */
export function readInputSchema(schema: Record<string, unknown>): Field {
  const field = readField(schema, schema);
  if (field.kind === 'object' || field.kind === 'json') return field;
  return { kind: 'json', reason: 'the input is not an object' };
}

/** A path as the validate route returns it, as one key: `address.zip`, `items.2`. */
export function pathKey(path: readonly (string | number)[]): string {
  return path.map(String).join('\u0000');
}

/** Whether a problem at `problem` belongs to the field at `field` (the field itself or inside it). */
export function isWithin(
  problem: readonly (string | number)[],
  field: readonly (string | number)[],
): boolean {
  return (
    field.length <= problem.length && field.every((part, index) => String(problem[index]) === String(part))
  );
}

/** Input types for string formats a browser has a control for. */
export function inputTypeFor(format: string | undefined): string {
  switch (format) {
    case 'email':
      return 'email';
    case 'uri':
    case 'url':
      return 'url';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    default:
      return 'text';
  }
}

/** Elicitation forms (SPEC 5.3): a flat object of primitive fields, or nothing the Tester can draw. */
export function readElicitationSchema(
  schema: unknown,
): { properties: { name: string; required: boolean; field: Field & PrimitiveField }[] } | undefined {
  if (!isObject(schema)) return undefined;
  const field = readField(schema, schema);
  if (field.kind !== 'object') return undefined;
  if (
    !field.properties.every((property) =>
      ['string', 'number', 'integer', 'boolean'].includes(property.field.kind),
    )
  ) {
    return undefined;
  }
  return {
    properties: field.properties as { name: string; required: boolean; field: Field & PrimitiveField }[],
  };
}
