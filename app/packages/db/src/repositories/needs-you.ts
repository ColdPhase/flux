import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { toDecisionRecord } from './work.js';

/**
 * Drizzle rows for the Inbox "Needs you" queue (#342). They satisfy the `NeedsYouRepository` port of
 * `packages/core/src/needs-you/ports.ts` structurally and make no access decisions: the core use case
 * passes only projects the policy lets the person read, and decides what they may accept.
 */

const s = schema.needsYouStates;
const d = schema.projectDecisions;
const n = schema.notifications;

export function needsYouRows(db: DbExecutor) {
  return {
    async states(userId: string) {
      const rows = await db.select().from(s).where(eq(s.userId, userId));
      return rows.map((row) => ({ key: row.itemKey, state: row.state, until: row.until, untilWorkId: row.untilWorkId, updatedAt: row.updatedAt }));
    },

    async putState(userId: string, key: string, value: { state: 'done' | 'declined' | 'snoozed'; until: Date | null; untilWorkId: string | null }) {
      await db.insert(s).values({ userId, itemKey: key, ...value }).onConflictDoUpdate({
        target: [s.userId, s.itemKey], set: { ...value, updatedAt: sql`now()` },
      });
    },

    async deleteStates(userId: string, keys: string[]) {
      if (!keys.length) return;
      await db.delete(s).where(and(eq(s.userId, userId), inArray(s.itemKey, keys)));
    },

    /** Proposed decisions of these projects, newest first. */
    async proposedDecisions(projectIds: string[], limit: number) {
      if (!projectIds.length) return [];
      const rows = await db.select().from(d).where(and(inArray(d.projectId, projectIds), eq(d.status, 'proposed'))).orderBy(desc(d.createdAt)).limit(limit);
      return rows.map(toDecisionRecord);
    },

    /** Open suggestions made by agents this person connected, in these (already readable) projects, newest first (#661). */
    async agentProposals(userId: string, projectIds: string[], limit: number) {
      if (!projectIds.length) return [];
      const p = schema.agentProposals;
      const v = schema.projectMaterialVersions;
      const rows = await db.select({ proposal: p, agentName: schema.agents.name, title: v.title }).from(p)
        .innerJoin(schema.agents, eq(schema.agents.id, p.agentId))
        .innerJoin(v, and(eq(v.materialId, p.sourceMaterialId), eq(v.version, p.sourceMaterialVersion)))
        .where(and(eq(p.ownerUserId, userId), eq(p.status, 'proposed'), inArray(p.projectId, projectIds)))
        .orderBy(desc(p.createdAt)).limit(limit);
      return rows.map((row) => ({
        id: row.proposal.id, projectId: row.proposal.projectId, agentId: row.proposal.agentId, agentName: row.agentName,
        fact: row.proposal.fact, interpretation: row.proposal.interpretation, suggestedAction: row.proposal.suggestedAction,
        source: { materialId: row.proposal.sourceMaterialId, title: row.title, version: row.proposal.sourceMaterialVersion },
        createdAt: row.proposal.createdAt,
      }));
    },

    /** Whether the person's own notification exists; read or unread is set on it. */
    async setNotificationRead(userId: string, id: string, read: boolean) {
      const rows = await db.update(n).set({ readAt: read ? sql`coalesce(${n.readAt}, now())` : null })
        .where(and(eq(n.userId, userId), eq(n.id, id))).returning({ id: n.id });
      return rows.length > 0;
    },

    /** Members of the project's workspace, by name: candidates only; the policy decides who may act. */
    async workspaceMembersOfProject(projectId: string, limit: number) {
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.projects)
        .innerJoin(schema.workspaceMembers, eq(schema.workspaceMembers.workspaceId, schema.projects.workspaceId))
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.workspaceMembers.userId))
        .where(eq(schema.projects.id, projectId)).orderBy(schema.authUsers.name).limit(limit);
      return rows;
    },

    /** Statuses of tasks by id, for "when it is done" snoozes. */
    async workStatuses(ids: string[]) {
      if (!ids.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.projectWorkItems.id, status: schema.projectWorkItems.status }).from(schema.projectWorkItems)
        .where(inArray(schema.projectWorkItems.id, ids));
      return new Map(rows.map((row) => [row.id, row.status as string]));
    },
  };
}
