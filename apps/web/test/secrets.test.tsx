// Phase 4: the Secrets page: list, missing references, set, replace (field cleared),
// delete refused while referenced, and forced delete.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, renderApp, status } from './helpers';

const VALUE = 'new-secret-value-1234-5678';

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/status': status(),
    'GET /api/secrets': {
      secrets: [
        { name: 'github-token', last4: 'wxyz', usedBy: ['github'] },
        { name: 'unused-key', usedBy: [] },
      ],
      missing: [{ name: 'notion-key', usedBy: ['notion'] }],
    },
    ...extra,
  };
}

describe('Secrets page', () => {
  it('lists names, last four characters, users, and highlights missing references', async () => {
    fakeApi(routes());
    renderApp('/secrets');
    const row = (await screen.findByText('github-token')).closest('tr')!;
    expect(row).toHaveTextContent('…wxyz');
    expect(row).toHaveTextContent('github');
    expect(screen.getByText('unused-key').closest('tr')).toHaveTextContent('nothing');
    const missing = screen.getByText('Referenced but not set').closest('[role="alert"]') as HTMLElement;
    expect(missing).toHaveTextContent('notion-key');
    expect(missing).toHaveTextContent('used by notion');
  });

  it('sets a new secret through a masked field, and says which servers restarted', async () => {
    let sent: unknown;
    const { calls } = fakeApi(
      routes({
        'PUT /api/secrets/brave-key': (call: { body: unknown }) => {
          sent = call.body;
          return { body: { name: 'brave-key', restarted: ['brave'] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/secrets');
    await user.click(await screen.findByRole('button', { name: 'New secret' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Bad Name');
    expect(within(dialog).getByText(/must be a lowercase slug/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'brave-key');
    const value = within(dialog).getByLabelText('Value');
    expect(value).toHaveAttribute('type', 'password');
    await user.type(value, VALUE);
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(sent).toEqual({ value: VALUE }));
    expect(await screen.findByText('Saved the secret brave-key.')).toBeInTheDocument();
    expect(screen.getByText('Restarted brave to use it.')).toBeInTheDocument();
    // The value went out once, in the request body only.
    expect(calls.filter((call) => JSON.stringify(call.body ?? '').includes(VALUE))).toHaveLength(1);
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it('replace: the field is cleared afterwards, even when it fails', async () => {
    let fail = true;
    fakeApi(
      routes({
        'PUT /api/secrets/github-token': () =>
          fail
            ? { status: 400, body: { error: { code: 'invalid_request', message: 'The value is too long.' } } }
            : { body: { name: 'github-token', restarted: ['github'] } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/secrets');
    const row = (await screen.findByText('github-token')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Replace' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Replace github-token');
    await user.type(within(dialog).getByLabelText('Value'), VALUE);
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
    expect(await within(dialog).findByText('The value is too long.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Value')).toHaveValue('');
    fail = false;
    await user.type(within(dialog).getByLabelText('Value'), VALUE);
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Opening it again starts empty.
    await user.click(within(row).getByRole('button', { name: 'Replace' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Value')).toHaveValue('');
  });

  it('delete of a referenced secret explains who uses it and needs "delete it anyway"', async () => {
    let deletedPath: string | undefined;
    fakeApi(
      routes({
        'DELETE /api/secrets/github-token': (call: { path: string }) => {
          deletedPath = call.path;
          return { body: { name: 'github-token', deleted: true, restarted: ['github'] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/secrets');
    const row = (await screen.findByText('github-token')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Used by github');
    const confirm = within(dialog).getByRole('button', { name: 'Delete github-token' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Delete it anyway' }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(deletedPath).toBe('/api/secrets/github-token?force=true'));
  });

  it('delete of an unused secret needs no force', async () => {
    let deletedPath: string | undefined;
    fakeApi(
      routes({
        'DELETE /api/secrets/unused-key': (call: { path: string }) => {
          deletedPath = call.path;
          return { body: { name: 'unused-key', deleted: true, restarted: [] } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/secrets');
    const row = (await screen.findByText('unused-key')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Delete unused-key' }));
    await waitFor(() => expect(deletedPath).toBe('/api/secrets/unused-key'));
  });

  it('empty and error states', async () => {
    fakeApi({ 'GET /api/status': status(), 'GET /api/secrets': { secrets: [], missing: [] } });
    renderApp('/secrets');
    expect(await screen.findByText('No secrets yet')).toBeInTheDocument();
  });

  it('error', async () => {
    fakeApi({
      'GET /api/status': status(),
      'GET /api/secrets': () => ({
        status: 500,
        body: { error: { code: 'internal_error', message: 'Credential Manager failed.' } },
      }),
    });
    renderApp('/secrets');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the secrets');
  });
});
