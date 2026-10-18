import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PlayIcon, SearchIcon } from 'lucide-react';
import {
  API_PATHS,
  type ArgumentProblem,
  type TesterCallResponse,
  type TesterMode,
  type ToolInfo,
  type ToolSearchResponse,
  type ValidateArgumentsResponse,
} from '@mcpier/shared';
import { api } from '@/lib/api';
import { formatMs } from '@/lib/call-log';
import { useServers, useTools } from '@/lib/queries';
import { readElicitationSchema, readInputSchema, type Field } from '@/lib/schema-form';
import {
  findRun,
  inputRequiredOf,
  recordRun,
  runTester,
  useTesterHistory,
  validateArguments,
  type ElicitationAnswer,
  type InputRequest,
  type TesterRun,
} from '@/lib/tester';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@mcpier/shared';
import { ErrorBlock } from '@/components/error-block';
import { InfoTip, PageTitle, Panel } from '@/components/kit';
import { ServerTile } from '@/components/server-tile';
import { ToneBadge } from '@/components/status-badge';
import { EmptyState, ErrorMessage, formatTime, LoadingRows } from '@/components/common';
import { JsonEditor, SchemaForm } from '@/components/schema-form';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { OutcomeBadge } from '@/pages/call-log';

/** What the Call log (or the history) hands over when it opens a tool here. */
interface TesterLocationState {
  arguments?: Record<string, unknown>;
  runId?: number;
}

// ---- Picking a tool

