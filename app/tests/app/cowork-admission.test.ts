import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentStandingGrant, CoWorkRequestLimits, WorkItem } from '@flux/contracts';
import { coworkRecoveryRows, coworkRequestRows, createDatabase, schema } from '@flux/db';
import { coWorkRequestFingerprint, DomainError, normalizeCoWorkRequest } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { coWorkClaimInTransaction, type CoWorkClaimPolicy } from '../../apps/server/src/co-work/claims.js';
import { coWorkTaskGraphLocks } from '../../apps/server/src/co-work/graph.js';
import { coWorkRequestInTransaction, type CoWorkRequestPolicy } from '../../apps/server/src/co-work/requests.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';

// Live sender-unit request admission (#153) over real #152 runtimes/grants/ledger and PostgreSQL.
// Bearer bindings are trusted fixtures and units are inserted directly (no unit creation command exists
// yet). This is not model activation, a public tool or real-client evidence.
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const LIMITS: CoWorkRequestLimits = { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 };
const POLICY: CoWorkRequestPolicy = { limits: LIMITS, reviewSeparation: 'distinct_connection' };
type Role = 'execute' | 'review' | 'plan';

async function world() {
  const hubert = await person('cowork-admission-hubert'), marek = await person('cowork-admission-marek');
  const ws = await workspace(hubert, 'Admission workspace');
  await addMember(hubert, ws.id, marek, 'member');
  const p = await project(hubert, ws.id, 'Addressed review', 'restricted');
  await grant(hubert, p.id, marek, 'contributor');
  const task = async (title: string) =>
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title } }), 201) as WorkItem;
  const connect = async (who: Person, name: string, sender: boolean) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name, owner: 'self' } }), 201) as Agent;
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const connection = expectStatus(await who.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: agent.id, selectedProjectIds: [p.id], scopes: ['flux.context.read', 'flux.action.execute'] } }), 201) as AgentConnection;
    if (!sender) return { who, connection, claims: null, runtimeId: null };
    const clientId = `cowork-admission-${randomUUID()}`, bindingId = randomUUID();
    await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
      [randomUUID(), clientId, 'Trusted admission fixture', ['https://fixture.invalid/callback']]);
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
  const actionGrant = async (who: Person, connectionId: string, operation: string, objectId: string | null, role: Role, maximumUses = 10) =>
    who.browser.request('POST', `/api/v1/agent-connections/${connectionId}/action-grants`,
      { body: { clientCommandId: randomUUID(), projectId: p.id, operation, ...(objectId ? { objectId } : {}),
        peerRequestClass: role, maximumUses, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
  const material = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Review criteria', body: 'Exact current revision' } }), 201) as { materialId: string };
  return { hubert, marek, ws, p, task, connect, unit, actionGrant, material };
}
type World = Awaited<ReturnType<typeof world>>;
type Connected = Awaited<ReturnType<World['connect']>>;

/** A sender with its own live claim (through the real claim composition and the production graph provider). */
async function sender(w: World, s: Connected, unitId: string, role: Role = 'execute', maximumUses = 10) {
  const claimGrant = expectStatus(await w.actionGrant(s.who, s.connection.id, 'cowork.claim', unitId, role), 201) as AgentStandingGrant;
  const policy: CoWorkClaimPolicy = { maximumConnectionUnits: 1, leaseSeconds: 120,
    prepareTaskLocks: (tx, context, units) => coWorkTaskGraphLocks(tx, context.workspaceId, units),
    async requireEligible() {}, async requireCheckpointSources() {} };
  const claim = await db.transaction((tx) => coWorkClaimInTransaction(tx, s.claims!, { runtimeSessionId: s.runtimeId!, grantId: claimGrant.id,
    clientCommandId: randomUUID(), projectId: w.p.id, operation: 'cowork.claim', peerRequestClass: role,
    audience: { kind: 'project', projectId: w.p.id }, objectId: unitId, sources: [], payload: { expectedVersion: 1 } }, policy));
  const requestGrant = expectStatus(await w.actionGrant(s.who, s.connection.id, 'cowork.request', unitId, role, maximumUses), 201) as AgentStandingGrant;
  const command = (request: Record<string, unknown>, change: Partial<AgentExecutionCommand> = {}, fence = { generation: claim.generation, leaseId: claim.lease!.id }): AgentExecutionCommand => ({
    runtimeSessionId: s.runtimeId!, grantId: requestGrant.id, clientCommandId: randomUUID(), projectId: w.p.id, operation: 'cowork.request',
    peerRequestClass: role, audience: { kind: 'project', projectId: w.p.id }, objectId: unitId, sources: [],
    payload: { ...fence, request } as AgentExecutionCommand['payload'], ...change });
  const admit = (input: AgentExecutionCommand, policy = POLICY, options: { failAfter?: boolean; claims?: Connected['claims'] } = {}) =>
    db.transaction(async (tx) => {
      const outcome = await coWorkRequestInTransaction(tx, options.claims ?? s.claims!, input, policy);
      if (options.failAfter) throw new Error('Injected failure after admission/debit/receipt');
      return outcome;
    });
  return { claim, requestGrant, command, admit, unitId };
}
function rejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code, code);
}
async function count(table: string, column: string, value: string) {
  return (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [value])).rows[0].n as number;
}
/** Every refusal leaves no request, delivery, lineage budget, grant use or receipt. */
async function noEffects(w: World, s: Connected, grantId: string) {
  assert.equal(await count('cowork_requests', 'project_id', w.p.id), 0, 'no request');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cowork_delivery_intents d JOIN cowork_requests r ON r.id=d.request_id WHERE r.project_id=$1', [w.p.id])).rows[0].n, 0);
  assert.equal(await count('cowork_request_lineages', 'project_id', w.p.id), 0, 'no lineage budget opened');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grantId])).rows[0].used, 0, 'no grant use');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1 AND operation='cowork.request'", [s.connection.id])).rows[0].n, 0);
}

