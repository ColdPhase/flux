import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type pg from 'pg';
import { createDatabase, sql } from '@flux/db';
import { connectionString, pool as observer } from './support/db.js';

// #234: a pooled transaction whose BEGIN or ROLLBACK fails on the client (e.g. the 2 s read timeout
// fires while the server still runs it) must destroy that client. Before the fix a failed BEGIN
// leaked the client (the server kept an `idle in transaction` session) and a failed ROLLBACK
// returned a client with an open transaction to the pool.

type Failing = 'begin' | 'rollback';

/** A Flux pool whose next BEGIN (after running) or ROLLBACK (instead of running) fails on the client. */
function poolFailingOn(statement: Failing) {
  const database = createDatabase(connectionString);
  const connect = database.pool.connect.bind(database.pool) as () => Promise<pg.PoolClient>;
  const failed: { pid?: number } = {};
  (database.pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    const query = client.query.bind(client) as (config: unknown, values?: unknown) => Promise<unknown>;
    (client as unknown as { query: typeof query }).query = async (config, values) => {
      const text = (typeof config === 'string' ? config : (config as { text?: string }).text ?? '').trim().toLowerCase();
      if (failed.pid === undefined && text.startsWith(statement)) {
        failed.pid = (client as unknown as { processID: number }).processID;
        if (statement === 'begin') await query(config, values);
        throw new Error('Query read timeout');
      }
      return query(config, values);
    };
    return client;
  };
  after(() => database.pool.end());
  return { ...database, failed };
}

/** The server-side state of one backend, polled until the predicate holds or two seconds pass. */
async function backendState(pid: number, settled: (state: string | null) => boolean): Promise<string | null> {
  let state: string | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { rows } = await observer.query<{ state: string }>('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
    state = rows[0]?.state ?? null;
    if (settled(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return state;
}

describe('pooled transactions release a failed client (#234)', () => {
  test('a BEGIN that fails on the client destroys the client instead of leaking an open transaction', async () => {
    const { db, pool, failed } = poolFailingOn('begin');
    await assert.rejects(db.transaction(async (tx) => { await tx.execute(sql`SELECT 1`); }), /Query read timeout/);
    assert.ok(failed.pid, 'the injected failure ran');
    assert.equal(pool.totalCount, 0, 'the client left the pool instead of staying checked out');
    assert.equal(await backendState(failed.pid, (state) => state === null), null, 'no session is left idle in a transaction');
    const [row] = (await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`)).rows;
    assert.equal(row?.ok, 1, 'the pool keeps working');
  });

  test('a ROLLBACK that fails destroys the client, keeps the original error and leaves the next user a clean session', async () => {
    const { db, pool, failed } = poolFailingOn('rollback');
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      throw new Error('the transaction body failed');
    }), /the transaction body failed/);
    assert.ok(failed.pid, 'the injected failure ran');
    assert.equal(pool.totalCount, 0, 'the client was destroyed, not returned to the pool');
    assert.equal(await backendState(failed.pid, (state) => state === null), null, 'its open transaction ended with the session');
    const { rows } = await pool.query<{ open: boolean }>("SELECT now() <> statement_timestamp() AS open");
    assert.equal(rows[0]?.open, false, 'the next pool user is not inside a leftover transaction');
  });

  test('ordinary commits and rollbacks keep reusing the pooled client', async () => {
    const { db, pool } = createDatabase(connectionString);
    after(() => pool.end());
    assert.equal(await db.transaction(async (tx) => (await tx.execute<{ n: number }>(sql`SELECT 2 AS n`)).rows[0]?.n), 2);
    await assert.rejects(db.transaction(async () => { throw new Error('rolled back'); }), /rolled back/);
    assert.equal(pool.totalCount, 1, 'one healthy client serves both transactions');
    assert.equal(pool.idleCount, 1);
  });
});
