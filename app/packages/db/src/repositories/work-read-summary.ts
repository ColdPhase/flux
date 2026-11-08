import { sql } from 'drizzle-orm';
import type { PrincipalRef, ProjectWorkSummary, WorkCounts } from '@flux/contracts';
import type { DbExecutor } from './push.js';
import { nativeWorkViewKeySource } from './work-read-keys.js';

const groupByRank = ['needs', 'in_progress', 'blocked', 'open', 'parked', 'finished', 'rules', 'rules', 'results'] as const;

export function nativeWorkSummaryRows(db: DbExecutor) {
  const observedAt = async () => {
    const result = await db.execute<{ at: string }>(sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
    if (!result.rows[0]?.at) throw new Error('Missing native observation timestamp');
    return result.rows[0].at;
  };
  async function counts(projectId: string, caller: PrincipalRef, mine: boolean): Promise<WorkCounts> {
    const selected = nativeWorkViewKeySource(projectId, caller, { purpose: 'tasks', group: 'all', mine });
    const result = await db.execute<{ rank: number; total: number }>(sql`WITH selected AS (${selected}) SELECT rank, count(*)::int AS total FROM selected GROUP BY rank`);
    const counts: WorkCounts = { needs: 0, in_progress: 0, blocked: 0, open: 0, parked: 0, finished: 0, rules: 0, results: 0 };
    for (const row of result.rows) {
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
      const at = await observedAt();
      const all = await counts(projectId, actor, false), mine = await counts(projectId, actor, true);
      return { projectId, observedAt: at, all, mine, workTotal: all.in_progress + all.blocked + all.open + all.parked + all.finished,
        unfinishedTotal: all.in_progress + all.blocked + all.open };
    },
  };
}
