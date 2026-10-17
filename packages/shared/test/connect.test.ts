import { describe, expect, it } from 'vitest';
import {
  CONNECT_CLIENTS,
  connectSnippet,
  connectSnippets,
  isConnectClient,
  tomlString,
} from '../src/index.js';

const INPUTS = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliEntry: 'C:\\Users\\me\\code\\MCPier\\apps\\cli\\dist\\mcpier.js',
  port: 48123,
};
const URL = 'http://127.0.0.1:48123/mcp';

describe('connect snippets', () => {
  it('has one snippet per client, in order', () => {
    expect(connectSnippets(INPUTS).map((snippet) => snippet.client)).toEqual([...CONNECT_CLIENTS]);
    expect(isConnectClient('cursor')).toBe(true);
    expect(isConnectClient('nope')).toBe(false);
  });

  it('claude-desktop: the stdio bridge with node.exe and the script, as valid JSON', () => {
    const snippet = connectSnippet('claude-desktop', INPUTS);
    expect(snippet.transport).toBe('stdio');
    expect(JSON.parse(snippet.snippet)).toEqual({
      mcpServers: { mcpier: { command: INPUTS.nodePath, args: [INPUTS.cliEntry, 'stdio'] } },
    });
    expect(snippet.snippet).toContain('C:\\\\Program Files\\\\nodejs\\\\node.exe');
    expect(snippet.configLocations[0]).toBe('%APPDATA%\\Claude\\claude_desktop_config.json');
    expect(snippet.configLocations[1]).toContain('LocalCache\\Roaming\\Claude');
  });

  it('claude-code: one command with the real port', () => {
    expect(connectSnippet('claude-code', INPUTS).snippet).toBe(
      `claude mcp add --transport http --scope user mcpier ${URL}`,
    );
  });

  it('cursor: mcpServers with a url', () => {
    expect(JSON.parse(connectSnippet('cursor', INPUTS).snippet)).toEqual({
      mcpServers: { mcpier: { url: URL } },
    });
  });

  it('vscode: servers with type http', () => {
    expect(JSON.parse(connectSnippet('vscode', INPUTS).snippet)).toEqual({
      servers: { mcpier: { type: 'http', url: URL } },
    });
  });

  it('codex: a TOML table with literal strings, backslashes kept', () => {
    expect(connectSnippet('codex', INPUTS).snippet).toBe(
      [
        '[mcp_servers.mcpier]',
        "command = 'C:\\Program Files\\nodejs\\node.exe'",
        "args = ['C:\\Users\\me\\code\\MCPier\\apps\\cli\\dist\\mcpier.js', 'stdio']",
      ].join('\n'),
    );
  });

  it('generic: the URL and a quoted command line', () => {
    const snippet = connectSnippet('generic', INPUTS).snippet;
    expect(snippet).toContain(URL);
    expect(snippet).toContain(`"${INPUTS.nodePath}" ${INPUTS.cliEntry} stdio`);
  });

  it('escapes awkward paths correctly', () => {
    const odd = { ...INPUTS, cliEntry: 'C:\\Users\\O\'Brien "x"\\mcpier.js' };
    expect(JSON.parse(connectSnippet('claude-desktop', odd).snippet).mcpServers.mcpier.args[0]).toBe(
      odd.cliEntry,
    );
    expect(connectSnippet('codex', odd).snippet).toContain('"C:\\\\Users\\\\O\'Brien \\"x\\"\\\\mcpier.js"');
  });
});

describe('tomlString', () => {
  it.each([
    ['C:\\a b\\c.exe', "'C:\\a b\\c.exe'"],
    ["it's", '"it\'s"'],
    ['line\nbreak', '"line\\nbreak"'],
    ['tab\there', '"tab\\there"'],
  ])('%j', (input, expected) => {
    expect(tomlString(input)).toBe(expected);
  });
});
