import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PATH from an environment, whatever the case of its name (Windows uses `Path`). */
export function pathOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key ? (env[key] ?? '') : '';
}

/**
 * Where a command would be found, the way Windows launches it: a path is checked as written
 * (and with each PATHEXT extension when it has none); a bare name is looked up in each PATH
 * folder with the PATHEXT extensions (a file named just `npx` is a shell script Windows cannot
 * run). Reads the file system only; nothing is started.
 */
export function findCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): string | undefined {
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = (base: string) =>
    extname(base) ? [base, ...extensions.map((ext) => base + ext)] : extensions.map((ext) => base + ext);
  if (/[\\/]/.test(command) || isAbsolute(command)) {
    const full = resolve(cwd, command);
    return [full, ...candidates(full)].find(isFile);
  }
  for (const dir of pathOf(env).split(delimiter).filter(Boolean)) {
    const found = candidates(join(dir, command)).find(isFile);
    if (found) return found;
  }
  return undefined;
}
