import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { test } from 'node:test';
import { tarGzip } from '@flux/core';

test('large binary archives respect a paused consumer and decompress completely without collecting files', async () => {
  const bytes = randomBytes(1024 * 1024);
  let produced = 0;
  let finished = false;
  async function* files() {
    try {
      for (let i = 0; i < 12; i++) {
        produced++;
        yield { path: `files/${i}`, content: Buffer.from(bytes) };
      }
    } finally { finished = true; }
  }
  const archive = tarGzip('project', files(), new Date(0));
  await once(archive, 'readable');
  await setTimeout(30);
  assert.ok(produced < 12, `a paused consumer must stop upstream production (produced ${produced})`);
  let decompressed = 0;
  await pipeline(archive, createGunzip(), new Writable({ write(chunk: Buffer, _encoding, done) {
    decompressed += chunk.length; done();
  } }));
  assert.equal(decompressed, 12 * (512 + bytes.length) + 1024);
  assert.equal(produced, 12);
  assert.equal(finished, true);
});

test('an abandoned archive cancels the generator instead of reading the remaining files', async () => {
  const controller = new AbortController();
  const bytes = randomBytes(1024 * 1024);
  let produced = 0;
  let finished = false;
  async function* files() {
    try {
      for (let i = 0; i < 12; i++) {
        produced++;
        yield { path: `files/${i}`, content: Buffer.from(bytes) };
      }
    } finally { finished = true; }
  }
  const archive = tarGzip('project', files(), new Date(0), controller.signal);
  const consumed = pipeline(archive, new Writable({ write(_chunk, _encoding, done) {
    controller.abort(); done();
  } }));
  await assert.rejects(consumed, { name: 'AbortError' });
  await setTimeout(10);
  assert.ok(produced < 12);
  assert.equal(finished, true);
});
