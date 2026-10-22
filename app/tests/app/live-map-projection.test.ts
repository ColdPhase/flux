import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveMapPosition, SketchDetail, Thought } from '@flux/contracts';
import { applyLivePreviews, applyLocal, createLivePreviewProjection } from '../../apps/web/src/sketch/projection.js';

const me = { id: 'person', name: 'Projection Person' };
function native(count = 500): SketchDetail {
  const now = '2026-10-04T00:00:00.000Z';
  const thoughts: Thought[] = Array.from({ length: count }, (_, index) => ({ id: `thought-${index}`, sketchId: 'map',
    text: `Native thought ${index}`, x: index * 12, y: index * 7, width: 184, height: 72, shape: 'card',
    placement: null, source: null, createdBy: { kind: 'human', ...me }, version: 3, createdAt: now, updatedAt: now }));
  return { id: 'map', workspaceId: 'workspace', scope: 'project', projectId: 'project', dmId: null,
    title: 'Stable native graph', access: 'write', createdBy: { kind: 'human', ...me }, origin: null,
    version: 2, createdAt: now, updatedAt: now, thoughts, links: [], copies: [] };
}
const position = (thought: Thought, changed: Partial<LiveMapPosition> = {}): LiveMapPosition => ({ id: thought.id, x: thought.x, y: thought.y, ...changed });

test('no overlay, exact unchanged positions and absent IDs preserve the actual 500-thought native graph', () => {
  const confirmed = native(); const original = structuredClone(confirmed);
  assert.equal(applyLivePreviews(confirmed, new Map()), confirmed);
  const same = new Map(confirmed.thoughts.map(thought => [thought.id, position(thought)]));
  assert.equal(applyLivePreviews(confirmed, same), confirmed);
  assert.equal(applyLivePreviews(confirmed, new Map([['deleted', { id: 'deleted', x: 99, y: 99 }]])), confirmed);
  assert.deepEqual(confirmed, original);
});

test('real movement/resize changes are immutable while all unaffected thought and link identities remain native', () => {
  const confirmed = native(); const original = structuredClone(confirmed);
  const first = confirmed.thoughts[0]!, second = confirmed.thoughts[1]!;
  const projected = applyLivePreviews(confirmed, new Map([
    [first.id, position(first, { x: first.x + 60, y: first.y + 25 })],
    [second.id, position(second, { width: 220, height: 90 })],
  ]));
  assert.notEqual(projected, confirmed); assert.notEqual(projected.thoughts, confirmed.thoughts);
  assert.notEqual(projected.thoughts[0], first); assert.notEqual(projected.thoughts[1], second);
  assert.equal(projected.thoughts[0]!.x, first.x + 60); assert.equal(projected.thoughts[0]!.width, first.width);
  assert.equal(projected.thoughts[1]!.width, 220); assert.equal(projected.thoughts[1]!.height, 90);
  assert.equal(projected.thoughts[0]!.version, first.version);
  for (let index = 2; index < confirmed.thoughts.length; index++) assert.equal(projected.thoughts[index], confirmed.thoughts[index]);
  assert.equal(projected.links, confirmed.links); assert.equal(projected.copies, confirmed.copies);
  assert.deepEqual(confirmed, original); assert.equal(applyLivePreviews(confirmed, new Map()), confirmed, 'Expiry restores native identities');
});

test('remote native changes survive unrelated pending intent and stale previews cannot resurrect removed thoughts', () => {
  const before = native(3); const removed = before.thoughts[0]!, peer = before.thoughts[1]!, local = before.thoughts[2]!;
  const changedPeer = { ...peer, text: 'Peer confirmed text', version: peer.version + 1 };
  const confirmed = { ...before, thoughts: [changedPeer, local] };
  const projected = applyLivePreviews(confirmed, new Map([[removed.id, position(removed, { x: 600 })]]));
  assert.equal(projected, confirmed); assert.equal(projected.thoughts.some(thought => thought.id === removed.id), false);
  const pending = applyLocal(projected, { kind: 'update', id: local.id, changes: { text: 'Unrelated pending edit' } }, me);
  assert.equal(pending.thoughts[0], changedPeer); assert.equal(pending.thoughts[0]!.version, peer.version + 1);
  assert.equal(pending.thoughts[1]!.text, 'Unrelated pending edit'); assert.equal(confirmed.thoughts[1], local);
  assert.equal(confirmed.thoughts[1]!.text, local.text); assert.equal(pending.thoughts.some(thought => thought.id === removed.id), false);
});

test('presence-only notifications reuse all 200 moved thought bodies until a preview changes or expires', () => {
  const confirmed = native(); const project = createLivePreviewProjection();
  const preview = { positions: confirmed.thoughts.slice(0, 200).map(thought => position(thought, { x: thought.x + 60 })) };
  const moved = project(confirmed, [preview]);
  assert.equal(project(confirmed, new Map([['lease', preview]]).values()), moved);
  for (let index = 0; index < 200; index++) assert.notEqual(moved.thoughts[index], confirmed.thoughts[index]);
  const advanced = { positions: preview.positions.map(value => ({ ...value, x: value.x + 12 })) };
  const next = project(confirmed, [advanced]);
  assert.notEqual(next, moved); assert.equal(next.thoughts[0]!.x, moved.thoughts[0]!.x + 12);
  assert.equal(project(confirmed, [advanced]), next);
  assert.equal(project(confirmed, []), confirmed, 'Expiry restores confirmed geometry and native identities');
  assert.notEqual(project(confirmed, [advanced]), confirmed, 'A new gesture still projects after expiry');
});

test('cached live geometry never hides native edits/removals or reuses another editor projection', () => {
  const confirmed = native(3); const project = createLivePreviewProjection();
  const preview = { positions: confirmed.thoughts.map(thought => position(thought, { x: thought.x + 60 })) };
  const moved = project(confirmed, [preview]);
  const edited = { ...confirmed.thoughts[1]!, text: 'New confirmed peer text', version: 4 };
  const fresh = { ...confirmed, thoughts: [edited, confirmed.thoughts[2]!] };
  const next = project(fresh, [preview]);
  assert.notEqual(next, moved); assert.deepEqual(next.thoughts.map(thought => thought.id), fresh.thoughts.map(thought => thought.id));
  assert.equal(next.thoughts[0]!.text, edited.text); assert.equal(next.thoughts[0]!.version, 4);
  assert.equal(next.thoughts[0]!.x, edited.x + 60);
  assert.equal(createLivePreviewProjection()(confirmed, []), confirmed);
  assert.equal(project(fresh, []), fresh);
});
