import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { AssistantJoinRequest } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

type Row = typeof schema.assistantJoinRequests.$inferSelect;
export const assistantJoinView = (row: Row, agentId: string): AssistantJoinRequest => ({
  id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, ownerUserId: row.ownerUserId,
  connectionId: row.connectionId, agentId, state: row.state, version: row.version,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});

/** Rows only. The server authorizes the owner/place or the current project manager before calling these. */
export function assistantJoinRows(tx: DbExecutor) {
  return {
    async forOwner(ownerUserId: string, workspaceId: string) {
      const [row] = await tx.select({ settings: schema.assistantSettings, revokedAt: schema.agentConnections.revokedAt,
        agentName: schema.agents.name, ownerName: schema.authUsers.name }).from(schema.assistantSettings)
        .innerJoin(schema.agentConnections, and(eq(schema.agentConnections.id, schema.assistantSettings.connectionId),
          eq(schema.agentConnections.ownerUserId, ownerUserId), eq(schema.agentConnections.computeSource, 'owner_assistant')))
        .innerJoin(schema.agents, and(eq(schema.agents.id, schema.assistantSettings.agentId), eq(schema.agents.workspaceId, schema.assistantSettings.workspaceId)))
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, ownerUserId))
        .where(and(eq(schema.assistantSettings.ownerUserId, ownerUserId), eq(schema.assistantSettings.workspaceId, workspaceId))).for('share');
      return row && !row.revokedAt ? { ...row.settings, agentName: row.agentName, ownerName: row.ownerName } : null;
    },
    async open(ownerUserId: string, workspaceId: string, connectionId: string, projectId: string) {
      const [existing] = await tx.select().from(schema.assistantJoinRequests).where(and(
        eq(schema.assistantJoinRequests.connectionId, connectionId), eq(schema.assistantJoinRequests.projectId, projectId))).for('update');
      if (existing?.state === 'pending') return { row: existing, created: false };
      if (existing) {
        const [row] = await tx.update(schema.assistantJoinRequests).set({ state: 'pending', version: existing.version + 1, updatedAt: new Date() })
          .where(eq(schema.assistantJoinRequests.id, existing.id)).returning();
        return { row: row!, created: true };
      }
      const [row] = await tx.insert(schema.assistantJoinRequests).values({ id: randomUUID(), ownerUserId, workspaceId, connectionId, projectId }).returning();
      return { row: row!, created: true };
    },
    async peek(projectId: string, requestId: string) {
      return (await tx.select().from(schema.assistantJoinRequests).where(and(eq(schema.assistantJoinRequests.id, requestId),
        eq(schema.assistantJoinRequests.projectId, projectId))))[0] ?? null;
    },
    async find(projectId: string, requestId: string) {
      const [row] = await tx.select().from(schema.assistantJoinRequests).where(and(eq(schema.assistantJoinRequests.id, requestId),
        eq(schema.assistantJoinRequests.projectId, projectId))).for('update');
      return row ?? null;
    },
    async close(requestId: string, state: 'accepted' | 'declined') {
      const [row] = await tx.update(schema.assistantJoinRequests).set({ state, version: sql`${schema.assistantJoinRequests.version} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.assistantJoinRequests.id, requestId), ne(schema.assistantJoinRequests.state, state))).returning();
      return row ?? (await tx.select().from(schema.assistantJoinRequests).where(eq(schema.assistantJoinRequests.id, requestId)))[0]!;
    },
    candidates: (workspaceId: string) => tx.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId)).orderBy(schema.workspaceMembers.userId),
    async markQuestion(id: string) {
      await tx.update(schema.notifications).set({ reason: 'question' }).where(eq(schema.notifications.id, id));
    },
    async snapshotQuestion(identity: { joinRequestId: string; openingVersion: number; assistantId: string; assistantName: string; ownerId: string; ownerName: string }) {
      const snapshots = schema.assistantJoinQuestionIdentitySnapshots;
      const [inserted] = await tx.insert(snapshots).values(identity).onConflictDoNothing()
        .returning({ joinRequestId: snapshots.joinRequestId });
      if (inserted) return;
      const [existing] = await tx.select().from(snapshots).where(and(
        eq(snapshots.joinRequestId, identity.joinRequestId), eq(snapshots.openingVersion, identity.openingVersion)));
      if (!existing || existing.assistantId !== identity.assistantId || existing.assistantName !== identity.assistantName
        || existing.ownerId !== identity.ownerId || existing.ownerName !== identity.ownerName)
        throw new Error('Assistant join-question cycle identity is immutable');
    },
    async linkQuestion(notificationId: string, joinRequestId: string, openingVersion: number) {
      await tx.update(schema.notifications).set({ assistantJoinRequestId: joinRequestId, assistantJoinOpeningVersion: openingVersion })
        .where(eq(schema.notifications.id, notificationId));
      await tx.update(schema.assistantJoinQuestionIdentitySnapshots).set({ notificationLinkedAt: sql`coalesce(${schema.assistantJoinQuestionIdentitySnapshots.notificationLinkedAt}, now())` })
        .where(and(eq(schema.assistantJoinQuestionIdentitySnapshots.joinRequestId, joinRequestId),
          eq(schema.assistantJoinQuestionIdentitySnapshots.openingVersion, openingVersion)));
    },
  };
}
