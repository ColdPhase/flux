import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

export interface ComparisonSourceRef { type: string; id: string; version: number | null; sketchId?: string }
export const COMPARISON_CONTEXT_LIMITS = { materials: 6, messages: 12, work: 8, positiveResults: 4, thoughts: 8, excerptCharacters: 2_000 } as const;
const m = schema.projectMaterials;
const v = schema.projectMaterialVersions;
const messages = schema.projectMessages;
const w = schema.projectWorkItems;
const r = schema.projectResults;
const users = schema.authUsers;
const t = schema.sketchThoughts;
const s = schema.sketches;
const humanThought = and(isNull(t.placementType), isNull(t.placementId), isNull(t.createdByAgentId),
  sql`${t.createdByUserId} IS NOT NULL`,
  sql`NOT EXISTS (SELECT 1 FROM ${schema.events} e WHERE e.object_id = ${t.sketchId}
    AND e.kind = 'sketch.changed.v1' AND e.data->>'op' IN ('thought_added', 'thought_updated')
    AND e.data->'thoughtIds' @> jsonb_build_array(${t.id}::text) AND e.actor_id LIKE 'agent:%')`);

// A work item made from this agent's earlier proposal or changed by an agent is not evidence.
const humanWork = and(eq(w.createdByKind, 'human'),
  sql`NOT EXISTS (SELECT 1 FROM ${schema.proactiveComparisonProposals} p WHERE p.used_work_id = ${w.id})`,
  sql`NOT EXISTS (SELECT 1 FROM ${schema.events} e WHERE e.object_id = ${w.projectId}
    AND e.kind IN ('project.work_created.v1', 'project.work_updated.v1')
    AND e.data->>'workId' = ${w.id}::text AND e.actor_id LIKE 'agent:%')`);

