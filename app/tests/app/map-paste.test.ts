import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { fileRows, schema } from '@flux/db';
import { createAgent, createFileUseCases, grantProject, type Principal } from '@flux/core';
import { imageTypeOf, type CreatedThought, type Sketch, type SketchDetail, type StagedFile } from '@flux/contracts';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { fileUnitOfWork } from '../../apps/server/src/files/adapters.js';
import { sketchUseCases } from '../../apps/server/src/sketches/adapters.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { db, pool } from './support/db.js';

// #252: pasting on a map. Lines and links are ordinary thoughts saved only by the client's confirmation; an image is
// staged privately through the #225 stored-files path and becomes the project's to read only when its thought is
// created. Contract: docs/development/task-discussions.md ("Map thought images") and docs/design/thought-drafts.md.

const filesDir = process.env.FLUX_TEST_FILES_DIR ?? '/data/files';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="4" height="4"/></svg>');

async function scene() {
  const owner = await person('Paste owner');
  const writer = await person('Paste writer');
  const reader = await person('Paste reader');
  const outsider = await person('Paste outsider');
  const ws = await workspace(owner, 'Map paste');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Gesture lamp', 'restricted');
  const elsewhere = await project(owner, ws.id, 'Reading corner', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, elsewhere.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'viewer');
  const map = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
    { body: { title: 'Bedside sensing', scope: 'project', projectId: place.id } }), 201) as Sketch;
  return { owner, writer, reader, outsider, ws, place, elsewhere, map };
}

async function upload(who: Person, projectId: string, bytes: Uint8Array, name = 'Pasted image.png') {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin },
    body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as StagedFile & { code?: string } };
}
const download = (who: Person, id: string) => fetch(new URL(`/api/v1/files/${id}`, who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
const detail = async (who: Person, sketchId: string) => expectStatus(await who.browser.request('GET', `/api/v1/sketches/${sketchId}`), 200) as SketchDetail;
const place = (who: Person, sketchId: string, body: Record<string, unknown>, key = randomUUID()) =>
  who.browser.request('POST', `/api/v1/sketches/${sketchId}/thoughts`, { body: { text: 'Pasted image', x: 40, y: 40, width: 240, height: 200, ...body }, headers: { 'idempotency-key': key } });
const code = (response: { json: unknown }) => (response.json as { code?: string }).code;
const row = async (id: string) => (await fileRows(db).findFile(id))!;
const sketchEvents = async (sketchId: string) => Number((await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id = $1', [sketchId])).rows[0].n);

test('image signatures: PNG, JPEG, GIF and WebP only, never SVG or a renamed text file', () => {
  assert.equal(imageTypeOf(PNG), 'image/png');
  assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])), 'image/jpeg');
  assert.equal(imageTypeOf(Buffer.from('GIF89a\x01\x00', 'latin1')), 'image/gif');
  assert.equal(imageTypeOf(Buffer.from('GIF87a\x01\x00', 'latin1')), 'image/gif');
  assert.equal(imageTypeOf(Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])), 'image/webp');
  // Negative controls: a RIFF that is not WebP, SVG markup, text and truncated signatures.
  assert.equal(imageTypeOf(Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt ')])), null);
  assert.equal(imageTypeOf(SVG), null);
  assert.equal(imageTypeOf(Buffer.from('lux,gestures\n5,38%\n')), null);
  assert.equal(imageTypeOf(PNG.subarray(0, 7)), null);
  assert.equal(imageTypeOf(new Uint8Array()), null);
});

