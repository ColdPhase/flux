import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentStandingGrant, CoWorkRequestLimits, Project, WorkItem } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { coWorkRootRunId, DomainError, type CoWorkUnitPolicy } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { coWorkClaimInTransaction, type CoWorkClaimPolicy } from '../../apps/server/src/co-work/claims.js';
import { coWorkTaskGraphLocks } from '../../apps/server/src/co-work/graph.js';
import { coWorkRequestInTransaction, type CoWorkRequestPolicy } from '../../apps/server/src/co-work/requests.js';
import { coWorkRequestResponseInTransaction } from '../../apps/server/src/co-work/responses.js';
import { coWorkUnitCreateInTransaction } from '../../apps/server/src/co-work/units.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';

// Authorized co-work unit creation (#153) over real #152 runtimes/grants/ledger and PostgreSQL. Bearer bindings are
// trusted fixtures; no unit is inserted directly. Not a public tool or client evidence.
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const UNITS: CoWorkUnitPolicy = { maximumRunUnits: 4, reviewSeparation: 'distinct_connection' };
const CLAIMS: CoWorkClaimPolicy = { maximumConnectionUnits: 1, leaseSeconds: 120,
  prepareTaskLocks: (tx, context, units) => coWorkTaskGraphLocks(tx, context.workspaceId, units),
  async requireEligible() {}, async requireCheckpointSources() {} };
const LIMITS: CoWorkRequestLimits = { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 };
const REQUESTS: CoWorkRequestPolicy = { limits: LIMITS, reviewSeparation: 'distinct_connection' };
type Role = 'execute' | 'review' | 'plan';

