#!/usr/bin/env node
// Runs the OAuth fixture as its own process, for manual checks: `node http-oauth-main.js`.
// Prints "READY <mcp url> <issuer>" on stdout once both servers are listening. The
// authorization endpoint approves every request at once (test mode).
import { startOAuthFixture } from './http-oauth.js';

const fixture = await startOAuthFixture({ accessTokenLifetimeSeconds: 120 });
process.stdout.write(`READY ${fixture.mcpUrl} ${fixture.issuer}\n`);
