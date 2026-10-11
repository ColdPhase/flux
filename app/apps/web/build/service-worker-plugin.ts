import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Emits /sw.js from src/pwa/sw.js with the list of shell files to precache and a version
 * derived from their content (issue #41). A hand-written worker plus this ~60-line plugin
 * replaces vite-plugin-pwa/Workbox: no extra runtime dependency, Vite 8 compatibility is ours
 * to keep, and the caching rules (never /api/*, network-first navigations) stay explicit.
 */
export function fluxServiceWorker(source = 'src/pwa/sw.js'): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'flux-service-worker',
    apply: 'build',
    // Vite removes CSS-only JS facades while finishing the bundle. Inventory/hash the final
    // output, after those hooks, rather than precaching files which will never be written.
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle: { order: 'post', handler(_options, bundle) {
      const entries = new Map<string, string | Uint8Array>();
      for (const file of Object.values(bundle)) {
        if (file.fileName.endsWith('.map') || file.fileName === 'index.html') continue;
        entries.set(`/${file.fileName}`, file.type === 'chunk' ? file.code : file.source);
      }
      const publicDir = config.publicDir;
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else entries.set(`/${relative(publicDir, path).split(sep).join('/')}`, readFileSync(path));
        }
      };
      if (publicDir) walk(publicDir);
      if (!entries.has('/offline.html')) this.error('public/offline.html is required for the service worker fallback');
      const urls = [...entries.keys()].sort();
      const hash = createHash('sha256');
      for (const url of urls) hash.update(url).update('\0').update(entries.get(url)!).update('\0');
      const index = bundle['index.html'];
      if (index?.type === 'asset') hash.update(index.source);
      const template = readFileSync(join(config.root, source), 'utf8');
      const version = hash.digest('hex').slice(0, 16);
      const code = template
        .replace("'__FLUX_SW_VERSION__'", JSON.stringify(version))
        .replace('/* __FLUX_PRECACHE__ */ []', JSON.stringify(urls));
      if (code === template) this.error('Service worker placeholders not found');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    } },
  };
}
