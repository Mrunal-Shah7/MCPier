import {
  jsonErrorMessage,
  API_PATHS,
  type ToolCallResponse,
  type ToolListResponse,
  type ToolResponse,
  type ToolSearchResponse,
} from '@mcpier/shared';
import { connectApi } from '../api.js';
import { CliError } from '../errors.js';
import { printJson, shorten, table } from '../format.js';

export async function toolsList(options: {
  server?: string;
  all?: boolean;
  json?: boolean;
}): Promise<number> {
  const api = await connectApi();
  const query = options.server ? `?server=${encodeURIComponent(options.server)}` : '';
  const { tools } = await api.request<ToolListResponse>('GET', `${API_PATHS.tools}${query}`);
  const shown = options.all ? tools : tools.filter((tool) => tool.enabled && tool.available);
  if (options.json) {
    printJson({ tools: shown });
    return 0;
  }
  if (shown.length === 0) {
    console.log(
      options.all ? 'No tools known.' : 'No enabled, available tools. Use --all to see every known tool.',
    );
    return 0;
  }
  console.log(
    table(
      ['TOOL', ...(options.all ? ['STATE'] : []), 'DESCRIPTION'],
      shown.map((tool) => {
        const state = [
          tool.enabled ? '' : 'disabled',
          tool.available ? '' : 'unavailable',
          tool.flag ? 'flagged' : '',
        ]
          .filter(Boolean)
          .join(',');
        return [tool.fullName, ...(options.all ? [state || 'ok'] : []), shorten(tool.description, 70)];
      }),
    ),
  );
  return 0;
}

export async function toolsToggle(fullName: string, enable: boolean): Promise<number> {
  const api = await connectApi();
  const { tool } = await api.request<ToolResponse>(
    'POST',
    API_PATHS.toolAction(fullName, enable ? 'enable' : 'disable'),
  );
  console.log(`${tool.fullName} is ${tool.enabled ? 'enabled' : 'disabled'}.`);
  return 0;
}

interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string };
}

export async function toolsCall(
  fullName: string,
  options: { args?: string; json?: boolean },
): Promise<number> {
  let args: unknown = {};
  if (options.args !== undefined) {
    try {
      args = JSON.parse(options.args);
    } catch (error) {
      throw new CliError(`--args is not valid JSON: ${jsonErrorMessage(error)}`, {
        hint: `In Git Bash, wrap it in single quotes: --args '{"path":"C:\\\\data"}'`,
      });
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new CliError('--args must be a JSON object, for example \'{"text":"hello"}\'.');
  }
  const api = await connectApi();
  const response = await api.request<ToolCallResponse>('POST', API_PATHS.toolAction(fullName, 'call'), {
    arguments: args,
  });
  if (options.json) {
    printJson(response);
    return response.result.isError === true ? 1 : 0;
  }
  const result = response.result as {
    content?: ContentBlock[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const out = result.isError ? console.error : console.log;
  if (result.isError) console.error('The tool returned an error:');
  for (const block of result.content ?? []) {
    if (block.type === 'text') out(block.text ?? '');
    else if (block.type === 'resource')
      out(block.resource?.text ?? `[resource ${block.resource?.uri ?? ''}]`);
    else if (block.type === 'resource_link') out(`[resource link ${block.uri ?? ''}]`);
    else out(`[${block.type}${block.mimeType ? ` ${block.mimeType}` : ''} content; use --json to see it]`);
  }
  if (result.structuredContent !== undefined && (result.content ?? []).length === 0) {
    out(JSON.stringify(result.structuredContent, null, 2));
  }
  return result.isError ? 1 : 0;
}

export async function toolsSearch(
  query: string,
  options: { limit?: string; server?: string; json?: boolean },
): Promise<number> {
  const params = new URLSearchParams({ q: query });
  if (options.limit !== undefined) params.set('limit', options.limit);
  if (options.server) params.set('server', options.server);
  const api = await connectApi();
  const response = await api.request<ToolSearchResponse>('GET', `${API_PATHS.toolSearch}?${params}`);
  if (options.json) {
    printJson(response);
    return 0;
  }
  if (response.results.length === 0) {
    console.log(`No tools match "${query}".`);
    return 0;
  }
  console.log(
    table(
      ['TOOL', 'AVAILABLE', 'DESCRIPTION'],
      response.results.map((match) => [
        match.name,
        match.available ? 'yes' : `no (${match.serverStatus ?? 'unknown'})`,
        shorten(match.description, 70),
      ]),
    ),
  );
  return 0;
}
