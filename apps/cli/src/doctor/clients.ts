// Read-only look at MCP clients' config files: does each have an MCPier entry, and do the
// paths in a bridge entry still exist? Nothing is ever written, and nothing read from these
// files is printed except their paths and entry names (they may hold other servers' tokens).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DoctorCheck } from '@mcpier/shared';
import { findCommand } from './find-command.js';

export interface ClientTarget {
  /** The `mcpier connect` client name. */
  client: 'claude-desktop' | 'cursor' | 'vscode' | 'codex';
  id: string;
  label: string;
  file: string;
  format: 'json' | 'jsonc' | 'toml';
}

/** The config files MCPier knows, under the given user folders (D-043: two for Claude Desktop). */
export function clientTargets(env: NodeJS.ProcessEnv): ClientTarget[] {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const profile = env.USERPROFILE?.trim();
  const targets: ClientTarget[] = [];
  if (appData) {
    targets.push({
      client: 'claude-desktop',
      id: 'client-claude-desktop',
      label: 'Claude Desktop',
      file: join(appData, 'Claude', 'claude_desktop_config.json'),
      format: 'json',
    });
  }
  if (localAppData) {
    targets.push({
      client: 'claude-desktop',
      id: 'client-claude-desktop-store',
      label: 'Claude Desktop (Microsoft Store)',
      file: join(
        localAppData,
        'Packages',
        'Claude_pzs8sxrjxfjjc',
        'LocalCache',
        'Roaming',
        'Claude',
        'claude_desktop_config.json',
      ),
      format: 'json',
    });
  }
  if (profile) {
    targets.push({
      client: 'cursor',
      id: 'client-cursor',
      label: 'Cursor',
      file: join(profile, '.cursor', 'mcp.json'),
      format: 'json',
    });
  }
  if (appData) {
    targets.push({
      client: 'vscode',
      id: 'client-vscode',
      label: 'VS Code',
      file: join(appData, 'Code', 'User', 'mcp.json'),
      format: 'jsonc',
    });
  }
  if (profile) {
    targets.push({
      client: 'codex',
      id: 'client-codex',
      label: 'Codex',
      file: join(profile, '.codex', 'config.toml'),
      format: 'toml',
    });
  }
  return targets;
}

/** One server entry, reduced to what the checks need. */
export interface ClientEntry {
  name: string;
  command?: string;
  args: string[];
  url?: string;
}

/** Removes `//` and `/* *\/` comments and trailing commas outside strings (VS Code's JSONC). */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function entriesFromMap(map: unknown): ClientEntry[] {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).map(([name, raw]) => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      name,
      ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
      args: Array.isArray(entry.args)
        ? entry.args.filter((arg): arg is string => typeof arg === 'string')
        : [],
      ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    };
  });
}

