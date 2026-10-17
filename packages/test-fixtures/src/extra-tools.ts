// Fixture tools added in Sprint 3: elicitation in both protocol eras, large structured output,
// a deliberately rich input schema, and an echo of the request's `_meta`.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fromJsonSchema, inputRequired, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Tools every fake server exposes in addition to the Sprint 1 set. */
export const SPRINT3_COMMON_TOOL_NAMES = ['big_structured', 'rich_input', 'meta_echo'] as const;
/** Only the stateless (2026-07-28) server: returns `input_required`. */
export const MODERN_ONLY_TOOL_NAMES = ['confirm_action'] as const;
/** Only the legacy-session server: sends a 2025-style elicitation request mid-call. */
export const LEGACY_ONLY_TOOL_NAMES = ['ask_legacy'] as const;

/**
 * The input schema of `rich_input`: nested objects, `$defs` with `$ref`, `oneOf`, an enum,
 * a pattern, a format, an array bound and required fields, so validation errors of every
 * kind can be produced.
 */
export const RICH_INPUT_SCHEMA = {
  type: 'object',
  $defs: {
    address: {
      type: 'object',
      properties: {
        street: { type: 'string', minLength: 1 },
        zip: { type: 'string', pattern: '^[0-9]{5}$' },
      },
      required: ['street', 'zip'],
      additionalProperties: false,
    },
  },
  properties: {
    name: { type: 'string', minLength: 1, description: 'Who this is' },
    kind: { type: 'string', enum: ['person', 'company'] },
    address: { $ref: '#/$defs/address' },
    contact: {
      oneOf: [
        {
          type: 'object',
          properties: { email: { type: 'string', format: 'email' } },
          required: ['email'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { phone: { type: 'string', minLength: 3 } },
          required: ['phone'],
          additionalProperties: false,
        },
      ],
    },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['name', 'kind', 'address'],
  additionalProperties: false,
} as const;

const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

/** A per-process key: `confirm_action` signs the state it hands out and checks it on retry. */
const stateKey = randomBytes(32);

function signState(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey).update(body).digest('base64url')}`;
}

function verifyState(state: unknown): { action: string } | undefined {
  if (typeof state !== 'string') return undefined;
  const [body, mac] = state.split('.');
  if (!body || !mac) return undefined;
  const expected = createHmac('sha256', stateKey).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { action: string };
  } catch {
    return undefined;
  }
}

export interface ExtraToolOptions {
  modernTools?: boolean;
  legacyTools?: boolean;
  called: (tool: string) => void;
}

export function registerExtraTools(server: McpServer, options: ExtraToolOptions): void {
  const { called } = options;

  server.registerTool(
    'big_structured',
    {
      description: 'Returns a structuredContent object of the requested size in kilobytes.',
      inputSchema: z.object({ kb: z.number().int().min(0).max(10_240).describe('Size in kilobytes') }),
    },
    async ({ kb }) => {
      called('big_structured');
      return {
        content: [{ type: 'text' as const, text: `structured output of ${kb} KB` }],
        structuredContent: { kb, data: 'y'.repeat(kb * 1024) },
      };
    },
  );

  server.registerTool(
    'rich_input',
    {
      description:
        'Accepts a person or company record; its input schema exercises nested objects, $ref and oneOf.',
      inputSchema: fromJsonSchema(RICH_INPUT_SCHEMA as never),
    },
    async (args: unknown) => {
      called('rich_input');
      return text(`rich_input accepted ${JSON.stringify(args)}`);
    },
  );

  server.registerTool(
    'meta_echo',
    {
      description: 'Returns the _meta of the request it received, and the name the client gave itself.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      called('meta_echo');
      // The SDK types the envelope as an empty object; the reserved keys are read by name.
      const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
      const clientInfo = envelope?.['io.modelcontextprotocol/clientInfo'] as { name?: string } | undefined;
      const clientName = clientInfo?.name ?? server.server.getClientVersion()?.name;
      const meta = ctx.mcpReq._meta ?? {};
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ meta, clientName }) }],
        structuredContent: { meta, clientName: clientName ?? null },
      };
    },
  );

  if (options.modernTools) {
    server.registerTool(
      'confirm_action',
      {
        description: 'Asks the user to confirm an action (input_required), then reports the answer.',
        inputSchema: z.object({ action: z.string().describe('What to confirm') }),
      },
      async ({ action }, ctx) => {
        called('confirm_action');
        const responses = ctx.mcpReq.inputResponses;
        const rawState = ctx.mcpReq.requestState<string>();
        if (responses === undefined && rawState === undefined) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Confirm "${action}"?`,
                requestedSchema: {
                  type: 'object',
                  properties: { confirm: { type: 'boolean', title: 'Confirm' } },
                  required: ['confirm'],
                },
              }),
            },
            requestState: signState({ action, nonce: randomBytes(8).toString('hex') }),
          });
        }
        const state = verifyState(rawState);
        if (!state || state.action !== action)
          return text('confirm_action: invalid or missing request state', true);
        const answer = responses?.confirm as { action?: string; content?: { confirm?: boolean } } | undefined;
        if (!answer) return text('confirm_action: no answer received', true);
        if (answer.action !== 'accept')
          return text(`confirm_action ${action}: ${answer.action ?? 'unknown'}`);
        return text(`confirm_action ${action}: accepted (confirm=${String(answer.content?.confirm)})`);
      },
    );
  }

  if (options.legacyTools) {
    server.registerTool(
      'ask_legacy',
      {
        description: 'Sends a 2025-style elicitation request to the client mid-call and reports the outcome.',
        inputSchema: z.object({}),
      },
      async (_args, ctx) => {
        called('ask_legacy');
        try {
          const result = await ctx.mcpReq.elicitInput({
            message: 'Proceed?',
            requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          });
          return text(
            `ask_legacy: ${result.action}${result.content ? ` ${JSON.stringify(result.content)}` : ''}`,
          );
        } catch (error) {
          return text(`ask_legacy: error: ${(error as Error).message}`);
        }
      },
    );
  }
}
