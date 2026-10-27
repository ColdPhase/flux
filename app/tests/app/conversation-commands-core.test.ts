import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { FILE_LIMITS, type ConversationRootQuery, type ConversationWindowQuery } from '@flux/contracts';
import {
  normalizeAttachmentIds,
  normalizeConversationWindow,
  normalizeMessage,
  normalizeRootWindow,
  optionalBody,
  optionalUrl,
  positiveVersion,
  requiredText,
} from '@flux/core';

// The command normalizers of messages, materials and conversation windows (#154, UI116-1). They
// turn what the API receives into validated values; `normalizeMessage` also builds the fingerprint
// that decides whether a retry replays a stored receipt. All are pure: no database, no network.

/** A refusal: an `InvalidInputError` with its stable code and the exact message. */
const refusal = (message: string) => ({ name: 'InvalidInputError', code: 'INVALID_INPUT', message });
/** A refusal whose message is not part of the rule under test. */
const anyRefusal = { name: 'InvalidInputError', code: 'INVALID_INPUT' };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The n-th well-formed lowercase UUID. */
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CLIENT = id(0xc1);
const MATERIAL = id(0xaa);

describe('requiredText', () => {
  test('trims the text', () => {
    assert.equal(requiredText('  hello  ', 'Title', 10), 'hello');
    assert.equal(requiredText('\n\ttabbed\n', 'Title', 10), 'tabbed');
    assert.equal(requiredText('inner  spaces stay', 'Title', 50), 'inner  spaces stay');
  });

  test('refuses empty and whitespace-only input, naming the label', () => {
    assert.throws(() => requiredText('', 'Subject', 10), refusal('Subject must be 1–10 characters'));
    assert.throws(() => requiredText('   \n\t ', 'Subject', 10), refusal('Subject must be 1–10 characters'));
  });

  test('refuses input that is too long, naming the label and the maximum', () => {
    assert.throws(() => requiredText('a'.repeat(11), 'Message', 10), refusal('Message must be 1–10 characters'));
    assert.throws(() => requiredText('a'.repeat(101), 'Title', 100), refusal('Title must be 1–100 characters'));
  });

  test('the maximum counts the trimmed text', () => {
    assert.equal(requiredText('a'.repeat(10), 'Title', 10), 'a'.repeat(10));
    assert.equal(requiredText(`  ${'a'.repeat(10)}  `, 'Title', 10), 'a'.repeat(10));
  });

  test('refuses a value that is not a string', () => {
    for (const value of [undefined, null, 5, {}, ['a']]) {
      assert.throws(() => requiredText(value, 'Title', 10), refusal('Title must be 1–10 characters'), JSON.stringify(value));
    }
  });
});

describe('optionalBody', () => {
  test('gives an empty string for undefined', () => {
    assert.equal(optionalBody(undefined), '');
  });

  test('keeps the text untrimmed', () => {
    assert.equal(optionalBody('  hi \n'), '  hi \n');
    assert.equal(optionalBody('   '), '   ');
    assert.equal(optionalBody(''), '');
  });

  test('refuses a value that is not a string, null included', () => {
    for (const value of [null, 5, true, {}, ['a']]) {
      assert.throws(() => optionalBody(value), refusal('Body must be at most 100000 characters'), JSON.stringify(value));
    }
  });

  test('accepts 100000 characters and refuses one more', () => {
    assert.equal(optionalBody('a'.repeat(100_000)).length, 100_000);
    assert.throws(() => optionalBody('a'.repeat(100_001)), refusal('Body must be at most 100000 characters'));
  });
});

describe('positiveVersion', () => {
  test('accepts 1 and larger safe integers', () => {
    assert.equal(positiveVersion(1, 'version'), 1);
    assert.equal(positiveVersion(42, 'version'), 42);
    assert.equal(positiveVersion(Number.MAX_SAFE_INTEGER, 'version'), Number.MAX_SAFE_INTEGER);
  });

  test('refuses 0, negatives, fractions, numeric strings and unsafe integers, naming the label', () => {
    const cases: [string, unknown][] = [['0', 0], ['-1', -1], ['1.5', 1.5], ['a numeric string', '1'], ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
      ['NaN', NaN], ['Infinity', Infinity], ['null', null], ['undefined', undefined]];
    for (const [name, value] of cases) {
      assert.throws(() => positiveVersion(value, 'expectedVersion'), refusal('expectedVersion must be a positive integer'), name);
    }
  });
});

