import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pictureBounds, type StagedFile } from '@flux/contracts';
import { person, project, workspace, type Person } from './support/people.js';
import { pool } from './support/db.js';
import { assertSamePixels } from './support/picture-pixels.js';
import { animatedGif, apng, jpeg, jpegWithBombThumbnail, png, webp } from './support/pictures.js';
// The pictures are read back with the same sharp the server uses (its own dependency, not the test workspace's).
import sharp from '../../apps/server/node_modules/sharp/dist/index.mjs';

// A picture a person uploads is decoded and written again by the server before anything stores it (#1343, C-59): every reader's browser then draws
// exactly what was checked. The hostile files are the audit's of #1270 and their variants, through the real upload route.

async function scene() {
  const owner = await person('Picture owner');
  const ws = await workspace(owner, 'Picture uploads');
  const place = await project(owner, ws.id, 'Pictures', 'restricted');
  return { owner, place };
}
async function upload(who: Person, projectId: string, bytes: Uint8Array, name: string, uploadId: string = randomUUID()) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as StagedFile & { code?: string } };
}
async function download(who: Person, id: string) {
  const response = await fetch(new URL(`/api/v1/files/${id}`, who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, text: bytes.toString('latin1') };
}
const rowsOf = async (projectId: string) => (await pool.query(`SELECT count(*)::int AS n FROM project_files WHERE project_id = $1`, [projectId])).rows[0].n as number;

test('the audit\'s pictures are refused at upload, with a plain code, and nothing is stored (#1343)', async () => {
  const f = await scene();
  const hostile: Array<[string, Uint8Array, number, string]> = [
    ['two image chunks (52 bytes that draw 16383×16383)', webp.twoChunks(), 400, 'UNREADABLE_PICTURE'],
    ['the small one first', webp.twoChunksReversed(), 400, 'UNREADABLE_PICTURE'],
    ['two lossy VP8 chunks', webp.twoLossyChunks(), 400, 'UNREADABLE_PICTURE'],
    ['a VP8X canvas of 1×1 over a 16383×16383 image', webp.stillMismatch(), 400, 'UNREADABLE_PICTURE'],
    ['an animation frame outside its canvas', webp.animatedMismatch(), 400, 'UNREADABLE_PICTURE'],
    ['an APNG frame wider than its canvas', apng(8, 8, [[8, 8, 0, 0], [16, 8, 0, 0]]), 400, 'UNREADABLE_PICTURE'],
    ['one WebP image of 268 million pixels', webp.solid(16_383, 16_383), 413, 'PICTURE_TOO_MANY_PIXELS'],
    ['a PNG header of 30,000×30,000', png(4, 4, { declared: { width: 30_000, height: 30_000 } }), 413, 'PICTURE_TOO_MANY_PIXELS'],
    ['a JPEG start-of-frame of 60,000×60,000', jpeg({ width: 60_000, height: 60_000 }), 413, 'PICTURE_TOO_MANY_PIXELS'],
  ];
  for (const [name, bytes, status, code] of hostile) {
    const refused = await upload(f.owner, f.place.id, bytes, 'bomb.png');
    assert.deepEqual([refused.status, refused.body.code], [status, code], name);
  }
  // A PNG that parses to its end but whose image data is not a zlib stream: the decoder refuses it, a header check never would.
  const garbage = Buffer.from(png(32, 32));
  const at = garbage.indexOf(Buffer.from('IDAT')) + 4;
  for (let i = 0; i < 40; i++) garbage[at + 2 + i] = (i * 37 + 11) & 0xff;
  assert.deepEqual([(await upload(f.owner, f.place.id, garbage, 'garbage.png')).body.code], ['UNREADABLE_PICTURE']);
  assert.equal(await rowsOf(f.place.id), 0, 'no row of any refused upload is left, so no quota is spent');
});

test('a PNG is stored written again: the same pixels, no text chunks or appended page; a retry of the upload finds the same file', async () => {
  const f = await scene();
  const appended = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('<html><script>alert(1)</script></html>')]);
  const key = randomUUID();
  const staged = await upload(f.owner, f.place.id, Buffer.concat([png(96, 64, { metadata: true }), appended]), 'bed.png', key);
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const stored = await download(f.owner, staged.body.id);
  assert.equal(staged.body.size, stored.bytes.length, 'the size is that of the stored picture');
  await assertSamePixels(stored.bytes, png(96, 64), 'the picture');
  for (const secret of ['Ada Nowak', 'GPS', 'tIME', 'PK\x03\x04', '<script>']) assert.ok(!stored.text.includes(secret), `${secret} is gone`);
  assert.deepEqual(pictureBounds(stored.bytes), { width: 96, height: 64 });
  const again = await upload(f.owner, f.place.id, Buffer.concat([png(96, 64, { metadata: true }), appended]), 'bed.png', key);
  assert.deepEqual(again, staged, 'the same upload again is the same file: the picture is written the same way each time');
  assert.equal((await upload(f.owner, f.place.id, png(8, 8), 'bed.png', key)).body.code, 'UPLOAD_CONFLICT');
});

test('a JPEG is stored upright with no EXIF, and a thumbnail with a size of its own in it does not matter', async () => {
  const f = await scene();
  const turned = await upload(f.owner, f.place.id, jpeg({ metadata: true, orientation: 6 }), 'held.jpg');
  assert.equal(turned.status, 201, JSON.stringify(turned.body));
  const stored = await download(f.owner, turned.body.id);
  const meta = await sharp(stored.bytes).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 8, 16], 'the camera was held a quarter turn');
  for (const secret of ['Exif', 'GPS', 'Ada Nowak', 'xmpmeta', 'Taken at home']) assert.ok(!stored.text.includes(secret), `${secret} is gone`);
  const thumbnail = await upload(f.owner, f.place.id, jpegWithBombThumbnail(), 'thumb.jpg');
  assert.equal(thumbnail.status, 201, JSON.stringify(thumbnail.body));
  assert.deepEqual(pictureBounds((await download(f.owner, thumbnail.body.id)).bytes), { width: 16, height: 8 });
});

test('animations stay animations: a GIF keeps its frames and loses its comment, an animated WebP keeps its frames', async () => {
  const f = await scene();
  const gif = await upload(f.owner, f.place.id, animatedGif(3), 'loop.gif');
  assert.equal(gif.status, 201, JSON.stringify(gif.body));
  const storedGif = await download(f.owner, gif.body.id);
  assert.equal((await sharp(storedGif.bytes, { pages: -1 }).metadata()).pages, 3);
  assert.ok(storedGif.text.includes('NETSCAPE2.0') && !storedGif.text.includes('GPS'));
  const moving = await upload(f.owner, f.place.id, webp.animated(6, 4, 3), 'moving.webp');
  assert.equal(moving.status, 201, JSON.stringify(moving.body));
  assert.equal((await sharp((await download(f.owner, moving.body.id)).bytes, { pages: -1 }).metadata()).pages, 3);
});

test('a file that is not a picture by its bytes is stored as it arrived, whatever it is called', async () => {
  const f = await scene();
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);
  const archive = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(100, 7)]);
  for (const [name, bytes] of [['drawing.png', svg], ['sound.webp', wav], ['notes.jpg', Buffer.from('just words, named like a photo')], ['bundle.zip', archive]] as const) {
    const staged = await upload(f.owner, f.place.id, bytes, name);
    assert.equal(staged.status, 201, `${name}: ${JSON.stringify(staged.body)}`);
    assert.deepEqual((await download(f.owner, staged.body.id)).bytes, bytes, `${name} is byte for byte what was sent`);
  }
});
