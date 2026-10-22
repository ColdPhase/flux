import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { SKETCH_LIMITS, type CreatedThought, type Dm, type LinkLabelConflict, type Project, type Sketch, type SketchDetail, type ThoughtLink, type UpdateLinkLabelCommand, type Workspace } from '@flux/contracts';
import { DomainError, createSketchUseCases, type SketchUnitOfWork } from '@flux/core';
import { sketchPorts, sketchUseCases } from '../../apps/server/src/sketches/adapters.js';
import { db, pool } from './support/db.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// #481: renaming a connection preserves it; concurrent labels never overwrite unnoticed.
const path = (link: ThoughtLink) => `/api/v1/sketches/${link.sketchId}/links/${link.id}`;
const patch = (actor: Person, link: ThoughtLink, label: string | null, expectedLabel = link.label, headers?: Record<string, string>) =>
  actor.browser.request('PATCH', path(link), { body: { label, expectedLabel }, headers });
const detail = async (actor: Person, sketchId: string) =>
  expectStatus(await actor.browser.request('GET', `/api/v1/sketches/${sketchId}`), 200) as SketchDetail;
const changes = async (sketchId: string) => (await pool.query(
  "SELECT data FROM events WHERE object_id = $1 AND kind = 'sketch.changed.v1' AND data->>'op' = 'link_updated' ORDER BY seq", [sketchId],
)).rows;