test('a pasted image stays private staging until its thought is saved, then the project reads it', async () => {
  const f = await scene();
  const before = await detail(f.owner, f.map.id);
  const eventsBefore = await sketchEvents(f.map.id);
  const staged = await upload(f.writer, f.place.id, PNG);
  assert.equal(staged.status, 201);
  // Draft before save: staging writes nothing shared. No thought, link or map event; nobody else can read the bytes.
  assert.deepEqual(await detail(f.owner, f.map.id), before);
  assert.equal(await sketchEvents(f.map.id), eventsBefore);
  for (const other of [f.owner, f.reader, f.outsider]) assert.equal((await download(other, staged.body.id)).status, 404, 'private staging');
  assert.equal((await download(f.writer, staged.body.id)).status, 200, 'the uploader previews their own staged image');

  const key = randomUUID();
  const thoughtId = randomUUID();
  const created = expectStatus(await place(f.writer, f.map.id, { id: thoughtId, fileId: staged.body.id.toUpperCase() }, key), 201) as CreatedThought;
  assert.deepEqual(created.thought.file, { id: staged.body.id, name: 'Pasted image.png', size: PNG.length });
  assert.equal(created.thought.text, 'Pasted image');
  assert.deepEqual([created.thought.width, created.thought.height], [240, 200]);
  const published = await row(staged.body.id);
  assert.equal(published.thoughtId, thoughtId);
  assert.equal(published.messageId, null);
  assert.equal(published.expiresAt, null, 'a published image never expires');
  assert.ok(published.publishedAt);
  // An exact retry returns the same thought; it never duplicates or republishes.
  assert.deepEqual(expectStatus(await place(f.writer, f.map.id, { id: thoughtId, fileId: staged.body.id.toUpperCase() }, key), 201), created);
  const shared = await detail(f.reader, f.map.id);
  assert.equal(shared.thoughts.length, before.thoughts.length + 1);
  assert.deepEqual(shared.thoughts.find((thought) => thought.id === thoughtId)!.file, created.thought.file);
  for (const other of [f.owner, f.reader]) {
    const response = await download(other, staged.body.id);
    assert.equal(response.status, 200, 'project read after confirmation');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  }
  assert.equal((await download(f.outsider, staged.body.id)).status, 404, 'still only the project');
  // Thoughts without an image carry no `file`; cleanup never touches a published image.
  const plain = expectStatus(await place(f.writer, f.map.id, { text: 'https://example.test/lamp-notes' }), 201) as CreatedThought;
  assert.equal('file' in plain.thought, false);
  await createFileUseCases(fileUnitOfWork(db), await diskFileStorage(filesDir)).cleanup();
  assert.equal((await download(f.reader, staged.body.id)).status, 200);
  // Losing project access ends the image read like any project content.
  await grant(f.owner, f.place.id, f.reader, 'denied');
  assert.equal((await download(f.reader, staged.body.id)).status, 404);
});

