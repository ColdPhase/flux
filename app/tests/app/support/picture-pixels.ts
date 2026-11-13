import assert from 'node:assert/strict';
// The test pictures are read with the same sharp the server uses (its own dependency, not the test workspace's).
import sharp from '../../../apps/server/node_modules/sharp/dist/index.mjs';

/** TEST ONLY (#1343): a stored picture is decoded and written again, so it is compared with the original by what it draws, not by its bytes. */
export async function rawPixels(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
export async function assertSamePixels(actual: Uint8Array, expected: Uint8Array, message: string) {
  const [a, b] = [await rawPixels(actual), await rawPixels(expected)];
  assert.deepEqual([a.width, a.height], [b.width, b.height], `${message}: the same size`);
  assert.ok(a.data.equals(b.data), `${message}: every pixel is the same`);
}
