import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { asc, eq, inArray } from 'drizzle-orm';
import { coworkRequestRows, coworkUnitRows, createDatabase, schema, sql, type DbExecutor } from '@flux/db';
import { normalizeCoWorkRequest, coWorkRequestFingerprint, validateCoWorkRequestLimits } from '@flux/core';
import type { CoWorkEnqueueCommand, CoWorkRequestLimits } from '@flux/contracts';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';

// Real storage/transaction regressions. Actual #152 grants, current-source authorization,
// opaque public cursors, actor publication and real client scheduling are not these fixtures.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(url);
after(() => pool.end());

async function fixture() {
  const workspaceId = randomUUID(), projectId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
  const owners = [randomUUID(), randomUUID()];
  await db.insert(schema.authUsers).values(owners.map((id) => ({ id, name: 'Queue fixture', email: `${id}@cowork.test` })));
  await db.insert(schema.workspaces).values({ id: workspaceId, name: 'Addressed storage', createdBy: owners[0]! });
  await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'Native project', createdBy: owners[0]! });
  await db.insert(schema.projectWorkItems).values({ id: taskId, workspaceId, projectId, title: 'Native outcome', createdByKind: 'human', createdById: owners[0]! });
  const agentId = randomUUID();
  await db.insert(schema.agents).values({ id: agentId, workspaceId, name: 'Fixture client', createdBy: owners[0]! });
  const connections = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(schema.agentConnections).values(connections.map((id, index) => ({ id, workspaceId, agentId,
    ownerUserId: owners[index === 1 ? 1 : 0]!, scopes: ['flux.context.read' as const] })));
  const sender = { workspaceId, projectId, connectionId: connections[0]! };
  const recipient = { workspaceId, projectId, connectionId: connections[1]! };
  const third = { workspaceId, projectId, connectionId: connections[2]! };
  const targetId = randomUUID();
  await db.insert(schema.projectResults).values({ id: targetId, workspaceId, projectId, title: 'Original result', finding: 'positive',
    evidence: 'Private original prose; never copied into request storage', createdByKind: 'human', createdById: owners[0]! });
  const tasks = [taskId];
  const makeUnit = async (options: { role?: 'review' | 'execute'; taskId?: string; lineageTaskId?: string; runId?: string; connectionId?: string } = {}) => {
    const ownTask = options.taskId ?? taskId;
    const unitId = randomUUID();
    await db.insert(schema.coworkUnits).values({ id: unitId, workspaceId, projectId, taskId: ownTask, lineageTaskId: options.lineageTaskId ?? ownTask,
      runId: options.runId ?? runId, unitKey: unitId, role: options.role ?? 'review', assignmentConnectionId: options.connectionId ?? recipient.connectionId });
    return unitId;
  };
  const makeTask = async () => {
    const id = randomUUID();
    await db.insert(schema.projectWorkItems).values({ id, workspaceId, projectId, title: 'Related native task', createdByKind: 'human', createdById: owners[0]! });
    tasks.push(id);
    return id;
  };
  const unitId = await makeUnit();
  const input = (change: Partial<CoWorkEnqueueCommand> = {}) => normalizeCoWorkRequest({ commandId: randomUUID(), unitId,
    expectedUnitVersion: 1, recipientConnectionId: recipient.connectionId, intentKey: 'original-review', parentRequestId: null,
    kind: 'review', target: { type: 'result', id: targetId }, sourceRefs: [{ type: 'result', id: targetId }],
    criteriaRefs: [{ type: 'work', id: taskId, version: 1 }], priority: 1, peerUnblocking: true, lifetimeSeconds: 3600, ...change });
  const limits: CoWorkRequestLimits = { maximumRequests: 128, maximumDepth: 8, maximumReviewRounds: 16 };
  const locks = async (tx: DbExecutor) => {
    // Required order; no actual grant/runtime adapter is claimed by this structural fixture.
    await tx.select().from(schema.agentConnections).where(inArray(schema.agentConnections.id, connections)).orderBy(asc(schema.agentConnections.id)).for('share');
    await tx.insert(schema.coworkConnectionSlots).values([...connections].sort().map((connectionId) => ({ connectionId, workspaceId }))).onConflictDoNothing();
    await tx.select().from(schema.coworkConnectionSlots).where(inArray(schema.coworkConnectionSlots.connectionId, connections)).orderBy(asc(schema.coworkConnectionSlots.connectionId)).for('update');
    await tx.select().from(schema.projectWorkItems).where(inArray(schema.projectWorkItems.id, [...tasks].sort())).orderBy(asc(schema.projectWorkItems.id)).for('update');
    await tx.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.workspaceId, workspaceId)).orderBy(asc(schema.coworkUnits.id)).for('update');
  };
  const enqueue = (command = input(), policy = limits) => db.transaction(async (tx) => {
    validateCoWorkRequestLimits(policy);
    await locks(tx);
    return coworkRequestRows(tx).enqueue(sender, command, coWorkRequestFingerprint(command, sender.connectionId), policy);
  });
  return { workspaceId, projectId, taskId, runId, sender, recipient, third, unitId, input, limits, locks, enqueue, makeUnit, makeTask };
}
type Enqueued = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['enqueue']>>;
function created(result: Enqueued) {
  assert.equal(result.status, 'created');
  if (result.status !== 'created') throw new Error('Expected committed request');
  return result;
}

