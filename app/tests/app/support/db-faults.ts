import type { Pool } from 'pg';

/**
 * A fault in the database for one row only, to follow what a drain does when its work fails every time. `when` is the trigger's WHEN
 * condition (name the row: `OLD.id = '…'`), `body` the PL/pgSql that runs when it holds (it raises, or decides by what it reads); the
 * trigger returns NEW otherwise. The fault is always removed, whatever `run` does.
 */
export async function withFault(pool: Pick<Pool, 'query'>, fault: { name: string; table: string; on?: 'INSERT' | 'UPDATE'; when: string; body: string }, run: () => Promise<void>) {
  const event = fault.on ?? 'UPDATE';
  await pool.query(`CREATE FUNCTION ${fault.name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${fault.body} RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${fault.name} BEFORE ${event} ON ${fault.table} FOR EACH ROW WHEN (${fault.when}) EXECUTE FUNCTION ${fault.name}()`);
  try { await run(); } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${fault.name} ON ${fault.table}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${fault.name}()`);
  }
}

/** The tries of an event are brought forward (they wait 1, 4, 9 and 16 seconds); each try is one a drain makes. Returns where the event stands. */
export async function eventNow(pool: Pick<Pool, 'query'>, where: { workId?: string; runId?: string; kind: string }) {
  const column = where.runId ? 'run_id' : 'work_id';
  const value = where.runId ?? where.workId;
  await pool.query(`UPDATE agent_task_events SET next_try_at = now() WHERE ${column} = $1 AND kind = $2 AND handled_at IS NULL`, [value, where.kind]);
  await pool.query(`SELECT pg_notify('flux_agent_tasks', '')`);
  return (await pool.query(`SELECT attempts, handled_at FROM agent_task_events WHERE ${column} = $1 AND kind = $2`, [value, where.kind])).rows[0] as { attempts: number; handled_at: Date | null };
}
