import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { Agent, AgentConnection, AgentExecutionCommand, AgentJsonValue, AgentPeerRequestClass, AgentPostcondition, AgentStandingGrant, WorkItem } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { agentExecutionUseCases, createWorkUseCases, DomainError, normalizeAgentExecution, recordEvent } from '@flux/core';
import { agentRuntimeInTransaction } from '../../apps/server/src/agent-connection/runtime.js';
import { agentStandingGrants } from '../../apps/server/src/agent-connection/grants.js';
import { agentExecutionInTransaction } from '../../apps/server/src/agent-connection/execution.js';
import { policyWorkAccess, workRepository } from '../../apps/server/src/work/adapters.js';
import { expectStatus, person, project, workspace } from './support/people.js';
import { waitUntilBlockedBy } from './support/locks.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(url);
after(() => pool.end());
async function fixture(maximumUses = 1) {
  const owner = await person('execution-owner'); const ws = await workspace(owner, "Execution workspace"); const p = await project(owner, ws.id, 'Execution target', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Execution agent', owner: 'self' } }), 201) as Agent;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
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
  const grants = agentStandingGrants(db);
  const grant = expectStatus(await owner.browser.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: {
    clientCommandId: randomUUID(), projectId: p.id, operation: 'work.create',
    peerRequestClass: 'execute', maximumUses, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } }), 201) as AgentStandingGrant;
  const command: AgentExecutionCommand = { runtimeSessionId: runtime.id, grantId: grant.id, clientCommandId: randomUUID(),
    projectId: p.id, operation: 'work.create', peerRequestClass: 'execute', audience: { kind: 'project', projectId: p.id },
    objectId: null, sources: [], payload: { title: 'One canonical execution task' } };
  let effects = 0;
  async function run(input = command, fail = false, failAfterCompletion = false) {
    return db.transaction(async (tx) => {
      const events: Parameters<typeof recordEvent>[] = [];
      const cases = createWorkUseCases({ run: (work) => work({ access: policyWorkAccess(tx), work: workRepository(tx),
        events: { record: async (...event) => { events.push([tx, ...event]); } } }) });
      const result = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims)).run(input, async (scope) => {
        if (scope.replay) return { value: scope.replay.value, postconditions: scope.replay.postconditions };
        effects++;
        const work = await cases.createWork({ kind: 'agent', id: scope.context.agentId }, input.projectId,
          { title: (input.payload as { title: string }).title });
        if (fail) throw new Error('Injected failure before durable completion');
        return { value: { workId: work.id, version: work.version } as AgentJsonValue, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
      });
      if (failAfterCompletion) throw new Error('Injected failure after debit and durable receipt');
      // This fixture has exactly one canonical event. It follows the domain/debit/receipt SQL.
      // Production multi-domain writes await the independently verified final batch adapter.
      for (const event of events) await recordEvent(...event);
      return result as { workId: string; version: number };
    });
  }
  return { owner, p, agent, connection, runtime, claims, grant, command, grants, run, effects: () => effects };
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
}

test('concurrent duplicate canonical commands share one effect, receipt and last-use debit; matching retry preserves the produced version', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.run(), f.run()]); assert.deepEqual(a, b);
  assert.equal(f.effects(), 1);
  assert.deepEqual(await f.run(), a, 'an exhausted last-use retry returns the original effect');
  assert.equal(f.effects(), 1);
  const rows = await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.grant.id]); assert.equal(rows.rows[0].used, 1);
  const count = await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id]); assert.equal(count.rows[0].n, 1);
  const work = expectStatus(await f.owner.browser.request('GET', `/api/v1/work/${a.workId}`), 200) as WorkItem;
  assert.equal(work.createdBy.kind, 'agent'); assert.equal(work.createdBy.id, f.agent.id);
  await rejects(f.run({ ...f.command, clientCommandId: randomUUID() }), 'AGENT_EXECUTION_UNAVAILABLE');
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/work/${a.workId}`, { body: { title: 'An intervening human edit' }, headers: { 'if-match': '"1"' } }), 200);
  await rejects(f.run(), 'COMMAND_POSTSTATE_STALE');
});

test('changed payload/session/class context conflicts, revoked grants deny replay and scope handles cannot be forged or reused', async () => {
  const f = await fixture(2); await f.run();
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
  await f.grants.revoke({ kind: 'human', id: f.owner.id }, f.connection.id, f.grant.id);
  await rejects(f.run(), 'AGENT_EXECUTION_UNAVAILABLE');
});

test('effect failure rolls back native rows, receipt, event and grant use', async () => {
  const f = await fixture(); await assert.rejects(f.run(f.command, true), /Injected failure/);
  await assert.rejects(f.run(f.command, false, true), /Injected failure after debit/);
  const rows = await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.grant.id]); assert.equal(rows.rows[0].used, 0);
  const receipts = await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id]); assert.equal(receipts.rows[0].n, 0);
  const work = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.p.id}/work`), 200) as { total: number }; assert.equal(work.total, 0);
  await f.run(); assert.equal(f.effects(), 3, 'rolled-back commands can be executed once successfully');
});

