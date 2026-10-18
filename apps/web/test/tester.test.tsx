// Sprint 6, Phase 3: the Tester: the form for each supported type and the JSON fallback, the
// Raw JSON toggle, live validation, both modes, an unavailable tool, elicitation, and the
// session history. Plus the schema reader itself.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TesterCallResponse, ToolInfo, ValidateArgumentsResponse } from '@mcpier/shared';
import { readElicitationSchema, readField, readInputSchema } from '@/lib/schema-form';
import { HISTORY_SIZE, recordRun, resetTesterHistory } from '@/lib/tester';
import { currentLocation, fakeApi, renderApp, server, status, type FakeCall } from './helpers';

const RICH_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'What to write' },
    color: { type: 'string', enum: ['red', 'blue'] },
    when: { type: 'string', format: 'date' },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number' },
    loud: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
  required: ['text'],
};

function tool(overrides: Partial<ToolInfo> = {}): ToolInfo {
  return {
    fullName: 'files__write',
    server: 'files',
    name: 'write',
    description: 'Writes a note.',
    inputSchema: RICH_SCHEMA,
    readOnlyHint: false,
    destructiveHint: true,
    enabled: true,
    available: true,
    ...overrides,
  };
}

const okResult = (text: string, overrides: Partial<TesterCallResponse> = {}): TesterCallResponse => ({
  mode: 'model',
  outcome: 'ok',
  durationMs: 7,
  result: { content: [{ type: 'text', text }] },
  ...overrides,
});

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/status': status(),
    'GET /api/servers': { servers: [server()] },
    'GET /api/tools': { tools: [tool()] },
    'POST /api/tools/files__write/validate': { result: 'valid' } satisfies ValidateArgumentsResponse,
    'POST /api/tools/files__write/test': okResult('written'),
    ...extra,
  } as Record<string, object>;
}

const posts = (calls: FakeCall[], suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));

beforeEach(() => resetTesterHistory());

describe('schema reading', () => {
  it('draws primitives, arrays of primitives and nested objects; falls back to JSON for the rest', () => {
    const field = readInputSchema(RICH_SCHEMA);
    expect(field.kind).toBe('object');
    const kinds = Object.fromEntries(
      (field as Extract<typeof field, { kind: 'object' }>).properties.map((p) => [p.name, p.field.kind]),
    );
    expect(kinds).toEqual({
      text: 'string',
      color: 'string',
      when: 'string',
      count: 'integer',
      ratio: 'number',
      loud: 'boolean',
      tags: 'array',
      address: 'object',
      choice: 'json',
    });
    const root = { $defs: { name: { type: 'string' } } } as Record<string, unknown>;
    expect(readField({ $ref: '#/$defs/name' }, root).kind).toBe('string');
    expect(readField({ $ref: 'https://example.com/x.json' }, root)).toMatchObject({ kind: 'json' });
    expect(readField({ allOf: [{ type: 'string' }] }, root)).toMatchObject({
      kind: 'json',
      reason: 'uses allOf',
    });
    expect(readField({ type: 'string', if: {} }, root)).toMatchObject({ kind: 'json', reason: 'uses if' });
    expect(
      readField({ type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } }, root),
    ).toMatchObject({
      kind: 'json',
      reason: 'an array of objects or arrays',
    });
    expect(readField({ type: ['string', 'null'] }, root).kind).toBe('string');
    const loop = { $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } } };
    const read = readField({ $ref: '#/$defs/node' }, loop);
    expect(read.kind).toBe('object');
    expect((read as Extract<typeof read, { kind: 'object' }>).properties[0]!.field).toMatchObject({
      kind: 'json',
      reason: 'a recursive reference',
    });
    expect(readElicitationSchema({ type: 'object', properties: { ok: { type: 'boolean' } } })).toBeDefined();
    expect(
      readElicitationSchema({
        type: 'object',
        properties: { list: { type: 'array', items: { type: 'string' } } },
      }),
    ).toBeUndefined();
  });
});

