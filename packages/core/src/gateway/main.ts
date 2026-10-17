import { resolveDataDir } from '../data-dir.js';
import { getPlatform } from '../platform/index.js';
import { GatewayStartError, startGateway } from './gateway.js';

export interface RunGatewayOptions {
  /** Running in the user's terminal: log to the console too, and print start-up errors. */
  foreground: boolean;
  /** The CLI entry script running this gateway (for the dashboard's connect snippets). */
  cliEntry?: string;
}

/**
 * Runs the gateway as the current process until it is stopped (admin API, Ctrl+C or a
 * termination signal). Resolves with the exit code the process should use.
 */
export async function runGatewayProcess(options: RunGatewayOptions): Promise<number> {
  const platform = getPlatform();
  let gateway;
  try {
    gateway = await startGateway({
      dataDir: resolveDataDir(platform),
      platform,
      consoleLog: options.foreground,
      childGuard: true,
      ...(options.cliEntry ? { cliEntry: options.cliEntry } : {}),
    });
  } catch (error) {
    // In the background these messages go nowhere; the gateway log already has them, and
    // `mcpier start` prints the end of the log when the gateway fails to come up.
    if (options.foreground) {
      console.error(
        error instanceof GatewayStartError
          ? error.message
          : `Gateway failed to start: ${(error as Error).message}`,
      );
    }
    return 1;
  }

  if (options.foreground) {
    console.log(`MCPier gateway running at ${gateway.url} (pid ${gateway.pid}). Press Ctrl+C to stop.`);
  }

  const running = gateway;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
    process.on(signal, () => void running.stop(`signal ${signal}`));
  }
  let exitCode = 0;
  process.on('uncaughtException', (error) => {
    running.logger.fatal({ err: { message: error.message, stack: error.stack } }, 'Uncaught exception');
    exitCode = 1;
    void running.stop('uncaught exception');
  });

  await running.stopped;
  return exitCode;
}
