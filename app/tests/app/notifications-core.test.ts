import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  DEFAULT_PREFERENCES,
  applyPreferenceChange,
  deliverableAt,
  localMinutes,
  GENERATION_MAX_ATTEMPTS,
  deliverPlainSummary,
  generateNotifications,
  preferenceRepository,
  type SummaryPorts,
  type GeneratorEvent,
  type GeneratorPorts,
  type NotificationFacts,
} from '@flux/core';

// The notification generator with in-memory ports (issue #116): a transient failure stops the
// cursor before the failing event and retries it; only repeated failures dead-letter it.

const workspaceId = randomUUID();
const dmId = randomUUID();

function dmEvent(seq: number): GeneratorEvent {
  return { id: randomUUID(), seq, kind: 'dm.message_sent.v1', workspaceId, objectId: dmId, actorId: 'human:ada', data: { messageId: randomUUID() } };
}

function harness(events: GeneratorEvent[], failures: Map<string, number>) {
  const state = { cursor: 0, notifications: [] as string[], attempts: new Map<string, number>(), dead: new Set<string>(), errors: [] as string[] };
  const facts: NotificationFacts = {
    audience: async () => ['kai'],
    projectMessage: async () => null,
    dmMessage: async (_dm, messageId) => {
      const event = events.find((item) => item.data.messageId === messageId)!;
      const left = failures.get(event.id) ?? 0;
      if (left > 0) { failures.set(event.id, left - 1); throw Object.assign(new Error(`connection reset near ${messageId}: CANARY-in-the-message`), { detail: 'CANARY-in-the-detail' }); }
      return { id: messageId, workspaceId, dmId, kind: 'pair', title: null, authorId: 'ada', body: 'hi', participantIds: ['ada', 'kai'] };
    },
    work: async () => null,
    decision: async () => null,
    result: async () => null,
    liveInvitation: async () => null,
    names: async (ids) => new Map(ids.map((id) => [id, id])),
  };
  const ports: GeneratorPorts = {
    lockCursor: async () => state.cursor,
    advanceCursor: async (seq) => { state.cursor = Math.max(state.cursor, seq); },
    eventsAfter: async (seq, limit) => events.filter((event) => event.seq > seq).slice(0, limit),
    facts,
    preferences: preferenceRepository({ find: async () => ({ ...DEFAULT_PREFERENCES, channels: {} }), save: async () => undefined, isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined }),
    authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
    insertNotification: async (notification) => { state.notifications.push(notification.eventId); return true; },
    deliverableSubscriptions: async () => [],
    emailedRecently: async () => false,
    insertEmail: async () => true,
    enqueuePush: async () => null,
    enqueueEmail: async () => null,
    recordFailure: async (eventId, error) => { state.errors.push(error); const attempts = (state.attempts.get(eventId) ?? 0) + 1; state.attempts.set(eventId, attempts); return attempts; },
    deadLetter: async (eventId) => { state.dead.add(eventId); },
    // A savepoint: a failure inside undoes only what this event wrote.
    isolate: async (work) => {
      const before = state.notifications.length;
      try { return await work(); } catch (error) { state.notifications.length = before; throw error; }
    },
  };
  return { state, ports, uow: { run: <T>(work: (p: GeneratorPorts) => Promise<T>) => work(ports) } };
}

