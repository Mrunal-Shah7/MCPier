#!/usr/bin/env node
// Runs the stateless fixture as its own process: `node http-stateless-main.js --port 0`.
// Prints "READY <url>" on stdout once it is listening.
import { portFromArgs } from './http-common.js';
import { startStatelessServer } from './http-stateless.js';

const fixture = await startStatelessServer({ port: portFromArgs(process.argv) });
process.stdout.write(`READY ${fixture.url}\n`);
