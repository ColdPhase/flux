import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIdempotencyKey, requestHash } from '@flux/core';

// Idempotency key parsing and request hashing (#86) as pure functions: no database, no network.
// A retry is matched to its first run by requestHash, so its canonical form must stay stable.

const refusal = { name: 'InvalidInputError', code: 'INVALID_IDEMPOTENCY_KEY' };

test('an absent key is null, and visible ASCII keys of 1 to 255 characters are accepted', () => {
  assert.equal(parseIdempotencyKey(undefined), null);
  assert.equal(parseIdempotencyKey('a'), 'a');
  assert.equal(parseIdempotencyKey('!'), '!');
  assert.equal(parseIdempotencyKey('~'), '~');
  assert.equal(parseIdempotencyKey('key-1_2.3:4'), 'key-1_2.3:4');
  const longest = 'k'.repeat(255);
  assert.equal(parseIdempotencyKey(longest), longest);
});

test('empty, too long, spaced, non-ASCII and non-string keys are refused', () => {
  const refused: unknown[] = ['', 'k'.repeat(256), 'a b', ' a', 'a\n', 'café', 'ключ', 42, null, {}, ['a']];
  for (const value of refused) {
    assert.throws(() => parseIdempotencyKey(value), refusal, String(value));
  }
});

test('the same request hashes the same whatever the order of its object keys, at any depth', () => {
  const a = { title: 'Ship', owner: { id: 'u1', role: 'lead' }, tags: ['x'] };
  const b = { tags: ['x'], owner: { role: 'lead', id: 'u1' }, title: 'Ship' };
  assert.equal(requestHash(a), requestHash(b));
  assert.notEqual(requestHash(a), requestHash({ ...a, title: 'Ship!' }), 'a changed value changes the hash');
});

test('a field set to undefined hashes like a missing field', () => {
  assert.equal(requestHash({ a: 1, b: undefined }), requestHash({ a: 1 }));
  assert.equal(requestHash({ a: { b: undefined, c: 2 } }), requestHash({ a: { c: 2 } }));
});

test('array order matters', () => {
  assert.notEqual(requestHash({ ids: [1, 2] }), requestHash({ ids: [2, 1] }));
});

test('null and undefined requests hash the same', () => {
  assert.equal(requestHash(null), requestHash(undefined));
  assert.notEqual(requestHash(null), requestHash({}));
});
