import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { GENERIC_PUSH_TITLE, type NotificationReason, type PushPayload } from '@flux/contracts';
import {
  DEFAULT_PREFERENCES,
  InvalidInputError,
  LIVE_STARTED_EVENT,
  WAITING_CHANGE_EVENT,
  applyPreferenceChange,
  deliverPushJob,
  generateNotifications,
  hiddenNotificationTitle,
  preferenceRepository,
  type DeliveryPorts,
  type GeneratedNotification,
  type GeneratorEvent,
  type GeneratorPorts,
  type NotificationFacts,
  type NotificationRecord,
  type PushSendJob,
} from '@flux/core';

// "Hide previews" (founder decision, 2026-11-13, #1346): with it on, the push payload carries who and where in fixed words and nothing
// else, for every kind of notice; off, it shows what the Inbox shows. The generator and the delivery are the real ones, with in-memory ports.
// Every case's content carries SECRET, so the payload is searched for it.

const workspaceId = randomUUID();
const projectId = randomUUID();
const dmId = randomUUID();
const conversationId = randomUUID();
const ada = 'ada';
const jonas = 'jonas';

interface Case {
  name: string;
  reason: NotificationReason;
  /** What the push says with Hide previews on. */
  hidden: string;
  event: Omit<GeneratorEvent, 'id' | 'seq' | 'workspaceId'>;
  facts: Partial<NotificationFacts>;
}

const messageId = () => randomUUID();
const dm = (body: string, extra: { kind?: 'pair' | 'group'; title?: string | null } = {}): Pick<Case, 'event' | 'facts'> => {
  const id = messageId();
  return {
    event: { kind: 'dm.message_sent.v1', objectId: dmId, actorId: `human:${jonas}`, data: { messageId: id } },
    facts: { dmMessage: async (_dm, requested) => requested === id ? { id, workspaceId, dmId, kind: extra.kind ?? 'pair', title: extra.title ?? null, authorId: jonas, body, participantIds: [ada, jonas] } : null },
  };
};
const space = (body: string): Pick<Case, 'event' | 'facts'> => {
  const id = messageId();
  return {
    event: { kind: 'project.message_sent.v1', objectId: projectId, actorId: `human:${jonas}`, data: { messageId: id } },
    facts: {
      projectMessage: async (requested) => requested === id ? {
        id, workspaceId, projectId, projectName: 'Tool library', conversationId, opening: 'The opening, SECRET-OPENING, of the thread',
        conversationCreatedBy: { kind: 'human', id: ada }, author: { kind: 'human', id: jonas }, authorName: 'Jonas Berg', body, sequence: 2, earlierAuthors: [],
      } : null,
    },
  };
};
const workFacts = (patch: Record<string, unknown>): NotificationFacts['work'] => async (id) => ({
  id, projectId, projectName: 'Tool library', title: 'SECRET-TASK title', number: 7, ownerUserId: ada, waitingForUserId: null, status: 'open', blocker: null, dropped: false, ...patch,
});
const task = (data: Record<string, unknown>, patch: Record<string, unknown>, kind = 'project.work_created.v1'): Pick<Case, 'event' | 'facts'> => {
  const workId = randomUUID();
  return { event: { kind, objectId: projectId, actorId: `human:${jonas}`, data: { workId, ...data } }, facts: { work: workFacts({ id: workId, ...patch }) } };
};

