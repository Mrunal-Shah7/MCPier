import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  API_PATHS,
  DASHBOARD_API_PATHS,
  looksSensitive,
  parseSecretRef,
  proposedSecretName,
  type MoveToSecretResponse,
  type ServerDetailResponse,
  type ServerLogResponse,
  type ToolInfo,
} from '@mcpier/shared';
import { ChevronRightIcon, EyeIcon, EyeOffIcon, PencilIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { queryKeys, useServer } from '@/lib/queries';
import { readSse } from '@/lib/sse';
import { useToolToggle } from '@/lib/tool-toggle';
import { ErrorMessage, formatDuration, formatTime, LoadingRows, PageHeader } from '@/components/common';
import { AuthorizationSection } from '@/components/authorization';
import { ServerActionsMenu } from '@/components/server-actions-menu';
import { StatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toaster';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ---- Overview

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/** One env or header value: references as references; credential-looking plain values masked. */
function ValueLine({
  location,
  name,
  value,
  onMove,
}: {
  location: 'env' | 'header';
  name: string;
  value: string;
  onMove: (location: 'env' | 'header', key: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const parsed = parseSecretRef(value, location);
  const sensitive = parsed.kind !== 'secret' && looksSensitive(location, name);
  return (
    <li className="flex flex-wrap items-center gap-2 py-1" data-value={name}>
      <span className="font-mono text-xs">{name}</span>
      {parsed.kind === 'secret' ? (
        <Badge variant="secondary" className="font-mono">
          {parsed.prefix}secret:{parsed.name}
        </Badge>
      ) : sensitive && !revealed ? (
        <span className="text-muted-foreground font-mono text-xs" aria-label={`${name} is hidden`}>
          ••••••••
        </span>
      ) : (
        <span className="font-mono text-xs break-all">{value}</span>
      )}
      {sensitive ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={revealed ? `Hide ${name}` : `Reveal ${name}`}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onMove(location, name)}>
            Move to secret
          </Button>
          <span className="text-muted-foreground text-xs">Stored as plain text in config.json.</span>
        </>
      ) : null}
    </li>
  );
}

function MoveToSecretDialog({
  server,
  target,
  onClose,
}: {
  server: string;
  target: { location: 'env' | 'header'; key: string } | undefined;
  onClose: () => void;
}) {
  const [secretName, setSecretName] = useState('');
  const client = useQueryClient();
  const { notify } = useToast();
  useEffect(() => {
    if (target) setSecretName(proposedSecretName(server, target.key));
  }, [server, target]);
  const move = useMutation({
    // Only names travel: the gateway reads the value from config.json itself.
    mutationFn: () =>
      api.post<MoveToSecretResponse>(DASHBOARD_API_PATHS.moveToSecret(server), {
        location: target!.location,
        key: target!.key,
        secretName,
      }),
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: queryKeys.server(server) });
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      notify(
        'success',
        `${target!.key} now uses the secret ${response.secret}.`,
        `config.json holds ${response.reference}.`,
      );
      onClose();
    },
  });
  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {target?.key} to a secret</DialogTitle>
          <DialogDescription>
            MCPier stores the value in Windows Credential Manager and puts a reference in config.json. The
            server restarts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="move-secret-name">Secret name</Label>
          <Input
            id="move-secret-name"
            value={secretName}
            onChange={(event) => setSecretName(event.target.value)}
          />
        </div>
        {move.error ? <ErrorMessage error={move.error} title="Could not move the value" /> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!secretName || move.isPending} onClick={() => move.mutate()}>
            Move to secret
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Overview({ detail }: { detail: ServerDetailResponse }) {
  const { server, config } = detail;
  const [moving, setMoving] = useState<{ location: 'env' | 'header'; key: string } | undefined>();
  const values =
    config.transport === 'stdio'
      ? Object.entries(config.env).map(([key, value]) => ({ location: 'env' as const, key, value }))
      : Object.entries(config.headers).map(([key, value]) => ({ location: 'header' as const, key, value }));

  return (
    <div className="space-y-6">
      {config.transport === 'http' && config.auth === 'oauth' ? (
        <AuthorizationSection server={server.name} />
      ) : null}
      <dl className="divide-y rounded-md border px-4">
        <Row label="Status">
          <StatusBadge state={server.status.state} />{' '}
          <span className="text-muted-foreground ml-2 text-xs">since {formatTime(server.status.since)}</span>
          {server.status.detail ? <p className="mt-1 whitespace-pre-line">{server.status.detail}</p> : null}
        </Row>
        <Row label="Enabled">{server.enabled ? 'Yes' : 'No'}</Row>
        <Row label="Transport">{server.transport}</Row>
        <Row label="Protocol">{server.protocolVersion ?? '—'}</Row>
        <Row label="Uptime">
          {server.status.state === 'ready' ? formatDuration(server.uptimeSeconds) : '—'}
        </Row>
        <Row label="Tools">
          {server.tools.enabled} enabled of {server.tools.total}
        </Row>
      </dl>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Configuration</h2>
        <dl className="divide-y rounded-md border px-4">
          {config.transport === 'stdio' ? (
            <>
              <Row label="Command">
                <code className="font-mono text-xs">{config.command}</code>
              </Row>
              <Row label="Arguments">
                {config.args.length === 0 ? (
                  '—'
                ) : (
                  <ol className="space-y-0.5">
                    {config.args.map((arg, index) => (
                      <li key={index} className="font-mono text-xs break-all">
                        {arg}
                      </li>
                    ))}
                  </ol>
                )}
              </Row>
            </>
          ) : (
            <>
              <Row label="URL">
                <code className="font-mono text-xs break-all">{config.url}</code>
              </Row>
              <Row label="Sign-in">{config.auth === 'oauth' ? 'OAuth' : 'None'}</Row>
            </>
          )}
          <Row label={config.transport === 'stdio' ? 'Environment' : 'Headers'}>
            {values.length === 0 ? (
              '—'
            ) : (
              <ul>
                {values.map((value) => (
                  <ValueLine
                    key={`${value.location}:${value.key}`}
                    location={value.location}
                    name={value.key}
                    value={value.value}
                    onMove={(location, key) => setMoving({ location, key })}
                  />
                ))}
              </ul>
            )}
          </Row>
          <Row label="Protocol mode">{config.protocol}</Row>
          <Row label="Timeouts">
            call {config.timeoutMs} ms, startup {config.startupTimeoutMs} ms
          </Row>
          {config.disabledTools.length > 0 ? (
            <Row label="Disabled tools">{config.disabledTools.join(', ')}</Row>
          ) : null}
        </dl>
      </section>
      <MoveToSecretDialog server={server.name} target={moving} onClose={() => setMoving(undefined)} />
    </div>
  );
}

