// Sprint 7, Phase 5: the Edit page's JSON tab: the stored entry, validation as you type with
// line numbers, syntax errors by line and column only, Format, switching tabs both ways, the
// unsaved-changes guard, the credential warning, Save as secret, and saving with PUT.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDetailResponse } from '@mcpier/shared';
import { UNSAVED_MESSAGE } from '@/lib/unsaved-guard';
import { currentLocation, fakeApi, renderApp, server, status, type FakeCall } from './helpers';

const PLAIN_TOKEN = 'plain-token-value-4444-abcd';
const CLIENT_SECRET = 'console-client-secret-9876';

function stdioEntry(): ServerDetailResponse['config'] {
  return {
    name: 'files',
    description: 'Local files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'fs'],
    env: { GH: 'secret:github-token' },
    enabled: true,
    timeoutMs: 60000,
    startupTimeoutMs: 90000,
    disabledTools: ['delete_file'],
    protocol: 'auto',
  } as ServerDetailResponse['config'];
}

function routes(config = stdioEntry(), extra: Record<string, object> = {}): Record<string, object> {
  return {
    'GET /api/status': status(),
    'GET /api/servers': { servers: [server({ name: config.name })] },
    'GET /api/secrets': { secrets: [{ name: 'github-token', usedBy: ['files'] }], missing: [] },
    [`GET /api/servers/${config.name}`]: { server: server({ name: config.name }), config, tools: [] },
    ...extra,
  };
}

async function openJson(user: ReturnType<typeof userEvent.setup>, name = 'files') {
  await user.click(await screen.findByRole('tab', { name: 'JSON' }));
  return screen.getByLabelText(`${name} as JSON`) as HTMLTextAreaElement;
}

const setText = (area: HTMLTextAreaElement, text: string) =>
  fireEvent.change(area, { target: { value: text } });
const json = (value: unknown) => JSON.stringify(value, null, 2);

afterEach(() => vi.restoreAllMocks());

