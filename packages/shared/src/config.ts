import { z } from 'zod';
import { parseSecretRef, type SecretRefContext } from './secrets.js';
import { slugProblem } from './slug.js';

// Every object schema here is a `looseObject`: unknown keys pass through parsing untouched,
// so a field added by hand (or by a newer build) survives a load-and-save by this build.
// Nested object defaults use `.prefault({})` so the inner field defaults are applied.

export const DEFAULT_PORT = 47800;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

/** How MCPier negotiates the protocol version with an upstream server. */
export const PROTOCOL_MODES = ['auto', 'legacy', 'modern'] as const;
export type ProtocolMode = (typeof PROTOCOL_MODES)[number];

const slug = z.string().superRefine((value, ctx) => {
  const problem = slugProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** A plain string, or a well-formed secret reference (see `parseSecretRef` for the forms). */
const plainOrSecretRef = (context: SecretRefContext) =>
  z.string().superRefine((value, ctx) => {
    const parsed = parseSecretRef(value, context);
    if (parsed.kind === 'malformed') {
      ctx.addIssue({
        code: 'custom',
        message: `is a malformed secret reference: the name after "secret:" ${parsed.problem}`,
      });
    }
  });

const stringMap = (context: SecretRefContext) =>
  z.record(z.string().min(1, { error: 'keys must not be empty' }), plainOrSecretRef(context));

const searchWeight = z
  .number({ error: 'must be a number' })
  .min(0, { error: 'must be between 0 and 100' })
  .max(100, { error: 'must be between 0 and 100' });

/**
 * Field weights for the tool search index. Tool name and title rank highest, then the
 * description, then parameter names and the server's own name and description.
 */
export const SearchWeightsSchema = z.looseObject({
  name: searchWeight.default(3),
  title: searchWeight.default(3),
  description: searchWeight.default(2),
  parameterNames: searchWeight.default(1),
  serverName: searchWeight.default(1),
  serverDescription: searchWeight.default(1),
});

export const SettingsSchema = z.looseObject({
  port: z
    .int({ error: 'must be a whole number' })
    .min(1024, { error: 'must be between 1024 and 65535' })
    .max(65535, { error: 'must be between 1024 and 65535' })
    .default(DEFAULT_PORT),
  /** Extra folders added to PATH for spawned servers. */
  extraPath: z.array(z.string().min(1, { error: 'must not be empty' })).default([]),
  /** Text output above this size is cut by `call_tool`. */
  resultSizeLimitKb: z
    .int({ error: 'must be a whole number' })
    .min(1, { error: 'must be at least 1' })
    .default(100),
  /** Call log retention. */
  logRetentionDays: z
    .int({ error: 'must be a whole number' })
    .min(1, { error: 'must be at least 1' })
    .default(30),
  /** Store full request and response bodies in the call log (false: metadata only). */
  storeCallBodies: z.boolean({ error: 'must be true or false' }).default(true),
  searchWeights: SearchWeightsSchema.prefault({}),
  /** Optional HTTPS URL of MCPier's Client ID Metadata Document (CIMD, v2). */
  cimdUrl: z.url({ protocol: /^https$/, error: 'must be an https:// URL' }).optional(),
});

/** File types a local icon may have (the bytes are still checked when it is read). */
export const ICON_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg'] as const;

/** Why an `icon` value is not usable, or undefined when it is. */
export function iconFieldProblem(value: string): string | undefined {
  if (value === 'none') return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return 'must be an https:// URL, an absolute path to an image file, or "none"';
    }
    return url.protocol === 'https:' ? undefined : 'must use https:// (or be an absolute path, or "none")';
  }
  const absolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  if (!absolute) return 'must be an https:// URL, an absolute path to an image file, or "none"';
  const lower = value.toLowerCase();
  if (!ICON_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return `must be a ${ICON_FILE_EXTENSIONS.join(', ')} file`;
  }
  return undefined;
}

const iconField = z.string().superRefine((value, ctx) => {
  const problem = iconFieldProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const serverCommon = {
  name: slug,
  description: z.string().optional(),
  /**
   * The server's logo, overriding what MCPier finds: an `https` URL, an absolute path to a
   * .png, .jpg, .webp, .ico or .svg file, or `"none"` for the letter tile.
   */
  icon: iconField.optional(),
  enabled: z.boolean({ error: 'must be true or false' }).default(true),
  timeoutMs: z
    .int({ error: 'must be a whole number of milliseconds' })
    .min(1, { error: 'must be at least 1' })
    .default(DEFAULT_TIMEOUT_MS),
  disabledTools: z.array(z.string().min(1, { error: 'must not be empty' })).default([]),
  /**
   * Protocol negotiation: `auto` (default) tries what works, `legacy` always uses the 2025
   * `initialize` handshake, `modern` always uses 2026-07-28.
   */
  protocol: z.enum(PROTOCOL_MODES, { error: 'must be "auto", "legacy" or "modern"' }).default('auto'),
  /** How long connecting may take before the start counts as failed (first npx/uvx runs download). */
  startupTimeoutMs: z
    .int({ error: 'must be a whole number of milliseconds' })
    .min(1000, { error: 'must be at least 1000' })
    .default(DEFAULT_STARTUP_TIMEOUT_MS),
};

export const StdioServerSchema = z.looseObject({
  ...serverCommon,
  transport: z.literal('stdio'),
  command: z.string({ error: 'is required' }).min(1, { error: 'must not be empty' }),
  args: z.array(z.string()).default([]),
  env: stringMap('env').default({}),
});

/** A whole `secret:<name>` reference; a plain value is refused (client secrets are never stored in config). */
const secretRefOnly = z.string().superRefine((value, ctx) => {
  const parsed = parseSecretRef(value, 'env');
  if (parsed.kind === 'plain') {
    ctx.addIssue({
      code: 'custom',
      message:
        'must be a secret reference ("secret:<name>"), never a plain value. Store the value first with: mcpier secret set <name>',
    });
  } else if (parsed.kind === 'malformed') {
    ctx.addIssue({
      code: 'custom',
      message: `is a malformed secret reference: the name after "secret:" ${parsed.problem}`,
    });
  }
});

export const SCOPE_MAX_LENGTH = 128;
export const SCOPE_MAX_COUNT = 50;

/** Why a scope is not a valid RFC 6749 scope token, or undefined when it is. */
export function scopeProblem(scope: string): string | undefined {
  if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))
    return 'must be one scope: no spaces, quotes or backslashes';
  if (scope.length > SCOPE_MAX_LENGTH) return `must be at most ${SCOPE_MAX_LENGTH} characters`;
  return undefined;
}