describe('notification generation cursor', () => {
  test('a transient failure stops before the event and a retry delivers it once', async () => {
    const events = [dmEvent(1), dmEvent(2), dmEvent(3)];
    const { state, uow } = harness(events, new Map([[events[1]!.id, 2]]));
    const first = await generateNotifications(uow, { emailAvailable: false });
    assert.deepEqual({ ...first, cursor: state.cursor }, { processed: 1, created: 1, stalled: true, cursor: 1 });
    const second = await generateNotifications(uow, { emailAvailable: false });
    assert.equal(second.stalled, true);
    assert.equal(state.cursor, 1, 'the cursor never passes an event that has not been delivered');
    const third = await generateNotifications(uow, { emailAvailable: false });
    assert.deepEqual({ ...third, cursor: state.cursor }, { processed: 2, created: 2, stalled: false, cursor: 3 });
    assert.deepEqual(state.notifications, events.map((event) => event.id), 'every event notified exactly once, in order');
    assert.equal(state.dead.size, 0);
  });

  test('an event that keeps failing is dead-lettered after bounded attempts and the rest continue', async () => {
    const events = [dmEvent(1), dmEvent(2)];
    const { state, uow } = harness(events, new Map([[events[0]!.id, 100]]));
    for (let attempt = 1; attempt < GENERATION_MAX_ATTEMPTS; attempt += 1) {
      assert.equal((await generateNotifications(uow, { emailAvailable: false })).stalled, true);
      assert.equal(state.cursor, 0);
    }
    const last = await generateNotifications(uow, { emailAvailable: false });
    assert.equal(last.stalled, false);
    assert.equal(state.cursor, 2);
    assert.deepEqual([...state.dead], [events[0]!.id]);
    assert.deepEqual(state.notifications, [events[1]!.id]);
  });
});

describe('F-030 generation failures of a sealed workspace (#712 review P3)', () => {
  test('the failure stored and logged for a sealed workspace\'s event keeps class, code and ids only; a plain one keeps its text', async () => {
    for (const sealed of [true, false]) {
      const events = [dmEvent(1)];
      const { state, ports, uow } = harness(events, new Map([[events[0]!.id, 1]]));
      if (sealed) ports.facts.sealedWorkspace = async () => ({ name: 'Garden club' });
      const logged: unknown[] = [];
      await generateNotifications(uow, { emailAvailable: false, log: (_message, details) => logged.push(details) });
      const stored = state.errors.join('\n') + JSON.stringify(logged);
      assert.equal(stored.includes('CANARY'), !sealed, sealed ? 'no content in a sealed failure' : 'the plain failure keeps its message');
      if (sealed) assert.match(state.errors[0]!, new RegExp(`^Error · ids ${events[0]!.id}$`));
    }
  });
});

describe('F-030 morning summary of encrypted workspaces (#712 review)', () => {
  const plainWs = randomUUID(); const sealedWs = randomUUID(); const lockedWs = randomUUID();
  const source = (workspaceId: string) => ({ workspaceId, type: 'project' as const, id: randomUUID() });
  function ports(sources: ReturnType<typeof source>[]) {
    const inserted: { source: { workspaceId: string }; title: string; aiOrigin: boolean; sources: unknown[] }[] = [];
    const summary: SummaryPorts = {
      authorizer: { canRead: async (_user, place) => {
        const workspaceId = sources.find((item) => item.id === place.id)!.workspaceId;
        if (workspaceId === lockedWs) throw Object.assign(new Error('locked'), { code: 'WORKSPACE_LOCKED' });
        return { visible: true, allowed: true, workspaceId };
      } },
      lockCandidate: async () => null, isMuted: async () => false, claimDay: async () => true,
      unread: async () => sources.map((item) => ({ id: randomUUID(), source: item })),
      insertSummary: async (row) => { inserted.push(row); },
      deliverableSubscriptions: async () => [], enqueuePush: async () => null,
      sealedWorkspace: async (workspaceId) => workspaceId !== plainWs,
    };
    return { summary, inserted };
  }

  test('the row is anchored on the newest plain source; an assistant line is kept only there', async () => {
    const mixed = ports([source(sealedWs), source(plainWs)]);
    assert.equal(await deliverPlainSummary(mixed.summary, 'ben', 'Your assistant: all good.'), 'sent');
    assert.equal(mixed.inserted[0]!.source.workspaceId, plainWs);
    assert.equal(mixed.inserted[0]!.title, 'Your assistant: all good.');
    const sealedOnly = ports([source(sealedWs)]);
    await deliverPlainSummary(sealedOnly.summary, 'ben', 'Your assistant: all good.');
    assert.deepEqual({ ws: sealedOnly.inserted[0]!.source.workspaceId, title: sealedOnly.inserted[0]!.title, ai: sealedOnly.inserted[0]!.aiOrigin },
      { ws: sealedWs, title: '1 thing waits in your inbox', ai: false }, 'only sealed sources: the plain count, never the line');
  });

  test('an item of a locked workspace is left out instead of failing the summary', async () => {
    const withLocked = ports([source(lockedWs), source(plainWs)]);
    assert.equal(await deliverPlainSummary(withLocked.summary, 'ben'), 'sent');
    assert.equal(withLocked.inserted[0]!.title, '1 thing waits in your inbox');
    assert.equal(withLocked.inserted[0]!.sources.length, 1);
    assert.equal(await deliverPlainSummary(ports([source(lockedWs)]).summary, 'ben'), 'empty', 'only locked items: nothing to send, no failure');
  });
});