function ToolPicker({ onPick }: { onPick: (fullName: string) => void }) {
  const [params] = useSearchParams();
  const server = params.get('server') ?? undefined;
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const search = useQuery({
    queryKey: ['tester-search', query, server],
    // With a server (from its page), an empty query lists that server's tools.
    enabled: query !== '' || server !== undefined,
    queryFn: () =>
      api.get<ToolSearchResponse>(
        `${API_PATHS.toolSearch}?${new URLSearchParams({ q: query, limit: server ? '20' : '10', ...(server ? { server } : {}) })}`,
      ),
  });
  return (
    <section aria-label="Pick a tool" className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="tester-search">Find a tool</Label>
        <div className="relative max-w-xl">
          <SearchIcon
            aria-hidden="true"
            className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            id="tester-search"
            type="search"
            className="pl-8"
            placeholder="read file"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </div>
      {search.error ? <ErrorMessage error={search.error} title="Search failed" /> : null}
      {search.data ? (
        search.data.results.length === 0 ? (
          <p className="text-muted-foreground text-sm">No tools match "{search.data.query}".</p>
        ) : (
          <ul className="space-y-1" aria-label="Matching tools">
            {search.data.results.map((match) => (
              <li key={match.name}>
                <button
                  type="button"
                  className="hover:bg-accent w-full rounded-md border px-3 py-2 text-left"
                  onClick={() => onPick(match.name)}
                >
                  <span className="font-mono text-sm font-medium">{match.name}</span>
                  {match.available ? null : (
                    <span className="text-muted-foreground ml-2 text-xs">(unavailable)</span>
                  )}
                  {match.description ? (
                    <span className="text-muted-foreground mt-0.5 block text-xs">{match.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

// ---- Results

/** Draws an image block on a canvas: the dashboard's policy allows no data: or blob: images. */
function ImageBlock({ data, mimeType }: { data: string; mimeType: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const bytes = Math.floor((data.length * 3) / 4);
  useEffect(() => {
    let cancelled = false;
    if (typeof createImageBitmap !== 'function') {
      setFailed(true);
      return;
    }
    try {
      const binary = atob(data);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      void createImageBitmap(new Blob([array], { type: mimeType }))
        .then((bitmap) => {
          if (cancelled || !canvas.current) return;
          canvas.current.width = bitmap.width;
          canvas.current.height = bitmap.height;
          canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0);
        })
        .catch(() => !cancelled && setFailed(true));
    } catch {
      setFailed(true);
    }
    return () => {
      cancelled = true;
    };
  }, [data, mimeType]);
  if (failed) {
    return (
      <p className="text-muted-foreground text-sm" data-block="image">
        Image ({mimeType}, about {bytes} bytes) that cannot be shown here.
      </p>
    );
  }
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={`Image (${mimeType})`}
      data-block="image"
      className="h-auto max-w-full rounded-md border"
    />
  );
}

interface ContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

function Block({ block }: { block: ContentBlock }) {
  if (block.type === 'text') {
    return (
      <pre
        data-block="text"
        className="bg-muted overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-words"
      >
        {block.text}
      </pre>
    );
  }
  if (block.type === 'image' && typeof block.data === 'string') {
    return <ImageBlock data={block.data} mimeType={block.mimeType ?? 'image/png'} />;
  }
  if (block.type === 'audio') {
    return (
      <p className="text-muted-foreground text-sm" data-block="audio">
        Audio ({block.mimeType ?? 'unknown type'}, about {Math.floor(((block.data ?? '').length * 3) / 4)}{' '}
        bytes).
      </p>
    );
  }
  if (block.type === 'resource_link') {
    return (
      <p className="text-sm" data-block="resource_link">
        Link to a resource: <span className="font-mono text-xs break-all">{block.uri}</span>
        {block.name ? ` (${block.name})` : ''}
      </p>
    );
  }
  if (block.type === 'resource' && block.resource) {
    return (
      <div className="space-y-1" data-block="resource">
        <p className="text-sm">
          Embedded resource <span className="font-mono text-xs break-all">{block.resource.uri}</span>
          {block.resource.mimeType ? ` (${block.resource.mimeType})` : ''}
        </p>
        {typeof block.resource.text === 'string' ? (
          <pre className="wrap-anywhere bg-panel-2 max-h-96 overflow-y-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
            {block.resource.text}
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs">Binary content, not shown.</p>
        )}
      </div>
    );
  }
  return (
    <p className="text-muted-foreground text-sm" data-block="other">
      A {block.type ?? 'unknown'} block.
    </p>
  );
}

function ResultView({ response }: { response: TesterCallResponse }) {
  const result = response.result as
    | { content?: ContentBlock[]; structuredContent?: unknown; isError?: boolean; resultType?: string }
    | undefined;
  // A tool error's first text block is shown as its clean message, the raw text one click away.
  const errorIndex = result?.isError
    ? (result.content ?? []).findIndex((block) => block.type === 'text')
    : -1;
  const errorText = errorIndex >= 0 ? (result!.content![errorIndex]!.text ?? '') : undefined;
  return (
    <section
      aria-label="Result"
      className="bg-card min-w-0 space-y-3 rounded-[10px] border p-3.5 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-3 border-b pb-2.5 text-sm">
        <h2 className="text-[13px] font-semibold">Result</h2>
        <span className="flex-1" />
        <OutcomeBadge outcome={response.outcome} />
        <span className="text-faint text-xs">{formatMs(response.durationMs)}</span>
        <span className="text-faint text-xs">
          {response.mode === 'model' ? 'As the model sees it' : 'Raw'}
        </span>
      </div>
      {errorText !== undefined ? (
        <ErrorBlock
          message={cleanErrorMessage(errorText).message}
          raw={errorText}
          code={cleanErrorMessage(errorText).code}
        />
      ) : null}
      {response.truncation ? (
        <p className="text-sm" role="note">
          Cut to the result size limit (the <code>resultSizeLimitKb</code> setting)
          {response.truncation.text
            ? `: ${response.truncation.text.shownBytes} bytes of text shown, ${response.truncation.text.droppedBytes} dropped`
            : ''}
          {response.truncation.structuredDroppedBytes !== undefined
            ? `; structured content of ${response.truncation.structuredDroppedBytes} bytes dropped`
            : ''}
          . A model gets exactly this.
        </p>
      ) : null}
      {response.error ? (
        <ErrorBlock message={cleanErrorMessage(response.error).message} raw={response.error} />
      ) : null}
      {result?.resultType === 'input_required' && response.mode === 'raw' ? (
        <p className="text-muted-foreground text-sm">
          The server asked for input. Raw mode cannot answer it; run the tool as the model sees it to answer.
        </p>
      ) : null}
      {result?.content?.map((block, index) =>
        index === errorIndex ? null : <Block key={index} block={block} />,
      )}
      {result?.structuredContent !== undefined ? (
        <div>
          <h3 className="mb-1 text-sm font-medium">Structured content</h3>
          <pre
            aria-label="Structured content"
            className="wrap-anywhere bg-panel-2 max-h-96 overflow-y-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
          >
            {JSON.stringify(result.structuredContent, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

// ---- Elicitation

function ElicitationRequest({
  id,
  request,
  answered,
  onAnswer,
}: {
  id: string;
  request: InputRequest;
  answered?: ElicitationAnswer;
  onAnswer: (answer: ElicitationAnswer) => void;
}) {
  const message = typeof request.params?.message === 'string' ? request.params.message : undefined;
  const isForm = request.method === 'elicitation/create' && (request.params?.mode ?? 'form') === 'form';
  const schema = isForm ? readElicitationSchema(request.params?.requestedSchema) : undefined;
  const [value, setValue] = useState<Record<string, unknown>>({});
  const field: Field | undefined = schema ? { kind: 'object', properties: schema.properties } : undefined;
  return (
    <section
      aria-label={`Input request ${id}`}
      className="space-y-3 rounded-md border border-sky-500/40 p-4"
      data-request={id}
    >
      <h3 className="text-sm font-semibold">The server asks{message ? ':' : ' for input'}</h3>
      {message ? <p className="text-sm whitespace-pre-line">{message}</p> : null}
      {field ? (
        <SchemaForm field={field} value={value} onChange={setValue} />
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm" role="note">
            The Tester cannot answer this request (
            {isForm
              ? 'its form uses fields the Tester does not draw'
              : (request.method ?? 'an unknown request')}
            {request.params?.mode && request.params.mode !== 'form' ? `, mode ${request.params.mode}` : ''}).
            You can decline or cancel it.
          </p>
          <pre className="wrap-anywhere bg-panel-2 max-h-96 overflow-y-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(request, null, 2)}
          </pre>
        </div>
      )}
      {answered ? (
        <p className="text-muted-foreground text-sm">Answered: {answered.action}.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {field ? (
            <Button type="button" onClick={() => onAnswer({ action: 'accept', content: value })}>
              Accept
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onAnswer({ action: 'decline' })}>
            Decline
          </Button>
          <Button type="button" variant="ghost" onClick={() => onAnswer({ action: 'cancel' })}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}

function Elicitation({
  requests,
  onComplete,
}: {
  requests: Record<string, InputRequest>;
  onComplete: (answers: Record<string, ElicitationAnswer>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, ElicitationAnswer>>({});
  const keys = Object.keys(requests);
  return (
    <div className="space-y-3" aria-label="Input requests" role="group">
      {keys.map((key) => (
        <ElicitationRequest
          key={key}
          id={key}
          request={requests[key]!}
          answered={answers[key]}
          onAnswer={(answer) => {
            const next = { ...answers, [key]: answer };
            setAnswers(next);
            // Every request answered: send them all with the state.
            if (keys.every((name) => next[name] !== undefined)) onComplete(next);
          }}
        />
      ))}
    </div>
  );
}

// ---- One tool

function useLiveValidation(tool: string, args: Record<string, unknown>, enabled: boolean) {
  const [answer, setAnswer] = useState<ValidateArgumentsResponse | undefined>();
  const [failed, setFailed] = useState<unknown>();
  const text = JSON.stringify(args);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const timer = setTimeout(() => {
      validateArguments(tool, JSON.parse(text) as Record<string, unknown>)
        .then((result) => {
          if (!current) return;
          setAnswer(result);
          setFailed(undefined);
        })
        .catch((error: unknown) => current && setFailed(error));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [tool, text, enabled]);
  return { answer, failed };
}

function ValidationSummary({ answer }: { answer: ValidateArgumentsResponse | undefined }) {
  if (!answer) return null;
  if (answer.result === 'valid') {
    return (
      <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status" aria-label="Validation">
        The arguments match the input schema.
      </p>
    );
  }
  if (answer.result === 'not_validated') {
    return (
      <p className="text-muted-foreground text-sm" role="status" aria-label="Validation">
        Not validated: {answer.reason}. call_tool does not validate this tool's arguments either.
      </p>
    );
  }
  return (
    <p className="text-tone-bad-text text-sm" role="status" aria-label="Validation">
      {answer.problems.length === 1 ? '1 problem' : `${answer.problems.length} problems`} with the arguments.
    </p>
  );
}

function History({ onShow }: { onShow: (run: TesterRun) => void }) {
  const runs = useTesterHistory();
  return (
    <section
      aria-label="Tester history"
      className="bg-card min-w-0 self-start rounded-[10px] border shadow-card"
    >
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">History</h2>
        <InfoTip label="About the history">The last 20 runs, kept only while this page is open.</InfoTip>
      </div>
      {runs.length === 0 ? (
        <p className="text-muted-foreground px-3.5 py-3 text-sm">No runs yet.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex items-center gap-2 border-b px-3.5 py-2 last:border-b-0"
              data-run={run.id}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onShow(run)}
                aria-label={`Show ${run.tool}`}
              >
                <span className="block truncate font-mono text-xs">{run.tool}</span>
                <span className="text-faint block text-xs">
                  {formatTime(run.at)} · {run.mode === 'model' ? 'model' : 'raw'} ·{' '}
                  {formatMs(run.response.durationMs)}
                </span>
              </button>
              <OutcomeBadge outcome={run.response.outcome} />
              <Button type="button" variant="ghost" size="xs" onClick={() => onShow(run)}>
                Show
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ToolPanel({
  tool,
  mode,
  initialArguments,
  initialRun,
  onChangeTool,
  onShowRun,
}: {
  tool: ToolInfo;
  mode: TesterMode;
  initialArguments?: Record<string, unknown>;
  initialRun?: TesterRun;
  onChangeTool: () => void;
  onShowRun: (run: TesterRun) => void;
}) {
  const servers = useServers();
  const server = servers.data?.servers.find((entry) => entry.name === tool.server);
  const field = useMemo(() => readInputSchema(tool.inputSchema), [tool.inputSchema]);
  const [value, setFormValue] = useState<Record<string, unknown>>(
    initialArguments ?? initialRun?.arguments ?? {},
  );
  // Problems show once there is something to judge: an edit, a run, or arguments handed over.
  const [touched, setTouched] = useState(initialArguments !== undefined || initialRun !== undefined);
  const setValue = (next: Record<string, unknown>) => {
    setTouched(true);
    setFormValue(next);
  };
  const [rawJson, setRawJson] = useState(field.kind !== 'object');
  const [response, setResponse] = useState<TesterCallResponse | undefined>(initialRun?.response);
  const [round, setRound] = useState(0);
  const validation = useLiveValidation(tool.fullName, value, true);
  const problems: ArgumentProblem[] =
    touched && validation.answer?.result === 'invalid' ? validation.answer.problems : [];

  const run = useMutation({
    // Answers always go back in model mode: only call_tool's path issues and checks the state.
    mutationFn: (extra: { inputResponses?: Record<string, ElicitationAnswer>; requestState?: string }) =>
      runTester(tool.fullName, { mode: extra.requestState ? 'model' : mode, arguments: value, ...extra }),
    onSuccess: (answer) => {
      setResponse(answer);
      setRound((n) => n + 1);
      recordRun({ tool: tool.fullName, mode: answer.mode, arguments: value, response: answer });
    },
  });
  const asked = inputRequiredOf(response);
  const unavailable = !tool.available;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_260px]">
      <Panel className="space-y-4 self-start p-3.5">
        <section aria-label="Tool" className="space-y-2">
          <div className="bg-panel-2 flex min-h-10 flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
            <ServerTile name={tool.server} icon={server?.icon} size="sm" />
            <h2 className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">{tool.fullName}</h2>
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
            {!tool.enabled ? (
              <ToneBadge tone="off" dot={false}>
                disabled in MCPier
              </ToneBadge>
            ) : null}
            <Button type="button" variant="ghost" size="xs" onClick={onChangeTool}>
              Change tool
            </Button>
          </div>
          {tool.description ? (
            <p className="text-muted-foreground wrap-anywhere m-0 text-sm whitespace-pre-line">
              {tool.description}
            </p>
          ) : null}
          {unavailable ? (
            <div className="flex flex-wrap items-center gap-2 text-sm" role="note">
              <span>The tool is not available: its server is</span>
              {server ? <StatusBadge state={server.status.state} /> : <span>not connected</span>}
              {server?.status.detail ? (
                <span className="text-muted-foreground wrap-anywhere">
                  ({server.status.detailMessage ?? server.status.detail})
                </span>
              ) : null}
              <Link to={`/servers/${encodeURIComponent(tool.server)}`} className="underline">
                Open {tool.server}
              </Link>
            </div>
          ) : null}
        </section>

        <section aria-label="Arguments" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ValidationSummary
              answer={
                touched || validation.answer?.result === 'not_validated' ? validation.answer : undefined
              }
            />
            <span className="flex-1" />
            <div className="flex items-center gap-2">
              <Switch
                id="tester-raw-json"
                checked={rawJson}
                disabled={field.kind !== 'object'}
                onCheckedChange={setRawJson}
              />
              <Label htmlFor="tester-raw-json">Raw JSON</Label>
            </div>
          </div>
          {rawJson ? (
            <div className="space-y-1.5">
              <JsonEditor
                id="tester-json"
                label="Arguments (JSON)"
                rows={10}
                value={value}
                invalid={problems.length > 0}
                onChange={(next) =>
                  setValue(
                    next && typeof next === 'object' && !Array.isArray(next)
                      ? (next as Record<string, unknown>)
                      : {},
                  )
                }
              />
              {problems.length > 0 ? (
                <ul className="text-tone-bad-text space-y-0.5 text-xs" aria-label="Problems">
                  {problems.map((problem) => (
                    <li key={`${problem.location}:${problem.message}`}>
                      {problem.location}: {problem.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <SchemaForm field={field} value={value} onChange={setValue} problems={problems} />
          )}
          {validation.failed ? <ErrorMessage error={validation.failed} title="Cannot validate" /> : null}
        </section>

        <section aria-label="Run">
          <Button
            type="button"
            className="h-9 w-full"
            disabled={unavailable || run.isPending}
            onClick={() => {
              setTouched(true);
              run.mutate({});
            }}
          >
            <PlayIcon aria-hidden="true" />
            {run.isPending ? 'Running…' : 'Run'}
          </Button>
        </section>
      </Panel>

      <div className="min-w-0 space-y-4">
        {run.error ? <ErrorMessage error={run.error} title="The run failed" /> : null}
        {asked ? (
          <Elicitation
            key={round}
            requests={asked.inputRequests}
            onComplete={(answers) =>
              run.mutate({ inputResponses: answers, requestState: asked.requestState })
            }
          />
        ) : null}
        {response && !asked ? <ResultView response={response} /> : null}
        {!response && !asked && !run.error ? (
          <Panel>
            <p className="text-muted-foreground px-3.5 py-6 text-center text-sm">
              Run the tool to see its result.
            </p>
          </Panel>
        ) : null}
      </div>

      <History onShow={onShowRun} />
    </div>
  );
}

/** The mode as two radio buttons drawn as a segmented control. */
function ModeSwitch({ mode, onChange }: { mode: TesterMode; onChange: (mode: TesterMode) => void }) {
  return (
    <fieldset className="border-line-2 m-0 inline-flex overflow-hidden rounded-lg border p-0">
      <legend className="sr-only">Mode</legend>
      {(
        [
          ['model', 'As the model sees it'],
          ['raw', 'Raw'],
        ] as const
      ).map(([key, label]) => (
        <label
          key={key}
          className={cn(
            'has-[:focus-visible]:ring-ring/50 cursor-pointer px-3 py-1.5 text-[12.5px] has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-inset',
            mode === key
              ? 'bg-brand-soft text-tone-ok-text font-semibold'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <input
            type="radio"
            name="tester-mode"
            value={key}
            checked={mode === key}
            onChange={() => onChange(key)}
            className="sr-only"
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

export function TesterPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tools = useTools();
  const selected = params.get('tool') ?? undefined;
  const state = (location.state ?? {}) as TesterLocationState;
  const initialRun = state.runId !== undefined ? findRun(state.runId) : undefined;
  const tool = selected ? tools.data?.tools.find((entry) => entry.fullName === selected) : undefined;
  const [mode, setMode] = useState<TesterMode>(initialRun?.mode ?? 'model');

  const pick = (fullName: string | undefined, nextState?: TesterLocationState) => {
    const next = new URLSearchParams(params);
    if (fullName) next.set('tool', fullName);
    else next.delete('tool');
    setParams(next, { state: nextState ?? null });
  };
  const showRun = (run: TesterRun) => {
    setMode(run.mode);
    navigate(`/tester?tool=${encodeURIComponent(run.tool)}`, {
      state: { runId: run.id } satisfies TesterLocationState,
    });
  };

  return (
    <>
      <PageTitle
        title="Tester"
        info="Run a tool by hand. As the model sees it: exactly as call_tool runs it, with validation, the result size limit, and input requests you can answer here. Raw: straight to the server, with no validation by MCPier, no size limit and no input requests."
        actions={<ModeSwitch mode={mode} onChange={setMode} />}
      />
      {!selected ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
          <Panel className="p-3.5">
            <ToolPicker onPick={(name) => pick(name)} />
          </Panel>
          <History onShow={showRun} />
        </div>
      ) : tools.isPending ? (
        <LoadingRows label="Loading the tool" />
      ) : tools.error ? (
        <ErrorMessage error={tools.error} title="Cannot load the tools" />
      ) : !tool ? (
        <EmptyState
          title={`There is no tool named "${selected}"`}
          action={<Button onClick={() => pick(undefined)}>Pick another tool</Button>}
        >
          It may have been removed, or its server has not listed it yet.
        </EmptyState>
      ) : (
        <ToolPanel
          // A new tool, a prefill or a run from the history starts the panel afresh.
          key={`${tool.fullName}:${location.key}`}
          tool={tool}
          mode={mode}
          initialArguments={state.arguments}
          initialRun={initialRun}
          onChangeTool={() => pick(undefined)}
          onShowRun={showRun}
        />
      )}
    </>
  );
}
