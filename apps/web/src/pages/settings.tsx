import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTH_API_PATHS,
  AUTOSTART_API_PATH,
  DASHBOARD_API_PATHS,
  defaultConfig,
  type AutostartResponse,
  type CimdDocumentResponse,
  validateConfig,
  type Settings,
  type SettingsUpdateResponse,
} from '@mcpier/shared';
import { api } from '@/lib/api';
import { queryKeys, useSettings, useStatus } from '@/lib/queries';
import { CopyButton, ErrorMessage, formatTime, LoadingRows, PageHeader } from '@/components/common';
import { useToast } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/**
 * The client ID metadata document for the saved `cimdUrl` and the gateway's port, to publish
 * at that address (MCPier does not host it).
 */
function CimdDocumentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const document = useMutation({
    mutationFn: () => api.get<CimdDocumentResponse>(AUTH_API_PATHS.cimdDocument),
  });
  const { mutate } = document;
  useEffect(() => {
    if (open) mutate();
  }, [open, mutate]);
  const text = document.data ? JSON.stringify(document.data.document, null, 2) : '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Client ID metadata document</DialogTitle>
          <DialogDescription>
            Publish this JSON at the CIMD URL, served over https. Authorization servers that support client ID
            metadata documents read it to learn who MCPier is.
          </DialogDescription>
        </DialogHeader>
        {document.isPending ? <LoadingRows rows={4} label="Loading the document" /> : null}
        {document.error ? <ErrorMessage error={document.error} title="No document yet" /> : null}
        {document.data ? (
          <div className="space-y-2">
            <p className="text-sm">
              Publish at <span className="font-mono text-xs break-all">{document.data.url}</span>
            </p>
            <pre
              className="bg-muted max-h-80 overflow-auto rounded p-3 font-mono text-xs"
              data-testid="cimd-json"
            >
              {text}
            </pre>
            <p className="text-muted-foreground text-xs">
              Its redirect URI, {document.data.redirectUri}, uses the current port. Publish it again if the
              port changes. The CLI prints the same document: mcpier auth cimd-document
            </p>
          </div>
        ) : null}
        <DialogFooter>
          {document.data ? <CopyButton text={text} label="Copy the CIMD document" /> : null}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const WEIGHT_FIELDS = [
  ['name', 'Tool name'],
  ['title', 'Title'],
  ['description', 'Description'],
  ['parameterNames', 'Parameter names'],
  ['serverName', 'Server name'],
  ['serverDescription', 'Server description'],
] as const;

interface SettingsForm {
  port: string;
  extraPath: string[];
  resultSizeLimitKb: string;
  logRetentionDays: string;
  storeCallBodies: boolean;
  weights: Record<(typeof WEIGHT_FIELDS)[number][0], string>;
  cimdUrl: string;
}

function toForm(settings: Settings): SettingsForm {
  return {
    port: String(settings.port),
    extraPath: [...settings.extraPath],
    resultSizeLimitKb: String(settings.resultSizeLimitKb),
    logRetentionDays: String(settings.logRetentionDays),
    storeCallBodies: settings.storeCallBodies,
    weights: Object.fromEntries(
      WEIGHT_FIELDS.map(([key]) => [key, String(settings.searchWeights[key])]),
    ) as SettingsForm['weights'],
    cimdUrl: settings.cimdUrl ?? '',
  };
}

const number = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

/** The patch the gateway receives: every field, with an empty CIMD URL removed. */
export function settingsPatch(form: SettingsForm): Record<string, unknown> {
  return {
    port: number(form.port),
    extraPath: form.extraPath.map((path) => path.trim()).filter(Boolean),
    resultSizeLimitKb: number(form.resultSizeLimitKb),
    logRetentionDays: number(form.logRetentionDays),
    storeCallBodies: form.storeCallBodies,
    searchWeights: Object.fromEntries(WEIGHT_FIELDS.map(([key]) => [key, number(form.weights[key])])),
    cimdUrl: form.cimdUrl.trim() === '' ? null : form.cimdUrl.trim(),
  };
}

