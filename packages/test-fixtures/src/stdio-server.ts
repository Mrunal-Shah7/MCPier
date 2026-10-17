#!/usr/bin/env node
// Fake MCP server over stdio. Serves both protocol eras (2026-07-28 and the 2025 handshake);
// with --modern-only it rejects the 2025 handshake, like a modern-only server would.
// Writes a line to stderr on startup, on every tool call and on every cancellation, so log
// capture can be tested.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createFakeServer } from './tools.js';

const log = (line: string) => process.stderr.write(`[fake-stdio] ${line}\n`);
const modernOnly = process.argv.includes('--modern-only');

serveStdio(
  () =>
    createFakeServer('fake-stdio', {
      stdioTools: true,
      onCall: (tool) => log(`call ${tool}`),
      onCancelled: (tool) => log(`cancelled ${tool}`),
    }),
  { legacy: modernOnly ? 'reject' : 'serve' },
);
log(`ready pid=${process.pid}${modernOnly ? ' modern-only' : ''}`);
