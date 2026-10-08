import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PgBoss } from 'pg-boss';
import { assignmentDeliveryAdmission, pushDeliveryRepository } from '@flux/db';
import { deliverNotificationEmail, deliverPushJob, loadNotificationMailConfig, loadPushSenderConfig, policySourceReader, type DeliveryPorts } from '@flux/core';
import type { WorkItem } from '@flux/contracts';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { emailUnitOfWork, pushPreferenceCheck, pushQuietCheck, smtpNotificationMailer } from '../../apps/worker/src/notifications/adapters.js';
import { createPushAgent, webPushSender } from '../../apps/worker/src/push/deliver.js';
import { connectionString, db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect } from './support/mcp.js';
import { barrier } from './support/locks.js';
import { mailpitUrl } from './support/http.js';
import { recordedPushes, subscribe, waitFor } from './support/push.js';

// Use the same real queue adapter as the worker, including delivery promotion (#329).
const queue = new PgBoss({ connectionString, migrate: false });
before(() => queue.start());
after(() => queue.stop());

async function within<T>(pending: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function settleDelivery(pending: Promise<unknown> | undefined) {
  if (pending) await within(pending.then(() => undefined, () => undefined), 'released delivery cleanup');
}

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
  return { ...f, ownerId: owner, email, item, queued, subscription, agent, ports, undo,
    job: { notificationId: queued.id, subscriptionId: subscription.id, userId: owner } };
}

test('queued push rechecks task lifecycle after a held source authorizer or quiet-hour check', { timeout: 45_000 }, async () => {
  for (const phase of ['authorizer', 'quiet'] as const) {
    const f = await queuedAssignment(); const held = barrier(); const release = barrier();
    let delivery: Promise<unknown> | undefined;
    try {
      const ports = { ...f.ports };
      if (phase === 'authorizer') ports.authorizer = { async canRead(user, source) {
        const result = await f.ports.authorizer.canRead(user, source);
        held.resolve(); await within(release.promise, 'delivery release'); return result;
      } };
      else ports.quietUntil = async (user) => {
        const result = await f.ports.quietUntil!(user);
        held.resolve(); await within(release.promise, 'delivery release'); return result;
      };
      delivery = deliverPushJob(ports, f.job);
      void delivery.catch(() => undefined);
      await within(held.promise, 'delivery barrier'); expect(await f.undo(), 200); release.resolve();
      assert.deepEqual(await within(delivery, 'delivery outcome'), { outcome: 'skipped', reason: 'task creation was undone before delivery' });
      assert.equal((await recordedPushes(f.subscription.subscription.mockId)).length, 0);
      const history = expect(await f.owner.request('GET', `/api/v1/inbox/${f.queued.id}`), 200);
      assert.match(String(history.body), /Task creation undone/);
    } finally { release.resolve(); try { await settleDelivery(delivery); } finally { f.agent.destroy(); } }
  }
});

