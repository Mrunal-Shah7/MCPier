import { existsSync } from 'node:fs';
import { gatewayUrl, probeHealth, readAdminToken, type DataPaths } from '@mcpier/core';
import { ApiErrorResponseSchema, CLIENT_NAME_HEADER } from '@mcpier/shared';
import { cliContext, resolvePort } from './context.js';
import { CliError } from './errors.js';

/** A failed admin API call, carrying the API's own error code and problems. */
export class ApiCallError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    problems: readonly string[] = [],
  ) {
    super(message, { problems });
    this.name = 'ApiCallError';
  }
}

export interface Api {
  port: number;
  paths: DataPaths;
  request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** Opens a server-sent events stream (for `logs --follow`). */
  stream(path: string, signal: AbortSignal): Promise<Response>;
}

/**
 * Connects to the running gateway of this data directory. Every command that changes or reads
 * servers, tools or secrets goes through here: the gateway is the only writer of config.json.
 */
export async function connectApi(): Promise<Api> {
  const { paths } = cliContext();
  const port = await resolvePort(paths);
  const probe = await probeHealth(port);
  if (probe.kind !== 'mcpier') {
    throw new CliError('MCPier is not running.', { hint: 'Start it with: mcpier start' });
  }
  if (!existsSync(paths.adminToken)) {
    throw new CliError(`The MCPier gateway on port ${port} uses a different data directory.`);
  }
  const token = readAdminToken(paths.adminToken);
  const base = gatewayUrl(port);
  // The client name lands in the search and call records.
  const headers = { authorization: `Bearer ${token}`, [CLIENT_NAME_HEADER]: 'mcpier-cli' };

  return {
    port,
    paths,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new CliError(`Lost the connection to the gateway: ${(error as Error).message}`, {
          hint: 'Check it with: mcpier status',
        });
      }
      const text = await response.text();
      const json: unknown = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const parsed = ApiErrorResponseSchema.safeParse(json);
        if (response.status === 401) {
          throw new ApiCallError(
            `The MCPier gateway on port ${port} uses a different data directory.`,
            401,
            'unauthorized',
          );
        }
        if (parsed.success) {
          throw new ApiCallError(
            parsed.data.error.message,
            response.status,
            parsed.data.error.code,
            parsed.data.error.problems,
          );
        }
        throw new ApiCallError(`The gateway answered HTTP ${response.status}.`, response.status, 'unknown');
      }
      return json as T;
    },
    async stream(path: string, signal: AbortSignal): Promise<Response> {
      const response = await fetch(`${base}${path}`, { headers, signal });
      if (!response.ok || !response.body) {
        const parsed = ApiErrorResponseSchema.safeParse(await response.json().catch(() => ({})));
        throw new ApiCallError(
          parsed.success ? parsed.data.error.message : `The gateway answered HTTP ${response.status}.`,
          response.status,
          parsed.success ? parsed.data.error.code : 'unknown',
        );
      }
      return response;
    },
  };
}