async function reviewSetup() {
  const w = await world();
  const a = await w.task('Native outcome A'); const run = randomUUID();
  const codex = await w.connect(w.hubert, 'Hubert Codex', true);
  const marekClaude = await w.connect(w.marek, 'Marek Claude', false);
  const senderUnit = await w.unit(a.id, run, 'execute', codex.connection.id);
  const reviewUnit = await w.unit(a.id, run, 'review', marekClaude.connection.id);
  const s = await sender(w, codex, senderUnit);
  const request = (change: Record<string, unknown> = {}) => ({ unitId: reviewUnit, expectedUnitVersion: 1,
    recipientConnectionId: marekClaude.connection.id, intentKey: 'review-a', parentRequestId: null, kind: 'review',
    target: { type: 'work', id: a.id, version: a.version }, sourceRefs: [{ type: 'material', id: w.material.materialId, version: 1 }],
    criteriaRefs: [{ type: 'work', id: a.id, version: a.version }], priority: 1, peerUnblocking: true, lifetimeSeconds: 3600, ...change });
  return { w, a, run, codex, marekClaude, senderUnit, reviewUnit, s, request };
}

test('a live sender claim admits one request, delivery intent, debit and canonical receipt; exact replay observes it', async () => {
  const f = await reviewSetup();
  const command = f.s.command(f.request());
  const created = await f.s.admit(command);
  assert.equal(created.status, 'created'); assert.equal(created.state, 'queued'); assert.equal(created.version, 1);
  const [row] = await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.id, created.requestId));
  assert.equal(row!.senderConnectionId, f.codex.connection.id); assert.equal(row!.recipientConnectionId, f.marekClaude.connection.id);
  assert.equal(row!.recipientOwnerId, f.w.marek.id); assert.equal(row!.unitId, f.reviewUnit);
  assert.equal(await count('cowork_delivery_intents', 'request_id', created.requestId), 1);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.s.requestGrant.id])).rows[0].used, 1);
  const receipts = await pool.query("SELECT * FROM agent_command_receipts WHERE connection_id=$1 AND operation='cowork.request'", [f.codex.connection.id]);
  assert.equal(receipts.rows.length, 1);
  assert.deepEqual(receipts.rows[0].postconditions, [{ kind: 'cowork.request_state', workspaceId: f.w.ws.id, projectId: f.w.p.id,
    connectionId: f.codex.connection.id, unitId: f.senderUnit, requestId: created.requestId, role: 'execute', version: 1, state: 'queued' }]);
  // Selecting Marek's connection manufactured no claim, lease or grant for it.
  const [review] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, f.reviewUnit));
  assert.equal(review!.state, 'pending'); assert.equal(review!.leaseId, null);
  assert.equal(await count('agent_standing_grants', 'connection_id', f.marekClaude.connection.id), 0);

  assert.deepEqual(await f.s.admit(command), created, 'exact replay returns the original effect');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.s.requestGrant.id])).rows[0].used, 1);
  assert.equal(await count('cowork_requests', 'project_id', f.w.p.id), 1);
  await rejects(f.s.admit({ ...command, payload: { ...(command.payload as object), request: f.request({ priority: 3 }) } }), 'IDEMPOTENCY_CONFLICT');

  // The recipient's transition makes the old receipt stale; a new command for the same intent returns the same request.
  const deferred = await db.transaction((tx) => coworkRequestRows(tx).defer({ workspaceId: f.w.ws.id, projectId: f.w.p.id,
    connectionId: f.marekClaude.connection.id }, created.requestId, 1, 'busy', 'after_tests'));
  assert.equal(deferred!.version, 2);
  await rejects(f.s.admit(command), 'COMMAND_POSTSTATE_STALE');
  const again = await f.s.admit(f.s.command(f.request()));
  assert.deepEqual(again, { ...created, status: 'existing', version: 2, state: 'deferred' });
  assert.equal(await count('cowork_delivery_intents', 'request_id', created.requestId), 1, 'no second delivery');
  assert.equal((await pool.query('SELECT created_requests FROM cowork_request_lineages WHERE project_id=$1', [f.w.p.id])).rows[0].created_requests, 1);
});

