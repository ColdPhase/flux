import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { dmFilePosterPath, dmFilesPath, FILE_LIMITS, fileVideoPath, type Dm, type DmMessage, type StagedFile } from '@flux/contracts';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, person, removeMember, workspace, type Person } from './support/people.js';
import { png } from './support/pictures.js';

// Files, photos and videos in direct messages (#1438 point 10): the same stored files, limits, checks, pictures and videos as a space's, with the
// conversation as the place. A staged file is its sender's alone; a sent one is for the conversation's current people, checked on every request.

const MiB = 1024 * 1024;
const clip = (name: string) => readFileSync(join(import.meta.dirname, '../ui/fixtures/video', name));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Staged = StagedFile & { code?: string; error?: string };
const headers = (who: Person, extra: Record<string, string> = {}) => ({ cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin, ...extra });
const get = (who: Person, path: string, extra: Record<string, string> = {}) => fetch(new URL(path, who.browser.base), { headers: headers(who, extra) });

async function scene() {
  const ada = await person('Ada Files');
  const ben = await person('Ben Files');
  const cyra = await person('Cyra Files');
  const lee = await person('Lee Files');
  const ws = await workspace(ada, 'DM files');
  for (const other of [ben, cyra, lee]) await addMember(ada, ws.id, other, 'member');
  const pair = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [ben.id] } }), 201) as Dm;
  return { ada, ben, cyra, lee, ws, pair };
}
async function upload(who: Person, dmId: string, bytes: Uint8Array, name = 'notes.txt', uploadId = randomUUID()) {
  const response = await fetch(new URL(`${dmFilesPath(dmId)}?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as Staged };
}
async function poster(who: Person, dmId: string, fileId: string, bytes: Uint8Array) {
  const response = await fetch(new URL(dmFilePosterPath(dmId, fileId), who.browser.base), { method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes) });
  return { status: response.status, body: await response.json() as Staged };
}
const send = (who: Person, dmId: string, body: string, attachmentIds: string[] = [], rootId?: string) => who.browser.request('POST',
  rootId ? `/api/v1/dms/${dmId}/threads/${rootId}/replies` : `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID(), ...(attachmentIds.length ? { attachmentIds } : {}) } });
const read = async (who: Person, dmId: string) => (expectStatus(await who.browser.request('GET', `/api/v1/dms/${dmId}`), 200) as Dm).messages;