test('viewers, other uploaders, other projects, private maps, agents and non-images cannot place an image', async () => {
  const f = await scene();
  const before = await detail(f.owner, f.map.id);
  // A viewer can neither stage nor save a thought.
  const viewerUpload = await upload(f.reader, f.place.id, PNG);
  assert.equal(viewerUpload.status, 403);
  const staged = (await upload(f.writer, f.place.id, PNG)).body;
  assert.equal((await place(f.reader, f.map.id, { fileId: staged.id })).status, 403);
  // Another person's staged image is an unknown file, even to the project's manager.
  const foreign = await place(f.owner, f.map.id, { fileId: staged.id });
  assert.equal(foreign.status, 404);
  assert.equal(code(foreign), 'ATTACHMENT_UNAVAILABLE');
  // A file staged in another project, a guessed id and an expired staging are unknown too.
  const away = (await upload(f.writer, f.elsewhere.id, PNG)).body;
  assert.equal(code(await place(f.writer, f.map.id, { fileId: away.id })), 'ATTACHMENT_UNAVAILABLE');
  assert.equal(code(await place(f.writer, f.map.id, { fileId: randomUUID() })), 'ATTACHMENT_UNAVAILABLE');
  const stale = (await upload(f.writer, f.place.id, PNG, 'stale.png')).body;
  await db.update(schema.projectFiles).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.projectFiles.id, stale.id));
  assert.equal(code(await place(f.writer, f.map.id, { fileId: stale.id })), 'ATTACHMENT_UNAVAILABLE');
  // Type limit by signature: SVG and a renamed text file stay private staging.
  for (const [bytes, name] of [[SVG, 'drawing.svg'], [Buffer.from('lux,gestures\n5,38%\n'), 'readings.png']] as const) {
    const other = (await upload(f.writer, f.place.id, bytes, name)).body;
    const refused = await place(f.writer, f.map.id, { fileId: other.id });
    assert.equal(refused.status, 400);
    assert.equal(code(refused), 'UNSUPPORTED_IMAGE');
    assert.equal((await row(other.id)).publishedAt, null);
    assert.equal((await download(f.reader, other.id)).status, 404);
  }
  // Size limit: the stored-file limit refuses a larger image before it is staged.
  const large = await upload(f.writer, f.place.id, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
  assert.equal(large.status, 413);
  // Stored files belong to a project: a private map refuses the image and keeps it staged.
  const mine = expectStatus(await f.writer.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`, { body: { title: 'Mine', scope: 'private' } }), 201) as Sketch;
  const privateMap = await place(f.writer, mine.id, { fileId: staged.id });
  assert.equal(privateMap.status, 422);
  assert.equal(code(privateMap), 'IMAGES_NEED_A_PROJECT');
  assert.deepEqual((await detail(f.writer, mine.id)).thoughts, []);
  // Agents cannot place files, even with a contributor grant.
  const owner: Principal = { kind: 'human', id: f.owner.id };
  const helper = await createAgent(owner, f.ws.id, { name: 'Lamp helper', owner: 'self' }, db);
  await grantProject(owner, f.place.id, { principal: { kind: 'agent', id: helper.id }, role: 'contributor' }, db);
  const agent: Principal = { kind: 'agent', id: helper.id };
  await assert.rejects(sketchUseCases(db, await diskFileStorage(filesDir)).addThought(agent, f.map.id, { text: 'Agent image', x: 0, y: 0, fileId: staged.id }),
    (error: unknown) => (error as { code?: string }).code === 'AGENT_FILES_UNAVAILABLE');
  // Nothing above created a thought or published the staged image.
  assert.deepEqual(await detail(f.owner, f.map.id), before);
  assert.equal((await row(staged.id)).publishedAt, null);
  assert.equal((await download(f.reader, staged.id)).status, 404);
});

test('an image is published once: Undo restores the same thought, nothing else can reuse it', async () => {
  const f = await scene();
  const staged = (await upload(f.writer, f.place.id, PNG)).body;
  const id = randomUUID();
  const created = expectStatus(await place(f.writer, f.map.id, { id, fileId: staged.id }), 201) as CreatedThought;
  expectStatus(await f.writer.browser.request('DELETE', `/api/v1/sketches/${f.map.id}/thoughts/${id}`, { headers: { 'if-match': `"${created.thought.version}"` } }), 204);
  // Removing the thought neither unpublishes nor deletes the file (like a placement).
  assert.equal((await row(staged.id)).thoughtId, id);
  assert.equal((await download(f.reader, staged.id)).status, 200);
  // Undo re-creates the same thought id with its image; another project writer may do it too.
  const restored = expectStatus(await place(f.owner, f.map.id, { id, fileId: staged.id }), 201) as CreatedThought;
  assert.deepEqual(restored.thought.file, created.thought.file);
  // Any other reuse: another thought, or a message.
  const again = await place(f.writer, f.map.id, { fileId: staged.id });
  assert.equal(again.status, 409);
  assert.equal(code(again), 'ATTACHMENT_ALREADY_PUBLISHED');
  const message = await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`,
    { body: { body: '', attachmentIds: [staged.id], clientMessageId: randomUUID() } });
  assert.equal(message.status, 409);
  assert.equal(code(message), 'ATTACHMENT_ALREADY_PUBLISHED');
  // A message attachment cannot become a thought image either.
  const attached = (await upload(f.writer, f.place.id, PNG, 'attached.png')).body;
  expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`,
    { body: { body: 'The lamp at dusk', attachmentIds: [attached.id], clientMessageId: randomUUID() } }), 201);
  const fromMessage = await place(f.writer, f.map.id, { fileId: attached.id });
  assert.equal(fromMessage.status, 409);
  assert.equal(code(fromMessage), 'ATTACHMENT_ALREADY_PUBLISHED');
  assert.equal((await row(attached.id)).thoughtId, null);
  // The database itself refuses a file published to a message and a thought at once.
  await assert.rejects(pool.query('UPDATE project_files SET thought_id = $1 WHERE id = $2', [randomUUID(), attached.id]), /project_file_publication/);
  const map = await detail(f.reader, f.map.id);
  assert.deepEqual(map.thoughts.filter((thought) => thought.file).map((thought) => thought.id), [id]);
});
