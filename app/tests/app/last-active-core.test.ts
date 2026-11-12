import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProjectPerson } from '@flux/contracts';
import { roundedLastActive } from '@flux/core';
import { ACTIVITY_INTERVAL_MS, createActivityGate } from '../../apps/server/src/identity/last-active.js';
import { activeFirst, activeNow, lastActiveWords } from '../../apps/web/src/people/lastActive.js';

// When a person was last active (#1225, C-58): the server's rounding, the gate that keeps it to one write a minute, and the words the screen uses.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (lastActiveAt: Date | null, showLastActive = true) => ({ lastActiveAt, showLastActive });

describe('the rounding the server does', () => {
  test('nothing for someone who turned it off or has not been active', () => {
    assert.equal(roundedLastActive(row(ago(MINUTE), false), { timeZone: 'UTC' }, NOW), undefined);
    assert.equal(roundedLastActive(row(null), { timeZone: 'UTC' }, NOW), undefined);
  });

  test('to the minute under an hour, never newer than it was', () => {
    assert.equal(roundedLastActive(row(ago(30_000)), { timeZone: 'UTC' }, NOW), '2026-11-12T11:59:00.000Z');
    assert.equal(roundedLastActive(row(new Date('2026-11-12T11:47:19.412Z')), { timeZone: 'UTC' }, NOW), '2026-11-12T11:47:00.000Z');
    assert.equal(roundedLastActive(row(ago(59 * MINUTE + 59_000)), { timeZone: 'UTC' }, NOW), '2026-11-12T11:00:00.000Z');
  });

  test('to the hour under a day', () => {
    assert.equal(roundedLastActive(row(ago(HOUR + MINUTE)), { timeZone: 'UTC' }, NOW), '2026-11-12T10:00:00.000Z');
    assert.equal(roundedLastActive(row(new Date('2026-11-11T14:59:59.999Z')), { timeZone: 'UTC' }, NOW), '2026-11-11T14:00:00.000Z');
  });

  test('from a day on, only the day, counted in the reader\'s zone', () => {
    const at = new Date('2026-11-09T23:30:00.000Z');
    assert.equal(roundedLastActive(row(at), { timeZone: 'UTC' }, NOW), '2026-11-09');
    assert.equal(roundedLastActive(row(at), { timeZone: 'Pacific/Auckland' }, NOW), '2026-11-10');
    assert.equal(roundedLastActive(row(at), { timeZone: 'America/New_York' }, NOW), '2026-11-09');
    assert.equal(roundedLastActive(row(new Date('2026-11-10T03:00:00.000Z')), { timeZone: 'America/New_York' }, NOW), '2026-11-09');
    assert.equal(roundedLastActive(row(at), { timeZone: 'Not/AZone' }, NOW), '2026-11-09', 'an unknown zone counts days in UTC');
  });

  test('a time a little ahead of this server\'s clock is not in the future', () => {
    assert.equal(roundedLastActive(row(new Date(NOW.getTime() + 4000)), { timeZone: 'UTC' }, NOW), '2026-11-12T12:00:00.000Z');
  });
});

