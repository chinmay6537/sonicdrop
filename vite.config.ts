import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: { port: 5178, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
});
