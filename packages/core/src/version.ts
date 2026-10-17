import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Name of the root package.json, which carries the project version. */
const ROOT_PACKAGE_NAME = 'mcpier';

let cachedRoot: string | undefined;

/**
 * The repository root, found by walking up from this file to the package.json named
 * `mcpier`. MCPier runs from the cloned repository, so this always exists.
 */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === ROOT_PACKAGE_NAME) {
        cachedRoot = dir;
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('Cannot find the MCPier repository root (package.json named "mcpier")');
    dir = parent;
  }
}

let cachedVersion: string | undefined;

/** The project version from the root package.json. */
export function projectVersion(): string {
  if (!cachedVersion) {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { version: string };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}

/** Where the built dashboard lives: `apps/web/dist` in the repository. */
export function defaultWebRoot(): string {
  return join(repoRoot(), 'apps', 'web', 'dist');
}
