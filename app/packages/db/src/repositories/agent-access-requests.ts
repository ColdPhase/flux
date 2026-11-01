import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AgentAccessRequest, ProjectGrantRole } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Row = typeof schema.agentAccessRequests.$inferSelect;

/**
 * Rows of #763 FT-1 agent access requests. The server authorizes the agent's owner (asking) or a current project
 * manager (listing all and answering) before calling these; nothing here grants access.
 */
export function agentAccessRequestRows(tx: DbExecutor) {
  const view = async (rows: Row[]): Promise<AgentAccessRequest[]> => {
    if (!rows.length) return [];
    const agents = new Map((await tx.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)
      .where(inArray(schema.agents.id, [...new Set(rows.map((row) => row.agentId))]))).map((row) => [row.id, row.name]));
    const owners = new Map((await tx.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers)
      .where(inArray(schema.authUsers.id, [...new Set(rows.map((row) => row.ownerUserId))]))).map((row) => [row.id, row.name]));
    return rows.map((row) => ({
      id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
      agent: { id: row.agentId, name: agents.get(row.agentId) ?? 'Agent' }, owner: { id: row.ownerUserId, name: owners.get(row.ownerUserId) ?? 'Someone' },
      role: row.role, state: row.state, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  };
  return {
    view,
    /** The owner's active personal agent, locked for share so a revocation cannot interleave. */
    async ownAgent(ownerUserId: string, agentId: string) {
      const [row] = await tx.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.ownerUserId, ownerUserId))).for('share');
      return row && !row.revokedAt ? row : null;
    },
    async grantOf(projectId: string, agentId: string): Promise<ProjectGrantRole | null> {
      const [row] = await tx.select({ role: schema.projectGrants.role }).from(schema.projectGrants)
        .where(and(eq(schema.projectGrants.projectId, projectId), eq(schema.projectGrants.agentId, agentId)));
      return row?.role ?? null;
    },
    /** Opens the request, or reopens a closed one; an already pending one is returned as it is (`created` false). */
    async open(input: { workspaceId: string; projectId: string; agentId: string; ownerUserId: string; role: 'contributor' | 'viewer' }) {
      const [existing] = await tx.select().from(schema.agentAccessRequests).where(and(
        eq(schema.agentAccessRequests.agentId, input.agentId), eq(schema.agentAccessRequests.projectId, input.projectId))).for('update');
      if (existing?.state === 'pending' && existing.role === input.role) return { row: existing, created: false };
      if (existing) {
        const [row] = await tx.update(schema.agentAccessRequests).set({ state: 'pending', role: input.role, decidedBy: null, updatedAt: new Date() })
          .where(eq(schema.agentAccessRequests.id, existing.id)).returning();
        return { row: row!, created: existing.state !== 'pending' };
      }
      const [row] = await tx.insert(schema.agentAccessRequests).values({ id: randomUUID(), ...input }).returning();
      return { row: row!, created: true };
    },
    /** The agent's request in a project, whatever its state. */
    async current(agentId: string, projectId: string) {
      const [row] = await tx.select().from(schema.agentAccessRequests).where(and(
        eq(schema.agentAccessRequests.agentId, agentId), eq(schema.agentAccessRequests.projectId, projectId)));
      return row ?? null;
    },
    async find(projectId: string, requestId: string, lock = false) {
      const query = tx.select().from(schema.agentAccessRequests).where(and(eq(schema.agentAccessRequests.id, requestId),
        eq(schema.agentAccessRequests.projectId, projectId)));
      const [row] = lock ? await query.for('update') : await query;
      return row ?? null;
    },
    async close(requestId: string, state: 'accepted' | 'declined', decidedBy: string) {
      const [row] = await tx.update(schema.agentAccessRequests).set({ state, decidedBy, updatedAt: new Date() })
        .where(eq(schema.agentAccessRequests.id, requestId)).returning();
      return row!;
    },
    /** Pending requests of a project, oldest first; `ownerUserId` narrows to one owner's own. */
    pending(projectId: string, ownerUserId?: string) {
      return tx.select().from(schema.agentAccessRequests).where(and(eq(schema.agentAccessRequests.projectId, projectId),
        eq(schema.agentAccessRequests.state, 'pending'), ownerUserId ? eq(schema.agentAccessRequests.ownerUserId, ownerUserId) : undefined))
        .orderBy(asc(schema.agentAccessRequests.createdAt));
    },
    /** The agent's explicit grants and open requests in its workspace's projects (filtered by the caller to readable ones). */
    async ofAgent(agentId: string) {
      const grants = await tx.select({ projectId: schema.projectGrants.projectId, role: schema.projectGrants.role }).from(schema.projectGrants)
        .where(eq(schema.projectGrants.agentId, agentId));
      const requests = await tx.select({ id: schema.agentAccessRequests.id, projectId: schema.agentAccessRequests.projectId, role: schema.agentAccessRequests.role })
        .from(schema.agentAccessRequests).where(and(eq(schema.agentAccessRequests.agentId, agentId), eq(schema.agentAccessRequests.state, 'pending')));
      return { grants, requests };
    },
    /** Workspace members, in a stable order: the candidates a manager notice is offered to. */
    candidates: (workspaceId: string) => tx.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId)).orderBy(schema.workspaceMembers.userId),
    async names(userIds: string[]) {
      if (!userIds.length) return new Map<string, string>();
      return new Map((await tx.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers)
        .where(inArray(schema.authUsers.id, userIds))).map((row) => [row.id, row.name]));
    },
    /** A manager's notice is a question in their Needs you. */
    async markQuestion(notificationId: string) {
      await tx.update(schema.notifications).set({ reason: 'question' }).where(eq(schema.notifications.id, notificationId));
    },
    /** The managers' notices about a request leave Needs you once it is answered (by anyone). */
    async settleNotices(projectId: string, url: string) {
      await tx.update(schema.notifications).set({ readAt: sql`coalesce(${schema.notifications.readAt}, now())` })
        .where(and(eq(schema.notifications.sourceType, 'project'), eq(schema.notifications.sourceId, projectId), eq(schema.notifications.url, url)));
    },
  };
}
