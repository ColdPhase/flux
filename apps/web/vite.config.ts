import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fluxServiceWorker } from './build/service-worker-plugin.js';

// `./flux dev` (issue #72) sets FLUX_DEV_API_URL: the dev server proxies /api, including the
// WebSocket stream, to the API container and keeps the browser's Origin header unchanged so
// the API's origin policy sees the dev origin it was configured with. Builds ignore it.
const devApi = process.env.FLUX_DEV_API_URL;

export default defineConfig({
  plugins: [fluxServiceWorker()],
  resolve: devApi
    ? { alias: { '@flux/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) } }
    : undefined,
  server: devApi
    ? {
        proxy: { '/api': { target: devApi, ws: true } },
        watch: process.env.FLUX_DEV_POLL === 'true' ? { usePolling: true, interval: 300 } : undefined,
      }
    : undefined,
});
