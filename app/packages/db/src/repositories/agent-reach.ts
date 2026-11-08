import { and, eq } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';
import { loadActor, projectLevelSql, projectMemberSql, visibleProjectsSql } from './access.js';
import type { DbExecutor } from './push.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Where an agent connection reaches: every project its owner can see now (and belongs to), read fresh. No project list is stored for any
 * connection (F-036 AG-3, #855, #859): the owner's current rights alone decide, and a restricted project's id never reaches a
 * caller's payload. Empty for an unknown connection.
 */
export async function reachableProjectIds(tx: Transaction, connectionId: string): Promise<string[]> {
  const [row] = await tx.select({ workspaceId: schema.agentConnections.workspaceId, ownerUserId: schema.agentConnections.ownerUserId })
    .from(schema.agentConnections).where(eq(schema.agentConnections.id, connectionId));
  if (!row) return [];
  const owner = await loadActor({ kind: 'human', id: row.ownerUserId }, row.workspaceId, tx);
  // A company owner or admin reaches every space, but their agents only the ones they were added to (C-15, #934).
  return (await tx.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(visibleProjectsSql(owner), projectMemberSql(owner, schema.projects.id, schema.projects.visibility)))
    .orderBy(schema.projects.id)).map((project) => project.id);
}

/**
 * Whether the connection's agent may use this space now: its owner is a non-guest member of the company who can see the space, and AI
 * is on there (AG-2, AG-3, AG-10). Work addressed to a client that fails this could never be seen, claimed or answered by it, so it is
 * refused before it is made. Read fresh, under whatever locks the caller holds.
 */
export async function connectionReaches(tx: DbExecutor, connectionId: string, projectId: string): Promise<boolean> {
  const [row] = await tx.select({ workspaceId: schema.agentConnections.workspaceId, agentId: schema.agentConnections.agentId })
    .from(schema.agentConnections).where(eq(schema.agentConnections.id, connectionId));
  if (!row) return false;
  const actor = await loadActor({ kind: 'agent', id: row.agentId }, row.workspaceId, tx);
  if (!actor.active) return false;
  const [project] = await tx.select({ level: projectLevelSql(actor, schema.projects.id, schema.projects.visibility).mapWith(Number) }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, row.workspaceId)));
  return !!project && project.level > 0;
}
