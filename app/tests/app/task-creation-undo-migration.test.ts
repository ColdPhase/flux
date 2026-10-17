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

// #238 AC-U5: 0048 (lifecycle, baseline, use and reversion facts) and 0060 (the `work.creation.revert` grant) on an
// existing database whose sparse ledger already has 0049-0054, on a fresh database in file order, and the guarded
// pre-use reversal of both back to the exact prior ledger and schema.
const directory = 'packages/db/migrations';
const newColumns = ['creation_origin', 'creation_baseline', 'creation_baseline_version', 'creation_proposal_id', 'first_persisted_use_at',
  'creation_reverted_at', 'creation_reverted_by_kind', 'creation_reverted_by_id', 'creation_reversion_notice_id'];
const listed = (definition: string) => [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort();

test('an existing database applies the lower missing 0048 and then 0060, keeps old history unknown, and reverses only before use', { timeout: 120_000 }, async () => {
  const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
  const plan = await readTaskCreationReversalPlan(directory, FLUX_SCHEMA_VERSION);
  assert.deepEqual(plan.downs.map((down) => down.version), [60, 48]);
  assert.ok(plan.prior.some((file) => file.version === 54) && !plan.prior.some((file) => file.version === 48 || file.version === 60));
  assert.deepEqual(plan.prior.map((file) => file.version), manifest.map((file) => file.version).filter((version) => version !== 48 && version !== 60));
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
    // A grant of an operation 0050 added: the later 0060 must keep it valid (order independence).
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

    // The migrator's own loop: the ledger knows 0054 and applies the lower missing 0048, then 0060, each checked.
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

    assert.deepEqual(await upgrade(), [48, 60], 'only the two missing #238 files apply, lower one first');
    assert.deepEqual(await old(), original, 'every old task, notice, grant and search row is unchanged');
    const unknown = (await db.query(`SELECT ${newColumns.join(',')} FROM project_work_items WHERE id=$1`, [work])).rows[0];
    assert.ok(Object.values(unknown).every((value) => value === null), 'old history stays unknown: no inferred origin, baseline or use');
    await assert.rejects(db.query('UPDATE project_work_items SET creation_proposal_id=$1 WHERE id=$2', [randomUUID(), work]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
    const operations = listed((await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='agent_standing_grants'::regclass AND conname='agent_standing_grants_operation_check'`)).rows[0].definition);
    assert.deepEqual(operations, [...AGENT_OPERATIONS].sort(), 'after 0054, 0060 leaves exactly the contract list');
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
    assert.deepEqual(await upgrade(), [48, 60]);
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
    await assert.rejects(reverse(), /0060 reversal refused/); assert.deepEqual(await shape(), before);
    await db.query('DELETE FROM agent_standing_grants WHERE id=$1', [revertGrant]);
    // Derived from this image, never a fixed number: a fixed one becomes a real migration file and collides with it.
    const later = FLUX_SCHEMA_VERSION + 1;
    await db.query('INSERT INTO flux_schema_version(version) VALUES($1)', [later]);
    before = await shape();
    await assert.rejects(reverse(), new RegExp(`versions without files.*${later}`)); assert.deepEqual(await shape(), before);
    await db.query('DELETE FROM flux_schema_version WHERE version=$1', [later]);

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

test('a fresh database in file order ends with the contract operation list only because 0060 follows the 0054 rewrite', async () => {
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
    // Negative control: without 0060 the list is the one 0054 wrote, so 0048 alone could never carry the operation.
    // 0107 (decline) is dropped too, so the list is exactly the one 0054 wrote.
    const without = await listAfter(manifest.filter((file) => file.version !== 60 && file.version !== 107));
    assert.ok(!without.includes('work.creation.revert'));
    assert.deepEqual(without, [...AGENT_OPERATIONS].filter((operation) => operation !== 'work.creation.revert' && operation !== 'cowork.unit.decline').sort());
    // 0060 and 0107 each extend the live list in place, so dropping either one removes only its own operation.
    assert.deepEqual(await listAfter(manifest.filter((file) => file.version !== 60)),
      [...AGENT_OPERATIONS].filter((operation) => operation !== 'work.creation.revert').sort());
    assert.deepEqual(await listAfter(manifest.filter((file) => file.version !== 107)),
      [...AGENT_OPERATIONS].filter((operation) => operation !== 'cowork.unit.decline').sort());
  } finally { client.release(); }
});

test('schema 106 upgrades to 107 adding only the decline operation and a nullable marker; 0107 and 0060 are idempotent and its reversal is guarded', async () => {
  const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
  const sql = async (version: number) => readFile(join(directory, manifest.find((file) => file.version === version)!.name), 'utf8');
  const client = await pool.connect();
  const schema = `flux153_decline_${randomUUID().replaceAll('-', '')}`;
  const [owner, workspace, project, agent, connection, task, unit] = Array.from({ length: 7 }, () => randomUUID());
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    for (const file of manifest.filter((file) => file.version < 107)) await client.query(await sql(file.version));
    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Decline owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Decline space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Decline project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO agents (id,workspace_id,name,owner_user_id,created_by) VALUES ($1,$2,'Decline agent',$3,$3)", [agent, workspace, owner]);
    await client.query('INSERT INTO agent_connections (id,workspace_id,owner_user_id,agent_id,scopes) VALUES ($1,$2,$3,$4,$5)',
      [connection, workspace, owner, agent, ['flux.context.read', 'flux.action.execute']]);
    await client.query('INSERT INTO agent_connection_projects (workspace_id,connection_id,project_id) VALUES ($1,$2,$3)', [workspace, connection, project]);
    await client.query("INSERT INTO project_work_items (id,workspace_id,project_id,title,created_by_kind,created_by_id) VALUES ($1,$2,$3,'Decline task','human',$4)",
      [task, workspace, project, owner]);
    await client.query(`INSERT INTO cowork_units (id,workspace_id,project_id,work_id,lineage_work_id,run_id,unit_key,role,assignment_connection_id,state)
      VALUES ($1,$2,$3,$4,$4,$5,'pending-unit','execute',$6,'pending')`, [unit, workspace, project, task, randomUUID(), connection]);
    const grant = (operation: string) => client.query(`INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,
      client_command_id,request_fingerprint,operation,peer_request_class,maximum_uses,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'execute',3,now()+interval '1 hour')`, [randomUUID(), workspace, project, connection, owner, randomUUID(), 'a'.repeat(64), operation]);
    const refused = async (statement: () => Promise<unknown>) => {
      await client.query('SAVEPOINT refused');
      try { await statement(); } catch (error) { await client.query('ROLLBACK TO SAVEPOINT refused'); return error as { code?: string }; }
      throw new Error('The statement was accepted');
    };
    const definition = async () => (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=$1::regclass AND conname='agent_standing_grants_operation_check'`, [`${schema}.agent_standing_grants`])).rows[0].definition as string;
    const grants = async () => (await client.query('SELECT * FROM agent_standing_grants ORDER BY id')).rows;
    const marker = async () => (await client.query(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='cowork_units' AND column_name='transferred_from_connection_id'`, [schema])).rows;
    const without = AGENT_OPERATIONS.filter((operation) => operation !== 'cowork.unit.decline');
    for (const operation of without) await grant(operation);

    // Schema 106: the list lacks decline, which is refused; there is no marker column.
    assert.deepEqual(listed(await definition()), [...without].sort());
    assert.equal((await refused(() => grant('cowork.unit.decline'))).code, '23514');
    assert.deepEqual(await marker(), []);
    const before = await grants();
    const unitBefore = (await client.query('SELECT * FROM cowork_units WHERE id=$1', [unit])).rows[0];

    // 0107: every grant row and the unit are unchanged, the list is the contract list and the marker starts empty.
    await client.query(await sql(107));
    assert.deepEqual(await grants(), before);
    assert.deepEqual((await client.query('SELECT * FROM cowork_units WHERE id=$1', [unit])).rows[0], { ...unitBefore, transferred_from_connection_id: null });
    assert.deepEqual(await marker(), [{ data_type: 'uuid', is_nullable: 'YES' }]);
    const head = await definition();
    assert.deepEqual(listed(head), [...AGENT_OPERATIONS].sort());
    // Idempotent, and 0060 run after 0107 (a reserved lower number filled late) keeps decline.
    await client.query(await sql(107));
    await client.query(await sql(60));
    assert.equal(await definition(), head);
    await grant('cowork.unit.decline');

    // The reversal refuses once a decline receipt exists (deleting its grant would cascade to it) and changes nothing.
    const down = await readFile(join(directory, 'reverse/0107_cowork_unit_decline.down.sql'), 'utf8');
    const receipt = randomUUID();
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`INSERT INTO agent_command_receipts (connection_id,client_command_id,runtime_session_id,grant_id,grant_generation,binding_id,
      binding_generation,fingerprint,operation,project_id,value,postconditions)
      VALUES ($1,$2,$3,$4,1,$5,1,$6,'cowork.unit.decline',$7,'{}','[]')`, [connection, receipt, randomUUID(), randomUUID(), randomUUID(), 'c'.repeat(64), project]);
    await client.query('SET LOCAL session_replication_role = origin');
    const rows = await grants();
    assert.equal((await refused(() => client.query(down))).code, '23001', 'restrict_violation');
    assert.equal(await definition(), head); assert.deepEqual(await grants(), rows); assert.equal((await marker()).length, 1);
    await client.query('DELETE FROM agent_command_receipts WHERE client_command_id=$1', [receipt]);

    // Without a receipt it restores exactly schema 106 (the unused decline grant goes), and 0107 applies again.
    await client.query(down);
    assert.deepEqual(listed(await definition()), [...without].sort());
    assert.deepEqual(await marker(), []);
    assert.deepEqual(await grants(), before);
    await client.query(await sql(107));
    assert.equal(await definition(), head);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
