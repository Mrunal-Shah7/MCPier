// Sprint 3: the tool search index (SPEC 5.2) and its membership rules.
import { describe, expect, it } from 'vitest';
import { defaultConfig, type SearchWeights, type ServerStatus, type ToolInfo } from '@mcpier/shared';
import {
  SearchIndex,
  searchCandidates,
  splitWords,
  type SearchCandidate,
  type ServerManager,
} from '@mcpier/core';

const WEIGHTS = defaultConfig().settings.searchWeights;

function tool(server: string, name: string, extra: Partial<ToolInfo> = {}): ToolInfo {
  return {
    fullName: `${server}__${name}`,
    server,
    name,
    inputSchema: { type: 'object' },
    enabled: true,
    available: true,
    ...extra,
  };
}

function candidate(
  info: ToolInfo,
  serverStatus: ServerStatus = 'ready',
  serverDescription?: string,
): SearchCandidate {
  return { tool: info, serverStatus, ...(serverDescription ? { serverDescription } : {}) };
}

function indexOf(candidates: SearchCandidate[], weights: SearchWeights = WEIGHTS): SearchIndex {
  return new SearchIndex({ candidates: () => candidates, weights: () => weights });
}

const names = (index: SearchIndex, query: string, limit = 10, server?: string) =>
  index.search({ query, limit, ...(server ? { server } : {}) }).map((hit) => hit.tool.fullName);

describe('splitWords', () => {
  it.each([
    ['create_issue', ['create', 'issue']],
    ['listDirectory', ['list', 'directory']],
    ['get-file.contents', ['get', 'file', 'contents']],
    ['getHTTPStatus', ['get', 'http', 'status']],
    ['read file', ['read', 'file']],
    ['v2Search', ['v2', 'search']],
  ])('%s', (input, expected) => {
    expect(splitWords(input)).toEqual(expected);
  });
});

describe('ranking', () => {
  const tools = [
    candidate(tool('github', 'create_issue', { description: 'Open a new issue in a repository' })),
    candidate(tool('files', 'listDirectory', { description: 'List the entries of a folder' })),
    candidate(tool('files', 'read_file', { description: 'Read a file from disk' })),
    candidate(
      tool('notes', 'append', {
        description: 'Add text to a note',
        inputSchema: { type: 'object', properties: { issueNumber: { type: 'number' } } },
      }),
    ),
  ];

  it('matches name words split from camelCase and underscores', () => {
    expect(names(indexOf(tools), 'directory')[0]).toBe('files__listDirectory');
    expect(names(indexOf(tools), 'create issue')[0]).toBe('github__create_issue');
  });

  it('matches by prefix and fuzzily', () => {
    expect(names(indexOf(tools), 'direc')[0]).toBe('files__listDirectory');
    expect(names(indexOf(tools), 'isue')).toContain('github__create_issue');
  });

  it('matches parameter names, server names and server descriptions', () => {
    expect(names(indexOf(tools), 'number')).toContain('notes__append');
    expect(names(indexOf(tools), 'github')[0]).toBe('github__create_issue');
    const described = indexOf([
      candidate(tool('alpha', 'run'), 'ready', 'Talks to the weather service'),
      candidate(tool('beta', 'run')),
    ]);
    expect(names(described, 'weather')).toEqual(['alpha__run']);
  });

  it('field weights change the order', () => {
    const pair = [
      candidate(tool('a', 'deploy', { description: 'Ship it' })),
      candidate(tool('b', 'ship', { description: 'Runs a deploy of the current build' })),
    ];
    // Default weights: a name match beats a description match.
    expect(names(indexOf(pair), 'deploy')[0]).toBe('a__deploy');
    // With the description weighted far above the name, the order flips.
    const descriptionFirst = { ...WEIGHTS, name: 0.1, description: 20 };
    expect(names(indexOf(pair, descriptionFirst), 'deploy')[0]).toBe('b__ship');
  });

  it('respects the limit and the server filter', () => {
    expect(names(indexOf(tools), 'file', 1)).toHaveLength(1);
    expect(names(indexOf(tools), 'issue', 10, 'notes')).toEqual(['notes__append']);
  });

  it('an empty query with a server filter lists that server, by name', () => {
    expect(names(indexOf(tools), '', 10, 'files')).toEqual(['files__listDirectory', 'files__read_file']);
    expect(names(indexOf(tools), '', 10)).toEqual([]);
  });
});

describe('availability', () => {
  it('ranks unavailable tools after available ones, even with a better score', () => {
    const index = indexOf([
      candidate(tool('gh', 'search_issues', { available: false }), 'needs_auth'),
      candidate(tool('local', 'notes', { description: 'search issues you wrote down' })),
    ]);
    const hits = index.search({ query: 'search issues', limit: 10 });
    expect(hits.map((hit) => hit.tool.fullName)).toEqual(['local__notes', 'gh__search_issues']);
    expect(hits[1]).toMatchObject({ available: false, serverStatus: 'needs_auth' });
  });

  it('includes flagged tools', () => {
    const index = indexOf([candidate(tool('odd', 'weird name!', { flag: 'bad characters' }))]);
    expect(names(index, 'weird')).toEqual(['odd__weird name!']);
  });
});

describe('suggestions', () => {
  it('offers close full names for a name nobody has', () => {
    const index = indexOf([candidate(tool('files', 'read_file')), candidate(tool('files', 'write_file'))]);
    expect(index.suggest('files__read_fil')).toContain('files__read_file');
    expect(index.suggest('zzz__qqq')).toEqual([]);
  });
});

describe('live updates', () => {
  it('a search during a rebuild uses the previous snapshot, then the new one', async () => {
    let current = [candidate(tool('a', 'old_tool'))];
    const index = new SearchIndex({ candidates: () => current, weights: () => WEIGHTS }, undefined, 30);
    current = [candidate(tool('a', 'new_tool'))];
    index.invalidate();
    // Not rebuilt yet: the previous index answers, without failing or waiting.
    expect(names(index, 'old')).toEqual(['a__old_tool']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(names(index, 'old')).toEqual([]);
    expect(names(index, 'new')).toEqual(['a__new_tool']);
    index.close();
  });

  it('many changes in a burst cause one rebuild', async () => {
    let builds = 0;
    const index = new SearchIndex(
      {
        candidates: () => {
          builds++;
          return [];
        },
        weights: () => WEIGHTS,
      },
      undefined,
      20,
    );
    for (let i = 0; i < 10; i++) index.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(builds).toBe(2); // the initial build and one rebuild
    index.close();
  });
});

describe('membership', () => {
  it('takes enabled tools on enabled servers, available or not', () => {
    const summaries = [
      { name: 'on', enabled: true, description: 'Enabled server', status: { state: 'ready' } },
      { name: 'down', enabled: true, status: { state: 'crashed', detail: 'exit 1' } },
      { name: 'off', enabled: false, status: { state: 'stopped' } },
    ];
    const catalog = [
      tool('down', 'still_listed', { available: false }),
      tool('off', 'hidden', { enabled: false }),
      tool('on', 'listed'),
      tool('on', 'turned_off', { enabled: false }),
    ];
    const manager = { summaries: () => summaries, tools: () => catalog } as unknown as ServerManager;
    const found = searchCandidates(manager);
    expect(found.map((entry) => entry.tool.fullName)).toEqual(['down__still_listed', 'on__listed']);
    expect(found[0]!.serverStatus).toBe('crashed');
    expect(found[1]!.serverDescription).toBe('Enabled server');
  });
});
