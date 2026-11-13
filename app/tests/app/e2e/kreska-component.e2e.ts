import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { expressions, sizes, kreskaComponentFixture } from '../../../apps/web/scripts/kreska-component-fixture.js';

const loop = (name: string, count = 1) => Array.from({ length: count }, () => `${name} infinite`);
const once = (name: string, count = 1) => Array.from({ length: count }, () => `${name} 1`);
/** Each expression's motion as ui.css draws it (final design §3, #1342): every animated part's name and iteration count, sorted. */
const MOTION: Record<string, string[]> = {
  idle: loop('kreska-blink-rare'), working: loop('kreska-blink'), thinking: loop('kreska-wave'), writing: once('kreska-pen'), reading: once('kreska-scan'),
  waiting: once('kreska-look-down'), asking: once('kreska-lift'), looking: [...once('kreska-glance'), ...once('kreska-glance-brow')], loading: loop('kreska-dot', 3),
  surprised: [...once('kreska-jump'), ...once('kreska-pop', 2)], done: once('kreska-settle'), wink: [...once('kreska-wink-open'), ...once('kreska-wink-shut')],
  celebrate: [...once('kreska-settle'), ...once('kreska-sparkle')], hello: once('kreska-hello'), asleep: [...loop('kreska-breathe'), ...loop('kreska-drift')], worried: once('kreska-drop'),
};
/** At 20px or less only the loops that moved there before #1342. */
const SMALL: Record<string, string[]> = { working: MOTION.working!, thinking: MOTION.thinking!, loading: MOTION.loading! };
const motion = (face: Element) => [...face.querySelectorAll('*')].map((part) => getComputedStyle(part)).filter((style) => style.animationName !== 'none')
  .map((style) => `${style.animationName} ${style.animationIterationCount}`).sort();

// Actual React component and the application's built CSS, viewed separately from live-app journeys.
// This verifies all 80 frames, sizing/weights and reduced motion; integration is tested elsewhere.
test('all sixteen production Kreska expressions at five sizes retain static frames, and move as the design draws them, in Chromium and WebKit', async () => {
  const assets = join(process.cwd(), 'apps/web/dist/assets');
  const css = readdirSync(assets).filter((file) => file.endsWith('.css')).map((file) => readFileSync(join(assets, file), 'utf8')).join('\n');
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const scheme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1050, height: 1350 }, reducedMotion: 'reduce', colorScheme: scheme });
        await page.goto(`${process.env.FLUX_API_URL ?? 'http://api:8080'}/sign-in`);
        await page.setContent(`<style>${css}</style><style>body{margin:24px;background:var(--bg);color:var(--t1)}main{display:grid;grid-template-columns:1fr 1fr;gap:12px}section{display:flex;align-items:center;gap:20px;min-height:132px;padding:8px;background:var(--el)}h2{font-size:14px;width:90px}section>div{display:grid;gap:12px;font-size:12px}</style><main>${kreskaComponentFixture()}</main>`);
        await page.evaluate(() => document.fonts.ready);
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
        // Each expression's own motion (#1342): one-shots play once, only the ongoing states loop. At 20px or less only the three
        // loops that moved there before run, and a face without a state stays still.
        for (const expression of expressions) {
          for (const size of sizes) {
            const moving = await page.locator(`[data-face="${expression}"] [data-size="${size}"] .kreska`).evaluate(motion);
            assert.deepEqual(moving, size <= 20 ? (SMALL[expression] ?? []) : MOTION[expression], `${engine.name()} ${scheme}: ${expression} at ${size}px`);
          }
        }
        await page.evaluate(() => { const plain = document.querySelector('[data-face="idle"] [data-size="48"] .kreska')!; plain.removeAttribute('data-moves'); });
        assert.deepEqual(await page.locator('[data-face="idle"] [data-size="48"] .kreska').evaluate(motion), [], 'a face without a state stays still');
        // Reduced motion in Settings → Appearance, and Kreska's small moments off, each leave every face its static frame.
        for (const [attribute, value] of [['motion', 'reduce'], ['kreska', 'off']] as const) {
          await page.evaluate(([name, setting]) => { document.documentElement.dataset[name] = setting; }, [attribute, value]);
          const still = await page.locator('.kreska').evaluateAll((faces) => faces.flatMap((face) => [...face.querySelectorAll('*')]).filter((part) => getComputedStyle(part).animationName !== 'none').length);
          assert.equal(still, 0, `${engine.name()} ${scheme}: data-${attribute}="${value}" stops every Kreska motion`);
          await page.evaluate((name) => { delete document.documentElement.dataset[name]; }, attribute);
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }
});