test('sender fence: no claim, wrong lease/generation, another session, expiry, pause or wrong role all refuse without effects', async () => {
  const w = await world();
  const a = await w.task('Native outcome A'); const run = randomUUID();
  const codex = await w.connect(w.hubert, 'Hubert Codex', true);
  const marekClaude = await w.connect(w.marek, 'Marek Claude', false);
  const senderUnit = await w.unit(a.id, run, 'execute', codex.connection.id);
  const reviewUnit = await w.unit(a.id, run, 'review', marekClaude.connection.id);
  const request = { unitId: reviewUnit, expectedUnitVersion: 1, recipientConnectionId: marekClaude.connection.id, intentKey: 'review-a',
    parentRequestId: null, kind: 'review', target: { type: 'work', id: a.id, version: a.version },
    sourceRefs: [{ type: 'work', id: a.id, version: a.version }], criteriaRefs: [{ type: 'work', id: a.id, version: a.version }],
    priority: 1, peerUnblocking: false, lifetimeSeconds: 3600 };
  // Unclaimed: a request grant alone is not a live claim.
  const early = expectStatus(await w.actionGrant(w.hubert, codex.connection.id, 'cowork.request', senderUnit, 'execute'), 201) as AgentStandingGrant;
  const unclaimed: AgentExecutionCommand = { runtimeSessionId: codex.runtimeId!, grantId: early.id, clientCommandId: randomUUID(), projectId: w.p.id,
    operation: 'cowork.request', peerRequestClass: 'execute', audience: { kind: 'project', projectId: w.p.id }, objectId: senderUnit, sources: [],
    payload: { generation: 1, leaseId: randomUUID(), request } };
  await rejects(db.transaction((tx) => coWorkRequestInTransaction(tx, codex.claims!, unclaimed, POLICY)), 'COWORK_CLAIM_LOST');
  await noEffects(w, codex, early.id);

  const s = await sender(w, codex, senderUnit);
  const fence = { generation: s.claim.generation, leaseId: s.claim.lease!.id };
  await rejects(s.admit(s.command(request, {}, { ...fence, leaseId: randomUUID() })), 'COWORK_CLAIM_LOST');
  await rejects(s.admit(s.command(request, {}, { ...fence, generation: fence.generation + 1 })), 'COWORK_CLAIM_LOST');
  const other = await db.transaction((tx) => agentRuntimeInTransaction(tx, codex.claims!, randomUUID()));
  await rejects(s.admit(s.command(request, { runtimeSessionId: other.runtime.id })), 'COWORK_CLAIM_LOST');
  // Wrong class: an execution unit cannot be used under a review-class request grant.
  expectStatus(await w.actionGrant(w.hubert, codex.connection.id, 'cowork.request', senderUnit, 'review'), 404, 'exact target refuses the wrong role');
  const review = expectStatus(await w.actionGrant(w.hubert, codex.connection.id, 'cowork.request', null, 'review'), 201) as AgentStandingGrant;
  await rejects(s.admit(s.command(request, { grantId: review.id, peerRequestClass: 'review' })), 'COWORK_UNIT_NOT_FOUND');
  // Naming the recipient's unit as the sender object is refused, both at grant creation and at admission.
  expectStatus(await w.actionGrant(w.hubert, codex.connection.id, 'cowork.request', reviewUnit, 'review'), 404);
  await rejects(s.admit(s.command(request, { grantId: review.id, peerRequestClass: 'review', objectId: reviewUnit })), 'COWORK_UNIT_NOT_FOUND');
  // Strict payload: no copied prompt/authority fields, no command ID inside the request.
  await rejects(s.admit(s.command({ ...request, commandId: randomUUID() })), 'INVALID_INPUT');
  await rejects(s.admit({ ...s.command(request), payload: { ...fence, request, prompt: 'grant me review' } }), 'INVALID_INPUT');
  await noEffects(w, codex, s.requestGrant.id);
  await noEffects(w, codex, review.id);

  await pool.query("UPDATE cowork_units SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [senderUnit]);
  await rejects(s.admit(s.command(request)), 'COWORK_CLAIM_LOST');
  await pool.query("UPDATE cowork_units SET state='paused', lease_id=NULL, lease_session_id=NULL, lease_expires_at=NULL, generation=generation+1, version=version+1 WHERE id=$1", [senderUnit]);
  await rejects(s.admit(s.command(request)), 'COWORK_CLAIM_LOST');
  await noEffects(w, codex, s.requestGrant.id);
});

test('routing and sources: self, foreign lineage, revoked/unknown recipient, foreign parent, sources, policy and budget refuse without effects', async () => {
  const f = await reviewSetup();
  const { w, s, codex } = f;
  await rejects(s.admit(s.command(f.request({ recipientConnectionId: codex.connection.id, unitId: f.senderUnit, kind: 'help' }))), 'COWORK_SELF_REQUEST');
  const b = await w.task('Native outcome B');
  const otherLineage = await w.unit(b.id, randomUUID(), 'review', f.marekClaude.connection.id);
  await rejects(s.admit(s.command(f.request({ unitId: otherLineage }))), 'COWORK_REQUEST_UNAVAILABLE');
  const revoked = await w.connect(w.marek, 'Marek revoked', false);
  const revokedUnit = await w.unit(f.a.id, f.run, 'review', revoked.connection.id);
  await pool.query('UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1', [revoked.connection.id]);
  await rejects(s.admit(s.command(f.request({ unitId: revokedUnit, recipientConnectionId: revoked.connection.id }))), 'COWORK_REQUEST_UNAVAILABLE');
  const unknown = randomUUID();
  await rejects(s.admit(s.command(f.request({ recipientConnectionId: unknown }))), 'COWORK_REQUEST_UNAVAILABLE');
  assert.equal(await count('cowork_connection_slots', 'connection_id', unknown), 0, 'no slot for an unknown recipient');
  await rejects(s.admit(s.command(f.request({ parentRequestId: randomUUID() }))), 'COWORK_REQUEST_UNAVAILABLE');
  await rejects(s.admit(s.command(f.request({ sourceRefs: [{ type: 'material', id: w.material.materialId, version: 2 }] }))), 'COWORK_SOURCE_UNAVAILABLE');
  await rejects(s.admit(s.command(f.request({ target: { type: 'message', id: randomUUID() } }))), 'COWORK_SOURCE_UNAVAILABLE');
  await rejects(s.admit(s.command(f.request({ sourceRefs: [{ type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(),
    headSha: 'a'.repeat(40) }] }))), 'COWORK_SOURCE_UNAVAILABLE');
  // A same-owner (Hubert's Claude) reviewer is refused only under the stricter project policy.
  const claude = await w.connect(w.hubert, 'Hubert Claude', false);
  const sameOwner = await w.unit(f.a.id, f.run, 'review', claude.connection.id);
  const toClaude = f.request({ unitId: sameOwner, recipientConnectionId: claude.connection.id, intentKey: 'review-a-claude' });
  await rejects(s.admit(s.command(toClaude), { ...POLICY, reviewSeparation: 'distinct_owner' }), 'COWORK_REVIEW_SEPARATION');
  await assert.rejects(s.admit(s.command(f.request()), POLICY, { failAfter: true }), /Injected failure after admission/);
  await noEffects(w, codex, s.requestGrant.id);
  assert.equal(await count('cowork_requests', 'project_id', w.p.id), 0, 'outer failure rolled the admitted request back');

  const tight = { ...POLICY, limits: { ...LIMITS, maximumRequests: 1 } };
  assert.equal((await s.admit(s.command(toClaude), tight)).status, 'created', 'explicit same-owner review is allowed by default');
  await rejects(s.admit(s.command(f.request()), tight), 'COWORK_BUDGET_EXHAUSTED');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [s.requestGrant.id])).rows[0].used, 1);
  assert.equal(await count('cowork_requests', 'project_id', w.p.id), 1);
});

