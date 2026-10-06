import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentStandingGrant, CoWorkRequestLimits, Project, WorkItem,
  WorkResult } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { DomainError, type CoWorkUnitPolicy } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { coWorkClaimInTransaction, type CoWorkClaimPolicy } from '../../apps/server/src/co-work/claims.js';
import { coWorkTaskGraphLocks } from '../../apps/server/src/co-work/graph.js';
import { coWorkRequestInTransaction, type CoWorkRequestPolicy } from '../../apps/server/src/co-work/requests.js';
import { coWorkRequestResponseInTransaction } from '../../apps/server/src/co-work/responses.js';
import { coWorkUnitTransitionInTransaction, type CoWorkUnitTransitionPolicy } from '../../apps/server/src/co-work/transitions.js';
import { coWorkUnitCreateInTransaction } from '../../apps/server/src/co-work/units.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';

// The holder's unit completion and transfer (#153) over real #152 runtimes/grants/ledger and PostgreSQL. Units are
// created and claimed only through the production compositions. Bearer bindings are trusted fixtures. Not a public
// tool or client evidence.
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const TRANSITIONS: CoWorkUnitTransitionPolicy = { reviewSeparation: 'distinct_connection' };
const UNITS: CoWorkUnitPolicy = { maximumRunUnits: 8, reviewSeparation: 'distinct_connection' };
const CLAIMS: CoWorkClaimPolicy = { maximumConnectionUnits: 2, leaseSeconds: 120,
  prepareTaskLocks: (tx, context, units) => coWorkTaskGraphLocks(tx, context.workspaceId, units),
  async requireEligible() {}, async requireCheckpointSources() {} };
const LIMITS: CoWorkRequestLimits = { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 };
const REQUESTS: CoWorkRequestPolicy = { limits: LIMITS, reviewSeparation: 'distinct_connection' };
const NO_PUBLICATION = { async publishResponse(): Promise<never> { throw new Error('A claim or decline never publishes'); } };
type Role = 'execute' | 'review' | 'plan';