describe('quiet hours across daylight-saving transitions', () => {
  const quiet = (timeZone: string, start: string, end: string) => {
    const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return { ...DEFAULT_PREFERENCES, quietEnabled: true, quietStart: clock(start), quietEnd: clock(end), timeZone };
  };
  const at = (iso: string) => new Date(iso);
  const cases: [string, ReturnType<typeof quiet>, string, string][] = [
    // Europe/Warsaw springs forward 2026-03-29 02:00 CET → 03:00 CEST (01:00Z).
    ['Warsaw spring-forward, end after the gap', quiet('Europe/Warsaw', '22:00', '04:00'), '2026-03-29T00:30:00Z', '2026-03-29T02:00:00.000Z'],
    ['Warsaw spring-forward, end inside the gap → first valid instant after it', quiet('Europe/Warsaw', '22:00', '02:30'), '2026-03-29T00:30:00Z', '2026-03-29T01:00:00.000Z'],
    // Europe/Warsaw falls back 2026-10-25 03:00 CEST → 02:00 CET (01:00Z).
    ['Warsaw fall-back, end after the repeat', quiet('Europe/Warsaw', '22:00', '04:00'), '2026-10-24T22:30:00Z', '2026-10-25T03:00:00.000Z'],
    ['Warsaw fall-back, repeated end → first occurrence after now', quiet('Europe/Warsaw', '22:00', '02:30'), '2026-10-24T23:30:00Z', '2026-10-25T00:30:00.000Z'],
    // America/New_York springs forward 2026-03-08 02:00 EST → 03:00 EDT (07:00Z), falls back 2026-11-01 02:00 EDT → 01:00 EST (06:00Z).
    ['New York spring-forward', quiet('America/New_York', '23:00', '06:00'), '2026-03-08T05:00:00Z', '2026-03-08T10:00:00.000Z'],
    ['New York fall-back', quiet('America/New_York', '23:00', '06:00'), '2026-11-01T04:00:00Z', '2026-11-01T11:00:00.000Z'],
    ['New York fall-back, repeated end → first occurrence', quiet('America/New_York', '22:00', '01:30'), '2026-11-01T04:00:00Z', '2026-11-01T05:30:00.000Z'],
    // Asia/Tokyo has no DST; the window crosses midnight.
    ['Tokyo, no DST, across midnight', quiet('Asia/Tokyo', '22:00', '07:00'), '2026-03-29T14:00:00Z', '2026-03-29T22:00:00.000Z'],
    ['Tokyo, after midnight', quiet('Asia/Tokyo', '22:00', '07:00'), '2026-03-29T16:59:30Z', '2026-03-29T22:00:00.000Z'],
    ['UTC same-day window, last minute', quiet('UTC', '09:00', '17:00'), '2026-09-28T16:59:30Z', '2026-09-28T17:00:00.000Z'],
    ['UTC, at the end: already outside', quiet('UTC', '09:00', '17:00'), '2026-09-28T17:00:00Z', '2026-09-28T17:00:00.000Z'],
    ['outside quiet hours: now', quiet('Europe/Warsaw', '22:00', '04:00'), '2026-03-29T10:00:00Z', '2026-03-29T10:00:00.000Z'],
  ];
  for (const [name, preferences, now, expected] of cases) {
    test(name, () => {
      const result = deliverableAt(preferences, at(now));
      assert.equal(result.toISOString(), expected);
      // Never earlier than now, and never still inside quiet hours.
      assert.ok(result.getTime() >= at(now).getTime());
      const minute = localMinutes(result, preferences.timeZone);
      const { quietStart: start, quietEnd: end } = preferences;
      assert.ok(!(start < end ? minute >= start && minute < end : minute >= start || minute < end), 'released outside the window');
    });
  }

  test('a one-minute outside gap is not stepped over', () => {
    const preferences = quiet('Europe/Warsaw', '22:01', '22:00');
    assert.equal(deliverableAt(preferences, at('2026-03-28T21:30:00Z')).toISOString(), '2026-03-29T20:00:00.000Z');
  });
});