/** Problems from the shared schema, keyed by setting name. */
export function settingsProblems(current: Settings, form: SettingsForm): Map<string, string> {
  const patch = settingsPatch(form);
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (patch.cimdUrl === null) delete merged.cimdUrl;
  const result = validateConfig({ ...defaultConfig(), settings: merged });
  const problems = new Map<string, string>();
  if (!result.ok) {
    for (const problem of result.problems) {
      const match = /^settings\.([A-Za-z]+)(?:\.([A-Za-z]+))?(?:\[\d+\])?: (.*)$/.exec(problem);
      if (match) problems.set(match[2] ? `${match[1]}.${match[2]}` : match[1]!, match[3]!);
      else problems.set('_', problem);
    }
  }
  return problems;
}

function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
  problem,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  problem?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        value={value}
        aria-invalid={problem !== undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {label} {problem}.
        </p>
      ) : hint ? (
        <p className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const status = useStatus();
  const client = useQueryClient();
  const { notify } = useToast();
  const [form, setForm] = useState<SettingsForm | undefined>();
  const [showCimd, setShowCimd] = useState(false);
  useEffect(() => {
    if (settings.data && !form) setForm(toForm(settings.data.settings));
  }, [settings.data, form]);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<SettingsUpdateResponse>(DASHBOARD_API_PATHS.settings, patch),
    onSuccess: (response) => {
      client.setQueryData(queryKeys.settings, { settings: response.settings });
      setForm(toForm(response.settings));
      notify('success', 'Settings saved.', response.notes.join('\n') || undefined);
    },
  });

  if (settings.isPending || !form)
    return settings.error ? (
      <ErrorMessage error={settings.error} title="Cannot load the settings" />
    ) : (
      <LoadingRows label="Loading settings" />
    );
  const problems = settingsProblems(settings.data!.settings, form);
  const set = (change: Partial<SettingsForm>) => setForm({ ...form, ...change });

  return (
    <>
      <PageHeader title="Settings" description="Saved to config.json and applied at once, except the port." />
      <form
        className="space-y-8"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (problems.size === 0) save.mutate(settingsPatch(form));
        }}
      >
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumberField
            id="setting-port"
            label="Port"
            value={form.port}
            onChange={(port) => set({ port })}
            problem={problems.get('port')}
            hint="Takes effect after MCPier restarts; then update your clients (Connect page)."
          />
          <NumberField
            id="setting-result-size"
            label="Result size limit (KB)"
            value={form.resultSizeLimitKb}
            onChange={(resultSizeLimitKb) => set({ resultSizeLimitKb })}
            problem={problems.get('resultSizeLimitKb')}
            hint="Text results above this are cut, with a note."
          />
          <NumberField
            id="setting-retention"
            label="Log retention (days)"
            value={form.logRetentionDays}
            onChange={(logRetentionDays) => set({ logRetentionDays })}
            problem={problems.get('logRetentionDays')}
          />
          <div className="flex items-center gap-2 self-end pb-2">
            <Switch
              id="setting-bodies"
              checked={form.storeCallBodies}
              onCheckedChange={(storeCallBodies) => set({ storeCallBodies })}
            />
            <Label htmlFor="setting-bodies">Store call bodies in the call log</Label>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Extra PATH folders</h2>
          <p className="text-muted-foreground text-xs">
            Added to PATH for stdio servers. Changing them restarts those servers.
          </p>
          {form.extraPath.map((path, index) => (
            <div key={index} className="flex gap-2">
              <Input
                aria-label={`Extra PATH folder ${index + 1}`}
                value={path}
                onChange={(event) =>
                  set({
                    extraPath: form.extraPath.map((other, i) => (i === index ? event.target.value : other)),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => set({ extraPath: form.extraPath.filter((_, i) => i !== index) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set({ extraPath: [...form.extraPath, ''] })}
          >
            Add folder
          </Button>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Search weights</h2>
          <p className="text-muted-foreground text-xs">
            How much each field counts in search_tools (0 to 100).
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WEIGHT_FIELDS.map(([key, label]) => (
              <NumberField
                key={key}
                id={`weight-${key}`}
                label={label}
                value={form.weights[key]}
                onChange={(value) => set({ weights: { ...form.weights, [key]: value } })}
                problem={problems.get(`searchWeights.${key}`)}
              />
            ))}
          </div>
        </section>

        <section className="space-y-1.5">
          <Label htmlFor="setting-cimd">Client ID Metadata Document URL (optional)</Label>
          <Input
            id="setting-cimd"
            type="url"
            value={form.cimdUrl}
            aria-invalid={problems.has('cimdUrl')}
            onChange={(event) => set({ cimdUrl: event.target.value })}
          />
          {problems.get('cimdUrl') ? (
            <p className="text-destructive text-xs" role="alert">
              The URL {problems.get('cimdUrl')}.
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              An https:// URL where you publish MCPier's client ID metadata document. When it is set, OAuth
              servers that support such documents use it instead of registering MCPier.
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!settings.data?.settings.cimdUrl}
            onClick={() => setShowCimd(true)}
          >
            Show CIMD document
          </Button>
          <CimdDocumentDialog open={showCimd} onOpenChange={setShowCimd} />
        </section>

        {problems.get('_') ? <p className="text-destructive text-sm">{problems.get('_')}</p> : null}
        {save.error ? <ErrorMessage error={save.error} title="Could not save the settings" /> : null}
        <Button type="submit" disabled={problems.size > 0 || save.isPending}>
          Save settings
        </Button>
      </form>

      {status.data ? (
        <section className="mt-10 space-y-2">
          <h2 className="text-sm font-semibold">About this gateway</h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Version</dt>
            <dd>{status.data.version}</dd>
            <dt className="text-muted-foreground">Data directory</dt>
            <dd className="font-mono text-xs break-all">{status.data.dataDir}</dd>
            <dt className="text-muted-foreground">Process id</dt>
            <dd>{status.data.pid}</dd>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{formatTime(status.data.startedAt)}</dd>
            <dt className="text-muted-foreground">Listening on</dt>
            <dd>127.0.0.1:{status.data.port}</dd>
          </dl>
        </section>
      ) : null}
      <AutostartSection />
    </>
  );
}

/** Read-only: the logon task is created and removed with the CLI. */
function AutostartSection() {
  const autostart = useQuery({
    queryKey: ['autostart'],
    queryFn: () => api.get<AutostartResponse>(AUTOSTART_API_PATH),
  });
  const data = autostart.data;
  const status = data?.status;
  const missing = status?.paths?.filter((path) => !path.exists) ?? [];
  return (
    <section className="mt-10 space-y-2" aria-label="Start with Windows">
      <h2 className="text-sm font-semibold">Start with Windows</h2>
      {autostart.isPending ? <LoadingRows rows={1} label="Loading the autostart status" /> : null}
      {autostart.error ? (
        <p className="text-muted-foreground text-sm">
          The autostart status cannot be checked here. In a terminal:{' '}
          <code className="font-mono">mcpier autostart status</code>
        </p>
      ) : null}
      {status ? (
        <div
          className="space-y-2 text-sm"
          data-autostart={status.unknown ? 'unknown' : status.enabled ? 'on' : 'off'}
        >
          {status.unknown ? (
            <p className="text-muted-foreground">Could not check it: {status.detail}</p>
          ) : status.enabled ? (
            <p>
              On: MCPier starts, hidden, when you sign in to Windows (logon task{' '}
              <code className="font-mono">{status.taskName}</code>).
            </p>
          ) : (
            <p>Off: MCPier starts when you run it, or when a client starts the stdio bridge.</p>
          )}
          {missing.length > 0 ? (
            <p className="text-destructive">
              The task points at {missing.map((path) => path.path).join(' and ')}, which no longer{' '}
              {missing.length === 1 ? 'exists' : 'exist'}. Run the enable command again.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">To change it, run in a terminal:</span>
            <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
              {status.enabled ? data.commands.disable : data.commands.enable}
            </code>
            <CopyButton
              text={status.enabled ? data.commands.disable : data.commands.enable}
              label="Copy the autostart command"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
