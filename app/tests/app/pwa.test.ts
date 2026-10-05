import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
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
    assert.match(html, /<meta name="theme-color" content="#FFFFFF">/);
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
    for (const url of precache) assert.equal((await get(url)).response.status, 200, `precached ${url} exists`);
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
    for (const asset of assets) {
      const plain = await raw(asset, 'identity');
      assert.equal(plain.headers['content-encoding'], undefined, asset);
      const br = await raw(asset, 'br');
      assert.equal(br.headers['content-encoding'], 'br', asset);
      assert.equal(br.headers['content-type'], plain.headers['content-type'], asset);
      assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable', asset);
      assert.deepEqual(brotliDecompressSync(br.bytes), plain.bytes, `${asset} decodes to the same bytes`);
      assert.ok(br.bytes.length < plain.bytes.length / 2, `${asset}: ${br.bytes.length} of ${plain.bytes.length} bytes`);
      const gz = await raw(asset, 'gzip');
      assert.equal(gz.headers['content-encoding'], 'gzip', asset);
      assert.deepEqual(gunzipSync(gz.bytes), plain.bytes);
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
