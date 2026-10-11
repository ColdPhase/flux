import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PgBoss } from 'pg-boss';
import { COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB } from '@flux/core';
import { createDatabase } from '@flux/db';
import type { BackgroundComputeUsage, ProactiveComparisonRule, WorkResult } from '@flux/contracts';
import type { SwitchState } from './background-comparisons-switch.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { signIn } from './support/http.js';
import { expectStatus, password } from './support/people.js';
import type { RecordedProviderRequest } from './support/provider-mock.js';

// Live cancellation and crash reconciliation of a paid background comparison in the running app
// (#58), after the switched-on journey `e2e/background-comparisons.e2e.ts` with the API and worker
// on. scripts/check_application.sh runs:
//   cancel       the provider mock never answers; the owner pauses the rule in flight; the request is
//                aborted, the possible charge stays counted as unknown, nothing is published or retried.
//   crash-start  the same hanging request, then check_application.sh kills the worker container.
//   crash-verify the worker is restarted; its own recovery job (sent by hand, the stale cutoff
//                aged by SQL instead of a 20-minute wait) settles the interrupted reservation as
//                unknown, keeping the possible charge, and nothing is dispatched twice.
// The provider is the Compose `providermock`, never a real provider: this proves Flux's behavior
// against a fake that hangs, not a provider's, nor any billing.

const stateFile = join(process.env.FLUX_TEST_STATE_DIR ?? '/state', 'background-comparisons.json');
const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const phase = process.argv[2];
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);

