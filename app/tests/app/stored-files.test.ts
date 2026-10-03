import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { and, eq, sql } from 'drizzle-orm';
import { fileRows, schema } from '@flux/db';
import { createFileUseCases, NotFoundError, type FileUnitOfWork } from '@flux/core';
import { FILE_LIMITS, type Conversation, type ConversationMessage, type StagedFile, type TaskDiscussion, type WorkItem } from '@flux/contracts';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { exportUseCases } from '../../apps/server/src/export/adapters.js';
import { fileUnitOfWork } from '../../apps/server/src/files/adapters.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { db } from './support/db.js';

const filesDir = process.env.FLUX_TEST_FILES_DIR ?? '/data/files';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const objectPath = (id: string) => join(filesDir, 'attachments', 'objects', id.slice(0, 2), id);
const chunks = async function* (bytes: Uint8Array) { yield bytes; };
async function scene() {
  const owner = await person('File owner');
  const writer = await person('File writer');
  const reader = await person('File reader');
  const outsider = await person('File outsider');
  const ws = await workspace(owner, 'Stored files');
  for (const other of [writer, reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Private file conversation', 'restricted');
  await grant(owner, place.id, writer, 'contributor');
  await grant(owner, place.id, reader, 'viewer');
  return { owner, writer, reader, outsider, ws, place };
}
async function upload(who: Person, projectId: string, bytes: Uint8Array, uploadId: string = randomUUID(), name = 'pomysł.txt') {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin },
    body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as StagedFile & { code?: string } };
}
async function download(who: Person, id: string) {
  return fetch(new URL(`/api/v1/files/${id}`, who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
}

test('real bytes have a measured digest, private staging, canonical upload retry and safe download headers', async () => {
  const f = await scene();
  const bytes = Buffer.from([0, 255, 128, 4, 10]);
  const key = randomUUID();
  const staged = await upload(f.writer, f.place.id.toUpperCase(), bytes, key.toUpperCase());
  assert.equal(staged.status, 201);
  assert.equal(staged.body.projectId, f.place.id);
  assert.equal(staged.body.uploadId, key);
  assert.equal(staged.body.size, bytes.length);
  assert.equal(staged.body.sha256, digest(bytes));
  assert.deepEqual(await upload(f.writer, f.place.id, bytes, key), staged);
  assert.equal((await upload(f.writer, f.place.id, Buffer.from('different'), key)).body.code, 'UPLOAD_CONFLICT');
  assert.equal((await upload(f.writer, f.place.id, bytes, key, 'another.txt')).status, 409);
  for (const other of [f.owner, f.reader, f.outsider]) assert.equal((await download(other, staged.body.id)).status, 404);
  const response = await download(f.writer, staged.body.id.toUpperCase());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition')!, /^attachment;.*filename\*=UTF-8''/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(await readFile(objectPath(staged.body.id)), bytes);
});

test('empty, oversized, unsafe names, live upload identity and reservation quota are bounded', async () => {
  const f = await scene();
  assert.equal((await upload(f.writer, f.place.id, Buffer.alloc(0))).body.code, 'EMPTY_FILE');
  assert.equal((await upload(f.writer, f.place.id, Buffer.alloc(FILE_LIMITS.fileBytes + 1))).status, 413);
  for (const name of ['../report', '.', '..', '\nreport.txt\t', 'a\\b', 'a\u202eb'])
    assert.equal((await upload(f.writer, f.place.id, Buffer.from('x'), randomUUID(), name)).status, 400);
  const pendingId = randomUUID();
  await db.transaction(async (tx) => {
    const repo = fileRows(tx);
    for (let i = 0; i < 20; i++) await repo.reserve({ id: randomUUID(), workspaceId: f.ws.id, projectId: f.place.id,
      uploader: { kind: 'human', id: f.writer.id }, uploadId: i ? randomUUID() : pendingId, name: 'receiving.txt',
      reservedBytes: FILE_LIMITS.fileBytes, expiresAt: new Date(Date.now() + 60_000) });
  });
  assert.equal((await upload(f.writer, f.place.id, Buffer.from('x'), pendingId)).body.code, 'UPLOAD_IN_PROGRESS');
  assert.equal((await upload(f.writer, f.place.id, Buffer.from('x'))).body.code, 'UPLOAD_QUOTA_EXCEEDED');
});

test('same-UUID recovery works when ready staged files exactly fill the quota', async () => {
  const f = await scene();
  const bytes = Buffer.alloc(FILE_LIMITS.fileBytes, 7);
  let last: StagedFile | undefined;
  for (let i = 0; i < 20; i++) {
    const response = await upload(f.writer, f.place.id, bytes);
    assert.equal(response.status, 201);
    last = response.body;
  }
  assert.equal(await fileRows(db).stagedBytes(f.place.id, { kind: 'human', id: f.writer.id }, new Date()), FILE_LIMITS.stagedBytes);
  const recovered = await upload(f.writer, f.place.id, bytes, last!.uploadId, last!.name);
  assert.equal(recovered.status, 201);
  assert.deepEqual(recovered.body, last);
  assert.equal((await upload(f.writer, f.place.id, Buffer.from('new'))).body.code, 'UPLOAD_QUOTA_EXCEEDED');
});

test('files-only roots, ordinary replies and task replies retain exact order and retry identity', async () => {
  const f = await scene();
  const staged = await upload(f.writer, f.place.id, Buffer.from('first'));
  const command = { body: '', attachmentIds: [staged.body.id], clientMessageId: randomUUID() };
  const started = expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: command }), 201) as Conversation;
  assert.equal(started.messages[0]!.body, '');
  assert.equal(started.firstMessageBody, '1 attached file');
  const readBack = expectStatus(await f.reader.browser.request('GET', `/api/v1/conversations/${started.id}`), 200) as Conversation;
  assert.equal(readBack.firstMessageBody, started.firstMessageBody);
  assert.deepEqual(started.messages[0]!.files, [{ id: staged.body.id, name: staged.body.name, size: 5 }]);
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: command }), 201), started);
  assert.equal((await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: { ...command, clientMessageId: randomUUID() } })).status, 409);
  assert.equal((await download(f.reader, staged.body.id)).status, 200);
  assert.equal((await download(f.outsider, staged.body.id)).status, 404);
  const second = (await upload(f.writer, f.place.id, Buffer.from('reply'))).body;
  const reply = { body: '', attachmentIds: [second.id], clientMessageId: randomUUID() };
  const sent = expectStatus(await f.writer.browser.request('POST', `/api/v1/conversations/${started.id}/messages`, { body: reply }), 201) as ConversationMessage;
  assert.equal(sent.sequence, 2);
  assert.deepEqual(sent.files, [{ id: second.id, name: second.name, size: second.size }]);
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', `/api/v1/conversations/${started.id}/messages`, { body: reply }), 201), sent);
  const task = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.place.id}/work`, { body: { title: 'Files-only first contribution' } }), 201) as WorkItem;
  const third = (await upload(f.writer, f.place.id, Buffer.from('task root'))).body;
  const taskCommand = { body: '', attachmentIds: [third.id], clientMessageId: randomUUID() };
  const root = expectStatus(await f.writer.browser.request('POST', `/api/v1/work/${task.id}/discussion`, { body: taskCommand }), 201) as ConversationMessage;
  const discussion = expectStatus(await f.reader.browser.request('GET', `/api/v1/work/${task.id}/discussion`), 200) as TaskDiscussion;
  assert.deepEqual(discussion.root, root);
  assert.deepEqual(discussion.messages, [root]);
  assert.deepEqual(expectStatus(await f.writer.browser.request('POST', `/api/v1/work/${task.id}/discussion`, { body: taskCommand }), 201), root);
  await grant(f.owner, f.place.id, f.writer, 'denied');
  assert.equal((await download(f.writer, staged.body.id)).status, 404);
  assert.equal((await f.writer.browser.request('POST', `/api/v1/work/${task.id}/discussion`, { body: taskCommand })).status, 404);
});

test('foreign, revoked, missing and same-size corrupt staged bytes cannot create a message', async () => {
  const f = await scene();
  const file = (await upload(f.writer, f.place.id, Buffer.from('data'))).body;
  const send = (who: Person, projectId = f.place.id) => who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, {
    body: { body: '', attachmentIds: [file.id], clientMessageId: randomUUID() },
  });
  assert.equal((await send(f.owner)).status, 404);
  const elsewhere = await project(f.owner, f.ws.id, 'Other files', 'workspace');
  assert.equal((await send(f.writer, elsewhere.id)).status, 404);
  await writeFile(objectPath(file.id), 'oops');
  assert.equal((await send(f.writer)).status, 404);
  assert.equal((await download(f.writer, file.id)).status, 404);
  await rm(objectPath(file.id));
  assert.equal((await send(f.writer)).status, 404);
  await writeFile(objectPath(file.id), 'data');
  await grant(f.owner, f.place.id, f.writer, 'denied');
  assert.equal((await send(f.writer)).status, 404);
  const [row] = await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.id, file.id));
  assert.equal(row!.messageId, null);
});

test('upload and upload retry reauthorize after streaming; an in-flight replay returns no revoked file', async () => {
  const f = await scene();
  const storage = await diskFileStorage(filesDir);
  const bytes = Buffer.from('pause for revocation');
  const original = (await upload(f.writer, f.place.id, bytes)).body;
  let arrived!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const incoming = async function* () { yield bytes; arrived(); await gate; };
  const principal = { kind: 'human' as const, id: f.writer.id };
  const replay = createFileUseCases(fileUnitOfWork(db), storage).stage(principal, f.place.id,
    { uploadId: original.uploadId, name: original.name }, incoming());
  await waiting;
  const reserved = await fileRows(db).stagedBytes(f.place.id, { kind: 'human', id: f.writer.id }, new Date());
  assert.equal(reserved, bytes.length, 'digest-only replay creates no second disk copy');
  assert.equal((await upload(f.writer, f.place.id, bytes, original.uploadId, original.name)).body.code, 'UPLOAD_IN_PROGRESS');
  await grant(f.owner, f.place.id, f.writer, 'denied');
  resume();
  await assert.rejects(replay, NotFoundError);
  assert.equal(await fileRows(db).stagedBytes(f.place.id, { kind: 'human', id: f.writer.id }, new Date()), bytes.length,
    'finished verification releases scratch reservation');
});

test('an expired retired generation cannot create a late object after cleanup consumed its tombstone', async () => {
  const f = await scene();
  const storage = await diskFileStorage(filesDir);
  let resume!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const waiting = new Promise<void>((resolve) => { arrived = resolve; });
  let commits = 0;
  const paused = { ...storage, receive: async (...args: Parameters<typeof storage.receive>) => {
    const received = await storage.receive(...args);
    arrived(); await gate;
    return { ...received, commit: async (id: string) => { commits++; await received.commit(id); } };
  } };
  const key = randomUUID();
  const stage = createFileUseCases(fileUnitOfWork(db), paused).stage({ kind: 'human', id: f.writer.id }, f.place.id,
    { uploadId: key, name: 'late.txt' }, chunks(Buffer.from('late private bytes')));
  const rejected = assert.rejects(stage, (error: unknown) => (error as { code: string }).code === 'UPLOAD_EXPIRED');
  await waiting;
  const row = (await fileRows(db).findUpload(f.place.id, { kind: 'human', id: f.writer.id }, key))!;
  await db.update(schema.projectFiles).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.projectFiles.id, row.id));
  await createFileUseCases(fileUnitOfWork(db), storage).cleanup();
  assert.equal(await fileRows(db).findFile(row.id), null);
  assert.equal((await fileRows(db).pendingGarbage(50)).includes(row.id), false);
  resume(); await rejected;
  assert.equal(commits, 0, 'retired generation never renames its scratch bytes');
  await assert.rejects(readFile(objectPath(row.id)), /ENOENT/);
});

test('a failure after durable rename publishes no ready row and leaves bytes discoverable for cleanup', async () => {
  const f = await scene();
  const storage = await diskFileStorage(filesDir);
  let finalId = '';
  const faulty = { ...storage, receive: async (...args: Parameters<typeof storage.receive>) => {
    const received = await storage.receive(...args);
    return { ...received, commit: async (id: string) => {
      finalId = id; await received.commit(id);
      throw new Error('Simulated directory sync acknowledgement failure');
    } };
  } };
  await assert.rejects(createFileUseCases(fileUnitOfWork(db), faulty).stage({ kind: 'human', id: f.writer.id }, f.place.id,
    { uploadId: randomUUID(), name: 'never-ready.txt' }, chunks(Buffer.from('private durable orphan'))), /acknowledgement failure/);
  assert.equal(await fileRows(db).findFile(finalId), null);
  assert.equal((await fileRows(db).pendingGarbage(50)).includes(finalId), true);
  assert.equal((await download(f.writer, finalId)).status, 404);
  await createFileUseCases(fileUnitOfWork(db), storage).cleanup();
  await assert.rejects(readFile(objectPath(finalId)), /ENOENT/);
});

test('concurrent commands publish one staged file once, while exact concurrent retries publish one message', async () => {
  const f = await scene();
  const path = `/api/v1/projects/${f.place.id}/conversations`;
  const staged = (await upload(f.writer, f.place.id, Buffer.from('race'))).body;
  const results = await Promise.all(Array.from({ length: 2 }, () => f.writer.browser.request('POST', path,
    { body: { body: '', attachmentIds: [staged.id], clientMessageId: randomUUID() } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const other = (await upload(f.writer, f.place.id, Buffer.from('retry race'))).body;
  const command = { body: '', attachmentIds: [other.id], clientMessageId: randomUUID() };
  const replayed = await Promise.all(Array.from({ length: 2 }, () => f.writer.browser.request('POST', path, { body: command })));
  assert.deepEqual(replayed.map((r) => r.status), [201, 201]);
  assert.deepEqual(replayed[0]!.json, replayed[1]!.json);
});

test('lost COMMIT acknowledgement retains durable ready bytes and same-key recovery', async () => {
  const f = await scene();
  const storage = await diskFileStorage(filesDir);
  const actual = fileUnitOfWork(db);
  let calls = 0;
  const uncertain: FileUnitOfWork = { run: async (action) => {
    const value = await actual.run(action);
    if (++calls === 2) throw new Error('Simulated lost COMMIT acknowledgement');
    return value;
  } };
  const bytes = Buffer.from('durable uncertain response');
  const key = randomUUID();
  const principal = { kind: 'human' as const, id: f.writer.id };
  await assert.rejects(createFileUseCases(uncertain, storage).stage(principal, f.place.id, { uploadId: key, name: 'result.txt' }, chunks(bytes)), /acknowledgement/);
  const recovered = await createFileUseCases(actual, storage).stage(principal, f.place.id, { uploadId: key, name: 'result.txt' }, chunks(bytes));
  assert.deepEqual((await createFileUseCases(actual, storage).download(principal, recovered.id)).bytes, bytes);
});

test('expired replacement and failed unlink keep a durable deletion queue; published files survive cleanup', async () => {
  const f = await scene();
  const storage = await diskFileStorage(filesDir);
  const cases = createFileUseCases(fileUnitOfWork(db), storage);
  const expired = (await upload(f.writer, f.place.id, Buffer.from('expired'))).body;
  await db.update(schema.projectFiles).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.projectFiles.id, expired.id));
  const replacement = await upload(f.writer, f.place.id, Buffer.from('replacement'), expired.uploadId);
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.body.id, expired.id);
  assert.equal((await download(f.writer, expired.id)).status, 404);
  const failing = createFileUseCases(fileUnitOfWork(db), { ...storage, remove: async () => { throw new Error('unlink unavailable'); } });
  await failing.cleanup();
  assert.equal((await fileRows(db).pendingGarbage(50)).includes(expired.id), true);
  await cases.cleanup();
  assert.equal((await fileRows(db).pendingGarbage(50)).includes(expired.id), false);
  await assert.rejects(readFile(objectPath(expired.id)), /ENOENT/);
  const command = { body: '', attachmentIds: [replacement.body.id], clientMessageId: randomUUID() };
  expectStatus(await f.writer.browser.request('POST', `/api/v1/projects/${f.place.id}/conversations`, { body: command }), 201);
  await cases.cleanup();
  assert.equal((await download(f.reader, replacement.body.id)).status, 200);
});

test('attachment count and byte bounds roll back publication; bundle exports exact public bytes and relationships', async () => {
  const f = await scene();
  const staged: StagedFile[] = [];
  for (let i = 0; i < 10; i++) staged.push((await upload(f.writer, f.place.id, Buffer.from(`file ${i}`), randomUUID(), `${i}.txt`)).body);
  const ids = staged.map((file) => file.id).reverse();
  const path = `/api/v1/projects/${f.place.id}/conversations`;
  assert.equal((await f.writer.browser.request('POST', path, { body: { body: '', attachmentIds: [...ids, randomUUID()], clientMessageId: randomUUID() } })).status, 400);
  const started = expectStatus(await f.writer.browser.request('POST', path, { body: { body: '', attachmentIds: ids, clientMessageId: randomUUID() } }), 201) as Conversation;
  assert.deepEqual(started.messages[0]!.files!.map((file) => file.id), ids);
  const response = await fetch(new URL(`/api/v1/projects/${f.place.id}/export?format=bundle`, f.owner.browser.base), {
    headers: { cookie: f.owner.browser.cookieHeader() },
  });
  assert.equal(response.status, 200);
  const tar = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const members = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const path = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 12), 8);
    members.set(path.slice(path.indexOf('/') + 1), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (let i = 0; i < staged.length; i++) assert.deepEqual(members.get(`files/${staged[i]!.id}`), Buffer.from(`file ${i}`));
  const manifest = JSON.parse(members.get('manifest.json')!.toString()) as { files: { path: string; bytes: number; sha256: string }[] };
  assert.equal(manifest.files.length, members.size - 1);
  for (const member of manifest.files) {
    assert.equal(members.get(member.path)!.length, member.bytes);
    assert.equal(digest(members.get(member.path)!), member.sha256);
  }
  const controller = new AbortController();
  const storage = await diskFileStorage(filesDir);
  let reads = 0;
  const cancelled = { ...storage, read: async (id: string) => {
    reads++; controller.abort(); return storage.read(id);
  } };
  await assert.rejects(exportUseCases(db, null, cancelled).exportBundle({ kind: 'human', id: f.owner.id }, f.place.id,
    { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, 1, 'cancelled preflight stops before reading the remaining attachments');
  let lateReads = 0;
  const failedStream = { ...storage, read: async (id: string) => ++lateReads > staged.length ? null : storage.read(id) };
  const late = await exportUseCases(db, null, failedStream).exportBundle({ kind: 'human', id: f.owner.id }, f.place.id);
  await assert.rejects(async () => { for await (const chunk of late.content) void chunk; }, NotFoundError);
  const data = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.place.id}/export`), 200) as { files: Array<{ id: string; sha256: string; messageId: string }> };
  assert.equal(data.files.length, 10);
  assert.equal(data.files.find((file) => file.id === staged[0]!.id)!.sha256, digest(Buffer.from('file 0')));
  assert.equal(data.files[0]!.messageId, started.messages[0]!.id);
  assert.equal((await f.reader.browser.request('GET', `/api/v1/projects/${f.place.id}/export`)).status, 403);
  const large: string[] = [];
  for (let i = 0; i < 5; i++) large.push((await upload(f.writer, f.place.id, Buffer.alloc(FILE_LIMITS.fileBytes, i))).body.id);
  assert.equal((await f.writer.browser.request('POST', path, { body: { body: '', attachmentIds: large, clientMessageId: randomUUID() } })).status, 400);
  const rows = await db.select().from(schema.projectFiles).where(and(eq(schema.projectFiles.projectId, f.place.id), sql`${schema.projectFiles.id} IN (${sql.join(large.map((id) => sql`${id}::uuid`), sql`,`)})`));
  assert.equal(rows.every((row) => row.messageId === null), true);
  const atLimit = expectStatus(await f.writer.browser.request('POST', path,
    { body: { body: '', attachmentIds: large.slice(0, 4), clientMessageId: randomUUID() } }), 201) as Conversation;
  assert.equal(atLimit.messages[0]!.files!.reduce((sum, file) => sum + file.size, 0), FILE_LIMITS.messageBytes);
});


test('stalled raw HTTP uploads and ready-UUID verification close the socket after the receive deadline', { timeout: 40_000 }, async () => {
  const f = await scene();
  const ready = (await upload(f.writer, f.place.id, Buffer.from('ready'))).body;
  async function stalled(uploadId: string, name: string) {
    let body = '';
    let status = 0;
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/api/v1/projects/${f.place.id}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, f.writer.browser.base);
      const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': '10',
        cookie: f.writer.browser.cookieHeader(), origin: f.writer.browser.defaultOrigin } }, (response) => {
        status = response.statusCode!;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('error', reject);
      });
      req.on('error', reject);
      req.on('close', resolve);
      req.setTimeout(35_000, () => { req.destroy(); reject(new Error('Server retained the stalled upload socket')); });
      req.write('r'); // Leave Content-Length incomplete; no end, abort or client timeout before the server deadline.
    });
    assert.equal(status, 400);
    assert.equal((JSON.parse(body) as { code: string }).code, 'UPLOAD_TIMEOUT');
  }
  await Promise.all([stalled(randomUUID(), 'stalled.bin'), stalled(ready.uploadId, ready.name)]);
});
