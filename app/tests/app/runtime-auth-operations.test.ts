import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createDatabase, currentRuntimeAuthOperation, runtimeAuthOperations, settleRuntimeAuthOperation,
  RuntimeAuthSupersededError,
  type RuntimeAuthClaim, type RuntimeAuthOperation,
} from '@flux/db';
import { database, db, insertedHuman, pool, connectionString } from './support/db.js';

async function fixture(work: (target: RuntimeAuthClaim, operation: ReturnType<typeof runtimeAuthOperations>) => Promise<void>) {
  const owner = await insertedHuman('auth-fence-owner');
  const sessionId = randomUUID(), bindingId = randomUUID(), boot = randomUUID();
  const slot = `runtime-${900 + Math.floor(Math.random() * 99)}`;
  await pool.query(`INSERT INTO auth_sessions(id, user_id, token, expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,
    [sessionId, owner.id, `test-cookie-${randomUUID()}`]);
  await pool.query(`INSERT INTO agent_runtime_slots(slot,state,boot_id) VALUES ($1,'held',$2)`, [slot, boot]);
  await pool.query(`INSERT INTO agent_runtime_bindings(id,owner_user_id,slot,state) VALUES ($1,$2,$3,'active')`, [bindingId, owner.id, slot]);
  try {
    await work({ ownerUserId: owner.id, sessionId, bindingId, client: 'claude_code', kind: 'check', leaseMs: 60_000, lifetimeMs: 120_000 }, runtimeAuthOperations(db));
  } finally {
    await pool.query('DELETE FROM auth_users WHERE id=$1', [owner.id]);
    await pool.query('DELETE FROM agent_runtime_slots WHERE slot=$1', [slot]);
    await pool.query('UPDATE agent_runtime_auth_admission SET blocked=false,purge_id=NULL WHERE singleton');
  }
}
const claimed = (answer: Awaited<ReturnType<ReturnType<typeof runtimeAuthOperations>['claim']>>) => {
  assert.equal(answer.kind, 'claimed');
  assert.ok(answer.kind === 'claimed');
  return answer.operation;
};
async function finish(operation: RuntimeAuthOperation) {
  return db.transaction(async tx => {
    if (!await currentRuntimeAuthOperation(tx, operation)) return 'superseded';
    await settleRuntimeAuthOperation(tx, operation);
    return 'accepted';
  });
}

test('two independent PostgreSQL API pools admit exactly one current operation; no connection waits externally', () => fixture(async target => {
  const second = createDatabase(connectionString);
  try {
    const [a,b] = await Promise.all([runtimeAuthOperations(db).claim(target), runtimeAuthOperations(second.db).claim(target)]);
    assert.deepEqual([a.kind,b.kind].sort(), ['busy','claimed']);
    assert.equal(database.pool.waitingCount, 0);
    assert.equal(second.pool.waitingCount, 0);
    assert.equal(database.pool.totalCount, database.pool.idleCount);
    assert.equal(second.pool.totalCount, second.pool.idleCount);
    const operation = claimed(a.kind === 'claimed' ? a : b);
    assert.equal(await finish(operation), 'accepted');
    const next = claimed(await runtimeAuthOperations(second.db).claim(target));
    assert.equal(next.revision, operation.revision + 1);
    assert.equal(await finish(operation), 'superseded', 'old completion cannot settle a newer operation');
    assert.equal(await finish(next), 'accepted');
  } finally { await second.pool.end(); }
}));

test('one verified console nonce is consumed across independent API pools, not a local Map', () => fixture(async target => {
  const second = createDatabase(connectionString);
  const nonce = { digest: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now()+60_000) };
  try {
    const input: RuntimeAuthClaim = { ...target, kind: 'console', lifetimeMs: 900_000, nonce };
    const [a,b] = await Promise.all([runtimeAuthOperations(db).claim(input), runtimeAuthOperations(second.db).claim(input)]);
    assert.deepEqual([a.kind,b.kind].sort(), ['claimed','ticket_replayed']);
    const operation = claimed(a.kind === 'claimed' ? a : b);
    assert.equal(await finish(operation), 'accepted');
    assert.equal((await runtimeAuthOperations(second.db).claim(input)).kind, 'ticket_replayed');
    const raw = JSON.stringify((await pool.query('SELECT * FROM agent_runtime_auth_operations WHERE binding_id=$1', [target.bindingId])).rows);
    assert.ok(!raw.includes(target.sessionId), 'session record ID stays ephemeral; only its digest is retained');
  } finally { await second.pool.end(); }
}));

test('expired operations cannot renew or be stolen on the same binding; recovery disables both clients', () => fixture(async (target,operations) => {
  const operation = claimed(await operations.claim(target));
  await pool.query(`UPDATE agent_runtime_auth_operations SET claimed_at=clock_timestamp()-interval '2 minutes',
    lease_ends_at=clock_timestamp()-interval '1 minute' WHERE binding_id=$1`, [target.bindingId]);
  assert.equal(await operations.renew(operation,60_000), false);
  assert.equal((await operations.claim({ ...target, kind:'logout' })).kind, 'recovery');
  assert.equal((await pool.query('SELECT state,release_reason FROM agent_runtime_bindings WHERE id=$1',[target.bindingId])).rows[0].state,'releasing');
  assert.equal((await pool.query('SELECT phase FROM agent_runtime_auth_operations WHERE binding_id=$1',[target.bindingId])).rows[0].phase,'uncertain');
  assert.equal(await finish(operation),'superseded');
  assert.equal((await operations.claim({ ...target,client:'codex' })).kind,'superseded');
}));

test('wrong owner/client/boot/revision and a revoked session cannot complete or renew', () => fixture(async (target,operations) => {
  const operation=claimed(await operations.claim(target));
  for (const wrong of [ { ...operation,ownerUserId:randomUUID() }, { ...operation,client:'codex' as const },
    { ...operation,bootId:randomUUID() }, { ...operation,revision:operation.revision+1 } ]) {
    assert.equal(await finish(wrong),'superseded');
    assert.equal(await operations.renew(wrong,60_000),false);
  }
  await pool.query('DELETE FROM auth_sessions WHERE id=$1',[target.sessionId]);
  assert.equal(await finish(operation),'superseded');
  assert.equal(await operations.renew(operation,60_000),false);
  assert.equal(await operations.uncertain(operation),true,'session loss can restrict authority but never increase it');
  assert.equal((await pool.query('SELECT state FROM agent_runtime_bindings WHERE id=$1',[target.bindingId])).rows[0].state,'releasing');
}));

test('lifecycle revocation and operator purge fence completion and all new admission until confirmed cleanup', () => fixture(async (target,operations) => {
  const operation=claimed(await operations.claim(target));
  const purge=await operations.beginPurge();
  assert.equal((await operations.claim(target)).kind,'superseded');
  assert.equal(await finish(operation),'superseded');
  assert.equal(await operations.finishPurge(purge,false),false);
  assert.equal(await operations.finishPurge(randomUUID(),true),false);
  assert.equal((await pool.query('SELECT blocked FROM agent_runtime_auth_admission WHERE singleton')).rows[0].blocked,true);
  assert.equal(await operations.finishPurge(purge,true),true);
  // Logical gate opening does not revive a releasing binding or old completion.
  assert.equal((await operations.claim(target)).kind,'superseded');
  assert.equal(await finish(operation),'superseded');
}));

test('a lost operation becomes a full release request through the existing reconciliation seam', () => fixture(async (target,operations) => {
  const operation=claimed(await operations.claim(target));
  await pool.query(`UPDATE agent_runtime_auth_operations SET claimed_at=clock_timestamp()-interval '2 minutes',
    lease_ends_at=clock_timestamp()-interval '1 minute' WHERE binding_id=$1`,[target.bindingId]);
  assert.equal(await operations.recoverAbandoned(),1);
  assert.equal(await operations.recoverAbandoned(),0,'already releasing is not admitted or taken over again');
  assert.equal(await finish(operation),'superseded');
}));

test('expired nonce rollback leaves no phantom operation and neither nonce nor metadata accepts credential text', () => fixture(async (target,operations) => {
  await assert.rejects(operations.claim({ ...target,kind:'console',nonce:{ digest:'a'.repeat(64),expiresAt:new Date(0) } }),/nonce expired/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runtime_auth_operations WHERE binding_id=$1',[target.bindingId])).rows[0].n,0);
  await assert.rejects(async () => operations.claim({ ...target,kind:'console',nonce:{ digest:'sk-ant-seeded-credential',expiresAt:new Date(Date.now()+60_000) } }),/Invalid internal/);
  claimed(await operations.claim(target));
  await assert.rejects(pool.query(`UPDATE agent_runtime_auth_operations SET actor_digest='sk-ant-seeded-credential'
    WHERE binding_id=$1`,[target.bindingId]),/actor_digest_check/);
  await assert.rejects(pool.query(`UPDATE agent_runtime_auth_operations SET kind='arbitrary-command'
    WHERE binding_id=$1`,[target.bindingId]),/kind_check/);
}));

test('expiry between initial validation and final CAS rolls the complete transaction back', () => fixture(async (target,operations) => {
  const operation=claimed(await operations.claim(target));
  await assert.rejects(db.transaction(async tx => {
    assert.equal(await currentRuntimeAuthOperation(tx,operation),true);
    // Controlled expiry barrier, without a timing sleep or held external wait.
    await tx.execute((await import('drizzle-orm')).sql`UPDATE agent_runtime_auth_operations
      SET claimed_at=clock_timestamp()-interval '2 minutes', lease_ends_at=clock_timestamp()-interval '1 minute'
      WHERE binding_id=${target.bindingId}`);
    await settleRuntimeAuthOperation(tx,operation);
  }),RuntimeAuthSupersededError);
  assert.equal(await finish(operation),'accepted','failed settlement rolled all provisional changes back');
}));

test('paired reverse refuses unsafe active metadata and restores T4 after settled metadata is removed', () => fixture(async (target,operations) => {
  const { readFile } = await import('node:fs/promises');
  const reverse=await readFile('packages/db/migrations/reverse/0058_agent_runtime_auth_operations.down.sql','utf8');
  const operation=claimed(await operations.claim(target));
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(reverse),/recovery\/admission\/history must be resolved/);
    await client.query('ROLLBACK');
    assert.equal(await finish(operation),'accepted');
    await client.query('BEGIN');
    await client.query(reverse);
    assert.equal((await client.query("SELECT to_regclass('agent_runtime_auth_operations') present")).rows[0].present,null);
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK').catch(()=>undefined);client.release(); }
}));
