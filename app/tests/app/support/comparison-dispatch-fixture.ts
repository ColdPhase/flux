import type { Pool } from 'pg';

/** Existing provider/access tests isolate dispatch, using a due, fully-collected fixture.
 * They do not prove scheduling. The scheduling suite uses the real cursor and fake clock.
 * Run DB tests serially because cursor-recovery fixtures own this global test cursor. */
export async function comparisonDispatchFixtureDue(pool: Pool, candidateId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT seq FROM proactive_comparison_cursor WHERE id=1 FOR UPDATE');
    await client.query('UPDATE proactive_comparison_cursor SET seq=coalesce((SELECT max(seq) FROM events),0) WHERE id=1');
    await client.query("UPDATE proactive_comparison_outbox SET available_after=now()-interval '1 second' WHERE id=$1", [candidateId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