describe('Tester: form', () => {
  it('renders a control for each supported type and a JSON editor for oneOf', async () => {
    fakeApi(routes());
    renderApp('/tester?tool=files__write');
    expect(await screen.findByRole('heading', { name: 'files__write' })).toBeInTheDocument();
    expect(screen.getByText('destructive')).toBeInTheDocument();
    expect(screen.getByLabelText(/^text/)).toHaveAttribute('type', 'text');
    expect(screen.getByText(/What to write/)).toBeInTheDocument();
    const color = screen.getByLabelText(/^color/);
    expect(
      within(color)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['(not set)', 'red', 'blue']);
    expect(screen.getByLabelText(/^when/)).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText(/^count/)).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByText(/whole number · min 1 · max 10/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^ratio/)).toHaveAttribute('inputmode', 'decimal');
    expect(within(screen.getByLabelText(/^loud/)).getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Add item to tags' })).toBeInTheDocument();
    const address = screen.getByRole('group', { name: /address/ });
    expect(within(address).getByLabelText(/^city/)).toBeInTheDocument();
    expect(screen.getByText('Edited as JSON: uses oneOf.')).toBeInTheDocument();
  });

  it('builds the arguments from the form, the array and the JSON fallback', async () => {
    const { calls } = fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    await user.type(await screen.findByLabelText(/^text/), 'hello');
    await user.selectOptions(screen.getByLabelText(/^color/), 'blue');
    await user.type(screen.getByLabelText(/^count/), '3');
    await user.selectOptions(screen.getByLabelText(/^loud/), 'true');
    await user.click(screen.getByRole('button', { name: 'Add item to tags' }));
    expect(screen.getByRole('group', { name: /^tags/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('tags item 1'), 'one');
    await user.type(within(screen.getByRole('group', { name: /address/ })).getByLabelText(/^city/), 'Pune');
    const choice = screen.getByLabelText(/^choice/);
    await user.type(choice, '42');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(posts(calls, '/test')).toHaveLength(1));
    expect(posts(calls, '/test')[0]!.body).toEqual({
      mode: 'model',
      arguments: {
        text: 'hello',
        color: 'blue',
        count: 3,
        loud: true,
        tags: ['one'],
        address: { city: 'Pune' },
        choice: 42,
      },
    });
    // Live validation sent the same arguments.
    await waitFor(() =>
      expect(posts(calls, '/validate').at(-1)!.body).toEqual({
        arguments: (posts(calls, '/test')[0]!.body as { arguments: unknown }).arguments,
      }),
    );
  });

  it('a field the form cannot draw says "Not valid JSON yet" until it is', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    const choice = await screen.findByLabelText(/^choice/);
    await user.type(choice, '{{"a":');
    expect(await screen.findByText('Not valid JSON yet.')).toBeInTheDocument();
  });

  it('Raw JSON toggle: the whole input as JSON, both ways', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    await user.type(await screen.findByLabelText(/^text/), 'hi');
    await user.click(screen.getByRole('switch', { name: 'Raw JSON' }));
    const editor = screen.getByLabelText('Arguments (JSON)');
    expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual({ text: 'hi' });
    await user.clear(editor);
    await user.click(editor);
    await user.paste('{"text":"from json","count":5}');
    await user.click(screen.getByRole('switch', { name: 'Raw JSON' }));
    expect(screen.getByLabelText(/^text/)).toHaveValue('from json');
    expect(screen.getByLabelText(/^count/)).toHaveValue('5');
  });

  it("shows the validate route's problems next to their fields", async () => {
    fakeApi(
      routes({
        'POST /api/tools/files__write/validate': {
          result: 'invalid',
          problems: [
            { path: ['text'], location: 'arguments.text', message: 'is required' },
            { path: ['address', 'city'], location: 'arguments.address.city', message: 'must be string' },
            { path: ['extra'], location: 'arguments.extra', message: 'is not an allowed property' },
          ],
        } satisfies ValidateArgumentsResponse,
      }),
    );
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    const text = await screen.findByLabelText(/^text/);
    // Nothing is judged before the first edit.
    await waitFor(() => expect(screen.getByLabelText(/^color/)).toBeInTheDocument());
    expect(text).not.toHaveAttribute('aria-invalid');
    await user.selectOptions(screen.getByLabelText(/^color/), 'red');
    await waitFor(() => expect(text).toHaveAttribute('aria-invalid', 'true'));
    expect(text.closest('[data-field]')).toHaveTextContent('text: is required');
    const city = within(screen.getByRole('group', { name: /address/ })).getByLabelText(/^city/);
    expect(city.closest('[data-field]')).toHaveTextContent('address.city: must be string');
    // A problem no field shows is listed at the top.
    expect(screen.getByText('extra: is not an allowed property')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Validation' })).toHaveTextContent('3 problems');
  });

  it('a schema the gateway cannot validate is said so', async () => {
    fakeApi(
      routes({
        'POST /api/tools/files__write/validate': {
          result: 'not_validated',
          reason: "can't resolve reference",
        },
      }),
    );
    renderApp('/tester?tool=files__write');
    expect(await screen.findByRole('status', { name: 'Validation' })).toHaveTextContent(
      "Not validated: can't resolve reference",
    );
  });

  it('arrives prefilled from the Call log', async () => {
    fakeApi(routes());
    renderApp({
      pathname: '/tester',
      search: '?tool=files__write',
      state: { arguments: { text: 'again', count: 2 } },
    });
    expect(await screen.findByLabelText(/^text/)).toHaveValue('again');
    expect(screen.getByLabelText(/^count/)).toHaveValue('2');
  });
});

