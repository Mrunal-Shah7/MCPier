// Request and response types of the routes added in Sprint 4 for the dashboard: the sign-in
// hand-off, the live event stream, the connection test, settings and connect snippets.
import { z } from 'zod';
import type { StatusResponse } from './api.js';
import type { ClientSnippet } from './connect.js';
import type { Settings } from './config.js';
import type { CallSummary } from './call-log.js';
import type { AuthStatus, OAuthDiscoveryResult } from './oauth.js';
import type { ServerStatusInfo, ServerSummary } from './servers.js';

/** Public routes outside /api (still behind the Host and Origin checks). */
export const AUTH_PATHS = {
  /** `GET ?code=<one-time code>&next=<dashboard path>`: sets the admin cookie, then redirects. */
  handoff: '/auth/handoff',
  /** `POST`: clears the admin cookie, then redirects to the dashboard root. */
  signout: '/auth/signout',
} as const;

/** Dashboard routes under /api (token or admin cookie required). */
export const DASHBOARD_API_PATHS = {
  /** `POST`: a one-time hand-off code. */
  sessionCode: '/api/session/code',
  /** `GET`: server-sent events (see `GatewayEvent`). */
  events: '/api/events',
  /** `POST` an unsaved server entry: connect, list tools, disconnect. */
  connectionTest: '/api/connection-test',
  /** `GET` / `PATCH` the `settings` part of config.json. */
  settings: '/api/settings',
  /** `GET` the client setup snippets with this gateway's paths and port. */
  connect: '/api/connect',
  /** `POST`: store a plain env or header value as a secret and put the reference in config. */
  moveToSecret: (name: string) =>
    `/api/servers/${name.startsWith(':') ? name : encodeURIComponent(name)}/move-to-secret`,
} as const;

/** `POST /api/servers/:name/move-to-secret`. The value never travels: the gateway reads it from config. */
export const MoveToSecretRequestSchema = z.object({
  location: z.enum(['env', 'header']),
  key: z.string().min(1),
  secretName: z.string().min(1),
  /** Overwrite a secret that already has this name. */
  replace: z.boolean().optional(),
});
export type MoveToSecretRequest = z.infer<typeof MoveToSecretRequestSchema>;

export interface MoveToSecretResponse {
  server: ServerSummary;
  /** What config now holds for that key: `secret:<name>`, or `Bearer secret:<name>` for a header. */
  reference: string;
  secret: string;
}

/** How long a hand-off code stays valid. */
export const HANDOFF_CODE_TTL_SECONDS = 60;

/** `POST /api/session/code` */
export interface SessionCodeResponse {
  /** Single use, valid for `expiresInSeconds`. Never logged. */
  code: string;
  /** The hand-off path with the code, relative to the gateway's origin. */
  path: string;
  expiresInSeconds: number;
}

/** `POST /api/connection-test` (body: an unsaved server entry). */
export interface ConnectionTestResponse {
  ok: boolean;
  /** The server uses OAuth: only discovery ran (no sign-in); sign in after saving it. */
  needsAuth?: boolean;
  /** For an OAuth entry: what discovery found and which registration method would be used. */
  discovery?: OAuthDiscoveryResult;
  protocolVersion?: string;
  tools: { count: number; names: string[] };
  durationMs: number;
  /** Why it failed, readable, with every env and header value removed. */
  error?: string;
  /** The last stderr lines of a stdio server (values removed). */
  stderr?: string[];
}

/** `GET /api/settings` */
export interface SettingsResponse {
  settings: Settings;
}

/** `PATCH /api/settings` (body: settings fields to change; `null` removes an optional one). */
export interface SettingsUpdateResponse extends SettingsResponse {
  /** A changed port is saved but used only after the gateway restarts. */
  restartRequired: boolean;
  /** Readable notes about the change (for example the port restart). */
  notes: string[];
}

/** `GET /api/connect` */
export interface ConnectResponse {
  url: string;
  port: number;
  /** The gateway was not started by the CLI, so the node.exe and script paths are placeholders. */
  placeholder: boolean;
  note?: string;
  clients: ClientSnippet[];
}

/** One message on `GET /api/events`, as `event: <type>` with JSON `data`. */
export type GatewayEvent =
  | { type: 'snapshot'; data: { status: StatusResponse; servers: ServerSummary[] } }
  | { type: 'server_status'; data: { name: string; status: ServerStatusInfo; protocolVersion?: string } }
  | { type: 'server_tools'; data: { name: string; tools: { total: number; enabled: number } } }
  | { type: 'server_added'; data: { name: string } }
  | { type: 'server_edited'; data: { name: string } }
  | { type: 'server_removed'; data: { name: string } }
  | { type: 'settings_changed'; data: Record<string, never> }
  | {
      type: 'config_problem';
      data: { problem: { file: string; problems: string[]; since: string } | null };
    }
  | { type: 'secrets_changed'; data: { names: string[] } }
  /** Sign-in, refresh, sign-out and step-up of an OAuth server (no values). */
  | { type: 'auth_status'; data: AuthStatus }
  /** A call was recorded in the call log: its summary only (no arguments, result or error text). */
  | { type: 'call_recorded'; data: CallSummary };

export type GatewayEventType = GatewayEvent['type'];

export const GATEWAY_EVENT_TYPES: readonly GatewayEventType[] = [
  'snapshot',
  'server_status',
  'server_tools',
  'server_added',
  'server_edited',
  'server_removed',
  'settings_changed',
  'config_problem',
  'secrets_changed',
  'auth_status',
  'call_recorded',
];

/** Heartbeat comment interval on the event stream. */
export const EVENT_HEARTBEAT_MS = 25_000;
