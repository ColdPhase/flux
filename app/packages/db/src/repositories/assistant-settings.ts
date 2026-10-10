import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { assistantAreasFromPolicy, patchAssistantAreas, type AgentConnection, type AgentMcpPolicy,
  type AssistantSettings, type UpdateAssistantSettings } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { lockAssistantOwner } from './assistant-lock.js';
import { initializeAgentMcpPolicy, lockAgentMcpPolicy } from './agent-mcp-policy.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type SettingsRow = typeof schema.assistantSettings.$inferSelect;
export interface AssistantAuthority {
  requireWorkspace(ownerUserId: string, workspaceId: string, tx: Transaction): Promise<void>;
  requireAgent(ownerUserId: string, workspaceId: string, agentId: string, tx: Transaction): Promise<void>;
  allowsProject(principal: { kind: 'human' | 'agent'; id: string }, action: 'project.read' | 'project.write' | 'project.manage', projectId: string, tx: Transaction): Promise<boolean>;
  grantProject(ownerUserId: string, projectId: string, agentId: string, tx: Transaction): Promise<void>;
  identityChanged(): never;
  initialPolicy(connection: AgentConnection): AgentMcpPolicy;
  withinConsent(connection: AgentConnection, policy: AgentMcpPolicy): boolean;
  admissionActions(previous: AgentMcpPolicy, policy: AgentMcpPolicy): { projectId: string; action: 'project.read' | 'project.write' }[];
}
const view = (row: SettingsRow, policy: AgentMcpPolicy): AssistantSettings => ({
  workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: row.agentId, connectionId: row.connectionId,
  approvalMode: row.approvalMode, changesPerRun: row.changesPerRun, backgroundRunsPerDay: row.backgroundRunsPerDay,
  projectMode: row.projectMode, areas: assistantAreasFromPolicy(policy), policy,
  // A direct owner save on S6 also invalidates the assistant's CAS token.
  version: Math.max(row.version, policy.version), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});
async function connectionView(tx: Transaction, row: SettingsRow): Promise<AgentConnection | null> {
  const [connection] = await tx.select().from(schema.agentConnections).where(and(eq(schema.agentConnections.id, row.connectionId),
    eq(schema.agentConnections.ownerUserId, row.ownerUserId), eq(schema.agentConnections.computeSource, 'owner_assistant'))).for('share');
  if (!connection) return null;
  const selections = await tx.select({ id: schema.agentConnectionProjects.projectId }).from(schema.agentConnectionProjects)
    .where(eq(schema.agentConnectionProjects.connectionId, row.connectionId)).orderBy(schema.agentConnectionProjects.projectId);
  return { id: connection.id, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: connection.agentId,
    name: connection.name, clientDesignation: connection.clientDesignation, computeSource: connection.computeSource,
    scopes: [...connection.scopes], selectedProjectIds: selections.map((p) => p.id),
    revokedAt: connection.revokedAt?.toISOString() ?? null, createdAt: connection.createdAt.toISOString() };
}

