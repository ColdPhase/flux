import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pictureBounds } from '@flux/contracts';
import { ServiceUnavailableError, type CleanPicture } from '@flux/core';
import { sharpPictureRenderer } from '../../apps/server/src/pictures/render.js';
import { animatedGif, APPENDED, apng, jpeg, jpegWithBombThumbnail, png, webp } from './support/pictures.js';
// The test pictures are made, and read back, with the same sharp the server uses (its own dependency, not the test workspace's).
import sharp from '../../apps/server/node_modules/sharp/dist/index.mjs';

// A stored picture is decoded and written again by a real decoder (#1343, C-59): what comes out is one picture of the size libvips wrote, so what a
// browser draws is exactly what was checked. These run the API's own canonicalizer (libvips) on the audit's files and their variants; no database.

const pictures = sharpPictureRenderer();
type Kept = Extract<CleanPicture, { ok: true }>;
const canonical = async (bytes: Uint8Array) => pictures.canonical(bytes);
const kept = async (bytes: Uint8Array): Promise<Kept> => {
  const result = await canonical(bytes);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Kept;
};
const refusedAs = async (bytes: Uint8Array, reason: string, why: string) => assert.deepEqual(await canonical(bytes), { ok: false, reason }, why);
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));
const pixels = async (bytes: Uint8Array) => (await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));

/** What a decoder sees in the stored bytes agrees with what was reported, whatever the file was. */
async function agrees(result: Kept) {
  const meta = await sharp(result.bytes).metadata();
  assert.deepEqual([meta.width, meta.height], [result.width, result.height], 'libvips reads the size that was reported');
  assert.deepEqual(pictureBounds(result.bytes), { width: result.width, height: result.height }, 'and no header of the file claims another');
}

