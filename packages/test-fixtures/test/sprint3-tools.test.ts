import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RICH_INPUT_SCHEMA,
  startLegacyServer,
  startStatelessServer,
  type RunningFixture,
} from '../src/index.js';

const MODERN = { pin: '2026-07-28' } as const;
type Result = {
  content?: { text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
/** `callTool` params with the 2026-07-28 retry fields, which the SDK's param type omits. */
const retry = (params: Record<string, unknown>) => params as Parameters<Client['callTool']>[0];
const textOf = (result: unknown) =>
  ((result as Result).content ?? []).map((block) => block.text ?? '').join('');

let stateless: RunningFixture;
let legacy: Awaited<ReturnType<typeof startLegacyServer>>;
const clients: Client[] = [];

beforeAll(async () => {
  stateless = await startStatelessServer();
  legacy = await startLegacyServer();
});

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {});
  await stateless.close();
  await legacy.close();
});

async function modernClient(): Promise<Client> {
  const client = new Client(
    { name: 'fixture-test', version: '1' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: MODERN } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(stateless.url)));
  clients.push(client);
  return client;
}

describe('confirm_action (input_required, stateless server)', () => {
  it('asks for confirmation, then reports the answer on the retry', async () => {
    const client = await modernClient();
    const first = (await client.callTool(
      { name: 'confirm_action', arguments: { action: 'deploy' } },
      { allowInputRequired: true },
    )) as unknown as {
      resultType: string;
      inputRequests: Record<string, { method: string; params: { message: string } }>;
      requestState: string;
    };
    expect(first.resultType).toBe('input_required');
    expect(first.inputRequests.confirm!.method).toBe('elicitation/create');
    expect(first.inputRequests.confirm!.params.message).toBe('Confirm "deploy"?');
    expect(typeof first.requestState).toBe('string');

    const second = await client.callTool(
      retry({
        name: 'confirm_action',
        arguments: { action: 'deploy' },
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: first.requestState,
      }),
      { allowInputRequired: true },
    );
    expect(textOf(second)).toBe('confirm_action deploy: accepted (confirm=true)');

    const declined = await client.callTool(
      retry({
        name: 'confirm_action',
        arguments: { action: 'deploy' },
        inputResponses: { confirm: { action: 'decline' } },
        requestState: first.requestState,
      }),
      { allowInputRequired: true },
    );
    expect(textOf(declined)).toBe('confirm_action deploy: decline');
  });

  it('rejects a tampered state, a state for another action, and an answer without state', async () => {
    const client = await modernClient();
    const first = (await client.callTool(
      { name: 'confirm_action', arguments: { action: 'one' } },
      { allowInputRequired: true },
    )) as unknown as { requestState: string };
    const answer = { confirm: { action: 'accept', content: { confirm: true } } };
    const tampered = `${first.requestState.slice(0, -2)}xx`;
    for (const [args, state] of [
      [{ action: 'one' }, tampered],
      [{ action: 'two' }, first.requestState],
      [{ action: 'one' }, undefined],
    ] as const) {
      const result = await client.callTool(
        retry({
          name: 'confirm_action',
          arguments: args,
          inputResponses: answer,
          ...(state ? { requestState: state } : {}),
        }),
        { allowInputRequired: true },
      );
      expect((result as Result).isError).toBe(true);
      expect(textOf(result)).toBe('confirm_action: invalid or missing request state');
    }
  });
});

describe('ask_legacy (2025-style elicitation, legacy server)', () => {
  it('reports the answer when the client handles elicitation', async () => {
    const client = new Client({ name: 'answers', version: '1' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { ok: true } }));
    await client.connect(new StreamableHTTPClientTransport(new URL(legacy.url)));
    clients.push(client);
    expect(textOf(await client.callTool({ name: 'ask_legacy', arguments: {} }))).toBe(
      'ask_legacy: accept {"ok":true}',
    );
  });

  it('reports an error, without hanging, when the client cannot elicit', async () => {
    const client = new Client({ name: 'no-elicitation', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(legacy.url)));
    clients.push(client);
    const result = await client.callTool({ name: 'ask_legacy', arguments: {} }, { timeout: 5000 });
    expect(textOf(result)).toMatch(/^ask_legacy: error: /);
  });
});

describe('big_structured, rich_input and meta_echo', () => {
  it('returns structured content of the requested size', async () => {
    const client = await modernClient();
    const result = (await client.callTool({ name: 'big_structured', arguments: { kb: 2 } })) as Result;
    expect((result.structuredContent!.data as string).length).toBe(2048);
    expect(textOf(result)).toBe('structured output of 2 KB');
  });

  it('publishes the rich schema unchanged and validates against it', async () => {
    const client = await modernClient();
    const { tools } = await client.listTools(undefined, { cacheMode: 'refresh' });
    const rich = tools.find((tool) => tool.name === 'rich_input')!;
    expect(rich.inputSchema).toMatchObject({
      $defs: RICH_INPUT_SCHEMA.$defs,
      properties: { address: { $ref: '#/$defs/address' }, contact: { oneOf: expect.any(Array) } },
      required: ['name', 'kind', 'address'],
    });
    const ok = await client.callTool({
      name: 'rich_input',
      arguments: {
        name: 'Ada',
        kind: 'person',
        address: { street: 'Main', zip: '12345' },
        contact: { phone: '555' },
      },
    });
    expect(textOf(ok)).toMatch(/^rich_input accepted/);
    const bad = await client
      .callTool({
        name: 'rich_input',
        arguments: { name: '', kind: 'robot', address: { street: 'x', zip: 'abc' } },
      })
      .catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
    expect((bad as Result).isError).toBe(true);
  });

  it('echoes the request _meta in both eras', async () => {
    const modern = await modernClient();
    const echoed = (await modern.callTool({
      name: 'meta_echo',
      arguments: {},
      _meta: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    })) as Result;
    expect(echoed.structuredContent).toMatchObject({
      meta: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      clientName: 'fixture-test',
    });
    const old = new Client({ name: 'legacy-echo', version: '1' });
    await old.connect(new StreamableHTTPClientTransport(new URL(legacy.url)));
    clients.push(old);
    const legacyEcho = (await old.callTool({
      name: 'meta_echo',
      arguments: {},
      _meta: { tracestate: 'k=v' },
    })) as Result;
    expect(legacyEcho.structuredContent).toMatchObject({
      meta: { tracestate: 'k=v' },
      clientName: 'legacy-echo',
    });
  });
});