describe('optionalUrl', () => {
  test('null, undefined and an empty string give null', () => {
    assert.equal(optionalUrl(null), null);
    assert.equal(optionalUrl(undefined), null);
    assert.equal(optionalUrl(''), null);
  });

  test('returns the normalized href', () => {
    assert.equal(optionalUrl('https://EXAMPLE.test'), 'https://example.test/');
    assert.equal(optionalUrl('http://example.test'), 'http://example.test/');
    assert.equal(optionalUrl('https://example.test/a%20b?q=1#top'), 'https://example.test/a%20b?q=1#top');
  });

  test('refuses a scheme other than http and https', () => {
    for (const url of ['ftp://example.test/file', 'javascript:alert(1)', 'mailto:a@example.test', 'file:///etc/passwd', 'data:text/plain,hi']) {
      assert.throws(() => optionalUrl(url), refusal('URL must be an HTTP or HTTPS URL'), url);
    }
  });

  test('refuses text that is not a URL', () => {
    for (const url of ['not a url', 'example.test', '/relative/path']) {
      assert.throws(() => optionalUrl(url), refusal('URL must be an HTTP or HTTPS URL'), url);
    }
  });

  test('accepts 2048 characters and refuses one more', () => {
    const prefix = 'https://example.test/';
    const longest = prefix + 'a'.repeat(2048 - prefix.length);
    assert.equal(longest.length, 2048);
    assert.equal(optionalUrl(longest), longest);
    assert.throws(() => optionalUrl(`${longest}a`), refusal('URL must be at most 2048 characters'));
  });

  test('refuses a value that is not a string', () => {
    for (const value of [5, true, {}, ['https://example.test/']]) assert.throws(() => optionalUrl(value), anyRefusal, JSON.stringify(value));
  });
});

describe('normalizeConversationWindow', () => {
  const windowOf = (query: unknown) => normalizeConversationWindow(query as ConversationWindowQuery);

  test('no input gives limit 50 and no cursor', () => {
    assert.deepEqual(normalizeConversationWindow(), { limit: 50, beforeSequence: null });
    assert.deepEqual(normalizeConversationWindow({}), { limit: 50, beforeSequence: null });
  });

  test('accepts numeric strings, as a query string sends them', () => {
    assert.deepEqual(windowOf({ limit: '20' }), { limit: 20, beforeSequence: null });
    assert.deepEqual(windowOf({ limit: '20', beforeSequence: '7' }), { limit: 20, beforeSequence: 7 });
  });

  test('the limit is 1 to 100', () => {
    assert.equal(windowOf({ limit: 1 }).limit, 1);
    assert.equal(windowOf({ limit: 100 }).limit, 100);
    for (const limit of [0, 101, -5, 1.5, 'abc', NaN, '0', '101']) {
      assert.throws(() => windowOf({ limit }), refusal('limit must be 1–100'), String(limit));
    }
  });

  test('the cursor is a positive integer', () => {
    assert.deepEqual(windowOf({ beforeSequence: 1 }), { limit: 50, beforeSequence: 1 });
    assert.deepEqual(windowOf({ beforeSequence: 12 }), { limit: 50, beforeSequence: 12 });
    for (const beforeSequence of [0, -1, 1.5, 'abc', NaN, '0']) {
      assert.throws(() => windowOf({ beforeSequence }), refusal('beforeSequence must be a positive integer'), String(beforeSequence));
    }
  });
});

