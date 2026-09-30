import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { BackgroundComputeUsage, InspectedComparisonSource, InsufficientComparisonOutcome,
  ProactiveComparisonOutcome } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { comparisonProposalView } from './proactive-outbox.js';

const q = schema.proactiveComparisonOutbox;
const p = schema.proactiveComparisonProposals;
const i = schema.proactiveComparisonInsufficientOutcomes;
const c = schema.backgroundComputeConnections;
type InsufficientRow = typeof i.$inferSelect;
type SourceRef = Pick<InspectedComparisonSource, 'type' | 'id' | 'version' | 'conversationId' | 'sketchId'>;

function insufficientView(row: InsufficientRow, inspectedSources: InspectedComparisonSource[]): InsufficientComparisonOutcome {
  return { kind: 'insufficient_evidence', id: row.id, projectId: row.projectId, resultId: row.resultId,
    ownerUserId: row.ownerUserId, agentId: row.agentId, reason: row.reason, inspectedSources,
    unavailableSourcesCount: 0, status: row.status, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Outcome storage and owner-private accounting; current reader policy is assembled by the server. */
export function comparisonOutcomeRows(db: DbExecutor) {
  const visible = or(isNotNull(p.id), isNotNull(i.id));
  return {
    async listProject(projectId: string, limit: number, offset: number) {
      const rows = await db.select({ proposal: p, insufficient: i, inspected: q.inspectedSources }).from(q)
        .leftJoin(p, eq(p.outboxId, q.id)).leftJoin(i, eq(i.outboxId, q.id))
        .where(and(eq(q.projectId, projectId), visible))
        .orderBy(desc(sql`coalesce(${p.createdAt}, ${i.createdAt})`), desc(sql`coalesce(${p.id}, ${i.id})`))
        .limit(limit).offset(offset);
      const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(q)
        .leftJoin(p, eq(p.outboxId, q.id)).leftJoin(i, eq(i.outboxId, q.id))
        .where(and(eq(q.projectId, projectId), visible));
      const items: ProactiveComparisonOutcome[] = rows.map((row) => row.proposal
        ? { kind: 'comparison', proposal: comparisonProposalView(row.proposal), inspectedSources: row.inspected,
          unavailableSourcesCount: 0 }
        : insufficientView(row.insufficient!, row.inspected!));
      return { items, total: count?.total ?? 0 };
    },
    async lockInsufficient(id: string) {
      const [row] = await db.select().from(i).where(eq(i.id, id)).for('update');
      if (!row) return null;
      const [candidate] = await db.select({ sources: q.inspectedSources }).from(q).where(eq(q.id, row.outboxId));
      return insufficientView(row, candidate!.sources!);
    },
    async dismissInsufficient(id: string, expectedVersion: number) {
      const [row] = await db.update(i).set({ status: 'dismissed', version: sql`${i.version} + 1`, updatedAt: new Date() })
        .where(and(eq(i.id, id), eq(i.version, expectedVersion), eq(i.status, 'open'))).returning();
      if (!row) return null;
      const [candidate] = await db.select({ sources: q.inspectedSources }).from(q).where(eq(q.id, row.outboxId));
      return insufficientView(row, candidate!.sources!);
    },
    async ownerUsage(ownerId: string, now: Date): Promise<BackgroundComputeUsage> {
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const period = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const counted = sql`greatest(${q.reservedCents}, coalesce(${q.usageEstimatedCents}, 0))`;
      const [totals] = await db.select({
        startedRequestsToday: sql<number>`count(*) FILTER (WHERE ${q.dispatchStartedAt} >= ${day})::int`,
        conservativeCountedCents: sql<number>`coalesce(sum(${counted}) FILTER (WHERE ${q.reservedAt} >= ${period}), 0)::int`,
        observedEstimatedCents: sql<number>`coalesce(sum(${q.usageEstimatedCents}) FILTER (WHERE ${q.reservedAt} >= ${period}), 0)::int`,
        unknownPossibleCents: sql<number>`coalesce(sum(${counted}) FILTER (WHERE ${q.status} = 'unknown' AND ${q.reservedAt} >= ${period}), 0)::int`,
        inFlightCents: sql<number>`coalesce(sum(${counted}) FILTER (WHERE ${q.status} = 'reserved'), 0)::int`,
      }).from(q).where(eq(q.ownerUserId, ownerId));
      const [connection] = await db.select({ maxRunsPerDay: c.maxRunsPerDay, periodBudgetCents: c.periodBudgetCents,
        perRunCents: c.perRunCents }).from(c)
        .where(and(eq(c.ownerUserId, ownerId), isNull(c.revokedAt), isNotNull(c.encryptedKey)));
      const candidates = await db.select({ id: q.id, projectId: q.projectId, resultId: q.resultId, ruleId: q.ruleId,
        status: q.status, reason: q.failureCode, createdAt: q.createdAt, reservedAt: q.reservedAt,
        startedAt: q.dispatchStartedAt, finishedAt: q.finishedAt, reservedCents: q.reservedCents,
        input: q.usageInputTokens, output: q.usageOutputTokens, estimate: q.usageEstimatedCents })
        .from(q).where(eq(q.ownerUserId, ownerId)).orderBy(desc(q.createdAt), desc(q.id)).limit(50);
      return { asOf: now.toISOString(), utcDayStartsAt: day.toISOString(), rollingPeriodStartsAt: period.toISOString(),
        startedRequestsToday: totals?.startedRequestsToday ?? 0,
        conservativeCountedCents: totals?.conservativeCountedCents ?? 0,
        observedEstimatedCents: totals?.observedEstimatedCents ?? 0,
        unknownPossibleCents: totals?.unknownPossibleCents ?? 0, inFlightCents: totals?.inFlightCents ?? 0,
        currentLimits: connection ? { ...connection, periodDays: 30 } : null,
        candidates: candidates.map((row) => ({ id: row.id, projectId: row.projectId, resultId: row.resultId, context: null,
          ruleId: row.ruleId, status: row.status, reason: row.reason, createdAt: row.createdAt.toISOString(),
          reservedAt: row.reservedAt?.toISOString() ?? null, startedAt: row.startedAt?.toISOString() ?? null,
          finishedAt: row.finishedAt?.toISOString() ?? null, reservedCents: row.reservedCents,
          observedUsage: row.input !== null && row.output !== null && row.estimate !== null
            ? { inputTokens: row.input, outputTokens: row.output, estimatedCents: row.estimate } : null })) };
    },
    /** Exact current labels, read only after core authorizes this project. Accounting queries stay unchanged. */
    async usageContext(projectId: string, resultId: string) {
      const result = schema.projectResults;
      const project = schema.projects;
      const [row] = await db.select({ projectTitle: project.name, resultTitle: result.title }).from(result)
        .innerJoin(project, and(eq(project.id, result.projectId), eq(project.workspaceId, result.workspaceId)))
        .where(and(eq(result.id, resultId), eq(result.projectId, projectId)));
      return row ?? null;
    },
    /** Existence and navigation of the historical reference, without reading its body or title. */
    async sourceExists(projectId: string, source: SourceRef): Promise<boolean> {
      if (source.type === 'thought') {
        if (!source.sketchId) return false;
        const [row] = await db.select({ id: schema.sketchThoughts.id }).from(schema.sketchThoughts)
          .innerJoin(schema.sketches, eq(schema.sketches.id, schema.sketchThoughts.sketchId))
          .where(and(eq(schema.sketchThoughts.id, source.id), eq(schema.sketches.id, source.sketchId),
            eq(schema.sketches.projectId, projectId), eq(schema.sketches.scope, 'project')));
        return !!row;
      }
      if (source.type === 'material') {
        const [row] = await db.select({ id: schema.projectMaterialVersions.materialId }).from(schema.projectMaterialVersions)
          .where(and(eq(schema.projectMaterialVersions.projectId, projectId),
            eq(schema.projectMaterialVersions.materialId, source.id), eq(schema.projectMaterialVersions.version, source.version)));
        return !!row;
      }
      if (source.type === 'message') {
        if (!source.conversationId) return false;
        const [row] = await db.select({ id: schema.projectMessages.id }).from(schema.projectMessages)
          .where(and(eq(schema.projectMessages.projectId, projectId), eq(schema.projectMessages.id, source.id),
            eq(schema.projectMessages.conversationId, source.conversationId)));
        return !!row;
      }
      if (source.type === 'work') {
        const [row] = await db.select({ id: schema.projectWorkItems.id }).from(schema.projectWorkItems)
          .where(and(eq(schema.projectWorkItems.projectId, projectId), eq(schema.projectWorkItems.id, source.id)));
        return !!row;
      }
      const [row] = await db.select({ id: schema.projectResults.id }).from(schema.projectResults)
        .where(and(eq(schema.projectResults.projectId, projectId), eq(schema.projectResults.id, source.id)));
      return !!row;
    },
  };
}