async function world() {
  const hubert = await person('cowork-transitions-hubert'), marek = await person('cowork-transitions-marek');
  const ws = await workspace(hubert, 'Unit transitions workspace');
  // Marek authorizes his own connection's standing grants, which needs project management (#152).
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Shared outcome', 'restricted');
  const other = await project(hubert, ws.id, 'Other project', 'restricted');
  for (const id of [p.id, other.id]) await grant(hubert, id, marek, 'contributor');
  const task = async (title: string, inProject: Project = p) =>
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${inProject.id}/work`, { body: { title } }), 201) as WorkItem;
  /** A connection row only: an assignee never needs a bearer to receive a unit. */
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
  const connect = async (who: Person, name: string, options: { projects?: string[] } = {}) => {
    const created = await connection(who, name, options);
    const clientId = `cowork-transitions-${randomUUID()}`, bindingId = randomUUID();
    await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
      [randomUUID(), clientId, 'Trusted transition fixture', ['https://fixture.invalid/callback']]);
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
  const result = async (title: string, inProject: Project = p) => expectStatus(await hubert.browser.request('POST',
    `/api/v1/projects/${inProject.id}/results`, { body: { title, finding: 'positive' } }), 201) as WorkResult;
  return { hubert, marek, ws, p, other, task, connection, connect, actionGrant, material, result };
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
/** A unit through the real creation composition. */
async function createUnit(w: World, c: Connected, task: WorkItem, role: Role, unitKey: string,
  options: { assignee?: string; parent?: { unitId: string; generation: number; leaseId: string } } = {}) {
  const g = await grantOf(w, c, 'cowork.unit.create', task.id, role);
  return db.transaction((tx) => coWorkUnitCreateInTransaction(tx, c.claims, command(w, c, 'cowork.unit.create', task.id, role, g.id,
    { unitKey, expectedTaskVersion: task.version, assignmentConnectionId: options.assignee ?? c.connection.id, parent: options.parent ?? null }), UNITS));
}
/** A live claim on a unit through the real claim composition and the production graph provider. */
async function claimUnit(w: World, c: Connected, unitId: string, role: Role, expectedVersion = 1) {
  const g = await grantOf(w, c, 'cowork.claim', unitId, role);
  return db.transaction((tx) => coWorkClaimInTransaction(tx, c.claims,
    command(w, c, 'cowork.claim', unitId, role, g.id, { expectedVersion }), CLAIMS));
}
type Claim = Awaited<ReturnType<typeof claimUnit>>;
/** The holder's live fence from its claim outcome. */
const fenceOf = (claim: Claim) => ({ expectedVersion: claim.version, generation: claim.generation, leaseId: claim.lease!.id });
/** Completion/transfer commands of one connection for one unit, each through its own owner's standing grant. */
async function holder(w: World, c: Connected, unitId: string, role: Role, options: { exact?: boolean } = {}) {
  const complete = await grantOf(w, c, 'cowork.unit.complete', options.exact === false ? null : unitId, role);
  const transfer = await grantOf(w, c, 'cowork.unit.transfer', options.exact === false ? null : unitId, role);
  return {
    complete, transfer,
    finish: (payload: Record<string, unknown>, change: Partial<AgentExecutionCommand> = {}) =>
      command(w, c, 'cowork.unit.complete', unitId, role, complete.id, payload, change),
    handOver: (payload: Record<string, unknown>, change: Partial<AgentExecutionCommand> = {}) =>
      command(w, c, 'cowork.unit.transfer', unitId, role, transfer.id, payload, change),
    run: (input: AgentExecutionCommand, policy = TRANSITIONS) =>
      db.transaction((tx) => coWorkUnitTransitionInTransaction(tx, c.claims, input, policy)),
  };
}
/** Everything a refused transition could have changed. */
async function effects(w: World, connections: readonly Connected[]) {
  const ids = connections.map((c) => c.connection.id);
  const units = (await pool.query(`SELECT id, work_id, lineage_work_id, run_id, unit_key, role, assignment_connection_id, state, version,
    generation, lease_id, lease_expires_at, checkpoint_id, outcome_ref FROM cowork_units WHERE workspace_id=$1 ORDER BY id`, [w.ws.id])).rows;
  const requests = (await pool.query('SELECT id, state, version, claimed_generation, reason, response_ref FROM cowork_requests WHERE workspace_id=$1 ORDER BY id',
    [w.ws.id])).rows;
  const used = (await pool.query('SELECT COALESCE(sum(used),0)::int AS n FROM agent_standing_grants WHERE connection_id = ANY($1::uuid[])', [ids])).rows[0].n;
  const receipts = (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id = ANY($1::uuid[])', [ids])).rows[0].n;
  const tasks = (await pool.query(`SELECT id, version, status, owner_user_id, owner_agent_id, updated_at FROM project_work_items
    WHERE workspace_id=$1 ORDER BY id`, [w.ws.id])).rows;
  const slots = (await pool.query('SELECT connection_id FROM cowork_connection_slots WHERE workspace_id=$1 ORDER BY connection_id', [w.ws.id])).rows;
  return { units, requests, used, receipts, tasks, slots };
}
/** The attempt starts only after the snapshot, so nothing it does can leak into `before`. */
async function refusedWithoutEffects(w: World, connections: readonly Connected[], attempt: () => Promise<unknown>, code: string) {
  const before = await effects(w, connections);
  await rejects(attempt(), code);
  assert.deepEqual(await effects(w, connections), before, `${code}: no unit, request, slot row, grant use, receipt or task change`);
}
/** Lock types the sessions blocked by `holder` are waiting on (row locks show as `transactionid`). */
async function waitingOn(holderPid: number) {
  return (await pool.query(`SELECT l.locktype FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND $1 = ANY(pg_blocking_pids(a.pid))`, [holderPid])).rows.map((x) => x.locktype as string);
}
async function unitRow(id: string) {
  return (await pool.query('SELECT * FROM cowork_units WHERE id=$1', [id])).rows[0];
}
async function receiptsOf(c: Connected, operation: string) {
  return (await pool.query('SELECT postconditions, value FROM agent_command_receipts WHERE connection_id=$1 AND operation=$2 ORDER BY completed_at',
    [c.connection.id, operation])).rows;
}
async function usedOf(grantId: string) {
  return (await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used as number;
}

/** Hubert's Codex takes task A (root execute unit) and holds its live claim. */
async function setup() {
  const w = await world();
  const a = await w.task('Native outcome A');
  const codex = await w.connect(w.hubert, 'Hubert Codex'), marekClaude = await w.connect(w.marek, 'Marek Claude');
  const root = await createUnit(w, codex, a, 'execute', 'take-a');
  const claim = await claimUnit(w, codex, root.unitId, 'execute');
  const own = await holder(w, codex, root.unitId, 'execute');
  return { w, a, codex, marekClaude, root, claim, fence: fenceOf(claim), own };
}
/** A review unit of the codex run assigned to Marek, claimed by Marek, plus the author's request helper. */
async function reviewScene() {
  const f = await setup();
  const { w } = f;
  const parent = { unitId: f.root.unitId, generation: f.claim.generation, leaseId: f.claim.lease!.id };
  const review = await createUnit(w, f.codex, f.a, 'review', 'review-a', { assignee: f.marekClaude.connection.id, parent });
  const reviewClaim = await claimUnit(w, f.marekClaude, review.unitId, 'review');
  const reviewer = await holder(w, f.marekClaude, review.unitId, 'review');
  const askGrant = await grantOf(w, f.codex, 'cowork.request', f.root.unitId, 'execute');
  const ask = (intentKey: string, lifetimeSeconds = 3600) => command(w, f.codex, 'cowork.request', f.root.unitId, 'execute', askGrant.id,
    { generation: f.claim.generation, leaseId: f.claim.lease!.id, request: { unitId: review.unitId, expectedUnitVersion: reviewClaim.version,
      recipientConnectionId: f.marekClaude.connection.id, intentKey, parentRequestId: null, kind: 'review',
      target: { type: 'work', id: f.a.id, version: f.a.version }, sourceRefs: [{ type: 'material', id: w.material.materialId, version: 1 }],
      criteriaRefs: [{ type: 'work', id: f.a.id, version: f.a.version }], priority: 1, peerUnblocking: true, lifetimeSeconds } });
  const admit = (input: AgentExecutionCommand) => db.transaction((tx) => coWorkRequestInTransaction(tx, f.codex.claims, input, REQUESTS));
  const takeGrant = await grantOf(w, f.marekClaude, 'cowork.request.claim', review.unitId, 'review');
  const respondGrant = await grantOf(w, f.marekClaude, 'cowork.request.respond', review.unitId, 'review');
  const live = { generation: reviewClaim.generation, leaseId: reviewClaim.lease!.id };
  const take = (requestId: string, expectedRequestVersion = 1) => db.transaction((tx) => coWorkRequestResponseInTransaction(tx,
    f.marekClaude.claims, command(w, f.marekClaude, 'cowork.request.claim', review.unitId, 'review', takeGrant.id,
      { ...live, requestId, expectedRequestVersion }), NO_PUBLICATION));
  const decline = (requestId: string, expectedRequestVersion = 2) => db.transaction((tx) => coWorkRequestResponseInTransaction(tx,
    f.marekClaude.claims, command(w, f.marekClaude, 'cowork.request.respond', review.unitId, 'review', respondGrant.id,
      { ...live, requestId, expectedRequestVersion, outcome: 'declined', reason: 'scope' }), NO_PUBLICATION));
  return { ...f, review, reviewClaim, reviewer, reviewFence: fenceOf(reviewClaim), ask, admit, take, decline };
}

test('the holder completes its claimed unit with an outcome: terminal, task untouched, replay observes, every later attempt is fenced', async () => {
  const f = await setup();
  const { w } = f;
  const result = await w.result('Measured baseline');
  const before = await effects(w, [f.codex]);
  const first = f.own.finish({ ...f.fence, outcome: { type: 'result', id: result.id } });
  const done = await f.own.run(first);
  assert.deepEqual(done, { unitId: f.root.unitId, taskId: f.a.id, role: 'execute', assignmentConnectionId: f.codex.connection.id,
    version: f.claim.version + 1, state: 'completed', outcomeRef: { type: 'result', id: result.id } });
  const row = await unitRow(f.root.unitId);
  assert.deepEqual([row.state, row.generation, row.version, row.lease_id, row.lease_session_id, row.lease_expires_at, row.checkpoint_id,
    row.outcome_ref, row.assignment_connection_id, row.run_id], ['completed', f.claim.generation + 1, f.claim.version + 1, null, null, null,
    null, { type: 'result', id: result.id }, f.codex.connection.id, f.root.runId]);
  // One debit and one receipt with the canonical post-state; the task row, its status and human assignee are unchanged.
  assert.equal(await usedOf(f.own.complete.id), 1);
  assert.deepEqual((await receiptsOf(f.codex, 'cowork.unit.complete')).map((x) => x.postconditions), [[{ kind: 'cowork.unit_state',
    workspaceId: w.ws.id, projectId: w.p.id, unitId: f.root.unitId, taskId: f.a.id, lineageTaskId: f.a.id, runId: f.root.runId,
    role: 'execute', assignmentConnectionId: f.codex.connection.id, version: f.claim.version + 1, state: 'completed' }]]);
  assert.deepEqual((await effects(w, [f.codex])).tasks, before.tasks, 'completion never changes the task row');

  // Exact replay is an observation: no second change, debit or receipt. A changed payload under that ID conflicts.
  assert.deepEqual(await f.own.run(first), done);
  assert.equal(await usedOf(f.own.complete.id), 1);
  assert.equal((await receiptsOf(f.codex, 'cowork.unit.complete')).length, 1);
  await rejects(f.own.run({ ...first, payload: { ...f.fence, outcome: { type: 'result', id: randomUUID() } } }), 'IDEMPOTENCY_CONFLICT');
  // Completion is terminal: another completion, a transfer or a new claim of the unit are refused without effects.
  const later = { expectedVersion: done.version, generation: f.claim.generation + 1, leaseId: f.claim.lease!.id };
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => f.own.run(f.own.finish({ ...f.fence, outcome: { type: 'result', id: result.id } })),
    'COWORK_VERSION_CONFLICT');
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => f.own.run(f.own.finish({ ...later, outcome: { type: 'result', id: result.id } })),
    'COWORK_CLAIM_LOST');
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => f.own.run(f.own.handOver({ ...later,
    assignmentConnectionId: f.marekClaude.connection.id })), 'COWORK_CLAIM_LOST');
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => claimUnit(w, f.codex, f.root.unitId, 'execute', done.version), 'COWORK_UNIT_CLOSED');
  // The completed unit still observes its receipt; a revoked grant refuses even that.
  assert.deepEqual(await f.own.run(first), done);
  expectStatus(await w.hubert.browser.request('DELETE', `/api/v1/agent-connections/${f.codex.connection.id}/action-grants/${f.own.complete.id}`), 204);
  await rejects(f.own.run(first), 'AGENT_EXECUTION_UNAVAILABLE');
});

test('a versioned outcome must be readable now: an unknown, foreign, stale or GitHub outcome is refused; a replay rechecks it', async () => {
  const f = await setup();
  const { w } = f;
  const foreign = await w.result('Elsewhere', w.other);
  const refuse = (outcome: unknown, code: string) => refusedWithoutEffects(w, [f.codex],
    () => f.own.run(f.own.finish({ ...f.fence, outcome })), code);
  await refuse({ type: 'result', id: randomUUID() }, 'COWORK_OUTCOME_UNAVAILABLE');
  await refuse({ type: 'result', id: foreign.id }, 'COWORK_OUTCOME_UNAVAILABLE');
  await refuse({ type: 'material', id: w.material.materialId, version: 2 }, 'COWORK_OUTCOME_UNAVAILABLE');
  await refuse({ type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(), headSha: 'a'.repeat(40) }, 'COWORK_OUTCOME_UNAVAILABLE');
  for (const outcome of [null, 'done', { type: 'result' }, { type: 'material', id: w.material.materialId }, { type: 'result', id: randomUUID(), title: 'x' }])
    await refuse(outcome, 'INVALID_INPUT');
  // The current revision is readable; once the material moves on, replaying the completion is no longer observable.
  const first = f.own.finish({ ...f.fence, outcome: { type: 'material', id: w.material.materialId, version: 1 } });
  const done = await f.own.run(first);
  assert.deepEqual(done.outcomeRef, { type: 'material', id: w.material.materialId, version: 1 });
  expectStatus(await w.hubert.browser.request('PATCH', `/api/v1/materials/${w.material.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Revision two' } }), 200);
  await rejects(f.own.run(first), 'COWORK_OUTCOME_UNAVAILABLE');
  assert.equal(await usedOf(f.own.complete.id), 1);
});

