import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { ConversationMessage, Dm, DmSummary, Page, Workspace } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { authorize, createAgent, type Principal } from '@flux/core';
import { addMember, expectStatus, person, removeMember, workspace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';

// Direct messages over HTTP (issue #107, AC-1..AC-4 and AC-6): the audience is exactly the
// participants (owners and admins outside a DM get 404), one idempotent 1:1 DM per pair, group
// DMs, leaving and workspace removal, #36 message retries, If-Match, Idempotency-Key and
// stream events whose audience is the participants.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());

const dmsOf = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/dms`;

async function openDm(actor: Person, workspaceId: string, others: Person[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await actor.browser.request('POST', dmsOf(workspaceId), { body: { participantIds: others.map((o) => o.id), ...extra }, headers });
  assert.ok(response.status === 201 || response.status === 200, `open DM: ${response.status} ${response.text}`);
  return { dm: response.json as Dm, status: response.status, response };
}

async function say(actor: Person, dmId: string, body: string, clientMessageId: string = randomUUID(), headers: Record<string, string> = {}) {
  return actor.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId }, headers });
}

async function read(actor: Person, dmId: string, query = '') {
  return actor.browser.request('GET', `/api/v1/dms/${dmId}${query}`);
}

async function list(actor: Person, workspaceId: string) {
  return expectStatus(await actor.browser.request('GET', `${dmsOf(workspaceId)}?limit=100`), 200, 'list DMs') as Page<DmSummary>;
}

async function audience(dmId: string) {
  const result = await pool.query('SELECT DISTINCT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.object_id = $1', [dmId]);
  return new Set(result.rows.map((row) => row.recipient as string));
}

describe('direct messages', () => {
  let ada: Person; // workspace owner, never in the DMs below unless named
  let jo: Person; // member
  let kai: Person; // member
  let lee: Person; // member
  let max: Person; // admin
  let gus: Person; // guest
  let dave: Person; // another workspace
  let ws: Workspace;
  let other: Workspace;

  before(async () => {
    [ada, jo, kai, lee, max, gus, dave] = await Promise.all(['dm-ada', 'dm-jo', 'dm-kai', 'dm-lee', 'dm-max', 'dm-gus', 'dm-dave'].map(person));
    ws = await workspace(ada, 'Makers');
    other = await workspace(dave, 'Elsewhere');
    await addMember(ada, ws.id, jo, 'member');
    await addMember(ada, ws.id, kai, 'member');
    await addMember(ada, ws.id, lee, 'member');
    await addMember(ada, ws.id, max, 'admin');
    await addMember(ada, ws.id, gus, 'guest');
  });

  test('one 1:1 DM per pair: repeated and concurrent opens from either side return it', async () => {
    const first = await openDm(jo, ws.id, [kai]);
    assert.equal(first.status, 201);
    assert.equal(first.dm.kind, 'pair');
    assert.equal(first.dm.title, null);
    assert.deepEqual(first.dm.audience, { kind: 'dm', participantIds: first.dm.participants.map((p) => p.id) });
    assert.deepEqual(new Set(first.dm.audience.participantIds), new Set([jo.id, kai.id]));
    assert.deepEqual(first.dm.participants.find((p) => p.id === kai.id)?.name, 'dm-kai');
    assert.equal(first.response.headers.get('etag'), `"${first.dm.version}"`);

    const again = await openDm(jo, ws.id, [kai]);
    assert.equal(again.status, 200, 'an existing pair answers 200');
    assert.equal(again.dm.id, first.dm.id);
    const fromKai = await openDm(kai, ws.id, [jo, kai]);
    assert.equal(fromKai.dm.id, first.dm.id, 'the other side (listing itself too) opens the same DM');

    // Concurrent first opens of a new pair still create exactly one DM.
    const racers = await Promise.all([...Array(6)].map((_, index) => openDm(index % 2 ? lee : kai, ws.id, [index % 2 ? kai : lee])));
    assert.equal(new Set(racers.map((r) => r.dm.id)).size, 1);
    assert.equal(racers.filter((r) => r.status === 201).length, 1);
    const rows = await pool.query('SELECT count(*)::int AS n FROM dms WHERE workspace_id = $1 AND kind = $2 AND pair_key = $3', [ws.id, 'pair', [kai.id, lee.id].sort().join(':')]);
    assert.equal(rows.rows[0].n, 1);

    // Rejected inputs: nobody else, a title on a 1:1, someone outside the workspace, a guest starting one.
    expectStatus(await jo.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [jo.id] } }), 400, 'only oneself');
    expectStatus(await jo.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [kai.id], title: 'Us' } }), 422, 'titled pair');
    const outside = await jo.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [dave.id] } });
    expectStatus(outside, 422, 'non-member');
    assert.equal((outside.json as { code: string }).code, 'DM_PARTICIPANT_UNAVAILABLE');
    expectStatus(await gus.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [jo.id] } }), 403, 'guest starts a DM');
    expectStatus(await dave.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [jo.id] } }), 404, 'another workspace');
  });

  test('only participants see a DM: owners, admins, members and other tenants get 404 and no list entry', async () => {
    const { dm } = await openDm(jo, ws.id, [kai]);
    expectStatus(await say(jo, dm.id, 'Lamp idea: wave to dim?'), 201, 'send');
    expectStatus(await read(kai, dm.id), 200, 'participant reads');
    for (const [who, label] of [[ada, 'owner'], [max, 'admin'], [lee, 'member'], [gus, 'guest'], [dave, 'other tenant']] as const) {
      const denied = await read(who, dm.id);
      expectStatus(denied, 404, `${label} reads`);
      assert.equal((denied.json as { code: string }).code, 'DM_NOT_FOUND');
      assert.ok(!denied.text.includes('Lamp idea'), `${label} gets no content`);
      expectStatus(await say(who, dm.id, 'hello?'), 404, `${label} sends`);
      expectStatus(await who.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 404, `${label} leaves`);
    }
    const adaList = await list(ada, ws.id);
    assert.ok(!adaList.items.some((item) => item.id === dm.id), 'not in the owner’s list');
    const maxList = await list(max, ws.id);
    assert.equal(maxList.total, maxList.items.length, 'counts exclude invisible DMs');
    assert.ok(!maxList.items.some((item) => item.id === dm.id), 'not in the admin’s list');
    expectStatus(await dave.browser.request('GET', dmsOf(ws.id)), 404, 'another workspace lists');
    const kaiList = await list(kai, ws.id);
    const entry = kaiList.items.find((item) => item.id === dm.id);
    assert.ok(entry, 'in the participant’s list');
    assert.equal(entry.lastMessageBody, 'Lamp idea: wave to dim?');
    assert.deepEqual(await audience(dm.id), new Set([`human:${jo.id}`, `human:${kai.id}`]), 'events reach only the participants');

    // Agents are excluded from DMs in this slice, including the participant’s own agent.
    const joPrincipal: Principal = { id: jo.id, kind: 'human' };
    const helper = await createAgent(joPrincipal, ws.id, { name: 'Jo’s helper', owner: 'self' }, db);
    const agent: Principal = { id: helper.id, kind: 'agent' };
    assert.deepEqual(await authorize(agent, 'dm.read', { type: 'dm', id: dm.id }, db), { allowed: false, visible: false });
    assert.equal((await authorize(agent, 'dm.create', { type: 'workspace', id: ws.id }, db)).allowed, false);
    assert.deepEqual(await authorize(joPrincipal, 'dm.write', { type: 'dm', id: dm.id }, db), { allowed: true, visible: true });
    assert.deepEqual(await authorize({ id: ada.id, kind: 'human' }, 'dm.read', { type: 'dm', id: dm.id }, db), { allowed: false, visible: false });
  });

  test('messages keep #36 ordering, clientMessageId retries, Idempotency-Key replays and paging', async () => {
    const { dm } = await openDm(kai, ws.id, [max]);
    const clientMessageId = randomUUID();
    const sent = expectStatus(await say(kai, dm.id, 'Sensor or camera?', clientMessageId), 201) as ConversationMessage;
    assert.equal(sent.sequence, 1);
    assert.equal(sent.conversationId, dm.id);
    assert.equal(sent.source, null);
    const retried = expectStatus(await say(kai, dm.id, 'Sensor or camera?', clientMessageId), 201, 'retry') as ConversationMessage;
    assert.equal(retried.id, sent.id, 'a lost-response retry returns the original message');
    const reused = await say(kai, dm.id, 'Something else', clientMessageId);
    expectStatus(reused, 409, 'same id, other content');
    assert.equal((reused.json as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
    const cited = await kai.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'see this', clientMessageId: randomUUID(), source: { materialId: randomUUID(), version: 1 } } });
    expectStatus(cited, 422, 'material citation');
    assert.equal((cited.json as { code: string }).code, 'DM_SOURCE_UNSUPPORTED');

    const key = randomUUID();
    const keyedClientId = randomUUID();
    const keyed = await say(max, dm.id, 'Sensor, for privacy.', keyedClientId, { 'idempotency-key': key });
    expectStatus(keyed, 201);
    const keyReplay = await say(max, dm.id, 'Sensor, for privacy.', keyedClientId, { 'idempotency-key': key });
    expectStatus(keyReplay, 201, 'key replay');
    assert.equal(keyReplay.headers.get('idempotent-replayed'), 'true');
    assert.equal((keyReplay.json as ConversationMessage).id, (keyed.json as ConversationMessage).id);
    expectStatus(await say(max, dm.id, 'Sensor, for privacy.', randomUUID(), { 'idempotency-key': key }), 422, 'same key, different request');
    const concurrent = await Promise.all([...Array(8)].map((_, index) => say(index % 2 ? kai : max, dm.id, `thought ${index}`)));
    for (const response of concurrent) expectStatus(response, 201);
    const sequences = concurrent.map((response) => (response.json as ConversationMessage).sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, [3, 4, 5, 6, 7, 8, 9, 10], 'concurrent sends get distinct consecutive sequences');

    const count = await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1', [dm.id]);
    assert.equal(count.rows[0].n, 10, 'retries did not duplicate');
    const newest = expectStatus(await read(max, dm.id, '?limit=4'), 200) as Dm;
    assert.deepEqual(newest.messages.map((m) => m.sequence), [7, 8, 9, 10]);
    assert.deepEqual(newest.messagePage, { hasMoreBefore: true, nextBeforeSequence: 7, limit: 4 });
    const older = expectStatus(await read(max, dm.id, '?limit=4&beforeSequence=7'), 200) as Dm;
    assert.deepEqual(older.messages.map((m) => m.sequence), [3, 4, 5, 6]);
    const oldest = expectStatus(await read(max, dm.id, '?limit=4&beforeSequence=3'), 200) as Dm;
    assert.deepEqual(oldest.messages.map((m) => m.body), ['Sensor or camera?', 'Sensor, for privacy.']);
    assert.equal(oldest.messagePage.hasMoreBefore, false);
  });

  test('group DMs: named, renamed with If-Match, readable by exactly their participants', async () => {
    const created = await openDm(jo, ws.id, [kai, lee], { title: 'Lamp prototype' }, { 'idempotency-key': 'group-lamp-1' });
    assert.equal(created.status, 201);
    const group = created.dm;
    assert.equal(group.kind, 'group');
    assert.equal(group.title, 'Lamp prototype');
    assert.equal(group.participants.length, 3);
    const replayed = await openDm(jo, ws.id, [kai, lee], { title: 'Lamp prototype' }, { 'idempotency-key': 'group-lamp-1' });
    assert.equal(replayed.dm.id, group.id, 'a retry with the same key returns the same group');
    assert.equal(replayed.response.headers.get('idempotent-replayed'), 'true');
    const second = await openDm(jo, ws.id, [kai, lee]);
    assert.notEqual(second.dm.id, group.id, 'a new group without a key is a new conversation');

    expectStatus(await say(lee, group.id, 'I can print the housing.'), 201);
    for (const who of [jo, kai, lee]) expectStatus(await read(who, group.id), 200);
    for (const who of [ada, max]) expectStatus(await read(who, group.id), 404);

    const rename = (actor: Person, title: string | null, headers: Record<string, string> = {}) =>
      actor.browser.request('PATCH', `/api/v1/dms/${group.id}`, { body: { title }, headers });
    expectStatus(await rename(kai, 'Lamp v2'), 428, 'rename without a version');
    expectStatus(await rename(ada, 'Lamp v2', { 'if-match': `"${group.version}"` }), 404, 'owner renames');
    const renamed = await rename(kai, 'Lamp v2', { 'if-match': `"${group.version}"` });
    expectStatus(renamed, 200);
    assert.equal((renamed.json as DmSummary).title, 'Lamp v2');
    assert.equal(renamed.headers.get('etag'), `"${group.version + 1}"`);
    const stale = await rename(jo, 'Lamp v3', { 'if-match': `"${group.version}"` });
    expectStatus(stale, 409, 'stale rename');
    assert.equal((stale.json as { currentVersion: number }).currentVersion, group.version + 1);
    const { dm: pair } = await openDm(jo, ws.id, [kai]);
    expectStatus(await jo.browser.request('PATCH', `/api/v1/dms/${pair.id}`, { body: { title: 'x' }, headers: { 'if-match': `"${pair.version}"` } }), 422, 'rename a 1:1');
  });

  test('leaving removes access on the next request and in the stream; old messages stay hidden', async () => {
    const early = await StreamClient.connect(lee.browser);
    const earlyCursor = (await early.ready()).cursor;
    await early.close();
    const { dm: group } = await openDm(kai, ws.id, [jo, lee], { title: 'Garden sensors' });
    expectStatus(await say(lee, group.id, 'Lee’s early note'), 201);
    const [leeLive, joLive] = await Promise.all([StreamClient.connect(lee.browser), StreamClient.connect(jo.browser)]);
    try {
      await Promise.all([leeLive.ready(), joLive.ready()]);
      expectStatus(await lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204, 'leave');
      const gone = await read(lee, group.id);
      expectStatus(gone, 404, 'read after leaving');
      assert.ok(!gone.text.includes('early note'));
      expectStatus(await say(lee, group.id, 'still here?'), 404, 'send after leaving');
      assert.ok(!(await list(lee, ws.id)).items.some((item) => item.id === group.id), 'gone from the list');
      expectStatus(await lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 404, 'leaving twice');

      const forJo = expectStatus(await read(jo, group.id), 200) as Dm;
      assert.deepEqual(new Set(forJo.audience.participantIds), new Set([kai.id, jo.id]), 'the audience shrinks');
      assert.equal(forJo.people.find((p) => p.id === lee.id)?.name, 'dm-lee', 'a former participant’s messages keep their name');

      await joLive.event(group.id, 'dm.changed.v1');
      expectStatus(await say(kai, group.id, 'After Lee left'), 201);
      await joLive.event(group.id, 'dm.message_sent.v1');
      // Nothing about the DM after the leave reaches Lee, live or on replay from an earlier cursor.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.ok(!leeLive.events.some((event) => event.objectId === group.id), 'no DM event reaches the leaver');
      const leeReplay = await StreamClient.connect(lee.browser, { cursor: earlyCursor });
      try {
        await leeReplay.ready();
        assert.ok(!leeReplay.events.some((event) => event.objectId === group.id), 'replay rechecks current access');
      } finally { await leeReplay.close(); }
      assert.ok(!(await audience(group.id)).has(`human:${ada.id}`), 'the owner is never in the audience');
    } finally {
      await Promise.all([leeLive.close(), joLive.close()]);
    }
  });

  test('a 1:1 whose other person left is not reopened for them: 409, nothing sent, until they reopen it', async () => {
    const { dm: pair } = await openDm(lee, ws.id, [max]);
    expectStatus(await say(lee, pair.id, 'Can you check the sensor order?'), 201);
    expectStatus(await max.browser.request('POST', `/api/v1/dms/${pair.id}/leave`), 204);
    const leeView = expectStatus(await read(lee, pair.id), 200) as Dm;
    assert.deepEqual(leeView.audience.participantIds, [lee.id], 'only Lee is left');
    assert.deepEqual(leeView.counterpart, { id: max.id, name: 'dm-max' }, 'the pair still names the other person');
    const eventsBefore = (await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id = $1', [pair.id])).rows[0].n;

    // Lee's "Message Max" does not return a thread or re-add Max.
    const again = await lee.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [max.id] } });
    expectStatus(again, 409, 'open a 1:1 after the other left');
    assert.equal((again.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
    assert.match((again.json as { error: string }).error, /dm-max left this conversation\. They can reopen it by messaging you\./);
    assert.ok(!again.text.includes('sensor order'), 'no thread content in the refusal');
    const sent = await say(lee, pair.id, 'Hello?');
    expectStatus(sent, 409, 'send into a 1:1 whose other person left');
    assert.equal((sent.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
    const rows = await pool.query('SELECT user_id FROM dm_participants WHERE dm_id = $1', [pair.id]);
    assert.deepEqual(rows.rows.map((row) => row.user_id), [lee.id], 'Max was not re-added');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM dm_messages WHERE dm_id = $1', [pair.id])).rows[0].n, 1, 'nothing stored');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id = $1', [pair.id])).rows[0].n, eventsBefore, 'no event with an audience of only Lee');
    expectStatus(await read(max, pair.id), 404, 'Max still sees nothing');

    // Max reopens it himself: both take part again and messages reach both.
    const reopened = await openDm(max, ws.id, [lee]);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.dm.id, pair.id);
    assert.deepEqual(new Set(reopened.dm.audience.participantIds), new Set([lee.id, max.id]));
    const [leeLive, maxLive] = await Promise.all([StreamClient.connect(lee.browser), StreamClient.connect(max.browser)]);
    try {
      await Promise.all([leeLive.ready(), maxLive.ready()]);
      expectStatus(await say(lee, pair.id, 'Welcome back'), 201);
      await Promise.all([leeLive.event(pair.id, 'dm.message_sent.v1'), maxLive.event(pair.id, 'dm.message_sent.v1')]);
    } finally { await Promise.all([leeLive.close(), maxLive.close()]); }
    const last = await pool.query(`SELECT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id
      WHERE e.object_id = $1 AND e.kind = 'dm.message_sent.v1' ORDER BY a.seq DESC LIMIT 2`, [pair.id]);
    assert.deepEqual(new Set(last.rows.map((row) => row.recipient)), new Set([`human:${lee.id}`, `human:${max.id}`]));
  });

  test('removal from the workspace ends DM access at once and is not undone by rejoining', async () => {
    const nia = await person('dm-nia');
    await addMember(ada, ws.id, nia, 'member');
    const { dm } = await openDm(nia, ws.id, [jo]);
    expectStatus(await say(nia, dm.id, 'Nia’s private idea'), 201);
    const niaLive = await StreamClient.connect(nia.browser);
    try {
      await niaLive.ready();
      await removeMember(ada, ws.id, nia);
      expectStatus(await read(nia, dm.id), 404, 'read after removal');
      expectStatus(await say(nia, dm.id, 'hello'), 404, 'send after removal');
      const unavailable = await say(jo, dm.id, 'Are you still there?');
      expectStatus(unavailable, 409, 'send after the other person was removed');
      assert.equal((unavailable.json as { code: string }).code, 'DM_RECIPIENT_UNAVAILABLE');
      const reopenRemoved = await jo.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [nia.id] } });
      expectStatus(reopenRemoved, 409, 'open a 1:1 with a removed person');
      assert.equal((reopenRemoved.json as { code: string }).code, 'DM_RECIPIENT_UNAVAILABLE');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.ok(!niaLive.events.some((event) => event.objectId === dm.id), 'no DM events after removal');
    } finally { await niaLive.close(); }
    const rows = await pool.query('SELECT user_id FROM dm_participants WHERE dm_id = $1', [dm.id]);
    assert.deepEqual(rows.rows.map((row) => row.user_id), [jo.id], 'the participant row went with the membership');
    await addMember(ada, ws.id, nia, 'member');
    expectStatus(await read(nia, dm.id), 404, 'rejoining the workspace does not restore the DM');
    // Back in the workspace, Jo still cannot re-add Nia; Nia reopens it herself.
    const reopenReadded = await jo.browser.request('POST', dmsOf(ws.id), { body: { participantIds: [nia.id] } });
    expectStatus(reopenReadded, 409, 'open a 1:1 with a re-added person who has not reopened it');
    assert.equal((reopenReadded.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
    expectStatus(await say(jo, dm.id, 'Still nobody here'), 409);
    const byNia = await openDm(nia, ws.id, [jo]);
    assert.equal(byNia.dm.id, dm.id);
    assert.deepEqual(new Set(byNia.dm.audience.participantIds), new Set([jo.id, nia.id]));
    expectStatus(await say(jo, dm.id, 'Welcome back, Nia'), 201);
    assert.ok((expectStatus(await read(nia, dm.id), 200) as Dm).messages.some((m) => m.body === 'Welcome back, Nia'));
    // A guest can take part when a member adds them.
    const { dm: withGuest } = await openDm(jo, ws.id, [gus]);
    expectStatus(await say(gus, withGuest.id, 'Guest reply'), 201, 'guest replies in a DM they are in');
    // Another workspace’s people and DMs stay separate.
    expectStatus(await read(dave, withGuest.id), 404);
    assert.equal((await list(dave, other.id)).total, 0);
  });
});
