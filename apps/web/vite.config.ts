import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The project version lives in the root package.json. It is baked into the page at build
// time so the not-signed-in page can show it without calling the API.
const rootPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  version: string;
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Radix's scroll lock would inject a <style> the CSP blocks; see the shim (BUGS B-4).
      {
        find: /^react-style-singleton$/,
        replacement: fileURLToPath(new URL('./src/lib/style-singleton-shim.ts', import.meta.url)),
      },
    ],
  },
  define: {
    __MCPIER_VERSION__: JSON.stringify(rootPackage.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Everything is a file the gateway serves: no inline data: URLs (the CSP allows 'self' only).
    assetsInlineLimit: 0,
    // One local bundle (React, Radix, zod for the shared validation): loaded once from 127.0.0.1.
    chunkSizeWarningLimit: 1024,
  },
});
