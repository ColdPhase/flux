import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { FILE_LIMITS, FILE_LIMITS_PATH, filePosterPath, fileVideoPath, imageTypeOf, type Conversation, type FileLimits, type StagedFile } from '@flux/contracts';
import { createSealed, passphrase } from './support/encryption.js';
import { db } from './support/db.js';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';
import { png, SVG } from './support/pictures.js';

// Videos play inside Flux (C-61, #1352): what the server stores as a video, what it streams and to whom, the limits, the poster, and what
// an encrypted space does with one. The test stack gives the API FLUX_VIDEO_MAX_MIB=12 (docker/compose.test.yaml), read here from the API.

const MiB = 1024 * 1024;
const clip = (name: string) => readFileSync(join(import.meta.dirname, '../ui/fixtures/video', name));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Staged = StagedFile & { code?: string; error?: string };

/** The fixture's container with `extra` bytes of padding after it: a stand-in for a long video that the tests can range over. */
function longClip(extra: number, name = 'clip.mp4') {
  const bytes = Buffer.alloc(clip(name).length + extra);
  clip(name).copy(bytes);
  for (let i = clip(name).length; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}
async function scene() {
  const owner = await person('Video owner');
  const sender = await person('Video sender');
  const reader = await person('Video reader');
  const outsider = await person('Video outsider');
  const ws = await workspace(owner, 'Videos');
  for (const other of [sender, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Private video conversation', 'restricted');
  await grant(owner, place.id, sender, 'contributor');
  await grant(owner, place.id, reader, 'contributor');
  return { owner, sender, reader, outsider, ws, place };
}
const headers = (who: Person, extra: Record<string, string> = {}) => ({ cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin, ...extra });
async function upload(who: Person, projectId: string, bytes: Uint8Array, name: string, uploadId = randomUUID()) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as Staged };
}
const get = (who: Person, path: string, extra: Record<string, string> = {}, method = 'GET') =>
  fetch(new URL(path, who.browser.base), { method, headers: headers(who, extra) });
async function poster(who: Person, projectId: string, fileId: string, bytes: Uint8Array) {
  const response = await fetch(new URL(filePosterPath(projectId, fileId), who.browser.base), {
    method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as Staged };
}
/** A raw upload with exactly these headers and no body: the declared length alone must be enough to refuse it. */
async function declared(who: Person, projectId: string, name: string, length: number) {
  const base = new URL(who.browser.base);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(base.port || 80), base.hostname, () => {
      socket.write(`POST /api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)} HTTP/1.1\r\nHost: ${base.host}\r\n`
        + `Content-Type: application/octet-stream\r\nContent-Length: ${length}\r\nCookie: ${who.browser.cookieHeader()}\r\nOrigin: ${who.browser.defaultOrigin}\r\nConnection: close\r\n\r\n`);
    });
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  return { status: Number(raw.slice(9, 12)), body: JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)) as { code: string; error: string } };
}
const send = async (who: Person, projectId: string, fileIds: string[]) => expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
  { body: { body: '', attachmentIds: fileIds, clientMessageId: randomUUID() } }), 201) as Conversation;

/** The operator's video cap, as the API says it. */
async function cap() {
  const who = await person('Limits reader');
  return (expectStatus(await who.browser.request('GET', FILE_LIMITS_PATH), 200) as FileLimits).videoBytes;
}
/** An upload with no declared length (chunked), so only the count can stop it: `total` bytes of a video's container and zeros. */
async function chunked(who: Person, projectId: string, name: string, total: number) {
  const head = clip('clip.mp4');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(head));
    for (let sent = head.length; sent < total; sent += MiB) controller.enqueue(new Uint8Array(Math.min(MiB, total - sent)));
    controller.close();
  } });
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { status: response.status, body: await response.json() as Staged };
}
/** The width and height of a WebP picture, from its header. */
function webpSize(bytes: Buffer): [number, number] {
  const kind = bytes.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const bits = bytes.readUInt32LE(21); return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]; }
  assert.equal(kind, 'VP8X');
  return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
}

