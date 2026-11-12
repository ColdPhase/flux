import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import { ME_PHOTO_PATH, PEOPLE_PHOTOS_PATH, PICTURE_LIMITS, picturePath, type PeoplePhotos, type PictureSize } from '@flux/contracts';
import { addMember, grant, person, project, removeMember, workspace, type Person } from './support/people.js';
import { Browser } from './support/http.js';
import { db } from './support/db.js';
// The test images are made with the same sharp the server uses (its own dependency, not the test workspace's).
import sharp from '../../apps/server/node_modules/sharp/dist/index.mjs';

// Profile photos (F-039, #1226): types by magic bytes, size and pixel limits, the middle square, three clean WebP renditions,
// immutable URLs, removal, and who may see a photo (members, guests, and nobody after leaving).


type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const GREEN: Rgb = [0, 255, 0];

/** A picture of vertical bands: [colour, width] from left to right. */
function bands(height: number, parts: Array<[Rgb, number]>) {
  const width = parts.reduce((sum, [, w]) => sum + w, 0);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    let x = 0;
    for (const [colour, w] of parts) for (let i = 0; i < w; i++, x++) raw.set(colour, (y * width + x) * 3);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

async function upload(who: Person, bytes: Uint8Array, type = 'application/octet-stream', origin = who.browser.defaultOrigin) {
  const response = await fetch(new URL(ME_PHOTO_PATH, who.browser.base), {
    method: 'PUT', headers: { 'content-type': type, cookie: who.browser.cookieHeader(), origin }, body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json().catch(() => null) as { photo?: string; code?: string } | null };
}
async function photoOf(who: Person, bytes: Uint8Array) {
  const set = await upload(who, bytes);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  return set.body!.photo!;
}
async function rendition(who: Person | Browser, id: string, size: PictureSize) {
  const browser = who instanceof Browser ? who : who.browser;
  return fetch(new URL(picturePath(id, size), browser.base), { headers: browser.cookies.size ? { cookie: browser.cookieHeader() } : {} });
}
async function directory(who: Person) {
  const response = await who.browser.request('GET', PEOPLE_PHOTOS_PATH);
  assert.equal(response.status, 200);
  return (response.json as PeoplePhotos).photos;
}
async function pixel(bytes: Uint8Array, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at]!, data[at + 1]!, data[at + 2]!];
}
function near(actual: Rgb, expected: Rgb, message: string) {
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]!) < 40), `${message}: ${actual.join(',')} is not ${expected.join(',')}`);
}

test('a PNG photo becomes three square WebP renditions of its middle, served immutable and only as an image', async () => {
  const ada = await person('Photo Ada');
  // 300 × 100: red, green, blue thirds. The middle square is the green third.
  const id = await photoOf(ada, await bands(100, [[RED, 100], [GREEN, 100], [BLUE, 100]]).png().toBuffer());
  for (const size of [64, 128, 256] as const) {
    const response = await rendition(ada, id, size);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', size, size]);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    for (const [x, y] of [[2, 2], [size - 3, 2], [size / 2, size / 2], [2, size - 3], [size - 3, size - 3]] as const) near(await pixel(bytes, x, y), GREEN, `${size} at ${x},${y}`);
  }
  assert.deepEqual((await directory(ada))[ada.id], id);
  for (const size of ['32', '512', 'x']) assert.equal((await fetch(new URL(`/api/v1/pictures/${id}/${size}`, ada.browser.base), { headers: { cookie: ada.browser.cookieHeader() } })).status, 404);
  assert.equal((await rendition(ada, 'not-a-uuid', 64)).status, 404);
  assert.equal((await rendition(new Browser(), id, 64)).status, 401);
});

