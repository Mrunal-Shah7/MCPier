#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { projectVersion, runGatewayProcess } from '@mcpier/core';
import { authCimdDocument, authLogin, authLogout, authRefresh, authStatus } from './commands/auth.js';
import { secretDelete, secretList, secretSet } from './commands/secret.js';
import {
  serverAction,
  serverAdd,
  serverImport,
  serverList,
  serverLogs,
  serverRemove,
  serverShow,
  type ServerAddOptions,
  type ServerImportOptions,
} from './commands/server.js';
import { applyStartOverrides, startCommand } from './commands/start.js';
import { autostartDisable, autostartEnable, autostartStatus } from './commands/autostart.js';
import { doctorCommand } from './commands/doctor.js';
import { stdioCommand } from './commands/stdio.js';
import { toolsCall, toolsList, toolsSearch, toolsToggle } from './commands/tools.js';
import { connectCommand } from './commands/connect.js';
import { openCommand } from './commands/open.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { reportError } from './errors.js';

/** This script's own path: the background gateway is started by running it again. */
const CLI_ENTRY = fileURLToPath(import.meta.url);

const program = new Command('mcpier')
  .description('MCPier: one local MCP gateway in front of all your MCP servers.')
  .version(projectVersion(), '-v, --version', 'print the MCPier version')
  .option('--debug', 'show full error details')
  .helpOption('-h, --help', 'show help')
  .showHelpAfterError('(run "mcpier --help" for the list of commands)');

/** Runs a command and turns its result (or error) into the process exit code. */
async function run(action: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (error) {
    process.exitCode = reportError(error, Boolean(program.opts<{ debug?: boolean }>().debug));
  }
}

/**
 * Exits once stdout and stderr are flushed. HTTP keep-alive sockets from the health checks
 * would otherwise hold the process open for a few seconds after the command is done.
 */