test('the limits say what this instance accepts, to a signed-in person only', async () => {
  const who = await person('Limits');
  const body = expectStatus(await who.browser.request('GET', FILE_LIMITS_PATH), 200) as FileLimits;
  assert.equal(body.fileBytes, FILE_LIMITS.fileBytes);
  assert.equal(body.messageBytes, FILE_LIMITS.messageBytes);
  assert.equal(body.messageFiles, FILE_LIMITS.messageFiles);
  assert.equal(body.videoBytes, 12 * MiB, 'the test stack sets FLUX_VIDEO_MAX_MIB=12');
  assert.equal((await fetch(new URL(FILE_LIMITS_PATH, who.browser.base))).status, 401);
});

test('an MP4, a WebM and a MOV are stored as videos by their bytes, with their playing time', async () => {
  const f = await scene();
  for (const [name, container, type] of [['clip.mp4', 'mp4', 'video/mp4'], ['clip.webm', 'webm', 'video/webm'], ['clip.mov', 'mov', 'video/quicktime']] as const) {
    const staged = await upload(f.sender, f.place.id, clip(name), `Holiday ${name}`);
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    assert.equal(staged.body.video, container);
    assert.ok(staged.body.durationMs! >= 1900 && staged.body.durationMs! <= 2200, `${name} plays for ${staged.body.durationMs} ms`);
    assert.equal(staged.body.sha256, digest(clip(name)));
    const played = await get(f.sender, fileVideoPath(staged.body.id));
    assert.equal(played.status, 200);
    assert.equal(played.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await played.arrayBuffer()), clip(name));
  }
  // The name proposes; the bytes decide: a WebM named .mp4 is a WebM.
  const renamed = await upload(f.sender, f.place.id, clip('clip.webm'), 'renamed.mp4');
  assert.equal(renamed.body.video, 'webm');
  assert.equal((await get(f.sender, fileVideoPath(renamed.body.id))).headers.get('content-type'), 'video/webm');
});

test('a file named like a video that is not one is refused, and leaves nothing behind', async () => {
  const f = await scene();
  const attempts: Array<[string, Uint8Array]> = [['page.mp4', Buffer.from('<!doctype html><script>alert(document.cookie)</script>')], ['image.webm', SVG],
    ['photo.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)])], ['archive.mov', Buffer.from('PK\x03\x04 not a movie')],
    ['clip.mp4', Buffer.alloc(6 * MiB)]];
  for (const [name, bytes] of attempts) {
    const id = randomUUID();
    const refused = await upload(f.sender, f.place.id, bytes, name, id);
    assert.equal(refused.status, 400, name);
    assert.equal(refused.body.code, 'NOT_A_VIDEO', name);
    const rows = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.uploadId, id));
    assert.deepEqual(rows, [], `${name} left no row`);
  }
  // Matroska has a WebM's start and is not one.
  const matroska = Buffer.from(clip('clip.webm'));
  matroska.write('matroska', matroska.indexOf('webm'), 'latin1');
  assert.equal((await upload(f.sender, f.place.id, matroska, 'movie.webm')).body.code, 'NOT_A_VIDEO');
  // Other video formats are ordinary files at the ordinary limit.
  const mkv = await upload(f.sender, f.place.id, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]), 'movie.mkv');
  assert.equal(mkv.status, 201);
  assert.equal(mkv.body.video, undefined);
  assert.equal((await upload(f.sender, f.place.id, Buffer.alloc(FILE_LIMITS.fileBytes + 1, 1), 'movie.mkv')).body.code, 'FILE_TOO_LARGE');
  assert.equal((await get(f.sender, fileVideoPath(mkv.body.id))).status, 404, 'a file that is not a video has no video route');
});

