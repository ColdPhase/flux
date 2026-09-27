import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { CreatedThought, MovedThoughts, PositionsConflict, Project, Sketch, SketchDetail, SketchPage, Thought, ThoughtLink, VersionConflict, Workspace } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { addMember, draft, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';

// Persistent sketches over HTTP (issue #69, AC-1/AC-2/AC-4): access through the #29 policy,
// private and DM sketches, cross-workspace rejection, If-Match, concurrent moves, idempotent
// retries, placements that never delete their object, and stream events with a policy audience.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });

async function createSketch(actor: Person, workspaceId: string, body: Record<string, unknown>) {
  return expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${workspaceId}/sketches`, { body }), 201, 'create sketch') as Sketch;
}

async function addThought(actor: Person, sketchId: string, body: Record<string, unknown>) {
  return expectStatus(await actor.browser.request('POST', `/api/v1/sketches/${sketchId}/thoughts`, { body }), 201, 'add thought') as CreatedThought;
}

async function detail(actor: Person, sketchId: string) {
  return expectStatus(await actor.browser.request('GET', `/api/v1/sketches/${sketchId}`), 200, 'get sketch') as SketchDetail;
}

async function audience(sketchId: string) {
  const result = await pool.query('SELECT DISTINCT a.recipient FROM event_audience a JOIN events e ON e.id = a.event_id WHERE e.object_id = $1', [sketchId]);
  return new Set(result.rows.map((row) => row.recipient as string));
}

describe('sketch access', () => {
  let alice: Person; // workspace owner
  let bob: Person; // member
  let carol: Person; // admin
  let erin: Person; // member with a viewer grant on the project
  let dave: Person; // owner of another workspace
  let ws: Workspace;
  let other: Workspace;
  let lamp: Project;

  before(async () => {
    [alice, bob, carol, erin, dave] = await Promise.all(['sketch-alice', 'sketch-bob', 'sketch-carol', 'sketch-erin', 'sketch-dave'].map(person));
    ws = await workspace(alice, 'Sketching');
    other = await workspace(dave, 'Elsewhere');
    await addMember(alice, ws.id, bob, 'member');
    await addMember(alice, ws.id, carol, 'admin');
    await addMember(alice, ws.id, erin, 'member');
    lamp = await project(alice, ws.id, 'Gesture lamp', 'workspace');
    await grant(alice, lamp.id, erin, 'viewer');
  });

  test('a project sketch follows project access: members change it, viewers read it, outsiders get 404', async () => {
    const sketch = await createSketch(bob, ws.id, { title: 'Lamp ideas', scope: 'project', projectId: lamp.id });
    assert.equal(sketch.scope, 'project');
    assert.equal(sketch.access, 'write');
    assert.deepEqual(sketch.participants, []);
    const { thought } = await addThought(alice, sketch.id, { text: 'Gesture-controlled desk lamp', x: 40, y: 60 });
    assert.equal(thought.createdBy.name, 'sketch-alice');
    assert.equal(thought.shape, 'card');
    assert.equal(thought.width, 184);

    const forErin = await detail(erin, sketch.id);
    assert.equal(forErin.access, 'read');
    assert.equal(forErin.thoughts.length, 1);
    expectStatus(await erin.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: 'no', x: 0, y: 0 } }), 403, 'viewer adds');
    expectStatus(await erin.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: { moves: [{ id: thought.id, x: 1, y: 1, expectedVersion: 1 }] } }), 403, 'viewer moves');
    expectStatus(await dave.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 404, 'other workspace reads');
    expectStatus(await dave.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: { moves: [{ id: thought.id, x: 1, y: 1, expectedVersion: 1 }] } }), 404, 'other workspace moves');
    expectStatus(await dave.browser.request('GET', `/api/v1/workspaces/${ws.id}/sketches`), 404, 'other workspace lists');

    // Explicit deny wins: a denied member loses the sketch with the project.
    await grant(alice, lamp.id, bob, 'denied');
    expectStatus(await bob.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 404, 'denied member');
    const bobList = expectStatus(await bob.browser.request('GET', `/api/v1/workspaces/${ws.id}/sketches`), 200) as SketchPage;
    assert.ok(!bobList.items.some((item) => item.id === sketch.id));
    await pool.query("DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2", [lamp.id, bob.id]);
    expectStatus(await bob.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 200, 'access returns with the grant removed');
  });

  test('a private sketch is visible only to its author, never through the project or to admins', async () => {
    const mine = await createSketch(alice, ws.id, { title: 'Just me', scope: 'direct' });
    assert.deepEqual(mine.participants.map((p) => p.id), [alice.id]);
    await addThought(alice, mine.id, { text: 'Half an idea', x: 0, y: 0 });
    for (const [who, label] of [[bob, 'member'], [carol, 'admin'], [erin, 'viewer'], [dave, 'outsider']] as const) {
      expectStatus(await who.browser.request('GET', `/api/v1/sketches/${mine.id}`), 404, `${label} reads a private sketch`);
      expectStatus(await who.browser.request('POST', `/api/v1/sketches/${mine.id}/thoughts`, { body: { text: 'x', x: 0, y: 0 } }), 404, `${label} writes a private sketch`);
    }
    const carolList = expectStatus(await carol.browser.request('GET', `/api/v1/workspaces/${ws.id}/sketches`), 200) as SketchPage;
    assert.ok(!carolList.items.some((item) => item.id === mine.id), 'not in an admin’s list');
    const projectList = expectStatus(await alice.browser.request('GET', `/api/v1/workspaces/${ws.id}/sketches?projectId=${lamp.id}`), 200) as SketchPage;
    assert.ok(!projectList.items.some((item) => item.id === mine.id), 'not in the project’s sketches, even for its author');
    const aliceList = expectStatus(await alice.browser.request('GET', `/api/v1/workspaces/${ws.id}/sketches`), 200) as SketchPage;
    assert.ok(aliceList.items.some((item) => item.id === mine.id));
    assert.equal(aliceList.total, aliceList.items.length);
    assert.deepEqual(await audience(mine.id), new Set([`human:${alice.id}`]), 'its events reach only the author');
  });

  test('a DM sketch belongs to its participants: both change it, nobody else sees it or its events', async () => {
    const dm = await createSketch(alice, ws.id, { title: 'Lamp ideas with Bob', scope: 'direct', participantIds: [bob.id] });
    assert.deepEqual(new Set(dm.participants.map((p) => p.id)), new Set([alice.id, bob.id]));
    const stream = await StreamClient.connect(bob.browser);
    const carolStream = await StreamClient.connect(carol.browser);
    try {
      await Promise.all([stream.ready(), carolStream.ready()]);
      const { thought } = await addThought(bob, dm.id, { text: 'ToF distance sensor', x: 10, y: 10 });
      const event = await stream.event(dm.id, 'sketch.changed.v1');
      assert.equal(event.objectType, 'sketch');
      assert.equal(JSON.stringify(event).includes('ToF'), false, 'events carry identifiers, never content');
      expectStatus(await carol.browser.request('GET', `/api/v1/sketches/${dm.id}`), 404, 'admin outside the DM');
      expectStatus(await carol.browser.request('DELETE', `/api/v1/sketches/${dm.id}/thoughts/${thought.id}`, { headers: ifMatch(1) }), 404, 'admin removes');
      // Another workspace event after the DM one: carol receives it, and never the DM event before it.
      const marker = await createSketch(carol, ws.id, { title: 'Carol’s own', scope: 'direct' });
      await carolStream.event(marker.id);
      assert.ok(!carolStream.events.some((e) => e.objectId === dm.id), 'the DM event never reached a non-participant');
    } finally {
      await Promise.all([stream.close(), carolStream.close()]);
    }
    assert.deepEqual(await audience(dm.id), new Set([`human:${alice.id}`, `human:${bob.id}`]));

    // Leaving the workspace ends the participation.
    const frank = await person('sketch-frank');
    await addMember(alice, ws.id, frank, 'member');
    const withFrank = await createSketch(alice, ws.id, { title: 'With Frank', scope: 'direct', participantIds: [frank.id] });
    expectStatus(await frank.browser.request('GET', `/api/v1/sketches/${withFrank.id}`), 200);
    expectStatus(await alice.browser.request('DELETE', `/api/v1/workspaces/${ws.id}/members/${frank.id}`), 204);
    expectStatus(await frank.browser.request('GET', `/api/v1/sketches/${withFrank.id}`), 404, 'former member');
  });

  test('cross-workspace references are rejected', async () => {
    const bobOnly = await createSketch(bob, ws.id, { title: 'Bob’s map', scope: 'direct' });
    const outsider = expectStatus(await alice.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'x', scope: 'direct', participantIds: [dave.id] } }), 422) as { code: string };
    assert.equal(outsider.code, 'PARTICIPANT_NOT_MEMBER');
    expectStatus(await dave.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'x', scope: 'direct' } }), 404, 'create in a workspace you are not in');

    // Alice also belongs to Dave's workspace: a project there is still not a place here.
    await addMember(dave, other.id, alice, 'member');
    const away = await project(dave, other.id, 'Away', 'workspace');
    const cross = expectStatus(await alice.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'x', scope: 'project', projectId: away.id } }), 422) as { code: string };
    assert.equal(cross.code, 'CROSS_WORKSPACE');
    expectStatus(await bob.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'x', scope: 'project', projectId: away.id } }), 404, 'invisible project');

    // A draft of the other workspace cannot be placed here, even by someone who can read it.
    const awayDraft = await draft(alice, other.id, 'Other workspace note');
    const sketch = await createSketch(alice, ws.id, { title: 'Placements', scope: 'project', projectId: lamp.id });
    const placed = expectStatus(await alice.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: 'x', x: 0, y: 0, placement: { type: 'draft', id: awayDraft.id } } }), 422) as { code: string };
    assert.equal(placed.code, 'CROSS_WORKSPACE');

    // Thoughts of different sketches never link.
    const here = await addThought(alice, sketch.id, { text: 'Here', x: 0, y: 0 });
    const there = await addThought(bob, bobOnly.id, { text: 'There', x: 0, y: 0 });
    expectStatus(await alice.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: here.thought.id, toId: there.thought.id } }), 404, 'link to another sketch');
    expectStatus(await alice.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: 'x', x: 0, y: 0, linkFrom: { thoughtId: there.thought.id } } }), 404, 'connected thought from another sketch');
  });

  test('placements show only what the reader may open, and removing one never deletes the object', async () => {
    const sketch = await createSketch(alice, ws.id, { title: 'With drafts', scope: 'project', projectId: lamp.id });
    const note = await draft(alice, ws.id, 'Alice’s private plan', { body: 'secret' });
    const { thought } = await addThought(alice, sketch.id, { text: 'The plan', x: 0, y: 0, placement: { type: 'draft', id: note.id } });
    assert.deepEqual(thought.placement, { type: 'draft', id: note.id, title: 'Alice’s private plan' });
    const forBob = await detail(bob, sketch.id);
    assert.deepEqual(forBob.thoughts[0]!.placement, { type: 'draft', id: note.id, title: null }, 'no title for a reader who cannot open the draft');
    assert.equal(JSON.stringify(forBob).includes('secret'), false);
    expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { text: 'x', x: 0, y: 0, placement: { type: 'draft', id: note.id } } }), 404, 'placing a draft you cannot read');

    const other = await addThought(alice, sketch.id, { text: 'Next step', x: 240, y: 0, linkFrom: { thoughtId: thought.id, label: 'then' } });
    assert.equal(other.link?.label, 'then');
    expectStatus(await alice.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/thoughts/${thought.id}`), 428, 'remove without If-Match');
    expectStatus(await alice.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/thoughts/${thought.id}`, { headers: ifMatch(1) }), 204);
    const after = await detail(alice, sketch.id);
    assert.deepEqual(after.thoughts.map((t) => t.id), [other.thought.id]);
    assert.deepEqual(after.links, [], 'links of a removed thought go with it');
    const kept = expectStatus(await alice.browser.request('GET', `/api/v1/drafts/${note.id}`), 200) as { title: string; body: string };
    assert.equal(kept.body, 'secret', 'the placed draft is untouched');

    // Undo on the client: recreate the thought and its link with the same ids.
    const restored = await addThought(alice, sketch.id, { id: thought.id, text: 'The plan', x: 0, y: 0, placement: { type: 'draft', id: note.id } });
    assert.equal(restored.thought.id, thought.id);
    const relinked = expectStatus(await alice.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { id: other.link!.id, fromId: thought.id, toId: other.thought.id, label: 'then' } }), 201) as ThoughtLink;
    assert.equal(relinked.id, other.link!.id);
    expectStatus(await alice.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { id: thought.id, text: 'dup', x: 0, y: 0 } }), 409, 'id already used');
  });

  test('links are many-to-many, undirected and unique per pair', async () => {
    const sketch = await createSketch(bob, ws.id, { title: 'Links', scope: 'project', projectId: lamp.id });
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((text, index) => addThought(bob, sketch.id, { text, x: index * 200, y: 0 })));
    const ab = expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: a!.thought.id, toId: b!.thought.id, label: 'option' } }), 201) as ThoughtLink;
    expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: a!.thought.id, toId: c!.thought.id } }), 201);
    expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: b!.thought.id, toId: c!.thought.id } }), 201);
    const duplicate = expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: b!.thought.id, toId: a!.thought.id } }), 409) as { code: string };
    assert.equal(duplicate.code, 'LINK_EXISTS');
    const self = expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/links`, { body: { fromId: a!.thought.id, toId: a!.thought.id } }), 422) as { code: string };
    assert.equal(self.code, 'SELF_LINK');
    assert.equal((await detail(bob, sketch.id)).links.length, 3);
    expectStatus(await erin.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/links/${ab.id}`), 403, 'viewer unlinks');
    expectStatus(await bob.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/links/${ab.id}`), 204);
    expectStatus(await bob.browser.request('DELETE', `/api/v1/sketches/${sketch.id}/links/${ab.id}`), 404, 'already removed');
    assert.deepEqual((await detail(bob, sketch.id)).links.map((link) => link.label), [null, null]);
  });

  test('versioned changes: If-Match, concurrent moves conflict or merge', async () => {
    const sketch = await createSketch(alice, ws.id, { title: 'Moves', scope: 'direct', participantIds: [bob.id] });
    const one = (await addThought(alice, sketch.id, { text: 'One', x: 0, y: 0 })).thought;
    const two = (await addThought(alice, sketch.id, { text: 'Two', x: 300, y: 0 })).thought;

    expectStatus(await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/thoughts/${one.id}`, { body: { text: 'no version' } }), 428);
    const edited = await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/thoughts/${one.id}`, { body: { text: 'One, edited', shape: 'pill', width: 220 }, headers: ifMatch(1) });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.headers.get('etag'), '"2"');
    assert.deepEqual([(edited.json as Thought).shape, (edited.json as Thought).width], ['pill', 220]);
    const stale = expectStatus(await bob.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/thoughts/${one.id}`, { body: { text: 'lost' }, headers: ifMatch(1) }), 409) as VersionConflict<Thought>;
    assert.equal(stale.currentVersion, 2);
    assert.equal(stale.current.text, 'One, edited');

    // The same thought moved by both at once: exactly one wins, the other gets 409 and nothing of it lands.
    const [first, second] = await Promise.all([alice, bob].map((who, index) => who.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, {
      body: { moves: [{ id: one.id, x: 100 + index, y: 100 + index, expectedVersion: 2 }] },
    })));
    assert.deepEqual([first!.status, second!.status].sort(), [200, 409]);
    const loser = (first!.status === 409 ? first : second)!.json as PositionsConflict;
    assert.equal(loser.code, 'VERSION_CONFLICT');
    assert.equal(loser.conflicts[0]!.id, one.id);
    assert.equal(loser.conflicts[0]!.currentVersion, 3);
    const winner = ((first!.status === 200 ? first : second)!.json as MovedThoughts).thoughts[0]!;
    const stored = (await detail(alice, sketch.id)).thoughts.find((t) => t.id === one.id)!;
    assert.deepEqual([stored.x, stored.y, stored.version], [winner.x, winner.y, 3]);

    // Different thoughts moved at once both land (they merge).
    const [left, right] = await Promise.all([
      alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: { moves: [{ id: one.id, x: 10, y: 20, expectedVersion: 3 }] } }),
      bob.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: { moves: [{ id: two.id, x: 310, y: 20, expectedVersion: 1 }] } }),
    ]);
    assert.deepEqual([left.status, right.status], [200, 200]);

    // A batch with one stale move moves nothing.
    const batch = expectStatus(await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, {
      body: { moves: [{ id: one.id, x: 0, y: 0, expectedVersion: 4 }, { id: two.id, x: 0, y: 0, expectedVersion: 1 }] },
    }), 409) as PositionsConflict;
    assert.deepEqual(batch.conflicts.map((c) => c.id), [two.id]);
    const unchanged = await detail(alice, sketch.id);
    assert.deepEqual(unchanged.thoughts.map((t) => [t.x, t.y]), [[10, 20], [310, 20]]);
    expectStatus(await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: { moves: [{ id: one.id, x: 0, y: 0 }] } }), 428, 'move without version');

    const moved = expectStatus(await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, {
      body: { moves: [{ id: one.id, x: -40, y: 5, expectedVersion: 4 }, { id: two.id, x: 400, y: 5, expectedVersion: 2 }] },
    }), 200) as MovedThoughts;
    assert.deepEqual(moved.thoughts.map((t) => t.version), [5, 3]);

    // Renaming the sketch needs its version too.
    expectStatus(await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}`, { body: { title: 'Renamed' } }), 428);
    const renamed = expectStatus(await bob.browser.request('PATCH', `/api/v1/sketches/${sketch.id}`, { body: { title: 'Renamed' }, headers: ifMatch(1) }), 200) as Sketch;
    assert.equal(renamed.version, 2);
    expectStatus(await alice.browser.request('PATCH', `/api/v1/sketches/${sketch.id}`, { body: { title: 'Again' }, headers: ifMatch(1) }), 409);
  });

  test('an idempotent retry replays the stored answer without a second change', async () => {
    const sketch = await createSketch(alice, ws.id, { title: 'Retries', scope: 'direct', participantIds: [bob.id] });
    const key = randomUUID();
    const body = { text: 'Only once', x: 5, y: 5 };
    const first = await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body, headers: { 'idempotency-key': key } });
    const retry = await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body, headers: { 'idempotency-key': key } });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(retry.json, first.json);
    assert.equal((await detail(bob, sketch.id)).thoughts.length, 1);
    const reused = expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body: { ...body, text: 'Different' }, headers: { 'idempotency-key': key } }), 422) as { code: string };
    assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED');

    const thought = (first.json as CreatedThought).thought;
    const moveKey = randomUUID();
    const move = { moves: [{ id: thought.id, x: 50, y: 50, expectedVersion: 1 }] };
    expectStatus(await bob.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: move, headers: { 'idempotency-key': moveKey } }), 200);
    const replayed = await bob.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/positions`, { body: move, headers: { 'idempotency-key': moveKey } });
    assert.equal(replayed.status, 200, 'a retried move is not a conflict with itself');
    assert.equal(replayed.headers.get('idempotent-replayed'), 'true');
    assert.equal((await detail(bob, sketch.id)).thoughts[0]!.version, 2);

    // A replay is re-authorized: once Bob can no longer read the sketch he gets 404, not the stored body.
    await pool.query('DELETE FROM sketch_participants WHERE sketch_id = $1 AND user_id = $2', [sketch.id, bob.id]);
    expectStatus(await bob.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body, headers: { 'idempotency-key': key } }), 404, 'replay after losing access');
    const events = await pool.query("SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND kind = 'sketch.changed.v1'", [sketch.id]);
    assert.equal(events.rows[0].n, 2, 'one event per applied change, none for replays');
  });

  test('input is validated', async () => {
    const sketch = await createSketch(alice, ws.id, { title: 'Checks', scope: 'direct' });
    const cases: [Record<string, unknown>, string][] = [
      [{ text: '   ', x: 0, y: 0 }, 'blank text'],
      [{ text: 'x', x: 200_001, y: 0 }, 'x out of range'],
      [{ text: 'x', x: 0, y: 0, width: 20 }, 'too narrow'],
      [{ text: 'x', x: 0, y: 0, shape: 'star' }, 'unknown shape'],
      [{ text: 'x'.repeat(1001), x: 0, y: 0 }, 'text too long'],
    ];
    for (const [body, label] of cases) expectStatus(await alice.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, { body }), 400, label);
    expectStatus(await alice.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title: 'x', scope: 'project' } }), 400, 'project sketch without project');
    expectStatus(await alice.browser.request('GET', '/api/v1/sketches/not-a-uuid'), 404);
  });
});