const load = async () => JSON.parse(await readFile(stateFile, 'utf8')) as SwitchState;
const save = (state: SwitchState) => writeFile(stateFile, JSON.stringify(state));
async function mockRequests() {
  return ((await (await fetch(`${MOCK}/__requests`)).json()) as { requests: RecordedProviderRequest[] }).requests;
}
const script = (body: unknown) => fetch(`${MOCK}/__script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
const outbox = async (id: string) => (await pool.query(
  'SELECT status, failure_code, reserved_cents, dispatch_started_at, proposal_id, insufficient_outcome_id FROM proactive_comparison_outbox WHERE id=$1', [id])).rows[0];
const nothingPublished = (row: { proposal_id: string | null; insufficient_outcome_id: string | null }) =>
  assert.deepEqual([row.proposal_id, row.insufficient_outcome_id], [null, null], 'nothing is published');

/** A contributor's negative result, made ready at once, and the provider mock hanging on it. */
async function hangingRun(state: SwitchState, title: string) {
  const peer = (await signIn(state.peerEmail, password)).browser;
  const hangsFrom = (await mockRequests()).length;
  await script({ wire: 'openai', mode: 'hang' });
  const result = expectStatus(await peer.request('POST', `/api/v1/projects/${state.projectId}/results`, { body: {
    title, finding: 'negative', evidence: 'Camera A recognized 36% of gestures at 5 lux; target was 90%.',
    sources: [{ type: 'material', id: state.materialId, version: 1 }] } }), 201) as WorkResult;
  const candidateId = (await pool.query<{ id: string }>('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0]!.id;
  await comparisonDispatchFixtureDue(pool, candidateId);
  await pool.query('DELETE FROM proactive_comparison_project_changes WHERE project_id=$1', [state.projectId]);
  // The worker's own scheduled tick reserves it and sends the request, which the mock never answers.
  const open = await until('the hanging provider request', async () => {
    const row = await outbox(candidateId);
    const sent = (await mockRequests()).slice(hangsFrom);
    return row.status === 'reserved' && row.dispatch_started_at && sent.length === 1 ? { row, request: sent[0]! } : null;
  }, 4 * 60_000, 1_000);
  assert.equal(open.request.aborted, false, 'the provider request is still open');
  assert.equal(open.row.reserved_cents, 13);
  return { candidateId, hangsFrom };
}

async function ruleRow(ruleId: string) {
  return (await pool.query<{ status: string; version: number }>('SELECT status, version FROM proactive_comparison_rules WHERE id=$1', [ruleId])).rows[0]!;
}
async function ensureEnabled(state: SwitchState) {
  const owner = (await signIn(state.ownerEmail, password)).browser;
  const rule = await ruleRow(state.ruleId);
  if (rule.status === 'enabled') return owner;
  const enabled = expectStatus(await owner.request('PATCH', `/api/v1/proactive-comparison-rules/${state.ruleId}`,
    { body: { expectedVersion: rule.version, status: 'enabled' } }), 200) as ProactiveComparisonRule;
  assert.equal(enabled.status, 'enabled');
  return owner;
}
/** One tick sent by hand; returns whether the running worker worked it in time. */
async function tickWorked(timeoutMs = 90_000) {
  const boss = new PgBoss({ connectionString, migrate: false });
  boss.on('error', (error) => console.error(error));
  await boss.start();
  const job = await boss.send(COMPARISON_TICK_JOB, {});
  await boss.stop();
  // No id: the queue already holds a waiting tick (a killed worker's job blocks the queue until pg-boss expires it).
  if (!job) { await new Promise((resolve) => setTimeout(resolve, timeoutMs)); return false; }
  return Boolean(await until('a comparison tick to be worked', async () => (await pool.query(
    "SELECT 1 FROM pgboss.job WHERE id=$1 AND state='completed'", [job])).rowCount, timeoutMs, 1_000).catch(() => false));
}

try {
  const state = await load();
  assert.ok(state.paidResultId, 'the switched-on journey ran first');
  if (phase === 'cancel') {
    const owner = await ensureEnabled(state);
    const { candidateId, hangsFrom } = await hangingRun(state, 'Fourth low-light trial missed the target');
    const rule = await ruleRow(state.ruleId);
    expectStatus(await owner.request('PATCH', `/api/v1/proactive-comparison-rules/${state.ruleId}`,
      { body: { expectedVersion: rule.version, status: 'paused' } }), 200);

    // The pause reaches the open request within seconds: aborted at the provider, possible charge kept.
    const stopped = await until('the in-flight comparison to be cancelled', async () => {
      const row = await outbox(candidateId);
      return row.status === 'unknown' ? row : null;
    }, 30_000);
    assert.equal(stopped.failure_code, 'AUTHORIZATION_CHANGED');
    assert.equal(stopped.reserved_cents, 13, 'a request that may have been charged stays counted');
    nothingPublished(stopped);
    assert.equal((await mockRequests())[hangsFrom]!.aborted, true, 'the provider saw the connection close');
    const usage = expectStatus(await owner.request('GET', '/api/v1/background-compute-usage'), 200) as BackgroundComputeUsage;
    const summary = usage.candidates.find((candidate) => candidate.id === candidateId);
    assert.deepEqual([summary?.status, summary?.reservedCents], ['unknown', 13]);
    assert.ok(usage.unknownPossibleCents >= 13);

    // A later tick never retries it, and the paused rule makes nothing new.
    await script({});
    assert.equal(await tickWorked(), true, 'the worker works ticks while the rule is paused');
    assert.equal((await mockRequests()).length, hangsFrom + 1, 'no retry after cancellation');
    assert.deepEqual(await outbox(candidateId), stopped);
    await ensureEnabled(state);
    await save({ ...state, liveRequests: 1 });
    console.log('background-comparisons-live: pausing in flight aborted the request, kept 13 cents counted as unknown and published nothing');
  } else if (phase === 'crash-start') {
    await ensureEnabled(state);
    const { candidateId } = await hangingRun(state, 'Fifth low-light trial missed the target');
    await save({ ...state, crashCandidateId: candidateId, liveRequests: 2 });
    console.log('background-comparisons-live: a paid request is open; the worker is about to be killed');
  } else if (phase === 'crash-verify') {
    const candidateId = state.crashCandidateId;
    assert.ok(candidateId, 'crash-start ran first');
    const owner = (await signIn(state.ownerEmail, password)).browser;
    // The killed worker never finished: still reserved, intent persisted, the connection to the mock dropped.
    const killed = await outbox(candidateId);
    assert.deepEqual([killed.status, killed.reserved_cents], ['reserved', 13]);
    assert.ok(killed.dispatch_started_at);
    nothingPublished(killed);
    const requests = await mockRequests();
    assert.equal(requests.length, 3);
    await until('the provider to see the dead worker disconnect', async () => (await mockRequests())[2]!.aborted, 30_000);

    // The restarted worker's recovery job, with the stale cutoff (20 minutes) reached by SQL.
    await pool.query("UPDATE proactive_comparison_outbox SET updated_at=now()-interval '21 minutes' WHERE id=$1", [candidateId]);
    const boss = new PgBoss({ connectionString, migrate: false });
    boss.on('error', (error) => console.error(error));
    await boss.start();
    const job = await boss.send(COMPARISON_RECOVERY_JOB, {});
    await boss.stop();
    const settled = await until('the restarted worker to reconcile the reservation', async () => {
      const row = await outbox(candidateId);
      return row.status === 'reserved' ? null : row;
    }, 90_000, 1_000);
    assert.equal((await pool.query('SELECT state FROM pgboss.job WHERE id=$1', [job])).rows[0]?.state, 'completed');
    assert.deepEqual([settled.status, settled.failure_code, settled.reserved_cents],
      ['unknown', 'WORKER_INTERRUPTED_AFTER_DISPATCH_INTENT', 13], 'a sent request is only possible spending: kept counted, never released');
    nothingPublished(settled);
    const usage = expectStatus(await owner.request('GET', '/api/v1/background-compute-usage'), 200) as BackgroundComputeUsage;
    const summary = usage.candidates.find((candidate) => candidate.id === candidateId);
    assert.deepEqual([summary?.status, summary?.reservedCents], ['unknown', 13]);
    assert.ok(usage.conservativeCountedCents >= 26, 'the cancelled and the interrupted request both stay counted');

    // The restarted worker neither resumes nor repeats it.
    // A killed worker's active tick job must not hold the singleton tick queue: its heartbeat lapses,
    // pg-boss fails it, and the restarted worker's scheduled ticks run again within a bounded time.
    await script({});
    const restartedAt = new Date();
    const ran = await until('a scheduled tick to run after the restart', async () => (await pool.query(
      "SELECT 1 FROM pgboss.job WHERE name=$1 AND state='completed' AND started_on > $2", [COMPARISON_TICK_JOB, restartedAt])).rowCount, 180_000, 2_000);
    assert.ok(ran);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND state='active'", [COMPARISON_TICK_JOB])).rows[0].n <= 1, true, 'never two ticks at once');
    console.log(`background-comparisons-live: a scheduled tick ran ${Math.round((Date.now() - restartedAt.getTime()) / 1000)} s after crash-verify started`);
    assert.equal((await mockRequests()).length, 3, 'no second request after the crash');
    assert.deepEqual(await outbox(candidateId), settled);
    console.log('background-comparisons-live: the restarted worker reconciled the interrupted request as unknown, 13 cents kept, no retry');
  } else {
    throw new Error('Usage: background-comparisons-live.ts cancel|crash-start|crash-verify');
  }
} finally {
  await pool.end();
}
