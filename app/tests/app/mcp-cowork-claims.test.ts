import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Agent, AgentExecutionCommand, AgentStandingGrant, WorkItem } from '@flux/contracts';
import { coworkUnitRows } from '@flux/db';
import { DomainError } from '@flux/core';
import { coWorkClaimInTransaction } from '../../apps/server/src/co-work/claims.js';
import { COWORK_CLAIM_POLICY } from '../../apps/server/src/co-work/policy.js';
import { db, pool } from './support/db.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// Unit claims over MCP (#153, cowork-coordination.md "Unit claims over MCP", 2026-10-06): real OAuth bearers claim,
// renew, release with a checkpoint, complete and transfer their units through the registered tools, the unchanged
// compositions and the production claim policy (graph locks, role eligibility, checkpoint sources). A server fixture,
// not real Codex/Claude client evidence.
const SCOPES = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
type Role = 'execute' | 'review' | 'plan';
type Lease = { id: string; runtimeSessionId: string; expiresAt: string };
type Checkpoint = { id: string; summary: string; nextAction: string; blocker: string | null;
  sources: { materialId: string; version: number }[]; createdAt: string };
type Claim = { unitId: string; generation: number; version: number; state: string; checkpointId: string | null; lease: Lease | null;
  checkpoint?: Checkpoint | null };

