import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DomainError, type LiveMedia } from '@flux/core';
import { listCallLines } from '../../apps/server/src/live/discovery.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// A call is one line in the conversation it started from (F-041 point 6): the space's calls in its conversation, a task's calls in its
// discussion; a call at a map or a page has none. Identifiers and times only, and never for someone who cannot read the space.

const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });
const missing = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('the space conversation lists its calls as lines: running with who is in it, ended with who was, or nobody joined', async () => {
  const nia = await person('Nia Line');
  const ada = await person('Ada Line');
  const lee = await person('Lee Line');
  const ws = await workspace(nia, 'Call lines');
  await addMember(nia, ws.id, ada, 'member');
  await addMember(nia, ws.id, lee, 'member');
  const place = await project(nia, ws.id, 'Tool library', 'restricted');
  await grant(nia, place.id, ada, 'contributor');
  const store = liveSessionStore(db);
  const noRoom = async () => {};
  const ended = await store.createOrGet(human(nia), place.id, { type: 'space', id: place.id }, randomUUID(), noRoom);
  await pool.query(`UPDATE live_sessions SET state = 'ended', joined_by = $2, created_at = now() - interval '20 minutes', ended_at = now() - interval '8 minutes' WHERE id = $1`,
    [ended.id, [nia.id, ada.id]]);
  const lonely = await store.createOrGet(human(ada), place.id, { type: 'space', id: place.id }, randomUUID(), noRoom);
  await pool.query(`UPDATE live_sessions SET state = 'ended', joined_by = $2, created_at = now() - interval '6 minutes', ended_at = now() - interval '1 minute' WHERE id = $1`,
    [lonely.id, [ada.id]]);
  const running = await store.createOrGet(human(nia), place.id, { type: 'space', id: place.id }, randomUUID(), noRoom);
  const task = expectStatus(await nia.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Fix the drill' } }), 201) as { id: string };
  const atTask = await store.createOrGet(human(nia), place.id, { type: 'work', id: task.id }, randomUUID(), noRoom);
  const doc = expectStatus(await nia.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Loan rules', body: 'Two weeks.' },
    headers: { 'idempotency-key': randomUUID() } }), 201) as { id: string };
  await store.createOrGet(human(ada), place.id, { type: 'doc', id: doc.id }, randomUUID(), noRoom);

  const room = (await pool.query('SELECT room_id FROM live_sessions WHERE id = $1', [running.id])).rows[0].room_id as string;
  const media: Pick<LiveMedia, 'participants'> = {
    async participants(roomId) {
      if (roomId === room) return [{ userId: nia.id, joinedAt: new Date().toISOString() }, { userId: ada.id, joinedAt: new Date().toISOString() }];
      throw new Error('SFU is unavailable');
    },
  };
  const lines = (await listCallLines(db, media, human(ada), place.id, null)).items;
  assert.deepEqual(lines.map((line) => line.id), [ended.id, lonely.id, running.id], 'the space\'s calls, oldest first: not the task\'s or the page\'s');
  assert.deepEqual(lines[0]!.joinedBy, [nia.id, ada.id]);
  assert.ok(lines[0]!.endedAt && Date.parse(lines[0]!.endedAt) - Date.parse(lines[0]!.startedAt) >= 11 * 60_000, 'it lasted twelve minutes');
  assert.equal(lines[0]!.inCall, null, 'an ended call has nobody in it now');
  assert.deepEqual(lines[1]!.joinedBy, [ada.id], 'nobody joined Ada');
  assert.equal(lines[2]!.endedAt, null);
  assert.deepEqual(lines[2]!.inCall, [nia.id, ada.id], 'who is in the running call');
  assert.deepEqual(lines[2]!.context, { type: 'space', id: place.id });
  assert.ok(!JSON.stringify(lines).includes(room), 'no room identifier');

  const taskLines = (await listCallLines(db, media, human(ada), place.id, task.id)).items;
  assert.deepEqual(taskLines.map((line) => line.id), [atTask.id], 'a task\'s discussion has the calls started from it');
  assert.equal(taskLines[0]!.inCall, null, 'an unreadable presence is unknown, never empty');

  await assert.rejects(listCallLines(db, media, human(lee), place.id, null), missing('PROJECT_NOT_FOUND'), 'never for someone outside the space');
  await assert.rejects(listCallLines(db, media, human(ada), place.id, randomUUID()), missing('LIVE_CONTEXT_NOT_FOUND'));
});