test('recipient slot is held through commit: a late committer cannot fall behind a recovery position (F2)', async () => {
  const w = await world();
  const a = await w.task('Lineage A'), b = await w.task('Lineage B');
  const runA = randomUUID(), runB = randomUUID();
  const codex = await w.connect(w.hubert, 'Hubert Codex', true), claude = await w.connect(w.hubert, 'Hubert Claude', true);
  const marekClaude = await w.connect(w.marek, 'Marek Claude', false);
  const sa = await sender(w, codex, await w.unit(a.id, runA, 'execute', codex.connection.id));
  const sb = await sender(w, claude, await w.unit(b.id, runB, 'execute', claude.connection.id));
  const reviewA = await w.unit(a.id, runA, 'review', marekClaude.connection.id), reviewB = await w.unit(b.id, runB, 'review', marekClaude.connection.id);
  const ask = (task: WorkItem, unitId: string, intentKey: string) => ({ unitId, expectedUnitVersion: 1, recipientConnectionId: marekClaude.connection.id,
    intentKey, parentRequestId: null, kind: 'review', target: { type: 'work', id: task.id, version: task.version },
    sourceRefs: [{ type: 'work', id: task.id, version: task.version }], criteriaRefs: [{ type: 'work', id: task.id, version: task.version }],
    priority: 1, peerUnblocking: false, lifetimeSeconds: 3600 });
  const old = await sa.admit(sa.command(ask(a, reviewA, 'old')));
  const recipient = { workspaceId: w.ws.id, projectId: w.p.id, connectionId: marekClaude.connection.id };

  const readyA = barrier<number>(), releaseA = barrier(), readyB = barrier<number>(), releaseB = barrier();
  const txA = db.transaction(async (tx) => {
    const outcome = await coWorkRequestInTransaction(tx, codex.claims!, sa.command(ask(a, reviewA, 'late-a')), POLICY);
    // The production provider took the project graph lock before any task lock.
    const advisory = await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted", [await backendPid(tx)]);
    assert.ok(advisory.rows[0].n >= 1, 'project graph advisory lock held');
    readyA.resolve(await backendPid(tx)); await releaseA.promise; return outcome;
  });
  txA.catch(() => readyA.resolve(-1));
  const pidA = await readyA.promise; assert.ok(pidA > 0);
  const txB = db.transaction(async (tx) => {
    const outcome = await coWorkRequestInTransaction(tx, claude.claims!, sb.command(ask(b, reviewB, 'late-b')), POLICY);
    readyB.resolve(await backendPid(tx)); await releaseB.promise; return outcome;
  });
  txB.catch(() => readyB.resolve(-1));
  const bDone = settled(readyB.promise);
  await waitUntilBlockedBy(pool, pidA); // B waits on the recipient slot only: distinct senders, tasks and lineages
  assert.equal(bDone(), false, 'B cannot assign its timestamp while A is uncommitted');
  let page = await coworkRecoveryRows(db).page(recipient, 1);
  assert.deepEqual(page.records.map((r) => r.id), [old.requestId]); assert.equal(page.continuation, null);
  releaseA.resolve(); const late = await txA;
  assert.ok(await readyB.promise > 0);
  // Window 2: A committed, B uncommitted. A reader can now hold a position at A.
  page = await coworkRecoveryRows(db).page(recipient, 1);
  assert.deepEqual(page.records.map((r) => r.id), [old.requestId]);
  page = await coworkRecoveryRows(db).page(recipient, 1, page.continuation!);
  assert.deepEqual(page.records.map((r) => r.id), [late.requestId]);
  const positionA = (await pool.query('SELECT created_at::text AS at FROM cowork_requests WHERE id=$1', [late.requestId])).rows[0].at as string;
  releaseB.resolve(); const lateB = await txB;
  const continued = await coworkRecoveryRows(db).page(recipient, 10, { createdAt: positionA, id: late.requestId });
  assert.deepEqual(continued.records.map((r) => r.id), [lateB.requestId], 'continuing from A still reaches B');
  const order = await pool.query('SELECT id FROM cowork_requests WHERE recipient_connection_id=$1 ORDER BY created_at, id', [marekClaude.connection.id]);
  assert.deepEqual(order.rows.map((r) => r.id), [old.requestId, late.requestId, lateB.requestId]);
});