test('a JPEG keeps its orientation and loses its metadata; WebP is taken; a polyglot keeps only pixels', async () => {
  const ben = await person('Photo Ben');
  // Stored 200 × 100, left red and right blue, with EXIF orientation 6 (turn 90° clockwise): seen 100 × 200, red above blue.
  const jpeg = await bands(100, [[RED, 100], [BLUE, 100]]).jpeg({ quality: 95 })
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'flux-secret-gps-48.85N', Make: 'FluxCam' } } }).toBuffer();
  assert.ok(jpeg.includes(Buffer.from('flux-secret-gps')));
  const id = await photoOf(ben, jpeg);
  const bytes = new Uint8Array(await (await rendition(ben, id, 256)).arrayBuffer());
  assert.ok(!Buffer.from(bytes).includes(Buffer.from('flux-secret')));
  assert.ok(!Buffer.from(bytes).includes(Buffer.from('FluxCam')));
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);
  near(await pixel(bytes, 30, 30), RED, 'top left'); near(await pixel(bytes, 225, 30), RED, 'top right');
  near(await pixel(bytes, 30, 225), BLUE, 'bottom left'); near(await pixel(bytes, 225, 225), BLUE, 'bottom right');

  const webp = await photoOf(ben, await bands(80, [[BLUE, 50]]).webp().toBuffer());
  assert.notEqual(webp, id);
  near(await pixel(new Uint8Array(await (await rendition(ben, webp, 64)).arrayBuffer()), 32, 32), BLUE, 'webp');

  const polyglot = Buffer.concat([await bands(10, [[GREEN, 10]]).png().toBuffer(), Buffer.from('<html><script>alert(1)</script></html>')]);
  const clean = await photoOf(ben, polyglot);
  for (const size of [64, 128, 256] as const) assert.ok(!Buffer.from(await (await rendition(ben, clean, size)).arrayBuffer()).includes(Buffer.from('script')));
});

