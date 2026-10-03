import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { comparisonSchedulingRows, createDatabase, proactiveOutboxRows } from '@flux/db';
import { collectComparisonSourceChanges, COMPARISON_QUIET_WINDOW_MS, reconsiderComparisonSources, recordEvent } from '@flux/core';
import { comparisonScheduling } from '../../apps/worker/src/proactive-comparison/scheduling-adapter.js';
import { comparisonSchedulingTick } from '../../apps/worker/src/proactive-comparison/scheduling.js';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { proactiveReservation } from '../../apps/worker/src/proactive-comparison/reservation-adapter.js';
import { proactiveComparisonOutcomePath } from '@flux/contracts';
import { expectStatus, person, project, workspace } from './support/people.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { eventPorts } from '../../apps/server/src/events.js';
import { db, pool } from './support/db.js';

const start = new Date('2030-01-01T00:00:00Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
const unit = comparisonScheduling(db);
async function collect(now: Date) {
  let count = 0;
  for (;;) { const result = await collectComparisonSourceChanges(unit, now); count += result.processed; if (result.processed < 100) return count; }
}
async function fixture() {
  const owner = await person('scheduling-owner');
  const ws = await workspace(owner, 'Durable comparison scheduling');
  const prj = await project(owner, ws.id, 'Human low-light evidence', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string };
  const grant = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201) as { id: string };
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/proactive-comparison-rules`,
    { body: { agentId: agent.id, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
      maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 5 } }), 201) as { id: string };
  // Controlled scheduler only; no production enable endpoint or provider registration.
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  await collect(start);
  const material = async () => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Human camera measurement', body: '38% detected at 5 lux.' } }), 201) as { materialId: string };
  const negative = async (sources: Array<{ type: 'material'; id: string; version: number }> = []) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/results`,
    { body: { title: 'Camera missed the target', finding: 'negative', evidence: 'Target was 90%.', sources } }), 201) as { id: string };
  const candidates = async () => (await pool.query('SELECT * FROM proactive_comparison_outbox WHERE rule_id=$1 ORDER BY created_at,id', [rule.id])).rows;
  const window = async () => (await pool.query('SELECT * FROM proactive_comparison_project_changes WHERE project_id=$1', [prj.id])).rows[0];
  const connect = async () => expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'scheduling-fixture-'.repeat(4)}END8`, payerOrganization: 'Fixture payer', providerWorkspace: 'Fixture scope',
    workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true,
    projectDataDisclosureAcknowledged: true, maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
  } }), 201);
  return { owner, ws, prj, agent, grant, rule, material, negative, candidates, window, connect };
}

test('a committed result is not a grant to bypass quiet time; collection sees no uncommitted event', async () => {
  const f = await fixture(); const material = await f.material(); await collect(start);
  await reconsiderComparisonSources(unit, at(2));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO events(id,kind,object_id,actor_id,workspace_id,data)
      VALUES ($1,'project.material_updated.v1',$2,$3,$4,$5)`,
    [randomUUID(), f.prj.id, `human:${f.owner.id}`, f.ws.id, { materialId: material.materialId, version: 1 }]);
    await collect(at(3)); assert.equal(await f.window(), undefined);
    await client.query('COMMIT');
    await collect(at(3)); assert.equal((await f.window()).due_at.toISOString(), at(5).toISOString());
  } finally { await client.query('ROLLBACK'); client.release(); }
  const requestStart = Date.now(); await f.negative();
  const candidate = (await f.candidates())[0]!;
  assert.ok(candidate.available_after.getTime() >= requestStart + COMPARISON_QUIET_WINDOW_MS - 50);
  let providerCalls = 0;
  const outcome = await dispatchProactiveComparison({ db, candidateId: candidate.id, masterKey: Buffer.alloc(32), provider: {
    async countInputTokens() { providerCalls++; return 100; }, async createMessage() { providerCalls++; throw new Error('Must not be reached'); },
  } });
  assert.deepEqual(outcome, { status: 'blocked', reason: 'QUIET_WINDOW' });
  assert.equal(providerCalls, 0);
  const saved = (await f.candidates())[0]!;
  assert.equal(saved.status, 'queued'); assert.equal(saved.reserved_cents, 0); assert.equal(saved.inspected_sources, null);
});