test('a video may be larger than a file, up to the operator\'s cap, and no more', async () => {
  const f = await scene();
  const most = await cap();
  assert.equal(most, 12 * MiB);
  const big = longClip(FILE_LIMITS.fileBytes + MiB);
  const staged = await upload(f.sender, f.place.id, big, 'long.mp4');
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.size, big.length);
  assert.equal(staged.body.sha256, digest(big));
  // Over the cap is refused from the declared length, before a byte is read, and says so in the video's words.
  const over = await declared(f.sender, f.place.id, 'huge.mp4', most + 1);
  assert.deepEqual([over.status, over.body.code], [413, 'FILE_TOO_LARGE']);
  assert.match(over.body.error, /A video is at most 12 MiB/);
  // The same size for another file keeps the 5 MiB.
  const file = await declared(f.sender, f.place.id, 'huge.bin', most);
  assert.deepEqual([file.status, file.body.code], [413, 'FILE_TOO_LARGE']);
  assert.match(file.body.error, /A file is at most 5 MiB/);
  // A video that streams past the cap with no declared length is stopped by the count, and leaves nothing.
  const streaming = await scene();
  const endless = await chunked(streaming.sender, streaming.place.id, 'endless.mp4', most + 1);
  assert.deepEqual([endless.status, endless.body.code], [413, 'FILE_TOO_LARGE']);
  assert.equal((await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.projectId, streaming.place.id))).length, 0);
  assert.equal((await chunked(streaming.sender, streaming.place.id, 'exact.mp4', most)).status, 201);
  // The waiting videos of one person in one space stay within one cap together: 7 MiB is staged, another 7 MiB does not fit, 4 MiB does.
  const seven = longClip(7 * MiB - clip('clip.mp4').length);
  const other = await scene();
  assert.equal((await upload(other.sender, other.place.id, seven, 'one.mp4')).status, 201);
  const second = await upload(other.sender, other.place.id, seven, 'two.mp4');
  assert.deepEqual([second.status, second.body.code], [409, 'UPLOAD_QUOTA_EXCEEDED']);
  assert.equal((await upload(other.sender, other.place.id, longClip(4 * MiB - clip('clip.mp4').length), 'three.mp4')).status, 201);
  // The ordinary files' allowance is its own: a video does not use it.
  assert.equal((await upload(other.sender, other.place.id, Buffer.alloc(FILE_LIMITS.fileBytes, 3), 'plain.bin')).status, 201);
});

/** An admitted video upload whose body never comes: it holds its connection until the socket is closed. */
async function stalled(who: Person, projectId: string, name: string) {
  const base = new URL(who.browser.base);
  const uploadId = randomUUID();
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = connect(Number(base.port || 80), base.hostname, () => {
      opened.write(`POST /api/v1/projects/${projectId}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)} HTTP/1.1\r\nHost: ${base.host}\r\n`
        + `Content-Type: application/octet-stream\r\nContent-Length: ${MiB}\r\nCookie: ${who.browser.cookieHeader()}\r\nOrigin: ${who.browser.defaultOrigin}\r\n\r\n`);
      resolve(opened);
    });
    opened.on('error', reject);
  });
  for (let i = 0; i < 100; i++) {
    if ((await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.uploadId, uploadId))).length) return socket;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  socket.destroy();
  throw new Error('the stalled upload was never admitted');
}

test('one person has at most three videos arriving at once, so slow uploads cannot hold the server', async () => {
  const f = await scene();
  const held = [await stalled(f.sender, f.place.id, 'a.mp4'), await stalled(f.sender, f.place.id, 'b.mp4'), await stalled(f.sender, f.place.id, 'c.mov')];
  try {
    const busy = await upload(f.sender, f.place.id, clip('clip.mp4'), 'd.mp4');
    assert.deepEqual([busy.status, busy.body.code], [429, 'UPLOADS_BUSY']);
    // Somebody else's video, and the person's other files, are not held up.
    assert.equal((await upload(f.reader, f.place.id, clip('clip.mp4'), 'other.mp4')).status, 201);
    assert.equal((await upload(f.sender, f.place.id, Buffer.from('notes'), 'notes.txt')).status, 201);
  } finally { for (const socket of held) socket.destroy(); }
  // A cut upload leaves nothing waiting, and gives its place back.
  for (let i = 0; i < 100 && (await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.state, 'receiving'))
    .then((rows) => rows.some((row) => row.projectId === f.place.id))); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const receiving = (await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.projectId, f.place.id))).filter((row) => row.state === 'receiving');
  assert.deepEqual(receiving, []);
  assert.equal((await upload(f.sender, f.place.id, clip('clip.mp4'), 'd.mp4')).status, 201);
});

