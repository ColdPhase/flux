import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

/**
 * Renders the placeholder Flux mark to the PNG icons the manifest and iOS need (issue #41).
 * Run in the Playwright image so no host browser or image tool is needed:
 *   docker compose --env-file docker/.env -p flux-icons -f docker/compose.source.yaml -f docker/compose.test.yaml build pushmock
 *   docker run --rm -v "$PWD/app/apps/web/public/icons:/out" flux-e2e:flux-icons \
 *     node_modules/.bin/tsx apps/web/scripts/generate-icons.ts /out
 */
const out = process.argv[2] ?? 'apps/web/public/icons';
const ACCENT = '#5159C8';
const GLYPH = '<path d="M168 144h176v52H228v48h100v50H228v74h-60z" fill="#FFFFFF"/>';
// Maskable and Apple icons are full-bleed squares (the platform applies its own mask), with the
// glyph well inside the central 80% safe zone. "any" icons carry their own rounded corners.
const variants = [
  { file: 'icon-192.png', size: 192, shape: 'rounded' },
  { file: 'icon-512.png', size: 512, shape: 'rounded' },
  { file: 'maskable-192.png', size: 192, shape: 'full' },
  { file: 'maskable-512.png', size: 512, shape: 'full' },
  { file: 'apple-touch-icon.png', size: 180, shape: 'full' },
] as const;

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, shape } of variants) {
    await page.setViewportSize({ width: size, height: size });
    const background = shape === 'rounded' ? `<rect width="512" height="512" rx="112" fill="${ACCENT}"/>` : `<rect width="512" height="512" fill="${ACCENT}"/>`;
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512" style="display:block">${background}${GLYPH}</svg></body></html>`);
    await page.screenshot({ path: join(out, file), omitBackground: shape === 'rounded', clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`wrote ${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
