import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  const reports = [];
  for (const suffix of ['decoded-natural', 'source-natural']) {
    const bytes = readFileSync(`/evidence/code_4-viewer-2-code-2-${suffix}.png`);
    reports.push(await page.evaluate(async ({ suffix, url }) => {
      const img = new Image(); img.src = url; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const g = canvas.getContext('2d')!; g.drawImage(img, 0, 0);
      const boxes = [{ label: 'title', x: 512, y: 10, width: 700, height: 23 },
        { label: 'first 14px code row', x: 64, y: 95, width: 1000, height: 22 },
        { label: 'first 16px terminal row', x: 1344, y: 95, width: 1000, height: 22 }].map((box) => {
        const p = g.getImageData(box.x, box.y, box.width, box.height).data;
        let left = box.width, right = -1;
        for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
          const i = (y * box.width + x) * 4;
          if (p[i] > 100 || p[i + 1] > 100 || p[i + 2] > 100) { left = Math.min(left, x); right = Math.max(right, x); }
        }
        return { label: box.label, inkLeft: box.x + left, inkRight: box.x + right, inkWidth: right - left + 1 };
      });
      return { suffix, width: img.width, height: img.height, boxes,
        backgroundRgb: [...g.getImageData(1100, 500, 1, 1).data].slice(0, 3) };
    }, { suffix, url: `data:image/png;base64,${bytes.toString('base64')}` }));
  }
  console.log(JSON.stringify({ observedOriginalPixels: reports,
    limitation: 'Ink extents establish raster/reference difference only; no transport/codec cause or readability threshold is inferred.' }, null, 2));
} finally { await browser.close(); }