test('owner grant API is idempotent, bounded and management-gated; history and narrowing remain owner-only after role loss', async () => {
  const f = await fixture(2); const peer = await person('grant-peer');
  const path = `/api/v1/agent-connections/${f.connection.id}/action-grants`;
  const command = { clientCommandId: randomUUID(), projectId: f.p.id, operation: 'work.create', peerRequestClass: 'plan', maximumUses: 3,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const [a, b] = await Promise.all([f.owner.browser.request('POST', path, { body: command }), f.owner.browser.request('POST', path, { body: command })]);
  const first = expectStatus(a, 201) as AgentStandingGrant;
  assert.equal((expectStatus(b, 201) as AgentStandingGrant).id, first.id, 'retries never create another use ceiling');
  expectStatus(await f.owner.browser.request('POST', path, { body: { ...command, maximumUses: 4 } }), 409);
  expectStatus(await peer.browser.request('GET', path), 404);
  expectStatus(await peer.browser.request('DELETE', `${path}/${first.id}`), 404);
  expectStatus(await f.owner.browser.request('GET', `${path}?limit=51`), 400);
  expectStatus(await f.owner.browser.request('POST', path, { body: { ...command, clientCommandId: randomUUID(), peerRequestClass: 'review' } }), 400);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.p.workspaceId}/members`, { body: { email: peer.email, role: 'owner' } }), 201);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/grants`, { body: { principal: { kind: 'human', id: f.owner.id }, role: 'contributor' } }), 201);
  expectStatus(await peer.browser.request('PATCH', `/api/v1/workspaces/${f.p.workspaceId}/members/${f.owner.id}`, { body: { role: 'member' } }), 200);
  expectStatus(await f.owner.browser.request('POST', path, { body: { ...command, clientCommandId: randomUUID() } }), 403, 'project contributor cannot create standing authority');
  const page = expectStatus(await f.owner.browser.request('GET', `${path}?limit=1`), 200) as { total: number; items: AgentStandingGrant[] };
  assert.equal(page.total, 2); assert.equal(page.items.length, 1);
  assert.ok(!JSON.stringify(page).includes(f.p.name), 'metadata history does not expose project or result titles');
  expectStatus(await f.owner.browser.request('DELETE', `${path}/${first.id}`), 204);
});

