import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fluxPrecompress } from './build/precompress-plugin.js';

// The PDF viewer frame (C-60, #1350) is a page of its own, built after the app into `dist/pdf-viewer/`: one script that carries PDF.js and
// its worker, one stylesheet and one HTML file. It is not part of the app's bundle or its offline shell (it needs the network like the
// file it shows), and the server gives it its own policy and headers (`http/pdf-viewer.ts`).
export default defineConfig({
  root: fileURLToPath(new URL('./pdf-viewer', import.meta.url)),
  base: '/pdf-viewer/',
  publicDir: false,
  plugins: [fluxPrecompress()],
  build: {
    outDir: fileURLToPath(new URL('./dist/pdf-viewer', import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
  },
});