/** One OAuth scope token (RFC 6749 §3.3): printable ASCII without spaces, quotes or backslashes. */
const scopeToken = z
  .string()
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, { error: 'must be one scope: no spaces, quotes or backslashes' })
  .max(SCOPE_MAX_LENGTH, { error: `must be at most ${SCOPE_MAX_LENGTH} characters` });

/**
 * Optional OAuth client settings for an `auth: "oauth"` server. A `clientId` makes MCPier use
 * that client (registered by hand in the provider's console) instead of registering itself.
 */
export const OAuthClientSchema = z
  .looseObject({
    clientId: z.string().min(1, { error: 'must not be empty' }).optional(),
    /** Only as a reference: `secret:<name>`. */
    clientSecret: secretRefOnly.optional(),
    /**
     * When non-empty, exactly these scopes are requested (plus `offline_access` when the
     * authorization server offers it); otherwise the server's own scopes are used.
     */
    scopes: z
      .array(scopeToken)
      .max(SCOPE_MAX_COUNT, { error: `must list at most ${SCOPE_MAX_COUNT} scopes` })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.clientSecret !== undefined && value.clientId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientSecret'],
        message: 'needs "clientId" too: a client secret belongs to a client ID',
      });
    }
  });

export const HttpServerSchema = z.looseObject({
  ...serverCommon,
  transport: z.literal('http'),
  url: z.url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' }),
  headers: stringMap('header').default({}),
  auth: z.enum(['none', 'oauth'], { error: 'must be "none" or "oauth"' }).default('none'),
  /** OAuth client settings; used only when `auth` is `"oauth"`. */
  oauth: OAuthClientSchema.optional(),
});

/**
 * Keys of a server entry that MCPier does not use (`oauth.<key>` for the OAuth block), for the
 * JSON editor's "not used by MCPier" warning. They are kept as written.
 */
export function unknownEntryKeys(entry: Record<string, unknown>): string[] {
  const shape = entry.transport === 'http' ? HttpServerSchema.shape : StdioServerSchema.shape;
  const unknown = Object.keys(entry).filter((key) => !(key in shape));
  const oauth = entry.oauth;
  if (entry.transport === 'http' && typeof oauth === 'object' && oauth !== null && !Array.isArray(oauth)) {
    const known = ['clientId', 'clientSecret', 'scopes'];
    for (const key of Object.keys(oauth)) if (!known.includes(key)) unknown.push(`oauth.${key}`);
  }
  return unknown;
}

export const ServerEntrySchema = z.discriminatedUnion('transport', [StdioServerSchema, HttpServerSchema], {
  error: 'must be "stdio" or "http"',
});

export const ConfigSchema = z.looseObject({
  settings: SettingsSchema.prefault({}),
  servers: z
    .array(ServerEntrySchema)
    .default([])
    .superRefine((servers, ctx) => {
      const firstIndex = new Map<string, number>();
      servers.forEach((server, index) => {
        const earlier = firstIndex.get(server.name);
        if (earlier === undefined) {
          firstIndex.set(server.name, index);
        } else {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'name'],
            message: `duplicates the name of servers[${earlier}] ("${server.name}"); server names must be unique`,
          });
        }
      });
    }),
});

export type SearchWeights = z.output<typeof SearchWeightsSchema>;
export type Settings = z.output<typeof SettingsSchema>;
export type StdioServerEntry = z.output<typeof StdioServerSchema>;
export type HttpServerEntry = z.output<typeof HttpServerSchema>;
export type OAuthClientConfig = z.output<typeof OAuthClientSchema>;
export type ServerEntry = z.output<typeof ServerEntrySchema>;
export type McpierConfig = z.output<typeof ConfigSchema>;
/** The config as written by hand: every defaulted field optional. */
export type McpierConfigInput = z.input<typeof ConfigSchema>;

/** A full config with every default filled in. Written as `config.json` on first run. */
export function defaultConfig(): McpierConfig {
  return ConfigSchema.parse({});
}

export type ConfigValidation = { ok: true; config: McpierConfig } | { ok: false; problems: string[] };

/** Validates already-parsed JSON. Problems are plain-words lines naming their location. */
export function validateConfig(value: unknown): ConfigValidation {
  const result = ConfigSchema.safeParse(value);
  if (result.success) return { ok: true, config: result.data };
  return { ok: false, problems: result.error.issues.map(formatIssue) };
}

/** Formats a path like `servers[1].env["API KEY"]`. */
export function formatConfigPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (typeof segment === 'string' && /^[A-Za-z_$][\w$]*$/.test(segment))
      out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(String(segment))}]`;
  }
  return out;
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? formatConfigPath(issue.path) : '(top level)';
  return `${where}: ${issue.message}`;
}
