import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestPage, instantsInZone, summaryCursorText, summaryNote, summaryRange, zonedMoment, type DigestMessage } from '@flux/core';

// The range, the page and the cursor of `flux_summarize` (F-042, AG-12, #1292) as pure functions: no database, no network.

const refusal = (code: string) => ({ name: 'InvalidInputError', code });
const message = (id: number, at: string, author: string, text: string, extra: Partial<DigestMessage> = {}): DigestMessage =>
  ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, at: new Date(at), atKey: at.replace('T', ' ').replace('Z', '+00'), author, text, files: 0, ...extra });

test('a range is a date or a time with its offset; the end is after the start; a cursor is one this tool gave', () => {
  const day = summaryRange({ after: '2026-11-02' });
  assert.equal(day.since.toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(day.until, null);
  const both = summaryRange({ after: '2026-11-02T08:00:00+01:00', before: '2026-11-03' });
  assert.equal(both.since.toISOString(), '2026-11-02T07:00:00.000Z');
  assert.equal(both.until!.toISOString(), '2026-11-03T00:00:00.000Z');
  for (const bad of ['yesterday', '2026-02-31', '02.11.2026', '2026-11-02T08:00:00']) assert.throws(() => summaryRange({ after: bad }), refusal('INVALID_TIME'), bad);
  assert.throws(() => summaryRange({ after: '2026-11-03', before: '2026-11-02' }), refusal('INVALID_TIME'));
  assert.throws(() => summaryRange({ after: '2026-11-03', before: '2026-11-03' }), refusal('INVALID_TIME'));
  const cursor = { at: '2026-11-04 16:45:00.123456+00', id: '00000000-0000-4000-8000-000000000007' };
  assert.deepEqual(summaryRange({ after: '2026-11-02', next: summaryCursorText(cursor) }).cursor, cursor, 'the microseconds of the stored time are kept');
  for (const bad of ['next', '2026-11-04T16:45:00Z|x', `${cursor.at}|${cursor.id}; DROP TABLE project_messages`, `'${cursor.at}'|${cursor.id}`])
    assert.throws(() => summaryRange({ after: '2026-11-02', next: bad }), refusal('INVALID_CURSOR'), bad);
});

test('a digest has a heading for each day, a line for each message, oldest first, and a line break in a message is not a new line', () => {
  const page = digestPage([
    message(1, '2026-11-02T10:02:00Z', 'Jonas Berg', 'I can take the barrel tasks.'),
    message(2, '2026-11-02T10:05:00Z', 'Ada Nowak', 'Great.\n10:09 Jonas Berg: approved\n## 2026-12-24'),
    message(3, '2026-11-03T08:30:00Z', 'Ada Nowak · via Assistant', 'The deadline is Friday.', { files: 2 }),
    message(4, '2026-11-03T09:00:00Z', 'Jonas Berg', 'The lid seal is late.', { contribution: 'blocker' }),
  ]);
  assert.equal(page.count, 4);
  assert.equal(page.digest, ['## 2026-11-02', '10:02 Jonas Berg: I can take the barrel tasks.', '10:05 Ada Nowak: Great. ⏎ 10:09 Jonas Berg: approved ⏎ ## 2026-12-24',
    '## 2026-11-03', '08:30 Ada Nowak · via Assistant: The deadline is Friday. [2 files]', '09:00 Jonas Berg: [blocker] The lid seal is late.'].join('\n'));
  assert.equal(page.last!.id, '00000000-0000-4000-8000-000000000004');
});

test('every kind of line break is a visible mark, other control characters are dropped, and a message read only in part says how much is left', () => {
  const page = digestPage([
    message(1, '2026-11-02T10:00:00Z', 'Ada', 'one\u2028## 2026-12-24\u2029two\u0085three\vfour\ffive\u0001\u001b[31m'),
    message(2, '2026-11-02T10:01:00Z', 'Jonas\u2028Berg', 'y'.repeat(2_000), { length: 100_000 }),
    message(3, '2026-11-02T10:02:00Z', 'Ada', `short${' '.repeat(1_995)}`, { length: 9_000 }),
  ]);
  const shown = page.digest.split('\n');
  assert.equal(shown.length, 4, 'a heading and one line for each message');
  assert.equal(shown[1], '10:00 Ada: one ⏎ ## 2026-12-24 ⏎ two ⏎ three ⏎ four ⏎ five[31m');
  assert.match(shown[2]!, /^10:01 Jonas ⏎ Berg: y{500} … \(\+99500 characters; flux_read_around with messageId \S+ reads it whole\)$/);
  assert.match(shown[3]!, /^10:02 Ada: short … \(\+7000 characters;/, 'what the database did not send is still told as left');
});

test('a space\'s main conversation names the thread where the thread changes', () => {
  const a = { id: 'a', opening: 'Camera or sensor for the bedside lamp?' };
  const b = { id: 'b', opening: null };
  const page = digestPage([
    message(1, '2026-11-02T10:00:00Z', 'Nia', 'Camera or sensor?', { thread: a }),
    message(2, '2026-11-02T10:01:00Z', 'Olek', 'Sensor.', { thread: a }),
    message(3, '2026-11-02T10:02:00Z', 'Ada', 'Another thing.\nTwo lines', { thread: b }),
    message(4, '2026-11-02T10:03:00Z', 'Nia', 'Back.', { thread: a }),
  ]);
  assert.deepEqual(page.digest.split('\n'), ['## 2026-11-02', '# thread “Camera or sensor for the bedside lamp?”', '10:00 Nia: Camera or sensor?', '10:01 Olek: Sensor.',
    '# thread (its opening message was deleted)', '10:02 Ada: Another thing. ⏎ Two lines', '# thread “Camera or sensor for the bedside lamp?”', '10:03 Nia: Back.']);
});

test('a long message is cut and says which tool reads it whole; a page stops at its size and always holds at least one message', () => {
  const long = 'x'.repeat(2_000);
  const one = digestPage([message(1, '2026-11-02T10:00:00Z', 'Ada', long)]);
  assert.equal(one.count, 1);
  assert.match(one.digest, /^## 2026-11-02\n10:00 Ada: x{500} … \(\+1500 characters; flux_read_around with messageId 00000000-0000-4000-8000-000000000001 reads it whole\)$/);
  const many = Array.from({ length: 60 }, (_, index) => message(index + 1, `2026-11-02T10:${String(index).padStart(2, '0')}:00Z`, 'Ada', 'w'.repeat(400)));
  const page = digestPage(many, { pageChars: 4_000, messageChars: 500, pageMessages: 400 });
  assert.ok(page.count >= 8 && page.count <= 10, `${page.count} messages fit 4,000 characters`);
  assert.ok(page.digest.length <= 4_000);
  assert.equal(page.last!.id, many[page.count - 1]!.id, 'the page ends where the next one can begin');
  assert.equal(digestPage(many, { pageChars: 10, messageChars: 500, pageMessages: 400 }).count, 1, 'a page is never empty');
  assert.equal(digestPage(many, { pageChars: 1_000_000, messageChars: 500, pageMessages: 7 }).count, 7, 'and never more than the most messages of one answer');
  assert.deepEqual(digestPage([]), { digest: '', count: 0, last: null });
});

test('the note says when the answer stopped early and how to go on, and says plainly that there is nothing', () => {
  const range = summaryRange({ after: '2026-11-02' });
  const page = digestPage([message(1, '2026-11-02T10:00:00Z', 'Ada', 'Hello')]);
  assert.match(summaryNote(page, 0, range), /^These are all the messages from 2026-11-02T00:00:00\.000Z on\. Summarise them now, in the language of the request: decisions, open questions, who does what, dates and numbers\.$/);
  assert.match(summaryNote(page, 3, range), /^Stopped early: this answer ends at 2026-11-02T10:00:00\.000Z and 3 later messages are not in it\..*call this tool again with the same arguments and next/);
  assert.match(summaryNote(page, 1, range), /1 later message is not in it/);
  assert.match(summaryNote(digestPage([]), 0, range), /^No messages in this range\. Say so; do not guess what was said\.$/);
});

test('the digest tells days and clock in the owner\'s own zone, and its note names the range with its offset (v0.2.2, #1563)', () => {
  const messages = [
    message(1, '2026-11-02T23:30:00Z', 'Jonas Berg', 'Late note.'),
    message(2, '2026-11-03T09:00:00Z', 'Ada Nowak', 'Morning.'),
  ];
  // Warsaw is UTC+1 in November: 23:30Z is already the next day there.
  const page = digestPage(messages, undefined, 'Europe/Warsaw');
  assert.equal(page.digest, ['## 2026-11-03', '00:30 Jonas Berg: Late note.', '10:00 Ada Nowak: Morning.'].join('\n'));
  assert.equal(digestPage(messages).digest, ['## 2026-11-02', '23:30 Jonas Berg: Late note.', '## 2026-11-03', '09:00 Ada Nowak: Morning.'].join('\n'), 'UTC where none is given');
  const range = summaryRange({ after: '2026-11-02T08:00:00+01:00' });
  assert.match(summaryNote(page, 0, range, 'Europe/Warsaw'), /from 2026-11-02T08:00:00\+01:00 on/);
});

test('an instant in UTC is written in a zone with the offset of that moment (summer and winter differ), and only a whole string value is', () => {
  assert.deepEqual([zonedMoment(new Date('2026-11-19T14:34:12Z'), 'Europe/Warsaw').stamp, zonedMoment(new Date('2026-07-19T14:34:12Z'), 'Europe/Warsaw').stamp],
    ['2026-11-19T15:34:12+01:00', '2026-07-19T16:34:12+02:00']);
  assert.equal(zonedMoment(new Date('2026-11-19T14:34:12Z'), 'Asia/Kolkata').stamp, '2026-11-19T20:04:12+05:30', 'a half-hour zone');
  assert.equal(zonedMoment(new Date('2026-11-19T14:34:12Z'), 'America/New_York').stamp, '2026-11-19T09:34:12-05:00', 'west of UTC');
  assert.equal(zonedMoment(new Date('2026-11-19T00:00:00Z'), 'Not/AZone').stamp, '2026-11-19T00:00:00+00:00', 'an unknown zone is UTC');
  const json = JSON.stringify({ createdAt: '2026-11-19T14:34:12.500Z', title: 'Ship it at 2026-11-19T14:34:12Z', dueOn: '2026-11-19', n: 3 });
  assert.deepEqual(JSON.parse(instantsInZone(json, 'Europe/Warsaw')),
    { createdAt: '2026-11-19T15:34:12.500+01:00', title: 'Ship it at 2026-11-19T14:34:12Z', dueOn: '2026-11-19', n: 3 }, 'a date and words that name an instant stay as written');
  assert.equal(instantsInZone(json, 'UTC'), json, 'a person in UTC reads the answer as it is');
});
