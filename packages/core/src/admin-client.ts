import {
  HEALTH_PATH,
  HealthResponseSchema,
  StatusResponseSchema,
  type HealthResponse,
  type StatusResponse,
} from '@mcpier/shared';

export type HealthProbe =
  /** MCPier answered the health check. */
  | { kind: 'mcpier'; health: HealthResponse }
  /** Something answered on the port, but it is not MCPier. */
  | { kind: 'other' }
  /** Nothing is listening (or it did not answer in time). */
  | { kind: 'none' };

export function gatewayUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Checks `GET /healthz` on 127.0.0.1:port. Never throws. */
export async function probeHealth(port: number, timeoutMs = 1500): Promise<HealthProbe> {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl(port)}${HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { kind: 'none' };
  }
  try {
    const parsed = HealthResponseSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'mcpier', health: parsed.data } : { kind: 'other' };
  } catch {
    return { kind: 'other' };
  }
}

/** The admin API rejected the token: the gateway on this port uses a different data directory. */
export class AdminAuthError extends Error {
  constructor(port: number) {
    super(
      `The MCPier gateway on port ${port} rejected the admin token (it uses a different data directory).`,
    );
    this.name = 'AdminAuthError';
  }
}

/** Minimal admin API client used by the CLI and by the gateway's own port check. */
export class AdminClient {
  constructor(
    readonly port: number,
    private readonly token: string,
    private readonly timeoutMs = 5000,
  ) {}

  private async request(method: 'GET' | 'POST', path: string): Promise<unknown> {
    const response = await fetch(`${gatewayUrl(this.port)}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401) throw new AdminAuthError(this.port);
    const body = (await response.json().catch(() => undefined)) as
      { error?: { message?: string } } | undefined;
    if (!response.ok) {
      throw new Error(
        `${method} ${path} failed (${response.status}): ${body?.error?.message ?? 'no details'}`,
      );
    }
    return body;
  }

  async status(): Promise<StatusResponse> {
    return StatusResponseSchema.parse(await this.request('GET', '/api/status'));
  }

  async shutdown(): Promise<void> {
    await this.request('POST', '/api/shutdown');
  }
}
