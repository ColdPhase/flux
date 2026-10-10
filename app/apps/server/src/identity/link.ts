import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';

/**
 * Explicit linking of an existing password account to the one provider, before cutover (F-024 S5b, #315). The owner
 * is signed in with the account's own password session; the browser then completes one provider round trip. The
 * provider's subject is linked to that account only if no other account holds it. Nothing is matched by email.
 */

export const LINK_COOKIE = 'flux_link';
export const LINK_PATH = '/api/auth';
export const LINK_TTL_MS = 10 * 60_000;

export type LinkOutcome = 'linked' | 'identity_held' | 'already_linked' | 'link_expired';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createLinkIntents(db: Database, now: () => Date = () => new Date()) {
  return {
    /** Opens an intent for this password session and user. A newer intent replaces nothing: each token stands alone. */
    async open(userId: string, sessionId: string, providerId: string): Promise<string> {
      const token = randomBytes(32).toString('base64url');
      await db.insert(schema.authLinkIntents).values({
        id: randomUUID(), tokenHash: hash(token), userId, sessionId, providerId,
        expiresAt: new Date(now().getTime() + LINK_TTL_MS),
      });
      return token;
    },

    /** The intent a callback presents, if it is still pending and belongs to this browser's session and user. */
    async pending(token: string, sessionId: string, userId: string): Promise<{ id: string; userId: string } | null> {
      const [row] = await db.select().from(schema.authLinkIntents).where(eq(schema.authLinkIntents.tokenHash, hash(token)));
      if (!row || row.state !== 'pending' || row.expiresAt <= now() || row.sessionId !== sessionId || row.userId !== userId) return null;
      return { id: row.id, userId: row.userId };
    },

    /**
     * Links the provider subject to the intent's account, once. Refused when another account already holds the subject,
     * or when the account is already linked to a different subject at this provider.
     */
    async attach(intentId: string, providerId: string, subject: string): Promise<LinkOutcome> {
      return db.transaction(async (tx) => {
        const [intent] = await tx.select().from(schema.authLinkIntents).where(eq(schema.authLinkIntents.id, intentId)).for('update');
        if (!intent || intent.state !== 'pending' || intent.expiresAt <= now() || intent.providerId !== providerId) return 'link_expired' as const;
        // Serialize competing links for this account and this provider subject before reading holders.
        await tx.execute(sql`SELECT id FROM auth_users WHERE id = ${intent.userId} FOR UPDATE`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerId + ':' + subject}, 0))`);
        const [holder] = await tx.select({ userId: schema.authAccounts.userId }).from(schema.authAccounts)
          .where(and(eq(schema.authAccounts.providerId, providerId), eq(schema.authAccounts.accountId, subject)));
        if (holder && holder.userId !== intent.userId) return 'identity_held' as const;
        if (!holder) {
          const [other] = await tx.select({ id: schema.authAccounts.id }).from(schema.authAccounts)
            .where(and(eq(schema.authAccounts.userId, intent.userId), eq(schema.authAccounts.providerId, providerId)));
          if (other) return 'already_linked' as const;
          await tx.insert(schema.authAccounts).values({ id: randomUUID(), userId: intent.userId, accountId: subject, providerId });
        }
        await tx.update(schema.authLinkIntents).set({ state: 'used', usedAt: now() }).where(eq(schema.authLinkIntents.id, intentId));
        return 'linked' as const;
      });
    },
  };
}
export type LinkIntents = ReturnType<typeof createLinkIntents>;

export const linkCookie = (token: string, secure: boolean, maxAgeSeconds = Math.floor(LINK_TTL_MS / 1000)) =>
  `${LINK_COOKIE}=${token}; Path=${LINK_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
