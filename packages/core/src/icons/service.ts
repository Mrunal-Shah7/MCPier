// The icon cache (Sprint 7): `<data>\icons\`, one file per server (and per theme when the server
// gave a light and a dark icon), plus `<server>.json` with the source, the URL it came from (no
// query string), the content type, the SHA-256 and when it was fetched. The folder sits inside
// the data directory and inherits its restriction to the current user.
//
// When: in the background after a server becomes ready (an HTTP server that never does, such as
// one that needs sign-in, still gets its site's favicon), again after 7 days, and at once on
// "Refresh icon" or when the `icon` field changes. A failure is remembered for a day.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IconSource, ServerEntry, ServerIconInfo } from '@mcpier/shared';
import type { Logger } from '../logger.js';
import type { UpstreamServerInfo } from '../upstream/types.js';
import { discoverIcon, type IconDiscovery, type IconVariant, type IconVariantName } from './discover.js';
import type { IconFetcher } from './fetcher.js';
import { ICON_EXTENSIONS, ICON_TYPES, type IconContentType } from './image-type.js';

export const ICON_REFRESH_AFTER_MS = 7 * 86_400_000;
export const ICON_FAILURE_RETRY_MS = 86_400_000;

interface StoredVariant {
  file: string;
  contentType: IconContentType;
  sha256: string;
  bytes: number;
  /** Where it came from, without a query string. */
  url: string;
}

/** `<server>.json`: no value from config, no header, no token, no query string. */
interface IconMeta {
  format: 'mcpier-icon';
  version: 1;
  server: string;
  fetchedAt: string;
  /** Whether the server's own `serverInfo` was known when this was decided. */
  withServerInfo: boolean;
  /** The `icon` field this was decided for (so a change is noticed after a restart too). */
  iconField?: string;
  source?: IconSource;
  variants?: Partial<Record<IconVariantName, StoredVariant>>;
  /** `icon: "none"`. */
  disabled?: boolean;
  failure?: { reason: string };
}

export type IconTrigger = 'ready' | 'not_ready' | 'config' | 'refresh';

export interface IconServiceOptions {
  dir: string;
  fetcher: IconFetcher;
  logger: Logger;
  now?: () => number;
  /** Fetches running at once across servers. */
  concurrency?: number;
}

export interface IconFile {
  path: string;
  contentType: IconContentType;
  /** A strong validator: the quoted start of the SHA-256. */
  etag: string;
}

const etagOf = (sha256: string) => `"${sha256.slice(0, 32)}"`;
const hasServerHints = (info: UpstreamServerInfo | undefined) =>
  Boolean(info && ((info.icons?.length ?? 0) > 0 || info.websiteUrl));

