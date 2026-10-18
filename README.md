# MCPier

MCPier is a local Windows gateway that looks like one MCP server to every client and fans out to all your real MCP servers behind it.

> Status: **v1 (1.0.0)**. The gateway runs your MCP servers (stdio and remote, OAuth included) behind three meta-tools, with secrets, a dashboard and a CLI. Every call and search is recorded ([Call log](#call-log-and-search-hit-rate)), tools can be tried by hand ([Tester](#tester)), `mcpier doctor` checks the whole setup ([Troubleshooting](#troubleshooting)), and `mcpier autostart enable` starts MCPier when you sign in to Windows ([Starting with Windows](#starting-with-windows)). The checklist for trying it on your machine with real servers is [docs/V1-ACCEPTANCE.md](docs/V1-ACCEPTANCE.md).

## Prerequisites

- Windows 10 or later
- [Node.js 24 LTS](https://nodejs.org/)
- [pnpm](https://pnpm.io/) (developed with 12.9)
- Git Bash. All commands below are written for it.

Docker is not needed.

## Install and build

From the repository root:

```bash
pnpm install
pnpm build
```

`pnpm build` compiles every package into its own `dist/` folder and builds the dashboard into `apps/web/dist/`.

## Link the CLI globally

Make `mcpier` available in every terminal:

```bash
pnpm add -g "link:$(pwd -W)/apps/cli"
```

Run this from the repository root. pnpm 12 has no `pnpm link --global`; this command does the same job. The global command points at this repository, so after a rebuild the new version runs without linking again.

Check it:

```bash
mcpier --version     # 1.0.0
```

If `mcpier` is not found, pnpm's global bin folder is not on your `PATH`:

1. Run `pnpm setup` once.
2. Open a new Git Bash window.

`pnpm setup` adds `PNPM_HOME` (usually `%LOCALAPPDATA%\pnpm`) and its `bin` folder to your user environment. Alternatively, add `%LOCALAPPDATA%\pnpm\bin` to your user `PATH` yourself in _Settings → System → About → Advanced system settings → Environment Variables_.

To remove the link: `pnpm remove -g @mcpier/cli`.

## Daily use

```bash
mcpier start        # start the gateway in the background (no console window)
mcpier status       # running or stopped; version, pid, uptime, port, data directory, server counts
mcpier status --json
mcpier stop         # clean shutdown; falls back to stopping the process tree after 10 seconds
mcpier doctor       # check everything that commonly goes wrong (see Troubleshooting)
```

- `mcpier start` prints the dashboard URL (by default `http://127.0.0.1:47800/`), the process id, and a reminder that `mcpier open` signs a browser in. The gateway keeps running after you close the terminal.
- `mcpier status` exits with code 0 when the gateway is running and 3 when it is stopped.
- If `start` fails, it prints the last lines of the gateway log. Add `--debug` to any command for full error details.

### Running in the foreground

```bash
mcpier start --foreground
```

The gateway runs in the current terminal and logs to the console as well as to the log file. Press Ctrl+C to stop it cleanly.

## The dashboard

```bash
mcpier open               # starts the gateway if needed, signs the browser in, opens the dashboard
mcpier open --print-url   # prints the one-time sign-in link instead of opening a browser
```

**Signing in.** `mcpier open` gets a one-time sign-in link from the gateway: it works once, within 60 seconds. It opens your default browser with that link, and the gateway swaps it for an HTTP-only cookie.

- The admin token never appears in a URL, in browser storage or in a log.
- Opening `http://127.0.0.1:47800/` directly, without that cookie, shows only a "not signed in" page.
- **Sign out** (top right) clears the cookie.
- Rotating the admin token (deleting `admin-token` and restarting MCPier) signs every browser out.

The dashboard updates live: status changes, tool changes and config problems appear without a reload. The dot in the header shows whether live updates are connected. It follows the Windows light or dark setting.

| Page              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Servers**       | Every server with its status, protocol, tool counts and uptime. Start, stop, restart, enable, disable or delete one; **Sign in…** for a server waiting for sign-in                                                                                                                                                                                                                                                                                                                   |
| **Server detail** | Status and the stored config. For an OAuth server, the **Authorization** section: signed in or why not, issuer, registration, scopes, token expiry, and **Sign in**, **Refresh now**, **Sign out**, **Forget registration**. Credential-looking plain values are masked (Reveal shows them); **Move to secret** stores one in Credential Manager and puts the reference in config. Tools with their schemas and enable switches. The live log, with pause and clear. Edit the server |
| **Add server**    | A form, or **Paste JSON** for a `mcpServers` block. Env and header values can be stored as secrets (on by default for credential-looking names) or refer to an existing secret. **Test connection** connects once, lists the tools and disconnects, without saving anything. For an OAuth server it runs discovery only and shows how a sign-in would register. Advanced holds the **OAuth client** fields                                                                           |
| **Tools**         | **Search** shows exactly what `search_tools` returns for a query. The **Catalog** lists every tool, filterable, with enable switches                                                                                                                                                                                                                                                                                                                                                 |
| **Secrets**       | Secret names, their last four characters and which servers use them; references to missing secrets are highlighted. Set or replace a value (it is never shown again) or delete one                                                                                                                                                                                                                                                                                                   |
| **Call log**      | Every call and search through MCPier, newest first, live. Filter by time, server, client, outcome and tool; the filters are in the address, so a view can be bookmarked. A call's detail shows its arguments and result (when stored), and opens it in the Tester. The **Search** tab shows the search hit rate and the recent misses. **Clear log** deletes everything ([more](#call-log-and-search-hit-rate))                                                                      |
| **Tester**        | Run any tool by hand from a form built from its schema, as the model would through `call_tool` or raw, answering input requests ([more](#tester))                                                                                                                                                                                                                                                                                                                                    |
| **Connect**       | The setup snippet for each client, with this machine's paths and port, and a Copy button                                                                                                                                                                                                                                                                                                                                                                                             |
| **Settings**      | Port (used after a restart), extra PATH folders, result size limit, log retention, whether call bodies are stored, search weights, CIMD URL (with **Show CIMD document**), with validation as you type. **Start with Windows** shows whether autostart is on, and the command to change it                                                                                                                                                                                           |

While `config.json` has problems (after a broken hand edit), every page shows a banner listing them, and changes from the dashboard and the CLI are paused until the file is fixed.

## Adding servers

The gateway must be running (`mcpier start`). Every `server`, `tools` and `secret` command talks to it; with no gateway, they say so and exit.

### A local (stdio) server

Put the command after `--`:

```bash
mcpier server add files -- npx -y @modelcontextprotocol/server-filesystem "C:\Users\me\mcpier-test"
```

MCPier starts the server hidden (no console window), waits until it is ready, and prints its status. If the server fails, the reason and its last stderr lines are printed instead (for example a mistyped command's "is not recognized" message).

Options:

| Option                            | Meaning                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--env KEY=VALUE`                 | Environment variable, repeatable. The value may be `secret:<name>`                              |
| `--description <text>`            | One-line description                                                                            |
| `--protocol auto\|legacy\|modern` | Protocol negotiation (default `auto`)                                                           |
| `--timeout <ms>`                  | Per-call limit (default 60000)                                                                  |
| `--startup-timeout <ms>`          | How long starting may take (default 90000). First runs of `npx`/`uvx` servers download packages |
| `--disabled`                      | Add without starting                                                                            |

Git Bash turns arguments that start with `/` into paths. For a `cmd /c …` command, put `MSYS_NO_PATHCONV=1` in front of the `mcpier` command, or import the server from a JSON file.

### A remote server

```bash
mcpier secret set github-token
mcpier server add github --url <url from the server's README> --header "Authorization: Bearer secret:github-token"
mcpier server add notion --url <url from the server's README> --oauth
```

A header value may be `secret:<name>` or keep one scheme word in front: `Bearer secret:<name>`. A server added with `--oauth` shows `needs_auth` until you sign in: see [Signing in to OAuth servers](#signing-in-to-oauth-servers).

### Importing an `mcpServers` block

Most server READMEs and client configs publish servers as JSON. MCPier reads three shapes:

- `{"mcpServers": {...}}`
- VS Code's `{"servers": {...}}`
- a bare map of entries

```bash
mcpier server import claude_desktop_config.json --dry-run   # show what would be created
mcpier server import claude_desktop_config.json
cat servers.json | mcpier server import -                   # from standard input
```

Keys become server names (lowercased, other characters turned into hyphens). An entry with `"type": "sse"` (the deprecated HTTP+SSE transport) is refused, and fields MCPier does not use are listed as ignored.

Plain values that look like credentials are handled in one of three ways:

- **In a terminal:** MCPier asks, per value, whether to move it into Credential Manager. The keys it checks are env keys and header names containing TOKEN, KEY, SECRET, PASSWORD, PAT or AUTH, and `Authorization`.
- **With a flag:** `--move-secrets` moves them all and `--keep-secrets` keeps them all, without asking.
- **Without a terminal and without a flag:** values stay plain, with a warning naming the keys.

### Managing servers

```bash
mcpier server list                    # status, protocol, tools, last error (--json too)
mcpier server show files              # config as stored, status detail, tools
mcpier server stop files              # stop until started again
mcpier server start files
mcpier server restart files
mcpier server disable files           # stop and keep stopped (--json prints the result)
mcpier server enable files            # start it again and wait for it (--json too)
mcpier server refresh files           # list its tools again
mcpier server logs files --lines 50   # stderr, protocol logs, connection events
mcpier server logs files --follow     # keep printing new lines until Ctrl+C
mcpier server remove files
```

**Statuses:**

| Status       | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `starting`   | MCPier is connecting                                                        |
| `ready`      | Connected, and its tools are listed                                         |
| `needs_auth` | Waiting for sign-in; the detail says why ([OAuth](#what-the-statuses-mean)) |
| `error`      | The last attempt failed; MCPier retries with backoff, up to once a minute   |
| `crashed`    | A stdio server failed 5 times in 5 minutes. Start or restart it             |
| `stopped`    | Stopped, or disabled                                                        |

## Secrets

Secrets live in Windows Credential Manager, under the service `MCPier/` (shown as `<name>.MCPier/`). `config.json` only ever holds references like `secret:github-token`.

```bash
mcpier secret set github-token           # hidden prompt
printf '%s' "$TOKEN" | mcpier secret set github-token
mcpier secret list                       # names, last four characters, which servers use them
mcpier secret delete github-token        # refused while a server uses it
mcpier secret delete github-token --force
```

- **Never typed on the command line:** the value is never given as an argument, because it would end up in your shell history.
- **Restarts:** setting or deleting a secret restarts the servers that use it.
- **Size limit:** values are limited to 1,280 characters.
- **Never shown:** secret values never appear in logs, command output or API responses. If a server echoes one back, it is replaced by `[secret:<name>]`.

## Signing in to OAuth servers

Remote servers that use OAuth (Notion, Linear and others) are added with `--oauth`, or with **Sign-in: OAuth** in the dashboard. MCPier is the OAuth client: it signs in once, keeps the tokens, and refreshes them. Your MCP clients never see a token.

### Signing in

- **From the dashboard:** open the server's page. The **Authorization** section shows whether you are signed in. **Sign in** opens the provider's sign-in page in a new browser tab. Approve there, and the tab shows "Signed in to <server>". The dashboard updates by itself, and the server becomes `ready`. The Servers page also has **Sign in…** in the row menu of a server that needs it.
- **From the command line:**

  ```bash
  mcpier auth login notion              # opens the sign-in page in your browser, then waits (up to 10 minutes)
  mcpier auth login notion --print-url  # prints the link instead; open it in a browser on this computer
  mcpier auth status                    # every OAuth server: signed in or not, registration, token expiry, scopes
  mcpier auth status notion --json
  mcpier auth refresh notion            # renew the access token now
  mcpier auth logout notion             # sign out
  mcpier auth logout notion --forget-client
  ```

MCPier never opens a browser by itself: a sign-in always starts from the button or `mcpier auth login`. The sign-in link carries a one-time value, so do not share it. It stays valid for 10 minutes, and a gateway restart cancels it.

### What happens

1. **Discovery:** MCPier asks the server where it signs in: its protected-resource metadata, then its authorization server's metadata.
2. **Registration:** MCPier registers itself, the first way that applies:
   1. **A client ID you entered** (see below);
   2. a **client ID metadata document**, when the CIMD URL setting is set and the authorization server supports it;
   3. **dynamic registration**, as a native application with the redirect `http://127.0.0.1:<port>/oauth/callback`.
3. **Sign-in:** the sign-in uses PKCE. The provider sends your browser back to MCPier's own callback page, on `127.0.0.1` and MCPier's port. The response is checked to really come from the authorization server it went to.
4. **Refresh:** tokens are renewed before they expire, and once more if the server refuses one. They survive gateway restarts.

### What the statuses mean

A server waiting for sign-in is `needs_auth`, with one of these details:

| Detail                         | Meaning                                                                                            | What to do                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Sign in required               | Never signed in, or signed out                                                                     | Sign in                                                            |
| Sign-in expired; sign in again | The provider refused to renew the sign-in (it was revoked or expired). The tokens were deleted     | Sign in again                                                      |
| More permissions needed (…)    | The server asked for more permissions (scopes) than you granted. The scopes it asked for are named | Sign in again; MCPier asks for the old and the new scopes together |
| This server needs a client ID  | The provider has no automatic registration, and no client ID is configured                         | Enter a client ID (below)                                          |

If the provider cannot be reached when a token needs renewing, that is an outage, not an expired sign-in. The server shows `error`, MCPier retries, and your sign-in is kept.

When a model calls a tool on such a server, `call_tool` answers with the reason and tells it to ask you to sign in, on the server's page or with `mcpier auth login <server>`.

### Signing out and forgetting the registration

- **Sign out** (dashboard) or `mcpier auth logout <server>`: MCPier asks the provider to revoke the refresh token, when the provider supports it, then deletes the tokens. The registration is kept, so the next sign-in reuses it.
- **Forget registration** (dashboard, after a confirmation) or `mcpier auth logout <server> --forget-client`: signs out, then deletes the stored registration too. The next sign-in registers MCPier again.

### Providers without automatic registration: a client ID

Some providers want you to create an OAuth client in their developer console first.

1. **Create the client** in the provider's console, with this redirect URI: `http://127.0.0.1:47800/oauth/callback`. Use your port if you changed it, and keep `127.0.0.1`, not `localhost`.
2. **Enter its client ID** in MCPier: **Edit**, then **Advanced**, then **OAuth client**. If the provider issued a **client secret**, store it there as a secret; config.json then holds only `secret:<name>`. You can also add **extra scopes**.
3. **Sign in.**

In config.json the same thing reads:

```json
{
  "name": "linear",
  "transport": "http",
  "url": "https://…",
  "auth": "oauth",
  "oauth": { "clientId": "abc123", "clientSecret": "secret:linear-client-secret", "scopes": ["read"] }
}
```

A plain client secret in config.json is refused: store it with `mcpier secret set <name>` and use the reference.

### Client ID metadata documents (CIMD)

A client ID metadata document is a small JSON file at an https:// address of your own. That address becomes MCPier's client ID, so authorization servers that support it need no registration at all. MCPier does not host the document; you publish it.

1. Choose the address, for example `https://example.org/mcpier/client.json`, and set it as **CIMD URL** on the Settings page.
2. Get the document: **Show CIMD document** on the Settings page (with a Copy button), or

   ```bash
   mcpier auth cimd-document > client.json   # the JSON goes to standard output; where to publish it goes to standard error
   ```

3. Publish it at that address, served over https.

The document lists MCPier's redirect URI, which contains the port. If you change the port, publish it again. Until the setting is set, MCPier never tries CIMD.

### Where the tokens are, and how they are protected

- **Files:** each OAuth server's tokens and registration are in one file, `%LOCALAPPDATA%\MCPier\oauth\<server>.json`. It is encrypted (AES-256-GCM) and only your Windows user and SYSTEM can read the folder.
- **The key:** 32 random bytes in Windows Credential Manager, under MCPier's own service `MCPier-internal` (account `OAuthStoreKey`). It never appears in `mcpier secret list` or on the Secrets page. Tokens are too long for Credential Manager themselves, which holds at most 1,280 characters per value.
- **Never in plain view:** tokens never appear in `config.json`, a log, a command's output or an API answer.
- **An unreadable file:** if the key is missing (a different Windows user, the data folder copied to another machine) or the file is damaged, the file is renamed `<server>.json.unreadable` and the server asks you to sign in again. Delete the `.unreadable` file when you no longer need it.
- **Removing the server, or changing its URL,** deletes its file.

## Tools

Tools have full names `server__tool`, for example `files__read_file`.

```bash
mcpier tools list                         # enabled, available tools
mcpier tools search "list directory"      # the same search clients get; --limit N, --server <name>, --json
mcpier tools list --server files --all    # include disabled and unavailable ones, marked
mcpier tools disable github__delete_repository
mcpier tools enable github__delete_repository
mcpier tools call files__list_directory --args '{"path":"C:\\Users\\me\\mcpier-test"}'
mcpier tools call files__list_directory --args '{"path":"C:\\Users\\me"}' --json   # raw result
```

## Connecting clients

MCPier gives clients two ways in, both reaching the same gateway:

- **HTTP endpoint:** `http://127.0.0.1:47800/mcp` (your port if you changed it). For clients that accept a URL. The gateway must be running (`mcpier start`). The endpoint needs no admin token, but only accepts requests addressed to `127.0.0.1` or `localhost`, with no foreign `Origin`.
- **stdio bridge:** `mcpier stdio`, launched by the client itself. For clients that only start local commands. The bridge starts the gateway if it is not running. If the gateway stops while the client is open, the next request starts it again.

`mcpier connect` prints the exact setup for a client, with this machine's paths and port filled in:

```bash
mcpier connect                  # the supported clients and the endpoint URL
mcpier connect claude-desktop   # config file location and the JSON entry (stdio bridge)
mcpier connect claude-code      # a "claude mcp add" command to run once (HTTP)
mcpier connect cursor           # mcp.json entry (HTTP)
mcpier connect vscode           # mcp.json entry; VS Code uses "servers", not "mcpServers"
mcpier connect codex            # config.toml table (stdio bridge)
mcpier connect generic          # the URL and the command, for any other client
mcpier connect vscode --json    # the same, as data
```

MCPier never edits a client's config file: you paste the snippet yourself. Stdio snippets point at `node.exe` and the CLI's script directly, never at a `.cmd` shim.

**Claude Desktop:**

- Add the entry under `mcpServers` in its config file.
- Then quit it fully, including from the system tray, and start it again; it only reads the file at startup.
- If it was installed from the Microsoft Store, the config file lives under `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\`; `mcpier connect claude-desktop` shows both locations.

### What the model sees

A client connected to MCPier sees exactly three tools, however many servers you have:

1. **`list_servers`**: your enabled servers, what each is for, whether each is working, and how many tools each has.
2. **`search_tools`**: give it a few words ("list directory", "create issue"). It returns the best matches with their full names (`server__tool`) and input schemas, so the model can call one right away.
3. **`call_tool`**: runs a tool by its full name with arguments. The arguments are checked against the tool's schema first. A mistake comes back as an error listing each problem, so the model can fix the call.

The server's instructions tell the model to use them in that order. Every search and call is recorded in the [Call log](#call-log-and-search-hit-rate) with the client's name.

Some tools ask the user a question mid-call (MCP elicitation). That works with clients that support the 2026-07-28 protocol and elicitation. Older clients get an error explaining that the tool needs input their client cannot provide.

### Servers that are not ready

Tools of a server that is starting, crashed, stopped or waiting for sign-in still show up in search, after the working ones, marked unavailable with the reason. `call_tool` on one of them returns a message naming the state and what to do, for example "ask the user to restart it in MCPier".

Results larger than `resultSizeLimitKb` (default 100 KB) are cut, with a note saying how much was shown and dropped. Images and other binary content pass through.

## Call log and search hit rate

Every `call_tool` and `search_tools` (and every call and search from the dashboard and the CLI) is recorded in `mcpier.db` in your data folder.

- **What a call record holds:** time, the client's name and version, the tool and server, duration, outcome (ok, tool error, invalid arguments, unknown tool, disabled, server not ready, timed out, cancelled, input required, failed), the trace id, and a short error text for failures.
- **Arguments and results** are stored too while **Store call bodies** is on (Settings; the default). Turning it off applies to new calls. Every secret value and OAuth token of that server is replaced by its reference (`[secret:<name>]`) before anything is written, each body is cut at 64 KB with a note, and MCPier's elicitation state and your answers to input requests are never stored.
- **Searches** keep the query and the names it returned, in order.
- **Retention:** records older than **Log retention** (30 days by default) are deleted at start and every hour, and at once when you lower the setting. **Clear log** on the Call log page deletes everything, after a confirmation.

**Search hit rate.** A search is a **hit** when the same client's next call, within 5 minutes, is to one of the tools it returned (the page shows its rank), and a **miss** when that call is to another tool; with no call within 5 minutes it has no follow-up. Hit rate = hits ÷ (hits + misses). The **Search** tab lists the recent misses with what was called instead: the places where search falls short.

## Tester

The **Tester** page runs one tool by hand. Find it with the search box (or open a call from the Call log, which fills in its arguments).

- **The form** is built from the tool's input schema: text, choices, numbers, true/false, lists and nested groups. Anything the form cannot draw (for example "one of these shapes") becomes a small JSON box for that field, and **Raw JSON** edits the whole input at once. As you type, MCPier checks the arguments against the schema and shows problems next to their fields.
- **As the model sees it** (the default) runs the tool exactly as `call_tool` would: the same checks, the same size limit (with its note when a result is cut), and input requests. When the tool asks a question, the Tester shows it with **Accept**, **Decline** and **Cancel**, then sends your answer.
- **Raw** sends the call straight to the server: no checks by MCPier and no size limit.
- **The result** shows the outcome, the time taken, text, structured content and images. The last 20 runs of the page stay listed until you close it.
- Tester calls appear in the Call log as `dashboard-tester`. A tool whose server is not ready shows the server's status and cannot be run.

## Starting with Windows

```bash
mcpier autostart enable    # create (or replace) the logon task
mcpier autostart status    # on or off, what it runs, and whether those paths still exist
mcpier autostart disable   # remove it
```

`enable` creates a Task Scheduler task named `MCPier` that starts MCPier when you sign in, in your own session (so your PATH and Credential Manager work), with no window, no stored password and no administrator rights, also on battery power and with no time limit. It runs this `node.exe` and this repository's CLI, and keeps `MCPIER_HOME` and `MCPIER_PORT` if you have set them. If you move the repository or Node.js, run `mcpier autostart enable` again (`mcpier doctor` tells you). The Settings page shows the status too.

## Troubleshooting

Start with:

```bash
mcpier doctor          # works whether or not MCPier is running
mcpier doctor --json   # the same results as data
```

It checks, and for anything wrong prints the exact fix:

- **Environment:** Node.js 24; whether `node`, `npx` and `uvx` (and `docker`, optional) are found on the PATH servers get, `extraPath` included; that every `extraPath` folder exists.
- **Data directory:** that only you (and the system) can open it, `admin-token`, `state-key` and `oauth`; that `config.json` is valid; that `mcpier.db` is healthy; leftover damaged databases.
- **Gateway:** running or not, a port taken by another program, a version mismatch after a rebuild, autostart.
- **Secrets and OAuth:** Credential Manager, missing secrets, OAuth servers that need sign-in, unreadable sign-in records.
- **Servers:** each server's command, and each server's state with its last error.
- **Clients:** for Claude Desktop (both install types), Cursor, VS Code and Codex, whether their config has an MCPier entry, and whether a bridge entry still points at existing files. Client config files are only read, never changed.

It exits with 1 when something failed (warnings alone exit 0), and never prints a secret or token.

Common fixes:

| Symptom                                                    | Fix                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A client cannot find MCPier after you moved the repository | `mcpier connect <client>` prints the new entry; `mcpier autostart enable` updates the logon task                                      |
| A server shows `error` with "is not recognized"            | The command is not on the PATH MCPier gives servers: add its folder under **extra PATH folders** in Settings, then restart the server |
| A server shows `needs_auth`                                | `mcpier auth login <server>`, or **Sign in** on its page                                                                              |
| Port 47800 is taken                                        | Set another port in Settings (used after a restart), then `mcpier connect <client>` for the new snippets                              |
| Nothing is recorded in the Call log                        | `mcpier doctor` says whether `mcpier.db` could be used; `mcpier stop` then `mcpier start` replaces a damaged one                      |
| Autostart does nothing at sign-in                          | `mcpier autostart status` shows whether the paths it runs still exist                                                                 |

## Editing config.json by hand

While the gateway runs, it watches `%LOCALAPPDATA%\MCPier\config.json`.

- **A valid edit** takes effect within a second, as a difference. Only servers whose connection fields changed restart: `command`, `args`, `env`, `url`, `headers`, `auth`, `oauth`, `protocol` or `startupTimeoutMs`. A change to `description`, `timeoutMs` or `disabledTools` applies without a restart.
- **An invalid edit** (broken JSON, a bad value) is not applied. The gateway keeps running on the last good config, logs every problem, and `mcpier status` shows them until you fix the file.
- **While the file is invalid**, commands that change the config are refused, so your edit is never overwritten.

Every server entry accepts these fields:

| Field              | Meaning                                    |
| ------------------ | ------------------------------------------ |
| `name`             | The server name                            |
| `description`      | One-line description                       |
| `enabled`          | Whether the server runs (default `true`)   |
| `timeoutMs`        | Per-call limit (default 60000)             |
| `startupTimeoutMs` | How long starting may take (default 90000) |
| `protocol`         | `auto` (default), `legacy` or `modern`     |
| `disabledTools`    | Tool names to hide                         |

Plus, by transport:

- **stdio:** `command`, `args`, `env`
- **http:** `url`, `headers`, `auth` (`none` or `oauth`), and for OAuth an optional `oauth` block: `clientId`, `clientSecret` (a `secret:` reference only) and `scopes` ([details](#providers-without-automatic-registration-a-client-id))

Fields MCPier does not know are kept as they are.

## Where data lives

Everything MCPier stores lives in `%LOCALAPPDATA%\MCPier\`, never in the repository:

| File                  | What it is                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`         | Settings and servers. Hand-editable; MCPier never overwrites an invalid file                                                                          |
| `admin-token`         | The admin API token. Only your Windows user (and SYSTEM) can read the folder and this file                                                            |
| `state-key`           | The key that signs MCPier's elicitation state. Restricted like `admin-token`                                                                          |
| `gateway.pid`         | The running gateway's process id and port; removed on clean shutdown                                                                                  |
| `logs\gateway.log`    | The gateway's own log, rotated at 5 MB (three old files kept). Never contains the token                                                               |
| `logs\<server>.log`   | One per server: its stderr, protocol log messages and connection events. Rotated the same way                                                         |
| `oauth\<server>.json` | One per OAuth server: its tokens and registration, encrypted ([how](#where-the-tokens-are-and-how-they-are-protected))                                |
| `mcpier.db`           | The call log, the search log and each server's last tool list (SQLite). A damaged file is renamed `mcpier.db.corrupt-<time>` and a new one is created |

Secrets are not stored here: they live in Windows Credential Manager (see [Secrets](#secrets)), as does the key of the OAuth files.

### Overrides

| Variable      | Effect                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| `MCPIER_HOME` | Use this folder instead of `%LOCALAPPDATA%\MCPier\`                         |
| `MCPIER_PORT` | Use this port instead of `settings.port` from `config.json` (default 47800) |

Both work the same for the CLI and the gateway. `mcpier start --home <dir> --port <n>` does the same for one start. For example, to experiment without touching your real data:

```bash
MCPIER_HOME="$PWD/.dev-home" MCPIER_PORT=47911 mcpier start
```

`.dev-home/` is ignored by version control.

## Development

```bash
pnpm build          # build everything
pnpm typecheck      # type-check every package and the tests
pnpm lint           # ESLint (TypeScript-aware recommended rules)
pnpm format         # Prettier (pnpm format:check to only check)
pnpm test           # build, then run every test in the repository
pnpm test:only      # run the tests without building first
```

- Tests never touch your real data. Each one uses a temporary `MCPIER_HOME` and a random port.
- A safety check makes any test fail if it would resolve the data directory to `%LOCALAPPDATA%\MCPier\`, use your Credential Manager entries, or read or change the real `MCPier` logon task. Two tests use test-only names on purpose: one creates and deletes a `MCPierTest-…` logon task, and an opt-in test (`MCPIER_TEST_KEYRING=1 pnpm exec vitest run packages/core/test/keyring.opt-in.test.ts`) uses the Credential Manager services `MCPierTest/` and `MCPierTest-internal` and empties them afterwards.
- The dashboard has component tests (jsdom) and one end-to-end test that drives the installed Microsoft Edge (`test/e2e/dashboard.test.ts`; skipped with a reason if Edge is missing). Set `MCPIER_E2E_SHOTS` to a folder to also save screenshots of some pages in both themes.

### Working on the dashboard

```bash
pnpm dev:web        # rebuilds apps/web/dist on every change
```

Run a gateway as usual (`mcpier start`, with a test `MCPIER_HOME` if you like), sign in with `mcpier open`, and reload the page after each rebuild.

- **Same origin, real checks:** the gateway serves the files itself. There is no dev server or proxy, and the Host, Origin and token checks and the Content Security Policy apply exactly as in daily use.
- **No dev server on another port:** the Origin check refuses it by design.

### Repository layout

```
packages/shared         types and zod schemas (config, API responses)
packages/core           the gateway; Windows-specific code in src/platform/windows
packages/test-fixtures  fake MCP servers (stdio, stateless HTTP, legacy-session HTTP, OAuth-protected)
apps/cli                the mcpier CLI
apps/web                the dashboard (React; the gateway serves its build from apps/web/dist)
test/                   shared test setup and helpers
docs/                   DECISIONS.md and per-sprint notes
```
