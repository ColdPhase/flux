import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { comparisonSources } from './proactive-sources.js';

const cursor = schema.proactiveComparisonCursor;
const changes = schema.proactiveComparisonProjectChanges;
const rules = schema.proactiveComparisonRules;
const q = schema.proactiveComparisonOutbox;
type SourceEvent = { kind: string; actorId: string; objectId: string; data: Record<string, unknown> };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Durable scheduling metadata only. Source selection requires core policy composition. */
export function comparisonSchedulingRows(db: DbExecutor) {
  const selected = comparisonSources(db);
  return {
    events: {
      async lockCursor() {
        const [row] = await db.select({ seq: cursor.seq }).from(cursor).where(eq(cursor.id, 1)).for('update');
        if (!row) throw new Error('Comparison cursor is missing');
        return row.seq;
      },
      async retainedRange() {
        const [row] = await db.select({ first: sql<string | null>`min(${schema.events.seq})`, last: sql<string | null>`max(${schema.events.seq})` }).from(schema.events);
        return { first: row?.first === null || row?.first === undefined ? null : Number(row.first),
          last: row?.last === null || row?.last === undefined ? null : Number(row.last) };
      },
      async after(seq: number, limit: number) {
        const rows = await db.select({ seq: schema.events.seq, kind: schema.events.kind, actorId: schema.events.actorId,
          objectId: schema.events.objectId, data: schema.events.data }).from(schema.events)
          .where(gt(schema.events.seq, seq)).orderBy(asc(schema.events.seq)).limit(limit);
        return rows.map((row) => ({ ...row, data: row.data && typeof row.data === 'object' && !Array.isArray(row.data)
          ? row.data as Record<string, unknown> : {} }));
      },
      async storeCursor(seq: number) { await db.update(cursor).set({ seq }).where(eq(cursor.id, 1)); },
    },
    projects: {
      async enabledAfter(after: string | null, limit: number) {
        const rows = await db.selectDistinct({ projectId: rules.projectId }).from(rules)
          .where(and(eq(rules.status, 'enabled'), after ? gt(rules.projectId, after) : undefined))
          .orderBy(asc(rules.projectId)).limit(limit);
        return rows.map((row) => row.projectId);
      },
      async forHumanSourceEvent(event: SourceEvent): Promise<string | null> {
        if (!event.actorId.startsWith('human:')) return null;
        if (event.kind === 'sketch.changed.v1') {
          const [sketch] = await db.select({ projectId: schema.sketches.projectId }).from(schema.sketches)
            .where(and(eq(schema.sketches.id, event.objectId), eq(schema.sketches.scope, 'project')));
          if (!sketch?.projectId) return null;
          if (event.data.op === 'thought_removed') return sketch.projectId;
          const ids = Array.isArray(event.data.thoughtIds) ? event.data.thoughtIds.filter(uuid) : [];
          for (const thoughtId of ids) {
            const [thought] = await db.select({ version: schema.sketchThoughts.version }).from(schema.sketchThoughts)
              .where(and(eq(schema.sketchThoughts.id, thoughtId), eq(schema.sketchThoughts.sketchId, event.objectId)));
            if (thought && await selected.current(sketch.projectId, { type: 'thought', id: thoughtId, version: thought.version, sketchId: event.objectId })) return sketch.projectId;
          }
          return null;
        }
        const projectId = event.objectId;
        if (event.kind === 'project.doc_created.v1' || event.kind === 'project.doc_updated.v1'
          || event.kind === 'project.material_created.v1' || event.kind === 'project.material_updated.v1') {
          const id = event.data.docId ?? event.data.materialId;
          const version = event.data.version;
          if (!uuid(id) || !Number.isSafeInteger(version) || Number(version) < 1) return null;
          const [row] = await db.select({ id: schema.projectMaterialVersions.materialId }).from(schema.projectMaterialVersions)
            .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.projectMaterialVersions.authorId))
            .where(and(eq(schema.projectMaterialVersions.materialId, id), eq(schema.projectMaterialVersions.projectId, projectId),
              eq(schema.projectMaterialVersions.version, Number(version)),
              sql`(${schema.projectMaterialVersions.state} IS NULL OR ${schema.projectMaterialVersions.state} = 'published')`));
          return row ? projectId : null;
        }
        if (event.kind === 'project.work_created.v1' || event.kind === 'project.work_updated.v1') {
          if (!uuid(event.data.workId)) return null;
          const [work] = await db.select({ version: schema.projectWorkItems.version }).from(schema.projectWorkItems)
            .where(and(eq(schema.projectWorkItems.id, event.data.workId), eq(schema.projectWorkItems.projectId, projectId)));
          return work && await selected.current(projectId, { type: 'work', id: event.data.workId, version: work.version }) ? projectId : null;
        }
        if (event.kind === 'project.conversation_created.v1' || event.kind === 'project.message_sent.v1') {
          if (!uuid(event.data.messageId)) return null;
          return await selected.current(projectId, { type: 'message', id: event.data.messageId, version: 1 }) ? projectId : null;
        }
        if (event.kind === 'project.result_recorded.v1') {
          if (!uuid(event.data.resultId)) return null;
          return await selected.current(projectId, { type: 'result', id: event.data.resultId, version: 1 }) ? projectId : null;
        }
        if (event.kind === 'project.link_created.v1') {
          if (!uuid(event.data.from)) return null;
          const [link] = await db.select({ id: schema.projectObjectLinks.id }).from(schema.projectObjectLinks)
            .where(and(eq(schema.projectObjectLinks.projectId, projectId), eq(schema.projectObjectLinks.fromId, event.data.from),
              eq(schema.projectObjectLinks.role, 'source'),
              sql`NOT EXISTS (SELECT 1 FROM ${schema.proactiveComparisonProposals} p WHERE p.used_work_id = ${schema.projectObjectLinks.fromId})`));
          return link ? projectId : null;
        }
        return null;
      },
    },
    changes: {
      async lockProject(projectId: string) {
        const [row] = await db.select().from(changes).where(eq(changes.projectId, projectId)).for('update');
        return row ?? null;
      },
      async save(window: { projectId: string; firstChangedAt: Date; lastChangedAt: Date; dueAt: Date }) {
        await db.insert(changes).values(window).onConflictDoUpdate({ target: changes.projectId,
          set: { firstChangedAt: window.firstChangedAt, lastChangedAt: window.lastChangedAt, dueAt: window.dueAt } });
      },
      async dueProjectIds(now: Date, limit: number) {
        const rows = await db.select({ projectId: changes.projectId }).from(changes)
          .where(lte(changes.dueAt, now)).orderBy(asc(changes.dueAt), asc(changes.projectId)).limit(limit);
        return rows.map((row) => row.projectId);
      },
      async remove(projectId: string) { await db.delete(changes).where(eq(changes.projectId, projectId)); },
    },
    rules: {
      async enabledForProject(projectId: string) {
        return db.select({ id: rules.id, ownerUserId: rules.ownerUserId, agentId: rules.agentId, projectId: rules.projectId }).from(rules)
          .where(and(eq(rules.projectId, projectId), eq(rules.status, 'enabled'))).orderBy(asc(rules.id)).for('share');
      },
    },
    sources: {
      async negativeResultsAfter(projectId: string, after: string | null, limit: number) {
        const rows = await db.select({ id: schema.projectResults.id }).from(schema.projectResults)
          .where(and(eq(schema.projectResults.projectId, projectId), eq(schema.projectResults.finding, 'negative'),
            eq(schema.projectResults.createdByKind, 'human'), after ? gt(schema.projectResults.id, after) : undefined))
          .orderBy(asc(schema.projectResults.id)).limit(limit);
        return rows.map((row) => row.id);
      },
      snapshot: selected.snapshot,
    },
    candidates: {
      async stopObsoleteQueued(ruleId: string, resultId: string, fingerprint: string) {
        const stopped = await db.update(q).set({ status: 'not_run', failureCode: 'SOURCE_CHANGED', reservedCents: 0,
          usageInputTokens: 0, usageOutputTokens: 0, usageEstimatedCents: 0, finishedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(q.ruleId, ruleId), eq(q.resultId, resultId), eq(q.status, 'queued'), sql`${q.sourceFingerprint} <> ${fingerprint}`))
          .returning({ id: q.id });
        return stopped.length;
      },
      async insert(input: { rule: { id: string; ownerUserId: string; projectId: string }; resultId: string; fingerprint: string; availableAfter: Date }) {
        const [row] = await db.insert(q).values({ id: randomUUID(), ruleId: input.rule.id, ownerUserId: input.rule.ownerUserId,
          projectId: input.rule.projectId, resultId: input.resultId, sourceFingerprint: input.fingerprint, availableAfter: input.availableAfter })
          .onConflictDoNothing().returning({ id: q.id });
        return !!row;
      },
    },
    /** A queued job must recheck this gate; a stale selected id does not bypass quiet time. */
    async ready(candidateId: string, now: Date) {
      const [row] = await db.select({ id: q.id }).from(q).where(and(eq(q.id, candidateId), eq(q.status, 'queued'), lte(q.availableAfter, now),
        sql`NOT EXISTS (SELECT 1 FROM ${changes} c WHERE c.project_id = ${q.projectId})`,
        sql`EXISTS (SELECT 1 FROM ${cursor} c WHERE c.id = 1 AND c.seq >= coalesce((SELECT max(e.seq) FROM ${schema.events} e), 0))`));
      return !!row;
    },
    async readyIds(now: Date, limit: number) {
      const rows = await db.select({ id: q.id }).from(q).where(and(eq(q.status, 'queued'), lte(q.availableAfter, now),
        sql`NOT EXISTS (SELECT 1 FROM ${changes} c WHERE c.project_id = ${q.projectId})`,
        sql`EXISTS (SELECT 1 FROM ${cursor} c WHERE c.id = 1 AND c.seq >= coalesce((SELECT max(e.seq) FROM ${schema.events} e), 0))`))
        .orderBy(asc(q.availableAfter), asc(q.id)).limit(limit);
      return rows.map((row) => row.id);
    },
  };
}
