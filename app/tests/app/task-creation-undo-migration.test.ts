import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_OPERATIONS } from '@flux/contracts';
import { assertExactMigrationLedger, assertKnownMigrationVersions, assertMigrationSqlLedgerChange, assertMigrationStepLedger, createDatabase,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest, readTaskCreationReversalPlan, reverseUnusedTaskCreation } from '@flux/db';
import { pool } from './support/db.js';
import { guardFixturePool } from './support/fixture-database.js';

// #238 AC-U5: 0048 (lifecycle, baseline, use and reversion facts) and 0057 (the `work.creation.revert` grant) on an
// existing database whose sparse ledger already has 0049-0054, on a fresh database in file order, and the guarded
// pre-use reversal of both back to the exact prior ledger and schema.
const directory = 'packages/db/migrations';
const newColumns = ['creation_origin', 'creation_baseline', 'creation_baseline_version', 'creation_proposal_id', 'first_persisted_use_at',
  'creation_reverted_at', 'creation_reverted_by_kind', 'creation_reverted_by_id', 'creation_reversion_notice_id'];
const listed = (definition: string) => [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort();

test('an existing database applies the lower missing 0048 and then 0057, keeps old history unknown, and reverses only before use', { timeout: 120_000 }, async () => {
  const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
  const plan = await readTaskCreationReversalPlan(directory, FLUX_SCHEMA_VERSION);
  assert.deepEqual(plan.downs.map((down) => down.version), [57, 48]);
  assert.ok(plan.prior.some((file) => file.version === 54) && !plan.prior.some((file) => file.version === 48 || file.version === 57));
  assert.deepEqual(plan.prior.map((file) => file.version), manifest.map((file) => file.version).filter((version) => version !== 48 && version !== 57));
  const name = `flux_undo_history_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  let history: ReturnType<typeof createDatabase>['pool'] | undefined;
  let guard: ReturnType<typeof guardFixturePool> | undefined;
  const [user, workspace, project, work, notice, agent, connection, unitGrant] = Array.from({ length: 8 }, () => randomUUID());
  try {
    const createFixture = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
    await admin.query(createFixture);
    history = createDatabase(url.toString()).pool;
    guard = guardFixturePool(history);
    const db = history;
    for (const file of plan.prior) {
      await db.query(await readFile(join(directory, file.name), 'utf8'));
      await db.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    assertExactMigrationLedger(plan.prior, await readAppliedMigrationVersions(db));
    await db.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Historical author',$2)", [user, `${user}@example.test`]);
    await db.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Original space',$2)", [workspace, user]);
    await db.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Original project',$3)", [project, workspace, user]);
    await db.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,outcome,status,created_by_kind,created_by_id)
      VALUES($1,$2,$3,'Original retained task','Original outcome','open','human',$4)`, [work, workspace, project, user]);
    await db.query(`INSERT INTO project_task_notices(id,workspace_id,project_id,work_id,kind,created_by_kind,created_by_id,sources,created_at)
      VALUES($1,$2,$3,$4,'task.created','human',$5,'[]',clock_timestamp())`, [notice, workspace, project, work, user]);
    await db.query("INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Original agent',$3,$3)", [agent, workspace, user]);
    await db.query("INSERT INTO agent_connections(id,workspace_id,owner_user_id,agent_id,scopes) VALUES($1,$2,$3,$4,ARRAY['flux.context.read'])", [connection, workspace, user, agent]);
    await db.query('INSERT INTO agent_connection_projects(workspace_id,connection_id,project_id) VALUES($1,$2,$3)', [workspace, connection, project]);
    const grant = (id: string, operation: string) => db.query(`INSERT INTO agent_standing_grants(id,workspace_id,project_id,connection_id,owner_user_id,
      client_command_id,request_fingerprint,operation,peer_request_class,maximum_uses,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'execute',1,clock_timestamp()+interval '1 hour')`, [id, workspace, project, connection, user, randomUUID(), 'a'.repeat(64), operation]);
    // A grant of an operation 0050 added: the later 0057 must keep it valid (order independence).
    await grant(unitGrant, 'cowork.unit.create');

    const old = async () => ({ work: (await db.query('SELECT to_jsonb(w) - $1::text[] AS row FROM project_work_items w ORDER BY id', [newColumns])).rows,
      notices: (await db.query('SELECT * FROM project_task_notices ORDER BY id')).rows,
      grants: (await db.query('SELECT * FROM agent_standing_grants ORDER BY id')).rows,
      search: (await db.query('SELECT * FROM search_documents ORDER BY doc_key')).rows });
    const shape = async () => ({ ledger: await readAppliedMigrationVersions(db),
      columns: (await db.query(`SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns
        WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows,
      constraints: (await db.query(`SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE connamespace='public'::regnamespace ORDER BY 1,2`)).rows,
      triggers: (await db.query(`SELECT event_object_table,trigger_name,event_manipulation,action_statement FROM information_schema.triggers
        WHERE trigger_schema='public' ORDER BY 1,2,3`)).rows,
      functions: (await db.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1")).rows });
    const original = await old();
    const prior = await shape();

    // The migrator's own loop: the ledger knows 0054 and applies the lower missing 0048, then 0057, each checked.
    const upgrade = async () => {
      const client = await db.connect();
      const appliedNow: number[] = [];
      try {
        let applied = await readAppliedMigrationVersions(client);
        assertKnownMigrationVersions(manifest, applied);
        for (const file of manifest) {
          if (applied.includes(file.version)) continue;
          await client.query('BEGIN');
          try {
            await client.query(await readFile(join(directory, file.name), 'utf8'));
            assertMigrationSqlLedgerChange(applied, await readAppliedMigrationVersions(client), file);
            await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
            const after = await readAppliedMigrationVersions(client);
            assertMigrationStepLedger(applied, after, file);
            await client.query('COMMIT');
            applied = after; appliedNow.push(file.version);
          } catch (error) { await client.query('ROLLBACK'); throw error; }
        }
        assertExactMigrationLedger(manifest, applied);
      } finally { client.release(); }
      return appliedNow;
    };
    const reverse = async () => reverseUnusedTaskCreation(await db.connect(), plan, { quiesced: true });

    assert.deepEqual(await upgrade(), [48, 57], 'only the two missing #238 files apply, lower one first');
    assert.deepEqual(await old(), original, 'every old task, notice, grant and search row is unchanged');
    const unknown = (await db.query(`SELECT ${newColumns.join(',')} FROM project_work_items WHERE id=$1`, [work])).rows[0];
    assert.ok(Object.values(unknown).every((value) => value === null), 'old history stays unknown: no inferred origin, baseline or use');
    await assert.rejects(db.query('UPDATE project_work_items SET creation_proposal_id=$1 WHERE id=$2', [randomUUID(), work]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
    const operations = listed((await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='agent_standing_grants'::regclass AND conname='agent_standing_grants_operation_check'`)).rows[0].definition);
    assert.deepEqual(operations, [...AGENT_OPERATIONS].sort(), 'after 0054, 0057 leaves exactly the contract list');
    const revertGrant = randomUUID();
    await grant(revertGrant, 'work.creation.revert');
    await db.query('DELETE FROM agent_standing_grants WHERE id=$1', [revertGrant]);
    const upgraded = await shape();

    // An active holder is refused, not waited for; nothing changes.
    const busy = await db.connect(); await busy.query('BEGIN'); await busy.query('SELECT id FROM project_work_items FOR SHARE');
    try { await assert.rejects(reverse(), (error: unknown) => error instanceof Error && 'code' in error && error.code === '55P03'); }
    finally { await busy.query('ROLLBACK'); busy.release(); }
    assert.deepEqual(await shape(), upgraded, 'refusal under an active holder keeps schema and ledger');

    // Pre-use reversal returns the exact prior schema and ledger; then it applies again.
    await reverse();
    assert.deepEqual(await shape(), prior, 'columns, constraints, triggers, functions and ledger equal the prior image');
    assert.deepEqual(await old(), original);
    assert.throws(() => assertExactMigrationLedger(manifest, prior.ledger), /0048_unused_ai_task_creation_undo\.sql/,
      'this image refuses to start on the reversed database; the matching prior image starts instead');
    assert.deepEqual(await upgrade(), [48, 57]);
    assert.deepEqual(await shape(), upgraded);

    // Any feature fact refuses the reversal and changes nothing: a first use, a revert grant, an unknown later version.
    await db.query('UPDATE project_work_items SET first_persisted_use_at=clock_timestamp() WHERE id=$1', [work]);
    let before = await shape();
    await assert.rejects(reverse(), /0048 reversal refused/); assert.deepEqual(await shape(), before);
    await assert.rejects(db.query('UPDATE project_work_items SET first_persisted_use_at=NULL WHERE id=$1', [work]), /immutable first task use/);
    // Only this disposable database is reset for the next scenario; the runner never clears a latch.
    await db.query('TRUNCATE project_work_items CASCADE');
    await grant(revertGrant, 'work.creation.revert');
    before = await shape();
    await assert.rejects(reverse(), /0057 reversal refused/); assert.deepEqual(await shape(), before);
    await db.query('DELETE FROM agent_standing_grants WHERE id=$1', [revertGrant]);
    await db.query('INSERT INTO flux_schema_version(version) VALUES(99)');
    before = await shape();
    await assert.rejects(reverse(), /versions without files.*99/); assert.deepEqual(await shape(), before);
    await db.query('DELETE FROM flux_schema_version WHERE version=99');

    // A reverted task is read only for every column 0048 knows, yet a later migration can backfill its own new column
    // (for example a task number): history stays exact without blocking a future additive migration.
    const reverted = randomUUID(), createdNotice = randomUUID(), revertedNotice = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id,creation_origin,creation_baseline,creation_baseline_version)
        VALUES($1,$2,$3,'Reverted history','agent',$4,'native_agent','{}'::jsonb,1)`, [reverted, workspace, project, agent]);
      await client.query(`INSERT INTO project_task_notices(id,workspace_id,project_id,work_id,kind,created_by_kind,created_by_id,sources,created_at)
        VALUES($1,$2,$3,$4,'task.created','agent',$5,'[]',clock_timestamp()),($6,$2,$3,$4,'task.creation_reverted','human',$7,'[]',clock_timestamp())`,
      [createdNotice, workspace, project, reverted, agent, revertedNotice, user]);
      await client.query(`UPDATE project_work_items SET creation_reverted_at=clock_timestamp(), creation_reverted_by_kind='human', creation_reverted_by_id=$2,
        creation_reversion_notice_id=$3, version=2 WHERE id=$1`, [reverted, user, revertedNotice]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    for (const change of ["title='Rewritten'", "status='done'", 'version=3', 'updated_at=clock_timestamp()', 'first_persisted_use_at=clock_timestamp()'])
      await assert.rejects(db.query(`UPDATE project_work_items SET ${change} WHERE id=$1`, [reverted]), /reverted task is read only/, change);
    await db.query('ALTER TABLE project_work_items ADD COLUMN later_number integer');
    await db.query('UPDATE project_work_items SET later_number=7 WHERE id=$1', [reverted]);
    assert.equal((await db.query('SELECT later_number FROM project_work_items WHERE id=$1', [reverted])).rows[0].later_number, 7);
    await db.query(`INSERT INTO task_creation_undo_receipts(workspace_id,project_id,actor_kind,actor_id,client_command_id,request_fingerprint,work_id,notice_id)
      VALUES($1,$2,'human',$3,$4,$5,$6,$7)`, [workspace, project, user, randomUUID(), 'b'.repeat(64), reverted, revertedNotice]);
    await assert.rejects(db.query('DELETE FROM task_creation_undo_receipts'), /immutable task creation Undo receipt/, 'receipts cannot be removed');
    await assert.rejects(db.query("UPDATE task_creation_undo_receipts SET request_fingerprint=$1", ['c'.repeat(64)]), /immutable task creation Undo receipt/);
  } finally {
    guard?.cleanup();
    await history?.end();
    const dropFixture = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await admin.query(dropFixture);
    await admin.end();
  }
  guard?.assertNoEarlyErrors();
});

test('a fresh database in file order ends with the contract operation list only because 0057 follows the 0054 rewrite', async () => {
  const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
  const client = await pool.connect();
  const listAfter = async (files: typeof manifest) => {
    const schema = `flux238_fresh_${randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
      for (const file of files) await client.query(await readFile(join(directory, file.name), 'utf8'));
      const definition = (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=$1::regclass AND conname='agent_standing_grants_operation_check'`, [`${schema}.agent_standing_grants`])).rows[0].definition as string;
      return listed(definition);
    } finally { await client.query('ROLLBACK'); }
  };
  try {
    assert.deepEqual(await listAfter(manifest), [...AGENT_OPERATIONS].sort(), 'the live list equals the contract list');
    // Negative control: without 0057 the list is the one 0054 wrote, so 0048 alone could never carry the operation.
    const without = await listAfter(manifest.filter((file) => file.version !== 57));
    assert.ok(!without.includes('work.creation.revert'));
    assert.deepEqual(without, [...AGENT_OPERATIONS].filter((operation) => operation !== 'work.creation.revert').sort());
  } finally { client.release(); }
});
