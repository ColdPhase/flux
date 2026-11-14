/* global process, console */
// What the first screen downloads before any route code (#850 AC-4, #862: at most 250 KB of JS and CSS, brotli). Runs with plain Node
// inside the API container, fed on stdin by scripts/check_performance.sh: it reads the built app's `index.html`, follows its script,
// modulepreload and stylesheet links, and prints the file count and the bytes raw and brotli-compressed, then what the service worker
// precaches (every first visit also downloads those), and the largest chunks. `app/tests/app/first-screen-budget.test.ts` holds the first
// screen to its budget with the same count (tests/test_first_screen_budget.py keeps the two the same).

import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'apps/web/dist');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const entry = [...new Set([...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"[^>]*>/g)].map((match) => match[1]))];
const size = (file) => {
  const data = readFileSync(join(root, file.replace(/^\//, '')));
  return { file, raw: data.byteLength, br: brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).byteLength };
};
const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const first = entry.map(size);
const firstScreen = (files) => [...files].sort((a, b) => b.br - a.br).map((item) => `${item.file.replace('/assets/', '')} ${(item.br / 1024).toFixed(1)}`).join(', ');
console.log(`First screen: ${first.length} files (${first.filter((item) => item.file.endsWith('.js')).length} JS, ${first.filter((item) => item.file.endsWith('.css')).length} CSS), ${kb(sum(first, 'raw'))} raw, ${kb(sum(first, 'br'))} brotli (target at most 250 KB brotli before content)`);

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const all = walk(root).map((path) => path.slice(root.length)).filter((file) => /\.(js|css)$/.test(file) && !file.endsWith('.map'));
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const listed = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(sw)?.[1] ?? '[]');
const cached = listed.filter((url) => /\.(js|css)$/.test(url)).map(size);
console.log(`Service worker precache: ${listed.length} files, JS and CSS ${kb(sum(cached, 'br'))} brotli of ${all.length} built (${kb(sum(all.map(size), 'br'))} in all)`);
console.log('Largest chunks (brotli): ' + all.map(size).sort((a, b) => b.br - a.br).slice(0, 6).map((item) => `${item.file.replace('/assets/', '')} ${kb(item.br)}${listed.includes(item.file) ? '' : ' (not precached)'}`).join(', '));
console.log(`First-screen files (KB brotli): ${firstScreen(first)}`);