describe('normalizeRootWindow', () => {
  const rootOf = (query: unknown) => normalizeRootWindow(query as ConversationRootQuery);

  test('no input gives limit 50 and no cursor', () => {
    assert.deepEqual(normalizeRootWindow(), { limit: 50, before: null });
    assert.deepEqual(normalizeRootWindow({}), { limit: 50, before: null });
  });

  test('lowercases an uppercase UUID in before', () => {
    const before = id(0xabcdef);
    assert.deepEqual(rootOf({ before: before.toUpperCase() }), { limit: 50, before });
    assert.deepEqual(rootOf({ before }), { limit: 50, before });
  });

  test('refuses a before that is not a UUID', () => {
    for (const before of ['not-a-uuid', '', ` ${id(1)}`, id(1).slice(1), `${id(1)}0`, 7, null]) {
      assert.throws(() => rootOf({ before }), refusal('before must be a UUID'), String(before));
    }
  });

  test('the limit is 1 to 100 and accepts a numeric string', () => {
    assert.equal(rootOf({ limit: '20' }).limit, 20);
    assert.equal(rootOf({ limit: 1 }).limit, 1);
    assert.equal(rootOf({ limit: 100 }).limit, 100);
    for (const limit of [0, 101, 1.5, 'abc']) assert.throws(() => rootOf({ limit }), refusal('limit must be 1–100'), String(limit));
  });
});

describe('normalizeAttachmentIds', () => {
  test('undefined and an empty list give []', () => {
    assert.deepEqual(normalizeAttachmentIds(undefined), []);
    assert.deepEqual(normalizeAttachmentIds([]), []);
  });

  test('keeps the order given and lowercases each id', () => {
    assert.deepEqual(normalizeAttachmentIds([id(3), id(1), id(2)]), [id(3), id(1), id(2)]);
    assert.deepEqual(normalizeAttachmentIds([id(0xa).toUpperCase(), id(0xb)]), [id(0xa), id(0xb)]);
  });

  test('refuses the same id again, in another letter case too', () => {
    assert.throws(() => normalizeAttachmentIds([id(0xa), id(0xa)]), refusal('attachmentIds must be distinct'));
    assert.throws(() => normalizeAttachmentIds([id(0xa), id(0xb), id(0xa).toUpperCase()]), refusal('attachmentIds must be distinct'));
  });

  test('accepts exactly the message file limit and refuses one more', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => id(index + 1));
    assert.equal(normalizeAttachmentIds(ids(FILE_LIMITS.messageFiles)).length, FILE_LIMITS.messageFiles);
    assert.throws(() => normalizeAttachmentIds(ids(FILE_LIMITS.messageFiles + 1)),
      refusal(`attachmentIds must list at most ${FILE_LIMITS.messageFiles} files`));
  });

  test('refuses a value that is not a list', () => {
    for (const value of [null, id(1), {}, 5]) {
      assert.throws(() => normalizeAttachmentIds(value), refusal(`attachmentIds must list at most ${FILE_LIMITS.messageFiles} files`), JSON.stringify(value));
    }
  });

  test('refuses an item that is not a UUID, naming its position', () => {
    assert.throws(() => normalizeAttachmentIds([id(1), 'file.txt']), refusal('attachmentIds[1] must be a UUID'));
    assert.throws(() => normalizeAttachmentIds([7]), refusal('attachmentIds[0] must be a UUID'));
  });
});