// ---- Tools

function SchemaBlock({ title, schema }: { title: string; schema: Record<string, unknown> | undefined }) {
  if (!schema) return null;
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-xs font-medium">{title}</p>
      <pre className="bg-muted max-h-80 overflow-auto rounded p-2 font-mono text-xs">
        {JSON.stringify(schema, null, 2)}
      </pre>
    </div>
  );
}

function ToolRow({ tool, open }: { tool: ToolInfo; open: boolean }) {
  const toggle = useToolToggle();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'center' });
  }, [open]);
  return (
    <Collapsible defaultOpen={open}>
      <div ref={ref} id={`tool-${tool.name}`} className="rounded-md border p-3" data-tool={tool.fullName}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-2 text-left">
            <ChevronRightIcon
              className="mt-0.5 size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="font-mono text-sm font-medium">{tool.name}</span>
              {tool.title ? <span className="text-muted-foreground ml-2 text-sm">{tool.title}</span> : null}
              {tool.description ? (
                <span className="text-muted-foreground mt-0.5 block text-xs">{tool.description}</span>
              ) : null}
            </span>
          </CollapsibleTrigger>
          <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
            {tool.readOnlyHint ? <Badge variant="secondary">read-only</Badge> : null}
            {tool.destructiveHint ? <Badge variant="destructive">destructive</Badge> : null}
            {tool.flag ? (
              <Badge variant="outline" title={tool.flag}>
                flagged name
              </Badge>
            ) : null}
            {!tool.available ? <Badge variant="outline">unavailable</Badge> : null}
            <Switch
              aria-label={`${tool.enabled ? 'Disable' : 'Enable'} ${tool.fullName}`}
              checked={tool.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enable) => toggle.mutate({ fullName: tool.fullName, enable })}
            />
          </div>
        </div>
        <CollapsibleContent className="mt-3 space-y-3">
          {tool.flag ? <p className="text-muted-foreground text-xs">{tool.flag}</p> : null}
          <SchemaBlock title="Input schema" schema={tool.inputSchema} />
          <SchemaBlock title="Output schema" schema={tool.outputSchema} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ToolsTab({ tools, focus }: { tools: ToolInfo[]; focus: string | null }) {
  if (tools.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No tools listed yet. They appear once the server is ready.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {tools.map((tool) => (
        <ToolRow key={tool.fullName} tool={tool} open={focus === tool.name} />
      ))}
    </div>
  );
}

