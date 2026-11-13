import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { channelsOf, LIVE_STARTED_EVENT } from '@flux/core';
import { NEEDS_YOU_PATH, type NeedsYouResponse } from '@flux/contracts';
import { liveSpaces } from '../../apps/server/src/live/discovery.js';
import { ALONE_LIMIT_MS, liveLifecycle } from '../../apps/server/src/live/lifecycle.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// Calls are noticed (F-041, #1223): a call started in a space tells the space's other people in their Inbox, with Join, while someone is in
// it; push follows the level; it is never emailed. The call glyph of a space and the end of a call nobody joined. (The invitation's chime is #1243's.)

const human = (someone: Person) => ({ kind: 'human' as const, id: someone.id });
const noRoom = async () => {};

async function callNotes(userId: string) {
  return (await pool.query(`SELECT title, body, url, in_inbox FROM notifications WHERE user_id = $1 AND reason = 'call'`, [userId])).rows as
    { title: string; body: string; url: string; in_inbox: boolean }[];
}
async function needsYou(someone: Person) {
  return (expectStatus(await someone.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).items;
}
/** The tab's "(N)" (#1243): at "Everything" an open call's notice counts, a finished one does not. */
async function notifying(someone: Person) {
  return (expectStatus(await someone.browser.request('GET', NEEDS_YOU_PATH), 200) as NeedsYouResponse).notifying;
}

test('a call started in a space reaches its other people in the Inbox with Join, only while someone is in it, and never by email', async () => {
  const nia = await person('Nia Call');
  const ada = await person('Ada Call');
  const outsider = await person('Lee Call');
  const ws = await workspace(nia, 'Call notices');
  await addMember(nia, ws.id, ada, 'member');
  await addMember(nia, ws.id, outsider, 'member');
  const place = await project(nia, ws.id, 'Gesture lamp', 'restricted');
  await grant(nia, place.id, ada, 'contributor');

  const call = await liveSessionStore(db).createOrGet(human(nia), place.id, { type: 'space', id: place.id }, randomUUID(), noRoom);
  const events = await pool.query(`SELECT data, actor_id FROM events WHERE kind = $1 AND object_id = $2`, [LIVE_STARTED_EVENT, place.id]);
  assert.equal(events.rows.length, 1, 'one start, one event');
  assert.deepEqual(events.rows[0].data, { sessionId: call.id }, 'identifiers only');

  const url = `/projects/${place.id}/live/${call.id}`;
  const [note] = await waitFor(async () => { const rows = await callNotes(ada.id); return rows.length ? rows : null; }, 'the call notice');
  assert.deepEqual(note, { title: 'Nia Call started a call in Gesture lamp', body: 'Call in Gesture lamp', url, in_inbox: true });
  assert.deepEqual(await callNotes(nia.id), [], 'the starter is not told of their own call');
  assert.deepEqual(await callNotes(outsider.id), [], 'someone outside the space never hears of it');
  const emails = await pool.query(`SELECT e.id FROM notification_emails e JOIN notifications n ON n.id = e.notification_id WHERE n.reason = 'call'`);
  assert.equal(emails.rows.length, 0, 'a call is never emailed');

  // The Inbox lists it with Join while someone is in the call (the starter's grant clears `empty_since`), and drops it when it is over.
  assert.equal((await needsYou(ada)).find((item) => item.url === url), undefined, 'an empty room asks nothing');
  await pool.query('UPDATE live_sessions SET empty_since = NULL WHERE id = $1', [call.id]);
  const item = (await needsYou(ada)).find((entry) => entry.url === url);
  assert.ok(item, 'the call is in the Inbox');
  assert.equal(await notifying(ada), 0, 'at "Only what needs me" an open call does not count in the tab');
  expectStatus(await ada.browser.request('PATCH', '/api/v1/notification-preferences', { body: { level: 'everything' } }), 200);
  assert.equal(await notifying(ada), 1, 'at "Everything" an open call counts once');
  assert.equal(item.reason, 'call');
  assert.equal(item.title, 'Nia Call started a call in Gesture lamp');
  assert.deepEqual(item.call, { projectId: place.id, sessionId: call.id });
  // The call glyph of the space: for its people, never for someone outside it.
  assert.ok((await liveSpaces(db, human(ada))).projectIds.includes(place.id));
  assert.ok(!(await liveSpaces(db, human(outsider))).projectIds.includes(place.id));
  await pool.query(`UPDATE live_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [call.id]);
  assert.equal((await needsYou(ada)).find((entry) => entry.url === url), undefined, 'an ended call leaves the Inbox');
  assert.equal(await notifying(ada), 0, 'and the tab no longer counts it');
  assert.ok(!(await liveSpaces(db, human(ada))).projectIds.includes(place.id), 'and its space loses the call glyph');
});

test('push for a call follows the level, and a call is never emailed', () => {
  // "Only what needs me" pushes an invitation but not an open call; "Everything" pushes both; neither is ever emailed.
  assert.deepEqual(channelsOf({ level: 'needsYou', emailMe: true }).call, { inApp: true, push: false, email: false });
  assert.deepEqual(channelsOf({ level: 'everything', emailMe: true }).call, { inApp: true, push: true, email: false });
  assert.deepEqual(channelsOf({ level: 'needsYou', emailMe: true }).invitation, { inApp: true, push: true, email: false });
  assert.deepEqual(channelsOf({ level: 'nothing', emailMe: true }).call, { inApp: true, push: false, email: false });

});

test('a call nobody but its starter joins ends after 10 minutes alone; one someone joined keeps going and records who was in it', async () => {
  const nia = await person('Nia Alone');
  const ada = await person('Ada Alone');
  const ws = await workspace(nia, 'Alone calls');
  await addMember(nia, ws.id, ada, 'member');
  const place = await project(nia, ws.id, 'Seed swap', 'restricted');
  await grant(nia, place.id, ada, 'contributor');
  const store = liveSessionStore(db);
  const alone = await store.createOrGet(human(nia), place.id, { type: 'space', id: place.id }, randomUUID(), noRoom);
  // A second call, at a task, that Ada joins.
  const task = expectStatus(await nia.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Sort the seeds' } }), 201) as { id: string };
  const joined = await store.createOrGet(human(nia), place.id, { type: 'work', id: task.id }, randomUUID(), noRoom);

  const created = new Date((await pool.query('SELECT created_at FROM live_sessions WHERE id = $1', [alone.id])).rows[0].created_at);
  let clock = new Date(created.getTime() + 60_000);
  const present: Record<string, string[]> = { [alone.id]: [nia.id], [joined.id]: [nia.id, ada.id] };
  const rooms: Record<string, string> = {
    [(await pool.query('SELECT room_id FROM live_sessions WHERE id = $1', [alone.id])).rows[0].room_id]: alone.id,
    [(await pool.query('SELECT room_id FROM live_sessions WHERE id = $1', [joined.id])).rows[0].room_id]: joined.id,
  };
  const deleted: string[] = [];
  const lifecycle = liveLifecycle(db, pool, {
    async occupancy(roomId) { return present[rooms[roomId]!]!.length; },
    async participants(roomId) { return present[rooms[roomId]!]!.map((userId) => ({ userId, joinedAt: clock.toISOString() })); },
    async deleteRoom(roomId) { deleted.push(roomId); },
  }, () => clock);

  assert.equal(await lifecycle.reconcile(alone.id), 'occupied', 'alone for a minute: still on');
  assert.equal(await lifecycle.reconcile(joined.id), 'occupied');
  // Ada leaves the second call; Nia stays alone in it. Someone joined it once, so it is not a call "nobody joined".
  present[joined.id] = [nia.id];
  clock = new Date(created.getTime() + ALONE_LIMIT_MS + 60_000);
  assert.equal(await lifecycle.reconcile(joined.id), 'occupied', 'a call someone joined keeps going');
  assert.equal(await lifecycle.reconcile(alone.id), 'ended', 'ten minutes with nobody else: it ends');
  const rows = (await pool.query('SELECT id, state, joined_by FROM live_sessions WHERE id = ANY($1)', [[alone.id, joined.id]])).rows as { id: string; state: string; joined_by: string[] }[];
  const by = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(by[alone.id]!.state, 'ended');
  assert.deepEqual(by[alone.id]!.joined_by, [nia.id], 'only its starter was ever in it');
  assert.equal(by[joined.id]!.state, 'available');
  assert.deepEqual(by[joined.id]!.joined_by, [nia.id, ada.id], 'who was in it, first join first');
  assert.equal(deleted.length, 1, 'the lone call\'s room is removed, which disconnects its starter');
});