function exitWhenFlushed(): void {
  const code = Number(process.exitCode ?? 0);
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

program
  .command('start')
  .description('start the gateway in the background')
  .option('--foreground', 'run the gateway in this terminal; Ctrl+C stops it')
  .option('--home <dir>', 'the data directory to use (instead of the MCPIER_HOME variable)')
  .option('--port <n>', 'the port to use (instead of the MCPIER_PORT variable)')
  .action((options: { foreground?: boolean; home?: string; port?: string }) =>
    run(async () => {
      // Before anything resolves the data directory or the port; the background gateway
      // inherits them. The autostart task uses these (a task cannot set variables).
      applyStartOverrides(options);
      return startCommand({ foreground: options.foreground, cliEntry: CLI_ENTRY });
    }),
  );

program
  .command('stop')
  .description('stop the running gateway')
  .action(() => run(stopCommand));

program
  .command('status')
  .description('show whether the gateway is running (exit code 3 when stopped)')
  .option('--json', 'print machine-readable JSON')
  .action((options: { json?: boolean }) => run(() => statusCommand(options)));

// ---- server

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Help text listing example commands (written for Git Bash). */
const examples = (...lines: string[]) =>
  ['', 'Examples (Git Bash):', ...lines.map((line) => `  ${line}`)].join('\n');

const server = program
  .command('server')
  .description('add, change and manage upstream MCP servers')
  .addHelpText(
    'after',
    `
Examples (Git Bash):
  mcpier server list
  mcpier server add files -- npx -y @modelcontextprotocol/server-filesystem "C:\\Users\\me\\mcpier-test"
  mcpier secret set github-token
  mcpier server add github --url <url from the server's README> --header "Authorization: Bearer secret:github-token"
  mcpier server import servers.json`,
  );

server
  .command('list')
  .description('list servers with status, protocol version, tool counts and last error')
  .option('--json', 'print machine-readable JSON')
  .addHelpText('after', examples('mcpier server list', 'mcpier server list --json'))
  .action((options: { json?: boolean }) => run(() => serverList(options)));

server
  .command('add <name> [command...]')
  .description('add a stdio server (command after --) or a remote server (--url)')
  .option('--url <url>', 'remote server URL (Streamable HTTP)')
  .option('--oauth', 'the remote server signs in with OAuth')
  .option(
    '--scope <scope>',
    'OAuth scope to request, repeatable (a value with spaces is split); exactly these are requested. Implies --oauth',
    collect,
  )
  .option('--client-id <id>', "OAuth client ID registered in the provider's console. Implies --oauth")
  .option(
    '--client-secret <secret:name>',
    'its client secret, only as a reference (store it first with: mcpier secret set <name>). Implies --oauth',
  )
  .option(
    '--header <"Name: value">',
    'request header, repeatable; the value may be "Bearer secret:<name>"',
    collect,
  )
  .option('--env <KEY=VALUE>', 'environment variable, repeatable; the value may be secret:<name>', collect)
  .option('--description <text>', 'one-line description')
  .option('--protocol <mode>', 'protocol negotiation: auto (default), legacy or modern')
  .option('--timeout <ms>', 'per-call time limit in milliseconds (default 60000)')
  .option('--startup-timeout <ms>', 'how long starting may take, in milliseconds (default 90000)')
  .option('--disabled', 'add it without starting it')
  .addHelpText(
    'after',
    `
Examples (Git Bash):
  mcpier server add files -- npx -y @modelcontextprotocol/server-filesystem "C:\\Users\\me\\mcpier-test"
  mcpier server add github --env GITHUB_PERSONAL_ACCESS_TOKEN=secret:github-token -- "C:\\tools\\github-mcp-server.exe" stdio
  mcpier server add github-remote --url <url from the server's README> --header "Authorization: Bearer secret:github-token"
  mcpier server add notion --url <url from the server's README> --oauth
  mcpier secret set linear-client-secret
  mcpier server add linear --url <url> --client-id <id> --client-secret secret:linear-client-secret --scope read --scope write

Git Bash turns arguments that start with "/" into paths. For "cmd /c …" commands, run
the command with MSYS_NO_PATHCONV=1 in front, or import the server from a JSON file.`,
  )
  .action((name: string, command: string[], options: ServerAddOptions) =>
    run(() => serverAdd(name, command, options)),
  );

server
  .command('import <file>')
  .description('add servers from an mcpServers JSON block in a file (or "-" for standard input)')
  .option('--dry-run', 'show what would be created without saving anything')
  .option('--move-secrets', 'store every credential-looking value in Credential Manager without asking')
  .option('--keep-secrets', 'keep credential-looking values as plain text without asking')
  .addHelpText(
    'after',
    `
Accepts {"mcpServers": {...}}, VS Code's {"servers": {...}}, or a bare map of entries.
In a terminal, MCPier asks for each credential-looking value whether to move it into
Credential Manager. Without a terminal and without a flag, values stay plain (with a warning).

Examples (Git Bash):
  mcpier server import claude_desktop_config.json --dry-run
  cat servers.json | mcpier server import - --move-secrets`,
  )
  .action((file: string, options: ServerImportOptions) => run(() => serverImport(file, options)));

server
  .command('show <name>')
  .description('show a server: config as stored, status with detail, and tools')
  .option('--json', 'print machine-readable JSON')
  .addHelpText('after', examples('mcpier server show files', 'mcpier server show files --json'))
  .action((name: string, options: { json?: boolean }) => run(() => serverShow(name, options)));

for (const [action, description] of [
  ['enable', 'enable a server (and start it)'],
  ['disable', 'disable a server (and stop it)'],
  ['start', 'start a stopped, failed or crashed server'],
  ['stop', 'stop a server until it is started again (stays enabled)'],
  ['restart', 'restart a server'],
  ['refresh', 'list a server’s tools again'],
] as const) {
  const command = server
    .command(`${action} <name>`)
    .description(description)
    .addHelpText('after', examples(`mcpier server ${action} files`));
  // enable and disable can report the resulting server as JSON.
  if (action === 'enable' || action === 'disable') {
    command.option('--json', 'print the resulting server as JSON');
  }
  command.action((name: string, options: { json?: boolean }) =>
    run(() => serverAction(action, name, options)),
  );
}

server
  .command('remove <name>')
  .description('remove a server (stops it and drops its tools)')
  .addHelpText('after', examples('mcpier server remove files'))
  .action((name: string) => run(() => serverRemove(name)));

server
  .command('logs <name>')
  .description("print a server's recent log lines (stderr, protocol logs, connection events)")
  .option('--lines <n>', 'how many lines (default 50)')
  .option('--follow', 'keep printing new lines until Ctrl+C')
  .addHelpText('after', examples('mcpier server logs files --lines 20', 'mcpier server logs files --follow'))
  .action((name: string, options: { lines?: string; follow?: boolean }) =>
    run(() => serverLogs(name, options)),
  );

// ---- tools

const tools = program
  .command('tools')
  .description('list, toggle and call tools')
  .addHelpText(
    'after',
    examples(
      'mcpier tools list --server files',
      'mcpier tools disable files__write_file',
      `mcpier tools call files__read_file --args '{"path":"C:\\\\Users\\\\me\\\\notes.txt"}'`,
    ),
  );

tools
  .command('list')
  .description('list enabled, available tools (by full name server__tool)')
  .option('--server <name>', 'only this server')
  .option('--all', 'include disabled and unavailable tools, marked')
  .option('--json', 'print machine-readable JSON')
  .addHelpText(
    'after',
    examples('mcpier tools list', 'mcpier tools list --server files --all', 'mcpier tools list --json'),
  )
  .action((options: { server?: string; all?: boolean; json?: boolean }) => run(() => toolsList(options)));

tools
  .command('enable <full-name>')
  .description('enable one tool')
  .addHelpText('after', examples('mcpier tools enable files__write_file'))
  .action((fullName: string) => run(() => toolsToggle(fullName, true)));

tools
  .command('disable <full-name>')
  .description('disable one tool (it stays listed with --all)')
  .addHelpText('after', examples('mcpier tools disable files__write_file'))
  .action((fullName: string) => run(() => toolsToggle(fullName, false)));

tools
  .command('search <query>')
  .description('search tools by what they do (the same search clients get through MCPier)')
  .option('--limit <n>', 'how many matches (1-20, default 5)')
  .option('--server <name>', 'only this server')
  .option('--json', 'print machine-readable JSON')
  .addHelpText(
    'after',
    examples(
      'mcpier tools search "list directory"',
      'mcpier tools search issue --server github --limit 10',
      'mcpier tools search "read file" --json',
    ),
  )
  .action((query: string, options: { limit?: string; server?: string; json?: boolean }) =>
    run(() => toolsSearch(query, options)),
  );

tools
  .command('call <full-name>')
  .description('call a tool and print its result')
  .option('--args <json>', 'arguments as a JSON object')
  .option('--json', 'print the raw result')
  .addHelpText(
    'after',
    `
Examples (Git Bash):
  mcpier tools call files__list_directory --args '{"path":"C:\\\\Users\\\\me\\\\mcpier-test"}'
  mcpier tools call github__get_me --json`,
  )
  .action((fullName: string, options: { args?: string; json?: boolean }) =>
    run(() => toolsCall(fullName, options)),
  );

// ---- secret

const secret = program
  .command('secret')
  .description('manage secrets in Windows Credential Manager')
  .addHelpText(
    'after',
    examples('mcpier secret set github-token', 'mcpier secret list', 'mcpier secret delete github-token'),
  );

secret
  .command('set <name>')
  .description('store a secret; the value is read from a hidden prompt, or from standard input when piped')
  .addHelpText(
    'after',
    `
The value is never taken from the command line (it would end up in shell history).

Examples (Git Bash):
  mcpier secret set github-token
  printf '%s' "$TOKEN" | mcpier secret set github-token
Reference it in config as secret:github-token (or "Bearer secret:github-token" in a header).`,
  )
  .action((name: string) => run(() => secretSet(name)));

secret
  .command('list')
  .description('list secret names, their last four characters, and which servers use them')
  .option('--json', 'print machine-readable JSON')
  .addHelpText('after', examples('mcpier secret list', 'mcpier secret list --json'))
  .action((options: { json?: boolean }) => run(() => secretList(options)));

secret
  .command('delete <name>')
  .description('delete a secret; refused while a server uses it, unless --force')
  .option('--force', 'delete even if servers use it')
  .addHelpText(
    'after',
    examples('mcpier secret delete github-token', 'mcpier secret delete github-token --force'),
  )
  .action((name: string, options: { force?: boolean }) => run(() => secretDelete(name, options)));

// ---- auth

const auth = program
  .command('auth')
  .description('sign in to OAuth servers, check, refresh and sign out')
  .addHelpText(
    'after',
    examples(
      'mcpier auth login notion',
      'mcpier auth status',
      'mcpier auth refresh notion',
      'mcpier auth logout notion',
      'mcpier auth cimd-document > client.json',
    ),
  );

auth
  .command('login <server>')
  .description('sign in to an OAuth server in your browser, then wait until it is done')
  .option('--print-url', 'print the sign-in link instead of opening a browser')
  .addHelpText('after', examples('mcpier auth login notion', 'mcpier auth login notion --print-url'))
  .action((server: string, options: { printUrl?: boolean }) => run(() => authLogin(server, options)));

auth
  .command('status [server]')
  .description('show the sign-in of one OAuth server, or a table of all of them')
  .option('--json', 'print machine-readable JSON')
  .addHelpText('after', examples('mcpier auth status', 'mcpier auth status notion --json'))
  .action((server: string | undefined, options: { json?: boolean }) =>
    run(() => authStatus(server, options)),
  );

auth
  .command('refresh <server>')
  .description("refresh a server's access token now")
  .action((server: string) => run(() => authRefresh(server)));

auth
  .command('logout <server>')
  .description('sign out (revokes the refresh token when the server allows it)')
  .option('--forget-client', 'also forget the registration, so the next sign-in registers again')
  .addHelpText('after', examples('mcpier auth logout notion', 'mcpier auth logout notion --forget-client'))
  .action((server: string, options: { forgetClient?: boolean }) => run(() => authLogout(server, options)));

auth
  .command('cimd-document')
  .description('print the client ID metadata document to publish at the "cimdUrl" setting')
  .action(() => run(authCimdDocument));

// ---- autostart

const autostart = program
  .command('autostart')
  .description('start MCPier hidden when you sign in to Windows (a logon task)')
  .addHelpText(
    'after',
    examples('mcpier autostart enable', 'mcpier autostart status', 'mcpier autostart disable'),
  );

autostart
  .command('enable')
  .description('create (or replace) the logon task with this node.exe and this MCPier')
  .action(() => run(() => autostartEnable({ cliEntry: CLI_ENTRY })));

autostart
  .command('disable')
  .description('remove the logon task')
  .action(() => run(() => autostartDisable()));

autostart
  .command('status')
  .description('show whether the logon task exists and what it runs')
  .option('--json', 'print machine-readable JSON')
  .action((options: { json?: boolean }) => run(() => autostartStatus(options)));

// ---- doctor

program
  .command('doctor')
  .description('check everything that commonly goes wrong, and say how to fix it (exit 1 on a failure)')
  .option('--json', 'print the results as JSON')
  .addHelpText(
    'after',
    `
Checks the environment (Node.js, the commands servers use), the data directory, the gateway,
Credential Manager and OAuth sign-ins, every server, and the MCP clients set up on this
machine. Client config files are only read, never changed.${examples('mcpier doctor', 'mcpier doctor --json')}`,
  )
  .action((options: { json?: boolean }) => run(() => doctorCommand({ ...options, cliEntry: CLI_ENTRY })));

// ---- open

program
  .command('open')
  .description('sign in and open the dashboard in your browser (starts the gateway if needed)')
  .option('--print-url', 'print the one-time sign-in link instead of opening a browser')
  .addHelpText('after', examples('mcpier open', 'mcpier open --print-url'))
  .action((options: { printUrl?: boolean }) => run(() => openCommand({ ...options, cliEntry: CLI_ENTRY })));

// ---- connect

program
  .command('connect [client]')
  .description('print the setup snippet for an MCP client (MCPier never edits client config files)')
  .option('--json', 'print the snippets as JSON')
  .addHelpText(
    'after',
    examples('mcpier connect', 'mcpier connect claude-desktop', 'mcpier connect vscode --json'),
  )
  .action((client: string | undefined, options: { json?: boolean }) =>
    run(() => connectCommand(client, { ...options, cliEntry: CLI_ENTRY })),
  );

// ---- stdio bridge

program
  .command('stdio')
  .description(
    'relay MCP over stdin/stdout to the gateway, starting it if needed (for clients that launch a command)',
  )
  .addHelpText(
    'after',
    `
Clients start this command themselves; you do not run it by hand. Use "mcpier connect" to get
the snippet for your client. Standard output carries MCP messages only; messages for people
go to standard error.`,
  )
  .action(() => run(() => stdioCommand({ cliEntry: CLI_ENTRY })));

// Internal: the background process `mcpier start` launches. Not shown in help.
program
  .command('run-gateway', { hidden: true })
  .action(() => run(() => runGatewayProcess({ foreground: false, cliEntry: CLI_ENTRY })));

if (process.argv.length <= 2) program.help();
await program.parseAsync(process.argv);
exitWhenFlushed();
