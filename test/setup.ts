// Runs before every test file (see vitest.config.ts).
import { homedir } from 'node:os';
import { join } from 'node:path';

// Safety net: the data-directory resolver throws for this path (and anything inside it)
// while this variable is set. Child processes started by tests inherit it, so a gateway or
// CLI launched without MCPIER_HOME fails instead of touching the user's real data.
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
process.env.MCPIER_TEST_FORBIDDEN_HOME = join(localAppData, 'MCPier');

// Never inherit the developer's own overrides; tests pass explicit values.
delete process.env.MCPIER_HOME;
delete process.env.MCPIER_PORT;
