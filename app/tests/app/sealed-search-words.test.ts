import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSealedSearch, docHeapCost, SealedSearchIndex, type IndexDoc, type SearchPlanRows } from '@flux/db';

// Plain words in an encrypted workspace (F-042, #1293): any of the words, the typed word as a prefix, a title with a typo, and the rarer word
// first, without stems. The index, its compile step and its search are pure (no database).

let n = 0;
function doc(title: string, body: string, audience = 'project:p', kind: IndexDoc['kind'] = 'message'): IndexDoc {
  n += 1;
  return { id: String(n), key: `${kind}:${n}`, kind, audience, workspaceId: 'w', projectId: 'p', objectId: `object-${n}`, parentId: null, version: null, status: null,
    author: { kind: 'human', id: 'user-1' }, at: new Date(1_700_000_000_000 + n), atKey: '2026-01-01 00:00:00+00', atMicros: BigInt(n), title, body, number: null, hidden: false,
    cost: docHeapCost(title, body), indexCost: 0 };
}

const plan = (text: string, extra: Partial<SearchPlanRows> = {}): SearchPlanRows => {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word.toLowerCase());
  const typing = /[\p{L}\p{N}]$/u.test(text) && words.length ? words[words.length - 1]! : null;
  return { text, prefix: typing ? [...words.slice(0, -1), `${typing}:*`].join(' & ') : null, fuzzy: true, number: null, words: words.join(' '), kinds: null, place: null, author: null,
    after: null, limit: 20, reader: 'user-1', anyWord: true, ...extra };
};
const find = (index: SealedSearchIndex, text: string, extra: Partial<SearchPlanRows> = {}) => {
  const p = plan(text, extra);
  return index.search(new Set(['project:p']), p, compileSealedSearch(p)).hits.sort((a, b) => b.score - a.score).map((hit) => hit.doc.title || hit.doc.body);
};

function sample() {
  const index = new SealedSearchIndex('w');
  for (const [title, body] of [
    ['', 'The sensor comparison covers the lamp and the camera.'],
    ['', 'Camera privacy is still the open question for the workshop.'],
    ['Use a time-of-flight sensor', 'Cameras raise privacy concerns at the stall.'],
    ['Sensor field notes', 'Notes about the sensor and the lamp enclosure.'],
    ['', 'Open with the lamp story.'],
    ['Infrared drifts in sunlight', ''],
    ['', 'Kalibracja czujników jest zaplanowana na piątek.'],
  ] as const) index.put(doc(title, body));
  for (let i = 0; i < 6; i += 1) index.put(doc('', `Lamp number ${i} is on the shelf.`));
  return index;
}

test('any of the words matches, and a word that is nowhere hides nothing', () => {
  const index = sample();
  assert.equal(find(index, 'sensor zeppelin').length, 3);
  assert.equal(find(index, 'zeppelin sunlight').length, 1);
  assert.deepEqual(find(index, 'zeppelin'), []);
  // Every word was required before: "sensor privacy" needed both. Now either finds a document, and the one with both leads.
  const both = find(index, 'sensor privacy');
  assert.equal(both[0], 'Use a time-of-flight sensor');
  assert.equal(both.length, 4, 'every document with either word');
});

test('the rarer word ranks first, a word in a title above one in a body', () => {
  const index = sample();
  // "lamp" is in nine documents, "sunlight" in one: the document with the rare word leads, though "lamp" is in more of them.
  assert.equal(find(index, 'lamp sunlight')[0], 'Infrared drifts in sunlight');
  // The same word: the title match leads the body match.
  const sensor = find(index, 'sensor');
  assert.ok(['Use a time-of-flight sensor', 'Sensor field notes'].includes(sensor[0]!), sensor[0]);
});

test('the word being typed is a prefix, a title tolerates a typo, and there are no stems', () => {
  const index = sample();
  assert.ok(find(index, 'sens').includes('Sensor field notes'));
  assert.ok(find(index, 'ultra sunl').includes('Infrared drifts in sunlight'), 'the earlier word is whole and the last is a prefix of the other document');
  assert.ok(find(index, 'ensor').includes('Sensor field notes'), 'a missing first letter');
  assert.ok(find(index, 'sensr notes').includes('Sensor field notes'));
  assert.deepEqual(find(index, 'czujnik zeppelin'), [], 'no stem: a whole czujnik is not czujników');
  assert.equal(find(index, 'czujnik', { prefix: null }).length, 0, 'and not as a word that is finished');
  assert.equal(find(index, 'czujnik').length, 1, 'but as far as it is typed it is the start of czujników');
  assert.equal(find(index, 'czujników zeppelin').length, 1);
  assert.deepEqual(find(index, 'piatek zeppelin'), [], 'no accent folding either');
});

test('a number names one task, quotes stay exact', () => {
  const index = new SealedSearchIndex('w');
  index.put(doc('Order 2 spare probes', ''));
  index.put(doc('Seal the barrel lid', '#2\n', 'project:p', 'work'));
  index.put(doc('Log the hedge readings', '#20\n', 'project:p', 'work'));
  const p = plan('2', { number: 2, prefix: null });
  const hits = index.search(new Set(['project:p']), p, compileSealedSearch(p)).hits.sort((a, b) => b.score - a.score);
  assert.equal(hits[0]!.doc.title, 'Seal the barrel lid', 'the task numbered 2 leads');
  assert.ok(!hits.some((hit) => hit.doc.title === 'Log the hedge readings'), 'not #20 by prefix');
  // Quotes and `or` are answered as before: every word of a phrase, adjacent.
  const exact = sample();
  const quoted = plan('"sensor comparison"', { anyWord: false, prefix: null, fuzzy: false });
  assert.equal(exact.search(new Set(['project:p']), quoted, compileSealedSearch(quoted)).hits.length, 1);
  const every = plan('sensor privacy', { anyWord: false });
  assert.equal(exact.search(new Set(['project:p']), every, compileSealedSearch(every)).hits.length, 1, 'without anyWord, every word is required, as before');
});

test('the weight of a word is that of its own audience: documents of another audience do not move the ranking', () => {
  const index = sample();
  const before = find(index, 'lamp sunlight');
  for (let i = 0; i < 50; i += 1) index.put(doc('', `lamp sunlight ${i}`, 'project:hidden'));
  assert.deepEqual(find(index, 'lamp sunlight'), before, 'same hits in the same order');
});
