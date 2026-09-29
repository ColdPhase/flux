import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Executor } from '@flux/core';

/** A media admission as the signaling gate sees it (#128). */
export interface LiveAdmission {
  id: string;
  liveSessionId: string;
  userId: string;
  authSessionId: string;
  revokedAt: Date | null;
}

/** A revoked admission and the current room of its live session. */
export interface RevokedAdmission {
  id: string;
  userId: string;
  roomId: string;
}

/**
 * Persistence of media admissions. Rows are inserted by the join transaction (`store.ts`)
 * and revoked by the `auth_sessions` deletion trigger (migration 0028); nothing here grants
 * access. Project access is always rechecked by the live use cases.
 */
export interface LiveAdmissionStore {
  find(id: string): Promise<LiveAdmission | null>;
  /** The revoked admissions of one ended auth session. */
  revokedForSession(authSessionId: string): Promise<RevokedAdmission[]>;
  /**
   * Of these ids, the admissions that still stand: unrevoked, and their auth session row
   * exists and has not expired. An expired session no longer authorizes connected media.
   */
  standing(ids: readonly string[]): Promise<Set<string>>;
  /** Rooms of available live sessions, newest activity first, for the reconciliation pass. */
  availableRooms(limit: number): Promise<string[]>;
  /** Removes old rows that can no longer match a connected participant. */
  prune(olderThan: Date, limit: number): Promise<number>;
}

export function liveAdmissionStore(db: Executor): LiveAdmissionStore {
  const admissions = schema.liveAdmissions;
  const sessions = schema.liveSessions;
  return {
    async find(id) {
      const [row] = await db.select({ id: admissions.id, liveSessionId: admissions.liveSessionId,
        userId: admissions.userId, authSessionId: admissions.authSessionId, revokedAt: admissions.revokedAt })
        .from(admissions).where(eq(admissions.id, id));
      return row ?? null;
    },

    async revokedForSession(authSessionId) {
      return db.select({ id: admissions.id, userId: admissions.userId, roomId: sessions.roomId })
        .from(admissions).innerJoin(sessions, eq(sessions.id, admissions.liveSessionId))
        .where(and(eq(admissions.authSessionId, authSessionId), sql`${admissions.revokedAt} IS NOT NULL`));
    },

    async standing(ids) {
      if (!ids.length) return new Set();
      const rows = await db.select({ id: admissions.id }).from(admissions)
        .innerJoin(schema.authSessions, eq(schema.authSessions.id, admissions.authSessionId))
        .where(and(inArray(admissions.id, [...new Set(ids)]), isNull(admissions.revokedAt),
          eq(schema.authSessions.userId, admissions.userId), gt(schema.authSessions.expiresAt, sql`now()`)));
      return new Set(rows.map((row) => row.id));
    },

    async availableRooms(limit) {
      const rows = await db.select({ roomId: sessions.roomId }).from(sessions)
        .where(eq(sessions.state, 'available')).orderBy(sql`${sessions.updatedAt} DESC`, sql`${sessions.id} DESC`).limit(limit);
      return rows.map((row) => row.roomId);
    },

    async prune(olderThan, limit) {
      // Only revoked rows and rows of ended sessions: the admission of a participant that
      // stays connected for days (its token slides with each SFU refresh) is never pruned.
      const result = await db.execute(sql`
        DELETE FROM live_admissions WHERE id IN (
          SELECT a.id FROM live_admissions a
          JOIN live_sessions s ON s.id = a.live_session_id
          WHERE a.issued_at < ${olderThan} AND (a.revoked_at IS NOT NULL OR s.state = 'ended')
          LIMIT ${limit})`);
      return result.rowCount ?? 0;
    },
  };
}
