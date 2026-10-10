import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentStandingGrant, CoWorkRequestLimits, ProjectAgents, WorkItem } from '@flux/contracts';
import { coworkRecoveryRows, coworkRequestRows, createDatabase, schema, sql } from '@flux/db';
import { coWorkRequestFingerprint, DomainError, normalizeCoWorkRequest } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { coWorkClaimInTransaction, type CoWorkClaimPolicy } from '../../apps/server/src/co-work/claims.js';
import { coWorkTaskGraphLocks } from '../../apps/server/src/co-work/graph.js';
import { coWorkRequestInTransaction, type CoWorkRequestPolicy } from '../../apps/server/src/co-work/requests.js';
import { coWorkRequestResponseInTransaction, type CoWorkResponsePolicy } from '../../apps/server/src/co-work/responses.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';

// Recipient request claim, response and supersession (#153) over real #152 runtimes/grants/ledger and PostgreSQL.
// Bearer bindings are trusted fixtures, units are inserted directly (no unit creation command exists yet) and the
// response publisher is a same-transaction fixture, not #154's production provider. Not a public tool or client evidence.
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const LIMITS: CoWorkRequestLimits = { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 };
const REQUESTS: CoWorkRequestPolicy = { limits: LIMITS, reviewSeparation: 'distinct_connection' };
const CLAIMS: CoWorkClaimPolicy = { maximumConnectionUnits: 1, leaseSeconds: 120,
  prepareTaskLocks: (tx, context, units) => coWorkTaskGraphLocks(tx, context.workspaceId, units),
  async requireEligible() {}, async requireCheckpointSources() {} };
type Role = 'execute' | 'review' | 'plan';
type Publisher = CoWorkResponsePolicy['publishResponse'];

