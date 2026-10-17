import MiniSearch from 'minisearch';
import type { SearchWeights, ServerStatus, ToolInfo } from '@mcpier/shared';

/**
 * Splits a tool or parameter name into words: underscores, hyphens, dots, spaces and
 * camelCase boundaries (`create_issue` → create, issue; `listDirectory` → list, directory;
 * `getHTTPStatus` → get, http, status).
 */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.\-/:]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** A tool that may be searched, with what the index needs to know about its server. */
export interface SearchCandidate {
  tool: ToolInfo;
  serverDescription?: string;
  serverStatus: ServerStatus;
}

export interface ScoredCandidate {
  candidate: SearchCandidate;
  score: number;
}

/**
 * Ranking behind one small interface (SPEC 5.2): given a query and candidate tools, return a
 * scored list, best first. MiniSearch is the only implementation now; embeddings or another
 * ranker can replace it without touching anything else.
 */
export interface ToolRanker {
  rank(query: string, candidates: readonly SearchCandidate[], weights: SearchWeights): ScoredCandidate[];
}

const FIELDS = [
  'nameWords',
  'title',
  'description',
  'parameterNames',
  'serverName',
  'serverDescription',
] as const;

function parameterNames(tool: ToolInfo): string {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).flatMap(splitWords).join(' ');
}

/** MiniSearch (BM25-style) with fuzzy and prefix matching. Rebuilt once per candidate set. */
export class MiniSearchRanker implements ToolRanker {
  private built:
    { candidates: readonly SearchCandidate[]; weights: SearchWeights; index: MiniSearch } | undefined;

  private indexFor(candidates: readonly SearchCandidate[], weights: SearchWeights): MiniSearch {
    if (this.built && this.built.candidates === candidates && this.built.weights === weights)
      return this.built.index;
    const index = new MiniSearch({
      fields: [...FIELDS],
      idField: 'id',
      searchOptions: {
        boost: {
          nameWords: weights.name,
          title: weights.title,
          description: weights.description,
          parameterNames: weights.parameterNames,
          serverName: weights.serverName,
          serverDescription: weights.serverDescription,
        },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'OR',
      },
    });
    index.addAll(
      candidates.map((candidate, position) => ({
        id: position,
        nameWords: splitWords(candidate.tool.name).join(' '),
        title: candidate.tool.title ?? '',
        description: candidate.tool.description ?? '',
        parameterNames: parameterNames(candidate.tool),
        serverName: splitWords(candidate.tool.server).join(' '),
        serverDescription: candidate.serverDescription ?? '',
      })),
    );
    this.built = { candidates, weights, index };
    return index;
  }

  rank(query: string, candidates: readonly SearchCandidate[], weights: SearchWeights): ScoredCandidate[] {
    if (!query.trim() || candidates.length === 0) return [];
    const index = this.indexFor(candidates, weights);
    return index
      .search(splitWords(query).join(' ') || query)
      .map((hit) => ({ candidate: candidates[hit.id as number]!, score: hit.score }));
  }
}

export interface SearchHit {
  tool: ToolInfo;
  score: number;
  available: boolean;
  serverStatus: ServerStatus;
}

export interface SearchQuery {
  query: string;
  limit: number;
  /** Only this server's tools. */
  server?: string;
}

export interface SearchSource {
  /** Every searchable tool: enabled tools on enabled servers, available or not. */
  candidates(): SearchCandidate[];
  weights(): SearchWeights;
}

/**
 * The search index the meta-tools and `mcpier tools search` use. It holds a snapshot of the
 * candidates; `invalidate()` (on tool, status or config changes) schedules a debounced
 * rebuild, and searches keep using the previous snapshot until the new one is swapped in,
 * so a search never fails or waits for a rebuild.
 */
export class SearchIndex {
  private snapshot: { candidates: SearchCandidate[]; weights: SearchWeights };
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly source: SearchSource,
    private readonly ranker: ToolRanker = new MiniSearchRanker(),
    private readonly debounceMs = 100,
  ) {
    this.snapshot = { candidates: source.candidates(), weights: source.weights() };
  }

  /** Schedules a rebuild. Many changes in a burst cause one rebuild. */
  invalidate(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuildNow(), this.debounceMs);
    this.timer.unref();
  }

  rebuildNow(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.snapshot = { candidates: this.source.candidates(), weights: this.source.weights() };
  }

  /** Server names that currently have searchable tools. */
  serverNames(): string[] {
    return [...new Set(this.snapshot.candidates.map((candidate) => candidate.tool.server))].sort();
  }

  /**
   * Ranked matches: available tools first, then unavailable ones, each group by score. An
   * empty query with a server filter lists that server's tools (available first, by name).
   */
  search({ query, limit, server }: SearchQuery): SearchHit[] {
    const { candidates, weights } = this.snapshot;
    if (!query.trim() && !server) return [];
    const inScope = (candidate: SearchCandidate) => !server || candidate.tool.server === server;
    // Rank the whole snapshot (its index is built once) and filter afterwards.
    const scored: ScoredCandidate[] = query.trim()
      ? this.ranker.rank(query, candidates, weights).filter((hit) => inScope(hit.candidate))
      : candidates
          .filter(inScope)
          .sort((a, b) => a.tool.name.localeCompare(b.tool.name))
          .map((candidate) => ({ candidate, score: 0 }));
    const toHit = ({ candidate, score }: ScoredCandidate): SearchHit => ({
      tool: candidate.tool,
      score,
      available: candidate.tool.available,
      serverStatus: candidate.serverStatus,
    });
    const hits = scored.map(toHit);
    // Stable: within each group the ranker's order (best score first) is kept.
    return [...hits.filter((hit) => hit.available), ...hits.filter((hit) => !hit.available)].slice(0, limit);
  }

  /** Up to `count` full names close to a name nobody has (for "did you mean"). */
  suggest(fullName: string, count = 3): string[] {
    const words = splitWords(fullName.replace('__', ' ')).join(' ');
    return this.search({ query: words, limit: count }).map((hit) => hit.tool.fullName);
  }

  close(): void {
    clearTimeout(this.timer);
  }
}
