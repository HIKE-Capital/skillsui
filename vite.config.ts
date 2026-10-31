import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { DEV_PORT } from './src/shared/dev.js';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // ^ anchors the regex: only real API paths (/api/...) are proxied.
      // A bare '/api' prefix would also swallow /api.ts, the web api module.
      '^/api/': `http://127.0.0.1:${DEV_PORT}`,
    },
  },
});
