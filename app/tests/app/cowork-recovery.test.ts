import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { Agent, AgentConnection, CoWorkEnqueueCommand, CoWorkSourceRef, WorkItem } from '@flux/contracts';
import { coWorkRequestFingerprint, DomainError, normalizeCoWorkRequest } from '@flux/core';
import { coworkRequestRows, createDatabase, schema } from '@flux/db';
import { coWorkRecovery } from '../../apps/server/src/co-work/recovery.js';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

// Actual owner APIs, current central policy, connection binding and durable SQL.
// Trusted OAuth binding/enqueue fixtures do not certify public MCP admission,
// standing execution policy, provider access or a real model-driven client loop.
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const secret = 'cowork-recovery-test-server-secret-at-least32';
async function fixture() {
  const owner = await person('recovery-owner'), receiver = await person('recovery-receiver');
  const ws = await workspace(owner, 'Recovery workspace'); await addMember(owner, ws.id, receiver, 'member');
  const p = await project(owner, ws.id, 'Addressed native work', 'restricted'); await grant(owner, p.id, receiver, 'viewer');
  const agent = expectStatus(await receiver.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Recovery receiver', owner: 'self' } }), 201) as Agent;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'viewer' } }), 201);
  const connect = async () => {
    const connection = expectStatus(await receiver.browser.request('POST', '/api/v1/agent-connections',
      { body: { agentId: agent.id, selectedProjectIds: [p.id], scopes: ['flux.context.read'] } }), 201) as AgentConnection;
    const clientId = `recovery-fixture-${randomUUID()}`, bindingId = randomUUID();
    await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
      [randomUUID(), clientId, 'Trusted recovery binding fixture', ['https://fixture.invalid/callback']]);
    await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)',
      [bindingId, receiver.id, connection.id, clientId]);
    return { connection, claims: { ownerUserId: receiver.id, connectionId: connection.id, clientId,
      grantReferenceId: `flux-grant:${bindingId}`, scopes: connection.scopes } };
  };
  const recipient = await connect();
  const senderAgent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Native sender', owner: 'self' } }), 201) as Agent;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/grants`,
    { body: { principal: { kind: 'agent', id: senderAgent.id }, role: 'contributor' } }), 201);
  const senderConnection = expectStatus(await owner.browser.request('POST', '/api/v1/agent-connections',
    { body: { agentId: senderAgent.id, selectedProjectIds: [p.id], scopes: ['flux.context.read'] } }), 201) as AgentConnection;
  const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/work`,
    { body: { title: 'Durable native outcome' } }), 201) as WorkItem;
  const source = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${p.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Original source label', body: 'Original private body must not be copied' } }), 201) as { materialId: string };
  const unitId = randomUUID();
  await db.insert(schema.coworkUnits).values({ id: unitId, workspaceId: ws.id, projectId: p.id, taskId: work.id,
    lineageTaskId: work.id, runId: randomUUID(), unitKey: unitId, role: 'execute', assignmentConnectionId: recipient.connection.id });
  const sender = { workspaceId: ws.id, projectId: p.id, connectionId: senderConnection.id };
  const enqueue = async (overrides: Partial<CoWorkEnqueueCommand> = {}) => {
    const input = normalizeCoWorkRequest({ commandId: randomUUID(), unitId, expectedUnitVersion: 1,
      recipientConnectionId: recipient.connection.id, intentKey: randomUUID(), parentRequestId: null, kind: 'help',
      target: { type: 'work', id: work.id, version: 1 }, sourceRefs: [{ type: 'material', id: source.materialId, version: 1 }],
      criteriaRefs: [{ type: 'work', id: work.id, version: 1 }], priority: 0, peerUnblocking: false, lifetimeSeconds: 3600, ...overrides });
    const result = await db.transaction((tx) => coworkRequestRows(tx).enqueue(sender, input,
      coWorkRequestFingerprint(input, sender.connectionId), { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 }));
    if (result.status !== 'created') throw new Error(`Fixture enqueue failed: ${result.status}`);
    return result;
  };
  const recover = coWorkRecovery(db, secret);
  const read = (query: { limit?: number; cursor?: string } = {}) => recover(recipient.claims, p.id, query);
  return { owner, receiver, ws, p, agent, connect, recipient, sender, source, work, unitId, enqueue, recover, read };
}
const unavailable = (error: unknown) => error instanceof DomainError && error.status >= 400 && error.status < 500;

test('current-source filtering precedes pagination, including a large hidden prefix, with no content or authority effects', async () => {
  const f = await fixture(); const hidden = await project(f.owner, f.ws.id, 'Unselected project', 'restricted');
  const material = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${hidden.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Hidden source label', body: 'Hidden source prose' } }), 201) as { materialId: string };
  const hiddenIds: string[] = [];
  for (let i = 0; i < 55; i++) hiddenIds.push((await f.enqueue({ target: { type: 'material', id: material.materialId, version: 1 } })).request.id);
  const a = await f.enqueue(), b = await f.enqueue();
  const one = await f.read({ limit: 1 }); assert.equal(one.recovery, 'snapshot'); assert.equal(one.requests[0]!.id, a.request.id);
  assert.ok(one.continuation); const text = JSON.stringify(one);
  for (const hiddenValue of [...hiddenIds, material.materialId, 'Hidden source label', 'Original private body', f.owner.id, f.receiver.id])
    assert.equal(text.includes(hiddenValue), false);
  assert.equal('total' in one, false); assert.equal('scanned' in one, false); assert.equal('fingerprint' in one.requests[0]!, false);
  const cold = await coWorkRecovery(db, secret)(f.recipient.claims, f.p.id, { limit: 1, cursor: one.continuation });
  assert.equal(cold.requests[0]!.id, b.request.id); assert.equal(cold.continuation, null); assert.equal(cold.recovery, 'continuation');
  for (let i = 0; i < 3; i++) assert.equal((await f.read()).requests.length, 2);
  await db.transaction((tx) => coworkRequestRows(tx).acknowledge({ ...f.sender, connectionId: f.recipient.connection.id }, a.deliveryIntentId));
  assert.equal((await f.read()).requests.length, 2, 'transport ACK never resolves pending work');
  const [unit] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, f.unitId));
  assert.equal(unit!.state, 'pending'); assert.equal(unit!.generation, 0); assert.equal(unit!.leaseId, null);
  const facts = (await pool.query(`SELECT (SELECT count(*)::int FROM cowork_requests WHERE project_id=$1) AS pending,
    (SELECT count(*)::int FROM agent_runtime_sessions WHERE connection_id=$2) AS runtimes,
    (SELECT count(*)::int FROM agent_standing_grants WHERE connection_id=$2) AS grants,
    (SELECT count(*)::int FROM agent_command_receipts WHERE connection_id=$2) AS receipts`, [f.p.id, f.recipient.connection.id])).rows[0];
  assert.deepEqual(facts, { pending: 57, runtimes: 0, grants: 0, receipts: 0 });
});

test('native immutable and versioned reference packets require every current source, dependency and response', async () => {
  const f = await fixture();
  const doc = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/docs`,
    { body: { title: 'Actual doc', body: 'Original document' } }), 201) as { id: string; version: number };
  const result = expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/results`,
    { body: { title: 'Actual result', finding: 'positive', evidence: 'Human observation' } }), 201) as { id: string };
  const message = expectStatus(await f.owner.browser.request('POST', `/api/v1/work/${f.work.id}/discussion`,
    { body: { body: 'An original contribution', clientMessageId: randomUUID() } }), 201) as { id: string };
  const map = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Canonical project map', scope: 'project', projectId: f.p.id } }), 201) as { id: string };
  const thought = expectStatus(await f.owner.browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`,
    { body: { text: 'Current thought', x: 0, y: 0 } }), 201) as { thought: { id: string; version: number } };
  const refs: CoWorkSourceRef[] = [{ type: 'doc', id: doc.id, version: doc.version }, { type: 'result', id: result.id },
    { type: 'message', id: message.id }, { type: 'thought', id: thought.thought.id, version: thought.thought.version }];
  const r = await f.enqueue({ target: refs[2]!, sourceRefs: refs, criteriaRefs: [refs[0]!] });
  assert.equal((await f.read()).requests[0]!.id, r.request.id);
  await db.update(schema.coworkRequests).set({ dependencyRef: { type: 'result', id: randomUUID() } }).where(eq(schema.coworkRequests.id, r.request.id));
  assert.deepEqual((await f.read()).requests, []);
  await db.update(schema.coworkRequests).set({ dependencyRef: null, responseRef: { type: 'result', id: randomUUID() } }).where(eq(schema.coworkRequests.id, r.request.id));
  assert.deepEqual((await f.read()).requests, []);
  await db.update(schema.coworkRequests).set({ responseRef: null }).where(eq(schema.coworkRequests.id, r.request.id));
  await pool.query('UPDATE sketch_thoughts SET version=version+1 WHERE id=$1', [thought.thought.id]);
  assert.deepEqual((await f.read()).requests, [], 'changed version is not silently replaced in the original packet');
  assert.equal((await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.id, r.request.id)))[0]!.state, 'queued');
});

