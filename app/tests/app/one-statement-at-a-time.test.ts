import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type pg from 'pg';
import { createDatabase, sql } from '@flux/db';
import { connectionString } from './support/db.js';

// pg 8.23 warns, once per process, that a statement issued while another runs on the same connection "is deprecated and will be removed
// in pg@9.0". A transaction's `tx` is one connection, so `Promise.all` over it reaches that (#916). Flux's pool connections run one
// statement at a time in the order asked, so the warning has nothing to say and pg 9 changes nothing. The wrapped connection is tested
// first: pg warns once, and the control at the end needs that first warning for itself.
const warnings: string[] = [];
process.on('warning', (warning) => { if (/already executing a query/.test(warning.message)) warnings.push(warning.message); });
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 50); });

const database = createDatabase(connectionString, undefined, { onError: () => undefined });
after(async () => { await database.pool.end(); });

test('statements issued together inside a transaction run in the order asked, and pg is never asked while it is busy', async () => {
  const rows = await database.db.transaction(async (tx) => {
    await tx.execute(sql`CREATE TEMP TABLE one_at_a_time (id serial PRIMARY KEY, n int) ON COMMIT DROP`);
    const slow = tx.execute(sql`INSERT INTO one_at_a_time (n) SELECT 1 FROM pg_sleep(0.1)`);
    const second = tx.execute(sql`INSERT INTO one_at_a_time (n) VALUES (2)`);
    const third = tx.execute(sql`INSERT INTO one_at_a_time (n) VALUES (3)`);
    const read = tx.execute(sql`SELECT n FROM one_at_a_time ORDER BY id`);
    const [, , , result] = await Promise.all([slow, second, third, read]);
    return result.rows.map((row) => Number(row.n));
  });
  assert.deepEqual(rows, [1, 2, 3], 'the slow statement was first and the others did not overtake it');
  await settle();
  assert.deepEqual(warnings, [], 'pg did not warn');
});

test('a failed statement does not stop the ones behind it, and reaches only its own caller', async () => {
  const client = await database.pool.connect();
  try {
    const results = await Promise.allSettled([client.query('SELECT 1 AS n'), client.query('SELECT nope FROM nowhere'), client.query('SELECT 3 AS n')]);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal((results[2] as PromiseFulfilledResult<pg.QueryResult>).value.rows[0].n, 3);
    await new Promise<void>((resolve, reject) => { client.query('SELECT 4 AS n', (error, result) => { if (error) reject(error); else { assert.equal(result.rows[0].n, 4); resolve(); } }); });
    assert.equal((await database.pool.query('SELECT 5 AS n')).rows[0].n, 5, 'the pool\'s own queries are untouched');
  } finally { client.release(); }
  await settle();
  assert.deepEqual(warnings, []);
});

test('a statement that times out fails the ones waiting behind it at once, not one timeout after another (#961)', async () => {
  const quick = createDatabase(connectionString, undefined, { onError: () => undefined, queryTimeoutMs: 300 });
  const client = await quick.pool.connect();
  try {
    const started = Date.now();
    // The first hangs for three seconds on the server. Behind it, each would wait its own 300 ms in turn: 600, 900, 1200.
    const results = await Promise.allSettled([client.query('SELECT pg_sleep(3)'), client.query('SELECT 1'), client.query('SELECT 2'), client.query('SELECT 3')]);
    const took = Date.now() - started;
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected', 'rejected', 'rejected']);
    for (const result of results) assert.equal(((result as PromiseRejectedResult).reason as Error).message, 'Query read timeout');
    assert.ok(took < 700, `all four failed together, after about one timeout (${took} ms)`);
  } finally {
    client.release(true);
    await quick.pool.end();
  }
});

test('a COMMIT slower than the read timeout is waited for: what it stored is reported stored, not failed (#1389)', { timeout: 15_000 }, async () => {
  // A commit that takes a second on the server (a deferred trigger sleeps in it), against a 300 ms read timeout. Given up at 300 ms, the
  // server committed anyway and the caller was told the write failed, as the API answered 500 for stored messages on a slow CI database.
  const quick = createDatabase(connectionString, undefined, { onError: () => undefined, queryTimeoutMs: 300 });
  const table = `slow_commit_${process.pid}_${Date.now()}`;
  await database.pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
  await database.pool.query(`CREATE FUNCTION ${table}_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`);
  await database.pool.query(`CREATE CONSTRAINT TRIGGER ${table}_at_commit AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${table}_wait()`);
  try {
    const started = Date.now();
    const stored = await quick.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`INSERT INTO ${table} VALUES (1)`));
      return 'stored';
    });
    const took = Date.now() - started;
    assert.equal(stored, 'stored', 'the transaction reports what it stored');
    assert.ok(took >= 900, `the commit itself took the second (${took} ms), longer than the 300 ms read timeout`);
    assert.equal((await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
    assert.equal(quick.pool.totalCount, 1, 'its client is healthy and back in the pool');
    assert.equal(quick.pool.idleCount, 1);
    // Every other statement keeps the short read timeout.
    await assert.rejects(quick.pool.connect().then(async (client) => {
      try { await client.query('SELECT pg_sleep(1)'); } finally { client.release(true); }
    }), /Query read timeout/);
  } finally {
    await quick.pool.end();
    await database.pool.query(`DROP TABLE ${table}`);
    await database.pool.query(`DROP FUNCTION ${table}_wait()`);
  }
});

test('control: asking pg directly, past the wrapper, makes it warn, so the checks above could have failed', async () => {
  const client = await database.pool.connect();
  try {
    // The instance's `query` is the wrapper; the prototype's is pg's own.
    const direct = (text: string) => (Object.getPrototypeOf(client) as { query: (text: string) => Promise<unknown> }).query.call(client, text);
    // pg warns when a statement finds others already waiting, so the third one is what it objects to.
    await Promise.all([direct('SELECT 1'), direct('SELECT 2'), direct('SELECT 3')]);
  } finally { client.release(); }
  await settle();
  assert.equal(warnings.length, 1);
});
