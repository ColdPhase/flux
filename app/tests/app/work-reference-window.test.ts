import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERENCE_WINDOW, selectReferenceWindow } from '../../apps/web/src/work/reference-window.js';

const ref = (n: number) => `work:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

test('every loaded proposal target is read regardless of scroll while at most 98 share the window', () => {
  const proposals = range(1, 99).map((n) => ({ ref: ref(n), distance: n * 1000 }));
  const focused = ref(500), interacted = ref(501);
  const visible = range(600, 640).map(ref);
  const allowed = new Set([...proposals.map((p) => p.ref), focused, interacted, ...visible]);
  const selected = selectReferenceWindow({ focused, interacted, proposals, visible }, allowed);
  assert.equal(selected.length, REFERENCE_WINDOW);
  for (const proposal of proposals) assert.ok(selected.includes(proposal.ref), `${proposal.ref} far below the fold is still read`);
  assert.ok(selected.includes(focused) && selected.includes(interacted));
  assert.deepEqual(selected, [...selected].sort());
});

test('100 distinct proposal targets plus a distinct focused citation: the farthest proposal waits, visible ones never do', () => {
  // Proposal 1 is the first in reading order but far above the viewport; proposal 100 is last and visible.
  const proposals = range(1, 101).map((n) => ({ ref: ref(n), distance: n === 100 ? 0 : (101 - n) * 100 }));
  const focused = ref(900);
  const allowed = new Set([...proposals.map((p) => p.ref), focused]);
  const selected = selectReferenceWindow({ focused, proposals, visible: [ref(100)] }, allowed);
  assert.equal(selected.length, REFERENCE_WINDOW, 'the selection stays bounded to 100 identities');
  assert.ok(selected.includes(focused), 'the focused citation keeps its slot');
  assert.ok(selected.includes(ref(100)), 'a visible proposal is read even when it is last in reading order');
  assert.ok(!selected.includes(ref(1)), 'only the proposal farthest from the viewport is left for later');
  assert.equal(proposals.filter((p) => !selected.includes(p.ref)).length, 1);
  // Scrolling up to it brings it into the window; the farthest one then waits instead.
  const scrolled = proposals.map((p, index) => ({ ...p, distance: index * 100 }));
  const after = selectReferenceWindow({ focused, proposals: scrolled, visible: [ref(1)] }, allowed);
  assert.ok(after.includes(ref(1)) && after.includes(focused) && !after.includes(ref(100)));
});

test('the window holds only allowed, distinct identities and visible citations fill what remains', () => {
  const allowed = new Set([ref(1), ref(2), ref(3)]);
  const selected = selectReferenceWindow({ focused: ref(9), interacted: ref(2), proposals: [{ ref: ref(2), distance: 0 }, { ref: ref(8), distance: 0 }], visible: [ref(3), ref(1), ref(3)] }, allowed);
  assert.deepEqual(selected, [ref(1), ref(2), ref(3)]);
  assert.deepEqual(selectReferenceWindow({ proposals: [], visible: [] }, allowed), []);
  const many = range(1, 300).map(ref);
  assert.equal(selectReferenceWindow({ proposals: [], visible: many }, new Set(many)).length, REFERENCE_WINDOW);
});