test('a human edit burst selects only the latest fingerprint and stops obsolete queued rows at zero cost', async () => {
  const f = await fixture(); const material = await f.material(); await f.negative();
  await collect(start); assert.equal((await f.window()).due_at.toISOString(), at(2).toISOString());
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Corrected: 42% detected.' } }), 200);
  await collect(at(1)); assert.equal((await f.window()).due_at.toISOString(), at(3).toISOString());
  const ownIds = new Set((await f.candidates()).map((row) => row.id));
  assert.equal((await comparisonSchedulingTick(db, at(2))).readyIds.filter((id) => ownIds.has(id)).length, 0);
  await comparisonSchedulingTick(db, at(3));
  const rows = await f.candidates(); assert.equal(rows.length, 2);
  const stopped = rows.find((row) => row.status === 'not_run')!; const latest = rows.find((row) => row.status === 'queued')!;
  assert.equal(stopped.failure_code, 'SOURCE_CHANGED'); assert.equal(stopped.usage_estimated_cents, 0);
  assert.equal(stopped.reserved_at, null); assert.equal(stopped.dispatch_started_at, null);
  const snapshot = await proactiveOutboxRows(db).sourceSnapshot(latest.result_id, f.rule.id);
  assert.equal(latest.source_fingerprint, snapshot.fingerprint);
  assert.ok(snapshot.sources.some((source) => source.id === material.materialId && source.version === 2));
  assert.ok(await comparisonSchedulingRows(db).ready(latest.id, at(3)));
  await comparisonSchedulingTick(db, at(4)); assert.equal((await f.candidates()).length, 2, 'unchanged sources never duplicate');
});

test('continuous edits are reconsidered at fifteen minutes from the first change', async () => {
  const f = await fixture(); const material = await f.material(); await f.negative(); await collect(start);
  for (let minute = 1; minute <= 14; minute++) {
    expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: minute, body: `Human measurement ${minute}.` } }), 200);
    await collect(at(minute));
  }
  assert.equal((await f.window()).due_at.toISOString(), at(15).toISOString());
  assert.equal((await f.window()).first_changed_at.toISOString(), start.toISOString());
  await comparisonSchedulingTick(db, at(15));
  assert.equal(await f.window(), undefined);
  assert.equal((await f.candidates()).filter((row) => row.status === 'queued').length, 1);
});

test('an explicit published v1 stays pinned beside current v2; a mid-count v3 edit ends the candidate before any paid call', async () => {
  for (const mode of ['complete', 'edit_during_count'] as const) {
    const f = await fixture(); await f.connect(); const material = await f.material();
    await f.negative([{ type: 'material', id: material.materialId, version: 1 }]);
    expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Human corrected the reading to 42%.' } }), 200);
    await collect(start); await comparisonSchedulingTick(db, at(2));
    const candidate = (await f.candidates()).find((row) => row.status === 'queued')!;
    assert.ok(candidate);
    const snapshot = await proactiveOutboxRows(db).sourceSnapshot(candidate.result_id, f.rule.id);
    assert.deepEqual(snapshot.sources.filter((source) => source.id === material.materialId).map((source) => source.version).sort(), [1, 2]);
    assert.ok(await proactiveOutboxRows(db).sourceCurrent(f.prj.id, { type: 'material', id: material.materialId, version: 1 }));
    // Advance only this controlled dispatch fixture; scheduling itself was exercised with the fake clock above.
    await comparisonDispatchFixtureDue(pool, candidate.id);
    let paid = 0;
    const outcome = await dispatchProactiveComparison({ db, candidateId: candidate.id,
      masterKey: readFileSync('/run/secrets/flux_background_key'), provider: {
        async countInputTokens(input) {
          const versions = input.sources.filter((source) => source.id === material.materialId);
          assert.deepEqual(versions.map((source) => source.version).sort(), [1, 2]);
          assert.match(versions.find((source) => source.version === 1)!.text, /38%/);
          assert.match(versions.find((source) => source.version === 2)!.text, /42%/);
          if (mode === 'edit_during_count') expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
            { body: { clientMutationId: randomUUID(), expectedVersion: 2, body: 'Human v3 corrects the measurement again.' } }), 200);
          return 100;
        },
        async createMessage() { paid++; return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 },
          answer: { kind: 'insufficient_evidence', reason: 'The corrected camera trial lacks a matching sensor trial.' } }; },
      } });
    const saved = (await f.candidates()).find((row) => row.id === candidate.id)!;
    if (mode === 'complete') {
      assert.equal(outcome.status, 'insufficient_evidence'); assert.equal(paid, 1);
      assert.deepEqual(saved.inspected_sources.filter((source: { id: string }) => source.id === material.materialId)
        .map((source: { version: number }) => source.version).sort(), [1, 2]);
    } else {
      assert.deepEqual(outcome, { status: 'not_run', reason: 'SOURCE_CHANGED' }); assert.equal(paid, 0);
      assert.equal(saved.usage_estimated_cents, 0); assert.equal(saved.reserved_at, null); assert.equal(saved.dispatch_started_at, null);
    }
  }
});

