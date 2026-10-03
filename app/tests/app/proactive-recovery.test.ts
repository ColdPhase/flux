import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase, proactiveOutboxRows, schema, sealBackgroundKey } from '@flux/db';
import { COMPARISON_RESERVATION_STALE_MS, type ComparisonProvider } from '@flux/core';
import type { BackgroundComputeUsage } from '@flux/contracts';
import { comparisonRecoveryTick } from '../../apps/worker/src/proactive-comparison/recovery.js';
import { comparisonSchedulingTick } from '../../apps/worker/src/proactive-comparison/scheduling.js';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { proactiveReservation } from '../../apps/worker/src/proactive-comparison/reservation-adapter.js';
import { expectStatus, person, project, workspace } from './support/people.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { db, pool } from './support/db.js';

const masterKey = readFileSync('/run/secrets/flux_background_key');
const now = new Date();
const old = new Date(now.getTime() - COMPARISON_RESERVATION_STALE_MS - 1_000);

async function fixture() {
  const owner = await person('recovery-owner');
  const ws = await workspace(owner, 'Interrupted comparison');
  const prj = await project(owner, ws.id, 'Human low-light result', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Comparison assistant', owner: 'self' } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/proactive-comparison-rules`,
    { body: { agentId: agent.id, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal', maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 5 } }), 201) as { id: string };
  const connect = async () => expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'recovery-only-fixture-'.repeat(4)}END8`, payerOrganization: 'Fixture payer', providerWorkspace: 'Fixture scope',
    workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true,
    projectDataDisclosureAcknowledged: true, maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
  } }), 201) as { id: string };
  const connection = await connect();
  // Controlled fixtures only. This does not enable the production worker/provider.
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const negative = async () => {
    const result = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/results`,
      { body: { title: 'Camera missed gestures', finding: 'negative', evidence: '38% detection at 5 lux.' } }), 201) as { id: string };
    const candidate = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0].id as string;
    await comparisonDispatchFixtureDue(pool, candidate);
    return { result, candidate };
  };
  const usage = () => owner.browser.request('GET', '/api/v1/background-compute-usage');
  return { owner, ws, prj, agent, rule, connection, connect, negative, usage };
}
async function row(id: string) { return (await pool.query('SELECT * FROM proactive_comparison_outbox WHERE id=$1', [id])).rows[0]; }
async function stale(id: string) { await pool.query('UPDATE proactive_comparison_outbox SET updated_at=$1 WHERE id=$2', [old, id]); }

test('persistent pre-intent recovery is zero cost, post-intent recovery retains uncertainty/history, and fresh rows stay reserved', async () => {
  const f = await fixture(); const before = await f.negative();
  assert.equal((await proactiveReservation(db).reserve(before.candidate)).status, 'reserved'); await stale(before.candidate);
  // A deliberate second pool: the recovery must work from a fresh process view, not the shared one.
  const restart = createDatabase(process.env.DATABASE_URL!);
  try { assert.deepEqual(await comparisonRecoveryTick(restart.db, now), { notRun: 1, unknown: 0 }); }
  finally { await restart.pool.end(); }
  const free = await row(before.candidate);
  assert.deepEqual([free.status, free.failure_code, free.reserved_cents, free.usage_input_tokens, free.usage_output_tokens, free.usage_estimated_cents],
    ['not_run', 'WORKER_INTERRUPTED_BEFORE_DISPATCH', 0, 0, 0, 0]);
  const after = await f.negative();
  assert.equal((await proactiveReservation(db).reserve(after.candidate)).status, 'reserved');
  await proactiveOutboxRows(db).markDispatchStarted(after.candidate);
  await pool.query('UPDATE proactive_comparison_outbox SET usage_input_tokens=100,usage_output_tokens=20,usage_estimated_cents=2 WHERE id=$1', [after.candidate]);
  await stale(after.candidate);
  assert.deepEqual(await comparisonRecoveryTick(db, now), { notRun: 0, unknown: 1 });
  const uncertain = await row(after.candidate);
  assert.deepEqual([uncertain.status, uncertain.failure_code, uncertain.reserved_cents, uncertain.usage_input_tokens, uncertain.usage_output_tokens, uncertain.usage_estimated_cents],
    ['unknown', 'WORKER_INTERRUPTED_AFTER_DISPATCH_INTENT', 5, 100, 20, 2]);
  assert.equal(uncertain.connection_id, f.connection.id);
  const fresh = await f.negative();
  assert.equal((await proactiveReservation(db).reserve(fresh.candidate)).status, 'reserved');
  assert.deepEqual(await comparisonRecoveryTick(db, now), { notRun: 0, unknown: 0 });
  assert.equal((await row(fresh.candidate)).status, 'reserved');
  await f.connect();
  const usage = expectStatus(await f.usage(), 200) as BackgroundComputeUsage;
  assert.equal(usage.conservativeCountedCents, 10);
  assert.ok(usage.candidates.some((candidate) => candidate.status === 'unknown' && candidate.reservedCents === 5));
  assert.deepEqual(await row(after.candidate), uncertain, 'replacement cannot rewrite the recovered charge history');
});

