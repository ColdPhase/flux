import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { visibleAgentIdentity } from './agents.js';
import { projectGoalRows } from './project-goals.js';
import { projectLevelSql, visibleProjectsSql, type AccessActor, type AccessPrincipal } from './access.js';
import type { DbExecutor } from './push.js';
import { isUuid } from './uuid.js';

/**
 * Project, grant and audience rows for `packages/core/src/access/{projects,grants}.ts` (issues #46, #91). It satisfies
 * core's `ProjectRepository` port structurally and makes no access decision: core evaluates the policy first and
 * takes the locks here in its documented order (the project row `FOR NO KEY UPDATE` before a grant change, the
 * grant row `FOR UPDATE`). PostgreSQL's unique and foreign-key violations of a grant write are returned as typed
 * results, so core raises its own `ConflictError`.
 */

type GrantRow = typeof schema.projectGrants.$inferSelect;
export type GrantWrite = { grant: GrantRow } | { conflict: 'GRANT_CONFLICT' | 'GRANTEE_REMOVED' };

function pgCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  const code = candidate?.code ?? candidate?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A grant write that PostgreSQL rejects for a reason the use case names; any other error is the caller's. */
async function writeGrant(write: () => Promise<GrantRow | undefined>): Promise<GrantWrite> {
  try {
    return { grant: (await write())! };
  } catch (error) {
    if (pgCode(error) === '23505') return { conflict: 'GRANT_CONFLICT' };
    // The composite foreign key rejects a grantee whose membership was removed concurrently.
    if (pgCode(error) === '23503') return { conflict: 'GRANTEE_REMOVED' };
    throw error;
  }
}

export function projectRepository(db: DbExecutor) {
  return {
    /**
     * Taken before a grant change: conflicts with the `FOR SHARE` lock that mutations hold on the project while
     * they decide (the access reader's `lockProjectAccess`), including for grants that do not exist yet, without
     * blocking inserts that only reference the project.
     */
    async lockForGrantChange(projectId: string): Promise<void> {
      if (!isUuid(projectId)) return;
      await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('no key update');
    },

    async insert(row: { id: string; workspaceId: string; name: string; visibility: 'workspace' | 'restricted'; views: string[]; createdBy: string }) {
      const [created] = await db.insert(schema.projects).values(row).returning();
      return created!;
    },

    async get(projectId: string) {
      const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
      return row ?? null;
    },

    async setViews(projectId: string, views: string[]) {
      const [row] = await db.update(schema.projects).set({ views, version: sql`${schema.projects.version} + 1`, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId)).returning();
      return row!;
    },

    /** The goal each project shows (#520): its current goal, or else its most recently reached one. */
    shownGoals: (projectIds: string[]) => projectGoalRows(db).shown(projectIds),

    /** One page of the projects the actor can see, with their level; the filter applies before count and page. */
    async listVisible(actor: AccessActor, page: { limit: number; offset: number }) {
      const filter = visibleProjectsSql(actor);
      const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.projects).where(filter);
      const rows = await db.select({ project: schema.projects, level: projectLevelSql(actor, schema.projects.id, schema.projects.visibility).mapWith(Number) })
        .from(schema.projects).where(filter)
        .orderBy(asc(schema.projects.createdAt), asc(schema.projects.id))
        .limit(page.limit).offset(page.offset);
      return { total: counted?.count ?? 0, rows };
    },

    /** The project's grants, leaving out the agents the principal may not see. */
    listGrants(principal: AccessPrincipal, projectId: string) {
      return db.select().from(schema.projectGrants).where(and(eq(schema.projectGrants.projectId, projectId), sql`(${schema.projectGrants.agentId} is null or ${visibleAgentIdentity(principal, projectId, sql`${schema.projectGrants.agentId}`)})`))
        .orderBy(asc(schema.projectGrants.createdAt), asc(schema.projectGrants.id));
    },

    /** The workspace's people, for the audience of a project. */
    members(workspaceId: string) {
      return db.select({ id: schema.workspaceMembers.userId, name: schema.authUsers.name })
        .from(schema.workspaceMembers)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.workspaceMembers.userId))
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    },

    /** The workspace's unrevoked agents this principal may see in the project. */
    audienceAgents(principal: AccessPrincipal, projectId: string, workspaceId: string) {
      return db.select({ id: schema.agents.id, name: schema.agents.name, ownerUserId: schema.agents.ownerUserId }).from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt), visibleAgentIdentity(principal, projectId)));
    },

    async member(workspaceId: string, userId: string) {
      const [member] = await db.select().from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
      return member ?? null;
    },

    /** The workspace's unrevoked agent with this id, or null. */
    async activeAgent(workspaceId: string, agentId: string) {
      const [agent] = await db.select().from(schema.agents)
        .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.revokedAt)));
      return agent ?? null;
    },

    /** The principal's grant on the project `FOR UPDATE`. */
    async lockGrantOf(projectId: string, target: { kind: 'human' | 'agent'; id: string }) {
      const principalColumn = target.kind === 'human' ? schema.projectGrants.userId : schema.projectGrants.agentId;
      const [existing] = await db.select().from(schema.projectGrants)
        .where(and(eq(schema.projectGrants.projectId, projectId), eq(principalColumn, target.id))).for('update');
      return existing ?? null;
    },

    /** A grant of the project by id `FOR UPDATE`. */
    async lockGrant(projectId: string, grantId: string) {
      const [grant] = await db.select().from(schema.projectGrants)
        .where(and(eq(schema.projectGrants.id, grantId), eq(schema.projectGrants.projectId, projectId))).for('update');
      return grant ?? null;
    },

    updateGrant(grantId: string, role: GrantRow['role'], createdBy: string): Promise<GrantWrite> {
      return writeGrant(async () => (await db.update(schema.projectGrants).set({ role, createdBy, updatedAt: new Date() })
        .where(eq(schema.projectGrants.id, grantId)).returning())[0]);
    },

    insertGrant(row: { id: string; workspaceId: string; projectId: string; role: GrantRow['role']; createdBy: string; userId: string | null; agentId: string | null }): Promise<GrantWrite> {
      return writeGrant(async () => (await db.insert(schema.projectGrants).values(row).returning())[0]);
    },

    async memberRole(workspaceId: string, userId: string) {
      const [member] = await db.select({ role: schema.workspaceMembers.role }).from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
      return member?.role ?? null;
    },

    async deleteGrant(grantId: string): Promise<void> {
      await db.delete(schema.projectGrants).where(eq(schema.projectGrants.id, grantId));
    },
  };
}
