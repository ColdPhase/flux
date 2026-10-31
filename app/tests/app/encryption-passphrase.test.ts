import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFF_LARGE_WORDLIST } from '../../apps/web/src/encryption/eff-large-wordlist.js';
import {
  MIN_DISTINCT_CHARACTERS, MIN_PASSWORD_LENGTH, PASSPHRASE_WORDS, checkPassword, followsPattern, generatePassphrase, groupRecoveryCode, lengthOf, randomBelow, wordsOf,
} from '../../apps/web/src/encryption/passphrase.js';

// F-030 (#655, S3): the unlock password the creation form fills in (docs/product/encrypted-workspaces.md, "Password strength").

test('the EFF large wordlist has its 7,776 distinct words, none with a space', () => {
  const words = wordsOf(EFF_LARGE_WORDLIST);
  assert.equal(words.length, 7776);
  assert.equal(new Set(words).size, 7776);
  assert.equal(words[0], 'abacus');
  assert.equal(words.at(-1), 'zoom');
  for (const word of words) assert.match(word, /^[a-z]+(-[a-z]+)?$/);
});

test('a generated passphrase is six words of the list and meets the password rule', () => {
  const words = wordsOf(EFF_LARGE_WORDLIST);
  for (let round = 0; round < 200; round += 1) {
    const phrase = generatePassphrase(words);
    const picked = phrase.split(' ');
    assert.equal(picked.length, PASSPHRASE_WORDS);
    for (const word of picked) assert.ok(words.includes(word), word);
    assert.equal(checkPassword(phrase).problem, null);
  }
  assert.notEqual(generatePassphrase(words), generatePassphrase(words), 'two draws differ');
});

test('the random index is uniform: the biased tail of the 32-bit range is rejected, not folded in', () => {
  // With max 7776, the top 2^32 mod 7776 = 2560 values would be over-represented by a plain remainder. Feed the tail first, then a value.
  const queue = [0xffffffff, 0xfffff600, 7777];
  const index = randomBelow(7776, (words) => { words[0] = queue.shift()!; });
  assert.equal(index, 7777 % 7776);
  assert.equal(queue.length, 0, 'both tail values were rejected');
  assert.throws(() => randomBelow(0), RangeError);
  // A real source stays in range and covers it.
  const seen = new Set<number>();
  for (let round = 0; round < 3000; round += 1) {
    const value = randomBelow(10);
    assert.ok(value >= 0 && value < 10);
    seen.add(value);
  }
  assert.equal(seen.size, 10);
});

test('the password rule: 20 characters after NFC, at least 8 different ones', () => {
  assert.deepEqual(checkPassword(''), { length: 0, distinct: 0, problem: 'short' });
  assert.equal(checkPassword('a'.repeat(19)).problem, 'short');
  assert.equal(checkPassword('a'.repeat(40)).problem, 'few-different');
  assert.equal(checkPassword('abcdefgh'.repeat(3)).problem, 'patterned', 'long and different enough, but one block repeated');
  assert.equal(checkPassword('bright tulip granite').problem, null);
  assert.equal(checkPassword('abcdefg'.repeat(3)).problem, 'few-different', '21 characters but only 7 different ones');
  assert.equal(checkPassword('abcdefgh'.repeat(2)).problem, 'short');
  assert.equal(checkPassword('abcdefgh'.repeat(3)).length, 24);
  // NFC: a letter and its combining accent count once, so a string of 29 code points before normalising is 19 characters after it.
  const decomposed = 'é'.repeat(10) + 'abcdefghi';
  assert.equal(checkPassword(decomposed).length, 19);
  assert.equal(checkPassword(decomposed).problem, 'short');
  // Emoji count as one character each, not two.
  assert.equal(checkPassword('😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗').length, 20);
  assert.equal(MIN_PASSWORD_LENGTH, 20);
  assert.equal(MIN_DISTINCT_CHARACTERS, 8);
});

test('the length is described, never called strength', () => {
  assert.equal(lengthOf(checkPassword('short')), 'short');
  assert.equal(lengthOf(checkPassword('bright tulip granite')), 'long-enough');
  assert.equal(lengthOf(checkPassword('bright tulip granite quiet pond')), 'long');
  assert.equal(lengthOf(checkPassword('bright tulip granite quiet pond with seven small stones')), 'very-long');
  assert.equal(lengthOf(checkPassword('a'.repeat(50))), 'short', 'a long run of one character is not long enough');
});

test('a recovery code is shown as eight groups of four', () => {
  const code = 'K7QD2M9XABCD1234EFGH5678JKMN90PQ';
  assert.deepEqual(groupRecoveryCode(code), ['K7QD', '2M9X', 'ABCD', '1234', 'EFGH', '5678', 'JKMN', '90PQ']);
  assert.deepEqual(groupRecoveryCode('k7qd-2m9x-abcd-1234-efgh-5678-jkmn-90pq'), ['K7QD', '2M9X', 'ABCD', '1234', 'EFGH', '5678', 'JKMN', '90PQ']);
  assert.deepEqual(groupRecoveryCode('short'), ['short'], 'a code of another shape is shown as it is');
});

test('an obvious pattern is explained before sending; ordinary phrases and random words are not flagged', () => {
  for (const weak of ['abcdefghabcdefghabcd', 'qwertyuiopasdfghjklzxcvbnm', '12345678901234567890', 'passwordpasswordpassword', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihg', 'abababababababababab']) {
    assert.equal(followsPattern(weak), true, weak);
    assert.notEqual(checkPassword(weak).problem, null, weak);
  }
  for (const fine of ['seven loud geese in a hat', 'twelve quiet lamps by the sea', 'correct horse battery staple', 'Tr0ub4dor&3 is a bad idea', 'unchanged chewy movie finch override estranged']) {
    assert.equal(followsPattern(fine), false, fine);
    assert.equal(checkPassword(fine).problem, null, fine);
  }
  const words = wordsOf(EFF_LARGE_WORDLIST);
  for (let round = 0; round < 500; round += 1) assert.equal(followsPattern(generatePassphrase(words)), false);
  assert.equal(checkPassword('abcdefghabcdefghabcd').problem, 'patterned');
});