test('request and one delivery intent preserve original references and do not claim or copy source content', async () => {
  const f = await fixture();
  const request = created(await f.enqueue());
  assert.equal(request.request.recipientConnectionId, f.recipient.connectionId);
  assert.notEqual(request.request.senderOwnerId, request.request.recipientOwnerId);
  assert.deepEqual(request.request.target, f.input().target);
  assert.equal(JSON.stringify(request).includes('Private original prose'), false);
  assert.equal('fingerprint' in request.request, false);
  const [unit] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, f.unitId));
  assert.equal(unit!.state, 'pending'); assert.equal(unit!.version, 1); assert.equal(unit!.leaseId, null);
  assert.equal((await db.select().from(schema.coworkDeliveryIntents).where(eq(schema.coworkDeliveryIntents.requestId, request.request.id))).length, 1);
});

test('permanent semantic retry keeps identity after new command/version, while changed content conflicts', async () => {
  const f = await fixture();
  const initial = created(await f.enqueue());
  await db.update(schema.coworkUnits).set({ version: 2 }).where(eq(schema.coworkUnits.id, f.unitId));
  const repeated = await f.enqueue(f.input({ expectedUnitVersion: 2 }));
  assert.equal(repeated.status, 'existing');
  if (repeated.status !== 'existing') throw new Error('Expected retained request');
  assert.equal(repeated.request.id, initial.request.id);
  assert.equal(repeated.deliveryIntentId, initial.deliveryIntentId);
  assert.equal((await f.enqueue(f.input({ expectedUnitVersion: 2, priority: 3 }))).status, 'conflict');
  const [root] = await db.select().from(schema.coworkRequestLineages).where(eq(schema.coworkRequestLineages.id, initial.request.lineageId));
  assert.equal(root!.createdRequests, 1);
});

test('simultaneous transport retries commit one request/outbox and one budget use', async () => {
  const f = await fixture();
  const ready = barrier<number>(), release = barrier();
  const first = db.transaction(async (tx) => {
    await f.locks(tx);
    const command = f.input();
    const result = await coworkRequestRows(tx).enqueue(f.sender, command, coWorkRequestFingerprint(command, f.sender.connectionId), f.limits);
    ready.resolve(await backendPid(tx)); await release.promise;
    return result;
  });
  first.catch(() => ready.resolve(-1));
  const pid = await ready.promise;
  if (pid < 0) await first;
  const retry = f.enqueue();
  const done = settled(retry);
  try { await waitUntilBlockedBy(pool, pid); assert.equal(done(), false); }
  finally { release.resolve(); }
  const initial = created(await first);
  const duplicate = await retry;
  assert.equal(duplicate.status, 'existing');
  if (duplicate.status !== 'existing') throw new Error('Expected duplicate');
  assert.equal(duplicate.request.id, initial.request.id);
  assert.equal(duplicate.deliveryIntentId, initial.deliveryIntentId);
});

test('new intent keys and looser policy cannot reset initial request or global review-round budgets', async () => {
  const f = await fixture();
  const limited = { maximumRequests: 2, maximumDepth: 1, maximumReviewRounds: 1 };
  const first = created(await f.enqueue(f.input(), limited));
  assert.equal((await f.enqueue(f.input({ intentKey: 'another-review' }), f.limits)).status, 'budget_exhausted');
  created(await f.enqueue(f.input({ intentKey: 'help', kind: 'help', parentRequestId: first.request.id }), f.limits));
  assert.equal((await f.enqueue(f.input({ intentKey: 'new-id-help', kind: 'help' }), f.limits)).status, 'budget_exhausted');
  assert.equal((await f.enqueue(f.input(), { ...limited, maximumRequests: 1 })).status, 'existing');
  const [root] = await db.select().from(schema.coworkRequestLineages).where(eq(schema.coworkRequestLineages.id, first.request.lineageId));
  assert.equal(root!.maximumRequests, 2); assert.equal(root!.createdRequests, 2); assert.equal(root!.reviewRequests, 1);
});

