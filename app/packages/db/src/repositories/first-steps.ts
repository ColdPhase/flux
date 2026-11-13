import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * What Home's first-steps card reads (#1438) for `packages/core/src/first-steps`. Every read is one person's own facts (their company,
 * role, connections, messages and photo) or whether their company has anyone else or any invite; it makes no access decision.
 */
export function firstStepRows(db: DbExecutor) {
  const exists = async (query: Promise<unknown[]>) => (await query).length > 0;
  return {
    async company(userId: string) {
      const w = schema.workspaces, m = schema.workspaceMembers, u = schema.authUsers, p = schema.projects;
      // The company; a test deployment's people are in isolated workspaces instead, and the shell takes the oldest plain one, as here.
      const [row] = await db.select({ id: w.id, name: w.name, role: m.role, hiddenAt: u.firstStepsHiddenAt }).from(m)
        .innerJoin(w, eq(w.id, m.workspaceId)).innerJoin(u, eq(u.id, m.userId))
        .where(and(eq(m.userId, userId), eq(w.encrypted, false), isNull(w.companyWorkspaceId)))
        .orderBy(desc(w.company), asc(w.createdAt), asc(w.id)).limit(1);
      if (!row) return null;
      const [everyone] = await db.select({ id: p.id }).from(p).where(and(eq(p.workspaceId, row.id), eq(p.visibility, 'workspace')))
        .orderBy(asc(p.createdAt), asc(p.id)).limit(1);
      return { id: row.id, name: row.name, role: row.role, everyoneSpaceId: everyone?.id ?? null, hidden: row.hiddenAt !== null };
    },
    async invitedAnyone(companyId: string) {
      const m = schema.workspaceMembers, i = schema.workspaceInvites;
      const [row] = await db.select({ members: sql<number>`count(*)::int` }).from(m).where(eq(m.workspaceId, companyId));
      return (row?.members ?? 0) > 1 || exists(db.select({ id: i.id }).from(i).where(eq(i.workspaceId, companyId)).limit(1));
    },
    async aiConnected(userId: string) {
      const k = schema.backgroundComputeConnections, a = schema.agentConnections;
      return await exists(db.select({ id: k.id }).from(k).where(and(eq(k.ownerUserId, userId), isNull(k.revokedAt))).limit(1))
        || exists(db.select({ id: a.id }).from(a).where(and(eq(a.ownerUserId, userId), isNull(a.revokedAt))).limit(1));
    },
    async wroteMessage(userId: string, companyId: string) {
      const msg = schema.projectMessages, p = schema.projects;
      // One index probe per space of the company (project_id, author_id, …): never a scan of every message.
      return exists(db.select({ id: msg.id }).from(msg)
        .where(and(eq(msg.authorId, userId), inArray(msg.projectId, db.select({ id: p.id }).from(p).where(eq(p.workspaceId, companyId))))).limit(1));
    },
    async hasPhoto(userId: string) {
      const ph = schema.personPhotos;
      return exists(db.select({ id: ph.id }).from(ph).where(eq(ph.userId, userId)).limit(1));
    },
    async hide(userId: string, at: Date) {
      const u = schema.authUsers;
      await db.update(u).set({ firstStepsHiddenAt: at }).where(and(eq(u.id, userId), isNull(u.firstStepsHiddenAt)));
    },
  };
}
