import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { imageTypeOf } from '@flux/contracts';
import { cleanPicture, PICTURE_LIMITS, pictureName } from '@flux/core';
import { APPENDED, GIF, gifWithComment, jpeg, png, SVG, WEBP, webpWithExif } from './support/pictures.js';

// The picture an agent attaches (#1217, AG-8, C-59) is kept only as a picture: its type by its own bytes, its size from its header before
// anything decodes it, its metadata and anything after its end dropped, and anything that does not parse refused. Pure: no network.

const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));
const kept = (bytes: Uint8Array) => {
  const result = cleanPicture(bytes);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<ReturnType<typeof cleanPicture>, { ok: true }>;
};

describe('cleanPicture', () => {
  test('a PNG keeps its pixels and loses its text, time and EXIF chunks and anything appended after its end', () => {
    const original = png(48, 32, { metadata: true });
    const result = kept(Buffer.concat([original, APPENDED]));
    assert.deepEqual([result.type, result.width, result.height], ['image/png', 48, 32]);
    for (const secret of ['Ada Nowak', 'GPS', 'tIME', 'PK\x03\x04', '<script>']) assert.ok(!has(result.bytes, secret), `${secret} is gone`);
    assert.deepEqual(Buffer.from(result.bytes), png(48, 32), 'exactly the picture without its metadata');
    assert.equal(imageTypeOf(result.bytes), 'image/png', 'what the browser checks again');
  });

  test('a private PNG chunk that hides a page (a polyglot) is dropped with the rest', () => {
    const plain = png(8, 8);
    const hidden = Buffer.from('<html><script>alert(1)</script></html>');
    const size = Buffer.alloc(4); size.writeUInt32BE(hidden.length);
    const chunk = Buffer.concat([size, Buffer.from('prVt'), hidden, Buffer.alloc(4)]);
    const at = 8 + 25; // after the signature and IHDR
    const result = kept(Buffer.concat([plain.subarray(0, at), chunk, plain.subarray(at)]));
    assert.deepEqual(Buffer.from(result.bytes), plain);
  });

  test('a JPEG keeps its frame, tables and scan and loses EXIF, XMP, IPTC and comments; the scan with stuffed bytes and restarts parses', () => {
    const result = kept(Buffer.concat([jpeg({ metadata: true }), APPENDED]));
    assert.deepEqual([result.type, result.width, result.height], ['image/jpeg', 16, 8]);
    for (const secret of ['Exif', 'GPS', 'Ada Nowak', 'xmpmeta', 'Taken at home', 'Photoshop', 'PK\x03\x04']) assert.ok(!has(result.bytes, secret), `${secret} is gone`);
    assert.deepEqual(Buffer.from(result.bytes), jpeg(), 'exactly the picture without its metadata');
  });

  test('a GIF loses its comments; a WebP loses its EXIF chunk and the flag that announced it', () => {
    const gif = kept(gifWithComment());
    assert.deepEqual([gif.type, gif.width, gif.height], ['image/gif', 1, 1]);
    assert.deepEqual(Buffer.from(gif.bytes), GIF);
    const webp = kept(Buffer.concat([webpWithExif(), APPENDED]));
    assert.deepEqual([webp.type, webp.width, webp.height], ['image/webp', 1, 1]);
    assert.ok(!has(webp.bytes, 'EXIF') && !has(webp.bytes, 'GPS'));
    assert.equal(webp.bytes[20]! & 0x08, 0, 'VP8X no longer says it has EXIF');
    assert.equal(Buffer.from(webp.bytes).readUInt32LE(4), webp.bytes.length - 8, 'the RIFF size is the new one');
    assert.deepEqual(Buffer.from(kept(WEBP).bytes), WEBP, 'a plain WebP is unchanged');
  });

  test('JPEG: an APP0 or JPGn segment carrying a page is dropped, and a second start-of-frame is refused (review of #1288)', () => {
    const plain = jpeg();
    const segment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
    const page = Buffer.from('<html><script>alert(1)</script></html>');
    const withPage = Buffer.concat([plain.subarray(0, 2), segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), page])), segment(0xf0, page), plain.subarray(2)]);
    const result = kept(withPage);
    assert.ok(!has(result.bytes, '<script>'), 'the page is gone');
    assert.deepEqual(Buffer.from(result.bytes), plain, 'the bare JFIF header of the original stays');
    const sof = segment(0xc0, Buffer.from([8, 0xfd, 0xe8, 0xfd, 0xe8, 1, 1, 0x11, 0]));
    assert.deepEqual(cleanPicture(Buffer.concat([plain.subarray(0, 2), sof, plain.subarray(2)])), { ok: false, reason: 'broken' }, 'two frames: refused');
  });

  test('GIF: frames are bounded together, and a frame larger than the screen counts its own size', () => {
    const frame = (width: number, height: number) => Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 2, 2, 0x44, 0x01, 0])]);
    const screen = GIF.subarray(0, 13 + 6); // header, a 1×1 screen and its two-colour table
    const many = Buffer.concat([screen, ...Array.from({ length: 10 }, () => frame(6_000, 6_000)), Buffer.from([0x3b])]);
    assert.deepEqual(cleanPicture(many), { ok: false, reason: 'too_many_pixels' }, '10 frames of 36 Mpx');
    const big = Buffer.concat([screen, frame(7_000, 7_000), Buffer.from([0x3b])]);
    assert.deepEqual(cleanPicture(big), { ok: false, reason: 'too_many_pixels' }, 'one 49 Mpx frame on a 1×1 screen');
  });

  test('SVG, a web page and other files are refused by their bytes, whatever they are called', () => {
    assert.deepEqual(cleanPicture(SVG), { ok: false, reason: 'svg' });
    assert.deepEqual(cleanPicture(Buffer.from('\xEF\xBB\xBF  <svg viewBox="0 0 1 1"></svg>', 'latin1')), { ok: false, reason: 'svg' });
    assert.deepEqual(cleanPicture(Buffer.from('<!doctype html><title>x</title>')), { ok: false, reason: 'not_picture' });
    assert.deepEqual(cleanPicture(Buffer.from('BM\0\0')), { ok: false, reason: 'not_picture' }, 'a BMP is not one of the four');
    assert.deepEqual(cleanPicture(new Uint8Array()), { ok: false, reason: 'not_picture' });
  });

  test('decompression bombs: a header larger than the bounds is refused before anything decodes it', () => {
    assert.deepEqual(cleanPicture(png(4, 4, { declared: { width: 20_000, height: 20_000 } })), { ok: false, reason: 'too_many_pixels' });
    assert.deepEqual(cleanPicture(png(4, 4, { declared: { width: 7_000, height: 7_000 } })), { ok: false, reason: 'too_many_pixels' }, '49 million pixels');
    assert.deepEqual(cleanPicture(png(4, 4, { declared: { width: 8_001, height: 1 } })), { ok: false, reason: 'too_many_pixels' });
    assert.deepEqual(cleanPicture(jpeg({ width: 60_000, height: 60_000 })), { ok: false, reason: 'too_many_pixels' });
    assert.equal(kept(png(4, 4, { declared: { width: 8_000, height: 5_000 } })).width, 8_000, 'the bound itself passes the header check');
  });

  test('a file over 5 MiB, a truncated one and a damaged one are refused', () => {
    assert.deepEqual(cleanPicture(Buffer.concat([png(), Buffer.alloc(PICTURE_LIMITS.bytes)])), { ok: false, reason: 'too_large' });
    const whole = png();
    assert.deepEqual(cleanPicture(whole.subarray(0, whole.length - 20)), { ok: false, reason: 'broken' }, 'no IEND');
    const noEnd = jpeg();
    assert.deepEqual(cleanPicture(noEnd.subarray(0, noEnd.length - 2)), { ok: false, reason: 'broken' }, 'no EOI');
    const lying = Buffer.from(whole); lying.writeUInt32BE(0x7ffffff0, 8 + 8 + 13 + 4); // the IDAT's length runs past the end
    assert.deepEqual(cleanPicture(lying), { ok: false, reason: 'broken' });
    assert.deepEqual(cleanPicture(GIF.subarray(0, 20)), { ok: false, reason: 'broken' });
    assert.deepEqual(cleanPicture(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xff, 0xff, 0x7f]), Buffer.from('WEBPVP8 ')])), { ok: false, reason: 'broken' });
  });

  test('every loop ends on hostile lengths: a mass of random bytes behind each signature is refused or kept quickly', () => {
    const started = Date.now();
    for (const head of [png().subarray(0, 8), Buffer.from([0xff, 0xd8, 0xff]), GIF.subarray(0, 13), WEBP.subarray(0, 12)]) {
      for (let round = 0; round < 50; round++) {
        const noise = Buffer.alloc(4096);
        for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761 + round * 97) & 0xff;
        cleanPicture(Buffer.concat([head, noise]));
      }
    }
    assert.ok(Date.now() - started < 2_000, 'bounded');
  });

  test('a picture\'s name: the caption, else the address\'s last segment, with its real type\'s extension and nothing unsafe', () => {
    assert.equal(pictureName('Raised garden bed', 'https://example.org/a/b.svg', 'image/jpeg'), 'Raised garden bed.jpg');
    assert.equal(pictureName(undefined, 'https://example.org/img/Raised%20bed.PNG?x=1', 'image/png'), 'Raised bed.png');
    assert.equal(pictureName('  ', 'https://example.org/', 'image/webp'), 'Picture.webp');
    assert.equal(pictureName('../..‮/etc\u0007', 'https://example.org/', 'image/gif'), '....etc.gif');
    assert.ok(pictureName('x'.repeat(500), 'https://example.org/', 'image/png').length <= 200);
  });
});
