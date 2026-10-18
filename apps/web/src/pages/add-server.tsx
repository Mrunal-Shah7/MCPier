import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, RefreshCwIcon } from 'lucide-react';
import {
  jsonErrorMessage,
  API_PATHS,
  iconFieldProblem,
  PROTOCOL_MODES,
  proposedSecretName,
  slugProblem,
  validateConfig,
  type ImportResponse,
  type ServerEntry,
  type ServerResponse,
} from '@mcpier/shared';
import { api, describeError } from '@/lib/api';
import {
  buildEntry,
  choiceKey,
  emptyForm,
  entryFromCandidate,
  formFromEntry,
  oauthProblems,
  proposedClientSecretName,
  refreshRow,
  rowProblems,
  type EntryForm,
  type SecretToStore,
} from '@/lib/entry-form';
import { analyzeEntryJson } from '@/lib/json-entry';
import { queryKeys, useSecrets, useServer, useServers } from '@/lib/queries';
import { useUnsavedGuard } from '@/lib/unsaved-guard';
import { ErrorMessage, LoadingRows } from '@/components/common';
import { ConnectionTest, SecretsNote } from '@/components/connection-test';
import { InfoTip, PageTitle, Panel, PanelBody, RailGrid, Segmented, Stack } from '@/components/kit';
import { ScopeInput } from '@/components/scope-input';
import { ServerTile } from '@/components/server-tile';
import { ServerJson } from '@/components/server-json';
import { Chip, SecretChip, StatusBadge, ToneBadge, TransportChip } from '@/components/status-badge';
import { useToast } from '@/components/toaster';
import { ValueRows } from '@/components/value-rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { MoveToSecretDialog } from '@/pages/server-detail';

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
  info,
  hint,
  problem,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  info?: string;
  /** Kept only where a mistake is costly (Confirmed decision 3). */
  hint?: string;
  problem?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-semibold">
          {label}
        </Label>
        {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
      </div>
      {children}
      {problem ? (
        <p className="text-tone-bad-text mt-1 text-xs" role="alert">
          {problem}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-faint mt-1 text-xs">
          {hint}
        </p>
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

/** The OAuth client group: a client ID, its secret (stored as a secret first), and scopes. */
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
    <fieldset className="space-y-4 border-t pt-4" aria-label="OAuth client">
      <legend className="sr-only">OAuth client</legend>
      <div className="flex items-center gap-2">
        <b className="text-sm">OAuth client</b>
        <InfoTip label="About the OAuth client">
          Only needed when the provider has no automatic registration. A client ID from the provider's console
          is used whenever it is set.
        </InfoTip>
        <span className="text-faint ml-auto text-xs">optional</span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Client ID" htmlFor="oauth-client-id">
          <Input
            id="oauth-client-id"
            autoComplete="off"
            className="font-mono"
            placeholder="Automatic registration"
            value={form.oauthClientId}
            onChange={(event) => set({ oauthClientId: event.target.value })}
          />
        </Field>
        <Field label="Client secret" htmlFor="oauth-secret-mode">
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
            <option value="none">None</option>
            <option value="new-secret">Store as a secret</option>
            <option value="existing-secret">Use an existing secret</option>
          </NativeSelect>
        </Field>
        {form.oauthSecretMode === 'new-secret' ? (
          <>
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
          </>
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
      <Field
        label="Scopes"
        htmlFor="oauth-scopes"
        hint="When set, exactly these scopes are requested (plus offline_access when offered). Leave empty to use the server's own."
      >
        <ScopeInput
          id="oauth-scopes"
          describedBy="oauth-scopes-hint"
          value={form.oauthScopes}
          onChange={(oauthScopes) => set({ oauthScopes })}
        />
      </Field>
    </fieldset>
  );
}

function IconField({
  form,
  set,
  serverName,
}: {
  form: EntryForm;
  set: (change: Partial<EntryForm>) => void;
  /** Edit only: the server whose icon can be fetched again. */
  serverName?: string;
}) {
  const client = useQueryClient();
  const { notify } = useToast();
  const servers = useServers();
  const icon = servers.data?.servers.find((server) => server.name === serverName)?.icon;
  const refresh = useMutation({
    mutationFn: () => api.post<ServerResponse>(API_PATHS.serverIconRefresh(serverName!)),
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: queryKeys.servers });
      void client.invalidateQueries({ queryKey: queryKeys.server(serverName!) });
      notify(
        'success',
        response.server.icon?.available
          ? `Icon found (${response.server.icon.source}).`
          : 'No icon found: the letter tile stays.',
      );
    },
    onError: (error) => notify('error', 'Could not refresh the icon', (error as Error).message),
  });
  const problem = form.icon.trim() ? iconFieldProblem(form.icon.trim()) : undefined;
  return (
    <Field
      label="Icon"
      htmlFor="server-icon"
      info="Found automatically: the server's own icon, its website's favicon, or its site's. Override it with an https URL, an absolute path to a .png, .jpg, .webp, .ico or .svg file, or none for the letter tile."
      problem={problem}
    >
      <div className="flex flex-wrap items-center gap-2">
        {serverName ? <ServerTile name={serverName} icon={icon} /> : null}
        <Input
          id="server-icon"
          className="min-w-0 flex-1 font-mono"
          placeholder="Automatic"
          value={form.icon}
          aria-invalid={problem !== undefined}
          onChange={(event) => set({ icon: event.target.value })}
        />
        {serverName ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCwIcon aria-hidden="true" className={refresh.isPending ? 'animate-spin' : undefined} />
            Refresh icon
          </Button>
        ) : null}
      </div>
      {serverName && icon?.source ? <p className="text-faint mt-1 text-xs">Current: {icon.source}</p> : null}
    </Field>
  );
}