async function scene() {
  const hubert = await person('mcp-claims-hubert'), marek = await person('mcp-claims-marek');
  const ws = await workspace(hubert, 'MCP unit claims');
  // Marek authorizes his own connection's standing grants, which needs project management (#152).
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Claimed outcome', 'restricted');
  await grant(hubert, p.id, marek, 'contributor');
  const connect = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const connected = await agentConnection(pool, who.browser, String(agent.id), [p.id], SCOPES);
    const [binding] = (await pool.query('SELECT id, client_id FROM agent_oauth_bindings WHERE connection_id=$1', [connected.connectionId])).rows;
    /** The bearer's verified claims, for the one internal-only payload form (a release naming an existing checkpoint). */
    const claims = { ownerUserId: who.id, connectionId: connected.connectionId, clientId: String(binding.client_id),
      grantReferenceId: `flux-grant:${binding.id}`, scopes: [...SCOPES, 'offline_access'] };
    const grantRequest = (operation: string, objectId: string | null, role: Role, maximumUses = 10) =>
      who.browser.request('POST', `/api/v1/agent-connections/${connected.connectionId}/action-grants`, { body: {
        clientCommandId: randomUUID(), projectId: p.id, operation, peerRequestClass: role, maximumUses, ...(objectId ? { objectId } : {}),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    const standing = async (operation: string, objectId: string | null, role: Role, maximumUses = 10) =>
      expectStatus(await grantRequest(operation, objectId, role, maximumUses), 201) as AgentStandingGrant;
    const revoke = async (grantId: string) => expectStatus(await who.browser.request('DELETE',
      `/api/v1/agent-connections/${connected.connectionId}/action-grants/${grantId}`), 204);
    const base = (grantId: string, role: Role, clientCommandId: string = randomUUID(), runtimeSessionId = connected.runtimeSessionId) =>
      ({ projectId: p.id, runtimeSessionId, grantId, clientCommandId, peerRequestClass: role });
    /** Another runtime session of this same bearer: a second client session's bootstrap. */
    const session = async () => (toolValue(await connected.tool('flux_bootstrap', { projectId: p.id, clientSessionId: randomUUID() }))
      .runtime as { id: string }).id;
    /** Takes a task over MCP: a root unit of `role`, assigned to this connection. */
    const take = async (task: WorkItem, role: Role = 'execute', unitKey = 'take') => {
      const create = await standing('cowork.unit.create', task.id, role);
      return toolValue(await connected.tool('flux_create_unit', { ...base(create.id, role), taskId: task.id, unitKey,
        expectedTaskVersion: task.version, assignmentConnectionId: connected.connectionId, parent: null })) as { unitId: string; state: string; version: number };
    };
    return { ...connected, claims, grantRequest, standing, revoke, base, session, take };
  };
  const task = async (title: string) => expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`,
    { body: { title } }), 201) as WorkItem;
  const patchTask = async (item: { id: string; version: number }, body: Record<string, unknown>) => expectStatus(await hubert.browser.request('PATCH',
    `/api/v1/work/${item.id}`, { body, headers: { 'if-match': `"${item.version}"` } }), 200) as WorkItem;
  const material = async (title: string) => {
    const created = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
      { body: { clientMutationId: randomUUID(), title, body: 'Exact first revision' } }), 201) as { materialId: string; version: number };
    return { materialId: created.materialId, version: created.version };
  };
  const used = async (grantId: string) => (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used as number;
  const unit = async (id: string) => (await pool.query(`SELECT state, version, generation, assignment_connection_id, lease_id, lease_session_id,
    lease_expires_at, checkpoint_id, outcome_ref FROM cowork_units WHERE id=$1`, [id])).rows[0];
  const taskRow = async (id: string) => (await pool.query('SELECT status, version, updated_at FROM project_work_items WHERE id=$1', [id])).rows[0];
  const checkpoints = async (unitId: string) => (await pool.query(`SELECT id, connection_id, runtime_session_id, generation, progress
    FROM cowork_checkpoints WHERE unit_id=$1 ORDER BY created_at`, [unitId])).rows;
  const receipts = async (connectionId: string) =>
    (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [connectionId])).rows[0].n as number;
  return { hubert, marek, ws, p, connect, task, patchTask, material, used, unit, taskRow, checkpoints, receipts };
}
type Scene = Awaited<ReturnType<typeof scene>>;
type Connection = Awaited<ReturnType<Scene['connect']>>;
/** A strict schema refusal: the SDK reports it as a tool error or a JSON-RPC error, never a domain effect. */
function schemaRefused(message: Record<string, unknown> | null) {
  return !!message?.error || (message?.result as { isError?: boolean } | undefined)?.isError === true;
}
const claimTool = async (c: Connection, grantId: string, unitId: string, expectedVersion: number, options: { command?: string; session?: string } = {}) =>
  c.tool('flux_claim_unit', { ...c.base(grantId, 'execute', options.command, options.session), unitId, expectedVersion });
const fenceOf = (claim: Claim) => ({ unitId: claim.unitId, expectedVersion: claim.version, generation: claim.generation, leaseId: claim.lease!.id });

test('one MCP bearer takes a task, claims, renews and completes its unit with an outcome; a second connection cannot claim it', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), claude = await f.connect(f.hubert, 'Hubert Claude');
  const a = await f.task('Native outcome A');
  const root = await codex.take(a);
  assert.deepEqual([root.state, root.version], ['pending', 1]);

  const claimGrant = await codex.standing('cowork.claim', root.unitId, 'execute');
  const claimed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, 1)) as Claim;
  assert.deepEqual({ ...claimed, lease: null }, { unitId: root.unitId, generation: 1, version: 2, state: 'claimed', checkpointId: null,
    checkpoint: null, lease: null });
  assert.equal(claimed.lease!.runtimeSessionId, codex.runtimeSessionId);
  const remaining = Date.parse(claimed.lease!.expiresAt) - Date.now();
  assert.ok(remaining > 240_000 && remaining <= 300_000, `the server-owned lease is 300 seconds (${remaining} ms left)`);
  const live = await f.unit(root.unitId);
  assert.deepEqual([live.state, live.lease_id, live.lease_session_id, live.assignment_connection_id],
    ['claimed', claimed.lease!.id, codex.runtimeSessionId, codex.connectionId]);

  // A second connection of the same owner cannot claim it: an exact grant cannot even name the unit, and a project-wide
  // claim grant does not find it.
  assert.equal((await claude.grantRequest('cowork.claim', root.unitId, 'execute')).status, 404);
  const claudeClaim = await claude.standing('cowork.claim', null, 'execute');
  assert.equal(toolFailure(await claimTool(claude, claudeClaim.id, root.unitId, 2)).code, 'COWORK_UNIT_NOT_FOUND');

  // One live unit per connection: another task's unit waits until this one is released or completed.
  const other = await codex.take(await f.task('Native outcome B'));
  const otherGrant = await codex.standing('cowork.claim', other.unitId, 'execute');
  assert.equal(toolFailure(await claimTool(codex, otherGrant.id, other.unitId, 1)).code, 'COWORK_CONNECTION_BUSY');

  const renewGrant = await codex.standing('cowork.renew', root.unitId, 'execute');
  const renewed = toolValue(await codex.tool('flux_renew_unit', { ...codex.base(renewGrant.id, 'execute'), ...fenceOf(claimed) })) as Claim;
  assert.deepEqual([renewed.state, renewed.version, renewed.generation, renewed.lease!.id, renewed.lease!.runtimeSessionId],
    ['claimed', 3, 1, claimed.lease!.id, codex.runtimeSessionId]);
  assert.ok(Date.parse(renewed.lease!.expiresAt) >= Date.parse(claimed.lease!.expiresAt), 'renewal extends the lease from now');

  // The outcome is a native record the agent publishes under its own grant; completion only references it.
  const resultGrant = await codex.standing('result.record', null, 'execute');
  const recorded = toolValue(await codex.tool('flux_record_result', { ...codex.base(resultGrant.id, 'execute'), sources: [],
    result: { title: 'Outcome A observed', finding: 'positive', evidence: 'The bounded check ran and passed.', workIds: [a.id] } }));
  const taskBefore = await f.taskRow(a.id);
  const completeGrant = await codex.standing('cowork.unit.complete', root.unitId, 'execute');
  const complete = { ...codex.base(completeGrant.id, 'execute'), ...fenceOf(renewed), outcome: { type: 'result', id: recorded.resultId } };
  const completed = toolValue(await codex.tool('flux_complete_unit', complete));
  assert.deepEqual(completed, { unitId: root.unitId, taskId: a.id, role: 'execute', assignmentConnectionId: codex.connectionId,
    version: 4, state: 'completed', outcomeRef: { type: 'result', id: recorded.resultId } });
  const done = await f.unit(root.unitId);
  assert.deepEqual([done.state, done.lease_id, done.lease_session_id, done.lease_expires_at, done.outcome_ref],
    ['completed', null, null, null, { type: 'result', id: recorded.resultId }]);
  assert.deepEqual(await f.taskRow(a.id), taskBefore, 'completion does not change the task');
  assert.deepEqual(toolValue(await codex.tool('flux_complete_unit', complete)), completed, 'a retry replays the completion');

  // Completed is final: the holder cannot claim it again, and the second connection still cannot.
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, 4)).code, 'COWORK_UNIT_CLOSED');
  assert.equal(toolFailure(await claimTool(claude, claudeClaim.id, root.unitId, 4)).code, 'COWORK_UNIT_NOT_FOUND');
  assert.deepEqual([await f.used(claimGrant.id), await f.used(renewGrant.id), await f.used(completeGrant.id), await f.used(claudeClaim.id)],
    [1, 1, 1, 0], 'one use per effect; refusals and the replay spend nothing');
  assert.equal(await f.receipts(claude.connectionId), 0);
  // Completion freed the connection: the other unit can be claimed now.
  assert.equal((toolValue(await claimTool(codex, otherGrant.id, other.unitId, 1)) as Claim).state, 'claimed');
  assert.equal(await f.used(otherGrant.id), 1);
});

test('a replay returns the stored claim; a changed payload conflicts; renewal makes the claim receipt stale; a revoked grant refuses', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimGrant = await codex.standing('cowork.claim', root.unitId, 'execute');
  const command = randomUUID();
  const claimed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, 1, { command })) as Claim;
  assert.deepEqual(toolValue(await claimTool(codex, claimGrant.id, root.unitId, 1, { command })), claimed, 'a lost response is retried');
  assert.equal(await f.used(claimGrant.id), 1);
  assert.equal(await f.receipts(codex.connectionId), 2, 'the creation and the one claim');
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, 2, { command })).code, 'IDEMPOTENCY_CONFLICT');

  const renewGrant = await codex.standing('cowork.renew', root.unitId, 'execute');
  const renew = { ...codex.base(renewGrant.id, 'execute'), ...fenceOf(claimed) };
  const renewed = toolValue(await codex.tool('flux_renew_unit', renew)) as Claim;
  assert.deepEqual(toolValue(await codex.tool('flux_renew_unit', renew)), renewed);
  assert.equal(await f.used(renewGrant.id), 1);
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, 1, { command })).code, 'COWORK_RECEIPT_STALE',
    'the claim receipt no longer describes the unit after a renewal');

  // The owner revokes the renewal grant: a new renewal and the replay of the earlier one are both refused.
  await codex.revoke(renewGrant.id);
  const before = await f.unit(root.unitId);
  assert.equal(toolFailure(await codex.tool('flux_renew_unit', { ...renew, clientCommandId: randomUUID(), expectedVersion: renewed.version }))
    .code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await codex.tool('flux_renew_unit', renew)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  // The same holds for the claim grant: a fresh claim and its replay are refused before any effect.
  await codex.revoke(claimGrant.id);
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, renewed.version)).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, 1, { command })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual(await f.unit(root.unitId), before);
  assert.deepEqual([await f.used(claimGrant.id), await f.used(renewGrant.id), await f.receipts(codex.connectionId)], [1, 1, 3]);
});

test('a lease is fenced by its runtime session and its expiry: the other session and the expired holder are refused', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimGrant = await codex.standing('cowork.claim', root.unitId, 'execute');
  const renewGrant = await codex.standing('cowork.renew', root.unitId, 'execute');
  const completeGrant = await codex.standing('cowork.unit.complete', root.unitId, 'execute');
  const claimed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, 1)) as Claim;
  const outcome = { type: 'work', id: (await f.task('Outcome record')).id, version: 1 };
  const renew = (claim: Claim, session?: string) => codex.tool('flux_renew_unit', { ...codex.base(renewGrant.id, 'execute', randomUUID(), session),
    ...fenceOf(claim) });
  const complete = (claim: Claim, session?: string) => codex.tool('flux_complete_unit', {
    ...codex.base(completeGrant.id, 'execute', randomUUID(), session), ...fenceOf(claim), outcome });

  // The same bearer's second client session has its own runtime: it passes #152 but does not hold this lease.
  const other = await codex.session();
  assert.notEqual(other, codex.runtimeSessionId);
  const held = await f.unit(root.unitId);
  assert.equal(toolFailure(await renew(claimed, other)).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await complete(claimed, other)).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, claimed.version, { session: other })).code, 'COWORK_UNIT_BUSY');
  assert.deepEqual(await f.unit(root.unitId), held);

  // The database clock passes the lease (the persisted deadline moves into the past; nothing else changes).
  await pool.query("UPDATE cowork_units SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [root.unitId]);
  const expired = await f.unit(root.unitId);
  assert.equal(toolFailure(await renew(claimed)).code, 'COWORK_CLAIM_LOST', 'renewal cannot resurrect an expired lease');
  assert.equal(toolFailure(await complete(claimed)).code, 'COWORK_CLAIM_LOST');
  assert.deepEqual(await f.unit(root.unitId), expired);
  // The other session can now claim it; the new generation fences the old lease for good.
  const reclaimed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, claimed.version, { session: other })) as Claim;
  assert.deepEqual([reclaimed.generation, reclaimed.lease!.runtimeSessionId], [2, other]);
  assert.equal(toolFailure(await renew({ ...claimed, version: reclaimed.version })).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await complete({ ...claimed, version: reclaimed.version })).code, 'COWORK_CLAIM_LOST');
  assert.deepEqual([await f.used(claimGrant.id), await f.used(renewGrant.id), await f.used(completeGrant.id)], [2, 0, 0]);
});

test('role eligibility: a wrong class names no unit, execute needs its prerequisites now, plan does not, a closed task refuses', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), claude = await f.connect(f.hubert, 'Hubert Claude');
  const pre = await f.task('Prerequisite');
  const dependent = await f.patchTask(await f.task('Dependent'), { dependencyIds: [pre.id] });
  const execute = await codex.take(dependent);
  const claimGrant = await codex.standing('cowork.claim', execute.unitId, 'execute');
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, execute.unitId, 1)).code, 'TASK_PREREQUISITES_UNMET');
  assert.deepEqual([(await f.unit(execute.unitId)).state, await f.used(claimGrant.id)], ['pending', 0]);

  // A review-class grant cannot name an execute unit, and a project-wide one does not find it.
  assert.equal((await codex.grantRequest('cowork.claim', execute.unitId, 'review')).status, 404);
  const review = await codex.standing('cowork.claim', null, 'review');
  assert.equal(toolFailure(await codex.tool('flux_claim_unit', { ...codex.base(review.id, 'review'), unitId: execute.unitId, expectedVersion: 1 }))
    .code, 'COWORK_UNIT_NOT_FOUND');

  // Planning has no prerequisite rule: another connection takes and claims the plan unit of the same task.
  const plan = await claude.take(dependent, 'plan', 'plan');
  const planGrant = await claude.standing('cowork.claim', plan.unitId, 'plan');
  const planned = toolValue(await claude.tool('flux_claim_unit', { ...claude.base(planGrant.id, 'plan'), unitId: plan.unitId, expectedVersion: 1 })) as Claim;
  assert.equal(planned.state, 'claimed');

  // The prerequisite is done: the execute claim succeeds. Reopened, it stops the next renewal; parking is still possible.
  const finished = await f.patchTask(pre, { status: 'done' });
  const claimed = toolValue(await claimTool(codex, claimGrant.id, execute.unitId, 1)) as Claim;
  await f.patchTask(finished, { status: 'in_progress' });
  const renewGrant = await codex.standing('cowork.renew', execute.unitId, 'execute');
  const held = await f.unit(execute.unitId);
  assert.equal(toolFailure(await codex.tool('flux_renew_unit', { ...codex.base(renewGrant.id, 'execute'), ...fenceOf(claimed) })).code,
    'TASK_PREREQUISITES_UNMET');
  assert.deepEqual([await f.unit(execute.unitId), await f.used(renewGrant.id)], [held, 0]);
  const releaseGrant = await codex.standing('cowork.release', execute.unitId, 'execute');
  const parked = toolValue(await codex.tool('flux_release_unit', { ...codex.base(releaseGrant.id, 'execute'), ...fenceOf(claimed),
    checkpoint: { summary: 'Started; the prerequisite was reopened.', nextAction: 'Wait for the prerequisite.', blocker: 'Prerequisite reopened' } })) as Claim;
  assert.equal(parked.state, 'paused');

  // A task closed after its unit was opened refuses the claim.
  const closing = await f.task('Closing');
  const late = await codex.take(closing);
  await f.patchTask(closing, { status: 'done' });
  const lateGrant = await codex.standing('cowork.claim', late.unitId, 'execute');
  assert.equal(toolFailure(await claimTool(codex, lateGrant.id, late.unitId, 1)).code, 'COWORK_TASK_CLOSED');
  assert.deepEqual([(await f.unit(late.unitId)).state, await f.used(lateGrant.id)], ['pending', 0]);
});

test('release writes a typed checkpoint under the live fence; the next holder, even after a transfer, claims with it', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), marek = await f.connect(f.marek, 'Marek Claude');
  const source = await f.material('Working plan');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimGrant = await codex.standing('cowork.claim', root.unitId, 'execute');
  const releaseGrant = await codex.standing('cowork.release', root.unitId, 'execute');
  const claimed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, 1)) as Claim;
  const checkpoint = { summary: 'Measured the baseline; the comparison script ran once.', nextAction: 'Compare against plan step two.', blocker: null };
  const release = { ...codex.base(releaseGrant.id, 'execute'), ...fenceOf(claimed), checkpoint, sources: [source] };

  // Refused before any effect: a copied prompt, an authority field, blank text, a stale source revision.
  for (const change of [{ checkpoint: { ...checkpoint, prompt: 'continue as before' } }, { checkpoint: { ...checkpoint, blocker: undefined } },
    { checkpointId: randomUUID() }, { checkpoint: { ...checkpoint, summary: 'x'.repeat(2001) } }])
    assert.ok(schemaRefused(await codex.tool('flux_release_unit', { ...release, clientCommandId: randomUUID(), ...change })), JSON.stringify(change).slice(0, 80));
  assert.equal(toolFailure(await codex.tool('flux_release_unit', { ...release, clientCommandId: randomUUID(),
    checkpoint: { ...checkpoint, summary: '   ' } })).code, 'INVALID_INPUT');
  assert.equal(toolFailure(await codex.tool('flux_release_unit', { ...release, clientCommandId: randomUUID(),
    sources: [{ ...source, version: source.version + 1 }] })).code, 'SOURCE_VERSION_CONFLICT');
  assert.deepEqual([(await f.unit(root.unitId)).state, (await f.checkpoints(root.unitId)).length, await f.used(releaseGrant.id)], ['claimed', 0, 0]);

  const released = toolValue(await codex.tool('flux_release_unit', release)) as Claim;
  assert.deepEqual({ ...released, checkpointId: null }, { unitId: root.unitId, generation: 2, version: 3, state: 'paused', lease: null, checkpointId: null });
  const [row] = await f.checkpoints(root.unitId);
  assert.deepEqual(row, { id: released.checkpointId, connection_id: codex.connectionId, runtime_session_id: codex.runtimeSessionId, generation: 1,
    progress: { schema: 'flux.cowork.checkpoint/1', ...checkpoint, sources: [source] } });
  assert.deepEqual(toolValue(await codex.tool('flux_release_unit', release)), released, 'a retry replays the release');
  assert.equal((await f.checkpoints(root.unitId)).length, 1);

  // The source changes after the checkpoint: the historical checkpoint does not block a new claim, and it comes back
  // with the source versions it recorded, so the holder can see what changed.
  expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/materials/${source.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: source.version, body: 'A later revision' } }), 200);
  const resumed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, released.version)) as Claim;
  assert.deepEqual([resumed.state, resumed.generation, resumed.checkpointId], ['claimed', 3, released.checkpointId]);
  assert.deepEqual({ ...resumed.checkpoint!, createdAt: null }, { id: released.checkpointId, ...checkpoint, sources: [source], createdAt: null });

  // Transfer to Marek's connection: the former holder loses the unit, the assignee claims it under its own owner's grant
  // and receives the same checkpoint, written by another connection and owner.
  const transferGrant = await codex.standing('cowork.unit.transfer', root.unitId, 'execute');
  const transferred = toolValue(await codex.tool('flux_transfer_unit', { ...codex.base(transferGrant.id, 'execute'), ...fenceOf(resumed),
    assignmentConnectionId: marek.connectionId }));
  assert.deepEqual([transferred.state, transferred.assignmentConnectionId, transferred.version], ['pending', marek.connectionId, 5]);
  assert.equal(toolFailure(await claimTool(codex, claimGrant.id, root.unitId, 5)).code, 'COWORK_UNIT_NOT_FOUND');
  const marekGrant = await marek.standing('cowork.claim', root.unitId, 'execute');
  const taken = toolValue(await claimTool(marek, marekGrant.id, root.unitId, 5)) as Claim;
  assert.deepEqual([taken.state, taken.lease!.runtimeSessionId, taken.checkpoint!.id, taken.checkpoint!.summary],
    ['claimed', marek.runtimeSessionId, released.checkpointId, checkpoint.summary]);

  // A checkpoint whose source no longer exists in the project is never shown: the claim is refused and changes nothing.
  const releaseMarek = await marek.standing('cowork.release', root.unitId, 'execute');
  const parked = toolValue(await marek.tool('flux_release_unit', { ...marek.base(releaseMarek.id, 'execute'), ...fenceOf(taken),
    checkpoint: { summary: 'Reviewed the earlier checkpoint.', nextAction: 'Continue the comparison.', blocker: null },
    sources: [{ materialId: source.materialId, version: source.version + 1 }] })) as Claim;
  await pool.query('DELETE FROM project_materials WHERE id=$1', [source.materialId]);
  const paused = await f.unit(root.unitId);
  assert.equal(toolFailure(await claimTool(marek, marekGrant.id, root.unitId, parked.version)).code, 'COWORK_CHECKPOINT_NOT_FOUND');
  assert.deepEqual([await f.unit(root.unitId), await f.used(marekGrant.id)], [paused, 1]);
});

test('production checkpoint rules on the internal checkpointId form: a release needs exact coverage, an untyped checkpoint is never used', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const source = await f.material('Working plan');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimGrant = await codex.standing('cowork.claim', root.unitId, 'execute');
  const releaseGrant = await codex.standing('cowork.release', root.unitId, 'execute');
  const claimed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, 1)) as Claim;
  // Two checkpoints written under the live fence, as only a release does in production: one typed, one not.
  const insert = (progress: Record<string, unknown>) => db.transaction(async (tx) => {
    const locked = await coworkUnitRows(tx).lock({ workspaceId: f.ws.id, projectId: f.p.id, connectionId: codex.connectionId, unitId: root.unitId });
    const id = randomUUID();
    assert.equal(await locked!.insertCheckpoint({ id, generation: claimed.generation, leaseId: claimed.lease!.id,
      runtimeSessionId: codex.runtimeSessionId, progress }), id);
    return id;
  });
  const typed = await insert({ schema: 'flux.cowork.checkpoint/1', summary: 'Measured the baseline.', nextAction: 'Compare.', blocker: null,
    sources: [source] });
  const untyped = await insert({ sources: [source], nextAction: 'An untyped note' });
  const release = (checkpointId: string, sources: { materialId: string; version: number }[]) => db.transaction((tx) =>
    coWorkClaimInTransaction(tx, codex.claims, { runtimeSessionId: codex.runtimeSessionId, grantId: releaseGrant.id, clientCommandId: randomUUID(),
      projectId: f.p.id, operation: 'cowork.release', peerRequestClass: 'execute', audience: { kind: 'project', projectId: f.p.id },
      objectId: root.unitId, sources, payload: { expectedVersion: claimed.version, generation: claimed.generation, leaseId: claimed.lease!.id,
        checkpointId } } satisfies AgentExecutionCommand,
    COWORK_CLAIM_POLICY));
  const rejects = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code, code);
  const held = await f.unit(root.unitId);
  await rejects(release(typed, []), 'COWORK_CHECKPOINT_SOURCES_REQUIRED');
  await rejects(release(untyped, [source]), 'COWORK_CHECKPOINT_NOT_FOUND');
  assert.deepEqual([await f.unit(root.unitId), await f.used(releaseGrant.id)], [held, 0]);
  const paused = await release(typed, [source]);
  assert.deepEqual([paused.state, paused.checkpointId], ['paused', typed]);
  const resumed = toolValue(await claimTool(codex, claimGrant.id, root.unitId, paused.version)) as Claim;
  assert.deepEqual([resumed.checkpoint!.id, resumed.checkpoint!.summary, resumed.checkpoint!.sources], [typed, 'Measured the baseline.', [source]]);
});
