import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';
import type { OidcConfig } from './config.js';

export interface Confirmation {
  /**
   * True when the person is managed by the configured provider and its last confirmation is older than
   * FLUX_OIDC_CONFIRMATION_MAX_AGE (F-024 S2, #312), or has no link to the sole provider under SSO-only
   * (F-024 S5a, #313). Without a provider, ordinary password lifetimes remain in force.
   */
  lapsed(userId: string): Promise<boolean>;
  /** A provider sign-in just vouched for the person. */
  confirm(userId: string, providerId: string): Promise<void>;
  /**
   * Ends one browser session that signed in with the provider once that provider's confirmation lapsed, and
   * says whether it did. A password session is not affected here: removing passwords for managed accounts is S5b.
   */
  endIfLapsed(sessionId: string): Promise<boolean>;
}

export function createConfirmation(db: Database, oidc: OidcConfig | null, now: () => Date = () => new Date(), requireProviderLink = oidc !== null): Confirmation {
  const cutoff = () => new Date(now().getTime() - oidc!.confirmationMaxAgeMs).toISOString();
  // The newest of the provider sign-in (auth_accounts.confirmed_at, kept even with the standing check off) and the
  // standing check's last success (auth_idp_standing.confirmed_at, S4). A managed account with neither is lapsed.
  const lapsedSql = (where: ReturnType<typeof sql>) => sql`
    SELECT 1 FROM auth_accounts a
    LEFT JOIN auth_idp_standing st ON st.user_id = a.user_id AND st.provider_id = a.provider_id
    WHERE ${where} AND a.provider_id = ${oidc!.providerId}
      AND (GREATEST(a.confirmed_at, st.confirmed_at) IS NULL OR GREATEST(a.confirmed_at, st.confirmed_at) < ${cutoff()}::timestamptz)
    LIMIT 1`;
  return {
    async lapsed(userId) {
      if (!oidc) return false;
      // An unlinked password account must not retain bearer/refresh authority after SSO cutover.
      // Both token minting and MCP requests read this gate; absence of an IdP row is a refusal.
      const [link] = await db.select({ id: schema.authAccounts.id }).from(schema.authAccounts)
        .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, oidc.providerId))).limit(1);
      if (!link) return requireProviderLink;
      return ((await db.execute(lapsedSql(sql`a.user_id = ${userId}`))).rowCount ?? 0) > 0;
    },
    async confirm(userId, providerId) {
      await db.update(schema.authAccounts).set({ confirmedAt: now() })
        .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, providerId)));
    },
    async endIfLapsed(sessionId) {
      if (!oidc) return false;
      const rows = await db.select({ userId: schema.authSessions.userId }).from(schema.authSessions)
        .innerJoin(schema.authSessionIdentities, eq(schema.authSessionIdentities.sessionId, schema.authSessions.id))
        .where(and(eq(schema.authSessions.id, sessionId), eq(schema.authSessionIdentities.method, oidc.providerId))).limit(1);
      const userId = rows[0]?.userId;
      if (!userId || !await this.lapsed(userId)) return false;
      await db.delete(schema.authSessions).where(eq(schema.authSessions.id, sessionId));
      return true;
    },
  };
}
