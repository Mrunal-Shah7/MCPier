import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DASHBOARD_API_PATHS,
  looksSensitive,
  parseSecretRef,
  proposedSecretName,
  splitFullToolName,
  type MoveToSecretResponse,
  type ServerDetailResponse,
  type ServerSummary,
  type ToolInfo,
} from '@mcpier/shared';
import {
  EyeIcon,
  EyeOffIcon,
  FlaskConicalIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatMs } from '@/lib/call-log';
import { queryKeys, useServer } from '@/lib/queries';
import { useDeleteServer, useServerAction } from '@/lib/server-actions';
import { useToolToggle } from '@/lib/tool-toggle';
import { useRecentCalls, useUsage } from '@/lib/usage';
import { cn } from '@/lib/utils';
import { ConfirmDialog, CopyButton, ErrorMessage, formatDuration, LoadingRows } from '@/components/common';
import { ActivityTab } from '@/components/activity';
import { AuthorizationSection } from '@/components/authorization';
import { Sparkline } from '@/components/charts';
import { ErrorBlock } from '@/components/error-block';
import {
  Delta,
  EmptyLine,
  KeyValues,
  KpiCard,
  PageTitle,
  Panel,
  PanelBody,
  PanelHeader,
  RailGrid,
  Stack,
} from '@/components/kit';
import { ServerActionsMenu } from '@/components/server-actions-menu';
import { ServerTile } from '@/components/server-tile';
import { OutcomeBadge, SecretChip, StatusBadge, ToneBadge, TransportChip } from '@/components/status-badge';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ---- Overview

/** One env or header value: references as chips; credential-looking plain values masked. */
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
        <SecretChip name={parsed.name} prefix={parsed.prefix} />
      ) : sensitive && !revealed ? (
        <span className="text-muted-foreground font-mono text-xs" aria-label={`${name} is hidden`}>
          ••••••••
        </span>
      ) : (
        <span className="wrap-anywhere font-mono text-xs">{value}</span>
      )}
      {sensitive ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={revealed ? `Hide ${name}` : `Reveal ${name}`}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => onMove(location, name)}>
            Move to secret
          </Button>
          <span className="text-tone-warn-text text-xs">Plain text in config.json</span>
        </>
      ) : null}
    </li>
  );
}