test('ranges answer 206 with the exact Content-Range, from disk; odd ranges get the whole file; 416 past the end', async () => {
  const f = await scene();
  const bytes = longClip(6 * MiB);
  const staged = (await upload(f.sender, f.place.id, bytes, 'seek.mp4')).body;
  const size = bytes.length;
  const path = fileVideoPath(staged.id);
  const first = await get(f.sender, path, { range: 'bytes=0-99' });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal(first.headers.get('content-length'), '100');
  assert.equal(first.headers.get('accept-ranges'), 'bytes');
  assert.equal(first.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes.subarray(0, 100));
  const middle = await get(f.sender, path, { range: 'bytes=5000000-5000099' });
  assert.equal(middle.status, 206);
  assert.equal(middle.headers.get('content-range'), `bytes 5000000-5000099/${size}`);
  assert.deepEqual(Buffer.from(await middle.arrayBuffer()), bytes.subarray(5_000_000, 5_000_100));
  const tail = await get(f.sender, path, { range: `bytes=${size - 50}-` });
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 50}-${size - 1}/${size}`);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(size - 50));
  const suffix = await get(f.sender, path, { range: 'bytes=-10' });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(size - 10));
  const clamped = await get(f.sender, path, { range: `bytes=${size - 3}-${size + 1000}` });
  assert.equal(clamped.headers.get('content-range'), `bytes ${size - 3}-${size - 1}/${size}`);
  await clamped.arrayBuffer();
  const past = await get(f.sender, path, { range: `bytes=${size}-` });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${size}`);
  await past.arrayBuffer();
  // Several ranges, an unknown unit, a bad range and a validator Flux never sent all get the whole file, which the standard allows.
  for (const range of ['bytes=0-1,5-9', 'items=0-5', 'bytes=9-1', 'bytes=x-y']) {
    const whole = await get(f.sender, path, { range });
    assert.equal(whole.status, 200, range);
    assert.equal(whole.headers.get('content-length'), String(size));
    await whole.arrayBuffer();
  }
  const validated = await get(f.sender, path, { range: 'bytes=0-9', 'if-range': '"anything"' });
  assert.equal(validated.status, 200);
  await validated.arrayBuffer();
  // A HEAD says what a GET would, without a body; the download route ranges too, as the file it is.
  const head = await get(f.sender, path, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(size));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const resumed = await get(f.sender, `/api/v1/files/${staged.id}`, { range: 'bytes=100-199' });
  assert.equal(resumed.status, 206);
  assert.equal(resumed.headers.get('content-type'), 'application/octet-stream');
  assert.equal(resumed.headers.get('content-range'), `bytes 100-199/${size}`);
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes.subarray(100, 200));
  // A download of the whole video streams it back byte for byte, though it is larger than a file may be.
  const whole = await get(f.sender, `/api/v1/files/${staged.id}`);
  assert.equal(whole.status, 200);
  assert.equal(digest(Buffer.from(await whole.arrayBuffer())), digest(bytes));
});

test('a video is served as an attachment under nosniff and sandbox, never as a page', async () => {
  const f = await scene();
  const staged = (await upload(f.sender, f.place.id, clip('clip.mp4'), 'safe.mp4')).body;
  const response = await get(f.sender, fileVideoPath(staged.id));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition')!, /^attachment;.*filename\*=UTF-8''safe\.mp4$/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  await response.arrayBuffer();
});

test('access is checked on every request: only the sender before it is sent, the space after, and nobody once they lose it', async () => {
  const f = await scene();
  const bytes = longClip(2 * MiB);
  const staged = (await upload(f.sender, f.place.id, bytes, 'access.mp4')).body;
  for (const other of [f.owner, f.reader, f.outsider]) assert.equal((await get(other, fileVideoPath(staged.id), { range: 'bytes=0-9' })).status, 404, 'unsent');
  assert.equal((await fetch(new URL(fileVideoPath(staged.id), f.sender.browser.base), { headers: { range: 'bytes=0-9' } })).status, 401, 'signed out');
  await send(f.sender, f.place.id, [staged.id]);
  assert.equal((await get(f.reader, fileVideoPath(staged.id), { range: 'bytes=0-9' })).status, 206);
  assert.equal((await get(f.owner, fileVideoPath(staged.id), { range: 'bytes=0-9' })).status, 206);
  assert.equal((await get(f.outsider, fileVideoPath(staged.id), { range: 'bytes=0-9' })).status, 404, 'not in the space');
  // The next range of a player that was in the middle of the file finds the door closed.
  assert.equal((await get(f.reader, fileVideoPath(staged.id), { range: 'bytes=1000000-1000099' })).status, 206);
  await removeFromSpace(f.owner, f.place.id, f.reader);
  for (const range of ['bytes=1000100-1000199', 'bytes=0-9', undefined]) {
    const lost = await get(f.reader, fileVideoPath(staged.id), range ? { range } : {});
    assert.equal(lost.status, 404, String(range));
    assert.equal(((await lost.json()) as { code: string }).code, 'FILE_UNAVAILABLE');
  }
  assert.equal((await get(f.reader, `/api/v1/files/${staged.id}`, { range: 'bytes=0-9' })).status, 404);
  assert.equal((await get(f.reader, fileVideoPath(staged.id), {}, 'HEAD')).status, 404);
});