const cases: Case[] = [
  { name: 'a direct message', reason: 'dm', hidden: 'Jonas Berg sent you a message', ...dm('SECRET-DM text for you') },
  { name: 'a mention in a direct message group', reason: 'mention', hidden: 'Jonas Berg mentioned you in “Lunch crew”', ...dm('@Ada SECRET-GROUP-MENTION', { kind: 'group', title: 'Lunch crew' }) },
  { name: 'a message in a group without a name', reason: 'dm', hidden: 'Jonas Berg sent you a message in a group', ...dm('SECRET-GROUP text', { kind: 'group' }) },
  { name: 'a mention in a space', reason: 'mention', hidden: 'Jonas Berg mentioned you in Tool library', ...space('@Ada SECRET-MENTION please look') },
  { name: 'a question in a space', reason: 'question', hidden: 'Jonas Berg asked you in Tool library', ...space('@Ada SECRET-QUESTION which one?') },
  { name: 'a reply in a thread you started', reason: 'reply', hidden: 'Jonas Berg replied in Tool library', ...space('SECRET-REPLY and nothing more') },
  { name: 'a task given to you', reason: 'assigned', hidden: 'Jonas Berg assigned you a task in Tool library', ...task({ assignedTo: ada }, {}) },
  { name: 'a task that waits for you', reason: 'assigned', hidden: 'Jonas Berg assigned you a task in Tool library',
    ...task({ waitingFor: ada }, { status: 'blocked', waitingForUserId: ada, ownerUserId: jonas, blocker: 'SECRET-BLOCKER' }, 'project.work_updated.v1') },
  { name: 'a task that can continue', reason: 'assigned', hidden: 'Jonas Berg assigned you a task in Tool library',
    ...task({ resumedFor: ada, reason: 'decision' }, { status: 'open' }, 'project.work_updated.v1') },
  (() => {
    const decisionId = randomUUID();
    return {
      name: 'a decision about your work', reason: 'review' as const, hidden: 'Jonas Berg asked for your review in Tool library',
      event: { kind: 'project.decision_proposed.v1', objectId: projectId, actorId: `human:${jonas}`, data: { decisionId } },
      facts: { decision: async (id: string) => id === decisionId ? { id, projectId, projectName: 'Tool library', title: 'SECRET-DECISION title', by: { kind: 'human' as const, id: jonas }, workOwners: [ada], agentOwner: null } : null },
    };
  })(),
  (() => {
    const changeId = randomUUID();
    return {
      name: 'an agent waiting for your OK', reason: 'approval' as const, hidden: 'Scout is waiting for your OK in Tool library',
      event: { kind: WAITING_CHANGE_EVENT, objectId: projectId, actorId: `agent:${randomUUID()}`, data: { changeId } },
      facts: { waitingChange: async (id: string) => id === changeId ? { id, projectId, projectName: 'Tool library', ownerUserId: ada, agentName: 'Scout', group: 'run-1', words: 'Add “SECRET-CHANGE”' } : null },
    };
  })(),
  (() => {
    const invitationId = randomUUID();
    const sessionId = randomUUID();
    return {
      name: 'an invitation to work together', reason: 'invitation' as const, hidden: 'Jonas Berg invited you to work together in Tool library',
      event: { kind: 'project.live_invited.v1', objectId: projectId, actorId: `human:${jonas}`, data: { invitationId, sessionId, recipientId: ada } },
      facts: {
        liveInvitation: async (id: string) => id === invitationId ? { id, sessionId, projectId, projectName: 'Tool library', inviterId: jonas, recipientId: ada, anchor: { type: 'work' as const, label: 'SECRET-ANCHOR' } } : null,
      },
    };
  })(),
  (() => {
    const sessionId = randomUUID();
    return {
      name: 'a call started in your space', reason: 'call' as const, hidden: 'Jonas Berg started a call in Tool library',
      event: { kind: LIVE_STARTED_EVENT, objectId: projectId, actorId: `human:${jonas}`, data: { sessionId } },
      facts: { liveSession: async (id: string) => id === sessionId ? { id, projectId, projectName: 'Tool library', startedBy: jonas, anchor: { type: 'conversation' as const, label: 'SECRET-TOPIC' } } : null },
    };
  })(),
];

/** Generates the one case's notification for Ada at "Everything", as the worker would, and returns what it stored and queued. */
async function generated(one: Case, options: { sealed?: string } = {}) {
  const stored: GeneratedNotification[] = [];
  const jobs: PushSendJob[] = [];
  const event: GeneratorEvent = { id: randomUUID(), seq: 1, workspaceId, ...one.event };
  const facts: NotificationFacts = {
    audience: async () => [ada, jonas], projectMessage: async () => null, dmMessage: async () => null, work: async () => null, decision: async () => null,
    liveInvitation: async () => null, liveSession: async () => null, waitingChange: async () => null,
    names: async (ids) => new Map(ids.map((id) => [id, id === jonas ? 'Jonas Berg' : 'Ada'])),
    ...(options.sealed ? { sealedWorkspace: async () => ({ name: options.sealed! }) } : {}),
    ...one.facts,
  };
  const ports: GeneratorPorts = {
    lockCursor: async () => 0, advanceCursor: async () => undefined, eventsAfter: async (seq) => seq ? [] : [event], facts,
    preferences: preferenceRepository({ find: async () => ({ ...DEFAULT_PREFERENCES, level: 'everything' }), save: async () => undefined, isMuted: async () => false, mutes: async () => [], setMuted: async () => undefined }),
    authorizer: { canRead: async () => ({ visible: true, allowed: true, workspaceId }) },
    insertNotification: async (notification) => { stored.push(notification); return true; },
    deliverableSubscriptions: async () => ['subscription-1'], emailedRecently: async () => false, insertEmails: async () => [], enqueuePush: async (job) => { jobs.push(job); return randomUUID(); },
    enqueueEmail: async () => null, recordFailure: async () => 1, deadLetter: async () => undefined, isolate: (work) => work(),
  };
  await generateNotifications({ run: (work) => work(ports) }, { emailAvailable: false, now: () => new Date('2026-11-13T12:00:00Z') });
  assert.equal(stored.length, 1, `${one.name}: one notification for Ada`);
  assert.equal(jobs.length, 1, `${one.name}: one push job`);
  return { notification: stored[0]!, job: jobs[0]! };
}