/** Transaction-bound persistence. All collaborative access and grant changes go through supplied core policy/use cases. */
export function assistantSettingsRows(tx: Transaction, authority: AssistantAuthority) {
  const settings = async (ownerUserId: string, workspaceId: string, lock = false) => {
    await authority.requireWorkspace(ownerUserId, workspaceId, tx);
    const query = tx.select().from(schema.assistantSettings).where(and(eq(schema.assistantSettings.ownerUserId, ownerUserId),
      eq(schema.assistantSettings.workspaceId, workspaceId)));
    return (await (lock ? query.for('update') : query.for('share')))[0] ?? null;
  };
  const get = async (ownerUserId: string, workspaceId: string): Promise<AssistantSettings | null> => {
    const row = await settings(ownerUserId, workspaceId);
    if (!row || !await connectionView(tx, row)) return null;
    const policy = await lockAgentMcpPolicy(tx, row.connectionId);
    return policy ? view(row, policy) : null;
  };
  const addProject = async (row: SettingsRow, projectId: string) => {
    const [ceiling] = await tx.select({ id: schema.agentConnectionProjects.projectId }).from(schema.agentConnectionProjects)
      .where(and(eq(schema.agentConnectionProjects.connectionId, row.connectionId), eq(schema.agentConnectionProjects.projectId, projectId)));
    const [selected] = await tx.select({ id: schema.agentConnectionMcpProjects.projectId }).from(schema.agentConnectionMcpProjects)
      .where(and(eq(schema.agentConnectionMcpProjects.connectionId, row.connectionId), eq(schema.agentConnectionMcpProjects.projectId, projectId)));
    if (ceiling && (row.projectMode === 'chosen' || selected)) return;
    const policy = await lockAgentMcpPolicy(tx, row.connectionId, 'update');
    if (!policy) throw new Error('Assistant policy missing');
    await tx.insert(schema.agentConnectionProjects).values({ connectionId: row.connectionId, workspaceId: row.workspaceId, projectId }).onConflictDoNothing();
    if (row.projectMode === 'all') await tx.insert(schema.agentConnectionMcpProjects)
      .values({ connectionId: row.connectionId, workspaceId: row.workspaceId, projectId }).onConflictDoNothing();
    const version = Math.max(row.version, policy.version) + 1;
    await tx.update(schema.agentConnectionMcpPolicies).set({ version, updatedAt: new Date() }).where(eq(schema.agentConnectionMcpPolicies.connectionId, row.connectionId));
    await tx.update(schema.assistantSettings).set({ version, updatedAt: new Date() }).where(eq(schema.assistantSettings.connectionId, row.connectionId));
  };
  return {
    lockOwner: (ownerUserId: string) => lockAssistantOwner(tx, ownerUserId),
    get,
    async ensure(ownerUserId: string, workspaceId: string, agentId: string): Promise<AssistantSettings> {
      await lockAssistantOwner(tx, ownerUserId);
      await authority.requireAgent(ownerUserId, workspaceId, agentId, tx);
      let row = await settings(ownerUserId, workspaceId, true);
      // The agent identity is selected at enablement; an engine change never substitutes another one.
      if (row && row.agentId !== agentId) authority.identityChanged();
      const candidates = await tx.select({ id: schema.projects.id }).from(schema.projects)
        .where(eq(schema.projects.workspaceId, workspaceId)).orderBy(schema.projects.id);
      for (const project of candidates) if (await authority.allowsProject({ kind: 'human', id: ownerUserId }, 'project.manage', project.id, tx))
        await authority.grantProject(ownerUserId, project.id, agentId, tx);
      const projects: string[] = [];
      for (const project of candidates) if (await authority.allowsProject({ kind: 'human', id: ownerUserId }, 'project.read', project.id, tx)
        && await authority.allowsProject({ kind: 'agent', id: agentId }, 'project.read', project.id, tx)) projects.push(project.id);
      if (!row) {
        const connectionId = randomUUID();
        await tx.insert(schema.agentConnections).values({ id: connectionId, workspaceId, ownerUserId, agentId,
          name: 'Your assistant', clientDesignation: 'other', computeSource: 'owner_assistant',
          scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] });
        [row] = await tx.insert(schema.assistantSettings).values({ workspaceId, ownerUserId, agentId, connectionId }).returning();
        if (projects.length) await tx.insert(schema.agentConnectionProjects).values(projects.map((projectId) => ({ workspaceId, connectionId, projectId })));
        const connection = await connectionView(tx, row!);
        await initializeAgentMcpPolicy(tx, connection!, authority.initialPolicy);
      } else {
        await tx.update(schema.agentConnections).set({ revokedAt: null, updatedAt: new Date() }).where(eq(schema.agentConnections.id, row.connectionId));
        const connection = await connectionView(tx, row);
        await initializeAgentMcpPolicy(tx, connection!, authority.initialPolicy);
        for (const projectId of projects) if (!connection!.selectedProjectIds.includes(projectId)) await addProject(row, projectId);
      }
      return (await get(ownerUserId, workspaceId))!;
    },
    async remove(ownerUserId: string): Promise<void> {
      await lockAssistantOwner(tx, ownerUserId);
      await tx.update(schema.agentConnections).set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.agentConnections.ownerUserId, ownerUserId), eq(schema.agentConnections.computeSource, 'owner_assistant')));
    },
    async addGrantedProject(agentId: string, workspaceId: string, projectId: string) {
      const [row] = await tx.select().from(schema.assistantSettings).where(and(eq(schema.assistantSettings.agentId, agentId), eq(schema.assistantSettings.workspaceId, workspaceId))).for('update');
      if (!row || !await authority.allowsProject({ kind: 'human', id: row.ownerUserId }, 'project.read', projectId, tx)
        || !await authority.allowsProject({ kind: 'agent', id: row.agentId }, 'project.read', projectId, tx)) return;
      await addProject(row, projectId);
      await tx.update(schema.assistantJoinRequests).set({ state: 'accepted', version: sql`${schema.assistantJoinRequests.version} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.assistantJoinRequests.connectionId, row.connectionId), eq(schema.assistantJoinRequests.projectId, projectId), eq(schema.assistantJoinRequests.state, 'pending')));
    },
    async joinCreatedProject(ownerUserId: string, workspaceId: string, projectId: string) {
      const row = await settings(ownerUserId, workspaceId, true);
      if (!row || !await authority.allowsProject({ kind: 'human', id: ownerUserId }, 'project.manage', projectId, tx)) return;
      const connection = await connectionView(tx, row);
      if (!connection || connection.revokedAt) return;
      await authority.grantProject(ownerUserId, projectId, row.agentId, tx);
      await addProject(row, projectId);
    },
    async save(ownerUserId: string, workspaceId: string, expected: number, input: UpdateAssistantSettings) {
      await lockAssistantOwner(tx, ownerUserId);
      const row = await settings(ownerUserId, workspaceId, true);
      if (!row) return null;
      const connection = await connectionView(tx, row);
      const previous = await lockAgentMcpPolicy(tx, row.connectionId, 'update');
      if (!connection || !previous) return null;
      const current = view(row, previous);
      if (current.version !== expected) return { conflict: current };
      const projectMode = input.projectMode ?? row.projectMode;
      const selectedProjectIds = projectMode === 'all' ? connection.selectedProjectIds : input.selectedProjectIds ?? previous.selectedProjectIds;
      const changed = input.areas ? patchAssistantAreas(previous, input.areas) : previous;
      const desired: AgentMcpPolicy = { ...previous, ...changed, selectedProjectIds };
      if (!authority.withinConsent(connection, desired)) return 'OUTSIDE_CONSENT' as const;
      for (const { projectId, action } of authority.admissionActions(previous, desired))
        if (!await authority.allowsProject({ kind: 'agent', id: row.agentId }, action, projectId, tx)) return 'AUTHORITY_UNAVAILABLE' as const;
      const version = current.version + 1; const now = new Date();
      await tx.update(schema.agentConnectionMcpPolicies).set({ version, enabledCapabilityIds: desired.enabledCapabilityIds,
        enabledEntryIds: desired.enabledEntryIds, updatedAt: now }).where(eq(schema.agentConnectionMcpPolicies.connectionId, row.connectionId));
      await tx.delete(schema.agentConnectionMcpProjects).where(eq(schema.agentConnectionMcpProjects.connectionId, row.connectionId));
      if (selectedProjectIds.length) await tx.insert(schema.agentConnectionMcpProjects)
        .values(selectedProjectIds.map((projectId) => ({ connectionId: row.connectionId, workspaceId, projectId })));
      await tx.update(schema.assistantSettings).set({ version, updatedAt: now,
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
        ...(input.changesPerRun === undefined ? {} : { changesPerRun: input.changesPerRun }),
        ...(input.backgroundRunsPerDay === undefined ? {} : { backgroundRunsPerDay: input.backgroundRunsPerDay }), projectMode,
      }).where(eq(schema.assistantSettings.connectionId, row.connectionId));
      return (await get(ownerUserId, workspaceId))!;
    },
  };
}
