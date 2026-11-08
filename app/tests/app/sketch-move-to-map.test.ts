import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { CreatedThought, MovedToMap, PositionsConflict, Project, Sketch, SketchDetail, SketchPage, ThoughtLink, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';

// Moving thoughts from one map to another (#948): My map's "Move to a space map", and the Undo that brings them back. The caller needs
// to change both maps; a thought becomes a new thought on the target (a map keeps every id it has held) and the original goes in the same
// change; connections between moved thoughts move with them and the others stay behind.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const move = (from: string) => `/api/v1/sketches/${from}/move-to-map`;

async function createSketch(actor: Person, workspaceId: string, body: Record<string, unknown>) {
  return expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`, { body }), 201, 'create sketch') as Sketch;
}
async function addThought(actor: Person, sketchId: string, body: Record<string, unknown>) {
  return (expectStatus(await actor.browser.request('POST', `/api/v1/sketches/${sketchId}/thoughts`, { body }), 201, 'add thought') as CreatedThought).thought;
}
async function link(actor: Person, sketchId: string, fromId: string, toId: string, label: string | null = null) {
  return expectStatus(await actor.browser.request('POST', `/api/v1/sketches/${sketchId}/links`, { body: { fromId, toId, label } }), 201, 'add link') as ThoughtLink;
}
async function ownMap(actor: Person, workspaceId: string) {
  const listed = expectStatus(await actor.browser.request('GET', `/api/v1/workspaces/${workspaceId}/sketches?scope=private&limit=100`), 200) as SketchPage;
  return listed.items[0] ?? await createSketch(actor, workspaceId, { title: 'My map', scope: 'private' });
}
const detail = async (actor: Person, sketchId: string) => expectStatus(await actor.browser.request('GET', `/api/v1/sketches/${sketchId}`), 200, 'get sketch') as SketchDetail;

describe('moving thoughts to another map (#948)', () => {
  let ada: Person;
  let ben: Person;
  let cleo: Person;
  let dave: Person;
  let ws: Workspace;
  let elsewhere: Workspace;
  let garden: Project;
  let hidden: Project;

  before(async () => {
    [ada, ben, cleo, dave] = await Promise.all(['move-ada', 'move-ben', 'move-cleo', 'move-dave'].map(person));
    ws = await workspace(ada, 'Moving thoughts');
    elsewhere = await workspace(dave, 'Moving elsewhere');
    await addMember(ada, ws.id, ben, 'member');
    await addMember(ada, ws.id, cleo, 'member');
    garden = await project(ada, ws.id, 'Garden', 'restricted');
    hidden = await project(ada, ws.id, 'Not for everyone', 'restricted');
    await grant(ada, garden.id, ben, 'contributor');
    await grant(ada, hidden.id, ben, 'contributor');
  });

  test('thoughts move from My map to a space map as new thoughts with the same words, shape and size; a connection between them goes along, the others stay behind', async () => {
    const mine = await ownMap(ada, ws.id);
    const space = await createSketch(ada, ws.id, { title: 'Garden ideas', scope: 'project', projectId: garden.id });
    const existing = await addThought(ada, space.id, { text: 'Already on the space map', x: 50, y: 300 });
    const a = await addThought(ada, mine.id, { text: 'Rain sensor on the shed roof?', x: 120, y: 40, shape: 'pill', width: 220, height: 90 });
    const b = await addThought(ada, mine.id, { text: 'Solar panel for the gateway?', x: 420, y: 140 });
    const c = await addThought(ada, mine.id, { text: 'Bulb planting day', x: 700, y: 400 });
    const ab = await link(ada, mine.id, a.id, b.id, 'powers');
    const bc = await link(ada, mine.id, b.id, c.id);

    const moved = expectStatus(await ada.browser.request('POST', move(mine.id), {
      body: { toSketchId: space.id, thoughts: [{ id: a.id, expectedVersion: a.version }, { id: b.id, expectedVersion: b.version }] },
    }), 200, 'move') as MovedToMap;
    assert.equal(moved.fromSketchId, mine.id);
    assert.equal(moved.toSketchId, space.id);
    assert.deepEqual(moved.origin, { x: 120, y: 40 });
    assert.deepEqual(moved.moved.map((item) => item.from), [a.id, b.id]);
    const [a2, b2] = moved.moved.map((item) => item.thought);
    for (const [before, after] of [[a, a2], [b, b2]] as const) {
      assert.notEqual(after!.id, before.id, 'a map keeps every id it has held, so the thought has a new one');
      assert.equal(after!.sketchId, space.id);
      assert.equal(after!.text, before.text);
      assert.equal(after!.shape, before.shape);
      assert.equal(after!.width, before.width);
      assert.equal(after!.height, before.height);
      assert.equal(after!.version, 1);
    }
    // The group keeps its shape and lands under what is on the target, at its left edge.
    assert.equal(a2!.x, existing.x);
    assert.ok(a2!.y >= existing.y + existing.height, `under the thought that was there: ${a2!.y}`);
    assert.equal(b2!.x - a2!.x, b.x - a.x);
    assert.equal(b2!.y - a2!.y, b.y - a.y);
    // The connection between the two goes along, with its label; the one to the thought that stays is left behind and named.
    assert.equal(moved.links.length, 1);
    assert.deepEqual([moved.links[0]!.fromId, moved.links[0]!.toId, moved.links[0]!.label], [a2!.id, b2!.id, 'powers']);
    assert.notEqual(moved.links[0]!.id, ab.id);
    assert.deepEqual(moved.severed.map((item) => item.id).sort(), [bc.id].sort());

    const left = await detail(ada, mine.id);
    assert.deepEqual(left.thoughts.map((thought) => thought.id), [c.id], 'the originals are gone from My map');
    assert.deepEqual(left.links, [], 'with every connection of theirs');
    const arrived = await detail(ada, space.id);
    assert.deepEqual(arrived.thoughts.map((thought) => thought.id).sort(), [existing.id, a2!.id, b2!.id].sort());
    assert.equal(arrived.links.length, 1);
    assert.equal(arrived.thoughts.find((thought) => thought.id === a2!.id)!.createdBy.id, ada.id);

    // Both maps record an event for it, naming ids and never words.
    const named = async (sketchId: string, thoughtId: string) => (await pool.query(
      "SELECT data FROM events WHERE kind = 'sketch.changed.v1' AND object_id = $1 AND data->'thoughtIds' @> to_jsonb($2::text)", [sketchId, thoughtId])).rows.map((row) => row.data as { op: string });
    assert.deepEqual((await named(mine.id, a.id)).map((data) => data.op).sort(), ['link_added', 'thought_added', 'thought_removed'], 'My map: the thought was added and connected, then removed');
    assert.deepEqual((await named(space.id, a2!.id)).map((data) => data.op), ['thought_added']);
    assert.equal(JSON.stringify(await named(space.id, a2!.id)).includes('Rain sensor'), false, 'events carry identifiers, never words');

    // Undo: the same move back, to where the group was. The connection to the thought that stayed is made again by the caller.
    const back = expectStatus(await ada.browser.request('POST', move(space.id), {
      body: { toSketchId: mine.id, thoughts: moved.moved.map((item) => ({ id: item.thought.id, expectedVersion: item.thought.version })), at: moved.origin },
    }), 200, 'undo') as MovedToMap;
    const [a3, b3] = back.moved.map((item) => item.thought);
    assert.deepEqual([a3!.x, a3!.y, b3!.x, b3!.y], [a.x, a.y, b.x, b.y], 'back where they were');
    assert.equal(back.links.length, 1);
    const restored = await link(ada, mine.id, b3!.id, c.id);
    assert.equal(restored.toId, c.id);
    assert.deepEqual((await detail(ada, space.id)).thoughts.map((thought) => thought.id), [existing.id], 'and gone from the space map');
    assert.equal((await detail(ada, mine.id)).links.length, 2);
  });

  test('a moved group with nothing on the target stays where it was; a stale version moves nothing', async () => {
    const mine = await ownMap(ada, ws.id);
    const empty = await createSketch(ada, ws.id, { title: 'Empty map', scope: 'project', projectId: garden.id });
    const t = await addThought(ada, mine.id, { text: 'A thought that will change', x: 10, y: 20 });
    const stale = expectStatus(await ada.browser.request('PATCH', `/api/v1/sketches/${mine.id}/positions`, { body: { moves: [{ id: t.id, x: 11, y: 21, expectedVersion: t.version }] } }), 200);
    assert.ok(stale);
    const conflict = expectStatus(await ada.browser.request('POST', move(mine.id), { body: { toSketchId: empty.id, thoughts: [{ id: t.id, expectedVersion: t.version }] } }), 409) as PositionsConflict;
    assert.equal(conflict.code, 'VERSION_CONFLICT');
    assert.equal(conflict.conflicts[0]!.id, t.id);
    assert.equal(conflict.conflicts[0]!.currentVersion, 2);
    assert.equal((await detail(ada, empty.id)).thoughts.length, 0, 'nothing moved');
    assert.equal((await detail(ada, mine.id)).thoughts.some((thought) => thought.id === t.id), true);
    const moved = expectStatus(await ada.browser.request('POST', move(mine.id), { body: { toSketchId: empty.id, thoughts: [{ id: t.id, expectedVersion: 2 }] } }), 200) as MovedToMap;
    assert.deepEqual([moved.moved[0]!.thought.x, moved.moved[0]!.thought.y], [11, 21]);
  });

  test('the caller must be able to change both maps: what they cannot see answers 404 and nothing moves', async () => {
    const mine = await ownMap(ada, ws.id);
    const t = await addThought(ada, mine.id, { text: 'Stays put', x: 0, y: 0 });
    const body = (toSketchId: string) => ({ toSketchId, thoughts: [{ id: t.id, expectedVersion: t.version }] });
    // A space Ada is in, but Cleo is not (restricted): Cleo cannot see its map, so Ada's map has nowhere to go for her.
    const bens = await ownMap(ben, ws.id);
    const benThought = await addThought(ben, bens.id, { text: 'Ben’s own', x: 0, y: 0 });
    const secret = await createSketch(ada, ws.id, { title: 'Closed map', scope: 'project', projectId: hidden.id });
    expectStatus(await cleo.browser.request('POST', move(bens.id), { body: { toSketchId: secret.id, thoughts: [{ id: benThought.id, expectedVersion: 1 }] } }), 404, 'a person who cannot see the source map');
    // Ben can write the hidden space's map, but not Ada's private one, whoever asks.
    expectStatus(await ben.browser.request('POST', move(bens.id), { body: { toSketchId: mine.id, thoughts: [{ id: benThought.id, expectedVersion: 1 }] } }), 404, 'another person’s private map as the target');
    expectStatus(await ben.browser.request('POST', move(mine.id), { body: { toSketchId: secret.id, thoughts: [{ id: t.id, expectedVersion: 1 }] } }), 404, 'another person’s private map as the source');
    // A map of another company is not a place for this one.
    const abroad = await createSketch(dave, elsewhere.id, { title: 'Abroad', scope: 'private' });
    expectStatus(await ada.browser.request('POST', move(mine.id), { body: body(abroad.id) }), 404, 'a map of a company they are not in');
    // A space Cleo was never added to.
    expectStatus(await ada.browser.request('POST', move(mine.id), { body: body(randomUUID()) }), 404, 'a map that does not exist');
    assert.equal((await detail(ada, mine.id)).thoughts.some((thought) => thought.id === t.id), true, 'nothing moved');
    // Someone who lost their place in the space can no longer move into it.
    const garden2 = await project(ada, ws.id, 'Left alone', 'restricted');
    await grant(ada, garden2.id, ben, 'contributor');
    const closing = await createSketch(ada, ws.id, { title: 'Closing', scope: 'project', projectId: garden2.id });
    const benMine = await addThought(ben, bens.id, { text: 'Goes nowhere once removed', x: 0, y: 0 });
    await removeFromSpace(ada, garden2.id, ben);
    expectStatus(await ben.browser.request('POST', move(bens.id), { body: { toSketchId: closing.id, thoughts: [{ id: benMine.id, expectedVersion: 1 }] } }), 404, 'a space they were removed from');
    expectStatus(await ben.browser.request('POST', move(bens.id), { body: { toSketchId: (await createSketch(ben, ws.id, { title: 'Ben’s own space map', scope: 'project', projectId: garden.id })).id, thoughts: [{ id: benMine.id, expectedVersion: 1 }] } }), 200, 'a space they are in');
  });

  test('the request is validated: another map, listed thoughts once each, with their versions, and a thought of that map', async () => {
    const mine = await ownMap(ada, ws.id);
    const space = await createSketch(ada, ws.id, { title: 'Validation', scope: 'project', projectId: garden.id });
    const t = await addThought(ada, mine.id, { text: 'Checked', x: 0, y: 0 });
    const item = { id: t.id, expectedVersion: t.version };
    const send = (path: string, body: unknown) => ada.browser.request('POST', path, { body });
    expectStatus(await send(move(mine.id), { toSketchId: mine.id, thoughts: [item] }), 400, 'the same map');
    expectStatus(await send(move(mine.id), { toSketchId: space.id, thoughts: [] }), 400, 'no thoughts');
    expectStatus(await send(move(mine.id), { toSketchId: space.id, thoughts: [item, item] }), 400, 'a thought twice');
    expectStatus(await send(move(mine.id), { toSketchId: 'not-an-id', thoughts: [item] }), 400, 'a target that is not an id');
    expectStatus(await send(move(mine.id), { toSketchId: space.id, thoughts: [{ id: t.id }] }), 400, 'a thought with no version');
    expectStatus(await send(move(mine.id), { toSketchId: space.id, thoughts: [item], at: { x: 'left' } }), 400, 'a place that is not a place');
    expectStatus(await send(move(mine.id), { toSketchId: space.id, thoughts: [{ id: randomUUID(), expectedVersion: 1 }] }), 404, 'a thought that is not on the map');
    expectStatus(await send(move(space.id), { toSketchId: mine.id, thoughts: [item] }), 404, 'a thought of the other map');
    expectStatus(await send(move(mine.id), { toSketchId: space.id, thoughts: [item], at: { x: 5_000_000, y: 0 } }), 400, 'a place off the plane');
    assert.equal((await detail(ada, mine.id)).thoughts.some((thought) => thought.id === t.id), true, 'nothing moved');
  });

  test('a retry with the same key moves once; the second answer is the first', async () => {
    const mine = await ownMap(ada, ws.id);
    const space = await createSketch(ada, ws.id, { title: 'Once', scope: 'project', projectId: garden.id });
    const t = await addThought(ada, mine.id, { text: 'Only once', x: 0, y: 0 });
    const body = { toSketchId: space.id, thoughts: [{ id: t.id, expectedVersion: t.version }] };
    const key = randomUUID();
    const first = await ada.browser.request('POST', move(mine.id), { body, headers: { 'idempotency-key': key } });
    const retry = await ada.browser.request('POST', move(mine.id), { body, headers: { 'idempotency-key': key } });
    assert.equal(first.status, 200, first.text);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(retry.json, first.json);
    assert.equal((await detail(ada, space.id)).thoughts.length, 1, 'one thought on the target, not two');
    // Another key for the same thought is another request: the thought is gone from My map.
    expectStatus(await ada.browser.request('POST', move(mine.id), { body, headers: { 'idempotency-key': randomUUID() } }), 404, 'moving it again');
  });

  test('a thought with an image stays on its map', async () => {
    const one = await createSketch(ada, ws.id, { title: 'Pictures', scope: 'project', projectId: garden.id });
    const two = await createSketch(ada, ws.id, { title: 'More pictures', scope: 'project', projectId: garden.id });
    const staged = await fetch(new URL(`/api/v1/projects/${garden.id}/files?uploadId=${randomUUID()}&name=Picture.png`, ada.browser.base), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: ada.browser.cookieHeader(), origin: ada.browser.defaultOrigin }, body: Buffer.from(PNG),
    });
    assert.equal(staged.status, 201);
    const file = await staged.json() as { id: string };
    const picture = await addThought(ada, one.id, { text: 'A picture', x: 0, y: 0, width: 240, height: 200, fileId: file.id });
    assert.ok(picture.file, 'the thought shows its image');
    const refused = expectStatus(await ada.browser.request('POST', move(one.id), { body: { toSketchId: two.id, thoughts: [{ id: picture.id, expectedVersion: picture.version }] } }), 422) as { code: string };
    assert.equal(refused.code, 'IMAGE_THOUGHT_STAYS');
    assert.equal((await detail(ada, one.id)).thoughts.length, 1, 'it is still where it was');
    assert.equal((await detail(ada, two.id)).thoughts.length, 0);
  });
});
