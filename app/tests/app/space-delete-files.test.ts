import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { fileRows, schema } from '@flux/db';
import { createFileUseCases } from '@flux/core';
import { projectPath, type StagedFile } from '@flux/contracts';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { fileUnitOfWork } from '../../apps/server/src/files/adapters.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';
import { db, pool } from './support/db.js';

// Delete space erases what it says it erases (#874, review P1-2): the rows of every file of the space go with it, and the bytes are queued for
// the file cleanup in the same transaction, so the cleanup removes them from the files volume. Without the queue nothing could ever find them.

const filesDir = process.env.FLUX_TEST_FILES_DIR ?? '/data/files';
const objectPath = (id: string) => join(filesDir, 'attachments', 'objects', id.slice(0, 2), id);
const CSV = Buffer.from('date,amount\n2026-11-01,1200.00\n');

async function upload(who: Person, projectId: string, bytes: Uint8Array, name = 'bank-statement.csv') {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: Buffer.from(bytes),
  });
  return { status: response.status, body: await response.json() as StagedFile };
}

test('deleting a space queues the bytes of its files and the file cleanup removes them from disk; another space\'s files stay', async () => {
  const [admin, member] = await Promise.all([person('Files admin'), person('Files member')]);
  const ws = await workspace(admin, 'Delete files');
  await addMember(admin, ws.id, member, 'member');
  const closed = await project(admin, ws.id, 'Closed books', 'restricted');
  const kept = await project(admin, ws.id, 'Kept books', 'restricted');
  const doomed = await upload(admin, closed.id, CSV);
  const staged = await upload(admin, closed.id, Buffer.from('staged bytes'), 'notes.txt');
  const staying = await upload(admin, kept.id, Buffer.from('stays'), 'stays.txt');
  assert.deepEqual([doomed.status, staged.status, staying.status], [201, 201, 201]);
  // One of them is staged to a message, the other is only staged: both are the space's.
  expectStatus(await admin.browser.request('POST', `/api/v1/projects/${closed.id}/conversations`,
    { body: { body: '', attachmentIds: [doomed.body.id], clientMessageId: randomUUID() } }), 201);
  assert.deepEqual(await readFile(objectPath(doomed.body.id)), CSV, 'control: the bytes are on disk');

  expectStatus(await admin.browser.request('DELETE', projectPath(closed.id)), 204);
  assert.equal((await db.select().from(schema.projectFiles).where(eq(schema.projectFiles.projectId, closed.id))).length, 0, 'the rows went with the space');
  const queued = await fileRows(db).pendingGarbage(500);
  assert.ok(queued.includes(doomed.body.id) && queued.includes(staged.body.id), 'every file of the space is queued for cleanup in the same transaction');
  assert.ok(!queued.includes(staying.body.id), 'another space\'s file is not');

  await createFileUseCases(fileUnitOfWork(db), await diskFileStorage(filesDir)).cleanup();
  await assert.rejects(readFile(objectPath(doomed.body.id)), /ENOENT/, 'the staged file\'s bytes are gone');
  await assert.rejects(readFile(objectPath(staged.body.id)), /ENOENT/, 'the staged file\'s bytes are gone');
  assert.deepEqual(await readFile(objectPath(staying.body.id)), Buffer.from('stays'), 'the other space keeps its bytes');
  assert.ok(!(await fileRows(db).pendingGarbage(500)).includes(doomed.body.id), 'the queue is empty of them once they are removed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_garbage WHERE id = ANY($1)', [[doomed.body.id, staged.body.id]])).rows[0].n, 0);
});

test('a sweep removes the whole queue of a deleted space, not one batch of fifty (#908)', async () => {
  // A space with many files queues them all when it is deleted; at fifty a sweep and a sweep every ten minutes it took hours to leave the disk.
  const ids = (await pool.query<{ id: string }>("INSERT INTO file_garbage (id) SELECT gen_random_uuid() FROM generate_series(1, 120) RETURNING id")).rows.map((row) => row.id);
  await createFileUseCases(fileUnitOfWork(db), await diskFileStorage(filesDir)).cleanup();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_garbage WHERE id = ANY($1)', [ids])).rows[0].n, 0, 'one sweep emptied the queue');
});
