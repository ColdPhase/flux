import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { AgentOperation, ProjectAgentConnection, ProjectAgents } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = { id: string; kind: 'human' };

/** The composition root supplies the existing #29 policy; this adapter never decides access itself. */
export interface ProjectAgentPolicy {
  /** Throws the policy's not-found/forbidden error unless the reader can read the project now. */
  authorizeRead(reader: Reader, projectId: string, tx: Transaction): Promise<void>;
  /** Whether this human or agent can read the project now. */
  canRead(principal: { id: string; kind: 'human' | 'agent' }, projectId: string, tx: Transaction): Promise<boolean>;
}

/**
 * Agents view projection (UI116-2, #136): current connections selected for one project, with a
 * state derived only from server records. A configured or offline connection never looks busy.
 */
export function projectAgentRepository(db: Database, policy: ProjectAgentPolicy) {
  return {
    list(reader: Reader, projectId: string): Promise<ProjectAgents> {
      return db.transaction(async (tx) => {
        await policy.authorizeRead(reader, projectId, tx);
        const candidates = await tx.select({ connection: schema.agentConnections, agentName: schema.agents.name, ownerName: schema.authUsers.name })
          .from(schema.agentConnectionProjects)
          .innerJoin(schema.agentConnections, and(eq(schema.agentConnections.id, schema.agentConnectionProjects.connectionId),
            isNull(schema.agentConnections.revokedAt)))
          .innerJoin(schema.agents, and(eq(schema.agents.id, schema.agentConnections.agentId),
            eq(schema.agents.ownerUserId, schema.agentConnections.ownerUserId), isNull(schema.agents.revokedAt)))
          .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.agentConnections.ownerUserId))
          .where(eq(schema.agentConnectionProjects.projectId, projectId))
          .orderBy(asc(schema.authUsers.name), asc(schema.agentConnections.createdAt), asc(schema.agentConnections.id));
        // A connection is listed only while both its agent and its owner can still read this project.
        const current = [];
        for (const row of candidates) {
          if (await policy.canRead({ kind: 'agent', id: row.connection.agentId }, projectId, tx)
            && await policy.canRead({ kind: 'human', id: row.connection.ownerUserId }, projectId, tx)) current.push(row);
        }
        if (!current.length) return { projectId, connections: [] };
        const ids = current.map((row) => row.connection.id);
        const authorized = new Set((await tx.selectDistinct({ connectionId: schema.agentOauthBindings.connectionId })
          .from(schema.agentOauthBindings).where(inArray(schema.agentOauthBindings.connectionId, ids))).map((row) => row.connectionId));
        // Only a session on the binding's current generation counts; a revoked or rotated grant has none.
        const sessions = new Map<string, { startedAt: Date; expiresAt: Date }>();
        for (const row of await tx.selectDistinctOn([schema.agentRuntimeSessions.connectionId], { connectionId: schema.agentRuntimeSessions.connectionId,
          startedAt: schema.agentRuntimeSessions.createdAt, expiresAt: schema.agentRuntimeSessions.expiresAt })
          .from(schema.agentRuntimeSessions)
          .innerJoin(schema.agentOauthBindings, and(eq(schema.agentOauthBindings.id, schema.agentRuntimeSessions.bindingId),
            eq(schema.agentOauthBindings.generation, schema.agentRuntimeSessions.bindingGeneration)))
          .where(and(inArray(schema.agentRuntimeSessions.connectionId, ids), isNull(schema.agentRuntimeSessions.revokedAt),
            gt(schema.agentRuntimeSessions.expiresAt, sql`now()`)))
          .orderBy(schema.agentRuntimeSessions.connectionId, desc(schema.agentRuntimeSessions.createdAt))) sessions.set(row.connectionId, row);
        const activity = new Map<string, { operation: AgentOperation; at: Date }>();
        for (const row of await tx.selectDistinctOn([schema.agentCommandReceipts.connectionId], { connectionId: schema.agentCommandReceipts.connectionId,
          operation: schema.agentCommandReceipts.operation, at: schema.agentCommandReceipts.completedAt })
          .from(schema.agentCommandReceipts)
          .where(and(eq(schema.agentCommandReceipts.projectId, projectId), inArray(schema.agentCommandReceipts.connectionId, ids)))
          .orderBy(schema.agentCommandReceipts.connectionId, desc(schema.agentCommandReceipts.completedAt))) activity.set(row.connectionId, row);
        const connections = current.map(({ connection, agentName, ownerName }): ProjectAgentConnection => {
          const session = sessions.get(connection.id);
          const last = activity.get(connection.id);
          return {
            id: connection.id, name: connection.name, clientDesignation: connection.clientDesignation,
            owner: { id: connection.ownerUserId, name: ownerName }, agent: { id: connection.agentId, name: agentName },
            own: connection.ownerUserId === reader.id,
            state: session ? 'session_open' : authorized.has(connection.id) ? 'offline' : 'not_signed_in',
            session: session ? { startedAt: session.startedAt.toISOString(), expiresAt: session.expiresAt.toISOString() } : null,
            lastActivity: last ? { operation: last.operation, at: last.at.toISOString() } : null,
          };
        });
        return { projectId, connections };
      });
    },
  };
}