test('negative control: the same distinct-lineage interleaving through raw storage without slots loses a late committer', async () => {
  const w = await world();
  const a = await w.task('Lineage A'), b = await w.task('Lineage B');
  const runA = randomUUID(), runB = randomUUID();
  const codex = await w.connect(w.hubert, 'Hubert Codex', false), claude = await w.connect(w.hubert, 'Hubert Claude', false);
  const marekClaude = await w.connect(w.marek, 'Marek Claude', false);
  const reviewA = await w.unit(a.id, runA, 'review', marekClaude.connection.id), reviewB = await w.unit(b.id, runB, 'review', marekClaude.connection.id);
  const recipient = { workspaceId: w.ws.id, projectId: w.p.id, connectionId: marekClaude.connection.id };
  const raw = (from: string, task: WorkItem, unitId: string, intentKey: string) => {
    const input = normalizeCoWorkRequest({ commandId: randomUUID(), unitId, expectedUnitVersion: 1, recipientConnectionId: marekClaude.connection.id,
      intentKey, parentRequestId: null, kind: 'review', target: { type: 'work', id: task.id, version: task.version },
      sourceRefs: [{ type: 'work', id: task.id, version: task.version }], criteriaRefs: [{ type: 'work', id: task.id, version: task.version }],
      priority: 1, peerUnblocking: false, lifetimeSeconds: 3600 });
    return { sender: { workspaceId: w.ws.id, projectId: w.p.id, connectionId: from }, input, fingerprint: coWorkRequestFingerprint(input, from) };
  };
  const enqueue = async (tx: Parameters<typeof coworkRequestRows>[0], r: ReturnType<typeof raw>) => {
    const result = await coworkRequestRows(tx).enqueue(r.sender, r.input, r.fingerprint, LIMITS);
    assert.equal(result.status, 'created'); if (result.status !== 'created') throw new Error('unreachable');
    return result.request.id;
  };
  const ready = barrier<string>(), release = barrier();
  const txA = db.transaction(async (tx) => { const id = await enqueue(tx, raw(codex.connection.id, a, reviewA, 'late-a')); ready.resolve(id); await release.promise; return id; });
  txA.catch(() => ready.resolve(''));
  const lateA = await ready.promise; assert.ok(lateA);
  const bId = await db.transaction((tx) => enqueue(tx, raw(claude.connection.id, b, reviewB, 'b1')));
  const dId = await db.transaction((tx) => enqueue(tx, raw(claude.connection.id, b, reviewB, 'b2')));
  const first = await coworkRecoveryRows(db).page(recipient, 1);
  assert.deepEqual(first.records.map((r) => r.id), [bId]);
  release.resolve(); await txA;
  const next = await coworkRecoveryRows(db).page(recipient, 10, first.continuation!);
  assert.deepEqual(next.records.map((r) => r.id), [dId], 'the hazard: the late committer is behind the retained position');
  const order = await pool.query('SELECT id FROM cowork_requests WHERE recipient_connection_id=$1 ORDER BY created_at, id', [marekClaude.connection.id]);
  assert.deepEqual(order.rows.map((r) => r.id), [lateA, bId, dId]);
});