describe('connection labels', () => {
  let owner: Person;
  let editor: Person;
  let viewer: Person;
  let outsider: Person;
  let ws: Workspace;
  let room: Project;

  before(async () => {
    [owner, editor, viewer, outsider] = await Promise.all(['labels-owner', 'labels-editor', 'labels-viewer', 'labels-outsider'].map(person));
    ws = await workspace(owner, 'Connection labels');
    await addMember(owner, ws.id, editor, 'member');
    await addMember(owner, ws.id, viewer, 'member');
    room = await project(owner, ws.id, 'Garden sensors', 'workspace');
    await grant(owner, room.id, viewer, 'viewer');
  });

  async function linked(actor = owner, scope: Record<string, unknown> = { scope: 'project', projectId: room.id }, label: string | null = null) {
    const sketch = expectStatus(await actor.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, {
      body: { title: 'Where the sensors go', ...scope },
    }), 201) as Sketch;
    const first = expectStatus(await actor.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, {
      body: { text: 'Six sensors', x: 40, y: 40 },
    }), 201) as CreatedThought;
    const next = expectStatus(await actor.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`, {
      body: { text: 'Borrow two sensors?', x: 300, y: 40, linkFrom: { thoughtId: first.thought.id, label } },
    }), 201) as CreatedThought;
    return { sketch, link: next.link! };
  }

  test('add, edit and clear persist without replacing the connection or changing thoughts', async () => {
    const { sketch, link } = await linked();
    const before = await detail(owner, sketch.id);
    const added = expectStatus(await patch(editor, link, '  budget  '), 200) as ThoughtLink;
    assert.deepEqual(added, { ...link, label: 'budget' });
    let stored = await detail(viewer, sketch.id);
    assert.deepEqual(stored.links, [added]);
    assert.deepEqual(stored.thoughts, before.thoughts);
    assert.ok(stored.updatedAt > before.updatedAt);

    const edited = expectStatus(await patch(owner, added, 'range'), 200) as ThoughtLink;
    assert.deepEqual(edited, { ...link, label: 'range' });
    const cleared = expectStatus(await patch(editor, edited, '   '), 200) as ThoughtLink;
    assert.deepEqual(cleared, link);
    stored = await detail(owner, sketch.id);
    assert.deepEqual(stored.links, [link]);
    assert.deepEqual(stored.thoughts, before.thoughts);
    expectStatus(await patch(owner, cleared, null), 200, 'unchanged label');
    assert.equal((await detail(owner, sketch.id)).updatedAt, stored.updatedAt, 'a no-op never touches the sketch');
    const events = await changes(sketch.id);
    assert.equal(events.length, 3, 'exactly one event per actual label change');
    assert.deepEqual(events[0]!.data, { op: 'link_updated', thoughtIds: [link.fromId, link.toId], linkIds: [link.id] });
    assert.ok(!JSON.stringify(events).includes('budget'), 'stream events contain no label content');

    const again = expectStatus(await patch(owner, link, 'problem'), 200) as ThoughtLink;
    expectStatus(await patch(editor, again, null), 200, 'explicit null also clears');
    assert.deepEqual((await detail(owner, sketch.id)).links, [link]);
  });

  test('write access is checked before current labels are returned, including private and DM scopes', async () => {
    const { sketch, link } = await linked(owner, undefined, 'private detail');
    expectStatus(await new Browser().request('PATCH', path(link), { body: { label: 'no', expectedLabel: null } }), 401);
    for (const [actor, status] of [[viewer, 403], [outsider, 404]] as const) {
      const response = await patch(actor, link, 'no', null);
      expectStatus(response, status);
      assert.ok(!response.text.includes('private detail'), 'denied response does not reveal current label');
    }
    const foreign = await linked();
    expectStatus(await editor.browser.request('PATCH', `/api/v1/sketches/${sketch.id}/links/${foreign.link.id}`, {
      body: { label: 'no', expectedLabel: null },
    }), 404, 'link id belongs to another sketch');
    expectStatus(await patch(editor, { ...link, id: randomUUID() }, 'no'), 404, 'unknown link');
    assert.equal((await detail(owner, sketch.id)).links[0]!.label, 'private detail');

    const privateMap = await linked(editor, { scope: 'private' });
    expectStatus(await patch(owner, privateMap.link, 'no'), 404, 'workspace owner cannot edit private sketch');
    expectStatus(await patch(editor, privateMap.link, 'my label'), 200);

    const dm = expectStatus(await editor.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, {
      body: { participantIds: [viewer.id] },
    }), 201) as Dm;
    const dmMap = await linked(editor, { scope: 'dm', dmId: dm.id });
    expectStatus(await patch(owner, dmMap.link, 'no'), 404, 'workspace owner outside DM');
    expectStatus(await patch(viewer, dmMap.link, 'shared label'), 200, 'DM participant edits despite project viewer grant');
    expectStatus(await viewer.browser.request('POST', `/api/v1/dms/${dm.id}/leave`), 204, 'leave DM');
    expectStatus(await patch(viewer, dmMap.link, 'no'), 404, 'former participant cannot edit');
    expectStatus(await patch(editor, dmMap.link, 'no'), 403, 'closed one-to-one DM is read-only');
  });

  test('concurrent edits compare under the sketch lock and stale retries leave data and events unchanged', async () => {
    const { sketch, link } = await linked();
    const replies = await Promise.all([patch(owner, link, 'range'), patch(editor, link, 'problem')]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
    const winner = replies.find((reply) => reply.status === 200)!.json as ThoughtLink;
    const conflict = replies.find((reply) => reply.status === 409)!.json as LinkLabelConflict;
    assert.equal(conflict.code, 'LABEL_CONFLICT');
    assert.equal(conflict.currentLabel, winner.label);
    assert.deepEqual(conflict.current, winner);
    const stored = await detail(owner, sketch.id);
    assert.deepEqual(stored.links, [winner]);
    const stale = expectStatus(await patch(editor, link, 'stale value'), 409) as LinkLabelConflict;
    assert.equal(stale.currentLabel, winner.label);
    assert.equal((await detail(owner, sketch.id)).updatedAt, stored.updatedAt);
    assert.equal((await changes(sketch.id)).length, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM map_live_heads WHERE sketch_id=$1', [sketch.id])).rows[0].n, 0,
      'a native stale-label conflict never creates a live room');
    // A deliberate second save names the reviewed current label.
    expectStatus(await patch(editor, winner, 'reviewed replacement'), 200);
    assert.equal((await detail(owner, sketch.id)).links[0]!.label, 'reviewed replacement');
  });

  test('idempotent retries replay once, remain scoped to the link, and recheck access', async () => {
    const restricted = await project(owner, ws.id, 'Restricted map', 'restricted');
    await grant(owner, restricted.id, editor, 'contributor');
    const { sketch, link } = await linked(owner, { scope: 'project', projectId: restricted.id });
    const headers = { 'idempotency-key': randomUUID() };
    const first = expectStatus(await patch(editor, link, 'budget', null, headers), 200) as ThoughtLink;
    const updatedAt = (await detail(owner, sketch.id)).updatedAt;
    const replay = await patch(editor, link, 'budget', null, headers);
    expectStatus(replay, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(replay.json, first);
    assert.equal((await detail(owner, sketch.id)).updatedAt, updatedAt);
    assert.equal((await changes(sketch.id)).length, 1);
    const reused = expectStatus(await patch(editor, link, 'another', null, headers), 422) as { code: string };
    assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED');
    const other = await linked(owner, { scope: 'project', projectId: restricted.id });
    expectStatus(await patch(editor, other.link, 'budget', null, headers), 422, 'same key for another link does not replay');
    await grant(owner, restricted.id, editor, 'denied');
    expectStatus(await patch(editor, link, 'budget', null, headers), 404, 'replay after losing access');
    assert.equal((await changes(sketch.id)).length, 1);
  });

  test('label validation applies in HTTP and core, and event failure rolls back the label', async () => {
    const { sketch, link } = await linked();
    for (const body of [{ label: 'missing expectation' }, { expectedLabel: null },
      { label: 'x'.repeat(SKETCH_LIMITS.label + 1), expectedLabel: null },
      { label: 'valid', expectedLabel: 'x'.repeat(SKETCH_LIMITS.label + 1) }]) {
      expectStatus(await owner.browser.request('PATCH', path(link), { body }), 400);
    }
    const actor = { kind: 'human' as const, id: owner.id };
    for (const body of [{ label: 'missing expectation' }, { label: 12, expectedLabel: null }, { label: null, expectedLabel: false }]) {
      await assert.rejects(sketchUseCases(db).updateLinkLabel(actor, sketch.id, link.id, body as unknown as UpdateLinkLabelCommand),
        (error: unknown) => error instanceof DomainError && error.code === 'INVALID_INPUT');
    }
    assert.deepEqual((await detail(owner, sketch.id)).links, [link]);
    const failing: SketchUnitOfWork = {
      run: (work) => db.transaction((tx) => {
        const ports = sketchPorts(tx);
        return work({ ...ports, events: { record: async () => { throw new Error('label-event-rollback'); } } });
      }),
    };
    await assert.rejects(createSketchUseCases(failing).updateLinkLabel(actor, sketch.id, link.id, { label: 'rolled back', expectedLabel: null }),
      /label-event-rollback/);
    assert.deepEqual((await detail(owner, sketch.id)).links, [link]);
    assert.equal((await changes(sketch.id)).length, 0);
    const maximum = 'x'.repeat(SKETCH_LIMITS.label);
    expectStatus(await patch(owner, link, `  ${maximum}  `), 200, 'limit applies after trimming');
    assert.equal((await detail(owner, sketch.id)).links[0]!.label, maximum);
  });
});
