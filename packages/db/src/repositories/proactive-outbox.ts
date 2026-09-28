import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { workRows } from './work.js';

const q = schema.proactiveComparisonOutbox;
const rules = schema.proactiveComparisonRules;
const results = schema.projectResults;
const connections = schema.backgroundComputeConnections;

/** Only explicit result source links are snapshotted here. Future source expansion needs a new fingerprint contract. */
export async function resultSourceFingerprint(db: DbExecutor, resultId: string) {
  const links = await db.select({ type: schema.projectObjectLinks.toType, id: schema.projectObjectLinks.toId,
    version: schema.projectObjectLinks.toVersion }).from(schema.projectObjectLinks)
    .where(and(eq(schema.projectObjectLinks.fromType, 'result'), eq(schema.projectObjectLinks.fromId, resultId),
      eq(schema.projectObjectLinks.role, 'source')));
  const sources = links.map((row) => ({ type: row.type, id: row.id, version: row.version }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { sources, fingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex') };
}

export function proactiveOutboxRows(db: DbExecutor) {
  return {
    sourceSnapshot: (resultId: string) => resultSourceFingerprint(db, resultId),
    async sourceCurrent(projectId: string, source: { type: string; id: string; version: number | null }) {
      if (source.type !== 'message' && source.type !== 'result' && source.type !== 'material') return false;
      const ref = source.type === 'material'
        ? { type: 'material' as const, id: source.id, version: source.version! }
        : source.type === 'message' ? { type: 'message' as const, id: source.id }
          : { type: 'result' as const, id: source.id };
      if (!await workRows(db).targetExists(projectId, ref)) return false;
      if (source.type !== 'material') return true;
      const [current] = await db.select({ version: schema.projectMaterials.currentVersion }).from(schema.projectMaterials)
        .where(and(eq(schema.projectMaterials.id, source.id), eq(schema.projectMaterials.projectId, projectId))).for('share');
      return current?.version === source.version;
    },
    /** Called inside the result transaction, after links and before the commit event. */
    async enqueueHumanNegative(resultId: string, projectId: string, authorId: string): Promise<number> {
      const [result] = await db.select({ id: results.id }).from(results).where(and(eq(results.id, resultId),
        eq(results.projectId, projectId), eq(results.finding, 'negative'),
        eq(results.createdByKind, 'human'), eq(results.createdById, authorId)));
      if (!result) return 0;
      const { fingerprint } = await resultSourceFingerprint(db, resultId);
      const eligible = await db.select({ id: rules.id, ownerId: rules.ownerUserId }).from(rules)
        .where(and(eq(rules.projectId, projectId), eq(rules.ownerUserId, authorId), eq(rules.status, 'enabled')));
      let count = 0;
      for (const rule of eligible) {
        const [inserted] = await db.insert(q).values({ id: randomUUID(), ruleId: rule.id, ownerUserId: rule.ownerId,
          projectId, resultId, sourceFingerprint: fingerprint }).onConflictDoNothing().returning({ id: q.id });
        if (inserted) count++;
      }
      return count;
    },
    async lockCandidate(id: string) {
      const [row] = await db.select().from(q).where(eq(q.id, id)).for('update');
      return row ?? null;
    },
    async lockOwner(ownerId: string) {
      const [row] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers)
        .where(eq(schema.authUsers.id, ownerId)).for('update');
      return Boolean(row);
    },
    async rule(id: string) {
      const [row] = await db.select().from(rules).where(eq(rules.id, id)).for('share');
      return row ?? null;
    },
    async result(id: string) {
      const [row] = await db.select().from(results).where(eq(results.id, id)).for('share');
      return row ?? null;
    },
    async connection(ownerId: string) {
      const [row] = await db.select().from(connections)
        .where(and(eq(connections.ownerUserId, ownerId), isNull(connections.revokedAt))).for('share');
      return row ?? null;
    },
    async usage(ownerId: string, startOfDay: Date, startOfPeriod: Date) {
      const [row] = await db.select({
        dayRuns: sql<number>`count(*) FILTER (WHERE ${q.reservedAt} >= ${startOfDay})::int`,
        periodCents: sql<number>`coalesce(sum(${q.reservedCents}) FILTER (WHERE ${q.reservedAt} >= ${startOfPeriod}), 0)::int`,
      }).from(q).where(and(eq(q.ownerUserId, ownerId), inArray(q.status, ['reserved', 'unknown', 'completed']),
        gte(q.reservedAt, startOfPeriod)));
      const [active] = await db.select({ count: sql<number>`count(*)::int` }).from(q)
        .where(and(eq(q.ownerUserId, ownerId), eq(q.status, 'reserved')));
      return { dayRuns: row?.dayRuns ?? 0, periodCents: row?.periodCents ?? 0, inFlight: active?.count ?? 0 };
    },
    async reserve(id: string, connectionId: string, cents: number, at: Date) {
      const [row] = await db.update(q).set({ status: 'reserved', connectionId, reservedCents: cents,
        reservedAt: at, updatedAt: at }).where(and(eq(q.id, id), eq(q.status, 'queued'))).returning();
      return row ?? null;
    },
    async cancel(id: string) {
      await db.update(q).set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(q.id, id), eq(q.status, 'queued')));
    },
  };
}
