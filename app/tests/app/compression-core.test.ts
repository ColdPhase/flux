import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { chooseEncoding, JSON_COMPRESS_MIN_BYTES, useJsonCompression } from '../../apps/server/src/http/compress.js';

// JSON compression for the API (#266 item 9). No database or network: Fastify's inject only.
describe('choosing a response encoding', () => {
  test('prefers Brotli, falls back to gzip, honours q=0 and wildcards', () => {
    assert.equal(chooseEncoding('gzip, deflate, br'), 'br');
    assert.equal(chooseEncoding('gzip'), 'gzip');
    assert.equal(chooseEncoding('br;q=0, gzip;q=0.8'), 'gzip');
    assert.equal(chooseEncoding('identity'), null);
    assert.equal(chooseEncoding(undefined), null);
    assert.equal(chooseEncoding('*'), 'br');
    assert.equal(chooseEncoding('*;q=0, gzip'), 'gzip');
  });
});

describe('compressing JSON answers', () => {
  const big = { items: Array.from({ length: 200 }, (_, index) => ({ id: index, title: `Task number ${index} about the raised beds` })) };
  async function app() {
    const instance = Fastify();
    useJsonCompression(instance);
    instance.get('/api/v1/big', async () => big);
    instance.get('/api/v1/small', async () => ({ ok: true }));
    instance.get('/api/auth/token', async () => big);
    instance.get('/api/v1/text', async (_request, reply) => reply.type('text/plain').send('x'.repeat(JSON_COMPRESS_MIN_BYTES * 2)));
    await instance.ready();
    return instance;
  }

  test('a large JSON answer is Brotli or gzip encoded, with Vary, and decodes to the same JSON', async () => {
    const instance = await app();
    const br = await instance.inject({ url: '/api/v1/big', headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(br.statusCode, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(String(br.headers.vary), /Accept-Encoding/i);
    assert.deepEqual(JSON.parse(brotliDecompressSync(br.rawPayload).toString()), big);
    assert.ok(br.rawPayload.length < JSON.stringify(big).length / 3, `compressed ${br.rawPayload.length} bytes`);
    const gz = await instance.inject({ url: '/api/v1/big', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(gz.rawPayload).toString()), big);
    await instance.close();
  });

  test('small answers, auth answers, other types, HEAD and clients without encodings pass unchanged', async () => {
    const instance = await app();
    for (const [url, method] of [['/api/v1/small', 'GET'], ['/api/auth/token', 'GET'], ['/api/v1/text', 'GET'], ['/api/v1/big', 'HEAD']] as const) {
      const response = await instance.inject({ method, url, headers: { 'accept-encoding': 'br, gzip' } });
      assert.equal(response.headers['content-encoding'], undefined, `${method} ${url}`);
    }
    const identity = await instance.inject({ url: '/api/v1/big', headers: { 'accept-encoding': 'identity' } });
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.match(String(identity.headers.vary), /Accept-Encoding/i, 'caches still key on the encoding');
    assert.deepEqual(identity.json(), big);
    await instance.close();
  });
});