test('causal depth and unit root binding prevent borrowing an unrelated lineage budget', async () => {
  const f = await fixture();
  const first = created(await f.enqueue(f.input({ kind: 'help' }), { ...f.limits, maximumDepth: 1 }));
  const child = created(await f.enqueue(f.input({ intentKey: 'child', kind: 'help', parentRequestId: first.request.id })));
  assert.equal(child.request.lineageId, first.request.lineageId);
  assert.equal((await f.enqueue(f.input({ intentKey: 'grandchild', kind: 'help', parentRequestId: child.request.id }))).status, 'budget_exhausted');
  const differentTask = await f.makeTask();
  const unrelatedUnit = await f.makeUnit({ taskId: differentTask });
  const unrelated = created(await f.enqueue(f.input({ unitId: unrelatedUnit, intentKey: 'unrelated', kind: 'help' })));
  assert.notEqual(unrelated.request.lineageId, first.request.lineageId);
  assert.equal((await f.enqueue(f.input({ intentKey: 'borrow', kind: 'help', parentRequestId: unrelated.request.id }))).status, 'unavailable');
  const inheritedUnit = await f.makeUnit({ taskId: differentTask, lineageTaskId: f.taskId });
  const inherited = created(await f.enqueue(f.input({ unitId: inheritedUnit, intentKey: 'explicit-inherited', kind: 'help', parentRequestId: first.request.id })));
  assert.equal(inherited.request.lineageId, first.request.lineageId);
  assert.equal(inherited.request.taskId, differentTask);
});

test('outer failure removes request, delivery and budget together', async () => {
  const f = await fixture();
  await assert.rejects(db.transaction(async (tx) => {
    await f.locks(tx);
    const command = f.input();
    created(await coworkRequestRows(tx).enqueue(f.sender, command, coWorkRequestFingerprint(command, f.sender.connectionId), f.limits));
    throw new Error('Outer completion failed');
  }), /Outer completion failed/);
  assert.deepEqual(await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.workspaceId, f.workspaceId)), []);
  assert.deepEqual(await db.select().from(schema.coworkRequestLineages).where(eq(schema.coworkRequestLineages.workspaceId, f.workspaceId)), []);
  created(await f.enqueue());
});

test('only a parent request party may extend its lineage, including another connection of the same owner', async () => {
  const f = await fixture();
  const parent = created(await f.enqueue());
  const snapshot = async () => ({
    requests: await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.workspaceId, f.workspaceId)).orderBy(asc(schema.coworkRequests.id)),
    lineage: await db.select().from(schema.coworkRequestLineages).where(eq(schema.coworkRequestLineages.id, parent.request.lineageId)),
    deliveries: await db.select().from(schema.coworkDeliveryIntents)
      .innerJoin(schema.coworkRequests, eq(schema.coworkRequests.id, schema.coworkDeliveryIntents.requestId))
      .where(eq(schema.coworkRequests.workspaceId, f.workspaceId)).orderBy(asc(schema.coworkDeliveryIntents.id)),
  });
  const before = await snapshot();
  const unrelated = f.input({ intentKey: 'third-party-child', kind: 'help', parentRequestId: parent.request.id });
  const rejected = await db.transaction(async (tx) => {
    await f.locks(tx);
    return coworkRequestRows(tx).enqueue(f.third, unrelated, coWorkRequestFingerprint(unrelated, f.third.connectionId), f.limits);
  });
  assert.equal(rejected.status, 'unavailable', 'the same owner and root/run do not make a third connection a party');
  assert.deepEqual(await snapshot(), before, 'refusal creates no request or delivery and consumes no lineage budget');

  const followup = created(await f.enqueue(f.input({ intentKey: 'sender-followup', kind: 'help', parentRequestId: parent.request.id })));
  assert.equal(followup.request.lineageId, parent.request.lineageId, 'the original sender can follow up');
  const responseUnit = await f.makeUnit({ connectionId: f.sender.connectionId, role: 'execute' });
  const response = f.input({ unitId: responseUnit, recipientConnectionId: f.sender.connectionId,
    intentKey: 'recipient-response', kind: 'help', parentRequestId: parent.request.id });
  const replied = created(await db.transaction(async (tx) => {
    await f.locks(tx);
    return coworkRequestRows(tx).enqueue(f.recipient, response, coWorkRequestFingerprint(response, f.recipient.connectionId), f.limits);
  }));
  assert.equal(replied.request.lineageId, parent.request.lineageId, 'the addressed recipient can respond in the same lineage');
});

