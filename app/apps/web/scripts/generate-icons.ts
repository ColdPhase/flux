import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

/**
 * Renders the Flux logo, Kreska's tile (final design F-026 §3, #339), to the icons the manifest, the
 * browser tab and iOS need. Run in the Playwright image so no host browser or image tool is needed:
 *   docker compose --env-file docker/.env -p flux-icons -f docker/compose.source.yaml -f docker/compose.test.yaml build pushmock
 *   docker run --rm -v "$PWD/app/apps/web/public/icons:/out" -v "$PWD/app/apps/web/scripts:/app/apps/web/scripts:ro" flux-e2e:flux-icons \
 *     node_modules/.bin/tsx apps/web/scripts/generate-icons.ts /out
 */
const out = process.argv[2] ?? 'apps/web/public/icons';
const INK = '#18181B';
const ON_INK = '#FFFFFF';
// Kreska's idle face, the design's paths in a 24×24 box (ui/Kreska.tsx).
const EYES = 'M9.3 11.2V13.8M14.7 11.2V13.8';
const BROW = 'M7.3 8.1 10.5 7.2';
const TILE = 'M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z';
/** The face knocked out of the tile; `scale` is the logo's own 1.14, smaller inside a maskable safe zone. */
const face = (eyes: number, brow: number, scale = 1.14) =>
  `<g transform="translate(12 12) scale(${scale}) translate(-12 -12.4)" fill="none" stroke="${ON_INK}" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="${EYES}" stroke-width="${eyes}"/><path d="${BROW}" stroke-width="${brow}"/></g>`;
/** "any" icons carry the tile's own rounded corners; maskable and Apple icons are full-bleed squares. */
const tile = (eyes: number, brow: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${TILE}" fill="${INK}"/>${face(eyes, brow)}</svg>`;
const square = (eyes: number, brow: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${INK}"/>${face(eyes, brow, 0.9)}</svg>`;

// Line weights follow the drawn size (guide §3): small for the tab, the 40–63px set for app icons.
const variants = [
  { file: 'icon-192.png', size: 192, svg: tile(2.0, 1.55) },
  { file: 'icon-512.png', size: 512, svg: tile(2.0, 1.55) },
  { file: 'maskable-192.png', size: 192, svg: square(2.0, 1.55) },
  { file: 'maskable-512.png', size: 512, svg: square(2.0, 1.55) },
  { file: 'apple-touch-icon.png', size: 180, svg: square(2.0, 1.55) },
] as const;

await mkdir(out, { recursive: true });
// The browser tab icon stays vector, with the small-size weights.
await writeFile(join(out, 'icon.svg'), tile(2.2, 1.7) + '\n');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, svg } of variants) {
    await page.setViewportSize({ width: size, height: size });
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
    await page.screenshot({ path: join(out, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`wrote ${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
