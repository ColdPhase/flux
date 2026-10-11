import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { agentRuntimeUseCases, type RuntimeManagerPort, type RuntimeAuthOperation, type AgentRuntimeConfig } from '@flux/core';
import { agentRuntimeStore, agentRuntimeOperations, createDatabase } from '@flux/db';
import { db, pool, insertedHuman, connectionString } from './support/db.js';

// Actual DB adapter + production core. Manager barriers hold external responses without a DB
// connection. Physical late-CLI/reboot behavior is separately exercised by real supervisor/PTY tests.
function barrier() {
  let release!: () => void, enter!: () => void;
  let deadline: ReturnType<typeof setTimeout>;
  const entered = new Promise<void>((resolve,reject) => {
    deadline=setTimeout(()=>reject(new Error('external dispatch barrier not reached')),5000);
    enter=()=>{ clearTimeout(deadline); resolve(); };
  });
  const waiting = new Promise<void>(r => { release = r; });
  return { entered, release: () => { clearTimeout(deadline); release(); }, async hold() { enter(); await waiting; } };
}
const signed = { signedIn: true, facts: { authMethod: 'claude.ai', plan: 'max', accountLabel: 'a***@example.org', accountDigest: null } };
const config: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: null, idleDays: null,
  manager: { url: 'http://unused:1', secret: 'x'.repeat(40) } };
