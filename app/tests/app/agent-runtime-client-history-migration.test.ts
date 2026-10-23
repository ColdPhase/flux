import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';
import { guardFixturePool } from './support/fixture-database.js';

// Migration 0118 (#480): the durable client history backfills conservatively from existing bindings and refuses
// to be reversed while a live binding may still hold a vendor login.

test('0118 backfills live bindings conservatively, ignores released ones, and reverses only without a possible login', { timeout: 120_000 }, async () => {
  const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
  const history = manifest.find(file => file.version === 118)!;
  assert.equal(history.name, '0118_agent_runtime_client_history.sql');
  const prior = manifest.filter(file => file.version < 118);
  const name = `client_history_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  const createFixture = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
  await pool.query(createFixture);
  const fixture = createDatabase(url.toString()).pool;
  const errors = guardFixturePool(fixture);
  try {
    for (const file of prior) {
      await fixture.query(await readFile(join('packages/db/migrations', file.name), 'utf8'));
      await fixture.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const owner = randomUUID();
    await fixture.query("INSERT INTO auth_users(id,name,email) VALUES($1,'History owner',$2)", [owner, `${owner}@example.test`]);
    const slots = ['runtime-1', 'runtime-2', 'runtime-3', 'runtime-4'];
    for (const slot of slots) await fixture.query("INSERT INTO agent_runtime_slots(slot,state) VALUES($1,'held')", [slot]);
    // Four bindings: signed in (live), confirmed sign-out (live), a console started with no result (live), and released.
    const owners = await Promise.all(slots.map(async (_, index) => {
      const id = index === 0 ? owner : randomUUID();
      if (index) await fixture.query("INSERT INTO auth_users(id,name,email) VALUES($1,'History owner',$2)", [id, `${id}@example.test`]);
      return id;
    }));
    const [signedIn, signedOut, consoleOnly, released] = slots.map(() => randomUUID());
    const bindings = [signedIn, signedOut, consoleOnly, released];
    for (const [index, id] of bindings.entries()) {
      await fixture.query(`INSERT INTO agent_runtime_bindings(id,owner_user_id,slot,state${index === 3 ? ",release_reason,release_requested_at,released_at,release_logout_failed" : ''})
        VALUES($1,$2,$3,${index === 3 ? "'released','owner',now(),now(),false" : "'active'"})`, [id, owners[index], slots[index]]);
    }
    await fixture.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,signed_in_at) VALUES($1,$2,$3,'claude_code','signed_in',now())", [randomUUID(), owners[0], signedIn]);
    await fixture.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,signed_out_at,sign_out_failed) VALUES($1,$2,$3,'codex','signed_out',now(),false)", [randomUUID(), owners[1], signedOut]);
    await fixture.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,signed_out_at,sign_out_failed) VALUES($1,$2,$3,'claude_code','signed_out',now(),true)", [randomUUID(), owners[1], signedOut]);
    await fixture.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,signed_in_at) VALUES($1,$2,$3,'claude_code','signed_in',now())", [randomUUID(), owners[3], released]);
    // A label the old CHECK allowed (bounded, contains a star, no whitespace) but the reducer never writes.
    await fixture.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,account_label) VALUES($1,$2,$3,'codex','signed_out','a*b')", [randomUUID(), owners[0], signedIn]);
    await fixture.query("INSERT INTO agent_runtime_connections(id,owner_user_id,binding_id,client,state,account_label) VALUES($1,$2,$3,'codex','signed_out','b***@example.org')", [randomUUID(), owners[2], consoleOnly]);
    const boot = randomUUID();
    await fixture.query(`INSERT INTO agent_runtime_auth_operations(binding_id,client,owner_user_id,operation_id,revision,boot_id,actor_digest,kind,phase,claimed_at,lease_ends_at,hard_ends_at,settled_at)
      VALUES($1,'codex',$2,$3,1,$4,$5,'console','settled',clock_timestamp(),clock_timestamp()+interval '1 minute',clock_timestamp()+interval '2 minutes',clock_timestamp())`,
      [consoleOnly, owners[2], randomUUID(), boot, 'a'.repeat(64)]);

    await fixture.query(await readFile(join('packages/db/migrations', history.name), 'utf8'));
    const rows = (await fixture.query('SELECT binding_id, client, login_possible FROM agent_runtime_client_history ORDER BY binding_id, client')).rows;
    const byKey = new Map(rows.map(row => [`${row.binding_id}:${row.client}`, row.login_possible]));
    assert.equal(byKey.get(`${signedIn}:claude_code`), true, 'a signed-in connection: a login may exist');
    assert.equal(byKey.get(`${signedOut}:codex`), false, 'a confirmed sign-out (failed = false) is the only thing that clears');
    assert.equal(byKey.get(`${signedOut}:claude_code`), true, 'a failed sign-out keeps it');
    assert.equal(byKey.get(`${consoleOnly}:codex`), true, 'a claimed console with no connection row counts as a started login');
    assert.ok(![...byKey.keys()].some(key => key.startsWith(released)), 'a released binding needs no history');
    assert.equal(byKey.get(`${signedIn}:codex`), true, 'a connection row with no confirmed sign-out is a possible login');
    assert.equal(rows.length, 5);

    const labels = (await fixture.query("SELECT binding_id, account_label FROM agent_runtime_connections WHERE binding_id = ANY($1) AND client = 'codex'", [[signedIn, consoleOnly]])).rows;
    assert.equal(labels.find(row => row.binding_id === signedIn)?.account_label, null, 'a label of an unexpected shape is dropped');
    assert.equal(labels.find(row => row.binding_id === consoleOnly)?.account_label, 'b***@example.org', 'a conforming label is kept');
    await assert.rejects(fixture.query("UPDATE agent_runtime_connections SET account_label = 'a*b' WHERE binding_id = $1 AND client = 'codex'", [consoleOnly]), /account_label_check/);

    const down = await readFile('packages/db/migrations/reverse/0118_agent_runtime_client_history.down.sql', 'utf8');
    await assert.rejects(fixture.query(down), /0118 reversal refused/);
    await fixture.query("UPDATE agent_runtime_client_history SET login_possible = false");
    await fixture.query(down);
    assert.equal((await fixture.query("SELECT to_regclass('agent_runtime_client_history') AS t")).rows[0].t, null);
  } finally {
    errors.cleanup(); await fixture.end();
    const dropFixture = { text: `DROP DATABASE "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await pool.query(dropFixture);
  }
  errors.assertNoEarlyErrors();
});
