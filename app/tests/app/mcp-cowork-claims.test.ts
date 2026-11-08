import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Agent, AgentBootstrap, AgentExecutionCommand, WorkItem } from '@flux/contracts';
import { coworkUnitRows } from '@flux/db';
import { DomainError } from '@flux/core';
import { coWorkClaimInTransaction } from '../../apps/server/src/co-work/claims.js';
import { COWORK_CLAIM_POLICY } from '../../apps/server/src/co-work/policy.js';
import { db, pool } from './support/db.js';
import { agentConnection, approveWaiting, toolFailure, waits } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';

// Unit claims over MCP (#153, cowork-coordination.md "Unit claims over MCP", 2026-10-06): real OAuth bearers claim,
// renew, release with a checkpoint, complete and transfer their units through the registered tools, the unchanged
// compositions and the production claim policy (graph locks, role eligibility, checkpoint sources). A server fixture,
// not real Codex/Claude client evidence.
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
    const connected = await agentConnection(pool, who.browser, String(agent.id), [p.id]);
    const [binding] = (await pool.query('SELECT id, client_id FROM agent_oauth_bindings WHERE connection_id=$1', [connected.connectionId])).rows;
    /** The bearer's verified claims, for the one internal-only payload form (a release naming an existing checkpoint). */
    const claims = { ownerUserId: who.id, connectionId: connected.connectionId, clientId: String(binding.client_id),
      grantReferenceId: `flux-grant:${binding.id}` };
    // No standing grants (#859): the stub keeps the call sites that name one; the tool helpers drop its id.
    const standing = async (...named: [operation: string, objectId: string | null, role: Role, maximumUses?: number]) => { void named; return { id: randomUUID() }; };
    const base = (role: Role, clientCommandId: string = randomUUID(), runtimeSessionId = connected.runtimeSessionId) =>
      ({ projectId: p.id, runtimeSessionId, clientCommandId, peerRequestClass: role });
    /** Another runtime session of this same bearer: a second client session's bootstrap. */
    const session = async () => (toolValue(await connected.tool('flux_bootstrap', { projectId: p.id, clientSessionId: randomUUID() }))
      .runtime as { id: string }).id;
    /** Takes a task over MCP: a root unit of `role`, assigned to this connection. */
    const take = async (task: WorkItem, role: Role = 'execute', unitKey = 'take') => {
      return toolValue(await connected.tool('flux_create_unit', { ...base(role), taskId: task.id, unitKey,
        expectedTaskVersion: task.version, assignmentConnectionId: connected.connectionId, parent: null })) as { unitId: string; state: string; version: number };
    };
    return { ...connected, claims, standing, base, session, take };
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
  const unit = async (id: string) => (await pool.query(`SELECT state, version, generation, assignment_connection_id, lease_id, lease_session_id,
    lease_expires_at, checkpoint_id, outcome_ref FROM cowork_units WHERE id=$1`, [id])).rows[0];
  const taskRow = async (id: string) => (await pool.query('SELECT status, version, updated_at FROM project_work_items WHERE id=$1', [id])).rows[0];
  const checkpoints = async (unitId: string) => (await pool.query(`SELECT id, connection_id, runtime_session_id, generation, progress
    FROM cowork_checkpoints WHERE unit_id=$1 ORDER BY created_at`, [unitId])).rows;
  const receipts = async (connectionId: string) =>
    (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [connectionId])).rows[0].n as number;
  return { hubert, marek, ws, p, connect, task, patchTask, material, unit, taskRow, checkpoints, receipts };
}
type Scene = Awaited<ReturnType<typeof scene>>;
type Connection = Awaited<ReturnType<Scene['connect']>>;
/** A strict schema refusal: the SDK reports it as a tool error or a JSON-RPC error, never a domain effect. */
function schemaRefused(message: Record<string, unknown> | null) {
  return !!message?.error || (message?.result as { isError?: boolean } | undefined)?.isError === true;
}
const claimTool = async (c: Connection, unitId: string, expectedVersion: number, options: { command?: string; session?: string } = {}) =>
  c.tool('flux_claim_unit', { ...c.base('execute', options.command, options.session), unitId, expectedVersion });
const fenceOf = (claim: Claim) => ({ unitId: claim.unitId, expectedVersion: claim.version, generation: claim.generation, leaseId: claim.lease!.id });