async function world() {
  const hubert = await person('cowork-units-hubert'), marek = await person('cowork-units-marek');
  const ws = await workspace(hubert, 'Unit creation workspace');
  // Marek authorizes his own connection's standing grants, which needs project management (#152).
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Shared outcome', 'restricted');
  const other = await project(hubert, ws.id, 'Other project', 'restricted');
  for (const id of [p.id, other.id]) await grant(hubert, id, marek, 'contributor');
  const task = async (title: string, inProject: Project = p) =>
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${inProject.id}/work`, { body: { title } }), 201) as WorkItem;
  /** A connection row only: the assignee side never needs a bearer. */
  const connection = async (who: Person, name: string, options: { projects?: string[]; scopes?: string[]; space?: string } = {}) => {
    const space = options.space ?? ws.id, projects = options.projects ?? [p.id];
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${space}/agents`,
      { body: { name, owner: 'self' } }), 201) as Agent;
    for (const id of projects) expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    return expectStatus(await who.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: agent.id, selectedProjectIds: projects, scopes: options.scopes ?? ['flux.context.read', 'flux.action.execute'] } }),
    201) as AgentConnection;
  };
  /** A connection with a trusted OAuth binding and a live runtime session. */
  const connect = async (who: Person, name: string) => {
    const created = await connection(who, name);
    const clientId = `cowork-units-${randomUUID()}`, bindingId = randomUUID();
    await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
      [randomUUID(), clientId, 'Trusted unit fixture', ['https://fixture.invalid/callback']]);
    await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)',
      [bindingId, who.id, created.id, clientId]);
    const claims = { ownerUserId: who.id, connectionId: created.id, clientId, grantReferenceId: `flux-grant:${bindingId}`, scopes: created.scopes };
    const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, randomUUID()));
    return { who, connection: created, claims, runtimeId: runtime.id };
  };
  const actionGrant = async (who: Person, connectionId: string, operation: string, objectId: string | null, role: Role, projectId = p.id) =>
    who.browser.request('POST', `/api/v1/agent-connections/${connectionId}/action-grants`,
      { body: { clientCommandId: randomUUID(), projectId, operation, ...(objectId ? { objectId } : {}),
        peerRequestClass: role, maximumUses: 20, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
  const material = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Review criteria', body: 'Exact current revision' } }), 201) as { materialId: string };
  return { hubert, marek, ws, p, other, task, connection, connect, actionGrant, material };
}
type World = Awaited<ReturnType<typeof world>>;
type Connected = Awaited<ReturnType<World['connect']>>;

function command(w: World, c: Connected, operation: string, objectId: string, role: Role, grantId: string,
  payload: Record<string, unknown>, change: Partial<AgentExecutionCommand> = {}): AgentExecutionCommand {
  return { runtimeSessionId: c.runtimeId, grantId, clientCommandId: randomUUID(), projectId: w.p.id,
    operation: operation as AgentExecutionCommand['operation'], peerRequestClass: role, audience: { kind: 'project', projectId: w.p.id },
    objectId, sources: [], payload: payload as AgentExecutionCommand['payload'], ...change };
}
async function grantOf(w: World, c: Connected, operation: string, objectId: string | null, role: Role) {
  return expectStatus(await w.actionGrant(c.who, c.connection.id, operation, objectId, role), 201) as AgentStandingGrant;
}
function rejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code, code);
}
/** A creator bound to one task and class through its own owner's standing grant. */
async function creator(w: World, c: Connected, task: WorkItem, role: Role, options: { exact?: boolean; policy?: CoWorkUnitPolicy } = {}) {
  const g = await grantOf(w, c, 'cowork.unit.create', options.exact === false ? null : task.id, role);
  const cmd = (payload: Record<string, unknown>, change: Partial<AgentExecutionCommand> = {}) =>
    command(w, c, 'cowork.unit.create', task.id, role, g.id, payload, change);
  const root = (unitKey: string, change: Record<string, unknown> = {}) =>
    cmd({ unitKey, expectedTaskVersion: task.version, assignmentConnectionId: c.connection.id, parent: null, ...change });
  const run = (input: AgentExecutionCommand, policy = options.policy ?? UNITS) =>
    db.transaction((tx) => coWorkUnitCreateInTransaction(tx, c.claims, input, policy));
  return { grant: g, cmd, root, run };
}
/** A live claim on a unit through the real claim composition and the production graph provider. */
async function claimUnit(w: World, c: Connected, unitId: string, role: Role, expectedVersion = 1) {
  const g = await grantOf(w, c, 'cowork.claim', unitId, role);
  return db.transaction((tx) => coWorkClaimInTransaction(tx, c.claims,
    command(w, c, 'cowork.claim', unitId, role, g.id, { expectedVersion }), CLAIMS));
}
/** Everything a refused creation could have changed. */
async function effects(w: World, connections: readonly Connected[]) {
  const ids = connections.map((c) => c.connection.id);
  const units = (await pool.query(`SELECT id, work_id, lineage_work_id, run_id, unit_key, role, assignment_connection_id, state, version,
    generation FROM cowork_units WHERE workspace_id=$1 ORDER BY id`, [w.ws.id])).rows;
  const lineages = (await pool.query('SELECT count(*)::int AS n FROM cowork_request_lineages WHERE workspace_id=$1', [w.ws.id])).rows[0].n;
  const used = (await pool.query('SELECT COALESCE(sum(used),0)::int AS n FROM agent_standing_grants WHERE connection_id = ANY($1::uuid[])', [ids])).rows[0].n;
  const receipts = (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id = ANY($1::uuid[])', [ids])).rows[0].n;
  const tasks = (await pool.query(`SELECT id, version, status, owner_user_id, owner_agent_id, updated_at FROM project_work_items
    WHERE workspace_id=$1 ORDER BY id`, [w.ws.id])).rows;
  const slots = (await pool.query('SELECT connection_id FROM cowork_connection_slots WHERE workspace_id=$1 ORDER BY connection_id', [w.ws.id])).rows;
  return { units, lineages, used, receipts, tasks, slots };
}
/** The attempt starts only after the snapshot, so nothing it does can leak into `before`. */
async function refusedWithoutEffects(w: World, connections: readonly Connected[], attempt: () => Promise<unknown>, code: string) {
  const before = await effects(w, connections);
  await rejects(attempt(), code);
  assert.deepEqual(await effects(w, connections), before, `${code}: no unit, lineage, slot row, grant use, receipt or task change`);
}
/** Lock types the sessions blocked by `holder` are waiting on (row locks show as `transactionid`). */
async function waitingOn(holder: number) {
  return (await pool.query(`SELECT l.locktype FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND $1 = ANY(pg_blocking_pids(a.pid))`, [holder])).rows.map((x) => x.locktype as string);
}
async function unitRow(id: string) {
  return (await pool.query('SELECT * FROM cowork_units WHERE id=$1', [id])).rows[0];
}
async function receiptsOf(c: Connected, operation = 'cowork.unit.create') {
  return (await pool.query('SELECT postconditions, value FROM agent_command_receipts WHERE connection_id=$1 AND operation=$2 ORDER BY completed_at',
    [c.connection.id, operation])).rows;
}
async function usedOf(grantId: string) {
  return (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used as number;
}

/** Hubert's Codex opens task A's run, claims it and can create its peers' units in that run. */
async function setup() {
  const w = await world();
  const a = await w.task('Native outcome A');
  const codex = await w.connect(w.hubert, 'Hubert Codex'), marekClaude = await w.connect(w.marek, 'Marek Claude');
  const execute = await creator(w, codex, a, 'execute');
  const root = await execute.run(execute.root('take-a'));
  const claim = await claimUnit(w, codex, root.unitId, 'execute');
  const fence = { unitId: root.unitId, generation: claim.generation, leaseId: claim.lease!.id };
  const review = await creator(w, codex, a, 'review');
  const child = (unitKey: string, assignmentConnectionId: string, change: Record<string, unknown> = {}) =>
    review.cmd({ unitKey, expectedTaskVersion: a.version, assignmentConnectionId, parent: fence, ...change });
  return { w, a, codex, marekClaude, execute, root, claim, fence, review, child };
}

test('a root unit opens its own run for its own assignee; exact replay observes, a re-issued intent returns it, changes go stale', async () => {
  const w = await world();
  const a = await w.task('Native outcome A');
  const codex = await w.connect(w.hubert, 'Hubert Codex');
  const before = await effects(w, [codex]);
  const execute = await creator(w, codex, a, 'execute');
  const first = execute.root('take-a');
  const created = await execute.run(first);
  const runId = coWorkRootRunId(codex.connection.id, a.id, 'take-a');
  assert.deepEqual({ ...created, unitId: undefined }, { status: 'created', unitId: undefined, taskId: a.id, lineageTaskId: a.id, runId,
    role: 'execute', assignmentConnectionId: codex.connection.id, version: 1, state: 'pending' });
  const row = await unitRow(created.unitId);
  assert.deepEqual([row.work_id, row.lineage_work_id, row.run_id, row.unit_key, row.role, row.assignment_connection_id, row.state, row.generation,
    row.version, row.lease_id, row.checkpoint_id], [a.id, a.id, runId, 'take-a', 'execute', codex.connection.id, 'pending', 0, 1, null, null]);
  // One debit and one receipt with the canonical post-state; nothing else changes.
  assert.equal(await usedOf(execute.grant.id), 1);
  assert.deepEqual((await receiptsOf(codex)).map((x) => x.postconditions), [[{ kind: 'cowork.unit_state', workspaceId: w.ws.id,
    projectId: w.p.id, unitId: created.unitId, taskId: a.id, lineageTaskId: a.id, runId, role: 'execute',
    assignmentConnectionId: codex.connection.id, version: 1, state: 'pending' }]]);
  const after = await effects(w, [codex]);
  assert.deepEqual(after.tasks, before.tasks, 'creation never changes the task row, its status or its human assignee');
  assert.equal(after.lineages, 0, 'creation opens no request lineage');

  // Exact replay is an observation: no second unit, debit or receipt. A changed payload under that ID conflicts.
  assert.deepEqual(await execute.run(first), created);
  assert.equal(await usedOf(execute.grant.id), 1);
  assert.equal((await receiptsOf(codex)).length, 1);
  await rejects(execute.run({ ...first, payload: { ...(first.payload as object), unitKey: 'take-a-2' } }), 'IDEMPOTENCY_CONFLICT');
  // The same intent under a new command ID meets the same run and unit: `existing`, one more grant use, no new row.
  const again = await execute.run(execute.root('take-a'));
  assert.deepEqual(again, { ...created, status: 'existing' });
  assert.equal(await usedOf(execute.grant.id), 2);
  assert.equal((await effects(w, [codex])).units.length, 1);
  // The same intent key for another role is a conflict, not a second unit in that run.
  const plan = await creator(w, codex, a, 'plan');
  await refusedWithoutEffects(w, [codex], () => plan.run(plan.root('take-a')), 'COWORK_UNIT_CONFLICT');

  // The created unit is claimable through the ordinary claim command; the creation receipt then goes stale.
  const claim = await claimUnit(w, codex, created.unitId, 'execute');
  assert.equal(claim.state, 'claimed');
  await rejects(execute.run(first), 'COMMAND_POSTSTATE_STALE');
  // A re-issue observed in the claimed state records that version; a renewal keeps the state name but changes the
  // version, so that receipt goes stale too.
  const reissue = execute.root('take-a');
  const observed = await execute.run(reissue);
  assert.deepEqual([observed.status, observed.unitId, observed.version, observed.state], ['existing', created.unitId, 2, 'claimed']);
  assert.deepEqual(await execute.run(reissue), observed, 'an unchanged unit can still be observed');
  const renewGrant = await grantOf(w, codex, 'cowork.renew', created.unitId, 'execute');
  const renewed = await db.transaction((tx) => coWorkClaimInTransaction(tx, codex.claims, command(w, codex, 'cowork.renew', created.unitId,
    'execute', renewGrant.id, { expectedVersion: 2, generation: claim.generation, leaseId: claim.lease!.id }), CLAIMS));
  assert.deepEqual([renewed.state, renewed.version], ['claimed', 3]);
  await rejects(execute.run(reissue), 'COMMAND_POSTSTATE_STALE');
  // A grant revoked after creation also refuses observation.
  expectStatus(await w.hubert.browser.request('DELETE', `/api/v1/agent-connections/${codex.connection.id}/action-grants/${execute.grant.id}`), 204);
  await rejects(execute.run(first), 'AGENT_EXECUTION_UNAVAILABLE');
});

test('a child unit inherits the run; its peer claims it with its own grant and the request lifecycle runs on production units', async () => {
  const f = await setup();
  const { w } = f;
  const created = await f.review.run(f.child('review-a', f.marekClaude.connection.id));
  assert.deepEqual({ ...created, unitId: undefined }, { status: 'created', unitId: undefined, taskId: f.a.id, lineageTaskId: f.a.id,
    runId: f.root.runId, role: 'review', assignmentConnectionId: f.marekClaude.connection.id, version: 1, state: 'pending' });
  assert.deepEqual((await receiptsOf(f.codex)).at(-1)!.postconditions[0].assignmentConnectionId, f.marekClaude.connection.id);
  // The parent's claim is untouched: creating does not renew, release or version it.
  const parent = await unitRow(f.root.unitId);
  assert.deepEqual([parent.state, parent.generation, parent.version, parent.lease_id], ['claimed', f.claim.generation, f.claim.version, f.claim.lease!.id]);

  // The creator's grant authorizes nothing for either party: the author cannot claim the reviewer's unit, and the
  // reviewer needs its own owner's review claim grant.
  expectStatus(await w.actionGrant(w.hubert, f.codex.connection.id, 'cowork.claim', created.unitId, 'review'), 404);
  const broad = await grantOf(w, f.codex, 'cowork.claim', null, 'review');
  await rejects(db.transaction((tx) => coWorkClaimInTransaction(tx, f.codex.claims,
    command(w, f.codex, 'cowork.claim', created.unitId, 'review', broad.id, { expectedVersion: 1 }), CLAIMS)), 'COWORK_UNIT_NOT_FOUND');
  const marekClaim = await claimUnit(w, f.marekClaude, created.unitId, 'review');
  assert.equal(marekClaim.state, 'claimed');

  // The author's review request is admitted to the created unit and the reviewer claims it.
  const requestGrant = await grantOf(w, f.codex, 'cowork.request', f.root.unitId, 'execute');
  const asked = await db.transaction((tx) => coWorkRequestInTransaction(tx, f.codex.claims, command(w, f.codex, 'cowork.request', f.root.unitId,
    'execute', requestGrant.id, { generation: f.claim.generation, leaseId: f.claim.lease!.id, request: { unitId: created.unitId,
      expectedUnitVersion: 2, recipientConnectionId: f.marekClaude.connection.id, intentKey: 'review-a-1', parentRequestId: null, kind: 'review',
      target: { type: 'work', id: f.a.id, version: f.a.version }, sourceRefs: [{ type: 'material', id: w.material.materialId, version: 1 }],
      criteriaRefs: [{ type: 'work', id: f.a.id, version: f.a.version }], priority: 1, peerUnblocking: true, lifetimeSeconds: 3600 } }), REQUESTS));
  assert.equal(asked.status, 'created');
  const takeGrant = await grantOf(w, f.marekClaude, 'cowork.request.claim', created.unitId, 'review');
  const taken = await db.transaction((tx) => coWorkRequestResponseInTransaction(tx, f.marekClaude.claims,
    command(w, f.marekClaude, 'cowork.request.claim', created.unitId, 'review', takeGrant.id, { generation: marekClaim.generation,
      leaseId: marekClaim.lease!.id, requestId: asked.requestId, expectedRequestVersion: 1 }),
    { async publishResponse() { throw new Error('No publication on a claim'); } }));
  assert.equal(taken.state, 'claimed');

  // A second child for another connection in the same run, and a plan unit for the author itself, are allowed.
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  assert.equal((await f.review.run(f.child('review-a-2', claude.connection.id))).runId, f.root.runId);
  const plan = await creator(w, f.codex, f.a, 'plan');
  const own = await plan.run(plan.cmd({ unitKey: 'plan-a', expectedTaskVersion: f.a.version, assignmentConnectionId: f.codex.connection.id, parent: f.fence }));
  assert.equal(own.runId, f.root.runId);
});

test('root negative controls: assignment, task fence, taken role, payload, grant and target refuse without effects', async () => {
  const w = await world();
  const a = await w.task('Native outcome A');
  const codex = await w.connect(w.hubert, 'Hubert Codex'), claude = await w.connect(w.hubert, 'Hubert Claude');
  const marekClaude = await w.connect(w.marek, 'Marek Claude');
  const all = [codex, claude, marekClaude];
  const execute = await creator(w, codex, a, 'execute');
  const refuse = (input: AgentExecutionCommand, code: string, run = execute.run) => refusedWithoutEffects(w, all, () => run(input), code);
  // Only a run's own assignee opens it.
  await refuse(execute.root('take-a', { assignmentConnectionId: marekClaude.connection.id }), 'COWORK_ASSIGNMENT_REFUSED');
  // Exact task version; closed tasks.
  await refuse(execute.root('take-a', { expectedTaskVersion: a.version + 1 }), 'COWORK_VERSION_CONFLICT');
  for (const status of ['done', 'not_pursued'] as const) {
    const closed = await w.task(`Closed ${status}`);
    const edited = expectStatus(await w.hubert.browser.request('PATCH', `/api/v1/work/${closed.id}`,
      { body: { status }, headers: { 'if-match': `"${closed.version}"` } }), 200) as WorkItem;
    const onClosed = await creator(w, codex, edited, 'execute');
    await refuse(onClosed.root('take-closed'), 'COWORK_TASK_CLOSED', onClosed.run);
  }
  // Payload shape.
  for (const payload of [
    { unitKey: 'x', expectedTaskVersion: a.version, assignmentConnectionId: codex.connection.id, parent: null, prompt: 'take it' },
    { unitKey: 'x', expectedTaskVersion: a.version, assignmentConnectionId: codex.connection.id },
    { unitKey: 'has space', expectedTaskVersion: a.version, assignmentConnectionId: codex.connection.id, parent: null },
    { unitKey: 'x', expectedTaskVersion: a.version, assignmentConnectionId: codex.connection.id, parent: 'root' },
    { unitKey: 'x', expectedTaskVersion: a.version, assignmentConnectionId: codex.connection.id, parent: null, runId: randomUUID() },
    { unitKey: 'x', expectedTaskVersion: 0, assignmentConnectionId: codex.connection.id, parent: null },
  ]) await refuse(execute.cmd(payload), 'INVALID_INPUT');
  // Grants: another operation's grant, an exact grant for another task, another project's task.
  const claimGrant = await grantOf(w, codex, 'cowork.claim', null, 'execute');
  await refuse({ ...execute.root('take-a'), grantId: claimGrant.id }, 'AGENT_EXECUTION_UNAVAILABLE');
  const b = await w.task('Native outcome B');
  await refuse(command(w, codex, 'cowork.unit.create', b.id, 'execute', execute.grant.id, { unitKey: 'take-b', expectedTaskVersion: b.version,
    assignmentConnectionId: codex.connection.id, parent: null }), 'AGENT_EXECUTION_UNAVAILABLE');
  const foreign = await w.task('Elsewhere', w.other);
  const anyTask = await creator(w, codex, a, 'execute', { exact: false });
  await refuse(command(w, codex, 'cowork.unit.create', foreign.id, 'execute', anyTask.grant.id, { unitKey: 'take-foreign',
    expectedTaskVersion: foreign.version, assignmentConnectionId: codex.connection.id, parent: null }), 'OBJECT_NOT_FOUND', anyTask.run);
  expectStatus(await w.actionGrant(w.hubert, codex.connection.id, 'cowork.unit.create', foreign.id, 'execute'), 404,
    'an exact target must be a task of the grant project');
  // A unit is not a task target.
  const created = await execute.run(execute.root('take-a'));
  expectStatus(await w.actionGrant(w.hubert, codex.connection.id, 'cowork.unit.create', created.unitId, 'execute'), 404);

  // One open unit of a role per task: another connection, or the same one under another intent key, is refused.
  const claudeExecute = await creator(w, claude, a, 'execute');
  await refuse(claudeExecute.root('take-a'), 'COWORK_UNIT_TAKEN', claudeExecute.run);
  await refuse(execute.root('take-a-again'), 'COWORK_UNIT_TAKEN');
  // A paused unit still holds the task; a different role does not conflict.
  await pool.query("UPDATE cowork_units SET state='paused' WHERE id=$1", [created.unitId]);
  await refuse(claudeExecute.root('take-a'), 'COWORK_UNIT_TAKEN', claudeExecute.run);
  const claudePlan = await creator(w, claude, a, 'plan');
  assert.equal((await claudePlan.run(claudePlan.root('plan-a'))).status, 'created');
  // The sole plan writer: a second plan root on the task is refused.
  const codexPlan = await creator(w, codex, a, 'plan');
  await refuse(codexPlan.root('plan-a'), 'COWORK_UNIT_TAKEN', codexPlan.run);
  // Once the earlier unit is stopped (its connection revoked), another connection can open a new run.
  expectStatus(await w.hubert.browser.request('DELETE', `/api/v1/agent-connections/${codex.connection.id}`), 204);
  assert.equal((await unitRow(created.unitId)).state, 'stopped');
  const opened = await claudeExecute.run(claudeExecute.root('take-a'));
  assert.equal(opened.status, 'created'); assert.notEqual(opened.runId, created.runId);
});

test('child negative controls: parent fence, assignee, separation and the run cap refuse without effects', async () => {
  const f = await setup();
  const { w } = f;
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  const all = [f.codex, f.marekClaude, claude];
  const refuse = (input: AgentExecutionCommand, code: string, policy = UNITS) =>
    refusedWithoutEffects(w, all, () => f.review.run(input, policy), code);
  const marek = f.marekClaude.connection.id;
  // Parent: unknown, another connection's unit, another task's unit, another project's unit.
  await refuse(f.child('r', marek, { parent: { ...f.fence, unitId: randomUUID() } }), 'COWORK_UNIT_NOT_FOUND');
  const marekUnit = await f.review.run(f.child('marek-review', marek));
  await refuse(f.child('r', marek, { parent: { ...f.fence, unitId: marekUnit.unitId } }), 'COWORK_UNIT_NOT_FOUND');
  const b = await w.task('Native outcome B');
  const onB = await creator(w, f.codex, b, 'plan');
  const bUnit = await onB.run(onB.root('plan-b'));
  await refuse(f.child('r', marek, { parent: { ...f.fence, unitId: bUnit.unitId } }), 'COWORK_UNIT_NOT_FOUND');
  // Parent claim fence: wrong lease, wrong generation, another runtime session, an expired lease, an unclaimed parent.
  await refuse(f.child('r', marek, { parent: { ...f.fence, leaseId: randomUUID() } }), 'COWORK_CLAIM_LOST');
  await refuse(f.child('r', marek, { parent: { ...f.fence, generation: f.fence.generation + 1 } }), 'COWORK_CLAIM_LOST');
  const other = await db.transaction((tx) => agentRuntimeInTransaction(tx, f.codex.claims, randomUUID()));
  await refuse({ ...f.child('r', marek), runtimeSessionId: other.runtime.id }, 'COWORK_CLAIM_LOST');
  // An own, unclaimed unit on the same task is not a live parent.
  const plan = await creator(w, f.codex, f.a, 'plan');
  const idle = await plan.run(plan.cmd({ unitKey: 'plan-a', expectedTaskVersion: f.a.version, assignmentConnectionId: f.codex.connection.id,
    parent: f.fence }));
  await refuse(f.child('r', marek, { parent: { unitId: idle.unitId, generation: 1, leaseId: randomUUID() } }), 'COWORK_CLAIM_LOST');
  await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.root.unitId]);
  await refuse(f.child('r', marek), 'COWORK_CLAIM_LOST');
  await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=$1", [f.root.unitId]);
  // Assignee: unknown, revoked, another workspace, project not selected, no execute scope — one content-free outcome.
  const revoked = await w.connection(w.marek, 'Marek revoked');
  expectStatus(await w.marek.browser.request('DELETE', `/api/v1/agent-connections/${revoked.id}`), 204);
  const elsewhere = await workspace(w.hubert, 'Another workspace');
  const away = await project(w.hubert, elsewhere.id, 'Away', 'restricted');
  const foreign = await w.connection(w.hubert, 'Hubert elsewhere', { space: elsewhere.id, projects: [away.id] });
  const unselected = await w.connection(w.marek, 'Marek other project', { projects: [w.other.id] });
  const readOnly = await w.connection(w.marek, 'Marek read only', { scopes: ['flux.context.read'] });
  for (const id of [randomUUID(), revoked.id, foreign.id, unselected.id, readOnly.id])
    await refuse(f.child('r', id), 'COWORK_ASSIGNEE_UNAVAILABLE');
  // Separation: the author cannot review its own run; a reviewer cannot become an executor of it.
  await refuse(f.child('r', f.codex.connection.id), 'COWORK_REVIEW_SEPARATION');
  const executeChild = await creator(w, f.codex, f.a, 'execute');
  await refuse(executeChild.cmd({ unitKey: 'e', expectedTaskVersion: f.a.version, assignmentConnectionId: marek, parent: f.fence }),
    'COWORK_REVIEW_SEPARATION');
  // A stricter project policy also refuses another connection of the author's owner; the default allows it.
  await refuse(f.child('claude-review', claude.connection.id), 'COWORK_REVIEW_SEPARATION', { ...UNITS, reviewSeparation: 'distinct_owner' });
  assert.equal((await f.review.run(f.child('claude-review', claude.connection.id))).status, 'created');
  // Intent key: the same key for another assignee is a conflict.
  await refuse(f.child('claude-review', marek), 'COWORK_UNIT_CONFLICT');
  // Run cap (4 here: the root, Marek's review, the idle plan unit and Claude's review).
  assert.equal((await effects(w, all)).units.filter((unit) => unit.run_id === f.root.runId).length, 4);
  await refuse(f.child('fifth', claude.connection.id), 'COWORK_BUDGET_EXHAUSTED');
  // A re-issued existing intent is still returned at the cap: it creates nothing.
  assert.equal((await f.review.run(f.child('claude-review', claude.connection.id))).status, 'existing');
});