test('a video travels with a message: its own cap, its poster and the 20 MiB of the rest', async () => {
  const f = await scene();
  const video = (await upload(f.sender, f.place.id, longClip(7 * MiB), 'seven.mp4')).body;
  // Twenty MiB of ordinary files go with it: the video is not counted in them.
  const files: StagedFile[] = [];
  for (let i = 0; i < 4; i++) files.push((await upload(f.sender, f.place.id, Buffer.alloc(FILE_LIMITS.fileBytes, i + 1), `part-${i}.bin`)).body);
  const started = await send(f.sender, f.place.id, [video.id, ...files.map((file) => file.id)]);
  assert.deepEqual(started.messages[0]!.files!.map((file) => file.id), [video.id, ...files.map((file) => file.id)]);
  assert.equal(started.messages[0]!.files![0]!.video, 'mp4');
  const read = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${started.id}`), 200) as Conversation;
  assert.equal(read.messages[0]!.files![0]!.video, 'mp4');
  assert.equal(read.messages[0]!.files![0]!.name, 'seven.mp4');
  // More than 20 MiB of ordinary files is still refused, video or not.
  const crowd: string[] = [];
  for (let i = 0; i < 5; i++) crowd.push((await upload(f.sender, f.place.id, Buffer.alloc(FILE_LIMITS.fileBytes, i + 9), `crowd-${i}.bin`)).body.id);
  const refused = await f.sender.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: '', attachmentIds: crowd, clientMessageId: randomUUID() } });
  assert.equal(refused.status, 400);
});

test('a poster is decoded and re-encoded small, belongs to its video, and goes with it to the message', async () => {
  const f = await scene();
  const video = (await upload(f.sender, f.place.id, clip('clip.mp4'), 'poster.mp4')).body;
  const drawn = png(1600, 900, { metadata: true });
  const first = await poster(f.sender, f.place.id, video.id, drawn);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.name, 'poster.webp');
  const stored = Buffer.from(await (await get(f.sender, `/api/v1/files/${first.body.id}`)).arrayBuffer());
  assert.equal(imageTypeOf(stored), 'image/webp', 'a poster is kept as a WebP, never as sent');
  assert.ok(stored.length <= FILE_LIMITS.posterBytes, `${stored.length} bytes`);
  assert.equal(stored.includes(Buffer.from('Kraków')), false);
  assert.equal(stored.includes(Buffer.from('GPS')), false);
  assert.deepEqual(webpSize(stored), [640, 360], '1600 x 900 fits 640 px on its longest side');
  // Nobody else may give it a poster, or see the staged one.
  assert.equal((await poster(f.reader, f.place.id, video.id, png())).status, 404);
  assert.equal((await get(f.reader, `/api/v1/files/${first.body.id}`)).status, 404);
  // A second poster replaces the first.
  const second = await poster(f.sender, f.place.id, video.id, png(320, 180));
  assert.equal(second.status, 201);
  assert.equal((await get(f.sender, `/api/v1/files/${first.body.id}`)).status, 404, 'the replaced poster is gone');
  // A poster cannot be sent as a file of its own: it goes with its video.
  const alone = await f.sender.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { body: '', attachmentIds: [second.body.id], clientMessageId: randomUUID() } });
  assert.equal(alone.status, 404, alone.text);
  // It is not a file of the message: the video carries its id, and a reader reads it.
  const started = await send(f.sender, f.place.id, [video.id]);
  assert.deepEqual(started.messages[0]!.files!.map((file) => file.id), [video.id]);
  assert.equal(started.messages[0]!.files![0]!.poster, second.body.id);
  const read = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${started.id}`), 200) as Conversation;
  assert.equal(read.messages[0]!.files![0]!.poster, second.body.id);
  const seen = await get(f.reader, `/api/v1/files/${second.body.id}`);
  assert.equal(seen.status, 200);
  assert.equal(imageTypeOf(Buffer.from(await seen.arrayBuffer())), 'image/webp');
  assert.equal((await get(f.outsider, `/api/v1/files/${second.body.id}`)).status, 404);
  // Once sent, a video takes no new poster.
  assert.equal((await poster(f.sender, f.place.id, video.id, png())).status, 404);
  // Removing the message removes the poster with it.
  const removed = await f.sender.browser.request('DELETE', `/api/v1/conversations/${started.id}/messages/${started.messages[0]!.id}`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await get(f.reader, `/api/v1/files/${second.body.id}`)).status, 404);
});

