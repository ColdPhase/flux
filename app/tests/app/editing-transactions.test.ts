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
