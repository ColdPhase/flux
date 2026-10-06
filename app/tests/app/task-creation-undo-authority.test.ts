import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ComparisonProvider } from '@flux/core';
import type { ProactiveComparisonProposal, UndoTaskCreationResult, WorkItem, WorkResult } from '@flux/contracts';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { actionScene, agentConnection, toolFailure } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';

async function fixture() {
  const f = await actionScene(pool);
  const ownerId = (await pool.query('SELECT owner_user_id FROM agents WHERE id=$1', [f.agentId])).rows[0].owner_user_id as string;
  const owner: Person = { id: ownerId, email: '', browser: f.owner };
  const peer = await person('undo-current-assignee');
  await addMember(owner, f.workspaceId, peer, 'member'); await grant(owner, f.projectId, peer, 'contributor');
  const createGrant = await f.grant('work.create', 'execute');
  const create = async () => {
    const value = toolValue(await f.tool('flux_create_task', { projectId: f.projectId, runtimeSessionId: f.runtimeSessionId,
      grantId: createGrant.id, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title: 'Current authority trial' } }));
    return await f.read(String(value.workId)) as unknown as WorkItem;
  };
  return { ...f, ownerId, human: owner, peer, create };
}

test('initial native human assignee requires current project write at Undo and exact receipt replay', { timeout: 30_000 }, async () => {
  const f = await fixture();
  // The production MCP creation schema has no owner field. This genuine scene's
  // admitted native agent port supplies initial assignment, preserving the baseline;
  // all Undo and grant changes use real authenticated human API sessions.
  const item = await db.transaction(async tx => {
    const native = nativeWorkInTransaction(tx);
    const created = await native.createWork({ kind: 'agent', id: f.agentId }, f.projectId,
      { title: 'Initially assigned native trial', owner: { kind: 'human', id: f.peer.id } });
    await native.flushEvents(); return created;
  });
  const commandId = randomUUID(); const command = { clientCommandId: commandId, expectedVersion: item.version };
  assert.deepEqual((expectStatus(await f.peer.browser.request('GET', `/api/v1/work/${item.id}`), 200) as WorkItem).creationUndo,
    { eligible: true, reason: 'eligible' });
  await grant(f.human, f.projectId, f.peer, 'viewer');
  assert.equal((await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command })).status, 403);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 0);
  await grant(f.human, f.projectId, f.peer, 'contributor');
  const reverted = expectStatus(await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command }), 200) as UndoTaskCreationResult;
  assert.equal(reverted.work.lifecycle?.state, 'creation_reverted');
  assert.ok(reverted.work.lifecycle?.state === 'creation_reverted');
  assert.deepEqual(reverted.work.lifecycle.revertedBy, { kind: 'human', id: f.peer.id, name: 'undo-current-assignee' });
  await grant(f.human, f.projectId, f.peer, 'viewer');
  assert.equal((await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command })).status, 403);
  await grant(f.human, f.projectId, f.peer, 'contributor');
  assert.deepEqual(expectStatus(await f.peer.browser.request('POST', `/api/v1/work/${item.id}/creation-undo`, { body: command }), 200), reverted);
});

