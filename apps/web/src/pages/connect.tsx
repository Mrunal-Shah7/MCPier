import type { ClientSnippet } from '@mcpier/shared';
import { InfoIcon } from 'lucide-react';
import { useConnect } from '@/lib/queries';
import { CopyButton, ErrorMessage, LoadingRows } from '@/components/common';
import { InfoTip, PageTitle, Panel, PanelBody } from '@/components/kit';
import { Chip } from '@/components/status-badge';

function ClientCard({ snippet }: { snippet: ClientSnippet }) {
  return (
    <Panel data-client={snippet.client} aria-label={snippet.title}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5">
        <span
          aria-hidden="true"
          className="bg-panel-3 grid size-[22px] place-items-center rounded-md text-[11px] font-bold"
        >
          {snippet.title.charAt(0)}
        </span>
        <h2 className="text-[13px] font-semibold">{snippet.title}</h2>
        <Chip>{snippet.transport === 'stdio' ? 'stdio bridge' : 'HTTP'}</Chip>
        <span className="flex-1" />
        <InfoTip label={`Where the ${snippet.title} snippet goes`}>
          <span className="block space-y-1">
            {snippet.configLocations.length > 0 ? (
              <span className="block">
                {snippet.configLocations.length === 1 ? 'Config file: ' : 'Config file (one of): '}
                {snippet.configLocations.join(' · ')}
              </span>
            ) : null}
            {snippet.steps.map((step) => (
              <span key={step} className="block">
                {step}
              </span>
            ))}
          </span>
        </InfoTip>
      </div>
      <PanelBody className="space-y-3">
        <pre className="wrap-anywhere bg-panel-2 m-0 rounded-lg border p-3 font-mono text-[11.5px] whitespace-pre-wrap">
          {snippet.snippet}
        </pre>
        {snippet.configLocations.length > 0 ? (
          <ul className="text-faint wrap-anywhere m-0 list-none p-0 font-mono text-[11px]">
            {snippet.configLocations.map((location) => (
              <li key={location}>{location}</li>
            ))}
          </ul>
        ) : null}
        <ol className="sr-only">
          {snippet.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <CopyButton text={snippet.snippet} label={`Copy the ${snippet.title} snippet`} />
      </PanelBody>
    </Panel>
  );
}

export function ConnectPage() {
  const connect = useConnect();
  return (
    <>
      <PageTitle
        title="Connect"
        info="Setup for each client, with this machine's paths and port. Paste the snippet into the client yourself."
        actions={<span className="text-faint text-xs">MCPier never edits client configs</span>}
      />
      {connect.isPending ? (
        <LoadingRows label="Loading snippets" />
      ) : connect.error ? (
        <ErrorMessage error={connect.error} title="Cannot load the snippets" />
      ) : (
        <div className="space-y-4">
          {connect.data.placeholder ? (
            <p
              role="status"
              className="border-tone-info/35 bg-tone-info-soft text-tone-info-text m-0 flex items-start gap-2 rounded-[10px] border px-3.5 py-2.5 text-sm"
            >
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                <b>Placeholder paths</b> <span>{connect.data.note}</span>
              </span>
            </p>
          ) : null}
          <p className="m-0 text-sm">
            Endpoint: <code className="font-mono">{connect.data.url}</code>
          </p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {connect.data.clients.map((snippet) => (
              <ClientCard key={snippet.client} snippet={snippet} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
