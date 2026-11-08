import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { afterDeadlock, isDeadlock, sql } from '@flux/db';
import { db } from './support/db.js';

// #1052: a transaction PostgreSQL cancels to break a deadlock (SQLSTATE 40P01) is run once more by the commands that opt in, a space's delete among them.
// Nothing else is retried, and not more than once.

describe('afterDeadlock', () => {
  const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

  test('a deadlock victim is recognised through the layers that wrap the driver\'s error; other failures are not', () => {
    assert.equal(isDeadlock(deadlock()), true);
    assert.equal(isDeadlock(Object.assign(new Error('Failed query'), { cause: deadlock() })), true);
    assert.equal(isDeadlock(Object.assign(new Error('a'), { cause: Object.assign(new Error('b'), { cause: deadlock() }) })), true);
    for (const other of [new Error('plain'), Object.assign(new Error('unique'), { code: '23505' }), Object.assign(new Error('serialization'), { code: '40001' }), null, undefined, 'text'])
      assert.equal(isDeadlock(other), false);
  });

  test('it runs the attempt once more after a deadlock, and no more than once; any other failure is the caller\'s at once', async () => {
    let runs = 0;
    assert.equal(await afterDeadlock(async () => { runs += 1; if (runs === 1) throw deadlock(); return 'done'; }), 'done');
    assert.equal(runs, 2);

    runs = 0;
    await assert.rejects(afterDeadlock(async () => { runs += 1; throw deadlock(); }), { code: '40P01' });
    assert.equal(runs, 2, 'a second deadlock is not retried again');

    runs = 0;
    await assert.rejects(afterDeadlock(async () => { runs += 1; throw new Error('boom'); }), /boom/);
    assert.equal(runs, 1);
  });

  test('two real transactions that lock two rows in opposite order: PostgreSQL cancels one, and the retry lets both finish', async () => {
    const table = sql.raw(`deadlock_probe_${randomUUID().replace(/-/g, '')}`);
    await db.execute(sql`CREATE TABLE ${table} (id int PRIMARY KEY, n int NOT NULL DEFAULT 0)`);
    try {
      await db.execute(sql`INSERT INTO ${table} (id) VALUES (1), (2)`);
      let started = 0;
      let held = 0;
      let bothHold!: () => void;
      const barrier = new Promise<void>((resolve) => { bothHold = resolve; });
      const lock = (first: number, second: number) => afterDeadlock(() => db.transaction(async (tx) => {
        const attempt = (started += 1);
        await tx.execute(sql`UPDATE ${table} SET n = n + 1 WHERE id = ${first}`);
        // In the first round each holds its row before either asks for the other's: that is the deadlock. A retry (the third attempt) does not wait.
        if (attempt <= 2) { held += 1; if (held === 2) bothHold(); await barrier; }
        await tx.execute(sql`UPDATE ${table} SET n = n + 1 WHERE id = ${second}`);
      }));
      await Promise.all([lock(1, 2), lock(2, 1)]);
      assert.equal(started, 3, 'two transactions and one retry of the cancelled one');
      const rows = (await db.execute(sql`SELECT id, n FROM ${table} ORDER BY id`)).rows;
      assert.deepEqual(rows.map((row) => [row.id, row.n]), [[1, 2], [2, 2]], 'both transactions applied, once each');
    } finally {
      await db.execute(sql`DROP TABLE ${table}`);
    }
  });
});
