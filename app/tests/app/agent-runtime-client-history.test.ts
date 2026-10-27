import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { reconcileAgentRuntime, type AgentRuntimeConfig, type RuntimeManagerPort, type RuntimeAuthOperation } from '@flux/core';
import { agentRuntimeOperations, agentRuntimeStore } from '@flux/db';
import { db, insertedHuman, pool } from './support/db.js';

// #480 (F-022 T3, #331 "never installed"): the durable client history of migration 0118 against the real
// PostgreSQL store. The decision at release does not depend on the slot's files: a missing CLI with nothing in
// the binding directory is confirmed only while the history says no login was ever started for that client.

const store = agentRuntimeStore(db);
const config: AgentRuntimeConfig = { clients: ['claude_code', 'codex'], commercialTermsAgreedOn: '2026-10-01', idleDays: null, manager: { url: 'http://unused:1', secret: 'x'.repeat(32) } };

async function owned(work: (c: { ownerUserId: string; sessionId: string; bindingId: string; slot: string; boot: string }) => Promise<void>) {
  const owner = await insertedHuman('client-history-owner');
  const sessionId = randomUUID(), bindingId = randomUUID(), boot = randomUUID();
  const slot = `runtime-${600 + Math.floor(Math.random() * 99)}`;
  await pool.query(`INSERT INTO auth_sessions(id, user_id, token, expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,
    [sessionId, owner.id, `test-cookie-${randomUUID()}`]);
  await pool.query(`INSERT INTO agent_runtime_slots(slot,state,boot_id) VALUES ($1,'held',$2)`, [slot, boot]);
  await pool.query(`INSERT INTO agent_runtime_bindings(id,owner_user_id,slot,state) VALUES ($1,$2,$3,'active')`, [bindingId, owner.id, slot]);
  try {
    await work({ ownerUserId: owner.id, sessionId, bindingId, slot, boot });
  } finally {
    await pool.query('DELETE FROM auth_users WHERE id=$1', [owner.id]);
    await pool.query('DELETE FROM agent_runtime_slots WHERE slot=$1', [slot]);
  }
}
const claim = async (c: { ownerUserId: string; sessionId: string; bindingId: string }, client: 'claude_code' | 'codex', kind: 'check' | 'logout' | 'console') => {
  const admitted = await store.claimAuth({ ownerUserId: c.ownerUserId, sessionId: c.sessionId, bindingId: c.bindingId, client, kind, leaseMs: 60_000, lifetimeMs: 120_000,
    ...(kind === 'console' ? { nonce: { digest: randomUUID().replaceAll('-', '').repeat(2), expiresAt: new Date(Date.now() + 60_000) } } : {}) });
  assert.equal(admitted.kind, 'claimed');
  return (admitted as { operation: RuntimeAuthOperation }).operation;
};
const signedIn = (operation: RuntimeAuthOperation) => ({ operation, ownerUserId: operation.ownerUserId, bindingId: operation.bindingId, client: operation.client,
  method: 'claude_account' as const, signedIn: true, facts: { authMethod: 'claude.ai', plan: 'max', accountLabel: 'a***@example.org' }, fingerprint: 'f'.repeat(64) });

test('a console claim writes the history before the slot is asked; a check or a logout does not', () => owned(async (c) => {
  assert.deepEqual(await store.loginPossible(c.bindingId), [], 'a fresh binding has no history');
  const check = await claim(c, 'claude_code', 'check');
  assert.deepEqual(await store.loginPossible(c.bindingId), [], 'reading the CLI status cannot create a login');
  assert.equal(await store.recordSignIn({ ...signedIn(check), method: null, signedIn: false, facts: null, fingerprint: null }), true);
  assert.deepEqual(await store.loginPossible(c.bindingId), [], 'a status that reports no login adds nothing');
  const console = await claim(c, 'codex', 'console');
  assert.deepEqual(await store.loginPossible(c.bindingId), ['codex'], 'claimed, before any slot call: the write-ahead record');
  // The command is abandoned without any result; the history still says a login may exist.
  await store.recoverAuth(console);
  assert.deepEqual(await store.loginPossible(c.bindingId), ['codex']);
}));

test('only a CLI logout that returned ok clears the history; a failed one keeps it and a later sign-in turns it on again', () => owned(async (c) => {
  const first = await claim(c, 'claude_code', 'console');
  assert.equal(await store.recordSignIn(signedIn(first)), true);
  assert.deepEqual(await store.loginPossible(c.bindingId), ['claude_code']);
  const failed = await claim(c, 'claude_code', 'logout');
  assert.equal(await store.recordSignOut(failed, true), true);
  assert.deepEqual(await store.loginPossible(c.bindingId), ['claude_code'], 'a failed, timed-out, skipped or not_installed logout is not a confirmation');
  const confirmed = await claim(c, 'claude_code', 'logout');
  assert.equal(await store.recordSignOut(confirmed, false), true);
  assert.deepEqual(await store.loginPossible(c.bindingId), [], 'the CLI said ok');
  const again = await claim(c, 'claude_code', 'console');
  assert.deepEqual(await store.loginPossible(c.bindingId), ['claude_code'], 'a new sign-in is a new possible login');
  await store.recoverAuth(again);
}));

test('a status that reports a login records it even when no console was claimed (a login the history did not know)', () => owned(async (c) => {
  const check = await claim(c, 'codex', 'check');
  assert.equal(await store.recordSignIn({ ...signedIn(check), client: 'codex', method: null }), true);
  assert.deepEqual(await store.loginPossible(c.bindingId), ['codex']);
}));

test('the worker\'s release: not_installed is confirmed only against the history, through the PostgreSQL store', () => owned(async (c) => {
  const dirs: string[] = [c.bindingId];
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: [{ slot: c.slot, reachable: true as const, bootId: c.boot, bindings: [...dirs], other: 0 }] }; },
    async bind() { return { ok: true, value: undefined }; },
    async release() { dirs.length = 0; return { ok: true, value: { dataEmpty: true, logoutFailed: false, notInstalled: ['claude_code', 'codex'] } }; },
    async status() { return { ok: false, code: 'x' }; },
    async logout() { return { ok: false, code: 'x' }; },
  };
  // Codex had a console claimed (so a login may exist); Claude Code never did.
  await claim(c, 'codex', 'console');
  await store.requestRelease({ ownerUserId: c.ownerUserId }, 'owner');
  await reconcileAgentRuntime({ config, store, manager });
  const row = (await pool.query(`SELECT state, release_logout_failed FROM agent_runtime_bindings WHERE id = $1`, [c.bindingId])).rows[0];
  assert.deepEqual([row.state, row.release_logout_failed], ['released', true], 'the slot found nothing, the history says a Codex login may exist');
}));

test('the worker\'s release is confirmed when the slot finds nothing and the history has no login (negative control)', () => owned(async (c) => {
  const dirs: string[] = [c.bindingId];
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: [{ slot: c.slot, reachable: true as const, bootId: c.boot, bindings: [...dirs], other: 0 }] }; },
    async bind() { return { ok: true, value: undefined }; },
    async release() { dirs.length = 0; return { ok: true, value: { dataEmpty: true, logoutFailed: false, notInstalled: ['claude_code', 'codex'] } }; },
    async status() { return { ok: false, code: 'x' }; },
    async logout() { return { ok: false, code: 'x' }; },
  };
  await store.requestRelease({ ownerUserId: c.ownerUserId }, 'owner');
  await reconcileAgentRuntime({ config, store, manager });
  const row = (await pool.query(`SELECT state, release_logout_failed FROM agent_runtime_bindings WHERE id = $1`, [c.bindingId])).rows[0];
  assert.deepEqual([row.state, row.release_logout_failed], ['released', false]);
}));

test('deleting the binding deletes its history (the table follows its owner)', () => owned(async (c) => {
  await claim(c, 'claude_code', 'console');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runtime_client_history WHERE binding_id = $1', [c.bindingId])).rows[0].n, 1);
  await pool.query('DELETE FROM agent_runtime_auth_operations WHERE binding_id = $1', [c.bindingId]);
  await pool.query('DELETE FROM agent_runtime_bindings WHERE id = $1', [c.bindingId]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runtime_client_history WHERE binding_id = $1', [c.bindingId])).rows[0].n, 0);
}));

test('purge: a client the slots reported not_installed is confirmed only against the history', async () => {
  const owner = await insertedHuman('client-history-purge');
  const bindingId = randomUUID();
  const rollback = new Error('rollback isolated purge fixture');
  const cases: { name: string; confirmed: boolean; pairs: { bindingId: string; client: 'claude_code' | 'codex' }[]; history: ('claude_code' | 'codex')[]; failed: boolean }[] = [
    { name: 'unconfirmed stays failed', confirmed: false, pairs: [], history: [], failed: true },
    { name: 'confirmed, nothing reported missing', confirmed: true, pairs: [], history: ['claude_code'], failed: false },
    { name: 'confirmed, missing and no history', confirmed: true, pairs: [{ bindingId, client: 'claude_code' }], history: [], failed: false },
    { name: 'confirmed, missing but the history has a login for it', confirmed: true, pairs: [{ bindingId, client: 'claude_code' }], history: ['claude_code'], failed: true },
    { name: 'confirmed, missing codex while only claude_code has history', confirmed: true, pairs: [{ bindingId, client: 'codex' }], history: ['claude_code'], failed: false },
    { name: 'a pair for another binding changes nothing', confirmed: true, pairs: [{ bindingId: randomUUID(), client: 'claude_code' }], history: ['claude_code'], failed: false },
  ];
  for (const scenario of cases) {
    // Purge updates every binding. Roll back the whole fixture, including nested adapter transactions.
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO agent_runtime_slots(slot, state) VALUES ('runtime-998', 'held')`);
      await tx.execute(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES (${bindingId}, ${owner.id}, 'runtime-998', 'active')`);
      for (const client of scenario.history) await tx.execute(sql`INSERT INTO agent_runtime_client_history(binding_id, client) VALUES (${bindingId}, ${client})`);
      const purgeId = await agentRuntimeOperations(tx).beginPurge();
      await agentRuntimeOperations(tx).forgetAll(purgeId, scenario.confirmed, scenario.pairs);
      const view = await agentRuntimeStore(tx).ownerView(owner.id);
      assert.equal(view.lastRelease?.reason, 'purge', scenario.name);
      assert.equal(view.lastRelease?.signOutFailed, scenario.failed, scenario.name);
      throw rollback;
    }), (error) => error === rollback, scenario.name);
  }
});
