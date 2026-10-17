// MCPier's own form renderer for tool input (and elicitation) schemas. It draws strings,
// numbers, integers, booleans, arrays of those and nested objects; anything else is a JSON
// editor for that field. It never validates: the gateway does (the validate route).
import { useEffect, useId, useState } from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { ArgumentProblem } from '@mcpier/shared';
import { inputTypeFor, isWithin, pathKey, type Field, type PrimitiveField } from '@/lib/schema-form';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

type Path = (string | number)[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every path the form shows problems at: leaves, arrays, JSON editors and objects themselves. */
function placedPaths(field: Field, path: Path, out: { path: Path; deep: boolean }[] = []) {
  if (field.kind === 'object') {
    out.push({ path, deep: false });
    for (const property of field.properties) placedPaths(property.field, [...path, property.name], out);
  } else {
    out.push({ path, deep: field.kind === 'json' || field.kind === 'array' });
  }
  return out;
}

/** Problems no field shows (an unexpected top-level property, for example). */
export function unplacedProblems(field: Field, problems: readonly ArgumentProblem[]): ArgumentProblem[] {
  const placed = placedPaths(field, []);
  return problems.filter(
    (problem) =>
      problem.path.length === 0 ||
      !placed.some((entry) =>
        entry.deep ? isWithin(problem.path, entry.path) : pathKey(entry.path) === pathKey(problem.path),
      ),
  );
}

function ProblemList({ id, problems }: { id: string; problems: readonly ArgumentProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul id={id} className="text-destructive mt-1 space-y-0.5 text-xs" aria-live="polite">
      {problems.map((problem) => (
        <li key={`${problem.location}:${problem.message}`}>
          {problem.path.length > 0 ? `${problem.location.replace(/^arguments\.?/, '')}: ` : ''}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

function hint(field: Field): string | undefined {
  const parts: string[] = [];
  if (field.kind === 'string') {
    if (field.format) parts.push(field.format);
    if (field.minLength !== undefined) parts.push(`at least ${field.minLength} characters`);
    if (field.maxLength !== undefined) parts.push(`at most ${field.maxLength} characters`);
    if (field.pattern) parts.push(`pattern ${field.pattern}`);
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    if (field.kind === 'integer') parts.push('whole number');
    if (field.minimum !== undefined) parts.push(`min ${field.minimum}`);
    if (field.maximum !== undefined) parts.push(`max ${field.maximum}`);
  }
  if (field.kind === 'array') {
    if (field.minItems !== undefined) parts.push(`at least ${field.minItems} items`);
    if (field.maxItems !== undefined) parts.push(`at most ${field.maxItems} items`);
  }
  if (field.defaultValue !== undefined) parts.push(`default ${JSON.stringify(field.defaultValue)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** A number input that keeps what is typed ("-", "1.") while sending a number when it is one. */
function NumberInput({
  id,
  field,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  field: Extract<PrimitiveField, { kind: 'number' | 'integer' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    // Follow outside changes (a prefill, the Raw JSON editor) without fighting the typing.
    setText((current) => {
      const shown =
        current.trim() === '' ? undefined : Number.isFinite(Number(current)) ? Number(current) : current;
      if (shown === value) return current;
      return value === undefined ? '' : String(value);
    });
  }, [value]);
  if (field.enum) {
    return (
      <NativeSelect
        id={id}
        wrapperClassName="w-full sm:w-64"
        value={value === undefined ? '' : String(value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      >
        <option value="">(not set)</option>
        {field.enum.map((option) => (
          <option key={option} value={String(option)}>
            {option}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <Input
      id={id}
      inputMode={field.kind === 'integer' ? 'numeric' : 'decimal'}
      className="w-full sm:w-64"
      value={text}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') onChange(undefined);
        else {
          const parsed = Number(next);
          // Not a number yet: send the text, so the gateway's validation says what is wrong.
          onChange(Number.isFinite(parsed) ? parsed : next);
        }
      }}
    />
  );
}

function PrimitiveInput({
  id,
  field,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  field: PrimitiveField;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  if (field.kind === 'boolean') {
    return (
      <NativeSelect
        id={id}
        wrapperClassName="w-full sm:w-40"
        value={value === true ? 'true' : value === false ? 'false' : ''}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
      >
        <option value="">(not set)</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </NativeSelect>
    );
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    return (
      <NumberInput
        id={id}
        field={field}
        value={value}
        onChange={onChange}
        invalid={invalid}
        describedBy={describedBy}
      />
    );
  }
  if (field.kind !== 'string') return null;
  if (field.enum) {
    return (
      <NativeSelect
        id={id}
        wrapperClassName="w-full sm:w-64"
        value={typeof value === 'string' ? value : ''}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      >
        <option value="">(not set)</option>
        {field.enum.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <Input
      id={id}
      type={inputTypeFor(field.format)}
      value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    />
  );
}

/** One field edited as JSON text: the fallback for what the form does not draw. */
export function JsonEditor({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  rows = 4,
  label,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid?: boolean;
  describedBy?: string;
  rows?: number;
  label?: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string | undefined>();
  useEffect(() => {
    setText((current) => {
      // Cleared by the user: an empty value ({} for a whole input) keeps the editor empty.
      if (
        current.trim() === '' &&
        (value === undefined || (isObject(value) && Object.keys(value).length === 0))
      ) {
        return current;
      }
      if (current.trim() !== '') {
        try {
          if (JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current;
        } catch {
          // The text is mid-edit (not JSON yet): keep it.
          return current;
        }
      }
      return value === undefined ? '' : JSON.stringify(value, null, 2);
    });
  }, [value]);
  const errorId = `${id}-json-error`;
  return (
    <div>
      <Textarea
        id={id}
        rows={rows}
        spellCheck={false}
        className="font-mono text-xs"
        value={text}
        aria-label={label}
        aria-invalid={invalid || parseError !== undefined || undefined}
        aria-describedby={
          [describedBy, parseError ? errorId : undefined].filter(Boolean).join(' ') || undefined
        }
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (next.trim() === '') {
            setParseError(undefined);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            setParseError(undefined);
            onChange(parsed);
          } catch {
            setParseError('Not valid JSON yet.');
          }
        }}
      />
      {parseError ? (
        <p id={errorId} className="text-destructive mt-1 text-xs">
          {parseError}
        </p>
      ) : null}
    </div>
  );
}

interface FieldProps {
  name: string;
  required: boolean;
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  path: Path;
  problems: readonly ArgumentProblem[];
  idPrefix: string;
}

function FieldRow({ name, required, field, value, onChange, path, problems, idPrefix }: FieldProps) {
  const id = `${idPrefix}-${path
    .map(String)
    .join('-')
    .replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const deep = field.kind === 'json' || field.kind === 'array';
  const mine = problems.filter((problem) =>
    deep ? isWithin(problem.path, path) : pathKey(problem.path) === pathKey(path),
  );
  const problemId = `${id}-problems`;
  const descriptionId = `${id}-description`;
  const extra = hint(field);
  const describedBy =
    [field.description || extra ? descriptionId : undefined, mine.length > 0 ? problemId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  if (field.kind === 'object') {
    const object = isObject(value) ? value : {};
    return (
      <fieldset className="space-y-3 rounded-md border p-3" data-field={pathKey(path)}>
        <legend className="px-1 text-sm font-medium">
          {name}
          {required ? <span aria-hidden="true"> *</span> : null}
        </legend>
        {field.description ? <p className="text-muted-foreground text-xs">{field.description}</p> : null}
        <ProblemList id={problemId} problems={mine} />
        <ObjectFields
          field={field}
          value={object}
          onChange={(next) => onChange(Object.keys(next).length === 0 && !required ? undefined : next)}
          path={path}
          problems={problems}
          idPrefix={idPrefix}
        />
      </fieldset>
    );
  }

  return (
    <div className="space-y-1.5" data-field={pathKey(path)}>
      {/* An array is a group of inputs: its name labels the group, not one control. */}
      <Label {...(field.kind === 'array' ? { id: `${id}-label` } : { htmlFor: id })}>
        {name}
        {required ? <span aria-hidden="true"> *</span> : null}
        {field.title && field.title !== name ? (
          <span className="text-muted-foreground font-normal">({field.title})</span>
        ) : null}
      </Label>
      {field.kind === 'json' ? (
        <>
          <p className="text-muted-foreground text-xs">Edited as JSON: {field.reason}.</p>
          <JsonEditor
            id={id}
            value={value}
            onChange={onChange}
            invalid={mine.length > 0}
            describedBy={describedBy}
          />
        </>
      ) : field.kind === 'array' ? (
        <ArrayField
          id={id}
          name={name}
          field={field}
          value={value}
          onChange={onChange}
          path={path}
          problems={problems}
          describedBy={describedBy}
        />
      ) : (
        <PrimitiveInput
          id={id}
          field={field}
          value={value}
          onChange={onChange}
          invalid={mine.length > 0}
          describedBy={describedBy}
        />
      )}
      {field.description || extra ? (
        <p id={descriptionId} className="text-muted-foreground text-xs">
          {field.description}
          {field.description && extra ? ' · ' : ''}
          {extra}
        </p>
      ) : null}
      <ProblemList id={problemId} problems={mine} />
    </div>
  );
}

function ArrayField({
  id,
  name,
  field,
  value,
  onChange,
  path,
  problems,
  describedBy,
}: {
  id: string;
  name: string;
  field: Extract<Field, { kind: 'array' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  path: Path;
  problems: readonly ArgumentProblem[];
  describedBy?: string;
}) {
  const items = Array.isArray(value) ? value : [];
  const set = (next: unknown[]) => onChange(next.length === 0 ? undefined : next);
  return (
    <div
      className="space-y-2"
      id={id}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
    >
      {items.map((item, index) => {
        const itemPath = [...path, index];
        const invalid = problems.some((problem) => isWithin(problem.path, itemPath));
        return (
          <div key={index} className="flex items-center gap-2">
            <label htmlFor={`${id}-${index}`} className="sr-only">
              {name} item {index + 1}
            </label>
            <PrimitiveInput
              id={`${id}-${index}`}
              field={field.items}
              value={item}
              invalid={invalid}
              onChange={(next) => set(items.map((old, at) => (at === index ? next : old)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${name} item ${index + 1}`}
              onClick={() => set(items.filter((_, at) => at !== index))}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          set([...items, field.items.kind === 'boolean' ? false : field.items.kind === 'string' ? '' : 0])
        }
      >
        <PlusIcon aria-hidden="true" />
        Add item to {name}
      </Button>
    </div>
  );
}

function ObjectFields({
  field,
  value,
  onChange,
  path,
  problems,
  idPrefix,
}: {
  field: Extract<Field, { kind: 'object' }>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  path: Path;
  problems: readonly ArgumentProblem[];
  idPrefix: string;
}) {
  return (
    <>
      {field.properties.map((property) => (
        <FieldRow
          key={property.name}
          name={property.name}
          required={property.required}
          field={property.field}
          value={value[property.name]}
          path={[...path, property.name]}
          problems={problems}
          idPrefix={idPrefix}
          onChange={(next) => {
            const copy = { ...value };
            if (next === undefined) delete copy[property.name];
            else copy[property.name] = next;
            onChange(copy);
          }}
        />
      ))}
    </>
  );
}

/** The form for a whole input: an object's fields, or (for a schema it cannot draw) one JSON editor. */
export function SchemaForm({
  field,
  value,
  onChange,
  problems = [],
  className,
}: {
  field: Field;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  problems?: readonly ArgumentProblem[];
  className?: string;
}) {
  const idPrefix = `f${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const loose = unplacedProblems(field, problems);
  if (field.kind !== 'object') {
    return (
      <div className={cn('space-y-1.5', className)}>
        <p className="text-muted-foreground text-xs">
          The form cannot draw this input ({field.kind === 'json' ? field.reason : field.kind}); edit it as
          JSON.
        </p>
        <JsonEditor
          id={`${idPrefix}-root`}
          label="Arguments (JSON)"
          rows={8}
          value={value}
          onChange={(next) => onChange(isObject(next) ? next : {})}
          invalid={problems.length > 0}
        />
        <ProblemList id={`${idPrefix}-root-problems`} problems={problems} />
      </div>
    );
  }
  return (
    <div className={cn('space-y-4', className)}>
      <ProblemList id={`${idPrefix}-loose`} problems={loose} />
      {field.properties.length === 0 ? (
        <p className="text-muted-foreground text-sm">This tool takes no arguments.</p>
      ) : null}
      <ObjectFields
        field={field}
        value={value}
        onChange={onChange}
        path={[]}
        problems={problems}
        idPrefix={idPrefix}
      />
    </div>
  );
}
