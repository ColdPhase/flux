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

    /** The company an encrypted space belongs to (F-037, #874), or null. */
    async companyOf(workspaceId: string): Promise<string | null> {
      if (!isUuid(workspaceId)) return null;
      const [row] = await db.select({ company: schema.workspaces.companyWorkspaceId }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      return row?.company ?? null;
    },

    /** The encrypted spaces of this company that the person is in. */
    async spacesOfCompanyWith(companyId: string, userId: string): Promise<string[]> {
      const rows = await db.select({ id: schema.workspaces.id }).from(schema.workspaces)
        .innerJoin(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, schema.workspaces.id), eq(schema.workspaceMembers.userId, userId)))
        .where(eq(schema.workspaces.companyWorkspaceId, companyId)).orderBy(asc(schema.workspaces.id));
      return rows.map((row) => row.id);
    },

    async hasProject(workspaceId: string): Promise<boolean> {
      const [row] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.workspaceId, workspaceId)).limit(1);
      return !!row;
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
      return db.select({ member: schema.workspaceMembers, email: schema.authUsers.email, name: schema.authUsers.name, lastActiveAt: schema.authUsers.lastActiveAt, showLastActive: schema.authUsers.showLastActive })
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

    /** Someone who became a guest is no longer a space admin: their `manager` grants become plain membership, held for when they stop being one. */
    async endSpaceAdmin(workspaceId: string, userId: string) {
      await db.update(schema.projectGrants).set({ role: 'contributor', adminHeld: true, updatedAt: new Date() })
        .where(and(eq(schema.projectGrants.workspaceId, workspaceId), eq(schema.projectGrants.userId, userId), eq(schema.projectGrants.role, 'manager')));
    },

    /** A guest who is a member (or more) again is an admin again of the spaces they were an admin of; nothing is held any more. */
    async restoreSpaceAdmin(workspaceId: string, userId: string) {
      await db.update(schema.projectGrants).set({ role: 'manager', adminHeld: false, updatedAt: new Date() })
        .where(and(eq(schema.projectGrants.workspaceId, workspaceId), eq(schema.projectGrants.userId, userId), eq(schema.projectGrants.adminHeld, true)));
    },

    /** Whether the account is in the workspace now. */
    async isMember(workspaceId: string, userId: string, options: { lock?: boolean } = {}) {
      const query = db.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
      const [row] = options.lock ? await query.for('share') : await query;
      return !!row;
    },

    /**
     * Remembers someone who is leaving or being removed, for Restore (#1424 F): their role, their space grants and their direct messages,
     * read from the membership that is still there. Call it before `deleteMember`, whose cascade takes the grants and DM places.
     */
    async recordRemoved(workspaceId: string, userId: string, removedBy: string) {
      await db.execute(sql`INSERT INTO workspace_removed_people (workspace_id, user_id, removed_by, removed_at, role, kept)
        SELECT m.workspace_id, m.user_id, ${removedBy}, now(), m.role, jsonb_build_object(
          'spaces', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.project_id, 'role', g.role) ORDER BY g.created_at, g.project_id)
            FROM project_grants g WHERE g.workspace_id = m.workspace_id AND g.user_id = m.user_id), '[]'::jsonb),
          'dms', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.dm_id, 'joinedAt', p.joined_at) ORDER BY p.joined_at, p.dm_id)
            FROM dm_participants p WHERE p.workspace_id = m.workspace_id AND p.user_id = m.user_id), '[]'::jsonb))
        FROM workspace_members m WHERE m.workspace_id = ${workspaceId}::uuid AND m.user_id = ${userId}
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET removed_by = EXCLUDED.removed_by, removed_at = EXCLUDED.removed_at,
          role = EXCLUDED.role, kept = EXCLUDED.kept`);
    },

    /**
     * Everyone who left or was removed and has not joined again, newest first, with the role they had and how many of the spaces they
     * were in still exist besides Everyone (what Restore brings back).
     */
    async removedPeople(workspaceId: string) {
      const rows = (await db.execute(sql`SELECT r.user_id, r.removed_at, u.email, u.name, r.role, r.kept,
          (SELECT count(*)::int FROM jsonb_array_elements(r.kept -> 'spaces') k JOIN projects p ON p.id = (k ->> 'id')::uuid
            WHERE p.workspace_id = r.workspace_id AND p.visibility <> 'workspace') AS spaces
        FROM workspace_removed_people r JOIN auth_users u ON u.id = r.user_id
        WHERE r.workspace_id = ${workspaceId}::uuid ORDER BY r.removed_at DESC`)).rows as
        { user_id: string; removed_at: Date | string; email: string; name: string; role: WorkspaceRole; kept: schema.RemovedPersonKept; spaces: number }[];
      return rows.map((row) => ({ userId: row.user_id, removedAt: row.removed_at instanceof Date ? row.removed_at : new Date(row.removed_at),
        email: row.email, name: row.name, role: row.role, kept: row.kept, spaces: row.spaces }));
    },

    /**
     * Puts back what a removal kept (#1424 F), for a person who is a member again in this transaction: each kept space that still exists in
     * this workspace gets its grant back, and each kept direct message its place (with the time they first joined it). Rows that vanished
     * meanwhile are skipped (held `FOR KEY SHARE` first, so a delete racing this waits or wins cleanly). Returns what was put back.
     */
    async restoreKept(workspaceId: string, userId: string, kept: schema.RemovedPersonKept, restoredBy: string) {
      const spaceIds = kept.spaces.map((space) => space.id).filter(isUuid);
      const dmIds = kept.dms.map((dm) => dm.id).filter(isUuid);
      const spaces: { projectId: string; grantId: string; role: 'manager' | 'contributor' }[] = [];
      if (spaceIds.length) {
        const live = new Set(((await db.execute(sql`SELECT id::text AS id FROM projects WHERE id = ANY(${sql.param(spaceIds)}::uuid[]) AND workspace_id = ${workspaceId}::uuid
          FOR KEY SHARE`)).rows as { id: string }[]).map((row) => row.id));
        for (const space of kept.spaces) {
          if (!live.has(space.id)) continue;
          const role = space.role === 'manager' ? 'manager' : 'contributor';
          const [row] = (await db.execute(sql`INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by)
            VALUES (gen_random_uuid(), ${workspaceId}::uuid, ${space.id}::uuid, ${userId}, ${role}, ${restoredBy})
            ON CONFLICT DO NOTHING RETURNING id::text AS id`)).rows as { id: string }[];
          if (row) spaces.push({ projectId: space.id, grantId: row.id, role });
        }
      }
      const dms: string[] = [];
      if (dmIds.length) {
        const live = new Set(((await db.execute(sql`SELECT id::text AS id FROM dms WHERE id = ANY(${sql.param(dmIds)}::uuid[]) AND workspace_id = ${workspaceId}::uuid
          FOR KEY SHARE`)).rows as { id: string }[]).map((row) => row.id));
        for (const dm of kept.dms) {
          if (!live.has(dm.id)) continue;
          const inserted = (await db.execute(sql`INSERT INTO dm_participants (workspace_id, dm_id, user_id, joined_at)
            VALUES (${workspaceId}::uuid, ${dm.id}::uuid, ${userId}, ${dm.joinedAt}::timestamptz) ON CONFLICT DO NOTHING RETURNING dm_id`)).rows.length > 0;
          if (!inserted) continue;
          await db.execute(sql`UPDATE dms SET version = version + 1 WHERE id = ${dm.id}::uuid`);
          dms.push(dm.id);
        }
      }
      return { spaces, dms };
    },

    /** The name of the company this person left or was removed from and has not joined again, or null. */
    async removedFromCompany(userId: string) {
      const [row] = await db.select({ name: schema.workspaces.name }).from(schema.workspaceRemovedPeople)
        .innerJoin(schema.workspaces, and(eq(schema.workspaces.id, schema.workspaceRemovedPeople.workspaceId), eq(schema.workspaces.company, true)))
        .where(eq(schema.workspaceRemovedPeople.userId, userId)).orderBy(desc(schema.workspaceRemovedPeople.removedAt)).limit(1);
      return row?.name ?? null;
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