test('a genuine foreign agent exact grant cannot Undo another creator; revoked connection cannot replay its authority', { timeout: 30_000 }, async () => {
  const f = await fixture(); const item = await f.create();
  const other = expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`,
    { body: { name: 'Another genuine creator', owner: 'self' } }), 201);
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/grants`,
    { body: { principal: { kind: 'agent', id: other.id }, role: 'contributor' } }), 201);
  const actor = await agentConnection(pool, f.owner, String(other.id), [f.projectId]);
  const authority = await actor.grant('work.creation.revert', 'plan', 5, item.id);
  const command = { projectId: f.projectId, runtimeSessionId: actor.runtimeSessionId, grantId: authority.id,
    clientCommandId: randomUUID(), peerRequestClass: 'plan', sources: [], workId: item.id, expectedVersion: item.version };
  assert.equal(toolFailure(await actor.tool('flux_undo_task_creation', command)).code, 'TASK_CREATION_UNDO_FORBIDDEN');
  assert.equal(await f.used(authority.id), 0); assert.equal((await f.read(item.id) as unknown as WorkItem).creationUndo?.eligible, true);
  expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${actor.connectionId}`), 204);
  const revoked = await actor.raw('flux_undo_task_creation', command);
  assert.notEqual(revoked.status, 200, 'Revocation refuses before tool execution');
  assert.equal(await f.used(authority.id), 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 0);
});

test('trusted proposal use keeps accepting human creator; suggesting agent owner gains no Undo right and used proposal cannot resurrect', { timeout: 45_000 }, async () => {
  const f = await fixture();
  const rule = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/proactive-comparison-rules`,
    { body: { agentId: f.agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
      maxRunsPerDay: 1, periodBudgetCents: 5, perRunCents: 5 } }), 201);
  expect(await f.owner.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'undo-controlled-provider-'.repeat(4)}END6`, payerOrganization: 'Controlled fixture payer',
    providerWorkspace: 'Dedicated fixture workspace', workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
    providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
    maxRunsPerDay: 1, periodDays: 30, periodBudgetCents: 5, perRunCents: 5,
  } }), 201);
  // Existing dispatch fixtures enable only the internal controlled-provider path;
  // this proves committed trusted provenance, not production scheduling/billing.
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const observed = expectStatus(await f.peer.browser.request('POST', `/api/v1/projects/${f.projectId}/results`,
    { body: { title: 'Actual published comparison input', finding: 'negative', evidence: 'The same fixture sensor misses the trial.' } }), 201) as WorkResult;
  const candidate = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [observed.id])).rows[0].id as string;
  await comparisonDispatchFixtureDue(pool, candidate);
  const provider: ComparisonProvider = {
    async countInputTokens() { return 100; },
    async createMessage(input) { return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 },
      answer: { kind: 'comparison', fact: 'The fixture sensor missed the trial.', interpretation: 'Repeat with unchanged conditions.',
        suggestedAction: 'Repeat the fixture sensor trial.', citations: input.sources.map(({ type,id,version }) => ({ type,id,version })) } }; },
  };
  const outcome = await dispatchProactiveComparison({ db, candidateId: candidate, masterKey: readFileSync('/run/secrets/flux_background_key'), provider });
  assert.equal(outcome.status, 'proposal'); assert.ok(outcome.status === 'proposal');
  const proposals = expectStatus(await f.peer.browser.request('GET', `/api/v1/projects/${f.projectId}/proactive-comparison-proposals`), 200) as ProactiveComparisonProposal[];
  const proposal = proposals.find(value => value.id === outcome.proposalId)!; assert.ok(proposal);
  const used = expectStatus(await f.peer.browser.request('POST', `/api/v1/proactive-comparison-proposals/${proposal.id}/use`,
    { body: { expectedVersion: proposal.version, title: 'Human accepted AI trial' } }), 200) as { proposal: ProactiveComparisonProposal; work: WorkItem };
  assert.deepEqual(used.work.createdBy, { kind: 'human', id: f.peer.id, name: 'undo-current-assignee' });
  assert.deepEqual(used.work.creationUndo, { eligible: true, reason: 'eligible' });
  const origin = (await pool.query('SELECT creation_origin,creation_proposal_id,created_by_kind,created_by_id FROM project_work_items WHERE id=$1', [used.work.id])).rows[0];
  assert.deepEqual(origin, { creation_origin: 'ai_proposal', creation_proposal_id: proposal.id, created_by_kind: 'human', created_by_id: f.peer.id });
  const command = { clientCommandId: randomUUID(), expectedVersion: used.work.version };
  assert.equal((await f.owner.request('POST', `/api/v1/work/${used.work.id}/creation-undo`, { body: command })).status, 403);
  const reverted = expectStatus(await f.peer.browser.request('POST', `/api/v1/work/${used.work.id}/creation-undo`, { body: command }), 200) as UndoTaskCreationResult;
  assert.deepEqual(reverted.work.createdBy, used.work.createdBy);
  assert.deepEqual((await pool.query('SELECT status,used_work_id FROM proactive_comparison_proposals WHERE id=$1', [proposal.id])).rows[0],
    { status: 'used', used_work_id: used.work.id });
  const count = await f.tasks();
  assert.equal((await f.peer.browser.request('POST', `/api/v1/proactive-comparison-proposals/${proposal.id}/use`,
    { body: { expectedVersion: used.proposal.version, title: 'Do not create another trial' } })).status, 409);
  assert.equal(await f.tasks(), count);
  assert.deepEqual(expectStatus(await f.peer.browser.request('POST', `/api/v1/work/${used.work.id}/creation-undo`, { body: command }), 200), reverted);
});
