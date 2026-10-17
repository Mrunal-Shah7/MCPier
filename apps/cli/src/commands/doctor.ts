import { AdminAuthError, FORBIDDEN_HOME_ENV, gatewayUrl, probeHealth, projectVersion } from '@mcpier/core';
import {
  AUTOSTART_TASK_NAME,
  CLIENT_NAME_HEADER,
  DOCTOR_AREA_TITLES,
  DOCTOR_AREAS,
  type DoctorReport,
} from '@mcpier/shared';
import { cliContext } from '../context.js';
import { runDoctor, type DoctorDeps } from '../doctor/checks.js';

/** A GET on the admin API, as `mcpier-cli`. */
async function adminGet<T>(port: number, token: string, path: string): Promise<T> {
  const response = await fetch(`${gatewayUrl(port)}${path}`, {
    headers: { authorization: `Bearer ${token}`, [CLIENT_NAME_HEADER]: 'mcpier-cli' },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) throw new AdminAuthError(port);
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function doctorDeps(): DoctorDeps {
  const { platform, paths } = cliContext();
  // Under the test guard Credential Manager and the real logon task are off limits (they
  // would refuse anyway); say so instead of failing.
  const guarded = Boolean(process.env[FORBIDDEN_HOME_ENV]);
  return {
    env: process.env,
    paths,
    cliVersion: projectVersion(),
    nodeVersion: process.versions.node,
    files: platform.files,
    ...(guarded
      ? { skipped: 'skipped under the test guard' }
      : { secrets: platform.secrets, autostart: platform.autostart }),
    autostartTaskName: AUTOSTART_TASK_NAME,
    probe: (port) => probeHealth(port),
    adminGet,
  };
}

const MARKS = { pass: 'ok  ', warn: 'WARN', fail: 'FAIL' } as const;

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [`MCPier doctor (version ${report.version})`];
  for (const area of DOCTOR_AREAS) {
    const checks = report.checks.filter((check) => check.area === area);
    if (checks.length === 0) continue;
    lines.push('', DOCTOR_AREA_TITLES[area]);
    for (const check of checks) {
      lines.push(`  ${MARKS[check.status]}  ${check.message}`);
      if (check.fix && check.status !== 'pass') lines.push(`        fix: ${check.fix}`);
    }
  }
  const { pass, warn, fail } = report.summary;
  lines.push(
    '',
    `${pass} passed, ${warn} ${warn === 1 ? 'warning' : 'warnings'}, ${fail} failed.` +
      (report.ok
        ? warn > 0
          ? ' Nothing is broken; the warnings say what could be better.'
          : ' All good.'
        : ''),
  );
  return lines.join('\n');
}

export async function doctorCommand(
  options: { json?: boolean; cliEntry: string },
  deps: DoctorDeps = doctorDeps(),
): Promise<number> {
  const report = await runDoctor(deps);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}