test('queued email rechecks lifecycle after a held current account-address check, before actual SMTP', { timeout: 45_000 }, async () => {
  const f = await queuedAssignment(); const held = barrier(); const release = barrier();
  const config = loadNotificationMailConfig();
  if (config.status !== 'available') throw new Error('SMTP test configuration required');
  const smtp = smtpNotificationMailer(config);
  const base = emailUnitOfWork(db, queue);
  const uow: typeof base = { admitSend: base.admitSend, run: (action) => base.run((ports) => action({ ...ports,
    async accountAddress(user) { const result = await ports.accountAddress(user); held.resolve(); await within(release.promise, 'delivery release'); return result; },
  })) };
  let delivery: ReturnType<typeof deliverNotificationEmail> | undefined;
  try {
    delivery = deliverNotificationEmail({ available: true, origin: config.origin, uow, mailer: smtp }, { emailId: f.queued.email_id });
    void delivery.catch(() => undefined);
    await within(held.promise, 'delivery barrier'); expect(await f.undo(), 200); release.resolve();
    assert.deepEqual(await within(delivery, 'delivery outcome'), { outcome: 'skipped', reason: 'task creation was undone before delivery' });
    const mail = await (await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${f.email}"`)}`)).json() as { messages: unknown[] };
    assert.equal(mail.messages.length, 0);
    assert.equal((await pool.query('SELECT status FROM notification_emails WHERE id=$1', [f.queued.email_id])).rows[0].status, 'skipped');
  } finally { release.resolve(); try { await settleDelivery(delivery); } finally { smtp.close(); f.agent.destroy(); } }
});

test('already admitted real push finishes as history while Undo proceeds without waiting for its response', { timeout: 45_000 }, async () => {
  const f = await queuedAssignment(); const entered = barrier(); const release = barrier();
  const sender = f.ports.sender;
  f.ports.sender = { send(subscription, payload) {
    const response = sender.send(subscription, payload); // Concrete provider handoff occurs synchronously.
    entered.resolve(); return response.then(async (result) => { await within(release.promise, 'provider response release'); return result; });
  } };
  let delivery: ReturnType<typeof deliverPushJob> | undefined;
  try {
    delivery = deliverPushJob(f.ports, f.job);
    void delivery.catch(() => undefined);
    await within(entered.promise, 'actual provider handoff'); expect(await f.undo(), 200); release.resolve();
    assert.equal((await within(delivery, 'delivery outcome')).outcome, 'sent');
    assert.equal((await recordedPushes(f.subscription.subscription.mockId)).length, 1);
    assert.equal((await f.read(f.item.id) as unknown as WorkItem).lifecycle?.state, 'creation_reverted');
  } finally { release.resolve(); try { await settleDelivery(delivery); } finally { f.agent.destroy(); } }
});

test('post-handoff SQL rollback stays unknown while a confirmed transaction preserves provider rejection without another call', { timeout: 45_000 }, async () => {
  const f = await queuedAssignment(); let calls = 0;
  try {
    const rollbackDb = { transaction: <T>(action: Parameters<typeof db.transaction<T>>[0]) => db.transaction(async (tx) => {
      await action(tx); throw new Error('Injected admission rollback after handoff');
    }) };
    const result = await assignmentDeliveryAdmission(rollbackDb, f.queued.id, () => {
      calls++; return Promise.reject(new Error('Injected provider rejection'));
    });
    assert.deepEqual(result, { status: 'unknown' }); assert.equal(calls, 1);
    const rejected = new Error('Known provider response rejection after the admission transaction');
    await assert.rejects(assignmentDeliveryAdmission(db, f.queued.id, () => {
      calls++; return Promise.reject(rejected);
    }), (error: unknown) => error === rejected);
    assert.equal(calls, 2, 'each explicit admission attempts the concrete provider once, never internally retries');
    expect(await f.undo(), 200);
  } finally { f.agent.destroy(); }
});

test('real SMTP handoff with injected admission SQL rollback retains the sending claim and never sends that copy again', { timeout: 45_000 }, async () => {
  const f = await queuedAssignment(); const config = loadNotificationMailConfig();
  if (config.status !== 'available') throw new Error('SMTP test configuration required');
  const smtp = smtpNotificationMailer(config); const base = emailUnitOfWork(db, queue);
  let calls = 0;
  const rollbackDb = { transaction: <T>(action: Parameters<typeof db.transaction<T>>[0]) => db.transaction(async (tx) => {
    await action(tx); throw new Error('Injected admission SQL rollback after real SMTP handoff');
  }) };
  const uow: typeof base = { run: base.run, admitSend: (id, send) => assignmentDeliveryAdmission(rollbackDb, id, () => {
    calls++; return send();
  }) };
  try {
    const job = { emailId: f.queued.email_id };
    assert.deepEqual(await deliverNotificationEmail({ available: true, origin: config.origin, uow, mailer: smtp }, job),
      { outcome: 'unknown', reason: 'delivery outcome unknown after provider admission' });
    assert.equal((await pool.query('SELECT status FROM notification_emails WHERE id=$1', [job.emailId])).rows[0].status, 'sending');
    assert.deepEqual(await deliverNotificationEmail({ available: true, origin: config.origin, uow: base, mailer: smtp }, job),
      { outcome: 'skipped', reason: 'already sending' });
    assert.equal(calls, 1, 'the unknown result never requeues or re-admits this copy');
    const mail = await waitFor(async () => {
      const response = await (await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${f.email}"`)}`)).json() as { messages: unknown[] };
      return response.messages.length === 1 ? response : undefined;
    }, 'the one actual accepted SMTP message');
    assert.equal(mail.messages.length, 1);
  } finally { smtp.close(); f.agent.destroy(); }
});