describe('JSON editor', () => {
  it('shows the stored entry, references as references, and says it is valid', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    expect(JSON.parse(area.value)).toEqual(stdioEntry());
    expect(area.value).toContain('"GH": "secret:github-token"');
    expect(document.querySelector('[data-json-state="valid"]')).toHaveTextContent('Valid');
    expect(screen.getByText("Saving replaces the whole entry · name can't change here")).toBeInTheDocument();
    // One gutter number per line.
    expect(document.querySelectorAll('[data-slot="gutter"] > div')).toHaveLength(
      area.value.split('\n').length,
    );
  });

  it('validates as you type, listing problems with their line numbers and marking the gutter', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, json({ ...stdioEntry(), name: 'other', timeoutMs: 'soon' }));
    const problems = await screen.findByRole('list', { name: 'Problems' });
    const lines = area.value.split('\n');
    const nameLine = lines.findIndex((line) => line.includes('"name"')) + 1;
    const timeoutLine = lines.findIndex((line) => line.includes('"timeoutMs"')) + 1;
    expect(problems).toHaveTextContent(`Line ${nameLine}: name: must stay "files"`);
    expect(problems).toHaveTextContent(new RegExp(`Line ${timeoutLine}: timeoutMs:`));
    expect(document.querySelector('[data-json-state="invalid"]')).toHaveTextContent('2 problems');
    const gutter = [...document.querySelectorAll('[data-slot="gutter"] > div')];
    expect(gutter[timeoutLine - 1]!.className).toContain('text-tone-bad-text');
    expect(gutter[0]!.className).not.toContain('text-tone-bad-text');
    expect(screen.getByRole('button', { name: 'Save JSON' })).toBeDisabled();
  });

  it("a syntax error shows only its line and column, never the parser's message or the text", async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, `{\n  "name": "files",\n  "env": { "KEY": "${PLAIN_TOKEN}" \n}`);
    const problems = await screen.findByRole('list', { name: 'Problems' });
    expect(problems.textContent).toMatch(/^Line \d+: Not valid JSON at line \d+, column \d+\.$/);
    expect(problems.textContent).not.toContain(PLAIN_TOKEN);
    expect(problems.textContent).not.toMatch(/Unexpected|Expected|position/);
    expect(document.querySelector('[data-json-state="invalid"]')).toHaveTextContent('Not JSON');
  });

  it('Format re-indents valid JSON and leaves invalid JSON alone', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, JSON.stringify(stdioEntry()));
    await user.click(screen.getByRole('button', { name: 'Format' }));
    expect(area.value).toBe(json(stdioEntry()));
    setText(area, '{ "name": ');
    await user.click(screen.getByRole('button', { name: 'Format' }));
    expect(area.value).toBe('{ "name": ');
  });

  it('Tab inserts two spaces', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, '{}');
    area.setSelectionRange(1, 1);
    fireEvent.keyDown(area, { key: 'Tab' });
    expect(area.value).toBe('{  }');
  });

  it('Form → JSON carries unsaved form edits over, keeping keys the form does not show', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const description = await screen.findByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Shared files');
    const area = await openJson(user);
    const entry = JSON.parse(area.value);
    expect(entry.description).toBe('Shared files');
    expect(entry.disabledTools).toEqual(['delete_file']);
    expect(entry.env).toEqual({ GH: 'secret:github-token' });
  });

  it('JSON → Form is refused while the JSON is invalid, and carries a valid edit over', async () => {
    fakeApi(routes());
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, '{ "name": ');
    await user.click(screen.getByRole('tab', { name: 'Form' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The JSON has problems; fix them before going back to the form.',
    );
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');
    setText(area, json({ ...stdioEntry(), description: 'From JSON' }));
    await user.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Description')).toHaveValue('From JSON');
  });

  it('asks before leaving with unsaved JSON, and stays when told to', async () => {
    fakeApi(routes());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, json({ ...stdioEntry(), description: 'Changed' }));
    await user.click(screen.getByRole('link', { name: 'Tester' }));
    expect(confirm).toHaveBeenCalledWith(UNSAVED_MESSAGE);
    expect(currentLocation()).toBe('/servers/files/edit');
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('link', { name: 'Tester' }));
    await waitFor(() => expect(currentLocation()).toBe('/tester'));
  });

  it('does not ask when nothing changed', async () => {
    fakeApi(routes());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    await openJson(user);
    await user.click(screen.getByRole('link', { name: 'Tester' }));
    await waitFor(() => expect(currentLocation()).toBe('/tester'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('warns about plain credential values by key, and offers Move to secret after saving', async () => {
    let put: FakeCall | undefined;
    fakeApi(
      routes(stdioEntry(), {
        'PUT /api/servers/files': (call: FakeCall) => {
          put = call;
          return { body: { server: server(), warnings: [] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, json({ ...stdioEntry(), env: { GH: 'secret:github-token', API_TOKEN: PLAIN_TOKEN } }));
    const note = await screen.findByText(/Plain values that look like credentials/);
    expect(note).toHaveTextContent('API_TOKEN');
    expect(note.textContent).not.toContain(PLAIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Save JSON' }));
    await waitFor(() => expect(put).toBeDefined());
    expect(await screen.findByRole('button', { name: 'Move API_TOKEN to secret' })).toBeInTheDocument();
  });

  it('a save right after typing sends the text as it is now, not the last checked text', async () => {
    let put: FakeCall | undefined;
    fakeApi(
      routes(stdioEntry(), {
        'PUT /api/servers/files': (call: FakeCall) => {
          put = call;
          return { body: { server: server(), warnings: [] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    // Within the 300 ms check delay: the badge still shows the earlier, valid text.
    setText(area, json({ ...stdioEntry(), description: 'Typed just now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));
    await waitFor(() => expect(put).toBeDefined());
    expect((put!.body as { description: string }).description).toBe('Typed just now');
  });

  it('a save sends the whole entry to the replace route, shows warnings, and the Form follows', async () => {
    let put: FakeCall | undefined;
    const edited = { ...stdioEntry(), description: 'Saved from JSON', team: 'alpha' };
    fakeApi(
      routes(stdioEntry(), {
        'PUT /api/servers/files': (call: FakeCall) => {
          put = call;
          return { body: { server: server(), warnings: ['team: not used by MCPier'] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, json(edited));
    expect(await screen.findByRole('note')).toHaveTextContent('Not used by MCPier (kept as written): team');
    await user.click(screen.getByRole('button', { name: 'Save JSON' }));
    await waitFor(() => expect(put).toBeDefined());
    expect(put!.method).toBe('PUT');
    expect(put!.path).toBe('/api/servers/files');
    expect(put!.body).toEqual(edited);
    expect(await screen.findByText('Saved files.')).toBeInTheDocument();
    expect(screen.getByText('team: not used by MCPier')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Saved from JSON');
  });

  it('a refused save shows the problems and keeps the text', async () => {
    fakeApi(
      routes(stdioEntry(), {
        'PUT /api/servers/files': () => ({
          status: 400,
          body: {
            error: {
              code: 'invalid_request',
              message: 'The server entry is invalid.',
              problems: ['command: required'],
            },
          },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/files/edit');
    const area = await openJson(user);
    setText(area, json({ ...stdioEntry(), description: 'x' }));
    await user.click(screen.getByRole('button', { name: 'Save JSON' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save');
    expect(alert).toHaveTextContent('command: required');
    expect(JSON.parse(area.value).description).toBe('x');
  });
});

describe('JSON editor: a plain OAuth client secret', () => {
  const httpEntry = {
    name: 'notion',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: {},
    auth: 'oauth',
    oauth: { clientId: 'from-console' },
    enabled: true,
    timeoutMs: 60000,
    startupTimeoutMs: 90000,
    disabledTools: [],
    protocol: 'auto',
  } as unknown as ServerDetailResponse['config'];

  it('is refused, and Save as secret stores it and puts the reference in its place', async () => {
    let stored: FakeCall | undefined;
    const { calls } = fakeApi(
      routes(httpEntry, {
        'PUT /api/secrets/notion-client-secret': (call: FakeCall) => {
          stored = call;
          return { body: { name: 'notion-client-secret', restarted: [] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/servers/notion/edit');
    const area = await openJson(user, 'notion');
    setText(area, json({ ...httpEntry, oauth: { clientId: 'from-console', clientSecret: CLIENT_SECRET } }));
    expect(await screen.findByText('oauth.clientSecret must be a secret: reference.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Problems' })).getByText(/oauth\.clientSecret/),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Problems' }).textContent).not.toContain(CLIENT_SECRET);
    expect(screen.getByRole('button', { name: 'Save JSON' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save as secret' }));
    await waitFor(() => expect(stored).toBeDefined());
    expect(stored!.body).toEqual({ value: CLIENT_SECRET });
    await waitFor(() =>
      expect(JSON.parse(area.value).oauth.clientSecret).toBe('secret:notion-client-secret'),
    );
    expect(area.value).not.toContain(CLIENT_SECRET);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save JSON' })).toBeEnabled());
    // The value went out once, to the secrets route only.
    expect(calls.filter((call) => JSON.stringify(call.body ?? '').includes(CLIENT_SECRET))).toHaveLength(1);
  });
});
