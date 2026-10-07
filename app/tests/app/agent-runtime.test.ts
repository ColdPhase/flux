import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_PATH } from '@flux/contracts';
import { agentRuntimeUseCases, reconcileAgentRuntime, type AgentRuntimeConfig, type DomainError, type RuntimeManagerPort } from '@flux/core';
import { agentRuntimeOperations, agentRuntimeStore } from '@flux/db';
import { Browser } from './support/http.js';
import { db, insertedHuman, pool } from './support/db.js';
import { expectStatus, person } from './support/people.js';

// F-022 T3 (#278) against the running API and PostgreSQL of the normal test stack, where the operator
// switch FLUX_AGENT_RUNTIME is empty (the default). The live runtime with slots is
// scripts/check_agent_runtime.sh.

describe('the operator switch is off by default', () => {
  test('the API reports the runtime disabled and refuses every command', async () => {
    const ada = await person('Runtime Off Ada');
    const status = expectStatus(await ada.browser.request('GET', AGENT_RUNTIME_PATH), 200);
    assert.deepEqual(status, { enabled: false, clients: { claude_code: 'off', codex: 'off' }, commercialTerms: null, idleReleaseDays: null,
      pool: 'off', binding: null, lastRelease: null });
    for (const method of ['POST', 'DELETE']) {
      const refused = expectStatus(await ada.browser.request(method, AGENT_RUNTIME_BINDING_PATH), 409) as { code: string };
      assert.equal(refused.code, 'AGENT_RUNTIME_OFF');
    }
    assert.equal((await new Browser().request('GET', AGENT_RUNTIME_PATH)).status, 401);
  });

  test('no request input is accepted: no slot, binding or owner can be named', async () => {
    const ada = await person('Runtime Input Ada');
    for (const path of [`${AGENT_RUNTIME_PATH}?slot=runtime-2`, `${AGENT_RUNTIME_PATH}?ownerId=x`, `${AGENT_RUNTIME_BINDING_PATH}?bindingId=${randomUUID()}`]) {
      const refused = expectStatus(await ada.browser.request(path.startsWith(AGENT_RUNTIME_BINDING_PATH) ? 'POST' : 'GET', path), 400) as { code: string };
      assert.equal(refused.code, 'AGENT_RUNTIME_NO_INPUT', path);
    }
    for (const body of [{ slot: 'runtime-2' }, { ownerId: 'someone' }, { bindingId: randomUUID() }, { client: 'codex' }, ['runtime-1']]) {
      const refused = expectStatus(await ada.browser.request('POST', AGENT_RUNTIME_BINDING_PATH, { body }), 400) as { code: string };
      assert.equal(refused.code, 'AGENT_RUNTIME_NO_INPUT', JSON.stringify(body));
    }
    for (const path of [`${AGENT_RUNTIME_BINDING_PATH}/${randomUUID()}`, '/api/v1/agent-runtime/slots/runtime-2', '/api/v1/agent-runtime/slots']) {
      assert.equal((await ada.browser.request('GET', path)).status, 404, path);
    }
  });
});

