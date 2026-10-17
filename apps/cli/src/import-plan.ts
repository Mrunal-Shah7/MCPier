import {
  makeSecretRef,
  parseImportBlock,
  proposedSecretName,
  slugProblem,
  splitScheme,
  type ImportParseResult,
} from '@mcpier/shared';
import { CliError } from './errors.js';
import type { Prompter } from './prompt.js';

/** A pasted value that will be stored in Credential Manager and replaced by a reference. */
export interface SecretMove {
  server: string;
  location: 'env' | 'header';
  key: string;
  secretName: string;
  /** The value to store (for `Bearer <token>` headers, the token only). Never printed. */
  value: string;
}

export interface KeptPlain {
  server: string;
  location: 'env' | 'header';
  key: string;
}

export interface ImportPlan {
  parsed: ImportParseResult;
  moves: SecretMove[];
  kept: KeptPlain[];
  /** The pasted block with moved values replaced by secret references. */
  source: unknown;
}

/**
 * - `ask`: ask per value (interactive terminal only).
 * - `move`: move every credential-looking plain value without asking.
 * - `keep`: keep every value as plain text.
 */
export type SecretMode = 'ask' | 'move' | 'keep';

function rawEntries(
  source: unknown,
  shape: ImportParseResult['shape'],
): Record<string, Record<string, unknown>> {
  const record = source as Record<string, unknown>;
  const map = shape === 'mcpServers' ? record.mcpServers : shape === 'servers' ? record.servers : record;
  return map as Record<string, Record<string, unknown>>;
}

async function chooseName(prompter: Prompter, proposed: string, label: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const name = await prompter.ask(`  Secret name for ${label}`, proposed);
    const problem = slugProblem(name);
    if (!problem) return name;
    console.log(`  "${name}" ${problem}.`);
  }
  throw new CliError('No valid secret name given.');
}

/** Decides what happens to each credential-looking value in a pasted block. */
export async function planImport(
  pasted: unknown,
  existingNames: readonly string[],
  mode: SecretMode,
  prompter?: Prompter,
): Promise<ImportPlan> {
  const source = structuredClone(pasted);
  const parsed = parseImportBlock(source, existingNames);
  const moves: SecretMove[] = [];
  const kept: KeptPlain[] = [];
  const raw = parsed.candidates.length > 0 ? rawEntries(source, parsed.shape) : {};

  for (const candidate of parsed.candidates) {
    const rawEntry = raw[candidate.key]!;
    for (const sensitive of candidate.sensitive) {
      const mapName = sensitive.location === 'env' ? 'env' : 'headers';
      const rawMap = rawEntry[mapName] as Record<string, string>;
      const original = rawMap[sensitive.key]!;
      const label = `${candidate.name} ${sensitive.location === 'env' ? 'env' : 'header'} ${sensitive.key}`;
      let move = mode === 'move';
      if (mode === 'ask' && prompter) {
        move = await prompter.confirm(`Move ${label} into Credential Manager?`, true);
      }
      if (!move) {
        kept.push({ server: candidate.name, location: sensitive.location, key: sensitive.key });
        continue;
      }
      const proposed = proposedSecretName(candidate.name, sensitive.key);
      const secretName = mode === 'ask' && prompter ? await chooseName(prompter, proposed, label) : proposed;
      const value = sensitive.scheme ? splitScheme(original).token : original;
      rawMap[sensitive.key] = makeSecretRef(secretName, sensitive.scheme);
      moves.push({
        server: candidate.name,
        location: sensitive.location,
        key: sensitive.key,
        secretName,
        value,
      });
    }
  }
  return { parsed, moves, kept, source };
}