test('a file sent in a direct message reaches the conversation\'s people and nobody else', async () => {
  const f = await scene();
  const bytes = Buffer.from('Notes for Ben, only for Ben');
  const staged = await upload(f.ada, f.pair.id, bytes);
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.dmId, f.pair.id);
  assert.equal(staged.body.projectId, undefined, 'a direct message\'s file belongs to no space');
  assert.equal(staged.body.sha256, digest(bytes));
  // Until it is sent a staged file is its sender's alone; the other person and an outsider find nothing.
  assert.equal((await get(f.ben, `/api/v1/files/${staged.body.id}`)).status, 404);
  assert.equal((await get(f.ada, `/api/v1/files/${staged.body.id}`)).status, 200);
  // Words and a file; the file alone; and a file the sender did not stage, which is no file at all.
  const sent = expectStatus(await send(f.ada, f.pair.id, 'Here are the notes', [staged.body.id]), 201) as DmMessage;
  assert.deepEqual(sent.files, [{ id: staged.body.id, name: 'notes.txt', size: bytes.length }]);
  const only = expectStatus(await send(f.ada, f.pair.id, '', [(await upload(f.ada, f.pair.id, Buffer.from('second'), 'second.txt')).body.id]), 201) as DmMessage;
  assert.equal(only.body, '');
  assert.equal(only.files!.length, 1);
  assert.equal((await send(f.ada, f.pair.id, '')).status, 400, 'no words and no files is no message');
  const theirs = (await upload(f.ben, f.pair.id, Buffer.from('mine'), 'ben.txt')).body.id;
  assert.equal((await send(f.ada, f.pair.id, 'borrowed', [theirs])).status, 404, 'another person\'s staged file cannot be sent');
  // Both people read the conversation with its files, and the bytes.
  for (const who of [f.ada, f.ben]) {
    const messages = await read(who, f.pair.id);
    assert.deepEqual(messages.map((m) => m.files?.map((file) => file.name) ?? []), [['notes.txt'], ['second.txt']]);
    const downloaded = await get(who, `/api/v1/files/${staged.body.id}`);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  }
  // Someone outside the conversation, in the same company, finds neither the conversation nor the file; nor can they stage one in it.
  assert.equal((await get(f.cyra, `/api/v1/files/${staged.body.id}`)).status, 404);
  assert.equal((await get(f.cyra, `/api/v1/dms/${f.pair.id}`)).status, 404);
  assert.equal((await upload(f.cyra, f.pair.id, Buffer.from('intruder'))).status, 404);
  assert.equal((await send(f.cyra, f.pair.id, 'hello', [])).status, 404);
  // It is a stored file of no space: no project, and nothing in search or the file-text queue.
  const [row] = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.id, staged.body.id));
  assert.deepEqual([row!.projectId, row!.dmId, row!.messageId, row!.dmMessageId === sent.id], [null, f.pair.id, null, true]);
  assert.equal((await pool.query(`SELECT 1 FROM search_documents WHERE kind = 'file' AND object_id = $1`, [staged.body.id])).rows.length, 0);
  assert.equal((await pool.query(`SELECT 1 FROM file_text_jobs WHERE file_id = $1`, [staged.body.id])).rows.length, 0);
});

test('a picture is decoded and written again, and a file over the limit is refused, as in a space', async () => {
  const f = await scene();
  const photo = png(48, 32, { metadata: true });
  const staged = await upload(f.ada, f.pair.id, photo, 'photo.png');
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const stored = Buffer.from(await (await get(f.ada, `/api/v1/files/${staged.body.id}`)).arrayBuffer());
  assert.ok(!stored.includes(Buffer.from('Ada Nowak')) && !stored.includes(Buffer.from('tEXt')), 'what a camera wrote in the picture is not kept');
  // A file that starts like a picture is read whole by the real decoder, and refused when it cannot be vouched for; any other file is stored as it arrives.
  const damaged = await upload(f.ada, f.pair.id, photo.subarray(0, 40), 'damaged.png');
  assert.equal(damaged.status, 400, JSON.stringify(damaged.body));
  assert.equal(damaged.body.code, 'UNREADABLE_PICTURE');
  const big = await upload(f.ada, f.pair.id, Buffer.alloc(FILE_LIMITS.fileBytes + 1, 1), 'big.bin');
  assert.equal(big.status, 413);
  assert.equal(big.body.code, 'FILE_TOO_LARGE');
  assert.equal((await upload(f.ada, f.pair.id, Buffer.alloc(0), 'empty.txt')).status, 400);
  assert.equal((await upload(f.ada, f.pair.id, Buffer.from('x'), '../escape')).status, 400);
});

test('a video plays by range in a direct message, with its poster, for the conversation\'s people only', async () => {
  const f = await scene();
  const video = await upload(f.ada, f.pair.id, clip('clip.mp4'), 'clip.mp4');
  assert.equal(video.status, 201, JSON.stringify(video.body));
  assert.equal(video.body.video, 'mp4');
  const staged = await poster(f.ada, f.pair.id, video.body.id, png(64, 40));
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal((await poster(f.cyra, f.pair.id, video.body.id, png(64, 40))).status, 404, 'an outsider takes no poster');
  const sent = expectStatus(await send(f.ada, f.pair.id, '', [video.body.id]), 201) as DmMessage;
  assert.equal(sent.files![0]!.video, 'mp4');
  assert.ok(sent.files![0]!.poster, 'the poster goes to the message with its video');
  const played = await get(f.ben, fileVideoPath(video.body.id), { range: 'bytes=0-99' });
  assert.equal(played.status, 206);
  assert.equal(played.headers.get('content-type'), 'video/mp4');
  assert.equal((await get(f.ben, `/api/v1/files/${sent.files![0]!.poster}`)).status, 200);
  assert.equal((await get(f.cyra, fileVideoPath(video.body.id))).status, 404);
  assert.equal((await get(f.cyra, `/api/v1/files/${sent.files![0]!.poster}`)).status, 404);
});

