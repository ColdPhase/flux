import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  DEFAULT_PREFERENCES,
  inQuietHours,
  GENERATION_MAX_ATTEMPTS,
  generateNotifications,
  preferenceRepository,
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
    liveInvitation: async () => null,
    liveSession: async () => null,
    waitingChange: async () => null,
    names: async (ids) => new Map(ids.map((id) => [id, id])),
  };
  const ports: GeneratorPorts = {
    lockCursor: async () => state.cursor,
    advanceCursor: async (seq) => { state.cursor = Math.max(state.cursor, seq); },
    eventsAfter: async (seq, limit) => events.filter((event) => event.seq > seq).slice(0, limit),
    facts,
    preferences: preferenceRepository({ find: async () => ({ ...DEFAULT_PREFERENCES }), save: async () => undefined, isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined }),
    authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
    insertNotification: async (notification) => { state.notifications.push(notification.eventId); return true; },
    deliverableSubscriptions: async () => [],
    emailedRecently: async () => false,
    insertEmails: async () => [randomUUID()],
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

describe('quiet hours across daylight-saving transitions', () => {
  const quiet = (timeZone: string, start: string, end: string) => {
    const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return { ...DEFAULT_PREFERENCES, quietEnabled: true, quietStart: clock(start), quietEnd: clock(end), timeZone };
  };
  // Quiet hours follow the person's own wall clock, so each case names the instants just inside and just outside the
  // window. Nothing is deferred (C-31): the window only decides whether push and email are sent at all.
  const cases: [string, ReturnType<typeof quiet>, [string, boolean][]][] = [
    // Europe/Warsaw springs forward 2026-03-29 02:00 CET → 03:00 CEST (01:00Z).
    ['Warsaw spring-forward, end after the gap', quiet('Europe/Warsaw', '22:00', '04:00'),
      [['2026-03-29T00:30:00Z', true], ['2026-03-29T01:59:00Z', true], ['2026-03-29T02:00:00Z', false]]],
    ['Warsaw spring-forward, end inside the gap', quiet('Europe/Warsaw', '22:00', '02:30'),
      [['2026-03-29T00:30:00Z', true], ['2026-03-29T00:59:00Z', true], ['2026-03-29T01:00:00Z', false]]],
    // Europe/Warsaw falls back 2026-10-25 03:00 CEST → 02:00 CET (01:00Z).
    ['Warsaw fall-back, end after the repeat', quiet('Europe/Warsaw', '22:00', '04:00'),
      [['2026-10-24T22:30:00Z', true], ['2026-10-25T02:59:00Z', true], ['2026-10-25T03:00:00Z', false]]],
    ['Warsaw fall-back, end inside the repeated hour: the wall clock is inside it twice', quiet('Europe/Warsaw', '22:00', '02:30'),
      [['2026-10-24T23:30:00Z', true], ['2026-10-25T00:30:00Z', false], ['2026-10-25T01:00:00Z', true], ['2026-10-25T01:30:00Z', false]]],
    // America/New_York springs forward 2026-03-08 02:00 EST → 03:00 EDT (07:00Z), falls back 2026-11-01 02:00 EDT → 01:00 EST (06:00Z).
    ['New York spring-forward', quiet('America/New_York', '23:00', '06:00'),
      [['2026-03-08T05:00:00Z', true], ['2026-03-08T09:59:00Z', true], ['2026-03-08T10:00:00Z', false]]],
    ['New York fall-back', quiet('America/New_York', '23:00', '06:00'),
      [['2026-11-01T04:00:00Z', true], ['2026-11-01T10:59:00Z', true], ['2026-11-01T11:00:00Z', false]]],
    // Asia/Tokyo has no DST; the window crosses midnight.
    ['Tokyo, no DST, across midnight', quiet('Asia/Tokyo', '22:00', '07:00'),
      [['2026-03-29T14:00:00Z', true], ['2026-03-29T21:59:00Z', true], ['2026-03-29T22:00:00Z', false]]],
    ['UTC same-day window, last minute and the end', quiet('UTC', '09:00', '17:00'),
      [['2026-09-28T08:59:59Z', false], ['2026-09-28T16:59:30Z', true], ['2026-09-28T17:00:00Z', false]]],
    ['outside the window', quiet('Europe/Warsaw', '22:00', '04:00'), [['2026-03-29T10:00:00Z', false]]],
    ['a one-minute outside gap is not stepped over', quiet('Europe/Warsaw', '22:01', '22:00'),
      [['2026-03-28T21:30:00Z', true], ['2026-03-29T19:59:00Z', true], ['2026-03-29T20:00:00Z', false], ['2026-03-29T20:01:00Z', true]]],
  ];
  for (const [name, preferences, instants] of cases) {
    test(name, () => {
      for (const [iso, inside] of instants) assert.equal(inQuietHours(preferences, new Date(iso)), inside, `${iso} (${preferences.timeZone})`);
    });
  }

  test('off, an empty window and an unknown time zone are never quiet', () => {
    const at = new Date('2026-09-28T12:00:00Z');
    assert.equal(inQuietHours({ ...quiet('UTC', '00:00', '23:59'), quietEnabled: false }, at), false);
    assert.equal(inQuietHours(quiet('UTC', '09:00', '09:00'), at), false);
    assert.equal(inQuietHours(quiet('Mars/Olympus', '00:00', '23:59'), at), false);
  });
});
