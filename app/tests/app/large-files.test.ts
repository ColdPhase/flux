import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { FILE_LIMITS, FILE_LIMITS_PATH, type Conversation, type FileLimits, type StagedFile } from '@flux/contracts';
import { createSealed, passphrase } from './support/encryption.js';
import { db } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { png } from './support/pictures.js';

// #1549 (C-61): a PDF or any other document may be larger than 5 MiB, up to the operator's FLUX_FILE_MAX_MIB, and takes the video's streamed
// path. The test stack sets FLUX_FILE_MAX_MIB=8 (docker/compose.test.yaml), above the 5 MiB a file is read whole and below the video cap.
const MiB = 1024 * 1024;
const FILE_CAP = 8 * MiB;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Staged = StagedFile & { code?: string; error?: string };

async function scene() {
  const owner = await person('Large owner');
  const sender = await person('Large sender');
  const reader = await person('Large reader');
  const ws = await workspace(owner, 'Large files');
  for (const other of [sender, reader]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Scans and decks', 'restricted');
  await grant(owner, place.id, sender, 'contributor');
  await grant(owner, place.id, reader, 'contributor');
  return { owner, sender, reader, ws, place };
}
const headers = (who: Person, extra: Record<string, string> = {}) => ({ cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin, ...extra });
async function upload(who: Person, projectId: string, bytes: Uint8Array, name: string, uploadId: string = randomUUID()) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as Staged };
}
const get = (who: Person, path: string, extra: Record<string, string> = {}) => fetch(new URL(path, who.browser.base), { headers: headers(who, extra) });
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
/** An upload with no declared length (chunked), so only the count can stop it. */
async function chunked(who: Person, projectId: string, name: string, total: number) {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (let sent = 0; sent < total; sent += MiB) controller.enqueue(new Uint8Array(Math.min(MiB, total - sent)).fill(0x41));
    controller.close();
  } });
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { status: response.status, body: await response.json() as Staged };
}

/**
 * A PDF of `size` bytes with three pages whose page tree root comes last, after a picture's stream of several MiB: its pages can be counted
 * only from bytes past the first 5 MiB, as the upload streams them.
 */
function largePdf(size: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\n'
    + '2 0 obj << /Type /Page /Parent 9 0 R >> endobj\n3 0 obj << /Type /Page /Parent 9 0 R >> endobj\n4 0 obj << /Type /Page /Parent 9 0 R >> endobj\n'
    + '5 0 obj << /Type /XObject /Subtype /Image /Length 0 >> stream\n', 'latin1');
  const tail = Buffer.from('\nendstream endobj\n9 0 obj << /Type /Pages /Kids [2 0 R 3 0 R 4 0 R] /Count 3 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const picture = Buffer.alloc(size - head.length - tail.length);
  for (let i = 0; i < picture.length; i++) picture[i] = (i * 131 + 17) & 0xff;
  return Buffer.concat([head, picture, tail]);
}

test('the limits say the operator\'s file cap and the message total that follows from it', async () => {
  const who = await person('Large limits');
  const limits = expectStatus(await who.browser.request('GET', FILE_LIMITS_PATH), 200) as FileLimits;
  assert.equal(limits.fileBytes, FILE_CAP, 'the test stack sets FLUX_FILE_MAX_MIB=8');
  assert.equal(limits.messageBytes, 4 * FILE_CAP);
});

