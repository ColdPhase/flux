import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pool } from './support/db.js';

// 0108 (F-027 A4, #404): the owner's lane knows what started a run. The forward and the reverse file are each one transaction; the round
// trip runs inside a transaction that is rolled back, so the shared test database keeps its shape.

const directory = 'packages/db/migrations';

test('0108: the reverse drops the lane columns and the forward restores them; a background run needs its name and an owner request has none', async () => {
  const client = await pool.connect();
  const columns = async () => (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'personal_runs'
    AND column_name IN ('authority', 'background_label') ORDER BY column_name`)).rows.map((row) => row.column_name as string);
  try {
    await client.query('BEGIN');
    assert.deepEqual(await columns(), ['authority', 'background_label']);
    await client.query(await readFile(join(directory, 'reverse/0108_assistant_run_authority.down.sql'), 'utf8'));
    assert.deepEqual(await columns(), [], 'a rollback forgets what started a run');
    await client.query(await readFile(join(directory, '0108_assistant_run_authority.sql'), 'utf8'));
    assert.deepEqual(await columns(), ['authority', 'background_label']);
    const [existing] = (await client.query(`SELECT id FROM personal_runs LIMIT 1`)).rows as { id: string }[];
    if (existing) {
      await client.query('SAVEPOINT label');
      await assert.rejects(client.query(`UPDATE personal_runs SET authority = 'owner_schedule' WHERE id = $1`, [existing.id]), /personal_runs_authority_label_check/);
      await client.query('ROLLBACK TO SAVEPOINT label');
      await assert.rejects(client.query(`UPDATE personal_runs SET authority = 'owner_request', background_label = 'Morning summary' WHERE id = $1`, [existing.id]), /personal_runs_authority_label_check/);
      await client.query('ROLLBACK TO SAVEPOINT label');
      await client.query(`UPDATE personal_runs SET authority = 'owner_schedule', background_label = 'Morning summary' WHERE id = $1`, [existing.id]);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
