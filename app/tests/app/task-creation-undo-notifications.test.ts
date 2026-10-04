import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { assignmentDeliveryAdmission, pushDeliveryRepository } from '@flux/db';
import { deliverNotificationEmail, deliverPushJob, loadNotificationMailConfig, loadPushSenderConfig, policySourceReader, type DeliveryPorts } from '@flux/core';
import type { WorkItem } from '@flux/contracts';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { emailUnitOfWork, pushPreferenceCheck, pushQuietCheck, smtpNotificationMailer } from '../../apps/worker/src/notifications/adapters.js';
import { createPushAgent, webPushSender } from '../../apps/worker/src/push/deliver.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect } from './support/mcp.js';
import { barrier } from './support/locks.js';
import { mailpitUrl } from './support/http.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';

async function queuedAssignment() {
  const f = await actionScene(pool);
  const owner = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const email = (await pool.query('SELECT email FROM auth_users WHERE id=$1', [owner])).rows[0].email as string;
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  expect(await f.owner.request('PATCH', '/api/v1/notification-preferences', { body: {
    channels: { assigned: { inbox: true, push: true, email: true } }, emailDestination: 'account',
    quietHours: { enabled: true, start: clock((minute + 1410) % 1440), end: clock((minute + 90) % 1440), timeZone: 'UTC' },
  } }), 200);
  const subscription = await subscribe(f.owner);
  const item = await db.transaction(async (tx) => {
    const native = nativeWorkInTransaction(tx);
    const result = await native.createWork({ kind: 'agent', id: f.agentId }, f.projectId,
      { title: 'Unused assigned trial', owner: { kind: 'human', id: owner } });
    await native.flushEvents(); return result;
  });
  const queued = await waitFor(async () => {
    const rows = await pool.query(`SELECT n.id, e.id AS email_id FROM notifications n
      JOIN notification_emails e ON e.notification_id=n.id
      WHERE n.user_id=$1 AND n.reason='assigned' AND n.url=$2 AND e.status='queued'`,
    [owner, `/projects/${f.projectId}/tasks?open=work:${item.id}`]);
    return rows.rows[0] as { id: string; email_id: string } | undefined;
  }, 'the real generator queued assignment');
  // Existing jobs retain their quiet-hour start_after, so the controlled delivery owns this attempt.
  expect(await f.owner.request('PATCH', '/api/v1/notification-preferences', { body: { quietHours: { enabled: false } } }), 200);
  const config = loadPushSenderConfig();
  assert.equal(config.status, 'available');
  if (config.status !== 'available') throw new Error('Push test configuration required');
  const agent = createPushAgent(config);
  const ports: DeliveryPorts = { available: true, targets: pushDeliveryRepository(db), authorizer: policySourceReader(db),
    sender: webPushSender(config, agent), admitSend: (id, send) => assignmentDeliveryAdmission(db, id, send),
    stillWanted: pushPreferenceCheck(db), quietUntil: pushQuietCheck(db) };
  const undo = () => f.owner.request('POST', `/api/v1/work/${item.id}/creation-undo`,
    { body: { clientCommandId: randomUUID(), expectedVersion: item.version } });
  return { ...f, owner, email, item, queued, subscription, agent, ports, undo,
    job: { notificationId: queued.id, subscriptionId: subscription.id, userId: owner } };
}

test('queued push rechecks task lifecycle after a held source authorizer or quiet-hour check', async () => {
  for (const phase of ['authorizer', 'quiet'] as const) {
    const f = await queuedAssignment(); const held = barrier(); const release = barrier();
    try {
      const ports = { ...f.ports };
      if (phase === 'authorizer') ports.authorizer = { async canRead(user, source) {
        const result = await f.ports.authorizer.canRead(user, source);
        held.resolve(); await release.promise; return result;
      } };
      else ports.quietUntil = async (user) => {
        const result = await f.ports.quietUntil!(user);
        held.resolve(); await release.promise; return result;
      };
      const delivery = deliverPushJob(ports, f.job);
      await held.promise; expect(await f.undo(), 200); release.resolve();
      assert.deepEqual(await delivery, { outcome: 'skipped', reason: 'task creation was undone before delivery' });
      assert.equal((await recordedPushes(f.subscription.subscription.mockId)).length, 0);
      const history = expect(await f.owner.request('GET', `/api/v1/inbox/${f.queued.id}`), 200);
      assert.match(String(history.body), /Task creation undone/);
    } finally { release.resolve(); f.agent.destroy(); }
  }
});

test('queued email rechecks lifecycle after a held current account-address check, before actual SMTP', async () => {
  const f = await queuedAssignment(); const held = barrier(); const release = barrier();
  const config = loadNotificationMailConfig();
  if (config.status !== 'available') throw new Error('SMTP test configuration required');
  const smtp = smtpNotificationMailer(config);
  const base = emailUnitOfWork(db);
  const uow: typeof base = { admitSend: base.admitSend, run: (action) => base.run((ports) => action({ ...ports,
    async accountAddress(user) { const result = await ports.accountAddress(user); held.resolve(); await release.promise; return result; },
  })) };
  try {
    const delivery = deliverNotificationEmail({ available: true, origin: config.origin, uow, mailer: smtp }, { emailId: f.queued.email_id });
    await held.promise; expect(await f.undo(), 200); release.resolve();
    assert.deepEqual(await delivery, { outcome: 'skipped', reason: 'task creation was undone before delivery' });
    const mail = await (await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${f.email}"`)}`)).json() as { messages: unknown[] };
    assert.equal(mail.messages.length, 0);
    assert.equal((await pool.query('SELECT status FROM notification_emails WHERE id=$1', [f.queued.email_id])).rows[0].status, 'skipped');
  } finally { release.resolve(); smtp.close(); f.agent.destroy(); }
});

test('already admitted real push finishes as history while Undo proceeds without waiting for its response', async () => {
  const f = await queuedAssignment(); const entered = barrier(); const release = barrier();
  const sender = f.ports.sender;
  f.ports.sender = { send(subscription, payload) {
    const response = sender.send(subscription, payload); // Concrete provider handoff occurs synchronously.
    entered.resolve(); return response.then(async (result) => { await release.promise; return result; });
  } };
  try {
    const delivery = deliverPushJob(f.ports, f.job);
    await entered.promise; expect(await f.undo(), 200); release.resolve();
    assert.equal((await delivery).outcome, 'sent');
    assert.equal((await recordedPushes(f.subscription.subscription.mockId)).length, 1);
    assert.equal((await f.read(f.item.id) as unknown as WorkItem).lifecycle?.state, 'creation_reverted');
  } finally { release.resolve(); f.agent.destroy(); }
});

test('post-handoff SQL rollback and callback rejection are observed as unknown without another provider call', async () => {
  const f = await queuedAssignment(); let calls = 0;
  try {
    const rollbackDb = { transaction: <T>(action: Parameters<typeof db.transaction<T>>[0]) => db.transaction(async (tx) => {
      await action(tx); throw new Error('Injected admission rollback after handoff');
    }) };
    const result = await assignmentDeliveryAdmission(rollbackDb, f.queued.id, () => {
      calls++; return Promise.reject(new Error('Injected provider rejection'));
    });
    assert.deepEqual(result, { status: 'unknown' }); assert.equal(calls, 1);
    expect(await f.undo(), 200);
  } finally { f.agent.destroy(); }
});
