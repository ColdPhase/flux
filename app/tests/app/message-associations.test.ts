import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionRowProjection, ObjectLink, WorkAssociations, WorkRowProjection } from '@flux/contracts';
import { messageWorkPreviews, visibleMessageBatch } from '../../apps/web/src/work/message-associations.js';

test('a source preview keeps exact counts while object and edge windows are incomplete, deduplicates kind/id and preserves native row order', () => {
  const base = { id: 'shared-id', projectId: 'project', workspaceId: 'workspace', audience: { kind: 'project' as const, projectId: 'project' }, title: 'Check the distance sensor', createdAt: '2026-10-01T00:00:00Z', version: 1, updatedAt: '2026-10-01T00:00:00Z', relations: { edges: 3, sourceMessages: 2, sourceMaterials: 0, decisions: 0, results: 0 } };
  const work: WorkRowProjection = { ...base, kind: 'work', prerequisiteCounts: { total: 0, unmet: 0 }, status: 'open', owner: null, blocker: null, parked: null, parkedBy: null, rule: null };
  const decision: DecisionRowProjection = { ...base, kind: 'decision', status: 'proposed', proposedBy: { kind: 'human', id: 'ada', name: 'Ada Kowalska' }, decidedBy: null, decidedAt: null, supersedes: null, supersededAt: null, supersededBy: null };
  const edge = (id: string, kind: 'work' | 'decision', message: string, role: ObjectLink['role'] = 'source'): ObjectLink => ({ id, projectId: 'project', role, from: { type: kind, id: 'shared-id' }, to: { type: 'message', id: message }, fromTitle: base.title, toTitle: 'Measure the lamp', conversationId: 'conversation', sketchId: null, createdAt: base.createdAt });
  const counts = { messageId: 'one', work: 17, decisions: 5, results: 3, edges: 25 };
  const page: WorkAssociations = { items: [work, decision], limit: 50, total: 25, before: 0, nextCursor: 'object-next', previousCursor: null, observedAt: base.createdAt, sources: [counts, { messageId: 'two', work: 1, decisions: 0, results: 0, edges: 1 }, { messageId: 'zero', work: 0, decisions: 0, results: 0, edges: 0 }], sourceTotal: 3, sourceNextCursor: null, sourcePreviousCursor: null, edgeTotal: 26,
    edges: { items: [edge('d','decision','one'), edge('w','work','one'), edge('duplicate','work','one'), edge('w2','work','two'), edge('other-role','decision','two','related'), edge('foreign','work','not-selected')], total: 10, limit: 50, before: 0, nextCursor: 'edge-next', previousCursor: null } };
  const previews = messageWorkPreviews(page);
  assert.equal(previews.get('one')?.counts, counts);
  assert.deepEqual(previews.get('one')?.items, [work, decision]);
  assert.deepEqual(previews.get('two')?.items, [work]);
  assert.deepEqual(previews.get('zero')?.items, []);
  assert.equal(previews.has('not-selected'), false);
  assert.equal(page.items.length, 2); assert.equal(page.total, 25);
});

test('a stable globally bounded source batch follows an older visible native window without per-message paging or retaining removed IDs', () => {
  const all = Array.from({ length: 300 }, (_, i) => `message-${i}`);
  const latest = all.slice(-100);
  assert.deepEqual(visibleMessageBatch(all, ['message-270', 'message-290'], latest), latest);
  const older = visibleMessageBatch(all, ['message-109', 'message-140'], latest);
  assert.equal(older.length, 100);
  for (const id of ['message-109', 'message-140']) assert.ok(older.includes(id));
  assert.deepEqual(visibleMessageBatch(all, ['message-110'], older), older);
  const removed = visibleMessageBatch(all.slice(150), ['message-160'], older);
  assert.equal(removed.length, 100); assert.ok(removed.includes('message-160'));
  assert.ok(removed.every((id) => all.slice(150).includes(id)));
  assert.deepEqual(visibleMessageBatch(all.slice(0, 12), [], latest), all.slice(0, 12));
  assert.deepEqual(visibleMessageBatch([], [], latest), []);
});
