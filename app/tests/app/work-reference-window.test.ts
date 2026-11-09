import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERENCE_WINDOW, selectReferenceWindow } from '../../apps/web/src/work/reference-window.js';

const ref = (n: number) => `work:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

test('the focused and the interacted reference keep their slots before the visible ones, and the window stays bounded and sorted', () => {
  const focused = ref(500), interacted = ref(501);
  const visible = range(1, 300).map(ref);
  const allowed = new Set([...visible, focused, interacted]);
  const selected = selectReferenceWindow({ focused, interacted, visible }, allowed);
  assert.equal(selected.length, REFERENCE_WINDOW, 'the selection stays bounded to 100 identities');
  assert.ok(selected.includes(focused) && selected.includes(interacted));
  assert.deepEqual(selected, [...selected].sort());
});

test('the window holds only allowed, distinct identities and visible citations fill what remains', () => {
  const allowed = new Set([ref(1), ref(2), ref(3)]);
  const selected = selectReferenceWindow({ focused: ref(9), interacted: ref(2), visible: [ref(3), ref(1), ref(3)] }, allowed);
  assert.deepEqual(selected, [ref(1), ref(2), ref(3)]);
  assert.deepEqual(selectReferenceWindow({ visible: [] }, allowed), []);
  const many = range(1, 300).map(ref);
  assert.equal(selectReferenceWindow({ visible: many }, new Set(many)).length, REFERENCE_WINDOW);
});