/** A TOML string at the start of `text`: 'literal' or "basic" (with \\ and \" escapes). */
function tomlString(text: string): { value: string; length: number } | undefined {
  const literal = /^'([^']*)'/.exec(text);
  if (literal) return { value: literal[1]!, length: literal[0].length };
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  return basic ? { value: basic[1]!.replace(/\\(["\\])/g, '$1'), length: basic[0].length } : undefined;
}

/** Just enough TOML for `[mcp_servers.<name>]` tables with command, args and url. */
export function codexEntries(text: string): ClientEntry[] {
  const entries = new Map<string, ClientEntry>();
  let current: ClientEntry | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const table = /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]$/.exec(line);
    if (table) {
      const name = table[1] ?? table[2] ?? table[3]!;
      current = entries.get(name) ?? { name, args: [] };
      entries.set(name, current);
      continue;
    }
    if (line.startsWith('[')) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const pair = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    let value = rawValue!;
    if (key === 'args') {
      // An array may span lines.
      while (!value.includes(']') && i + 1 < lines.length) value += ` ${lines[++i]!.trim()}`;
      const items: string[] = [];
      let rest = value.slice(value.indexOf('[') + 1);
      for (;;) {
        rest = rest.replace(/^[\s,]+/, '');
        if (!rest || rest.startsWith(']')) break;
        const item = tomlString(rest);
        if (item === undefined) break;
        items.push(item.value);
        rest = rest.slice(item.length);
      }
      current.args = items;
    } else if (key === 'command' || key === 'url') {
      const parsed = tomlString(value);
      if (parsed !== undefined) current[key] = parsed.value;
    }
  }
  return [...entries.values()];
}

/** The server entries in a client's config file; throws (without any file content) if it cannot be read. */
export function readClientEntries(target: ClientTarget): ClientEntry[] {
  const text = readFileSync(target.file, 'utf8').replace(/^\uFEFF/, '');
  if (target.format === 'toml') return codexEntries(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(target.format === 'jsonc' ? stripJsonc(text) : text) as Record<string, unknown>;
  } catch {
    // Never the parser's message: it can quote the file, and the file may hold tokens.
    throw new Error('not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('not a JSON object');
  return [...entriesFromMap(parsed.mcpServers), ...entriesFromMap(parsed.servers)];
}

const LOCAL_MCP_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/mcp\/?$/i;

/** Whether an entry points at MCPier: its name, the bridge script, or the local /mcp URL. */
export function isMcpierEntry(entry: ClientEntry): boolean {
  return (
    entry.name.toLowerCase() === 'mcpier' ||
    entry.args.some((arg) => /[\\/]mcpier\.js$/i.test(arg)) ||
    (entry.url !== undefined && LOCAL_MCP_URL.test(entry.url))
  );
}

export function checkClient(target: ClientTarget, port: number, env: NodeJS.ProcessEnv): DoctorCheck {
  const base = { area: 'clients' as const, id: target.id };
  const snippet = `mcpier connect ${target.client}`;
  if (!existsSync(target.file)) {
    return {
      ...base,
      status: 'pass',
      message: `${target.label}: no config file at ${target.file} (not set up here).`,
    };
  }
  let entries: ClientEntry[];
  try {
    entries = readClientEntries(target);
  } catch (error) {
    return {
      ...base,
      status: 'warn',
      message: `${target.label}: ${target.file} could not be read (${(error as Error).message}).`,
      fix: `Open ${target.file} and fix it; ${target.label} cannot read it either. "${snippet}" prints the MCPier entry.`,
    };
  }
  const ours = entries.filter(isMcpierEntry);
  if (ours.length === 0) {
    return {
      ...base,
      status: 'warn',
      message: `${target.label}: ${target.file} has no MCPier entry.`,
      fix: `Run "${snippet}" and add the entry it prints to ${target.file}.`,
    };
  }
  const problems: string[] = [];
  for (const entry of ours) {
    if (entry.url !== undefined) {
      const entryPort = Number(LOCAL_MCP_URL.exec(entry.url)?.[1]);
      if (entryPort !== port)
        problems.push(`entry "${entry.name}" uses port ${entryPort}, but MCPier uses ${port}`);
      continue;
    }
    if (entry.command !== undefined) {
      const node = findCommand(entry.command, env, dirname(target.file));
      if (!node) problems.push(`entry "${entry.name}" runs ${entry.command}, which does not exist`);
      const script = entry.args.find((arg) => /mcpier\.js$/i.test(arg));
      if (script && !existsSync(script))
        problems.push(`entry "${entry.name}" points at ${script}, which does not exist`);
    }
  }
  const names = ours.map((entry) => `"${entry.name}"`).join(', ');
  if (problems.length > 0) {
    return {
      ...base,
      status: 'fail',
      message: `${target.label}: ${target.file}: ${problems.join('; ')}.`,
      fix: `Run "${snippet}" and replace the entry in ${target.file} with the one it prints (the repository or Node.js may have moved, or the port changed).`,
    };
  }
  return {
    ...base,
    status: 'pass',
    message: `${target.label}: MCPier entry ${names} in ${target.file}; its paths exist.`,
  };
}
