import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { GENERIC_PUSH_TITLE, type PushPayload } from '@flux/contracts';
import {
  buildPushPayload,
  deliverPushJob,
  getInboxItem,
  type NotificationRecord,
  type PushDeliveryTarget,
  type PushSubscriptionRecord,
  type SourceReadDecision,
} from '@flux/core';

// The core notification/push use cases with in-memory ports: no database, queue or network
// (issue #46). Shows the rules hold independently of the adapters.

const workspaceId = randomUUID();
const notification: NotificationRecord = {
  id: randomUUID(), userId: 'user-1', source: { workspaceId, type: 'project', id: randomUUID() },
  title: 'Q3 numbers are in', body: 'Revenue 4.2M', url: '/projects/x', createdAt: new Date(), readAt: null, reason: null,
};
const subscription: PushSubscriptionRecord = {
  id: randomUUID(), userId: 'user-1', sessionId: 'session-1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a',
  expirationTime: null, deviceLabel: null, userAgent: null, createdAt: new Date(), lastSuccessAt: null, lastFailureAt: null, lastFailureStatus: null,
};
const job = { notificationId: notification.id, subscriptionId: subscription.id, userId: 'user-1' };
const reads: SourceReadDecision = { visible: true, allowed: true, workspaceId };

function ports(decision: SourceReadDecision, target: PushDeliveryTarget | null = { subscription, notification, sessionActive: true }) {
  const sent: PushPayload[] = [];
  const deleted: string[] = [];
  return {
    sent,
    deleted,
    ports: {
      available: true,
      admitSend: async (_id: string, send: () => Promise<import('@flux/core').PushSendResult>) => ({ status: 'started' as const, response: await send() }),
      targets: {
        findTarget: async () => target,
        deleteSubscription: async (id: string) => { deleted.push(id); },
        recordSuccess: async () => undefined,
        recordFailure: async () => undefined,
      },
      authorizer: { canRead: async () => decision },
      sender: { send: async (_: PushSubscriptionRecord, payload: PushPayload) => { sent.push(payload); return { kind: 'accepted' as const, status: 201 }; } },
    },
  };
}

describe('push payload privacy (core)', () => {
  test('full text only while the recipient can read the source in its workspace', () => {
    assert.deepEqual(buildPushPayload(notification, reads), { preview: 'full', notificationId: notification.id, title: notification.title, body: notification.body, url: '/projects/x' });
    const generic = { preview: 'generic', notificationId: notification.id, title: GENERIC_PUSH_TITLE };
    assert.deepEqual(buildPushPayload(notification, { visible: true, allowed: false, workspaceId }), generic);
    assert.deepEqual(buildPushPayload(notification, { visible: false, allowed: false, workspaceId: null }), generic);
    assert.deepEqual(buildPushPayload(notification, { ...reads, workspaceId: randomUUID() }), generic, 'a source in another workspace is not this notification\'s source');
  });

  test('a recipient who lost read access gets the generic payload; one who cannot see the source gets nothing', async () => {
    const lostRead = ports({ visible: true, allowed: false, workspaceId });
    assert.deepEqual(await deliverPushJob(lostRead.ports, job), { outcome: 'sent', status: 201, preview: 'generic' });
    assert.deepEqual(lostRead.sent, [{ preview: 'generic', notificationId: notification.id, title: 'New activity in Flux' }]);
    assert.equal(JSON.stringify(lostRead.sent).includes('Revenue'), false, 'no source text leaves the server');

    const invisible = ports({ visible: false, allowed: false, workspaceId: null });
    assert.equal((await deliverPushJob(invisible.ports, job)).outcome, 'skipped');
    assert.deepEqual(invisible.sent, []);

    const allowed = ports(reads);
    assert.equal((await deliverPushJob(allowed.ports, job)).outcome, 'sent');
    assert.equal(allowed.sent[0]?.preview, 'full');
  });

  test('an ended session removes the subscription without sending', async () => {
    const ended = ports(reads, { subscription, notification, sessionActive: false });
    assert.equal((await deliverPushJob(ended.ports, job)).outcome, 'removed');
    assert.deepEqual(ended.deleted, [subscription.id]);
    assert.deepEqual(ended.sent, []);
  });

  test('the inbox answers 404 for an unreadable source and for someone else\'s id', async () => {
    const notifications = {
      insert: async () => undefined,
      findForRecipient: async (userId: string, id: string) => (userId === notification.userId && id === notification.id ? notification : null),
      listReadable: async () => ({ items: [], unread: 0 }),
      markRead: async () => null,
      markAllRead: async () => 0,
    };
    const readable = { notifications, authorizer: { canRead: async () => reads } };
    assert.equal((await getInboxItem(readable, 'user-1', notification.id)).id, notification.id);
    const lost = { notifications, authorizer: { canRead: async () => ({ visible: true, allowed: false, workspaceId }) } };
    await assert.rejects(getInboxItem(lost, 'user-1', notification.id), (error: { status?: number }) => error.status === 404);
    await assert.rejects(getInboxItem(readable, 'user-2', notification.id), (error: { status?: number }) => error.status === 404);
    await assert.rejects(getInboxItem(readable, 'user-1', 'not-a-uuid'), (error: { status?: number }) => error.status === 404);
  });
});
