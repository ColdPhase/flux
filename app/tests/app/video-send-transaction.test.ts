import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { conversationUseCases, type FileStorage, type Principal } from '@flux/core';
import { FILE_LIMITS, type StagedFile, type WorkItem } from '@flux/contracts';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { conversationStore } from '../../apps/server/src/conversation/store.js';
import { taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { connectionString, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// #1411 (audit #1270): sending a message hashed each whole video inside the message's transaction, so a handful of video sends at once
// held every database connection of an API process and other people's requests failed. A message's transaction now reads no byte of its
// files, only their rows and each object's size on disk. This file sends twelve staged videos at once (four people, three spaces each, the
// audit's shape) and a thirteenth to a task's thread, through the real conversation and task adapters on a pool shaped like one API
// process's: 10 connections and the production 1.5 s wait for one. Its file storage is the real disk storage, except that reading bytes
// (`read`, `stream`, `has`) takes 2 s, as hashing a large video does: a send that read bytes inside its transaction would hold its
// connection that long, which is what the counts below would see.

const filesDir = process.env.FLUX_TEST_FILES_DIR ?? '/data/files';
const READ_MS = 2000;
const api = createDatabase(connectionString, 1500, { max: 10 });
after(async () => { await api.pool.end().catch(() => undefined); });

const clip = readFileSync(join(import.meta.dirname, '../ui/fixtures/video', 'clip.mp4'));
/** A video just over the ordinary 5 MiB: the clip's container, then padding. */
function video() {
  const bytes = Buffer.alloc(FILE_LIMITS.fileBytes + 1);
  clip.copy(bytes);
  for (let i = clip.length; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}
const headers = (who: Person) => ({ cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin, 'content-type': 'application/octet-stream' });
async function stage(who: Person, projectId: string, bytes: Uint8Array, name: string) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base),
    { method: 'POST', headers: headers(who), body: Buffer.from(bytes) });
  const body = await response.json() as StagedFile;
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.id;
}
const human = (who: Person): Principal => ({ id: who.id, kind: 'human' });

test('twelve videos sent at once hold no connection while bytes are read; the pool stays free for everyone else', { timeout: 120_000 }, async () => {
  const owner = await person('Video send owner');
  const bystander = await person('Video send bystander');
  const senders = await Promise.all(['A', 'B', 'C', 'D'].map((n) => person(`Video sender ${n}`)));
  const ws = await workspace(owner, 'Video sends');
  for (const p of [bystander, ...senders]) await addMember(owner, ws.id, p, 'member');
  const spaces: string[] = [];
  for (let i = 0; i < 3; i++) spaces.push((await project(owner, ws.id, `Ward ${i}`, 'restricted')).id);
  for (const p of senders) for (const s of spaces) await grant(owner, s, p, 'contributor');
  const bytes = video();
  const staged: { who: Person; space: string; id: string }[] = [];
  for (const who of senders) {
    const ids = await Promise.all(spaces.map((s, i) => stage(who, s, bytes, `ward-${i}.mp4`)));
    ids.forEach((id, i) => staged.push({ who, space: spaces[i]!, id }));
  }
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${spaces[0]}/work`, { body: { title: 'Check the night alarms' } }), 201) as WorkItem;
  const threaded = await stage(senders[0]!, spaces[0]!, bytes, 'alarm.mp4');

  const disk = await diskFileStorage(filesDir);
  const reads: string[] = [];
  const slow = <T>(name: string, run: () => Promise<T>) => async () => { reads.push(name); await new Promise((r) => setTimeout(r, READ_MS)); return run(); };
  const storage: FileStorage = { ...disk,
    read: (id) => slow('read', () => disk.read(id))(),
    stream: (id, range) => slow('stream', () => disk.stream(id, range))(),
    has: (id, size, sha256) => slow('has', () => disk.has(id, size, sha256))() };
  const conversations = conversationUseCases(conversationStore(api.db, { storage }));
  const discussion = taskDiscussionUseCases(api.db, storage);

  // Another person's requests on the same process: one short query after another, each needing a connection of the same pool.
  const errors: string[] = [];
  let probing = true;
  let probes = 0;
  const probe = (async () => {
    while (probing) {
      try { await api.pool.query('SELECT 1'); probes++; } catch (error) { errors.push((error as Error).message); }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  // Connections that have been idle inside a transaction for half a second: a send waiting on the disk, not on its next statement.
  const watcher = await pool.connect();
  let watching = true;
  let longest = 0;
  const watch = (async () => {
    while (watching) {
      const { rows } = await watcher.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
        AND state = 'idle in transaction' AND now() - state_change > interval '500 milliseconds'`);
      longest = Math.max(longest, rows[0]!.n);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  const started = performance.now();
  const sends = await Promise.allSettled([
    ...staged.map(({ who, space, id }, i) => conversations.createConversation(human(who), space, { body: `Clip ${i}`, attachmentIds: [id], clientMessageId: randomUUID() })),
    discussion.contribute(human(senders[0]!), task.id, { body: 'The alarm at 3:10', attachmentIds: [threaded], clientMessageId: randomUUID() }),
  ]);
  const seconds = Math.round(performance.now() - started) / 1000;
  probing = false; watching = false;
  await Promise.all([probe, watch]);
  watcher.release();
  const failed = sends.flatMap((s) => s.status === 'rejected' ? [(s.reason as Error).message] : []);
  console.log(`#1411 thirteen video sends: ${seconds}s, failed ${failed.length}, byte reads ${reads.length}, connections idle in a transaction over 500 ms: ${longest}, other requests ${probes} ok / ${errors.length} failed`);

  assert.deepEqual(reads, [], 'a send reads no byte of its files inside its transaction');
  assert.deepEqual(failed, [], 'every send is accepted');
  assert.deepEqual(errors, [], 'other requests always find a connection');
  assert.equal(longest, 0, 'no transaction waits on a file');
  // The videos went with their messages: each one is now published, exactly once.
  const published = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM project_files WHERE id = ANY($1::uuid[]) AND message_id IS NOT NULL',
    [[...staged.map((s) => s.id), threaded]])).rows[0]!.n;
  assert.equal(published, 13);
});