export function ServerForm({
  form,
  setForm,
  editing,
  onSubmit,
  formId = 'server-form',
}: {
  form: EntryForm;
  setForm: (update: (current: EntryForm) => EntryForm) => void;
  editing: boolean;
  onSubmit: (form: EntryForm) => void;
  formId?: string;
}) {
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
      id={formId}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setShowProblems(true);
        if (problems.length === 0) onSubmit(form);
      }}
    >
      <Panel>
        <PanelBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Name"
              htmlFor="server-name"
              info="Lowercase letters, digits and hyphens. Tools appear as name__tool."
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
              info="What the server is for; search uses it."
            >
              <Input
                id="server-description"
                placeholder="Optional"
                value={form.description}
                onChange={(event) => set({ description: event.target.value })}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground w-[90px] text-xs font-semibold">Transport</span>
            <Segmented<EntryForm['transport']>
              label="Transport"
              value={form.transport}
              options={[
                { value: 'stdio', label: 'stdio' },
                { value: 'http', label: 'http' },
              ]}
              onChange={(transport) => set({ transport })}
            />
          </div>

          {form.transport === 'stdio' ? (
            <>
              <Field
                label="Command"
                htmlFor="server-command"
                info="For example npx, uvx, or a full path to an .exe."
              >
                <Input
                  id="server-command"
                  className="font-mono"
                  value={form.command}
                  onChange={(event) => set({ command: event.target.value })}
                />
              </Field>
              <div className="space-y-2">
                <span className="text-muted-foreground text-xs font-semibold">Arguments</span>
                {form.args.map((arg, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      aria-label={`Argument ${index + 1}`}
                      className="font-mono"
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
              <div className="space-y-2 border-t pt-4">
                <b className="text-sm">Environment</b>
                <ValueRows
                  rows={form.env}
                  onChange={(env) => set({ env })}
                  location="env"
                  serverName={form.name}
                  secretNames={secretNames}
                />
              </div>
            </>
          ) : (
            <>
              <Field label="URL" htmlFor="server-url" info="The server's Streamable HTTP endpoint.">
                <Input
                  id="server-url"
                  type="url"
                  className="font-mono"
                  value={form.url}
                  onChange={(event) => set({ url: event.target.value })}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-muted-foreground w-[90px] text-xs font-semibold">Sign-in</span>
                <Segmented<EntryForm['auth']>
                  label="Sign-in"
                  value={form.auth}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'oauth', label: 'OAuth' },
                  ]}
                  onChange={(auth) => set({ auth })}
                />
              </div>
              {form.auth === 'oauth' ? (
                <OAuthClientFields form={form} set={set} secretNames={secretNames} />
              ) : null}
              <div className="space-y-2 border-t pt-4">
                <b className="text-sm">Headers</b>
                <ValueRows
                  rows={form.headers}
                  onChange={(headers) => set({ headers })}
                  location="header"
                  serverName={form.name}
                  secretNames={secretNames}
                />
              </div>
            </>
          )}

          <details className="border-t pt-4">
            <summary className="text-muted-foreground cursor-pointer text-sm">Advanced</summary>
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field label="Protocol" htmlFor="server-protocol" info="auto works for almost every server.">
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
                <Field label="Call timeout (ms)" htmlFor="server-timeout" info="Default 60000.">
                  <Input
                    id="server-timeout"
                    inputMode="numeric"
                    placeholder="60000"
                    value={form.timeoutMs}
                    onChange={(event) => set({ timeoutMs: event.target.value })}
                  />
                </Field>
                <Field
                  label="Startup timeout (ms)"
                  htmlFor="server-startup"
                  info="Default 90000; first npx/uvx runs can be slow."
                >
                  <Input
                    id="server-startup"
                    inputMode="numeric"
                    placeholder="90000"
                    value={form.startupTimeoutMs}
                    onChange={(event) => set({ startupTimeoutMs: event.target.value })}
                  />
                </Field>
              </div>
              <IconField form={form} set={set} {...(editing ? { serverName: form.name } : {})} />
              <div className="flex items-center gap-2">
                <Switch
                  id="server-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => set({ enabled })}
                />
                <Label htmlFor="server-enabled">{editing ? 'Enabled' : 'Start it when saved'}</Label>
              </div>
            </div>
          </details>

          {showProblems && problems.length > 0 ? (
            <div role="alert" className="text-tone-bad-text space-y-1 text-sm">
              {problems.map((problem) => (
                <p key={problem} className="wrap-anywhere m-0">
                  {problem}
                </p>
              ))}
            </div>
          ) : null}
        </PanelBody>
      </Panel>
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
    <Stack>
      <Panel>
        <PanelBody className="space-y-3">
          <Label htmlFor="paste-json" className="sr-only">
            A mcpServers block
          </Label>
          <Textarea
            id="paste-json"
            className="min-h-48 font-mono text-xs"
            placeholder={
              '{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\me"] } } }'
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!text.trim() || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              Preview
            </Button>
            <InfoTip label="About pasting">
              The format most server READMEs publish. Nothing is saved until you choose Save.
            </InfoTip>
          </div>
          {previewMutation.error ? (
            <ErrorMessage error={previewMutation.error} title="Cannot read that block" />
          ) : null}
        </PanelBody>
      </Panel>

      {preview ? (
        <Panel aria-label="Preview">
          <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
            <h2 className="text-[13px] font-semibold">Preview</h2>
            <span className="text-faint ml-auto text-xs">
              {preview.response.entries.length} {preview.response.entries.length === 1 ? 'server' : 'servers'}
            </span>
          </div>
          <div className="divide-y">
            {preview.response.errors.map((problem) => (
              <div key={problem.key} role="alert" className="px-3.5 py-3 text-sm">
                <p className="text-tone-bad-text m-0 font-medium">{problem.key}: not imported</p>
                <p className="text-muted-foreground wrap-anywhere m-0">{problem.message}</p>
              </div>
            ))}
            {preview.response.entries.map((candidate) => (
              <div key={candidate.key} className="space-y-3 px-3.5 py-3" data-candidate={candidate.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <ServerTile name={candidate.name} size="sm" />
                  <b>{candidate.name}</b>
                  <TransportChip transport={candidate.entry.transport === 'http' ? 'http' : 'stdio'} />
                  {candidate.oauth ? (
                    <>
                      <ToneBadge tone="ok" dot={false}>
                        OAuth detected
                      </ToneBadge>
                      {candidate.oauth.scopes.length > 0 ? (
                        <ToneBadge tone="info" dot={false}>
                          {candidate.oauth.scopes.length}{' '}
                          {candidate.oauth.scopes.length === 1 ? 'scope' : 'scopes'}
                        </ToneBadge>
                      ) : null}
                    </>
                  ) : null}
                  {statusOf(candidate.name) && created.includes(candidate.name) ? (
                    <StatusBadge state={statusOf(candidate.name)!.status.state} className="ml-auto" />
                  ) : null}
                </div>
                {candidate.oauth ? (
                  <div
                    className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
                    data-oauth-preview
                  >
                    {candidate.oauth.clientId ? (
                      <span>
                        Client ID{' '}
                        <span className="text-foreground font-mono">{candidate.oauth.clientId}</span>
                      </span>
                    ) : null}
                    {candidate.oauth.scopes.map((scope) => (
                      <Chip key={scope} className="font-mono">
                        {scope}
                      </Chip>
                    ))}
                    {candidate.oauth.clientSecret?.kind === 'plain' &&
                    candidate.oauth.clientSecret.movedTo ? (
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono">clientSecret</span> →{' '}
                        <SecretChip name={candidate.oauth.clientSecret.movedTo} />
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {(candidate.notes ?? []).map((note) => (
                  <p key={note} className="text-tone-warn-text m-0 text-xs">
                    {note}
                  </p>
                ))}
                {candidate.ignored.length > 0 ? (
                  <p className="text-faint m-0 text-xs">Ignored fields: {candidate.ignored.join(', ')}</p>
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
                  bare
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
          </div>
          {preview.response.entries.length > 0 && created.length === 0 ? (
            <div className="border-t px-3.5 py-3">
              <Button type="button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                Save {preview.response.entries.length}{' '}
                {preview.response.entries.length === 1 ? 'server' : 'servers'}
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </Stack>
  );
}

// ---- Pages

export function AddServerPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { notify } = useToast();
  const [tab, setTab] = useState('form');
  const [form, setForm] = useState<EntryForm>(() => emptyForm());
  const save = useMutation({
    mutationFn: (current: EntryForm) => {
      const built = buildEntry(current, 'save');
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
      <PageTitle
        crumb={
          <>
            <Link to="/servers" className="hover:underline">
              Servers
            </Link>{' '}
            / Add
          </>
        }
        title="Add server"
        actions={
          <>
            <Button type="button" variant="outline" asChild>
              <Link to="/servers">Cancel</Link>
            </Button>
            {tab === 'form' ? (
              <Button type="submit" form="server-form" disabled={save.isPending}>
                <CheckIcon aria-hidden="true" />
                Save server
              </Button>
            ) : null}
          </>
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="paste">Paste JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="form">
          <RailGrid>
            <Stack>
              {save.error ? <ErrorMessage error={save.error} title="Could not save the server" /> : null}
              <ServerForm
                form={form}
                setForm={setForm}
                editing={false}
                onSubmit={(current) => save.mutate(current)}
              />
            </Stack>
            <Stack>
              <ConnectionTest
                entry={() => buildEntry(form, 'test').entry}
                disabled={formProblems(form, [], false).length > 0}
              />
              <SecretsNote />
            </Stack>
          </RailGrid>
        </TabsContent>
        <TabsContent value="paste">
          <PasteJson />
        </TabsContent>
      </Tabs>
    </>
  );
}

/** Whether a form holds values typed for "store as secret" that are not stored yet. */
function pendingSecrets(form: EntryForm): boolean {
  const rows = form.transport === 'stdio' ? form.env : form.headers;
  return (
    rows.some((row) => row.mode === 'new-secret' && row.value !== '') ||
    (form.transport === 'http' &&
      form.auth === 'oauth' &&
      form.oauthSecretMode === 'new-secret' &&
      form.oauthSecretValue !== '')
  );
}

/** The form's entry as JSON, keeping the stored entry's keys the form does not know. */
function jsonFromForm(form: EntryForm, stored: ServerEntry): string {
  const built = buildEntry(form, 'save').entry;
  // Keys the form owns come from the form (a cleared one disappears); the rest (disabledTools,
  // keys MCPier does not use) are kept as stored.
  const owned = [
    'name',
    'transport',
    'description',
    'icon',
    'command',
    'args',
    'env',
    'url',
    'headers',
    'auth',
    'oauth',
    'protocol',
    'timeoutMs',
    'startupTimeoutMs',
    'enabled',
  ];
  const kept = Object.fromEntries(
    Object.entries(stored as unknown as Record<string, unknown>).filter(([key]) => !owned.includes(key)),
  );
  return JSON.stringify({ ...built, ...kept }, null, 2);
}

function EditServer({ name, stored }: { name: string; stored: ServerEntry }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { notify } = useToast();
  const initialForm = useMemo(() => formFromEntry(stored), [stored]);
  const initialJson = useMemo(() => JSON.stringify(stored, null, 2), [stored]);
  const [form, setForm] = useState<EntryForm>(initialForm);
  const [json, setJson] = useState(initialJson);
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [switchProblem, setSwitchProblem] = useState<string | undefined>();
  const [moving, setMoving] = useState<{ location: 'env' | 'header'; key: string } | undefined>();
  const [savedJson, setSavedJson] = useState(initialJson);
  const formDirty =
    JSON.stringify(buildEntry(form, 'save').entry) !== JSON.stringify(buildEntry(initialForm, 'save').entry);
  const jsonDirty = json !== savedJson;
  useUnsavedGuard(tab === 'json' ? jsonDirty : formDirty || pendingSecrets(form));

  const save = useMutation({
    mutationFn: (current: EntryForm) => {
      const built = buildEntry(current, 'save');
      const { name: _name, ...fields } = built.entry;
      const patch: Record<string, unknown> = { ...fields };
      if (!current.description.trim()) patch.description = null;
      if (!current.icon.trim()) patch.icon = null;
      if (current.transport === 'http' && current.auth !== 'oauth') patch.auth = null;
      // A cleared OAuth client is removed from config.json.
      if (current.transport === 'http' && !('oauth' in fields)) patch.oauth = null;
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

  const switchTab = (next: string) => {
    setSwitchProblem(undefined);
    if (next === 'json' && tab === 'form') {
      if (pendingSecrets(form)) {
        setSwitchProblem('Save the form first: it has values waiting to be stored as secrets.');
        return;
      }
      if (formDirty) setJson(jsonFromForm(form, stored));
      setTab('json');
    } else if (next === 'form' && tab === 'json') {
      const analysis = analyzeEntryJson(json, name);
      if (!analysis.valid || !analysis.entry) {
        setSwitchProblem('The JSON has problems; fix them before going back to the form.');
        return;
      }
      setForm(formFromEntry(analysis.entry as unknown as ServerEntry));
      setTab('form');
    }
  };

  return (
    <>
      <PageTitle
        crumb={
          <>
            <Link to="/servers" className="hover:underline">
              Servers
            </Link>{' '}
            /{' '}
            <Link to={`/servers/${encodeURIComponent(name)}`} className="hover:underline">
              {name}
            </Link>{' '}
            / Edit
          </>
        }
        title={`Edit ${name}`}
        actions={
          <>
            <Button type="button" variant="outline" asChild>
              <Link to={`/servers/${encodeURIComponent(name)}`}>Cancel</Link>
            </Button>
            {tab === 'form' ? (
              <Button type="submit" form="server-form" disabled={save.isPending}>
                <CheckIcon aria-hidden="true" />
                Save changes
              </Button>
            ) : null}
          </>
        }
      />
      <Tabs value={tab} onValueChange={switchTab}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="form">Form</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          {switchProblem ? (
            <p role="alert" className="text-tone-bad-text m-0 text-sm">
              {switchProblem}
            </p>
          ) : null}
        </div>
        <RailGrid>
          <Stack>
            <TabsContent value="form" className="space-y-4">
              {save.error ? <ErrorMessage error={save.error} title="Could not save the server" /> : null}
              <ServerForm
                form={form}
                setForm={setForm}
                editing
                onSubmit={(current) => save.mutate(current)}
              />
            </TabsContent>
            <TabsContent value="json">
              <Panel>
                <PanelBody>
                  <ServerJson
                    name={name}
                    text={json}
                    onText={setJson}
                    onSaved={(entry) => {
                      setSavedJson(json);
                      setForm(formFromEntry(entry as unknown as ServerEntry));
                    }}
                    onMoveToSecret={setMoving}
                  />
                </PanelBody>
              </Panel>
            </TabsContent>
          </Stack>
          <Stack>
            <ConnectionTest
              entry={() =>
                tab === 'json' ? (analyzeEntryJson(json, name).entry ?? {}) : buildEntry(form, 'test').entry
              }
            />
            <SecretsNote />
          </Stack>
        </RailGrid>
      </Tabs>
      <MoveToSecretDialog server={name} target={moving} onClose={() => setMoving(undefined)} />
    </>
  );
}

export function EditServerPage() {
  const { name = '' } = useParams();
  const detail = useServer(name);
  if (detail.isPending) return <LoadingRows label="Loading the server" />;
  if (detail.error) return <ErrorMessage error={detail.error} title={`Cannot load ${name}`} />;
  return <EditServer key={name} name={name} stored={detail.data.config} />;
}