test('holder fence negative controls: only the current holder under its live claim completes or transfers', async () => {
  const f = await setup();
  const { w } = f;
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  const all = [f.codex, f.marekClaude, claude];
  const result = await w.result('Observed');
  const outcome = { type: 'result', id: result.id };
  const refuse = (input: AgentExecutionCommand, code: string, run = f.own.run) => refusedWithoutEffects(w, all, () => run(input), code);
  const to = { assignmentConnectionId: f.marekClaude.connection.id };
  for (const [name, build] of [['complete', (fence: object) => f.own.finish({ ...fence, outcome })],
    ['transfer', (fence: object) => f.own.handOver({ ...fence, ...to })]] as const) {
    // Wrong lease, wrong generation, another runtime session of the same connection, stale version.
    await refuse(build({ ...f.fence, leaseId: randomUUID() }), 'COWORK_CLAIM_LOST');
    await refuse(build({ ...f.fence, generation: f.fence.generation + 1 }), 'COWORK_CLAIM_LOST');
    const other = await db.transaction((tx) => agentRuntimeInTransaction(tx, f.codex.claims, randomUUID()));
    await refuse({ ...build(f.fence), runtimeSessionId: other.runtime.id }, 'COWORK_CLAIM_LOST');
    await refuse(build({ ...f.fence, expectedVersion: f.fence.expectedVersion + 1 }), 'COWORK_VERSION_CONFLICT');
    // An expired lease, even with the exact fence.
    await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.root.unitId]);
    await refuse(build(f.fence), 'COWORK_CLAIM_LOST');
    await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=$1", [f.root.unitId]);
    // Payload shape: missing or extra fields, copied prompts, lineage/state fields.
    for (const payload of [{ ...f.fence }, { ...f.fence, outcome, ...to }, { ...f.fence, ...(name === 'complete' ? { outcome } : to), prompt: 'do it' },
      { ...f.fence, ...(name === 'complete' ? { outcome } : to), state: 'completed' }, { ...f.fence, expectedVersion: 0, ...(name === 'complete' ? { outcome } : to) }])
      await refuse({ ...build(f.fence), payload: payload as AgentExecutionCommand['payload'] }, 'INVALID_INPUT');
  }
  // A non-holder connection with a project-wide grant of its own owner: the unit is not its unit.
  const intruder = await holder(w, claude, f.root.unitId, 'execute', { exact: false });
  await refuse(intruder.finish({ ...f.fence, outcome }), 'COWORK_UNIT_NOT_FOUND', intruder.run);
  await refuse(intruder.handOver({ ...f.fence, ...to }), 'COWORK_UNIT_NOT_FOUND', intruder.run);
  // An exact grant can only name a unit assigned to the grantee with that role.
  expectStatus(await w.actionGrant(w.hubert, claude.connection.id, 'cowork.unit.complete', f.root.unitId, 'execute'), 404);
  expectStatus(await w.actionGrant(w.hubert, f.codex.connection.id, 'cowork.unit.transfer', f.root.unitId, 'review'), 404);
  // Another class (a broad review grant cannot act on an execute unit), another operation's grant, an exact grant for another unit.
  const reviewClass = await grantOf(w, f.codex, 'cowork.unit.complete', null, 'review');
  await refuse(command(w, f.codex, 'cowork.unit.complete', f.root.unitId, 'review', reviewClass.id, { ...f.fence, outcome }), 'COWORK_UNIT_NOT_FOUND');
  await refuse({ ...f.own.finish({ ...f.fence, outcome }), grantId: f.own.transfer.id }, 'AGENT_EXECUTION_UNAVAILABLE');
  const b = await w.task('Native outcome B');
  const bUnit = await createUnit(w, f.codex, b, 'execute', 'take-b');
  await refuse(command(w, f.codex, 'cowork.unit.complete', bUnit.unitId, 'execute', f.own.complete.id, { ...f.fence, outcome }),
    'AGENT_EXECUTION_UNAVAILABLE');
  // An own unit without a live claim (pending) is not completable or transferable.
  const bHolder = await holder(w, f.codex, bUnit.unitId, 'execute');
  await refuse(bHolder.finish({ expectedVersion: 1, generation: 1, leaseId: randomUUID(), outcome }), 'COWORK_CLAIM_LOST', bHolder.run);
  await refuse(bHolder.handOver({ expectedVersion: 1, generation: 1, leaseId: randomUUID(), ...to }), 'COWORK_CLAIM_LOST', bHolder.run);
  // Another project's unit of a connection that selected both projects, under this project's project-wide grant.
  const both = await w.connect(w.hubert, 'Hubert both projects', { projects: [w.p.id, w.other.id] });
  const elsewhere = await w.task('Elsewhere', w.other);
  const otherGrant = expectStatus(await w.actionGrant(w.hubert, both.connection.id, 'cowork.unit.create', elsewhere.id, 'execute', w.other.id),
    201) as AgentStandingGrant;
  const away = await db.transaction((tx) => coWorkUnitCreateInTransaction(tx, both.claims, command(w, both, 'cowork.unit.create', elsewhere.id,
    'execute', otherGrant.id, { unitKey: 'take-away', expectedTaskVersion: elsewhere.version, assignmentConnectionId: both.connection.id,
      parent: null }, { projectId: w.other.id, audience: { kind: 'project', projectId: w.other.id } }), UNITS));
  expectStatus(await w.actionGrant(w.hubert, both.connection.id, 'cowork.unit.complete', away.unitId, 'execute'), 404,
    'an exact target must be a unit of the grant project');
  const wide = await grantOf(w, both, 'cowork.unit.complete', null, 'execute');
  await refusedWithoutEffects(w, [...all, both], () => db.transaction((tx) => coWorkUnitTransitionInTransaction(tx, both.claims,
    command(w, both, 'cowork.unit.complete', away.unitId, 'execute', wide.id, { ...f.fence, outcome }), TRANSITIONS)), 'COWORK_UNIT_NOT_FOUND');
  // After all refusals the holder still completes with its exact live fence.
  assert.equal((await f.own.run(f.own.finish({ ...f.fence, outcome }))).state, 'completed');
});

