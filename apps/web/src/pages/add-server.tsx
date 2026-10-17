import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  jsonErrorMessage,
  API_PATHS,
  PROTOCOL_MODES,
  proposedSecretName,
  slugProblem,
  validateConfig,
  type ImportResponse,
  type ServerResponse,
} from '@mcpier/shared';
import { api, describeError } from '@/lib/api';
import {
  buildEntry,
  choiceKey,
  emptyForm,
  entryFromCandidate,
  formFromEntry,
  newRow,
  oauthProblems,
  proposedClientSecretName,
  refreshRow,
  rowProblems,
  type EntryForm,
  type SecretToStore,
} from '@/lib/entry-form';
import { queryKeys, useSecrets, useServer, useServers } from '@/lib/queries';
import { ErrorMessage, LoadingRows, PageHeader } from '@/components/common';
import { ConnectionTest } from '@/components/connection-test';
import { StatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toaster';
import { ValueRows } from '@/components/value-rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

/** Stores the values marked as secrets first, one by one; only then is the entry saved. */
export async function storeSecretsThen<T>(secrets: SecretToStore[], save: () => Promise<T>): Promise<T> {
  for (const secret of secrets) {
    await api.put(API_PATHS.secret(secret.name), { value: secret.value });
  }
  return save();
}

function Field({
  label,
  htmlFor,
  hint,
  problem,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  problem?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : hint ? (
        <p className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
    </div>
  );
}

/** Problems for the whole form: name, rows, then the shared config schema. */
export function formProblems(form: EntryForm, existingNames: readonly string[], editing: boolean): string[] {
  const problems: string[] = [];
  const nameProblem = form.name ? slugProblem(form.name) : 'Name must not be empty';
  if (nameProblem) problems.push(nameProblem.startsWith('Name') ? nameProblem : `Name ${nameProblem}.`);
  if (!editing && existingNames.includes(form.name))
    problems.push(`A server named "${form.name}" already exists.`);
  problems.push(...rowProblems(form), ...oauthProblems(form));
  if (form.transport === 'http' && form.auth === 'oauth' && form.oauthSecretMode === 'new-secret') {
    const problem = form.oauthSecretName.trim() ? slugProblem(form.oauthSecretName.trim()) : undefined;
    if (problem) problems.push(`Secret name "${form.oauthSecretName}" ${problem}.`);
  }
  const rows = form.transport === 'stdio' ? form.env : form.headers;
  for (const row of rows) {
    if (row.mode === 'new-secret' && row.secretName) {
      const problem = slugProblem(row.secretName);
      if (problem) problems.push(`Secret name "${row.secretName}" ${problem}.`);
    }
  }
  if (problems.length === 0) {
    const result = validateConfig({ servers: [buildEntry(form, 'save').entry] });
    if (!result.ok)
      problems.push(...result.problems.map((problem) => problem.replace(/^servers\[0\]\.?/, '')));
  }
  return problems;
}

/**
 * The "OAuth client" group: only for providers that offer no automatic registration. The
 * client secret is stored as a secret before the server is saved, like other secret rows.
 */
function OAuthClientFields({
  form,
  set,
  secretNames,
}: {
  form: EntryForm;
  set: (change: Partial<EntryForm>) => void;
  secretNames: string[];
}) {
  const options =
    form.oauthExistingSecret && !secretNames.includes(form.oauthExistingSecret)
      ? [...secretNames, form.oauthExistingSecret].sort()
      : secretNames;
  return (
    <fieldset className="mt-6 space-y-4 border-t pt-4" aria-label="OAuth client">
      <legend className="text-sm font-medium">OAuth client</legend>
      <p className="text-muted-foreground text-xs">
        Leave this empty unless the provider has no automatic registration: MCPier then registers itself. A
        client ID from the provider's console is used whenever it is set.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Client ID" htmlFor="oauth-client-id" hint="From the provider's developer console.">
          <Input
            id="oauth-client-id"
            autoComplete="off"
            value={form.oauthClientId}
            onChange={(event) => set({ oauthClientId: event.target.value })}
          />
        </Field>
        <Field
          label="Extra scopes"
          htmlFor="oauth-scopes"
          hint="Separated by spaces; asked for on top of the server's own."
        >
          <Input
            id="oauth-scopes"
            autoComplete="off"
            value={form.oauthScopes}
            onChange={(event) => set({ oauthScopes: event.target.value })}
          />
        </Field>
        <Field label="Client secret" htmlFor="oauth-secret-mode" hint="Only if the provider issued one.">
          <NativeSelect
            id="oauth-secret-mode"
            wrapperClassName="w-full"
            value={form.oauthSecretMode}
            onChange={(event) =>
              set({
                oauthSecretMode: event.target.value as EntryForm['oauthSecretMode'],
                ...(event.target.value === 'new-secret' && !form.oauthSecretName
                  ? { oauthSecretName: proposedClientSecretName(form.name) }
                  : {}),
              })
            }
          >
            <option value="none">None (a public client)</option>
            <option value="new-secret">Store as a secret</option>
            <option value="existing-secret">Use an existing secret</option>
          </NativeSelect>
        </Field>
        {form.oauthSecretMode === 'new-secret' ? (
          <div className="grid grid-cols-1 gap-2">
            <Field label="Client secret value" htmlFor="oauth-secret-value">
              <Input
                id="oauth-secret-value"
                type="password"
                autoComplete="off"
                value={form.oauthSecretValue}
                onChange={(event) => set({ oauthSecretValue: event.target.value })}
              />
            </Field>
            <Field label="Secret name" htmlFor="oauth-secret-name">
              <Input
                id="oauth-secret-name"
                value={form.oauthSecretName}
                onChange={(event) => set({ oauthSecretName: event.target.value })}
              />
            </Field>
          </div>
        ) : null}
        {form.oauthSecretMode === 'existing-secret' ? (
          <Field label="Secret" htmlFor="oauth-existing-secret">
            <NativeSelect
              id="oauth-existing-secret"
              wrapperClassName="w-full"
              value={form.oauthExistingSecret}
              onChange={(event) => set({ oauthExistingSecret: event.target.value })}
            >
              <option value="" disabled>
                {options.length === 0 ? 'No secrets yet' : 'Choose a secret'}
              </option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
      </div>
    </fieldset>
  );
}

export function ServerForm({
  initial,
  editing,
  onSubmit,
  submitting,
  submitLabel,
}: {
  initial: EntryForm;
  editing: boolean;
  onSubmit: (form: EntryForm) => void;
  submitting: boolean;
  submitLabel: string;
}) {
  const [form, setForm] = useState<EntryForm>(initial);
  const [showProblems, setShowProblems] = useState(false);
  const servers = useServers();
  const secrets = useSecrets();
  const existing = servers.data?.servers.map((server) => server.name) ?? [];
  const secretNames = secrets.data?.secrets.map((secret) => secret.name) ?? [];
  const problems = formProblems(form, existing, editing);
  const set = (change: Partial<EntryForm>) => setForm((current) => ({ ...current, ...change }));
  const setName = (name: string) =>
    setForm((current) => ({
      ...current,
      name,
      env: current.env.map((row) => refreshRow(row, 'env', name)),
      headers: current.headers.map((row) => refreshRow(row, 'header', name)),
    }));
  const nameProblem =
    form.name.length === 0
      ? undefined
      : ((slugProblem(form.name) ? `Name ${slugProblem(form.name)}.` : undefined) ??
        (!editing && existing.includes(form.name)
          ? `A server named "${form.name}" already exists.`
          : undefined));

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setShowProblems(true);
        if (problems.length === 0) onSubmit(form);
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Name"
          htmlFor="server-name"
          hint="Lowercase letters, digits and hyphens. Tools appear as name__tool."
          problem={nameProblem}
        >
          <Input
            id="server-name"
            value={form.name}
            disabled={editing}
            aria-invalid={nameProblem !== undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="server-description"
          hint="What the server is for; search uses it."
        >
          <Input
            id="server-description"
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
          />
        </Field>
        <Field label="Transport" htmlFor="server-transport">
          <NativeSelect
            id="server-transport"
            wrapperClassName="w-full"
            value={form.transport}
            onChange={(event) => set({ transport: event.target.value as EntryForm['transport'] })}
          >
            <option value="stdio">stdio (a local command)</option>
            <option value="http">HTTP (a remote URL)</option>
          </NativeSelect>
        </Field>
      </div>

      {form.transport === 'stdio' ? (
        <section className="space-y-4">
          <Field
            label="Command"
            htmlFor="server-command"
            hint="For example npx, uvx, or a full path to an .exe."
          >
            <Input
              id="server-command"
              value={form.command}
              onChange={(event) => set({ command: event.target.value })}
            />
          </Field>
          <div className="space-y-2">
            <Label>Arguments</Label>
            {form.args.map((arg, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  aria-label={`Argument ${index + 1}`}
                  value={arg}
                  onChange={(event) =>
                    set({ args: form.args.map((other, i) => (i === index ? event.target.value : other)) })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => set({ args: form.args.filter((_, i) => i !== index) })}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set({ args: [...form.args, ''] })}
            >
              Add argument
            </Button>
          </div>
          <div className="space-y-2">
            <Label>Environment variables</Label>
            <ValueRows
              rows={form.env}
              onChange={(env) => set({ env })}
              location="env"
              serverName={form.name}
              secretNames={secretNames}
            />
          </div>
        </section>
      ) : (
        <section className="space-y-4">
          <Field label="URL" htmlFor="server-url" hint="The server's Streamable HTTP endpoint.">
            <Input
              id="server-url"
              type="url"
              value={form.url}
              onChange={(event) => set({ url: event.target.value })}
            />
          </Field>
          <div className="space-y-2">
            <Label>Headers</Label>
            <ValueRows
              rows={form.headers}
              onChange={(headers) => set({ headers })}
              location="header"
              serverName={form.name}
              secretNames={secretNames}
            />
          </div>
          <Field label="Sign-in" htmlFor="server-auth">
            <NativeSelect
              id="server-auth"
              wrapperClassName="w-full md:w-72"
              value={form.auth}
              onChange={(event) => set({ auth: event.target.value as EntryForm['auth'] })}
            >
              <option value="none">None (or headers above)</option>
              <option value="oauth">OAuth</option>
            </NativeSelect>
          </Field>
        </section>
      )}

      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Protocol" htmlFor="server-protocol" hint="auto works for almost every server.">
            <NativeSelect
              id="server-protocol"
              wrapperClassName="w-full"
              value={form.protocol}
              onChange={(event) => set({ protocol: event.target.value as EntryForm['protocol'] })}
            >
              {PROTOCOL_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Call timeout (ms)" htmlFor="server-timeout" hint="Default 60000.">
            <Input
              id="server-timeout"
              inputMode="numeric"
              value={form.timeoutMs}
              onChange={(event) => set({ timeoutMs: event.target.value })}
            />
          </Field>
          <Field
            label="Startup timeout (ms)"
            htmlFor="server-startup"
            hint="Default 90000; first npx/uvx runs can be slow."
          >
            <Input
              id="server-startup"
              inputMode="numeric"
              value={form.startupTimeoutMs}
              onChange={(event) => set({ startupTimeoutMs: event.target.value })}
            />
          </Field>
          <div className="flex items-center gap-2 self-end pb-2">
            <Switch
              id="server-enabled"
              checked={form.enabled}
              onCheckedChange={(enabled) => set({ enabled })}
            />
            <Label htmlFor="server-enabled">{editing ? 'Enabled' : 'Start it when saved'}</Label>
          </div>
        </div>
        {form.transport === 'http' && form.auth === 'oauth' ? (
          <OAuthClientFields form={form} set={set} secretNames={secretNames} />
        ) : null}
      </details>

      {showProblems && problems.length > 0 ? (
        <div role="alert" className="text-destructive space-y-1 text-sm">
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </div>
      ) : null}

      <ConnectionTest entry={() => buildEntry(form, 'test').entry} disabled={problems.length > 0} />

      <div className="flex gap-2 border-t pt-4">
        <Button type="submit" disabled={submitting}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link to={editing ? `/servers/${encodeURIComponent(form.name)}` : '/servers'}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

// ---- Paste JSON

function PasteJson() {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ response: ImportResponse; pasted: unknown } | undefined>();
  const [secretNames, setSecretNames] = useState<Map<string, string>>(new Map());
  const [created, setCreated] = useState<string[]>([]);
  const client = useQueryClient();
  const servers = useServers();
  const { notify } = useToast();

  const previewMutation = useMutation({
    mutationFn: async () => {
      let pasted: unknown;
      try {
        pasted = JSON.parse(text);
      } catch (error) {
        throw new Error(`The pasted text is not valid JSON: ${jsonErrorMessage(error)}`, { cause: error });
      }
      const response = await api.post<ImportResponse>(API_PATHS.import, { source: pasted, dryRun: true });
      return { response, pasted };
    },
    onSuccess: (result) => {
      setPreview(result);
      setCreated([]);
      // Credential-looking values default to "store as secret", with a proposed name.
      const names = new Map<string, string>();
      for (const entry of result.response.entries) {
        for (const value of entry.sensitive)
          names.set(
            choiceKey(entry.key, value.location, value.key),
            proposedSecretName(entry.name, value.key),
          );
      }
      setSecretNames(names);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!preview) return [];
      const names: string[] = [];
      for (const candidate of preview.response.entries) {
        const built = entryFromCandidate(
          candidate,
          preview.pasted,
          preview.response.shape,
          { secretNames },
          'save',
        );
        await storeSecretsThen(built.secrets, () => api.post<ServerResponse>(API_PATHS.servers, built.entry));
        names.push(candidate.name);
      }
      return names;
    },
    onSuccess: (names) => {
      setCreated(names);
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      notify('success', `Added ${names.join(', ')}.`);
    },
    onError: (error) => {
      const { message, problems } = describeError(error);
      notify('error', 'Could not save', [message, ...problems].join('\n'));
    },
  });

  const statusOf = (name: string) => servers.data?.servers.find((server) => server.name === name);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="paste-json">A mcpServers block</Label>
        <Textarea
          id="paste-json"
          className="min-h-40 font-mono text-xs"
          placeholder={
            '{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\me"] } } }'
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          The format most server READMEs publish. Nothing is saved until you choose Save.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={!text.trim() || previewMutation.isPending}
        onClick={() => previewMutation.mutate()}
      >
        Preview
      </Button>
      {previewMutation.error ? (
        <ErrorMessage error={previewMutation.error} title="Cannot read that block" />
      ) : null}

      {preview ? (
        <div className="space-y-4">
          {preview.response.errors.map((problem) => (
            <div
              key={problem.key}
              role="alert"
              className="border-destructive/40 rounded-md border p-3 text-sm"
            >
              <p className="font-medium">{problem.key}: not imported</p>
              <p className="text-muted-foreground">{problem.message}</p>
            </div>
          ))}
          {preview.response.entries.map((candidate) => (
            <div
              key={candidate.key}
              className="space-y-3 rounded-md border p-4"
              data-candidate={candidate.name}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {candidate.name}
                  <span className="text-muted-foreground ml-2 text-xs">
                    {String(candidate.entry.transport)}
                  </span>
                </p>
                {statusOf(candidate.name) && created.includes(candidate.name) ? (
                  <StatusBadge state={statusOf(candidate.name)!.status.state} />
                ) : null}
              </div>
              {candidate.ignored.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  Ignored fields: {candidate.ignored.join(', ')}
                </p>
              ) : null}
              {candidate.sensitive.map((value) => {
                const key = choiceKey(candidate.key, value.location, value.key);
                const name = secretNames.get(key);
                return (
                  <div
                    key={key}
                    className="flex flex-wrap items-center gap-2 text-sm"
                    data-sensitive={value.key}
                  >
                    <Switch
                      id={`secret-${key}`}
                      aria-label={`Store ${value.key} as a secret`}
                      checked={name !== undefined}
                      onCheckedChange={(on) =>
                        setSecretNames((current) => {
                          const next = new Map(current);
                          if (on) next.set(key, proposedSecretName(candidate.name, value.key));
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                    <span>
                      <span className="font-mono">{value.key}</span> looks like a credential.{' '}
                      {name !== undefined
                        ? 'Store it as the secret'
                        : 'Keep it as plain text in config.json.'}
                    </span>
                    {name !== undefined ? (
                      <Input
                        aria-label={`Secret name for ${value.key}`}
                        className="h-8 w-56"
                        value={name}
                        onChange={(event) =>
                          setSecretNames((current) => new Map(current).set(key, event.target.value))
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
              <ConnectionTest
                entry={() =>
                  entryFromCandidate(
                    candidate,
                    preview.pasted,
                    preview.response.shape,
                    { secretNames },
                    'test',
                  ).entry
                }
              />
            </div>
          ))}
          {preview.response.entries.length > 0 && created.length === 0 ? (
            <Button type="button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              Save {preview.response.entries.length}{' '}
              {preview.response.entries.length === 1 ? 'server' : 'servers'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- Pages

export function AddServerPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { notify } = useToast();
  const initial = useMemo(() => ({ ...emptyForm(), env: [] as ReturnType<typeof newRow>[] }), []);
  const save = useMutation({
    mutationFn: (form: EntryForm) => {
      const built = buildEntry(form, 'save');
      return storeSecretsThen(built.secrets, () => api.post<ServerResponse>(API_PATHS.servers, built.entry));
    },
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      notify('success', `Added ${response.server.name}.`);
      void navigate(`/servers/${encodeURIComponent(response.server.name)}`);
    },
  });

  return (
    <>
      <PageHeader
        title="Add server"
        description="Fill in a form, or paste the mcpServers block from the server's README."
      />
      <Tabs defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="paste">Paste JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="mt-4 space-y-4">
          {save.error ? <ErrorMessage error={save.error} title="Could not save the server" /> : null}
          <ServerForm
            initial={initial}
            editing={false}
            onSubmit={(form) => save.mutate(form)}
            submitting={save.isPending}
            submitLabel="Save server"
          />
        </TabsContent>
        <TabsContent value="paste" className="mt-4">
          <PasteJson />
        </TabsContent>
      </Tabs>
    </>
  );
}

export function EditServerPage() {
  const { name = '' } = useParams();
  const detail = useServer(name);
  const navigate = useNavigate();
  const client = useQueryClient();
  const { notify } = useToast();
  const save = useMutation({
    mutationFn: (form: EntryForm) => {
      const built = buildEntry(form, 'save');
      const { name: _name, ...fields } = built.entry;
      const patch: Record<string, unknown> = { ...fields };
      if (!form.description.trim()) patch.description = null;
      if (form.transport === 'http' && form.auth !== 'oauth') patch.auth = null;
      // A cleared OAuth client is removed from config.json.
      if (form.transport === 'http' && !('oauth' in fields)) patch.oauth = null;
      return storeSecretsThen(built.secrets, () => api.patch<ServerResponse>(API_PATHS.server(name), patch));
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.server(name) });
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      notify('success', `Saved ${name}. It restarts if its connection settings changed.`);
      void navigate(`/servers/${encodeURIComponent(name)}`);
    },
  });

  if (detail.isPending) return <LoadingRows label="Loading the server" />;
  if (detail.error) return <ErrorMessage error={detail.error} title={`Cannot load ${name}`} />;
  return (
    <>
      <PageHeader
        title={`Edit ${name}`}
        description="Changes to the command, URL, env or headers restart the server."
      />
      {save.error ? <ErrorMessage error={save.error} title="Could not save the server" /> : null}
      <ServerForm
        initial={formFromEntry(detail.data.config)}
        editing
        onSubmit={(form) => save.mutate(form)}
        submitting={save.isPending}
        submitLabel="Save changes"
      />
    </>
  );
}
