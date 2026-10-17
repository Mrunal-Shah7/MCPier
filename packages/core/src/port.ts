import type { McpierConfig } from '@mcpier/shared';

export const PORT_ENV = 'MCPIER_PORT';

/** The port to use: `MCPIER_PORT` if set, otherwise `settings.port` from the config. */
export function effectivePort(config: McpierConfig, env: NodeJS.ProcessEnv = process.env): number {
  const override = env[PORT_ENV]?.trim();
  if (!override) return config.settings.port;
  const port = Number(override);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${PORT_ENV} must be a whole number between 1024 and 65535 (got "${override}")`);
  }
  return port;
}