export function MoveToSecretDialog({
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
            Stored in Windows Credential Manager; config.json gets a reference. The server restarts.
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

const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

function ConnectionPanel({ detail }: { detail: ServerDetailResponse }) {
  const { server, config } = detail;
  const [moving, setMoving] = useState<{ location: 'env' | 'header'; key: string } | undefined>();
  const values =
    config.transport === 'stdio'
      ? Object.entries(config.env).map(([key, value]) => ({ location: 'env' as const, key, value }))
      : Object.entries(config.headers).map(([key, value]) => ({ location: 'header' as const, key, value }));
  const valueList =
    values.length === 0 ? (
      <span className="text-faint">none</span>
    ) : (
      <ul className="m-0 list-none p-0">
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
    );
  const rows: [string, React.ReactNode][] =
    config.transport === 'stdio'
      ? [
          ['Command', <code className="font-mono text-xs">{config.command}</code>],
          [
            'Arguments',
            config.args.length === 0 ? (
              <span className="text-faint">none</span>
            ) : (
              <ol className="m-0 list-none space-y-0.5 p-0">
                {config.args.map((arg, index) => (
                  <li key={index} className="wrap-anywhere font-mono text-xs">
                    {arg}
                  </li>
                ))}
              </ol>
            ),
          ],
          ['Environment', valueList],
        ]
      : [
          ['URL', <code className="wrap-anywhere font-mono text-xs">{config.url}</code>],
          ['Sign-in', config.auth === 'oauth' ? 'OAuth' : 'None'],
          ['Headers', valueList],
        ];
  rows.push(
    [
      'Protocol',
      <>
        {config.protocol}
        {server.protocolVersion ? <span className="text-faint"> → {server.protocolVersion}</span> : null}
      </>,
    ],
    ['Timeouts', `${seconds(config.timeoutMs)} call · ${seconds(config.startupTimeoutMs)} start`],
    ['Uptime', server.status.state === 'ready' ? formatDuration(server.uptimeSeconds) : '—'],
  );
  if (config.disabledTools.length > 0) rows.push(['Disabled tools', config.disabledTools.join(', ')]);
  return (
    <Panel aria-label="Connection">
      <PanelHeader title="Connection" />
      <PanelBody>
        <KeyValues rows={rows} />
      </PanelBody>
      <MoveToSecretDialog server={server.name} target={moving} onClose={() => setMoving(undefined)} />
    </Panel>
  );
}

function QuickActions({ server }: { server: ServerSummary }) {
  const action = useServerAction();
  const navigate = useNavigate();
  const remove = useDeleteServer(() => void navigate('/servers'));
  const [confirming, setConfirming] = useState(false);
  const running = server.status.state !== 'stopped';
  return (
    <Panel aria-label="Quick actions">
      <PanelHeader title="Quick actions" />
      <PanelBody className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={`/tester?server=${encodeURIComponent(server.name)}`}>
            <FlaskConicalIcon aria-hidden="true" />
            Test a tool
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => action.mutate({ name: server.name, action: 'refresh' })}
        >
          <RefreshCwIcon aria-hidden="true" />
          Refresh tools
        </Button>
        {server.enabled ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => action.mutate({ name: server.name, action: running ? 'stop' : 'start' })}
          >
            {running ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
            {running ? 'Stop' : 'Start'}
          </Button>
        ) : null}
        <Button size="sm" variant="destructive-ghost" onClick={() => setConfirming(true)}>
          <Trash2Icon aria-hidden="true" />
          Delete
        </Button>
      </PanelBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${server.name}?`}
        description={<p>Stops it and removes it from MCPier. Secrets stay in Credential Manager.</p>}
        confirmLabel={`Delete ${server.name}`}
        onConfirm={() => remove.mutate(server.name)}
      />
    </Panel>
  );
}

function OverviewRail({ server }: { server: ServerSummary }) {
  const week = useUsage({ range: '7d', server: server.name });
  const recent = useRecentCalls(server.name);
  const totals = week.data?.totals;
  return (
    <Stack>
      <KpiCard
        label="Calls · 7 days"
        value={totals ? totals.calls.toLocaleString() : '—'}
        delta={totals ? <Delta current={totals.calls} previous={week.data!.previous.calls} /> : undefined}
        chart={
          <Sparkline
            values={week.data?.series.map((point) => point.calls) ?? []}
            label="Calls per day, last 7 days"
          />
        }
      />
      <QuickActions server={server} />
      <Panel aria-label="Recent calls">
        <PanelHeader
          title="Recent calls"
          actions={
            <Link to={`?tab=activity`} className="text-faint text-xs hover:underline">
              Activity →
            </Link>
          }
        />
        {recent.data && recent.data.calls.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {recent.data.calls.map((call) => (
              <li key={call.id} className="flex items-center gap-2.5 border-b px-3.5 py-2 last:border-b-0">
                <Link to={`?tab=activity&call=${call.id}`} className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">
                    {splitFullToolName(call.tool)?.tool ?? call.tool}
                  </div>
                  <div className="text-faint truncate text-xs">
                    {call.client.name ?? 'unknown client'} · {new Date(call.at).toLocaleTimeString()} ·{' '}
                    {formatMs(call.durationMs)}
                  </div>
                </Link>
                <OutcomeBadge outcome={call.outcome} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground px-3.5 py-3 text-sm">No calls yet.</p>
        )}
      </Panel>
    </Stack>
  );
}

function Overview({ detail }: { detail: ServerDetailResponse }) {
  const { server, config } = detail;
  return (
    <RailGrid>
      <Stack>
        <ConnectionPanel detail={detail} />
        {config.transport === 'http' && config.auth === 'oauth' ? (
          <AuthorizationSection server={server.name} />
        ) : null}
      </Stack>
      <OverviewRail server={server} />
    </RailGrid>
  );
}

// ---- Tools

function HintBadges({ tool }: { tool: ToolInfo }) {
  return (
    <>
      {tool.readOnlyHint ? (
        <ToneBadge tone="info" dot={false}>
          read-only
        </ToneBadge>
      ) : null}
      {tool.destructiveHint ? (
        <ToneBadge tone="bad" dot={false}>
          destructive
        </ToneBadge>
      ) : null}
      {tool.flag ? (
        <ToneBadge tone="warn" dot={false} className="cursor-help" data-flag={tool.flag}>
          <span title={tool.flag}>flagged name</span>
        </ToneBadge>
      ) : null}
      {!tool.available ? (
        <ToneBadge tone="off" dot={false}>
          unavailable
        </ToneBadge>
      ) : null}
    </>
  );
}

function SchemaBlock({ title, schema }: { title: string; schema: Record<string, unknown> | undefined }) {
  if (!schema) return null;
  const text = JSON.stringify(schema, null, 2);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        <span className="flex-1" />
        <CopyButton text={text} label={`Copy the ${title.toLowerCase()}`} />
      </div>
      <pre className="wrap-anywhere bg-panel-2 max-h-96 overflow-y-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

function ToolsTab({
  tools,
  focus,
  onFocus,
}: {
  tools: ToolInfo[];
  focus: string | null;
  onFocus: (name: string) => void;
}) {
  const toggle = useToolToggle();
  const [filter, setFilter] = useState('');
  if (tools.length === 0) {
    return (
      <Panel>
        <EmptyLine>No tools yet. They appear once the server is ready.</EmptyLine>
      </Panel>
    );
  }
  const query = filter.trim().toLowerCase();
  const shown = tools.filter(
    (tool) =>
      !query ||
      tool.name.toLowerCase().includes(query) ||
      (tool.description ?? '').toLowerCase().includes(query),
  );
  const selected = tools.find((tool) => tool.name === focus) ?? shown[0] ?? tools[0]!;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Panel aria-label="Tool list" className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
          <Label htmlFor="tool-filter" className="sr-only">
            Filter tools
          </Label>
          <Input
            id="tool-filter"
            className="h-8"
            placeholder="Filter tools"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className="text-faint text-xs whitespace-nowrap">
            {tools.filter((tool) => tool.enabled).length} on
          </span>
        </div>
        <ul className="m-0 max-h-[640px] list-none overflow-y-auto p-0">
          {shown.map((tool) => (
            <li
              key={tool.fullName}
              data-tool={tool.fullName}
              className={cn(
                'flex items-center gap-2.5 border-b px-3.5 py-2.5 last:border-b-0',
                tool.name === selected.name ? 'bg-brand-soft' : 'hover:bg-panel-2',
              )}
            >
              <button
                type="button"
                aria-current={tool.name === selected.name ? 'true' : undefined}
                className="min-w-0 flex-1 text-left"
                onClick={() => onFocus(tool.name)}
              >
                <code className="block truncate text-[12.5px]">{tool.name}</code>
                {tool.title || tool.description ? (
                  <span className="text-faint block truncate text-xs" title={tool.description ?? tool.title}>
                    {tool.title ?? tool.description}
                  </span>
                ) : null}
              </button>
              <span className="flex shrink-0 items-center gap-1.5">
                <HintBadges tool={tool} />
              </span>
              <Switch
                aria-label={`${tool.enabled ? 'Disable' : 'Enable'} ${tool.fullName}`}
                checked={tool.enabled}
                disabled={toggle.isPending}
                onCheckedChange={(enable) => toggle.mutate({ fullName: tool.fullName, enable })}
              />
            </li>
          ))}
          {shown.length === 0 ? (
            <li className="text-muted-foreground px-3.5 py-3 text-sm">No tools match.</li>
          ) : null}
        </ul>
      </Panel>
      <Panel aria-label="Tool detail" id={`tool-${selected.name}`}>
        <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-mono font-semibold">{selected.name}</div>
            {selected.title ? <div className="text-faint text-xs">{selected.title}</div> : null}
          </div>
          <span className="flex-1" />
          <HintBadges tool={selected} />
          <Button asChild size="sm">
            <Link to={`/tester?tool=${encodeURIComponent(selected.fullName)}`}>
              <PlayIcon aria-hidden="true" />
              Try in Tester
            </Link>
          </Button>
        </div>
        <PanelBody className="space-y-4">
          {selected.description ? (
            <p className="text-muted-foreground wrap-anywhere m-0 text-sm whitespace-pre-line">
              {selected.description}
            </p>
          ) : null}
          {selected.flag ? <p className="text-tone-warn-text m-0 text-xs">{selected.flag}</p> : null}
          <SchemaBlock title="Input schema" schema={selected.inputSchema} />
          <SchemaBlock title="Output schema" schema={selected.outputSchema} />
        </PanelBody>
      </Panel>
    </div>
  );
}

// ---- Page

const TABS = ['overview', 'tools', 'activity'] as const;

export function ServerDetailPage() {
  const { name = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const detail = useServer(name);
  const navigate = useNavigate();
  const action = useServerAction();
  const focusTool = search.get('tool');
  const requested = search.get('tab');

  // The Logs tab became Activity (Sprint 7): old links still land in the right place.
  if (requested === 'logs') {
    const next = new URLSearchParams(search);
    next.set('tab', 'activity');
    return <Navigate to={`${location.pathname}?${next}`} replace />;
  }
  const tab = (TABS as readonly string[]).includes(requested ?? '')
    ? requested!
    : focusTool
      ? 'tools'
      : 'overview';
  const callText = search.get('call');
  const selectedCall = callText && /^\d+$/.test(callText) ? Number(callText) : undefined;

  if (detail.isPending) return <LoadingRows label={`Loading ${name}`} />;
  if (detail.error) return <ErrorMessage error={detail.error} title={`Cannot load ${name}`} />;
  const { server } = detail.data;
  const failing = server.status.state === 'error' || server.status.state === 'crashed';
  const running = server.status.state !== 'stopped';

  return (
    <>
      <PageTitle
        crumb={
          <>
            <Link to="/servers" className="hover:underline">
              Servers
            </Link>{' '}
            / {server.name}
          </>
        }
        leading={<ServerTile name={server.name} icon={server.icon} size="lg" />}
        title={server.name}
        info={server.description}
        meta={
          <>
            <StatusBadge state={server.status.state} />
            {!server.enabled ? <span className="text-faint text-xs">disabled</span> : null}
            <TransportChip transport={server.transport} />
            {server.protocolVersion ? (
              <span className="text-faint font-mono text-xs">{server.protocolVersion}</span>
            ) : null}
          </>
        }
        actions={
          <>
            {server.enabled && running ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => action.mutate({ name: server.name, action: 'restart' })}
              >
                <RefreshCwIcon aria-hidden="true" />
                Restart
              </Button>
            ) : null}
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
      {server.status.detail && server.status.state !== 'ready' ? (
        failing ? (
          <ErrorBlock
            className="mb-4"
            message={server.status.detailMessage ?? server.status.detail}
            raw={server.status.detail}
          />
        ) : (
          <p className="text-muted-foreground wrap-anywhere mb-4 text-sm whitespace-pre-line" role="note">
            {server.status.detailMessage ?? server.status.detail}
          </p>
        )
      ) : null}
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value }, { replace: true })}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tools">
            Tools <span className="text-faint text-[11px]">{detail.data.tools.length}</span>
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview detail={detail.data} />
        </TabsContent>
        <TabsContent value="tools">
          <ToolsTab
            tools={detail.data.tools}
            focus={focusTool}
            onFocus={(tool) => setSearch({ tab: 'tools', tool }, { replace: true })}
          />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab
            server={server.name}
            selected={selectedCall}
            onSelect={(id) =>
              setSearch(id === undefined ? { tab: 'activity' } : { tab: 'activity', call: String(id) }, {
                replace: true,
              })
            }
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
