// Removes build output from every package. Usage: pnpm clean
import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

for (const group of ['packages', 'apps']) {
  for (const name of readdirSync(group)) {
    rmSync(join(group, name, 'dist'), { recursive: true, force: true });
    rmSync(join(group, name, 'tsconfig.tsbuildinfo'), { force: true });
  }
}
