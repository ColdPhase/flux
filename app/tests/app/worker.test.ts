import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import type { DraftSummary } from '@flux/contracts';
import { createDatabase, draftResultRepository, eventRepository, schema } from '@flux/db';
import {
  addMember,
  createDraft,
  createProject,
  createWorkspace,
  DRAFT_SUMMARY_JOB,
  grantProject,
  NotFoundError,
  processDraftSummary,
  removeMember,
  requestDraftSummary,
  revokeProjectGrant,
  shareDraft,
  type Database,
  type Principal,
} from '@flux/core';
import { pgBossQueue } from '../../apps/server/src/push/adapters.js';
import { barrier, backendPid, settled, waitUntilBlockedBy } from './support/locks.js';
import { draft, expectStatus, person } from './support/people.js';

// Worker read/commit authorization for draft.summarize.v1 (issue #29, AC-3).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
const boss = new PgBoss({ connectionString, migrate: false });
before(() => boss.start().then(() => undefined));
after(async () => { await boss.stop(); await pool.end(); });

/**
 * Enqueues through the real transactional path but delays the job for an hour, so the
 * Compose worker does not claim it and the test can run the handler with a barrier.
 */
const summaryPorts = { results: draftResultRepository, events: eventRepository };
const delayed = { ...summaryPorts, queue: pgBossQueue({ send: (name: string, data: object, options: object) =>
  boss.send(name, data, { ...options, startAfter: 3600 }) } as unknown as Pick<PgBoss, 'send'>) };

