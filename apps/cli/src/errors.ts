/** An error meant for the user: printed as one line (plus an optional hint), no stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly options: { hint?: string; exitCode?: number; problems?: readonly string[] } = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Prints an error the way every command does, and returns the exit code to use. */
export function reportError(error: unknown, debug: boolean): number {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mcpier: ${message}`);
  if (error instanceof CliError) {
    for (const problem of error.options.problems ?? []) console.error(`  - ${problem}`);
    if (error.options.hint) console.error(`Hint: ${error.options.hint}`);
  }
  if (debug && error instanceof Error && error.stack) console.error(error.stack);
  else if (!(error instanceof CliError)) console.error('Run again with --debug for details.');
  return error instanceof CliError ? (error.options.exitCode ?? 1) : 1;
}