test('the holder transfers its unit; the assignee claims it with its own grant; the former holder loses it', async () => {
  const f = await setup();
  const { w } = f;
  const first = f.own.handOver({ ...f.fence, assignmentConnectionId: f.marekClaude.connection.id });
  const before = await effects(w, [f.codex, f.marekClaude]);
  const moved = await f.own.run(first);
  assert.deepEqual(moved, { unitId: f.root.unitId, taskId: f.a.id, role: 'execute', assignmentConnectionId: f.marekClaude.connection.id,
    version: f.claim.version + 1, state: 'pending', outcomeRef: null });
  const row = await unitRow(f.root.unitId);
  assert.deepEqual([row.state, row.generation, row.version, row.lease_id, row.assignment_connection_id, row.work_id, row.lineage_work_id,
    row.run_id, row.unit_key, row.role, row.checkpoint_id, row.outcome_ref], ['pending', f.claim.generation + 1, f.claim.version + 1, null,
    f.marekClaude.connection.id, f.a.id, f.a.id, f.root.runId, 'take-a', 'execute', null, null], 'task, lineage, run, key and role are retained');
  assert.deepEqual((await effects(w, [f.codex, f.marekClaude])).tasks, before.tasks, 'a transfer never changes the task or its human assignee');
  assert.deepEqual((await receiptsOf(f.codex, 'cowork.unit.transfer')).map((x) => x.postconditions[0].assignmentConnectionId),
    [f.marekClaude.connection.id], 'the receipt records the new assignee; the receipt itself belongs to the former holder');
  // Replay by the former holder observes the unchanged unit, without a second debit.
  assert.deepEqual(await f.own.run(first), moved);
  assert.equal(await usedOf(f.own.transfer.id), 1);

  // The former holder lost the unit: claim, completion, another transfer and request claims are not found; its old
  // claim receipt no longer locates its unit.
  const broadClaim = await grantOf(w, f.codex, 'cowork.claim', null, 'execute');
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => db.transaction((tx) => coWorkClaimInTransaction(tx, f.codex.claims,
    command(w, f.codex, 'cowork.claim', f.root.unitId, 'execute', broadClaim.id, { expectedVersion: moved.version }), CLAIMS)), 'COWORK_UNIT_NOT_FOUND');
  const result = await w.result('Late result');
  const lateFence = { expectedVersion: moved.version, generation: f.claim.generation + 1, leaseId: f.claim.lease!.id };
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => f.own.run(f.own.finish({ ...lateFence, outcome: { type: 'result', id: result.id } })),
    'COWORK_UNIT_NOT_FOUND');
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => f.own.run(f.own.handOver({ ...lateFence,
    assignmentConnectionId: f.codex.connection.id })), 'COWORK_UNIT_NOT_FOUND');
  const broadTake = await grantOf(w, f.codex, 'cowork.request.claim', null, 'execute');
  await refusedWithoutEffects(w, [f.codex, f.marekClaude], () => db.transaction((tx) => coWorkRequestResponseInTransaction(tx, f.codex.claims,
    command(w, f.codex, 'cowork.request.claim', f.root.unitId, 'execute', broadTake.id, { generation: f.claim.generation, leaseId: f.claim.lease!.id,
      requestId: randomUUID(), expectedRequestVersion: 1 }), NO_PUBLICATION)), 'COWORK_UNIT_NOT_FOUND');
  expectStatus(await w.actionGrant(w.hubert, f.codex.connection.id, 'cowork.claim', f.root.unitId, 'execute'), 404);

  // The transfer gave Marek nothing but a pending unit: Marek's own owner grants his claim, and the claim fences again.
  const marekClaim = await claimUnit(w, f.marekClaude, f.root.unitId, 'execute', moved.version);
  assert.deepEqual([marekClaim.state, marekClaim.generation, marekClaim.version], ['claimed', f.claim.generation + 2, moved.version + 1]);
  // Once the unit changed again, the former holder's transfer receipt is stale.
  await rejects(f.own.run(first), 'COMMAND_POSTSTATE_STALE');
  // The new holder can finish it.
  const marekHolder = await holder(w, f.marekClaude, f.root.unitId, 'execute');
  const done = await marekHolder.run(marekHolder.finish({ ...fenceOf(marekClaim), outcome: { type: 'result', id: result.id } }));
  assert.deepEqual([done.state, done.assignmentConnectionId], ['completed', f.marekClaude.connection.id]);
});

