import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { TaskUseRefusal, type TaskUseMemory } from './task-use.js';

/**
 * Closed display projections only. `_chargeBytes` is the total UTF-8 size of
 * variable text on each row. The outer command owns SQL/rows/refs/maps and both
 * escaped JSON and response copies until its transaction/response has settled.
 * Nothing here locks a task, resolves authority, or marks a persisted use.
 */
export async function workProjection<Row>(db: DbExecutor, memory: TaskUseMemory, projection: SQL, order?: SQL): Promise<Row[]> {
  const countProjection = sql`SELECT count(*)::text AS count,
    COALESCE(sum("_chargeBytes"), 0)::text AS bytes FROM (${projection}) work_projection`;
  const measured = (await db.execute<{ count: string; bytes: string }>(countProjection)).rows[0]!;
  const count = Number(measured.count); const bytes = Number(measured.bytes);
  const charge = 8192 + (count + 1) * 8192 + bytes * 48;
  if (![count, bytes, charge].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
  // Reserve BEFORE any complete projection transfer. 8KiB/row covers driver
  // rows, typed refs, project/title Maps, derived links and query continuations;
  // 48/UTF-8 byte covers escaped wire, parsed strings and serialized response.
  memory.reserve(charge);
  const [loaded] = (await db.execute<{ rows: Row[] | null }>(sql`
    WITH work_projection AS MATERIALIZED (${projection}),
    work_projection_size AS (SELECT count(*) AS count,
      COALESCE(sum("_chargeBytes"), 0) AS bytes FROM work_projection)
    SELECT CASE WHEN count <= ${count} AND bytes <= ${bytes} THEN
      (SELECT COALESCE(jsonb_agg(to_jsonb(bounded) - '_chargeBytes' ${order ? sql`ORDER BY ${order}` : sql``}), '[]'::jsonb)
       FROM (SELECT * FROM work_projection LIMIT ${count + 1}) bounded)
      ELSE NULL END AS rows FROM work_projection_size`)).rows;
  // The second snapshot gates JSON construction inside PostgreSQL. It cannot
  // transfer a newly expanded array/string first and check its size afterwards.
  if (!loaded || loaded.rows === null) throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
  return loaded.rows;
}
