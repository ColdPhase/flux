import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';

// #347: the Agents view reads each connection's latest completed action in a project; the schema indexes
// agent_command_receipts for that read.
const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());

test('the schema indexes the receipts the Agents view reads for last activity', async () => {
  const { rows } = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'agent_command_receipts' AND indexname = 'agent_command_receipts_activity_idx'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.indexdef, /\(connection_id, project_id, completed_at DESC\)/);
});
