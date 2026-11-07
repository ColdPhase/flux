import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { WorkspaceRole } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { isUuid } from './uuid.js';

/**
 * Workspace and membership rows for the use cases in `packages/core/src/access/{workspaces,members}.ts`
 * (issues #46, #91). It satisfies core's `WorkspaceRepository` port structurally (this package does not depend on
 * core) and makes no access decision: core evaluates the policy first and holds the locks these methods take in
 * the order it documents. Each method is the statement the use case ran before, unchanged. Bind it to the
 * transaction that decides, so a lock holds until that transaction commits.
 */

export type AccountLookup = { userId: string } | { email: string };

export function workspaceRepository(db: DbExecutor) {
  return {
    /** The workspace and its first owner; `company` marks the one company workspace (F-037). */
    async createWithOwner(row: { id: string; name: string; createdBy: string; company?: boolean }) {
      const [workspace] = await db.insert(schema.workspaces).values({ id: row.id, name: row.name, createdBy: row.createdBy, company: row.company ?? false }).returning();
      await db.insert(schema.workspaceMembers).values({ workspaceId: row.id, userId: row.createdBy, role: 'owner', createdBy: row.createdBy });
      return workspace!;
    },

    /** F-037: company setup runs one at a time, under a transaction-scoped advisory lock. */
    async lockCompanySetup(): Promise<void> {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('flux.company_setup'))`);
    },

    /** The company workspace (F-037), or null before setup. */
    async company() {
      const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.company, true));
      return row ?? null;
    },

    /** A new name, one version on. */
    async rename(workspaceId: string, name: string) {
      const [row] = await db.update(schema.workspaces).set({ name, version: sql`${schema.workspaces.version} + 1`, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspaceId)).returning();
      return row!;
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
      // Joining again, by any path, takes the person off the company's removed list.
      if (inserted[0]) await db.delete(schema.workspaceRemovedPeople).where(and(eq(schema.workspaceRemovedPeople.workspaceId, row.workspaceId), eq(schema.workspaceRemovedPeople.userId, row.userId)));
      return inserted[0] ?? null;
    },

    /** Someone who became a guest is no longer a space admin: their `manager` grants become plain membership. */
    async endSpaceAdmin(workspaceId: string, userId: string) {
      await db.update(schema.projectGrants).set({ role: 'contributor', updatedAt: new Date() })
        .where(and(eq(schema.projectGrants.workspaceId, workspaceId), eq(schema.projectGrants.userId, userId), eq(schema.projectGrants.role, 'manager')));
    },

    /** Whether the account is in the workspace now. */
    async isMember(workspaceId: string, userId: string) {
      const [row] = await db.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
      return !!row;
    },

    /** Remembers someone who left or was removed, for Restore. */
    async recordRemoved(workspaceId: string, userId: string, removedBy: string) {
      await db.insert(schema.workspaceRemovedPeople).values({ workspaceId, userId, removedBy })
        .onConflictDoUpdate({ target: [schema.workspaceRemovedPeople.workspaceId, schema.workspaceRemovedPeople.userId], set: { removedBy, removedAt: new Date() } });
    },

    /** Everyone who left or was removed and has not joined again, newest first. */
    async removedPeople(workspaceId: string) {
      const rows = await db.select({ userId: schema.workspaceRemovedPeople.userId, removedAt: schema.workspaceRemovedPeople.removedAt,
        email: schema.authUsers.email, name: schema.authUsers.name })
        .from(schema.workspaceRemovedPeople).innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.workspaceRemovedPeople.userId))
        .where(eq(schema.workspaceRemovedPeople.workspaceId, workspaceId)).orderBy(desc(schema.workspaceRemovedPeople.removedAt));
      return rows;
    },

    /** Whether this person is on the removed list. */
    async isRemoved(workspaceId: string, userId: string) {
      const [row] = await db.select({ userId: schema.workspaceRemovedPeople.userId }).from(schema.workspaceRemovedPeople)
        .where(and(eq(schema.workspaceRemovedPeople.workspaceId, workspaceId), eq(schema.workspaceRemovedPeople.userId, userId)));
      return !!row;
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