test('unpublishing or deleting a cited historical version refuses at zero cost without silently dropping it', async () => {
  for (const change of ['unpublish', 'delete'] as const) {
    const f = await fixture(); await f.connect();
    const doc = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.prj.id}/docs`,
      { body: { title: 'Published human trial', body: '38% detected at 5 lux.', state: 'published' } }), 201) as { id: string };
    await f.negative([{ type: 'material', id: doc.id, version: 1 }]);
    await collect(start); await comparisonSchedulingTick(db, at(2));
    const candidate = (await f.candidates()).find((row) => row.status === 'queued')!;
    await comparisonDispatchFixtureDue(pool, candidate.id);
    if (change === 'unpublish') expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${doc.id}`,
      { body: { state: 'draft' }, headers: { 'If-Match': '"1"' } }), 200);
    else await pool.query('DELETE FROM project_materials WHERE id=$1', [doc.id]); // controlled deletion in persistence
    let calls = 0;
    assert.deepEqual(await dispatchProactiveComparison({ db, candidateId: candidate.id,
      masterKey: readFileSync('/run/secrets/flux_background_key'), provider: {
        async countInputTokens() { calls++; return 100; }, async createMessage() { calls++; throw new Error('Must not be reached'); },
      } }), { status: 'not_run', reason: 'SOURCE_CHANGED' });
    assert.equal(calls, 0);
    const saved = (await f.candidates()).find((row) => row.id === candidate.id)!;
    assert.equal(saved.usage_estimated_cents, 0); assert.equal(saved.inspected_sources, null);
  }
});

test('draft save/edit, private sketches, layout and agent events do not dirty project evidence', async () => {
  const f = await fixture();
  const doc = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.prj.id}/docs`,
    { body: { title: 'Unpublished experiment', body: 'Work in progress.' } }), 201) as { id: string };
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${doc.id}`,
    { body: { body: 'Still a draft.' }, headers: { 'If-Match': '"1"' } }), 200);
  const sketch = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Private thought', scope: 'private' } }), 201) as { id: string };
  expectStatus(await f.owner.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Private evidence is excluded.', x: 0, y: 0 } }), 201);
  await db.transaction((tx) => recordEvent(eventPorts(tx), { kind: 'agent', id: f.agent.id }, f.ws.id,
    'project.material_updated.v1', f.prj.id, { materialId: doc.id, version: 1 }));
  await db.transaction((tx) => recordEvent(eventPorts(tx), { kind: 'human', id: f.owner.id }, f.ws.id,
    'sketch.changed.v1', sketch.id, { op: 'thoughts_moved', thoughtIds: [], linkIds: [] }));
  await collect(start); assert.equal(await f.window(), undefined);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/docs/${doc.id}`,
    { body: { state: 'published' }, headers: { 'If-Match': '"2"' } }), 200);
  await collect(at(1)); assert.equal((await f.window()).due_at.toISOString(), at(3).toISOString(), 'publishing admits the new version');
});

test('paused or revoked-access rules are excluded before metadata selection', async () => {
  for (const change of ['pause', 'access'] as const) {
    const f = await fixture(); await f.negative(); const material = await f.material(); await collect(start);
    if (change === 'pause') expectStatus(await f.owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${f.rule.id}`,
      { body: { expectedVersion: 1, status: 'paused' } }), 200);
    else expectStatus(await f.owner.browser.request('DELETE', `/api/v1/projects/${f.prj.id}/grants/${f.grant.id}`), 204);
    await collect(at(1)); await comparisonSchedulingTick(db, at(3));
    assert.equal((await f.candidates()).length, 1, `${change} creates no new candidate for ${material.materialId}`);
    assert.equal((await f.candidates())[0]!.inspected_sources, null);
  }
});

test('two consumers, restart and more than 100 negative results create each candidate once', async () => {
  const f = await fixture(); await f.material();
  const resultIds = Array.from({ length: 123 }, () => randomUUID());
  await pool.query(`INSERT INTO project_results(id,workspace_id,project_id,title,finding,created_by_kind,created_by_id)
    SELECT id,$2,$3,'Human low-light result','negative','human',$4 FROM unnest($1::uuid[]) id`, [resultIds, f.ws.id, f.prj.id, f.owner.id]);
  const attempts = await Promise.all([collectComparisonSourceChanges(unit, start), collectComparisonSourceChanges(comparisonScheduling(db), start)]);
  assert.ok(attempts.reduce((count, value) => count + value.processed, 0) > 0);
  await collect(start);
  await Promise.all([reconsiderComparisonSources(unit, at(2)), reconsiderComparisonSources(comparisonScheduling(db), at(2))]);
  assert.equal((await f.candidates()).length, 123);
  // A deliberate second pool: scheduling resumes from a reopened connection, not the shared one.
  const reopened = createDatabase(process.env.DATABASE_URL!);
  try { await comparisonSchedulingTick(reopened.db, at(3)); } finally { await reopened.pool.end(); }
  assert.equal((await f.candidates()).length, 123, 'a restart retains the cursor, unique fingerprints and due state');
});

