import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { assertExactMigrationLedger, createDatabase, readAppliedMigrationVersions, readTaskCreationReversalManifest, reverseUnusedTaskCreation } from '@flux/db';
const directory='packages/db/migrations';
async function replacement(pool: ReturnType<typeof createDatabase>['pool'], old: number) {
  assert.equal(pool.totalCount,0,'The ambiguous dedicated client is destroyed rather than returned idle');
  const client=await pool.connect();
  try {
    const current=(await client.query('SELECT pg_backend_pid() AS pid,now()=statement_timestamp() AS clean')).rows[0];
    assert.notEqual(Number(current.pid),old);assert.equal(current.clean,true);
    const deadline=Date.now()+4000;let present=true;
    while(present&&Date.now()<deadline){present=(await client.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present',[old])).rows[0].present;if(present)await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(present,false,'The old backend and its delayed control query have exited');
  } finally {client.release();}
}

test('actual pg advisory query_timeout preserves the original rejection and destroys the client even before serialization was observed', {timeout:15_000},async()=>{
  const manifest=await readTaskCreationReversalManifest(directory);const holder=createDatabase(process.env.DATABASE_URL!).pool;const isolated=createDatabase(process.env.DATABASE_URL!).pool;
  const lock=await holder.connect();let locked=false;let original:unknown;let backend=0;
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))',['flux-migrate']);locked=true;
    const client=await isolated.connect();backend=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const query=client.query.bind(client);
    client.query=function(...args:unknown[]){const pending=Reflect.apply(query,client,args);return args[0]==='SELECT pg_advisory_lock(hashtext($1))'?pending.catch((error:unknown)=>{original=error;throw error;}):pending;} as typeof client.query;
    await assert.rejects(reverseUnusedTaskCreation(client,manifest,{quiesced:true}),error=>error===original&&error instanceof Error&&/timeout/i.test(error.message));
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['flux-migrate']);locked=false;
    await replacement(isolated,backend);
    const probe=await isolated.query('SELECT pg_try_advisory_lock(hashtext($1)) AS free',['flux-migrate']);assert.equal(probe.rows[0].free,true);
    await isolated.query('SELECT pg_advisory_unlock(hashtext($1))',['flux-migrate']);
  } finally {if(locked)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['flux-migrate']);lock.release();await Promise.all([holder.end(),isolated.end()]);}
});

test('actual pg COMMIT response timeout reports unknown reversal with original cause; replacement inspects the committed exact prior ledger', {timeout:120_000},async()=>{
  const manifest=await readTaskCreationReversalManifest(directory);const name=`flux_undo_control_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.DATABASE_URL!,connectionTimeoutMillis:1500,query_timeout:60000,max:1});
  const url=new URL(process.env.DATABASE_URL!);url.pathname=`/${name}`;let history:ReturnType<typeof createDatabase>['pool']|undefined;
  let original:unknown;let backend=0;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);history=createDatabase(url.toString()).pool;
    for(const file of manifest.current){await history.query(await readFile(join(directory,file.name),'utf8'));await history.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING',[file.version]);}
    const client=await history.connect();backend=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);const query=client.query.bind(client);
    // Genuine COMMIT is sent before the sleeping statement; its response is lost
    // through public pg's configured query_timeout, without fabricating rejection.
    client.query=function(...args:unknown[]){return args[0]==='COMMIT'?query('COMMIT; SELECT pg_sleep(3)').catch(error=>{original=error;throw error;}):Reflect.apply(query,client,args);} as typeof client.query;
    await assert.rejects(reverseUnusedTaskCreation(client,manifest,{quiesced:true}),error=>error instanceof Error&&/COMMIT outcome is unknown/.test(error.message)&&error.cause===original);
    await replacement(history,backend);assertExactMigrationLedger(manifest.prior,await readAppliedMigrationVersions(history));
    assert.equal((await history.query("SELECT to_regclass('task_creation_undo_receipts') AS name")).rows[0].name,null);
  } finally {try{await history?.end();}finally{try{await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);}finally{await admin.end();}}}
});
