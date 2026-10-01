import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assertExactMigrationLedger, assertMigrationSqlLedgerChange, assertMigrationStepLedger, createDatabase,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';

// 0039 (#152): criteria, prerequisite edges and plan intent. The previous ledger upgrades in place, every existing
// task survives byte for byte with empty plan fields, and the SQL is re-runnable. Numbers: 0039 is the lowest free
// number at or above 0039 on origin/main and every pushed origin/* head on 2026-10-01 (highest present: 0038).
const migrationsDir = 'packages/db/migrations';
const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());

test('0039 upgrades the previous ledger in place: tasks are preserved exactly, plan fields describe absence, and re-running changes nothing', async () => {
  const client = await pool.connect();
  const schema = `flux152_plan_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID(); const material = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    const migration = manifest.find((file) => file.version === 39);
    assert.equal(migration?.name, '0039_native_task_plan.sql');
    assert.equal(manifest.filter((file) => file.version >= 39).length, 1, 'exactly one new migration, at 0039');
    assert.equal(FLUX_SCHEMA_VERSION, 39);
    const upToCurrent = manifest.filter((file) => file.version <= 39);
    // The migrator owns ledger rows for files that do not self-record, so replay exactly its apply loop.
    for (const file of upToCurrent.filter((file) => file.version < 39)) {
      await client.query(await readFile(join(migrationsDir, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const before = await readAppliedMigrationVersions(client);
    assert.deepEqual(before, upToCurrent.filter((file) => file.version < 39).map((file) => file.version), 'the previous ledger, with 0038 as its last file');
    assert.equal(before.at(-1), 38);
    assert.throws(() => assertExactMigrationLedger(upToCurrent, before), /0039_native_task_plan\.sql/, 'the migrator must apply 0039 before Flux starts');

    // Existing data written under the previous schema, including a human author, an owner and a finished task.
    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Plan owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Plan space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Plan project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO project_materials (id,workspace_id,project_id,created_by,client_mutation_id,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6)",
      [material, workspace, project, owner, randomUUID(), 'c'.repeat(64)]);
    await client.query("INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_id) VALUES ($1,$2,$3,1,'Old plan','Body',$4)",
      [workspace, project, material, owner]);
    const tasks: string[] = [randomUUID(), randomUUID(), randomUUID()];
    await client.query(`INSERT INTO project_work_items (id,workspace_id,project_id,title,outcome,status,created_by_kind,created_by_id,version,created_at,updated_at)
      VALUES ($1,$4,$5,'Open task','What to learn','open','human',$6,1,'2026-01-02T03:04:05Z','2026-01-02T03:04:05Z'),
             ($2,$4,$5,'Finished task','','done','human',$6,4,'2026-02-02T03:04:05Z','2026-03-02T03:04:05Z'),
             ($3,$4,$5,'Blocked task','','blocked','human',$6,2,'2026-02-03T03:04:05Z','2026-02-04T03:04:05Z')`, [tasks[0], tasks[1], tasks[2], workspace, project, owner]);
    await client.query("UPDATE project_work_items SET blocker = 'Waiting for parts' WHERE id = $1", [tasks[2]]);
    const snapshot = async () => (await client.query('SELECT * FROM project_work_items ORDER BY id')).rows as Record<string, unknown>[];
    const old = await snapshot();
    assert.equal(old.length, 3);

    // Before: the previous schema has none of it.
    // Qualified: the live application schema already has 0039 and sits behind this temporary one on the search path.
    assert.deepEqual((await client.query('SELECT to_regclass($1) AS dependencies, to_regclass($2) AS intents', [`${schema}.project_task_dependencies`, `${schema}.project_task_plan_intents`])).rows[0],
      { dependencies: null, intents: null });
    assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'project_work_items' AND column_name = 'criteria'")).rows[0].n, 0);

    // Apply exactly as tooling/migrate.ts does, including its ledger checks.
    const sql = await readFile(join(migrationsDir, migration!.name), 'utf8');
    await client.query(sql);
    const afterSql = await readAppliedMigrationVersions(client);
    assertMigrationSqlLedgerChange(before, afterSql, migration!);
    await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [migration!.version]);
    const after = await readAppliedMigrationVersions(client);
    assertMigrationStepLedger(before, after, migration!);
    assertExactMigrationLedger(upToCurrent, after);

    // After: every existing column of every task is unchanged (content, status, blocker, authors, versions, times); only criteria is new and empty.
    const upgraded = await snapshot();
    assert.deepEqual(upgraded.map(({ criteria, ...row }) => { assert.deepEqual(criteria, []); return row; }), old);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM project_task_dependencies')).rows[0].n, 0, 'no guessed edges');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM project_task_plan_intents')).rows[0].n, 0, 'no guessed intent');
    // A writer that still uses the previous column list keeps working and gets empty criteria.
    const legacy = randomUUID();
    await client.query("INSERT INTO project_work_items (id,workspace_id,project_id,title,created_by_kind,created_by_id) VALUES ($1,$2,$3,'Inserted after','human',$4)", [legacy, workspace, project, owner]);
    assert.deepEqual((await client.query('SELECT criteria FROM project_work_items WHERE id = $1', [legacy])).rows[0].criteria, []);
    // The new rules hold on upgraded rows.
    await client.query('SAVEPOINT rule');
    await assert.rejects(client.query("UPDATE project_work_items SET criteria = '[\"same\",\"same\"]' WHERE id = $1", [tasks[0]]), /project_work_criteria_bounded/);
    await client.query('ROLLBACK TO SAVEPOINT rule');
    await client.query('INSERT INTO project_task_dependencies (workspace_id,project_id,task_id,prerequisite_id) VALUES ($1,$2,$3,$4)', [workspace, project, tasks[0], tasks[1]]);
    await client.query('INSERT INTO project_task_plan_intents (workspace_id,project_id,material_id,material_version,intent_key,task_id,creation_fingerprint,task_version) VALUES ($1,$2,$3,1,$4,$5,$6,1)',
      [workspace, project, material, 'upgraded', tasks[0], 'b'.repeat(64)]);

    // Idempotent: a second application keeps every definition and row, and writes no ledger version itself.
    const definitions = async () => (await client.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('project_work_items'::regclass, 'project_task_dependencies'::regclass, 'project_task_plan_intents'::regclass) ORDER BY conname`)).rows;
    const shape = await definitions();
    assert.ok(shape.some((row) => row.conname === 'project_work_criteria_bounded') && shape.some((row) => row.conname === 'project_task_dependency_not_self'));
    await client.query(sql);
    assert.deepEqual(await definitions(), shape);
    assert.deepEqual(await readAppliedMigrationVersions(client), after);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM project_task_dependencies')).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM project_task_plan_intents')).rows[0].n, 1);
    assert.deepEqual((await snapshot()).filter((row) => tasks.includes(row.id as string)).map(({ criteria, ...row }) => { void criteria; return row; }), old);
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
});
