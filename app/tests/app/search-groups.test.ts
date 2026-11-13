import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchKind, SearchResult } from '@flux/contracts';
import { groupResults } from '../../apps/web/src/search/groups.js';

const hit = (id: string, kind: SearchKind): SearchResult => ({
  id, kind, label: kind, title: [{ text: id, match: true }], snippet: null, place: { type: 'private' }, author: null, at: '2026-11-13T10:00:00.000Z',
  target: { type: 'sketch', sketchId: id },
});

// #1424: the server ranks the hits, best first. The groups follow that rank, so a weak task never stands above the message that answers the question.
test('the group of the best match leads and each group keeps the server order', () => {
  const groups = groupResults([hit('m1', 'message'), hit('d1', 'doc'), hit('m2', 'dm_message'), hit('t1', 'work'), hit('f1', 'file'), hit('x1', 'decision'), hit('v1', 'material'), hit('p1', 'person')]);
  assert.deepEqual(groups.map((group) => group.label), ['Messages', 'Wiki', 'Tasks', 'Files', 'People']);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [['m1', 'm2'], ['d1'], ['t1', 'x1'], ['f1', 'v1'], ['p1']]);
});

test('a task that ranks first keeps its group first, and nothing is listed twice', () => {
  const items = [hit('t1', 'work'), hit('m1', 'message'), hit('t2', 'work'), hit('th', 'thought'), hit('sk', 'sketch')];
  const groups = groupResults(items);
  assert.deepEqual(groups.map((group) => group.label), ['Tasks', 'Messages', 'Thoughts']);
  assert.equal(groups.flatMap((group) => group.items).length, items.length);
  assert.deepEqual(groupResults([]), []);
});
