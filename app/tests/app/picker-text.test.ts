import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, addMonths, formatTime, makeDay, makeTime, parseDay, parseTime, splitDay, timeSteps } from '../../apps/web/src/ui/pickerText.js';

// #1251: what the date and time fields read from typed text. A day is `YYYY-MM-DD` and a time `HH:MM`, as the native inputs stored them.
const NOW = new Date(2026, 10, 12, 10, 0); // 12 Nov 2026

test('a date is read the way people write it', () => {
  const read = (text: string) => parseDay(text, NOW);
  assert.equal(read('2026-11-14'), '2026-11-14');
  assert.equal(read('2026-1-4'), '2026-01-04');
  assert.equal(read('14 Nov'), '2026-11-14');
  assert.equal(read('14 november'), '2026-11-14');
  assert.equal(read('14 Nov 2026'), '2026-11-14');
  assert.equal(read('Nov 14'), '2026-11-14');
  assert.equal(read('nov 14, 2027'), '2027-11-14');
  assert.equal(read('14th Nov'), '2026-11-14');
  assert.equal(read('3 sept 2026'), '2026-09-03');
  assert.equal(read('14 Nov 26'), '2026-11-14');
  assert.equal(read('14.11'), '2026-11-14');
  assert.equal(read('14/11/2026'), '2026-11-14');
  assert.equal(read('11/14'), '2026-11-14');
  assert.equal(read('  14   Nov  '), '2026-11-14');
  assert.equal(read('today'), '2026-11-12');
  assert.equal(read('Tomorrow'), '2026-11-13');
  assert.equal(read('29 Feb 2028'), '2028-02-29');
});

test('a day without a year is the next time that day comes', () => {
  const read = (text: string) => parseDay(text, NOW);
  assert.equal(read('12 Nov'), '2026-11-12', 'today is today');
  assert.equal(read('13 Nov'), '2026-11-13');
  assert.equal(read('11 Nov'), '2027-11-11', 'a day that has passed is next year\'s');
  assert.equal(read('5 Jan'), '2027-01-05');
  assert.equal(read('3 sept'), '2027-09-03');
  assert.equal(read('14.1'), '2027-01-14');
  assert.equal(read('29 Feb'), '2028-02-29', 'waits for a leap year');
  assert.equal(parseDay('5 Jan', new Date(2027, 0, 5, 23, 59)), '2027-01-05');
  assert.equal(parseDay('5 Jan', new Date(2027, 0, 6, 0, 1)), '2028-01-05');
  assert.equal(read('31 Nov'), null);
});

test('text that is not a day is not read', () => {
  for (const text of ['', '  ', 'soon', '31 Nov', '32 Nov', '0 Nov', '29 Feb 2027', '2026-02-30', '2026-13-01', 'Nov', '14', '14 Nov Nov', '14 15 16 Nov', '14 Foo']) {
    assert.equal(parseDay(text, NOW), null, JSON.stringify(text));
  }
});

test('days move by calendar', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-11-12', 12), '2027-11-12');
  assert.equal(addMonths('2026-11-12', -23), '2024-12-12');
  assert.equal(makeDay(2026, 2, 29), null);
  assert.equal(makeDay(2024, 2, 29), '2024-02-29');
  assert.deepEqual(splitDay('2026-11-14'), { year: 2026, month: 11, day: 14 });
  assert.equal(splitDay('2026-11-31'), null);
  assert.equal(splitDay('14 Nov'), null);
});

test('a time is read the way people write it', () => {
  const read = parseTime;
  assert.equal(read('9:00'), '09:00');
  assert.equal(read('9'), '09:00');
  assert.equal(read('21'), '21:00');
  assert.equal(read('9.30'), '09:30');
  assert.equal(read('9h15'), '09:15');
  assert.equal(read('930'), '09:30');
  assert.equal(read('0930'), '09:30');
  assert.equal(read('2130'), '21:30');
  assert.equal(read('21:15'), '21:15');
  assert.equal(read('9 pm'), '21:00');
  assert.equal(read('9pm'), '21:00');
  assert.equal(read('9:30am'), '09:30');
  assert.equal(read('9 p.m.'), '21:00');
  assert.equal(read('12am'), '00:00');
  assert.equal(read('12pm'), '12:00');
  assert.equal(read('12:30 AM'), '00:30');
  assert.equal(read('noon'), '12:00');
  assert.equal(read('Midnight'), '00:00');
  assert.equal(read('00:00'), '00:00');
  assert.equal(read(' 7:05 '), '07:05');
});

test('text that is not a time is not read', () => {
  for (const text of ['', ' ', 'later', '24:00', '25', '9:60', '9:5', '13pm', '0pm', '9:30:15', '9 xm', '1:2:3']) {
    assert.equal(parseTime(text), null, JSON.stringify(text));
  }
});

test('a time shows as the app writes it and the list has the half hours of the day', () => {
  assert.equal(formatTime('09:00'), '9:00');
  assert.equal(formatTime('00:30'), '0:30');
  assert.equal(formatTime('22:00'), '22:00');
  assert.equal(formatTime(''), '');
  assert.equal(makeTime(24, 0), null);
  const steps = timeSteps();
  assert.equal(steps.length, 48);
  assert.deepEqual([steps[0], steps[1], steps[18], steps[47]], ['00:00', '00:30', '09:00', '23:30']);
  const withExtra = timeSteps('08:45');
  assert.equal(withExtra.length, 49);
  assert.deepEqual(withExtra.slice(16, 20), ['08:00', '08:30', '08:45', '09:00']);
  assert.equal(timeSteps('09:00').length, 48);
});