async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await work(f); } finally {
    await pool.query('DELETE FROM auth_users WHERE id=$1', [f.owner.id]);
    await pool.query('DELETE FROM agent_runtime_slots WHERE slot=$1', [f.slot]);
    await pool.query('UPDATE agent_runtime_auth_admission SET blocked=false,purge_id=NULL WHERE singleton');
    await f.second.pool.end();
  }
}
async function setup() {
  const owner = await insertedHuman('auth-core-owner'), sessionId = randomUUID(), bindingId = randomUUID(), bootId = randomUUID();
  const slot = `runtime-${900 + Math.floor(Math.random()*99)}`;
  await pool.query(`INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId,owner.id,`fixture-${randomUUID()}`]);
  await pool.query(`INSERT INTO agent_runtime_slots(slot,state,boot_id) VALUES ($1,'held',$2)`, [slot,bootId]);
  await pool.query(`INSERT INTO agent_runtime_bindings(id,owner_user_id,slot,state) VALUES ($1,$2,$3,'active')`, [bindingId,owner.id,slot]);
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: [] }; }, async bind() { return { ok:true,value:undefined }; },
    async release() { return { ok: true,value:{ dataEmpty:true,logoutFailed:false } }; },
    async status() { return { ok:true,value:{ ...signed,bootId } }; },
    async logout() { return { ok:true,value:{ logout:'ok',bootId } }; },
  };
  const second=createDatabase(connectionString), store=agentRuntimeStore(db), otherStore=agentRuntimeStore(second.db);
  const runtime=agentRuntimeUseCases(config,store,manager), otherRuntime=agentRuntimeUseCases(config,otherStore,manager);
  const actor={ ownerUserId:owner.id,sessionId };
  const console=async () => (await runtime.beginConsole(actor,'claude_code',{
    digest:createHash('sha256').update(randomUUID()).digest('hex'),expiresAt:new Date(Date.now()+60_000) })).operation;
  const observe=async (operation?:RuntimeAuthOperation) => {
    const op=operation??await console();
    return runtime.recordSignIn(owner.id,{ operation:op,method:'sso' },{ ...signed,bootId:op.bootId });
  };
  return { owner,slot,bindingId,bootId,sessionId,actor,manager,runtime,otherRuntime,store,otherStore,second,console,observe };
}

test('held old status + second API sign-out cannot revive access or invent confirmation', { timeout:10_000 }, () => fixture(async f => {
  await f.observe();
  const held=barrier();
  f.manager.status=async () => { await held.hold(); return { ok:true,value:{ ...signed,bootId:f.bootId } }; };
  const pending=f.runtime.check(f.owner.id,'claude_code',f.sessionId);
  try {
    await held.entered;
    assert.equal(pool.waitingCount,0); assert.equal(pool.totalCount,pool.idleCount,'no transaction held during manager wait');
    await assert.rejects(f.otherRuntime.signOut(f.owner.id,'claude_code',f.sessionId),/confirmed cleanup/);
    const view=await f.runtime.status(f.owner.id);
    assert.equal(view.binding?.recovery,true); assert.equal(view.connections.claude_code,null);
    held.release();
    const completed=await pending;
    assert.deepEqual(completed.authCompletion,{ kind:'check',disposition:'superseded' });
    assert.equal(completed.connections.claude_code,null);
    assert.equal((await pool.query('SELECT sign_out_failed FROM agent_runtime_connections WHERE binding_id=$1',[f.bindingId])).rows[0].sign_out_failed,null,'no false logout acknowledgement');
  } finally { held.release(); await pending.catch(()=>undefined); }
}));

test('sign-out is pending and authority disabled before cleanup; another console cannot replace it', { timeout:10_000 }, () => fixture(async f => {
  await f.observe(); const held=barrier();
  f.manager.logout=async () => { await held.hold(); return { ok:true,value:{ logout:'not_installed',bootId:f.bootId } }; };
  const pending=f.runtime.signOut(f.owner.id,'claude_code',f.sessionId);
  try {
    await held.entered;
    const view=await f.otherRuntime.status(f.owner.id);
    assert.equal(view.auth?.claude_code,'signing_out'); assert.equal(view.connections.claude_code?.state,'signed_out');
    assert.equal(view.connections.claude_code?.signOut,null,'pending is not confirmation');
    await assert.rejects(f.console(),/Another auth operation/);
    held.release(); const completed=await pending;
    assert.deepEqual(completed.authCompletion,{ kind:'logout',disposition:'accepted' });
    assert.equal(completed.connections.claude_code?.signOut?.failed,true);
    assert.deepEqual(completed.auth,{});
  } finally { held.release(); await pending.catch(()=>undefined); }
}));

test('rejected old console reports superseded even when a different operation is signed in', () => fixture(async f => {
  const old=await f.console(); assert.equal((await f.observe(old)).signedIn,true);
  await f.runtime.signOut(f.owner.id,'claude_code',f.sessionId);
  const newest=await f.observe(); assert.equal(newest.disposition,'accepted');
  const stale=await f.observe(old);
  assert.equal(stale.disposition,'superseded'); assert.equal(stale.signedIn,false);
  assert.equal(stale.status.connections.claude_code?.state,'signed_in','new owner view stays separate from this completion');
}));

test('lifecycle fence rejects obsolete logout INSERT fallback, and purge blocks new reservations', () => fixture(async f => {
  const admitted=await f.store.claimAuth({ ...f.actor,bindingId:f.bindingId,client:'claude_code',kind:'logout',leaseMs:60_000,lifetimeMs:120_000 });
  assert.ok(admitted.kind==='claimed');
  const purge=await agentRuntimeOperations(db).beginPurge();
  assert.equal(await f.store.recordSignOut(admitted.operation,false),false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runtime_connections WHERE binding_id=$1',[f.bindingId])).rows[0].n,0,'obsolete INSERT must make no row');
  const other=await insertedHuman('auth-purge-other');
  try { assert.equal((await f.otherStore.reserve(other.id,randomUUID())).kind,'starting'); }
  finally { await pool.query('DELETE FROM auth_users WHERE id=$1',[other.id]); }
  await assert.rejects(agentRuntimeOperations(db).forgetAll(randomUUID(),true),/current fenced cleanup/);
  assert.equal((await pool.query('SELECT blocked FROM agent_runtime_auth_admission WHERE singleton')).rows[0].blocked,true);
  // Component proof: caller's confirmed physical cleanup is covered by the launcher journey.
  await agentRuntimeOperations(db).forgetAll(purge,false);
  assert.equal((await f.runtime.status(f.owner.id)).lastRelease?.signOutFailed,true);
  assert.equal(await f.store.recordSignOut(admitted.operation,false),false);
}));


test('accepted status without required display facts cannot report a successful sign-in', () => fixture(async f => {
  const operation=await f.console();
  const answer=await f.runtime.recordSignIn(f.owner.id,{ operation,method:'sso' },{ signedIn:true,facts:null,bootId:f.bootId });
  assert.equal(answer.disposition,'accepted');assert.equal(answer.signedIn,false);
  assert.equal(answer.status.connections.claude_code?.state,'signed_out');
  assert.equal((await f.observe()).signedIn,true,'same real store with complete facts signs in');
}));