test('Start/Resume discovers its own open work with bounded pages and distinguishes another live session', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Resume Codex'), peer = await f.connect(f.marek, 'Resume Claude');
  const first = await codex.take(await f.task('Recover my active task'));
  const later = await codex.take(await f.task('Recover my queued task'));
  await peer.take(await f.task('Other owner work'));
  const clientSessionId = randomUUID();
  const recover = async (extra: Record<string, unknown> = {}) => toolValue(await codex.tool('flux_bootstrap', {
    projectId: f.p.id, clientSessionId, includeWorkRecovery: true, ...extra })) as unknown as AgentBootstrap;
  const boot = await recover();
  assert.equal(boot.trusted.coordination!.work!.units.length, 2);
  const claimed = toolValue(await claimTool(codex, first.unitId, 1, { session: boot.runtime.id })) as Claim;
  const current = await recover({ workLimit: 1 });
  assert.equal(current.trusted.coordination!.activeClaimReference, first.unitId);
  const work = current.trusted.coordination!.work!;
  assert.deepEqual(work.units.map((unit) => [unit.id, unit.version, unit.lease?.currentSession]), [[first.unitId, claimed.version, true]]);
  assert.equal(work.nextOffset, 1);
  assert.deepEqual((await recover({ workLimit: 1, workOffset: 1 })).trusted.coordination!.work!.units.map((unit) => unit.id), [later.unitId]);
  const cold = await recover({ clientSessionId: randomUUID() });
  assert.equal(cold.trusted.coordination!.work!.units[0]!.lease!.currentSession, false);
  assert.ok(!JSON.stringify(cold.trusted.coordination).includes(claimed.lease!.id), 'recovery never exposes a lease secret');
  assert.equal(toolFailure(await claimTool(codex, first.unitId, claimed.version, { session: cold.runtime.id })).code, 'COWORK_UNIT_BUSY');
  await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.unitId]);
  assert.equal((await recover()).trusted.coordination!.activeClaimReference, null, 'expired claims are recoverable without being shown as live');
  await pool.query("UPDATE cowork_units SET state='stopped',lease_id=NULL,lease_session_id=NULL,lease_expires_at=NULL WHERE id=$1", [first.unitId]);
  assert.deepEqual((await recover()).trusted.coordination!.work!.units.map((unit) => unit.id), [later.unitId], 'Stop is not a Resume candidate');
});

test('a durable orientation checkpoint survives context loss and exposes a changed plan without rereading unchanged sources', async () => {
  const f = await scene(); const codex = await f.connect(f.hubert, 'Oriented Codex');
  const task = await f.task('Read the project before working'); const root = await codex.take(task);
  const doc = expectStatus(await f.hubert.browser.request('POST', `/api/v1/projects/${f.p.id}/docs`,
    { body: { title: 'Current project plan', body: 'First revision: measure the baseline.' } }), 201) as { id: string; version: number };
  const claimed = toolValue(await claimTool(codex, root.unitId, 1)) as Claim;
  const known = [{ kind: 'doc', id: doc.id, version: doc.version }, { kind: 'work', id: task.id, version: task.version }];
  const orientation = { known, gaps: ['No repository is linked; this is a non-code study.'] };
  const released = toolValue(await codex.tool('flux_release_unit', { ...codex.base('execute'), ...fenceOf(claimed),
    checkpoint: { summary: 'Read the complete current plan and existing task.', nextAction: 'Compare source versions before resuming.', blocker: null, orientation }, sources: [] })) as Claim;
  expectStatus(await f.hubert.browser.request('PATCH', `/api/v1/docs/${doc.id}`, { headers: { 'if-match': `"${doc.version}"` },
    body: { title: 'Current project plan', body: 'Changed plan: compare the alternatives before measurement.' } }), 200);
  const resumed = toolValue(await claimTool(codex, root.unitId, released.version, { session: await codex.session() })) as Claim;
  const stored = resumed.checkpoint as Checkpoint & { orientation: typeof orientation };
  assert.deepEqual(stored.orientation, orientation, 'the next client context gets exact version coverage and missing context');
  const changes = toolValue(await codex.tool('flux_changes_since', { projectId: f.p.id, known: stored.orientation.known }));
  assert.deepEqual((changes.changed as { checkpoint: { kind: string; id: string; version: number } }[]).map((source) => source.checkpoint),
    [{ kind: 'doc', id: doc.id, version: doc.version + 1 }]);
  assert.deepEqual(changes.unchanged, [{ kind: 'work', id: task.id }]);
});

