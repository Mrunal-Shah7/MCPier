// Sprint 3 manager additions: trace context, input_required as an outcome, retries, and
// legacy upstream elicitation being declined.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fixtureScripts,
  startLegacyServer,
  startStatelessServer,
  type RunningFixture,
} from '@mcpier/test-fixtures';
import {
  FAST_TIMING,
  startTestGateway,
  waitForStatus,
  type TestGateway,
} from '../../../test/helpers/gateway.js';

const SECRET = 'header-secret-value-for-redaction-1234';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

let t: TestGateway;
let stateless: RunningFixture;
let legacy: RunningFixture;

beforeAll(async () => {
  stateless = await startStatelessServer();
  legacy = await startLegacyServer();
  t = await startTestGateway({
    timing: FAST_TIMING,
    config: {
      servers: [
        { name: 'modern', transport: 'http', url: stateless.url, headers: { 'X-Key': 'secret:header-key' } },
        { name: 'old', transport: 'http', url: legacy.url },
        { name: 'local', transport: 'stdio', command: process.execPath, args: [fixtureScripts.stdio] },
      ],
    } as never,
  });
  await t.secrets.set('header-key', SECRET);
  await t.gateway.manager.restart('modern');
  for (const name of ['modern', 'old', 'local']) await waitForStatus(t.gateway, name, 'ready');
});

afterAll(async () => {
  await t.cleanup();
  await stateless.close();
  await legacy.close();
});

const structured = (outcome: Awaited<ReturnType<typeof t.gateway.manager.callTool>>) => {
  if (outcome.kind !== 'result') throw new Error(`expected a result, got ${outcome.kind}`);
  return outcome.result.structuredContent as { meta: Record<string, unknown>; clientName: string };
};

describe('trace context', () => {
  it.each([['modern'], ['old'], ['local']])(
    'reaches the %s server; the client identity stays MCPier’s',
    async (server) => {
      const outcome = await t.gateway.manager.callTool(
        `${server}__meta_echo`,
        {},
        {
          traceMeta: { traceparent: TRACEPARENT, tracestate: 'vendor=1', baggage: 'k=v' },
        },
      );
      const echoed = structured(outcome);
      expect(echoed.meta).toMatchObject({ traceparent: TRACEPARENT, tracestate: 'vendor=1', baggage: 'k=v' });
      expect(echoed.clientName).toBe('mcpier');
    },
  );
});

describe('input_required', () => {
  it('comes back as its own outcome when the elicitation capability is forwarded', async () => {
    const outcome = await t.gateway.manager.callTool(
      'modern__confirm_action',
      { action: 'ship' },
      {
        elicitation: { form: {} },
      },
    );
    expect(outcome.kind).toBe('input_required');
    if (outcome.kind !== 'input_required') return;
    const request = outcome.inputRequired.inputRequests!.confirm as {
      method: string;
      params: { message: string };
    };
    expect(request.method).toBe('elicitation/create');
    expect(request.params.message).toBe('Confirm "ship"?');
    expect(typeof outcome.inputRequired.requestState).toBe('string');

    const retried = await t.gateway.manager.callTool(
      'modern__confirm_action',
      { action: 'ship' },
      {
        elicitation: { form: {} },
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: outcome.inputRequired.requestState,
      },
    );
    expect(retried).toMatchObject({
      kind: 'result',
      result: { content: [{ type: 'text', text: 'confirm_action ship: accepted (confirm=true)' }] },
    });
  });

  it('is refused by the upstream when the caller cannot elicit', async () => {
    await expect(
      t.gateway.manager.callTool('modern__confirm_action', { action: 'ship' }),
    ).rejects.toMatchObject({ code: -32021 });
  });

  it('removes secret values from the input request messages', async () => {
    const outcome = await t.gateway.manager.callTool(
      'modern__confirm_action',
      { action: SECRET },
      {
        elicitation: { form: {} },
      },
    );
    expect(outcome.kind).toBe('input_required');
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).toContain('[secret:header-key]');
  });
});

describe('legacy upstream elicitation', () => {
  it('is declined without hanging', async () => {
    const started = Date.now();
    const outcome = await t.gateway.manager.callTool('old__ask_legacy', {}, { elicitation: { form: {} } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    const text = (outcome.result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/^ask_legacy: (error|decline)/);
  });
});
