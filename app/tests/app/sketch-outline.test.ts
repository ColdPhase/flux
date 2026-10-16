import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Thought, ThoughtLink } from '@flux/contracts';
import { buildOutline, emptyOutline, OUTLINE_STORE_BYTES, OUTLINE_STORE_LIMIT, readOutline, readStoredOutline, rememberThoughts, sibling, swapOrder, visibleRows, writeStoredOutline } from '../../apps/web/src/sketch/outline.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const thought = (value: number, createdAt = `2026-09-30T10:00:${String(value).padStart(2, '0')}.000Z`): Thought => ({
  id: id(value), sketchId: id(900), text: `Thought ${value}`, x: value * 200, y: 0, width: 184, height: 72, shape: 'card', placement: null, source: null,
  createdBy: { kind: 'human', id: id(901), name: 'Kai' }, version: 1, createdAt, updatedAt: createdAt,
});
const link = (from: number, to: number, value = from * 100 + to): ThoughtLink => ({ id: id(value), sketchId: id(900), fromId: id(from), toId: id(to), label: null, createdAt: '2026-09-30T10:01:00.000Z' });

test('#510: the list is the map\'s tree: a thought sits under the thought its connection was drawn from', () => {
  const thoughts = Array.from({ length: 6 }, (_, index) => thought(index + 1));
  const outline = buildOutline(thoughts, [link(1, 2), link(2, 3), link(1, 4), link(5, 6)], emptyOutline());
  assert.deepEqual(outline.rows.map((row) => [row.thought.id, row.depth, row.parentId]), [
    [id(1), 0, null], [id(2), 1, id(1)], [id(3), 2, id(2)], [id(4), 1, id(1)], [id(5), 0, null], [id(6), 1, id(5)],
  ]);
  assert.deepEqual(outline.byId.get(id(1))?.children, [id(2), id(4)]);
  assert.equal(outline.byId.get(id(3))?.link?.id, link(2, 3).id);
  assert.deepEqual(outline.byId.get(id(3))?.ancestors, [id(1), id(2)]);
});

test('several parents: the oldest is the branch, the others are "also under"; every link shows exactly once', () => {
  const thoughts = Array.from({ length: 5 }, (_, index) => thought(index + 1));
  // 3 is connected from 1 (oldest) and 2; 4 from 2 and then from 1; 5 draws towards its own parent.
  const links = [link(2, 3), link(1, 3), link(1, 2), link(2, 4), link(1, 4), link(4, 5), link(5, 2)];
  const outline = buildOutline(thoughts, links, emptyOutline());
  assert.equal(outline.byId.get(id(3))?.parentId, id(1));
  assert.deepEqual(outline.byId.get(id(3))?.also.map((item) => item.id), [id(2)]);
  assert.equal(outline.byId.get(id(4))?.parentId, id(1));
  assert.deepEqual(outline.byId.get(id(4))?.also.map((item) => item.id), [id(2)]);
  assert.equal(outline.byId.get(id(2))?.parentId, id(1));
  assert.deepEqual(outline.byId.get(id(2))?.also.map((item) => item.id), [id(5)], 'a later connection towards it reads also under');
  assert.equal(new Set(outline.rows.map((row) => row.thought.id)).size, thoughts.length, 'every thought once');
  const shown = outline.rows.flatMap((row) => [...(row.link ? [row.link.id] : []), ...row.also.map((item) => item.link.id)]);
  assert.deepEqual([...shown].sort(), links.map((item) => item.id).sort(), 'every connection is a branch or an "also under"');
});

test('pure cycles, missing endpoints and self links resolve deterministically without losing a thought', () => {
  const thoughts = [thought(3), thought(2), thought(1), thought(4, thought(2).createdAt)];
  const links = [link(1, 2), link(2, 3), link(3, 1), link(4, 3), link(1, 99), link(4, 4, 444)];
  const outline = buildOutline(thoughts, links, emptyOutline());
  assert.equal(outline.rows.length, 4);
  assert.equal(new Set(outline.rows.map((row) => row.thought.id)).size, 4);
  assert.ok(outline.rows.some((row) => row.depth === 0), 'a cycle still has a root');
  assert.deepEqual(buildOutline([...thoughts].reverse(), [...links].reverse(), emptyOutline()).rows.map((row) => [row.thought.id, row.parentId]),
    outline.rows.map((row) => [row.thought.id, row.parentId]), 'input order does not matter');
});

