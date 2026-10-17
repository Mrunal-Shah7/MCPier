import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  LEGACY_ONLY_TOOL_NAMES,
  MODERN_ONLY_TOOL_NAMES,
  registerExtraTools,
  SPRINT3_COMMON_TOOL_NAMES,
} from './extra-tools.js';

export const FIXTURE_SERVER_VERSION = '1.0.0';

/** Tools every fake server exposes. */
export const COMMON_TOOL_NAMES = [
  'echo',
  'add',
  'slow',
  'fail',
  'big_output',
  ...SPRINT3_COMMON_TOOL_NAMES,
] as const;
/** Every tool of the stateless (2026-07-28) server. */
export const STATELESS_TOOL_NAMES = [...COMMON_TOOL_NAMES, ...MODERN_ONLY_TOOL_NAMES] as const;
/** Every tool of the legacy-session server. */
export const LEGACY_TOOL_NAMES = [...COMMON_TOOL_NAMES, ...LEGACY_ONLY_TOOL_NAMES] as const;
/** Extra tools only the stdio server exposes. `change_tools` and `log_message` are test-only. */
export const STDIO_ONLY_TOOL_NAMES = ['env_echo', 'crash', 'change_tools', 'log_message'] as const;
/** The tool `change_tools` adds (then announces with a tool-list-changed notification). */
export const ADDED_TOOL_NAME = 'added_tool';

export interface FakeToolOptions {
  /** Add `env_echo` and `crash` (stdio server only). */
  stdioTools?: boolean;
  /** Called with the tool name on every call (the stdio server logs it to stderr). */
  onCall?: (tool: string) => void;
  /** Called when a call is cancelled by the client (the stdio server logs it to stderr). */
  onCancelled?: (tool: string) => void;
  /** Cache lifetime sent with `tools/list` to 2026-07-28 clients (default: the SDK's 0). */
  toolsTtlMs?: number;
  /** Add `confirm_action` (input_required; stateless server). */
  modernTools?: boolean;
  /** Add `ask_legacy` (2025-style elicitation; legacy server). */
  legacyTools?: boolean;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** Builds one fake MCP server instance with the shared tool set. */
export function createFakeServer(name: string, options: FakeToolOptions = {}): McpServer {
  const server = new McpServer(
    { name, version: FIXTURE_SERVER_VERSION },
    {
      capabilities: { logging: {}, tools: { listChanged: true } },
      ...(options.toolsTtlMs !== undefined
        ? { cacheHints: { 'tools/list': { ttlMs: options.toolsTtlMs } } }
        : {}),
    },
  );
  const called = (tool: string) => options.onCall?.(tool);
  registerExtraTools(server, { called, modernTools: options.modernTools, legacyTools: options.legacyTools });

  server.registerTool(
    'echo',
    {
      description: 'Returns the given text unchanged.',
      inputSchema: z.object({ text: z.string().describe('Text to send back') }),
    },
    async ({ text: value }) => {
      called('echo');
      return text(value);
    },
  );

  server.registerTool(
    'add',
    {
      description: 'Adds two numbers and returns the sum as text and as structured output.',
      inputSchema: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      }),
      outputSchema: z.object({ sum: z.number() }),
    },
    async ({ a, b }) => {
      called('add');
      const sum = a + b;
      return { ...text(String(sum)), structuredContent: { sum } };
    },
  );

  server.registerTool(
    'slow',
    {
      description: 'Waits for the given number of milliseconds, then returns.',
      inputSchema: z.object({
        ms: z.number().int().min(0).max(600_000).describe('How long to wait, in milliseconds'),
      }),
    },
    async ({ ms }, ctx) => {
      called('slow');
      const signal = ctx.mcpReq.signal;
      const cancelled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (cancelled) options.onCancelled?.('slow');
      return text(cancelled ? 'cancelled' : `waited ${ms} ms`);
    },
  );

  server.registerTool(
    'fail',
    {
      description: 'Always returns a tool result marked as an error.',
      inputSchema: z.object({ message: z.string().optional().describe('Error message to return') }),
    },
    async ({ message }) => {
      called('fail');
      return { ...text(message ?? 'This tool always fails.'), isError: true };
    },
  );

  server.registerTool(
    'big_output',
    {
      description: 'Returns text of the requested size in kilobytes (1 KB = 1024 characters).',
      inputSchema: z.object({
        kb: z.number().int().min(0).max(10_240).describe('Size of the text in kilobytes'),
      }),
    },
    async ({ kb }) => {
      called('big_output');
      return text('x'.repeat(kb * 1024));
    },
  );

  let added = false;
  if (options.stdioTools) {
    server.registerTool(
      'env_echo',
      {
        description:
          'Returns the value of the named environment variable, or an empty string if it is not set.',
        inputSchema: z.object({ name: z.string().describe('Environment variable name') }),
      },
      async ({ name: variable }) => {
        called('env_echo');
        return text(process.env[variable] ?? '');
      },
    );

    server.registerTool(
      'change_tools',
      {
        description: `Test only: adds the tool "${ADDED_TOOL_NAME}" and sends a tool-list-changed notification.`,
        inputSchema: z.object({}),
      },
      async () => {
        called('change_tools');
        if (!added) {
          added = true;
          server.registerTool(
            ADDED_TOOL_NAME,
            { description: 'Test only: appears after change_tools is called.', inputSchema: z.object({}) },
            async () => text('added'),
          );
        }
        server.sendToolListChanged();
        return text('tools changed');
      },
    );

    server.registerTool(
      'log_message',
      {
        description: 'Test only: sends the given text as a protocol log message (notifications/message).',
        inputSchema: z.object({ message: z.string() }),
      },
      async ({ message }) => {
        called('log_message');
        await server.sendLoggingMessage({ level: 'info', logger: 'fixture', data: message });
        return text('logged');
      },
    );

    server.registerTool(
      'crash',
      {
        description: 'Exits the server process immediately with exit code 1.',
        inputSchema: z.object({}),
      },
      async () => {
        called('crash');
        process.exit(1);
      },
    );
  }

  return server;
}
