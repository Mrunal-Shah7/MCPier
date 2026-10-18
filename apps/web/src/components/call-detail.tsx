// One call's detail (the Call log and a server's Activity tab share it): the summary, the clean
// error with the raw response behind a disclosure, the estimated tokens, and the stored
// arguments and result. Everything wraps inside the panel; nothing scrolls the page sideways.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronDownIcon, PlayIcon, XIcon } from 'lucide-react';
import { splitFullToolName, type CallSummary, type StoredBody } from '@mcpier/shared';
import { formatMs, prettyBody, useCallDetail } from '@/lib/call-log';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorMessage, formatTime, LoadingRows } from '@/components/common';
import { ErrorBlock } from '@/components/error-block';
import { KeyValues, Panel, PanelBody, PanelHeader } from '@/components/kit';
import { OutcomeBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export const clientLabel = (client: CallSummary['client']) =>
  client.name ? `${client.name}${client.version ? ` ${client.version}` : ''}` : '(unnamed client)';

export function toolHref(call: { tool: string; server?: string }): string | undefined {
  const parts = splitFullToolName(call.tool);
  if (!call.server || !parts) return undefined;
  return `/servers/${encodeURIComponent(call.server)}?tab=tools&tool=${encodeURIComponent(parts.tool)}`;
}

function Body({ title, body }: { title: string; body: StoredBody | undefined }) {
  const [open, setOpen] = useState(true);
  if (!body) {
    return (
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-muted-foreground text-sm">None.</p>
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="text-foreground px-1 font-semibold">
            <ChevronDownIcon
              aria-hidden="true"
              className={cn('transition-transform', open ? '' : '-rotate-90')}
            />
            {title}
          </Button>
        </CollapsibleTrigger>
        <CopyButton text={body.text} label={`Copy ${title.toLowerCase()}`} />
      </div>
      <CollapsibleContent>
        {body.truncated ? <p className="text-faint mb-1 text-xs">Cut at 64 KB when it was stored.</p> : null}
        <pre
          aria-label={title}
          className="wrap-anywhere bg-panel-2 max-h-96 overflow-y-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
        >
          {prettyBody(body.text)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CallDetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useCallDetail(id);
  const navigate = useNavigate();
  const call = detail.data;
  let testerArguments: Record<string, unknown> | undefined;
  if (call?.arguments && !call.arguments.truncated) {
    try {
      const parsed: unknown = JSON.parse(call.arguments.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        testerArguments = parsed as Record<string, unknown>;
    } catch {
      testerArguments = undefined;
    }
  }
  const href = call ? toolHref(call) : undefined;
  return (
    <Panel aria-label="Call detail" className="xl:sticky xl:top-[68px] xl:self-start">
      <PanelHeader
        title={`Call ${id}`}
        actions={
          <>
            {call ? <OutcomeBadge outcome={call.outcome} /> : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close the call detail"
              onClick={onClose}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </>
        }
      />
      <PanelBody className="space-y-4">
        {detail.isPending ? <LoadingRows rows={3} label="Loading the call" /> : null}
        {detail.error ? <ErrorMessage error={detail.error} title="Cannot load the call" /> : null}
        {call ? (
          <>
            <KeyValues
              rows={[
                [
                  'Tool',
                  <span className="font-mono text-xs">
                    {href ? (
                      <Link to={href} className="hover:underline">
                        {call.tool}
                      </Link>
                    ) : (
                      call.tool
                    )}
                  </span>,
                ],
                [
                  'Server',
                  call.server ? (
                    <Link to={`/servers/${encodeURIComponent(call.server)}`} className="hover:underline">
                      {call.server}
                    </Link>
                  ) : (
                    '—'
                  ),
                ],
                [
                  'Client',
                  <>
                    {clientLabel(call.client)} <span className="text-faint">({call.era})</span>
                  </>,
                ],
                ['Time', formatTime(call.at)],
                ['Duration', formatMs(call.durationMs)],
                [
                  'Est. tokens',
                  call.estimatedTokens !== undefined ? (
                    <span title="Estimated from the result's size: about 4 bytes per token">
                      {call.estimatedTokens.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-faint">not recorded (before 1.1.0)</span>
                  ),
                ],
                ['Trace id', <span className="font-mono text-xs">{call.traceId ?? '—'}</span>],
              ]}
            />
            {call.errorText ? (
              <ErrorBlock
                message={call.errorMessage ?? call.errorText}
                raw={call.errorText}
                code={call.errorCode}
              />
            ) : null}
            {call.bodiesStored ? (
              <div className="space-y-3">
                <Body title="Arguments" body={call.arguments} />
                <Body title="Result" body={call.result} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm" role="note">
                Arguments and result were not stored: <strong>Store call bodies</strong> was off. Turn it on
                in{' '}
                <Link to="/settings" className="underline">
                  Settings
                </Link>{' '}
                for new calls.
              </p>
            )}
            {testerArguments ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(`/tester?tool=${encodeURIComponent(call.tool)}`, {
                    state: { arguments: testerArguments },
                  })
                }
              >
                <PlayIcon aria-hidden="true" />
                Open in Tester
              </Button>
            ) : null}
          </>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
