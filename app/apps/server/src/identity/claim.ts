import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';

/**
 * Provider identity, email held by another account (F-024 S5a, #313; docs/product/mcp-identity.md, "Password
 * sign-up, reset and email collisions"). The provider vouches for the address, but an address is never a key:
 *  - held by a VERIFIED account: refused. Nothing moves and nothing is linked;
 *  - held by an UNVERIFIED account: the unverified account never blocks the person. They may claim the address,
 *    which releases it (`unverified-<id>@invalid`, RFC 2606), ends that account's sessions and MCP authority and
 *    writes an audit row. The released account keeps its data; nothing is transferred to the new account.
 */

export const CLAIM_COOKIE = 'flux_claim';
export const CLAIM_PATH = '/api/v1/identity/claim';
const CLAIM_TTL_MS = 15 * 60_000;

export type EmailHolder = { kind: 'none' } | { kind: 'verified'; userId: string } | { kind: 'unverified'; userId: string };

export interface ClaimOutcome { providerId: string; email: string; releasedUserId: string }
export type ClaimResult = { claimed: ClaimOutcome } | { refused: 'unknown' | 'expired' | 'held_by_verified' | 'changed' };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
/** The released address. `.invalid` can never be registered or deliver mail. */
export const releasedEmail = (userId: string) => `unverified-${userId}@invalid`;

export function createEmailClaims(db: Database, now: () => Date = () => new Date()) {
  return {
    /** Who, other than this provider identity itself, holds the address. */
    async holder(providerId: string, subject: string, email: string): Promise<EmailHolder> {
      const [user] = await db.select({ id: schema.authUsers.id, verified: schema.authUsers.emailVerified }).from(schema.authUsers)
        .where(eq(sql`lower(${schema.authUsers.email})`, email.trim().toLowerCase()));
      if (!user) return { kind: 'none' };
      const [own] = await db.select({ id: schema.authAccounts.id }).from(schema.authAccounts)
        .where(and(eq(schema.authAccounts.providerId, providerId), eq(schema.authAccounts.accountId, subject), eq(schema.authAccounts.userId, user.id)));
      if (own) return { kind: 'none' };
      return user.verified ? { kind: 'verified', userId: user.id } : { kind: 'unverified', userId: user.id };
    },

    /** Records what the verified ID token proved and returns the secret for the browser that completed it. */
    async open(providerId: string, subject: string, email: string, heldBy: string): Promise<string> {
      const token = randomBytes(32).toString('base64url');
      await db.insert(schema.authEmailClaims).values({
        id: randomUUID(), tokenHash: hash(token), providerId, subject, email: email.trim().toLowerCase(), heldBy,
        expiresAt: new Date(now().getTime() + CLAIM_TTL_MS),
      });
      return token;
    },

    /** What the claim page shows: the address and whether it can still be claimed. */
    async pending(token: string): Promise<{ email: string; expiresAt: Date } | null> {
      const [row] = await db.select().from(schema.authEmailClaims).where(eq(schema.authEmailClaims.tokenHash, hash(token)));
      return row && row.state === 'pending' && row.expiresAt > now() ? { email: row.email, expiresAt: row.expiresAt } : null;
    },

    /**
     * Releases the address from the unverified account, once. The account is re-read under a lock: if it was
     * verified or changed hands since the sign-in, nothing happens.
     */
    async claim(token: string): Promise<ClaimResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(schema.authEmailClaims).where(eq(schema.authEmailClaims.tokenHash, hash(token))).for('update');
        if (!row || row.state !== 'pending') return { refused: 'unknown' as const };
        if (row.expiresAt <= now()) return { refused: 'expired' as const };
        const [holder] = await tx.select().from(schema.authUsers).where(eq(schema.authUsers.id, row.heldBy)).for('update');
        if (!holder || holder.email.toLowerCase() !== row.email) return { refused: 'changed' as const };
        if (holder.emailVerified) return { refused: 'held_by_verified' as const };
        const released = releasedEmail(holder.id);
        await tx.update(schema.authUsers).set({ email: released, updatedAt: now() }).where(eq(schema.authUsers.id, holder.id));
        // The released account keeps its data but can no longer act: no session, no MCP connection or token.
        await tx.delete(schema.authSessions).where(eq(schema.authSessions.userId, holder.id));
        await tx.execute(sql`UPDATE agent_connections SET revoked_at = ${now().toISOString()}::timestamptz, updated_at = ${now().toISOString()}::timestamptz
          WHERE owner_user_id = ${holder.id} AND revoked_at IS NULL`);
        await tx.execute(sql`UPDATE oauth_refresh_token SET revoked = ${now().toISOString()}::timestamptz WHERE user_id = ${holder.id} AND revoked IS NULL`);
        await tx.execute(sql`DELETE FROM oauth_access_token WHERE user_id = ${holder.id}`);
        await tx.update(schema.authEmailClaims).set({ state: 'claimed', claimedAt: now(), releasedEmail: released }).where(eq(schema.authEmailClaims.id, row.id));
        return { claimed: { providerId: row.providerId, email: row.email, releasedUserId: holder.id } };
      });
    },
  };
}
export type EmailClaims = ReturnType<typeof createEmailClaims>;