test('a transfer receipt stays stale after the unit returns to the same assignee and state through a full cycle', async () => {
  const f = await setup();
  const { w } = f;
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  const first = f.own.handOver({ ...f.fence, assignmentConnectionId: f.marekClaude.connection.id });
  const moved = await f.own.run(first);
  // Marek claims and hands it to Claude; Claude claims and hands it back: pending, assigned to Marek, as in the receipt.
  const marekClaim = await claimUnit(w, f.marekClaude, f.root.unitId, 'execute', moved.version);
  const marek = await holder(w, f.marekClaude, f.root.unitId, 'execute');
  const toClaude = await marek.run(marek.handOver({ ...fenceOf(marekClaim), assignmentConnectionId: claude.connection.id }));
  const claudeClaim = await claimUnit(w, claude, f.root.unitId, 'execute', toClaude.version);
  const claudeHolder = await holder(w, claude, f.root.unitId, 'execute');
  const back = await claudeHolder.run(claudeHolder.handOver({ ...fenceOf(claudeClaim), assignmentConnectionId: f.marekClaude.connection.id }));
  assert.deepEqual([back.state, back.assignmentConnectionId, back.taskId, back.role], [moved.state, moved.assignmentConnectionId, moved.taskId, moved.role]);
  assert.equal(back.version, moved.version + 4, 'only the version tells the two states apart');
  await rejects(f.own.run(first), 'COMMAND_POSTSTATE_STALE');
  assert.equal(await usedOf(f.own.transfer.id), 1);
});