test('recovery skips active row locks, serializes replicas, pages beyond 100 and is idempotent', async () => {
  const f = await fixture(); const first = await f.negative();
  assert.equal((await proactiveReservation(db).reserve(first.candidate)).status, 'reserved'); await stale(first.candidate);
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT id FROM proactive_comparison_outbox WHERE id=$1 FOR UPDATE', [first.candidate]);
    assert.deepEqual(await comparisonRecoveryTick(db, now), { notRun: 0, unknown: 0 });
    await client.query('COMMIT');
  } finally { client.release(); }
  // Historical metadata fixtures preserve one reserved row per owner. They are
  // valid owner/agent/connection identities, not evidence of 122 provider calls.
  const [user] = await db.select().from(schema.authUsers).where(eq(schema.authUsers.id, f.owner.id));
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  const [rule] = await db.select().from(schema.proactiveComparisonRules).where(eq(schema.proactiveComparisonRules.id, f.rule.id));
  const [connection] = await db.select().from(schema.backgroundComputeConnections).where(eq(schema.backgroundComputeConnections.id, f.connection.id));
  const ids = [first.candidate];
  await db.transaction(async (tx) => {
    for (let index = 0; index < 122; index++) {
      const ownerId = randomUUID(); const agentId = randomUUID(); const ruleId = randomUUID(); const connectionId = randomUUID(); const id = randomUUID(); ids.push(id);
      await tx.insert(schema.authUsers).values({ ...user!, id: ownerId, email: `recovery-${ownerId}@example.test` });
      await tx.insert(schema.agents).values({ ...agent!, id: agentId, ownerUserId: ownerId });
      await tx.insert(schema.proactiveComparisonRules).values({ ...rule!, id: ruleId, agentId, ownerUserId: ownerId });
      await tx.insert(schema.backgroundComputeConnections).values({ ...connection!, id: connectionId, ownerUserId: ownerId,
        encryptedKey: sealBackgroundKey('a known local fixture only', ownerId, connectionId, masterKey) });
      await tx.insert(schema.proactiveComparisonOutbox).values({ id, ruleId, ownerUserId: ownerId, projectId: f.prj.id, resultId: first.result.id,
        sourceFingerprint: 'a'.repeat(64), status: 'reserved', connectionId, reservedCents: 5, reservedAt: now, updatedAt: old,
        dispatchStartedAt: index % 2 ? old : null });
    }
  });
  const both = await Promise.all([comparisonRecoveryTick(db, now), comparisonRecoveryTick(db, now)]);
  assert.equal(both.reduce((sum, result) => sum + result.notRun, 0), 62);
  assert.equal(both.reduce((sum, result) => sum + result.unknown, 0), 61);
  const rows = (await pool.query('SELECT status,failure_code FROM proactive_comparison_outbox WHERE id=ANY($1::uuid[])', [ids])).rows;
  assert.equal(rows.length, 123); assert.ok(rows.every((candidate) => candidate.status === 'not_run' || candidate.status === 'unknown'));
  assert.deepEqual(await comparisonRecoveryTick(db, now), { notRun: 0, unknown: 0 });
});

test('a recovered fingerprint is not scheduled again and an old process cannot publish or release its terminal history', async () => {
  for (const stage of ['count', 'message'] as const) {
    const f = await fixture(); const candidate = await f.negative();
    let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    let paid = 0;
    const provider: ComparisonProvider = {
      async countInputTokens() { if (stage === 'count') { enter(); await pending; } return 100; },
      async createMessage({ sources }) { paid++; if (stage === 'message') { enter(); await pending; }
        return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 }, answer: { kind: 'comparison', fact: 'The camera missed gestures.',
          interpretation: 'Its exposure may be too short.', suggestedAction: 'Run a matching sensor trial.',
          citations: sources.map((source) => ({ type: source.type, id: source.id, version: source.version })) } }; },
    };
    const dispatch = dispatchProactiveComparison({ db, candidateId: candidate.candidate, masterKey, provider });
    await entered; await stale(candidate.candidate);
    assert.deepEqual(await comparisonRecoveryTick(db, now), stage === 'count' ? { notRun: 1, unknown: 0 } : { notRun: 0, unknown: 1 });
    const recovered = await row(candidate.candidate);
    release(); await dispatch;
    assert.deepEqual(await row(candidate.candidate), recovered, 'late dispatch cannot overwrite recovery');
    assert.equal(paid, stage === 'count' ? 0 : 1);
    assert.equal((await pool.query('SELECT id FROM proactive_comparison_proposals WHERE outbox_id=$1', [candidate.candidate])).rowCount, 0);
    assert.equal((await pool.query('SELECT id FROM proactive_comparison_insufficient_outcomes WHERE outbox_id=$1', [candidate.candidate])).rowCount, 0);
    const countBefore = (await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE rule_id=$1', [f.rule.id])).rows[0].n;
    await comparisonSchedulingTick(db, now);
    await comparisonSchedulingTick(db, new Date(now.getTime() + 2 * 60_000));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE rule_id=$1', [f.rule.id])).rows[0].n, countBefore);
    assert.deepEqual(await row(candidate.candidate), recovered);
  }
});
