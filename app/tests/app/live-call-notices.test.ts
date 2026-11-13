import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
  // Who started it and where, like every other kind; its words are the call's place (#1424). The notification keeps its sentence.
  assert.deepEqual([item.title, item.detail, item.from?.id, item.from?.name, item.project], ['Call in Gesture lamp', '', nia.id, 'Nia Call', { id: place.id, name: 'Gesture lamp' }]);
  assert.deepEqual(item.call, { projectId: place.id, sessionId: call.id });
  // The call glyph of the space: for its people, never for someone outside it.
  assert.ok((await liveSpaces(db, human(ada))).projectIds.includes(place.id));
  assert.ok(!(await liveSpaces(db, human(outsider))).projectIds.includes(place.id));
  await pool.query(`UPDATE live_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [call.id]);
  assert.equal((await needsYou(ada)).find((entry) => entry.url === url), undefined, 'an ended call leaves the Inbox');
  assert.equal(await notifying(ada), 0, 'and the tab no longer counts it');
  assert.ok(!(await liveSpaces(db, human(ada))).projectIds.includes(place.id), 'and its space loses the call glyph');
});

test('joining a call answers its notice and an invitation to it, and nobody else\'s', async () => {
  const nia = await person('Nia Join');
  const ada = await person('Ada Join');
  const lee = await person('Lee Join');
  const ws = await workspace(nia, 'Join notices');
  await addMember(nia, ws.id, ada, 'member');
  await addMember(nia, ws.id, lee, 'member');
  const place = await project(nia, ws.id, 'Rain barrel', 'restricted');
  await grant(nia, place.id, ada, 'contributor');
  await grant(nia, place.id, lee, 'contributor');
  const store = liveSessionStore(db);
  const call = await store.createOrGet(human(nia), place.id, { type: 'space', id: place.id }, randomUUID(), noRoom);
  await pool.query('UPDATE live_sessions SET empty_since = NULL WHERE id = $1', [call.id]);
  const url = `/projects/${place.id}/live/${call.id}`;
  await waitFor(async () => { const rows = await callNotes(ada.id); return rows.length ? rows : null; }, 'the call notice');
  await waitFor(async () => { const rows = await callNotes(lee.id); return rows.length ? rows : null; }, 'the call notice of the other person');
  // An invitation to the same call (the worker writes it from the invitation; the row is what the queue reads).
  await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, in_inbox, ai_origin)
    VALUES ($1, $2, $3, 'project', $4, 'Nia Join invited you to a call', 'Call in Rain barrel', $5, 'invitation', true, false)`,
  [randomUUID(), ada.id, ws.id, place.id, `${url}?invitation=${randomUUID()}`]);
  assert.ok((await needsYou(ada)).some((item) => item.call?.sessionId === call.id), 'the call asks something of Ada');
  assert.ok((await needsYou(lee)).some((item) => item.call?.sessionId === call.id), 'and of Lee');

  await store.withAdmission(human(ada), call.id, async () => 'grant issued', { id: randomBytes(16).toString('base64url'), authSessionId: 'join-test' });
  assert.equal((await needsYou(ada)).filter((item) => item.call).length, 0, 'Ada joined: neither the notice nor the invitation asks anything of her');
  const read = (await pool.query(`SELECT reason, read_at FROM notifications WHERE user_id = $1 AND reason IN ('call', 'invitation')`, [ada.id])).rows as { reason: string; read_at: Date | null }[];
  assert.deepEqual(read.map((row) => row.reason).sort(), ['call', 'invitation']);
  assert.ok(read.every((row) => row.read_at), 'both are read');
  assert.ok((await needsYou(lee)).some((item) => item.call?.sessionId === call.id), 'Lee has not joined: it still asks him');
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

test('a call started again about the same place within 5 minutes tells nobody a second time; another starter, or a later start, does (#1347)', async () => {
  const nia = await person('Nia Repeat');
  const ada = await person('Ada Repeat');
  const ws = await workspace(nia, 'Repeated calls');
  await addMember(nia, ws.id, ada, 'member');
  const place = await project(nia, ws.id, 'Repeat lamp', 'workspace');
  const space = { type: 'space' as const, id: place.id };
  const store = liveSessionStore(db);
  const notices = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = $1 AND object_id = $2`, [LIVE_STARTED_EVENT, place.id])).rows[0].n);
  const changes = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM events WHERE kind = 'project.live_changed.v1' AND object_id = $1`, [place.id])).rows[0].n);
  const end = (id: string) => pool.query(`UPDATE live_sessions SET state = 'ended', ended_at = now() WHERE id = $1`, [id]);

  const first = await store.createOrGet(human(nia), place.id, space, randomUUID(), noRoom);
  assert.equal(await notices(), 1);
  // The worker tells Ada while the call is on (a notice of a call that is already over is never made).
  await waitFor(async () => ((await callNotes(ada.id)).length ? true : null), 'the one notice');
  // The call ends and Nia starts it again, over and over: the call starts each time and its Join shows (a change event each time), nobody is told again.
  await end(first.id);
  const second = await store.createOrGet(human(nia), place.id, space, randomUUID(), noRoom);
  await end(second.id);
  const third = await store.createOrGet(human(nia), place.id, space, randomUUID(), noRoom);
  assert.deepEqual([second.state, third.state], ['available', 'available']);
  assert.equal(await notices(), 1, 'one notice for the three starts');
  assert.equal(await changes(), 3, 'but the space\'s tabs learn of each call');
  assert.equal((await callNotes(ada.id)).length, 1, 'Ada has the one');
  // Another person starting a call about the same place is told as ever: the pause is the starter's own.
  const others = await store.createOrGet(human(ada), place.id, space, randomUUID(), noRoom);
  assert.equal(await notices(), 2);
  await end(third.id); await end(others.id);
  // Later than the pause, Nia's next call tells the space again.
  await pool.query(`UPDATE events SET created_at = now() - interval '6 minutes' WHERE kind = $1 AND object_id = $2 AND actor_id = $3`, [LIVE_STARTED_EVENT, place.id, `human:${nia.id}`]);
  await store.createOrGet(human(nia), place.id, space, randomUUID(), noRoom);
  assert.equal(await notices(), 3, 'after 5 minutes it is told again');
});
