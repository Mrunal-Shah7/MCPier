import type { Logger } from '../logger.js';
import type { Tool } from '../upstream/types.js';
import type { Db } from './database.js';

/** Where the manager keeps each server's last listed tools between runs. */
export interface ToolCache {
  load(server: string): Tool[] | undefined;
  save(server: string, tools: readonly Tool[]): void;
  remove(server: string): void;
}

/**
 * The last successfully listed tools of each server, in `mcpier.db`. At start the manager
 * seeds each enabled server's catalog from it (marked unavailable until the server is ready),
 * so `search_tools` covers servers that are still starting or need sign-in.
 */
export class SqliteToolCache implements ToolCache {
  private readonly selectOne;
  private readonly upsert;
  private readonly deleteOne;

  constructor(
    db: Db,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.selectOne = db.prepare('SELECT tools FROM tool_cache WHERE server = ?');
    this.upsert = db.prepare(
      `INSERT INTO tool_cache (server, tools, listed_at) VALUES (?, ?, ?)
       ON CONFLICT (server) DO UPDATE SET tools = excluded.tools, listed_at = excluded.listed_at`,
    );
    this.deleteOne = db.prepare('DELETE FROM tool_cache WHERE server = ?');
  }

  load(server: string): Tool[] | undefined {
    try {
      const row = this.selectOne.get(server) as { tools: string } | undefined;
      if (!row) return undefined;
      const tools = JSON.parse(row.tools) as unknown;
      return Array.isArray(tools) ? (tools as Tool[]) : undefined;
    } catch (error) {
      this.logger.warn(
        { server, err: { message: (error as Error).message } },
        'Could not read the tool cache',
      );
      return undefined;
    }
  }

  save(server: string, tools: readonly Tool[]): void {
    try {
      this.upsert.run(server, JSON.stringify(tools), this.now());
    } catch (error) {
      this.logger.warn(
        { server, err: { message: (error as Error).message } },
        'Could not write the tool cache',
      );
    }
  }

  remove(server: string): void {
    try {
      this.deleteOne.run(server);
    } catch (error) {
      this.logger.warn(
        { server, err: { message: (error as Error).message } },
        'Could not clear the tool cache',
      );
    }
  }
}
