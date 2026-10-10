import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { apiUrl } from './support/http.js';

// Installability and service worker delivery checks over HTTP (issue #41). Browser behaviour
// (registration, offline fallback, update prompt) is covered by tests/app/e2e/pwa.e2e.ts.
interface ManifestIcon { src: string; sizes: string; type: string; purpose?: string }
interface Manifest { id: string; name: string; short_name: string; start_url: string; scope: string; display: string; theme_color: string; background_color: string; icons: ManifestIcon[] }

async function get(path: string, accept = '*/*') {
  const response = await fetch(new URL(path, apiUrl), { headers: { accept } });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

function pngSize(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe('web app manifest and icons', () => {
  test('the manifest is valid JSON with installability fields, served as a manifest', async () => {
    const { response, bytes } = await get('/manifest.webmanifest');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/manifest\+json/);
    const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;
    assert.equal(manifest.name, 'Flux');
    assert.equal(manifest.short_name, 'Flux');
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.match(manifest.theme_color, /^#[0-9A-F]{6}$/i);
    assert.match(manifest.background_color, /^#[0-9A-F]{6}$/i);
    const purposes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`);
    for (const required of ['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']) assert.ok(purposes.includes(required), required);
  });

  test('every manifest icon and the Apple touch icon is a PNG of the declared size', async () => {
    const manifest = JSON.parse((await get('/manifest.webmanifest')).bytes.toString('utf8')) as Manifest;
    for (const icon of manifest.icons) {
      const { response, bytes } = await get(icon.src);
      assert.equal(response.status, 200, icon.src);
      assert.equal(response.headers.get('content-type'), 'image/png', icon.src);
      assert.equal(pngSize(bytes), icon.sizes, icon.src);
    }
    const apple = await get('/icons/apple-touch-icon.png');
    assert.equal(apple.response.status, 200);
    assert.equal(pngSize(apple.bytes), '180x180');
    assert.equal(apple.bytes[25], 2, 'Apple touch icon is opaque RGB');
  });

  test('the app page links the manifest, icons and iOS standalone metadata', async () => {
    const html = (await get('/', 'text/html')).bytes.toString('utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
    assert.match(html, /<meta name="theme-color" content="#F4F4F5">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /viewport-fit=cover/);
  });
});

describe('service worker delivery', () => {
  test('sw.js is served from the root scope, uncached, with a precache list and version', async () => {
    const { response, bytes } = await get('/sw.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^(text|application)\/javascript/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('service-worker-allowed'), '/');
    const code = bytes.toString('utf8');
    assert.match(code, /const VERSION = "[0-9a-f]{16}";/);
    const precache = JSON.parse(code.match(/const PRECACHE = (\[[^\]]*\]);/)?.[1] ?? 'null') as string[];
    assert.ok(precache.includes('/offline.html'));
    assert.ok(precache.includes('/manifest.webmanifest'));
    assert.ok(precache.some((url) => /^\/assets\/.+\.js$/.test(url)), 'the app bundle is precached');
    assert.equal(precache.some((url) => url.startsWith('/api/')), false, 'no API URL is precached');
    assert.equal(precache.includes('/index.html'), false, 'navigations are network-first, not precached');
    // Compare with the actual finished build, not the earlier bundler object: CSS-only facades
    // can be removed after a normal generateBundle hook. Every real file must still be cached.
    const directory = 'apps/web/dist';
    const actual: string[] = [];
    function walk(folder: string) {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (!/\.(?:map|br|gz)$/.test(name) && !['index.html', 'sw.js'].includes(name)) actual.push(`/${relative(directory, path)}`);
      }
    }
    walk(directory);
    assert.deepEqual(precache, actual.sort(), 'the exact final build inventory has no phantom or omitted asset');
    const hash = createHash('sha256');
    for (const url of precache) {
      const original = readFileSync(join(directory, url.slice(1)));
      const delivered = await get(url);
      assert.equal(delivered.response.status, 200, `precached ${url} exists`);
      assert.deepEqual(delivered.bytes, original, `${url} delivers its actual built bytes`);
      hash.update(url).update('\0').update(original).update('\0');
    }
    hash.update(readFileSync(join(directory, 'index.html')));
    assert.equal(code.match(/const VERSION = "([0-9a-f]{16})";/)?.[1], hash.digest('hex').slice(0, 16), 'version fingerprints actual final asset and HTML bytes');
  });

  test('hashed assets are immutable while HTML and the offline page revalidate', async () => {
    const html = (await get('/', 'text/html'));
    assert.equal(html.response.headers.get('cache-control'), 'no-cache');
    const deepLink = await get('/projects/some-project', 'text/html');
    assert.equal(deepLink.response.status, 200, 'deep links load the app');
    assert.equal(deepLink.response.headers.get('cache-control'), 'no-cache');
    const offline = await get('/offline.html');
    assert.equal(offline.response.headers.get('cache-control'), 'no-cache');
    assert.match(offline.bytes.toString('utf8'), /You are offline/);
    const script = html.bytes.toString('utf8').match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(script);
    assert.equal((await get(script)).response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
});

// Precompressed app files (#266 item 9): a phone downloads about a quarter of the bytes.
describe('compressed app files', () => {
  async function fetchEncoded(path: string, encoding: string) {
    const response = await fetch(new URL(path, apiUrl), { headers: { 'accept-encoding': encoding } });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  async function raw(path: string, encoding: string) {
    // undici decodes bodies itself; node:http shows the bytes as sent.
    const { request } = await import('node:http');
    return new Promise<{ headers: Record<string, string | string[] | undefined>; bytes: Buffer }>((resolve, reject) => {
      request(new URL(path, apiUrl), { headers: { 'accept-encoding': encoding } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ headers: res.headers, bytes: Buffer.concat(chunks) }));
      }).on('error', reject).end();
    });
  }

  test('the main script and style are sent as Brotli or gzip with their own type and cache policy', async () => {
    const html = (await get('/', 'text/html')).bytes.toString('utf8');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
    assert.ok(assets.length >= 2, `assets in index.html: ${assets.join(', ')}`);
    const entry = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^" ]+\.js)"/)?.[1];
    // Vite can link a tiny shared dependency stylesheet before the primary app stylesheet.
    // Keep the strong main-delivery guards on the largest eager stylesheet, regardless of order;
    // every linked stylesheet below still has its exact delivery/threshold/benefit checks.
    const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="(\/assets\/[^" ]+\.css)"/g)].map((match) => match[1]!);
    const style = styles.sort((a, b) => readFileSync(`apps/web/dist${b}`).length - readFileSync(`apps/web/dist${a}`).length)[0];
    assert.ok(entry && style, 'actual entry script and main stylesheet are present');
    for (const asset of assets) {
      const plain = await raw(asset, 'identity');
      assert.equal(plain.headers['content-encoding'], undefined, asset);
      assert.deepEqual(plain.bytes, readFileSync(`apps/web/dist${asset}`), `${asset} serves its actual built bytes`);
      const br = await raw(asset, 'br');
      const hasBr = existsSync(`apps/web/dist${asset}.br`);
      assert.equal(br.headers['content-encoding'], hasBr ? 'br' : undefined, asset);
      assert.equal(br.headers['content-type'], plain.headers['content-type'], asset);
      assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable', asset);
      for (const answer of [plain, br]) assert.match(String(answer.headers.vary), /accept-encoding/i, `${asset} varies by encoding`);
      assert.deepEqual(hasBr ? brotliDecompressSync(br.bytes) : br.bytes, plain.bytes, `${asset} decodes to the same bytes`);
      const gz = await raw(asset, 'gzip');
      const hasGz = existsSync(`apps/web/dist${asset}.gz`);
      assert.equal(gz.headers['content-encoding'], hasGz ? 'gzip' : undefined, asset);
      assert.deepEqual(hasGz ? gunzipSync(gz.bytes) : gz.bytes, plain.bytes);
      if (asset === entry || asset === style) {
        assert.equal(hasBr, true, `${asset}: main delivery retains Brotli`);
        assert.equal(hasGz, true, `${asset}: main delivery retains gzip`);
        assert.ok(br.bytes.length < plain.bytes.length / 2, `${asset}: ${br.bytes.length} of ${plain.bytes.length} bytes`);
      } else if (plain.bytes.length < 1024) {
        assert.equal(hasBr || hasGz, false, `${asset}: the documented small-file threshold stays intact`);
      }
      if (hasBr) assert.ok(br.bytes.length < plain.bytes.length, `${asset}: Brotli is kept only when beneficial`);
      if (hasGz) assert.ok(gz.bytes.length < plain.bytes.length, `${asset}: gzip is kept only when beneficial`);
    }
    // fetch decodes transparently, as browsers do.
    const decoded = await fetchEncoded(assets[0]!, 'br');
    assert.equal(decoded.response.status, 200);
  });

  test('a compressed service worker keeps its scope header and no-cache policy', async () => {
    const plain = await raw('/sw.js', 'identity');
    const br = await raw('/sw.js', 'br');
    assert.equal(br.headers['service-worker-allowed'], '/');
    assert.equal(br.headers['cache-control'], 'no-cache');
    assert.match(String(br.headers['content-type']), /javascript/);
    if (br.headers['content-encoding'] === 'br') assert.deepEqual(brotliDecompressSync(br.bytes), plain.bytes);
  });
});
