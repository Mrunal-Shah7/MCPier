import { describe, expect, it } from 'vitest';
import {
  defaultConfig,
  isSecretRef,
  makeSecretRef,
  parseSecretRef,
  referencedSecretNames,
  secretHint,
  secretRefName,
  secretValueProblem,
  slugProblem,
  validateConfig,
  type McpierConfig,
} from '../src/index.js';

function expectValid(value: unknown): McpierConfig {
  const result = validateConfig(value);
  if (!result.ok) throw new Error(`expected valid config, got:\n${result.problems.join('\n')}`);
  return result.config;
}

function problemsOf(value: unknown): string[] {
  const result = validateConfig(value);
  if (result.ok) throw new Error('expected the config to be invalid');
  return result.problems;
}

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: 'stdio',
  command: 'npx',
  ...extra,
});
const http = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: 'http',
  url: 'https://example.com/mcp',
  ...extra,
});

describe('config schema: valid configs', () => {
  it('accepts a full config with every setting and both transports', () => {
    const config = expectValid({
      settings: {
        port: 48000,
        extraPath: ['C:\\tools\\bin'],
        resultSizeLimitKb: 250,
        logRetentionDays: 7,
        storeCallBodies: false,
        searchWeights: {
          name: 5,
          title: 4,
          description: 2,
          parameterNames: 1,
          serverName: 0.5,
          serverDescription: 0.5,
        },
        cimdUrl: 'https://example.com/mcpier/client.json',
      },
      servers: [
        {
          name: 'github',
          description: 'GitHub repos, issues, PRs',
          enabled: true,
          transport: 'stdio',
          command: 'github-mcp-server',
          args: ['stdio'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret:github-token', PLAIN: 'value' },
          timeoutMs: 30000,
          disabledTools: ['delete_repository'],
        },
        {
          name: 'notion',
          transport: 'http',
          url: 'https://mcp.notion.com/mcp',
          auth: 'oauth',
          headers: { 'X-Api-Key': 'secret:notion-key' },
          enabled: false,
        },
        { name: 'local-http', transport: 'http', url: 'http://127.0.0.1:9000/mcp' },
      ],
    });
    expect(config.settings.port).toBe(48000);
    expect(config.settings.cimdUrl).toBe('https://example.com/mcpier/client.json');
    expect(config.settings.searchWeights.serverName).toBe(0.5);
    expect(config.servers).toHaveLength(3);
    const [github, notion] = config.servers;
    expect(github).toMatchObject({ transport: 'stdio', args: ['stdio'], timeoutMs: 30000 });
    expect(notion).toMatchObject({ transport: 'http', auth: 'oauth', enabled: false });
  });

  it('fills in every default for an empty config', () => {
    expect(expectValid({})).toEqual({
      settings: {
        port: 47800,
        extraPath: [],
        resultSizeLimitKb: 100,
        logRetentionDays: 30,
        storeCallBodies: true,
        searchWeights: {
          name: 3,
          title: 3,
          description: 2,
          parameterNames: 1,
          serverName: 1,
          serverDescription: 1,
        },
      },
      servers: [],
    });
    expect(defaultConfig()).toEqual(expectValid({}));
  });

  it('fills in server defaults for minimal entries', () => {
    const config = expectValid({ servers: [stdio('fs'), http('remote')] });
    expect(config.servers[0]).toEqual({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
      enabled: true,
      timeoutMs: 60000,
      disabledTools: [],
      protocol: 'auto',
      startupTimeoutMs: 90000,
    });
    expect(config.servers[1]).toEqual({
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {},
      auth: 'none',
      enabled: true,
      timeoutMs: 60000,
      disabledTools: [],
      protocol: 'auto',
      startupTimeoutMs: 90000,
    });
  });

  it('fills in missing search weights individually', () => {
    const config = expectValid({ settings: { searchWeights: { name: 10 } } });
    expect(config.settings.searchWeights).toMatchObject({ name: 10, title: 3, description: 2 });
  });

  it('keeps unknown keys at every level', () => {
    const config = expectValid({
      futureTopLevel: { a: 1 },
      settings: { futureSetting: true, searchWeights: { futureField: 2 } },
      servers: [stdio('fs', { futureServerField: 'x' }), http('web', { futureHttpField: [1, 2] })],
    }) as Record<string, unknown> & McpierConfig;
    expect(config.futureTopLevel).toEqual({ a: 1 });
    expect((config.settings as Record<string, unknown>).futureSetting).toBe(true);
    expect((config.settings.searchWeights as Record<string, unknown>).futureField).toBe(2);
    expect((config.servers[0] as Record<string, unknown>).futureServerField).toBe('x');
    expect((config.servers[1] as Record<string, unknown>).futureHttpField).toEqual([1, 2]);
  });
});

describe('config schema: invalid configs', () => {
  it.each([
    ['uppercase letters', 'GitHub'],
    ['starting with a digit', '1server'],
    ['starting with a hyphen', '-server'],
    ['ending with a hyphen', 'server-'],
    ['a double hyphen', 'my--server'],
    ['an underscore', 'my_server'],
    ['a space', 'my server'],
    ['an empty name', ''],
    ['49 characters', `a${'b'.repeat(48)}`],
  ])('rejects a server name with %s', (_label, name) => {
    const problems = problemsOf({ servers: [stdio(name)] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^servers\[0\]\.name: /);
  });

  it('accepts a 48-character name', () => {
    expectValid({ servers: [stdio(`a${'b'.repeat(47)}`)] });
  });

  it('rejects a double underscore with a specific message', () => {
    const problems = problemsOf({ servers: [stdio('git__hub')] });
    expect(problems).toEqual([
      'servers[0].name: must not contain "__" (a double underscore separates server and tool names)',
    ]);
  });

  it('rejects duplicate server names, naming both entries', () => {
    const problems = problemsOf({ servers: [stdio('fs'), http('web'), http('fs')] });
    expect(problems).toEqual([
      'servers[2].name: duplicates the name of servers[0] ("fs"); server names must be unique',
    ]);
  });

  it.each([['ftp://example.com/mcp'], ['not a url'], ['file:///C:/server'], ['ws://example.com/mcp']])(
    'rejects the URL %s',
    (url) => {
      expect(problemsOf({ servers: [http('web', { url })] })).toEqual([
        'servers[0].url: must be an http:// or https:// URL',
      ]);
    },
  );

  it.each([
    ['an uppercase name', 'secret:GitHub'],
    ['an underscore', 'secret:github_token'],
    ['an empty name', 'secret:'],
    ['a double underscore', 'secret:a__b'],
  ])('rejects a malformed secret reference with %s in env', (_label, value) => {
    const problems = problemsOf({ servers: [stdio('fs', { env: { TOKEN: value } })] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^servers\[0\]\.env\.TOKEN: is a malformed secret reference/);
  });

  it('rejects a malformed secret reference in headers, quoting unusual keys', () => {
    const problems = problemsOf({ servers: [http('web', { headers: { 'X-Api-Key': 'secret:Bad' } })] });
    expect(problems[0]).toMatch(/^servers\[0\]\.headers\["X-Api-Key"\]: is a malformed secret reference/);
  });

  it.each([[1023], [65536], [0], [-1], [47800.5]])('rejects port %s', (port) => {
    const problems = problemsOf({ settings: { port } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^settings\.port: must be/);
  });

  it('accepts the port boundaries', () => {
    expectValid({ settings: { port: 1024 } });
    expectValid({ settings: { port: 65535 } });
  });

  it('rejects an unknown transport', () => {
    expect(problemsOf({ servers: [{ name: 'x', transport: 'websocket' }] })).toEqual([
      'servers[0].transport: must be "stdio" or "http"',
    ]);
  });

  it('rejects a stdio entry without a command', () => {
    expect(problemsOf({ servers: [{ name: 'x', transport: 'stdio' }] })).toEqual([
      'servers[0].command: is required',
    ]);
  });

  it('rejects a non-https CIMD URL', () => {
    expect(problemsOf({ settings: { cimdUrl: 'http://example.com/client.json' } })).toEqual([
      'settings.cimdUrl: must be an https:// URL',
    ]);
  });

  it('reports every problem, not just the first', () => {
    const problems = problemsOf({
      settings: { port: 1 },
      servers: [stdio('Bad'), http('web', { url: 'nope' })],
    });
    expect(problems).toHaveLength(3);
  });

  it('rejects a non-object config', () => {
    expect(problemsOf([])[0]).toMatch(/^\(top level\): /);
  });
});

describe('secret reference helpers', () => {
  it('tells a secret reference from a plain value', () => {
    expect(isSecretRef('secret:github-token')).toBe(true);
    expect(isSecretRef('secret:')).toBe(true);
    expect(isSecretRef('plain-value')).toBe(false);
    expect(isSecretRef('SECRET:github-token')).toBe(false);
  });

  it('extracts the name of a well-formed reference', () => {
    expect(parseSecretRef('secret:github-token')).toEqual({
      kind: 'secret',
      name: 'github-token',
      prefix: '',
    });
    expect(secretRefName('secret:github-token')).toBe('github-token');
    expect(secretRefName('plain')).toBeUndefined();
    expect(secretRefName('secret:Bad')).toBeUndefined();
  });

  it('flags a malformed reference with the reason', () => {
    const parsed = parseSecretRef('secret:has_underscore');
    expect(parsed.kind).toBe('malformed');
  });
});

describe('protocol and startup timeout fields', () => {
  it('default to auto and 90 seconds when absent (older config files still load)', () => {
    const config = expectValid({
      servers: [{ name: 'old', transport: 'stdio', command: 'x', timeoutMs: 5000 }],
    });
    expect(config.servers[0]).toMatchObject({ protocol: 'auto', startupTimeoutMs: 90000, timeoutMs: 5000 });
  });

  it.each([['auto'], ['legacy'], ['modern']])('accept protocol %s on both transports', (protocol) => {
    const config = expectValid({
      servers: [stdio('a', { protocol }), http('b', { protocol, startupTimeoutMs: 1000 })],
    });
    expect(config.servers.map((server) => server.protocol)).toEqual([protocol, protocol]);
    expect(config.servers[1]!.startupTimeoutMs).toBe(1000);
  });

  it('reject an unknown protocol and a startup timeout under one second', () => {
    expect(problemsOf({ servers: [stdio('a', { protocol: 'v2' })] })).toEqual([
      'servers[0].protocol: must be "auto", "legacy" or "modern"',
    ]);
    expect(problemsOf({ servers: [stdio('a', { startupTimeoutMs: 999 })] })).toEqual([
      'servers[0].startupTimeoutMs: must be at least 1000',
    ]);
    expect(problemsOf({ servers: [stdio('a', { startupTimeoutMs: 1500.5 })] })).toEqual([
      'servers[0].startupTimeoutMs: must be a whole number of milliseconds',
    ]);
  });
});

describe('header secret references with a scheme word', () => {
  it('accepts "Bearer secret:<name>" in headers', () => {
    const config = expectValid({
      servers: [
        http('web', { headers: { Authorization: 'Bearer secret:github-token', 'X-Key': 'secret:key' } }),
      ],
    });
    expect(config.servers[0]).toMatchObject({ headers: { Authorization: 'Bearer secret:github-token' } });
    expect(parseSecretRef('Bearer secret:github-token', 'header')).toEqual({
      kind: 'secret',
      name: 'github-token',
      prefix: 'Bearer ',
    });
  });

  it('rejects a malformed name after a scheme word in headers', () => {
    const problems = problemsOf({
      servers: [http('web', { headers: { Authorization: 'Bearer secret:Bad' } })],
    });
    expect(problems[0]).toMatch(/^servers\[0\]\.headers\.Authorization: is a malformed secret reference/);
  });

  it('keeps env values whole: "Bearer secret:x" in env is a plain string', () => {
    const config = expectValid({ servers: [stdio('a', { env: { TOKEN: 'Bearer secret:Anything Goes' } })] });
    expect(config.servers[0]).toMatchObject({ env: { TOKEN: 'Bearer secret:Anything Goes' } });
    expect(parseSecretRef('Bearer secret:x', 'env')).toEqual({ kind: 'plain' });
    expect(isSecretRef('Bearer secret:x', 'header')).toBe(true);
    expect(isSecretRef('two words secret:x', 'header')).toBe(false);
  });

  it('builds references and lists the names an entry uses', () => {
    expect(makeSecretRef('gh')).toBe('secret:gh');
    expect(makeSecretRef('gh', 'Bearer')).toBe('Bearer secret:gh');
    expect(
      referencedSecretNames({
        env: { A: 'secret:one', B: 'plain', C: 'Bearer secret:not-in-env' },
        headers: { Authorization: 'Bearer secret:two', 'X-Key': 'secret:one' },
      }),
    ).toEqual(['one', 'two']);
  });
});

describe('secret value checks', () => {
  it('rejects empty and over-long values without echoing them', () => {
    expect(secretValueProblem('')).toBe('The secret value must not be empty.');
    expect(secretValueProblem('x'.repeat(1280))).toBeUndefined();
    const problem = secretValueProblem('y'.repeat(1281));
    expect(problem).toContain('at most 1280');
    expect(problem).not.toContain('yyyy');
  });

  it('shows the last four characters only for values of at least eight', () => {
    expect(secretHint('abcdefgh')).toBe('efgh');
    expect(secretHint('short')).toBeUndefined();
  });
});

describe('slug rule', () => {
  it('accepts typical names', () => {
    for (const name of ['github', 'fs', 'my-server-2', 'a1b2']) expect(slugProblem(name)).toBeUndefined();
  });
});
