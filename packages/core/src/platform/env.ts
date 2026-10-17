import { delimiter } from 'node:path';

/**
 * Environment for a spawned server: the gateway's own environment, then the `extraPath`
 * folders put in front of PATH, then the server's resolved `env` values (which win).
 * Windows treats variable names case-insensitively, so an existing `Path` is reused.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extraPath: readonly string[],
  serverEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (extraPath.length > 0) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const current = env[pathKey];
    env[pathKey] = [...extraPath, ...(current ? [current] : [])].join(delimiter);
  }
  for (const [key, value] of Object.entries(serverEnv)) {
    const existing = Object.keys(env).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
    if (existing && existing !== key) delete env[existing];
    env[key] = value;
  }
  return env;
}
