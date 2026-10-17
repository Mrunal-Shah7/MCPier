import {
  API_PATHS,
  slugProblem,
  type SecretDeleteResponse,
  type SecretListResponse,
  type SecretSetResponse,
} from '@mcpier/shared';
import { connectApi } from '../api.js';
import { CliError } from '../errors.js';
import { printJson, table } from '../format.js';
import { readHidden, readStdin } from '../prompt.js';

/**
 * Stores a secret. The value never comes from a command-line argument (it would end up in
 * shell history): it is read from a hidden prompt, or from standard input when piped.
 */
export async function secretSet(name: string): Promise<number> {
  const problem = slugProblem(name);
  if (problem) throw new CliError(`Secret name "${name}" ${problem}.`);
  const api = await connectApi();
  const value = process.stdin.isTTY
    ? await readHidden(`Value for ${name} (input hidden): `)
    : await readStdin();
  if (!value) throw new CliError('No value given; nothing was stored.');
  const result = await api.request<SecretSetResponse>('PUT', API_PATHS.secret(name), { value });
  console.log(`Secret ${name} saved in Credential Manager.`);
  if (result.restarted.length > 0) console.log(`Restarted: ${result.restarted.join(', ')}`);
  return 0;
}

export async function secretList(options: { json?: boolean }): Promise<number> {
  const api = await connectApi();
  const result = await api.request<SecretListResponse>('GET', API_PATHS.secrets);
  if (options.json) {
    printJson(result);
    return 0;
  }
  if (result.secrets.length === 0) console.log('No secrets stored. Add one with: mcpier secret set <name>');
  else {
    console.log(
      table(
        ['NAME', 'LAST 4', 'USED BY'],
        result.secrets.map((secret) => [secret.name, secret.last4 ?? '-', secret.usedBy.join(', ') || '-']),
      ),
    );
  }
  for (const missing of result.missing) {
    console.log(`Not set but referenced: ${missing.name} (used by ${missing.usedBy.join(', ')})`);
  }
  return 0;
}

export async function secretDelete(name: string, options: { force?: boolean }): Promise<number> {
  const api = await connectApi();
  const path = `${API_PATHS.secret(name)}${options.force ? '?force=true' : ''}`;
  const result = await api.request<SecretDeleteResponse>('DELETE', path);
  console.log(`Secret ${name} deleted.`);
  if (result.restarted.length > 0) console.log(`Restarted: ${result.restarted.join(', ')}`);
  return 0;
}
