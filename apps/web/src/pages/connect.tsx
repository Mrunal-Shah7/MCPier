import type { ClientSnippet } from '@mcpier/shared';
import { InfoIcon } from 'lucide-react';
import { useConnect } from '@/lib/queries';
import { CopyButton, ErrorMessage, LoadingRows, PageHeader } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function ClientCard({ snippet }: { snippet: ClientSnippet }) {
  return (
    <Card data-client={snippet.client}>
      <CardHeader>
        <CardTitle>{snippet.title}</CardTitle>
        <CardDescription>
          {snippet.transport === 'stdio'
            ? 'Through the stdio bridge (mcpier stdio)'
            : 'Through the HTTP endpoint'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {snippet.configLocations.length > 0 ? (
          <div>
            <p className="text-muted-foreground text-xs font-medium">
              {snippet.configLocations.length === 1 ? 'Config file' : 'Config file (one of)'}
            </p>
            <ul className="font-mono text-xs break-all">
              {snippet.configLocations.map((location) => (
                <li key={location}>{location}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="relative">
          <pre className="bg-muted overflow-x-auto rounded-md p-3 pr-24 font-mono text-xs">
            {snippet.snippet}
          </pre>
          <div className="absolute top-2 right-2">
            <CopyButton text={snippet.snippet} label={`Copy the ${snippet.title} snippet`} />
          </div>
        </div>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5">
          {snippet.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function ConnectPage() {
  const connect = useConnect();
  return (
    <>
      <PageHeader
        title="Connect"
        description="Setup for each client, with this machine's paths and port. MCPier never edits a client's config file: paste the snippet yourself."
      />
      {connect.isPending ? (
        <LoadingRows label="Loading snippets" />
      ) : connect.error ? (
        <ErrorMessage error={connect.error} title="Cannot load the snippets" />
      ) : (
        <div className="space-y-4">
          {connect.data.placeholder ? (
            <Alert role="status">
              <InfoIcon />
              <AlertTitle>Placeholder paths</AlertTitle>
              <AlertDescription>{connect.data.note}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm">
            Endpoint: <code className="font-mono">{connect.data.url}</code>
          </p>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {connect.data.clients.map((snippet) => (
              <ClientCard key={snippet.client} snippet={snippet} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
