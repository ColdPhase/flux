import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { ProactiveComparisonProposal } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { comparisonSources } from './proactive-sources.js';

const q = schema.proactiveComparisonOutbox;
const rules = schema.proactiveComparisonRules;
const results = schema.projectResults;
const connections = schema.backgroundComputeConnections;
const proposals = schema.proactiveComparisonProposals;
type ProposalRow = typeof proposals.$inferSelect;

function proposalView(row: ProposalRow): ProactiveComparisonProposal {
  return { id: row.id, projectId: row.projectId, resultId: row.resultId, ownerUserId: row.ownerUserId,
    agentId: row.agentId, audience: { kind: 'project', projectId: row.projectId },
    computeSource: 'owner_background_claude_platform', model: 'claude-sonnet-5',
    sources: row.sources, fact: row.fact, interpretation: row.interpretation,
    suggestedAction: row.suggestedAction, status: row.status, version: row.version,
    editedByUserId: row.editedByUserId, usedWorkId: row.usedWorkId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function proactiveOutboxRows(db: DbExecutor) {
  return {
    async enabledRules(projectId: string) {
      return db.select({ id: rules.id, ownerUserId: rules.ownerUserId, agentId: rules.agentId }).from(rules)
        .where(and(eq(rules.projectId, projectId), eq(rules.status, 'enabled')));
    },
    async listProposals(projectId: string): Promise<ProactiveComparisonProposal[]> {
      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectId))
        .orderBy(desc(proposals.createdAt), desc(proposals.id)).limit(50);
      return rows.map(proposalView);
    },
    async proposalForCandidate(candidateId: string): Promise<ProactiveComparisonProposal | null> {
      const [row] = await db.select().from(proposals).where(eq(proposals.outboxId, candidateId));
      return row ? proposalView(row) : null;
    },
    async lockProposal(id: string) {
      const [row] = await db.select().from(proposals).where(eq(proposals.id, id)).for('update');
      return row ?? null;
    },
    async reviseProposal(id: string, patch: { fact?: string; interpretation?: string; suggestedAction?: string;
      status?: 'dismissed' | 'used'; editedByUserId: string; usedWorkId?: string }) {
      const [row] = await db.update(proposals).set({ ...patch, version: sql`${proposals.version} + 1`, updatedAt: new Date() })
        .where(eq(proposals.id, id)).returning();
      return row ? proposalView(row) : null;
    },
    async complete(input: { candidateId: string; id: string; ownerUserId: string; agentId: string;
      projectId: string; resultId: string; sourceFingerprint: string;
      sources: ProposalRow['sources']; fact: string; interpretation: string; suggestedAction: string;
      inputTokens: number; outputTokens: number; estimatedCents: number }): Promise<ProactiveComparisonProposal | null> {
      const [candidate] = await db.select({ id: q.id }).from(q)
        .where(and(eq(q.id, input.candidateId), eq(q.status, 'reserved'), eq(q.ownerUserId, input.ownerUserId))).for('update');
      if (!candidate) return null;
      const [row] = await db.insert(proposals).values({
        id: input.id, outboxId: input.candidateId, ownerUserId: input.ownerUserId, agentId: input.agentId,
        projectId: input.projectId, resultId: input.resultId, sourceFingerprint: input.sourceFingerprint,
        sources: input.sources, fact: input.fact, interpretation: input.interpretation,
        suggestedAction: input.suggestedAction,
      }).returning();
      await db.update(q).set({ status: 'completed', proposalId: row!.id, usageInputTokens: input.inputTokens,
        usageOutputTokens: input.outputTokens, usageEstimatedCents: input.estimatedCents,
        finishedAt: new Date(), updatedAt: new Date() }).where(eq(q.id, input.candidateId));
      return proposalView(row!);
    },
    async markUnknown(candidateId: string, failureCode: string,
      usage?: { inputTokens: number; outputTokens: number; estimatedCents: number }) {
      await db.update(q).set({ status: 'unknown', failureCode, finishedAt: new Date(), updatedAt: new Date(),
        ...(usage ? { usageInputTokens: usage.inputTokens, usageOutputTokens: usage.outputTokens,
          usageEstimatedCents: usage.estimatedCents } : {}),
      }).where(and(eq(q.id, candidateId), eq(q.status, 'reserved')));
    },
    /** Only the dispatch path that has not entered createMessage may release this reservation. */
    async markNotRun(candidateId: string, failureCode: string) {
      await db.update(q).set({ status: 'cancelled', failureCode, connectionId: null,
        reservedAt: null, reservedCents: 0, usageInputTokens: 0, usageOutputTokens: 0,
        usageEstimatedCents: 0, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(q.id, candidateId), eq(q.status, 'reserved')));
    },
    sourceSnapshot: (resultId: string, ruleId: string) => comparisonSources(db).snapshot(resultId, ruleId),
    async messageConversation(projectId: string, messageId: string) {
      const [row] = await db.select({ conversationId: schema.projectMessages.conversationId }).from(schema.projectMessages)
        .where(and(eq(schema.projectMessages.projectId, projectId), eq(schema.projectMessages.id, messageId))).for('share');
      return row?.conversationId ?? null;
    },
    sourceCurrent: (projectId: string, source: { type: string; id: string; version: number | null; sketchId?: string }) =>
      comparisonSources(db).current(projectId, source, true),
    async sourceText(projectId: string, source: { type: 'message' | 'result' | 'material' | 'work' | 'thought'; id: string; version: number }) {
      if (source.type === 'message') {
        const [row] = await db.select({ body: schema.projectMessages.body }).from(schema.projectMessages)
          .where(and(eq(schema.projectMessages.projectId, projectId), eq(schema.projectMessages.id, source.id)));
        return row?.body ?? null;
      }
      if (source.type === 'result') {
        const [row] = await db.select({ title: results.title, evidence: results.evidence }).from(results)
          .where(and(eq(results.projectId, projectId), eq(results.id, source.id)));
        return row ? `${row.title}\n${row.evidence}` : null;
      }
      if (source.type === 'work') {
        const [row] = await db.select({ title: schema.projectWorkItems.title, outcome: schema.projectWorkItems.outcome,
          status: schema.projectWorkItems.status, blocker: schema.projectWorkItems.blocker }).from(schema.projectWorkItems)
          .where(and(eq(schema.projectWorkItems.projectId, projectId), eq(schema.projectWorkItems.id, source.id),
            eq(schema.projectWorkItems.version, source.version)));
        return row ? `${row.title}\n${row.outcome}\nStatus: ${row.status}${row.blocker ? `\nBlocker: ${row.blocker}` : ''}` : null;
      }
      if (source.type === 'thought') {
        const [row] = await db.select({ text: schema.sketchThoughts.text }).from(schema.sketchThoughts)
          .innerJoin(schema.sketches, eq(schema.sketches.id, schema.sketchThoughts.sketchId))
          .where(and(eq(schema.sketches.projectId, projectId), eq(schema.sketches.scope, 'project'),
            eq(schema.sketchThoughts.id, source.id), eq(schema.sketchThoughts.version, source.version),
            isNull(schema.sketchThoughts.placementType), isNull(schema.sketchThoughts.placementId)));
        return row?.text ?? null;
      }
      const [row] = await db.select({ title: schema.projectMaterialVersions.title, body: schema.projectMaterialVersions.body })
        .from(schema.projectMaterialVersions).where(and(eq(schema.projectMaterialVersions.projectId, projectId),
          eq(schema.projectMaterialVersions.materialId, source.id), eq(schema.projectMaterialVersions.version, source.version)));
      return row ? `${row.title}\n${row.body}` : null;
    },
    /** Called inside the result transaction, after links and before the commit event. */
    async enqueueHumanNegative(resultId: string, projectId: string, authorId: string, eligibleRuleIds: string[] = []): Promise<number> {
      const [result] = await db.select({ id: results.id }).from(results).where(and(eq(results.id, resultId),
        eq(results.projectId, projectId), eq(results.finding, 'negative'),
        eq(results.createdByKind, 'human'), eq(results.createdById, authorId)));
      if (!result) return 0;
      const eligible = await db.select({ id: rules.id, ownerId: rules.ownerUserId }).from(rules)
        .where(and(eq(rules.projectId, projectId), eq(rules.status, 'enabled'), inArray(rules.id, eligibleRuleIds)));
      let count = 0;
      for (const rule of eligible) {
        const { fingerprint } = await comparisonSources(db).snapshot(resultId, rule.id);
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
      const [row] = await db.select({ id: results.id, projectId: results.projectId,
        finding: results.finding, createdByKind: results.createdByKind, createdById: results.createdById }).from(results)
        .where(eq(results.id, id)).for('share');
      return row ?? null;
    },
    async resultState(id: string) {
      const [row] = await db.select({ id: results.id, projectId: results.projectId,
        finding: results.finding, createdByKind: results.createdByKind }).from(results)
        .where(eq(results.id, id)).for('share');
      return row ?? null;
    },
    async connectionState(ownerId: string) {
      const [row] = await db.select({ id: connections.id, perRunCents: connections.perRunCents,
        keyAvailable: sql<boolean>`${connections.encryptedKey} IS NOT NULL` }).from(connections)
        .where(and(eq(connections.ownerUserId, ownerId), isNull(connections.revokedAt))).for('share');
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
        periodCents: sql<number>`coalesce(sum(greatest(${q.reservedCents}, coalesce(${q.usageEstimatedCents}, 0))) FILTER (WHERE ${q.reservedAt} >= ${startOfPeriod}), 0)::int`,
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
