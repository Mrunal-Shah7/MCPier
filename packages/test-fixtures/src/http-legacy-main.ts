#!/usr/bin/env node
// Runs the legacy fixture as its own process: `node http-legacy-main.js --port 0`.
// Prints "READY <url>" on stdout once it is listening.
import { portFromArgs } from './http-common.js';
import { startLegacyServer } from './http-legacy.js';

const fixture = await startLegacyServer({ port: portFromArgs(process.argv) });
process.stdout.write(`READY ${fixture.url}\n`);
