import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Persistence for the standing check of a person's account at the identity provider (F-024 S4, #311).
 * The sealed refresh token and the standing live in `auth_idp_standing` (migration 0070). Nothing here
 * calls the provider or opens a transaction: the checker claims a row with a short lease, releases every
 * database resource, calls the provider, and writes the outcome with a second short statement.
 */
const s = schema.authIdpStanding;

export type IdpStandingState = 'ok' | 'sign_in_required';
export type IdpCheckOutcome = 'success' | 'sign_in_required' | 'unknown';

export interface IdpStandingClaim { userId: string; providerId: string; refreshTokenEnc: string; leaseId: string }

export type IdpCheckResult =
  | { outcome: 'success'; refreshTokenEnc?: string }
  | { outcome: 'sign_in_required'; reason: string }
  | { outcome: 'unknown' };

/** The row ids come from `claim`; the clock is a parameter so tests need no sleeping. */
export function idpStandingRepository(db: DbExecutor) {
  return {
    /**
     * A successful provider sign-in: stores the sealed offline token, clears sign-in required and marks the
     * identity confirmed now. Returns the token it replaced, so the caller can revoke it at the provider.
     */
    async record(userId: string, providerId: string, refreshTokenEnc: string, now: Date, nextCheckAt: Date): Promise<string | null> {
      const [previous] = await db.select({ token: s.refreshTokenEnc }).from(s).where(and(eq(s.userId, userId), eq(s.providerId, providerId)));
      await db.insert(s).values({ userId, providerId, state: 'ok', refreshTokenEnc, confirmedAt: now, stateChangedAt: now, nextCheckAt })
        .onConflictDoUpdate({ target: [s.userId, s.providerId], set: {
          state: 'ok', reason: null, refreshTokenEnc, confirmedAt: now, nextCheckAt, leaseId: null, leaseUntil: null,
          stateChangedAt: sql`CASE WHEN ${s.state} = 'ok' THEN ${s.stateChangedAt} ELSE ${now} END`,
        } });
      return previous?.token ?? null;
    },

    /** True when any of the person's provider identities is in sign-in required. Cheap enough for every request. */
    async refuses(userId: string): Promise<boolean> {
      const rows = await db.select({ userId: s.userId }).from(s).where(and(eq(s.userId, userId), eq(s.state, 'sign_in_required'))).limit(1);
      return rows.length > 0;
    },

    /** The state of one identity, or null when the person has no row for the provider. */
    async state(userId: string, providerId: string): Promise<{ state: IdpStandingState; reason: string | null } | null> {
      const [row] = await db.select({ state: s.state, reason: s.reason }).from(s).where(and(eq(s.userId, userId), eq(s.providerId, providerId)));
      return row ? { state: row.state as IdpStandingState, reason: row.reason } : null;
    },

    /**
     * Gives every account that signed in through the provider a row. One without a stored token (a restore
     * left none, or the row never existed) is in sign-in required until the person signs in again.
     */
    async reconcile(providerId: string, now: Date): Promise<number> {
      const result = await db.execute(sql`
        INSERT INTO auth_idp_standing (user_id, provider_id, state, reason, state_changed_at, next_check_at)
        SELECT DISTINCT a.user_id, ${providerId}, 'sign_in_required', 'no_token', ${now}, ${now}
        FROM auth_accounts a WHERE a.provider_id = ${providerId}
        ON CONFLICT (user_id, provider_id) DO NOTHING`);
      return result.rowCount ?? 0;
    },

    /** With the standing check off, nothing may keep refusing people or hold this provider's token. */
    async clear(providerId: string): Promise<number> {
      const result = await db.execute(sql`DELETE FROM auth_idp_standing WHERE provider_id = ${providerId}`);
      return result.rowCount ?? 0;
    },

    /**
     * Leases up to `limit` due identities for `leaseMs`. Eligible: a stored token and a live browser session or
     * a live MCP refresh token. SKIP LOCKED keeps two replicas off one identity, and the lease replaces any
     * lock held across the provider call (N3): this is one statement that commits at once.
     */
    async claim(now: Date, leaseMs: number, limit: number, leaseId: string): Promise<IdpStandingClaim[]> {
      const until = new Date(now.getTime() + leaseMs);
      const result = await db.execute(sql`
        UPDATE auth_idp_standing AS st SET lease_id = ${leaseId}, lease_until = ${until}
        WHERE (st.user_id, st.provider_id) IN (
          SELECT c.user_id, c.provider_id FROM auth_idp_standing c
          WHERE c.refresh_token_enc IS NOT NULL AND c.next_check_at <= ${now}
            AND (c.lease_until IS NULL OR c.lease_until <= ${now})
            AND (EXISTS (SELECT 1 FROM auth_sessions x WHERE x.user_id = c.user_id AND x.expires_at > ${now})
              OR EXISTS (SELECT 1 FROM oauth_refresh_token r WHERE r.user_id = c.user_id AND r.revoked IS NULL AND r.expires_at > ${now}))
          ORDER BY c.next_check_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING st.user_id AS "userId", st.provider_id AS "providerId", st.refresh_token_enc AS "refreshTokenEnc"`);
      return (result.rows as Omit<IdpStandingClaim, 'leaseId'>[]).map((row) => ({ ...row, leaseId }));
    },

    /**
     * Writes one check's outcome if the lease is still this claim's (a stale writer changes nothing). A rotated
     * token replaces the old one in the same statement, so the previous token is forgotten only now.
     * Sign-in required ends the person's browser sessions and revokes nothing else.
     */
    async finish(claim: IdpStandingClaim, result: IdpCheckResult, now: Date, nextCheckAt: Date): Promise<boolean> {
      const lease = and(eq(s.userId, claim.userId), eq(s.providerId, claim.providerId), eq(s.leaseId, claim.leaseId));
      const common = { lastCheckAt: now, lastOutcome: result.outcome, nextCheckAt, leaseId: null, leaseUntil: null };
      if (result.outcome === 'unknown') return (await db.update(s).set(common).where(lease).returning({ id: s.userId })).length > 0;
      if (result.outcome === 'success') {
        return (await db.update(s).set({
          ...common, state: 'ok', reason: null, confirmedAt: now,
          stateChangedAt: sql`CASE WHEN ${s.state} = 'ok' THEN ${s.stateChangedAt} ELSE ${now} END`,
          ...(result.refreshTokenEnc ? { refreshTokenEnc: result.refreshTokenEnc } : {}),
        }).where(lease).returning({ id: s.userId })).length > 0;
      }
      const updated = await db.update(s).set({
        ...common, state: 'sign_in_required', reason: result.reason.slice(0, 100),
        stateChangedAt: sql`CASE WHEN ${s.state} = 'sign_in_required' THEN ${s.stateChangedAt} ELSE ${now} END`,
      }).where(lease).returning({ id: s.userId });
      if (!updated.length) return false;
      await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, claim.userId));
      return true;
    },
  };
}
