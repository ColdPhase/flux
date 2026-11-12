import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  DEFAULT_PREFERENCES,
  generateNotifications,
  noticeEventKind,
  preferenceRepository,
  type GeneratorPorts,
  type NoticeAnnouncement,
  type StoredPreferences,
} from '@flux/core';

// The open tab's notice (#1243): the generator announces a notification that interrupts its person, by the same rule as push (the
// level, quiet hours, mutes), once per batch and after every row of the batch is stored.

function generator(preferences: StoredPreferences, options: { muted?: boolean; messages?: number } = {}) {
  const workspaceId = randomUUID();
  const dmId = randomUUID();
  const log: string[] = [];
  const inserted: string[] = [];
  const announced: NoticeAnnouncement[][] = [];
  const events = Array.from({ length: options.messages ?? 1 }, (_, index) => ({
    id: randomUUID(), seq: index + 1, kind: 'dm.message_sent.v1', workspaceId, objectId: dmId, actorId: 'human:jonas', data: { messageId: randomUUID() },
  }));
  const ports: GeneratorPorts = {
    lockCursor: async () => 0,
    advanceCursor: async () => { log.push('cursor'); },
    eventsAfter: async (seq) => (seq ? [] : events),
    facts: {
      audience: async () => ['ada', 'jonas'], projectMessage: async () => null, work: async () => null, decision: async () => null, liveInvitation: async () => null, liveSession: async () => null, waitingChange: async () => null,
      dmMessage: async (id, messageId) => ({ id: messageId, workspaceId, dmId: id, kind: 'pair', title: null, authorId: 'jonas', body: 'Can you check the probes?', participantIds: ['ada', 'jonas'] }),
      names: async (ids) => new Map(ids.map((id) => [id, id === 'jonas' ? 'Jonas Berg' : 'Ada'])),
    },
    preferences: preferenceRepository({ find: async () => preferences, save: async () => undefined, isMuted: async () => !!options.muted, mutes: async () => [], setMuted: async () => undefined }),
    authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
    insertNotification: async (notification) => { inserted.push(notification.id); log.push('insert'); return true; },
    deliverableSubscriptions: async () => [],
    emailedRecently: async () => false,
    insertEmails: async () => [],
    enqueuePush: async () => null,
    enqueueEmail: async () => null,
    recordFailure: async () => 1,
    deadLetter: async () => undefined,
    announceNotices: async (notices) => { announced.push([...notices]); log.push('announce'); },
    isolate: (work) => work(),
  };
  return { inserted, announced, log, dmId, workspaceId, uow: { run: <T>(work: (p: GeneratorPorts) => Promise<T>) => work(ports) } };
}

const now = () => new Date('2026-11-12T12:00:00Z');
const fresh = (): StoredPreferences => ({ ...DEFAULT_PREFERENCES });

describe('the notice on an open tab', () => {
  test('a direct message at Only what needs me is announced to its person alone, with the notification as its id', async () => {
    const run = generator(fresh());
    await generateNotifications(run.uow, { emailAvailable: false, now });
    assert.equal(run.announced.length, 1);
    assert.deepEqual(run.announced[0], [{ notificationId: run.inserted[0], userId: 'ada', workspaceId: run.workspaceId, source: { type: 'dm', id: run.dmId }, actorId: 'human:jonas' }]);
    assert.equal(noticeEventKind('dm'), 'dm.notice.v1');
    assert.equal(noticeEventKind('project'), 'project.notice.v1');
  });

  test('a burst is announced once, last: after every row of the batch and the cursor', async () => {
    const run = generator(fresh(), { messages: 3 });
    await generateNotifications(run.uow, { emailAvailable: false, now });
    assert.deepEqual(run.log, ['insert', 'insert', 'insert', 'cursor', 'announce']);
    assert.deepEqual(run.announced[0]!.map((notice) => notice.notificationId), run.inserted);
  });

  test('quiet hours, the level Nothing and a muted place announce nothing; the Inbox keeps the row except where muted', async () => {
    const quiet = generator({ ...fresh(), quietEnabled: true, quietStart: 1, quietEnd: 0, timeZone: 'UTC' });
    await generateNotifications(quiet.uow, { emailAvailable: false, now });
    assert.deepEqual([quiet.inserted.length, quiet.announced.length], [1, 0], 'quiet hours: stored, not announced');

    const nothing = generator({ ...fresh(), level: 'nothing' });
    await generateNotifications(nothing.uow, { emailAvailable: false, now });
    assert.deepEqual([nothing.inserted.length, nothing.announced.length], [1, 0], 'Nothing: stored, not announced');

    const muted = generator(fresh(), { muted: true });
    await generateNotifications(muted.uow, { emailAvailable: false, now });
    assert.deepEqual([muted.inserted.length, muted.announced.length], [0, 0], 'muted: neither');
  });
});
