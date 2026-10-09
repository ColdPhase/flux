import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';

/**
 * Persistence for OIDC back-channel logout (F-024 S3, #314). Each method is one statement, so the
 * receiver holds no transaction while it validates tokens or calls the provider.
 */
export function idpLogoutRepository(db: DbExecutor) {
  return {
    /** Records a logout token id. False when this provider already used it (a replay). Expired ids are pruned here. */
    async consumeJti(providerId: string, jti: string, expiresAt: Date, now: Date): Promise<boolean> {
      await db.execute(sql`DELETE FROM auth_logout_tokens WHERE expires_at < ${now.toISOString()}::timestamptz`);
      const result = await db.execute(sql`
        INSERT INTO auth_logout_tokens (provider_id, jti, expires_at) VALUES (${providerId}, ${jti}, ${expiresAt.toISOString()}::timestamptz)
        ON CONFLICT (provider_id, jti) DO NOTHING RETURNING jti`);
      return (result.rowCount ?? 0) > 0;
    },

    /** The people whose account at this provider has this subject. */
    async usersBySubject(providerId: string, subject: string): Promise<string[]> {
      const result = await db.execute(sql`SELECT user_id AS "userId" FROM auth_accounts WHERE provider_id = ${providerId} AND account_id = ${subject}`);
      return (result.rows as { userId: string }[]).map((row) => row.userId);
    },

    /** Ends the browser sessions created from one provider session (`sid`). Returns the people they belonged to. */
    async endSessionsBySid(providerId: string, sid: string): Promise<string[]> {
      const result = await db.execute(sql`
        DELETE FROM auth_sessions WHERE id IN (SELECT session_id FROM auth_session_identities WHERE method = ${providerId} AND idp_sid = ${sid})
        RETURNING user_id AS "userId"`);
      return [...new Set((result.rows as { userId: string }[]).map((row) => row.userId))];
    },

    /** Ends every browser session of the given people. */
    async endSessionsOf(userIds: string[]): Promise<number> {
      if (!userIds.length) return 0;
      const result = await db.execute(sql`DELETE FROM auth_sessions WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
      return result.rowCount ?? 0;
    },

    /** Revokes the unrevoked MCP refresh tokens of the given people (clients must be authorized again). */
    async revokeMcpRefreshTokens(userIds: string[], now: Date): Promise<number> {
      if (!userIds.length) return 0;
      const result = await db.execute(sql`UPDATE oauth_refresh_token SET revoked = ${now.toISOString()}::timestamptz
        WHERE revoked IS NULL AND user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
      return result.rowCount ?? 0;
    },

    /** Makes the standing checker pick these identities up on its next pass. */
    async dueNow(providerId: string, userIds: string[], now: Date): Promise<void> {
      if (!userIds.length) return;
      await db.execute(sql`UPDATE auth_idp_standing SET next_check_at = ${now.toISOString()}::timestamptz
        WHERE provider_id = ${providerId} AND lease_id IS NULL AND user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`);
    },

    /**
     * Deletes the stored provider token and puts the identity in sign-in required (the provider revoked offline
     * access). Returns the sealed token it removed so the caller can revoke it at the provider.
     */
    async dropToken(providerId: string, userId: string, now: Date): Promise<string | null> {
      const result = await db.execute(sql`
        WITH old AS (SELECT refresh_token_enc FROM auth_idp_standing WHERE user_id = ${userId} AND provider_id = ${providerId}),
        upd AS (UPDATE auth_idp_standing SET refresh_token_enc = NULL, state = 'sign_in_required', reason = 'offline_access_revoked',
          state_changed_at = ${now.toISOString()}::timestamptz, lease_id = NULL, lease_until = NULL
          WHERE user_id = ${userId} AND provider_id = ${providerId} RETURNING 1)
        SELECT (SELECT refresh_token_enc FROM old) AS token, (SELECT count(*) FROM upd)::int AS n`);
      return (result.rows[0] as { token: string | null } | undefined)?.token ?? null;
    },
  };
}
