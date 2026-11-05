import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AgentConnection, AgentMcpPolicy, AssistantSettings, UpdateAssistantSettings } from '@flux/contracts';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { lockAssistantOwner } from './assistant-lock.js';
import { assistantProjectIds, initializeAgentMcpPolicy } from './agent-mcp-policy.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type SettingsRow = typeof schema.assistantSettings.$inferSelect;
export interface AssistantAuthority {
  requireWorkspace(ownerUserId: string, workspaceId: string, tx: Transaction): Promise<void>;
  requireAgent(ownerUserId: string, workspaceId: string, agentId: string, tx: Transaction): Promise<void>;
  identityChanged(): never;
  initialPolicy(connection: AgentConnection): AgentMcpPolicy;
}
const view = (row: SettingsRow, connection: { mayDo: AssistantSettings['mayDo'] }): AssistantSettings => ({
  workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: row.agentId, connectionId: row.connectionId,
  mayDo: connection.mayDo, backgroundRunsPerDay: row.backgroundRunsPerDay,
  version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});
async function connectionView(tx: Transaction, row: SettingsRow): Promise<AgentConnection | null> {
  const [connection] = await tx.select().from(schema.agentConnections).where(and(eq(schema.agentConnections.id, row.connectionId),
    eq(schema.agentConnections.ownerUserId, row.ownerUserId), eq(schema.agentConnections.computeSource, 'owner_assistant'))).for('share');
  if (!connection) return null;
  // The assistant reaches every project its owner can (F-036 AG-3): no project list is stored for it.
  return { id: connection.id, workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, agentId: connection.agentId,
    name: connection.name, clientDesignation: connection.clientDesignation, computeSource: connection.computeSource,
    scopes: [...connection.scopes], selectedProjectIds: await assistantProjectIds(tx, connection.id) ?? [], mayDo: connection.mayDo,
    revokedAt: connection.revokedAt?.toISOString() ?? null, createdAt: connection.createdAt.toISOString() };
}

/** Transaction-bound persistence of the owner's assistant. Its rights are its owner's; it has no grants, switches or project list. */
export function assistantSettingsRows(tx: Transaction, authority: AssistantAuthority) {
  const settings = async (ownerUserId: string, workspaceId: string, lock = false) => {
    await authority.requireWorkspace(ownerUserId, workspaceId, tx);
    const query = tx.select().from(schema.assistantSettings).where(and(eq(schema.assistantSettings.ownerUserId, ownerUserId),
      eq(schema.assistantSettings.workspaceId, workspaceId)));
    return (await (lock ? query.for('update') : query.for('share')))[0] ?? null;
  };
  const get = async (ownerUserId: string, workspaceId: string): Promise<AssistantSettings | null> => {
    await lockAssistantOwner(tx, ownerUserId);
    const row = await settings(ownerUserId, workspaceId);
    const connection = row ? await connectionView(tx, row) : null;
    return row && connection ? view(row, connection) : null;
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
      if (!row) {
        const connectionId = randomUUID();
        await tx.insert(schema.agentConnections).values({ id: connectionId, workspaceId, ownerUserId, agentId,
          name: 'Your assistant', clientDesignation: 'other', computeSource: 'owner_assistant',
          scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] });
        [row] = await tx.insert(schema.assistantSettings).values({ workspaceId, ownerUserId, agentId, connectionId }).returning();
      } else {
        await tx.update(schema.agentConnections).set({ revokedAt: null, updatedAt: new Date() }).where(eq(schema.agentConnections.id, row.connectionId));
      }
      const connection = await connectionView(tx, row!);
      await initializeAgentMcpPolicy(tx, connection!, authority.initialPolicy);
      return (await get(ownerUserId, workspaceId))!;
    },
    async remove(ownerUserId: string): Promise<void> {
      await lockAssistantOwner(tx, ownerUserId);
      await tx.update(schema.agentConnections).set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.agentConnections.ownerUserId, ownerUserId), eq(schema.agentConnections.computeSource, 'owner_assistant')));
    },
    async save(ownerUserId: string, workspaceId: string, expected: number, input: UpdateAssistantSettings) {
      await lockAssistantOwner(tx, ownerUserId);
      const row = await settings(ownerUserId, workspaceId, true);
      const connection = row ? await connectionView(tx, row) : null;
      if (!row || !connection) return null;
      const current = view(row, connection);
      if (current.version !== expected) return { conflict: current };
      const [saved] = await tx.update(schema.assistantSettings).set({ version: current.version + 1, updatedAt: new Date(),
        ...(input.backgroundRunsPerDay === undefined ? {} : { backgroundRunsPerDay: input.backgroundRunsPerDay }),
      }).where(eq(schema.assistantSettings.connectionId, row.connectionId)).returning();
      return view(saved!, connection);
    },
  };
}