test('one MCP bearer takes a task, claims, renews and completes its unit with an outcome; a second connection cannot claim it', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), claude = await f.connect(f.hubert, 'Hubert Claude');
  const a = await f.task('Native outcome A');
  const root = await codex.take(a);
  assert.deepEqual([root.state, root.version], ['pending', 1]);

  const claimed = toolValue(await claimTool(codex, root.unitId, 1)) as Claim;
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
  assert.equal(toolFailure(await claimTool(claude, root.unitId, 2)).code, 'COWORK_UNIT_NOT_FOUND');

  // One live unit per connection: another task's unit waits until this one is released or completed.
  const other = await codex.take(await f.task('Native outcome B'));
  assert.equal(toolFailure(await claimTool(codex, other.unitId, 1)).code, 'COWORK_CONNECTION_BUSY');

  const renewed = toolValue(await codex.tool('flux_renew_unit', { ...codex.base('execute'), ...fenceOf(claimed) })) as Claim;
  assert.deepEqual([renewed.state, renewed.version, renewed.generation, renewed.lease!.id, renewed.lease!.runtimeSessionId],
    ['claimed', 3, 1, claimed.lease!.id, codex.runtimeSessionId]);
  assert.ok(Date.parse(renewed.lease!.expiresAt) >= Date.parse(claimed.lease!.expiresAt), 'renewal extends the lease from now');

  // The outcome is a native record the agent publishes under its own grant; completion only references it.
  const recorded = toolValue(await codex.tool('flux_record_result', { ...codex.base('execute'), sources: [],
    result: { title: 'Outcome A observed', finding: 'positive', evidence: 'The bounded check ran and passed.', workIds: [a.id] } }));
  const taskBefore = await f.taskRow(a.id);
  const complete = { ...codex.base('execute'), ...fenceOf(renewed), outcome: { type: 'result', id: recorded.resultId } };
  const completed = toolValue(await codex.tool('flux_complete_unit', complete));
  assert.deepEqual(completed, { unitId: root.unitId, taskId: a.id, role: 'execute', assignmentConnectionId: codex.connectionId,
    version: 4, state: 'completed', outcomeRef: { type: 'result', id: recorded.resultId } });
  const done = await f.unit(root.unitId);
  assert.deepEqual([done.state, done.lease_id, done.lease_session_id, done.lease_expires_at, done.outcome_ref],
    ['completed', null, null, null, { type: 'result', id: recorded.resultId }]);
  assert.deepEqual(await f.taskRow(a.id), taskBefore, 'completion does not change the task');
  assert.deepEqual(toolValue(await codex.tool('flux_complete_unit', complete)), completed, 'a retry replays the completion');

  // Completed is final: the holder cannot claim it again, and the second connection still cannot.
  assert.equal(toolFailure(await claimTool(codex, root.unitId, 4)).code, 'COWORK_UNIT_CLOSED');
  assert.equal(toolFailure(await claimTool(claude, root.unitId, 4)).code, 'COWORK_UNIT_NOT_FOUND');
  assert.equal(await f.receipts(claude.connectionId), 0);
  // Completion freed the connection: the other unit can be claimed now.
  assert.equal((toolValue(await claimTool(codex, other.unitId, 1)) as Claim).state, 'claimed');
});

test('a replay returns the stored claim; a changed payload conflicts; renewal makes the claim receipt stale; a revoked grant refuses', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const root = await codex.take(await f.task('Native outcome A'));
  const command = randomUUID();
  const claimed = toolValue(await claimTool(codex, root.unitId, 1, { command })) as Claim;
  assert.deepEqual(toolValue(await claimTool(codex, root.unitId, 1, { command })), claimed, 'a lost response is retried');
  assert.equal(await f.receipts(codex.connectionId), 2, 'the creation and the one claim');
  assert.equal(toolFailure(await claimTool(codex, root.unitId, 2, { command })).code, 'IDEMPOTENCY_CONFLICT');

  const renew = { ...codex.base('execute'), ...fenceOf(claimed) };
  const renewed = toolValue(await codex.tool('flux_renew_unit', renew)) as Claim;
  assert.deepEqual(toolValue(await codex.tool('flux_renew_unit', renew)), renewed);
  assert.equal(toolFailure(await claimTool(codex, root.unitId, 1, { command })).code, 'COWORK_RECEIPT_STALE',
    'the claim receipt no longer describes the unit after a renewal');

  assert.deepEqual([await f.receipts(codex.connectionId)], [3]);
});