test('only PNG, JPEG and WebP by their bytes, whole, within 5 MiB and 40 megapixels', async () => {
  const cy = await person('Photo Cy');
  const png = await bands(10, [[GREEN, 10]]).png().toBuffer();
  const refused: Array<[string, Uint8Array, string, number, string]> = [
    ['SVG declared as PNG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), 'image/png', 400, 'UNSUPPORTED_PICTURE'],
    ['GIF', await bands(10, [[GREEN, 10]]).gif().toBuffer(), 'image/png', 400, 'UNSUPPORTED_PICTURE'],
    ['TIFF', await bands(10, [[GREEN, 10]]).tiff().toBuffer(), 'image/png', 400, 'UNSUPPORTED_PICTURE'],
    ['text', Buffer.from('hello'), 'application/octet-stream', 400, 'UNSUPPORTED_PICTURE'],
    ['PNG magic, then nothing', png.subarray(0, 8), 'image/png', 400, 'UNREADABLE_PICTURE'],
    ['truncated PNG', png.subarray(0, png.length - 20), 'image/png', 400, 'UNREADABLE_PICTURE'],
    ['JPEG magic on a PNG', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png]), 'image/jpeg', 400, 'UNREADABLE_PICTURE'],
  ];
  for (const [name, bytes, type, status, code] of refused) {
    const result = await upload(cy, bytes, type);
    assert.deepEqual([result.status, result.body?.code], [status, code], name);
  }
  // A decompression bomb: 10,000 × 10,000 px in about 300 KB. Refused from its header, before any decoding.
  const bomb = await sharp({ create: { width: 10_000, height: 10_000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < PICTURE_LIMITS.photoBytes);
  assert.deepEqual([(await upload(cy, bomb)).status, (await upload(cy, bomb)).body?.code], [413, 'PICTURE_TOO_MANY_PIXELS']);
  const tooBig = Buffer.concat([png, Buffer.alloc(PICTURE_LIMITS.photoBytes)]);
  assert.equal((await upload(cy, tooBig)).status, 413);
  assert.equal((await upload(cy, new Uint8Array(0))).status, 400);
  const json = await cy.browser.request('PUT', ME_PHOTO_PATH, { body: { photo: 'https://example.com/a.png' } });
  assert.equal(json.status, 400);
  assert.equal((await upload(cy, png, 'image/svg+xml')).status, 415);
  // A foreign page cannot set it, and neither can someone without a session.
  assert.equal((await upload(cy, png, 'image/png', 'https://evil.example')).status, 403);
  const anonymous = await fetch(new URL(ME_PHOTO_PATH, cy.browser.base), { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(anonymous.status, 401);
  // A thin strip is cropped before it is resized, so it is a cheap 1 × 1 square, not a huge one.
  assert.equal((await upload(cy, await bands(30_000, [[RED, 1]]).png().toBuffer())).status, 200);
  assert.deepEqual(await directory(cy), { [cy.id]: (await directory(cy))[cy.id] });
});

test('a new photo and Remove free the old renditions; removal goes back to the initials', async () => {
  const dee = await person('Photo Dee');
  const first = await photoOf(dee, await bands(20, [[RED, 20]]).png().toBuffer());
  const [row] = await db.select().from(schema.personPhotos).where(inArray(schema.personPhotos.id, [first]));
  const objects = [row!.object64, row!.object128, row!.object256];
  const second = await photoOf(dee, await bands(20, [[BLUE, 20]]).png().toBuffer());
  assert.notEqual(second, first);
  assert.equal((await rendition(dee, first, 64)).status, 404);
  assert.equal((await rendition(dee, second, 64)).status, 200);
  // The old renditions are queued for the files sweep (which runs every ten minutes, never at start) and no row names them.
  assert.equal((await db.select().from(schema.fileGarbage).where(inArray(schema.fileGarbage.id, objects))).length, 3);
  assert.equal((await db.select().from(schema.personPhotos).where(inArray(schema.personPhotos.id, [first]))).length, 0);
  assert.deepEqual(await directory(dee), { [dee.id]: second });

  const removed = await dee.browser.request('DELETE', ME_PHOTO_PATH);
  assert.equal(removed.status, 204);
  assert.equal((await rendition(dee, second, 128)).status, 404);
  assert.deepEqual(await directory(dee), {});
  assert.equal((await dee.browser.request('DELETE', ME_PHOTO_PATH)).status, 204);
});

test('who sees a photo: people of the same company, a guest only those of their spaces, nobody after leaving', async () => {
  const owner = await person('Photo Owner');
  const member = await person('Photo Member');
  const guest = await person('Photo Guest');
  const roommate = await person('Photo Roommate');
  const outsider = await person('Photo Outsider');
  const ws = await workspace(owner, 'Photo company');
  await addMember(owner, ws.id, member, 'member');
  await addMember(owner, ws.id, roommate, 'member');
  await addMember(owner, ws.id, guest, 'guest');
  const room = await project(owner, ws.id, 'Photo room', 'restricted');
  await grant(owner, room.id, guest, 'contributor');
  await grant(owner, room.id, roommate, 'contributor');
  await workspace(outsider, 'Elsewhere');
  const photos = new Map<Person, string>();
  for (const someone of [owner, member, guest, roommate, outsider]) photos.set(someone, await photoOf(someone, await bands(16, [[GREEN, 16]]).png().toBuffer()));
  const sees = async (viewer: Person, subject: Person) => {
    const listed = (await directory(viewer))[subject.id] === photos.get(subject);
    const served = (await rendition(viewer, photos.get(subject)!, 64)).status === 200;
    assert.equal(listed, served, 'the list and the picture route agree');
    return served;
  };
  for (const subject of [owner, guest, roommate]) assert.equal(await sees(member, subject), true);
  assert.equal(await sees(member, outsider), false);
  assert.equal(await sees(outsider, member), false);
  // The guest sees the people of their space (the owner made it, the roommate is in it) and not the rest of the company.
  assert.equal(await sees(guest, roommate), true);
  assert.equal(await sees(guest, owner), true);
  assert.equal(await sees(guest, member), false);
  assert.equal(await sees(guest, guest), true);

  // The member leaves the company: their photo goes with them, and they see nobody's.
  await removeMember(owner, ws.id, member);
  assert.equal(await sees(owner, member), false);
  assert.equal(await sees(roommate, member), false);
  assert.equal(await sees(member, owner), false);
  assert.deepEqual(Object.keys(await directory(member)), [member.id]);
});