describe('canonical pictures', () => {
  test('the audit\'s files are refused: two image chunks, a canvas that is not its image\'s size, a 52-byte WebP that draws 268 million pixels', async () => {
    assert.equal(webp.twoChunks().length, 52);
    await refusedAs(webp.twoChunks(), 'broken', 'two chunks, the big one first (every browser drew 16383×16383)');
    await refusedAs(webp.twoChunksReversed(), 'broken', 'the small one first');
    await refusedAs(webp.twoLossyChunks(), 'broken', 'two lossy VP8 chunks');
    await refusedAs(webp.stillMismatch(), 'broken', 'VP8X canvas 1×1 over a 16383×16383 image');
    await refusedAs(webp.animatedMismatch(), 'broken', 'an animation frame that does not fit its canvas');
    await refusedAs(webp.solid(16_383, 16_383), 'too_many_pixels', 'one image of 268 million pixels');
    const ok = await kept(webp.solid(64, 64));
    assert.deepEqual([ok.type, ok.width, ok.height], ['image/webp', 64, 64]);
    await agrees(ok);
  });

  test('a PNG with a huge header, a JPEG whose start-of-frame says 60,000×60,000, and one over the pixel bound are refused before anything is decoded', async () => {
    await refusedAs(png(4, 4, { declared: { width: 30_000, height: 30_000 } }), 'too_many_pixels', 'PNG IHDR 30,000×30,000');
    await refusedAs(png(4, 4, { declared: { width: 4_000_000_000, height: 4_000_000_000 } }), 'too_many_pixels', 'PNG IHDR with 32-bit sides');
    await refusedAs(jpeg({ width: 60_000, height: 60_000 }), 'too_many_pixels', 'JPEG SOF 60,000×60,000');
    await refusedAs(jpeg({ width: 8_001, height: 8 }), 'too_many_pixels', 'one side over 8,000');
    await refusedAs(png(4, 4, { declared: { width: 7_000, height: 7_000 } }), 'too_many_pixels', '49 million pixels');
    const flat = await sharp({ create: { width: 6_500, height: 6_500, channels: 3, background: '#4c8c4a' } }).png().toBuffer();
    await refusedAs(flat, 'too_many_pixels', '42 million pixels, a few KB of file');
  });

  test('a JPEG whose start-of-frame says more than its data holds is one picture of the size it says; a thumbnail with a size of its own is dropped', async () => {
    const lying = await kept(jpeg({ width: 3_000, height: 2_000 }));
    assert.deepEqual([lying.width, lying.height], [3_000, 2_000], 'what a browser draws is the size the frame says, and so it is');
    await agrees(lying);
    assert.ok(lying.bytes.length < 200_000, 'the rest is filled, a few KB of file');
    const thumbnail = await kept(jpegWithBombThumbnail());
    assert.deepEqual([thumbnail.width, thumbnail.height], [16, 8]);
    await agrees(thumbnail);
  });

  test('a PNG is written again losslessly: the same pixels, no text, no time, no EXIF and nothing appended', async () => {
    const original = png(96, 64, { metadata: true });
    const result = await kept(Buffer.concat([original, APPENDED]));
    assert.deepEqual([result.type, result.width, result.height, result.frames], ['image/png', 96, 64, 1]);
    for (const secret of ['Ada Nowak', 'GPS', 'tIME', 'PK\x03\x04', '<script>']) assert.ok(!has(result.bytes, secret), `${secret} is gone`);
    const before = await pixels(png(96, 64)); const after = await pixels(result.bytes);
    assert.deepEqual(after.data, before.data, 'every pixel is the same');
    await agrees(result);
  });

  test('a JPEG is upright after its orientation is applied, and has no EXIF, comment or reserved segment left', async () => {
    const payload = Buffer.from('<html><script>alert(1)</script></html>');
    const result = await kept(jpeg({ metadata: true, orientation: 6, reserved: payload }));
    assert.deepEqual([result.type, result.width, result.height], ['image/jpeg', 8, 16], 'the 16×8 picture turned a quarter, as the camera said');
    for (const secret of ['Exif', 'GPS', 'Ada Nowak', 'xmpmeta', 'Taken at home', 'Photoshop', '<script>']) assert.ok(!has(result.bytes, secret), `${secret} is gone`);
    await agrees(result);
  });

  test('a lossless WebP stays lossless, a lossy one stays lossy, a palette PNG stays a palette; each is canonical: the same input gives the same bytes', async () => {
    const raw = Buffer.alloc(40 * 30 * 4);
    for (let i = 0; i < 40 * 30; i++) raw.set([(i * 7) % 256, (i * 3) % 256, (i * 11) % 256, i % 5 === 0 ? 0 : 255], i * 4);
    const input = { raw: { width: 40, height: 30, channels: 4 as const } };
    const lossless = await sharp(raw, input).webp({ lossless: true }).toBuffer();
    const lossy = await sharp(raw, input).webp({ quality: 70 }).toBuffer();
    const losslessResult = await kept(lossless);
    assert.ok(losslessResult.lossless && has(losslessResult.bytes, 'VP8L'));
    assert.deepEqual((await pixels(losslessResult.bytes)).data, (await pixels(lossless)).data, 'lossless pixels, alpha included, are the same');
    const lossyResult = await kept(lossy);
    assert.ok(!lossyResult.lossless && has(lossyResult.bytes, 'VP8 ') && !has(lossyResult.bytes, 'VP8L'));
    const bands = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#0a0' } }).png({ palette: true }).toBuffer();
    const palette = await kept(bands);
    assert.ok(has(palette.bytes, 'PLTE') && palette.bytes.length < bands.length * 2, 'a palette stays one, not a truecolour file many times its size');
    for (const bytes of [lossless, lossy, bands, jpeg({ orientation: 3 }), png(33, 17)])
      assert.deepEqual(Buffer.from((await kept(bytes)).bytes), Buffer.from((await kept(bytes)).bytes), 'deterministic, so a retried upload finds the same file');
  });

  test('a file that parses but does not decode is refused: a PNG with garbage for its image data, a truncated PNG', async () => {
    const whole = png(32, 32);
    const garbage = Buffer.from(whole);
    const at = garbage.indexOf(Buffer.from('IDAT')) + 4;
    for (let i = 0; i < 40; i++) garbage[at + 2 + i] = (i * 37 + 11) & 0xff;
    await refusedAs(garbage, 'broken', 'IDAT that is not a zlib stream');
    await refusedAs(whole.subarray(0, whole.length - 20), 'broken', 'no IEND');
  });

  test('animations are kept as their frames, within the bounds, when libvips reads the same canvas: a GIF, an APNG, an animated WebP', async () => {
    const gif = await kept(animatedGif(3));
    assert.deepEqual([gif.type, gif.width, gif.height, gif.frames], ['image/gif', 1, 1, 3]);
    assert.ok(!has(gif.bytes, 'GPS') && has(gif.bytes, 'NETSCAPE2.0'));
    const moving = await kept(apng(8, 8, [[8, 8, 0, 0], [4, 4, 2, 2]]));
    assert.deepEqual([moving.type, moving.width, moving.height, moving.frames], ['image/png', 8, 8, 2]);
    const wide = await kept(webp.animated(6, 4, 3));
    assert.deepEqual([wide.type, wide.width, wide.height, wide.frames], ['image/webp', 6, 4, 3]);
    await refusedAs(apng(8, 8, [[8, 8, 0, 0], [16, 8, 0, 0]]), 'broken', 'an APNG frame wider than its canvas');
  });

  test('a burst waits in one line and is refused as busy past it, as photos are', async () => {
    const small = sharpPictureRenderer({ picturesWaiting: 1 });
    const big = await sharp({ create: { width: 4_000, height: 3_000, channels: 3, background: '#4c8c4a' } }).png().toBuffer();
    const first = small.canonical(big); const second = small.canonical(big);
    await assert.rejects(small.canonical(big), (error) => error instanceof ServiceUnavailableError && /busy/i.test(error.message));
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
  });
});
