import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  DEFAULT_PREFERENCES,
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
  const state = { cursor: 0, notifications: [] as string[], attempts: new Map<string, number>(), dead: new Set<string>() };
  const facts: NotificationFacts = {
    audience: async () => ['kai'],
    projectMessage: async () => null,
    dmMessage: async (_dm, messageId) => {
      const event = events.find((item) => item.data.messageId === messageId)!;
      const left = failures.get(event.id) ?? 0;
      if (left > 0) { failures.set(event.id, left - 1); throw new Error('connection reset'); }
      return { id: messageId, workspaceId, dmId, kind: 'pair', title: null, authorId: 'ada', body: 'hi', participantIds: ['ada', 'kai'] };
    },
    work: async () => null,
    decision: async () => null,
    result: async () => null,
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
    recordFailure: async (eventId) => { const attempts = (state.attempts.get(eventId) ?? 0) + 1; state.attempts.set(eventId, attempts); return attempts; },
    deadLetter: async (eventId) => { state.dead.add(eventId); },
    // A savepoint: a failure inside undoes only what this event wrote.
    isolate: async (work) => {
      const before = state.notifications.length;
      try { return await work(); } catch (error) { state.notifications.length = before; throw error; }
    },
  };
  return { state, uow: { run: <T>(work: (p: GeneratorPorts) => Promise<T>) => work(ports) } };
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
