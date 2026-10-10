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

test('0046 and 0047 arrive late on a database already at the current latest and on a fresh one, with the exact ledger either way', async () => {
  const client = await pool.connect(); const namespace = `live_late_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(`SET LOCAL search_path TO "${namespace}",public`);
    const dir = 'packages/db/migrations'; const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
    const live = manifest.filter((file) => file.version === 46 || file.version === 47);
    assert.deepEqual(live.map((file) => file.name), ['0046_live_editing.sql', '0047_live_maps.sql']);
    // An upgraded installation recorded everything else (including 0048..latest) before these files existed.
    let applied: number[] = [];
    const apply = async (file: (typeof manifest)[number]) => {
      await client.query(await readFile(join(dir, file.name), 'utf8'));
      assertMigrationSqlLedgerChange(applied, await readAppliedMigrationVersions(client), file);
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
      const next = await readAppliedMigrationVersions(client); assertMigrationStepLedger(applied, next, file); applied = next;
    };
    for (const file of manifest.filter((file) => file.version !== 46 && file.version !== 47)) await apply(file);
    assert.ok(applied.includes(FLUX_SCHEMA_VERSION) && !applied.includes(46));
    assert.throws(() => assertExactMigrationLedger(manifest, applied), /0046_live_editing\.sql/, 'the migrator must apply the older numbers');
    // The migrator loop applies every missing file, whatever its number.
    for (const file of manifest) if (!applied.includes(file.version)) await apply(file);
    assertExactMigrationLedger(manifest, applied);
    for (const table of ['doc_live_heads', 'doc_live_updates', 'live_editing_intents', 'map_live_heads', 'map_live_journal'])
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} starts empty`);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('0084 keeps every existing room as a complete snapshot, logs ledgers from then on and reverses only before the log is used', async () => {
  const client = await pool.connect(); const namespace = `live_log_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID(); const doc = randomUUID(); const generation = randomUUID();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(`SET LOCAL search_path TO "${namespace}",public`);
    const dir = 'packages/db/migrations'; const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
    const migration = manifest.find((file) => file.version === 84)!; assert.equal(migration.name, '0084_live_update_log.sql');
    for (const file of manifest.filter((file) => file.version < 84)) {
      await client.query(await readFile(join(dir, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Writer',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO project_materials (id,workspace_id,project_id,created_by,kind) VALUES ($1,$2,$3,$4,'doc')", [doc, workspace, project, owner]);
    await client.query(`INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_id,state,reason)
      VALUES ($1,$2,$3,1,'Saved text','Saved',$4,'published','First')`, [workspace, project, doc, owner]);
    // A room from before 0084: its whole codec state (with receipts and a journal) is current at sequence 2.
    const state = { kind: 'wiki', sequence: 2, receipts: { r: {} }, journal: [{ sequence: 1 }, { sequence: 2 }] };
    await client.query(`INSERT INTO doc_live_heads (doc_id,workspace_id,project_id,generation,sequence,body,hash,saved_version,codec_state)
      VALUES ($1,$2,$3,$4,2,'Saved and typed',$5,1,$6)`, [doc, workspace, project, generation, 'a'.repeat(64), JSON.stringify(state)]);
    await client.query(`INSERT INTO doc_live_updates (doc_id,generation,sequence,actor_id,command_id,fingerprint,bytes)
      VALUES ($1,$2,1,$3,$4,$5,'YQ=='),($1,$2,2,$3,$6,$5,'Yg==')`, [doc, generation, owner, randomUUID(), 'c'.repeat(64), randomUUID()]);
    const before = await readAppliedMigrationVersions(client);
    const sql = await readFile(join(dir, migration.name), 'utf8'); await client.query(sql);
    assertMigrationSqlLedgerChange(before, await readAppliedMigrationVersions(client), migration);
    await client.query('INSERT INTO flux_schema_version(version) VALUES (84) ON CONFLICT DO NOTHING');
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(client));
    const head = (await client.query('SELECT sequence,snapshot_sequence,revision,codec_state FROM doc_live_heads WHERE doc_id=$1', [doc])).rows[0];
    assert.deepEqual([Number(head.sequence), Number(head.snapshot_sequence), Number(head.revision)], [2, 2, 0], 'An existing room is its own complete snapshot');
    assert.deepEqual(head.codec_state, state, 'No stored state is rewritten');
    assert.deepEqual((await client.query('SELECT ledger FROM doc_live_updates WHERE doc_id=$1 ORDER BY sequence', [doc])).rows.map((row) => row.ledger), [null, null]);
    const refused = async (statement: string, values: unknown[]) => {
      await client.query('SAVEPOINT refused');
      try { await (values.length ? client.query(statement, values) : client.query(statement)); } catch (error) { await client.query('ROLLBACK TO SAVEPOINT refused'); return error as { constraint?: string; message?: string }; }
      throw new Error(`Unexpected acceptance: ${statement}`);
    };
    assert.equal((await refused('UPDATE doc_live_heads SET snapshot_sequence=3 WHERE doc_id=$1', [doc])).constraint, 'doc_live_head_snapshot');
    assert.equal((await refused(`INSERT INTO doc_live_updates (doc_id,generation,sequence,actor_id,command_id,fingerprint,bytes,ledger)
      VALUES ($1,$2,9,$3,$4,$5,'YQ==','[]')`, [doc, generation, owner, randomUUID(), 'c'.repeat(64)])).constraint, 'doc_live_update_ledger');
    const rerun = (await client.query('SELECT * FROM doc_live_heads')).rows; await client.query(sql);
    assert.deepEqual((await client.query('SELECT * FROM doc_live_heads')).rows, rerun, 'Rerunning 0084 changes nothing');
    const reverse = await readFile(join(dir, 'reverse', '0084_live_update_log.down.sql'), 'utf8');
    // A logged update after the snapshot: the room's state now depends on the log.
    await client.query(`INSERT INTO doc_live_updates (doc_id,generation,sequence,actor_id,command_id,fingerprint,bytes,ledger)
      VALUES ($1,$2,3,$3,$4,$5,'Yw==','{"nodes":[],"deleted":[],"splits":[]}')`, [doc, generation, owner, randomUUID(), 'c'.repeat(64)]);
    await client.query('UPDATE doc_live_heads SET sequence=3,revision=1 WHERE doc_id=$1', [doc]);
    assert.match((await refused(reverse, [])).message ?? '', /0084 reversal refused/);
    await client.query('UPDATE doc_live_heads SET snapshot_sequence=3 WHERE doc_id=$1', [doc]);
    await client.query(reverse);
    assert.equal((await client.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('doc_live_heads','doc_live_archives','doc_live_updates') AND column_name IN ('snapshot_sequence','revision','ledger')", [namespace])).rows[0].n, 0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
