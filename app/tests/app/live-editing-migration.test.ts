import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertExactMigrationLedger, assertMigrationSqlLedgerChange, assertMigrationStepLedger,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

test('0046 preserves saved material/history/search and makes live receipts, provenance and replica ownership immutable', async () => {
  const client = await pool.connect(); const namespace = `live_upgrade_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID(); const doc = randomUUID();
  const generation = randomUUID(); const command = randomUUID(); const instance = randomUUID();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(`SET LOCAL search_path TO "${namespace}",public`);
    const dir = 'packages/db/migrations'; const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
    const current = manifest.filter((file) => file.version <= 46); const migration = current.find((file) => file.version === 46)!;
    assert.equal(migration.name, '0046_live_editing.sql');
    for (const file of current.filter((file) => file.version < 46)) {
      await client.query(await readFile(join(dir, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Writer',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO project_materials (id,workspace_id,project_id,created_by,kind) VALUES ($1,$2,$3,$4,'doc')", [doc, workspace, project, owner]);
    await client.query(`INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_id,state,reason)
      VALUES ($1,$2,$3,1,'Saved text','Immutable original',$4,'published','First')`, [workspace, project, doc, owner]);
    const saved = async () => ({ material: (await client.query('SELECT * FROM project_materials ORDER BY id')).rows,
      versions: (await client.query('SELECT * FROM project_material_versions ORDER BY material_id,version')).rows,
      search: (await client.query('SELECT * FROM search_documents ORDER BY doc_key')).rows });
    const original = await saved(); const before = await readAppliedMigrationVersions(client);
    const sql = await readFile(join(dir, migration.name), 'utf8'); await client.query(sql);
    assertMigrationSqlLedgerChange(before, await readAppliedMigrationVersions(client), migration);
    await client.query('INSERT INTO flux_schema_version(version) VALUES (46) ON CONFLICT DO NOTHING');
    const after = await readAppliedMigrationVersions(client); assertMigrationStepLedger(before, after, migration); assertExactMigrationLedger(current, after);
    assert.deepEqual(await saved(), original, 'no saved body, author, time or projection backfill');
    const tables = ['doc_live_heads', 'doc_live_archives', 'doc_live_updates', 'doc_live_replicas', 'doc_live_snapshots', 'live_editing_intents'];
    for (const table of tables) assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    const refused = async (statement: string, values: unknown[]) => {
      await client.query('SAVEPOINT refused');
      try { await client.query(statement, values); } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT refused'); return error as { code?: string; constraint?: string };
      }
      throw new Error(`Unexpected acceptance: ${statement}`);
    };
    await client.query(`INSERT INTO doc_live_heads (doc_id,workspace_id,project_id,generation,body,hash,saved_version)
      VALUES ($1,$2,$3,$4,'Immutable original',$5,1)`, [doc, workspace, project, generation, 'a'.repeat(64)]);
    await client.query(`INSERT INTO doc_live_replicas (doc_id,generation,replica_id,actor_id,instance_id,expires_at)
      VALUES ($1,$2,42,$3,$4,now()+interval '1 hour')`, [doc, generation, owner, instance]);
    await client.query(`INSERT INTO live_editing_intents (actor_id,command_id,workspace_id,kind,resource_id,generation,operation,fingerprint,byte_length,receipt)
      VALUES ($1,$2,$3,'wiki',$4,$5,'text',$6,1,'{"sequence":0}')`, [owner, command, workspace, doc, generation, 'b'.repeat(64)]);
    assert.equal((await refused('UPDATE live_editing_intents SET resource_id=$1 WHERE actor_id=$2 AND command_id=$3', [randomUUID(), owner, command])).code, '23514');
    assert.equal((await refused('DELETE FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2', [owner, command])).code, '23514');
    assert.equal((await refused('UPDATE doc_live_replicas SET instance_id=$1 WHERE doc_id=$2', [randomUUID(), doc])).code, '23514');
    assert.equal((await refused("UPDATE doc_live_replicas SET owner_kind='server',actor_id=NULL WHERE doc_id=$1", [doc])).code, '23514');
    await client.query(`INSERT INTO doc_live_replicas (doc_id,generation,replica_id,owner_kind,actor_id,instance_id,expires_at)
      VALUES ($1,$2,43,'server',NULL,$3,now())`, [doc, generation, randomUUID()]);
    assert.equal((await refused(`INSERT INTO doc_live_replicas (doc_id,generation,replica_id,owner_kind,actor_id,instance_id,expires_at)
      VALUES ($1,$2,44,'server',$3,$4,now())`, [doc, generation, owner, randomUUID()])).constraint, 'doc_live_replica_owner');
    await client.query('UPDATE doc_live_replicas SET expires_at=now()+interval \'2 hours\',connection_id=$1 WHERE doc_id=$2', [randomUUID(), doc]);
    assert.equal((await refused('UPDATE doc_live_heads SET sequence=-1 WHERE doc_id=$1', [doc])).constraint, 'doc_live_head_sequence');
    assert.equal((await refused('UPDATE doc_live_heads SET hash=$1 WHERE doc_id=$2', ['bad', doc])).constraint, 'doc_live_head_hash');
    await client.query(`INSERT INTO doc_live_updates (doc_id,generation,sequence,actor_id,command_id,fingerprint,bytes)
      VALUES ($1,$2,1,$3,$4,$5,'YQ==')`, [doc, generation, owner, randomUUID(), 'c'.repeat(64)]);
    assert.equal((await refused("UPDATE doc_live_updates SET bytes='Yg==' WHERE doc_id=$1", [doc])).code, '23514');
    await client.query(`INSERT INTO doc_live_snapshots (doc_id,version,workspace_id,project_id,generation,from_sequence,to_sequence,hash,contributors)
      VALUES ($1,1,$2,$3,$4,0,1,$5,'[]')`, [doc, workspace, project, generation, 'd'.repeat(64)]);
    assert.equal((await refused("UPDATE doc_live_snapshots SET contributors='[]' WHERE doc_id=$1", [doc])).code, '23514');
    const retained = async () => Object.fromEntries(await Promise.all(tables.map(async (table) =>
      [table, (await client.query(`SELECT * FROM ${table}`)).rows])));
    const once = await retained(); await client.query(sql);
    assert.deepEqual(await retained(), once, 'rerunning migration retains every room, lease, interval and original receipt');
    assert.deepEqual(await saved(), original); assert.deepEqual(await readAppliedMigrationVersions(client), after);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
