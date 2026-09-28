import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { AgentConnection, CreateAgentConnectionCommand } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Row = typeof schema.agentConnections.$inferSelect;

export interface AgentConnectionPolicy {
  authorizeProject(agentId: string, projectId: string, action: 'project.read' | 'project.write', tx: Transaction): Promise<string>;
}

function serialize(row: Row, selectedProjectIds: string[]): AgentConnection {
  return {
    id: row.id, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: row.agentId,
    selectedProjectIds, scopes: [...row.scopes], computeSource: 'user_operated_claude_code',
    revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

/** SQL and locking; the composition root supplies the existing #29 policy. */
export function agentConnectionRepository(db: Database, policy: AgentConnectionPolicy) {
  const projects = async (tx: Transaction, id: string) => (await tx.select({ id: schema.agentConnectionProjects.projectId })
    .from(schema.agentConnectionProjects).where(eq(schema.agentConnectionProjects.connectionId, id)))
    .map((row) => row.id);

  const resolveCurrent = async (tx: Transaction, ownerUserId: string, connectionId: string) => {
    const [row] = await tx.select().from(schema.agentConnections).where(and(
      eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
      isNull(schema.agentConnections.revokedAt))).for('share');
    if (!row) return null;
    const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(
      eq(schema.agents.id, row.agentId), eq(schema.agents.ownerUserId, ownerUserId),
      isNull(schema.agents.revokedAt))).for('share');
    if (!agent) return null;
    const selectedProjectIds = await projects(tx, row.id);
    if (!selectedProjectIds.length) return null;
    const action = row.scopes.includes('flux.proposal.write') ? 'project.write' : 'project.read';
    for (const projectId of selectedProjectIds) {
      if (await policy.authorizeProject(row.agentId, projectId, action, tx) !== row.workspaceId) return null;
    }
    return serialize(row, selectedProjectIds);
  };

  return {
    async create(ownerUserId: string, command: CreateAgentConnectionCommand): Promise<AgentConnection | 'AGENT_NOT_FOUND'> {
      return db.transaction(async (tx) => {
        const [agent] = await tx.select({ workspaceId: schema.agents.workspaceId }).from(schema.agents).where(and(
          eq(schema.agents.id, command.agentId), eq(schema.agents.ownerUserId, ownerUserId),
          isNull(schema.agents.revokedAt))).for('share');
        if (!agent) return 'AGENT_NOT_FOUND';
        const action = command.scopes.includes('flux.proposal.write') ? 'project.write' : 'project.read';
        for (const projectId of command.selectedProjectIds) {
          const workspaceId = await policy.authorizeProject(command.agentId, projectId, action, tx);
          if (workspaceId !== agent.workspaceId) return 'AGENT_NOT_FOUND';
        }
        const [created] = await tx.insert(schema.agentConnections).values({
          id: randomUUID(), workspaceId: agent.workspaceId, ownerUserId, agentId: command.agentId,
          scopes: command.scopes,
        }).returning();
        await tx.insert(schema.agentConnectionProjects).values(command.selectedProjectIds.map((projectId) => ({
          workspaceId: agent.workspaceId, connectionId: created!.id, projectId,
        })));
        return serialize(created!, command.selectedProjectIds);
      });
    },

    list(ownerUserId: string): Promise<AgentConnection[]> {
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(schema.agentConnections)
          .where(eq(schema.agentConnections.ownerUserId, ownerUserId))
          .orderBy(desc(schema.agentConnections.createdAt), desc(schema.agentConnections.id));
        return Promise.all(rows.map(async (row) => serialize(row, await projects(tx, row.id))));
      });
    },

    revoke(ownerUserId: string, connectionId: string): Promise<boolean> {
      return db.transaction(async (tx) => (await tx.update(schema.agentConnections)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.agentConnections.id, connectionId), eq(schema.agentConnections.ownerUserId, ownerUserId),
          isNull(schema.agentConnections.revokedAt))).returning({ id: schema.agentConnections.id })).length > 0);
    },

    resolve(ownerUserId: string, connectionId: string): Promise<AgentConnection | null> {
      return db.transaction((tx) => resolveCurrent(tx, ownerUserId, connectionId));
    },

    /** A browser session can make one OAuth choice; another tab cannot substitute it. */
    selectForOauth(ownerUserId: string, sessionId: string, connectionId: string): Promise<'SELECTED' | 'CONNECTION_NOT_FOUND' | 'ALREADY_SELECTED'> {
      return db.transaction(async (tx) => {
        const [session] = await tx.select({ id: schema.authSessions.id }).from(schema.authSessions).where(and(
          eq(schema.authSessions.id, sessionId), eq(schema.authSessions.userId, ownerUserId),
          gt(schema.authSessions.expiresAt, new Date()))).for('share');
        if (!session || !await resolveCurrent(tx, ownerUserId, connectionId)) return 'CONNECTION_NOT_FOUND';
        await tx.insert(schema.agentOauthSelections).values({ sessionId, ownerUserId, connectionId }).onConflictDoNothing();
        const [selection] = await tx.select({ connectionId: schema.agentOauthSelections.connectionId })
          .from(schema.agentOauthSelections).where(eq(schema.agentOauthSelections.sessionId, sessionId)).for('share');
        return selection?.connectionId === connectionId ? 'SELECTED' : 'ALREADY_SELECTED';
      });
    },

    selectedForOauth(ownerUserId: string, sessionId: string): Promise<AgentConnection | null> {
      return db.transaction(async (tx) => {
        const [selection] = await tx.select({ connectionId: schema.agentOauthSelections.connectionId })
          .from(schema.agentOauthSelections).where(and(eq(schema.agentOauthSelections.sessionId, sessionId),
            eq(schema.agentOauthSelections.ownerUserId, ownerUserId))).for('share');
        return selection ? resolveCurrent(tx, ownerUserId, selection.connectionId) : null;
      });
    },
  };
}
