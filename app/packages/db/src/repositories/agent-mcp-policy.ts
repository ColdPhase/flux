import { and, eq, isNull } from 'drizzle-orm';
import type { AgentConnection, AgentMcpCapabilityId, AgentMcpPolicy, SaveAgentMcpPolicy } from '@flux/contracts';
import { initialAgentMcpPolicy, mcpPolicyWithinConsent, type AgentMcpPolicyPort } from '@flux/core';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface McpPolicyAuthority {
  authorizeProject(agentId: string, projectId: string, action: 'project.read' | 'project.write', tx: Transaction): Promise<string>;
}

/** Caller already holds the original owned connection; first seed captures explicit real entry membership. */
export async function initializeAgentMcpPolicy(tx: Transaction, connection: AgentConnection): Promise<void> {
  const initial = initialAgentMcpPolicy(connection);
  const inserted = await tx.insert(schema.agentConnectionMcpPolicies).values({ connectionId: connection.id,
    enabledCapabilityIds: initial.enabledCapabilityIds, enabledEntryIds: initial.enabledEntryIds }).onConflictDoNothing().returning();
  if (inserted.length && initial.selectedProjectIds.length) await tx.insert(schema.agentConnectionMcpProjects)
    .values(initial.selectedProjectIds.map((projectId) => ({ connectionId: connection.id, workspaceId: connection.workspaceId, projectId })));
}

/** Shared/exclusive policy row is the database fence also used by the real transport write. */
export async function lockAgentMcpPolicy(tx: Transaction, connectionId: string, lock: 'share' | 'update' = 'share'): Promise<AgentMcpPolicy | null> {
  const [row] = await tx.select().from(schema.agentConnectionMcpPolicies)
    .where(eq(schema.agentConnectionMcpPolicies.connectionId, connectionId)).for(lock);
  if (!row) return null;
  const projects = await tx.select({ id: schema.agentConnectionMcpProjects.projectId })
    .from(schema.agentConnectionMcpProjects).where(eq(schema.agentConnectionMcpProjects.connectionId, connectionId))
    .orderBy(schema.agentConnectionMcpProjects.projectId);
  return { connectionId, version: row.version, enabledCapabilityIds: [...row.enabledCapabilityIds] as AgentMcpCapabilityId[],
    enabledEntryIds: [...row.enabledEntryIds], selectedProjectIds: projects.map((project) => project.id) };
}

/** Structural owner management is available even with no enabled capability/project or active agent grant. */
export function agentMcpPolicyRepository(db: Database, authority: McpPolicyAuthority): AgentMcpPolicyPort {
  const structural = async (tx: Transaction, ownerUserId: string, id: string): Promise<AgentConnection | null> => {
    const [row] = await tx.select().from(schema.agentConnections).where(and(eq(schema.agentConnections.id, id),
      eq(schema.agentConnections.ownerUserId, ownerUserId), isNull(schema.agentConnections.revokedAt))).for('share');
    if (!row) return null;
    const selected = await tx.select({ id: schema.agentConnectionProjects.projectId }).from(schema.agentConnectionProjects)
      .where(eq(schema.agentConnectionProjects.connectionId, id)).orderBy(schema.agentConnectionProjects.projectId);
    return { id: row.id, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: row.agentId, name: row.name,
      clientDesignation: row.clientDesignation, scopes: [...row.scopes], computeSource: row.computeSource,
      revokedAt: null, createdAt: row.createdAt.toISOString(), selectedProjectIds: selected.map((project) => project.id) };
  };
  return {
    get: (ownerUserId, id) => db.transaction(async (tx) => {
      const connection = await structural(tx, ownerUserId, id);
      if (!connection) return null;
      await initializeAgentMcpPolicy(tx, connection);
      const policy = await lockAgentMcpPolicy(tx, id);
      return policy ? { connection, policy } : null;
    }),
    save: (ownerUserId, id, expectedVersion, input: SaveAgentMcpPolicy) => db.transaction(async (tx) => {
      const connection = await structural(tx, ownerUserId, id);
      if (!connection) return 'CONNECTION_NOT_FOUND';
      await initializeAgentMcpPolicy(tx, connection);
      const previous = await lockAgentMcpPolicy(tx, id, 'update');
      if (!previous || previous.version !== expectedVersion) return 'POLICY_VERSION_CONFLICT';
      if (!mcpPolicyWithinConsent(connection, input)) return 'MCP_POLICY_OUTSIDE_CONSENT';
      const widens = input.enabledCapabilityIds.some((capability) => !previous.enabledCapabilityIds.includes(capability))
        || input.enabledEntryIds.some((entry) => !previous.enabledEntryIds.includes(entry));
      const addedProjects = input.selectedProjectIds.filter((project) => !previous.selectedProjectIds.includes(project));
      const projects = widens ? input.selectedProjectIds : addedProjects;
      if (projects.length) {
        const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, connection.agentId),
          eq(schema.agents.ownerUserId, ownerUserId), isNull(schema.agents.revokedAt))).for('share');
        if (!agent) return 'MCP_POLICY_AUTHORITY_UNAVAILABLE';
        const writes = input.enabledCapabilityIds.some((capability) => !capability.endsWith('.read'));
        for (const projectId of [...projects].sort()) {
          if (await authority.authorizeProject(connection.agentId, projectId, writes ? 'project.write' : 'project.read', tx) !== connection.workspaceId)
            return 'MCP_POLICY_AUTHORITY_UNAVAILABLE';
        }
      }
      const [row] = await tx.update(schema.agentConnectionMcpPolicies).set({ version: previous.version + 1,
        enabledCapabilityIds: input.enabledCapabilityIds, enabledEntryIds: input.enabledEntryIds, updatedAt: new Date() })
        .where(and(eq(schema.agentConnectionMcpPolicies.connectionId, id), eq(schema.agentConnectionMcpPolicies.version, expectedVersion))).returning();
      if (!row) return 'POLICY_VERSION_CONFLICT';
      await tx.delete(schema.agentConnectionMcpProjects).where(eq(schema.agentConnectionMcpProjects.connectionId, id));
      if (input.selectedProjectIds.length) await tx.insert(schema.agentConnectionMcpProjects)
        .values(input.selectedProjectIds.map((projectId) => ({ connectionId: id, workspaceId: connection.workspaceId, projectId })));
      return { connectionId: id, version: row.version, enabledCapabilityIds: [...row.enabledCapabilityIds] as AgentMcpCapabilityId[],
        enabledEntryIds: [...row.enabledEntryIds], selectedProjectIds: [...input.selectedProjectIds] };
    }),
  };
}