test('transfer negative controls: an ineligible, revoked or self assignee and separation within the run refuse without effects', async () => {
  const f = await reviewScene();
  const { w } = f;
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  const all = [f.codex, f.marekClaude, claude];
  const refuse = (input: AgentExecutionCommand, code: string, run = f.own.run, policy = TRANSITIONS) =>
    refusedWithoutEffects(w, all, () => run(input, policy), code);
  const to = (assignmentConnectionId: string) => f.own.handOver({ ...f.fence, assignmentConnectionId });
  // Unknown, revoked, another workspace, project not selected, no execute scope — one content-free outcome.
  const revoked = await w.connection(w.marek, 'Marek revoked');
  expectStatus(await w.marek.browser.request('DELETE', `/api/v1/agent-connections/${revoked.id}`), 204);
  const elsewhere = await workspace(w.hubert, 'Another workspace');
  const away = await project(w.hubert, elsewhere.id, 'Away', 'restricted');
  const foreign = await w.connection(w.hubert, 'Hubert elsewhere', { space: elsewhere.id, projects: [away.id] });
  const unselected = await w.connection(w.marek, 'Marek other project', { projects: [w.other.id] });
  const readOnly = await w.connection(w.marek, 'Marek read only', { scopes: ['flux.context.read'] });
  for (const id of [randomUUID(), revoked.id, foreign.id, unselected.id, readOnly.id]) await refuse(to(id), 'COWORK_ASSIGNEE_UNAVAILABLE');
  // Not to itself.
  await refuse(to(f.codex.connection.id), 'COWORK_ASSIGNMENT_REFUSED');
  // Separation: the author's execute unit cannot go to the run's reviewer, nor the review unit to the run's author.
  await refuse(to(f.marekClaude.connection.id), 'COWORK_REVIEW_SEPARATION');
  await refuse(f.reviewer.handOver({ ...f.reviewFence, assignmentConnectionId: f.codex.connection.id }), 'COWORK_REVIEW_SEPARATION', f.reviewer.run);
  // A stricter policy also refuses another connection of the author's owner as the reviewer; the default allows it.
  await refuse(f.reviewer.handOver({ ...f.reviewFence, assignmentConnectionId: claude.connection.id }), 'COWORK_REVIEW_SEPARATION', f.reviewer.run,
    { reviewSeparation: 'distinct_owner' });
  const handed = await f.reviewer.run(f.reviewer.handOver({ ...f.reviewFence, assignmentConnectionId: claude.connection.id }));
  assert.deepEqual([handed.state, handed.assignmentConnectionId], ['pending', claude.connection.id]);
  // The author's execute unit can go to another connection of its own owner that holds no review unit of the run.
  const yetAnother = await w.connect(w.hubert, 'Hubert Gemini');
  assert.equal((await f.own.run(to(yetAnother.connection.id))).assignmentConnectionId, yetAnother.connection.id);
});

