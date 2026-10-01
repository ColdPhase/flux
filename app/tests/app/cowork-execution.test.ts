import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentStandingGrant, WorkItem } from '@flux/contracts';
import { coworkUnitRows, createDatabase, schema } from '@flux/db';
import { DomainError } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { coWorkClaimInTransaction, type CoWorkClaimPolicy } from '../../apps/server/src/co-work/claims.js';
import { expectStatus, person, project, workspace } from './support/people.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';

// Real native API/runtime/grant/SQL ledger composition. The bearer binding and
// policy callbacks are trusted fixtures, not model activation or complete native
// dependency/reviewer/checkpoint policy acceptance. Public tools stay disabled.
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
async function fixture(maximumUses = 1, seconds = 30) {
  const owner = await person('co-work-execution'); const ws = await workspace(owner, 'Execution workspace');
  const p = await project(owner, ws.id, 'Native co-work', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Co-work executor', owner: 'self' } }), 201) as Agent;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId: agent.id, selectedProjectIds: [p.id], scopes: ['flux.context.read', 'flux.action.execute'] } }), 201) as AgentConnection;
  const clientId = `cowork-fixture-${randomUUID()}`, bindingId = randomUUID();
  await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
    [randomUUID(), clientId, 'Trusted co-work boundary fixture', ['https://fixture.invalid/callback']]);
  await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)',
    [bindingId, owner.id, connection.id, clientId]);
  const claims = { ownerUserId: owner.id, connectionId: connection.id, clientId,
    grantReferenceId: `flux-grant:${bindingId}`, scopes: connection.scopes };
  const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, randomUUID()));
  const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/work`,
    { body: { title: 'One bounded native unit' } }), 201) as WorkItem;
  const source = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Current source', body: 'Current exact revision' } }), 201) as { materialId: string };
  const unitId = randomUUID();
  await db.insert(schema.coworkUnits).values({ id: unitId, workspaceId: ws.id, projectId: p.id, taskId: work.id,
    lineageTaskId: work.id, runId: randomUUID(), unitKey: unitId, role: 'execute', assignmentConnectionId: connection.id });
  const grant = async (operation: 'claim' | 'renew' | 'release' = 'claim', objectId: string | null = unitId, role: 'execute' | 'review' | 'plan' = 'execute') =>
    expectStatus(await owner.browser.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`,
      { body: { clientCommandId: randomUUID(), projectId: p.id, operation: `cowork.${operation}`, ...(objectId ? { objectId } : {}),
        peerRequestClass: role, maximumUses, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as AgentStandingGrant;
  const ceiling = await grant();
  const command: AgentExecutionCommand = { runtimeSessionId: runtime.id, grantId: ceiling.id, clientCommandId: randomUUID(),
    projectId: p.id, operation: 'cowork.claim', peerRequestClass: 'execute', audience: { kind: 'project', projectId: p.id },
    objectId: unitId, sources: [{ materialId: source.materialId, version: 1 }], payload: { expectedVersion: 1 } };
  const preparations: { observation: boolean }[] = [];
  const policy: CoWorkClaimPolicy = {
    maximumConnectionUnits: 1, leaseSeconds: seconds,
    async prepareTaskLocks(_tx, context, units) {
      assert.equal(context.id, runtime.id);
      assert.ok(units.every((unit) => unit.projectId === p.id));
      return []; // No graph fixture: the real native graph provider is still mandatory pending work.
    },
    async requireEligible(tx, context, unit, action) {
      assert.equal(unit.assignmentConnectionId, context.connectionId);
      const [task] = await tx.select().from(schema.projectWorkItems).where(eq(schema.projectWorkItems.id, unit.taskId));
      assert.equal(task!.projectId, p.id);
      preparations.push({ observation: action.observation });
    },
    async requireCheckpointSources(tx, context, checkpoint, input) {
      assert.equal(checkpoint.workspaceId, context.workspaceId); assert.equal(checkpoint.projectId, input.projectId);
      const refs = (checkpoint.progress as { sources?: { materialId: string; version: number }[] }).sources;
      if (!Array.isArray(refs)) throw new DomainError(409, 'COWORK_CHECKPOINT_SOURCES_REQUIRED', 'Checkpoint source coverage required');
      for (const ref of refs) {
        if (!input.sources.some((known) => known.materialId === ref.materialId && known.version === ref.version))
          throw new DomainError(409, 'COWORK_CHECKPOINT_SOURCES_REQUIRED', 'Checkpoint source coverage required');
        // Already locked by actual152 prepare; this does not acquire a late material lock.
        const [row] = await tx.select().from(schema.projectMaterials).where(eq(schema.projectMaterials.id, ref.materialId));
        if (!row || row.workspaceId !== context.workspaceId || row.projectId !== input.projectId || row.currentVersion !== ref.version)
          throw new DomainError(409, 'SOURCE_VERSION_CONFLICT', 'Checkpoint source changed');
      }
    },
  };
  const run = (input = command, options: { failAfter?: boolean; policy?: CoWorkClaimPolicy } = {}) => db.transaction(async (tx) => {
    const outcome = await coWorkClaimInTransaction(tx, claims, input, options.policy ?? policy);
    if (options.failAfter) throw new Error('Injected failure after claim/debit/receipt');
    return outcome;
  });
  const state = async () => (await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, unitId)))[0]!;
  return { owner, ws, p, agent, connection, claims, runtime, work, source, unitId, ceiling, grant, command, policy, preparations, run, state };
}
function rejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
}

