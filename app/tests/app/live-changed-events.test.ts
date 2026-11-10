import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Conversation } from '@flux/contracts';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { liveLifecycle } from '../../apps/server/src/live/lifecycle.js';
import { LIVE_CHANGED_EVENT } from '../../apps/server/src/live/events.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

const noRoom = async () => undefined;

/** The space's `project.live_changed.v1` events, oldest first, with who each was stored for. */
async function changes(projectId: string) {
  const rows = await pool.query<{ id: string; object_id: string; actor_id: string; data: { sessionId?: string }; recipients: string[] }>(`
    SELECT e.id, e.object_id, e.actor_id, e.data, array_agg(a.recipient ORDER BY a.recipient) AS recipients
      FROM events e JOIN event_audience a ON a.event_id = e.id
     WHERE e.kind = $1 AND e.object_id = $2 GROUP BY e.id, e.seq ORDER BY e.seq`, [LIVE_CHANGED_EVENT, projectId]);
  return rows.rows;
}

test('#1175: a call starting, someone joining or leaving it and its end tell the people of the space, and nobody else', async () => {
  const owner = await person('live-changed-owner');
  const nia = await person('live-changed-nia');
  const outsider = await person('live-changed-outsider');
  const ws = await workspace(owner, 'Live changed');
  await addMember(owner, ws.id, nia, 'member');
  await addMember(owner, ws.id, outsider, 'member');
  const place = await project(owner, ws.id, 'Rain barrels', 'restricted');
  await grant(owner, place.id, nia, 'contributor');
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: 'Which barrel overflows first?', clientMessageId: randomUUID() },
  }), 201) as Conversation;
  const store = liveSessionStore(db);
  const clientSessionId = randomUUID();
  const started = await store.createOrGet({ kind: 'human', id: nia.id }, place.id, { type: 'conversation', id: thread.id }, clientSessionId, noRoom);

  const people = [`human:${nia.id}`, `human:${owner.id}`].sort();
  let rows = await changes(place.id);
  assert.equal(rows.length, 1, 'a start is one event');
  assert.deepEqual(rows[0]!.recipients, people, 'for the people who can read the space: not the company member outside it');
  assert.equal(rows[0]!.actor_id, `human:${nia.id}`);
  assert.deepEqual(rows[0]!.data, { sessionId: started.id }, 'identifiers only');

  // A repeated start of the same call (the same client key) records nothing.
  await store.createOrGet({ kind: 'human', id: nia.id }, place.id, { type: 'conversation', id: thread.id }, clientSessionId, noRoom);
  assert.equal((await changes(place.id)).length, 1);

  let occupancy = 1;
  let clock = new Date();
  const lifecycle = liveLifecycle(db, pool, { async occupancy() { return occupancy; }, async deleteRoom() {} }, () => clock);
  // The timer's sweep keeps the lifecycle and tells nobody.
  assert.equal(await lifecycle.reconcile(started.id), 'occupied');
  assert.equal((await changes(place.id)).length, 1);
  // The SFU said someone joined (a webhook): the space reads who is in the call.
  assert.equal(await lifecycle.reconcile(started.id, started.generation, { announce: true }), 'occupied');
  // ... and that they left.
  occupancy = 0;
  assert.equal(await lifecycle.reconcile(started.id, started.generation, { announce: true }), 'empty');
  rows = await changes(place.id);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.deepEqual(row.recipients, people);
  // A stale generation's hint announces nothing.
  assert.equal(await lifecycle.reconcile(started.id, started.generation + 1, { announce: true }), 'stale');
  assert.equal((await changes(place.id)).length, 3);

  // The empty call ends after its grace: Join leaves the space's open tabs.
  clock = new Date(clock.getTime() + 91_000);
  assert.equal(await lifecycle.reconcile(started.id), 'ended');
  rows = await changes(place.id);
  assert.equal(rows.length, 4, 'the end is one event');
  assert.deepEqual(rows[3]!.recipients, people);
  assert.equal(rows[3]!.actor_id, `human:${nia.id}`, 'the call\'s starter stands for the server');
  assert.deepEqual(rows[3]!.data, { sessionId: started.id });
});
