import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fluxPrecompress } from './build/precompress-plugin.js';
import { fluxServiceWorker } from './build/service-worker-plugin.js';

// `./flux dev` (issue #72) sets FLUX_DEV_API_URL: the dev server proxies /api, including the
// WebSocket stream, to the API container and keeps the browser's Origin header unchanged so
// the API's origin policy sees the dev origin it was configured with. Builds ignore it.
const devApi = process.env.FLUX_DEV_API_URL;

export default defineConfig({
  plugins: [fluxServiceWorker(), fluxPrecompress()],
  build: {
    modulePreload: {
      // A failed dynamic JS modulepreload can poison WebKit's resource cache even across reload
      // (WebKit270357). Native import still loads the code; keep its CSS and eager HTML preloads.
      // This public Vite8 option is experimental and covered by actual HTTP503/reload browser tests.
      resolveDependencies: (_url, dependencies, { hostType }) => hostType === 'js'
        ? dependencies.filter((path) => !path.endsWith('.js'))
        : dependencies,
    },
  },
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
