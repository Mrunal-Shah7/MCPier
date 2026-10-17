import { secretValueProblem, slugProblem } from '@mcpier/shared';

/** Invalid secret name or value. The message never contains the value. */
export class SecretInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretInputError';
  }
}

export function checkSecretName(name: string): void {
  const problem = slugProblem(name);
  if (problem) throw new SecretInputError(`Secret name "${name}" ${problem}.`);
}

export function checkSecretValue(value: string): void {
  const problem = secretValueProblem(value);
  if (problem) throw new SecretInputError(problem);
}

/**
 * Internal account names start with an uppercase letter, so they can never be a slug: a
 * secret listing (which keeps slugs only) drops them even if it matched them.
 */
const INTERNAL_ACCOUNT = /^[A-Z][A-Za-z0-9]{0,63}$/;

export function checkInternalAccount(account: string): void {
  if (!INTERNAL_ACCOUNT.test(account)) {
    throw new SecretInputError(`"${account}" is not a valid internal account name.`);
  }
}