test('actual concurrent claim commands share one lease/effect/ledger and exhausted replay preserves the original expiry', async () => {
  const f = await fixture(1, 1);
  const [a, b] = await Promise.all([f.run(), f.run()]); assert.deepEqual(a, b);
  assert.equal(a.lease!.runtimeSessionId, f.runtime.id);
  assert.equal((await f.state()).version, 2);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, a.lease!.expiresAt.getTime() - Date.now()) + 25));
  assert.deepEqual(await f.run(), a, 'historical expiry is observed; replay cannot renew/reacquire');
  assert.equal((await f.state()).version, 2); assert.equal((await f.state()).generation, 1);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.ceiling.id])).rows[0].used, 1);
  const receipts = await pool.query('SELECT * FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id]);
  assert.equal(receipts.rows.length, 1); assert.equal(receipts.rows[0].runtime_session_id, f.runtime.id);
  assert.equal(receipts.rows[0].postconditions[0].leaseExpiresAt, a.lease!.expiresAt.toISOString());
  assert.deepEqual(f.preparations.map((item) => item.observation).sort(), [false, true, true]);
  await rejects(f.run({ ...f.command, clientCommandId: randomUUID() }), 'AGENT_EXECUTION_UNAVAILABLE');
});

test('changed command payload/session/operation conflicts without changing the original claim', async () => {
  const f = await fixture(2); const first = await f.run();
  await rejects(f.run({ ...f.command, payload: { expectedVersion: 2 } }), 'IDEMPOTENCY_CONFLICT');
  const other = await db.transaction((tx) => agentRuntimeInTransaction(tx, f.claims, randomUUID()));
  await rejects(f.run({ ...f.command, runtimeSessionId: other.runtime.id }), 'IDEMPOTENCY_CONFLICT');
  const grant = await f.grant('renew');
  await rejects(f.run({ ...f.command, grantId: grant.id, operation: 'cowork.renew',
    payload: { expectedVersion: first.version, generation: first.generation, leaseId: first.lease!.id } }), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.state()).version, 2); assert.equal((await f.state()).leaseId, first.lease!.id);
});

test('renewal and checkpoint-backed release use one shared ledger and make earlier receipts visibly stale', async () => {
  const f = await fixture(); const first = await f.run();
  const renewGrant = await f.grant('renew');
  const renew = { ...f.command, grantId: renewGrant.id, clientCommandId: randomUUID(), operation: 'cowork.renew' as const,
    payload: { expectedVersion: first.version, generation: first.generation, leaseId: first.lease!.id } };
  const renewed = await f.run(renew); assert.equal(renewed.lease!.id, first.lease!.id); assert.equal(renewed.generation, first.generation);
  assert.deepEqual(await f.run(renew), renewed);
  await rejects(f.run(), 'COWORK_RECEIPT_STALE');
  const checkpointId = randomUUID();
  await db.transaction(async (tx) => {
    const locked = await coworkUnitRows(tx).lock({ workspaceId: f.ws.id, projectId: f.p.id, connectionId: f.connection.id, unitId: f.unitId });
    assert.equal(await locked!.insertCheckpoint({ id: checkpointId, generation: renewed.generation, leaseId: renewed.lease!.id,
      runtimeSessionId: f.runtime.id, progress: { sources: f.command.sources, nextAction: 'Continue native task' } }), checkpointId);
  });
  const releaseGrant = await f.grant('release');
  const release = { ...f.command, grantId: releaseGrant.id, clientCommandId: randomUUID(), operation: 'cowork.release' as const,
    payload: { expectedVersion: renewed.version, generation: renewed.generation, leaseId: renewed.lease!.id, checkpointId } };
  await rejects(f.run({ ...release, sources: [] }), 'COWORK_CHECKPOINT_SOURCES_REQUIRED');
  assert.equal((await f.state()).state, 'claimed', 'failed source coverage rolls back the release');
  const paused = await f.run(release); assert.equal(paused.state, 'paused'); assert.equal(paused.lease, null);
  assert.equal(paused.generation, renewed.generation + 1); assert.equal(paused.checkpointId, checkpointId);
  assert.deepEqual(await f.run(release), paused);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id])).rows[0].n, 3);
});

