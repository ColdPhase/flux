import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { scheduledSummaryDay } from '../../packages/core/src/notifications/summary-schedule.js';

const due = (at: number, zone: string, now: string) => scheduledSummaryDay(at, zone, new Date(now));

describe('morning-summary calendar schedule', () => {
  test('the 15-minute tick catches 23:46 and 23:59 after midnight for the scheduled day', () => {
    for (const at of [23 * 60 + 46, 23 * 60 + 59]) {
      assert.equal(due(at, 'UTC', '2026-10-08T23:45:00Z'), null, 'not before the chosen time');
      assert.equal(due(at, 'UTC', '2026-10-09T00:00:00Z'), '2026-10-08');
      assert.equal(due(at, 'UTC', '2026-10-09T00:15:00Z'), '2026-10-08', 'another tick keeps the same claim date');
      assert.equal(due(at, 'UTC', '2026-10-10T00:00:00Z'), '2026-10-09', 'the next scheduled day gets its own identity');
    }
  });

  test('the three-hour catch-up window is half-open, including across midnight', () => {
    const at = 23 * 60 + 59;
    assert.equal(due(at, 'UTC', '2026-10-08T23:58:59Z'), null);
    assert.equal(due(at, 'UTC', '2026-10-08T23:59:00Z'), '2026-10-08');
    assert.equal(due(at, 'UTC', '2026-10-09T02:58:59Z'), '2026-10-08');
    assert.equal(due(at, 'UTC', '2026-10-09T02:59:00Z'), null);
  });

  test('midnight and year boundaries use local calendar dates', () => {
    assert.equal(due(0, 'UTC', '2026-10-09T00:00:00Z'), '2026-10-09');
    assert.equal(due(23 * 60 + 59, 'Europe/Warsaw', '2026-12-31T23:00:00Z'), '2026-12-31');
    assert.equal(due(23 * 60 + 59, 'Europe/Warsaw', '2027-01-01T23:00:00Z'), '2027-01-01');
  });

  test('a daytime schedule retains its before, due and expired boundaries', () => {
    assert.equal(due(9 * 60, 'Europe/Warsaw', '2026-10-08T06:59:59Z'), null);
    assert.equal(due(9 * 60, 'Europe/Warsaw', '2026-10-08T07:00:00Z'), '2026-10-08');
    assert.equal(due(9 * 60, 'Europe/Warsaw', '2026-10-08T09:59:59Z'), '2026-10-08');
    assert.equal(due(9 * 60, 'Europe/Warsaw', '2026-10-08T10:00:00Z'), null);
  });

  test('a spring-gap schedule starts at the first valid minute and expires three elapsed hours later', () => {
    const at = 2 * 60 + 30;
    // Warsaw jumps from 01:59 to 03:00 local at 01:00Z on 29 March 2026.
    assert.equal(due(at, 'Europe/Warsaw', '2026-03-29T00:59:59Z'), null);
    assert.equal(due(at, 'Europe/Warsaw', '2026-03-29T01:00:00Z'), '2026-03-29');
    assert.equal(due(at, 'Europe/Warsaw', '2026-03-29T03:59:59Z'), '2026-03-29');
    assert.equal(due(at, 'Europe/Warsaw', '2026-03-29T04:00:00Z'), null);
  });

  test('a fall overlap uses the first occurrence even while the repeated clock is before HH:MM', () => {
    const at = 2 * 60 + 30;
    assert.equal(due(at, 'Europe/Warsaw', '2026-10-25T00:29:59Z'), null);
    assert.equal(due(at, 'Europe/Warsaw', '2026-10-25T00:30:00Z'), '2026-10-25');
    // The repeated 02:10 is after the first 02:30, not before this day's occurrence.
    assert.equal(due(at, 'Europe/Warsaw', '2026-10-25T01:10:00Z'), '2026-10-25');
    assert.equal(due(at, 'Europe/Warsaw', '2026-10-25T01:30:00Z'), '2026-10-25', 'same day, not a second claim identity');
    assert.equal(due(at, 'Europe/Warsaw', '2026-10-25T03:29:59Z'), '2026-10-25');
    assert.equal(due(at, 'Europe/Warsaw', '2026-10-25T03:30:00Z'), null, 'the second occurrence does not extend expiry');
  });

  test('a quarter-hour offset does not require the UTC tick to share the local hour', () => {
    assert.equal(due(9 * 60, 'Asia/Kathmandu', '2026-10-08T03:14:59Z'), null);
    assert.equal(due(9 * 60, 'Asia/Kathmandu', '2026-10-08T03:15:00Z'), '2026-10-08');
    assert.equal(due(23 * 60 + 59, 'Asia/Kathmandu', '2026-10-08T18:15:00Z'), '2026-10-08');
  });

  test('a thirty-minute spring gap resolves to its real end', () => {
    const at = 2 * 60 + 15;
    // Lord Howe advances from 02:00 to 02:30; the missing 02:15 resolves to 02:30.
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-10-03T15:29:59Z'), null);
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-10-03T15:30:00Z'), '2026-10-04');
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-10-03T18:29:59Z'), '2026-10-04');
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-10-03T18:30:00Z'), null);
  });

  test('a thirty-minute fall overlap also keeps its first occurrence', () => {
    const at = 60 + 45;
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-04-04T14:44:59Z'), null);
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-04-04T14:45:00Z'), '2026-04-05');
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-04-04T15:05:00Z'), '2026-04-05', 'repeated 01:35 is after the first 01:45');
    assert.equal(due(at, 'Australia/Lord_Howe', '2026-04-04T17:45:00Z'), null);
  });

  test('a skipped calendar date does not invent an occurrence or lose a recent real one', () => {
    // Apia skipped 30 December 2011: 29 Dec 23:59 was followed by 31 Dec 00:00.
    assert.equal(due(23 * 60 + 59, 'Pacific/Apia', '2011-12-30T10:00:00Z'), '2011-12-29');
    assert.equal(due(23 * 60 + 59, 'Pacific/Apia', '2011-12-30T12:59:00Z'), null);
  });

  test('each evaluation uses the supplied current schedule rather than a previous due time', () => {
    const now = '2026-10-08T09:05:00Z';
    assert.equal(due(9 * 60, 'UTC', now), '2026-10-08');
    assert.equal(due(10 * 60, 'UTC', now), null, 'a later chosen time is not yet due');
    assert.equal(due(10 * 60, 'UTC', '2026-10-08T10:00:00Z'), '2026-10-08');
    assert.equal(due(9 * 60, 'UTC', now), '2026-10-08', 'returning to a schedule does not change its day identity');
  });

  test('each evaluation uses the current timezone, including a different local date', () => {
    const now = '2026-10-08T09:05:00Z';
    assert.equal(due(9 * 60, 'UTC', now), '2026-10-08');
    assert.equal(due(9 * 60, 'America/New_York', now), null, '05:05 local is not due');
    assert.equal(due(9 * 60, 'Europe/Warsaw', now), '2026-10-08', '11:05 local remains within the window');
    assert.equal(due(23 * 60 + 59, 'UTC', '2026-10-09T00:00:00Z'), '2026-10-08');
    assert.equal(due(23 * 60 + 59, 'America/New_York', '2026-10-09T00:00:00Z'), null, '20:00 local is before its occurrence');
  });
});
