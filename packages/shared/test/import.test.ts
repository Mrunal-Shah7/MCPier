import { describe, expect, it } from 'vitest';
import { looksSensitive, parseImportBlock, proposedSecretName, slugify, splitScheme } from '../src/index.js';

const entries = { files: { command: 'npx', args: ['-y', '@scope/server-files', 'C:\\data'] } };

describe('parseImportBlock: accepted shapes', () => {
  it.each([
    ['mcpServers', { mcpServers: entries }],
    ['servers', { servers: entries }],
    ['bare', entries],
  ])('reads the %s shape', (shape, source) => {
    const result = parseImportBlock(source);
    expect(result.shape).toBe(shape);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toEqual([
      {
        key: 'files',
        name: 'files',
        entry: {
          name: 'files',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@scope/server-files', 'C:\\data'],
          env: {},
        },
        ignored: [],
        sensitive: [],
      },
    ]);
  });

  it('rejects anything else with one clear error', () => {
    for (const source of [null, [], 'text', { unrelated: 1 }]) {
      const result = parseImportBlock(source);
      expect(result.candidates).toEqual([]);
      expect(result.errors[0]!.message).toContain('Expected an object with "mcpServers"');
    }
  });
});

describe('parseImportBlock: entries', () => {
  it('converts stdio and HTTP entries, including serverUrl and description/disabled', () => {
    const result = parseImportBlock({
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'uvx',
          args: ['tool'],
          env: { MODE: 'x' },
          description: 'Local',
          disabled: true,
        },
        remote: { type: 'http', url: 'https://a.example/mcp', headers: { 'X-Team': 'blue' } },
        streamable: { type: 'streamable-http', serverUrl: 'https://b.example/mcp' },
        untyped: { url: 'https://c.example/mcp' },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.entry)).toEqual([
      {
        name: 'local',
        description: 'Local',
        enabled: false,
        transport: 'stdio',
        command: 'uvx',
        args: ['tool'],
        env: { MODE: 'x' },
      },
      { name: 'remote', transport: 'http', url: 'https://a.example/mcp', headers: { 'X-Team': 'blue' } },
      { name: 'streamable', transport: 'http', url: 'https://b.example/mcp', headers: {} },
      { name: 'untyped', transport: 'http', url: 'https://c.example/mcp', headers: {} },
    ]);
  });

  it('accepts a Windows-style entry that runs npx through cmd /c', () => {
    const result = parseImportBlock({
      mcpServers: { github: { command: 'cmd', args: ['/c', 'npx', '-y', '@scope/server-github'] } },
    });
    expect(result.candidates[0]!.entry).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@scope/server-github'],
    });
  });

  it('rejects the deprecated sse transport with a clear message', () => {
    const result = parseImportBlock({ mcpServers: { old: { type: 'sse', url: 'https://x.example/sse' } } });
    expect(result.candidates).toEqual([]);
    expect(result.errors[0]).toMatchObject({ key: 'old' });
    expect(result.errors[0]!.message).toContain('deprecated HTTP+SSE transport ("type": "sse")');
  });

  it('reports unusable entries one by one while importing the rest', () => {
    const result = parseImportBlock({
      mcpServers: {
        good: { command: 'x' },
        neither: { foo: 1 },
        badArgs: { command: 'x', args: 'nope' },
        badEnv: { command: 'x', env: { A: 1 } },
        weirdType: { type: 'websocket', url: 'wss://x' },
        notObject: 'x',
      },
    });
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(['good']);
    expect(Object.fromEntries(result.errors.map((error) => [error.key, error.message]))).toEqual({
      neither: 'has neither a "command" (stdio server) nor a "url" (remote server)',
      badArgs: '"args" must be a list of strings',
      badEnv: '"env.A" must be a string',
      weirdType: 'has a URL but an unknown "type": "websocket"',
      notObject: 'is not an object.',
    });
  });

  it('reports fields MCPier ignores instead of dropping them silently', () => {
    const result = parseImportBlock({
      mcpServers: { files: { command: 'x', cwd: 'C:\\', alwaysAllow: ['a'], autoApprove: [] } },
    });
    expect(result.candidates[0]!.ignored).toEqual(['cwd', 'alwaysAllow', 'autoApprove']);
  });
});

describe('parseImportBlock: names', () => {
  it('converts keys to slugs', () => {
    const result = parseImportBlock({
      mcpServers: {
        'GitHub Server': { command: 'x' },
        'my_tools.v2': { command: 'x' },
        '--Odd--Name--': { command: 'x' },
      },
    });
    expect(result.candidates.map((candidate) => candidate.name)).toEqual([
      'github-server',
      'my-tools-v2',
      'odd-name',
    ]);
  });

  it('refuses names that collide with existing servers or other entries, or cannot become slugs', () => {
    const result = parseImportBlock(
      {
        mcpServers: {
          Existing: { command: 'x' },
          'new one': { command: 'x' },
          New_One: { command: 'y' },
          '2fast': { command: 'x' },
          '***': { command: 'x' },
        },
      },
      ['existing'],
    );
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(['new-one']);
    const messages = Object.fromEntries(result.errors.map((error) => [error.key, error.message]));
    expect(messages.Existing).toContain('"existing", which already exists');
    expect(messages.New_One).toContain('which another entry in this block already uses');
    expect(messages['2fast']).toContain('cannot be used as a server name');
    expect(messages['***']).toContain('is empty after conversion');
  });

  it('slugify and proposed secret names', () => {
    expect(slugify('A  B__C')).toBe('a-b-c');
    expect(slugify('x'.repeat(60))).toHaveLength(48);
    expect(proposedSecretName('github', 'GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(
      'github-github-personal-access-token',
    );
  });
});

describe('sensitive values', () => {
  it('flags credential-looking env keys and headers with plain values only', () => {
    const result = parseImportBlock({
      mcpServers: {
        gh: {
          command: 'x',
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x',
            API_KEY: 'k',
            DB_PASSWORD: 'p',
            CLIENT_SECRET: 's',
            GH_PAT: 'p',
            AUTH_MODE: 'basic',
            PATH: 'C:\\bin',
            MODE: 'x',
            ALREADY: 'secret:stored-one',
            EMPTY_TOKEN: '',
          },
        },
        web: {
          url: 'https://x.example/mcp',
          headers: {
            Authorization: 'Bearer abc123',
            'X-Api-Key': 'k',
            'X-Other': 'v',
            'X-Ref': 'Bearer secret:stored-one',
          },
        },
      },
    });
    expect(result.candidates[0]!.sensitive.map((value) => value.key)).toEqual([
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'API_KEY',
      'DB_PASSWORD',
      'CLIENT_SECRET',
      'GH_PAT',
      'AUTH_MODE',
    ]);
    expect(result.candidates[1]!.sensitive).toEqual([
      { location: 'header', key: 'Authorization', scheme: 'Bearer' },
      { location: 'header', key: 'X-Api-Key' },
    ]);
  });

  it('detects keys and splits schemes', () => {
    expect(looksSensitive('env', 'PATH')).toBe(false);
    expect(looksSensitive('env', 'PATHEXT')).toBe(false);
    expect(looksSensitive('env', 'PAT')).toBe(true);
    expect(looksSensitive('header', 'authorization')).toBe(true);
    expect(splitScheme('Bearer abc def')).toEqual({ scheme: 'Bearer', token: 'abc def' });
    expect(splitScheme('just-a-key')).toEqual({ token: 'just-a-key' });
  });
});
