import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentJsonValue, WorkItem } from '@flux/contracts';
import { agentExecutionUseCases, DomainError, normalizeAgentExecution } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { agentExecutionInTransaction } from '../../apps/server/src/agent-connection/execution.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, project, workspace } from './support/people.js';

async function fixture() {
  const owner = await person('execution-owner'); const ws = await workspace(owner, "Execution workspace"); const p = await project(owner, ws.id, 'Execution target', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Execution agent', owner: 'self' } }), 201) as Agent;
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId: agent.id, selectedProjectIds: [p.id], scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] } }), 201) as AgentConnection;
  // Trusted bearer fixture for SQL/port checks; not a model or actual client activation.
  const clientId = `execution-fixture-${randomUUID()}`; const bindingId = randomUUID();
  await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
    [randomUUID(), clientId, 'Execution boundary fixture', ['https://fixture.invalid/callback']]);
  await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)',
    [bindingId, owner.id, connection.id, clientId]);
  const claims = { ownerUserId: owner.id, connectionId: connection.id, clientId, grantReferenceId: `flux-grant:${bindingId}`, scopes: connection.scopes };
  const clientSessionId = randomUUID();
  const { runtime } = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, clientSessionId));
  const again = await db.transaction((tx) => agentRuntimeInTransaction(tx, claims, clientSessionId));
  assert.deepEqual(again.runtime, runtime, 'same client session observes its original server identity and expiry');
  const command: AgentExecutionCommand = { runtimeSessionId: runtime.id, clientCommandId: randomUUID(),
    projectId: p.id, operation: 'work.create', peerRequestClass: 'execute', audience: { kind: 'project', projectId: p.id },
    objectId: null, sources: [], payload: { title: 'One canonical execution task' } };
  let effects = 0;
  async function run(input = command, fail = false, failAfterCompletion = false) {
    return db.transaction(async (tx) => {
      // The production composition: native work and the mandatory contribution hook share this transaction
      // and one final event batch, awaited only after the domain and receipt writes.
      const cases = nativeWorkInTransaction(tx);
      const result = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims)).run(input, async (scope) => {
        if (scope.replay) return { value: scope.replay.value, postconditions: scope.replay.postconditions };
        effects++;
        const work = await cases.createWork({ kind: 'agent', id: scope.context.agentId }, input.projectId,
          { title: (input.payload as { title: string }).title });
        if (fail) throw new Error('Injected failure before durable completion');
        return { value: { workId: work.id, version: work.version } as AgentJsonValue, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
      });
      if (failAfterCompletion) throw new Error('Injected failure after the durable receipt');
      await cases.flushEvents();
      return result as { workId: string; version: number };
    });
  }
  return { owner, p, agent, connection, runtime, claims, command, run, effects: () => effects };
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
}

