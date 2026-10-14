import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PrincipalRef, ProjectWorkSummary, WorkCounts, WorkReadRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { nativeWorkViewKeySource } from './work-read-keys.js';
import { workRows } from './work.js';

const w = schema.projectWorkItems, d = schema.projectDecisions, r = schema.projectResults;
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
  async function firstWork(projectId: string, status: 'in_progress' | 'blocked' | 'open'): Promise<WorkReadRef | null> {
    const [row] = await db.select({ id: w.id, title: w.title }).from(w).where(and(eq(w.projectId, projectId), eq(w.status, status), isNull(w.parkedAt), isNull(w.creationRevertedAt))).orderBy(desc(w.createdAt), desc(w.id)).limit(1);
    return row ? { kind: 'work', ...row } : null;
  }
  return {
    observedAt,
    async summary(projectId: string, caller: PrincipalRef): Promise<Omit<ProjectWorkSummary, 'access'>> {
      const actor = { ...caller };
      const at = await observedAt();
      const all = await counts(projectId, actor, false), mine = await counts(projectId, actor, true);
      const [rule] = await db.select({ id: d.id, title: d.title }).from(d).where(and(eq(d.projectId, projectId), eq(d.status, 'accepted'))).orderBy(desc(d.createdAt), desc(d.id)).limit(1);
      const [proposal] = await db.select({ id: d.id, title: d.title }).from(d).where(and(eq(d.projectId, projectId), eq(d.status, 'proposed'))).orderBy(desc(d.createdAt), desc(d.id)).limit(1);
      const [result] = await db.select({ id: r.id, title: r.title, finding: r.finding }).from(r).where(eq(r.projectId, projectId)).orderBy(desc(r.createdAt), desc(r.id)).limit(1);
      const activeFirst = await firstWork(projectId, 'in_progress'), blockedFirst = await firstWork(projectId, 'blocked');
      const openFirst = await firstWork(projectId, 'open');
      const historyCounts = await db.execute<{ completed: number; not_pursued: number; parked: number }>(sql`SELECT
        count(*) FILTER (WHERE status = 'done' AND parked_at IS NULL)::int AS completed,
        count(*) FILTER (WHERE status = 'not_pursued' AND parked_at IS NULL)::int AS not_pursued,
        count(*) FILTER (WHERE parked_at IS NOT NULL)::int AS parked
        FROM project_work_items WHERE project_id = ${projectId}::uuid AND creation_reverted_at IS NULL`);
      const [historyWork] = await db.select({ id: w.id, title: w.title }).from(w).where(and(eq(w.projectId, projectId), isNull(w.creationRevertedAt))).orderBy(desc(w.createdAt), desc(w.id)).limit(1);
      const [historyDecision] = await db.select({ id: d.id, title: d.title }).from(d).where(eq(d.projectId, projectId)).orderBy(desc(d.createdAt), desc(d.id)).limit(1);
      const decisionTotal = await db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM project_decisions WHERE project_id = ${projectId}::uuid`);
      const history = historyCounts.rows[0];
      if (!history || !decisionTotal.rows[0]) throw new Error('Missing native history counts');
      const ownerScope = sql`SELECT DISTINCT CASE WHEN owner_user_id IS NOT NULL THEN 'human' ELSE 'agent' END AS kind,
        coalesce(owner_user_id, owner_agent_id::text) AS id FROM project_work_items WHERE project_id = ${projectId}::uuid AND status = 'in_progress'
        AND parked_at IS NULL AND creation_reverted_at IS NULL AND (owner_user_id IS NOT NULL OR owner_agent_id IS NOT NULL)`;
      const owners = await db.execute<PrincipalRef>(sql`WITH owners AS (${ownerScope}) SELECT kind, id FROM owners ORDER BY kind, id LIMIT 3`);
      const total = await db.execute<{ total: number }>(sql`WITH owners AS (${ownerScope}) SELECT count(*)::int AS total FROM owners`);
      if (!total.rows[0]) throw new Error('Missing native owner count');
      const names = await workRows(db).names(owners.rows);
      return { projectId, observedAt: at, all, mine, workTotal: all.in_progress + all.blocked + all.open + all.parked + all.finished,
        unfinishedTotal: all.in_progress + all.blocked + all.open,
        state: { rule: rule ? { kind: 'decision', ...rule } : null, proposal: proposal ? { kind: 'decision', ...proposal } : null,
          active: { count: all.in_progress, first: activeFirst, ownerTotal: total.rows[0].total,
            owners: owners.rows.map((owner) => ({ ...owner, name: names.get(`${owner.kind}:${owner.id}`) ?? (owner.kind === 'agent' ? 'Agent' : 'Former member') })) },
          blocked: { count: all.blocked, first: blockedFirst }, open: { count: all.open, first: openFirst },
          history: { completed: history.completed, notPursued: history.not_pursued, parked: history.parked,
            firstWork: historyWork ? { kind: 'work', ...historyWork } : null, decisionCount: decisionTotal.rows[0].total,
            firstDecision: historyDecision ? { kind: 'decision', ...historyDecision } : null },
          result: result ? { kind: 'result', ...result } : null } };
    },
  };
}