test('open requests addressed to the unit block completion and transfer until answered; expired ones do not; a completed unit takes no request', async () => {
  const f = await reviewScene();
  const { w } = f;
  const all = [f.codex, f.marekClaude];
  const result = await w.result('Review findings');
  const finish = () => f.reviewer.run(f.reviewer.finish({ ...f.reviewFence, outcome: { type: 'result', id: result.id } }));
  const marekCodex = await w.connect(w.marek, 'Marek Codex');
  const asked = await f.admit(f.ask('review-1'));
  assert.equal(asked.state, 'queued');
  // Queued, then claimed under the live claim: both block.
  await refusedWithoutEffects(w, all, finish, 'COWORK_UNIT_REQUESTS_OPEN');
  await refusedWithoutEffects(w, all, () => f.reviewer.run(f.reviewer.handOver({ ...f.reviewFence,
    assignmentConnectionId: marekCodex.connection.id })), 'COWORK_UNIT_REQUESTS_OPEN');
  assert.equal((await f.take(asked.requestId)).state, 'claimed');
  await refusedWithoutEffects(w, all, finish, 'COWORK_UNIT_REQUESTS_OPEN');
  // Declined (a visible outcome for the sender): nothing is open any more. A request that expired cannot be answered and does not block.
  assert.equal((await f.decline(asked.requestId)).state, 'declined');
  const fleeting = await f.admit(f.ask('review-2', 1));
  assert.equal(fleeting.state, 'queued');
  await refusedWithoutEffects(w, all, finish, 'COWORK_UNIT_REQUESTS_OPEN');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const done = await finish();
  assert.equal(done.state, 'completed');
  assert.deepEqual((await pool.query('SELECT state FROM cowork_requests WHERE id = ANY($1::uuid[]) ORDER BY created_at',
    [[asked.requestId, fleeting.requestId]])).rows.map((x) => x.state), ['declined', 'queued'], 'completion changes no request row');
  // A request to a completed unit could never be answered, so admission refuses it.
  await refusedWithoutEffects(w, all, () => f.admit(f.ask('review-3')), 'COWORK_REQUEST_UNAVAILABLE');
});

