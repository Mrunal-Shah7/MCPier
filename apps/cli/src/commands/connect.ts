import {
  CONNECT_CLIENTS,
  connectSnippet,
  connectSnippets,
  isConnectClient,
  mcpEndpointUrl,
  type ClientSnippet,
  type ConnectInputs,
} from '@mcpier/shared';
import { cliContext, resolvePort } from '../context.js';
import { CliError } from '../errors.js';
import { printJson } from '../format.js';

function printSnippet(snippet: ClientSnippet): void {
  console.log(`${snippet.title} (${snippet.transport === 'stdio' ? 'stdio bridge' : 'HTTP endpoint'})`);
  console.log('');
  if (snippet.configLocations.length > 0) {
    console.log(snippet.configLocations.length === 1 ? 'Config file:' : 'Config file (one of):');
    for (const location of snippet.configLocations) console.log(`  ${location}`);
    console.log('');
  }
  console.log(snippet.format === 'shell' ? 'Run:' : 'Snippet:');
  console.log('');
  for (const line of snippet.snippet.split('\n')) console.log(`  ${line}`);
  console.log('');
  for (const step of snippet.steps) console.log(`- ${step}`);
  console.log('');
  console.log('MCPier never edits client config files; paste this yourself.');
}

/** `mcpier connect [client]`: setup snippets with this machine's real paths and port. */
export async function connectCommand(
  client: string | undefined,
  options: { json?: boolean; cliEntry: string },
): Promise<number> {
  const { paths } = cliContext();
  const inputs: ConnectInputs = {
    nodePath: process.execPath,
    cliEntry: options.cliEntry,
    port: await resolvePort(paths),
  };

  if (client === undefined) {
    if (options.json) {
      printJson({ url: mcpEndpointUrl(inputs.port), clients: connectSnippets(inputs) });
      return 0;
    }
    console.log('Clients MCPier has setup instructions for:');
    for (const snippet of connectSnippets(inputs)) {
      console.log(`  ${snippet.client.padEnd(16)}${snippet.title}`);
    }
    console.log('');
    console.log(`MCPier's endpoint: ${mcpEndpointUrl(inputs.port)}`);
    console.log('Run "mcpier connect <client>" for the snippet, for example: mcpier connect claude-desktop');
    return 0;
  }

  if (!isConnectClient(client)) {
    throw new CliError(`Unknown client "${client}".`, {
      hint: `Use one of: ${CONNECT_CLIENTS.join(', ')}.`,
    });
  }
  const snippet = connectSnippet(client, inputs);
  if (options.json) printJson(snippet);
  else printSnippet(snippet);
  return 0;
}