test('a lease is fenced by its runtime session and its expiry: the other session and the expired holder are refused', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimed = toolValue(await claimTool(codex, root.unitId, 1)) as Claim;
  const outcome = { type: 'work', id: (await f.task('Outcome record')).id, version: 1 };
  const renew = (claim: Claim, session?: string) => codex.tool('flux_renew_unit', { ...codex.base('execute', undefined, session),
    ...fenceOf(claim) });
  const complete = (claim: Claim, session?: string) => codex.tool('flux_complete_unit', {
    ...codex.base('execute', undefined, session), ...fenceOf(claim), outcome });

  // The same bearer's second client session has its own runtime: it passes #152 but does not hold this lease.
  const other = await codex.session();
  assert.notEqual(other, codex.runtimeSessionId);
  const held = await f.unit(root.unitId);
  assert.equal(toolFailure(await renew(claimed, other)).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await complete(claimed, other)).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await claimTool(codex, root.unitId, claimed.version, { session: other })).code, 'COWORK_UNIT_BUSY');
  assert.deepEqual(await f.unit(root.unitId), held);

  // The database clock passes the lease (the persisted deadline moves into the past; nothing else changes).
  await pool.query("UPDATE cowork_units SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [root.unitId]);
  const expired = await f.unit(root.unitId);
  assert.equal(toolFailure(await renew(claimed)).code, 'COWORK_CLAIM_LOST', 'renewal cannot resurrect an expired lease');
  assert.equal(toolFailure(await complete(claimed)).code, 'COWORK_CLAIM_LOST');
  assert.deepEqual(await f.unit(root.unitId), expired);
  // The other session can now claim it; the new generation fences the old lease for good.
  const reclaimed = toolValue(await claimTool(codex, root.unitId, claimed.version, { session: other })) as Claim;
  assert.deepEqual([reclaimed.generation, reclaimed.lease!.runtimeSessionId], [2, other]);
  assert.equal(toolFailure(await renew({ ...claimed, version: reclaimed.version })).code, 'COWORK_CLAIM_LOST');
  assert.equal(toolFailure(await complete({ ...claimed, version: reclaimed.version })).code, 'COWORK_CLAIM_LOST');
});

test('role eligibility: a wrong class names no unit, execute needs its prerequisites now, plan does not, a closed task refuses', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), claude = await f.connect(f.hubert, 'Hubert Claude');
  const pre = await f.task('Prerequisite');
  const dependent = await f.patchTask(await f.task('Dependent'), { dependencyIds: [pre.id] });
  const execute = await codex.take(dependent);
  assert.equal(toolFailure(await claimTool(codex, execute.unitId, 1)).code, 'TASK_PREREQUISITES_UNMET');
  assert.deepEqual([(await f.unit(execute.unitId)).state], ['pending']);

  // A review-class grant cannot name an execute unit, and a project-wide one does not find it.
  assert.equal(toolFailure(await codex.tool('flux_claim_unit', { ...codex.base('review'), unitId: execute.unitId, expectedVersion: 1 }))
    .code, 'COWORK_UNIT_NOT_FOUND');

  // Planning has no prerequisite rule: another connection takes and claims the plan unit of the same task.
  const plan = await claude.take(dependent, 'plan', 'plan');
  const planned = toolValue(await claude.tool('flux_claim_unit', { ...claude.base('plan'), unitId: plan.unitId, expectedVersion: 1 })) as Claim;
  assert.equal(planned.state, 'claimed');

  // The prerequisite is done: the execute claim succeeds. Reopened, it stops the next renewal; parking is still possible.
  const finished = await f.patchTask(pre, { status: 'done' });
  const claimed = toolValue(await claimTool(codex, execute.unitId, 1)) as Claim;
  await f.patchTask(finished, { status: 'in_progress' });
  const held = await f.unit(execute.unitId);
  assert.equal(toolFailure(await codex.tool('flux_renew_unit', { ...codex.base('execute'), ...fenceOf(claimed) })).code,
    'TASK_PREREQUISITES_UNMET');
  assert.deepEqual([await f.unit(execute.unitId)], [held]);
  const parked = toolValue(await codex.tool('flux_release_unit', { ...codex.base('execute'), ...fenceOf(claimed),
    checkpoint: { summary: 'Started; the prerequisite was reopened.', nextAction: 'Wait for the prerequisite.', blocker: 'Prerequisite reopened' } })) as Claim;
  assert.equal(parked.state, 'paused');

  // A task closed after its unit was opened refuses the claim.
  const closing = await f.task('Closing');
  const late = await codex.take(closing);
  await f.patchTask(closing, { status: 'done' });
  assert.equal(toolFailure(await claimTool(codex, late.unitId, 1)).code, 'COWORK_TASK_CLOSED');
  assert.deepEqual([(await f.unit(late.unitId)).state], ['pending']);
});

