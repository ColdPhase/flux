import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NamedPrincipal, PrincipalRef, ThoughtTaskRow, WorkRowProjection } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { workRows } from './work.js';
import { nativeWorkObjectRows } from './work-read-objects.js';
import { nativeWorkEndpointVisible } from './work-read-visibility.js';

const w = schema.projectWorkItems;
const WINDOW = 100;

/**
 * Tasks linked to selected thoughts of this project's project sketches (#170/#196). Thoughts
 * are checked structurally (central project.read is the caller's); a missing, foreign,
 * private or DM thought is simply not visible. Exact counts are scalars; pairs and rows are one
 * global window of at most 100. No project collection or link list leaves the database.
 */
export function nativeWorkThoughtRows(db: DbExecutor) {
  const selected = (thoughtIds: readonly string[]) => {
    if (thoughtIds.length < 1 || thoughtIds.length > 100) throw new Error('Invalid native thought window');
    return sql.join(thoughtIds.map((id) => sql`(${id}::uuid)`), sql`, `);
  };
  async function visible(projectId: string, thoughtIds: readonly string[]): Promise<string[]> {
    // The endpoint predicate uses its own aliases (t, s); the selection is `g`, as elsewhere.
    const result = await db.execute<{ id: string }>(sql`WITH sel(id) AS (VALUES ${selected(thoughtIds)})
      SELECT g.id::text AS id FROM sel g WHERE (${nativeWorkEndpointVisible(projectId, sql`'thought'`, sql`g.id`)})
      ORDER BY g.id::text COLLATE "C"`);
    return result.rows.map((row) => row.id);
  }
  return {
    visible,
    async observe(projectId: string, thoughtIds: readonly string[]) {
      const thoughts = await visible(projectId, thoughtIds);
      if (!thoughts.length) return { visible: thoughts, counts: [], links: [], linkTotal: 0, items: [] as ThoughtTaskRow[] };
      const pairs = sql`WITH thoughts(id) AS (VALUES ${selected(thoughts)}), pairs AS (
        SELECT DISTINCT e.to_id::text AS thought_id, o.id::text AS work_id, (o.parked_at IS NOT NULL AND o.parked_by_decision_id IS NOT NULL) AS parked,
          CASE o.status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'open' THEN 2 WHEN 'done' THEN 3 ELSE 4 END AS status_rank, o.created_at
        FROM project_object_links e JOIN thoughts t ON t.id = e.to_id
        JOIN project_work_items o ON o.project_id = ${projectId}::uuid AND o.id = e.from_id
        WHERE e.project_id = ${projectId}::uuid AND e.from_type = 'work' AND e.to_type = 'thought')`;
      const counts = await db.execute<{ thoughtId: string; tasks: number }>(sql`${pairs}
        SELECT thought_id AS "thoughtId", count(*)::int AS tasks FROM pairs GROUP BY thought_id ORDER BY thought_id COLLATE "C"`);
      const links = await db.execute<{ thoughtId: string; workId: string }>(sql`${pairs}
        SELECT thought_id AS "thoughtId", work_id AS "workId" FROM pairs
        ORDER BY thought_id COLLATE "C", parked, status_rank, created_at, work_id COLLATE "C" LIMIT ${WINDOW}`);
      const workIds = [...new Set(links.rows.map((link) => link.workId))];
      const rows = await nativeWorkObjectRows(db).rows(projectId, workIds.map((id) => ({ kind: 'work' as const, id })));
      const creators = workIds.length ? await db.select({ id: w.id, kind: w.createdByKind, by: w.createdById }).from(w).where(and(eq(w.projectId, projectId), inArray(w.id, workIds))) : [];
      const refs: PrincipalRef[] = creators.map((creator) => ({ kind: creator.kind, id: creator.by }));
      const names = await workRows(db).names(refs);
      const named = (ref: PrincipalRef): NamedPrincipal => ({ ...ref, name: names.get(`${ref.kind}:${ref.id}`) ?? (ref.kind === 'agent' ? 'Agent' : 'Former member') });
      const items = rows.map((row) => {
        const creator = creators.find((entry) => entry.id === row.id);
        if (!creator || row.kind !== 'work') throw new Error('Missing native task creator');
        return { ...(row as WorkRowProjection), createdBy: named({ kind: creator.kind, id: creator.by }) };
      });
      return { visible: thoughts, counts: counts.rows, links: links.rows, linkTotal: counts.rows.reduce((sum, entry) => sum + entry.tasks, 0), items };
    },
  };
}
