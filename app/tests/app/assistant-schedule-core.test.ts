import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AssistantJobSchedule } from '@flux/contracts';
import { InvalidInputError } from '../../packages/core/src/access/errors.js';
import { nextRuns, parseCron, previewRuns, scheduleFields, scheduleWords, timeLabel } from '../../packages/core/src/assistant/schedule.js';

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

  test('C-14: no minimum interval: every minute, or two minutes apart, is a schedule like any other', () => {
    for (const cron of ['* * * * *', '*/2 * * * *', '0-10 9 * * *', '0,4 9 * * *', '0,58 * * * *', '*/5 * * * *', '0,30 * * * *', '*/15 9-17 * * 1-5', '0 * * * *', '15 9 * * 1-5', '0 9,10 * * *'])
      assert.doesNotThrow(() => scheduleFields({ kind: 'cron', cron }), cron);
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

describe('schedules: 9:00 stays 9:00 on the owner\'s wall clock across clock changes (#1168, C-57)', () => {
  const weekdays: AssistantJobSchedule = { kind: 'weekdays', at: '09:00' };
  const daily: AssistantJobSchedule = { kind: 'daily', at: '09:00' };
  /** The wall-clock time of each instant in the zone: what the person's screen shows. */
  const wall = (dates: Date[], timeZone: string) => dates.map((date) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date));

  test('Europe/Warsaw: weekdays at 9 over the autumn change (25 October 2026) and the spring one (28 March 2027)', () => {
    // Friday 9:00 is summer time (07:00Z); Monday 9:00 is winter time (08:00Z).
    const autumn = nextRuns(weekdays, 'Europe/Warsaw', at('2026-10-23T05:00:00Z'), 3);
    assert.deepEqual(iso(autumn), ['2026-10-23T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-10-27T08:00:00.000Z']);
    assert.deepEqual(wall(autumn, 'Europe/Warsaw'), ['Fri 09:00', 'Mon 09:00', 'Tue 09:00']);
    const spring = nextRuns(weekdays, 'Europe/Warsaw', at('2027-03-26T05:00:00Z'), 3);
    assert.deepEqual(iso(spring), ['2027-03-26T08:00:00.000Z', '2027-03-29T07:00:00.000Z', '2027-03-30T07:00:00.000Z']);
    assert.deepEqual(wall(spring, 'Europe/Warsaw'), ['Fri 09:00', 'Mon 09:00', 'Tue 09:00']);
    // The tick asks for the next time after the firing: the Monday after a Friday's run is still 9:00.
    assert.deepEqual(iso(nextRuns(weekdays, 'Europe/Warsaw', at('2026-10-23T07:00:30Z'), 1)), ['2026-10-26T08:00:00.000Z']);
    assert.deepEqual(iso(nextRuns(weekdays, 'Europe/Warsaw', at('2027-03-26T08:00:30Z'), 1)), ['2027-03-29T07:00:00.000Z']);
  });

  test('Europe/Warsaw: every day at 9 on the very days the clocks change', () => {
    assert.deepEqual(iso(nextRuns(daily, 'Europe/Warsaw', at('2026-10-24T05:00:00Z'), 3)), ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
    assert.deepEqual(iso(nextRuns(daily, 'Europe/Warsaw', at('2027-03-27T05:00:00Z'), 3)), ['2027-03-27T08:00:00.000Z', '2027-03-28T07:00:00.000Z', '2027-03-29T07:00:00.000Z']);
  });

  test('America/New_York: weekdays and every day at 9 over the autumn change (1 November 2026) and the spring one (14 March 2027)', () => {
    const autumn = nextRuns(weekdays, 'America/New_York', at('2026-10-30T10:00:00Z'), 3);
    assert.deepEqual(iso(autumn), ['2026-10-30T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
    assert.deepEqual(wall(autumn, 'America/New_York'), ['Fri 09:00', 'Mon 09:00', 'Tue 09:00']);
    const spring = nextRuns(weekdays, 'America/New_York', at('2027-03-12T10:00:00Z'), 3);
    assert.deepEqual(iso(spring), ['2027-03-12T14:00:00.000Z', '2027-03-15T13:00:00.000Z', '2027-03-16T13:00:00.000Z']);
    assert.deepEqual(wall(spring, 'America/New_York'), ['Fri 09:00', 'Mon 09:00', 'Tue 09:00']);
    assert.deepEqual(iso(nextRuns(daily, 'America/New_York', at('2026-10-31T10:00:00Z'), 2)), ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
    assert.deepEqual(iso(nextRuns(daily, 'America/New_York', at('2027-03-13T10:00:00Z'), 2)), ['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z']);
  });

  test('America/New_York: a time the spring change skips runs when the gap ends; one the autumn change repeats runs once', () => {
    // 2:30 does not exist on 14 March 2027 (2:00 jumps to 3:00 EDT, 07:00Z).
    assert.deepEqual(iso(nextRuns({ kind: 'daily', at: '02:30' }, 'America/New_York', at('2027-03-13T12:00:00Z'), 2)), ['2027-03-14T07:00:00.000Z', '2027-03-15T06:30:00.000Z']);
    // 1:30 happens twice on 1 November 2026 (05:30Z in EDT, 06:30Z in EST): only the first.
    assert.deepEqual(iso(nextRuns({ kind: 'daily', at: '01:30' }, 'America/New_York', at('2026-10-31T12:00:00Z'), 2)), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  });

  test('the words and the next times say 9:00 in the owner\'s zone, the hour it runs; in UTC the same words run at 10:00 in Warsaw', () => {
    assert.deepEqual(previewRuns(weekdays, 'Europe/Warsaw', at('2026-10-23T05:00:00Z')).map((item) => item.label), ['Fri 9:00', 'Mon 9:00', 'Tue 9:00']);
    assert.deepEqual(previewRuns(weekdays, 'America/New_York', at('2026-10-30T10:00:00Z')).map((item) => item.label), ['Fri 9:00', 'Mon 9:00', 'Tue 9:00']);
    assert.equal(scheduleWords(weekdays, 'Europe/Warsaw'), 'Weekdays at 9:00');
    // The defect of #1168: a schedule stored in UTC for a person in Warsaw says 9:00 and runs at 10:00 on their clock.
    assert.deepEqual(wall(nextRuns(weekdays, 'UTC', at('2026-11-10T05:00:00Z'), 1), 'Europe/Warsaw'), ['Tue 10:00']);
  });
});