/** Fixture publisher: a genuine agent result row inside the caller's transaction. */
const publishResult: Publisher = async (tx, runtime, request, response) => {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO project_results (id, workspace_id, project_id, title, finding, evidence, created_by_kind, created_by_id)
    SELECT ${id}::uuid, workspace_id, project_id, ${String(response.title)}, 'negative', '', 'agent', ${runtime.agentId}
    FROM project_work_items WHERE id = ${request.taskId}::uuid`);
  return { type: 'result', id };
};

async function world() {
  const hubert = await person('cowork-responses-hubert'), marek = await person('cowork-responses-marek');
  const ws = await workspace(hubert, 'Responses workspace');
  // Marek authorizes his own connection's standing grants, which needs project management (#152).
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Addressed review', 'restricted');
  await grant(hubert, p.id, marek, 'contributor');
  const task = async (title: string) =>
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title } }), 201) as WorkItem;
  const connect = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name, owner: 'self' } }), 201) as Agent;
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const connection = expectStatus(await who.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: agent.id, selectedProjectIds: [p.id], scopes: ['flux.context.read', 'flux.action.execute'] } }), 201) as AgentConnection;
    const clientId = `cowork-responses-${randomUUID()}`, bindingId = randomUUID();
    await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
      [randomUUID(), clientId, 'Trusted responses fixture', ['https://fixture.invalid/callback']]);
    await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)',
      [bindingId, who.id, connection.id, clientId]);
    const claims = { ownerUserId: who.id, connectionId: connection.id, clientId, grantReferenceId: `flux-grant:${bindingId}`, scopes: connection.scopes };
    const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, randomUUID()));
    return { who, connection, claims, runtimeId: runtime.id };
  };
  const unit = async (workId: string, runId: string, role: Role, connectionId: string) => {
    const id = randomUUID();
    await db.insert(schema.coworkUnits).values({ id, workspaceId: ws.id, projectId: p.id, taskId: workId, lineageTaskId: workId,
      runId, unitKey: id, role, assignmentConnectionId: connectionId });
    return id;
  };
  const actionGrant = async (who: Person, connectionId: string, operation: string, objectId: string | null, role: Role) =>
    who.browser.request('POST', `/api/v1/agent-connections/${connectionId}/action-grants`,
      { body: { clientCommandId: randomUUID(), projectId: p.id, operation, ...(objectId ? { objectId } : {}),
        peerRequestClass: role, maximumUses: 20, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
  const material = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Review criteria', body: 'Exact current revision' } }), 201) as { materialId: string };
  return { hubert, marek, ws, p, task, connect, unit, actionGrant, material };
}
type World = Awaited<ReturnType<typeof world>>;
type Connected = Awaited<ReturnType<World['connect']>>;

function command(w: World, c: Connected, operation: string, objectId: string, role: Role, grantId: string,
  payload: Record<string, unknown>, change: Partial<AgentExecutionCommand> = {}): AgentExecutionCommand {
  return { runtimeSessionId: c.runtimeId, grantId, clientCommandId: randomUUID(), projectId: w.p.id,
    operation: operation as AgentExecutionCommand['operation'], peerRequestClass: role, audience: { kind: 'project', projectId: w.p.id },
    objectId, sources: [], payload: payload as AgentExecutionCommand['payload'], ...change };
}
async function grantOf(w: World, c: Connected, operation: string, unitId: string | null, role: Role) {
  return expectStatus(await w.actionGrant(c.who, c.connection.id, operation, unitId, role), 201) as AgentStandingGrant;
}
/** A live claim on a unit through the real claim composition and the production graph provider. */
async function claimUnit(w: World, c: Connected, unitId: string, role: Role, expectedVersion = 1) {
  const g = await grantOf(w, c, 'cowork.claim', unitId, role);
  return db.transaction((tx) => coWorkClaimInTransaction(tx, c.claims,
    command(w, c, 'cowork.claim', unitId, role, g.id, { expectedVersion }), CLAIMS));
}
async function sender(w: World, c: Connected, unitId: string, role: Role = 'execute') {
  const claim = await claimUnit(w, c, unitId, role);
  const requestGrant = await grantOf(w, c, 'cowork.request', unitId, role);
  const cmd = (request: Record<string, unknown>) => command(w, c, 'cowork.request', unitId, role, requestGrant.id,
    { generation: claim.generation, leaseId: claim.lease!.id, request });
  const admit = (input: AgentExecutionCommand) => db.transaction((tx) => coWorkRequestInTransaction(tx, c.claims, input, REQUESTS));
  return { claim, requestGrant, cmd, admit, send: (request: Record<string, unknown>) => admit(cmd(request)) };
}
async function recipient(w: World, c: Connected, unitId: string, role: Role = 'review') {
  const claim = await claimUnit(w, c, unitId, role);
  const claimGrant = await grantOf(w, c, 'cowork.request.claim', unitId, role);
  const respondGrant = await grantOf(w, c, 'cowork.request.respond', unitId, role);
  const own = { generation: claim.generation, leaseId: claim.lease!.id };
  const take = (requestId: string, expectedRequestVersion: number, change: Partial<AgentExecutionCommand> = {}, fence = own) =>
    command(w, c, 'cowork.request.claim', unitId, role, claimGrant.id, { ...fence, requestId, expectedRequestVersion }, change);
  const respond = (requestId: string, expectedRequestVersion: number, outcome: Record<string, unknown>,
    change: Partial<AgentExecutionCommand> = {}, fence = own) =>
    command(w, c, 'cowork.request.respond', unitId, role, respondGrant.id, { ...fence, requestId, expectedRequestVersion, ...outcome }, change);
  const run = (input: AgentExecutionCommand, options: { publish?: Publisher; failAfter?: boolean } = {}) =>
    db.transaction(async (tx) => {
      const outcome = await coWorkRequestResponseInTransaction(tx, c.claims, input, { publishResponse: options.publish ?? publishResult });
      if (options.failAfter) throw new Error('Injected failure after the transition/debit/receipt');
      return outcome;
    });
  return { claim, claimGrant, respondGrant, fence: own, take, respond, run, unitId };
}
function rejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code, code);
}
/** Everything a refused recipient command could have changed. */
async function effects(w: World, c: Connected, requestId: string) {
  const [request] = (await pool.query(`SELECT state, version, claimed_generation, reason, next_boundary, dependency_ref, response_ref
    FROM cowork_requests WHERE id=$1`, [requestId])).rows;
  const used = (await pool.query('SELECT COALESCE(sum(used),0)::int AS n FROM agent_standing_grants WHERE connection_id=$1', [c.connection.id])).rows[0].n;
  const receipts = (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [c.connection.id])).rows[0].n;
  const results = (await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [w.p.id])).rows[0].n;
  return { request, used, receipts, results };
}
/** The attempt starts only after the snapshot, so nothing it does can leak into `before`. */
async function refusedWithoutEffects(w: World, c: Connected, requestId: string, attempt: () => Promise<unknown>, code: string) {
  const before = await effects(w, c, requestId);
  await rejects(attempt(), code);
  assert.deepEqual(await effects(w, c, requestId), before, `${code}: no request change, publication, grant use or receipt`);
}
/** Lock types the sessions blocked by `holder` are waiting on (row locks show as `transactionid`). */
async function waitingOn(holder: number) {
  return (await pool.query(`SELECT l.locktype FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND $1 = ANY(pg_blocking_pids(a.pid))`, [holder])).rows.map((x) => x.locktype as string);
}
async function row(id: string) {
  return (await pool.query('SELECT * FROM cowork_requests WHERE id=$1', [id])).rows[0];
}

async function setup() {
  const w = await world();
  const a = await w.task('Native outcome A'); const run = randomUUID();
  const codex = await w.connect(w.hubert, 'Hubert Codex'), marekClaude = await w.connect(w.marek, 'Marek Claude');
  const senderUnit = await w.unit(a.id, run, 'execute', codex.connection.id);
  const reviewUnit = await w.unit(a.id, run, 'review', marekClaude.connection.id);
  const s = await sender(w, codex, senderUnit);
  const ask = (change: Record<string, unknown> = {}) => ({ unitId: reviewUnit, expectedUnitVersion: 1,
    recipientConnectionId: marekClaude.connection.id, intentKey: `review-${randomUUID()}`, parentRequestId: null, kind: 'review',
    target: { type: 'work', id: a.id, version: a.version }, sourceRefs: [{ type: 'material', id: w.material.materialId, version: 1 }],
    criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], priority: 1, peerUnblocking: true, lifetimeSeconds: 3600, ...change });
  return { w, a, run, codex, marekClaude, senderUnit, reviewUnit, s, ask };
}

test('the recipient claims under its live unit fence and resolves with a same-transaction exact response; replay observes', async () => {
  const f = await setup();
  const askCommand = f.s.cmd(f.ask());
  const asked = await f.s.admit(askCommand);
  const r = await recipient(f.w, f.marekClaude, f.reviewUnit);
  const takeCommand = r.take(asked.requestId, 1);
  const taken = await r.run(takeCommand);
  assert.deepEqual(taken, { requestId: asked.requestId, version: 2, state: 'claimed', responseRef: null });
  assert.equal((await row(asked.requestId)).claimed_generation, r.claim.generation);
  const receipt = async (operation: string) => (await pool.query(
    'SELECT postconditions FROM agent_command_receipts WHERE connection_id=$1 AND operation=$2', [f.marekClaude.connection.id, operation])).rows;
  assert.deepEqual((await receipt('cowork.request.claim')).map((x) => x.postconditions), [[{ kind: 'cowork.request_state', workspaceId: f.w.ws.id,
    projectId: f.w.p.id, connectionId: f.marekClaude.connection.id, unitId: f.reviewUnit, requestId: asked.requestId, role: 'review', version: 2, state: 'claimed' }]]);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [r.claimGrant.id])).rows[0].used, 1);
  assert.deepEqual(await r.run(takeCommand), taken, 'exact claim replay observes the original effect');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [r.claimGrant.id])).rows[0].used, 1, 'no second debit');
  await rejects(r.run({ ...takeCommand, payload: { ...(takeCommand.payload as object), expectedRequestVersion: 2 } }), 'IDEMPOTENCY_CONFLICT');

  const respondCommand = r.respond(asked.requestId, 2, { outcome: 'resolved', response: { title: 'Findings on A' } });
  const resolved = await r.run(respondCommand);
  assert.equal(resolved.state, 'resolved'); assert.equal(resolved.version, 3); assert.equal(resolved.responseRef?.type, 'result');
  const stored = await row(asked.requestId);
  assert.deepEqual(stored.response_ref, resolved.responseRef); assert.equal(stored.reason, null);
  const result = (await pool.query('SELECT created_by_kind, created_by_id, title FROM project_results WHERE id=$1', [resolved.responseRef!.id])).rows[0];
  assert.deepEqual(result, { created_by_kind: 'agent', created_by_id: (await pool.query('SELECT agent_id FROM agent_connections WHERE id=$1',
    [f.marekClaude.connection.id])).rows[0].agent_id, title: 'Findings on A' });
  // The unit's own claim is untouched; releasing or completing it is a separate command.
  const unit = (await pool.query('SELECT state, generation, lease_id FROM cowork_units WHERE id=$1', [f.reviewUnit])).rows[0];
  assert.deepEqual(unit, { state: 'claimed', generation: r.claim.generation, lease_id: r.claim.lease!.id });

  const results = (await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [f.w.p.id])).rows[0].n;
  assert.deepEqual(await r.run(respondCommand), resolved, 'exact response replay observes; it publishes nothing again');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_results WHERE project_id=$1', [f.w.p.id])).rows[0].n, results);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [r.respondGrant.id])).rows[0].used, 1);
  await rejects(r.run(takeCommand), 'COMMAND_POSTSTATE_STALE');
  // Resolved work leaves the pending recovery page and the ready candidates.
  const address = { workspaceId: f.w.ws.id, projectId: f.w.p.id, connectionId: f.marekClaude.connection.id };
  assert.deepEqual((await coworkRecoveryRows(db).page(address, 10)).records, []);
  assert.deepEqual((await db.transaction((tx) => coworkRequestRows(tx).readyCandidates(address, 10))).records, []);
  // The sender's admission receipt observed the queued state it produced, so it is now stale as well.
  await rejects(f.s.admit(askCommand), 'COMMAND_POSTSTATE_STALE');
});

test('claim negative controls: unit fence, addressing, version, state, expiry, sources, class and payload refuse without effects', async () => {
  const f = await setup();
  const { w } = f;
  const asked = await f.s.send(f.ask());
  // No live unit claim: a request-claim grant alone is not a fence.
  const early = await grantOf(w, f.marekClaude, 'cowork.request.claim', f.reviewUnit, 'review');
  await refusedWithoutEffects(w, f.marekClaude, asked.requestId, () => db.transaction((tx) => coWorkRequestResponseInTransaction(tx, f.marekClaude.claims,
    command(w, f.marekClaude, 'cowork.request.claim', f.reviewUnit, 'review', early.id, { generation: 1, leaseId: randomUUID(),
      requestId: asked.requestId, expectedRequestVersion: 1 }), { publishResponse: publishResult })), 'COWORK_CLAIM_LOST');
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  const refuse = (input: AgentExecutionCommand, code: string, id = asked.requestId) =>
    refusedWithoutEffects(w, f.marekClaude, id, () => r.run(input), code);
  await refuse(r.take(asked.requestId, 1, {}, { ...r.fence, leaseId: randomUUID() }), 'COWORK_CLAIM_LOST');
  await refuse(r.take(asked.requestId, 1, {}, { ...r.fence, generation: r.fence.generation + 1 }), 'COWORK_CLAIM_LOST');
  const other = await db.transaction((tx) => agentRuntimeInTransaction(tx, f.marekClaude.claims, randomUUID()));
  await refuse(r.take(asked.requestId, 1, { runtimeSessionId: other.runtime.id }), 'COWORK_CLAIM_LOST');
  // Addressing: an unknown request, and another unit of this connection, are the same content-free outcome.
  await refuse(r.take(randomUUID(), 1), 'COWORK_REQUEST_UNAVAILABLE');
  const secondUnit = await w.unit(f.a.id, f.run, 'review', f.marekClaude.connection.id);
  const toSecond = await f.s.send(f.ask({ unitId: secondUnit }));
  await refuse(r.take(toSecond.requestId, 1), 'COWORK_REQUEST_UNAVAILABLE', toSecond.requestId);
  // Another connection (Hubert's Claude) with its own live claim cannot take a request addressed to Marek's.
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  const claudeUnit = await w.unit(f.a.id, f.run, 'review', claude.connection.id);
  const intruder = await recipient(w, claude, claudeUnit);
  await refusedWithoutEffects(w, claude, asked.requestId, () => intruder.run(intruder.take(asked.requestId, 1)), 'COWORK_REQUEST_UNAVAILABLE');
  // Version, class and payload.
  await refuse(r.take(asked.requestId, 2), 'COWORK_VERSION_CONFLICT');
  expectStatus(await w.actionGrant(w.marek, f.marekClaude.connection.id, 'cowork.request.claim', f.reviewUnit, 'execute'), 404,
    'an exact target refuses a class that is not the unit role');
  const wrongClass = await grantOf(w, f.marekClaude, 'cowork.request.claim', null, 'execute');
  await refuse(r.take(asked.requestId, 1, { grantId: wrongClass.id, peerRequestClass: 'execute' }), 'COWORK_UNIT_NOT_FOUND');
  await refuse({ ...r.take(asked.requestId, 1), payload: { ...r.fence, requestId: asked.requestId, expectedRequestVersion: 1, prompt: 'claim it' } }, 'INVALID_INPUT');
  await refuse({ ...r.take(asked.requestId, 1), payload: { ...r.fence, requestId: asked.requestId } }, 'INVALID_INPUT');
  // Changed source: the target task moved to a new version after the request was admitted. (A help request, so it
  // does not supersede the pending review used below.)
  const changedTask = await w.task('Native outcome C');
  const stale = await f.s.send(f.ask({ kind: 'help', expectedUnitVersion: 2, target: { type: 'work', id: changedTask.id, version: changedTask.version },
    criteriaRefs: [{ type: 'work', id: changedTask.id, version: changedTask.version }] }));
  assert.deepEqual(stale.supersededRequestIds, []);
  const edited = expectStatus(await w.hubert.browser.request('PATCH', `/api/v1/work/${changedTask.id}`,
    { body: { title: 'Native outcome C, edited' }, headers: { 'if-match': `"${changedTask.version}"` } }), 200) as WorkItem;
  assert.ok(edited.version > changedTask.version);
  await refuse(r.take(stale.requestId, 1), 'COWORK_SOURCE_UNAVAILABLE', stale.requestId);
  // Expired request.
  await pool.query("UPDATE cowork_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [asked.requestId]);
  await refuse(r.take(asked.requestId, 1), 'COWORK_REQUEST_EXPIRED');
  await pool.query("UPDATE cowork_requests SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [asked.requestId]);
  // Already claimed under the live generation, then terminal.
  await r.run(r.take(asked.requestId, 1));
  await refuse(r.take(asked.requestId, 2), 'COWORK_REQUEST_CLAIMED');
  await r.run(r.respond(asked.requestId, 2, { outcome: 'declined', reason: 'capability' }));
  await refuse(r.take(asked.requestId, 3), 'COWORK_REQUEST_CLOSED');
  const answered = await f.s.send(f.ask({ expectedUnitVersion: 2 }));
  await r.run(r.take(answered.requestId, 1));
  assert.equal((await r.run(r.respond(answered.requestId, 2, { outcome: 'resolved', response: { title: 'Answer' } }))).state, 'resolved');
  await refuse(r.take(answered.requestId, 3), 'COWORK_REQUEST_CLOSED', answered.requestId);
  // A request of another project, addressed to this very connection, is unavailable from this project's unit.
  const p2 = await project(w.hubert, w.ws.id, 'Other project', 'restricted');
  const t2 = expectStatus(await w.hubert.browser.request('POST', `/api/v1/projects/${p2.id}/work`, { body: { title: 'Other task' } }), 201) as WorkItem;
  const u2 = randomUUID();
  await db.insert(schema.coworkUnits).values({ id: u2, workspaceId: w.ws.id, projectId: p2.id, taskId: t2.id, lineageTaskId: t2.id,
    runId: randomUUID(), unitKey: u2, role: 'review', assignmentConnectionId: f.marekClaude.connection.id });
  const foreignInput = normalizeCoWorkRequest({ commandId: randomUUID(), unitId: u2, expectedUnitVersion: 1,
    recipientConnectionId: f.marekClaude.connection.id, intentKey: 'other-project', parentRequestId: null, kind: 'review',
    target: { type: 'work', id: t2.id, version: t2.version }, sourceRefs: [{ type: 'work', id: t2.id, version: t2.version }],
    criteriaRefs: [{ type: 'work', id: t2.id, version: t2.version }], priority: 1, peerUnblocking: false, lifetimeSeconds: 3600 });
  const foreign = await db.transaction((tx) => coworkRequestRows(tx).enqueue({ workspaceId: w.ws.id, projectId: p2.id,
    connectionId: f.codex.connection.id }, foreignInput, coWorkRequestFingerprint(foreignInput, f.codex.connection.id), LIMITS));
  if (foreign.status !== 'created') throw new Error('fixture enqueue failed');
  await refuse(r.take(foreign.request.id, 1), 'COWORK_REQUEST_UNAVAILABLE', foreign.request.id);
  // An expired unit lease (no re-claim) fences the recipient too.
  const next = await f.s.send(f.ask({ expectedUnitVersion: 2 }));
  await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reviewUnit]);
  await refuse(r.take(next.requestId, 1), 'COWORK_CLAIM_LOST', next.requestId);
});

test('respond negative controls: unclaimed, lost claim, version, response, sources and outer failure leave no effects', async () => {
  const f = await setup();
  const { w } = f;
  const asked = await f.s.send(f.ask());
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  const refuse = (input: AgentExecutionCommand, code: string, options: { publish?: Publisher } = {}, id = asked.requestId) =>
    refusedWithoutEffects(w, f.marekClaude, id, () => r.run(input, options), code);
  const resolve = { outcome: 'resolved', response: { title: 'Findings' } };
  await refuse(r.respond(asked.requestId, 1, resolve), 'COWORK_REQUEST_NOT_CLAIMED');
  await refuse(r.respond(asked.requestId, 1, { outcome: 'declined', reason: 'capability' }), 'COWORK_REQUEST_NOT_CLAIMED');
  await r.run(r.take(asked.requestId, 1));
  await refuse(r.respond(asked.requestId, 1, resolve), 'COWORK_VERSION_CONFLICT');
  await refuse(r.respond(asked.requestId, 2, resolve, {}, { ...r.fence, leaseId: randomUUID() }), 'COWORK_CLAIM_LOST');
  await refuse(r.respond(asked.requestId, 2, { outcome: 'declined', reason: 'later' }), 'INVALID_INPUT');
  await refuse(r.respond(asked.requestId, 2, { outcome: 'declined', reason: 'policy', response: { title: 'x' } }), 'INVALID_INPUT');
  await refuse(r.respond(asked.requestId, 2, { outcome: 'resolved', response: 'free text' }), 'INVALID_INPUT');
  await refuse(r.respond(asked.requestId, 2, { outcome: 'approved' }), 'INVALID_INPUT');
  // The response must be readable at its exact version in this transaction; the publication rolls back with the refusal.
  const missing: Publisher = async (tx, runtime, request, response) => { await publishResult(tx, runtime, request, response); return { type: 'result', id: randomUUID() }; };
  await refuse(r.respond(asked.requestId, 2, resolve), 'COWORK_RESPONSE_UNAVAILABLE', { publish: missing });
  const github: Publisher = async () => ({ type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(), headSha: 'b'.repeat(40) });
  await refuse(r.respond(asked.requestId, 2, resolve), 'COWORK_RESPONSE_UNAVAILABLE', { publish: github });
  const oldMaterial: Publisher = async () => ({ type: 'material', id: w.material.materialId, version: 2 });
  await refuse(r.respond(asked.requestId, 2, resolve), 'COWORK_RESPONSE_UNAVAILABLE', { publish: oldMaterial });
  const before = await effects(w, f.marekClaude, asked.requestId);
  await assert.rejects(r.run(r.respond(asked.requestId, 2, resolve), { failAfter: true }), /Injected failure/);
  assert.deepEqual(await effects(w, f.marekClaude, asked.requestId), before, 'an outer failure rolls back the response, transition, debit and receipt');
  const throwing: Publisher = async (tx, runtime, request, response) => { await publishResult(tx, runtime, request, response); throw new Error('publication failed'); };
  await assert.rejects(r.run(r.respond(asked.requestId, 2, resolve), { publish: throwing }), /publication failed/);
  assert.deepEqual(await effects(w, f.marekClaude, asked.requestId), before);
  // A source changed after the claim: the request cannot be resolved against it, but can be declined as source_changed.
  await pool.query("UPDATE cowork_requests SET source_refs=jsonb_build_array(jsonb_build_object('type','material','id',$2::text,'version',2)) WHERE id=$1",
    [asked.requestId, w.material.materialId]);
  await refuse(r.respond(asked.requestId, 2, resolve), 'COWORK_SOURCE_UNAVAILABLE');
  const declineCommand = r.respond(asked.requestId, 2, { outcome: 'declined', reason: 'source_changed' });
  const declined = await r.run(declineCommand);
  assert.deepEqual(declined, { requestId: asked.requestId, version: 3, state: 'declined', responseRef: null });
  const stored = await row(asked.requestId);
  assert.equal(stored.reason, 'source_changed'); assert.equal(stored.response_ref, null);
  assert.deepEqual(await r.run(declineCommand), declined, 'a content-free decline replays without source readability');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [r.respondGrant.id])).rows[0].used, 1);
});

test('lease loss returns a claimed request to recoverable pending; re-claim under the new generation; receipts follow the rows', async () => {
  const f = await setup();
  const { w } = f;
  const asked = await f.s.send(f.ask());
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  const takeCommand = r.take(asked.requestId, 1);
  await r.run(takeCommand);
  const address = { workspaceId: w.ws.id, projectId: w.p.id, connectionId: f.marekClaude.connection.id };
  const recovered = async () => (await coworkRecoveryRows(db).page(address, 10)).records.map((x) => [x.id, x.effectiveState, x.readinessReason]);
  assert.deepEqual(await recovered(), [[asked.requestId, 'claimed', null]]);
  // Historical expiry alone leaves both rows unchanged: the claim receipt is still observable, but no effect is live.
  await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reviewUnit]);
  assert.deepEqual(await recovered(), [[asked.requestId, 'queued', 'claim_lost']]);
  assert.equal((await r.run(takeCommand)).state, 'claimed', 'an unchanged expired claim is observable');
  await refusedWithoutEffects(w, f.marekClaude, asked.requestId,
    () => r.run(r.respond(asked.requestId, 2, { outcome: 'declined', reason: 'scope' })), 'COWORK_CLAIM_LOST');
  // The unit is claimed again under a new generation; the request claim is stale until it is taken again.
  const again = await claimUnit(w, f.marekClaude, f.reviewUnit, 'review', r.claim.version);
  assert.equal(again.generation, r.claim.generation + 1);
  assert.deepEqual(await recovered(), [[asked.requestId, 'queued', 'claim_lost']]);
  await rejects(r.run(takeCommand), 'COMMAND_POSTSTATE_STALE');
  const fence = { generation: again.generation, leaseId: again.lease!.id };
  await refusedWithoutEffects(w, f.marekClaude, asked.requestId,
    () => r.run(r.respond(asked.requestId, 2, { outcome: 'declined', reason: 'scope' }, {}, fence)), 'COWORK_CLAIM_LOST');
  const retaken = await r.run(r.take(asked.requestId, 2, {}, fence));
  assert.deepEqual(retaken, { requestId: asked.requestId, version: 3, state: 'claimed', responseRef: null });
  assert.equal((await row(asked.requestId)).claimed_generation, again.generation);
  assert.deepEqual(await recovered(), [[asked.requestId, 'claimed', null]]);
  await r.run(r.respond(asked.requestId, 3, { outcome: 'declined', reason: 'scope' }, {}, fence));
  assert.deepEqual(await recovered(), [], 'a declined request leaves the pending recovery page');
});

test('a newer request supersedes only earlier unclaimed requests of the same lineage, sender, recipient unit and kind', async () => {
  const f = await setup();
  const { w } = f;
  const address = { workspaceId: w.ws.id, projectId: w.p.id, connectionId: f.marekClaude.connection.id };
  // Earlier requests in three states, enqueued through storage (which never supersedes) so all three coexist.
  const earlier = async () => {
    const input = normalizeCoWorkRequest({ commandId: randomUUID(), ...f.ask() });
    const created = await db.transaction((tx) => coworkRequestRows(tx).enqueue({ workspaceId: w.ws.id, projectId: w.p.id,
      connectionId: f.codex.connection.id }, input, coWorkRequestFingerprint(input, f.codex.connection.id), LIMITS));
    if (created.status !== 'created') throw new Error('fixture enqueue failed');
    return created.request.id;
  };
  const queued = await earlier(), deferred = await earlier(), claimedOne = await earlier();
  assert.ok(await db.transaction((tx) => coworkRequestRows(tx).defer(address, deferred, 1, 'busy', 'after_tests')));
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  await r.run(r.take(claimedOne, 1));
  // Unaffected neighbours: another kind, another recipient unit, another sender.
  // The recipient's unit claim moved its version to 2; senders name the version they saw.
  const help = await f.s.send(f.ask({ kind: 'help', expectedUnitVersion: 2 }));
  const otherUnit = await w.unit(f.a.id, f.run, 'review', f.marekClaude.connection.id);
  const elsewhere = await f.s.send(f.ask({ unitId: otherUnit }));
  const claude = await w.connect(w.hubert, 'Hubert Claude');
  const claudeSender = await sender(w, claude, await w.unit(f.a.id, f.run, 'execute', claude.connection.id));
  const fromClaude = await claudeSender.send(f.ask({ expectedUnitVersion: 2 }));
  const lineage = async () => (await pool.query('SELECT created_requests, review_requests FROM cowork_request_lineages WHERE project_id=$1', [w.p.id])).rows[0];
  const budget = await lineage();

  const newest = await f.s.send(f.ask({ expectedUnitVersion: 2 }));
  assert.deepEqual(newest.supersededRequestIds, [queued, deferred].sort());
  for (const id of [queued, deferred]) {
    const prior = await row(id);
    assert.equal(prior.state, 'superseded'); assert.equal(prior.reason, 'newer_request');
  }
  assert.equal((await row(queued)).version, 2); assert.equal((await row(deferred)).version, 3);
  assert.equal((await row(claimedOne)).state, 'claimed', 'an in-flight claimed request keeps its history');
  for (const id of [help.requestId, elsewhere.requestId, fromClaude.requestId]) assert.equal((await row(id)).state, 'queued');
  assert.deepEqual(await lineage(), { created_requests: budget.created_requests + 1, review_requests: budget.review_requests + 1 },
    'supersession refunds no budget');
  // Re-issuing the same intent returns the existing request and supersedes nothing.
  const intentKey = (await row(newest.requestId)).intent_key as string;
  const reissued = await f.s.send(f.ask({ intentKey }));
  assert.equal(reissued.status, 'existing'); assert.deepEqual(reissued.supersededRequestIds, []);
  // Superseded work is closed for the recipient and leaves the pending recovery page.
  await refusedWithoutEffects(w, f.marekClaude, queued, () => r.run(r.take(queued, 2)), 'COWORK_REQUEST_CLOSED');
  const pending = (await coworkRecoveryRows(db).page(address, 10)).records.map((x) => x.id);
  assert.ok(!pending.includes(queued) && !pending.includes(deferred));
  assert.ok(pending.includes(claimedOne) && pending.includes(newest.requestId));
});

test('race: a supersession that commits first closes the request for a concurrent claim, which persists nothing', async () => {
  const f = await setup();
  const { w } = f;
  const older = await f.s.send(f.ask());
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  const ready = barrier<number>(), release = barrier();
  const admission = db.transaction(async (tx) => {
    const outcome = await coWorkRequestInTransaction(tx, f.codex.claims, f.s.cmd(f.ask({ expectedUnitVersion: 2 })), REQUESTS);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  admission.catch(() => ready.resolve(-1));
  const holder = await ready.promise; assert.ok(holder > 0);
  const before = await effects(w, f.marekClaude, older.requestId);
  const claim = r.run(r.take(older.requestId, 1));
  claim.catch(() => undefined);
  const done = settled(claim);
  await waitUntilBlockedBy(pool, holder);
  assert.equal(done(), false, 'the claim waits for the supersession to commit or roll back');
  assert.deepEqual(await waitingOn(holder), ['transactionid'], 'the claim waits on the recipient slot row, before any graph lock');
  release.resolve();
  assert.deepEqual((await admission).supersededRequestIds, [older.requestId]);
  await rejects(claim, 'COWORK_REQUEST_CLOSED');
  assert.deepEqual((await effects(w, f.marekClaude, older.requestId)).used, before.used, 'the losing claim debited nothing');
  assert.equal((await effects(w, f.marekClaude, older.requestId)).receipts, before.receipts);
  assert.equal((await row(older.requestId)).state, 'superseded');
});

test('race: a claim that commits first keeps its request out of a concurrent supersession', async () => {
  const f = await setup();
  const { w } = f;
  const older = await f.s.send(f.ask());
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  const ready = barrier<number>(), release = barrier();
  const claim = db.transaction(async (tx) => {
    const outcome = await coWorkRequestResponseInTransaction(tx, f.marekClaude.claims, r.take(older.requestId, 1), { publishResponse: publishResult });
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  claim.catch(() => ready.resolve(-1));
  const holder = await ready.promise; assert.ok(holder > 0);
  const admission = f.s.send(f.ask({ expectedUnitVersion: 2 }));
  admission.catch(() => undefined);
  const done = settled(admission);
  await waitUntilBlockedBy(pool, holder);
  assert.equal(done(), false, 'the admission waits on the recipient slot held by the claim');
  assert.deepEqual(await waitingOn(holder), ['transactionid'], 'a row lock (the recipient slot), not the graph advisory lock');
  release.resolve();
  assert.equal((await claim).state, 'claimed');
  const newer = await admission;
  assert.equal(newer.status, 'created'); assert.deepEqual(newer.supersededRequestIds, [], 'a claimed request is never superseded');
  assert.equal((await row(older.requestId)).state, 'claimed');
});

test('race: two concurrent claims of one request from one session yield exactly one effect', async () => {
  const f = await setup();
  const { w } = f;
  const asked = await f.s.send(f.ask());
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  const ready = barrier<number>(), release = barrier();
  const first = db.transaction(async (tx) => {
    const outcome = await coWorkRequestResponseInTransaction(tx, f.marekClaude.claims, r.take(asked.requestId, 1), { publishResponse: publishResult });
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  first.catch(() => ready.resolve(-1));
  const holder = await ready.promise; assert.ok(holder > 0);
  const second = r.run(r.take(asked.requestId, 1));
  second.catch(() => undefined);
  await waitUntilBlockedBy(pool, holder);
  release.resolve();
  assert.equal((await first).version, 2);
  await rejects(second, 'COWORK_VERSION_CONFLICT');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [r.claimGrant.id])).rows[0].used, 1, 'one debit');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1 AND operation='cowork.request.claim'",
    [f.marekClaude.connection.id])).rows[0].n, 1, 'one receipt');
  assert.equal((await row(asked.requestId)).version, 2);
});

test('the grant registry reserves exactly the recipient operations; a request or claim grant cannot stand in for them', async () => {
  const f = await setup();
  const { w } = f;
  const asked = await f.s.send(f.ask());
  const r = await recipient(w, f.marekClaude, f.reviewUnit);
  // The sender's own request grant, and the recipient's unit claim grant, are not request-claim grants.
  const claimGrant = await grantOf(w, f.marekClaude, 'cowork.claim', f.reviewUnit, 'review');
  await refusedWithoutEffects(w, f.marekClaude, asked.requestId, () => r.run(r.take(asked.requestId, 1, { grantId: claimGrant.id })), 'AGENT_EXECUTION_UNAVAILABLE');
  await refusedWithoutEffects(w, f.marekClaude, asked.requestId, () => r.run(r.take(asked.requestId, 1, { grantId: r.respondGrant.id })), 'AGENT_EXECUTION_UNAVAILABLE');
  // The recipient's unit is the only exact target: the sender's unit is refused at grant creation.
  expectStatus(await w.actionGrant(w.marek, f.marekClaude.connection.id, 'cowork.request.respond', f.senderUnit, 'execute'), 404);
  await assert.rejects(pool.query(`INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,
    request_fingerprint,operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'cowork.request.ack','review',1,now()+interval '1 hour')`,
  [randomUUID(), w.ws.id, w.p.id, f.marekClaude.connection.id, w.marek.id, randomUUID(), 'a'.repeat(64)]),
  (error: unknown) => (error as { constraint?: string }).constraint === 'agent_standing_grants_operation_check');
  const definition = (await pool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='agent_standing_grants_operation_check'")).rows[0].d as string;
  assert.ok(definition.includes("'cowork.request.claim'::text") && definition.includes("'cowork.request.respond'::text"));
});

test('the Agents view shows each connection its held unit and its open request with the request state (#160 AC-5)', async () => {
  const f = await setup();
  const asked = await f.s.send(f.ask());
  const view = async () => expectStatus(await f.w.hubert.browser.request('GET', `/api/v1/projects/${f.w.p.id}/agents`), 200) as ProjectAgents;
  const reviewer = (listed: ProjectAgents) => listed.connections.find((item) => item.id === f.marekClaude.connection.id)!;
  const before = reviewer(await view());
  assert.deepEqual(before.currentWork, { taskId: f.a.id, taskTitle: f.a.title, role: 'review', state: 'pending' }, 'assigned, not yet claimed');
  assert.deepEqual(before.requests, [{ id: asked.requestId, kind: 'review', state: 'queued', reason: null, taskId: f.a.id, taskTitle: f.a.title,
    sender: { connectionId: f.codex.connection.id, name: f.codex.connection.name, ownerName: before.requests[0]!.sender.ownerName } }]);
  assert.equal(typeof before.requests[0]!.sender.ownerName, 'string');
  assert.deepEqual((await view()).connections.find((item) => item.id === f.codex.connection.id)!.requests, [], 'the sender has no request to answer');
  const r = await recipient(f.w, f.marekClaude, f.reviewUnit);
  await r.run(r.take(asked.requestId, 1));
  const claimed = reviewer(await view());
  assert.equal(claimed.requests[0]!.state, 'claimed');
  assert.equal(claimed.currentWork!.state, 'claimed');
});