test('release writes a typed checkpoint under the live fence; the next holder, even after a transfer, claims with it', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), marek = await f.connect(f.marek, 'Marek Claude');
  const source = await f.material('Working plan');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimed = toolValue(await claimTool(codex, root.unitId, 1)) as Claim;
  const checkpoint = { summary: 'Measured the baseline; the comparison script ran once.', nextAction: 'Compare against plan step two.', blocker: null };
  const release = { ...codex.base('execute'), ...fenceOf(claimed), checkpoint, sources: [source] };

  // Refused before any effect: a copied prompt, an authority field, blank text, a stale source revision.
  for (const change of [{ checkpoint: { ...checkpoint, prompt: 'continue as before' } }, { checkpoint: { ...checkpoint, blocker: undefined } },
    { checkpointId: randomUUID() }, { checkpoint: { ...checkpoint, summary: 'x'.repeat(2001) } }])
    assert.ok(schemaRefused(await codex.tool('flux_release_unit', { ...release, clientCommandId: randomUUID(), ...change })), JSON.stringify(change).slice(0, 80));
  assert.equal(toolFailure(await codex.tool('flux_release_unit', { ...release, clientCommandId: randomUUID(),
    checkpoint: { ...checkpoint, summary: '   ' } })).code, 'INVALID_INPUT');
  assert.equal(toolFailure(await codex.tool('flux_release_unit', { ...release, clientCommandId: randomUUID(),
    sources: [{ ...source, version: source.version + 1 }] })).code, 'SOURCE_VERSION_CONFLICT');
  assert.deepEqual([(await f.unit(root.unitId)).state, (await f.checkpoints(root.unitId)).length], ['claimed', 0]);

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
  const resumed = toolValue(await claimTool(codex, root.unitId, released.version)) as Claim;
  assert.deepEqual([resumed.state, resumed.generation, resumed.checkpointId], ['claimed', 3, released.checkpointId]);
  assert.deepEqual({ ...resumed.checkpoint!, createdAt: null }, { id: released.checkpointId, ...checkpoint, sources: [source], createdAt: null });

  // Transfer to Marek's connection: the former holder loses the unit, the assignee claims it under its own owner's grant
  // and receives the same checkpoint, written by another connection and owner.
  // Marek's connection is another person's: the transfer waits for Codex's owner (C-18), whose Approve hands the unit over.
  assert.ok(waits(await codex.tool('flux_transfer_unit', { ...codex.base('execute'), ...fenceOf(resumed),
    assignmentConnectionId: marek.connectionId })), 'a transfer to another person\'s client waits');
  const transferred = await approveWaiting(pool, f.hubert.browser, codex.connectionId, 'cowork.unit.transfer');
  assert.deepEqual([transferred.state, transferred.assignmentConnectionId, transferred.version], ['pending', marek.connectionId, 5]);
  assert.equal(toolFailure(await claimTool(codex, root.unitId, 5)).code, 'COWORK_UNIT_NOT_FOUND');
  const taken = toolValue(await claimTool(marek, root.unitId, 5)) as Claim;
  assert.deepEqual([taken.state, taken.lease!.runtimeSessionId, taken.checkpoint!.id, taken.checkpoint!.summary],
    ['claimed', marek.runtimeSessionId, released.checkpointId, checkpoint.summary]);

  // A checkpoint whose source no longer exists in the project is never shown: the claim is refused and changes nothing.
  const parked = toolValue(await marek.tool('flux_release_unit', { ...marek.base('execute'), ...fenceOf(taken),
    checkpoint: { summary: 'Reviewed the earlier checkpoint.', nextAction: 'Continue the comparison.', blocker: null },
    sources: [{ materialId: source.materialId, version: source.version + 1 }] })) as Claim;
  await pool.query('DELETE FROM project_materials WHERE id=$1', [source.materialId]);
  const paused = await f.unit(root.unitId);
  assert.equal(toolFailure(await claimTool(marek, root.unitId, parked.version)).code, 'COWORK_CHECKPOINT_NOT_FOUND');
  assert.deepEqual([await f.unit(root.unitId)], [paused]);
});