test('ACK is connection/project scoped, idempotent and leaves pending work recoverable', async () => {
  const f = await fixture();
  const result = created(await f.enqueue());
  const rows = coworkRequestRows(db);
  assert.equal(await rows.acknowledge(f.third, result.deliveryIntentId), false);
  assert.equal(await rows.acknowledge({ ...f.recipient, projectId: randomUUID() }, result.deliveryIntentId), false);
  assert.equal(await rows.acknowledge(f.recipient, result.deliveryIntentId), true);
  const [before] = await db.select().from(schema.coworkDeliveryIntents).where(eq(schema.coworkDeliveryIntents.id, result.deliveryIntentId));
  assert.equal(await rows.acknowledge(f.recipient, result.deliveryIntentId), true);
  const [after] = await db.select().from(schema.coworkDeliveryIntents).where(eq(schema.coworkDeliveryIntents.id, result.deliveryIntentId));
  assert.deepEqual(after!.acknowledgedAt, before!.acknowledgedAt);
  const pending = (await rows.pendingPage(f.recipient, 10)).records;
  assert.equal(pending[0]!.id, result.request.id); assert.equal(pending[0]!.state, 'queued');
  assert.deepEqual((await rows.pendingPage(f.third, 10)).records, []);
});

test('busy deferral persists a boundary without preempting a live unit and stale versions fail', async () => {
  const f = await fixture();
  const busyUnit = await f.makeUnit({ role: 'execute' });
  await db.transaction(async (tx) => {
    await f.locks(tx);
    const scope = await coworkUnitRows(tx).lock({ ...f.recipient, unitId: busyUnit });
    assert.ok(scope);
    assert.ok(await scope.save({ ...scope.unit, state: 'claimed', version: 2, generation: 1,
      lease: { id: randomUUID(), runtimeSessionId: 'busy-session', expiresAt: new Date(0) } },
    { operation: 'claim', expectedVersion: 1, runtimeSessionId: 'busy-session', leaseSeconds: 30, maximumConnectionUnits: 1 }));
  });
  const [before] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, busyUnit));
  const request = created(await f.enqueue());
  const rows = coworkRequestRows(db);
  assert.equal(await rows.defer(f.third, request.request.id, 1, 'busy', 'after_tests'), null);
  const deferred = await rows.defer(f.recipient, request.request.id, 1, 'busy', 'after_tests');
  assert.equal(deferred!.state, 'deferred'); assert.equal(deferred!.nextBoundary, 'after_tests');
  assert.equal(await rows.defer(f.recipient, request.request.id, 1, 'busy', 'after_step'), null);
  await assert.rejects(rows.defer(f.recipient, request.request.id, 2, 'dependency', 'on_dependency'), /actual dependency/);
  const [after] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, busyUnit));
  assert.deepEqual(after, before);
});

test('bounded snapshot pagination preserves pending references and distinguishes lost claim from completion', async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) created(await f.enqueue(f.input({ intentKey: `request-${index}`, kind: 'help' })));
  const rows = coworkRequestRows(db);
  const initialPage = await rows.pendingPage(f.recipient, 1);
  const first = initialPage.records;
  assert.ok(initialPage.continuation);
  const second = (await rows.pendingPage(f.recipient, 1, initialPage.continuation)).records;
  assert.equal(first.length, 1); assert.equal(second.length, 1); assert.notEqual(first[0]!.id, second[0]!.id);
  await assert.rejects(rows.pendingPage(f.recipient, 51), /bounded inbox/);
  await db.update(schema.coworkRequests).set({ state: 'claimed', claimedGeneration: 1 }).where(eq(schema.coworkRequests.id, first[0]!.id));
  const recovered = (await rows.pendingPage(f.recipient, 3)).records;
  const lost = recovered.find((row) => row.id === first[0]!.id)!;
  assert.equal(lost.state, 'claimed'); assert.equal(lost.effectiveState, 'queued'); assert.equal(lost.readinessReason, 'claim_lost');
  await db.update(schema.coworkRequests).set({ expiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.coworkRequests.id, first[0]!.id));
  const expired = (await rows.pendingPage(f.recipient, 3)).records.find((row) => row.id === first[0]!.id)!;
  assert.equal(expired.effectiveState, 'expired'); assert.equal(expired.readinessReason, 'request_expired');
});