async function human(label: string): Promise<Principal> {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id}@example.test` });
  return { id, kind: 'human' };
}

async function row(resultId: string) {
  const [result] = await db.select().from(schema.draftResults).where(eq(schema.draftResults.id, resultId));
  return result!;
}

async function completionEvents(draftId: string) {
  const rows = await pool.query("SELECT kind FROM events WHERE object_id = $1 AND kind LIKE 'draft.summary_%' ORDER BY seq", [draftId]);
  return rows.rows.map((r: { kind: string }) => r.kind);
}

describe('draft.summarize.v1 worker', () => {
  test('the Compose worker commits a result for an authorized requester', async () => {
    const author = await person('worker-author');
    const ws = expectStatus(await author.browser.request('POST', '/api/v1/workspaces', { body: { name: 'Worker' } }), 201) as { id: string };
    const item = await draft(author, ws.id, 'Counted', { body: 'one two  three\nfour' });
    const queued = expectStatus(await author.browser.request('POST', `/api/v1/drafts/${item.id}/summaries`), 202) as DraftSummary;
    assert.equal(queued.status, 'queued');
    const job = await pool.query('SELECT name, data FROM pgboss.job WHERE data->>\'resultId\' = $1', [queued.id]);
    assert.equal(job.rows[0]?.name, DRAFT_SUMMARY_JOB, 'job committed with the result row');
    assert.deepEqual(Object.keys(job.rows[0].data), ['resultId'], 'payload carries a reference only');
    const deadline = Date.now() + 30_000;
    let current = queued;
    while (current.status !== 'completed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = expectStatus(await author.browser.request('GET', `/api/v1/drafts/${item.id}/summaries/${queued.id}`), 200) as DraftSummary;
    }
    assert.equal(current.status, 'completed', 'worker completed the job');
    assert.equal(current.wordCount, 4);
    assert.equal(current.draftVersion, 1);
    const listed = expectStatus(await author.browser.request('GET', `/api/v1/drafts/${item.id}/summaries`), 200) as DraftSummary[];
    assert.deepEqual(listed.map((s) => s.id), [queued.id]);
    const outsider = await person('worker-outsider');
    expectStatus(await outsider.browser.request('GET', `/api/v1/drafts/${item.id}/summaries/${queued.id}`), 404, 'result follows draft visibility');
    expectStatus(await outsider.browser.request('POST', `/api/v1/drafts/${item.id}/summaries`), 404, 'cannot summarize an invisible draft');
  });

  async function scenario(label: string) {
    const owner = await human(`${label}-owner`);
    const member = await human(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db);
    const created = await createDraft(owner, ws.id, { title: 'Shared', body: 'alpha beta gamma' }, db);
    const item = await shareDraft(owner, created.id, { scope: 'workspace', expectedVersion: created.version }, db);
    const summary = await requestDraftSummary(member, item.id, db, delayed);
    return { owner, member, ws, item, summary };
  }

  test('a requester who lost access before the job ran gets no read and no result', async () => {
    const { owner, member, ws, item, summary } = await scenario('before-read');
    await removeMember(owner, ws.id, member.id, db);
    let read = false;
    const outcome = await processDraftSummary(summary.id, db, summaryPorts, { afterRead: async () => { read = true; } });
    assert.equal(outcome, 'denied');
    assert.equal(read, false, 'inputs were not read');
    const stored = await row(summary.id);
    assert.equal(stored.status, 'denied');
    assert.equal(stored.deniedAtStage, 'before_read');
    assert.equal(stored.wordCount, null);
    assert.deepEqual(await completionEvents(item.id), ['draft.summary_requested.v1', 'draft.summary_denied.v1']);
  });

  test('revocation between read and commit prevents the commit (race)', async () => {
    const { owner, member, ws, item, summary } = await scenario('race');
    let read = false;
    const outcome = await processDraftSummary(summary.id, db, summaryPorts, {
      afterRead: async () => {
        read = true;
        await removeMember(owner, ws.id, member.id, db);
      },
    });
    assert.equal(read, true, 'the input was read while access was valid');
    assert.equal(outcome, 'denied');
    const stored = await row(summary.id);
    assert.equal(stored.status, 'denied');
    assert.equal(stored.deniedAtStage, 'before_commit');
    assert.equal(stored.wordCount, null, 'the computed result was not committed');
    assert.deepEqual(await completionEvents(item.id), ['draft.summary_requested.v1', 'draft.summary_denied.v1']);
  });

  test('a draft made private between read and commit also prevents the commit', async () => {
    const { owner, item, summary } = await scenario('reshare');
    const outcome = await processDraftSummary(summary.id, db, summaryPorts, {
      afterRead: async () => { await shareDraft(owner, item.id, { scope: 'private', expectedVersion: item.version }, db); },
    });
    assert.equal(outcome, 'denied');
    assert.equal((await row(summary.id)).deniedAtStage, 'before_commit');
  });

  test('an authorized run commits once and a redelivered job is skipped', async () => {
    const { item, summary } = await scenario('commit');
    assert.equal(await processDraftSummary(summary.id, db, summaryPorts), 'completed');
    const stored = await row(summary.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.wordCount, 3);
    assert.equal(stored.draftVersion, item.version);
    assert.equal(await processDraftSummary(summary.id, db, summaryPorts), 'skipped');
    assert.deepEqual(await completionEvents(item.id), ['draft.summary_requested.v1', 'draft.summary_completed.v1']);
  });

  /** A member reads a restricted-project draft only through an explicit viewer grant. */
  async function grantScenario(label: string) {
    const owner = await human(`${label}-owner`);
    const member = await human(`${label}-member`);
    const ws = await createWorkspace(owner, { name: label }, db);
    await addMember(owner, ws.id, { userId: member.id, role: 'member' }, db);
    const room = await createProject(owner, ws.id, { name: 'Room', visibility: 'restricted' }, db);
    const access = await grantProject(owner, room.id, { principal: { kind: 'human', id: member.id }, role: 'viewer' }, db);
    const created = await createDraft(owner, ws.id, { title: 'Room notes', body: 'one two three four five', projectId: room.id }, db);
    const item = await shareDraft(owner, created.id, { scope: 'project', expectedVersion: created.version }, db);
    const summary = await requestDraftSummary(member, item.id, db, delayed);
    return { owner, room, access, item, summary };
  }

  test('a grant revoke that starts during the commit waits and the result commits under the checked grant', async () => {
    const { owner, room, access, item, summary } = await grantScenario('grant-commit-first');
    const holding = barrier<number>();
    const gate = barrier();
    const outcome = processDraftSummary(summary.id, db, summaryPorts, {
      beforeCommit: async (tx) => { holding.resolve(await backendPid(tx)); await gate.promise; },
    });
    const worker = await holding.promise;
    const revoke = revokeProjectGrant(owner, room.id, access.id, db);
    const revokeDone = settled(revoke);
    await waitUntilBlockedBy(pool, worker);
    assert.equal(revokeDone(), false, 'the revoke waits for the worker commit');
    gate.resolve();
    assert.equal(await outcome, 'completed');
    await revoke;
    assert.equal((await row(summary.id)).wordCount, 5);
    assert.deepEqual(await completionEvents(item.id), ['draft.summary_requested.v1', 'draft.summary_completed.v1']);
  });

  test('a grant revoke committed between read and commit prevents the commit (two connections)', async () => {
    const { owner, room, access, item, summary } = await grantScenario('grant-revoke-first');
    const revoked = barrier<number>();
    const gate = barrier();
    let revocation: Promise<void> | null = null;
    const outcome = processDraftSummary(summary.id, db, summaryPorts, {
      afterRead: async () => {
        // The revoke runs on another connection and stays uncommitted while the worker commits.
        revocation = db.transaction(async (tx) => {
          await revokeProjectGrant(owner, room.id, access.id, tx as unknown as Database);
          revoked.resolve(await backendPid(tx));
          await gate.promise;
        });
        await revoked.promise;
      },
    });
    const revoker = await revoked.promise;
    await waitUntilBlockedBy(pool, revoker);
    const workerDone = settled(outcome);
    assert.equal(workerDone(), false, 'the worker commit waits for the uncommitted revoke');
    gate.resolve();
    await revocation;
    assert.equal(await outcome, 'denied');
    const stored = await row(summary.id);
    assert.equal(stored.status, 'denied');
    assert.equal(stored.deniedAtStage, 'before_commit');
    assert.equal(stored.wordCount, null, 'nothing was committed under the revoked grant');
    assert.deepEqual(await completionEvents(item.id), ['draft.summary_requested.v1', 'draft.summary_denied.v1']);
  });

  test('requesting needs read access to the draft', async () => {
    const { item } = await scenario('request');
    const stranger = await human('request-stranger');
    await assert.rejects(requestDraftSummary(stranger, item.id, db, delayed), NotFoundError);
  });
});
