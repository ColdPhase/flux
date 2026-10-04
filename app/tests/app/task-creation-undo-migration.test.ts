import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertExactMigrationLedger, createDatabase, readAppliedMigrationVersions, readTaskCreationReversalManifest, reverseUnusedTaskCreation } from '@flux/db';

const directory = 'packages/db/migrations';
const newColumns = ['creation_origin', 'creation_baseline', 'creation_baseline_version', 'creation_proposal_id', 'first_persisted_use_at',
  'creation_reverted_at', 'creation_reverted_by_kind', 'creation_reverted_by_id', 'creation_reversion_notice_id'];

test('actual sparse0048 upgrade preserves old history; atomic reversal and guarded refusals preserve exact schema/ledger', { timeout: 120_000 }, async () => {
  const manifest = await readTaskCreationReversalManifest(directory);
  assert.equal(manifest.prior.at(-1)?.version, 47); assert.ok(manifest.prior.some(file => file.version === 46));
  assert.ok(!manifest.prior.some(file => file.version === 42), 'reserved gap is preserved rather than invented');
  const name = `flux_undo_history_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool; const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  let history: ReturnType<typeof createDatabase>['pool'] | undefined;
  const [user, workspace, project, work, notice, agent, connection, grant] = Array.from({ length: 8 }, () => randomUUID());
  try {
    await admin.query({ text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 }); history = createDatabase(url.toString()).pool;
    for (const file of manifest.prior) {
      await history.query(await readFile(join(directory, file.name), 'utf8'));
      await history.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    assertExactMigrationLedger(manifest.prior, await readAppliedMigrationVersions(history));
    await history.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Historical author',$2)", [user, `${user}@example.test`]);
    await history.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Original space',$2)", [workspace, user]);
    await history.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Original project',$3)", [project, workspace, user]);
    await history.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,outcome,status,created_by_kind,created_by_id)
      VALUES($1,$2,$3,'Original retained task','Original outcome','open','human',$4)`, [work, workspace, project, user]);
    await history.query(`INSERT INTO project_task_notices(id,workspace_id,project_id,work_id,kind,created_by_kind,created_by_id,sources,created_at)
      VALUES($1,$2,$3,$4,'task.created','human',$5,'[]',clock_timestamp())`, [notice, workspace, project, work, user]);
    const old = async () => ({ work: (await history!.query('SELECT to_jsonb(w) - $1::text[] AS row FROM project_work_items w ORDER BY id', [newColumns])).rows,
      notices: (await history!.query('SELECT * FROM project_task_notices ORDER BY id')).rows,
      search: (await history!.query('SELECT * FROM search_documents ORDER BY doc_key')).rows });
    const original = await old();
    const forward = await readFile(join(directory, '0048_unused_ai_task_creation_undo.sql'), 'utf8');
    const apply = async () => {
      const client = await history!.connect();
      try { await client.query('BEGIN'); await client.query(forward); await client.query('INSERT INTO flux_schema_version(version) VALUES(48)'); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const reverse = async () => {
      const client = await history!.connect();
      try { await reverseUnusedTaskCreation(client, manifest, { quiesced: true }); } finally { client.release(); }
    };
    const state = async () => ({ ledger: await readAppliedMigrationVersions(history!), old: await old(),
      columns: (await history!.query(`SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('project_work_items','project_task_notices','task_creation_undo_receipts','agent_standing_grants')
        ORDER BY table_name,ordinal_position`)).rows,
      triggers: (await history!.query(`SELECT event_object_table,trigger_name,event_manipulation,action_statement FROM information_schema.triggers
        WHERE trigger_schema='public' ORDER BY event_object_table,trigger_name,event_manipulation`)).rows });
    await apply(); assert.deepEqual(await old(), original);
    const unknown = (await history.query(`SELECT ${newColumns.join(',')} FROM project_work_items WHERE id=$1`, [work])).rows[0];
    assert.ok(Object.values(unknown).every(value => value === null), 'old history stays unknown with no inferred provenance/use');
    await assert.rejects(history.query('UPDATE project_work_items SET creation_proposal_id=$1 WHERE id=$2', [randomUUID(), work]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
    assertExactMigrationLedger(manifest.current, await readAppliedMigrationVersions(history));
    const before = await state();
    const busy = await history.connect(); await busy.query('BEGIN'); await busy.query('SELECT id FROM project_work_items FOR SHARE');
    try { await assert.rejects(reverse(), (error: unknown) => error instanceof Error && 'code' in error && error.code === '55P03'); }
    finally { await busy.query('ROLLBACK'); busy.release(); }
    assert.deepEqual(await state(), before, 'active relation holder refusal preserves schema and ledger');
    await reverse(); assert.deepEqual(await old(), original); assertExactMigrationLedger(manifest.prior, await readAppliedMigrationVersions(history));
    assert.equal((await history.query("SELECT to_regclass('task_creation_undo_receipts') AS name")).rows[0].name, null);
    assert.throws(() => assertExactMigrationLedger(manifest.current, manifest.prior.map(file => file.version)), /0048/,
      'the current image readiness check refuses the reversed database; actual prior-image startup is a separate gate');
    await apply(); assert.deepEqual(await old(), original);
    await history.query('UPDATE project_work_items SET first_persisted_use_at=clock_timestamp() WHERE id=$1', [work]);
    const used = await state(); await assert.rejects(reverse(), /reversal refused/); assert.deepEqual(await state(), used);
    // Reset only this disposable database for a distinct grant-refusal scenario.
    // The runner never clears a latch or truncates task/receipt/history storage.
    await history.query('TRUNCATE project_work_items CASCADE');
    await history.query("INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Original agent',$3,$3)", [agent, workspace, user]);
    await history.query("INSERT INTO agent_connections(id,workspace_id,owner_user_id,agent_id,scopes) VALUES($1,$2,$3,$4,ARRAY['flux.context.read'])", [connection, workspace, user, agent]);
    await history.query('INSERT INTO agent_connection_projects(workspace_id,connection_id,project_id) VALUES($1,$2,$3)', [workspace, connection, project]);
    await history.query(`INSERT INTO agent_standing_grants(id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
      operation,peer_request_class,maximum_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'work.creation.revert','execute',1,clock_timestamp()+interval '1 hour')`,
    [grant, workspace, project, connection, user, randomUUID(), 'a'.repeat(64)]);
    const granted = await state(); await assert.rejects(reverse(), /Undo grants/); assert.deepEqual(await state(), granted);
    await history.query('INSERT INTO flux_schema_version(version) VALUES(49)');
    const later = await state(); await assert.rejects(reverse(), /versions without files.*49/); assert.deepEqual(await state(), later);
  } finally {
    await history?.end();
    await admin.query({ text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 }); await admin.end();
  }
});