test('the tree depends only on the graph: removing a thought detaches its children, and restoring it restores them', () => {
  const thoughts = [thought(1), thought(2), thought(3), thought(4)];
  const links = [link(1, 2), link(2, 3), link(3, 4), link(1, 4)];
  const state = rememberThoughts(emptyOutline(), thoughts);
  const before = buildOutline(thoughts, links, state);
  assert.equal(before.byId.get(id(4))?.parentId, id(1));
  const removed = buildOutline([thoughts[0]!, thoughts[2]!, thoughts[3]!], [links[3]!, links[2]!], state);
  assert.equal(removed.byId.get(id(3))?.depth, 0);
  // Undo restores the same links with new creation times; the tree is the same.
  const restored = buildOutline(thoughts, [links[3]!, ...links.slice(0, 3).map((item) => ({ ...item, createdAt: '2026-10-01T00:00:00.000Z' }))], state);
  assert.deepEqual(restored.rows.map((row) => [row.thought.id, row.parentId, row.depth]), before.rows.map((row) => [row.thought.id, row.parentId, row.depth]));
});

test('siblings follow the personal reading order; moving swaps only the two remembered siblings', () => {
  const thoughts = [thought(1), thought(2), thought(3), thought(4)];
  const links = [link(1, 2), link(1, 3), link(1, 4)];
  const state = rememberThoughts(emptyOutline(), thoughts);
  const outline = buildOutline(thoughts, links, state);
  assert.equal(sibling(outline, id(3), -1), id(2));
  assert.equal(sibling(outline, id(2), -1), null);
  assert.equal(sibling(outline, id(1), 1), null);
  const moved = buildOutline(thoughts, links, swapOrder(state, id(3), id(2)));
  assert.deepEqual(moved.byId.get(id(1))?.children, [id(3), id(2), id(4)]);
  assert.deepEqual(visibleRows(moved, [id(1)]).map((row) => row.thought.id), [id(1)]);
  assert.equal(swapOrder(state, id(3), id(99)), state);
});

test('renaming/moving/reordered server arrays preserve local outline order and never mutate graph input', () => {
  const thoughts = [thought(1), thought(2), thought(3)];
  const links = [link(1, 2)];
  const state = rememberThoughts(emptyOutline(), thoughts);
  state.parents = { [id(2)]: id(1) };
  const original = JSON.stringify({ thoughts, links });
  const outline = buildOutline([...thoughts].reverse().map((item) => ({ ...item, x: -200, text: `Renamed ${item.text}` })), links, state);
  assert.deepEqual(outline.rows.map((row) => row.thought.id), [id(1), id(2), id(3)]);
  assert.equal(JSON.stringify({ thoughts, links }), original);
});

test('preference storage is ID-only, account-scoped and globally bounded with oldest sketch eviction', () => {
  assert.deepEqual(readOutline('{bad'), emptyOutline());
  const dirty = readOutline(JSON.stringify({ version: 1, order: [id(1), 'private title', id(1)], parents: { [id(1)]: 'secret', title: 'hidden' }, collapsed: [id(1), 'title'], title: 'SECRET' }));
  assert.deepEqual(dirty, { version: 1, order: [id(1)], parents: {}, collapsed: [id(1)] });
  let raw = '';
  const keys: string[] = [];
  for (let index = 0; index < 8; index++) {
    const key = `${id(700)}:${id(800)}:${id(900 + index)}`;
    keys.push(key);
    const state = rememberThoughts(emptyOutline(), Array.from({ length: 1000 }, (_, node) => thought(1000 + node, '2026-09-30T00:00:00.000Z')));
    raw = writeStoredOutline(raw, key, state);
  }
  const saved = JSON.parse(raw) as { key: string; state: { order: string[] } }[];
  assert.ok(saved.reduce((count, entry) => count + entry.state.order.length, 0) <= OUTLINE_STORE_LIMIT);
  assert.ok(raw.length <= OUTLINE_STORE_BYTES);
  assert.deepEqual(readStoredOutline(raw, keys[0]!), emptyOutline());
  assert.equal(readStoredOutline(raw, keys.at(-1)!).order.length, 1000);
  assert.deepEqual(readStoredOutline(raw, `${id(701)}:${id(800)}:${id(907)}`), emptyOutline());
});

test('graphs exceeding the preference cap still render once and converge without a reconciliation loop', () => {
  const thoughts = Array.from({ length: 2005 }, (_, index) => thought(index + 1, '2026-09-30T00:00:00.000Z'));
  const first = rememberThoughts(emptyOutline(), thoughts);
  assert.equal(first.order.length, 2000);
  assert.equal(rememberThoughts(first, thoughts), first);
  const outline = buildOutline(thoughts, [], first);
  assert.equal(outline.rows.length, thoughts.length);
  assert.equal(new Set(outline.rows.map((row) => row.thought.id)).size, thoughts.length);
});
