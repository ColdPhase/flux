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
  preferenceRepository,
  type GeneratorPorts,
  type StoredPreferences,
} from '@flux/core';

// Notification levels (#350, F-026 S22) with in-memory ports.

const fresh = (): StoredPreferences => ({ ...DEFAULT_PREFERENCES });

describe('notification levels', () => {
  test('the default is Only what needs me with email too: push and email for the needs-you reasons, not replies, and the inbox for all', () => {
    const channels = channelsOf(fresh());
    for (const reason of NOTIFICATION_REASONS) {
      const needsYou = (NEEDS_YOU_REASONS as readonly string[]).includes(reason);
      assert.equal(channels[reason].inApp, true, `${reason} reaches the inbox`);
      assert.equal(channels[reason].push, needsYou, `${reason} push`);
      assert.equal(channels[reason].email, needsYou && reason !== 'invitation', `${reason} email follows push, a live call invitation excepted`);
    }
    assert.equal(channels.reply.push, false);
  });

  test('Everything, Nothing and back: the inbox is never turned off', () => {
    const everything = applyPreferenceChange(fresh(), { level: 'everything' });
    assert.equal(everything.level, 'everything');
    assert.ok(NOTIFICATION_REASONS.every((reason) => channelsOf(everything)[reason].push && channelsOf(everything)[reason].email === (reason !== 'invitation')));

    const nothing = applyPreferenceChange(everything, { level: 'nothing' });
    const off = channelsOf(nothing);
    assert.ok(NOTIFICATION_REASONS.every((reason) => off[reason].inApp && !off[reason].push && !off[reason].email), 'Nothing keeps the inbox only');

    const back = applyPreferenceChange(nothing, { level: 'needsYou' });
    assert.deepEqual(back, fresh(), 'Only what needs me after Nothing is the default again');
  });

  test('Email me too covers the same events as the level and nothing else', () => {
    const noEmail = applyPreferenceChange(fresh(), { emailMe: false });
    assert.equal(noEmail.emailMe, false);
    assert.ok(NOTIFICATION_REASONS.every((reason) => !channelsOf(noEmail)[reason].email), 'no reason emails');
    assert.deepEqual(NOTIFICATION_REASONS.map((reason) => channelsOf(noEmail)[reason].push), NOTIFICATION_REASONS.map((reason) => channelsOf(fresh())[reason].push), 'push is unchanged');
    const everything = applyPreferenceChange(fresh(), { level: 'everything', emailMe: true });
    assert.ok(NOTIFICATION_REASONS.every((reason) => channelsOf(everything)[reason].email === (reason !== 'invitation')), 'Everything emails every reason but a live call invitation');
    assert.equal(channelsOf(everything).invitation.push, true, 'the invitation still rings on push, and is in the Inbox');
  });

  test('unknown levels and non-boolean switches are refused', () => {
    assert.throws(() => applyPreferenceChange(fresh(), { level: 'loud' as never }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_LEVEL');
    assert.throws(() => applyPreferenceChange(fresh(), { emailMe: 'yes' as never }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_EMAIL_ME');
  });
});

describe('quiet hours', () => {
  /** `extras`: how many confirmed extra addresses are switched on (the repository queues a copy for each). */
  function generator(preferences: StoredPreferences, extras = 0) {
    const workspaceId = randomUUID();
    const counts = { notifications: 0, pushes: 0, emails: 0 };
    const ports: GeneratorPorts = {
      lockCursor: async () => 0,
      advanceCursor: async () => undefined,
      eventsAfter: async (seq) => (seq ? [] : [{ id: randomUUID(), seq: 1, kind: 'dm.message_sent.v1', workspaceId, objectId: randomUUID(), actorId: 'human:ada', data: { messageId: randomUUID() } }]),
      facts: {
        audience: async () => ['kai'], projectMessage: async () => null, work: async () => null, decision: async () => null, liveInvitation: async () => null, waitingChange: async () => null,
        dmMessage: async (dmId, id) => ({ id, workspaceId, dmId, kind: 'pair', title: null, authorId: 'ada', body: 'hi', participantIds: ['ada', 'kai'] }),
        names: async (ids) => new Map(ids.map((id) => [id, id])),
      },
      preferences: preferenceRepository({ find: async () => preferences, save: async () => undefined, isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined }),
      authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
      insertNotification: async () => { counts.notifications++; return true; },
      deliverableSubscriptions: async () => ['phone'],
      emailedRecently: async () => false,
      // One copy for the sign-in address when its switch is on, and one for each confirmed extra address that is switched on.
      insertEmails: async ({ account }) => [...(account ? [randomUUID()] : []), ...Array.from({ length: extras }, () => randomUUID())],
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

  test('inside quiet hours the inbox keeps the notification and no push or email is queued, now or later (C-31)', async () => {
    const { counts, uow } = generator(quiet);
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 0, emails: 0 });
  });

  test('outside quiet hours, and with them off, the same notification sends push and email at once', async () => {
    for (const preferences of [{ ...fresh(), quietEnabled: true, quietStart: 22 * 60, quietEnd: 7 * 60 }, fresh()]) {
      const { counts, uow } = generator(preferences);
      await generateNotifications(uow, { emailAvailable: true, now });
      assert.deepEqual(counts, { notifications: 1, pushes: 1, emails: 1 });
    }
  });

  test('Email me too goes to every address that is switched on: the sign-in address and each confirmed extra address', async () => {
    const { counts, uow } = generator(fresh(), 2);
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 1, emails: 3 });
  });

  test('a sign-in address that is switched off gets no copy, and the extra addresses still do (C-49)', async () => {
    const { counts, uow } = generator({ ...fresh(), accountEnabled: false }, 1);
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 1, emails: 1 });
  });

  test('Email me too off keeps push and the inbox but queues no email', async () => {
    const { counts, uow } = generator({ ...fresh(), emailMe: false });
    await generateNotifications(uow, { emailAvailable: true, now });
    assert.deepEqual(counts, { notifications: 1, pushes: 1, emails: 0 });
  });
});
