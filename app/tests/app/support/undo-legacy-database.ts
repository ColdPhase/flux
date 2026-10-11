import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';

export const legacyDirectory = 'tests/app/fixtures/task-creation-undo-legacy';
const directory = 'packages/db/migrations';
const execute = (db: ReturnType<typeof createDatabase>['pool'], text: string) => {
  const statement = { text, query_timeout: 60_000 }; return db.query(statement);
};
export const legacySql = (name: string) => readFile(`${legacyDirectory}/${name}`, 'utf8');
export const dbUrl = (name: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; return url.toString(); };
export async function originalUndoFiles() {
  const provenance = JSON.parse(await readFile(`${legacyDirectory}/provenance.json`, 'utf8')) as {
    originalUndoManifest: { name: string; sha256: string }[];
  };
  return Promise.all(provenance.originalUndoManifest.map(async (file) => {
    const sql = await readFile(`${Number(file.name.slice(0, 4)) === 48 || Number(file.name.slice(0, 4)) === 57 ? legacyDirectory : directory}/${file.name}`, 'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'), file.sha256, `original 45c08e7d SQL remains exact: ${file.name}`);
    return { name: file.name, version: Number(file.name.slice(0, 4)), sql };
  }));
}
export async function fixtureDatabase(files?: Awaited<ReturnType<typeof originalUndoFiles>>, name = `flux_undo_legacy_${randomUUID().replaceAll('-', '')}`) {
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  await execute(admin, `CREATE DATABASE "${name}"`);
  const db = createDatabase(dbUrl(name)).pool;
  const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
  try {
    for (const file of files ?? await Promise.all(manifest.map(async (file) => ({ ...file, sql: await readFile(`${directory}/${file.name}`, 'utf8') })))) {
      await execute(db, file.sql);
      await db.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
  } catch (error) { await db.end(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); throw error; }
  return { db, name, async close() { await db.end(); await execute(admin, `DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); },
    async retain() { await db.end(); await admin.end(); } };
}
export async function retainedHistory(db: ReturnType<typeof createDatabase>['pool']) {
  const user = randomUUID(), workspace = randomUUID(), project = randomUUID(), task = randomUUID();
  await db.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Legacy retained owner',$2)", [user, `${user}@example.test`]);
  await db.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Legacy retained space',$2)", [workspace, user]);
  await db.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Legacy retained project',$3)", [project, workspace, user]);
  await db.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id)
    VALUES($1,$2,$3,'Original retained task','human',$4)`, [task, workspace, project, user]);
  return { user, workspace, project, task };
}
export async function retainedUndoHistory(db: ReturnType<typeof createDatabase>['pool']) {
  const { user, workspace, project, task } = await retainedHistory(db);
  const agent = randomUUID(), connection = randomUUID(), reverted = randomUUID(), createdNotice = randomUUID(), revertedNotice = randomUUID();
  await db.query("INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Legacy creator agent',$3,$3)", [agent, workspace, user]);
  await db.query("INSERT INTO agent_connections(id,workspace_id,owner_user_id,agent_id,scopes) VALUES($1,$2,$3,$4,ARRAY['flux.context.read'])", [connection, workspace, user, agent]);
  await db.query('INSERT INTO agent_connection_projects(workspace_id,connection_id,project_id) VALUES($1,$2,$3)', [workspace, connection, project]);
  await db.query(`INSERT INTO agent_standing_grants(id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
    operation,peer_request_class,maximum_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'work.creation.revert','execute',1,'2026-10-12T12:34:56Z')`,
  [randomUUID(), workspace, project, connection, user, randomUUID(), 'a'.repeat(64)]);
  await db.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id,creation_origin,creation_baseline,creation_baseline_version)
    VALUES($1,$2,$3,'Legacy reverted agent task','agent',$4,'native_agent','{}'::jsonb,1)`, [reverted, workspace, project, agent]);
  await db.query(`INSERT INTO project_task_notices(id,workspace_id,project_id,work_id,kind,created_by_kind,created_by_id,sources,created_at)
    VALUES($1,$2,$3,$4,'task.created','agent',$5,'[]',clock_timestamp()),($6,$2,$3,$4,'task.creation_reverted','human',$7,'[]',clock_timestamp())`,
  [createdNotice, workspace, project, reverted, agent, revertedNotice, user]);
  await db.query(`UPDATE project_work_items SET creation_reverted_at=clock_timestamp(),creation_reverted_by_kind='human',creation_reverted_by_id=$2,
    creation_reversion_notice_id=$3,version=2 WHERE id=$1`, [reverted, user, revertedNotice]);
  await db.query(`INSERT INTO task_creation_undo_receipts(workspace_id,project_id,actor_kind,actor_id,client_command_id,request_fingerprint,work_id,notice_id)
    VALUES($1,$2,'human',$3,$4,$5,$6,$7)`, [workspace, project, user, randomUUID(), 'b'.repeat(64), reverted, revertedNotice]);
  await db.query('UPDATE project_work_items SET first_persisted_use_at=clock_timestamp() WHERE id=$1', [task]);
}
export async function snapshot(db: ReturnType<typeof createDatabase>['pool']) {
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows as { tablename: string }[];
  const data: Record<string, unknown> = {};
  for (const { tablename } of tables) data[tablename] = (await db.query(`SELECT to_jsonb(t)::text AS row FROM "${tablename.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)).rows;
  const catalog = await db.query(`SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(x ORDER BY x.table_name,x.ordinal_position) FROM
      (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public') x),
    'constraints',(SELECT jsonb_agg(x ORDER BY x.relation,x.name) FROM
      (SELECT conrelid::regclass::text AS relation,conname AS name,pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace) x),
    'triggers',(SELECT jsonb_agg(x ORDER BY x.relation,x.name) FROM
      (SELECT tgrelid::regclass::text AS relation,tgname AS name,pg_get_triggerdef(oid) AS definition,tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)) x),
    'functions',(SELECT jsonb_agg(x ORDER BY x.name,x.arguments) FROM
      (SELECT proname AS name,pg_get_function_identity_arguments(oid) AS arguments,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f') x),
    'schemas',(SELECT jsonb_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema')
  ) AS catalog`);
  return { data, catalog: catalog.rows[0].catalog };
}
export function migrationCli(name: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tooling/dist/migrate.js'], { env: { ...process.env, DATABASE_URL: dbUrl(name) } });
    let output = ''; child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
    child.once('error', reject); child.once('exit', (code) => resolve({ code, output }));
  });
}
export async function refusedUnchanged(fixture: Awaited<ReturnType<typeof fixtureDatabase>>, reason: RegExp) {
  const before = await snapshot(fixture.db);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await migrationCli(fixture.name);
    assert.equal(result.code, 1, result.output); assert.match(result.output, reason);
    assert.ok(!result.output.includes('Applied migration'), result.output);
    assert.deepEqual(await snapshot(fixture.db), before, 'real CLI refusal/restart preserves every public row, catalog, ledger and pg-boss absence');
  }
}
