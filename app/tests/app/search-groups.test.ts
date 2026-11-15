import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionAppPath, searchTargetPath, type SearchKind, type SearchResult } from '@flux/contracts';
import { groupResults } from '../../apps/web/src/search/groups.js';
import { SEARCH_HINT } from '../../apps/web/src/search/hint.js';

const hit = (id: string, kind: SearchKind): SearchResult => ({
  id, kind, label: kind, title: [{ text: id, match: true }], snippet: null, place: { type: 'private' }, author: null, at: '2026-11-13T10:00:00.000Z',
  target: { type: 'sketch', sketchId: id },
});

// #1424: the server ranks the hits, best first. The groups follow that rank, so a weak task never stands above the message that answers the question.
// A saved source (kind `material`) stands in the Wiki group: Search has no Material kind (#1419 item 20).
test('the group of the best match leads and each group keeps the server order', () => {
  const groups = groupResults([hit('m1', 'message'), hit('d1', 'doc'), hit('m2', 'dm_message'), hit('t1', 'work'), hit('f1', 'file'), hit('x1', 'decision'), hit('v1', 'material'), hit('p1', 'person')]);
  assert.deepEqual(groups.map((group) => group.label), ['Messages', 'Wiki', 'Tasks', 'Files', 'Decisions', 'People']);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [['m1', 'm2'], ['d1', 'v1'], ['t1'], ['f1'], ['x1'], ['p1']]);
});

// Personas round (v0.2.1): a decision was listed under "Tasks" and opened over the Tasks view, whose own search could not find it, and the
// hint named no decisions. A decision is listed as a decision, opens as one over its space's conversation, and the hint names it.
test('a decision is listed under Decisions, opens over its conversation, and the hint names decisions', () => {
  const groups = groupResults([hit('x1', 'decision'), hit('t1', 'work')]);
  assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [['Decisions', ['x1']], ['Tasks', ['t1']]]);
  assert.equal(searchTargetPath({ type: 'decision', projectId: 'p-1', id: 'd-1' }), '/projects/p-1?open=decision:d-1');
  // One address for a decision everywhere: Search, the Inbox, notifications, Wiki references and Discuss share `decisionAppPath`.
  assert.equal(decisionAppPath('p-1', 'd-1'), searchTargetPath({ type: 'decision', projectId: 'p-1', id: 'd-1' }));
  assert.equal(searchTargetPath({ type: 'work', projectId: 'p-1', id: 'w-1' }), '/projects/p-1/tasks?open=work:w-1');
  assert.match(SEARCH_HINT, /\bdecisions\b/);
});

test('a task that ranks first keeps its group first, and nothing is listed twice', () => {
  const items = [hit('t1', 'work'), hit('m1', 'message'), hit('t2', 'work'), hit('th', 'thought'), hit('sk', 'sketch')];
  const groups = groupResults(items);
  assert.deepEqual(groups.map((group) => group.label), ['Tasks', 'Messages', 'Thoughts']);
  assert.equal(groups.flatMap((group) => group.items).length, items.length);
  assert.deepEqual(groupResults([]), []);
});
