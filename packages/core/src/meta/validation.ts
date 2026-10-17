import { createHash } from 'node:crypto';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { Logger } from '../logger.js';
import { jsonDepth, MAX_SCHEMA_DEPTH } from './schema.js';

/** One problem with its place in the arguments, for a form to show next to its field. */
export interface ValidationIssue {
  /** Property names and array indexes from the arguments object down to the field. */
  path: (string | number)[];
  /** The readable form of `path`: `arguments.address.zip`, `arguments.items[2]`. */
  location: string;
  /** What is wrong, without the location. */
  message: string;
}

export type ValidationResult =
  { ok: true; skipped?: string } | { ok: false; problems: string[]; issues: ValidationIssue[] };

/** `/address/zip` → `['address', 'zip']`; array indexes as numbers. */
function pathOf(instancePath: string): (string | number)[] {
  if (!instancePath) return [];
  return instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** `['address', 'zip']` → `arguments.address.zip`; array indexes as `[n]`. */
function location(path: (string | number)[]): string {
  return (
    'arguments' +
    path
      .map((part) =>
        typeof part === 'number'
          ? `[${part}]`
          : /^[A-Za-z_$][\w$]*$/.test(part)
            ? `.${part}`
            : `[${JSON.stringify(part)}]`,
      )
      .join('')
  );
}

/** The problem as `call_tool` reports it to a model: `<location>: <message>`. */
function describe(error: ErrorObject): string {
  const where = location(pathOf(error.instancePath));
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'additionalProperties') {
    return `${where}: has an unexpected property "${String(params.additionalProperty)}"`;
  }
  if (error.keyword === 'enum') {
    return `${where}: must be one of ${(params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(', ')}`;
  }
  return `${where}: ${error.message ?? error.keyword}`;
}

/**
 * The same problem placed for a form: a missing or unexpected property is reported on that
 * property itself, not on the object that holds it.
 */
function issue(error: ErrorObject): ValidationIssue {
  const params = error.params as Record<string, unknown>;
  const base = pathOf(error.instancePath);
  let path = base;
  let message: string;
  if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
    path = [...base, params.missingProperty];
    message = 'is required';
  } else if (error.keyword === 'additionalProperties') {
    path = [...base, String(params.additionalProperty)];
    message = 'is not an allowed property';
  } else if (error.keyword === 'enum') {
    message = `must be one of ${(params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(', ')}`;
  } else {
    message = error.message ?? error.keyword;
  }
  return { path, location: location(path), message };
}

/**
 * Validates `call_tool` arguments against each tool's input schema with Ajv's JSON Schema
 * 2020-12 build: every error is reported, and remote references are never loaded (there is
 * no `loadSchema`, so an unresolvable `$ref` makes compilation fail).
 *
 * Compiled validators are cached per tool and keyed by a hash of the schema, so a changed
 * schema is recompiled. A schema that cannot be compiled (or is deeper than
 * `MAX_SCHEMA_DEPTH`) does not block calls: validation is skipped for it, with one warning.
 */
export class ArgumentValidator {
  private readonly cache = new Map<
    string,
    { hash: string; validate: ValidateFunction | undefined; reason?: string }
  >();

  constructor(private readonly logger?: Logger) {}

  private compile(
    tool: string,
    schema: Record<string, unknown>,
  ): { validate?: ValidateFunction; reason?: string } {
    if (jsonDepth(schema, MAX_SCHEMA_DEPTH) > MAX_SCHEMA_DEPTH) {
      return { reason: `the schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels` };
    }
    // Many servers label their schema draft-07; the 2020-12 build refuses that meta-schema
    // id, and the keywords such schemas use mean the same here. `$id` is dropped so two tools
    // with the same id never clash.
    const { $schema: _schema, $id: _id, ...body } = schema;
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
      return { validate: ajv.compile(body) };
    } catch (error) {
      return { reason: (error as Error).message };
    }
  }

  validate(tool: string, schema: Record<string, unknown>, args: unknown): ValidationResult {
    const hash = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    let entry = this.cache.get(tool);
    if (!entry || entry.hash !== hash) {
      const compiled = this.compile(tool, schema);
      entry = { hash, validate: compiled.validate, reason: compiled.reason };
      this.cache.set(tool, entry);
      if (!compiled.validate) {
        this.logger?.warn(
          { tool, reason: compiled.reason },
          'Input schema cannot be compiled; arguments are not validated',
        );
      }
    }
    if (!entry.validate) return { ok: true, skipped: entry.reason };
    if (entry.validate(args)) return { ok: true };
    const errors = entry.validate.errors ?? [];
    return { ok: false, problems: errors.map(describe), issues: errors.map(issue) };
  }

  /** Drops cached validators of tools that no longer exist. */
  retain(tools: Iterable<string>): void {
    const keep = new Set(tools);
    for (const name of this.cache.keys()) if (!keep.has(name)) this.cache.delete(name);
  }
}
