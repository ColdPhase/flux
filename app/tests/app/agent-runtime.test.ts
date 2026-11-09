import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_PATH } from '@flux/contracts';
import { agentRuntimeUseCases, reconcileAgentRuntime, type AgentRuntimeConfig, type RuntimeManagerPort } from '@flux/core';
import { agentRuntimeOperations, agentRuntimeStore, workspaceRepository } from '@flux/db';
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
      pool: 'off', binding: null, lastRelease: null, connections: { claude_code: null, codex: null } });
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
    agent_runtime_slots: ['slot:text', 'state:text', 'boot_id:uuid', 'out_of_pool_reason:text', 'reported_at:timestamp with time zone', 'updated_at:timestamp with time zone', 'capacity:smallint'],
    agent_runtime_bindings: ['id:uuid', 'owner_user_id:text', 'slot:text', 'state:text', 'created_at:timestamp with time zone', 'last_used_at:timestamp with time zone',
      'release_reason:text', 'release_requested_at:timestamp with time zone', 'released_at:timestamp with time zone', 'release_logout_failed:boolean'],
    agent_runtime_connections: ['id:uuid', 'owner_user_id:text', 'binding_id:uuid', 'transport:text', 'client:text', 'state:text', 'sign_in_method:text', 'auth_method:text',
      'plan_label:text', 'account_label:text', 'signed_in_at:timestamp with time zone', 'created_at:timestamp with time zone', 'revoked_at:timestamp with time zone',
      // 0096 (T4): a keyed HMAC of the account (exactly 64 hex digits by CHECK, too short for any vendor
      // token), the previous masked label for the account-change notice, and the last sign-out.
      'account_fingerprint:text', 'previous_account_label:text', 'account_changed_at:timestamp with time zone', 'signed_out_at:timestamp with time zone',
      'sign_out_failed:boolean',
      // 0003 (#854): the provider's remaining usage as the last run saw it: a share 0–100, a window name, a time, one boolean.
      'usage_left_percent:smallint', 'usage_window:text', 'usage_resets_at:timestamp with time zone', 'usage_limit_reached:boolean',
      'usage_read_at:timestamp with time zone'],
    agent_runtime_operator_statements: ['statement:text', 'agreed_on:date', 'recorded_at:timestamp with time zone'],
    // 0097: bounded operation identity/time/phase and digests; no raw ticket, session token or output.
    agent_runtime_auth_operations: ['binding_id:uuid', 'client:text', 'owner_user_id:text', 'operation_id:uuid', 'revision:integer',
      'boot_id:uuid', 'actor_digest:text', 'kind:text', 'phase:text', 'claimed_at:timestamp with time zone',
      'lease_ends_at:timestamp with time zone', 'hard_ends_at:timestamp with time zone', 'settled_at:timestamp with time zone'],
    agent_runtime_console_nonces: ['nonce_digest:text', 'owner_user_id:text', 'actor_digest:text', 'operation_id:uuid',
      'expires_at:timestamp with time zone', 'consumed_at:timestamp with time zone'],
    agent_runtime_auth_admission: ['singleton:boolean', 'blocked:boolean', 'purge_id:uuid', 'changed_at:timestamp with time zone'],
    // 0118 (#480): per binding and client, whether a vendor login may exist; timestamps and one boolean.
    agent_runtime_client_history: ['binding_id:uuid', 'client:text', 'first_login_at:timestamp with time zone', 'login_possible:boolean', 'changed_at:timestamp with time zone'],
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
      // 0118: the label has exactly the shape the slot's reducer can send, not merely "bounded and contains a star".
      for (const label of ['a*b', '***', 'a***@', 'ab***@example.org', 'a***@exa mple.org', 'a***@example.org\n', `a***@${'x'.repeat(71)}`]) {
        await assert.rejects(connection(label), /agent_runtime_connections_account_label_check/, JSON.stringify(label));
      }
    } finally {
      await pool.query('DELETE FROM agent_runtime_bindings WHERE slot = $1', [slot]);
      await pool.query('DELETE FROM agent_runtime_slots WHERE slot = $1', [slot]);
    }
  });
});

