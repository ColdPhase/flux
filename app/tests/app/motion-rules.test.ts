import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrivalShouldAnimate, arrivals, cssTimeToMs, loopShouldRun, newBelowText, routeView, viewDirection } from '../../apps/web/src/ui/motion-rules.js';

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

test('CSS times read in milliseconds whatever unit the minifier chose (#264)', () => {
  assert.equal(cssTimeToMs('180ms'), 180);
  assert.equal(cssTimeToMs('.18s'), 180);
  assert.equal(cssTimeToMs('0.2s'), 200);
  assert.equal(cssTimeToMs(' 130ms '), 130);
  assert.equal(cssTimeToMs('1S'), 1000);
  for (const off of ['0ms', '0s', '', 'none', 'auto', '12', '-5ms', 'calc(1s)']) assert.equal(cssTimeToMs(off), 0, off);
});

test('a view switch is a different view; a thread, a page or a sketch opened inside one is not (#593 AC-3)', () => {
  // Project views are told apart, and so are two projects.
  assert.notEqual(routeView('/projects/p1'), routeView('/projects/p1/tasks'));
  assert.notEqual(routeView('/projects/p1/tasks'), routeView('/projects/p1/map'));
  assert.notEqual(routeView('/projects/p1/tasks'), routeView('/projects/p2/tasks'));
  // A thread opening beside the conversation stays in the Conversation view.
  assert.equal(routeView('/projects/p1'), routeView('/projects/p1/conversations/c9'));
  // A page inside the Wiki and a sketch inside the Map stay in their view; the Wiki and the Map are views.
  assert.equal(routeView('/projects/p1/docs'), routeView('/projects/p1/docs/d3/edit'));
  assert.equal(routeView('/projects/p1/map'), routeView('/projects/p1/map/s2'));
  // Top-level places and Settings sections.
  assert.equal(routeView('/inbox'), routeView('/inbox/n1'));
  assert.notEqual(routeView('/inbox'), routeView('/search'));
  assert.notEqual(routeView('/settings'), routeView('/settings/appearance'));
  assert.notEqual(routeView('/settings/appearance'), routeView('/settings/account'));
  assert.equal(routeView('/dm/d1'), routeView('/dm/d1/'));
  assert.notEqual(routeView('/dm/d1'), routeView('/dm/d1/sketches'));
  assert.equal(routeView('/dm/d1/sketches'), routeView('/dm/d1/sketches/s1'));
  assert.notEqual(routeView('/dm'), routeView('/dm/new'));
  assert.notEqual(routeView('/projects'), routeView('/projects/new'));
  assert.equal(routeView('/materials/m1'), routeView('/materials/m1/versions/2'));
});

test('the way a view switch travels follows the project row, and Back reverses it (#593 AC-3)', () => {
  // Conversation, Map, Tasks, Wiki, Agents in the tabs' order: further along is forward, before is back.
  assert.equal(viewDirection('/projects/p1', '/projects/p1/tasks', false), 'forward');
  assert.equal(viewDirection('/projects/p1/tasks', '/projects/p1', false), 'back');
  assert.equal(viewDirection('/projects/p1/map', '/projects/p1/docs', false), 'forward');
  assert.equal(viewDirection('/projects/p1/agents', '/projects/p1/map', false), 'back');
  // Places and Settings sections have no row: the history decides.
  assert.equal(viewDirection('/inbox', '/search', false), 'forward');
  assert.equal(viewDirection('/search', '/inbox', true), 'back');
  assert.equal(viewDirection('/settings', '/settings/appearance', false), 'forward');
  // The row beats the history: going to a view further along is forward even by the browser's Forward.
  assert.equal(viewDirection('/projects/p1', '/projects/p1/tasks', true), 'forward');
});
