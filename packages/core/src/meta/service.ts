import type { Settings } from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { ServerManager } from '../manager/manager.js';
import type { MetaToolContext } from './meta-tools.js';
import { LogRecorder, type Recorder } from './recorder.js';
import { RequestStateSigner } from './request-state.js';
import { SearchIndex, type SearchCandidate, type ToolRanker } from './search.js';
import { ArgumentValidator } from './validation.js';

export interface MetaServiceOptions {
  manager: ServerManager;
  settings: () => Settings;
  logger: Logger;
  /** HMAC key for `requestState` (the `state-key` file). */
  stateKey: Buffer;
  recorder?: Recorder;
  ranker?: ToolRanker;
  /** Clock for `requestState` expiry (tests). */
  now?: () => number;
  /** Debounce for index rebuilds. Default 100 ms. */
  debounceMs?: number;
}

export interface MetaService extends MetaToolContext {
  /** Rebuild the index now (config applied, tests). */
  refresh(): void;
  close(): void;
}

/** Searchable tools: enabled tools on enabled servers, with their server's description and state. */
export function searchCandidates(manager: ServerManager): SearchCandidate[] {
  const servers = new Map(manager.summaries().map((server) => [server.name, server]));
  return manager
    .tools()
    .filter((tool) => tool.enabled && servers.get(tool.server)?.enabled)
    .map((tool) => {
      const server = servers.get(tool.server)!;
      return {
        tool,
        ...(server.description ? { serverDescription: server.description } : {}),
        serverStatus: server.status.state,
      };
    });
}

/**
 * Everything the meta-tools need, wired to the manager: the index is rebuilt (debounced) on
 * every tool or status change, and cached validators of tools that are gone are dropped.
 */
export function createMetaService(options: MetaServiceOptions): MetaService {
  const { manager } = options;
  const validator = new ArgumentValidator(options.logger);
  const search = new SearchIndex(
    { candidates: () => searchCandidates(manager), weights: () => options.settings().searchWeights },
    options.ranker,
    options.debounceMs,
  );
  const onChange = () => {
    search.invalidate();
    validator.retain(manager.tools().map((tool) => tool.fullName));
  };
  manager.on('tools', onChange);
  manager.on('status', onChange);
  return {
    manager,
    search,
    validator,
    signer: new RequestStateSigner(options.stateKey, options.now),
    recorder: options.recorder ?? new LogRecorder(options.logger),
    settings: options.settings,
    refresh: () => search.rebuildNow(),
    close() {
      manager.off('tools', onChange);
      manager.off('status', onChange);
      search.close();
    },
  };
}
