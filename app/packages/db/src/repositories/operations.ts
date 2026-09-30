import { and, gt, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Operator maintenance for `./flux restore` (issue #123). A restore brings back the agent
 * connections and OAuth tokens as they were when the backup was taken, so a connection revoked
 * after that moment would be live again. `revokeAll` ends every agent connection and revokes
 * every OAuth access and refresh token, so each external client must be connected again.
 */
export function agentAccessOperations(db: DbExecutor) {
  const now = sql`now()`;
  return {
    async status() {
      const [connections] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.agentConnections)
        .where(isNull(schema.agentConnections.revokedAt));
      const [refresh] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.oauthRefreshToken)
        .where(and(isNull(schema.oauthRefreshToken.revoked), gt(schema.oauthRefreshToken.expiresAt, now)));
      return { activeConnections: connections?.count ?? 0, liveRefreshTokens: refresh?.count ?? 0 };
    },

    /** Call inside one transaction. */
    async revokeAll() {
      const connections = await db.update(schema.agentConnections).set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(isNull(schema.agentConnections.revokedAt)).returning({ id: schema.agentConnections.id });
      const refresh = await db.update(schema.oauthRefreshToken).set({ revoked: new Date() })
        .where(isNull(schema.oauthRefreshToken.revoked)).returning({ id: schema.oauthRefreshToken.id });
      const access = await db.update(schema.oauthAccessToken).set({ revoked: new Date() })
        .where(isNull(schema.oauthAccessToken.revoked)).returning({ id: schema.oauthAccessToken.id });
      return { connections: connections.length, refreshTokens: refresh.length, accessTokens: access.length };
    },
  };
}