test('aging lets an old ordinary request outrank a new blocker and ranked continuation reaches later candidates', async () => {
  const f = await fixture();
  const old = created(await f.enqueue(f.input({ kind: 'help', intentKey: 'ordinary', priority: 0, peerUnblocking: false })));
  const recent = created(await f.enqueue(f.input({ kind: 'help', intentKey: 'blocker', priority: 3 })));
  await db.update(schema.coworkRequests).set({ createdAt: sql`clock_timestamp() - interval '1 hour'` }).where(eq(schema.coworkRequests.id, old.request.id));
  const rows = coworkRequestRows(db);
  const first = await rows.readyCandidates(f.recipient, 1);
  assert.equal(first.records[0]!.id, old.request.id); assert.ok(first.continuation);
  const next = await rows.readyCandidates(f.recipient, 1, 600, first.continuation);
  assert.equal(next.records[0]!.id, recent.request.id);
});

test('more than a page of high-priority busy requests cannot hide a claim-ready unit', async () => {
  const f = await fixture();
  for (let index = 0; index < 51; index++) created(await f.enqueue(f.input({ kind: 'help', intentKey: `busy-${index}`, priority: 3 })));
  const readyUnit = await f.makeUnit();
  const ready = created(await f.enqueue(f.input({ unitId: readyUnit, intentKey: 'ready', kind: 'help', priority: 0, peerUnblocking: false })));
  await db.update(schema.coworkUnits).set({ state: 'claimed', generation: 1, version: 2,
    leaseId: randomUUID(), leaseSessionId: 'current', leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'` }).where(eq(schema.coworkUnits.id, f.unitId));
  const candidates = await coworkRequestRows(db).readyCandidates(f.recipient, 50);
  assert.equal(candidates.records.length, 1); assert.equal(candidates.records[0]!.id, ready.request.id);
});

test('ranked pages reject changes to aging or recipient context instead of silently skipping eligible work', async () => {
  const f = await fixture();
  const older = created(await f.enqueue(f.input({ kind: 'help', intentKey: 'aged', priority: 1, peerUnblocking: false })));
  const recent = created(await f.enqueue(f.input({ kind: 'help', intentKey: 'recent', priority: 0, peerUnblocking: false })));
  await db.update(schema.coworkRequests).set({ createdAt: sql`clock_timestamp() - interval '20 minutes'` })
    .where(eq(schema.coworkRequests.id, older.request.id));
  const rows = coworkRequestRows(db);
  const first = await rows.readyCandidates(f.recipient, 1, 600);
  assert.equal(first.records[0]!.id, older.request.id); assert.ok(first.continuation);
  await assert.rejects(rows.readyCandidates(f.recipient, 1, 60, first.continuation), /does not match the scan/);
  for (const address of [f.third, { ...f.recipient, workspaceId: randomUUID() },
    { ...f.recipient, projectId: randomUUID() }])
    await assert.rejects(rows.readyCandidates(address, 1, 600, first.continuation), /does not match the scan/);
  const next = await rows.readyCandidates(f.recipient, 1, 600, first.continuation);
  assert.equal(next.records[0]!.id, recent.request.id);
});

test('strict reference normalization rejects prompt/credential fields, fake result versions and array kinds', async () => {
  const f = await fixture();
  const valid = f.input();
  for (const input of [{ ...valid, kind: ['review'] }, { ...valid, prompt: 'do anything' },
    { ...valid, target: { type: 'result', id: randomUUID(), version: 1 } },
    { ...valid, target: { type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(), headSha: 'a'.repeat(40), token: 'credential' } },
    { ...valid, sourceRefs: Array.from({ length: 17 }, () => valid.target) }]) assert.throws(() => normalizeCoWorkRequest(input));
  const upper = normalizeCoWorkRequest({ ...valid, commandId: valid.commandId.toUpperCase(), unitId: valid.unitId.toUpperCase() });
  assert.equal(coWorkRequestFingerprint(upper, f.sender.connectionId.toUpperCase()), coWorkRequestFingerprint(valid, f.sender.connectionId));
  assert.deepEqual(await db.select().from(schema.coworkRequests).where(eq(schema.coworkRequests.workspaceId, f.workspaceId)), []);
});