test('a poster must be a small picture of the sender\'s own staged video, and nothing else', async () => {
  const f = await scene();
  const video = (await upload(f.sender, f.place.id, clip('clip.mp4'), 'checked.mp4')).body;
  const text = (await upload(f.sender, f.place.id, Buffer.from('plain'), 'note.txt')).body;
  assert.equal((await poster(f.sender, f.place.id, text.id, png())).status, 404, 'only a video has a poster');
  assert.equal((await poster(f.sender, f.place.id, randomUUID(), png())).status, 404);
  assert.equal((await poster(f.outsider, f.place.id, video.id, png())).status, 404);
  for (const [what, bytes] of [['SVG', SVG], ['HTML', Buffer.from('<script>alert(1)</script>')], ['text', Buffer.from('hello')], ['a video', clip('clip.mp4')]] as const) {
    const refused = await poster(f.sender, f.place.id, video.id, bytes);
    assert.equal(refused.status, 400, what);
    assert.equal(refused.body.code, 'UNSUPPORTED_PICTURE', what);
  }
  // A picture that unpacks to far more pixels than it says is refused from its header, before it is decoded.
  const bomb = await poster(f.sender, f.place.id, video.id, png(8, 8, { declared: { width: 20_000, height: 20_000 } }));
  assert.ok([400, 413].includes(bomb.status), `status ${bomb.status}`);
  const big = await fetch(new URL(filePosterPath(f.place.id, video.id), f.sender.browser.base), {
    method: 'POST', headers: headers(f.sender, { 'content-type': 'application/octet-stream' }), body: Buffer.alloc(FILE_LIMITS.posterBytes + 1, 1),
  });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { code: string }).code, 'POSTER_TOO_LARGE');
  assert.equal((await fetch(new URL(filePosterPath(f.place.id, video.id), f.sender.browser.base), { method: 'POST', headers: headers(f.sender, { 'content-type': 'image/png' }), body: Buffer.from(png()) })).status, 400);
  // Still a video with no poster, and still sendable.
  const started = await send(f.sender, f.place.id, [video.id]);
  assert.equal(started.messages[0]!.files![0]!.poster, undefined);
});

test('in an encrypted space a video is an ordinary sealed file: 5 MiB, no poster, no playback', async () => {
  const ada = await person('Sealed sender');
  const sealed = (await createSealed(ada, 'Sealed videos', passphrase())).workspace;
  const place = await project(ada, sealed.id, 'Sealed place', 'workspace');
  const staged = await upload(ada, place.id, clip('clip.mp4'), 'sealed.mp4');
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.video, undefined, 'no container is recorded for a sealed space');
  assert.equal((await get(ada, fileVideoPath(staged.body.id))).status, 404, 'no playback route');
  assert.equal((await poster(ada, place.id, staged.body.id, png())).status, 404, 'no poster');
  const row = (await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.id, staged.body.id)))[0]!;
  assert.equal(row.videoContainer, null);
  assert.ok(row.keyVersion !== null, 'it is sealed on disk like every file of the space');
  // It downloads, sealed and opened, byte for byte, and ranges as a file.
  const download = await get(ada, `/api/v1/files/${staged.body.id}`, { range: 'bytes=0-31' });
  assert.equal(download.status, 206);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), clip('clip.mp4').subarray(0, 32));
  // The ordinary limit holds, in the ordinary words.
  const large = await upload(ada, place.id, longClip(FILE_LIMITS.fileBytes), 'large.mp4');
  assert.deepEqual([large.status, large.body.code], [413, 'FILE_TOO_LARGE']);
  assert.match(large.body.error!, /A file is at most 5 MiB/);
  // Its bytes are not recognised as a video, so a mislabelled one is just a file.
  assert.equal((await upload(ada, place.id, Buffer.from('not a movie'), 'plain.mp4')).status, 201);
});
