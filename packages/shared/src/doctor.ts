// `mcpier doctor` results and the autostart status (Sprint 6). Shared so `--json`, the CLI's
// text output and the dashboard's Settings page agree. Nothing here ever carries a secret
// value, a token or anything read from a client's config file except paths and entry names.

export const DOCTOR_AREAS = ['environment', 'data', 'gateway', 'secrets', 'servers', 'clients'] as const;
export type DoctorArea = (typeof DOCTOR_AREAS)[number];

export const DOCTOR_AREA_TITLES: Record<DoctorArea, string> = {
  environment: 'Environment',
  data: 'Data directory',
  gateway: 'Gateway',
  secrets: 'Secrets and OAuth',
  servers: 'Servers',
  clients: 'Clients',
};

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  area: DoctorArea;
  /** Stable id, such as `node-version` or `client-claude-desktop`. */
  id: string;
  status: DoctorStatus;
  /** One line: what was checked and what was found. */
  message: string;
  /** For anything not passing: the exact fix (a command, a setting, or a file to edit). */
  fix?: string;
}

export interface DoctorReport {
  version: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
  /** No failures (warnings allowed): `mcpier doctor` exits 0. */
  ok: boolean;
}

/** The Windows logon task that starts MCPier (`mcpier autostart`). */
export const AUTOSTART_TASK_NAME = 'MCPier';

/** Task names tests may use: never the real one. */
export const AUTOSTART_TEST_TASK_PREFIX = 'MCPierTest-';

export interface AutostartStatus {
  /** The task exists. */
  enabled: boolean;
  /** Could not be checked (`detail` says why); `enabled` is then false. */
  unknown?: boolean;
  detail?: string;
  taskName: string;
  /** What the task runs (when enabled). */
  command?: string;
  arguments?: string;
  /** node.exe and the CLI entry the task points at, and whether each still exists. */
  paths?: { role: 'node' | 'cli'; path: string; exists: boolean }[];
}

/** `GET /api/autostart` (read-only; the CLI changes it). */
export interface AutostartResponse {
  status: AutostartStatus;
  /** The commands that change it. */
  commands: { enable: string; disable: string };
}

export const AUTOSTART_API_PATH = '/api/autostart';
