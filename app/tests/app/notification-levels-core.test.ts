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
  type GeneratorPorts,
  type StoredPreferences,
} from '@flux/core';

// Notification levels (#350, F-026 S22) with in-memory ports.

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

  test('unknown levels are refused', () => {
    assert.throws(() => applyPreferenceChange(fresh(), { level: 'loud' as never }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_LEVEL');
  });
});

describe('quiet hours', () => {
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

  test('a push held by quiet hours is queued for their end; the inbox keeps it and email still waits for the end', async () => {
    const { counts, uow } = generator(quiet);
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 1, emails: 1 });
  });
});