test('private map thoughts and GitHub references cannot pass project-only recovery or suppress visible requests', async () => {
  const f = await fixture();
  const map = expectStatus(await f.owner.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Private map', scope: 'private' } }), 201) as { id: string };
  const thought = expectStatus(await f.owner.browser.request('POST', `/api/v1/sketches/${map.id}/thoughts`,
    { body: { text: 'Private thought', x: 0, y: 0 } }), 201) as { thought: { id: string } };
  await f.enqueue({ sourceRefs: [{ type: 'thought', id: thought.thought.id, version: 1 }] });
  await f.enqueue({ criteriaRefs: [{ type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(), headSha: 'a'.repeat(40) }] });
  const visible = await f.enqueue(); const page = await f.read({ limit: 1 });
  assert.deepEqual(page.requests.map((r) => r.id), [visible.request.id]); assert.equal(page.continuation, null);
  assert.equal(JSON.stringify(page).includes(thought.thought.id), false);
});

test('opaque continuations retain microsecond positions and expiry, and foreign connection/project/key or tampering requires resync', async () => {
  const f = await fixture(); const records = [await f.enqueue(), await f.enqueue(), await f.enqueue()];
  for (let i = 0; i < records.length; i++) await pool.query("UPDATE cowork_requests SET created_at='2026-09-30 12:00:00.000001+00'::timestamptz + ($1 * interval '1 microsecond') WHERE id=$2", [i, records[i]!.request.id]);
  const a = await f.read({ limit: 1 }); assert.ok(a.continuation);
  const b = await f.read({ limit: 1, cursor: a.continuation }); assert.ok(b.continuation);
  const c = await f.read({ limit: 1, cursor: b.continuation }); assert.equal(c.continuation, null);
  assert.deepEqual([a, b, c].map((p) => p.requests[0]!.id), records.map((r) => r.request.id));
  const scope = { workspaceId: f.ws.id, projectId: f.p.id, connectionId: f.recipient.connection.id,
    ownerUserId: f.receiver.id, clientId: f.recipient.claims.clientId, grantReferenceId: f.recipient.claims.grantReferenceId };
  const key = Buffer.from(hkdfSync('sha256', secret, 'flux-cowork-recovery', 'encryption-v1', 32));
  function position(token: string) {
    const bytes = Buffer.from(token.slice(4), 'base64url'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(JSON.stringify(scope))); cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString()) as { createdAt: string; id: string; expiresAt: number };
  }
  assert.ok(position(a.continuation).createdAt.includes('000001')); assert.equal(position(a.continuation).expiresAt, position(b.continuation).expiresAt);
  assert.equal(Buffer.from(a.continuation.slice(4), 'base64url').toString().includes(records[0]!.request.id), false);
  const another = await f.connect();
  const foreign = await f.recover(another.claims, f.p.id, { cursor: a.continuation }); assert.equal(foreign.recovery, 'resync_required');
  assert.deepEqual(foreign.requests, []);
  const secondBinding = randomUUID(), secondClient = `new-binding-${randomUUID()}`;
  await pool.query('INSERT INTO oauth_client(id,client_id,name,redirect_uris) VALUES($1,$2,$3,$4)',
    [randomUUID(), secondClient, 'Other genuine binding fixture', ['https://fixture.invalid/callback']]);
  await pool.query('INSERT INTO agent_oauth_bindings(id,owner_user_id,connection_id,client_id) VALUES($1,$2,$3,$4)',
    [secondBinding, f.receiver.id, f.recipient.connection.id, secondClient]);
  assert.equal((await f.recover({ ...f.recipient.claims, clientId: secondClient, grantReferenceId: `flux-grant:${secondBinding}` },
    f.p.id, { cursor: a.continuation })).recovery, 'resync_required', 'another currently valid binding cannot borrow the cursor');
  assert.equal((await coWorkRecovery(db, secret + 'other')(f.recipient.claims, f.p.id, { cursor: a.continuation })).recovery, 'resync_required');
  const bytes = Buffer.from(a.continuation.slice(4), 'base64url'); bytes[15] = bytes[15]! ^ 1;
  assert.equal((await f.read({ cursor: 'cw1.' + bytes.toString('base64url') })).recovery, 'resync_required');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(scope)));
  const sealed = Buffer.concat([cipher.update(JSON.stringify({ ...position(a.continuation), expiresAt: Date.now() - 1 })), cipher.final()]);
  const expired = 'cw1.' + Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
  assert.equal((await f.read({ cursor: expired })).recovery, 'resync_required');
  await assert.rejects(f.recover(f.recipient.claims, randomUUID(), { cursor: a.continuation }), unavailable);
});

