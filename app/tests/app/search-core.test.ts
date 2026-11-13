import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSearchWord, searchWordStem } from '@flux/contracts';
import { checkSearchGrammar, createSearchUseCases, markSearchWords, normalizeSearch, prefixQuery, searchGrammar, taskNumberQuery, usesSearchSyntax,
  type Principal, type SearchPlan, type SearchPorts, type SearchRow } from '@flux/core';

// Search query rules (#114, #276) as pure functions: no database, no network.
const UUID = '0f8fad5b-d9cb-469f-a165-8c45a5d2c123';

function refusal(code: string) {
  return { name: 'InvalidInputError', code };
}

test('a task number names one task, with or without the hash, and is never a prefix query', () => {
  assert.equal(taskNumberQuery('#2'), 2);
  assert.equal(taskNumberQuery('2'), 2);
  assert.equal(taskNumberQuery(' #12 '), 12);
  assert.equal(taskNumberQuery('2a'), null);
  assert.equal(prefixQuery('#2'), null);
  assert.equal(prefixQuery('2'), null);
});

test('a trailing word becomes a prefix, earlier words must match in full', () => {
  assert.equal(prefixQuery('hello'), 'hello:*');
  assert.equal(prefixQuery('Big Cat'), 'big & cat:*');
  assert.equal(prefixQuery('hello '), null, 'a query ending in a space is not a prefix');
  assert.equal(prefixQuery('draft 2'), 'draft & 2:*', 'a trailing number is a prefix too');
});

test('quotes, a bare or and -word switch to web search syntax', () => {
  for (const text of ['"exact phrase"', 'cats or dogs', 'cats -dogs', '-dogs']) {
    assert.equal(usesSearchSyntax(text), true, text);
    assert.equal(prefixQuery(text), null, text);
  }
  for (const text of ['color', 'order', 'orange', 'cats-dogs']) {
    assert.equal(usesSearchSyntax(text), false, text);
  }
});

test('a query of only words to leave out is refused with QUERY_NEEDS_WORD', () => {
  for (const text of ['-word', '-"a phrase"', '-a -b']) {
    assert.throws(() => checkSearchGrammar(text), refusal('QUERY_NEEDS_WORD'), text);
    assert.throws(() => normalizeSearch({ q: text }), refusal('QUERY_NEEDS_WORD'), text);
  }
});

test('or cannot be mixed with -word and is refused with QUERY_UNSUPPORTED', () => {
  for (const text of ['cats or -dogs', '-dogs or cats', 'cats OR -dogs']) {
    assert.throws(() => checkSearchGrammar(text), refusal('QUERY_UNSUPPORTED'), text);
    assert.throws(() => normalizeSearch({ q: text }), refusal('QUERY_UNSUPPORTED'), text);
  }
  assert.doesNotThrow(() => checkSearchGrammar('cats or dogs'));
});

test('a quoted "or" counts as a positive word, not as the operator', () => {
  assert.deepEqual(searchGrammar('"or"'), { positive: true, negation: false, or: false });
  assert.deepEqual(searchGrammar('cats or dogs'), { positive: true, negation: false, or: true });
  assert.doesNotThrow(() => checkSearchGrammar('-dogs "or"'));
  assert.equal(normalizeSearch({ q: '"or"' }).text, '"or"');
});

test('an empty or too-long query is refused', () => {
  assert.throws(() => normalizeSearch({ q: '' }), refusal('QUERY_REQUIRED'));
  assert.throws(() => normalizeSearch({ q: '   ' }), refusal('QUERY_REQUIRED'));
  assert.throws(() => normalizeSearch({}), refusal('QUERY_REQUIRED'));
  assert.throws(() => normalizeSearch({ q: 'a'.repeat(201) }), refusal('QUERY_TOO_LONG'));
  assert.equal(normalizeSearch({ q: 'a'.repeat(200) }).text.length, 200);
});

test('an unknown type is refused with INVALID_TYPE and a known one is kept', () => {
  assert.throws(() => normalizeSearch({ q: 'a', type: 'spreadsheet' as never }), refusal('INVALID_TYPE'));
  assert.equal(normalizeSearch({ q: 'a', type: 'doc' }).type, 'doc');
  assert.equal(normalizeSearch({ q: 'a', type: '' as never }).type, null);
});

test('a bad place is refused with INVALID_PLACE; project, dm and private are accepted', () => {
  for (const place of ['project:not-a-uuid', 'folder:' + UUID, 'private-ish', 'project:']) {
    assert.throws(() => normalizeSearch({ q: 'a', place }), refusal('INVALID_PLACE'), place);
  }
  assert.deepEqual(normalizeSearch({ q: 'a', place: `project:${UUID}` }).place, { type: 'project', id: UUID });
  assert.deepEqual(normalizeSearch({ q: 'a', place: `dm:${UUID.toUpperCase()}` }).place, { type: 'dm', id: UUID });
  assert.deepEqual(normalizeSearch({ q: 'a', place: 'private' }).place, { type: 'private' });
});

