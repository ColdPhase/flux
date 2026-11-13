import { sql } from 'drizzle-orm';
import type { PrincipalRef, ProjectWorkSummary, WorkCounts } from '@flux/contracts';
import type { DbExecutor } from './push.js';
import { nativeWorkViewKeySource } from './work-read-keys.js';

const groupByRank = ['needs', 'in_progress', 'blocked', 'open', 'finished', 'rules', 'rules'] as const;

export function nativeWorkSummaryRows(db: DbExecutor) {
  const observedAt = async () => {
    const result = await db.execute<{ at: string }>(sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
    if (!result.rows[0]?.at) throw new Error('Missing native observation timestamp');
    return result.rows[0].at;
  };
  /** Both groups' counts (everyone's and the reader's own) and the observation time in one statement (#1429; were three). */
  async function counted(projectId: string, caller: PrincipalRef) {
    const all = nativeWorkViewKeySource(projectId, caller, { purpose: 'tasks', group: 'all', mine: false });
    const mine = nativeWorkViewKeySource(projectId, caller, { purpose: 'tasks', group: 'all', mine: true });
    const result = await db.execute<{ at: string; all: { rank: number; total: number }[] | null; mine: { rank: number; total: number }[] | null }>(sql`WITH a AS (${all}), m AS (${mine})
      SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        (SELECT json_agg(json_build_object('rank', rank, 'total', total)) FROM (SELECT rank, count(*)::int AS total FROM a GROUP BY rank) g) AS "all",
        (SELECT json_agg(json_build_object('rank', rank, 'total', total)) FROM (SELECT rank, count(*)::int AS total FROM m GROUP BY rank) g) AS mine`);
    const row = result.rows[0];
    if (!row?.at) throw new Error('Missing native observation timestamp');
    return { at: row.at, all: counts(row.all ?? []), mine: counts(row.mine ?? []) };
  }
  function counts(rows: readonly { rank: number; total: number }[]): WorkCounts {
    const counts: WorkCounts = { needs: 0, in_progress: 0, blocked: 0, open: 0, finished: 0, rules: 0 };
    for (const row of rows) {
      const group = groupByRank[row.rank];
      if (!group || !Number.isSafeInteger(row.total) || row.total < 0) throw new Error('Invalid native work group count');
      counts[group] += row.total;
    }
    return counts;
  }
  return {
    observedAt,
    async summary(projectId: string, caller: PrincipalRef): Promise<Omit<ProjectWorkSummary, 'access'>> {
      const actor = { ...caller };
      const { at, all, mine } = await counted(projectId, actor);
      return { projectId, observedAt: at, all, mine, workTotal: all.in_progress + all.blocked + all.open + all.finished,
        unfinishedTotal: all.in_progress + all.blocked + all.open };
    },
  };
}
