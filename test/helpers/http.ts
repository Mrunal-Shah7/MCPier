import { request } from 'node:http';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
}

/**
 * A plain HTTP request to 127.0.0.1 with full control over headers, including `Host`
 * (which `fetch` does not allow overriding).
 */
export function httpRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body) as T,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
