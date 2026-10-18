// The interactive path of `server import`: questions answered by a scripted prompter.
import { describe, expect, it } from 'vitest';
import { planImport } from '../src/import-plan.js';
import type { Prompter } from '../src/prompt.js';

function scripted(answers: { confirm: boolean[]; ask: string[] }): Prompter & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    async confirm(question) {
      questions.push(question);
      return answers.confirm.shift() ?? false;
    },
    async ask(question, defaultValue) {
      questions.push(`${question} [${defaultValue}]`);
      const answer = answers.ask.shift();
      return answer === undefined || answer === '' ? defaultValue : answer;
    },
  };
}

const block = {
  mcpServers: {
    gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_value_1', MODE: 'x', API_KEY: 'key_value_2' } },
    web: { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer tok_value_3' } },
  },
};

describe('planImport in ask mode', () => {
  it('asks per value, lets the user rename, and keeps refused values plain', async () => {
    const prompter = scripted({ confirm: [true, false, true], ask: ['', 'web-bearer'] });
    const plan = await planImport(block, [], 'ask', prompter);
    expect(prompter.questions).toEqual([
      'Move gh env GITHUB_TOKEN into Credential Manager?',
      '  Secret name for gh env GITHUB_TOKEN [gh-github-token]',
      'Move gh env API_KEY into Credential Manager?',
      'Move web header Authorization into Credential Manager?',
      '  Secret name for web header Authorization [web-authorization]',
    ]);
    expect(plan.moves).toEqual([
      {
        server: 'gh',
        location: 'env',
        key: 'GITHUB_TOKEN',
        secretName: 'gh-github-token',
        value: 'ghp_value_1',
      },
      {
        server: 'web',
        location: 'header',
        key: 'Authorization',
        secretName: 'web-bearer',
        value: 'tok_value_3',
      },
    ]);
    expect(plan.kept).toEqual([{ server: 'gh', location: 'env', key: 'API_KEY' }]);
    const source = plan.source as typeof block;
    expect(source.mcpServers.gh.env).toEqual({
      GITHUB_TOKEN: 'secret:gh-github-token',
      MODE: 'x',
      API_KEY: 'key_value_2',
    });
    expect(source.mcpServers.web.headers).toEqual({ Authorization: 'Bearer secret:web-bearer' });
    // The pasted object itself is left untouched.
    expect(block.mcpServers.gh.env.GITHUB_TOKEN).toBe('ghp_value_1');
  });

  it('asks again for an invalid secret name', async () => {
    const prompter = scripted({ confirm: [true, false, false], ask: ['Bad Name', 'good-name'] });
    const plan = await planImport(block, [], 'ask', prompter);
    expect(plan.moves[0]!.secretName).toBe('good-name');
  });

  it('moves everything with move mode and nothing with keep mode, without asking', async () => {
    expect((await planImport(block, [], 'move')).moves.map((move) => move.secretName)).toEqual([
      'gh-github-token',
      'gh-api-key',
      'web-authorization',
    ]);
    const kept = await planImport(block, [], 'keep');
    expect(kept.moves).toEqual([]);
    expect(kept.kept).toHaveLength(3);
  });
});

describe('a plain OAuth client secret in an interactive run', () => {
  it('is not asked about: it goes to the gateway, which always moves it into a secret', async () => {
    const prompter = scripted({ confirm: [], ask: [] });
    const pasted = {
      mcpServers: {
        drive: { url: 'https://x.example/mcp', oauth: { clientId: 'a', clientSecret: 'cs-value' } },
      },
    };
    const plan = await planImport(pasted, [], 'ask', prompter);
    expect(prompter.questions).toEqual([]);
    expect(plan.moves).toEqual([]);
    expect(plan.parsed.candidates[0]!.oauth?.clientSecret).toEqual({ kind: 'plain' });
  });
});