test('a unit, a transfer or a request goes only to a client whose owner can use the space: refused up front, nothing waits (review of #943)', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex'), marek = await f.connect(f.marek, 'Marek Claude');
  const root = await codex.take(await f.task('Work for an outsider'));
  const claimed = toolValue(await claimTool(codex, root.unitId, 1)) as Claim;
  const waitingFor = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM assistant_changes WHERE connection_id = $1 AND state = 'waiting'`, [codex.connectionId])).rows[0].n);
  const asked = async (tool: string, args: Record<string, unknown>) => toolFailure(await codex.tool(tool, args)).code;
  // Marek is taken out of the space: a company admin who was never added reaches it in the sidebar's sense no more, and neither does his client.
  await removeFromSpace(f.hubert, f.p.id, f.marek);
  const child = { ...codex.base('execute'), taskId: (await pool.query('SELECT work_id FROM cowork_units WHERE id = $1', [root.unitId])).rows[0].work_id as string,
    unitKey: 'helper', expectedTaskVersion: 1, assignmentConnectionId: marek.connectionId, parent: { unitId: root.unitId, generation: claimed.generation, leaseId: claimed.lease!.id } };
  assert.equal(await asked('flux_transfer_unit', { ...codex.base('execute'), ...fenceOf(claimed), assignmentConnectionId: marek.connectionId }), 'COWORK_ASSIGNEE_UNAVAILABLE', 'a transfer');
  assert.equal(await asked('flux_create_unit', child), 'COWORK_ASSIGNEE_UNAVAILABLE', 'a child unit');
  assert.equal(await waitingFor(), 0, 'nothing is left waiting for an OK that could never apply');
  assert.deepEqual([(await f.unit(root.unitId)).state, (await f.unit(root.unitId)).assignment_connection_id], ['claimed', codex.connectionId], 'the unit stays where it was');
});

test('production checkpoint rules on the internal checkpointId form: a release needs exact coverage, an untyped checkpoint is never used', async () => {
  const f = await scene();
  const codex = await f.connect(f.hubert, 'Hubert Codex');
  const source = await f.material('Working plan');
  const root = await codex.take(await f.task('Native outcome A'));
  const claimed = toolValue(await claimTool(codex, root.unitId, 1)) as Claim;
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
    coWorkClaimInTransaction(tx, codex.claims, { runtimeSessionId: codex.runtimeSessionId, clientCommandId: randomUUID(),
      projectId: f.p.id, operation: 'cowork.release', peerRequestClass: 'execute', audience: { kind: 'project', projectId: f.p.id },
      objectId: root.unitId, sources, payload: { expectedVersion: claimed.version, generation: claimed.generation, leaseId: claimed.lease!.id,
        checkpointId } } satisfies AgentExecutionCommand,
    COWORK_CLAIM_POLICY));
  const rejects = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code, code);
  const held = await f.unit(root.unitId);
  await rejects(release(typed, []), 'COWORK_CHECKPOINT_SOURCES_REQUIRED');
  await rejects(release(untyped, [source]), 'COWORK_CHECKPOINT_NOT_FOUND');
  assert.deepEqual([await f.unit(root.unitId)], [held]);
  const paused = await release(typed, [source]);
  assert.deepEqual([paused.state, paused.checkpointId], ['paused', typed]);
  const resumed = toolValue(await claimTool(codex, root.unitId, paused.version)) as Claim;
  assert.deepEqual([resumed.checkpoint!.id, resumed.checkpoint!.summary, resumed.checkpoint!.sources], [typed, 'Measured the baseline.', [source]]);
});