/** The worker's delivery of that job to a device, with Ada's "Hide previews" as given; returns the one payload sent. */
async function delivered(notification: GeneratedNotification, job: PushSendJob, hidePreviews: boolean, readable = true): Promise<PushPayload> {
  const record: NotificationRecord = { id: notification.id, userId: ada, source: notification.source, title: notification.title, body: notification.body, url: notification.url,
    createdAt: new Date(), readAt: null, reason: notification.reason };
  const sent: PushPayload[] = [];
  const ports: DeliveryPorts = {
    available: true,
    targets: {
      findTarget: async () => ({ subscription: { id: job.subscriptionId, userId: ada, sessionId: 'session', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: '', auth: '', expirationTime: null,
        deviceLabel: null, userAgent: null, createdAt: new Date(), lastSuccessAt: null, lastFailureAt: null, lastFailureStatus: null }, notification: record, sessionActive: true }),
      deleteSubscription: async () => undefined, recordSuccess: async () => undefined, recordFailure: async () => undefined,
    },
    authorizer: { canRead: async () => ({ visible: true, allowed: readable, workspaceId: readable ? workspaceId : null }) },
    sender: { send: async (_subscription, payload) => { sent.push(payload); return { kind: 'accepted', status: 201 }; } },
    admitSend: async (_id, send) => ({ status: 'started', response: await send() }),
    hidePreviews: async () => hidePreviews,
  };
  const outcome = await deliverPushJob(ports, job);
  assert.equal(outcome.outcome, 'sent');
  assert.equal(sent.length, 1);
  return sent[0]!;
}

describe('Hide previews: what the push payload carries', () => {
  for (const one of cases) {
    test(`${one.name}: on, only who and where; off, what the Inbox shows`, async () => {
      const { notification, job } = await generated(one);
      assert.equal(notification.reason, one.reason);
      const off = await delivered(notification, job, false);
      assert.equal(off.preview, 'full');
      assert.match(JSON.stringify(off), /SECRET/, 'off: the push shows the content, so the check below means something');

      const on = await delivered(notification, job, true);
      assert.deepEqual(on, { preview: 'hidden', notificationId: notification.id, title: one.hidden }, 'on: the id and one title, nothing else');
      assert.doesNotMatch(JSON.stringify(on), /SECRET/, 'on: no content anywhere in the payload');
      assert.deepEqual(Object.keys(on).sort(), ['notificationId', 'preview', 'title'], 'no body and no link');
      // The Inbox row is the same either way: Hide previews changes only what is sent.
      assert.match(`${notification.title} ${notification.body}`, /SECRET|Jonas|Scout/, 'the stored row keeps its content');
    });
  }

  test('the words are the same fixed words an encrypted workspace uses, with who and where', () => {
    assert.equal(hiddenNotificationTitle('mention', 'Ada', 'Tool library'), 'Ada mentioned you in Tool library');
    assert.equal(hiddenNotificationTitle('dm', 'Ada', ''), 'Ada sent you a message');
  });

  test('a notification without a title to say (made directly, or queued before this) shows the fixed text, and a recipient who cannot read it gets it too', async () => {
    const { notification, job } = await generated(cases[3]!);
    const queuedEarlier: PushSendJob = { notificationId: job.notificationId, subscriptionId: job.subscriptionId, userId: job.userId };
    assert.deepEqual(await delivered(notification, queuedEarlier, true), { preview: 'generic', notificationId: notification.id, title: GENERIC_PUSH_TITLE });
    assert.deepEqual(await delivered(notification, job, true, false), { preview: 'generic', notificationId: notification.id, title: GENERIC_PUSH_TITLE });
    assert.deepEqual(await delivered(notification, job, false, false), { preview: 'generic', notificationId: notification.id, title: GENERIC_PUSH_TITLE });
  });

  test('the switch is read when the push is sent: the same queued job shows the text, then hides it', async () => {
    const { notification, job } = await generated(cases[3]!);
    assert.equal((await delivered(notification, job, false)).preview, 'full');
    assert.equal((await delivered(notification, job, true)).preview, 'hidden');
    assert.equal((await delivered(notification, job, false)).preview, 'full');
  });

  test('an encrypted workspace stays content-free either way: its stored title is the one that is sent', async () => {
    const { notification, job } = await generated(cases[3]!, { sealed: 'Garden club' });
    assert.deepEqual([notification.title, notification.body], ['Jonas Berg mentioned you in Garden club', '']);
    assert.equal(job.hiddenTitle, notification.title);
    assert.doesNotMatch(JSON.stringify(await delivered(notification, job, true)), /SECRET/);
    assert.doesNotMatch(JSON.stringify(await delivered(notification, job, false)), /SECRET|Tool library/);
  });
});

describe('Hide previews: the preference', () => {
  test('it is off by default, changes on its own, and refuses anything but true or false', () => {
    assert.equal(DEFAULT_PREFERENCES.hidePreviews, false);
    const on = applyPreferenceChange({ ...DEFAULT_PREFERENCES, level: 'everything' }, { hidePreviews: true });
    assert.deepEqual([on.hidePreviews, on.level], [true, 'everything']);
    assert.equal(applyPreferenceChange(on, { emailMe: false }).hidePreviews, true, 'another change leaves it as it was');
    assert.equal(applyPreferenceChange(on, { hidePreviews: false }).hidePreviews, false);
    assert.throws(() => applyPreferenceChange(on, { hidePreviews: 'yes' as never }), (error: unknown) => error instanceof InvalidInputError && error.code === 'INVALID_HIDE_PREVIEWS');
  });
});
