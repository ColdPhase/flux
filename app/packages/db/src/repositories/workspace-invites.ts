import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { isUuid } from './uuid.js';

/**
 * Invite link rows (F-035, #763 PE-2) for `packages/core/src/access/invites.ts`. Satisfies core's `InviteRepository`
 * structurally and makes no access decision: core evaluates the policy and takes the workspace lock first.
 */
export function workspaceInviteRepository(db: DbExecutor) {
  const i = schema.workspaceInvites;
  return {
    async insert(row: { id: string; workspaceId: string; role: 'admin' | 'member' | 'guest'; email: string | null; tokenHash: string; createdBy: string; expiresAt: Date }) {
      const [created] = await db.insert(i).values(row).returning();
      return created!;
    },

    /** The pending (not used, not revoked, not expired) invites with their creator's name, newest first. */
    pending(workspaceId: string, now: Date) {
      return db.select({ invite: i, creatorName: schema.authUsers.name }).from(i)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, i.createdBy))
        .where(and(eq(i.workspaceId, workspaceId), isNull(i.revokedAt), isNull(i.acceptedAt), gt(i.expiresAt, now)))
        .orderBy(desc(i.createdAt), desc(i.id));
    },

    async pendingCount(workspaceId: string, now: Date): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(i)
        .where(and(eq(i.workspaceId, workspaceId), isNull(i.revokedAt), isNull(i.acceptedAt), gt(i.expiresAt, now)));
      return row?.count ?? 0;
    },

    /** One invite by id with its workspace and creator, optionally `FOR UPDATE` of the invite row. */
    async get(inviteId: string, options: { lock?: boolean } = {}) {
      if (!isUuid(inviteId)) return null;
      const query = db.select({ invite: i, workspaceName: schema.workspaces.name, encrypted: schema.workspaces.encrypted, creatorName: schema.authUsers.name })
        .from(i).innerJoin(schema.workspaces, eq(schema.workspaces.id, i.workspaceId)).innerJoin(schema.authUsers, eq(schema.authUsers.id, i.createdBy))
        .where(eq(i.id, inviteId));
      const [row] = options.lock ? await query.for('update', { of: i }) : await query;
      return row ?? null;
    },

    async memberRole(workspaceId: string, userId: string): Promise<'owner' | 'admin' | 'member' | 'guest' | null> {
      const m = schema.workspaceMembers;
      const [row] = await db.select({ role: m.role }).from(m).where(and(eq(m.workspaceId, workspaceId), eq(m.userId, userId)));
      return row?.role ?? null;
    },

    async revoke(inviteId: string, revokedBy: string, at: Date) {
      await db.update(i).set({ revokedAt: at, revokedBy }).where(eq(i.id, inviteId));
    },

    async markAccepted(inviteId: string, acceptedBy: string, at: Date) {
      await db.update(i).set({ acceptedAt: at, acceptedBy }).where(eq(i.id, inviteId));
    },
  };
}