test('concurrent duplicate canonical commands share one effect and receipt; matching retry preserves the produced version', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.run(), f.run()]); assert.deepEqual(a, b);
  assert.equal(f.effects(), 1);
  assert.deepEqual(await f.run(), a, 'a retry returns the original effect');
  assert.equal(f.effects(), 1);
  const count = await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id]); assert.equal(count.rows[0].n, 1);
  const work = expectStatus(await f.owner.browser.request('GET', `/api/v1/work/${a.workId}`), 200) as WorkItem;
  assert.equal(work.createdBy.kind, 'agent'); assert.equal(work.createdBy.id, f.agent.id);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/work/${a.workId}`, { body: { title: 'An intervening human edit' }, headers: { 'if-match': '"1"' } }), 200);
  await rejects(f.run(), 'COMMAND_POSTSTATE_STALE');
});

test('changed payload/session/class context conflicts and scope handles cannot be forged or reused', async () => {
  const f = await fixture(); await f.run();
  await rejects(f.run({ ...f.command, payload: { title: 'Changed payload' } }), 'IDEMPOTENCY_CONFLICT');
  await rejects(db.transaction((tx) => agentExecutionInTransaction(tx, f.claims).prepare({
    ...normalizeAgentExecution(f.command), payload: { title: 'A changed payload carrying the original hash' },
  })), 'IDEMPOTENCY_CONFLICT');
  await rejects(f.run({ ...f.command, runtimeSessionId: randomUUID() }), 'AGENT_EXECUTION_UNAVAILABLE');
  await assert.rejects(f.run({ ...f.command, peerRequestClass: 'review' }), (error: unknown) => error instanceof DomainError);
  await rejects(db.transaction(async (tx) => {
    const port = agentExecutionInTransaction(tx, f.claims);
    await port.complete({ transaction: tx, context: f.runtime, now: new Date(), replay: null },
      { value: null, postconditions: [{ kind: 'work', id: randomUUID(), version: 1 }] });
  }), 'EXECUTION_SCOPE_INVALID');
  await rejects(db.transaction(async (tx) => {
    const port = agentExecutionInTransaction(tx, f.claims);
    const scope = await port.prepare(normalizeAgentExecution(f.command));
    assert.ok(scope.replay);
    await port.complete(scope, { value: scope.replay.value, postconditions: scope.replay.postconditions });
    await port.complete(scope, { value: scope.replay.value, postconditions: scope.replay.postconditions });
  }), 'EXECUTION_SCOPE_INVALID');
  await pool.query('UPDATE agent_connections SET revoked_at = now() WHERE id = $1', [f.connection.id]);
  await rejects(f.run(), 'CONNECTION_NOT_FOUND');
});

test('effect failure rolls back native rows, receipt and event', async () => {
  const f = await fixture(); await assert.rejects(f.run(f.command, true), /Injected failure/);
  await assert.rejects(f.run(f.command, false, true), /Injected failure after the durable receipt/);
  const receipts = await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id]); assert.equal(receipts.rows[0].n, 0);
  const work = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.p.id}/work`), 200) as { total: number }; assert.equal(work.total, 0);
  await f.run(); assert.equal(f.effects(), 3, 'rolled-back commands can be executed once successfully');
});

test('runtime expiry/revocation and lost current domain authority deny successful receipt observation', async () => {
  const f = await fixture(); await f.run();
  // The owner kept out of the project: the agent has exactly what its owner has (F-036 AG-3).
  await pool.query(`INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by) SELECT $1, workspace_id, id, $2, 'denied', $2 FROM projects WHERE id = $3 ON CONFLICT (project_id, user_id) WHERE (user_id IS NOT NULL) DO UPDATE SET role = 'denied'`, [randomUUID(), f.owner.id, f.p.id]);
  await assert.rejects(f.run(), /Space not found/);
  await pool.query('DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2', [f.p.id, f.owner.id]);
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.runtime.id]);
  await rejects(f.run(), 'AGENT_EXECUTION_UNAVAILABLE');
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=clock_timestamp()+interval '1 hour', revoked_at=clock_timestamp() WHERE id=$1", [f.runtime.id]);
  await rejects(f.run(), 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(f.effects(), 1);
});

test('changed plan/source revisions and actual client or coarse scope substitution fail before effect or replay', async () => {
  const f = await fixture();
  const source = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Execution source', body: 'Version one' } }), 201) as { materialId: string };
  const command = { ...f.command, sources: [{ materialId: source.materialId, version: 1 }] }; await f.run(command);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${source.materialId}`, { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'Version two' } }), 200);
  await rejects(f.run(command), 'SOURCE_VERSION_CONFLICT');
  for (const claims of [{ ...f.claims, clientId: 'another-actual-client' }, { ...f.claims, scopes: ['flux.context.read'] }]) {
    await assert.rejects(db.transaction((tx) => agentExecutionInTransaction(tx, claims).prepare(normalizeAgentExecution(f.command))),
      (error: unknown) => error instanceof DomainError);
  }
  assert.equal(f.effects(), 1);
});
