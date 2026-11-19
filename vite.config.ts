import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'web',
  server: { port: 5178, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
  // The page lives in web/, the tests in test/.
  test: { root: here },
});