describe('the PostgreSQL store under the owner use cases', () => {
  const config: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: null, idleDays: null, manager: { url: 'http://unused:1', secret: 'x'.repeat(32) } };
  const slots = [`runtime-${800 + Math.floor(Math.random() * 90)}`];
  const dirs = new Map<string, string[]>(slots.map((slot) => [slot, []]));
  const boots = new Map<string, string>(slots.map((slot) => [slot, randomUUID()]));
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: slots.map((slot) => ({ slot, reachable: true as const, bootId: boots.get(slot)!, bindings: [...dirs.get(slot)!], other: 0, capacity: 2, running: [] })) }; },
    async bind(slot, id) { dirs.get(slot)!.push(id); return { ok: true, value: undefined }; },
    async release(slot, id) { dirs.set(slot, dirs.get(slot)!.filter((dir) => dir !== id)); return { ok: true, value: { deleted: true, logoutFailed: true, notInstalled: [] } }; },
    async status(slot) { return { ok: true, value: { signedIn: false, facts: null, bootId: boots.get(slot)! } }; },
    async logout(slot) { return { ok: true, value: { logout: 'ok', bootId: boots.get(slot)! } }; },
  };
  const store = agentRuntimeStore(db);

  test('many owners at once each get a place in the one runtime, and each leaves alone (#860)', async () => {
    try {
      await reconcileAgentRuntime({ config, store, manager });
      const runtime = agentRuntimeUseCases(config, store, manager);
      const [ada, jonas, mia] = await Promise.all([insertedHuman('runtime-ada'), insertedHuman('runtime-jonas'), insertedHuman('runtime-mia')]);
      // Only our runtime may be bindable in this shared database.
      const others = await pool.query(`SELECT count(*)::int AS n FROM agent_runtime_slots WHERE state = 'ready' AND slot <> ALL($1)`, [slots]);
      assert.equal(others.rows[0].n, 0);
      const outcomes = await Promise.allSettled([runtime.bind(ada.id), runtime.bind(jonas.id), runtime.bind(mia.id)]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled', 'fulfilled']);
      const bound = await pool.query(`SELECT slot, owner_user_id FROM agent_runtime_bindings WHERE slot = ANY($1) AND state = 'active' ORDER BY slot`, [slots]);
      assert.equal(bound.rows.length, 3, 'three owners in one runtime');
      assert.equal(new Set(bound.rows.map((row) => row.slot)).size, 1);
      const capacity = await pool.query(`SELECT capacity FROM agent_runtime_slots WHERE slot = ANY($1)`, [slots]);
      assert.equal(capacity.rows[0].capacity, 2);
      // Release with a failed sign-out: the owner is told.
      await runtime.remove(ada.id);
      await reconcileAgentRuntime({ config, store, manager });
      const status = await runtime.status(ada.id);
      assert.equal(status.binding, null);
      assert.deepEqual([status.lastRelease?.reason, status.lastRelease?.signOutFailed], ['owner', true]);
      // The operator's view and release by a person's e-mail.
      const emails = await pool.query<{ id: string; email: string }>('SELECT id, email FROM auth_users WHERE id = ANY($1)', [[jonas.id, mia.id]]);
      const listed = (await agentRuntimeOperations(db).list()).filter((row) => slots.includes(row.slot));
      assert.deepEqual(listed.map((row) => row.email).sort(), emails.rows.map((row) => row.email).sort());
      assert.equal(listed[0]!.capacity, 2);
      assert.ok(await agentRuntimeOperations(db).release(emails.rows.find((row) => row.id === jonas.id)!.email));
      assert.equal(await agentRuntimeOperations(db).release('nobody@example.test'), null);
      await reconcileAgentRuntime({ config, store, manager });
      assert.equal((await runtime.status(jonas.id)).lastRelease?.reason, 'operator');
      assert.equal((await runtime.status(mia.id)).binding?.state, 'active', 'and the other stays');
    } finally {
      await pool.query('DELETE FROM agent_runtime_bindings WHERE slot = ANY($1)', [slots]);
      await pool.query('DELETE FROM agent_runtime_slots WHERE slot = ANY($1)', [slots]);
    }
  });
});

