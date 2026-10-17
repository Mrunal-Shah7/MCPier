// Sprint 6, Phase 4: the Settings page shows the autostart status (read-only) and the command
// that changes it.
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defaultConfig, type AutostartResponse, type AutostartStatus } from '@mcpier/shared';
import { fakeApi, renderApp, status } from './helpers';

const commands = { enable: 'mcpier autostart enable', disable: 'mcpier autostart disable' };

function routes(autostart: AutostartStatus | (() => { status: number; body: unknown })) {
  return {
    'GET /api/status': status(),
    'GET /api/settings': { settings: defaultConfig().settings },
    'GET /api/autostart':
      typeof autostart === 'function'
        ? autostart
        : ({ status: autostart, commands } satisfies AutostartResponse),
  } as Record<string, object>;
}

async function section() {
  return screen.findByRole('region', { name: 'Start with Windows' });
}

describe('Settings: Start with Windows', () => {
  it('off: says so and shows the enable command', async () => {
    fakeApi(routes({ enabled: false, taskName: 'MCPier' }));
    renderApp('/settings');
    const region = await section();
    expect(await within(region).findByText(/^Off:/)).toBeInTheDocument();
    expect(within(region).getByText('mcpier autostart enable')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Copy the autostart command' })).toBeInTheDocument();
  });

  it('on: names the task and shows the disable command', async () => {
    fakeApi(
      routes({
        enabled: true,
        taskName: 'MCPier',
        command: 'C:\\Windows\\System32\\conhost.exe',
        arguments: '--headless node.exe mcpier.js start',
        paths: [
          { role: 'node', path: 'C:\\node\\node.exe', exists: true },
          { role: 'cli', path: 'C:\\repo\\mcpier.js', exists: true },
        ],
      }),
    );
    renderApp('/settings');
    const region = await section();
    expect(await within(region).findByText(/^On: MCPier starts, hidden/)).toBeInTheDocument();
    expect(within(region).getByText('mcpier autostart disable')).toBeInTheDocument();
    expect(within(region).queryByText(/no longer exist/)).not.toBeInTheDocument();
  });

  it('on, pointing at a moved folder: says which path is gone', async () => {
    fakeApi(
      routes({
        enabled: true,
        taskName: 'MCPier',
        paths: [
          { role: 'node', path: 'C:\\node\\node.exe', exists: true },
          { role: 'cli', path: 'C:\\old\\mcpier.js', exists: false },
        ],
      }),
    );
    renderApp('/settings');
    const region = await section();
    expect(
      await within(region).findByText(/C:\\old\\mcpier\.js, which no longer exists/),
    ).toBeInTheDocument();
  });

  it('unknown, and an error from the route', async () => {
    fakeApi(
      routes({
        enabled: false,
        unknown: true,
        taskName: 'MCPier',
        detail: 'Task Scheduler is not available',
      }),
    );
    const first = renderApp('/settings');
    expect(
      await within(await section()).findByText(/Could not check it: Task Scheduler is not available/),
    ).toBeInTheDocument();
    first.unmount();

    fakeApi(routes(() => ({ status: 500, body: { error: { code: 'internal_error', message: 'x' } } })));
    renderApp('/settings');
    expect(await within(await section()).findByText(/cannot be checked here/)).toBeInTheDocument();
  });
});
