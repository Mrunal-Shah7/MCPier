// Setup snippets for MCP clients (SPEC 2). Pure functions of the paths and port, so the CLI's
// `mcpier connect` and the dashboard's Connect page show the same text. MCPier never writes
// any client's config file; these are for the user to paste.

export const CONNECT_CLIENTS = [
  'claude-desktop',
  'claude-code',
  'cursor',
  'vscode',
  'codex',
  'generic',
] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];

export interface ConnectInputs {
  /** Absolute path of node.exe (stdio clients launch it directly, never a .cmd shim). */
  nodePath: string;
  /** Absolute path of the CLI's built entry script. */
  cliEntry: string;
  /** The gateway's port. */
  port: number;
}

export interface ClientSnippet {
  client: ConnectClient;
  title: string;
  /** How the client reaches MCPier: the stdio bridge or the HTTP endpoint. */
  transport: 'stdio' | 'http';
  /** Where the snippet goes, most likely first. Empty when it is a command to run. */
  configLocations: string[];
  format: 'json' | 'toml' | 'shell' | 'text';
  snippet: string;
  /** What to do with it, one step per line. */
  steps: string[];
}

export function isConnectClient(value: string): value is ConnectClient {
  return (CONNECT_CLIENTS as readonly string[]).includes(value);
}

export function mcpEndpointUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * A TOML string for a value: a literal string ('...', backslashes kept as they are) when it
 * can be one, otherwise a basic string with escapes.
 */
export function tomlString(value: string): string {
  const isControl = (char: string) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
  const chars = [...value];
  if (!chars.some((char) => char === "'" || isControl(char))) return `'${value}'`;
  const escaped = chars.map((char) => {
    if (char !== '\\' && char !== '"' && !isControl(char)) return char;
    switch (char) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
  return `"${escaped.join('')}"`;
}

/** A command line for display: each part quoted when it has spaces or quotes. */
function commandLine(parts: string[]): string {
  return parts.map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ');
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function connectSnippet(client: ConnectClient, inputs: ConnectInputs): ClientSnippet {
  const url = mcpEndpointUrl(inputs.port);
  const stdioEntry = { command: inputs.nodePath, args: [inputs.cliEntry, 'stdio'] };
  switch (client) {
    case 'claude-desktop':
      return {
        client,
        title: 'Claude Desktop',
        transport: 'stdio',
        configLocations: [
          '%APPDATA%\\Claude\\claude_desktop_config.json',
          '%LOCALAPPDATA%\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json (Microsoft Store / MSIX install)',
        ],
        format: 'json',
        snippet: json({ mcpServers: { mcpier: stdioEntry } }),
        steps: [
          'Open the config file (Settings > Developer > Edit Config), or create it.',
          'Add the "mcpier" entry under "mcpServers" (keep any entries already there).',
          'Quit Claude Desktop fully (also from the system tray) and start it again.',
          'The bridge starts MCPier if it is not running.',
        ],
      };
    case 'claude-code':
      return {
        client,
        title: 'Claude Code',
        transport: 'http',
        configLocations: [],
        format: 'shell',
        snippet: `claude mcp add --transport http --scope user mcpier ${url}`,
        steps: [
          'Run the command once. "--scope user" makes MCPier available in every project.',
          'MCPier must be running (mcpier start).',
        ],
      };
    case 'cursor':
      return {
        client,
        title: 'Cursor',
        transport: 'http',
        configLocations: [
          '%USERPROFILE%\\.cursor\\mcp.json (every project)',
          '.cursor\\mcp.json in a project folder',
        ],
        format: 'json',
        snippet: json({ mcpServers: { mcpier: { url } } }),
        steps: [
          'Add the "mcpier" entry under "mcpServers" (keep any entries already there).',
          'Restart Cursor if it does not pick the change up.',
          'MCPier must be running (mcpier start).',
        ],
      };
    case 'vscode':
      return {
        client,
        title: 'VS Code',
        transport: 'http',
        configLocations: [
          'The user mcp.json (Command Palette: "MCP: Open User Configuration")',
          '.vscode\\mcp.json in a workspace folder',
        ],
        format: 'json',
        snippet: json({ servers: { mcpier: { type: 'http', url } } }),
        steps: [
          'Add the "mcpier" entry under "servers" (VS Code uses "servers", not "mcpServers").',
          'MCPier must be running (mcpier start).',
        ],
      };
    case 'codex':
      return {
        client,
        title: 'Codex',
        transport: 'stdio',
        configLocations: ['%USERPROFILE%\\.codex\\config.toml'],
        format: 'toml',
        snippet: [
          '[mcp_servers.mcpier]',
          `command = ${tomlString(inputs.nodePath)}`,
          `args = [${tomlString(inputs.cliEntry)}, 'stdio']`,
        ].join('\n'),
        steps: [
          'Add the table to config.toml.',
          'This uses the stdio bridge, which starts MCPier if it is not running.',
          `To use the HTTP endpoint instead: [mcp_servers.mcpier] with url = '${url}'.`,
        ],
      };
    case 'generic':
      return {
        client,
        title: 'Any other client',
        transport: 'http',
        configLocations: [],
        format: 'text',
        snippet: [
          `HTTP (Streamable HTTP) URL: ${url}`,
          `Command (stdio):            ${commandLine([inputs.nodePath, inputs.cliEntry, 'stdio'])}`,
        ].join('\n'),
        steps: [
          'If the client accepts a URL, use the URL (MCPier must be running).',
          'If it only launches commands, use the command: node.exe with the script path and "stdio" as arguments.',
          'The stdio command starts MCPier if it is not running.',
        ],
      };
  }
}

export function connectSnippets(inputs: ConnectInputs): ClientSnippet[] {
  return CONNECT_CLIENTS.map((client) => connectSnippet(client, inputs));
}
