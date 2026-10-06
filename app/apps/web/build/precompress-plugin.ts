import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Plugin, ResolvedConfig } from 'vite';

const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt|xml)$/;

/**
 * Writes a Brotli (`.br`) and a gzip (`.gz`) copy next to every compressible file of the build
 * (#266 item 9), so the API's static handler (`preCompressed`) sends about a quarter of the bytes
 * to a phone without compressing anything per request. Only node:zlib is used; a copy is kept
 * only when it is smaller than the original.
 */
export function fluxPrecompress(minBytes = 1024): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'flux-precompress',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          const stat = statSync(path);
          if (stat.isDirectory()) { walk(path); continue; }
          if (!COMPRESSIBLE.test(name) || stat.size < minBytes) continue;
          const bytes = readFileSync(path);
          const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
          const gz = gzipSync(bytes, { level: 9 });
          if (br.length < bytes.length) writeFileSync(`${path}.br`, br);
          if (gz.length < bytes.length) writeFileSync(`${path}.gz`, gz);
        }
      };
      walk(outDir);
    },
  };
}
