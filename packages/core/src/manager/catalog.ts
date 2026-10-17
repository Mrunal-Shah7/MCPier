import { fullToolName, type ServerEntry, type ToolInfo } from '@mcpier/shared';
import type { Tool } from '../upstream/types.js';

/** Characters MCP tool names may use. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Why an upstream tool name breaks MCPier's naming rule, or `undefined` if it is fine.
 * Flagged tools are kept, listed and callable: full names split at the first `__`, and server
 * names never contain `__`, so even a tool name containing `__` resolves correctly.
 */
export function toolNameFlag(name: string): string | undefined {
  if (name.includes('__')) {
    return 'The tool name contains "__", the separator between server and tool names; it still resolves, but reads ambiguously.';
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return 'The tool name uses characters outside A-Z, a-z, 0-9, "_", "-" and "." (or is longer than 128).';
  }
  return undefined;
}

function hint(tool: Tool, key: 'readOnlyHint' | 'destructiveHint'): boolean | undefined {
  const value = tool.annotations?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Catalog entries for one server's last known tools. */
export function catalogEntries(entry: ServerEntry, tools: readonly Tool[], available: boolean): ToolInfo[] {
  return tools.map((tool) => {
    const info: ToolInfo = {
      fullName: fullToolName(entry.name, tool.name),
      server: entry.name,
      name: tool.name,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      enabled: entry.enabled && !entry.disabledTools.includes(tool.name),
      available,
    };
    const title = tool.title ?? tool.annotations?.title;
    if (title) info.title = title;
    if (tool.description) info.description = tool.description;
    if (tool.outputSchema) info.outputSchema = tool.outputSchema as Record<string, unknown>;
    const readOnly = hint(tool, 'readOnlyHint');
    if (readOnly !== undefined) info.readOnlyHint = readOnly;
    const destructive = hint(tool, 'destructiveHint');
    if (destructive !== undefined) info.destructiveHint = destructive;
    const flag = toolNameFlag(tool.name);
    if (flag) info.flag = flag;
    return info;
  });
}
