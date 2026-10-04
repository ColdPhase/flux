import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isQuestion, mentions } from '@flux/core';

// Pure addressing rules shared by notifications (#116) and the return view (#106). They pin today's
// behaviour; a mention only selects a reason and never grants access (#220).

test('a mention is "@name", "@first name" or a message that opens with the name and a comma or colon', () => {
  const cases: [body: string, name: string, expected: boolean][] = [
    ['@ari can you look?', 'Ari Kowal', true],
    ['@Ari Kowal thoughts?', 'Ari Kowal', true],
    ['(@ari)', 'Ari Kowal', true],
    ['Ari, check this', 'Ari Kowal', true],
    ['ARI: look', 'Ari Kowal', true],
    ['@Łucja', 'Łucja Nowak', true],
    ['Hi Ari, ok', 'Ari Kowal', false],
    ['mail ari@x.com', 'Ari Kowal', false],
    ['@Arianna', 'Ari Kowal', false],
    ['ask @ari_bot', 'Ari Kowal', false],
    ['@A', 'A', false],
  ];
  for (const [body, name, expected] of cases) assert.equal(mentions(body, name), expected, `mentions(${JSON.stringify(body)}, ${JSON.stringify(name)})`);
});

test('a question ends with a question mark (optionally an emoji) or has one before a space', () => {
  const cases: [body: string, expected: boolean][] = [
    ['Ready? 🙂', true],
    ['What?', true],
    ['What ?  ', true],
    ['Is it ready? I think so', true],
    ['Ready?!', false],
    ['No question.', false],
  ];
  for (const [body, expected] of cases) assert.equal(isQuestion(body), expected, `isQuestion(${JSON.stringify(body)})`);
});
