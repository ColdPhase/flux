import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { ConversationMessage, Dm, ProjectPerson, PromotedSketch, SearchResponse, Sketch, SketchDetail, SketchPage, SketchPromotionPreview, Workspace } from '@flux/contracts';
import { authorize, createAgent, createSketchUseCases, type Principal, type SketchUnitOfWork } from '@flux/core';
import { sketchPorts } from '../../apps/server/src/sketches/adapters.js';
import { db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, removeMember, workspace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';

// Sketches bound to a direct message over HTTP (issue #96): a foreign key to the DM, an audience
// of exactly its current participants (404 for owners, admins, members, agents and other
// workspaces), "Start sketch from these messages" with provenance, leaving and removal on the
// next request and in the stream, the #107 rule that only the person who left reopens a 1:1, and
// promotion into a project with an exact audience preview and a copy that never syncs.

async function openDm(actor: Person, workspaceId: string, others: Person[], title?: string) {
  const response = await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/dms`, { body: { participantIds: others.map((o) => o.id), ...(title ? { title } : {}) } });
  assert.ok(response.status === 201 || response.status === 200, `open DM: ${response.status} ${response.text}`);
  return response.json as Dm;
}

async function say(actor: Person, dmId: string, body: string) {
  return expectStatus(await actor.browser.request('POST', `/api/v1/dms/${dmId}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201, 'send') as ConversationMessage;
}

