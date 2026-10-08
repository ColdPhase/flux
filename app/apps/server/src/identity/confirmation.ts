import { and, eq, lt, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';
import type { OidcConfig } from './config.js';

/** What a refused person or client is told. ASCII only: it travels in a WWW-Authenticate parameter. */
export const CONFIRMATION_LAPSED = 'Your identity provider has not confirmed this account recently. Sign in again.';

export interface Confirmation {
  /**
   * True when the person is managed by the configured provider and its last confirmation is older than
   * FLUX_OIDC_CONFIRMATION_MAX_AGE (F-024 S2, #312). A password-only account, or any account while no provider
   * is configured, is never lapsed and keeps its ordinary lifetimes.
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

export function createConfirmation(db: Database, oidc: OidcConfig | null, now: () => Date = () => new Date()): Confirmation {
  const cutoff = () => new Date(now().getTime() - oidc!.confirmationMaxAgeMs);
  // A managed account with no recorded confirmation has never been vouched for; it is lapsed.
  const stale = (userId: string) => and(
    eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, oidc!.providerId),
    sql`(${schema.authAccounts.confirmedAt} IS NULL OR ${lt(schema.authAccounts.confirmedAt, cutoff())})`);
  return {
    async lapsed(userId) {
      if (!oidc) return false;
      const rows = await db.select({ id: schema.authAccounts.id }).from(schema.authAccounts).where(stale(userId)).limit(1);
      return rows.length > 0;
    },
    async confirm(userId, providerId) {
      await db.update(schema.authAccounts).set({ confirmedAt: now() })
        .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, providerId)));
    },
    async endIfLapsed(sessionId) {
      if (!oidc) return false;
      const rows = await db.select({ userId: schema.authSessions.userId }).from(schema.authSessions)
        .innerJoin(schema.authSessionIdentities, eq(schema.authSessionIdentities.sessionId, schema.authSessions.id))
        .innerJoin(schema.authAccounts, and(eq(schema.authAccounts.userId, schema.authSessions.userId),
          eq(schema.authAccounts.providerId, schema.authSessionIdentities.method)))
        .where(and(eq(schema.authSessions.id, sessionId), eq(schema.authSessionIdentities.method, oidc.providerId),
          sql`(${schema.authAccounts.confirmedAt} IS NULL OR ${lt(schema.authAccounts.confirmedAt, cutoff())})`)).limit(1);
      if (!rows.length) return false;
      await db.delete(schema.authSessions).where(eq(schema.authSessions.id, sessionId));
      return true;
    },
  };
}
