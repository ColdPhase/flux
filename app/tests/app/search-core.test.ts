import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSearchGrammar, normalizeSearch, prefixQuery, searchGrammar, taskNumberQuery, usesSearchSyntax } from '@flux/core';

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
