import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Thought, ThoughtLink } from '@flux/contracts';
import { buildOutline, emptyOutline, groupingChoices, OUTLINE_STORE_BYTES, OUTLINE_STORE_LIMIT, readOutline, readStoredOutline, rememberThoughts, visibleRows, writeStoredOutline } from '../../apps/web/src/sketch/outline.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const thought = (value: number, createdAt = `2026-09-30T10:00:${String(value).padStart(2, '0')}.000Z`): Thought => ({
  id: id(value), sketchId: id(900), text: `Thought ${value}`, x: value * 200, y: 0, width: 184, height: 72, shape: 'card', placement: null, source: null,
  createdBy: { kind: 'human', id: id(901), name: 'Kai' }, version: 1, createdAt, updatedAt: createdAt,
});
const link = (from: number, to: number, value = from * 100 + to): ThoughtLink => ({ id: id(value), sketchId: id(900), fromId: id(from), toId: id(to), label: null, createdAt: '2026-09-30T10:01:00.000Z' });

test('fresh graphs, including cycles and identical birth timestamps, conservatively start as deterministic roots', () => {
  const thoughts = [thought(3), thought(2), thought(1), thought(4, thought(2).createdAt)];
  const outline = buildOutline(thoughts, [link(1, 2), link(2, 3), link(3, 1), link(4, 3)], emptyOutline());
  assert.deepEqual(outline.rows.map((row) => row.thought.id), [id(1), id(2), id(4), id(3)]);
  assert.ok(outline.rows.every((row) => row.depth === 0));
  assert.equal(new Set(outline.rows.map((row) => row.thought.id)).size, thoughts.length);
});

test('depth 3/4 and roots/shallower nodes retain their levels when ordinary relations add multiple parents and cycles', () => {
  const thoughts = Array.from({ length: 8 }, (_, index) => thought(index + 1));
  const state = rememberThoughts(emptyOutline(), thoughts);
  state.parents = { [id(2)]: id(1), [id(3)]: id(2), [id(4)]: id(3), [id(5)]: id(4), [id(7)]: id(6) };
  const links = [link(1, 2), link(2, 3), link(3, 4), link(4, 5), link(6, 7)];
  const before = buildOutline(thoughts, links, state);
  const after = buildOutline(thoughts, [...links, link(6, 4), link(5, 6), link(7, 4), link(5, 7), link(1, 5)], state);
  assert.deepEqual(after.rows.map((row) => [row.thought.id, row.depth, row.parentId]), before.rows.map((row) => [row.thought.id, row.depth, row.parentId]));
  assert.equal(after.byId.get(id(4))?.depth, 3);
  assert.equal(after.byId.get(id(5))?.depth, 4);
  assert.equal(after.byId.get(id(6))?.depth, 0);
  assert.equal(after.byId.get(id(7))?.depth, 1);
  assert.equal(after.byId.get(id(8))?.depth, 0);
});

test('a missing parent or graph edge detaches without erasing the ID-only intent, and graph undo restores it', () => {
  const thoughts = [thought(1), thought(2), thought(3)];
  const state = rememberThoughts(emptyOutline(), thoughts);
  state.parents = { [id(2)]: id(1), [id(3)]: id(2) };
  const links = [link(1, 2), link(2, 3)];
  const removedParent = buildOutline([thoughts[0]!, thoughts[2]!], [links[0]!], state);
  assert.equal(removedParent.byId.get(id(3))?.depth, 0);
  assert.equal(buildOutline(thoughts, [links[0]!], state).byId.get(id(3))?.depth, 0);
  const restored = buildOutline(thoughts, links, state);
  assert.equal(restored.byId.get(id(3))?.depth, 2);
  assert.deepEqual(state.parents, { [id(2)]: id(1), [id(3)]: id(2) });
});

test('malformed saved cycles resolve deterministically; grouping only offers authorized linked non-descendants', () => {
  const thoughts = [thought(1), thought(2), thought(3), thought(4)];
  const links = [link(1, 2), link(2, 3), link(3, 1), link(1, 99)];
  const state = rememberThoughts(emptyOutline(), thoughts);
  state.parents = { [id(1)]: id(3), [id(2)]: id(1), [id(3)]: id(2), [id(4)]: id(99) };
  const corrupted = buildOutline(thoughts, links, state);
  assert.ok(corrupted.rows.every((row) => row.depth === 0));
  state.parents = { [id(2)]: id(1), [id(3)]: id(2) };
  const outline = buildOutline(thoughts, links, state);
  assert.deepEqual(groupingChoices(id(1), outline, links), []);
  assert.deepEqual(groupingChoices(id(3), outline, links).map((row) => row.thought.id), [id(1), id(2)]);
  assert.deepEqual(visibleRows(outline, [id(1)]).map((row) => row.thought.id), [id(1), id(4)]);
  assert.deepEqual(outline.byId.get(id(3))?.ancestors, [id(1), id(2)]);
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
