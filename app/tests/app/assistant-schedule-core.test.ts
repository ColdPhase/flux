import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AssistantJobSchedule } from '@flux/contracts';
import { InvalidInputError } from '../../packages/core/src/access/errors.js';
import { nextRuns, parseCron, previewRuns, scheduleFields, scheduleWords, timeLabel, TOO_OFTEN } from '../../packages/core/src/assistant/schedule.js';

// F-027 AST-7 "When" (A8 #408): the schedule picker's kinds and cron become the same calendar, found in the
// owner's time zone. Pure; the clock is always the `after` argument.

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());
const at = (value: string) => new Date(value);

describe('schedules: next times in the owner\'s own time zone', () => {
  test('every Monday at 9:00 in Warsaw, across the autumn clock change', () => {
    const weekly: AssistantJobSchedule = { kind: 'weekly', at: '09:00', weekday: 1 };
    // 2026-10-24 is a Saturday; summer time ends on Sunday 25 October at 03:00.
    assert.deepEqual(iso(nextRuns(weekly, 'Europe/Warsaw', at('2026-10-24T12:00:00Z'), 3)),
      ['2026-10-26T08:00:00.000Z', '2026-11-02T08:00:00.000Z', '2026-11-09T08:00:00.000Z']);
    assert.deepEqual(iso(nextRuns(weekly, 'Europe/Warsaw', at('2026-10-19T06:59:59Z'), 1)), ['2026-10-19T07:00:00.000Z']);
    assert.deepEqual(iso(nextRuns(weekly, 'Europe/Warsaw', at('2026-10-19T07:00:00Z'), 1)), ['2026-10-26T08:00:00.000Z'], 'strictly after the given time');
  });

  test('weekdays and every day', () => {
    const weekdays: AssistantJobSchedule = { kind: 'weekdays', at: '09:00' };
    // Friday 16 October 2026 after 9:00 -> Monday 19.
    assert.deepEqual(iso(nextRuns(weekdays, 'UTC', at('2026-10-16T09:30:00Z'), 2)), ['2026-10-19T09:00:00.000Z', '2026-10-20T09:00:00.000Z']);
    assert.deepEqual(iso(nextRuns({ kind: 'daily', at: '08:30' }, 'America/New_York', at('2026-10-16T12:00:00Z'), 2)),
      ['2026-10-16T12:30:00.000Z', '2026-10-17T12:30:00.000Z']);
  });

  test('every hour while I work: 9:00 to 17:00 on weekdays, editable', () => {
    const hourly: AssistantJobSchedule = { kind: 'hourly', from: '09:00', to: '17:00' };
    assert.deepEqual(iso(nextRuns(hourly, 'UTC', at('2026-10-16T15:30:00Z'), 4)),
      ['2026-10-16T16:00:00.000Z', '2026-10-16T17:00:00.000Z', '2026-10-19T09:00:00.000Z', '2026-10-19T10:00:00.000Z']);
    const narrow: AssistantJobSchedule = { kind: 'hourly', from: '10:30', to: '12:00' };
    assert.deepEqual(iso(nextRuns(narrow, 'UTC', at('2026-10-16T00:00:00Z'), 3)),
      ['2026-10-16T10:30:00.000Z', '2026-10-16T11:30:00.000Z', '2026-10-19T10:30:00.000Z']);
    assert.throws(() => scheduleFields({ kind: 'hourly', from: '17:00', to: '09:00' }), InvalidInputError);
  });

  test('a time that does not exist runs at the end of the gap, and a repeated one runs once', () => {
    const night: AssistantJobSchedule = { kind: 'daily', at: '02:30' };
    // Warsaw jumps from 02:00 to 03:00 on 29 March 2026 (01:00Z).
    assert.deepEqual(iso(nextRuns(night, 'Europe/Warsaw', at('2026-03-28T12:00:00Z'), 2)), ['2026-03-29T01:00:00.000Z', '2026-03-30T00:30:00.000Z']);
    // Clocks repeat 02:00-03:00 on 25 October 2026; 02:30 happens at 00:30Z and again at 01:30Z: once.
    assert.deepEqual(iso(nextRuns(night, 'Europe/Warsaw', at('2026-10-24T12:00:00Z'), 2)), ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
  });

  test('a one-off runs once, in the future only', () => {
    const once: AssistantJobSchedule = { kind: 'once', at: '2026-10-17T14:00:00.000Z' };
    assert.deepEqual(iso(nextRuns(once, 'UTC', at('2026-10-17T13:00:00Z'), 3)), ['2026-10-17T14:00:00.000Z']);
    assert.deepEqual(nextRuns(once, 'UTC', at('2026-10-17T14:00:00Z'), 3), []);
  });

  test('cron under More: lists, ranges and steps; day of month and weekday together mean either', () => {
    assert.deepEqual(iso(nextRuns({ kind: 'cron', cron: '0 9 * * 1,3' }, 'UTC', at('2026-10-16T00:00:00Z'), 3)),
      ['2026-10-19T09:00:00.000Z', '2026-10-21T09:00:00.000Z', '2026-10-26T09:00:00.000Z']);
    assert.deepEqual(iso(nextRuns({ kind: 'cron', cron: '15 */6 * * *' }, 'UTC', at('2026-10-16T05:00:00Z'), 3)),
      ['2026-10-16T06:15:00.000Z', '2026-10-16T12:15:00.000Z', '2026-10-16T18:15:00.000Z']);
    assert.deepEqual(iso(nextRuns({ kind: 'cron', cron: '0 8 1,15 * 5' }, 'UTC', at('2026-10-01T09:00:00Z'), 3)),
      ['2026-10-02T08:00:00.000Z', '2026-10-09T08:00:00.000Z', '2026-10-15T08:00:00.000Z']);
    assert.deepEqual(iso(nextRuns({ kind: 'cron', cron: '0 12 29 2 *' }, 'UTC', at('2026-10-01T00:00:00Z'), 1)), ['2028-02-29T12:00:00.000Z']);
    assert.deepEqual(iso(nextRuns({ kind: 'cron', cron: '30 7 * JAN-MAR MON' }, 'UTC', at('2026-12-31T00:00:00Z'), 1)), ['2027-01-04T07:30:00.000Z']);
  });

  test('AST-7.10: more than once an hour is refused with "At most once an hour"', () => {
    for (const cron of ['*/5 * * * *', '0,30 * * * *', '* * * * *', '0-10 9 * * *']) {
      assert.throws(() => scheduleFields({ kind: 'cron', cron }), (error: unknown) => error instanceof InvalidInputError && error.message === TOO_OFTEN, cron);
    }
    for (const cron of ['0 * * * *', '15 9 * * 1-5', '0 9,10 * * *']) assert.doesNotThrow(() => scheduleFields({ kind: 'cron', cron }), cron);
  });

  test('cron that is not a schedule is refused in plain words', () => {
    for (const cron of ['', '0 9 * *', '0 9 * * * *', '60 9 * * *', '0 25 * * *', '0 9 32 * *', '0 9 * 13 *', '0 9 * * 8', '@daily', 'a b c d e', '0 9 */0 * *', '5-1 9 * * *']) {
      assert.throws(() => parseCron(cron), InvalidInputError, cron);
    }
  });
});

describe('schedules: plain words and labels', () => {
  test('the row says the schedule in words', () => {
    assert.equal(scheduleWords({ kind: 'weekly', at: '09:00', weekday: 1 }, 'UTC'), 'Every Monday at 9:00');
    assert.equal(scheduleWords({ kind: 'weekly', at: '16:00', weekday: 5 }, 'UTC'), 'Every Friday at 16:00');
    assert.equal(scheduleWords({ kind: 'weekly', at: '10:00', weekday: 7 }, 'UTC'), 'Every Sunday at 10:00');
    assert.equal(scheduleWords({ kind: 'daily', at: '08:30' }, 'UTC'), 'Every day at 8:30');
    assert.equal(scheduleWords({ kind: 'weekdays', at: '09:00' }, 'UTC'), 'Weekdays at 9:00');
    assert.equal(scheduleWords({ kind: 'hourly', from: '09:00', to: '17:00' }, 'UTC'), 'Every hour, weekdays 9:00–17:00');
    assert.equal(scheduleWords({ kind: 'once', at: '2026-10-17T12:00:00.000Z' }, 'Europe/Warsaw'), 'Once, Sat 17 Oct at 14:00');
  });

  test('cron is shown back in plain words', () => {
    const words = (cron: string) => scheduleWords({ kind: 'cron', cron }, 'UTC');
    assert.equal(words('0 9 * * 1-5'), 'Weekdays at 9:00');
    assert.equal(words('0 9 * * *'), 'Every day at 9:00');
    assert.equal(words('0 9 * * 1'), 'Every Monday at 9:00');
    assert.equal(words('30 8 * * 1,3'), 'At 8:30 on Monday and Wednesday');
    assert.equal(words('0 9,12,15 * * *'), 'At 9:00, 12:00 and 15:00, every day');
    assert.equal(words('0 * * * *'), 'Every hour');
    assert.equal(words('15 * * * 1-5'), 'Every hour at :15, weekdays');
    assert.equal(words('0 9 1 * *'), 'At 9:00 on day 1 of the month');
    assert.equal(words('0 9 1 6 *'), 'At 9:00 on day 1 of the month in Jun');
  });

  test('AST-7.10: the next three times in words, in the owner\'s time zone', () => {
    const preview = previewRuns({ kind: 'cron', cron: '0 9 * * 2-4' }, 'Europe/Warsaw', at('2026-10-17T10:00:00Z'));
    assert.deepEqual(preview.map((item) => item.label), ['Tue 9:00', 'Wed 9:00', 'Thu 9:00']);
    assert.equal(timeLabel(at('2026-10-26T08:00:00Z'), 'Europe/Warsaw', at('2026-10-19T10:00:00Z')), 'Mon 9:00', 'seven days away is still named by its weekday');
    assert.equal(timeLabel(at('2026-10-26T08:00:00Z'), 'Europe/Warsaw', at('2026-10-18T10:00:00Z')), 'Mon 26 Oct 9:00', 'beyond a week it names the date');
  });
});