describe('Tester: running', () => {
  it('model mode (default) shows the result and the truncation note; raw mode sends mode raw', async () => {
    const { calls } = fakeApi(
      routes({
        'POST /api/tools/files__write/test': (request: FakeCall) => ({
          body:
            (request.body as { mode: string }).mode === 'raw'
              ? okResult('x'.repeat(3000), { mode: 'raw', durationMs: 4 })
              : okResult('x'.repeat(1024), {
                  truncation: { text: { shownBytes: 1024, droppedBytes: 1976 } },
                  result: {
                    content: [
                      { type: 'text', text: 'x'.repeat(1024) },
                      { type: 'text', text: '[MCPier: output truncated.]' },
                    ],
                    structuredContent: { rows: 3 },
                  },
                }),
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    expect(await screen.findByRole('radio', { name: 'As the model sees it' })).toBeChecked();
    // Sprint 7: the mode switch sits in the page title, shown before the tool has loaded.
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const result = await screen.findByRole('region', { name: 'Result' });
    expect(within(result).getByRole('note')).toHaveTextContent('1024 bytes of text shown, 1976 dropped');
    expect(within(result).getByText('[MCPier: output truncated.]')).toBeInTheDocument();
    expect(within(result).getByLabelText('Structured content')).toHaveTextContent('"rows": 3');
    expect(within(result).getByText('OK')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Raw' }));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(posts(calls, '/test')).toHaveLength(2));
    expect(posts(calls, '/test')[1]!.body).toMatchObject({ mode: 'raw' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent('Raw'));
    expect(
      within(screen.getByRole('region', { name: 'Result' })).queryByRole('note'),
    ).not.toBeInTheDocument();
  });

  it('an error outcome and an image block are shown', async () => {
    fakeApi(
      routes({
        'POST /api/tools/files__write/test': {
          mode: 'model',
          outcome: 'tool_error',
          durationMs: 3,
          result: {
            isError: true,
            content: [
              { type: 'text', text: 'disk full' },
              { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
              { type: 'resource_link', uri: 'file:///notes.txt', name: 'notes' },
            ],
          },
        } satisfies TesterCallResponse,
      }),
    );
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const result = await screen.findByRole('region', { name: 'Result' });
    expect(within(result).getByText('Tool error')).toBeInTheDocument();
    expect(within(result).getByText('disk full')).toBeInTheDocument();
    // jsdom has no createImageBitmap: the block is described instead of drawn.
    expect(await within(result).findByText(/Image \(image\/png/)).toBeInTheDocument();
    expect(within(result).getByText(/Link to a resource/)).toHaveTextContent('file:///notes.txt');
  });

  it('an unavailable tool shows its server status and cannot be run', async () => {
    fakeApi(
      routes({
        'GET /api/servers': {
          servers: [server({ status: { state: 'needs_auth', since: 'x', detail: 'sign-in required' } })],
        },
        'GET /api/tools': { tools: [tool({ available: false })] },
      }),
    );
    renderApp('/tester?tool=files__write');
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('The tool is not available');
    expect(await within(note).findByText('Needs sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('picks a tool with search', async () => {
    fakeApi(
      routes({
        'GET /api/tools/search': {
          query: 'write',
          results: [
            {
              name: 'files__write',
              server: 'files',
              description: 'Writes a note.',
              inputSchema: {},
              available: true,
            },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/tester');
    await user.type(await screen.findByLabelText('Find a tool'), 'write');
    await user.click(await screen.findByRole('button', { name: /files__write/ }));
    await waitFor(() => expect(currentLocation()).toBe('/tester?tool=files__write'));
    expect(await screen.findByRole('heading', { name: 'files__write' })).toBeInTheDocument();
  });
});

describe('Tester: elicitation', () => {
  const asked: TesterCallResponse = {
    mode: 'model',
    outcome: 'input_required',
    durationMs: 5,
    result: {
      resultType: 'input_required',
      requestState: 'mcpier1.signed-state',
      inputRequests: {
        confirm: {
          method: 'elicitation/create',
          params: {
            message: 'Confirm "ship"?',
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean' } },
              required: ['confirm'],
            },
          },
        },
      },
    },
  };

  function answering() {
    const bodies: unknown[] = [];
    const api = fakeApi(
      routes({
        'POST /api/tools/files__write/test': (request: FakeCall) => {
          bodies.push(request.body);
          return { body: bodies.length === 1 ? asked : okResult('confirm_action ship: done') };
        },
      }),
    );
    return { ...api, bodies };
  }

  it.each([
    ['Accept', { action: 'accept', content: { confirm: true } }],
    ['Decline', { action: 'decline' }],
    ['Cancel', { action: 'cancel' }],
  ] as const)('%s retries with the answer and the signed state', async (button, expected) => {
    const { bodies } = answering();
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    await user.type(await screen.findByLabelText(/^text/), 'ship');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const request = await screen.findByRole('region', { name: 'Input request confirm' });
    expect(request).toHaveTextContent('Confirm "ship"?');
    if (button === 'Accept') await user.selectOptions(within(request).getByLabelText(/^confirm/), 'true');
    await user.click(within(request).getByRole('button', { name: button }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      mode: 'model',
      arguments: { text: 'ship' },
      inputResponses: { confirm: expected },
      requestState: 'mcpier1.signed-state',
    });
    expect(await screen.findByText('confirm_action ship: done')).toBeInTheDocument();
  });

  it('a request the Tester cannot draw is shown read-only, with decline and cancel only', async () => {
    fakeApi(
      routes({
        'POST /api/tools/files__write/test': {
          ...asked,
          result: {
            resultType: 'input_required',
            requestState: 'mcpier1.s',
            inputRequests: {
              open: {
                method: 'elicitation/create',
                params: { mode: 'url', message: 'Open this page', url: 'https://example.com' },
              },
            },
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    const request = await screen.findByRole('region', { name: 'Input request open' });
    expect(within(request).getByRole('note')).toHaveTextContent('cannot answer this request');
    expect(within(request).queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(within(request).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(within(request).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('Tester: session history', () => {
  it('lists the runs of this page session and shows an earlier one again', async () => {
    let n = 0;
    fakeApi(routes({ 'POST /api/tools/files__write/test': () => ({ body: okResult(`run number ${++n}`) }) }));
    const user = userEvent.setup();
    renderApp('/tester?tool=files__write');
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    await screen.findByText('run number 1');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByText('run number 2');
    const history = screen.getByRole('region', { name: 'Tester history' });
    const entries = within(history).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    await user.click(within(entries[1]!).getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('run number 1')).toBeInTheDocument();
    expect(screen.queryByText('run number 2')).not.toBeInTheDocument();
  });

  it('keeps the last 20 only, in memory', () => {
    for (let i = 0; i < HISTORY_SIZE + 5; i++) {
      act(() => {
        recordRun({ tool: 't', mode: 'raw', arguments: {}, response: okResult(String(i)) });
      });
    }
    fakeApi(routes());
    renderApp('/tester');
    return waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Tester history' })).getAllByRole('listitem'),
      ).toHaveLength(HISTORY_SIZE),
    );
  });
});
