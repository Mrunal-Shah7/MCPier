// The one module that talks to the admin API. Same origin, so the browser sends the
// HTTP-only admin cookie by itself: the dashboard never sees or handles the token.
import { CLIENT_NAME_HEADER, type ApiErrorCode } from '@mcpier/shared';

/** The name MCPier records for the dashboard's searches and calls. */
export const DASHBOARD_CLIENT_NAME = 'dashboard';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode | 'network' | 'unknown',
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const unauthorizedListeners = new Set<() => void>();

/** Called whenever any request answers 401: the browser is (no longer) signed in. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Turns the standard error shape `{ error: { code, message, problems? } }` into an ApiError. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = (body as { error?: { code?: unknown; message?: unknown; problems?: unknown } } | undefined)
    ?.error;
  if (error && typeof error.message === 'string') {
    const problems = Array.isArray(error.problems)
      ? error.problems.filter((p): p is string => typeof p === 'string')
      : [];
    return new ApiError(error.message, response.status, (error.code as ApiErrorCode) ?? 'unknown', problems);
  }
  return new ApiError(`MCPier answered HTTP ${response.status}.`, response.status, 'unknown');
}

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    [CLIENT_NAME_HEADER]: DASHBOARD_CLIENT_NAME,
    accept: 'application/json',
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the MCPier gateway. Is it running? (mcpier start)', 0, 'network');
  }
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (error.unauthorized) for (const listener of unauthorizedListeners) listener();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** A message for people: the error's own message, plus its problems as lines. */
export function describeError(error: unknown): { message: string; problems: readonly string[] } {
  if (error instanceof ApiError) return { message: error.message, problems: error.problems };
  return { message: (error as Error)?.message ?? String(error), problems: [] };
}
