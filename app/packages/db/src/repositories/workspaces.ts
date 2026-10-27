import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { WorkspaceRole } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { isUuid } from './uuid.js';

/**
 * Workspace, membership and AI policy rows for the use cases in `packages/core/src/access/{workspaces,members,workspace-ai}.ts`
 * (issues #46, #91). It satisfies core's `WorkspaceRepository` port structurally (this package does not depend on
 * core) and makes no access decision: core evaluates the policy first and holds the locks these methods take in
 * the order it documents. Each method is the statement the use case ran before, unchanged. Bind it to the
 * transaction that decides, so a lock holds until that transaction commits.
 */

export type AccountLookup = { userId: string } | { email: string };

export function workspaceRepository(db: DbExecutor) {
  return {
    /** The workspace and its first owner. */
    async createWithOwner(row: { id: string; name: string; createdBy: string }) {
      const [workspace] = await db.insert(schema.workspaces).values({ id: row.id, name: row.name, createdBy: row.createdBy }).returning();
      await db.insert(schema.workspaceMembers).values({ workspaceId: row.id, userId: row.createdBy, role: 'owner', createdBy: row.createdBy });
      return workspace!;
    },

    /** The person's workspaces with their role, oldest first. */
    forMember(userId: string) {
      return db.select({ workspace: schema.workspaces, role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
        .where(eq(schema.workspaceMembers.userId, userId))
        .orderBy(asc(schema.workspaces.createdAt), asc(schema.workspaces.id));
    },

    async workspaceOfAgent(agentId: string): Promise<string | null> {
      const [agent] = await db.select({ workspaceId: schema.agents.workspaceId }).from(schema.agents).where(eq(schema.agents.id, agentId));
      return agent?.workspaceId ?? null;
    },

    async get(workspaceId: string) {
      const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      return row ?? null;
    },

    /** The AI policy rows of the workspaces, with the name of whoever last changed each. */
    aiPolicies(workspaceIds: string[]) {
      const p = schema.workspaceAiPolicies;
      return db.select({ workspaceId: p.workspaceId, state: p.state, version: p.version, changedAt: p.changedAt,
        changedBy: p.changedBy, changedByName: schema.authUsers.name }).from(p)
        .leftJoin(schema.authUsers, eq(schema.authUsers.id, p.changedBy)).where(inArray(p.workspaceId, workspaceIds));
    },

    /** The workspace's AI policy row `FOR UPDATE` (the flip's first lock). */
    async lockAiPolicy(workspaceId: string) {
      const p = schema.workspaceAiPolicies;
      const [row] = await db.select().from(p).where(eq(p.workspaceId, workspaceId)).for('update');
      return row ?? null;
    },

    /** The next state with the next epoch and version. */
    async updateAiPolicy(workspaceId: string, state: 'allowed' | 'blocked', changedBy: string): Promise<{ epoch: number }> {
      const p = schema.workspaceAiPolicies;
      const [updated] = await db.update(p).set({ state, epoch: sql`${p.epoch} + 1`, version: sql`${p.version} + 1`, changedBy, changedAt: new Date() })
        .where(eq(p.workspaceId, workspaceId)).returning({ epoch: p.epoch });
      return updated!;
    },

    members(workspaceId: string) {
      return db.select({ member: schema.workspaceMembers, email: schema.authUsers.email, name: schema.authUsers.name })
        .from(schema.workspaceMembers)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.workspaceMembers.userId))
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
        .orderBy(asc(schema.workspaceMembers.createdAt), asc(schema.workspaceMembers.userId));
    },

    /**
     * `FOR NO KEY UPDATE` serializes membership changes without blocking inserts that only
     * reference the workspace (their foreign-key checks take KEY SHARE).
     */
    async lock(workspaceId: string): Promise<void> {
      if (!isUuid(workspaceId)) return;
      await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).for('no key update');
    },

    async ownerCount(workspaceId: string): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, 'owner')));
      return row?.count ?? 0;
    },

    async findAccount(lookup: AccountLookup) {
      const where = 'userId' in lookup ? eq(schema.authUsers.id, lookup.userId) : eq(schema.authUsers.email, lookup.email);
      const [user] = await db.select().from(schema.authUsers).where(where);
      return user ?? null;
    },

    /** The new membership, or null when the account is already a member. */
    async insertMember(row: { workspaceId: string; userId: string; role: WorkspaceRole; createdBy: string }) {
      const inserted = await db.insert(schema.workspaceMembers).values(row).onConflictDoNothing().returning();
      return inserted[0] ?? null;
    },

    /** A membership row `FOR UPDATE`. */
    async lockMember(workspaceId: string, userId: string) {
      const [target] = await db.select().from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId))).for('update');
      return target ?? null;
    },

    async setRole(workspaceId: string, userId: string, role: WorkspaceRole) {
      const [updated] = await db.update(schema.workspaceMembers).set({ role, updatedAt: new Date() })
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId))).returning();
      return updated!;
    },

    async deleteMember(workspaceId: string, userId: string): Promise<void> {
      await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
    },
  };
}
