import { and, eq, gt, ne } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle persistence adapter for the Flux session routes (issues #46, #81). It satisfies the
 * `SessionStore` port declared in `apps/server/src/identity/routes.ts` structurally. Better Auth
 * still creates and reads session rows through its own adapter; this module only lists and
 * deletes them. Every method is scoped to one user, so a caller cannot touch another
 * person's sessions. A deleted row stops authenticating on the next request because the
 * session resolver reads the row every time (no cookie cache).
 */
const s = schema.authSessions;

export interface AuthSessionRecord {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export function createSessionRepository(db: DbExecutor) {
  return {
    /** The user's unexpired sessions, oldest first. */
    async listActive(userId: string): Promise<AuthSessionRecord[]> {
      const rows = await db.select().from(s)
        .where(and(eq(s.userId, userId), gt(s.expiresAt, new Date())))
        .orderBy(s.createdAt);
      return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt, ipAddress: row.ipAddress, userAgent: row.userAgent }));
    },
    /** Deletes one of the user's sessions; false when no such session belongs to the user. */
    async deleteOwned(userId: string, sessionId: string): Promise<boolean> {
      const deleted = await db.delete(s)
        .where(and(eq(s.id, sessionId), eq(s.userId, userId)))
        .returning({ id: s.id });
      return deleted.length > 0;
    },
    /** Deletes every session of the user except `keepSessionId`; returns how many were deleted. */
    async deleteOthers(userId: string, keepSessionId: string): Promise<number> {
      const deleted = await db.delete(s)
        .where(and(eq(s.userId, userId), ne(s.id, keepSessionId)))
        .returning({ id: s.id });
      return deleted.length;
    },
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
