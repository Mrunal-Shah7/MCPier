// Helpers for OAuth tests: the OAuth fixture plus a real gateway (temporary home, random port,
// fake secret store), with the browser replaced by HTTP requests.
import { AUTH_API_PATHS, type McpierConfigInput, type SignInStartResponse } from '@mcpier/shared';
import { FakeSecretStore, type GatewayOptions } from '@mcpier/core';
import { startOAuthFixture, type OAuthFixture, type OAuthFixtureOptions } from '@mcpier/test-fixtures';
import { FAST_TIMING, startTestGateway, waitForStatus, type TestGateway } from './gateway.js';
import type { TempHome } from './temp-home.js';

/** A tool result as `call_tool` returns it. */
export interface CallToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** One 2026-07-28 request to /mcp (no handshake), answered as JSON or as one SSE message. */
async function mcpRequest(url: string, method: string, name: string, params: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'oauth-test-client', version: '1.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
        .find((message) => 'result' in message || 'error' in message)
    : (JSON.parse(text) as Record<string, unknown>);
  if (!json || 'error' in json) throw new Error(`/mcp answered an error: ${text}`);
  return json.result as CallToolResult;
}

export interface ApiAnswer<T = unknown> {
  status: number;
  body: T;
  text: string;
}

export interface OAuthWorld {
  fixture: OAuthFixture;
  t: TestGateway;
  secrets: FakeSecretStore;
  /** Every response body and page text seen through these helpers (for leak checks). */
  seen: string[];
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiAnswer<T>>;
  /** Starts a sign-in through the admin API (fails the test if it does not start). */
  startSignIn(server?: string): Promise<SignInStartResponse>;
  /** Follows an authorization URL through the fixture to the gateway's callback; returns the page. */
  finish(authorizationUrl: string): Promise<{ status: number; html: string; callbackUrl: string }>;
  /** Start, approve, callback, then wait until the server is ready. */
  signIn(server?: string): Promise<SignInStartResponse>;
  /** `call_tool` through the gateway's /mcp endpoint. */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Restarts the gateway on the same home and secret store (optionally another port). */
  restart(port?: number): Promise<void>;
  close(): Promise<void>;
}

export interface OAuthWorldOptions {
  fixture?: Partial<OAuthFixtureOptions>;
  /** Extra fields of the `notion` server entry. */
  server?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** More servers in the config. */
  servers?: Record<string, unknown>[];
  extra?: Partial<GatewayOptions>;
  secrets?: FakeSecretStore;
  home?: TempHome;
}

export const OAUTH_SERVER = 'notion';

export async function startOAuthWorld(options: OAuthWorldOptions = {}): Promise<OAuthWorld> {
  const fixture = await startOAuthFixture(options.fixture);
  const secrets = options.secrets ?? new FakeSecretStore();
  const seen: string[] = [];
  const config = (): McpierConfigInput =>
    ({
      settings: options.settings ?? {},
      servers: [
        { name: OAUTH_SERVER, transport: 'http', url: fixture.mcpUrl, auth: 'oauth', ...options.server },
        ...(options.servers ?? []),
      ],
    }) as McpierConfigInput;
  let t = await startTestGateway({
    timing: FAST_TIMING,
    config: config(),
    secrets,
    ...(options.home ? { home: options.home } : {}),
    extra: options.extra,
  });

  const world: OAuthWorld = {
    fixture,
    get t() {
      return t;
    },
    secrets,
    seen,
    async api<T>(method: string, path: string, body?: unknown) {
      const response = await fetch(`${t.gateway.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${t.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      // The start route's body is the authorization URL itself (state + PKCE challenge, by
      // design); every other answer goes into the leak corpus.
      if (!path.endsWith('/auth/login')) seen.push(text);
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T, text };
    },
    async startSignIn(server = OAUTH_SERVER) {
      const answer = await world.api<SignInStartResponse>('POST', AUTH_API_PATHS.login(server));
      if (answer.status !== 200) throw new Error(`sign-in did not start: ${answer.status} ${answer.text}`);
      return answer.body;
    },
    async finish(authorizationUrl: string) {
      const callbackUrl = await fixture.approve(authorizationUrl);
      const response = await fetch(callbackUrl);
      const html = await response.text();
      seen.push(html);
      return { status: response.status, html, callbackUrl };
    },
    async signIn(server = OAUTH_SERVER) {
      const started = await world.startSignIn(server);
      const page = await world.finish(started.authorizationUrl);
      if (page.status !== 200) throw new Error(`sign-in failed: ${page.html}`);
      await waitForStatus(t.gateway, server, 'ready');
      return started;
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await mcpRequest(`${t.gateway.url}/mcp`, 'tools/call', 'call_tool', {
        name: 'call_tool',
        arguments: { name, arguments: args },
      });
      seen.push(JSON.stringify(result));
      return result;
    },
    async restart(port?: number) {
      const home = t.home;
      await t.gateway.stop('test restart');
      t = await startTestGateway({
        timing: FAST_TIMING,
        home,
        secrets,
        // The same port unless told otherwise: callback URLs of earlier sign-ins point at it.
        port: port ?? t.port,
        extra: options.extra,
      });
    },
    async close() {
      await t.cleanup();
      if (options.home === undefined) await t.home.cleanup();
      await fixture.close();
    },
  };
  return world;
}

/** The text of a tool result's text blocks. */
export function resultText(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');
}
