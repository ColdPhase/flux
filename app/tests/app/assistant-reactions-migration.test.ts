import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

test('0114 up/reverse/reapply preserves native tasks and ordinary runs; fixed event/action and tap/dedupe constraints hold', async () => {
  const client=await pool.connect(); const namespace=`assistant_when_${randomUUID().replaceAll('-','')}`;
  const directory='packages/db/migrations';
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA ${namespace}`); await client.query(`SET LOCAL search_path TO ${namespace},public,pg_catalog`);
    for(const file of (await readMigrationManifest(directory,FLUX_SCHEMA_VERSION)).filter((file)=>file.version!==114)) await client.query(await readFile(join(directory,file.name),'utf8'));
    const owner=randomUUID(),ws=randomUUID(),project=randomUUID(),agent=randomUUID(),conversation=randomUUID(),ask=randomUUID(),reaction=randomUUID(),rule=randomUUID(),task=randomUUID();
    await client.query(`INSERT INTO auth_users(id,name,email) VALUES($1,'Ada',$2)`,[owner,`${owner}@example.test`]);
    await client.query(`INSERT INTO workspaces(id,name,created_by) VALUES($1,'Studio',$2)`,[ws,owner]);
    await client.query(`INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Sensor','workspace',$3)`,[project,ws,owner]);
    await client.query(`INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Assistant',$3,$3)`,[agent,ws,owner]);
    await client.query(`INSERT INTO project_conversations(id,workspace_id,project_id,created_by) VALUES($1,$2,$3,$4)`,[conversation,ws,project,owner]);
    const run=(id:string,kind:string)=>client.query(`INSERT INTO personal_runs(id,workspace_id,project_id,conversation_id,owner_user_id,agent_id,client_run_id,request_fingerprint,kind,prompt,reserved_micros,provider,model) VALUES($1,$2,$3,$4,$5,$6,$7,'f',$8,'Check the connector',500000,'anthropic','claude-sonnet-5')`,[id,ws,project,conversation,owner,agent,randomUUID(),kind]);
    await run(ask,'ask');
    const up=await readFile(join(directory,'0114_assistant_reactions.sql'),'utf8');
    await client.query(up); await run(reaction,'reaction');
    await client.query(`INSERT INTO assistant_reactions(id,workspace_id,project_id,owner_user_id,event,action) VALUES($1,$2,$3,$4,'blocked','tell')`,[rule,ws,project,owner]);
    await client.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,status,blocker,owner_user_id,created_by_kind,created_by_id) VALUES($1,$2,$3,'Sensor','blocked','No power',$4,'human',$4)`,[task,ws,project,owner]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM assistant_reaction_events')).rows[0].n,0,'off means no capture');
    await client.query(`UPDATE assistant_reactions SET enabled=true WHERE id=$1`,[rule]);
    await client.query(`UPDATE project_work_items SET blocker='Connector loose' WHERE id=$1`,[task]);
    const event=(await client.query('SELECT * FROM assistant_reaction_events')).rows[0];
    assert.equal(event.owner_user_id,owner); assert.equal(event.object_id,task); assert.equal(event.event,'blocked'); assert.equal(event.reaction_version,1); assert.equal(event.data,null,'tap stores no text');
    await client.query(`SELECT assistant_capture_reaction($1,$2,'blocked',$3,$4)`,[project,owner,task,event.source_id]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM assistant_reaction_events')).rows[0].n,1);
    await client.query('SAVEPOINT unsupported');
    await assert.rejects(client.query(`UPDATE assistant_reactions SET action='draft_reply' WHERE id=$1`,[rule]),/check constraint/);
    await client.query('ROLLBACK TO SAVEPOINT unsupported');
    await client.query(await readFile(join(directory,'reverse/0114_assistant_reactions.down.sql'),'utf8'));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM project_work_items WHERE id=$1',[task])).rows[0].n,1);
    assert.deepEqual((await client.query('SELECT id FROM personal_runs ORDER BY id')).rows.map((row)=>row.id),[ask,reaction].sort());
    assert.equal((await client.query(`SELECT to_regclass($1) AS table`,[`${namespace}.assistant_reactions`])).rows[0].table,null);
    await client.query(up);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM assistant_reactions')).rows[0].n,0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
