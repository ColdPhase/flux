import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isVideoName, videoContainerOf, videoNameContainer } from '@flux/contracts';
import { fileDetailOf, parseRange } from '@flux/core';
import { SVG } from './support/pictures.js';

// C-61 (#1352): which bytes are a video container, and which byte ranges a request means. Pure; no server.
const clip = (name: string) => readFileSync(join(import.meta.dirname, '../ui/fixtures/video', name));
const ftyp = (brand: string, size = 24) => Buffer.concat([Buffer.from([0, 0, 0, size]), Buffer.from('ftyp'), Buffer.from(brand, 'latin1'), Buffer.alloc(size - 12)]);

test('the first bytes decide the container, never the name', () => {
  assert.equal(videoContainerOf(clip('clip.mp4')), 'mp4');
  assert.equal(videoContainerOf(clip('clip.mov')), 'mov');
  assert.equal(videoContainerOf(clip('clip.webm')), 'webm');
  assert.equal(videoContainerOf(ftyp('isom')), 'mp4');
  assert.equal(videoContainerOf(ftyp('M4V ')), 'mp4');
  assert.equal(videoContainerOf(ftyp('qt  ')), 'mov');
  // A picture or a sound in the same box layout is not a video.
  for (const brand of ['heic', 'avif', 'mif1', 'M4A ', 'avis']) assert.equal(videoContainerOf(ftyp(brand)), null, brand);
  // Matroska has the same EBML start as WebM and is not one; a name is not a signature.
  const matroska = Buffer.from(clip('clip.webm')); matroska.write('matroska', matroska.indexOf('webm'), 'latin1');
  assert.equal(videoContainerOf(matroska.subarray(0, 40)), null);
  for (const hostile of [SVG, Buffer.from('<!doctype html><script>alert(1)</script>'), Buffer.from('PK\x03\x04 hello'), Buffer.alloc(64), Buffer.from('GIF89a'), Buffer.alloc(0)])
    assert.equal(videoContainerOf(hostile), null);
  // An ftyp box that claims to be huge or tiny is no ftyp.
  assert.equal(videoContainerOf(Buffer.concat([Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('ftypisom'), Buffer.alloc(8)])), null);
  assert.equal(videoContainerOf(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('ftypisom')])), null);
  // A truncated EBML header does not read past its end.
  for (let cut = 0; cut < 40; cut++) assert.doesNotThrow(() => videoContainerOf(clip('clip.webm').subarray(0, cut)));
});

test('names propose, extensions are case-insensitive, and only the three containers are videos', () => {
  assert.equal(videoNameContainer('Holiday.MP4'), 'mp4');
  assert.equal(videoNameContainer('clip.m4v'), 'mp4');
  assert.equal(videoNameContainer('clip.MOV'), 'mov');
  assert.equal(videoNameContainer('clip.webm'), 'webm');
  for (const name of ['clip.mkv', 'clip.avi', 'clip.wmv', 'clip.flv', 'clip.mp3', '.mp4', 'mp4', 'clip.mp4.txt']) assert.equal(isVideoName(name), false, name);
});

test('a video says its playing time when the first bytes hold it', () => {
  for (const name of ['clip.mp4', 'clip.mov', 'clip.webm']) {
    const { durationMs } = fileDetailOf(name, clip(name).subarray(0, 64 * 1024));
    assert.ok(durationMs !== undefined && durationMs >= 1900 && durationMs <= 2200, `${name}: ${durationMs}`);
  }
  // A moov box that does not fit in the head gives no duration rather than a wrong one.
  assert.deepEqual(fileDetailOf('clip.mp4', clip('clip.mp4').subarray(0, 1000)), {});
});

test('one byte range, clamped; an impossible one is 416; anything odd is the whole file', () => {
  const size = 1000;
  assert.deepEqual(parseRange('bytes=0-99', size), { kind: 'partial', start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', size), { kind: 'partial', start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', size), { kind: 'partial', start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', size), { kind: 'partial', start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', size), { kind: 'partial', start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=999-999', size), { kind: 'partial', start: 999, end: 999 });
  assert.deepEqual(parseRange('bytes=1000-', size), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=5000-6000', size), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-0', size), { kind: 'unsatisfiable' });
  for (const header of [undefined, '', 'bytes=', 'bytes=-', 'bytes=0-1,5-9', 'bytes=5-1', 'items=0-5', 'bytes=a-b', 'bytes=0-99 ', 'bytes=0--5', 'bytes=99999999999999999-1'])
    assert.deepEqual(parseRange(header, size), header === 'bytes=0-99 ' ? { kind: 'partial', start: 0, end: 99 } : { kind: 'full' }, String(header));
  assert.deepEqual(parseRange('bytes=0-1', 0), { kind: 'full' });
});
