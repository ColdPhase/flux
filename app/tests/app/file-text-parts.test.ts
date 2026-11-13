import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EMBED_TEXT_LIMIT, FILE_TEXT_EXTENSIONS, FILE_TEXT_LIMITS, fileTextFormat, splitIntoParts } from '@flux/core';
import { pool } from './support/db.js';

// C-63, #1382: the text of a file becomes search rows of about 4,000 characters each. The cutting is pure and linear; these pin what the rows hold.

const limits = { partChars: 100, maxChars: 1000 };
const joined = (parts: { text: string }[]) => parts.map((part) => part.text).join('');

describe('splitIntoParts', () => {
  test('parts joined are the text, each at most the limit, cut at a line break or a space', () => {
    const text = Array.from({ length: 60 }, (_, index) => `line ${index} has some words in it`).join('\n');
    const { parts, truncated } = splitIntoParts([{ text }], { partChars: 100, maxChars: 100_000 });
    assert.equal(truncated, false);
    assert.equal(joined(parts), text);
    assert.ok(parts.every((part) => part.text.length <= 100), 'no part is longer than the limit');
    assert.ok(parts.every((part, index) => index === parts.length - 1 || /[\n ]$/.test(part.text)), 'a part ends at a line break or a space');
    assert.deepEqual(parts.map((part) => part.part), parts.map((_, index) => index + 1), 'numbered from 1');
  });

  test('a part never crosses a page, a long page is several parts of its own number, and a part says the page where it begins', () => {
    const { parts } = splitIntoParts([{ text: 'one', page: 1 }, { text: 'two', page: 2 }, { text: 'x'.repeat(90), page: 3 }, { text: 'four', page: 4 }], limits);
    assert.deepEqual(parts.map((part) => [part.page, part.text]), [[1, 'one\n'], [2, 'two\n'], [3, `${'x'.repeat(90)}\n`], [4, 'four']], 'one part for each page');
    assert.equal(joined(parts), 'one\ntwo\n' + 'x'.repeat(90) + '\nfour');
    const long = splitIntoParts([{ text: `${'word '.repeat(60)}`, page: 7 }, { text: 'next', page: 8 }], limits).parts;
    assert.ok(long.length > 3 && long.slice(0, -1).every((part) => part.page === 7) && long[long.length - 1]!.page === 8, 'a long page keeps its number for each of its parts');
    const text = splitIntoParts([{ text: 'a line\n'.repeat(40) }], limits).parts;
    assert.ok(text.length > 1 && text.every((part) => part.page === null), 'a text without pages has no page');
  });

  test('a text over the limit stops at it and says so; a word without a space is cut at the part limit; NUL goes; no surrogate pair is split', () => {
    const long = splitIntoParts([{ text: 'a'.repeat(5000) }], limits);
    assert.equal(long.truncated, true);
    assert.equal(long.chars, 1000);
    assert.ok(long.parts.every((part) => part.text.length <= 100));
    const nul = splitIntoParts([{ text: 'ab\u0000cd' }], limits);
    assert.equal(joined(nul.parts), 'abcd');
    const emoji = splitIntoParts([{ text: '😀'.repeat(200) }], { partChars: 100, maxChars: 1000 });
    for (const part of emoji.parts) assert.ok(!/[\ud800-\udbff]$/.test(part.text) && !/^[\udc00-\udfff]/.test(part.text), 'a pair stays whole');
  });

  test('the real limits: a part is what the embeddings embed of a row, and a worst-case text stays a few dozen rows', () => {
    assert.equal(FILE_TEXT_LIMITS.partChars, EMBED_TEXT_LIMIT);
    const pages = Array.from({ length: FILE_TEXT_LIMITS.pages }, (_, index) => ({ text: `${index} `.padEnd(2100, 'w'), page: index + 1 }));
    const { parts } = splitIntoParts(pages, { partChars: FILE_TEXT_LIMITS.partChars, maxChars: FILE_TEXT_LIMITS.chars });
    assert.ok(parts.length >= 90 && parts.length <= FILE_TEXT_LIMITS.pages, `one part for each page, as far as the characters kept reach (${parts.length})`);
    assert.equal(new Set(parts.map((part) => part.page)).size, parts.length, 'each part is of a page of its own');
    assert.ok(parts.every((part) => part.text.length <= FILE_TEXT_LIMITS.partChars));
    const start = Date.now();
    splitIntoParts([{ text: 'x'.repeat(FILE_TEXT_LIMITS.chars * 20) }], { partChars: FILE_TEXT_LIMITS.partChars, maxChars: FILE_TEXT_LIMITS.chars });
    assert.ok(Date.now() - start < 2000, 'cutting a huge text without a space is linear');
  });
});

describe('the files whose text is read', () => {
  test('by their names, the list in core is the list in the database', async () => {
    for (const extension of FILE_TEXT_EXTENSIONS) {
      assert.ok(fileTextFormat(`Report.${extension.toUpperCase()}`), extension);
      assert.equal((await pool.query('SELECT file_text_extractable($1) AS yes', [`Report.${extension}`])).rows[0].yes, true, extension);
    }
    for (const name of ['photo.jpg', 'clip.mp4', 'sheet.xlsx', 'deck.pptx', 'notes.pdf.exe', 'pdf', '.pdf2', 'data.json', 'page.html', 'archive.zip']) {
      assert.equal(fileTextFormat(name), null, name);
      assert.equal((await pool.query('SELECT file_text_extractable($1) AS yes', [name])).rows[0].yes, false, name);
    }
    assert.equal(fileTextFormat('a.pdf'), 'pdf');
    assert.equal(fileTextFormat('a.docx'), 'docx');
    assert.equal(fileTextFormat('a.csv'), 'text');
  });
});