test('runtime expiry/revocation and lost current domain authority deny successful receipt observation', async () => {
  const f = await fixture(2); await f.run();
  const grants = expectStatus(await f.owner.browser.request('GET', `/api/v1/projects/${f.p.id}/grants`), 200) as { id: string; principal: { kind: string; id: string } }[];
  const agentGrant = grants.find((row) => row.principal.kind === 'agent' && row.principal.id === f.agent.id)!;
  expectStatus(await f.owner.browser.request('DELETE', `/api/v1/projects/${f.p.id}/grants/${agentGrant.id}`), 204);
  await assert.rejects(f.run(), (error: unknown) => error instanceof DomainError);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/grants`, { body: { principal: { kind: 'agent', id: f.agent.id }, role: 'contributor' } }), 201);
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.runtime.id]);
  await rejects(f.run(), 'AGENT_EXECUTION_UNAVAILABLE');
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=clock_timestamp()+interval '1 hour', revoked_at=clock_timestamp() WHERE id=$1", [f.runtime.id]);
  await rejects(f.run(), 'AGENT_EXECUTION_UNAVAILABLE');
  assert.equal(f.effects(), 1);
});

test('changed plan/source revisions and actual client or coarse scope substitution fail before effect or replay', async () => {
  const f = await fixture(2);
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


test('grant expiry after a real lock wait uses DB wall time and publishes no effect', async () => {
  const f = await fixture(); const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await blocker.query("UPDATE agent_standing_grants SET expires_at = clock_timestamp() + interval '400 milliseconds' WHERE id=$1", [f.grant.id]);
    const running = f.run();
    // Attach the rejection handler before waiting so an unexpected early failure is not unhandled.
    const rejected = rejects(running, 'AGENT_EXECUTION_UNAVAILABLE');
    await waitUntilBlockedBy(pool, pid);
    await blocker.query('SELECT pg_sleep(0.5)');
    await blocker.query('COMMIT');
    await rejected;
    assert.equal(f.effects(), 0);
    const used = await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [f.grant.id]); assert.equal(used.rows[0].used, 0);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('cowork.request grants exist per sender class; the closed operation CHECK accepts them and still rejects unknown or non-operation names', async () => {
  const f = await fixture(); const path = `/api/v1/agent-connections/${f.connection.id}/action-grants`;
  const body = { projectId: f.p.id, maximumUses: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  for (const peerRequestClass of ['execute', 'review', 'plan']) {
    const grant = expectStatus(await f.owner.browser.request('POST', path,
      { body: { ...body, clientCommandId: randomUUID(), operation: 'cowork.request', peerRequestClass } }), 201) as AgentStandingGrant;
    assert.equal(grant.operation, 'cowork.request'); assert.equal(grant.peerRequestClass, peerRequestClass); assert.equal(grant.objectId, null);
    const row = await pool.query('SELECT operation, peer_request_class, used FROM agent_standing_grants WHERE id=$1', [grant.id]);
    assert.deepEqual(row.rows[0], { operation: 'cowork.request', peer_request_class: peerRequestClass, used: 0 });
  }
  // Request kinds, the recipient and ACK/deferral/selection are neither classes nor operations.
  for (const changed of [{ operation: 'cowork.request', peerRequestClass: 'help' }, { operation: 'cowork.request', peerRequestClass: 'recipient' },
    { operation: 'cowork.ack', peerRequestClass: 'execute' }, { operation: 'cowork.defer', peerRequestClass: 'execute' }, { operation: 'cowork.select', peerRequestClass: 'plan' }])
    expectStatus(await f.owner.browser.request('POST', path, { body: { ...body, clientCommandId: randomUUID(), ...changed } }), 400);
  // The exact sender-unit grant target belongs to the #153 coordination adapter: content-free 404 until it is composed.
  expectStatus(await f.owner.browser.request('POST', path, { body: { ...body, clientCommandId: randomUUID(),
    operation: 'cowork.request', peerRequestClass: 'execute', objectId: randomUUID() } }), 404);
  const insert = (operation: string) => pool.query(`INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,
    request_fingerprint,operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'execute',1,now()+interval '1 hour')`,
  [randomUUID(), f.p.workspaceId, f.p.id, f.connection.id, f.owner.id, randomUUID(), 'b'.repeat(64), operation]);
  await insert('cowork.request');
  for (const operation of ['cowork.ack', 'cowork.request.ack', 'cowork.requests'])
    await assert.rejects(insert(operation), (error: unknown) => (error as { code?: string; constraint?: string }).code === '23514'
      && (error as { constraint?: string }).constraint === 'agent_standing_grants_operation_check');
});

test('a cowork.request grant authorizes only its exact operation and sender class; completing without the canonical #153 callback debits nothing', async () => {
  const f = await fixture();
  const create = async (operation: string, peerRequestClass: string) => expectStatus(await f.owner.browser.request('POST',
    `/api/v1/agent-connections/${f.connection.id}/action-grants`, { body: { clientCommandId: randomUUID(), projectId: f.p.id, operation, peerRequestClass,
      maximumUses: 3, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as AgentStandingGrant;
  // Only an execute-class request grant and an execute-class claim grant exist: no review grant of any operation.
  const requestGrant = await create('cowork.request', 'execute'); const claimGrant = await create('cowork.claim', 'execute');
  const sender = randomUUID();
  const command = (grant: AgentStandingGrant, operation: 'cowork.request' | 'cowork.claim', peerRequestClass: AgentPeerRequestClass = 'execute'): AgentExecutionCommand => ({
    runtimeSessionId: f.runtime.id, grantId: grant.id, clientCommandId: randomUUID(), projectId: f.p.id, operation, peerRequestClass,
    audience: { kind: 'project', projectId: f.p.id }, objectId: sender, sources: [],
    payload: { kind: 'review', recipientConnectionId: randomUUID(), intentKey: 'review-round-1' } });
  const state = (given: AgentExecutionCommand, changed: Record<string, unknown> = {}) => ({ kind: 'cowork.request_state', workspaceId: f.runtime.workspaceId,
    projectId: f.p.id, connectionId: f.connection.id, unitId: sender, requestId: randomUUID(), role: given.peerRequestClass, version: 1, state: 'queued', ...changed }) as AgentPostcondition;
  let callbacks = 0;
  const checks = { async coordinationRequestPostcondition() { callbacks++; return true; } };
  const prepare = (given: AgentExecutionCommand) => db.transaction((tx) => agentExecutionInTransaction(tx, f.claims).prepare(normalizeAgentExecution(given)));
  const complete = (given: AgentExecutionCommand, postconditions: AgentPostcondition[], domain = {}) => db.transaction(async (tx) => {
    const port = agentExecutionInTransaction(tx, f.claims, domain);
    await port.complete(await port.prepare(normalizeAgentExecution(given)), { value: { requested: true }, postconditions });
  });
  const usage = async () => ({ used: (await pool.query('SELECT sum(used)::int AS n FROM agent_standing_grants WHERE connection_id=$1', [f.connection.id])).rows[0].n as number,
    receipts: (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id])).rows[0].n as number });

  // A sender's execution role may queue a review request: the class is the sender's, and the review kind sits in the payload.
  const sent = command(requestGrant, 'cowork.request');
  assert.equal((await prepare(sent)).context.connectionId, f.connection.id);
  // No grant crosses operation or class: request vs claim, a work grant, and a class the sender holds no grant for.
  for (const denied of [command(requestGrant, 'cowork.claim'), command(claimGrant, 'cowork.request'), command(f.grant, 'cowork.request'),
    command(requestGrant, 'cowork.request', 'review'), command(requestGrant, 'cowork.request', 'plan')])
    await rejects(prepare(denied), 'AGENT_EXECUTION_UNAVAILABLE');
  assert.deepEqual(await usage(), { used: 0, receipts: 0 }, 'selection and preparation debit nothing');

  // No request storage or callback exists in this change: a produced request cannot be accepted, debited or receipted.
  await rejects(complete(sent, [state(sent)]), 'COMMAND_POSTSTATE_STALE');
  assert.deepEqual(await usage(), { used: 0, receipts: 0 });
  // The exact sender context/role/unit binding is enforced before any canonical reader is consulted.
  for (const changed of [{ role: 'review' }, { role: 'plan' }, { connectionId: randomUUID() }, { projectId: randomUUID() },
    { workspaceId: randomUUID() }, { unitId: randomUUID() }])
    await rejects(complete(sent, [state(sent, changed)], checks), 'COMMAND_POSTSTATE_INVALID');
  await rejects(complete(sent, [{ kind: 'cowork.claim_state', workspaceId: f.runtime.workspaceId, projectId: f.p.id, connectionId: f.connection.id,
    unitId: sender, role: 'execute', version: 1, generation: 0, state: 'pending', leaseId: null, leaseSessionId: null, leaseExpiresAt: null, checkpointId: null }], checks),
  'COMMAND_POSTSTATE_INVALID');
  assert.equal(callbacks, 0); assert.deepEqual(await usage(), { used: 0, receipts: 0 });

  // Fixture callback standing in for #153's canonical row reader: one effect, one debit, one receipt with the typed post-state.
  await complete(sent, [state(sent, { requestId: '00000000-0000-4000-8000-000000000152' })], checks);
  assert.equal(callbacks, 1); assert.deepEqual(await usage(), { used: 1, receipts: 1 });
  const receipt = (await pool.query('SELECT operation, postconditions FROM agent_command_receipts WHERE connection_id=$1', [f.connection.id])).rows[0];
  assert.equal(receipt.operation, 'cowork.request'); assert.equal(receipt.postconditions[0].kind, 'cowork.request_state');
  assert.equal(receipt.postconditions[0].role, 'execute'); assert.equal(receipt.postconditions[0].unitId, sender);
});