test('current selected-project, client, scope, central access and revocation precede cursor recovery', async () => {
  const f = await fixture(); await f.enqueue(); await f.enqueue(); const first = await f.read({ limit: 1 });
  assert.ok(first.continuation);
  for (const claims of [{ ...f.recipient.claims, clientId: 'wrong-client' }, { ...f.recipient.claims, scopes: [] }])
    await assert.rejects(f.recover(claims, f.p.id, { cursor: first.continuation }), unavailable);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/grants`,
    { body: { principal: { kind: 'agent', id: f.agent.id }, role: 'denied' } }), 201);
  await assert.rejects(f.read({ cursor: first.continuation }), unavailable);
  expectStatus(await f.owner.browser.request('POST', `/api/v1/projects/${f.p.id}/grants`,
    { body: { principal: { kind: 'agent', id: f.agent.id }, role: 'viewer' } }), 201);
  assert.equal((await f.read({ cursor: first.continuation })).recovery, 'continuation');
  expectStatus(await f.receiver.browser.request('DELETE', `/api/v1/agent-connections/${f.recipient.connection.id}`), 204);
  await assert.rejects(f.read({ cursor: 'cw1.invalid' }), unavailable);
});

test('retention gaps require an explicit fresh snapshot; a changed source remains unresolved and bounded input is enforced', async () => {
  const f = await fixture(); const a = await f.enqueue(), b = await f.enqueue(); const first = await f.read({ limit: 1 });
  assert.ok(first.continuation);
  // Finishing the anchor does not create a retention gap or repeat the packet.
  await db.update(schema.coworkRequests).set({ state: 'resolved', responseRef: { type: 'work', id: f.work.id, version: 1 } })
    .where(eq(schema.coworkRequests.id, a.request.id));
  const afterResolution = await f.read({ cursor: first.continuation });
  assert.equal(afterResolution.recovery, 'continuation'); assert.deepEqual(afterResolution.requests.map((r) => r.id), [b.request.id]);
  await db.delete(schema.coworkRequests).where(eq(schema.coworkRequests.id, a.request.id));
  const gap = await f.read({ cursor: first.continuation }); assert.deepEqual(gap.requests, []); assert.equal(gap.recovery, 'resync_required');
  assert.equal((await f.read()).requests[0]!.id, b.request.id);
  expectStatus(await f.owner.browser.request('PATCH', `/api/v1/materials/${f.source.materialId}`,
    { body: { clientMutationId: randomUUID(), expectedVersion: 1, body: 'New exact version' } }), 200);
  assert.deepEqual((await f.read()).requests, []);
  const [retained] = await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.id, b.request.id));
  assert.equal(retained!.state, 'queued'); assert.equal(retained!.version, 1);
  for (const limit of [0, 51, 1.5]) await assert.rejects(f.read({ limit }), /bounded recovery/);
  await assert.rejects(f.read({ cursor: 'x'.repeat(805) }), /bounded recovery/);
});

test('observing a lost live claim returns queued recovery metadata without changing persisted request or lease state', async () => {
  const f = await fixture(); const r = await f.enqueue();
  await db.update(schema.coworkRequests).set({ state: 'claimed', claimedGeneration: 1 }).where(eq(schema.coworkRequests.id, r.request.id));
  const page = await f.read(); assert.equal(page.requests[0]!.state, 'claimed'); assert.equal(page.requests[0]!.effectiveState, 'queued');
  assert.equal(page.requests[0]!.readinessReason, 'claim_lost');
  const [persisted] = await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.id, r.request.id));
  assert.equal(persisted!.state, 'claimed'); assert.equal(persisted!.version, 1);
});