/** Metadata only. Callers must check current project access before selecting or reading content. */
export function comparisonSources(db: DbExecutor) {
  async function current(projectId: string, source: ComparisonSourceRef, lock = false): Promise<boolean> {
    if (source.type === 'material') {
      const query = db.select({ id: m.id }).from(m).innerJoin(v, and(eq(v.materialId, m.id), eq(v.version, m.currentVersion)))
        .innerJoin(users, eq(users.id, v.authorId)).where(and(eq(m.projectId, projectId), eq(m.id, source.id),
          eq(m.currentVersion, source.version ?? -1), or(isNull(v.state), eq(v.state, 'published'))));
      return (await (lock ? query.for('share') : query)).length === 1;
    }
    if (source.type === 'message') {
      if (source.version !== 1) return false;
      const query = db.select({ id: messages.id }).from(messages).innerJoin(users, eq(users.id, messages.authorId))
        .where(and(eq(messages.projectId, projectId), eq(messages.id, source.id)));
      return (await (lock ? query.for('share') : query)).length === 1;
    }
    if (source.type === 'result') {
      if (source.version !== 1) return false;
      const query = db.select({ id: r.id }).from(r).where(and(eq(r.projectId, projectId), eq(r.id, source.id), eq(r.createdByKind, 'human')));
      return (await (lock ? query.for('share') : query)).length === 1;
    }
    if (source.type === 'work') {
      const query = db.select({ id: w.id }).from(w).where(and(eq(w.projectId, projectId), eq(w.id, source.id),
        eq(w.version, source.version ?? -1), humanWork));
      return (await (lock ? query.for('share') : query)).length === 1;
    }
    if (source.type === 'thought') {
      if (!source.sketchId) return false;
      const query = db.select({ id: t.id }).from(t).innerJoin(s, eq(s.id, t.sketchId))
        .where(and(eq(s.scope, 'project'), eq(s.projectId, projectId), eq(t.id, source.id),
          eq(t.sketchId, source.sketchId), eq(t.version, source.version ?? -1), humanThought));
      return (await (lock ? query.for('share') : query)).length === 1;
    }
    return false;
  }

  return {
    current,
    async snapshot(resultId: string, ruleId: string) {
      const [rule] = await db.select({ id: schema.proactiveComparisonRules.id, version: schema.proactiveComparisonRules.version,
        ownerId: schema.proactiveComparisonRules.ownerUserId, projectId: schema.proactiveComparisonRules.projectId })
        .from(schema.proactiveComparisonRules).where(eq(schema.proactiveComparisonRules.id, ruleId));
      if (!rule) return { sources: [] as ComparisonSourceRef[], fingerprint: '', ruleVersion: null };
      const links = await db.select({ type: schema.projectObjectLinks.toType, id: schema.projectObjectLinks.toId,
        version: schema.projectObjectLinks.toVersion }).from(schema.projectObjectLinks)
        .where(and(eq(schema.projectObjectLinks.projectId, rule.projectId), eq(schema.projectObjectLinks.fromType, 'result'),
          eq(schema.projectObjectLinks.fromId, resultId), eq(schema.projectObjectLinks.role, 'source')));
      const explicit: ComparisonSourceRef[] = [];
      for (const link of links) {
        if (link.type !== 'thought') {
          explicit.push({ ...link, version: link.type === 'message' || link.type === 'result' ? 1 : link.version });
          continue;
        }
        const [thought] = await db.select({ version: t.version, sketchId: t.sketchId }).from(t).innerJoin(s, eq(s.id, t.sketchId))
          .where(and(eq(t.id, link.id), eq(s.scope, 'project'), eq(s.projectId, rule.projectId), humanThought));
        explicit.push({ type: 'thought', id: link.id, version: thought?.version ?? null, ...(thought ? { sketchId: thought.sketchId } : {}) });
      }
      const materials = await db.select({ id: m.id, version: m.currentVersion }).from(m)
        .innerJoin(v, and(eq(v.materialId, m.id), eq(v.version, m.currentVersion))).innerJoin(users, eq(users.id, v.authorId))
        .where(and(eq(m.projectId, rule.projectId), or(isNull(v.state), eq(v.state, 'published'))))
        .orderBy(desc(m.updatedAt), asc(m.id)).limit(COMPARISON_CONTEXT_LIMITS.materials);
      const conversation = await db.select({ id: messages.id }).from(messages).innerJoin(users, eq(users.id, messages.authorId))
        .where(eq(messages.projectId, rule.projectId)).orderBy(desc(messages.createdAt), asc(messages.id)).limit(COMPARISON_CONTEXT_LIMITS.messages);
      const work = await db.select({ id: w.id, version: w.version }).from(w).where(and(eq(w.projectId, rule.projectId), humanWork))
        .orderBy(desc(w.updatedAt), asc(w.id)).limit(COMPARISON_CONTEXT_LIMITS.work);
      const benchmarks = await db.select({ id: r.id }).from(r).where(and(eq(r.projectId, rule.projectId), eq(r.createdByKind, 'human'), eq(r.finding, 'positive')))
        .orderBy(desc(r.createdAt), asc(r.id)).limit(COMPARISON_CONTEXT_LIMITS.positiveResults);
      const thoughts = await db.select({ id: t.id, version: t.version, sketchId: t.sketchId }).from(t).innerJoin(s, eq(s.id, t.sketchId))
        .where(and(eq(s.scope, 'project'), eq(s.projectId, rule.projectId), humanThought))
        .orderBy(desc(t.updatedAt), asc(t.id)).limit(COMPARISON_CONTEXT_LIMITS.thoughts);
      const selected: ComparisonSourceRef[] = [
        { type: 'result', id: resultId, version: 1 }, ...explicit,
        ...materials.map((row) => ({ type: 'material', ...row })),
        ...conversation.map((row) => ({ type: 'message', ...row, version: 1 })),
        ...work.map((row) => ({ type: 'work', ...row })),
        ...benchmarks.map((row) => ({ type: 'result', ...row, version: 1 })),
        ...thoughts.map((row) => ({ type: 'thought', ...row })),
      ];
      const sourceKey = (source: ComparisonSourceRef) => `${source.type}:${source.id}:${source.version}:${source.sketchId ?? ''}`;
      const sorted = [...new Map(selected.map((source) => [sourceKey(source), source])).values()]
        .sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
      const fingerprint = createHash('sha256').update(JSON.stringify({ ruleId: rule.id, ruleVersion: rule.version,
        ownerId: rule.ownerId, sources: sorted, explicit: [...explicit].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))) })).digest('hex');
      // The provider/validator receive the trigger first; fingerprint order is independent of it.
      return { sources: [{ type: 'result', id: resultId, version: 1 }, ...sorted.filter((source) => source.type !== 'result' || source.id !== resultId)], fingerprint, ruleVersion: rule.version };
    },
  };
}
