import { gatewayUrl, MCP_PATH } from '@mcpier/core';
import { StdioBridge } from '../bridge.js';
import { cliContext } from '../context.js';
import { CliError } from '../errors.js';
import { ensureGatewayRunning } from './start.js';

/** How long the bridge waits for a gateway it started to answer its health check. */
const BRIDGE_START_TIMEOUT_MS = 15_000;

/**
 * `mcpier stdio`: for clients that can only start a command. Starts the gateway if needed,
 * then relays MCP messages between this process's stdin/stdout and /mcp. stdout carries
 * protocol messages only; everything else goes to stderr.
 */
export async function stdioCommand(options: { cliEntry: string }): Promise<number> {
  const log = (line: string) => process.stderr.write(`mcpier stdio: ${line}\n`);
  const bridge = new StdioBridge({
    input: process.stdin,
    output: process.stdout,
    log,
    connect: async () => {
      try {
        const info = await ensureGatewayRunning(options.cliEntry, BRIDGE_START_TIMEOUT_MS);
        for (const line of info.lines) log(line);
        return new URL(`${gatewayUrl(info.port)}${MCP_PATH}`);
      } catch (error) {
        // Say where to look, in the error each waiting request gets.
        const { paths } = cliContext();
        const problems = error instanceof CliError ? (error.options.problems ?? []) : [];
        throw new CliError(`${(error as Error).message} MCPier's log: ${paths.gatewayLog}`, { problems });
      }
    },
  });
  await bridge.run();
  return 0;
}