describe('normalizeMessage', () => {
  test('without attachmentIds the fingerprint is the SHA-256 of { body, source } with the trimmed body and a null source', () => {
    const message = normalizeMessage({ body: '  hello  ', clientMessageId: CLIENT });
    assert.equal(message.body, 'hello');
    assert.equal(message.source, null);
    assert.deepEqual(message.attachmentIds, []);
    assert.equal(message.fingerprint, createHash('sha256').update(JSON.stringify({ body: 'hello', source: null })).digest('hex'));
    // The key order is part of the shape: stored receipts were hashed from exactly this text.
    assert.equal(message.fingerprint, sha256('{"body":"hello","source":null}'));
  });

  test('an explicit empty attachmentIds list keeps the original fingerprint shape', () => {
    const plain = normalizeMessage({ body: 'hello', clientMessageId: CLIENT });
    const empty = normalizeMessage({ body: 'hello', clientMessageId: CLIENT, attachmentIds: [] });
    assert.equal(empty.fingerprint, plain.fingerprint);
  });

  test('a source is part of the fingerprint', () => {
    const message = normalizeMessage({ body: 'hello', clientMessageId: CLIENT, source: { materialId: MATERIAL, version: 3 } });
    assert.deepEqual(message.source, { materialId: MATERIAL, version: 3 });
    assert.equal(message.fingerprint, sha256(`{"body":"hello","source":{"materialId":"${MATERIAL}","version":3}}`));
  });

  test('attachments extend the fingerprint with their normalized ids', () => {
    const message = normalizeMessage({ body: 'hello', clientMessageId: CLIENT, attachmentIds: [id(2), id(1)] });
    assert.deepEqual(message.attachmentIds, [id(2), id(1)]);
    assert.equal(message.fingerprint, sha256(`{"body":"hello","source":null,"attachmentIds":["${id(2)}","${id(1)}"]}`));
    const upper = normalizeMessage({ body: 'hello', clientMessageId: CLIENT, attachmentIds: [id(2).toUpperCase(), id(1).toUpperCase()] });
    assert.equal(upper.fingerprint, message.fingerprint, 'letter case of an id does not change the fingerprint');
    const reordered = normalizeMessage({ body: 'hello', clientMessageId: CLIENT, attachmentIds: [id(1), id(2)] });
    assert.notEqual(reordered.fingerprint, message.fingerprint, 'the order of the files is part of the send');
  });

  test('a retry that differs only in surrounding whitespace has the same fingerprint, another text does not', () => {
    const first = normalizeMessage({ body: 'hello', clientMessageId: CLIENT });
    assert.equal(normalizeMessage({ body: '\n hello ', clientMessageId: CLIENT }).fingerprint, first.fingerprint);
    assert.notEqual(normalizeMessage({ body: 'hello!', clientMessageId: CLIENT }).fingerprint, first.fingerprint);
  });

  test('the text may be empty only when files are attached', () => {
    assert.throws(() => normalizeMessage({ body: '', clientMessageId: CLIENT }), refusal('Message must be 1–100000 characters'));
    assert.throws(() => normalizeMessage({ body: '  \n ', clientMessageId: CLIENT }), refusal('Message must be 1–100000 characters'));
    const withFile = normalizeMessage({ body: '  ', clientMessageId: CLIENT, attachmentIds: [id(1)] });
    assert.equal(withFile.body, '');
    assert.deepEqual(withFile.attachmentIds, [id(1)]);
  });

  test('the text is at most 100000 characters, with or without files', () => {
    const longest = 'a'.repeat(100_000);
    assert.equal(normalizeMessage({ body: longest, clientMessageId: CLIENT }).body, longest);
    assert.equal(normalizeMessage({ body: longest, clientMessageId: CLIENT, attachmentIds: [id(1)] }).body, longest);
    assert.throws(() => normalizeMessage({ body: `${longest}a`, clientMessageId: CLIENT }), refusal('Message must be 1–100000 characters'));
    assert.throws(() => normalizeMessage({ body: `${longest}a`, clientMessageId: CLIENT, attachmentIds: [id(1)] }),
      refusal('Message must be at most 100000 characters'));
  });

  test('refuses a missing command, a client id that is not a UUID and a bad attachment list', () => {
    assert.throws(() => normalizeMessage(null as never), refusal('Message is required'));
    assert.throws(() => normalizeMessage('hello' as never), refusal('Message is required'));
    assert.throws(() => normalizeMessage({ body: 'hello', clientMessageId: 'abc' }), refusal('clientMessageId must be a UUID'));
    assert.throws(() => normalizeMessage({ body: 'hello', clientMessageId: CLIENT, attachmentIds: [id(1), id(1)] }), refusal('attachmentIds must be distinct'));
  });

  test('refuses a source that does not identify a material version', () => {
    assert.throws(() => normalizeMessage({ body: 'hello', clientMessageId: CLIENT, source: null as never }), refusal('source must identify a material version'));
    assert.throws(() => normalizeMessage({ body: 'hello', clientMessageId: CLIENT, source: { materialId: 'x', version: 1 } }),
      refusal('source.materialId must be a UUID'));
    assert.throws(() => normalizeMessage({ body: 'hello', clientMessageId: CLIENT, source: { materialId: MATERIAL, version: 0 } }),
      refusal('source.version must be a positive integer'));
  });
});
