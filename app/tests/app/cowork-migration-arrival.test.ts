import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assertExactMigrationLedger, assertMigrationSqlLedgerChange, assertMigrationStepLedger,
  createDatabase, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest, type MigrationFile } from '@flux/db';

// Actual additive migration/history checks. These fixtures grant no agent action
// authority and do not establish current dependency eligibility or client activation.
const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());
const arrivals = [[35, 34, 33, 37], [34, 33, 37, 35], [33, 35, 34, 37]];

for (const order of arrivals) test(`co-work, runtime and genuine-actor migrations preserve history in arrival order ${order.join(',')}`, async () => {
  const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
  const client = await pool.connect();
  const name = `flux153_arrival_${randomUUID().replaceAll('-', '')}`;
  const [owner, workspace, project, agent, connection, task, conversation, message, unit, checkpoint, session, material] =
    Array.from({ length: 12 }, () => randomUUID());
  const originalAt = '2026-09-01T12:34:56.789Z';
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${name}`);
    await client.query(`SET LOCAL search_path TO ${name}, public, pg_catalog`);
    let applied: number[] = [];
    const apply = async (file: MigrationFile) => {
      await client.query(await readFile(join('packages/db/migrations', file.name), 'utf8'));
      assertMigrationSqlLedgerChange(applied, await readAppliedMigrationVersions(client), file);
      // The real migrator records non-self-recording SQL after checking its delta.
      await client.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
      const after = await readAppliedMigrationVersions(client);
      assertMigrationStepLedger(applied, after, file);
      applied = after;
    };
    for (const file of manifest.filter((file) => file.version < 33))
      await apply(file);
    await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Original owner',$2)", [owner, `${owner}@arrival.test`]);
    await client.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Original workspace',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Original project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Original agent',$3,$3)", [agent, workspace, owner]);
    await client.query(`INSERT INTO agent_connections(id,workspace_id,owner_user_id,agent_id,scopes,created_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [connection, workspace, owner, agent, ['flux.context.read'], originalAt]);
    await client.query('INSERT INTO agent_connection_projects(workspace_id,connection_id,project_id) VALUES($1,$2,$3)', [workspace, connection, project]);
    await client.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id,created_at,updated_at)
      VALUES($1,$2,$3,'Original task','human',$4,$5,$5)`, [task, workspace, project, owner, originalAt]);
    await client.query(`INSERT INTO project_materials(id,workspace_id,project_id,created_by,client_mutation_id,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,'original-source')`, [material, workspace, project, owner, randomUUID()]);
    await client.query(`INSERT INTO project_material_versions(workspace_id,project_id,material_id,version,title,body,author_id,created_at)
      VALUES($1,$2,$3,1,'Original evidence','Retain exact source bytes',$4,$5)`, [workspace, project, material, owner, originalAt]);
    await client.query(`INSERT INTO project_conversations(id,workspace_id,project_id,created_by,next_sequence,created_at)
      VALUES($1,$2,$3,$4,2,$5)`, [conversation, workspace, project, owner, originalAt]);
    await client.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,
      request_fingerprint,sequence,body,created_at,source_material_id,source_material_version)
      VALUES($1,$2,$3,$4,$5,$6,'original',1,'Original human contribution',$7,$8,1)`,
    [message, workspace, project, conversation, owner, randomUUID(), originalAt, material]);
    const history = async () => ({
      connection: (await client.query('SELECT id,workspace_id,owner_user_id,agent_id,scopes,created_at FROM agent_connections WHERE id=$1', [connection])).rows,
      task: (await client.query('SELECT id,title,status,version,created_by_kind,created_by_id,created_at,updated_at FROM project_work_items WHERE id=$1', [task])).rows,
      conversation: (await client.query('SELECT id,created_by,next_sequence,created_at FROM project_conversations WHERE id=$1', [conversation])).rows,
      message: (await client.query('SELECT id,conversation_id,author_id,sequence,body,created_at,source_material_id,source_material_version FROM project_messages WHERE id=$1', [message])).rows,
      source: (await client.query('SELECT * FROM project_material_versions WHERE material_id=$1', [material])).rows,
      search: (await client.query('SELECT * FROM search_documents WHERE doc_key=$1', [`message:${message}`])).rows,
    });
    const before = await history();
    assert.equal(before.search.length, 1);
    const coordination = async () => ({
      unit: (await client.query('SELECT * FROM cowork_units WHERE id=$1', [unit])).rows,
      checkpoint: (await client.query('SELECT * FROM cowork_checkpoints WHERE id=$1', [checkpoint])).rows,
    });
    let retained: Awaited<ReturnType<typeof coordination>> | null = null;
    for (const version of order) {
      const file = manifest.find((item) => item.version === version);
      assert.ok(file, `actual migration ${version} is shipped`);
      await apply(file);
      assert.deepEqual(await history(), before, `migration${version} must preserve original history`);
      if (version === 35) {
        await client.query('INSERT INTO cowork_connection_slots(connection_id,workspace_id) VALUES($1,$2)', [connection, workspace]);
        await client.query(`INSERT INTO cowork_units(id,workspace_id,project_id,work_id,lineage_work_id,run_id,unit_key,
          role,assignment_connection_id,state,generation,version,lease_id,lease_session_id,lease_expires_at)
          VALUES($1,$2,$3,$4,$4,$5,'original','review',$6,'claimed',1,2,$7,$8,clock_timestamp()+interval '1 hour')`,
        [unit, workspace, project, task, randomUUID(), connection, randomUUID(), session]);
        await client.query(`INSERT INTO cowork_checkpoints(id,workspace_id,project_id,unit_id,connection_id,runtime_session_id,generation,progress)
          VALUES($1,$2,$3,$4,$5,$6,1,'{"nextAction":"independent review"}')`, [checkpoint, workspace, project, unit, connection, session]);
        await client.query('UPDATE cowork_units SET checkpoint_id=$1 WHERE id=$2', [checkpoint, unit]);
        retained = await coordination();
      }
      if (retained) assert.deepEqual(await coordination(), retained, `migration${version} must retain existing claim/checkpoint`);
    }
    assert.ok(retained);
    for (const table of ['agent_oauth_bindings', 'agent_runtime_sessions', 'agent_standing_grants', 'agent_command_receipts',
      'project_task_notices', 'project_task_discussions', 'cowork_requests', 'cowork_delivery_intents'])
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table}: no inferred authority/content/receipt backfill`);
    const ledger = (await client.query('SELECT version FROM flux_schema_version ORDER BY version')).rows.map((row) => row.version);
    assert.ok(order.every((version) => ledger.includes(version)));
    assert.equal(Math.max(...ledger), 37);
    assertExactMigrationLedger(manifest, ledger);
    await client.query('UPDATE agent_connections SET revoked_at=clock_timestamp() WHERE id=$1', [connection]);
    const stopped = await coordination();
    assert.equal(stopped.unit[0].state, 'stopped'); assert.equal(stopped.unit[0].generation, 2); assert.equal(stopped.unit[0].version, 3);
    assert.equal(stopped.unit[0].lease_id, null); assert.equal(stopped.unit[0].lease_session_id, null);
    assert.equal(stopped.unit[0].lease_expires_at, null); assert.equal(stopped.unit[0].checkpoint_id, checkpoint);
    assert.deepEqual(stopped.checkpoint, retained.checkpoint);
    assert.deepEqual(await history(), before, 'revocation clears authority without rewriting historical sources');
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
});
