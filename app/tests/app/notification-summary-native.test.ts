import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test, type TestContext } from 'node:test';
import { PgBoss } from 'pg-boss';
import { loadPushSenderConfig, sendMorningSummaries, type PushSendJob, type SummaryUnitOfWork } from '@flux/core';
import type { NotificationPreferences, NotificationSourceRef, UpdateNotificationPreferencesCommand } from '@flux/contracts';
import { summaryUnitOfWork } from '../../apps/worker/src/jobs/morning-summary.js';
import { deliverPush } from '../../apps/worker/src/push/index.js';
import { connectionString, db, pool } from './support/db.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { decryptPush, recordedPushes, subscribe } from './support/push.js';

// Real session/grant/preferences APIs, SQL transactions and encrypted Web Push against the
// Compose push mock. Only enqueuePush is held: delivery runs after a committed summary and
// a real permission/preference change, rather than replacing the authorization result.
const queue = new PgBoss({ connectionString, migrate: false });
before(() => queue.start());
after(() => queue.stop());
const sender = loadPushSenderConfig();
const NOW = new Date('2034-06-12T00:05:00Z');
const INITIAL_CLAIM = '2034-06-10';

async function preferences(who: Person, change: UpdateNotificationPreferencesCommand) {
  return expectStatus(await who.browser.request('PATCH', '/api/v1/notification-preferences', { body: change }), 200) as NotificationPreferences;
}

async function watermark(userId: string): Promise<string | null> {
  const result = await pool.query('SELECT summary_last_on::text AS day FROM notification_preferences WHERE user_id = $1', [userId]);
  return result.rows[0].day as string | null;
}

interface SummaryRow {
  id: string;
  source_id: string;
  title: string;
  in_inbox: boolean;
  reason: null;
  delivery_kind: 'morning_summary';
  summary_sources: NotificationSourceRef[];
}

async function summaries(userId: string): Promise<SummaryRow[]> {
  return (await pool.query(`SELECT id, source_id, title, in_inbox, reason, delivery_kind, summary_sources
    FROM notifications WHERE user_id = $1 AND delivery_kind = 'morning_summary' ORDER BY created_at, id`, [userId])).rows as SummaryRow[];
}

