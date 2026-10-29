import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const directory = 'packages/db/migrations';

test('0109 adds schedules, their history, the note, the written summary and the silent run; the reverse keeps every ordinary run', async () => {
  const client = await pool.connect(); const namespace = `assistant_jobs_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET LOCAL search_path TO ${namespace}, public, pg_catalog`);
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    assert.equal(manifest.find((file) => file.version === 109)?.name, '0109_assistant_schedules.sql');
    // 0119 (F-030) lists the AI tables of schema `public` (the test stack's own, fully migrated) and creates its trigger on the table
    // of that name that search_path finds first. Before 0109 this namespace has no assistant_jobs, so it would find the stack's
    // table, which has the trigger already. A real upgrade applies 0109 first, so 0119 and what builds on it go in right after it.
    const afterwards = manifest.filter((file) => file.version >= 119);
    assert.equal(afterwards[0]?.name, '0119_encrypted_workspaces.sql');
    for (const file of manifest.filter((item) => item.version !== 109 && item.version < 119)) {
      await client.query(await readFile(join(directory, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const owner = randomUUID(); const ws = randomUUID(); const agent = randomUUID(); const project = randomUUID(); const conversation = randomUUID(); const ask = randomUUID();
    await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Ada',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Lab',$2)", [ws, owner]);
    await client.query("INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Assistant',$3,$3)", [agent, ws, owner]);
    await client.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Lamp','workspace',$3)", [project, ws, owner]);
    await client.query('INSERT INTO project_conversations(id,workspace_id,project_id,created_by) VALUES($1,$2,$3,$4)', [conversation, ws, project, owner]);
    await client.query('INSERT INTO notification_preferences(user_id) VALUES($1)', [owner]);
    const run = (id: string, kind: string) => client.query(`INSERT INTO personal_runs(id,workspace_id,project_id,conversation_id,owner_user_id,agent_id,client_run_id,request_fingerprint,kind,prompt,reserved_micros,provider,model,ai_epoch)
      VALUES($1,$2,$3,$4,$5,$6,$7,'f',$8,'Look around',1000,'anthropic','claude-sonnet-5',1)`, [id, ws, project, conversation, owner, agent, randomUUID(), kind]);
    await run(ask, 'ask');

    await client.query(await readFile(join(directory, '0109_assistant_schedules.sql'), 'utf8'));
    await client.query('INSERT INTO flux_schema_version(version) VALUES(109)');
    for (const file of afterwards) {
      await client.query(await readFile(join(directory, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES($1)', [file.version]);
    }
    assert.deepEqual((await client.query('SELECT silent FROM personal_runs WHERE id=$1', [ask])).rows, [{ silent: false }], 'an ordinary run is not silent');
    assert.deepEqual((await client.query('SELECT summary_by_assistant FROM notification_preferences WHERE user_id=$1', [owner])).rows, [{ summary_by_assistant: false }]);
    const scheduled = randomUUID();
    await run(scheduled, 'scheduled');
    await client.query('SAVEPOINT bogus');
    await assert.rejects(run(randomUUID(), 'bogus'), /personal_runs_kind_check/);
    await client.query('ROLLBACK TO SAVEPOINT bogus');

    const job = randomUUID();
    await client.query(`INSERT INTO assistant_jobs(id,workspace_id,owner_user_id,project_id,title,text,schedule_kind,schedule,time_zone,enabled,next_run_at)
      VALUES($1,$2,$3,$4,'Weekly review','Review the week','weekly','{"kind":"weekly","at":"09:00","weekday":1}'::jsonb,'UTC',true,now())`, [job, ws, owner, project]);
    const fired = new Date('2026-10-19T09:00:00Z');
    const firing = (state: string, by = 'schedule', at = fired) => client.query(`INSERT INTO assistant_job_runs(id,job_id,owner_user_id,fired_at,fired_by,state,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 = 'running' THEN NULL ELSE now() END)`, [randomUUID(), job, owner, at, by, state]);
    await firing('running');
    // The same time cannot be fired twice, and a schedule has one run at a time.
    await client.query('SAVEPOINT twice');
    await assert.rejects(firing('skipped'), /assistant_job_runs_job_id_fired_at_fired_by_key/);
    await client.query('ROLLBACK TO SAVEPOINT twice');
    await client.query('SAVEPOINT oneAtATime');
    await assert.rejects(firing('running', 'now', new Date('2026-10-19T09:01:00Z')), /assistant_job_runs_one_running_idx/);
    await client.query('ROLLBACK TO SAVEPOINT oneAtATime');
    await firing('done', 'now', new Date('2026-10-19T09:02:00Z'));
    await client.query('SAVEPOINT due');
    await assert.rejects(client.query('UPDATE assistant_jobs SET enabled=false WHERE id=$1', [job]), /assistant_jobs_due_check/, 'a schedule that is off has no next time');
    await client.query('ROLLBACK TO SAVEPOINT due');
    await client.query("UPDATE assistant_job_runs SET run_id=$1 WHERE job_id=$2 AND state='running'", [scheduled, job]);
    await client.query("INSERT INTO assistant_background_notes(owner_user_id,account_key,note_version) VALUES($1,'runtime:claude_code','v1')", [owner]);
    await client.query("INSERT INTO assistant_morning_summaries(owner_user_id,day,state,line) VALUES($1,'2026-10-19','written','Good morning, Ada.')", [owner]);
    await client.query('SAVEPOINT written');
    await assert.rejects(client.query("INSERT INTO assistant_morning_summaries(owner_user_id,day,state,line) VALUES($1,'2026-10-20','written',NULL)", [owner]), /assistant_morning_summaries_written_check/);
    await client.query('ROLLBACK TO SAVEPOINT written');

    // Reverse: the ordinary run stays, the background run goes with its change log, and the tables and columns are gone.
    await client.query(await readFile(join(directory, 'reverse/0109_assistant_schedules.down.sql'), 'utf8'));
    await client.query('DELETE FROM flux_schema_version WHERE version=109');
    assert.deepEqual((await client.query('SELECT id FROM personal_runs')).rows, [{ id: ask }]);
    for (const table of ['assistant_jobs', 'assistant_job_runs', 'assistant_background_notes', 'assistant_morning_summaries'])
      assert.equal((await client.query('SELECT to_regclass($1) AS name', [`${namespace}.${table}`])).rows[0].name, null, table);
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('silent','summary_by_assistant')", [namespace])).rowCount, 0);
    await client.query('SAVEPOINT kind');
    await assert.rejects(run(randomUUID(), 'scheduled'), /personal_runs_kind_check/);
    await client.query('ROLLBACK TO SAVEPOINT kind');
    // It applies again on the restored schema.
    await client.query(await readFile(join(directory, '0109_assistant_schedules.sql'), 'utf8'));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM assistant_jobs')).rows[0].n, 0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