test('outer failure rolls back the actual claim, use debit and receipt as one transaction', async () => {
  const f = await fixture();
  await assert.rejects(f.run(f.command, { failAfter: true }), /Injected failure after claim\/debit\/receipt/);
  const unit = await f.state(); assert.equal(unit.state, 'pending'); assert.equal(unit.version, 1); assert.equal(unit.generation, 0); assert.equal(unit.leaseId, null);
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.ceiling.id])).rows[0].used, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id])).rows[0].n, 0);
  await f.run();
});

test('current grant revoke, source edit and wrong actual client deny successful receipt observation', async () => {
  const f = await fixture(); await f.run();
  await assert.rejects(db.transaction((tx) => coWorkClaimInTransaction(tx, { ...f.claims, clientId: 'foreign-actual-client' }, f.command, f.policy)),
    (error: unknown) => error instanceof DomainError);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${f.source.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Changed current source' } }), 200);
  await rejects(f.run(), 'SOURCE_VERSION_CONFLICT');
  const separate = await fixture(); await separate.run();
  expectStatus(await separate.owner.browser.request('DELETE', `/api/v1/agent-connections/${separate.connection.id}/action-grants/${separate.ceiling.id}`), 204);
  await rejects(separate.run(), 'AGENT_EXECUTION_UNAVAILABLE');
});

test('runtime expiry during an actual connection-slot lock wait rolls back the late claim and ledger', async () => {
  const f = await fixture();
  await db.insert(schema.coworkConnectionSlots).values({ connectionId: f.connection.id, workspaceId: f.ws.id });
  const ready = barrier<number>(), release = barrier();
  const holder = db.transaction(async (tx) => {
    await tx.select().from(schema.coworkConnectionSlots).where(eq(schema.coworkConnectionSlots.connectionId, f.connection.id)).for('update');
    ready.resolve(await backendPid(tx)); await release.promise;
  });
  holder.catch(() => ready.resolve(-1));
  const pid = await ready.promise; if (pid < 0) await holder;
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.runtime.id]);
  const waiter = f.run(); waiter.catch(() => undefined);
  try { await waitUntilBlockedBy(pool, pid); await new Promise((resolve) => setTimeout(resolve, 1050)); }
  finally { release.resolve(); await holder; }
  await rejects(waiter, 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal((await f.state()).state, 'pending');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.ceiling.id])).rows[0].used, 0);
});

test('exact actual role and strict payload fields fail closed before any claim receipt', async () => {
  const f = await fixture();
  expectStatus(await f.owner.browser.request('POST', `/api/v1/agent-connections/${f.connection.id}/action-grants`,
    { body: { clientCommandId: randomUUID(), projectId: f.p.id, operation: 'cowork.claim', objectId: f.unitId,
      peerRequestClass: 'review', maximumUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 404,
  'an exact target cannot receive the wrong role grant');
  const review = await f.grant('claim', null, 'review');
  await rejects(f.run({ ...f.command, grantId: review.id, peerRequestClass: 'review' }), 'COWORK_UNIT_NOT_FOUND');
  await rejects(f.run({ ...f.command, payload: { expectedVersion: 1, prompt: 'invented authority' } }), 'INVALID_INPUT');
  await assert.rejects(f.run(f.command, { policy: { ...f.policy, prepareTaskLocks: undefined } as unknown as CoWorkClaimPolicy }), /providers are required/);
  assert.equal((await f.state()).state, 'pending');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id])).rows[0].n, 0);
});

test('a current authorized assignee can recover a historical foreign-connection checkpoint but cannot release with its old fence', async () => {
  const f = await fixture(); const checkpointId = randomUUID();
  // Inert reassignment/history fixture, not evidence of the future transfer command.
  await db.insert(schema.coworkCheckpoints).values({ id: checkpointId, workspaceId: f.ws.id, projectId: f.p.id,
    unitId: f.unitId, connectionId: randomUUID(), runtimeSessionId: randomUUID(), generation: 1,
    progress: { sources: f.command.sources, nextAction: 'Recover authorized native work' } });
  await db.update(schema.coworkUnits).set({ state: 'paused', generation: 1, version: 2, checkpointId }).where(eq(schema.coworkUnits.id, f.unitId));
  const recovered = await f.run({ ...f.command, payload: { expectedVersion: 2 } });
  assert.equal(recovered.checkpointId, checkpointId); assert.equal(recovered.generation, 2);
  const grant = await f.grant('release');
  await rejects(f.run({ ...f.command, grantId: grant.id, clientCommandId: randomUUID(), operation: 'cowork.release',
    payload: { expectedVersion: recovered.version, generation: recovered.generation, leaseId: recovered.lease!.id, checkpointId } }),
  'COWORK_CHECKPOINT_STALE');
  assert.equal((await f.state()).state, 'claimed');
  assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [grant.id])).rows[0].used, 0);
});
