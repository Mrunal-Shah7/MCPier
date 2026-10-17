import { PlusIcon, Trash2Icon } from 'lucide-react';
import { slugProblem } from '@mcpier/shared';
import { newRow, refreshRow, type ValueMode, type ValueRow } from '@/lib/entry-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * Key/value rows for env variables or headers. Each row is plain, a new secret (stored in
 * Credential Manager before saving; on by default for credential-looking names), or a
 * reference to an existing secret.
 */
export function ValueRows({
  rows,
  onChange,
  location,
  serverName,
  secretNames,
}: {
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
  location: 'env' | 'header';
  serverName: string;
  secretNames: string[];
}) {
  const label = location === 'env' ? 'Environment variable' : 'Header';
  // A referenced secret is always offered, even before the list loads or if it is missing.
  const optionsFor = (row: ValueRow) =>
    row.existingSecret && !secretNames.includes(row.existingSecret)
      ? [...secretNames, row.existingSecret].sort()
      : secretNames;
  const update = (id: number, change: Partial<ValueRow>, refresh = false) =>
    onChange(
      rows.map((row) => {
        if (row.id !== id) return row;
        const next = { ...row, ...change };
        return refresh ? refreshRow(next, location, serverName) : next;
      }),
    );

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No {location === 'env' ? 'environment variables' : 'headers'}.
        </p>
      ) : null}
      {rows.map((row, index) => {
        const secretNameProblem =
          row.mode === 'new-secret' && row.secretName ? slugProblem(row.secretName) : undefined;
        return (
          <div
            key={row.id}
            className="grid grid-cols-1 gap-2 rounded-md border p-3 md:grid-cols-[1fr_1fr_auto]"
            data-row={row.key || index}
          >
            <Input
              aria-label={`${label} ${index + 1} name`}
              placeholder={location === 'env' ? 'NAME' : 'Header-Name'}
              value={row.key}
              onChange={(event) => update(row.id, { key: event.target.value }, true)}
            />
            {row.mode === 'existing-secret' ? (
              <div className="grid grid-cols-[auto_1fr] gap-2">
                {location === 'header' ? (
                  <Input
                    aria-label={`${label} ${index + 1} scheme`}
                    placeholder="Bearer"
                    className="w-24"
                    value={row.value}
                    onChange={(event) => update(row.id, { value: event.target.value })}
                  />
                ) : (
                  <span />
                )}
                <NativeSelect
                  aria-label={`${label} ${index + 1} secret`}
                  wrapperClassName="w-full"
                  value={row.existingSecret}
                  onChange={(event) => update(row.id, { existingSecret: event.target.value })}
                >
                  <option value="" disabled>
                    {optionsFor(row).length === 0 ? 'No secrets yet' : 'Choose a secret'}
                  </option>
                  {optionsFor(row).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <Input
                aria-label={`${label} ${index + 1} value`}
                type={row.mode === 'new-secret' ? 'password' : 'text'}
                autoComplete="off"
                placeholder={row.mode === 'new-secret' ? 'Value to store as a secret' : 'value'}
                value={row.value}
                onChange={(event) => update(row.id, { value: event.target.value })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label.toLowerCase()} ${row.key || index + 1}`}
              onClick={() => onChange(rows.filter((other) => other.id !== row.id))}
            >
              <Trash2Icon />
            </Button>
            <div className="flex flex-wrap items-center gap-2 md:col-span-3">
              <NativeSelect
                aria-label={`${label} ${index + 1} storage`}
                controlSize="sm"
                wrapperClassName="w-56"
                value={row.mode}
                onChange={(event) =>
                  update(row.id, { mode: event.target.value as ValueMode, modeTouched: true })
                }
              >
                <option value="plain">Plain value in config.json</option>
                <option value="new-secret">Store as a secret</option>
                <option value="existing-secret">Use an existing secret</option>
              </NativeSelect>
              {row.mode === 'new-secret' ? (
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Secret name</span>
                  <Input
                    aria-label={`${label} ${index + 1} secret name`}
                    className="h-8 w-56"
                    value={row.secretName}
                    aria-invalid={secretNameProblem !== undefined}
                    onChange={(event) =>
                      update(row.id, { secretName: event.target.value, modeTouched: true })
                    }
                  />
                </label>
              ) : null}
              {secretNameProblem ? (
                <p className="text-destructive text-xs">Secret name {secretNameProblem}.</p>
              ) : null}
            </div>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, newRow()])}>
        <PlusIcon aria-hidden="true" />
        Add {location === 'env' ? 'variable' : 'header'}
      </Button>
    </div>
  );
}
