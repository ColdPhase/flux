import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { NEEDS_YOU_REASONS, NOTIFICATION_REASONS } from '@flux/contracts';
import {
  DEFAULT_PREFERENCES,
  InvalidInputError,
  applyPreferenceChange,
  channelsOf,
  generateNotifications,
  levelOf,
  preferenceRepository,
  sendMorningSummaries,
  summaryDueOn,
  type GeneratorPorts,
  type StoredPreferences,
  type SummaryPorts,
} from '@flux/core';

// Notification levels and the morning summary (#350, F-026 S22) with in-memory ports.

const fresh = (): StoredPreferences => ({ ...DEFAULT_PREFERENCES, channels: {} });

describe('notification levels', () => {
  test('the default is Only "Needs you": push for the needs-you reasons, not replies, and the inbox for all', () => {
    const channels = channelsOf(fresh());
    assert.equal(levelOf(channels), 'needsYou');
    for (const reason of NOTIFICATION_REASONS) {
      assert.equal(channels[reason].inApp, true, `${reason} reaches the inbox`);
      assert.equal(channels[reason].push, (NEEDS_YOU_REASONS as readonly string[]).includes(reason), `${reason} push`);
    }
    assert.equal(channels.reply.push, false);
  });

  test('Everything, Nothing and back: the inbox is never turned off and email returns to its defaults', () => {
    const everything = applyPreferenceChange(fresh(), { level: 'everything' });
    assert.equal(levelOf(channelsOf(everything)), 'everything');
    assert.ok(NOTIFICATION_REASONS.every((reason) => channelsOf(everything)[reason].push));

    const nothing = applyPreferenceChange(everything, { level: 'nothing' });
    const off = channelsOf(nothing);
    assert.equal(levelOf(off), 'nothing');
    assert.ok(NOTIFICATION_REASONS.every((reason) => off[reason].inApp && !off[reason].push && !off[reason].email), 'Nothing keeps the inbox only');

    const back = channelsOf(applyPreferenceChange(nothing, { level: 'needsYou' }));
    assert.equal(levelOf(back), 'needsYou');
    assert.deepEqual(back, channelsOf(fresh()), 'Needs you after Nothing is the default again');
  });

  test('a single per-reason change reads as custom; channels apply after the level', () => {
    const custom = applyPreferenceChange(fresh(), { channels: { reply: { push: true }, dm: { push: false } } });
    assert.equal(levelOf(channelsOf(custom)), 'custom');
    const both = applyPreferenceChange(fresh(), { level: 'everything', channels: { reply: { push: false } } });
    assert.equal(channelsOf(both).reply.push, false);
  });

  test('unknown levels and malformed summary times are refused', () => {
    assert.throws(() => applyPreferenceChange(fresh(), { level: 'loud' as never }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_LEVEL');
    assert.throws(() => applyPreferenceChange(fresh(), { morningSummary: { at: '9am' } }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_MORNING_SUMMARY');
    assert.throws(() => applyPreferenceChange(fresh(), { morningSummary: { enabled: 'yes' as never } }), InvalidInputError);
    const on = applyPreferenceChange(fresh(), { morningSummary: { enabled: true, at: '08:30' } });
    assert.deepEqual([on.summaryEnabled, on.summaryAt], [true, 510]);
  });
});

describe('morning summary', () => {
  const warsaw = { channels: {}, summaryEnabled: true, summaryAt: 9 * 60, timeZone: 'Europe/Warsaw' };

  test('due once a local day, from its time until three hours later, in the person\'s time zone', () => {
    // 2026-10-08 07:10Z is 09:10 in Warsaw (CEST).
    assert.equal(summaryDueOn(warsaw, null, new Date('2026-10-08T07:10:00Z')), '2026-10-08');
    assert.equal(summaryDueOn(warsaw, '2026-10-08', new Date('2026-10-08T07:10:00Z')), null, 'already sent today');
    assert.equal(summaryDueOn(warsaw, '2026-10-07', new Date('2026-10-08T06:50:00Z')), null, 'before 09:00 local');
    assert.equal(summaryDueOn(warsaw, '2026-10-07', new Date('2026-10-08T10:05:00Z')), null, 'more than three hours late');
    assert.equal(summaryDueOn({ ...warsaw, summaryEnabled: false }, null, new Date('2026-10-08T07:10:00Z')), null, 'off');
  });

  function harness(unread: { readable: boolean }[]) {
    const workspaceId = randomUUID();
    const state = { preferences: { ...fresh(), ...warsaw }, lastOn: null as string | null, inserted: [] as { title: string; source: { id: string } }[], pushes: 0 };
    const rows = unread.map((row) => ({ id: randomUUID(), readable: row.readable, source: { workspaceId, type: 'project' as const, id: randomUUID() } }));
    const ports: SummaryPorts = {
      authorizer: { canRead: async (_user, source) => ({ visible: true, allowed: rows.find((row) => row.source.id === source.id)?.readable ?? false, workspaceId }) },
      lockCandidate: async (userId) => ({ userId, preferences: state.preferences, lastOn: state.lastOn }),
      isMuted: async () => false,
      claimDay: async (_user, day) => { if (state.lastOn && state.lastOn >= day) return false; state.lastOn = day; return true; },
      unread: async (_user, limit) => rows.slice(0, limit),
      insertSummary: async (row) => { state.inserted.push(row); },
      deliverableSubscriptions: async () => ['phone', 'laptop'],
      enqueuePush: async () => { state.pushes++; },
    };
    const uow = { candidates: async () => [{ userId: 'ada', preferences: state.preferences, lastOn: state.lastOn }], run: <T>(work: (p: SummaryPorts) => Promise<T>) => work(ports) };
    return { state, uow, rows, ports };
  }

  test('one push per device counts only what the person can still read, and only once that day', async () => {
    const { state, uow, rows } = harness([{ readable: false }, { readable: true }, { readable: true }]);
    const now = new Date('2026-10-08T07:10:00Z');
    assert.deepEqual(await sendMorningSummaries(uow, now), { sent: 1, empty: 0 });
    assert.equal(state.inserted.length, 1);
    assert.equal(state.inserted[0]!.title, '2 things wait in your inbox');
    assert.equal(state.inserted[0]!.source.id, rows[1]!.source.id, 'the push carries a readable source, so delivery rechecks access');
    assert.equal(state.pushes, 2);
    assert.deepEqual(await sendMorningSummaries(uow, new Date('2026-10-08T07:25:00Z')), { sent: 0, empty: 0 }, 'a later tick that day sends nothing');
    assert.equal(state.pushes, 2);
  });

  test('Nothing and Off reject admission, including a preference changed after candidate discovery', async () => {
    for (const change of [{ level: 'nothing' as const }, { morningSummary: { enabled: false } }]) {
      const { state, uow } = harness([{ readable: true }]);
      const stale = await uow.candidates();
      state.preferences = applyPreferenceChange(state.preferences, change);
      assert.deepEqual(await sendMorningSummaries({ ...uow, candidates: async () => stale }, new Date('2026-10-08T07:10:00Z')), { sent: 0, empty: 0 });
      assert.equal(state.pushes, 0);
      assert.equal(state.inserted.length, 0);
      assert.equal(state.lastOn, null, 'rejected current preferences do not claim a day');
      state.preferences = { ...fresh(), ...warsaw };
      assert.equal((await sendMorningSummaries(uow, new Date('2026-10-08T07:10:00Z'))).sent, 1, 'enabled positive control');
    }
  });

  test('schedule/timezone changes retire a stale due candidate without consuming its day', async () => {
    for (const change of [{ morningSummary: { at: '18:00' } }, { quietHours: { timeZone: 'America/New_York' } }]) {
      const { state, uow } = harness([{ readable: true }]);
      const stale = await uow.candidates();
      state.preferences = applyPreferenceChange(state.preferences, change);
      assert.deepEqual(await sendMorningSummaries({ ...uow, candidates: async () => stale }, new Date('2026-10-08T07:10:00Z')), { sent: 0, empty: 0 });
      assert.equal(state.lastOn, null);
    }
  });

  test('changing timezone cannot rewind the scheduled-day watermark', () => {
    assert.equal(summaryDueOn({ ...warsaw, summaryAt: 23 * 60 + 59, timeZone: 'UTC' }, '2026-10-09', new Date('2026-10-09T00:00:00Z')), null);
  });

  test('an empty (or unreadable) inbox sends nothing', async () => {
    const { state, uow } = harness([{ readable: false }]);
    assert.deepEqual(await sendMorningSummaries(uow, new Date('2026-10-08T07:10:00Z')), { sent: 0, empty: 1 });
    assert.equal(state.pushes, 0);
    assert.equal(state.inserted.length, 0);
  });
});

describe('quiet hours with the morning summary', () => {
  function generator(preferences: StoredPreferences) {
    const workspaceId = randomUUID();
    const counts = { notifications: 0, pushes: 0, emails: 0 };
    const ports: GeneratorPorts = {
      lockCursor: async () => 0,
      advanceCursor: async () => undefined,
      eventsAfter: async (seq) => (seq ? [] : [{ id: randomUUID(), seq: 1, kind: 'dm.message_sent.v1', workspaceId, objectId: randomUUID(), actorId: 'human:ada', data: { messageId: randomUUID() } }]),
      facts: {
        audience: async () => ['kai'], projectMessage: async () => null, work: async () => null, decision: async () => null, result: async () => null, liveInvitation: async () => null,
        dmMessage: async (dmId, id) => ({ id, workspaceId, dmId, kind: 'pair', title: null, authorId: 'ada', body: 'hi', participantIds: ['ada', 'kai'] }),
        names: async (ids) => new Map(ids.map((id) => [id, id])),
      },
      preferences: preferenceRepository({ find: async () => preferences, save: async () => undefined, isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined }),
      authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
      insertNotification: async () => { counts.notifications++; return true; },
      deliverableSubscriptions: async () => ['phone'],
      emailedRecently: async () => false,
      insertEmail: async () => true,
      enqueuePush: async () => { counts.pushes++; return null; },
      enqueueEmail: async () => { counts.emails++; return null; },
      recordFailure: async () => 1,
      deadLetter: async () => undefined,
      isolate: (work) => work(),
    };
    return { counts, uow: { run: <T>(work: (p: GeneratorPorts) => Promise<T>) => work(ports) } };
  }
  // Quiet all day except one minute, so "now" is always inside quiet hours.
  const quiet = { ...fresh(), quietEnabled: true, quietStart: 1, quietEnd: 0, timeZone: 'UTC' };
  const now = () => new Date('2026-10-08T12:00:00Z');

  test('held pushes are not pinged one by one when the summary is on; the inbox keeps them and email still waits for the end', async () => {
    const { counts, uow } = generator({ ...quiet, summaryEnabled: true });
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 0, emails: 1 });
  });

  test('negative control: with the summary off they are queued for the end of quiet hours', async () => {
    const { counts, uow } = generator(quiet);
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 1, emails: 1 });
  });
});
