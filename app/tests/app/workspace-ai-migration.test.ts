import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AI_WORK_QUEUES } from '@flux/contracts';
import { FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

// Migration 0115 (F-029 workspace AI lock, #614): every existing workspace gets an explicit `allowed` row, a new one gets
// its row from the trigger, AI work rows need their admission epoch, the backstop refuses AI work while AI is off or under
// another epoch, the reaction tap captures nothing while AI is off and never fails the person's write; reverse and reapply.

const directory = 'packages/db/migrations';

test('0115 up: explicit allowed rows, epoch columns without default, backstop and quiet tap; reverse and reapply', async () => {
  const client = await pool.connect();
  const namespace = `workspace_ai_${randomUUID().replaceAll('-', '')}`;
  const sql = async (version: number) => {
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    return readFile(join(directory, manifest.find((file) => file.version === version)!.name), 'utf8');
  };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET LOCAL search_path TO ${namespace}, public, pg_catalog`);
    for (const file of (await readMigrationManifest(directory, FLUX_SCHEMA_VERSION)).filter((file) => file.version < 115))
      await client.query(await readFile(join(directory, file.name), 'utf8'));
    const owner = randomUUID(); const [ws1, ws2, ws3, project, agent, conversation, task, rule] = Array.from({ length: 8 }, () => randomUUID());
    await client.query(`INSERT INTO auth_users(id,name,email) VALUES($1,'Ada',$2)`, [owner, `${owner}@example.test`]);
    for (const ws of [ws1, ws2]) await client.query(`INSERT INTO workspaces(id,name,created_by) VALUES($1,'Studio',$2)`, [ws, owner]);
    await client.query(`INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Lamp','workspace',$3)`, [project, ws1, owner]);
    await client.query(`INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Assistant',$3,$3)`, [agent, ws1, owner]);
    await client.query(`INSERT INTO project_conversations(id,workspace_id,project_id,created_by) VALUES($1,$2,$3,$4)`, [conversation, ws1, project, owner]);
    const run = (id: string, epoch?: number) => client.query(`INSERT INTO personal_runs(id,workspace_id,project_id,conversation_id,owner_user_id,agent_id,
      client_run_id,request_fingerprint,kind,prompt,reserved_micros,provider,model${epoch === undefined ? '' : ',ai_epoch'})
      VALUES($1,$2,$3,$4,$5,$6,$7,'f','ask','Look',1000,'anthropic','claude-sonnet-5'${epoch === undefined ? '' : ',$8'})`,
    [id, ws1, project, conversation, owner, agent, randomUUID(), ...(epoch === undefined ? [] : [epoch])]);
    const before = randomUUID();
    await run(before);

    await client.query(await sql(115));
    const rows = (await client.query('SELECT workspace_id, state, epoch::int AS epoch, version FROM workspace_ai_policies ORDER BY workspace_id')).rows;
    assert.deepEqual(rows, [ws1, ws2].sort().map((id) => ({ workspace_id: id, state: 'allowed', epoch: 1, version: 1 })),
      'every existing workspace has an explicit allowed row');
    assert.equal((await client.query('SELECT ai_epoch::int AS e FROM personal_runs WHERE id=$1', [before])).rows[0].e, 1, 'existing work is at epoch 1');
    await client.query(`INSERT INTO workspaces(id,name,created_by) VALUES($1,'New',$2)`, [ws3, owner]);
    assert.equal((await client.query('SELECT state FROM workspace_ai_policies WHERE workspace_id=$1', [ws3])).rows[0].state, 'allowed', 'a new workspace starts allowed');
    // No default hides a forgotten stamp, on every AI work table.
    for (const table of AI_WORK_QUEUES.tables) {
      const column = (await client.query(`SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 AND column_name='ai_epoch'`, [namespace, table])).rows[0];
      assert.deepEqual(column, { is_nullable: 'NO', column_default: null }, `${table}.ai_epoch`);
      const triggers = (await client.query(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname='ai_work_admission'`, [namespace, table])).rows[0].n;
      assert.equal(triggers, 1, `${table} has the backstop`);
    }
    await client.query('SAVEPOINT missing');
    await assert.rejects(run(randomUUID()), /null value in column "ai_epoch"|AI is turned off in this workspace/, 'an insert without the stamp fails loudly');
    await client.query('ROLLBACK TO SAVEPOINT missing');
    await run(randomUUID(), 1);
    // The backstop: AI off, or another epoch, refuses the row.
    await client.query(`UPDATE workspace_ai_policies SET state='blocked', epoch=epoch+1 WHERE workspace_id=$1`, [ws1]);
    for (const epoch of [1, 2]) {
      await client.query('SAVEPOINT blocked');
      await assert.rejects(run(randomUUID(), epoch), /AI is turned off in this workspace/);
      await client.query('ROLLBACK TO SAVEPOINT blocked');
    }
    await client.query(`UPDATE workspace_ai_policies SET state='allowed', epoch=epoch+1 WHERE workspace_id=$1`, [ws1]);
    await client.query('SAVEPOINT stale');
    await assert.rejects(run(randomUUID(), 2), /AI is turned off in this workspace/, 'an older epoch is refused after re-enable');
    await client.query('ROLLBACK TO SAVEPOINT stale');
    await run(randomUUID(), 3);
    // The reaction tap: a person's task write always commits; it captures only while AI is on, with the epoch.
    await client.query(`INSERT INTO assistant_reactions(id,workspace_id,project_id,owner_user_id,event,action,enabled) VALUES($1,$2,$3,$4,'blocked','tell',true)`,
      [rule, ws1, project, owner]);
    await client.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,status,blocker,owner_user_id,created_by_kind,created_by_id)
      VALUES($1,$2,$3,'Sensor','blocked','No power',$4,'human',$4)`, [task, ws1, project, owner]);
    await client.query(`UPDATE project_work_items SET blocker='Connector loose' WHERE id=$1`, [task]);
    const captured = async () => (await client.query('SELECT DISTINCT ai_epoch::int AS epoch FROM assistant_reaction_events')).rows;
    const count = async () => (await client.query('SELECT count(*)::int AS n FROM assistant_reaction_events')).rows[0].n as number;
    assert.deepEqual(await captured(), [{ epoch: 3 }], 'captured while AI is on, at the current epoch');
    const capturedWhileOn = await count();
    assert.ok(capturedWhileOn >= 1);
    await client.query(`UPDATE workspace_ai_policies SET state='blocked', epoch=epoch+1 WHERE workspace_id=$1`, [ws1]);
    await client.query(`UPDATE project_work_items SET blocker='Loose wire' WHERE id=$1`, [task]);
    await client.query(`SELECT assistant_capture_reaction($1,$2,'blocked',$3,$4)`, [project, owner, task, randomUUID()]);
    assert.equal(await count(), capturedWhileOn, 'nothing is captured while AI is off, and the write committed');
    assert.equal((await client.query('SELECT blocker FROM project_work_items WHERE id=$1', [task])).rows[0].blocker, 'Loose wire');
    assert.match((await client.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='personal_runs_end_reason_check'
      AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)`, [namespace])).rows[0].def, /'ai_off'/);

    await client.query(`UPDATE personal_runs SET end_reason='ai_off', status='stopped' WHERE id=$1`, [before]);
    await client.query(await readFile(join(directory, 'reverse/0115_workspace_ai_policy.down.sql'), 'utf8'));
    assert.equal((await client.query('SELECT to_regclass($1) AS t', [`${namespace}.workspace_ai_policies`])).rows[0].t, null);
    assert.equal((await client.query('SELECT end_reason FROM personal_runs WHERE id=$1', [before])).rows[0].end_reason, 'unknown', 'reverse keeps the run');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND column_name='ai_epoch'`, [namespace])).rows[0].n, 0);
    await run(randomUUID());
    await client.query(await sql(115));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM workspace_ai_policies')).rows[0].n, 3, 'reapply writes a row per workspace again');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