async function fixture(t: TestContext) {
  assert.equal(sender.status, 'available', 'the Compose suite must configure VAPID and pushmock');
  const owner = await person('Summary owner');
  const reader = await person('Summary reader');
  t.after(() => preferences(reader, { morningSummary: { enabled: false } }));
  await preferences(reader, { level: 'needsYou', emailDestination: 'none', quietHours: { enabled: false, timeZone: 'UTC' }, morningSummary: { enabled: false, at: '23:59' } });
  // Keep the live scheduler out even if a test spans its quarter-hour tick. All simulated
  // schedules below are in 2034; the real worker's earlier day cannot advance this watermark.
  await pool.query('UPDATE notification_preferences SET summary_last_on = $2 WHERE user_id = $1', [reader.id, INITIAL_CLAIM]);
  const space = await workspace(owner, 'Summary source isolation');
  await addMember(owner, space.id, reader, 'member');
  const a = await project(owner, space.id, 'Readable anchor A', 'restricted');
  const b = await project(owner, space.id, 'Independent source B', 'restricted');
  await grant(owner, a.id, reader, 'viewer');
  await grant(owner, b.id, reader, 'viewer');
  const { subscription, id: subscriptionId } = await subscribe(reader.browser);
  const sourceA: NotificationSourceRef = { workspaceId: space.id, type: 'project', id: a.id };
  const sourceB: NotificationSourceRef = { workspaceId: space.id, type: 'project', id: b.id };
  // Ordinary unread notifications are valid existing producer output; no queue job is emitted
  // for these seeds. Explicit dates make A the anchor without relying on insertion timing.
  for (const [source, createdAt] of [[sourceA, '2034-06-11T23:58:00Z'], [sourceB, '2034-06-11T23:57:00Z']] as const) {
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url, reason, created_at)
      VALUES ($1, $2, $3, 'project', $4, 'Work awaits your review', 'Unread work', $5, 'assigned', $6)`,
    [randomUUID(), reader.id, space.id, source.id, `/projects/${source.id}`, createdAt]);
  }
  const real = summaryUnitOfWork(db, queue);
  const jobs: PushSendJob[] = [];
  const uow: SummaryUnitOfWork = {
    candidates: async () => (await real.candidates()).filter((candidate) => candidate.userId === reader.id),
    run: (work) => real.run((ports) => work({ ...ports, enqueuePush: async (job) => { jobs.push(job); return 'held-for-recheck'; } })),
  };
  return { owner, reader, a, b, sourceA, sourceB, subscription, subscriptionId, jobs, uow };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function enable(f: Fixture) {
  await preferences(f.reader, { level: 'needsYou', morningSummary: { enabled: true, at: '23:59' }, quietHours: { enabled: false, timeZone: 'UTC' } });
}

async function admit(f: Fixture) {
  await enable(f);
  assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 1, empty: 0 });
  const rows = await summaries(f.reader.id);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source_id, f.a.id, 'A really is the persisted anchor; the later revocation targets B');
  assert.deepEqual(row.summary_sources, [f.sourceA, f.sourceB], 'the persisted aggregate retains both independently authorized sources');
  assert.equal(row.delivery_kind, 'morning_summary');
  assert.equal(row.title, '2 things wait in your inbox');
  assert.equal(row.in_inbox, false);
  assert.equal(row.reason, null, 'an explicit kind distinguishes this summary from a legacy no-reason notification');
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.jobs[0], { notificationId: row.id, subscriptionId: f.subscriptionId, userId: f.reader.id });
  assert.equal(await watermark(f.reader.id), '2034-06-11', 'the midnight tick claims yesterday\'s scheduled day');
  const actualQueue = await pool.query("SELECT id FROM pgboss.job WHERE data->>'notificationId' = $1", [row.id]);
  assert.equal(actualQueue.rowCount, 0, 'only enqueuePush is held; the real notification transaction is already committed');
  assert.equal((await recordedPushes(f.subscription.mockId)).length, 0);
  expectStatus(await f.reader.browser.request('GET', `/api/v1/inbox/${row.id}`), 200);
  return row;
}

async function skipped(f: Fixture) {
  assert.equal((await deliverPush({ db, config: sender }, f.jobs[0]!)).outcome, 'skipped');
  assert.equal((await recordedPushes(f.subscription.mockId)).length, 0, 'no aggregate, including a generic fallback, leaves the server');
}

async function delivered(f: Fixture, job = f.jobs[0]!) {
  assert.equal((await deliverPush({ db, config: sender }, job)).outcome, 'sent');
  const pushes = await recordedPushes(f.subscription.mockId);
  assert.equal(pushes.length, 1, 'restored current authority/preferences really permit one encrypted push');
  const push = pushes[0]!;
  assert.equal(push.vapid.ok, true);
  const payload = JSON.parse(decryptPush(Buffer.from(push.bodyBase64, 'base64'), f.subscription)) as { notificationId: string; title: string; preview: string };
  assert.equal(payload.notificationId, job.notificationId);
  assert.equal(payload.preview, 'full');
  return payload;
}

describe('morning summary native admission and delivery rechecks (#350)', () => {
  for (const level of ['off', 'nothing'] as const) {
    test(`${level} before admission creates neither a summary, a claim nor a push job`, async (t) => {
      const f = await fixture(t);
      await enable(f);
      await preferences(f.reader, level === 'off' ? { morningSummary: { enabled: false } } : { level: 'nothing' });
      assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 0, empty: 0 });
      assert.equal((await summaries(f.reader.id)).length, 0);
      assert.equal(f.jobs.length, 0);
      assert.equal(await watermark(f.reader.id), INITIAL_CLAIM);
      assert.equal((await recordedPushes(f.subscription.mockId)).length, 0);
      await enable(f);
      assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 1, empty: 0 }, 'a rejected admission does not consume the day');
      assert.equal((await delivered(f)).title, '2 things wait in your inbox');
    });
  }

  const changedBeforeLock: [string, UpdateNotificationPreferencesCommand][] = [
    ['summary Off', { morningSummary: { enabled: false } }],
    ['Nothing', { level: 'nothing' }],
    ['a later time', { morningSummary: { at: '12:00' } }],
    ['a different timezone', { quietHours: { timeZone: 'Pacific/Honolulu' } }],
  ];
  for (const [label, change] of changedBeforeLock) {
    test(`a stale candidate cannot override ${label} committed before its real row lock`, async (t) => {
      const f = await fixture(t);
      await enable(f);
      const stale = await f.uow.candidates();
      assert.equal(stale.length, 1);
      await preferences(f.reader, change);
      const staleScan: SummaryUnitOfWork = { ...f.uow, candidates: async () => stale };
      assert.deepEqual(await sendMorningSummaries(staleScan, NOW), { sent: 0, empty: 0 });
      assert.equal((await summaries(f.reader.id)).length, 0);
      assert.equal(f.jobs.length, 0);
      assert.equal(await watermark(f.reader.id), INITIAL_CLAIM);
      await enable(f);
      assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 1, empty: 0 }, 'fresh current settings admit the positive control');
      assert.equal((await delivered(f)).title, '2 things wait in your inbox');
    });
  }

  test('a stale candidate recomputes its scheduled day from current settings under the real lock', async (t) => {
    const f = await fixture(t);
    await enable(f);
    const stale = await f.uow.candidates();
    await preferences(f.reader, { morningSummary: { at: '00:01' } });
    assert.deepEqual(await sendMorningSummaries({ ...f.uow, candidates: async () => stale }, NOW), { sent: 1, empty: 0 });
    assert.equal(await watermark(f.reader.id), '2034-06-12', 'today\'s newly due time replaces the stale yesterday 23:59 claim');
    assert.equal((await summaries(f.reader.id)).length, 1);
    assert.equal((await delivered(f)).title, '2 things wait in your inbox');
  });

  test('non-anchor and total access loss suppress an admitted A+B aggregate and its direct inbox read', async (t) => {
    const f = await fixture(t);
    const row = await admit(f);
    await grant(f.owner, f.b.id, f.reader, 'denied');
    expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.a.id}`), 200);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.b.id}`), 404);
    await skipped(f);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/inbox/${row.id}`), 404);
    await grant(f.owner, f.a.id, f.reader, 'denied');
    await skipped(f);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/inbox/${row.id}`), 404);
    // Restoring A alone still leaves B unauthorized; a single-anchor implementation fails here.
    await grant(f.owner, f.a.id, f.reader, 'viewer');
    await skipped(f);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/inbox/${row.id}`), 404);
    await grant(f.owner, f.b.id, f.reader, 'viewer');
    expectStatus(await f.reader.browser.request('GET', `/api/v1/inbox/${row.id}`), 200);
    assert.equal((await delivered(f)).title, '2 things wait in your inbox');
  });

  for (const level of ['off', 'nothing'] as const) {
    test(`${level} after admission suppresses delivery; re-enabling releases the same held job`, async (t) => {
      const f = await fixture(t);
      await admit(f);
      await preferences(f.reader, level === 'off' ? { morningSummary: { enabled: false } } : { level: 'nothing' });
      await skipped(f);
      assert.equal((await summaries(f.reader.id)).length, 1, 'the committed private record is not deleted');
      await enable(f);
      assert.equal((await delivered(f)).title, '2 things wait in your inbox');
    });
  }

  test('muting the non-anchor after admission suppresses the whole push; unmuting restores it', async (t) => {
    const f = await fixture(t);
    await admit(f);
    expectStatus(await f.reader.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: f.b.id, muted: true } }), 200);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.a.id}`), 200);
    expectStatus(await f.reader.browser.request('GET', `/api/v1/projects/${f.b.id}`), 200, 'mute does not revoke ordinary reading');
    await skipped(f);
    expectStatus(await f.reader.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: f.b.id, muted: false } }), 200);
    assert.equal((await delivered(f)).title, '2 things wait in your inbox');
  });

  test('an already muted non-anchor is excluded before the aggregate is persisted', async (t) => {
    const f = await fixture(t);
    await enable(f);
    expectStatus(await f.reader.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: f.b.id, muted: true } }), 200);
    assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 1, empty: 0 });
    const [row] = await summaries(f.reader.id);
    assert.ok(row);
    assert.deepEqual(row.summary_sources, [f.sourceA]);
    assert.equal(row.title, '1 thing waits in your inbox');
    assert.equal((await delivered(f)).title, '1 thing waits in your inbox');
  });

  test('an ordinary legacy no-reason notification is not silently reclassified as a summary', async (t) => {
    const f = await fixture(t);
    await preferences(f.reader, { level: 'nothing', morningSummary: { enabled: false } });
    const id = randomUUID();
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, body, url)
      VALUES ($1, $2, $3, 'project', $4, 'Ordinary legacy notice', 'Existing delivery contract', $5)`,
    [id, f.reader.id, f.sourceA.workspaceId, f.a.id, `/projects/${f.a.id}`]);
    const stored = (await pool.query('SELECT reason, delivery_kind, summary_sources FROM notifications WHERE id = $1', [id])).rows[0];
    assert.deepEqual(stored, { reason: null, delivery_kind: 'ordinary', summary_sources: null });
    expectStatus(await f.reader.browser.request('GET', `/api/v1/inbox/${id}`), 200);
    assert.equal((await delivered(f, { notificationId: id, subscriptionId: f.subscriptionId, userId: f.reader.id })).title, 'Ordinary legacy notice');
  });

  test('a queue failure rolls back the summary and its day claim so a retry can deliver', async (t) => {
    const f = await fixture(t);
    await enable(f);
    const failingQueue: SummaryUnitOfWork = {
      ...f.uow,
      run: (work) => f.uow.run((ports) => work({ ...ports, enqueuePush: async () => { throw new Error('summary queue unavailable'); } })),
    };
    await assert.rejects(sendMorningSummaries(failingQueue, NOW), /summary queue unavailable/);
    assert.equal(await watermark(f.reader.id), INITIAL_CLAIM);
    assert.equal((await summaries(f.reader.id)).length, 0);
    assert.equal(f.jobs.length, 0);
    assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 1, empty: 0 });
    assert.equal((await delivered(f)).title, '2 things wait in your inbox');
  });

  test('concurrent midnight ticks claim once and timezone or schedule changes never rewind the watermark', async (t) => {
    const f = await fixture(t);
    await enable(f);
    const stale = await f.uow.candidates();
    const sameScan: SummaryUnitOfWork = { ...f.uow, candidates: async () => stale };
    const results = await Promise.all([sendMorningSummaries(sameScan, NOW), sendMorningSummaries(sameScan, NOW), sendMorningSummaries(sameScan, NOW)]);
    assert.equal(results.reduce((total, result) => total + result.sent, 0), 1);
    assert.equal(await watermark(f.reader.id), '2034-06-11');
    assert.equal((await summaries(f.reader.id)).length, 1);
    assert.equal(f.jobs.length, 1);
    // A new 00:01 schedule is now due on June 12. It may advance the day, but subsequent
    // timezone and schedule edits cannot claim June 11 again or redeliver June 12.
    await preferences(f.reader, { morningSummary: { at: '00:01' } });
    assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 1, empty: 0 });
    assert.equal(await watermark(f.reader.id), '2034-06-12');
    await preferences(f.reader, { morningSummary: { at: '14:00' }, quietHours: { timeZone: 'Pacific/Honolulu' } });
    assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 0, empty: 0 });
    assert.equal(await watermark(f.reader.id), '2034-06-12');
    await preferences(f.reader, { morningSummary: { at: '00:01' }, quietHours: { timeZone: 'UTC' } });
    assert.deepEqual(await sendMorningSummaries(f.uow, NOW), { sent: 0, empty: 0 });
    assert.equal((await summaries(f.reader.id)).length, 2);
    assert.equal(f.jobs.length, 2);
    assert.deepEqual(await sendMorningSummaries(f.uow, new Date('2034-06-13T00:05:00Z')), { sent: 1, empty: 0 });
    assert.equal(await watermark(f.reader.id), '2034-06-13');
    assert.equal((await summaries(f.reader.id)).length, 3);
    assert.equal(f.jobs.length, 3);
    assert.equal(new Set(f.jobs.map((job) => job.notificationId)).size, 3);
    assert.equal((await recordedPushes(f.subscription.mockId)).length, 0, 'all three committed jobs remain held for this test');
  });
});