test('production graph provider adds direct prerequisites to the complete task lock set', async () => {
  const f = await reviewSetup();
  const pre = await f.w.task('Prerequisite');
  const current = expectStatus(await f.w.hubert.browser.request('GET', `/api/v1/work/${f.a.id}`), 200) as WorkItem;
  const linked = expectStatus(await f.w.hubert.browser.request('PATCH', `/api/v1/work/${f.a.id}`,
    { body: { dependencyIds: [pre.id] }, headers: { 'if-match': `"${current.version}"` } }), 200) as WorkItem;
  const ready = barrier<number>(), release = barrier();
  const held = db.transaction(async (tx) => {
    const outcome = await coWorkRequestInTransaction(tx, f.codex.claims!, f.s.command(f.request({
      target: { type: 'work', id: f.a.id, version: linked.version }, criteriaRefs: [{ type: 'work', id: f.a.id, version: linked.version }] })), POLICY);
    ready.resolve(await backendPid(tx)); await release.promise; return outcome;
  });
  held.catch(() => ready.resolve(-1));
  assert.ok(await ready.promise > 0);
  try {
    // NOWAIT proves the admission transaction holds the prerequisite row, without timing assumptions.
    await assert.rejects(pool.query('SELECT id FROM project_work_items WHERE id=$1 FOR UPDATE NOWAIT', [pre.id]),
      (error: unknown) => (error as { code?: string }).code === '55P03');
    // Negative control: an unrelated task of the same project is not locked.
    const unrelated = await f.w.task('Unrelated');
    assert.equal((await pool.query('SELECT id FROM project_work_items WHERE id=$1 FOR UPDATE NOWAIT', [unrelated.id])).rows.length, 1);
  } finally { release.resolve(); }
  assert.equal((await held).status, 'created');
});
