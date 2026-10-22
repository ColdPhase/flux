import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  InvalidInputError,
  formatClock,
  isTimeZone,
  parseClock,
} from '@flux/core';

// Quiet-hours clock and time-zone helpers (#627). All three are pure:
// no database, no network.

const throwsCode = (
  fn: () => unknown,
  code: string,
  message: string,
): void => {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof InvalidInputError, message);
      assert.equal(
        (error as InvalidInputError).code,
        code,
        `${message} (code)`,
      );
      return true;
    },
    message,
  );
};

describe('parseClock', () => {
  test('00:00 gives 0 and 23:59 gives 1439', () => {
    assert.equal(parseClock('00:00', 'quietHours.start'), 0);
    assert.equal(parseClock('23:59', 'quietHours.start'), 1439);
  });

  test('converts mid-day times to minutes after midnight', () => {
    assert.equal(parseClock('09:30', 'quietHours.start'), 570);
    assert.equal(parseClock('22:00', 'quietHours.start'), 1320);
  });

  test('rejects non HH:MM text with INVALID_QUIET_HOURS', () => {
    throwsCode(
      () => parseClock('noon', 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      'plain words are refused',
    );
    throwsCode(
      () => parseClock('24:00', 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      '24:00 is out of range',
    );
    throwsCode(
      () => parseClock('7:30', 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      'single digits need padding',
    );
    throwsCode(
      () => parseClock(null, 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      'non-strings are refused',
    );
  });

  test('rejects single-digit minutes, out-of-range minutes and numbers', () => {
    throwsCode(
      () => parseClock('22:0', 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      'single-digit minutes are refused',
    );
    throwsCode(
      () => parseClock('12:60', 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      'minutes out of range are refused',
    );
    throwsCode(
      () => parseClock(2200, 'quietHours.start'),
      'INVALID_QUIET_HOURS',
      'numbers are refused',
    );
  });

  test('honours a custom code, e.g. the morning summary', () => {
    throwsCode(
      () => parseClock('bad', 'morningSummary.at', 'INVALID_MORNING_SUMMARY'),
      'INVALID_MORNING_SUMMARY',
      'custom code survives',
    );
  });
});

describe('formatClock', () => {
  test('minutes after midnight become zero-padded HH:MM', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(75), '01:15');
    assert.equal(formatClock(1320), '22:00');
    assert.equal(formatClock(1439), '23:59');
  });

  test('round-trips parseClock for every valid example', () => {
    for (const time of ['00:00', '18:45', '22:00', '23:59']) {
      assert.equal(formatClock(parseClock(time, 'quietHours.end')), time);
    }
  });
});

describe('isTimeZone', () => {
  test('accepts real IANA zone names', () => {
    assert.equal(isTimeZone('America/Los_Angeles'), true);
    assert.equal(isTimeZone('UTC'), true);
    assert.equal(isTimeZone('Asia/Karachi'), true);
  });

  test('refuses empty text, non-strings, junk and over-long names', () => {
    assert.equal(isTimeZone(''), false);
    assert.equal(isTimeZone(null), false);
    assert.equal(isTimeZone(undefined), false);
    assert.equal(isTimeZone(123), false);
    assert.equal(isTimeZone('Not/AZone'), false);
    assert.equal(isTimeZone('x'.repeat(65)), false);
  });
});