describe('the gate: at most one write a minute per person', () => {
  const clock = () => {
    let at = 1_000_000;
    return { now: () => at, tick: (ms: number) => { at += ms; } };
  };

  test('a hundred requests in a minute write once; the next minute writes once more', async () => {
    const time = clock(); const written: string[] = [];
    const gate = createActivityGate(async (userId) => { written.push(userId); }, { now: time.now });
    for (let n = 0; n < 100; n += 1) { gate.touch('ada'); time.tick(ACTIVITY_INTERVAL_MS / 101); }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, ['ada']);
    time.tick(ACTIVITY_INTERVAL_MS);
    for (let n = 0; n < 50; n += 1) gate.touch('ada');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, ['ada', 'ada']);
  });

  test('each person has their own minute', async () => {
    const time = clock(); const written: string[] = [];
    const gate = createActivityGate(async (userId) => { written.push(userId); }, { now: time.now });
    gate.touch('ada'); gate.touch('kai'); gate.touch('ada'); gate.touch('kai'); gate.touch('nia');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written.sort(), ['ada', 'kai', 'nia']);
  });

  test('a failed write reaches the log, never the request, and the next request tries again', async () => {
    const time = clock(); const errors: unknown[] = []; let calls = 0;
    const gate = createActivityGate(async () => { calls += 1; if (calls === 1) throw new Error('database is down'); }, { now: time.now, onError: (error) => errors.push(error) });
    assert.doesNotThrow(() => gate.touch('ada'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    gate.touch('ada');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'a failure does not hold the person back for a minute');
    gate.touch('ada');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'a write that worked does');
  });

  test('a write that throws at once is the same', async () => {
    const errors: unknown[] = [];
    const gate = createActivityGate(() => { throw new Error('sync'); }, { onError: (error) => errors.push(error) });
    assert.doesNotThrow(() => gate.touch('ada'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  });
});

describe('the words on the screen', () => {
  const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const words = (value: string) => lastActiveWords(value, NOW);

  test('within five minutes the person is active now, with the mark', () => {
    assert.deepEqual(words(at(0)), { text: 'Active now', now: true, bare: false });
    assert.equal(words(at(4 * MINUTE + 59_000)).now, true);
    assert.equal(words(at(5 * MINUTE)).now, false);
    assert.equal(activeNow(at(MINUTE), NOW), true);
    assert.equal(activeNow(undefined, NOW), false);
  });

  test('minutes up to an hour, hours up to a day', () => {
    assert.equal(words(at(12 * MINUTE)).text, 'Active 12 min ago');
    assert.equal(words(at(59 * MINUTE)).text, 'Active 59 min ago');
    assert.equal(words(at(HOUR)).text, 'Active 1 h ago');
    assert.equal(words(at(2 * HOUR + 20 * MINUTE)).text, 'Active 2 h ago');
    assert.equal(words(at(23 * HOUR)).text, 'Active 23 h ago');
  });

  test('then yesterday and the date, which say "Last active" to a screen reader', () => {
    const now = new Date(2026, 10, 12, 9, 0);
    const day = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    assert.deepEqual(lastActiveWords(day(2026, 11, 11), now), { text: 'Yesterday', now: false, bare: true });
    assert.deepEqual(lastActiveWords(day(2026, 11, 3), now), { text: '3 Nov', now: false, bare: true });
    assert.equal(lastActiveWords(day(2025, 11, 3), now).text, '3 Nov 2025');
    // A kept answer that has since grown a day old is named by its own local day.
    assert.equal(lastActiveWords(new Date(2026, 10, 11, 8, 0).toISOString(), now).text, 'Yesterday');
    assert.equal(lastActiveWords(new Date(2026, 10, 10, 20, 0).toISOString(), now).text, '10 Nov');
    assert.equal(lastActiveWords(new Date(2026, 10, 11, 20, 0).toISOString(), now).text, 'Active 13 h ago', 'under a day it is hours, even across midnight');
  });
});

describe('the header\'s faces', () => {
  const human = (id: string, lastActiveAt?: string): ProjectPerson => ({ kind: 'human', id, name: id, access: 'contributor', ...(lastActiveAt ? { lastActiveAt } : {}) });
  const agent: ProjectPerson = { kind: 'agent', id: 'agent', name: 'Kreska', access: 'contributor' };
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 60 * HOUR).toISOString();

  test('the people active now come first, the others keep their order, the reader counts as active, and an agent is last', () => {
    const listed = [agent, human('ada', old), human('ben'), human('cy', fresh), human('me'), human('dee', old), human('eve', fresh)];
    assert.deepEqual(activeFirst(listed, 'me').map((person) => person.id), ['cy', 'me', 'eve', 'ada', 'ben', 'dee', 'agent']);
  });
});
