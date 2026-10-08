import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';

// #347: the Agents view reads each connection's latest completed action in a project. Migration 0062 indexes
// agent_command_receipts for that read (it had only its primary key); the index holds no data and reverses freely.
const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());

test('0062 indexes the receipts the Agents view reads for last activity', async () => {
  const { rows } = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'agent_command_receipts' AND indexname = 'agent_command_receipts_activity_idx'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.indexdef, /\(connection_id, project_id, completed_at DESC\)/);
});

test('0062 reverses by dropping only the index', async () => {
  const down = await readFile('packages/db/migrations/reverse/0062_agent_receipts_activity_index.down.sql', 'utf8');
  assert.match(down, /DROP INDEX IF EXISTS agent_command_receipts_activity_idx;/);
  assert.doesNotMatch(down, /DROP TABLE|DELETE|TRUNCATE/i);
});