test('a reply in a thread carries files; a message with files may be edited to no words; a message without may not', async () => {
  const f = await scene();
  const root = expectStatus(await send(f.ada, f.pair.id, 'Look at the plan'), 201) as DmMessage;
  const reply = expectStatus(await send(f.ben, f.pair.id, '', [(await upload(f.ben, f.pair.id, Buffer.from('plan v2'), 'plan.txt')).body.id], root.id), 201) as DmMessage;
  assert.equal(reply.files![0]!.name, 'plan.txt');
  const thread = expectStatus(await f.ada.browser.request('GET', `/api/v1/dms/${f.pair.id}/threads/${root.id}`), 200) as { replies: DmMessage[] };
  assert.equal(thread.replies[0]!.files![0]!.name, 'plan.txt');
  const withWords = expectStatus(await send(f.ada, f.pair.id, 'Words and a file', [(await upload(f.ada, f.pair.id, Buffer.from('a'), 'a.txt')).body.id]), 201) as DmMessage;
  const edited = expectStatus(await f.ada.browser.request('PATCH', `/api/v1/dms/${f.pair.id}/messages/${withWords.id}`, { body: { body: '' } }), 200) as DmMessage;
  assert.equal(edited.body, '');
  assert.equal(edited.files!.length, 1, 'the file stays');
  assert.equal((await f.ada.browser.request('PATCH', `/api/v1/dms/${f.pair.id}/messages/${root.id}`, { body: { body: '' } })).status, 400, 'a message with no files needs words');
});