test('race: two connections open a root on one task at once; the later waits and is refused without effects', async () => {
  const w = await world();
  const a = await w.task('Native outcome A');
  const codex = await w.connect(w.hubert, 'Hubert Codex'), claude = await w.connect(w.hubert, 'Hubert Claude');
  const first = await creator(w, codex, a, 'execute'), second = await creator(w, claude, a, 'execute');
  const ready = barrier<number>(), release = barrier();
  const holding = db.transaction(async (tx) => {
    const outcome = await coWorkUnitCreateInTransaction(tx, codex.claims, first.root('take-a'), UNITS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  holding.catch(() => ready.resolve(-1));
  const holder = await ready.promise; assert.ok(holder > 0);
  const before = await effects(w, [claude]);
  const later = second.run(second.root('take-a'));
  later.catch(() => undefined);
  const done = settled(later);
  await waitUntilBlockedBy(pool, holder);
  assert.equal(done(), false, 'the later creation waits for the first to commit or roll back');
  assert.deepEqual(await waitingOn(holder), ['advisory'], 'it waits on the project task graph lock, before any task or unit row');
  release.resolve();
  assert.equal((await holding).status, 'created');
  await rejects(later, 'COWORK_UNIT_TAKEN');
  const after = await effects(w, [claude]);
  assert.equal(after.used, before.used, 'the loser debited nothing'); assert.equal(after.receipts, before.receipts);
  assert.equal(after.units.filter((unit) => unit.work_id === a.id).length, 1, 'exactly one unit on the task');
});

test('race: the same intent issued twice at once creates one unit; the other command observes it as existing', async () => {
  const w = await world();
  const a = await w.task('Native outcome A');
  const codex = await w.connect(w.hubert, 'Hubert Codex');
  const execute = await creator(w, codex, a, 'execute');
  const ready = barrier<number>(), release = barrier();
  const holding = db.transaction(async (tx) => {
    const outcome = await coWorkUnitCreateInTransaction(tx, codex.claims, execute.root('take-a'), UNITS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  holding.catch(() => ready.resolve(-1));
  const holder = await ready.promise; assert.ok(holder > 0);
  const twin = execute.run(execute.root('take-a'));
  twin.catch(() => undefined);
  await waitUntilBlockedBy(pool, holder);
  release.resolve();
  const [one, two] = [await holding, await twin];
  assert.equal(one.status, 'created'); assert.deepEqual(two, { ...one, status: 'existing' });
  assert.equal((await effects(w, [codex])).units.length, 1);
  assert.equal(await usedOf(execute.grant.id), 2, 'each command spends one use');
  assert.equal((await receiptsOf(codex)).length, 2);
});

test('race: an assignee revocation that commits first refuses the creation; one that waits stops the new unit', async () => {
  const f = await setup();
  const { w } = f;
  // Revocation first: it holds the assignee row; the creation waits on it and then sees the revoked connection.
  const reviewer = await w.connect(w.marek, 'Marek reviewer');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE agent_connections SET revoked_at=now() WHERE id=$1', [reviewer.connection.id]);
    const holder = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const before = await effects(w, [f.codex, reviewer]);
    const attempt = f.review.run(f.child('to-revoked', reviewer.connection.id));
    attempt.catch(() => undefined);
    await waitUntilBlockedBy(pool, holder);
    assert.deepEqual(await waitingOn(holder), ['transactionid'], 'the creation waits on the assignee connection row');
    await client.query('COMMIT');
    await rejects(attempt, 'COWORK_ASSIGNEE_UNAVAILABLE');
    assert.deepEqual(await effects(w, [f.codex, reviewer]), before, 'nothing persisted');
  } finally { client.release(); }

  // Creation first: the revocation waits for its commit, then its trigger stops the new pending unit.
  const ready = barrier<number>(), release = barrier();
  const holding = db.transaction(async (tx) => {
    const outcome = await coWorkUnitCreateInTransaction(tx, f.codex.claims, f.child('to-marek', f.marekClaude.connection.id), UNITS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  holding.catch(() => ready.resolve(-1));
  const holder = await ready.promise; assert.ok(holder > 0);
  const revocation = pool.query('UPDATE agent_connections SET revoked_at=now() WHERE id=$1', [f.marekClaude.connection.id]);
  const done = settled(revocation);
  await waitUntilBlockedBy(pool, holder);
  assert.equal(done(), false, 'the revocation waits for the creation');
  release.resolve();
  const created = await holding;
  await revocation;
  const row = await unitRow(created.unitId);
  assert.deepEqual([row.state, row.generation, row.version], ['stopped', 1, 2], 'no pending unit survives for a revoked assignee');
});
