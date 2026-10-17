import { gatewayUrl } from '@mcpier/core';
import { DASHBOARD_API_PATHS, type SessionCodeResponse } from '@mcpier/shared';
import { connectApi } from '../api.js';
import { cliContext } from '../context.js';
import { ensureGatewayRunning } from './start.js';

/**
 * `mcpier open`: signs the browser in and opens the dashboard. The admin token never goes
 * into the URL: the gateway hands out a one-time code (60 seconds, single use), the browser
 * opens the hand-off URL with that code, and the gateway swaps it for the admin cookie.
 */
export async function openCommand(options: { cliEntry: string; printUrl?: boolean }): Promise<number> {
  const started = await ensureGatewayRunning(options.cliEntry);
  if (started.started) for (const line of started.lines) console.log(line);

  const api = await connectApi();
  const { path } = await api.request<SessionCodeResponse>('POST', DASHBOARD_API_PATHS.sessionCode);
  // Always 127.0.0.1: the cookie belongs to the host name the hand-off used.
  const url = `${gatewayUrl(api.port)}${path}`;
  if (options.printUrl) {
    console.log(url);
    console.error('This link signs a browser in once, within 60 seconds. Do not share it.');
    return 0;
  }
  await cliContext().platform.openUrl(url);
  console.log(`Opened the dashboard: ${gatewayUrl(api.port)}/`);
  return 0;
}
