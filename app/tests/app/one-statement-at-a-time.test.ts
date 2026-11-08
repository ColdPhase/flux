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
