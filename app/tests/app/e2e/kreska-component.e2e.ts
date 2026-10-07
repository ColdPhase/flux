import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { expressions, sizes, kreskaComponentFixture } from '../../../apps/web/scripts/kreska-component-fixture.js';

// Actual React component and the application's built CSS, viewed separately from live-app journeys.
// This verifies all 80 frames, sizing/weights and reduced motion; integration is tested elsewhere.
test('all sixteen production Kreska expressions at five sizes retain static frames in Chromium and WebKit', async () => {
  const assets = join(process.cwd(), 'apps/web/dist/assets');
  const css = readdirSync(assets).filter((file) => file.endsWith('.css')).map((file) => readFileSync(join(assets, file), 'utf8')).join('\n');
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const scheme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1050, height: 1350 }, reducedMotion: 'reduce', colorScheme: scheme });
        await page.setContent(`<style>${css}</style><style>body{margin:24px;background:var(--bg);color:var(--t1)}main{display:grid;grid-template-columns:1fr 1fr;gap:12px}section{display:flex;align-items:center;gap:20px;min-height:132px;padding:8px;background:var(--el)}h2{font-size:14px;width:90px}section>div{display:grid;gap:12px;font-size:12px}</style><main>${kreskaComponentFixture()}</main>`);
        assert.equal(await page.locator('.kreska').count(), 80);
        for (const expression of expressions) {
          for (const size of sizes) {
            const face = page.locator(`[data-face="${expression}"] [data-size="${size}"] .kreska`);
            const box = await face.boundingBox();
            assert.equal(box?.width, size); assert.equal(box?.height, size);
            assert.equal(await face.getAttribute('data-expression'), expression);
            assert.equal(await face.locator('.kreska__frame').getAttribute('stroke-width'), size >= 40 ? '1.5' : '1.8');
            assert.equal(await face.locator('.kreska__brow').getAttribute('stroke-width'), size >= 40 ? '1.55' : '1.7');
            assert.equal(await face.locator('.kreska__eyes, .kreska__dots').count(), 1, `${expression}/${size} draws its eyes`);
            const drawings = await face.locator('path, circle').evaluateAll((parts) => parts.map((part) => { const b = (part as SVGGraphicsElement).getBBox(); return [b.width, b.height]; }));
            assert.ok(drawings.every(([width, height]) => width > 0 || height > 0), `${expression}/${size} has drawn static geometry`);
          }
        }
        assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
        const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
        if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `339-kreska-80-frames-${engine.name()}-${scheme}.png`), fullPage: true }); }
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.waitForFunction(() => document.getAnimations().length > 0);
        const animated = await page.evaluate(() => [...new Set(document.getAnimations().map((animation) => (animation.effect as KeyframeEffect).target?.closest('.kreska')?.getAttribute('data-expression')))].sort());
        assert.deepEqual(animated, ['loading', 'thinking', 'working']);
        await page.close();
      }
    } finally { await browser.close(); }
  }
});