test('a bad author is refused with INVALID_AUTHOR; human and agent are accepted', () => {
  for (const author of ['robot:abc', 'human:', 'human:has space', 'agent:' + 'x'.repeat(65), 'abc']) {
    assert.throws(() => normalizeSearch({ q: 'a', author }), refusal('INVALID_AUTHOR'), author);
  }
  assert.deepEqual(normalizeSearch({ q: 'a', author: 'human:user_1' }).author, { kind: 'human', id: 'user_1' });
  assert.deepEqual(normalizeSearch({ q: 'a', author: 'agent:agent-2' }).author, { kind: 'agent', id: 'agent-2' });
});

// People's search on the BM25 index (F-042, #1293): which statement answers a query, and how its words are marked in the text.

test('words are folded the way the index folds them, and a longer form keeps the stem of the word', () => {
  assert.equal(foldSearchWord('Piątek'), 'piatek');
  assert.equal(foldSearchWord('Łódź'), 'lodz');
  assert.equal(foldSearchWord('Straße'), 'strasse');
  assert.equal(foldSearchWord('Crème brûlée'), 'creme brulee');
  assert.equal(searchWordStem('czujnik'), 'czujn');
  assert.equal(searchWordStem('calibrate'), 'calibra');
  assert.equal(searchWordStem('lamp'), 'lam');
  assert.equal(searchWordStem('sht'), 'sht', 'a word of three letters or fewer is exact');
});

test('the words a query names are marked in any longer form, with or without accents, and as far as they were typed', () => {
  const marks = (text: string, words: string[], typing: string | null = null) =>
    markSearchWords([{ text, match: false }], { words, typing }).map((part) => (part.match ? `[${part.text}]` : part.text)).join('');
  assert.equal(marks('Kalibracja czujników na dachu', ['czujnik']), 'Kalibracja [czujników] na dachu');
  assert.equal(marks('Kalibracja czujników w piątek', ['czujnikow', 'piatek']), 'Kalibracja [czujników] w [piątek]');
  assert.equal(marks('The sensors were calibrated', ['calibrate']), 'The sensors were [calibrated]');
  assert.equal(marks('Sensor comparison', ['com'], 'com'), 'Sensor [comparison]');
  assert.equal(marks('Sensor comparison', ['com']), 'Sensor comparison', 'a short word that is not being typed is exact');
  assert.equal(marks('The lamp and the lamb', ['the']), '[The] lamp and [the] lamb', 'a short word is exact');
  // A part the statement marked stays marked, and the rest of the text is split around it.
  const parts = markSearchWords([{ text: 'Camera or ', match: false }, { text: 'sensor', match: true }, { text: ' sensors', match: false }], { words: ['sensor'], typing: null });
  assert.deepEqual(parts, [{ text: 'Camera or ', match: false }, { text: 'sensor', match: true }, { text: ' ', match: false }, { text: 'sensors', match: true }]);
});

const reader: Principal = { kind: 'human', id: 'ari' };
const message = (text: string): SearchRow => ({
  position: { score: '0.5', at: '2026-11-01 10:00:00+00', id: '1' }, kind: 'message', workspaceId: 'w', workspaceName: 'W', objectId: 'm1', parentId: 'c1',
  projectId: 'p1', projectName: 'Lamp', dmName: null, sketchTitle: null, workNumber: null, version: null, currentVersion: null, status: null,
  title: [], snippet: [{ text, match: false }], hasBody: true, authorName: 'Ada', author: null, at: new Date('2026-11-01T10:00:00Z'),
});

function ports(calls: string[], rows: SearchRow[]): SearchPorts<null> {
  return {
    access: { audiences: async () => [{ type: 'project', workspaceId: 'w', condition: null }] },
    rows: {
      page: async (_audiences: unknown, plan: SearchPlan) => { calls.push(`page ${plan.text}`); return rows; },
      ranked: async (_audiences: unknown, plan: SearchPlan) => { calls.push(`ranked ${plan.words}|${plan.prefix ?? ''}`); return rows; },
      explain: async () => ({ rows: 0, indexRows: 0, searchBuffers: 0, buffers: 0, indexScans: 0, lookups: 0, nodes: [] }),
    },
    cursors: { seal: () => 'sealed', open: () => null },
  };
}

test('plain words are answered by the BM25 statement and the words are marked in the text; the web search syntax stays exact', async () => {
  const calls: string[] = [];
  const search = createSearchUseCases(ports(calls, [message('Kalibracja czujników na dachu')]));
  const answer = await search.search(reader, { q: 'Czujnik kalibr' });
  assert.deepEqual(calls, ['ranked czujnik kalibr|czujnik & kalibr:*']);
  assert.deepEqual(answer.items[0]!.title, [{ text: 'Kalibracja', match: true }, { text: ' ', match: false }, { text: 'czujników', match: true }, { text: ' na dachu', match: false }]);
  calls.length = 0;
  for (const q of ['"exact phrase"', 'cats or dogs', 'cats -dogs']) await search.search(reader, { q });
  assert.deepEqual(calls, ['page "exact phrase"', 'page cats or dogs', 'page cats -dogs']);
  calls.length = 0;
  assert.deepEqual(await search.search(reader, { q: '%_%' }), { items: [], next: null }, 'no letter or digit: nothing is asked');
  assert.deepEqual(calls, []);
});
