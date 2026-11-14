import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { excerpt, isQuestion, placeDecisionReference } from '@flux/core';
import { titleFromText } from '../../packages/core/src/assistant/jobs.js';
import { shortReason } from '../../packages/db/src/repositories/work-read-objects.js';
import { pageMarkdown } from '../../apps/web/src/docs/markdown-file.js';

// v0.2.1 audit #1270 (final pass). Text a member writes goes through a few regular expressions that were quadratic in its length, and a
// message or a page may be 100,000 characters: `?` followed by 100,000 spaces held the worker for 5.6 seconds (and the API once for every
// reader's Home), 100,000 `[` held a docs list for 4.9. Each case below took seconds before; the limit is generous so a slow machine passes,
// and the checks of the plain behaviour stay beside them.

const BIG = 100_000;
const FAST_MS = 400;

function within(label: string, work: () => unknown) {
  const start = process.hrtime.bigint();
  const result = work();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < FAST_MS, `${label} took ${ms.toFixed(0)} ms for ${BIG.toLocaleString()} characters (limit ${FAST_MS} ms)`);
  return result;
}

describe('text a person writes is read in linear time', () => {
  test('a question mark and a long run of spaces does not hold the process (isQuestion)', () => {
    assert.equal(within('isQuestion', () => isQuestion(`?${' '.repeat(BIG - 2)}x`)), true, 'a question mark before a space is a question');
    assert.equal(within('isQuestion', () => isQuestion(`${'a'.repeat(BIG)}?`)), true);
    assert.equal(within('isQuestion', () => isQuestion(`${'? '.repeat(BIG / 2)}x`)), true);
    assert.equal(within('isQuestion', () => isQuestion('?'.repeat(BIG) + 'x')), false, 'a run of question marks with no space or end is no question');
  });

  test('isQuestion answers as the pattern it replaces did, on every short text of a small alphabet', () => {
    const before = (body: string) => /\?\s*(\p{Emoji_Presentation})?\s*$/u.test(body.trim()) || /\?\s/.test(body);
    const alphabet = ['?', ' ', 'a', '\n', '\u{1F642}', '!', '\t'];
    let checked = 0;
    const walk = (text: string, depth: number) => {
      assert.equal(isQuestion(text), before(text), `isQuestion(${JSON.stringify(text)})`);
      checked += 1;
      if (depth) for (const letter of alphabet) walk(text + letter, depth - 1);
    };
    walk('', 6);
    assert.ok(checked > 100_000);
  });

  test('a page whose first line is 100,000 link openers lists at once (excerpt)', () => {
    const words = within('excerpt', () => excerpt(`${'['.repeat(BIG)}\nsecond line`));
    assert.equal(typeof words, 'string');
    assert.equal(excerpt('Plain [words](flux:doc/1) and **bold**\nnext'), 'Plain words and bold', 'the markup of an ordinary first line still goes');
    assert.equal(excerpt(`# Heading\n\n> ${'word '.repeat(100)}`).length, 160, 'the excerpt is still cut at its length');
  });

  test('a page that ends in a long run of spaces takes a decision reference without waiting (placeDecisionReference)', () => {
    const body = `Notes\n${' '.repeat(BIG)}x${' '.repeat(10)}`;
    const placed = within('placeDecisionReference', () => placeDecisionReference(body, '00000000-0000-4000-8000-000000000001', 'Use the gateway'));
    assert.match((placed as { body: string }).body, /\[Use the gateway\]\(flux:decision\/00000000-0000-4000-8000-000000000001\)/);
    assert.equal(within('pageMarkdown', () => pageMarkdown('Page', `text${' '.repeat(BIG)}`)), '# Page\n\ntext\n', 'a saved page ends at its last word');
  });

  test('a decision with a 20,000-character reason gets its card quickly (shortReason)', () => {
    within('shortReason', () => shortReason('['.repeat(20_000)));
    assert.equal(shortReason('Because the gateway is **faster**. It also costs less.'), 'Because the gateway is faster.');
    assert.equal(shortReason('See [the report](https://example.test/r) first. More.'), 'See the report first.');
  });

  test('a schedule sentence of punctuation and spaces names its row at once (titleFromText)', () => {
    within('titleFromText', () => titleFromText(`${'.'.repeat(BIG)}x`));
    assert.equal(titleFromText('Every Monday, summarise the week!!  '), 'Every Monday, summarise the week');
    assert.equal(titleFromText('...'), 'Schedule');
    assert.equal(titleFromText(`${'word '.repeat(40)}.`).endsWith('…'), true, 'a long first line is still cut at a word');
  });
});