test('a PDF over 5 MiB uploads, counts its pages, downloads whole and by range, and goes on a message to its readers', async () => {
  const f = await scene();
  const pdf = largePdf(7 * MiB + 123);
  const staged = await upload(f.sender, f.place.id, pdf, 'Site survey scan.pdf');
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.size, pdf.length);
  assert.equal(staged.body.sha256, digest(pdf));
  assert.equal(staged.body.pages, 3, 'the page tree after the first 5 MiB is counted as the bytes arrive');
  const row = (await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.id, staged.body.id)))[0]!;
  assert.equal(row.size, pdf.length);
  assert.equal(row.reservedBytes, pdf.length, 'a large file reserves its declared length, not the cap');
  // The same upload id with the same bytes is the same file.
  const again = await upload(f.sender, f.place.id, pdf, 'Site survey scan.pdf', staged.body.uploadId);
  assert.deepEqual([again.status, again.body.id], [201, staged.body.id]);
  const message = expectStatus(await f.sender.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`,
    { body: { body: 'The survey, scanned', attachmentIds: [staged.body.id], clientMessageId: randomUUID() } }), 201) as Conversation;
  assert.equal(message.messages[0]!.files![0]!.pages, 3);
  const whole = await get(f.reader, `/api/v1/files/${staged.body.id}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-length'), String(pdf.length));
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(digest(Buffer.from(await whole.arrayBuffer())), digest(pdf));
  const start = 6 * MiB;
  const part = await get(f.reader, `/api/v1/files/${staged.body.id}`, { range: `bytes=${start}-${start + 999}` });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes ${start}-${start + 999}/${pdf.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), pdf.subarray(start, start + 1000));
  // A file over 5 MiB is a download, never rewritten in memory as a preview page.
  const html = await upload(f.sender, f.place.id, Buffer.concat([Buffer.from('<!doctype html><p>big</p>'), Buffer.alloc(6 * MiB, 0x20)]), 'big.html');
  assert.equal(html.status, 201);
  const preview = await get(f.sender, `/api/v1/files/${html.body.id}/preview`, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' });
  assert.equal(preview.status, 404);
  assert.equal((await preview.json() as { code: string }).code, 'FILE_NO_PREVIEW');
});

test('over the operator\'s cap is refused in the server\'s words, by the declared length and by the count, and leaves nothing', async () => {
  const f = await scene();
  const over = await declared(f.sender, f.place.id, 'deck.pdf', FILE_CAP + 1);
  assert.deepEqual([over.status, over.body.code], [413, 'FILE_TOO_LARGE']);
  assert.equal(over.body.error, 'Files can be up to 8 MB on this server');
  const streamed = await chunked(f.sender, f.place.id, 'archive.zip', FILE_CAP + 1);
  assert.deepEqual([streamed.status, streamed.body.code], [413, 'FILE_TOO_LARGE']);
  assert.equal((await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.projectId, f.place.id))).length, 0);
  const exact = await chunked(f.sender, f.place.id, 'archive.zip', FILE_CAP);
  assert.equal(exact.status, 201, JSON.stringify(exact.body));
  assert.equal(exact.body.size, FILE_CAP);
});

test('a picture stays at 5 MiB, and so does every file of an encrypted space', async () => {
  const f = await scene();
  // A file that starts like a PNG is held whole to be cleaned (#1343): over 5 MiB it is refused before it is decoded.
  const picture = Buffer.concat([png(), Buffer.alloc(FILE_LIMITS.wholeBytes, 1)]);
  const refused = await upload(f.sender, f.place.id, picture, 'photo.png');
  assert.deepEqual([refused.status, refused.body.code], [413, 'FILE_TOO_LARGE']);
  assert.equal(refused.body.error, 'A picture is at most 5 MB');
  const ada = await person('Large sealed sender');
  const sealed = (await createSealed(ada, 'Sealed large files', passphrase())).workspace;
  const place = await project(ada, sealed.id, 'Sealed scans', 'workspace');
  const large = await upload(ada, place.id, largePdf(FILE_LIMITS.wholeBytes + 1), 'sealed.pdf');
  assert.deepEqual([large.status, large.body.code], [413, 'FILE_TOO_LARGE']);
  assert.equal(large.body.error, 'A file in an encrypted space is at most 5 MB');
  assert.equal((await upload(ada, place.id, largePdf(FILE_LIMITS.wholeBytes), 'sealed.pdf')).status, 201);
});