test('race: a request admission and the completion of its recipient unit serialize on the holder slot, in both orders', async () => {
  // Admission first: the completion waits on the recipient's slot and then sees the open request.
  const f = await reviewScene();
  const { w } = f;
  const result = await w.result('Review findings');
  const ready = barrier<number>(), release = barrier();
  const holding = db.transaction(async (tx) => {
    const outcome = await coWorkRequestInTransaction(tx, f.codex.claims, f.ask('review-race'), REQUESTS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  holding.catch(() => ready.resolve(-1));
  const holderPid = await ready.promise; assert.ok(holderPid > 0);
  const completion = f.reviewer.run(f.reviewer.finish({ ...f.reviewFence, outcome: { type: 'result', id: result.id } }));
  completion.catch(() => undefined);
  const done = settled(completion);
  await waitUntilBlockedBy(pool, holderPid);
  assert.equal(done(), false, 'the completion waits for the admission');
  assert.deepEqual(await waitingOn(holderPid), ['transactionid'], 'it waits on the recipient slot row');
  release.resolve();
  assert.equal((await holding).status, 'created');
  await rejects(completion, 'COWORK_UNIT_REQUESTS_OPEN');
  assert.equal((await unitRow(f.review.unitId)).state, 'claimed');

  // Completion first: the admission waits on the same slot and is then refused, so no request is left unanswerable.
  const g = await reviewScene();
  const findings = await g.w.result('Second findings');
  const ready2 = barrier<number>(), release2 = barrier();
  const finishing = db.transaction(async (tx) => {
    const outcome = await coWorkUnitTransitionInTransaction(tx, g.marekClaude.claims,
      g.reviewer.finish({ ...g.reviewFence, outcome: { type: 'result', id: findings.id } }), TRANSITIONS);
    ready2.resolve(await backendPid(tx)); await release2.promise; return outcome;
  });
  finishing.catch(() => ready2.resolve(-1));
  const finisher = await ready2.promise; assert.ok(finisher > 0);
  const before = await effects(g.w, [g.codex, g.marekClaude]);
  const admission = g.admit(g.ask('review-late'));
  admission.catch(() => undefined);
  await waitUntilBlockedBy(pool, finisher);
  release2.resolve();
  assert.equal((await finishing).state, 'completed');
  await rejects(admission, 'COWORK_REQUEST_UNAVAILABLE');
  const after = await effects(g.w, [g.codex, g.marekClaude]);
  assert.deepEqual(after.requests, before.requests, 'no request was admitted');
  assert.equal(after.used, before.used + 1, 'only the completion spent a use; the refused admission spent nothing');
});

test('race: two transitions of one unit by its holder serialize; exactly one wins and the other is fenced', async () => {
  const f = await setup();
  const { w } = f;
  const result = await w.result('Observed');
  const ready = barrier<number>(), release = barrier();
  const holding = db.transaction(async (tx) => {
    const outcome = await coWorkUnitTransitionInTransaction(tx, f.codex.claims,
      f.own.finish({ ...f.fence, outcome: { type: 'result', id: result.id } }), TRANSITIONS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  holding.catch(() => ready.resolve(-1));
  const holderPid = await ready.promise; assert.ok(holderPid > 0);
  const transfer = f.own.run(f.own.handOver({ ...f.fence, assignmentConnectionId: f.marekClaude.connection.id }));
  transfer.catch(() => undefined);
  await waitUntilBlockedBy(pool, holderPid);
  release.resolve();
  assert.equal((await holding).state, 'completed');
  await rejects(transfer, 'COWORK_VERSION_CONFLICT');
  const row = await unitRow(f.root.unitId);
  assert.deepEqual([row.state, row.assignment_connection_id], ['completed', f.codex.connection.id]);
  assert.equal(await usedOf(f.own.transfer.id), 0, 'the fenced transfer spent nothing');
});

test('race: an assignee revocation that commits first refuses the transfer; one that waits stops the transferred unit', async () => {
  const f = await setup();
  const { w } = f;
  // Revocation first: it holds the assignee row; the transfer waits on it and then sees the revoked connection.
  const marekCodex = await w.connect(w.marek, 'Marek Codex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE agent_connections SET revoked_at=now() WHERE id=$1', [marekCodex.connection.id]);
    const holderPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const before = await effects(w, [f.codex, marekCodex]);
    const attempt = f.own.run(f.own.handOver({ ...f.fence, assignmentConnectionId: marekCodex.connection.id }));
    attempt.catch(() => undefined);
    await waitUntilBlockedBy(pool, holderPid);
    assert.deepEqual(await waitingOn(holderPid), ['transactionid'], 'the transfer waits on the assignee connection row');
    await client.query('COMMIT');
    await rejects(attempt, 'COWORK_ASSIGNEE_UNAVAILABLE');
    assert.deepEqual(await effects(w, [f.codex, marekCodex]), before, 'nothing persisted');
  } finally { client.release(); }

  // Transfer first: the revocation waits for its commit, then its trigger stops the transferred pending unit.
  const ready = barrier<number>(), release = barrier();
  const holding = db.transaction(async (tx) => {
    const outcome = await coWorkUnitTransitionInTransaction(tx, f.codex.claims,
      f.own.handOver({ ...f.fence, assignmentConnectionId: f.marekClaude.connection.id }), TRANSITIONS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  holding.catch(() => ready.resolve(-1));
  const holderPid = await ready.promise; assert.ok(holderPid > 0);
  const revocation = pool.query('UPDATE agent_connections SET revoked_at=now() WHERE id=$1', [f.marekClaude.connection.id]);
  const done = settled(revocation);
  await waitUntilBlockedBy(pool, holderPid);
  assert.equal(done(), false, 'the revocation waits for the transfer');
  release.resolve();
  const moved = await holding;
  await revocation;
  const row = await unitRow(moved.unitId);
  assert.deepEqual([row.state, row.assignment_connection_id, row.generation, row.version],
    ['stopped', f.marekClaude.connection.id, f.claim.generation + 2, f.claim.version + 2], 'no pending unit survives for a revoked assignee');
});
