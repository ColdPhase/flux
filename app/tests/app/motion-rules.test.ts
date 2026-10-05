import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrivalShouldAnimate, arrivals, loopShouldRun, newBelowText } from '../../apps/web/src/ui/motion-rules.js';

test('only entries after the newest one already shown are arrivals (#155 UI116-5)', () => {
  // The first render is restored history: nothing arrives.
  assert.deepEqual(arrivals(null, ['a', 'b', 'c']), []);
  assert.deepEqual(arrivals([], ['a', 'b']), []);
  // A new entry at the end arrived; an unchanged or refreshed list has none.
  assert.deepEqual(arrivals(['a', 'b'], ['a', 'b', 'c']), ['c']);
  assert.deepEqual(arrivals(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  // Earlier history joining above ("Load earlier", a link) never counts, even together with an arrival.
  assert.deepEqual(arrivals(['c', 'd'], ['a', 'b', 'c', 'd']), []);
  assert.deepEqual(arrivals(['c', 'd'], ['a', 'b', 'c', 'd', 'e']), ['e']);
  // An announcement placed between entries already shown is not an arrival at the end.
  assert.deepEqual(arrivals(['a', 'c'], ['a', 'b', 'c']), []);
  // The newest shown entry left (an edit or removal): arrivals follow the newest one still shown.
  assert.deepEqual(arrivals(['a', 'b', 'c'], ['a', 'b', 'd']), ['d']);
  // Nothing in common: another conversation or window, never an arrival.
  assert.deepEqual(arrivals(['a', 'b'], ['x', 'y']), []);
});

test('an arrival animates only when seen, without reduced motion, a hidden page or a modal', () => {
  const seen = { reduced: false, hidden: false, visible: true, obscured: false };
  assert.equal(arrivalShouldAnimate(seen), true);
  assert.equal(arrivalShouldAnimate({ ...seen, reduced: true }), false);
  assert.equal(arrivalShouldAnimate({ ...seen, hidden: true }), false);
  assert.equal(arrivalShouldAnimate({ ...seen, visible: false }), false);
  assert.equal(arrivalShouldAnimate({ ...seen, obscured: true }), false);
});

test('a looping mark runs only while it can be seen (#155 AC-4)', () => {
  assert.equal(loopShouldRun({ hidden: false, intersecting: true, obscured: false }), true);
  assert.equal(loopShouldRun({ hidden: true, intersecting: true, obscured: false }), false);
  assert.equal(loopShouldRun({ hidden: false, intersecting: false, obscured: false }), false);
  assert.equal(loopShouldRun({ hidden: false, intersecting: true, obscured: true }), false);
});

test('the new-below line names messages and tasks exactly', () => {
  assert.equal(newBelowText(0, 0), '');
  assert.equal(newBelowText(1, 0), '1 new message');
  assert.equal(newBelowText(3, 0), '3 new messages');
  assert.equal(newBelowText(0, 1), '1 new task');
  assert.equal(newBelowText(2, 2), '2 new messages · 2 new tasks');
});