describe('focus pauses push and email (#340, F-026 S19)', () => {
  const now = new Date('2026-10-07T09:20:00Z');
  const paused = (until: string | null) => applyPreferenceChange({ ...DEFAULT_PREFERENCES, channels: {} }, { pause: { until } }, now);

  test('a running pause holds delivery until it ends, then quiet hours still apply', () => {
    assert.equal(deliverableAt(paused('2026-10-07T10:00:00Z'), now).toISOString(), '2026-10-07T10:00:00.000Z');
    const quietAfter = { ...paused('2026-10-07T10:00:00Z'), quietEnabled: true, quietStart: 9 * 60 + 50, quietEnd: 11 * 60, timeZone: 'UTC' };
    assert.equal(deliverableAt(quietAfter, now).toISOString(), '2026-10-07T11:00:00.000Z');
  });

  test('an ended or cleared pause holds nothing', () => {
    assert.equal(deliverableAt(paused('2026-10-07T10:00:00Z'), new Date('2026-10-07T10:00:00Z')).toISOString(), '2026-10-07T10:00:00.000Z');
    assert.equal(paused(null).pausedUntil, null);
    assert.equal(deliverableAt(paused(null), now).toISOString(), now.toISOString());
  });

  test('a pause must end in the future and within 12 hours', () => {
    for (const until of ['2026-10-07T09:00:00Z', '2026-10-07T21:21:00Z', 'tomorrow', '', 42, undefined]) {
      assert.throws(() => applyPreferenceChange(DEFAULT_PREFERENCES, { pause: { until } } as never, now), { code: 'INVALID_PAUSE' }, String(until));
    }
    assert.equal(paused('2026-10-07T21:20:00Z').pausedUntil?.toISOString(), '2026-10-07T21:20:00.000Z');
  });
});


describe('focus composed with the morning-summary preference', () => {
  const now = new Date('2026-10-07T09:20:00Z');
  const until = new Date('2026-10-07T10:00:00Z');
  const cases = [
    { name: 'pause only retains the individual push', quietEnabled: false, quietStart: 22 * 60, quietEnd: 7 * 60, pushes: 1, release: until },
    { name: 'quiet after the pause uses the summary and still holds email', quietEnabled: true, quietStart: 9 * 60 + 50, quietEnd: 11 * 60, pushes: 0, release: new Date('2026-10-07T11:00:00Z') },
    { name: 'quiet that already holds the push stays covered by the summary', quietEnabled: true, quietStart: 9 * 60, quietEnd: 9 * 60 + 50, pushes: 0, release: until },
  ];
  for (const row of cases) test(row.name, async () => {
    const { ports, state, uow } = harness([dmEvent(1)], new Map());
    const preferences = { ...DEFAULT_PREFERENCES, summaryEnabled: true, pausedUntil: until,
      quietEnabled: row.quietEnabled, quietStart: row.quietStart, quietEnd: row.quietEnd, timeZone: 'UTC' };
    ports.preferences = preferenceRepository({ find: async () => preferences, save: async () => undefined,
      isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined });
    ports.deliverableSubscriptions = async () => ['actual-subscription'];
    const pushes: (Date | null)[] = [], emails: (Date | null)[] = [];
    ports.enqueuePush = async (_payload, after) => { pushes.push(after); return null; };
    ports.enqueueEmail = async (_payload, after) => { emails.push(after); return null; };
    assert.deepEqual(await generateNotifications(uow, { emailAvailable: true, now: () => now }), { processed: 1, created: 1, stalled: false });
    assert.equal(state.notifications.length, 1, 'focus never holds the Inbox');
    assert.equal(pushes.length, row.pushes);
    for (const after of pushes) assert.equal(after?.toISOString(), row.release.toISOString());
    assert.deepEqual(emails.map(after => after?.toISOString()), [row.release.toISOString()]);
  });
});
