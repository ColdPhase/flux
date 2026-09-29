import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, proactiveOutboxRows } from '@flux/db';
import { recordEvent } from '@flux/core';
import type { WorkResult } from '@flux/contracts';
import { proactiveReservation } from '../../apps/worker/src/proactive-comparison/reservation-adapter.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
const reservations = proactiveReservation(db);
after(() => pool.end());
const fakeKey = `sk-ant-api03-${'outbox-owner-only-'.repeat(4)}END7`;

describe('negative-result candidate and budget reservation (#58)', () => {
  let owner: Person;
  let peer: Person;
  let projectId: string;
  let workspaceId: string;
  let ruleId: string;
  let agentId: string;
  let grantId: string;
  let peerResultId: string;

  const result = async (actor: Person, finding: 'positive' | 'negative', title: string) =>
    expectStatus(await actor.browser.request('POST', `/api/v1/projects/${projectId}/results`,
      { body: { title, finding, evidence: 'Low-light trial at 5 lux' } }), 201) as WorkResult;
  const candidate = async (resultId: string) => {
    const found = await pool.query('SELECT id, owner_user_id, rule_id, status, source_fingerprint, reserved_cents FROM proactive_comparison_outbox WHERE result_id=$1', [resultId]);
    return found.rows[0] as { id: string; owner_user_id: string; rule_id: string; status: string; source_fingerprint: string; reserved_cents: number } | undefined;
  };

  before(async () => {
    [owner, peer] = await Promise.all([person('outbox-owner'), person('outbox-peer')]);
    const ws = await workspace(owner, 'Outbox workspace');
    workspaceId = ws.id;
    await addMember(owner, ws.id, peer, 'member');
    projectId = (await project(owner, ws.id, 'Dark-room trial', 'restricted')).id;
    await grant(owner, projectId, peer, 'contributor');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Comparison agent', owner: 'self' } }), 201) as { id: string }).id;
    grantId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/grants`,
      { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201) as { id: string }).id;
    ruleId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/proactive-comparison-rules`,
      { body: { agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
        dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
        maxRunsPerDay: 1, periodBudgetCents: 5, perRunCents: 5 } }), 201) as { id: string }).id;
    expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
      apiKey: fakeKey, payerOrganization: 'Owner payer', providerWorkspace: 'Dedicated test workspace',
      workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
      providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
      maxRunsPerDay: 1, periodDays: 30, periodBudgetCents: 5, perRunCents: 5,
    } }), 201);
    // Production activation remains fail-closed until a provider worker exists. This
    // fixture enables the row solely to exercise the internal outbox/reservation path.
    await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [ruleId]);
  });

  test('a permitted peer’s committed negative result uses the owner’s standing rule; positive and proposal events do not trigger', async () => {
    const positive = await result(owner, 'positive', 'Camera passes');
    const peerNegative = await result(peer, 'negative', 'Peer sees poor low-light result');
    peerResultId = peerNegative.id;
    assert.equal(await candidate(positive.id), undefined);
    assert.deepEqual([(await candidate(peerNegative.id))?.owner_user_id, (await candidate(peerNegative.id))?.rule_id],
      [owner.id, ruleId], 'the peer’s project-visible result uses only the owner’s explicit rule and budget');
    const beforeProposal = (await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE project_id=$1', [projectId])).rows[0].n;
    await db.transaction((tx) => recordEvent(tx, { kind: 'agent', id: agentId }, workspaceId,
      'project.proposal_created.v1', projectId, {}));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE project_id=$1', [projectId])).rows[0].n,
      beforeProposal, 'a proposal-origin event cannot start another comparison');
    const resultPath = `/api/v1/projects/${projectId}/results`;
    const key = randomUUID();
    const command = { title: 'Camera misses gestures in low light', finding: 'negative', evidence: 'Low-light trial at 5 lux' };
    const negative = expectStatus(await owner.browser.request('POST', resultPath,
      { body: command, headers: { 'Idempotency-Key': key } }), 201) as WorkResult;
    const queued = await candidate(negative.id);
    assert.equal(queued?.status, 'queued');
    assert.match(queued!.source_fingerprint, /^[0-9a-f]{64}$/);
    const replay = expectStatus(await owner.browser.request('POST', resultPath,
      { body: command, headers: { 'Idempotency-Key': key } }), 201) as WorkResult;
    assert.equal(replay.id, negative.id, 'the result, event and candidate share one idempotent commit');
    assert.equal(await db.transaction((tx) => proactiveOutboxRows(tx).enqueueHumanNegative(negative.id, projectId, owner.id, [ruleId])), 0);
    assert.equal(await db.transaction((tx) => proactiveOutboxRows(tx).enqueueHumanNegative(peerNegative.id, projectId, peer.id, [ruleId])), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE result_id=$1', [negative.id])).rows[0].n, 1);
  });

  test('concurrent reservation charges once and never retries an unknown charge', async () => {
    const second = await result(owner, 'negative', 'Another dark-room run failed');
    const ids = [(await candidate(peerResultId))!.id, (await candidate(second.id))!.id];
    const attempts = await Promise.all(ids.map((id) => reservations.reserve(id)));
    assert.equal(attempts.filter((item) => item.status === 'reserved').length, 1);
    assert.equal(attempts.filter((item) => item.status === 'blocked' && item.reason === 'OWNER_IN_FLIGHT').length, 1);
    const reserved = attempts.find((item) => item.status === 'reserved')!;
    assert.equal(reserved.reservedCents, 5);
    assert.equal((await pool.query('SELECT sum(reserved_cents)::int AS cents FROM proactive_comparison_outbox WHERE owner_user_id=$1', [owner.id])).rows[0].cents, 5);
    await pool.query("UPDATE proactive_comparison_outbox SET status='unknown' WHERE id=$1", [reserved.id]);
    const blockedId = ids.find((id) => id !== reserved.id)!;
    assert.deepEqual(await reservations.reserve(blockedId), { status: 'blocked', reason: 'BUDGET_EXHAUSTED' });
    assert.equal((await candidate(ids[0] === reserved.id ? second.id : peerResultId))!.status, 'queued');
  });

  test('changed source, paused rule and revoked agent access prevent reservation', async () => {
    // Give a fresh owner a separate allowance below; this owner's period is spent,
    // but source checks must reject before budget evaluation.
    const evidence = await result(owner, 'positive', 'Earlier camera benchmark');
    const sourceChanged = await result(owner, 'negative', 'Source changed after result');
    const changedId = (await candidate(sourceChanged.id))!.id;
    const ws = await pool.query('SELECT workspace_id FROM projects WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO project_object_links
      (id, workspace_id, project_id, role, from_type, from_id, to_type, to_id, created_by_kind, created_by_id)
      VALUES ($1, $2, $3, 'source', 'result', $4, 'result', $5, 'human', $6)`, [
      randomUUID(), ws.rows[0].workspace_id, projectId, sourceChanged.id, evidence.id, owner.id,
    ]);
    assert.deepEqual(await reservations.reserve(changedId), { status: 'blocked', reason: 'SOURCE_CHANGED' });
    assert.equal((await candidate(sourceChanged.id))!.status, 'cancelled');

    const paused = await result(owner, 'negative', 'Paused after this result');
    expectStatus(await owner.browser.request('PATCH', `/api/v1/proactive-comparison-rules/${ruleId}`,
      { body: { expectedVersion: 1, status: 'paused' } }), 200);
    assert.deepEqual(await reservations.reserve((await candidate(paused.id))!.id),
      { status: 'blocked', reason: 'RULE_STOPPED' });
    assert.equal((await candidate(paused.id))!.status, 'cancelled');
    // Re-enable only in this fixture; production activation remains fail-closed.
    await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [ruleId]);
    const accessLost = await result(owner, 'negative', 'Access loss after result');
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${projectId}/grants/${grantId}`), 204);
    assert.deepEqual(await reservations.reserve((await candidate(accessLost.id))!.id),
      { status: 'blocked', reason: 'OWNER_OR_AGENT_ACCESS' });
    assert.equal((await candidate(accessLost.id))!.status, 'cancelled');
  });

  test('an agent-origin result cannot be enqueued even when an agent ID is supplied', async () => {
    const agentResultId = randomUUID();
    const ws = await pool.query('SELECT workspace_id FROM projects WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO project_results (id, workspace_id, project_id, title, finding, created_by_kind, created_by_id)
      VALUES ($1, $2, $3, 'Agent-derived finding', 'negative', 'agent', $4)`, [agentResultId, ws.rows[0].workspace_id, projectId, agentId]);
    assert.equal(await db.transaction((tx) => proactiveOutboxRows(tx).enqueueHumanNegative(agentResultId, projectId, owner.id, [ruleId])), 0);
    assert.equal(await db.transaction((tx) => proactiveOutboxRows(tx).enqueueHumanNegative(agentResultId, projectId, agentId, [ruleId])), 0);
    assert.equal(await candidate(agentResultId), undefined);
  });
});
