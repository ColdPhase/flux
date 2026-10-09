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
     * A successful provider sign-in: stores the sealed offline token with the provider session (`sid`) it was
     * issued for, clears sign-in required and marks the identity confirmed now. Returns the token it replaced
     * and that token's sid, so the caller can decide whether to revoke it at the provider.
     */
    async record(userId: string, providerId: string, refreshTokenEnc: string, sid: string | null, now: Date, nextCheckAt: Date): Promise<{ token: string; sid: string | null } | null> {
      const [previous] = await db.select({ token: s.refreshTokenEnc, sid: s.refreshTokenSid }).from(s).where(and(eq(s.userId, userId), eq(s.providerId, providerId)));
      await db.insert(s).values({ userId, providerId, state: 'ok', refreshTokenEnc, refreshTokenSid: sid, confirmedAt: now, stateChangedAt: now, nextCheckAt })
        .onConflictDoUpdate({ target: [s.userId, s.providerId], set: {
          state: 'ok', reason: null, refreshTokenEnc, refreshTokenSid: sid, confirmedAt: now, nextCheckAt, leaseId: null, leaseUntil: null,
          stateChangedAt: sql`CASE WHEN ${s.state} = 'ok' THEN ${s.stateChangedAt} ELSE ${now} END`,
        } });
      return previous?.token ? { token: previous.token, sid: previous.sid } : null;
    },

    /** Whether a live browser session of this person was created from this provider session (`sid`). */
    async sessionCarries(userId: string, providerId: string, sid: string, now: Date): Promise<boolean> {
      const result = await db.execute(sql`
        SELECT 1 FROM auth_session_identities i JOIN auth_sessions x ON x.id = i.session_id
        WHERE x.user_id = ${userId} AND i.method = ${providerId} AND i.idp_sid = ${sid} AND x.expires_at > ${now.toISOString()}::timestamptz
        LIMIT 1`);
      return (result.rowCount ?? 0) > 0;
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
        SELECT DISTINCT a.user_id, ${providerId}, 'sign_in_required', 'no_token', ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
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
      const until = new Date(now.getTime() + leaseMs).toISOString();
      const at = now.toISOString();
      const result = await db.execute(sql`
        UPDATE auth_idp_standing AS st SET lease_id = ${leaseId}, lease_until = ${until}::timestamptz
        WHERE (st.user_id, st.provider_id) IN (
          SELECT c.user_id, c.provider_id FROM auth_idp_standing c
          WHERE c.refresh_token_enc IS NOT NULL AND c.next_check_at <= ${at}::timestamptz
            AND (c.lease_until IS NULL OR c.lease_until <= ${at}::timestamptz)
            AND (EXISTS (SELECT 1 FROM auth_sessions x WHERE x.user_id = c.user_id AND x.expires_at > ${at}::timestamptz)
              OR EXISTS (SELECT 1 FROM oauth_refresh_token r WHERE r.user_id = c.user_id AND r.revoked IS NULL AND r.expires_at > ${at}::timestamptz))
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
      // One statement: the state and the end of the browser sessions are visible together, never one without the other.
      const outcome = await db.execute(sql`
        WITH upd AS (
          UPDATE auth_idp_standing SET state = 'sign_in_required', reason = ${result.reason.slice(0, 100)}, last_check_at = ${now.toISOString()}::timestamptz,
            last_outcome = 'sign_in_required', next_check_at = ${nextCheckAt.toISOString()}::timestamptz, lease_id = NULL, lease_until = NULL,
            state_changed_at = CASE WHEN state = 'sign_in_required' THEN state_changed_at ELSE ${now.toISOString()}::timestamptz END
          WHERE user_id = ${claim.userId} AND provider_id = ${claim.providerId} AND lease_id = ${claim.leaseId}
          RETURNING user_id),
        del AS (DELETE FROM auth_sessions WHERE user_id IN (SELECT user_id FROM upd))
        SELECT count(*)::int AS n FROM upd`);
      return (outcome.rows[0] as { n: number }).n > 0;
    },
  };
}

/**
 * Wraps a personal-run access policy so a person whose account no longer stands at the identity provider
 * starts and continues no compute (F-024 S4, #311). The adapter lives here, not in core: core holds the policy
 * and its port, and the apps compose this over it.
 */
export function withIdpStanding<A extends { canInvoke(principal: { kind: string; id: string }, agentId: string, options?: { lock?: boolean }): Promise<boolean> }>(access: A, db: DbExecutor): A {
  const standing = idpStandingRepository(db);
  return { ...access, async canInvoke(principal, agentId, options) {
    if (principal.kind === 'human' && await standing.refuses(principal.id)) return false;
    return access.canInvoke(principal, agentId, options);
  } };
}
