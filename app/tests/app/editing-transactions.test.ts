import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { EditingTransactionError, editingTransactions } from '@flux/db';

function boundary(fail: 'work' | 'commit' | 'rollback' | null) {
  const statements: string[] = []; const releases: boolean[] = [];
  const pool = { async connect() {
    return { async query(sql: string) { statements.push(sql); if (sql === 'COMMIT' && fail === 'commit' || sql === 'ROLLBACK' && fail === 'rollback') throw new Error(`controlled ${sql}`); return { rows: [] }; },
      release(discard: boolean) { releases.push(discard); } } as unknown as pg.PoolClient;
  } };
  return { transactions: editingTransactions(pool), statements, releases };
}
test('explicit public transaction distinguishes definite rollback from uncertain COMMIT/ROLLBACK responses', async () => {
  const work = boundary('work'); const failure = new Error('controlled pre-COMMIT work failure');
  await assert.rejects(work.transactions.run(async () => { throw failure; }), (error) => error === failure);
  assert.equal(work.statements.at(-1), 'ROLLBACK'); assert.deepEqual(work.releases, [false]); assert.ok(!work.statements.includes('COMMIT'));
  const commit = boundary('commit');
  await assert.rejects(commit.transactions.run(async () => 'prepared'), (error) => error instanceof EditingTransactionError && error.outcome === 'unknown');
  assert.equal(commit.statements.at(-1), 'COMMIT'); assert.ok(!commit.statements.includes('ROLLBACK')); assert.deepEqual(commit.releases, [true]);
  const rollback = boundary('rollback');
  await assert.rejects(rollback.transactions.run(async () => { throw failure; }), (error) => error instanceof EditingTransactionError && error.outcome === 'unknown');
  assert.deepEqual(rollback.releases, [true]);
  const success = boundary(null); assert.equal(await success.transactions.run(async () => 'committed'), 'committed');
  assert.equal(success.statements.at(-1), 'COMMIT'); assert.deepEqual(success.releases, [false]);
});

// This public query interposition sends a real BEGIN followed by a sleeping SQL statement:
// the client timeout loses the BEGIN response after the backend has opened a transaction.
test('actual pg BEGIN read timeout discards the ambiguous backend and preserves the original failure', {timeout:5000}, async()=>{
  const pgModule=await import('pg');
  const databaseUrl=process.env.DATABASE_URL;
  assert.ok(databaseUrl,'The application fixture requires its isolated PostgreSQL database');
  const pool=new pgModule.default.Pool({connectionString:databaseUrl,max:1,query_timeout:100});
  let callback=false;let originalFailure:unknown;let backend=0;
  const instrumented={async connect(){
    const client=await pool.connect();backend=Number((await client.query('SELECT pg_backend_pid() id')).rows[0].id);
    const query=client.query.bind(client);
    client.query=function(...args:unknown[]) {
      if(args[0]==='BEGIN')return query('BEGIN; SELECT pg_sleep(2)').catch(error=>{originalFailure=error;throw error;});
      return Reflect.apply(query,client,args);
    } as typeof client.query;
    return client;
  }};
  try {
    await assert.rejects(editingTransactions(instrumented).run(async()=>{callback=true;}),error=>error===originalFailure);
    assert.equal(callback,false);assert.equal(pool.totalCount,0,'The ambiguous backend cannot re-enter the pool');
    const next=await pool.connect();try {
      const result=await next.query('SELECT pg_backend_pid() id, now()=statement_timestamp() clean,1 works');
      assert.notEqual(Number(result.rows[0].id),backend);assert.equal(result.rows[0].clean,true);assert.equal(result.rows[0].works,1);
      const deadline=Date.now()+3000;let old=true;
      while(old&&Date.now()<deadline){old=(await next.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) old',[backend])).rows[0].old;if(old)await new Promise(resolve=>setTimeout(resolve,20));}
      assert.equal(old,false,'The ambiguous backend has exited, rather than merely leaving the JavaScript pool');
    } finally {next.release();}
  } finally {await pool.end();}
});
