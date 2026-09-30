import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { coworkUnitRows, createDatabase, schema, sql, type DbExecutor } from '@flux/db';
import { coWorkClaimPostcondition } from '@flux/core';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';

// Real SQL storage checks, not standing-grant, shared-receipt or supported-client acceptance.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
after(() => pool.end());
type Scope = NonNullable<Awaited<ReturnType<ReturnType<typeof coworkUnitRows>['lock']>>>;
type Unit = Scope['unit'];
function postgresCode(code: string) {
  return (error: unknown) => error instanceof Error
    && (error.cause as { code?: string } | undefined)?.code === code;
}

async function fixture() {
  const owner = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const connectionId = randomUUID();
  await db.insert(schema.authUsers).values({ id: owner, name: 'Storage owner', email: `${owner}@cowork.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, name: 'Storage fixture', createdBy: owner });
  await db.insert(schema.agents).values({ id: agentId, workspaceId, name: 'Local client', createdBy: owner });
  await db.insert(schema.agentConnections).values({ id: connectionId, workspaceId, agentId, ownerUserId: owner, scopes: ['flux.context.read'] });
  const makeUnit = async (role: 'execute' | 'review' | 'plan' = 'execute', assigned = connectionId) => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const unitId = randomUUID();
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'Native project', createdBy: owner });
    await db.insert(schema.projectWorkItems).values({ id: taskId, workspaceId, projectId, title: 'Native task', createdByKind: 'human', createdById: owner });
    await db.insert(schema.coworkUnits).values({ id: unitId, workspaceId, projectId, taskId, lineageTaskId: taskId, runId: randomUUID(), unitKey: 'first', role, assignmentConnectionId: assigned });
    return { workspaceId, projectId, connectionId: assigned, unitId };
  };
  return { owner, workspaceId, agentId, connectionId, makeUnit };
}
type Identity = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['makeUnit']>>;
function proposal(unit: Unit, operation: 'claim' | 'renew' | 'release', session = 'session-a', checkpointId = unit.checkpointId): Unit {
  return { ...unit, state: operation === 'release' ? 'paused' : 'claimed', version: unit.version + 1,
    generation: unit.generation + (operation === 'renew' ? 0 : 1), checkpointId,
    lease: operation === 'release' ? null : { id: operation === 'renew' ? unit.lease!.id : randomUUID(), runtimeSessionId: session, expiresAt: new Date(0) } };
}
function command(unit: Unit, operation: 'claim' | 'renew' | 'release', session = 'session-a', seconds = 30) {
  return { operation, expectedVersion: unit.version, generation: unit.generation, leaseId: unit.lease?.id,
    runtimeSessionId: session, leaseSeconds: seconds, maximumConnectionUnits: 1 };
}
async function lock(tx: DbExecutor, id: Identity) {
  const scope = await coworkUnitRows(tx).lock(id);
  assert.ok(scope);
  return scope;
}
async function claim(id: Identity, session = 'session-a', seconds = 30) {
  return db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    return scope.save(proposal(scope.unit, 'claim', session), command(scope.unit, 'claim', session, seconds));
  });
}
async function checkpoint(scope: Scope, overrides: Partial<{ generation: number; runtimeSessionId: string; leaseId: string }> = {}) {
  const id = randomUUID();
  assert.equal(await scope.insertCheckpoint({ id, generation: scope.unit.generation,
    leaseId: scope.unit.lease!.id, runtimeSessionId: scope.unit.lease!.runtimeSessionId,
    progress: { next: 'Continue native task', sources: [] }, ...overrides }), id);
  return id;
}

test('two sessions competing across projects and roles share one connection capacity slot', async () => {
  const f = await fixture();
  const first = await f.makeUnit('execute');
  const second = await f.makeUnit('review');
  const ready = barrier<number>();
  const release = barrier();
  const initial = db.transaction(async (tx) => {
    const scope = await lock(tx, first);
    const won = await scope.save(proposal(scope.unit, 'claim'), command(scope.unit, 'claim'));
    ready.resolve(await backendPid(tx));
    await release.promise;
    return won;
  });
  initial.catch(() => ready.resolve(-1));
  const pid = await ready.promise;
  if (pid < 0) await initial;
  const competing = claim(second, 'session-b');
  const done = settled(competing);
  try {
    await waitUntilBlockedBy(pool, pid);
    assert.equal(done(), false);
  } finally { release.resolve(); }
  assert.ok(await initial);
  assert.equal(await competing, null);
  const rows = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.assignmentConnectionId, f.connectionId));
  assert.equal(rows.filter((row) => row.state === 'claimed').length, 1);
});

test('separate connections can claim separate units and persisted DB deadline supplies the receipt condition', async () => {
  const f = await fixture();
  const other = randomUUID();
  await db.insert(schema.agentConnections).values({ id: other, workspaceId: f.workspaceId, agentId: f.agentId,
    ownerUserId: f.owner, scopes: ['flux.context.read'] });
  const a = await f.makeUnit();
  const b = await f.makeUnit('plan', other);
  const [one, two] = await Promise.all([claim(a), claim(b, 'other-session')]);
  assert.ok(one?.lease && two?.lease);
  assert.notEqual(one.lease.id, two.lease.id);
  const [row] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, a.unitId));
  assert.equal(coWorkClaimPostcondition(one).leaseExpiresAt, row!.leaseExpiresAt!.toISOString());
  assert.ok(one.lease.expiresAt.getTime() > Date.now());
});

test('renew waiting on a unit lock cannot resurrect a lease that expires during the wait', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  const original = await claim(id, 'session-a', 1);
  assert.ok(original?.lease);
  const ready = barrier<number>();
  const release = barrier();
  const holder = db.transaction(async (tx) => {
    await tx.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId)).for('update');
    ready.resolve(await backendPid(tx));
    await release.promise;
  });
  holder.catch(() => ready.resolve(-1));
  const pid = await ready.promise;
  if (pid < 0) await holder;
  const renewal = db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    return scope.save(proposal(scope.unit, 'renew'), command(original, 'renew'));
  });
  try {
    await waitUntilBlockedBy(pool, pid);
    let expired = false;
    while (!expired) {
      const time = await pool.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [original.lease.expiresAt]);
      expired = time.rows[0].expired;
      if (!expired) await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release.resolve(); }
  await holder;
  assert.equal(await renewal, null);
  const replacement = await claim(id, 'session-b');
  assert.equal(replacement?.generation, original.generation + 1);
  assert.notEqual(replacement?.lease?.id, original.lease.id);
});

test('old session, generation, version and checkpoint identities cannot release the current claim', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  assert.ok(await claim(id));
  await db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    const good = await checkpoint(scope);
    const release = proposal(scope.unit, 'release', 'session-a', good);
    for (const change of [{ runtimeSessionId: 'old-session' }, { generation: 0 }, { expectedVersion: 1 }, { leaseId: randomUUID() }]) {
      assert.equal(await scope.save(release, { ...command(scope.unit, 'release'), ...change }), null);
    }
    await assert.rejects(scope.save({ ...release, checkpointId: null }, command(scope.unit, 'release')), /Invalid proposed/);
    for (const mismatch of [{ generation: scope.unit.generation + 1 }, { runtimeSessionId: 'other-session' }, { connectionId: randomUUID() }]) {
      const wrong = randomUUID();
      await tx.insert(schema.coworkCheckpoints).values({ id: wrong, workspaceId: id.workspaceId, projectId: id.projectId,
        unitId: id.unitId, connectionId: id.connectionId, runtimeSessionId: 'session-a', generation: scope.unit.generation, progress: {}, ...mismatch });
      assert.equal(await scope.save({ ...release, checkpointId: wrong }, command(scope.unit, 'release')), null);
    }
    const paused = await scope.save(release, command(scope.unit, 'release'));
    assert.equal(paused?.state, 'paused');
    assert.equal(paused?.checkpointId, good);
    assert.equal(paused?.lease, null);
  });
});

test('claim/renew retain prior checkpoint and scoped lookup hides foreign units/checkpoints', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  assert.ok(await claim(id));
  let savedCheckpoint!: string;
  await db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    savedCheckpoint = await checkpoint(scope);
    await assert.rejects(scope.save(proposal(scope.unit, 'renew', 'session-a', savedCheckpoint), command(scope.unit, 'renew')), /Invalid proposed/);
    assert.ok(await scope.save(proposal(scope.unit, 'release', 'session-a', savedCheckpoint), command(scope.unit, 'release')));
  });
  await db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    await assert.rejects(scope.save(proposal(scope.unit, 'claim', 'session-b', null), command(scope.unit, 'claim', 'session-b')), /Invalid proposed/);
    assert.ok(await scope.save(proposal(scope.unit, 'claim', 'session-b'), command(scope.unit, 'claim', 'session-b')));
  });
  const foreign = await f.makeUnit();
  await db.transaction(async (tx) => {
    const scope = await lock(tx, foreign);
    assert.equal(await scope.checkpoint(savedCheckpoint), null);
    assert.equal(await coworkUnitRows(tx).lock({ ...id, projectId: foreign.projectId }), null);
  });
});

test('expiry after checkpoint insertion refuses release and enclosing rollback removes the checkpoint', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  assert.ok(await claim(id, 'session-a', 1));
  let attempted!: string;
  await assert.rejects(db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    attempted = await checkpoint(scope);
    await tx.execute(sql`SELECT pg_sleep(1.1)`);
    assert.equal(await scope.save(proposal(scope.unit, 'release', 'session-a', attempted), command(scope.unit, 'release')), null);
    throw new Error('Completion lost its fence');
  }), /Completion lost/);
  const rows = await db.select().from(schema.coworkCheckpoints).where(eq(schema.coworkCheckpoints.id, attempted));
  assert.deepEqual(rows, []);
});

test('revoke/delete preserve historical checkpoints and fence unfinished units once without reassigning', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  assert.ok(await claim(id));
  let checkpointId!: string;
  await db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    checkpointId = await checkpoint(scope);
    assert.ok(await scope.save(proposal(scope.unit, 'release', 'session-a', checkpointId), command(scope.unit, 'release')));
  });
  const active = await claim(id);
  assert.ok(active);
  await db.update(schema.agentConnections).set({ revokedAt: new Date() }).where(eq(schema.agentConnections.id, f.connectionId));
  const [stopped] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
  assert.equal(stopped!.state, 'stopped');
  assert.equal(stopped!.leaseId, null);
  assert.equal(stopped!.generation, active.generation + 1);
  assert.equal(stopped!.version, active.version + 1);
  assert.equal(stopped!.checkpointId, checkpointId);
  await db.delete(schema.agentConnections).where(eq(schema.agentConnections.id, f.connectionId));
  const [history] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
  assert.equal(history!.version, stopped!.version);
  assert.equal(history!.assignmentConnectionId, f.connectionId);
  const [progress] = await db.select().from(schema.coworkCheckpoints).where(eq(schema.coworkCheckpoints.id, checkpointId));
  assert.equal(progress!.connectionId, f.connectionId);
  assert.deepEqual(await db.select().from(schema.coworkConnectionSlots).where(eq(schema.coworkConnectionSlots.connectionId, f.connectionId)), []);
  await assert.rejects(db.transaction((tx) => coworkUnitRows(tx).lock(id)), postgresCode('23503'));
});

test('deletion rolls back its fence and slot removal together with the outer lifecycle transaction', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  const active = await claim(id);
  assert.ok(active);
  await assert.rejects(db.transaction(async (tx) => {
    await tx.delete(schema.agentConnections).where(eq(schema.agentConnections.id, f.connectionId));
    const [row] = await tx.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
    assert.equal(row!.state, 'stopped');
    throw new Error('Lifecycle rollback');
  }), /Lifecycle rollback/);
  const [row] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
  assert.equal(row!.state, 'claimed');
  assert.equal(row!.version, active.version);
  assert.equal(row!.leaseId, active.lease!.id);
  assert.equal((await db.select().from(schema.agentConnections).where(eq(schema.agentConnections.id, f.connectionId))).length, 1);
});

test('native unit association, correlation uniqueness and bounded checkpoint JSON are enforced by SQL', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  const [unit] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
  await assert.rejects(db.insert(schema.coworkUnits).values({ ...unit!, id: randomUUID() }), postgresCode('23505'));
  await assert.rejects(db.insert(schema.coworkUnits).values({ ...unit!, id: randomUUID(), taskId: randomUUID() }), postgresCode('23503'));
  assert.ok(await claim(id));
  await assert.rejects(db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    await scope.insertCheckpoint({ id: randomUUID(), generation: scope.unit.generation, leaseId: scope.unit.lease!.id,
      runtimeSessionId: 'session-a', progress: { body: 'x'.repeat(17000) } });
  }), postgresCode('23514'));
  assert.equal((await db.select().from(schema.coworkCheckpoints).where(and(eq(schema.coworkCheckpoints.unitId, id.unitId),
    eq(schema.coworkCheckpoints.workspaceId, f.workspaceId)))).length, 0);
});

test('connection deletion fences active and pending units while completed history is byte-preserved', async () => {
  const f = await fixture();
  const active = await f.makeUnit();
  const pending = await f.makeUnit('review');
  const terminal = await f.makeUnit('plan');
  assert.ok(await claim(active));
  await db.update(schema.coworkUnits).set({ state: 'completed' }).where(eq(schema.coworkUnits.id, terminal.unitId));
  const [before] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, terminal.unitId));
  await db.delete(schema.agentConnections).where(eq(schema.agentConnections.id, f.connectionId));
  for (const id of [active, pending]) {
    const [row] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
    assert.equal(row!.state, 'stopped');
    assert.equal(row!.leaseId, null);
    assert.equal(row!.assignmentConnectionId, f.connectionId);
  }
  const [after] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, terminal.unitId));
  assert.deepEqual(after, before);
});

test('checkpoint commit precedes waiting revocation, which then fences it without dropping progress', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  assert.ok(await claim(id));
  const ready = barrier<number>();
  const release = barrier();
  let checkpointId!: string;
  const writer = db.transaction(async (tx) => {
    // The real #152 adapter must take its current authorization locks first.
    // This verifies storage composition/linearization, not that still-pending adapter.
    await tx.select().from(schema.agentConnections).where(eq(schema.agentConnections.id, f.connectionId)).for('share');
    const scope = await lock(tx, id);
    checkpointId = await checkpoint(scope);
    const paused = await scope.save(proposal(scope.unit, 'release', 'session-a', checkpointId), command(scope.unit, 'release'));
    assert.ok(paused);
    ready.resolve(await backendPid(tx));
    await release.promise;
  });
  writer.catch(() => ready.resolve(-1));
  const pid = await ready.promise;
  if (pid < 0) await writer;
  const revoker = db.update(schema.agentConnections).set({ revokedAt: new Date() }).where(eq(schema.agentConnections.id, f.connectionId)).execute();
  const done = settled(revoker);
  try { await waitUntilBlockedBy(pool, pid); assert.equal(done(), false); }
  finally { release.resolve(); }
  await writer;
  await revoker;
  const [row] = await db.select().from(schema.coworkUnits).where(eq(schema.coworkUnits.id, id.unitId));
  assert.equal(row!.state, 'stopped');
  assert.equal(row!.checkpointId, checkpointId);
  assert.equal((await db.select().from(schema.coworkCheckpoints).where(eq(schema.coworkCheckpoints.id, checkpointId))).length, 1);
});

test('revocation trigger effects roll back and expired/stale checkpoint inserts produce no rows', async () => {
  const f = await fixture();
  const id = await f.makeUnit();
  const active = await claim(id);
  assert.ok(active);
  await assert.rejects(db.transaction(async (tx) => {
    await tx.update(schema.agentConnections).set({ revokedAt: new Date() }).where(eq(schema.agentConnections.id, f.connectionId));
    throw new Error('Revoke rollback');
  }), /Revoke rollback/);
  const [connection] = await db.select().from(schema.agentConnections).where(eq(schema.agentConnections.id, f.connectionId));
  assert.equal(connection!.revokedAt, null);
  await db.transaction(async (tx) => {
    const scope = await lock(tx, id);
    assert.equal(scope.unit.version, active.version);
    for (const change of [{ generation: 0 }, { runtimeSessionId: 'old-session' }, { leaseId: randomUUID() }]) {
      assert.equal(await scope.insertCheckpoint({ id: randomUUID(), generation: scope.unit.generation,
        runtimeSessionId: 'session-a', leaseId: scope.unit.lease!.id, progress: {}, ...change }), null);
    }
  });
});