export class IconService extends EventEmitter<{ changed: [server: string] }> {
  private readonly metas = new Map<string, IconMeta>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: IconServiceOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.load();
  }

  private metaPath(server: string): string {
    return join(this.options.dir, `${server}.json`);
  }

  private load(): void {
    if (!existsSync(this.options.dir)) return;
    for (const name of readdirSync(this.options.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.options.dir, name), 'utf8')) as IconMeta;
        if (meta.format === 'mcpier-icon' && meta.version === 1 && `${meta.server}.json` === name) {
          this.metas.set(meta.server, meta);
        }
      } catch {
        // An unreadable metadata file counts as no icon; the next fetch replaces it.
      }
    }
  }

  /** What server summaries say about the icon. */
  info(server: string): ServerIconInfo {
    const meta = this.metas.get(server);
    const main = meta?.variants?.default;
    if (!meta || !main || !this.fileExists(main)) return { available: false };
    const themes = (['light', 'dark'] as const).filter((theme) => meta.variants?.[theme]);
    const etag = createHash('sha256')
      .update(
        Object.values(meta.variants ?? {})
          .map((variant) => variant.sha256)
          .join(':'),
      )
      .digest('hex')
      .slice(0, 16);
    return {
      available: true,
      ...(meta.source ? { source: meta.source } : {}),
      etag,
      ...(themes.length === 2 ? { themes } : {}),
    };
  }

  private fileExists(variant: StoredVariant): boolean {
    return existsSync(join(this.options.dir, variant.file));
  }

  /** The file to serve for a theme: that theme's icon when there are two, otherwise the one icon. */
  file(server: string, theme?: 'light' | 'dark'): IconFile | undefined {
    const variants = this.metas.get(server)?.variants;
    const variant = (theme ? variants?.[theme] : undefined) ?? variants?.default;
    if (
      !variant ||
      !this.fileExists(variant) ||
      !(ICON_TYPES as readonly string[]).includes(variant.contentType)
    )
      return undefined;
    return {
      path: join(this.options.dir, variant.file),
      contentType: variant.contentType,
      etag: etagOf(variant.sha256),
    };
  }

  /**
   * Fetches now if the cache says so (see the module comment). `refresh` and `config` always
   * fetch. Returns at once; the work runs in the background, one fetch per server at a time.
   */
  consider(
    entry: ServerEntry,
    serverInfo: UpstreamServerInfo | undefined,
    trigger: IconTrigger,
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A request that arrives during a fetch is looked at again once that fetch is done: it may
    // carry what the running one lacked (the server's own serverInfo, once it is ready).
    const running = this.inFlight.get(entry.name);
    if (running) return running.then(() => this.consider(entry, serverInfo, trigger));
    if (!this.due(entry, serverInfo, trigger)) return Promise.resolve();
    return this.fetch(entry, serverInfo);
  }

  /** "Refresh icon": fetches again now, ignoring the 7-day and 1-day timers; resolves when done. */
  refresh(entry: ServerEntry, serverInfo: UpstreamServerInfo | undefined): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.fetch(entry, serverInfo, true);
  }

  private due(entry: ServerEntry, serverInfo: UpstreamServerInfo | undefined, trigger: IconTrigger): boolean {
    if (trigger === 'refresh' || trigger === 'config') return true;
    // A server that is not ready has no serverInfo: only an HTTP server's site can be tried.
    if (trigger === 'not_ready' && entry.transport !== 'http' && entry.icon === undefined) return false;
    const meta = this.metas.get(entry.name);
    if (!meta) return true;
    if (meta.iconField !== entry.icon) return true;
    if (meta.disabled) return false;
    // A decision made before the server could describe itself is reconsidered once it can.
    if (trigger === 'ready' && !meta.withServerInfo && hasServerHints(serverInfo) && meta.source !== 'config')
      return true;
    const age = this.now() - Date.parse(meta.fetchedAt);
    return meta.failure ? age >= ICON_FAILURE_RETRY_MS : age >= ICON_REFRESH_AFTER_MS;
  }

  private fetch(entry: ServerEntry, serverInfo: UpstreamServerInfo | undefined, wait = false): Promise<void> {
    const running = this.inFlight.get(entry.name);
    if (running) return wait ? running.then(() => this.fetch(entry, serverInfo)) : running;
    const job = this.slot()
      .then(async () => {
        try {
          if (this.closed) return;
          const found = await discoverIcon(
            { entry, ...(serverInfo ? { serverInfo } : {}) },
            this.options.fetcher,
          );
          if (!this.closed) this.store(entry, serverInfo, found);
        } catch (error) {
          this.options.logger.warn(
            { server: entry.name, err: { message: (error as Error)?.message } },
            'Icon: could not be fetched',
          );
        } finally {
          this.release();
        }
      })
      .finally(() => this.inFlight.delete(entry.name));
    this.inFlight.set(entry.name, job);
    return job;
  }

  private slot(): Promise<void> {
    if (this.running < (this.options.concurrency ?? 2)) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.running++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  private store(entry: ServerEntry, serverInfo: UpstreamServerInfo | undefined, found: IconDiscovery): void {
    const before = JSON.stringify(this.info(entry.name));
    mkdirSync(this.options.dir, { recursive: true });
    const meta: IconMeta = {
      format: 'mcpier-icon',
      version: 1,
      server: entry.name,
      fetchedAt: new Date(this.now()).toISOString(),
      withServerInfo: serverInfo !== undefined,
      ...(entry.icon !== undefined ? { iconField: entry.icon } : {}),
    };
    const keep = new Set<string>();
    if (found.kind === 'found') {
      meta.source = found.source;
      meta.variants = {};
      for (const [name, variant] of Object.entries(found.variants) as [
        IconVariantName,
        IconVariant | undefined,
      ][]) {
        if (!variant) continue;
        const file = `${entry.name}${name === 'default' ? '' : `-${name}`}.${ICON_EXTENSIONS[variant.contentType]}`;
        this.writeAtomically(file, variant.bytes);
        keep.add(file);
        meta.variants[name] = {
          file,
          contentType: variant.contentType,
          sha256: createHash('sha256').update(variant.bytes).digest('hex'),
          bytes: variant.bytes.byteLength,
          url: variant.url,
        };
      }
    } else if (found.kind === 'disabled') {
      meta.disabled = true;
    } else {
      meta.failure = { reason: 'nothing usable found' };
    }
    this.removeFiles(entry.name, keep);
    this.writeAtomically(`${entry.name}.json`, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
    this.metas.set(entry.name, meta);

    // One line per server: what was tried and what came of it (URLs without query strings).
    const result =
      found.kind === 'found'
        ? `found (${found.source})`
        : found.kind === 'disabled'
          ? 'disabled ("none")'
          : 'none found';
    this.options.logger.info(
      {
        server: entry.name,
        result,
        tried: found.attempts.map(
          (attempt) =>
            `${attempt.source} ${attempt.url}: ${attempt.result}${attempt.bytes !== undefined ? ` (${attempt.bytes} bytes)` : ''}`,
        ),
        ...(found.kind === 'found' ? { bytes: found.variants.default.bytes.byteLength } : {}),
      },
      `Icon: ${result}`,
    );
    if (JSON.stringify(this.info(entry.name)) !== before) this.emit('changed', entry.name);
  }

  private writeAtomically(file: string, bytes: Uint8Array): void {
    const target = join(this.options.dir, file);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
          rmSync(temporary, { force: true });
          throw error;
        }
      }
    }
  }

  /** Deletes a server's icon files except `keep` (metadata included unless kept). */
  private removeFiles(server: string, keep: Set<string> = new Set()): void {
    if (!existsSync(this.options.dir)) return;
    const pattern = new RegExp(
      `^${server}(?:-light|-dark)?\\.(?:${Object.values(ICON_EXTENSIONS).join('|')})$`,
    );
    for (const name of readdirSync(this.options.dir)) {
      if (pattern.test(name) && !keep.has(name)) rmSync(join(this.options.dir, name), { force: true });
    }
  }

  /** Removing a server deletes its icons and their metadata. */
  remove(server: string): void {
    this.removeFiles(server);
    rmSync(this.metaPath(server), { force: true });
    this.metas.delete(server);
  }

  /** Stops new fetches; one already running finishes without writing anything. */
  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }
}