test('unchanged dismissed/unknown candidates never retry; a new human revision preserves their accounting and permits a new fingerprint', async () => {
  for (const state of ['dismissed', 'unknown'] as const) {
    const f = await fixture(); const material = await f.material(); const result = await f.negative();
    expectStatus(await f.owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      apiKey: `sk-ant-api03-${'scheduling-fixture-'.repeat(4)}END8`, payerOrganization: 'Fixture payer', providerWorkspace: 'Fixture scope',
      workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true,
      projectDataDisclosureAcknowledged: true, maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
    } }), 201);
    await collect(start); await comparisonSchedulingTick(db, at(2));
    const candidate = (await f.candidates())[0]!;
    assert.equal((await proactiveReservation(db).reserve(candidate.id, at(2))).status, 'reserved');
    // Controlled persisted outcome/lost-response fixtures, not model calls or billing evidence.
    if (state === 'unknown') await proactiveOutboxRows(db).markUnknown(candidate.id, 'TEST_RESPONSE_LOSS');
    else {
      const outcomeId = randomUUID();
      await db.transaction(async (tx) => {
        const rows = proactiveOutboxRows(tx);
        await rows.saveInspected(candidate.id, [{ type: 'result', id: result.id, version: 1, title: 'Human result' }]);
        assert.ok(await rows.completeInsufficient({ candidateId: candidate.id, id: outcomeId, ownerUserId: f.owner.id,
          agentId: f.agent.id, projectId: f.prj.id, resultId: result.id, reason: 'No comparable sensor trial.',
          failureCode: 'INSUFFICIENT_EVIDENCE', inputTokens: 100, outputTokens: 50, estimatedCents: 2 }));
      });
      expectStatus(await f.owner.browser.request('PATCH', proactiveComparisonOutcomePath(outcomeId),
        { body: { expectedVersion: 1, status: 'dismissed' } }), 200);
    }
    const history = (await f.candidates())[0]!;
    // Reconsidering unchanged source metadata (e.g. cursor recovery) must not create a retry.
    await comparisonSchedulingRows(db).changes.save({ projectId: f.prj.id, firstChangedAt: at(3), lastChangedAt: at(3), dueAt: at(5) });
    await comparisonSchedulingTick(db, at(5)); assert.equal((await f.candidates()).length, 1);
    expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${material.materialId}`,
      { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Human revised the measurement.' } }), 200);
    await collect(at(6)); await comparisonSchedulingTick(db, at(8));
    const rows = await f.candidates(); assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((row) => row.id === candidate.id), history, 'all historical charge/outcome fields survive');
    assert.equal(rows.filter((row) => row.status === 'queued').length, 1);
    assert.notEqual(rows.find((row) => row.status === 'queued')!.source_fingerprint, candidate.source_fingerprint);
  }
});

test('cursor ahead of a rebuilt log recovers and logs every enabled project beyond the first page once', async () => {
  const f = await fixture(); const ids = Array.from({ length: 205 }, () => randomUUID());
  await pool.query(`INSERT INTO projects(id,workspace_id,name,visibility,created_by)
    SELECT id,$2,'Recovery fixture','restricted',$3 FROM unnest($1::uuid[]) id`, [ids, f.ws.id, f.owner.id]);
  await pool.query(`INSERT INTO proactive_comparison_rules(id,workspace_id,project_id,owner_user_id,agent_id,max_runs_per_day,period_budget_cents,per_run_cents,status)
    SELECT gen_random_uuid(),$2,id,$3,$4,3,50,5,'enabled' FROM unnest($1::uuid[]) id`, [ids, f.ws.id, f.owner.id, f.agent.id]);
  await pool.query('UPDATE proactive_comparison_cursor SET seq=(SELECT coalesce(max(seq),0)+10 FROM events) WHERE id=1');
  const logs: string[] = [];
  await comparisonSchedulingTick(db, start, (message) => logs.push(message));
  const count = async () => (await pool.query('SELECT count(*)::int n FROM proactive_comparison_project_changes c JOIN projects p ON p.id=c.project_id WHERE p.workspace_id=$1', [f.ws.id])).rows[0].n;
  assert.equal(await count(), 206); assert.equal(logs.length, 1); assert.match(logs[0]!, /cursor recovered/);
  await comparisonSchedulingTick(db, start, (message) => logs.push(message));
  assert.equal(await count(), 206); assert.equal(logs.length, 1);
});