function createDmSketch(actor: Person, workspaceId: string, dmId: string, fromMessageIds?: string[], headers: Record<string, string> = {}) {
  return actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`, {
    body: { title: 'Lamp ideas', scope: 'dm', dmId, ...(fromMessageIds ? { fromMessageIds } : {}) }, headers,
  });
}

const get = (actor: Person, sketchId: string) => actor.browser.request('GET', `/api/v1/sketches/${sketchId}`);
const addThought = (actor: Person, sketchId: string, text: string) => actor.browser.request('POST', `/api/v1/sketches/${sketchId}/thoughts`, { body: { text, x: 400, y: 40 } });
const preview = (actor: Person, sketchId: string, query = '') => actor.browser.request('GET', `/api/v1/sketches/${sketchId}/promotion${query}`);
const promote = (actor: Person, sketchId: string, body: unknown, headers: Record<string, string> = {}) => actor.browser.request('POST', `/api/v1/sketches/${sketchId}/promotion`, { body, headers });

async function listIds(actor: Person, workspaceId: string, query = '') {
  const page = expectStatus(await actor.browser.request('GET', `/api/v1/workspaces/${workspaceId}/sketches?limit=100${query}`), 200, 'list') as SketchPage;
  return { ids: new Set(page.items.map((item) => item.id)), total: page.total };
}

async function audience(objectId: string) {
  const result = await pool.query('SELECT DISTINCT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.object_id = $1', [objectId]);
  return new Set(result.rows.map((row) => row.recipient as string));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function search(actor: Person, params: Record<string, string>) {
  return expectStatus(await actor.browser.request('GET', `/api/v1/search?${new URLSearchParams(params)}`), 200, 'search') as SearchResponse;
}

/** Whether a promise has settled yet, without awaiting it. */
function tracked<T>(promise: Promise<T>) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return { promise, settled: () => done };
}

/**
 * The real sketch use cases on the server's own ports, paused once just before the copy is made
 * (after the token was checked against the audience): the point where a concurrent leave or grant
 * change must not slip in unseen.
 */
function pausedPromotion() {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const uow: SketchUnitOfWork = {
    run: (work) => db.transaction((tx) => {
      const ports = sketchPorts(tx);
      let paused = false;
      const stop = async () => { if (!paused) { paused = true; reached(); await gate; } };
      const { createProject } = ports.promotion;
      const { insertSketch } = ports.sketches;
      ports.promotion = { ...ports.promotion, createProject: async (...args) => { await stop(); return createProject(...args); } };
      ports.sketches = { ...ports.sketches, insertSketch: async (sketch) => { await stop(); return insertSketch(sketch); } };
      return work(ports);
    }),
  };
  return { useCases: createSketchUseCases(uow), release, arrived };
}

describe('DM sketches', () => {
  let olga: Person; // workspace owner, in no DM
  let jo: Person; // admin
  let kai: Person; // member
  let lee: Person; // member
  let mo: Person; // member outside the DMs
  let dave: Person; // another workspace
  let ws: Workspace;
  let other: Workspace;
  let pair: Dm;
  let messages: ConversationMessage[];

  before(async () => {
    [olga, jo, kai, lee, mo, dave] = await Promise.all(['dmsk-olga', 'dmsk-jo', 'dmsk-kai', 'dmsk-lee', 'dmsk-mo', 'dmsk-dave'].map(person));
    ws = await workspace(olga, 'Lamp makers');
    other = await workspace(dave, 'Elsewhere');
    await addMember(olga, ws.id, jo, 'admin');
    for (const member of [kai, lee, mo]) await addMember(olga, ws.id, member, 'member');
    pair = await openDm(jo, ws.id, [kai]);
    messages = [];
    messages.push(await say(kai, pair.id, 'Weekend idea: a desk lamp you control with gestures.'));
    messages.push(await say(jo, pair.id, 'Camera and hand tracking? A tiny OpenMV board could run that.'));
    messages.push(await say(kai, pair.id, 'A camera worries me for a bedside lamp. Maybe a ToF distance sensor?'));
    messages.push(await say(jo, pair.id, 'Unrelated: are you coming on Saturday?'));
  });

  test('starting a sketch from selected messages binds it to the DM with provenance; outsiders get 404', async () => {
    const [kaiLive, olgaLive] = await Promise.all([StreamClient.connect(kai.browser), StreamClient.connect(olga.browser)]);
    let sketch: Sketch;
    try {
      await Promise.all([kaiLive.ready(), olgaLive.ready()]);
      // Picked out of order; the thoughts follow the conversation.
      const picked = [messages[2]!.id, messages[0]!.id, messages[1]!.id];
      const key = randomUUID();
      sketch = expectStatus(await createDmSketch(jo, ws.id, pair.id, picked, { 'idempotency-key': key }), 201, 'start from messages') as Sketch;
      assert.equal(sketch.scope, 'dm');
      assert.equal(sketch.dmId, pair.id);
      assert.equal(sketch.projectId, null);
      const replay = await createDmSketch(jo, ws.id, pair.id, picked, { 'idempotency-key': key });
      expectStatus(replay, 201, 'retry');
      assert.equal((replay.json as Sketch).id, sketch.id, 'a retry with the same key returns the same sketch');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM sketches WHERE dm_id = $1', [pair.id])).rows[0].n, 1);

      const detail = expectStatus(await get(kai, sketch.id), 200, 'participant reads') as SketchDetail;
      assert.equal(detail.access, 'write');
      assert.deepEqual(detail.thoughts.map((t) => t.source?.dmMessageId), [messages[0]!.id, messages[1]!.id, messages[2]!.id]);
      assert.deepEqual(detail.thoughts.map((t) => t.text), [messages[0]!.body, messages[1]!.body, messages[2]!.body]);
      assert.equal(detail.thoughts[0]!.source!.author.id, kai.id);
      assert.equal(detail.thoughts[0]!.source!.author.name, 'dmsk-kai');
      assert.equal(detail.thoughts[1]!.source!.sentAt, messages[1]!.createdAt);
      // The binding is a foreign key to the DM, never a copied participant list.
      const row = (await pool.query('SELECT scope, dm_id FROM sketches WHERE id = $1', [sketch.id])).rows[0];
      assert.deepEqual(row, { scope: 'dm', dm_id: pair.id });
      const fks = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'sketches'::regclass AND contype = 'f' AND conname = 'sketches_dm_fk'");
      assert.equal(fks.rowCount, 1);
      assert.equal('participants' in detail, false);

      expectStatus(await addThought(kai, sketch.id, 'Or 60 GHz radar'), 201, 'the other participant writes');
      await kaiLive.event(sketch.id, 'sketch.created.v1');
      const event = await kaiLive.event(sketch.id, 'sketch.changed.v1');
      assert.equal(JSON.stringify(event).includes('radar'), false, 'events carry identifiers, never content');
      assert.deepEqual(await audience(sketch.id), new Set([`human:${jo.id}`, `human:${kai.id}`]), 'the event audience is the participants');
      await pause(800);
      assert.ok(!olgaLive.events.some((e) => e.objectId === sketch.id), 'the owner outside the DM receives nothing');
    } finally {
      await Promise.all([kaiLive.close(), olgaLive.close()]);
    }

    for (const [who, label] of [[olga, 'owner'], [lee, 'member'], [mo, 'member'], [dave, 'other workspace']] as const) {
      const response = await get(who, sketch.id);
      expectStatus(response, 404, `${label} reads`);
      assert.ok(!response.text.includes('Lamp'), 'no title leaks');
      expectStatus(await addThought(who, sketch.id, 'x'), 404, `${label} writes`);
      expectStatus(await preview(who, sketch.id), 404, `${label} previews`);
    }
    expectStatus(await dave.browser.request('GET', `/api/v1/workspaces/${ws.id}/sketches`), 404, 'other workspace lists');
    for (const who of [olga, lee]) {
      const list = await listIds(who, ws.id);
      assert.ok(!list.ids.has(sketch.id), 'not in an outsider’s list');
      assert.equal((await listIds(who, ws.id, `&dmId=${pair.id}`)).total, 0, 'nor its count');
    }
    assert.ok((await listIds(kai, ws.id, `&dmId=${pair.id}`)).ids.has(sketch.id));
    // Agents take no part in DMs: not even the participant's own agent sees the sketch.
    const helper = await createAgent({ kind: 'human', id: jo.id }, ws.id, { name: 'Jo’s helper', owner: 'self' }, db);
    const decision = await authorize({ kind: 'agent', id: helper.id } as Principal, 'sketch.read', { type: 'sketch', id: sketch.id }, db);
    assert.equal(decision.visible, false);

    // Only a participant starts one, only with messages of that DM, only in its workspace.
    expectStatus(await createDmSketch(olga, ws.id, pair.id), 404, 'owner outside the DM');
    expectStatus(await createDmSketch(dave, other.id, pair.id), 404, 'another workspace');
    const group = await openDm(lee, ws.id, [jo, mo], 'Garden');
    const foreign = await say(lee, group.id, 'Not from the lamp DM');
    const wrong = await createDmSketch(jo, ws.id, pair.id, [foreign.id]);
    expectStatus(wrong, 404, 'a message of another DM');
    assert.equal((wrong.json as { code: string }).code, 'MESSAGE_NOT_FOUND');
    const jos = await workspace(jo, 'Jo’s own');
    const cross = await createDmSketch(jo, jos.id, pair.id);
    expectStatus(cross, 422, 'the DM belongs to another workspace');
    assert.equal((cross.json as { code: string }).code, 'CROSS_WORKSPACE');
  });

  test('leaving or removal ends access on the next request and in the stream', async () => {
    const group = await openDm(jo, ws.id, [kai, lee], 'Lamp build');
    const note = await say(lee, group.id, 'I can solder the board');
    const sketch = expectStatus(await createDmSketch(jo, ws.id, group.id, [note.id]), 201) as Sketch;
    expectStatus(await get(lee, sketch.id), 200, 'before leaving');
    const early = await StreamClient.connect(lee.browser);
    const earlyCursor = (await early.ready()).cursor;
    await early.close();
    const [leeLive, kaiLive] = await Promise.all([StreamClient.connect(lee.browser), StreamClient.connect(kai.browser)]);
    try {
      await Promise.all([leeLive.ready(), kaiLive.ready()]);
      expectStatus(await lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204, 'leave');
      const gone = await get(lee, sketch.id);
      expectStatus(gone, 404, 'read after leaving');
      assert.ok(!gone.text.includes('solder'));
      expectStatus(await addThought(lee, sketch.id, 'still here?'), 404, 'write after leaving');
      assert.ok(!(await listIds(lee, ws.id)).ids.has(sketch.id), 'gone from the list');

      expectStatus(await addThought(jo, sketch.id, 'Order the sensor'), 201, 'the remaining people go on');
      await kaiLive.event(sketch.id, 'sketch.changed.v1');
      await pause(1200);
      assert.ok(!leeLive.events.some((e) => e.objectId === sketch.id), 'no frame reaches the person who left');
      const replay = await StreamClient.connect(lee.browser, { cursor: earlyCursor });
      try {
        await replay.ready();
        await pause(500);
        assert.ok(!replay.events.some((e) => e.objectId === sketch.id), 'replay rechecks current access');
      } finally { await replay.close(); }
    } finally {
      await Promise.all([leeLive.close(), kaiLive.close()]);
    }

    // Removal from the workspace cascades to the participant row: 404 at once.
    expectStatus(await get(kai, sketch.id), 200);
    await removeMember(olga, ws.id, kai);
    expectStatus(await get(kai, sketch.id), 404, 'removed from the workspace');
    await addMember(olga, ws.id, kai, 'member');
    expectStatus(await get(kai, sketch.id), 404, 'joining the workspace again does not restore the DM');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sketches WHERE id = $1', [sketch.id])).rows[0].n, 1, 'the sketch stays with the DM');
  });

  test('a 1:1 whose other person left is read-only: nothing is started or copied until they reopen it', async () => {
    const dm = await openDm(lee, ws.id, [mo]);
    const hello = await say(mo, dm.id, 'A shelf that lights up where you left your keys');
    const sketch = expectStatus(await createDmSketch(lee, ws.id, dm.id, [hello.id]), 201) as Sketch;
    expectStatus(await mo.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204);
    const forLee = expectStatus(await get(lee, sketch.id), 200, 'history stays readable') as SketchDetail;
    assert.equal(forLee.access, 'read');
    expectStatus(await addThought(lee, sketch.id, 'alone'), 403, 'no changes for an audience of one');
    const started = await createDmSketch(lee, ws.id, dm.id);
    expectStatus(started, 409, 'no new sketch');
    assert.equal((started.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
    assert.match((started.json as { error: string }).error, /reopen/);
    const previewed = await preview(lee, sketch.id);
    expectStatus(previewed, 409, 'no promotion');
    assert.equal((previewed.json as { code: string }).code, 'DM_RECIPIENT_LEFT');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM dm_participants WHERE dm_id = $1', [dm.id])).rows[0].n, 1, 'nobody was re-added');
    // Only Mo reopens it; then both change it again.
    await openDm(mo, ws.id, [lee]);
    expectStatus(await addThought(lee, sketch.id, 'Back together'), 201, 'open again');
    expectStatus(await addThought(mo, sketch.id, 'Magnets?'), 201);
  });

  test('promotion previews the exact audience, copies only the sketch, and never syncs the DM', async () => {
    const dm = await openDm(jo, ws.id, [lee]);
    const m1 = await say(lee, dm.id, 'Plant pot that tells you when to water');
    const m2 = await say(jo, dm.id, 'Capacitive soil sensor, cheap');
    await say(lee, dm.id, 'Also: dinner Friday?');
    const sketch = expectStatus(await createDmSketch(jo, ws.id, dm.id, [m1.id, m2.id]), 201) as Sketch;
    const detail = expectStatus(await get(jo, sketch.id), 200) as SketchDetail;
    expectStatus(await jo.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: detail.thoughts[0]!.id, toId: detail.thoughts[1]!.id, label: 'how' } }), 201);

    const first = expectStatus(await preview(jo, sketch.id), 200, 'preview') as SketchPromotionPreview;
    assert.deepEqual(first.target, { kind: 'new' }, 'an admin is offered a new project');
    assert.equal(first.canCreateProject, true);
    assert.deepEqual(new Set(first.audience.map((p) => `${p.id}:${p.reason}`)), new Set([`${jo.id}:participant`, `${lee.id}:participant`, `${olga.id}:manager`]));
    assert.deepEqual(first.content, { thoughts: 2, links: 1, fromMessages: 2 });
    assert.deepEqual(first.staysInDm, { messages: 1 });
    assert.deepEqual(first.leftOut, []);

    // A stale preview commits nothing: the other person changed the sketch meanwhile.
    expectStatus(await addThought(lee, sketch.id, 'Self-watering reservoir'), 201);
    const stale = await promote(jo, sketch.id, { target: { kind: 'new', name: 'Smart pot' }, token: first.token });
    expectStatus(stale, 409, 'stale preview');
    assert.equal((stale.json as { code: string }).code, 'PROMOTION_CHANGED');
    const fresh = (stale.json as { preview: SketchPromotionPreview }).preview;
    assert.equal(fresh.content.thoughts, 3);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND name = 'Smart pot'", [ws.id])).rows[0].n, 0, 'no project yet');

    const key = randomUUID();
    const done = expectStatus(await promote(jo, sketch.id, { target: { kind: 'new', name: 'Smart pot' }, token: fresh.token }, { 'idempotency-key': key }), 201, 'promote') as PromotedSketch;
    const again = await promote(jo, sketch.id, { target: { kind: 'new', name: 'Smart pot' }, token: fresh.token }, { 'idempotency-key': key });
    expectStatus(again, 201, 'retry');
    assert.equal((again.json as PromotedSketch).sketch.id, done.sketch.id, 'the retry returns the same copy');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND name = 'Smart pot'", [ws.id])).rows[0].n, 1, 'one project');

    // The preview was exact: the new project's readers are what it named.
    const people = expectStatus(await jo.browser.request('GET', `/api/v1/projects/${done.project.id}/people`), 200) as ProjectPerson[];
    assert.deepEqual(new Set(people.map((p) => p.id)), new Set(fresh.audience.map((p) => p.id)));
    const projectRow = (await pool.query('SELECT visibility FROM projects WHERE id = $1', [done.project.id])).rows[0];
    assert.equal(projectRow.visibility, 'restricted');
    expectStatus(await get(mo, done.sketch.id), 404, 'a member outside the audience');
    expectStatus(await get(kai, done.sketch.id), 404);
    const copy = expectStatus(await get(lee, done.sketch.id), 200, 'the other participant opens the copy') as SketchDetail;
    assert.equal(copy.scope, 'project');
    assert.equal(copy.dmId, null);
    assert.equal(copy.origin?.kind, 'dm_copy');
    assert.equal(copy.thoughts.length, 3);
    assert.equal(copy.links.length, 1);
    assert.ok(copy.thoughts.every((t) => t.source === null || (t.source.dmMessageId === null && t.source.author.name)), 'sources keep author and time, not the DM');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sketch_thoughts WHERE sketch_id = $1 AND (source_dm_id IS NOT NULL OR source_message_id IS NOT NULL)', [done.sketch.id])).rows[0].n, 0);
    assert.ok(!JSON.stringify(copy).includes(dm.id) && !JSON.stringify(copy).includes('dinner'), 'the copy names neither the DM nor its other messages');
    const original = expectStatus(await get(jo, sketch.id), 200) as SketchDetail;
    assert.deepEqual(original.copies.map((c) => c.sketchId), [done.sketch.id]);
    assert.equal(original.copies[0]!.projectName, 'Smart pot');

    // Nothing syncs later: new messages and DM sketch changes stay in the DM.
    await say(lee, dm.id, 'One more idea for the pot');
    expectStatus(await addThought(jo, sketch.id, 'Later thought'), 201);
    const later = expectStatus(await get(lee, done.sketch.id), 200) as SketchDetail;
    assert.equal(later.thoughts.length, 3);
    assert.ok(!later.thoughts.some((t) => t.text === 'Later thought'));

    // Only DM sketches are promoted.
    expectStatus(await preview(jo, done.sketch.id), 422, 'a project sketch');
  });

  test('search finds DM sketches and thoughts under the DM, opens them in the DM, and only for participants', async () => {
    const group = await openDm(jo, ws.id, [kai, lee], 'Aquarium');
    const note = await say(kai, group.id, 'A quokkafish lantern for the tank');
    const sketch = expectStatus(await createDmSketch(jo, ws.id, group.id, [note.id]), 201) as Sketch;
    expectStatus(await jo.browser.request('PATCH', `/api/v1/sketches/${sketch.id}`, { body: { title: 'Quokkafish ideas' }, headers: { 'if-match': '"1"' } }), 200);

    const inDm = await search(kai, { q: 'quokkafish', place: `dm:${group.id}` });
    const kinds = inDm.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ['dm_message', 'sketch', 'thought'], 'the DM place finds its messages, sketches and thoughts');
    for (const item of inDm.items) {
      assert.equal(item.place.type, 'dm');
      assert.equal((item.place as { id: string }).id, group.id);
    }
    const sketchHit = inDm.items.find((item) => item.kind === 'sketch')!;
    assert.deepEqual(sketchHit.target, { type: 'sketch', sketchId: sketch.id, dmId: group.id });
    const thoughtHit = inDm.items.find((item) => item.kind === 'thought')!;
    assert.equal((thoughtHit.target as { dmId: string | null }).dmId, group.id);
    assert.equal((thoughtHit.target as { sketchId: string }).sketchId, sketch.id);

    const everywhere = await search(jo, { q: 'quokkafish' });
    const global = everywhere.items.find((item) => item.kind === 'sketch')!;
    assert.equal(global.place.type, 'dm', 'a global result names its DM, not "private"');
    assert.equal((global.target as { dmId: string | null }).dmId, group.id);
    const privateOnly = await search(jo, { q: 'quokkafish', place: 'private' });
    assert.equal(privateOnly.items.length, 0, 'DM sketches are not the private place');

    // Outsiders find nothing and count nothing; the DM place of another DM finds nothing either.
    for (const who of [olga, mo]) {
      const outside = await search(who, { q: 'quokkafish' });
      assert.equal(outside.items.length, 0);
      assert.deepEqual(outside.counts, {});
      const forced = await search(who, { q: 'quokkafish', place: `dm:${group.id}` });
      assert.equal(forced.items.length, 0);
    }
    assert.equal((await search(jo, { q: 'quokkafish', place: `dm:${pair.id}` })).items.length, 0);

    // Leaving removes them on the very next search.
    expectStatus(await lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204);
    assert.equal((await search(lee, { q: 'quokkafish' })).items.length, 0);
  });

  test('promotion locks its audience: a leave waits for the copy, and a leave before it makes the preview stale', async () => {
    const group = await openDm(jo, ws.id, [kai, lee], 'Race A');
    const idea = await say(kai, group.id, 'Lamp that follows the sun');
    const sketch = expectStatus(await createDmSketch(jo, ws.id, group.id, [idea.id]), 201) as Sketch;

    // 1. Lee leaves while the promotion is between its token check and the copy: the leave waits.
    const seen = expectStatus(await preview(jo, sketch.id, '?target=new'), 200) as SketchPromotionPreview;
    assert.ok(seen.audience.some((p) => p.id === lee.id));
    const paused = pausedPromotion();
    const running = tracked(paused.useCases.promote({ kind: 'human', id: jo.id }, sketch.id, { target: { kind: 'new', name: 'Race A project' }, token: seen.token }));
    await paused.arrived;
    const leaving = tracked(lee.browser.request('POST', `/api/v1/dms/${group.id}/leave`));
    await pause(800);
    assert.equal(leaving.settled(), false, 'the leave waits for the promotion that already counted Lee');
    paused.release();
    const done = await running.promise;
    expectStatus(await leaving.promise, 204, 'the leave then completes');
    const people = expectStatus(await jo.browser.request('GET', `/api/v1/projects/${done.project.id}/people`), 200) as ProjectPerson[];
    assert.deepEqual(new Set(people.map((p) => p.id)), new Set(seen.audience.map((p) => p.id)), 'granted exactly the audience that was checked');

    // 2. Kai leaves after the preview but before the promotion runs: nothing is created.
    const stale = expectStatus(await preview(jo, sketch.id, '?target=new'), 200) as SketchPromotionPreview;
    assert.ok(stale.audience.some((p) => p.id === kai.id));
    expectStatus(await kai.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204);
    const refused = await promote(jo, sketch.id, { target: { kind: 'new', name: 'Race A stale' }, token: stale.token });
    expectStatus(refused, 409, 'stale audience');
    assert.equal((refused.json as { code: string }).code, 'PROMOTION_CHANGED');
    const fresh = (refused.json as { preview: SketchPromotionPreview }).preview;
    assert.ok(!fresh.audience.some((p) => p.id === kai.id), 'the fresh preview no longer names Kai');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE name = 'Race A stale'")).rows[0].n, 0, 'no project');
  });

  test('promotion into an existing project locks its grants: a grant change waits, or makes the preview stale', async () => {
    const group = await openDm(jo, ws.id, [lee, mo], 'Race B');
    const idea = await say(lee, group.id, 'Shelf that glows where the keys are');
    const sketch = expectStatus(await createDmSketch(jo, ws.id, group.id, [idea.id]), 201) as Sketch;
    const bench = await project(olga, ws.id, 'Race bench', 'restricted');
    await grant(olga, bench.id, lee, 'contributor');

    const seen = expectStatus(await preview(jo, sketch.id, `?projectId=${bench.id}`), 200) as SketchPromotionPreview;
    assert.ok(!seen.audience.some((p) => p.id === mo.id));
    const paused = pausedPromotion();
    const running = tracked(paused.useCases.promote({ kind: 'human', id: jo.id }, sketch.id, { target: { kind: 'existing', projectId: bench.id }, token: seen.token }));
    await paused.arrived;
    const granting = tracked(olga.browser.request('POST', `/api/v1/projects/${bench.id}/grants`, { body: { principal: { kind: 'human', id: mo.id }, role: 'contributor' } }));
    await pause(800);
    assert.equal(granting.settled(), false, 'a grant change on the target waits for the promotion');
    paused.release();
    const done = await running.promise;
    assert.equal(done.project.id, bench.id);
    expectStatus(await granting.promise, 201, 'the grant then completes');

    // A grant committed after the preview makes it stale: nothing is copied, a fresh preview comes back.
    const before = (await pool.query('SELECT count(*)::int AS n FROM sketches WHERE copied_from_sketch_id = $1', [sketch.id])).rows[0].n;
    const stale = expectStatus(await preview(jo, sketch.id, `?projectId=${bench.id}`), 200) as SketchPromotionPreview;
    await grant(olga, bench.id, kai, 'viewer');
    const refused = await promote(jo, sketch.id, { target: { kind: 'existing', projectId: bench.id }, token: stale.token });
    expectStatus(refused, 409, 'stale grants');
    assert.equal((refused.json as { code: string }).code, 'PROMOTION_CHANGED');
    assert.ok((refused.json as { preview: SketchPromotionPreview }).preview.audience.some((p) => p.id === kai.id));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sketches WHERE copied_from_sketch_id = $1', [sketch.id])).rows[0].n, before, 'no copy');
  });

  test('a member copies into a project they can change; the preview names who is left out', async () => {
    const dm = await openDm(kai, ws.id, [mo]);
    const idea = await say(mo, dm.id, 'Lamp that dims with the sunset');
    const sketch = expectStatus(await createDmSketch(kai, ws.id, dm.id, [idea.id]), 201) as Sketch;
    const open = await project(olga, ws.id, 'Lighting', 'workspace');
    const closed = await project(olga, ws.id, 'Kai’s bench', 'restricted');
    await grant(olga, closed.id, kai, 'contributor');
    const viewing = await project(olga, ws.id, 'Read only', 'restricted');
    await grant(olga, viewing.id, kai, 'viewer');

    const initial = expectStatus(await preview(kai, sketch.id), 200) as SketchPromotionPreview;
    assert.equal(initial.canCreateProject, false);
    assert.ok(initial.target?.kind === 'existing');
    assert.ok(initial.projects.some((p) => p.id === open.id) && initial.projects.some((p) => p.id === closed.id));
    assert.ok(!initial.projects.some((p) => p.id === viewing.id), 'only projects they can change');
    expectStatus(await preview(kai, sketch.id, '?target=new'), 403, 'members do not create projects');
    expectStatus(await preview(kai, sketch.id, `?projectId=${viewing.id}`), 403, 'a viewer cannot copy in');

    const bench = expectStatus(await preview(kai, sketch.id, `?projectId=${closed.id}`), 200) as SketchPromotionPreview;
    assert.deepEqual(bench.leftOut.map((p) => p.id), [mo.id], 'Mo is not in the restricted project');
    const people = expectStatus(await kai.browser.request('GET', `/api/v1/projects/${closed.id}/people`), 200) as ProjectPerson[];
    assert.deepEqual(new Set(bench.audience.map((p) => p.id)), new Set(people.map((p) => p.id)));

    const lighting = expectStatus(await preview(kai, sketch.id, `?projectId=${open.id}`), 200) as SketchPromotionPreview;
    assert.deepEqual(lighting.leftOut, []);
    const done = expectStatus(await promote(kai, sketch.id, { target: { kind: 'existing', projectId: open.id }, token: lighting.token }), 201) as PromotedSketch;
    assert.equal(done.project.id, open.id);
    expectStatus(await get(lee, done.sketch.id), 200, 'everyone in the workspace-visible project');
    const wrongProject = await promote(kai, sketch.id, { target: { kind: 'existing', projectId: closed.id }, token: lighting.token });
    expectStatus(wrongProject, 409, 'a token names its target');
  });
});