test('deleting a message takes its files with it, and a person who left no longer reaches the conversation\'s files', async () => {
  const f = await scene();
  const group = expectStatus(await f.ada.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/dms`, { body: { participantIds: [f.ben.id, f.cyra.id], title: 'Garden group' } }), 201) as Dm;
  const keep = (await upload(f.ada, group.id, Buffer.from('kept'), 'kept.txt')).body.id;
  const drop = (await upload(f.ada, group.id, Buffer.from('dropped'), 'dropped.txt')).body.id;
  const keptMessage = expectStatus(await send(f.ada, group.id, 'keep', [keep]), 201) as DmMessage;
  const droppedMessage = expectStatus(await send(f.ada, group.id, 'drop', [drop]), 201) as DmMessage;
  for (const who of [f.ada, f.ben, f.cyra]) assert.equal((await get(who, `/api/v1/files/${keep}`)).status, 200);
  // Delete (C-48): the words become the marker and the file is gone for everyone.
  const removed = expectStatus(await f.ada.browser.request('DELETE', `/api/v1/dms/${group.id}/messages/${droppedMessage.id}`), 200) as DmMessage;
  assert.equal(removed.body, 'Message removed');
  assert.equal(removed.files, undefined);
  for (const who of [f.ada, f.ben, f.cyra]) assert.equal((await get(who, `/api/v1/files/${drop}`)).status, 404);
  assert.equal((await pool.query(`SELECT 1 FROM file_garbage WHERE id = $1`, [drop])).rows.length, 1, 'its bytes are queued for removal');
  // Ben leaves: he no longer reaches what the conversation holds.
  expectStatus(await f.ben.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204);
  assert.equal((await get(f.ben, `/api/v1/files/${keep}`)).status, 404);
  assert.equal((await upload(f.ben, group.id, Buffer.from('late'))).status, 404);
  assert.equal((await get(f.cyra, `/api/v1/files/${keep}`)).status, 200);
  assert.equal(keptMessage.files!.length, 1);
});

test('a file staged in a space cannot be sent in a direct message, and one staged in a conversation not in another', async () => {
  const f = await scene();
  const other = expectStatus(await f.ada.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/dms`, { body: { participantIds: [f.lee.id] } }), 201) as Dm;
  const here = (await upload(f.ada, f.pair.id, Buffer.from('for Ben'), 'ben.txt')).body.id;
  assert.equal((await send(f.ada, other.id, 'wrong place', [here])).status, 404, 'a file belongs to the conversation it was staged in');
  const space = expectStatus(await f.ada.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/projects`, { body: { name: 'Garden', visibility: 'workspace' } }), 201) as { id: string };
  const staged = await fetch(new URL(`/api/v1/projects/${space.id}/files?uploadId=${randomUUID()}&name=space.txt`, f.ada.browser.base), {
    method: 'POST', headers: headers(f.ada, { 'content-type': 'application/octet-stream' }), body: Buffer.from('a space file') });
  assert.equal(staged.status, 201);
  assert.equal((await send(f.ada, f.pair.id, 'wrong kind', [((await staged.json()) as StagedFile).id])).status, 404);
  assert.deepEqual(await read(f.ada, f.pair.id), [], 'nothing was sent');
  assert.equal((await send(f.ada, f.pair.id, 'too many', Array.from({ length: FILE_LIMITS.messageFiles + 1 }, () => randomUUID()))).status, 400);
  assert.equal(MiB, 1024 * 1024);
});

test('someone of another company, a guest outside the conversation and a person removed from the company never reach its files; a conversation\'s file goes into no space', async () => {
  const f = await scene();
  const zed = await person('Zed Elsewhere');
  await workspace(zed, 'Another company');
  const gus = await person('Gus Guest');
  await addMember(f.ada, f.ws.id, gus, 'guest');
  const fileId = (await upload(f.ada, f.pair.id, Buffer.from('for Ben only'), 'ben.txt')).body.id;
  expectStatus(await send(f.ada, f.pair.id, 'for you', [fileId]), 201);
  // Checked on every request: neither the file, nor the conversation, nor staging into it.
  for (const who of [zed, gus]) {
    assert.equal((await get(who, `/api/v1/files/${fileId}`)).status, 404);
    assert.equal((await get(who, `/api/v1/files/${fileId}`, { range: 'bytes=0-3' })).status, 404);
    assert.equal((await get(who, `/api/v1/dms/${f.pair.id}`)).status, 404);
    assert.equal((await upload(who, f.pair.id, Buffer.from('intruder'))).status, 404);
  }
  // A file staged in a conversation cannot be posted into a space, where the space's people would read it.
  const space = expectStatus(await f.ada.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/projects`, { body: { name: 'Everyone sees', visibility: 'workspace' } }), 201) as { id: string };
  const dmOnly = (await upload(f.ada, f.pair.id, Buffer.from('dm only'), 'dm-only.txt')).body.id;
  const posted = await f.ada.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body: 'leak?', clientMessageId: randomUUID(), attachmentIds: [dmOnly] } });
  assert.deepEqual([posted.status, (posted.json as { code?: string } | null)?.code], [404, 'ATTACHMENT_UNAVAILABLE']);
  // Ben is removed from the company: the conversation's file is gone for him at once, and stays for Ada.
  assert.equal((await get(f.ben, `/api/v1/files/${fileId}`)).status, 200);
  await removeMember(f.ada, f.ws.id, f.ben);
  assert.equal((await get(f.ben, `/api/v1/files/${fileId}`)).status, 404);
  assert.equal((await get(f.ada, `/api/v1/files/${fileId}`)).status, 200);
});
