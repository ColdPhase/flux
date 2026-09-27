import { defineConfig } from 'vite';
import { fluxServiceWorker } from './build/service-worker-plugin.js';

export default defineConfig({
  plugins: [fluxServiceWorker()],
});