// ---- Logs

const MAX_LINES = 2000;

export function LogsPanel({ server }: { server: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<unknown>();
  const pausedRef = useRef(false);
  const held = useRef<string[]>([]);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    void (async () => {
      try {
        const recent = await api.get<ServerLogResponse>(`${API_PATHS.serverLogs(server)}?lines=200`, {
          signal: controller.signal,
        });
        setLines(recent.lines);
        await readSse(
          API_PATHS.serverLogStream(server),
          (event, data) => {
            if (event !== 'line') return;
            if (pausedRef.current) held.current.push(data);
            else setLines((current) => [...current, data].slice(-MAX_LINES));
          },
          controller.signal,
        );
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught);
      }
    })();
    return () => controller.abort();
  }, [server]);

  // Follow new lines unless the reader scrolled up.
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next && held.current.length > 0) {
      const add = held.current.splice(0);
      setLines((current) => [...current, ...add].slice(-MAX_LINES));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={togglePause}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setLines([])}>
          Clear view
        </Button>
        <span className="text-muted-foreground text-xs">
          {paused ? 'Paused: new lines are held.' : 'Live.'}
        </span>
      </div>
      {error ? <ErrorMessage error={error} title="The log stream stopped" /> : null}
      <pre
        ref={box}
        aria-label={`${server} log`}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="bg-muted h-96 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {lines.length === 0 ? 'No log lines yet.' : lines.join('\n')}
      </pre>
    </div>
  );
}

// ---- Page

export function ServerDetailPage() {
  const { name = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const detail = useServer(name);
  const navigate = useNavigate();
  const focusTool = search.get('tool');
  const tab = search.get('tab') ?? (focusTool ? 'tools' : 'overview');

  if (detail.isPending) return <LoadingRows label={`Loading ${name}`} />;
  if (detail.error) return <ErrorMessage error={detail.error} title={`Cannot load ${name}`} />;
  const { server } = detail.data;

  return (
    <>
      <PageHeader
        title={server.name}
        description={server.description}
        actions={
          <>
            <StatusBadge state={server.status.state} className="self-center" />
            <Button variant="outline" size="sm" asChild>
              <Link to={`/servers/${encodeURIComponent(server.name)}/edit`}>
                <PencilIcon aria-hidden="true" />
                Edit
              </Link>
            </Button>
            <ServerActionsMenu server={server} withRefresh onDeleted={() => void navigate('/servers')} />
          </>
        }
      />
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tools">Tools ({detail.data.tools.length})</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <Overview detail={detail.data} />
        </TabsContent>
        <TabsContent value="tools" className="mt-4">
          <ToolsTab tools={detail.data.tools} focus={focusTool} />
        </TabsContent>
        <TabsContent value="logs" className="mt-4">
          <LogsPanel server={server.name} />
        </TabsContent>
      </Tabs>
    </>
  );
}