describe('the idle policy and a guest (#1090)', () => {
  const config: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: null, idleDays: 30, manager: { url: 'http://unused:1', secret: 'x'.repeat(32) } };
  const slot = `runtime-${700 + Math.floor(Math.random() * 90)}`;
  const dirs: string[] = [];
  const boot = randomUUID();
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: [{ slot, reachable: true as const, bootId: boot, bindings: [...dirs], other: 0, capacity: 2, running: [] }] }; },
    async bind(_slot, id) { dirs.push(id); return { ok: true, value: undefined }; },
    async release(_slot, id) { dirs.splice(dirs.indexOf(id), 1); return { ok: true, value: { deleted: true, logoutFailed: false, notInstalled: [] } }; },
    async status() { return { ok: true, value: { signedIn: false, facts: null, bootId: boot } }; },
    async logout() { return { ok: true, value: { logout: 'ok', bootId: boot } }; },
  };
  const store = agentRuntimeStore(db);

  test('a guest\'s unused place is kept, and the member\'s is released, after the idle days', async () => {
    const company = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
    const [guest, member] = await Promise.all([insertedHuman('runtime-idle-guest'), insertedHuman('runtime-idle-member')]);
    try {
      await pool.query('INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, $3, $2), ($1, $4, $5, $4)', [company, guest.id, 'guest', member.id, 'member']);
      await reconcileAgentRuntime({ config, store, manager });
      const runtime = agentRuntimeUseCases(config, store, manager);
      await runtime.bind(guest.id); await runtime.bind(member.id);
      await pool.query(`UPDATE agent_runtime_bindings SET last_used_at = now() - interval '40 days', created_at = now() - interval '41 days' WHERE owner_user_id = ANY($1)`, [[guest.id, member.id]]);
      await pool.query(`UPDATE workspace_members SET updated_at = now() - interval '50 days' WHERE workspace_id = $1 AND user_id = ANY($2)`, [company, [guest.id, member.id]]);
      const report = await reconcileAgentRuntime({ config, store, manager });
      assert.equal(report.idle, 1, 'one place is released as idle');
      const states = await pool.query<{ owner_user_id: string; state: string }>('SELECT owner_user_id, state FROM agent_runtime_bindings WHERE owner_user_id = ANY($1)', [[guest.id, member.id]]);
      const stateOf = (id: string) => states.rows.find((row) => row.owner_user_id === id)?.state;
      assert.equal(stateOf(guest.id), 'active', 'the guest\'s place is kept: it is not signed out');
      assert.notEqual(stateOf(member.id), 'active', 'the member\'s is released');
      // As a member again, the place is the same one and is subject to the policy again, but its idle window starts at the return (#1095):
      // the days spent as a guest are not idle days, so it is not released at once, and the owner is shown the day it will be.
      const idle = async () => (await store.idleBindings(new Date(Date.now() - 30 * 86_400_000))).some((binding) => binding.ownerUserId === guest.id);
      await workspaceRepository(db).setRole(company, guest.id, 'member');
      assert.equal(await idle(), false, 'a guest back as a member keeps the whole window');
      assert.equal((await reconcileAgentRuntime({ config, store, manager })).idle, 0, 'and the sweep releases nothing');
      assert.equal((await pool.query<{ state: string }>('SELECT state FROM agent_runtime_bindings WHERE owner_user_id = $1', [guest.id])).rows[0]?.state, 'active');
      const shown = Date.parse((await runtime.status(guest.id)).binding!.idleReleaseAt!);
      assert.ok(shown > Date.now() + 29 * 86_400_000 && shown < Date.now() + 31 * 86_400_000, 'the date shown is 30 days after the return');
      // The window is the later of the last use and the return: a use after the return moves it, and a long time after the return releases.
      await pool.query(`UPDATE workspace_members SET updated_at = now() - interval '31 days' WHERE workspace_id = $1 AND user_id = $2`, [company, guest.id]);
      assert.equal(await idle(), true, 'thirty days after the return the place is idle again');
      await pool.query(`UPDATE agent_runtime_bindings SET last_used_at = now() - interval '1 day' WHERE owner_user_id = $1`, [guest.id]);
      assert.equal(await idle(), false, 'a later use starts the window again');
    } finally {
      await pool.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)', [company, [guest.id, member.id]]);
      await pool.query('DELETE FROM agent_runtime_bindings WHERE slot = $1', [slot]);
      await pool.query('DELETE FROM agent_runtime_slots WHERE slot = $1', [slot]);
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
        await tx.execute(sql`INSERT INTO agent_runtime_slots(slot, state) VALUES ('runtime-999', 'ready')`);
        await tx.execute(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state)
          VALUES (${randomUUID()}, ${owner.id}, 'runtime-999', 'active')`);
        await tx.execute(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state, release_reason, release_requested_at, released_at, release_logout_failed)
          VALUES (${randomUUID()}, ${historicalOwner.id}, 'runtime-999', 'released', 'owner', now() - interval '1 day', now() - interval '1 day', true)`);
        const purgeId = await agentRuntimeOperations(tx).beginPurge();
        await agentRuntimeOperations(tx).forgetAll(purgeId, confirmed);
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
