import type { Platform } from './types.js';
import { windowsPlatform } from './windows/index.js';

export type * from './types.js';
export { buildChildEnv } from './env.js';
export {
  buildTaskXml,
  checkTaskName,
  encodeTaskXml,
  quoteWindowsArg,
  splitWindowsArgs,
} from './windows/task-scheduler.js';
export { accessFromSddl } from './windows/index.js';
export {
  checkInternalAccount,
  checkSecretName,
  checkSecretValue,
  SecretInputError,
} from './secret-checks.js';

/**
 * The platform implementation for this machine. MCPier v1 is Windows-only; this is the one
 * place outside `platform/windows` that names the Windows implementation.
 */
export function getPlatform(): Platform {
  return windowsPlatform;
}
