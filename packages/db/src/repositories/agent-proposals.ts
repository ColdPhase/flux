import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AgentProposal, CreateAgentProposalCommand, Page } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = typeof schema.agentProposals.$inferSelect;
type Principal = { kind: 'human' | 'agent'; id: string };
type Connection = {
  ownerUserId: string;
  agentId: string;
  selectedProjectIds: readonly string[];
  scopes: readonly ('flux.context.read' | 'flux.proposal.write')[];
  computeSource: 'user_operated_claude_code';
};
type ValidatedCommand = CreateAgentProposalCommand & { fingerprint: string };
type Failure = 'AGENT_NOT_FOUND' | 'MATERIAL_NOT_FOUND' | 'SOURCE_VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';

/** The composition root supplies the one core policy path and event recorder. */
export interface AgentProposalPolicy {
  authorizeWrite(principal: Principal, projectId: string, tx: Transaction): Promise<{ workspaceId: string }>;
  authorizeRead(principal: Principal, projectId: string, tx: Transaction): Promise<void>;
  recordCreated(principal: Principal, workspaceId: string, projectId: string, tx: Transaction): Promise<void>;
}

function serialize(row: Row): AgentProposal {
  return {
    id: row.id, projectId: row.projectId,
    audience: { kind: 'project', projectId: row.projectId },
    agentId: row.agentId, ownerUserId: row.ownerUserId,
    computeSource: row.computeSource,
    agentGrant: { id: row.agentGrantId, role: row.agentGrantRole },
    source: { materialId: row.sourceMaterialId, version: row.sourceMaterialVersion },
    fact: row.fact, interpretation: row.interpretation, suggestedAction: row.suggestedAction,
    status: row.status, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** SQL, locking and idempotency live here; all audience decisions come from core policy. */
export function agentProposalRepository(db: Database, policy: AgentProposalPolicy) {
  return {
    async create(connection: Connection, input: ValidatedCommand): Promise<AgentProposal | Failure> {
      const principal: Principal = { kind: 'agent', id: connection.agentId };
      return db.transaction(async (tx) => {
        const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(
          eq(schema.agents.id, connection.agentId), eq(schema.agents.ownerUserId, connection.ownerUserId),
          isNull(schema.agents.revokedAt))).for('share');
        if (!agent) return 'AGENT_NOT_FOUND';
        const { workspaceId } = await policy.authorizeWrite(principal, input.projectId, tx);
        const [source] = await tx.select({ currentVersion: schema.projectMaterials.currentVersion })
          .from(schema.projectMaterials).where(and(
            eq(schema.projectMaterials.id, input.source.materialId),
            eq(schema.projectMaterials.projectId, input.projectId))).for('share');
        if (!source) return 'MATERIAL_NOT_FOUND';
        if (source.currentVersion !== input.source.version) return 'SOURCE_VERSION_CONFLICT';

        const key = and(eq(schema.agentProposals.agentId, connection.agentId),
          eq(schema.agentProposals.projectId, input.projectId),
          eq(schema.agentProposals.clientCommandId, input.clientCommandId));
        const [existing] = await tx.select().from(schema.agentProposals).where(key);
        if (existing) return existing.requestFingerprint === input.fingerprint ? serialize(existing) : 'IDEMPOTENCY_CONFLICT';

        // Keep an immutable grant snapshot even when the live grant is later removed.
        // The policy lock holds the project and agent grant until this transaction commits.
        const [grant] = await tx.select({ id: schema.projectGrants.id, role: schema.projectGrants.role })
          .from(schema.projectGrants).where(and(
            eq(schema.projectGrants.projectId, input.projectId),
            eq(schema.projectGrants.agentId, connection.agentId),
            eq(schema.projectGrants.role, 'contributor')));
        if (!grant) throw new Error('Authorized agent proposal has no contributor grant');
        const [created] = await tx.insert(schema.agentProposals).values({
          id: randomUUID(), workspaceId, projectId: input.projectId,
          agentId: connection.agentId, ownerUserId: connection.ownerUserId,
          computeSource: connection.computeSource, agentGrantId: grant.id, agentGrantRole: 'contributor',
          sourceMaterialId: input.source.materialId, sourceMaterialVersion: input.source.version,
          clientCommandId: input.clientCommandId, requestFingerprint: input.fingerprint,
          fact: input.fact, interpretation: input.interpretation, suggestedAction: input.suggestedAction,
        }).onConflictDoNothing().returning();
        if (!created) {
          const [raced] = await tx.select().from(schema.agentProposals).where(key);
          return raced?.requestFingerprint === input.fingerprint ? serialize(raced) : 'IDEMPOTENCY_CONFLICT';
        }
        await policy.recordCreated(principal, workspaceId, input.projectId, tx);
        return serialize(created);
      });
    },

    async listForPerson(principal: Principal, projectId: string, page: { limit: number; offset: number }): Promise<Page<AgentProposal>> {
      return db.transaction(async (tx) => {
        await policy.authorizeRead(principal, projectId, tx);
        const [count] = await tx.select({ total: sql<number>`count(*)::int` })
          .from(schema.agentProposals).where(eq(schema.agentProposals.projectId, projectId));
        const rows = await tx.select().from(schema.agentProposals)
          .where(eq(schema.agentProposals.projectId, projectId))
          .orderBy(desc(schema.agentProposals.createdAt), desc(schema.agentProposals.id))
          .limit(page.limit).offset(page.offset);
        return { items: rows.map(serialize), total: count?.total ?? 0, ...page };
      });
    },
  };
}