describe('runtime tables hold display facts only', () => {
  // Every column of every runtime table, reviewed. A new column fails here until it is reviewed: none
  // may hold a vendor credential, a token or a session (F-022 "Secrets and honesty").
  const REVIEWED: Record<string, string[]> = {
    agent_runtime_slots: ['slot:text', 'state:text', 'boot_id:uuid', 'wipe_boot_id:uuid', 'out_of_pool_reason:text', 'reported_at:timestamp with time zone', 'updated_at:timestamp with time zone'],
    agent_runtime_bindings: ['id:uuid', 'owner_user_id:text', 'slot:text', 'state:text', 'created_at:timestamp with time zone', 'last_used_at:timestamp with time zone',
      'release_reason:text', 'release_requested_at:timestamp with time zone', 'released_at:timestamp with time zone', 'release_logout_failed:boolean'],
    agent_runtime_connections: ['id:uuid', 'owner_user_id:text', 'binding_id:uuid', 'transport:text', 'client:text', 'state:text', 'sign_in_method:text', 'auth_method:text',
      'plan_label:text', 'account_label:text', 'signed_in_at:timestamp with time zone', 'created_at:timestamp with time zone', 'revoked_at:timestamp with time zone'],
    agent_runtime_operator_statements: ['statement:text', 'agreed_on:date', 'recorded_at:timestamp with time zone'],
  };
  // agent_runtime_sessions (0034) is unrelated: mode (b) MCP client sessions, outside the runtime transport.
  const RUNTIME_TABLES = Object.keys(REVIEWED);
  const TOKEN_LIKE = /token|secret|password|passwd|credential|cookie|session|bearer|jwt|refresh|api_?key|private|cipher|encrypted|auth_json|oauth|code_verifier|device_code/i;

  test('the columns are exactly the reviewed display facts, and none is token-shaped', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(`SELECT table_name, column_name, data_type
      FROM information_schema.columns WHERE table_schema = 'public' AND (table_name = ANY($1) OR table_name LIKE 'runtime\\_%'
        OR (table_name LIKE 'agent\\_runtime\\_%' AND table_name <> 'agent_runtime_sessions')) ORDER BY table_name, ordinal_position`, [RUNTIME_TABLES]);
    const actual: Record<string, string[]> = {};
    for (const row of rows) (actual[row.table_name] ??= []).push(`${row.column_name}:${row.data_type}`);
    assert.deepEqual(actual, REVIEWED);
    for (const row of rows) assert.doesNotMatch(row.column_name, TOKEN_LIKE, `${row.table_name}.${row.column_name}`);
    // No JSON or binary column could carry an opaque blob either.
    assert.ok(rows.every((row) => !['json', 'jsonb', 'bytea'].includes(row.data_type)));
  });

  test('the check fails on a token-shaped column (the guard itself works)', () => {
    for (const name of ['refresh_token', 'access_token', 'oauth_state', 'session_key', 'api_key', 'encrypted_login', 'credentials_json']) assert.match(name, TOKEN_LIKE);
    for (const name of ['auth_method', 'plan_label', 'account_label', 'sign_in_method']) assert.doesNotMatch(name, TOKEN_LIKE);
  });

  test('a binding id is a canonical version 4 UUID by CHECK, and display labels are bounded', async () => {
    const owner = await insertedHuman('runtime-check-owner');
    const slot = `runtime-${700 + Math.floor(Math.random() * 99)}`;
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'ready')`, [slot]);
    try {
      for (const id of ['00000000-0000-1000-8000-000000000000', '6ba7b810-9dad-11d1-80b4-00c04fd430c8']) {
        await assert.rejects(pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [id, owner.id, slot]), /agent_runtime_bindings_id_check/);
      }
      await assert.rejects(pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ('../runtime-1', 'ready')`), /check/i);
      const binding = randomUUID();
      await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [binding, owner.id, slot]);
      const connection = (label: string) => pool.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, account_label)
        VALUES ($1, $2, $3, 'claude_code', 'signed_out', $4)`, [randomUUID(), owner.id, binding, label]);
      await assert.rejects(connection('ada@example.org'), /check/i, 'an unmasked account label is refused');
      await assert.rejects(connection(`sk-ant-${'a'.repeat(90)}`), /check/i);
      await connection('a***@example.org');
    } finally {
      await pool.query('DELETE FROM agent_runtime_bindings WHERE slot = $1', [slot]);
      await pool.query('DELETE FROM agent_runtime_slots WHERE slot = $1', [slot]);
    }
  });
});

describe('the PostgreSQL store under the owner use cases', () => {
  const config: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: null, idleDays: null, manager: { url: 'http://unused:1', secret: 'x'.repeat(32) } };
  const base = 800 + Math.floor(Math.random() * 90);
  const slots = [`runtime-${base}`, `runtime-${base + 1}`];
  const dirs = new Map<string, string[]>(slots.map((slot) => [slot, []]));
  const boots = new Map<string, string>(slots.map((slot) => [slot, randomUUID()]));
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: slots.map((slot) => ({ slot, reachable: true as const, bootId: boots.get(slot)!, bindings: [...dirs.get(slot)!], other: 0 })) }; },
    async bind(slot, id) { if (dirs.get(slot)!.length) return { ok: false, code: 'data_not_empty' }; dirs.get(slot)!.push(id); return { ok: true, value: undefined }; },
    async release(slot, id) { dirs.set(slot, dirs.get(slot)!.filter((dir) => dir !== id)); boots.set(slot, randomUUID()); return { ok: true, value: { dataEmpty: true, logoutFailed: true } }; },
  };
  const store = agentRuntimeStore(db);

  test('two owners racing for the last free slot: exactly one gets it, the other sees the pool full', async () => {
    try {
      await reconcileAgentRuntime({ config, store, manager });
      const runtime = agentRuntimeUseCases(config, store, manager);
      const [ada, jonas, mia] = await Promise.all([insertedHuman('runtime-ada'), insertedHuman('runtime-jonas'), insertedHuman('runtime-mia')]);
      // Only our two slots may be bindable in this shared database.
      const others = await pool.query(`SELECT count(*)::int AS n FROM agent_runtime_slots WHERE state = 'ready' AND slot <> ALL($1)`, [slots]);
      assert.equal(others.rows[0].n, 0);
      await runtime.bind(ada.id);
      const outcomes = await Promise.allSettled([runtime.bind(jonas.id), runtime.bind(mia.id)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      assert.equal((refused.reason as DomainError).code, 'AGENT_RUNTIME_POOL_FULL');
      const bound = await pool.query(`SELECT slot, owner_user_id FROM agent_runtime_bindings WHERE slot = ANY($1) AND state = 'active' ORDER BY slot`, [slots]);
      assert.equal(new Set(bound.rows.map((row) => row.slot)).size, 2, 'two owners, two slots');
      // Release with a failed sign-out: the owner is told.
      await runtime.remove(ada.id);
      await reconcileAgentRuntime({ config, store, manager });
      const status = await runtime.status(ada.id);
      assert.equal(status.binding, null);
      assert.deepEqual([status.lastRelease?.reason, status.lastRelease?.signOutFailed], ['owner', true]);
      // The operator's view and release by slot.
      const listed = (await agentRuntimeOperations(db).list()).filter((row) => slots.includes(row.slot));
      assert.equal(listed.length, 2);
      const jonasOrMia = bound.rows.find((row) => row.owner_user_id !== ada.id)!;
      assert.ok(await agentRuntimeOperations(db).release(jonasOrMia.slot));
      await reconcileAgentRuntime({ config, store, manager });
      assert.equal((await runtime.status(jonasOrMia.owner_user_id)).lastRelease?.reason, 'operator');
    } finally {
      await pool.query('DELETE FROM agent_runtime_bindings WHERE slot = ANY($1)', [slots]);
      await pool.query('DELETE FROM agent_runtime_slots WHERE slot = ANY($1)', [slots]);
    }
  });
});

describe('purge records confirmed and unconfirmed vendor logout', () => {
  for (const confirmed of [undefined, false, true]) {
    test(`owner history reports signOutFailed=${confirmed !== true} after ${String(confirmed)} cleanup`, async () => {
      const owner = await insertedHuman('runtime-purge');
      const historicalOwner = await insertedHuman('runtime-previous-release');
      const rollback = new Error('rollback isolated purge fixture');
      // Purge updates every binding. Roll back the whole test, including nested adapter
      // transactions, so this regression cannot alter other owners' runtime state.
      await assert.rejects(db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO agent_runtime_slots(slot, state) VALUES ('runtime-999', 'held')`);
        await tx.execute(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state)
          VALUES (${randomUUID()}, ${owner.id}, 'runtime-999', 'active')`);
        await tx.execute(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state, release_reason, released_at, release_logout_failed)
          VALUES (${randomUUID()}, ${historicalOwner.id}, 'runtime-999', 'released', 'owner', now() - interval '1 day', true)`);
        await agentRuntimeOperations(tx).forgetAll(confirmed);
        const view = await agentRuntimeStore(tx).ownerView(owner.id);
        assert.equal(view.binding, null);
        assert.equal(view.lastRelease?.reason, 'purge');
        assert.equal(view.lastRelease?.signOutFailed, confirmed !== true);
        const historical = await agentRuntimeStore(tx).ownerView(historicalOwner.id);
        assert.equal(historical.lastRelease?.reason, 'owner');
        assert.equal(historical.lastRelease?.signOutFailed, true, 'purge preserves earlier release failures');
        throw rollback;
      }), (error) => error === rollback);
    });
  }
});

describe('migration 0056 reverses only before use', () => {
  test('refused with a binding, and drops the runtime tables without one (inside a rolled-back transaction)', async () => {
    const down = await readFile('packages/db/migrations/reverse/0056_agent_runtime.down.sql', 'utf8');
    const client = await pool.connect();
    try {
      const owner = await insertedHuman('runtime-reverse');
      await client.query('BEGIN');
      await client.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ('runtime-999', 'held')`);
      await client.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, 'runtime-999', 'active')`, [randomUUID(), owner.id]);
      await client.query('SAVEPOINT before_reverse');
      await assert.rejects(client.query(down), /0056 reversal refused/);
      await client.query('ROLLBACK TO SAVEPOINT before_reverse');
      await client.query('DELETE FROM agent_runtime_bindings');
      await client.query('DELETE FROM agent_runtime_connections');
      await client.query(down);
      const left = await client.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ANY($1)`,
        [['agent_runtime_slots', 'agent_runtime_bindings', 'agent_runtime_connections', 'agent_runtime_operator_statements']]);
      assert.equal(left.rows[0].n, 0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
