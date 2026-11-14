import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

// The first screen's budget (#850 AC-4, #862, #1428): the JS and CSS that a first visit downloads before any route code, at most 250 KB
// brotli-compressed. It counts exactly what `scripts/perf-bundle.mjs` counts (the files the built `index.html` loads: its scripts,
// modulepreloads and stylesheets, each brotli-compressed at quality 5), which is what the v0.2.0 against main comparison measured, so a
// number here is the number that script reports (`tests/test_first_screen_budget.py` keeps the two in step). It grew from 242 to 269 KB
// in nine days of features that each went into the entry chunk; the picker, the Create window, the notice card and the sign-out wiring now
// load with the code that needs them, and this holds them there. Over budget? Load the new code lazily (`app/DeferredSurfaces.tsx`, a
// route's `lazy`) instead of raising the number.
const BUDGET_KB = 250;
const root = join(process.cwd(), 'apps/web/dist');
const entryLink = /<(?:script|link)\b[^>]*?(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"[^>]*>/g;

function firstScreen() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const files = [...new Set([...html.matchAll(entryLink)].map((match) => match[1]!))];
  return files.map((file) => {
    const bytes = readFileSync(join(root, file.replace(/^\//, '')));
    return { file, raw: bytes.byteLength, br: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).byteLength };
  });
}

describe('the first screen stays within its budget', () => {
  test('a first visit downloads at most 250 KB of JS and CSS (brotli), the files perf-bundle.mjs counts', () => {
    assert.ok(existsSync(join(root, 'index.html')), 'the web app is built (apps/web/dist)');
    const files = firstScreen();
    assert.ok(files.some((item) => item.file.endsWith('.js')) && files.some((item) => item.file.endsWith('.css')), 'index.html names the app\'s scripts and styles');
    const total = files.reduce((sum, item) => sum + item.br, 0);
    const largest = [...files].sort((a, b) => b.br - a.br).slice(0, 6).map((item) => `${item.file.replace('/assets/', '')} ${(item.br / 1024).toFixed(1)}`).join(', ');
    console.log(`first screen: ${files.length} files, ${(total / 1024).toFixed(1)} KB brotli of ${BUDGET_KB} (largest: ${largest})`);
    assert.ok(total <= BUDGET_KB * 1024, `the first screen is ${(total / 1024).toFixed(1)} KB brotli, over its ${BUDGET_KB} KB budget; the largest files: ${largest}`);
  });

  test('what only a later action needs is not among the first screen\'s files', () => {
    // Each of these has its own chunk (they are imported with `import()`); one that turns up in index.html has been imported statically again.
    const names = firstScreen().map((item) => item.file);
    const built = readdirSync(join(root, 'assets'));
    for (const lazy of ['CreateWindow', 'Notices', 'SettingsHome', 'Details', 'JumpTo', 'ProjectTasks', 'WikiEditor', 'LiveStage']) {
      assert.equal(names.some((file) => new RegExp(`/assets/${lazy}-[^/]+\\.(?:js|css)$`).test(file)), false, `${lazy} is not part of the first screen`);
      assert.ok(built.some((file) => new RegExp(`^${lazy}-[^/]+\\.js$`).test(file)), `${lazy} is built as a chunk of its own`);
    }
  });
});
