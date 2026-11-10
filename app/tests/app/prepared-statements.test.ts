import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executePrepared, sql } from '@flux/db';
import { db } from './support/db.js';

// #1178: the work reads' heaviest statements are named prepared statements, so a connection plans each one a few times and then reuses a
// generic plan. One name per text, reused on the connection, and the same rows as the unnamed statement.
test('a prepared statement is planned once per connection under one name and answers as the unnamed one does', async () => {
  const query = (ids: string[]) => sql`SELECT count(*)::int AS n, ${'fixed'}::text AS label FROM unnest(${sql.param(ids)}::uuid[]) AS id`;
  await db.transaction(async (tx) => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const unnamed = (await tx.execute<{ n: number; label: string }>(query(ids))).rows;
    for (let run = 0; run < 7; run++) {
      // A different number of ids is the same text: an array is one parameter.
      const rows = (await executePrepared<{ n: number; label: string }>(tx, query(run % 2 ? ids : ids.slice(0, 1)))).rows;
      assert.deepEqual(rows, [{ n: run % 2 ? 2 : 1, label: 'fixed' }]);
    }
    assert.deepEqual((await executePrepared<{ n: number; label: string }>(tx, query(ids))).rows, unnamed);
    const prepared = (await tx.execute<{ name: string; runs: number }>(sql`SELECT name, (generic_plans + custom_plans)::int AS runs
      FROM pg_prepared_statements WHERE statement LIKE '%unnest(%::uuid[]) AS id%' AND name LIKE 'flux\\_%'`)).rows;
    assert.equal(prepared.length, 1, 'one statement on this connection, whatever the number of ids');
    assert.equal(prepared[0]!.runs, 8);
  });
});
